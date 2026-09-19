import { inspect, perform } from './browser.js';
import { matchesState, taskTransitions } from './flow.js';
import { decisionSchema, firstPageActionsSchema, type Action, type FlowMap, type Snapshot, type Task } from './types.js';
import type { PageFactory } from './crawler.js';
import type { Model } from './model.js';
import type { Trace } from './telemetry.js';
import { config } from './config.js';
import type { Page } from 'playwright';

export function validateSingleAction(snapshot: Snapshot, action: Action) {
  const element = snapshot.elements.find(candidate => candidate.selector === action.selector);
  if (!element) throw new Error('Model selected an action target that is not present in the current page observation');
  if (action.kind === 'fill' && !['input', 'textarea'].includes(element.tag)) throw new Error('Fill action requires an input or textarea');
  if (action.kind === 'select' && element.tag !== 'select') throw new Error('Select action requires a select element');
  return action;
}

/** Complete one simple task on the current page with one fully awaited model step. */
export async function completeSimpleActionOnCurrentPage(task: string, page: Page,
  model: Model, trace: Trace, signal: AbortSignal) {
  signal.throwIfAborted();
  const snapshot = await inspect(page);
  await trace.event('worker.observation', { snapshot, stateId: 'current' });
  const selection = await model.call(trace, 'choose_current_page_actions', firstPageActionsSchema,
    'You are a browser testing worker completing one simple task on the current page. Return the shortest sequence of at most five browser operations needed to perform it, using only visible actionable elements in the supplied current-page observation and copying every selector verbatim. A single user-level task may require multiple operations, such as filling a search field and clicking its submit button. Use click for links/buttons, fill for text fields, select for select elements, or press only for a supported key. Do not explore, add unrelated operations, or continue beyond the requested task.',
    { task, snapshot }, signal);
  const actions = selection.actions.map(action => validateSingleAction(snapshot, action));
  for (const action of actions) await perform(page, action, trace, signal);
  await trace.event('worker.simple_action.completed', { task, reason: selection.reason, actions });
  return { reason: selection.reason, actions };
}

export async function executeSingleAction(prompt: string, startUrl: string, openPage: PageFactory,
  model: Model, trace: Trace, signal: AbortSignal) {
  const lease = await openPage(startUrl);
  try {
    const completed = await completeSimpleActionOnCurrentPage(prompt, lease.page, model, trace, signal);
    const result = { name: 'Single action', status: 'succeeded', reason: completed.reason };
    await trace.event('worker.success', { ...result, actions: completed.actions });
    return result;
  } finally { await lease.dispose().catch(() => undefined); }
}

export async function executeTask(task: Task, map: FlowMap, prompt: string, openPage: PageFactory,
  model: Model, trace: Trace, signal: AbortSignal, maxActions = config.maxActions) {
  const transitions = taskTransitions(map, task);
  const lease = await openPage(map.startUrl);
  let count = 0;
  let at = map.rootId;
  try {
    for (let i = 0; i <= transitions.length; i++) {
      signal.throwIfAborted();
      const snapshot = await inspect(lease.page);
      await trace.event('worker.observation', { snapshot, stateId: at });
      const expected = map.states.find(s => s.id === at)!;
      if (!matchesState(expected.snapshot, snapshot)) {
        const result = { name: task.name, status: 'blocked', reason: 'Unexpected page state; assigned path cannot be safely continued' };
        await trace.event('worker.blocked', result); return result;
      }
      const next = transitions[i];
      const decision = await model.call(trace, 'decide_next', decisionSchema,
        'You are a browser testing worker. Evaluate the stop condition using the current observation. Return success only with concrete observed evidence that the task is satisfied. Otherwise execute ONLY the supplied next transition if it is needed and within the user task. Return blocked if no transition remains or it is unrelated. Never explore other branches. Evidence must quote visible page text or an observed element label/value.',
        { prompt, task, snapshot, nextTransition: next || null }, signal);
      if (decision.decision === 'success') {
        const evidence = decision.evidence.trim();
        const observable = snapshot.text + '\n' + snapshot.elements.map(e => `${e.label} ${e.value}`).join('\n');
        if (!evidence || !observable.includes(evidence)) throw new Error('Success evidence was not found in the current browser observation');
        const result = { name: task.name, status: 'succeeded', reason: decision.reason };
        await trace.event('worker.success', { ...result, evidence }); return result;
      }
      if (decision.decision === 'blocked' || !next) {
        const result = { name: task.name, status: 'blocked', reason: decision.reason };
        await trace.event('worker.blocked', result); return result;
      }
      for (const action of next.actions) {
        signal.throwIfAborted();
        if (++count > maxActions) throw new Error('Worker action limit reached');
        await perform(lease.page, action, trace, signal);
      }
      at = next.to!;
    }
    throw new Error('Worker exhausted path');
  } finally { await lease.dispose().catch(() => undefined); }
}
