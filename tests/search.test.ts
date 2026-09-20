import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { EvidenceTools } from '../src/evidence-tools.js';
import { searchableMetadata, type SearchService } from '../src/search.js';

test('search metadata excludes secrets, base64, and oversized values', () => {
  const encoded = 'A'.repeat(600);
  const result = searchableMetadata({ error: 'Checkout returned 500', password: 'do-not-index',
    nested: { authorization: 'Bearer secret', message: 'request failed' }, encoded,
    long: 'x'.repeat(20_000) });
  assert.match(result.metadata_text, /Checkout returned 500/);
  assert.match(result.metadata_text, /request failed/);
  assert.doesNotMatch(result.metadata_text, /do-not-index|Bearer secret/);
  assert.ok(!result.metadata_text.includes(encoded));
  assert.ok(result.metadata_text.length <= 8_000);
  assert.equal(result.fields.error, 'Checkout returned 500');
});

test('run evidence search enforces scope, hydrates hits, and drops stale results', async () => {
  const runId = randomUUID();
  const eventId = randomUUID();
  const staleId = randomUUID();
  const search = {
    available: true,
    searchRunEvidence: async (input: any) => {
      assert.equal(input.runId, runId);
      return { total: 2, hits: [
        { id: eventId, score: 3, highlights: ['checkout failed'], source: {} },
        { id: staleId, score: 2, highlights: ['stale'], source: {} },
      ] };
    },
  } as SearchService;
  const db = { hydrateEventSearchHits: async (scope: string, hits: any[]) => {
    assert.equal(scope, runId);
    assert.equal(hits.length, 2);
    return [{ event_id: eventId, agent_execution_id: randomUUID(), agent_id: 'worker',
      event_type: 'tool.failed', occurred_at: new Date().toISOString(), search_score: 3,
      search_highlights: ['checkout failed'] }];
  } };
  const tools = new EvidenceTools(db as any, runId, { maxCalls: 5, maxEvents: 5, maxArtifactBytes: 1 }, search);
  const result: any = await tools.searchRunEvidence({ runId, query: 'checkout', limit: 10 });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].event_id, eventId);
  await assert.rejects(() => tools.searchRunEvidence({ runId: randomUUID(), query: 'checkout', limit: 10 }),
    /outside the investigation run/);
});

test('similar incidents are explicitly historical and exclude the active run', async () => {
  const runId = randomUUID();
  const historicalRun = randomUUID();
  const investigationId = randomUUID();
  const search = {
    available: true,
    findSimilarIncidents: async (input: any) => {
      assert.equal(input.runId, runId);
      return { total: 1, hits: [{ id: `${investigationId}:1`, score: 4, highlights: ['same error'],
        source: { run_id: historicalRun, investigation_id: investigationId, event_type: 'tool.failed',
          outcome: 'UNRECOVERED_FAILURE', cause_category: 'APPLICATION_DEFECT', confidence: 'HIGH', summary: 'Known defect' } }] };
    },
  } as SearchService;
  const tools = new EvidenceTools({} as any, runId, { maxCalls: 5, maxEvents: 5, maxArtifactBytes: 1 }, search);
  const result: any = await tools.findSimilarIncidents({ query: 'same error', limit: 5 });
  assert.equal(result.historical_context_only, true);
  assert.equal(result.matches[0].run_id, historicalRun);
  assert.notEqual(result.matches[0].run_id, runId);
});
