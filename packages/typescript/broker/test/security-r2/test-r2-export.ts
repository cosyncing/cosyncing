/**
 * Adversarial no-model tests for the R2 export ENFORCEMENT ENGINE: the confirmation nonce, trust-tier
 * default-deny, rate limiting, the redact+attachment orchestrator, and the artifact store's
 * export-attachment ingestion/delivery. Uses the REAL modules with FAKE `AgentBackend.exportTranscript`
 * implementations — no live opencode/pi, no network, no model, no paid credentials.
 *
 * Covers GPT-Pro §3 threat rows: no-nonce, stale-revision, confused-deputy nonce tamper, outputPath
 * traversal / fake-native outside path, symlink race, oversized DoS, arbitrary-path artifact
 * exfiltration, XSS-in-transcript attachment headers + hostile filename, rate limiting, temp cleanup on
 * every failure phase.
 *
 *   bun run packages/typescript/broker/test/security-r2/test-r2-export.ts
 */
export {};
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentBackend, AgentMessage } from '../../../adapter-api/src/index.ts';
import { ArtifactStore } from '../../src/artifacts/artifact-store.ts';
import { runTranscriptExport } from '../../src/security/r2-export.ts';
import {
  __resetR2RateLimitsForTest,
  assertR2ActionsSafe,
  consumeConfirmNonce,
  deriveSessionRevision,
  getR2Action,
  issueConfirmNonce,
  r2ActionAvailable,
  reserveR2RateSlot,
  trustTierForAddress,
  type NonceBinding,
} from '../../src/security/r2-policy.ts';
import type { R2ActionDescriptor } from '../../../../../scripts/broker/capabilities/types.ts';

