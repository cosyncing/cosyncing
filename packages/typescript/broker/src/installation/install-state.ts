import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRODUCT_IDENTITY } from '@cosyncing/protocol';
import { setupStateHome } from './setup-state.ts';
import { atomicWriteJsonOwnerOnly, inspectOwnerOnlyFile } from '../security/secure-files.ts';
import { AGENT_SKILL_RESOURCE_IDS } from './agent-skill.ts';
import { OPENCODE_SHIM_RC_RESOURCE_IDS, OPENCODE_SHIM_RESOURCE_ID } from '@cosyncing/adapter-opencode';

export const TAILSCALE_SERVE_RESOURCE_ID = 'tailscale-serve-https-root';

/** Every receipt id emitted by setup and handled by uninstall. */
export const KNOWN_INSTALL_RESOURCE_IDS: ReadonlySet<string> = new Set<string>([
  'broker-binary',
  'broker-binary-previous',
  'broker-alias',
  'service-systemd',
  'service-launchd',
  'service-environment',
  'service-systemd-linger',
  'pi-bridge',
  TAILSCALE_SERVE_RESOURCE_ID,
  ...Object.values(AGENT_SKILL_RESOURCE_IDS),
  OPENCODE_SHIM_RESOURCE_ID,
  ...Object.values(OPENCODE_SHIM_RC_RESOURCE_IDS),
]);

export const INSTALL_STATE_SCHEMA_VERSION = 1 as const;
export const INSTALL_STATE_FILENAME = 'install-state.json';

export interface InstalledResourceRecord {
  id: string;
  /**
   * The resource shape drives how uninstall reverses it. Every kind MUST have a construction site (a setup
   * action that emits the receipt) and a matching uninstall branch in broker-lifecycle.ts; the uninstall
   * planner fails closed (`resource-<id>-preserved`) for any receipt it does not recognize. `shell-init-block`
   * is a marker-delimited region inside a user-owned rc file — reversed by excising exactly that region, never
   * by whole-file backup restore, so later unrelated edits survive.
   */
  kind: 'binary' | 'alias' | 'service' | 'environment-file' | 'path-entry' | 'agent-integration' | 'shell-init-block' | 'other';
  target: string;
  ownership: {
    proof: 'package-hash' | 'receipt' | 'legacy-marker';
    installedSha256?: string;
    originalSha256?: string;
    marker?: string;
    backupPath?: string;
  };
}

export interface InstallMigrationRecord {
  id: string;
  fromVersion: number;
  toVersion: number;
  backupPath: string;
  appliedAt: string;
}

export interface CommittedInstallState {
  schemaVersion: typeof INSTALL_STATE_SCHEMA_VERSION;
  product: typeof PRODUCT_IDENTITY.productName;
  setup: {
    status: 'committed';
    committedAt: string;
  };
  resources: InstalledResourceRecord[];
  migrations: InstallMigrationRecord[];
  /** Forward-compatible installer metadata survives later read/write cycles. */
  [key: string]: unknown;
}

export type InstallStateInspection =
  | { committed: true; path: string; state: CommittedInstallState }
  | {
      committed: false;
      path: string;
      reason: 'missing' | 'unsafe-file' | 'unreadable' | 'malformed' | 'uncommitted';
    };

export function installStatePath(home = setupStateHome()): string {
  return join(home, INSTALL_STATE_FILENAME);
}

/**
 * The one canonical installed broker binary, for every acquisition channel.
 *
 * A packaged binary can be acquired anywhere — a release tarball the operator unpacked, or
 * `<prefix>/lib/node_modules/cosyncing/bin/cosyncing` from `npm i -g`. Setup performs a "bootstrap copy" of
 * whatever packaged executable is running into THIS path and records every receipt against it, so the
 * lifecycle contract is uniform: the systemd unit execs it, `upgrade` swaps it, `repair`/`status` validate
 * it, and `uninstall` removes it. An acquisition artifact outside the state home (the npm package) is never
 * a receipt-owned resource and is never mutated.
 */
export function installedBinaryPath(home = setupStateHome()): string {
  return join(home, 'bin', PRODUCT_IDENTITY.primaryBinary);
}

/**
 * What the boot service must exec. Never `process.execPath`: the running executable may be an acquisition
 * artifact (an npm-owned `node_modules` path that `npm uninstall`/`npm update` moves out from under a live
 * unit). The bootstrap copy makes `installedBinaryPath` the stable, receipt-owned target, so the unit
 * survives every acquisition-channel change and `upgrade` swaps exactly the file the unit execs. Source
 * builds keep their entry point; they are never offered durable service mode.
 *
 * Setup and the lifecycle commands MUST resolve this identically, or a written unit reads back as drifted.
 */
export function serviceExecutablePath(options: {
  packaged: boolean;
  home: string;
  executablePath: string;
}): string {
  return options.packaged ? installedBinaryPath(options.home) : options.executablePath;
}

/** Pure record constructor for the future setup transaction and test fixtures. */
export function committedInstallState(committedAt = new Date().toISOString()): CommittedInstallState {
  return {
    schemaVersion: INSTALL_STATE_SCHEMA_VERSION,
    product: PRODUCT_IDENTITY.productName,
    setup: { status: 'committed', committedAt },
    resources: [],
    migrations: [],
  };
}

function normalizeCommittedInstallState(value: unknown): CommittedInstallState | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== INSTALL_STATE_SCHEMA_VERSION) return undefined;
  if (record.product !== PRODUCT_IDENTITY.productName) return undefined;
  if (!record.setup || typeof record.setup !== 'object' || Array.isArray(record.setup)) return undefined;
  const setup = record.setup as Record<string, unknown>;
  if (setup.status !== 'committed' || typeof setup.committedAt !== 'string') return undefined;
  const committedAt = setup.committedAt.trim();
  if (committedAt.length === 0 || !Number.isFinite(Date.parse(committedAt))) return undefined;
  // BPC1 already emitted schema-v1 receipts before these additive journals existed. Normalize that exact
  // shape in memory so an upgrade does not invalidate the D14 first-run gate; malformed present fields still
  // fail closed, and the next installer-owned write persists both arrays.
  const resources = record.resources ?? [];
  const migrations = record.migrations ?? [];
  if (!Array.isArray(resources) || !Array.isArray(migrations)) return undefined;
  return { ...record, resources, migrations } as CommittedInstallState;
}

/**
 * Read-only D14 gate. It never creates or repairs state; BPC5 owns the setup
 * transaction that writes this record after every required step succeeds.
 */
export function inspectInstallState(home = setupStateHome()): InstallStateInspection {
  const path = installStatePath(home);
  const inspection = inspectOwnerOnlyFile(path);
  if (inspection.status === 'missing') return { committed: false, path, reason: 'missing' };
  if (inspection.status === 'unsafe') return { committed: false, path, reason: 'unsafe-file' };
  if (inspection.status !== 'ok') return { committed: false, path, reason: 'unreadable' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { committed: false, path, reason: code ? 'unreadable' : 'malformed' };
  }
  const state = normalizeCommittedInstallState(parsed);
  if (!state) {
    return { committed: false, path, reason: 'uncommitted' };
  }
  return { committed: true, path, state };
}

/** BPC5 commits through this owner-only atomic boundary after its transaction verifies every step. */
export function writeInstallState(state: CommittedInstallState, home = setupStateHome()): void {
  const normalized = normalizeCommittedInstallState(state);
  if (!normalized) throw new Error('refusing to write invalid install state');
  atomicWriteJsonOwnerOnly(installStatePath(home), normalized);
}
