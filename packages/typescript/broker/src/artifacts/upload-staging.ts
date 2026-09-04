/**
 * Broker-owned chunked upload and prompt-attachment staging.
 *
 * Upload bytes remain outside the workspace until completion. Completion
 * moves them into the session inbox but returns only an opaque reference.
 * Prompt consumption binds that reference to the authenticated credential,
 * tool, session, and client-message identity before an adapter can see the
 * broker-owned path.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
  type Dirent,
} from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import {
  PROMPT_ATTACHMENT_LIMITS,
  type FileInput,
  type UploadCompleteResult,
  type UploadErrorCode,
  type UploadInitRequest,
  type UploadInitResult,
  type UploadPatchResult,
  type UploadStatus,
} from '@cosyncing/protocol';
import { setupStateHome } from '../installation/setup-state.ts';
import { PRODUCT_IDENTITY } from '@cosyncing/protocol';

/**
 * How much of the inbox registry one sweep may touch.
 *
 * Same posture as {@link UploadStaging.sweepExpired}, which these bounds sit
 * beside on one hourly timer: bound the work per tick and carry a cursor, so a
 * host with hundreds of stale workspaces pays for them over hours instead of
 * stalling one tick. Nothing here is a retention decision — a root skipped this
 * hour is swept the next.
 */
const INBOX_SWEEP_MAX_ROOTS = 32;
const INBOX_SWEEP_MAX_ENTRIES_PER_ROOT = 256;
/** Registered roots kept at once; the oldest registration is dropped past this. */
const INBOX_ROOT_REGISTRY_CAP = 256;
/**
 * Upper bound on staging records read to build the never-delete set.
 *
 * Unlike every other bound here, this one cannot be applied by truncation: an
 * incomplete never-delete set is indistinguishable from an empty one at the
 * unlink, so reaching it aborts the sweep instead of shortening it.
 */
const INBOX_PROTECTED_RECORD_CAP = 8192;

export class UploadError extends Error {
  constructor(
    readonly code: UploadErrorCode,
    message: string,
    readonly status = 400,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Credential plus exact saved client-profile incarnation upload namespace. */
export function scopedUploadIdentity(
  credentialIdentity: string,
  profileId?: string,
  incarnation?: string,
): string {
  if (!profileId && !incarnation) {
    return `${credentialIdentity}|client-source:legacy`;
  }
  const digest = (value: string | undefined) =>
    createHash('sha256').update((value ?? '').slice(0, 512)).digest('hex');
  return `${credentialIdentity}|profile:${digest(profileId)}|incarnation:${digest(incarnation)}`;
}

type UploadState = 'uploading' | 'ready';

interface UploadRecord {
  uploadId: string;
  identity: string;
  tool: string;
  sessionId: string;
  name: string;
  mimeType: string;
  offset: number;
  expectedSize: number | null;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  dataPath: string;
  state: UploadState;
  stagedRef?: string;
  contentHash?: string;
  expectedContentHash?: string;
  claimedClientMessageId?: string;
}

export interface PreparedPromptFiles {
  files: FileInput[];
  inlinePaths: string[];
  staged: Array<{ uploadId: string; clientMessageId: string }>;
}

/** One inbox sweep's outcome. Returned for logging and asserted by the suite. */
export interface InboxSweepResult {
  /** Registered roots this call inspected, bounded by {@link INBOX_SWEEP_MAX_ROOTS}. */
  roots: number;
  /** Regular files listed across those roots. */
  scanned: number;
  removed: number;
  bytes: number;
  /** Roots dropped from the registry because their directory is gone. */
  dropped: number;
  /** Roots refused because the inbox no longer resolves to itself. */
  refused: number;
}

/** The durable set of session cwds whose inboxes are in scope for collection. */
interface InboxRootRegistry {
  roots: string[];
  cursor: number;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeJsonAtomically(path: string, value: unknown): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(value));
  renameSync(tmp, path);
}

export interface UploadFileMover {
  renameSync(from: string, to: string): void;
  copyFileSync(from: string, to: string): void;
  unlinkSync(path: string): void;
}

export function moveUploadFileIntoInbox(
  from: string,
  to: string,
  mover: UploadFileMover = { renameSync, copyFileSync, unlinkSync },
): void {
  try {
    mover.renameSync(from, to);
    return;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
  }
  mover.copyFileSync(from, to);
  mover.unlinkSync(from);
}

function safeUploadName(raw: unknown): string {
  if (typeof raw !== 'string') throw new UploadError('BAD_PARAM', 'name is required');
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') {
    throw new UploadError('BAD_PARAM', 'name must be a non-dot basename');
  }
  if (trimmed.includes('\0')) throw new UploadError('BAD_PARAM', 'name contains a NUL byte');
  if (trimmed.includes('/') || trimmed.includes('\\')) {
    throw new UploadError('BAD_PARAM', 'name must be a basename');
  }
  if (trimmed.length > 255) throw new UploadError('BAD_PARAM', 'name is too long');
  return trimmed;
}

function assertSafeUploadId(raw: string): void {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
    throw new UploadError('BAD_PARAM', 'uploadId must be a broker-issued UUID');
  }
}

function sanitizeMime(raw: unknown): string {
  const mime = typeof raw === 'string' ? raw.trim() : '';
  if (mime.length > 255 || /[\r\n\0]/.test(mime)) {
    throw new UploadError('BAD_PARAM', 'mimeType is invalid');
  }
  return mime || 'application/octet-stream';
}

function parseExpectedSize(raw: unknown, maxBytes: number): number | undefined {
  if (raw == null) return undefined;
  if (!Number.isInteger(raw) || (raw as number) < 0) {
    throw new UploadError('BAD_PARAM', 'size must be a non-negative integer');
  }
  const size = raw as number;
  if (size > maxBytes) {
    throw new UploadError('UPLOAD_TOO_LARGE', `size exceeds attachment limit (${maxBytes})`, 413);
  }
  return size;
}

