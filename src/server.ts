import './telemetry.js';
import express from 'express';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { config, missingCredentials } from './config.js';
import { validateMap, flowTree } from './flow.js';
import { EventLog, Sentry } from './telemetry.js';
import { Runner } from './runner.js';
import type { LogEvent, Run } from './types.js';

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && origin !== `http://${req.get('host')}`) { res.status(403).json({ error: 'Cross-origin requests are not allowed' }); return; }
  next();
});
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
const log = new EventLog();
await log.init();
const clients = new Map<string, Set<express.Response>>();
function send(runId: string, name: string, payload: unknown) {
  for (const res of clients.get(runId) || []) res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
}
const runner = new Runner(log, (run: Run) => send(run.id, 'run', run));
log.on('event', (event: LogEvent) => send(event.runId, 'log', event));
app.get('/api/config', (_req, res) => res.json({ maxWorkers: config.maxWorkers, missingCredentials: missingCredentials() }));
app.get('/api/demo-tree', async (_req, res) => {
  try {
    const map = validateMap(JSON.parse(await readFile('logs/tree_demo.json', 'utf8')));
    // Only send graph labels and connections, not recorded DOM or browser data.
    res.json({ status: map.status, notes: [], rootId: map.rootId,
      states: map.states.map(({ id, task, snapshot }) => ({ id, task, snapshot: { title: snapshot.title, url: snapshot.url } })),
      transitions: map.transitions.map(({ id, from, to, status, reason }) => ({ id, from, to, status, reason })) });
  } catch { res.status(503).json({ error: 'Could not load logs/tree_demo.json. Restore a valid demo flow map and refresh.' }); }
});
const requestSchema = z.object({ prompt: z.string().trim().min(1).max(8000), targetUrl: z.string().url(),
  maxWorkers: z.number().int().min(1).max(config.maxWorkers), flowMap: z.unknown().optional(), testSingleAction: z.boolean().default(false), previewGraph: z.boolean().default(false) });
app.post('/api/runs', (req, res) => {
  try {
    const input = requestSchema.parse(req.body);
    const url = new URL(input.targetUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) target URL without credentials');
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Browserbase needs the public tunnel URL, not localhost');
    const map = input.flowMap === undefined ? undefined : validateMap(input.flowMap, url.href);
    const missing = missingCredentials();
    if (missing.length) { res.status(503).json({ error: `Set these environment variables: ${missing.join(', ')}` }); return; }
    res.status(202).json(runner.start(input.prompt, url.href, input.maxWorkers, map, input.testSingleAction, input.previewGraph));
  } catch (error) { res.status(String(error).includes('already active') ? 409 : 400).json({ error: String(error) }); }
});
app.get('/api/runs/:id', (req, res) => {
  const run = runner.runs.get(req.params.id);
  if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
  res.json(run);
});
app.get('/api/runs/:id/map', (req, res) => {
  const map = runner.runs.get(req.params.id)?.map;
  if (!map) { res.status(404).json({ error: 'No flow map yet' }); return; }
  res.attachment('flow-map.json').json(map);
});
app.get('/api/runs/:id/tree', (req, res) => {
  const map = runner.runs.get(req.params.id)?.map;
  if (!map) { res.status(404).json({ error: 'No flow map yet' }); return; }
  res.json(flowTree(map));
});
app.post('/api/runs/:id/cancel', (req, res) => res.status(runner.cancel(req.params.id) ? 202 : 404).json({ ok: true }));
app.post('/api/runs/:id/graph-preview/complete', (req, res) => {
  const ok = runner.completeGraphPreview(req.params.id);
  res.status(ok ? 200 : 409).json(ok ? { ok } : { error: 'Run is not waiting for a graph preview' });
});
app.get('/api/runs/:id/events', async (req, res) => {
  const run = runner.runs.get(req.params.id);
  if (!run) { res.status(404).json({ error: 'Run not found' }); return; }
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const set = clients.get(run.id) || new Set(); clients.set(run.id, set); set.add(res);
  res.write(`event: run\ndata: ${JSON.stringify(run)}\n\n`);
  // Subscribe before replay. Client de-duplicates sequence IDs to cover the overlap.
  for (const event of await log.read(run.id)) res.write(`event: log\ndata: ${JSON.stringify(event)}\n\n`);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
  req.on('close', () => { clearInterval(heartbeat); set.delete(res); });
});
app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(400).json({ error: error.message });
});
const server = app.listen(config.port, '127.0.0.1', () => console.log(`Open http://localhost:${config.port}`));
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  server.close();
  await runner.shutdown();
  for (const set of clients.values()) for (const res of set) res.end();
  await log.flush(); await Sentry.close(2000);
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
