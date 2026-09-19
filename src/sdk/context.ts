import { randomUUID } from 'node:crypto';
import type { AgentExecution, RegisterAgentInput, Run } from './types.js';

export class RunContext {
  readonly run_id: string;
  readonly goal: string;
  readonly created_at: string;
  constructor(goal: string, runId: string = randomUUID()) {
    this.run_id = runId;
    this.goal = goal;
    this.created_at = new Date().toISOString();
  }
  registerAgentExecution(input: RegisterAgentInput): AgentExecutionContext {
    return new AgentExecutionContext(this.run_id, input.agent_id, input.assigned_task);
  }
  toRun(): Run {
    return { run_id: this.run_id, goal: this.goal, created_at: this.created_at };
  }
}

export class AgentExecutionContext {
  readonly agent_execution_id: string;
  readonly run_id: string;
  readonly agent_id: string;
  readonly assigned_task?: string;
  readonly created_at: string;
  private sequenceCounter = 0;
  private sessionId?: string;
  constructor(runId: string, agentId: string, assignedTask?: string) {
    this.agent_execution_id = randomUUID();
    this.run_id = runId;
    this.agent_id = agentId;
    this.assigned_task = assignedTask;
    this.created_at = new Date().toISOString();
  }
  nextSequence(): number {
    return ++this.sequenceCounter;
  }
  setSessionId(sessionId: string): void {
    this.sessionId = sessionId;
  }
  getSessionId(): string | undefined {
    return this.sessionId;
  }
  toExecution(): AgentExecution {
    return {
      agent_execution_id: this.agent_execution_id,
      run_id: this.run_id,
      agent_id: this.agent_id,
      ...(this.assigned_task !== undefined ? { assigned_task: this.assigned_task } : {}),
      created_at: this.created_at,
    };
  }
}
