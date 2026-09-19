import { mapSchema, type FlowMap, type Plan, type Task, type Transition, type Snapshot, type Action } from './types.js';

export function validateMap(input: unknown, targetUrl?: string): FlowMap {
  const map = mapSchema.parse(input);
  if (!['http:', 'https:'].includes(new URL(map.startUrl).protocol)) throw new Error('Flow map must use HTTP(S)');
  if (targetUrl && new URL(map.startUrl).href !== new URL(targetUrl).href) throw new Error('Flow map startUrl must match target URL');
  const ids = new Set(map.states.map(s => s.id));
  if (ids.size !== map.states.length || !ids.has(map.rootId)) throw new Error('Invalid or duplicate state IDs');
  if (new Set(map.transitions.map(t => t.id)).size !== map.transitions.length) throw new Error('Duplicate transition IDs');
  for (const state of map.states) {
    if (!state.snapshot.fingerprint && (map.status !== 'provided' || !state.snapshot.text.trim())) {
      throw new Error('States require a discovered fingerprint or, for provided maps, nonempty expected visible text');
    }
  }
  for (const t of map.transitions) {
    if (!ids.has(t.from) || (t.to !== null && !ids.has(t.to))) throw new Error(`Invalid transition reference: ${t.id}`);
    if (t.status === 'observed' && !t.to) throw new Error(`Observed transition needs a destination: ${t.id}`);
  }
  return map;
}
export function matchesState(expected: Snapshot, actual: Snapshot) {
  if (expected.fingerprint) return expected.fingerprint === actual.fingerprint;
  const expectedUrl = new URL(expected.url), actualUrl = new URL(actual.url);
  return expectedUrl.pathname + expectedUrl.search + expectedUrl.hash === actualUrl.pathname + actualUrl.search + actualUrl.hash
    && !!expected.text.trim() && actual.text.includes(expected.text.trim())
    && expected.elements.every(e => actual.elements.some(a => a.selector === e.selector && (!e.label || a.label === e.label)));
}
export function taskTransitions(map: FlowMap, task: Task): Transition[] {
  let at = map.rootId;
  const seen = new Set([at]);
  return task.transitionIds.map(id => {
    const t = map.transitions.find(t => t.id === id);
    if (!t || t.from !== at || t.status !== 'observed' || !t.to) throw new Error(`Invalid assigned path at ${id}`);
    if (seen.has(t.to)) throw new Error('Worker paths must not loop');
    seen.add(t.to); at = t.to; return t;
  });
}
export function validatePlan(map: FlowMap, plan: Plan): Plan {
  const paths = new Set<string>();
  const used = new Set<string>();
  for (const task of plan.paths) {
    taskTransitions(map, task);
    const key = JSON.stringify(task.transitionIds);
    if (paths.has(key)) throw new Error('Duplicate assigned path');
    paths.add(key); task.transitionIds.forEach(id => used.add(id));
    if (!task.stopCondition.trim()) throw new Error('Missing stop condition');
  }
  for (const item of plan.skipped) {
    if (!map.transitions.some(t => t.id === item.transitionId) || used.has(item.transitionId)) throw new Error('Invalid skipped transition');
  }
  for (const t of map.transitions) if (!used.has(t.id) && !plan.skipped.some(s => s.transitionId === t.id)) {
    plan.skipped.push({ transitionId: t.id, reason: 'Not selected for this task' });
  }
  return plan;
}
export function flowTree(map: FlowMap) {
  const visited = new Set<string>();
  function branch(id: string): unknown {
    if (visited.has(id)) return { stateId: id, reference: true };
    visited.add(id);
    return { stateId: id, transitions: map.transitions.filter(t => t.from === id).map(t => ({
      id: t.id, status: t.status, reason: t.reason, actions: t.actions, next: t.to ? branch(t.to) : null,
    })) };
  }
  return branch(map.rootId);
}
export function candidates(snapshot: Snapshot, samples: string[]): Action[][] {
  const actions: Action[][] = [];
  const fields = snapshot.elements.filter(e => ['input', 'textarea'].includes(e.tag) && !['submit', 'button', 'checkbox', 'radio', 'hidden', 'password', 'file', 'range', 'color'].includes(e.type));
  const fill = (e: typeof fields[number], sample: string): Action => ({ kind: 'fill', selector: e.selector,
    value: ({ email: 'test@example.com', number: '1', date: '2026-01-01', time: '12:00', url: 'https://example.com', 'datetime-local': '2026-01-01T12:00' } as Record<string, string>)[e.type] || sample });
  for (const e of snapshot.elements) {
    if (e.tag === 'a' || e.tag === 'button' || ['submit', 'button', 'checkbox', 'radio'].includes(e.type) || ['button', 'link'].includes(e.type)) {
      const click: Action = { kind: 'click', selector: e.selector, value: '' };
      actions.push([click]);
      if (fields.length && (e.tag === 'button' || e.type === 'submit')) {
        for (const sample of samples) actions.push([...fields.map(f => fill(f, sample)), click]);
      }
    }
    if (e.tag === 'select') for (const value of e.options.slice(0, 3)) actions.push([{ kind: 'select', selector: e.selector, value }]);
  }
  for (const field of fields) for (const sample of samples) {
    actions.push([fill(field, sample)]);
    actions.push([fill(field, sample), { kind: 'press', selector: field.selector, value: 'Enter' }]);
  }
  return [...new Map(actions.map(a => [JSON.stringify(a), a])).values()];
}
export async function pool<T>(items: T[], concurrency: number, signal: AbortSignal, work: (item: T, index: number) => Promise<void>) {
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!signal.aborted) { const index = cursor++; if (index >= items.length) return; await work(items[index], index); }
  }));
}
