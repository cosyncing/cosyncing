/**
 * Which DSH web contract a host speaks, and what this build may therefore do.
 *
 * dsh is a developer preview whose rc train has already changed the web wire
 * once: 0.1.0-rc.6 served dot-named RPC methods plus two push-only sockets and
 * no authentication at all, while 0.2.0-rc.2 serves slash-named Typert Remote
 * endpoints on one multiplexed carrier and requires a signed cookie on every
 * API and WebSocket request. A version number greater than another is not
 * evidence of compatibility between those two, so the adapter classifies rather
 * than assumes.
 *
 * Two rules are enforced here rather than by review:
 *
 *  1. NO INFERIOR-FLOOR ACCEPTANCE. Support is a set of qualified versions plus
 *     a recognised contract family, never "anything at or above X". An
 *     unrecognised version — newer, older, or simply unexpected — is reported
 *     as unrecognised, which is a diagnosis, not a licence to try.
 *  2. NO MUTATING PROBE. Family selection reads only. A route that answers is
 *     enough; nothing here opens a session, prompts, or selects a model, and an
 *     authentication refusal never becomes a reason to try the older contract.
 */

import { DSH_MUX_ROUTE, dshApiPath } from './server.ts';
import { DSH_REMOTE_MUX_PATH } from './mux.ts';

/** The web contract families this build knows how to speak. */
export const DSH_CONTRACT_FAMILIES = Object.freeze(['legacy-0.1', 'remote-0.2'] as const);
export type DshContractFamily = typeof DSH_CONTRACT_FAMILIES[number];

/**
 * Versions this build was actually captured against. Each row is evidence, not
 * a range: 0.1.0-rc.6 produced `test/fixtures/dsh-0.1.0-rc.6.json` and
 * 0.2.0-rc.2 produced `test/fixtures/dsh-0.2.0-rc.2.json`.
 */
export const DSH_QUALIFIED_VERSIONS: Readonly<Record<DshContractFamily, readonly string[]>> = Object.freeze({
  'legacy-0.1': Object.freeze(['0.1.0-rc.6']),
  'remote-0.2': Object.freeze(['0.2.0-rc.2']),
});

/** The version this build's primary (current) fixtures and mappings were captured against. */
export const DSH_CURRENT_VERSION = '0.2.0-rc.2';

/**
 * A parsed `dsh` version. Prerelease and build parts are kept because the whole
 * product ships as release candidates, and `0.2.0-rc.2` is a different contract
 * from a hypothetical `0.2.0-rc.9`.
 */
export interface DshVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
  /** Prerelease identifiers, already split. Empty for a plain release. */
  prerelease: readonly string[];
}

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/**
 * Reduce one whitespace-delimited token of a version banner to a bare version.
 *
 * `commander`'s `--version` handler prints the bare number, but a banner that
 * says `dsh/0.2.0-rc.2` or `v0.2.0-rc.2` is the SAME fact, and refusing to read
 * it would make a correctly installed host look like no host at all. The
 * decorations stripped here are presentation only; anything this cannot reduce
 * is a program that is not this dsh, which is the answer worth getting.
 */
function normalizeVersionToken(token: string): string | null {
  const stripped = token.split('/').pop()?.split('@').pop() ?? '';
  const candidate = stripped.startsWith('v') ? stripped.slice(1) : stripped;
  return VERSION_PATTERN.test(candidate) ? candidate : null;
}

/**
 * Parse the output of `dsh -V` (or a bare version literal).
 *
 * Deliberately strict. `commander`'s version output is the exact package
 * version, so anything this cannot read means the binary is not the dsh CLI we
 * expect — including the unrelated `dsh` distributed-shell package Ubuntu
 * suggests — and guessing a version from it would be worse than reporting none.
 */
export function parseDshVersion(value: string | undefined | null): DshVersion | null {
  const raw = value?.trim().split(/\s+/).map(normalizeVersionToken).find((token) => token !== null);
  if (!raw) return null;
  const match = VERSION_PATTERN.exec(raw);
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  const parsed: DshVersion = {
    raw,
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ? prerelease.split('.') : [],
  };
  return Number.isSafeInteger(parsed.major) && Number.isSafeInteger(parsed.minor)
    && Number.isSafeInteger(parsed.patch) ? parsed : null;
}

