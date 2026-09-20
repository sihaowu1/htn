import './telemetry.js';
import express from 'express';
import { z } from 'zod';
import { fileURLToPath } from 'node:url';
import type { Notification, PoolClient } from 'pg';
import { config, missingCredentials } from './config.js';
import { EvidenceTools } from './evidence-tools.js';
import { validateMap, flowTree } from './flow.js';
import { Harness, MemoryAdapter, PgAdapter, type LegacyEvent } from './sdk/index.js';
import { closeTelemetry } from './telemetry.js';
import { Runner } from './runner.js';
import { ReplayNotFoundError, ReplayProviderError, ReplayService } from './replay.js';
import type { Run } from './types.js';
import { createSearchService } from './search.js';

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use((req, res, next) => {
  const origin = req.get('origin');
  if (origin && origin !== `http://${req.get('host')}`) { res.status(403).json({ error: 'Cross-origin requests are not allowed' }); return; }
  next();
});
app.use('/vendor/hls', express.static(fileURLToPath(new URL('../node_modules/hls.js/dist', import.meta.url))));
app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));
const store: PgAdapter | MemoryAdapter =
  config.databaseUrl ? new PgAdapter() : new MemoryAdapter();
if (store instanceof PgAdapter) await store.init();
const database = store instanceof PgAdapter ? store : undefined;
const search = createSearchService();
await search.initialize().catch(error => console.error('Elasticsearch search unavailable; using PostgreSQL fallback', error));
const harness = new Harness(store);
const replay = new ReplayService(async (runId, sessionId) =>
  (await store.readEvents(runId)).some(event => event.sessionId === sessionId));
const clients = new Map<string, Set<express.Response>>();
function send(runId: string, name: string, payload: unknown) {
  for (const res of clients.get(runId) || []) res.write(`event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`);
}
const runner = new Runner(harness, (run: Run) => send(run.id, 'run', run));
store.on('event', (event: LegacyEvent) => send(event.runId, 'log', event));
let investigationListener: PoolClient | undefined;
if (database) {
  const listener = await database.pool.connect();
  investigationListener = listener;
  await listener.query('LISTEN investigation_reports');
  listener.on('notification', async (notification: Notification) => {
    if (!notification.payload) return;
    const rows = await database.getInvestigation(notification.payload).catch(() => []);
    const latest = rows[0];
    if (latest?.report?.run_id) send(latest.report.run_id, 'investigation', latest.report);
  });
}
app.get('/api/config', (_req, res) => res.json({ maxWorkers: config.maxWorkers, missingCredentials: missingCredentials() }));
const pageSchema = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0) });
app.get('/api/dashboard/metrics', async (_req, res) => {
  if (!database) { res.json([]); return; }
  res.json(await database.getDashboardMetrics());
});
app.get('/api/runs', async (req, res) => {
  if (!database) {
    const items = [...runner.runs.values()].reverse().map(run => ({ run_id: run.id, goal: run.prompt,
      workflow_type: 'browser_qa', status: run.status, created_at: null, agent_count: run.sessions.length,
      event_count: 0, failure_count: run.results.filter(result => result.status !== 'succeeded').length }));
    res.json({ items, total: items.length, limit: items.length, offset: 0 }); return;
  }
  const query = pageSchema.extend({ search: z.string().max(500).optional(), status: z.string().max(100).optional(),
    workflowType: z.string().max(200).optional(), failureCategory: z.string().max(100).optional(),
    investigationStatus: z.string().max(100).optional(), from: z.string().datetime().optional(),
    to: z.string().datetime().optional() }).parse(req.query);
  if (query.search && search.available) {
    try {
      const result = await search.searchRuns({ query: query.search, ...query });
      const items = await database.hydrateRunSearchHits(result.hits, query);
      res.json({ items, total: result.total, limit: query.limit, offset: query.offset,
        searchBackend: 'elasticsearch' }); return;
    } catch (error) { console.error('Elasticsearch run search failed; using PostgreSQL fallback', error); }
  }
  res.json({ ...(await database.listRuns(query)), searchBackend: 'postgres' });
});
const requestSchema = z.object({ prompt: z.string().trim().min(1).max(8000), targetUrl: z.string().url(),
  maxWorkers: z.number().int().min(1).max(config.maxWorkers), flowMap: z.unknown().optional(), testSingleAction: z.boolean().default(false) });
