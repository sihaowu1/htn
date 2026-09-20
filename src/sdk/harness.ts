import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { validateCatalogMetadata } from './catalog.js';
import { AgentExecutionContext, RunContext } from './context.js';
import { redact } from './redact.js';
import { activeTraceContext, emitMetric, emitMetrics, metricsForEvent, Sentry } from '../telemetry.js';
import {
  attachArtifactInputSchema,
  emitEventInputSchema,
  eventLinkSchema,
  eventSchema,
  finishExecutionInputSchema,
  MetadataTooLargeError,
  recordEventLinkInputSchema,
  recordToolCallInputSchema,
  registerAgentInputSchema,
  SchemaValidationError,
  startRunInputSchema,
  wrapToolCallOptionsSchema,
  type AgentExecution,
  type AttachArtifactInput,
  type EmitEventInput,
  type Event,
  type EventLink,
  type FinishExecutionInput,
  type RecordEventLinkInput,
  type RecordToolCallInput,
  type RegisterAgentInput,
  type Run,
  type StartRunInput,
  type WrapToolCallOptions,
} from './types.js';

export const DEFAULT_MAX_METADATA_BYTES = 32_768;

function roleForAgent(agentId: string): string {
  if (agentId === 'observer') return 'observer';
  if (agentId === 'system') return 'system';
  if (agentId === 'crawler') return 'crawler';
  if (agentId === 'orchestrator') return 'orchestrator';
  if (agentId === 'worker' || agentId.startsWith('worker-')) return 'worker';
  return 'system';
}

export interface ArtifactContent {
  runId: string;
  agentExecutionId?: string;
  kind: string;
  mimeType: string;
  content: Buffer;
}

export interface StoreAdapter {
  storeRun(run: Run): Promise<void>;
  storeAgentExecution(execution: AgentExecution): Promise<void>;
  storeEvent(event: Event): Promise<void>;
  storeEventLink(link: EventLink): Promise<void>;
  storeArtifactContent(input: ArtifactContent): Promise<string>;
  close(): Promise<void>;
}

function parse<T>(schema: z.ZodType<T>, input: unknown, what: string): T {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof z.ZodError) throw new SchemaValidationError(`Invalid ${what}: ${error.message}`, error.issues);
    throw error;
  }
}

export function metadataByteSize(metadata: unknown): number {
  return Buffer.byteLength(JSON.stringify(metadata), 'utf8');
}

export class Harness {
  readonly maxMetadataBytes: number;
  constructor(readonly adapter: StoreAdapter, options?: { maxMetadataBytes?: number }) {
    this.maxMetadataBytes = options?.maxMetadataBytes ?? DEFAULT_MAX_METADATA_BYTES;
  }

  async start_run(raw: StartRunInput): Promise<RunContext> {
    const input = parse(startRunInputSchema, raw, 'start_run input');
    const ctx = new RunContext(input.goal, input.run_id, input.workflow_type, input.tags);
    await this.adapter.storeRun(ctx.toRun());
    return ctx;
  }

  async register_agent_execution(ctx: RunContext, raw: RegisterAgentInput): Promise<AgentExecutionContext> {
    const input = parse(registerAgentInputSchema, raw, 'register_agent_execution input');
    const agentCtx = ctx.registerAgentExecution(input);
    await this.adapter.storeAgentExecution(agentCtx.toExecution());
    return agentCtx;
  }

  private buildEvent(agentCtx: AgentExecutionContext, eventType: string, metadata: Record<string, unknown>,
    opts?: { session_id?: string; trace_id?: string; span_id?: string; parent_span_id?: string }): Event {
    const limit = this.maxMetadataBytes;
    const redacted = redact(metadata) as Record<string, unknown>;
    const size = metadataByteSize(redacted);
    if (size > limit) throw new MetadataTooLargeError(size, limit);
    const now = new Date().toISOString();
    const active = activeTraceContext();
    const traceId = opts?.trace_id ?? active.trace_id;
    const spanId = opts?.span_id ?? active.span_id;
    const parentSpanId = opts?.parent_span_id ?? active.parent_span_id;
    return parse(eventSchema, {
      event_id: randomUUID(),
      run_id: agentCtx.run_id,
      agent_execution_id: agentCtx.agent_execution_id,
      ...(opts?.session_id ?? agentCtx.getSessionId() ? { session_id: opts?.session_id ?? agentCtx.getSessionId() } : {}),
      occurred_at: now,
      sequence_number: agentCtx.nextSequence(),
      event_type: eventType,
      ...(traceId ? { trace_id: traceId } : {}),
      ...(spanId ? { span_id: spanId } : {}),
      ...(parentSpanId ? { parent_span_id: parentSpanId } : {}),
      metadata: redacted,
      schema_version: 1,
    }, 'event envelope');
  }