export function compareDshVersions(left: DshVersion, right: DshVersion): number {
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] < right[key] ? -1 : 1;
  }
  // A version with no prerelease outranks one with it, per semver ordering.
  if (left.prerelease.length === 0) return right.prerelease.length === 0 ? 0 : 1;
  if (right.prerelease.length === 0) return -1;
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === undefined) return -1;
    if (b === undefined) return 1;
    if (a === b) continue;
    const numericA = /^\d+$/.test(a) ? Number(a) : undefined;
    const numericB = /^\d+$/.test(b) ? Number(b) : undefined;
    if (numericA !== undefined && numericB !== undefined) return numericA < numericB ? -1 : 1;
    if (numericA !== undefined) return -1;
    if (numericB !== undefined) return 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

/** Why a version does or does not grant a launch or a protocol. */
export type DshVersionVerdict =
  | { status: 'qualified'; version: DshVersion; family: DshContractFamily }
  /** Recognised contract family, version not on the qualified list. Usable, but reported as unverified. */
  | { status: 'family-recognised'; version: DshVersion; family: DshContractFamily }
  /** Readable version that no contract family this build speaks claims. */
  | { status: 'unsupported'; version: DshVersion }
  /** No version could be read: no binary, or a binary that is not this dsh. */
  | { status: 'unavailable'; detail: string };

/**
 * Classify a locally installed `dsh`.
 *
 * The family boundary is the contract change itself, not a guess about it:
 * anything before 0.2 is the dot-named legacy surface, 0.2.x is the Remote
 * surface, and 0.3+ is unknown because nothing has been captured for it. A
 * 0.2.x host is recognised as a family even when the exact rc has never been
 * exercised — same route shapes, same auth model — while an unexercised 0.3
 * gets no benefit of the doubt, because the same rc train has already moved the
 * wire once inside 0.2.
 */
export function classifyDshVersion(value: string | undefined | null): DshVersionVerdict {
  const version = parseDshVersion(value);
  if (!version) return { status: 'unavailable', detail: 'no dsh version could be read from the executable output' };
  const exact = (DSH_QUALIFIED_VERSIONS['legacy-0.1'] as readonly string[]).includes(version.raw)
    ? 'legacy-0.1'
    : (DSH_QUALIFIED_VERSIONS['remote-0.2'] as readonly string[]).includes(version.raw) ? 'remote-0.2' : null;
  if (exact) return { status: 'qualified', version, family: exact };
  if (version.major === 0 && version.minor === 1) return { status: 'family-recognised', version, family: 'legacy-0.1' };
  if (version.major === 0 && version.minor === 2) return { status: 'family-recognised', version, family: 'remote-0.2' };
  return { status: 'unsupported', version };
}

/**
 * The unattended-launch flags each contract family has actually been verified
 * to accept.
 *
 * `--no-open` is the whole reason this table exists. The 0.2 web bundle opens
 * the operator's browser by default and suppresses it with `--no-open`; 0.1's
 * web profile predates that flag family, and a broker that passed it anyway
 * would be told `unknown option` and never start a host at all. Suppressing the
 * browser is not cosmetic either: a broker started as a systemd service has no
 * display, so the default handoff is a spawn failure whose message is the only
 * clue an operator gets.
 */
const FAMILY_LAUNCH_FLAGS: Readonly<Record<DshContractFamily, readonly string[]>> = Object.freeze({
  'legacy-0.1': Object.freeze([]),
  'remote-0.2': Object.freeze(['--no-open']),
});

export interface DshLaunchPlan {
  args: readonly string[];
  /** True only when this family's flags were verified to suppress the browser handoff. */
  browserSuppressed: boolean;
}

/**
 * Build the `web` invocation for one recognised family.
 *
 * `--port` is passed for both families and even when it names the default: one
 * launch shape means the port the descriptor advertises is always the port the
 * child was told to serve. `--host` is never passed, which is what keeps a
 * managed launch on dsh's own default loopback bind instead of inventing a bind
 * nobody verified.
 */
