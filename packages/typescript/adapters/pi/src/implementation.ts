/**
 * Pi adapter — integrationKind 'jsonrpc-stdio'.
 *
 * Pi (pi.dev) has no persistent daemon, so for MVP we attach by spawning
 * `pi --mode rpc --session <file>` (resume-under-broker): the broker owns the
 * process and fully drives it; the saved conversation is replayed via
 * `get_messages`. True multi-client live attach via a Pi extension is a later
 * upgrade (docs/protocol/adapter-support.md).
 *
 * Discovery: ~/.pi/agent/sessions/<encoded-cwd>/<iso>_<uuid>.jsonl by default, or a custom
 * session root when COSYNCING_PI_SESSIONS_ROOT / PI_CODING_AGENT_SESSION_DIR is explicitly set.
 * Protocol: strict JSONL over stdin/stdout, as specified by `rpc.md` in the
 * upstream Pi source distribution's documentation directory.
 */
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
  mkdirSync,
  writeFileSync,
  watch,
  type FSWatcher,
} from 'node:fs';
import { join, basename, dirname, extname, resolve } from 'node:path';
import {
  PI_BRIDGE_EMBEDDED_SHA256,
  PI_BRIDGE_EMBEDDED_SOURCE,
  PI_BRIDGE_LEGACY_MARKER,
} from './bridge-asset.ts';
import {
  createJsonlSplitter,
  PRODUCT_IDENTITY,
  summarizeDiff,
  splitUnifiedDiffFiles,
  type AgentBackend,
  type AgentCapabilities,
  type AgentMessage,
  type AgentMessageHandler,
  type AgentSetupDiagnosis,
  type AttachMode,
  type CommandInput,
  type FileChange,
  type CommandResult,
  type FileInput,
  type HistorySourceIdentity,
  type ModelOption,
  type PermissionDecision,
  type PromptInput,
  type SessionConnection,
  type SessionControlState,
  type SessionDiscoveryOptions,
  type SessionInfo,
  type SlashCommand,
  type ToolCommandState,
  type ToolDisplayClass,
  type ToolSearchGroup,
  type ToolSemantic,
  type SetupDiagnosisContext,
  type Unsubscribe,
  boundToolSemantic,
  boundedStream,
  commandSemantic,
  fileReadSemantic,
  searchGroup,
  searchSemantic,
  webSemantic,
} from '@cosyncing/adapter-api';
import { diagnosePiSetup } from './diagnostics.ts';

const CAPS: AgentCapabilities = {
  integrationKind: 'jsonrpc-stdio',
  attachModes: ['observe', 'resume', 'live'],
  supportsObserve: true,
  supportsResume: true,
  supportsLiveAttach: true, // per-session active only when the Pi bridge extension has hello'd
  supportsNativeArtifact: false,
  supportsNativeFileInput: true, // images in prompt
  supportsModelSwitch: true,
  permissionGranularity: 'per-tool',
};

const PI_SESSION_ROOT_OVERRIDE = process.env.COSYNCING_PI_SESSIONS_ROOT?.trim() || process.env.PI_CODING_AGENT_SESSION_DIR?.trim() || undefined;
const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), '.pi', 'agent');
const SESSIONS_ROOT = PI_SESSION_ROOT_OVERRIDE || join(PI_AGENT_DIR, 'sessions');
const SESSION_NAME_SCAN_BYTES = Math.max(256 * 1024, Number(process.env.COSYNCING_PI_NAME_SCAN_BYTES ?? 4 * 1024 * 1024) || 0);

export interface PiAdapterOptions {
  /** Broker URL the in-session Pi bridge extension should call back to. */
  brokerUrl?: string;
  /** Packaged setup wrote the owner-only scoped integration file, so terminal commands need no URL env. */
  bridgeUsesIntegrationFile?: boolean;
}

export {
  PI_BRIDGE_EMBEDDED_SHA256,
  PI_BRIDGE_EMBEDDED_SOURCE,
  PI_BRIDGE_LEGACY_MARKER,
} from './bridge-asset.ts';

export interface PiBridgeAssetInspection {
  status: 'missing' | 'owned' | 'legacy-marker' | 'unowned' | 'unreadable';
  expectedSha256: string;
  actualSha256?: string;
  path: string;
  requiresConfirmation: boolean;
}

/** Exact package hashes prove ownership. A legacy marker is evidence only and never authorizes overwrite. */
export function inspectPiBridgeAsset(agentDir = PI_AGENT_DIR): PiBridgeAssetInspection {
  const path = join(agentDir, 'extensions', 'cosyncing-bridge', 'index.ts');
  if (!existsSync(path)) {
    return { status: 'missing', expectedSha256: PI_BRIDGE_EMBEDDED_SHA256, path, requiresConfirmation: false };
  }
  try {
    const content = readFileSync(path, 'utf8');
    const actualSha256 = createHash('sha256').update(content).digest('hex');
    if (actualSha256 === PI_BRIDGE_EMBEDDED_SHA256) {
      return { status: 'owned', expectedSha256: PI_BRIDGE_EMBEDDED_SHA256, actualSha256, path, requiresConfirmation: false };
    }
    return {
      status: content.includes(PI_BRIDGE_LEGACY_MARKER) ? 'legacy-marker' : 'unowned',
      expectedSha256: PI_BRIDGE_EMBEDDED_SHA256,
      actualSha256,
      path,
      requiresConfirmation: true,
    };
  } catch {
    return { status: 'unreadable', expectedSha256: PI_BRIDGE_EMBEDDED_SHA256, path, requiresConfirmation: true };
  }
}

/** `extension_ui_request` methods Pi fires fire-and-forget (no response awaited) — must NOT be treated
 *  as blocking dialogs (replying is needless wire noise). The blocking ones (confirm/select/input/
 *  editor) are handled explicitly; only a genuinely-unknown method is cancelled as the anti-hang guard. */
const FIRE_AND_FORGET_UI = new Set(['notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text']);
const PI_THINKING_LEVELS = [
  { effort: 'off', label: 'Off' },
  { effort: 'minimal', label: 'Minimal' },
  { effort: 'low', label: 'Low' },
  { effort: 'medium', label: 'Medium' },
  { effort: 'high', label: 'High' },
  { effort: 'xhigh', label: 'Extra high' },
] as const;
const PI_THINKING_LEVEL_SET = new Set(PI_THINKING_LEVELS.map((x) => x.effort));

const enc = (s: string): string => Buffer.from(s, 'utf8').toString('base64url');
const dec = (s: string): string => Buffer.from(s, 'base64url').toString('utf8');
function canonicalSessionFile(file: string): string {
  const resolved = resolve(file);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}
const sessionIdForFile = (file: string): string => enc(canonicalSessionFile(file));

/** `--home-tester-Projects-x--` → `/home/tester/Projects/x` (best-effort; dashes are lossy). */
function decodeCwdDir(dir: string): string | undefined {
  const m = dir.replace(/^--/, '').replace(/--$/, '');
  const guess = '/' + m.replace(/-/g, '/');
  return existsSync(guess) ? guess : undefined;
}

export class PiAdapter implements AgentBackend {
  readonly id = 'pi';
  readonly displayName = 'Pi';
  readonly capabilities = CAPS;
  /** Native transcript export is HTML via RPC `export_html` (read generically by the broker R2 gate). */
  readonly transcriptExportFormat = 'html' as const;
  private readonly brokerUrl: string;
  private readonly bridgeUsesIntegrationFile: boolean;

  constructor(opts: PiAdapterOptions = {}) {
    this.brokerUrl = (opts.brokerUrl ?? process.env.COSYNCING_BROKER ?? 'http://127.0.0.1:7734').replace(/\/$/, '');
    this.bridgeUsesIntegrationFile = opts.bridgeUsesIntegrationFile === true;
  }

  private terminalSyncCommand(file: string): string {
    return piTerminalSyncCommand(file, this.brokerUrl, this.bridgeUsesIntegrationFile);
  }

  async isAvailable(): Promise<boolean> {
    return existsSync(SESSIONS_ROOT) || resolveBin('pi') !== null;
  }

  async diagnoseSetup(context: SetupDiagnosisContext): Promise<AgentSetupDiagnosis> {
    return diagnosePiSetup(context, { inspectBridge: inspectPiBridgeAsset });
  }

  canCreateSession(): boolean {
    return resolveBin('pi') !== null;
  }

  async listModels(): Promise<ModelOption[]> {
    const response = await createPiSessionViaRpc(homedir(), {
      catalogOnly: true,
    });
    return (response.models ?? [])
      .slice(0, PI_MAX_MODEL_OPTIONS)
      .map((model) => piModelOption(model))
      .filter((model): model is ModelOption => !!model);
  }

  async createSession(opts: {
    directory?: string;
    title?: string;
    model?: PromptInput['model'];
  } = {}): Promise<SessionInfo> {
    const cwd = opts.directory?.trim() || homedir();
    if (!statSafe(cwd)?.isDirectory()) throw new Error(`Pi createSession directory does not exist: ${cwd}`);
    if (resolveBin('pi') === null) throw new Error('Pi CLI is not available on PATH; cannot create a Pi session.');

    const title = opts.title?.trim() || undefined;
    const state = await createPiSessionViaRpc(cwd, {
      title,
      model: opts.model,
    });
    const file = typeof state.sessionFile === 'string' && state.sessionFile ? state.sessionFile : undefined;
    if (!file) throw new Error('Pi get_state did not return a durable session file after create.');
    materializePiSessionFile(file, cwd, String(state.sessionId ?? ''), title);
    const st = statSafe(file);
    const actualCwd = readSessionCwd(file) ?? cwd;
    const name = title ?? readSessionName(file);
    const sessionId = String(state.sessionId ?? '').trim();
    const currentModel = piCurrentModelFromNative(state.model, state.thinkingLevel);
    return {
      id: sessionIdForFile(file),
      tool: this.id,
      title: name ?? `${baseName(actualCwd)} · ${(sessionId || baseName(file)).slice(0, 8)}`,
      cwd: actualCwd,
      status: 'idle',
      attachMode: 'observe',
      currentModel,
      model: state.model?.name ? String(state.model.name) : state.model?.id ? String(state.model.id) : undefined,
      createdAt: st?.birthtimeMs || st?.ctimeMs,
      updatedAt: st?.mtimeMs,
      control: piControlState({
        canDrive: true,
        driveState: 'observing',
        terminalSyncActive: false,
        terminalSyncCommand: this.terminalSyncCommand(file),
        extensionInstalled: piBridgeExtensionInstalled(),
      }),
    };
  }

