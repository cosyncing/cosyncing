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
 * The one version Drive is measured against, and the only value the runtime
 * gate compares with `===`.
 *
 * Separate from {@link REASONIX_MINIMUM_VERSION} because those are different
 * claims wearing one number: `AgentMinimumVersion` is consumed as a `>=` FLOOR
 * by `diagnoseBinaryVersion`, while the Drive gate is an EXACT pin. Reading the
 * floor as the pin (and writing the pin a third time as a bare literal in the
 * adapter) meant a future bump could move one and silently leave the others.
 */
export const REASONIX_VERIFIED_VERSION = '1.25.2';

export const REASONIX_MINIMUM_VERSION: AgentMinimumVersion = Object.freeze({
  version: REASONIX_VERIFIED_VERSION,
  requiredFeature: 'the ACP stdio create/load/prompt surface and schema-v2 session store used by this adapter',
  evidenceUrl: 'https://reasonix.io/changelog/v1.25.2/',
  evidenceNote: 'Exact measured version: native-contract fixtures and isolated probes were recorded against Reasonix 1.25.2 on 2026-08-27; other versions remain Observe-only and the full physical pass is pending.',
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
    installMessage: 'Install the official Reasonix CLI, then rerun doctor.',
    upgradeCommand: `npm install -g reasonix@${REASONIX_VERIFIED_VERSION}`,
  });
  if (binary.installedVersion && binary.installedVersion !== REASONIX_VERIFIED_VERSION) {
    const index = binary.checks.findIndex((check) => check.id === 'reasonix.version');
    if (index >= 0) {
      binary.checks[index] = {
        id: 'reasonix.version',
        status: 'fail',
        detailCode: 'version-unverified',
        summary: `Reasonix ${binary.installedVersion} is not the native-contract-measured ${REASONIX_VERIFIED_VERSION} build.`,
        evidence: {
          installedVersion: binary.installedVersion,
          verifiedVersion: REASONIX_VERIFIED_VERSION,
        },
        remediation: {
          kind: 'command',
          message: `Install Reasonix ${REASONIX_VERIFIED_VERSION} for Resume/Create, or keep using Observe.`,
          command: `npm install -g reasonix@${REASONIX_VERIFIED_VERSION}`,
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
