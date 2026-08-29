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
  PI_DIALECT,
  resolvePiDialectPaths,
  sessionStoreCheck,
  type PiBridgeDiagnosticInspection,
  type PiDialectDiagnosticLabels,
} from '@cosyncing/pi-engine';
import {
  diagnosePiNodeRuntime,
  PI_MINIMUM_SUPPORTED_VERSION,
} from './runtime-readiness.ts';

export const PI_MINIMUM_VERSION: AgentMinimumVersion = Object.freeze({
  version: PI_MINIMUM_SUPPORTED_VERSION,
  requiredFeature: 'strict JSONL RPC mode plus auto-discovered TypeScript extensions used by Drive and the in-process bridge',
  evidenceUrl: 'https://github.com/earendil-works/pi/releases/tag/v0.78.1',
  evidenceNote: 'Conservative floor: the packaged bridge, RPC fixtures, and real-host lane are verified on Pi 0.78.1; tag-matched RPC and extension docs define the required surfaces.',
});

export type { PiBridgeDiagnosticInspection, PiDialectDiagnosticLabels } from '@cosyncing/pi-engine';

const PI_LABELS: PiDialectDiagnosticLabels = { checkPrefix: 'pi', displayName: 'Pi' };

export async function diagnosePiSetup(
  context: SetupDiagnosisContext,
  options: { inspectBridge: (agentDir: string) => PiBridgeDiagnosticInspection },
): Promise<AgentSetupDiagnosis> {
  const binary = await diagnoseBinaryVersion({
    context,
    checkPrefix: 'pi',
    displayName: 'Pi',
    command: context.env.COSYNCING_PI_BIN?.trim() || 'pi',
    packageNames: ['@earendil-works/pi-coding-agent', '@mariozechner/pi-coding-agent'],
    minimum: PI_MINIMUM_VERSION,
    versionArgs: ['--version'],
    installMessage: 'Install the supported Pi coding-agent package, then rerun doctor.',
    upgradeCommand: 'pi update self',
  });
  const paths = resolvePiDialectPaths(PI_DIALECT, { ...context.env, HOME: context.homeDir });
  const agentDir = paths.agentDir;
  const sessionRoot = paths.sessionsRoot;
  const checks: SetupCheck[] = [
    ...binary.checks,
    await diagnosePiNodeRuntime(context, binary.executable),
    sessionStoreCheck(PI_LABELS, context, sessionRoot, !!binary.executable),
    bridgeCheck(PI_LABELS, context, options.inspectBridge(agentDir)),
    bridgeConfigCheck(PI_LABELS, context, agentDir),
  ];
  return {
    agent: 'pi',
    displayName: 'Pi',
    minimumVersion: PI_MINIMUM_VERSION,
    checks,
  };
}
