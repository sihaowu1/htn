import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplayNotFoundError, ReplayProviderError, ReplayService, type ReplayClient } from '../src/replay.js';
import { eventKey, eventOffsetSeconds, eventsForSession, nearestEventIndex } from '../public/replay-utils.js';

function client(result: unknown): ReplayClient {
  return { sessions: { replays: { retrieve: async () => {
    if (result instanceof Error) throw result;
    return result as Awaited<ReturnType<ReplayClient['sessions']['replays']['retrieve']>>;
  } } } };
}

test('replay validates ownership before contacting Browserbase', async () => {
  let called = false;
  const sdk = { sessions: { replays: { retrieve: async () => { called = true; throw new Error('unexpected'); } } } } as ReplayClient;
  const service = new ReplayService(async () => false, sdk);
  await assert.rejects(() => service.get('run-1', 'session-1'), ReplayNotFoundError);
  assert.equal(called, false);
});

test('replay maps multiple Browserbase pages without exposing credentials', async () => {
  const service = new ReplayService(async () => true, client({ pageCount: 2, pages: [
    { pageId: 'page-1', startTimeMs: 1000, endTimeMs: 2000, url: 'https://replay.example/one.m3u8' },
    { pageId: 'page-2', startTimeMs: 2000, endTimeMs: 3000, url: 'https://replay.example/two.m3u8' },
  ] }));
  const result = await service.get('run-1', 'session-1');
  assert.deepEqual(result, { status: 'available', session_id: 'session-1', pages: [
    { page_id: 'page-1', start_time_ms: 1000, end_time_ms: 2000, playlist_url: 'https://replay.example/one.m3u8' },
    { page_id: 'page-2', start_time_ms: 2000, end_time_ms: 3000, playlist_url: 'https://replay.example/two.m3u8' },
  ] });
  assert.doesNotMatch(JSON.stringify(result), /api[_-]?key|BROWSERBASE/i);
});

test('replay distinguishes pending, missing, and provider failures', async () => {
  const pending = new ReplayService(async () => true, client({ pageCount: 0, pages: [] }));
  assert.deepEqual(await pending.get('run', 'session'), { status: 'pending', retry_after_ms: 2000 });
  const missingError = Object.assign(new Error('missing'), { status: 404 });
  await assert.rejects(() => new ReplayService(async () => true, client(missingError)).get('run', 'session'), ReplayNotFoundError);
  await assert.rejects(() => new ReplayService(async () => true, client(new Error('timeout'))).get('run', 'session'), ReplayProviderError);
});

test('event replay alignment uses execution-scoped fallback keys and page timestamps', () => {
  const base = { sessionId: 'session-1', time: '2026-01-01T00:00:01.000Z', type: 'action.attempt', data: {} };
  const a = { ...base, agentExecutionId: 'execution-a', seq: 1 };
  const b = { ...base, agentExecutionId: 'execution-b', seq: 1, time: '2026-01-01T00:00:02.000Z', type: 'browser.navigation' };
  const unrelated = { ...base, sessionId: 'session-2', agentExecutionId: 'execution-c', seq: 1 };
  assert.notEqual(eventKey(a), eventKey(b));
  assert.equal(eventKey({ ...a, eventId: 'event-id' }), 'event-id');
  assert.deepEqual(eventsForSession([b, unrelated, a], 'session-1'), [a, b]);
  const page = { start_time_ms: Date.parse('2026-01-01T00:00:00.000Z'), end_time_ms: Date.parse('2026-01-01T00:00:03.000Z') };
  assert.equal(eventOffsetSeconds(b, page), 2);
  assert.equal(nearestEventIndex([a, b], page, 1.8), 1);
});
