import type { AgentId } from './scenarios.ts';

export const TAXONOMY_FUNCTIONS = [
  'F01',
  'F02',
  'F03',
  'F04',
  'F05',
  'F06',
  'F07',
  'F08',
  'F09',
  'F10',
  'F11',
  'F12',
  'F13',
  'F14',
  'F15',
  'F16',
] as const;

export const EVIDENCE_LEVELS = ['L0', 'L1', 'L2', 'L3', 'D'] as const;

export type TaxonomyFunction = (typeof TAXONOMY_FUNCTIONS)[number];
export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export interface FunctionCoverage {
  fn: TaxonomyFunction;
  level: EvidenceLevel;
  agents: AgentId[] | 'all';
  note?: string;
}

export interface TraceManifestEntry {
  file: string;
  title: string;
  optIn?: boolean;
  capabilityIds?: string[];
  nativeVersion?: string;
  sourceLockIds?: string[];
  coverage: FunctionCoverage[];
}

/**
 * Browser traces retired when the PoC UI mount was removed.
 *
 * Every one of these drove a real browser at `/poc-ui/`, directly or through `pyOpenOnlySession` /
 * `spawnPermissionClickDriver`. The broker stopped serving that mount and now answers it with a plain 404,
 * so the navigation lands on nothing and the drivers assert against a page that does not exist. A trace that
 * cannot pass is not evidence, and leaving it in {@link TRACE_MANIFEST} would have the support matrix keep
 * citing it.
 *
 * They are not migrated because there is nothing yet to migrate them to. The replacement mount is `/cosy/`,
 * the Flutter client, which renders to a canvas: none of the DOM selectors these drivers use survive the
 * move, and driving it needs a web build (`bun run client:build:web`) that this tree does not carry. The
 * work is a re-authoring against Flutter's semantics tree, not a change of URL.
 *
 * Replaced by: `/cosy/` equivalents, once a Flutter web build exists to drive. Until then the files stay on
 * disk — their broker-side setup is the reusable half — and refuse to run rather than fail obscurely.
 */
export const RETIRED_POC_UI_TRACES: readonly string[] = [
  'scripts/broker/tests_traces/_app-trace-helpers.ts',
  'scripts/broker/tests_traces/_real-tui-app-helpers.ts',
  'scripts/broker/tests_traces/claude-app-answer-trace.ts',
  'scripts/broker/tests_traces/claude-app-answer-real-tui-trace.ts',
  'scripts/broker/tests_traces/claude-display-trace.ts',
  'scripts/broker/tests_traces/codex-app-answer-trace.ts',
  'scripts/broker/tests_traces/codex-app-answer-real-tui-trace.ts',
  'scripts/broker/tests_traces/codex-display-trace.ts',
  'scripts/broker/tests_traces/codex-real-native-model-change-trace.ts',
  'scripts/broker/tests_traces/opencode-app-answer-trace.ts',
  'scripts/broker/tests_traces/opencode-app-answer-real-tui-trace.ts',
  'scripts/broker/tests_traces/opencode-display-trace.ts',
  'scripts/broker/tests_traces/pi-app-answer-trace.ts',
  'scripts/broker/tests_traces/pi-app-answer-real-tui-trace.ts',
  'scripts/broker/tests_traces/pi-display-trace.ts',
  'scripts/broker/tests_traces/sync-refactor-dom-probe.ts',
  'scripts/broker/tests_traces/two-tab-draft-sync-trace.ts',
];