  private async persist(agentCtx: AgentExecutionContext, event: Event): Promise<Event> {
    const begun = performance.now();
    try {
      await this.adapter.storeEvent(event);
    } catch (error) {
      emitMetric({ kind: 'distribution', name: 'htn.harness.persist.duration',
        value: performance.now() - begun, unit: 'millisecond',
        attributes: { agent_role: roleForAgent(agentCtx.agent_id), outcome: 'failed' } });
      throw error;
    }
    try {
      emitMetric({ kind: 'distribution', name: 'htn.harness.persist.duration',
        value: performance.now() - begun, unit: 'millisecond',
        attributes: { agent_role: roleForAgent(agentCtx.agent_id), outcome: 'succeeded' } });
      emitMetrics(metricsForEvent(event, roleForAgent(agentCtx.agent_id)));
      Sentry.withScope(scope => {
        scope.setTags({ runId: agentCtx.run_id, agentId: agentCtx.agent_id,
          agentExecutionId: agentCtx.agent_execution_id, sessionId: agentCtx.getSessionId() || 'none' });
        Sentry.logger.info(event.event_type, { run_id: agentCtx.run_id, agent_id: agentCtx.agent_id,
          agent_execution_id: agentCtx.agent_execution_id, event_id: event.event_id,
          sequence_number: event.sequence_number, payload: JSON.stringify(event.metadata) });
        if (/error|failed|failure/.test(event.event_type)) {
          Sentry.captureException(new Error(event.event_type), { extra: { event } });
        }
      });
    } catch { /* Evidence persistence does not depend on Sentry availability. */ }
    return event;
  }

  async emit_event(agentCtx: AgentExecutionContext, raw: EmitEventInput): Promise<Event> {
    const input = parse(emitEventInputSchema, raw, 'emit_event input');
    if (input.validate_metadata) validateCatalogMetadata(input.event_type, input.metadata);
    const event = this.buildEvent(agentCtx, input.event_type, input.metadata, input);
    return this.persist(agentCtx, event);
  }

  async record_tool_call(agentCtx: AgentExecutionContext, raw: RecordToolCallInput): Promise<{ started: Event; finished: Event }> {
    const input = parse(recordToolCallInputSchema, raw, 'record_tool_call input');
    const started = this.buildEvent(agentCtx, 'tool.started', { name: input.name, ...(input.arguments !== undefined ? { arguments: input.arguments } : {}) });
    await this.persist(agentCtx, started);
    const finishedType = input.error !== undefined ? 'tool.failed' : 'tool.completed';
    const finished = this.buildEvent(agentCtx, finishedType, {
      name: input.name,
      ...(input.result !== undefined ? { result: input.result } : {}),
      ...(input.error !== undefined ? { error: typeof input.error === 'string' ? input.error : JSON.stringify(input.error) } : {}),
      ...(input.duration_ms !== undefined ? { duration_ms: input.duration_ms } : {}),
    });
    await this.persist(agentCtx, finished);
    await this.record_event_link({ run_id: agentCtx.run_id, source_event_id: finished.event_id, target_event_id: started.event_id, relationship_type: 'consumes_output' });
    return { started, finished };
  }

