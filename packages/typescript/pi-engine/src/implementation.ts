/**
 * Pi engine — integrationKind 'jsonrpc-stdio', dialect-parameterized.
 *
 * Pi (pi.dev) has no persistent daemon, so for MVP we attach by spawning
 * `pi --mode rpc --session <file>` (resume-under-broker): the broker owns the
 * process and fully drives it; the saved conversation is replayed via
 * `get_messages`. True multi-client live attach via a Pi extension is a later
 * upgrade (docs/protocol/adapter-support.md).
 *
 * Discovery: <agentDir>/sessions/<encoded-cwd>/<iso>_<uuid>.jsonl by default, or a custom
 * session root when the dialect's sessions-root env overrides are explicitly set.
 * Protocol: strict JSONL over stdin/stdout, as specified by `rpc.md` in the
 * upstream Pi source distribution's documentation directory.
 *
 * This package is the dialect-neutral engine shared by the pi adapter and any pi-compatible
 * fork's adapter: each adapter package binds it to a resolved dialect runtime (dialect.ts) plus
 * its own readiness gate, doctor diagnostics, and embedded bridge asset. `PiAdapter` itself lives
 * in the pi adapter package; only `PiEngineAdapter` and the dialect helpers live here.
 */
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
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
  createJsonlSplitter,
  PRODUCT_IDENTITY,
  SessionCreateTemporarilyUnavailableError,
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
  bunSpawnResolvedInvocation,
  commandSemantic,
  fileReadSemantic,
  resolveInvocation,
  terminateHostProcessTree,
  searchGroup,
  searchSemantic,
  webSemantic,
} from '@cosyncing/adapter-api';
import {
  PI_DIALECT,
  type PiDialect,
  type PiEngineReadiness,
  type PiDialectRuntime,
} from './dialect.ts';

const CAPS: AgentCapabilities = {
  integrationKind: 'jsonrpc-stdio',
  attachModes: ['observe', 'resume', 'live'],
  supportsObserve: true,
  supportsResume: true,
  supportsLiveAttach: true, // per-session active only when the dialect's bridge extension has hello'd
  supportsCrossClientDriveSharing: true,
  supportsNativeArtifact: false,
  supportsNativeFileInput: true, // images in prompt
  supportsModelSwitch: true,
  permissionGranularity: 'per-tool',
};

export interface PiAdapterOptions {
  /** Broker URL the in-session bridge extension should call back to. */
  brokerUrl?: string;
  /** Packaged setup wrote the owner-only scoped integration file, so terminal commands need no URL env. */
  bridgeUsesIntegrationFile?: boolean;
}

export interface PiBridgeAssetInspection {
  status: 'missing' | 'owned' | 'legacy-marker' | 'unowned' | 'unsafe' | 'unreadable';
  expectedSha256: string;
  actualSha256?: string;
  path: string;
  requiresConfirmation: boolean;
}

interface PiBridgePathInspection {
  status: 'missing' | 'safe' | 'unsafe' | 'unreadable';
  stat?: ReturnType<typeof lstatSync>;
}

/** Inspect every path component without following symlinks or opening a non-regular leaf. */
function inspectPiBridgePath(path: string): PiBridgePathInspection {
  const absolute = resolve(path);
  const components: string[] = [];
  let cursor = absolute;
  while (true) {
    components.push(cursor);
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  components.reverse();

  try {
    for (const component of components) {
      let stat: ReturnType<typeof lstatSync>;
      try {
        stat = lstatSync(component);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'missing' };
        throw error;
      }
      if (stat.isSymbolicLink()) return { status: 'unsafe' };
      if (component === absolute) {
        return stat.isFile() ? { status: 'safe', stat } : { status: 'unsafe' };
      }
      if (!stat.isDirectory()) return { status: 'unsafe' };
    }
    return { status: 'missing' };
  } catch {
    return { status: 'unreadable' };
  }
}

/** Exact current content proves ownership; exact known legacy content may be offered for confirmed migration. */
export function inspectDialectBridgeAsset(rt: PiDialectRuntime, agentDir = rt.agentDir): PiBridgeAssetInspection {
  const path = join(agentDir, 'extensions', 'cosyncing-bridge', 'index.ts');
  const expected = rt.bridgeAsset;
  const preflight = inspectPiBridgePath(path);
  if (preflight.status === 'missing') {
    return { status: 'missing', expectedSha256: expected.sha256, path, requiresConfirmation: false };
  }
  if (preflight.status === 'unsafe') {
    return { status: 'unsafe', expectedSha256: expected.sha256, path, requiresConfirmation: true };
  }
  if (preflight.status === 'unreadable' || !preflight.stat) {
    return { status: 'unreadable', expectedSha256: expected.sha256, path, requiresConfirmation: true };
  }

  let fd: number | undefined;
  try {
    // O_NONBLOCK prevents a raced-in FIFO/device from blocking open. O_NOFOLLOW rejects a raced-in leaf symlink.
    fd = openSync(resolve(path), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile()) {
      return { status: 'unsafe', expectedSha256: expected.sha256, path, requiresConfirmation: true };
    }
    const rechecked = inspectPiBridgePath(path);
    if (rechecked.status === 'unsafe') {
      return { status: 'unsafe', expectedSha256: expected.sha256, path, requiresConfirmation: true };
    }
    if (rechecked.status !== 'safe' || !rechecked.stat
        || opened.dev !== rechecked.stat.dev || opened.ino !== rechecked.stat.ino) {
      return { status: 'unreadable', expectedSha256: expected.sha256, path, requiresConfirmation: true };
    }
    const content = readFileSync(fd, 'utf8');
    const actualSha256 = createHash('sha256').update(content).digest('hex');
    if (actualSha256 === expected.sha256) {
      return { status: 'owned', expectedSha256: expected.sha256, actualSha256, path, requiresConfirmation: false };
    }
    return {
      // A copied marker, an edited legacy bridge, or any other content is unowned. Setup/repair may replace
      // only the complete preceding packaged source after a separate operator confirmation.
      status: expected.legacySource !== undefined && content === expected.legacySource ? 'legacy-marker' : 'unowned',
      expectedSha256: expected.sha256,
      actualSha256,
      path,
      requiresConfirmation: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') {
      return { status: 'unsafe', expectedSha256: expected.sha256, path, requiresConfirmation: true };
    }
    return { status: 'unreadable', expectedSha256: expected.sha256, path, requiresConfirmation: true };
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* inspection remains fail-closed */ }
    }
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

/** `--workspace-tester-Projects-x--` → `/workspace/tester/Projects/x` (best-effort; dashes are lossy). */
function decodeCwdDir(dir: string): string | undefined {
  const m = dir.replace(/^--/, '').replace(/--$/, '');
  const guess = '/' + m.replace(/-/g, '/');
  return existsSync(guess) ? guess : undefined;
}

/**
 * The dialect-parameterized Pi engine adapter. Carries every AgentBackend hook EXCEPT
 * forkSession/cloneSession — a dialect without RPC lifecycle commands (omp) omits those hooks so
 * the broker derives canFork/canClone=false from hook presence.
 */
export class PiEngineAdapter implements AgentBackend {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities = CAPS;
  /** Native transcript export is HTML via RPC `export_html` (read generically by the broker R2 gate). */
  readonly transcriptExportFormat = 'html' as const;
  protected readonly rt: PiDialectRuntime;
  protected readonly brokerUrl: string;
  protected readonly bridgeUsesIntegrationFile: boolean;
  /** Runs the bridge auto-install at most once per adapter instance (historically per broker). */
  private bridgeEnsured = false;

  constructor(rt: PiDialectRuntime, opts: PiAdapterOptions = {}) {
    this.rt = rt;
    this.id = rt.dialect.toolId;
    this.displayName = rt.dialect.displayName;
    this.brokerUrl = (opts.brokerUrl ?? process.env.COSYNCING_BROKER ?? 'http://127.0.0.1:7734').replace(/\/$/, '');
    this.bridgeUsesIntegrationFile = opts.bridgeUsesIntegrationFile === true;
  }

  private terminalSyncCommand(file: string): string {
    return piTerminalSyncCommand(this.rt, file, this.brokerUrl, this.bridgeUsesIntegrationFile);
  }

  private ensureBridgeExtension(): void {
    if (this.bridgeEnsured) return;
    this.bridgeEnsured = true;
    ensurePiBridgeExtension(this.rt);
  }

  private sessionAccessBlock(): PiEngineReadiness | undefined {
    const readiness = this.rt.hooks.readiness();
    return !readiness.ready && readiness.blocksSessionAccess ? readiness : undefined;
  }

  private assertSessionAccess(): void {
    const blocked = this.sessionAccessBlock();
    if (blocked) throw new Error(blocked.message);
  }

  async isAvailable(): Promise<boolean> {
    if (this.sessionAccessBlock()) return false;
    return existsSync(this.rt.sessionsRoot) || resolveBin(this.rt) !== null;
  }

  async diagnoseSetup(context: SetupDiagnosisContext): Promise<AgentSetupDiagnosis> {
    return this.rt.hooks.diagnose(context, (agentDir) => inspectDialectBridgeAsset(this.rt, agentDir));
  }

  canCreateSession(): boolean {
    return this.rt.hooks.readiness().ready;
  }

  async prepareCreateSession(): Promise<void> {
    const readiness = this.rt.hooks.readiness();
    if (readiness.ready) return;
    throw new SessionCreateTemporarilyUnavailableError(
      readiness.message,
      readiness.detailCode,
    );
  }

