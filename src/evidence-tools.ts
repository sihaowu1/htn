import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import type { PgAdapter } from './sdk/index.js';

export type EvidenceToolName = 'get_run_summary' | 'get_event' | 'get_agent_events' |
  'get_related_events' | 'read_artifact' | 'get_sentry_trace';

export class EvidenceTools {
  private calls = 0;
  private eventsRead = 0;
  private artifactBytes = 0;

  constructor(private db: PgAdapter, private runId: string, private limits: {
    maxCalls: number; maxEvents: number; maxArtifactBytes: number;
  }) {}

  async execute(name: EvidenceToolName, args: Record<string, unknown>) {
    if (++this.calls > this.limits.maxCalls) throw new Error('Investigation evidence-tool budget exhausted');
    switch (name) {
      case 'get_run_summary': return this.getRunSummary(String(args.run_id || ''));
      case 'get_event': return this.getEvent(String(args.event_id || ''));
      case 'get_agent_events': return this.getAgentEvents(String(args.agent_execution_id || ''),
        args.before == null ? undefined : Number(args.before), args.after == null ? undefined : Number(args.after),
        Number(args.limit || 20));
      case 'get_related_events': return this.getRelatedEvents(String(args.event_id || ''));
      case 'read_artifact': return this.readArtifact(String(args.artifact_id || ''), Number(args.offset || 0), Number(args.limit || 4096));
      case 'get_sentry_trace': return this.getSentryTrace(String(args.trace_id || ''));
      default: throw new Error(`Unknown evidence tool: ${name}`);
    }
  }

  private assertRun(runId: string) {
    if (runId !== this.runId) throw new Error('Evidence query is outside the investigation run');
  }

  private takeEvents(count: number) {
    this.eventsRead += count;
    if (this.eventsRead > this.limits.maxEvents) throw new Error('Investigation event-read budget exhausted');
  }

  async getRunSummary(runId: string) {
    this.assertRun(runId);
    const [run, executions, statuses, incidents] = await Promise.all([
      this.db.pool.query('SELECT run_id, goal, created_at FROM runs WHERE run_id = $1', [runId]),
      this.db.pool.query(`SELECT a.agent_execution_id, a.agent_id, a.assigned_task, a.created_at,
        COUNT(e.event_id)::int AS event_count,
        (ARRAY_AGG(e.event_type ORDER BY e.sequence_number DESC)
          FILTER (WHERE e.event_type ~ '(completed|finished|failed|succeeded)$'))[1] AS latest_terminal_event
        FROM agent_executions a LEFT JOIN events e USING (agent_execution_id)
        WHERE a.run_id = $1 GROUP BY a.agent_execution_id ORDER BY a.created_at`, [runId]),
      this.db.pool.query(`SELECT event_type, COUNT(*)::int AS count FROM events WHERE run_id = $1
        AND (event_type ~ '(failed|failure|error|finished|succeeded)$') GROUP BY event_type`, [runId]),
      this.db.pool.query(`SELECT signal, COUNT(*)::int AS count FROM incident_clusters
        WHERE run_id = $1 GROUP BY signal ORDER BY signal`, [runId]),
    ]);
    if (!run.rowCount) throw new Error('Run not found');
    return { ...run.rows[0], executions: executions.rows, high_level_status: statuses.rows, incidents: incidents.rows };
  }

  async getEvent(eventId: string) {
    const result = await this.db.pool.query(`SELECT e.*, a.agent_id FROM events e
      JOIN agent_executions a USING (agent_execution_id) WHERE e.run_id = $1 AND e.event_id = $2`, [this.runId, eventId]);
    if (!result.rowCount) throw new Error('Event not found in investigation run');
    const cluster = await this.db.pool.query(`SELECT c.cluster_id, c.signal,
      (ARRAY_AGG(t.event_id ORDER BY t.created_at, t.event_id))[1:50] AS trigger_event_ids
      FROM incident_triggers t JOIN incident_clusters c USING (cluster_id)
      WHERE c.run_id = $1 AND c.cluster_id IN (
        SELECT cluster_id FROM incident_triggers WHERE run_id = $1 AND event_id = $2
      ) GROUP BY c.cluster_id`, [this.runId, eventId]);
    const clusteredEvents = cluster.rows[0]?.trigger_event_ids?.length || 0;
    this.takeEvents(Math.max(1, clusteredEvents));
    return { ...result.rows[0], incident_cluster: cluster.rows[0] || null };
  }

  async getAgentEvents(agentExecutionId: string, before?: number, after?: number, limit = 20) {
    limit = Math.max(1, Math.min(50, Math.floor(limit)));
    if (before !== undefined && after !== undefined) throw new Error('Use either before or after, not both');
    const execution = await this.db.pool.query('SELECT 1 FROM agent_executions WHERE run_id = $1 AND agent_execution_id = $2',
      [this.runId, agentExecutionId]);
    if (!execution.rowCount) throw new Error('Agent execution not found in investigation run');
    const predicate = before !== undefined ? 'AND sequence_number < $3' : after !== undefined ? 'AND sequence_number > $3' : '';
    const direction = before !== undefined ? 'DESC' : 'ASC';
    const values: unknown[] = [this.runId, agentExecutionId];
    if (before !== undefined || after !== undefined) values.push(before ?? after);
    values.push(limit);
    const result = await this.db.pool.query(`SELECT * FROM events WHERE run_id = $1 AND agent_execution_id = $2
      ${predicate} ORDER BY sequence_number ${direction} LIMIT $${values.length}`, values);
    this.takeEvents(result.rows.length);
    return before !== undefined ? result.rows.reverse() : result.rows;
  }

