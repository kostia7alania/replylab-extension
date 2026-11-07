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

test('rich owner/person variables and scoped notes reach the prompt without leaking another account', () => {
  const context = { platform: 'tinder', accountId: 'A', chatId: 'peer', profile: { name: 'Alice', bio: 'Books', interests: ['hiking'] }, accountProfile: { name: 'Alex', bio: 'Cycling' }, messages: [] };
  const state = { settings: { replyLanguage: 'en' }, styles: [], memories: [], notes: { peer: { text: 'Ambiguous private note', updatedAt: new Date().toISOString() } }, conversations: [
    { id: 'A-peer', platform: 'tinder', accountId: 'A', chatId: 'peer', messages: [] },
    { id: 'B-peer', platform: 'tinder', accountId: 'B', chatId: 'peer', messages: [] },
  ] };
  const result = prepareTask('replies', { text: 'Reply', context, notes: 'Unsafe legacy fallback', systemPrompt: '{accountName}: {{accountBio}} / {personName}: {aboutPersonProfile} / {notes}' }, { library: state });
  assert.match(result.systemPrompt, /Alex: Cycling/); assert.match(result.systemPrompt, /Alice/); assert.match(result.systemPrompt, /hiking/);
  assert.equal(result.systemPrompt.includes('private note'), false); assert.equal(result.systemPrompt.includes('legacy fallback'), false);
  assert.equal(result.replyLanguage, 'en');
});

test('profile-only assistant context excludes the other person and their conversation', () => {
  const context = { platform: 'tinder', accountId: 'A', chatId: 'peer', profile: { name: 'Other', photos: ['https://example.test/other.jpg'] }, accountProfile: { name: 'Owner', photos: ['https://example.test/me.jpg'] }, messages: [{ role: 'assistant', text: 'Private chat text' }] };
  const result = prepareTask('assistant', { text: 'Review my profile', contextKind: 'profile', context, includePhotos: true }, {});
  assert.equal(result.context.profile, null); assert.deepEqual(result.context.messages, []);
  assert.deepEqual(result.attachments, ['https://example.test/me.jpg']);
});

test('follow-up assistant messages keep reviewed tool results as history data', () => {
  const toolResults = [{ type: 'suggestions', replies: [{ text: 'A', reason: 'Reason' }] }];
  const result = prepareTask('assistant', { messages: [{ role: 'user', text: 'Suggest' }, { role: 'assistant', text: 'Options', toolResults }, { role: 'user', text: 'Change the first' }] }, {});
  assert.equal(result.text, 'Change the first'); assert.deepEqual(result.messages[1].toolResults, toolResults);
});

test('style creation excludes the other person biography and incoming conversation facts', () => {
  const result = prepareTask('create-style', { text: 'Create a warm style', context: { platform: 'tinder', accountId: 'A', chatId: 'peer',
    accountProfile: { name: 'Alex', bio: 'Cycling' }, profile: { name: 'Alice', bio: 'Hiking and coffee' },
    messages: [{ role: 'assistant', text: 'My hobby is hiking' }, { role: 'user', text: 'Nice to meet you' }] } }, {});
  assert.equal(result.context.profile, null); assert.equal(result.context.accountProfile.bio, 'Cycling');
  assert.deepEqual(result.context.messages.map(item => item.text), ['Nice to meet you']);
});
