import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  PI_BRIDGE_EMBEDDED_SHA256,
  PI_BRIDGE_EMBEDDED_SOURCE,
  inspectPiBridgeAsset,
} from '@cosyncing/adapter-pi';
import type { BrokerConfig } from '../runtime/configuration.ts';
import { inspectBrokerConfig, writeBrokerConfig } from '../runtime/configuration.ts';
import {
  brokerTokenPath,
  ensureInstallationCredentials,
  inspectBrokerToken,
  inspectPiIntegration,
  piIntegrationPath,
  readPiIntegration,
} from '../security/credentials.ts';
import {
  committedInstallState,
  inspectInstallState,
  installStatePath,
  installedBinaryPath,
  writeInstallState,
  type CommittedInstallState,
  type InstalledResourceRecord,
} from './install-state.ts';
import {
  assertNoSymlinkComponents,
  atomicWriteOwnerOnly,
} from '../security/secure-files.ts';
import {
  inspectAgentSkill,
  AGENT_SKILL_SHA256,
  AGENT_SKILL_SOURCE,
  type AgentSkillTarget,
} from './agent-skill.ts';
import {
  OPENCODE_SHIM_BLOCK_BEGIN,
  OPENCODE_SHIM_DEFAULT_HOST,
  OPENCODE_SHIM_RESOURCE_ID,
  OPENCODE_SHIM_SHA256,
  OPENCODE_SHIM_SOURCE,
  inspectOpencodeShim,
  inspectRcFile,
  installRcBlock,
  opencodeShimPort,
  opencodeShimShellPath,
  type OpencodeShimRcTarget,
} from '@cosyncing/adapter-opencode';
import {
  readSetupState,
  setupStatePath,
  writeSetupState,
  type SetupState,
} from './setup-state.ts';
import type {
  SetupCommitAction,
  SetupRollbackRecord,
  SetupTransactionAction,
  SetupTransactionContext,
} from './setup-transaction.ts';
import {
  inspectDurableStatePermissionRepair,
  type DurableStatePermissionRepair,
} from '../security/durable-state.ts';
import {
  inspectPiBridgeOwnership,
  piBridgeOwnershipPrecondition,
  piBridgeReplaceable,
} from './pi-bridge-ownership.ts';

interface FileSnapshot {
  target: string;
  existed: boolean;
  backupPath?: string;
  mode?: number;
  /**
   * Ancestor directories of `target` that did not exist when the snapshot was taken, deepest first. The
   * owner-only writer creates them on the way to the file, and rollback used to restore the file while
   * leaving the tree behind — a failed physical setup left empty `bin/`, `secrets/`, and skill directories
   * scattered across the host. Absent on journals written before this field existed: nothing to remove.
   */
  createdDirectories?: string[];
}

interface FileRollbackData extends Record<string, unknown> {
  files: FileSnapshot[];
}

export interface SetupActionInputs {
  home: string;
  config: BrokerConfig;
  setupState: SetupState;
  piAgentDir: string;
  installPiBridge: boolean;
  /** Separate consent to replace only the exact preceding packaged Pi bridge. */
  replaceLegacyPiBridge?: boolean;
  /** Locked-plan identity that both apply and the final atomic replacement callback must still observe. */
  piBridgePrecondition?: string;
  /** Current-schema, owner-held files whose only defect is a loose mode. */
  durableStatePermissionRepairs?: readonly DurableStatePermissionRepair[];
  agentSkillTargets: readonly AgentSkillTarget[];
  installAgentSkill: boolean;
  /** Separate consent to replace only exact known preceding packaged skill content. */
  upgradeLegacyAgentSkill?: boolean;
  removeAgentSkillResourceIds: readonly string[];
  /** Opt-in shell shim. All candidate rc targets (bash/zsh); the action installs only into existing files. */
  opencodeShimRcTargets?: readonly OpencodeShimRcTarget[];
  installOpencodeShim?: boolean;
  /** True when the on-disk shim is a receipt-proven PREVIOUS package version (an owned-stale safe upgrade), so
   *  `apply` may overwrite a 'drifted' script; a drifted script WITHOUT this proof is preserved as foreign. */
  opencodeShimStaleUpgrade?: boolean;
  /** Managed serve port pinned into the rc block; resolved from OPENCODE_URL. Defaults to 4096 when omitted. */
  opencodeShimPort?: number;
  /** Managed serve host pinned into the rc block; resolved from OPENCODE_URL. Defaults to 127.0.0.1 when omitted. */
  opencodeShimHost?: string;
  installMetadata: {
    version: string;
    packaged: boolean;
    executablePath: string;
    aliasPath?: string;
    serviceChoice: 'foreground' | 'systemd' | 'launchd';
    systemdLingeringRequested: boolean;
  };
  removeResourceIds?: readonly string[];
  legacyConnectivityMigration?: { preservedTargets: readonly string[] };
  now?: () => Date;
}

