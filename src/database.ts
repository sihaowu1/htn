import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { config } from './config.js';
import { redact } from './telemetry.js';
import type { Identity, InvestigationReport, InvestigationReportDraft, LogEvent } from './types.js';

const SETTLE_MS = 15_000;
const migrationsDir = fileURLToPath(new URL('../sql/postgres/', import.meta.url));

export type InvestigationJob = {
  jobId: string; clusterId: string; runId: string; triggerEventId: string;
  goal: string; signal: string; generation: number; attemptCount: number;
};

function textField(data: unknown, names: string[]) {
  if (!data || typeof data !== 'object') return '';
  const record = data as Record<string, unknown>;
  for (const name of names) if (typeof record[name] === 'string') return record[name] as string;
  return '';
}

function normalizeFailureText(value: string) {
  return value.toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '<uuid>')
    .replace(/https?:\/\/\S+/g, '<url>')
    .replace(/\b\d{2,}\b/g, '<n>')
    .replace(/\s+/g, ' ').trim().slice(0, 500);
}

export function failureSignal(type: string, data: unknown) {
  if (type === 'run.finished') return 'RUN_COMPLETION';
  if (/(^|\.)(failed|failure|error|timeout|deadline|budget_exceeded)$/.test(type)) return type;
  if (/(^|\.)(deadline|timeout|budget)(\.|_)(exceeded|failed)$/.test(type)) return type;
  if (['failed', 'failure', 'timed_out'].includes(textField(data, ['status', 'outcome']).toLowerCase())) return type;
  return null;
}

export function failureFingerprint(runId: string, type: string, data: unknown) {
  const signal = failureSignal(type, data);
  if (!signal) return null;
  if (signal === 'RUN_COMPLETION') return createHash('sha256').update(`${runId}\0run_completion`).digest('hex');
  const identity = textField(data, ['tool', 'check', 'operation', 'name', 'code']);
  const error = textField(data, ['error', 'reason', 'message']);
  return createHash('sha256').update([
    runId, type, normalizeFailureText(identity), normalizeFailureText(error),
  ].join('\0')).digest('hex');
}

export async function enqueueInvestigationForEvent(client: Pick<PoolClient, 'query'>, input: {
  runId: string; eventId: string; type: string; data: unknown;
}) {
  const signal = failureSignal(input.type, input.data);
  const fingerprint = failureFingerprint(input.runId, input.type, input.data);
  if (!signal || !fingerprint) return;
  const clusterId = randomUUID();
  const inserted = await client.query<{ cluster_id: string }>(`INSERT INTO incident_clusters
    (cluster_id, run_id, fingerprint, signal, first_trigger_event_id, latest_trigger_event_id)
    VALUES ($1,$2,$3,$4,$5,$5) ON CONFLICT (run_id, fingerprint) DO NOTHING RETURNING cluster_id`,
  [clusterId, input.runId, fingerprint, signal, input.eventId]);
  const resolved = inserted.rows[0]?.cluster_id || (await client.query<{ cluster_id: string }>(
    'SELECT cluster_id FROM incident_clusters WHERE run_id = $1 AND fingerprint = $2', [input.runId, fingerprint])).rows[0].cluster_id;
  await client.query(`UPDATE incident_clusters SET latest_trigger_event_id = $2, last_triggered_at = clock_timestamp()
    WHERE cluster_id = $1`, [resolved, input.eventId]);
  await client.query(`INSERT INTO incident_triggers (cluster_id, run_id, event_id) VALUES ($1,$2,$3)
    ON CONFLICT DO NOTHING`, [resolved, input.runId, input.eventId]);
  if (!inserted.rowCount) return;
  const run = await client.query<{ goal: string }>('SELECT goal FROM runs WHERE run_id = $1', [input.runId]);
  await client.query(`INSERT INTO investigation_jobs
    (job_id, cluster_id, run_id, trigger_event_id, goal, signal, available_at, max_attempts)
    VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp() + ($7 * interval '1 millisecond'),$8)`, [
    randomUUID(), resolved, input.runId, input.eventId, run.rows[0].goal, signal,
    signal === 'RUN_COMPLETION' ? 0 : SETTLE_MS, config.investigationMaxAttempts,
  ]);
}

