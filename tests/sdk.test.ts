import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentExecutionContext,
  Harness,
  MetadataTooLargeError,
  PgAdapter,
  RunContext,
  SchemaValidationError,
  EventLinkUnresolvedError,
  DuplicateEventConflictError,
  type AgentExecution,
  type Event,
  type EventLink,
  type Run,
  type StoreAdapter,
} from '../src/sdk/index.js';

class MockAdapter implements StoreAdapter {
  runs = new Map<string, Run>();
  executions = new Map<string, AgentExecution>();
  events = new Map<string, Event>();
  links: EventLink[] = [];
  async storeRun(run: Run) { this.runs.set(run.run_id, run); }
  async storeAgentExecution(execution: AgentExecution) {
    if (!this.runs.has(execution.run_id)) throw new Error('run does not exist');
    this.executions.set(execution.agent_execution_id, execution);
  }
  async storeEvent(event: Event) {
    const key = `${event.run_id}:${event.agent_execution_id}`;
    if (![...this.executions.values()].some(e => `${e.run_id}:${e.agent_execution_id}` === key)) {
      throw new Error('execution does not exist');
    }
    const existing = this.events.get(event.event_id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(event)) throw new DuplicateEventConflictError(event.event_id);
      return;
    }
    this.events.set(event.event_id, event);
  }
  async storeEventLink(link: EventLink) {
    for (const id of [link.source_event_id, link.target_event_id]) {
      const target = this.events.get(id);
      if (!target || target.run_id !== link.run_id) throw new EventLinkUnresolvedError(`Event ${id} does not exist in run ${link.run_id}`);
    }
    if (!this.links.some(l => l.source_event_id === link.source_event_id && l.target_event_id === link.target_event_id
      && l.relationship_type === link.relationship_type)) this.links.push(link);
  }
  async close() {}
  async storeArtifactContent(input: { runId: string; agentExecutionId?: string; kind: string; mimeType: string; content: Buffer }) {
    const id = `artifact-${this.links.length}-${input.content.byteLength}`;
    return id;
  }
  eventsFor(executionId: string): Event[] {
    return [...this.events.values()].filter(e => e.agent_execution_id === executionId).sort((a, b) => a.sequence_number - b.sequence_number);
  }
}

const setup = async () => {
  const adapter = new MockAdapter();
  const harness = new Harness(adapter);
  const run = await harness.start_run({ goal: 'Process invoice #1234' });
  const agent = await harness.register_agent_execution(run, { agent_id: 'invoice-processor', assigned_task: 'Extract line items' });
  return { adapter, harness, run, agent };
};

test('start_run creates a run with generated UUID and persists it', async () => {
  const { adapter, run } = await setup();
  assert.match(run.run_id, /^[0-9a-f-]{36}$/);
  assert.equal(run.goal, 'Process invoice #1234');
  assert.deepEqual(adapter.runs.get(run.run_id), run.toRun());
});

test('register_agent_execution links execution to its run', async () => {
  const { adapter, run, agent } = await setup();
  assert.equal(agent.run_id, run.run_id);
  assert.equal(agent.agent_id, 'invoice-processor');
  assert.deepEqual(adapter.executions.get(agent.agent_execution_id), agent.toExecution());
});

test('emit_event builds a schema-valid envelope with auto-incremented sequence', async () => {
  const { adapter, harness, run, agent } = await setup();
  const first = await harness.emit_event(agent, { event_type: 'check.completed', metadata: { check: 'x', result: 'ok' } });
  const second = await harness.emit_event(agent, { event_type: 'check.completed', metadata: { check: 'y', result: 'ok' } });
  assert.equal(first.sequence_number, 1);
  assert.equal(second.sequence_number, 2);
  assert.equal(first.run_id, run.run_id);
  assert.equal(first.agent_execution_id, agent.agent_execution_id);
  assert.equal(first.schema_version, 1);
  assert.ok(!Number.isNaN(Date.parse(first.occurred_at)));
  assert.deepEqual(adapter.eventsFor(agent.agent_execution_id).map(e => e.event_type), ['check.completed', 'check.completed']);
});

