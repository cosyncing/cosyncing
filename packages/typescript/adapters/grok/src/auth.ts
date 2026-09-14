import type { AcpClient, AcpInitializeResult } from '@cosyncing/acp-client';

const MAX_AUTH_METHODS = 32;
const MAX_AUTH_ID_CHARS = 128;

function advertisedAuthIds(result: AcpInitializeResult | null | undefined): Set<string> | undefined {
  const raw = result?.authMethods;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_AUTH_METHODS) return undefined;
  const ids = new Set<string>();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== 'string' || id.length === 0 || id.length > MAX_AUTH_ID_CHARS || ids.has(id)) return undefined;
    ids.add(id);
  }
  return ids;
}

export function grokAuthMethod(
  result: AcpInitializeResult | null | undefined,
  configured?: string,
): string {
  const advertised = advertisedAuthIds(result);
  if (!advertised) throw new Error('Grok ACP returned a missing or malformed authentication catalog.');
  if (configured) {
    if (!advertised.has(configured)) {
      throw new Error(`Grok ACP did not advertise configured auth method ${configured}.`);
    }
    return configured;
  }
  const meta = result?._meta;
  const nativeDefault = meta && typeof meta === 'object' && !Array.isArray(meta)
    ? (meta as { defaultAuthMethodId?: unknown }).defaultAuthMethodId
    : undefined;
  if (nativeDefault === 'cached_token' && advertised.has(nativeDefault)) return nativeDefault;
  if (advertised.has('cached_token')) return 'cached_token';
  throw new Error('Grok ACP has no reusable cached_token authentication; run grok login first.');
}

export async function authenticateGrokClient(client: AcpClient, configured?: string): Promise<void> {
  const advertised = advertisedAuthIds(client.initializeResult);
  const method = grokAuthMethod(client.initializeResult, configured);
  if (!advertised?.has(method)) throw new Error('Grok ACP authentication catalog changed before authentication.');
  await client.authenticate({ methodId: method });
}
