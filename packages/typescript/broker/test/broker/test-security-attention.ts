#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { AuthFailureAttentionTracker } from '../../src/attention/attention-policy.ts';

let now = 1_000_000;
const tracker = new AuthFailureAttentionTracker({
  now: () => now,
  threshold: 5,
  windowMs: 10_000,
  cooldownMs: 60_000,
});

for (let index = 0; index < 4; index++) {
  assert.equal(tracker.recordFailure(), undefined);
}
assert.equal(tracker.recordFailure(), `auth-failures:${now}`);

now += 59_999;
for (let index = 0; index < 100_000; index++) tracker.recordFailure();
assert.equal(tracker.recordFailure(), undefined, 'cooldown suppresses attacker-triggered storms');

now += 2;
for (let index = 0; index < 4; index++) {
  assert.equal(tracker.recordFailure(), undefined, 'cooldown traffic does not prime the next incident');
}
assert.equal(tracker.recordFailure(), `auth-failures:${now}`);

now += 60_001;
for (let index = 0; index < 4; index++) {
  assert.equal(tracker.recordFailure(), undefined);
}
assert.equal(tracker.recordFailure(), `auth-failures:${now}`);

now += 20_000;
const sparse = new AuthFailureAttentionTracker({ now: () => now, threshold: 3, windowMs: 1_000 });
assert.equal(sparse.recordFailure(), undefined);
now += 1_001;
assert.equal(sparse.recordFailure(), undefined);
now += 1_001;
assert.equal(sparse.recordFailure(), undefined, 'failures outside the rolling window do not accumulate');

console.log('PASS: repeated-auth attention is thresholded, windowed, content-free, and rate-limited');
