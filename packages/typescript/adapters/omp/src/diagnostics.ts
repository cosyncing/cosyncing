import {
  diagnoseBinaryVersion,
  type AgentMinimumVersion,
  type AgentSetupDiagnosis,
  type SetupCheck,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';
import {
  bridgeCheck,
  bridgeConfigCheck,
  sessionStoreCheck,
  type PiBridgeDiagnosticInspection,
  type PiDialectDiagnosticLabels,
} from '@cosyncing/pi-engine';
import {
  detectOmpBunVersion,
  diagnoseOmpBunRuntime,
  OMP_MINIMUM_SUPPORTED_VERSION,
  OMP_VERIFIED_VERSION,
  ompInstallAdvice,
  ompVerifiedVersionsText,
  ompVersionVerdict,
} from './runtime-readiness.ts';
import { inspectOmpPathCollision, OMP_DIALECT } from './dialect.ts';
import { resolvePiDialectPaths } from '@cosyncing/pi-engine';

export const OMP_MINIMUM_VERSION: AgentMinimumVersion = Object.freeze({
  version: OMP_MINIMUM_SUPPORTED_VERSION,
  requiredFeature: 'strict JSONL RPC mode plus auto-discovered TypeScript extensions used by Drive and the in-process bridge',
  evidenceUrl: 'https://github.com/can1357/oh-my-pi/releases/tag/v17.4.2',
  evidenceNote: 'Conservative floor: the measured omp deltas (bare --version, get_available_commands, set_session_name, title slot, combined model_change) were audited on omp 17.4.2.',
});

const OMP_LABELS: PiDialectDiagnosticLabels = { checkPrefix: 'omp', displayName: 'omp' };

export async function diagnoseOmpSetup(
  context: SetupDiagnosisContext,
  options: { inspectBridge: (agentDir: string) => PiBridgeDiagnosticInspection },
): Promise<AgentSetupDiagnosis> {
  const binary = await diagnoseBinaryVersion({
    context,
    checkPrefix: 'omp',
    displayName: 'omp',
    command: context.env.COSYNCING_OMP_BIN?.trim() || 'omp',
    packageNames: ['@oh-my-pi/pi-coding-agent'],
    minimum: OMP_MINIMUM_VERSION,
    versionArgs: ['--version'],
    installMessage: 'Install the supported omp (oh-my-pi) package, then rerun doctor.',
    upgradeCommand: `bun install -g @oh-my-pi/pi-coding-agent@${OMP_MINIMUM_SUPPORTED_VERSION}`,
  });
  // `OMP_MINIMUM_VERSION` is read as a floor, but readiness drives exactly the captured builds: an
  // omp above the floor that is not one of them (newer than the newest, or between two captured
  // releases) is not "supported" in doctor while the roster refuses to drive it.
  const verdict = binary.installedVersion ? ompVersionVerdict(binary.installedVersion) : undefined;
  const index = binary.checks.findIndex((check) => check.id === 'omp.version');
  const versionCheck = index >= 0 ? binary.checks[index] : undefined;
  if (versionCheck && (verdict === 'unverified' || versionCheck.remediation?.kind === 'command')) {
    // Which captured omp to install depends on the Bun that would run it: omp 19.1.0 does not start
    // on a Bun below its floor, so advising it there leads straight to a Bun failure.
    const advice = ompInstallAdvice(binary.executable ? await detectOmpBunVersion(context, binary.executable) : undefined);
    binary.checks[index] = verdict === 'unverified'
      ? {
        id: 'omp.version',
        status: 'fail',
        detailCode: 'version-unverified',
        summary: `omp ${binary.installedVersion} is not one of the builds Drive and Create were measured against (omp ${ompVerifiedVersionsText()}).`,
        evidence: { installedVersion: binary.installedVersion!, verifiedVersion: OMP_VERIFIED_VERSION },
        remediation: {
          kind: 'command',
          message: `${advice.message} to drive sessions from the app, or keep using Observe.`,
          command: advice.command,
        },
      }
      : {
        ...versionCheck,
        remediation: {
          kind: 'command',
          message: versionCheck.detailCode === 'version-below-minimum' ? `${advice.message}.` : versionCheck.remediation!.message,
          command: advice.command,
        },
      };
  }
  const env = { ...context.env, HOME: context.homeDir };
  const paths = resolvePiDialectPaths(OMP_DIALECT, env);
  const agentDir = paths.agentDir;
  const sessionRoot = paths.sessionsRoot;
  const collision = inspectOmpPathCollision(env, context.platform);
  const checks: SetupCheck[] = [
    ...binary.checks,
    ...(collision ? [{
      id: 'omp.path-collision',
      status: 'fail' as const,
      detailCode: collision.code,
      summary: collision.summary,
      evidence: {
        piAgentDir: context.displayPath(collision.piAgentDir),
        ompAgentDir: context.displayPath(collision.ompAgentDir),
        piSessionsRoot: context.displayPath(collision.piSessionsRoot),
        ompSessionsRoot: context.displayPath(collision.ompSessionsRoot),
      },
      remediation: { kind: 'manual' as const, message: collision.remediation },
    }] : []),
    await diagnoseOmpBunRuntime(context, binary.executable),
    sessionStoreCheck(OMP_LABELS, context, sessionRoot, !!binary.executable),
    bridgeCheck(OMP_LABELS, context, options.inspectBridge(agentDir)),
    bridgeConfigCheck(OMP_LABELS, context, agentDir),
  ];
  return {
    agent: 'omp',
    displayName: 'omp',
    minimumVersion: OMP_MINIMUM_VERSION,
    checks,
  };
}
