import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBoolean, parseSampleRate, sentryDefaults } from '../src/config.js';
import { emitMetric, metricsForEvent, Sentry } from '../src/telemetry.js';
import { Harness, MemoryAdapter } from '../src/sdk/index.js';

test('Sentry sampling defaults and explicit configuration are validated', () => {
  assert.deepEqual(sentryDefaults('development'), { tracesSampleRate: 1, profileSessionSampleRate: 1 });
  assert.deepEqual(sentryDefaults('demo'), { tracesSampleRate: 1, profileSessionSampleRate: 1 });
  assert.deepEqual(sentryDefaults('production'), { tracesSampleRate: 0.2, profileSessionSampleRate: 0.1 });
  assert.equal(parseSampleRate('RATE', '0.35', 1), 0.35);
  assert.equal(parseSampleRate('RATE', undefined, 0.2), 0.2);
  for (const value of ['-0.1', '1.1', 'NaN', 'Infinity']) {
    assert.throws(() => parseSampleRate('RATE', value, 1), /Invalid RATE/);
  }
  assert.equal(parseBoolean('FLAG', 'false', true), false);
  assert.equal(parseBoolean('FLAG', '1', false), true);
  assert.throws(() => parseBoolean('FLAG', 'yes', true), /Invalid FLAG/);
});

test('metric mapping emits only catalog names and low-cardinality attributes', () => {
  const records = [
    ...metricsForEvent({ event_type: 'tool.completed', metadata: { name: 'browser.action', duration_ms: 12,
      run_id: 'must-not-leak', url: 'https://secret.example', selector: '#secret' } }, 'worker'),
    ...metricsForEvent({ event_type: 'model.response', metadata: { model: 'gpt-test', api: 'responses', duration_ms: 40,
      usage: { input_tokens: 11, output_tokens: 7 }, error: 'must-not-leak' } }, 'crawler'),
    ...metricsForEvent({ event_type: 'artifact.created', metadata: { kind: 'page-snapshot', size_bytes: 2048 } }, 'worker'),
  ];
  const allowed = new Set(['htn.harness.events', 'htn.tool.calls', 'htn.tool.duration', 'htn.model.calls',
    'htn.model.duration', 'htn.model.tokens', 'htn.artifact.bytes']);
  assert.ok(records.every(record => allowed.has(record.name)));
  assert.ok(records.some(record => record.name === 'htn.model.tokens' && record.attributes.direction === 'input'));
  const attributes = JSON.stringify(records.map(record => record.attributes));
  assert.doesNotMatch(attributes, /must-not-leak|secret\.example|#secret/);
});

test('events inherit active trace IDs and explicit trace IDs take precedence', async () => {
  const adapter = new MemoryAdapter(); const harness = new Harness(adapter);
  const run = await harness.start_run({ goal: 'trace correlation' });
  const agent = await harness.register_agent_execution(run, { agent_id: 'worker-1' });
  await Sentry.startSpan({ name: 'test root', op: 'test' }, async () => {
    const inherited = await harness.emit_event(agent, { event_type: 'check.completed', metadata: {} });
    assert.ok(inherited.trace_id); assert.ok(inherited.span_id);
    const explicit = await harness.emit_event(agent, { event_type: 'check.completed', metadata: {},
      trace_id: 'explicit-trace', span_id: 'explicit-span', parent_span_id: 'explicit-parent' });
    assert.equal(explicit.trace_id, 'explicit-trace');
    assert.equal(explicit.span_id, 'explicit-span');
    assert.equal(explicit.parent_span_id, 'explicit-parent');
  });
});

test('Sentry metric failures do not change persistence or tool behavior', async () => {
  const unavailable = {
    count: () => { throw new Error('Sentry unavailable'); },
    distribution: () => { throw new Error('Sentry unavailable'); },
  } as unknown as Pick<typeof Sentry.metrics, 'count' | 'distribution'>;
  assert.doesNotThrow(() => emitMetric({ kind: 'count', name: 'htn.tool.calls', value: 1,
    attributes: { tool: 'stable-tool', outcome: 'succeeded' } }, unavailable));
  const adapter = new MemoryAdapter(); const harness = new Harness(adapter);
  const run = await harness.start_run({ goal: 'best effort' });
  const agent = await harness.register_agent_execution(run, { agent_id: 'worker-1' });
  assert.equal(await harness.wrapToolCall(agent, async () => 42, { name: 'stable-tool' }), 42);
  const originalError = new Error('original tool failure');
  await assert.rejects(() => harness.wrapToolCall(agent, async () => { throw originalError; },
    { name: 'failing-tool' }), error => error === originalError);
  assert.equal((await adapter.readEvents()).length, 4);
});