export const TRACE_MANIFEST: TraceManifestEntry[] = [
  {
    file: 'scripts/broker/conformance.ts',
    title: 'canonical render coverage and adapter command/model drift',
    coverage: [
      { fn: 'F08', level: 'D', agents: ['opencode', 'pi', 'claude', 'codex'], note: 'model and mode drift where live probes are available' },
      { fn: 'F09', level: 'D', agents: ['opencode', 'pi', 'claude', 'codex'], note: 'command registry drift for adapters with required native probes' },
      { fn: 'F16', level: 'L0', agents: 'all', note: 'render blank-drop gate for canonical message types' },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/transport-crypto-broker-trace.ts',
    title: 'Secure transport and crypto adoption through real broker mailbox',
    coverage: [
      { fn: 'F16', level: 'L2', agents: 'all', note: 'independent persisted pairing keys, QR public-key exchange, sender verification, replay rejection, tamper rejection, and broker-opaque ciphertext carriage' },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/transport-session-control-reference-trace.ts',
    title: 'Encrypted session-control reference path through broker pairing and mailbox',
    coverage: [
      { fn: 'F06', level: 'L2', agents: 'all', note: 'approval-shaped control payload rides encrypted broker mailbox envelope' },
      { fn: 'F07', level: 'L2', agents: 'all', note: 'question-answer-shaped control payload rides encrypted broker mailbox envelope' },
      { fn: 'F10', level: 'L2', agents: 'all', note: 'plan-action-shaped control payload rides encrypted broker mailbox envelope' },
      { fn: 'F16', level: 'L2', agents: 'all', note: 'pairing registry, opaque ciphertext carriage, replay rejection, and revoke rejection for control envelopes' },
    ],
  },
  {
    file: 'packages/typescript/broker/test/crypto/test-pairing-key-store.ts',
    title: 'crypto pairing key-store regression suite',
    coverage: [
      { fn: 'F16', level: 'L0', agents: 'all', note: 'local persisted identity/exchange keys, QR private-key omission, DataKey wrap/unwrap wrong-key rejection' },
    ],
  },
  {
    file: 'scripts/broker/tests/app/test-web-ui-static.ts',
    title: 'static app and broker contract guards',
    coverage: [
      { fn: 'F01', level: 'L0', agents: 'all', note: 'attach/cache/history contract guards' },
      { fn: 'F02', level: 'L0', agents: 'all', note: 'control/sync UI invariants' },
      { fn: 'F06', level: 'L0', agents: 'all', note: 'pending permission actionability and read-only guards' },
      { fn: 'F07', level: 'L0', agents: 'all', note: 'question answer actionability and read-only guards' },
      { fn: 'F08', level: 'L0', agents: 'all', note: 'statusline and picker invariants' },
      { fn: 'F10', level: 'L0', agents: 'all', note: 'task-list-state renderer scaffold and plan-action lifecycle controls' },
      { fn: 'F11', level: 'L0', agents: 'all', note: 'goal/background activity bars' },
      { fn: 'F12', level: 'L0', agents: 'all', note: 'file upload control and read-only guard' },
      { fn: 'F13', level: 'L0', agents: 'all', note: 'artifact identity, lazy load, and cache guards' },
      { fn: 'F15', level: 'L0', agents: 'all', note: 'runtime/token/context statusline guards' },
      { fn: 'F16', level: 'L0', agents: 'all', note: 'auth token on mutating app fetches and WebSocket stream' },
    ],
  },
  {
    file: 'scripts/broker/tests/app/test-web-ui-components.ts',
    title: 'web app component DOM guards for interaction surfaces',
    coverage: [
      { fn: 'F10', level: 'L1', agents: 'all', note: 'plan-like task-list panels emit semantic plan-action frames from the real app renderer' },
      { fn: 'F13', level: 'L1', agents: 'all', note: 'interactive HTML artifact opens in a sandboxed signed-URL iframe and forwards cosyncing-bridge interactions over the session WebSocket' },
      { fn: 'F16', level: 'L1', agents: 'all', note: 'artifact iframe messages are accepted only from app-registered frames and ride the authenticated session stream' },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/artifact-sandbox-browser-trace.ts',
    title: 'real Chromium adversarial artifact sandbox trace',
    coverage: [
      { fn: 'F13', level: 'L1', agents: 'all', note: 'real browser loads signed HTML artifact, injected bridge forwards a valid form interaction through the app WebSocket' },
      { fn: 'F16', level: 'L1', agents: 'all', note: 'real browser proves CSP blocks non-nonce script and exfil fetch/beacon, and app drops forged nested postMessage source' },
    ],
  },
  {
    file: 'packages/typescript/broker/test/opencode/test-opencode.ts',
    title: 'OpenCode integration suite including file input/output',
    coverage: [
      { fn: 'F12', level: 'L2', agents: ['opencode'], note: 'single and multi-file upload reaches the agent' },
      { fn: 'F13', level: 'L2', agents: ['opencode'], note: 'session-qualified send_file artifact path' },
    ],
  },
  {
    file: 'packages/typescript/adapters/opencode/test/test-opencode-private.ts',
    title: 'OpenCode private Drive runtime and streaming suite',
    coverage: [
      { fn: 'F04', level: 'L2', agents: ['opencode'], note: 'raw run answer/tool/token lanes' },
      { fn: 'F15', level: 'L2', agents: ['opencode'], note: 'private runtime/token/run-summary mapping' },
    ],
  },
  {
    file: 'packages/typescript/broker/test/pi/test-pi.ts',
    title: 'Pi integration suite including file input/output',
    coverage: [
      { fn: 'F04', level: 'L2', agents: ['pi'], note: 'Pi JSONL/RPC text/thinking lanes' },
      { fn: 'F12', level: 'L2', agents: ['pi'], note: 'byte-exact inbox upload' },
      { fn: 'F13', level: 'L2', agents: ['pi'], note: 'session-qualified bridge send-file surfaces as file-artifact' },
    ],
  },
  {
    file: 'packages/typescript/broker/test/pi/test-tool-result-enrich.ts',
    title: 'Pi tool-result, bridge option, approval, question, and runtime suite',
    coverage: [
      { fn: 'F05', level: 'L2', agents: ['pi'], note: 'diff/path/exit/truncation enrichment' },
      { fn: 'F07', level: 'L2', agents: ['pi'], note: 'live bridge ask_user tool emits question-request and receives app answer command' },
      { fn: 'F08', level: 'L2', agents: ['pi'], note: 'bridge model/effort options, native model-change sessionInfo, and prompt/command switching' },
      { fn: 'F15', level: 'L2', agents: ['pi'], note: 'bridge runtime wire and token/status metadata' },
      { fn: 'F16', level: 'L2', agents: ['pi'], note: 'bridge auth/policy and dangerous-bash approval policy' },
    ],
  },
  {
    file: 'packages/typescript/adapters/omp/test/test-omp-discovery.ts',
    title: 'omp JSONL discovery and dialect-delta mapping suite',
    nativeVersion: '17.4.2',
    coverage: [
      { fn: 'F01', level: 'L2', agents: ['omp'], note: 'leading title slot, session header discovery, and stable session identity' },
      { fn: 'F04', level: 'L2', agents: ['omp'], note: 'shared JSONL mapper consumes omp session history' },
      { fn: 'F08', level: 'L2', agents: ['omp'], note: 'combined provider/modelId model_change maps to canonical model identity' },
      { fn: 'F14', level: 'L1', agents: ['omp'], note: 'last-write-wins title and title_change lifecycle metadata' },
      { fn: 'F15', level: 'L1', agents: ['omp'], note: 'model/status metadata survives discovery' },
    ],
  },
  {
    file: 'packages/typescript/adapters/omp/test/test-omp-lifecycle.ts',
    title: 'omp fake-stdio RPC resume and lifecycle suite',
    nativeVersion: '17.4.2',
    coverage: [
      { fn: 'F01', level: 'L2', agents: ['omp'], note: 'fake native --mode rpc create and resume path' },
      { fn: 'F03', level: 'L2', agents: ['omp'], note: 'resume connection uses the native stdio RPC transport' },
      { fn: 'F05', level: 'L2', agents: ['omp'], note: 'native tool events use the shared enriched result mapper' },
      { fn: 'F08', level: 'L2', agents: ['omp'], note: 'get_state model identity maps through the shared engine' },
      { fn: 'F09', level: 'L2', agents: ['omp'], note: 'fake native RPC requires get_available_commands and refuses pi-only get_commands' },
      { fn: 'F12', level: 'L2', agents: ['omp'], note: 'file input writes byte-exact inbox content and sends its absolute path in the same turn' },
      { fn: 'F14', level: 'L2', agents: ['omp'], note: 'native create/name path and explicit no-fork/no-clone surface' },
    ],
  },
  {
    file: 'packages/typescript/adapters/omp/test/test-omp-bridge-asset.ts',
    title: 'omp bridge asset dialect and compatibility guards',
    nativeVersion: '17.4.2',
    coverage: [
      { fn: 'F02', level: 'L2', agents: ['omp'], note: 'installed bridge uses omp routes, credentials, event keys, and feature-detect guards' },
      { fn: 'F16', level: 'L2', agents: ['omp'], note: 'omp credential namespace is disjoint from pi and asset bytes are ownership-stamped' },
    ],
  },
  {
    file: 'packages/typescript/adapters/omp/test/test-omp-runtime-readiness.ts',
    title: 'omp Bun and package readiness qualification suite',
    nativeVersion: '17.4.2',
    coverage: [
      { fn: 'F15', level: 'L1', agents: ['omp'], note: 'runtime and native package versions are qualified before create/resume' },
      { fn: 'F16', level: 'L1', agents: ['omp'], note: 'unverifiable and below-floor launchers fail closed' },
    ],
  },
  {
    file: 'packages/typescript/adapters/omp/test/test-omp-protocol-parity.ts',
    title: 'omp 17.4.2 fixture/adapter protocol lock with optional native source audit',
    nativeVersion: '17.4.2',
    coverage: [
      { fn: 'F04', level: 'L2', agents: ['omp'], note: 'reviewed fixture matches the shared engine consumed-event set; installed native source audit is optional' },
      { fn: 'F08', level: 'L2', agents: ['omp'], note: 'reviewed fixture requires the RPC model commands used by the adapter' },
      { fn: 'F09', level: 'L2', agents: ['omp'], note: 'reviewed fixture carries get_available_commands and omits get_commands' },
      { fn: 'F14', level: 'L2', agents: ['omp'], note: 'reviewed fixture carries set_session_name/export and omits fork/clone' },
    ],
  },
  {
    file: 'packages/typescript/broker/test/omp/test-omp-bridge.ts',
    title: 'omp broker bridge identity and live-wire suite',
    coverage: [
      { fn: 'F01', level: 'L2', agents: ['omp'], note: 'disk and bridge discovery converge on one canonical session id' },
      { fn: 'F02', level: 'L2', agents: ['omp'], note: 'bidirectional app/extension bridge wire and reload continuity' },
      { fn: 'F03', level: 'L2', agents: ['omp'], note: 'app prompt reaches the extension command queue' },
      { fn: 'F09', level: 'L2', agents: ['omp'], note: 'bridge command queue uses omp route identity' },
      { fn: 'F15', level: 'L2', agents: ['omp'], note: 'run summaries preserve omp key/source identity' },
      { fn: 'F16', level: 'L2', agents: ['omp'], note: 'revision gating and post-teardown route refusal' },
    ],
  },
  {
    file: 'packages/typescript/broker/test/codex/rollout.ts',
    title: 'Codex rollout mapping and runtime suite',
    coverage: [
      { fn: 'F04', level: 'L2', agents: ['codex'], note: '0.146 new-only, legacy-only, and dual-emission assistant text across cold history and live follow' },
      { fn: 'F15', level: 'L2', agents: ['codex'], note: 'sentAt/run-summary/runtimeTotals and token policy' },
      { fn: 'F16', level: 'L2', agents: ['codex'], note: 'observe-first Drive gating and control-state metadata' },
    ],
  },
  {
    file: 'packages/typescript/broker/test/codex/resume-fake.ts',
    title: 'Codex fake app-server resume, model, permissions, and lifecycle suite',
    coverage: [
      { fn: 'F01', level: 'L2', agents: ['codex'], note: 'native create/resume metadata through fake app-server' },
      { fn: 'F03', level: 'L2', agents: ['codex'], note: 'queued steer and early stop' },
      { fn: 'F06', level: 'L2', agents: ['codex'], note: 'pending approval replay and permission modes' },
      { fn: 'F07', level: 'L2', agents: ['codex'], note: 'waiting-on-user-input placeholder path' },
      { fn: 'F08', level: 'L2', agents: ['codex'], note: 'model/effort options and native app-server model notification refresh' },
      { fn: 'F15', level: 'L2', agents: ['codex'], note: 'app-server timestamp/run-summary/runtimeTotals mapping' },
    ],
  },
  {
    file: 'packages/typescript/broker/test/codex/resume.ts',
    title: 'Codex live resume suite including file input',
    optIn: true,
    coverage: [
      { fn: 'F12', level: 'L2', agents: ['codex'], note: 'inbox path is written and read by Codex' },
    ],
  },
  {
    file: 'packages/typescript/adapters/claude/test/test-claude-drive-surface.ts',
    title: 'Claude Drive surface including native file and image input',
    coverage: [
      { fn: 'F03', level: 'L2', agents: ['claude'], note: 'Drive prompt and stop command with stubbed process' },
      { fn: 'F12', level: 'L2', agents: ['claude'], note: 'inbox path-ref and image block input' },
      { fn: 'F08', level: 'L2', agents: ['claude'], note: 'model/mode reassertion on Drive' },
    ],
  },
  {
    file: 'packages/typescript/adapters/claude/test/test-claude-takeover.ts',
    title: 'Claude takeover refusal and roster-visible shared drive ownership (issue 15a/15b)',
    coverage: [
      { fn: 'F14', level: 'L2', agents: ['claude'], note: 'mid-turn terminal takeover refused; idle terminal resumes in place; adapter drive registry publishes driving on the roster and reverts on close' },
    ],
  },
  {
    file: 'packages/typescript/adapters/claude/test/test-claude-jsonl.ts',
    title: 'Claude transcript mapping, streaming lanes, tool enrichment, and token suite',
    coverage: [
      { fn: 'F04', level: 'L2', agents: ['claude'], note: 'model-output/thinking/tool lane mapping from JSONL' },
      { fn: 'F05', level: 'L2', agents: ['claude'], note: 'Bash/Edit/Read/Grep tool-result enrichment' },
      { fn: 'F15', level: 'L2', agents: ['claude'], note: 'token-count dedup and runtime-adjacent transcript metadata' },
    ],
  },
  {
    file: 'packages/typescript/adapters/claude/test/test-claude-resume.ts',
    title: 'Claude resume/Drive control suite',
    coverage: [
      { fn: 'F14', level: 'L2', agents: ['claude'], note: 'Drive/resume/freshness and live drive behavior' },
    ],
  },
  {
    file: 'packages/typescript/adapters/claude/test/test-claude-artifacts.ts',
    title: 'Claude SendUserFile and inline artifact suite',
    coverage: [
      { fn: 'F13', level: 'L2', agents: ['claude'], note: 'SendUserFile and inline image file-artifact mapping' },
    ],
  },
  {
    file: 'packages/typescript/broker/test/claude/test-claude-tmux-ornaments.ts',
    title: 'Claude tmux ornament classifier fixture suite',
    coverage: [
      { fn: 'F04', level: 'L0', agents: ['claude'], note: 'collapsed thought timer classified as TUI chrome while structured thinking remains canonical' },
      { fn: 'F10', level: 'L0', agents: ['claude'], note: 'trace checklist versus TodoWrite task-list-state classification' },
      { fn: 'F15', level: 'L0', agents: ['claude'], note: 'selected editor, diagnostics, recap, and crunched timer classified as canonical/status/TUI-only with reasons' },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/claude-tmux-ornaments-trace.ts',
    title: 'Claude real tmux ornament classification trace',
    optIn: true,
    coverage: [
      { fn: 'F04', level: 'L3', agents: ['claude'], note: 'real tmux capture classifies visible thinking/chrome ornaments when opt-in run is enabled' },
      { fn: 'F10', level: 'L3', agents: ['claude'], note: 'real tmux capture classifies checklist/TodoWrite-like surfaces when opt-in run is enabled' },
      { fn: 'F15', level: 'L3', agents: ['claude'], note: 'real tmux capture classifies editor/diagnostic/recap/timer ornaments when opt-in run is enabled' },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/opencode-true-sync-trace.ts',
    title: 'OpenCode shared-server true-sync and approval trace',
    coverage: [
      { fn: 'F01', level: 'L2', agents: ['opencode'] },
      { fn: 'F02', level: 'L2', agents: ['opencode'] },
      { fn: 'F03', level: 'L2', agents: ['opencode'] },
      { fn: 'F06', level: 'L2', agents: ['opencode'] },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/opencode-real-tui-trace.ts',
    title: 'OpenCode real TUI sync smoke',
    optIn: true,
    coverage: [
      { fn: 'F02', level: 'L3', agents: ['opencode'] },
      { fn: 'F03', level: 'L3', agents: ['opencode'] },
      { fn: 'F04', level: 'L3', agents: ['opencode'] },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/opencode-real-run-drive-trace.ts',
    title: 'OpenCode private observe and Drive real-run boundary',
    optIn: true,
    coverage: [
      { fn: 'F01', level: 'L2', agents: ['opencode'] },
      { fn: 'F03', level: 'L2', agents: ['opencode'] },
      { fn: 'F05', level: 'L2', agents: ['opencode'] },
      { fn: 'F14', level: 'L2', agents: ['opencode'] },
      { fn: 'F16', level: 'L2', agents: ['opencode'] },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/opencode-private-observe-drive-trace.ts',
    title: 'OpenCode observe-plus-drive ownership boundary',
    coverage: [
      { fn: 'F01', level: 'L2', agents: ['opencode'] },
      { fn: 'F03', level: 'L2', agents: ['opencode'] },
      { fn: 'F10', level: 'L2', agents: ['opencode'] },
      { fn: 'F11', level: 'L2', agents: ['opencode'] },
      { fn: 'F16', level: 'L2', agents: ['opencode'] },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/opencode-owner-degrade-trace.ts',
    title: 'OpenCode shared-server owner disappearance and downgrade trace',
    coverage: [
      { fn: 'F02', level: 'L2', agents: ['opencode'], note: 'server/event-stream loss and session.deleted clear stale active sync and drive ownership' },
      { fn: 'F14', level: 'L2', agents: ['opencode'], note: 'open socket receives degraded session frame after owner loss or session deletion' },
      { fn: 'F16', level: 'L2', agents: ['opencode'], note: 'downgraded socket rejects crafted prompt at broker boundary' },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/opencode-real-serve-owner-degrade-trace.ts',
    title: 'OpenCode real serve owner disappearance and downgrade trace',
    coverage: [
      { fn: 'F02', level: 'L2', agents: ['opencode'], note: 'real opencode serve loss clears stale owner/sync claims' },
      { fn: 'F14', level: 'L2', agents: ['opencode'], note: 'open socket receives degraded session frame after real shared-server loss' },
      { fn: 'F16', level: 'L2', agents: ['opencode'], note: 'degraded real-server socket rejects crafted prompt at broker boundary' },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/opencode-broad-real-tui-surface-trace.ts',
    title: 'OpenCode broad real-TUI surface trace',
    optIn: true,
    coverage: [
      { fn: 'F01', level: 'L3', agents: ['opencode'], note: 'real serve/TUI discovery, attach, history/options/commands, and lifecycle downgrade in one broad trace' },
      { fn: 'F05', level: 'L3', agents: ['opencode'], note: 'real broad turn must emit a tool-call or tool-result surface' },
      { fn: 'F08', level: 'L3', agents: ['opencode'], note: 'real model/options surface and selected trace model' },
      { fn: 'F09', level: 'L3', agents: ['opencode'], note: 'real commands frame exposes lifecycle commands' },
      { fn: 'F13', level: 'L3', agents: ['opencode'], note: 'real broad turn must deliver through the session-qualified send_file tool' },
      { fn: 'F14', level: 'L3', agents: ['opencode'], note: 'real serve owner disappearance downgrades the attached broad socket' },
      { fn: 'F15', level: 'L3', agents: ['opencode'], note: 'real broad trace observes status/model surfaces during a live run' },
      { fn: 'F16', level: 'L3', agents: ['opencode'], note: 'degraded broad socket rejects crafted prompt at broker boundary' },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/pi-bridge-true-sync-trace.ts',
    title: 'Pi bridge true-sync and permission trace',
    coverage: [
      { fn: 'F01', level: 'L2', agents: ['pi'] },
      { fn: 'F02', level: 'L2', agents: ['pi'] },
      { fn: 'F03', level: 'L2', agents: ['pi'] },
      { fn: 'F06', level: 'L2', agents: ['pi'] },
      { fn: 'F14', level: 'L2', agents: ['pi'] },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/pi-real-tui-bridge-trace.ts',
    title: 'Pi broad real TUI bridge surface trace',
    optIn: true,
    coverage: [
      { fn: 'F01', level: 'L3', agents: ['pi'], note: 'real bridge/TUI discovery, attach, app/terminal prompt flow, and command metadata' },
      { fn: 'F02', level: 'L3', agents: ['pi'] },
      { fn: 'F03', level: 'L3', agents: ['pi'] },
      { fn: 'F05', level: 'L3', agents: ['pi'], note: 'real broad app turn emits Pi bash tool activity' },
      { fn: 'F06', level: 'L3', agents: ['pi'] },
      { fn: 'F08', level: 'L3', agents: ['pi'], note: 'real bridge session exposes current model metadata' },
      { fn: 'F09', level: 'L3', agents: ['pi'], note: 'real commands frame exposes stop lifecycle command' },
      { fn: 'F13', level: 'L3', agents: ['pi'], note: 'real broad app turn delivers through the session-qualified bridge send_file tool' },
      { fn: 'F15', level: 'L3', agents: ['pi'], note: 'real broad app turn observes status/model/output surfaces during live bridge run' },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/codex-true-sync-trace.ts',
    title: 'Codex app-server true-sync trace',
    coverage: [
      { fn: 'F01', level: 'L2', agents: ['codex'] },
      { fn: 'F02', level: 'L2', agents: ['codex'] },
      { fn: 'F03', level: 'L2', agents: ['codex'] },
      { fn: 'F04', level: 'L2', agents: ['codex'] },
      { fn: 'F06', level: 'L2', agents: ['codex'], note: 'app approves via RPC response; a request answered by ANOTHER daemon client settles the card as external (serverRequest/resolved), turn end settles orphans, and late joiners replay no settled cards (issues-part3)' },
      { fn: 'F08', level: 'L2', agents: ['codex'], note: 'prompts without an explicit pick omit approvalPolicy; explicit picks ride turn/start; thread/settings/updated mirrors mode into the app; cold load restores the rollout mode AND model (surfaced currentModel + -m hint) against the real stdio binary (issues-part3 mode reset; 2026-07-13 spark→sol model reset)' },
      { fn: 'F14', level: 'L2', agents: ['codex'], note: 'daemon loaded-list loss downgrades open socket to observe without ended confusion' },
      { fn: 'F16', level: 'L2', agents: ['codex'], note: 'downgraded true-sync socket rejects crafted prompt at broker boundary' },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/codex-real-appserver-owner-degrade-trace.ts',
    title: 'Codex real app-server owner disappearance and downgrade trace',
    optIn: true,
    coverage: [
      { fn: 'F02', level: 'L3', agents: ['codex'], note: 'real app-server loss clears stale active true-sync claim' },
      { fn: 'F14', level: 'L3', agents: ['codex'], note: 'open socket receives degraded session frame after real app-server loss' },
      { fn: 'F16', level: 'L3', agents: ['codex'], note: 'degraded real app-server socket rejects crafted prompt at broker boundary' },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/codex-app-created-tui-sync-trace.ts',
    title: 'Codex app-created session terminal-join true-sync trace',
    optIn: true,
    coverage: [
      { fn: 'F02', level: 'L3', agents: ['codex'], note: 'app-created driven session: terminal join folds the ?mode=resume owner and upgrades the OPEN socket to live true-sync (the issues-part2 identity-split re-flag)' },
      { fn: 'F03', level: 'L3', agents: ['codex'], note: 'post-join relay proven BOTH ways against a real TUI: app prompt renders in the terminal, terminal-typed prompt renders in the app — including a message typed INSIDE the join→fold window (delivered by the fold resync; 2026-07-13 re-flag) and a pushed session frame correcting the sync-dialog hint to the model in use (-m spark, not the config default)' },
      { fn: 'F06', level: 'L3', agents: ['codex'], note: 'approval raised under ask-permission and ANSWERED IN THE REAL TUI auto-clears the app card as external via serverRequest/resolved (issues-part3: was stuck forever)' },
      { fn: 'F08', level: 'L3', agents: ['codex'], note: 'explicit approve-for-me pick persists in the live thread: a REOPENED app socket shows approve-for-me, not the old reset to ask-permission (issues-part3)' },
      { fn: 'F14', level: 'L3', agents: ['codex'], note: 'terminal exit drops the presence-based synced badge within seconds without tearing down the live conn; the composer keeps answering (or downgrades honestly if the daemon unloads)' },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/codex-broad-real-tui-surface-trace.ts',
    title: 'Codex broad real-TUI surface trace',
    optIn: true,
    coverage: [
      { fn: 'F01', level: 'L3', agents: ['codex'], note: 'real app-server/TUI discovery, attach, history/options/commands, and lifecycle downgrade in one broad trace' },
      { fn: 'F05', level: 'L3', agents: ['codex'], note: 'real broad turn must emit a tool-call or tool-result surface' },
      { fn: 'F08', level: 'L3', agents: ['codex'], note: 'real model/effort options and target-model broad turn' },
      { fn: 'F09', level: 'L3', agents: ['codex'], note: 'real commands frame exposes lifecycle commands' },
      { fn: 'F14', level: 'L3', agents: ['codex'], note: 'real app-server owner disappearance downgrades the attached broad socket' },
      { fn: 'F15', level: 'L3', agents: ['codex'], note: 'real broad trace observes status/model/effort surfaces during a live run' },
      { fn: 'F16', level: 'L3', agents: ['codex'], note: 'degraded broad socket rejects crafted prompt at broker boundary' },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/codex-real-tui-smoke.ts',
    title: 'Codex real TUI sync smoke',
    optIn: true,
    coverage: [
      { fn: 'F02', level: 'L3', agents: ['codex'] },
      { fn: 'F03', level: 'L3', agents: ['codex'] },
      { fn: 'F04', level: 'L3', agents: ['codex'] },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/codex-surface-contract-trace.ts',
    title: 'Codex surface contract and task-list trace',
    coverage: [
      { fn: 'F05', level: 'L1', agents: ['codex'] },
      { fn: 'F06', level: 'L1', agents: ['codex'] },
      { fn: 'F07', level: 'L1', agents: ['codex'] },
      { fn: 'F08', level: 'L1', agents: ['codex'] },
      { fn: 'F09', level: 'L1', agents: ['codex'] },
      { fn: 'F10', level: 'L1', agents: ['codex'] },
      { fn: 'F11', level: 'L1', agents: ['codex'] },
      { fn: 'F15', level: 'L1', agents: ['codex'] },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/codex-control-mode-restart-trace.ts',
    title: 'Codex sync enabler and broker restart trace',
    coverage: [
      { fn: 'F02', level: 'L1', agents: ['codex'] },
      { fn: 'F14', level: 'L1', agents: ['codex'] },
      { fn: 'F16', level: 'L1', agents: ['codex'] },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/claude-surface-contract-trace.ts',
    title: 'Claude surface contract trace',
    coverage: [
      { fn: 'F05', level: 'L1', agents: ['claude'] },
      { fn: 'F08', level: 'L1', agents: ['claude'], note: 'Drive mode picker includes plan and app-selected plan launches native Claude with --permission-mode plan' },
      { fn: 'F09', level: 'L1', agents: ['claude'] },
      { fn: 'F10', level: 'L1', agents: ['claude'] },
      { fn: 'F15', level: 'L1', agents: ['claude'] },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/claude-observe-question-trace.ts',
    title: 'Claude observe question surfacing trace',
    coverage: [
      { fn: 'F01', level: 'L2', agents: ['claude'] },
      { fn: 'F07', level: 'L2', agents: ['claude'] },
      { fn: 'F16', level: 'L2', agents: ['claude'], note: 'observe-mode question is read-only' },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/claude-runtime-trace.ts',
    title: 'Claude runtime and token telemetry trace',
    coverage: [
      { fn: 'F01', level: 'L2', agents: ['claude'] },
      { fn: 'F15', level: 'L2', agents: ['claude'] },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/claude-workflow-activity-trace.ts',
    title: 'Claude workflow and subagent activity trace',
    coverage: [
      { fn: 'F11', level: 'L2', agents: ['claude'] },
    ],
  },
];