function rowEvent(row: any): LogEvent {
  return {
    eventId: row.event_id, runId: row.run_id, agentExecutionId: row.agent_execution_id,
    agentId: row.agent_id, role: row.role || 'system', sessionId: row.session_id || undefined,
    seq: Number(row.sequence_number), time: new Date(row.occurred_at).toISOString(),
    type: row.event_type, data: row.metadata,
  };
}

export class EvidenceDatabase extends EventEmitter {
  readonly pool: Pool;
  private executions = new Map<string, string>();

  constructor(databaseUrl = config.databaseUrl, readonly artifactDir = config.artifactDir) {
    super();
    if (!databaseUrl) throw new Error('DATABASE_URL is required');
    this.pool = new Pool({ connectionString: databaseUrl, max: 10 });
  }

  async init() {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [9042601]);
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      )`);
      const names = ['001_runs_and_agent_executions.sql', '002_events.sql', '003_event_links.sql',
        '004_artifacts.sql', '005_investigations.sql'];
      for (const name of names) {
        const found = await client.query('SELECT 1 FROM schema_migrations WHERE filename = $1', [name]);
        if (found.rowCount) continue;
        await client.query(await readFile(join(migrationsDir, name), 'utf8'));
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [name]);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [9042601]).catch(() => undefined);
      client.release();
    }
    await mkdir(this.artifactDir, { recursive: true });
  }

  private executionId(identity: Identity) {
    if (identity.agentExecutionId) return identity.agentExecutionId;
    const key = `${identity.runId}:${identity.role}:${identity.agentId}`;
    let value = this.executions.get(key);
    if (!value) { value = randomUUID(); this.executions.set(key, value); }
    return value;
  }

  private async nextSequence(client: PoolClient, executionId: string) {
    await client.query('SELECT 1 FROM agent_executions WHERE agent_execution_id = $1 FOR UPDATE', [executionId]);
    const result = await client.query('SELECT COALESCE(MAX(sequence_number), -1) + 1 AS next FROM events WHERE agent_execution_id = $1', [executionId]);
    return Number(result.rows[0].next);
  }

  async write(identity: Identity, type: string, data: unknown = {}): Promise<LogEvent> {
    const eventId = randomUUID();
    const executionId = this.executionId(identity);
    const occurredAt = new Date();
    const metadata = redact(data) as Record<string, unknown>;
    const client = await this.pool.connect();
    let seq = 0;
    try {
      await client.query('BEGIN');
      const goal = type === 'run.started' ? textField(metadata, ['prompt', 'goal']) || `Run ${identity.runId}` : `Run ${identity.runId}`;
      await client.query(`INSERT INTO runs (run_id, goal) VALUES ($1, $2)
        ON CONFLICT (run_id) DO UPDATE SET goal = CASE WHEN $3 THEN EXCLUDED.goal ELSE runs.goal END`,
      [identity.runId, goal, type === 'run.started']);
      await client.query(`INSERT INTO agent_executions
        (agent_execution_id, run_id, agent_id, assigned_task)
        VALUES ($1, $2, $3, $4) ON CONFLICT (agent_execution_id) DO NOTHING`,
      [executionId, identity.runId, identity.agentId, textField(metadata, ['assignedTask', 'task']) || null]);
      seq = await this.nextSequence(client, executionId);
      await client.query(`INSERT INTO events
        (event_id, run_id, agent_execution_id, session_id, occurred_at, sequence_number, event_type, trace_id, span_id, parent_span_id, metadata)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [
        eventId, identity.runId, executionId, identity.sessionId || null, occurredAt, seq, type,
        textField(metadata, ['trace_id', 'traceId']) || null, textField(metadata, ['span_id', 'spanId']) || null,
        textField(metadata, ['parent_span_id', 'parentSpanId']) || null, metadata,
      ]);
      await enqueueInvestigationForEvent(client, { runId: identity.runId, eventId, type, data: metadata });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
    const event: LogEvent = { ...identity, agentExecutionId: executionId, eventId, seq, time: occurredAt.toISOString(), type, data: metadata };
    this.emit('event', event);
    return event;
  }

  async read(runId?: string): Promise<LogEvent[]> {
    const values: unknown[] = [];
    const where = runId ? 'WHERE e.run_id = $1' : '';
    if (runId) values.push(runId);
    const result = await this.pool.query(`SELECT e.*, a.agent_id,
      CASE WHEN a.agent_id = 'observer' THEN 'observer'
           WHEN a.agent_id = 'system' THEN 'system'
           WHEN a.agent_id LIKE 'worker-%' THEN 'worker'
           ELSE a.agent_id END AS role
      FROM events e JOIN agent_executions a USING (agent_execution_id) ${where}
      ORDER BY e.ingested_at, e.event_id`, values);
    return result.rows.map(rowEvent);
  }

  async addEventLink(runId: string, sourceEventId: string, targetEventId: string,
    relationship: 'consumes_output' | 'responds_to' | 'retries') {
    await this.pool.query(`INSERT INTO event_links (run_id, source_event_id, target_event_id, relationship_type)
      VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [runId, sourceEventId, targetEventId, relationship]);
  }

  async attachArtifact(input: { runId: string; agentExecutionId?: string; kind: string; mimeType: string; content: Buffer }) {
    const artifactId = randomUUID();
    const sha256 = createHash('sha256').update(input.content).digest('hex');
    const path = join(this.artifactDir, sha256.slice(0, 2), sha256);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.content, { flag: 'wx' }).catch(async error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    await this.pool.query(`INSERT INTO artifacts
      (artifact_id, run_id, agent_execution_id, kind, mime_type, byte_size, sha256, storage_path)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [artifactId, input.runId, input.agentExecutionId || null,
      input.kind, input.mimeType, input.content.byteLength, sha256, path]);
    return artifactId;
  }

  async listInvestigations(runId: string) {
    const result = await this.pool.query(`SELECT r.report, r.investigation_id, r.revision, r.created_at,
      j.status, j.signal, j.last_error FROM investigation_jobs j
      LEFT JOIN investigation_reports r USING (job_id) WHERE j.run_id = $1 ORDER BY j.created_at DESC`, [runId]);
    return result.rows;
  }

  async getInvestigation(investigationId: string) {
    const result = await this.pool.query(`SELECT report, investigation_id, revision, created_at
      FROM investigation_reports WHERE investigation_id = $1 ORDER BY revision DESC`, [investigationId]);
    return result.rows;
  }

  async requestInvestigation(runId: string, eventId: string, signal = 'USER_REQUESTED') {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const event = await client.query('SELECT 1 FROM events WHERE run_id = $1 AND event_id = $2', [runId, eventId]);
      if (!event.rowCount) throw new Error('Trigger event not found in run');
      const run = await client.query<{ goal: string }>('SELECT goal FROM runs WHERE run_id = $1', [runId]);
      const clusterId = randomUUID();
      await client.query(`INSERT INTO incident_clusters
        (cluster_id, run_id, fingerprint, signal, first_trigger_event_id, latest_trigger_event_id)
        VALUES ($1,$2,$3,$4,$5,$5)`, [clusterId, runId, `manual:${randomUUID()}`, signal, eventId]);
      const jobId = randomUUID();
      await client.query(`INSERT INTO investigation_jobs
        (job_id, cluster_id, run_id, trigger_event_id, goal, signal, available_at, max_attempts)
        VALUES ($1,$2,$3,$4,$5,$6,clock_timestamp(),$7)`,
      [jobId, clusterId, runId, eventId, run.rows[0].goal, signal, config.investigationMaxAttempts]);
      await client.query('COMMIT');
      return jobId;
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }

  async claimJob(workerId: string): Promise<InvestigationJob | null> {
    const result = await this.pool.query<any>(`WITH candidate AS (
      SELECT job_id FROM investigation_jobs
      WHERE status = 'queued' AND available_at <= clock_timestamp()
      ORDER BY available_at, created_at FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE investigation_jobs j SET status = 'running', locked_by = $1,
      lease_expires_at = clock_timestamp() + ($2 * interval '1 millisecond'),
      attempt_count = attempt_count + 1, updated_at = clock_timestamp()
      FROM candidate WHERE j.job_id = candidate.job_id RETURNING j.*`, [workerId, config.investigationLeaseMs]);
    const row = result.rows[0];
    return row ? { jobId: row.job_id, clusterId: row.cluster_id, runId: row.run_id,
      triggerEventId: row.trigger_event_id, goal: row.goal, signal: row.signal,
      generation: row.generation, attemptCount: row.attempt_count } : null;
  }

  async heartbeat(jobId: string, workerId: string) {
    await this.pool.query(`UPDATE investigation_jobs SET lease_expires_at = clock_timestamp() + ($3 * interval '1 millisecond'),
      updated_at = clock_timestamp() WHERE job_id = $1 AND locked_by = $2 AND status = 'running'`,
    [jobId, workerId, config.investigationLeaseMs]);
  }

  async failJob(job: InvestigationJob, workerId: string, error: unknown) {
    const dead = job.attemptCount >= config.investigationMaxAttempts;
    const delay = Math.min(60_000, 1000 * 2 ** Math.max(0, job.attemptCount - 1));
    await this.pool.query(`UPDATE investigation_jobs SET status = $3, available_at = clock_timestamp() + ($4 * interval '1 millisecond'),
      locked_by = NULL, lease_expires_at = NULL, last_error = $5, updated_at = clock_timestamp()
      WHERE job_id = $1 AND locked_by = $2`, [job.jobId, workerId, dead ? 'dead_letter' : 'queued', delay, String(error).slice(0, 4000)]);
  }

  async recoverExpiredJobs() {
    await this.pool.query(`UPDATE investigation_jobs SET status = CASE WHEN attempt_count >= max_attempts THEN 'dead_letter' ELSE 'queued' END,
      available_at = clock_timestamp(), locked_by = NULL, lease_expires_at = NULL,
      last_error = COALESCE(last_error, 'Worker lease expired'), updated_at = clock_timestamp()
      WHERE status = 'running' AND lease_expires_at < clock_timestamp()`);
  }

  async completeJob(job: InvestigationJob, workerId: string, draft: InvestigationReportDraft, model: string) {
    const report = await this.validateReport(job.runId, job.triggerEventId, draft);
    const investigationId = job.clusterId;
    const revisionResult = await this.pool.query<{ revision: number }>(
      'SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM investigation_reports WHERE investigation_id = $1', [investigationId]);
    const revision = Number(revisionResult.rows[0].revision);
    const full: InvestigationReport = { ...report, investigation_id: investigationId, run_id: job.runId,
      trigger_event_id: job.triggerEventId, revision };
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO investigation_reports
        (investigation_id, revision, job_id, cluster_id, run_id, trigger_event_id, outcome, report, model, prompt_version)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'1')`, [investigationId, revision, job.jobId, job.clusterId,
        job.runId, job.triggerEventId, full.outcome, full, model]);
      const done = await client.query(`UPDATE investigation_jobs SET status = 'succeeded', locked_by = NULL,
        lease_expires_at = NULL, updated_at = clock_timestamp() WHERE job_id = $1 AND locked_by = $2`, [job.jobId, workerId]);
      if (!done.rowCount) throw new Error('Investigation job lease was lost');
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
    this.emit('investigation', full);
    return full;
  }

  private async validateReport(runId: string, triggerEventId: string, report: InvestigationReportDraft) {
    const eventIds = new Set([
      triggerEventId, ...report.observed_facts.flatMap(f => f.event_ids),
      ...report.related_event_ids, ...(report.likely_cause?.supporting_event_ids || []),
      ...(report.earliest_relevant_event_id ? [report.earliest_relevant_event_id] : []),
    ]);
    const executionIds = new Set(report.affected_agent_execution_ids);
    const artifactIds = new Set(report.artifact_ids);
    const [events, executions, artifacts] = await Promise.all([
      this.existingIds('events', 'event_id', runId, eventIds),
      this.existingIds('agent_executions', 'agent_execution_id', runId, executionIds),
      this.existingIds('artifacts', 'artifact_id', runId, artifactIds),
    ]);
    const missing = (wanted: Set<string>, found: Set<string>) => [...wanted].filter(id => !found.has(id));
    const absent = [...missing(eventIds, events), ...missing(executionIds, executions), ...missing(artifactIds, artifacts)];
    if (absent.length) throw new Error(`Report contains out-of-scope or missing citations: ${absent.join(', ')}`);
    return report;
  }

  private async existingIds(table: string, column: string, runId: string, ids: Set<string>) {
    if (!ids.size) return new Set<string>();
    const result = await this.pool.query(`SELECT ${column} AS id FROM ${table} WHERE run_id = $1 AND ${column} = ANY($2::uuid[])`, [runId, [...ids]]);
    return new Set<string>(result.rows.map(row => row.id));
  }

  async flush() { /* PostgreSQL writes are awaited eagerly. */ }
  async close() { await this.pool.end(); }
}

export function safeArtifactName(path: string) { return basename(path); }
