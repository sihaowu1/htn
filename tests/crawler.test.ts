import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crawl } from '../src/crawler.js';
import { planRelevantTree, validateMap } from '../src/flow.js';
import { EventLog, Trace } from '../src/telemetry.js';
import type { Model } from '../src/model.js';

test('rendered local crawler maps URLs to the worker origin and discovers goal-relevant interactions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rendered-crawler-'));
  const log = new EventLog(join(dir, 'events.jsonl'), false); await log.init();
  const trace = new Trace(log, { runId: 'crawl', agentId: 'crawler', role: 'crawler' });
  const calls: unknown[] = [];
  const model: Model = { call: async (_trace, name, schema, _instruction, input: any, _signal, options) => {
    calls.push({ name, input, options });
    const composite = input.choices.find((choice: { description: string }) => /then Add to Cart/i.test(choice.description));
    const search = input.choices.find((choice: { description: string }) => /Search using/i.test(choice.description));
    const product = input.choices.find((choice: { description: string }) => /Vantage.*TV/i.test(choice.description));
    const matches = composite ? [composite] : [product, search].filter(Boolean);
    return schema.parse({ selections: matches.map((choice: { id: string; acceptsValue: boolean; task: string; description: string }) => ({
      choiceId: choice.id, task: choice.task, value: choice.acceptsValue ? (/numeric|then Add/i.test(choice.description) ? '3' : 'television') : '',
    })), reason: 'TV, search, and cart interactions match the goal' });
  } };
  try {
    const map = await crawl('https://worker.example/store/', 'View 3 televisions in the cart', model, trace,
      new AbortController().signal, () => {}, { states: 8, depth: 3 });
    validateMap(map);
    assert.ok(map.states.length > 1);
    assert.ok(map.states.every(state => state.snapshot.url.startsWith('https://worker.example/store/')));
    assert.ok(map.states.every(state => !state.snapshot.url.includes('127.0.0.1')));
    assert.ok(map.states.some(state => state.task === 'Search television'));
    assert.ok(map.states.some(state => state.task?.includes('to 3 and click Add to Cart')));
    const satisfied = map.states.find(state => /Added to cart/i.test(state.snapshot.text) && /Cart\s*3\b/i.test(state.snapshot.text));
    assert.ok(satisfied, 'crawler should retain the goal-satisfied cart state');
    assert.equal(map.transitions.some(transition => transition.from === satisfied.id), false,
      'goal-satisfied states must be terminal and not expand repeated navigation/cart controls');
    assert.equal((calls[0] as any).options.reasoningEffort, 'low');
    assert.ok(planRelevantTree(map, 'View 3 televisions in the cart').paths.length >= 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('crawler caps children at 5, passes explored behaviors, and records dropped choices as unexplored', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rendered-crawler-cap-'));
  const log = new EventLog(join(dir, 'events.jsonl'), false); await log.init();
  const trace = new Trace(log, { runId: 'crawl', agentId: 'crawler', role: 'crawler' });
  const seen: any[] = [];
  const model: Model = { call: async (_trace, _name, schema, _instruction, input: any) => {
    seen.push(input);
    const [skipped, ...rest] = input.choices;
    return schema.parse({ selections: rest.map((choice: { id: string; task: string }) => ({ choiceId: choice.id, task: choice.task, value: '' })),
      skipped: [{ choiceId: skipped.id, reason: 'repeat of an explored behavior' }], reason: 'all' });
  } };
  try {
    const map = await crawl('https://worker.example/store/', 'Browse', model, trace, new AbortController().signal, () => {}, { states: 3, depth: 1 });
    const children = (id: string) => map.transitions.filter(transition => transition.from === id);
    assert.ok(children('s0').filter(transition => transition.status !== 'unexplored').length <= 5);
    assert.ok(children('s0').some(transition => transition.status === 'unexplored' && /repeat/.test(transition.reason)));
    assert.ok(children('s0').some(transition => transition.status === 'unexplored' && /5-child limit/.test(transition.reason)));
    assert.deepEqual(seen[0].alreadyExplored, []);
    validateMap(map);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
