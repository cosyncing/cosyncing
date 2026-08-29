/**
 * cosyncing — Pi live bridge extension (Mode A).
 *
 * Installed globally at `~/.pi/agent/extensions/cosyncing-bridge/index.ts`, this loads inside
 * EVERY live `pi` session and relays it to the cosyncing broker so a phone/web client can view
 * and drive the SAME session the terminal is in — no second `pi` process, no JSONL corruption.
 *
 * Outbound: batches session events (status, streaming deltas, tool calls/results, finals, tokens)
 * to POST /pi/bridge/events. Inbound: long-polls GET /pi/bridge/commands and injects prompts via
 * pi.sendUserMessage / aborts via ctx.abort. Also registers a `send_file` tool (reuses the broker's
 * /api/tool/send_file endpoint). On shutdown it POSTs /pi/bridge/bye.
 *
 * Dormant when COSYNCING_NO_BRIDGE is set — that marks a pi the broker itself spawned (resume-under-
 * broker), which must not bridge back to the broker (a loop). See packages/typescript/pi-engine/src/bridge.ts.
 *
 * Dialect note: the pi route family, integration credential (env overrides, secrets record name and
 * `kind`), and event-source labels below are rewritten per dialect when a sibling tool's asset bytes
 * are stamped — a build-time constant per install, see bridge-asset.ts
 * piBridgeEmbeddedSourceForDialect. A sibling tool's installed extension calls its own broker routes
 * with its own integration record, never pi's.
 */
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CONFIG = readBridgeConfig();
const INTEGRATION = readPiIntegration();
// COSYNCING_BROKER and COSYNCING_PI_INTEGRATION_TOKEN remain source-development overrides. Packaged setup writes
// one owner-only integration record instead; the installed extension config never embeds a broker URL or the
// full shared broker token.
const BROKER = (process.env.COSYNCING_BROKER ?? INTEGRATION.internalUrl ?? 'http://127.0.0.1:7734').replace(/\/$/, '');
const TOKEN = (process.env.COSYNCING_PI_INTEGRATION_TOKEN ?? INTEGRATION.credential ?? '').trim();
const authHeaders = (): Record<string, string> => (TOKEN ? { 'x-cosyncing-integration-token': TOKEN } : {});
const APPROVAL_MODE = (process.env.COSYNCING_BRIDGE_APPROVALS ?? CONFIG.approvalMode ?? 'dangerous').toLowerCase();
const APPROVAL_TIMEOUT_MS = Number(process.env.COSYNCING_BRIDGE_APPROVAL_TIMEOUT_MS ?? CONFIG.approvalTimeoutMs ?? 300_000);
const PI_THINKING_LEVELS = new Set(['off', 'minimal', 'low', 'medium', 'high', 'xhigh']);

