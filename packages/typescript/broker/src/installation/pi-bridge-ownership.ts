import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, parse, resolve, win32 as win32Path } from 'node:path';
import {
  PI_BRIDGE_EMBEDDED_SHA256,
  inspectPiBridgeAsset,
  type PiBridgeAssetInspection,
} from '@cosyncing/adapter-pi';
import { inspectOmpBridgeAsset } from '@cosyncing/adapter-omp';
import { OMP_BRIDGE_EMBEDDED_SHA256 } from '@cosyncing/adapter-omp/bridge-asset';
import { inspectOwnerOnlyFile } from '../security/secure-files.ts';
import type {
  InstalledResourceRecord,
  InstallStateInspection,
} from './install-state.ts';

export const PI_BRIDGE_RESOURCE_ID = 'pi-bridge';
export const OMP_BRIDGE_RESOURCE_ID = 'omp-bridge';

export type PiBridgeOwnershipStatus =
  | 'missing'
  | 'owned-current'
  | 'owned-stale'
  | 'legacy-unreceipted'
  | 'unowned'
  | 'receipt-invalid'
  | 'unsafe'
  | 'unreadable';

export interface PiBridgeOwnershipDecision {
  status: PiBridgeOwnershipStatus;
  bridge: PiBridgeAssetInspection;
  /** Present whenever committed install state contains a Pi bridge receipt, valid or not. */
  receipt?: InstalledResourceRecord;
  /** A missing target may be restored only when this proves the current packaged bytes at its canonical path. */
  receiptMatchesCurrentPackage: boolean;
}

export type BridgeTargetMigrationStatus =
  | 'not-applicable'
  | 'eligible'
  | 'receipt-invalid'
  | 'unsafe'
  | 'unreadable';

/**
 * A narrowly scoped receipt-path migration. It is eligible only when setup is moving a single committed
 * omp bridge receipt to a different, missing canonical target and the old target still matches that receipt
 * exactly (or is already missing). This never makes a present destination replaceable.
 */
export interface BridgeTargetMigrationDecision {
  status: BridgeTargetMigrationStatus;
  bridge: PiBridgeAssetInspection;
  receipt?: InstalledResourceRecord;
  previousTarget?: string;
  previousTargetStatus?: 'missing' | 'owned';
  previousActualSha256?: string;
}

export type BridgeReceiptTargetStatus =
  | 'not-installed'
  | 'missing'
  | 'owned'
  | 'receipt-invalid'
  | 'unsafe'
  | 'unreadable';

/** Receipt-first ownership proof used when the current environment resolves a different agent directory. */
export interface BridgeReceiptTargetDecision {
  status: BridgeReceiptTargetStatus;
  receipt?: InstalledResourceRecord;
  target?: string;
  actualSha256?: string;
}

