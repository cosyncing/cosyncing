import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { artifactCacheRoot } from '../artifacts/artifact-store.ts';
import { setupStateHome } from '../installation/setup-state.ts';
import { acquireInstallationLock } from '../installation/installation-lock.ts';
import { normalizeCommittedInstallState } from '../installation/install-state.ts';
import { migrateBrokerConfigV1, validateBrokerConfig } from '../runtime/configuration.ts';
import { inspectBrokerInstance, parseBrokerInstanceText } from '../runtime/broker-instance.ts';
import {
  assertNoSymlinkComponents,
  atomicWriteJsonOwnerOnly,
  atomicWriteOwnerOnly,
  ensureOwnerOnlyDirectory,
  inspectOwnerOnlyFile,
  enforceOwnerOnlyFile,
  type SecureFileInspection,
} from './secure-files.ts';

export interface DurableStateLayout {
  stateRoot: string;
  cacheRoot: string;
  config: string;
  brokerInstance: string;
  setup: string;
  install: string;
  schedules: string;
  attention: string;
  peers: string;
  wakeRegistrations: string;
  transportKeys: string;
  brokerToken: string;
  piIntegration: string;
  ompIntegration: string;
  artifactIndex: string;
  artifactBlobs: string;
  artifactUrlSecret: string;
  backups: string;
}

export interface DurableSchemaSpec {
  id: 'config' | 'broker-instance' | 'setup' | 'install' | 'schedules' | 'attention' | 'peers' | 'wake-registrations' | 'artifacts';
  root: 'state' | 'cache';
  relativePath: string;
  versionField: 'schemaVersion' | 'version';
  currentVersion: 1 | 2;
  sensitive: boolean;
}

export const DURABLE_SCHEMA_REGISTRY: readonly DurableSchemaSpec[] = Object.freeze([
  { id: 'config', root: 'state', relativePath: 'config.json', versionField: 'schemaVersion', currentVersion: 2, sensitive: false },
  { id: 'broker-instance', root: 'state', relativePath: 'broker-instance.json', versionField: 'version', currentVersion: 2, sensitive: true },
  { id: 'setup', root: 'state', relativePath: 'setup-state.json', versionField: 'schemaVersion', currentVersion: 1, sensitive: false },
  { id: 'install', root: 'state', relativePath: 'install-state.json', versionField: 'schemaVersion', currentVersion: 1, sensitive: false },
  { id: 'schedules', root: 'state', relativePath: 'schedules.json', versionField: 'version', currentVersion: 2, sensitive: true },
  { id: 'attention', root: 'state', relativePath: 'attention-events.json', versionField: 'version', currentVersion: 1, sensitive: true },
  { id: 'peers', root: 'state', relativePath: 'transport-peers.json', versionField: 'version', currentVersion: 2, sensitive: true },
  { id: 'wake-registrations', root: 'state', relativePath: 'push-wake-tokens.json', versionField: 'version', currentVersion: 2, sensitive: true },
  { id: 'artifacts', root: 'cache', relativePath: 'artifacts/index.json', versionField: 'version', currentVersion: 1, sensitive: true },
]);

export interface DurableStoreInspection {
  id: DurableSchemaSpec['id'];
  status: 'missing' | 'ok' | 'unsafe' | 'malformed' | 'migration-required' | 'unsupported-version';
  version?: number;
  detailCode: string;
  permissionProblem?: NonNullable<SecureFileInspection['problem']> | NonNullable<SecureFileInspection['daclProblem']> | 'unreadable' | 'hard-link';
  permissionRepairable?: boolean;
  contentProblem?: string;
}

export interface DurableStatePermissionRepair {
  id: DurableSchemaSpec['id'];
  path: string;
}

export interface DurableStateSetupAssessment {
  permissionRepairs: DurableStatePermissionRepair[];
  blockers: DurableStoreInspection[];
}

/** Config v1 is readable by both sides of the revision-15/revision-16 rollback window. */
export function isRuntimeCompatibleConfigV1(
  inspection: Readonly<DurableStoreInspection>,
): boolean {
  return inspection.id === 'config'
    && inspection.status === 'migration-required'
    && inspection.version === 1;
}

