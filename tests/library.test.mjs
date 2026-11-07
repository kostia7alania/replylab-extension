import test from 'node:test';
import assert from 'node:assert/strict';
import { createLibrary, initialLibrary, mergeLibraries, renderStyle, validateLibrary } from '../extension/library.js';

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