  async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionInfo[]> {
    if (!existsSync(SESSIONS_ROOT)) return [];
    ensurePiBridgeExtension(); // sync-on-by-default: bundled bridge auto-installed/refreshed once
    const out: SessionInfo[] = [];
    for (const full of piSessionFiles(SESSIONS_ROOT)) {
      const st = statSafe(full);
      if (!st) continue;
      if (
        options?.updatedAfter !== undefined &&
        st.mtimeMs < options.updatedAfter
      ) {
        continue;
      }
      options?.onWork?.({ kind: 'decode-file', source: full });
      const cwd = readSessionCwd(full) ?? decodeCwdDir(baseDir(full)); // authoritative cwd from the file
      const surface = readSessionSurface(full);
      const uuid = baseName(full).replace(/\.jsonl$/, '').split('_').pop() ?? baseName(full);
      out.push({
        id: sessionIdForFile(full),
        tool: this.id,
        title: readSessionName(full) ?? `${cwd ? baseName(cwd) : baseDir(full)} · ${uuid.slice(0, 8)}`,
        cwd,
        // Pi has no live process to observe yet (resume-under-broker), so we can't know
        // working/needs-input from discovery — everything is 'idle' (available). Real-time
        // status arrives with the Pi extension bridge (Pi round). See the live-idle-status log.
        status: 'idle',
        attachMode: 'observe',
        model: surface.model,
        currentModel: surface.currentModel,
        control: piControlState({
          canDrive: resolveBin('pi') !== null,
          driveState: 'observing',
          terminalSyncActive: false,
          terminalSyncCommand: this.terminalSyncCommand(full),
          extensionInstalled: piBridgeExtensionInstalled(),
        }),
        updatedAt: st.mtimeMs,
      });
    }
    return out;
  }

  async attach(sessionId: string, mode: AttachMode = 'observe'): Promise<SessionConnection> {
    const path = canonicalSessionFile(dec(sessionId));
    const cwd = readSessionCwd(path) ?? decodeCwdDir(baseDir(path)); // authoritative cwd from the file
    const canDrive = resolveBin('pi') !== null;
    const surface = readSessionSurface(path);
    if (mode === 'live') {
      throw new Error('Pi true sync is not active for this session. Start the Pi bridge extension in the terminal session, then refresh.');
    }
    const info: SessionInfo = {
      id: sessionId,
      tool: this.id,
      title: readSessionName(path) ?? baseName(path),
      cwd,
      status: 'idle',
      attachMode: mode === 'resume' ? 'resume' : 'observe',
      model: surface.model,
      currentModel: surface.currentModel,
      control: piControlState({
        canDrive,
        driveState: mode === 'resume' ? 'driving' : 'observing',
        terminalSyncActive: false,
        terminalSyncCommand: this.terminalSyncCommand(path),
        extensionInstalled: piBridgeExtensionInstalled(),
      }),
    };
    if (mode !== 'resume') return new PiObserveConnection(path, cwd, info);
    if (!canDrive) throw new Error(`Pi CLI is not available on PATH, so ${PRODUCT_IDENTITY.productName} cannot Drive this session.`);
    const conn = new PiConnection(path, cwd, info);
    await conn.start();
    return conn;
  }

  async renameSession(sessionId: string, title: string | null): Promise<SessionInfo> {
    const path = canonicalSessionFile(dec(sessionId));
    const cwd = readSessionCwd(path) ?? decodeCwdDir(baseDir(path));
    const requested = title == null ? '' : title.trim().slice(0, 160);
    const state = await renamePiSessionViaRpc(path, requested);
    const st = statSafe(path);
    const currentModel = piCurrentModelFromNative(state.model, state.thinkingLevel);
    const nativeTitle =
      (typeof state.sessionName === 'string' && state.sessionName.trim()) ||
      (requested || undefined) ||
      readSessionName(path) ||
      baseName(path);
    return {
      id: sessionIdForFile(path),
      tool: this.id,
      title: nativeTitle,
      cwd,
      status: 'idle',
      attachMode: 'observe',
      currentModel,
      model: state.model?.name ? String(state.model.name) : state.model?.id ? String(state.model.id) : undefined,
      createdAt: st?.birthtimeMs || st?.ctimeMs,
      updatedAt: st?.mtimeMs,
      control: piControlState({
        canDrive: resolveBin('pi') !== null,
        driveState: 'observing',
        terminalSyncActive: false,
        terminalSyncCommand: this.terminalSyncCommand(path),
        extensionInstalled: piBridgeExtensionInstalled(),
      }),
    };
  }

  async forkSession(sessionId: string, opts: { messageId?: string | null } = {}): Promise<SessionInfo> {
    const path = canonicalSessionFile(dec(sessionId));
    const cwd = readSessionCwd(path) ?? decodeCwdDir(baseDir(path));
    const state = await runPiLifecycleRpc(path, 'fork', { messageId: opts.messageId });
    return piSessionInfoFromState(state, path, cwd, this.id, this.brokerUrl, this.bridgeUsesIntegrationFile, 'fork');
  }

  async cloneSession(sessionId: string): Promise<SessionInfo> {
    const path = canonicalSessionFile(dec(sessionId));
    const cwd = readSessionCwd(path) ?? decodeCwdDir(baseDir(path));
    const state = await runPiLifecycleRpc(path, 'clone');
    return piSessionInfoFromState(state, path, cwd, this.id, this.brokerUrl, this.bridgeUsesIntegrationFile, 'clone');
  }

  /**
   * Gated R2 transcript export (Slice 6). The ADAPTER generates a contained output path INSIDE the
   * broker-owned temp dir (a client-supplied path is schema-rejected upstream), calls RPC `export_html`
   * with that path, and realpath-verifies that Pi wrote exactly that contained file — a returned
   * outside/symlinked path is a security failure (rule 8). The broker then runs the mandatory
   * redaction pass and serves the HTML strictly as an export-attachment (never inline-rendered).
   */
  async exportTranscript(
    sessionId: string,
    opts: { tempDir: string; maxBytes: number; timeoutMs: number },
  ): Promise<{ path: string; format: 'html' }> {
    const sessionFile = canonicalSessionFile(dec(sessionId));
    const outputPath = join(opts.tempDir, 'export.html');
    const returned = await runPiExportHtmlRpc(sessionFile, outputPath, opts.timeoutMs);
    // Verify Pi wrote exactly our contained path — realpath both and compare (rule 8).
    let wantReal: string;
    try {
      wantReal = realpathSync(outputPath);
    } catch {
      throw new Error('Pi export_html did not write the requested contained file.');
    }
    let gotReal: string;
    try {
      gotReal = realpathSync(returned);
    } catch {
      throw new Error('Pi export_html returned a missing path.');
    }
    if (gotReal !== wantReal) throw new Error('Pi export_html wrote outside the contained temp path.');
    return { path: outputPath, format: 'html' };
  }
}

type PiRpcSessionState = {
  sessionFile?: string;
  sessionId?: string;
  sessionName?: string;
  model?: { provider?: string; id?: string; name?: string };
  thinkingLevel?: string;
  models?: any[];
};

interface PiCreateRpcOptions {
  title?: string;
  model?: PromptInput['model'];
  catalogOnly?: boolean;
}

export const PI_MAX_MODEL_OPTIONS = 256;

async function createPiSessionViaRpc(
  cwd: string,
  options: PiCreateRpcOptions = {},
): Promise<PiRpcSessionState> {
  const bin = resolveBin('pi');
  if (!bin) throw new Error('Pi CLI is not available on PATH; cannot create a Pi session.');
  const args = [bin, '--mode', 'rpc'];
  const env: NodeJS.ProcessEnv = { ...process.env, COSYNCING_NO_BRIDGE: '1' };
  if (PI_SESSION_ROOT_OVERRIDE) {
    args.push('--session-dir', PI_SESSION_ROOT_OVERRIDE);
    env.PI_CODING_AGENT_SESSION_DIR = PI_SESSION_ROOT_OVERRIDE;
  }
  const proc = Bun.spawn(args, {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd,
    // Keep creation broker-owned and dormant. Do NOT force PI_CODING_AGENT_SESSION_DIR in the normal
    // default case: Pi treats a supplied sessionDir as the final file directory, so forcing
    // ~/.pi/agent/sessions created root-level JSONL files that the terminal TUI's /resume could not
    // find. Only pass a custom session dir when the broker/user explicitly configured one.
    env,
  });
  let reqId = 0;
  let stderr = '';
  const pending = new Map<string, (resp: any) => void>();
  const split = createJsonlSplitter((line) => {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (obj?.type === 'response' && obj.id && pending.has(obj.id)) {
      pending.get(obj.id)!(obj);
      pending.delete(obj.id);
    }
  });
  const stdoutPump = (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        split(decoder.decode(value, { stream: true }));
      }
    } catch {
      /* process ended */
    }
  })();
  const stderrPump = (async () => {
    const reader = proc.stderr.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        stderr += decoder.decode(value, { stream: true });
      }
    } catch {
      /* process ended */
    }
  })();
  const rpc = (cmd: Record<string, unknown>, timeoutMs = 15000): Promise<any> => {
    const id = `create-${++reqId}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) resolve({ success: false, timeout: true, error: `Pi RPC ${cmd.type} timed out` });
      }, timeoutMs);
      pending.set(id, (resp) => {
        clearTimeout(timer);
        resolve(resp);
      });
      try {
        proc.stdin.write(JSON.stringify({ id, ...cmd }) + '\n');
        proc.stdin.flush();
      } catch (err) {
        clearTimeout(timer);
        pending.delete(id);
        resolve({ success: false, error: String(err) });
      }
    });
  };
  try {
    if (options.catalogOnly) {
      const catalog = await rpc({ type: 'get_available_models' }, 20000);
      if (catalog?.success !== true) {
        throw new Error(
          catalog?.error ?? 'Pi get_available_models failed.',
        );
      }
      return {
        models: Array.isArray(catalog?.data?.models)
          ? catalog.data.models.slice(0, PI_MAX_MODEL_OPTIONS)
          : [],
      };
    }
    let stateResp = await rpc({ type: 'get_state' }, 20000);
    if (stateResp?.success !== true) throw new Error(stateResp?.error ?? 'Pi get_state failed during create.');
    if (options.model) {
      const modelResp = await rpc(
        {
          type: 'set_model',
          provider: options.model.providerID,
          modelId: options.model.modelID,
        },
        15000,
      );
      if (modelResp?.success !== true) {
        throw new Error(modelResp?.error ?? 'Pi set_model failed during create.');
      }
      const effort = normalizePiThinkingLevel(options.model.reasoningEffort);
      if (effort) {
        const effortResp = await rpc(
          { type: 'set_thinking_level', level: effort },
          15000,
        );
        if (effortResp?.success !== true) {
          throw new Error(
            effortResp?.error ?? 'Pi set_thinking_level failed during create.',
          );
        }
      }
      stateResp = await rpc({ type: 'get_state' }, 15000);
      if (stateResp?.success !== true) {
        throw new Error('Pi get_state failed after selecting the model.');
      }
    }
    if (options.title) {
      const titleResp = await rpc({ type: 'set_session_name', name: options.title }, 15000);
      if (titleResp?.success !== true) throw new Error(titleResp?.error ?? 'Pi set_session_name failed during create.');
      stateResp = await rpc({ type: 'get_state' }, 15000);
      if (stateResp?.success !== true) throw new Error(stateResp?.error ?? 'Pi get_state failed after naming created session.');
    }
    return stateResp.data ?? {};
  } catch (err) {
    const detail = stderr.trim().split('\n').slice(0, 3).join('\n');
    throw new Error(`Pi createSession failed: ${err instanceof Error ? err.message : String(err)}${detail ? `\n${detail}` : ''}`);
  } finally {
    for (const resolve of pending.values()) resolve({ success: false, error: 'Pi createSession process closed.' });
    pending.clear();
    try {
      proc.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    await Promise.race([proc.exited.catch(() => undefined), new Promise((r) => setTimeout(r, 1000))]);
    await Promise.race([Promise.allSettled([stdoutPump, stderrPump]), new Promise((r) => setTimeout(r, 1000))]);
  }
}

async function renamePiSessionViaRpc(sessionFile: string, title: string): Promise<PiRpcSessionState> {
  const bin = resolveBin('pi');
  if (!bin) throw new Error('Pi CLI is not available on PATH; cannot rename a Pi session.');
  const proc = Bun.spawn([bin, '--mode', 'rpc', '--session', sessionFile], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: readSessionCwd(sessionFile) ?? undefined,
    env: { ...process.env, COSYNCING_NO_BRIDGE: '1' },
  });
  let reqId = 0;
  const pending = new Map<string, (resp: any) => void>();
  const split = createJsonlSplitter((line) => {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (obj?.type === 'response' && obj.id && pending.has(obj.id)) {
      pending.get(obj.id)!(obj);
      pending.delete(obj.id);
    }
  });
  const stdoutPump = (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        split(decoder.decode(value, { stream: true }));
      }
    } catch {
      /* process ended */
    }
  })();
  const stderrPump = proc.stderr.getReader().read().catch(() => undefined);
  const rpc = (cmd: Record<string, unknown>, timeoutMs = 15000): Promise<any> => {
    const id = `rename-${++reqId}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) resolve({ success: false, timeout: true, error: `Pi RPC ${cmd.type} timed out` });
      }, timeoutMs);
      pending.set(id, (resp) => {
        clearTimeout(timer);
        resolve(resp);
      });
      try {
        proc.stdin.write(JSON.stringify({ id, ...cmd }) + '\n');
        proc.stdin.flush();
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        resolve({ success: false, error: 'Pi RPC write failed' });
      }
    });
  };
  try {
    const titleResp = await rpc({ type: 'set_session_name', name: title }, 15000);
    if (titleResp?.success !== true) throw new Error('Pi set_session_name failed');
    const stateResp = await rpc({ type: 'get_state' }, 15000);
    if (stateResp?.success !== true) throw new Error('Pi get_state failed after rename');
    return stateResp.data ?? {};
  } catch {
    throw new Error('Pi rename failed');
  } finally {
    for (const resolve of pending.values()) resolve({ success: false, error: 'Pi rename process closed.' });
    pending.clear();
    try {
      proc.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    await Promise.race([proc.exited.catch(() => undefined), new Promise((r) => setTimeout(r, 1000))]);
    await Promise.race([Promise.allSettled([stdoutPump, stderrPump]), new Promise((r) => setTimeout(r, 1000))]);
  }
}

