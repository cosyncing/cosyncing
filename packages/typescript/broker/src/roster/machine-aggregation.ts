import type {
  AggregatedMachines,
  MachinePeerErrorCode,
  MachineRoster,
  MachineSessionIdentity,
  MachineSessionInfo,
  MachineSessionOwner,
  MachineSessionResolution,
  SessionInfo,
} from '@cosyncing/protocol';
import { BROKER_CONTRACT_REVISION, PRODUCT_IDENTITY } from '@cosyncing/protocol';

export type { AggregatedMachines, MachinePeerErrorCode, MachineRoster } from '@cosyncing/protocol';

export interface MachinePeerConfig {
  id: string;
  url: string;
  /** Deprecated compatibility shorthand for a broker owner token. */
  token?: string;
  credential?: MachinePeerCredential;
}

export type MachinePeerCredential =
  | { kind: 'broker-token'; value: string }
  | { kind: 'peer-token'; value: string };

export function parseMachinePeers(raw = process.env.COSYNCING_MACHINE_PEERS ?? ''): MachinePeerConfig[] {
  const text = raw.trim();
  if (!text) return [];
  const parsed = parsePeerJson(text);
  if (parsed) return parsed;
  return text
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part, index) => peerFromString(part, index));
}

function parsePeerJson(text: string): MachinePeerConfig[] | undefined {
  if (!text.startsWith('[')) return undefined;
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) throw new Error('COSYNCING_MACHINE_PEERS JSON must be an array');
  return parsed.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error('COSYNCING_MACHINE_PEERS entries must be objects');
    const obj = entry as Record<string, unknown>;
    const url = typeof obj.url === 'string' ? obj.url.trim() : '';
    if (!url) throw new Error('COSYNCING_MACHINE_PEERS entry.url is required');
    const id = typeof obj.id === 'string' && obj.id.trim() ? obj.id.trim() : peerIdFromUrl(url, index);
    const token = typeof obj.token === 'string' && obj.token ? obj.token : undefined;
    const credential = parseMachinePeerCredential(obj.credential);
    if (token && credential) throw new Error('COSYNCING_MACHINE_PEERS entry cannot contain both token and credential');
    return normalizePeer({ id, url, ...(token ? { token } : {}), ...(credential ? { credential } : {}) });
  });
}

function peerFromString(text: string, index: number): MachinePeerConfig {
  const at = text.indexOf('@');
  if (at > 0 && /^https?:\/\//i.test(text.slice(at + 1))) {
    const id = text.slice(0, at).trim();
    const rest = text.slice(at + 1).trim();
    const hash = rest.lastIndexOf('#');
    const url = hash > -1 ? rest.slice(0, hash) : rest;
    const token = hash > -1 ? rest.slice(hash + 1) : '';
    return normalizePeer({ id, url, ...(token ? { token } : {}) });
  }
  return normalizePeer({ id: peerIdFromUrl(text, index), url: text });
}

function normalizePeer(peer: MachinePeerConfig): MachinePeerConfig {
  const url = new URL(peer.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`unsupported machine peer URL protocol: ${url.protocol}`);
  return {
    id: peer.id,
    url: peerFetchBase(url),
    ...(peer.token ? { token: peer.token } : {}),
    ...(peer.credential ? { credential: peer.credential } : {}),
  };
}

function parseMachinePeerCredential(raw: unknown): MachinePeerCredential | undefined {
  if (raw == null) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('COSYNCING_MACHINE_PEERS entry.credential must be an object');
  }
  const credential = raw as Record<string, unknown>;
  if ((credential.kind !== 'broker-token' && credential.kind !== 'peer-token')
      || typeof credential.value !== 'string' || !credential.value) {
    throw new Error('COSYNCING_MACHINE_PEERS entry.credential must contain a supported kind and value');
  }
  return { kind: credential.kind, value: credential.value };
}

function peerIdFromUrl(url: string, index: number): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname || `peer-${index + 1}`;
  } catch {
    return `peer-${index + 1}`;
  }
}

