import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, resolve, sep } from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AgentMessage } from '@cosyncing/protocol';
import { PRODUCT_IDENTITY } from './product.ts';
import { ClientMessagePolicyError } from './client-message-policy.ts';

export interface ArtifactSession {
  tool: string;
  id: string;
}

type DeliveryClass = 'interactive' | 'export-attachment';
type ArtifactMessage = Extract<AgentMessage, { type: 'file-artifact' }>;
type ArtifactInteractionPolicy = NonNullable<ArtifactMessage['interactionPolicy']>;

export type NormalizedArtifactInteraction =
  | { type: 'form-submit'; formId?: string; data: Record<string, string | string[]> }
  | { type: 'action'; action: string; value?: string | number | boolean | null; label?: string };

export interface AuthorizedArtifactInteraction {
  artifact: { artifactKey: string; name: string; path: string };
  interaction: NormalizedArtifactInteraction;
}

interface ArtifactRecord {
  key: string;
  /** Stable configured broker origin that accepted the bytes. Tool/session
   *  ids are native and can legitimately collide across broker sources. */
  brokerSource?: string;
  tool: string;
  sessionId: string;
  artifactKey: string;
  contentHash: string;
  filePath: string;
  path: string;
  name: string;
  mimeType: string;
  size: number;
  createdAt: number;
  lastAccessedAt: number;
  /** Absent ⇒ `interactive` (existing inline sandboxed path, unchanged). */
  deliveryClass?: DeliveryClass;
  /** Absolute expiry for `export-attachment` records (rule 18; 30-min default). */
  expiresAt?: number;
  /** Export format + redaction summary shown on the file-artifact card (no secret content). */
  format?: string;
  redactionSummary?: string;
  /** Present only when the broker received this artifact through a source that
   *  already proved the exact tool + native session. Legacy cwd-outbox records
   *  intentionally lack this marker and are never replayed after restart. */
  qualifiedSource?: 'managed-connection-v1';
}

/** Metadata for an R2 `export-attachment` ingestion (bytes come from a verified broker temp file). */
export interface ExportAttachmentMeta {
  name: string;
  format: string;
  redactionSummary?: string;
  retentionMs: number;
}

export type ArtifactStorePersistenceOperation = 'load' | 'put' | 'access' | 'clear' | 'sweep';

/** Sanitized persistence signal for broker-health integration; raw errors and local paths stay local. */
export interface ArtifactStorePersistenceResult {
  ok: boolean;
  operation: ArtifactStorePersistenceOperation;
  at: number;
}

export interface ArtifactStoreOptions {
  onPersistenceResult?: (result: ArtifactStorePersistenceResult) => void;
  /** Test/embedding override. Always clamped to the production hard ceiling. */
  maxRecords?: number;
  /** Test/embedding override. Always clamped to the production hard ceiling. */
  sessionReplayLimit?: number;
  /** Test/embedding override. Always clamped to the production hard ceiling. */
  maxIndexBytes?: number;
}

interface ArtifactIndex {
  version: 1;
  records: ArtifactRecord[];
}

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_MAX_RECORDS = 4_096;
const HARD_MAX_RECORDS = 16_384;
export const DEFAULT_SESSION_ARTIFACT_REPLAY_LIMIT = 128;
const HARD_SESSION_ARTIFACT_REPLAY_LIMIT = 512;
const DEFAULT_MAX_INDEX_BYTES = 32 * 1024 * 1024;
const HARD_MAX_INDEX_BYTES = 64 * 1024 * 1024;
const SIGNATURE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const INTERACTION_SIGNATURE_TTL_MS = 30 * 60 * 1000;
const MAX_INTERACTION_BYTES = 16 * 1024;
const MAX_INTERACTION_DEPTH = 4;
const STRUCTURED_ACTIONS = ['form-submit', 'action'] as const;
const FORBIDDEN_INTERACTION_FIELD = /^(?:prompt|text|message|credential|credentials|token|secret|password|authorization|permission|decision|session|sessionid|tool|model|agent)$/i;

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');
const safePart = (s: string): string => encodeURIComponent(s);
const recordKey = (brokerSource: string, tool: string, sessionId: string, artifactKey: string): string =>
  `${brokerSource}\0${tool}\0${sessionId}\0${artifactKey}`;
