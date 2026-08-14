import { resolve } from 'node:path';
import {
  PI_BRIDGE_EMBEDDED_SHA256,
  inspectPiBridgeAsset,
  type PiBridgeAssetInspection,
} from '@cosyncing/adapter-pi';
import { inspectOwnerOnlyFile } from '../security/secure-files.ts';
import type {
  InstalledResourceRecord,
  InstallStateInspection,
} from './install-state.ts';

export const PI_BRIDGE_RESOURCE_ID = 'pi-bridge';

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

function piBridgeReceipts(install: InstallStateInspection): InstalledResourceRecord[] {
  if (!install.committed) return [];
  return (install.state.resources as unknown[]).filter((resource): resource is InstalledResourceRecord =>
    !!resource
      && typeof resource === 'object'
      && (resource as Record<string, unknown>).id === PI_BRIDGE_RESOURCE_ID);
}

function receiptProves(
  receipt: InstalledResourceRecord | undefined,
  bridge: PiBridgeAssetInspection,
  sha256: string | undefined,
): receipt is InstalledResourceRecord {
  return !!receipt
    && !!sha256
    && receipt.id === PI_BRIDGE_RESOURCE_ID
    && receipt.kind === 'agent-integration'
    && typeof receipt.target === 'string'
    && resolve(receipt.target) === resolve(bridge.path)
    && !!receipt.ownership
    && receipt.ownership.proof === 'package-hash'
    && receipt.ownership.installedSha256 === sha256;
}

/**
 * Interpret Pi bridge ownership at the broker installation boundary.
 *
 * The adapter owns only provider-specific path/content classification. Receipt meaning, canonical target
 * matching, and host-file safety stay here with setup/repair/uninstall.
 */
export function decidePiBridgeOwnership(
  install: InstallStateInspection,
  bridge: PiBridgeAssetInspection,
): PiBridgeOwnershipDecision {
  const receipts = piBridgeReceipts(install);
  const receipt = receipts[0];
  const uniqueReceipt = receipts.length === 1 ? receipt : undefined;
  const file = inspectOwnerOnlyFile(bridge.path);
  const base = {
    bridge,
    ...(receipt ? { receipt } : {}),
    receiptMatchesCurrentPackage: receiptProves(uniqueReceipt, bridge, PI_BRIDGE_EMBEDDED_SHA256),
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
  if (receipt && !receiptProves(uniqueReceipt, bridge, bridge.actualSha256)) {
    return { ...base, status: 'receipt-invalid' };
  }
  if (bridge.status === 'owned') return { ...base, status: 'owned-current' };
  if (receiptProves(uniqueReceipt, bridge, bridge.actualSha256)) return { ...base, status: 'owned-stale' };
  if (!receipt && bridge.status === 'legacy-marker') return { ...base, status: 'legacy-unreceipted' };
  return { ...base, status: 'unowned' };
}

export function inspectPiBridgeOwnership(
  install: InstallStateInspection,
  piAgentDir: string,
): PiBridgeOwnershipDecision {
  return decidePiBridgeOwnership(install, inspectPiBridgeAsset(piAgentDir));
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
