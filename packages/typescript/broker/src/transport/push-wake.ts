import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type {
  WakePlatform,
  WakePushDispatchResult,
  WakePushErrorCode,
  WakeRegistrationInput,
  WakeRegistrationPublic,
} from '@cosyncing/protocol';
import { setupStateHome } from '../installation/setup-state.ts';

export interface WakeRegistration {
  deviceId: string;
  owner: WakeRegistrationOwner;
  platform: WakePlatform;
  token: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
}

export type WakeRegistrationOwner =
  | { kind: 'owner' }
  | { kind: 'peer'; peerId: string; authGeneration: number };

export interface DeviceWakeCoalescerOptions<TTimer = ReturnType<typeof setTimeout>> {
  dispatch: (registration: WakeRegistration) => Promise<unknown> | unknown;
  windowMs?: number;
  now?: () => number;
  setTimer?: (callback: () => void, delayMs: number) => TTimer;
  clearTimer?: (timer: TTimer) => void;
  onError?: (error: unknown, registration: WakeRegistration) => void;
}

type DeviceWakeState<TTimer> = {
  nextAllowedAt: number;
  timer?: TTimer;
  pending?: WakeRegistration;
  pendingWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
};

/** Coalesces content-free provider wakes per device while durable events remain independent. */
export class DeviceWakeCoalescer<TTimer = ReturnType<typeof setTimeout>> {
  private readonly states = new Map<string, DeviceWakeState<TTimer>>();
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, delayMs: number) => TTimer;
  private readonly clearTimer: (timer: TTimer) => void;

  constructor(private readonly options: DeviceWakeCoalescerOptions<TTimer>) {
    this.windowMs = Math.max(1, options.windowMs ?? 30_000);
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs) as TTimer);
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  }

  request(registration: WakeRegistration): Promise<void> {
    const now = this.now();
    let state = this.states.get(registration.deviceId);
    if (!state) {
      state = { nextAllowedAt: now + this.windowMs, pendingWaiters: [] };
      this.states.set(registration.deviceId, state);
      const dispatched = this.dispatch(registration);
      this.arm(registration.deviceId, state);
      return dispatched;
    }

    if (now >= state.nextAllowedAt) {
      if (state.timer !== undefined) this.clearTimer(state.timer);
      state.timer = undefined;
      const waiters = state.pendingWaiters;
      state.pendingWaiters = [];
      state.pending = undefined;
      state.nextAllowedAt = now + this.windowMs;
      const dispatched = this.dispatch(registration);
      void dispatched.then(
        () => { for (const waiter of waiters) waiter.resolve(); },
        (error) => { for (const waiter of waiters) waiter.reject(error); },
      );
      this.arm(registration.deviceId, state);
      return dispatched;
    }

    state.pending = registration;
    return new Promise<void>((resolve, reject) => state!.pendingWaiters.push({ resolve, reject }));
  }

  stop(): void {
    for (const state of this.states.values()) {
      if (state.timer !== undefined) this.clearTimer(state.timer);
      for (const waiter of state.pendingWaiters) waiter.reject(new Error('wake coalescer stopped'));
    }
    this.states.clear();
  }

  private arm(deviceId: string, state: DeviceWakeState<TTimer>): void {
    const delay = Math.max(0, state.nextAllowedAt - this.now());
    state.timer = this.setTimer(() => {
      state.timer = undefined;
      const pending = state.pending;
      const waiters = state.pendingWaiters;
      state.pending = undefined;
      state.pendingWaiters = [];
      if (!pending) {
        this.states.delete(deviceId);
        for (const waiter of waiters) waiter.resolve();
        return;
      }
      state.nextAllowedAt = this.now() + this.windowMs;
      void this.dispatch(pending).then(
        () => { for (const waiter of waiters) waiter.resolve(); },
        (error) => { for (const waiter of waiters) waiter.reject(error); },
      );
      this.arm(deviceId, state);
    }, delay);
    (state.timer as { unref?: () => unknown }).unref?.();
  }

  private async dispatch(registration: WakeRegistration): Promise<void> {
    try {
      await this.options.dispatch(registration);
    } catch (error) {
      this.options.onError?.(error, registration);
      throw error;
    }
  }
}

interface LegacyWakeStoreFile {
  version: 1;
  registrations: unknown[];
}

interface WakeStoreFile {
  version: 2;
  registrations: WakeRegistration[];
}