function sha256(content: string | Uint8Array): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Ancestor directories of `target` that are absent right now, deepest first. */
function missingAncestorDirectories(target: string): string[] {
  const missing: string[] = [];
  let cursor = dirname(target);
  while (cursor !== dirname(cursor) && !existsSync(cursor)) {
    missing.push(cursor);
    cursor = dirname(cursor);
  }
  return missing;
}

export function snapshotSetupFiles(
  context: Readonly<SetupTransactionContext>,
  actionId: string,
  targets: readonly string[],
): SetupRollbackRecord {
  const files = targets.map((target, index): FileSnapshot => {
    assertNoSymlinkComponents(target, false);
    if (!existsSync(target)) {
      const createdDirectories = missingAncestorDirectories(target);
      return { target, existed: false, ...(createdDirectories.length ? { createdDirectories } : {}) };
    }
    const stat = lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`unsafe setup target: ${actionId}`);
    const backupPath = join(context.transactionDirectory, `${actionId}-${index}-${basename(target)}.backup`);
    atomicWriteOwnerOnly(backupPath, readFileSync(target), { mode: 0o600 });
    return { target, existed: true, backupPath, mode: stat.mode & 0o777 };
  });
  return { kind: 'files-v1', data: { files } satisfies FileRollbackData };
}

export function rollbackSetupFiles(record: Readonly<SetupRollbackRecord>): void {
  if (record.kind !== 'files-v1' || !Array.isArray(record.data.files)) {
    throw new Error('invalid setup rollback record');
  }
  const files = record.data.files as unknown[];
  for (const candidate of [...files].reverse()) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('invalid setup rollback snapshot');
    }
    const snapshot = candidate as Partial<FileSnapshot>;
    if (typeof snapshot.target !== 'string' || typeof snapshot.existed !== 'boolean') {
      throw new Error('invalid setup rollback snapshot');
    }
    assertNoSymlinkComponents(snapshot.target, false);
    if (snapshot.existed) {
      if (typeof snapshot.backupPath !== 'string' || !existsSync(snapshot.backupPath)) {
        throw new Error('setup rollback backup is missing');
      }
      const backup = lstatSync(snapshot.backupPath);
      if (backup.isSymbolicLink() || !backup.isFile()) throw new Error('setup rollback backup is unsafe');
      atomicWriteOwnerOnly(snapshot.target, readFileSync(snapshot.backupPath), {
        mode: typeof snapshot.mode === 'number' ? snapshot.mode : 0o600,
      });
      continue;
    }
    if (existsSync(snapshot.target)) {
      const current = lstatSync(snapshot.target);
      if (current.isSymbolicLink() || !current.isFile()) throw new Error('refusing unsafe rollback removal');
      unlinkSync(snapshot.target);
    }
    removeCreatedEmptyDirectories(snapshot.createdDirectories);
  }
}

