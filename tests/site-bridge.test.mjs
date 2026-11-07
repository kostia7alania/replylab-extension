import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
const source = await readFile(new URL('../extension/site-bridge.js', import.meta.url), 'utf8');
test('document_start bridge tolerates absent root and records calls without coordinates', async () => {
  const events = [], handlers = new Map(), document = {}, native = [];
  const window = { addEventListener(name, handler) { handlers.set(name, handler); }, postMessage(data) { events.push(data); } };
  const location = { hostname: 'web.whatsapp.com', origin: 'https://web.whatsapp.com', pathname: '/' };
  const navigator = { geolocation: { getCurrentPosition(success) { native.push('get'); success({ coords: { latitude: 1, longitude: 2 } }); }, watchPosition() { native.push('watch'); return 3; }, clearWatch() {} } };
  const context = vm.createContext({ window, document, location, navigator, Node: class {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, queueMicrotask,
    MutationObserver: class { observe(target) { assert.equal(target, document); } } });
  vm.runInContext(source, context);
  navigator.geolocation.getCurrentPosition(() => {}); navigator.geolocation.watchPosition(() => {});
  assert.deepEqual(native, ['get', 'watch']);
  const audit = events.filter(item => item.kind === 'geo-request');
  assert.equal(audit.length, 2); assert(audit.every(item => item.overridden === false));
  assert.equal(JSON.stringify(audit).includes('latitude'), false);
  handlers.get('message')({ source: window, origin: location.origin, data: { channel: 'replylab:site', kind: 'geo', value: { enabled: true, latitude: 10, longitude: 20, accuracy: 100 } } });
  const position = await new Promise(resolve => navigator.geolocation.getCurrentPosition(resolve));
  assert.equal(position.coords.latitude, 10); assert.equal(native.length, 2);
  assert.equal(events.at(-1).overridden, true);
});

function harness(state) {
  const events = [], handlers = new Map(), frames = [], clears = [];
  let subscriptions = 0, unsubscribed = 0;
  const store = { getState: () => state, subscribe() { subscriptions++; return () => { unsubscribed++; }; } };
  const document = { body: { children: [{ __reactFiber: { memoizedState: { store } } }] } };
  const window = { addEventListener(name, callback) { handlers.set(name, callback); }, postMessage(data) { events.push(data); } };
  const location = { hostname: 'tinder.com', origin: 'https://tinder.com', pathname: '/app/messages/demo-chat' };
  const navigator = { geolocation: { getCurrentPosition() {}, watchPosition() { return 12; }, clearWatch(id) { clears.push(id); } } };
  const context = vm.createContext({ window, document, location, navigator, Node: class {}, requestAnimationFrame(callback) { frames.push(callback); return frames.length; },
    cancelAnimationFrame() {}, queueMicrotask, MutationObserver: class { observe() {} disconnect() {} } });
  vm.runInContext(source, context);
  const message = data => handlers.get('message')({ source: window, origin: location.origin, data: { channel: 'replylab:site', ...data } });
  return { events, handlers, navigator, clears, state, message, flush() { const work = frames.splice(0); for (const callback of work) callback(); }, subscriptions: () => subscriptions, unsubscribed: () => unsubscribed };
}
const tinderState = JSON.parse(await readFile(new URL('./site-fixtures/tinder.json', import.meta.url), 'utf8'));

test('MAIN snapshots whitelist rich current profiles and own profile, bound messages and never serialize unrelated secrets', () => {
  const state = structuredClone(tinderState);
  state.profile.user = { _id: 'synthetic-self', name: 'Мой профиль', token: 'private-secret', user_interests: { selected_interests: [{ name: 'Музыка' }] } };
  state.entities.profiles['659200800000000000000001'].accessToken = 'private-secret';
  state.entities.profiles.unrelated = { name: 'Not current', token: 'private-secret' };
  state.entities.messages.m1.token = 'private-secret';
  const h = harness(state); h.flush();
  const snapshot = h.events.find(value => value.kind === 'snapshot');
  assert.equal(snapshot.state.profile.user.name, 'Мой профиль');
  assert.deepEqual(Array.from(snapshot.state.profile.user.interests), ['Музыка']);
  assert.equal(JSON.stringify(snapshot).includes('private-secret'), false);
  assert.equal(JSON.stringify(snapshot).includes('Not current'), false);
  assert.equal(snapshot.state.entities.matches['demo-chat'].messages.length, 2);
  assert.equal(h.subscriptions(), 1);
});

test('loaded import is explicit, account checked, date filtered and cursor bounded to fifty chats', () => {
  const state = structuredClone(tinderState);
  const sample = state.entities.matches['demo-chat'];
  for (let index = 0; index < 60; index++) state.entities.matches[`chat-${index}`] = sample;
  const h = harness(state); h.flush();
  assert.equal(h.events.some(value => value.kind === 'import-result'), false);
  h.message({ kind: 'import-loaded', requestId: 'req-1', accountId: 'other' });
  assert.equal(h.events.at(-1).ok, false);
  h.message({ kind: 'import-loaded', requestId: 'req-2', accountId: 'synthetic-self', cursor: 0, from: Date.parse('2026-11-07T10:00:30Z'), to: Date.parse('2026-11-07T10:02:00Z') });
  const batch = h.events.at(-1);
  assert.equal(batch.ok, true); assert.equal(batch.conversations.length, 50); assert.equal(batch.nextCursor, 50);
  assert.equal(batch.conversations[0].messages.length, 1); assert.equal(batch.conversations[0].messages[0]._id, 'm2');
  assert.equal(batch.partial, true);
  h.message({ kind: 'import-loaded', requestId: 'req-3', accountId: 'synthetic-self', cursor: batch.nextCursor });
  assert.equal(h.events.at(-1).conversations.length, 11); assert.equal(h.events.at(-1).nextCursor, null);
  assert.equal(h.subscriptions(), 1);
});

test('cleared geolocation watchers never receive queued preference callbacks and identical settings do not emit twice', async () => {
  const h = harness(structuredClone(tinderState));
  let callbacks = 0;
  const id = h.navigator.geolocation.watchPosition(() => { callbacks++; });
  const value = { enabled: true, latitude: 1, longitude: 2, accuracy: 100 };
  h.message({ kind: 'geo', value }); h.navigator.geolocation.clearWatch(id);
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(callbacks, 0); assert.deepEqual(h.clears, [12]);
  h.navigator.geolocation.watchPosition(() => { callbacks++; });
  await new Promise(resolve => queueMicrotask(resolve)); assert.equal(callbacks, 1);
  h.message({ kind: 'geo', value }); await new Promise(resolve => queueMicrotask(resolve)); assert.equal(callbacks, 1);
  h.handlers.get('pagehide')({ persisted: true }); assert.equal(h.unsubscribed(), 0);
  h.flush(); h.handlers.get('pagehide')({ persisted: false }); assert.equal(h.unsubscribed(), 1);
});


test('explicit content handshake resends unchanged snapshots already emitted before the listener loaded', () => {
  const h = harness(structuredClone(tinderState)); h.flush();
  assert.equal(h.events.filter(value => value.kind === 'snapshot').length, 1);
  h.message({ kind: 'request' }); h.flush();
  assert.equal(h.events.filter(value => value.kind === 'snapshot').length, 2);
  assert.equal(h.subscriptions(), 1);
});