const normalizeBrokerSource = (raw: string): string => {
  try {
    const url = new URL(raw);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return raw.trim();
  }
};
const isHtmlMime = (mimeType: string): boolean => /\bhtml\b/i.test(mimeType);
const positiveNumber = (raw: string | undefined, fallback: number): number => {
  const n = raw == null || raw.trim() === '' ? Number.NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const boundedPositiveInteger = (
  raw: number | string | undefined,
  fallback: number,
  hardMaximum: number,
): number => {
  const n = raw == null || String(raw).trim() === '' ? Number.NaN : Number(raw);
  return Number.isSafeInteger(n) && n > 0
    ? Math.min(n, hardMaximum)
    : fallback;
};

export const artifactKeyFor = (path: string, fingerprint: string): string =>
  Buffer.from(`${path}\0${fingerprint}`, 'utf8').toString('base64url');

/** Header-safe download filename for an export-attachment (defeats hostile filenames / header
 *  injection — the `x"><img...>.html` threat). Only [A-Za-z0-9._-], with the format extension. */
function exportFileName(name: string, format: string): string {
  const ext = `.${format.toLowerCase().replace(/[^a-z0-9]/g, '')}`;
  const base = String(name || 'transcript')
    .replace(/\.[A-Za-z0-9]+$/, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 120) || 'transcript';
  return `${base}${ext}`;
}

function injectCosyncingBridge(html: string, artifactKey: string, nonce: string): string {
  const script = `<script nonce="${nonce}">
(() => {
  const artifactKey = ${JSON.stringify(artifactKey)};
  const targetOrigin = window.location.origin;
  const send = (interaction) => {
    try {
      window.parent.postMessage({
        type: 'cosyncing-artifact-interaction',
        bridgeVersion: 1,
        schemaVersion: 1,
        artifactKey,
        interaction,
      }, targetOrigin);
    } catch {}
  };
  window.__COSYNCING__ = {
    artifactKey,
    submit: (interaction) => send(interaction),
  };
  document.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target;
    let data = {};
    try { data = Object.fromEntries(new FormData(form)); } catch {}
    send({ type: 'form-submit', formId: form?.id || null, data });
  }, true);
  document.addEventListener('click', (event) => {
    const el = event.target?.closest?.('[data-cosyncing-action]');
    if (!el) return;
    event.preventDefault();
    send({
      type: 'action',
      action: el.dataset.cosyncingAction || '',
      value: el.dataset.cosyncingValue || el.dataset.cosyncingPayload || null,
      label: (el.textContent || '').trim() || null,
    });
  }, true);
})();
</script>`;
  return /<\/body\s*>/i.test(html) ? html.replace(/<\/body\s*>/i, `${script}</body>`) : `${html}${script}`;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validateInteractionShape(value: unknown, depth = 0): void {
  if (depth > MAX_INTERACTION_DEPTH) {
    throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_INVALID', 'artifact interaction exceeds the maximum depth');
  }
  if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return;
  if (Array.isArray(value)) {
    if (value.length > 20) throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_INVALID', 'artifact interaction array is too large');
    for (const item of value) validateInteractionShape(item, depth + 1);
    return;
  }
  if (!plainRecord(value)) throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_INVALID', 'artifact interaction must contain plain JSON data');
  const entries = Object.entries(value);
  if (entries.length > 40) throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_INVALID', 'artifact interaction has too many fields');
  for (const [key, item] of entries) {
    if (!key || key.length > 80 || FORBIDDEN_INTERACTION_FIELD.test(key)) {
      throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_INVALID', 'artifact interaction contains a forbidden field');
    }
    validateInteractionShape(item, depth + 1);
  }
}

function shortInteractionString(value: unknown, max: number, required = false): string | undefined {
  if (value == null && !required) return undefined;
  if (typeof value !== 'string') throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_INVALID', 'artifact interaction string field is invalid');
  const out = value.trim();
  if ((required && !out) || out.length > max) {
    throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_INVALID', 'artifact interaction string field is invalid');
  }
  return out || undefined;
}

function normalizeArtifactInteraction(raw: unknown): NormalizedArtifactInteraction {
  let encoded: string;
  try {
    encoded = JSON.stringify(raw);
  } catch {
    throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_INVALID', 'artifact interaction must be JSON serializable');
  }
  if (Buffer.byteLength(encoded || '') > MAX_INTERACTION_BYTES) {
    throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_TOO_LARGE', 'artifact interaction exceeds 16384 bytes');
  }
  validateInteractionShape(raw);
  if (!plainRecord(raw)) throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_INVALID', 'artifact interaction must be an object');
  if (raw.type === 'form-submit') {
    const allowed = new Set(['type', 'formId', 'data']);
    if (Object.keys(raw).some((key) => !allowed.has(key)) || !plainRecord(raw.data)) {
      throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_INVALID', 'form-submit fields are invalid');
    }
    const data: Record<string, string | string[]> = {};
    const entries = Object.entries(raw.data);
    if (entries.length > 32) throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_INVALID', 'form-submit has too many fields');
    for (const [key, value] of entries) {
      if (!key || key.length > 64 || FORBIDDEN_INTERACTION_FIELD.test(key)) {
        throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_INVALID', 'form-submit contains a forbidden field');
      }
      if (typeof value === 'string' && value.length <= 2_000) data[key] = value;
      else if (Array.isArray(value) && value.length <= 20 && value.every((item) => typeof item === 'string' && item.length <= 2_000)) data[key] = value;
      else throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_INVALID', 'form-submit value is invalid');
    }
    return {
      type: 'form-submit',
      ...(shortInteractionString(raw.formId, 120) ? { formId: shortInteractionString(raw.formId, 120) } : {}),
      data,
    };
  }
  if (raw.type === 'action') {
    const allowed = new Set(['type', 'action', 'value', 'label']);
    if (Object.keys(raw).some((key) => !allowed.has(key))) {
      throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_INVALID', 'action fields are invalid');
    }
    const action = shortInteractionString(raw.action, 120, true)!;
    if (!/^[A-Za-z0-9._:-]+$/.test(action) || /^(?:approve|deny|reject|allow|permission|answer)$/i.test(action)) {
      throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_INVALID', 'artifact action is reserved or malformed');
    }
    const value = raw.value;
    if (value !== undefined && value !== null && typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
      throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_INVALID', 'artifact action value is invalid');
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_INVALID', 'artifact action value is invalid');
    }
    if (typeof value === 'string' && value.length > 2_000) {
      throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_INVALID', 'artifact action value is too long');
    }
    const label = shortInteractionString(raw.label, 200);
    return { type: 'action', action, ...(value !== undefined ? { value } : {}), ...(label ? { label } : {}) };
  }
  throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_UNSUPPORTED', 'artifact interaction action class is unsupported');
}

function parseDataUrl(url: string): { mimeType: string; bytes: Buffer } | null {
  const m = url.match(/^data:([^;,]+)?(?:;[^,]*)?;base64,([\s\S]*)$/);
  if (!m) return null;
  return {
    mimeType: m[1] || 'application/octet-stream',
    bytes: Buffer.from(m[2] || '', 'base64'),
  };
}

export function artifactCacheRoot(): string {
  const override = process.env.COSYNCING_CACHE_DIR?.trim();
  if (!override) return join(homedir(), '.cache', PRODUCT_IDENTITY.cacheDirectoryName);
  if (!isAbsolute(override) || override.includes('\0')) throw new Error('COSYNCING_CACHE_DIR must be an absolute path');
  return resolve(override);
}

export class ArtifactStore {
  private readonly root: string;
  private readonly blobDir: string;
  private readonly indexFile: string;
  private readonly secretFile: string;
  private readonly maxBytes: number;
  private readonly maxAgeMs: number;
  private readonly maxRecords: number;
  private readonly maxIndexBytes: number;
  private readonly secret: Buffer;
  private readonly brokerSource: string;
  readonly replayLimit: number;
  private readonly records = new Map<string, ArtifactRecord>();
  /** Strictly increasing LRU clock. Wall-clock milliseconds alone can collide,
   *  which must never let key ordering evict the record a successful call is
   *  about to acknowledge. Seeded from disk so restart preserves ordering. */
  private lastRecency = 0;

  constructor(private readonly brokerUrl: string, root = artifactCacheRoot(), private readonly options: ArtifactStoreOptions = {}) {
    this.root = root;
    this.blobDir = join(root, 'artifacts', 'blobs');
    this.indexFile = join(root, 'artifacts', 'index.json');
    this.secretFile = join(root, 'artifact-url-secret');
    this.brokerSource = normalizeBrokerSource(brokerUrl);
    this.maxBytes = positiveNumber(process.env.COSYNCING_ARTIFACT_CACHE_MAX_BYTES, DEFAULT_MAX_BYTES);
    this.maxAgeMs = positiveNumber(process.env.COSYNCING_ARTIFACT_CACHE_MAX_AGE_DAYS, DEFAULT_MAX_AGE_DAYS) * 24 * 60 * 60 * 1000;
    this.maxRecords = boundedPositiveInteger(
      options.maxRecords ?? process.env.COSYNCING_ARTIFACT_CACHE_MAX_RECORDS,
      DEFAULT_MAX_RECORDS,
      HARD_MAX_RECORDS,
    );
    this.replayLimit = boundedPositiveInteger(
      options.sessionReplayLimit ?? process.env.COSYNCING_ARTIFACT_SESSION_REPLAY_LIMIT,
      DEFAULT_SESSION_ARTIFACT_REPLAY_LIMIT,
      HARD_SESSION_ARTIFACT_REPLAY_LIMIT,
    );
    this.maxIndexBytes = boundedPositiveInteger(
      options.maxIndexBytes ?? process.env.COSYNCING_ARTIFACT_CACHE_MAX_INDEX_BYTES,
      DEFAULT_MAX_INDEX_BYTES,
      HARD_MAX_INDEX_BYTES,
    );
    mkdirSync(this.blobDir, { recursive: true });
    this.secret = this.loadSecret();
    const idx = this.loadIndex();
    const loaded = idx.records || [];
    const retained = loaded.length <= this.maxRecords
      ? loaded
      : [...loaded]
        .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt || b.createdAt - a.createdAt)
        .slice(0, this.maxRecords)
        .reverse();
    for (const r of retained) {
      this.records.set(r.key, r);
      this.lastRecency = Math.max(this.lastRecency, r.createdAt, r.lastAccessedAt);
    }
    if (retained.length !== loaded.length) this.persist('sweep');
  }

  toReference(session: ArtifactSession, message: AgentMessage, brokerUrl?: string): AgentMessage {
    if (message.type !== 'file-artifact') return message;
    if (message.url?.startsWith('data:')) {
      const parsed = parseDataUrl(message.url);
      if (parsed) return this.putBytes(session, message, parsed.bytes, parsed.mimeType, brokerUrl);
    }
    const key = message.artifactKey;
    if (!key) return this.displayOnly(message);
    const record = this.lookupRecord(session.tool, session.id, key);
    if (!record) {
      const { fetchUrl: _fetchUrl, interactionPolicy: _interactionPolicy, ...rest } = message;
      return this.displayOnly(rest as ArtifactMessage);
    }
    return this.asMessage(session, message, record, brokerUrl);
  }

  /** Add the broker's conservative policy to an inline/back-compat artifact without converting it
   * to a stored reference. Inline bytes have no signed broker identity, so they are display-only. */
  displayOnly(message: ArtifactMessage): ArtifactMessage {
    const { interactionPolicy: _interactionPolicy, ...rest } = message;
    return { ...rest, interactionPolicy: this.displayOnlyPolicy() };
  }

  authorizeInteraction(
    session: ArtifactSession,
    artifactKey: unknown,
    interactionRef: unknown,
    interaction: unknown,
  ): AuthorizedArtifactInteraction {
    if (typeof artifactKey !== 'string' || !artifactKey || artifactKey.length > 512) {
      throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_INVALID', 'artifactKey is invalid');
    }
    const record = this.lookupRecord(session.tool, session.id, artifactKey);
    if (!record || !existsSync(record.filePath)) {
      throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_NOT_FOUND', 'artifact interaction target was not found');
    }
    if (!this.isStructured(record)) {
      throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_UNSUPPORTED', 'artifact is display-only');
    }
    if (typeof interactionRef !== 'string' || interactionRef.length > 1024) {
      throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_REF_INVALID', 'artifact interaction reference is invalid');
    }
    const parts = interactionRef.split('.');
    const expires = Number(parts[1]);
    if (parts.length !== 3 || parts[0] !== 'v1' || !Number.isSafeInteger(expires) || expires <= 0) {
      throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_REF_INVALID', 'artifact interaction reference is invalid');
    }
    if (Date.now() > expires) {
      throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_EXPIRED', 'artifact interaction reference expired');
    }
    const expected = this.signInteraction(record, expires);
    try {
      const suppliedBytes = Buffer.from(parts[2]!);
      const expectedBytes = Buffer.from(expected);
      if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
        throw new Error('mismatch');
      }
    } catch {
      throw new ClientMessagePolicyError('ARTIFACT_INTERACTION_REF_INVALID', 'artifact interaction reference is invalid');
    }
    return {
      artifact: { artifactKey: record.artifactKey, name: record.name, path: record.path },
      interaction: normalizeArtifactInteraction(interaction),
    };
  }

  putFile(
    session: ArtifactSession,
    message: AgentMessage & { type: 'file-artifact' },
    fullPath: string,
    brokerUrl?: string,
  ): AgentMessage & { type: 'file-artifact' } {
    const bytes = readFileSync(fullPath);
    return this.putBytes(session, message, bytes, message.mimeType, brokerUrl);
  }

  putBytes(
    session: ArtifactSession,
    message: AgentMessage & { type: 'file-artifact' },
    bytes: Buffer,
    fallbackMimeType = 'application/octet-stream',
    brokerUrl?: string,
    options: { sessionQualified?: boolean } = {},
  ): AgentMessage & { type: 'file-artifact' } {
    const contentHash = sha256(bytes);
    const rel = message.path || message.name || contentHash;
    const artifactKey = message.artifactKey || artifactKeyFor(rel, contentHash);
    const filePath = this.blobPath(contentHash);
    mkdirSync(dirname(filePath), { recursive: true });
    const createdBlob = !existsSync(filePath);
    if (createdBlob) writeFileSync(filePath, bytes);
    const now = this.nextRecency();
    const rec: ArtifactRecord = {
      key: recordKey(this.brokerSource, session.tool, session.id, artifactKey),
      brokerSource: this.brokerSource,
      tool: session.tool,
      sessionId: session.id,
      artifactKey,
      contentHash,
      filePath,
      path: rel,
      name: message.name || basename(rel),
      mimeType: message.mimeType || fallbackMimeType,
      size: bytes.byteLength,
      createdAt: now,
      lastAccessedAt: now,
      ...(options.sessionQualified ? { qualifiedSource: 'managed-connection-v1' as const } : {}),
    };
    this.commitRecord(rec, createdBlob);
    return this.asMessage(session, message, rec, brokerUrl);
  }

  /**
   * Content-address an oversized tool-result diff body and return a signed fetch
   * reference. Mirrors {@link putBytes}' storage (blob-by-hash, LRU-swept, and
   * idempotent — the same body re-hashes to the same blob across re-attach) but
   * returns a bare reference rather than a `file-artifact` message. The body is
   * served by {@link serve} as `text/x-diff`, fetched by the client on expansion.
   */
  stashDiff(
    tool: string,
    sessionId: string,
    keyBase: string,
    body: string,
    brokerUrl?: string,
  ): { fetchUrl: string; contentHash: string; byteSize: number } {
    const bytes = Buffer.from(body, 'utf8');
    const contentHash = sha256(bytes);
    const rel = `diff/${keyBase}`;
    const artifactKey = artifactKeyFor(rel, contentHash);
    const filePath = this.blobPath(contentHash);
    mkdirSync(dirname(filePath), { recursive: true });
    const createdBlob = !existsSync(filePath);
    if (createdBlob) writeFileSync(filePath, bytes);
    const now = this.nextRecency();
    const rec: ArtifactRecord = {
      key: recordKey(this.brokerSource, tool, sessionId, artifactKey),
      brokerSource: this.brokerSource,
      tool,
      sessionId,
      artifactKey,
      contentHash,
      filePath,
      path: rel,
      name: `${keyBase}.diff`,
      mimeType: 'text/x-diff; charset=utf-8',
      size: bytes.byteLength,
      createdAt: now,
      lastAccessedAt: now,
    };
    this.commitRecord(rec, createdBlob);
    return {
      fetchUrl: this.signedUrl(tool, sessionId, artifactKey, brokerUrl),
      contentHash,
      byteSize: bytes.byteLength,
    };
  }

  copyFile(
    session: ArtifactSession,
    message: AgentMessage & { type: 'file-artifact' },
    fullPath: string,
    brokerUrl?: string,
    options: { sessionQualified?: boolean } = {},
  ): AgentMessage & { type: 'file-artifact' } {
    const bytes = readFileSync(fullPath);
    const contentHash = sha256(bytes);
    const rel = message.path || message.name || contentHash;
    const artifactKey = message.artifactKey || artifactKeyFor(rel, contentHash);
    const filePath = this.blobPath(contentHash);
    mkdirSync(dirname(filePath), { recursive: true });
    const createdBlob = !existsSync(filePath);
    if (createdBlob) copyFileSync(fullPath, filePath);
    const now = this.nextRecency();
    const rec: ArtifactRecord = {
      key: recordKey(this.brokerSource, session.tool, session.id, artifactKey),
      brokerSource: this.brokerSource,
      tool: session.tool,
      sessionId: session.id,
      artifactKey,
      contentHash,
      filePath,
      path: rel,
      name: message.name || basename(rel),
      mimeType: message.mimeType,
      size: bytes.byteLength,
      createdAt: now,
      lastAccessedAt: now,
      ...(options.sessionQualified ? { qualifiedSource: 'managed-connection-v1' as const } : {}),
    };
    this.commitRecord(rec, createdBlob);
    return this.asMessage(session, message, rec, brokerUrl);
  }

  /** Durable broker-injected artifacts whose producer proved this exact
   *  broker-owned tool/session connection. This is the only restart replay
   *  path for artifacts absent from native history. Records written before
   *  session-qualified delivery was introduced fail closed here. */
  sessionQualifiedArtifacts(
    session: ArtifactSession,
    brokerUrl?: string,
  ): Array<AgentMessage & { type: 'file-artifact' }> {
    const now = Date.now();
    const matching = [...this.records.values()]
      .filter((record) =>
        record.tool === session.tool &&
        record.sessionId === session.id &&
        record.brokerSource === this.brokerSource &&
        record.qualifiedSource === 'managed-connection-v1' &&
        existsSync(record.filePath) &&
        (!record.expiresAt || now <= record.expiresAt)
      )
      .sort((a, b) => a.createdAt - b.createdAt)
      .slice(-this.replayLimit);
    return matching
      .map((record) => this.asMessage(
        session,
        {
          type: 'file-artifact',
          path: record.path,
          name: record.name,
          mimeType: record.mimeType,
          size: record.size,
          proactive: true,
          ...(record.deliveryClass ? { deliveryClass: record.deliveryClass } : {}),
          ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
          ...(record.format ? { format: record.format } : {}),
          ...(record.redactionSummary ? { redactionSummary: record.redactionSummary } : {}),
        },
        record,
        brokerUrl,
      ));
  }

  /**
   * Ingest an R2 transcript export as an `export-attachment` artifact (rules 14-16). Bytes are read
   * ONLY from a broker-owned temp file inside `tempRoot`: the real path must resolve inside the real
   * temp root, must not be a symlink, must be a regular file, and must carry the expected extension.
   * The artifact id is a random opaque token (never path-derived). Served download-only, never inline.
   */
  putExportAttachment(
    session: ArtifactSession,
    meta: ExportAttachmentMeta,
    filePath: string,
    tempRoot: string,
    brokerUrl?: string,
  ): AgentMessage & { type: 'file-artifact' } {
    const realRoot = realpathSync(tempRoot);
    const lst = lstatSync(filePath); // throws if the file is missing
    if (lst.isSymbolicLink()) throw new Error('export path is a symlink');
    const realFile = realpathSync(filePath);
    if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) throw new Error('export path escapes the broker temp root');
    const st = statSync(realFile);
    if (!st.isFile()) throw new Error('export path is not a regular file');
    const expectExt = `.${meta.format.toLowerCase()}`;
    if (extname(realFile).toLowerCase() !== expectExt) throw new Error(`unexpected export extension: ${extname(realFile)}`);
    const bytes = readFileSync(realFile);
    const contentHash = sha256(bytes);
    const artifactKey = randomBytes(24).toString('base64url'); // opaque, not path-derived (rule 14)
    const blob = this.blobPath(contentHash);
    mkdirSync(dirname(blob), { recursive: true });
    const createdBlob = !existsSync(blob);
    if (createdBlob) writeFileSync(blob, bytes);
    const now = Date.now();
    const recency = this.nextRecency();
    const safeName = exportFileName(meta.name, meta.format);
    const rec: ArtifactRecord = {
      key: recordKey(this.brokerSource, session.tool, session.id, artifactKey),
      brokerSource: this.brokerSource,
      tool: session.tool,
      sessionId: session.id,
      artifactKey,
      contentHash,
      filePath: blob,
      path: safeName,
      name: safeName,
      mimeType: 'application/octet-stream',
      size: bytes.byteLength,
      createdAt: recency,
      lastAccessedAt: recency,
      deliveryClass: 'export-attachment',
      expiresAt: now + meta.retentionMs,
      format: meta.format,
      redactionSummary: meta.redactionSummary,
    };
    this.commitRecord(rec, createdBlob);
    return {
      type: 'file-artifact',
      path: safeName,
      name: safeName,
      mimeType: 'application/octet-stream',
      size: bytes.byteLength,
      artifactKey,
      contentHash,
      deliveryClass: 'export-attachment',
      format: meta.format,
      ...(meta.redactionSummary ? { redactionSummary: meta.redactionSummary } : {}),
      expiresAt: rec.expiresAt,
      interactionPolicy: this.displayOnlyPolicy(),
      fetchUrl: this.signedUrl(session.tool, session.id, artifactKey, brokerUrl, meta.retentionMs),
    };
  }

  /** Delete every export-attachment artifact + its blobs (rule 18: delete on broker shutdown). */
  clearExportAttachments(): number {
    const removed: ArtifactRecord[] = [];
    const n = this.commitMutation('clear', () => {
      let count = 0;
      for (const [key, rec] of [...this.records.entries()]) {
        if (
          rec.deliveryClass !== 'export-attachment' ||
          (rec.brokerSource && rec.brokerSource !== this.brokerSource)
        ) continue;
        this.records.delete(key);
        removed.push(rec);
        count++;
      }
      return count;
    });
    this.removeUnreferenced(removed);
    return n;
  }

  serve(tool: string, sessionId: string, artifactKey: string, expiresRaw: string | null, sigRaw: string | null): Response {
    const expires = Number(expiresRaw ?? 0);
    if (!expires || !sigRaw || Date.now() > expires) return new Response('artifact URL expired', { status: 403 });
    if (!this.verify(tool, sessionId, artifactKey, expires, sigRaw)) return new Response('invalid artifact signature', { status: 403 });
    const rec = this.lookupRecord(tool, sessionId, artifactKey);
    if (!rec || !existsSync(rec.filePath)) return new Response('artifact not found', { status: 404 });
    // R2 export-attachment: download-only, never inline-rendered, never bridge-injected. Enforce the
    // absolute retention expiry independently of the URL signature TTL.
    if (rec.deliveryClass === 'export-attachment') {
      if (rec.expiresAt && Date.now() > rec.expiresAt) return new Response('artifact expired', { status: 403 });
      this.commitMutation('access', () => { rec.lastAccessedAt = this.nextRecency(); }, rec.key);
      const h = new Headers();
      h.set('content-type', 'application/octet-stream');
      h.set('content-disposition', `attachment; filename="${exportFileName(rec.name, rec.format || 'bin')}"`);
      h.set('cache-control', 'no-store');
      h.set('content-security-policy', 'sandbox');
      h.set('x-content-type-options', 'nosniff');
      h.set('x-cosyncing-artifact-key', rec.artifactKey);
      h.set('x-cosyncing-content-hash', rec.contentHash);
      h.set('content-length', String(rec.size));
      return new Response(Bun.file(rec.filePath), { headers: h });
    }
    this.commitMutation('access', () => { rec.lastAccessedAt = this.nextRecency(); }, rec.key);
    const headers = new Headers();
    headers.set('content-type', rec.mimeType || 'application/octet-stream');
    headers.set('cache-control', 'private, max-age=604800');
    headers.set('x-cosyncing-artifact-key', rec.artifactKey);
    headers.set('x-cosyncing-content-hash', rec.contentHash);
    headers.set('x-content-type-options', 'nosniff');
    if (isHtmlMime(rec.mimeType)) {
      const nonce = randomBytes(18).toString('base64url');
      const html = injectCosyncingBridge(readFileSync(rec.filePath, 'utf8'), rec.artifactKey, nonce);
      headers.set(
        'content-security-policy',
        [
          "default-src 'none'",
          `script-src 'nonce-${nonce}'`,
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "connect-src 'none'",
          "frame-src 'none'",
          "object-src 'none'",
          "base-uri 'none'",
          "form-action 'none'",
        ].join('; '),
      );
      headers.set('cache-control', 'no-store');
      headers.set('x-frame-options', 'SAMEORIGIN');
      headers.set('content-length', String(Buffer.byteLength(html)));
      return new Response(html, { headers });
    }
    headers.set('content-length', String(rec.size));
    return new Response(Bun.file(rec.filePath), { headers });
  }

  clearSession(tool: string, sessionId: string): number {
    const removed: ArtifactRecord[] = [];
    const n = this.commitMutation('clear', () => {
      let count = 0;
      for (const [key, rec] of [...this.records.entries()]) {
        if (
          rec.brokerSource !== this.brokerSource ||
          rec.tool !== tool ||
          rec.sessionId !== sessionId
        ) continue;
        this.records.delete(key);
        removed.push(rec);
        count++;
      }
      return count;
    });
    this.removeUnreferenced(removed);
    return n;
  }

  private asMessage(
    session: ArtifactSession,
    message: AgentMessage & { type: 'file-artifact' },
    rec: ArtifactRecord,
    brokerUrl?: string,
  ): AgentMessage & { type: 'file-artifact' } {
    const { url: _url, interactionPolicy: _interactionPolicy, ...rest } = message;
    return {
      ...rest,
      path: message.path || rec.path,
      name: message.name || rec.name,
      mimeType: message.mimeType || rec.mimeType,
      size: message.size ?? rec.size,
      artifactKey: rec.artifactKey,
      contentHash: rec.contentHash,
      fetchUrl: this.signedUrl(session.tool, session.id, rec.artifactKey, brokerUrl),
      interactionPolicy: this.interactionPolicy(rec),
    };
  }

  private displayOnlyPolicy(): ArtifactInteractionPolicy {
    return { mode: 'display-only', bridgeVersion: 1, schemaVersion: 1, allowedActions: [] };
  }

  private isStructured(record: ArtifactRecord): boolean {
    return record.deliveryClass !== 'export-attachment' && isHtmlMime(record.mimeType);
  }

  private interactionPolicy(record: ArtifactRecord): ArtifactInteractionPolicy {
    if (!this.isStructured(record)) return this.displayOnlyPolicy();
    const expiresAt = Date.now() + INTERACTION_SIGNATURE_TTL_MS;
    return {
      mode: 'structured',
      bridgeVersion: 1,
      schemaVersion: 1,
      allowedActions: [...STRUCTURED_ACTIONS],
      expiresAt,
      interactionRef: `v1.${expiresAt}.${this.signInteraction(record, expiresAt)}`,
    };
  }

  private signedUrl(tool: string, sessionId: string, artifactKey: string, brokerUrl = this.brokerUrl, ttlMs = SIGNATURE_TTL_MS): string {
    const expires = Date.now() + ttlMs;
    const sig = this.sign(tool, sessionId, artifactKey, expires);
    const url = new URL(
      `/api/sessions/${safePart(tool)}/${safePart(sessionId)}/artifact/${safePart(artifactKey)}`,
      brokerUrl,
    );
    url.searchParams.set('expires', String(expires));
    url.searchParams.set('sig', sig);
    return url.toString();
  }

  private sign(tool: string, sessionId: string, artifactKey: string, expires: number): string {
    return createHmac('sha256', this.secret)
      .update(`${this.brokerSource}\0${tool}\0${sessionId}\0${artifactKey}\0${expires}`)
      .digest('base64url');
  }

  private signInteraction(record: ArtifactRecord, expires: number): string {
    return createHmac('sha256', this.secret)
      .update([
        'artifact-interaction-v1',
        this.brokerSource,
        record.tool,
        record.sessionId,
        record.artifactKey,
        record.contentHash,
        String(expires),
        STRUCTURED_ACTIONS.join(','),
      ].join('\0'))
      .digest('base64url');
  }

  private verify(tool: string, sessionId: string, artifactKey: string, expires: number, sig: string): boolean {
    try {
      const a = Buffer.from(sig);
      const b = Buffer.from(this.sign(tool, sessionId, artifactKey, expires));
      return a.length === b.length && timingSafeEqual(a, b);
    } catch {
      return false;
    }
  }

  private blobPath(hash: string): string {
    return join(this.blobDir, hash.slice(0, 2), hash);
  }

  private lookupRecord(tool: string, sessionId: string, artifactKey: string): ArtifactRecord | undefined {
    const record = this.records.get(recordKey(this.brokerSource, tool, sessionId, artifactKey));
    return record?.brokerSource === this.brokerSource ? record : undefined;
  }

  private loadSecret(): Buffer {
    try {
      return Buffer.from(readFileSync(this.secretFile, 'utf8').trim(), 'base64');
    } catch {
      const secret = randomBytes(32);
      mkdirSync(dirname(this.secretFile), { recursive: true });
      writeFileSync(this.secretFile, secret.toString('base64'), { mode: 0o600 });
      return secret;
    }
  }

  private loadIndex(): ArtifactIndex {
    if (!existsSync(this.indexFile)) return { version: 1, records: [] };
    try {
      if (statSync(this.indexFile).size > this.maxIndexBytes) {
        throw new Error('artifact index exceeds the bounded load limit');
      }
      const parsed = JSON.parse(readFileSync(this.indexFile, 'utf8')) as Partial<ArtifactIndex>;
      if (parsed.version !== 1 || !Array.isArray(parsed.records)) throw new Error('unsupported artifact index');
      return parsed as ArtifactIndex;
    } catch {
      // Preserve corrupt bytes for diagnosis rather than silently replacing them. The callback is
      // sanitized and isolated; the broker health layer never receives the path or parse error.
      const backup = `${this.indexFile}.corrupt-${Date.now()}-${randomBytes(6).toString('hex')}`;
      try { renameSync(this.indexFile, backup); } catch { /* retain the original in place if backup fails */ }
      this.reportPersistence({ ok: false, operation: 'load', at: Date.now() });
      return { version: 1, records: [] };
    }
  }

  private persist(operation: ArtifactStorePersistenceOperation, requiredKey?: string): void {
    mkdirSync(dirname(this.indexFile), { recursive: true });
    const evicted: ArtifactRecord[] = [];
    let serialized = '';
    try {
      for (;;) {
        const idx: ArtifactIndex = { version: 1, records: [...this.records.values()] };
        serialized = JSON.stringify(idx);
        if (Buffer.byteLength(serialized, 'utf8') <= this.maxIndexBytes) break;
        // Retention is deterministic and agrees with the count/byte sweep:
        // discard least-recently-used records first, then oldest creation, then
        // stable record key. Never persist an empty success for a newly accepted
        // record that cannot fit by itself; reject the surrounding transaction
        // and leave the last valid index untouched instead.
        if (this.records.size <= 1) {
          throw new Error('artifact index record exceeds the bounded persistence limit');
        }
        const oldest = [...this.records.values()]
          .filter((record) => record.key !== requiredKey)
          .sort((a, b) =>
            a.lastAccessedAt - b.lastAccessedAt ||
            a.createdAt - b.createdAt ||
            (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
          )[0];
        if (!oldest) {
          throw new Error('required artifact index record exceeds the bounded persistence limit');
        }
        this.records.delete(oldest.key);
        evicted.push(oldest);
      }
      if (requiredKey && !this.records.has(requiredKey)) {
        throw new Error('required artifact record was lost before persistence');
      }
    } catch (error) {
      this.reportPersistence({ ok: false, operation, at: Date.now() });
      throw error;
    }
    const tempFile = join(dirname(this.indexFile), `.index-${process.pid}-${randomBytes(12).toString('hex')}.tmp`);
    let fd: number | undefined;
    try {
      fd = openSync(tempFile, 'wx', 0o600);
      writeFileSync(fd, serialized);
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(tempFile, this.indexFile);
    } catch (error) {
      this.reportPersistence({ ok: false, operation, at: Date.now() });
      throw error;
    } finally {
      if (fd != null) {
        try { closeSync(fd); } catch { /* preserve the persistence error */ }
      }
      try { rmSync(tempFile, { force: true }); } catch { /* best-effort temp cleanup */ }
    }
    if (requiredKey && !this.records.has(requiredKey)) {
      throw new Error('required artifact record was lost after persistence');
    }
    this.removeUnreferenced(evicted);
    this.reportPersistence({ ok: true, operation, at: Date.now() });
  }

  private reportPersistence(result: ArtifactStorePersistenceResult): void {
    try {
      this.options.onPersistenceResult?.(result);
    } catch {
      // Observability is not part of the storage transaction and must never change its outcome.
    }
  }

  private commitMutation<T>(
    operation: ArtifactStorePersistenceOperation,
    mutate: () => T,
    requiredKey?: string,
  ): T {
    // Clone record values as well as the Map: access-time updates mutate a record object in place.
    const before = new Map([...this.records].map(([key, record]) => [key, { ...record }]));
    try {
      const result = mutate();
      this.persist(operation, requiredKey);
      if (requiredKey && !this.records.has(requiredKey)) {
        throw new Error('required artifact record was not indexed after persistence');
      }
      return result;
    } catch (error) {
      this.records.clear();
      for (const [key, record] of before) this.records.set(key, record);
      throw error;
    }
  }

  private commitRecord(record: ArtifactRecord, createdBlob: boolean): void {
    const removed: ArtifactRecord[] = [];
    try {
      this.commitMutation('put', () => {
        const replaced = this.records.get(record.key);
        if (replaced && replaced.contentHash !== record.contentHash) removed.push(replaced);
        this.records.set(record.key, record);
        removed.push(...this.applyRetention(record.key));
      }, record.key);
      this.removeUnreferenced(removed);
    } catch (error) {
      if (createdBlob) {
        try { rmSync(record.filePath, { force: true }); } catch { /* preserve the index error */ }
      }
      throw error;
    }
  }

  /** Apply every retention boundary inside the insertion transaction. Blob
   *  removal happens only after the resulting index is durably replaced. */
  private applyRetention(requiredKey: string): ArtifactRecord[] {
    const removed: ArtifactRecord[] = [];
    const now = Date.now();
    for (const [key, rec] of [...this.records.entries()]) {
      // Export attachments expire on an absolute retention deadline; other
      // records age out by last access. The inserted record is never eligible.
      const expired = rec.expiresAt ? now > rec.expiresAt : now - rec.lastAccessedAt > this.maxAgeMs;
      if (!expired || key === requiredKey) continue;
      this.records.delete(key);
      removed.push(rec);
    }
    let records = [...this.records.values()];
    if (records.length > this.maxRecords) {
      const candidates = records
        .filter((candidate) => candidate.key !== requiredKey)
        .sort((a, b) =>
          a.lastAccessedAt - b.lastAccessedAt ||
          a.createdAt - b.createdAt ||
          (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
        );
      for (const candidate of candidates.slice(0, records.length - this.maxRecords)) {
        this.records.delete(candidate.key);
        removed.push(candidate);
      }
      records = [...this.records.values()];
    }
    let total = records.reduce((sum, record) => sum + record.size, 0);
    if (total > this.maxBytes) {
      records = records.sort((a, b) =>
        a.lastAccessedAt - b.lastAccessedAt ||
        a.createdAt - b.createdAt ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
      );
      for (const candidate of records) {
        if (total <= this.maxBytes * 0.8) break;
        if (candidate.key === requiredKey) continue;
        this.records.delete(candidate.key);
        removed.push(candidate);
        total -= candidate.size;
      }
      if (total > this.maxBytes * 0.8) {
        throw new Error('required artifact record exceeds the bounded cache limit');
      }
    }
    return removed;
  }

  private nextRecency(): number {
    this.lastRecency = Math.max(Date.now(), this.lastRecency + 1);
    return this.lastRecency;
  }

  private removeUnreferenced(removed: ArtifactRecord[]): void {
    if (!removed.length) return;
    const liveHashes = new Set([...this.records.values()].map((r) => r.contentHash));
    for (const rec of removed) {
      if (liveHashes.has(rec.contentHash)) continue;
      try {
        rmSync(rec.filePath);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}