/** These broker-owned v1 stores are accepted only as input to the fail-closed revision-17
 * startup migration. They are never treated as current revision-17 authorization state. */
export function isRuntimeSecurityMigrationV1(
  inspection: Readonly<DurableStoreInspection>,
): boolean {
  return (inspection.id === 'broker-instance'
      || inspection.id === 'peers'
      || inspection.id === 'schedules'
      || inspection.id === 'wake-registrations')
    && inspection.status === 'migration-required'
    && inspection.version === 1;
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
    id: 'setup-state-v0-to-v1' | 'broker-config-v1-to-v2';
    store: 'setup' | 'config';
    fromVersion: 0 | 1;
    toVersion: 1 | 2;
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
    brokerInstance: join(stateRoot, 'broker-instance.json'),
    setup: join(stateRoot, 'setup-state.json'),
    install: join(stateRoot, 'install-state.json'),
    schedules: join(stateRoot, 'schedules.json'),
    attention: join(stateRoot, 'attention-events.json'),
    peers: join(stateRoot, 'transport-peers.json'),
    wakeRegistrations: join(stateRoot, 'push-wake-tokens.json'),
    transportKeys: join(stateRoot, 'transport-keys'),
    brokerToken: join(stateRoot, 'secrets', 'broker-token'),
    piIntegration: join(stateRoot, 'secrets', 'pi-integration.json'),
    ompIntegration: join(stateRoot, 'secrets', 'omp-integration.json'),
    artifactIndex: join(cacheRoot, 'artifacts', 'index.json'),
    artifactBlobs: join(cacheRoot, 'artifacts', 'blobs'),
    artifactUrlSecret: join(cacheRoot, 'artifact-url-secret'),
    backups: join(stateRoot, 'backups'),
  };
}

export function inspectDurableSchemas(layout = durableStateLayout()): DurableStoreInspection[] {
  return DURABLE_SCHEMA_REGISTRY.map((spec) => {
    if (spec.id === 'broker-instance') {
      const inspection = inspectBrokerInstance(layout.stateRoot);
      if (inspection.status === 'missing') {
        return { id: spec.id, status: 'missing', detailCode: inspection.detailCode };
      }
      if (inspection.status === 'ok') {
        return { id: spec.id, status: 'ok', version: inspection.state.version, detailCode: inspection.detailCode };
      }
      if (inspection.status === 'migration-required') {
        return { id: spec.id, status: 'migration-required', version: 1, detailCode: inspection.detailCode };
      }
      if (inspection.status === 'malformed') {
        const content = inspectDurableSchemaContent(spec, join(layout.stateRoot, spec.relativePath));
        if (content.status === 'unsupported-version') return content;
      }
      return {
        id: spec.id,
        status: inspection.status === 'unsafe' ? 'unsafe' : 'malformed',
        detailCode: inspection.detailCode,
        ...(inspection.status === 'unsafe' ? durablePermissionDetails(spec, join(layout.stateRoot, spec.relativePath)) : {}),
      };
    }
    const root = spec.root === 'state' ? layout.stateRoot : layout.cacheRoot;
    const path = join(root, spec.relativePath);
    const file = inspectOwnerOnlyFile(path);
    if (file.status === 'missing') return { id: spec.id, status: 'missing', detailCode: `${spec.id}-missing` };
    if (file.status !== 'ok') return { id: spec.id, status: 'unsafe', detailCode: `${spec.id}-unsafe`, ...durablePermissionDetails(spec, path, file) };
    return inspectDurableSchemaContent(spec, path);
  });
}

export function durableSchemaPath(spec: DurableSchemaSpec, layout: DurableStateLayout): string {
  return join(spec.root === 'state' ? layout.stateRoot : layout.cacheRoot, spec.relativePath);
}

