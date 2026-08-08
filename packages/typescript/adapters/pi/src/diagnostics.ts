import { join } from 'node:path';
import {
  diagnoseBinaryVersion,
  type AgentMinimumVersion,
  type AgentSetupDiagnosis,
  type SetupCheck,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';

export const PI_MINIMUM_VERSION: AgentMinimumVersion = Object.freeze({
  version: '0.78.1',
  requiredFeature: 'strict JSONL RPC mode plus auto-discovered TypeScript extensions used by Drive and the in-process bridge',
  evidenceUrl: 'https://github.com/earendil-works/pi/releases/tag/v0.78.1',
  evidenceNote: 'Conservative floor: the packaged bridge, RPC fixtures, and real-host lane are verified on Pi 0.78.1; tag-matched RPC and extension docs define the required surfaces.',
});

export interface PiBridgeDiagnosticInspection {
  status: 'missing' | 'owned' | 'legacy-marker' | 'unowned' | 'unreadable';
  path: string;
  requiresConfirmation: boolean;
}

function sessionStoreCheck(context: SetupDiagnosisContext, path: string, binaryPresent: boolean): SetupCheck {
  const inspection = context.inspectPath(path);
  if (inspection.status === 'directory' && inspection.readable) {
    return {
      id: 'pi.sessions',
      status: 'pass',
      detailCode: 'sessions-readable',
      summary: 'Pi session storage is readable.',
      evidence: { path: inspection.displayPath },
    };
  }
  if (inspection.status === 'missing') {
    return {
      id: 'pi.sessions',
      status: binaryPresent ? 'warn' : 'skip',
      detailCode: 'sessions-missing',
      summary: 'Pi session storage is not present yet.',
      evidence: { path: inspection.displayPath },
      ...(binaryPresent ? { remediation: { kind: 'manual' as const, message: 'Start Pi once to create its session store.' } } : {}),
    };
  }
  return {
    id: 'pi.sessions',
    status: 'fail',
    detailCode: inspection.status === 'unreadable' ? 'sessions-unreadable' : 'sessions-unsafe-type',
    summary: 'Pi session storage is unreadable or has an unexpected type.',
    evidence: { path: inspection.displayPath },
    remediation: { kind: 'command', message: 'Repair the Pi integration paths.', command: 'cosyncing repair' },
  };
}

function bridgeCheck(context: SetupDiagnosisContext, inspection: PiBridgeDiagnosticInspection): SetupCheck {
  const path = context.displayPath(inspection.path);
  switch (inspection.status) {
    case 'owned':
      return {
        id: 'pi.bridge-asset',
        status: 'pass',
        detailCode: 'bridge-owned-current',
        summary: 'Installed Pi bridge matches the packaged asset.',
        evidence: { path },
      };
    case 'missing':
      return {
        id: 'pi.bridge-asset',
        status: 'warn',
        detailCode: 'bridge-missing',
        summary: 'The Pi bridge extension is not installed.',
        evidence: { path },
        remediation: { kind: 'command', message: 'Install the packaged Pi bridge through setup.', command: 'cosyncing setup' },
      };
    case 'legacy-marker':
      return {
        id: 'pi.bridge-asset',
        status: 'warn',
        detailCode: 'bridge-legacy-marker',
        summary: 'A legacy cosyncing Pi bridge is present and requires confirmation before replacement.',
        evidence: { path, requiresConfirmation: true },
        remediation: { kind: 'command', message: 'Review and reconcile the legacy bridge.', command: 'cosyncing repair' },
      };
    case 'unowned':
      return {
        id: 'pi.bridge-asset',
        status: 'fail',
        detailCode: 'bridge-unowned-collision',
        summary: 'The Pi bridge target contains unowned content and will not be overwritten.',
        evidence: { path, requiresConfirmation: true },
        remediation: { kind: 'manual', message: 'Back up or relocate the existing extension, then rerun `cosyncing repair`.' },
      };
    case 'unreadable':
    default:
      return {
        id: 'pi.bridge-asset',
        status: 'fail',
        detailCode: 'bridge-unreadable',
        summary: 'The Pi bridge target cannot be inspected safely.',
        evidence: { path },
        remediation: { kind: 'command', message: 'Repair Pi bridge ownership and permissions.', command: 'cosyncing repair' },
      };
  }
}

function bridgeConfigCheck(context: SetupDiagnosisContext, agentDir: string): SetupCheck {
  const path = join(agentDir, 'extensions', 'cosyncing-bridge', 'config.json');
  const read = context.readText(path, 128 * 1024);
  if (!read.ok && read.reason === 'missing') {
    return {
      id: 'pi.bridge-config',
      status: 'skip',
      detailCode: 'bridge-config-absent',
      summary: 'No optional Pi bridge approval configuration is present.',
    };
  }
  if (!read.ok) {
    return {
      id: 'pi.bridge-config',
      status: 'fail',
      detailCode: 'bridge-config-unreadable',
      summary: 'Pi bridge configuration is unreadable.',
      remediation: { kind: 'command', message: 'Reconcile the Pi bridge configuration.', command: 'cosyncing repair' },
    };
  }
  try {
    const parsed = JSON.parse(read.text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid root');
    if (Object.prototype.hasOwnProperty.call(parsed, 'token') || Object.prototype.hasOwnProperty.call(parsed, 'broker')) {
      return {
        id: 'pi.bridge-config',
        status: 'fail',
        detailCode: 'bridge-config-legacy-auth',
        summary: 'Legacy Pi bridge configuration may contain a fixed broker URL or embedded shared credential.',
        remediation: { kind: 'command', message: 'Rotate and move integration data into the owner-only scoped record.', command: 'cosyncing repair' },
      };
    }
    return {
      id: 'pi.bridge-config',
      status: 'pass',
      detailCode: 'bridge-config-approval-only',
      summary: 'Pi bridge configuration contains approval preferences only.',
      evidence: { path: context.displayPath(path) },
    };
  } catch {
    return {
      id: 'pi.bridge-config',
      status: 'fail',
      detailCode: 'bridge-config-malformed',
      summary: 'Pi bridge configuration is malformed.',
      remediation: { kind: 'command', message: 'Reconcile the Pi bridge configuration.', command: 'cosyncing repair' },
    };
  }
}

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
    installMessage: 'Install the supported Pi coding-agent package, then rerun doctor.',
    upgradeCommand: 'pi update self',
  });
  const agentDir = context.env.PI_CODING_AGENT_DIR?.trim() || join(context.homeDir, '.pi', 'agent');
  const sessionRoot = context.env.COSYNCING_PI_SESSIONS_ROOT?.trim()
    || context.env.PI_CODING_AGENT_SESSION_DIR?.trim()
    || join(agentDir, 'sessions');
  const checks: SetupCheck[] = [
    ...binary.checks,
    sessionStoreCheck(context, sessionRoot, !!binary.executable),
    bridgeCheck(context, options.inspectBridge(agentDir)),
    bridgeConfigCheck(context, agentDir),
  ];
  return {
    agent: 'pi',
    displayName: 'Pi',
    minimumVersion: PI_MINIMUM_VERSION,
    checks,
  };
}
