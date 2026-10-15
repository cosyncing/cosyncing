/**
 * Transcript export against a misbehaving adapter, and the R2 policy table.
 *
 * `e2e/broker/transcript-export.test.ts` runs exports through a real broker
 * and a fake `opencode` CLI, which can only behave as OpenCode's adapter
 * lets it: the adapter writes the file itself, inside the broker's temp root.
 * What a buggy or hostile adapter could hand back instead — a path outside
 * that root, a symlink, a file over the cap — needs a fake backend in process.
 * So does the trust tier no HTTP request carries (T3), and the registry guard
 * that refuses to boot an unsafe action table.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentBackend } from '@cosyncing/adapter-api';
import { ArtifactStore } from '../artifacts/artifact-store.ts';
import { runTranscriptExport } from './r2-export.ts';
import { assertR2ActionsSafe, getR2Action, r2ActionAvailable, type R2ActionDescriptor } from './r2-policy.ts';

const root = mkdtempSync(join(tmpdir(), 'cosyncing-r2-export-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

// The size cap under test is the descriptor's own; an operator override would replace it.
delete process.env.COSYNCING_R2_MAX_BYTES;
const action = getR2Action('transcriptExport')!;
const store = new ArtifactStore('http://127.0.0.1:7734', join(root, 'cache'));

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
