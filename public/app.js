import { eventKey, eventOffsetSeconds, eventsForSession, isPlaybackEvent,
  nearestEventIndex } from './replay-utils.js';

const $ = id => document.getElementById(id);
let current, stream, graph = { nodes: [], edges: [] }, selectedEvent, eventOffset = 0;
const eventPageSize = 50, seen = new Set(), cards = new Map();
const eventRows = new Map(), replays = new Map();
async function request(url, options) { const response = await fetch(url, options); const data = await response.json(); if (!response.ok) throw new Error(data.error || response.statusText); return data; }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>'"]/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;' })[c]); }
function fmtDuration(ms) { if (ms == null) return 'running'; const s = Math.max(0, Math.round(Number(ms) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s/60)}m ${s%60}s`; }
function isFailure(type, data = {}) { return /(^|\.)(failed|failure|error|timeout|deadline|budget_exceeded)$/.test(type) || ['failed','failure','timed_out'].includes(String(data.status || data.outcome || '').toLowerCase()); }
const headings = { runs:['Run intelligence','Find a run, understand its outcome, and follow the evidence.'], overview:['Run overview','A consistent summary of agents, signals, coverage, and decisions.'], investigate:['Failure investigation','Follow the causal path from assumptions to effects.'], events:['Evidence explorer','Search and inspect the immutable event record.'], browsers:['Observation room','A front-row seat to every browser path and action.'] };
function showView(name) { for (const b of $('nav').querySelectorAll('button')) { const active = b.dataset.view === name; b.classList.toggle('active', active); active ? b.setAttribute('aria-current','page') : b.removeAttribute('aria-current'); } for (const view of document.querySelectorAll('.view')) view.classList.toggle('active', view.id === `view-${name}`); $('view-name').textContent = name[0].toUpperCase()+name.slice(1); $('page-title').replaceChildren(document.createTextNode(headings[name][0]), Object.assign(document.createElement('span'), {textContent:'.'})); $('page-description').textContent = headings[name][1]; }
$('nav').addEventListener('click', event => { const button = event.target.closest('button[data-view]'); if (button) showView(button.dataset.view); });

async function loadRuns() { const params = new URLSearchParams({limit:'100'}); if ($('run-search').value) params.set('search',$('run-search').value); if ($('run-status').value) params.set('status',$('run-status').value); if ($('failure-category').value) params.set('failureCategory',$('failure-category').value); try { const [data,metrics] = await Promise.all([request(`/api/runs?${params}`),request('/api/dashboard/metrics')]); renderGlobalMetrics(data.items,metrics); renderRunList(data.items); } catch (error) { $('error').textContent = error.message; } }
function renderGlobalMetrics(runs,daily) { const successful=runs.filter(r=>r.status==='succeeded').length, failures=runs.reduce((s,r)=>s+Number(r.failure_count||0),0), backlog=runs.reduce((s,r)=>s+Number(r.investigation_backlog||0),0), recovery=runs.filter(r=>r.investigation_outcome==='RECOVERED_FAILURE').length; $('global-metrics').innerHTML=[["Runs",runs.length,'in current result'],['Success rate',runs.length?`${Math.round(successful/runs.length*100)}%`:'—',`${successful} succeeded`],['Failure clusters',failures,`${recovery} recovered`],['Investigation backlog',backlog,'queued or running']].map(([l,v,n])=>`<article class="metric"><span>${l}</span><strong>${v}</strong><small>${n}</small></article>`).join(''); const grouped=new Map(); for(const row of daily){const day=String(row.day).slice(0,10), entry=grouped.get(day)||{total:0,failed:0}; entry.total+=Number(row.runs); if(String(row.status).includes('fail'))entry.failed+=Number(row.runs); grouped.set(day,entry);} const max=Math.max(1,...[...grouped.values()].map(v=>v.total)); $('outcome-chart').innerHTML=[...grouped.entries()].slice(-14).map(([day,v])=>`<div class="bar-column" title="${day}: ${v.total} runs, ${v.failed} failed"><div class="bar failure" style="height:${v.failed/max*100}%"></div><div class="bar success" style="height:${(v.total-v.failed)/max*100}%"></div><span>${day.slice(5)}</span></div>`).join('')||'<p class="empty-copy">No historical metrics yet.</p>'; }
function renderRunList(runs) { $('run-list').innerHTML=runs.map(run=>`<button class="run-row ${String(run.status).includes('fail')?'has-failure':''}" data-run="${run.run_id}"><span class="run-health"></span><span class="run-main"><strong>${escapeHtml(run.goal)}</strong><small>${run.run_id} · ${escapeHtml(run.workflow_type||'workflow')}</small></span><span><small>Status</small><strong>${escapeHtml(run.status)}</strong></span><span><small>Duration</small><strong>${fmtDuration(run.duration_ms)}</strong></span><span><small>Agents / events</small><strong>${run.agent_count||0} / ${run.event_count||0}</strong></span><span><small>Failures</small><strong>${run.failure_count||0}</strong></span><span><small>Cause</small><strong>${escapeHtml(run.failure_category||'—')}</strong></span></button>`).join('')||'<p class="empty-copy">No runs match these filters.</p>'; }
$('run-list').addEventListener('click',e=>{const row=e.target.closest('[data-run]');if(row)void selectRun(row.dataset.run);});
async function selectRun(id) { current=id; localStorage.setItem('lastRun',id); $('error').textContent=''; try { const [summary,runGraph]=await Promise.all([request(`/api/runs/${id}/summary`),request(`/api/runs/${id}/graph`)]); graph=runGraph; renderSummary(summary); renderInvestigations(summary.investigations||[]); renderTimeline(); renderGraph(); await loadEvents(true); $('status').textContent=String(summary.status).replaceAll('_',' '); document.body.dataset.phase=summary.status; $('export-events').hidden=false; $('export-events').href=`/api/runs/${id}/events/export`; showView(Number(summary.metrics?.failures||0)>0?'investigate':'overview'); if(['starting','discovering','planning','running','observing'].includes(summary.status))connect(id); } catch(error){$('error').textContent=error.message;} }
function renderSummary(s) { const m=s.metrics||{}; $('run-summary').innerHTML=`<div class="run-title"><div><span class="eyebrow">${escapeHtml(s.workflow_type)}</span><h2>${escapeHtml(s.goal)}</h2><code>${s.run_id}</code></div><span class="outcome ${String(s.status).includes('fail')?'bad':''}">${escapeHtml(s.status)}</span></div><div class="metric-grid compact">${[['Duration',fmtDuration(s.completed_at?new Date(s.completed_at)-new Date(s.created_at):null)],['Agents',s.agents.length],['Events',m.events||0],['Failures',m.failures||0],['Model calls',m.model_calls||0],['Tool calls',m.tool_calls||0],['Retries',m.retries||0],['p95 latency',m.latency_p95_ms?`${Math.round(m.latency_p95_ms)}ms`:'—']].map(([k,v])=>`<div class="metric"><span>${k}</span><strong>${v}</strong></div>`).join('')}</div><div class="stage-strip">${['discovery','planning','execution','observation','completion'].map(stage=>`<span class="${graph.nodes.some(n=>n.type==='workflow.stage.completed'&&n.metadata?.stage===stage)?'done':''}">${stage}</span>`).join('')}</div>`; $('agent-cards').innerHTML=s.agents.map(a=>`<article class="agent-card"><span>${escapeHtml(a.agent_id)}</span><strong>${escapeHtml(a.assigned_task||'coordination')}</strong><dl><dt>Outcome</dt><dd>${escapeHtml(a.outcome||'—')}</dd><dt>Events</dt><dd>${a.event_count}</dd><dt>Retries</dt><dd>${a.retry_count}</dd><dt>Last signal</dt><dd>${escapeHtml(a.last_event||'—')}</dd></dl></article>`).join(''); const decisions=graph.nodes.filter(n=>n.type==='decision.recorded'||n.type==='decision.revised'); $('decisions').innerHTML=decisions.map(n=>`<button data-event="${n.id}" class="decision"><span>${escapeHtml(n.agent_id)}</span><strong>${escapeHtml(n.metadata.decision)}</strong><small>${(n.metadata.assumptions||[]).length?escapeHtml(n.metadata.assumptions.join(' · ')):'Unsupported: no assumptions or evidence recorded'}</small></button>`).join('')||'<p class="empty-copy">No explicit decision summaries were recorded for this run.</p>'; }
function renderInvestigations(items) { const reports=items.filter(i=>i.report).map(i=>i.report); $('investigation-summary').innerHTML=reports.map(r=>`<article class="failure-report"><header><div><span class="outcome bad">${escapeHtml(r.outcome)}</span><h2>${escapeHtml(r.title||r.summary||r.observed_failure||'Observer finding')}</h2></div><span class="confidence">${escapeHtml(r.likely_cause?.confidence||'—')} confidence</span></header><h3>Observed facts</h3><ol>${r.observed_facts.map(f=>`<li>${escapeHtml(f.statement)} ${f.event_ids.map(id=>`<button class="citation" data-event="${id}">${id.slice(0,8)}</button>`).join(' ')}</li>`).join('')}</ol>${r.likely_cause?`<h3>Likely cause · ${escapeHtml(r.likely_cause.category)}</h3><p>${escapeHtml(r.likely_cause.explanation)}</p>`:''}<h3>Evidence gaps and alternatives</h3><ul>${r.evidence_gaps_and_alternatives.map(g=>`<li>${escapeHtml(g)}</li>`).join('')||'<li>None recorded.</li>'}</ul>${r.reproduction_step?`<h3>Reproduction step</h3><p>${escapeHtml(r.reproduction_step)}</p>`:''}<details><summary>Raw report JSON</summary><pre>${escapeHtml(JSON.stringify(r,null,2))}</pre></details></article>`).join('')||'<p class="empty-copy">No completed investigation report yet. Failure clusters remain visible in the timeline.</p>'; }
function groupedNodes(){const map=new Map();for(const n of graph.nodes)map.set(n.agent_id,[...(map.get(n.agent_id)||[]),n]);return map;}
function renderTimeline(){ $('timeline').innerHTML=[...groupedNodes().entries()].map(([agent,nodes])=>`<div class="lane"><strong>${escapeHtml(agent)}</strong><div class="lane-events">${nodes.map(n=>`<button data-event="${n.id}" class="event-mark ${isFailure(n.type,n.metadata)?'failure':''} ${selectedEvent===n.id?'selected':''}" title="${escapeHtml(n.type)}"><span>${new Date(n.occurred_at).toLocaleTimeString()}</span>${escapeHtml(n.type)}</button>`).join('')}</div></div>`).join('')||'<p class="empty-copy">No events recorded.</p>'; }
function renderGraph(){const svg=$('causal-graph'),width=Math.max(520,svg.clientWidth||720),lanes=[...new Set(graph.nodes.map(n=>n.agent_id))],height=Math.max(280,lanes.length*90+50);svg.setAttribute('viewBox',`0 0 ${width} ${height}`);const byId=new Map(),min=Math.min(...graph.nodes.map(n=>new Date(n.occurred_at).getTime()),Date.now()),max=Math.max(...graph.nodes.map(n=>new Date(n.occurred_at).getTime()),min+1),nodes=graph.nodes.map(n=>({...n,x:125+(new Date(n.occurred_at).getTime()-min)/(max-min)*(width-155),y:45+lanes.indexOf(n.agent_id)*90}));nodes.forEach(n=>byId.set(n.id,n));const edges=graph.edges.map(e=>{const a=byId.get(e.source),b=byId.get(e.target);return a&&b?`<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" class="graph-edge ${e.inferred?'inferred':''}"/>`:''}).join('');svg.innerHTML=`${lanes.map((name,i)=>`<text x="8" y="${49+i*90}" class="graph-label">${escapeHtml(name)}</text><line x1="120" y1="${45+i*90}" x2="${width-15}" y2="${45+i*90}" class="lane-line"/>`).join('')}${edges}${nodes.map(n=>`<g data-event="${n.id}" class="graph-node ${isFailure(n.type,n.metadata)?'failure':''} ${selectedEvent===n.id?'selected':''}" transform="translate(${n.x},${n.y})" role="button"><circle r="7"></circle><title>${escapeHtml(n.type)}</title></g>`).join('')}`;}
async function loadEvents(reset=false){if(!current)return;if(reset)eventOffset=0;const p=new URLSearchParams({limit:String(eventPageSize),offset:String(eventOffset)});if($('event-search').value)p.set('search',$('event-search').value);if($('event-type').value)p.set('type',$('event-type').value);if($('event-agent').value)p.set('agent',$('event-agent').value);const data=await request(`/api/runs/${current}/events?${p}`);$('events').innerHTML=data.items.map(e=>`<tr data-event="${e.event_id}" class="${selectedEvent===e.event_id?'selected':''}"><td>${new Date(e.occurred_at).toLocaleTimeString()}</td><td>${escapeHtml(e.agent_id)}</td><td><span class="event-kind ${isFailure(e.event_type,e.metadata)?'failure':''}">${escapeHtml(e.event_type)}</span></td><td>${e.sequence_number}</td></tr>`).join('');$('events-page').textContent=`${data.total?eventOffset+1:0}–${Math.min(eventOffset+eventPageSize,data.total)} of ${data.total}`;$('events-prev').disabled=eventOffset===0;$('events-next').disabled=eventOffset+eventPageSize>=data.total;}
function selectEvent(id){selectedEvent=id;renderTimeline();renderGraph();const n=graph.nodes.find(x=>x.id===id);if(!n)return;const antecedents=graph.edges.filter(e=>e.source===id),dependents=graph.edges.filter(e=>e.target===id);$('evidence-content').innerHTML=`<span class="eyebrow">EVENT EVIDENCE</span><h2>${escapeHtml(n.type)}</h2><dl class="evidence-fields"><dt>Event ID</dt><dd><code>${id}</code></dd><dt>Agent</dt><dd>${escapeHtml(n.agent_id)}</dd><dt>Execution</dt><dd><code>${n.agent_execution_id}</code></dd><dt>Session</dt><dd>${escapeHtml(n.session_id||'—')}</dd><dt>Sequence</dt><dd>${n.sequence_number}</dd><dt>Occurred</dt><dd>${escapeHtml(n.occurred_at)}</dd><dt>Ingested</dt><dd>${escapeHtml(n.ingested_at||'—')}</dd><dt>Trace / span</dt><dd>${escapeHtml(n.trace_id||'—')} / ${escapeHtml(n.span_id||'—')}</dd><dt>Schema</dt><dd>${n.schema_version||1}</dd><dt>Causal links</dt><dd>${antecedents.length} antecedent · ${dependents.length} dependent</dd></dl><h3>Metadata</h3><pre>${escapeHtml(JSON.stringify(n.metadata,null,2))}</pre><button id="investigate-event" type="button">Investigate this event</button>`;$('evidence-drawer').hidden=false;$('investigate-event').onclick=async()=>{try{await request(`/api/runs/${current}/investigations`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({eventId:id,signal:'USER_REQUESTED'})});$('investigate-event').textContent='Investigation queued';$('investigate-event').disabled=true;}catch(error){$('error').textContent=error.message;}};}
document.addEventListener('click',e=>{const target=e.target.closest('[data-event]');if(target&&!target.closest('#run-list'))selectEvent(target.dataset.event);});$('close-drawer').onclick=()=>{$('evidence-drawer').hidden=true;};
function debounce(fn,ms){let timer;return(...args)=>{clearTimeout(timer);timer=setTimeout(()=>fn(...args),ms);};}$('refresh-runs').onclick=loadRuns;$('run-search').addEventListener('input',debounce(loadRuns,250));$('run-status').onchange=loadRuns;$('failure-category').onchange=loadRuns;$('event-filter').onclick=()=>loadEvents(true);$('events-prev').onclick=()=>{eventOffset=Math.max(0,eventOffset-eventPageSize);void loadEvents();};$('events-next').onclick=()=>{eventOffset+=eventPageSize;void loadEvents();};
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
        sequence_number: row.seq, metadata: row.data }); renderTimeline(); renderGraph();
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
$('form').addEventListener('submit',async e=>{e.preventDefault();$('error').textContent='';$('start').disabled=true;try{const file=$('mapFile').files[0],data={targetUrl:$('url').value,prompt:$('prompt').value,maxWorkers:Number($('workers').value),testSingleAction:$('singleAction').checked,...(file?{flowMap:JSON.parse(await file.text())}:{})},run=await request('/api/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});seen.clear();cards.clear();graph={nodes:[],edges:[]};$('sessions').replaceChildren();localStorage.setItem('lastRun',run.id);renderLive(run);connect(run.id);showView('browsers');}catch(error){$('error').textContent=error.message;$('start').disabled=false;}});$('stop').onclick=async()=>{try{await request(`/api/runs/${current}/cancel`,{method:'POST'});}catch(error){$('error').textContent=error.message;}};
request('/api/config').then(c=>{$('workers').max=c.maxWorkers;$('workers').value=Math.min(2,c.maxWorkers);if(c.missingCredentials.length)$('error').textContent=`Configure .env and restart: ${c.missingCredentials.join(', ')}`;}).catch(e=>{$('error').textContent=e.message;});void loadRuns();
