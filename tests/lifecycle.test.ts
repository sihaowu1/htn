import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserSession } from '../src/browser.js';
import { Harness, MemoryAdapter } from '../src/sdk/index.js';

test('session release is idempotent and failures retain session correlation', async () => {
  const adapter = new MemoryAdapter();
  const harness = new Harness(adapter);
  const run = await harness.start_run({ goal: 'lifecycle test' });
  const agent = await harness.register_agent_execution(run, { agent_id: 'worker' });
  agent.setSessionId('s');
  try {
    let releases = 0, closes = 0;
    const publications: Array<{ liveUrl: string; status: string }> = [];
    const session = new BrowserSession({ sessions: { update: async () => { releases++; } } } as any,
      { close: async () => { closes++; } } as any,
      { sessionId: 's', agentId: 'a', role: 'worker', liveUrl: 'https://debug.example/page', status: 'running' }, harness, agent,
      info => publications.push({ liveUrl: info.liveUrl, status: info.status }));
    await Promise.all([session.close(), session.close(), session.close()]);
    assert.equal(releases, 1); assert.equal(closes, 1); assert.equal(session.info.status, 'closed');
    assert.equal(publications[0].liveUrl, '');
    assert.equal(publications.at(-1)?.status, 'closed');
    const failing = new BrowserSession({ sessions: { update: async () => { throw new Error('Offline'); } } } as any,
      { close: async () => { closes++; } } as any, { sessionId: 's', agentId: 'a', role: 'worker', liveUrl: '', status: 'running' }, harness, agent);
    await failing.close();
    assert.equal(closes, 2); assert.equal(failing.info.status, 'release failed');
    const failure = [...adapter.events.values()].find(e => e.event_type === 'session.release.failed');
    assert.equal(failure?.session_id, 's');
  } finally { await adapter.close(); }
});