/**
 * Remove the directories this action's write created, deepest first, and only while they are still empty
 * real directories. Anything now holding content belongs to something else and is left alone; every step is
 * best-effort because a leftover directory must never turn a settled rollback into a rollback failure.
 */
function removeCreatedEmptyDirectories(directories: unknown): void {
  if (!Array.isArray(directories)) return;
  for (const candidate of directories) {
    if (typeof candidate !== 'string' || !isAbsolute(candidate)) continue;
    try {
      if (!existsSync(candidate)) continue;
      const stat = lstatSync(candidate);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      if (readdirSync(candidate).length > 0) return;
      rmdirSync(candidate);
    } catch {
      return;
    }
  }
}

/**
 * Bootstrap-copy status of the canonical installed binary (`<home>/bin/cosyncing`).
 *
 * 'not-applicable' — a source build; it has no packaged executable to copy and never claims one.
 * 'missing'        — no home copy yet (first setup, including every npm install).
 * 'stale'          — a home copy exists but differs from the running packaged executable (npm updated it).
 * 'current'        — the home copy is byte-identical to the running executable; nothing to write.
 * 'unsafe'         — the home copy is a symlink, a non-file, or not owned by us; never overwritten.
 * 'source-unreadable' — the running executable cannot be read safely, so no copy can be proven.
 */
export type InstalledBinaryStatus =
  | 'not-applicable'
  | 'missing'
  | 'stale'
  | 'current'
  | 'unsafe'
  | 'source-unreadable';

export interface InstalledBinaryInspection {
  /** `<home>/bin/cosyncing` — the canonical installed path every receipt names. */
  path: string;
  status: InstalledBinaryStatus;
  /** sha256 of the running packaged executable (the copy source), when it reads safely. */
  expectedSha256?: string;
  /** sha256 of the existing home copy, when it is a safe owner-only regular file. */
  actualSha256?: string;
  /** True when the running executable already IS the home copy (a self-installed/upgraded run). */
  selfInstalled: boolean;
}

/** Read a candidate binary only when it is an absolute, non-symlinked, owner-held regular file. */
function readSafeBinary(target: string): Uint8Array | undefined {
  try {
    assertNoSymlinkComponents(target, false);
    if (!existsSync(target)) return undefined;
    const stat = lstatSync(target);
    const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
    if (stat.isSymbolicLink() || !stat.isFile() || (uid !== undefined && stat.uid !== uid)) return undefined;
    return readFileSync(target);
  } catch {
    return undefined;
  }
}

/**
 * Decide whether setup must perform the bootstrap copy, without mutating anything. Both the planner and the
 * `binary.install` action read this, so the plan shown to the operator is exactly what apply() will do.
 */
export function inspectInstalledBinary(options: {
  home: string;
  packaged: boolean;
  executablePath: string;
}): InstalledBinaryInspection {
  const path = installedBinaryPath(options.home);
  const selfInstalled = resolve(options.executablePath) === resolve(path);
  if (!options.packaged) return { path, status: 'not-applicable', selfInstalled };
  const source = readSafeBinary(options.executablePath);
  if (!source) return { path, status: 'source-unreadable', selfInstalled };
  const expectedSha256 = sha256(source);
  if (selfInstalled) return { path, status: 'current', expectedSha256, actualSha256: expectedSha256, selfInstalled };
  let existing = false;
  try {
    assertNoSymlinkComponents(path, false);
    existing = existsSync(path);
  } catch {
    return { path, status: 'unsafe', expectedSha256, selfInstalled };
  }
  if (!existing) return { path, status: 'missing', expectedSha256, selfInstalled };
  const current = readSafeBinary(path);
  if (!current) return { path, status: 'unsafe', expectedSha256, selfInstalled };
  const actualSha256 = sha256(current);
  return {
    path,
    status: actualSha256 === expectedSha256 ? 'current' : 'stale',
    expectedSha256,
    actualSha256,
    selfInstalled,
  };
}

