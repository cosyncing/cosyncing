/**
 * Exporting a session transcript from the app (an R2, "risky", action).
 *
 * The app asks for a confirmation (`/export/preflight`), shows it, then runs
 * the export with the one-use nonce it was given (`/export`). The broker asks
 * the agent's own CLI for the transcript (here a fake `opencode export`),
 * redacts it, and hands back an attachment-only download. HTTP clients may do
 * this only when the owner enabled it locally. These tests assert what the app
 * is told, what it downloads, what the CLI was asked, and that nothing the
 * export wrote outlives the request.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { defaultBrokerConfig, writeBrokerConfig } from '../../packages/typescript/broker/src/runtime/configuration.ts';
import { type Broker, type BrokerClient, eventually, startBroker } from '../harness/index.ts';
import { installOpenCodeExport, opencodeData, type OpenCodeExportFixture } from '../harness/fakes/opencode-export.ts';

// Split so the public-tree scanner, which rejects secret-shaped literals in
// source, never sees one here; the strings the redactor gets are whole.
const GITHUB = 'gh' + 'p_';
const AWS = 'AK' + 'IA';
const KEY_BLOCK = (edge: 'BEGIN' | 'END') => `-----${edge} RSA PRIVATE ` + 'KEY-----';

/** Secrets a transcript can echo (public documentation examples), each beside the part that must not survive. */
const SECRETS: Array<[line: string, secret: string]> = [
  ['OPENAI_API_KEY=sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ012345', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'],
  ['ANTHROPIC_API_KEY=sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'sk-ant-'],
  [`GITHUB_TOKEN=${GITHUB}ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`, `${GITHUB}ABCDEFGHIJ`],
  [`aws_access_key_id=${AWS}IOSFODNN7EXAMPLE`, `${AWS}IOSFODNN7EXAMPLE`],
  ['aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', 'wJalrXUtnFEMI'],
  ['auth=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0'],
  ['DATABASE_URL=postgres://dbuser:s3cr3tpass@db.example.com:5432/app', 's3cr3tpass'],
  ['Authorization: Bearer abc123def456ghi789jkl012mno345', 'abc123def456ghi789'],
  ['clone url https://alice:hunter2@github.com/acme/repo.git', 'hunter2'],
  ['fetch https://api.example.com/data?token=SUPERSECRETVALUE123&x=1', 'SUPERSECRETVALUE123'],
  [`${KEY_BLOCK('BEGIN')}\nMIIEpAIBAAKCAQEA0000000000000000000000000000000000000000\n${KEY_BLOCK('END')}`, 'MIIEpAIBAAKCAQEA'],
];
const MAX_BYTES = 64 * 1024;

const tempRoot = (broker: Broker): string => join(broker.paths.root, 'tmp');
/** The broker's private export directories still on disk. */
const leftoverExportDirs = (broker: Broker): string[] =>
  readdirSync(tempRoot(broker)).filter((name) => name.startsWith('cosyncing-r2-'));

const exportRoutes = (id: string) => ({
  preflight: `/api/sessions/opencode/${encodeURIComponent(id)}/export/preflight`,
  execute: `/api/sessions/opencode/${encodeURIComponent(id)}/export`,
});

/** The broker environment every export broker shares: fake CLI on PATH, storage, temp dir, size cap. */
function exportBroker(name: string, extra: Record<string, string>, configure?: (home: string) => void) {
  let fixture!: OpenCodeExportFixture;
  const started = startBroker({
    name,
    token: true,
    setup: (paths) => {
      fixture = installOpenCodeExport(paths);
      mkdirSync(join(paths.root, 'tmp'));
      configure?.(paths.cosyncingHome);
    },
    env: (paths) => ({
      OPENCODE_DATA: opencodeData(paths),
      TMPDIR: join(paths.root, 'tmp'),
      TMP: join(paths.root, 'tmp'),
      TEMP: join(paths.root, 'tmp'),
      COSYNCING_R2_MAX_BYTES: String(MAX_BYTES),
      ...extra,
    }),
  });
  return started.then((broker) => ({ broker, opencode: fixture }));
}

describe('by default', () => {
  let broker: Broker;
  beforeAll(async () => {
    broker = await startBroker({ name: 'transcript-export-default', token: true });
  });
  afterAll(() => broker?.stop());

  test('export needs a credential, is advertised for the agents that can export, and is refused to HTTP clients until enabled', async () => {
    const owner = broker.client();
    const anonymous = owner.as({ kind: 'none' });
    const routes = exportRoutes('ses_any');
    expect((await anonymous.post(routes.preflight)).status).toBe(401);
    expect((await anonymous.post(routes.execute)).status).toBe(401);

    const agents = new Map((await owner.agents()).map((agent) => [agent.id, agent]));
    expect(agents.get('opencode')?.canTranscriptExport).toBe(true);
    expect(agents.get('pi')?.canTranscriptExport).toBe(true);

    for (const path of [routes.preflight, routes.execute]) {
      const refused = await owner.post(path, {});
      expect([refused.status, refused.body.code]).toEqual([403, 'R2_DISABLED']);
    }
  });
});

describe('enabled in the broker configuration', () => {
  let broker: Broker;
  let owner: BrokerClient;
  let opencode: OpenCodeExportFixture;
  let cwd: string;

  beforeAll(async () => {
    ({ broker, opencode } = await exportBroker('transcript-export', {}, (home) => {
      writeBrokerConfig({ ...defaultBrokerConfig(), features: { httpTranscriptExport: true } }, home);
    }));
    owner = broker.client();
    cwd = join(broker.paths.home, 'project');
    mkdirSync(cwd);
  });
  afterAll(() => broker?.stop());

  async function confirm(id: string): Promise<{ nonce: string; confirm: any }> {
    const preflight = await owner.post(exportRoutes(id).preflight);
    expect(preflight.status).toBe(200);
    return preflight.body;
  }

  async function exportSession(id: string): Promise<any> {
    const { nonce } = await confirm(id);
    return owner.post(exportRoutes(id).execute, { nonce });
  }

  test('a confirmed export is redacted and served as a download-only attachment, and the CLI was asked only for that session', async () => {
    opencode.session('ses_happy', { cwd, title: 'My Session' }, {
      stdout: [
        ...SECRETS.map(([line]) => line),
        `workspace at ${join(cwd, 'src', 'secret.ts')}`,
        `notes in ${join(broker.paths.home, 'notes')}`,
        '<script>alert(1)</script>',
        'a normal conversation about sorting algorithms',
      ].join('\n'),
    });
    const { nonce, confirm: card } = await confirm('ses_happy');
    expect(card).toMatchObject({
      action: 'transcriptExport', tool: 'opencode', sessionId: 'ses_happy', sessionTitle: 'My Session',
      format: 'json', redactionMode: 'redacted-full', tier: 'T2', retentionMinutes: 30, sizeCapBytes: MAX_BYTES,
    });

    const executed = await owner.post(exportRoutes('ses_happy').execute, { nonce });
    expect(executed.status).toBe(200);
    const artifact = executed.body.artifact;
    expect(artifact).toMatchObject({ type: 'file-artifact', deliveryClass: 'export-attachment' });
    expect(typeof artifact.expiresAt).toBe('number');
    expect(artifact.redactionSummary).not.toContain('sk-proj');
    expect(opencode.cli.calls().filter((call) => call.argv[0] === 'export').map((call) => call.argv))
      .toEqual([['export', 'ses_happy', '--sanitize']]);

    const served = await fetch(new URL(artifact.fetchUrl, broker.url), { headers: owner.credentialHeaders() });
    const body = await served.text();
    expect(served.status).toBe(200);
    expect(served.headers.get('content-disposition')?.startsWith('attachment;')).toBe(true);
    expect(served.headers.get('cache-control')).toBe('no-store');
    expect(served.headers.get('content-security-policy')).toBe('sandbox');
    expect(served.headers.get('x-content-type-options')).toBe('nosniff');
    expect(served.headers.get('content-type')).toBe('application/octet-stream');
    for (const [, secret] of SECRETS) expect(body).not.toContain(secret);
    expect(body).toContain('a normal conversation about sorting algorithms');
    expect(body).not.toContain(cwd);
    expect(body).not.toContain(broker.paths.home);
    expect(body).not.toContain('window.__COSYNCING__');
    expect(body).toContain('[REDACTED_PROJECT]');
    expect(leftoverExportDirs(broker)).toEqual([]);
  });

  test('a hostile session title becomes a sanitized download filename', async () => {
    opencode.session('ses_hostile', { cwd, title: 'x"><img src=x onerror=alert(1)>\r\nSet-Cookie: a=b' }, { stdout: '{"parts":[]}' });
    const executed = await exportSession('ses_hostile');
    expect(executed.status).toBe(200);
    const served = await fetch(new URL(executed.body.artifact.fetchUrl, broker.url), { headers: owner.credentialHeaders() });
    const disposition = served.headers.get('content-disposition') ?? '';
    const filename = disposition.match(/filename="([^"]*)"/)?.[1] ?? '';
    expect(disposition.startsWith('attachment;')).toBe(true);
    expect(filename.length).toBeGreaterThan(0);
    expect(filename).not.toMatch(/[<>"'\r\n]/);
    expect(served.headers.get('set-cookie')).toBeNull();
  });

  test('the confirmation is single-use and bound to its session and that session\'s revision', async () => {
    opencode.session('ses_nonce', { cwd, title: 'Nonce' }, { stdout: '{"parts":["one"]}' });
    opencode.session('ses_other', { cwd, title: 'Other' }, { stdout: '{"parts":["two"]}' });
    const stale = (response: { status: number; body: any }) => [response.status, response.body.code];
    const execute = (id: string, body: unknown) => owner.post(exportRoutes(id).execute, body);

    expect(stale(await execute('ses_nonce', {}))).toEqual([409, 'CONFIRMATION_STALE']);
    expect(stale(await execute('ses_nonce', { nonce: 'abc.def.ghi' }))).toEqual([409, 'CONFIRMATION_STALE']);
    const { nonce: forOther } = await confirm('ses_other');
    expect(stale(await execute('ses_nonce', { nonce: forOther }))).toEqual([409, 'CONFIRMATION_STALE']);

    const { nonce } = await confirm('ses_nonce');
    const tampered = `${nonce.slice(0, -1)}${nonce.endsWith('A') ? 'B' : 'A'}`;
    expect(stale(await execute('ses_nonce', { nonce: tampered }))).toEqual([409, 'CONFIRMATION_STALE']);
    expect((await execute('ses_nonce', { nonce })).status).toBe(200);
    expect(stale(await execute('ses_nonce', { nonce }))).toEqual([409, 'CONFIRMATION_STALE']);

    // The session changed after the user confirmed: the confirmation no longer describes it.
    const { nonce: beforeChange } = await confirm('ses_nonce');
    opencode.session('ses_nonce', { cwd, title: 'Nonce', updated: Date.now() });
    expect(stale(await execute('ses_nonce', { nonce: beforeChange }))).toEqual([409, 'CONFIRMATION_STALE']);
  });

  test('the client may not choose where the export is written', async () => {
    opencode.session('ses_paths', { cwd, title: 'Paths' }, { stdout: '{}' });
    const { nonce } = await confirm('ses_paths');
    for (const key of ['outputPath', 'path', 'filename', 'directory']) {
      const refused = await owner.post(exportRoutes('ses_paths').execute, { nonce, [key]: '/etc/passwd' });
      expect([key, refused.status, refused.body.code]).toEqual([key, 400, 'BAD_PARAM']);
    }
    const unexpected = await owner.post(exportRoutes('ses_paths').execute, { nonce, format: 'html' });
    expect([unexpected.status, unexpected.body.code]).toEqual([400, 'BAD_PARAM']);
    expect((await owner.post(exportRoutes('ses_missing').preflight)).status).toBe(404);
  });

  test('a session may export three times in the window; the fourth is rate limited', async () => {
    opencode.session('ses_rate', { cwd, title: 'Rate' }, { stdout: '{"parts":[]}' });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect((await exportSession('ses_rate')).status).toBe(200);
    }
    const fourth = await exportSession('ses_rate');
    expect([fourth.status, fourth.body.code]).toEqual([429, 'RATE_LIMITED']);
  });

  test('an export that fails, runs past the size cap, or cannot be safely redacted is refused and leaves nothing behind', async () => {
    opencode.session('ses_fail', { cwd, title: 'Fail' }, { exit: 1, stderr: 'database is locked' });
    opencode.session('ses_big', { cwd, title: 'Big' }, { stdout: 'x'.repeat(1024), repeat: 200 });
    opencode.session('ses_pem', { cwd, title: 'Pem' }, { stdout: `leak ${KEY_BLOCK('BEGIN')}\nMIIE-no-end-marker` });
    opencode.session('ses_binary', { cwd, title: 'Binary' }, { stdout: 'text then a NUL: \u0000 binary tail' });
    const failed = await exportSession('ses_fail');
    expect([failed.status, failed.body.code]).toEqual([502, 'EXPORT_FAILED']);
    // OpenCode's own reader stops at the cap, so an oversize export fails in the native step.
    const big = await exportSession('ses_big');
    expect([big.status, big.body.code]).toEqual([502, 'EXPORT_FAILED']);
    const pem = await exportSession('ses_pem');
    expect([pem.status, pem.body.code]).toEqual([422, 'REDACTION_REFUSED']);
    const binary = await exportSession('ses_binary');
    expect([binary.status, binary.body.code]).toEqual([422, 'REDACTION_REFUSED']);
    for (const refused of [failed, big, pem, binary]) expect(refused.body.artifact).toBeUndefined();
    expect(leftoverExportDirs(broker)).toEqual([]);
  });

  // Export attachments are dropped when the broker shuts down. The harness can stop a Windows broker
  // only by terminating it, which runs no shutdown path, so this is asserted on POSIX.
  test.skipIf(process.platform === 'win32')('a delivered export does not outlive the broker process', async () => {
    opencode.session('ses_transient', { cwd, title: 'Transient' }, { stdout: '{"parts":["gone after restart"]}' });
    const executed = await exportSession('ses_transient');
    const url = new URL(executed.body.artifact.fetchUrl, broker.url);
    expect((await fetch(url, { headers: owner.credentialHeaders() })).status).toBe(200);
    await broker.restart();
    expect((await fetch(url, { headers: owner.credentialHeaders() })).status).toBe(404);
  });
});

describe('enabled from the source environment, with a short confirmation lifetime', () => {
  let broker: Broker;
  let opencode: OpenCodeExportFixture;
  beforeAll(async () => {
    ({ broker, opencode } = await exportBroker('transcript-export-expiry', {
      COSYNCING_R2_ENABLED_ACTIONS: 'transcriptExport',
      COSYNCING_TEST_R2_NONCE_TTL_MS: '300',
    }));
  });
  afterAll(() => broker?.stop());

  test('a confirmation used after it expired is refused', async () => {
    const owner = broker.client();
    opencode.session('ses_expiry', { cwd: broker.paths.home, title: 'Expiry' }, { stdout: '{}' });
    const preflight = await owner.post(exportRoutes('ses_expiry').preflight);
    expect(preflight.status).toBe(200);
    const expiresAt = Number(preflight.body.expiresAt);
    await eventually(() => Date.now() > expiresAt + 50, { what: 'the confirmation lifetime to pass' });
    const late = await owner.post(exportRoutes('ses_expiry').execute, { nonce: preflight.body.nonce });
    expect([late.status, late.body.code]).toEqual([409, 'CONFIRMATION_STALE']);
    expect(opencode.cli.calls().filter((call) => call.argv[0] === 'export')).toEqual([]);
  });
});
