import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { OpenAIModel } from '../src/model.js';
import { Harness, MemoryAdapter } from '../src/sdk/index.js';

async function fixture() {
  const adapter = new MemoryAdapter();
  const harness = new Harness(adapter);
  const run = await harness.start_run({ goal: 'model test' });
  const agent = await harness.register_agent_execution(run, { agent_id: 'orchestrator' });
  return { adapter, harness, agent };
}

function eventsOf(adapter: MemoryAdapter, type: string) {
  return [...adapter.events.values()].filter(e => e.event_type === type);
}

test('reasoning calls use Responses structured output', async () => {
  const { adapter, harness, agent } = await fixture();
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
    const result = await model.call(harness, agent, 'select_paths', z.object({ selected: z.array(z.string()) }),
      'Select paths.', { paths: ['path-a'] }, new AbortController().signal,
      { model: 'gpt-5.6-luna', reasoningEffort: 'low' });
    assert.deepEqual(result, { selected: ['path-a'] });
    assert.deepEqual(request.reasoning, { effort: 'low' });
    assert.equal(request.store, false);
    assert.equal(request.text.format.type, 'json_schema');
    const requested = eventsOf(adapter, 'model.request');
    assert.equal(requested.length, 1);
    assert.equal((requested[0].metadata as any).api, 'responses');
    assert.ok((requested[0].metadata as any).input_ref);
    assert.equal(eventsOf(adapter, 'model.response').length, 1);
  } finally { await adapter.close(); }
});

test('non-reasoning calls remain on Chat Completions', async () => {
  const { adapter, harness, agent } = await fixture();
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
    const result = await model.call(harness, agent, 'act', z.object({ action: z.string() }),
      'Choose an action.', {}, new AbortController().signal);
    assert.deepEqual(result, { action: 'click' });
    assert.equal(request.tools[0].type, 'function');
    assert.equal('reasoning_effort' in request, false);
    const requested = eventsOf(adapter, 'model.request');
    assert.equal(requested.length, 1);
    assert.equal((requested[0].metadata as any).api, 'chat.completions');
  } finally { await adapter.close(); }
});
