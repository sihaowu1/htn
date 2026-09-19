import { test } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { OpenAIModel, type ResponseSession } from '../src/model.js';
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

test('crawl conversations chain validated Responses and remain isolated', async () => {
  const { adapter, harness, agent } = await fixture();
  try {
    const requests: any[] = [];
    let invalid = false;
    const model = new OpenAIModel();
    (model as any).client = { responses: { parse: async (body: unknown) => {
      requests.push(body);
      return { id: `response-${requests.length}`, output_parsed: invalid ? { done: 'bad' } : { done: false }, usage: {} };
    } } };
    const session: ResponseSession = {};
    const call = (current: ResponseSession) => model.call(harness, agent, 'choose', z.object({ done: z.boolean() }),
      'Choose.', { stateId: requests.length }, new AbortController().signal, { reasoningEffort: 'low', session: current });
    await call(session);
    await call(session);
    assert.equal(requests[0].store, true);
    assert.equal(requests[0].previous_response_id, undefined);
    assert.equal(requests[1].previous_response_id, 'response-1');
    assert.equal(requests[1].instructions, requests[0].instructions);
    invalid = true;
    await assert.rejects(call(session));
    assert.equal(session.previousResponseId, 'response-2');
    invalid = false;
    await call({});
    assert.equal(requests[3].previous_response_id, undefined);
    assert.ok(eventsOf(adapter, 'model.request').some(event => (event.metadata as any).previousResponseId === 'response-1'));
  } finally { await adapter.close(); }
});

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
