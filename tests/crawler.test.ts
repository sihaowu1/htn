import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crawl } from '../src/crawler.js';
import { fingerprint } from '../src/browser.js';
import { planRelevantTree, validateMap } from '../src/flow.js';
import { Harness, MemoryAdapter } from '../src/sdk/index.js';
import type { Model } from '../src/model.js';

async function fixture(agentId = 'crawler') {
  const adapter = new MemoryAdapter();
  const harness = new Harness(adapter);
  const run = await harness.start_run({ goal: 'crawler test' });
  const agent = await harness.register_agent_execution(run, { agent_id: agentId });
  return { adapter, harness, agent };
}

test('crawler cancellation stops branch decisions after a navigation', async () => {
  const { adapter, harness, agent } = await fixture();
  const controller = new AbortController();
  let calls = 0;
  const model: Model = { call: async (_harness, _agent, _name, schema, _instruction, input: any) => {
    calls++;
    return schema.parse({ goalSatisfied: false, selections: [{ choiceId: input.choices[0].id, task: 'Search', value: '' }], reason: 'Search' });
  } };
  try {
    await assert.rejects(crawl('https://worker.example/', 'Search cameras', model, harness, agent, controller.signal,
      () => controller.abort(), { states: 10, depth: 5 }, 'tests/fixtures/crawler-goal'), { name: 'AbortError' });
    assert.equal(calls, 1);
  } finally { await adapter.close(); }
});

test('crawler follows branches in one conversation, reuses forward navigation, and stops at search results', async () => {
  const { adapter, harness, agent } = await fixture();
  const seen: any[] = [];
  const sessions: unknown[] = [];
  const model: Model = { call: async (_harness, _agent, _name, schema, instruction, input: any, _signal, options) => {
    seen.push(input); sessions.push(options?.session);
    assert.ok(!instruction.includes('Always select choices that advance toward the cart'));
    const done = input.page.title === 'Camera search results';
    const relevant = input.choices.filter((choice: any) => /Search cameras|Camera category/.test(choice.description));
    // Deliberately return a checkout choice along with satisfaction: the crawler must still stop.
    return schema.parse({ goalSatisfied: done, selections: (done ? input.choices : relevant).map((choice: any) => ({
      choiceId: choice.id, task: choice.task, value: '',
    })), skipped: input.choices.filter((choice: any) => /Checkout/.test(choice.description)).map((choice: any) => ({
      choiceId: choice.id, reason: 'Unrelated to search',
    })), reason: done ? 'Visible camera search results' : 'Routes to camera results' });
  } };
  try {
    const map = await crawl('https://worker.example/', 'Find camera search results', model, harness, agent,
      new AbortController().signal, () => {}, { states: 10, depth: 5 }, 'tests/fixtures/crawler-goal');
    validateMap(map);
    assert.equal(seen.length, 3, 'each distinct state gets only one decision');
    assert.ok(sessions[0] && sessions.every(session => session === sessions[0]));
    assert.ok(seen[1].outcomes.some((outcome: any) => outcome.from === 's0' && outcome.status === 'observed'));
    const results = map.states.find(state => state.snapshot.title === 'Camera search results')!;
    assert.ok(results);
    assert.equal(map.transitions.filter(transition => transition.from === results.id).length, 0);
    assert.equal(map.states.some(state => /Checkout/.test(state.snapshot.title)), false);
    assert.equal(map.transitions.filter(transition => transition.to === results.id).length, 2, 'branches reference the shared result');
    const events = await adapter.readEvents();
    assert.equal(events.filter(event => event.type === 'discovery.replay').length, 1, 'only the sibling branch needs a replay');
    assert.ok(events.some(event => event.type === 'discovery.goal_satisfied'));
  } finally { await adapter.close(); }
});