/**
 * D0 bootstrap copy. Place the running packaged executable at `<home>/bin/cosyncing` (owner-only 0o700,
 * temp+rename, no symlink components) and emit the measured `broker-binary` receipt for it.
 *
 * Idempotent by content: a byte-identical home copy is left untouched and only re-receipted, so re-running
 * setup after no change writes nothing, while re-running after an `npm update` overwrites the stale copy
 * with the newly acquired build. A self-installed run (the running executable already IS the home copy)
 * never rewrites itself. Source builds emit no binary receipt at all — they keep today's behavior of
 * refusing to claim an installed binary they do not own.
 */
export function createInstalledBinarySetupAction(inputs: SetupActionInputs): SetupTransactionAction {
  const target = installedBinaryPath(inputs.home);
  const inspect = (): InstalledBinaryInspection => inspectInstalledBinary({
    home: inputs.home,
    packaged: inputs.installMetadata.packaged,
    executablePath: inputs.installMetadata.executablePath,
  });
  return {
    id: 'binary.install',
    prepare: (context) => snapshotSetupFiles(context, 'binary.install', [target]),
    apply: () => {
      if (!inputs.installMetadata.packaged) return { resources: [] };
      const before = inspect();
      if (before.status === 'source-unreadable') throw new Error('installed binary source is not readable');
      if (before.status === 'unsafe') throw new Error('installed binary target is not safely replaceable');
      const expectedSha256 = before.expectedSha256;
      if (!expectedSha256) throw new Error('installed binary source hash is unavailable');
      if (before.status === 'missing' || before.status === 'stale') {
        const source = readSafeBinary(inputs.installMetadata.executablePath);
        if (!source) throw new Error('installed binary source is not readable');
        atomicWriteOwnerOnly(target, source, { mode: 0o700 });
      }
      const written = readSafeBinary(target);
      if (!written || sha256(written) !== expectedSha256) throw new Error('installed binary copy did not verify');
      return {
        resources: [{
          id: 'broker-binary',
          kind: 'binary',
          target,
          ownership: { proof: 'package-hash', installedSha256: expectedSha256 },
        } satisfies InstalledResourceRecord],
      };
    },
    verify: () => {
      if (!inputs.installMetadata.packaged) return true;
      const after = inspect();
      return after.status === 'current';
    },
    rollback: (_context, record) => { rollbackSetupFiles(record); },
  };
}

function sameConfig(left: BrokerConfig, right: BrokerConfig): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function createConfigurationSetupAction(inputs: SetupActionInputs): SetupTransactionAction {
  return {
    id: 'config.ensure',
    prepare: (context) => snapshotSetupFiles(context, 'config.ensure', [join(inputs.home, 'config.json')]),
    apply: () => { writeBrokerConfig(inputs.config, inputs.home); },
    verify: () => {
      const inspection = inspectBrokerConfig(inputs.home);
      return inspection.status === 'ok' && sameConfig(inspection.config, inputs.config);
    },
    rollback: (_context, record) => { rollbackSetupFiles(record); },
  };
}

export function createCredentialSetupAction(inputs: SetupActionInputs): SetupTransactionAction {
  const tokenTarget = brokerTokenPath(inputs.home);
  const piTarget = piIntegrationPath(inputs.home);
  return {
    id: 'credentials.ensure',
    prepare: (context) => snapshotSetupFiles(context, 'credentials.ensure', [tokenTarget, piTarget]),
    apply: () => {
      ensureInstallationCredentials({ home: inputs.home, internalUrl: inputs.config.broker.internalUrl });
    },
    verify: () => {
      if (inspectBrokerToken(tokenTarget).status !== 'ok' || inspectPiIntegration(piTarget).status !== 'ok') return false;
      return readPiIntegration(piTarget).internalUrl === inputs.config.broker.internalUrl;
    },
    rollback: (_context, record) => { rollbackSetupFiles(record); },
  };
}

