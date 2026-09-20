import { eventKey, eventOffsetSeconds, eventsForSession, isPlaybackEvent,
  nearestEventIndex } from './replay-utils.js';

const $ = id => document.getElementById(id);
let current, stream, graph = { nodes: [], edges: [] }, selectedEvent, currentAgents = [], currentReports = [];
window.__setTestGraph = g => { graph = g; renderFlow(); };
window.__setTestInvestigations = items => renderInvestigations(items);
window.showView = showView;
window.renderInvestigations = renderInvestigations;
let eventLogOffset = 0, eventLogPageSize = 50, eventLogFilter = 'all';
const seen = new Set(), cards = new Map();
const eventRows = new Map(), replays = new Map();
function debounce(fn,ms){let timer;return(...args)=>{clearTimeout(timer);timer=setTimeout(()=>fn(...args),ms);};}
async function request(url, options) { const response = await fetch(url, options); const data = await response.json(); if (!response.ok) throw new Error(data.error || response.statusText); return data; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[c]); }
function fmtDuration(ms) { if (ms == null) return 'running'; const s = Math.max(0, Math.round(Number(ms) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s/60)}m ${s%60}s`; }
function isFailure(type, data = {}) { return /(^|\.)(failed|failure|error|timeout|deadline|budget_exceeded)$/.test(type) || ['failed','failure','timed_out'].includes(String(data.status || data.outcome || '').toLowerCase()); }
function filterSubAgents(items) { return (items || []).filter(x => x.agent_id !== 'system' && x.agent_id !== 'crawler'); }
function agentRoleClass(agentId) { if (agentId === 'orchestrator') return 'orchestrator'; if (agentId === 'observer') return 'observer'; return 'worker'; }
function eventStatus(type, data) { return isFailure(type, data) ? 'failure' : (type.endsWith('.completed') || type === 'worker.success' || type === 'agent.completed' ? 'success' : 'info'); }
function extractDetail(type, data = {}) {
  if (data.action?.kind) return `${data.action.kind}${data.action.selector ? ': ' + String(data.action.selector).slice(0, 35) : ''}`;
  if (data.tool?.name || data.tool_name) return `tool: ${String(data.tool?.name || data.tool_name).slice(0, 35)}`;
  if (data.url) return String(data.url).slice(0, 40);
  if (data.level && type === 'browser.console') return `${data.level}: ${String(data.message || '').slice(0, 30)}`;
  if (data.status) return String(data.status).slice(0, 30);
  if (data.outcome) return String(data.outcome).slice(0, 30);
  if (data.error?.message) return String(data.error.message).slice(0, 35);
  if (data.message) return String(data.message).slice(0, 35);
  if (data.findings) return String(data.findings).slice(0, 35);
  if (data.selector) return String(data.selector).slice(0, 40);
  return '';
}
function fmtTime(iso) { try { return new Date(iso).toLocaleTimeString(); } catch { return iso; } }
const headings = { runs:['Run intelligence','Find a run, understand its outcome, and follow the evidence.'], overview:['Run overview','A consistent summary of agents, signals, coverage, and decisions.'], investigate:['Failure investigation','Follow the causal path from assumptions to effects.'], browsers:['Control Room','A front-row seat to every browser path and action.'] };
function showView(name) {
  for (const b of $('nav').querySelectorAll('button')) {
    const active = b.dataset.view === name;
    b.classList.toggle('active', active);
    active ? b.setAttribute('aria-current','page') : b.removeAttribute('aria-current');
  }
  for (const view of document.querySelectorAll('.view'))
    view.classList.toggle('active', view.id === `view-${name}`);
  $('view-name').textContent = name[0].toUpperCase()+name.slice(1);
  $('page-title').replaceChildren(document.createTextNode(headings[name][0]), Object.assign(document.createElement('span'), {textContent:'.'}));
  $('page-description').textContent = headings[name][1];
  $('form').hidden = name !== 'browsers';
  if (name === 'investigate' && graph.nodes.length) {
    requestAnimationFrame(() => renderFlow());
  }
}
$('nav').addEventListener('click', event => { const button = event.target.closest('button[data-view]'); if (button) showView(button.dataset.view); });

async function loadRuns() { const params = new URLSearchParams({limit:'100'}); if ($('run-search').value) params.set('search',$('run-search').value); if ($('run-status').value) params.set('status',$('run-status').value); if ($('failure-category').value) params.set('failureCategory',$('failure-category').value); try { const [data,metrics] = await Promise.all([request(`/api/runs?${params}`),request('/api/dashboard/metrics')]); renderGlobalMetrics(data.items,metrics); renderRunList(data.items); } catch (error) { $('error').textContent = error.message; } }
function renderGlobalMetrics(runs,daily) { const successful=runs.filter(r=>r.status==='succeeded').length, failures=runs.reduce((s,r)=>s+Number(r.failure_count||0),0), backlog=runs.reduce((s,r)=>s+Number(r.investigation_backlog||0),0), recovery=runs.filter(r=>r.investigation_outcome==='RECOVERED_FAILURE').length; $('global-metrics').innerHTML=[["Runs",runs.length,'in current result'],['Success rate',runs.length?`${Math.round(successful/runs.length*100)}%`:'—',`${successful} succeeded`],['Failure clusters',failures,`${recovery} recovered`],['Investigation backlog',backlog,'queued or running']].map(([l,v,n])=>`<article class="metric"><span>${l}</span><strong>${v}</strong><small>${n}</small></article>`).join(''); const grouped=new Map(); for(const row of daily){const day=String(row.day).slice(0,10), entry=grouped.get(day)||{total:0,failed:0}; entry.total+=Number(row.runs); if(String(row.status).includes('fail'))entry.failed+=Number(row.runs); grouped.set(day,entry);} const max=Math.max(1,...[...grouped.values()].map(v=>v.total)); $('outcome-chart').innerHTML=[...grouped.entries()].slice(-14).map(([day,v])=>`<div class="bar-column" title="${day}: ${v.total} runs, ${v.failed} failed"><div class="bar failure" style="height:${v.failed/max*100}%"></div><div class="bar success" style="height:${(v.total-v.failed)/max*100}%"></div><span>${day.slice(5)}</span></div>`).join('')||'<p class="empty-copy">No historical metrics yet.</p>'; }
function renderRunList(runs) { $('run-list').innerHTML=runs.map(run=>`<button class="run-row ${String(run.status).includes('fail')?'has-failure':''}" data-run="${run.run_id}"><span class="run-health"></span><span class="run-main"><strong>${escapeHtml(run.goal)}</strong><small>${run.run_id} · ${escapeHtml(run.workflow_type||'workflow')}</small></span><span><small>Status</small><strong>${escapeHtml(run.status)}</strong></span><span><small>Duration</small><strong>${fmtDuration(run.duration_ms)}</strong></span><span><small>Agents / events</small><strong>${run.agent_count||0} / ${run.event_count||0}</strong></span><span><small>Failures</small><strong>${run.failure_count||0}</strong></span><span><small>Cause</small><strong>${escapeHtml(run.failure_category||'—')}</strong></span></button>`).join('')||'<p class="empty-copy">No runs match these filters.</p>'; }
$('run-list').addEventListener('click',e=>{const row=e.target.closest('[data-run]');if(row)void selectRun(row.dataset.run);});
async function selectRun(id) {
  current=id; localStorage.setItem('lastRun',id); $('error').textContent='';
  try {
    const [summary,runGraph]=await Promise.all([request(`/api/runs/${id}/summary`),request(`/api/runs/${id}/graph`)]);
    graph=runGraph;
    currentAgents = summary.agents || [];
    currentReports = (summary.investigations || []).filter(i => i.report).map(i => i.report);
    const modal = $('investigation-modal');
    if (modal) modal.hidden = true;
    renderSummary(summary);
    renderInvestigations(summary.investigations||[]);
    $('status').textContent=String(summary.status).replaceAll('_',' ');
    document.body.dataset.phase=summary.status;
    showView(Number(summary.metrics?.failures||0)>0?'investigate':'overview');
    renderFlow();
    renderEventLog(true);
    if(['starting','discovering','planning','running','observing'].includes(summary.status))connect(id);
  } catch(error){$('error').textContent=error.message;}
}
function renderSummary(s) { const m=s.metrics||{}; const subAgents=filterSubAgents(s.agents); $('run-summary').innerHTML=`<div class="run-title"><div><span class="eyebrow">${escapeHtml(s.workflow_type)}</span><h2>${escapeHtml(s.goal)}</h2><code>${s.run_id}</code></div><span class="outcome ${String(s.status).includes('fail')?'bad':''}">${escapeHtml(s.status)}</span></div><div class="metric-grid compact">${[['Duration',fmtDuration(s.completed_at?new Date(s.completed_at)-new Date(s.created_at):null)],['Agents',subAgents.length],['Events',m.events||0],['Failures',m.failures||0],['Model calls',m.model_calls||0],['Tool calls',m.tool_calls||0],['Retries',m.retries||0],['p95 latency',m.latency_p95_ms?`${Math.round(m.latency_p95_ms)}ms`:'—']].map(([k,v])=>`<div class="metric"><span>${k}</span><strong>${v}</strong></div>`).join('')}</div><div class="stage-strip">${['discovery','planning','execution','observation','completion'].map(stage=>`<span class="${graph.nodes.some(n=>n.type==='workflow.stage.completed'&&n.metadata?.stage===stage)?'done':''}">${stage}</span>`).join('')}</div>`; $('agent-cards').innerHTML=subAgents.map(a=>`<article class="agent-card"><span>${escapeHtml(a.agent_id)}</span><strong>${escapeHtml(a.assigned_task||'coordination')}</strong><dl><dt>Outcome</dt><dd>${escapeHtml(a.outcome||'—')}</dd><dt>Events</dt><dd>${a.event_count}</dd><dt>Retries</dt><dd>${a.retry_count}</dd><dt>Last signal</dt><dd>${escapeHtml(a.last_event||'—')}</dd></dl></article>`).join('')||'<p class="empty-copy">No sub-agent executions recorded for this run.</p>'; const decisions=filterSubAgents(graph.nodes.filter(n=>n.type==='decision.recorded'||n.type==='decision.revised')); $('decisions').innerHTML=decisions.map(n=>`<button data-event="${n.id}" class="decision"><span>${escapeHtml(n.agent_id)}</span><strong>${escapeHtml(n.metadata.decision)}</strong><small>${(n.metadata.assumptions||[]).length?escapeHtml(n.metadata.assumptions.join(' · ')):'Unsupported: no assumptions or evidence recorded'}</small></button>`).join('')||'<p class="empty-copy">No explicit decision summaries were recorded for this run.</p>'; }
function getReportAgents(r) {
  if (!r) return [];
  const eventIds = new Set([
    ...(r.earliest_relevant_event_id ? [r.earliest_relevant_event_id] : []),
    ...(r.trigger_event_id ? [r.trigger_event_id] : []),
    ...((r.observed_facts || []).flatMap(f => f.event_ids || [])),
    ...((r.likely_cause?.supporting_event_ids || [])),
    ...((r.related_event_ids || []))
  ]);
  const agents = new Set();
  for (const id of eventIds) {
    const node = (graph.nodes || []).find(n => n.id === id);
    if (node?.agent_id) agents.add(node.agent_id);
  }
  if (r.affected_agent_execution_ids) {
    for (const execId of r.affected_agent_execution_ids) {
      const node = (graph.nodes || []).find(n => n.agent_execution_id === execId);
      if (node?.agent_id) agents.add(node.agent_id);
      const ag = (currentAgents || []).find(a => a.agent_execution_id === execId);
      if (ag?.agent_id) agents.add(ag.agent_id);
    }
  }
  if (!agents.size && r.recommended_owner && r.recommended_owner !== 'unknown') {
    agents.add(r.recommended_owner);
  }
  return [...agents].filter(a => a !== 'system' && a !== 'crawler').sort(sortAgentLanes);
}

function showInvestigationModal(idx) {
  const r = currentReports[idx];
  if (!r) return;
  const agents = getReportAgents(r);
  const isBad = String(r.outcome).includes('FAIL') || String(r.outcome).includes('bad') || r.outcome === 'CONFIRMED_FAILURE';
  const title = r.title || r.summary || r.observed_failure || 'Observer finding';
  const facts = r.observed_facts || [];
  const gaps = r.evidence_gaps_and_alternatives || [];
  const causeCat = r.likely_cause?.category || '';
  const causeClass = causeCat ? `cause-${causeCat.toLowerCase().replace(/_/g, '-')}` : '';
  const conf = r.likely_cause?.confidence || '—';

  $('investigation-modal-content').innerHTML = `
    <article class="failure-report modal-report">
      <header>
        <div>
          <span class="outcome ${isBad ? 'bad' : ''}">${escapeHtml(r.outcome || 'INCONCLUSIVE')}</span>
          <h2 id="modal-report-title">${escapeHtml(title)}</h2>
          ${agents.length ? `<div class="report-agent-meta"><span class="meta-label">Involved agents:</span> ${agents.map(a => `<span class="agent-badge ${agentRoleClass(a)}">${escapeHtml(a)}</span>`).join(' ')}</div>` : ''}
        </div>
        <span class="confidence ${conf.toLowerCase()}">${escapeHtml(conf)} confidence</span>
      </header>
      <h3>Observed facts</h3>
      <ol>${facts.length ? facts.map(f => `<li>${escapeHtml(f.statement)} ${(f.event_ids || []).map(id => `<button class="citation" data-event="${id}" title="Jump to event evidence">${id.slice(0, 8)}</button>`).join(' ')}</li>`).join('') : '<li>No facts recorded.</li>'}</ol>
      ${r.likely_cause ? `<h3>Likely cause · <span class="cause-tag ${causeClass}">${escapeHtml(causeCat)}</span></h3><p>${escapeHtml(r.likely_cause.explanation)}</p>` : ''}
      <h3>Evidence gaps and alternatives</h3>
      <ul>${gaps.map(g => `<li>${escapeHtml(g)}</li>`).join('') || '<li>None recorded.</li>'}</ul>
      ${r.reproduction_step ? `<h3>Reproduction step</h3><p>${escapeHtml(r.reproduction_step)}</p>` : ''}
      <details><summary>Raw report JSON</summary><pre>${escapeHtml(JSON.stringify(r, null, 2))}</pre></details>
    </article>
  `;
  $('investigation-modal').hidden = false;
}

function renderAgentBadges(agents, max = 2) {
  if (!agents || !agents.length) return '<span class="agent-badge observer">observer</span>';
  if (agents.length <= max) {
    return agents.map(a => `<span class="agent-badge ${agentRoleClass(a)}">${escapeHtml(a)}</span>`).join('');
  }
  const shown = agents.slice(0, max);
  const remaining = agents.slice(max);
  return shown.map(a => `<span class="agent-badge ${agentRoleClass(a)}">${escapeHtml(a)}</span>`).join('') +
    `<span class="agent-badge more" title="More agents: ${escapeHtml(remaining.join(', '))}"> (+${remaining.length})</span>`;
}

function renderInvestigations(items) {
  const reports = (items || []).map(i => i.report || i).filter(r => r && (r.outcome || r.observed_facts || r.likely_cause || r.title));
  currentReports = reports;
  if (!reports.length) {
    $('investigation-summary').innerHTML = '<p class="empty-copy">No completed investigation report yet. Failure clusters remain visible in the agent flow.</p>';
    return;
  }
  $('investigation-summary').innerHTML = `
    <div class="investigation-section">
      <div class="section-bar">
        <h2><span class="bad-dot"></span> Agent failure investigations <span class="badge-count">${reports.length}</span></h2>
        <span class="quiet-label">CLICK ROW OR INSPECT TO VIEW FULL DOSSIER</span>
      </div>
      <div class="investigation-table-wrap">
        <table class="investigation-table" aria-label="Failure investigations">
          <thead>
            <tr>
              <th class="col-agent">Agent</th>
              <th class="col-outcome">Outcome</th>
              <th class="col-finding">Finding / Insight</th>
              <th class="col-cause">Likely cause</th>
              <th class="col-confidence">Confidence</th>
              <th class="col-facts">Facts</th>
              <th class="col-action"></th>
            </tr>
          </thead>
          <tbody>
            ${reports.map((r, idx) => {
              const agents = getReportAgents(r);
              const isBad = String(r.outcome).includes('FAIL') || String(r.outcome).includes('bad') || r.outcome === 'CONFIRMED_FAILURE';
              const title = r.title || r.summary || r.observed_failure || 'Observer finding';
              const detail = (r.observed_failure && r.observed_failure !== title) ? r.observed_failure : (r.summary && r.summary !== title ? r.summary : '');
              const causeCat = r.likely_cause?.category || '';
              const causeClass = causeCat ? `cause-${causeCat.toLowerCase().replace(/_/g, '-')}` : '';
              const conf = r.likely_cause?.confidence || '—';
              const factsCount = (r.observed_facts || []).length;
              return `
                <tr class="investigation-row" data-report-idx="${idx}" tabindex="0" role="button" aria-label="View report for ${escapeHtml(title)}">
                  <td class="col-agent">
                    <div class="agent-badges-cell">
                      ${renderAgentBadges(agents, 2)}
                    </div>
                  </td>
                  <td class="col-outcome">
                    <span class="outcome ${isBad ? 'bad' : ''}">${escapeHtml(r.outcome || 'INCONCLUSIVE')}</span>
                  </td>
                  <td class="col-finding">
                    <strong class="finding-title">${escapeHtml(title)}</strong>
                    ${detail ? `<small class="finding-detail">${escapeHtml(detail)}</small>` : ''}
                  </td>
                  <td class="col-cause">
                    ${causeCat ? `<span class="cause-tag ${causeClass}">${escapeHtml(causeCat)}</span>` : '<span class="muted">—</span>'}
                  </td>
                  <td class="col-confidence">
                    <span class="confidence-pill conf-${conf.toLowerCase()}">${escapeHtml(conf)}</span>
                  </td>
                  <td class="col-facts">
                    <span class="facts-pill">${factsCount} fact${factsCount === 1 ? '' : 's'}</span>
                  </td>
                  <td class="col-action">
                    <button class="btn-inspect-report" type="button" data-report-idx="${idx}">Inspect ↗</button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>
  `;
}
function sortAgentLanes(a,b){const order={orchestrator:0,observer:2};const ao=order[a]??1,bo=order[b]??1;if(ao!==bo)return ao-bo;if(a.startsWith('worker-')&&b.startsWith('worker-'))return Number(a.slice(7))-Number(b.slice(7));return a.localeCompare(b);}
function fmtTimelineTime(t, minTime, durationMs) {
  const d = new Date(t);
  const timeStr = fmtTime(d);
  if (durationMs == null || durationMs <= 0) return timeStr;
  const elapsedMs = Math.max(0, t - minTime);
  if (durationMs < 10000) {
    const s = (elapsedMs / 1000).toFixed(1);
    return `${timeStr} (+${s}s)`;
  }
  if (durationMs < 120000) {
    const s = Math.round(elapsedMs / 1000);
    return `${timeStr} (+${s}s)`;
  }
  return timeStr;
}

function renderFlow() {
  const container = $('flow-container'), lanesEl = $('flow-lanes'), axisEl = $('flow-axis'), edgesEl = $('flow-edges'), statsEl = $('flow-stats');
  const nodes = filterSubAgents(graph.nodes);
  if (!nodes.length) {
    lanesEl.innerHTML = axisEl.innerHTML = edgesEl.innerHTML = '';
    statsEl.innerHTML = '<span class="quiet-label">NO SUB-AGENT EVENTS</span>';
    return;
  }
  const laneNames = [...new Set(nodes.map(n => n.agent_id))].sort(sortAgentLanes);
  const nodeTimes = new Map(nodes.map(n => [n.id, new Date(n.occurred_at).getTime()]));
  const times = [...nodeTimes.values()];
  const minTime = Math.min(...times);
  const maxTime = Math.max(...times, minTime);
  const durationMs = maxTime - minTime;

  const labelWidth = 130;
  const nodeWidth = 126;
  const minGap = 20;
  const availableWidth = Math.max(container.clientWidth - labelWidth - 40, 500);

  statsEl.innerHTML = `<span><strong>${nodes.length}</strong><em>events</em></span><span><strong>${nodes.filter(n => isFailure(n.type, n.metadata)).length}</strong><em>failures</em></span><span><strong>${laneNames.length}</strong><em>agents</em></span><span><strong>${fmtDuration(durationMs)}</strong><em>duration</em></span><span class="quiet-label">SELECT AN EVENT TO OPEN EVIDENCE</span>`;

  const predecessors = new Map();
  for (const n of nodes) predecessors.set(n.id, []);
  for (const e of graph.edges) {
    if (predecessors.has(e.target)) predecessors.get(e.target).push(e.source);
  }

  // Base px/ms scaled across available space without artificial clamps
  const idealPxPerMs = durationMs > 0 ? (availableWidth - 120) / durationMs : 0;
  const pxPerMs = Math.max(0.02, Math.min(2.0, idealPxPerMs || 0.1));

  const nodesSorted = [...nodes].sort((a, b) => (nodeTimes.get(a.id) - nodeTimes.get(b.id)) || (a.sequence_number - b.sequence_number));
  const laneLastRight = new Map();
  for (const name of laneNames) laneLastRight.set(name, 16);
  const nodeComputedLeft = new Map();
  let maxRight = 400;

  for (const n of nodesSorted) {
    const t = nodeTimes.get(n.id);
    const naturalLeft = 16 + (t - minTime) * pxPerMs;
    let left = naturalLeft;
    const prevInLane = laneLastRight.get(n.agent_id) ?? 16;
    if (prevInLane > 16) {
      left = Math.max(left, prevInLane + minGap);
    }
    for (const predId of predecessors.get(n.id) || []) {
      const predLeft = nodeComputedLeft.get(predId);
      if (predLeft != null) {
        left = Math.max(left, predLeft + nodeWidth + 24);
      }
    }
    nodeComputedLeft.set(n.id, left);
    laneLastRight.set(n.agent_id, left + nodeWidth);
    if (left + nodeWidth > maxRight) maxRight = left + nodeWidth;
  }

  const trackWidth = Math.max(container.clientWidth - labelWidth - 20, maxRight + 60);
  const totalWidth = labelWidth + trackWidth;
  const laneHeight = 76;
  const totalHeight = laneNames.length * laneHeight;

  // Build time anchors to map horizontal track coordinate directly to event timestamps
  const anchors = [];
  for (const n of nodesSorted) {
    anchors.push({ x: nodeComputedLeft.get(n.id), t: nodeTimes.get(n.id) });
  }
  anchors.sort((a, b) => a.x - b.x);

  function getTimeAtX(x) {
    if (!anchors.length) return minTime;
    if (x <= anchors[0].x) return anchors[0].t;
    if (x >= anchors[anchors.length - 1].x) return anchors[anchors.length - 1].t;
    for (let i = 0; i < anchors.length - 1; i++) {
      const a1 = anchors[i], a2 = anchors[i + 1];
      if (x >= a1.x && x <= a2.x) {
        if (a2.x === a1.x) return a1.t;
        return a1.t + ((x - a1.x) / (a2.x - a1.x)) * (a2.t - a1.t);
      }
    }
    return maxTime;
  }

  // Generate evenly spaced timeline marks spanning trackWidth without any overlapping
  axisEl.style.width = `${totalWidth}px`;
  const minTickSpacing = 150; // Guaranteed space so time labels never collide
  const activeSpan = Math.max(maxRight - 16, trackWidth - 60);
  const numTicks = Math.max(2, Math.min(20, Math.floor(activeSpan / minTickSpacing)));
  const tickStep = activeSpan / numTicks;

  let marksHtml = '';
  const tickPositions = [];
  for (let i = 0; i <= numTicks; i++) {
    const left = Math.round(16 + i * tickStep);
    if (left > trackWidth - 30) continue;
    const t = getTimeAtX(left);
    const label = fmtTimelineTime(t, minTime, durationMs);
    marksHtml += `<mark style="left:${left}px"><label>${escapeHtml(label)}</label></mark>`;
    tickPositions.push(left);
  }

  // If an event is selected, highlight an active pin on the timeline axis
  if (selectedEvent && nodeComputedLeft.has(selectedEvent)) {
    const selLeft = Math.round(nodeComputedLeft.get(selectedEvent) + nodeWidth / 2);
    const selTime = nodeTimes.get(selectedEvent);
    marksHtml += `<div class="flow-axis-marker" style="left:${selLeft}px"><span class="marker-pin"></span><span class="marker-label">${escapeHtml(fmtTimelineTime(selTime, minTime, durationMs))}</span></div>`;
  }

  axisEl.innerHTML = `<div class="flow-axis-corner">AGENT / TIME</div><div class="flow-axis-track" style="width:${trackWidth}px;">${marksHtml}</div>`;

  lanesEl.style.width = `${totalWidth}px`;
  lanesEl.style.height = `${totalHeight}px`;
  lanesEl.innerHTML = laneNames.map(name =>
    `<div class="flow-lane" data-agent="${escapeHtml(name)}">
      <div class="flow-lane-label" title="${escapeHtml(name)}">${escapeHtml(name)}</div>
      <div class="flow-nodes" data-agent="${escapeHtml(name)}" style="width:${trackWidth}px;"></div>
    </div>`
  ).join('');

  const nodeButtons = new Map();
  for (const n of nodes) {
    const lane = lanesEl.querySelector(`.flow-nodes[data-agent="${CSS.escape(n.agent_id)}"]`);
    if (!lane) continue;
    const left = nodeComputedLeft.get(n.id) ?? 16;
    const status = eventStatus(n.type, n.metadata);
    const detail = extractDetail(n.type, n.metadata);
    const t = nodeTimes.get(n.id);
    const elapsedSec = durationMs > 0 ? ((t - minTime) / 1000).toFixed(1) : '0.0';
    const timeLabel = durationMs < 10000 && durationMs > 0 ? `${fmtTime(n.occurred_at)} (+${elapsedSec}s)` : fmtTime(n.occurred_at);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `flow-node ${status === 'failure' ? 'failure' : ''} ${selectedEvent === n.id ? 'selected' : ''}`;
    btn.dataset.event = n.id;
    btn.dataset.status = status;
    btn.style.left = `${Math.round(left)}px`;
    btn.style.top = '11px';
    btn.title = `${escapeHtml(n.type)}\n${detail ? escapeHtml(detail) + '\n' : ''}${fmtTime(n.occurred_at)} (+${elapsedSec}s) · seq ${n.sequence_number}`;
    btn.innerHTML = `<span class="node-type"><span class="status-dot"></span>${escapeHtml(n.type)}</span>${detail ? `<span class="node-detail">${escapeHtml(detail)}</span>` : ''}<span class="node-time">${escapeHtml(timeLabel)}</span>`;
    lane.append(btn);
    nodeButtons.set(n.id, btn);
  }

  edgesEl.style.width = `${totalWidth}px`;
  edgesEl.style.height = `${totalHeight + 32}px`;

  const edgesRect = edgesEl.getBoundingClientRect();
  const nodePositions = new Map();
  const isVisible = edgesRect.width > 0;
  const laneIndexMap = new Map(laneNames.map((name, idx) => [name, idx]));

  for (const n of nodes) {
    const btn = nodeButtons.get(n.id);
    if (!btn) continue;
    if (isVisible) {
      const r = btn.getBoundingClientRect();
      nodePositions.set(n.id, {
        left: Math.round(r.left - edgesRect.left),
        right: Math.round(r.right - edgesRect.left),
        x: Math.round(r.left - edgesRect.left + r.width / 2),
        y: Math.round(r.top - edgesRect.top + r.height / 2),
        top: Math.round(r.top - edgesRect.top),
        bottom: Math.round(r.bottom - edgesRect.top)
      });
    } else {
      const laneIdx = laneIndexMap.get(n.agent_id) ?? 0;
      const left = labelWidth + (nodeComputedLeft.get(n.id) ?? 16);
      const top = 28 + laneIdx * laneHeight + 11;
      nodePositions.set(n.id, {
        left,
        right: left + nodeWidth,
        x: left + nodeWidth / 2,
        y: top + 26,
        top,
        bottom: top + 52
      });
    }
  }

  edgesEl.innerHTML = '';

  // Draw vertical grid guidelines from timeline marks across all lanes
  for (const left of tickPositions) {
    const gridX = labelWidth + left;
    const gridLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    gridLine.setAttribute('x1', String(gridX));
    gridLine.setAttribute('y1', '28');
    gridLine.setAttribute('x2', String(gridX));
    gridLine.setAttribute('y2', String(totalHeight + 28));
    gridLine.setAttribute('class', 'flow-grid-line');
    edgesEl.append(gridLine);
  }

  // Draw vertical guideline for selected event
  if (selectedEvent && nodePositions.has(selectedEvent)) {
    const selPos = nodePositions.get(selectedEvent);
    const selLine = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    selLine.setAttribute('x1', String(selPos.x));
    selLine.setAttribute('y1', '28');
    selLine.setAttribute('x2', String(selPos.x));
    selLine.setAttribute('y2', String(totalHeight + 28));
    selLine.setAttribute('class', 'flow-selected-guide');
    edgesEl.append(selLine);
  }

  for (const e of graph.edges) {
    const posA = nodePositions.get(e.source);
    const posB = nodePositions.get(e.target);
    if (!posA || !posB) continue;

    let x1, y1, x2, y2;
    if (posA.left <= posB.left) {
      x1 = posA.right;
      y1 = posA.y;
      x2 = posB.left;
      y2 = posB.y;
    } else {
      x1 = posA.left;
      y1 = posA.y;
      x2 = posB.right;
      y2 = posB.y;
    }

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    let d;
    if (Math.abs(y1 - y2) < 4) {
      d = `M ${x1} ${y1} L ${x2} ${y2}`;
    } else {
      const dx = Math.max(24, Math.abs(x2 - x1));
      const cx1 = x1 <= x2 ? x1 + dx * 0.5 : x1 - dx * 0.5;
      const cx2 = x1 <= x2 ? x2 - dx * 0.5 : x2 + dx * 0.5;
      d = `M ${x1} ${y1} C ${cx1} ${y1} ${cx2} ${y2} ${x2} ${y2}`;
    }
    const isHighlighted = selectedEvent && (e.source === selectedEvent || e.target === selectedEvent);
    path.setAttribute('d', d);
    path.setAttribute('class', `flow-edge ${e.inferred ? 'inferred' : ''} ${isHighlighted ? 'highlighted' : ''}`);
    edgesEl.append(path);
  }
}
window.addEventListener('resize', debounce(() => {
  if (graph.nodes?.length && $('view-investigate')?.classList.contains('active')) {
    renderFlow();
  }
}, 150));
async function renderEventLog(reset=false){if(!current)return;if(reset)eventLogOffset=0;const search=$('event-log-search').value.trim();const params=new URLSearchParams({limit:String(eventLogPageSize),offset:String(eventLogOffset)});if(search)params.set('search',search);try{const data=await request(`/api/runs/${current}/events?${params}`);let items=data.items||[];items=filterSubAgents(items.map(e=>({...e,agent_id:e.agent_id})));if(eventLogFilter!=='all')items=items.filter(e=>e.agent_id===eventLogFilter);const agents=[...new Set(filterSubAgents(graph.nodes).map(n=>n.agent_id))].sort(sortAgentLanes);const pillsEl=$('agent-pills');pillsEl.innerHTML=`<button type="button" class="agent-pill ${eventLogFilter==='all'?'active':''}" data-agent="all">All</button>`+agents.map(a=>`<button type="button" class="agent-pill ${eventLogFilter===a?'active':''} agent-badge ${agentRoleClass(a)}" data-agent="${escapeHtml(a)}">${escapeHtml(a)}<span class="pill-count">${graph.nodes.filter(n=>n.agent_id===a).length}</span></button>`).join('');
$('event-log-body').innerHTML=items.map(e=>{const status=eventStatus(e.event_type,e.metadata);const detail=extractDetail(e.event_type,e.metadata);const highlights=e.search_highlights?.length?`<small class="search-highlights">${escapeHtml(e.search_highlights.join(' · '))}</small>`:'';return `<tr data-event="${e.event_id}" class="${selectedEvent===e.event_id?'selected':''}"><td class="col-time">${fmtTime(e.occurred_at)}</td><td class="col-agent"><span class="agent-badge ${agentRoleClass(e.agent_id)}">${escapeHtml(e.agent_id)}</span></td><td class="col-type"><span class="event-kind ${status}">${escapeHtml(e.event_type)}</span>${highlights}</td><td class="col-detail">${detail?escapeHtml(detail):'—'}</td><td class="col-status"><span class="status-badge ${status}">${status}</span></td><td class="col-seq">${e.sequence_number}</td></tr>`;}).join('')||'<tr><td colspan="6"><p class="empty-copy">No sub-agent events match this filter.</p></td></tr>';
$('event-log-page').textContent=`${items.length?eventLogOffset+1:0}–${eventLogOffset+items.length} shown`;$('event-log-prev').disabled=eventLogOffset===0;$('event-log-next').disabled=items.length<eventLogPageSize;}catch(error){$('error').textContent=error.message;}}
function selectEvent(id){selectedEvent=id;renderFlow();renderEventLog();const n=graph.nodes.find(x=>x.id===id);if(!n)return;const antecedents=graph.edges.filter(e=>e.source===id),dependents=graph.edges.filter(e=>e.target===id);$('evidence-content').innerHTML=`<span class="eyebrow">EVENT EVIDENCE</span><h2>${escapeHtml(n.type)}</h2><dl class="evidence-fields"><dt>Event ID</dt><dd><code>${id}</code></dd><dt>Agent</dt><dd>${escapeHtml(n.agent_id)}</dd><dt>Execution</dt><dd><code>${n.agent_execution_id}</code></dd><dt>Session</dt><dd>${escapeHtml(n.session_id||'—')}</dd><dt>Sequence</dt><dd>${n.sequence_number}</dd><dt>Occurred</dt><dd>${escapeHtml(n.occurred_at)}</dd><dt>Ingested</dt><dd>${escapeHtml(n.ingested_at||'—')}</dd><dt>Trace / span</dt><dd>${escapeHtml(n.trace_id||'—')} / ${escapeHtml(n.span_id||'—')}</dd><dt>Schema</dt><dd>${n.schema_version||1}</dd><dt>Causal links</dt><dd>${antecedents.length} antecedent · ${dependents.length} dependent</dd></dl><h3>Metadata</h3><pre>${escapeHtml(JSON.stringify(n.metadata,null,2))}</pre><button id="investigate-event" type="button">Investigate this event</button>`;$('evidence-drawer').hidden=false;$('investigate-event').onclick=async()=>{try{await request(`/api/runs/${current}/investigations`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({eventId:id,signal:'USER_REQUESTED'})});$('investigate-event').textContent='Investigation queued';$('investigate-event').disabled=true;}catch(error){$('error').textContent=error.message;}};}
document.addEventListener('click', e => {
  const target = e.target.closest('[data-event]');
  if (target && !target.closest('#run-list')) {
    const modal = $('investigation-modal');
    if (modal && !modal.hidden) modal.hidden = true;
    selectEvent(target.dataset.event);
  }
});
$('close-drawer').onclick = () => { $('evidence-drawer').hidden = true; };
const modalCloseBtn = $('close-investigation-modal');
if (modalCloseBtn) modalCloseBtn.onclick = () => { $('investigation-modal').hidden = true; };
const investModal = $('investigation-modal');
if (investModal) {
  investModal.addEventListener('click', e => {
    if (e.target === investModal) investModal.hidden = true;
  });
}
window.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    const m = $('investigation-modal');
    if (m && !m.hidden) m.hidden = true;
  }
});
const investSummary = $('investigation-summary');
if (investSummary) {
  investSummary.addEventListener('click', e => {
    const trigger = e.target.closest('[data-report-idx]');
    if (trigger) {
      const idx = Number(trigger.dataset.reportIdx);
      if (!Number.isNaN(idx)) showInvestigationModal(idx);
    }
  });
  investSummary.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      const trigger = e.target.closest('tr[data-report-idx]');
      if (trigger) {
        e.preventDefault();
        const idx = Number(trigger.dataset.reportIdx);
        if (!Number.isNaN(idx)) showInvestigationModal(idx);
      }
    }
  });
}
$('refresh-runs').onclick=loadRuns;$('run-search').addEventListener('input',debounce(loadRuns,250));$('run-status').onchange=loadRuns;$('failure-category').onchange=loadRuns;$('event-log-search').addEventListener('input',debounce(()=>renderEventLog(true),250));$('event-log-prev').onclick=()=>{eventLogOffset=Math.max(0,eventLogOffset-eventLogPageSize);void renderEventLog();};$('event-log-next').onclick=()=>{eventLogOffset+=eventLogPageSize;void renderEventLog();};$('agent-pills').onclick=e=>{const pill=e.target.closest('.agent-pill');if(!pill)return;eventLogFilter=pill.dataset.agent;renderEventLog(true);};
const agentMessages = {
  starting: ['Getting the team ready.', 'Preparing a new run.'],
  discovering: ['A little look around first.', 'Mapping the paths your website can take.'],
  planning: ['Finding the right paths.', 'Choosing what matters for your task.'],
  running: ['Eyes on the browsers.', 'The team is working through its assigned paths.'],
  cancelling: ['Bringing everyone back.', 'Stopping work and closing browser sessions.'],
  observing: ['One last look at the evidence.', 'Browsers are closing while the observer finishes.'],
  succeeded: ['The assigned tasks are complete.', 'Results and observer reports are ready to review.'],
  completed_with_failures: ['A few things need a closer look.', 'Check the results and their supporting events.'],
  blocked: ['We need a different path.', 'The run could not find an executable task path.'],
  failed: ['Something interrupted the run.', 'The event log has the details.'],
  cancelled: ['Everyone is off duty.', 'This run was cancelled.'],
  idle: ['All quiet on the browser front.', "Give the team a task. I'll keep an eye on things."]
};
function updateLookoutBot(status, detail) {
  const messageEl = $('agent-message');
  const detailEl = $('agent-detail');
  if (!messageEl || !detailEl) return;
  const pair = agentMessages[status] || ['Keeping an eye on things.', 'Run updates will appear here.'];
  messageEl.textContent = pair[0];
  detailEl.textContent = detail || pair[1];
}
function renderLive(run){current=run.id;$('status').textContent=run.status.replaceAll('_',' ');document.body.dataset.phase=run.status;updateLookoutBot(run.status);$('feed-count').textContent=String(run.sessions.filter(s=>s.status==='running').length).padStart(2,'0');$('empty-monitors').hidden=run.sessions.length>0;$('stop').disabled=!['starting','discovering','planning','running','cancelling'].includes(run.status);$('start').disabled=!$('stop').disabled||run.status==='observing';$('plan').textContent=JSON.stringify(run.plan||{},null,2);if(run.map){$('tree').textContent=JSON.stringify(run.map,null,2);$('download').hidden=false;$('download').href=`/api/runs/${run.id}/map`;}for(const info of run.sessions){let card=cards.get(info.sessionId);if(!card){card=document.createElement('div');card.className='session';card.innerHTML='<div class="monitor-header"><span class="session-label"></span><span class="session-status"></span></div><div class="feed-screen"></div><div class="monitor-footer"><span class="session-identity"></span><span>READ ONLY</span></div>';cards.set(info.sessionId,card);$('sessions').append(card);}card.dataset.status=info.status;card.querySelector('.session-label').textContent=`${info.role} / ${info.agentId}`;card.querySelector('.session-status').textContent=info.status;card.querySelector('.session-identity').textContent=info.sessionId;const screen=card.querySelector('.feed-screen');if(info.status==='running'&&info.liveUrl){let frame=screen.querySelector('iframe');if(!frame){screen.replaceChildren();frame=document.createElement('iframe');frame.title=`Live browser: ${info.agentId}`;screen.append(frame);}if(frame.dataset.liveUrl!==info.liveUrl){const url=new URL(info.liveUrl);url.searchParams.set('readOnly','true');frame.dataset.liveUrl=info.liveUrl;frame.src=url.href;}}else screen.innerHTML=`<div class="feed-placeholder">Session ${escapeHtml(info.status)}</div>`;}}