function bridgeReceipts(install: InstallStateInspection, resourceId: string): InstalledResourceRecord[] {
  if (!install.committed) return [];
  return (install.state.resources as unknown[]).filter((resource): resource is InstalledResourceRecord =>
    !!resource
      && typeof resource === 'object'
      && (resource as Record<string, unknown>).id === resourceId);
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function pathIdentity(path: string, platform: NodeJS.Platform): string {
  const absolute = platform === 'win32' ? win32Path.resolve(path) : resolve(path);
  return platform === 'win32' ? absolute.toLowerCase() : absolute;
}

/** Host-filesystem path equality; Windows paths are case-insensitive. */
export function sameCanonicalPath(
  left: string,
  right: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  return pathIdentity(left, platform) === pathIdentity(right, platform);
}

function ompBridgeLeafPath(target: string): boolean {
  if (!isAbsolute(target)) return false;
  const normalized = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value;
  const bridgeDirectory = dirname(target);
  const extensionsDirectory = dirname(bridgeDirectory);
  const agentDirectory = dirname(extensionsDirectory);
  return normalized(basename(target)) === 'index.ts'
    && normalized(basename(bridgeDirectory)) === 'cosyncing-bridge'
    && normalized(basename(extensionsDirectory)) === 'extensions'
    && agentDirectory !== parse(agentDirectory).root;
}

function receiptProves(
  receipt: InstalledResourceRecord | undefined,
  bridge: PiBridgeAssetInspection,
  resourceId: string,
  sha256: string | undefined,
): receipt is InstalledResourceRecord {
  return !!receipt
    && !!sha256
    && receipt.id === resourceId
    && receipt.kind === 'agent-integration'
    && typeof receipt.target === 'string'
    && sameCanonicalPath(receipt.target, bridge.path)
    && !!receipt.ownership
    && receipt.ownership.proof === 'package-hash'
    && receipt.ownership.installedSha256 === sha256;
}

/** Which bridge family an ownership decision covers: receipt id plus this build's packaged bytes. */
export interface BridgeOwnershipSpec {
  resourceId: string;
  currentSha256: string | undefined;
}

export const PI_BRIDGE_OWNERSHIP_SPEC: BridgeOwnershipSpec = {
  resourceId: PI_BRIDGE_RESOURCE_ID,
  currentSha256: PI_BRIDGE_EMBEDDED_SHA256,
};

export const OMP_BRIDGE_OWNERSHIP_SPEC: BridgeOwnershipSpec = {
  resourceId: OMP_BRIDGE_RESOURCE_ID,
  currentSha256: OMP_BRIDGE_EMBEDDED_SHA256,
};

/**
 * Interpret bridge ownership at the broker installation boundary.
 *
 * The adapter owns only provider-specific path/content classification. Receipt meaning, canonical target
 * matching, and host-file safety stay here with setup/repair/uninstall.
 */
export function decideBridgeOwnership(
  spec: BridgeOwnershipSpec,
  install: InstallStateInspection,
  bridge: PiBridgeAssetInspection,
): PiBridgeOwnershipDecision {
  const receipts = bridgeReceipts(install, spec.resourceId);
  const receipt = receipts[0];
  const uniqueReceipt = receipts.length === 1 ? receipt : undefined;
  const file = inspectOwnerOnlyFile(bridge.path);
  const base = {
    bridge,
    ...(receipt ? { receipt } : {}),
    receiptMatchesCurrentPackage: receiptProves(uniqueReceipt, bridge, spec.resourceId, spec.currentSha256),
  };

  if (file.status === 'unsafe') return { ...base, status: 'unsafe' };
  if (file.status === 'unreadable') return { ...base, status: 'unreadable' };
  if (bridge.status === 'unsafe') return { ...base, status: 'unsafe' };
  if (file.status === 'missing') {
    if (bridge.status !== 'missing') return { ...base, status: 'unreadable' };
    if (receipt && !base.receiptMatchesCurrentPackage) return { ...base, status: 'receipt-invalid' };
    return { ...base, status: 'missing' };
  }
  if (bridge.status === 'missing' || bridge.status === 'unreadable') {
    return { ...base, status: 'unreadable' };
  }

  // Once a receipt exists it must prove the exact safe file now on disk. A malformed, wrong-path, stale,
  // or forged receipt cannot be ignored merely because the leaf happens to resemble a known asset.
  if (receipt && !receiptProves(uniqueReceipt, bridge, spec.resourceId, bridge.actualSha256)) {
    return { ...base, status: 'receipt-invalid' };
  }
  if (bridge.status === 'owned') return { ...base, status: 'owned-current' };
  if (receiptProves(uniqueReceipt, bridge, spec.resourceId, bridge.actualSha256)) return { ...base, status: 'owned-stale' };
  if (!receipt && bridge.status === 'legacy-marker') return { ...base, status: 'legacy-unreceipted' };
  return { ...base, status: 'unowned' };
}

/** Pi ownership decision, bound to the pi receipt id and this build's packaged pi bytes. */
export function decidePiBridgeOwnership(
  install: InstallStateInspection,
  bridge: PiBridgeAssetInspection,
): PiBridgeOwnershipDecision {
  return decideBridgeOwnership(PI_BRIDGE_OWNERSHIP_SPEC, install, bridge);
}

export function inspectPiBridgeOwnership(
  install: InstallStateInspection,
  piAgentDir: string,
): PiBridgeOwnershipDecision {
  return decidePiBridgeOwnership(install, inspectPiBridgeAsset(piAgentDir));
}

export function inspectOmpBridgeOwnership(
  install: InstallStateInspection,
  ompAgentDir: string,
): PiBridgeOwnershipDecision {
  return decideBridgeOwnership(OMP_BRIDGE_OWNERSHIP_SPEC, install, inspectOmpBridgeAsset(ompAgentDir));
}

/** Inspect the committed omp bridge at the path named by its receipt, independent of the current env. */
export function inspectOmpBridgeReceiptTarget(install: InstallStateInspection): BridgeReceiptTargetDecision {
  const receipts = bridgeReceipts(install, OMP_BRIDGE_RESOURCE_ID);
  const receipt = receipts.length === 1 ? receipts[0] : undefined;
  const base = { ...(receipts[0] ? { receipt: receipts[0] } : {}) };
  if (!install.committed || receipts.length === 0) return { ...base, status: 'not-installed' };
  if (!receipt
      || typeof receipt.target !== 'string'
      || receipt.id !== OMP_BRIDGE_RESOURCE_ID
      || receipt.kind !== 'agent-integration'
      || !isAbsolute(receipt.target)
      || !ompBridgeLeafPath(receipt.target)
      || receipt.ownership?.proof !== 'package-hash'
      || typeof receipt.ownership.installedSha256 !== 'string'
      || !/^[0-9a-f]{64}$/.test(receipt.ownership.installedSha256)) {
    return { ...base, status: 'receipt-invalid' };
  }
  const target = resolve(receipt.target);
  const file = inspectOwnerOnlyFile(target);
  if (file.status === 'unsafe') return { ...base, status: 'unsafe', target };
  if (file.status === 'unreadable') return { ...base, status: 'unreadable', target };
  if (file.status === 'missing') return { ...base, status: 'missing', target };
  let actualSha256: string;
  try {
    actualSha256 = sha256File(target);
  } catch {
    return { ...base, status: 'unreadable', target };
  }
  if (actualSha256 !== receipt.ownership.installedSha256) {
    return { ...base, status: 'receipt-invalid', target, actualSha256 };
  }
  return { ...base, status: 'owned', target, actualSha256 };
}

/** Stable non-secret proof for receipt-target removal during uninstall. */
export function ompBridgeReceiptTargetPrecondition(decision: BridgeReceiptTargetDecision): string {
  if (!decision.receipt || !decision.target
      || (decision.status !== 'owned' && decision.status !== 'missing')) {
    throw new Error('omp bridge receipt target is not removable');
  }
  return JSON.stringify({
    status: decision.status,
    target: resolve(decision.target),
    actualSha256: decision.actualSha256,
    receipt: {
      id: decision.receipt.id,
      kind: decision.receipt.kind,
      target: resolve(decision.receipt.target),
      proof: decision.receipt.ownership?.proof,
      installedSha256: decision.receipt.ownership?.installedSha256,
    },
  });
}

/** Prove that a changed omp agent directory can receive the committed bridge receipt without orphaning it. */
export function inspectOmpBridgeTargetMigration(
  install: InstallStateInspection,
  ompAgentDir: string,
): BridgeTargetMigrationDecision {
  const bridge = inspectOmpBridgeAsset(ompAgentDir);
  const receiptTarget = inspectOmpBridgeReceiptTarget(install);
  const base = { bridge, ...(receiptTarget.receipt ? { receipt: receiptTarget.receipt } : {}) };
  if (!receiptTarget.receipt || !receiptTarget.target
      || sameCanonicalPath(receiptTarget.target, bridge.path)
      || receiptTarget.status === 'not-installed') {
    return { ...base, status: 'not-applicable' };
  }
  const previousTarget = resolve(receiptTarget.target);
  if (receiptTarget.status === 'receipt-invalid') return { ...base, status: 'receipt-invalid', previousTarget };
  if (receiptTarget.status === 'unsafe') return { ...base, status: 'unsafe', previousTarget };
  if (receiptTarget.status === 'unreadable') return { ...base, status: 'unreadable', previousTarget };
  const destination = inspectOwnerOnlyFile(bridge.path);
  if (destination.status === 'unsafe' || bridge.status === 'unsafe') {
    return { ...base, status: 'unsafe' };
  }
  if (destination.status === 'unreadable' || bridge.status === 'unreadable') {
    return { ...base, status: 'unreadable' };
  }
  // Migration is never an authorization to replace an existing destination, even if its bytes happen to
  // match a packaged asset. Only the ordinary same-path ownership decision may authorize replacement.
  if (destination.status !== 'missing' || bridge.status !== 'missing') {
    return { ...base, status: 'not-applicable' };
  }
  if (receiptTarget.status === 'missing') {
    return { ...base, status: 'eligible', previousTarget, previousTargetStatus: 'missing' };
  }
  return {
    ...base,
    status: 'eligible',
    previousTarget,
    previousTargetStatus: 'owned',
    previousActualSha256: receiptTarget.actualSha256,
  };
}

/** Stable non-secret identity checked again before and during the transactional path migration. */
export function ompBridgeTargetMigrationPrecondition(decision: BridgeTargetMigrationDecision): string {
  if (decision.status !== 'eligible' || !decision.receipt || !decision.previousTarget
      || !decision.previousTargetStatus) {
    throw new Error('omp bridge target migration is not eligible');
  }
  return JSON.stringify({
    status: decision.status,
    target: resolve(decision.bridge.path),
    previousTarget: resolve(decision.previousTarget),
    previousTargetStatus: decision.previousTargetStatus,
    previousActualSha256: decision.previousActualSha256,
    receipt: {
      id: decision.receipt.id,
      kind: decision.receipt.kind,
      target: resolve(decision.receipt.target),
      proof: decision.receipt.ownership?.proof,
      installedSha256: decision.receipt.ownership?.installedSha256,
    },
  });
}

/** Stable, non-secret identity carried from planning to the final pre-replacement check. */
export function piBridgeOwnershipPrecondition(decision: PiBridgeOwnershipDecision): string {
  return JSON.stringify({
    status: decision.status,
    actualSha256: decision.bridge.actualSha256,
    receipt: decision.receipt
      ? {
          id: decision.receipt.id,
          kind: decision.receipt.kind,
          target: typeof decision.receipt.target === 'string'
            ? resolve(decision.receipt.target)
            : '<invalid>',
          proof: decision.receipt.ownership?.proof,
          installedSha256: decision.receipt.ownership?.installedSha256,
        }
      : null,
  });
}

export function piBridgeReplaceable(decision: PiBridgeOwnershipDecision): boolean {
  return decision.status === 'missing'
    || decision.status === 'owned-stale'
    || decision.status === 'legacy-unreceipted';
}
