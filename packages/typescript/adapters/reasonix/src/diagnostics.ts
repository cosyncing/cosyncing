import { join } from 'node:path';
import {
  diagnoseBinaryVersion,
  type AgentMinimumVersion,
  type AgentSetupDiagnosis,
  type SetupCheck,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';
import { reasonixStoreRoot } from './store.ts';

/**
 * The 1.x release Drive was first measured against, and the doctor's `>=` floor.
 *
 * Separate from {@link REASONIX_DRIVE_VERSIONS} because those are different claims: `AgentMinimumVersion`
 * is consumed as a `>=` FLOOR by `diagnoseBinaryVersion`, while the Drive gate is an EXACT set. Reading
 * the floor as the gate would hand Drive to every unmeasured 1.x and 2.x release above it.
 */
export const REASONIX_VERIFIED_VERSION = '1.25.2';

/**
 * The final upstream release. Reasonix development has ended and its repository is archived, so no
 * later version exists to measure; this is the version a fresh `npm install -g reasonix` gets.
 */
export const REASONIX_FINAL_UPSTREAM_VERSION = '2.61.0';

/**
 * The exact versions that get Drive, Create and Resume; the runtime gate compares with `===`.
 *
 * 2.61.0 was measured on 2026-11-24 in an isolated home: ACP sessions stay in the global
 * `sessions/<id>.jsonl` store at meta schema 2, event index schema 1 and display index schema 1, and
 * a 1.25.2 session continues on 2.61.0 under the same id and files. 1.x releases after 1.25.2 are
 * different programs for this adapter: 1.39.11 (the last 1.x) writes new sessions to `sessions-v4/`
 * and rewrites a continued 1.25.2 transcript, so they stay Observe-only.
 */
export const REASONIX_DRIVE_VERSIONS: readonly string[] = Object.freeze([
  REASONIX_VERIFIED_VERSION,
  REASONIX_FINAL_UPSTREAM_VERSION,
]);

export function reasonixVersionAllowsDrive(version: string | undefined): boolean {
  return version !== undefined && REASONIX_DRIVE_VERSIONS.includes(version);
}

/** The install a doctor or a refusal recommends: the final release. */
export const REASONIX_INSTALL_COMMAND = `npm install -g reasonix@${REASONIX_FINAL_UPSTREAM_VERSION}`;

/**
 * The version rule, in the one wording doctor, the Drive reason and the Create/Resume refusals share.
 */
export const REASONIX_VERSION_RULE = `Drive, Create and Resume need Reasonix ${REASONIX_FINAL_UPSTREAM_VERSION} `
  + `(the final release) or ${REASONIX_VERIFIED_VERSION}. Other versions are Observe-only: 1.x releases after `
  + `${REASONIX_VERIFIED_VERSION} were not measured, and from 1.38.8 they keep new sessions in a sessions-v4 store `
  + `this adapter does not list; 2.x releases before ${REASONIX_FINAL_UPSTREAM_VERSION} were not measured.`;

export const REASONIX_MINIMUM_VERSION: AgentMinimumVersion = Object.freeze({
  version: REASONIX_VERIFIED_VERSION,
  requiredFeature: 'the ACP stdio create/load/prompt surface and schema-v2 session store used by this adapter',
  evidenceUrl: 'https://reasonix.io/changelog/v1.25.2/',
  evidenceNote: `Exact measured versions: native-contract fixtures and isolated probes were recorded against `
    + `Reasonix ${REASONIX_VERIFIED_VERSION} on 2026-08-27 and ${REASONIX_FINAL_UPSTREAM_VERSION} on 2026-11-24. `
    + `Upstream development has ended. ${REASONIX_VERSION_RULE}`,
});

function storeCheck(context: SetupDiagnosisContext, binaryPresent: boolean): SetupCheck {
  const root = reasonixStoreRoot(context.env, context.homeDir);
  const inspected = context.inspectPath(root);
  if (inspected.status === 'directory' && inspected.readable) {
    const sessions = context.inspectPath(join(root, 'sessions'));
    return {
      id: 'reasonix.storage',
      status: 'pass',
      detailCode: sessions.status === 'directory' && sessions.readable
        ? 'storage-readable'
        : 'storage-root-readable',
      summary: sessions.status === 'directory' && sessions.readable
        ? 'Reasonix local session storage is readable.'
        : 'Reasonix home is readable; no global ACP session directory exists yet.',
      evidence: { path: inspected.displayPath },
    };
  }
  if (inspected.status === 'missing') {
    return {
      id: 'reasonix.storage',
      status: binaryPresent ? 'warn' : 'skip',
      detailCode: 'storage-missing',
      summary: 'Reasonix local session storage is not present yet.',
      evidence: { path: inspected.displayPath },
      ...(binaryPresent ? {
        remediation: { kind: 'manual' as const, message: 'Start Reasonix once, then rerun doctor.' },
      } : {}),
    };
  }
  return {
    id: 'reasonix.storage',
    status: 'fail',
    detailCode: inspected.status === 'unreadable' ? 'storage-unreadable' : 'storage-unsafe-type',
    summary: 'Reasonix local session storage is unreadable or has an unexpected type.',
    evidence: { path: inspected.displayPath },
    remediation: { kind: 'manual', message: 'Repair the Reasonix home permissions or configuration, then rerun doctor.' },
  };
}

export async function diagnoseReasonixSetup(
  context: SetupDiagnosisContext,
): Promise<AgentSetupDiagnosis> {
  const binary = await diagnoseBinaryVersion({
    context,
    checkPrefix: 'reasonix',
    displayName: 'Reasonix',
    command: 'reasonix',
    versionArgs: ['--version'],
    packageNames: ['reasonix'],
    productNames: ['reasonix'],
    preferVersionProbe: true,
    minimum: REASONIX_MINIMUM_VERSION,
    installMessage: `Install Reasonix ${REASONIX_FINAL_UPSTREAM_VERSION}, the final release `
      + `(${REASONIX_INSTALL_COMMAND}), then rerun doctor.`,
    upgradeCommand: REASONIX_INSTALL_COMMAND,
  });
  if (binary.installedVersion && !reasonixVersionAllowsDrive(binary.installedVersion)) {
    const index = binary.checks.findIndex((check) => check.id === 'reasonix.version');
    if (index >= 0) {
      binary.checks[index] = {
        id: 'reasonix.version',
        status: 'fail',
        detailCode: 'version-unverified',
        summary: `Reasonix ${binary.installedVersion} is Observe-only here. Upstream development has ended. `
          + REASONIX_VERSION_RULE,
        evidence: {
          installedVersion: binary.installedVersion,
          verifiedVersion: REASONIX_FINAL_UPSTREAM_VERSION,
          supportedVersions: REASONIX_DRIVE_VERSIONS.join(', '),
        },
        remediation: {
          kind: 'command',
          message: `Install Reasonix ${REASONIX_FINAL_UPSTREAM_VERSION} for Create and Resume, or keep using Observe.`,
          command: REASONIX_INSTALL_COMMAND,
        },
      };
    }
  }
  return {
    agent: 'reasonix',
    displayName: 'Reasonix',
    minimumVersion: REASONIX_MINIMUM_VERSION,
    checks: [...binary.checks, storeCheck(context, !!binary.executable)],
  };
}
