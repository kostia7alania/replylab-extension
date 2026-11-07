import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway } from '../scripts/gateway.mjs';

const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const HEADERS = { 'Content-Type': 'application/json', 'X-ReplyLab': '1', Origin: ORIGIN };
const INPUT = { text: 'Как прошёл день?', tone: 'friendly', model: 'test-model' };
const REPLIES = [1, 2, 3].map(number => ({ text: `Ответ ${number}`, reason: `Причина ${number}` }));

async function gateway(t, options = {}) {
  const server = createGateway({ env: {}, ...options });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}/replies`;
}

function post(url, { headers = HEADERS, input = INPUT } = {}) {
  return fetch(url, { method: 'POST', headers, body: JSON.stringify(input) });
}

function postWithHost(url, host) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: 'POST', headers: { ...HEADERS, Host: host } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    request.on('error', reject);
    request.end(JSON.stringify(INPUT));
  });
}

test('gateway rejects web origins, missing marker and non-local Host before calling upstream', async t => {
  let calls = 0;
  const url = await gateway(t, { apiKey: 'test-key', fetchImpl: async () => { calls++; throw new Error(); } });
  const web = await post(url, { headers: { ...HEADERS, Origin: 'https://example.test' } });
  assert.equal(web.status, 403);
  assert.equal(web.headers.get('access-control-allow-origin'), null);
  const missing = await post(url, { headers: { 'Content-Type': 'application/json', Origin: ORIGIN } });
  assert.equal(missing.status, 403);
  assert.equal(await postWithHost(url, 'example.test'), 403);
  assert.equal(calls, 0);
});

test('valid extension preflight declares only the expected method and headers', async t => {
  const url = await gateway(t);
  const response = await fetch(url, { method: 'OPTIONS', headers: { Origin: ORIGIN } });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(response.headers.get('access-control-allow-headers'), 'Content-Type, X-ReplyLab');
  assert.equal(response.headers.get('access-control-allow-methods'), 'POST, OPTIONS');
});

test('missing key gives a readable local error without a mock fallback', async t => {
  const url = await gateway(t);
  const response = await post(url);
  assert.equal(response.status, 503);
  const result = await response.json();
  assert.match(result.error, /OPENAI_API_KEY/);
  assert.equal(result.replies, undefined);
});

test('oversized body, long or empty text and missing model are rejected locally', async t => {
  let calls = 0;
  const url = await gateway(t, { apiKey: 'test-key', fetchImpl: async () => { calls++; throw new Error(); } });
  assert.equal((await post(url, { input: { ...INPUT, text: 'x'.repeat(9 * 1024 * 1024) } })).status, 413);
  assert.equal((await post(url, { input: { ...INPUT, text: 'я'.repeat(10001) } })).status, 400);
  assert.equal((await post(url, { input: { ...INPUT, text: '  ' } })).status, 400);
  assert.equal((await post(url, { input: { text: 'Привет' } })).status, 400);
  assert.equal(calls, 0);
});

test('successful request uses fixed HTTPS upstream and server-only credentials', async t => {
  let captured;
  const url = await gateway(t, {
    apiKey: 'server-only-test-key',
    fetchImpl: async (upstreamUrl, options) => {
      captured = { upstreamUrl, options };
      return Response.json({ choices: [{ message: { content: JSON.stringify({ replies: REPLIES }) } }] });
    },
  });
  const response = await post(url);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), ORIGIN);
  const raw = await response.text();
  assert.equal(raw.includes('server-only-test-key'), false);
  assert.deepEqual(JSON.parse(raw), { replies: REPLIES });
  assert.equal(captured.upstreamUrl, 'https://api.openai.com/v1/chat/completions');
  assert.equal(captured.options.method, 'POST');
  assert.equal(captured.options.redirect, 'error');
  assert.equal(captured.options.headers.Authorization, 'Bearer server-only-test-key');
  assert.ok(captured.options.signal instanceof AbortSignal);
  const body = JSON.parse(captured.options.body);
  assert.equal(body.model, INPUT.model);
  assert.equal(body.messages[1].content, INPUT.text);
  assert.deepEqual(body.response_format, { type: 'json_object' });
});

test('local CLI may omit Origin while retaining request marker', async t => {
  const url = await gateway(t, {
    apiKey: 'test-key',
    fetchImpl: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ replies: REPLIES }) } }] }),
  });
  const response = await post(url, { headers: { 'Content-Type': 'application/json', 'X-ReplyLab': '1' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), null);
});

test('malformed or failed upstream responses remain generic and never expose upstream bodies', async t => {
  for (const result of [
    () => Response.json({ choices: [{ message: { content: 'not json' } }] }),
    () => Response.json({ choices: [{ message: { content: JSON.stringify({ replies: REPLIES.slice(0, 2) }) } }] }),
    () => Response.json({ choices: [{ message: { content: JSON.stringify({ replies: [{ text: '', reason: 'x' }, ...REPLIES.slice(1)] }) } }] }),
    () => new Response('secret-upstream-error', { status: 401 }),
  ]) {
    const url = await gateway(t, { apiKey: 'secret-upstream-key', fetchImpl: async () => result() });
    const response = await post(url);
    assert.equal(response.status, 502);
    const raw = await response.text();
    assert.equal(raw.includes('secret-upstream'), false);
    assert.match(JSON.parse(raw).error, /GPT/);
    assert.equal(JSON.parse(raw).replies, undefined);
  }
});

async function backend(t, options = {}) {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const directory = await mkdtemp(join(tmpdir(), 'replylab-backend-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return (await gateway(t, { directory, ...options })).replace(/\/replies$/, '');
}

test('authenticated persistent sync/import/search and analytics share one data contract', async t => {
  const base = await backend(t, { serverToken: 'owner-test-token' });
  const headers = { ...HEADERS, Authorization: 'Bearer owner-test-token' };
  assert.equal((await fetch(`${base}/sync`, { headers: HEADERS })).status, 401);
  const state = { version: 1, conversations: [{ id: 'chat', messages: [{ id: 'm', role: 'user', text: 'Ёлка и кофе' }] }], notes: { chat: { text: 'КОФЕ завтра' } }, events: [{ id: 'e', kind: 'like', createdAt: new Date().toISOString() }] };
  const imported = await (await post(`${base}/import`, { headers, input: { format: 'replylab-library', state } })).json();
  assert.equal(imported.revision, 1);
  const saved = await (await fetch(`${base}/sync`, { headers })).json();
  assert.equal(saved.state.conversations[0].messages[0].text, 'Ёлка и кофе');
  assert.equal((await (await fetch(`${base}/search?q=${encodeURIComponent('кофе')}`, { headers })).json()).results.length, 2);
  assert.equal((await (await fetch(`${base}/analytics?tz=UTC`, { headers })).json()).likes, 1);
  assert.equal((await fetch(`${base}/analytics?tz=Invalid`, { headers })).status, 400);
  const preflight = await fetch(`${base}/sync`, { method: 'OPTIONS', headers: { Origin: ORIGIN } });
  assert.match(preflight.headers.get('access-control-allow-methods'), /GET/);
});

test('public token share is escaped/noindex and authenticated revocation makes it unavailable', async t => {
  const base = await backend(t, { serverToken: 'owner-test-token' });
  const headers = { ...HEADERS, Authorization: 'Bearer owner-test-token' };
  const result = await (await post(`${base}/shares`, { headers, input: { conversation: { title: '<script>title</script>', messages: [{ role: 'user', text: '<script>alert(1)</script>' }] }, ttlHours: 1 } })).json();
  const shared = await fetch(`${base}/s/${result.token}`);
  assert.equal(shared.status, 200); assert.match(shared.headers.get('x-robots-tag'), /noindex/);
  const html = await shared.text(); assert.equal(html.includes('<script>'), false); assert.match(html, /&lt;script&gt;/);
  assert.equal((await fetch(`${base}/shares/${result.token}`, { method: 'DELETE', headers })).status, 200);
  assert.equal((await fetch(`${base}/s/${result.token}`)).status, 404);
});

test('stream route relays genuine upstream deltas and persists completed assistant session', async t => {
  const base = await backend(t, { apiKey: 'server-test-key', fetchImpl: async () => new Response(new ReadableStream({ start(controller) {
    for (const text of ['Первая ', 'вторая']) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`));
    controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close();
  } })) });
  const response = await post(`${base}/stream`, { input: { ...INPUT, task: 'assistant', sessionId: 'session' } });
  assert.match(response.headers.get('content-type'), /event-stream/);
  const text = await response.text(); assert.equal((text.match(/event: delta/g) ?? []).length, 2); assert.match(text, /event: result/); assert.match(text, /event: done/);
  const state = await (await fetch(`${base}/sync`, { headers: HEADERS })).json();
  assert.equal(state.state.assistantChats[0].messages[1].text, 'Первая вторая');
});

