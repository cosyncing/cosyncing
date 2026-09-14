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

// These entries predate Reasonix. Keep their original scope explicit so adding
// a new AgentId cannot turn adapter-agnostic client/transport checks into
// Reasonix adapter evidence without a deliberate review.
const PRE_REASONIX_MANIFEST_AGENTS: AgentId[] = ['opencode', 'pi', 'omp', 'claude', 'codex'];

export const TRACE_MANIFEST: TraceManifestEntry[] = [
  {
    file: 'scripts/broker/conformance.ts',
    title: 'canonical render coverage and adapter command/model drift',
    coverage: [
      { fn: 'F08', level: 'D', agents: ['opencode', 'pi', 'claude', 'codex'], note: 'model and mode drift where live probes are available' },
      { fn: 'F09', level: 'D', agents: ['opencode', 'pi', 'claude', 'codex'], note: 'command registry drift for adapters with required native probes' },
      { fn: 'F16', level: 'L0', agents: PRE_REASONIX_MANIFEST_AGENTS, note: 'render blank-drop gate for canonical message types' },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/transport-crypto-broker-trace.ts',
    title: 'Secure transport and crypto adoption through real broker mailbox',
    coverage: [
      { fn: 'F16', level: 'L2', agents: PRE_REASONIX_MANIFEST_AGENTS, note: 'independent persisted pairing keys, QR public-key exchange, sender verification, replay rejection, tamper rejection, and broker-opaque ciphertext carriage' },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/transport-session-control-reference-trace.ts',
    title: 'Encrypted session-control reference path through broker pairing and mailbox',
    coverage: [
      { fn: 'F06', level: 'L2', agents: PRE_REASONIX_MANIFEST_AGENTS, note: 'approval-shaped control payload rides encrypted broker mailbox envelope' },
      { fn: 'F07', level: 'L2', agents: PRE_REASONIX_MANIFEST_AGENTS, note: 'question-answer-shaped control payload rides encrypted broker mailbox envelope' },
      { fn: 'F10', level: 'L2', agents: PRE_REASONIX_MANIFEST_AGENTS, note: 'plan-action-shaped control payload rides encrypted broker mailbox envelope' },
      { fn: 'F16', level: 'L2', agents: PRE_REASONIX_MANIFEST_AGENTS, note: 'pairing registry, opaque ciphertext carriage, replay rejection, and revoke rejection for control envelopes' },
    ],
  },
  {
    file: 'packages/typescript/broker/test/crypto/test-pairing-key-store.ts',
    title: 'crypto pairing key-store regression suite',
    coverage: [
      { fn: 'F16', level: 'L0', agents: PRE_REASONIX_MANIFEST_AGENTS, note: 'local persisted identity/exchange keys, QR private-key omission, DataKey wrap/unwrap wrong-key rejection' },
    ],
  },
  {
    file: 'scripts/broker/tests/app/test-web-ui-static.ts',
    title: 'static app and broker contract guards',
    coverage: [
      { fn: 'F01', level: 'L0', agents: PRE_REASONIX_MANIFEST_AGENTS, note: 'attach/cache/history contract guards' },
      { fn: 'F02', level: 'L0', agents: PRE_REASONIX_MANIFEST_AGENTS, note: 'control/sync UI invariants' },
      { fn: 'F06', level: 'L0', agents: PRE_REASONIX_MANIFEST_AGENTS, note: 'pending permission actionability and read-only guards' },
      { fn: 'F07', level: 'L0', agents: PRE_REASONIX_MANIFEST_AGENTS, note: 'question answer actionability and read-only guards' },
      { fn: 'F08', level: 'L0', agents: PRE_REASONIX_MANIFEST_AGENTS, note: 'statusline and picker invariants' },
      { fn: 'F10', level: 'L0', agents: PRE_REASONIX_MANIFEST_AGENTS, note: 'task-list-state renderer scaffold and plan-action lifecycle controls' },
      { fn: 'F11', level: 'L0', agents: PRE_REASONIX_MANIFEST_AGENTS, note: 'goal/background activity bars' },
      { fn: 'F12', level: 'L0', agents: PRE_REASONIX_MANIFEST_AGENTS, note: 'file upload control and read-only guard' },
      { fn: 'F13', level: 'L0', agents: PRE_REASONIX_MANIFEST_AGENTS, note: 'artifact identity, lazy load, and cache guards' },
      { fn: 'F15', level: 'L0', agents: PRE_REASONIX_MANIFEST_AGENTS, note: 'runtime/token/context statusline guards' },
      { fn: 'F16', level: 'L0', agents: PRE_REASONIX_MANIFEST_AGENTS, note: 'auth token on mutating app fetches and WebSocket stream' },
    ],
  },
  {
    file: 'scripts/broker/tests/app/test-web-ui-components.ts',
    title: 'web app component DOM guards for interaction surfaces',
    coverage: [
      { fn: 'F10', level: 'L1', agents: PRE_REASONIX_MANIFEST_AGENTS, note: 'plan-like task-list panels emit semantic plan-action frames from the real app renderer' },
      { fn: 'F13', level: 'L1', agents: PRE_REASONIX_MANIFEST_AGENTS, note: 'interactive HTML artifact opens in a sandboxed signed-URL iframe and forwards cosyncing-bridge interactions over the session WebSocket' },
      { fn: 'F16', level: 'L1', agents: PRE_REASONIX_MANIFEST_AGENTS, note: 'artifact iframe messages are accepted only from app-registered frames and ride the authenticated session stream' },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/artifact-sandbox-browser-trace.ts',
    title: 'real Chromium adversarial artifact sandbox trace',
    coverage: [
      { fn: 'F13', level: 'L1', agents: PRE_REASONIX_MANIFEST_AGENTS, note: 'real browser loads signed HTML artifact, injected bridge forwards a valid form interaction through the app WebSocket' },
      { fn: 'F16', level: 'L1', agents: PRE_REASONIX_MANIFEST_AGENTS, note: 'real browser proves CSP blocks non-nonce script and exfil fetch/beacon, and app drops forged nested postMessage source' },
    ],
  },
  {
    file: 'scripts/broker/tests_traces/file-viewer-csp-browser-trace.ts',
    title: 'real Chromium file-viewer rendered-HTML policy trace',
    optIn: true,
    coverage: [
      {
        fn: 'F16',
        level: 'L1',
        agents: 'all',
        note: 'real browser proves the injected policy blocks stylesheet, font and image loads from a rendered workspace HTML file, with an unpolicied control frame that does load them',
      },
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
    file: 'packages/typescript/adapters/reasonix/test/test-reasonix-store.ts',
    title: 'Reasonix v1.25.2 store discovery, schema, identity, and boundary suite',
    nativeVersion: '1.25.2',
    coverage: [
      { fn: 'F01', level: 'L0', agents: ['reasonix'], note: 'global/project discovery, bounded transcript replay, and newest-first selection' },
      { fn: 'F08', level: 'L0', agents: ['reasonix'], note: 'durable provider/model identity is parsed without inventing a display label' },
      { fn: 'F14', level: 'L0', agents: ['reasonix'], note: 'append identity and rewrite lineage are distinguished' },
      { fn: 'F16', level: 'L0', agents: ['reasonix'], note: 'no-follow reads, containment, sidecar exclusions, size caps, and unknown-schema refusal' },
    ],
  },
  {
    file: 'packages/typescript/adapters/reasonix/test/test-reasonix-mapping.ts',
    title: 'Reasonix flat-transcript canonical mapping suite',
    nativeVersion: '1.25.2',
    coverage: [
      { fn: 'F04', level: 'L0', agents: ['reasonix'], note: 'reasoning and answer lanes preserve stored whitespace and stable keys' },
      { fn: 'F05', level: 'L0', agents: ['reasonix'], note: 'measured durable tool rows preserve bounded result, call id, name, and failure state; live-only arguments cannot be reconstructed' },
      { fn: 'F15', level: 'L0', agents: ['reasonix'], note: 'workDurationMs maps to runtime without fabricated token fields' },
      { fn: 'F16', level: 'L0', agents: ['reasonix'], note: 'unknown roles remain named neutral events and never become human rows' },
    ],
  },
  {
    file: 'packages/typescript/adapters/reasonix/test/test-reasonix-observe.ts',
    title: 'Reasonix Observe replay, immutable snapshot, and replacement watcher suite',
    nativeVersion: '1.25.2',
    coverage: [
      { fn: 'F01', level: 'L0', agents: ['reasonix'], note: 'history-before-tail replay, append dedupe, and watcher rearm after atomic replacement' },
      { fn: 'F04', level: 'L0', agents: ['reasonix'], note: 'one canonical mapper serves replay and durable tail' },
      { fn: 'F14', level: 'L0', agents: ['reasonix'], note: 'rewrite emits rollback history-reset instead of splicing replaced history' },
      { fn: 'F15', level: 'L0', agents: ['reasonix'], note: 'ownerless user tail becomes cancelled rather than indefinitely running' },
      { fn: 'F16', level: 'L0', agents: ['reasonix'], note: 'multi-file consistency retries prevent mixed transcript/index snapshots' },
    ],
  },
  {
    file: 'packages/typescript/adapters/reasonix/test/test-reasonix-drive.ts',
    title: 'Reasonix ACP Drive queue, output, permission, and demotion suite',
    nativeVersion: '1.25.2',
    coverage: [
      { fn: 'F03', level: 'L0', agents: ['reasonix'], note: 'bounded FIFO prompt admission, durable echo reconciliation, cancel, and write refusal after demotion' },
      { fn: 'F04', level: 'L0', agents: ['reasonix'], note: 'pre-tool ACP answer/thought chunks use replay-compatible assistant sequence keys; ambiguous post-tool deltas remain keyless' },
      { fn: 'F05', level: 'L0', agents: ['reasonix'], note: 'terminal tool results preserve native title/name and bounded raw output' },
      { fn: 'F06', level: 'L0', agents: ['reasonix'], note: 'canonical permission decisions map to measured ACP option ids' },
      { fn: 'F14', level: 'L0', agents: ['reasonix'], note: 'history rewrite invalidates correlations and cancels the writer' },
      { fn: 'F16', level: 'L0', agents: ['reasonix'], note: 'admission caps, foreign-session permission refusal, ownership fences, and demotion on detectable conflicts' },
    ],
  },
  {
    file: 'packages/typescript/adapters/reasonix/test/test-reasonix-identity.ts',
    title: 'Reasonix captured ACP/store identity and single-writer registry suite',
    nativeVersion: '1.25.2',
    coverage: [
      { fn: 'F01', level: 'L0', agents: ['reasonix'], note: 'captured ACP session id and durable store identity converge' },
      { fn: 'F04', level: 'L0', agents: ['reasonix'], note: 'captured live output and replay output converge on one key' },
      { fn: 'F06', level: 'L0', agents: ['reasonix'], note: 'idle child exit resolves pending permissions before demotion' },
      { fn: 'F14', level: 'L0', agents: ['reasonix'], note: 'identity-CAS replacement prevents stale owner deregistration' },
      { fn: 'F16', level: 'L0', agents: ['reasonix'], note: 'one child per native attach and unexpected child death fail read-only' },
    ],
  },
  {
    file: 'packages/typescript/broker/test/reasonix/test-reasonix-registration-gate.ts',
    title: 'Reasonix broker registration, capability, create/load, and fail-closed gate',
    nativeVersion: '1.25.2',
    coverage: [
      { fn: 'F01', level: 'L2', agents: ['reasonix'], note: 'real fixture broker publishes Reasonix and adapter attach/create re-derive durable history identity' },
      { fn: 'F02', level: 'L2', agents: ['reasonix'], note: 'broker advertises terminal sync unsupported and omits an unpinned terminal hint' },
      { fn: 'F03', level: 'L2', agents: ['reasonix'], note: 'Observe stays process-free while Resume command discovery starts the workspace-scoped ACP writer before its first prompt' },
      { fn: 'F08', level: 'L2', agents: ['reasonix'], note: 'durable model survives create/load while existing-session switch remains false' },
      { fn: 'F14', level: 'L2', agents: ['reasonix'], note: 'create/load succeeds only when ACP identity reappears in the durable store' },
      { fn: 'F16', level: 'L2', agents: ['reasonix'], note: 'undeclared modes, missing binaries, synthetic identities, and unsupported client shapes fail closed' },
    ],
  },
  {
    file: 'packages/typescript/broker/test/broker/test-reasonix-cross-client-join.ts',
    title: 'Reasonix broker cross-client writer, permission replay, and ownership-loss suite',
    nativeVersion: '1.25.2',
    coverage: [
      { fn: 'F01', level: 'L2', agents: ['reasonix'], note: 'Observe reload can join the exact existing Drive connection and pending history' },
      { fn: 'F03', level: 'L2', agents: ['reasonix'], note: 'two sockets preserve prompt order through one ACP child and refuse after demotion' },
      { fn: 'F06', level: 'L2', agents: ['reasonix'], note: 'late joiner replays an unresolved card and maps approve to native allow_once' },
      { fn: 'F09', level: 'L2', agents: ['reasonix'], note: 'synthetic protocol-shaped catalog reaches a joined Drive and invokes an advertised command through session/prompt; native payload capture remains pending' },
      { fn: 'F14', level: 'L2', agents: ['reasonix'], note: 'a detectable foreign durable write demotes every joined socket without losing accepted prompts' },
      { fn: 'F16', level: 'L2', agents: ['reasonix'], note: 'single-writer reuse and nonmatching foreign-write detection reduce competing native writers; native per-write identity remains unmeasured' },
    ],
  },
  {
    file: 'packages/typescript/adapters/grok/test/test-grok-store.ts',
    title: 'Grok 1.0.13 local-store discovery, identity, and boundary suite',
    nativeVersion: '1.0.13',
    coverage: [
      { fn: 'F01', level: 'L0', agents: ['grok'], note: 'URL-decoded workspace discovery joins measured headless roots plus bounded summary, updates, and signals files to one UUID identity' },
      { fn: 'F08', level: 'L0', agents: ['grok'], note: 'durable current model, effort, and agent identity are parsed without a scraped catalog' },
      { fn: 'F11', level: 'L0', agents: ['grok'], note: 'exact native parent meta and subagent summaries publish one child roster row with parentThreadId; ambiguous or incomplete lineage is withheld' },
      { fn: 'F14', level: 'L0', agents: ['grok'], note: 'append identity, partial-line withholding, and rewritten lineage are distinguished' },
      { fn: 'F16', level: 'L0', agents: ['grok'], note: 'no-follow containment, schema and size bounds, cwd identity matching, and enumeration exhaustion fail closed' },
    ],
  },
  {
    file: 'packages/typescript/adapters/grok/test/test-grok-mapping.ts',
    title: 'Grok measured ACP update canonical mapping suite',
    nativeVersion: '1.0.13',
    coverage: [
      { fn: 'F04', level: 'L0', agents: ['grok'], note: 'answer and thought chunks preserve exact text while user rows remain the only human bubbles' },
      { fn: 'F05', level: 'L0', agents: ['grok'], note: 'measured tool metadata preserves stable calls, class, bounded arguments, results, and failure posture' },
      { fn: 'F10', level: 'L0', agents: ['grok'], note: 'task_completed snapshots map to native task-list state' },
      { fn: 'F11', level: 'L0', agents: ['grok'], note: 'backgrounded and completed tasks map to neutral activity without inventing child sessions' },
      { fn: 'F15', level: 'L0', agents: ['grok'], note: 'turn usage and aggregate context usage are kept distinct without fabricated cumulative token counts' },
      { fn: 'F16', level: 'L0', agents: ['grok'], note: 'unknown additive values remain named neutral context and garbage input is total' },
    ],
  },
  {
    file: 'packages/typescript/adapters/grok/test/test-grok-observe.ts',
    title: 'Grok Observe replay, immutable snapshot, tail, and rewrite suite',
    nativeVersion: '1.0.13',
    coverage: [
      { fn: 'F01', level: 'L0', agents: ['grok'], note: 'history-before-tail replay, append dedupe, partial-line withholding, and page capture share one identity' },
      { fn: 'F04', level: 'L0', agents: ['grok'], note: 'one canonical mapper serves replay and durable tail' },
      { fn: 'F14', level: 'L0', agents: ['grok'], note: 'prefix rewrite emits rollback history-reset instead of splicing histories' },
      { fn: 'F15', level: 'L0', agents: ['grok'], note: 'ownerless trailing user turns are cancelled rather than indefinitely running' },
      { fn: 'F16', level: 'L0', agents: ['grok'], note: 'snapshot identity and bounded page readers keep source revisions coherent' },
    ],
  },
  {
    file: 'packages/typescript/adapters/grok/test/test-grok-drive.ts',
    title: 'Grok ACP Drive queue, permission, and demotion suite',
    nativeVersion: '1.0.13',
    coverage: [
      { fn: 'F03', level: 'L0', agents: ['grok'], note: 'bounded prompt admission, durable event-id reconciliation, cancel, and refusal after demotion' },
      { fn: 'F04', level: 'L0', agents: ['grok'], note: 'live child updates pass through the replay mapper and preserve correlation' },
      { fn: 'F05', level: 'L0', agents: ['grok'], note: 'tool and command rows retain measured bounded metadata' },
      { fn: 'F06', level: 'L0', agents: ['grok'], note: 'allow-once/reject decisions map to the measured ACP option ids' },
      { fn: 'F14', level: 'L0', agents: ['grok'], note: 'history rewrite invalidates correlations and force-closes the writer' },
      { fn: 'F16', level: 'L0', agents: ['grok'], note: 'admission caps, permission bounds, event-id ownership, and foreign-write detection fail read-only' },
    ],
  },
  {
    file: 'packages/typescript/adapters/grok/test/test-grok-identity.ts',
    title: 'Grok executable-stub ACP/store identity and restart suite',
    nativeVersion: '1.0.13',
    coverage: [
      { fn: 'F01', level: 'L0', agents: ['grok'], note: 'session/new, durable UUID, session/load, replay, and restart identity converge through the floored-version executable stub' },
      { fn: 'F03', level: 'L0', agents: ['grok'], note: 'the lazy ACP prompt path claims the queued key from the native event id' },
      { fn: 'F08', level: 'L0', agents: ['grok'], note: 'initialize and relaunch cover model labels, effort, mode, and same-id load' },
      { fn: 'F14', level: 'L0', agents: ['grok'], note: 'create closes its temporary child and restart restores durable app-created eligibility' },
      { fn: 'F16', level: 'L0', agents: ['grok'], note: 'only 1.0.13 or newer with reusable cached-token authentication creates or drives; older versions remain Observe-only' },
    ],
  },
  {
    file: 'packages/typescript/adapters/grok/test/test-grok-diagnostics.ts',
    title: 'Grok effect-free floored-version and local-store diagnosis suite',
    nativeVersion: '1.0.13',
    coverage: [
      { fn: 'F15', level: 'L1', agents: ['grok'], note: 'doctor distinguishes missing, measured, newer-unmeasured, and below-floor local binary versions' },
      { fn: 'F16', level: 'L1', agents: ['grok'], note: 'effect-free diagnosis honors explicit executable/store roots and reports unsafe store types without mutation' },
    ],
  },
  {
    file: 'packages/typescript/broker/test/grok/test-grok-registration-gate.ts',
    title: 'Grok shipped floored-version writer registration and fallback gate',
    nativeVersion: '1.0.13',
    coverage: [
      { fn: 'F01', level: 'L2', agents: ['grok'], note: 'the fixture broker publishes Observe plus floored-version create/load and restart-safe Drive eligibility' },
      { fn: 'F03', level: 'L2', agents: ['grok'], note: 'Observe stays process-free while eligible Resume lazily loads one authenticated ACP writer' },
      { fn: 'F08', level: 'L2', agents: ['grok'], note: 'shipped registration publishes model, effort, and mode controls only on the version-gated writer surface' },
      { fn: 'F09', level: 'L2', agents: ['grok'], note: 'the ACP initialize catalog reaches the shipped floored-version Drive connection' },
      { fn: 'F14', level: 'L2', agents: ['grok'], note: 'create/load/cancel eligibility is durable while terminal handoff remains a separate-process hint' },
      { fn: 'F16', level: 'L2', agents: ['grok'], note: 'client floor, service executable capture, cached-token readiness, version fence, and Observe fallback are pinned' },
    ],
  },
  {
    file: 'packages/typescript/broker/test/broker/test-grok-cross-client-join.ts',
    title: 'Grok shipped writer cross-client and ownership-loss suite',
    nativeVersion: '1.0.13',
    coverage: [
      { fn: 'F01', level: 'L2', agents: ['grok'], note: 'reload joins the exact existing Drive connection and receives its queued history' },
      { fn: 'F03', level: 'L2', agents: ['grok'], note: 'two sockets preserve prompt order through one ACP child and refuse after shared demotion' },
      { fn: 'F04', level: 'L2', agents: ['grok'], note: 'a joined socket receives correlated user echo and model output from the existing child' },
      { fn: 'F06', level: 'L2', agents: ['grok'], note: 'a late joiner replays an unresolved permission and maps approve to allow_once' },
      { fn: 'F09', level: 'L2', agents: ['grok'], note: 'a joined Drive receives the existing child command catalog' },
      { fn: 'F14', level: 'L2', agents: ['grok'], note: 'a detectable foreign durable write demotes every joined socket together' },
      { fn: 'F16', level: 'L2', agents: ['grok'], note: 'single-writer reuse, shared-ledger, and foreign-write fences cover the shipped floored-version writer' },
    ],
  },
  {
    file: 'packages/typescript/adapters/cline/test/test-cline-store.ts',
    title: 'Cline 3.0.61 parent/subagent snapshot discovery and boundary suite',
    nativeVersion: '3.0.61',
    coverage: [
      { fn: 'F01', level: 'L0', agents: ['cline'], note: 'parent metadata and rewritten message documents converge with measured child session identities' },
      { fn: 'F08', level: 'L0', agents: ['cline'], note: 'provider/model labels and current mode survive snapshot materialization without reading provider secrets' },
      { fn: 'F11', level: 'L0', agents: ['cline'], note: 'subagent documents publish child nativeId and parentThreadId with strict linkage validation' },
      { fn: 'F14', level: 'L0', agents: ['cline'], note: 'snapshot identity and updatedAfter child-parent retention are bounded and deterministic' },
      { fn: 'F16', level: 'L0', agents: ['cline'], note: 'no-follow containment, schema/count limits, duplicate ids, and invalid child linkage fail closed' },
    ],
  },
  {
    file: 'packages/typescript/adapters/cline/test/test-cline-mapping.ts',
    title: 'Cline rewritten-message canonical mapping suite',
    nativeVersion: '3.0.61',
    coverage: [
      { fn: 'F04', level: 'L0', agents: ['cline'], note: 'answer and thinking preserve exact stored content while only user text becomes a human row' },
      { fn: 'F05', level: 'L0', agents: ['cline'], note: 'tool call/result identity and bounded opaque payloads are preserved without guessed path semantics' },
      { fn: 'F06', level: 'L0', agents: ['cline'], note: 'unmatched tool use appears as explicitly read-only pending state' },
      { fn: 'F11', level: 'L0', agents: ['cline'], note: 'spawn_agent call/result activity shares one stable canonical key' },
      { fn: 'F15', level: 'L0', agents: ['cline'], note: 'cache-inclusive input totals retain cache subsets without double addition' },
      { fn: 'F16', level: 'L0', agents: ['cline'], note: 'unknown blocks remain traced neutral context and never become human messages' },
    ],
  },
  {
    file: 'packages/typescript/adapters/cline/test/test-cline-observe.ts',
    title: 'Cline Observe replay, immutable snapshot, rewrite, and paging suite',
    nativeVersion: '3.0.61',
    coverage: [
      { fn: 'F01', level: 'L0', agents: ['cline'], note: 'history replay, whole-file append dedupe, page capture, and explicit Observe reattach share one identity' },
      { fn: 'F04', level: 'L0', agents: ['cline'], note: 'one canonical mapper serves live ACP updates, replay, and rewritten-file tail' },
      { fn: 'F14', level: 'L0', agents: ['cline'], note: 'content rewrite emits rollback history-reset and invalidates stale page identity' },
      { fn: 'F15', level: 'L0', agents: ['cline'], note: 'dead-pid session tail receives a cancelled summary and aggregate usage remains separate' },
      { fn: 'F16', level: 'L0', agents: ['cline'], note: 'snapshot convergence and read-only prompt/permission refusals fail closed' },
    ],
  },
  {
    file: 'packages/typescript/adapters/cline/test/test-cline-drive.ts',
    title: 'Cline fixture-only ACP candidate and fail-closed ownership suite',
    nativeVersion: '3.0.61',
    coverage: [
      { fn: 'F01', level: 'L0', agents: ['cline'], note: 'test-only create/load identity and restart provenance converge on one fixture session id; this is not shipped Drive evidence' },
      { fn: 'F03', level: 'L0', agents: ['cline'], note: 'candidate prompts serialize and reject missing causal evidence; production never enables this ACP writer' },
      { fn: 'F04', level: 'L0', agents: ['cline'], note: 'candidate semantic comparison fails closed when live and durable shapes diverge' },
      { fn: 'F06', level: 'L0', agents: ['cline'], note: 'fixture ACP permissions settle on close or demotion; shipped Observe remains non-actionable' },
      { fn: 'F08', level: 'L0', agents: ['cline'], note: 'fixture model and mode propagation tests do not advertise production controls' },
      { fn: 'F14', level: 'L0', agents: ['cline'], note: 'fixture create/cancel plus independently measured native rename preserve lifecycle boundaries' },
      { fn: 'F15', level: 'L0', agents: ['cline'], note: 'candidate live telemetry mapping remains unshipped; durable snapshot telemetry is covered separately' },
      { fn: 'F16', level: 'L0', agents: ['cline'], note: 'missing delimiter, timeout, rewrite, permission, and foreign-writer cases fail read-only in the fixture-only candidate' },
    ],
  },
  {
    file: 'packages/typescript/adapters/cline/test/test-cline-hub.ts',
    title: 'Cline shipped isolated Hub Drive, approval, replay, and ownership suite',
    nativeVersion: '3.0.61 / Hub core 0.0.82',
    coverage: [
      { fn: 'F01', level: 'L0', agents: ['cline'], note: 'managed create, late app-socket join, and same-Hub broker replacement preserve one exact native session id and durable boundary; content rewrites and Hub-epoch replacement revoke correlation authority' },
      { fn: 'F03', level: 'L0', agents: ['cline'], note: 'direct run.start serializes native turns, reconciles an early durable native echo without duplication, and Stop verifies non-running status plus a stable durable boundary before accepting another prompt' },
      { fn: 'F06', level: 'L0', agents: ['cline'], note: 'top-level native approval requests expose bounded detail, settle exactly once, reject as a set on Stop or overflow, and cannot remain actionable after demotion' },
      { fn: 'F08', level: 'L0', agents: ['cline'], note: 'configured provider/model and ask/auto/plan mode propagate into native session creation while per-turn switching stays disabled' },
      { fn: 'F14', level: 'L0', agents: ['cline'], note: 'managed Create/Resume, verified and bounded Stop, late cross-client join, broker-client replacement, transport-loss authority recovery, and Hub-epoch invalidation preserve lifecycle boundaries; Stop and close synchronously fence peer prompt admission, and a lost terminal run reply demotes instead of hanging' },
      { fn: 'F15', level: 'L0', agents: ['cline'], note: 'native answer and token events project live and the durable transcript remains canonical' },
      { fn: 'F16', level: 'L0', agents: ['cline'], note: 'owner-only discovery, isolated profile/port, inbound/outbound frame bounds, malformed-frame close, duplicate-create cleanup safety, full-content rewrite identity, foreign-run demotion, replacement-Hub refusal, and a failed last-resort managed-Hub stop fence fail closed and surface the unsafe disposal' },
    ],
  },
  {
    file: 'packages/typescript/adapters/cline/test/test-cline-diagnostics.ts',
    title: 'Cline effect-free floored-version and snapshot-root diagnosis suite',
    nativeVersion: '3.0.61',
    coverage: [
      { fn: 'F15', level: 'L1', agents: ['cline'], note: 'doctor distinguishes missing and measured local binary/storage states' },
      { fn: 'F16', level: 'L1', agents: ['cline'], note: 'effect-free diagnosis honors explicit executable/data roots and reports unsafe types without reading provider settings' },
    ],
  },
  {
    file: 'packages/typescript/broker/test/cline/test-cline-registration-gate.ts',
    title: 'Cline shipped managed-Hub registration, revision-floor, and service-environment gate',
    nativeVersion: '3.0.61',
    coverage: [
      { fn: 'F01', level: 'L2', agents: ['cline'], note: 'current clients receive the managed Create/Resume row while older clients omit Cline without crashing' },
      { fn: 'F03', level: 'L2', agents: ['cline'], note: 'bare attach remains refused; explicit Observe is process-free and unavailable managed Resume fails instead of downgrading' },
      { fn: 'F06', level: 'L2', agents: ['cline'], note: 'registration publishes per-tool permission support only for the dynamically ready managed writer' },
      { fn: 'F08', level: 'L2', agents: ['cline'], note: 'registration publishes create-time model/mode controls with display-only per-turn model state' },
      { fn: 'F11', level: 'L2', agents: ['cline'], note: 'parent and subagent roster rows preserve measured native and parent identities' },
      { fn: 'F14', level: 'L2', agents: ['cline'], note: 'native rename and separate-process terminal handoff coexist with managed Create/Resume' },
      { fn: 'F16', level: 'L2', agents: ['cline'], note: 'client floor, setup copy, service paths/model selection, managed-host gate, and dynamic create readiness are pinned' },
    ],
  },
  {
    file: 'packages/typescript/adapters/kilocode/test/test-kilocode-store.ts',
    title: 'Kilo 7.4.23 SQLite discovery, snapshot, and boundary suite',
    nativeVersion: '7.4.23',
    coverage: [
      { fn: 'F01', level: 'L0', agents: ['kilo'], note: 'Kilo-named database precedence, session discovery, history replay, and updatedAfter retention use one measured SQLite schema' },
      { fn: 'F08', level: 'L0', agents: ['kilo'], note: 'provider, model, and display-only agent state come from durable session/message rows' },
      { fn: 'F14', level: 'L0', agents: ['kilo'], note: 'history refresh and active-session retention remain read-only and deterministic' },
      { fn: 'F15', level: 'L0', agents: ['kilo'], note: 'durable timestamps, terminal summaries, model identity, token usage, and cost map without treating cache subsets as extra input' },
      { fn: 'F16', level: 'L0', agents: ['kilo'], note: 'schema validation, no-follow files, bounded snapshots, identities, databases, and sessions fail closed' },
    ],
  },
  {
    file: 'packages/typescript/adapters/kilocode/test/test-kilocode-mapping.ts',
    title: 'Kilo OpenCode-lineage part mapping suite',
    nativeVersion: '7.4.23',
    coverage: [
      { fn: 'F04', level: 'L0', agents: ['kilo'], note: 'stored answer and reasoning preserve exact content through the shared mapper' },
      { fn: 'F05', level: 'L0', agents: ['kilo'], note: 'one synthetic shared-lineage read-tool fixture checks mapper reuse; exact native Kilo tool identity and paths remain unsupported pending capture' },
      { fn: 'F16', level: 'L0', agents: ['kilo'], note: 'unknown parts remain traced neutral context and never become human messages' },
    ],
  },
  {
    file: 'packages/typescript/adapters/kilocode/test/test-kilocode-observe.ts',
    title: 'Kilo Observe replay, WAL resnapshot, replacement, and paging suite',
    nativeVersion: '7.4.23',
    coverage: [
      { fn: 'F01', level: 'L0', agents: ['kilo'], note: 'history replay, append dedupe, immutable paging, and explicit Observe reattach share one identity' },
      { fn: 'F04', level: 'L0', agents: ['kilo'], note: 'one canonical mapper serves replay and WAL-triggered resnapshot tail' },
      { fn: 'F06', level: 'L0', agents: ['kilo'], note: 'the Observe connection rejects permission responses because no native Kilo permission route has been captured' },
      { fn: 'F14', level: 'L0', agents: ['kilo'], note: 'retained-prefix replacement emits history-reset and invalidates stale page identity' },
      { fn: 'F16', level: 'L0', agents: ['kilo'], note: 'read-only prompt, permission, attachment, model, and agent mutations fail closed' },
    ],
  },
  {
    file: 'packages/typescript/adapters/kilocode/test/test-kilocode-drive.ts',
    title: 'Kilo authenticated managed-host Drive, permission, model, and ownership suite',
    nativeVersion: '7.4.23',
    coverage: [
      { fn: 'F01', level: 'L0', agents: ['kilo'], note: 'managed-server create, live attach, Observe fallback, durable identity, and restart eligibility converge' },
      { fn: 'F03', level: 'L0', agents: ['kilo'], note: 'prompt_async preserves caller correlation, serial admission, abort, and refusal after demotion' },
      { fn: 'F04', level: 'L0', agents: ['kilo'], note: 'SSE answer/reasoning parts share stable identity with replay and suppress duplicate streaming snapshots' },
      { fn: 'F06', level: 'L0', agents: ['kilo'], note: 'authenticated pending permissions, native replies, external settlement, and close cleanup preserve ownership' },
      { fn: 'F08', level: 'L0', agents: ['kilo'], note: 'provider catalog labels and model selections survive create, native updates, history, and restart' },
      { fn: 'F11', level: 'L0', agents: ['kilo'], note: 'live-qualified native child sessions preserve parent_id and remain Observe-only' },
      { fn: 'F14', level: 'L0', agents: ['kilo'], note: 'create, abort, native rename, and history replacement preserve lifecycle boundaries' },
      { fn: 'F15', level: 'L0', agents: ['kilo'], note: 'SSE status, run summaries, cache-aware tokens, and cost converge with durable history' },
      { fn: 'F16', level: 'L0', agents: ['kilo'], note: 'Basic auth, bounded bodies, dedicated-host proof, prompt claims, and foreign-writer demotion fail closed' },
    ],
  },
  {
    file: 'packages/typescript/adapters/kilocode/test/test-kilocode-diagnostics.ts',
    title: 'Kilo effect-free floored-version store and managed-port diagnosis suite',
    nativeVersion: '7.4.23',
    coverage: [
      { fn: 'F15', level: 'L1', agents: ['kilo'], note: 'doctor distinguishes missing, measured, newer-unmeasured, and below-floor CLI/storage states without mutation' },
      { fn: 'F16', level: 'L1', agents: ['kilo'], note: 'effect-free diagnosis honors explicit roots, database precedence, unsafe types, and dedicated-port ownership state' },
    ],
  },
  {
    file: 'packages/typescript/broker/test/kilocode/test-kilocode-registration-gate.ts',
    title: 'Kilo shipped authenticated writer registration and managed-host gate',
    nativeVersion: '7.4.23',
    coverage: [
      { fn: 'F01', level: 'L2', agents: ['kilo'], note: 'the fixture broker publishes SQLite Observe plus floored-version managed-host create and live attach' },
      { fn: 'F02', level: 'L2', agents: ['kilo'], note: 'discovery publishes no terminal sync hint because no exact-session Kilo join command has been captured' },
      { fn: 'F03', level: 'L2', agents: ['kilo'], note: 'Observe rejects writes while eligible live attach publishes prompt, cancel, and actionable permission control' },
      { fn: 'F06', level: 'L2', agents: ['kilo'], note: 'the shipped floored-version writer publishes authenticated per-tool permission cards and native replies' },
      { fn: 'F08', level: 'L2', agents: ['kilo'], note: 'registration publishes create-time model selection and live current-model labels without inventing permission modes' },
      { fn: 'F14', level: 'L2', agents: ['kilo'], note: 'create, cancel, and native rename ship while no unmeasured terminal handoff is advertised' },
      { fn: 'F16', level: 'L2', agents: ['kilo'], note: 'client floor, setup copy, dedicated port 4097, managed-host consent, Basic auth, and ownership proof are pinned' },
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