test('parallel agents get independent sequence counters', async () => {
  const { harness, run } = await setup();
  const a = await harness.register_agent_execution(run, { agent_id: 'a' });
  const b = await harness.register_agent_execution(run, { agent_id: 'b' });
  await harness.emit_event(a, { event_type: 'tool.started', metadata: {} });
  await harness.emit_event(b, { event_type: 'tool.started', metadata: {} });
  await harness.emit_event(a, { event_type: 'tool.completed', metadata: {} });
  await harness.emit_event(b, { event_type: 'tool.completed', metadata: {} });
  const seqA = (await harness.emit_event(a, { event_type: 'agent.completed', metadata: {} })).sequence_number;
  const seqB = (await harness.emit_event(b, { event_type: 'agent.completed', metadata: {} })).sequence_number;
  assert.equal(seqA, 3);
  assert.equal(seqB, 3);
});

test('invalid inputs are rejected with SchemaValidationError', async () => {
  const { harness, run, agent } = await setup();
  await assert.rejects(() => harness.start_run({ goal: '   ' }), SchemaValidationError);
  await assert.rejects(() => harness.register_agent_execution(run, { agent_id: '' }), SchemaValidationError);
  await assert.rejects(() => harness.emit_event(agent, { event_type: '', metadata: {} }), SchemaValidationError);
  await assert.rejects(() => harness.record_event_link({
    run_id: run.run_id, source_event_id: agent.agent_execution_id, target_event_id: agent.agent_execution_id, relationship_type: 'retries',
  }), SchemaValidationError);
  await assert.rejects(() => harness.record_event_link({
    run_id: run.run_id, source_event_id: '00000000-0000-4000-8000-000000000001',
    target_event_id: '00000000-0000-4000-8000-000000000002', relationship_type: 'unknown' as never,
  }), SchemaValidationError);
});

test('wrapToolCall preserves return value and emits started/completed/link', async () => {
  const { adapter, harness, agent } = await setup();
  const result = await harness.wrapToolCall(agent, async () => ({ items: 3 }), { name: 'extract', arguments: { id: '1234' } });
  assert.deepEqual(result, { items: 3 });
  const events = adapter.eventsFor(agent.agent_execution_id);
  assert.deepEqual(events.map(e => e.event_type), ['tool.started', 'tool.completed']);
  assert.deepEqual(events[0].metadata, { name: 'extract', arguments: { id: '1234' } });
  assert.deepEqual((events[1].metadata as { result: unknown }).result, { items: 3 });
  assert.ok(typeof (events[1].metadata as { duration_ms: unknown }).duration_ms === 'number');
  assert.equal(adapter.links.length, 1);
  assert.deepEqual(
    [adapter.links[0].source_event_id, adapter.links[0].target_event_id, adapter.links[0].relationship_type],
    [events[1].event_id, events[0].event_id, 'consumes_output'],
  );
});

test('wrapToolCall rethrows the original error and emits tool.failed', async () => {
  const { adapter, harness, agent } = await setup();
  const failure = new Error('button disabled');
  await assert.rejects(() => harness.wrapToolCall(agent, async () => { throw failure; }, { name: 'click' }), (error: unknown) => error === failure);
  const events = adapter.eventsFor(agent.agent_execution_id);
  assert.deepEqual(events.map(e => e.event_type), ['tool.started', 'tool.failed']);
  assert.equal((events[1].metadata as { error: string }).error, 'button disabled');
  assert.equal(adapter.links.length, 1);
});

test('wrapToolCall redacts secrets in stored metadata but not in the return value', async () => {
  const { adapter, harness, agent } = await setup();
  const secret = { password: 'hunter2', rows: [1, 2] };
  const result = await harness.wrapToolCall(agent, async () => secret, { name: 'load', arguments: { token: 'abc123' } });
  assert.equal(result.password, 'hunter2');
  const events = adapter.eventsFor(agent.agent_execution_id);
  assert.deepEqual(events[0].metadata, { name: 'load', arguments: { token: '[redacted]' } });
  assert.deepEqual((events[1].metadata as { result: unknown }).result, { password: '[redacted]', rows: [1, 2] });
});

