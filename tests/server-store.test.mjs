import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore, validateState } from '../scripts/server-store.mjs';

async function storeFor(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'replylab-store-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { store: createStore({ directory, ...options }), directory };
}
const record = (id, text, updatedAt = '2026-01-01T00:00:00Z') => ({ id, text, updatedAt });

test('atomic store survives restart, serializes concurrent merges and protects file modes', async t => {
  const { store, directory } = await storeFor(t);
  await Promise.all(['a', 'b', 'c'].map(id => store.merge({ version: 1, memories: [record(id, id)] })));
  const fresh = createStore({ directory });
  const result = await fresh.read();
  assert.equal(result.revision, 3);
  assert.deepEqual(result.state.memories.map(item => item.id).sort(), ['a', 'b', 'c']);
  assert.equal((await stat(join(directory, 'state.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});

test('latest timestamp wins and tombstones prevent stale resurrection', async t => {
  const { store } = await storeFor(t);
  await store.merge({ notes: { chat: { text: 'новое', updatedAt: '2026-02-01T00:00:00Z' } }, styles: [{ id: 'style', name: 'Style', prompt: 'old', updatedAt: '2026-01-01T00:00:00Z' }] });
  await store.merge({ notes: { chat: { text: 'старое', updatedAt: '2026-01-01T00:00:00Z' } }, styles: [{ id: 'style', deleted: true, updatedAt: '2026-02-01T00:00:00Z' }] });
  await store.merge({ styles: [{ id: 'style', name: 'Style', prompt: 'stale', updatedAt: '2026-01-01T00:00:00Z' }] });
  const { state } = await store.read();
  assert.equal(state.notes.chat.text, 'новое'); assert.equal(state.styles[0].deleted, true);
});

test('state rejects dangerous keys, unknown versions, duplicate ids and silent history trimming', () => {
  assert.throws(() => validateState(JSON.parse('{"settings":{"__proto__":{"polluted":true}}}')), /Недопустимое/);
  assert.throws(() => validateState({ version: 2 }), /версия/);
  assert.throws(() => validateState({ memories: [record('x', 'a'), record('x', 'b')] }), /id/);
  assert.throws(() => validateState({ assistantChats: [{ id: 'x', messages: Array.from({ length: 41 }, () => ({})) }] }), /экспортируйте/);
  assert.throws(() => validateState({ settings: { apiKey: 'private-value' } }), /отдельно/);
});

test('Unicode search covers imported conversations and notes without losing text', async t => {
  const { store } = await storeFor(t);
  await store.merge({ format: 'replylab-library', state: { version: 1, conversations: [{ id: 'c', messages: [{ id: 'm', role: 'user', text: 'Ёлка и КОФЕ' }] }], notes: { c: { text: 'Кофе завтра' } } } });
  assert.equal((await store.search('кофе')).length, 2);
  assert.equal((await store.search('елка')).length, 1);
  assert.equal((await store.read()).state.conversations[0].messages[0].text, 'Ёлка и КОФЕ');
});

test('unpredictable share tokens expire and can be revoked independently', async t => {
  let now = Date.parse('2026-01-01T00:00:00Z');
  const { store } = await storeFor(t, { now: () => now });
  const share = await store.createShare({ title: 'Диалог', messages: [{ role: 'user', text: '<script>' }] }, 1);
  assert.match(share.token, /^[A-Za-z0-9_-]{32}$/); assert.ok(await store.share(share.token));
  now += 3600001; assert.equal(await store.share(share.token), null);
  const next = await store.createShare({ messages: [] }, 1);
  assert.equal((await store.deleteShare(next.token)).deleted, true); assert.equal(await store.share(next.token), null);
});

test('analytics groups events by timezone, ninety-day window and genuine observed likes', async t => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  const { store } = await storeFor(t, { now: () => now });
  await store.merge({ events: [
    { id: 'a', kind: 'like', at: '2026-11-06T22:30:00Z' },
    { id: 'b', type: 'pass', createdAt: '2026-11-05T22:30:00Z' },
    { id: 'c', type: 'like', at: '2025-11-01T00:00:00Z' },
  ] });
  const analytics = await store.analytics('Europe/Moscow');
  assert.equal(analytics.totalEvents, 2); assert.equal(analytics.likeRate, 0.5); assert.equal(analytics.longestStreak, 2);
  assert.equal(analytics.days['2026-11-07'], 1); assert.equal(analytics.hours[1], 2);
  await assert.rejects(store.analytics('Invalid/Zone'), RangeError);
});

test('partial sync does not reset settings and equal-time tombstone wins', async t => {
  const { store } = await storeFor(t);
  const at = '2026-01-01T00:00:00Z';
  await store.merge({ settings: { provider: 'compatible', assistantModel: 'kept-model', updatedAt: at }, memories: [{ id: 'm', text: 'before', updatedAt: at }] });
  await store.merge({ notes: { chat: { text: 'note', updatedAt: at } } });
  await store.merge({ memories: [{ id: 'm', deleted: true, updatedAt: at }] });
  await store.merge({ memories: [{ id: 'm', text: 'stale resurrection', updatedAt: at }] });
  const { state } = await store.read(); assert.equal(state.settings.assistantModel, 'kept-model'); assert.equal(state.settings.provider, 'compatible'); assert.equal(state.memories[0].deleted, true);
});

test('schedule claims serialize across devices and survive restart/stale sync without automatic retry', async t => {
  const now = Date.parse('2026-11-07T12:00:00Z'); const fireAt = new Date(now - 1000).toISOString();
  const { store, directory } = await storeFor(t, { now: () => now });
  const schedule = { id: 'schedule', chatId: 'chat', text: 'Ответ', fireAt, incomingSnapshot: 'last-incoming', status: 'scheduled', updatedAt: fireAt };
  await store.merge({ schedules: [schedule] });
  const requests = await Promise.allSettled(['device-a', 'device-b'].map(deviceId => store.claimSchedule({ id: 'schedule', fireAt, deviceId, incomingSnapshot: 'last-incoming' })));
  assert.equal(requests.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(requests.filter(result => result.status === 'rejected')[0].reason.status, 409);
  const restarted = createStore({ directory, now: () => now + 100000 });
  await restarted.merge({ schedules: [{ ...schedule, updatedAt: new Date(now + 1).toISOString() }] });
  await assert.rejects(restarted.claimSchedule({ id: 'schedule', fireAt, deviceId: 'device-c', incomingSnapshot: 'last-incoming' }), error => error.status === 409);
  assert.equal(Object.hasOwn(await restarted.read(), 'claims'), false);
  const nextFireAt = new Date(now + 50000).toISOString();
  await restarted.merge({ schedules: [{ ...schedule, fireAt: nextFireAt, updatedAt: new Date(now + 2).toISOString() }] });
  assert.equal((await restarted.claimSchedule({ id: 'schedule', fireAt: nextFireAt, deviceId: 'device-c', incomingSnapshot: 'last-incoming' })).claimed, true);
});

test('schedule claim refuses future time or changed incoming snapshot without reserving it', async t => {
  const now = Date.parse('2026-11-07T12:00:00Z'); const fireAt = new Date(now + 1000).toISOString();
  const { store } = await storeFor(t, { now: () => now });
  await store.merge({ schedules: [{ id: 's', chatId: 'c', text: 'Ответ', fireAt, incomingSnapshot: 'current', status: 'scheduled' }] });
  await assert.rejects(store.claimSchedule({ id: 's', fireAt, deviceId: 'd', incomingSnapshot: 'current' }), error => error.status === 409);
  await assert.rejects(store.claimSchedule({ id: 's', fireAt, deviceId: 'd', incomingSnapshot: 'changed' }), error => error.status === 409);
});

test('server sync unions partial message histories in both directions and keeps tombstones', async t => {
  const { store } = await storeFor(t);
  const old = { id: 'partial', chatId: 'partial', updatedAt: '2026-11-07T10:00:00Z', messages: [{ id: 'a', role: 'incoming', text: 'A' }] };
  const recent = { ...old, updatedAt: '2026-11-07T11:00:00Z', messages: [{ id: 'b', role: 'outgoing', text: 'B' }] };
  await store.merge({ conversations: [old] }); await store.merge({ conversations: [recent] });
  await store.merge({ conversations: [{ ...old, messages: [{ id: 'c', role: 'incoming', text: 'C' }] }] });
  assert.deepEqual((await store.read()).state.conversations[0].messages.map(m => m.id).sort(), ['a', 'b', 'c']);
  await store.merge({ conversations: [{ id: 'partial', deleted: true, updatedAt: '2026-11-07T11:00:00Z' }] });
  await store.merge({ conversations: [recent] });
  assert.equal((await store.read()).state.conversations[0].deleted, true);
});

test('server claim rejects a changed text/version without reserving the job', async t => {
  const now = Date.parse('2026-11-07T12:00:00Z'); const fireAt = new Date(now - 1000).toISOString();
  const { store } = await storeFor(t, { now: () => now });
  await store.merge({ schedules: [{ id: 'v', chatId: 'c', text: 'Current', fireAt, incomingSnapshot: 'same', updatedAt: fireAt }] });
  await assert.rejects(store.claimSchedule({ id: 'v', fireAt, deviceId: 'd', incomingSnapshot: 'same', expectedText: 'Stale' }), error => error.status === 409);
  assert.equal((await store.claimSchedule({ id: 'v', fireAt, deviceId: 'd', incomingSnapshot: 'same', expectedText: 'Current', expectedUpdatedAt: fireAt })).claimed, true);
});

test('own-server catalog and versioned templates are real persistent CRUD without a seeded public catalog', async t => {
  const { store, directory } = await storeFor(t);
  assert.deepEqual((await store.catalog()).items, []); assert.deepEqual((await store.templates()).items, []);
  const saved = await store.saveCatalog({ name: 'Tea', prompt: 'Use {{name}} naturally.' });
  assert.equal(saved.item.shared, true); assert.equal(saved.revision, 1);
  await store.saveCatalog({ prompt: 'Updated instruction.' }, saved.item.id);
  const template = await store.saveTemplate({ name: 'Base', scope: 'assistant-base', prompt: 'Facts only.' });
  const edited = await store.saveTemplate({ prompt: 'Facts and questions.' }, template.item.id);
  assert.equal(edited.item.version, 2);
  const restarted = createStore({ directory });
  assert.equal((await restarted.catalog()).items[0].prompt, 'Updated instruction.');
  assert.equal((await restarted.templates()).items[0].prompt, 'Facts and questions.');
  await restarted.merge({ memories: [record('m', 'Keep this')] });
  assert.equal((await restarted.templates()).items[0].version, 2);
  await restarted.deleteCatalog(saved.item.id); await restarted.deleteTemplate(template.item.id);
  assert.equal((await restarted.catalog()).items.length, 0); assert.equal((await restarted.templates()).items.length, 0);
  assert.equal((await restarted.read()).state.styles[0].deleted, true);
  await assert.rejects(restarted.saveTemplate({ name: 'Invalid', scope: 'unknown', prompt: 'No' }), /область/);
  await assert.rejects(restarted.saveTemplate({ name: 'Invalid', scope: 'reply', prompt: 'No', apiKey: 'not-a-key' }), /поле/);
  await assert.rejects(restarted.saveCatalog({ prompt: 'Missing' }, 'missing'), error => error.status === 404);
});

test('past reply pairs search is Unicode normalized and defaults to the confirmed current account', async t => {
  const { store } = await storeFor(t);
  const conversation = (id, accountId, platform, ownText) => ({ id, chatId: id, accountId, platform, partial: true, messages: [
    { id: id + '-peer', role: 'assistant', text: 'Ёлка, кофе?', createdAt: null },
    { id: id + '-own', role: 'user', text: ownText, createdAt: null },
  ] });
  await store.merge({ conversations: [conversation('a', 'account-a', 'tinder', 'Кофе завтра'), conversation('b', 'account-b', 'tinder', 'Other account'), conversation('wa', 'account-a', 'whatsapp', 'Other platform')] });
  const result = await store.searchPastReplies({ query: 'ЕЛКА кофе', accountId: 'account-a', platform: 'tinder' });
  assert.equal(result.length, 1); assert.equal(result[0].myReply, 'Кофе завтра'); assert.equal(result[0].theirText, 'Ёлка, кофе?'); assert.equal(result[0].sentAt, null); assert.equal(result[0].accountId, 'account-a');
  assert.equal((await store.searchPastReplies({ query: 'кофе', current_account_only: false, platform: 'tinder' })).length, 2);
  assert.deepEqual(await store.searchPastReplies({ query: 'not-in-history', accountId: 'account-a' }), []);
  await assert.rejects(store.searchPastReplies({ query: 'кофе' }), /аккаунт/);
});

test('history excerpts mark truncation and never attribute an unknown sender message to an earlier incoming text', async t => {
  const { store } = await storeFor(t);
  await store.merge({ conversations: [{ id: 'c', chatId: 'c', accountId: 'a', platform: 'tinder', partial: false, messages: [
    { id: 'old-peer', role: 'assistant', text: 'Old incoming', createdAt: null }, { id: 'unknown', role: 'unknown', text: 'Unknown sender', createdAt: null },
    { id: 'reply', role: 'user', text: 'needle ' + 'a'.repeat(6000), createdAt: null },
  ] }] });
  const results = await store.searchPastReplies({ query: 'needle', accountId: 'a' });
  assert.equal(results[0].theirText, ''); assert.equal(results[0].partial, true); assert.equal(results[0].myReply.length, 5000);
});
