import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('early partial and exploratory branches beat duplicate successful form-filling routes', async () => {
  const goal = 'Find TV';
  const root = snapshot('https://test.example/', 'Choose TV');
  root.elements = ['direct', 'category', 'alternate'].map(id => ({ selector: `#${id}`, tag: 'a', type: '', label: `${id} TV`, value: '', options: [] }));
  const form = snapshot('https://test.example/form', 'Form');
  form.elements = ['a', 'b'].map(id => ({ selector: `#${id}`, tag: 'input', type: 'text', label: id, value: '', options: [] }));
  const map: FlowMap = { version: 1, startUrl: root.url, rootId: 'root', status: 'limited', notes: [],
    states: [{ id: 'root', depth: 0, snapshot: root }, { id: 'form', depth: 1, snapshot: form },
      ...['a', 'b'].map(id => ({ id, depth: 2, snapshot: snapshot(`https://test.example/${id}`, id),
        goalAssessment: { goal, satisfied: true, progress: 1, reason: 'Goal' } })),
      { id: 'category', depth: 1, snapshot: snapshot('https://test.example/category', 'TV category') }],
    transitions: [
      { id: 'direct', from: 'root', to: 'form', status: 'observed', reason: '', actions: [{ kind: 'click', selector: '#direct', value: '' }] },
      ...['a', 'b'].map(id => ({ id, from: 'form', to: id, status: 'observed' as const, reason: '', actions: [{ kind: 'fill' as const, selector: `#${id}`, value: 'test' }] })),
      { id: 'category', from: 'root', to: 'category', status: 'observed', reason: '', actions: [{ kind: 'click', selector: '#category', value: '' }] },
      { id: 'alternate', from: 'root', to: null, status: 'unexplored', reason: 'Another TV route', actions: [{ kind: 'click', selector: '#alternate', value: '' }] },
    ] };
  const dir = await mkdtemp(join(tmpdir(), 'early-diversity-'));
  const { adapter, harness, agent } = await fixture();
  try {
    const { plan } = await orchestratePaths(map, goal, 'run', { call: async () => { throw new Error('No model needed'); } },
      harness, agent, new AbortController().signal, dir);
    assert.equal(plan.paths.length, 3);
    assert.equal(plan.paths.filter(path => path.completion === 'goal').length, 1);
    assert.ok(plan.paths.some(path => path.transitionIds[0] === 'category'));
    assert.ok(plan.paths.some(path => path.exploreFrom === 'alternate'));
    assert.equal(plan.paths.some(path => path.repeatOf), false);
  } finally { await adapter.close(); await rm(dir, { recursive: true, force: true }); }
});

test('goal-confirmed routes win; otherwise fallback prioritizes goal progress over detour length', async () => {
  const goal = 'Enter payment for the requested items';
  const map: FlowMap = { version: 1, startUrl: 'https://test.example/', rootId: 'root', status: 'limited', notes: ['Depth limit reached'],
    states: [
      { id: 'root', depth: 0, snapshot: snapshot('https://test.example/', 'Home') },
      { id: 'near', depth: 1, snapshot: snapshot('https://test.example/cart', 'Requested items in cart'),
        goalAssessment: { goal, satisfied: false, progress: 0.8, reason: 'Payment form unavailable' } },
      { id: 'detour', depth: 1, snapshot: snapshot('https://test.example/category', 'Category') },
      { id: 'far', depth: 2, snapshot: snapshot('https://test.example/checkout', 'Empty checkout'),
        goalAssessment: { goal, satisfied: false, progress: 0.2, reason: 'Missing requested items and payment' } },
    ], transitions: [
      { id: 'near', from: 'root', to: 'near', status: 'observed', reason: '', actions: [{ kind: 'click', selector: '#near', value: '' }] },
      { id: 'detour', from: 'root', to: 'detour', status: 'observed', reason: '', actions: [{ kind: 'click', selector: '#detour', value: '' }] },
      { id: 'far', from: 'detour', to: 'far', status: 'observed', reason: '', actions: [{ kind: 'click', selector: '#far', value: '' }] },
    ] };
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-frontier-'));
  const { adapter, harness, agent } = await fixture();
  const model: Model = { call: async () => { throw new Error('No diversity decision needed'); } };
  try {
    const partial = await orchestratePaths(map, goal, 'run', model, harness, agent, new AbortController().signal, dir);
    assert.deepEqual(partial.plan.paths.map(path => path.transitionIds), [['near'], ['detour', 'far'], ['near']]);
    assert.equal(partial.plan.paths[2].repeatOf, partial.plan.paths[0].name);
    assert.equal(partial.plan.paths[0].completion, 'partial');
    assert.match(partial.plan.paths[0].limitation!, /Payment form unavailable/);
    assert.match(partial.plan.summary, /No complete route was confirmed/);
    assert.equal(JSON.parse(await readFile(partial.file, 'utf8')).selectedPaths[0].completion, 'partial');
    map.states[3].goalAssessment = { goal, satisfied: true, progress: 1, reason: 'Full goal now observed' };
    const complete = await orchestratePaths(map, goal, 'run', model, harness, agent, new AbortController().signal, dir);
    assert.deepEqual(complete.plan.paths.map(path => path.transitionIds), [['detour', 'far'], ['near'], ['detour', 'far']]);
    assert.equal(complete.plan.paths[0].completion, 'goal');
  } finally { await adapter.close(); await rm(dir, { recursive: true, force: true }); }
});

