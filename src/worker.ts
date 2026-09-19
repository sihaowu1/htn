import { inspect, perform } from './browser.js';
import { matchesState, taskTransitions } from './flow.js';
import { decisionSchema, firstPageActionsSchema, type Action, type FlowMap, type Snapshot, type Task } from './types.js';
import type { PageFactory } from './crawler.js';
import type { Model } from './model.js';
import type { AgentExecutionContext, Harness } from './sdk/index.js';
import { config } from './config.js';
import type { Page } from 'playwright';

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

export function validateSingleAction(snapshot: Snapshot, action: Action) {
  const element = snapshot.elements.find(candidate => candidate.selector === action.selector);
  if (!element) throw new Error('Model selected an action target that is not present in the current page observation');
  if (action.kind === 'fill' && !['input', 'textarea'].includes(element.tag)) throw new Error('Fill action requires an input or textarea');
  if (action.kind === 'select' && element.tag !== 'select') throw new Error('Select action requires a select element');
  return action;
}

/** Complete one simple task on the current page with one fully awaited model step. */
export async function completeSimpleActionOnCurrentPage(task: string, page: Page,
  model: Model, harness: Harness, agent: AgentExecutionContext, signal: AbortSignal) {
  signal.throwIfAborted();
  const snapshot = await inspect(page);
  await emitObservation(harness, agent, 'current', snapshot);
  const selection = await model.call(harness, agent, 'choose_current_page_actions', firstPageActionsSchema,
    'You are a browser testing worker completing one simple task on the current page. Return the shortest sequence of at most five browser operations needed to perform it, using only visible actionable elements in the supplied current-page observation and copying every selector verbatim. A single user-level task may require multiple operations, such as filling a search field and clicking its submit button. Use click for links/buttons, fill for text fields, select for select elements, or press only for a supported key. Do not explore, add unrelated operations, or continue beyond the requested task.',
    { task, snapshot }, signal);
  const actions = selection.actions.map(action => validateSingleAction(snapshot, action));
  for (const action of actions) await perform(page, action, harness, agent, signal);
  await harness.emit_event(agent, { event_type: 'worker.simple_action.completed', metadata: { task, reason: selection.reason, actions } });
  return { reason: selection.reason, actions };
}

export async function executeSingleAction(prompt: string, startUrl: string, openPage: PageFactory,
  model: Model, harness: Harness, agent: AgentExecutionContext, signal: AbortSignal) {
  const lease = await openPage(startUrl);
  try {
    const completed = await completeSimpleActionOnCurrentPage(prompt, lease.page, model, harness, agent, signal);
    const result = { name: 'Single action', status: 'succeeded', reason: completed.reason };
    await harness.emit_event(agent, { event_type: 'worker.success', metadata: { ...result, actions: completed.actions } });
    return result;
  } finally { await lease.dispose().catch(() => undefined); }
}

export async function executeTask(task: Task, map: FlowMap, prompt: string, openPage: PageFactory,
  model: Model, harness: Harness, agent: AgentExecutionContext, signal: AbortSignal, maxActions = config.maxActions) {
  const transitions = taskTransitions(map, task);
  const lease = await openPage(map.startUrl);
  let count = 0;
  let at = map.rootId;
  try {
    for (let i = 0; i <= transitions.length; i++) {
      signal.throwIfAborted();
      const snapshot = await inspect(lease.page);
      await emitObservation(harness, agent, at, snapshot);
      const expected = map.states.find(s => s.id === at)!;
      if (!matchesState(expected.snapshot, snapshot)) {
        const result = { name: task.name, status: 'blocked', reason: 'Unexpected page state; assigned path cannot be safely continued' };
        await harness.emit_event(agent, { event_type: 'worker.blocked', metadata: result }); return result;
      }
      const next = transitions[i];
      const decision = await model.call(harness, agent, 'decide_next', decisionSchema,
        'You are a browser testing worker. Evaluate the stop condition using the current observation. Return success only with concrete observed evidence that the task is satisfied. Otherwise execute ONLY the supplied next transition if it is needed and within the user task. Return blocked if no transition remains or it is unrelated. Never explore other branches. Evidence must quote visible page text or an observed element label/value.',
        { prompt, task, snapshot, nextTransition: next || null }, signal);
      if (decision.decision === 'success') {
        const evidence = decision.evidence.trim();
        const observable = snapshot.text + '\n' + snapshot.elements.map(e => `${e.label} ${e.value}`).join('\n');
        if (!evidence || !observable.includes(evidence)) throw new Error('Success evidence was not found in the current browser observation');
        const result = { name: task.name, status: 'succeeded', reason: decision.reason };
        await harness.emit_event(agent, { event_type: 'worker.success', metadata: { ...result, evidence } }); return result;
      }
      if (decision.decision === 'blocked' || !next) {
        const result = { name: task.name, status: 'blocked', reason: decision.reason };
        await harness.emit_event(agent, { event_type: 'worker.blocked', metadata: result }); return result;
      }
      for (const action of next.actions) {
        signal.throwIfAborted();
        if (++count > maxActions) throw new Error('Worker action limit reached');
        await perform(lease.page, action, harness, agent, signal);
      }
      at = next.to!;
    }
    throw new Error('Worker exhausted path');
  } finally { await lease.dispose().catch(() => undefined); }
}
