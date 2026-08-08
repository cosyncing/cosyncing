/**
 * R2 policy enforcement runtime (GPT-Pro §2 rules 1-5/20 + maintainer §4.5 defaults).
 *
 * The broker consults this GENERICALLY — never a tool-name branch. The reviewed action data lives in
 * `scripts/broker/capabilities/policies/r2-actions.ts` (single source of truth); this module adds the runtime
 * enforcement: trust-tier derivation, default-deny-for-non-loopback-unless-locally-enabled, the
 * confirmation nonce (bound to action/session/revision/format/redaction-mode/tier, ≤60s), and
 * conservative rate limits. Local enablement (`r2.enabledActions`) is read from the environment at
 * broker start and is NOT remotely togglable (rule 2 / do-not-build "no remote R2 toggle").
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { R2_ACTIONS, getR2Action } from '../../../../scripts/broker/capabilities/policies/r2-actions.ts';
import type { R2ActionDescriptor, TrustTier } from '../../../../scripts/broker/capabilities/types.ts';

export { R2_ACTIONS, getR2Action };
export type { R2ActionDescriptor, TrustTier };

/**
 * Fail-closed startup guard for the reviewed R2 registry (maintainer Decision #2, 2026-07-08). Enforces
 * the one invariant the confirm-nonce revision model depends on: a session-MUTATING R2 action may not
 * bind its confirmation to the weak `session-timestamp` revision (updatedAt ?? createdAt), because an
 * adapter that fails to bump `updatedAt` would let a stale confirm apply to changed content. Read-only
 * actions (transcriptExport) may use it. Called once at broker start; throws to refuse booting an
 * unsafe registry rather than silently shipping a weak binding.
 */
export function assertR2ActionsSafe(actions: R2ActionDescriptor[] = R2_ACTIONS): void {
  for (const a of actions) {
    if (a.mutatesSession && a.revisionBinding === 'session-timestamp') {
      throw new Error(
        `R2 action '${a.id}' mutates session state but binds the weak 'session-timestamp' revision; ` +
          `destructive actions require a content-derived revisionBinding (content-hash / last-message-id).`,
      );
    }
  }
}

/**
 * Derive the confirm-nonce "revision" for a session per the action's `revisionBinding`. Only the
 * cheap `session-timestamp` proxy is implemented today (the sole R2 action is read-only). Stronger
 * content-derived bindings need the discovery layer to surface the field first; until then they
 * fail closed (throw) rather than silently degrade to the timestamp — so a future destructive action
 * cannot ship a weak revision by omission.
 */
export function deriveSessionRevision(
  base: { updatedAt?: number | string | null; createdAt?: number | string | null },
  binding: R2ActionDescriptor['revisionBinding'],
): string {
  if (binding === 'session-timestamp') return String(base.updatedAt ?? base.createdAt ?? '');
  throw new Error(`revisionBinding '${binding}' is not yet implemented in the broker (fail-closed)`);
}

/** Local-only enablement allowlist for R2 on non-loopback (T2) clients. */
export function r2EnabledActions(): Set<string> {
  const raw = process.env.COSYNCING_R2_ENABLED_ACTIONS ?? '';
  return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
}

/** Effective per-artifact byte cap: default cap, or a local override clamped to the hard ceiling. */
export function r2MaxBytes(action: R2ActionDescriptor): number {
  const raw = process.env.COSYNCING_R2_MAX_BYTES;
  const override = raw == null || raw.trim() === '' ? Number.NaN : Number(raw);
  if (Number.isFinite(override) && override > 0) return Math.min(Math.floor(override), action.localMaxBytes);
  return action.sizeCapBytes;
}

/** Effective native invocation timeout, clamped to the hard local max. */
export function r2TimeoutMs(action: R2ActionDescriptor): number {
  const raw = process.env.COSYNCING_R2_TIMEOUT_MS;
  const override = raw == null || raw.trim() === '' ? Number.NaN : Number(raw);
  if (Number.isFinite(override) && override > 0) return Math.min(Math.floor(override), action.localMaxTimeoutMs);
  return action.timeoutMs;
}

/**
 * Derive the client trust tier from its address (consolidation.md §4.2). A loopback client is T1
 * (same machine, TUI-replacement tier); anything else reachable over the bind is T2 (own-network,
 * authed). T3 (internet relay) is out of scope and never produced here.
 */
export function trustTierForAddress(address: string | undefined | null): TrustTier {
  if (!address) return 'T2';
  const a = address.replace(/^::ffff:/i, '');
  if (a === '127.0.0.1' || a.startsWith('127.') || a === '::1' || a === 'localhost') return 'T1';
  return 'T2';
}

export interface R2Availability {
  allowed: boolean;
  reason?: string;
}

/** Default-deny gate for an R2 action at a given trust tier (rule 2). */
export function r2ActionAvailable(action: R2ActionDescriptor, tier: TrustTier): R2Availability {
  if (!action.allowedTrustTiers.includes(tier)) return { allowed: false, reason: `trust tier ${tier} may not perform ${action.id}` };
  if (tier === 'T1') return { allowed: true }; // same-machine: confirm nonce still required at execute
  if (action.requiresLocalEnablement && !r2EnabledActions().has(action.id)) {
    return { allowed: false, reason: `${action.id} is disabled for non-loopback clients; enable locally via COSYNCING_R2_ENABLED_ACTIONS` };
  }
  return { allowed: true };
}

