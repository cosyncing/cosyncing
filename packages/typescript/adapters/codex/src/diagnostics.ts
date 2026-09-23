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

const CODEX_DAEMON_SOCKET_LABEL = 'Codex managed app-server socket';

/** What {@link daemonEndpoint} decided about the control endpoint, plus what listener lookup should use. */
type CodexDaemonEndpoint =
  | {
      check: SetupCheck;
      state: 'usable';
      /** The path an active listener appears as in the kernel's Unix-socket table. */
      listenerPath: string;
      resolvedPath: string;
      viaAlias: boolean;
    }
  | {
      check: SetupCheck;
      state: 'unusable';
      skipDetailCode: 'daemon-socket-missing' | 'daemon-socket-invalid';
    };

/**
 * Judge the managed control endpoint the way the native runtime actually publishes it.
 *
 * A current Codex runtime replaces `app-server-control/app-server-control.sock` with a symlink into a
 * runtime-owned directory, so one endpoint carries two names. Refusing the link, as this check used to,
 * told the operator their healthy daemon was an unsafe file — and the same rejection in the live routing
 * path is what made Drive report ownership unknown for ordinary sessions. So the alias is admitted, and
 * listener lookup then uses the TARGET: the Unix-socket table records the bound path and never the alias,
 * so a match on the alias could only ever prove that the alias exists.
 *
 * Admitting a name is not admitting anything else. A link that reaches a non-socket is still a hard
 * failure, an unreadable target is still a failure, and a dangling link is still only evidence that the
 * endpoint is absent. Nothing here touches process-stop ownership, which keeps refusing aliases.
 */
function daemonEndpoint(options: {
  context: SetupDiagnosisContext;
  path: string;
  missingStatus: 'warn' | 'skip';
}): CodexDaemonEndpoint {
  const { context, path, missingStatus } = options;
  const inspected = context.inspectPath(path);
  const unusable = (check: SetupCheck): CodexDaemonEndpoint => ({
    check,
    state: 'unusable',
    skipDetailCode: check.detailCode === 'socket-missing' || check.detailCode === 'socket-alias-dangling'
      ? 'daemon-socket-missing'
      : 'daemon-socket-invalid',
  });
  if (inspected.status !== 'other' || inspected.link === undefined) {
    const check = pathCheck({
      context,
      id: 'codex.daemon-socket',
      label: CODEX_DAEMON_SOCKET_LABEL,
      path,
      expected: 'socket',
      missingStatus,
    });
    return check.status === 'pass'
      ? { check, state: 'usable', listenerPath: path, resolvedPath: path, viaAlias: false }
      : unusable(check);
  }
  const { link } = inspected;
  if (link.status === 'socket' && link.readable) {
    return {
      check: {
        id: 'codex.daemon-socket',
        status: 'pass',
        detailCode: 'socket-alias-readable',
        summary: `${CODEX_DAEMON_SOCKET_LABEL} is readable through the runtime control-socket alias.`,
        evidence: { path: inspected.displayPath, resolved: context.displayPath(link.resolvedPath) },
      },
      state: 'usable',
      listenerPath: link.resolvedPath,
      resolvedPath: link.resolvedPath,
      viaAlias: true,
    };
  }
  if (link.status === 'missing') {
    return unusable({
      id: 'codex.daemon-socket',
      status: missingStatus,
      detailCode: 'socket-alias-dangling',
      summary: `${CODEX_DAEMON_SOCKET_LABEL} points at a runtime socket that is no longer present.`,
      evidence: { path: inspected.displayPath },
      ...(missingStatus === 'warn'
        ? { remediation: { kind: 'command' as const, message: 'Reconcile the managed Codex daemon.', command: 'cosyncing repair' } }
        : {}),
    });
  }
  return unusable({
    id: 'codex.daemon-socket',
    status: 'fail',
    detailCode: link.status === 'socket' ? 'socket-alias-unreadable' : 'socket-alias-unsafe-type',
    summary: link.status === 'socket'
      ? `${CODEX_DAEMON_SOCKET_LABEL} is readable through an alias but cannot be read.`
      : `${CODEX_DAEMON_SOCKET_LABEL} aliases something that is not a socket.`,
    evidence: { path: inspected.displayPath, resolved: context.displayPath(link.resolvedPath) },
    remediation: { kind: 'command', message: 'Inspect and repair the Codex installation state.', command: 'cosyncing repair' },
  });
}

