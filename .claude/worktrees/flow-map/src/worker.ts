import { inspect, perform } from './browser.js';
import { matchesState, taskTransitions } from './flow.js';
import { decisionSchema, type FlowMap, type Task } from './types.js';
import type { PageFactory } from './crawler.js';
import type { Model } from './model.js';
import type { Trace } from './telemetry.js';
import { config } from './config.js';

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
