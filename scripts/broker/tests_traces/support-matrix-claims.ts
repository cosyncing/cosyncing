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

  // F02 true sync
  claim('claude', 'F02', 'partial', 'hooks are answer-only; Drive is app-owned continuation'),
  claim('codex', 'F02', 'full', 'managed app-server live thread'),
  claim('opencode', 'F02', 'full', 'shared opencode serve plus attach TUI'),
  claim('pi', 'F02', 'full', 'bridge extension'),
  claim('omp', 'F02', 'partial', 'bridge extension is wired; real OMP TUI true-sync pass remains'),

  // F03 prompt/queue/stop
  claim('claude', 'F03', 'full', 'Drive prompt/stop; hooks sync cannot inject prompts'),
  claim('codex', 'F03', 'full', 'Drive/live; queued steer guarded'),
  claim('opencode', 'F03', 'full', 'shared server; private Drive partial but prompt path covered'),
  claim('pi', 'F03', 'full', 'resume/bridge; queue semantics partial but prompt/stop path covered'),
  claim('omp', 'F03', 'full', 'resume/bridge; queue semantics partial but prompt/stop path covered'),

  // F04 answer/thinking streaming
  claim('claude', 'F04', 'partial', 'externally launched hooks are block-level; Drive is fuller'),
  claim('codex', 'F04', 'full', 'app-server streaming; observe rollout limited'),
  claim('opencode', 'F04', 'full', 'answer/thinking lanes'),
  claim('pi', 'F04', 'partial', 'live tool-output streaming thinner than RPC history'),
  claim('omp', 'F04', 'partial', 'live tool-output streaming thinner than RPC history'),

  // F05 tool display
  claim('claude', 'F05', 'full', 'common Claude tools, TodoWrite, diffs'),
  claim('codex', 'F05', 'full', 'exec/patch/read/search plus subagent control suppression'),
  claim('opencode', 'F05', 'full', 'bash/edit/read/search summaries'),
  claim('pi', 'F05', 'full', 'common built-ins after enrichment'),
  claim('omp', 'F05', 'full', 'common built-ins after shared-engine enrichment'),

  // F06 permissions
  claim('claude', 'F06', 'full', 'PreToolUse hooks and Drive; L3 app-answer exists'),
  claim('codex', 'F06', 'full', 'app-server permission path'),
  claim('opencode', 'F06', 'full', 'SSE/REST permission path'),
  claim('pi', 'F06', 'full', 'bridge permission and RPC confirm'),
  claim('omp', 'F06', 'full', 'bridge permission and RPC confirm'),

  // F07 questions
  claim('claude', 'F07', 'full', 'AskUserQuestion and Drive'),
  claim('codex', 'F07', 'full', 'app-server tool/MCP questions'),
  claim('opencode', 'F07', 'full', 'SSE/REST question channel'),
  claim('pi', 'F07', 'partial', 'resume/RPC select works; live bridge ask_user works; native TUI dialogs terminal-only'),
  claim('omp', 'F07', 'partial', 'resume/RPC select works; live bridge ask_user works; native TUI dialogs terminal-only'),

  // F08 model/effort/mode display/override
  claim('claude', 'F08', 'full', 'display plus Drive overrides; hooks locked when not injectable'),
  claim('codex', 'F08', 'full', 'display and Drive overrides'),
  claim('opencode', 'F08', 'full', 'model/agent display and override'),
  claim('pi', 'F08', 'full', 'model/thinking display and override'),
  claim('omp', 'F08', 'full', 'model/thinking display and override'),

  // F09 slash commands/skills/templates
  claim('claude', 'F09', 'partial', 'native command discovery; hooks cannot inject prompt commands'),
  claim('codex', 'F09', 'partial', 'native slash/skills where app-server exposes them'),
  claim('opencode', 'F09', 'full', 'server command registry; documented TUI built-ins tracked separately'),
  claim('pi', 'F09', 'full', 'get_commands registry; TUI/RPC-only gaps tracked separately'),
  claim('omp', 'F09', 'full', 'get_available_commands registry; pinned native drift gate remains follow-up work', 'L2'),

  // F10 todo/task list
  claim('claude', 'F10', 'full', 'TodoWrite to task-list-state'),
  claim('codex', 'F10', 'full', 'update_plan to task-list-state'),
  claim('opencode', 'F10', 'full', 'todowrite to task-list-state'),
  claim('pi', 'F10', 'n/a', 'no native todo tool'),
  claim('omp', 'F10', 'n/a', 'no mapped native todo tool'),

  // F11 subagents/workflows/activity
  claim('claude', 'F11', 'full', 'Task plus UltraCode/workflow activity'),
  claim('codex', 'F11', 'full', 'spawn/wait-derived subagents'),
  claim('opencode', 'F11', 'full', 'OpenCode task/subagent progress'),
  claim('pi', 'F11', 'n/a', 'no native subagent/workflow concept'),
  claim('omp', 'F11', 'n/a', 'native subagent events are deliberately outside the v1 adapter'),

  // F12 user-to-agent files
  claim('claude', 'F12', 'full', 'native file/image input through Drive'),
  claim('codex', 'F12', 'full', 'inbox path read by Codex'),
  claim('opencode', 'F12', 'full', 'single and multi-file input'),
  claim('pi', 'F12', 'full', 'byte-exact inbox upload'),
  claim('omp', 'F12', 'full', 'byte-exact inbox upload'),

  // F13 agent-to-user artifacts
  claim('claude', 'F13', 'partial', 'maps native SendUserFile transcript records, but local CLI/Drive exposes no callable delivery tool'),
  claim('codex', 'F13', 'n/a', 'no exact session-qualified delivery route; shared cwd outbox fails closed'),
  claim('opencode', 'F13', 'full', 'session-qualified send_file plus exact native write events'),
  claim('pi', 'F13', 'full', 'session-qualified bridge send-file route'),
  claim('omp', 'F13', 'full', 'session-qualified bridge send-file route'),

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

  // F15 runtime/tokens/context/status
  claim('claude', 'F15', 'full', 'runtime/status/token display with hooks caveat'),
  claim('codex', 'F15', 'full', 'runtime/status; no fabricated token split'),
  claim('opencode', 'F15', 'full', 'runtime/status/tokens; context meter follow-up'),
  claim('pi', 'F15', 'full', 'runtime/status/tokens; context stats follow-up'),
  claim('omp', 'F15', 'full', 'runtime/status/tokens; context stats follow-up'),

  // F16 security/auth/boundaries
  claim('claude', 'F16', 'full', 'hook path auth/data-loss hardening; broader read auth follow-up'),
  claim('codex', 'F16', 'partial', 'path/id guards; app-server auth follows native daemon'),
  claim('opencode', 'F16', 'partial', 'path/artifact guards; shared-server auth is native deployment concern'),
  claim('pi', 'F16', 'partial', 'bridge token/auth plus path guards; broader read auth follow-up'),
  claim('omp', 'F16', 'partial', 'separately scoped bridge token/auth plus path guards; broader read auth follow-up'),
];
