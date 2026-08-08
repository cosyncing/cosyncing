import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { artifactCacheRoot } from './artifact-store.ts';
import { setupStateHome } from './setup-state.ts';
import { acquireInstallationLock } from './installation-lock.ts';
import {
  assertNoSymlinkComponents,
  atomicWriteJsonOwnerOnly,
  atomicWriteOwnerOnly,
  ensureOwnerOnlyDirectory,
  inspectOwnerOnlyFile,
} from './secure-files.ts';

export interface DurableStateLayout {
  stateRoot: string;
  cacheRoot: string;
  config: string;
  setup: string;
  install: string;
  schedules: string;
  attention: string;
  peers: string;
  transportKeys: string;
  brokerToken: string;
  piIntegration: string;
  artifactIndex: string;
  artifactBlobs: string;
  artifactUrlSecret: string;
  backups: string;
}

export interface DurableSchemaSpec {
  id: 'config' | 'setup' | 'install' | 'schedules' | 'attention' | 'peers' | 'artifacts';
  root: 'state' | 'cache';
  relativePath: string;
  versionField: 'schemaVersion' | 'version';
  currentVersion: 1;
  sensitive: boolean;
}

export const DURABLE_SCHEMA_REGISTRY: readonly DurableSchemaSpec[] = Object.freeze([
  { id: 'config', root: 'state', relativePath: 'config.json', versionField: 'schemaVersion', currentVersion: 1, sensitive: false },
  { id: 'setup', root: 'state', relativePath: 'setup-state.json', versionField: 'schemaVersion', currentVersion: 1, sensitive: false },
  { id: 'install', root: 'state', relativePath: 'install-state.json', versionField: 'schemaVersion', currentVersion: 1, sensitive: false },
  { id: 'schedules', root: 'state', relativePath: 'schedules.json', versionField: 'version', currentVersion: 1, sensitive: true },
  { id: 'attention', root: 'state', relativePath: 'attention-events.json', versionField: 'version', currentVersion: 1, sensitive: true },
  { id: 'peers', root: 'state', relativePath: 'transport-peers.json', versionField: 'version', currentVersion: 1, sensitive: true },
  { id: 'artifacts', root: 'cache', relativePath: 'artifacts/index.json', versionField: 'version', currentVersion: 1, sensitive: true },
]);

export interface DurableStoreInspection {
  id: DurableSchemaSpec['id'];
  status: 'missing' | 'ok' | 'unsafe' | 'malformed' | 'migration-required' | 'unsupported-version';
  version?: number;
  detailCode: string;
}

export interface DurableCorruptionEvidence {
  id: DurableSchemaSpec['id'];
  detailCode: string;
}

export interface DurableBackupManifest {
  schemaVersion: 1;
  purpose: string;
  createdAt: string;
  stateRootIncluded: true;
  cacheRootIncluded: true;
  entries: Array<{ source: string; backup: string; kind: 'file' | 'directory'; bytes?: number; sha256?: string }>;
}

export interface DurableMigrationPlan {
  schemaVersion: 1;
  requiresConfirmation: true;
  steps: Array<{
    id: 'setup-state-v0-to-v1';
    store: 'setup';
    fromVersion: 0;
    toVersion: 1;
  }>;
  blockers: Array<{ store: DurableSchemaSpec['id']; detailCode: string }>;
}

export function durableStateLayout(options: { stateRoot?: string; cacheRoot?: string } = {}): DurableStateLayout {
  const stateRoot = options.stateRoot ?? setupStateHome();
  const cacheRoot = options.cacheRoot ?? artifactCacheRoot();
  return {
    stateRoot,
    cacheRoot,
    config: join(stateRoot, 'config.json'),
    setup: join(stateRoot, 'setup-state.json'),
    install: join(stateRoot, 'install-state.json'),
    schedules: join(stateRoot, 'schedules.json'),
    attention: join(stateRoot, 'attention-events.json'),
    peers: join(stateRoot, 'transport-peers.json'),
    transportKeys: join(stateRoot, 'transport-keys'),
    brokerToken: join(stateRoot, 'secrets', 'broker-token'),
    piIntegration: join(stateRoot, 'secrets', 'pi-integration.json'),
    artifactIndex: join(cacheRoot, 'artifacts', 'index.json'),
    artifactBlobs: join(cacheRoot, 'artifacts', 'blobs'),
    artifactUrlSecret: join(cacheRoot, 'artifact-url-secret'),
    backups: join(stateRoot, 'backups'),
  };
}

