/**
 * R2 transcript-export orchestration (GPT-Pro §2 rules 7-16). Generic over the adapter: the broker
 * creates a private `0700` temp root inside its own state home ({@link transcriptExportWorkRoot}), asks
 * the adapter to write a native export INTO it (never a client-supplied path), then enforces path
 * containment + size cap, runs the mandatory fail-closed redaction pass, and ingests the redacted
 * bytes as an `export-attachment` artifact. Output over the cap
 * answers `413 EXPORT_TOO_LARGE` whether the adapter stopped at it (`TranscriptExportTooLargeError`) or
 * the broker measured it afterwards; any other adapter failure is `502 EXPORT_FAILED`. The temp root is
 * ALWAYS deleted in `finally` — success, refusal, timeout, or adapter crash (rule 18 / "temp cleanup on
 * every failure phase"); one the broker process itself died during is removed by the next start
 * ({@link sweepTranscriptExportWorkRoot}). Dispatch is by `backend.exportTranscript` presence, never a
 * tool name.
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { extname, join, sep } from 'node:path';
import { isTranscriptExportTooLargeError, type AgentBackend, type AgentMessage } from '@cosyncing/adapter-api';
import type { ArtifactStore } from '../artifacts/artifact-store.ts';
import { redactTranscript } from './r2-redactor.ts';
import { r2MaxBytes, r2TimeoutMs, type R2ActionDescriptor } from './r2-policy.ts';
import { ensureOwnerOnlyDirectory } from './secure-files.ts';

/**
 * Where every export's working directory lives: `exports-tmp/` in the broker's own state home. While an
 * export runs, its directory holds the native, UNREDACTED transcript.
 *
 * Never the system temp directory. Every broker on the host (an installed one, a review broker) shares
 * that, so no broker could tell an export a dead process abandoned there from one another live broker
 * is running, and the start sweep below could not exist. A state home belongs to one broker: two
 * brokers with different state homes never share this directory, and a state home serves one running
 * broker at a time, which is what lets that broker empty it at start.
 */
export function transcriptExportWorkRoot(stateHome: string): string {
  return join(stateHome, 'exports-tmp');
}

/**
 * Remove every export a previous process of this broker left in its working root: one that was running
 * when the process crashed, was killed, or was terminated still holds the unredacted native transcript.
 * Call it once at start, after the listener bound and before a request is answered — no export of this
 * process can exist yet. Returns how many entries were removed. A missing root is nothing to do; a root
 * that is a symlink, not a directory, or owned by someone else throws, and nothing in it is touched.
 */
