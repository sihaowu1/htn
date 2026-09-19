import { z } from 'zod';

export const actionSchema = z.object({
  kind: z.enum(['click', 'fill', 'select', 'press']),
  selector: z.string().min(1).max(2000), value: z.string().max(2000),
});
export type Action = z.infer<typeof actionSchema>;
export const elementSchema = z.object({
  selector: z.string(), tag: z.string(), type: z.string(), label: z.string(),
  value: z.string().default(''), options: z.array(z.string()).default([]),
});
export type ElementInfo = z.infer<typeof elementSchema>;
export const snapshotSchema = z.object({
  url: z.string().url(), title: z.string().default(''), text: z.string(), dom: z.string().default(''),
  elements: z.array(elementSchema).default([]), fingerprint: z.string().default(''),
  unsupported: z.array(z.string()).default([]),
});
export type Snapshot = z.infer<typeof snapshotSchema>;
export const mapSchema = z.object({
  version: z.literal(1), startUrl: z.string().url(), rootId: z.string(),
  status: z.enum(['complete', 'limited', 'provided']), notes: z.array(z.string()),
  states: z.array(z.object({ id: z.string(), snapshot: snapshotSchema, depth: z.number().int().nonnegative(),
    task: z.string().max(2000).optional() })).min(1).max(500),
  transitions: z.array(z.object({
    id: z.string(), from: z.string(), to: z.string().nullable(),
    actions: z.array(actionSchema).min(1).max(30),
    status: z.enum(['observed', 'unexplored', 'failed', 'unsupported']), reason: z.string(),
  })).max(10000),
});
export type FlowMap = z.infer<typeof mapSchema>;
export type Transition = FlowMap['transitions'][number];
export const planSchema = z.object({
  summary: z.string(), paths: z.array(z.object({
    name: z.string(), transitionIds: z.array(z.string()).max(30),
    instructions: z.string(), stopCondition: z.string(),
  })).max(100), skipped: z.array(z.object({ transitionId: z.string(), reason: z.string() })),
});
export type Plan = z.infer<typeof planSchema>;
export type Task = Plan['paths'][number];
export const decisionSchema = z.object({
  decision: z.enum(['execute', 'success', 'blocked']), reason: z.string(), evidence: z.string(),
});
export const firstPageActionsSchema = z.object({ actions: z.array(actionSchema).min(1).max(5), reason: z.string() });
export const reportSchema = z.object({
  summary: z.string(), findings: z.array(z.object({
    severity: z.enum(['info', 'warning', 'error']),
    description: z.string(), suspectedCause: z.string(), eventIds: z.array(z.number().int()),
  })),
});
export type Report = z.infer<typeof reportSchema> & {
  references?: { eventId: number; agentId: string; sessionId: string | null; type: string }[];
};
export const investigationOutcomeSchema = z.enum([
  'UNRECOVERED_FAILURE', 'RECOVERED_FAILURE', 'NO_FAILURE', 'INSUFFICIENT_EVIDENCE',
]);
export const causeCategorySchema = z.enum([
  'APPLICATION_DEFECT', 'AGENT_MISTAKE', 'STATE_RACE', 'HANDOFF_CORRUPTION', 'EXPECTED_STOP', 'UNKNOWN',
]);
export const investigationReportDraftSchema = z.object({
  summary: z.string().nullable().default(null),
  title: z.string().nullable().default(null),
  impact: z.string().nullable().default(null),
  outcome: investigationOutcomeSchema,
  observed_failure: z.string().nullable(),
  earliest_relevant_event_id: z.string().uuid().nullable(),
  observed_facts: z.array(z.object({
    statement: z.string().min(1), event_ids: z.array(z.string().uuid()).min(1),
  })),
  likely_cause: z.object({
    category: causeCategorySchema, explanation: z.string().min(1),
    confidence: z.enum(['LOW', 'MEDIUM', 'HIGH']),
    supporting_event_ids: z.array(z.string().uuid()),
  }).nullable(),
  related_event_ids: z.array(z.string().uuid()),
  affected_agent_execution_ids: z.array(z.string().uuid()),
  evidence_gaps_and_alternatives: z.array(z.string()),
  suggested_next_step: z.string().min(1),
  reproduction_step: z.string().nullable(),
  artifact_ids: z.array(z.string().uuid()),
  trace_ids: z.array(z.string()),
  recovery_events: z.array(z.string().uuid()).default([]),
  assumption_event_ids: z.array(z.string().uuid()).default([]),
  recommended_owner: z.enum(['application', 'agent', 'infrastructure', 'unknown']).default('unknown'),
});
export type InvestigationReportDraft = z.infer<typeof investigationReportDraftSchema>;
export type InvestigationReport = InvestigationReportDraft & {
  investigation_id: string; run_id: string; trigger_event_id: string; revision: number;
};
export const investigationPayloadSchema = z.object({
  run_id: z.string().uuid(), event_id: z.string().uuid(), goal: z.string(), signal: z.string(),
});
export type InvestigationPayload = z.infer<typeof investigationPayloadSchema>;
export type Identity = {
  runId: string; agentId: string;
  role: 'crawler' | 'orchestrator' | 'worker' | 'observer' | 'system';
  sessionId?: string; agentExecutionId?: string;
};
export type LogEvent = Identity & {
  eventId?: string; seq: number; time: string; type: string; data: unknown;
};
export type SessionInfo = {
  agentId: string; role: string; sessionId: string; liveUrl: string; status: string; instruction?: string;
};
export type ReplayPage = {
  page_id: string; start_time_ms: number; end_time_ms: number; playlist_url: string;
};
export type ReplayResponse =
  | { status: 'available'; session_id: string; pages: ReplayPage[] }
  | { status: 'pending'; retry_after_ms: number };
export type Run = {
  id: string; prompt: string; targetUrl: string; maxWorkers: number;
  status: string; sessions: SessionInfo[]; map?: FlowMap; plan?: Plan;
  findings: Report[]; results: { name: string; status: string; reason: string }[];
};
