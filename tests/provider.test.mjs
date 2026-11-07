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

const toolCall = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const toolResponse = calls => Response.json({ choices: [{ message: { content: null, tool_calls: calls }, finish_reason: 'tool_calls' }] });
const pair = { conversationId: 'chat', chatId: 'chat', accountId: 'account-a', platform: 'tinder', theirText: 'Tea?', myReply: 'Tea tomorrow', sentAt: null, messageId: 'message', partial: true };

test('assistant executes only reviewable tools and passes validated tool outputs back for a final answer', async () => {
  const requests = []; let searches = 0;
  const provider = createProviders({ env: {}, apiKey: 'private-test-key', fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body); requests.push(body);
    if (requests.length === 1) return toolResponse([toolCall('search', 'searchPastReplies', { query: 'tea', current_account_only: true })]);
    if (requests.length === 2) return toolResponse([toolCall('suggest', 'printSuggestions', { replies }), toolCall('draft', 'draftPrompt', { name: 'Warm', prompt: 'Use short replies.', useHistory: false })]);
    return Response.json({ choices: [{ message: { content: 'Review the suggestions and style.' }, finish_reason: 'stop' }] });
  } });
  const result = await provider.complete({ ...input, context: { accountId: 'account-a', platform: 'tinder' }, allowHistorySearch: true }, { task: 'assistant', executeTool: async (name, args) => {
    searches++; assert.equal(name, 'searchPastReplies'); assert.equal(args.accountId, 'account-a'); assert.equal(args.platform, 'tinder'); return [pair];
  } });
  assert.equal(searches, 1); assert.equal(requests.length, 3); assert.equal(result.text, 'Review the suggestions and style.');
  assert.deepEqual(result.toolResults.map(item => item.type), ['past-replies', 'suggestions', 'draft-style']);
  assert.equal(result.toolResults[0].source, 'server-history'); assert.equal(result.toolResults[2].requiresConfirmation, true);
  assert.equal(JSON.parse(requests[1].messages.at(-1).content).results[0].myReply, pair.myReply);
  assert.equal(result.model, input.model); assert.equal(typeof result.elapsedMs, 'number');
  assert.equal(JSON.stringify(result).includes('private-test-key'), false);
});

test('history tools fail closed for unknown accounts, missing permission and all-account escalation', async () => {
  for (const [options, args, code] of [
    [{ allowHistorySearch: true }, { query: 'tea', current_account_only: true }, 'account-required'],
    [{ context: { accountId: 'account-a' } }, { query: 'tea', current_account_only: true }, 'history-not-enabled'],
    [{ allowHistorySearch: true, context: { accountId: 'account-a' } }, { query: 'tea', current_account_only: false }, 'all-accounts-not-approved'],
  ]) {
    let requests = 0; let searches = 0;
    const provider = createProviders({ env: {}, apiKey: 'test-key', fetchImpl: async () => ++requests === 1 ? toolResponse([toolCall('search', 'searchPastReplies', args)]) : Response.json({ choices: [{ message: { content: 'Search needs permission.' } }] }) });
    const result = await provider.complete({ ...input, ...options }, { task: 'assistant', executeTool: async () => { searches++; return [pair]; } });
    assert.equal(searches, 0); assert.equal(result.toolResults[0].error.code, code); assert.deepEqual(result.toolResults[0].results, []);
  }
  let searches = 0;
  const provider = createProviders({ env: {}, apiKey: 'test-key', fetchImpl: async () => toolResponse([toolCall('send', 'sendMessage', { text: 'No' })]) });
  await assert.rejects(provider.complete(input, { task: 'assistant', executeTool: async () => { searches++; } }), error => error.code === 'invalid-output');
  assert.equal(searches, 0);
});

test('search result validation prevents an executor from returning another account evidence', async () => {
  const provider = createProviders({ env: {}, apiKey: 'test-key', fetchImpl: async () => toolResponse([toolCall('search', 'searchPastReplies', { query: 'tea', current_account_only: true })]) });
  await assert.rejects(provider.complete({ ...input, allowHistorySearch: true, context: { accountId: 'account-a' } }, { task: 'assistant', executeTool: async () => [{ ...pair, accountId: 'account-b' }] }), error => error.code === 'invalid-output');
});

