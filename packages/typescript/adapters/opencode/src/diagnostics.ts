import { join } from 'node:path';
import {
  diagnoseBinaryVersion,
  diagnoseManagedRuntimeFailure,
  type AgentMinimumVersion,
  type AgentSetupDiagnosis,
  type SetupCheck,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';

export const OPENCODE_MINIMUM_VERSION: AgentMinimumVersion = Object.freeze({
  version: '1.17.19',
  requiredFeature: 'the headless `opencode serve` HTTP/OpenAPI and SSE surface used for shared-owner terminal sync',
  evidenceUrl: 'https://github.com/anomalyco/opencode/releases/tag/v1.17.19',
  evidenceNote: 'Conservative floor: this repository is fixture- and real-host-verified on OpenCode 1.17.19; official server docs define the required multi-client HTTP surface.',
});

function dataDirectory(context: SetupDiagnosisContext, configured?: string): string {
  if (configured) return configured;
  if (context.env.OPENCODE_DATA?.trim()) return context.env.OPENCODE_DATA.trim();
  if (context.platform === 'darwin') return join(context.homeDir, 'Library', 'Application Support', 'opencode');
  if (context.platform === 'win32') {
    return join(context.env.LOCALAPPDATA?.trim() || join(context.homeDir, 'AppData', 'Local'), 'opencode');
  }
  return join(context.env.XDG_DATA_HOME?.trim() || join(context.homeDir, '.local', 'share'), 'opencode');
}

function storageCheck(context: SetupDiagnosisContext, path: string, binaryPresent: boolean): SetupCheck {
  const inspected = context.inspectPath(path);
  if (inspected.status === 'directory' && inspected.readable) {
    return {
      id: 'opencode.storage',
      status: 'pass',
      detailCode: 'storage-readable',
      summary: 'OpenCode local session storage is readable.',
      evidence: { path: inspected.displayPath },
    };
  }
  if (inspected.status === 'missing') {
    return {
      id: 'opencode.storage',
      status: binaryPresent ? 'warn' : 'skip',
      detailCode: 'storage-missing',
      summary: 'OpenCode local session storage is not present yet.',
      evidence: { path: inspected.displayPath },
      ...(binaryPresent ? {
        remediation: { kind: 'manual' as const, message: 'Start OpenCode once or use a reachable shared server.' },
      } : {}),
    };
  }
  return {
    id: 'opencode.storage',
    status: 'fail',
    detailCode: inspected.status === 'unreadable' ? 'storage-unreadable' : 'storage-unsafe-type',
    summary: 'OpenCode local session storage is unreadable or has an unexpected type.',
    evidence: { path: inspected.displayPath },
    remediation: { kind: 'command', message: 'Repair the OpenCode integration paths.', command: 'cosyncing repair' },
  };
}

function normalizedServerUrl(raw: string): URL | undefined {
  try {
    const value = new URL(raw);
    const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(value.hostname);
    if (loopback && !value.port) value.port = '4096';
    if ((value.protocol !== 'http:' && value.protocol !== 'https:')
        || value.username || value.password || value.search || value.hash
        || (value.pathname !== '/' && value.pathname !== '')) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function serverEvidence(server: URL): string {
  const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(server.hostname);
  return loopback ? server.origin : `${server.protocol}//<configured-host>${server.port ? `:${server.port}` : ''}`;
}

function truthy(value: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(value?.trim() || '');
}

export async function diagnoseOpenCodeSetup(
  context: SetupDiagnosisContext,
  options: { baseUrl?: string; dataDir?: string; serverExplicitlyConfigured?: boolean } = {},
): Promise<AgentSetupDiagnosis> {
  const binary = await diagnoseBinaryVersion({
    context,
    checkPrefix: 'opencode',
    displayName: 'OpenCode',
    command: 'opencode',
    versionArgs: ['--version'],
    minimum: OPENCODE_MINIMUM_VERSION,
    installMessage: 'Install the official OpenCode CLI, then rerun doctor.',
    upgradeCommand: 'opencode upgrade',
  });
  const checks: SetupCheck[] = [
    ...binary.checks,
    storageCheck(context, dataDirectory(context, options.dataDir), !!binary.executable),
    diagnoseManagedRuntimeFailure(context, 'opencode', 'OpenCode'),
  ];

  const server = normalizedServerUrl(options.baseUrl || context.env.OPENCODE_URL?.trim() || 'http://127.0.0.1:4096');
  if (!server) {
    checks.push({
      id: 'opencode.server',
      status: 'fail',
      detailCode: 'server-url-invalid',
      summary: 'The configured OpenCode server URL is invalid.',
      remediation: { kind: 'command', message: 'Reconfigure the OpenCode integration.', command: 'cosyncing repair' },
    });
  } else {
    const healthUrl = new URL('/global/health', server).toString();
    const health = await context.fetchJson(healthUrl);
    const payload = health.json as { healthy?: unknown; version?: unknown } | undefined;
    if (health.status === 'ok' && payload?.healthy === true) {
      checks.push({
        id: 'opencode.server',
        status: 'pass',
        detailCode: 'server-reachable',
        summary: 'OpenCode shared server is reachable.',
        evidence: { url: serverEvidence(server) },
      });
    } else {
      const port = Number(server.port || (server.protocol === 'https:' ? 443 : 80));
      const portState = await context.probeTcp(server.hostname, port);
      const explicitlyConfigured = options.serverExplicitlyConfigured ?? !!context.env.OPENCODE_URL?.trim();
      checks.push(portState === 'open'
        ? {
            id: 'opencode.server',
            status: 'fail',
            detailCode: 'server-port-conflict',
            summary: 'The OpenCode port is occupied but does not expose the expected health contract.',
            evidence: { url: serverEvidence(server) },
            remediation: { kind: 'command', message: 'Reconcile the managed OpenCode server without killing an unowned process.', command: 'cosyncing repair' },
          }
        : {
            id: 'opencode.server',
            status: explicitlyConfigured ? 'fail' : binary.executable ? 'warn' : 'skip',
            detailCode: portState === 'unknown' ? 'server-reachability-unknown' : 'server-not-running',
            summary: explicitlyConfigured
              ? 'The configured OpenCode server is unreachable.'
              : 'No shared OpenCode server is currently reachable.',
            evidence: { url: serverEvidence(server) },
            remediation: binary.executable
              ? { kind: 'command', message: 'Let setup reconcile the managed OpenCode server.', command: 'cosyncing setup' }
              : { kind: 'manual', message: 'Install OpenCode before enabling its shared server.' },
          });
    }

    const loopback = ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(server.hostname);
    if (!loopback) {
      checks.push({
        id: 'opencode.managed-serve-eligibility',
        status: 'skip',
        detailCode: 'external-server-configured',
        summary: 'OpenCode uses an externally managed server; cosyncing will not launch another one.',
        evidence: { url: serverEvidence(server) },
      });
    } else if (truthy(context.env.COSYNCING_OPENCODE_NO_AUTOSERVE)) {
      checks.push({
        id: 'opencode.managed-serve-eligibility',
        status: 'warn',
        detailCode: 'managed-serve-disabled',
        summary: 'Managed OpenCode serve is disabled by source-development configuration.',
        remediation: { kind: 'command', message: 'Reconcile packaged configuration.', command: 'cosyncing repair' },
      });
    } else {
      checks.push({
        id: 'opencode.managed-serve-eligibility',
        status: binary.executable ? 'pass' : 'skip',
        detailCode: binary.executable ? 'managed-serve-eligible' : 'managed-serve-binary-missing',
        summary: binary.executable
          ? 'OpenCode is eligible for the broker-managed shared server.'
          : 'Managed serve eligibility was not checked because OpenCode is missing.',
      });
    }
  }

  return {
    agent: 'opencode',
    displayName: 'OpenCode',
    minimumVersion: OPENCODE_MINIMUM_VERSION,
    checks,
  };
}