  async listModels(): Promise<ModelOption[]> {
    await this.prepareCreateSession();
    const response = await createPiSessionViaRpc(this.rt, homedir(), {
      catalogOnly: true,
    });
    return (response.models ?? [])
      .slice(0, PI_MAX_MODEL_OPTIONS)
      .map((model) => piModelOption(model, response.thinkingLevel))
      .filter((model): model is ModelOption => !!model);
  }

  async createSession(opts: {
    directory?: string;
    title?: string;
    model?: PromptInput['model'];
  } = {}): Promise<SessionInfo> {
    await this.prepareCreateSession();
    const cwd = opts.directory?.trim() || homedir();
    if (!statSafe(cwd)?.isDirectory()) throw new Error(`${this.rt.dialect.displayName} createSession directory does not exist: ${cwd}`);

    const title = opts.title?.trim() || undefined;
    const state = await createPiSessionViaRpc(this.rt, cwd, {
      title,
      model: opts.model,
    });
    const file = typeof state.sessionFile === 'string' && state.sessionFile ? state.sessionFile : undefined;
    if (!file) throw new Error(`${this.rt.dialect.displayName} get_state did not return a durable session file after create.`);
    materializePiSessionFile(this.rt, file, cwd, String(state.sessionId ?? ''), title);
    const st = statSafe(file);
    const actualCwd = readSessionCwd(file) ?? cwd;
    const name = title ?? readSessionName(this.rt, file);
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
      control: piControlState(this.rt.dialect, {
        canDrive: true,
        driveState: 'observing',
        terminalSyncActive: false,
        terminalSyncCommand: this.terminalSyncCommand(file),
        extensionInstalled: piBridgeExtensionInstalled(this.rt),
      }),
    };
  }

  async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionInfo[]> {
    if (this.sessionAccessBlock()) return [];
    if (!existsSync(this.rt.sessionsRoot)) return [];
    this.ensureBridgeExtension(); // sync-on-by-default: bundled bridge auto-installed/refreshed once
    const out: SessionInfo[] = [];
    for (const full of piSessionFiles(this.rt.sessionsRoot)) {
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
      const surface = readSessionSurface(this.rt, full);
      const uuid = baseName(full).replace(/\.jsonl$/, '').split('_').pop() ?? baseName(full);
      out.push({
        id: sessionIdForFile(full),
        tool: this.id,
        title: readSessionName(this.rt, full) ?? `${cwd ? baseName(cwd) : baseDir(full)} · ${uuid.slice(0, 8)}`,
        cwd,
        // Pi has no live process to observe yet (resume-under-broker), so we can't know
        // working/needs-input from discovery — everything is 'idle' (available). Real-time
        // status arrives with the Pi extension bridge (Pi round). See the live-idle-status log.
        status: 'idle',
        attachMode: 'observe',
        model: surface.model,
        currentModel: surface.currentModel,
        control: piControlState(this.rt.dialect, {
          canDrive: resolveBin(this.rt) !== null,
          driveState: 'observing',
          terminalSyncActive: false,
          terminalSyncCommand: this.terminalSyncCommand(full),
          extensionInstalled: piBridgeExtensionInstalled(this.rt),
        }),
        updatedAt: st.mtimeMs,
      });
    }
    return out;
  }

  async attach(sessionId: string, mode: AttachMode = 'observe'): Promise<SessionConnection> {
    this.assertSessionAccess();
    const path = canonicalSessionFile(dec(sessionId));
    const cwd = readSessionCwd(path) ?? decodeCwdDir(baseDir(path)); // authoritative cwd from the file
    const canDrive = resolveBin(this.rt) !== null;
    const surface = readSessionSurface(this.rt, path);
    if (mode === 'live') {
      throw new Error(`${this.rt.dialect.displayName} true sync is not active for this session. Start the ${this.rt.dialect.displayName} bridge extension in the terminal session, then refresh.`);
    }
    const info: SessionInfo = {
      id: sessionId,
      tool: this.id,
      title: readSessionName(this.rt, path) ?? baseName(path),
      cwd,
      status: 'idle',
      attachMode: mode === 'resume' ? 'resume' : 'observe',
      model: surface.model,
      currentModel: surface.currentModel,
      control: piControlState(this.rt.dialect, {
        canDrive,
        driveState: mode === 'resume' ? 'driving' : 'observing',
        terminalSyncActive: false,
        terminalSyncCommand: this.terminalSyncCommand(path),
        extensionInstalled: piBridgeExtensionInstalled(this.rt),
      }),
    };
    if (mode !== 'resume') return new PiObserveConnection(this.rt, path, cwd, info);
    if (!canDrive) throw new Error(`${this.rt.dialect.displayName} CLI is not available on PATH, so ${PRODUCT_IDENTITY.productName} cannot Drive this session.`);
    const conn = new PiConnection(this.rt, path, cwd, info);
    await conn.start();
    return conn;
  }

  async renameSession(sessionId: string, title: string | null): Promise<SessionInfo> {
    this.assertSessionAccess();
    const path = canonicalSessionFile(dec(sessionId));
    const cwd = readSessionCwd(path) ?? decodeCwdDir(baseDir(path));
    const requested = title == null ? '' : title.trim().slice(0, 160);
    const state = await renamePiSessionViaRpc(this.rt, path, requested);
    const st = statSafe(path);
    const currentModel = piCurrentModelFromNative(state.model, state.thinkingLevel);
    const nativeTitle =
      (typeof state.sessionName === 'string' && state.sessionName.trim()) ||
      (requested || undefined) ||
      readSessionName(this.rt, path) ||
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
      control: piControlState(this.rt.dialect, {
        canDrive: resolveBin(this.rt) !== null,
        driveState: 'observing',
        terminalSyncActive: false,
        terminalSyncCommand: this.terminalSyncCommand(path),
        extensionInstalled: piBridgeExtensionInstalled(this.rt),
      }),
    };
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
    this.assertSessionAccess();
    const sessionFile = canonicalSessionFile(dec(sessionId));
    const outputPath = join(opts.tempDir, 'export.html');
    const returned = await runPiExportHtmlRpc(this.rt, sessionFile, outputPath, opts.timeoutMs);
    // Verify Pi wrote exactly our contained path — realpath both and compare (rule 8).
    let wantReal: string;
    try {
      wantReal = realpathSync(outputPath);
    } catch {
      throw new Error(`${this.rt.dialect.displayName} export_html did not write the requested contained file.`);
    }
    let gotReal: string;
    try {
      gotReal = realpathSync(returned);
    } catch {
      throw new Error(`${this.rt.dialect.displayName} export_html returned a missing path.`);
    }
    if (gotReal !== wantReal) throw new Error(`${this.rt.dialect.displayName} export_html wrote outside the contained temp path.`);
    return { path: outputPath, format: 'html' };
  }
}

/**
 * One fork/clone lifecycle round: resolve the session, run the dialect's lifecycle RPC, and build
 * the child SessionInfo from `get_state`. Only dialects with RPC lifecycle commands (pi) expose
 * this — an adapter subclass wires it to forkSession/cloneSession so the broker derives
 * canFork/canClone from hook presence.
 */
export async function runPiLifecycleAction(
  rt: PiDialectRuntime,
  sessionId: string,
  action: 'fork' | 'clone',
  opts: { messageId?: string | null; brokerUrl: string; bridgeUsesIntegrationFile: boolean },
): Promise<SessionInfo> {
  const path = canonicalSessionFile(dec(sessionId));
  const cwd = readSessionCwd(path) ?? decodeCwdDir(baseDir(path));
  const state = await runPiLifecycleRpc(rt, path, action, { messageId: opts.messageId });
  return piSessionInfoFromState(rt, state, path, cwd, rt.dialect.toolId, opts.brokerUrl, opts.bridgeUsesIntegrationFile, action);
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
  rt: PiDialectRuntime,
  cwd: string,
  options: PiCreateRpcOptions = {},
): Promise<PiRpcSessionState> {
  const bin = resolveBin(rt);
  if (!bin) throw new Error(`${rt.dialect.displayName} CLI is not available on PATH; cannot create a ${rt.dialect.displayName} session.`);
  const args = ['--mode', 'rpc'];
  const env = piProcessEnv(rt, { COSYNCING_NO_BRIDGE: '1' });
  if (rt.sessionsRootOverride) {
    args.push('--session-dir', rt.sessionsRootOverride);
    env.PI_CODING_AGENT_SESSION_DIR = rt.sessionsRootOverride;
  }
  const proc = spawnPi(rt.dialect, bin, args, {
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
        if (pending.delete(id)) resolve({ success: false, timeout: true, error: `${rt.dialect.displayName} RPC ${cmd.type} timed out` });
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
          catalog?.error ?? `${rt.dialect.displayName} get_available_models failed.`,
        );
      }
      // This zero-turn process uses the same configured initial thinking level as a subsequent
      // create. Carry that native default with the catalog instead of making the client guess.
      const state = await rpc({ type: 'get_state' }, 15000);
      return {
        models: Array.isArray(catalog?.data?.models)
          ? catalog.data.models.slice(0, PI_MAX_MODEL_OPTIONS)
          : [],
        thinkingLevel: state?.success === true
          ? normalizePiThinkingLevel(state?.data?.thinkingLevel)
          : undefined,
      };
    }
    let stateResp = await rpc({ type: 'get_state' }, 20000);
    if (stateResp?.success !== true) throw new Error(stateResp?.error ?? `${rt.dialect.displayName} get_state failed during create.`);
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
        throw new Error(modelResp?.error ?? `${rt.dialect.displayName} set_model failed during create.`);
      }
      const effort = normalizePiThinkingLevel(options.model.reasoningEffort);
      if (effort) {
        const effortResp = await rpc(
          { type: 'set_thinking_level', level: effort },
          15000,
        );
        if (effortResp?.success !== true) {
          throw new Error(
            effortResp?.error ?? `${rt.dialect.displayName} set_thinking_level failed during create.`,
          );
        }
      }
      stateResp = await rpc({ type: 'get_state' }, 15000);
      if (stateResp?.success !== true) {
        throw new Error(`${rt.dialect.displayName} get_state failed after selecting the model.`);
      }
    }
    if (options.title) {
      const titleResp = await rpc({ type: 'set_session_name', name: options.title }, 15000);
      if (titleResp?.success !== true) throw new Error(titleResp?.error ?? `${rt.dialect.displayName} set_session_name failed during create.`);
      stateResp = await rpc({ type: 'get_state' }, 15000);
      if (stateResp?.success !== true) throw new Error(stateResp?.error ?? `${rt.dialect.displayName} get_state failed after naming created session.`);
    }
    return stateResp.data ?? {};
  } catch (err) {
    const detail = stderr.trim().split('\n').slice(0, 3).join('\n');
    throw new Error(`${rt.dialect.displayName} createSession failed: ${err instanceof Error ? err.message : String(err)}${detail ? `\n${detail}` : ''}`);
  } finally {
    for (const resolve of pending.values()) resolve({ success: false, error: `${rt.dialect.displayName} createSession process closed.` });
    pending.clear();
    await endPiChild(proc);
    await Promise.race([Promise.allSettled([stdoutPump, stderrPump]), new Promise((r) => setTimeout(r, 1000))]);
  }
}