function progressFor(offset: number, expectedSize: number | null): number {
  if (!expectedSize || expectedSize <= 0) return 0;
  return Math.max(0, Math.min(1, offset / expectedSize));
}

function readUploadRecord(path: string): UploadRecord {
  const raw = readJson(path);
  if (!raw || typeof raw !== 'object') {
    throw new UploadError('UPLOAD_NOT_FOUND', 'upload metadata is missing', 404);
  }
  const obj = raw as Partial<UploadRecord>;
  if (
    typeof obj.uploadId !== 'string'
    || typeof obj.identity !== 'string'
    || typeof obj.tool !== 'string'
    || typeof obj.sessionId !== 'string'
    || typeof obj.name !== 'string'
    || typeof obj.mimeType !== 'string'
    || typeof obj.offset !== 'number'
    || (obj.expectedSize !== null && typeof obj.expectedSize !== 'number')
    || typeof obj.createdAt !== 'number'
    || typeof obj.updatedAt !== 'number'
    || typeof obj.expiresAt !== 'number'
    || typeof obj.dataPath !== 'string'
    || (obj.state !== 'uploading' && obj.state !== 'ready')
    || (obj.stagedRef !== undefined && typeof obj.stagedRef !== 'string')
    || (obj.contentHash !== undefined && typeof obj.contentHash !== 'string')
    || (obj.expectedContentHash !== undefined && typeof obj.expectedContentHash !== 'string')
    || (obj.claimedClientMessageId !== undefined && typeof obj.claimedClientMessageId !== 'string')
  ) {
    throw new UploadError('UPLOAD_NOT_FOUND', 'invalid upload metadata', 404);
  }
  return obj as UploadRecord;
}

function nextUniqueInDir(dir: string, rawName: string): string {
  const name = basename(rawName).trim() || 'upload';
  let candidate = name;
  const suffixSeed = randomUUID().slice(0, 8);
  let cursor = 1;
  while (true) {
    try {
      lstatSync(join(dir, candidate));
      const ext = extname(name);
      const stem = ext ? name.slice(0, -ext.length) : name;
      candidate = cursor === 1 ? `${stem}-${suffixSeed}${ext}` : `${stem}-${cursor}${ext}`;
      cursor += 1;
    } catch {
      return candidate;
    }
  }
}

function decodeCanonicalBase64(raw: string): Buffer {
  if (
    raw.length === 0
    || raw.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw)
  ) {
    throw new UploadError('BAD_PARAM', 'inline attachment data is not canonical base64');
  }
  const bytes = Buffer.from(raw, 'base64');
  if (bytes.toString('base64') !== raw) {
    throw new UploadError('BAD_PARAM', 'inline attachment data is not canonical base64');
  }
  return bytes;
}

function sameSecret(expected: string, actual: string): boolean {
  const left = Buffer.from(expected);
  const right = Buffer.from(actual);
  return left.length === right.length && timingSafeEqual(left, right);
}

function canonicalContentHash(raw: unknown): string | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(raw)) {
    throw new UploadError('BAD_PARAM', 'contentHash must be a canonical SHA-256 digest');
  }
  return raw;
}

async function hashFileIncrementally(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return `sha256:${hash.digest('hex')}`;
}

export class UploadStaging {
  private readonly home: string;
  private readonly maxBytes: number;
  private readonly ttlMs: number;
  private readonly maxRecordsPerScope: number;
  private readonly maxScopeBytes: number;
  private readonly cleanupBatchRecords: number;
  private readonly inboxRetentionMs: number;
  private readonly maxInboxBytes: number;
  private readonly maxInboxFiles: number;
  /**
   * Files kept whatever the CAP rules say.
   *
   * This floor bounds cap-driven eviction only. The retention age is not
   * subject to it: an inbox of three files a user last touched in June is
   * exactly the leak this sweep exists to clear, and a floor that spared it
   * would leave every small workspace collecting forever.
   */
  private readonly inboxFileFloor = PROMPT_ATTACHMENT_LIMITS.maxRetainedClientFiles;
  /** A file this new is never collected while a live session holds its cwd. */
  private readonly inboxGraceMs = PROMPT_ATTACHMENT_LIMITS.stagingTtlMs;
  private readonly hashFile: (path: string) => Promise<string>;
  /** Claims owned by a prompt currently awaiting its adapter handoff. */
  private readonly activeClaims = new Set<string>();
  /** Upload ids currently being hashed/finalized. */
  private readonly activeCompletions = new Set<string>();
  private readonly revokedCredentialIdentities = new Set<string>();

  constructor(options?: {
    home?: string;
    maxBytes?: number;
    ttlMs?: number;
    maxRecordsPerScope?: number;
    maxScopeBytes?: number;
    cleanupBatchRecords?: number;
    inboxRetentionMs?: number;
    maxInboxBytes?: number;
    maxInboxFiles?: number;
    hashFile?: (path: string) => Promise<string>;
  }) {
    this.home = options?.home ?? setupStateHome();
    this.maxBytes = options?.maxBytes
      ?? envNumber('COSYNCING_UPLOAD_MAX_BYTES', PROMPT_ATTACHMENT_LIMITS.maxFileBytes);
    this.ttlMs = options?.ttlMs
      ?? envNumber('COSYNCING_UPLOAD_TTL_MS', PROMPT_ATTACHMENT_LIMITS.stagingTtlMs);
    this.maxRecordsPerScope = options?.maxRecordsPerScope
      ?? PROMPT_ATTACHMENT_LIMITS.maxStagedRecordsPerScope;
    this.maxScopeBytes = options?.maxScopeBytes
      ?? PROMPT_ATTACHMENT_LIMITS.maxStagedBytesPerScope;
    this.cleanupBatchRecords = options?.cleanupBatchRecords
      ?? PROMPT_ATTACHMENT_LIMITS.cleanupBatchRecords;
    this.inboxRetentionMs = options?.inboxRetentionMs
      ?? envNumber('COSYNCING_INBOX_RETENTION_MS', PROMPT_ATTACHMENT_LIMITS.inboxRetentionMs);
    this.maxInboxBytes = options?.maxInboxBytes
      ?? envNumber('COSYNCING_INBOX_MAX_BYTES', PROMPT_ATTACHMENT_LIMITS.maxInboxBytes);
    this.maxInboxFiles = options?.maxInboxFiles
      ?? envNumber('COSYNCING_INBOX_MAX_FILES', PROMPT_ATTACHMENT_LIMITS.maxInboxFiles);
    this.hashFile = options?.hashFile ?? hashFileIncrementally;
    // `sweepInboxes` deliberately does NOT run here. Broker start already does
    // enough IO; the timer's first tick is soon enough and is deferred off the
    // startup path.
    this.sweepExpired();
  }

