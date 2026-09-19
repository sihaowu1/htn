import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeNodeSequence } from '../src/execution/node-sequence.js';
import { executeExploratoryBranch } from '../src/execution/exploratory.js';
import { EventLog, Trace } from '../src/telemetry.js';
import type { Model } from '../src/model.js';
import type { FlowMap, Snapshot } from '../src/types.js';

const snapshot = (id: string): Snapshot => ({ url: `https://test.example/${id === 'root' ? '' : id}`, title: id, text: id,
  dom: `<body>${id}</body>`, elements: [], fingerprint: id, unsupported: [] });

test('exploratory workers follow a distinct cached branch and validate live actions and completion', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'exploratory-worker-'));
  const log = new EventLog(join(dir, 'events.jsonl'), false); await log.init();
  const trace = new Trace(log, { runId: 'run', agentId: 'worker', role: 'worker' });
  const task = { name: 'Alternative', transitionIds: [], instructions: 'Find results', stopCondition: 'Results visible' };
  const branch = { id: 'alternate', from: 'root', to: null, status: 'unexplored' as const, reason: '',
    actions: [{ kind: 'click' as const, selector: '#alternate', value: '' }] };
  let at = 'root'; const actions: string[] = [];
  const helpers = { inspect: async () => ({ ...snapshot(at), elements: [
    { selector: at === 'root' ? '#alternate' : '#next', tag: 'a', type: '', label: 'Next', value: '', options: [] },
  ] }), perform: async (_page: any, action: any) => { actions.push(action.selector); at = at === 'root' ? 'alternative' : 'results'; } };
  const model: Model = { call: async (_t, name, schema, _i, input: any) => {
    assert.equal(name, 'advance_exploratory_goal');
    assert.equal(input.observedHistory[0].action.selector, '#alternate');
    return schema.parse(at === 'results' ? { decision: 'success', action: null, reason: 'Results found', evidence: 'results' }
      : { decision: 'act', action: { kind: 'click', selector: '#next', value: '' }, reason: 'Go to results', evidence: '' });
  } };
  try {
    const result = await executeExploratoryBranch(task, branch, 'Find results', {} as any, model, trace, new AbortController().signal, 5, helpers, () => {});
    assert.equal(result.status, 'succeeded'); assert.deepEqual(actions, ['#alternate', '#next']);
    at = 'root'; actions.length = 0;
    const invalid: Model = { call: async (_t, _n, schema) => schema.parse({ decision: 'act', action: { kind: 'click', selector: '#invented', value: '' }, reason: 'Bad action', evidence: '' }) };
    await assert.rejects(executeExploratoryBranch(task, branch, 'Find results', {} as any, invalid, trace, new AbortController().signal, 5, helpers, () => {}), /not present/);
    assert.deepEqual(actions, ['#alternate']);
    at = 'root'; actions.length = 0;
    const limited = await executeExploratoryBranch(task, branch, 'Find results', {} as any, model, trace, new AbortController().signal, 1, helpers, () => {});
    assert.equal(limited.status, 'incomplete'); assert.deepEqual(actions, ['#alternate']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('partial workers execute the entire frontier and never report success from a checkout URL', async () => {
  const goal = 'Enter payment';
  const map: FlowMap = { version: 1, startUrl: 'https://test.example/', rootId: 'root', status: 'limited', notes: [],
    states: [
      { id: 'root', depth: 0, snapshot: snapshot('root') },
      { id: 'checkout', depth: 1, snapshot: snapshot('checkout'),
        goalAssessment: { goal, satisfied: false, progress: 0.5, reason: 'Payment input unavailable' } },
    ], transitions: [{ id: 'next', from: 'root', to: 'checkout', status: 'observed', reason: '',
      actions: [{ kind: 'click', selector: '#checkout', value: '' }] }] };
  const dir = await mkdtemp(join(tmpdir(), 'partial-worker-'));
  const log = new EventLog(join(dir, 'events.jsonl'), false); await log.init();
  const trace = new Trace(log, { runId: 'run', agentId: 'worker', role: 'worker' });
  let state = 'root'; let disposed = false;
  const model: Model = { call: async (_t, name, schema) => {
    assert.equal(name, 'accept_node_instruction');
    return schema.parse({ decision: 'execute', reason: 'Available' });
  } };
  try {
    const result = await executeNodeSequence({ name: 'Partial', transitionIds: ['next'], instructions: goal,
      stopCondition: 'Furthest available', completion: 'partial', limitation: 'Payment input unavailable' }, map, goal,
      async () => ({ page: {} as any, dispose: async () => { disposed = true; } }), model, trace, new AbortController().signal,
      () => {}, 10, { inspect: async () => snapshot(state), perform: async () => { state = 'checkout'; } });
    assert.equal(state, 'checkout'); assert.equal(disposed, true);
    assert.equal(result.status, 'incomplete');
    assert.match(result.reason, /Payment input unavailable/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('worker rejects a completion claim without actual final evidence', async () => {
  const map: FlowMap = { version: 1, startUrl: 'https://test.example/', rootId: 'root', status: 'provided', notes: [],
    states: [{ id: 'root', depth: 0, snapshot: snapshot('root') }], transitions: [] };
  const dir = await mkdtemp(join(tmpdir(), 'worker-evidence-'));
  const log = new EventLog(join(dir, 'events.jsonl'), false); await log.init();
  const trace = new Trace(log, { runId: 'run', agentId: 'worker', role: 'worker' });
  const model: Model = { call: async (_t, _n, schema) => schema.parse({ satisfied: true, evidence: 'Payment entered', reason: 'Claim' }) };
  try {
    const result = await executeNodeSequence({ name: 'Claim', transitionIds: [], instructions: 'Enter payment', stopCondition: 'Payment entered' },
      map, 'Enter payment', async () => ({ page: {} as any, dispose: async () => {} }), model, trace, new AbortController().signal,
      () => {}, 10, { inspect: async () => snapshot('root'), perform: async () => { throw new Error('No actions assigned'); } });
    assert.equal(result.status, 'incomplete');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('selected-path worker receives and completes node instructions one at a time in one front-page session', async () => {
  const map: FlowMap = { version: 1, startUrl: 'https://test.example/', rootId: 'root', status: 'complete', notes: [],
    states: [
      { id: 'root', depth: 0, task: 'Start', snapshot: snapshot('root') },
      { id: 'category', depth: 1, task: 'Click Televisions', snapshot: snapshot('category') },
      { id: 'product', depth: 2, task: 'Click TV One', snapshot: snapshot('product') },
    ], transitions: [
      { id: 'category-link', from: 'root', to: 'category', status: 'observed', reason: '', actions: [{ kind: 'click', selector: '#televisions', value: '' }] },
      { id: 'product-link', from: 'category', to: 'product', status: 'observed', reason: '', actions: [{ kind: 'click', selector: '#tv-one', value: '' }] },
    ] };
  const dir = await mkdtemp(join(tmpdir(), 'node-worker-'));
  const log = new EventLog(join(dir, 'events.jsonl'), false); await log.init();
  const trace = new Trace(log, { runId: 'run', agentId: 'worker-1', role: 'worker', sessionId: 'session' });
  let state = 'root'; let opens = 0; let disposals = 0;
  const instructions: string[] = []; const modelInstructions: string[] = [];
  const model: Model = { call: async (_trace, name, schema, _system, input: any) => {
    if (name === 'verify_path_goal') return schema.parse({ satisfied: true, evidence: 'product', reason: 'Requested product reached' });
    assert.equal(name, 'accept_node_instruction');
    modelInstructions.push(input.instruction);
    return schema.parse({ decision: 'blocked', reason: 'The navigation link is available and safe to execute' });
  } };
  try {
    const result = await executeNodeSequence({ name: 'TV path', transitionIds: ['category-link', 'product-link'],
      instructions: 'View a television', stopCondition: 'Product reached' }, map, 'View a television',
    async startUrl => { opens++; assert.equal(startUrl, map.startUrl); return { page: {} as any, dispose: async () => { disposals++; } }; },
    model, trace, new AbortController().signal, instruction => { if (instruction) instructions.push(instruction); }, 10, {
      inspect: async () => snapshot(state),
      perform: async (_page, action) => { state = action.selector === '#televisions' ? 'category' : 'product'; },
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(opens, 1); assert.equal(disposals, 1);
    assert.deepEqual(instructions, ['Click Televisions', 'Click TV One']);
    assert.deepEqual(modelInstructions, instructions);
    const events = await log.read('run');
    assert.equal(events.filter(event => event.type === 'worker.node.review_disagreed').length, 2);
    assert.deepEqual(events.filter(event => event.type === 'worker.node.completed').map(event => (event.data as any).instruction), instructions);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a completed path whose final state is not checkout is incomplete for a checkout goal', async () => {
  const map: FlowMap = { version: 1, startUrl: 'https://test.example/', rootId: 'root', status: 'complete', notes: [],
    states: [
      { id: 'root', depth: 0, task: 'Start', snapshot: snapshot('root') },
      { id: 'product', depth: 1, task: 'Click Add to Cart', snapshot: snapshot('product') },
    ], transitions: [
      { id: 'add', from: 'root', to: 'product', status: 'observed', reason: '', actions: [{ kind: 'click', selector: '#add', value: '' }] },
    ] };
  const dir = await mkdtemp(join(tmpdir(), 'node-worker-'));
  const log = new EventLog(join(dir, 'events.jsonl'), false); await log.init();
  const trace = new Trace(log, { runId: 'run', agentId: 'worker-1', role: 'worker', sessionId: 'session' });
  let state = 'root';
  const model: Model = { call: async (_trace, name, schema) => schema.parse(name === 'verify_path_goal'
    ? { satisfied: false, evidence: '', reason: 'Checkout has not been reached' }
    : { decision: 'execute', reason: 'ok' }) };
  try {
    const result = await executeNodeSequence({ name: 'Cart path', transitionIds: ['add'], instructions: 'Add to cart', stopCondition: 'Added' },
      map, 'Add a TV and proceed to checkout', async () => ({ page: {} as any, dispose: async () => {} }), model, trace,
      new AbortController().signal, () => {}, 10, { inspect: async () => snapshot(state), perform: async () => { state = 'product'; } });
    assert.equal(result.status, 'incomplete');
    assert.ok((await log.read('run')).some(event => event.type === 'worker.incomplete'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
