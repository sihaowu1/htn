import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomInt } from 'node:crypto';
import { config } from '../config.js';
import { planRelevantTree, validatePlan } from '../flow.js';
import type { Model } from '../model.js';
import type { AgentExecutionContext, Harness } from '../sdk/index.js';
import type { FlowMap, Plan, Task } from '../types.js';
import { isAccountCreation } from '../fixture-credentials.js';

type Candidate = {
  id: string;
  task: Task;
  nodeTasks: string[];
  actions: string[];
  terminalStateId: string;
  entryStrategy: 'direct' | 'category' | 'search';
  productIds: string[];
  progress: number;
  behavior: string[];
};

function entryStrategy(nodeTasks: string[], actions: string[]): Candidate['entryStrategy'] {
  const description = [nodeTasks[1] || '', actions[0] || ''].join(' ').toLowerCase();
  if (/\bsearch\b/.test(description)) return 'search';
  if (/\bcategory\b|\bopen (?:the )?tvs\b|\bclick tvs\b/.test(description)) return 'category';
  return 'direct';
}

function describeCandidates(map: FlowMap, goal: string): Candidate[] {
  return planRelevantTree(map, goal).paths.map((task, index) => {
    let stateId = map.rootId;
    const nodeTasks = [map.states.find(state => state.id === stateId)?.task || 'Start'];
    const actions: string[] = [];
    const behavior: string[] = [];
    const productIds = new Set<string>();
    let progress = 0;
    for (const transitionId of task.transitionIds) {
      const transition = map.transitions.find(item => item.id === transitionId)!;
      const source = map.states.find(state => state.id === transition.from)!;
      for (const action of transition.actions) {
        const element = source.snapshot.elements.find(element => element.selector === action.selector);
        // Field-filling permutations on the same form do not count as different routes.
        if (element && ['input', 'textarea', 'select'].includes(element.tag) && !/search/i.test(element.type + element.label)) continue;
        behavior.push(JSON.stringify([new URL(source.snapshot.url).pathname + new URL(source.snapshot.url).search, action]));
      }
      actions.push(...transition.actions.map(action => `${action.kind}:${action.selector}${action.kind === 'fill' && action.value !== '[fixture-login-password]' ? `=${action.value}` : ''}`));
      stateId = transition.to!;
      const state = map.states.find(candidate => candidate.id === stateId);
      if (state?.goalAssessment?.goal === goal) progress = state.goalAssessment.progress;
      nodeTasks.push(state?.task || stateId);
      if (state) {
        const productId = new URL(state.snapshot.url).searchParams.get('id');
        if (productId) productIds.add(productId);
      }
    }
    return { id: `path-${index + 1}`, task, nodeTasks, actions, terminalStateId: stateId,
      entryStrategy: entryStrategy(nodeTasks, actions), productIds: [...productIds],
      progress, behavior: behavior.length ? behavior : actions };
  });
}

function distance(a: Candidate, b: Candidate) {
  let shared = 0;
  while (shared < Math.min(a.behavior.length, b.behavior.length) && a.behavior[shared] === b.behavior[shared]) shared++;
  return 1 - shared / Math.max(1, Math.max(a.behavior.length, b.behavior.length));
}

function exploratoryCandidates(map: FlowMap, goal: string): Candidate[] {
  const root = map.states.find(state => state.id === map.rootId)!;
  const words = goal.toLowerCase().match(/[a-z]{2,}/g) || [];
  return map.transitions.filter(transition => transition.from === map.rootId && transition.status === 'unexplored' && transition.to === null)
    .flatMap(transition => {
      const elements = transition.actions.map(action => root.snapshot.elements.find(element => element.selector === action.selector));
      if (elements.some(element => !element || isAccountCreation(element.label))) return [];
      const description = elements.map(element => element!.label).join(' ');
      // Only take cached, visible routes related to this request; don't open arbitrary skipped branches.
      const text = (description + ' ' + transition.reason).toLowerCase();
      if (!words.filter(word => !['the', 'and', 'then', 'with', 'into', 'from', 'for', 'add', 'enter', 'to', 'an', 'in', 'of', 'it', 'is'].includes(word))
        .some(word => text.includes(word.replace(/s$/, '')))) return [];
      if (transition.actions.some(action => action.kind !== 'click')) return [];
      const behavior = transition.actions.map(action => JSON.stringify([new URL(root.snapshot.url).pathname + new URL(root.snapshot.url).search, action]));
      return [{ id: `explore-${transition.id}`, task: { name: `Explore ${description.slice(0, 100)}`, transitionIds: [],
        exploreFrom: transition.id, instructions: goal, completion: 'partial' as const,
        stopCondition: `Stop when the full goal is observed or no relevant safe action remains: ${goal}`,
        limitation: 'This cached branch was not replayed by discovery; the worker validates it live.' },
        nodeTasks: ['Start', description], actions: behavior, terminalStateId: root.id,
        entryStrategy: entryStrategy(['Start', description], behavior), productIds: [], progress: 0, behavior }];
    });
}