function peerFetchBase(url: URL): string {
  url.username = '';
  url.password = '';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

export function machineSessionIdentity(machineId: string, tool: string, sessionId: string): MachineSessionIdentity {
  return {
    machineId,
    tool,
    sessionId,
    key: [machineId, tool, sessionId].map(encodeURIComponent).join(':'),
  };
}

function streamUrl(baseUrl: string | undefined, tool: string, sessionId: string): string | undefined {
  if (!baseUrl) return undefined;
  const url = new URL(`/api/sessions/${encodeURIComponent(tool)}/${encodeURIComponent(sessionId)}/stream`, baseUrl);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}

function owner(
  machineId: string,
  machine: string,
  role: 'local' | 'peer',
  baseUrl: string | undefined,
  tool: string,
  sessionId: string,
  route: MachineSessionOwner['route'],
): MachineSessionOwner {
  return {
    machineId,
    machine,
    role,
    route,
    authoritative: route === 'local' || route === 'direct',
    ...(baseUrl ? { baseUrl, streamUrl: streamUrl(baseUrl, tool, sessionId) } : {}),
    requiresIndependentAuthentication: role === 'peer',
  };
}

function routeSessions(
  sessions: SessionInfo[],
  input: { machineId: string; machine: string; role: 'local' | 'peer'; baseUrl?: string; route: MachineSessionOwner['route'] },
): MachineSessionInfo[] {
  return sessions.map((session) => ({
    ...session,
    machine: input.machine,
    identity: machineSessionIdentity(input.machineId, session.tool, session.id),
    owner: owner(input.machineId, input.machine, input.role, input.baseUrl, session.tool, session.id, input.route),
  }));
}

export function localMachineRoster(
  machine: string,
  sessions: SessionInfo[],
  baseUrl?: string,
  now = Date.now(),
  // Whether `sessions` is the whole local roster. An incomplete one must not be
  // reported `ok`: a caller resolving a session that belongs to the adapter the
  // sweep could not read would be told it does not exist, when what happened is
  // that nobody could look. `degraded` is the existing word for that, and
  // MACHINE_PEER_PARTIAL the existing code.
  complete = true,
): MachineRoster {
  const routed = routeSessions(sessions, { machineId: machine, machine, role: 'local', ...(baseUrl ? { baseUrl } : {}), route: 'local' });
  const duplicates = duplicateSessionKeys(routed);
  if (duplicates.size) markAmbiguous(routed, duplicates);
  // Duplicates first: an ambiguous identity is a stronger claim about the rows
  // present than partial coverage is about rows absent, and only one code fits.
  const code = duplicates.size
    ? 'MACHINE_PEER_DUPLICATE_SESSION' as const
    : complete ? undefined : 'MACHINE_PEER_PARTIAL' as const;
  return {
    machineId: machine,
    machine,
    role: 'local',
    status: code ? 'degraded' : 'ok',
    sessions: routed,
    sessionCount: routed.length,
    ...(baseUrl ? { baseUrl } : {}),
    checkedAt: now,
    generatedAt: now,
    freshness: 'fresh',
    ...(code ? {
      code,
      error: duplicates.size
        ? 'duplicate session identity on local owner'
        : 'local roster is missing an adapter this sweep could not read',
    } : {}),
  };
}

export async function fetchPeerMachineRoster(peer: MachinePeerConfig, opts: { timeoutMs?: number } = {}): Promise<MachineRoster> {
  const timeoutMs = Math.max(100, opts.timeoutMs ?? envTimeoutMs());
  const checkedAt = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    // Declares the revision this BROKER can decode, which is the current one:
    // a peer filters its roster to what its caller can parse, and a caller that
    // says nothing is read as the oldest possible client. Asking bare made every
    // peer withhold exactly the agents with a declared floor — Kimi and dsh —
    // so remote sessions for them could never appear in a machine roster.
    const res = await fetch(`${peer.url}/api/sessions?contractRevision=${BROKER_CONTRACT_REVISION}`, {
      signal: ac.signal,
      headers: machinePeerCredentialHeaders(peer),
    });
    if (res.status === 401) {
      return degraded(peer, 'MACHINE_PEER_BAD_CONFIG',
        'machine peer authentication required: add a broker-token or paired peer-token credential');
    }
    if (!res.ok) {
      return degraded(peer, 'MACHINE_PEER_BAD_RESPONSE', `peer roster returned HTTP ${res.status}`);
    }
    const body = await res.json().catch(() => undefined) as {
      machine?: unknown; sessions?: unknown; generatedAt?: unknown; complete?: unknown;
    } | undefined;
    if (!body || typeof body.machine !== 'string' || !Array.isArray(body.sessions)) {
      return degraded(peer, 'MACHINE_PEER_BAD_RESPONSE', 'peer roster response is malformed');
    }
    const validSessions = body.sessions.filter(isSessionInfo);
    const invalidSessionCount = body.sessions.length - validSessions.length;
    const generatedAt = typeof body.generatedAt === 'number' && Number.isFinite(body.generatedAt) ? body.generatedAt : undefined;
    const stale = generatedAt !== undefined && checkedAt - generatedAt > envStaleMs();
    const sessions = routeSessions(validSessions, {
      machineId: peer.id,
      machine: body.machine,
      role: 'peer',
      baseUrl: peer.url,
      route: stale ? 'stale' : 'direct',
    });
    const duplicateKeys = duplicateSessionKeys(sessions);
    if (duplicateKeys.size) markAmbiguous(sessions, duplicateKeys);
    // Contract revision 23. A peer that says its own roster is not the whole one
    // is exactly as partial as one whose rows we had to discard, and it already
    // has a code that says so.
    //
    // Three cases, not two. Omission is valid and means complete: a peer that
    // predates the flag never answered ahead of a sweep. `true` is complete. But
    // a field that is PRESENT and not a boolean is a peer we cannot read, and
    // reading it as complete is the one interpretation with a cost -- it is what
    // lets a garbled roster answer `ok` and then deny a session that exists.
    // Unreadable is treated as unconfirmed.
    const peerIncomplete = body.complete !== undefined && body.complete !== true;
    const peerCompletenessUnreadable = body.complete !== undefined && typeof body.complete !== 'boolean';
    const code: MachinePeerErrorCode | undefined = stale
      ? 'MACHINE_PEER_STALE'
      : duplicateKeys.size
        ? 'MACHINE_PEER_DUPLICATE_SESSION'
        : invalidSessionCount || peerIncomplete
          ? 'MACHINE_PEER_PARTIAL'
          : undefined;
    return {
      machineId: peer.id,
      machine: body.machine,
      role: 'peer',
      status: code ? 'degraded' : 'ok',
      baseUrl: peer.url,
      sessions,
      sessionCount: sessions.length,
      checkedAt,
      ...(generatedAt !== undefined ? { generatedAt } : {}),
      freshness: stale ? 'stale' : generatedAt === undefined ? 'unknown' : 'fresh',
      ...(invalidSessionCount ? { invalidSessionCount } : {}),
      ...(code ? {
        code,
        error: stale
          ? 'peer roster is stale'
          : duplicateKeys.size
            ? 'peer roster contains duplicate composite session identities'
            : invalidSessionCount
            ? 'peer roster was partially accepted after malformed sessions were discarded'
            : peerCompletenessUnreadable
              ? 'peer roster completeness is malformed and cannot be read as whole'
              : 'peer reported its own roster as incomplete',
      } : {}),
    };
  } catch (err) {
    const aborted = ac.signal.aborted || (err instanceof Error && err.name === 'AbortError');
    return degraded(peer, aborted ? 'MACHINE_PEER_TIMEOUT' : 'MACHINE_PEER_UNREACHABLE', err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

function machinePeerCredentialHeaders(peer: MachinePeerConfig): Record<string, string> | undefined {
  const credential = peer.credential ?? (peer.token ? { kind: 'broker-token' as const, value: peer.token } : undefined);
  if (!credential) return undefined;
  return credential.kind === 'peer-token'
    ? { 'x-cosyncing-peer-token': credential.value }
    : { [PRODUCT_IDENTITY.tokenHeader]: credential.value };
}

function degraded(peer: MachinePeerConfig, code: MachinePeerErrorCode, error: string): MachineRoster {
  return {
    machineId: peer.id,
    machine: peer.id,
    role: 'peer',
    status: 'degraded',
    baseUrl: peer.url,
    sessions: [],
    sessionCount: 0,
    checkedAt: Date.now(),
    freshness: 'unknown',
    code,
    error,
  };
}

function duplicateSessionKeys(sessions: MachineSessionInfo[]): Set<string> {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const session of sessions) {
    if (seen.has(session.identity.key)) duplicates.add(session.identity.key);
    seen.add(session.identity.key);
  }
  return duplicates;
}

function markAmbiguous(sessions: MachineSessionInfo[], keys?: Set<string>): void {
  for (const session of sessions) {
    if (keys && !keys.has(session.identity.key)) continue;
    session.owner = { ...session.owner, route: 'ambiguous', authoritative: false, streamUrl: undefined };
  }
}

/** Reconcile configured routing ids after all peer fetches. Duplicate machineIds are never
 * first-wins: every competing roster and session is marked ambiguous. */
export function reconcileMachineRosters(machines: MachineRoster[]): MachineRoster[] {
  const groups = new Map<string, MachineRoster[]>();
  for (const machine of machines) {
    const group = groups.get(machine.machineId) ?? [];
    group.push(machine);
    groups.set(machine.machineId, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const machine of group) {
      machine.status = 'degraded';
      machine.code = 'MACHINE_PEER_DUPLICATE_MACHINE';
      machine.error = 'multiple owners use the same configured machineId';
      markAmbiguous(machine.sessions);
    }
  }
  return machines;
}

export function aggregatedMachines(machineId: string, machines: MachineRoster[], generatedAt = Date.now()): AggregatedMachines {
  return { version: 1, machine: machineId, machineId, generatedAt, machines: reconcileMachineRosters(machines) };
}

export function resolveMachineSession(
  aggregate: AggregatedMachines,
  input: { machineId: string; tool: string; sessionId: string },
): MachineSessionResolution {
  const identity = machineSessionIdentity(input.machineId, input.tool, input.sessionId);
  const owners = aggregate.machines.filter((machine) => machine.machineId === input.machineId);
  if (owners.length > 1) {
    return { ok: false, identity, status: 'ambiguous', code: 'MACHINE_ROUTE_AMBIGUOUS', message: 'multiple owners use this machineId' };
  }
  const machine = owners[0];
  if (!machine) {
    return { ok: false, identity, status: 'not-found', code: 'MACHINE_ROUTE_NOT_FOUND', message: 'machine owner is not configured' };
  }
  if (machine.code === 'MACHINE_PEER_TIMEOUT' || machine.code === 'MACHINE_PEER_UNREACHABLE' || machine.code === 'MACHINE_PEER_BAD_RESPONSE') {
    return { ok: false, identity, status: 'owner-unreachable', code: 'MACHINE_OWNER_UNREACHABLE', message: 'owning machine is unreachable' };
  }
  const matches = machine.sessions.filter((session) => session.identity.key === identity.key);
  if (matches.length > 1 || matches[0]?.owner.route === 'ambiguous') {
    return { ok: false, identity, status: 'ambiguous', code: 'MACHINE_ROUTE_AMBIGUOUS', message: 'session identity has multiple owners' };
  }
  const session = matches[0];
  if (machine.freshness === 'stale' || session?.owner.route === 'stale') {
    return { ok: false, identity, status: 'stale', code: 'MACHINE_ROUTE_STALE', message: 'owning roster is stale', ...(session ? { session, owner: session.owner } : {}) };
  }
  if (!session) {
    // A partial roster is truthful about the rows it carries and silent about the
    // rest, so it can confirm a session but never deny one. Absence here means the
    // owner did not finish looking -- the same thing staleness means, and it gets
    // the same answer rather than a fabricated not-found.
    if (machine.code === 'MACHINE_PEER_PARTIAL') {
      return { ok: false, identity, status: 'stale', code: 'MACHINE_ROUTE_STALE', message: 'owning roster is incomplete' };
    }
    return { ok: false, identity, status: 'not-found', code: 'MACHINE_ROUTE_NOT_FOUND', message: 'session is not present on the owning machine' };
  }
  return { ok: true, identity, status: 'resolved', session, owner: session.owner };
}

function isSessionInfo(value: unknown): value is SessionInfo {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.id === 'string' && typeof obj.tool === 'string';
}

function envTimeoutMs(): number {
  const raw = Number(process.env.COSYNCING_MACHINE_PEER_TIMEOUT_MS ?? 1500);
  return Number.isFinite(raw) && raw > 0 ? raw : 1500;
}

function envStaleMs(): number {
  const raw = Number(process.env.COSYNCING_MACHINE_PEER_STALE_MS ?? 30_000);
  return Number.isFinite(raw) && raw >= 1_000 ? raw : 30_000;
}