function timeMs(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  if (process.env.COSYNCING_NO_BRIDGE) return; // broker-owned pi → stay dormant (no self-bridge)

  let id: string | undefined; // bridge session id (broker-assigned; base64url of the session file)
  let alive = false;
  let ended = false; // session_shutdown fired — stop re-hello attempts for good
  // Streaming key namespace. Pi's event stream carries NO message.id (always undefined in 0.78.1),
  // so this counter IS the per-turn key. It MUST advance on `turn_start` (fires once per LLM turn),
  // NOT `agent_start` (fires once per agent RUN). A single run can batch several queued prompts into
  // one run with one agent_start but N turn_starts; keying off agent_start kept `turn` constant, so
  // every reply's deltas collided on one key and the app merged them into a single bubble (later
  // turns vanished). See docs/project/implementation-status.md
  let turn = 0;
  /** The OPEN user turn — one summary per USER TURN, mirroring buildHistory (and the broker's
   *  JSONL mapper): a user message_start closes the previous turn and opens its own, a terminal
   *  stopReason closes at that message_end, agent_end closes whatever remains. One summary per
   *  RUN diverged from every reload as soon as a run batched queued steer/follow-up turns. */
  let currentRun:
    | {
        key: string;
        turnId: string;
        userMessageKey?: string;
        startedAt?: number;
        sawAssistantActivity?: boolean;
        lastAssistant?: { stopReason?: string; errored: boolean; completedAt?: number };
      }
    | undefined;
  /** When the current RUN began (agent_start). Only the FALLBACK turn anchor consumes it — the
   *  authoritative anchor is the opening user message itself. */
  let agentStartAt: number | undefined;
  /** Usage summed across the OPEN TURN's message_ends, reported on that turn's summary. */
  let currentRunTokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number } | undefined;
  let lastUserMessageKey: string | undefined;
  // Per-user-message key counter. Pi's UserMessage has NO id field (message_start emits a bare
  // Message), so we mint a stable `u<n>` key ourselves — without it the app can't dedupe a user
  // bubble and the in-attach-window history-push-plus-emit double-renders it. Seeded at session_start
  // from the count of existing user messages so live keys continue ABOVE the backfilled ones and a
  // reload (module restarts at 0) can't collide a new bubble onto a pre-reload one (mirrors `turn`).
  let userKeySeq = 0;
  let lastCtx: any; // most recent handler ctx — used to abort from the (ctx-less) poll loop
  const buf: any[] = []; // outbound event batch
  let flushTimer: ReturnType<typeof setTimeout> | undefined;
  // Tool-call args by callId — Pi's tool_execution_end carries no args, but the broker needs them to
  // recover the edited file's path for the canonical tool-result `path` chip. Cached at start, read
  // (and cleared) at end. See enrichPiToolResult in
  // packages/typescript/pi-engine/src/implementation.ts.
  const toolArgs = new Map<string, any>();
  const pendingPermissions = new Map<string, { resolve: (ok: boolean) => void; cleanup: () => void; scope: string }>();
  const pendingQuestions = new Map<string, { resolve: (answers: string[][] | null) => void; cleanup: () => void }>();
  // A terminal answer can race an already-queued app answer. Remember settled bridge questions so
  // the late command is ignored instead of being misclassified as an unresolvable native Pi dialog.
  const settledQuestions = new Set<string>();
  const approvedScopes = new Set<string>();

  // Pi may make the first tool call immediately after session_start, while the asynchronous bridge
  // hello is still one fetch microtask away from assigning `id`. Give that startup/re-link race a
  // short grace instead of falsely reporting "Not bridged" on an otherwise healthy connection.
  const waitForBridge = async (timeoutMs = 1500): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (!id && !ended && Date.now() < deadline) await sleep(25);
    return !!id;
  };

  const isBusyNow = (): boolean => {
    try {
      return !!lastCtx && typeof lastCtx.isIdle === 'function' && !lastCtx.isIdle();
    } catch {
      return false;
    }
  };

  const normalizeDeliverAs = (requested?: string): 'steer' | 'followUp' | undefined => {
    if (requested === 'steer' || requested === 'followUp') return requested;
    if (requested === 'nextTurn') return 'followUp';
    return isBusyNow() ? 'steer' : undefined;
  };

  const injectUserMessage = async (text: string, requestedDeliverAs?: string): Promise<void> => {
    const deliverAs = normalizeDeliverAs(requestedDeliverAs);
    try {
      await pi.sendUserMessage(text, deliverAs ? { deliverAs } : undefined);
      return;
    } catch (first) {
      // Pi throws if the agent started streaming after the broker queued the command but before this
      // extension injected it. Retry once using Pi's streaming-safe path, then make failure visible.
      if (!deliverAs) {
        try {
          await pi.sendUserMessage(text, { deliverAs: 'steer' });
          return;
        } catch (second) {
          emit({ t: 'error', message: `Remote input was not delivered: ${oneLine(second)}` });
          return;
        }
      }
      emit({ t: 'error', message: `Remote input was not delivered: ${oneLine(first)}` });
    }
  };

  const normalizeThinkingLevel = (value: unknown): string | undefined => {
    const level = typeof value === 'string' ? value.trim() : '';
    return PI_THINKING_LEVELS.has(level) ? level : undefined;
  };

  const currentThinkingLevel = (): string | undefined => {
    try {
      return normalizeThinkingLevel(pi.getThinkingLevel?.());
    } catch {
      return undefined;
    }
  };

  const modelPayload = (model: any, thinkingLevel?: string): any | undefined => {
    if (!model?.id) return undefined;
    return {
      providerID: String(model.provider ?? ''),
      modelID: String(model.id),
      label: String(model.name ?? model.id),
      reasoning: model.reasoning === true,
      thinkingLevelMap: model.thinkingLevelMap && typeof model.thinkingLevelMap === 'object' ? model.thinkingLevelMap : undefined,
      ...(thinkingLevel ? { reasoningEffort: thinkingLevel } : {}),
    };
  };

  const modelCatalog = (ctx: any): any[] => {
    try {
      return (ctx?.modelRegistry?.getAvailable?.() ?? [])
        .map((m: any) => modelPayload(m))
        .filter(Boolean);
    } catch {
      return [];
    }
  };

  const relayModelState = (ctx: any): void => {
    if (!id) return;
    const thinkingLevel = currentThinkingLevel();
    emit({ t: 'model', model: modelPayload(ctx?.model, thinkingLevel), thinkingLevel, models: modelCatalog(ctx) });
  };

  const applyModel = async (providerID: string, modelID: string, reasoningEffort?: string): Promise<void> => {
    const ctx = lastCtx;
    const model = ctx?.modelRegistry?.find?.(providerID, modelID);
    if (!model) {
      emit({ t: 'error', message: `Model not found: ${providerID}/${modelID}` });
      return;
    }
    const ok = await pi.setModel(model);
    if (!ok) {
      emit({ t: 'error', message: `Model switch failed: no API key for ${providerID}/${modelID}` });
      return;
    }
    const effort = normalizeThinkingLevel(reasoningEffort);
    if (effort) pi.setThinkingLevel(effort as any);
    relayModelState(ctx ? { ...ctx, model } : { model });
  };

  const post = async (path: string, body: unknown): Promise<any> => {
    try {
      const r = await fetch(`${BROKER}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() }, body: JSON.stringify(body),
      });
      return r.ok ? await r.json().catch(() => ({})) : undefined;
    } catch {
      return undefined; // broker down → drop (the session keeps working locally)
    }
  };

  const emit = (ev: any): void => {
    if (!id) return;
    buf.push(ev);
    if (buf.length >= 32) return void flush();
    if (!flushTimer) flushTimer = setTimeout(flush, 60); // coalesce token deltas into ~60ms batches
  };

  const flush = async (): Promise<void> => {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = undefined; }
    if (!id || !buf.length) return;
    const events = buf.splice(0, buf.length);
    await post('/pi/bridge/events', { id, events });
  };

  // ── inbound: long-poll the broker for commands and act on them ──
  const pollLoop = async (): Promise<void> => {
    while (alive && id) {
      let commands: any[] = [];
      try {
        const r = await fetch(`${BROKER}/pi/bridge/commands?id=${encodeURIComponent(id)}`, { headers: authHeaders() });
        if (r.status === 404) {
          // Unknown id = the broker restarted and forgot this registration (a transient outage is a
          // fetch ERROR, not a 404). Drop out so bridgeLoop re-hellos with a fresh history backfill.
          alive = false;
          id = undefined;
          lastCtx?.ui?.setStatus?.('cosyncing', '📱 re-linking…');
          return;
        }
        if (r.ok) commands = (await r.json())?.commands ?? [];
      } catch {
        await sleep(1500); // broker hiccup → back off, keep trying
        continue;
      }
      for (const c of commands) {
        try {
          if (c.kind === 'prompt' && c.text) {
            await injectUserMessage(c.text, c.deliverAs);
          } else if (c.kind === 'command' && c.name) {
            // A user template (/name) or skill (/skill:name): Pi expands these from a normal user
            // message, so we inject '/name args' the same way the resume adapter's runCommand does.
            // (Built-in TUI commands like /compact aren't promptable → stay terminal-only for now.)
            const line = '/' + c.name + (c.args ? ' ' + c.args : '');
            await injectUserMessage(line, c.deliverAs);
          } else if (c.kind === 'abort') {
            lastCtx?.abort?.();
          } else if (c.kind === 'permission' && c.requestId) {
            resolvePermission(String(c.requestId), c.decision);
          } else if (c.kind === 'answer' || c.kind === 'reject-question') {
            const requestId = c.requestId ? String(c.requestId) : '';
            if (requestId && pendingQuestions.has(requestId)) {
              resolveQuestion(requestId, c.kind === 'reject-question' ? null : c.answers ?? []);
            } else if (requestId && settledQuestions.has(requestId)) {
              // The native Pi dialog won the race and already closed the app card.
            } else if (requestId) {
              // Pi native TUI select/input dialogs are still terminal-only because the extension API does
              // not receive those events. Only bridge-originated `ask_user` tool questions are resolvable.
              emit({ t: 'question-resolved', requestId });
              emit({ t: 'error', message: 'Answer interactive questions in the Pi terminal — a synced (bridged) Pi session relays permission prompts but not select/input dialogs.' });
            }
          } else if (c.kind === 'set-model' && c.modelID) {
            await applyModel(String(c.providerID ?? ''), String(c.modelID), c.reasoningEffort);
          } else if (c.kind === 'set-thinking-level' && c.reasoningEffort) {
            const effort = normalizeThinkingLevel(c.reasoningEffort);
            if (effort) {
              pi.setThinkingLevel(effort as any);
              relayModelState(lastCtx);
            }
          }
        } catch {
          /* ignore a bad command */
        }
      }
    }
  };

  const resolvePermission = (requestId: string, decision?: string): void => {
    const pending = pendingPermissions.get(requestId);
    if (!pending) return;
    pendingPermissions.delete(requestId);
    pending.cleanup();
    const ok = decision === 'approve' || decision === 'approve-session';
    if (decision === 'approve-session') approvedScopes.add(pending.scope);
    emit({ t: 'permission-resolved', requestId, decision: ok ? decision : 'reject' });
    pending.resolve(ok);
  };

  const resolveQuestion = (requestId: string, answers: string[][] | null): void => {
    const pending = pendingQuestions.get(requestId);
    if (!pending) return;
    pending.resolve(answers);
  };

  const canAskUserInTerminal = (params: any, ctx: any): boolean => {
    if (ctx?.mode && ctx.mode !== 'tui') return false;
    if (ctx?.hasUI === false) return false;
    const options = Array.isArray(params?.options) ? params.options : [];
    return options.length > 0
      ? typeof ctx?.ui?.select === 'function'
      : typeof ctx?.ui?.input === 'function';
  };

  const askUserInTerminal = async (params: any, ctx: any, signal: AbortSignal): Promise<string[][] | null> => {
    const options = (Array.isArray(params?.options) ? params.options : []).map((option: any) => ({
      label: typeof option === 'string' ? option : String(option?.label ?? ''),
      description: typeof option === 'string' || option?.description == null ? undefined : String(option.description),
    }));
    const question = String(params?.question ?? 'Input requested');
    const header = params?.header ? String(params.header) : '';
    const title = header ? `${header}: ${question}` : question;

    if (options.length === 0) {
      const answer = await ctx.ui.input(title, undefined, { signal });
      return answer === undefined ? null : [[answer]];
    }

    const usedDisplays = new Set<string>();
    const choices = options.map((option: { label: string; description?: string }, index: number) => {
      const base = option.description ? `${option.label} — ${option.description}` : option.label;
      let display = base;
      if (usedDisplays.has(display)) display = `${base} (${index + 1})`;
      usedDisplays.add(display);
      return { display, label: option.label };
    });

    if (params?.multiple !== true) {
      const selected = await ctx.ui.select(title, choices.map((choice: { display: string }) => choice.display), { signal });
      if (selected === undefined) return null;
      return [[choices.find((choice: { display: string }) => choice.display === selected)?.label ?? selected]];
    }

    const selectedLabels: string[] = [];
    const remaining = [...choices];
    let doneLabel = 'Done';
    while (usedDisplays.has(doneLabel)) doneLabel = `✓ ${doneLabel}`;
    while (remaining.length > 0) {
      const selected = await ctx.ui.select(
        selectedLabels.length === 0 ? title : `${title} (${selectedLabels.length} selected)`,
        [...remaining.map((choice: { display: string }) => choice.display), doneLabel],
        { signal },
      );
      if (selected === undefined) return null;
      if (selected === doneLabel) break;
      const index = remaining.findIndex((choice: { display: string }) => choice.display === selected);
      if (index < 0) continue;
      selectedLabels.push(remaining[index]!.label);
      remaining.splice(index, 1);
    }
    return [selectedLabels];
  };

  const askUser = (params: any, ctx: any, mirrorToApp: boolean): Promise<string[][] | null> => {
    const requestId = `ca-q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const options = Array.isArray(params?.options) ? params.options : [];
    return new Promise((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const dialogAbort = new AbortController();
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        ctx?.signal?.removeEventListener?.('abort', onAbort);
        dialogAbort.abort();
      };
      const finish = (answers: string[][] | null) => {
        if (settled) return;
        settled = true;
        if (mirrorToApp) {
          pendingQuestions.delete(requestId);
          settledQuestions.add(requestId);
        }
        cleanup();
        if (mirrorToApp) emit({ t: 'question-resolved', requestId });
        resolve(answers);
      };
      const onAbort = () => finish(null);
      if (APPROVAL_TIMEOUT_MS > 0) timeout = setTimeout(() => finish(null), APPROVAL_TIMEOUT_MS);
      ctx?.signal?.addEventListener?.('abort', onAbort, { once: true });
      if (mirrorToApp) {
        pendingQuestions.set(requestId, { resolve: (answers) => finish(answers), cleanup });
        emit({
          t: 'question-request',
          requestId,
          questions: [{
            header: params?.header ? String(params.header) : undefined,
            question: String(params?.question ?? 'Input requested'),
            options: options.map((o: any) => typeof o === 'string' ? { label: o } : { label: String(o?.label ?? ''), description: o?.description == null ? undefined : String(o.description) }),
            multiple: params?.multiple === true,
          }],
        });
      }
      if (canAskUserInTerminal(params, ctx)) {
        void askUserInTerminal(params, ctx, dialogAbort.signal)
          .then((answers) => finish(answers))
          .catch(() => {
            if (!mirrorToApp) finish(null);
          });
      }
    });
  };

  const requestPermission = (event: any, ctx: any, scope: string): Promise<boolean> => {
    const requestId = `ca-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    return new Promise<boolean>((resolve) => {
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        ctx?.signal?.removeEventListener?.('abort', onAbort);
      };
      const finish = (ok: boolean) => {
        if (!pendingPermissions.has(requestId)) return;
        pendingPermissions.delete(requestId);
        cleanup();
        emit({ t: 'permission-resolved', requestId, decision: ok ? 'approve' : 'reject' });
        resolve(ok);
      };
      const onAbort = () => finish(false);
      if (APPROVAL_TIMEOUT_MS > 0) timeout = setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS);
      ctx?.signal?.addEventListener?.('abort', onAbort, { once: true });
      pendingPermissions.set(requestId, { resolve, cleanup, scope });
      emit({
        t: 'permission-request',
        requestId,
        toolName: String(event?.toolName ?? 'tool'),
        title: permissionTitle(event),
        detail: permissionDetail(event),
      });
    });
  };

  // ── lifecycle: announce on start, tear down on shutdown ──
  const sayHello = async (): Promise<boolean> => {
    const ctx = lastCtx;
    const sessionFile = ctx?.sessionManager?.getSessionFile?.();
    if (!ctx || !sessionFile) return false;
    // Seed the per-turn key namespace ABOVE any turn already in this session. On a RELOAD this module
    // is re-instantiated with turn=0, but the broker keeps the connection alive (grace) so the phone
    // stays attached with its pre-reload bubbles keyed t1,t2,…; restarting at t1 would collide a new
    // turn's deltas onto an old bubble. Entries grow ≥2/turn, so the count strictly exceeds the
    // highest prior turn number. A fresh session has 0 entries → turn=0 (unchanged behavior).
    turn = entryCount(ctx);
    userKeySeq = countUserMessages(ctx); // continue user keys above the backfilled history's u0..u(k-1)
    const thinkingLevel = currentThinkingLevel();
    const model = (ctx as any).model;
    const res = await post('/pi/bridge/hello', {
      sessionFile,
      cwd: ctx.cwd,
      title: sessionFile.split('/').pop(),
      model: modelPayload(model, thinkingLevel),
      thinkingLevel,
      models: modelCatalog(ctx),
      // Backfill the conversation so far — without this the app shows only events relayed AFTER
      // attach (a freshly-opened phone saw a blank session). Mapped to the same wire shapes as live.
      history: buildHistory(ctx),
      // The user's skills/templates so the palette isn't just /stop (best-effort; see buildCommands).
      commands: buildCommands(ctx),
    });
    if (!res?.id) return false;
    id = res.id;
    alive = true;
    approvedScopes.clear();
    ctx.ui?.setStatus?.('cosyncing', '📱 bridged');
    return true;
  };

  // Registration is a LOOP, not a one-shot: the broker restarts routinely (upgrades, audits), and a
  // restart forgets every live bridge. A TUI that helloed the old broker must re-hello the new one or
  // it silently runs unbridged while the app diverges onto the resume adapter (issues-part2 item 3).
  // Hello failure = broker down → retry; pollLoop returning = registration lost (404) → re-hello.
  let bridgeLoopRunning = false;
  const bridgeLoop = async (): Promise<void> => {
    if (bridgeLoopRunning) return;
    bridgeLoopRunning = true;
    try {
      while (!ended) {
        if (!(await sayHello())) {
          await sleep(5000);
          continue;
        }
        await pollLoop();
        if (!ended) await sleep(1000);
      }
    } finally {
      bridgeLoopRunning = false;
    }
  };

  pi.on('session_start', async (_event: any, ctx: any) => {
    lastCtx = ctx;
    if (!ctx.sessionManager.getSessionFile?.()) return; // ephemeral (no file) → not discoverable/attachable; skip bridging
    void bridgeLoop();
  });

  // Command/skill relay: make the bridged palette more than just /stop. Skills aren't loaded into the
  // resource loader at session_start, so we relay them as soon as they ARE available — on
  // resources_discover (fires right after start, usually before a phone attaches) and, as a fallback,
  // on the first turn's systemPromptOptions. emit() no-ops until `id` is set, so a resources_discover
  // that beats the hello round-trip simply defers to before_agent_start; either way the palette fills.
  let commandsSent = false;
  const relayCommands = (cmds: any[]): void => {
    if (commandsSent || !id || !cmds.length) return;
    commandsSent = true;
    emit({ t: 'commands', commands: cmds });
  };
  pi.on('resources_discover', (_e: any, ctx: any) => relayCommands(skillCommands(ctx)));
  pi.on('before_agent_start', (event: any) => relayCommands(commandsFromOptions((event as any)?.systemPromptOptions)));
  // omp (oh-my-pi) does not emit model_select/thinking_level_select. Both runtimes' `on()` is an
  // unvalidated Map insert that never throws, so a try/catch is the only possible guard: subscribing
  // to an absent event is a silent no-op there, and pi behavior is byte-for-byte what it was.
  try {
    pi.on('model_select', (_event: any, ctx: any) => {
      lastCtx = ctx;
      relayModelState(ctx);
    });
    pi.on('thinking_level_select', (_event: any, ctx: any) => {
      lastCtx = ctx;
      relayModelState(ctx);
    });
  } catch {
    /* dialect without these events — the model state relay rides get_state/model_change instead */
  }

  // Remote approval gate. Default is intentionally narrow (`dangerous` bash commands) so installing
  // the bridge does not make normal terminal editing depend on a phone. Broaden with:
  //   COSYNCING_BRIDGE_APPROVALS=mutating  # bash + edit/write
  //   COSYNCING_BRIDGE_APPROVALS=all       # every tool call
  //   COSYNCING_BRIDGE_APPROVALS=off       # disable
  pi.on('tool_call', async (event: any, ctx: any) => {
    lastCtx = ctx;
    const scope = approvalScope(event);
    if (!shouldRequestApproval(event) || !id || approvedScopes.has(scope)) return undefined;
    const ok = await requestPermission(event, ctx, scope);
    if (!ok) return { block: true, reason: 'Denied from cosyncing' };
    return undefined;
  });

  pi.on('session_shutdown', async (event: any) => {
    ended = true; // stop the re-hello loop — a reload re-instantiates this module fresh
    alive = false;
    for (const requestId of [...pendingPermissions.keys()]) resolvePermission(requestId, 'reject');
    for (const requestId of [...pendingQuestions.keys()]) resolveQuestion(requestId, null);
    await flush();
    // Relay Pi's shutdown reason ('quit'|'reload'|'new'|'resume'|'fork') so the broker can tell a
    // reload (the SAME session re-hellos in a moment → keep the attached phone) apart from a genuine
    // quit / session replacement (tear down + send the phone a clean `ended` frame). See
    // packages/typescript/pi-engine/src/bridge.ts (PiBridgeRegistry.bye) and SessionShutdownEvent in Pi's types.
    if (id) await post('/pi/bridge/bye', { id, reason: event?.reason });
    id = undefined;
  });

  // ── outbound relays ──
  // agent_start = once per RUN (status only). turn_start = once per LLM turn → advance the key
  // namespace here so each turn's deltas/final get a distinct key (the multi-turn-merge fix).

  /** Close the open USER TURN with buildHistory's exact rules — status from the last assistant's
   *  terminal stopReason, completion only from message-end evidence (or the supplied run-end
   *  clock), duration only when both clocks agree, and NO summary for a prompt the agent never
   *  answered — so the live stream and the next backfill agree turn for turn, key for key. */
  const closeLiveTurn = (fallbackCompletedAt?: number): void => {
    const run = currentRun;
    currentRun = undefined;
    const tokens = currentRunTokens;
    currentRunTokens = undefined;
    if (!run) return;
    let last = run.lastAssistant;
    // Assistant streaming without a message_end (degraded stream) still earns the summary;
    // a prompt with no assistant activity at all is suppressed, as buildHistory suppresses it.
    if (!last && run.sawAssistantActivity) last = { errored: false, completedAt: undefined };
    if (!last) return;
    const terminal = last.stopReason === 'stop'
      ? 'done'
      : last.stopReason === 'aborted'
        ? 'cancelled'
        : last.stopReason === 'error'
          ? 'error'
          : undefined;
    const completedAt = last.completedAt ?? fallbackCompletedAt;
    const duration = run.startedAt != null && completedAt != null && completedAt >= run.startedAt
      ? completedAt - run.startedAt
      : undefined;
    emit({
      t: 'run-summary',
      key: run.key,
      turnId: run.turnId,
      userMessageKey: run.userMessageKey,
      status: last.errored ? 'error' : (terminal ?? 'done'),
      ...(run.startedAt != null ? { startedAt: run.startedAt } : {}),
      ...(completedAt != null ? { completedAt } : {}),
      ...(duration != null ? { totalRuntimeMs: duration } : {}),
      ...(tokens ? { tokens } : {}),
      source: 'pi-bridge',
    });
  };

  /** Pi normally emits turn_start BEFORE the user message_start. A fallback created at
   *  turn_start therefore becomes an orphan as soon as the real user turn opens. Wait until the
   *  first assistant event; only a degraded stream with no user event reaches this path. */
  const ensureLiveTurn = (): void => {
    if (currentRun) return;
    const startedAt = agentStartAt ?? Date.now();
    const fallbackTurn = `t${Math.max(turn, 1)}`;
    currentRun = {
      key: `pi:run:${fallbackTurn}`,
      turnId: fallbackTurn,
      userMessageKey: lastUserMessageKey,
      startedAt,
    };
    emit({
      t: 'run-summary',
      key: currentRun.key,
      turnId: currentRun.turnId,
      userMessageKey: currentRun.userMessageKey,
      startedAt,
      status: 'running',
      source: 'pi-bridge',
    });
  };

  pi.on('agent_start', (event: any, ctx: any) => {
    lastCtx = ctx;
    // The run's start clock — consumed only by the FALLBACK turn anchor; the authoritative
    // anchor is the opening user message itself (message_start below).
    agentStartAt = timeMs(event?.timestamp) ?? Date.now();
    emit({ t: 'status', running: true });
  });
  pi.on('agent_end', (event: any, ctx: any) => {
    lastCtx = ctx;
    toolArgs.clear(); // drop args of any uncompleted tool call
    // Whatever turn is still open closes at the run's end clock — a stream with no terminal
    // stopReason evidence (abort) or none of the message_* events at all (degraded).
    closeLiveTurn(timeMs(event?.timestamp) ?? Date.now());
    agentStartAt = undefined;
    emit({ t: 'status', running: false });
  });
  pi.on('turn_start', (event: any, ctx: any) => {
    lastCtx = ctx;
    turn++;
    // Do not open summary state here: Pi emits turn_start before the user message_start. A runtime
    // that omits the user event falls back lazily at its first assistant event (ensureLiveTurn).
  });

  pi.on('message_start', (event: any, ctx: any) => {
    lastCtx = ctx;
    // Every user message — typed in the terminal, queued while busy, or injected by us — is the source
    // for one user bubble. before_agent_start fires only ONCE per run, so queued prompts produced no
    // bubble; message_start fires per user message (the broker dedupes our optimistic echo by text).
    const m = event?.message;
    if (m?.role !== 'user') return;
    const text = contentText(m?.content);
    // Mint a stable per-message key (Pi gives none) so the broker/app dedupe this against the
    // in-window history copy and across reattaches — parity with OpenCode's keyed user-messages.
    // The ordinal advances for EVERY user message (buildHistory does the same), so live keys and
    // the next backfill's keys stay in one space even across empty-content messages.
    const key = `u${userKeySeq++}`;
    lastUserMessageKey = key;
    if (text) emit({ t: 'user', text, key, sentAt: timeMs(m.timestamp ?? event?.timestamp) ?? Date.now() });
    // A user message ENTERING the conversation is the user-turn boundary, exactly as its entry
    // is for buildHistory: it closes the previous turn and opens its own. One summary per RUN
    // instead left a single row spanning every queued steer/follow-up turn, so summary count,
    // keys, timing and token grouping all changed on the next backfill.
    closeLiveTurn();
    currentRun = {
      key: `pi:run:${key}`,
      turnId: key,
      userMessageKey: key,
      startedAt: timeMs(m?.timestamp ?? event?.timestamp) ?? Date.now(),
    };
    emit({ t: 'run-summary', key: currentRun.key, turnId: key, userMessageKey: key, startedAt: currentRun.startedAt, status: 'running', source: 'pi-bridge' });
  });

  pi.on('message_update', (event: any, ctx: any) => {
    lastCtx = ctx;
    const e = event?.assistantMessageEvent;
    if (!e) return;
    ensureLiveTurn();
    currentRun!.sawAssistantActivity = true;
    // Key by turn + content KIND (not the model-dependent contentIndex), so the final below always
    // shares the deltas' key and a reattach/history replay can't draw a second, misaligned bubble.
    if (e.type === 'text_delta') emit({ t: 'delta', kind: 'text', key: `t${turn}:t`, delta: e.delta });
    else if (e.type === 'thinking_delta') emit({ t: 'delta', kind: 'thinking', key: `t${turn}:r`, delta: e.delta });
  });

  pi.on('message_end', (event: any, ctx: any) => {
    lastCtx = ctx;
    const m = event?.message;
    if (m?.role !== 'assistant') return;
    ensureLiveTurn();
    // Finalized snapshots for history backfill, keyed identically to the live deltas (see above).
    const text = contentText(m?.content);
    if (text) emit({ t: 'final', kind: 'text', key: `t${turn}:t`, text });
    const think = thinkingText(m?.content);
    if (think) emit({ t: 'final', kind: 'thinking', key: `t${turn}:r`, text: think });
    const u = m?.usage;
    if (u) {
      emit({ t: 'token', input: u.input, output: u.output, cost: u.cost?.total });
      // Summed for the OPEN TURN's summary. A run with tool calls has many message_ends
      // inside one turn — only a TERMINAL stopReason below ends the turn, so a mid-turn
      // toolUse end never stamps a premature completed footer.
      const sum = currentRunTokens ?? {};
      for (const [field, value] of [
        ['input', u.input],
        ['output', u.output],
        ['cacheRead', u.cacheRead],
        ['cacheWrite', u.cacheWrite],
        ['cost', u.cost?.total],
      ] as const) {
        if (typeof value === 'number' && Number.isFinite(value)) {
          sum[field] = (sum[field] ?? 0) + value;
        }
      }
      currentRunTokens = sum;
    }
    // The message's END clock is the live analog of the entry write time buildHistory reads —
    // the only authoritative completion evidence. A terminal stopReason closes the turn HERE,
    // as buildHistory closes on the entry, so a queued follow-up's next turn never inherits
    // this turn's span or usage.
    if (currentRun) {
      currentRun.lastAssistant = {
        stopReason: typeof m.stopReason === 'string' ? m.stopReason : undefined,
        errored: !!m.error,
        completedAt: timeMs(event?.timestamp) ?? Date.now(),
      };
      if (m.stopReason === 'stop' || m.stopReason === 'aborted' || m.stopReason === 'error' || !!m.error) {
        closeLiveTurn();
      }
    }
  });

  pi.on('tool_execution_start', (event: any, ctx: any) => {
    lastCtx = ctx;
    if (event?.toolCallId != null && event?.args !== undefined) toolArgs.set(String(event.toolCallId), event.args);
    emit({ t: 'tool-call', callId: event?.toolCallId, name: event?.toolName, args: event?.args });
  });
  pi.on('tool_execution_end', (event: any, ctx: any) => {
    lastCtx = ctx;
    const callId = event?.toolCallId != null ? String(event.toolCallId) : '';
    // Relay the rich `details` (diff/patch/truncation/exitCode) + originating args so the broker can
    // map them to the canonical diffstat/exit-code/path chips (shared tool-result enrichment).
    emit({
      t: 'tool-result',
      callId: event?.toolCallId,
      name: event?.toolName,
      isError: !!event?.isError,
      result: contentText(event?.result?.content),
      details: event?.result?.details,
      args: toolArgs.get(callId),
    });
    toolArgs.delete(callId);
  });

  // ── send_file tool (reuses the broker's existing endpoint; mirrors the OpenCode tool) ──
  pi.registerTool({
    name: 'send_file',
    label: 'Send file',
    description: 'Send a file from this workspace to the user in their cosyncing app. Pass the path of the file to deliver (create it first if needed). Use this when the user asks you to send/share/deliver a file.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path of the file to send (absolute, or relative to the workspace).' },
      },
      required: ['path'],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: any) {
      if (!id && !(await waitForBridge())) return { content: [{ type: 'text', text: 'Not bridged to the app right now.' }], details: {} };
      try {
        const r = await fetch(`${BROKER}/pi/bridge/send-file`, {
          method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ id, path: params.path }),
        });
        const text = await r.text();
        return { content: [{ type: 'text', text: text || (r.ok ? 'sent' : 'failed') }], details: {} };
      } catch (e) {
        return { content: [{ type: 'text', text: `send_file failed: ${String(e)}` }], details: {} };
      }
    },
  });

  pi.registerTool({
    name: 'ask_user',
    label: 'Ask user',
    description: 'Ask the user a question in Pi and their cosyncing app, then use the first answer. Use this for choices, confirmations, and short free-text input.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Question to show to the user.' },
        header: { type: 'string', description: 'Short optional heading.' },
        options: {
          type: 'array',
          description: 'Optional answer choices. Leave empty for free-text input.',
          items: {
            anyOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  label: { type: 'string' },
                  description: { type: 'string' },
                },
                required: ['label'],
                additionalProperties: false,
              },
            ],
          },
        },
        multiple: { type: 'boolean', description: 'Whether the user may choose multiple options.' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    async execute(_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: unknown, ctx: any) {
      const terminalAvailable = canAskUserInTerminal(params, ctx);
      const bridgeAvailable = !!id || (!terminalAvailable && await waitForBridge());
      if (!bridgeAvailable && !terminalAvailable) return { content: [{ type: 'text', text: 'No interactive user interface is available.' }], details: { cancelled: true } };
      const answers = await askUser(params, ctx, bridgeAvailable);
      if (!answers) return { content: [{ type: 'text', text: 'User did not answer.' }], details: { cancelled: true } };
      const flat = answers.flat().filter(Boolean);
      return { content: [{ type: 'text', text: flat.length ? flat.join('\n') : 'No answer provided.' }], details: { answers } };
    },
  });
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: any) => (typeof c === 'string' ? c : c?.type === 'text' ? c.text : '')).join('');
  return '';
}

function readBridgeConfig(): { approvalMode?: string; approvalTimeoutMs?: number } {
  const roots = [
    process.env.COSYNCING_BRIDGE_CONFIG,
    join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent'), 'extensions', 'cosyncing-bridge', 'config.json'),
  ].filter(Boolean) as string[];
  for (const p of roots) {
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      /* ignore a malformed/missing config and use env/defaults */
    }
  }
  return {};
}

function readPiIntegration(): { schemaVersion?: number; kind?: string; internalUrl?: string; credential?: string } {
  const stateRoot = process.env.COSYNCING_HOME
    ?? join(homedir(), '__COSYNCING_STATE_DIRECTORY__');
  const path = process.env.COSYNCING_PI_INTEGRATION_FILE
    ?? join(stateRoot, 'secrets', 'pi-integration.json');
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (value?.schemaVersion !== 1 || value?.kind !== 'pi-bridge') return {};
    if (typeof value.internalUrl !== 'string' || typeof value.credential !== 'string') return {};
    return value;
  } catch {
    return {};
  }
}

function shouldRequestApproval(event: any): boolean {
  if (APPROVAL_MODE === 'off' || APPROVAL_MODE === '0' || APPROVAL_MODE === 'false') return false;
  const toolName = String(event?.toolName ?? '');
  if (!toolName) return false;
  if (APPROVAL_MODE === 'all') return true;
  if (APPROVAL_MODE === 'mutating') return /^(bash|edit|write|patch|apply_patch|create|delete|move|rename)$/i.test(toolName);
  if (/^bash$/i.test(toolName)) return dangerousBashCommand(String(event?.input?.command ?? ''));
  return false;
}

function approvalScope(event: any): string {
  const toolName = String(event?.toolName ?? 'tool').toLowerCase();
  return `${toolName}:${stableInput(event?.input ?? {})}`;
}

export function dangerousBashCommand(command: string): boolean {
  if (/\bsudo\b/i.test(command)) return true;
  if (/\b(chmod|chown)\b.*\b777\b/i.test(command)) return true;
  if (/\bmkfs(?:\.\w+)?\b/i.test(command)) return true;
  if (/\bdd\b.+\bof=\/dev\//i.test(command)) return true;

  const words = shellWords(command);
  const rmAt = words.findIndex((w) => basenameOf(w) === 'rm');
  if (rmAt < 0) return false;
  const args = words.slice(rmAt + 1).filter((w) => w !== '--');
  return args.some((a) => a === '--force' || a === '--recursive' || /^-[A-Za-z]*[fRr][A-Za-z]*$/.test(a));
}

function shellWords(command: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | '' = '';
  let esc = false;
  for (const ch of command) {
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (ch === '\\' && quote !== "'") {
      esc = true;
      continue;
    }
    if ((ch === '"' || ch === "'") && (!quote || quote === ch)) {
      quote = quote ? '' : ch;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function basenameOf(cmd: string): string {
  return String(cmd).split('/').pop() ?? cmd;
}

function stableInput(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value) ?? String(value);
  if (Array.isArray(value)) return `[${value.map(stableInput).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableInput(obj[k])}`).join(',')}}`;
}

function permissionTitle(event: any): string {
  const toolName = String(event?.toolName ?? 'tool');
  if (toolName === 'bash') return 'Run shell command?';
  if (toolName === 'edit' || toolName === 'write') return `Run ${toolName} tool?`;
  return `Run ${toolName}?`;
}

function permissionDetail(event: any): string {
  const toolName = String(event?.toolName ?? 'tool');
  const input = event?.input ?? {};
  if (toolName === 'bash' && typeof input.command === 'string') return input.command;
  const path = input.path ?? input.file_path ?? input.filePath ?? input.filename;
  if (typeof path === 'string' && path) return `Path: ${path}`;
  try {
    return JSON.stringify(input, null, 2).slice(0, 1200);
  } catch {
    return '';
  }
}
/** Reasoning text from a Pi message's content parts ({type:'thinking', thinking} | {type:'reasoning', text}). */
function thinkingText(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content
    .map((c: any) => (c?.type === 'thinking' ? (c.thinking ?? c.text ?? '') : c?.type === 'reasoning' ? (c.text ?? '') : ''))
    .join('');
}

/** Map the session's stored entries to bridge wire events for history backfill. Pi entries are
 *  `{type:'message', id, message:{role:'user'|'assistant'|'toolResult', content:[…]}}`; content
 *  parts are `{type:'text'|'thinking'|'toolCall', …}`. Keyed by entry id so the app renders distinct
 *  bubbles (same keying discipline as the live relay). */
/** How many entries the session already has — used to seed the turn-key namespace above prior turns
 *  so a reload can't reuse a key the still-attached phone has already rendered (see session_start). */
function entryCount(ctx: any): number {
  try {
    return (ctx?.sessionManager?.getEntries?.() ?? []).length;
  } catch {
    return 0;
  }
}

/** How many user messages the session already has — seeds the live user-key counter so it
 *  continues exactly above buildHistory's `u0..u(k-1)`. MUST mirror buildHistory's ordinal,
 *  which advances for EVERY user entry (empty content included) so the two key spaces stay
 *  aligned (no gap, no collision) and a live turn's summary key equals the key the next
 *  backfill gives the same turn. */
function countUserMessages(ctx: any): number {
  let n = 0;
  try {
    for (const e of ctx?.sessionManager?.getEntries?.() ?? [])
      if (e?.type === 'message' && e.message?.role === 'user') n++;
  } catch {
    /* getEntries unavailable → 0 (fresh session) */
  }
  return n;
}

function buildHistory(ctx: any): any[] {
  let entries: any[] = [];
  try {
    entries = ctx?.sessionManager?.getEntries?.() ?? [];
  } catch {
    return [];
  }
  // Tool-call args by id (a toolResult's file path lives on the originating call) — same recovery the
  // live relay does via toolArgs, but resolved here across the stored entries.
  const histArgs = new Map<string, any>();
  for (const e of entries)
    if (e?.type === 'message' && e.message?.role === 'assistant' && Array.isArray(e.message.content))
      for (const p of e.message.content)
        if (p?.type === 'toolCall' && p.id != null) histArgs.set(String(p.id), p.arguments);
  const out: any[] = [];
  let i = 0;
  let u = 0; // user-message ordinal → `u0,u1,…`; live message_start continues this space (userKeySeq)
  let totalRuntimeMs = 0;
  let turnCount = 0;
  let updatedAt: number | undefined;
  // One summary per USER TURN, from evidence only — the same rules the broker's
  // JSONL mapper applies. A per-entry "done" summary put a completed footer on a
  // run still going (this backfill runs at every hello, including a reload
  // mid-run), and its span was inferred from adjacent message timestamps.
  let openTurn:
    | {
        userKey?: string;
        startedAt?: number;
        last?: { key: string; stopReason?: string; errored: boolean; completedAt?: number; anchor?: string };
        tokens?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number; cost?: number };
      }
    | undefined;
  const closeTurn = (closed: boolean): void => {
    const turnState = openTurn;
    openTurn = undefined;
    if (!turnState || (!turnState.userKey && !turnState.last)) return;
    // No assistant entry = no run evidence: a closed prompt-only turn earns no
    // summary (one hollow "done" per prompt otherwise); only the trailing OPEN
    // turn may stand on the prompt alone, as `running`.
    if (closed && !turnState.last) return;
    const last = turnState.last;
    const terminal = last?.stopReason === 'stop'
      ? 'done'
      : last?.stopReason === 'aborted'
        ? 'cancelled'
        : last?.stopReason === 'error'
          ? 'error'
          : undefined;
    const status = !closed ? 'running' : last?.errored ? 'error' : (terminal ?? 'done');
    const startedAt = turnState.startedAt;
    const completedAt = closed ? last?.completedAt : undefined;
    const duration = closed && startedAt != null && completedAt != null && completedAt >= startedAt
      ? completedAt - startedAt
      : undefined;
    const anchor = turnState.userKey ?? last!.key;
    out.push({
      t: 'run-summary',
      key: `pi:run:${anchor}`,
      turnId: anchor,
      userMessageKey: turnState.userKey,
      assistantMessageKey: last?.anchor,
      status,
      ...(startedAt != null ? { startedAt } : {}),
      ...(completedAt != null ? { completedAt } : {}),
      ...(duration != null ? { totalRuntimeMs: duration } : {}),
      ...(turnState.tokens ? { tokens: turnState.tokens } : {}),
      source: 'pi-bridge-history',
    });
    if (duration != null) {
      totalRuntimeMs += duration;
      turnCount++;
      if (completedAt != null) updatedAt = updatedAt == null ? completedAt : Math.max(updatedAt, completedAt);
    }
  };
  for (const e of entries) {
    if (e?.type !== 'message') continue;
    const m = e.message ?? {};
    const key = String(e.id ?? `h${i++}`);
    if (m.role === 'user') {
      const text = contentText(m.content);
      const userKey = `u${u++}`;
      const sentAt = timeMs(m.timestamp ?? e.timestamp);
      // A later prompt proves the previous run ended even without a terminal stopReason.
      closeTurn(true);
      if (text) out.push({ t: 'user', text, key: userKey, turnId: userKey, sentAt });
      openTurn = { userKey, startedAt: sentAt };
    } else if (m.role === 'assistant') {
      const think = thinkingText(m.content);
      if (think) out.push({ t: 'final', kind: 'thinking', key: `${key}:r`, text: think });
      const text = contentText(m.content);
      if (text) out.push({ t: 'final', kind: 'text', key: `${key}:t`, text });
      if (Array.isArray(m.content))
        for (const p of m.content)
          if (p?.type === 'toolCall')
            out.push({ t: 'tool-call', callId: String(p.id ?? ''), name: String(p.name ?? 'tool'), args: p.arguments });
      openTurn ??= {};
      openTurn.last = {
        key,
        stopReason: typeof m.stopReason === 'string' ? m.stopReason : undefined,
        errored: !!m.error,
        // Entry write time only: the message's own timestamp is its request-creation
        // time and must never stand in for completion.
        completedAt: timeMs(e.timestamp),
        anchor: text ? `${key}:t` : think ? `${key}:r` : undefined,
      };
      if (m.usage) {
        const sum = openTurn.tokens ?? {};
        for (const [field, value] of [
          ['input', m.usage.input],
          ['output', m.usage.output],
          ['cacheRead', m.usage.cacheRead],
          ['cacheWrite', m.usage.cacheWrite],
          ['cost', m.usage.cost?.total],
        ] as const) {
          if (typeof value === 'number' && Number.isFinite(value)) sum[field] = (sum[field] ?? 0) + value;
        }
        openTurn.tokens = sum;
      }
      const terminal = m.stopReason === 'stop' || m.stopReason === 'aborted' || m.stopReason === 'error' || !!m.error;
      if (terminal) closeTurn(true);
    } else if (m.role === 'toolResult') {
      const callId = String(m.toolCallId ?? m.callId ?? m.id ?? '');
      out.push({
        t: 'tool-result',
        callId,
        name: String(m.toolName ?? 'tool'),
        result: contentText(m.content),
        isError: !!m.isError,
        details: m.details,
        args: histArgs.get(callId),
      });
    }
  }
  // A backfill taken mid-run reports the trailing turn as running — never as a
  // completed footer the run has not earned yet.
  closeTurn(false);
  if (turnCount) out.push({ t: 'runtime-totals', value: { totalRuntimeMs, turnCount, updatedAt, source: 'pi-bridge-history' } });
  return out;
}

/** Skills as SlashCommand-ish records, read from the resource loader (`ctx.resourceLoader.getSkills()`).
 *  Empty at session_start (skills load on resources_discover), so callers relay it later too. */
function skillCommands(ctx: any): any[] {
  const out: any[] = [];
  try {
    for (const s of ctx?.resourceLoader?.getSkills?.()?.skills ?? [])
      if (s?.name) out.push({ name: `skill:${s.name}`, description: s.description ? String(s.description) : undefined, kind: 'prompt' });
  } catch {
    /* resourceLoader not ready / not on ctx */
  }
  return dedupeCommands(out);
}

/** Best-effort skills/templates at hello time (usually empty — skills load after session_start). */
function buildCommands(ctx: any): any[] {
  return skillCommands(ctx);
}

/** Skills (and any prompt templates) from a before_agent_start `systemPromptOptions` — verified to
 *  carry the full skill list (27 in testing) once the first turn begins. */
function commandsFromOptions(opts: any): any[] {
  if (!opts) return [];
  const out: any[] = [];
  for (const s of Array.isArray(opts.skills) ? opts.skills : [])
    if (s?.name) out.push({ name: `skill:${s.name}`, description: s.description ? String(s.description) : undefined, kind: 'prompt' });
  for (const p of Array.isArray(opts.prompts) ? opts.prompts : opts.commands ?? [])
    if (p?.name) out.push({ name: String(p.name), description: p.description ? String(p.description) : undefined, kind: 'prompt' });
  return dedupeCommands(out);
}

function dedupeCommands(cmds: any[]): any[] {
  const seen = new Set<string>();
  return cmds.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));
}
function oneLine(err: unknown): string {
  return String(err instanceof Error ? err.message : err).replace(/\s+/g, ' ').slice(0, 180) || 'unknown error';
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
