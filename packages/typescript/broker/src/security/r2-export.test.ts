/**
 * Transcript export against a misbehaving adapter, and the R2 policy table.
 *
 * `e2e/broker/transcript-export.test.ts` runs exports through a real broker
 * and a fake `opencode` CLI, which can only behave as OpenCode's adapter
 * lets it: the adapter writes the file itself, inside the broker's temp root.
 * What a buggy or hostile adapter could hand back instead — a path outside
 * that root, a symlink, a file over the cap — needs a fake backend in process.
 * So does the trust tier no HTTP request carries (T3), the registry guard
 * that refuses to boot an unsafe action table, and what the start sweep of the
 * export working directory may touch.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TranscriptExportTooLargeError, type AgentBackend } from '@cosyncing/adapter-api';
import { ArtifactStore } from '../artifacts/artifact-store.ts';
import { runTranscriptExport, sweepTranscriptExportWorkRoot, transcriptExportWorkRoot } from './r2-export.ts';
import { assertR2ActionsSafe, getR2Action, r2ActionAvailable, type R2ActionDescriptor } from './r2-policy.ts';

const root = mkdtempSync(join(tmpdir(), 'cosyncing-r2-export-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// The size cap under test is the descriptor's own; an operator override would replace it.
delete process.env.COSYNCING_R2_MAX_BYTES;
const action = getR2Action('transcriptExport')!;
const store = new ArtifactStore('http://127.0.0.1:7734', join(root, 'cache'));
const workRoot = transcriptExportWorkRoot(join(root, 'state'));

/** Run an export whose adapter does `write` in the temp dir it is handed; report the result and that dir. */
async function exportWith(write: (tempDir: string) => string, descriptor: R2ActionDescriptor = action) {
  let tempDir = '';
  const backend = {
    id: 'fake',
    displayName: 'Fake',
    transcriptExportFormat: 'json',
    async exportTranscript(_id: string, options: { tempDir: string }) {
      tempDir = options.tempDir;
      return { path: write(options.tempDir), format: 'json' as const };
    },
  } as unknown as AgentBackend;
  const result = await runTranscriptExport({
    backend,
    action: descriptor,
    session: { tool: 'fake', id: 's1', cwd: join(root, 'project'), title: 'Session' },
    artifactStore: store,
    workRoot,
  });
  return { result, tempDir };
}

describe('an adapter that does not stay inside the broker\'s temp root', () => {
  test('a path outside it is refused and never read', async () => {
    const secret = join(mkdtempSync(join(root, 'outside-')), 'secret.json');
    writeFileSync(secret, '{"password":"hunter2"}');
    const { result, tempDir } = await exportWith(() => secret);
    expect([result.status, result.code]).toEqual([422, 'PATH_ESCAPE']);
    expect(result.artifact).toBeUndefined();
    expect(readFileSync(secret, 'utf8')).toBe('{"password":"hunter2"}');
    expect(existsSync(tempDir)).toBe(false);
  });

  test.skipIf(process.platform === 'win32')('a symlink to a file outside it is refused', async () => {
    const target = join(mkdtempSync(join(root, 'link-target-')), 'id_rsa');
    writeFileSync(target, 'private');
    const { result, tempDir } = await exportWith((dir) => {
      symlinkSync(target, join(dir, 'export.json'));
      return join(dir, 'export.json');
    });
    expect([result.status, result.code]).toEqual([422, 'PATH_SYMLINK']);
    expect(existsSync(tempDir)).toBe(false);
  });

  test('a file of another type, or over the size cap, is refused', async () => {
    const wrongType = await exportWith((dir) => {
      writeFileSync(join(dir, 'export.html'), '<p>x</p>');
      return join(dir, 'export.html');
    });
    expect([wrongType.result.status, wrongType.result.code]).toEqual([422, 'PATH_EXT']);
    const oversize = await exportWith((dir) => {
      writeFileSync(join(dir, 'export.json'), 'x'.repeat(4096));
      return join(dir, 'export.json');
    }, { ...action, sizeCapBytes: 1024 });
    expect([oversize.result.status, oversize.result.code]).toEqual([413, 'EXPORT_TOO_LARGE']);
    expect([existsSync(wrongType.tempDir), existsSync(oversize.tempDir)]).toEqual([false, false]);
  });

  test('an adapter that stopped at the cap is told apart from one that failed, by type and not by text', async () => {
    const capped = await exportWith(() => {
      throw new TranscriptExportTooLargeError('stopped at the cap', 1024);
    });
    expect([capped.result.status, capped.result.code]).toEqual([413, 'EXPORT_TOO_LARGE']);
    // The same refusal from a copy of the class in another bundle carries only its name and shape.
    const otherRealm = await exportWith(() => {
      throw Object.assign(new Error('stopped at the cap'), { name: 'TranscriptExportTooLargeError', maxBytes: 1024 });
    });
    expect([otherRealm.result.status, otherRealm.result.code]).toEqual([413, 'EXPORT_TOO_LARGE']);
    const failed = await exportWith(() => {
      throw new Error('export exceeded the size cap: database is locked');
    });
    expect([failed.result.status, failed.result.code]).toEqual([502, 'EXPORT_FAILED']);
    expect([capped.tempDir, otherRealm.tempDir, failed.tempDir].map((dir) => existsSync(dir))).toEqual([false, false, false]);
  });

  test('an adapter that throws leaves no temp root behind', async () => {
    const { result, tempDir } = await exportWith(() => {
      throw new Error('native export crashed\nwith a second line');
    });
    expect([result.status, result.code]).toEqual([502, 'EXPORT_FAILED']);
    expect(result.error).not.toContain('second line');
    expect(existsSync(tempDir)).toBe(false);
  });
});