test('aborting client request aborts provider fetch instead of continuing generation', async t => {
  let entered; const started = new Promise(resolve => { entered = resolve; }); let providerSignal;
  const base = await backend(t, { apiKey: 'server-test-key', fetchImpl: async (url, options) => {
    providerSignal = options.signal; entered();
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
  } });
  const controller = new AbortController();
  const request = fetch(`${base}/assistant`, { method: 'POST', headers: HEADERS, body: JSON.stringify(INPUT), signal: controller.signal }).catch(error => error);
  await started; controller.abort(); await request;
  for (let attempts = 0; !providerSignal.aborted && attempts < 20; attempts++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(providerSignal.aborted, true);
});

test('OAuth routes use injected service, protect start and allow only state-validated callback', async t => {
  const oauth = {
    start: async (provider, base) => ({ url: `https://example.test/authorize?provider=${provider}`, callbackBase: base }),
    status: async () => ({ accounts: [] }),
    callback: async url => { if (url.searchParams.get('state') !== 'valid') throw new Error('private-state-detail'); return { provider: 'chatgpt', connected: true }; },
  };
  const base = await backend(t, { oauth, serverToken: 'owner-test-token' });
  assert.equal((await post(`${base}/oauth/start`, { input: { provider: 'chatgpt' } })).status, 401);
  const result = await (await post(`${base}/oauth/start`, { headers: { ...HEADERS, Authorization: 'Bearer owner-test-token' }, input: { provider: 'chatgpt' } })).json();
  assert.match(result.callbackBase, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal((await fetch(`${base}/auth/callback?state=valid`)).status, 200);
  const invalid = await fetch(`${base}/auth/callback?state=wrong`); assert.equal(invalid.status, 400); assert.equal((await invalid.text()).includes('private-state-detail'), false);
});

test('schedule claim endpoint is token-protected and second device gets conflict', async t => {
  const base = await backend(t, { serverToken: 'owner-test-token' });
  const headers = { ...HEADERS, Authorization: 'Bearer owner-test-token' };
  const fireAt = new Date(Date.now() - 1000).toISOString();
  await post(`${base}/sync`, { headers, input: { schedules: [{ id: 's', chatId: 'c', text: 'Ответ', fireAt, status: 'scheduled', incomingSnapshot: '' }] } });
  const input = { id: 's', fireAt, deviceId: 'a', incomingSnapshot: '' };
  assert.equal((await post(`${base}/schedules/claim`, { input })).status, 401);
  assert.equal((await post(`${base}/schedules/claim`, { headers, input })).status, 200);
  assert.equal((await post(`${base}/schedules/claim`, { headers, input: { ...input, deviceId: 'b' } })).status, 409);
});

test('provider usage endpoint requires authentication and never exposes provider key details', async t => {
  const base = await backend(t, { serverToken: 'owner-test-token', env: { OPENROUTER_API_KEY: 'provider-private-test-key' }, fetchImpl: async url => {
    assert.equal(url, 'https://openrouter.ai/api/v1/key'); return Response.json({ data: { usage: 1.5, limit: 5, limit_remaining: 3.5, label: 'private-label', hash: 'private-hash' } });
  } });
  assert.equal((await fetch(`${base}/provider-usage?provider=openrouter`, { headers: HEADERS })).status, 401);
  const response = await fetch(`${base}/provider-usage?provider=openrouter`, { headers: { ...HEADERS, Authorization: 'Bearer owner-test-token' } });
  assert.equal(response.status, 200); const text = await response.text(); assert.equal(text.includes('private-'), false); assert.equal(JSON.parse(text).remaining, 3.5);
});