  init(req: UploadInitRequest, identity = 'loopback-local'): UploadInitResult {
    this.assertIdentityActive(identity);
    this.sweepExpired();
    const name = safeUploadName(req.name);
    const mimeType = sanitizeMime(req.mimeType);
    const expectedSize = parseExpectedSize(req.expectedSize, this.maxBytes);
    const expectedContentHash = canonicalContentHash(req.contentHash);
    this.assertScopeCapacity(req.tool, req.sessionId, identity, expectedSize ?? 0);
    const uploadId = randomUUID();
    const dataRoot = this.sessionRoot(req.tool, req.sessionId);
    const dataPath = join(dataRoot, `${uploadId}.bin`);
    const metaPath = join(dataRoot, `${uploadId}.json`);
    const now = Date.now();

    mkdirSync(dataRoot, { recursive: true });
    const fd = openSync(dataPath, 'wx');
    closeSync(fd);

    const meta: UploadRecord = {
      uploadId,
      identity,
      tool: req.tool,
      sessionId: req.sessionId,
      name,
      mimeType,
      offset: 0,
      expectedSize: expectedSize ?? null,
      createdAt: now,
      updatedAt: now,
      expiresAt: now + this.ttlMs,
      dataPath,
      state: 'uploading',
      ...(expectedContentHash ? { expectedContentHash } : {}),
    };
    writeJsonAtomically(metaPath, meta);
    return { uploadId, offset: 0, size: expectedSize ?? 0, expiresAt: meta.expiresAt };
  }

  status(
    tool: string,
    sessionId: string,
    uploadId: string,
    identity = 'loopback-local',
  ): UploadStatus {
    this.assertIdentityActive(identity);
    const record = this.loadRecord(tool, sessionId, uploadId, identity);
    return {
      uploadId: record.uploadId,
      offset: record.offset,
      size: record.expectedSize ?? 0,
      name: record.name,
      mimeType: record.mimeType,
      expiresAt: record.expiresAt,
      ...(record.state === 'ready' ? { ready: true } : {}),
    };
  }

  patch(
    tool: string,
    sessionId: string,
    uploadId: string,
    offsetHeader: string | null,
    chunk: Uint8Array,
    identity = 'loopback-local',
  ): UploadPatchResult {
    this.assertIdentityActive(identity);
    const parsedOffset = this.parseOffset(offsetHeader);
    const record = this.loadRecord(tool, sessionId, uploadId, identity);
    if (this.activeCompletions.has(uploadId)) {
      throw new UploadError('UPLOAD_SCOPE_MISMATCH', 'upload completion is already in progress', 409);
    }
    if (record.state !== 'uploading') {
      throw new UploadError('UPLOAD_SIZE_MISMATCH', 'completed upload cannot accept more bytes', 409);
    }
    if (parsedOffset !== record.offset) {
      throw new UploadError(
        'UPLOAD_OFFSET_MISMATCH',
        `expected offset ${record.offset}, got ${parsedOffset}`,
        409,
        { offset: record.offset, expectedOffset: record.offset, receivedOffset: parsedOffset },
      );
    }
    if (record.expectedSize != null && record.offset + chunk.byteLength > record.expectedSize) {
      throw new UploadError('UPLOAD_SIZE_MISMATCH', 'chunk would exceed advertised upload size', 409);
    }
    if (record.offset + chunk.byteLength > this.maxBytes) {
      throw new UploadError('UPLOAD_TOO_LARGE', `upload exceeds attachment limit (${this.maxBytes})`, 413);
    }
    this.assertScopeByteGrowth(tool, sessionId, identity, chunk.byteLength);

    const fd = openSync(record.dataPath, 'r+');
    try {
      const written = this.writeAt(fd, chunk, record.offset);
      const next: UploadRecord = {
        ...record,
        offset: record.offset + written,
        updatedAt: Date.now(),
      };
      writeJsonAtomically(this.recordPath(tool, sessionId, uploadId), next);
      return {
        uploadId: next.uploadId,
        offset: next.offset,
        size: next.expectedSize ?? 0,
        progress: progressFor(next.offset, next.expectedSize),
      };
    } finally {
      closeSync(fd);
    }
  }

