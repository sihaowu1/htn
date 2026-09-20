import './telemetry.js';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import type { PoolClient } from 'pg';
import { config } from './config.js';
import { PgAdapter, type InvestigationJob } from './sdk/index.js';
import { EvidenceTools } from './evidence-tools.js';
import { InvestigationAgent } from './investigation.js';
import { closeTelemetry, emitMetric, withSpan } from './telemetry.js';
import { createSearchService, type SearchService } from './search.js';

export class ObserverWorker {
  private workerId = `${hostname()}:${process.pid}:${randomUUID()}`;
  private active = 0;
  private draining = false;
  private stopped = false;
  private wakeTimer?: ReturnType<typeof setTimeout>;
  private maintenance?: ReturnType<typeof setInterval>;
  private searchMaintenance?: ReturnType<typeof setInterval>;
  private indexing = false;
  private listener?: PoolClient;

  constructor(private db: PgAdapter, private search: SearchService = createSearchService()) {}

  async start() {
    await this.search.initialize().catch(error => console.error('Elasticsearch initialization failed; indexing will retry', error));
    const listener = await this.db.pool.connect();
    this.listener = listener;
    await listener.query('LISTEN investigation_jobs');
    listener.on('notification', () => void this.drain());
    listener.on('error', (error: Error) => console.error('Investigation LISTEN connection failed', error));
    this.maintenance = setInterval(() => void this.recover(), 60_000);
    if (this.search.available) this.searchMaintenance = setInterval(() => void this.drainSearch(), 5_000);
    await this.recover();
    await this.drainSearch();
  }

  private async recover() {
    if (this.stopped) return;
    await this.db.recoverExpiredJobs();
    await this.db.recoverExpiredSearchOutbox();
    await this.drain();
    await this.drainSearch();
  }

  private async drainSearch() {
    if (!this.search.available || this.indexing || this.stopped) return;
    this.indexing = true;
    let items: Awaited<ReturnType<PgAdapter['claimSearchOutbox']>> = [];
    try {
      items = await this.db.claimSearchOutbox(this.workerId);
      if (!items.length) return;
      await this.search.indexDocuments(items.map(item => ({ kind: item.kind, id: item.documentId, payload: item.payload })));
      await this.db.completeSearchOutbox(this.workerId, items.map(item => item.outboxId));
    } catch (error) {
      await this.db.failSearchOutbox(this.workerId, items, error).catch(() => undefined);
      console.error('Elasticsearch outbox batch failed', error);
    } finally { this.indexing = false; }
  }

  private async scheduleNext() {
    clearTimeout(this.wakeTimer);
    const result = await this.db.pool.query<{ delay: number | null }>(`SELECT
      GREATEST(0, EXTRACT(EPOCH FROM (MIN(available_at) - clock_timestamp())) * 1000)::bigint AS delay
      FROM investigation_jobs WHERE status = 'queued'`);
    const delay = result.rows[0]?.delay == null ? null : Number(result.rows[0].delay);
    if (delay !== null) this.wakeTimer = setTimeout(() => void this.drain(), Math.min(delay + 10, 60_000));
  }

  private async drain() {
    if (this.draining || this.stopped) return;
    this.draining = true;
    try {
      while (!this.stopped && this.active < config.investigationConcurrency) {
        const job = await this.db.claimJob(this.workerId);
        if (!job) break;
        emitMetric({ kind: 'count', name: 'htn.investigation.jobs', value: 1,
          attributes: { outcome: 'claimed' } });
        this.active++;
        void this.runJob(job).finally(() => { this.active--; void this.drain(); });
      }
      await this.scheduleNext();
    } finally { this.draining = false; }
  }

  private async runJob(job: InvestigationJob) {
    return withSpan({ name: 'investigation.job', op: 'agent.investigation',
      attributes: { run_id: job.runId, investigation_job_id: job.jobId } }, async () => {
    const begun = performance.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('Investigation lease expired')),
      Math.max(1000, config.investigationLeaseMs - 1000));
    const heartbeat = setInterval(() => void this.db.heartbeat(job.jobId, this.workerId),
      Math.max(1000, Math.floor(config.investigationLeaseMs / 3)));
    try {
      const tools = new EvidenceTools(this.db, job.runId, {
        maxCalls: config.investigationMaxToolCalls, maxEvents: config.investigationMaxEvents,
        maxArtifactBytes: config.investigationMaxArtifactBytes,
      }, this.search);
      const report = await new InvestigationAgent(tools).run({ run_id: job.runId,
        event_id: job.triggerEventId, goal: job.goal, signal: job.signal }, controller.signal);
      await this.db.completeJob(job, this.workerId, report, config.model);
      emitMetric({ kind: 'count', name: 'htn.investigation.jobs', value: 1,
        attributes: { outcome: 'succeeded' } });
      emitMetric({ kind: 'distribution', name: 'htn.investigation.duration',
        value: performance.now() - begun, unit: 'millisecond', attributes: { outcome: 'succeeded' } });
    } catch (error) {
      await this.db.failJob(job, this.workerId, error);
      const outcome = job.attemptCount >= config.investigationMaxAttempts ? 'dead_lettered' : 'retried';
      emitMetric({ kind: 'count', name: 'htn.investigation.jobs', value: 1, attributes: { outcome } });
      emitMetric({ kind: 'distribution', name: 'htn.investigation.duration',
        value: performance.now() - begun, unit: 'millisecond', attributes: { outcome } });
    } finally { clearTimeout(timeout); clearInterval(heartbeat); }
    });
  }

  async stop() {
    this.stopped = true;
    clearTimeout(this.wakeTimer); clearInterval(this.maintenance); clearInterval(this.searchMaintenance);
    if (this.listener) { await this.listener.query('UNLISTEN investigation_jobs').catch(() => undefined); this.listener.release(); }
    while (this.active || this.indexing) await new Promise(resolve => setTimeout(resolve, 25));
  }
}

async function main() {
  const db = new PgAdapter();
  await db.init();
  const worker = new ObserverWorker(db);
  await worker.start();
  console.log(`Investigation worker ${process.pid} is listening for durable jobs`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    await worker.stop(); await db.close(); await closeTelemetry(2000); process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exit(1); });
}
