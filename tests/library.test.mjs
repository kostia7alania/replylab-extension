import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibrary, initialLibrary, mergeLibraries, renderStyle, validateLibrary, PROFILE_FIELDS, normalizeStoredProfile, getConversationKey, getNoteKey, getConversationNote } from '../extension/library.js';

function harness() {
  let state = {}, rejectWrite = false;
  const adapter = {
    async get() { await new Promise(resolve => setTimeout(resolve, 1)); return structuredClone(state); },
    async set(value) { if (rejectWrite) throw new Error('Storage full'); await new Promise(resolve => setTimeout(resolve, 1)); state = structuredClone(value); },
  };
  return { library: createLibrary(adapter), snapshot: () => structuredClone(state), reject(value) { rejectWrite = value; }, inject(value) { state = value; } };
}

test('serialized concurrent mutations retain every record and returned state is detached', async () => {
  const { library } = harness();
  await Promise.all(Array.from({ length: 25 }, (_, index) => library.dispatch('save-memory', { memory: { id: 'm-' + index, text: String(index) } })));
  const state = await library.getState();
  assert.equal(state.memories.length, 25);
  state.memories[0].text = 'mutated outside storage';
  assert.notEqual((await library.getState()).memories[0].text, state.memories[0].text);
});

test('invalid import never writes and cannot pollute object prototypes', async () => {
  const h = harness();
  await h.library.dispatch('save-note', { chatId: 'chat-1', text: 'keep' });
  const before = h.snapshot();
  await assert.rejects(h.library.dispatch('import', { data: JSON.parse('{"version":1,"__proto__":{"polluted":true}}') }));
  await assert.rejects(h.library.dispatch('save-note', { chatId: '__proto__', text: 'bad' }));
  assert.deepEqual(h.snapshot(), before);
  assert.equal({}.polluted, undefined);
});

