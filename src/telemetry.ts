import * as Sentry from '@sentry/node';
import { nodeProfilingIntegration } from '@sentry/profiling-node';
import { config } from './config.js';

try {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    enabled: !!process.env.SENTRY_DSN,
    environment: config.sentryEnvironment,
    tracesSampleRate: config.sentryTracesSampleRate,
    profileSessionSampleRate: config.sentryProfileSessionSampleRate,
    profileLifecycle: 'trace',
    enableLogs: true,
    sendDefaultPii: false,
    integrations: [
      Sentry.openAIIntegration({ recordInputs: false, recordOutputs: false }),
      nodeProfilingIntegration(),
      ...(config.sentryRuntimeMetricsEnabled ? [Sentry.nodeRuntimeMetricsIntegration()] : []),
    ],
  });
} catch { /* Application startup must not depend on Sentry availability. */ }
export { Sentry };

export async function withSpan<T>(options: Parameters<typeof Sentry.startSpan>[0],
  callback: () => Promise<T> | T): Promise<T> {
  let invoked = false;
  let completed = false;
  let failed = false;
  let value: T;
  let operationError: unknown;
  const invoke = async () => {
    invoked = true;
    try {
      value = await callback();
      completed = true;
      return value;
    } catch (error) {
      failed = true;
      operationError = error;
      throw error;
    }
  };
  try {
    return await Sentry.startSpan(options, invoke);
  } catch (error) {
    if (failed) throw operationError;
    if (completed) return value!;
    if (!invoked) return callback();
    throw error;
  }
}

export async function closeTelemetry(timeoutMs: number): Promise<void> {
  try { await Sentry.close(timeoutMs); } catch { /* Best-effort shutdown flush. */ }
}

export type MetricRecord = {
  kind: 'count' | 'distribution';
  name: string;
  value: number;
  unit?: string;
  attributes: Record<string, string>;
};

type MetricEvent = { event_type: string; metadata: Record<string, unknown> };

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function tokenCounts(usage: unknown): Array<{ direction: 'input' | 'output'; value: number }> {
  if (!usage || typeof usage !== 'object') return [];
  const item = usage as Record<string, unknown>;
  const input = finiteNumber(item.input_tokens ?? item.prompt_tokens);
  const output = finiteNumber(item.output_tokens ?? item.completion_tokens);
  return [
    ...(input === undefined ? [] : [{ direction: 'input' as const, value: input }]),
    ...(output === undefined ? [] : [{ direction: 'output' as const, value: output }]),
  ];
}

export function metricsForModelCall(model: string, api: string, outcome: 'succeeded' | 'failed',
  durationMs: number, usage?: unknown): MetricRecord[] {
  const attributes = { model, api, outcome };
  return [
    { kind: 'count', name: 'htn.model.calls', value: 1, attributes },
    { kind: 'distribution', name: 'htn.model.duration', value: durationMs,
      unit: 'millisecond', attributes },
    ...tokenCounts(usage).map(tokens => ({ kind: 'count' as const, name: 'htn.model.tokens',
      value: tokens.value, unit: 'token', attributes: { model, api, direction: tokens.direction } })),
  ];
}

/** Pure mapping kept separate so its cardinality rules are directly testable. */
export function metricsForEvent(event: MetricEvent, role: string): MetricRecord[] {
  const metadata = event.metadata;
  const records: MetricRecord[] = [{
    kind: 'count', name: 'htn.harness.events', value: 1,
    attributes: { event_type: event.event_type, agent_role: role },
  }];
  if (event.event_type === 'agent.completed') {
    records.push({ kind: 'count', name: 'htn.agent.executions', value: 1,
      attributes: { agent_role: role, outcome: String(metadata.outcome ?? 'unknown') } });
  }
  if (event.event_type === 'worker.failed') {
    records.push({ kind: 'count', name: 'htn.agent.executions', value: 1,
      attributes: { agent_role: role, outcome: 'failed' } });
  }
  if ((event.event_type === 'run.finished' || event.event_type === 'run.failed') && role === 'system') {
    records.push({ kind: 'count', name: 'htn.agent.executions', value: 1,
      attributes: { agent_role: role, outcome: String(metadata.status ??
        (event.event_type === 'run.failed' ? 'failed' : 'completed')) } });
  }
  if ((role === 'crawler' || role === 'orchestrator')
    && (event.event_type === 'tool.completed' || event.event_type === 'tool.failed')) {
    records.push({ kind: 'count', name: 'htn.agent.executions', value: 1,
      attributes: { agent_role: role, outcome: event.event_type === 'tool.completed' ? 'succeeded' : 'failed' } });
  }
  if (event.event_type === 'tool.completed' || event.event_type === 'tool.failed') {
    const attributes = { tool: String(metadata.name ?? 'unknown'),
      outcome: event.event_type === 'tool.completed' ? 'succeeded' : 'failed' };
    records.push({ kind: 'count', name: 'htn.tool.calls', value: 1, attributes });
    const duration = finiteNumber(metadata.duration_ms);
    if (duration !== undefined) records.push({ kind: 'distribution', name: 'htn.tool.duration',
      value: duration, unit: 'millisecond', attributes });
  }
  if (event.event_type === 'model.response' || event.event_type === 'model.failed') {
    const duration = finiteNumber(metadata.duration_ms);
    records.push(...metricsForModelCall(String(metadata.model ?? 'unknown'), String(metadata.api ?? 'unknown'),
      event.event_type === 'model.response' ? 'succeeded' : 'failed', duration ?? 0, metadata.usage));
  }
  if (event.event_type === 'artifact.created') {
    const bytes = finiteNumber(metadata.size_bytes);
    if (bytes !== undefined) records.push({ kind: 'distribution', name: 'htn.artifact.bytes',
      value: bytes, unit: 'byte', attributes: { artifact_kind: String(metadata.kind ?? 'unknown') } });
  }
  return records;
}

type MetricSink = Pick<typeof Sentry.metrics, 'count' | 'distribution'>;

export function emitMetric(record: MetricRecord, sink: MetricSink = Sentry.metrics): void {
  try {
    const options = { attributes: record.attributes, ...(record.unit ? { unit: record.unit } : {}) };
    if (record.kind === 'count') sink.count(record.name, record.value, options);
    else sink.distribution(record.name, record.value, options);
  } catch { /* Telemetry must never affect evidence or agent execution. */ }
}

export function emitMetrics(records: MetricRecord[]): void {
  for (const record of records) emitMetric(record);
}

export function activeTraceContext(): { trace_id?: string; span_id?: string; parent_span_id?: string } {
  try {
    const span = Sentry.getActiveSpan();
    if (!span) return {};
    const json = Sentry.spanToJSON(span);
    return { trace_id: json.trace_id, span_id: json.span_id,
      ...(json.parent_span_id ? { parent_span_id: json.parent_span_id } : {}) };
  } catch { return {}; }
}

const secretKeys = /^(authorization|cookie|password|token|apiKey|connectUrl|liveUrl)$/i;
export function redact(value: unknown): unknown {
  if (typeof value === 'string') {
    let text = value;
    for (const key of ['OPENAI_API_KEY', 'BROWSERBASE_API_KEY', 'SENTRY_DSN']) {
      const secret = process.env[key];
      if (secret) text = text.split(secret).join('[redacted]');
    }
    return text.replace(/(https?:\/\/[^\s"<>]*[?&](?:token|api_key|key|password)=)[^&\s"<>]*/gi, '$1[redacted]');
  }
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, val]) => [key, secretKeys.test(key) ? '[redacted]' : redact(val)]));
  return value;
}
