/**
 * R2 transcript-export orchestration (GPT-Pro §2 rules 7-16). Generic over the adapter: the broker
 * creates a private `0700` temp root, asks the adapter to write a native export INTO it (never a
 * client-supplied path), then enforces path containment + size cap, runs the mandatory fail-closed
 * redaction pass, and ingests the redacted bytes as an `export-attachment` artifact. The temp root is
 * ALWAYS deleted in `finally` — success, refusal, timeout, or crash (rule 18 / "temp cleanup on every
 * failure phase"). Dispatch is by `backend.exportTranscript` presence, never a tool name.
 */
import { chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, join, sep } from 'node:path';
import type { AgentBackend, AgentMessage } from '@cosyncing/adapter-api';
import type { ArtifactStore } from './artifact-store.ts';
import { redactTranscript } from './r2-redactor.ts';
import { r2MaxBytes, r2TimeoutMs, type R2ActionDescriptor } from './r2-policy.ts';

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
  brokerUrl?: string;
}): Promise<TranscriptExportResult> {
  const { backend, action, session, artifactStore, brokerUrl } = opts;
  const refuse = (status: number, error: string, code: string): TranscriptExportResult => ({ ok: false, status, error, code });
  if (typeof backend.exportTranscript !== 'function') {
    return refuse(501, 'native transcript export is not available for this agent', 'NOT_SUPPORTED');
  }
  const maxBytes = r2MaxBytes(action);
  const timeoutMs = r2TimeoutMs(action);
  const tempRoot = mkdtempSync(join(tmpdir(), 'cosyncing-r2-'));
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
