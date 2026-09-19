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
import { EventLog, Trace } from '../src/telemetry.js';
import { validateMap } from '../src/flow.js';
import type { Model } from '../src/model.js';
import type { FlowMap } from '../src/types.js';

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
  const log = new EventLog(join(dir, 'events.jsonl'), false); await log.init();
  const trace = new Trace(log, { runId: 'test', agentId: 'worker', role: 'worker', sessionId: 'local-test' });
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
    for (const action of actions) await perform(lease.page, action, trace, signal);
    const results = await inspect(lease.page); assert.match(results.text, /Found apple/);
    const checkout = results.elements.find(e => e.label === 'Checkout')!;
    await perform(lease.page, { kind: 'click', selector: checkout.selector, value: '' }, trace, signal);
    const checkoutSnapshot = await inspect(lease.page);
    await lease.dispose();
    const map: FlowMap = { version: 1, startUrl: url, rootId: 'root', status: 'provided', notes: [], states: [
      { id: 'root', snapshot: root, depth: 0 }, { id: 'results', snapshot: results, depth: 1 }, { id: 'checkout', snapshot: checkoutSnapshot, depth: 2 },
    ], transitions: [
      { id: 'search', from: 'root', to: 'results', actions, status: 'observed', reason: '' },
      { id: 'checkout', from: 'results', to: 'checkout', actions: [{ kind: 'click', selector: checkout.selector, value: '' }], status: 'observed', reason: '' },
    ] };
    validateMap(JSON.parse(JSON.stringify(map)));
    const model: Model = { call: async (_trace, _name, schema, _instruction, input: any) => schema.parse(input.snapshot.text.includes('Found apple') ?
      { decision: 'success', reason: 'Results visible', evidence: 'Found apple' } : { decision: 'execute', reason: 'Search needed', evidence: '' }) };
    const task = { name: 'Search', instructions: 'Search apple', transitionIds: ['search'], stopCondition: 'Found apple visible' };
    const startSeq = (await log.read()).length;
    const result = await executeTask(task, map, 'Test search only', factory, model, trace, signal);
    assert.equal(result.status, 'succeeded');
    const workerEvents = (await log.read()).slice(startSeq);
    assert.equal(workerEvents.filter(e => e.type === 'action.attempt').length, 2);
    assert.ok(!workerEvents.filter(e => e.type === 'action.result').some(e => JSON.stringify(e.data).includes('view=checkout"')));
    const provided = validateMap(JSON.parse(await readFile(new URL('../examples/flow-map.json', import.meta.url), 'utf8')));
    provided.startUrl = url;
    assert.equal((await executeTask({ ...task, transitionIds: ['search-apple'] }, provided, 'Search', factory, model, trace, signal)).status, 'succeeded');
    const hallucinating: Model = { call: async (_t, _n, schema) => schema.parse({ decision: 'success', reason: 'Claim', evidence: 'Never visible evidence' }) };
    await assert.rejects(executeTask(task, map, 'Search', factory, hallucinating, trace, signal), /evidence was not found/);
    const wrong = structuredClone(map); wrong.states[0].snapshot.fingerprint = 'mismatch';
    assert.equal((await executeTask(task, wrong, 'Search', factory, model, trace, signal)).status, 'blocked');
    await assert.rejects(executeTask(task, map, 'Search', factory, model, trace, signal, 1), /action limit/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(executeTask(task, map, 'Search', factory, model, trace, controller.signal));
    const crawlerModel: Model = { call: async (_t, _n, schema, _instruction, input: any) =>
      schema.parse({ selections: input.choices.map((choice: { id: string; task: string }) => ({ choiceId: choice.id, task: choice.task, value: '' })), reason: 'Test all links' }) };
    const discovered = await crawl(url, 'Find help', crawlerModel, trace, signal, () => {}, { states: 5, depth: 2 });
    assert.equal(discovered.status, 'limited');
    assert.ok(discovered.transitions.some(t => t.status === 'observed'));
    assert.ok(discovered.transitions.some(t => t.status === 'unexplored'));
    assert.ok(discovered.states.some(s => s.snapshot.url.includes('view=help')));
    validateMap(discovered);
  } finally { await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); }
});
