import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isInstallerWebPin } from '../runtime/runtime-assets.ts';
import { atomicWriteOwnerOnly, inspectOwnerOnlyFile } from '../security/secure-files.ts';
import { parseBrokerServiceEnvironment } from './service-manager.ts';
import type { CommittedInstallState, InstalledResourceRecord } from './install-state.ts';

export interface ServiceWebEnvironmentChange {
  resource: InstalledResourceRecord;
  before: string;
  after: string;
}
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const xml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export class ServiceWebEnvironmentError extends Error {
  constructor(readonly detailCode: string, readonly target: string) { super(detailCode); }
}

/** Only receipt-proven service files may be rewritten. Preserve every other environment entry. */
export function planServiceWebEnvironment(options: {
  state: CommittedInstallState;
  fromRoot: string;
  toRoot: string;
  versionedService?: boolean;
  versionedInstallerRoot?: string;
}): { pinnedRoot?: string; checkServedVersion: boolean; changes: ServiceWebEnvironmentChange[] } {
  const resource = options.state.resources.find((entry) => entry.id === 'service-environment');
  if (!resource) return { checkServedVersion: true, changes: [] };
  const readOwned = (entry: InstalledResourceRecord): string => {
    if (inspectOwnerOnlyFile(entry.target).status !== 'ok') throw new ServiceWebEnvironmentError('upgrade-service-environment-unsafe', entry.target);
    return readFileSync(entry.target, 'utf8');
  };
  const verifyReceipt = (entry: InstalledResourceRecord, text: string): void => {
    if (digest(text) !== entry.ownership.installedSha256) throw new ServiceWebEnvironmentError('upgrade-service-environment-drifted', entry.target);
  };
  const before = readOwned(resource);
  let variables: Record<string, string> | undefined;
  let windows: { variables: Record<string, string> } | undefined;
  try {
    if (resource.ownership.proof === 'receipt') {
      windows = JSON.parse(before);
      variables = windows?.variables;
    } else variables = parseBrokerServiceEnvironment(before);
  } catch { /* rejected below */ }
  if (!variables) throw new ServiceWebEnvironmentError('upgrade-service-environment-invalid', resource.target);
  const pin = variables.COSYNCING_WEB_DIR;
  const installerPin = !!pin && isInstallerWebPin(pin, dirname(options.fromRoot));
  // A versioned Windows activation keeps the old root and its environment intact for rollback. Its
  // writer carries custom pins into the candidate, and moves an installer pin to the candidate root.
  if (options.versionedService || !pin || !installerPin) {
    return { ...(pin && !installerPin ? { pinnedRoot: pin } : {}), checkServedVersion: !pin || installerPin
      || !!(options.versionedInstallerRoot && resolve(pin) === resolve(options.versionedInstallerRoot)), changes: [] };
  }
  verifyReceipt(resource, before);
  const after = windows
    ? JSON.stringify({ ...windows, variables: { ...variables, COSYNCING_WEB_DIR: options.toRoot } }, null, 2) + '\n'
    : before.replace(/^COSYNCING_WEB_DIR=.*$/m, () => `COSYNCING_WEB_DIR=${JSON.stringify(options.toRoot)}`);
  const changes: ServiceWebEnvironmentChange[] = [{ resource, before, after }];
  const plist = options.state.resources.find((entry) => entry.id === 'service-launchd');
  if (plist) {
    const definition = readOwned(plist);
    verifyReceipt(plist, definition);
    const match = /(<key>EnvironmentVariables<\/key>\s*<dict>)([\s\S]*?)(<\/dict>)/.exec(definition);
    if (!match) throw new ServiceWebEnvironmentError('upgrade-launchd-environment-invalid', plist.target);
    const pairs = [...match[2]!.matchAll(/<key>COSYNCING_WEB_DIR<\/key>\s*<string>([^<]*)<\/string>/g)];
    if (pairs.length !== 1 || pairs[0]![1] !== xml(pin)) throw new ServiceWebEnvironmentError('upgrade-launchd-web-pin-drifted', plist.target);
    const body = match[2]!.replace(/(<key>COSYNCING_WEB_DIR<\/key>\s*<string>)[^<]*(<\/string>)/,
      (_all, start: string, end: string) => start + xml(options.toRoot) + end);
    changes.push({ resource: plist, before: definition, after: definition.replace(match[0], () => match[1] + body + match[3]) });
  }
  return { pinnedRoot: options.toRoot, checkServedVersion: true, changes };
}

/** Journaled snapshots are bound to ledger targets, including after the candidate receipts commit. */
export function validServiceWebChanges(value: unknown, state: CommittedInstallState): value is ServiceWebEnvironmentChange[] {
  return Array.isArray(value) && value.length <= 2 && new Set(value.map((v) => v?.resource?.id)).size === value.length
    && value.every((change) => {
      const resource = change?.resource;
      const owned = state.resources.find((entry) => entry.id === resource?.id);
      return owned && ['service-environment', 'service-launchd'].includes(resource.id)
        && owned.kind === resource.kind && owned.target === resource.target
        && owned.ownership.proof === resource.ownership?.proof
        && typeof change.before === 'string' && change.before.length <= 128 * 1024
        && typeof change.after === 'string' && change.after.length <= 128 * 1024
        && digest(change.before) === resource.ownership.installedSha256;
    });
}

export function writeServiceWebEnvironment(changes: readonly ServiceWebEnvironmentChange[], restore = false): InstalledResourceRecord[] {
  return changes.map(({ resource, before, after }) => {
    const text = restore ? before : after;
    if (inspectOwnerOnlyFile(resource.target).status !== 'ok') throw new Error('upgrade-service-environment-unsafe');
    const current = readFileSync(resource.target, 'utf8');
    if (current !== before && current !== after) throw new Error('upgrade-service-environment-drifted');
    atomicWriteOwnerOnly(resource.target, text, { mode: 0o600 });
    return { ...resource, ownership: { ...resource.ownership, installedSha256: digest(text) } };
  });
}
