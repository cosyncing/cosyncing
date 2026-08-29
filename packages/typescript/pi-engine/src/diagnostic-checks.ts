/**
 * Dialect-parameterized doctor checks shared by every Pi-engine adapter: the session store, the
 * installed bridge asset, and the optional bridge config. Each adapter passes its own labels;
 * pi's {checkPrefix: 'pi', displayName: 'Pi'} reproduce the historical pi check ids and summaries
 * exactly.
 */
import { join } from 'node:path';
import {
  type SetupCheck,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';

export interface PiBridgeDiagnosticInspection {
  status: 'missing' | 'owned' | 'legacy-marker' | 'unowned' | 'unsafe' | 'unreadable';
  path: string;
  requiresConfirmation: boolean;
}

/** Check-id prefix + human name for one dialect. */
export interface PiDialectDiagnosticLabels {
  checkPrefix: string;
  displayName: string;
}

export function sessionStoreCheck(labels: PiDialectDiagnosticLabels, context: SetupDiagnosisContext, path: string, binaryPresent: boolean): SetupCheck {
  const inspection = context.inspectPath(path);
  if (inspection.status === 'directory' && inspection.readable) {
    return {
      id: `${labels.checkPrefix}.sessions`,
      status: 'pass',
      detailCode: 'sessions-readable',
      summary: `${labels.displayName} session storage is readable.`,
      evidence: { path: inspection.displayPath },
    };
  }
  if (inspection.status === 'missing') {
    return {
      id: `${labels.checkPrefix}.sessions`,
      status: binaryPresent ? 'warn' : 'skip',
      detailCode: 'sessions-missing',
      summary: `${labels.displayName} session storage is not present yet.`,
      evidence: { path: inspection.displayPath },
      ...(binaryPresent ? { remediation: { kind: 'manual' as const, message: `Start ${labels.displayName} once to create its session store.` } } : {}),
    };
  }
  return {
    id: `${labels.checkPrefix}.sessions`,
    status: 'fail',
    detailCode: inspection.status === 'unreadable' ? 'sessions-unreadable' : 'sessions-unsafe-type',
    summary: `${labels.displayName} session storage is unreadable or has an unexpected type.`,
    evidence: { path: inspection.displayPath },
    remediation: { kind: 'command', message: `Repair the ${labels.displayName} integration paths.`, command: 'cosyncing repair' },
  };
}

export function bridgeCheck(labels: PiDialectDiagnosticLabels, context: SetupDiagnosisContext, inspection: PiBridgeDiagnosticInspection): SetupCheck {
  const path = context.displayPath(inspection.path);
  switch (inspection.status) {
    case 'owned':
      return {
        id: `${labels.checkPrefix}.bridge-asset`,
        status: 'pass',
        detailCode: 'bridge-owned-current',
        summary: `Installed ${labels.displayName} bridge matches the packaged asset.`,
        evidence: { path },
      };
    case 'missing':
      return {
        id: `${labels.checkPrefix}.bridge-asset`,
        status: 'warn',
        detailCode: 'bridge-missing',
        summary: `The ${labels.displayName} bridge extension is not installed.`,
        evidence: { path },
        remediation: { kind: 'command', message: `Install the packaged ${labels.displayName} bridge through setup.`, command: 'cosyncing setup' },
      };
    case 'legacy-marker':
      return {
        id: `${labels.checkPrefix}.bridge-asset`,
        status: 'warn',
        detailCode: 'bridge-legacy-marker',
        summary: `A legacy cosyncing ${labels.displayName} bridge is present and requires confirmation before replacement.`,
        evidence: { path, requiresConfirmation: true },
        remediation: {
          kind: 'command',
          message: 'Rerun setup and confirm replacement of the exact known legacy bridge.',
          command: 'cosyncing setup',
        },
      };
    case 'unowned':
      return {
        id: `${labels.checkPrefix}.bridge-asset`,
        status: 'fail',
        detailCode: 'bridge-unowned-collision',
        summary: `The ${labels.displayName} bridge target contains unowned content and will not be overwritten.`,
        evidence: { path, requiresConfirmation: true },
        remediation: { kind: 'manual', message: 'Back up or relocate the existing extension, then rerun `cosyncing repair`.' },
      };
    case 'unsafe':
      return {
        id: `${labels.checkPrefix}.bridge-asset`,
        status: 'fail',
        detailCode: 'bridge-unsafe',
        summary: `The ${labels.displayName} bridge target has an unsafe filesystem type or symlinked path.`,
        evidence: { path },
        remediation: { kind: 'command', message: `Repair ${labels.displayName} bridge ownership and permissions.`, command: 'cosyncing repair' },
      };
    case 'unreadable':
    default:
      return {
        id: `${labels.checkPrefix}.bridge-asset`,
        status: 'fail',
        detailCode: 'bridge-unreadable',
        summary: `The ${labels.displayName} bridge target cannot be inspected safely.`,
        evidence: { path },
        remediation: { kind: 'command', message: `Repair ${labels.displayName} bridge ownership and permissions.`, command: 'cosyncing repair' },
      };
  }
}

export function bridgeConfigCheck(labels: PiDialectDiagnosticLabels, context: SetupDiagnosisContext, agentDir: string): SetupCheck {
  const path = join(agentDir, 'extensions', 'cosyncing-bridge', 'config.json');
  const read = context.readText(path, 128 * 1024);
  if (!read.ok && read.reason === 'missing') {
    return {
      id: `${labels.checkPrefix}.bridge-config`,
      status: 'skip',
      detailCode: 'bridge-config-absent',
      summary: `No optional ${labels.displayName} bridge approval configuration is present.`,
    };
  }
  if (!read.ok) {
    return {
      id: `${labels.checkPrefix}.bridge-config`,
      status: 'fail',
      detailCode: 'bridge-config-unreadable',
      summary: `${labels.displayName} bridge configuration is unreadable.`,
      remediation: { kind: 'command', message: `Reconcile the ${labels.displayName} bridge configuration.`, command: 'cosyncing repair' },
    };
  }
  try {
    const parsed = JSON.parse(read.text) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid root');
    if (Object.prototype.hasOwnProperty.call(parsed, 'token') || Object.prototype.hasOwnProperty.call(parsed, 'broker')) {
      return {
        id: `${labels.checkPrefix}.bridge-config`,
        status: 'fail',
        detailCode: 'bridge-config-legacy-auth',
        summary: `Legacy ${labels.displayName} bridge configuration may contain a fixed broker URL or embedded shared credential.`,
        remediation: { kind: 'command', message: 'Rotate and move integration data into the owner-only scoped record.', command: 'cosyncing repair' },
      };
    }
    return {
      id: `${labels.checkPrefix}.bridge-config`,
      status: 'pass',
      detailCode: 'bridge-config-approval-only',
      summary: `${labels.displayName} bridge configuration contains approval preferences only.`,
      evidence: { path: context.displayPath(path) },
    };
  } catch {
    return {
      id: `${labels.checkPrefix}.bridge-config`,
      status: 'fail',
      detailCode: 'bridge-config-malformed',
      summary: `${labels.displayName} bridge configuration is malformed.`,
      remediation: { kind: 'command', message: `Reconcile the ${labels.displayName} bridge configuration.`, command: 'cosyncing repair' },
    };
  }
}
