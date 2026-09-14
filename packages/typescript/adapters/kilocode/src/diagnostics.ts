import { join, parse, sep } from 'node:path';
import {
  diagnoseBinaryVersion,
  type AgentMinimumVersion,
  type AgentSetupDiagnosis,
  type SetupCheck,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';
import { KILO_MAX_DATA_ROOT_ENTRIES, kiloDataRoot } from './store.ts';
import {
  KILO_MEASURED_VERSIONS,
  KILO_MINIMUM_SUPPORTED_VERSION,
  kiloVersionStanding,
} from './version.ts';

function preferredDatabaseName(names: readonly string[]): string | undefined {
  const kilo = names.filter((name) => name === 'kilo.db' || /^kilo-[a-z0-9._-]+\.db$/iu.test(name));
  const legacy = names.filter((name) => name === 'opencode.db' || /^opencode-[a-z0-9._-]+\.db$/iu.test(name));
  const candidates = kilo.length > 0 ? kilo : legacy;
  return [...candidates].sort((left, right) => {
    if (left === 'kilo.db' || left === 'opencode.db') return -1;
    if (right === 'kilo.db' || right === 'opencode.db') return 1;
    return left.localeCompare(right);
  })[0];
}

export const KILO_MINIMUM_VERSION: AgentMinimumVersion = Object.freeze({
  version: KILO_MINIMUM_SUPPORTED_VERSION,
  requiredFeature: 'bounded SQLite Observe plus authenticated managed HTTP/SSE Create and Drive',
  evidenceUrl: 'https://kilocode.ai/docs/',
  evidenceNote: `Physically measured: ${KILO_MEASURED_VERSIONS.join(', ')}. SQLite, CLI, serve, Basic-auth health, Create, Drive, permission, model, and lineage evidence was recorded against Kilo Code 7.4.23 on 2026-08-23/30/31. Newer builds are supported without being enumerated: the SQLite schema, server health and credential checks each fail closed on their own. Builds below ${KILO_MINIMUM_SUPPORTED_VERSION} remain Observe-only.`,
});

function storageCheck(context: SetupDiagnosisContext, binaryPresent: boolean): SetupCheck {
  const root = kiloDataRoot(context.env, context.homeDir);
  const inspected = context.inspectPath(root);
  if (inspected.status === 'directory' && inspected.readable) {
    const parsed = parse(root);
    let component = parsed.root;
    for (const segment of root.slice(parsed.root.length).split(sep).filter(Boolean)) {
      component = join(component, segment);
      const componentInspection = context.inspectPath(component);
      if (['file', 'socket', 'other'].includes(componentInspection.status)) return {
        id: 'kilo.storage', status: 'fail', detailCode: 'storage-unsafe-component',
        summary: 'The Kilo Code data-root path contains a symlink or non-directory component that runtime discovery refuses.',
        evidence: { path: componentInspection.displayPath },
        remediation: { kind: 'manual', message: 'Configure KILO_DATA_DIR with a direct, non-symlinked directory path, then rerun doctor.' },
      };
    }
    const listing = context.listDirectory(root, KILO_MAX_DATA_ROOT_ENTRIES);
    const names = listing.ok && !listing.truncated ? listing.names : [];
    const database = preferredDatabaseName(names);
    const databaseInspection = database ? context.inspectPath(join(root, database)) : undefined;
    if (database && (databaseInspection?.status !== 'file' || !databaseInspection.readable)) return {
      id: 'kilo.storage', status: 'fail', detailCode: 'storage-unsafe-type',
      summary: 'The selected Kilo Code database is unreadable or has an unexpected type.',
      evidence: { path: databaseInspection?.displayPath ?? join(inspected.displayPath, database) },
      remediation: { kind: 'manual', message: 'Repair the Kilo Code database type or permissions, then rerun doctor.' },
    };
    return {
      id: 'kilo.storage',
      status: database ? 'pass' : binaryPresent ? 'warn' : 'skip',
      detailCode: database ? 'storage-readable' : 'storage-database-missing',
      summary: database
        ? 'Kilo Code SQLite session storage is readable.'
        : 'Kilo Code data root is readable, but no supported database is present.',
      evidence: { path: inspected.displayPath, ...(database ? { database: join(inspected.displayPath, database) } : {}) },
    };
  }
  if (inspected.status === 'missing') return {
    id: 'kilo.storage', status: binaryPresent ? 'warn' : 'skip', detailCode: 'storage-missing',
    summary: 'Kilo Code local session storage is not present yet.', evidence: { path: inspected.displayPath },
  };
  return {
    id: 'kilo.storage', status: 'fail',
    detailCode: inspected.status === 'unreadable' ? 'storage-unreadable' : 'storage-unsafe-type',
    summary: 'Kilo Code local session storage is unreadable or has an unexpected type.',
    evidence: { path: inspected.displayPath },
    remediation: { kind: 'manual', message: 'Repair the Kilo Code data-directory permissions or configuration, then rerun doctor.' },
  };
}

export async function diagnoseKiloSetup(context: SetupDiagnosisContext): Promise<AgentSetupDiagnosis> {
  const command = context.env.COSYNCING_KILO_BIN?.trim() || 'kilo';
  const binary = await diagnoseBinaryVersion({
    context, checkPrefix: 'kilo', displayName: 'Kilo Code', command,
    versionArgs: ['--version'], packageNames: ['kilo', '@kilocode/cli'],
    // Doctor and setup spawn this probe too, and an unguarded `--version`
    // here is the same class of gap as an unguarded runtime child --
    // `diagnoseBinaryVersion` runs it on every doctor and every setup.
    versionProbeEnv: { KILO_DISABLE_AUTOUPDATE: '1' },
    productNames: ['kilo', 'kilocode'], preferVersionProbe: true,
    minimum: KILO_MINIMUM_VERSION,
    installMessage: `Install Kilo Code CLI ${KILO_MINIMUM_SUPPORTED_VERSION} or newer, then rerun doctor.`,
    upgradeCommand: 'npm install -g @kilocode/cli',
  });
  const standing = kiloVersionStanding(binary.installedVersion);
  // A newer build passes rather than warning. Kilo ships through npm, so an
  // ordinary `npm update -g` would otherwise raise a warning the operator can
  // do nothing useful about.
  if (binary.installedVersion && standing !== 'measured') {
    const index = binary.checks.findIndex((check) => check.id === 'kilo.version');
    if (index >= 0) binary.checks[index] = standing === 'newer-unmeasured'
      ? {
        id: 'kilo.version', status: 'pass', detailCode: 'version-newer-than-measured',
        summary: `Kilo Code CLI ${binary.installedVersion} is newer than the measured baseline (${KILO_MEASURED_VERSIONS.join(', ')}); Observe, Create and Drive remain available, and the SQLite schema and server health are checked at use.`,
        evidence: { installedVersion: binary.installedVersion, measuredVersions: KILO_MEASURED_VERSIONS.join(', ') },
      }
      // `unreadable` is refused like `below-floor` but is a different fact: a
      // version this reader cannot compare may well be NEWER, so reporting it
      // as "older" points the operator at a remediation that cannot help.
      : standing === 'unreadable' ? {
        id: 'kilo.version', status: 'warn', detailCode: 'version-unreadable',
        summary: `Kilo Code CLI reported a version this reader cannot compare (${binary.installedVersion}); compatible SQLite sessions remain observable, but managed Create and Drive stay disabled because the floor ${KILO_MINIMUM_SUPPORTED_VERSION} cannot be confirmed.`,
        evidence: { installedVersion: binary.installedVersion, minimumVersion: KILO_MINIMUM_SUPPORTED_VERSION },
        remediation: {
          kind: 'manual',
          message: `Install a Kilo Code CLI whose \`--version\` reports a plain MAJOR.MINOR.PATCH at or above ${KILO_MINIMUM_SUPPORTED_VERSION}.`,
        },
      } : {
        id: 'kilo.version', status: 'warn', detailCode: 'version-below-measured-floor',
        summary: `Kilo Code CLI ${binary.installedVersion} is older than the measured floor ${KILO_MINIMUM_SUPPORTED_VERSION}; compatible SQLite sessions remain observable, but managed Create and Drive stay disabled.`,
        evidence: { installedVersion: binary.installedVersion, minimumVersion: KILO_MINIMUM_SUPPORTED_VERSION },
        remediation: {
          kind: 'manual',
          message: `Update Kilo Code to ${KILO_MINIMUM_SUPPORTED_VERSION} or newer to enable managed Create and Drive.`,
        },
      };
  }
  const portState = await context.probeTcp('127.0.0.1', 4097);
  const port: SetupCheck = portState === 'open'
    ? {
        id: 'kilo.port-4097', status: 'pass', detailCode: 'managed-port-listening',
        summary: 'The dedicated Kilo Code managed-host port is listening; runtime will still require exact authenticated health and ownership.',
      }
    : portState === 'closed' ? {
        id: 'kilo.port-4097', status: 'skip', detailCode: 'managed-port-clear',
        summary: 'The dedicated Kilo Code managed-host port is clear and can be started by the broker when Drive is requested.',
      } : {
        id: 'kilo.port-4097', status: 'warn', detailCode: 'managed-port-unknown',
        summary: 'The dedicated Kilo Code managed-host port could not be checked; runtime ownership remains fail-closed.',
      };
  return {
    agent: 'kilo', displayName: 'Kilo Code', minimumVersion: KILO_MINIMUM_VERSION,
    checks: [...binary.checks, storageCheck(context, !!binary.executable), port],
  };
}