async function runPiLifecycleRpc(
  sessionFile: string,
  action: 'fork' | 'clone',
  opts: { messageId?: string | null } = {},
): Promise<PiRpcSessionState> {
  const bin = resolveBin('pi');
  if (!bin) throw new Error(`Pi CLI is not available on PATH; cannot ${action} a Pi session.`);
  const proc = Bun.spawn([bin, '--mode', 'rpc', '--session', sessionFile], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: readSessionCwd(sessionFile) ?? undefined,
    env: { ...process.env, COSYNCING_NO_BRIDGE: '1' },
  });
  let reqId = 0;
  const pending = new Map<string, (resp: any) => void>();
  const split = createJsonlSplitter((line) => {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (obj?.type === 'response' && obj.id && pending.has(obj.id)) {
      pending.get(obj.id)!(obj);
      pending.delete(obj.id);
    }
  });
  const stdoutPump = (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        split(decoder.decode(value, { stream: true }));
      }
    } catch {
      /* process ended */
    }
  })();
  const stderrPump = proc.stderr.getReader().read().catch(() => undefined);
  const rpc = (cmd: Record<string, unknown>, timeoutMs = 15000): Promise<any> => {
    const id = `${action}-${++reqId}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) resolve({ success: false, timeout: true, error: `Pi RPC ${cmd.type} timed out` });
      }, timeoutMs);
      pending.set(id, (resp) => {
        clearTimeout(timer);
        resolve(resp);
      });
      try {
        proc.stdin.write(JSON.stringify({ id, ...cmd }) + '\n');
        proc.stdin.flush();
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        resolve({ success: false, error: 'Pi RPC write failed' });
      }
    });
  };
  try {
    const cmd: Record<string, unknown> = { type: action };
    if (action === 'fork' && opts.messageId) cmd.messageId = opts.messageId;
    const actionResp = await rpc(cmd, 15000);
    if (actionResp?.success !== true) throw new Error(piLifecycleFailure(action, actionResp));
    const stateResp = await rpc({ type: 'get_state' }, 15000);
    if (stateResp?.success === true && stateResp.data) return stateResp.data;
    return actionResp.data ?? {};
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Pi ')) throw err;
    throw new Error(`Pi ${action} failed`);
  } finally {
    for (const resolve of pending.values()) resolve({ success: false, error: `Pi ${action} process closed.` });
    pending.clear();
    try {
      proc.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    await Promise.race([proc.exited.catch(() => undefined), new Promise((r) => setTimeout(r, 1000))]);
    await Promise.race([Promise.allSettled([stdoutPump, stderrPump]), new Promise((r) => setTimeout(r, 1000))]);
  }
}

/**
 * Drive one `pi --mode rpc` process to export the session HTML to a broker-owned `outputPath`. Returns
 * the path Pi reports it wrote (verified against the requested contained path by the caller). Explicit
 * argv, no shell; structured RPC fields only (rule 9). The process is always torn down in `finally`.
 */
async function runPiExportHtmlRpc(sessionFile: string, outputPath: string, timeoutMs: number): Promise<string> {
  const bin = resolveBin('pi');
  if (!bin) throw new Error('Pi CLI is not available on PATH; cannot export transcript.');
  const proc = Bun.spawn([bin, '--mode', 'rpc', '--session', sessionFile], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: readSessionCwd(sessionFile) ?? undefined,
    env: { ...process.env, COSYNCING_NO_BRIDGE: '1' },
  });
  let reqId = 0;
  const pending = new Map<string, (resp: any) => void>();
  const split = createJsonlSplitter((line) => {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (obj?.type === 'response' && obj.id && pending.has(obj.id)) {
      pending.get(obj.id)!(obj);
      pending.delete(obj.id);
    }
  });
  const stdoutPump = (async () => {
    const reader = proc.stdout.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        split(decoder.decode(value, { stream: true }));
      }
    } catch {
      /* process ended */
    }
  })();
  const stderrPump = proc.stderr.getReader().read().catch(() => undefined);
  const rpc = (cmd: Record<string, unknown>): Promise<any> => {
    const id = `export-${++reqId}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (pending.delete(id)) resolve({ success: false, timeout: true, error: `Pi RPC ${cmd.type} timed out` });
      }, timeoutMs);
      pending.set(id, (resp) => {
        clearTimeout(timer);
        resolve(resp);
      });
      try {
        proc.stdin.write(JSON.stringify({ id, ...cmd }) + '\n');
        proc.stdin.flush();
      } catch {
        clearTimeout(timer);
        pending.delete(id);
        resolve({ success: false, error: 'Pi RPC write failed' });
      }
    });
  };
  try {
    const resp = await rpc({ type: 'export_html', outputPath });
    if (resp?.success !== true) {
      if (resp?.timeout) throw new Error('Pi export_html timed out');
      throw new Error('Pi export_html failed');
    }
    const written = resp?.data?.path ?? resp?.path;
    if (typeof written !== 'string' || !written) throw new Error('Pi export_html returned no path');
    return written;
  } finally {
    for (const resolve of pending.values()) resolve({ success: false, error: 'Pi export process closed.' });
    pending.clear();
    try {
      proc.stdin.end();
    } catch {
      /* ignore */
    }
    try {
      proc.kill();
    } catch {
      /* ignore */
    }
    await Promise.race([proc.exited.catch(() => undefined), new Promise((r) => setTimeout(r, 1000))]);
    await Promise.race([Promise.allSettled([stdoutPump, stderrPump]), new Promise((r) => setTimeout(r, 1000))]);
  }
}

function piLifecycleFailure(action: 'fork' | 'clone', resp: any): string {
  const raw = String(resp?.error ?? '');
  if (/cancel/i.test(raw)) return `Pi ${action} cancelled by native extension`;
  if (resp?.timeout) return `Pi ${action} timed out`;
  return `Pi ${action} failed`;
}

function piSessionInfoFromState(
  state: PiRpcSessionState,
  fallbackSessionFile: string,
  fallbackCwd: string | undefined,
  tool: string,
  brokerUrl: string,
  bridgeUsesIntegrationFile: boolean,
  action: 'fork' | 'clone',
): SessionInfo {
  const file = canonicalSessionFile(typeof state.sessionFile === 'string' && state.sessionFile ? state.sessionFile : fallbackSessionFile);
  const cwd = readSessionCwd(file) ?? fallbackCwd ?? decodeCwdDir(baseDir(file));
  const st = statSafe(file);
  const sessionId = String(state.sessionId ?? '').trim();
  const currentModel = piCurrentModelFromNative(state.model, state.thinkingLevel);
  const title =
    (typeof state.sessionName === 'string' && state.sessionName.trim()) ||
    readSessionName(file) ||
    `${action === 'fork' ? 'Fork' : 'Clone'} · ${(sessionId || baseName(file)).slice(0, 8)}`;
  return {
    id: sessionIdForFile(file),
    tool,
    title,
    cwd,
    status: 'idle',
    attachMode: 'observe',
    currentModel,
    model: state.model?.name ? String(state.model.name) : state.model?.id ? String(state.model.id) : undefined,
    createdAt: st?.birthtimeMs || st?.ctimeMs,
    updatedAt: st?.mtimeMs,
    control: piControlState({
      canDrive: resolveBin('pi') !== null,
      driveState: 'observing',
      terminalSyncActive: false,
      terminalSyncCommand: piTerminalSyncCommand(file, brokerUrl, bridgeUsesIntegrationFile),
      extensionInstalled: piBridgeExtensionInstalled(),
    }),
  };
}

class PiConnection implements SessionConnection {
  private readonly handlers = new Set<AgentMessageHandler>();
  private proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
  private reqId = 0;
  private readonly pendingRpc = new Map<string, (resp: any) => void>();
  /** extension UI requests awaiting a user decision: requestId → method. */
  private readonly pendingUi = new Map<string, { method: string; options?: string[] }>();
  /** The exact permission/question-request frames still UNRESOLVED — replayed on attach via
   *  {@link getPending} so a client joining a blocked Pi session sees the box, not just the badge.
   *  Tracked centrally in {@link emit} and cleared on the matching *-resolved frame. (Issue G.) */
  private readonly pendingFrames = new Map<string, AgentMessage>();
  private streaming = false;
  /** Per-turn counter: Pi's message_update carries no message.id, so without this every turn's
   *  deltas share a constant key ('m:…') and the app collapses all turns into one growing bubble. */
  private turnSeq = 0;
  /** Tool-call arguments by callId, so a later tool_execution_end can recover the edited file's path
   *  (Pi's result event carries no args) for the canonical tool-result `path` chip. */
  private readonly toolArgs = new Map<string, any>();
  /** Per-prompt counter for the optimistic user-message key, so the app's keyed history-vs-live
   *  dedupe has a stable (non-random) key to work with — matching OpenCode's keyed user-messages. */
  private userSeq = 0;
  private lastUserMessageKey: string | undefined;
  private currentRun:
    | {
        key: string;
        turnId: string;
        userMessageKey?: string;
        startedAt?: number;
      }
    | undefined;

