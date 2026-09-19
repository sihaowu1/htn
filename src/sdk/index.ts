export { Harness, DEFAULT_MAX_METADATA_BYTES, metadataByteSize } from './harness.js';
export type { ArtifactContent, StoreAdapter } from './harness.js';
export { MemoryAdapter } from './memory-adapter.js';
export { PgAdapter, DuplicateEventConflictError, EventLinkUnresolvedError,
  enqueueInvestigationForEvent, failureFingerprint, failureSignal } from './pg-adapter.js';
export type { InvestigationJob, LegacyEvent } from './pg-adapter.js';
export { AgentExecutionContext, RunContext } from './context.js';
export { catalogSchemaFor, eventTypes, validateCatalogMetadata } from './catalog.js';
export { redact } from './redact.js';
export { MetadataTooLargeError, SchemaValidationError } from './types.js';
export type {
  AgentExecution,  AttachArtifactInput,
  EmitEventInput,
  Event,
  EventLink,
  FinishExecutionInput,
  RecordEventLinkInput,
  RecordToolCallInput,
  RegisterAgentInput,
  RelationshipType,
  Run,
  StartRunInput,
  WrapToolCallOptions,
} from './types.js';