function renderReplayTimeline(sessionId) {
  const state = replays.get(sessionId); if (!state?.timeline) return;
  const rows = eventsForSession([...eventRows.values()], sessionId);
  state.events = rows; state.timeline.replaceChildren();
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index], status = eventStatus(row.type, row.data);
    const button = document.createElement('button'); button.type = 'button';
    button.className = `replay-event ${status} ${isPlaybackEvent(row) ? 'playback-event' : 'sync-event'}`;
    button.dataset.eventKey = eventKey(row);
    const detail = extractDetail(row.type, row.data);
    button.innerHTML = `<span>${fmtTime(row.time)}</span><strong>${escapeHtml(row.type)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ''}`;
    button.onclick = () => selectEvent(row.eventId || eventKey(row));
    if (state.page) {
      const offset = eventOffsetSeconds(row, state.page);
      if (offset != null) button.onclick = () => { selectEvent(row.eventId || eventKey(row)); seekVideo(sessionId, offset); };
      else button.disabled = true;
    } else button.disabled = true;
    state.timeline.append(button);
  }
}
function highlightReplayEvent(sessionId) {
  const state = replays.get(sessionId); if (!state?.video || !state.page || !state.events.length) return;
  const targetTime = state.page.started_at ? new Date(state.page.started_at).getTime() + state.video.currentTime * 1000 : null;
  const activeIndex = targetTime == null ? -1 : nearestEventIndex(state.events, targetTime);
  for (const button of state.timeline.querySelectorAll('.replay-event')) button.classList.remove('current');
  if (activeIndex >= 0) {
    const active = state.timeline.children[activeIndex];
    if (active) { active.classList.add('current'); active.scrollIntoView({ block: 'nearest' }); }
  }
}
function seekVideo(sessionId, seconds) {
  const state = replays.get(sessionId); if (!state?.video) return;
  const target = Math.max(0, Number(seconds) || 0);
  try { state.video.currentTime = target; void state.video.play().catch(() => {}); }
  catch { state.video.addEventListener('loadedmetadata', () => { state.video.currentTime = target; }, { once: true }); }
}
function attachReplayPage(sessionId, page) {
  const state = replays.get(sessionId); if (!state?.video) return;
  state.page = page;
  if (!page.has_recording || !page.recording_url) {
    state.message.textContent = page.status_message || 'Recording unavailable for this page.';
    state.video.hidden = true; renderReplayTimeline(sessionId); return;
  }
  state.message.textContent = page.status_message || 'Replay synced with event timeline.';
  state.video.hidden = false;
  if (window.Hls?.isSupported()) {
    state.hls?.destroy();
    const hls = new window.Hls(); state.hls = hls;
    hls.loadSource(page.recording_url); hls.attachMedia(state.video);
  } else {
    state.video.src = page.recording_url;
  }
  renderReplayTimeline(sessionId);
}
function showReplay(card, sessionId, pages) {
  const screen = card.querySelector('.feed-screen'); screen.replaceChildren();
  const layout = document.createElement('div'); layout.className = 'replay-layout';
  const media = document.createElement('div'); media.className = 'replay-media';
  const message = document.createElement('div'); message.className = 'replay-message';
  const video = document.createElement('video'); video.controls = true; video.preload = 'metadata'; video.setAttribute('playsinline', '');
  media.append(message);
  if (pages.length > 1) {
    const select = document.createElement('select'); select.className = 'replay-page';
    pages.forEach((page, index) => select.append(Object.assign(document.createElement('option'), {
      value: String(index), textContent: `Page ${index + 1}`,
    })));
    select.onchange = () => attachReplayPage(sessionId, pages[Number(select.value)]); media.append(select);
  }
  media.append(video);
  const timeline = document.createElement('div'); timeline.className = 'replay-timeline';
  layout.append(media, timeline); screen.append(layout);
  replays.get(sessionId)?.hls?.destroy();
  replays.set(sessionId, { pages, page: pages[0], video, timeline, message, events: [] });
  video.addEventListener('timeupdate', () => highlightReplayEvent(sessionId)); attachReplayPage(sessionId, pages[0]);
}
function showReplayGap(card, sessionId, messageText) {
  const screen = card.querySelector('.feed-screen'); screen.replaceChildren();
  const layout = document.createElement('div'); layout.className = 'replay-layout replay-gap';
  const message = document.createElement('div'); message.className = 'replay-message'; message.textContent = messageText;
  const timeline = document.createElement('div'); timeline.className = 'replay-timeline';
  layout.append(message, timeline); screen.append(layout); replays.get(sessionId)?.hls?.destroy();
  replays.set(sessionId, { timeline, message, gap: messageText, events: [] }); renderReplayTimeline(sessionId);
}
async function loadReplay(runId, info, card, attempt = 0) {
  const button = card.querySelector('.load-replay');
  if (button) { button.disabled = true; button.textContent = attempt ? 'Recording is processing…' : 'Loading replay…'; }
  try {
    const replay = await request(`/api/runs/${encodeURIComponent(runId)}/sessions/${encodeURIComponent(info.sessionId)}/replay`);
    if (replay.status === 'pending') {
      if (attempt < 15) setTimeout(() => void loadReplay(runId, info, card, attempt + 1), replay.retry_after_ms);
      else showReplayGap(card, info.sessionId, 'Recording is still unavailable. The event timeline remains available.');
      return;
    }
    showReplay(card, info.sessionId, replay.pages);
  } catch (error) { showReplayGap(card, info.sessionId, `Replay gap: ${error.message}. The event timeline remains available.`); }
}
function renderSessionInfo(runId, info) {
  let card = cards.get(info.sessionId);
  if (!card) {
    card = document.createElement('div'); card.className = 'session';
    card.innerHTML = '<div class="monitor-header"><span class="session-label"></span><span class="session-status"></span></div><div class="feed-screen"></div><div class="monitor-footer"><span class="session-identity"></span><span>READ ONLY</span></div>';
    cards.set(info.sessionId, card); $('sessions').append(card);
  }
  card.dataset.status = info.status; card.querySelector('.session-label').textContent = `${info.role} / ${info.agentId}`;
  card.querySelector('.session-status').textContent = info.status; card.querySelector('.session-identity').textContent = info.sessionId;
  const screen = card.querySelector('.feed-screen');
  if (info.status === 'running' && info.liveUrl) {
    let frame = screen.querySelector('iframe'); if (!frame) { screen.replaceChildren(); frame = document.createElement('iframe'); frame.title = `Live browser: ${info.agentId}`; screen.append(frame); }
    if (frame.dataset.liveUrl !== info.liveUrl) { const url = new URL(info.liveUrl); url.searchParams.set('readOnly', 'true'); frame.dataset.liveUrl = info.liveUrl; frame.src = url.href; }
    return;
  }
  if (info.status === 'closed') {
    const state = replays.get(info.sessionId);
    if (state?.pages) { if (!screen.querySelector('.replay-layout')) showReplay(card, info.sessionId, state.pages); else renderReplayTimeline(info.sessionId); return; }
    if (state?.gap) { if (!screen.querySelector('.replay-layout')) showReplayGap(card, info.sessionId, state.gap); else renderReplayTimeline(info.sessionId); return; }
    screen.replaceChildren(); const placeholder = document.createElement('div'); placeholder.className = 'feed-placeholder';
    placeholder.append(document.createTextNode('Session closed · '));
    const load = document.createElement('button'); load.type = 'button'; load.className = 'load-replay'; load.textContent = 'Load replay';
    load.onclick = () => void loadReplay(runId, info, card); placeholder.append(load); screen.append(placeholder); return;
  }
  screen.innerHTML = `<div class="feed-placeholder">Session ${escapeHtml(info.status)}</div>`;
}
const renderLiveBase = renderLive;
renderLive = function renderLiveWithReplay(run) {
  renderLiveBase(run); for (const info of run.sessions) renderSessionInfo(run.id, info);
};
const renderSummaryBase = renderSummary;
renderSummary = function renderSummaryWithSessions(summary) {
  renderSummaryBase(summary);
  const sessions = new Map();
  for (const node of graph.nodes) if (node.session_id) {
    eventRows.set(node.id, { eventId: node.id, runId: summary.run_id, agentExecutionId: node.agent_execution_id,
      agentId: node.agent_id, sessionId: node.session_id, seq: node.sequence_number,
      time: node.occurred_at, type: node.type, data: node.metadata });
    sessions.set(node.session_id, { sessionId: node.session_id, agentId: node.agent_id, role: node.agent_id,
      liveUrl: '', status: 'closed' });
  }
  for (const info of sessions.values()) renderSessionInfo(summary.run_id, info);
  $('empty-monitors').hidden = sessions.size > 0 || cards.size > 0;
  $('feed-count').textContent = String(sessions.size || cards.size).padStart(2, '0');
  updateLookoutBot(summary.status);
};
function connect(id){
  stream?.close(); stream = new EventSource(`/api/runs/${id}/stream`);
  stream.addEventListener('run', event => renderLive(JSON.parse(event.data)));
  stream.addEventListener('log', event => {
    const row = JSON.parse(event.data), key = eventKey(row); if (seen.has(key)) return; seen.add(key); eventRows.set(key, row);
    if (current === id && row.eventId && !graph.nodes.some(node => node.id === row.eventId)) {
      graph.nodes.push({ id: row.eventId, type: row.type, agent_execution_id: row.agentExecutionId,
        agent_id: row.agentId, session_id: row.sessionId, occurred_at: row.time,
        sequence_number: row.seq, metadata: row.data }); renderFlow(); if (eventLogOffset === 0) renderEventLog();
    }
    if (row.sessionId) renderReplayTimeline(row.sessionId);
    const phase = document.body.dataset.phase;
    if (['starting', 'discovering', 'planning', 'running', 'observing'].includes(phase)) {
      const detailText = extractDetail(row.type, row.data);
      const activity = `${row.agentId || 'agent'}: ${row.type.replace(/^.*\./, '')}${detailText ? ' — ' + detailText : ''}`;
      updateLookoutBot(phase, activity);
    }
  });
  stream.addEventListener('investigation', () => void selectRun(id));
  stream.onerror = () => { $('error').textContent = 'Live stream disconnected; reconnecting automatically.'; };
  stream.onopen = () => { $('error').textContent = ''; };
}
$('form').addEventListener('submit', async e => {
  e.preventDefault();
  eventRows.clear();
  for (const state of replays.values()) state.hls?.destroy();
  replays.clear();
  $('error').textContent = '';
  $('start').disabled = true;
  updateLookoutBot('starting');
  try {
    const file = $('mapFile').files[0],
      data = {
        targetUrl: $('url').value,
        prompt: $('prompt').value,
        maxWorkers: Number($('workers').value),
        testSingleAction: $('singleAction').checked,
        ...(file ? { flowMap: JSON.parse(await file.text()) } : {})
      },
      run = await request('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
    seen.clear();
    cards.clear();
    graph = { nodes: [], edges: [] };
    $('sessions').replaceChildren();
    localStorage.setItem('lastRun', run.id);
    renderLive(run);
    connect(run.id);
    showView('browsers');
  } catch (error) {
    $('error').textContent = error.message;
    $('start').disabled = false;
  }
});
$('stop').onclick = async () => {
  try { await request(`/api/runs/${current}/cancel`, { method: 'POST' }); }
  catch (error) { $('error').textContent = error.message; }
};
request('/api/config').then(c => {
  $('workers').min = 1;
  $('workers').max = c.maxWorkers;
  $('workers').value = Math.min(Number($('workers').value) || 2, c.maxWorkers);
  $('workers').readOnly = false;
  if (c.missingCredentials.length) $('error').textContent = `Configure .env and restart: ${c.missingCredentials.join(', ')}`;
}).catch(e => { $('error').textContent = e.message; });
const previous = localStorage.getItem('lastRun');
if (previous) selectRun(previous).catch(() => localStorage.removeItem('lastRun'));
void loadRuns();