  constructor(
    private readonly sessionPath: string,
    private readonly cwd: string | undefined,
    readonly info: SessionInfo,
  ) {}

  private emit(m: AgentMessage): void {
    // Track pending permission/question requests so they replay on a later attach (Issue G); clear on
    // the matching resolution. requestId is the dedup key the UI also uses, so replay is idempotent.
    if (m.type === 'permission-request' || m.type === 'question-request') this.pendingFrames.set(m.requestId, m);
    else if (m.type === 'permission-resolved' || m.type === 'question-resolved') this.pendingFrames.delete(m.requestId);
    for (const h of this.handlers) {
      try {
        h(m);
      } catch {
        /* isolate */
      }
    }
  }

  /** Unresolved permission/question requests, replayed AFTER history on attach so a client joining a
   *  blocked session gets the box (the Hub's live snapshot only carries in-flight text). (Issue G.) */
  getPending(): AgentMessage[] {
    return [...this.pendingFrames.values()];
  }

  subscribe(handler: AgentMessageHandler): Unsubscribe {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async start(): Promise<void> {
    // Resolve the absolute binary path so Windows picks up `pi.cmd`/`pi.exe` (Bun.spawn won't append
    // those itself); fall back to bare 'pi' for PATH lookup elsewhere.
    const bin = resolveBin('pi') ?? 'pi';
    const cmd = [bin, '--mode', 'rpc', '--session', this.sessionPath];
    this.proc = Bun.spawn(cmd, {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: this.cwd && existsSync(this.cwd) ? this.cwd : undefined,
      // COSYNCING_NO_BRIDGE: this pi is broker-owned (resume-under-broker). The global bridge extension
      // auto-loads in EVERY pi; without this flag a broker-spawned pi would itself try to bridge back
      // to the broker (a loop / double-owner). The flag tells the extension to stay dormant here.
      env: { ...process.env, COSYNCING_NO_BRIDGE: '1' },
    });
    const split = createJsonlSplitter((line) => this.onLine(line));
    void (async () => {
      const reader = this.proc!.stdout.getReader();
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          split(decoder.decode(value, { stream: true }));
        }
      } catch {
        /* process ended */
      }
    })();
    // Best-effort (bounded): learn the active model + display name so the picker shows what's current.
    try {
      const st = await Promise.race([
        this.rpc<any>({ type: 'get_state' }),
        new Promise<any>((r) => setTimeout(() => r(null), 2500)),
      ]);
      const m = st?.data?.model;
      const currentModel = piCurrentModelFromNative(m, st?.data?.thinkingLevel);
      if (currentModel) {
        this.info.currentModel = currentModel;
        this.info.model = String(m?.name ?? m?.id ?? currentModel.modelID);
      }
      if (st?.data?.sessionName) this.info.title = String(st.data.sessionName);
    } catch {
      /* state unavailable — picker still works via listModels() */
    }
  }

  private write(obj: unknown): void {
    if (!this.proc) return;
    this.proc.stdin.write(JSON.stringify(obj) + '\n');
    this.proc.stdin.flush();
  }

  private rpc<T = any>(cmd: Record<string, unknown>): Promise<T> {
    const id = `rpc-${++this.reqId}`;
    return new Promise<T>((resolve) => {
      this.pendingRpc.set(id, resolve);
      this.write({ id, ...cmd });
      setTimeout(() => {
        if (this.pendingRpc.delete(id)) resolve({ success: false, timeout: true } as T);
      }, 15000);
    });
  }

  private onLine(line: string): void {
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    if (obj.type === 'response' && obj.id && this.pendingRpc.has(obj.id)) {
      this.pendingRpc.get(obj.id)!(obj);
      this.pendingRpc.delete(obj.id);
      return;
    }
    this.handleEvent(obj);
  }

  private handleEvent(ev: any): void {
    switch (ev.type) {
      case 'agent_start':
        this.streaming = true;
        this.emit({ type: 'status', status: 'running' });
        return;
      case 'turn_start':
        // Advance the key namespace PER LLM TURN, not per agent RUN. agent_start fires once per run,
        // but a run can batch many turns (queued steer/follow-up) — incrementing on agent_start kept
        // the key constant so every reply's deltas collided and merged into one bubble (the same bug
        // the bridge fixed). turn_start IS forwarded over RPC stdout. See the bridge extension.
        this.turnSeq++;
        this.currentRun = {
          key: `pi:run:${this.turnSeq}`,
          turnId: `t${this.turnSeq}`,
          userMessageKey: this.lastUserMessageKey,
          startedAt: nativeTimeMs(ev.timestamp) ?? Date.now(),
        };
        this.emit({ type: 'run-summary', ...this.currentRun, status: 'running', source: 'pi-rpc' });
        return;
      case 'agent_end':
        this.streaming = false;
        this.toolArgs.clear(); // turn boundary — drop args of any tool-call whose result never arrived (abort/block)
        if (this.currentRun) {
          const completedAt = nativeTimeMs(ev.timestamp) ?? Date.now();
          this.emit({
            type: 'run-summary',
            ...this.currentRun,
            status: 'done',
            completedAt,
            totalRuntimeMs:
              this.currentRun.startedAt != null && completedAt >= this.currentRun.startedAt
                ? completedAt - this.currentRun.startedAt
                : undefined,
            source: 'pi-rpc',
          });
          this.currentRun = undefined;
        }
        this.emit({ type: 'status', status: 'idle' });
        void this.emitSessionStats();
        return;
      case 'message_update': {
        const e = ev.assistantMessageEvent ?? {};
        // Pi gives no message.id, so the turn counter IS the key. Key by content KIND (text/thinking),
        // not the model-dependent contentIndex, so live deltas and any finalized/history snapshot
        // align on the same key — matches the bridge extension's keying.
        if (e.type === 'text_delta') this.emit({ type: 'model-output', delta: e.delta, key: `t${this.turnSeq}:t` });
        else if (e.type === 'thinking_delta') this.emit({ type: 'thinking', delta: e.delta, key: `t${this.turnSeq}:r` });
        else if (e.type === 'toolcall_end' && e.toolCall) {
          const callId = e.toolCall.id ?? `t${this.turnSeq}`;
          if (e.toolCall.arguments !== undefined) this.toolArgs.set(callId, e.toolCall.arguments);
          const semantic = piToolSemantic(e.toolCall.name ?? 'tool', {
            args: e.toolCall.arguments,
            hasResult: false,
          });
          this.emit({
            type: 'tool-call',
            callId,
            toolName: e.toolCall.name ?? 'tool',
            toolClass: piToolDisplayClass(e.toolCall.name ?? 'tool'),
            args: e.toolCall.arguments,
            ...(semantic ? { semantic } : {}),
          });
        }
        return;
      }
      case 'tool_execution_end': {
        const text = contentToText(ev.result?.content);
        const callId = ev.toolCallId ?? '';
        const toolName = ev.toolName ?? 'tool';
        // Enrich with diff/additions/deletions/exitCode/truncated/path so Pi file-edits and shell
        // commands render the SAME chips as OpenCode (the shared tool-result-mapping fix), instead
        // of opaque text. Args (for the path) come from the originating tool-call we cached above.
        const parts = enrichPiToolResult(toolName, {
          text,
          details: ev.result?.details,
          isError: !!ev.isError,
          args: this.toolArgs.get(callId),
        });
        const semantic = piToolSemantic(toolName, {
          args: this.toolArgs.get(callId),
          details: ev.result?.details,
          text,
          isError: !!ev.isError,
          hasResult: true,
        });
        this.toolArgs.delete(callId);
        this.emit({ type: 'tool-result', callId, toolName, toolClass: piToolDisplayClass(toolName), ...(semantic ? { semantic } : {}), isError: !!ev.isError, result: text, ...parts });
        return;
      }
      case 'auto_retry_start': {
        // The API call hit a transient error (429 / overloaded / 5xx) and Pi is retrying. Keep the
        // turn 'running' and surface attempt + reason as a banner — parity with OpenCode's retry
        // (otherwise a rate-limited Pi turn just looks frozen). See docs rpc.md auto_retry_start.
        const reason = String(ev.errorMessage ?? 'transient API error').replace(/\s+/g, ' ').slice(0, 80);
        const detail = `Retrying ${ev.attempt ?? '?'}/${ev.maxAttempts ?? '?'} — ${reason}`;
        this.emit({ type: 'status', status: 'running', detail });
        return;
      }
      case 'auto_retry_end':
        // success → resume (clear the banner with a detail-less running status); exhausted → error.
        if (ev.success === false)
          this.emit({ type: 'error', message: `API retry gave up: ${String(ev.finalError ?? 'all attempts failed').split('\n')[0]?.slice(0, 180)}` });
        else this.emit({ type: 'status', status: 'running' });
        return;
      case 'compaction_start':
        this.emit({ type: 'status', status: 'running', detail: 'Compacting conversation…' });
        return;
      case 'compaction_end':
        // History was rewritten — reload it for every client (vanishes the compacted turns).
        this.emit({ type: 'status', status: this.streaming ? 'running' : 'idle' });
        this.emit({ type: 'history-reset' });
        return;
      case 'extension_ui_request': {
        // confirm → a yes/no permission card; select → an interactive question card so the user's
        // ACTUAL choice is sent back (previously select collapsed to options[0] on approve).
        if (ev.method === 'confirm') {
          this.pendingUi.set(ev.id, { method: 'confirm', options: ev.options });
          this.emit({ type: 'permission-request', requestId: ev.id, title: ev.title ?? 'Confirm?', detail: ev.message });
        } else if (ev.method === 'select') {
          this.pendingUi.set(ev.id, { method: 'select', options: ev.options });
          this.emit({
            type: 'question-request',
            requestId: ev.id,
            questions: [
              { question: ev.message ?? ev.title ?? 'Choose', header: ev.title, options: (ev.options ?? []).map((o: string) => ({ label: o })) },
            ],
          });
        } else if (ev.method === 'input' || ev.method === 'editor') {
          // A free-text dialog (single-line input / multi-line editor). Surface as a question with NO
          // preset options so the app shows a text field; the user's text returns as the `value`.
          // WITHOUT this branch these methods fell through and Pi blocked FOREVER waiting for an
          // extension_ui_response (the resume-adapter hang). See docs deep-source-audit [pi/medium].
          this.pendingUi.set(ev.id, { method: ev.method });
          this.emit({
            type: 'question-request',
            requestId: ev.id,
            questions: [{ question: ev.message ?? ev.title ?? 'Enter a value', header: ev.title, options: [] }],
          });
        } else if (FIRE_AND_FORGET_UI.has(ev.method)) {
          // Fire-and-forget UI call (notify/setStatus/…), NOT a blocking dialog — Pi awaits no
          // response, so don't reply; replying would be needless wire traffic.
          return;
        } else {
          // Unknown BLOCKING dialog method (Pi version drift): we can't answer it correctly, so cancel
          // NOW rather than hang the turn indefinitely. The catch-all is the durable anti-hang guard.
          this.write({ type: 'extension_ui_response', id: ev.id, cancelled: true });
          this.emit({ type: 'event', name: 'dialog-skipped', payload: { method: ev.method } });
        }
        return;
      }
      case 'extension_error':
        this.emit({ type: 'error', message: String(ev.error ?? 'extension error') });
        return;
      default:
        return;
    }
  }

  async getHistory(): Promise<AgentMessage[]> {
    const resp = await this.rpc({ type: 'get_messages' });
    const msgs: any[] = resp?.data?.messages ?? [];
    // First pass: collect tool-call args by id so a toolResult further down can recover its file path
    // (the path lives on the originating tool call, not the result) — mirrors the live toolArgs cache.
    const argsByCallId = new Map<string, any>();
    for (const m of msgs)
      if (m?.role === 'assistant' && Array.isArray(m.content))
        for (const c of m.content) if (c?.type === 'toolCall' && c.id != null) argsByCallId.set(String(c.id), c.arguments);
    const history = mapPiMessages(msgs.map((message, index) => ({ message, index, keyBase: message?.id != null ? String(message.id) : `h${index}`, timestamp: nativeTimeMs(message?.timestamp) })), argsByCallId, true);
    history.push(...await this.sessionStatsMessages());
    return history;
  }

  getHistorySourceIdentity(): HistorySourceIdentity | undefined {
    return fileHistorySourceIdentity(this.sessionPath);
  }

  private async sessionStatsMessages(): Promise<AgentMessage[]> {
    try {
      const resp = await this.rpc({ type: 'get_session_stats' });
      if (resp?.success !== true || !resp.data) return [];
      return mapPiSessionStats(resp.data);
    } catch {
      return [];
    }
  }

  private async emitSessionStats(): Promise<void> {
    for (const message of await this.sessionStatsMessages()) this.emit(message);
  }

  private async applyModelOverride(model: PromptInput['model'] | undefined): Promise<void> {
    if (!model?.modelID) return;
    const modelResp = await this.rpc({ type: 'set_model', provider: model.providerID, modelId: model.modelID });
    const effort = normalizePiThinkingLevel(model.reasoningEffort);
    if (effort) await this.rpc({ type: 'set_thinking_level', level: effort });
    this.info.currentModel = piCurrentModelFromNative(modelResp?.data, effort) ?? {
      providerID: model.providerID,
      modelID: model.modelID,
      ...(effort ? { reasoningEffort: effort } : {}),
    };
  }

  async sendPrompt(input: PromptInput): Promise<void> {
    let text = input.text;
    // Attachments: write each to the workspace inbox and reference them by ABSOLUTE path in THIS
    // turn (multi-file + file+prompt) — the same universal path as OpenCode.
    if (input.files?.length) {
      const refs = input.files.map((f) => {
        const abs = this.writeInboxFile(f);
        return `- ${f.name} (${f.mimeType}) → \`${abs}\``;
      });
      const note = `Attached file(s) — read them from these paths:\n${refs.join('\n')}`;
      text = text.trim() ? `${text}\n\n${note}` : note;
    }
    // Ignore a truly empty prompt (no text, no images, no files) — it spawns a wasted no-op turn.
    if (!text.trim() && !(input.images?.length)) return;
    // Pi (unlike OpenCode) emits NO event echoing the user's own prompt, so the app would never
    // show the message you just sent until a reattach reloads history. Echo it optimistically so
    // it renders immediately (and so the queued-bubble reconcile in the app has something to adopt).
    // Key it (stable per prompt, not random) so the app's keyed dedupe path behaves like OpenCode's.
    // The namespace must NOT collide with the bridge extension's `u<n>` counter: after a terminal
    // bridge adopts this session, the bridge's next live user key can equal a `u<n>` this echo
    // already used — the app then upserts the TUI-typed message INTO the old bubble and the user
    // message silently never appears (issues-part2 item 3 refinement: same-text "hi" repro).
    const sentAt = Date.now();
    const userKey = `u:sent:${++this.userSeq}`;
    this.lastUserMessageKey = userKey;
    this.emit({ type: 'user-message', text, key: userKey, turnId: userKey, sentAt, ...(input.clientMessageId ? { clientKey: input.clientMessageId } : {}) });
    // Per-prompt model override: Pi switches the active model with set_model before the turn runs.
    await this.applyModelOverride(input.model);
    const images = (input.images ?? []).map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }));
    const cmd: Record<string, unknown> = { type: 'prompt', message: text };
    if (images.length) cmd.images = images;
    if (this.streaming) cmd.streamingBehavior = 'steer';
    const resp = await this.rpc(cmd);
    if (resp && resp.success === false && !resp.timeout) {
      throw new Error(resp.error ?? 'pi prompt rejected');
    }
  }

  /** Universal file delivery (same as OpenCode): a bare upload is a prompt carrying one attachment. */
  async sendFile(file: FileInput): Promise<void> {
    await this.sendPrompt({ text: '', files: [file] });
  }

  /** Write an uploaded file into `<cwd>/.cosyncing/inbox`, uniquifying on collision; returns the
   *  ABSOLUTE path written (relative refs get mis-resolved by models), or null if no cwd / failure. */
  private writeInboxFile(file: FileInput): string {
    if (!this.cwd) throw new Error('Pi attachment delivery requires a workspace.');
    const inbox = resolve(this.cwd, PRODUCT_IDENTITY.repositoryDirectoryName, 'inbox');
    if (file.brokerPath) {
      const brokerPath = resolve(file.brokerPath);
      if (dirname(brokerPath) !== inbox || !existsSync(brokerPath)) {
        throw new Error('Pi rejected an untrusted broker attachment path.');
      }
      return brokerPath;
    }
    if (typeof file.data !== 'string') {
      throw new Error('Pi attachment bytes are missing.');
    }
    try {
      mkdirSync(inbox, { recursive: true });
      const base = sanitizeFileName(file.name);
      let safe = base;
      if (existsSync(join(inbox, safe))) {
        const ext = extname(base);
        const stem = ext ? base.slice(0, -ext.length) : base;
        let n = 2;
        while (existsSync(join(inbox, `${stem}-${n}${ext}`))) n++;
        safe = `${stem}-${n}${ext}`;
      }
      const abs = join(inbox, safe);
      writeFileSync(abs, Buffer.from(file.data, 'base64'));
      return abs;
    } catch (error) {
      throw new Error(`Pi could not materialize attachment ${file.name}: ${String(error)}`);
    }
  }

  async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    const ui = this.pendingUi.get(requestId);
    this.pendingUi.delete(requestId);
    if (!ui) return;
    if (decision === 'reject') {
      this.write({ type: 'extension_ui_response', id: requestId, cancelled: true });
    } else if (ui.method === 'confirm') {
      this.write({ type: 'extension_ui_response', id: requestId, confirmed: true });
    } else {
      this.write({ type: 'extension_ui_response', id: requestId, value: ui.options?.[0] ?? 'yes' });
    }
    this.emit({ type: 'permission-resolved', requestId, decision });
  }

  /** Answer a `select` dialog with the user's ACTUAL choice (was: always options[0]). */
  async answerQuestion(requestId: string, answers: string[][]): Promise<void> {
    const ui = this.pendingUi.get(requestId);
    this.pendingUi.delete(requestId);
    const choice = answers?.[0]?.[0];
    this.write({ type: 'extension_ui_response', id: requestId, value: choice ?? ui?.options?.[0] ?? '' });
    this.emit({ type: 'question-resolved', requestId });
  }

  async rejectQuestion(requestId: string): Promise<void> {
    this.pendingUi.delete(requestId);
    this.write({ type: 'extension_ui_response', id: requestId, cancelled: true });
    this.emit({ type: 'question-resolved', requestId });
  }

  /** Built-in RPC actions + Pi's OWN commands (prompt templates, skills, extension commands) from
   *  rpc:get_commands — these are exactly the slash commands the user defined; previously NONE were
   *  reachable (we surfaced only 'stop'), which is why Pi looked far thinner than OpenCode. */
  async listCommands(): Promise<SlashCommand[]> {
    const builtins: SlashCommand[] = [
      { name: 'stop', description: 'Stop the running turn', kind: 'action' },
      { name: 'compact', description: 'Compact / summarize the conversation', kind: 'action' },
    ];
    let dynamic: SlashCommand[] = [];
    try {
      const resp = await this.rpc({ type: 'get_commands' });
      const cmds: any[] = resp?.data?.commands ?? [];
      dynamic = cmds
        .filter((c) => c?.name && /^[\w:-]+$/.test(c.name))
        .map((c) => ({ name: c.name, description: c.description, kind: 'prompt' as const }));
    } catch {
      /* commands unavailable */
    }
    return [...builtins, ...dynamic];
  }

  /** Run a command: built-in RPC actions, else a user template/skill/extension command — which Pi
   *  invokes by sending '/name' as a prompt (rpc.md get_commands). */
  async runCommand(name: string, args?: string, input?: CommandInput): Promise<CommandResult | void> {
    if (name === 'stop' || name === 'abort') {
      this.write({ type: 'abort' });
      return { notice: 'Stopped the turn.' };
    }
    if (name === 'compact') {
      this.write({ type: 'compact', ...(args ? { customInstructions: args } : {}) });
      return { notice: 'Compacting the conversation…' };
    }
    // A dynamic command (template/skill/extension): deliver as a prompt that Pi expands.
    await this.applyModelOverride(input?.model);
    const message = '/' + name + (args ? ' ' + args : '');
    const cmd: Record<string, unknown> = { type: 'prompt', message };
    if (this.streaming) cmd.streamingBehavior = 'steer';
    const resp = await this.rpc(cmd);
    if (resp && resp.success === false && !resp.timeout) throw new Error(resp.error ?? `pi command /${name} rejected`);
  }

  /** Pi's configured models (rpc:get_available_models) → the app's model picker. Fulfils the
   *  long-advertised supportsModelSwitch capability that previously had no list and no switch path. */
  async listModels(): Promise<ModelOption[]> {
    try {
      const resp = await this.rpc({ type: 'get_available_models' });
      const models: any[] = Array.isArray(resp?.data?.models)
        ? resp.data.models.slice(0, PI_MAX_MODEL_OPTIONS)
        : [];
      return models
        .map((m) => piModelOption(m, this.info.currentModel?.reasoningEffort))
        .filter((m): m is ModelOption => !!m);
    } catch {
      return [];
    }
  }

  async close(): Promise<void> {
    try {
      this.write({ type: 'abort' });
    } catch {
      /* ignore */
    }
    this.handlers.clear();
    this.toolArgs.clear();
    this.proc?.kill();
  }
}

