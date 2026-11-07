import test from 'node:test';
import assert from 'node:assert/strict';
import { serverRequest, streamServer } from '../extension/server-client.js';
const options = { canConnect: true, settings: { serverUrl: 'http://127.0.0.1:4318' } };

test('server failures expose only safe typed reason metadata to the UI', async () => {
  await assert.rejects(serverRequest('/assistant', { ...options, fetchImpl: async () => Response.json({ error: 'Увеличьте лимит ответа.', code: 'length', retryable: true, secret: 'never copy' }, { status: 502 }) }), error => {
    assert.equal(error.message, 'Увеличьте лимит ответа.'); assert.equal(error.code, 'length'); assert.equal(error.retryable, true);
    assert.equal(error.secret, undefined); return true;
  });
});

test('HTML failure does not expose response contents as a parser error', async () => {
  await assert.rejects(serverRequest('/catalog', { ...options, fetchImpl: async () => new Response('<secret>private</secret>', { status: 503 }) }), error => /JSON.*503/.test(error.message) && !error.message.includes('private'));
});

test('stream error preserves safe code and incomplete stream cannot succeed', async () => {
  const response = events => new Response(events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
  await assert.rejects(streamServer({}, { ...options, fetchImpl: async () => response([{ type: 'error', error: 'Поток прерван.', code: 'incomplete', retryable: true }]) }), error => error.code === 'incomplete');
  await assert.rejects(streamServer({}, { ...options, fetchImpl: async () => response([{ type: 'result', text: 'Partial' }]) }), /прерван|заверш/);
});
