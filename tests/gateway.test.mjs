import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createGateway } from '../scripts/gateway.mjs';

const ORIGIN = `chrome-extension://${'a'.repeat(32)}`;
const HEADERS = { 'Content-Type': 'application/json', 'X-ReplyLab': '1', Origin: ORIGIN };
const INPUT = { text: 'Как прошёл день?', tone: 'friendly', model: 'test-model' };
const REPLIES = [1, 2, 3].map(number => ({ text: `Ответ ${number}`, reason: `Причина ${number}` }));

async function gateway(t, options = {}) {
  const server = createGateway(options);
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
  assert.equal((await post(url, { input: { ...INPUT, text: 'x'.repeat(70000) } })).status, 413);
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
