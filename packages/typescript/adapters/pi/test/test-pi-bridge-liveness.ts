#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { PiBridgeRegistry } from '../src/bridge.ts';
import type { SessionInfo } from '../../../adapter-api/src/index.ts';

const tornDown: Array<{ id: string; reason: string }> = [];
const registry = new PiBridgeRegistry((id, reason) => { tornDown.push({ id, reason }); }, 10);
const info = (id: string): SessionInfo => ({
  id, tool: 'pi', machine: 'test', title: id, status: 'idle', attachMode: 'live',
  control: {
    drive: { supported: false, state: 'unavailable' },
    terminalSync: { supported: true, syncAvailable: true, active: true },
  },
});

const neverSeen = registry.hello('never', info('never'));
const active = registry.hello('active', info('active'));
active.lastSeen = 1_000;
const fresh = registry.hello('fresh', info('fresh'));
fresh.lastSeen = 60_000;

assert.deepEqual(registry.sweepStale(61_001, 60_000), ['active']);
assert.deepEqual(tornDown, [{ id: 'active', reason: 'liveness-timeout' }]);
assert.equal(registry.has('active'), false);
assert.equal(registry.has('never'), true, 'lastSeen=0 is not proof of death');
assert.equal(registry.has('fresh'), true);
assert.equal(neverSeen.lastSeen, 0);
console.log('PASS: Pi abrupt bridge loss uses a deterministic 60-second lastSeen sweep');