app.post('/api/runs', (req, res) => {
  try {
    const input = requestSchema.parse(req.body);
    const url = new URL(input.targetUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) target URL without credentials');
    if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Browserbase needs the public tunnel URL, not localhost');
    const map = input.flowMap === undefined ? undefined : validateMap(input.flowMap, url.href);
    const missing = missingCredentials();
    if (missing.length) { res.status(503).json({ error: `Set these environment variables: ${missing.join(', ')}` }); return; }
    res.status(202).json(runner.start(input.prompt, url.href, input.maxWorkers, map, input.testSingleAction));
  } catch (error) { res.status(String(error).includes('already active') ? 409 : 400).json({ error: String(error) }); }
});
app.get('/api/runs/:id', async (req, res) => {
  const run = runner.runs.get(req.params.id);
  if (run) { res.json(run); return; }
  const summary = await database?.getRunSummary(req.params.id);
  if (!summary) { res.status(404).json({ error: 'Run not found' }); return; }
  res.json(summary);
});
app.get('/api/runs/:id/summary', async (req, res) => {
  if (!database) { res.status(503).json({ error: 'DATABASE_URL is not configured' }); return; }
  const summary = await database.getRunSummary(req.params.id);
  if (!summary) { res.status(404).json({ error: 'Run not found' }); return; }
  res.json(summary);
});
app.get('/api/runs/:id/graph', async (req, res) => {
  if (!database) { res.status(503).json({ error: 'DATABASE_URL is not configured' }); return; }
  res.json(await database.getRunGraph(req.params.id));
});
app.get('/api/runs/:id/metrics', async (req, res) => {
  if (!database) { res.status(503).json({ error: 'DATABASE_URL is not configured' }); return; }
  const summary = await database.getRunSummary(req.params.id);
  if (!summary) { res.status(404).json({ error: 'Run not found' }); return; }
  res.json(summary.metrics);
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
app.get('/api/runs/:id/investigations', async (req, res) => {
  if (!database) { res.status(503).json({ error: 'DATABASE_URL is not configured' }); return; }
  res.json(await database.listInvestigations(req.params.id));
});
app.get('/api/investigations/:id', async (req, res) => {
  if (!database) { res.status(503).json({ error: 'DATABASE_URL is not configured' }); return; }
  const reports = await database.getInvestigation(req.params.id);
  if (!reports.length) { res.status(404).json({ error: 'Investigation not found' }); return; }
  res.json(reports);
});
app.post('/api/runs/:id/investigations', async (req, res) => {
  if (!database) { res.status(503).json({ error: 'DATABASE_URL is not configured' }); return; }
  const input = z.object({ eventId: z.string().uuid(), signal: z.string().min(1).max(200).default('USER_REQUESTED') }).parse(req.body);
  const jobId = await database.requestInvestigation(req.params.id, input.eventId, input.signal);
  res.status(202).json({ jobId });
});
app.get('/api/runs/:id/artifacts/:artifactId', async (req, res) => {
  if (!database) { res.status(503).json({ error: 'DATABASE_URL is not configured' }); return; }
  const query = z.object({ offset: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().min(1).max(65_536).default(4096) }).parse(req.query);
  const tools = new EvidenceTools(database, req.params.id, { maxCalls: 1, maxEvents: 1,
    maxArtifactBytes: config.investigationMaxArtifactBytes });
  res.json(await tools.readArtifact(req.params.artifactId, query.offset, query.limit));
});
app.get('/api/runs/:runId/sessions/:sessionId/replay', async (req, res) => {
  if (!config.browserbaseReplayEnabled) {
    res.status(404).json({ error: 'Browserbase replay is disabled' }); return;
  }
  try {
    const result = await replay.get(req.params.runId, req.params.sessionId);
    res.status(result.status === 'pending' ? 202 : 200).json(result);
  } catch (error) {
    if (error instanceof ReplayNotFoundError) {
      res.status(404).json({ error: error.message }); return;
    }
    if (error instanceof ReplayProviderError) {
      res.status(502).json({ error: error.message }); return;
    }
    throw error;
  }
});
app.post('/api/runs/:id/cancel', (req, res) => res.status(runner.cancel(req.params.id) ? 202 : 404).json({ ok: true }));
app.get('/api/runs/:id/events', async (req, res) => {
  if (!database) { res.status(503).json({ error: 'DATABASE_URL is not configured' }); return; }
  const query = pageSchema.extend({ search: z.string().max(500).optional(), type: z.string().max(200).optional(),
    agent: z.string().max(500).optional() }).parse(req.query);
  if (query.search && search.available) {
    try {
      const result = await search.searchEvents({ runId: req.params.id, query: query.search,
        type: query.type, agent: query.agent, limit: query.limit, offset: query.offset });
      const items = (await database.hydrateEventSearchHits(req.params.id, result.hits)).filter(item =>
        (!query.type || item.event_type === query.type) && (!query.agent || item.agent_id === query.agent));
      res.json({ items, total: result.total, limit: query.limit, offset: query.offset,
        searchBackend: 'elasticsearch' }); return;
    } catch (error) { console.error('Elasticsearch event search failed; using PostgreSQL fallback', error); }
  }
  res.json({ ...(await database.queryEvents(req.params.id, query)), searchBackend: 'postgres' });
});
app.get('/api/runs/:id/events/export', async (req, res) => {
  if (!database) { res.status(503).json({ error: 'DATABASE_URL is not configured' }); return; }
  const data = await database.queryEvents(req.params.id, { limit: 200, offset: Number(req.query.offset || 0) });
  res.attachment(`run-${req.params.id}-events.json`).json(data.items);
});
app.get('/api/runs/:id/stream', async (req, res) => {
  const run = runner.runs.get(req.params.id);
  if (!run && !database) { res.status(404).json({ error: 'Run not found' }); return; }
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  const runId = req.params.id;
  const set = clients.get(runId) || new Set(); clients.set(runId, set); set.add(res);
  if (run) res.write(`event: run\ndata: ${JSON.stringify(run)}\n\n`);
  // Subscribe before replay. The client de-duplicates by event ID, with an
  // execution-plus-sequence fallback for legacy rows, to cover the overlap.
  for (const event of await store.readEvents(runId)) res.write(`event: log\ndata: ${JSON.stringify(event)}\n\n`);
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
  await store.flush();
  if (investigationListener) { await investigationListener.query('UNLISTEN investigation_reports').catch(() => undefined); investigationListener.release(); }
  await store.close(); await closeTelemetry(2000);
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