  async complete(
    tool: string,
    sessionId: string,
    uploadId: string,
    sessionCwd: string,
    identity = 'loopback-local',
  ): Promise<UploadCompleteResult> {
    this.assertIdentityActive(identity);
    const record = this.loadRecord(tool, sessionId, uploadId, identity);
    if (record.state === 'ready') return this.completeResult(record);
    if (this.activeCompletions.has(uploadId)) {
      throw new UploadError('UPLOAD_SCOPE_MISMATCH', 'upload completion is already in progress', 409);
    }
    if (record.expectedSize != null && record.offset !== record.expectedSize) {
      throw new UploadError(
        'UPLOAD_SIZE_MISMATCH',
        `expected size ${record.expectedSize}, received ${record.offset}`,
        409,
      );
    }
    this.activeCompletions.add(uploadId);
    try {
      const contentHash = await this.hashFile(record.dataPath);
      this.assertIdentityActive(identity);
      if (
        record.expectedContentHash
        && record.expectedContentHash !== contentHash
      ) {
        throw new UploadError(
          'UPLOAD_SIZE_MISMATCH',
          'upload content hash does not match the selected file',
          409,
        );
      }
      const inbox = this.inboxFor(sessionCwd);
      const finalName = nextUniqueInDir(inbox, record.name);
      const finalPath = join(inbox, finalName);
      moveUploadFileIntoInbox(record.dataPath, finalPath);
      const stagedRef = `stg1.${record.uploadId}.${randomBytes(32).toString('base64url')}`;
      const ready: UploadRecord = {
        ...record,
        name: finalName,
        dataPath: finalPath,
        state: 'ready',
        stagedRef,
        contentHash,
        updatedAt: Date.now(),
      };
      writeJsonAtomically(this.recordPath(tool, sessionId, uploadId), ready);
      return this.completeResult(ready);
    } finally {
      this.activeCompletions.delete(uploadId);
    }
  }

  discard(
    tool: string,
    sessionId: string,
    uploadId: string,
    identity = 'loopback-local',
  ): void {
    this.assertIdentityActive(identity);
    const record = this.loadRecord(tool, sessionId, uploadId, identity);
    if (this.activeCompletions.has(uploadId)) {
      throw new UploadError(
        'UPLOAD_SCOPE_MISMATCH',
        'upload completion is already in progress',
        409,
      );
    }
    if (record.claimedClientMessageId) {
      throw new UploadError('UPLOAD_SCOPE_MISMATCH', 'upload is owned by an in-flight prompt', 409);
    }
    this.deleteRecord(record);
  }

