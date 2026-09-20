import { eventKey, eventOffsetSeconds, eventsForSession, isPlaybackEvent,
  nearestEventIndex } from './replay-utils.js';

const $ = id => document.getElementById(id);
<<<<<<< HEAD
$('nav').addEventListener('click', event => {
  const button = event.target.closest('button[data-view]');
  if (!button) return;
  for (const b of $('nav').querySelectorAll('button')) {
    b.classList.toggle('active', b === button);
    if (b === button) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  for (const view of document.querySelectorAll('.view')) view.classList.toggle('active', view.id === `view-${button.dataset.view}`);
  const headings = {
    browsers: ['Control Room', 'A front-row seat to every path, click, and discovery.'],
    observer: ['A second pair of eyes', 'Observed facts, possible causes, and the evidence behind them.'],
    results: ['Every path has an outcome', 'See where each assigned task landed.'],
    events: ['The whole story', 'Follow the observations and actions behind a run.'],
  };
  $('view-name').textContent = button.dataset.view[0].toUpperCase() + button.dataset.view.slice(1);
  $('page-title').replaceChildren(document.createTextNode(headings[button.dataset.view][0]), Object.assign(document.createElement('span'), { textContent: '.' }));
  $('page-description').textContent = headings[button.dataset.view][1];
});
let current, stream;
const seen = new Set();
const cards = new Map();
const eventRows = new Map();
async function request(url, options) {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data;
}
function render(run) {
  current = run.id;
  $('status').textContent = run.status.replaceAll('_', ' ');
  $('status').title = `Run ${run.id}`;
  document.body.dataset.phase = run.status;
  $('feed-count').textContent = String(run.sessions.filter(s => s.status === 'running').length).padStart(2, '0');
  $('empty-monitors').hidden = run.sessions.length > 0;
  const messages = {
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
  };
  const message = messages[run.status] || ['Keeping an eye on things.', 'Run updates will appear here.'];
  $('agent-message').textContent = message[0];
  $('agent-detail').textContent = message[1];
  $('stop').disabled = !['starting', 'discovering', 'planning', 'running', 'cancelling'].includes(run.status);
  $('start').disabled = !$('stop').disabled || run.status === 'observing';
  $('plan').textContent = JSON.stringify(run.plan || {}, null, 2);
  $('results').textContent = JSON.stringify(run.results, null, 2);
  $('findings').textContent = run.findings.map(f => JSON.stringify(f, null, 2)).join('\n\n') || 'No findings yet';
  if (run.map) {
    const visited = new Set();
    function tree(id) {
      if (visited.has(id)) return { stateId: id, reference: true };
      visited.add(id);
      const state = run.map.states.find(candidate => candidate.id === id);
      return { stateId: id, task: state?.task || '', branches: run.map.transitions.filter(t => t.from === id).map(t => ({
        id: t.id, actions: t.actions, status: t.status, reason: t.reason, next: t.to ? tree(t.to) : null,
      })) };
    }
    $('tree').textContent = JSON.stringify({ status: run.map.status, notes: run.map.notes, tree: tree(run.map.rootId) }, null, 2);
    $('download').hidden = false; $('download').href = `/api/runs/${run.id}/map`;
  }
  for (const info of run.sessions) {
    let card = cards.get(info.sessionId);
    if (!card) {
      card = document.createElement('div'); card.className = 'session';
      const header = document.createElement('div'); header.className = 'monitor-header';
      const label = document.createElement('span'); label.className = 'session-label';
      const status = document.createElement('span'); status.className = 'session-status';
      header.append(label, status);
      const screen = document.createElement('div'); screen.className = 'feed-screen';
      const footer = document.createElement('div'); footer.className = 'monitor-footer';
      const identity = document.createElement('span'); identity.className = 'session-identity';
      const mode = document.createElement('span'); mode.textContent = 'READ ONLY';
      footer.append(identity, mode); card.append(header, screen, footer);
      cards.set(info.sessionId, card); $('sessions').append(card);
    }
    if (info.status === 'running' && info.liveUrl) {
      let frame = card.querySelector('iframe');
      card.querySelector('.feed-placeholder')?.remove();
      if (!frame) { frame = document.createElement('iframe'); frame.title = `Live browser: ${info.agentId}`; card.querySelector('.feed-screen').append(frame); }
      const url = new URL(info.liveUrl); url.searchParams.set('readOnly', 'true');
      // Browserbase may redirect/canonicalize the iframe URL. Comparing
      // frame.src to the original URL then reloads DevTools on every run
      // update, closing its WebSocket even though the session is healthy.
      if (frame.dataset.liveUrl !== info.liveUrl) {
        frame.dataset.liveUrl = info.liveUrl;
        frame.src = url.href;
      }
    } else {
      card.querySelector('iframe')?.remove();
      let placeholder = card.querySelector('.feed-placeholder');
      if (!placeholder) { placeholder = document.createElement('div'); placeholder.className = 'feed-placeholder'; card.querySelector('.feed-screen').append(placeholder); }
      placeholder.textContent = info.status === 'running' ? 'Connecting the live view…' : info.status === 'closed' ? 'Session closed · see results and events' : `Session ${info.status} · check events`;
    }
    if (info.status === 'running' && !info.liveUrl) {
      let note = card.querySelector('.live-view-note');
      if (!note) { note = document.createElement('small'); note.className = 'live-view-note'; card.append(note); }
      note.textContent = 'Live view URL is not available yet; check the session events for details.';
    } else card.querySelector('.live-view-note')?.remove();
    card.dataset.status = info.status;
    card.querySelector('.session-label').textContent = `CAM ${String(run.sessions.indexOf(info) + 1).padStart(2, '0')} / ${info.agentId.toUpperCase()}`;
    card.querySelector('.session-status').textContent = info.status === 'running' && info.liveUrl ? 'LIVE' : info.status.toUpperCase();
    card.querySelector('.session-identity').textContent = `${info.role} · ${info.sessionId}`;
    card.querySelector('.session-identity').title = info.sessionId;
    let instruction = card.querySelector('.session-instruction');
    if (info.instruction) {
      if (!instruction) { instruction = document.createElement('p'); instruction.className = 'session-instruction'; card.append(instruction); }
      instruction.textContent = info.instruction;
    } else instruction?.remove();
=======
let current, stream, graph = { nodes: [], edges: [] }, selectedEvent;
let eventLogOffset = 0, eventLogPageSize = 50, eventLogFilter = 'all';
const seen = new Set(), cards = new Map();
const eventRows = new Map(), replays = new Map();
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
  if (data.selector) return String(data.selector).slice(0, 40);
  return '';
}
function fmtTime(iso) { try { return new Date(iso).toLocaleTimeString(); } catch { return iso; } }
const headings = { runs:['Run intelligence','Find a run, understand its outcome, and follow the evidence.'], overview:['Run overview','A consistent summary of agents, signals, coverage, and decisions.'], investigate:['Failure investigation','Follow the causal path from assumptions to effects.'], browsers:['Observation room','A front-row seat to every browser path and action.'] };
function showView(name) { for (const b of $('nav').querySelectorAll('button')) { const active = b.dataset.view === name; b.classList.toggle('active', active); active ? b.setAttribute('aria-current','page') : b.removeAttribute('aria-current'); } for (const view of document.querySelectorAll('.view')) view.classList.toggle('active', view.id === `view-${name}`); $('view-name').textContent = name[0].toUpperCase()+name.slice(1); $('page-title').replaceChildren(document.createTextNode(headings[name][0]), Object.assign(document.createElement('span'), {textContent:'.'})); $('page-description').textContent = headings[name][1]; $('form').hidden = name !== 'browsers'; }
$('nav').addEventListener('click', event => { const button = event.target.closest('button[data-view]'); if (button) showView(button.dataset.view); });

async function loadRuns() { const params = new URLSearchParams({limit:'100'}); if ($('run-search').value) params.set('search',$('run-search').value); if ($('run-status').value) params.set('status',$('run-status').value); if ($('failure-category').value) params.set('failureCategory',$('failure-category').value); try { const [data,metrics] = await Promise.all([request(`/api/runs?${params}`),request('/api/dashboard/metrics')]); renderGlobalMetrics(data.items,metrics); renderRunList(data.items); } catch (error) { $('error').textContent = error.message; } }
function renderGlobalMetrics(runs,daily) { const successful=runs.filter(r=>r.status==='succeeded').length, failures=runs.reduce((s,r)=>s+Number(r.failure_count||0),0), backlog=runs.reduce((s,r)=>s+Number(r.investigation_backlog||0),0), recovery=runs.filter(r=>r.investigation_outcome==='RECOVERED_FAILURE').length; $('global-metrics').innerHTML=[["Runs",runs.length,'in current result'],['Success rate',runs.length?`${Math.round(successful/runs.length*100)}%`:'—',`${successful} succeeded`],['Failure clusters',failures,`${recovery} recovered`],['Investigation backlog',backlog,'queued or running']].map(([l,v,n])=>`<article class="metric"><span>${l}</span><strong>${v}</strong><small>${n}</small></article>`).join(''); const grouped=new Map(); for(const row of daily){const day=String(row.day).slice(0,10), entry=grouped.get(day)||{total:0,failed:0}; entry.total+=Number(row.runs); if(String(row.status).includes('fail'))entry.failed+=Number(row.runs); grouped.set(day,entry);} const max=Math.max(1,...[...grouped.values()].map(v=>v.total)); $('outcome-chart').innerHTML=[...grouped.entries()].slice(-14).map(([day,v])=>`<div class="bar-column" title="${day}: ${v.total} runs, ${v.failed} failed"><div class="bar failure" style="height:${v.failed/max*100}%"></div><div class="bar success" style="height:${(v.total-v.failed)/max*100}%"></div><span>${day.slice(5)}</span></div>`).join('')||'<p class="empty-copy">No historical metrics yet.</p>'; }
function renderRunList(runs) { $('run-list').innerHTML=runs.map(run=>`<button class="run-row ${String(run.status).includes('fail')?'has-failure':''}" data-run="${run.run_id}"><span class="run-health"></span><span class="run-main"><strong>${escapeHtml(run.goal)}</strong><small>${run.run_id} · ${escapeHtml(run.workflow_type||'workflow')}</small></span><span><small>Status</small><strong>${escapeHtml(run.status)}</strong></span><span><small>Duration</small><strong>${fmtDuration(run.duration_ms)}</strong></span><span><small>Agents / events</small><strong>${run.agent_count||0} / ${run.event_count||0}</strong></span><span><small>Failures</small><strong>${run.failure_count||0}</strong></span><span><small>Cause</small><strong>${escapeHtml(run.failure_category||'—')}</strong></span></button>`).join('')||'<p class="empty-copy">No runs match these filters.</p>'; }
$('run-list').addEventListener('click',e=>{const row=e.target.closest('[data-run]');if(row)void selectRun(row.dataset.run);});
async function selectRun(id) { current=id; localStorage.setItem('lastRun',id); $('error').textContent=''; try { const [summary,runGraph]=await Promise.all([request(`/api/runs/${id}/summary`),request(`/api/runs/${id}/graph`)]); graph=runGraph; renderSummary(summary); renderInvestigations(summary.investigations||[]); renderFlow(); renderEventLog(true); $('status').textContent=String(summary.status).replaceAll('_',' '); document.body.dataset.phase=summary.status; showView(Number(summary.metrics?.failures||0)>0?'investigate':'overview'); if(['starting','discovering','planning','running','observing'].includes(summary.status))connect(id); } catch(error){$('error').textContent=error.message;} }
function renderSummary(s) { const m=s.metrics||{}; const subAgents=filterSubAgents(s.agents); $('run-summary').innerHTML=`<div class="run-title"><div><span class="eyebrow">${escapeHtml(s.workflow_type)}</span><h2>${escapeHtml(s.goal)}</h2><code>${s.run_id}</code></div><span class="outcome ${String(s.status).includes('fail')?'bad':''}">${escapeHtml(s.status)}</span></div><div class="metric-grid compact">${[['Duration',fmtDuration(s.completed_at?new Date(s.completed_at)-new Date(s.created_at):null)],['Agents',subAgents.length],['Events',m.events||0],['Failures',m.failures||0],['Model calls',m.model_calls||0],['Tool calls',m.tool_calls||0],['Retries',m.retries||0],['p95 latency',m.latency_p95_ms?`${Math.round(m.latency_p95_ms)}ms`:'—']].map(([k,v])=>`<div class="metric"><span>${k}</span><strong>${v}</strong></div>`).join('')}</div><div class="stage-strip">${['discovery','planning','execution','observation','completion'].map(stage=>`<span class="${graph.nodes.some(n=>n.type==='workflow.stage.completed'&&n.metadata?.stage===stage)?'done':''}">${stage}</span>`).join('')}</div>`; $('agent-cards').innerHTML=subAgents.map(a=>`<article class="agent-card"><span>${escapeHtml(a.agent_id)}</span><strong>${escapeHtml(a.assigned_task||'coordination')}</strong><dl><dt>Outcome</dt><dd>${escapeHtml(a.outcome||'—')}</dd><dt>Events</dt><dd>${a.event_count}</dd><dt>Retries</dt><dd>${a.retry_count}</dd><dt>Last signal</dt><dd>${escapeHtml(a.last_event||'—')}</dd></dl></article>`).join('')||'<p class="empty-copy">No sub-agent executions recorded for this run.</p>'; const decisions=filterSubAgents(graph.nodes.filter(n=>n.type==='decision.recorded'||n.type==='decision.revised')); $('decisions').innerHTML=decisions.map(n=>`<button data-event="${n.id}" class="decision"><span>${escapeHtml(n.agent_id)}</span><strong>${escapeHtml(n.metadata.decision)}</strong><small>${(n.metadata.assumptions||[]).length?escapeHtml(n.metadata.assumptions.join(' · ')):'Unsupported: no assumptions or evidence recorded'}</small></button>`).join('')||'<p class="empty-copy">No explicit decision summaries were recorded for this run.</p>'; }
function renderInvestigations(items) { const reports=items.filter(i=>i.report).map(i=>i.report); $('investigation-summary').innerHTML=reports.map(r=>`<article class="failure-report"><header><div><span class="outcome bad">${escapeHtml(r.outcome)}</span><h2>${escapeHtml(r.title||r.summary||r.observed_failure||'Observer finding')}</h2></div><span class="confidence">${escapeHtml(r.likely_cause?.confidence||'—')} confidence</span></header><h3>Observed facts</h3><ol>${r.observed_facts.map(f=>`<li>${escapeHtml(f.statement)} ${f.event_ids.map(id=>`<button class="citation" data-event="${id}">${id.slice(0,8)}</button>`).join(' ')}</li>`).join('')}</ol>${r.likely_cause?`<h3>Likely cause · ${escapeHtml(r.likely_cause.category)}</h3><p>${escapeHtml(r.likely_cause.explanation)}</p>`:''}<h3>Evidence gaps and alternatives</h3><ul>${r.evidence_gaps_and_alternatives.map(g=>`<li>${escapeHtml(g)}</li>`).join('')||'<li>None recorded.</li>'}</ul>${r.reproduction_step?`<h3>Reproduction step</h3><p>${escapeHtml(r.reproduction_step)}</p>`:''}<details><summary>Raw report JSON</summary><pre>${escapeHtml(JSON.stringify(r,null,2))}</pre></details></article>`).join('')||'<p class="empty-copy">No completed investigation report yet. Failure clusters remain visible in the agent flow.</p>'; }
function sortAgentLanes(a,b){const order={orchestrator:0,observer:2};const ao=order[a]??1,bo=order[b]??1;if(ao!==bo)return ao-bo;if(a.startsWith('worker-')&&b.startsWith('worker-'))return Number(a.slice(7))-Number(b.slice(7));return a.localeCompare(b);}
function renderFlow(){const container=$('flow-container'),lanesEl=$('flow-lanes'),axisEl=$('flow-axis'),edgesEl=$('flow-edges'),statsEl=$('flow-stats');const nodes=filterSubAgents(graph.nodes);if(!nodes.length){lanesEl.innerHTML=axisEl.innerHTML=edgesEl.innerHTML='';statsEl.innerHTML='<span class="quiet-label">NO SUB-AGENT EVENTS</span>';return;}const laneNames=[...new Set(nodes.map(n=>n.agent_id))].sort(sortAgentLanes);const times=nodes.map(n=>new Date(n.occurred_at).getTime());const min=Math.min(...times),max=Math.max(...times, min+1);const durationMs=max-min;const pxPerMs=Math.max(0.25, Math.min(2, 8000 / Math.max(durationMs, 1000)));const axisPadding=16,nodeWidth=122,laneWidth=Math.max(nodeWidth+28,160),totalWidth=Math.max(container.clientWidth-30,laneNames.length*laneWidth+axisPadding+20);const totalHeight=Math.max(280, durationMs*pxPerMs+120);const byId=new Map(nodes.map(n=>[n.id,n]));
statsEl.innerHTML=`<span><strong>${nodes.length}</strong><em>events</em></span><span><strong>${nodes.filter(n=>isFailure(n.type,n.metadata)).length}</strong><em>failures</em></span><span><strong>${laneNames.length}</strong><em>agents</em></span><span><strong>${fmtDuration(durationMs)}</strong><em>duration</em></span><span class="quiet-label">SELECT AN EVENT TO OPEN EVIDENCE</span>`;
axisEl.innerHTML='';const ticks=Math.max(4,Math.floor(totalWidth/120));for(let i=0;i<=ticks;i++){const t=min+(max-min)*(i/ticks);const left=axisPadding+(t-min)*pxPerMs;const mark=document.createElement('mark');mark.style.left=`${left}px`;const label=document.createElement('label');label.textContent=fmtTime(new Date(t));mark.append(label);axisEl.append(mark);}
lanesEl.style.width=`${totalWidth}px`;lanesEl.style.height=`${totalHeight}px`;lanesEl.innerHTML=laneNames.map(name=>`<div class="flow-lane" data-agent="${escapeHtml(name)}"><div class="flow-lane-label">${escapeHtml(name)}</div><div class="flow-nodes" data-agent="${escapeHtml(name)}"></div></div>`).join('');
for(const n of nodes){const lane=document.querySelector(`.flow-nodes[data-agent="${CSS.escape(n.agent_id)}"]`);if(!lane)continue;const top=40+(new Date(n.occurred_at).getTime()-min)*pxPerMs;const left=axisPadding;const status=eventStatus(n.type,n.metadata);const detail=extractDetail(n.type,n.metadata);const btn=document.createElement('button');btn.type='button';btn.className=`flow-node ${status==='failure'?'failure':''} ${selectedEvent===n.id?'selected':''}`;btn.dataset.event=n.id;btn.dataset.status=status;btn.style.top=`${top}px`;btn.style.left=`${left}px`;btn.title=`${escapeHtml(n.type)}\n${detail ? escapeHtml(detail) + '\n' : ''}${fmtTime(n.occurred_at)} · seq ${n.sequence_number}`;btn.innerHTML=`<span class="node-type"><span class="status-dot"></span>${escapeHtml(n.type)}</span>${detail?`<span class="node-detail">${escapeHtml(detail)}</span>`:''}<span class="node-time">${fmtTime(n.occurred_at)}</span>`;lane.append(btn);}
edgesEl.style.width=`${totalWidth}px`;edgesEl.style.height=`${totalHeight}px`;edgesEl.innerHTML='';for(const e of graph.edges){const a=byId.get(e.source),b=byId.get(e.target);if(!a||!b)continue;const x1=axisPadding+nodeWidth/2,y1=40+(new Date(a.occurred_at).getTime()-min)*pxPerMs+10;const x2=axisPadding+nodeWidth/2,y2=40+(new Date(b.occurred_at).getTime()-min)*pxPerMs+10;const path=document.createElementNS('http://www.w3.org/2000/svg','path');const c1=(x1+x2)/2+40,c2=(x1+x2)/2-40;path.setAttribute('d',`M ${x1} ${y1} C ${c1} ${y1} ${c2} ${y2} ${x2} ${y2}`);path.setAttribute('class',`flow-edge ${e.inferred?'inferred':''}`);edgesEl.append(path);}}
async function renderEventLog(reset=false){if(!current)return;if(reset)eventLogOffset=0;const search=$('event-log-search').value.trim();const params=new URLSearchParams({limit:String(eventLogPageSize),offset:String(eventLogOffset)});if(search)params.set('search',search);try{const data=await request(`/api/runs/${current}/events?${params}`);let items=data.items||[];items=filterSubAgents(items.map(e=>({...e,agent_id:e.agent_id})));if(eventLogFilter!=='all')items=items.filter(e=>e.agent_id===eventLogFilter);const agents=[...new Set(filterSubAgents(graph.nodes).map(n=>n.agent_id))].sort(sortAgentLanes);const pillsEl=$('agent-pills');pillsEl.innerHTML=`<button type="button" class="agent-pill ${eventLogFilter==='all'?'active':''}" data-agent="all">All</button>`+agents.map(a=>`<button type="button" class="agent-pill ${eventLogFilter===a?'active':''} agent-badge ${agentRoleClass(a)}" data-agent="${escapeHtml(a)}">${escapeHtml(a)}<span class="pill-count">${graph.nodes.filter(n=>n.agent_id===a).length}</span></button>`).join('');
$('event-log-body').innerHTML=items.map(e=>{const status=eventStatus(e.event_type,e.metadata);const detail=extractDetail(e.event_type,e.metadata);const highlights=e.search_highlights?.length?`<small class="search-highlights">${escapeHtml(e.search_highlights.join(' · '))}</small>`:'';return `<tr data-event="${e.event_id}" class="${selectedEvent===e.event_id?'selected':''}"><td class="col-time">${fmtTime(e.occurred_at)}</td><td class="col-agent"><span class="agent-badge ${agentRoleClass(e.agent_id)}">${escapeHtml(e.agent_id)}</span></td><td class="col-type"><span class="event-kind ${status}">${escapeHtml(e.event_type)}</span>${highlights}</td><td class="col-detail">${detail?escapeHtml(detail):'—'}</td><td class="col-status"><span class="status-badge ${status}">${status}</span></td><td class="col-seq">${e.sequence_number}</td></tr>`;}).join('')||'<tr><td colspan="6"><p class="empty-copy">No sub-agent events match this filter.</p></td></tr>';
$('event-log-page').textContent=`${items.length?eventLogOffset+1:0}–${eventLogOffset+items.length} shown`;$('event-log-prev').disabled=eventLogOffset===0;$('event-log-next').disabled=items.length<eventLogPageSize;}catch(error){$('error').textContent=error.message;}}
function selectEvent(id){selectedEvent=id;renderFlow();renderEventLog();const n=graph.nodes.find(x=>x.id===id);if(!n)return;const antecedents=graph.edges.filter(e=>e.source===id),dependents=graph.edges.filter(e=>e.target===id);$('evidence-content').innerHTML=`<span class="eyebrow">EVENT EVIDENCE</span><h2>${escapeHtml(n.type)}</h2><dl class="evidence-fields"><dt>Event ID</dt><dd><code>${id}</code></dd><dt>Agent</dt><dd>${escapeHtml(n.agent_id)}</dd><dt>Execution</dt><dd><code>${n.agent_execution_id}</code></dd><dt>Session</dt><dd>${escapeHtml(n.session_id||'—')}</dd><dt>Sequence</dt><dd>${n.sequence_number}</dd><dt>Occurred</dt><dd>${escapeHtml(n.occurred_at)}</dd><dt>Ingested</dt><dd>${escapeHtml(n.ingested_at||'—')}</dd><dt>Trace / span</dt><dd>${escapeHtml(n.trace_id||'—')} / ${escapeHtml(n.span_id||'—')}</dd><dt>Schema</dt><dd>${n.schema_version||1}</dd><dt>Causal links</dt><dd>${antecedents.length} antecedent · ${dependents.length} dependent</dd></dl><h3>Metadata</h3><pre>${escapeHtml(JSON.stringify(n.metadata,null,2))}</pre><button id="investigate-event" type="button">Investigate this event</button>`;$('evidence-drawer').hidden=false;$('investigate-event').onclick=async()=>{try{await request(`/api/runs/${current}/investigations`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({eventId:id,signal:'USER_REQUESTED'})});$('investigate-event').textContent='Investigation queued';$('investigate-event').disabled=true;}catch(error){$('error').textContent=error.message;}};}
document.addEventListener('click',e=>{const target=e.target.closest('[data-event]');if(target&&!target.closest('#run-list'))selectEvent(target.dataset.event);});$('close-drawer').onclick=()=>{$('evidence-drawer').hidden=true;};
function debounce(fn,ms){let timer;return(...args)=>{clearTimeout(timer);timer=setTimeout(()=>fn(...args),ms);};}$('refresh-runs').onclick=loadRuns;$('run-search').addEventListener('input',debounce(loadRuns,250));$('run-status').onchange=loadRuns;$('failure-category').onchange=loadRuns;$('event-log-search').addEventListener('input',debounce(()=>renderEventLog(true),250));$('event-log-prev').onclick=()=>{eventLogOffset=Math.max(0,eventLogOffset-eventLogPageSize);void renderEventLog();};$('event-log-next').onclick=()=>{eventLogOffset+=eventLogPageSize;void renderEventLog();};$('agent-pills').onclick=e=>{const pill=e.target.closest('.agent-pill');if(!pill)return;eventLogFilter=pill.dataset.agent;renderEventLog(true);};
function renderLive(run){current=run.id;$('status').textContent=run.status.replaceAll('_',' ');document.body.dataset.phase=run.status;$('feed-count').textContent=String(run.sessions.filter(s=>s.status==='running').length).padStart(2,'0');$('empty-monitors').hidden=run.sessions.length>0;$('stop').disabled=!['starting','discovering','planning','running','cancelling'].includes(run.status);$('start').disabled=!$('stop').disabled||run.status==='observing';$('plan').textContent=JSON.stringify(run.plan||{},null,2);if(run.map){$('tree').textContent=JSON.stringify(run.map,null,2);$('download').hidden=false;$('download').href=`/api/runs/${run.id}/map`;}for(const info of run.sessions){let card=cards.get(info.sessionId);if(!card){card=document.createElement('div');card.className='session';card.innerHTML='<div class="monitor-header"><span class="session-label"></span><span class="session-status"></span></div><div class="feed-screen"></div><div class="monitor-footer"><span class="session-identity"></span><span>READ ONLY</span></div>';cards.set(info.sessionId,card);$('sessions').append(card);}card.dataset.status=info.status;card.querySelector('.session-label').textContent=`${info.role} / ${info.agentId}`;card.querySelector('.session-status').textContent=info.status;card.querySelector('.session-identity').textContent=info.sessionId;const screen=card.querySelector('.feed-screen');if(info.status==='running'&&info.liveUrl){let frame=screen.querySelector('iframe');if(!frame){screen.replaceChildren();frame=document.createElement('iframe');frame.title=`Live browser: ${info.agentId}`;screen.append(frame);}if(frame.dataset.liveUrl!==info.liveUrl){const url=new URL(info.liveUrl);url.searchParams.set('readOnly','true');frame.dataset.liveUrl=info.liveUrl;frame.src=url.href;}}else screen.innerHTML=`<div class="feed-placeholder">Session ${escapeHtml(info.status)}</div>`;}}
function replayEventSummary(event) {
  const data = event.data && typeof event.data === 'object' ? event.data : {};
  const detail = data.action?.kind || data.url || data.status || data.outcome || data.level || '';
  return `${new Date(event.time).toLocaleTimeString()} · ${event.type}${detail ? ` · ${detail}` : ''}`;
}
function renderReplayTimeline(sessionId) {
  const state = replays.get(sessionId); if (!state?.timeline) return;
  const events = eventsForSession([...eventRows.values()], sessionId); state.events = events;
  state.timeline.replaceChildren();
  if (!events.length) { state.timeline.textContent = 'No session events have arrived yet.'; return; }
  for (const [index, event] of events.entries()) {
    const button = document.createElement('button'); button.type = 'button';
    button.className = `replay-event${isPlaybackEvent(event) ? ' sync-event' : ''}`;
    button.dataset.eventIndex = String(index); button.textContent = replayEventSummary(event);
    if (state.page && state.video) {
      const offset = eventOffsetSeconds(event, state.page);
      const length = Math.max(0, (state.page.end_time_ms - state.page.start_time_ms) / 1000);
      if (offset >= 0 && offset <= length) button.onclick = () => { state.video.currentTime = offset; };
      else button.disabled = true;
    } else button.disabled = true;
    state.timeline.append(button);
>>>>>>> observability
  }
}
function highlightReplayEvent(sessionId) {
  const state = replays.get(sessionId); if (!state?.video || !state.page || !state.events) return;
  const selected = nearestEventIndex(state.events, state.page, state.video.currentTime);
  for (const button of state.timeline.querySelectorAll('.replay-event')) {
    button.classList.toggle('current', Number(button.dataset.eventIndex) === selected);
  }
}
function attachReplayPage(sessionId, page) {
  const state = replays.get(sessionId); if (!state) return;
  state.hls?.destroy(); state.hls = undefined; state.page = page;
  const video = state.video; video.removeAttribute('src'); video.load();
  if (video.canPlayType('application/vnd.apple.mpegurl')) video.src = page.playlist_url;
  else if (window.Hls?.isSupported()) {
    state.hls = new window.Hls(); state.hls.loadSource(page.playlist_url); state.hls.attachMedia(video);
  } else state.message.textContent = 'This browser cannot play HLS. The event timeline is still available.';
  renderReplayTimeline(sessionId);
}
function showReplay(card, sessionId, pages) {
  const screen = card.querySelector('.feed-screen'); screen.replaceChildren();
  const layout = document.createElement('div'); layout.className = 'replay-layout';
  const media = document.createElement('div'); media.className = 'replay-media';
  const message = document.createElement('div'); message.className = 'replay-message';
  message.textContent = `Provider recording · ${pages.length} page${pages.length === 1 ? '' : 's'}`;
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
  });
  stream.addEventListener('investigation', () => void selectRun(id));
  stream.onerror = () => { $('error').textContent = 'Live stream disconnected; reconnecting automatically.'; };
  stream.onopen = () => { $('error').textContent = ''; };
}
$('form').addEventListener('submit', () => {
  eventRows.clear(); for (const state of replays.values()) state.hls?.destroy(); replays.clear();
}, { capture: true });
$('form').addEventListener('submit', async e => {
  e.preventDefault();
  $('error').textContent = '';
  $('start').disabled = true;
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
  $('workers').min = c.maxWorkers;
  $('workers').max = c.maxWorkers;
  $('workers').value = c.maxWorkers;
  $('workers').readOnly = true;
  if (c.missingCredentials.length) $('error').textContent = `Configure .env and restart: ${c.missingCredentials.join(', ')}`;
}).catch(e => { $('error').textContent = e.message; });
const previous = localStorage.getItem('lastRun');
if (previous) selectRun(previous).catch(() => localStorage.removeItem('lastRun'));
void loadRuns();
