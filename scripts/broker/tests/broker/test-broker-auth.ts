#!/usr/bin/env bun
/**
 * Broker auth model (default-deny on mutations) — deterministic, no real agents.
 *
 * When COSYNCING_TOKEN is set (required for any non-loopback bind), EVERY mutating route (POST/PATCH/DELETE)
 * must require the token — so a newly-added control route is gated by construction — while ordinary read-only
 * GETs (roster, health) stay open. Sensitive GETs that expose workspace files or drive a stream are explicit
 * exceptions and must be tokened. The in-session Pi extension / Claude hook / OpenCode send_file tool and the
 * app all carry `x-cosyncing-token`. With NO token (the loopback baseline) every route is open and behavior is
 * unchanged. This guards the 2026-06-24 review fix (send_file / restart / codex-sync / createSession / rename
 * were ungated despite a configured token).
 *
 *   bun run scripts/broker/tests/broker/test-broker-auth.ts
 */
export {};
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => { results.push({ name, ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`); };

async function spawnBroker(
  port: number,
  env: Record<string, string>,
  prepare?: (home: string) => void,
) {
  const home = mkdtempSync(join(tmpdir(), 'cosyncing-auth-'));
  prepare?.(home);
  const broker = Bun.spawn(['bun', 'packages/typescript/broker/src/main.ts'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(port),
      HOST: '127.0.0.1',
      COSYNCING_MACHINE: 'auth-test',
      COSYNCING_DEV_MODE: '1', // source-only Claude hook contract; packaged builds expose no hook routes
      COSYNCING_HOME: home,
      COSYNCING_RESTART_DRY_RUN: '1', // never actually relaunch during the test
      COSYNCING_OPENCODE_NO_AUTOSERVE: '1', // don't spawn a managed opencode serve
      COSYNCING_CODEX_SYNC_SERVER: '0', // never inherit a developer daemon/socket
      COSYNCING_CODEX_APP_SERVER_SOCK: '',
      COSYNCING_CODEX_REMOTE_ADDR: '',
      ...env,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  });
  const base = `http://127.0.0.1:${port}`;
  let up = false;
  for (let i = 0; i < 80 && !up; i++) {
    try { up = (await fetch(`${base}/api/health`)).ok; } catch {}
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  return { broker, base, home, up };
}
const status = async (base: string, path: string, init?: RequestInit): Promise<number> => {
  try { return (await fetch(`${base}${path}`, init)).status; } catch { return -1; }
};

const TOKEN = 'auth-test-secret';
const PI_CREDENTIAL = 'pi-route-only-credential-0123456789abcdefghijklmno';
const withTok: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json', 'x-cosyncing-token': TOKEN }, body: '{}' };
const noTok = (method = 'POST'): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: method === 'DELETE' ? undefined : '{}' });

// Mutating routes that MUST be gated when a token is set (one representative per class the review flagged).
const MUTATING: [string, RequestInit][] = [
  ['/api/broker/restart', noTok()],
  ['/api/broker/restart-all', noTok()],
  ['/api/agents/codex/sync', noTok()],
  ['/api/agent-runtime-update-policy', noTok()],
  ['/api/agent-runtime-updates/codex/restart', noTok()],
  ['/api/tool/send_file', noTok()],
  ['/pi/bridge/hello', noTok()],
  ['/claude/hook/request', noTok()],
  ['/api/projects/rename', { ...noTok(), method: 'PATCH' }],
  ['/api/sessions/codex', noTok()], // createSession spawns a process — must be gated
  ['/api/attention-events/missing/ack', noTok()],
  ['/api/attention-events/missing/dismiss', noTok()],
  ['/api/attention-events/dismiss-batch', noTok()],
  ['/api/tokdash/quota-preference', noTok()],
  ['/api/schedules', noTok()],
  ['/api/schedules/missing', noTok('DELETE')],
  ['/api/schedules/missing', { ...noTok(), method: 'PATCH' }],
  ['/api/schedules/missing/actions', noTok()],
];

const SENSITIVE_GETS = [
  '/api/sessions/opencode/missing-session/fs',
  '/api/sessions/opencode/missing-session/fs/read?path=a.txt',
  '/api/sessions/opencode/missing-session/fs/download?path=a.txt',
  '/api/attention-events?clientId=auth-test',
  '/api/broker/health',
  '/api/tokdash/quota',
  '/api/tokdash/quota-preference',
  '/api/schedules', // carries complete future prompt text
  '/api/schedules/missing', // every schedule subroute is prompt-bearing/future-compatible
];

let piCredentialFile = '';
const tokened = await spawnBroker(7796, { COSYNCING_TOKEN: TOKEN }, (home) => {
  const secrets = join(home, 'secrets');
  mkdirSync(secrets, { recursive: true, mode: 0o700 });
  piCredentialFile = join(secrets, 'pi-integration.json');
  writeFileSync(piCredentialFile, JSON.stringify({
    schemaVersion: 1,
    kind: 'pi-bridge',
    internalUrl: 'http://127.0.0.1:7796',
    credential: PI_CREDENTIAL,
  }), { mode: 0o600 });
  chmodSync(piCredentialFile, 0o600);
  process.env.COSYNCING_PI_INTEGRATION_FILE = piCredentialFile;
});
try {
  check('tokened broker is up', tokened.up, tokened.base);

  // Read-only GETs stay OPEN without a token.
  check('GET /api/health open without token', (await status(tokened.base, '/api/health')) === 200);
  check('GET /api/sessions open without token', (await status(tokened.base, '/api/sessions')) === 200);

  // Every mutating route is 401 WITHOUT the token.
  for (const [p, init] of MUTATING) {
    const s = await status(tokened.base, p, init);
    check(`${init.method} ${p} → 401 without token`, s === 401, `status=${s}`);
  }

  for (const p of SENSITIVE_GETS) {
    const s = await status(tokened.base, p, { method: 'GET' });
    check(`GET ${p} → 401 without token`, s === 401, `status=${s}`);
  }

  // WITH the token, a mutating route is NOT 401 (codex/sync dry-run → 200; proves the token unlocks it).
  const okSync = await status(tokened.base, '/api/agents/codex/sync', { ...withTok, body: JSON.stringify({ enabled: false }) });
  check('POST /api/agents/codex/sync with token is accepted (not 401)', okSync !== 401 && okSync !== -1, `status=${okSync}`);
  // …and via the ?token= query param too (the path the WS stream uses).
  const okQuery = await status(tokened.base, `/api/agents/codex/sync?token=${TOKEN}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  check('mutating route accepts ?token= query param', okQuery !== 401 && okQuery !== -1, `status=${okQuery}`);

  const unauthResume = await fetch(`${tokened.base}/api/sessions/codex/missing/stream?mode=resume`);
  const unauthResumeBody = await unauthResume.json().catch(() => ({})) as any;
  check('unauthenticated direct resume is rejected with stable code',
    unauthResume.status === 401 && unauthResumeBody.code === 'RESUME_AUTH_REQUIRED',
    `status=${unauthResume.status} code=${String(unauthResumeBody.code)}`);
  const authResume = await status(tokened.base, `/api/sessions/codex/missing/stream?mode=resume&token=${TOKEN}`, { method: 'GET' });
  check('authenticated direct resume reaches the websocket upgrade boundary', authResume === 426, `status=${authResume}`);

  const piHeaders = { 'content-type': 'application/json', 'x-cosyncing-integration-token': PI_CREDENTIAL };
  const hello = await fetch(`${tokened.base}/pi/bridge/hello`, {
    method: 'POST',
    headers: piHeaders,
    body: JSON.stringify({ sessionFile: join(tokened.home, 'pi-session.jsonl'), cwd: tokened.home }),
  });
  const helloBody = await hello.json().catch(() => ({})) as any;
  check('route-scoped Pi credential authenticates Pi hello', hello.status === 200 && typeof helloBody.id === 'string', `status=${hello.status}`);
  const piStatus = await status(tokened.base, `/pi/bridge/status?id=${encodeURIComponent(String(helloBody.id ?? ''))}`, {
    method: 'GET', headers: { 'x-cosyncing-integration-token': PI_CREDENTIAL },
  });
  check('route-scoped Pi credential authenticates Pi GET legs', piStatus === 200, `status=${piStatus}`);
  const surfacedPath = join(tokened.home, 'pi-output.txt');
  writeFileSync(surfacedPath, 'scoped bridge output');
  const piSendFile = await fetch(`${tokened.base}/pi/bridge/send-file`, {
    method: 'POST',
    headers: piHeaders,
    body: JSON.stringify({ id: helloBody.id, path: surfacedPath }),
  });
  const piSendFileBody = await piSendFile.json().catch(() => ({})) as any;
  check('route-scoped Pi credential can surface a file only through its live bridge',
    piSendFile.status === 200 && piSendFileBody.ok === true,
    `status=${piSendFile.status}`);
  const forgedBridge = await status(tokened.base, '/pi/bridge/send-file', {
    method: 'POST', headers: piHeaders, body: JSON.stringify({ id: 'pi:forged', path: surfacedPath }),
  });
  check('route-scoped Pi send-file rejects a forged bridge identity', forgedBridge === 404, `status=${forgedBridge}`);

  const generalWithPi = await status(tokened.base, '/api/agents/codex/sync', {
    method: 'POST', headers: piHeaders, body: JSON.stringify({ enabled: false }),
  });
  check('Pi credential cannot authorize general broker control', generalWithPi === 401, `status=${generalWithPi}`);
  const resumeWithPi = await fetch(`${tokened.base}/api/sessions/codex/missing/stream?mode=resume`, {
    headers: { 'x-cosyncing-integration-token': PI_CREDENTIAL },
  });
  const resumeWithPiBody = await resumeWithPi.json().catch(() => ({})) as any;
  check('Pi credential cannot authorize Drive resume',
    resumeWithPi.status === 401 && resumeWithPiBody.code === 'RESUME_AUTH_REQUIRED',
    `status=${resumeWithPi.status}`);

  const confusedGeneralHeader = await status(tokened.base, '/pi/bridge/hello', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-cosyncing-token': PI_CREDENTIAL }, body: '{}',
  });
  check('Pi credential is rejected in the shared-token header', confusedGeneralHeader === 401, `status=${confusedGeneralHeader}`);
  const confusedPiHeader = await status(tokened.base, '/pi/bridge/hello', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-cosyncing-integration-token': TOKEN }, body: '{}',
  });
  check('shared token is rejected in the Pi integration header', confusedPiHeader === 401, `status=${confusedPiHeader}`);

  const scheduleHeaders = { 'content-type': 'application/json', 'x-cosyncing-token': TOKEN };
  const repeatingMessage = await status(tokened.base, '/api/schedules', {
    method: 'POST', headers: scheduleHeaders,
    body: JSON.stringify({ kind: 'message', tool: 'codex', sessionId: 's', text: 'later', at: Date.now() + 60_000, repeat: 'daily' }),
  });
  check('existing-session schedules reject repeat (D5 one-shot)', repeatingMessage === 400, `status=${repeatingMessage}`);
  const unknownRepeat = await status(tokened.base, '/api/schedules', {
    method: 'POST', headers: scheduleHeaders,
    body: JSON.stringify({ kind: 'new-session', tool: 'codex', text: 'later', at: Date.now() + 60_000, repeat: 'weekly' }),
  });
  check('unknown repeat values fail instead of silently becoming one-shot', unknownRepeat === 400, `status=${unknownRepeat}`);

  const invalidCron = await fetch(`${tokened.base}/api/schedules`, {
    method: 'POST', headers: scheduleHeaders,
    body: JSON.stringify({ kind: 'message', tool: 'codex', sessionId: 's', text: 'later', cron: { expression: '0 25 * * *', timeZone: 'UTC' } }),
  });
  const invalidCronBody = await invalidCron.json().catch(() => ({})) as any;
  check('invalid cron has a stable typed failure',
    invalidCron.status === 400 && invalidCronBody.code === 'SCHEDULE_CRON_INVALID',
    `status=${invalidCron.status} code=${String(invalidCronBody.code)}`);

  const recurringMessage = await fetch(`${tokened.base}/api/schedules`, {
    method: 'POST', headers: scheduleHeaders,
    body: JSON.stringify({ kind: 'message', tool: 'codex', sessionId: 's', text: 'later', cron: { expression: '0 0 * * *', timeZone: 'UTC' } }),
  });
  const recurringMessageBody = await recurringMessage.json().catch(() => ({})) as any;
  check('crafted existing-session cron remains rejected by the D5 one-shot boundary',
    recurringMessage.status === 400 && recurringMessageBody.code === 'SCHEDULE_INVALID',
    `status=${recurringMessage.status} code=${String(recurringMessageBody.code)}`);

  const createCron = await fetch(`${tokened.base}/api/schedules`, {
    method: 'POST', headers: scheduleHeaders,
    body: JSON.stringify({
      kind: 'new-session', tool: 'codex', title: 'Scheduled target', text: 'full private prompt',
      cron: { expression: '0 0 1 1 *', timeZone: 'UTC' },
      retryPolicy: { maxRetries: 2, delayMs: 60_000, backoff: 'exponential', retryOn: ['delivery', 'quota'] },
      futureAdditiveField: { ignored: true },
    }),
  });
  const createCronBody = await createCron.json().catch(() => ({})) as any;
  const scheduleId = String(createCronBody.schedule?.id ?? '');
  check('authenticated arbitrary-cron schedule is broker-timed and revisioned',
    createCron.status === 201 && scheduleId.length > 0 && createCronBody.schedule?.revision === 1
      && createCronBody.schedule?.at > Date.now() && createCronBody.schedule?.retryPolicy?.maxRetries === 2,
    `status=${createCron.status} revision=${String(createCronBody.schedule?.revision)}`);

  const edit = await fetch(`${tokened.base}/api/schedules/${encodeURIComponent(scheduleId)}`, {
    method: 'PATCH', headers: scheduleHeaders,
    body: JSON.stringify({ expectedRevision: 1, text: 'edited private prompt', title: 'Edited', futureAdditiveField: true }),
  });
  const editBody = await edit.json().catch(() => ({})) as any;
  check('schedule edit accepts additive data and advances revision',
    edit.status === 200 && editBody.schedule?.revision === 2 && editBody.schedule?.text === 'edited private prompt',
    `status=${edit.status} revision=${String(editBody.schedule?.revision)}`);

  const staleEdit = await fetch(`${tokened.base}/api/schedules/${encodeURIComponent(scheduleId)}`, {
    method: 'PATCH', headers: scheduleHeaders,
    body: JSON.stringify({ expectedRevision: 1, text: 'stale overwrite' }),
  });
  const staleEditBody = await staleEdit.json().catch(() => ({})) as any;
  check('stale schedule edit is a stable conflict',
    staleEdit.status === 409 && staleEditBody.code === 'SCHEDULE_STALE',
    `status=${staleEdit.status} code=${String(staleEditBody.code)}`);

  const pause = await fetch(`${tokened.base}/api/schedules/${encodeURIComponent(scheduleId)}/actions`, {
    method: 'POST', headers: scheduleHeaders,
    body: JSON.stringify({ action: 'pause', expectedRevision: 2 }),
  });
  const pauseBody = await pause.json().catch(() => ({})) as any;
  check('typed pause action advances a schedule to paused',
    pause.status === 200 && pauseBody.schedule?.state === 'paused' && pauseBody.schedule?.revision === 3,
    `status=${pause.status} state=${String(pauseBody.schedule?.state)}`);

  const invalidRunNow = await fetch(`${tokened.base}/api/schedules/${encodeURIComponent(scheduleId)}/actions`, {
    method: 'POST', headers: scheduleHeaders,
    body: JSON.stringify({ action: 'run-now', expectedRevision: 3 }),
  });
  const invalidRunNowBody = await invalidRunNow.json().catch(() => ({})) as any;
  check('unsupported lifecycle transition has a stable typed conflict',
    invalidRunNow.status === 409 && invalidRunNowBody.code === 'SCHEDULE_INVALID_STATE',
    `status=${invalidRunNow.status} code=${String(invalidRunNowBody.code)}`);

  const resume = await fetch(`${tokened.base}/api/schedules/${encodeURIComponent(scheduleId)}/actions`, {
    method: 'POST', headers: scheduleHeaders,
    body: JSON.stringify({ action: 'resume', expectedRevision: 3 }),
  });
  const resumeScheduleBody = await resume.json().catch(() => ({})) as any;
  check('typed resume action returns to scheduled',
    resume.status === 200 && resumeScheduleBody.schedule?.state === 'scheduled' && resumeScheduleBody.schedule?.revision === 4,
    `status=${resume.status} state=${String(resumeScheduleBody.schedule?.state)}`);

  const noQuotaEvidence = await fetch(`${tokened.base}/api/schedules/${encodeURIComponent(scheduleId)}/actions`, {
    method: 'POST', headers: scheduleHeaders,
    body: JSON.stringify({ action: 'recover-quota', expectedRevision: 4 }),
  });
  const noQuotaEvidenceBody = await noQuotaEvidence.json().catch(() => ({})) as any;
  check('quota recovery requires an exhausted native quota failure',
    noQuotaEvidence.status === 409 && noQuotaEvidenceBody.code === 'SCHEDULE_QUOTA_RECOVERY_UNAVAILABLE',
    `status=${noQuotaEvidence.status} code=${String(noQuotaEvidenceBody.code)}`);
} finally {
  tokened.broker.kill();
  await tokened.broker.exited.catch(() => null);
  rmSync(tokened.home, { recursive: true, force: true });
  delete process.env.COSYNCING_PI_INTEGRATION_FILE;
}

// Loopback baseline: NO token → every route open (a mutation is not 401).
const open = await spawnBroker(7797, {});
try {
  check('no-token broker is up', open.up, open.base);
  const s = await status(open.base, '/api/agents/codex/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: false }) });
  check('no-token baseline: mutating route is NOT gated (open)', s !== 401 && s !== -1, `status=${s}`);
  const observe = await status(open.base, '/api/sessions/codex/missing/stream', { method: 'GET' });
  check('no-token loopback Observe still reaches websocket upgrade boundary', observe === 426, `status=${observe}`);
  const resume = await fetch(`${open.base}/api/sessions/codex/missing/stream?mode=resume`);
  const resumeBody = await resume.json().catch(() => ({})) as any;
  check('no-token loopback Drive resume still requires a credential',
    resume.status === 401 && resumeBody.code === 'RESUME_AUTH_REQUIRED',
    `status=${resume.status} code=${String(resumeBody.code)}`);
} finally {
  open.broker.kill();
  await open.broker.exited.catch(() => null);
  rmSync(open.home, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
if (failed.length) { console.error(`\nFAIL: ${failed.length}/${results.length} broker-auth check(s) failed.`); process.exit(1); }
console.log(`\n✅ ${results.length}/${results.length} broker-auth checks passed.`);
