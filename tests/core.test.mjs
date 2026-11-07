import test from 'node:test';
import assert from 'node:assert/strict';
import { TEST_CODE, activate, fixture, canUseApp, suggestReplies } from '../extension/core.js';

const NOW = Date.parse('2026-11-07T12:00:00Z');

test('local code selects a fresh active fixture', () => {
  assert.equal(TEST_CODE, 'REPLYLAB-LOCAL');
  assert.deepEqual(activate(TEST_CODE, NOW), fixture('active', NOW));
  assert.deepEqual(activate('  replylab-local  ', NOW), fixture('active', NOW));
  assert.throws(() => activate('wrong', NOW), /Неверный/);
  assert.throws(() => activate(null, NOW), /Неверный/);
});

test('scenario fixtures preserve successful and denied states', () => {
  const active = fixture('active', NOW);
  assert.equal(active.displayName, 'Локальный тест');
  assert.equal(active.canUseApp, true);
  assert.equal(active.canUseManagedAI, true);
  assert.equal(active.isOnTrial, false);
  assert.equal(active.trialEndsAt, null);

  const trial = fixture('trial', NOW);
  assert.equal(trial.canUseApp, true);
  assert.equal(trial.isOnTrial, true);
  assert.ok(Date.parse(trial.trialEndsAt) > NOW);

  const expired = fixture('expired', NOW);
  assert.equal(expired.canUseApp, false);
  assert.equal(expired.isOnTrial, false);
  assert.equal(expired.canUseManagedAI, false);
  assert.ok(Date.parse(expired.trialEndsAt) < NOW);
  assert.equal(fixture('signed_out', NOW), null);
  assert.throws(() => fixture('unknown', NOW), /Неизвестный/);
  assert.throws(() => fixture('trial', Number.NaN), /время/);
});

test('gate allows either entitlement flag and denies expired or missing user', () => {
  assert.equal(canUseApp(fixture('active', NOW)), true);
  assert.equal(canUseApp(fixture('trial', NOW)), true);
  assert.equal(canUseApp({ canUseApp: false, isOnTrial: true }), true);
  assert.equal(canUseApp({ canUseApp: true, isOnTrial: false }), true);
  assert.equal(canUseApp(fixture('expired', NOW)), false);
  assert.equal(canUseApp(null), false);
  assert.equal(canUseApp(undefined), false);
});

test('local replies validate input without silently truncating it', () => {
  for (const input of ['', ' \n\t ', null, undefined, 12]) {
    assert.throws(() => suggestReplies(input));
  }
  assert.equal(suggestReplies('я'.repeat(10000)).length, 3);
  assert.throws(() => suggestReplies('я'.repeat(10001)), /10 000/);
});

test('every tone returns exactly three independent Russian mock replies', () => {
  for (const tone of ['friendly', 'playful', 'concise', 'unknown']) {
    const replies = suggestReplies('Как прошёл день?', tone);
    assert.equal(replies.length, 3);
    assert.equal(new Set(replies.map(reply => reply.text)).size, 3);
    for (const reply of replies) {
      assert.deepEqual(Object.keys(reply).sort(), ['reason', 'text']);
      assert.match(reply.text, /[А-Яа-яЁё]/);
      assert.match(reply.reason, /[А-Яа-яЁё]/);
    }
  }
  const replies = suggestReplies('Привет');
  replies[0].text = 'changed';
  assert.notEqual(suggestReplies('Привет')[0].text, 'changed');
});
