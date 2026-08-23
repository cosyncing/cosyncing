const MAX_PAIRING_BROKER_URL_LENGTH = 2_048;

export class PairingBrokerUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PairingBrokerUrlError';
  }
}

/** Validate and normalize a client-reachable URL without probing it. */
export function normalizePairingBrokerUrl(value: unknown): string | undefined {
  if (value == null || value === '') return undefined;
  if (typeof value !== 'string') throw new PairingBrokerUrlError('brokerUrl must be a string');
  if (value.length > MAX_PAIRING_BROKER_URL_LENGTH || /[\0-\x1f\x7f]/.test(value)) {
    throw new PairingBrokerUrlError('brokerUrl is empty, too long, or contains control characters');
  }
  const raw = value.trim();
  if (!raw) throw new PairingBrokerUrlError('brokerUrl is empty');
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new PairingBrokerUrlError('brokerUrl must be an absolute HTTP or HTTPS URL');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
    throw new PairingBrokerUrlError('brokerUrl must be an absolute HTTP or HTTPS URL with a hostname');
  }
  if (parsed.username || parsed.password) throw new PairingBrokerUrlError('brokerUrl must not contain credentials');
  if (parsed.search || parsed.hash) throw new PairingBrokerUrlError('brokerUrl must not contain a query or fragment');
  if (parsed.pathname !== '' && parsed.pathname !== '/') {
    throw new PairingBrokerUrlError('brokerUrl must be an origin without a path');
  }
  return parsed.origin;
}

export function pairingBrokerUrlUsesUnprotectedHttp(url: string): boolean {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:') return false;
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return host !== 'localhost' && host !== '::1' && !host.startsWith('127.');
}
