import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Server } from 'bun';
import type { ServerRouteIdentityProof } from '@cosyncing/protocol';
import {
  atomicWriteOwnerOnly,
  readOwnerOnlyText,
} from '../security/secure-files.ts';

/** Canonical bytes: UTF-8 JSON array in this exact field order. */
export function identityProofBytes(
  proof: Omit<ServerRouteIdentityProof, 'signature'>
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify([
      'cosyncing/server-routes-v1',
      proof.nonce,
      proof.origin,
      proof.identityPublicKey,
      proof.issuedAt,
      proof.expiresAt,
    ])
  );
}

/** Origins only: never silently discard pasted paths or credentials. */
export function canonicalRouteOrigin(input: unknown): string {
  if (
    typeof input !== 'string' ||
    input.length > 2048 ||
    input !== input.trim()
  )
    throw new Error('Invalid origin');
  const url = new URL(input);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== '' && url.pathname !== '/') ||
    !url.hostname
  )
    throw new Error('An HTTP or HTTPS origin is required');
  return url.origin;
}

interface RouteConfiguration {
  version: 1;
  generation: number;
  advertisedOrigins: string[];
  trustedClientOrigins: string[];
}

/** Owner-controlled directions of trust are deliberately separate. */
export class ServerRoutes {
  private readonly path: string;
  private config: RouteConfiguration;
  private windowStart = 0;
  private proofs = 0;

  constructor(
    home: string,
    initialOrigins: string[],
    private readonly signer: {
      publicKey: string;
      sign: (bytes: Uint8Array) => string;
    },
    private readonly now: () => number = Date.now
  ) {
    this.path = join(home, 'server-routes.json');
    this.config = {
      version: 1,
      generation: 1,
      advertisedOrigins: initialOrigins.map(canonicalRouteOrigin),
      trustedClientOrigins: [],
    };
    if (existsSync(this.path)) {
      const stored = JSON.parse(readOwnerOnlyText(this.path));
      if (stored.version !== 1 || !Number.isSafeInteger(stored.generation))
        throw new Error('Unsupported server route configuration');
      this.config = {
        version: 1,
        generation: stored.generation,
        advertisedOrigins: this.origins(stored.advertisedOrigins),
        trustedClientOrigins: this.origins(stored.trustedClientOrigins),
      };
    }
  }

  get identityPublicKey(): string {
    return this.signer.publicKey;
  }
  configuration(): RouteConfiguration {
    return structuredClone(this.config);
  }
  configure(input: unknown): RouteConfiguration {
    if (!input || typeof input !== 'object')
      throw new Error('Route configuration required');
    const body = input as Record<string, unknown>;
    if (body.generation !== this.config.generation)
      throw new Error('Configuration changed; refresh before editing');
    const next: RouteConfiguration = {
      version: 1,
      generation: this.config.generation + 1,
      advertisedOrigins: this.origins(body.advertisedOrigins),
      trustedClientOrigins: this.origins(body.trustedClientOrigins),
    };
    if (!next.advertisedOrigins.length)
      throw new Error('At least one advertised origin is required');
    atomicWriteOwnerOnly(this.path, JSON.stringify(next));
    this.config = next;
    return this.configuration();
  }
  private origins(input: unknown): string[] {
    if (!Array.isArray(input) || input.length > 64)
      throw new Error('At most 64 explicit origins are allowed');
    return [...new Set(input.map(canonicalRouteOrigin))];
  }

  proof(input: unknown): ServerRouteIdentityProof {
    const now = this.now();
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now;
      this.proofs = 0;
    }
    if (++this.proofs > 120)
      throw new RouteProofError(429, 'Proof rate limit reached');
    if (!input || typeof input !== 'object')
      throw new RouteProofError(400, 'Challenge required');
    const body = input as Record<string, unknown>;
    if (
      typeof body.nonce !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(body.nonce)
    )
      throw new RouteProofError(400, 'A fresh 32-byte nonce is required');
    let origin: string;
    try {
      origin = canonicalRouteOrigin(body.origin);
    } catch {
      throw new RouteProofError(400, 'Invalid origin');
    }
    if (!this.config.advertisedOrigins.includes(origin))
      throw new RouteProofError(403, 'Origin is not advertised by this server');
    const proof = {
      version: 1 as const,
      nonce: body.nonce,
      origin,
      identityPublicKey: this.signer.publicKey,
      issuedAt: now,
      expiresAt: now + 15_000,
    };
    return { ...proof, signature: this.signer.sign(identityProofBytes(proof)) };
  }

  /** Owner-approved cross-origin web clients; a page served by this broker needs no entry. */
  trustsClient(origin: string): boolean {
    try {
      return this.config.trustedClientOrigins.includes(
        canonicalRouteOrigin(origin)
      );
    } catch {
      return false;
    }
  }
}

export class RouteProofError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

const requestHeaders = [
  'authorization',
  'content-type',
  'x-cosyncing-token',
  'x-cosyncing-client-profile',
  'x-cosyncing-client-incarnation',
  'x-cosyncing-peer-token',
  'x-cosyncing-client-profile-id',
  'x-cosyncing-client-profile-incarnation',
  'x-cosyncing-client-version',
  'x-cosyncing-contract-revision',
  'x-cosyncing-minimum-broker-revision',
  'x-cosyncing-contract-surface-hash',
  'range',
  'if-range',
  'if-none-match',
  'upload-offset',
  'x-upload-offset',
  'x-cosyncing-upload-offset',
];

/**
 * CORS for owner-trusted cross-origin web clients, on API errors as well as
 * probe success. Preflight confers no authority. Other origins are served
 * without CORS headers rather than refused: every data-bearing API needs a
 * header credential or a one-use ticket, which a browser never attaches by
 * itself, and without these headers a foreign page can neither read a response
 * nor send a preflighted request. The broker cannot tell its own pages apart by
 * origin anyway: behind a TLS-terminating proxy it sees `http://host` while the
 * page sends `Origin: https://host`, and proxies may rewrite the host too.
 */
export function withServerRouteOrigins<T>(
  routes: ServerRoutes,
  handler: (
    request: Request,
    server: Server<T>
  ) => Promise<Response | undefined>
): (request: Request, server: Server<T>) => Promise<Response | undefined> {
  return async (request, server) => {
    const url = new URL(request.url);
    const origin = request.headers.get('origin');
    if (
      !origin ||
      !url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/api/media-previews/') ||
      !routes.trustsClient(origin)
    )
      return handler(request, server);
    let response: Response | undefined;
    if (request.method === 'OPTIONS') {
      const method = request.headers.get('access-control-request-method') ?? '';
      const headers = (
        request.headers.get('access-control-request-headers') ?? ''
      )
        .toLowerCase()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      response =
        ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'].includes(method) &&
        headers.every((h) => requestHeaders.includes(h))
          ? new Response(null, { status: 204 })
          : new Response('Preflight not allowed', { status: 403 });
    } else response = await handler(request, server);
    if (response) {
      response.headers.set('access-control-allow-origin', origin);
      response.headers.append('vary', 'Origin');
      response.headers.set(
        'access-control-allow-methods',
        'GET, HEAD, POST, PATCH, DELETE, OPTIONS'
      );
      response.headers.set(
        'access-control-allow-headers',
        requestHeaders.join(', ')
      );
      response.headers.set(
        'access-control-expose-headers',
        'Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified, Upload-Offset, X-Cosyncing-Mime-Type, X-Cosyncing-Artifact-Key, X-Cosyncing-Content-Hash'
      );
    }
    return response;
  };
}
