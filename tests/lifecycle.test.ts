import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession } from '../src/browser.js';
import { EventLog, Trace } from '../src/telemetry.js';
import { Observer } from '../src/observer.js';
import type { Model } from '../src/model.js';
import type { Report } from '../src/types.js';

test('session release is idempotent and failures retain session correlation', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-release-'));
  try {
    const log = new EventLog(join(dir, 'events.jsonl'), false); await log.init();
    const trace = new Trace(log, { runId: 'r', agentId: 'a', role: 'worker', sessionId: 's' });
    let releases = 0, closes = 0;
    const publications: Array<{ liveUrl: string; status: string }> = [];
    const session = new BrowserSession({ sessions: { update: async () => { releases++; } } } as any,
      { close: async () => { closes++; } } as any,
      { sessionId: 's', agentId: 'a', role: 'worker', liveUrl: 'https://debug.example/page', status: 'running' }, trace,
      info => publications.push({ liveUrl: info.liveUrl, status: info.status }));
    await Promise.all([session.close(), session.close(), session.close()]);
    assert.equal(releases, 1); assert.equal(closes, 1); assert.equal(session.info.status, 'closed');
    assert.equal(publications[0].liveUrl, '');
    assert.equal(publications.at(-1)?.status, 'closed');
    const failing = new BrowserSession({ sessions: { update: async () => { throw new Error('Offline'); } } } as any,
      { close: async () => { closes++; } } as any, { sessionId: 's', agentId: 'a', role: 'worker', liveUrl: '', status: 'running' }, trace);
    await failing.close();
    assert.equal(closes, 2); assert.equal(failing.info.status, 'release failed');
    const failure = (await log.read()).find(e => e.type === 'session.release.failed');
    assert.equal(failure?.sessionId, 's');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('observer tails only new non-observer events and cites actual worker/session IDs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-observer-'));
  try {
    const log = new EventLog(join(dir, 'events.jsonl'), false); await log.init();
    const identity = { runId: 'r', agentId: 'worker-1', role: 'worker' as const, sessionId: 'session-1' };
    const failure = await log.write(identity, 'worker.failed', { reason: 'Missing results' });
    await log.write({ ...identity, runId: 'other-run' }, 'worker.failed', { reason: 'Different run' });
    const inputs: any[] = [];
    const model: Model = { call: async (_trace, _name, schema, _instruction, input: any) => {
      inputs.push(input);
      return schema.parse({ summary: 'Worker failed', findings: input.events.length ? [{ severity: 'error', description: 'Missing results', suspectedCause: '', eventIds: [input.events[0].seq] }] : [] });
    } };
    const reports: Report[] = [];
    const observer = new Observer(model, new Trace(log, { runId: 'r', agentId: 'observer', role: 'observer' }), report => reports.push(report));
    await observer.tick(false);
    assert.deepEqual(inputs[0].events.map((e: any) => e.seq), [failure.seq]);
    assert.equal(reports[0].references?.[0].sessionId, 'session-1');
    await observer.tick(false); assert.equal(inputs.length, 1);
    const finish = await log.write(identity, 'worker.finished');
    await observer.stop();
    assert.deepEqual(inputs[1].events.map((e: any) => e.seq), [finish.seq]);
    assert.equal(inputs[1].final, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