describe('the R2 policy table', () => {
  test('transcript export is never available at T3, even when enabled locally', () => {
    expect(r2ActionAvailable(action, 'T3', new Set(['transcriptExport'])).allowed).toBe(false);
  });

  test('the startup guard refuses a session-mutating action bound to the weak timestamp revision', () => {
    expect(() => assertR2ActionsSafe()).not.toThrow();
    expect(() => assertR2ActionsSafe([{ ...action, id: 'fakeDestructive', mutatesSession: true, revisionBinding: 'session-timestamp' }])).toThrow();
    expect(() => assertR2ActionsSafe([{ ...action, id: 'fakeDestructive', mutatesSession: true, revisionBinding: 'last-message-id' }])).not.toThrow();
  });
});

describe('the export working directory', () => {
  test('lives in the broker\'s state home, and the start sweep empties only it', async () => {
    const { result, tempDir } = await exportWith((dir) => {
      writeFileSync(join(dir, 'export.json'), '{"parts":[]}');
      return join(dir, 'export.json');
    });
    expect(result.status).toBe(200);
    expect(tempDir.startsWith(workRoot)).toBe(true);
    expect(readdirSync(workRoot)).toEqual([]);

    // What a broker that died mid-export leaves: a working directory holding the native transcript.
    const abandoned = join(workRoot, 'export-abandoned');
    mkdirSync(abandoned);
    writeFileSync(join(abandoned, 'export.json'), 'unredacted');
    const outside = mkdtempSync(join(root, 'outside-work-root-'));
    writeFileSync(join(outside, 'keep.json'), 'not the broker\'s');
    if (process.platform !== 'win32') symlinkSync(outside, join(workRoot, 'linked'));
    expect(sweepTranscriptExportWorkRoot(workRoot)).toBe(process.platform === 'win32' ? 1 : 2);
    expect(readdirSync(workRoot)).toEqual([]);
    expect(readFileSync(join(outside, 'keep.json'), 'utf8')).toBe('not the broker\'s');
    expect(sweepTranscriptExportWorkRoot(join(root, 'never-created'))).toBe(0);
  });

  test.skipIf(process.platform === 'win32')('a working root that is a symlink is refused, and nothing behind it is touched', () => {
    const target = mkdtempSync(join(root, 'link-target-'));
    writeFileSync(join(target, 'keep.json'), 'kept');
    const state = mkdtempSync(join(root, 'linked-state-'));
    symlinkSync(target, transcriptExportWorkRoot(state));
    expect(() => sweepTranscriptExportWorkRoot(transcriptExportWorkRoot(state))).toThrow();
    expect(readdirSync(target)).toEqual(['keep.json']);
  });
});
