import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { inspect, pageLiveViewUrl, perform } from '../src/browser.js';
import { crawl } from '../src/crawler.js';
import { executeTask } from '../src/worker.js';
import { Harness, MemoryAdapter } from '../src/sdk/index.js';
import { validateMap } from '../src/flow.js';
import type { Model } from '../src/model.js';
import type { FlowMap } from '../src/types.js';
import { serveLocalWebsite } from '../src/crawler/local-site.js';
import { fixtureLoginActions } from '../src/fixture-credentials.js';

test('real mock login preserves the cart, returns to checkout, and rejects account creation', { skip: process.env.RUN_BROWSER_TESTS !== '1' }, async () => {
  const site = await serveLocalWebsite();
  const browser = await chromium.launch();
  const dir = await mkdtemp(join(tmpdir(), 'fixture-login-'));
  const log = new EventLog(join(dir, 'events.jsonl'), false); await log.init();
  const trace = new Trace(log, { runId: 'login', agentId: 'worker', role: 'worker' });
  try {
    for (let worker = 0; worker < 3; worker++) {
      const context = await browser.newContext(); const page = await context.newPage();
      await page.goto(site.origin);
      await page.evaluate(() => localStorage.setItem('bb_mock_cart', JSON.stringify({ p1: 2, p17: 1, p13: 1 })));
      await page.goto(site.origin + '/auth.html?returnTo=checkout.html');
      const initial = await inspect(page);
      const create = initial.elements.find(element => element.type === 'submit' && element.label === 'Create account')!;
      await assert.rejects(perform(page, { kind: 'click', selector: create.selector, value: '' }, trace, new AbortController().signal), /Account creation is prohibited/);
      const password = initial.elements.find(element => element.type === 'password')!;
      await assert.rejects(perform(page, { kind: 'press', selector: password.selector, value: 'Enter' }, trace, new AbortController().signal), /Account creation is prohibited/);
      for (let step = 0; step < 2; step++) {
        const actions = fixtureLoginActions(await inspect(page))!;
        assert.ok(actions);
        for (const action of actions) await perform(page, action, trace, new AbortController().signal);
      }
      assert.equal(new URL(page.url()).pathname, '/checkout.html');
      const state = await page.evaluate(() => ({ user: JSON.parse(localStorage.getItem('bb_mock_user')!), cart: JSON.parse(localStorage.getItem('bb_mock_cart')!) }));
      assert.equal(state.user.email, 'johnsmith@example.com');
      assert.deepEqual(state.cart, { p1: 2, p17: 1, p13: 1 });
      await context.close();
    }
    assert.equal(JSON.stringify(await log.read('login')).includes('123456'), false);
  } finally { await browser.close(); await site.close(); await rm(dir, { recursive: true, force: true }); }
});

test('live view selects the navigated page instead of the default blank tab', () => {
  const pages = [
    { url: 'about:blank', debuggerFullscreenUrl: 'https://debug.example/blank' },
    { url: 'https://target.example/', debuggerFullscreenUrl: 'https://debug.example/target' },
  ];
  assert.equal(pageLiveViewUrl(pages, 'https://target.example/'), 'https://debug.example/target');
  assert.equal(pageLiveViewUrl(pages, 'https://missing.example/'), '');
});