test('emit_event rejects oversized metadata; wrapToolCall converts large results to artifact references', async () => {
  const { adapter, harness, agent } = await setup();
  const big = 'x'.repeat(40_000);
  await assert.rejects(() => harness.emit_event(agent, { event_type: 'tool.completed', metadata: { blob: big } }), MetadataTooLargeError);
  const result = await harness.wrapToolCall(agent, async () => ({ blob: big }), { name: 'capture' });
  assert.equal((result as { blob: string }).blob, big);
  const events = adapter.eventsFor(agent.agent_execution_id);
  assert.deepEqual(events.map(e => e.event_type), ['tool.started', 'artifact.created', 'tool.completed']);
  const completedMeta = events[2].metadata as { result_ref: string };
  assert.ok(completedMeta.result_ref);
  assert.equal((events[1].metadata as { kind: string }).kind, 'tool-result');
  assert.equal((events[1].metadata as { artifact_id: string }).artifact_id, completedMeta.result_ref);
});

test('record_tool_call, attach_artifact, finish_execution emit expected events', async () => {
  const { adapter, harness, agent } = await setup();
  const { started, finished } = await harness.record_tool_call(agent, { name: 'search', arguments: { q: 'x' }, result: { hits: 2 }, duration_ms: 5 });
  assert.equal(started.event_type, 'tool.started');
  assert.equal(finished.event_type, 'tool.completed');
  const artifact = await harness.attach_artifact(agent, { artifact_id: 'doc_1', kind: 'document', mime_type: 'text/plain' });
  assert.equal(artifact.event_type, 'artifact.created');
  const done = await harness.finish_execution(agent, { outcome: 'succeeded', summary: 'done' });
  assert.equal(done.event_type, 'agent.completed');
  assert.deepEqual(adapter.eventsFor(agent.agent_execution_id).map(e => e.sequence_number), [1, 2, 3, 4]);
  assert.equal(adapter.links.length, 1);
});

test('catalog metadata validation is opt-in and rejects wrong shapes', async () => {
  const { harness, agent } = await setup();
  await assert.rejects(
    () => harness.emit_event(agent, { event_type: 'tool.failed', metadata: { name: 'x' }, validate_metadata: true }),
    SchemaValidationError,
  );
  const ok = await harness.emit_event(agent, { event_type: 'tool.failed', metadata: { name: 'x', error: 'boom' }, validate_metadata: true });
  assert.equal(ok.event_type, 'tool.failed');
});

test('record_event_link rejects links to events outside the run', async () => {
  const { adapter, harness, run, agent } = await setup();
  const other = new AgentExecutionContext('00000000-0000-4000-8000-000000000000', 'ghost');
  const lonely = await harness.emit_event(agent, { event_type: 'agent.started', metadata: {} });
  await assert.rejects(() => adapter.storeEventLink({
    run_id: run.run_id, source_event_id: lonely.event_id, target_event_id: other.agent_execution_id, relationship_type: 'responds_to',
  }), EventLinkUnresolvedError);
});

test('duplicate event_id with different contents is detected', async () => {
  const adapter = new MockAdapter();
  const harness = new Harness(adapter);
  const run = await harness.start_run({ goal: 'retry test' });
  const agent = await harness.register_agent_execution(run, { agent_id: 'r' });
  const event = await harness.emit_event(agent, { event_type: 'check.completed', metadata: { check: 'a' } });
  await adapter.storeEvent(event);
  await assert.rejects(adapter.storeEvent({ ...event, metadata: { check: 'b' } }), DuplicateEventConflictError);
});

test('contexts are independent objects usable without the harness', () => {
  const run = new RunContext('standalone goal');
  const agent = run.registerAgentExecution({ agent_id: 'solo' });
  assert.equal(agent.run_id, run.run_id);
  assert.equal(agent.nextSequence(), 1);
  assert.equal(agent.nextSequence(), 2);
  agent.setSessionId('ext-1');
  assert.equal(agent.getSessionId(), 'ext-1');
});

