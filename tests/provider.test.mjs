import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProviders } from '../scripts/providers.mjs';
const replies = [{ text: 'Ответ', reason: 'Причина' }];
const input = { text: 'Привет', model: 'test-model', count: 1 };
function stream(events) { return new Response(new ReadableStream({ start(controller) { for (const event of events) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)); controller.close(); } })); }

test('richer request preserves photos, memory, template variables and requested count', async () => {
  let captured;
  const provider = createProviders({ env: {}, apiKey: 'private-test-key', fetchImpl: async (url, options) => { captured = JSON.parse(options.body); return Response.json({ choices: [{ message: { content: JSON.stringify({ replies }) } }] }); } });
  const result = await provider.complete({ ...input, style: { prompt: 'Имя {personName}', temperature: 0.2, maxTokens: 500 }, context: { profile: { name: 'Тест' } }, memories: [{ text: 'Любит чай', enabled: true }], photos: ['data:image/png;base64,YQ=='] });
  assert.deepEqual(result.replies, replies);
  assert.match(captured.messages[0].content, /Имя Тест/); assert.match(captured.messages[0].content, /Любит чай/);
  assert.equal(captured.messages[1].content[1].type, 'image_url'); assert.equal(captured.temperature, 0.2);
});

test('real upstream SSE produces deltas and validates the final reply contract', async () => {
  const json = JSON.stringify({ replies }); const deltas = [];
  const provider = createProviders({ env: {}, apiKey: 'test-key', fetchImpl: async () => stream([{ choices: [{ delta: { content: json.slice(0, 10) } }] }, { choices: [{ delta: { content: json.slice(10) }, finish_reason: 'stop' }] }]) });
  assert.deepEqual((await provider.complete(input, { onDelta: text => deltas.push(text) })).replies, replies);
  assert.equal(deltas.join(''), json); assert.equal(deltas.length, 2);
});

test('ChatGPT OAuth resolver uses Responses streaming and requires completion marker', async () => {
  let captured;
  const resolver = async () => ({ apiKey: 'oauth-token-test', baseUrl: 'https://api.openai.com/v1', protocol: 'responses' });
  const make = complete => createProviders({ env: {}, credentialResolver: resolver, fetchImpl: async (url, options) => { captured = { url, body: JSON.parse(options.body) }; return stream([{ type: 'response.output_text.delta', delta: 'Готово' }, ...(complete ? [{ type: 'response.completed' }] : [])]); } });
  const result = await make(true).complete({ ...input, provider: 'chatgpt' }, { task: 'assistant' });
  assert.equal(result.text, 'Готово'); assert.equal(captured.url, 'https://api.openai.com/v1/responses'); assert.equal(captured.body.store, false); assert.equal(captured.body.stream, true);
  await assert.rejects(make(false).complete({ ...input, provider: 'chatgpt' }, { task: 'assistant' }), /GPT/);
});

test('model catalogs handle OAuth slug shape and credentials persist privately without leaking status', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'replylab-credentials-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const providers = createProviders({ env: {}, directory, fetchImpl: async () => Response.json({ models: [{ slug: 'test-model', display_name: 'Test', visibility: 'list' }, { slug: 'hidden', visibility: 'hidden' }] }) });
  await providers.credentials({ provider: 'openai', apiKey: 'server-private-test-key' });
  assert.equal((await stat(join(directory, 'credentials.json'))).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(await providers.status()).includes('server-private-test-key'), false);
  assert.equal((await providers.models('openai'))[0].id, 'test-model'); assert.equal((await providers.models('openai')).length, 1);
  assert.equal((await createProviders({ env: {}, directory }).status())[0].configured, true);
});

test('truncated chat stream fails even when the partial text is valid JSON', async () => {
  const provider = createProviders({ env: {}, apiKey: 'test-key', fetchImpl: async () => stream([{ choices: [{ delta: { content: JSON.stringify({ replies }) } }] }]) });
  await assert.rejects(provider.complete(input, { onDelta() {} }), /GPT/);
});

test('loopback compatible endpoint works without a key and never sends an empty bearer', async () => {
  let headers;
  const provider = createProviders({ env: { COMPATIBLE_API_BASE: 'http://127.0.0.1:11434/v1' }, fetchImpl: async (url, options) => { headers = options.headers; return Response.json({ choices: [{ message: { content: JSON.stringify({ replies }) } }] }); } });
  assert.equal((await provider.status()).find(item => item.id === 'compatible').configured, true);
  await provider.complete({ ...input, provider: 'compatible' }); assert.equal(Object.hasOwn(headers, 'Authorization'), false);
});