class PiObserveConnection implements SessionConnection {
  private readonly handlers = new Set<AgentMessageHandler>();
  private watcher?: FSWatcher;
  private offset = 0;
  private lineIndex = 0;
  private tailBuffer = '';
  private primed = false;

  constructor(
    private readonly sessionPath: string,
    private readonly cwd: string | undefined,
    readonly info: SessionInfo,
  ) {}

  subscribe(handler: AgentMessageHandler): Unsubscribe {
    this.handlers.add(handler);
    if (this.primed) this.startWatch();
    return () => this.handlers.delete(handler);
  }

  private emit(m: AgentMessage): void {
    for (const h of this.handlers) {
      try {
        h(m);
      } catch {
        /* isolate */
      }
    }
  }

  async getHistory(): Promise<AgentMessage[]> {
    const raw = readFileSync(this.sessionPath, 'utf8');
    this.offset = Buffer.byteLength(raw);
    this.lineIndex = countJsonlLines(raw);
    this.primed = true;
    this.startWatch();
    return mapPiJsonlText(raw, 0);
  }

  getHistorySourceIdentity(): HistorySourceIdentity | undefined {
    return fileHistorySourceIdentity(this.sessionPath);
  }

  private startWatch(): void {
    if (this.watcher) return;
    try {
      this.watcher = watch(this.sessionPath, () => setTimeout(() => this.readTail(), 80));
    } catch {
      return;
    }
    this.readTail();
  }

