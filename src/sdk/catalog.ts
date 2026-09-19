import { z } from 'zod';
import { SchemaValidationError, type metadataSchema } from './types.js';

export const eventTypes = [
  'agent.started',
  'tool.started',
  'tool.completed',
  'tool.failed',
  'artifact.created',
  'handoff.sent',
  'check.completed',
  'check.failed',
  'agent.completed',
] as const;
export type EventType = (typeof eventTypes)[number] | (string & {});

const catalog: Record<string, z.ZodType> = {
  'agent.started': z.object({ assigned_task: z.string().max(8000).optional() }),
  'tool.started': z.object({ name: z.string().min(1), arguments: z.unknown().optional() }),
  'tool.completed': z.object({
    name: z.string().min(1), result: z.unknown().optional(), result_ref: z.string().optional(), duration_ms: z.number().nonnegative().optional(),
  }),
  'tool.failed': z.object({ name: z.string().min(1), error: z.string().min(1), duration_ms: z.number().nonnegative().optional() }),
  'artifact.created': z.object({
    artifact_id: z.string().min(1), kind: z.string().min(1), mime_type: z.string().optional(),
    size_bytes: z.number().int().nonnegative().optional(), digest: z.string().optional(),
  }),
  'handoff.sent': z.object({ target_agent_id: z.string().min(1), summary: z.string().min(1) }),
  'check.completed': z.object({
    check: z.string().min(1), result: z.string().min(1), assessment_source: z.string().optional(), explanation: z.string().optional(),
  }),
  'check.failed': z.object({
    check: z.string().min(1), expected: z.string().min(1), actual: z.string().min(1), explanation: z.string().optional(),
  }),
  'agent.completed': z.object({ outcome: z.string().min(1), summary: z.string().optional() }),
};

export function catalogSchemaFor(eventType: string): z.ZodType | undefined {
  return catalog[eventType];
}

export function validateCatalogMetadata(eventType: string, metadata: z.infer<typeof metadataSchema>): void {
  const schema = catalogSchemaFor(eventType);
  if (!schema) return;
  try {
    schema.parse(metadata);
  } catch (error) {
    if (error instanceof z.ZodError) throw new SchemaValidationError(`Invalid metadata for ${eventType}: ${error.message}`, error.issues);
    throw error;
  }
}