export function inspectDurableSchemas(layout = durableStateLayout()): DurableStoreInspection[] {
  return DURABLE_SCHEMA_REGISTRY.map((spec) => {
    const root = spec.root === 'state' ? layout.stateRoot : layout.cacheRoot;
    const path = join(root, spec.relativePath);
    const file = inspectOwnerOnlyFile(path);
    if (file.status === 'missing') return { id: spec.id, status: 'missing', detailCode: `${spec.id}-missing` };
    if (file.status !== 'ok') return { id: spec.id, status: 'unsafe', detailCode: `${spec.id}-unsafe` };
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      return { id: spec.id, status: 'malformed', detailCode: `${spec.id}-malformed` };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { id: spec.id, status: 'malformed', detailCode: `${spec.id}-malformed` };
    }
    const version = (parsed as Record<string, unknown>)[spec.versionField];
    if (version == null) {
      return { id: spec.id, status: 'migration-required', detailCode: `${spec.id}-unversioned` };
    }
    if (!Number.isSafeInteger(version)) {
      return { id: spec.id, status: 'malformed', detailCode: `${spec.id}-version-malformed` };
    }
    if (version !== spec.currentVersion) {
      return {
        id: spec.id,
        status: 'unsupported-version',
        version: version as number,
        detailCode: `${spec.id}-unsupported-version`,
      };
    }
    return { id: spec.id, status: 'ok', version: version as number, detailCode: `${spec.id}-ok` };
  });
}

/**
 * Find store-owned corruption backups even after a recovering store moved the bad primary aside.
 * Health reports only stable store ids/codes; it never returns local paths or filenames.
 */
export function inspectDurableCorruptionEvidence(
  layout = durableStateLayout(),
): DurableCorruptionEvidence[] {
  const evidence: DurableCorruptionEvidence[] = [];
  for (const spec of DURABLE_SCHEMA_REGISTRY) {
    const root = spec.root === 'state' ? layout.stateRoot : layout.cacheRoot;
    const target = join(root, spec.relativePath);
    const directory = dirname(target);
    const leaf = basename(target);
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch {
      continue;
    }
    const found = names.some((name) => {
      const ownedPattern = name.startsWith(`${leaf}.corrupt-`)
        || (name.startsWith(`${leaf}.`) && name.endsWith('.corrupt'));
      if (!ownedPattern) return false;
      try {
        const stat = lstatSync(join(directory, name));
        return stat.isFile() && !stat.isSymbolicLink();
      } catch {
        return false;
      }
    });
    if (found) evidence.push({ id: spec.id, detailCode: `${spec.id}-corruption-recovered` });
  }
  return evidence;
}

/** Read-only migration planner. Unknown/unsupported stores are blockers, never silently reset. */
export function planDurableStateMigrations(layout = durableStateLayout()): DurableMigrationPlan {
  const steps: DurableMigrationPlan['steps'] = [];
  const blockers: DurableMigrationPlan['blockers'] = [];
  for (const inspection of inspectDurableSchemas(layout)) {
    if (inspection.status === 'migration-required' && inspection.id === 'setup') {
      steps.push({ id: 'setup-state-v0-to-v1', store: 'setup', fromVersion: 0, toVersion: 1 });
    } else if (inspection.status !== 'ok' && inspection.status !== 'missing') {
      blockers.push({ store: inspection.id, detailCode: inspection.detailCode });
    }
  }
  return { schemaVersion: 1, requiresConfirmation: true, steps, blockers };
}

/**
 * Apply only migrations named by the displayed plan. A cross-command lock and full two-root backup are
 * mandatory even for an additive schema stamp, keeping the same safety floor for future destructive steps.
 */
export function applyDurableStateMigrations(options: {
  plan: DurableMigrationPlan;
  confirmed: boolean;
  stateRoot?: string;
  cacheRoot?: string;
  now?: () => Date;
}): { applied: string[]; backupPath?: string } {
  if (!options.confirmed) throw new Error('durable-state migration requires confirmation');
  if (options.plan.blockers.length > 0) throw new Error('durable-state migration has unresolved blockers');
  if (options.plan.steps.length === 0) return { applied: [] };
  const layout = durableStateLayout({ stateRoot: options.stateRoot, cacheRoot: options.cacheRoot });
  const lock = acquireInstallationLock({ command: 'repair', home: layout.stateRoot, now: options.now });
  try {
    return applyDurableStateMigrationsWithLockHeld({ ...options, confirmed: true });
  } finally {
    lock.release();
  }
}

/**
 * Apply a previously displayed migration plan while the caller already holds the cross-command installation
 * lock. Exported for `cosyncing repair`; ordinary callers should use `applyDurableStateMigrations()`.
 */
export function applyDurableStateMigrationsWithLockHeld(options: {
  plan: DurableMigrationPlan;
  confirmed: true;
  stateRoot?: string;
  cacheRoot?: string;
  now?: () => Date;
}): { applied: string[]; backupPath?: string } {
  if (options.plan.blockers.length > 0) throw new Error('durable-state migration has unresolved blockers');
  if (options.plan.steps.length === 0) return { applied: [] };
  const layout = durableStateLayout({ stateRoot: options.stateRoot, cacheRoot: options.cacheRoot });
  const backup = backupDurableStores({
    purpose: 'schema-migration',
    stateRoot: layout.stateRoot,
    cacheRoot: layout.cacheRoot,
    now: options.now,
  });
  const applied: string[] = [];
  for (const step of options.plan.steps) {
    if (step.id !== 'setup-state-v0-to-v1') throw new Error('unsupported durable-state migration step');
    const raw = JSON.parse(readFileSync(layout.setup, 'utf8')) as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('setup state is malformed');
    atomicWriteJsonOwnerOnly(layout.setup, { ...(raw as Record<string, unknown>), schemaVersion: 1 });
    applied.push(step.id);
  }
  return { applied, backupPath: backup.path };
}

