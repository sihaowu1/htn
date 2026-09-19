import { z } from 'zod';
import { inspect, perform } from '../browser.js';
import { config } from '../config.js';
import type { PageFactory } from '../crawler.js';
import { matchesState, taskTransitions } from '../flow.js';
import type { Model } from '../model.js';
import type { Trace } from '../telemetry.js';
import type { Action, FlowMap, Snapshot, Task } from '../types.js';
import type { Page } from 'playwright';

const nodeDecisionSchema = z.object({ decision: z.enum(['execute', 'blocked']), reason: z.string() });

type Helpers = {
  inspect: (page: Page) => Promise<Snapshot>;
  perform: (page: Page, action: Action, trace: Trace, signal: AbortSignal) => Promise<void>;
};

export async function executeNodeSequence(task: Task, map: FlowMap, prompt: string, openPage: PageFactory,
  model: Model, trace: Trace, signal: AbortSignal, onInstruction: (instruction: string) => void = () => {},
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
        await trace.event('worker.blocked', result); return result;
      }
    }
    for (let index = 0; index < transitions.length; index++) {
      signal.throwIfAborted();
      const transition = transitions[index];
      const destination = map.states.find(state => state.id === transition.to)!;
      const instruction = destination.task?.trim() || `Execute transition ${transition.id}`;
      onInstruction(instruction);
      const before = await helpers.inspect(lease.page);
      await trace.event('worker.observation', { snapshot: before, stateId: at });
      const expectedSource = map.states.find(state => state.id === at)!;
      if (!matchesState(expectedSource.snapshot, before)) {
        const result = { name: task.name, status: 'blocked', reason: `Unexpected state before node instruction: ${instruction}` };
        await trace.event('worker.blocked', result); return result;
      }
      await trace.event('worker.node.instruction', { index, total: transitions.length, fromStateId: at,
        toStateId: transition.to, instruction, transitionId: transition.id });
      const decision = await model.call(trace, 'accept_node_instruction', nodeDecisionSchema,
        'You are a browser testing worker receiving exactly one node instruction at a time. Decide whether to execute the supplied validated transition for this instruction. Return execute when the instruction and transition are coherent; return blocked only when the current observation makes the instruction unavailable or unsafe. Do not explore, alter the transition, skip ahead, or evaluate later nodes.',
        { prompt, path: task.name, instruction, currentObservation: before, transition }, signal);
      if (decision.decision === 'blocked') {
        const result = { name: task.name, status: 'blocked', reason: decision.reason };
        await trace.event('worker.blocked', { ...result, instruction, stateId: at }); return result;
      }
      for (const action of transition.actions) {
        signal.throwIfAborted();
        if (++count > maxActions) throw new Error('Worker action limit reached');
        await helpers.perform(lease.page, action, trace, signal);
      }
      const after = await helpers.inspect(lease.page);
      if (!matchesState(destination.snapshot, after)) {
        const result = { name: task.name, status: 'blocked', reason: `Node instruction did not reach its expected state: ${instruction}` };
        await trace.event('worker.blocked', { ...result, instruction, expectedStateId: destination.id, snapshot: after }); return result;
      }
      at = destination.id;
      await trace.event('worker.node.completed', { index, total: transitions.length, stateId: at, instruction, reason: decision.reason });
    }
    const result = { name: task.name, status: 'succeeded', reason: `Completed ${transitions.length} node instruction${transitions.length === 1 ? '' : 's'} in order` };
    await trace.event('worker.success', result); return result;
  } finally {
    onInstruction('');
    await lease.dispose().catch(() => undefined);
  }
}