function desiredSetupStateMatches(actual: SetupState, desired: SetupState): boolean {
  return actual.schemaVersion === 1
    && actual.agents?.codex === desired.agents?.codex
    && actual.managedRuntimeAcknowledgedAt === desired.managedRuntimeAcknowledgedAt
    && actual.serviceChoice === desired.serviceChoice
    && actual.systemdLingeringRequested === desired.systemdLingeringRequested
    && actual.agentSkillRequested === desired.agentSkillRequested
    && actual.opencodeShimRequested === desired.opencodeShimRequested
    && actual.quotaWarningsEnabled === desired.quotaWarningsEnabled;
}

export function createSetupStateAction(inputs: SetupActionInputs): SetupTransactionAction {
  return {
    id: 'setup-state.write',
    prepare: (context) => snapshotSetupFiles(context, 'setup-state.write', [setupStatePath(inputs.home)]),
    apply: () => { writeSetupState(inputs.setupState, inputs.home); },
    verify: () => desiredSetupStateMatches(readSetupState(inputs.home), inputs.setupState),
    rollback: (_context, record) => { rollbackSetupFiles(record); },
  };
}

export function createPiBridgeSetupAction(inputs: SetupActionInputs): SetupTransactionAction {
  const target = inspectPiBridgeAsset(inputs.piAgentDir).path;
  const assertReplacementPrecondition = (): void => {
    if (!inputs.piBridgePrecondition) throw new Error('Pi bridge replacement precondition is missing');
    const decision = inspectPiBridgeOwnership(inspectInstallState(inputs.home), inputs.piAgentDir);
    if (!piBridgeReplaceable(decision)
        || piBridgeOwnershipPrecondition(decision) !== inputs.piBridgePrecondition
        || (decision.status === 'legacy-unreceipted' && inputs.replaceLegacyPiBridge !== true)) {
      throw new Error('Pi bridge target or receipt changed after planning');
    }
  };
  return {
    id: 'pi-bridge.install',
    prepare: (context) => snapshotSetupFiles(context, 'pi-bridge.install', [target]),
    apply: () => {
      assertReplacementPrecondition();
      atomicWriteOwnerOnly(target, PI_BRIDGE_EMBEDDED_SOURCE, {
        mode: 0o600,
        beforeReplace: assertReplacementPrecondition,
      });
      return {
        resources: [{
          id: 'pi-bridge',
          kind: 'agent-integration',
          target,
          ownership: { proof: 'package-hash', installedSha256: PI_BRIDGE_EMBEDDED_SHA256 },
        } satisfies InstalledResourceRecord],
      };
    },
    verify: () => inspectPiBridgeAsset(inputs.piAgentDir).status === 'owned',
    rollback: (_context, record) => { rollbackSetupFiles(record); },
  };
}

export function createDurableStatePermissionsSetupAction(inputs: SetupActionInputs): SetupTransactionAction {
  const repairs = inputs.durableStatePermissionRepairs ?? [];
  return {
    id: 'durable-state.permissions',
    prepare: (context) => snapshotSetupFiles(
      context,
      'durable-state.permissions',
      repairs.map((repair) => repair.path),
    ),
    apply: () => {
      for (const repair of repairs) {
        const status = inspectDurableStatePermissionRepair(repair);
        if (status === 'current') continue;
        if (status !== 'tightenable') {
          throw new Error(`durable state is not safely permission-repairable: ${repair.id}`);
        }
        chmodSync(repair.path, 0o600);
      }
    },
    verify: () => repairs.every((repair) => inspectDurableStatePermissionRepair(repair) === 'current'),
    rollback: (_context, record) => { rollbackSetupFiles(record); },
  };
}

