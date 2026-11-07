import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedSender } from '../extension/messaging.js';
const id = 'a'.repeat(32);

test('own popup and own options tab may request generation', () => {
  const sender = { id, url: `chrome-extension://${id}/index.html` };
  assert.equal(allowedSender(sender, id), true);
  assert.equal(allowedSender({ ...sender, tab: { id: 1 }, frameId: 0 }, id), true);
});

test('only the top-level target chat may use the page bridge', () => {
  const sender = { id, url: 'https://tinder.com/app/messages/example', tab: { id: 1 }, frameId: 0 };
  assert.equal(allowedSender(sender, id), true);
  for (const change of [{ id: 'b'.repeat(32) }, { frameId: 1 }, { url: 'https://tinder.com/app/recs' }, { url: 'https://example.org/app/messages/example' }, { url: 'invalid' }]) {
    assert.equal(allowedSender({ ...sender, ...change }, id), false);
  }
});
