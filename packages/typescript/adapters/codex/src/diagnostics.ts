import { join } from 'node:path';
import {
  diagnoseBinaryVersion,
  type AgentMinimumVersion,
  type AgentSetupDiagnosis,
  type SetupCheck,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';
import { CODEX_MAC_LSOF_PATH, CODEX_MAC_PS_PATH } from './tui-presence.ts';

export const CODEX_MINIMUM_VERSION: AgentMinimumVersion = Object.freeze({
  version: '0.144.5',
  requiredFeature: 'versioned app-server JSON-RPC plus the local daemon/socket control plane used by Drive and terminal sync',
  evidenceUrl: 'https://github.com/openai/codex/releases/tag/rust-v0.144.5',
  evidenceNote: 'Conservative floor: the repository fixtures and real-host traces are verified against Codex 0.144.5 and its tag-matched app-server schema.',
});

export const CODEX_STANDALONE_INSTALL_COMMAND = 'curl -fsSL https://chatgpt.com/codex/install.sh | sh';

function standaloneInstallCheck(
  context: SetupDiagnosisContext,
  codexHome: string,
  executable: string | undefined,
): SetupCheck {
  if (!executable) {
    return {
      id: 'codex.standalone-install',
      status: 'skip',
      detailCode: 'standalone-install-binary-missing',
      summary: 'The standalone Codex package was not checked because Codex is missing.',
    };
  }
  if (context.env.COSYNCING_CODEX_APP_SERVER_SOCK?.trim()) {
    return {
      id: 'codex.standalone-install',
      status: 'skip',
      detailCode: 'standalone-install-external-daemon',
      summary: 'An external Codex daemon is configured, so cosyncing does not require the standalone package.',
    };
  }

  // The installer keeps `current` as a release symlink and `current/codex` as another symlink. Inspect the
  // real file beneath both links: SetupDiagnosisContext intentionally reports a final symlink as `other`.
  // On Windows the same installer (install.ps1) writes `current\bin\codex.exe`, with `current` as a
  // JUNCTION rather than a symlink — so checking only the extensionless name reports
  // standalone-install-missing against a perfectly correct Windows standalone install, and tells the
  // operator to reinstall something they already have.
  const base = join(codexHome, 'packages', 'standalone', 'current', 'bin', 'codex');
  const candidates = context.platform === 'win32' ? [`${base}.exe`, base] : [base];
  let inspected = context.inspectPath(candidates[0]!);
  for (const candidate of candidates.slice(1)) {
    if (inspected.status === 'file' && inspected.readable) break;
    inspected = context.inspectPath(candidate);
  }
  if (inspected.status === 'file' && inspected.readable) {
    return {
      id: 'codex.standalone-install',
      status: 'pass',
      detailCode: 'standalone-install-ready',
      summary: 'The official standalone Codex package is installed for the managed daemon and terminal sync.',
      evidence: { path: inspected.displayPath },
    };
  }
  return {
    id: 'codex.standalone-install',
    status: 'warn',
    detailCode: inspected.status === 'missing'
      ? 'standalone-install-missing'
      : 'standalone-install-unusable',
    summary: inspected.status === 'missing'
      ? 'Codex is supported, but the official standalone package is missing; the broker-managed daemon and terminal sync are unavailable.'
      : 'The official standalone Codex package is unreadable or has an unexpected file type.',
    evidence: { path: inspected.displayPath },
    remediation: {
      kind: 'command',
      message: 'Install the official standalone Codex CLI, open a new terminal, then rerun `cosy setup`.',
      command: CODEX_STANDALONE_INSTALL_COMMAND,
    },
  };
}

function pathCheck(options: {
  context: SetupDiagnosisContext;
  id: string;
  label: string;
  path: string;
  expected: 'file' | 'directory' | 'socket';
  missingStatus: 'warn' | 'skip';
}): SetupCheck {
  const inspected = options.context.inspectPath(options.path);
  if (inspected.status === options.expected && inspected.readable) {
    return {
      id: options.id,
      status: 'pass',
      detailCode: `${options.expected}-readable`,
      summary: `${options.label} is readable.`,
      evidence: { path: inspected.displayPath },
    };
  }
  if (inspected.status === 'missing') {
    return {
      id: options.id,
      status: options.missingStatus,
      detailCode: `${options.expected}-missing`,
      summary: `${options.label} is not present.`,
      evidence: { path: inspected.displayPath },
      ...(options.missingStatus === 'warn' ? {
        remediation: {
          kind: 'command' as const,
          message: 'Run setup or repair after installing Codex.',
          command: 'cosyncing setup',
        },
      } : {}),
    };
  }
  return {
    id: options.id,
    status: 'fail',
    detailCode: inspected.status === 'unreadable' ? `${options.expected}-unreadable` : `${options.expected}-unsafe-type`,
    summary: `${options.label} is unreadable or has an unexpected file type.`,
    evidence: { path: inspected.displayPath },
    remediation: { kind: 'command', message: 'Inspect and repair the Codex installation state.', command: 'cosyncing repair' },
  };
}

export async function diagnoseCodexSetup(context: SetupDiagnosisContext): Promise<AgentSetupDiagnosis> {
  const binary = await diagnoseBinaryVersion({
    context,
    checkPrefix: 'codex',
    displayName: 'Codex',
    command: 'codex',
    packageNames: ['@openai/codex'],
    // The official standalone layout carries the exact version in its canonical path. Do not invoke
    // `codex --version`: current Codex attempts PATH-alias writes even for that flag, violating doctor.
    versionFromExecutable: (path) => path.match(/[/\\]releases[/\\](\d+\.\d+\.\d+)(?:-[^/\\]+)?[/\\]bin[/\\]codex$/)?.[1],
    minimum: CODEX_MINIMUM_VERSION,
    installMessage: 'Install the official Codex CLI, then rerun doctor.',
    upgradeCommand: 'codex update',
  });
  const codexHome = context.env.CODEX_HOME?.trim() || join(context.homeDir, '.codex');
  const daemonSocket = context.env.COSYNCING_CODEX_APP_SERVER_SOCK?.trim()
    || join(codexHome, 'app-server-control', 'app-server-control.sock');
  const daemonSocketInspection = context.inspectPath(daemonSocket);
  const checks: SetupCheck[] = [
    ...binary.checks,
    standaloneInstallCheck(context, codexHome, binary.executable),
    pathCheck({
      context,
      id: 'codex.sessions',
      label: 'Codex session store',
      path: join(codexHome, 'sessions'),
      expected: 'directory',
      missingStatus: binary.executable ? 'warn' : 'skip',
    }),
    pathCheck({
      context,
      id: 'codex.config',
      label: 'Codex configuration',
      path: join(codexHome, 'config.toml'),
      expected: 'file',
      missingStatus: binary.executable ? 'warn' : 'skip',
    }),
    pathCheck({
      context,
      id: 'codex.daemon-socket',
      label: 'Codex managed app-server socket',
      path: daemonSocket,
      expected: 'socket',
      missingStatus: binary.executable ? 'warn' : 'skip',
    }),
  ];

  if (!binary.executable || daemonSocketInspection.status !== 'socket') {
    checks.push({
      id: 'codex.daemon-status',
      status: 'skip',
      detailCode: !binary.executable
        ? 'daemon-binary-missing'
        : daemonSocketInspection.status === 'missing' ? 'daemon-socket-missing' : 'daemon-socket-invalid',
      summary: 'Codex daemon status was not queried because its binary or safe socket is unavailable.',
    });
  } else if (context.platform !== 'linux') {
    // Listener state comes from /proc/net/unix, which only Linux has. A safe socket file on any other host
    // is real evidence but NOT proof of a live listener, so this reports an explicit skip rather than
    // silently inheriting the Linux 'stale' verdict and accusing a healthy daemon of being dead.
    checks.push({
      id: 'codex.daemon-status',
      status: 'skip',
      detailCode: 'daemon-status-platform-unsupported',
      summary: 'The Codex daemon socket is present; active-listener verification is Linux/WSL-only on this host.',
      evidence: { socket: context.displayPath(daemonSocket) },
    });
  } else {
    const unixSockets = context.readText('/proc/net/unix', 2 * 1024 * 1024);
    const listening = unixSockets.ok && unixSockets.text.split('\n').some((line) => line.includes(daemonSocket));
    if (listening) {
      checks.push({
        id: 'codex.daemon-status',
        status: 'pass',
        detailCode: 'daemon-socket-listening',
        summary: 'Codex daemon socket has an active Unix listener.',
        evidence: { socket: context.displayPath(daemonSocket) },
      });
    } else {
      checks.push({
        id: 'codex.daemon-status',
        status: unixSockets.ok ? 'fail' : 'warn',
        detailCode: unixSockets.ok ? 'daemon-socket-stale' : 'daemon-status-unavailable',
        summary: unixSockets.ok
          ? 'The Codex daemon socket exists but no active listener could be verified.'
          : 'The Codex daemon socket exists, but Linux Unix-listener state is unreadable.',
        remediation: { kind: 'command', message: 'Reconcile the managed Codex daemon.', command: 'cosyncing repair' },
      });
    }
  }
  if (context.platform === 'darwin') {
    const ps = context.resolveExecutable(CODEX_MAC_PS_PATH);
    const lsof = context.resolveExecutable(CODEX_MAC_LSOF_PATH);
    checks.push(ps && lsof
      ? {
          id: 'codex.terminal-presence-capability',
          status: 'pass',
          detailCode: 'terminal-presence-capable',
          summary: 'macOS process identity, cwd, and Unix-socket diagnostics are available.',
          evidence: { ps: context.displayPath(ps), lsof: context.displayPath(lsof) },
        }
      : {
          id: 'codex.terminal-presence-capability',
          status: 'warn',
          detailCode: 'terminal-presence-tools-missing',
          summary: 'Codex terminal presence cannot be proved on this Mac because ps or lsof is unavailable.',
          remediation: {
            kind: 'manual',
            message: 'Restore the standard macOS ps and lsof tools; automatic Drive restoration stays disabled until presence can be proved.',
          },
        });
  } else if (context.platform !== 'linux') {
    checks.push({
      id: 'codex.terminal-presence-capability',
      status: 'warn',
      detailCode: 'terminal-presence-platform-unsupported',
      summary: 'Authoritative Codex terminal-presence detection is unavailable on this platform.',
      remediation: { kind: 'manual', message: 'Use Observe or explicit Take over; automatic Drive restoration stays disabled.' },
    });
  } else {
    const proc = context.inspectPath('/proc');
    checks.push(proc.status === 'directory' && proc.readable
      ? {
          id: 'codex.terminal-presence-capability',
          status: 'pass',
          detailCode: 'terminal-presence-capable',
          summary: 'Linux process and Unix-socket diagnostics are available.',
          evidence: { proc: '/proc' },
        }
      : {
          id: 'codex.terminal-presence-capability',
          status: 'warn',
          detailCode: 'process-diagnostic-unreadable',
          summary: 'Codex terminal presence cannot be proved on this host.',
          remediation: { kind: 'manual', message: 'Ensure Linux /proc process state is readable.' },
        });
  }

  return {
    agent: 'codex',
    displayName: 'Codex',
    minimumVersion: CODEX_MINIMUM_VERSION,
    checks,
  };
}