  private readTail(): void {
    let buf: Buffer;
    try {
      buf = readFileSync(this.sessionPath);
    } catch {
      return;
    }
    if (buf.length < this.offset) {
      this.offset = 0;
      this.tailBuffer = '';
      this.lineIndex = 0;
      this.emit({ type: 'history-reset' });
    }
    if (buf.length <= this.offset) return;
    const chunk = buf.subarray(this.offset).toString('utf8');
    this.offset = buf.length;
    this.tailBuffer += chunk;
    const lines = this.tailBuffer.split('\n');
    this.tailBuffer = lines.pop() ?? '';
    if (!lines.length) return;
    const messages = mapPiJsonlLines(lines, this.lineIndex);
    this.lineIndex += lines.length;
    for (const m of messages) this.emit(m);
  }

  async sendPrompt(): Promise<void> {
    throw new Error('This Pi session is read-only in Observe mode. Tap Drive to take over before sending prompts.');
  }

  async respondPermission(): Promise<void> {
    throw new Error(`This Pi session is read-only in Observe mode. Tap Drive to respond from ${PRODUCT_IDENTITY.productName}.`);
  }

  async answerQuestion(): Promise<void> {
    throw new Error(`This Pi session is read-only in Observe mode. Tap Drive to answer from ${PRODUCT_IDENTITY.productName}.`);
  }

  async rejectQuestion(): Promise<void> {
    throw new Error(`This Pi session is read-only in Observe mode. Tap Drive to answer from ${PRODUCT_IDENTITY.productName}.`);
  }

  async sendFile(): Promise<void> {
    throw new Error('This Pi session is read-only in Observe mode. Tap Drive to upload files.');
  }

  async listCommands(): Promise<SlashCommand[]> {
    return [];
  }

  async runCommand(): Promise<CommandResult | void> {
    throw new Error('This Pi session is read-only in Observe mode. Tap Drive to run commands.');
  }

  async close(): Promise<void> {
    this.watcher?.close();
    this.handlers.clear();
  }
}

// ── mapping helpers ───────────────────────────────────────────────────────────

function mapPiMessage(m: any, index = 0, argsByCallId?: Map<string, any>, keyBase?: string, entryTimestamp?: number): AgentMessage[] {
  const out: AgentMessage[] = [];
  if (m?.role === 'user') {
    const text = contentToText(m.content);
    // Key by Pi's message id when present, else deterministically by position — so the history copy
    // dedupes against any live echo and keys identically across reattaches (OpenCode keys its too).
    const key = keyBase ?? (m.id != null ? String(m.id) : `h${index}`);
    const sentAt = nativeTimeMs(m.timestamp) ?? entryTimestamp;
    if (text) out.push({ type: 'user-message', text, key, turnId: key, sentAt });
  } else if (m?.role === 'assistant') {
    const content = Array.isArray(m.content) ? m.content : [];
    let textSeq = 0;
    let thinkingSeq = 0;
    for (const c of content) {
      if (c.type === 'text' && c.text) out.push({ type: 'model-output', text: c.text, final: true, key: keyBase ? `${keyBase}:t:${textSeq++}` : undefined });
      else if (c.type === 'thinking' && c.thinking) out.push({ type: 'thinking', text: c.thinking, key: keyBase ? `${keyBase}:r:${thinkingSeq++}` : undefined });
      else if (c.type === 'toolCall') {
        const semantic = piToolSemantic(c.name ?? 'tool', { args: c.arguments, hasResult: false });
        out.push({ type: 'tool-call', callId: c.id ?? '', toolName: c.name ?? 'tool', toolClass: piToolDisplayClass(c.name ?? 'tool'), args: c.arguments, ...(semantic ? { semantic } : {}) });
      }
    }
    const u = m.usage;
    if (u) out.push({ type: 'token-count', input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite, cost: u.cost?.total });
  } else if (m?.role === 'toolResult') {
    const text = contentToText(m.content);
    const callId = m.toolCallId ?? '';
    const toolName = m.toolName ?? 'tool';
    const args = argsByCallId?.get(String(callId));
    const parts = enrichPiToolResult(toolName, { text, details: m.details, isError: !!m.isError, args });
    const semantic = piToolSemantic(toolName, { args, details: m.details, text, isError: !!m.isError, hasResult: true });
    out.push({ type: 'tool-result', callId, toolName, toolClass: piToolDisplayClass(toolName), ...(semantic ? { semantic } : {}), isError: !!m.isError, result: text, ...parts });
  }
  return out;
}

export function mapPiJsonlText(raw: string, firstIndex = 0): AgentMessage[] {
  return mapPiJsonlLines(raw.split('\n'), firstIndex, true);
}

function mapPiJsonlLines(lines: string[], firstIndex = 0, includeTotals = false): AgentMessage[] {
  const entries: { message: any; index: number; keyBase: string; timestamp?: number }[] = [];
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      return;
    }
    const message = obj?.type === 'message' ? obj.message : undefined;
    if (!message) return;
    const index = firstIndex + i;
    const keyBase = obj.id != null ? String(obj.id) : message.id != null ? String(message.id) : `h${index}`;
    entries.push({ message, index, keyBase, timestamp: nativeTimeMs(obj.timestamp) ?? nativeTimeMs(message.timestamp) });
  });
  const argsByCallId = new Map<string, any>();
  for (const e of entries) {
    const m = e.message;
    if (m?.role === 'assistant' && Array.isArray(m.content)) {
      for (const c of m.content) if (c?.type === 'toolCall' && c.id != null) argsByCallId.set(String(c.id), c.arguments);
    }
  }
  return mapPiMessages(entries, argsByCallId, includeTotals);
}

function mapPiMessages(
  entries: { message: any; index: number; keyBase: string; timestamp?: number }[],
  argsByCallId: Map<string, any>,
  includeTotals: boolean,
): AgentMessage[] {
  const out: AgentMessage[] = [];
  let lastUserKey: string | undefined;
  let lastUserAt: number | undefined;
  const summaries: AgentMessage[] = [];
  for (const e of entries) {
    out.push(...mapPiMessage(e.message, e.index, argsByCallId, e.keyBase, e.timestamp));
    if (e.message?.role === 'user') {
      lastUserKey = e.keyBase;
      lastUserAt = nativeTimeMs(e.message.timestamp) ?? e.timestamp ?? lastUserAt;
    } else if (e.message?.role === 'assistant') {
      const startedAt = lastUserAt ?? nativeTimeMs(e.message.timestamp);
      const completedAt = e.timestamp ?? nativeTimeMs(e.message.timestamp);
      const textKey = firstPiAssistantTextKey(e.message, e.keyBase);
      const summary: AgentMessage = {
        type: 'run-summary',
        key: `pi:run:${e.keyBase}`,
        turnId: e.keyBase,
        userMessageKey: lastUserKey,
        assistantMessageKey: textKey,
        status: e.message.error ? 'error' : 'done',
        startedAt,
        completedAt,
        totalRuntimeMs: startedAt != null && completedAt != null && completedAt >= startedAt ? completedAt - startedAt : undefined,
        tokens: piUsageTokens(e.message.usage),
        source: 'pi-jsonl',
      };
      out.push(summary);
      summaries.push(summary);
    }
  }
  const totals = includeTotals ? runtimeTotalsFromRunSummaries(summaries, 'pi') : undefined;
  if (totals) out.push(totals);
  return out;
}

function countJsonlLines(raw: string): number {
  if (!raw) return 0;
  const parts = raw.split('\n');
  return raw.endsWith('\n') ? parts.length - 1 : parts.length;
}

function nativeTimeMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function firstPiAssistantTextKey(message: any, keyBase: string): string | undefined {
  if (!Array.isArray(message?.content)) return undefined;
  let textSeq = 0;
  let thinkingSeq = 0;
  for (const c of message.content) {
    if (c?.type === 'text' && c.text) return `${keyBase}:t:${textSeq}`;
    if (c?.type === 'text') textSeq++;
    else if (c?.type === 'thinking') thinkingSeq++;
  }
  thinkingSeq = 0;
  for (const c of message.content) {
    if (c?.type === 'thinking' && c.thinking) return `${keyBase}:r:${thinkingSeq}`;
    if (c?.type === 'thinking') thinkingSeq++;
  }
  return undefined;
}

function piUsageTokens(usage: any): { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number } | undefined {
  if (!usage) return undefined;
  const out = {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    cost: usage.cost?.total,
  };
  return Object.values(out).some((v) => v != null) ? out : undefined;
}

