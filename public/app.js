const $ = id => document.getElementById(id);
$('nav').addEventListener('click', event => {
  const button = event.target.closest('button[data-view]');
  if (!button) return;
  for (const b of $('nav').querySelectorAll('button')) {
    b.classList.toggle('active', b === button);
    if (b === button) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  for (const view of document.querySelectorAll('.view')) view.classList.toggle('active', view.id === `view-${button.dataset.view}`);
  const headings = {
    browsers: ['Observation room', 'A front-row seat to every path, click, and discovery.'],
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
    card.firstChild.textContent = `${info.role} / ${info.agentId} / ${info.sessionId} / ${info.status}${info.instruction ? ` / ${info.instruction}` : ''}`;
  }
}
$('form').addEventListener('submit', async event => {
  event.preventDefault(); $('error').textContent = ''; $('start').disabled = true;
  try {
    const file = $('mapFile').files[0];
    const data = { targetUrl: $('url').value, prompt: $('prompt').value, maxWorkers: Number($('workers').value), testSingleAction: $('singleAction').checked,
      ...(file ? { flowMap: JSON.parse(await file.text()) } : {}) };
    const run = await request('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
    stream?.close(); seen.clear(); eventRows.clear(); cards.clear(); $('sessions').replaceChildren(); $('events').textContent = '';
    $('download').hidden = true; $('tree').textContent = 'Waiting for discovery';
    localStorage.setItem('lastRun', run.id); render(run); connect(run.id);
  } catch (error) { $('error').textContent = error.message; $('start').disabled = false; }
});
function connect(id) {
  stream = new EventSource(`/api/runs/${id}/events`);
  stream.addEventListener('run', event => render(JSON.parse(event.data)));
  stream.addEventListener('log', event => {
    const row = JSON.parse(event.data); if (seen.has(row.seq)) return; seen.add(row.seq);
    eventRows.set(row.seq, row);
    $('events').textContent = [...eventRows.values()].sort((a, b) => a.seq - b.seq).slice(-500).map(e => JSON.stringify(e)).join('\n');
    $('events').scrollTop = $('events').scrollHeight;
  });
  stream.onerror = () => { $('error').textContent = 'Event stream disconnected; reconnecting automatically.'; };
  stream.onopen = () => { $('error').textContent = ''; };
}
$('stop').onclick = async () => {
  try { await request(`/api/runs/${current}/cancel`, { method: 'POST' }); }
  catch (error) { $('error').textContent = error.message; }
};
request('/api/config').then(config => {
  $('workers').max = config.maxWorkers; $('workers').value = Math.min(2, config.maxWorkers);
  if (config.missingCredentials.length) $('error').textContent = `Configure .env and restart: ${config.missingCredentials.join(', ')}`;
}).catch(error => { $('error').textContent = error.message; });
const previous = localStorage.getItem('lastRun');
if (previous) request(`/api/runs/${previous}`).then(run => { render(run); connect(run.id); }).catch(() => localStorage.removeItem('lastRun'));
