import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  WakePlatform,
  WakePushDispatchResult,
  WakePushErrorCode,
  WakeRegistrationInput,
  WakeRegistrationPublic,
} from '@cosyncing/protocol';
import { setupStateHome } from './setup-state.ts';

export interface WakeRegistration {
  deviceId: string;
  platform: WakePlatform;
  token: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
}

interface WakeStoreFile {
  version: 1;
  registrations: WakeRegistration[];
}

export class WakePushError extends Error {
  constructor(
    readonly code: WakePushErrorCode,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

export class WakePushRegistry {
  private readonly path: string;
  private readonly registrations = new Map<string, WakeRegistration>();

  constructor(home = setupStateHome()) {
    this.path = join(home, 'push-wake-tokens.json');
    this.load();
  }

  register(input: WakeRegistrationInput): WakeRegistrationPublic {
    const platform = normalizePlatform(input.platform);
    const token = String(input.token ?? '').trim();
    if (!token) throw new WakePushError('BAD_PARAM', 'push token is required');
    if (token.length > 4096) throw new WakePushError('BAD_PARAM', 'push token is too long');
    const deviceId = normalizeDeviceId(input.deviceId) ?? `dev_${randomBytes(9).toString('base64url')}`;
    const now = new Date().toISOString();
    const prior = this.registrations.get(deviceId);
    const registration: WakeRegistration = {
      deviceId,
      platform,
      token,
      ...(input.label ? { label: String(input.label).trim().slice(0, 80) } : prior?.label ? { label: prior.label } : {}),
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
    this.registrations.set(deviceId, registration);
    this.save();
    return publicRegistration(registration);
  }

  list(): WakeRegistrationPublic[] {
    return [...this.registrations.values()].map(publicRegistration).sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  /** Broker-internal delivery view. Never return this from an HTTP route or write it to logs. */
  listForDispatch(): WakeRegistration[] {
    return [...this.registrations.values()].map((registration) => ({ ...registration }));
  }

  get(deviceId: string): WakeRegistration {
    const id = normalizeDeviceId(deviceId);
    const registration = id ? this.registrations.get(id) : undefined;
    if (!registration) throw new WakePushError('PUSH_TOKEN_NOT_FOUND', 'push token not found', 404);
    return registration;
  }

  revoke(deviceId: string): boolean {
    const id = normalizeDeviceId(deviceId);
    if (!id) throw new WakePushError('BAD_PARAM', 'deviceId is required');
    const deleted = this.registrations.delete(id);
    if (deleted) this.save();
    return deleted;
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as WakeStoreFile;
      if (parsed.version !== 1 || !Array.isArray(parsed.registrations)) return;
      for (const raw of parsed.registrations) {
        const normalized = normalizeStored(raw);
        if (normalized) this.registrations.set(normalized.deviceId, normalized);
      }
    } catch {
      this.registrations.clear();
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, registrations: [...this.registrations.values()] } satisfies WakeStoreFile, null, 2) + '\n');
    renameSync(tmp, this.path);
  }
}

export async function dispatchWakePush(
  registration: WakeRegistration,
  /** `reason` remains accepted for source compatibility but is deliberately ignored: the provider
   *  sees one constant opaque wake marker on every manual and automatic path. Governing UX/privacy:
   *  docs/architecture/client-ui.md */
  opts: { reason?: string; fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<WakePushDispatchResult> {
  const webhook = process.env.COSYNCING_WAKE_PUSH_WEBHOOK?.trim();
  if (!webhook) throw new WakePushError('PUSH_NOT_CONFIGURED', 'wake push provider is not configured', 501);
  const fetchImpl = opts.fetch ?? fetch;
  const configuredTimeout = opts.timeoutMs ?? Number(process.env.COSYNCING_WAKE_PUSH_TIMEOUT_MS ?? 5000);
  const timeoutMs = Math.max(1, Number.isFinite(configuredTimeout) ? configuredTimeout : 5000);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetchImpl(webhook, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        platform: registration.platform,
        token: registration.token,
        type: 'wake',
        // Intentionally no reason, session id, event kind/id, prompt, transcript, or approval data.
      }),
    });
  } catch (err) {
    const timedOut = ac.signal.aborted || (err instanceof Error && err.name === 'AbortError');
    throw new WakePushError('PUSH_DELIVERY_FAILED', timedOut ? `wake push provider timed out after ${timeoutMs}ms` : `wake push provider failed: ${err instanceof Error ? err.message : String(err)}`, 502);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new WakePushError('PUSH_DELIVERY_FAILED', `wake push provider returned HTTP ${res.status}`, 502);
  return { ok: true, deviceId: registration.deviceId, platform: registration.platform, provider: 'webhook' };
}

function normalizePlatform(raw: unknown): WakePlatform {
  if (raw === 'apns' || raw === 'fcm') return raw;
  throw new WakePushError('BAD_PARAM', 'platform must be apns or fcm');
}

function normalizeDeviceId(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'string') throw new WakePushError('BAD_PARAM', 'deviceId must be a string');
  const id = raw.trim();
  if (!id) return undefined;
  if (id.length > 120 || !/^[A-Za-z0-9._:-]+$/.test(id)) throw new WakePushError('BAD_PARAM', 'deviceId must be a short ASCII token');
  return id;
}

function tokenPreview(token: string): string {
  if (token.length <= 12) return `${token.slice(0, 3)}...${token.slice(-3)}`;
  return `${token.slice(0, 6)}...${token.slice(-6)}`;
}

function publicRegistration(registration: WakeRegistration): WakeRegistrationPublic {
  return {
    deviceId: registration.deviceId,
    platform: registration.platform,
    tokenPreview: tokenPreview(registration.token),
    ...(registration.label ? { label: registration.label } : {}),
    createdAt: registration.createdAt,
    updatedAt: registration.updatedAt,
  };
}

function normalizeStored(raw: any): WakeRegistration | undefined {
  try {
    const platform = normalizePlatform(raw?.platform);
    const deviceId = normalizeDeviceId(raw?.deviceId);
    const token = typeof raw?.token === 'string' ? raw.token : '';
    if (!deviceId || !token) return undefined;
    return {
      deviceId,
      platform,
      token,
      ...(raw.label ? { label: String(raw.label) } : {}),
      createdAt: String(raw.createdAt ?? new Date(0).toISOString()),
      updatedAt: String(raw.updatedAt ?? new Date(0).toISOString()),
    };
  } catch {
    return undefined;
  }
}
