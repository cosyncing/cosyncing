#!/usr/bin/env bun
/**
 * Focused HTTP contract test for the revisioned schedule PATCH/DELETE surface (create → edit →
 * stale-conflict → new-session edit → terminal-state conflict → cancel/remove → restart persistence).
 *
 *   bun run scripts/broker/tests/broker/test-schedule-api.ts
 */
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type RunningBroker = { broker: Bun.Subprocess; base: string; home: string };

async function spawnBroker(port: number, home: string): Promise<RunningBroker> {
  const broker = Bun.spawn(['bun', 'packages/typescript/broker/src/main.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      COSYNCING_MACHINE: 'schedule-api-test',
      COSYNCING_HOME: home,
      COSYNCING_DEV_MODE: '1',
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { up = (await fetch(`${base}/api/health`)).ok; } catch { /* startup */ }
    if (!up) await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!up) {
    broker.kill();
    await broker.exited.catch(() => undefined);
  }
  assert.equal(up, true, 'broker starts for schedule API test');
  return { broker, base, home };
}

async function stopBroker(running: RunningBroker): Promise<void> {
  running.broker.kill();
  await running.broker.exited.catch(() => undefined);
}

async function request(base: string, path: string, method: string, body?: unknown): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
}

const home = mkdtempSync(join(tmpdir(), 'cosyncing-schedule-api-'));
const firstPort = 39_000 + (process.pid % 500);
let running = await spawnBroker(firstPort, home);
try {
  const first = await request(running.base, '/api/schedules', 'POST', {
    kind: 'message', tool: 'codex', sessionId: 'session-edit', text: 'before', at: Date.now() + 120_000,
  });
  assert.equal(first.status, 201);
  assert.equal(first.body.schedule.revision, 1);
  const stableId = first.body.schedule.id as string;

  const editedAt = Date.now() + 240_000;
  const edited = await request(running.base, `/api/schedules/${encodeURIComponent(stableId)}`, 'PATCH', {
    text: 'after', at: editedAt, expectedRevision: 1,
  });
  assert.equal(edited.status, 200, 'live message PATCH succeeds');
  assert.equal(edited.body.schedule.id, stableId, 'PATCH keeps the stable id');
  assert.equal(edited.body.schedule.text, 'after');
  assert.equal(edited.body.schedule.at, editedAt);
  assert.equal(edited.body.schedule.revision, 2);

  const stale = await request(running.base, `/api/schedules/${encodeURIComponent(stableId)}`, 'PATCH', {
    text: 'stale overwrite', at: Date.now() + 300_000, expectedRevision: 1,
  });
  assert.equal(stale.status, 409, 'stale PATCH conflicts');
  assert.equal(stale.body.code, 'SCHEDULE_STALE');
  assert.equal(stale.body.schedule.text, 'after', 'stale PATCH includes the canonical current row');
  assert.equal(stale.body.schedule.revision, 2);

  const invalid = await request(running.base, `/api/schedules/${encodeURIComponent(stableId)}`, 'PATCH', {
    text: 'bad time', at: 0, expectedRevision: 2,
  });
  assert.equal(invalid.status, 400, 'invalid PATCH input is rejected');

  const repeating = await request(running.base, '/api/schedules', 'POST', {
    kind: 'new-session', tool: 'codex', text: 'new session later', at: Date.now() + 180_000,
  });
  assert.equal(repeating.status, 201);
  // The revisioned update contract makes new-session rows editable (prompt, time, recurrence, retry);
  // only kind/tool/target session stay immutable.
  const newSessionEdit = await request(running.base, `/api/schedules/${encodeURIComponent(repeating.body.schedule.id)}`, 'PATCH', {
    text: 'new session revised', at: Date.now() + 240_000, expectedRevision: 1,
  });
  assert.equal(newSessionEdit.status, 200, 'new-session schedules are editable under the update contract');
  assert.equal(newSessionEdit.body.schedule.text, 'new session revised');
  assert.equal(newSessionEdit.body.schedule.revision, 2, 'new-session edit increments revision');

  const terminalCandidate = await request(running.base, '/api/schedules', 'POST', {
    kind: 'message', tool: 'codex', sessionId: 'session-terminal', text: 'cancel me', at: Date.now() + 180_000,
  });
  assert.equal(terminalCandidate.status, 201);
  const terminalId = terminalCandidate.body.schedule.id as string;
  const canceled = await request(running.base, `/api/schedules/${encodeURIComponent(terminalId)}`, 'DELETE');
  assert.equal(canceled.status, 200);
  assert.equal(canceled.body.schedule.revision, 2, 'cancel increments revision');
  const terminalPatch = await request(running.base, `/api/schedules/${encodeURIComponent(terminalId)}`, 'PATCH', {
    text: 'too late', at: Date.now() + 240_000, expectedRevision: 2,
  });
  assert.equal(terminalPatch.status, 409, 'terminal message PATCH conflicts');
  assert.equal(terminalPatch.body.code, 'SCHEDULE_INVALID_STATE');
  // DELETE is terminal-idempotent without a revision field: a second DELETE removes the canceled row.
  const removed = await request(running.base, `/api/schedules/${encodeURIComponent(terminalId)}`, 'DELETE');
  assert.deepEqual(removed.body, { ok: true, removed: true }, 'DELETE removes a terminal row');
  const removedAgain = await request(running.base, `/api/schedules/${encodeURIComponent(terminalId)}`, 'DELETE');
  assert.equal(removedAgain.status, 404, 'a removed row is gone');
  assert.equal(removedAgain.body.code, 'SCHEDULE_NOT_FOUND');

  const unknown = await request(running.base, '/api/schedules/unknown-edit-id', 'PATCH', {
    text: 'missing', at: Date.now() + 120_000, expectedRevision: 1,
  });
  assert.equal(unknown.status, 404, 'unknown PATCH target is not created');

  await stopBroker(running);
  running = await spawnBroker(firstPort + 1, home);
  const afterRestart = await request(running.base, '/api/schedules', 'GET');
  const persisted = afterRestart.body.schedules.find((schedule: any) => schedule.id === stableId);
  assert.equal(persisted?.text, 'after', 'edited text survives broker restart');
  assert.equal(persisted?.at, editedAt, 'edited time survives broker restart');
  assert.equal(persisted?.revision, 2, 'edited revision survives broker restart');
  assert.equal(afterRestart.body.schedules.some((schedule: any) => schedule.id === terminalId), false, 'removed row stays removed');
  console.log('PASS broker schedule API (PATCH/CAS/DELETE/persistence)');
} finally {
  await stopBroker(running);
  rmSync(home, { recursive: true, force: true });
}
