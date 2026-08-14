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