function safePurpose(value: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized.slice(0, 80) || 'migration';
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function copyOwnedTree(
  source: string,
  destination: string,
  sourceLabel: string,
  backupRoot: string,
  entries: DurableBackupManifest['entries'],
): void {
  assertNoSymlinkComponents(source);
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) throw new Error('backup source contains a symlink');
  const backupLabel = relative(backupRoot, destination);
  if (stat.isDirectory()) {
    ensureOwnerOnlyDirectory(destination);
    entries.push({ source: sourceLabel, backup: backupLabel, kind: 'directory' });
    for (const child of readdirSync(source, { withFileTypes: true })) {
      copyOwnedTree(
        join(source, child.name),
        join(destination, child.name),
        `${sourceLabel}/${child.name}`,
        backupRoot,
        entries,
      );
    }
    return;
  }
  if (!stat.isFile()) throw new Error('backup source is not a regular file');
  const bytes = readFileSync(source);
  atomicWriteOwnerOnly(destination, bytes);
  entries.push({
    source: sourceLabel,
    backup: backupLabel,
    kind: 'file',
    bytes: bytes.byteLength,
    sha256: sha256(bytes),
  });
}

/**
 * Copy every migration-sensitive store from both durable roots into one owner-only snapshot. This function is
 * intentionally mutation-only; callers must present/confirm a plan and hold the installation lock first.
 */
export function backupDurableStores(options: {
  purpose: string;
  stateRoot?: string;
  cacheRoot?: string;
  now?: () => Date;
}): { path: string; manifest: DurableBackupManifest } {
  const layout = durableStateLayout({ stateRoot: options.stateRoot, cacheRoot: options.cacheRoot });
  ensureOwnerOnlyDirectory(layout.stateRoot);
  ensureOwnerOnlyDirectory(layout.backups);
  const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const path = join(layout.backups, `${stamp}-${safePurpose(options.purpose)}-${randomBytes(6).toString('hex')}`);
  ensureOwnerOnlyDirectory(path);
  const entries: DurableBackupManifest['entries'] = [];
  const sources = [
    { path: layout.config, label: 'state/config.json', destination: join(path, 'state', 'config.json') },
    { path: layout.setup, label: 'state/setup-state.json', destination: join(path, 'state', 'setup-state.json') },
    { path: layout.install, label: 'state/install-state.json', destination: join(path, 'state', 'install-state.json') },
    { path: layout.schedules, label: 'state/schedules.json', destination: join(path, 'state', 'schedules.json') },
    { path: layout.attention, label: 'state/attention-events.json', destination: join(path, 'state', 'attention-events.json') },
    { path: layout.peers, label: 'state/transport-peers.json', destination: join(path, 'state', 'transport-peers.json') },
    { path: layout.transportKeys, label: 'state/transport-keys', destination: join(path, 'state', 'transport-keys') },
    { path: layout.brokerToken, label: 'state/secrets/broker-token', destination: join(path, 'state', 'secrets', 'broker-token') },
    { path: layout.piIntegration, label: 'state/secrets/pi-integration.json', destination: join(path, 'state', 'secrets', 'pi-integration.json') },
    { path: join(layout.cacheRoot, 'artifacts'), label: 'cache/artifacts', destination: join(path, 'cache', 'artifacts') },
    { path: layout.artifactUrlSecret, label: 'cache/artifact-url-secret', destination: join(path, 'cache', 'artifact-url-secret') },
  ];
  for (const source of sources) {
    if (!existsSync(source.path)) continue;
    copyOwnedTree(source.path, source.destination, source.label, path, entries);
  }
  const manifest: DurableBackupManifest = {
    schemaVersion: 1,
    purpose: safePurpose(options.purpose),
    createdAt: (options.now?.() ?? new Date()).toISOString(),
    stateRootIncluded: true,
    cacheRootIncluded: true,
    entries,
  };
  atomicWriteJsonOwnerOnly(join(path, 'manifest.json'), manifest);
  return { path, manifest };
}

/** Normal uninstall preserves these roots; `--purge-data` must enumerate both before confirmed removal. */
export function purgeDataInventory(layout = durableStateLayout()): Array<{
  id: 'state-root' | 'artifact-cache-root';
  path: string;
}> {
  return [
    { id: 'state-root', path: layout.stateRoot },
    { id: 'artifact-cache-root', path: layout.cacheRoot },
  ];
}