function mapPiSessionStats(stats: any): AgentMessage[] {
  if (!stats || typeof stats !== 'object') return [];
  const out: AgentMessage[] = [{ type: 'metadata-update', key: 'sessionStats', value: stats }];
  const tokens = stats.tokens && typeof stats.tokens === 'object' ? stats.tokens : stats;
  const tokenCount = {
    input: firstNumber(tokens.input, tokens.inputTokens, tokens.promptTokens, tokens.totalInputTokens),
    output: firstNumber(tokens.output, tokens.outputTokens, tokens.completionTokens, tokens.totalOutputTokens),
    cacheRead: firstNumber(tokens.cacheRead, tokens.cache_read, tokens.cacheReadTokens),
    cacheWrite: firstNumber(tokens.cacheWrite, tokens.cache_write, tokens.cacheWriteTokens),
    cost: firstNumber(tokens.cost, tokens.totalCost, tokens.costUsd),
  };
  if (Object.values(tokenCount).some((v) => v != null)) out.push({ type: 'token-count', ...tokenCount });
  return out;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

function runtimeTotalsFromRunSummaries(summaries: AgentMessage[], source: string): AgentMessage | undefined {
  let totalRuntimeMs = 0;
  let turnCount = 0;
  let updatedAt: number | undefined;
  for (const m of summaries) {
    if (m.type !== 'run-summary' || (m.status !== 'done' && m.status !== 'error' && m.status !== 'cancelled')) continue;
    if (typeof m.totalRuntimeMs === 'number' && m.totalRuntimeMs >= 0) {
      totalRuntimeMs += m.totalRuntimeMs;
      turnCount++;
    }
    if (typeof m.completedAt === 'number') updatedAt = updatedAt == null ? m.completedAt : Math.max(updatedAt, m.completedAt);
  }
  if (!turnCount) return undefined;
  return { type: 'metadata-update', key: 'runtimeTotals', value: { totalRuntimeMs, turnCount, updatedAt, source } };
}

function piControlState(opts: {
  canDrive: boolean;
  driveState: 'observing' | 'driving';
  terminalSyncActive: boolean;
  terminalSyncCommand: string;
  /** D22: the Pi bridge extension is installed on disk, so resuming this session in the terminal WILL
   *  auto-connect the bridge → sync. Only then do we advertise `syncAvailable` on a not-yet-bridged
   *  disk row; without it, sync is not something the in-app flow can deliver (→ Take over / Observe). */
  extensionInstalled: boolean;
}): SessionControlState {
  const drive = opts.driveState === 'driving'
    ? { supported: true, state: 'driving' as const }
    : opts.canDrive
      ? { supported: true, state: 'observing' as const }
      : { supported: false, state: 'unavailable' as const, reason: `Pi CLI is not available on PATH, so ${PRODUCT_IDENTITY.productName} cannot Drive this session.` };
  const terminalSync = opts.terminalSyncActive
    ? {
        supported: true,
        syncAvailable: true,
        active: true,
        label: 'Synced with Pi terminal',
        note: `This Pi session is connected through the ${PRODUCT_IDENTITY.productName} bridge extension.`,
      }
    : {
        supported: true,
        // D22: only promise sync when the bridge extension is actually installed (otherwise resuming
        // won't connect a bridge and we'd be advertising sync we can't deliver).
        syncAvailable: opts.extensionInstalled,
        active: false,
        label: 'Resume in Pi terminal',
        command: opts.terminalSyncCommand,
        note: 'Resume this session in the Pi CLI; once the installed bridge connects, the app will show it as synced.',
      };
  return { drive, terminalSync };
}

/** D22 probe: is the cosyncing Pi bridge extension installed where a live `pi` will load it?
 *  Installed at `${PI_CODING_AGENT_DIR ?? ~/.pi/agent}/extensions/cosyncing-bridge/index.ts`. */
function piBridgeExtensionInstalled(): boolean {
  return existsSync(join(PI_AGENT_DIR, 'extensions', 'cosyncing-bridge', 'index.ts'));
}

// True-sync on by default (issues-part2): install the embedded bridge extension when the target is absent.
// Exact hash matches are idempotent. A differing legacy-marker or unrelated file is preserved until the
// transactional setup flow obtains confirmation; marker-only evidence never authorizes an automatic overwrite.
// Runs once per broker lifetime; COSYNCING_PI_BRIDGE_AUTOINSTALL=0 opts out.
let _piBridgeEnsured = false;
function ensurePiBridgeExtension(): void {
  if (_piBridgeEnsured) return;
  _piBridgeEnsured = true;
  if (/^(0|false|no|off)$/i.test((process.env.COSYNCING_PI_BRIDGE_AUTOINSTALL ?? '').trim())) return;
  try {
    const inspection = inspectPiBridgeAsset();
    if (inspection.status !== 'missing') return;
    const dstDir = dirname(inspection.path);
    mkdirSync(dstDir, { recursive: true });
    writeFileSync(inspection.path, PI_BRIDGE_EMBEDDED_SOURCE, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch {
    /* best-effort — doctor/setup owns the visible remediation path */
  }
}

function piTerminalSyncCommand(file: string, brokerUrl: string, bridgeUsesIntegrationFile = false): string {
  const resume = `pi --session ${shellQuote(canonicalSessionFile(file))}`;
  return bridgeUsesIntegrationFile || isDefaultBrokerUrl(brokerUrl)
    ? resume
    : `COSYNCING_BROKER=${shellQuote(brokerUrl)} ${resume}`;
}

function isDefaultBrokerUrl(brokerUrl: string): boolean {
  try {
    const u = new URL(brokerUrl);
    const host = u.hostname.replace(/^\[|\]$/g, '');
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return u.protocol === 'http:' && port === '7734' && (host === '127.0.0.1' || host === 'localhost' || host === '::1');
  } catch {
    return brokerUrl === 'http://127.0.0.1:7734';
  }
}

/** The canonical tool-result rich-detail fields derived from a Pi result (see {@link enrichPiToolResult}). */
export interface PiToolResultParts {
  path?: string;
  diff?: string;
  fileChanges?: FileChange[];
  additions?: number;
  deletions?: number;
  exitCode?: number;
  truncated?: boolean;
  title?: string;
  durationMs?: number;
}

/**
 * Map a Pi tool result's rich details into the canonical `tool-result` fields so a phone shows the
 * SAME diffstat / exit-code / truncation chips for Pi that it already does for OpenCode — instead of
 * an opaque text blob (the audit's shared-surface tool-result-mapping gap). Shared by BOTH Pi paths:
 * the resume adapter (live `tool_execution_end` + history) and the live bridge
 * (broker/src/pi-bridge.ts), so neither drops detail. Pi's edit tool returns `details.diff`/`.patch`;
 * bash returns `details.truncation`/`.fullOutputPath` and embeds the exit code in the error text
 * ("Command exited with code N"); the file path comes from the originating tool-call args.
 */
export function enrichPiToolResult(
  toolName: string,
  opts: { text?: string; details?: any; isError?: boolean; args?: any },
): PiToolResultParts {
  const out: PiToolResultParts = {};
  const d = opts.details ?? {};
  const args = opts.args ?? {};
  const diff = typeof d.diff === 'string' ? d.diff : typeof d.patch === 'string' ? d.patch : undefined;
  if (diff) {
    out.diff = diff;
    const { additions, deletions } = summarizeDiff(diff);
    out.additions = additions;
    out.deletions = deletions;
  }
  // A diff implies a real file op, so its path is always trustworthy. Otherwise only trust an arg
  // `path` for file read/write tools — grep/ls/find overload `path` to mean a SEARCH directory, which
  // must NOT become a path chip or a filename-style title.
  const isFileTool = /edit|write|read|create|patch|apply|multiedit|replace/i.test(toolName);
  const argPath = args.path ?? args.file_path ?? args.filePath ?? args.filename ?? d.path;
  const path = diff
    ? (typeof argPath === 'string' && argPath ? argPath : pathFromDiff(diff))
    : (isFileTool && typeof argPath === 'string' && argPath ? argPath : undefined);
  if (path) out.path = path;
  // Canonical per-file change set from the same event-time diff (single file for Pi's edit tool).
  if (diff) {
    const changes = splitUnifiedDiffFiles(diff);
    if (changes.length) out.fileChanges = changes.map((c) => (c.path ? c : { ...c, path: out.path ?? '' }));
    else if (out.path) out.fileChanges = [{ path: out.path, operation: 'edit', diff, additions: out.additions, deletions: out.deletions }];
  }
  if (d.truncation?.truncated === true || d.truncated === true) out.truncated = true;
  if (typeof d.exitCode === 'number') out.exitCode = d.exitCode;
  else if (opts.isError && opts.text) {
    // Pi appends the authoritative "Command exited with code N" status LAST (after the command's own
    // output), so take the LAST match — a command whose output itself mentions an exit code won't fool it.
    const matches = [...opts.text.matchAll(/exit(?:ed)?(?: with)? code (\d+)/gi)];
    const last = matches[matches.length - 1];
    if (last?.[1]) out.exitCode = Number(last[1]);
  }
  if (out.path) {
    const base = out.path.split(/[\\/]/).pop() || out.path;
    out.title = /edit|write|patch|apply|create|multiedit|replace/i.test(toolName) ? `Edited ${base}` : base;
  }
  const explicitDuration = Number(d.durationMs ?? d.duration_ms ?? d.elapsedMs ?? d.elapsed_ms);
  if (Number.isFinite(explicitDuration) && explicitDuration >= 0) out.durationMs = explicitDuration;
  else if (d.duration && typeof d.duration === 'object') {
    const seconds = Number(d.duration.secs ?? d.duration.seconds ?? 0);
    const nanos = Number(d.duration.nanos ?? d.duration.nanoseconds ?? 0);
    const durationMs = seconds * 1000 + nanos / 1_000_000;
    if (Number.isFinite(durationMs) && durationMs >= 0) out.durationMs = durationMs;
  }
  return out;
}

/**
 * The one place Pi maps a native tool name to a normalized presentation family;
 * `null` keeps a tool on the bounded structured fallback.
 */
function piToolFamily(toolName: string): 'command' | 'file-read' | 'search' | 'web' | null {
  switch (String(toolName || '').toLowerCase()) {
    case 'bash':
    case 'shell':
    case 'command':
    case 'interactive_bash':
      return 'command';
    case 'read':
      return 'file-read';
    case 'grep':
    case 'glob':
    case 'find':
    case 'list':
    case 'ls':
      return 'search';
    case 'webfetch':
    case 'websearch':
      return 'web';
    default:
      return null;
  }
}

/**
 * Pi tool call/result → the canonical normalized family.
 *
 * Shared by BOTH Pi surfaces (the resume adapter's live/history mapping and the
 * live bridge in broker/src/pi-bridge.ts) so neither invents its own parsing.
 * `details` is absent on a still-running call, which yields the call-time fields
 * plus a `running` state.
 */
export function piToolSemantic(
  toolName: string,
  opts: { args?: any; details?: any; text?: string; isError?: boolean; hasResult: boolean },
): ToolSemantic | undefined {
  const family = piToolFamily(toolName);
  if (!family) return undefined;
  const args = opts.args && typeof opts.args === 'object' ? opts.args : {};
  const d = opts.details && typeof opts.details === 'object' ? opts.details : {};
  switch (family) {
    case 'command': {
      // Pi embeds the authoritative code in the result text when `details` has
      // none; reuse the existing enrichment rather than re-deriving it here.
      const exitCode = typeof d.exitCode === 'number'
        ? d.exitCode
        : enrichPiToolResult(toolName, {
            text: opts.text,
            details: opts.details,
            isError: opts.isError,
            args: opts.args,
          }).exitCode;
      const state: ToolCommandState = !opts.hasResult
        ? 'running'
        : d.aborted === true || d.interrupted === true
          ? 'interrupted'
          : exitCode !== undefined
            ? (exitCode === 0 ? 'completed' : 'failed')
            : opts.isError === true
              ? 'failed'
              : 'unknown';
      return boundToolSemantic(commandSemantic({
        command: args.command ?? args.cmd ?? d.command,
        cwd: args.cwd ?? args.workdir ?? d.cwd,
        state,
        stdout: boundedStream(d.stdout),
        stderr: boundedStream(d.stderr),
      }));
    }
    case 'file-read':
      return boundToolSemantic(fileReadSemantic({
        path: args.path ?? args.file_path ?? args.filePath ?? d.path,
        startLine: typeof args.offset === 'number' ? args.offset + 1 : d.startLine,
        preview: opts.hasResult ? (d.content ?? opts.text) : undefined,
        totalLines: d.totalLines ?? d.lines,
        previewTruncated: d.truncation?.truncated === true || d.truncated === true,
      }));
    case 'search': {
      const groups: (ToolSearchGroup | undefined)[] = [];
      const files = Array.isArray(d.files) ? d.files : Array.isArray(d.matches) ? d.matches : [];
      for (const file of files) {
        groups.push(typeof file === 'string'
          ? searchGroup({ path: file })
          : searchGroup({ path: file?.path, matchCount: file?.count, matches: file?.matches }));
      }
      return boundToolSemantic(searchSemantic({
        query: args.pattern ?? args.query ?? args.name,
        scope: args.path ?? args.glob ?? args.dir,
        matchCount: d.matchCount,
        fileCount: d.fileCount ?? (files.length || undefined),
        groups,
      }));
    }
    case 'web':
      return boundToolSemantic(webSemantic({
        query: args.query,
        url: args.url,
        results: Array.isArray(d.results) ? d.results : undefined,
      }));
  }
}

/** Pi owns this native-name mapping; clients consume only the canonical semantic class. */
export function piToolDisplayClass(toolName: string): ToolDisplayClass {
  const name = String(toolName || '').toLowerCase();
  if (/^(bash|shell|exec|command|interactive_bash)$/.test(name)) return 'execute';
  if (/(^|[_-])(edit|write|patch|create|delete|move|rename)([_-]|$)/.test(name)) return 'edit';
  if (
    /^(read|grep|glob|find|list|ls|webfetch|websearch|view_image)$/.test(name)
    || /(^|[_-])(read|grep|glob|search|fetch|list|query|diagnostic|symbols)([_-]|$)/.test(name)
    || /directory_tree/.test(name)
  ) return 'lookup';
  return 'other';
}

/** Recover a file path from a unified-diff `+++ b/<path>` (or `+++ <path>`) header. */
function pathFromDiff(diff: string): string | undefined {
  const m = /^\+\+\+ (?:[ab]\/)?(.+)$/m.exec(diff);
  const p = m?.[1]?.trim();
  return p && p !== '/dev/null' ? p : undefined;
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content))
    return content
      .map((c: any) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text : ''))
      .join('')
      .trim();
  return '';
}

