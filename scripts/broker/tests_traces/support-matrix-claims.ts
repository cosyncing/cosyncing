import type { AgentId } from './scenarios.ts';
import type { EvidenceLevel, TaxonomyFunction } from './trace-manifest.ts';

export type SupportLevel = 'full' | 'partial' | 'n/a';

export interface SupportClaim {
  agent: AgentId;
  fn: TaxonomyFunction;
  support: SupportLevel;
  summary: string;
  /**
   * Override the default evidence level when a function has unusual evidence needs. `D` means an exact drift
   * scan is required, not a minimum ordered level.
   */
  requiredLevel?: EvidenceLevel;
  capabilityIds?: string[];
  reviewedNativeVersions?: Partial<Record<AgentId, string>>;
}

export const FULL_SUPPORT_MIN_LEVEL: Record<TaxonomyFunction, EvidenceLevel> = {
  F01: 'L2',
  F02: 'L3',
  F03: 'L2',
  F04: 'L2',
  F05: 'L1',
  F06: 'L2',
  F07: 'L1',
  F08: 'L1',
  F09: 'D',
  F10: 'L1',
  F11: 'L1',
  F12: 'L2',
  F13: 'L1',
  F14: 'L1',
  F15: 'L1',
  F16: 'L1',
};

export const PARTIAL_SUPPORT_MIN_LEVEL: Record<TaxonomyFunction, EvidenceLevel> = {
  F01: 'L0',
  F02: 'L0',
  F03: 'L0',
  F04: 'L0',
  F05: 'L0',
  F06: 'L0',
  F07: 'L0',
  F08: 'L0',
  F09: 'D',
  F10: 'L0',
  F11: 'L0',
  F12: 'L0',
  F13: 'L0',
  F14: 'L0',
  F15: 'L0',
  F16: 'L0',
};

function claim(
  agent: AgentId,
  fn: TaxonomyFunction,
  support: SupportLevel,
  summary: string,
  requiredLevel?: EvidenceLevel,
  extra?: Pick<SupportClaim, 'capabilityIds' | 'reviewedNativeVersions'>,
): SupportClaim {
  return { agent, fn, support, summary, ...(requiredLevel ? { requiredLevel } : {}), ...(extra ?? {}) };
}

