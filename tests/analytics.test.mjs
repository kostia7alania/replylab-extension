import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate90days } from '../extension/analytics.js';

const now = Date.parse('2026-11-07T12:00:00Z');
const event = (kind, at, extra = {}) => ({ kind, at, ...extra });

test('observed swipe aliases count consistently and unrelated activity does not affect like rate', () => {
  const data = aggregate90days([event('like-observed', '2026-11-07T10:00:00Z'), event('pass-observed', '2026-11-07T11:00:00Z'), event('reply-generated', '2026-11-07T11:30:00Z')], 'UTC', now);
  assert.equal(data.totalEvents, 3); assert.equal(data.swipes, 2);
  assert.equal(data.likes, 1); assert.equal(data.passes, 1); assert.equal(data.likeRate, 0.5);
  assert.equal(data.days['2026-11-07'], 2);
});

test('timezone and repeated DST hour are handled by local calendar without losing either observation', () => {
  const data = aggregate90days([event('like', '2026-11-01T05:30:00Z'), event('pass', '2026-11-01T06:30:00Z')], 'America/New_York', Date.parse('2026-11-02T15:00:00Z'));
  assert.equal(data.days['2026-11-01'], 2);
  assert.equal(data.hours[1], 2);
  assert.equal(data.currentStreak, 1);
});

test('the 90-day local-calendar boundary excludes older, future, deleted and invalid observations', () => {
  const data = aggregate90days([
    event('like', '2026-03-01T00:00:00Z'), event('pass', '2026-02-28T23:59:59Z'),
    event('like', '2026-05-29T13:00:00Z'), event('like', 'invalid'),
    event('like', '2026-05-28T12:00:00Z', { deleted: true }),
  ], 'UTC', Date.parse('2026-05-29T12:00:00Z'));
  assert.equal(Object.keys(data.days).length, 90);
  assert.equal(Object.keys(data.days)[0], '2026-03-01');
  assert.equal(data.swipes, 1);
});

test('streak and 30-day comparison derive from observed swipe days', () => {
  const data = aggregate90days([
    event('like', '2026-11-07T10:00:00Z'), event('like', '2026-11-06T10:00:00Z'),
    event('pass', '2026-10-01T10:00:00Z'),
  ], 'UTC', now);
  assert.equal(data.longestStreak, 2); assert.equal(data.currentStreak, 2);
  assert.equal(data.activeDays, 3); assert.equal(data.last30, 2); assert.equal(data.previous30, 1);
  assert.equal(data.trendPercent, 100);
});

test('taste counts only explicit observed profile metadata and keeps missing data unknown', () => {
  const input = [
    event('like', '2026-11-07T10:00:00Z', { profile: { age: 29, city: 'Paris' } }),
    event('like-observed', '2026-11-07T10:01:00Z', { profile: { bio: '22, Paris', age: 17 } }),
    event('pass-observed', '2026-11-07T10:02:00Z', { profile: { age: 37, city: 'PARIS' } }),
  ];
  const original = structuredClone(input);
  const { taste } = aggregate90days(input, 'UTC', now);
  assert.equal(taste.knownAge, 1); assert.equal(taste.unknownAge, 1);
  assert.equal(taste.knownCity, 1); assert.equal(taste.unknownCity, 1);
  assert.deepEqual(taste.ageBands.find(group => group.label === '25–34'), { label: '25–34', likes: 1, passes: 0 });
  assert.deepEqual(taste.cities, [{ name: 'Paris', likes: 1, passes: 1 }]);
  assert.deepEqual(input, original);
});

test('empty sample and invalid inputs do not invent rates or timezone facts', () => {
  const data = aggregate90days([], 'UTC', now);
  assert.equal(data.likeRate, null); assert.equal(data.trendPercent, null);
  assert.equal(data.currentStreak, 0); assert.equal(data.taste.knownAge, 0);
  assert.throws(() => aggregate90days([], 'not-a-timezone', now), RangeError);
  assert.throws(() => aggregate90days([], 'UTC', NaN), TypeError);
});
