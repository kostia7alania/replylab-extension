import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { platformFor, objectIdTimestamp, normalizeProfile, conversationFromTinder, conversationFromWhatsApp,
  normalizeSiteSnapshot, incomingSnapshot, transcript, validGeo, photoUrl, canAutoSendContext,
  styleConditions, isStyleEligible, instagramLinks, languageHint } from '../extension/site-context.js';

const tinder = JSON.parse(await readFile(new URL('./site-fixtures/tinder.json', import.meta.url)));
const whatsapp = JSON.parse(await readFile(new URL('./site-fixtures/whatsapp.json', import.meta.url)));
const loc = { hostname: 'tinder.com', pathname: '/app/messages/demo-chat' };

test('Tinder extracts only active loaded conversation with observed message direction', () => {
  const context = conversationFromTinder(tinder, loc.pathname);
  assert.equal(context.chatId, 'demo-chat');
  assert.equal(context.profile.bio, 'Синтетический пример для проверки интерфейса.');
  assert.deepEqual(context.messages.map(message => message.role), ['assistant', 'user']);
  assert.equal(context.messages[0].text, 'Как прошёл день?');
  assert.equal(context.partial, true);
  assert.equal(context.photos.length, 2);
  assert.equal(conversationFromTinder(tinder, '/app/messages/other-chat'), null);
  assert.equal(conversationFromTinder(tinder, '/app/messages/%'), null);
  assert.equal(conversationFromTinder({}, loc.pathname), null);
});

test('snapshot rejects wrong platform or route and exposes only loaded current card', () => {
  assert.equal(normalizeSiteSnapshot({ platform: 'whatsapp', route: loc.pathname }, loc), null);
  assert.equal(normalizeSiteSnapshot({ platform: 'tinder', route: '/app/recs', state: tinder }, loc), null);
  const value = normalizeSiteSnapshot({ platform: 'tinder', route: loc.pathname, state: tinder }, loc);
  assert.equal(value.profile.name, 'Тестовый профиль');
  assert.equal(value.conversation.chatId, 'demo-chat');
  assert.equal(platformFor({ hostname: 'example.test' }), null);
  assert.equal(platformFor({ hostname: 'web.whatsapp.com' }), 'whatsapp');
});

test('WhatsApp maps loaded active chat, timestamps, direction and profile', () => {
  const context = conversationFromWhatsApp(whatsapp, '/');
  assert.equal(context.chatId, 'synthetic-chat@c.us');
  assert.deepEqual(context.messages.map(message => message.role), ['assistant', 'user']);
  assert.equal(context.partial, true);
  assert.equal(context.photos[0], 'https://example.test/avatar.jpg');
  assert.ok(context.messages[0].createdAt.endsWith('Z'));
  assert.equal(conversationFromWhatsApp(null, '/'), null);
});

test('incoming snapshot ignores outgoing changes but invalidates new incoming text', () => {
  const context = conversationFromTinder(tinder, loc.pathname);
  const before = incomingSnapshot(context);
  context.messages[1].text = 'Другой исходящий черновик';
  assert.equal(incomingSnapshot(context), before);
  context.messages[0].text = 'Новое входящее сообщение';
  assert.notEqual(incomingSnapshot(context), before);
  assert.match(transcript(context), /Только загруженная часть/);
  assert.match(transcript(context), /Вы: Другой исходящий/);
});

test('ID timestamp is bounded inference, never manufactured for arbitrary IDs', () => {
  assert.equal(objectIdTimestamp('not-an-object-id'), null);
  assert.equal(objectIdTimestamp('ffffffff0000000000000000'), null);
  assert.equal(objectIdTimestamp('000000000000000000000000'), null);
  assert.match(objectIdTimestamp('659200800000000000000001'), /^2024-/);
  assert.equal(normalizeProfile(null).name, '');
  assert.equal(photoUrl('javascript:alert(1)'), null);
  assert.equal(photoUrl('https://user:secret@example.test/photo'), null);
});

test('geo override is explicit and rejects nonnumeric or out-of-bounds coordinates', () => {
  assert.equal(validGeo({ enabled: false, latitude: 0, longitude: 0 }), false);
  assert.equal(validGeo({ enabled: true, latitude: 90, longitude: -180 }), true);
  assert.equal(validGeo({ enabled: true, latitude: '1', longitude: 0 }), false);
  assert.equal(validGeo({ enabled: true, latitude: 91, longitude: 0 }), false);
  assert.equal(validGeo({ enabled: true, latitude: 0, longitude: Number.NaN }), false);
  assert.equal(validGeo({ enabled: true, latitude: 0, longitude: 0, accuracy: 0 }), false);
});

