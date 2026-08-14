#!/usr/bin/env bun
/**
 * Focused Codex terminal presence/provenance tests (part4):
 * - terminal presence classifier (`absent|private|shared|unknown`) with exact + cwd/birth heuristics
 * - rollout launch-surface mapping
 * - terminal sync control invariants (active only when shared + live-loaded)
 *
 * Pure/no-side-effects: scan fixtures only, no daemon/process calls.
 */
import {
  codexControlState,
  codexPresenceRequiresFullWatchReemit,
  codexRolloutLaunchSurface,
  classifyCodexTerminalPresence,
  qualifyCodexRolloutStatus,
} from '../src/index.ts';

type PresenceFixture = {
  attributed: Set<string>;
  unattributed: Array<{ cwd?: string; startedAtMs?: number }>;
  privateThreadIds: Set<string>;
  privateUnattributed: Array<{ cwd?: string; startedAtMs?: number }>;
  unknownUnattributed: Array<{ cwd?: string; startedAtMs?: number }>;
  unknownThreadIds: Set<string>;
  candidates: Array<{
    pid: number;
    proof: 'shared' | 'private' | 'unknown';
    threadIds?: string[];
    cwd?: string;
    startedAtMs?: number;
  }>;
  socketDiagAvailable: boolean;
  processScanAvailable: boolean;
};

const mkScan = (patch: Partial<PresenceFixture>): PresenceFixture => ({
  attributed: new Set(),
  unattributed: [],
  privateThreadIds: new Set(),
  privateUnattributed: [],
  unknownUnattributed: [],
  unknownThreadIds: new Set(),
  candidates: [],
  socketDiagAvailable: false,
  processScanAvailable: true,
  ...patch,
});

let failures = 0;
const check = (label: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
  if (!ok) failures++;
};

const now = 1_700_000_000_000; // deterministic millis
const cwd = '/tmp/cosyncing/test/cwd';
const sharedThread = '019f1234-0000-4000-8000-000000000001';
const privateThread = '019f1234-0000-4000-8000-000000000002';
const unknownThread = '019f1234-0000-4000-8000-000000000003';

check(
  'an abandoned unmatched start is Idle when no daemon or terminal owns it',
  qualifyCodexRolloutStatus('working', {
    liveLoaded: false,
    terminalPresence: 'absent',
    agentOwned: false,
  }) === 'idle',
);

check(
  'a daemon-owned unmatched start remains Working',
  qualifyCodexRolloutStatus('working', {
    liveLoaded: true,
    terminalPresence: 'absent',
    agentOwned: false,
  }) === 'working',
);

check(
  'point-in-time native Idle retires a sticky daemon-loaded unmatched start',
  qualifyCodexRolloutStatus('working', {
    liveLoaded: true,
    nativeActivity: 'idle',
    terminalPresence: 'absent',
    agentOwned: false,
  }) === 'idle',
);

check(
  'point-in-time native Needs input refines a daemon-loaded unmatched start',
  qualifyCodexRolloutStatus('working', {
    liveLoaded: true,
    nativeActivity: 'needs-input',
    terminalPresence: 'absent',
    agentOwned: false,
  }) === 'needs-input',
);

check(
  'point-in-time native Working closes the gap before a new rollout start is durable',
  qualifyCodexRolloutStatus('idle', {
    liveLoaded: true,
    nativeActivity: 'working',
    terminalPresence: 'absent',
    agentOwned: false,
  }) === 'working',
);

check(
  'a terminal-owned unmatched start remains Working',
  qualifyCodexRolloutStatus('working', {
    liveLoaded: false,
    terminalPresence: 'private',
    agentOwned: false,
  }) === 'working',
);

check(
  'unknown process evidence cannot retire an unmatched start',
  qualifyCodexRolloutStatus('working', {
    liveLoaded: false,
    terminalPresence: 'unknown',
    agentOwned: false,
  }) === 'working',
);

check(
  'an active subagent keeps its own exact lifecycle without a separate TUI',
  qualifyCodexRolloutStatus('working', {
    liveLoaded: false,
    terminalPresence: 'absent',
    agentOwned: true,
  }) === 'working',
);

check(
  'native Idle on a subagent parent retires an orphaned child start',
  qualifyCodexRolloutStatus('working', {
    liveLoaded: false,
    terminalPresence: 'absent',
    agentOwned: true,
    parentLiveLoaded: true,
    parentNativeActivity: 'idle',
    parentTerminalPresence: 'absent',
  }) === 'idle',
);

check(
  'point-in-time native Idle on a loaded child outranks its active parent',
  qualifyCodexRolloutStatus('working', {
    liveLoaded: true,
    nativeActivity: 'idle',
    terminalPresence: 'absent',
    agentOwned: true,
    parentLiveLoaded: true,
    parentNativeActivity: 'working',
    parentTerminalPresence: 'absent',
  }) === 'idle',
);

