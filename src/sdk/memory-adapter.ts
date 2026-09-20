import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AgentExecution, Event, EventLink, Run } from './types.js';
import type { ArtifactContent, StoreAdapter } from './harness.js';
import { DuplicateEventConflictError, EventLinkUnresolvedError, type LegacyEvent } from './pg-adapter.js';

function roleForAgentId(agentId: string): LegacyEvent['role'] {
  if (agentId === 'observer') return 'observer';
  if (agentId === 'system') return 'system';
  if (agentId.startsWith('worker-') || agentId === 'worker') return 'worker';
  if (agentId === 'crawler') return 'crawler';
  if (agentId === 'orchestrator') return 'orchestrator';
  return 'system';
}

export class MemoryAdapter extends EventEmitter implements StoreAdapter {
  runs = new Map<string, Run>();
  executions = new Map<string, AgentExecution>();
  events = new Map<string, Event>();
  links: EventLink[] = [];
  artifacts = new Map<string, { input: ArtifactContent; sha256: string }>();

  async storeRun(run: Run) { this.runs.set(run.run_id, run); }

  async storeAgentExecution(execution: AgentExecution) {
    if (!this.runs.has(execution.run_id)) throw new Error('run does not exist');
    this.executions.set(execution.agent_execution_id, execution);
  }

  async storeEvent(event: Event) {
    const execution = [...this.executions.values()].find(e =>
      e.run_id === event.run_id && e.agent_execution_id === event.agent_execution_id);
    if (!execution) throw new EventLinkUnresolvedError(
      `Agent execution ${event.agent_execution_id} does not exist in run ${event.run_id}`);
    const existing = this.events.get(event.event_id);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(event)) throw new DuplicateEventConflictError(event.event_id);
      return;
    }
    this.events.set(event.event_id, event);
    this.emit('event', {
      eventId: event.event_id, runId: event.run_id, agentExecutionId: event.agent_execution_id,
      agentId: execution.agent_id, role: roleForAgentId(execution.agent_id), sessionId: event.session_id,
      seq: event.sequence_number, time: event.occurred_at, type: event.event_type, data: event.metadata,
    } satisfies LegacyEvent);
  }

  async storeEventLink(link: EventLink) {
    for (const id of [link.source_event_id, link.target_event_id]) {
      const target = this.events.get(id);
      if (!target || target.run_id !== link.run_id) throw new EventLinkUnresolvedError(
        `Event ${id} does not exist in run ${link.run_id}`);
    }
    if (!this.links.some(l => l.source_event_id === link.source_event_id && l.target_event_id === link.target_event_id
      && l.relationship_type === link.relationship_type)) this.links.push(link);
  }

  async storeArtifactContent(input: ArtifactContent): Promise<string> {
    const artifactId = randomUUID();
    const { createHash } = await import('node:crypto');
    this.artifacts.set(artifactId, { input, sha256: createHash('sha256').update(input.content).digest('hex') });
    return artifactId;
  }

  async readEvents(runId?: string): Promise<LegacyEvent[]> {
    return [...this.events.values()]
      .filter(e => !runId || e.run_id === runId)
      .sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.event_id.localeCompare(b.event_id))
      .map(e => {
        const execution = this.executions.get(e.agent_execution_id)!;
        return {
          eventId: e.event_id, runId: e.run_id, agentExecutionId: e.agent_execution_id,
          agentId: execution.agent_id, role: roleForAgentId(execution.agent_id), sessionId: e.session_id,
          seq: e.sequence_number, time: e.occurred_at, type: e.event_type, data: e.metadata,
        } satisfies LegacyEvent;
      });
  }

  async flush() { /* Writes are awaited eagerly. */ }
  async close() {}
}