export function createAgentSkillSetupAction(inputs: SetupActionInputs): SetupTransactionAction {
  const targets = inputs.agentSkillTargets;
  return {
    id: 'agent-skill.reconcile',
    prepare: (context) => snapshotSetupFiles(
      context,
      'agent-skill.reconcile',
      targets.map((target) => target.path),
    ),
    apply: () => {
      // Pre-transaction receipts prove which on-disk copies we installed. The commit action rewrites them
      // afterwards, so reading here reflects the previous install's ownership evidence.
      const existing = inspectInstallState(inputs.home);
      const receipts = existing.committed ? existing.state.resources : [];
      const resources: InstalledResourceRecord[] = [];
      for (const target of targets) {
        const inspection = inspectAgentSkill(target);
        if (inputs.installAgentSkill) {
          const receipt = receipts.find((item) => item.id === target.resourceId);
          const receiptProves = (sha: string | undefined): boolean => !!receipt
            && receipt.kind === 'agent-integration'
            && receipt.target === target.path
            && receipt.ownership?.proof === 'package-hash'
            && !!sha
            && receipt.ownership.installedSha256 === sha;
          if (inspection.status === 'missing') {
            atomicWriteOwnerOnly(target.path, AGENT_SKILL_SOURCE, { mode: 0o600 });
          } else if (inspection.status === 'owned') {
            // Current packaged content already on disk; only (re)record the ownership receipt below.
          } else if (inspection.status === 'known-legacy' && inputs.upgradeLegacyAgentSkill === true) {
            atomicWriteOwnerOnly(target.path, AGENT_SKILL_SOURCE, { mode: 0o600 });
          } else if (inspection.status === 'drifted' && receiptProves(inspection.actualSha256)) {
            // owned-stale: our receipt proves we installed this exact older content -> upgrade it in place.
            atomicWriteOwnerOnly(target.path, AGENT_SKILL_SOURCE, { mode: 0o600 });
          } else {
            throw new Error(`agent skill target is not safely replaceable: ${target.id}`);
          }
          resources.push({
            id: target.resourceId,
            kind: 'agent-integration',
            target: target.path,
            ownership: { proof: 'package-hash', installedSha256: AGENT_SKILL_SHA256 },
          });
          continue;
        }
        if (!inputs.removeAgentSkillResourceIds.includes(target.resourceId)) continue;
        if (inspection.status === 'owned') unlinkSync(target.path);
        else if (inspection.status !== 'missing') {
          throw new Error(`agent skill target is not safely removable: ${target.id}`);
        }
      }
      return { resources };
    },
    verify: () => targets.every((target) => {
      const status = inspectAgentSkill(target).status;
      return inputs.installAgentSkill
        ? status === 'owned'
        : !inputs.removeAgentSkillResourceIds.includes(target.resourceId) || status === 'missing';
    }),
    rollback: (_context, record) => { rollbackSetupFiles(record); },
  };
}

/**
 * Install the opt-in OpenCode terminal-attach shim: R1 the hash-owned shim script under the state home, and
 * R2 a delimited managed block in each ALREADY-EXISTING bash/zsh rc file (never creating rc files). Only acts
 * when consent is true; opt-out and full removal are handled by uninstall/repair, not here. Every rc edit
 * preserves unrelated bytes (installRcBlock replaces only the marker region or appends after one blank line).
 */