async function renamePiSessionViaRpc(rt: PiDialectRuntime, sessionFile: string, title: string): Promise<PiRpcSessionState> {
  const bin = resolveBin(rt);
  if (!bin) throw new Error(`${rt.dialect.displayName} CLI is not available on PATH; cannot rename a ${rt.dialect.displayName} session.`);
  const proc = spawnPi(rt.dialect, bin, ['--mode', 'rpc', '--session', sessionFile], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: readSessionCwd(sessionFile) ?? undefined,
    env: piProcessEnv(rt, { COSYNCING_NO_BRIDGE: '1' }),
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
        if (pending.delete(id)) resolve({ success: false, timeout: true, error: `${rt.dialect.displayName} RPC ${cmd.type} timed out` });
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
        resolve({ success: false, error: `${rt.dialect.displayName} RPC write failed` });
      }
    });
  };
  try {
    const titleResp = await rpc({ type: 'set_session_name', name: title }, 15000);
    if (titleResp?.success !== true) throw new Error(`${rt.dialect.displayName} set_session_name failed`);
    const stateResp = await rpc({ type: 'get_state' }, 15000);
    if (stateResp?.success !== true) throw new Error(`${rt.dialect.displayName} get_state failed after rename`);
    return stateResp.data ?? {};
  } catch {
    throw new Error(`${rt.dialect.displayName} rename failed`);
  } finally {
    for (const resolve of pending.values()) resolve({ success: false, error: `${rt.dialect.displayName} rename process closed.` });
    pending.clear();
    await endPiChild(proc);
    await Promise.race([Promise.allSettled([stdoutPump, stderrPump]), new Promise((r) => setTimeout(r, 1000))]);
  }
}

async function runPiLifecycleRpc(
  rt: PiDialectRuntime,
  sessionFile: string,
  action: 'fork' | 'clone',
  opts: { messageId?: string | null } = {},
): Promise<PiRpcSessionState> {
  const bin = resolveBin(rt);
  if (!bin) throw new Error(`${rt.dialect.displayName} CLI is not available on PATH; cannot ${action} a ${rt.dialect.displayName} session.`);
  const proc = spawnPi(rt.dialect, bin, ['--mode', 'rpc', '--session', sessionFile], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: readSessionCwd(sessionFile) ?? undefined,
    env: piProcessEnv(rt, { COSYNCING_NO_BRIDGE: '1' }),
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
        if (pending.delete(id)) resolve({ success: false, timeout: true, error: `${rt.dialect.displayName} RPC ${cmd.type} timed out` });
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
        resolve({ success: false, error: `${rt.dialect.displayName} RPC write failed` });
      }
    });
  };
  try {
    /**
     * Pi's fork RPC takes `entryId`, and it is REQUIRED: `fork(undefined)` throws
     * `Invalid entry ID for forking` before anything is copied. The field was previously sent as
     * `messageId`, which Pi silently ignores, so every fork — with or without a chosen message —
     * was refused on every platform. A native Windows trace is what surfaced it; the adapter's own
     * fixture had modelled the wrong field on both sides and agreed with itself.
     *
     * A BARE fork — no message chosen — has no fork RPC of its own. Pi's `clone` is exactly that
     * operation (it forks at the current leaf), so a bare fork issues it rather than sending an
     * incomplete `fork` Pi can only refuse.
     */
    const forkPoint = action === 'fork' && opts.messageId ? opts.messageId : undefined;
    const cmd: Record<string, unknown> = forkPoint ? { type: 'fork', entryId: forkPoint } : { type: 'clone' };
    const actionResp = await rpc(cmd, 15000);
    if (actionResp?.success !== true) throw new Error(piLifecycleFailure(rt.dialect, action, actionResp));
    // `success: true` is not the same as `it happened`: Pi reports an extension-cancelled fork as a
    // successful call carrying `cancelled`. Without this the adapter would read the UNCHANGED state
    // back and hand a client the source session dressed as its own copy.
    if (actionResp?.data?.cancelled === true) {
      throw new Error(`${rt.dialect.displayName} ${action} cancelled by native extension`);
    }
    /**
     * The child's identity comes from `get_state` and from NOWHERE else.
     *
     * Pi's own fork response carries `{text, cancelled}` and its clone response carries
     * `{cancelled}` — neither has ever carried a session file. So falling back to the action
     * response meant falling back to the SOURCE path, and handing a client the session it forked
     * FROM wearing the new session's name: every later prompt, rename and delete would land on the
     * original. A `get_state` that fails, times out, or names the source is refused here instead.
     */
    const stateResp = await rpc({ type: 'get_state' }, 15000);
    const state: PiRpcSessionState | undefined =
      stateResp?.success === true && stateResp.data ? stateResp.data : undefined;
    const childFile = typeof state?.sessionFile === 'string' ? state.sessionFile.trim() : '';
    if (!childFile) {
      throw new Error(
        `${rt.dialect.displayName} ${action} did not report the new session, so the original is being kept rather than returned as the copy.`,
      );
    }
    if (canonicalSessionFile(childFile) === canonicalSessionFile(sessionFile)) {
      throw new Error(
        `${rt.dialect.displayName} ${action} named the original session as its own result, so no copy was returned.`,
      );
    }
    return state!;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith(`${rt.dialect.displayName} `)) throw err;
    throw new Error(`${rt.dialect.displayName} ${action} failed`);
  } finally {
    for (const resolve of pending.values()) resolve({ success: false, error: `${rt.dialect.displayName} ${action} process closed.` });
    pending.clear();
    await endPiChild(proc);
    await Promise.race([Promise.allSettled([stdoutPump, stderrPump]), new Promise((r) => setTimeout(r, 1000))]);
  }
}

/**
 * Drive one `pi --mode rpc` process to export the session HTML to a broker-owned `outputPath`. Returns
 * the path Pi reports it wrote (verified against the requested contained path by the caller). Explicit
 * argv, no shell; structured RPC fields only (rule 9). The process is always torn down in `finally`.
 */
async function runPiExportHtmlRpc(rt: PiDialectRuntime, sessionFile: string, outputPath: string, timeoutMs: number): Promise<string> {
  const bin = resolveBin(rt);
  if (!bin) throw new Error(`${rt.dialect.displayName} CLI is not available on PATH; cannot export transcript.`);
  const proc = spawnPi(rt.dialect, bin, ['--mode', 'rpc', '--session', sessionFile], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: readSessionCwd(sessionFile) ?? undefined,
    env: piProcessEnv(rt, { COSYNCING_NO_BRIDGE: '1' }),
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
        if (pending.delete(id)) resolve({ success: false, timeout: true, error: `${rt.dialect.displayName} RPC ${cmd.type} timed out` });
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
        resolve({ success: false, error: `${rt.dialect.displayName} RPC write failed` });
      }
    });
  };
  try {
    const resp = await rpc({ type: 'export_html', outputPath });
    if (resp?.success !== true) {
      if (resp?.timeout) throw new Error(`${rt.dialect.displayName} export_html timed out`);
      throw new Error(`${rt.dialect.displayName} export_html failed`);
    }
    const written = resp?.data?.path ?? resp?.path;
    if (typeof written !== 'string' || !written) throw new Error(`${rt.dialect.displayName} export_html returned no path`);
    return written;
  } finally {
    for (const resolve of pending.values()) resolve({ success: false, error: `${rt.dialect.displayName} export process closed.` });
    pending.clear();
    await endPiChild(proc);
    await Promise.race([Promise.allSettled([stdoutPump, stderrPump]), new Promise((r) => setTimeout(r, 1000))]);
  }
}

