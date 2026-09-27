import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore, type ArtifactStorePersistenceResult } from '../../src/artifacts/artifact-store.ts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const root = mkdtempSync(join(tmpdir(), 'cosyncing-artifact-health-'));
try {
  const results: ArtifactStorePersistenceResult[] = [];
  const indexPath = join(root, 'artifacts', 'index.json');
  const store = new ArtifactStore('http://broker.invalid', root, {
    onPersistenceResult: (result) => results.push(result),
  });
  mkdirSync(indexPath, { recursive: true }); // Force atomic rename to fail: destination is a directory.
  const message = {
    type: 'file-artifact' as const,
    path: 'report.txt',
    name: 'report.txt',
    mimeType: 'text/plain',
    url: 'data:text/plain;base64,aGVsbG8=',
  };

  let failed = false;
  try {
    store.toReference({ tool: 'codex', id: 'session' }, message);
  } catch {
    failed = true;
  }
  assert(failed, 'artifact insertion must surface index persistence failure');
  assert(results.at(-1)?.ok === false, 'artifact persistence callback must report failure');
  assert(results.at(-1)?.operation === 'put', 'persistence callback must name the operation without raw errors');
  assert(!('error' in (results.at(-1) ?? {})), 'persistence callback must not expose raw exception text');
  const hash = createHash('sha256').update('hello').digest('hex');
  assert(!existsSync(join(root, 'artifacts', 'blobs', hash.slice(0, 2), hash)), 'failed index commit must remove a blob created by the failed put');

  rmSync(indexPath, { recursive: true, force: true });
  assert(store.clearSession('codex', 'session') === 0, 'failed insertion must roll back the in-memory index');

  const ref = store.toReference({ tool: 'codex', id: 'session' }, message);
  assert(ref.type === 'file-artifact' && ref.fetchUrl, 'store must remain usable after destination recovery');
  assert(results.at(-1)?.ok === true, 'successful atomic index persistence must report recovery');
  const parsed = JSON.parse(readFileSync(indexPath, 'utf8')) as { records?: unknown[] };
  assert(parsed.records?.length === 1, 'atomic index must contain the committed record');
  assert(!readdirSync(join(root, 'artifacts')).some((name) => name.endsWith('.tmp')), 'atomic persistence must not leave temporary index files');
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('PASS artifact store atomic persistence, rollback, and health callbacks');

const callbackRoot = mkdtempSync(join(tmpdir(), 'cosyncing-artifact-health-callback-'));
try {
  const store = new ArtifactStore('http://broker.invalid', callbackRoot, {
    onPersistenceResult: () => { throw new Error('health observer failure'); },
  });
  const ref = store.toReference({ tool: 'codex', id: 'callback-session' }, {
    type: 'file-artifact',
    path: 'callback.txt',
    name: 'callback.txt',
    mimeType: 'text/plain',
    url: 'data:text/plain;base64,b2s=',
  });
  assert(ref.type === 'file-artifact' && ref.fetchUrl, 'health callback exceptions must not corrupt committed artifact writes');
  const reloaded = new ArtifactStore('http://broker.invalid', callbackRoot);
  assert(reloaded.clearSession('codex', 'callback-session') === 1, 'callback failure must not diverge disk and memory indexes');
} finally {
  rmSync(callbackRoot, { recursive: true, force: true });
}

console.log('PASS artifact store isolates health callback failures');

const corruptRoot = mkdtempSync(join(tmpdir(), 'cosyncing-artifact-health-corrupt-'));
try {
  const artifactDir = join(corruptRoot, 'artifacts');
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, 'index.json'), '{not-json');
  const results: ArtifactStorePersistenceResult[] = [];
  const store = new ArtifactStore('http://broker.invalid', corruptRoot, {
    onPersistenceResult: (result) => results.push(result),
  });
  assert(results.some((result) => !result.ok && result.operation === 'load'), 'corrupt index must emit a sanitized load-failure health signal');
  assert(readdirSync(artifactDir).some((name) => name.startsWith('index.json.corrupt-')), 'corrupt index must be retained under a backup name');
  const ref = store.toReference({ tool: 'codex', id: 'corrupt-session' }, {
    type: 'file-artifact',
    path: 'recovered.txt',
    name: 'recovered.txt',
    mimeType: 'text/plain',
    url: 'data:text/plain;base64,b2s=',
  });
  assert(ref.type === 'file-artifact' && ref.fetchUrl, 'store must accept new commits after isolating a corrupt index');
} finally {
  rmSync(corruptRoot, { recursive: true, force: true });
}

console.log('PASS artifact store backs up and reports corrupt indexes');

// A size preview stores nothing, and builds exactly the shape a delivery would. A history frame's
// decoded-size bound measures rows it may then trim away, so measuring must never write a blob or
// commit the index (whose failure would otherwise abort the attach), and its size must be the size
// the client then receives.
const previewRoot = mkdtempSync(join(tmpdir(), 'cosyncing-artifact-preview-'));
try {
  const results: ArtifactStorePersistenceResult[] = [];
  const store = new ArtifactStore('http://broker.invalid', previewRoot, {
    onPersistenceResult: (result) => results.push(result),
  });
  const blobs = (): string[] => {
    const dir = join(previewRoot, 'artifacts', 'blobs');
    // Blobs live at `<2-char prefix>/<hash>`; the prefix directories are not blobs.
    return existsSync(dir)
      ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile()).map((entry) => entry.name)
      : [];
  };
  const indexPath = join(previewRoot, 'artifacts', 'index.json');
  const indexBefore = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : undefined;
  const body = Array.from({ length: 5_000 }, (_, index) => `+line ${index}`).join('\n');
  const artifact = {
    type: 'file-artifact' as const,
    path: 'preview.txt',
    name: 'preview.txt',
    mimeType: 'text/plain',
    url: `data:text/plain;base64,${Buffer.from('preview bytes').toString('base64')}`,
  };
  const session = { tool: 'claude', id: 'preview-session' };

  const previewedDiff = store.previewDiff('claude', 'preview-session', 'preview-session:call', body);
  const previewedArtifact = store.previewReference(session, artifact);
  assert(blobs().length === 0, `a preview must store no blob: ${blobs().join(',')}`);
  assert(results.length === 0, 'a preview must not commit the index');
  assert(
    (existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : undefined) === indexBefore,
    'a preview must leave the index file untouched',
  );

  const stashed = store.stashDiff('claude', 'preview-session', 'preview-session:call', body);
  const delivered = store.toReference(session, artifact);
  assert(blobs().length === 2, 'delivery stores what the references point at');
  assert(
    previewedDiff.contentHash === stashed.contentHash
      && previewedDiff.byteSize === stashed.byteSize
      && previewedDiff.fetchUrl.length === stashed.fetchUrl.length
      && new URL(previewedDiff.fetchUrl, 'http://x').pathname === new URL(stashed.fetchUrl, 'http://x').pathname,
    'a previewed diff reference has the delivered reference shape',
  );
  const shape = (message: unknown): string => JSON.stringify(message, (key, value) =>
    key === 'fetchUrl' && typeof value === 'string' ? new URL(value, 'http://x').pathname : value);
  assert(shape(previewedArtifact) === shape(delivered), 'a previewed artifact has the delivered shape');
} finally {
  rmSync(previewRoot, { recursive: true, force: true });
}

console.log('PASS artifact store previews references without storing them');
