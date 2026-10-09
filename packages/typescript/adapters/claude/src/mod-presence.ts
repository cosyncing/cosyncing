/**
 * The Claude mod's presence, as the adapter is allowed to see it.
 *
 * The mod registration is a broker fact: a process dialed the broker's Unix socket, and the
 * kernel said which one. The adapter must not own that truth, and it must not have to know how
 * to read a socket. So the broker injects a lookup, and this module is the narrow shape of the
 * conversation between them — one question ("does this session have a live mod right now?") and
 * one sink for the writes a live attach wants to make.
 *
 * Two rules here are the reason the module exists rather than a bare `boolean`:
 *
 * - A row goes `live` only on a FRESH registration. A stale one means the poll chain stopped,
 *   which means the terminal stopped reporting; advertising `live` there would send prompts to a
 *   process that is not listening. Absent or stale is `observe`, the fail-open shape: the
 *   transcript still mirrors, and Take over still works.
 * - The adapter asks when it builds a row and never caches. Freshness is three missed 20-second
 *   polls, evaluated when something asks; a cached answer is a second source of truth whose only
 *   possible news is that it disagrees with the registry.
 *
 * The command sink is injected for the same reason. The queue lives beside the peer credential
 * that authorises it; the adapter only hands over what the user asked for.
 */

import type {
  AgentCapabilities,
  PermissionDecidedBy,
  PermissionReleaseReason,
  SessionControlState,
} from '@cosyncing/adapter-api';

/** The mod's report on one Claude session, as the broker's registry holds it. */
export interface ClaudeModStatus {
  /** A registration exists for this session id at all. */
  present: boolean;
  /** Fresh poll chain, provably the same process, interactive terminal. The only `live` test. */
  live: boolean;
  /** Why not live, in registry vocabulary: stale | pid-dead | not-interactive | not-terminal. */
  reasons: string[];
  /** Where the session runs, from the registration rather than from the transcript. */
  cwd?: string;
  claudeVersion?: string;
}

/** A write a live Claude attach asks the mod to carry out. Mirrors the broker's `ModCommand`. */
export interface ClaudeModCommand {
  requestId: string;
  op: 'prompt' | 'steer' | 'abort' | 'answer';
  text?: string;
  turnId?: string;
  answers?: string[][];
  queuedAt: number;
}

export interface ClaudeModCommandResult {
  ok: boolean;
  /** Stable code when the broker refused: no_registration, invalid_command, queue_full. */
  code?: string;
}

/**
 * What the adapter needs from the broker's mod registry.
 *
 * Optional by design. With no bridge wired, the adapter behaves exactly as it did before the mod
 * existed, which is what keeps every existing Claude suite and every host without a socket
 * unchanged. The feature switch lives in the broker, not here.
 */
export interface ClaudeModBridge {
  /** Whether the broker's mod socket is bound right now. A bind that failed advertises no `live`. */
  serving?: () => boolean;
  status(sessionId: string): ClaudeModStatus | undefined;
  send?(sessionId: string, command: ClaudeModCommand): ClaudeModCommandResult;
  /** Mid-turn steering. Off until the app renders the transcript row it leaves. */
  steeringEnabled?: () => boolean;
  /** Whether the mod says a turn is running for this session right now. What decides prompt/steer. */
  turnRunning?: (sessionId: string) => boolean;
  /** When the mod last said this session's main turn ended, if it has. */
  turnEndedAt?: (sessionId: string) => number | undefined;
  /**
   * What the broker knows about a card it drew for this session that the transcript cannot say.
   * The transcript keeps the question and its answer, and a reload is drawn from it; this is the
   * rest of what the card showed.
   */
  cardNote?: (sessionId: string, requestId: string) => ClaudeModCardNote | undefined;
}

/** The part of a mod card's story that only the broker saw. */
export interface ClaudeModCardNote {
  /** The question went to Claude's own picker: left there by the gate, or handed there from the band. */
  inTerminal?: true;
  /** Who settled it, when the broker settled it: the app's answer, the terminal's cancel, the lease. */
  decidedBy?: PermissionDecidedBy;
  /** Why it ended without an answer from the app, where that is the resolution. */
  releaseReason?: PermissionReleaseReason;
}