function piLifecycleFailure(dialect: PiDialect, action: 'fork' | 'clone', resp: any): string {
  const raw = String(resp?.error ?? '');
  if (/cancel/i.test(raw)) return `${dialect.displayName} ${action} cancelled by native extension`;
  if (resp?.timeout) return `${dialect.displayName} ${action} timed out`;
  // Classified from a known phrase into text WE own. Pi's raw error is never echoed: it can quote
  // provider or filesystem detail, and the redaction rule here is older than this classification.
  if (/invalid entry id/i.test(raw)) {
    return `${dialect.displayName} ${action} failed: the chosen message is not a fork point in this session`;
  }
  return `${dialect.displayName} ${action} failed`;
}

function piSessionInfoFromState(
  rt: PiDialectRuntime,
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
    readSessionName(rt, file) ||
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
    control: piControlState(rt.dialect, {
      canDrive: resolveBin(rt) !== null,
      driveState: 'observing',
      terminalSyncActive: false,
      terminalSyncCommand: piTerminalSyncCommand(rt, file, brokerUrl, bridgeUsesIntegrationFile),
      extensionInstalled: piBridgeExtensionInstalled(rt),
    }),
  };
}

class PiConnection implements SessionConnection {
  private readonly handlers = new Set<AgentMessageHandler>();
  private proc: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;
  private reqId = 0;
  private readonly pendingRpc = new Map<string, (resp: any) => void>();
  /** Connection-wide prompt transaction tail. Broker clients have independent WebSocket queues,
   *  so the adapter must serialize native-state reconciliation, optimistic FIFO mutation, model
   *  override, and prompt acknowledgement across every caller sharing this PiConnection. */
  private promptDeliveryTail: Promise<void> = Promise.resolve();
  /** extension UI requests awaiting a user decision: requestId → method. */
  private readonly pendingUi = new Map<string, { method: string; options?: string[] }>();
  /** The exact permission/question-request frames still UNRESOLVED — replayed on attach via
   *  {@link getPending} so a client joining a blocked Pi session sees the box, not just the badge.
   *  Tracked centrally in {@link emit} and cleared on the matching *-resolved frame. (Issue G.) */
  private readonly pendingFrames = new Map<string, AgentMessage>();
  private streaming = false;
  /** A partial model switch could not be rolled back or reconciled. No later prompt may reach Pi
   *  until get_state succeeds and republishes the actual native selection. */
  private modelStateUncertain = false;
  /** Per-turn counter: Pi's message_update carries no message.id, so without this every turn's
   *  deltas share a constant key ('m:…') and the app collapses all turns into one growing bubble.
   *  Seeded from the session file's entry count at {@link start}: a reconnect constructs a fresh
   *  connection, and a counter restarting at 0 would key a NEW turn's deltas onto the OLDEST
   *  retained bubble a client still holds — the mid-transcript "text appears at the top" scramble.
   *  Entries grow with every turn, so the seed strictly exceeds every previously-issued number
   *  (the same rule the bridge extension applies at hello). */
  private turnSeq = 0;
  /** Tool-call arguments by callId, so a later tool_execution_end can recover the edited file's path
   *  (Pi's result event carries no args) for the canonical tool-result `path` chip. */
  private readonly toolArgs = new Map<string, any>();
  /** Per-prompt counter for the optimistic user-message key, so the app's keyed history-vs-live
   *  dedupe has a stable (non-random) key to work with — matching OpenCode's keyed user-messages.
   *  Seeded with {@link turnSeq} for the same reconnect-collision reason. */
  private userSeq = 0;
  /** Durable per-user-turn ordinal shared with the JSONL mapper and bridge (`u0`, `u1`, ...).
   *  Unlike the optimistic user bubble key, this is reproducible after reload even though Pi's
   *  live user message carries no native entry id. */
  private nextUserTurnOrdinal = 0;
  private lastUserMessageKey: string | undefined;
  /** Optimistic prompt keys not yet consumed by a user `message_start` — FIFO, because a queued
   *  steer/follow-up is consumed in send order. The durable summary ordinal is allocated only when
   *  the turn actually starts, so a rejected/dropped prompt cannot leave a reload-visible gap. */
  private readonly pendingUserTurns: string[] = [];
  /** When the current RUN began: stamped at agent_start. Only the FALLBACK turn anchor (a
   *  degraded stream that never forwards `message_start`) consumes it; the authoritative
   *  anchor is the opening user message itself, matching the JSONL mapper. */
  private runStartedAt: number | undefined;
  /** The OPEN user turn — one summary per USER TURN, the same authority model as
   *  {@link mapPiMessages}: a user message entering the conversation closes the previous
   *  turn and opens its own; a terminal stopReason closes immediately; agent_end closes
   *  whatever remains. One summary per RUN diverged from every reload of the JSONL file
   *  as soon as a run batched queued steer/follow-up turns. */
  private currentRun:
    | {
        key: string;
        turnId: string;
        userMessageKey?: string;
        startedAt?: number;
        /** Any assistant streaming reached this turn — distinguishes a degraded stream that
         *  never forwards message_end (close at run end) from a prompt the agent truly never
         *  answered (suppress, as the mapper does). */
        sawAssistantActivity?: boolean;
        lastAssistant?: { stopReason?: string; errored: boolean; completedAt?: number };
        tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number };
      }
    | undefined;

  constructor(
    private readonly rt: PiDialectRuntime,
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
    // those itself); fall back to the bare binary name for PATH lookup elsewhere.
    const bin = resolveBin(this.rt) ?? this.rt.dialect.bin;
    this.proc = spawnPi(this.rt.dialect, bin, ['--mode', 'rpc', '--session', this.sessionPath], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: this.cwd && existsSync(this.cwd) ? this.cwd : undefined,
      // COSYNCING_NO_BRIDGE: this pi is broker-owned (resume-under-broker). The global bridge extension
      // auto-loads in EVERY pi; without this flag a broker-spawned pi would itself try to bridge back
      // to the broker (a loop / double-owner). The flag tells the extension to stay dormant here.
      env: piProcessEnv(this.rt, { COSYNCING_NO_BRIDGE: '1' }),
    });
    // Seed the live key namespaces above every entry already in this session,
    // so a reconnect's fresh counters can never re-issue a key an earlier
    // connection's turns already own (see the field docs).
    try {
      const raw = readFileSync(this.sessionPath, 'utf8');
      this.turnSeq = countJsonlLines(raw);
      this.userSeq = this.turnSeq;
      this.nextUserTurnOrdinal = countPiJsonlUserMessages(raw);
    } catch {
      /* a fresh session file may not exist yet — counters stay at 0 */
    }
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

  /** Close the open user turn with the JSONL mapper's exact rule set: status from the last
   *  assistant's terminal stopReason (error > cancelled > done), completion clock only from
   *  assistant-end evidence (or the supplied run-end clock), duration only when both clocks
   *  exist and agree, and NO summary at all for a prompt the agent never answered — the same
   *  hollow-summary guard `mapPiMessages` applies, so live and reload agree turn for turn. */
  private closeCurrentRun(fallbackCompletedAt?: number): void {
    const run = this.currentRun;
    if (!run) return;
    this.currentRun = undefined;
    let last = run.lastAssistant;
    // A degraded RPC stream may expose deltas but omit message_end. Keep the same fallback the
    // bridge applies: assistant activity is enough for a summary, but not enough to invent an end
    // clock unless agent_end supplied one. A prompt with no assistant evidence is still suppressed.
    if (!last && run.sawAssistantActivity) last = { errored: false, completedAt: undefined };
    if (!last) return;
    const terminal = piTerminalStopReason(last.stopReason);
    const completedAt = last.completedAt ?? fallbackCompletedAt;
    const totalRuntimeMs =
      run.startedAt != null && completedAt != null && completedAt >= run.startedAt
        ? completedAt - run.startedAt
        : undefined;
    this.emit({
      type: 'run-summary',
      key: run.key,
      turnId: run.turnId,
      userMessageKey: run.userMessageKey,
      status: last.errored ? 'error' : (terminal ?? 'done'),
      ...(run.startedAt != null ? { startedAt: run.startedAt } : {}),
      ...(completedAt != null ? { completedAt } : {}),
      ...(totalRuntimeMs != null ? { totalRuntimeMs } : {}),
      ...(run.tokens ? { tokens: run.tokens } : {}),
      source: this.rt.dialect.eventSources.rpc,
    });
  }

  /** Degraded RPC fallback: Pi normally emits turn_start BEFORE the user message_start, so
   *  turn_start itself must never mint a summary. If a runtime omits the user event entirely,
   *  the first assistant event opens the turn here using the run clock and queued prompt link. */
  private ensureCurrentRun(): void {
    if (this.currentRun) return;
    const anchor = `u${this.nextUserTurnOrdinal++}`;
    this.currentRun = {
      key: `${this.rt.dialect.eventKeyNamespace}${anchor}`,
      turnId: anchor,
      userMessageKey: this.pendingUserTurns.shift() ?? this.lastUserMessageKey,
      startedAt: this.runStartedAt ?? Date.now(),
    };
    this.emit({ type: 'run-summary', ...this.currentRun, status: 'running', source: this.rt.dialect.eventSources.rpc });
  }

  /** Remove one prompt that never reached Pi's agent loop without disturbing older/newer queued
   *  prompts. A blanket shift/pop is wrong when several steers are pending: the later successful
   *  message_start must still consume its own optimistic bubble key. */
  private removePendingUserTurn(userKey: string): void {
    const index = this.pendingUserTurns.indexOf(userKey);
    if (index !== -1) this.pendingUserTurns.splice(index, 1);
  }

  private handleEvent(ev: any): void {
    switch (ev.type) {
      case 'agent_start':
        this.streaming = true;
        // The run's start clock — consumed only by the FALLBACK turn anchor below; the
        // authoritative anchor is the opening user message itself (message_start).
        this.runStartedAt = nativeTimeMs(ev.timestamp) ?? Date.now();
        this.emit({ type: 'status', status: 'running' });
        return;
      case 'message_start': {
        // A user message ENTERING the conversation — typed prompt or queued steer/follow-up
        // consumed mid-run — is the user-turn boundary, exactly as its JSONL entry is for
        // mapPiMessages: it closes the previous turn and opens its own. Grouping summaries per
        // RUN instead left one summary spanning every queued turn, so count, keys, timing and
        // token grouping all changed on the first reload of the session file.
        const m = ev.message;
        if (m?.role !== 'user') return;
        this.closeCurrentRun();
        const userKey = this.pendingUserTurns.shift();
        const anchor = `u${this.nextUserTurnOrdinal++}`;
        this.currentRun = {
          key: `${this.rt.dialect.eventKeyNamespace}${anchor}`,
          turnId: anchor,
          userMessageKey: userKey,
          // The message's own clock is the turn's start — the durable record of the same
          // instant the JSONL entry carries, so live and reload agree.
          startedAt: nativeTimeMs(m.timestamp) ?? nativeTimeMs(ev.timestamp) ?? Date.now(),
        };
        this.emit({ type: 'run-summary', ...this.currentRun, status: 'running', source: this.rt.dialect.eventSources.rpc });
        return;
      }
      case 'turn_start':
        // Advance the key namespace PER LLM TURN, not per agent RUN. agent_start fires once per run,
        // but a run can batch many turns (queued steer/follow-up) — incrementing on agent_start kept
        // the key constant so every reply's deltas collided and merged into one bubble (the same bug
        // the bridge fixed). turn_start IS forwarded over RPC stdout. See the bridge extension.
        this.turnSeq++;
        // The installed Pi loop emits this BEFORE the user message_start. Opening a fallback here
        // minted an orphan running summary, then message_start opened the real ordinal one. Wait
        // for that user event; a degraded stream falls back at its first assistant event instead.
        return;
      case 'message_end': {
        // The assistant message's END clock is the live analog of the JSONL entry's write
        // time — the only authoritative completion evidence. A terminal stopReason closes
        // the turn HERE, as the mapper closes on the entry, so a queued follow-up's next
        // turn never inherits the previous turn's span or usage.
        const m = ev.message;
        if (m?.role !== 'assistant') return;
        this.ensureCurrentRun();
        const currentRun = this.currentRun!;
        currentRun.lastAssistant = {
          stopReason: typeof m.stopReason === 'string' ? m.stopReason : undefined,
          errored: !!m.error,
          completedAt: nativeTimeMs(ev.timestamp) ?? Date.now(),
        };
        accumulatePiUsage(currentRun, m.usage);
        if (piTerminalStopReason(m.stopReason) !== undefined || m.error) this.closeCurrentRun();
        return;
      }
      case 'agent_end':
        this.streaming = false;
        this.toolArgs.clear(); // turn boundary — drop args of any tool-call whose result never arrived (abort/block)
        this.runStartedAt = undefined;
        this.pendingUserTurns.length = 0; // unconsumed queue entries died with the run
        // Whatever is still open closes at the run's end clock. A degraded stream that
        // streamed assistant output but forwards no message_end still gets its summary; a
        // prompt the agent truly never answered is suppressed, exactly as the mapper does.
        this.closeCurrentRun(nativeTimeMs(ev.timestamp) ?? Date.now());
        this.emit({ type: 'status', status: 'idle' });
        void this.emitSessionStats();
        return;
      case 'message_update': {
        const e = ev.assistantMessageEvent ?? {};
        this.ensureCurrentRun();
        this.currentRun!.sawAssistantActivity = true;
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
          // Deliberately no `options`: a confirm is a one-shot yes/no with no session scope to
          // grant, so the client's approve/reject default is the whole vocabulary here (the
          // bridged tool-approval card in bridge.ts is the path that advertises approve-session).
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
    // Prefer the session FILE: it is the durable causal record. Its entry ids
    // key every row identically to Observe and across reloads (get_messages
    // returns bare messages, which forced positional h<n> keys that re-key the
    // whole transcript on every mode switch), and its entry envelopes carry
    // write-time clocks — the only authoritative completion evidence a
    // history read has. RPC state remains the fallback for a file that cannot
    // be read; its summaries then carry no completion clock rather than one
    // inferred from adjacent message timestamps.
    try {
      const raw = readFileSync(this.sessionPath, 'utf8');
      if (raw.trim()) {
        const history = mapPiJsonlText(raw, 0, this.rt.dialect);
        // A file with no message entries yet (a fresh session header, or a runtime
        // that has not flushed) proves nothing — let RPC state answer instead.
        if (history.length > 0) {
          history.push(...await this.sessionStatsMessages());
          return history;
        }
      }
    } catch {
      /* unreadable session file → RPC fallback below */
    }
    const resp = await this.rpc({ type: 'get_messages' });
    const msgs: any[] = resp?.data?.messages ?? [];
    // First pass: collect tool-call args by id so a toolResult further down can recover its file path
    // (the path lives on the originating tool call, not the result) — mirrors the live toolArgs cache.
    const argsByCallId = new Map<string, any>();
    for (const m of msgs)
      if (m?.role === 'assistant' && Array.isArray(m.content))
        for (const c of m.content) if (c?.type === 'toolCall' && c.id != null) argsByCallId.set(String(c.id), c.arguments);
    const history = mapPiMessages(
      msgs.map((message, index) => ({
        message,
        index,
        keyBase: message?.id != null ? String(message.id) : `h${index}`,
        messageAt: nativeTimeMs(message?.timestamp),
      })),
      argsByCallId,
      true,
      undefined,
      this.rt.dialect,
    );
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

  /** Make the broker's advertised selection match one acknowledged native Pi state. */
  private publishNativeModelState(state: any): boolean {
    const currentModel = piCurrentModelFromNative(state?.model, state?.thinkingLevel);
    if (!currentModel) return false;
    this.modelStateUncertain = false;
    this.info.currentModel = currentModel;
    const label = state?.model?.name ?? state?.model?.label ?? state?.model?.id ?? state?.model?.modelID;
    if (typeof label === 'string' && label) this.info.model = label;
    this.emit({
      type: 'metadata-update',
      key: 'sessionInfo',
      value: { currentModel, ...(this.info.model ? { model: this.info.model } : {}) },
    });
    return true;
  }

  /** Gate prompt delivery after an unreconciled partial switch. Recovery happens before the
   *  optimistic bubble/FIFO entry is created, so a refused retry cannot poison turn identity. */
  private async ensureNativeModelStateKnown(): Promise<void> {
    if (!this.modelStateUncertain) return;
    const actualResp = await this.rpc({ type: 'get_state' });
    if (actualResp?.success === true && this.publishNativeModelState(actualResp.data)) return;
    const detail = actualResp?.error ?? `${this.rt.dialect.displayName} get_state did not return a valid model selection.`;
    throw new Error(`${this.rt.dialect.displayName} model state is uncertain; prompt delivery is blocked: ${detail}`);
  }

  /** A thinking-level rejection happens after Pi has already accepted set_model. Restore both
   *  pieces of the previous native selection. If either rollback command is rejected/ambiguous,
   *  read Pi's actual state and advertise that instead of guessing which mutation took effect. */
  private async restoreNativeModelState(previousState: any): Promise<void> {
    const previousModel = piCurrentModelFromNative(previousState?.model, previousState?.thinkingLevel);
    if (!previousModel) throw new Error(`${this.rt.dialect.displayName} model rollback has no valid previous model.`);
    const modelResp = await this.rpc({
      type: 'set_model',
      provider: previousModel.providerID,
      modelId: previousModel.modelID,
    });
    const previousEffort = normalizePiThinkingLevel(previousState?.thinkingLevel ?? previousModel.reasoningEffort);
    if (!previousEffort) throw new Error(`${this.rt.dialect.displayName} model rollback has no valid previous thinking level.`);
    const effortResp = await this.rpc({ type: 'set_thinking_level', level: previousEffort });
    if (modelResp?.success === true && effortResp?.success === true) {
      this.publishNativeModelState(previousState);
      return;
    }

    this.modelStateUncertain = true;
    const actualResp = await this.rpc({ type: 'get_state' });
    if (actualResp?.success === true && this.publishNativeModelState(actualResp.data)) return;
    throw new Error(actualResp?.error ?? `${this.rt.dialect.displayName} get_state failed after model rollback failed.`);
  }

  private async applyModelOverride(model: PromptInput['model'] | undefined): Promise<void> {
    if (!model?.modelID) return;
    const effort = normalizePiThinkingLevel(model.reasoningEffort);
    // Snapshot native state, not merely `info`, because set_model and set_thinking_level are two
    // separate mutations and the second can fail after the first has already taken effect.
    const previousResp = await this.rpc({ type: 'get_state' });
    const previousModel = piCurrentModelFromNative(
      previousResp?.data?.model,
      previousResp?.data?.thinkingLevel,
    );
    if (previousResp?.success !== true || !previousModel) {
      throw new Error(previousResp?.error ?? `${this.rt.dialect.displayName} get_state failed before model override.`);
    }
    if (
      effort
      && !normalizePiThinkingLevel(previousResp.data?.thinkingLevel ?? previousModel.reasoningEffort)
    ) {
      throw new Error(`${this.rt.dialect.displayName} get_state returned no rollback-safe thinking level.`);
    }
    const modelResp = await this.rpc({ type: 'set_model', provider: model.providerID, modelId: model.modelID });
    if (modelResp?.success !== true) {
      throw new Error(modelResp?.error ?? `${this.rt.dialect.displayName} set_model failed.`);
    }
    if (effort) {
      const effortResp = await this.rpc({ type: 'set_thinking_level', level: effort });
      if (effortResp?.success !== true) {
        const failure = effortResp?.error ?? `${this.rt.dialect.displayName} set_thinking_level failed.`;
        // Native Pi may already be on the requested model. Block concurrent/later delivery until
        // rollback or reconciliation below establishes and publishes one authoritative selection.
        this.modelStateUncertain = true;
        try {
          await this.restoreNativeModelState(previousResp.data);
        } catch (rollbackError) {
          const rollbackDetail = rollbackError instanceof Error
            ? rollbackError.message
            : String(rollbackError);
          throw new Error(`${failure} ${rollbackDetail}`);
        }
        throw new Error(failure);
      }
    }
    // Publish the requested selection only after every required Pi mutation is acknowledged.
    // A partial/failed switch must neither masquerade as active nor allow its prompt to run.
    this.info.currentModel = piCurrentModelFromNative(modelResp?.data, effort) ?? {
      providerID: model.providerID,
      modelID: model.modelID,
      ...(effort ? { reasoningEffort: effort } : {}),
    };
  }

  private serializePromptDelivery(operation: () => Promise<void>): Promise<void> {
    const result = this.promptDeliveryTail.then(operation);
    // Keep the tail fulfilled even when one prompt is rejected, or every later prompt would inherit
    // the rejection without entering its own critical section.
    this.promptDeliveryTail = result.catch(() => {});
    return result;
  }

  async sendPrompt(input: PromptInput): Promise<void> {
    return this.serializePromptDelivery(() => this.sendPromptCritical(input));
  }

  private async sendPromptCritical(input: PromptInput): Promise<void> {
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
    // A previous partial model switch may have left native Pi on an unknown selection. Reconcile
    // before creating the optimistic bubble; if state is still unavailable, this prompt is refused.
    await this.ensureNativeModelStateKnown();
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
    // Consumed FIFO by the user message_start this prompt produces — queued steers are
    // delivered in send order, and each turn's summary must link to ITS echo bubble.
    this.pendingUserTurns.push(userKey);
    this.emit({ type: 'user-message', text, key: userKey, turnId: userKey, sentAt, ...(input.clientMessageId ? { clientKey: input.clientMessageId } : {}) });
    // Per-prompt model override happens before prompt delivery. If it fails, this optimistic key
    // has no future message_start and must leave the FIFO now or it will be assigned to the next
    // successful prompt's summary.
    try {
      await this.applyModelOverride(input.model);
    } catch (error) {
      this.removePendingUserTurn(userKey);
      throw error;
    }
    const images = (input.images ?? []).map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType }));
    const cmd: Record<string, unknown> = { type: 'prompt', message: text };
    if (images.length) cmd.images = images;
    if (this.streaming) cmd.streamingBehavior = 'steer';
    const resp = await this.rpc(cmd);
    if (resp && resp.success === false && !resp.timeout) {
      // An explicit rejection proves Pi did not accept this prompt. A timeout is deliberately
      // different: delivery is ambiguous, so retain the key for a possible later message_start.
      this.removePendingUserTurn(userKey);
      throw new Error(resp.error ?? `${this.rt.dialect.toolId} prompt rejected`);
    }
  }

  /** Universal file delivery (same as OpenCode): a bare upload is a prompt carrying one attachment. */
  async sendFile(file: FileInput): Promise<void> {
    await this.sendPrompt({ text: '', files: [file] });
  }

  /** Write an uploaded file into `<cwd>/.cosyncing/inbox`, uniquifying on collision; returns the
   *  ABSOLUTE path written (relative refs get mis-resolved by models), or null if no cwd / failure. */
  private writeInboxFile(file: FileInput): string {
    if (!this.cwd) throw new Error(`${this.rt.dialect.displayName} attachment delivery requires a workspace.`);
    const inbox = resolve(this.cwd, PRODUCT_IDENTITY.repositoryDirectoryName, 'inbox');
    if (file.brokerPath) {
      const brokerPath = resolve(file.brokerPath);
      if (dirname(brokerPath) !== inbox || !existsSync(brokerPath)) {
        throw new Error(`${this.rt.dialect.displayName} rejected an untrusted broker attachment path.`);
      }
      return brokerPath;
    }
    if (typeof file.data !== 'string') {
      throw new Error(`${this.rt.dialect.displayName} attachment bytes are missing.`);
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
      throw new Error(`${this.rt.dialect.displayName} could not materialize attachment ${file.name}: ${String(error)}`);
    }
  }

  async respondPermission(requestId: string, decision: PermissionDecision): Promise<void> {
    if (decision === 'approve-rule') {
      throw new Error(`${this.rt.dialect.displayName} does not support persistent approval rules through this connection`);
    }
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

  /** Built-in RPC actions + the tool's OWN commands (prompt templates, skills, extension commands)
   *  from the dialect's get-commands RPC (`get_commands` on pi, `get_available_commands` on omp) —
   *  these are exactly the slash commands the user defined; previously NONE were reachable (we
   *  surfaced only 'stop'), which is why Pi looked far thinner than OpenCode. */
  async listCommands(): Promise<SlashCommand[]> {
    const builtins: SlashCommand[] = [
      { name: 'stop', description: 'Stop the running turn', kind: 'action' },
      { name: 'compact', description: 'Compact / summarize the conversation', kind: 'action' },
    ];
    let dynamic: SlashCommand[] = [];
    try {
      const resp = await this.rpc({ type: this.rt.dialect.rpcAliases.getCommands });
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
    if (resp && resp.success === false && !resp.timeout) throw new Error(resp.error ?? `${this.rt.dialect.toolId} command /${name} rejected`);
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
    // Not `kill()`: on Windows that would leave the Pi this connection started running forever.
    if (this.proc) await endPiChild(this.proc);
  }
}

class PiObserveConnection implements SessionConnection {
  private readonly handlers = new Set<AgentMessageHandler>();
  private watcher?: FSWatcher;
  private offset = 0;
  private lineIndex = 0;
  private tailBuffer = '';
  private primed = false;
  /** Open-turn evidence threaded across tail windows, so a turn whose prompt
   *  arrived in one read and whose final entry arrives in a later one closes
   *  with the SAME summary a whole-file reload computes. */
  private turnCarry: PiJsonlTurnCarry = {};

  constructor(
    private readonly rt: PiDialectRuntime,
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
    this.turnCarry = {};
    this.startWatch();
    return mapPiJsonlLines(raw.split('\n'), 0, true, this.turnCarry, this.rt.dialect);
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
      this.turnCarry = {};
      this.emit({ type: 'history-reset' });
    }
    if (buf.length <= this.offset) return;
    const chunk = buf.subarray(this.offset).toString('utf8');
    this.offset = buf.length;
    this.tailBuffer += chunk;
    const lines = this.tailBuffer.split('\n');
    this.tailBuffer = lines.pop() ?? '';
    if (!lines.length) return;
    const messages = mapPiJsonlLines(lines, this.lineIndex, false, this.turnCarry, this.rt.dialect);
    this.lineIndex += lines.length;
    for (const m of messages) this.emit(m);
  }

  async sendPrompt(): Promise<void> {
    throw new Error(`This ${this.rt.dialect.displayName} session is read-only in Observe mode. Tap Drive to take over before sending prompts.`);
  }

  async respondPermission(): Promise<void> {
    throw new Error(`This ${this.rt.dialect.displayName} session is read-only in Observe mode. Tap Drive to respond from ${PRODUCT_IDENTITY.productName}.`);
  }

  async answerQuestion(): Promise<void> {
    throw new Error(`This ${this.rt.dialect.displayName} session is read-only in Observe mode. Tap Drive to answer from ${PRODUCT_IDENTITY.productName}.`);
  }

  async rejectQuestion(): Promise<void> {
    throw new Error(`This ${this.rt.dialect.displayName} session is read-only in Observe mode. Tap Drive to answer from ${PRODUCT_IDENTITY.productName}.`);
  }

  async sendFile(): Promise<void> {
    throw new Error(`This ${this.rt.dialect.displayName} session is read-only in Observe mode. Tap Drive to upload files.`);
  }

  async listCommands(): Promise<SlashCommand[]> {
    return [];
  }

  async runCommand(): Promise<CommandResult | void> {
    throw new Error(`This ${this.rt.dialect.displayName} session is read-only in Observe mode. Tap Drive to run commands.`);
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

export function mapPiJsonlText(raw: string, firstIndex = 0, dialect: PiDialect = PI_DIALECT): AgentMessage[] {
  return mapPiJsonlLines(raw.split('\n'), firstIndex, true, undefined, dialect);
}

/**
 * The turn a mapped window left OPEN, carried into the next window.
 *
 * The observe tail maps the session file in arbitrary append chunks. A turn's
 * evidence routinely spans chunks — the prompt arrives in one read, the final
 * assistant entry in a later one — and a stateless mapper could then never
 * compute the same run summary a whole-file read does. The connection threads
 * this accumulator through consecutive windows, so a turn closed by a later
 * chunk carries the exact start evidence its opening chunk recorded, and the
 * live view converges with a reload instead of trailing it.
 */
export interface PiJsonlTurnCarry {
  open?: PiOpenTurn;
  /** User-turn ordinal for the next prompt in a later append window. This makes an incremental
   *  observe tail mint the same summary identity as a fresh whole-file reload. */
  nextUserOrdinal?: number;
}

type PiOpenTurn = {
  /** Reload-stable summary identity. Pi's live user events expose no JSONL entry id, so all three
   *  paths use the user's durable transcript ordinal instead (`u0`, `u1`, ...). */
  summaryAnchor?: string;
  /** Opening durable user entry key — links the summary to the reloaded user bubble. */
  userKey?: string;
  /** The opening prompt's own timestamp: the turn's authoritative start. */
  startedAt?: number;
  /** Newest assistant entry seen for the turn, with its completion evidence. */
  lastAssistant?: {
    keyBase: string;
    stopReason?: string;
    errored: boolean;
    /** Entry write time — present only when the source records it (JSONL). */
    completedAt?: number;
    textKey?: string;
  };
  tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number };
};

function mapPiJsonlLines(
  lines: string[],
  firstIndex = 0,
  includeTotals = false,
  carry?: PiJsonlTurnCarry,
  dialect: PiDialect = PI_DIALECT,
): AgentMessage[] {
  const entries: { message: any; index: number; keyBase: string; entryAt?: number; messageAt?: number }[] = [];
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
    entries.push({
      message,
      index,
      keyBase,
      entryAt: nativeTimeMs(obj.timestamp),
      messageAt: nativeTimeMs(message.timestamp),
    });
  });
  const argsByCallId = new Map<string, any>();
  for (const e of entries) {
    const m = e.message;
    if (m?.role === 'assistant' && Array.isArray(m.content)) {
      for (const c of m.content) if (c?.type === 'toolCall' && c.id != null) argsByCallId.set(String(c.id), c.arguments);
    }
  }
  return mapPiMessages(entries, argsByCallId, includeTotals, carry, dialect);
}