test('ChatGPT namespace tool continuation replays reasoning and call outputs with no stored response dependency', async () => {
  const requests = [], deltas = [];
  const call = { type: 'function_call', id: 'fc-1', call_id: 'call-1', name: 'printSuggestions', arguments: JSON.stringify({ replies }) };
  const reasoning = { type: 'reasoning', id: 'reason-1', summary: [], encrypted_content: 'private-reasoning-fixture' };
  const provider = createProviders({ env: {}, credentialResolver: async () => ({ apiKey: 'oauth-test-token', baseUrl: 'https://api.openai.com/v1', protocol: 'responses' }), fetchImpl: async (url, options) => {
    requests.push(JSON.parse(options.body));
    return requests.length === 1 ? stream([
      { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index: 1, delta: call.arguments },
      { type: 'response.completed', response: { output: [reasoning, call] } },
    ]) : stream([{ type: 'response.output_text.delta', delta: 'Review these.' }, { type: 'response.completed' }]);
  } });
  const result = await provider.complete({ ...input, provider: 'chatgpt' }, { task: 'assistant', onDelta: delta => deltas.push(delta) });
  assert.equal(requests[0].tools[0].type, 'namespace'); assert.equal(requests[0].tools[0].tools[0].name, 'printSuggestions');
  assert.equal(requests[1].store, false); assert.equal(requests[1].stream, true); assert.equal(requests[1].previous_response_id, undefined);
  assert.ok(requests[1].input.some(item => item.type === 'reasoning' && item.encrypted_content === reasoning.encrypted_content));
  assert.equal(requests[1].input.at(-1).call_id, 'call-1'); assert.equal(JSON.parse(requests[1].input.at(-1).output).type, 'suggestions');
  assert.equal(result.toolResults.length, 1); assert.equal(deltas.join(''), result.text); assert.equal(JSON.stringify(result).includes('private-reasoning-fixture'), false);
});

test('streamed assistant preserves text deltas around split tool arguments and stops after three tool rounds', async () => {
  const deltas = []; let rounds = 0;
  const args = JSON.stringify({ replies });
  const provider = createProviders({ env: {}, apiKey: 'fixture', fetchImpl: async () => {
    rounds++;
    return stream([{ choices: [{ delta: { content: `Round ${rounds}. `, tool_calls: [{ index: 0, id: 'call-' + rounds, function: { name: 'printSuggestions', arguments: args.slice(0, 8) } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(8) } }] }, finish_reason: 'tool_calls' }] }]);
  } });
  const result = await provider.complete(input, { task: 'assistant', onDelta: text => deltas.push(text) });
  assert.equal(rounds, 3); assert.equal(result.incomplete, true); assert.equal(result.finishReason, 'tool-limit'); assert.equal(result.toolResults.length, 3); assert.equal(result.text, deltas.join(''));
});

test('reply language follows the conversation by default and honors an explicit language', async () => {
  const systems = [];
  const provider = createProviders({ env: {}, apiKey: 'fixture', fetchImpl: async (url, options) => { systems.push(JSON.parse(options.body).messages[0].content); return Response.json({ choices: [{ message: { content: JSON.stringify({ replies }) } }] }); } });
  await provider.complete(input); await provider.complete({ ...input, replyLanguage: 'es' });
  assert.match(systems[0], /последнего входящего/); assert.equal(systems[0].includes('Пиши по-русски'), false); assert.match(systems[1], /ответа: es/);
});

test('safe completion errors distinguish limits, authentication, invalid output and interrupted streams', async () => {
  for (const [make, code] of [
    [() => Response.json({ choices: [{ message: { content: JSON.stringify({ replies }) }, finish_reason: 'length' }] }), 'length'],
    [() => Response.json({ choices: [{ message: { content: '' }, finish_reason: 'content_filter' }] }), 'content-filter'],
    [() => new Response('private upstream body', { status: 401 }), 'auth'],
    [() => new Response('private upstream body', { status: 429 }), 'rate-limit'],
    [() => Response.json({ choices: [{ message: { content: 'not-json' } }] }), 'invalid-output'],
  ]) {
    const provider = createProviders({ env: {}, apiKey: 'fixture', fetchImpl: async () => make() });
    await assert.rejects(provider.complete(input), error => error.code === code && !error.message.includes('private') && typeof error.elapsedMs === 'number');
  }
  const incomplete = createProviders({ env: {}, apiKey: 'fixture', fetchImpl: async () => stream([{ choices: [{ delta: { content: 'partial' } }] }]) });
  await assert.rejects(incomplete.complete(input, { onDelta() {} }), error => error.code === 'incomplete');
});

