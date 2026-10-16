import {
  compareSemanticVersions,
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
  diagnoseOmpBunRuntime,
  OMP_MINIMUM_SUPPORTED_VERSION,
  OMP_VERIFIED_VERSION,
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
  // `OMP_MINIMUM_VERSION` is read as a floor, but readiness drives exactly the verified build: a
  // newer omp is not "supported" in doctor while the roster refuses to drive it.
  const aboveVerified = binary.installedVersion
    ? compareSemanticVersions(binary.installedVersion, OMP_VERIFIED_VERSION)
    : undefined;
  if (aboveVerified !== undefined && aboveVerified > 0) {
    const index = binary.checks.findIndex((check) => check.id === 'omp.version');
    if (index >= 0) {
      binary.checks[index] = {
        id: 'omp.version',
        status: 'fail',
        detailCode: 'version-unverified',
        summary: `omp ${binary.installedVersion} is newer than ${OMP_VERIFIED_VERSION}, the build Drive and Create were measured against.`,
        evidence: { installedVersion: binary.installedVersion!, verifiedVersion: OMP_VERIFIED_VERSION },
        remediation: {
          kind: 'command',
          message: `Install omp ${OMP_VERIFIED_VERSION} to drive sessions from the app, or keep using Observe.`,
          command: `bun install -g @oh-my-pi/pi-coding-agent@${OMP_VERIFIED_VERSION}`,
        },
      };
    }
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