const results: { name: string; ok: boolean; detail: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

const action = getR2Action('transcriptExport')!;
const roots: string[] = [];
function storeRoot(): string {
  const r = mkdtempSync(join(tmpdir(), 'cosyncing-r2store-'));
  roots.push(r);
  return r;
}

/** A fake backend whose exportTranscript writes `content` into the broker-provided tempDir. Records the
 *  tempDir it was handed so the test can assert it is cleaned up afterwards. */
function fakeBackend(cfg: {
  format: 'json' | 'html';
  write: (tempDir: string) => string; // returns the path to return from the hook
}): { backend: AgentBackend; lastTempDir: () => string | undefined } {
  let seen: string | undefined;
  const backend = {
    id: 'fake',
    displayName: 'Fake',
    transcriptExportFormat: cfg.format,
    async exportTranscript(_id: string, opts: { tempDir: string; maxBytes: number; timeoutMs: number }) {
      seen = opts.tempDir;
      const path = cfg.write(opts.tempDir);
      return { path, format: cfg.format };
    },
  } as unknown as AgentBackend;
  return { backend, lastTempDir: () => seen };
}

async function run(backend: AgentBackend, session = { tool: 'fake', id: 's1', cwd: '/home/tester/proj', title: 'My Session' }) {
  const store = new ArtifactStore('http://127.0.0.1:7734', storeRoot());
  const result = await runTranscriptExport({ backend, action, session, artifactStore: store, brokerUrl: 'http://127.0.0.1:7734' });
  return { store, result };
}

// ── Happy path: redact + attachment delivery + download-only headers ──
{
  const fb = fakeBackend({
    format: 'json',
    write: (dir) => {
      const p = join(dir, 'export.json');
      writeFileSync(p, JSON.stringify({ info: { path: '/home/tester/proj/x' }, key: 'OPENAI_API_KEY=sk-proj-ABCDEFGHIJKLMNOPQRSTUVWX0123' }));
      return p;
    },
  });
  const { store, result } = await run(fb.backend);
  check('happy path exports ok', result.ok && result.status === 200, JSON.stringify(result));
  const art = result.artifact as (AgentMessage & { type: 'file-artifact' }) | undefined;
  check('artifact is an export-attachment', art?.deliveryClass === 'export-attachment', JSON.stringify(art));
  check('artifact carries a fetchUrl + opaque key + expiry', !!art?.fetchUrl && !!art?.artifactKey && !!art?.expiresAt, JSON.stringify(art));
  check('redaction summary present, no secret content', typeof art?.redactionSummary === 'string' && !/sk-proj/.test(art!.redactionSummary!), art?.redactionSummary);
  check('native temp root cleaned after success', !existsSync(fb.lastTempDir()!), fb.lastTempDir());

  const u = new URL(art!.fetchUrl!, 'http://127.0.0.1');
  const served = store.serve('fake', 's1', art!.artifactKey!, u.searchParams.get('expires'), u.searchParams.get('sig'));
  check('served export status 200', served.status === 200, String(served.status));
  check('served as attachment', (served.headers.get('content-disposition') || '').startsWith('attachment;'), served.headers.get('content-disposition') || '');
  check('served with no-store', served.headers.get('cache-control') === 'no-store', served.headers.get('cache-control') || '');
  check('served with CSP sandbox', served.headers.get('content-security-policy') === 'sandbox', served.headers.get('content-security-policy') || '');
  check('served with nosniff', served.headers.get('x-content-type-options') === 'nosniff', served.headers.get('x-content-type-options') || '');
  check('served as octet-stream (never text/html inline)', served.headers.get('content-type') === 'application/octet-stream', served.headers.get('content-type') || '');
  const body = await served.text();
  check('served bytes are redacted', !/sk-proj-[A-Za-z0-9]{20,}/.test(body) && !body.includes('/home/tester'), body.slice(0, 200));
  check('served bytes never inline-render the cosyncing bridge', !body.includes('window.__COSYNCING__'), body.slice(0, 80));
}

// ── XSS-in-transcript (HTML) + hostile filename → still an attachment with a sanitized filename ──
{
  const fb = fakeBackend({
    format: 'html',
    write: (dir) => {
      const p = join(dir, 'export.html');
      writeFileSync(p, '<html><body><script>alert(1)</script><img src=x onerror=alert(2)></body></html>');
      return p;
    },
  });
  const { store, result } = await run(fb.backend, { tool: 'fake', id: 's1', cwd: '/home/tester/proj', title: 'x"><img src=x onerror=alert(1)>' });
  check('XSS html export still succeeds as attachment', result.ok, JSON.stringify(result));
  const art = result.artifact as AgentMessage & { type: 'file-artifact' };
  const u = new URL(art.fetchUrl!, 'http://127.0.0.1');
  const served = store.serve('fake', 's1', art.artifactKey!, u.searchParams.get('expires'), u.searchParams.get('sig'));
  const cd = served.headers.get('content-disposition') || '';
  const fname = cd.match(/filename="([^"]*)"/)?.[1] ?? '';
  check('hostile filename is sanitized in Content-Disposition', cd.startsWith('attachment;') && fname.length > 0 && !/[<>"'\r\n]/.test(fname), `${cd} (filename=${fname})`);
  check('served HTML is never inline (octet-stream + sandbox)', served.headers.get('content-type') === 'application/octet-stream' && served.headers.get('content-security-policy') === 'sandbox', '');
}

// ── Oversize → killed/refused + temp cleaned ──
{
  const prev = process.env.COSYNCING_R2_MAX_BYTES;
  process.env.COSYNCING_R2_MAX_BYTES = '1024';
  const fb = fakeBackend({ format: 'json', write: (dir) => { const p = join(dir, 'export.json'); writeFileSync(p, '['.padEnd(4096, 'x')); return p; } });
  const { result } = await run(fb.backend);
  check('oversize export refused (413 EXPORT_TOO_LARGE)', !result.ok && result.status === 413 && result.code === 'EXPORT_TOO_LARGE', JSON.stringify(result));
  check('oversize temp root cleaned', !existsSync(fb.lastTempDir()!), fb.lastTempDir());
  if (prev == null) delete process.env.COSYNCING_R2_MAX_BYTES; else process.env.COSYNCING_R2_MAX_BYTES = prev;
}

// ── Fake-native OUTSIDE path (e.g. /etc/passwd-style) → refused + temp cleaned ──
{
  const outside = mkdtempSync(join(tmpdir(), 'cosyncing-r2-outside-'));
  roots.push(outside);
  const secret = join(outside, 'secret.json');
  writeFileSync(secret, JSON.stringify({ password: 'DATABASE_URL=postgres://u:p@h/db' }));
  const fb = fakeBackend({ format: 'json', write: () => secret /* returns a path OUTSIDE the broker temp root */ });
  const { result } = await run(fb.backend);
  check('fake-native outside path refused (PATH_ESCAPE)', !result.ok && result.code === 'PATH_ESCAPE', JSON.stringify(result));
  check('outside-path temp root cleaned', !existsSync(fb.lastTempDir()!), fb.lastTempDir());
  check('outside secret file was NOT ingested (no read/exfiltration)', existsSync(secret), 'secret should be untouched');
}

// ── Symlink in temp root pointing at an outside secret → refused + temp cleaned ──
{
  const outside = mkdtempSync(join(tmpdir(), 'cosyncing-r2-symtarget-'));
  roots.push(outside);
  const target = join(outside, 'id_rsa');
  writeFileSync(target, '-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----');
  const fb = fakeBackend({
    format: 'json',
    write: (dir) => {
      const link = join(dir, 'export.json');
      symlinkSync(target, link);
      return link;
    },
  });
  const { result } = await run(fb.backend);
  check('symlinked native export refused (PATH_SYMLINK)', !result.ok && result.code === 'PATH_SYMLINK', JSON.stringify(result));
  check('symlink temp root cleaned', !existsSync(fb.lastTempDir()!), fb.lastTempDir());
}

// ── Redaction refusal (unclosed private key) → refused + temp cleaned ──
{
  const fb = fakeBackend({ format: 'json', write: (dir) => { const p = join(dir, 'export.json'); writeFileSync(p, 'leak -----BEGIN RSA PRIVATE KEY-----\nMIIE-no-end-marker'); return p; } });
  const { result } = await run(fb.backend);
  check('redaction-refused export blocked (422 REDACTION_REFUSED)', !result.ok && result.status === 422 && result.code === 'REDACTION_REFUSED', JSON.stringify(result));
  check('redaction-refused temp root cleaned', !existsSync(fb.lastTempDir()!), fb.lastTempDir());
}

// ── Artifact store: arbitrary-path ingestion + serving refusals ──
{
  const root = storeRoot();
  const store = new ArtifactStore('http://127.0.0.1:7734', root);
  const tempRoot = mkdtempSync(join(tmpdir(), 'cosyncing-r2-ingest-'));
  roots.push(tempRoot);
  const outside = mkdtempSync(join(tmpdir(), 'cosyncing-r2-ingest-outside-'));
  roots.push(outside);
  const outsideFile = join(outside, 'evil.json');
  writeFileSync(outsideFile, '{}');
  let threw = false;
  try {
    store.putExportAttachment({ tool: 'fake', id: 's1' }, { name: 'x', format: 'json', retentionMs: 60000 }, outsideFile, tempRoot);
  } catch {
    threw = true;
  }
  check('export-attachment ingestion refuses a path outside the temp root', threw, 'expected throw');

  // Arbitrary artifactKey traversal on serve → 404, no filesystem read.
  const denied = store.serve('fake', 's1', '../../etc/passwd', String(Date.now() + 60000), 'nope');
  check('traversal artifactKey serve refused (not 200)', denied.status !== 200, String(denied.status));

  // Canonical file-artifact metadata with an arbitrary path + no url → no read, no fetchUrl advertised.
  const ref = store.toReference({ tool: 'fake', id: 's1' }, { type: 'file-artifact', path: '/etc/passwd', name: 'passwd', mimeType: 'text/plain' }) as AgentMessage & { type: 'file-artifact' };
  check('arbitrary local path artifact is not readable (no fetchUrl)', !ref.fetchUrl, JSON.stringify(ref));
}

// ── Confirmation nonce: no-nonce, stale-revision, confused-deputy, expiry, replay ──
{
  const binding: NonceBinding = { actionId: 'transcriptExport', tool: 'opencode', sessionId: 's1', revision: 'rev-1', format: 'json', redactionMode: 'redacted-full', tier: 'T2' };
  check('empty nonce rejected', !consumeConfirmNonce('', binding).ok, 'no-nonce');
  const { nonce } = issueConfirmNonce(binding, action.nonceTtlMs);
  const staleRev = consumeConfirmNonce(nonce, { ...binding, revision: 'rev-2' });
  check('stale-revision nonce rejected (CONFIRMATION_STALE)', !staleRev.ok, staleRev.reason);
  const confused = consumeConfirmNonce(nonce, { ...binding, actionId: 'deleteSession' });
  check('confused-deputy (action tamper) nonce rejected', !confused.ok, confused.reason);
  const good = consumeConfirmNonce(nonce, binding);
  check('correct binding nonce accepted once', good.ok, good.reason);
  const replay = consumeConfirmNonce(nonce, binding);
  check('nonce replay rejected (single-use)', !replay.ok, replay.reason);
  const expired = issueConfirmNonce(binding, 1);
  await new Promise((r) => setTimeout(r, 5));
  check('expired nonce rejected', !consumeConfirmNonce(expired.nonce, binding).ok, 'expiry');
  check('tampered nonce string rejected', !consumeConfirmNonce('abc.def.ghi', binding).ok, 'malformed');
}

// ── Trust tier + default-deny for non-loopback unless locally enabled ──
{
  check('loopback address is T1', trustTierForAddress('127.0.0.1') === 'T1' && trustTierForAddress('::1') === 'T1', '');
  check('LAN address is T2', trustTierForAddress('192.168.1.20') === 'T2', '');
  check('T1 may run transcriptExport (confirm still required)', r2ActionAvailable(action, 'T1').allowed, '');
  check('T3 may never run transcriptExport', !r2ActionAvailable(action, 'T3').allowed, '');
  const prev = process.env.COSYNCING_R2_ENABLED_ACTIONS;
  delete process.env.COSYNCING_R2_ENABLED_ACTIONS;
  check('T2 default-DENY when not locally enabled', !r2ActionAvailable(action, 'T2').allowed, 'should be denied');
  process.env.COSYNCING_R2_ENABLED_ACTIONS = 'transcriptExport';
  check('T2 allowed only after local enablement', r2ActionAvailable(action, 'T2').allowed, 'should be allowed');
  if (prev == null) delete process.env.COSYNCING_R2_ENABLED_ACTIONS; else process.env.COSYNCING_R2_ENABLED_ACTIONS = prev;
}

// ── Param schema forbids client-supplied paths ──
{
  check('registry rejects client output-path keys', action.paramSchema.rejectKeys.includes('outputPath') && action.paramSchema.rejectKeys.includes('path'), JSON.stringify(action.paramSchema));
  check('registry allows only the confirmation nonce param', action.paramSchema.allowedKeys.join(',') === 'nonce', JSON.stringify(action.paramSchema.allowedKeys));
}

// ── Rate limiting (rule 20) ──
{
  __resetR2RateLimitsForTest();
  const ok1 = reserveR2RateSlot(action, 'fake', 'rl1').ok;
  const ok2 = reserveR2RateSlot(action, 'fake', 'rl1').ok;
  const ok3 = reserveR2RateSlot(action, 'fake', 'rl1').ok;
  const fourth = reserveR2RateSlot(action, 'fake', 'rl1');
  check('per-session rate limit allows 3 then refuses', ok1 && ok2 && ok3 && !fourth.ok, JSON.stringify({ ok1, ok2, ok3, fourth }));
  __resetR2RateLimitsForTest();
}

// ── Decision #2 guard: mutating action may not bind the weak session-timestamp revision ──
{
  // The shipped registry is safe (only the read-only transcriptExport, session-timestamp).
  let shippedOk = true;
  try {
    assertR2ActionsSafe();
  } catch {
    shippedOk = false;
  }
  check('assertR2ActionsSafe accepts the shipped read-only registry', shippedOk);

  const bad: R2ActionDescriptor = { ...action, id: 'fakeDestructive', mutatesSession: true, revisionBinding: 'session-timestamp' };
  let rejected = false;
  try {
    assertR2ActionsSafe([bad]);
  } catch {
    rejected = true;
  }
  check('assertR2ActionsSafe REFUSES a mutating action bound to session-timestamp', rejected);

  const safe: R2ActionDescriptor = { ...action, id: 'fakeDestructive', mutatesSession: true, revisionBinding: 'last-message-id' };
  let accepted = true;
  try {
    assertR2ActionsSafe([safe]);
  } catch {
    accepted = false;
  }
  check('assertR2ActionsSafe accepts a mutating action with a content-derived revision', accepted);

  // deriveSessionRevision implements only the timestamp proxy; strong bindings fail closed (throw).
  check(
    'deriveSessionRevision(session-timestamp) uses updatedAt ?? createdAt',
    deriveSessionRevision({ updatedAt: 42, createdAt: 1 }, 'session-timestamp') === '42' &&
      deriveSessionRevision({ createdAt: 7 }, 'session-timestamp') === '7',
  );
  let threwStrong = false;
  try {
    deriveSessionRevision({ updatedAt: 42 }, 'last-message-id');
  } catch {
    threwStrong = true;
  }
  check('deriveSessionRevision fails closed for an unimplemented strong binding', threwStrong);
}

for (const r of roots) rmSync(r, { recursive: true, force: true });

const failed = results.filter((x) => !x.ok);
if (failed.length) {
  console.error(`\nFAIL: ${failed.length}/${results.length} R2 export check(s) failed.`);
  process.exit(1);
}
console.log(`\nPASS ${results.length}/${results.length} R2 export enforcement checks`);
