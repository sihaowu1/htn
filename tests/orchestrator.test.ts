import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { orchestratePaths } from '../src/orchestrator/index.js';
import { EventLog, Trace } from '../src/telemetry.js';
import type { Model } from '../src/model.js';
import type { FlowMap, Snapshot } from '../src/types.js';

const snapshot = (url: string, text: string): Snapshot => ({ url, title: text, text, dom: `<body>${text}</body>`, elements: [], fingerprint: text, unsupported: [] });

test('orchestrator selects MAX_PATHS diverse candidates with a cheap low-reasoning model and persists them', async () => {
  const count = config.maxPaths + 2;
  const map: FlowMap = {
    version: 1, startUrl: 'https://test.example/', rootId: 'root', status: 'complete', notes: [],
    states: [{ id: 'root', depth: 0, task: 'Start', snapshot: snapshot('https://test.example/', 'Root') },
      ...Array.from({ length: count }, (_, index) => ({ id: `leaf-${index}`, depth: 1, task: `Task ${index}`,
        snapshot: snapshot(`https://test.example/${index}`, `Leaf ${index}`) }))],
    transitions: Array.from({ length: count }, (_, index) => ({ id: `t${index}`, from: 'root', to: `leaf-${index}`,
      actions: [{ kind: 'click' as const, selector: `#choice-${index}`, value: '' }], status: 'observed' as const, reason: '' })),
  };
  const dir = await mkdtemp(join(tmpdir(), 'orchestrator-'));
  const log = new EventLog(join(dir, 'events.jsonl'), false); await log.init();
  const trace = new Trace(log, { runId: 'run-test', agentId: 'orchestrator', role: 'orchestrator' });
  let options: unknown;
  const model: Model = { call: async (_trace, name, schema, _instruction, input: any, _signal, callOptions) => {
    assert.equal(name, 'select_diverse_paths'); options = callOptions;
    const candidates = input.candidates as { id: string }[];
    const spread = Array.from({ length: config.maxPaths }, (_, index) =>
      candidates[Math.floor(index * (candidates.length - 1) / Math.max(config.maxPaths - 1, 1))].id);
    return schema.parse({ pathIds: spread, reason: 'Selected paths with different branches and terminal states.' });
  } };
  try {
    const result = await orchestratePaths(map, 'Test varied routes', 'run-test', model, trace, new AbortController().signal, dir);
    assert.equal(result.plan.paths.length, config.maxPaths);
    assert.equal((options as any).model, config.orchestratorModel);
    assert.equal((options as any).reasoningEffort, 'low');
    assert.equal(result.plan.skipped.length, count - config.maxPaths);
    const persisted = JSON.parse(await readFile(result.file, 'utf8'));
    assert.equal(persisted.selectedPaths.length, config.maxPaths);
    assert.equal(persisted.maxPaths, config.maxPaths);
    assert.match(result.file.replaceAll('\\', '/'), /orchestrator\/run-test\/selected-paths\.json$/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