  /** Revoke every staged upload owned by one broker credential incarnation. */
  revokeCredentialIdentity(credentialIdentity: string): number {
    const normalized = credentialIdentity.trim();
    if (!normalized) return 0;
    this.revokedCredentialIdentities.add(normalized);
    const root = join(this.home, 'uploads');
    let removed = 0;
    let toolDirs: string[] = [];
    try {
      toolDirs = readdirSync(root);
    } catch {
      return 0;
    }
    for (const toolDir of toolDirs) {
      let sessionDirs: string[] = [];
      try {
        sessionDirs = readdirSync(join(root, toolDir));
      } catch {
        continue;
      }
      for (const sessionDir of sessionDirs) {
        const sessionRoot = join(root, toolDir, sessionDir);
        let names: string[] = [];
        try {
          names = readdirSync(sessionRoot);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.endsWith('.json')) continue;
          try {
            const record = readUploadRecord(join(sessionRoot, name));
            if (!this.identityUsesCredential(record.identity, normalized)) continue;
            this.deleteRecord(record);
            removed += 1;
          } catch {
            /* malformed or concurrently removed transient record */
          }
        }
      }
    }
    return removed;
  }

  preparePromptFiles(options: {
    tool: string;
    sessionId: string;
    identity: string;
    clientMessageId: string;
    sessionCwd: string;
    files: unknown;
  }): PreparedPromptFiles {
    this.assertIdentityActive(options.identity);
    const rawFiles = options.files;
    if (!Array.isArray(rawFiles) || rawFiles.length === 0) {
      return { files: [], inlinePaths: [], staged: [] };
    }
    if (rawFiles.length > PROMPT_ATTACHMENT_LIMITS.maxFiles) {
      throw new UploadError('UPLOAD_TOO_LARGE', 'prompt has too many attachments', 413);
    }

    const normalized: Array<
      | { kind: 'inline'; name: string; mimeType: string; bytes: Buffer }
      | { kind: 'staged'; record: UploadRecord }
    > = [];
    let inlineDecoded = 0;
    let inlineEncoded = 0;
    let totalDecoded = 0;

    for (const raw of rawFiles) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new UploadError('BAD_PARAM', 'attachment must be an object');
      }
      const file = raw as Record<string, unknown>;
      if ('path' in file || 'brokerPath' in file) {
        throw new UploadError('UPLOAD_SCOPE_MISMATCH', 'client-supplied attachment paths are forbidden', 403);
      }
      const hasData = typeof file.data === 'string';
      const hasRef = typeof file.stagedRef === 'string';
      if (hasData === hasRef) {
        throw new UploadError('BAD_PARAM', 'attachment must contain exactly one of data or stagedRef');
      }
      if (hasData) {
        const name = safeUploadName(file.name);
        const mimeType = sanitizeMime(file.mimeType);
        const data = file.data as string;
        const bytes = decodeCanonicalBase64(data);
        if (bytes.length > PROMPT_ATTACHMENT_LIMITS.maxInlineFileBytes) {
          throw new UploadError('UPLOAD_TOO_LARGE', 'inline attachment exceeds per-file limit', 413);
        }
        if (file.size !== undefined && file.size !== bytes.length) {
          throw new UploadError('UPLOAD_SIZE_MISMATCH', 'inline attachment size does not match data', 409);
        }
        inlineDecoded += bytes.length;
        inlineEncoded += Buffer.byteLength(data, 'utf8');
        totalDecoded += bytes.length;
        normalized.push({ kind: 'inline', name, mimeType, bytes });
      } else {
        const record = this.recordForReference(
          options.tool,
          options.sessionId,
          file.stagedRef as string,
          options.identity,
        );
        if (file.size !== undefined && file.size !== record.offset) {
          throw new UploadError('UPLOAD_SIZE_MISMATCH', 'staged attachment size does not match upload', 409);
        }
        totalDecoded += record.offset;
        normalized.push({ kind: 'staged', record });
      }
    }
    if (inlineDecoded > PROMPT_ATTACHMENT_LIMITS.maxInlineDecodedBytes) {
      throw new UploadError('UPLOAD_TOO_LARGE', 'prompt inline decoded-byte limit exceeded', 413);
    }
    if (inlineEncoded > PROMPT_ATTACHMENT_LIMITS.maxInlineEncodedBytes) {
      throw new UploadError('UPLOAD_TOO_LARGE', 'prompt inline encoded-byte limit exceeded', 413);
    }
    if (totalDecoded > PROMPT_ATTACHMENT_LIMITS.maxPromptBytes) {
      throw new UploadError('UPLOAD_TOO_LARGE', 'prompt attachment-byte limit exceeded', 413);
    }

    const prepared: PreparedPromptFiles = { files: [], inlinePaths: [], staged: [] };
    try {
      // Claim every staged reference before materializing inline files. A
      // partial claim is rolled back below and never reaches an adapter.
      for (const entry of normalized) {
        if (entry.kind !== 'staged') continue;
        const prior = entry.record.claimedClientMessageId;
        if (prior && prior !== options.clientMessageId) {
          throw new UploadError(
            'UPLOAD_SCOPE_MISMATCH',
            'staged attachment is already owned by another prompt',
            409,
          );
        }
        const claimed = { ...entry.record, claimedClientMessageId: options.clientMessageId };
        writeJsonAtomically(this.recordPath(options.tool, options.sessionId, claimed.uploadId), claimed);
        this.activeClaims.add(claimed.uploadId);
        entry.record = claimed;
        prepared.staged.push({
          uploadId: claimed.uploadId,
          clientMessageId: options.clientMessageId,
        });
      }

      const inbox = this.inboxFor(options.sessionCwd);
      for (const entry of normalized) {
        if (entry.kind === 'staged') {
          prepared.files.push({
            name: entry.record.name,
            mimeType: entry.record.mimeType,
            size: entry.record.offset,
            brokerPath: entry.record.dataPath,
          });
          continue;
        }
        const finalName = nextUniqueInDir(inbox, entry.name);
        const finalPath = join(inbox, finalName);
        writeFileSync(finalPath, entry.bytes, { flag: 'wx' });
        prepared.inlinePaths.push(finalPath);
        prepared.files.push({
          name: finalName,
          mimeType: entry.mimeType,
          size: entry.bytes.length,
          brokerPath: finalPath,
        });
      }
      return prepared;
    } catch (error) {
      this.rollbackPreparedPromptFiles(options.tool, options.sessionId, prepared);
      throw error;
    }
  }

  commitPreparedPromptFiles(tool: string, sessionId: string, prepared: PreparedPromptFiles): void {
    for (const claimed of prepared.staged) {
      try {
        const record = this.loadRecordById(tool, sessionId, claimed.uploadId);
        if (record.claimedClientMessageId !== claimed.clientMessageId) continue;
        this.deleteMetadata(tool, sessionId, claimed.uploadId);
      } catch {
        // Delivery already succeeded. Leaving an expiring metadata record is
        // safer than deleting the workspace file the agent was just given.
      } finally {
        this.activeClaims.delete(claimed.uploadId);
      }
    }
  }

  rollbackPreparedPromptFiles(tool: string, sessionId: string, prepared: PreparedPromptFiles): void {
    for (const path of prepared.inlinePaths) {
      try {
        unlinkSync(path);
      } catch {
        /* already absent */
      }
    }
    for (const claimed of prepared.staged) {
      try {
        const record = this.loadRecordById(tool, sessionId, claimed.uploadId);
        if (record.claimedClientMessageId !== claimed.clientMessageId) continue;
        writeJsonAtomically(this.recordPath(tool, sessionId, claimed.uploadId), {
          ...record,
          claimedClientMessageId: undefined,
          updatedAt: Date.now(),
        });
      } catch {
        /* expiry/removal is already a safe rollback */
      } finally {
        this.activeClaims.delete(claimed.uploadId);
      }
    }
  }

  private completeResult(record: UploadRecord): UploadCompleteResult {
    if (!record.stagedRef) {
      throw new UploadError('UPLOAD_NOT_FOUND', 'completed upload reference is missing', 404);
    }
    return {
      uploadId: record.uploadId,
      stagedRef: record.stagedRef,
      name: record.name,
      mimeType: record.mimeType,
      size: record.offset,
      expiresAt: record.expiresAt,
    };
  }

  private recordForReference(
    tool: string,
    sessionId: string,
    stagedRef: string,
    identity: string,
  ): UploadRecord {
    const match = /^stg1\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/i.exec(stagedRef);
    if (!match) throw new UploadError('UPLOAD_NOT_FOUND', 'staged attachment reference is invalid', 404);
    const record = this.loadRecord(tool, sessionId, match[1]!, identity);
    if (record.state !== 'ready' || !record.stagedRef || !sameSecret(record.stagedRef, stagedRef)) {
      throw new UploadError('UPLOAD_NOT_FOUND', 'staged attachment reference was not found', 404);
    }
    return record;
  }

  private loadRecord(
    tool: string,
    sessionId: string,
    uploadId: string,
    identity: string,
  ): UploadRecord {
    const record = this.loadRecordById(tool, sessionId, uploadId);
    if (record.identity !== identity) {
      throw new UploadError('UPLOAD_SCOPE_MISMATCH', 'upload belongs to another credential', 403);
    }
    return record;
  }

  private loadRecordById(tool: string, sessionId: string, uploadId: string): UploadRecord {
    const { metaPath, dataPath } = this.resolvePaths(tool, sessionId, uploadId);
    let record: UploadRecord;
    try {
      record = readUploadRecord(metaPath);
    } catch (err) {
      if (err instanceof UploadError) throw err;
      throw new UploadError('UPLOAD_NOT_FOUND', 'upload not found', 404);
    }
    if (
      record.uploadId !== uploadId
      || record.tool !== tool
      || record.sessionId !== sessionId
      || (record.state === 'uploading' && record.dataPath !== dataPath)
    ) {
      throw new UploadError('UPLOAD_NOT_FOUND', 'upload not found', 404);
    }
    if (
      Date.now() > record.expiresAt
      && !this.activeClaims.has(record.uploadId)
      && !this.activeCompletions.has(record.uploadId)
    ) {
      this.deleteRecord(record);
      throw new UploadError('UPLOAD_EXPIRED', 'upload session has expired', 410);
    }
    try {
      const stat = statSync(record.dataPath);
      if (!stat.isFile() || stat.size !== record.offset) {
        throw new Error('size mismatch');
      }
    } catch {
      throw new UploadError('UPLOAD_NOT_FOUND', 'upload data missing', 404);
    }
    return record;
  }

  private deleteRecord(record: UploadRecord): void {
    this.deleteMetadata(record.tool, record.sessionId, record.uploadId);
    try {
      unlinkSync(record.dataPath);
    } catch {
      /* already gone */
    }
  }

  private deleteMetadata(tool: string, sessionId: string, uploadId: string): void {
    const { metaPath } = this.resolvePaths(tool, sessionId, uploadId);
    try {
      unlinkSync(metaPath);
    } catch {
      /* already gone */
    }
  }

  private parseOffset(raw: string | null): number {
    if (!raw) throw new UploadError('BAD_PARAM', 'x-cosyncing-upload-offset is required');
    const offset = Number(raw);
    if (!Number.isInteger(offset) || offset < 0) {
      throw new UploadError('BAD_PARAM', 'offset must be a non-negative integer');
    }
    return offset;
  }

  private identityUsesCredential(identity: string, credentialIdentity: string): boolean {
    return identity === credentialIdentity || identity.startsWith(`${credentialIdentity}|`);
  }

  private assertIdentityActive(identity: string): void {
    for (const credentialIdentity of this.revokedCredentialIdentities) {
      if (this.identityUsesCredential(identity, credentialIdentity)) {
        throw new UploadError('UPLOAD_SCOPE_MISMATCH', 'upload credential was revoked', 403);
      }
    }
  }

  private writeAt(fd: number, bytes: Uint8Array, offset: number): number {
    const bytesWritten = writeSync(fd, bytes, 0, bytes.byteLength, offset);
    if (!Number.isFinite(bytesWritten) || bytesWritten < 0) {
      throw new UploadError('BAD_PARAM', 'failed to write upload chunk');
    }
    if (bytesWritten !== bytes.byteLength) {
      throw new UploadError('BAD_PARAM', 'partial upload write');
    }
    return bytesWritten;
  }

  private resolvePaths(
    tool: string,
    sessionId: string,
    uploadId: string,
  ): { sessionRoot: string; metaPath: string; dataPath: string } {
    assertSafeUploadId(uploadId);
    const sessionRoot = this.sessionRoot(tool, sessionId);
    return {
      sessionRoot,
      metaPath: join(sessionRoot, `${uploadId}.json`),
      dataPath: join(sessionRoot, `${uploadId}.bin`),
    };
  }

  private recordPath(tool: string, sessionId: string, uploadId: string): string {
    return this.resolvePaths(tool, sessionId, uploadId).metaPath;
  }

  private sessionRoot(tool: string, sessionId: string): string {
    const toolSafe = createHash('sha256').update(tool).digest('hex').slice(0, 24);
    const idSafe = createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
    return join(this.home, 'uploads', toolSafe, idSafe);
  }

  private inboxFor(sessionCwd: string): string {
    const inbox = join(resolve(sessionCwd), PRODUCT_IDENTITY.repositoryDirectoryName, 'inbox');
    mkdirSync(inbox, { recursive: true });
    this.rememberInboxRoot(sessionCwd);
    return inbox;
  }

  /**
   * Where the registry of session inboxes lives.
   *
   * {@link inboxFor} is only ever called with a cwd the caller hands in, and an
   * inbox outlives every session that wrote to it — that is the whole of the
   * leak this sweep closes. Nothing else on disk records which inboxes exist,
   * so collection needs its own durable root list.
   */
  private inboxRegistryPath(): string {
    return join(this.home, 'uploads', 'inbox-roots.json');
  }

  private loadInboxRoots(): InboxRootRegistry {
    try {
      const raw = readJson(this.inboxRegistryPath());
      if (!raw || typeof raw !== 'object') return { roots: [], cursor: 0 };
      const obj = raw as Partial<InboxRootRegistry>;
      const roots = Array.isArray(obj.roots)
        ? obj.roots.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
        : [];
      const cursor = Number.isSafeInteger(obj.cursor) && (obj.cursor as number) >= 0
        ? (obj.cursor as number)
        : 0;
      return { roots: roots.slice(-INBOX_ROOT_REGISTRY_CAP), cursor };
    } catch {
      return { roots: [], cursor: 0 };
    }
  }

  private saveInboxRoots(registry: InboxRootRegistry): void {
    const path = this.inboxRegistryPath();
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeJsonAtomically(path, {
        roots: registry.roots.slice(-INBOX_ROOT_REGISTRY_CAP),
        cursor: registry.cursor,
      });
    } catch {
      /* a registry we cannot write costs a later sweep, never a delivery */
    }
  }

  /**
   * Record a session cwd so its inbox can be collected later.
   *
   * The resolved CWD is stored, not the inbox path: the sweep re-derives
   * `<cwd>/.cosyncing/inbox` itself and refuses the root unless both of those
   * components still resolve to themselves. Storing the inbox directly would
   * let a `.cosyncing` symlink planted after registration point the sweep at a
   * directory outside the workspace.
   */
  private rememberInboxRoot(sessionCwd: string): void {
    let resolved: string;
    try {
      resolved = realpathSync(resolve(sessionCwd));
    } catch {
      return;
    }
    const registry = this.loadInboxRoots();
    if (registry.roots.includes(resolved)) return;
    registry.roots.push(resolved);
    this.saveInboxRoots(registry);
  }

  /**
   * Bring a live session's workspace into scope if it already has an inbox.
   *
   * {@link inboxFor} is the only other writer of the registry, so an inbox that
   * filled up before this collector existed is invisible to it: the workspace
   * would stay leaked until the user happened to attach one more file there.
   * A live session's cwd is the one other place the broker learns a workspace
   * from, so the sweep adopts it — but only when `<cwd>/.cosyncing/inbox` is
   * already present, which it is only because cosyncing staged into it. A
   * workspace with no inbox is not registered and no directory is created.
   *
   * Adoption changes nothing about what may be deleted. The root still has to
   * pass {@link resolveSweepableInbox}, and every never-deleted rule applies
   * unchanged.
   */
  private adoptLiveInboxRoots(registry: InboxRootRegistry, cwds: Iterable<string>): void {
    const known = new Set(registry.roots);
    const adopted: string[] = [];
    for (const cwd of cwds) {
      let root: string;
      try {
        root = realpathSync(resolve(cwd));
      } catch {
        continue;
      }
      if (known.has(root)) continue;
      if (!existsSync(join(root, PRODUCT_IDENTITY.repositoryDirectoryName, 'inbox'))) continue;
      known.add(root);
      adopted.push(root);
    }
    if (adopted.length === 0) return;
    registry.roots = registry.roots.concat(adopted).slice(-INBOX_ROOT_REGISTRY_CAP);
  }

  /**
   * Every inbox path a staging record still points at.
   *
   * A completed staged upload's `dataPath` IS an inbox path — completion
   * renames the bytes there and rewrites the record — so an unexpired or
   * claimed record is the one case where a file inside an inbox is still
   * referenced by the broker itself.
   *
   * Returns `undefined` past {@link INBOX_PROTECTED_RECORD_CAP}, which aborts
   * the sweep. This set is the only bound here that cannot be truncated.
   */
  private protectedInboxPaths(now: number): Set<string> | undefined {
    const protectedPaths = new Set<string>();
    const root = join(this.home, 'uploads');
    let toolDirs: string[] = [];
    try {
      toolDirs = readdirSync(root);
    } catch {
      return protectedPaths;
    }
    let inspected = 0;
    for (const toolDir of toolDirs) {
      const toolRoot = join(root, toolDir);
      let sessionDirs: string[] = [];
      try {
        sessionDirs = readdirSync(toolRoot);
      } catch {
        continue;
      }
      for (const sessionDir of sessionDirs) {
        const sessionRoot = join(toolRoot, sessionDir);
        let names: string[] = [];
        try {
          names = readdirSync(sessionRoot);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.endsWith('.json')) continue;
          inspected += 1;
          if (inspected > INBOX_PROTECTED_RECORD_CAP) return undefined;
          try {
            const record = readUploadRecord(join(sessionRoot, name));
            if (
              record.expiresAt > now
              || this.activeClaims.has(record.uploadId)
              || this.activeCompletions.has(record.uploadId)
            ) {
              protectedPaths.add(this.canonicalInboxPath(record.dataPath));
            }
          } catch {
            /* an unreadable record protects nothing; sweepExpired removes it */
          }
        }
      }
    }
    return protectedPaths;
  }

  /**
   * A path in the same form the sweep builds its candidates in.
   *
   * The PARENT is resolved and the leaf is appended, never resolved: calling
   * `realpathSync` on the leaf is itself a follow, which would report a
   * symlink's target and defeat the comparison it is meant to support.
   */
  private canonicalInboxPath(path: string): string {
    const absolute = resolve(path);
    try {
      return join(realpathSync(dirname(absolute)), basename(absolute));
    } catch {
      return absolute;
    }
  }

  /**
   * Resolve a registered cwd to a sweepable inbox, or refuse it.
   *
   * A workspace reached through a symlinked ancestor is ordinary and stays in
   * scope, but `.cosyncing` and `inbox` must each resolve to themselves. That
   * is what stops a `.cosyncing` symlink planted after registration from
   * pointing the sweep at a directory outside any workspace.
   */
  private resolveSweepableInbox(cwd: string): string | undefined {
    const marker = join(cwd, PRODUCT_IDENTITY.repositoryDirectoryName);
    try {
      if (realpathSync(marker) !== marker) return undefined;
      const inbox = join(marker, 'inbox');
      if (realpathSync(inbox) !== inbox) return undefined;
      if (!lstatSync(inbox).isDirectory()) return undefined;
      return inbox;
    } catch {
      return undefined;
    }
  }

  /**
   * Collect delivered prompt attachments out of the session inboxes.
   *
   * A delivered attachment used to leak forever. Completion unlinks the staging
   * METADATA and leaves the bytes in `<cwd>/.cosyncing/inbox`, and an inline
   * attachment never had metadata at all, so {@link sweepExpired} — which walks
   * the metadata tree — never listed an inbox directory at all.
   *
   * Nothing here is rewritten or truncated. The attachment was read, or its
   * path passed, in the prompt turn that delivered it; a later read of a
   * collected file is an ordinary `ENOENT` every adapter already handles as a
   * missing file. The grace rule and the retention age keep that case out of a
   * working session.
   *
   * Never deleted: anything that is not a regular file — a symlink is neither
   * followed nor removed — a path a live staging record still points at,
   * anything inside the grace window while a live session holds that cwd, and,
   * for the CAP rules only, the newest `maxRetainedClientFiles` files.
   *
   * `COSYNCING_INBOX_RETENTION_MS=0` disables this sweep entirely and leaves
   * {@link sweepExpired} untouched.
   */
  sweepInboxes(
    now = Date.now(),
    options: { liveCwds?: () => Iterable<string> } = {},
  ): InboxSweepResult {
    const result: InboxSweepResult = {
      roots: 0, scanned: 0, removed: 0, bytes: 0, dropped: 0, refused: 0,
    };
    if (this.inboxRetentionMs <= 0) return result;

    const registry = this.loadInboxRoots();
    this.adoptLiveInboxRoots(registry, options.liveCwds?.() ?? []);
    const total = registry.roots.length;
    if (total === 0) return result;

    const protectedPaths = this.protectedInboxPaths(now);
    if (!protectedPaths) return result;

    const liveInboxes = new Set<string>();
    for (const cwd of options.liveCwds?.() ?? []) {
      try {
        liveInboxes.add(join(
          realpathSync(resolve(cwd)),
          PRODUCT_IDENTITY.repositoryDirectoryName,
          'inbox',
        ));
      } catch {
        /* a live session whose cwd is gone protects nothing */
      }
    }

    const start = registry.cursor % total;
    const surviving = new Set(registry.roots);
    const budget = Math.min(INBOX_SWEEP_MAX_ROOTS, total);
    for (let step = 0; step < budget; step += 1) {
      const cwd = registry.roots[(start + step) % total]!;
      result.roots += 1;
      if (!existsSync(cwd)) {
        surviving.delete(cwd);
        result.dropped += 1;
        continue;
      }
      const inbox = this.resolveSweepableInbox(cwd);
      if (!inbox) {
        result.refused += 1;
        continue;
      }
      this.sweepOneInbox(inbox, now, protectedPaths, liveInboxes.has(inbox), result);
    }

    this.saveInboxRoots({
      roots: registry.roots.filter((root) => surviving.has(root)),
      cursor: start + budget,
    });
    return result;
  }

  private sweepOneInbox(
    inbox: string,
    now: number,
    protectedPaths: Set<string>,
    live: boolean,
    result: InboxSweepResult,
  ): void {
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(inbox, { withFileTypes: true })
        .slice(0, INBOX_SWEEP_MAX_ENTRIES_PER_ROOT);
    } catch {
      return;
    }
    const files: Array<{ abs: string; mtimeMs: number; size: number }> = [];
    for (const entry of entries) {
      // A `Dirent` describes the link itself, so a symlink is excluded here and
      // never followed. `lstatSync` re-checks rather than trusting the listing.
      if (!entry.isFile()) continue;
      const abs = join(inbox, entry.name);
      try {
        const stat = lstatSync(abs);
        if (!stat.isFile()) continue;
        files.push({ abs, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        /* vanished between the listing and the stat */
      }
    }
    result.scanned += files.length;

    files.sort((a, b) => a.mtimeMs - b.mtimeMs);
    let liveBytes = files.reduce((sum, file) => sum + file.size, 0);
    let liveFiles = files.length;

    for (const file of files) {
      if (protectedPaths.has(file.abs)) continue;
      const age = now - file.mtimeMs;
      if (live && age < this.inboxGraceMs) continue;
      const aged = age > this.inboxRetentionMs;
      const overCap = (liveBytes > this.maxInboxBytes || liveFiles > this.maxInboxFiles)
        && liveFiles > this.inboxFileFloor;
      if (!aged && !overCap) continue;
      try {
        // `unlinkSync` removes the name, never a symlink's target, so a file
        // swapped for a link between the stat and here cannot reach outside.
        unlinkSync(file.abs);
      } catch {
        continue;
      }
      result.removed += 1;
      result.bytes += file.size;
      liveBytes -= file.size;
      liveFiles -= 1;
    }
  }

  private scopeRecords(tool: string, sessionId: string, identity: string): UploadRecord[] {
    const root = this.sessionRoot(tool, sessionId);
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      return [];
    }
    const records: UploadRecord[] = [];
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      try {
        const record = readUploadRecord(join(root, name));
        if (record.identity === identity && record.expiresAt > Date.now()) records.push(record);
      } catch {
        /* malformed transient records do not gain capacity */
      }
    }
    return records;
  }

  private assertScopeCapacity(
    tool: string,
    sessionId: string,
    identity: string,
    reservedBytes: number,
  ): void {
    const records = this.scopeRecords(tool, sessionId, identity);
    if (records.length >= this.maxRecordsPerScope) {
      throw new UploadError('UPLOAD_CAPACITY', 'staged upload record limit reached', 429);
    }
    const bytes = records.reduce((sum, record) => sum + (record.expectedSize ?? record.offset), 0);
    if (bytes + reservedBytes > this.maxScopeBytes) {
      throw new UploadError('UPLOAD_CAPACITY', 'staged upload byte limit reached', 429);
    }
  }

  private assertScopeByteGrowth(
    tool: string,
    sessionId: string,
    identity: string,
    additionalBytes: number,
  ): void {
    const records = this.scopeRecords(tool, sessionId, identity);
    const bytes = records.reduce((sum, record) => sum + record.offset, 0);
    if (bytes + additionalBytes > this.maxScopeBytes) {
      throw new UploadError('UPLOAD_CAPACITY', 'staged upload byte limit reached', 429);
    }
  }

  sweepExpired(now = Date.now()): number {
    const root = join(this.home, 'uploads');
    let removed = 0;
    let inspected = 0;
    let toolDirs: string[] = [];
    try {
      toolDirs = readdirSync(root);
    } catch {
      return 0;
    }
    outer:
    for (const toolDir of toolDirs) {
      const toolRoot = join(root, toolDir);
      let sessionDirs: string[] = [];
      try {
        sessionDirs = readdirSync(toolRoot);
      } catch {
        continue;
      }
      for (const sessionDir of sessionDirs) {
        const sessionRoot = join(toolRoot, sessionDir);
        let names: string[] = [];
        try {
          names = readdirSync(sessionRoot);
        } catch {
          continue;
        }
        for (const name of names) {
          if (!name.endsWith('.json')) continue;
          if (inspected >= this.cleanupBatchRecords) break outer;
          inspected += 1;
          try {
            const record = readUploadRecord(join(sessionRoot, name));
            if (
              record.expiresAt > now
              || this.activeClaims.has(record.uploadId)
              || this.activeCompletions.has(record.uploadId)
            ) {
              continue;
            }
            this.deleteRecord(record);
            removed += 1;
          } catch {
            continue;
          }
        }
        try {
          if (readdirSync(sessionRoot).length === 0) rmSync(sessionRoot, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
      try {
        if (readdirSync(toolRoot).length === 0) rmSync(toolRoot, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
    return removed;
  }
}
