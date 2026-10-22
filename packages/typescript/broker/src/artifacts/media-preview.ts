import { randomBytes } from 'node:crypto';
import { closeSync, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { DownloadRangeError, ifRangeMatches, parseDownloadRange, prepareSessionDownload } from './fs-browse.ts';
import type { WsAuthTicketPrincipal } from '../security/ws-auth-tickets.ts';

/** Deliberately excludes active documents, SVG and arbitrary MIME supplied by a caller. */
export function mediaPreviewType(name: string): { mimeType: string; maxBytes: number } | undefined {
  const extension = name.split('.').pop()?.toLowerCase();
  const types: Record<string, string> = {
    png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
    pdf: 'application/pdf', mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm',
  };
  if (!extension || !Object.hasOwn(types, extension)) return undefined;
  const mimeType = types[extension]!;
  return { mimeType, maxBytes: (mimeType.startsWith('video/') ? 2048 : mimeType === 'application/pdf' ? 128 : 32) * 1024 * 1024 };
}

export interface MediaPreviewBinding {
  tool: string;
  sessionId: string;
  path?: string;
  /** Resolved at issuance so seeks never rediscover the session roster. */
  workspaceRoot?: string;
  artifactId?: string;
  principal: WsAuthTicketPrincipal;
}

/** Read-only bearer capabilities: one file, bounded lifetime/count, revocable on close. No credentials. */
export class MediaPreviewTickets {
  private readonly tickets = new Map<string, MediaPreviewBinding & { expiresAt: number }>();
  constructor(private readonly now: () => number = Date.now) {}

  issue(binding: MediaPreviewBinding): { url: string; expiresAt: number } {
    for (const [key, value] of this.tickets) {
      if (value.expiresAt <= this.now()) this.tickets.delete(key);
    }
    while (this.tickets.size >= 256) this.tickets.delete(this.tickets.keys().next().value!);
    const ticket = randomBytes(32).toString('base64url');
    const expiresAt = this.now() + 6 * 60 * 60 * 1000;
    this.tickets.set(ticket, { ...binding, expiresAt });
    return { url: `/api/media-previews/${ticket}`, expiresAt };
  }

  get(ticket: string): MediaPreviewBinding | undefined {
    const binding = this.tickets.get(ticket);
    if (!binding || binding.expiresAt <= this.now()) {
      this.tickets.delete(ticket);
      return undefined;
    }
    return binding;
  }

  /** Open media capabilities are leases even between range requests. */
  referencesArtifact(tool: string, sessionId: string, artifactId: string): boolean {
    return [...this.tickets.values()].some((binding) => binding.expiresAt > this.now()
      && binding.tool === tool && binding.sessionId === sessionId && binding.artifactId === artifactId);
  }

  revoke(ticket: string): void { this.tickets.delete(ticket); }
}

/** Opens the jailed file again on every range; replacement, gate and size checks stay live. */
export function serveWorkspaceMedia(cwd: string, path: string, request: Request): Response {
  const type = mediaPreviewType(path);
  if (!type) return new Response('Unsupported preview', { status: 415 });
  const file = prepareSessionDownload(cwd, path, type.maxBytes);
  const headers = new Headers({
    'content-type': type.mimeType,
    'accept-ranges': 'bytes',
    'etag': file.etag,
    'last-modified': new Date(file.mtimeMs).toUTCString(),
    'cache-control': 'private, no-store',
    'referrer-policy': 'no-referrer',
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; sandbox",
  });
  let range;
  try {
    range = ifRangeMatches(request.headers.get('if-range'), file.etag, file.mtimeMs)
      ? parseDownloadRange(request.headers.get('range'), file.size) : undefined;
  } catch (error) {
    closeSync(file.fd);
    if (!(error instanceof DownloadRangeError)) throw error;
    headers.set('content-range', `bytes */${file.size}`);
    return new Response(null, { status: 416, headers });
  }
  headers.set('content-length', String(range ? range.end - range.start + 1 : file.size));
  if (range) headers.set('content-range', `bytes ${range.start}-${range.end}/${file.size}`);
  if (request.method === 'HEAD') {
    closeSync(file.fd);
    return new Response(null, { status: range ? 206 : 200, headers });
  }
  const stream = createReadStream(file.abs, {
    fd: file.fd, autoClose: true, ...(range ? { start: range.start, end: range.end } : {}),
  });
  return new Response(Readable.toWeb(stream) as unknown as ReadableStream, { status: range ? 206 : 200, headers });
}
