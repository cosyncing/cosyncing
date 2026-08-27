/**
 * `cosyncing doctor` for Antigravity.
 *
 * Exists because REGISTRATION requires it. `shippedAdapters()` is the one list
 * doctor diagnoses and the service environment activates, and an adapter on that
 * list with no `diagnoseSetup` does not degrade quietly — `diagnoseAgents`
 * synthesizes a hard `fail` (`adapter-diagnosis-missing`) whose remediation tells
 * the operator to "update cosyncing to a build with complete adapter diagnosis",
 * i.e. to install a build that does not exist. Every other shipped adapter
 * answers with `warn`/`skip` on a machine where its CLI is simply absent, and agy
 * must answer the same way.
 *
 * Two facts, and only the two this adapter actually depends on:
 *
 *  - THE BINARY, because `attach('resume')` refuses without it and every row's
 *    `terminalSyncHint` is a command that would not run.
 *  - THE CLI APP-DATA ROOT, because discovery is file-backed and reads nothing
 *    else. Its absence is the ordinary state of a host where the IDE is
 *    installed and the CLI has never run — a `skip`, not a fault.
 *
 * There is no host check, no port probe and no managed-runtime check, because
 * there is no daemon: nothing listens between invocations (MEASURED `ss -ltnp`
 * + `ps`, 2026-08-21), so there is nothing for a diagnosis to reach.
 */
import {
  diagnoseBinaryVersion,
  type AgentMinimumVersion,
  type AgentSetupDiagnosis,
  type SetupCheck,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';
import { defaultAgyRoots } from './store.ts';

/**
 * The floor is THE VERSION THIS REPOSITORY MEASURED, not an inferred earlier one.
 *
 * 1.1.13 had no drive surface at all — the CLI grew one somewhere between it and
 * 1.1.17, during a fifteen-minute read-only probe — so a floor guessed backwards
 * would admit a binary that cannot do the thing the adapter is for. 1.1.17 is
 * where the stream-json envelope was captured, and 1.1.20 re-ran the same probe
 * unchanged.
 *
 * `evidenceUrl` is EMPTY on purpose. Antigravity publishes no release page this
 * floor could cite, and citing a plausible-looking one would be inventing the
 * evidence the field exists to carry. `agy changelog` is upstream's own surface
 * and it has already been wrong about upstream's own wire (1.1.17 announced
 * `models --output-format json` and rejected the flag), so the note records what
 * was measured here instead.
 */
export const AGY_MINIMUM_VERSION: AgentMinimumVersion = Object.freeze({
  version: '1.1.17',
  requiredFeature:
    'the `--output-format=stream-json --input-format=stream-json` drive surface and the '
    + '`brain/<id>/.system_generated/logs/transcript.jsonl` transcript Observe replays and tails',
  evidenceUrl: '',
  evidenceNote:
    'Conservative floor: the exact version whose wire this repository captured. 1.1.13 shipped no drive '
    + 'surface, so an earlier floor would admit a binary that cannot be driven; 1.1.17 is where the '
    + 'stream-json envelope was measured and 1.1.20 reproduced it unchanged. The binary replaces itself '
    + 'with no user action, so every wire claim in this adapter carries the version it was measured on.',
});

/** Is the CLI's app-data root there, and readable? Discovery reads nothing else. */
function appDataCheck(context: SetupDiagnosisContext, binaryPresent: boolean): SetupCheck {
  const path = defaultAgyRoots(context.homeDir).appData;
  const inspection = context.inspectPath(path);
  if (inspection.status === 'directory' && inspection.readable) {
    return {
      id: 'agy.store',
      status: 'pass',
      detailCode: 'store-readable',
      summary: 'Antigravity CLI conversation storage is readable.',
      evidence: { path: inspection.displayPath },
    };
  }
  if (inspection.status === 'missing') {
    // Not a fault. The IDE and the CLI share a product and not a store, so this
    // is exactly what a host looks like where only the IDE has ever run.
    return {
      id: 'agy.store',
      status: binaryPresent ? 'warn' : 'skip',
      detailCode: 'store-missing',
      summary: 'Antigravity CLI conversation storage is not present yet.',
      evidence: { path: inspection.displayPath },
      ...(binaryPresent
        ? { remediation: { kind: 'manual' as const, message: 'Run `agy` once to create its conversation store.' } }
        : {}),
    };
  }
  return {
    id: 'agy.store',
    status: 'fail',
    detailCode: inspection.status === 'unreadable' ? 'store-unreadable' : 'store-unsafe-type',
    summary: 'Antigravity CLI conversation storage is unreadable or has an unexpected type.',
    evidence: { path: inspection.displayPath },
    remediation: { kind: 'manual', message: 'Restore read access to the Antigravity CLI app-data directory.' },
  };
}

export async function diagnoseAgySetup(context: SetupDiagnosisContext): Promise<AgentSetupDiagnosis> {
  const binary = await diagnoseBinaryVersion({
    context,
    checkPrefix: 'agy',
    displayName: 'Antigravity',
    command: 'agy',
    // `--version` is a read-only probe run through the diagnosis seam's own
    // timeout, and only ever after the executable resolved. It is the ONLY place
    // this adapter invokes `agy`: `isAvailable()` deliberately does not, because
    // that runs on every roster sweep and each invocation pays a workspace init.
    versionArgs: ['--version'],
    minimum: AGY_MINIMUM_VERSION,
    installMessage: 'Install the Antigravity CLI and make `agy` available on PATH, then rerun doctor.',
    upgradeCommand: 'agy update',
  });
  return {
    agent: 'agy',
    displayName: 'Antigravity',
    minimumVersion: AGY_MINIMUM_VERSION,
    checks: [...binary.checks, appDataCheck(context, binary.executable !== undefined)],
  };
}