function inspectDurableSchemaContent(spec: DurableSchemaSpec, path: string): DurableStoreInspection {
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
    if (spec.id === 'config' && version === 1 && spec.currentVersion === 2) {
      return {
        id: spec.id,
        status: 'migration-required',
        version,
        detailCode: 'config-v1-migration-required',
      };
    }
    if ((spec.id === 'broker-instance' || spec.id === 'peers' || spec.id === 'schedules' || spec.id === 'wake-registrations')
      && version === 1 && spec.currentVersion === 2) {
      return {
        id: spec.id,
        status: 'migration-required',
        version,
        detailCode: `${spec.id}-v1-security-migration-required`,
      };
    }
    return {
      id: spec.id,
      status: 'unsupported-version',
      version: version as number,
      detailCode: `${spec.id}-unsupported-version`,
    };
  }
  return { id: spec.id, status: 'ok', version: version as number, detailCode: `${spec.id}-ok` };
}

/**
 * A setup-safe permission migration is intentionally narrow: an owner-held regular file, no symlinked
 * parent, current schema, and its owner-only permissions as the only defect. Content and ownership problems
 * remain blockers.
 */
export function inspectDurableStatePermissionRepair(
  repair: Readonly<DurableStatePermissionRepair>,
  options: { currentVersionOnly?: boolean } = {},
): 'current' | 'tightenable' | 'blocked' {
  const spec = DURABLE_SCHEMA_REGISTRY.find((candidate) => candidate.id === repair.id);
  if (!spec || (!spec.sensitive && !options.currentVersionOnly)) return 'blocked';
  const file = inspectOwnerOnlyFile(repair.path);
  if (file.status !== 'missing' && file.status !== 'unreadable' && file.problem !== 'symlink'
      && lstatSync(repair.path).nlink !== 1) return 'blocked';
  if (file.status === 'ok') {
    if (spec.id === 'broker-instance') {
      return inspectBrokerInstance(dirname(repair.path)).status === 'ok' ? 'current' : 'blocked';
    }
    const inspection = inspectDurableSchemaContent(spec, repair.path);
    return inspection.status === 'ok' || (!options.currentVersionOnly && isRuntimeSecurityMigrationV1(inspection)) ? 'current' : 'blocked';
  }
  if (file.status !== 'unsafe' || (file.problem !== 'unsafe-mode' && file.problem !== 'unsafe-dacl')) {
    return 'blocked';
  }
  // Fail closed on ACL faults outside the explicitly repairable permission-drift set.
  if (file.problem === 'unsafe-dacl' && ![
    'inherited-access', 'unexpected-principal', 'missing-principal', 'insufficient-access', 'unsafe-inheritance',
  ].includes(file.daclProblem ?? '')) return 'blocked';
  const inspection = inspectDurableSchemaContent(spec, repair.path);
  if (options.currentVersionOnly && inspection.status !== 'ok') return 'blocked';
  if (!options.currentVersionOnly && spec.id === 'broker-instance') return 'blocked';
  try {
    const text = readFileSync(repair.path, 'utf8');
    const parsed = JSON.parse(text);
    if (spec.id === 'broker-instance') parseBrokerInstanceText(text);
    if (spec.id === 'config') validateBrokerConfig(parsed);
    if (spec.id === 'install' && !normalizeCommittedInstallState(parsed)) return 'blocked';
    const arrayField = ({ peers: 'peers', schedules: 'schedules', attention: 'events',
      'wake-registrations': 'registrations', artifacts: 'records' } as Partial<Record<DurableSchemaSpec['id'], string>>)[spec.id];
    if (arrayField && !Array.isArray(parsed[arrayField])) return 'blocked';
  } catch { return 'blocked'; }
  return inspection.status === 'ok' || (!options.currentVersionOnly && isRuntimeSecurityMigrationV1(inspection))
    ? 'tightenable' : 'blocked';
}