async function persistSelection(runId: string, goal: string, candidates: Candidate[], selected: Candidate[], reason: string,
  logRoot: string) {
  const directory = join(logRoot, 'orchestrator', runId);
  await mkdir(directory, { recursive: true });
  const document = {
    kind: 'planned-paths',
    runId, createdAt: new Date().toISOString(), goal, model: null, selectionMethod: 'early-divergence-with-random-ties',
    maxPaths: config.maxPaths, candidateCount: candidates.length, reason,
    selectedPaths: selected.map((candidate, index) => ({ agentId: `worker-${index + 1}`, id: candidate.id, ...candidate.task,
      nodeTasks: candidate.nodeTasks, actions: candidate.actions, terminalStateId: candidate.terminalStateId,
      progress: candidate.progress,
      entryStrategy: candidate.entryStrategy, productIds: candidate.productIds })),
  };
  const file = join(directory, 'selected-paths.json');
  await writeFile(file, JSON.stringify(document, null, 2) + '\n', 'utf8');
  return file;
}

export async function orchestratePaths(map: FlowMap, goal: string, runId: string, model: Model, harness: Harness, agent: AgentExecutionContext,
  signal: AbortSignal, logRoot = 'logs'): Promise<{ plan: Plan; file: string; reason: string }> {
  signal.throwIfAborted();
  const all = [...describeCandidates(map, goal), ...exploratoryCandidates(map, goal)];
  // Fresh random ordering breaks equal-quality/diversity ties without weakening
  // the goal and distinct-behavior priorities or reusing a saved assignment.
  for (let index = all.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [all[index], all[other]] = [all[other], all[index]];
  }
  const reaching = all.filter(candidate => candidate.task.completion === 'goal');
  // A leaf is not proof of success. Prefer goal-confirmed paths; otherwise send the
  // most advanced known frontier, without claiming that the goal is impossible.
  const candidates = all;
  if (!candidates.length) {
    const plan = validatePlan(map, { summary: 'No executable root-to-leaf paths were discovered.', paths: [], skipped: [] });
    const reason = 'No candidate paths were available.';
    const file = await persistSelection(runId, goal, candidates, [], reason, logRoot);
    return { plan, file, reason };
  }

  const quality = (a: Candidate, b: Candidate) => Number(b.task.completion === 'goal') - Number(a.task.completion === 'goal')
    || b.progress - a.progress || (a.task.completion === 'goal' ? a.task.transitionIds.length - b.task.transitionIds.length
      : b.task.transitionIds.length - a.task.transitionIds.length);
  const selected: Candidate[] = [all.slice().sort(quality)[0]];
  while (selected.length < Math.min(config.maxPaths, all.length)) {
    const remaining = all.filter(candidate => !selected.includes(candidate));
    const novelty = (candidate: Candidate) => Math.min(...selected.map(chosen => distance(candidate, chosen)));
    remaining.sort((a, b) => novelty(b) - novelty(a) || quality(a, b));
    selected.push(remaining[0]);
  }
  const reasons = ['Preserved the best goal route, then maximized early behavioral divergence, including partial or exploratory routes before near-identical successful paths.'];
  const distinct = [...selected];
  while (selected.length < config.maxPaths) {
    const source = distinct[(selected.length - distinct.length) % distinct.length];
    const slot = selected.length + 1;
    selected.push({ ...source, id: `${source.id}-repeat-${slot}`, task: { ...source.task,
      name: `${source.task.name} (independent replay ${slot})`, repeatOf: source.task.name } });
  }
  if (distinct.length < config.maxPaths) reasons.push(`Only ${distinct.length} distinct routes were discovered; remaining workers independently replay validated routes.`);
  const reason = reasons.join(' ') || 'Selected all available distinct routes.';

  const plan = validatePlan(map, {
    summary: `${reaching.length ? 'Goal-reaching routes take priority.' : 'No complete route was confirmed.'} Assigned three workers: ${selected.filter(path => path.task.completion === 'goal').length} goal-reaching and ${selected.filter(path => path.task.completion !== 'goal').length} partial routes. ${reason}`,
    paths: selected.map(candidate => candidate.task), skipped: [],
  });
  const file = await persistSelection(runId, goal, candidates, selected, reason, logRoot);
  await harness.emit_event(agent, { event_type: 'orchestrator.paths.selected', metadata: { candidateCount: candidates.length, selectedPathIds: selected.map(path => path.id), reason, file } });
  return { plan, file, reason };
}
