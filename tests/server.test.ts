import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

test('HTTP server serves bare frontend and validates runs without leaking credentials', { timeout: 60_000 }, async () => {
  const probe = createServer(); await new Promise<void>(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port; await new Promise<void>(resolve => probe.close(() => resolve()));
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server.ts'], {
    env: { ...process.env, PORT: String(port), OPENAI_API_KEY: '', BROWSERBASE_API_KEY: '', BROWSERBASE_PROJECT_ID: '', SENTRY_DSN: '' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const origin = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let i = 0; i < 400; i++) {
      if (child.exitCode !== null) throw new Error(output);
      try { if ((await fetch(origin + '/api/config')).ok) { ready = true; break; } } catch {}
      await delay(100);
    }
    assert.ok(ready, output);
    const landing = await (await fetch(origin)).text();
    assert.match(landing, /Watchtower/);
    assert.match(landing, /Get started/);
    assert.match(landing, /href="\/dashboard.html"/);
    const dashboard = await (await fetch(origin + '/dashboard.html')).text();
    assert.match(dashboard, /Maximum simultaneous workers/);
    assert.match(dashboard, /Control Room/);
    assert.match(dashboard, /TASK ASSIGNMENT/);
    assert.ok(dashboard.indexOf('id="form"') < dashboard.indexOf('id="view-browsers"'));
    const configuration = await (await fetch(origin + '/api/config')).json();
    assert.deepEqual(configuration.missingCredentials.sort(), ['BROWSERBASE_API_KEY', 'BROWSERBASE_PROJECT_ID', 'OPENAI_API_KEY', 'SENTRY_DSN']);
    const post = (body: unknown) => fetch(origin + '/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post({ prompt: '', maxWorkers: 1, targetUrl: 'https://example.com' })).status, 400);
    assert.equal((await post({ prompt: 'Search', maxWorkers: 1, targetUrl: 'http://localhost:8080' })).status, 400);
    assert.equal((await post({ prompt: 'Search', maxWorkers: 1, targetUrl: 'https://example.com' })).status, 503);
    assert.equal((await fetch(origin + '/api/runs/unknown')).status, 404);
  } finally {
    child.kill();
    await new Promise<void>(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', () => resolve()); });
  }
});
