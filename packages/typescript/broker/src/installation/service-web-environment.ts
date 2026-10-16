import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isInstallerWebPin } from '../runtime/runtime-assets.ts';
import { atomicWriteOwnerOnly, inspectOwnerOnlyFile } from '../security/secure-files.ts';
import { environmentLine, parseBrokerServiceEnvironment, systemdQuote } from './service-manager.ts';
import type { CommittedInstallState, InstalledResourceRecord } from './install-state.ts';

export interface ServiceWebEnvironmentChange {
  resource: InstalledResourceRecord;
  before: string;
  after: string;
}
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
const xml = (text: string): string => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const unxml = (text: string): string => text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

/** Receipt ids whose files an upgrade may rewrite through a journaled before/after pair. */
const JOURNALED_SERVICE_FILE_IDS = ['service-environment', 'service-launchd', 'service-systemd'] as const;

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
  return Array.isArray(value) && value.length <= JOURNALED_SERVICE_FILE_IDS.length
    && new Set(value.map((v) => v?.resource?.id)).size === value.length
    && value.every((change) => {
      const resource = change?.resource;
      const owned = state.resources.find((entry) => entry.id === resource?.id);
      return owned && (JOURNALED_SERVICE_FILE_IDS as readonly string[]).includes(resource.id)
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

/**
 * The service PATH with its runtime directory moved, exactly as setup would have rendered it for the new
 * runtime.
 *
 * Setup writes `[agent dirs..., fixed home dirs..., <application dir>, <runtime dir>, /usr/local/bin,
 * /usr/bin, /bin]`, deduplicated keeping the first occurrence. Everything up to the application directory
 * does not depend on the runtime, so it is kept verbatim -- including the agent directories setup detected,
 * which this process (possibly a transient update unit with a bare environment) must not re-detect. Only
 * the tail is re-derived, and only when it provably is the tail setup wrote for the old runtime; otherwise
 * the new directory is added after the application directory and nothing is removed.
 */
export function moveServicePathRuntime(
  path: string,
  applicationDirectory: string,
  fromRuntimeDirectory: string,
  toRuntimeDirectory: string,
): string {
  const entries = path.split(':').filter(Boolean);
  const tail = ['/usr/local/bin', '/usr/bin', '/bin'];
  const at = entries.indexOf(applicationDirectory);
  if (at >= 0) {
    const prefix = entries.slice(0, at + 1);
    const suffixFor = (directory: string): string[] =>
      [...new Set([directory, ...tail])].filter((entry) => !prefix.includes(entry));
    if (JSON.stringify(entries.slice(at + 1)) === JSON.stringify(suffixFor(fromRuntimeDirectory))) {
      return [...prefix, ...suffixFor(toRuntimeDirectory)].join(':');
    }
  }
  if (entries.includes(toRuntimeDirectory)) return entries.join(':');
  const insertAt = at >= 0 ? at + 1 : 0;
  return [...entries.slice(0, insertAt), toRuntimeDirectory, ...entries.slice(insertAt)].join(':');
}

function systemdArguments(value: string): string[] | undefined {
  const tokens: string[] = [];
  let rest = value;
  while (rest.length > 0) {
    const match = /^"((?:[^"\\]|\\.)*)"(?: |$)/.exec(rest);
    if (!match) return undefined;
    tokens.push(match[1]!.replace(/\\(.)/g, '$1'));
    rest = rest.slice(match[0].length);
  }
  return tokens;
}

/**
 * Point the receipt-owned systemd or launchd service at a new Bun runtime, composed onto any web-pin changes
 * already planned for the same files.
 *
 * Only the three places the runtime appears are touched: the interpreter argument of the launch command
 * (systemd `ExecStart=`, launchd `ProgramArguments`), and its directory in the service PATH (`broker.env`,
 * and the plist's materialized copy). Every other byte -- agent directories, overrides, the web pin -- is
 * carried over unchanged, which is what keeps this a runtime switch rather than a re-run of setup from
 * whatever environment the update happens to run in.
 *
 * Files whose bytes no longer match their receipt are refused before anything is written, as the web-pin
 * planner refuses them, so a rollback can always put back exactly what setup owned. Windows is not handled
 * here: its Scheduled Task and versioned environment move with the service version activation.
 */
