import test from 'node:test';
import assert from 'node:assert/strict';
import { generateReplies, prepareTask } from '../extension/generation.js';
import { fixture } from '../extension/core.js';

const input = { text: 'Привет! Как прошёл день?', tone: 'friendly' };
const noNetwork = () => { throw new Error('Unexpected network request'); };

test('photo consent controls actual vision attachments as well as context URLs', () => {
  const payload = { text: 'hello', context: { profile: { photos: ['https://example.test/photo.jpg'] } } };
  assert.deepEqual(prepareTask('replies', payload, {}).attachments, []);
  assert.deepEqual(prepareTask('replies', payload, {}).context.profile.photos, []);
  assert.deepEqual(prepareTask('replies', { ...payload, includePhotos: true }, {}).attachments, ['https://example.test/photo.jpg']);
});

test('local generation never uses network and expired profiles cannot generate', async () => {
  assert.equal((await generateReplies(input, { user: fixture('active'), fetchImpl: noNetwork })).length, 3);
  await assert.rejects(generateReplies(input, { user: fixture('expired'), fetchImpl: noNetwork }), /REPLYLAB-LOCAL/);
});

test('GPT requires explicit local connector permission and a model before networking', async () => {
  const state = { user: fixture('active'), mode: 'gpt', fetchImpl: noNetwork };
  await assert.rejects(generateReplies(input, state), /Разрешите/);
  await assert.rejects(generateReplies(input, { ...state, canConnect: true }), /модель/);
});

test('GPT shares the connector contract and never redirects', async () => {
  let calls = 0;
  const expected = [1, 2, 3].map((n) => ({ text: `Ответ ${n}`, reason: 'Пример' }));
  const replies = await generateReplies(input, { user: fixture('active'), mode: 'gpt', model: 'test-model', canConnect: true,
    fetchImpl: async (url, options) => {
      calls++;
      assert.equal(url, 'http://127.0.0.1:4318/replies');
      assert.equal(options.redirect, 'error');
      assert.deepEqual(JSON.parse(options.body), { ...input, model: 'test-model' });
      return { ok: true, json: async () => ({ replies: expected }) };
    },
  });
  assert.equal(calls, 1); assert.deepEqual(replies, expected);
});

test('malformed remote replies fail instead of falling back to local replies', async () => {
  await assert.rejects(generateReplies(input, { user: fixture('active'), mode: 'gpt', model: 'test-model', canConnect: true,
    fetchImpl: async () => ({ ok: true, json: async () => ({ replies: [{ text: '<script>bad</script>' }] }) }),
  }), /неверный формат/);
});
