#!/usr/bin/env bun
import { strict as assert } from 'node:assert';
import { DeviceWakeCoalescer } from '../../../../packages/typescript/broker/src/wake-coalescer.ts';
import type { WakeRegistration } from '../../../../packages/typescript/broker/src/push-wake.ts';

let failures = 0;
async function run(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn();
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures++;
    console.error(`FAIL  ${name} - ${err instanceof Error ? err.message : String(err)}`);
  }
}

type Timer = { at: number; callback: () => void; cleared: boolean };
function fakeTime() {
  let now = 0;
  const timers: Timer[] = [];
  return {
    now: () => now,
    setNow(next: number): void {
      now = next;
    },
    setTimer(callback: () => void, delay: number): Timer {
      const timer = { at: now + delay, callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer: Timer): void {
      timer.cleared = true;
    },
    async advance(ms: number): Promise<void> {
      now += ms;
      for (;;) {
        const due = timers
          .filter((timer) => !timer.cleared && timer.at <= now)
          .sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        due.cleared = true;
        due.callback();
        await Promise.resolve();
      }
    },
  };
}

function registration(deviceId: string, token = `${deviceId}-token`): WakeRegistration {
  return {
    deviceId,
    platform: 'fcm',
    token,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(message));
      }, timeoutMs);
      timer.unref();
    }),
  ]);
}

await run('leading wake is prompt and a burst produces at most one trailing wake', async () => {
  const time = fakeTime();
  const sent: string[] = [];
  const coalescer = new DeviceWakeCoalescer({
    windowMs: 30_000,
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    dispatch: async (item) => { sent.push(`${item.deviceId}:${item.token}`); },
  });

  const first = coalescer.request(registration('phone', 'v1'));
  const second = coalescer.request(registration('phone', 'v2'));
  const third = coalescer.request(registration('phone', 'v3'));
  await first;
  assert.deepEqual(sent, ['phone:v1']);

  await time.advance(29_999);
  assert.deepEqual(sent, ['phone:v1']);
  await time.advance(1);
  await Promise.all([second, third]);
  assert.deepEqual(sent, ['phone:v1', 'phone:v3']);
  await time.advance(60_000);
  assert.equal(sent.length, 2);
});

await run('immediate-available request settles all pending waiters', async () => {
  const time = fakeTime();
  const sent: string[] = [];
  const coalescer = new DeviceWakeCoalescer({
    windowMs: 30_000,
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    dispatch: async (item) => { sent.push(`${item.deviceId}:${item.token}`); },
  });

  const first = coalescer.request(registration('phone', 'v1'));
  const second = coalescer.request(registration('phone', 'v2'));
  await first;
  time.setNow(30_000);
  const third = coalescer.request(registration('phone', 'v3'));
  await withTimeout(Promise.all([second, third]), 200, 'burst waiters were not settled when immediate request won after window');
  assert.deepEqual(sent, ['phone:v1', 'phone:v3']);
});

await run('different devices coalesce independently', async () => {
  const time = fakeTime();
  const sent: string[] = [];
  const coalescer = new DeviceWakeCoalescer({
    windowMs: 30_000,
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    dispatch: async (item) => { sent.push(item.deviceId); },
  });
  await Promise.all([
    coalescer.request(registration('phone')),
    coalescer.request(registration('tablet')),
  ]);
  assert.deepEqual(sent.sort(), ['phone', 'tablet']);
});

await run('stop cancels trailing wakes and reports dispatch failures without throwing to callers', async () => {
  const time = fakeTime();
  const errors: unknown[] = [];
  let attempts = 0;
  const coalescer = new DeviceWakeCoalescer({
    windowMs: 30_000,
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    dispatch: async () => { attempts++; throw new Error('provider down'); },
    onError: (error) => errors.push(error),
  });
  const leading = coalescer.request(registration('phone')).catch(() => undefined);
  const trailing = coalescer.request(registration('phone')).catch(() => undefined);
  await leading;
  coalescer.stop();
  await trailing;
  await time.advance(30_000);
  assert.equal(attempts, 1);
  assert.equal(errors.length, 1);
});

await run('timer callback resolves waiters when no pending request remains', async () => {
  const time = fakeTime();
  const sent: string[] = [];
  const coalescer = new DeviceWakeCoalescer({
    windowMs: 30_000,
    now: time.now,
    setTimer: time.setTimer,
    clearTimer: time.clearTimer,
    dispatch: async (item) => { sent.push(`${item.deviceId}:${item.token}`); },
  });

  await coalescer.request(registration('phone', 'v1'));
  const second = coalescer.request(registration('phone', 'v2'));
  const states = coalescer as unknown as { states: Map<string, {
    timer?: Timer;
    pending?: WakeRegistration;
    pendingWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
  }> };
  const state = states.states.get('phone');
  assert.ok(state, 'coalescer state should be present');
  assert.ok(state.timer, 'timer should be set for trailing coalescer requests');
  state.pending = undefined;
  state.timer.callback();
  await withTimeout(second, 200, 'timer-captured waiters remained unresolved when pending was empty');
  assert.deepEqual(sent, ['phone:v1'], 'stale timer callbacks should settle waiters defensively without dispatch');
});

if (failures) {
  console.error(`\nFAIL: ${failures} wake coalescer test(s) failed`);
  process.exit(1);
}
console.log('\nPASS: wake coalescer tests passed');
