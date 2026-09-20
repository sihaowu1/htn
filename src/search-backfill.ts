import { createSearchService, searchableMetadata } from './search.js';
import { PgAdapter } from './sdk/index.js';

async function main() {
  const db = new PgAdapter();
  await db.init();
  const search = createSearchService();
  if (!search.available) throw new Error('Set ELASTICSEARCH_ENABLED=true, ELASTICSEARCH_URL, and ELASTICSEARCH_API_KEY');

  const events = await search.rebuildIndex('event', async (offset, limit) => {
    const result = await db.pool.query(`SELECT e.*, a.agent_id, a.assigned_task, r.goal, r.workflow_type, r.status
      FROM events e JOIN agent_executions a USING (agent_execution_id) JOIN runs r USING (run_id)
      ORDER BY e.ingested_at, e.event_id LIMIT $1 OFFSET $2`, [limit, offset]);
    return result.rows.map(row => {
      const searchable = searchableMetadata(row.metadata);
      return { id: row.event_id, payload: { document_kind: 'event', event_id: row.event_id,
        run_id: row.run_id, agent_execution_id: row.agent_execution_id, agent_id: row.agent_id,
        assigned_task: row.assigned_task, run_goal: row.goal, workflow_type: row.workflow_type,
        status: row.status, event_type: row.event_type, occurred_at: row.occurred_at,
        session_id: row.session_id, trace_id: row.trace_id, ...searchable.fields,
        metadata_text: searchable.metadata_text } };
    });
  });

  const investigations = await search.rebuildIndex('investigation', async (offset, limit) => {
    const result = await db.pool.query(`SELECT ir.*, r.goal, r.workflow_type, r.status, ij.signal, ij.status AS investigation_status
      FROM investigation_reports ir JOIN runs r USING (run_id) JOIN investigation_jobs ij USING (job_id)
      ORDER BY ir.created_at, ir.investigation_id, ir.revision LIMIT $1 OFFSET $2`, [limit, offset]);
    return result.rows.map(row => { const report = row.report; return {
      id: `${row.investigation_id}:${row.revision}`, payload: { document_kind: 'investigation',
        investigation_id: row.investigation_id, revision: row.revision, run_id: row.run_id,
        trigger_event_id: row.trigger_event_id, event_type: row.signal, run_goal: row.goal,
        workflow_type: row.workflow_type, status: row.status, investigation_status: row.investigation_status,
        outcome: row.outcome, title: report.title, summary: report.summary,
        observed_failure: report.observed_failure, cause_category: report.likely_cause?.category,
        cause_explanation: report.likely_cause?.explanation, confidence: report.likely_cause?.confidence,
        suggested_next_step: report.suggested_next_step, reproduction_step: report.reproduction_step,
        created_at: row.created_at,
      },
    }; });
  });
  console.log(`Indexed ${events} events and ${investigations} investigations`);
  await db.close();
}

main().catch(error => { console.error(error); process.exitCode = 1; });
