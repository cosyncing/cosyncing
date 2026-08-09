import {
  accessSync,
  closeSync,
  constants,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { delimiter, dirname, isAbsolute, join, parse, resolve } from 'node:path';
import {
  compareSemanticVersions,
  semanticVersionFromText,
  type SetupDiagnosisContext,
} from '@cosyncing/adapter-api';

export const PI_DEFAULT_NODE_MINIMUM_VERSION = '22.19.0';
export const PI_MINIMUM_SUPPORTED_VERSION = '0.78.1';
const PI_PACKAGE_NAMES = new Set([
  '@earendil-works/pi-coding-agent',
  '@mariozechner/pi-coding-agent',
]);
const PACKAGE_JSON_MAX_BYTES = 256 * 1024;
const LAUNCHER_PREFIX_MAX_BYTES = 4096;
const RUNTIME_CACHE_TTL_MS = 2_000;

export interface PiRuntimeReadiness {
  ready: boolean;
  detailCode: string;
  message: string;
  executable?: string;
  nodeExecutable?: string;
  nodeVersion?: string;
  requiredNodeVersion?: string;
  packageVersion?: string;
}

interface PiPackageRuntimeContract {
  version?: string;
  minimumNodeVersion: string;
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

function readableExecutable(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveExecutable(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (!command || /[\0\r\n]/.test(command)) return undefined;
  if (command.includes('/') || command.includes('\\')) {
    const candidate = isAbsolute(command) ? command : resolve(command);
    return readableExecutable(candidate) ? canonical(candidate) : undefined;
  }
  for (const root of String(env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(root, command);
    if (readableExecutable(candidate)) return canonical(candidate);
  }
  return undefined;
}

function readPrefix(path: string, maxBytes = LAUNCHER_PREFIX_MAX_BYTES): string | undefined {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const bytes = Buffer.alloc(maxBytes);
    const count = readSync(fd, bytes, 0, bytes.length, 0);
    return bytes.subarray(0, count).toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
  }
}

function minimumVersionFromNodeEngine(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const lowerBound = value.match(/(?:^|[|\s])>=\s*v?(\d+\.\d+\.\d+)/)?.[1];
  if (lowerBound) return lowerBound;
  return value.trim().match(/^[~^]?v?(\d+\.\d+\.\d+)$/)?.[1];
}

function packageRuntimeContract(
  executable: string,
  readText: (path: string) => string | undefined,
): PiPackageRuntimeContract {
  let current = dirname(canonical(executable));
  const root = parse(current).root;
  for (let depth = 0; depth < 10; depth += 1) {
    const text = readText(join(current, 'package.json'));
    if (text !== undefined) {
      try {
        const pkg = JSON.parse(text) as {
          name?: unknown;
          version?: unknown;
          engines?: { node?: unknown };
        };
        if (typeof pkg.name === 'string' && PI_PACKAGE_NAMES.has(pkg.name)) {
          return {
            ...(typeof pkg.version === 'string' ? { version: pkg.version } : {}),
            minimumNodeVersion:
              minimumVersionFromNodeEngine(pkg.engines?.node)
              ?? PI_DEFAULT_NODE_MINIMUM_VERSION,
          };
        }
      } catch {
        // Keep walking through wrapper/package nesting. An unrelated malformed package cannot
        // lower the conservative fallback used for the actual Pi launcher.
      }
    }
    if (current === root) break;
    current = dirname(current);
  }
  return { minimumNodeVersion: PI_DEFAULT_NODE_MINIMUM_VERSION };
}

function nodeCommandFromShebang(prefix: string): string | undefined | null {
  if (!prefix.startsWith('#!')) return null; // native/compiled Pi executable: Node is not involved
  const firstLine = prefix.slice(2).split(/\r?\n/, 1)[0]?.trim() ?? '';
  if (!firstLine) return undefined;
  const tokens = firstLine.split(/\s+/).filter(Boolean);
  const interpreter = tokens.shift();
  if (!interpreter) return undefined;
  if (interpreter.endsWith('/env')) {
    while (tokens[0]?.startsWith('-')) tokens.shift();
    const command = tokens[0]?.split('=')[0];
    if (command === 'bun') return null;
    return command === 'node' ? 'node' : undefined;
  }
  const basename = interpreter.split('/').pop();
  if (basename === 'bun') return null;
  return basename === 'node' ? interpreter : undefined;
}

function unsupportedReadiness(
  detailCode: string,
  message: string,
  evidence: Omit<PiRuntimeReadiness, 'ready' | 'detailCode' | 'message'> = {},
): PiRuntimeReadiness {
  return { ready: false, detailCode, message, ...evidence };
}

function boundedVersionProbe(
  executable: string,
  env: NodeJS.ProcessEnv,
): { output: string; version?: string } | undefined {
  try {
    const probe = spawnSync(executable, ['--version'], {
      encoding: 'utf8',
      env: { ...env },
      input: '',
      timeout: 3_000,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
    if (probe.error || probe.status !== 0 || probe.signal) return undefined;
    const output = `${probe.stdout ?? ''}\n${probe.stderr ?? ''}`.trim();
    return { output, ...(semanticVersionFromText(output) ? { version: semanticVersionFromText(output) } : {}) };
  } catch {
    return undefined;
  }
}

function piIdentityVersion(output: string): string | undefined {
  const version = semanticVersionFromText(output);
  if (!version) return undefined;
  const identifiesPi = output.split(/\r?\n/).some((line) =>
    /(?:^|[\s/@-])pi(?:-coding-agent)?(?:$|[\s:@-])/i.test(line) && line.includes(version));
  return identifiesPi ? version : undefined;
}

export function inspectPiRuntimeReadiness(
  env: NodeJS.ProcessEnv = process.env,
): PiRuntimeReadiness {
  const configured = env.COSYNCING_PI_BIN?.trim() || 'pi';
  const executable = resolveExecutable(configured, env);
  if (!executable) {
    return unsupportedReadiness(
      'pi-binary-missing',
      'Pi is not installed or is not visible to the broker service. Install Pi, then restart cosyncing.',
    );
  }

  const prefix = readPrefix(executable);
  if (prefix === undefined) {
    return unsupportedReadiness(
      'pi-launcher-unreadable',
      'Pi is installed, but its launcher cannot be inspected safely. Repair the Pi installation, then restart cosyncing.',
      { executable },
    );
  }
  const nodeCommand = nodeCommandFromShebang(prefix);
  if (nodeCommand === null) {
    const probe = boundedVersionProbe(executable, env);
    const version = probe ? piIdentityVersion(probe.output) : undefined;
    if (!version) {
      return unsupportedReadiness(
        'pi-native-identity-unverified',
        'The configured Pi executable does not provide a bounded, recognizable Pi version response. Point COSYNCING_PI_BIN at the supported Pi executable, then restart cosyncing.',
        { executable },
      );
    }
    const comparison = compareSemanticVersions(version, PI_MINIMUM_SUPPORTED_VERSION);
    if (comparison === undefined || comparison < 0) {
      return unsupportedReadiness(
        'pi-native-version-below-minimum',
        `The configured Pi executable is Pi ${version}, but ${PI_MINIMUM_SUPPORTED_VERSION} or newer is required. Upgrade Pi, then restart cosyncing.`,
        { executable, packageVersion: version },
      );
    }
    return {
      ready: true,
      detailCode: 'pi-native-runtime-ready',
      message: `Pi ${version} uses a verified native runtime and is available for session creation.`,
      executable,
      packageVersion: version,
    };
  }
  if (!nodeCommand) {
    return unsupportedReadiness(
      'pi-node-interpreter-unresolved',
      'Pi uses a launcher whose effective Node interpreter cannot be verified. Point COSYNCING_PI_BIN at the supported Pi executable or repair its launcher.',
      { executable },
    );
  }

  const nodeExecutable = resolveExecutable(nodeCommand, env);
  const contract = packageRuntimeContract(executable, (path) => {
    try {
      const stat = statSync(path);
      if (!stat.isFile() || stat.size > PACKAGE_JSON_MAX_BYTES) return undefined;
      return readFileSync(path, 'utf8');
    } catch {
      return undefined;
    }
  });
  const evidence = {
    executable,
    ...(nodeExecutable ? { nodeExecutable } : {}),
    requiredNodeVersion: contract.minimumNodeVersion,
    ...(contract.version ? { packageVersion: contract.version } : {}),
  };
  if (!nodeExecutable) {
    return unsupportedReadiness(
      'pi-node-interpreter-missing',
      `Pi requires Node ${contract.minimumNodeVersion} or newer, but its effective Node interpreter is not on the broker service PATH. Upgrade/configure Node, then restart cosyncing.`,
      evidence,
    );
  }

  const nodeVersion = boundedVersionProbe(nodeExecutable, env)?.version;
  if (!nodeVersion) {
    return unsupportedReadiness(
      'pi-node-version-unavailable',
      `Pi requires Node ${contract.minimumNodeVersion} or newer, but the effective interpreter version could not be verified. Repair Node, then restart cosyncing.`,
      evidence,
    );
  }
  const supported = compareSemanticVersions(nodeVersion, contract.minimumNodeVersion);
  if (supported === undefined || supported < 0) {
    return unsupportedReadiness(
      'pi-node-version-below-minimum',
      `Pi requires Node ${contract.minimumNodeVersion} or newer, but its effective interpreter is Node ${nodeVersion}. Upgrade Node and ensure the broker service PATH or COSYNCING_PI_BIN resolves Pi through it, then restart cosyncing.`,
      { ...evidence, nodeVersion },
    );
  }
  return {
    ready: true,
    detailCode: 'pi-node-runtime-supported',
    message: `Pi uses supported Node ${nodeVersion}.`,
    ...evidence,
    nodeVersion,
  };
}

let readinessCache: { key: string; at: number; value: PiRuntimeReadiness } | undefined;

export function currentPiRuntimeReadiness(): PiRuntimeReadiness {
  const key = `${process.env.COSYNCING_PI_BIN ?? ''}\0${process.env.PATH ?? ''}`;
  const now = Date.now();
  if (readinessCache && readinessCache.key === key && now - readinessCache.at < RUNTIME_CACHE_TTL_MS) {
    return readinessCache.value;
  }
  const value = inspectPiRuntimeReadiness(process.env);
  readinessCache = { key, at: now, value };
  return value;
}

export function resetPiRuntimeReadinessCache(): void {
  readinessCache = undefined;
}

export async function diagnosePiNodeRuntime(
  context: SetupDiagnosisContext,
  executable: string | undefined,
): Promise<import('@cosyncing/adapter-api').SetupCheck> {
  if (!executable) {
    return {
      id: 'pi.node-runtime',
      status: 'skip',
      detailCode: 'node-runtime-binary-missing',
      summary: 'Pi Node runtime was not checked because Pi is missing.',
    };
  }
  const launcher = context.readText(executable, 8 * 1024 * 1024);
  if (!launcher.ok) {
    return {
      id: 'pi.node-runtime',
      status: 'fail',
      detailCode: 'node-runtime-launcher-unreadable',
      summary: 'Pi is installed, but its launcher cannot be inspected safely.',
      remediation: { kind: 'manual', message: 'Repair the Pi installation, then rerun doctor.' },
    };
  }
  const nodeCommand = nodeCommandFromShebang(launcher.text.slice(0, LAUNCHER_PREFIX_MAX_BYTES));
  if (nodeCommand === null) {
    const probe = await context.runReadOnly(executable, ['--version'], 3_000);
    const version = probe.status === 'ok' ? piIdentityVersion(`${probe.stdout}\n${probe.stderr}`) : undefined;
    const comparison = version ? compareSemanticVersions(version, PI_MINIMUM_SUPPORTED_VERSION) : undefined;
    if (!version || comparison === undefined || comparison < 0) {
      return {
        id: 'pi.node-runtime',
        status: 'fail',
        detailCode: version ? 'native-runtime-version-below-minimum' : 'native-runtime-identity-unverified',
        summary: version
          ? `The configured Pi executable is Pi ${version}, but ${PI_MINIMUM_SUPPORTED_VERSION} or newer is required.`
          : 'The configured Pi executable did not provide a recognizable Pi version response.',
        ...(version ? { evidence: { installedVersion: version, minimumVersion: PI_MINIMUM_SUPPORTED_VERSION } } : {}),
        remediation: {
          kind: 'manual',
          message: 'Point COSYNCING_PI_BIN at the supported Pi executable, then restart cosyncing.',
        },
      };
    }
    return {
      id: 'pi.node-runtime',
      status: 'pass',
      detailCode: 'native-runtime-ready',
      summary: `Pi ${version} uses a verified native executable and does not depend on Node launcher compatibility.`,
      evidence: { installedVersion: version, minimumVersion: PI_MINIMUM_SUPPORTED_VERSION },
    };
  }
  const contract = packageRuntimeContract(executable, (path) => {
    const read = context.readText(path, PACKAGE_JSON_MAX_BYTES);
    return read.ok ? read.text : undefined;
  });
  const remediation = {
    kind: 'manual' as const,
    message: `Install Node ${contract.minimumNodeVersion} or newer, ensure the durable broker service PATH selects it, then restart cosyncing.`,
  };
  if (!nodeCommand) {
    return {
      id: 'pi.node-runtime',
      status: 'fail',
      detailCode: 'node-runtime-interpreter-unresolved',
      summary: 'Pi launcher runtime could not be verified.',
      remediation,
    };
  }
  const nodeExecutable = context.resolveExecutable(nodeCommand);
  if (!nodeExecutable) {
    return {
      id: 'pi.node-runtime',
      status: 'fail',
      detailCode: 'node-runtime-interpreter-missing',
      summary: `Pi requires Node ${contract.minimumNodeVersion} or newer, but its effective interpreter is unavailable.`,
      evidence: { minimumVersion: contract.minimumNodeVersion },
      remediation,
    };
  }
  const probe = await context.runReadOnly(nodeExecutable, ['--version'], 3_000);
  const nodeVersion = semanticVersionFromText(`${probe.stdout}\n${probe.stderr}`);
  const comparison = nodeVersion
    ? compareSemanticVersions(nodeVersion, contract.minimumNodeVersion)
    : undefined;
  if (!nodeVersion || comparison === undefined || comparison < 0) {
    return {
      id: 'pi.node-runtime',
      status: 'fail',
      detailCode: nodeVersion ? 'node-runtime-below-minimum' : 'node-runtime-version-unavailable',
      summary: nodeVersion
        ? `Pi requires Node ${contract.minimumNodeVersion} or newer, but its effective interpreter is Node ${nodeVersion}.`
        : `Pi requires Node ${contract.minimumNodeVersion} or newer, but its effective interpreter version could not be verified.`,
      evidence: {
        executable: context.displayPath(nodeExecutable),
        minimumVersion: contract.minimumNodeVersion,
        ...(nodeVersion ? { installedVersion: nodeVersion } : {}),
      },
      remediation,
    };
  }
  return {
    id: 'pi.node-runtime',
    status: 'pass',
    detailCode: 'node-runtime-supported',
    summary: `Pi effective Node ${nodeVersion} satisfies the installed distribution floor.`,
    evidence: {
      executable: context.displayPath(nodeExecutable),
      installedVersion: nodeVersion,
      minimumVersion: contract.minimumNodeVersion,
    },
  };
}