export const WAKE_REGISTRATION_GLOBAL_MAX = 256;
export const WAKE_REGISTRATION_PEER_MAX = 4;
const WAKE_REGISTRATION_MUTATIONS_PER_MINUTE = 30;

export interface WakePushRegistryOptions {
  now?: () => number;
  isPeerGenerationActive?: (peerId: string, authGeneration: number) => boolean;
  globalMax?: number;
  peerMax?: number;
  mutationsPerMinute?: number;
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
  private readonly mutationWindows = new Map<string, { startedAt: number; count: number }>();
  private readonly now: () => number;
  private readonly isPeerGenerationActive: (peerId: string, authGeneration: number) => boolean;
  private readonly globalMax: number;
  private readonly peerMax: number;
  private readonly mutationsPerMinute: number;

  constructor(home = setupStateHome(), options: WakePushRegistryOptions = {}) {
    this.path = join(home, 'push-wake-tokens.json');
    this.now = options.now ?? Date.now;
    this.isPeerGenerationActive = options.isPeerGenerationActive ?? (() => true);
    this.globalMax = positiveLimit(options.globalMax, WAKE_REGISTRATION_GLOBAL_MAX);
    this.peerMax = positiveLimit(options.peerMax, WAKE_REGISTRATION_PEER_MAX);
    this.mutationsPerMinute = positiveLimit(options.mutationsPerMinute, WAKE_REGISTRATION_MUTATIONS_PER_MINUTE);
    this.load();
  }

  register(input: WakeRegistrationInput, owner: WakeRegistrationOwner): WakeRegistrationPublic {
    const platform = normalizePlatform(input.platform);
    const token = String(input.token ?? '').trim();
    if (!token) throw new WakePushError('BAD_PARAM', 'push token is required');
    if (token.length > 4096) throw new WakePushError('BAD_PARAM', 'push token is too long');
    const requestedDeviceId = normalizeDeviceId(input.deviceId);
    if (owner.kind === 'peer' && !requestedDeviceId) {
      throw new WakePushError('BAD_PARAM', 'deviceId is required for paired devices');
    }
    const deviceId = registrationId(owner, requestedDeviceId);
    const now = new Date(this.now()).toISOString();
    const prior = this.registrations.get(deviceId);
    const label = input.label
      ? String(input.label).trim().slice(0, 80)
      : prior?.label;
    if (prior
      && registrationOwnerEquals(prior.owner, owner)
      && prior.platform === platform
      && prior.token === token
      && prior.label === label) {
      return publicRegistration(prior);
    }
    if (!prior) {
      if (this.registrations.size >= this.globalMax) {
        throw new WakePushError('BAD_PARAM', 'push registration limit reached', 429);
      }
      if (owner.kind === 'peer') {
        const peerRegistrations = [...this.registrations.values()]
          .filter((registration) => registrationOwnerEquals(registration.owner, owner)).length;
        if (peerRegistrations >= this.peerMax) {
          throw new WakePushError('BAD_PARAM', 'paired-device push registration limit reached', 429);
        }
      }
    }
    this.assertMutationAllowed(owner);
    const registration: WakeRegistration = {
      deviceId,
      owner,
      platform,
      token,
      ...(label ? { label } : {}),
      createdAt: prior?.createdAt ?? now,
      updatedAt: now,
    };
    this.registrations.set(deviceId, registration);
    this.save();
    return publicRegistration(registration);
  }

  list(owner: WakeRegistrationOwner): WakeRegistrationPublic[] {
    return [...this.registrations.values()]
      .filter((registration) => owner.kind === 'owner' || registrationOwnerEquals(registration.owner, owner))
      .map(publicRegistration)
      .sort((a, b) => a.deviceId.localeCompare(b.deviceId));
  }

  /** Broker-internal delivery view. Never return this from an HTTP route or write it to logs. */
  listForDispatch(): WakeRegistration[] {
    return [...this.registrations.values()]
      .filter((registration) => this.dispatchable(registration))
      .map((registration) => ({ ...registration }));
  }

  get(deviceId: string, owner: WakeRegistrationOwner): WakeRegistration {
    const id = normalizeDeviceId(deviceId);
    const registration = id ? this.registrations.get(id) : undefined;
    if (!registration || (owner.kind !== 'owner' && !registrationOwnerEquals(registration.owner, owner))) {
      throw new WakePushError('PUSH_TOKEN_NOT_FOUND', 'push token not found', 404);
    }
    return registration;
  }

