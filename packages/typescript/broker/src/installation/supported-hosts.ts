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
 * so `["darwin"] x ["x64","arm64"]` necessarily admits both). The package therefore constrains what it can
 * — no Windows — and the product tells the truth about the rest at diagnosis time.
 */
export interface SupportedBrokerHost {
  platform: 'linux' | 'darwin';
  arch: 'x64' | 'arm64';
}

export const SUPPORTED_BROKER_HOSTS: readonly SupportedBrokerHost[] = Object.freeze([
  Object.freeze({ platform: 'linux', arch: 'x64' } as const),
  Object.freeze({ platform: 'linux', arch: 'arm64' } as const),
  Object.freeze({ platform: 'darwin', arch: 'arm64' } as const),
]);

/** The distinct `os` values an npm manifest may declare. Windows is absent because it is not supported. */
export const SUPPORTED_BROKER_PACKAGE_OS: readonly string[] = Object.freeze(
  [...new Set(SUPPORTED_BROKER_HOSTS.map((host) => host.platform))],
);

/** The distinct `cpu` values an npm manifest may declare. */
export const SUPPORTED_BROKER_PACKAGE_CPU: readonly string[] = Object.freeze(
  [...new Set(SUPPORTED_BROKER_HOSTS.map((host) => host.arch))],
);

export function isSupportedBrokerHost(platform: string, arch: string): boolean {
  return SUPPORTED_BROKER_HOSTS.some((host) => host.platform === platform && host.arch === arch);
}

/** `linux-x64, linux-arm64, and darwin-arm64`, for operator-facing copy that must not drift from the list. */
export function supportedBrokerHostList(): string {
  return SUPPORTED_BROKER_HOSTS.map((host) => `${host.platform}-${host.arch}`).join(', ');
}