  async getRelatedEvents(eventId: string) {
    const source = await this.db.pool.query('SELECT 1 FROM events WHERE run_id = $1 AND event_id = $2', [this.runId, eventId]);
    if (!source.rowCount) throw new Error('Event not found in investigation run');
    const result = await this.db.pool.query(`SELECT l.relationship_type, l.source_event_id, l.target_event_id,
      CASE WHEN l.source_event_id = $2 THEN 'outgoing_to_antecedent' ELSE 'incoming_from_dependent' END AS direction,
      e.event_type, e.agent_execution_id, e.occurred_at, e.metadata
      FROM event_links l JOIN events e ON e.event_id = CASE WHEN l.source_event_id = $2 THEN l.target_event_id ELSE l.source_event_id END
      WHERE l.run_id = $1 AND (l.source_event_id = $2 OR l.target_event_id = $2)
      ORDER BY e.occurred_at, e.event_id`, [this.runId, eventId]);
    this.takeEvents(result.rows.length);
    return result.rows;
  }

  async readArtifact(artifactId: string, offset: number, limit: number) {
    offset = Math.max(0, Math.floor(offset));
    limit = Math.max(1, Math.min(64 * 1024, Math.floor(limit)));
    if (this.artifactBytes + limit > this.limits.maxArtifactBytes) throw new Error('Investigation artifact-read budget exhausted');
    const result = await this.db.pool.query(`SELECT * FROM artifacts WHERE run_id = $1 AND artifact_id = $2`, [this.runId, artifactId]);
    if (!result.rowCount) throw new Error('Artifact not found in investigation run');
    const artifact = result.rows[0];
    if (artifact.availability !== 'available') return { artifact_id: artifactId, availability: artifact.availability };
    try {
      const handle = await open(artifact.storage_path, 'r');
      try {
        const size = Math.min(limit, Math.max(0, Number(artifact.byte_size) - offset));
        const buffer = Buffer.alloc(size);
        const { bytesRead } = await handle.read(buffer, 0, size, offset);
        this.artifactBytes += bytesRead;
        const bytes = buffer.subarray(0, bytesRead);
        if (offset === 0 && bytesRead === Number(artifact.byte_size)) {
          const digest = createHash('sha256').update(bytes).digest('hex');
          if (digest !== artifact.sha256) return { artifact_id: artifactId, availability: 'corrupt' };
        }
        return { artifact_id: artifactId, mime_type: artifact.mime_type, offset, bytes_read: bytesRead,
          total_bytes: Number(artifact.byte_size), content_base64: bytes.toString('base64') };
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { artifact_id: artifactId, availability: 'missing' };
      throw error;
    }
  }

  async getSentryTrace(traceId: string) {
    const token = process.env.SENTRY_AUTH_TOKEN;
    const org = process.env.SENTRY_ORG;
    const project = process.env.SENTRY_PROJECT;
    if (!token || !org || !project) return { trace_id: traceId, available: false, gap: 'Sentry query credentials are not configured' };
    const query = encodeURIComponent(`trace:${traceId}`);
    const response = await fetch(`https://sentry.io/api/0/projects/${encodeURIComponent(org)}/${encodeURIComponent(project)}/events/?query=${query}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { trace_id: traceId, available: false, gap: `Sentry returned HTTP ${response.status}` };
    const body = await response.json();
    return { trace_id: traceId, available: true, events: Array.isArray(body) ? body.slice(0, 50) : body };
  }
}

export const evidenceToolDefinitions = [
  { name: 'get_run_summary', description: 'Get the goal, executions, and high-level status for the current run.',
    parameters: { type: 'object', properties: { run_id: { type: 'string' } }, required: ['run_id'], additionalProperties: false } },
  { name: 'get_event', description: 'Get deep metadata for one event in the current run.',
    parameters: { type: 'object', properties: { event_id: { type: 'string' } }, required: ['event_id'], additionalProperties: false } },
  { name: 'get_agent_events', description: 'Get a bounded execution-local event slice using sequence-number cursors.',
    parameters: { type: 'object', properties: { agent_execution_id: { type: 'string' }, before: { type: 'integer' },
      after: { type: 'integer' }, limit: { type: 'integer', minimum: 1, maximum: 50 } },
    required: ['agent_execution_id', 'limit'], additionalProperties: false } },
  { name: 'get_related_events', description: 'Traverse explicit consumes_output, responds_to, and retries links.',
    parameters: { type: 'object', properties: { event_id: { type: 'string' } }, required: ['event_id'], additionalProperties: false } },
  { name: 'read_artifact', description: 'Read a bounded byte range from an artifact.',
    parameters: { type: 'object', properties: { artifact_id: { type: 'string' }, offset: { type: 'integer', minimum: 0 },
      limit: { type: 'integer', minimum: 1, maximum: 65536 } }, required: ['artifact_id', 'offset', 'limit'], additionalProperties: false } },
  { name: 'get_sentry_trace', description: 'Fetch correlated Sentry events for a trace ID.',
    parameters: { type: 'object', properties: { trace_id: { type: 'string' } }, required: ['trace_id'], additionalProperties: false } },
] as const;