export function planDshLaunch(family: DshContractFamily, port: number): DshLaunchPlan {
  const flags = FAMILY_LAUNCH_FLAGS[family];
  return {
    args: Object.freeze(['web', '--port', String(port), ...flags]),
    browserSuppressed: flags.includes('--no-open'),
  };
}

/** Whether a locally installed executable may be launched at all, and why not. */
export type DshManagedLaunchDecision =
  | { allowed: true; plan: DshLaunchPlan; family: DshContractFamily }
  | { allowed: false; code: 'version-unavailable' | 'version-unsupported' | 'no-browser-suppression'; detail: string };

/**
 * Preflight a managed launch against the locally installed version.
 *
 * A known-unsupported executable is refused BEFORE the spawn. Launching it to
 * discover that it speaks a contract nothing can read produces a ready-timeout
 * and a stop, which the supervisor then repeats — three times, each of them
 * pointless, and the log says "host did not become ready" rather than "this
 * version is not supported". Refusing early also means refusing without
 * consuming the transient-restart budget.
 */
export function decideManagedLaunch(
  versionOutput: string | undefined | null,
  port: number,
): DshManagedLaunchDecision {
  const verdict = classifyDshVersion(versionOutput);
  if (verdict.status === 'unavailable') {
    return { allowed: false, code: 'version-unavailable', detail: verdict.detail };
  }
  if (verdict.status === 'unsupported') {
    return {
      allowed: false,
      code: 'version-unsupported',
      detail: `dsh ${verdict.version.raw} speaks a web contract this cosyncing build does not implement. `
        + `Verified contracts: ${DSH_QUALIFIED_VERSIONS['legacy-0.1'].join(', ')} and ${DSH_QUALIFIED_VERSIONS['remote-0.2'].join(', ')}.`,
    };
  }
  const plan = planDshLaunch(verdict.family, port);
  if (!plan.browserSuppressed) {
    return {
      allowed: false,
      code: 'no-browser-suppression',
      detail: `dsh ${verdict.version.raw} has no verified flag that keeps \`dsh web\` from opening a browser, so `
        + 'cosyncing does not start it unattended. Start the host yourself and cosyncing will connect to it.',
    };
  }
  return { allowed: true, plan, family: verdict.family };
}

// ── Read-only contract probing ──────────────────────────────────────────────

/**
 * Result of the GET-only fingerprint. Named for what was OBSERVED, because a
 * refusal to answer is not evidence of absence: a 401 says a Remote-family host
 * is there and has not accepted us, which is the opposite of "no host".
 */
export type DshContractProbe =
  /** Something on the port answers the 0.2 carrier and asked us to authenticate. */
  | { family: 'remote-0.2'; authenticated: false; reason: 'auth-required' | 'host-or-origin-refused' }
  /** The carrier accepted our GET; a WebSocket generation is still required to confirm it. */
  | { family: 'remote-0.2'; authenticated: true; reason: 'carrier-answered' }
  | { family: 'legacy-0.1'; authenticated: true; reason: 'legacy-upgrade-route' }
  /** Nothing distinguishable answered. Not a verdict about dsh; a verdict about the port. */
  | { family: null; authenticated: false; reason: 'no-listener' | 'no-contract' | 'probe-failed' };

/** The 0.2 carrier route, used as a read-only discriminator. Built from the carrier's own constant. */
export const DSH_REMOTE_MUX_PROBE_PATH = DSH_REMOTE_MUX_PATH;
/**
 * The 0.1 downlink route, kept as the legacy discriminator rather than as
 * history. Built through the legacy allowlist rather than spelled out, so this
 * module cannot name a route the legacy transport has refused to produce.
 */
export const DSH_LEGACY_MUX_PROBE_PATH = dshApiPath(DSH_MUX_ROUTE);
/** A real 0.1 host answers a plain GET on an upgrade-only route with this. */
export const DSH_UPGRADE_REQUIRED_STATUS = 426;

