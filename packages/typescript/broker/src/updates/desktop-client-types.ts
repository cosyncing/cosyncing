/** Desktop archives have their own signed manifest table, separate from broker host artifacts. */
export const DESKTOP_CLIENT_HOSTS = ['windows-x64', 'macos-arm64', 'linux-x64'] as const;
export type DesktopClientHost = typeof DESKTOP_CLIENT_HOSTS[number];

export interface ReleaseDesktopClient {
  name: string;
  version: string;
  size: number;
  sha256: string;
  url: string;
}

export type ReleaseDesktopClients = Partial<Record<DesktopClientHost, ReleaseDesktopClient>>;

export function desktopClientAssetName(host: DesktopClientHost, version: string): string {
  const extension = host === 'linux-x64' ? '.tar.gz' : '-unsigned.zip';
  return `cosyncing-client-${version}-${host}${extension}`;
}

/** Optional rows must remain bound to this release's version and asset identity. */
export function validDesktopClients(value: unknown, version: string): value is ReleaseDesktopClients {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  return Object.entries(value).every(([host, row]) => {
    if (!(DESKTOP_CLIENT_HOSTS as readonly string[]).includes(host)
        || !row || typeof row !== 'object' || Array.isArray(row)) return false;
    const item = row as Record<string, unknown>;
    if (item.name !== desktopClientAssetName(host as DesktopClientHost, version)
        || item.version !== version
        || !Number.isSafeInteger(item.size) || Number(item.size) <= 0
        || Number(item.size) > 256 * 1024 * 1024
        || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)
        || typeof item.url !== 'string' || item.url.length > 2_048 || /[\0\r\n]/.test(item.url)) return false;
    try {
      const url = new URL(item.url);
      return url.protocol === 'https:' && !url.username && !url.password;
    } catch { return false; }
  });
}

export interface DesktopClientOutcome {
  status: 'updated' | 'current' | 'skipped' | 'failed';
  detailCode: string;
  clause: string;
}