export interface ClaudeAdapterOptions {
  /** The broker's mod registry, read per row. Absent means no true sync is wired here. */
  modBridge?: ClaudeModBridge;
  /** Test hook: report a mod presence without a broker. Wins over `modBridge`. */
  lookupModRegistration?: (sessionId: string) => ClaudeModStatus | undefined;
}

/** Said to the app when a live Claude session cannot take what the user asked for. */
export const CLAUDE_MOD_COMMAND_REFUSAL =
  'The cosyncing mod in your terminal could not take this. It reports what it can see, and it '
  + 'never guesses on your behalf.';

/**
 * The control of a session that WAS synced and whose mod has since gone quiet or died.
 *
 * The client's ATTACH stays: somebody is reading this transcript, and dropping the row on them
 * would look like a crash. Only the right to write is withdrawn, because there is no longer a
 * process on the other end of it. Drive comes back as `unavailable` with `takeoverAvailable`,
 * which is the honest shape -- with no mod there is nothing left to share the session with, so a
 * Take over is a legitimate fresh confirmation rather than a second writer, exactly as it was
 * before the terminal ever synced. That is also what the refusal at `resume` was protecting, and
 * the refusal is gated on the same live registration this describes the loss of.
 */
export function claudeModLostControl(opts: {
  /** Why the sync stopped, for the row and for the person reading it. */
  reason: string;
  /** The resume command for the "sync your terminal" tip, which is how the sync comes back. */
  resumeCommand: string;
}): SessionControlState {
  return {
    drive: {
      supported: false,
      state: 'unavailable',
      reason: opts.reason,
      takeoverAvailable: true,
    },
    terminalSync: {
      supported: true,
      // The path works and lights up as soon as Claude runs in that terminal again. What is
      // missing is the mod, and only the person at the keyboard can put it back.
      syncAvailable: true,
      active: false,
      presence: 'absent',
      label: 'Sync paused',
      command: opts.resumeCommand,
      note: 'Open Claude in that terminal again and the cosyncing mod re-registers on its own.',
      reason: opts.reason,
    },
  };
}

/**
 * What a refused command means to the person who sent it.
 *
 * The generic sentence is honest but unhelpful for the two refusals a user can actually act on.
 * A Stop with nothing running is not a malfunction, and "could not take this" reads like one;
 * a mod that has gone quiet is worth saying plainly, because the fix is in the terminal.
 */
export function claudeModCommandRefusal(code?: string): string {
  switch (code) {
    case 'no_active_turn':
      return 'Nothing is running in that terminal right now, so there is nothing to stop.';
    case 'stale_registration':
      return 'The cosyncing mod in that terminal has stopped reporting to cosyncing, so this was not '
        + 'delivered. It re-registers on its own within about 30 s of the broker coming back.';
    case 'command_too_large':
      return 'That is more text than cosyncing will carry into a terminal. Send it in a smaller '
        + 'piece, or paste it into the terminal itself.';
    case 'queue_full':
      return 'That terminal has everything cosyncing can queue for it right now. Try again once it catches up.';
    case 'no_registration':
      return 'That terminal is not synced right now, so this was not delivered.';
    default:
      return CLAUDE_MOD_COMMAND_REFUSAL;
  }
}

/** Why Take over is refused over a live mod: the terminal is the writer, and it is talking to us. */
export const CLAUDE_MOD_LIVE_REFUSAL =
  'This Claude session is already synced with cosyncing through its mod: your terminal is the '
  + 'writer, and the app can send to it directly. Taking over would start a second Claude on the '
  + 'same transcript, and two writers fork its history into sibling branches.';
/** Machine conflict category for the refusal above; the broker maps it to DRIVE_OWNERSHIP_CONFLICT. */
export const CLAUDE_MOD_LIVE_CONFLICT = 'terminal-sync-active';

/** The mod's floor. Below it there is no mod to talk to, so the row stays Observe. */
export const CLAUDE_MOD_MIN_VERSION = '2.1.288';