export function planServiceRuntimeEnvironment(options: {
  state: CommittedInstallState;
  changes: readonly ServiceWebEnvironmentChange[];
  executablePath: string;
  toRuntime: string;
  platform?: string;
}): { changes: ServiceWebEnvironmentChange[]; fromRuntime?: string } {
  const changes = options.changes.map((change) => ({ ...change }));
  if ((options.platform ?? process.platform) === 'win32') return { changes };
  const definition = options.state.resources.find((entry) => entry.id === 'service-systemd' || entry.id === 'service-launchd');
  if (!definition) return { changes };
  const textOf = (resource: InstalledResourceRecord): string => {
    const planned = changes.find((change) => change.resource.id === resource.id);
    if (planned) return planned.after;
    if (inspectOwnerOnlyFile(resource.target).status !== 'ok') throw new ServiceWebEnvironmentError('upgrade-service-environment-unsafe', resource.target);
    const text = readFileSync(resource.target, 'utf8');
    if (digest(text) !== resource.ownership.installedSha256) throw new ServiceWebEnvironmentError('upgrade-service-environment-drifted', resource.target);
    return text;
  };
  const record = (resource: InstalledResourceRecord, after: string): void => {
    const planned = changes.find((change) => change.resource.id === resource.id);
    if (planned) planned.after = after;
    else changes.push({ resource, before: textOf(resource), after });
  };
  const application = resolve(options.executablePath);
  const invalid = (): never => { throw new ServiceWebEnvironmentError('upgrade-service-runtime-unrecognized', definition.target); };
  const current = textOf(definition);
  let fromRuntime: string;
  let nextDefinition: string;
  if (definition.id === 'service-systemd') {
    const lines = current.split('\n');
    const indexes = lines.flatMap((line, index) => (line.startsWith('ExecStart=') ? [index] : []));
    if (indexes.length !== 1) invalid();
    const line = lines[indexes[0]!]!;
    const argv = systemdArguments(line.slice('ExecStart='.length));
    if (!argv || argv.length !== 3 || argv[2] !== 'broker' || resolve(argv[1]!) !== application
        || line !== `ExecStart=${argv.map(systemdQuote).join(' ')}`) invalid();
    fromRuntime = argv![0]!;
    lines[indexes[0]!] = `ExecStart=${[options.toRuntime, argv![1]!, 'broker'].map(systemdQuote).join(' ')}`;
    nextDefinition = lines.join('\n');
  } else {
    const program = /(<key>ProgramArguments<\/key>\s*<array>)([\s\S]*?)(<\/array>)/.exec(current);
    if (!program) invalid();
    const strings = [...program![2]!.matchAll(/<string>([^<]*)<\/string>/g)].map((match) => unxml(match[1]!));
    if (strings.length !== 3 || strings[2] !== 'broker' || resolve(strings[1]!) !== application) invalid();
    fromRuntime = strings[0]!;
    const body = program![2]!.replace(/<string>[^<]*<\/string>/, () => `<string>${xml(options.toRuntime)}</string>`);
    nextDefinition = current.replace(program![0], () => program![1] + body + program![3]);
    const pathEntry = /(<key>PATH<\/key>\s*<string>)([^<]*)(<\/string>)/.exec(nextDefinition);
    if (pathEntry) {
      const moved = moveServicePathRuntime(unxml(pathEntry[2]!), dirname(application), dirname(fromRuntime), dirname(options.toRuntime));
      nextDefinition = nextDefinition.replace(pathEntry[0], () => pathEntry[1] + xml(moved) + pathEntry[3]);
    }
  }
  if (resolve(fromRuntime) === resolve(options.toRuntime)) return { changes: options.changes.map((change) => ({ ...change })), fromRuntime };
  record(definition, nextDefinition);
  const environment = options.state.resources.find((entry) => entry.id === 'service-environment');
  if (environment) {
    const text = textOf(environment);
    const variables = parseBrokerServiceEnvironment(text);
    if (!variables) throw new ServiceWebEnvironmentError('upgrade-service-environment-invalid', environment.target);
    if (variables.PATH !== undefined) {
      const moved = moveServicePathRuntime(variables.PATH, dirname(application), dirname(fromRuntime), dirname(options.toRuntime));
      const lines = text.split('\n');
      const index = lines.findIndex((line) => line.startsWith('PATH='));
      lines[index] = environmentLine('PATH', moved);
      record(environment, lines.join('\n'));
    }
  }
  return { changes, fromRuntime };
}