/** Pi's terminal stop reasons. `toolUse` means the run continues; absence proves nothing. */
function piTerminalStopReason(stopReason: unknown): 'done' | 'cancelled' | 'error' | undefined {
  if (stopReason === 'stop') return 'done';
  if (stopReason === 'aborted') return 'cancelled';
  if (stopReason === 'error') return 'error';
  return undefined;
}

function accumulatePiUsage(
  into: { tokens?: PiOpenTurn['tokens'] },
  usage: any,
): void {
  const tokens = piUsageTokens(usage);
  if (!tokens) return;
  const sum = into.tokens ?? {};
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite', 'cost'] as const) {
    const value = tokens[field];
    if (typeof value === 'number' && Number.isFinite(value)) {
      sum[field] = (sum[field] ?? 0) + value;
    }
  }
  into.tokens = sum;
}

/**
 * One run summary per USER TURN, from evidence only.
 *
 * The retired per-assistant-entry summaries fabricated both halves of the
 * footer: every entry present in a snapshot was stamped `done` — a reload
 * mid-turn showed a completed "Ran for …" for a run still going — and its
 * duration was inferred from the ADJACENT user message's timestamp against the
 * entry's own, which measures neither the run nor the message (an assistant
 * entry's embedded timestamp is its request-creation time and routinely EQUALS
 * the preceding entry's). The rules here:
 *
 *  - `startedAt` is the opening prompt entry's own timestamp — the durable
 *    record of the same instant the live `turn_start`/`agent_start` events
 *    stamp, so live and reload agree.
 *  - `completedAt` is the final assistant ENTRY's write time. Only the JSONL
 *    entry envelope records it; a source without it (RPC `get_messages`)
 *    yields a summary with no completion clock and no duration, never an
 *    inferred one.
 *  - A turn is CLOSED only with evidence: a terminal stopReason
 *    (`stop`/`aborted`/`error`), or a later user entry proving the run ended.
 *    Anything else — a trailing `toolUse`, a bare prompt, a window that ends
 *    mid-run — stays `running`, which the client renders without a footer.
 *  - Missing or contradictory clocks omit the duration rather than guess.
 */
