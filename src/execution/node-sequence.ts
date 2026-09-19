import { z } from 'zod';
import { inspect, perform } from '../browser.js';
import { config } from '../config.js';
import type { PageFactory } from '../crawler.js';
import { matchesState, reachesGoal, taskTransitions } from '../flow.js';
import type { Model } from '../model.js';
import type { AgentExecutionContext, Harness } from '../sdk/index.js';
import type { Action, FlowMap, Snapshot, Task } from '../types.js';
import type { Page } from 'playwright';

const nodeDecisionSchema = z.object({ decision: z.enum(['execute', 'blocked']), reason: z.string() });

type Helpers = {
  inspect: (page: Page) => Promise<Snapshot>;
  perform: (page: Page, action: Action, harness: Harness, agent: AgentExecutionContext, signal: AbortSignal) => Promise<void>;
};

async function emitObservation(harness: Harness, agent: AgentExecutionContext, stateId: string, snapshot: Snapshot) {
  try {
    await harness.emit_event(agent, { event_type: 'worker.observation', metadata: { snapshot, stateId } });
  } catch (error) {
    if (!(error instanceof Error) || error.name !== 'MetadataTooLargeError') throw error;
    const { artifact_id: snapshotRef, size_bytes: snapshotBytes } = await harness.store_payload(agent,
      { kind: 'page-snapshot', value: snapshot });
    await harness.emit_event(agent, { event_type: 'worker.observation', metadata: { stateId,
      snapshot_ref: snapshotRef, snapshot_bytes: snapshotBytes, url: snapshot.url, title: snapshot.title,
      fingerprint: snapshot.fingerprint, text_length: snapshot.text.length, element_count: snapshot.elements.length } });
  }
}

export async function executeNodeSequence(task: Task, map: FlowMap, prompt: string, openPage: PageFactory,
  model: Model, harness: Harness, agent: AgentExecutionContext, signal: AbortSignal, onInstruction: (instruction: string) => void = () => {},
  maxActions = config.maxActions, helpers: Helpers = { inspect, perform }) {
  const transitions = taskTransitions(map, task);
  const lease = await openPage(map.startUrl);
  let count = 0;
  let at = map.rootId;
  try {
    if (!transitions.length) {
      const snapshot = await helpers.inspect(lease.page);
      const expected = map.states.find(state => state.id === at)!;
      if (!matchesState(expected.snapshot, snapshot)) {
        const result = { name: task.name, status: 'blocked', reason: 'Unexpected front-page state' };
        await harness.emit_event(agent, { event_type: 'worker.blocked', metadata: result }); return result;
      }
    }
    for (let index = 0; index < transitions.length; index++) {
      signal.throwIfAborted();
      const transition = transitions[index];
      const destination = map.states.find(state => state.id === transition.to)!;
      const instruction = destination.task?.trim() || `Execute transition ${transition.id}`;
      onInstruction(instruction);
      const before = await helpers.inspect(lease.page);
      await emitObservation(harness, agent, at, before);
      const expectedSource = map.states.find(state => state.id === at)!;
      if (!matchesState(expectedSource.snapshot, before)) {
        const result = { name: task.name, status: 'blocked', reason: `Unexpected state before node instruction: ${instruction}` };
        await harness.emit_event(agent, { event_type: 'worker.blocked', metadata: result }); return result;
      }
      await harness.emit_event(agent, { event_type: 'worker.node.instruction', metadata: { index, total: transitions.length, fromStateId: at,
        toStateId: transition.to, instruction, transitionId: transition.id } });
      const decision = await model.call(harness, agent, 'accept_node_instruction', nodeDecisionSchema,
        'You are a browser testing worker receiving exactly one node instruction at a time. Decide whether to execute the supplied validated transition for this instruction. Return execute when the instruction and transition are coherent; return blocked only when the current observation makes the instruction unavailable or unsafe. Do not explore, alter the transition, skip ahead, or evaluate later nodes.',
        { prompt, path: task.name, instruction, currentObservation: before, transition }, signal);
      if (decision.decision === 'blocked') {
        const result = { name: task.name, status: 'blocked', reason: decision.reason };
        await harness.emit_event(agent, { event_type: 'worker.blocked', metadata: { ...result, instruction, stateId: at } }); return result;
      }
      for (const action of transition.actions) {
        signal.throwIfAborted();
        if (++count > maxActions) throw new Error('Worker action limit reached');
        await helpers.perform(lease.page, action, harness, agent, signal);
      }
      const after = await helpers.inspect(lease.page);
      if (!matchesState(destination.snapshot, after)) {
        const result = { name: task.name, status: 'blocked', reason: `Node instruction did not reach its expected state: ${instruction}` };
        await harness.emit_event(agent, { event_type: 'worker.blocked', metadata: { ...result, instruction, expectedStateId: destination.id } });
        await emitObservation(harness, agent, at, after);
        return result;
      }
      at = destination.id;
      await harness.emit_event(agent, { event_type: 'worker.node.completed', metadata: { index, total: transitions.length, stateId: at, instruction, reason: decision.reason } });
    }
    const finalState = map.states.find(state => state.id === at)!;
    if (!reachesGoal(prompt, finalState.snapshot)) {
      const result = { name: task.name, status: 'incomplete', reason: `Completed ${transitions.length} node instruction${transitions.length === 1 ? '' : 's'} but the final state ${finalState.snapshot.url} does not reach the goal` };
      await harness.emit_event(agent, { event_type: 'worker.incomplete', metadata: { ...result, stateId: at } }); return result;
    }
    const result = { name: task.name, status: 'succeeded', reason: `Completed ${transitions.length} node instruction${transitions.length === 1 ? '' : 's'} in order` };
    await harness.emit_event(agent, { event_type: 'worker.success', metadata: result }); return result;
  } finally {
    onInstruction('');
    await lease.dispose().catch(() => undefined);
  }
}
