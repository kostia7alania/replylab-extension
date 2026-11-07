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
