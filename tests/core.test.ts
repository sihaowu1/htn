import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog, redact } from '../src/telemetry.js';
import { validateMap, validatePlan, taskTransitions, flowTree, pool, matchesState } from '../src/flow.js';
import { verifyReport } from '../src/observer.js';
import { validateSingleAction } from '../src/worker.js';
import type { FlowMap, Plan, Snapshot } from '../src/types.js';

const snapshot: Snapshot = { url: 'https://test.example/', title: 'Shop', text: '', dom: '', elements: [], fingerprint: 'root', unsupported: [] };
export const map: FlowMap = { version: 1, startUrl: snapshot.url, rootId: 'root', status: 'provided', notes: [],
  states: ['root', 'results', 'checkout', 'help'].map((id, depth) => ({ id, snapshot: { ...snapshot, fingerprint: id }, depth })),
  transitions: [
    { id: 'search', from: 'root', to: 'results' }, { id: 'checkout', from: 'results', to: 'checkout' },
    { id: 'help', from: 'root', to: 'help' }, { id: 'back', from: 'help', to: 'root' },
  ].map(t => ({ ...t, status: 'observed', actions: [{ kind: 'click', selector: 'button', value: '' }], reason: '' })),
};
const plan = (): Plan => ({ summary: 'Search only', paths: [{ name: 'search', transitionIds: ['search'], instructions: 'Search', stopCondition: 'Results are visible' }], skipped: [] });
test('map round-trip and invalid references', () => {
  assert.deepEqual(validateMap(JSON.parse(JSON.stringify(map))), map);
  assert.throws(() => validateMap({ ...map, rootId: 'missing' }));
  assert.throws(() => validateMap(map, 'https://elsewhere.example/'));
  const invalid = structuredClone(map); invalid.transitions[0].to = 'missing';
  assert.throws(() => validateMap(invalid));
});
test('single-action mode accepts only targets and controls observed on the initial page', () => {
  const initial = { ...snapshot, elements: [
    { selector: '#search', tag: 'input', type: 'search', label: 'Search', value: '', options: [] },
    { selector: '#submit', tag: 'button', type: 'submit', label: 'Search', value: '', options: [] },
  ] };
  assert.deepEqual(validateSingleAction(initial, { kind: 'fill', selector: '#search', value: 'laptop' }),
    { kind: 'fill', selector: '#search', value: 'laptop' });
  assert.throws(() => validateSingleAction(initial, { kind: 'click', selector: '#missing', value: '' }), /not present/);
  assert.throws(() => validateSingleAction(initial, { kind: 'fill', selector: '#submit', value: 'laptop' }), /requires an input/);
});
test('manual JSON fallback accepts expected text and path, but rejects a different state', async () => {
  const example = validateMap(JSON.parse(await readFile(new URL('../examples/flow-map.json', import.meta.url), 'utf8')));
  const expected = example.states[0].snapshot;
  assert.equal(matchesState(expected, { ...snapshot, text: 'Test shop\nSearch\nHelp' }), true);
  assert.equal(matchesState(expected, { ...snapshot, text: 'Checkout' }), false);
  assert.equal(matchesState(expected, { ...snapshot, text: 'Test shop', url: 'https://test.example/checkout' }), false);
});
test('search plan excludes checkout and rejects disconnected, duplicate, looping paths', () => {
  const result = validatePlan(map, plan());
  assert.deepEqual(taskTransitions(map, result.paths[0]).map(t => t.id), ['search']);
  assert.ok(result.skipped.some(t => t.transitionId === 'checkout'));
  assert.throws(() => validatePlan(map, { ...plan(), paths: [{ ...plan().paths[0], transitionIds: ['checkout'] }] }));
  assert.throws(() => validatePlan(map, { ...plan(), paths: [plan().paths[0], plan().paths[0]] }));
  assert.throws(() => taskTransitions(map, { ...plan().paths[0], transitionIds: ['help', 'back'] }));
  assert.match(JSON.stringify(flowTree(map)), /"reference":true/);
});
test('pool respects concurrency and stops dequeuing after cancellation', async () => {
  let active = 0, highest = 0; const visited: number[] = [];
  await pool([1, 2, 3, 4, 5], 2, new AbortController().signal, async item => {
    active++; highest = Math.max(active, highest); visited.push(item);
    await new Promise(resolve => setTimeout(resolve, 10)); active--;
  });
  assert.equal(highest, 2); assert.equal(new Set(visited).size, 5);
  const controller = new AbortController(); const after: number[] = [];
  await pool([1, 2, 3], 1, controller.signal, async item => { after.push(item); controller.abort(); });
  assert.deepEqual(after, [1]);
});
test('global log serializes concurrent events, persists IDs across restart, and survives telemetry errors', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-log-'));
  const file = join(dir, 'events.jsonl');
  try {
    const log = new EventLog(file, false); await log.init();
    await Promise.all(Array.from({ length: 40 }, (_, i) => log.write({ runId: 'r', agentId: `a${i % 2}`, role: 'worker', sessionId: `s${i % 2}` }, 'action', { i })));
    const events = await log.read('r');
    assert.deepEqual(events.map(e => e.seq), Array.from({ length: 40 }, (_, i) => i + 1));
    assert.equal(events[0].sessionId, 's0');
    const restarted = new EventLog(file, () => { throw new Error('Transport failed'); }); await restarted.init();
    const next = await restarted.write({ runId: 'r2', agentId: 'observer', role: 'observer' }, 'report');
    assert.equal(next.seq, 41);
    assert.equal((await restarted.read('r2')).length, 1);
    assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 41);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('redaction and observer evidence validation', () => {
  assert.deepEqual(redact({ password: 'secret', token: 'secret', message: 'ok' }), { password: '[redacted]', token: '[redacted]', message: 'ok' });
  const finding = { severity: 'error' as const, description: 'Failed', suspectedCause: '', eventIds: [5] };
  const report = verifyReport({ summary: 'Failed', findings: [finding, { ...finding, eventIds: [99] }] }, [
    { seq: 5, time: '', runId: 'r', agentId: 'a', sessionId: 's', role: 'worker', type: 'worker.failed', data: {} },
  ]);
  assert.equal(report.findings.length, 1);
});