const pgEnabled = !!process.env.DATABASE_URL;
const pgTest = pgEnabled ? test : test.skip.bind(test);
pgTest('pg adapter persists run, execution, events, links with idempotent retries', async (t) => {
  const adapter = new PgAdapter();
  try {
    await adapter.init();
    const harness = new Harness(adapter);
    const run = await harness.start_run({ goal: 'pg round-trip' });
    const agent = await harness.register_agent_execution(run, { agent_id: 'pg-worker' });
    const first = await harness.emit_event(agent, { event_type: 'agent.started', metadata: {} });
    await adapter.storeEvent(first);
    const second = await harness.emit_event(agent, { event_type: 'agent.completed', metadata: { outcome: 'succeeded' } });
    const link = await harness.record_event_link({
      run_id: run.run_id, source_event_id: second.event_id, target_event_id: first.event_id, relationship_type: 'responds_to',
    });
    assert.equal(link.relationship_type, 'responds_to');
    await adapter.storeEventLink(link);
    await adapter.storeEventLink(link);
  } catch (error) {
    if (/ENOENT|ECONNREFUSED|ENOTFOUND|certificate|SSL|password authentication/i.test(String(error))) {
      t.skip('PostgreSQL is unreachable from this environment: ' + String(error).split('\n')[0]);
      return;
    }
    throw error;
  } finally {
    await adapter.close();
  }
});

test('pg adapter issues the expected SQL against a mock pool', async () => {
  const queries: Array<{ text: string; values: unknown[] }> = [];
  const canned = (text: string) => {
    if (text.includes('FROM agent_executions WHERE run_id')) return { rows: [{ agent_id: 'worker' }], rowCount: 1 };
    if (text.includes('SELECT goal FROM runs')) return { rows: [{ goal: 'g' }], rowCount: 1 };
    if (text.includes('SELECT 1 FROM schema_migrations')) return { rows: [], rowCount: 0 };
    if (text.includes('SELECT event_type, metadata FROM events')) return { rows: [], rowCount: 0 };
    if (text.includes('FROM events e JOIN agent_executions')) {
      return { rows: [{ event_id: 'e1', run_id: 'r1', agent_execution_id: 'a1', agent_id: 'worker',
        role: 'worker', session_id: null, sequence_number: 1, occurred_at: new Date('2026-01-01T00:00:00.000Z'),
        event_type: 'agent.started', metadata: {} }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };
  const client = {
    query: async (text: string, values: unknown[] = []) => {
      queries.push({ text, values });
      return canned(text);
    },
    release: () => {},
  };
  const mockPool = {
    query: async (text: string, values: unknown[] = []) => {
      queries.push({ text, values });
      return canned(text);
    },
    connect: async () => client,
    end: async () => {},
  };
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'sdk-pg-'));
  try {
    const adapter = new PgAdapter('postgres://mock', dir, mockPool as never);
    const harness = new Harness(adapter);
    const run = await harness.start_run({ goal: 'mock pg' });
    const agent = await harness.register_agent_execution(run, { agent_id: 'worker' });
    const first = await harness.emit_event(agent, { event_type: 'agent.started', metadata: {} });
    const second = await harness.emit_event(agent, { event_type: 'agent.completed', metadata: { outcome: 'ok' } });
    await harness.record_event_link({ run_id: run.run_id, source_event_id: second.event_id,
      target_event_id: first.event_id, relationship_type: 'responds_to' });
    const read = await adapter.readEvents(run.run_id);
    assert.equal(read.length, 1);
    assert.equal(read[0].type, 'agent.started');
    assert.equal(read[0].role, 'worker');
    const texts = queries.map(q => q.text);
    assert.ok(texts.some(t => t.includes('INSERT INTO runs')));
    assert.ok(texts.some(t => t.includes('INSERT INTO agent_executions')));
    assert.ok(texts.some(t => t.includes('INSERT INTO events') && t.includes('ON CONFLICT (event_id) DO NOTHING')));
    assert.ok(texts.some(t => t.includes('INSERT INTO event_links')));
    const eventInsert = queries.find(q => q.text.includes('INSERT INTO events'))!;
    assert.deepEqual(eventInsert.values.slice(0, 3), [first.event_id, run.run_id, agent.agent_execution_id]);
    await adapter.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