function durablePermissionDetails(
  spec: DurableSchemaSpec, path: string, file = inspectOwnerOnlyFile(path),
): Pick<DurableStoreInspection, 'permissionProblem' | 'permissionRepairable' | 'contentProblem'> {
  const permissionRepairable = inspectDurableStatePermissionRepair({ id: spec.id, path }, { currentVersionOnly: true }) === 'tightenable';
  let contentProblem: string | undefined;
  // Ownership and link proof always come before reading bytes through an unsafe descriptor.
  if (file.status === 'unsafe' && (file.problem === 'unsafe-mode' || file.problem === 'unsafe-dacl')) {
    const content = inspectDurableSchemaContent(spec, path);
    if (content.status === 'unsupported-version') contentProblem = `unsupported schema version ${content.version}`;
    else if (content.status === 'migration-required') contentProblem = `schema migration required (${content.detailCode})`;
    else if (content.status !== 'ok') contentProblem = 'malformed JSON or schema content';
    else if (!permissionRepairable && lstatSync(path).nlink === 1 && (file.problem === 'unsafe-mode' || [
      'inherited-access', 'unexpected-principal', 'missing-principal', 'insufficient-access', 'unsafe-inheritance',
    ].includes(file.daclProblem ?? ''))) contentProblem = 'invalid current-schema content';
  }
  return {
    permissionProblem: file.status === 'unsafe' && (file.problem === 'unsafe-mode' || file.problem === 'unsafe-dacl')
      && lstatSync(path).nlink !== 1 ? 'hard-link' : file.daclProblem ?? file.problem ?? 'unreadable',
    permissionRepairable,
    ...(contentProblem ? { contentProblem } : {}),
  };
}

/** Local CLI wording shared by doctor, repair, and the update preflight. Never includes store contents. */
export function durableStateProblemSummary(inspection: Readonly<DurableStoreInspection>): string {
  const file = DURABLE_SCHEMA_REGISTRY.find((spec) => spec.id === inspection.id)!.relativePath;
  const reasons: Record<string, string> = {
    'inherited-access': 'has inherited Windows permissions instead of owner-only permissions',
    'unexpected-principal': 'grants access to an unexpected Windows account',
    'missing-principal': 'is missing a required owner-only Windows permission',
    'insufficient-access': 'has insufficient Windows access rights for a required account',
    'unsafe-inheritance': 'has unsafe Windows permission inheritance flags',
    'deny-access': 'has a Windows deny-access rule',
    'duplicate-principal': 'has duplicate Windows permission entries',
    'wrong-owner': 'is owned by another account',
    'hard-link': 'is hard-linked to another file',
    symlink: 'contains a symbolic link or junction substitution',
    'not-file': 'is not a regular file',
    'unsafe-mode': 'has permissions that allow other accounts to access it',
    'unsafe-dacl': 'has an unsafe Windows DACL',
    unreadable: 'could not be inspected or read',
  };
  if (inspection.status === 'unsafe') {
    const reason = reasons[inspection.permissionProblem ?? 'unreadable'] ?? inspection.permissionProblem;
    const next = inspection.permissionRepairable
      ? 'run `cosy repair`, then `cosy update`'
      : inspection.permissionProblem === 'wrong-owner'
        ? 'restore a backup owned by your account, then run `cosy doctor`'
        : (inspection.permissionProblem === 'symlink' || inspection.permissionProblem === 'hard-link')
          ? 'remove the link substitution and restore a regular file from a trusted backup, then run `cosy doctor`'
          : 'check ownership, permissions and current-schema content with `cosy doctor`; restore a trusted compatible backup before retrying';
    return `\`${file}\` ${reason}${inspection.contentProblem ? `; ${inspection.contentProblem}` : ''}; ${next}.`;
  }
  if (inspection.status === 'migration-required') return `\`${file}\` needs a schema migration (${inspection.detailCode}); run \`cosy repair\`, then \`cosy update\`.`;
  if (inspection.status === 'unsupported-version') return `\`${file}\` has unsupported schema version ${inspection.version}; use a broker that supports that version or restore a compatible backup, then run \`cosy doctor\`.`;
  return `\`${file}\` has malformed JSON or schema content (${inspection.detailCode}); restore a trusted compatible backup, then run \`cosy doctor\`.`;
}

/** Recheck owner, link, ACL classification and current-schema content immediately before tightening. */
export function repairDurableStatePermissions(repair: Readonly<DurableStatePermissionRepair>): void {
  const state = inspectDurableStatePermissionRepair(repair, { currentVersionOnly: true });
  if (state === 'blocked') throw new Error(`permission-repair-precondition-changed:${repair.id}`);
  if (state === 'tightenable') {
    const before = lstatSync(repair.path);
    const content = readFileSync(repair.path);
    enforceOwnerOnlyFile(repair.path);
    const after = lstatSync(repair.path);
    if (before.dev !== after.dev || before.ino !== after.ino || after.nlink !== 1
        || !readFileSync(repair.path).equals(content)) throw new Error(`permission-repair-target-changed:${repair.id}`);
  }
  if (inspectOwnerOnlyFile(repair.path).status !== 'ok') throw new Error(`permission-repair-failed:${repair.id}`);
}