export function createOpencodeShimSetupAction(inputs: SetupActionInputs): SetupTransactionAction {
  const shimPath = opencodeShimShellPath(inputs.home);
  const port = inputs.opencodeShimPort ?? opencodeShimPort(undefined);
  const host = inputs.opencodeShimHost ?? OPENCODE_SHIM_DEFAULT_HOST;
  const rcTargets = inputs.opencodeShimRcTargets ?? [];
  return {
    id: 'opencode-shim.reconcile',
    prepare: (context) => snapshotSetupFiles(
      context,
      'opencode-shim.reconcile',
      [shimPath, ...rcTargets.map((target) => target.path)],
    ),
    apply: () => {
      if (!inputs.installOpencodeShim) return { resources: [] };
      const resources: InstalledResourceRecord[] = [];
      // R1: write when missing, already package-owned, or an owned-stale previous version we installed (a safe
      // in-place upgrade, proven by the receipt at plan time). A user-edited or structurally-unsafe copy is
      // never overwritten.
      const shimStatus = inspectOpencodeShim(shimPath);
      if (shimStatus === 'missing' || shimStatus === 'owned' || (shimStatus === 'drifted' && inputs.opencodeShimStaleUpgrade)) {
        atomicWriteOwnerOnly(shimPath, OPENCODE_SHIM_SOURCE, { mode: 0o600 });
      } else {
        throw new Error('opencode shim script is not safely replaceable');
      }
      resources.push({
        id: OPENCODE_SHIM_RESOURCE_ID,
        kind: 'path-entry',
        target: shimPath,
        ownership: { proof: 'package-hash', installedSha256: OPENCODE_SHIM_SHA256 },
      });
      // R2: managed block in each existing (regular, owned) rc file only. A FOREIGN block (lone/duplicate/
      // edited/nested markers, or a source line for another path) is never clobbered: skip it, push no receipt,
      // and warn so the operator can reconcile it manually. 'absent' appends; 'owned'/'owned-stale' (a drifted
      // port/host or older format) re-canonicalize in place.
      for (const target of rcTargets) {
        const rc = inspectRcFile(target.path, shimPath, port, host);
        if (rc.status === 'absent' || rc.status === 'unsafe') continue;
        if (rc.blockState === 'foreign') {
          console.warn(`cosyncing: ${target.path} has a modified or unrecognized cosyncing opencode block; `
            + 'preserving it and skipping this file. Reconcile it manually, then rerun setup.');
          continue;
        }
        const next = installRcBlock(rc.content, shimPath, port, host);
        if (next !== rc.content) atomicWriteOwnerOnly(target.path, next, { preserveMode: true });
        resources.push({
          id: target.resourceId,
          kind: 'shell-init-block',
          target: target.path,
          ownership: { proof: 'receipt', marker: OPENCODE_SHIM_BLOCK_BEGIN },
        });
      }
      return { resources };
    },
    verify: () => {
      if (!inputs.installOpencodeShim) return true;
      if (inspectOpencodeShim(shimPath) !== 'owned') return false;
      // A skipped foreign block is an accepted terminal state (preserved, not owned), so verify tolerates it.
      // An owned-stale block must have been re-canonicalized to owned by apply, so it is NOT tolerated here.
      return rcTargets.every((target) => {
        const rc = inspectRcFile(target.path, shimPath, port, host);
        return rc.status === 'absent' || rc.status === 'unsafe'
          || rc.blockState === 'owned' || rc.blockState === 'foreign';
      });
    },
    rollback: (_context, record) => { rollbackSetupFiles(record); },
  };
}