check(
  'native Working on a subagent parent preserves its active child',
  qualifyCodexRolloutStatus('working', {
    liveLoaded: false,
    terminalPresence: 'absent',
    agentOwned: true,
    parentLiveLoaded: true,
    parentNativeActivity: 'working',
    parentTerminalPresence: 'absent',
  }) === 'working',
);

check(
  'a terminal rollout remains Idle even while an owner surface is still present',
  qualifyCodexRolloutStatus('idle', {
    liveLoaded: true,
    terminalPresence: 'shared',
    agentOwned: false,
  }) === 'idle',
);

check(
  'process scan unavailable => unknown',
  classifyCodexTerminalPresence(
    mkScan({
      processScanAvailable: false,
      socketDiagAvailable: false,
      attributed: new Set(['x']),
      privateThreadIds: new Set(['y']),
      unknownThreadIds: new Set(['z']),
    }),
    sharedThread,
  ) === 'unknown',
);

check(
  'shared exact thread evidence is shared',
  classifyCodexTerminalPresence(
    mkScan({
      attributed: new Set([sharedThread]),
      privateThreadIds: new Set([sharedThread]),
      unknownThreadIds: new Set([sharedThread]),
    }),
    sharedThread,
  ) === 'shared',
);

check(
  'private exact thread evidence is private',
  classifyCodexTerminalPresence(
    mkScan({
      privateThreadIds: new Set([privateThread]),
      attributed: new Set(),
    }),
    privateThread,
  ) === 'private',
);

check(
  'unknown exact thread evidence is unknown',
  classifyCodexTerminalPresence(
    mkScan({
      unknownThreadIds: new Set([unknownThread]),
      privateThreadIds: new Set(),
      attributed: new Set(),
    }),
    unknownThread,
  ) === 'unknown',
);

check(
  'cwd+birth shared unattributed candidate can match',
  classifyCodexTerminalPresence(
    mkScan({
      attributed: new Set(),
      unattributed: [{ cwd, startedAtMs: now - 2_000 }],
      candidates: [{ pid: 101, proof: 'shared', cwd, startedAtMs: now - 2_000 }],
    }),
    '019f1234-0000-4000-8000-000000000004',
    cwd,
    now,
  ) === 'shared',
);

check(
  'cwd+birth private unattributed candidate can match',
  classifyCodexTerminalPresence(
    mkScan({
      attributed: new Set(),
      privateUnattributed: [{ cwd, startedAtMs: now - 2_000 }],
      candidates: [{ pid: 102, proof: 'private', cwd, startedAtMs: now - 2_000 }],
    }),
    '019f1234-0000-4000-8000-000000000005',
    cwd,
    now,
  ) === 'private',
);

check(
  'cwd+birth unknown unattributed candidate can match',
  classifyCodexTerminalPresence(
    mkScan({
      attributed: new Set(),
      unknownUnattributed: [{ cwd, startedAtMs: now - 2_000 }],
      candidates: [{ pid: 103, proof: 'unknown', cwd, startedAtMs: now - 2_000 }],
    }),
    '019f1234-0000-4000-8000-000000000006',
    cwd,
    now,
  ) === 'unknown',
);

check(
  'no match with scan evidence => absent',
  classifyCodexTerminalPresence(
    mkScan({
      attributed: new Set(),
      privateThreadIds: new Set(),
      unknownThreadIds: new Set(),
      unattributed: [{ cwd, startedAtMs: now - 20_000_000 }],
      privateUnattributed: [],
      unknownUnattributed: [],
      candidates: [{ pid: 104, proof: 'unknown', cwd, startedAtMs: now - 20_000_000 }],
    }),
    '019f1234-0000-4000-8000-000000000007',
    cwd,
    now,
  ) === 'absent',
);

check(
  'explicit shared candidate is not used as cwd+birth match for other threads',
  classifyCodexTerminalPresence(
    mkScan({
      candidates: [{ pid: 201, proof: 'shared', threadIds: [sharedThread], cwd, startedAtMs: now - 2_000 }],
      unattributed: [],
      privateUnattributed: [],
      unknownUnattributed: [],
    }),
    '019f1234-0000-4000-8000-000000000008',
    cwd,
    now,
  ) === 'absent',
);

check(
  'explicit private candidate is not used as cwd+birth match for other threads',
  classifyCodexTerminalPresence(
    mkScan({
      candidates: [{ pid: 202, proof: 'private', threadIds: [privateThread], cwd, startedAtMs: now - 2_000 }],
      privateUnattributed: [],
      unknownUnattributed: [],
      unattributed: [],
    }),
    '019f1234-0000-4000-8000-000000000009',
    cwd,
    now,
  ) === 'absent',
);