test('bounded loaded history reports omitted records explicitly', () => {
  const state = structuredClone(tinder);
  state.entities.matches['demo-chat'].messages = Array.from({ length: 505 }, (_, index) => ({ _id: String(index), message: 'Синтетическое сообщение', from: 'synthetic-self' }));
  const context = conversationFromTinder(state, loc.pathname);
  assert.equal(context.messages.length, 500);
  assert.equal(context.omittedMessages, 5);
  assert.equal(context.partial, true);
});

test('unknown sender or unreliable partial context cannot authorize automatic send', () => {
  const context = conversationFromTinder(tinder, loc.pathname);
  assert.equal(canAutoSendContext(context), true);
  const unknown = structuredClone(tinder);
  delete unknown.profile.user._id;
  const missing = conversationFromTinder(unknown, loc.pathname);
  assert.equal(missing.messages[0].role, 'unknown');
  assert.equal(canAutoSendContext(missing), false);
  assert.equal(canAutoSendContext({ ...context, source: 'rendered-dom' }), false);
  assert.equal(canAutoSendContext({ ...context, omittedMessages: 1 }), false);
  const before = incomingSnapshot(missing);
  missing.messages[1].text = 'Неизвестный автор написал ещё';
  assert.notEqual(incomingSnapshot(missing), before);
});

test('automatic sending requires a verified account and snapshots cannot cross accounts or chats', () => {
  const context = conversationFromTinder(tinder, loc.pathname);
  assert.equal(context.accountId, 'synthetic-self');
  assert.notEqual(incomingSnapshot(context), incomingSnapshot({ ...context, accountId: 'another-account' }));
  assert.notEqual(incomingSnapshot(context), incomingSnapshot({ ...context, chatId: 'another-chat' }));
  assert.equal(canAutoSendContext({ ...context, accountId: '' }), false);
  assert.equal(canAutoSendContext(conversationFromWhatsApp(whatsapp, '/')), false);
});

test('style eligibility respects opener, incoming, empty and known stale outgoing context', () => {
  const now = Date.parse('2026-11-08T12:00:00Z');
  assert.deepEqual(styleConditions({ messages: [] }, now), ['opener', 'empty']);
  assert.equal(isStyleEligible({ conditions: ['incoming'] }, { messages: [] }, now), false);
  assert.equal(isStyleEligible({ conditions: ['opener'] }, { messages: [] }, now), true);
  assert.deepEqual(styleConditions({ messages: [{ role: 'assistant' }] }, now), ['incoming']);
  assert.equal(isStyleEligible({ conditions: ['stale'] }, { messages: [{ role: 'user', createdAt: '2026-11-07T11:59:59Z' }] }, now), true);
  assert.equal(isStyleEligible({ conditions: ['stale'] }, { messages: [{ role: 'user', createdAt: '2026-11-07T12:00:00Z' }] }, now), false);
  assert.equal(isStyleEligible({ conditions: ['stale'] }, { messages: [{ role: 'user', createdAt: null }] }, now), false);
  assert.equal(isStyleEligible({ conditions: ['incoming', 'stale'] }, { messages: [{ role: 'unknown', createdAt: '2020-01-01' }] }, now), false);
  assert.equal(isStyleEligible({ deleted: true, conditions: ['opener'] }, { messages: [] }, now), false);
});

test('Instagram links require an explicit platform cue and always use the allowlisted HTTPS host', () => {
  assert.deepEqual(instagramLinks('Пишите @someone или me@example.test'), []);
  const links = instagramLinks('Insta: @demo.user и https://instagram.com/another_user/');
  assert.deepEqual(links.map(link => link.url), ['https://www.instagram.com/demo.user/', 'https://www.instagram.com/another_user/']);
  assert.deepEqual(instagramLinks('https://instagram.com/p/abcdef'), []);
  assert.deepEqual(instagramLinks('https://instagram.com.evil.test/profile'), []);
  assert.deepEqual(instagramLinks('https://evilinstagram.com/profile'), []);
});

test('language hints are explicitly heuristic and avoid unsupported guesses on short Latin text', () => {
  assert.equal(languageHint('Привет, как дела?').code, 'ru');
  assert.equal(languageHint('Bonjour et merci pour votre aide').code, 'fr');
  assert.equal(languageHint('ok').code, null);
  assert.equal(languageHint('hej').code, null);
  assert.equal(languageHint('hello and thanks').heuristic, true);
});