function normalizePiThinkingLevel(value: unknown): string | undefined {
  const level = typeof value === 'string' ? value.trim() : '';
  return PI_THINKING_LEVEL_SET.has(level as any) ? level : undefined;
}

function piThinkingEfforts(model: any): ModelOption['reasoningEfforts'] | undefined {
  if (model?.reasoning !== true) return undefined;
  const map = model?.thinkingLevelMap && typeof model.thinkingLevelMap === 'object' ? model.thinkingLevelMap : undefined;
  const efforts = PI_THINKING_LEVELS
    .filter(({ effort }) => map?.[effort] !== null)
    .map(({ effort, label }) => ({ effort, label }));
  return efforts.length ? efforts : undefined;
}

function piCurrentModelFromNative(model: any, thinkingLevel?: unknown): SessionInfo['currentModel'] | undefined {
  const modelID = model?.id ?? model?.modelID ?? model?.model;
  if (typeof modelID !== 'string' || !modelID) return undefined;
  const effort = normalizePiThinkingLevel(thinkingLevel ?? model?.thinkingLevel ?? model?.reasoningEffort);
  return {
    providerID: String(model.provider ?? model.providerID ?? ''),
    modelID,
    ...(effort ? { reasoningEffort: effort } : {}),
  };
}

function piModelOption(model: any, currentEffort?: string): ModelOption | undefined {
  const modelID = model?.id ?? model?.modelID;
  if (typeof modelID !== 'string' || !modelID) return undefined;
  const option: ModelOption = {
    providerID: String(model.provider ?? model.providerID ?? ''),
    modelID,
    label: String(model.name ?? model.label ?? modelID),
  };
  const efforts = piThinkingEfforts(model);
  if (efforts?.length) {
    option.reasoningEfforts = efforts;
    if (currentEffort && efforts.some((e) => e.effort === currentEffort)) option.defaultReasoningEffort = currentEffort;
  }
  return option;
}

type PiSessionSurface = { model?: string; currentModel?: SessionInfo['currentModel']; thinkingLevel?: string };

function readSessionSurface(file: string): PiSessionSurface {
  try {
    const st = statSafe(file);
    if (!st) return {};
    const maxTail = SESSION_NAME_SCAN_BYTES;
    const tail = readTextTail(file, st.size, maxTail);
    const tailSurface = scanSessionSurface(tail.split('\n'));
    if ((tailSurface.model || tailSurface.currentModel) || st.size <= maxTail) return tailSurface;
    // Fallback for tiny/early files that only have header-ish model metadata. Latest model/thinking
    // changes are intentionally taken from the bounded tail to keep roster polling cheap. If the tail
    // only reported a thinking-level change, combine it with the head's model instead of dropping it.
    const head = readTextHead(file, Math.min(st.size, 64 * 1024));
    const headSurface = scanSessionSurface(head.split('\n'));
    if (headSurface.currentModel && tailSurface.thinkingLevel) {
      return { ...headSurface, currentModel: { ...headSurface.currentModel, reasoningEffort: tailSurface.thinkingLevel } };
    }
    return headSurface;
  } catch {
    return {};
  }
}

function scanSessionSurface(lines: string[]): PiSessionSurface {
  let currentModel: SessionInfo['currentModel'];
  let modelLabel: string | undefined;
  let thinkingLevel: string | undefined;
  const applyModel = (model: any, label?: string) => {
    const next = piCurrentModelFromNative(model, thinkingLevel);
    if (!next) return;
    currentModel = next;
    modelLabel = label ?? String(model?.name ?? model?.label ?? model?.modelID ?? model?.id ?? model?.model ?? next.modelID);
  };
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj: any;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    const level = normalizePiThinkingLevel(obj?.thinkingLevel ?? obj?.thinking_level ?? obj?.data?.thinkingLevel);
    if (obj?.type === 'thinking_level_change' && level) {
      thinkingLevel = level;
      if (currentModel) currentModel = { ...currentModel, reasoningEffort: level };
      continue;
    }
    if (level && !thinkingLevel) thinkingLevel = level;
    if (obj?.type === 'model_change') {
      applyModel({ provider: obj.provider, id: obj.modelId ?? obj.modelID ?? obj.model }, obj.name ?? obj.modelName);
    } else if (obj?.type === 'message' && obj.message?.role === 'assistant') {
      applyModel({ provider: obj.message.provider, id: obj.message.model }, obj.message.modelName);
    } else if (obj?.model) {
      applyModel(obj.model);
    } else if (obj?.currentModel) {
      applyModel(obj.currentModel);
    }
  }
  return { model: modelLabel, currentModel, thinkingLevel };
}

function readSessionName(file: string): string | undefined {
  try {
    const st = statSafe(file);
    if (!st) return undefined;
    const maxTail = SESSION_NAME_SCAN_BYTES;
    const tail = readTextTail(file, st.size, maxTail);
    let latest: string | undefined;
    let fallback: string | undefined;
    for (const line of tail.split('\n')) {
      if (!line.trim()) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj?.type === 'session_info' && typeof obj.name === 'string') latest = obj.name || undefined;
      else if (!fallback && (typeof obj?.name === 'string' || typeof obj?.sessionName === 'string')) {
        fallback = obj.name || obj.sessionName || undefined;
      }
    }
    if (latest || fallback || st.size <= maxTail) return latest ?? fallback;
    const head = readTextHead(file, Math.min(st.size, 64 * 1024));
    for (const line of head.split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (typeof obj?.name === 'string' || typeof obj?.sessionName === 'string') return obj.name || obj.sessionName || undefined;
      } catch {
        continue;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function materializePiSessionFile(file: string, cwd: string, sessionId?: string, title?: string): void {
  try {
    if (!existsSync(file)) {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(
        file,
        JSON.stringify({
          type: 'session',
          version: 3,
          id: sessionId || baseName(file).replace(/\.jsonl$/, '').split('_').pop() || `cosyncing-${Date.now()}`,
          timestamp: new Date().toISOString(),
          cwd,
        }) + '\n',
      );
    }
    const name = title?.trim();
    if (name && readSessionName(file) !== name) {
      writeFileSync(
        file,
        JSON.stringify({
          type: 'session_info',
          id: `cosyncing-name-${Date.now()}`,
          parentId: null,
          timestamp: new Date().toISOString(),
          name,
        }) + '\n',
        { flag: 'a' },
      );
    }
  } catch {
    /* createSession will still return the native path; discovery may pick it up after the first turn */
  }
}

/**
 * The AUTHORITATIVE working dir: Pi records it in the session JSONL's first `session` record
 * (`{"type":"session", ..., "cwd":"/abs/path"}`). We use this instead of decoding the dash-mangled
 * directory name, which is lossy (`-`→`/`) and wrong for any path containing a hyphen — that bug
 * silently broke ALL file I/O and could even spawn pi in an unrelated directory.
 */
function readSessionCwd(file: string): string | undefined {
  try {
    const firstLine = readTextHead(file, 64 * 1024).split('\n', 1)[0] ?? '';
    const cwd = JSON.parse(firstLine)?.cwd;
    return typeof cwd === 'string' && cwd ? cwd : undefined;
  } catch {
    return undefined;
  }
}

function readTextHead(file: string, maxBytes: number): string {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const n = readSync(fd, buf, 0, maxBytes, 0);
    return buf.toString('utf8', 0, n);
  } finally {
    closeSync(fd);
  }
}

function readTextTail(file: string, size: number, maxBytes: number): string {
  const start = Math.max(0, size - maxBytes);
  const len = size - start;
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, start);
    const text = buf.toString('utf8', 0, n);
    if (start === 0) return text;
    const firstBreak = text.indexOf('\n');
    return firstBreak >= 0 ? text.slice(firstBreak + 1) : '';
  } finally {
    closeSync(fd);
  }
}

/** Filesystem-safe, length-bounded inbox name; degenerate inputs ('.', '..', '', whitespace) → 'file'. */
function sanitizeFileName(name: string): string {
  let base = baseName(String(name)).replace(/[^\w.\- ]+/g, '_').trim();
  if (!base || base === '.' || base === '..') base = 'file';
  if (base.length > 200) {
    const ext = extname(base).slice(0, 20);
    base = base.slice(0, 200 - ext.length) + ext;
  }
  return base;
}

function safeReaddir(p: string): string[] {
  try {
    return readdirSync(p);
  } catch {
    return [];
  }
}
function piSessionFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of safeReaddir(root)) {
    const full = join(root, entry);
    const st = statSafe(full);
    if (!st) continue;
    if (st.isFile() && entry.endsWith('.jsonl')) out.push(full);
    else if (st.isDirectory()) {
      for (const file of safeReaddir(full)) if (file.endsWith('.jsonl')) out.push(join(full, file));
    }
  }
  return out;
}
function statSafe(p: string) {
  try {
    return statSync(p);
  } catch {
    return undefined;
  }
}
const HISTORY_SOURCE_REWRITE_PREFIX_BYTES = 1024;

function fileHistorySourceIdentity(path: string): HistorySourceIdentity | undefined {
  const stat = statSafe(path);
  if (!stat) return undefined;
  const prefix = Buffer.alloc(
    Math.min(HISTORY_SOURCE_REWRITE_PREFIX_BYTES, stat.size),
  );
  let prefixBytes = 0;
  try {
    const fd = openSync(path, 'r');
    try {
      prefixBytes = readSync(fd, prefix, 0, prefix.length, 0);
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
  return {
    sourceId: `${path}:${stat.dev}:${stat.ino}`,
    revision: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
    appendPosition: stat.size,
    rewriteToken: createHash('sha256')
      .update(prefix.subarray(0, prefixBytes))
      .digest('base64url'),
  };
}
// node:path basename/dirname handle BOTH `/` and `\` on Windows (and `/` on POSIX), so these work
// for session paths (built with join → native sep) and for cwds reported by Pi on any platform.
function baseName(p: string): string {
  return basename(p) || p;
}
function baseDir(p: string): string {
  return basename(dirname(p));
}
/** Absolute path to a binary on PATH, or null. Bun.which is cross-platform — on Windows it resolves
 *  the `.cmd`/`.exe` shim (unlike a hard-coded `which`, which doesn't exist there). */
function resolveBin(bin: string): string | null {
  try {
    if (bin === 'pi') {
      const override = process.env.COSYNCING_PI_BIN?.trim();
      if (override) return override;
    }
    return Bun.which(bin);
  } catch {
    return null;
  }
}

function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