test('rendered local crawler maps URLs to the worker origin and discovers goal-relevant interactions', async () => {
  const { adapter, harness, agent } = await fixture();
  const calls: unknown[] = [];
  const model: Model = { call: async (_harness, _agent, name, schema, _instruction, input: any, _signal, options) => {
    calls.push({ name, input, options });
    const composite = input.choices.find((choice: { description: string }) => /then Add to Cart/i.test(choice.description));
    const search = input.choices.find((choice: { description: string }) => /Search using/i.test(choice.description));
    const product = input.choices.find((choice: { description: string }) => /Vantage.*TV/i.test(choice.description));
    const matches = composite ? [composite] : [product, search].filter(Boolean);
    return schema.parse({ goalSatisfied: /Cart\s*3\b/i.test(input.page.text), selections: matches.map((choice: { id: string; acceptsValue: boolean; task: string; description: string }) => ({
      choiceId: choice.id, task: choice.task, value: choice.acceptsValue ? (/numeric|then Add/i.test(choice.description) ? '3' : 'television') : '',
    })), reason: 'TV, search, and cart interactions match the goal' });
  } };
  try {
    const map = await crawl('https://worker.example/store/', 'View 3 televisions in the cart', model, harness, agent,
      new AbortController().signal, () => {}, { states: 8, depth: 3 });
    validateMap(map);
    assert.ok(map.states.length > 1);
    assert.ok(map.states.every(state => state.snapshot.url.startsWith('https://worker.example/store/')));
    assert.ok(map.states.every(state => !state.snapshot.url.includes('127.0.0.1')));
    assert.ok(map.states.every(state => !state.snapshot.dom.includes('127.0.0.1') && !state.snapshot.dom.includes('127.0.0.1'.replace(/\./g, '%2E'))),
      'local origin embedded in the DOM must be rewritten so worker fingerprints can match');
    assert.ok(map.states.every(state => state.snapshot.fingerprint === fingerprint(state.snapshot)));
    assert.ok(map.states.some(state => state.task === 'Search television'));
    assert.ok(map.states.some(state => state.task?.includes('to 3 and click Add to Cart')));
    const satisfied = map.states.find(state => /Added to cart/i.test(state.snapshot.text) && /Cart\s*3\b/i.test(state.snapshot.text));
    assert.ok(satisfied, 'crawler should retain the goal-satisfied cart state');
    assert.equal(map.transitions.some(transition => transition.from === satisfied.id), false,
      'goal-satisfied states must be terminal and not expand repeated navigation/cart controls');
    assert.equal((calls[0] as any).options.reasoningEffort, 'low');
    assert.ok(calls.every(call => (call as any).options.session === (calls[0] as any).options.session));
    assert.ok(planRelevantTree(map, 'View 3 televisions in the cart').paths.length >= 1);
  } finally { await adapter.close(); }
});

test('crawler caps children at 5, passes outcomes, and records dropped choices as unexplored', async () => {
  const { adapter, harness, agent } = await fixture();
  const seen: any[] = [];
  const model: Model = { call: async (_harness, _agent, _name, schema, _instruction, input: any) => {
    seen.push(input);
    const [skipped, ...rest] = input.choices;
    return schema.parse({ goalSatisfied: false, selections: rest.map((choice: { id: string; task: string }) => ({ choiceId: choice.id, task: choice.task, value: '' })),
      skipped: skipped ? [{ choiceId: skipped.id, reason: 'repeat of an explored behavior' }] : [], reason: 'all' });
  } };
  try {
    const map = await crawl('https://worker.example/store/', 'Browse', model, harness, agent, new AbortController().signal, () => {}, { states: 3, depth: 1 });
    const children = (id: string) => map.transitions.filter(transition => transition.from === id);
    assert.ok(children('s0').filter(transition => transition.status !== 'unexplored').length <= 5);
    assert.ok(children('s0').some(transition => transition.status === 'unexplored' && /repeat/.test(transition.reason)));
    assert.ok(children('s0').some(transition => transition.status === 'unexplored' && /5-child limit/.test(transition.reason)));
    assert.deepEqual(seen[0].outcomes, []);
    validateMap(map);
  } finally { await adapter.close(); }
});