test('explicit reply tool definitions accept only validated known tool output', async () => {
  let request;
  const provider = createProviders({ env: {}, apiKey: 'test-key', fetchImpl: async (url, options) => {
    request = JSON.parse(options.body);
    return Response.json({ choices: [{ message: { tool_calls: [{ function: { name: 'emitSuggestions', arguments: JSON.stringify({ suggestions: replies }) } }] } }] });
  } });
  assert.deepEqual((await provider.complete({ ...input, useTools: true })).replies, replies);
  assert.equal(request.tools[0].function.name, 'emitReplies'); assert.equal(request.response_format, undefined);
  const invalid = createProviders({ env: {}, apiKey: 'test-key', fetchImpl: async () => Response.json({ choices: [{ message: { tool_calls: [{ function: { name: 'unapprovedAction', arguments: JSON.stringify({ replies }) } }] } }] }) });
  await assert.rejects(invalid.complete(input), /GPT/);
});

test('OpenRouter usage returns only safe documented counters for the current key', async () => {
  let requested;
  const provider = createProviders({ env: { OPENROUTER_API_KEY: 'server-private-test-key' }, fetchImpl: async (url, options) => {
    requested = { url, options };
    return Response.json({ data: { usage: 2.5, usage_daily: 1, usage_weekly: 2, usage_monthly: 2.5, limit: 10, limit_remaining: 7.5, limit_reset: 'monthly', is_free_tier: false,
      label: 'private-key-label', creator_user_id: 'private-user-id', hash: 'private-hash', api_key: 'server-private-test-key',
      free_model_daily_requests: { limit: 50, used: 12, remaining: 38 }, effective_budget: { limit_usd: 20, remaining_usd: 17.5, spend_usd: 2.5, reset_interval: 'weekly' } } });
  } });
  const result = await provider.usage('openrouter');
  assert.equal(requested.url, 'https://openrouter.ai/api/v1/key'); assert.equal(requested.options.headers.Authorization, 'Bearer server-private-test-key'); assert.equal(requested.options.redirect, 'error');
  assert.equal(result.scope, 'current-key'); assert.equal(result.usage.total, 2.5); assert.equal(result.remaining, 7.5); assert.equal(result.freeRequests.remaining, 38);
  for (const privateValue of ['server-private-test-key', 'private-key-label', 'private-user-id', 'private-hash']) assert.equal(JSON.stringify(result).includes(privateValue), false);
});

test('ChatGPT usage is honestly unsupported and performs no speculative API request', async () => {
  const provider = createProviders({ env: {}, fetchImpl: async () => { throw new Error('Unexpected network'); }, credentialResolver: async () => { throw new Error('Unexpected credential lookup'); } });
  const result = await provider.usage('chatgpt'); assert.equal(result.supported, false); assert.match(result.message, /Settings → Usage/); assert.equal(result.usage, undefined);
  assert.equal(result.manageUrl, 'https://chatgpt.com/settings/usage');
  await assert.rejects(provider.usage('unknown'), error => error.status === 400);
});

test('ChatGPT Responses moves system instructions out of input and omits unsupported fields', async () => {
  let body;
  const provider = createProviders({ env: {}, credentialResolver: async () => ({ apiKey: 'oauth-test-token', baseUrl: 'https://api.openai.com/v1', protocol: 'responses' }), fetchImpl: async (url, options) => {
    body = JSON.parse(options.body);
    return stream([{ type: 'response.output_item.added', item: { type: 'function_call', name: 'emitReplies' } }, { type: 'response.function_call_arguments.delta', delta: JSON.stringify({ replies }) }, { type: 'response.completed' }]);
  } });
  assert.deepEqual((await provider.complete({ ...input, provider: 'chatgpt', useTools: true, temperature: 0.5, maxTokens: 100 })).replies, replies);
  assert.equal(typeof body.instructions, 'string'); assert.ok(body.instructions.length > 0); assert.equal(body.input.some(item => item.role === 'system'), false);
  assert.equal(Object.hasOwn(body, 'temperature'), false); assert.equal(Object.hasOwn(body, 'max_output_tokens'), false);
  assert.equal(body.tools[0].type, 'namespace'); assert.equal(body.tools[0].tools[0].name, 'emitReplies'); assert.equal(body.tool_choice, 'required');
});

test('assistant follow-up keeps explicitly uploaded attachments from previous user turns', async () => {
  let body;
  const provider = createProviders({ env: {}, apiKey: 'fixture', fetchImpl: async (url, options) => { body = JSON.parse(options.body); return Response.json({ choices: [{ message: { content: 'Follow-up' } }] }); } });
  await provider.complete({ ...input, messages: [{ role: 'user', text: 'Look at this', attachments: [{ dataUrl: 'data:image/png;base64,YQ==' }] }, { role: 'assistant', text: 'Description' }] }, { task: 'assistant' });
  assert.equal(body.messages[1].content[1].type, 'image_url');
  assert.equal(body.messages[2].content, 'Description');
});