/**
 * Match a Unix-socket table row by PATH rather than by substring.
 *
 * `/proc/net/unix` puts the bound path in the last column, so a row matches only when the path ends the
 * row at a column boundary. The substring test this replaces let one socket answer for every longer path
 * that merely contained its name, and a runtime directory holding several generation-named sockets is
 * exactly where that coincidence stops being hypothetical.
 */
function unixSocketTableListensFor(table: string, socketPath: string): boolean {
  if (socketPath.length === 0) return false;
  return table.split('\n').some((line) => {
    if (!line.endsWith(socketPath)) return false;
    const boundary = line[line.length - socketPath.length - 1];
    return boundary === undefined || /\s/.test(boundary);
  });
}

export async function diagnoseCodexSetup(context: SetupDiagnosisContext): Promise<AgentSetupDiagnosis> {
  const binary = await diagnoseBinaryVersion({
    context,
    checkPrefix: 'codex',
    displayName: 'Codex',
    command: 'codex',
    packageNames: ['@openai/codex'],
    // The official standalone layout carries the exact version in its canonical path, so on a host that
    // uses it the CLI is never invoked. `.exe` is admitted because the same layout on Windows names the
    // binary that way.
    versionFromExecutable: (path) =>
      path.match(/[/\\]releases[/\\](\d+\.\d+\.\d+)(?:-[^/\\]+)?[/\\]bin[/\\]codex(?:\.exe)?$/i)?.[1],
    // Last resort, reached only when neither the npm package nor the path answers. Codex's Windows
    // installer places `…\\Programs\\OpenAI\\Codex\\bin\\codex.exe`, a layout with no version in it and
    // no version resource on the binary, so without this a perfectly current Codex reports its version as
    // unreadable and setup disables it -- observed on the 3090 with 0.154.0 against a 0.144.5 floor. The
    // older refusal here was specific to a Codex that wrote PATH aliases even for this flag; 0.154.0 does
    // not (verified against the install tree, CODEX_HOME and the user PATH), and every other adapter
    // probes exactly this way.
    versionArgs: ['--version'],
    minimum: CODEX_MINIMUM_VERSION,
    installMessage: 'Install the official Codex CLI, then rerun doctor.',
    upgradeCommand: 'codex update',
  });
  const codexHome = context.env.CODEX_HOME?.trim() || join(context.homeDir, '.codex');
  const daemonSocket = context.env.COSYNCING_CODEX_APP_SERVER_SOCK?.trim()
    || join(codexHome, 'app-server-control', 'app-server-control.sock');
  const endpoint = daemonEndpoint({
    context,
    path: daemonSocket,
    missingStatus: binary.executable ? 'warn' : 'skip',
  });
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
    endpoint.check,
  ];

  if (!binary.executable || endpoint.state !== 'usable') {
    checks.push({
      id: 'codex.daemon-status',
      status: 'skip',
      detailCode: !binary.executable
        ? 'daemon-binary-missing'
        : endpoint.state === 'unusable' ? endpoint.skipDetailCode : 'daemon-socket-invalid',
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
      evidence: { socket: context.displayPath(endpoint.resolvedPath) },
    });
  } else {
    const unixSockets = context.readText('/proc/net/unix', 2 * 1024 * 1024);
    const listening = unixSockets.ok
      && unixSocketTableListensFor(unixSockets.text, endpoint.listenerPath);
    if (listening) {
      checks.push({
        id: 'codex.daemon-status',
        status: 'pass',
        detailCode: 'daemon-socket-listening',
        summary: 'Codex daemon socket has an active Unix listener.',
        evidence: {
          socket: context.displayPath(endpoint.resolvedPath),
          ...(endpoint.viaAlias ? { aliased: true } : {}),
        },
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