test('a single available route still produces three explicitly isolated replay assignments', async () => {
  const map: FlowMap = { version: 1, startUrl: 'https://test.example/', rootId: 'root', status: 'limited', notes: [],
    states: [{ id: 'root', depth: 0, snapshot: snapshot('https://test.example/', 'Home') }], transitions: [] };
  const dir = await mkdtemp(join(tmpdir(), 'three-workers-'));
  const { adapter, harness, agent } = await fixture();
  try {
    const result = await orchestratePaths(map, 'Unavailable goal', 'run', { call: async () => { throw new Error('No model needed'); } },
      harness, agent, new AbortController().signal, dir);
    assert.equal(result.plan.paths.length, 3);
    assert.equal(new Set(result.plan.paths.map(path => path.name)).size, 3);
    assert.ok(result.plan.paths.slice(1).every(path => path.repeatOf === result.plan.paths[0].name));
  } finally { await adapter.close(); await rm(dir, { recursive: true, force: true }); }
});

test('orchestrator selects three diverse candidates and preserves the fixed demo paths', async () => {
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
    await writeFile(join(dir, 'paths_demo.json'), 'fixed demo snapshot');
    const result = await orchestratePaths(map, 'Test varied routes', 'run-test', model, harness, agent, new AbortController().signal, dir);
    assert.equal(result.plan.paths.length, config.maxPaths);
    assert.equal(options, undefined, 'diversity constraints do not rely on a model following a prompt');
    assert.equal(result.plan.skipped.length, count - config.maxPaths);
    const persisted = JSON.parse(await readFile(result.file, 'utf8'));
    assert.equal(persisted.selectedPaths.length, config.maxPaths);
    assert.equal(persisted.maxPaths, config.maxPaths);
    assert.equal(await readFile(join(dir, 'paths_demo.json'), 'utf8'), 'fixed demo snapshot');
    assert.deepEqual(persisted.selectedPaths.map((path: { agentId: string }) => path.agentId), ['worker-1', 'worker-2', 'worker-3']);
    assert.match(result.file.replaceAll('\\', '/'), /orchestrator\/run-test\/selected-paths\.json$/);
  } finally { await adapter.close(); await rm(dir, { recursive: true, force: true }); }
});

test('orchestrator preserves direct, category, and search diversity despite randomized ties', async () => {
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
  for (const state of map.states.filter(state => ['direct', 'category-product', 'search-product'].includes(state.id))) {
    state.goalAssessment = { goal: 'Add three televisions to cart', satisfied: true, progress: 1, reason: 'Fixture goal endpoint' };
  }
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-routes-'));
  const { adapter, harness, agent } = await fixture();
  const model: Model = { call: async () => { throw new Error('model should not be needed when all route classes are available'); } };
  try {
    const result = await orchestratePaths(map, 'Add three televisions to cart', 'run-routes', model, harness, agent,
      new AbortController().signal, dir);
    assert.equal(result.plan.paths.length, 3);
    const persisted = JSON.parse(await readFile(result.file, 'utf8'));
    assert.deepEqual(persisted.selectedPaths.map((path: { entryStrategy: string }) => path.entryStrategy).sort(),
      ['category', 'direct', 'search']);
    assert.deepEqual(persisted.selectedPaths.flatMap((path: { productIds: string[] }) => path.productIds).sort(),
      ['p1', 'p2', 'p3']);
  } finally { await adapter.close(); await rm(dir, { recursive: true, force: true }); }
});
