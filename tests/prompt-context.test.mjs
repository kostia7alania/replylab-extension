import test from 'node:test';
import assert from 'node:assert/strict';
import { templateValues, contextualTranscript, searchOwnPastReplies, assistantPrompt } from '../extension/prompt-context.js';

test('template values preserve owner/person rich context and known times without inventing dates', () => {
  const context = { platform: 'tinder', accountProfile: { name: 'Owner', bio: 'Tea', interests: ['hiking'] },
    profile: { name: 'Person', bio: 'Coffee', interests: ['books'], descriptors: [{ name: 'Language', value: 'English' }],
      userPrompts: [{ question: 'Weekend?', answer: 'Mountains' }], spotify: { themeTrack: { name: 'Track', artists: ['Artist'] } } },
    messages: [{ role: 'user', text: 'Hello', createdAt: '2026-11-07T12:00:00Z' }, { role: 'assistant', text: 'Hi', createdAt: null }] };
  const values = templateValues(context, { now: Date.parse('2026-11-07T13:00:00Z'), notes: 'Note', memories: [{ text: 'Fact' }] });
  assert.equal(values.accountName, 'Owner'); assert.equal(values.accountBio, 'Tea'); assert.equal(values.personName, 'Person');
  assert.match(values.aboutAccountProfile, /hiking/); assert.match(values.aboutPersonProfile, /Mountains/);
  assert.match(values.aboutPersonProfile, /Track \(Artist\)/); assert.match(values.transcript, /1 h ago/);
  assert.match(values.transcript, /time unknown.*Person: Hi/); assert.equal(values.memories, 'Fact');
});

test('unknown or future timestamps are explicit and transcript never manufactures a sender', () => {
  const result = contextualTranscript({ messages: [{ role: 'unknown', text: 'A', createdAt: null }, { role: 'user', text: 'B', createdAt: '2099-01-01T00:00:00Z' }] });
  assert.match(result, /time unknown.*Unknown author/); assert.match(result, /future timestamp/);
});

test('past reply retrieval is account/platform scoped and retains both sides and reply provenance', () => {
  const conversation = (id, accountId, platform) => ({ id, chatId: id, accountId, platform, messages: [
    { id: 'in', role: 'assistant', text: 'Coffee tomorrow?' }, { id: 'out', role: 'user', text: 'Yes, afternoon.', createdAt: null }] });
  const all = [conversation('mine', 'A', 'tinder'), conversation('other', 'B', 'tinder'), conversation('platform', 'A', 'whatsapp')];
  const matches = searchOwnPastReplies(all, 'coffee', { accountId: 'A', platform: 'tinder' });
  assert.deepEqual(matches.map(item => item.conversationId), ['mine']); assert.equal(matches[0].theirText, 'Coffee tomorrow?');
  assert.equal(matches[0].myReply, 'Yes, afternoon.'); assert.equal(matches[0].sentAt, null);
  assert.deepEqual(searchOwnPastReplies(all, 'coffee', {}), []);
  assert.equal(searchOwnPastReplies(all, 'coffee', {}, { allAccounts: true }).length, 3);
});

test('default and custom assistant prompts use the requested context without mixing scopes', () => {
  assert.match(assistantPrompt({}, 'profile'), /owner profile/);
  assert.equal(assistantPrompt({ assistantPrompts: { useCustom: true, base: 'Base', chat: 'Chat', profile: 'Profile' } }, 'chat'), 'Base\n\nChat');
});
