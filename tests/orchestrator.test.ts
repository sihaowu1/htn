import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { orchestratePaths } from '../src/orchestrator/index.js';
import { Harness, MemoryAdapter } from '../src/sdk/index.js';
import type { Model } from '../src/model.js';
import type { FlowMap, Snapshot } from '../src/types.js';

const snapshot = (url: string, text: string): Snapshot => ({ url, title: text, text, dom: `<body>${text}</body>`, elements: [], fingerprint: text, unsupported: [] });

async function fixture(agentId = 'orchestrator') {
  const adapter = new MemoryAdapter();
  const harness = new Harness(adapter);
  const run = await harness.start_run({ goal: 'orchestrator test' });
  const agent = await harness.register_agent_execution(run, { agent_id: agentId });
  return { adapter, harness, agent };
}

test('orchestrator selects MAX_PATHS diverse candidates with a cheap low-reasoning model and persists them', async () => {
  const count = config.maxPaths + 2;
  const map: FlowMap = {
    version: 1, startUrl: 'https://test.example/', rootId: 'root', status: 'complete', notes: [],
    states: [{ id: 'root', depth: 0, task: 'Start', snapshot: snapshot('https://test.example/', 'Root') },
      ...Array.from({ length: count }, (_, index) => ({ id: `leaf-${index}`, depth: 1, task: `Task ${index}`,
        snapshot: snapshot(`https://test.example/${index}`, `Leaf ${index}`) }))],
    transitions: Array.from({ length: count }, (_, index) => ({ id: `t${index}`, from: 'root', to: `leaf-${index}`,
      actions: [{ kind: 'click' as const, selector: `#choice-${index}`, value: '' }], status: 'observed' as const, reason: '' })),
  };
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-'));
  const { adapter, harness, agent } = await fixture();
  let options: unknown;
  const model: Model = { call: async (_harness, _agent, name, schema, _instruction, input: any, _signal, callOptions) => {
    assert.equal(name, 'select_diverse_paths'); options = callOptions;
    const candidates = input.candidates as { id: string }[];
    const remaining = config.maxPaths - input.alreadySelected.length;
    const spread = Array.from({ length: remaining }, (_, index) =>
      candidates[Math.floor(index * (candidates.length - 1) / Math.max(remaining - 1, 1))].id);
    return schema.parse({ pathIds: spread, reason: 'Selected paths with different branches and terminal states.' });
  } };
  try {
    const result = await orchestratePaths(map, 'Test varied routes', 'run-test', model, harness, agent, new AbortController().signal, dir);
    assert.equal(result.plan.paths.length, config.maxPaths);
    assert.equal((options as any).model, config.orchestratorModel);
    assert.equal((options as any).reasoningEffort, 'low');
    assert.equal(result.plan.skipped.length, count - config.maxPaths);
    const persisted = JSON.parse(await readFile(result.file, 'utf8'));
    assert.equal(persisted.selectedPaths.length, config.maxPaths);
    assert.equal(persisted.maxPaths, config.maxPaths);
    assert.match(result.file.replaceAll('\\', '/'), /orchestrator\/run-test\/selected-paths\.json$/);
  } finally { await adapter.close(); await rm(dir, { recursive: true, force: true }); }
});

test('orchestrator deterministically selects direct, category, and search entry strategies', async () => {
  const states = [
    { id: 'root', depth: 0, task: 'Start', snapshot: snapshot('https://test.example/', 'Root') },
    { id: 'direct', depth: 1, task: 'Open Vantage television', snapshot: snapshot('https://test.example/product?id=p1', 'Vantage') },
    { id: 'category', depth: 1, task: 'Open the TVs category', snapshot: snapshot('https://test.example/tvs', 'TVs') },
    { id: 'category-product', depth: 2, task: 'Open Aperture television', snapshot: snapshot('https://test.example/product?id=p3', 'Aperture') },
    { id: 'search', depth: 1, task: 'Search for QLED TV', snapshot: snapshot('https://test.example/search', 'Search') },
    { id: 'search-product', depth: 2, task: 'Open Crestline television', snapshot: snapshot('https://test.example/product?id=p2', 'Crestline') },
  ];
  const map: FlowMap = {
    version: 1, startUrl: 'https://test.example/', rootId: 'root', status: 'complete', notes: [], states,
    transitions: [
      { id: 'direct', from: 'root', to: 'direct', actions: [{ kind: 'click', selector: '#p1', value: '' }], status: 'observed', reason: '' },
      { id: 'category', from: 'root', to: 'category', actions: [{ kind: 'click', selector: '#tvs', value: '' }], status: 'observed', reason: '' },
      { id: 'category-product', from: 'category', to: 'category-product', actions: [{ kind: 'click', selector: '#p3', value: '' }], status: 'observed', reason: '' },
      { id: 'search', from: 'root', to: 'search', actions: [{ kind: 'fill', selector: '#search', value: 'QLED TV' }], status: 'observed', reason: '' },
      { id: 'search-product', from: 'search', to: 'search-product', actions: [{ kind: 'click', selector: '#p2', value: '' }], status: 'observed', reason: '' },
    ],
  };
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-routes-'));
  const { adapter, harness, agent } = await fixture();
  const model: Model = { call: async () => { throw new Error('model should not be needed when all route classes are available'); } };
  try {
    const result = await orchestratePaths(map, 'Add three televisions to cart', 'run-routes', model, harness, agent,
      new AbortController().signal, dir);
    assert.equal(result.plan.paths.length, 3);
    const persisted = JSON.parse(await readFile(result.file, 'utf8'));
    assert.deepEqual(persisted.selectedPaths.map((path: { entryStrategy: string }) => path.entryStrategy),
      ['direct', 'category', 'search']);
    assert.deepEqual(persisted.selectedPaths.map((path: { productIds: string[] }) => path.productIds),
      [['p1'], ['p3'], ['p2']]);
  } finally { await adapter.close(); await rm(dir, { recursive: true, force: true }); }
});
