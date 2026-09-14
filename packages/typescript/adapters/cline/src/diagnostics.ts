import { join } from 'node:path';
import {
  diagnoseBinaryVersion,
  type AgentMinimumVersion,
  type AgentSetupDiagnosis,
  type SetupCheck,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';
import { CLINE_HUB_CORE_MINIMUM_VERSION } from './hub.ts';
import {
  CLINE_MEASURED_VERSIONS,
  CLINE_MINIMUM_SUPPORTED_VERSION,
  CLINE_OBSERVE_VERSIONS,
  CLINE_VERIFIED_VERSION,
  clineDataRoot,
  clineVersionStanding,
} from './store.ts';

export const CLINE_MINIMUM_VERSION: AgentMinimumVersion = Object.freeze({
  // The FLOOR, which is now DERIVED rather than chosen: the lowest measured CLI
  // whose own `@cline/core` clears the Hub floor. That currently coincides with
  // `CLINE_VERIFIED_VERSION` at 3.0.61, but the two answer different questions
  // -- VERIFIED names the newest snapshot FORMAT this adapter reads -- so this
  // must keep reading the floor. Naming the format constant here once told
  // operators the minimum was 3.0.61 while 3.0.60 was still accepted.
  version: CLINE_MINIMUM_SUPPORTED_VERSION,
  requiredFeature: 'the rewritten session/message snapshot layout used by the Observe adapter',
  evidenceUrl: 'https://docs.cline.bot/cline-cli/overview',
  evidenceNote: `Physically measured: ${CLINE_MEASURED_VERSIONS.join(', ')}. Local store plus OpenAI-compatible CLI and ACP surfaces were recorded against Cline 3.0.60 on 2026-08-30/31; 3.0.61 followed on 2026-09-08 after Cline self-updated. Newer builds are supported without being enumerated -- the ACP protocol major, Hub protocol v1, Hub epoch and app-created ownership each fail closed on their own. Snapshot FORMATS remain enumerated (${CLINE_OBSERVE_VERSIONS.join(', ')}), so sessions written by a newer build are not replayed until captured.`,
});

function storageCheck(context: SetupDiagnosisContext, binaryPresent: boolean): SetupCheck {
  const root = clineDataRoot(context.env, context.homeDir);
  const inspected = context.inspectPath(root);
  if (inspected.status === 'directory' && inspected.readable) {
    const sessions = context.inspectPath(join(root, 'sessions'));
    return {
      id: 'cline.storage',
      status: 'pass',
      detailCode: sessions.status === 'directory' && sessions.readable
        ? 'storage-readable'
        : 'storage-root-readable',
      summary: sessions.status === 'directory' && sessions.readable
        ? 'Cline local session storage is readable.'
        : 'Cline data root is readable; no session directory exists yet.',
      evidence: { path: inspected.displayPath },
    };
  }
  if (inspected.status === 'missing') {
    return {
      id: 'cline.storage',
      status: binaryPresent ? 'warn' : 'skip',
      detailCode: 'storage-missing',
      summary: 'Cline local session storage is not present yet.',
      evidence: { path: inspected.displayPath },
      ...(binaryPresent ? {
        remediation: { kind: 'manual' as const, message: 'Start one Cline CLI session, then rerun doctor.' },
      } : {}),
    };
  }
  return {
    id: 'cline.storage',
    status: 'fail',
    detailCode: inspected.status === 'unreadable' ? 'storage-unreadable' : 'storage-unsafe-type',
    summary: 'Cline local session storage is unreadable or has an unexpected type.',
    evidence: { path: inspected.displayPath },
    remediation: { kind: 'manual', message: 'Repair the Cline data-directory permissions or configuration, then rerun doctor.' },
  };
}

export async function diagnoseClineSetup(context: SetupDiagnosisContext): Promise<AgentSetupDiagnosis> {
  const command = context.env.COSYNCING_CLINE_BIN?.trim() || 'cline';
  const binary = await diagnoseBinaryVersion({
    context,
    checkPrefix: 'cline',
    displayName: 'Cline',
    command,
    versionArgs: ['--version'],
    versionProbeEnv: { CLINE_NO_AUTO_UPDATE: '1' },
    packageNames: ['cline', '@cline/cli', '@cline/core'],
    productNames: ['cline'],
    preferVersionProbe: true,
    minimum: CLINE_MINIMUM_VERSION,
    installMessage: `Install Cline CLI ${CLINE_MINIMUM_SUPPORTED_VERSION} or newer, then rerun doctor.`,
    upgradeCommand: 'npm install -g cline',
  });
  const standing = clineVersionStanding(binary.installedVersion);
  // Cline differs from the other floored adapters: a newer build may Drive, but
  // snapshots it WRITES carry its own version and stay unreadable until that
  // format is captured, because `CLINE_OBSERVE_VERSIONS` enumerates on-disk
  // formats rather than ordering them. So this stays a warning even though
  // Drive is unaffected — the consequence is real and the operator can act on
  // it, unlike a bare "unmeasured version" notice.
  if (binary.installedVersion && standing !== 'measured') {
    const index = binary.checks.findIndex((check) => check.id === 'cline.version');
    if (index >= 0) {
      binary.checks[index] = standing === 'newer-unmeasured'
        ? {
          id: 'cline.version',
          status: 'warn',
          detailCode: 'version-newer-snapshots-unread',
          summary: `Cline ${binary.installedVersion} is newer than the measured baseline (${CLINE_MEASURED_VERSIONS.join(', ')}). Create, Drive and Resume remain available; snapshots newly written by this version are not replayed until its format is captured.`,
          evidence: {
            installedVersion: binary.installedVersion,
            measuredVersions: CLINE_MEASURED_VERSIONS.join(', '),
            observableSnapshotVersions: CLINE_OBSERVE_VERSIONS.join(', '),
          },
          remediation: {
            kind: 'manual',
            message: `Capture the snapshot contract for ${binary.installedVersion} to restore replay of sessions it writes.`,
          },
        }
        // `unreadable` is refused by every gate exactly like `below-floor`, but
        // it is NOT the same fact and must not borrow its wording: a version
        // this reader cannot parse (build metadata, a `v` prefix, two parts)
        // may well be newer, and telling the operator it is "older" sends them
        // to a remediation that cannot help.
        : standing === 'unreadable'
          ? {
            id: 'cline.version',
            status: 'warn',
            detailCode: 'version-unreadable',
            summary: `Cline reported a version this reader cannot compare (${binary.installedVersion}); Create, Drive and Resume stay disabled because the floor ${CLINE_MINIMUM_SUPPORTED_VERSION} cannot be confirmed.`,
            evidence: { installedVersion: binary.installedVersion, minimumVersion: CLINE_MINIMUM_SUPPORTED_VERSION },
            remediation: {
              kind: 'manual',
              message: `Install a Cline build whose \`--version\` reports a plain MAJOR.MINOR.PATCH at or above ${CLINE_MINIMUM_SUPPORTED_VERSION}.`,
            },
          }
          // A build that IS measured but sits below the derived floor gets its
          // own wording. Reporting 3.0.60 as "older than the measured floor"
          // contradicted the same report's own evidence note, which lists it as
          // measured, and hid the actual reason: Drive runs through the managed
          // Hub and 3.0.60 ships a `@cline/core` below the Hub floor. Observe is
          // unaffected, and saying so is the difference between a version that
          // is unusable and one that is merely not drivable.
          : CLINE_MEASURED_VERSIONS.includes(binary.installedVersion)
            ? {
              id: 'cline.version',
              status: 'warn',
              detailCode: 'version-below-hub-core-floor',
              summary: `Cline ${binary.installedVersion} is measured, but the Hub it ships is older than the ${CLINE_HUB_CORE_MINIMUM_VERSION} Hub core that Create, Drive and Resume run through; Observe is unaffected.`,
              evidence: {
                installedVersion: binary.installedVersion,
                minimumVersion: CLINE_MINIMUM_SUPPORTED_VERSION,
                hubCoreMinimumVersion: CLINE_HUB_CORE_MINIMUM_VERSION,
              },
              remediation: {
                kind: 'manual',
                message: `Update Cline to ${CLINE_MINIMUM_SUPPORTED_VERSION} or newer to enable Create, Drive and Resume. Observe keeps working on ${binary.installedVersion}.`,
              },
            }
            : {
              id: 'cline.version',
              status: 'warn',
              detailCode: 'version-below-measured-floor',
              summary: `Cline ${binary.installedVersion} is older than the measured floor ${CLINE_MINIMUM_SUPPORTED_VERSION}; Create, Drive and Resume stay disabled.`,
              evidence: { installedVersion: binary.installedVersion, minimumVersion: CLINE_MINIMUM_SUPPORTED_VERSION },
              remediation: {
                kind: 'manual',
                message: `Update Cline to ${CLINE_MINIMUM_SUPPORTED_VERSION} or newer to enable Create, Drive and Resume.`,
              },
            };
    }
  }
  return {
    agent: 'cline',
    displayName: 'Cline',
    minimumVersion: CLINE_MINIMUM_VERSION,
    checks: [...binary.checks, storageCheck(context, !!binary.executable)],
  };
}