check(
  'explicit unknown candidate is not used as cwd+birth match for other threads',
  classifyCodexTerminalPresence(
    mkScan({
      candidates: [{ pid: 203, proof: 'unknown', threadIds: [unknownThread], cwd, startedAtMs: now - 2_000 }],
      privateUnattributed: [],
      unknownUnattributed: [],
      unattributed: [],
    }),
    '019f1234-0000-4000-8000-00000000000a',
    cwd,
    now,
  ) === 'absent',
);

check(
  'shared evidence takes precedence over private and unknown',
  classifyCodexTerminalPresence(
    mkScan({
      attributed: new Set(),
      privateThreadIds: new Set([unknownThread]),
      unknownThreadIds: new Set([unknownThread]),
      privateUnattributed: [{ cwd, startedAtMs: now - 2_000 }],
      candidates: [
        { pid: 201, proof: 'private', threadIds: [unknownThread], cwd, startedAtMs: now - 2_000 },
        { pid: 202, proof: 'shared', cwd, startedAtMs: now - 2_000 },
      ],
    }),
    unknownThread,
    cwd,
    now,
  ) === 'shared',
);

check(
  'watch refresh is triggered by presence fingerprint change',
  codexPresenceRequiresFullWatchReemit('ps:1|sd:1|a:|p:|u:|ua:|pu:|uu:|c:', 'ps:1|sd:1|a:x|p:|u:|ua:|pu:|uu:|c:') === true,
);
check(
  'watch refresh is not triggered without fingerprint change',
  !codexPresenceRequiresFullWatchReemit('ps:1|sd:1|a:x|', 'ps:1|sd:1|a:x|'),
);

check('cosyncing origin maps to app', codexRolloutLaunchSurface({ originator: 'cosyncing' }) === 'app');
check(
  'cosyncing prefix origin maps to app',
  codexRolloutLaunchSurface({ originator: 'cosyncing-ui' }) === 'app',
);
check('cosyncing origin maps to app', codexRolloutLaunchSurface({ originator: 'cosyncing' }) === 'app');
check('cosyncing prefix maps to app', codexRolloutLaunchSurface({ originator: 'cosyncing-probe' }) === 'app');
check('codex-tui origin maps to terminal', codexRolloutLaunchSurface({ originator: 'codex-tui' }) === 'terminal');
check('codex_tui origin maps to terminal', codexRolloutLaunchSurface({ originator: 'codex_tui' }) === 'terminal');
check('codex_cli_rs origin maps to terminal', codexRolloutLaunchSurface({ originator: 'codex_cli_rs' }) === 'terminal');
check('codex_vscode origin maps to ide', codexRolloutLaunchSurface({ originator: 'codex_vscode' }) === 'ide');
check('unknown originator maps to unknown', codexRolloutLaunchSurface({ originator: 'cursor' }) === 'unknown');

check(
  'active terminal sync requires shared presence (invariant helper)',
  (() => {
    const isActive = (liveLoaded: boolean, presence: string) => liveLoaded && presence === 'shared';
    return isActive(true, 'shared') && !isActive(true, 'private');
  })(),
);

check(
  'active sync emits shared presence/action on terminal control',
  (() => {
    const control = codexControlState({
      canResume: true,
      driveState: 'unavailable',
      terminalSyncActive: true,
      terminalSyncPresence: 'shared',
      terminalSyncAction: 'join',
      syncEnabled: true,
    });
    return control.terminalSync.active === true && control.terminalSync.presence === 'shared' && control.terminalSync.action === 'join';
  })(),
);

check(
  'non-shared live thread stays not active and carries non-shared presence',
  (() => {
    const control = codexControlState({
      canResume: true,
      driveState: 'driving',
      terminalSyncActive: false,
      terminalSyncPresence: 'private',
      terminalSyncAction: 'join',
      syncEnabled: true,
    });
    return control.terminalSync.active === false && control.terminalSync.presence === 'private' && control.terminalSync.action === 'join';
  })(),
);

check(
  'explicit private presence suppresses active even when terminalSyncActive is true',
  (() => {
    const control = codexControlState({
      canResume: true,
      driveState: 'unavailable',
      terminalSyncActive: true,
      terminalSyncPresence: 'private',
      terminalSyncAction: 'join',
      syncEnabled: true,
    });
    return (
      control.terminalSync.active === false &&
      control.terminalSync.presence === 'private' &&
      control.terminalSync.label === 'Sync with Codex terminal'
    );
  })(),
);

console.log(failures ? `\nFAIL: ${failures} check(s) failed.` : '\nAll codex terminal-control checks passed.');
process.exit(failures ? 1 : 0);