function mapPiMessages(
  entries: { message: any; index: number; keyBase: string; entryAt?: number; messageAt?: number }[],
  argsByCallId: Map<string, any>,
  includeTotals: boolean,
  carry?: PiJsonlTurnCarry,
  dialect: PiDialect = PI_DIALECT,
): AgentMessage[] {
  const out: AgentMessage[] = [];
  const summaries: AgentMessage[] = [];
  let open: PiOpenTurn | undefined = carry?.open;
  let nextUserOrdinal = carry?.nextUserOrdinal ?? 0;

  const summarize = (turn: PiOpenTurn, closed: boolean): AgentMessage | undefined => {
    const last = turn.lastAssistant;
    if (!turn.userKey && !last) return undefined;
    // A prompt the agent never answered before the next one carries no run
    // evidence at all — summarizing it as completed would mint one hollow
    // "done" footer per prompt. Only the trailing OPEN turn may stand on the
    // prompt alone (as `running`, which renders no footer).
    if (closed && !last) return undefined;
    const anchor = turn.summaryAnchor ?? turn.userKey ?? last!.keyBase;
    const terminal = last ? piTerminalStopReason(last.stopReason) : undefined;
    const status = !closed
      ? 'running'
      : last?.errored
        ? 'error'
        : (terminal ?? 'done');
    const startedAt = turn.startedAt;
    const completedAt = closed ? last?.completedAt : undefined;
    const totalRuntimeMs = closed
      && startedAt != null
      && completedAt != null
      && completedAt >= startedAt
      ? completedAt - startedAt
      : undefined;
    return {
      type: 'run-summary',
      key: `${dialect.eventKeyNamespace}${anchor}`,
      turnId: anchor,
      userMessageKey: turn.userKey,
      assistantMessageKey: last?.textKey,
      status,
      ...(startedAt != null ? { startedAt } : {}),
      ...(completedAt != null ? { completedAt } : {}),
      ...(totalRuntimeMs != null ? { totalRuntimeMs } : {}),
      ...(turn.tokens ? { tokens: turn.tokens } : {}),
      source: dialect.eventSources.jsonl,
    };
  };

  const close = (turn: PiOpenTurn | undefined, closed: boolean): void => {
    if (!turn) return;
    const summary = summarize(turn, closed);
    if (!summary) return;
    out.push(summary);
    summaries.push(summary);
  };

  for (const e of entries) {
    out.push(...mapPiMessage(e.message, e.index, argsByCallId, e.keyBase, e.entryAt ?? e.messageAt));
    if (e.message?.role === 'user') {
      // A later prompt proves the previous run ended even without a terminal
      // stopReason (an abort can leave none behind).
      close(open, true);
      open = {
        summaryAnchor: `u${nextUserOrdinal++}`,
        userKey: e.keyBase,
        startedAt: e.messageAt ?? e.entryAt,
      };
    } else if (e.message?.role === 'assistant') {
      open ??= {};
      open.lastAssistant = {
        keyBase: e.keyBase,
        stopReason: typeof e.message.stopReason === 'string' ? e.message.stopReason : undefined,
        errored: !!e.message.error,
        completedAt: e.entryAt,
        textKey: firstPiAssistantTextKey(e.message, e.keyBase),
      };
      accumulatePiUsage(open, e.message.usage);
      // Terminal evidence closes the turn immediately; the next user entry
      // opens its own.
      const terminal = piTerminalStopReason(open.lastAssistant.stopReason) !== undefined
        || open.lastAssistant.errored;
      if (terminal) {
        close(open, true);
        open = undefined;
      }
    }
  }
  if (carry) {
    // The window ended mid-turn: hand the open evidence to the next window and
    // report the turn as running, so nothing fabricates a completion.
    carry.open = open;
    carry.nextUserOrdinal = nextUserOrdinal;
    close(open, false);
  } else {
    close(open, false);
  }
  const totals = includeTotals ? runtimeTotalsFromRunSummaries(summaries, dialect.toolId) : undefined;
  if (totals) out.push(totals);
  return out;
}