test('real Chromium: discovery, replay, search-only stopping, divergence, limits and cancellation', { skip: process.env.RUN_BROWSER_TESTS !== '1', timeout: 180_000 }, async () => {
  const html = await readFile(new URL('fixtures/site.html', import.meta.url));
  const server = createServer((_req, res) => { res.setHeader('Content-Type', 'text/html'); res.end(html); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/`;
  const browser = await chromium.launch({ headless: true });
  const dir = await mkdtemp(join(tmpdir(), 'agent-browser-'));
  const adapter = new MemoryAdapter();
  const harness = new Harness(adapter);
  const run = await harness.start_run({ goal: 'browser test' });
  const agent = await harness.register_agent_execution(run, { agent_id: 'worker' });
  const factory = async (start: string) => {
    const context = await browser.newContext(); const page = await context.newPage(); await page.goto(start);
    return { page, dispose: () => context.close() };
  };
  const signal = new AbortController().signal;
  try {
    const lease = await factory(url);
    const root = await inspect(lease.page);
    const field = root.elements.find(e => e.tag === 'input')!;
    const button = root.elements.find(e => e.tag === 'button')!;
    const actions = [{ kind: 'fill' as const, selector: field.selector, value: 'apple' }, { kind: 'click' as const, selector: button.selector, value: '' }];
    for (const action of actions) await perform(lease.page, action, harness, agent, signal);
    const results = await inspect(lease.page); assert.match(results.text, /Found apple/);
    const checkout = results.elements.find(e => e.label === 'Checkout')!;
    await perform(lease.page, { kind: 'click', selector: checkout.selector, value: '' }, harness, agent, signal);
    const checkoutSnapshot = await inspect(lease.page);
    await lease.dispose();
    const map: FlowMap = { version: 1, startUrl: url, rootId: 'root', status: 'provided', notes: [], states: [
      { id: 'root', snapshot: root, depth: 0 }, { id: 'results', snapshot: results, depth: 1 }, { id: 'checkout', snapshot: checkoutSnapshot, depth: 2 },
    ], transitions: [
      { id: 'search', from: 'root', to: 'results', actions, status: 'observed', reason: '' },
      { id: 'checkout', from: 'results', to: 'checkout', actions: [{ kind: 'click', selector: checkout.selector, value: '' }], status: 'observed', reason: '' },
    ] };
    validateMap(JSON.parse(JSON.stringify(map)));
    const model: Model = { call: async (_harness, _agent, _name, schema, _instruction, input: any) => schema.parse(input.snapshot.text.includes('Found apple') ?
      { decision: 'success', reason: 'Results visible', evidence: 'Found apple' } : { decision: 'execute', reason: 'Search needed', evidence: '' }) };
    const task = { name: 'Search', instructions: 'Search apple', transitionIds: ['search'], stopCondition: 'Found apple visible' };
    const startSeq = (await adapter.readEvents()).length;
    const result = await executeTask(task, map, 'Test search only', factory, model, harness, agent, signal);
    assert.equal(result.status, 'succeeded');
    const workerEvents = (await adapter.readEvents()).slice(startSeq);
    assert.equal(workerEvents.filter(e => e.type === 'action.attempt').length, 2);
    assert.ok(!workerEvents.filter(e => e.type === 'action.result').some(e => JSON.stringify(e.data).includes('view=checkout"')));
    const provided = validateMap(JSON.parse(await readFile(new URL('../examples/flow-map.json', import.meta.url), 'utf8')));
    provided.startUrl = url;
    assert.equal((await executeTask({ ...task, transitionIds: ['search-apple'] }, provided, 'Search', factory, model, harness, agent, signal)).status, 'succeeded');
    const hallucinating: Model = { call: async (_h, _a, _n, schema) => schema.parse({ decision: 'success', reason: 'Claim', evidence: 'Never visible evidence' }) };
    await assert.rejects(executeTask(task, map, 'Search', factory, hallucinating, harness, agent, signal), /evidence was not found/);
    const wrong = structuredClone(map); wrong.states[0].snapshot.fingerprint = 'mismatch';
    assert.equal((await executeTask(task, wrong, 'Search', factory, model, harness, agent, signal)).status, 'blocked');
    await assert.rejects(executeTask(task, map, 'Search', factory, model, harness, agent, signal, 1), /action limit/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(executeTask(task, map, 'Search', factory, model, harness, agent, controller.signal));
    const crawlerModel: Model = { call: async (_h, _a, _n, schema, _instruction, input: any) =>
      schema.parse({ goalSatisfied: false, selections: input.choices.map((choice: { id: string; task: string }) => ({ choiceId: choice.id, task: choice.task, value: '' })), reason: 'Test all links' }) };
    const discovered = await crawl(url, 'Find cameras', crawlerModel, harness, agent, signal, () => {}, { states: 3, depth: 2 }, 'tests/fixtures/crawler-goal');
    assert.equal(discovered.status, 'limited');
    assert.ok(discovered.transitions.some(t => t.status === 'observed'));
    assert.ok(discovered.transitions.some(t => t.status === 'unexplored'));
    assert.ok(discovered.states.some(s => s.snapshot.url.includes('results.html')));
    validateMap(discovered);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});
