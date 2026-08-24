import { randomBytes } from 'node:crypto';

export type WsAuthTicketPrincipal =
  | { kind: 'owner'; credentialId: string }
  | { kind: 'peer'; peerId: string; authGeneration: number; roles: string[] };

export interface WsAuthTicketBinding {
  tool: string;
  sessionId: string;
  params: Record<string, string>;
  identity: string;
  uploadIdentity: string;
  credentialAuthenticated: boolean;
  principal: WsAuthTicketPrincipal;
}

export interface IssuedWsAuthTicket {
  wsAuthTicket: string;
  expiresAt: string;
}

interface StoredWsAuthTicket extends WsAuthTicketBinding {
  expiresAt: number;
}

const DEFAULT_TTL_MS = 30_000;
const DEFAULT_MAX_TICKETS = 2_048;

/** In-memory, one-use authorization for a single WebSocket upgrade. */
export class WsAuthTicketRegistry {
  private readonly tickets = new Map<string, StoredWsAuthTicket>();

  constructor(private readonly options: {
    now?: () => number;
    ttlMs?: number;
    maxTickets?: number;
  } = {}) {}

  issue(binding: WsAuthTicketBinding): IssuedWsAuthTicket {
    const now = this.now();
    this.prune(now);
    const maxTickets = Math.max(1, this.options.maxTickets ?? DEFAULT_MAX_TICKETS);
    while (this.tickets.size >= maxTickets) {
      const oldest = this.tickets.keys().next().value as string | undefined;
      if (!oldest) break;
      this.tickets.delete(oldest);
    }
    const wsAuthTicket = randomBytes(32).toString('base64url');
    const expiresAt = now + Math.max(1, this.options.ttlMs ?? DEFAULT_TTL_MS);
    this.tickets.set(wsAuthTicket, {
      ...binding,
      params: { ...binding.params },
      expiresAt,
    });
    return { wsAuthTicket, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Consumes before returning, so a failed or aborted upgrade cannot replay it. */
  consume(wsAuthTicket: string, tool: string, sessionId: string): WsAuthTicketBinding | undefined {
    const normalized = wsAuthTicket.trim();
    if (!normalized) return undefined;
    const stored = this.tickets.get(normalized);
    this.tickets.delete(normalized);
    if (!stored || stored.expiresAt <= this.now()) return undefined;
    if (stored.tool !== tool || stored.sessionId !== sessionId) return undefined;
    const { expiresAt: _expiresAt, ...binding } = stored;
    return { ...binding, params: { ...binding.params } };
  }

  invalidatePeer(peerId: string): number {
    let invalidated = 0;
    for (const [ticket, stored] of this.tickets) {
      if (stored.principal.kind !== 'peer' || stored.principal.peerId !== peerId) continue;
      this.tickets.delete(ticket);
      invalidated += 1;
    }
    return invalidated;
  }

  private prune(now: number): void {
    for (const [ticket, stored] of this.tickets) {
      if (stored.expiresAt <= now) this.tickets.delete(ticket);
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