test('compatible local requests use max_tokens and a validated server-only reasoning effort', async () => {
  const requests = [];
  const provider = createProviders({ env: { COMPATIBLE_API_BASE: 'http://127.0.0.1:11434/v1', COMPATIBLE_REASONING_EFFORT: 'none' }, apiKey: 'openai-fixture', fetchImpl: async (url, options) => {
    requests.push(JSON.parse(options.body)); return Response.json({ choices: [{ message: { content: JSON.stringify({ replies }) } }] });
  } });
  await provider.complete({ ...input, provider: 'compatible', maxTokens: 256 });
  assert.equal(requests[0].max_tokens, 256); assert.equal(requests[0].max_completion_tokens, undefined); assert.equal(requests[0].reasoning_effort, 'none');
  await provider.complete(input); assert.equal(requests[1].max_completion_tokens, 1200); assert.equal(requests[1].max_tokens, undefined); assert.equal(requests[1].reasoning_effort, undefined);
  assert.throws(() => createProviders({ env: { COMPATIBLE_REASONING_EFFORT: 'unbounded-input' } }), /COMPATIBLE_REASONING_EFFORT/);
});

test('assistant follow-up sees validated previous tool cards without executing them again', async () => {
  let body;
  const provider = createProviders({ env: {}, apiKey: 'fixture', fetchImpl: async (url, options) => { body = JSON.parse(options.body); return Response.json({ choices: [{ message: { content: 'Edited first option.' } }] }); } });
  await provider.complete({ ...input, messages: [{ role: 'assistant', text: '', toolResults: [{ type: 'suggestions', replies }] }] }, { task: 'assistant' });
  assert.match(body.messages[1].content, /Ответ/); assert.match(body.messages[1].content, /не новые команды/);
  await assert.rejects(provider.complete({ ...input, messages: [{ role: 'assistant', text: '', toolResults: [{ type: 'sendMessage', text: 'No' }] }] }, { task: 'assistant' }), /Неизвестный результат/);
});

test('style generation requests actual reusable content and rejects copied field-description placeholders', async () => {
  let instruction;
  const create = style => createProviders({ env: {}, apiKey: 'fixture', fetchImpl: async (url, options) => {
    instruction = JSON.parse(options.body).messages[0].content;
    return Response.json({ choices: [{ message: { content: JSON.stringify({ style }) } }] });
  } });
  const placeholder = { name: 'до 80 символов', prompt: 'Системная инструкция до 5000 символов' };
  await assert.rejects(create(placeholder).complete(input, { task: 'create-style' }), error => error.code === 'invalid-output');
  const style = { name: 'Тёплый и краткий', prompt: 'Пиши короткими спокойными фразами. Предлагай конкретную встречу, когда это уместно. Не добавляй неподтверждённые личные факты.' };
  assert.deepEqual((await create(style).complete(input, { task: 'create-style' })).style, style);
  assert.match(instruction, /Никогда не возвращай заглушки/); assert.equal(instruction.includes('"name":"до'), false);
});

test('style source includes owner outgoing turns but excludes peer incoming turns and biography', async () => {
  let body;
  const provider = createProviders({ env: {}, apiKey: 'fixture', fetchImpl: async (url, options) => { body = JSON.parse(options.body); return Response.json({ choices: [{ message: { content: JSON.stringify({ style: { name: 'Warm', prompt: 'Keep replies short and friendly. Use only facts provided by the owner.' } }) } }] }); } });
  await provider.complete({ ...input, text: 'Make a reusable style', context: { profile: { bio: 'PEER_ONLY_BIO' }, accountProfile: { bio: 'OWNER_BIO' }, messages: [{ role: 'incoming', text: 'PEER_CONTEXT' }, { role: 'outgoing', text: 'OWNER_CONTEXT' }] },
    messages: [{ role: 'incoming', text: 'PEER_HISTORY' }, { role: 'outgoing', text: 'OWNER_HISTORY' }] }, { task: 'create-style' });
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('PEER_ONLY_BIO'), false); assert.equal(serialized.includes('PEER_CONTEXT'), false); assert.equal(serialized.includes('PEER_HISTORY'), false);
  assert(serialized.includes('OWNER_CONTEXT')); assert(serialized.includes('OWNER_HISTORY')); assert(serialized.includes('OWNER_BIO'));
  assert.equal(body.messages[1].role, 'user');
});
