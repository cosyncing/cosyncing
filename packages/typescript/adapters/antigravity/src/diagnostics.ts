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
 * Three facts, and only the ones this adapter actually depends on:
 *
 *  - THE BINARY, because `attach('resume')` refuses without it and every row's
 *    `terminalSyncHint` is a command that would not run.
 *  - THE CLI APP-DATA ROOT, because discovery is file-backed and reads nothing
 *    else. Its absence is the ordinary state of a host where the IDE is
 *    installed and the CLI has never run — a `skip`, not a fault.
 *  - THE SAVED SIGN-IN, as agy's own newest run log reports it (AG-3). When agy
 *    cannot restore it, its model list times out and Create is unavailable, and
 *    nothing else on the host says why. Read from the log, never by running agy:
 *    doctor's shell is not the service's, and a run from here could succeed
 *    where the broker's fails.
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
import { basename, dirname, join } from 'node:path';
import { AGY_NO_AUTO_UPDATE_ENV } from './cli-catalog.ts';
import { AGY_CLI_LOG_MAX_BYTES, AGY_CLI_LOG_NAME, classifyAgyCliLogSignIn, defaultAgyRoots } from './store.ts';

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

/** Proxy variables a shell may route agy's sign-in refresh through. Only whether one is SET is used. */
const AGY_PROXY_VARIABLES = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];

/**
 * The newest agy run log, as doctor's read-only context can reach it:
 * `<appData>/cli.log` links to `log/cli-<stamp>.log` (MEASURED 1.5.14), and only
 * a link of that shape is followed. Undefined when there is no such log.
 */
function readLatestCliLog(context: SetupDiagnosisContext): { text: string; path: string } | undefined {
  const appData = defaultAgyRoots(context.homeDir).appData;
  const link = context.inspectPath(join(appData, 'cli.log')).link;
  if (!link || link.status !== 'file' || !link.readable) return undefined;
  const path = link.resolvedPath;
  if (basename(dirname(path)) !== 'log' || !AGY_CLI_LOG_NAME.test(basename(path))) return undefined;
  const read = context.readTextPrefix?.(path, AGY_CLI_LOG_MAX_BYTES) ?? context.readText(path, AGY_CLI_LOG_MAX_BYTES);
  return read.ok ? { text: read.text, path } : undefined;
}

/**
 * Did agy's last run restore its saved sign-in? (AG-3)
 *
 * MEASURED 2026-11-23: agy's access token expired on 2026-10-29 and 182 of the
 * 186 runs since 2026-11-20 — the broker's own `agy models`, every 15 minutes —
 * logged `keyringAuth: timed out after 10s` and were killed at the broker's 15 s
 * limit, so the app's model list froze and Create had no working child. The
 * refresh request to Google's token endpoint never completed from the service:
 * on that host a direct connection to it timed out while the shell's HTTP(S)
 * proxy reached it, and the cosyncing service environment carries no proxy
 * variables. So the check says to sign in, and names the proxy when this shell
 * sets one.
 */
function signInCheck(
  context: SetupDiagnosisContext,
  log: { text: string; path: string } | undefined,
  binaryPresent: boolean,
): SetupCheck {
  if (!binaryPresent) {
    return {
      id: 'agy.sign-in',
      status: 'skip',
      detailCode: 'sign-in-not-checked',
      summary: 'Antigravity sign-in was not checked because the agy binary is missing.',
    };
  }
  const evidence = log ? classifyAgyCliLogSignIn(log.text) : undefined;
  if (!log || !evidence) {
    return {
      id: 'agy.sign-in',
      status: 'skip',
      detailCode: 'sign-in-unknown',
      summary: 'Antigravity\'s newest run log does not say whether its saved sign-in was restored.',
    };
  }
  const shown = { log: context.displayPath(log.path) };
  if (evidence.state === 'restored') {
    return {
      id: 'agy.sign-in',
      status: 'pass',
      detailCode: 'sign-in-restored',
      summary: 'Antigravity restored its saved sign-in on its last run.',
      evidence: shown,
    };
  }
  const proxy = AGY_PROXY_VARIABLES.some((name) => Boolean(context.env[name]?.trim()));
  return {
    id: 'agy.sign-in',
    status: 'warn',
    detailCode: 'sign-in-not-restored',
    summary: 'Antigravity could not restore its saved sign-in on its last run, so its model list fails and '
      + 'new Antigravity sessions cannot be created from the app.',
    evidence: { ...shown, networkError: evidence.networkError, shellProxy: proxy },
    remediation: {
      kind: 'manual',
      message: 'Run `agy` in a terminal and sign in again.'
        + (proxy
          ? ' This shell sets an HTTP(S) proxy, and the cosyncing service does not inherit proxy settings, so agy '
            + 'started by the service may still be unable to refresh its sign-in.'
          : evidence.networkError
            ? ' agy reported a network error reaching Google\'s sign-in service; check that this machine can reach it.'
            : ''),
    },
  };
}

export async function diagnoseAgySetup(context: SetupDiagnosisContext): Promise<AgentSetupDiagnosis> {
  // Read BEFORE the version probe below: agy may repoint `cli.log` at a log of
  // its own for that run, and this check is about the runs the broker made.
  let log: { text: string; path: string } | undefined;
  try {
    log = readLatestCliLog(context);
  } catch {
    log = undefined;
  }
  const binary = await diagnoseBinaryVersion({
    context,
    checkPrefix: 'agy',
    displayName: 'Antigravity',
    command: 'agy',
    // `--version` is a read-only probe run through the diagnosis seam's own
    // timeout, and only ever after the executable resolved. `isAvailable()`
    // deliberately never runs agy, because that runs on every roster sweep and
    // each invocation pays a workspace init; the broker's other execution is
    // the TTL'd `agy models` list (`cli-catalog.ts`). SP-1: agy updates itself
    // in the background on ordinary invocations, so the probe disables that.
    versionArgs: ['--version'],
    versionProbeEnv: AGY_NO_AUTO_UPDATE_ENV,
    minimum: AGY_MINIMUM_VERSION,
    installMessage: 'Install the Antigravity CLI and make `agy` available on PATH, then rerun doctor.',
    upgradeCommand: 'agy update',
  });
  return {
    agent: 'agy',
    displayName: 'Antigravity',
    minimumVersion: AGY_MINIMUM_VERSION,
    checks: [
      ...binary.checks,
      appDataCheck(context, binary.executable !== undefined),
      signInCheck(context, log, binary.executable !== undefined),
    ],
  };
}