function countJsonlLines(raw: string): number {
  if (!raw) return 0;
  const parts = raw.split('\n');
  return raw.endsWith('\n') ? parts.length - 1 : parts.length;
}

/** Count durable Pi user entries without trusting line count: session/model/tool rows share the
 *  file, while summary identity advances only for user turns. */
function countPiJsonlUserMessages(raw: string): number {
  let count = 0;
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type === 'message' && entry.message?.role === 'user') count += 1;
    } catch {
      // A torn/malformed row is not a durable user turn; the next start/reload applies the same rule.
    }
  }
  return count;
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

function piControlState(dialect: PiDialect, opts: {
  canDrive: boolean;
  driveState: 'observing' | 'driving';
  terminalSyncActive: boolean;
  terminalSyncCommand: string;
  /** D22: the bridge extension is installed on disk, so resuming this session in the terminal WILL
   *  auto-connect the bridge → sync. Only then do we advertise `syncAvailable` on a not-yet-bridged
   *  disk row; without it, sync is not something the in-app flow can deliver (→ Take over / Observe). */
  extensionInstalled: boolean;
}): SessionControlState {
  const drive = opts.driveState === 'driving'
    ? { supported: true, state: 'driving' as const }
    : opts.canDrive
      ? { supported: true, state: 'observing' as const }
      : { supported: false, state: 'unavailable' as const, reason: `${dialect.displayName} CLI is not available on PATH, so ${PRODUCT_IDENTITY.productName} cannot Drive this session.` };
  const terminalSync = opts.terminalSyncActive
    ? {
        supported: true,
        syncAvailable: true,
        active: true,
        label: `Synced with ${dialect.displayName} terminal`,
        note: `This ${dialect.displayName} session is connected through the ${PRODUCT_IDENTITY.productName} bridge extension.`,
      }
    : {
        supported: true,
        // D22: only promise sync when the bridge extension is actually installed (otherwise resuming
        // won't connect a bridge and we'd be advertising sync we can't deliver).
        syncAvailable: opts.extensionInstalled,
        active: false,
        label: `Resume in ${dialect.displayName} terminal`,
        command: opts.terminalSyncCommand,
        note: `Resume this session in the ${dialect.displayName} CLI; once the installed bridge connects, the app will show it as synced.`,
      };
  return { drive, terminalSync };
}