// ── Confirmation nonce (rules 3-5) ───────────────────────────────────────────

export interface NonceBinding {
  actionId: string;
  tool: string;
  sessionId: string;
  /** Session revision / last-message id at preflight; a change forces re-confirmation (rule 4). */
  revision: string;
  format: string;
  redactionMode: string;
  tier: TrustTier;
}

let NONCE_SECRET: Buffer | null = null;
function nonceSecret(): Buffer {
  if (!NONCE_SECRET) NONCE_SECRET = randomBytes(32);
  return NONCE_SECRET;
}

function bindingPayload(b: NonceBinding): string {
  return [b.actionId, b.tool, b.sessionId, b.revision, b.format, b.redactionMode, b.tier].join('\0');
}

function mac(nonceId: string, expiresAt: number, b: NonceBinding): string {
  return createHmac('sha256', nonceSecret()).update(`${nonceId}\0${expiresAt}\0${bindingPayload(b)}`).digest('base64url');
}

const consumedNonces = new Map<string, number>(); // nonceId -> expiresAt

export interface IssuedNonce {
  nonce: string;
  expiresAt: number;
}

export function issueConfirmNonce(binding: NonceBinding, ttlMs: number): IssuedNonce {
  const expiresAt = Date.now() + Math.max(1, ttlMs);
  const nonceId = randomBytes(18).toString('base64url');
  return { nonce: `${nonceId}.${expiresAt}.${mac(nonceId, expiresAt, binding)}`, expiresAt };
}

export interface NonceVerdict {
  ok: boolean;
  reason?: string;
}

/**
 * Verify AND consume a confirmation nonce. Fails closed on: malformed nonce, tampered/mismatched
 * binding (confused-deputy — rule 4), expiry, or reuse (replay). Any bound-field change (revision,
 * format, redaction mode, tier, action, session) makes the recomputed MAC mismatch → CONFIRMATION_STALE.
 */
export function consumeConfirmNonce(nonce: string, binding: NonceBinding): NonceVerdict {
  const now = Date.now();
  for (const [id, exp] of consumedNonces) if (exp < now) consumedNonces.delete(id);
  if (typeof nonce !== 'string') return { ok: false, reason: 'missing confirmation nonce' };
  const parts = nonce.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed confirmation nonce' };
  const [nonceId, expiresRaw, providedMac] = parts as [string, string, string];
  const expiresAt = Number(expiresRaw);
  if (!Number.isFinite(expiresAt) || now > expiresAt) return { ok: false, reason: 'confirmation nonce expired' };
  const expected = mac(nonceId, expiresAt, binding);
  const a = Buffer.from(providedMac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'confirmation nonce does not match this action/session/revision' };
  if (consumedNonces.has(nonceId)) return { ok: false, reason: 'confirmation nonce already used' };
  consumedNonces.set(nonceId, expiresAt);
  return { ok: true };
}

// ── Rate limiting (rule 20) ──────────────────────────────────────────────────

const sessionHits = new Map<string, number[]>();
const brokerHits: number[] = [];

function prune(times: number[], windowMs: number, now: number): number[] {
  const cutoff = now - windowMs;
  let i = 0;
  while (i < times.length && times[i]! < cutoff) i++;
  return i > 0 ? times.slice(i) : times;
}

/**
 * Reserve one R2 rate slot for this (action, session). Reserving records the attempt so repeated
 * failures still count — a refusal must not leave temp files (rule 20), so this is checked before any
 * temp/native work. Returns ok:false with a reason when a window cap is exceeded.
 */
export function reserveR2RateSlot(action: R2ActionDescriptor, tool: string, sessionId: string): { ok: boolean; reason?: string } {
  const now = Date.now();
  const key = `${tool}\0${sessionId}`;
  const perSession = prune(sessionHits.get(key) ?? [], action.rateLimit.perSessionWindowMs, now);
  if (perSession.length >= action.rateLimit.perSessionMax) {
    sessionHits.set(key, perSession);
    return { ok: false, reason: `per-session R2 rate limit reached (${action.rateLimit.perSessionMax}/${Math.round(action.rateLimit.perSessionWindowMs / 60000)}min)` };
  }
  const perBroker = prune(brokerHits, action.rateLimit.perBrokerWindowMs, now);
  brokerHits.length = 0;
  brokerHits.push(...perBroker);
  if (perBroker.length >= action.rateLimit.perBrokerMax) {
    sessionHits.set(key, perSession);
    return { ok: false, reason: `per-broker R2 rate limit reached (${action.rateLimit.perBrokerMax}/${Math.round(action.rateLimit.perBrokerWindowMs / 3600000)}h)` };
  }
  perSession.push(now);
  brokerHits.push(now);
  sessionHits.set(key, perSession);
  return { ok: true };
}

/** Test-only reset of the in-memory rate windows. */
export function __resetR2RateLimitsForTest(): void {
  sessionHits.clear();
  brokerHits.length = 0;
}