export function sweepTranscriptExportWorkRoot(workRoot: string): number {
  if (!existsSync(workRoot)) return 0;
  ensureOwnerOnlyDirectory(workRoot);
  let removed = 0;
  for (const name of readdirSync(workRoot)) {
    // `rmSync` removes a symlink entry itself, never what it points at.
    rmSync(join(workRoot, name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

export interface TranscriptExportSession {
  tool: string;
  id: string;
  cwd?: string;
  title?: string;
}

export interface TranscriptExportResult {
  ok: boolean;
  status: number;
  error?: string;
  code?: string;
  artifact?: AgentMessage & { type: 'file-artifact' };
  redactionCounts?: Record<string, number>;
}

function summarizeRedactions(counts: Record<string, number>): string {
  const parts = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cat, n]) => `${cat}:${n}`);
  return parts.length ? `redacted ${parts.join(', ')}` : 'redacted (no secrets matched)';
}

function exportBaseName(session: TranscriptExportSession): string {
  const raw = (session.title || session.id || 'transcript').trim();
  return `${raw}-transcript`;
}

export async function runTranscriptExport(opts: {
  backend: AgentBackend;
  action: R2ActionDescriptor;
  session: TranscriptExportSession;
  artifactStore: ArtifactStore;
  /** The broker-owned parent of the export's working directory ({@link transcriptExportWorkRoot}). */
  workRoot: string;
  brokerUrl?: string;
}): Promise<TranscriptExportResult> {
  const { backend, action, session, artifactStore, workRoot, brokerUrl } = opts;
  const refuse = (status: number, error: string, code: string): TranscriptExportResult => ({ ok: false, status, error, code });
  if (typeof backend.exportTranscript !== 'function') {
    return refuse(501, 'native transcript export is not available for this agent', 'NOT_SUPPORTED');
  }
  const maxBytes = r2MaxBytes(action);
  const timeoutMs = r2TimeoutMs(action);
  let tempRoot: string;
  try {
    ensureOwnerOnlyDirectory(workRoot);
    tempRoot = mkdtempSync(join(workRoot, 'export-'));
  } catch {
    return refuse(500, 'the broker\'s export working directory is unavailable', 'TEMP_ROOT_MISSING');
  }
  try {
    try {
      chmodSync(tempRoot, 0o700);
    } catch {
      /* best effort on platforms without POSIX modes */
    }

    let produced: { path: string; format: 'json' | 'html' };
    try {
      produced = await backend.exportTranscript(session.id, { tempDir: tempRoot, maxBytes, timeoutMs });
    } catch (err) {
      // The adapter counted the bytes and stopped at the cap: the export is too large, not broken.
      // Typed, never read from the error text, so a native failure that happens to mention a size
      // still answers 502.
      if (isTranscriptExportTooLargeError(err)) return refuse(413, 'export exceeds the configured size cap', 'EXPORT_TOO_LARGE');
      return refuse(502, `native transcript export failed: ${err instanceof Error ? err.message.split('\n')[0] : 'error'}`, 'EXPORT_FAILED');
    }

    const nativePath = produced?.path;
    if (!nativePath || typeof nativePath !== 'string') return refuse(502, 'export produced no file', 'EXPORT_EMPTY');
    if (produced.format !== 'json' && produced.format !== 'html') return refuse(502, 'export produced an unexpected format', 'EXPORT_FORMAT');

    // Broker-side path containment on the ADAPTER-RETURNED native path (rule 8, defense in depth): a
    // buggy/hostile adapter returning `/etc/passwd`, a symlink, or a path outside the temp root is a
    // security failure — refuse and clean up. (Adapters also verify their own writes; this never trusts
    // them.) The redacted copy is re-checked again on ingestion.
    let realRoot: string;
    try {
      realRoot = realpathSync(tempRoot);
    } catch {
      return refuse(500, 'broker temp root vanished', 'TEMP_ROOT_MISSING');
    }
    let lst;
    try {
      lst = lstatSync(nativePath);
    } catch {
      return refuse(502, 'export file missing after native run', 'EXPORT_MISSING');
    }
    if (lst.isSymbolicLink()) return refuse(422, 'native export path is a symlink', 'PATH_SYMLINK');
    let realNative: string;
    try {
      realNative = realpathSync(nativePath);
    } catch {
      return refuse(502, 'export file missing after native run', 'EXPORT_MISSING');
    }
    if (realNative !== realRoot && !realNative.startsWith(realRoot + sep)) return refuse(422, 'native export escaped the broker temp root', 'PATH_ESCAPE');
    if (extname(realNative).toLowerCase() !== `.${produced.format}`) return refuse(422, 'native export has an unexpected extension', 'PATH_EXT');

    let size: number;
    try {
      size = statSync(realNative).size;
    } catch {
      return refuse(502, 'export file missing after native run', 'EXPORT_MISSING');
    }
    if (size > maxBytes) return refuse(413, 'export exceeds the configured size cap', 'EXPORT_TOO_LARGE');

    const bytes = readFileSync(realNative);
    const redaction = redactTranscript(bytes.toString('utf8'), {
      homeDirs: [homedir()],
      projectRoots: session.cwd ? [session.cwd] : [],
    });
    if (!redaction.ok) return refuse(422, `export refused by redactor: ${redaction.reason ?? 'residual secrets'}`, 'REDACTION_REFUSED');

    const redactedBytes = Buffer.from(redaction.text, 'utf8');
    if (redactedBytes.byteLength > maxBytes) return refuse(413, 'redacted export exceeds the configured size cap', 'EXPORT_TOO_LARGE');
    const redactedPath = join(tempRoot, `redacted.${produced.format}`);
    writeFileSync(redactedPath, redactedBytes);

    let artifact: AgentMessage & { type: 'file-artifact' };
    try {
      artifact = artifactStore.putExportAttachment(
        { tool: session.tool, id: session.id },
        {
          name: exportBaseName(session),
          format: produced.format,
          redactionSummary: summarizeRedactions(redaction.counts),
          retentionMs: action.retentionMs,
        },
        redactedPath,
        tempRoot,
        brokerUrl,
      );
    } catch (err) {
      return refuse(422, `artifact ingestion refused: ${err instanceof Error ? err.message : 'error'}`, 'INGEST_REFUSED');
    }

    return { ok: true, status: 200, artifact, redactionCounts: redaction.counts };
  } finally {
    try {
      rmSync(tempRoot, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}
