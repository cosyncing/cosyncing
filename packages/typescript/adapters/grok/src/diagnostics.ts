import { join } from 'node:path';
import {
  diagnoseBinaryVersion,
  type AgentMinimumVersion,
  type AgentSetupDiagnosis,
  type SetupCheck,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';
import {
  GROK_MEASURED_VERSIONS,
  GROK_MINIMUM_SUPPORTED_VERSION,
  grokStoreRoot,
  grokVersionStanding,
} from './store.ts';

export const GROK_MINIMUM_VERSION: AgentMinimumVersion = Object.freeze({
  version: GROK_MINIMUM_SUPPORTED_VERSION,
  requiredFeature: 'bounded local-store Observe plus cached-token authenticated ACP Create/Resume',
  evidenceUrl: 'https://grok.com/',
  evidenceNote: `Physically measured: ${GROK_MEASURED_VERSIONS.join(', ')}. Local store plus authenticated ACP initialize/create/load/prompt evidence was recorded against 1.0.13 on 2026-08-31; 1.0.24 was compared against it on 2026-09-09 and matched on every contract point the adapter reads. Newer builds are supported without being enumerated here — Grok updates itself, so the protocol, authentication, store-shape and ownership checks each fail closed on their own rather than gating on a version list.`,
});

function storeCheck(context: SetupDiagnosisContext, binaryPresent: boolean): SetupCheck {
  const root = grokStoreRoot(context.env, context.homeDir);
  const inspected = context.inspectPath(root);
  if (inspected.status === 'directory' && inspected.readable) {
    const sessions = context.inspectPath(join(root, 'sessions'));
    return {
      id: 'grok.storage',
      status: 'pass',
      detailCode: sessions.status === 'directory' && sessions.readable
        ? 'storage-readable'
        : 'storage-root-readable',
      summary: sessions.status === 'directory' && sessions.readable
        ? 'Grok local session storage is readable.'
        : 'Grok home is readable; no session directory exists yet.',
      evidence: { path: inspected.displayPath },
    };
  }
  if (inspected.status === 'missing') {
    return {
      id: 'grok.storage',
      status: binaryPresent ? 'warn' : 'skip',
      detailCode: 'storage-missing',
      summary: 'Grok local session storage is not present yet.',
      evidence: { path: inspected.displayPath },
      ...(binaryPresent ? {
        remediation: { kind: 'manual' as const, message: 'Start Grok once, then rerun doctor.' },
      } : {}),
    };
  }
  return {
    id: 'grok.storage',
    status: 'fail',
    detailCode: inspected.status === 'unreadable' ? 'storage-unreadable' : 'storage-unsafe-type',
    summary: 'Grok local session storage is unreadable or has an unexpected type.',
    evidence: { path: inspected.displayPath },
    remediation: { kind: 'manual', message: 'Repair the Grok home permissions or configuration, then rerun doctor.' },
  };
}

export async function diagnoseGrokSetup(context: SetupDiagnosisContext): Promise<AgentSetupDiagnosis> {
  const command = context.env.COSYNCING_GROK_BIN?.trim() || 'grok';
  const binary = await diagnoseBinaryVersion({
    context,
    checkPrefix: 'grok',
    displayName: 'Grok Build',
    command,
    versionArgs: ['--version'],
    // Doctor and setup spawn this probe too, and an unguarded `--version`
    // here is the same class of gap as an unguarded runtime child --
    // `diagnoseBinaryVersion` runs it on every doctor and every setup.
    versionProbeEnv: { GROK_DISABLE_AUTOUPDATER: '1' },
    packageNames: ['grok'],
    productNames: ['grok'],
    preferVersionProbe: true,
    minimum: GROK_MINIMUM_VERSION,
    installMessage: 'Install the official Grok Build CLI, then rerun doctor.',
    upgradeCommand: 'grok update',
  });
  const standing = grokVersionStanding(binary.installedVersion);
  // A build NEWER than the measured baseline keeps Drive and reports `pass`.
  // Warning on it would fire for every ordinary Grok self-update, which trains
  // the operator to ignore the one case that matters — a build too old to carry
  // the capabilities Drive needs, which no downstream check can detect.
  if (binary.installedVersion && standing !== 'measured') {
    const index = binary.checks.findIndex((check) => check.id === 'grok.version');
    if (index >= 0) {
      binary.checks[index] = standing === 'newer-unmeasured'
        ? {
          id: 'grok.version',
          status: 'pass',
          detailCode: 'version-newer-than-measured',
          summary: `Grok Build ${binary.installedVersion} is newer than the measured baseline (${GROK_MEASURED_VERSIONS.join(', ')}); Observe, Create and Resume remain available and the ACP contract is checked at child start.`,
          evidence: { installedVersion: binary.installedVersion, measuredVersions: GROK_MEASURED_VERSIONS.join(', ') },
        }
        // `unreadable` is refused like `below-floor` but is a different fact: a
        // version this reader cannot compare may well be NEWER, so reporting it
        // as "older" points the operator at a remediation that cannot help.
        : standing === 'unreadable'
          ? {
            id: 'grok.version',
            status: 'warn',
            detailCode: 'version-unreadable',
            summary: `Grok Build reported a version this reader cannot compare (${binary.installedVersion}); bounded Observe remains available, but Create and Resume stay disabled because the floor ${GROK_MINIMUM_SUPPORTED_VERSION} cannot be confirmed.`,
            evidence: { installedVersion: binary.installedVersion, minimumVersion: GROK_MINIMUM_SUPPORTED_VERSION },
            remediation: {
              kind: 'manual',
              message: `Install a Grok Build whose \`--version\` reports a plain MAJOR.MINOR.PATCH at or above ${GROK_MINIMUM_SUPPORTED_VERSION}.`,
            },
          }
          : {
            id: 'grok.version',
            status: 'warn',
            detailCode: 'version-below-measured-floor',
            summary: `Grok Build ${binary.installedVersion} is older than the measured floor ${GROK_MINIMUM_SUPPORTED_VERSION}; bounded Observe remains available, but Create and Resume stay disabled.`,
            evidence: { installedVersion: binary.installedVersion, minimumVersion: GROK_MINIMUM_SUPPORTED_VERSION },
            remediation: {
              kind: 'manual',
              message: `Update Grok Build to ${GROK_MINIMUM_SUPPORTED_VERSION} or newer to enable Create and Resume.`,
            },
          };
    }
  }
  return {
    agent: 'grok',
    displayName: 'Grok Build',
    minimumVersion: GROK_MINIMUM_VERSION,
    checks: [...binary.checks, storeCheck(context, !!binary.executable)],
  };
}