/** Classify every durable doctor failure before setup is allowed to plan a commit. */
export function assessDurableStateForSetup(
  layout = durableStateLayout(),
): DurableStateSetupAssessment {
  const permissionRepairs: DurableStatePermissionRepair[] = [];
  const blockers: DurableStoreInspection[] = [];
  for (const inspection of inspectDurableSchemas(layout)) {
    if (inspection.status === 'ok' || inspection.status === 'missing') continue;
    // The current broker reads config v1 in memory. Setup must be able to switch and health-check the
    // candidate while leaving that file untouched; only a later confirmed repair persists v2 with its
    // two-root backup. Treat no other old or unknown schema as safe at this boundary.
    if (isRuntimeCompatibleConfigV1(inspection) || isRuntimeSecurityMigrationV1(inspection)) continue;
    const spec = DURABLE_SCHEMA_REGISTRY.find((candidate) => candidate.id === inspection.id);
    if (!spec) {
      blockers.push(inspection);
      continue;
    }
    const repair = { id: spec.id, path: durableSchemaPath(spec, layout) };
    if (inspectDurableStatePermissionRepair(repair) === 'tightenable') permissionRepairs.push(repair);
    else blockers.push(inspection);
  }
  return { permissionRepairs, blockers };
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
    } else if (isRuntimeCompatibleConfigV1(inspection)) {
      steps.push({ id: 'broker-config-v1-to-v2', store: 'config', fromVersion: 1, toVersion: 2 });
    } else if (isRuntimeSecurityMigrationV1(inspection)) {
      // The broker owns this migration because it must invalidate executable/credential state
      // before it begins serving. The generic repair command must not reinterpret provenance.
      continue;
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
    if (step.id === 'setup-state-v0-to-v1') {
      const raw = JSON.parse(readFileSync(layout.setup, 'utf8')) as unknown;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('setup state is malformed');
      atomicWriteJsonOwnerOnly(layout.setup, { ...(raw as Record<string, unknown>), schemaVersion: 1 });
    } else if (step.id === 'broker-config-v1-to-v2') {
      const migrated = migrateBrokerConfigV1(layout.stateRoot);
      if (!migrated.migrated) throw new Error('broker config migration precondition changed');
    } else {
      throw new Error('unsupported durable-state migration step');
    }
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
    { path: layout.brokerInstance, label: 'state/broker-instance.json', destination: join(path, 'state', 'broker-instance.json') },
    { path: layout.setup, label: 'state/setup-state.json', destination: join(path, 'state', 'setup-state.json') },
    { path: layout.install, label: 'state/install-state.json', destination: join(path, 'state', 'install-state.json') },
    { path: layout.schedules, label: 'state/schedules.json', destination: join(path, 'state', 'schedules.json') },
    { path: layout.attention, label: 'state/attention-events.json', destination: join(path, 'state', 'attention-events.json') },
    { path: layout.peers, label: 'state/transport-peers.json', destination: join(path, 'state', 'transport-peers.json') },
    { path: layout.wakeRegistrations, label: 'state/push-wake-tokens.json', destination: join(path, 'state', 'push-wake-tokens.json') },
    { path: layout.transportKeys, label: 'state/transport-keys', destination: join(path, 'state', 'transport-keys') },
    { path: layout.brokerToken, label: 'state/secrets/broker-token', destination: join(path, 'state', 'secrets', 'broker-token') },
    { path: layout.piIntegration, label: 'state/secrets/pi-integration.json', destination: join(path, 'state', 'secrets', 'pi-integration.json') },
    { path: layout.ompIntegration, label: 'state/secrets/omp-integration.json', destination: join(path, 'state', 'secrets', 'omp-integration.json') },
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