/** D22 probe: is the cosyncing bridge extension installed where a live CLI will load it?
 *  Installed at the dialect's bridge install path (`<agentDir>/extensions/cosyncing-bridge/index.ts`). */
function piBridgeExtensionInstalled(rt: PiDialectRuntime): boolean {
  return existsSync(rt.bridgeInstallPath);
}

// True-sync on by default (issues-part2): install the embedded bridge extension when the target is absent.
// Exact current content is idempotent. Exact known legacy or unrelated content is preserved until the
// transactional setup flow obtains confirmation; marker-only evidence never authorizes an overwrite.
// Runs once per adapter instance (see PiEngineAdapter.bridgeEnsured); the dialect's autoinstall env
// override opts out.
function ensurePiBridgeExtension(rt: PiDialectRuntime): void {
  if (/^(0|false|no|off)$/i.test((process.env[rt.dialect.bridgeAutoinstallEnvOverride] ?? '').trim())) return;
  try {
    const inspection = inspectDialectBridgeAsset(rt);
    if (inspection.status !== 'missing') return;
    const dstDir = dirname(inspection.path);
    mkdirSync(dstDir, { recursive: true });
    writeFileSync(inspection.path, rt.bridgeAsset.source, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch {
    /* best-effort — doctor/setup owns the visible remediation path */
  }
}

function piTerminalSyncCommand(rt: PiDialectRuntime, file: string, brokerUrl: string, bridgeUsesIntegrationFile = false): string {
  const resume = `${rt.dialect.bin} --session ${shellQuote(canonicalSessionFile(file))}`;
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
 * (adapter-pi/src/bridge.ts), so neither drops detail. Pi's edit tool returns `details.diff`/`.patch`;
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
 * live bridge in adapter-pi/src/bridge.ts) so neither invents its own parsing.
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

function readSessionSurface(rt: PiDialectRuntime, file: string): PiSessionSurface {
  try {
    const st = statSafe(file);
    if (!st) return {};
    const maxTail = rt.nameScanBytes;
    const tail = readTextTail(file, st.size, maxTail);
    const tailSurface = scanSessionSurface(tail.split('\n'), rt.dialect);
    if ((tailSurface.model || tailSurface.currentModel) || st.size <= maxTail) return tailSurface;
    // Fallback for tiny/early files that only have header-ish model metadata. Latest model/thinking
    // changes are intentionally taken from the bounded tail to keep roster polling cheap. If the tail
    // only reported a thinking-level change, combine it with the head's model instead of dropping it.
    const head = readTextHead(file, Math.min(st.size, 64 * 1024));
    const headSurface = scanSessionSurface(head.split('\n'), rt.dialect);
    if (headSurface.currentModel && tailSurface.thinkingLevel) {
      return { ...headSurface, currentModel: { ...headSurface.currentModel, reasoningEffort: tailSurface.thinkingLevel } };
    }
    return headSurface;
  } catch {
    return {};
  }
}

function scanSessionSurface(lines: string[], dialect: PiDialect): PiSessionSurface {
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
      // pi records {provider, modelId}; omp records a combined `provider/modelId` string — the
      // dialect owns the split.
      const parsed = dialect.parseModelChange(obj);
      applyModel({ provider: parsed.provider, id: parsed.id }, typeof parsed.label === 'string' ? parsed.label : undefined);
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

function readSessionName(rt: PiDialectRuntime, file: string): string | undefined {
  try {
    const st = statSafe(file);
    if (!st) return undefined;
    const maxTail = rt.nameScanBytes;
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
      // The dialect's title entries are the authoritative renames: pi appends session_info {name};
      // omp owns the durable `title` slot plus `title_change` events. Both are last-write-wins.
      let titleEntry: string | undefined;
      let sawTitleEntry = false;
      if (obj?.type === 'session_info' && typeof obj.name === 'string') {
        titleEntry = obj.name;
        sawTitleEntry = true;
      } else if (rt.dialect.titleEntryTypes.includes(String(obj?.type)) && typeof obj?.title === 'string') {
        titleEntry = obj.title;
        sawTitleEntry = true;
      }
      if (sawTitleEntry) latest = titleEntry || undefined;
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
        // omp's leading `title` slot sits before the session header, so a file with no name-ish
        // field at all still surfaces its durable title.
        if (rt.dialect.titleEntryTypes.includes(String(obj?.type)) && typeof obj?.title === 'string' && obj.title) return obj.title;
      } catch {
        continue;
      }
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function materializePiSessionFile(rt: PiDialectRuntime, file: string, cwd: string, sessionId?: string, title?: string): void {
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
    // pi titles sessions through a session_info entry; omp owns its title natively (the durable
    // `title` slot / set_session_name RPC), so the create-time append is pi-dialect-only.
    if (rt.dialect.createTimeTitle === 'session_info' && name && readSessionName(rt, file) !== name) {
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
 * The AUTHORITATIVE working dir: the session JSONL's `session` record
 * (`{"type":"session", ..., "cwd":"/abs/path"}`). omp prepends a leading `title` slot BEFORE that
 * header, so the scan takes the first `session` entry rather than assuming line one. We use this
 * instead of decoding the dash-mangled directory name, which is lossy (`-`→`/`) and wrong for any
 * path containing a hyphen — that bug silently broke ALL file I/O and could even spawn the CLI in
 * an unrelated directory.
 */
function readSessionCwd(file: string): string | undefined {
  try {
    for (const line of readTextHead(file, 64 * 1024).split('\n')) {
      if (!line.trim()) continue;
      let obj: any;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      if (obj?.type !== 'session') continue;
      const cwd = obj?.cwd;
      return typeof cwd === 'string' && cwd ? cwd : undefined;
    }
    return undefined;
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
/** Absolute path to the dialect binary, or null. The readiness hook owns the resolution (PATH,
 *  env override, shebang interpreter) so the engine spawns exactly what the gate validated. */
function resolveBin(rt: PiDialectRuntime): string | null {
  try {
    return rt.hooks.readiness().executable ?? null;
  } catch {
    return null;
  }
}

/** Translate a dialect-specific agent-dir override back to the native Pi-family variable. */
function piProcessEnv(rt: PiDialectRuntime, extra: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  if (rt.agentDirOverride) env.PI_CODING_AGENT_DIR = rt.agentDir;
  return env;
}

/** Launch the exact file discovery selected, including npm's Windows .cmd shim. */
/**
 * End a Pi child, and mean it on Windows.
 *
 * A Windows npm launcher runs as `cmd.exe /c pi.cmd`, so the process this adapter holds is the
 * SHELL, not Pi. `kill()` takes the wrapper and leaves the `node.exe` actually running Pi alive —
 * still holding the session file and this broker's pipes. A native Phase 6 lane found exactly that:
 * the wrapper gone, Pi still running twenty minutes later, and the probe unable to exit because the
 * surviving grandchild held its stdio open. Every closed Drive session leaked one.
 *
 * Closing stdin is how Pi is ASKED to leave — its RPC mode shuts down on input end — and the tree
 * kill is what makes it true when it does not. On POSIX the tree kill is the same signal `kill()`
 * would have sent, so nothing changes there.
 */
async function endPiChild(
  proc: { pid: number; exited: Promise<unknown>; exitCode: number | null; kill: () => void; stdin?: unknown },
  graceMs = 1_000,
): Promise<void> {
  const stdin = proc.stdin as { end?: () => void } | undefined;
  try { stdin?.end?.(); } catch { /* already closed */ }
  await Promise.race([proc.exited.catch(() => undefined), Bun.sleep(graceMs)]);
  if (proc.exitCode !== null) return;
  try { terminateHostProcessTree(proc.pid, true); } catch { /* already gone */ }
  try { proc.kill(); } catch { /* already gone */ }
  await Promise.race([proc.exited.catch(() => undefined), Bun.sleep(graceMs)]);
}

function spawnPi<
  const In extends Bun.SpawnOptions.Writable,
  const Out extends Bun.SpawnOptions.Readable,
  const Err extends Bun.SpawnOptions.Readable,
>(
  dialect: PiDialect,
  executable: string,
  args: readonly string[],
  options: Bun.SpawnOptions.SpawnOptions<In, Out, Err>,
): Bun.Subprocess<In, Out, Err> {
  const env = (options?.env ?? process.env) as Readonly<Record<string, string | undefined>>;
  const invocation = resolveInvocation(executable, { env, platform: process.platform });
  if (!invocation) throw new Error(`${dialect.displayName} executable is no longer available: ${executable}`);
  return bunSpawnResolvedInvocation(invocation, args, options);
}

function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}