/**
 * Capabilities, computed rather than constated.
 *
 * `live` is advertised only when a mod bridge is wired — the same conditional the rows are built
 * under, because an adapter that cannot be told about registrations must not advertise a mode it
 * can never enter. Field initializers cannot read constructor parameters in TypeScript, so the
 * adapter calls this from its constructor, the shape `codexCapabilities()` uses.
 *
 * The base set is passed in rather than restated: Claude's capability record carries a long
 * history of why each member is what it is, and that belongs with the adapter.
 */
export function claudeCapabilities(
  base: AgentCapabilities,
  modBridgeEnabled: boolean,
): AgentCapabilities {
  if (!modBridgeEnabled) return base;
  return {
    ...base,
    attachModes: ['live', ...base.attachModes.filter((mode) => mode !== 'live')],
    supportsLiveAttach: true,
  };
}

/**
 * The control state of a mod-synced Claude row.
 *
 * True sync is active and the app may write: the mod can submit a prompt, stop a turn and answer
 * the engine's own permission and question prompts, so `input` is `full` and not the hooks
 * overlay's `answer-only`. Drive is unavailable rather than refused, because there is nothing to
 * take over: the terminal is already sharing the session with us.
 *
 * NO join command, and it is not an omission. A client that is not itself in the sync shows
 * `syncAvailable` and offers the adapter's join command verbatim, which is what an older app, one
 * with no idea what a mod is, does with this row. That command is `claude --resume <id>`, and
 * running it against a session whose terminal is already open, and whose session the first mod now
 * claims, forks the transcript into a second Claude that the claim then refuses. A row that is
 * already shared has no join left to offer, so there is no command to carry; the tip renders from
 * `label` and `note` alone.
 */
export function claudeModControl(opts: {
  /** Why prompts may not go through right now, when they may not. */
  blockedReason?: string;
}): SessionControlState {
  return {
    drive: {
      supported: false,
      state: 'unavailable',
      reason: CLAUDE_MOD_LIVE_REFUSAL,
    },
    terminalSync: {
      supported: true,
      syncAvailable: true,
      active: true,
      presence: 'shared',
      input: opts.blockedReason ? 'answer-only' : 'full',
      label: 'Synced with your terminal',
      note: 'Connected through the cosyncing mod in your terminal. Send prompts here, answer '
        + 'Claude\u2019s permission prompts here, and keep typing in the terminal.',
    },
  };
}

/** The live row's mode, or nothing when the mod is absent or stale. One rule for every row site. */
export function claudeModRowPatch(
  status: ClaudeModStatus | undefined,
): { attachMode: 'live' } | undefined {
  return status?.live ? { attachMode: 'live' } : undefined;
}

/**
 * True when a Claude build is at or above `floor`: the one comparison the socket's register gate,
 * setup's support check and the smoke all make.
 *
 * A version is read the way its sources hand it over -- `2.1.290`, `v2.1.290`, or `claude
 * --version`'s `2.1.290 (Claude Code)` -- and a pre-release ranks below its release, as in semver:
 * a `2.1.288-rc.1` predates the 2.1.288 the floor was measured on. Build metadata and anything
 * after the version are ignored. Text with no major.minor.patch is below every floor.
 */
export function claudeVersionAtLeast(
  version: string | undefined,
  floor: string = CLAUDE_MOD_MIN_VERSION,
): boolean {
  const a = claudeVersionParts(version);
  const b = claudeVersionParts(floor);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i]! > b.core[i]!;
  }
  return comparePrerelease(a.pre, b.pre) >= 0;
}

function claudeVersionParts(raw: string | undefined): { core: number[]; pre: string[] } | undefined {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?/.exec(String(raw ?? '').trim());
  return m ? { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] } : undefined;
}

/** Semver's pre-release order: a release ranks above any of its pre-releases. */
function comparePrerelease(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return b.length - a.length;
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const x = a[i]!;
    const y = b[i]!;
    if (x === y) continue;
    const xNumeric = /^\d+$/.test(x);
    const yNumeric = /^\d+$/.test(y);
    if (xNumeric && yNumeric) return Number(x) - Number(y);
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return a.length - b.length;
}
