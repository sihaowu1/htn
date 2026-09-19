import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeNodeSequence } from '../src/execution/node-sequence.js';
import { EventLog, Trace } from '../src/telemetry.js';
import type { Model } from '../src/model.js';
import type { FlowMap, Snapshot } from '../src/types.js';

const snapshot = (id: string): Snapshot => ({ url: `https://test.example/${id === 'root' ? '' : id}`, title: id, text: id,
  dom: `<body>${id}</body>`, elements: [], fingerprint: id, unsupported: [] });

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
    assert.equal(name, 'accept_node_instruction');
    modelInstructions.push(input.instruction);
    return schema.parse({ decision: 'execute', reason: 'Instruction matches assigned transition' });
  } };
  try {
    const result = await executeNodeSequence({ name: 'TV path', transitionIds: ['category-link', 'product-link'],
      instructions: 'Buy a television', stopCondition: 'Product reached' }, map, 'Buy a television',
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
    assert.deepEqual(events.filter(event => event.type === 'worker.node.completed').map(event => (event.data as any).instruction), instructions);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