test('unknown nested fields, invalid dates and unsafe attachment formats are rejected', () => {
  const state = initialLibrary();
  assert.throws(() => validateLibrary({ ...state, styles: [{ id: 'bad', prompt: '', endpoint: 'arbitrary' }] }));
  assert.throws(() => validateLibrary({ ...state, memories: [{ id: 'bad', text: 'x', updatedAt: 'invalid' }] }));
  assert.throws(() => validateLibrary({ ...state, assistantChats: [{ id: 'bad', messages: [{ role: 'user', text: '', attachments: [{ name: 'x.svg', mimeType: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,AAAA' }] }] }] }));
});

test('chat session/message limits reject without deleting existing history', async () => {
  const h = harness();
  for (let index = 0; index < 20; index++) await h.library.dispatch('save-chat', { chat: { id: 'c-' + index, messages: [] } });
  const before = h.snapshot();
  await assert.rejects(h.library.dispatch('save-chat', { chat: { id: 'overflow', messages: [] } }), /20/);
  assert.deepEqual(h.snapshot(), before);
  await assert.rejects(h.library.dispatch('save-chat', { chat: { id: 'c-0', messages: Array.from({ length: 41 }, (_, index) => ({ id: 'msg-' + index, role: 'user', text: 'x' })) } }), /40/);
  assert.deepEqual(h.snapshot(), before);
});

test('stale snapshots of the same assistant chat merge messages instead of losing a reply', async () => {
  const { library } = harness();
  await library.dispatch('save-chat', { chat: { id: 'chat', messages: [{ id: 'a', role: 'user', text: 'first' }] } });
  await Promise.all([
    library.dispatch('save-chat', { chat: { id: 'chat', messages: [{ id: 'b', role: 'assistant', text: 'answer' }] } }),
    library.dispatch('save-chat', { chat: { id: 'chat', messages: [{ id: 'c', role: 'user', text: 'next' }] } }),
  ]);
  assert.deepEqual((await library.getState()).assistantChats[0].messages.map(item => item.id), ['a', 'b', 'c']);
});

test('partial conversation captures accumulate identified messages', async () => {
  const { library } = harness();
  await library.dispatch('capture', { conversation: { chatId: 'one', messages: [{ id: '1', role: 'incoming', text: 'one' }] } });
  await library.dispatch('capture', { conversation: { chatId: 'one', messages: [{ id: '2', role: 'outgoing', text: 'two' }] } });
  assert.equal((await library.getState()).conversations[0].messages.length, 2);
});

test('export/import round trip, replace confirmation and tombstones preserve integrity', async () => {
  const { library } = harness();
  await library.dispatch('save-memory', { memory: { id: 'one', text: 'valuable' } });
  const exported = await library.dispatch('export');
  assert.equal(exported.format, 'replylab-library');
  await assert.rejects(library.dispatch('import', { data: exported, mode: 'replace' }), /confirmReplace/);
  await library.dispatch('delete-memory', { id: 'one' });
  const deleted = await library.getState();
  const stale = structuredClone(exported.state);
  stale.memories[0].updatedAt = deleted.memories[0].updatedAt;
  const merged = mergeLibraries(deleted, stale);
  assert.equal(merged.memories[0].deleted, true);
  await library.dispatch('import', { data: exported, mode: 'replace', confirmReplace: true });
  assert.equal((await library.getState()).memories[0].text, 'valuable');
});

test('failed storage writes do not poison the operation queue or overwrite prior data', async () => {
  const h = harness();
  await h.library.dispatch('save-note', { chatId: 'c', text: 'old' });
  h.reject(true);
  await assert.rejects(h.library.dispatch('save-note', { chatId: 'c', text: 'new' }), /Storage full/);
  h.reject(false);
  assert.equal((await h.library.getState()).notes.c.text, 'old');
  await h.library.dispatch('save-note', { chatId: 'c', text: 'recovered' });
  assert.equal((await h.library.getState()).notes.c.text, 'recovered');
});

test('automatic schedule claim is atomic and requires exact context and opt-in', async () => {
  const { library } = harness();
  await library.dispatch('schedule', { item: { id: 's', chatId: 'chat', text: 'hello', fireAt: '2020-01-01T00:00:00Z', sendMode: 'automatic', incomingSnapshot: 'unchanged' } });
  await assert.rejects(library.dispatch('claim-schedule', { id: 's', chatId: 'chat', incomingSnapshot: 'unchanged' }));
  await library.dispatch('save-settings', { settings: { autoSendEnabled: true } });
  await assert.rejects(library.dispatch('claim-schedule', { id: 's', chatId: 'chat', incomingSnapshot: 'changed' }));
  const attempts = await Promise.allSettled([1, 2].map(() => library.dispatch('claim-schedule', { id: 's', chatId: 'chat', incomingSnapshot: 'unchanged' })));
  assert.equal(attempts.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await library.getState()).schedules[0].status, 'firing');
  await assert.rejects(library.dispatch('reschedule', { id: 's', fireAt: '2030-01-01T00:00:00Z' }));
  await assert.rejects(library.dispatch('cancel-schedule', { id: 's' }), /уже выполняется/);
  assert.equal((await library.getState()).schedules[0].status, 'firing');
  await library.dispatch('complete-schedule', { id: 's', status: 'failed', error: 'uncertain outcome' });
  await assert.rejects(library.dispatch('claim-schedule', { id: 's', chatId: 'chat', incomingSnapshot: 'unchanged' }));
});

test('style variables are literal replacements and count/token contracts are integers', () => {
  assert.equal(renderStyle('{{name}} / {{transcript}} / {{unknown}}', { name: '<img>', transcript: '$&' }), '<img> / $& / {{unknown}}');
  assert.throws(() => validateLibrary({ ...initialLibrary(), styles: [{ suggestionCount: 1.5 }] }));
  assert.throws(() => validateLibrary({ ...initialLibrary(), styles: [{ maxTokens: 15 }] }));
  assert.equal(initialLibrary().styles[0].useHistory, false);
  assert.equal(validateLibrary({ ...initialLibrary(), styles: [{ id: 'history-style', useHistory: true }] }).styles[0].useHistory, true);
});

test('captured messages retain unknown sender and unknown time without inventing either', () => {
  const state = validateLibrary({ ...initialLibrary(), conversations: [{ chatId: 'rendered', messages: [{ text: 'observed', role: 'unknown', createdAt: null }] }] });
  assert.equal(state.conversations[0].messages[0].createdAt, null);
  assert.equal(state.conversations[0].messages[0].role, 'unknown');
});

test('merging independent histories retains both identified messages', () => {
  const left = validateLibrary({ ...initialLibrary(), conversations: [{ id: 'chat', chatId: 'chat', updatedAt: '2026-01-01T00:00:00Z', messages: [{ id: 'old', role: 'unknown', text: 'old' }] }] });
  const right = validateLibrary({ ...initialLibrary(), conversations: [{ id: 'chat', chatId: 'chat', updatedAt: '2026-02-01T00:00:00Z', messages: [{ id: 'new', role: 'unknown', text: 'new' }] }] });
  assert.deepEqual(mergeLibraries(left, right).conversations[0].messages.map(message => message.id), ['old', 'new']);
  assert.deepEqual(mergeLibraries(right, left).conversations[0].messages.map(message => message.id), ['old', 'new']);
});

test('invalid stored data remains untouched and can be exported for recovery', async () => {
  const h = harness();
  const invalid = { library: { version: 99, unknown: 'preserve me' } };
  h.inject(structuredClone(invalid));
  await assert.rejects(h.library.getState());
  const recovery = await h.library.dispatch('export', { raw: true });
  assert.equal(recovery.format, 'replylab-library-recovery');
  assert.deepEqual(recovery.state, invalid.library);
  assert.deepEqual(h.snapshot(), invalid);
});

test('preferences and observed profile metadata survive persistence without inferred defaults', async () => {
  const { library } = harness();
  const settings = (await library.getState()).settings;
  assert.equal(settings.sendOnEnter, false); assert.equal(settings.showProfile, true);
  assert.equal(settings.onboardingCompleted, false); assert.equal(settings.suggestionProvider, '');
  await library.dispatch('save-settings', { settings: { sendOnEnter: true, showTools: false, assistantProvider: 'chatgpt', suggestionProvider: 'compatible', onboardingCompleted: true, devMode: true } });
  await library.dispatch('record-event', { event: { kind: 'like-observed', profile: { id: 'observed', age: 32, city: 'Oslo', bio: 'Observed profile' } } });
  const state = await library.getState();
  assert.equal(state.settings.assistantProvider, 'chatgpt'); assert.equal(state.settings.showTools, false);
  assert.equal(state.settings.onboardingCompleted, true);
  assert.equal(state.events[0].profile.age, 32); assert.equal(state.events[0].profile.city, 'Oslo');
});

test('schedule jitter is bounded, stored once and is not reapplied by validation or import', async () => {
  const { library } = harness();
  const requested = '2030-01-01T10:00:00.000Z';
  await library.dispatch('schedule', { item: { id: 'variation', chatId: 'c', text: 'hello', fireAt: requested, variationSeconds: 60, skipIfNewMessage: false } });
  const first = (await library.getState()).schedules[0];
  assert.equal(first.requestedFor, requested);
  assert.ok(Math.abs(Date.parse(first.fireAt) - Date.parse(requested)) <= 60000);
  const exported = await library.dispatch('export');
  await library.dispatch('import', { data: exported, mode: 'merge' });
  assert.equal((await library.getState()).schedules[0].fireAt, first.fireAt);
});

test('automatic schedules cannot turn off the new-message guard', async () => {
  const h = harness();
  await assert.rejects(h.library.dispatch('schedule', { item: { chatId: 'c', text: 'hello', fireAt: '2030-01-01T00:00:00Z', sendMode: 'automatic', skipIfNewMessage: false } }), /Автоотправка/);
  assert.equal(h.snapshot().library, undefined);
});

test('schedule claims reject a stale expected record atomically', async () => {
  const { library } = harness();
  await library.dispatch('save-settings', { settings: { autoSendEnabled: true } });
  await library.dispatch('schedule', { item: { id: 'stale-claim', chatId: 'c', text: 'before edit', fireAt: '2020-01-01T00:00:00Z', sendMode: 'automatic', incomingSnapshot: 'same' } });
  const original = (await library.getState()).schedules[0];
  await library.dispatch('schedule', { item: { ...original, text: 'edited' } });
  await assert.rejects(library.dispatch('claim-schedule', { id: original.id, chatId: 'c', incomingSnapshot: 'same',
    expected: { fireAt: original.fireAt, text: original.text, updatedAt: original.updatedAt } }), /изменилась/);
  assert.equal((await library.getState()).schedules[0].status, 'scheduled');
});

test('conversation account identity is retained but never inferred', () => {
  const state = validateLibrary({ ...initialLibrary(), conversations: [{ chatId: 'known', accountId: 'verified', messages: [] }, { chatId: 'unknown', messages: [] }] });
  assert.equal(state.conversations[0].accountId, 'verified');
  assert.equal(state.conversations[1].accountId, '');
});

test('rich profiles and owner profiles retain only bounded evidenced fields', () => {
  const profile = normalizeStoredProfile({ id: 'person', name: 'Person', age: 29, city: 'Oslo', interests: ['Climbing'],
    descriptors: [{ id: 'education', name: 'Education', type: 'choice', value: 'University' }],
    userPrompts: [{ id: 'prompt', question: 'Question?', answer: 'Answer' }],
    spotify: { themeTrack: { name: 'Track', artists: ['Artist'] } }, birthDate: null });
  assert.equal(profile.userPrompts[0].answer, 'Answer'); assert.equal(profile.spotify.themeTrack.artists[0], 'Artist');
  assert.equal(profile.birthDate, null); assert.equal(profile.richPartial, true);
  const state = validateLibrary({ ...initialLibrary(), conversations: [{ id: 'legacy-id', chatId: 'chat', accountId: 'owner', profile, accountProfile: { id: 'owner', name: 'Owner', bio: 'Owner bio' } }] });
  assert.equal(state.conversations[0].id, 'legacy-id');
  assert.equal(state.conversations[0].accountProfile.bio, 'Owner bio');
  assert.deepEqual(Object.keys(profile).sort(), [...PROFILE_FIELDS].sort());
  assert.throws(() => normalizeStoredProfile({ arbitraryPrivateData: true }));
  assert.throws(() => normalizeStoredProfile({ photos: ['https://user:password@example.test/image.jpg'] }));
  assert.throws(() => normalizeStoredProfile({ interests: Array(101).fill('too many') }));
  assert.throws(() => validateLibrary({ ...state, conversations: [{ ...state.conversations[0], accountProfile: { id: 'wrong-owner' } }] }), /не соответствует/);
});

test('canonical keys isolate accounts and never truncate or rewrite legacy identities', () => {
  const first = getConversationKey({ platform: 'tinder', accountId: 'a:b', chatId: 'c' });
  const second = getConversationKey({ platform: 'tinder', accountId: 'a', chatId: 'b:c' });
  assert.notEqual(first, second);
  assert.equal(getNoteKey({ id: 'legacy-id', chatId: 'c' }), 'legacy-id');
  assert.throws(() => getConversationKey({ platform: 'tinder', accountId: '😀'.repeat(100), chatId: '😀'.repeat(100) }), /ID/);
});

test('account-scoped notes never fall back across ambiguous accounts', async () => {
  const { library } = harness();
  await library.dispatch('save-note', { chatId: 'same', text: 'legacy owner unknown' });
  const one = { chatId: 'same', platform: 'tinder', accountId: 'one', messages: [] };
  const two = { chatId: 'same', platform: 'tinder', accountId: 'two', messages: [] };
  await library.dispatch('capture', { conversation: one });
  assert.equal(getConversationNote(await library.getState(), one).text, 'legacy owner unknown');
  await library.dispatch('capture', { conversation: two });
  assert.equal(getConversationNote(await library.getState(), one), null);
  await assert.rejects(library.dispatch('save-note', { chatId: 'same', text: 'ambiguous' }), /Неоднозначный/);
  await library.dispatch('save-note', { conversation: one, text: 'only one' });
  await library.dispatch('append-note', { ...one, text: 'more' });
  const state = await library.getState();
  assert.equal(getConversationNote(state, one).text, 'only one\nmore');
  assert.equal(getConversationNote(state, two), null);
  assert.equal(getConversationNote(state, { ...two, id: getConversationKey(one) }), null);
  assert.equal(state.notes.same.text, 'legacy owner unknown');
});

test('template aliases support original single braces and new double braces without replacing unknown data', () => {
  const values = { personName: 'Person', bio: 'Bio', accountName: 'Owner', accountBio: 'Owner bio', aboutAccountProfile: 'Interests: music',
    aboutPersonProfile: 'Interests: climbing', matchRichFields: 'Education: university', datetime: 'known time', platform: 'tinder' };
  assert.equal(renderStyle('{personName} {{name}} {accountName} {{accountBio}} {datetime} {unknown} {{unknown}}', values), 'Person Person Owner Owner bio known time {unknown} {{unknown}}');
  assert.equal(renderStyle('{aboutAccountProfile}|{aboutPersonProfile}|{{matchRichFields}}|{platform}', values), 'Interests: music|Interests: climbing|Education: university|tinder');
});

test('assistant tool results persist structured data and require owner confirmation for drafts', async () => {
  const { library } = harness();
  const results = [
    { type: 'suggestions', replies: [{ text: 'A reply', reason: 'Reason' }] },
    { type: 'draft-style', style: { name: 'Draft', prompt: 'Prompt', useHistory: false }, requiresConfirmation: true },
    { type: 'past-replies', query: 'coffee', currentAccountOnly: true, source: 'server-history', results: [{ conversationId: 'tinder:owner:chat', chatId: 'chat', accountId: 'owner', platform: 'tinder', theirText: 'Coffee?', myReply: 'Yes', sentAt: null, messageId: 'old', partial: true }] },
  ];
  await library.dispatch('save-chat', { chat: { id: 'tools', messages: [{ id: 'answer', role: 'assistant', text: 'Answer', toolResults: results }] } });
  assert.deepEqual((await library.getState()).assistantChats[0].messages[0].toolResults, results);
  await assert.rejects(library.dispatch('save-chat', { chat: { id: 'invalid-tools', messages: [{ role: 'assistant', text: '', toolResults: [{ ...results[1], requiresConfirmation: false }] }] } }));
  assert.equal((await library.getState()).styles.length, 2, 'no generated style was automatically saved');
});

test('forking an edited or regenerated turn preserves the original confirmed history', async () => {
  const { library } = harness();
  const original = { id: 'original', title: 'Original', messages: [{ id: 'u1', role: 'user', text: 'first' }, { id: 'a1', role: 'assistant', text: 'answer' }, { id: 'u2', role: 'user', text: 'second' }] };
  await library.dispatch('save-chat', { chat: original });
  const before = (await library.getState()).assistantChats[0];
  await library.dispatch('fork-chat', { sourceId: 'original', messageId: 'u2', text: 'edited second' });
  let state = await library.getState();
  assert.deepEqual(state.assistantChats.find(chat => chat.id === 'original'), before);
  const edited = state.assistantChats.find(chat => chat.id !== 'original');
  assert.equal(edited.draft, 'edited second'); assert.equal(edited.messages.length, 2);
  await library.dispatch('fork-chat', { sourceId: 'original', messageId: 'a1' });
  state = await library.getState();
  const regenerated = state.assistantChats.find(chat => !['original', edited.id].includes(chat.id));
  assert.equal(regenerated.messages.length, 0); assert.equal(regenerated.draft, 'first');
});

test('assistant prompt and reply-language settings are strict and do not alter UI language', async () => {
  const { library } = harness();
  await library.dispatch('save-settings', { settings: { replyLanguage: 'en', assistantPrompts: { useCustom: true, base: 'Base', chat: 'Chat', profile: 'Profile' } } });
  const state = await library.getState();
  assert.equal(state.settings.replyLanguage, 'en'); assert.equal(state.settings.language, 'ru');
  assert.equal(state.settings.assistantPrompts.profile, 'Profile');
  await assert.rejects(library.dispatch('save-settings', { settings: { assistantPrompts: { unknown: 'bad' } } }));
});

test('unknown account labels isolate histories and notes without verifying or enabling sending', async () => {
  const { library } = harness();
  const first = { platform: 'whatsapp', accountId: '', accountScope: 'personal', chatId: 'same-peer', messages: [{ id: 'a', role: 'outgoing', text: 'personal' }] };
  const second = { ...first, accountScope: 'work', messages: [{ id: 'b', role: 'outgoing', text: 'work' }] };
  await library.dispatch('capture', { conversation: first });
  await library.dispatch('capture', { conversation: second });
  await library.dispatch('save-note', { conversation: first, text: 'private personal note' });
  const state = await library.getState();
  assert.equal(state.conversations.length, 2);
  assert.notEqual(getConversationKey(first), getConversationKey(second));
  assert.equal(getConversationNote(state, first).text, 'private personal note');
  assert.equal(getConversationNote(state, second), null);
  assert.equal(getConversationNote(state, { ...first, accountScope: '' }), null);
  assert.ok(state.conversations.every(item => item.accountId === ''));
  assert.equal(state.settings.autoSendEnabled, false);
  assert.throws(() => getConversationKey({ ...first, accountScope: 'x'.repeat(101) }));
  await assert.rejects(library.dispatch('append-note', { chatId: 'same-peer', text: 'ambiguous' }), /Неоднозначный/);
});

test('conflicting legacy conversation identities reject capture and import without mutating either history', async () => {
  const h = harness();
  await h.library.dispatch('capture', { conversation: { id: 'legacy-shared', platform: 'tinder', accountId: 'a', chatId: 'peer', messages: [{ id: 'a', text: 'first owner' }] } });
  const before = h.snapshot();
  for (const conflict of [{ accountId: 'b' }, { platform: 'whatsapp' }, { chatId: 'other' }, { accountScope: 'changed-scope' }]) {
    const incoming = { ...before.library.conversations[0], ...conflict, messages: [{ id: 'b', text: 'other owner' }], updatedAt: '2099-01-01T00:00:00Z' };
    assert.throws(() => mergeLibraries(before.library, { ...initialLibrary(), conversations: [incoming] }), /Конфликт идентичности/);
    await assert.rejects(h.library.dispatch('capture', { conversation: incoming }), /Конфликт идентичности/);
    await assert.rejects(h.library.dispatch('import', { data: { version: 1, conversations: [incoming] }, mode: 'merge' }), /Конфликт идентичности/);
    assert.deepEqual(h.snapshot(), before);
  }
});

test('backfilled captures preserve observed message order and archived messages with unknown times', async () => {
  const { library } = harness();
  const message = id => ({ id, role: 'unknown', text: id, createdAt: null });
  const snapshot = ids => ({ id: 'backfill', chatId: 'backfill', messages: ids.map(message) });
  await library.dispatch('capture', { conversation: snapshot(['m3', 'm4']) });
  await library.dispatch('capture', { conversation: snapshot(['m1', 'm2', 'm3', 'm4']) });
  await library.dispatch('capture', { conversation: snapshot(['m4', 'm5']) });
  let state = await library.getState();
  assert.deepEqual(state.conversations[0].messages.map(item => item.id), ['m1', 'm2', 'm3', 'm4', 'm5']);
  const merged = mergeLibraries(state, { ...initialLibrary(), conversations: [{ ...snapshot(['m0', 'm1', 'm2']), updatedAt: '2099-01-01T00:00:00Z' }] });
  assert.deepEqual(merged.conversations[0].messages.map(item => item.id), ['m0', 'm1', 'm2', 'm3', 'm4', 'm5']);
  assert.ok(merged.conversations[0].messages.every(item => item.createdAt === null));
});

test('schedule records preserve account scope and atomic claim rejects a different known account', async () => {
  const { library } = harness();
  await library.dispatch('save-settings', { settings: { autoSendEnabled: true } });
  await library.dispatch('schedule', { item: { id: 'owner-schedule', chatId: 'peer', platform: 'tinder', accountId: 'owner', text: 'draft', fireAt: '2020-01-01T00:00:00Z', sendMode: 'automatic', incomingSnapshot: 'same' } });
  await assert.rejects(library.dispatch('claim-schedule', { id: 'owner-schedule', chatId: 'peer', accountId: 'other', incomingSnapshot: 'same' }));
  assert.equal((await library.getState()).schedules[0].status, 'scheduled');
  await library.dispatch('schedule', { item: { id: 'review-scoped', chatId: 'peer', platform: 'whatsapp', accountScope: 'personal', text: 'review', fireAt: '2030-01-01T00:00:00Z' } });
  assert.equal((await library.getState()).schedules[1].accountScope, 'personal');
});

test('tool-only assistant turns and fork task/context metadata persist without executing tools', async () => {
  const { library } = harness();
  await library.dispatch('save-chat', { chat: { id: 'tool-context', messages: [
    { id: 'u', role: 'user', text: 'create a style', task: 'create-style', conversationId: 'context', contextKind: 'chat' },
    { id: 'a', role: 'assistant', text: '', incomplete: true, finishReason: 'tool-limit', conversationId: 'context', toolResults: [{ type: 'draft-style', style: { name: 'Draft', prompt: 'Prompt', useHistory: false }, requiresConfirmation: true }] },
  ] } });
  await library.dispatch('fork-chat', { sourceId: 'tool-context', messageId: 'a' });
  const state = await library.getState();
  assert.equal(state.assistantChats[0].messages[1].incomplete, true);
  assert.equal(state.assistantChats[1].draftTask, 'create-style');
  assert.equal(state.assistantChats[1].contextId, 'context');
  assert.equal(state.styles.length, 2);
});