  /** Broker-internal lookup for attention delivery. */
  getForDispatch(deviceId: string): WakeRegistration {
    const id = normalizeDeviceId(deviceId);
    const registration = id ? this.registrations.get(id) : undefined;
    if (!registration || !this.dispatchable(registration)) {
      throw new WakePushError('PUSH_TOKEN_NOT_FOUND', 'push token not found', 404);
    }
    return registration;
  }

  revoke(deviceId: string, owner: WakeRegistrationOwner): boolean {
    const id = normalizeDeviceId(deviceId);
    if (!id) throw new WakePushError('BAD_PARAM', 'deviceId is required');
    const registration = this.registrations.get(id);
    if (!registration || (owner.kind !== 'owner' && !registrationOwnerEquals(registration.owner, owner))) {
      return false;
    }
    const deleted = this.registrations.delete(id);
    if (deleted) this.save();
    return deleted;
  }

  revokePeer(peerId: string): number {
    let removed = 0;
    for (const [deviceId, registration] of this.registrations) {
      if (registration.owner.kind !== 'peer' || registration.owner.peerId !== peerId) continue;
      this.registrations.delete(deviceId);
      removed++;
    }
    if (removed) this.save();
    return removed;
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    let parsed: LegacyWakeStoreFile | WakeStoreFile;
    try {
      parsed = JSON.parse(readFileSync(this.path, 'utf8')) as LegacyWakeStoreFile | WakeStoreFile;
    } catch {
      this.registrations.clear();
      return;
    }
    if (!Array.isArray(parsed.registrations)) return;
    if (parsed.version === 1) {
      // Revision-16 records do not say which credential registered the endpoint. They cannot be
      // promoted to owner authority safely, so persist an empty v2 store before startup continues.
      this.save();
      return;
    }
    if (parsed.version !== 2) return;
    for (const raw of parsed.registrations) {
      const normalized = normalizeStored(raw);
      if (normalized) this.registrations.set(normalized.deviceId, normalized);
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 2, registrations: [...this.registrations.values()] } satisfies WakeStoreFile, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  private dispatchable(registration: WakeRegistration): boolean {
    return registration.owner.kind === 'owner'
      || this.isPeerGenerationActive(registration.owner.peerId, registration.owner.authGeneration);
  }

  private assertMutationAllowed(owner: WakeRegistrationOwner): void {
    if (owner.kind !== 'peer') return;
    const key = `${owner.peerId}:${owner.authGeneration}`;
    const now = this.now();
    const window = this.mutationWindows.get(key);
    if (!window || now - window.startedAt >= 60_000) {
      this.mutationWindows.set(key, { startedAt: now, count: 1 });
      return;
    }
    if (window.count >= this.mutationsPerMinute) {
      throw new WakePushError('BAD_PARAM', 'push registration updates are rate limited', 429);
    }
    window.count += 1;
  }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
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
      owner: normalizeStoredOwner(raw?.owner),
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

function registrationId(owner: WakeRegistrationOwner, requestedDeviceId: string | undefined): string {
  if (owner.kind === 'owner') return requestedDeviceId ?? `dev_${randomBytes(9).toString('base64url')}`;
  const source = requestedDeviceId ?? `dev_${randomBytes(9).toString('base64url')}`;
  const digest = createHash('sha256')
    .update(`${owner.peerId}\0${owner.authGeneration}\0${source}`)
    .digest('base64url')
    .slice(0, 24);
  return `peer_${digest}`;
}

function registrationOwnerEquals(a: WakeRegistrationOwner, b: WakeRegistrationOwner): boolean {
  return a.kind === b.kind
    && (a.kind === 'owner'
      || (b.kind === 'peer' && a.peerId === b.peerId && a.authGeneration === b.authGeneration));
}

function normalizeStoredOwner(raw: unknown): WakeRegistrationOwner {
  if (!raw || typeof raw !== 'object') throw new Error('wake-registration-owner-invalid');
  const value = raw as Record<string, unknown>;
  if (value.kind === 'owner') return { kind: 'owner' };
  if (value.kind === 'peer'
    && typeof value.peerId === 'string'
    && Number.isSafeInteger(value.authGeneration)
    && Number(value.authGeneration) > 0) {
    return {
      kind: 'peer',
      peerId: value.peerId,
      authGeneration: Number(value.authGeneration),
    };
  }
  throw new Error('wake-registration-owner-invalid');
}