export const SUPPORT_MATRIX_CLAIMS: SupportClaim[] = [
  // F01 discover/history/reattach
  claim('claude', 'F01', 'full', 'JSONL observe plus Drive/resume'),
  claim('codex', 'F01', 'full', 'rollout observe plus app-server resume/live'),
  claim('opencode', 'F01', 'full', 'shared-server plus private observe'),
  claim('pi', 'F01', 'full', 'JSONL/RPC observe plus bridge'),
  claim('omp', 'F01', 'full', 'JSONL/RPC observe plus bridge'),
  claim('reasonix', 'F01', 'full', 'bounded file-store observe plus ACP create/load and cross-client reattach'),
  claim('grok', 'F01', 'full', 'bounded local-store Observe plus authenticated ACP create/load, Drive, and cross-client reattach on 1.0.13 or newer'),
  claim('cline', 'F01', 'partial', 'bounded parent/subagent Observe plus isolated managed-Hub Create/Drive and cross-client reattach on 3.0.61 or newer; a replacement Hub epoch revokes Drive'),
  claim('kilo', 'F01', 'full', 'bounded SQLite Observe plus authenticated managed-server create, live attach, and restart reattach on 7.4.23 or newer'),

  // F02 true sync
  claim('claude', 'F02', 'partial', 'hooks are answer-only; Drive is app-owned continuation'),
  claim('codex', 'F02', 'full', 'managed app-server live thread'),
  claim('opencode', 'F02', 'full', 'shared opencode serve plus attach TUI'),
  claim('pi', 'F02', 'full', 'bridge extension'),
  claim('omp', 'F02', 'partial', 'bridge true-sync is physically proved for the measured version; reusable L3 TUI drift coverage remains outside the tracked matrix'),
  claim('reasonix', 'F02', 'n/a', 'broker-owned ACP has no terminal join; exact --resume session targeting is unpinned'),
  claim('grok', 'F02', 'n/a', 'exact-id terminal resume is a separate handoff process; Grok exposes no measured live terminal-join channel'),
  claim('cline', 'F02', 'n/a', 'cline --id starts a separate handoff process; no measured channel joins that process to the broker-owned Hub Drive'),
  claim('kilo', 'F02', 'n/a', 'the broker manages a dedicated authenticated loopback host on port 4097, but no exact-session terminal join has been captured'),

  // F03 prompt/queue/stop
  claim('claude', 'F03', 'full', 'Drive prompt/stop; hooks sync cannot inject prompts'),
  claim('codex', 'F03', 'full', 'Drive/live; queued steer guarded'),
  claim('opencode', 'F03', 'full', 'shared server; private Drive partial but prompt path covered'),
  claim('pi', 'F03', 'full', 'resume/bridge; queue semantics partial but prompt/stop path covered'),
  claim('omp', 'F03', 'full', 'resume/bridge; queue semantics partial but prompt/stop path covered'),
  claim('reasonix', 'F03', 'full', 'ACP prompt FIFO, pending replay, cancel, and detected ownership-loss stop'),
  claim('grok', 'F03', 'full', 'authenticated ACP Drive serializes prompts, reconciles durable echoes, cancels turns, and revokes on ownership loss'),
  claim('cline', 'F03', 'full', 'isolated Hub Drive serializes run.start, reconciles queued echoes after terminal reply plus durable reread, aborts turns, and revokes on ownership loss'),
  claim('kilo', 'F03', 'full', 'authenticated prompt_async, abort, echo correlation, and broker-owned single-writer boundaries ship on the managed host'),

  // F04 answer/thinking streaming
  claim('claude', 'F04', 'partial', 'externally launched hooks are block-level; Drive is fuller'),
  claim('codex', 'F04', 'full', 'app-server streaming; observe rollout limited'),
  claim('opencode', 'F04', 'full', 'answer/thinking lanes'),
  claim('pi', 'F04', 'partial', 'live tool-output streaming thinner than RPC history'),
  claim('omp', 'F04', 'partial', 'live tool-output streaming thinner than RPC history'),
  claim('reasonix', 'F04', 'partial', 'ACP answer/thinking lanes converge with flat replay; tool progress is terminal-only'),
  claim('grok', 'F04', 'partial', 'ACP answer/thinking chunks share one live/replay fold; installed streaming/final convergence is proved, while upstream chunk cadence remains undocumented'),
  claim('cline', 'F04', 'partial', 'live Hub answer/reasoning events and stored blocks converge through canonical presentation; native flush granularity remains unverified'),
  claim('kilo', 'F04', 'partial', 'live SSE and SQLite replay share answer/reasoning semantics and stable part identity; installed streaming/final convergence is proved, while upstream chunk cadence remains undocumented'),

  // F05 tool display
  claim('claude', 'F05', 'full', 'common Claude tools, TodoWrite, diffs'),
  claim('codex', 'F05', 'full', 'exec/patch/read/search plus subagent control suppression'),
  claim('opencode', 'F05', 'full', 'bash/edit/read/search summaries'),
  claim('pi', 'F05', 'full', 'common built-ins after enrichment'),
  claim('omp', 'F05', 'full', 'common built-ins after shared-engine enrichment'),
  claim('reasonix', 'F05', 'partial', 'ACP tool titles and bounded raw results are preserved without path/diff enrichment'),
  claim('grok', 'F05', 'partial', 'ACP tool metadata, arguments, and bounded results are preserved without unmeasured path/diff promotion'),
  claim('cline', 'F05', 'partial', 'live Hub and stored tool identities, names, bounded payloads, and subagent activity render without guessed path/diff promotion'),
  claim('kilo', 'F05', 'n/a', 'a synthetic shared-lineage mapper candidate exists, but no native Kilo tool part has been captured; tool identity, display, paths, and diffs remain unsupported'),

  // F06 permissions
  claim('claude', 'F06', 'full', 'PreToolUse hooks and Drive; L3 app-answer exists'),
  claim('codex', 'F06', 'full', 'app-server permission path'),
  claim('opencode', 'F06', 'full', 'SSE/REST permission path'),
  claim('pi', 'F06', 'full', 'bridge permission and RPC confirm'),
  claim('omp', 'F06', 'full', 'bridge permission and RPC confirm'),
  claim('reasonix', 'F06', 'full', 'per-tool ACP permission cards round-trip canonical allow/reject decisions'),
  // Measured 2026-09-03 on the pinned 1.0.13 through the installed broker: three tool classes
  // -- shell inside the session directory, shell outside it, and the native file-edit tool --
  // each executed with no `session/request_permission` reaching the client. The binary does
  // ship the method, so this is not a removed capability: cosyncing implements no client-side
  // `fs`/`terminal` (acp-client/src/dispatch.ts handles only session/request_permission and
  // session/update), so `clientCapabilities: {}` is honest and Grok runs every tool in-process
  // with nothing to ask this client about. The round-trip is real but is exercised only by
  // `writeFakeGrokBinary`, which does send the request; the shipped agent does not.
  claim('grok', 'F06', 'partial', 'the adapter maps allow-once and reject option ids and settles cards, but shipped Grok issues no permission request through this client: cosyncing delegates no fs/terminal execution, so tools run in-process'),
  claim('cline', 'F06', 'full', 'managed-Hub per-tool approval cards round-trip approve/reject and are cancelled on stop, close, or ownership loss'),
  claim('kilo', 'F06', 'full', 'authenticated per-tool HTTP/SSE permission requests and replies preserve actionable ownership'),

  // F07 questions
  claim('claude', 'F07', 'full', 'AskUserQuestion and Drive'),
  claim('codex', 'F07', 'full', 'app-server tool/MCP questions'),
  claim('opencode', 'F07', 'full', 'SSE/REST question channel'),
  claim('pi', 'F07', 'partial', 'resume/RPC select works; live bridge ask_user works; native TUI dialogs terminal-only'),
  claim('omp', 'F07', 'partial', 'resume/RPC select works; live bridge ask_user works; native TUI dialogs terminal-only'),
  claim('reasonix', 'F07', 'n/a', 'no measured ACP question request route; unknown requests fail closed'),
  claim('grok', 'F07', 'n/a', 'no measured Grok ACP question request route; unknown requests fail closed'),
  claim('cline', 'F07', 'n/a', 'no measured Cline snapshot block or hub route represents an actionable question request'),
  claim('kilo', 'F07', 'n/a', 'no measured Kilo SQLite part or SDK route represents an actionable question request'),

  // F08 model/effort/mode display/override
  claim('claude', 'F08', 'full', 'display plus Drive overrides; hooks locked when not injectable'),
  claim('codex', 'F08', 'full', 'display and Drive overrides'),
  claim('opencode', 'F08', 'full', 'model/agent display and override'),
  claim('pi', 'F08', 'full', 'model/thinking display and override'),
  claim('omp', 'F08', 'full', 'model/thinking display and override'),
  claim('reasonix', 'F08', 'partial', 'durable provider/model identity is displayed; existing-session model switch is unsupported'),
  claim('grok', 'F08', 'full', 'durable labels plus ACP model, effort, and mode selection survive create, relaunch, replay, and restart'),
  claim('cline', 'F08', 'partial', 'durable labels plus configured provider/model and ask/auto/plan mode propagate at managed creation; per-turn switching remains disabled'),
  claim('kilo', 'F08', 'partial', 'provider model labels and model selection propagate through create, live SSE, replay, and restart; no measured permission-mode vocabulary exists'),

  // F09 slash commands/skills/templates
  claim('claude', 'F09', 'partial', 'native command discovery; hooks cannot inject prompt commands'),
  claim('codex', 'F09', 'partial', 'native slash/skills where app-server exposes them'),
  claim('opencode', 'F09', 'full', 'server command registry; documented TUI built-ins tracked separately'),
  claim('pi', 'F09', 'full', 'get_commands registry; TUI/RPC-only gaps tracked separately'),
  claim('omp', 'F09', 'full', 'get_available_commands registry; pinned native drift gate remains follow-up work', 'L2'),
  claim('reasonix', 'F09', 'partial', 'protocol-shaped ACP command snapshots and prompt invocation; native payload/invocation capture remains a gap', 'L2'),
  claim('grok', 'F09', 'partial', 'ACP command catalogs and invocation ship on 1.0.13 or newer; native command breadth remains narrower than terminal documentation', 'L2'),
  claim('cline', 'F09', 'n/a', 'rewritten snapshots and the measured Hub expose no slash-command registry; Drive advertises only its lifecycle Stop action'),
  claim('kilo', 'F09', 'n/a', 'the measured store exposes no command registry and Observe has no prompt-command path'),

  // F10 todo/task list
  claim('claude', 'F10', 'full', 'TodoWrite to task-list-state'),
  claim('codex', 'F10', 'full', 'update_plan to task-list-state'),
  claim('opencode', 'F10', 'full', 'todowrite to task-list-state'),
  claim('pi', 'F10', 'n/a', 'no native todo tool'),
  claim('omp', 'F10', 'n/a', 'no mapped native todo tool'),
  claim('reasonix', 'F10', 'n/a', 'no native task-list record or mapped todo tool'),
  claim('grok', 'F10', 'partial', 'measured task_completed snapshots map to native task-list state; mutation controls are not exposed'),
  claim('cline', 'F10', 'n/a', 'no measured Cline snapshot block carries a native todo or task-list state'),
  claim('kilo', 'F10', 'n/a', 'the shared mapper recognizes OpenCode-lineage todos, but no Kilo todo capture exists to advertise the feature'),

  // F11 subagents/workflows/activity
  claim('claude', 'F11', 'full', 'Task plus UltraCode/workflow activity'),
  claim('codex', 'F11', 'full', 'spawn/wait-derived subagents'),
  claim('opencode', 'F11', 'full', 'OpenCode task/subagent progress'),
  claim('pi', 'F11', 'n/a', 'no native subagent/workflow concept'),
  claim('omp', 'F11', 'n/a', 'native subagent events are deliberately outside the v1 adapter'),
  claim('reasonix', 'F11', 'n/a', 'subagent command exists, but no child-session store shape has been measured'),
  claim('grok', 'F11', 'partial', 'measured background-task activity renders and exact native parent/child metadata publishes a linked child roster row; child sessions remain Observe-only'),
  claim('cline', 'F11', 'partial', 'spawn_agent activity and measured parent/subagent document identities render; team/workflow controls remain unsupported'),
  claim('kilo', 'F11', 'partial', 'a live-qualified native parent_id capture publishes linked child rows as Observe-only with no child writer controls'),

  // F12 user-to-agent files
  claim('claude', 'F12', 'full', 'native file/image input through Drive'),
  claim('codex', 'F12', 'full', 'inbox path read by Codex'),
  claim('opencode', 'F12', 'full', 'single and multi-file input'),
  claim('pi', 'F12', 'full', 'byte-exact inbox upload'),
  claim('omp', 'F12', 'full', 'byte-exact inbox upload'),
  claim('reasonix', 'F12', 'n/a', 'native file and image input are disabled until an attachment echo is measured'),
  claim('grok', 'F12', 'n/a', 'native file and image input are disabled until an ACP/store echo capture proves identity and replay'),
  claim('cline', 'F12', 'n/a', 'native file and image input remain disabled until their exact durable attachment echo is captured'),
  claim('kilo', 'F12', 'n/a', 'native file and image input remain disabled until an attachment echo and ownership route are captured'),

  // F13 agent-to-user artifacts
  claim('claude', 'F13', 'partial', 'maps native SendUserFile records and auto-surfaces its native Write of a deliverable file inside cwd; still partial because local CLI/Drive exposes no callable delivery tool'),
  claim('codex', 'F13', 'n/a', 'no exact session-qualified delivery route; shared cwd outbox fails closed'),
  claim('opencode', 'F13', 'full', 'session-qualified send_file plus exact native write events'),
  claim('pi', 'F13', 'full', 'session-qualified bridge send-file route'),
  claim('omp', 'F13', 'full', 'session-qualified bridge send-file route'),
  claim('reasonix', 'F13', 'n/a', 'no measured session-qualified artifact delivery route'),
  claim('grok', 'F13', 'n/a', 'no measured session-qualified artifact delivery route'),
  claim('cline', 'F13', 'n/a', 'no measured session-qualified artifact delivery block or callable route'),
  claim('kilo', 'F13', 'n/a', 'no measured session-qualified artifact delivery part or callable route'),

  // F14 lifecycle/history mutation
  claim('claude', 'F14', 'partial', 'resume/Drive/stop; fork/rename/export gaps'),
  claim('codex', 'F14', 'partial', 'observe/resume/live; archive/delete/fork UI gaps'),
  claim('opencode', 'F14', 'partial', 'rename/fork plus stop/compact/undo/redo; export mapped (needs L2); timeline gap remains', undefined, {
    capabilityIds: [
      'opencode.server.session.rename',
      'opencode.server.session.fork',
      'opencode.cli.export',
      'opencode.server.session.timeline',
    ],
    reviewedNativeVersions: { opencode: '1.16.2' },
  }),
  claim('pi', 'F14', 'partial', 'create/reload/quit/fork/clone/name covered; switch excluded by review; export mapped (needs L2)', undefined, {
    capabilityIds: ['pi.rpc.set_session_name', 'pi.rpc.fork', 'pi.rpc.clone', 'pi.rpc.export_html'],
    reviewedNativeVersions: { pi: '0.78.1' },
  }),
  claim('omp', 'F14', 'partial', 'create/reload/quit/name/export covered; fork and clone are unavailable through RPC', undefined, {
    reviewedNativeVersions: { omp: '17.4.2' },
  }),
  claim('reasonix', 'F14', 'partial', 'durable create/load/cancel and rewrite reset; rename, fork, and export are unsupported', undefined, {
    reviewedNativeVersions: { reasonix: '1.25.2' },
  }),
  claim('grok', 'F14', 'partial', 'create, durable load, cancel, history reset, and exact-id terminal handoff ship; rename, fork, clone, and export are unsupported', undefined, {
    reviewedNativeVersions: { grok: '1.0.13' },
  }),
  claim('cline', 'F14', 'partial', 'managed create/resume/stop, Observe rewrite reset, native rename, and exact-id terminal handoff ship; replacement-Hub resume, fork, clone, and export are unsupported', undefined, {
    reviewedNativeVersions: { cline: '3.0.61' },
  }),
  claim('kilo', 'F14', 'partial', 'create, live attach, cancel, native rename, and retained-history reset ship; terminal handoff, fork, clone, and export are unsupported', undefined, {
    reviewedNativeVersions: { kilo: '7.4.23' },
  }),

  // F15 runtime/tokens/context/status
  claim('claude', 'F15', 'full', 'runtime/status/token display with hooks caveat'),
  claim('codex', 'F15', 'full', 'runtime/status; no fabricated token split'),
  claim('opencode', 'F15', 'full', 'runtime/status/tokens; context meter follow-up'),
  claim('pi', 'F15', 'full', 'runtime/status/tokens plus exact native used/max context stats'),
  claim('omp', 'F15', 'full', 'runtime/status/tokens plus exact native used/max context stats'),
  claim('reasonix', 'F15', 'partial', 'assistant runtime, status, cumulative tokens, and cost map with monotonic partial-update merging; no measured context maximum exists'),
  claim('grok', 'F15', 'partial', 'turn completion, status, per-turn tokens, run summaries, and aggregate context usage map without fabricated cumulative totals'),
  claim('cline', 'F15', 'partial', 'live Hub status/tokens plus durable run summaries, cache-inclusive token metrics, and cost render without double-counting; no trustworthy context maximum exists'),
  claim('kilo', 'F15', 'partial', 'live status, run summaries, model identity, cache-aware tokens, and cost render; no measured context used/max pair exists'),

  // F16 security/auth/boundaries
  claim('claude', 'F16', 'full', 'hook path auth/data-loss hardening; broader read auth follow-up'),
  claim('codex', 'F16', 'partial', 'path/id guards; app-server auth follows native daemon'),
  claim('opencode', 'F16', 'partial', 'path/artifact guards; shared-server auth is native deployment concern'),
  claim('pi', 'F16', 'partial', 'bridge token/auth plus path guards; broader read auth follow-up'),
  claim('omp', 'F16', 'partial', 'separately scoped bridge token/auth plus path guards; broader read auth follow-up'),
  claim('reasonix', 'F16', 'partial', 'local stdio, component-checked store reads, schema/path/frame bounds, and ownership fences; native per-write identity is unmeasured'),
  claim('grok', 'F16', 'partial', 'no-follow bounded store reads, authenticated floored-version ACP, path/frame limits, provenance, and foreign-writer demotion ship'),
  claim('cline', 'F16', 'partial', 'no-follow bounded snapshots plus owner-only Hub discovery, isolated profile/port, floored-version gate, frame bounds, epoch fencing, and foreign-run demotion ship'),
  claim('kilo', 'F16', 'partial', 'no-follow bounded SQLite, floored-version Basic-auth host, dedicated-port ownership proof, origin-bound credentials, and writer demotion ship'),
];
