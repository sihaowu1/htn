import { test } from 'node:test';
import assert from 'node:assert/strict';
import { executeNodeSequence } from '../src/execution/node-sequence.js';
import { Harness, MemoryAdapter } from '../src/sdk/index.js';
import type { Model } from '../src/model.js';
import type { FlowMap, Snapshot } from '../src/types.js';

const snapshot = (id: string): Snapshot => ({ url: `https://test.example/${id === 'root' ? '' : id}`, title: id, text: id,
  dom: `<body>${id}</body>`, elements: [], fingerprint: id, unsupported: [] });

async function fixture(agentId = 'worker-1') {
  const adapter = new MemoryAdapter();
  const harness = new Harness(adapter);
  const run = await harness.start_run({ goal: 'node test' });
  const agent = await harness.register_agent_execution(run, { agent_id: agentId });
  return { adapter, harness, agent };
}

function completedInstructions(adapter: MemoryAdapter) {
  return [...adapter.events.values()]
    .filter(e => e.event_type === 'worker.node.completed')
    .map(e => (e.metadata as any).instruction);
}

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
  const { adapter, harness, agent } = await fixture();
  let state = 'root'; let opens = 0; let disposals = 0;
  const instructions: string[] = []; const modelInstructions: string[] = [];
  const model: Model = { call: async (_harness, _agent, name, schema, _system, input: any) => {
    assert.equal(name, 'accept_node_instruction');
    modelInstructions.push(input.instruction);
    return schema.parse({ decision: 'execute', reason: 'Instruction matches assigned transition' });
  } };
  try {
    const result = await executeNodeSequence({ name: 'TV path', transitionIds: ['category-link', 'product-link'],
      instructions: 'Buy a television', stopCondition: 'Product reached' }, map, 'Buy a television',
    async startUrl => { opens++; assert.equal(startUrl, map.startUrl); return { page: {} as any, dispose: async () => { disposals++; } }; },
    model, harness, agent, new AbortController().signal, instruction => { if (instruction) instructions.push(instruction); }, 10, {
      inspect: async () => snapshot(state),
      perform: async (_page, action) => { state = action.selector === '#televisions' ? 'category' : 'product'; },
    });
    assert.equal(result.status, 'succeeded');
    assert.equal(opens, 1); assert.equal(disposals, 1);
    assert.deepEqual(instructions, ['Click Televisions', 'Click TV One']);
    assert.deepEqual(modelInstructions, instructions);
    assert.deepEqual(completedInstructions(adapter), instructions);
  } finally { await adapter.close(); }
});

test('a completed path whose final state is not checkout is incomplete for a checkout goal', async () => {
  const map: FlowMap = { version: 1, startUrl: 'https://test.example/', rootId: 'root', status: 'complete', notes: [],
    states: [
      { id: 'root', depth: 0, task: 'Start', snapshot: snapshot('root') },
      { id: 'product', depth: 1, task: 'Click Add to Cart', snapshot: snapshot('product') },
    ], transitions: [
      { id: 'add', from: 'root', to: 'product', status: 'observed', reason: '', actions: [{ kind: 'click', selector: '#add', value: '' }] },
    ] };
  const { adapter, harness, agent } = await fixture();
  let state = 'root';
  const model: Model = { call: async (_harness, _agent, _name, schema) => schema.parse({ decision: 'execute', reason: 'ok' }) };
  try {
    const result = await executeNodeSequence({ name: 'Cart path', transitionIds: ['add'], instructions: 'Add to cart', stopCondition: 'Added' },
      map, 'Add a TV and proceed to checkout', async () => ({ page: {} as any, dispose: async () => {} }), model, harness, agent,
      new AbortController().signal, () => {}, 10, { inspect: async () => snapshot(state), perform: async () => { state = 'product'; } });
    assert.equal(result.status, 'incomplete');
    assert.ok([...adapter.events.values()].some(event => event.event_type === 'worker.incomplete'));
  } finally { await adapter.close(); }
});
