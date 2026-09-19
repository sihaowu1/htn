const $ = id => document.getElementById(id);
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
  $('status').textContent = `${run.id}: ${run.status}`;
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
      return { stateId: id, branches: run.map.transitions.filter(t => t.from === id).map(t => ({
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
      card.append(document.createElement('p'));
      cards.set(info.sessionId, card); $('sessions').append(card);
    }
    if (info.liveUrl) {
      let frame = card.querySelector('iframe');
      if (!frame) { frame = document.createElement('iframe'); frame.title = info.agentId; card.append(frame); }
      const url = new URL(info.liveUrl); url.searchParams.set('readOnly', 'true');
      if (frame.src !== url.href) frame.src = url.href;
    }
    card.firstChild.textContent = `${info.role} / ${info.agentId} / ${info.sessionId} / ${info.status}`;
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
