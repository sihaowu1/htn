import { z } from 'zod';
import { inspect, perform, type BrowserSession } from '../browser.js';
import { candidates } from '../flow.js';
import { config } from '../config.js';
import type { Model } from '../model.js';
import type { Trace } from '../telemetry.js';
import type { Action, FlowMap, Snapshot } from '../types.js';

export type PageLease = Awaited<ReturnType<BrowserSession['page']>>;
export type PageFactory = (url: string) => Promise<PageLease>;

export async function crawl(startUrl: string, openPage: PageFactory, model: Model, trace: Trace, signal: AbortSignal,
  update: (map: FlowMap) => void, limits = { states: config.maxStates, depth: config.maxDepth }) {
  const map: FlowMap = { version: 1, startUrl, rootId: 's0', status: 'complete', notes: [
    'Coverage is limited to visible DOM actions and sampled inputs. Arbitrary input values and hidden application states are not exhaustively enumerable.',
  ], states: [], transitions: [] };
  const initial = await openPage(startUrl);
  let root: Snapshot;
  try { root = await inspect(initial.page); } finally { await initial.dispose(); }
  const sampleSchema = z.object({ values: z.array(z.string().min(1).max(80)).min(1).max(3) });
  const { values } = await model.call(trace, 'choose_samples', sampleSchema,
    'Choose up to three short representative non-sensitive text inputs for exploring this demo website. Include one plausible valid search term and one unlikely match. You do not navigate.',
    { snapshot: root }, signal);
  const samples = [...new Set(values)];
  map.states.push({ id: map.rootId, snapshot: root, depth: 0 });
  const paths = new Map<string, Action[][]>([[map.rootId, []]]);
  const fingerprints = new Map([[root.fingerprint, map.rootId]]);
  let nextTransition = 0;
  for (let cursor = 0; cursor < map.states.length; cursor++) {
    const state = map.states[cursor];
    for (const note of state.snapshot.unsupported) {
      map.status = 'limited'; map.notes.push(`${state.id}: ${note}`);
    }
    const options = candidates(state.snapshot, samples);
    for (const actions of options) map.transitions.push({ id: `t${nextTransition++}`, from: state.id,
      to: null, actions, status: 'unexplored', reason: 'Not explored yet' });
    for (const transition of map.transitions.filter(t => t.from === state.id)) {
      if (signal.aborted || map.states.length >= limits.states || state.depth >= limits.depth) {
        transition.reason = signal.aborted ? 'Discovery stopped or timed out' : state.depth >= limits.depth ? 'Depth limit reached' : 'State limit reached';
        map.status = 'limited'; continue;
      }
      let lease: PageLease | undefined;
      try {
        signal.throwIfAborted();
        lease = await openPage(startUrl);
        const replay = paths.get(state.id)!;
        for (const step of replay) for (const action of step) await perform(lease.page, action, trace, signal);
        const before = await inspect(lease.page);
        if (before.fingerprint !== state.snapshot.fingerprint) throw new Error('Path replay produced a different state; target may require a backend reset');
        for (const action of transition.actions) await perform(lease.page, action, trace, signal);
        const observed = await inspect(lease.page);
        let id = fingerprints.get(observed.fingerprint);
        if (!id) {
          id = `s${map.states.length}`; fingerprints.set(observed.fingerprint, id);
          map.states.push({ id, snapshot: observed, depth: state.depth + 1 });
          paths.set(id, [...replay, transition.actions]);
        }
        transition.to = id; transition.status = 'observed'; transition.reason = '';
        await trace.event('discovery.transition', { transition, snapshot: observed });
      } catch (error) {
        transition.status = signal.aborted ? 'unexplored' : 'failed'; transition.reason = String(error); map.status = 'limited';
        await trace.event('discovery.failed', { transitionId: transition.id, error: String(error) });
      } finally { await lease?.dispose().catch(() => undefined); }
      update(map);
    }
  }
  update(map);
  await trace.event('discovery.finished', { states: map.states.length, transitions: map.transitions.length, status: map.status, notes: map.notes });
  return map;
}
