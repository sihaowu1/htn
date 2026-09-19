import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import pg from 'pg';
import { config } from '../config.js';
import type { InvestigationReport, InvestigationReportDraft } from '../types.js';
import type { AgentExecution, Event, EventLink, Run } from './types.js';
import type { StoreAdapter } from './harness.js';

const { Pool } = pg;
const SETTLE_MS = 15_000;
const migrationsDir = fileURLToPath(new URL('../../sql/postgres/', import.meta.url));

export type InvestigationJob = {
  jobId: string; clusterId: string; runId: string; triggerEventId: string;
  goal: string; signal: string; generation: number; attemptCount: number;
};

export type LegacyEvent = {
  eventId?: string; runId: string; agentExecutionId?: string; agentId: string;
  role: 'crawler' | 'orchestrator' | 'worker' | 'observer' | 'system';
  sessionId?: string; seq: number; time: string; type: string; data: unknown;
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

export async function enqueueInvestigationForEvent(client: Pick<pg.PoolClient, 'query'>, input: {
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

export class DuplicateEventConflictError extends Error {
  constructor(readonly eventId: string) {
    super(`event_id ${eventId} was already stored with different contents; retries must reuse the identical payload`);
    this.name = 'DuplicateEventConflictError';
  }
}

export class EventLinkUnresolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventLinkUnresolvedError';
  }
}

function roleForAgentId(agentId: string): LegacyEvent['role'] {
  if (agentId === 'observer') return 'observer';
  if (agentId === 'system') return 'system';
  if (agentId.startsWith('worker-') || agentId === 'worker') return 'worker';
  if (agentId === 'crawler') return 'crawler';
  if (agentId === 'orchestrator') return 'orchestrator';
  return 'system';
}

function legacyEvent(event: Event, agentId: string): LegacyEvent {
  return {
    eventId: event.event_id,
    runId: event.run_id,
    agentExecutionId: event.agent_execution_id,
    agentId,
    role: roleForAgentId(agentId),
    sessionId: event.session_id,
    seq: event.sequence_number,
    time: event.occurred_at,
    type: event.event_type,
    data: event.metadata,
  };
}

export class PgAdapter extends EventEmitter implements StoreAdapter {
  readonly pool: pg.Pool;

  constructor(databaseUrl = config.databaseUrl, readonly artifactDir = config.artifactDir, db?: pg.Pool) {
    super();
    if (!databaseUrl && !db) throw new Error('DATABASE_URL is required');
    this.pool = db ?? new Pool({ connectionString: databaseUrl, max: 10,
      idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  }

  private get db(): pg.Pool {
    return this.pool;
  }

  async init() {
    const client = await this.pool.connect();
    try {
      await client.query('SELECT pg_advisory_lock($1)', [9042601]);
      await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      )`);
      const names = ['001_runs_and_agent_executions.sql', '002_events.sql', '003_event_links.sql',
        '004_artifacts.sql', '005_investigations.sql', '006_dashboard_runs.sql'];
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

  async storeRun(run: Run): Promise<void> {
    await this.db.query(
      `INSERT INTO runs (run_id, goal, created_at, workflow_type, status, completed_at, tags)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (run_id) DO NOTHING`,
      [run.run_id, run.goal, run.created_at, run.workflow_type, run.status,
        run.completed_at ?? null, JSON.stringify(run.tags)],
    );
  }

  async storeAgentExecution(execution: AgentExecution): Promise<void> {
    await this.db.query(
      `INSERT INTO agent_executions (agent_execution_id, run_id, agent_id, assigned_task, created_at)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (agent_execution_id) DO NOTHING`,
      [execution.agent_execution_id, execution.run_id, execution.agent_id, execution.assigned_task ?? null, execution.created_at],
    );
  }

  async storeEvent(event: Event): Promise<void> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const execution = await client.query<{ agent_id: string }>(
        'SELECT agent_id FROM agent_executions WHERE run_id = $1 AND agent_execution_id = $2',
        [event.run_id, event.agent_execution_id],
      );
      if (!execution.rowCount) throw new EventLinkUnresolvedError(
        `Agent execution ${event.agent_execution_id} does not exist in run ${event.run_id}`);
      const result = await client.query(
        `INSERT INTO events (event_id, run_id, agent_execution_id, session_id, occurred_at,
           sequence_number, event_type, trace_id, span_id, parent_span_id, metadata, schema_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (event_id) DO NOTHING`,
        [event.event_id, event.run_id, event.agent_execution_id, event.session_id ?? null, event.occurred_at,
          event.sequence_number, event.event_type, event.trace_id ?? null, event.span_id ?? null,
          event.parent_span_id ?? null, JSON.stringify(event.metadata), event.schema_version],
      );
      if (result.rowCount === 0) await this.detectConflictingReuse(event, client);
      else {
        await enqueueInvestigationForEvent(client, { runId: event.run_id, eventId: event.event_id,
          type: event.event_type, data: event.metadata });
        if (event.event_type === 'run.finished' || event.event_type === 'run.failed') {
          const status = textField(event.metadata, ['status', 'outcome']) ||
            (event.event_type === 'run.failed' ? 'failed' : 'completed');
          await client.query('UPDATE runs SET status = $2, completed_at = $3 WHERE run_id = $1',
            [event.run_id, status, event.occurred_at]);
        }
      }
      await client.query('COMMIT');
      this.emit('event', legacyEvent(event, execution.rows[0].agent_id));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw this.translate(error);
    } finally { client.release(); }
  }

  private async detectConflictingReuse(event: Event, client: pg.PoolClient): Promise<void> {
    const existing = await client.query(
      'SELECT event_type, metadata FROM events WHERE event_id = $1', [event.event_id],
    );
    const row = existing.rows[0] as { event_type: string; metadata: unknown } | undefined;
    if (!row) return;
    const sameType = row.event_type === event.event_type;
    const sameMetadata = JSON.stringify(row.metadata) === JSON.stringify(event.metadata);
    if (!sameType || !sameMetadata) throw new DuplicateEventConflictError(event.event_id);
  }

  async storeEventLink(link: EventLink): Promise<void> {
    try {
      await this.db.query(
        `INSERT INTO event_links (run_id, source_event_id, target_event_id, relationship_type)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (source_event_id, target_event_id, relationship_type) DO NOTHING`,
        [link.run_id, link.source_event_id, link.target_event_id, link.relationship_type],
      );
    } catch (error) {
      throw this.translate(error);
    }
  }

  async readEvents(runId?: string): Promise<LegacyEvent[]> {
    const values: unknown[] = [];
    const where = runId ? 'WHERE e.run_id = $1' : '';
    if (runId) values.push(runId);
    const result = await this.db.query(`SELECT e.*, a.agent_id,
      CASE WHEN a.agent_id = 'observer' THEN 'observer'
           WHEN a.agent_id = 'system' THEN 'system'
           WHEN a.agent_id LIKE 'worker-%' THEN 'worker'
           ELSE a.agent_id END AS role
      FROM events e JOIN agent_executions a USING (agent_execution_id) ${where}
      ORDER BY e.ingested_at, e.event_id`, values);
    return result.rows.map(row => ({
      eventId: row.event_id,
      runId: row.run_id,
      agentExecutionId: row.agent_execution_id,
      agentId: row.agent_id,
      role: roleForAgentId(row.agent_id),
      sessionId: row.session_id || undefined,
      seq: Number(row.sequence_number),
      time: new Date(row.occurred_at).toISOString(),
      type: row.event_type,
      data: row.metadata,
    }));
  }

  async addEventLink(runId: string, sourceEventId: string, targetEventId: string,
    relationship: EventLink['relationship_type']) {
    await this.storeEventLink({ run_id: runId, source_event_id: sourceEventId,
      target_event_id: targetEventId, relationship_type: relationship });
  }

  async storeArtifactContent(input: { runId: string; agentExecutionId?: string; kind: string; mimeType: string; content: Buffer }) {
    const artifactId = randomUUID();
    const sha256 = createHash('sha256').update(input.content).digest('hex');
    const path = join(this.artifactDir, sha256.slice(0, 2), sha256);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, input.content, { flag: 'wx' }).catch(async error => {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    });
    await this.db.query(`INSERT INTO artifacts
      (artifact_id, run_id, agent_execution_id, kind, mime_type, byte_size, sha256, storage_path)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [artifactId, input.runId, input.agentExecutionId || null,
      input.kind, input.mimeType, input.content.byteLength, sha256, path]);
    return artifactId;
  }

  async listInvestigations(runId: string) {
    const result = await this.db.query(`SELECT r.report, r.investigation_id, r.revision, r.created_at,
      j.status, j.signal, j.last_error FROM investigation_jobs j
      LEFT JOIN investigation_reports r USING (job_id) WHERE j.run_id = $1 ORDER BY j.created_at DESC`, [runId]);
    return result.rows;
  }

  async listRuns(input: { search?: string; status?: string; workflowType?: string;
    failureCategory?: string; investigationStatus?: string; from?: string; to?: string;
    limit: number; offset: number }) {
    const values: unknown[] = [];
    const where: string[] = [];
    const add = (sql: string, value: unknown) => { values.push(value); where.push(sql.replace('?', `$${values.length}`)); };
    if (input.status) add('r.status = ?', input.status);
    if (input.workflowType) add('r.workflow_type = ?', input.workflowType);
    if (input.from) add('r.created_at >= ?', input.from);
    if (input.to) add('r.created_at <= ?', input.to);
    if (input.failureCategory) add(`EXISTS (SELECT 1 FROM investigation_reports ir
      WHERE ir.run_id = r.run_id AND ir.report->'likely_cause'->>'category' = ?)`, input.failureCategory);
    if (input.investigationStatus) add(`EXISTS (SELECT 1 FROM investigation_jobs ij
      WHERE ij.run_id = r.run_id AND ij.status = ?)`, input.investigationStatus);
    if (input.search) {
      values.push(`%${input.search}%`);
      where.push(`(r.goal ILIKE $${values.length} OR r.run_id::text ILIKE $${values.length} OR EXISTS (
        SELECT 1 FROM agent_executions ax LEFT JOIN events ex USING (agent_execution_id)
        WHERE ax.run_id = r.run_id AND (ax.agent_id ILIKE $${values.length} OR ex.event_type ILIKE $${values.length}
          OR ex.metadata::text ILIKE $${values.length})))`);
    }
    values.push(input.limit, input.offset);
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const result = await this.db.query(`SELECT r.*,
      COUNT(DISTINCT a.agent_execution_id)::int AS agent_count,
      COUNT(DISTINCT e.event_id)::int AS event_count,
      COUNT(DISTINCT e.event_id) FILTER (WHERE e.event_type = 'model.request')::int AS model_call_count,
      COUNT(DISTINCT e.event_id) FILTER (WHERE e.event_type = 'tool.started')::int AS tool_call_count,
      COUNT(DISTINCT e.event_id) FILTER (WHERE e.event_type LIKE 'retry.%')::int AS retry_count,
      COUNT(DISTINCT ar.artifact_id)::int AS artifact_count,
      COUNT(DISTINCT ic.cluster_id)::int AS failure_count,
      COUNT(DISTINCT ij.job_id) FILTER (WHERE ij.status IN ('queued','running'))::int AS investigation_backlog,
      EXTRACT(EPOCH FROM (COALESCE(r.completed_at, clock_timestamp()) - r.created_at)) * 1000 AS duration_ms,
      (ARRAY_AGG(ir.outcome ORDER BY ir.created_at DESC) FILTER (WHERE ir.outcome IS NOT NULL))[1] AS investigation_outcome,
      (ARRAY_AGG(ir.report->'likely_cause'->>'category' ORDER BY ir.created_at DESC)
        FILTER (WHERE ir.report->'likely_cause'->>'category' IS NOT NULL))[1] AS failure_category,
      (ARRAY_AGG(ir.report->'likely_cause'->>'confidence' ORDER BY ir.created_at DESC)
        FILTER (WHERE ir.report->'likely_cause'->>'confidence' IS NOT NULL))[1] AS confidence,
      COUNT(*) OVER()::int AS total_count
      FROM runs r LEFT JOIN agent_executions a USING (run_id) LEFT JOIN events e USING (agent_execution_id)
      LEFT JOIN artifacts ar ON ar.run_id = r.run_id LEFT JOIN incident_clusters ic ON ic.run_id = r.run_id
      LEFT JOIN investigation_jobs ij ON ij.run_id = r.run_id LEFT JOIN investigation_reports ir ON ir.run_id = r.run_id
      ${filter} GROUP BY r.run_id ORDER BY r.created_at DESC
      LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return { items: result.rows, total: Number(result.rows[0]?.total_count || 0), limit: input.limit, offset: input.offset };
  }

  async getRunSummary(runId: string) {
    const run = await this.db.query('SELECT * FROM runs WHERE run_id = $1', [runId]);
    if (!run.rowCount) return null;
    const [agents, counts, clusters, investigations] = await Promise.all([
      this.db.query(`SELECT a.*, COUNT(e.event_id)::int AS event_count,
        COUNT(e.event_id) FILTER (WHERE e.event_type LIKE 'retry.%')::int AS retry_count,
        MIN(e.occurred_at) AS first_event_at, MAX(e.occurred_at) AS last_event_at,
        (ARRAY_AGG(e.event_type ORDER BY e.sequence_number DESC) FILTER (WHERE e.event_id IS NOT NULL))[1] AS last_event,
        (ARRAY_AGG(e.metadata->>'outcome' ORDER BY e.sequence_number DESC)
          FILTER (WHERE e.event_type = 'agent.completed'))[1] AS outcome
        FROM agent_executions a LEFT JOIN events e USING (agent_execution_id)
        WHERE a.run_id = $1 GROUP BY a.agent_execution_id ORDER BY a.created_at`, [runId]),
      this.db.query(`SELECT COUNT(*)::int AS events,
        COUNT(*) FILTER (WHERE event_type = 'model.request')::int AS model_calls,
        COUNT(*) FILTER (WHERE event_type = 'tool.started')::int AS tool_calls,
        COUNT(*) FILTER (WHERE event_type LIKE 'retry.%')::int AS retries,
        COUNT(*) FILTER (WHERE event_type ~ '(failed|failure|error)$')::int AS failures,
        MIN(occurred_at) AS first_event_at, MAX(occurred_at) AS last_event_at,
        PERCENTILE_CONT(.5) WITHIN GROUP (ORDER BY (metadata->>'duration_ms')::numeric)
          FILTER (WHERE metadata ? 'duration_ms') AS latency_p50_ms,
        PERCENTILE_CONT(.95) WITHIN GROUP (ORDER BY (metadata->>'duration_ms')::numeric)
          FILTER (WHERE metadata ? 'duration_ms') AS latency_p95_ms
        FROM events WHERE run_id = $1`, [runId]),
      this.db.query(`SELECT c.*, COUNT(t.event_id)::int AS occurrences FROM incident_clusters c
        LEFT JOIN incident_triggers t USING (cluster_id) WHERE c.run_id = $1 GROUP BY c.cluster_id
        ORDER BY c.first_triggered_at`, [runId]),
      this.listInvestigations(runId),
    ]);
    return { ...run.rows[0], metrics: counts.rows[0], agents: agents.rows,
      failures: clusters.rows, investigations };
  }

  async queryEvents(runId: string, input: { search?: string; type?: string; agent?: string; limit: number; offset: number }) {
    const values: unknown[] = [runId]; const where = ['e.run_id = $1'];
    if (input.type) { values.push(input.type); where.push(`e.event_type = $${values.length}`); }
    if (input.agent) { values.push(input.agent); where.push(`a.agent_id = $${values.length}`); }
    if (input.search) { values.push(`%${input.search}%`); where.push(`(e.event_type ILIKE $${values.length} OR e.metadata::text ILIKE $${values.length})`); }
    values.push(input.limit, input.offset);
    const result = await this.db.query(`SELECT e.*, a.agent_id, COUNT(*) OVER()::int AS total_count
      FROM events e JOIN agent_executions a USING (agent_execution_id) WHERE ${where.join(' AND ')}
      ORDER BY e.occurred_at, e.event_id LIMIT $${values.length - 1} OFFSET $${values.length}`, values);
    return { items: result.rows, total: Number(result.rows[0]?.total_count || 0), limit: input.limit, offset: input.offset };
  }

  async getRunGraph(runId: string) {
    const [nodes, edges] = await Promise.all([
      this.db.query(`SELECT e.event_id AS id, e.event_type AS type, e.agent_execution_id, a.agent_id, e.session_id,
        e.occurred_at, e.ingested_at, e.sequence_number, e.trace_id, e.span_id, e.parent_span_id,
        e.schema_version, e.metadata FROM events e JOIN agent_executions a USING (agent_execution_id)
        WHERE e.run_id = $1 ORDER BY e.occurred_at, e.event_id`, [runId]),
      this.db.query(`SELECT source_event_id AS source, target_event_id AS target, relationship_type AS relationship,
        false AS inferred FROM event_links WHERE run_id = $1`, [runId]),
    ]);
    return { nodes: nodes.rows, edges: edges.rows };
  }

  async getDashboardMetrics() {
    const result = await this.db.query(`SELECT date_trunc('day', r.created_at) AS day, r.status,
      COUNT(DISTINCT r.run_id)::int AS runs,
      COUNT(DISTINCT ic.cluster_id)::int AS failures,
      COUNT(DISTINCT ij.job_id) FILTER (WHERE ij.status IN ('queued','running'))::int AS investigation_backlog,
      COUNT(DISTINCT ir.investigation_id) FILTER (WHERE ir.outcome = 'INSUFFICIENT_EVIDENCE')::int AS insufficient_evidence
      FROM runs r LEFT JOIN incident_clusters ic USING (run_id) LEFT JOIN investigation_jobs ij USING (run_id)
      LEFT JOIN investigation_reports ir USING (run_id) GROUP BY 1,2 ORDER BY 1`);
    return result.rows;
  }

  async getInvestigation(investigationId: string) {
    const result = await this.db.query(`SELECT report, investigation_id, revision, created_at
      FROM investigation_reports WHERE investigation_id = $1 ORDER BY revision DESC`, [investigationId]);
    return result.rows;
  }

  async requestInvestigation(runId: string, eventId: string, signal = 'USER_REQUESTED') {
    const client = await this.db.connect();
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
    const result = await this.db.query<any>(`WITH candidate AS (
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
    await this.db.query(`UPDATE investigation_jobs SET lease_expires_at = clock_timestamp() + ($3 * interval '1 millisecond'),
      updated_at = clock_timestamp() WHERE job_id = $1 AND locked_by = $2 AND status = 'running'`,
    [jobId, workerId, config.investigationLeaseMs]);
  }

  async failJob(job: InvestigationJob, workerId: string, error: unknown) {
    const dead = job.attemptCount >= config.investigationMaxAttempts;
    const delay = Math.min(60_000, 1000 * 2 ** Math.max(0, job.attemptCount - 1));
    await this.db.query(`UPDATE investigation_jobs SET status = $3, available_at = clock_timestamp() + ($4 * interval '1 millisecond'),
      locked_by = NULL, lease_expires_at = NULL, last_error = $5, updated_at = clock_timestamp()
      WHERE job_id = $1 AND locked_by = $2`, [job.jobId, workerId, dead ? 'dead_letter' : 'queued', delay, String(error).slice(0, 4000)]);
  }

  async recoverExpiredJobs() {
    await this.db.query(`UPDATE investigation_jobs SET status = CASE WHEN attempt_count >= max_attempts THEN 'dead_letter' ELSE 'queued' END,
      available_at = clock_timestamp(), locked_by = NULL, lease_expires_at = NULL,
      last_error = COALESCE(last_error, 'Worker lease expired'), updated_at = clock_timestamp()
      WHERE status = 'running' AND lease_expires_at < clock_timestamp()`);
  }

  async completeJob(job: InvestigationJob, workerId: string, draft: InvestigationReportDraft, model: string) {
    const report = await this.validateReport(job.runId, job.triggerEventId, draft);
    const investigationId = job.clusterId;
    const revisionResult = await this.db.query<{ revision: number }>(
      'SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM investigation_reports WHERE investigation_id = $1', [investigationId]);
    const revision = Number(revisionResult.rows[0].revision);
    const full: InvestigationReport = { ...report, investigation_id: investigationId, run_id: job.runId,
      trigger_event_id: job.triggerEventId, revision };
    const client = await this.db.connect();
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
      ...report.recovery_events, ...report.assumption_event_ids,
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
    const result = await this.db.query(`SELECT ${column} AS id FROM ${table} WHERE run_id = $1 AND ${column} = ANY($2::uuid[])`, [runId, [...ids]]);
    return new Set<string>(result.rows.map(row => row.id));
  }

  private translate(error: unknown): Error {
    if (error instanceof Error && 'code' in error) {
      const code = (error as { code?: string }).code;
      if (code === '23503') return new EventLinkUnresolvedError(`Foreign key violation: ${error.message}`);
      if (code === '23505') return new DuplicateEventConflictError('unique constraint violated');
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  async flush() { /* PostgreSQL writes are awaited eagerly. */ }

  async close(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }
}
