/**
 * Adversarial R2 export tests at the BROKER HTTP boundary (GPT-Pro §3: "CSRF / drive-by download" and
 * confused-deputy param tampering). Spawns the real broker on loopback with a token (same pattern as
 * test-broker-auth.ts) and drives the export routes. No model, no paid credentials; opencode autoserve
 * is disabled so the run is hermetic. The deeper nonce/redaction/attachment behaviour is unit-tested in
 * test-r2-export.ts (a real session would be required to exercise the full happy path over HTTP).
 *
 *   bun run scripts/broker/tests/security-r2/test-r2-broker.ts
 */
export {};
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: boolean, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
};

const TOKEN = 'r2-broker-secret';
const PORT = 7811;
const home = mkdtempSync(join(tmpdir(), 'cosyncing-r2broker-'));
const broker = Bun.spawn(['bun', 'packages/typescript/broker/src/main.ts'], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PORT: String(PORT),
    HOST: '127.0.0.1',
    COSYNCING_MACHINE: 'r2-broker-test',
    COSYNCING_HOME: home,
    COSYNCING_TOKEN: TOKEN,
    COSYNCING_RESTART_DRY_RUN: '1',
    COSYNCING_OPENCODE_NO_AUTOSERVE: '1',
  },
  stdout: 'ignore',
  stderr: 'ignore',
});
const base = `http://127.0.0.1:${PORT}`;
let up = false;
for (let i = 0; i < 80 && !up; i++) {
  try {
    up = (await fetch(`${base}/api/health`)).ok;
  } catch {
    /* not up yet */
  }
  if (!up) await new Promise((r) => setTimeout(r, 100));
}

try {
  check('r2 broker bound on loopback', up, up ? '' : 'broker did not bind — if this is a sandbox restriction, escalate to run localhost-bind tests');
  if (up) {
    const noTok = { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } as const;
    const withTok = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-cosyncing-token': TOKEN }, body: JSON.stringify(body) });

    // CSRF / default-deny: mutating export routes are 401 WITHOUT the token.
    const pre401 = (await fetch(`${base}/api/sessions/opencode/s1/export/preflight`, noTok)).status;
    check('export preflight is 401 without token (CSRF/default-deny)', pre401 === 401, `status=${pre401}`);
    const exec401 = (await fetch(`${base}/api/sessions/opencode/s1/export`, noTok)).status;
    check('export execute is 401 without token (CSRF/default-deny)', exec401 === 401, `status=${exec401}`);

    // Confused-deputy / no-client-paths: execute rejects a client-supplied output path (before any
    // session lookup) with 400 BAD_PARAM.
    const badParam = await fetch(`${base}/api/sessions/opencode/s1/export`, withTok({ outputPath: '/etc/passwd' }));
    const badParamBody = await badParam.json().catch(() => ({}));
    check('execute rejects client-supplied outputPath (400 BAD_PARAM)', badParam.status === 400 && (badParamBody as any).code === 'BAD_PARAM', `status=${badParam.status} body=${JSON.stringify(badParamBody)}`);

    // Capability advertisement: /api/agents (open GET) exposes canTranscriptExport for the agents whose
    // adapter implements the export hook (opencode + pi), computed from hook presence — never a name branch.
    const agents = (await (await fetch(`${base}/api/agents`)).json()) as any[];
    const byId = new Map(agents.map((a) => [a.id, a]));
    check('opencode advertises canTranscriptExport', byId.get('opencode')?.canTranscriptExport === true, JSON.stringify(byId.get('opencode')));
    check('pi advertises canTranscriptExport', byId.get('pi')?.canTranscriptExport === true, JSON.stringify(byId.get('pi')));
  }
} finally {
  broker.kill();
  await broker.exited.catch(() => null);
  rmSync(home, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.error(`\nFAIL: ${failed.length}/${results.length} R2 broker check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} R2 broker HTTP checks`);
