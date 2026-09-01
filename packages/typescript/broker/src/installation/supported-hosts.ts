/**
 * The hosts a cosyncing BROKER is supported on, in one place.
 *
 * This mattered less when every distribution was a compiled per-target binary: an unsupported host simply had
 * no artifact to install, and the absence was the refusal. One universal JavaScript bundle removes that
 * accident — it will happily run anywhere a supported Bun runs, including hosts this project has never
 * verified. So the supported set has to be stated explicitly and enforced, rather than inferred from which
 * binaries happen to exist.
 *
 * Intel macOS is the concrete case: `darwin` + `x64` is not a verified broker host, and an npm `os`/`cpu`
 * constraint cannot exclude it without also excluding Apple Silicon (the two fields are independent lists,
 * so `["darwin"] x ["x64","arm64"]` necessarily admits both). Windows ARM64 is now the same case for the
 * same reason: `["win32"] x ["x64","arm64"]` admits it, and narrowing `cpu` would exclude linux-arm64 and
 * darwin-arm64, which ARE supported. The package therefore constrains what it can, and the product tells
 * the truth about the rest at diagnosis time — which is what `brokerHostVerdict` below is for.
 */
export interface SupportedBrokerHost {
  platform: 'linux' | 'darwin' | 'win32';
  arch: 'x64' | 'arm64';
}

export const SUPPORTED_BROKER_HOSTS: readonly SupportedBrokerHost[] = Object.freeze([
  Object.freeze({ platform: 'linux', arch: 'x64' } as const),
  Object.freeze({ platform: 'linux', arch: 'arm64' } as const),
  Object.freeze({ platform: 'darwin', arch: 'arm64' } as const),
  Object.freeze({ platform: 'win32', arch: 'x64' } as const),
]);

/**
 * Why a host was refused. Windows ARM64 has its own codes rather than sharing the generic one because the
 * honest statement is "not yet qualified", not "unsupported forever" and not "no runtime exists": Bun has
 * shipped a native Windows ARM64 build since 1.3.10, and nothing in this project has been run on it.
 */
export type BrokerHostRefusalCode =
  | 'host-architecture-unsupported'
  | 'windows-arm64-not-qualified'
  | 'windows-emulated-x64-not-qualified'
  | 'windows-machine-architecture-unverified';

export type BrokerHostVerdict =
  | { readonly status: 'supported' }
  | { readonly status: 'refused'; readonly code: BrokerHostRefusalCode; readonly summary: string; readonly remediation: string };

/** What the native machine is, independently of what this process was compiled for. */
export type WindowsMachineArchitecture = 'x64' | 'arm64' | 'other' | 'unknown';

const NOT_YET_QUALIFIED = 'Windows ARM64 is not yet qualified for this broker. Run the broker on Windows x64, '
  + 'or on a supported Linux or macOS host.';

/**
 * The one host verdict setup, doctor, and broker startup all use.
 *
 * On Windows it asks two questions, because one is not enough. `process.arch` describes the BINARY: an x64
 * Bun emulated on an ARM64 machine reports x64, so a check written against the process alone would admit
 * the emulated host silently and a refusal written against `arch === 'arm64'` would be dead code. The
 * machine is asked separately, and a machine that will not answer is refused rather than assumed — the
 * qualified surface here is DACLs, PowerShell, Task Scheduler services, and the two-pid `.cmd` shim, none
 * of which has been exercised under emulation.
 */
export function brokerHostVerdict(options: {
  readonly platform: string;
  readonly arch: string;
  readonly windowsMachineArchitecture?: () => WindowsMachineArchitecture;
}): BrokerHostVerdict {
  const { platform, arch } = options;
  if (platform !== 'win32') {
    return isSupportedBrokerProcessTuple(platform, arch)
      ? { status: 'supported' }
      : {
          status: 'refused',
          code: 'host-architecture-unsupported',
          summary: `${platform}-${arch} is not a supported broker host.`,
          remediation: `Run the broker on a supported host: ${supportedBrokerHostList()}.`,
        };
  }
  if (arch === 'arm64') {
    return {
      status: 'refused',
      code: 'windows-arm64-not-qualified',
      summary: 'Windows ARM64 is not a qualified broker host yet.',
      remediation: NOT_YET_QUALIFIED,
    };
  }
  if (!isSupportedBrokerProcessTuple(platform, arch)) {
    return {
      status: 'refused',
      code: 'host-architecture-unsupported',
      summary: `${platform}-${arch} is not a supported broker host.`,
      remediation: `Run the broker on a supported host: ${supportedBrokerHostList()}.`,
    };
  }
  const machine = options.windowsMachineArchitecture?.() ?? 'unknown';
  if (machine === 'arm64') {
    return {
      status: 'refused',
      code: 'windows-emulated-x64-not-qualified',
      summary: 'This is an x64 process emulated on an ARM64 Windows machine, which is not qualified yet.',
      remediation: NOT_YET_QUALIFIED,
    };
  }
  if (machine !== 'x64') {
    return {
      status: 'refused',
      code: 'windows-machine-architecture-unverified',
      summary: 'The native Windows machine architecture could not be verified, so this host is not proven qualified.',
      remediation: 'The broker asks Windows for the native machine architecture and refuses hosts it cannot '
        + 'identify. Ensure PowerShell is available to the broker, then rerun.',
    };
  }
  return { status: 'supported' };
}

/** The distinct `os` values an npm manifest may declare. */
export const SUPPORTED_BROKER_PACKAGE_OS: readonly string[] = Object.freeze(
  [...new Set(SUPPORTED_BROKER_HOSTS.map((host) => host.platform))],
);

/** The distinct `cpu` values an npm manifest may declare. */
export const SUPPORTED_BROKER_PACKAGE_CPU: readonly string[] = Object.freeze(
  [...new Set(SUPPORTED_BROKER_HOSTS.map((host) => host.arch))],
);

/**
 * Whether a platform/arch PAIR is in the supported set — the process tuple only.
 *
 * Not the runtime authority, and named so it cannot be mistaken for one: on Windows this returns true for
 * `win32-x64` without asking what the physical machine is, and an x64 process emulated on ARM64 presents
 * exactly that tuple. `brokerHostVerdict` is the check a host must pass.
 */
export function isSupportedBrokerProcessTuple(platform: string, arch: string): boolean {
  return SUPPORTED_BROKER_HOSTS.some((host) => host.platform === platform && host.arch === arch);
}

/** The supported host list, for operator-facing copy that must not drift from it. */
export function supportedBrokerHostList(): string {
  return SUPPORTED_BROKER_HOSTS.map((host) => `${host.platform}-${host.arch}`).join(', ');
}
