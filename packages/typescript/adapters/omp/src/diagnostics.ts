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
  diagnoseOmpBunRuntime,
  OMP_MINIMUM_SUPPORTED_VERSION,
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
    upgradeCommand: 'bun install -g @oh-my-pi/pi-coding-agent@latest',
  });
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
