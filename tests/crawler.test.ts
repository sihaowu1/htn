import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crawl } from '../src/crawler.js';
import { planRelevantTree, validateMap } from '../src/flow.js';
import { EventLog, Trace } from '../src/telemetry.js';
import type { Model } from '../src/model.js';

test('HTTP crawler selects goal-relevant links without a browser and deduplicates URLs', async () => {
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    if (req.method === 'POST' && req.url === '/login') { res.end('<h1>Welcome John Smith</h1>'); return; }
    if (req.url === '/?q=television') { res.end('<h1>Search results for television</h1><a href="/tv/one">TV One</a>'); return; }
    if (req.url === '/tv') { res.end('<h1>Televisions</h1><a href="/tv/one">TV One</a>'); return; }
    if (req.url === '/tv/one') { res.end('<h1>TV One</h1><a href="/tv">Back to TVs</a>'); return; }
    res.end('<nav><a href="/tv">TV category</a></nav><a href="/tv">TV advertisement</a><a href="/help">Help</a>' +
      '<form><input name="q" type="search"><button type="submit">Search</button></form>' +
      '<form method="post" action="/login"><input name="email" type="email"><input name="password" type="password"><button>Login</button></form>');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  const dir = await mkdtemp(join(tmpdir(), 'http-crawler-'));
  const log = new EventLog(join(dir, 'events.jsonl'), false); await log.init();
  const trace = new Trace(log, { runId: 'crawl', agentId: 'crawler', role: 'crawler' });
  const calls: unknown[] = [];
  const model: Model = { call: async (_trace, name, schema, _instruction, input: any, _signal, options) => {
    calls.push({ name, input, options });
    const matches = input.choices.filter((choice: { url: string; kind: string }) => choice.url.includes('/tv') || choice.kind === 'search' || choice.kind === 'login');
    return schema.parse({ selections: matches.map((choice: { id: string; kind: string; task: string }) => ({
      choiceId: choice.id, task: choice.task, value: choice.kind === 'search' ? 'television' : '',
    })), reason: 'TV links and forms match the test' });
  } };
  try {
    const map = await crawl(`http://127.0.0.1:${address.port}/`, 'Buy a television', model, trace,
      new AbortController().signal, () => {}, { states: 10, depth: 4 });
    validateMap(map);
    assert.equal(map.states.filter(state => state.snapshot.url.endsWith('/tv')).length, 1);
    assert.ok(map.states.some(state => state.snapshot.url.endsWith('/tv/one')));
    assert.ok(!map.states.some(state => state.snapshot.url.endsWith('/help')));
    assert.ok(map.states.some(state => state.task === 'Search television'));
    assert.ok(map.states.some(state => state.task === 'Log in as JohnSmith@mail.com'));
    const login = map.transitions.find(transition => transition.actions.some(action => action.value === '[fixture-login-password]'))!;
    assert.deepEqual(login.actions.map(action => action.kind), ['fill', 'fill', 'press']);
    assert.ok(!JSON.stringify(map).includes('123456'));
    assert.ok((calls[0] as any).options.reasoningEffort === 'low');
    const plan = planRelevantTree(map, 'Buy a television');
    assert.ok(plan.paths.length >= 1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
