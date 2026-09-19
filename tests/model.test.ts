import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { OpenAIModel } from '../src/model.js';
import { EventLog, Trace } from '../src/telemetry.js';

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'model-api-'));
  const log = new EventLog(join(dir, 'events.jsonl'), false);
  await log.init();
  return { dir, log, trace: new Trace(log, { runId: 'run', agentId: 'agent', role: 'orchestrator' }) };
}

test('reasoning calls use Responses structured output', async () => {
  const { dir, log, trace } = await fixture();
  try {
    let request: any;
    const model = new OpenAIModel();
    (model as any).client = {
      responses: { parse: async (body: unknown) => {
        request = body;
        return { output_parsed: { selected: ['path-a'] }, usage: { input_tokens: 1, output_tokens: 1 } };
      } },
      chat: { completions: { create: async () => { throw new Error('Chat Completions should not be called'); } } },
    };
    const result = await model.call(trace, 'select_paths', z.object({ selected: z.array(z.string()) }),
      'Select paths.', { paths: ['path-a'] }, new AbortController().signal,
      { model: 'gpt-5.6-luna', reasoningEffort: 'low' });
    assert.deepEqual(result, { selected: ['path-a'] });
    assert.deepEqual(request.reasoning, { effort: 'low' });
    assert.equal(request.store, false);
    assert.equal(request.text.format.type, 'json_schema');
    const events = await log.read('run');
    assert.equal((events.find(event => event.type === 'model.request')?.data as any).api, 'responses');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('non-reasoning calls remain on Chat Completions', async () => {
  const { dir, log, trace } = await fixture();
  try {
    let request: any;
    const model = new OpenAIModel();
    (model as any).client = {
      responses: { parse: async () => { throw new Error('Responses should not be called'); } },
      chat: { completions: { create: async (body: unknown) => {
        request = body;
        return { choices: [{ message: { tool_calls: [{ type: 'function', function: { name: 'act', arguments: '{"action":"click"}' } }] } }], usage: {} };
      } } },
    };
    const result = await model.call(trace, 'act', z.object({ action: z.string() }),
      'Choose an action.', {}, new AbortController().signal);
    assert.deepEqual(result, { action: 'click' });
    assert.equal(request.tools[0].type, 'function');
    assert.equal('reasoning_effort' in request, false);
    const events = await log.read('run');
    assert.equal((events.find(event => event.type === 'model.request')?.data as any).api, 'chat.completions');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
