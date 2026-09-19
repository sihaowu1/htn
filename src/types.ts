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
export type Identity = { runId: string; agentId: string; role: 'crawler' | 'orchestrator' | 'worker' | 'observer' | 'system'; sessionId?: string };
export type LogEvent = Identity & { seq: number; time: string; type: string; data: unknown };
export type SessionInfo = { agentId: string; role: string; sessionId: string; liveUrl: string; status: string };
export type Run = {
  id: string; prompt: string; targetUrl: string; maxWorkers: number;
  status: string; sessions: SessionInfo[]; map?: FlowMap; plan?: Plan;
  findings: Report[]; results: { name: string; status: string; reason: string }[];
};
