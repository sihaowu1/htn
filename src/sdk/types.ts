import { z } from 'zod';

export class SchemaValidationError extends Error {
  constructor(message: string, readonly issues: unknown) {
    super(message);
    this.name = 'SchemaValidationError';
  }
}

export class MetadataTooLargeError extends Error {
  constructor(readonly sizeBytes: number, readonly limitBytes: number) {
    super(`Metadata is ${sizeBytes} bytes, exceeding the ${limitBytes} byte limit. Use attach_artifact for large payloads.`);
    this.name = 'MetadataTooLargeError';
  }
}


export const uuidSchema = z.string().uuid();
export const isoTimeSchema = z.string().datetime({ offset: true });

export const runSchema = z.object({
  run_id: uuidSchema,
  goal: z.string().min(1).max(8000),
  created_at: isoTimeSchema,
});
export type Run = z.infer<typeof runSchema>;

export const agentExecutionSchema = z.object({
  agent_execution_id: uuidSchema,
  run_id: uuidSchema,
  agent_id: z.string().min(1).max(500),
  assigned_task: z.string().max(8000).optional(),
  created_at: isoTimeSchema,
});
export type AgentExecution = z.infer<typeof agentExecutionSchema>;

export const eventTypeSchema = z.string().trim().min(1).max(200);
export const metadataSchema = z.record(z.string(), z.unknown());
export const schemaVersionSchema = z.number().int().positive();

export const eventSchema = z.object({
  event_id: uuidSchema,
  run_id: uuidSchema,
  agent_execution_id: uuidSchema,
  session_id: z.string().max(500).optional(),
  occurred_at: isoTimeSchema,
  // Set by the database on receipt (clock_timestamp() default). Producer-built
  // envelopes omit it; it is present on rows read back from the store.
  ingested_at: isoTimeSchema.optional(),
  sequence_number: z.number().int().nonnegative(),
  event_type: eventTypeSchema,
  trace_id: z.string().max(500).optional(),
  span_id: z.string().max(500).optional(),
  parent_span_id: z.string().max(500).optional(),
  metadata: metadataSchema,
  schema_version: schemaVersionSchema,
});
export type Event = z.infer<typeof eventSchema>;

export const relationshipTypeSchema = z.enum(['consumes_output', 'responds_to', 'retries']);
export type RelationshipType = z.infer<typeof relationshipTypeSchema>;

export const eventLinkSchema = z.object({
  run_id: uuidSchema,
  source_event_id: uuidSchema,
  target_event_id: uuidSchema,
  relationship_type: relationshipTypeSchema,
}).refine(link => link.source_event_id !== link.target_event_id, { message: 'Self-links are rejected' });
export type EventLink = z.infer<typeof eventLinkSchema>;

export const startRunInputSchema = z.object({ goal: z.string().trim().min(1).max(8000) });
export type StartRunInput = z.infer<typeof startRunInputSchema>;

export const registerAgentInputSchema = z.object({
  agent_id: z.string().trim().min(1).max(500),
  assigned_task: z.string().max(8000).optional(),
});
export type RegisterAgentInput = z.infer<typeof registerAgentInputSchema>;

export const emitEventInputSchema = z.object({
  event_type: eventTypeSchema,
  metadata: metadataSchema.default({}),
  session_id: z.string().max(500).optional(),
  trace_id: z.string().max(500).optional(),
  span_id: z.string().max(500).optional(),
  parent_span_id: z.string().max(500).optional(),
  validate_metadata: z.boolean().default(false),
});
export type EmitEventInput = z.infer<typeof emitEventInputSchema>;

export const recordToolCallInputSchema = z.object({
  name: z.string().trim().min(1).max(500),
  arguments: z.unknown().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
  duration_ms: z.number().nonnegative().optional(),
});
export type RecordToolCallInput = z.infer<typeof recordToolCallInputSchema>;

export const recordEventLinkInputSchema = z.object({
  run_id: uuidSchema,
  source_event_id: uuidSchema,
  target_event_id: uuidSchema,
  relationship_type: relationshipTypeSchema,
}).refine(link => link.source_event_id !== link.target_event_id, { message: 'Self-links are rejected' });
export type RecordEventLinkInput = z.infer<typeof recordEventLinkInputSchema>;

export const attachArtifactInputSchema = z.object({
  artifact_id: z.string().trim().min(1).max(500),
  kind: z.string().trim().min(1).max(200),
  mime_type: z.string().max(200).optional(),
  size_bytes: z.number().int().nonnegative().optional(),
  digest: z.string().max(500).optional(),
});
export type AttachArtifactInput = z.infer<typeof attachArtifactInputSchema>;

export const finishExecutionInputSchema = z.object({
  outcome: z.string().trim().min(1).max(200),
  summary: z.string().max(8000).optional(),
});
export type FinishExecutionInput = z.infer<typeof finishExecutionInputSchema>;

export const wrapToolCallOptionsSchema = z.object({
  name: z.string().trim().min(1).max(500),
  arguments: z.unknown().optional(),
  max_metadata_bytes: z.number().int().positive().optional(),
});
export type WrapToolCallOptions = z.infer<typeof wrapToolCallOptionsSchema>;
