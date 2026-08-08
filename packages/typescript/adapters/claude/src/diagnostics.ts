import { join } from 'node:path';
import {
  diagnoseBinaryVersion,
  type AgentMinimumVersion,
  type AgentSetupDiagnosis,
  type SetupCheck,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';

export const CLAUDE_MINIMUM_VERSION: AgentMinimumVersion = Object.freeze({
  version: '2.1.207',
  requiredFeature: 'the `claude -p --resume` stream-json Drive surface and current interactive-session metadata semantics used by Observe and Take over',
  evidenceUrl: 'https://github.com/anthropics/claude-code/releases/tag/v2.1.207',
  evidenceNote: 'Conservative floor: permission, question, task, and resume behavior in this adapter is fixture- and real-host-verified on Claude Code 2.1.207.',
});

export interface LegacyClaudeHookDiagnosticInspection {
  status: 'absent' | 'legacy-marker' | 'unreadable';
  path: string;
  entryCount: number;
  requiresConfirmation: boolean;
}

function transcriptStoreCheck(context: SetupDiagnosisContext, path: string, binaryPresent: boolean): SetupCheck {
  const inspection = context.inspectPath(path);
  if (inspection.status === 'directory' && inspection.readable) {
    return {
      id: 'claude.transcripts',
      status: 'pass',
      detailCode: 'transcripts-readable',
      summary: 'Claude transcript storage is readable.',
      evidence: { path: inspection.displayPath },
    };
  }
  if (inspection.status === 'missing') {
    return {
      id: 'claude.transcripts',
      status: binaryPresent ? 'warn' : 'skip',
      detailCode: 'transcripts-missing',
      summary: 'Claude transcript storage is not present yet.',
      evidence: { path: inspection.displayPath },
      ...(binaryPresent ? { remediation: { kind: 'manual' as const, message: 'Start Claude Code once to create its transcript store.' } } : {}),
    };
  }
  return {
    id: 'claude.transcripts',
    status: 'fail',
    detailCode: inspection.status === 'unreadable' ? 'transcripts-unreadable' : 'transcripts-unsafe-type',
    summary: 'Claude transcript storage is unreadable or has an unexpected type.',
    evidence: { path: inspection.displayPath },
    remediation: { kind: 'command', message: 'Repair Claude transcript access.', command: 'cosyncing repair' },
  };
}

function legacyHookCheck(
  context: SetupDiagnosisContext,
  inspection: LegacyClaudeHookDiagnosticInspection,
): SetupCheck {
  if (inspection.status === 'absent') {
    return {
      id: 'claude.legacy-hooks',
      status: 'pass',
      detailCode: 'legacy-hooks-absent',
      summary: 'No legacy cosyncing-hook settings entry is present.',
    };
  }
  if (inspection.status === 'legacy-marker') {
    return {
      id: 'claude.legacy-hooks',
      status: 'warn',
      detailCode: 'legacy-hooks-marked',
      summary: 'Legacy Claude hook entries are present; their command may contain an embedded shared credential.',
      evidence: {
        path: context.displayPath(inspection.path),
        entryCount: inspection.entryCount,
        requiresConfirmation: true,
      },
      remediation: {
        kind: 'command',
        message: 'Review marker-owned entries and rotate any embedded credential before confirmed removal.',
        command: 'cosyncing repair',
      },
    };
  }
  return {
    id: 'claude.legacy-hooks',
    status: 'fail',
    detailCode: 'claude-settings-unreadable',
    summary: 'Claude settings cannot be inspected safely for legacy hook entries.',
    evidence: { path: context.displayPath(inspection.path) },
    remediation: { kind: 'manual', message: 'Fix Claude settings readability, then rerun `cosyncing doctor`.' },
  };
}

export async function diagnoseClaudeSetup(
  context: SetupDiagnosisContext,
  options: {
    inspectLegacyHooks: (settingsPath: string) => LegacyClaudeHookDiagnosticInspection;
    binary?: string;
    configDir?: string;
  },
): Promise<AgentSetupDiagnosis> {
  const binaryName = options.binary || context.env.COSYNCING_CLAUDE_BIN?.trim() || 'claude';
  const binary = await diagnoseBinaryVersion({
    context,
    checkPrefix: 'claude',
    displayName: 'Claude Code',
    command: binaryName,
    versionArgs: ['--version'],
    minimum: CLAUDE_MINIMUM_VERSION,
    installMessage: 'Install the official Claude Code CLI, then rerun doctor.',
    upgradeCommand: 'claude update',
  });
  const configDir = options.configDir || context.env.CLAUDE_CONFIG_DIR?.trim() || join(context.homeDir, '.claude');
  const checks: SetupCheck[] = [
    ...binary.checks,
    transcriptStoreCheck(context, join(configDir, 'projects'), !!binary.executable),
    legacyHookCheck(context, options.inspectLegacyHooks(join(configDir, 'settings.json'))),
  ];
  return {
    agent: 'claude',
    displayName: 'Claude Code',
    minimumVersion: CLAUDE_MINIMUM_VERSION,
    checks,
  };
}
