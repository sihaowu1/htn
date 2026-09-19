import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { failureFingerprint, failureSignal } from '../src/database.js';
import { investigationReportDraftSchema } from '../src/types.js';
import { InvestigationAgent } from '../src/investigation.js';

test('detector selects deterministic failure and completion signals', () => {
  assert.equal(failureSignal('tool.failed', { error: 'HTTP 500' }), 'tool.failed');
  assert.equal(failureSignal('tool.completed', {}), null);
  assert.equal(failureSignal('check.completed', { status: 'failed' }), 'check.completed');
  assert.equal(failureSignal('run.finished', { status: 'succeeded' }), 'RUN_COMPLETION');
});

test('fingerprints deduplicate unstable IDs while separating operations and runs', () => {
  const one = failureFingerprint('run-a', 'tool.failed', { tool: 'checkout', error: `request ${randomUUID()} returned 500` });
  const two = failureFingerprint('run-a', 'tool.failed', { tool: 'checkout', error: `request ${randomUUID()} returned 500` });
  assert.equal(one, two);
  assert.notEqual(one, failureFingerprint('run-a', 'tool.failed', { tool: 'search', error: 'request id returned 500' }));
  assert.notEqual(one, failureFingerprint('run-b', 'tool.failed', { tool: 'checkout', error: 'request id returned 500' }));
});

test('structured investigation report keeps facts and hypotheses distinct', () => {
  const eventId = randomUUID();
  const report = investigationReportDraftSchema.parse({
    outcome: 'UNRECOVERED_FAILURE', observed_failure: 'Checkout returned 500',
    earliest_relevant_event_id: eventId,
    observed_facts: [{ statement: 'The checkout tool returned HTTP 500.', event_ids: [eventId] }],
    likely_cause: { category: 'APPLICATION_DEFECT', explanation: 'The application rejected checkout.',
      confidence: 'MEDIUM', supporting_event_ids: [eventId] },
    related_event_ids: [eventId], affected_agent_execution_ids: [],
    evidence_gaps_and_alternatives: ['Database metrics were unavailable.'],
    suggested_next_step: 'Inspect the correlated backend trace.', reproduction_step: null,
    artifact_ids: [], trace_ids: [],
  });
  assert.equal(report.observed_facts.length, 1);
  assert.equal(report.likely_cause?.confidence, 'MEDIUM');
  assert.throws(() => investigationReportDraftSchema.parse({ ...report,
    observed_facts: [{ statement: 'Unsupported', event_ids: [] }] }));
});

test('investigation agent queries scoped evidence before submitting a report', async () => {
  const runId = randomUUID();
  const eventId = randomUUID();
  const executionId = randomUUID();
  const calls: string[] = [];
  const tools = { execute: async (name: string) => { calls.push(name); return { run_id: runId, goal: 'Checkout' }; } };
  const responses = [
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'one', type: 'function',
      function: { name: 'get_run_summary', arguments: JSON.stringify({ run_id: runId }) } }] } }] },
    { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'two', type: 'function',
      function: { name: 'submit_investigation_report', arguments: JSON.stringify({
        outcome: 'UNRECOVERED_FAILURE', observed_failure: 'Checkout failed', earliest_relevant_event_id: eventId,
        observed_facts: [{ statement: 'The triggering event failed.', event_ids: [eventId] }],
        likely_cause: null, related_event_ids: [eventId], affected_agent_execution_ids: [executionId],
        evidence_gaps_and_alternatives: ['No backend trace was available.'], suggested_next_step: 'Inspect the service.',
        reproduction_step: null, artifact_ids: [], trace_ids: [],
      }) } }] } }] },
  ];
  const client = { chat: { completions: { create: async () => responses.shift() } } };
  const report = await new InvestigationAgent(tools as any, 'test-model', client as any).run({
    run_id: runId, event_id: eventId, goal: 'Checkout', signal: 'tool.failed',
  }, new AbortController().signal);
  assert.deepEqual(calls, ['get_run_summary']);
  assert.equal(report.outcome, 'UNRECOVERED_FAILURE');
});