function mergeResources(
  existing: readonly InstalledResourceRecord[],
  incoming: readonly InstalledResourceRecord[],
): InstalledResourceRecord[] {
  const merged = new Map(existing.map((resource) => [resource.id, resource]));
  for (const resource of incoming) merged.set(resource.id, resource);
  return [...merged.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Receipts the commit action contributes directly. The `broker-binary` receipt is NOT one of them: it is
 * emitted by `binary.install`, which is the only step that knows the home copy is in place and measured.
 * Deriving it here from `process.execPath` is exactly what produced a permanently invalid receipt for an npm
 * install (`<prefix>/lib/node_modules/...`), and re-deriving it on an unrelated commit would clobber the
 * measured one. A commit without that action keeps the previously committed receipt through `mergeResources`.
 */
function receiptResources(inputs: SetupActionInputs): InstalledResourceRecord[] {
  if (!inputs.installMetadata.packaged) return [];
  const resources: InstalledResourceRecord[] = [];
  if (inputs.installMetadata.aliasPath) {
    resources.push({
      id: 'broker-alias',
      kind: 'alias',
      target: inputs.installMetadata.aliasPath,
      ownership: { proof: 'receipt' },
    });
  }
  return resources;
}

export function createInstallCommitAction(inputs: SetupActionInputs): SetupCommitAction {
  const target = installStatePath(inputs.home);
  let expectedResources: InstalledResourceRecord[] = [];
  return {
    id: 'install-state.commit',
    prepare: (context) => snapshotSetupFiles(context, 'install-state.commit', [target]),
    apply: (_context, resources) => {
      const existing = inspectInstallState(inputs.home);
      const base: CommittedInstallState = existing.committed
        ? existing.state
        : committedInstallState((inputs.now?.() ?? new Date()).toISOString());
      const retained = base.resources.filter((resource) => !inputs.removeResourceIds?.includes(resource.id));
      expectedResources = mergeResources(
        retained,
        [...receiptResources(inputs), ...resources],
      );
      const committedAt = (inputs.now?.() ?? new Date()).toISOString();
      writeInstallState({
        ...base,
        setup: { status: 'committed', committedAt },
        resources: expectedResources,
        installer: {
          version: inputs.installMetadata.version,
          serviceChoice: inputs.installMetadata.serviceChoice,
          systemdLingeringRequested: inputs.installMetadata.systemdLingeringRequested,
        },
        ...(inputs.legacyConnectivityMigration
          ? {
              legacyConnectivityMigration: {
                migratedAt: committedAt,
                preservedTargets: [...inputs.legacyConnectivityMigration.preservedTargets],
              },
            }
          : {}),
      }, inputs.home);
    },
    verify: () => {
      const inspection = inspectInstallState(inputs.home);
      return inspection.committed
        && expectedResources.every((resource) => inspection.state.resources.some((item) => item.id === resource.id));
    },
    rollback: (_context, record) => { rollbackSetupFiles(record); },
  };
}

export function createSetupActionCatalog(inputs: SetupActionInputs): {
  actions: SetupTransactionAction[];
  commitAction: SetupCommitAction;
} {
  const actions = [
    createInstalledBinarySetupAction(inputs),
    createConfigurationSetupAction(inputs),
    createCredentialSetupAction(inputs),
    createSetupStateAction(inputs),
    createDurableStatePermissionsSetupAction(inputs),
    // Keep the complete stable catalog available for interrupted-transaction recovery. The plan decides
    // whether this action runs; merely constructing it performs no filesystem mutation.
    createPiBridgeSetupAction(inputs),
    createAgentSkillSetupAction(inputs),
    createOpencodeShimSetupAction(inputs),
  ];
  return { actions, commitAction: createInstallCommitAction(inputs) };
}

export function setupActionContentHash(inputs: SetupActionInputs): string {
  return sha256(JSON.stringify({
    config: inputs.config,
    setupState: inputs.setupState,
    installPiBridge: inputs.installPiBridge,
    replaceLegacyPiBridge: inputs.replaceLegacyPiBridge,
    piBridgePrecondition: inputs.piBridgePrecondition,
    durableStatePermissionRepairs: inputs.durableStatePermissionRepairs,
    agentSkillTargets: inputs.agentSkillTargets,
    installAgentSkill: inputs.installAgentSkill,
    upgradeLegacyAgentSkill: inputs.upgradeLegacyAgentSkill,
    removeAgentSkillResourceIds: inputs.removeAgentSkillResourceIds,
    opencodeShimRcTargets: inputs.opencodeShimRcTargets,
    installOpencodeShim: inputs.installOpencodeShim,
    opencodeShimStaleUpgrade: inputs.opencodeShimStaleUpgrade,
    opencodeShimPort: inputs.opencodeShimPort,
    opencodeShimHost: inputs.opencodeShimHost,
    installMetadata: inputs.installMetadata,
  }));
}
