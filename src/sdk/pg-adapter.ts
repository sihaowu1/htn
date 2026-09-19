import pg from 'pg';
import type { AgentExecution, Event, EventLink, Run } from './types.js';
import type { StoreAdapter } from './harness.js';

const { Pool } = pg;

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

let sharedPool: pg.Pool | undefined;

export function pool(): pg.Pool {
  if (!sharedPool) {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error('Set DATABASE_URL to use the PostgreSQL adapter');
    sharedPool = new Pool({ connectionString, max: 10, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 5_000 });
  }
  return sharedPool;
}

export async function closePool(): Promise<void> {
  await sharedPool?.end();
  sharedPool = undefined;
}

export class PgAdapter implements StoreAdapter {
  constructor(private db: pg.Pool = pool()) {}

  async storeRun(run: Run): Promise<void> {
    await this.db.query(
      'INSERT INTO runs (run_id, goal, created_at) VALUES ($1, $2, $3) ON CONFLICT (run_id) DO NOTHING',
      [run.run_id, run.goal, run.created_at],
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
    try {
      const result = await this.db.query(
        `INSERT INTO events (event_id, run_id, agent_execution_id, session_id, occurred_at,
           sequence_number, event_type, trace_id, span_id, parent_span_id, metadata, schema_version)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (event_id) DO NOTHING`,
        [event.event_id, event.run_id, event.agent_execution_id, event.session_id ?? null, event.occurred_at,
          event.sequence_number, event.event_type, event.trace_id ?? null, event.span_id ?? null,
          event.parent_span_id ?? null, JSON.stringify(event.metadata), event.schema_version],
      );
      if (result.rowCount === 0) await this.detectConflictingReuse(event);
    } catch (error) {
      throw this.translate(error);
    }
  }

  private async detectConflictingReuse(event: Event): Promise<void> {
    const existing = await this.db.query(
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

  private translate(error: unknown): Error {
    if (error instanceof Error && 'code' in error) {
      const code = (error as { code?: string }).code;
      if (code === '23503') return new EventLinkUnresolvedError(`Foreign key violation: ${error.message}`);
      if (code === '23505') return new DuplicateEventConflictError('unique constraint violated');
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  async close(): Promise<void> {
    await closePool();
  }
}
