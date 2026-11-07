import test from 'node:test';
import assert from 'node:assert/strict';
const listeners = {};
const database = { user: { canUseApp: true }, mode: 'mock' };
const id = 'a'.repeat(32);
const event = name => ({ addListener(listener) { listeners[name] = listener; } });
globalThis.chrome = {
  runtime: { id, getURL: path => `chrome-extension://${id}/${path}`, onMessage: event('message'), onConnect: event('connect'), onInstalled: event('installed'), onStartup: event('startup') },
  storage: { local: { async get(keys) { const wanted = typeof keys === 'string' ? [keys] : keys; return Object.fromEntries(wanted.filter(key => Object.hasOwn(database, key)).map(key => [key, structuredClone(database[key])])); }, async set(values) { Object.assign(database, structuredClone(values)); } } },
  permissions: { async contains() { return false; }, onAdded: event('added'), onRemoved: event('removed') },
  scripting: {}, tabs: { async create(options) { database.lastTab = options; } },
  alarms: { async create() {}, async clear() {}, onAlarm: event('alarm') },
};
await import('../extension/background.js');
const own = { id, url: `chrome-extension://${id}/index.html` };
const page = { id, url: 'https://tinder.com/app/messages/chat', tab: { id: 1 }, frameId: 0 };
const rpc = (action, payload = {}, sender = own) => new Promise(resolve => listeners.message({ type: 'replylab:action', action, payload }, sender, resolve));

test('page cannot grant device auto-send/sync consent or access server credentials', async () => {
  assert.equal((await rpc('save-settings', { settings: { autoSendEnabled: true } }, page)).ok, false);
  assert.equal((await rpc('server-credentials', { token: 'private-test-token' }, page)).ok, false);
  assert.equal(database.autoSendConsent, undefined); assert.equal(database.serverToken, undefined);
});

test('imported global flags cannot enable device actions and secrets never enter exports', async () => {
  const state = (await rpc('library')).state;
  state.settings.autoSendEnabled = true; state.settings.syncEnabled = true; state.settings.updatedAt = new Date().toISOString();
  const imported = await rpc('import', { data: state, mode: 'replace', confirmReplace: true });
  assert.equal(imported.ok, true); assert.equal(imported.state.settings.autoSendEnabled, false); assert.equal(imported.state.settings.syncEnabled, false);
  assert.equal((await rpc('sync')).ok, false);
  assert.equal((await rpc('server-credentials', { token: 'private-test-token' })).ok, true);
  const exported = await rpc('export');
  assert.equal(JSON.stringify(exported).includes('private-test-token'), false);
  assert.equal(JSON.stringify(exported).includes('autoSendConsent'), false);
});

test('only own settings action grants device consent and page sees masked state', async () => {
  const saved = await rpc('save-settings', { settings: { autoSendEnabled: true, syncEnabled: false } });
  assert.equal(saved.state.settings.autoSendEnabled, true); assert.equal(database.autoSendConsent, true);
  database.autoSendConsent = false;
  assert.equal((await rpc('library', {}, page)).state.settings.autoSendEnabled, false);
  const result = await rpc('claim-schedule', { id: 'anything', chatId: 'chat', incomingSnapshot: '' }, page);
  assert.equal(result.ok, false); assert.match(result.error, /не разрешена/);
});

test('capture strips profile extras, preserves unknown time and derives stable platform ids', async () => {
  const payload = { conversation: { chatId: 'chat', platform: 'tinder', profile: { id: 'p', name: 'Имя', bio: 'Описание', photos: [], internalExtra: 'discard' }, messages: [{ role: 'incoming', text: 'Привет' }] } };
  const first = await rpc('capture', payload, page); const second = await rpc('capture', payload, page);
  assert.equal(first.ok, true); assert.equal(second.state.conversations.length, 1);
  const conversation = second.state.conversations[0];
  assert.equal(conversation.id, 'tinder:chat'); assert.equal(conversation.chatId, 'chat');
  assert.equal(Object.hasOwn(conversation.profile, 'internalExtra'), false);
  assert.equal(conversation.messages[0].createdAt, null); assert.match(conversation.messages[0].id, /^derived:/); assert.equal(conversation.messages.length, 1);
});

test('default local suggestions do not need server permission or network', async () => {
  const response = await new Promise(resolve => listeners.message({ type: 'replylab:suggest', text: 'Привет', tone: 'friendly' }, page, resolve));
  assert.equal(response.ok, true); assert.equal(response.replies.length, 3);
});

test('imported endpoint cannot reuse previous device sync consent or server token', async () => {
  await rpc('save-settings', { settings: { serverUrl: 'http://127.0.0.1:4318', syncEnabled: true } });
  await rpc('server-credentials', { token: 'private-endpoint-token' });
  assert.equal(database.syncConsentOrigin, 'http://127.0.0.1:4318');
  assert.equal(database.serverTokenOrigin, 'http://127.0.0.1:4318');
  const state = (await rpc('export')).result.state;
  state.settings.serverUrl = 'https://example.test'; state.settings.syncEnabled = true;
  const result = await rpc('import', { data: state, mode: 'replace', confirmReplace: true });
  assert.equal(result.state.settings.syncEnabled, false);
  assert.equal((await rpc('sync')).ok, false);
  assert.equal(database.serverTokenOrigin, 'http://127.0.0.1:4318');
});

test('second assistant turn normalizes current user message once instead of dropping it', async () => {
  const response = await rpc('assistant', { messages: [
    { role: 'user', text: 'Первый вопрос', createdAt: null },
    { role: 'assistant', text: 'Первый ответ', createdAt: null },
    { role: 'user', text: 'Текущий второй вопрос', createdAt: null, attachments: [] },
  ] });
  assert.equal(response.ok, true); assert.match(response.text, /Текущий второй вопрос/);
  assert.equal(response.text.includes('Первый вопрос'), false);
});

test('revoked optional site permission blocks already-injected page messages', async () => {
  const sender = { ...page, url: 'https://web.whatsapp.com/' };
  const response = await rpc('library', {}, sender);
  assert.equal(response.ok, false); assert.match(response.error, /отозвано/); assert.equal(response.state, undefined);
});
