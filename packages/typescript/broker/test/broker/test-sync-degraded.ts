#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { SyncDegradationTracker, type SessionControlTransition } from '../../src/attention/attention-policy.ts';

let now = 100;
const tracker = new SyncDegradationTracker(() => now++);
const base: Omit<SessionControlTransition, 'from' | 'to'> = {
  tool: 'codex', sessionId: 'thread-1', path: 'terminal-sync', cause: 'transport-lost', observedAt: 1,
};

assert.equal(tracker.observe({ ...base, from: 'unknown', to: 'unavailable' }), undefined, 'startup unknown must not alert');
assert.equal(tracker.observe({ ...base, from: 'available', to: 'unknown' }), undefined, 'unknown is not degraded');

const down = tracker.observe({ ...base, from: 'active', to: 'unavailable' });
assert.deepEqual(down, {
  type: 'upsert',
  dedupeKey: 'sync-degraded:codex:thread-1:terminal-sync',
  tool: 'codex', sessionId: 'thread-1', path: 'terminal-sync', cause: 'transport-lost', at: 100,
});
assert.equal(tracker.observe({ ...base, from: 'unavailable', to: 'unavailable' }), undefined, 'repeat down is deduped');

const restored = tracker.observe({ ...base, from: 'unavailable', to: 'active', cause: 'unknown' });
assert.deepEqual(restored, {
  type: 'resolve', dedupeKey: 'sync-degraded:codex:thread-1:terminal-sync', at: 101,
});
assert.equal(tracker.observe({ ...base, from: 'unavailable', to: 'active' }), undefined, 'repeat recovery is silent');

assert.equal(
  tracker.observe({ ...base, from: 'active', to: 'unavailable', intentional: true, cause: 'configuration-removed' }),
  undefined,
  'intentional disable/uninstall/restart is suppressed',
);

tracker.observe({ ...base, from: 'available', to: 'unavailable' });
const ended = tracker.observe({ ...base, from: 'unavailable', to: 'ended', cause: 'peer-ended' });
assert.equal(ended?.type, 'resolve', 'definitive session end resolves a degradation');

console.log('PASS: sync-degraded transitions are authoritative, fail-closed, deduped, and recoverable');