/** The one HTTP verb this module uses. Any other would be an effect. */
export type DshProbeFetch = (url: string, init: { method: 'GET'; headers: Record<string, string> })
  => Promise<{ status: number }>;

/**
 * Decide which family to TRY, using two GETs and nothing else.
 *
 * Order matters. `/api/remote.mux` is asked first because it is the only route
 * whose answer discriminates the authenticated 0.2 host from an unauthenticated
 * 0.1 one: 0.1 has no authentication layer at all, so it answers 404 there
 * (no such route) while 0.2 answers 401 or 403 before it ever routes. Only a
 * 404 on that route makes the legacy fingerprint worth taking.
 *
 * The caller still has to PROVE the family. A positive GET is not a session:
 * 0.2 requires an authenticated `$events` `ready` frame, and legacy requires a
 * verified `host.describe`. This function's whole job is to stop the adapter
 * from opening the wrong socket against the wrong host and to make a refusal
 * reportable instead of retryable.
 */
export async function probeDshContract(
  baseUrl: string,
  fetchImpl: DshProbeFetch,
  headers: Readonly<Record<string, string>> = {},
): Promise<DshContractProbe> {
  const origin = baseUrl.replace(/\/+$/, '');
  // Deliberately anonymous, even when a perfectly good cookie is in hand. The
  // captured 0.2 host answers a credential-free GET on the carrier with 401,
  // which is the answer this function is built to read; the SAME host answers an
  // authenticated GET that does not offer a WebSocket upgrade with 404, because
  // past the auth fence there genuinely is no such route. Probing while logged in
  // therefore reports a real 0.2 host as an unrecognisable server, which is a
  // worse answer than the one the probe exists to avoid.
  const probeHeaders = Object.fromEntries(
    Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'cookie'),
  );
  let remoteStatus: number | null = null;
  try {
    remoteStatus = (await fetchImpl(`${origin}${DSH_REMOTE_MUX_PROBE_PATH}`, { method: 'GET', headers: { ...probeHeaders } })).status;
  } catch {
    return { family: null, authenticated: false, reason: 'no-listener' };
  }
  if (remoteStatus === 401) return { family: 'remote-0.2', authenticated: false, reason: 'auth-required' };
  if (remoteStatus === 403) return { family: 'remote-0.2', authenticated: false, reason: 'host-or-origin-refused' };
  if (remoteStatus === DSH_UPGRADE_REQUIRED_STATUS) {
    return { family: 'remote-0.2', authenticated: false, reason: 'auth-required' };
  }
  if (remoteStatus === 200) {
    return { family: 'remote-0.2', authenticated: true, reason: 'carrier-answered' };
  }
  if (remoteStatus !== 404 && remoteStatus < 500) {
    return { family: null, authenticated: false, reason: 'no-contract' };
  }
  // Only an absent Remote route can mean legacy, and only an upgrade-required
  // legacy route can prove it. Anything else is some other server on the port.
  try {
    const legacy = await fetchImpl(`${origin}${DSH_LEGACY_MUX_PROBE_PATH}`, { method: 'GET', headers: { ...probeHeaders } });
    if (legacy.status === DSH_UPGRADE_REQUIRED_STATUS) {
      return { family: 'legacy-0.1', authenticated: true, reason: 'legacy-upgrade-route' };
    }
  } catch {
    return { family: null, authenticated: false, reason: 'probe-failed' };
  }
  return { family: null, authenticated: false, reason: 'no-contract' };
}

/**
 * Whether an authentication refusal may fall through to the legacy contract.
 *
 * It may not, and this predicate exists so the rule cannot be re-litigated at
 * each call site. A 0.2 host behind a missing cookie and a 0.1 host are
 * distinguishable without trying anything, and reading "not logged in" as
 * "therefore it is the old protocol" would send an unauthenticated 0.1 request
 * to a host that is merely waiting for credentials — then report the resulting
 * failure as a version problem.
 */
export function mayFallBackToLegacyAfterProbe(probe: DshContractProbe): boolean {
  return probe.family !== 'remote-0.2';
}