  async wrapToolCall<T>(agentCtx: AgentExecutionContext, fn: () => Promise<T>, raw: WrapToolCallOptions): Promise<T> {
    const opts = parse(wrapToolCallOptionsSchema, raw, 'wrapToolCall options');
    const started = this.buildEvent(agentCtx, 'tool.started', {
      name: opts.name,
      ...(opts.arguments !== undefined ? { arguments: opts.arguments } : {}),
    });
    await this.persist(agentCtx, started);
    const begun = Date.now();
    try {
      const result = await fn();
      const duration_ms = Date.now() - begun;
      const finished = await this.finishToolCall(agentCtx, opts.name, duration_ms, { result });
      await this.record_event_link({ run_id: agentCtx.run_id, source_event_id: finished.event_id, target_event_id: started.event_id, relationship_type: 'consumes_output' });
      return result;
    } catch (error) {
      const duration_ms = Date.now() - begun;
      const finished = await this.finishToolCall(agentCtx, opts.name, duration_ms, {}, error);
      await this.record_event_link({ run_id: agentCtx.run_id, source_event_id: finished.event_id, target_event_id: started.event_id, relationship_type: 'consumes_output' });
      throw error;
    }
  }

  private async finishToolCall(agentCtx: AgentExecutionContext, name: string, duration_ms: number,
    outcome: { result?: unknown }, error?: unknown): Promise<Event> {
    if (error !== undefined) {
      const failed = this.buildEvent(agentCtx, 'tool.failed', {
        name, error: error instanceof Error ? error.message : String(error), duration_ms,
      });
      await this.persist(agentCtx, failed);
      return failed;
    }
    const limit = this.maxMetadataBytes;
    const safeResult = redact(outcome.result);
    const resultSize = metadataByteSize({ result: safeResult });
    if (resultSize > limit) {
      const content = Buffer.from(JSON.stringify(safeResult ?? null), 'utf8');
      const artifactId = await this.adapter.storeArtifactContent({ runId: agentCtx.run_id,
        agentExecutionId: agentCtx.agent_execution_id, kind: 'tool-result',
        mimeType: 'application/json', content });
      const artifact = this.buildEvent(agentCtx, 'artifact.created', {
        artifact_id: artifactId, kind: 'tool-result', mime_type: 'application/json', size_bytes: content.byteLength,
      });
      await this.persist(agentCtx, artifact);
      const completed = this.buildEvent(agentCtx, 'tool.completed', {
        name, result_ref: artifactId, duration_ms,
        note: `Result exceeded the ${limit} byte metadata limit and was recorded as an artifact reference.`,
      });
      await this.persist(agentCtx, completed);
      return completed;
    }
    const completed = this.buildEvent(agentCtx, 'tool.completed', { name, result: safeResult, duration_ms });
    await this.persist(agentCtx, completed);
    return completed;
  }

  async record_event_link(raw: RecordEventLinkInput): Promise<EventLink> {
    const input = parse(recordEventLinkInputSchema, raw, 'record_event_link input');
    const link = parse(eventLinkSchema, input, 'event link');
    await this.adapter.storeEventLink(link);
    return link;
  }

  async attach_artifact(agentCtx: AgentExecutionContext, raw: AttachArtifactInput): Promise<Event> {
    const input = parse(attachArtifactInputSchema, raw, 'attach_artifact input');
    const event = this.buildEvent(agentCtx, 'artifact.created', { ...input });
    await this.persist(agentCtx, event);
    return event;
  }

  async store_payload(agentCtx: AgentExecutionContext, input: { kind: string; value: unknown; mimeType?: string }):
    Promise<{ artifact_id: string; size_bytes: number }> {
    const content = Buffer.from(JSON.stringify(input.value ?? null), 'utf8');
    const artifact_id = await this.adapter.storeArtifactContent({ runId: agentCtx.run_id,
      agentExecutionId: agentCtx.agent_execution_id, kind: input.kind,
      mimeType: input.mimeType ?? 'application/json', content });
    emitMetric({ kind: 'distribution', name: 'htn.artifact.bytes', value: content.byteLength,
      unit: 'byte', attributes: { artifact_kind: input.kind } });
    return { artifact_id, size_bytes: content.byteLength };
  }

  async finish_execution(agentCtx: AgentExecutionContext, raw: FinishExecutionInput): Promise<Event> {
    const input = parse(finishExecutionInputSchema, raw, 'finish_execution input');
    const event = this.buildEvent(agentCtx, 'agent.completed', { ...input });
    await this.persist(agentCtx, event);
    return event;
  }
}
