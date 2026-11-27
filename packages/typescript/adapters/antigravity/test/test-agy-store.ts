/**
 * The store boundary: read the CLI's state without touching it.
 *
 * Five properties are asserted here, because each of them is a way this adapter
 * could quietly do harm or quietly lie:
 *
 *  1. Reading writes NOTHING. Not the database, not its WAL sidecars, not any
 *     file in the tree. The obvious spelling of "read-only" fails this — see the
 *     sidecar checks — so it is asserted rather than assumed.
 *  2. An IDE row can never reach the roster. The CLI and the Windows IDE share
 *     one summaries table, and an IDE row would be a row that can never open.
 *  3. A conversation with a store and no transcript yields an HONEST row whose
 *     history is a stated notice — never a crash, never a silent blank.
 *  4. The discovery cutoff and the budget are honoured.
 *  5. A path that escapes the app-data root is refused.
 *
 * Every check runs against a temp fixture tree, never a live install.
 *
 *   bun run packages/typescript/adapters/antigravity/test/test-agy-store.ts   (exit 0 = all pass)
 */
export {};
import { spawnSync } from 'node:child_process';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  isSessionCreateTemporarilyUnavailableError,
  type SetupCommandProbe,
  type SetupDiagnosisContext,
  type SetupPathInspection,
} from '@cosyncing/adapter-api';
import {
  AGY_CLI_MODELS_MAX_BACKOFF_MS,
  AGY_CLI_MODELS_TTL_MS,
  AGY_NO_AUTO_UPDATE_ENV,
  agyCliCatalogFailure,
  agyCliVersion,
  agyCliModelsBackoffMs,
  agyProbeEnv,
  cachedAgyCliCatalog,
  ensureAgyCliCatalog,
  fetchAgyCliCatalog,
  parseAgyCliModels,
  resetAgyCliCatalogForTests,
} from '../src/cli-catalog.ts';
import {
  AGY_AUTO_MODE_SETTINGS,
  AGY_DEFAULT_MODE_SETTINGS,
  AGY_MODES,
  AGY_REASONING_EFFORTS,
  AGY_SETTLEMENT_MAX_FILES,
  AGY_SMALL_JSON_MAX_BYTES,
  AGY_TASK_ID_SEGMENT,
  AgyAdapter,
  agyModelOptions,
  agyTaskLogPath,
  groupAgyModelFamilies,
  isAgyMode,
  agyModeLaunchArgs,
  agyModesFor,
  compareAgyVersions,
  parseAgyModeWarning,
  parseAgyVersion,
  parseAgyModelVariant,
  resolveAgyLaunchModel,
  scanAgyBrainDirs,
  scanAgySubagentLinks,
  containedAgyPath,
  isAgyReadRefusal,
  listAgySettlementFiles,
  listContainedDirectory,
  readContainedText,
  decodeWorkspaceUris,
  fileUriToPath,
  isAgyConversationId,
  parseAgyTimestamp,
  readAgyMetadata,
  readAgyModelCatalog,
  readAgySettingsModelLabel,
  readAgySummaries,
  resolveAgyModel,
  AGY_SIGN_IN_RECORD_FILE,
  agyCreateUnavailable,
  classifyAgyCliLogSignIn,
  defaultAgyRoots,
  diagnoseAgySetup,
  parseAgyCliLogModelAliases,
  type AgyTrace,
} from '../src/index.ts';
import { buildAgyFixtureTree, FIXTURE } from './fixtures/tree.ts';

/** Verbatim lines from agy's own run logs — see `_provenance` in the file. */
const CLI_LOG = await Bun.file(new URL('./fixtures/agy-cli-log.json', import.meta.url)).json() as {
  signInNotRestored: string[];
  signInNetworkError: string[];
  signInRestored: string[];
  modelAlias: string[];
};

/** One signed-in launch: the mode arguments, the mode the run reached, and what agy said (verbatim). */
interface CapturedAgyLaunch {
  args: string[];
  reached: string;
  stderr: string;
  log: string[];
}

/** Verbatim agy 1.5.16/1.5.18 output on modes and its updater (AG-4) — see `_provenance` in the file. */
const MODES_1_5_16 = await Bun.file(new URL('./fixtures/agy-1.5.16-modes.json', import.meta.url)).json() as {
  versionStdout: string;
  helpModeLine: string;
  stderr: { modeDefaultRefused: string; modeBogusRefused: string; modeAutoUnavailable: string; settingsDefaultRefused: string };
  log: { modeApplied: string; modeAutoUnavailable: string; updaterDisabled: string; updaterSpawned: string };
  updaterByValue: Record<string, string>;
  signedIn: {
    versionStdout: Record<'1.5.16' | '1.5.18', string>;
    helpModeLine1_5_18: string;
    launches: Record<
      | 'noMode' | 'settingsDefault' | 'settingsDefaultModeAcceptEdits' | 'settingsDefaultModePlan'
      | 'settingsDefaultModeAuto' | 'modeDefault' | 'settingsAuto',
      CapturedAgyLaunch
    >;
  };
  signedOut: { args: string[]; exitCode: number; stderr: string[]; stdout: string; log: string[] };
};

/** Point `<appData>/cli.log` at `log/<name>` holding `lines`, the relative link agy itself writes. */
function writeAgyCliLog(appData: string, name: string, lines: readonly string[]): void {
  mkdirSync(join(appData, 'log'), { recursive: true });
  writeFileSync(join(appData, 'log', name), `${lines.join('\n')}\n`);
  rmSync(join(appData, 'cli.log'), { force: true });
  symlinkSync(join('log', name), join(appData, 'cli.log'));
}

/**
 * `agy models` as 1.5.14 prints it — CONSTRUCTED, and only from measured parts: the
 * shape (a banner, then `id<TAB>displayName` rows) is the one captured on 1.1.22,
 * and both the id and the name are string constants of the installed 1.5.14
 * binary, the name being the one agy's own log resolves the saved label to. No
 * 1.5.x `agy models` output was captured: this work never runs agy.
 */
const AGY_1_5_MODELS = 'Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n';

/**
 * A stand-in `agy` for the `models` subcommand: it appends the value it saw for
 * agy's no-update variable to `runs` (one line per child — the spawn count), then
 * hangs when `slow` exists, prints `serve` when that exists, and otherwise exits 1.
 */
function writeProbeAgy(binDir: string): { binary: string; serve: string; slow: string; runs: () => string[] } {
  mkdirSync(binDir, { recursive: true });
  const binary = join(binDir, 'agy');
  const runsFile = join(binDir, 'runs');
  const serve = join(binDir, 'serve');
  const slow = join(binDir, 'slow');
  writeFileSync(binary, [
    '#!/bin/sh',
    '[ "$1" = "models" ] || exit 64',
    `printf '%s\\n' "\${AGY_CLI_DISABLE_AUTO_UPDATE-unset}" >> '${runsFile}'`,
    `[ -e '${slow}' ] && exec sleep 30`,
    `[ -e '${serve}' ] && exec cat '${serve}'`,
    'exit 1',
    '',
  ].join('\n'));
  chmodSync(binary, 0o755);
  return {
    binary,
    serve,
    slow,
    runs: () => (existsSync(runsFile) ? readFileSync(runsFile, 'utf8').split('\n').filter(Boolean) : []),
  };
}

const results: Array<{ name: string; ok: boolean }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Every file under `dir`, with its size and mtime — the before/after no-write witness. */
function snapshot(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else {
        const st = statSync(full);
        out.set(relative(dir, full), `${st.size}:${st.mtimeMs}:${readFileSync(full).byteLength}`);
      }
    }
  };
  walk(dir);
  return out;
}

function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const changes: string[] = [];
  for (const [path, stamp] of after) {
    const previous = before.get(path);
    if (previous === undefined) changes.push(`created ${path}`);
    else if (previous !== stamp) changes.push(`modified ${path}`);
  }
  for (const path of before.keys()) if (!after.has(path)) changes.push(`deleted ${path}`);
  return changes;
}

const IDS = FIXTURE.conversationIds;

// ── 1. Reading the store writes nothing ─────────────────────────────────────
{
  const tree = buildAgyFixtureTree();
  try {
    const before = snapshot(tree.dir);
    const adapter = new AgyAdapter({ roots: tree.roots, env: { PATH: '' }, trace: () => {} });
    const rows = await adapter.discoverSessions();
    const connection = await adapter.attach(IDS.withTranscript, 'observe');
    // The observe attach must carry the same control state the discovery row
    // does. When it was omitted the client failed closed to "Session control
    // status is unavailable" for every open agy session (physical pass,
    // 2026-08-27) — the pill derivation short-circuits to `unknown` whenever
    // `control` is absent, whatever the roster row said.
    check('an observe attach publishes an explicit control state',
      connection.info.control?.drive.state === 'observing'
        && connection.info.control?.drive.supported === true
        && connection.info.control?.terminalSync.supported === false,
      JSON.stringify(connection.info.control));
    await connection.getHistory();
    await connection.close();
    const after = snapshot(tree.dir);
    const changes = diffSnapshots(before, after);

    check('a full discovery + attach + history read changes no file in the store', changes.length === 0, changes.join(', '));
    check('discovery returned rows', rows.length > 0, `${rows.length} rows`);

    // The specific regression this guards: `new Database(path, {readonly:true})`
    // and `file:…?mode=ro` BOTH create `-wal` and `-shm` on a WAL database
    // (MEASURED on bun, 2026-08-25). Only `immutable=1` does not.
    const sidecars = [...after.keys()].filter((path) => path.endsWith('-wal') || path.endsWith('-shm'));
    check('reading the summaries database creates no WAL sidecars', sidecars.length === 0, sidecars.join(', '));
  } finally {
    tree.cleanup();
  }
}

// ── 2. IDE rows never reach the roster ──────────────────────────────────────
{
  const tree = buildAgyFixtureTree();
  try {
    const rows = readAgySummaries(tree.roots, {});
    const ids = rows.map((row) => row.conversationId);
    check(
      'the IDE row is filtered out at the SQL boundary',
      !ids.includes(IDS.ideRow),
      `ids: ${ids.join(', ')}`,
    );
    check(
      'every CLI row survived the filter',
      ids.includes(IDS.withTranscript) && ids.includes(IDS.withoutTranscript) && ids.includes(IDS.stale),
      ids.join(', '),
    );

    const adapter = new AgyAdapter({ roots: tree.roots, env: { PATH: '' }, trace: () => {} });
    const sessions = await adapter.discoverSessions();
    check(
      'the IDE row is absent from discoverSessions too',
      !sessions.some((session) => session.id === IDS.ideRow),
      sessions.map((session) => session.id).join(', '),
    );

    // The IDE row IS in the fixture database — otherwise the filter above would
    // be passing against a file that never contained one.
    const metadata = readAgyMetadata(tree.roots);
    check(
      'the fixture really does contain an IDE conversation (the filter is doing work)',
      metadata.get(IDS.ideRow)?.appDataDir === 'antigravity',
      String(metadata.get(IDS.ideRow)?.appDataDir),
    );
  } finally {
    tree.cleanup();
  }
}

// ── 3. A conversation with no transcript is honest, not blank ───────────────
{
  const tree = buildAgyFixtureTree();
  try {
    const traces: AgyTrace[] = [];
    const adapter = new AgyAdapter({ roots: tree.roots, env: { PATH: '' }, trace: (t) => traces.push(t) });
    const sessions = await adapter.discoverSessions();
    const row = sessions.find((session) => session.id === IDS.withoutTranscript);
    check('a conversation with no transcript still discovers', !!row, row ? row.title : 'missing');

    const connection = await adapter.attach(IDS.withoutTranscript, 'observe');
    check('a supplementary-branch attach publishes an explicit control state too',
      connection.info.control?.drive.state === 'observing',
      JSON.stringify(connection.info.control));
    const history = await connection.getHistory();
    const notice = history.find((message) => message.type === 'notice');
    check(
      'its history opens as a STATED notice rather than an empty list',
      history.length > 0 && !!notice && notice.type === 'notice' && /transcript/i.test(notice.message),
      JSON.stringify(history.slice(0, 1)),
    );
    check(
      'the missing transcript left a structured trace',
      traces.some((trace) => trace.op === 'transcript-missing'),
      traces.map((trace) => trace.op).join(', '),
    );
    check(
      'the notice is not a user message',
      !history.some((message) => message.type === 'user-message'),
      history.map((message) => message.type).join(','),
    );
    await connection.close();
    const nativeTitle = 'Native / 名称.md';
    const databasePath = join(tree.roots.appData, 'conversation_summaries.db');
    const names = new Database(databasePath);
    names.run('update conversation_summaries set title = ? where conversation_id = ?', [nativeTitle, IDS.withoutTranscript]);
    names.run('pragma wal_checkpoint(TRUNCATE)');
    names.close();
    const named = (await adapter.discoverSessions()).find((session) => session.id === IDS.withoutTranscript);
    const reopened = await adapter.attach(IDS.withoutTranscript, 'observe');
    check('a native title takes precedence over preview in both discovery and attach',
      named?.title === nativeTitle && reopened.info.title === nativeTitle,
      JSON.stringify({ discovered: named?.title, attached: reopened.info.title }));
    await reopened.close();
    const cleared = new Database(databasePath);
    cleared.run('update conversation_summaries set title = ? where conversation_id = ?', ['', IDS.withoutTranscript]);
    cleared.run('pragma wal_checkpoint(TRUNCATE)');
    cleared.close();
    check('clearing the native slot restores its stable preview without resurrecting the name',
      (await adapter.discoverSessions()).find((session) => session.id === IDS.withoutTranscript)?.title === row?.title);
  } finally {
    tree.cleanup();
  }
}

// ── 4. Cutoff and budget ────────────────────────────────────────────────────
{
  const tree = buildAgyFixtureTree();
  try {
    const all = readAgySummaries(tree.roots, {});
    const cutoff = Date.parse('2026-08-01T00:00:00Z');
    const work: Array<{ kind: string; bounded: boolean; cutoff?: number }> = [];
    const recent = readAgySummaries(tree.roots, { updatedAfter: cutoff, onWork: (w) => work.push(w) });

    check(
      'the cutoff drops the stale conversation',
      all.some((row) => row.conversationId === IDS.stale)
        && !recent.some((row) => row.conversationId === IDS.stale),
      `all=${all.length} recent=${recent.length}`,
    );
    check(
      'the cutoff keeps conversations newer than it',
      recent.some((row) => row.conversationId === IDS.withTranscript),
      recent.map((row) => row.conversationId.slice(0, 8)).join(', '),
    );
    check(
      'the bounded query reports itself through onWork with its cutoff',
      work.length === 1 && work[0]!.kind === 'sqlite-query' && work[0]!.bounded && work[0]!.cutoff === cutoff,
      JSON.stringify(work),
    );

    const limited = readAgySummaries(tree.roots, { limit: 2 });
    check('the discovery budget caps decoded rows', limited.length === 2, `${limited.length} rows`);

    const adapter = new AgyAdapter({ roots: tree.roots, env: { PATH: '' }, trace: () => {}, discoveryLimit: 1 });
    const capped = await adapter.discoverSessions();
    check('the adapter honours its own discovery limit', capped.length === 1, `${capped.length} rows`);
  } finally {
    tree.cleanup();
  }
}

// ── 5. Path containment ─────────────────────────────────────────────────────
{
  const tree = buildAgyFixtureTree();
  try {
    const roots = tree.roots;
    // Each of these RESOLVES outside the app-data root. They are passed whole,
    // not re-joined onto the root: `join(root, '/etc/passwd')` is
    // `root/etc/passwd`, which is legitimately inside and would make this pass
    // for the wrong reason.
    const escapes = [
      join(roots.appData, '..', '..', 'etc', 'passwd'),
      '/etc/passwd',
      join(roots.appData, '..', 'antigravity', 'conversations', 'x.pb'),
      join(roots.appData, 'brain', '..', '..', 'antigravity', 'x'),
    ];
    let refused = 0;
    for (const escape of escapes) {
      try {
        containedAgyPath(roots, escape);
      } catch {
        refused += 1;
      }
    }
    check('paths escaping the app-data root are refused', refused === escapes.length, `${refused} of ${escapes.length} refused`);

    // A sibling directory whose name merely EXTENDS the root must not pass as a child.
    let siblingRefused = false;
    try {
      containedAgyPath(roots, `${roots.appData}-evil/secrets`);
    } catch {
      siblingRefused = true;
    }
    check('a sibling whose name extends the root prefix is refused', siblingRefused);

    check('a real path inside the root is admitted', containedAgyPath(roots, join(roots.appData, 'brain')).endsWith('brain'));

    const adapter = new AgyAdapter({ roots, env: { PATH: '' }, trace: () => {} });
    let attachRefused = false;
    try {
      await adapter.attach('../../../etc/passwd', 'observe');
    } catch {
      attachRefused = true;
    }
    check('attach refuses an id that is not a conversation uuid', attachRefused);

    check(
      'the conversation-id gate accepts a uuid and rejects a path',
      isAgyConversationId(IDS.withTranscript) && !isAgyConversationId('../etc/passwd'),
    );
  } finally {
    tree.cleanup();
  }
}

// ── 5b. The read boundary: symlinks, FIFOs, and sizes ───────────────────────
//
// A lexical path check (section 5) proves a STRING sits under a prefix. These
// assert the three things it cannot prove, each checked on the OPENED
// DESCRIPTOR: that a symlink cannot redirect a read out of the store, that a
// FIFO cannot hang the process that opens it, and that a file's own size cannot
// decide how much memory this adapter allocates.
{
  const tree = buildAgyFixtureTree();
  try {
    const roots = tree.roots;
    const outsideSecret = join(tree.dir, 'outside-secret.txt');
    writeFileSync(outsideSecret, 'THE SECRET THAT MUST NOT BE READ');

    // 1. A symlink at the FINAL component. The path string is impeccably inside
    //    the root; the bytes it names are not.
    const finalLink = join(roots.appData, 'cache', 'linked.json');
    symlinkSync(outsideSecret, finalLink);
    const viaFinalLink = readContainedText(roots.appData, finalLink, AGY_SMALL_JSON_MAX_BYTES);
    check(
      'a symlink at the final component is refused, not followed',
      viaFinalLink === 'symlink',
      String(isAgyReadRefusal(viaFinalLink) ? viaFinalLink : 'FOLLOWED IT'),
    );

    // 2. A symlink at an INTERMEDIATE directory — the case `dirname` alone cannot
    //    see, because it stops above the final component and never resolves what
    //    it finds there.
    const outsideDir = join(tree.dir, 'outside-dir');
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, 'secret.json'), '{"stolen":true}');
    const dirLink = join(roots.appData, 'escape');
    symlinkSync(outsideDir, dirLink);
    const viaDirLink = readContainedText(roots.appData, join(dirLink, 'secret.json'), AGY_SMALL_JSON_MAX_BYTES);
    check(
      'a symlinked directory in the middle of the path is refused',
      viaDirLink === 'escapes-root',
      String(isAgyReadRefusal(viaDirLink) ? viaDirLink : 'FOLLOWED IT'),
    );

    // 3. A FIFO. Without O_NONBLOCK this open BLOCKS FOREVER with no writer, and
    //    it is the broker's event loop that stops — so the fact that this check
    //    returns at all is most of what it proves.
    const fifo = join(roots.appData, 'cache', 'pipe.json');
    const mkfifo = spawnSync('mkfifo', [fifo]);
    if (mkfifo.status === 0) {
      const startedAt = Date.now();
      const viaFifo = readContainedText(roots.appData, fifo, AGY_SMALL_JSON_MAX_BYTES);
      const elapsed = Date.now() - startedAt;
      check(
        'a FIFO is refused as a non-regular file and does not block',
        viaFifo === 'not-regular-file' && elapsed < 2000,
        `${String(viaFifo)} in ${elapsed}ms`,
      );
    } else {
      check('a FIFO is refused as a non-regular file and does not block', false, 'mkfifo unavailable');
    }

    // 4. A DIRECTORY opened as a file. Reading one yields EISDIR at best and
    //    platform-specific garbage at worst.
    const viaDir = readContainedText(roots.appData, join(roots.appData, 'cache'), AGY_SMALL_JSON_MAX_BYTES);
    check('a directory is refused as a non-regular file', viaDir === 'not-regular-file', String(viaDir));

    // 5. An absolute path with no relationship to the root at all.
    check(
      'an absolute path outside the root is refused before any open',
      readContainedText(roots.appData, '/etc/passwd', AGY_SMALL_JSON_MAX_BYTES) === 'escapes-root',
    );

    // 6. The cap bounds the ALLOCATION, and the truncation is REPORTED. A silent
    //    prefix is the dangerous outcome: it reads as a file that ended.
    const big = join(roots.appData, 'cache', 'big.txt');
    writeFileSync(big, 'x'.repeat(4096));
    const capped = readContainedText(roots.appData, big, 64);
    check(
      'a file past its cap is truncated to the cap and says so',
      !isAgyReadRefusal(capped) && capped.text.length === 64 && capped.truncated && capped.size === 4096,
      isAgyReadRefusal(capped) ? capped : `${capped.text.length} bytes, truncated=${capped.truncated}`,
    );

    // 7. A real file still reads WHOLE. A cap that quietly clipped ordinary files
    //    would be worse than no cap.
    const settingsRead = readContainedText(
      roots.appData,
      join(roots.appData, 'settings.json'),
      AGY_SMALL_JSON_MAX_BYTES,
    );
    check(
      'an ordinary file reads whole, untruncated',
      !isAgyReadRefusal(settingsRead) && !settingsRead.truncated && settingsRead.text.includes('model'),
    );

    // 8. An oversized JSON file is not parsed, and the trace names the SIZE — not
    //    a parse error, which would send a reader looking for the wrong bug.
    const traces: AgyTrace[] = [];
    writeFileSync(join(roots.appData, 'settings.json'), `{"model":"${'x'.repeat(AGY_SMALL_JSON_MAX_BYTES)}"}`);
    const oversizedLabel = readAgySettingsModelLabel(roots, (trace) => traces.push(trace));
    check(
      'a JSON file past its cap is refused as oversized, not reported as unparseable',
      oversizedLabel === undefined
      && traces.some((trace) => trace.op === 'settings-oversized')
      && !traces.some((trace) => trace.op === 'settings-unparseable'),
      traces.map((trace) => trace.op).join(','),
    );

    // 9. A byte cap says nothing about a directory holding a million files, so
    //    the listing is bounded by ENTRY COUNT independently.
    const crowded = join(roots.appData, 'crowded');
    mkdirSync(crowded, { recursive: true });
    for (let i = 0; i < 40; i += 1) writeFileSync(join(crowded, `f${i}.json`), '{}');
    const listed = listContainedDirectory(roots.appData, crowded, 8);
    check(
      'a directory listing is bounded by entry count and says so',
      !isAgyReadRefusal(listed) && listed.names.length === 8 && listed.truncated,
      isAgyReadRefusal(listed) ? listed : `${listed.names.length} names, truncated=${listed.truncated}`,
    );

    check(
      'a directory outside the root is refused',
      listContainedDirectory(roots.appData, tree.dir, 8) === 'escapes-root',
    );

    // 10. The settlement inbox is the directory this actually protects, and it is
    //     capped at a value far above the largest real one (19 entries measured).
    check(
      'the settlement inbox cap is well above the largest measured inbox',
      AGY_SETTLEMENT_MAX_FILES >= 512,
      String(AGY_SETTLEMENT_MAX_FILES),
    );

    // 11. The cap must bound the WORK, not just the result. `readdirSync`
    //     materializes every name in the directory before anything can be
    //     trimmed, so a million-entry inbox was fully read and fully allocated
    //     and only then sliced. Enumerating iteratively stops at `maxEntries + 1`
    //     — the +1 being exactly what separates "at the cap" from "over it", so
    //     truncation is REPORTED rather than guessed.
    //
    //     Asserted through the io surface — how many names came back and whether
    //     truncation was reported — never through timing.
    const huge = join(roots.appData, 'huge');
    mkdirSync(huge, { recursive: true });
    for (let i = 0; i < 300; i += 1) writeFileSync(join(huge, `m${i}.json`), '{}');

    const atCap = listContainedDirectory(roots.appData, huge, 300);
    check(
      'a directory exactly AT the cap is not reported as truncated',
      !isAgyReadRefusal(atCap) && atCap.names.length === 300 && !atCap.truncated,
      isAgyReadRefusal(atCap) ? atCap : `${atCap.names.length} names, truncated=${atCap.truncated}`,
    );

    const overCap = listContainedDirectory(roots.appData, huge, 299);
    check(
      'one entry OVER the cap stops at the cap and reports truncation',
      !isAgyReadRefusal(overCap) && overCap.names.length === 299 && overCap.truncated,
      isAgyReadRefusal(overCap) ? overCap : `${overCap.names.length} names, truncated=${overCap.truncated}`,
    );

    const tinyTraces: AgyTrace[] = [];
    const tiny = listContainedDirectory(roots.appData, huge, 4, (trace) => tinyTraces.push(trace));
    check(
      'a small cap over a large directory yields exactly the cap, and says so',
      !isAgyReadRefusal(tiny)
      && tiny.names.length === 4
      && tiny.truncated
      && tinyTraces.some((trace) => trace.op === 'directory-truncated'),
      isAgyReadRefusal(tiny) ? tiny : `${tiny.names.length} names; ${tinyTraces.map((t) => t.op).join(',')}`,
    );

    // An iterative reader that miscounted could return repeated or invented
    // names, which a length check alone would not catch.
    const actual = new Set(readdirSync(huge));
    check(
      'the bounded listing returns real, distinct entries of that directory',
      !isAgyReadRefusal(tiny)
      && new Set(tiny.names).size === tiny.names.length
      && tiny.names.every((name) => actual.has(name)),
      isAgyReadRefusal(tiny) ? tiny : tiny.names.join(','),
    );

    check(
      'the settlement listing sits on the same bounded rule',
      listAgySettlementFiles(roots, IDS.withTranscript).length <= AGY_SETTLEMENT_MAX_FILES,
    );
  } finally {
    tree.cleanup();
  }
}

// ── 6. Decoding: timestamps, workspace uris, the model join ─────────────────
{
  const tree = buildAgyFixtureTree();
  try {
    // Go's zero time parses to 2001-01-01 via Date.parse on V8 — a plausible-looking
    // wrong answer, which is why it is matched textually before any parse.
    check(
      "Go's zero time decodes to undefined, not to 2001",
      parseAgyTimestamp('0001-01-01 00:00:00+00:00') === undefined
        && parseAgyTimestamp('0001-01-01T00:00:00Z') === undefined,
      String(parseAgyTimestamp('0001-01-01 00:00:00+00:00')),
    );
    check(
      'the space-separated nanosecond datetime decodes',
      parseAgyTimestamp('2026-08-20 10:15:46.027884138+00:00') === Date.parse('2026-08-20T10:15:46.027Z'),
    );
    check(
      'the RFC3339 nanosecond form decodes',
      parseAgyTimestamp('2026-08-20T10:15:46.027884138Z') === Date.parse('2026-08-20T10:15:46.027Z'),
    );
    check('a non-string decodes to undefined', parseAgyTimestamp(null) === undefined && parseAgyTimestamp(17) === undefined);

    check(
      'workspace uris decode to absolute paths',
      decodeWorkspaceUris('["file:///fixture/demo-project"]')[0] === '/fixture/demo-project',
    );
    check('an empty workspace_uris decodes to no dirs', decodeWorkspaceUris('').length === 0);
    check('a percent-encoded file uri decodes', fileUriToPath('file:///fixture/my%20project') === '/fixture/my project');
    check('a non-file uri decodes to undefined', fileUriToPath('https://example.invalid/x') === undefined);

    const catalog = readAgyModelCatalog(tree.roots);
    const label = readAgySettingsModelLabel(tree.roots);
    check('settings.json stores the model LABEL, not the id', label === 'Gemini 3.7 Flash (High)', String(label));

    const traces: AgyTrace[] = [];
    const model = resolveAgyModel(catalog, label, (t) => traces.push(t));
    check(
      'the label joins the catalog to an id, and the label comes back FROM the catalog',
      model?.modelID === 'gemini-3.7-flash-high' && model.label === 'Gemini 3.7 Flash (High)'
        && model.providerID === 'google-antigravity',
      JSON.stringify(model),
    );

    // Four ids publish "Gemini 3.1 Flash Lite" on the real host; the fixture keeps three.
    const ambiguous = resolveAgyModel(catalog, 'Gemini 3.1 Flash Lite', (t) => traces.push(t));
    check(
      'an AMBIGUOUS label refuses rather than picking one of several ids',
      ambiguous === undefined,
      JSON.stringify(ambiguous),
    );
    check(
      'a label that does not join leaves a structured trace',
      resolveAgyModel(catalog, 'No Such Model', (t) => traces.push(t)) === undefined
        && traces.some((trace) => trace.op === 'model-join' && /No Such Model/.test(trace.detail)),
      traces.map((trace) => trace.detail).join(' | '),
    );
  } finally {
    tree.cleanup();
  }
}

// ── 7. The SessionInfo contract ─────────────────────────────────────────────
{
  const tree = buildAgyFixtureTree();
  try {
    const adapter = new AgyAdapter({ roots: tree.roots, env: { PATH: '' }, trace: () => {} });
    const sessions = await adapter.discoverSessions();
    const row = sessions.find((session) => session.id === IDS.withTranscript)!;

    check('id === nativeId === the conversation uuid (no path encoding)',
      row.id === IDS.withTranscript && row.nativeId === IDS.withTranscript);
    check('tool is the backend id', row.tool === 'agy', row.tool);
    check('the title is the host-published preview', row.title === 'Demo Project Review', row.title);
    check('cwd comes from workspace_uris[0]', row.cwd === '/fixture/demo-project', String(row.cwd));
    check('projectName is the cwd basename', row.projectName === 'demo-project', String(row.projectName));
    // The transcript in this tree was written at build time, so the merged
    // recency is the mtime, newer than the frozen table's last_modified_time
    // — see 12b′ for the pinned merge semantics in both directions.
    check('updatedAt is the newest evidence from either source, at least last_modified_time',
      (row.updatedAt ?? 0) >= Date.parse('2026-08-20T10:15:46.027Z'), String(row.updatedAt));
    check('attachMode is observe — opening never spawns a child', row.attachMode === 'observe');
    check('status is idle, never an invented working state', row.status === 'idle');
    check(
      'terminalSyncHint carries the exact resume command and the workspace dir',
      row.terminalSyncHint?.command === `agy --conversation ${IDS.withTranscript}`
        && row.terminalSyncHint.label === 'Resume in terminal'
        && (row.terminalSyncHint.note ?? '').includes('/fixture/demo-project'),
      JSON.stringify(row.terminalSyncHint),
    );
    check(
      'currentModel rides the DISCOVERY row with a host-published label',
      row.currentModel?.modelID === 'gemini-3.7-flash-high' && row.currentModel.label === 'Gemini 3.7 Flash (High)',
      JSON.stringify(row.currentModel),
    );
    check(
      'no currentMode on a discovery row (unsupported in P0, stated in the doc comment)',
      row.currentMode === undefined,
    );
    check('no origin/parentThreadId in P0 (columns unpopulated on every real row)',
      row.origin === undefined && row.parentThreadId === undefined);

    // Reflection §2's corollary: clearing needs an EXPLICIT key, not an omitted one.
    const noCatalog = buildAgyFixtureTree();
    try {
      const broken = new AgyAdapter({
        roots: { appData: noCatalog.roots.appData, cockpitCache: join(noCatalog.dir, 'nope') },
        env: { PATH: '' },
        trace: () => {},
      });
      const rows = await broken.discoverSessions();
      const first = rows[0]!;
      check(
        'a failed model join publishes currentModel as an explicit undefined KEY',
        'currentModel' in first && first.currentModel === undefined,
        `hasKey=${'currentModel' in first} value=${String(first.currentModel)}`,
      );
    } finally {
      noCatalog.cleanup();
    }
  } finally {
    tree.cleanup();
  }
}

// ── 8. Availability and attach-mode refusal ─────────────────────────────────
{
  const tree = buildAgyFixtureTree();
  try {
    // A removed binary leaves a readable store: still discoverable, and the broker lists its
    // conversations Observe-only because `isInstalled` says the binary is gone.
    const withoutBinary = new AgyAdapter({ roots: tree.roots, env: { PATH: '' }, trace: () => {} });
    check('discoverable from the store alone when no agy binary is on PATH', (await withoutBinary.isAvailable()) === true);
    check('not installed when no agy binary is on PATH', withoutBinary.isInstalled() === false);

    // A fake binary on a fake PATH.
    const binDir = join(tree.dir, 'bin');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'agy'), '#!/bin/sh\nexit 0\n');
    const withBinary = new AgyAdapter({ roots: tree.roots, env: { PATH: binDir }, trace: () => {} });
    check('available when the binary and the app-data root both exist', (await withBinary.isAvailable()) === true);
    check('installed when an agy binary is on PATH', withBinary.isInstalled() === true);

    const noStore = new AgyAdapter({
      roots: { appData: join(tree.dir, 'absent'), cockpitCache: tree.roots.cockpitCache },
      env: { PATH: binDir },
      trace: () => {},
    });
    check('unavailable when the app-data root is absent, even with a binary', (await noStore.isAvailable()) === false);

    const adapter = new AgyAdapter({ roots: tree.roots, env: { PATH: binDir }, trace: () => {} });
    // A mode the adapter does not implement must REFUSE, never silently downgrade
    // to observe: a client told it was driving while nothing drives is the exact
    // shape reflection §11 warns about. `resume` IS implemented (see the drive
    // suite); `live` is not, and stays a loud no.
    let refusal = '';
    try {
      await adapter.attach(IDS.withTranscript, 'live');
    } catch (error) {
      refusal = String(error);
    }
    check(
      'an unsupported attach mode REFUSES rather than silently downgrading to observe',
      /not available/.test(refusal),
      refusal,
    );
    const observe = await adapter.attach(IDS.withTranscript, 'observe');
    check('an observe attach succeeds', observe.info.id === IDS.withTranscript);
    check('an observe attach is not registered as driving', adapter.isDriving(IDS.withTranscript) === false);
    await observe.close();

    // Drive needs a binary it can actually spawn; refusing here is better than
    // handing back a Drive whose first prompt was always going to fail.
    const noBinary = new AgyAdapter({ roots: tree.roots, env: { PATH: '' }, trace: () => {} });
    let driveRefused = false;
    try {
      await noBinary.attach(IDS.withTranscript, 'resume');
    } catch {
      driveRefused = true;
    }
    check('a resume attach with no agy on PATH refuses rather than promising a drive', driveRefused);

    let unknownRefused = false;
    try {
      await adapter.attach('99999999-9999-4999-8999-999999999999', 'observe');
    } catch {
      unknownRefused = true;
    }
    check('attaching an id nothing on disk knows refuses cleanly', unknownRefused);
  } finally {
    tree.cleanup();
  }
}

// ── 9. The model picker (P2a) ──────────────────────────────────────────────
//
// The catalog is the ONLY publisher of a model's name and of its effort, and
// both facts are read from the host's own `displayName` — never from the id.
// The live catalog contradicts the id on two of its 25 rows, so an id-derived
// effort is not a shortcut, it is a wrong answer.
{
  const tree = buildAgyFixtureTree();
  try {
    const catalog = readAgyModelCatalog(tree.roots);
    const label = readAgySettingsModelLabel(tree.roots);
    const options = agyModelOptions(catalog, { ...(label ? { settingsLabel: label } : {}) });
    const byLabel = new Map(options.map((option) => [option.label, option]));

    check('a base model with several effort variants collapses into ONE row',
      options.filter((option) => option.label === 'Gemini 3.7 Flash').length === 1,
      options.map((option) => option.label).join(' | '));

    const flash37 = byLabel.get('Gemini 3.7 Flash');
    check('the collapsed row lists its efforts in the host\'s own low→medium→high order',
      JSON.stringify(flash37?.reasoningEfforts?.map((entry) => entry.effort)) === JSON.stringify(['low', 'medium', 'high']),
      JSON.stringify(flash37?.reasoningEfforts));
    check('the effort vocabulary is the binary\'s own three, not three chosen here',
      JSON.stringify([...AGY_REASONING_EFFORTS]) === JSON.stringify(['low', 'medium', 'high']));

    // The whole reason `--effort` is never passed: the row must name a REAL id.
    check('every emitted modelID is an id the catalog actually publishes',
      options.every((option) => catalog.byId.has(option.modelID)),
      options.filter((option) => !catalog.byId.has(option.modelID)).map((option) => option.modelID).join(','));

    check('the settings label preselects its family\'s effort — a MEASURED default, not a guessed one',
      flash37?.defaultReasoningEffort === 'high' && flash37?.modelID === 'gemini-3.7-flash-high',
      `${flash37?.defaultReasoningEffort} / ${flash37?.modelID}`);

    // Four ids publish "Gemini 3.1 Flash Lite" on the real host; the fixture keeps
    // three. Each is separately launchable, so each is listed, and the only thing
    // that tells them apart is their own id.
    const lite = options.filter((option) => option.label === 'Gemini 3.1 Flash Lite');
    check('an ambiguous label lists EVERY id rather than reverse-joining to one',
      lite.length === 3 && lite.every((option) => option.description === option.modelID),
      lite.map((option) => `${option.modelID}:${option.description}`).join(' | '));

    // A duplicate inside a family: first wins the effort slot, and the loser is
    // still reachable as its own row rather than vanishing from the picker.
    const families = groupAgyModelFamilies(catalog);
    check('a duplicate (family, effort) keeps the FIRST id and traces the collision',
      families.get('Gemini 3.5 Flash')?.byEffort.get('low') === 'gemini-3.5-flash-low',
      String(families.get('Gemini 3.5 Flash')?.byEffort.get('low')));
    check('the collision loser is still listed under its own full label',
      options.some((option) => option.modelID === 'gemini-3-flash-agent'),
      options.map((option) => option.modelID).join(','));

    let collisionTraced = false;
    groupAgyModelFamilies(catalog, (trace) => {
      if (trace.op === 'model-variant-collision') collisionTraced = true;
    });
    check('the collision is TRACED rather than silently resolved', collisionTraced);

    // The id says "low", the host says "(Medium)". The host wins, because the id
    // is an opaque handle and the displayName is a published fact.
    check('effort comes from the displayName parenthetical, never from the id',
      parseAgyModelVariant('Gemini 3.5 Flash (Medium)')?.effort === 'medium'
        && families.get('Gemini 3.5 Flash')?.byEffort.get('medium') === 'gemini-3.5-flash-medium',
      String(families.get('Gemini 3.5 Flash')?.byEffort.get('medium')));
    check('"(Thinking)" is a model NAME, not an effort level',
      parseAgyModelVariant('Claude Sonnet 4.6 (Thinking)') === undefined);

    // The re-expansion. A picker row plus an effort names the SIBLING id, and the
    // launch therefore passes `--model <sibling>` and never `--effort`.
    check('a row plus an effort resolves to the sibling id',
      resolveAgyLaunchModel(catalog, { modelID: 'gemini-3.7-flash-high', reasoningEffort: 'low' })
        === 'gemini-3.7-flash-low');
    check('a selection with no effort needs no lookup and passes straight through',
      resolveAgyLaunchModel(catalog, { modelID: 'claude-sonnet-4-6' }) === 'claude-sonnet-4-6');

    const unmapped: AgyTrace[] = [];
    const kept = resolveAgyLaunchModel(
      catalog,
      { modelID: 'claude-sonnet-4-6', reasoningEffort: 'high' },
      (trace) => unmapped.push(trace),
    );
    check('an effort on a model that has none DEGRADES to the id sent, and says so',
      kept === 'claude-sonnet-4-6' && unmapped.some((trace) => trace.op === 'model-effort-unmapped'),
      `${kept} / ${unmapped.map((trace) => trace.op).join(',')}`);

    const missing: AgyTrace[] = [];
    const fallback = resolveAgyLaunchModel(
      catalog,
      { modelID: 'gemini-3.5-flash-low', reasoningEffort: 'high' },
      (trace) => missing.push(trace),
    );
    check('an effort the family does not have keeps the id rather than inventing one',
      fallback === 'gemini-3.5-flash-low' && missing.some((trace) => trace.op === 'model-effort-unmapped'),
      `${fallback} / ${missing.map((trace) => trace.detail).join(',')}`);
  } finally {
    tree.cleanup();
  }
}

// ── 10. The mode picker (P2b, AG-4) ─────────────────────────────────────────
//
// Four modes in agy's own cycle order, `auto` since 1.3.5. The values that are
// NOT here matter as much as the ones that are: `full-access` occurs nowhere in
// the binary, and `request-review`/`always-proceed`/`strict` belong to the
// separate auto-approval axis that has no flag at all.
{
  check('listModes offers the four modes in agy\'s own cycle order',
    JSON.stringify(AGY_MODES.map((mode) => mode.value)) === JSON.stringify(['default', 'accept-edits', 'auto', 'plan']),
    AGY_MODES.map((mode) => mode.value).join(','));
  check('`full-access` is not among them — it is not a value agy has',
    !AGY_MODES.some((mode) => mode.value === 'full-access'));
  check('the auto-approval vocabulary is NOT offered as a mode',
    !AGY_MODES.some((mode) => ['request-review', 'always-proceed', 'strict'].includes(mode.value)));
  check('plan is filed as custom, not as a permission posture',
    AGY_MODES.find((mode) => mode.value === 'plan')?.category === 'custom');
  check('auto sits in the existing approve-for-me group with accept-edits, not as full access',
    AGY_MODES.find((mode) => mode.value === 'auto')?.category === 'approve-for-me');
  check('every mode carries the host\'s own one-clause description',
    AGY_MODES.every((mode) => (mode.description ?? '').length > 0));
  check('isAgyMode accepts the four and refuses everything else',
    isAgyMode('plan') && isAgyMode('default') && isAgyMode('accept-edits') && isAgyMode('auto')
      && !isAgyMode('request-review') && !isAgyMode('full-access') && !isAgyMode(undefined));

  // AG-4: the binary's own vocabulary and version, as 1.5.16 printed them.
  check('1.5.16\'s `--mode` help names accept-edits, auto and plan — and not default',
    MODES_1_5_16.helpModeLine.includes('(accept-edits, auto, plan)'), MODES_1_5_16.helpModeLine);
  check('`agy --version` output parses to its version', parseAgyVersion(MODES_1_5_16.versionStdout) === '1.5.16');
  check('versions compare numerically, not as text',
    compareAgyVersions('1.5.16', '1.5.7') > 0 && compareAgyVersions('1.3.5', '1.3.5') === 0
      && compareAgyVersions('1.1.20', '1.3.5') < 0);
  check('the picker drops auto only for an agy that predates it (1.3.5; 1.4.4 on Windows)',
    !agyModesFor('1.1.20', 'linux').some((mode) => mode.value === 'auto')
      && agyModesFor('1.3.5', 'linux').some((mode) => mode.value === 'auto')
      && !agyModesFor('1.4.0', 'win32').some((mode) => mode.value === 'auto')
      && agyModesFor('1.5.16', 'win32').length === 4
      && agyModesFor(undefined, 'linux').length === 4,
    agyModesFor('1.1.20', 'linux').map((mode) => mode.value).join(','));

  // Every launch names its mode. On 1.5.16 `--mode default` is refused, so Default
  // is pinned through session settings; accept-edits and plan add `--mode`; and
  // Auto is its own session setting, because print mode refuses `--mode auto`
  // before it restores the sign-in. Each encoding is the argv the signed-in
  // capture (1.5.16 and 1.5.18) saw reach that mode.
  const current = (mode?: string) => agyModeLaunchArgs(mode, '1.5.16', 'linux');
  const launches = MODES_1_5_16.signedIn.launches;
  check('1.5.16: Default is pinned with `--settings {"agentMode":""}`, never `--mode default`',
    JSON.stringify(current('default').args) === JSON.stringify(['--settings', AGY_DEFAULT_MODE_SETTINGS])
      && AGY_DEFAULT_MODE_SETTINGS === '{"agentMode":""}',
    JSON.stringify(current('default').args));
  check('1.5.16: no mode chosen is Default, not agy\'s own Auto',
    JSON.stringify(current(undefined)) === JSON.stringify(current('default')) && current(undefined).mode === 'default');
  const encodedAs: Array<[string, CapturedAgyLaunch]> = [
    ['default', launches.settingsDefault],
    ['accept-edits', launches.settingsDefaultModeAcceptEdits],
    ['plan', launches.settingsDefaultModePlan],
    ['auto', launches.settingsAuto],
  ];
  // 1.5.18 ran Default and Auto (not accept-edits or plan) with the same outcome.
  for (const [version, modes] of [['1.5.16', ['default', 'accept-edits', 'plan', 'auto']], ['1.5.18', ['default', 'auto']]] as const) {
    const ran = encodedAs.filter(([mode]) => (modes as readonly string[]).includes(mode));
    check(`${version}: ${modes.join(', ')} launch with the argv the signed-in capture saw reach each`,
      ran.length === modes.length && ran.every(([mode, captured]) => captured.reached === mode
        && JSON.stringify(agyModeLaunchArgs(mode, version, 'linux').args) === JSON.stringify(captured.args)),
      ran.map(([mode]) => `${mode}=${JSON.stringify(agyModeLaunchArgs(mode, version, 'linux').args)}`).join(' '));
  }
  check('1.5.16: Auto is `--settings {"agentMode":"auto"}` alone — no `--mode`, no Default pin',
    JSON.stringify(current('auto').args) === JSON.stringify(['--settings', AGY_AUTO_MODE_SETTINGS])
      && AGY_AUTO_MODE_SETTINGS === '{"agentMode":"auto"}' && !current('auto').pinsDefault,
    JSON.stringify(current('auto')));
  check('…because `--mode auto` over the pin was captured landing in Default, with agy blaming the account',
    launches.settingsDefaultModeAuto.reached === 'default'
      && JSON.stringify(current('auto').args) !== JSON.stringify(launches.settingsDefaultModeAuto.args)
      && parseAgyModeWarning(launches.settingsDefaultModeAuto.stderr)?.kind === 'unavailable'
      && /printmode\.go:903\].*rollout flag off/.test(launches.settingsDefaultModeAuto.log[0] ?? '')
      && /printmode\.go:410\].*not authenticated, trying silent auth/.test(launches.settingsDefaultModeAuto.log[1] ?? ''),
    JSON.stringify(launches.settingsDefaultModeAuto));
  check('…and the settings Auto launch reached Auto with nothing on stderr',
    launches.settingsAuto.stderr === '' && /SetCycleMode called: auto$/.test(launches.settingsAuto.log[0] ?? ''),
    JSON.stringify(launches.settingsAuto));
  check('1.5.16: Default, accept-edits and plan pin Default, so agy\'s "continuing in the default mode" means Default',
    ['default', 'accept-edits', 'plan'].every((mode) => current(mode).pinsDefault));
  check('an unknown version is encoded as current upstream, never as the old `--mode default`',
    ['default', 'accept-edits', 'auto', 'plan'].every((mode) => JSON.stringify(agyModeLaunchArgs(mode, undefined, 'linux').args)
      === JSON.stringify(current(mode).args)));
  check('1.5.18 prints the same `--mode` help and version shape as 1.5.16',
    MODES_1_5_16.signedIn.helpModeLine1_5_18 === MODES_1_5_16.helpModeLine
      && parseAgyVersion(MODES_1_5_16.signedIn.versionStdout['1.5.18']) === '1.5.18'
      && parseAgyVersion(MODES_1_5_16.signedIn.versionStdout['1.5.16']) === '1.5.16',
    MODES_1_5_16.signedIn.helpModeLine1_5_18);
  check('before 1.5.7 every mode is `--mode <mode>`, default included, with no --settings',
    JSON.stringify(agyModeLaunchArgs('default', '1.1.20', 'linux').args) === JSON.stringify(['--mode', 'default'])
      && JSON.stringify(agyModeLaunchArgs('auto', '1.4.10', 'linux').args) === JSON.stringify(['--mode', 'auto'])
      && !agyModeLaunchArgs('plan', '1.5.6', 'linux').pinsDefault);
  const tooOld = agyModeLaunchArgs('auto', '1.1.20', 'linux');
  check('auto on an agy older than 1.3.5 launches Default and says why',
    tooOld.mode === 'default' && JSON.stringify(tooOld.args) === JSON.stringify(['--mode', 'default'])
      && (tooOld.refused ?? '').includes('1.1.20'),
    JSON.stringify(tooOld));
  const offVocabulary = agyModeLaunchArgs('full-access', '1.5.16', 'linux');
  check('a value agy has no mode for launches Default and says why',
    offVocabulary.mode === 'default' && (offVocabulary.refused ?? '').includes('full-access'),
    JSON.stringify(offVocabulary));

  // agy's own stderr when it does not apply a mode — the lines the drive reads.
  const refusedDefault = parseAgyModeWarning(MODES_1_5_16.stderr.modeDefaultRefused);
  check('the captured `--mode default` refusal reads as unrecognized "default"',
    refusedDefault?.kind === 'unrecognized' && refusedDefault.value === 'default', JSON.stringify(refusedDefault));
  const refusedBogus = parseAgyModeWarning(MODES_1_5_16.stderr.modeBogusRefused);
  check('the captured refusal of an unknown value names that value',
    refusedBogus?.kind === 'unrecognized' && refusedBogus.value === 'bogus', JSON.stringify(refusedBogus));
  const unavailable = parseAgyModeWarning(MODES_1_5_16.stderr.modeAutoUnavailable);
  check('the captured "auto is not available" warning reads as unavailable auto',
    unavailable?.kind === 'unavailable' && unavailable.value === 'auto', JSON.stringify(unavailable));
  check('the captured signed-in refusals parse the same way',
    parseAgyModeWarning(launches.modeDefault.stderr)?.kind === 'unrecognized'
      && parseAgyModeWarning(launches.settingsDefaultModeAuto.stderr)?.value === 'auto');
  // With Auto's rollout flag off (the scratch home signed out), the settings route
  // says nothing about the mode: only the sign-in error, then exit 1. So no notice
  // can come from it, and the row keeps the Auto it launched.
  check('signed out, settings Auto prints no line the drive reads as a mode warning',
    MODES_1_5_16.signedOut.exitCode === 1
      && JSON.stringify(MODES_1_5_16.signedOut.args) === JSON.stringify(current('auto').args)
      && MODES_1_5_16.signedOut.stderr.length === 2
      && MODES_1_5_16.signedOut.stderr.every((line) => parseAgyModeWarning(line) === undefined)
      && !MODES_1_5_16.signedOut.log.some((line) => /SetCycleMode|agent mode|--mode|agentMode/.test(line)),
    MODES_1_5_16.signedOut.stderr.join(' | '));
  check('other stderr — the settings refusal, agy\'s log lines — is not a mode warning',
    parseAgyModeWarning(MODES_1_5_16.stderr.settingsDefaultRefused) === undefined
      && parseAgyModeWarning(MODES_1_5_16.log.modeAutoUnavailable) === undefined
      && parseAgyModeWarning(MODES_1_5_16.log.modeApplied) === undefined
      && parseAgyModeWarning('warning: ignoring unsupported stream input message event "future_thing"') === undefined);
}

// ── 10b. The installed agy's version is read once per binary image (AG-4) ────
//
// The Drive encodes its mode per agy version and the picker offers Auto only to an
// agy that has it, so the version is read with `agy --version` — the probe 1.5.16
// answered in 0.13 s without a run log — once per binary image, with agy's
// self-update off. A stand-in prints the captured output and records each run.
{
  const tree = buildAgyFixtureTree();
  try {
    resetAgyCliCatalogForTests();
    const binDir = join(tree.dir, 'version-bin');
    mkdirSync(binDir, { recursive: true });
    const binary = join(binDir, 'agy');
    const runsFile = join(binDir, 'runs');
    const writeStandIn = (version: string) => {
      writeFileSync(binary, [
        '#!/bin/sh',
        '[ "$1" = "--version" ] || exit 64',
        `printf '%s\\n' "\${AGY_CLI_DISABLE_AUTO_UPDATE-unset}" >> '${runsFile}'`,
        `printf '%s' '${version}'`,
        '',
      ].join('\n'));
      chmodSync(binary, 0o755);
    };
    const runs = () => (existsSync(runsFile) ? readFileSync(runsFile, 'utf8').split('\n').filter(Boolean) : []);
    writeStandIn(MODES_1_5_16.versionStdout);
    const traces: AgyTrace[] = [];
    const first = await agyCliVersion(binary, { trace: (trace) => traces.push(trace) });
    const again = await agyCliVersion(binary, { trace: (trace) => traces.push(trace) });
    check('the version is read from `agy --version`, once for the same binary image',
      first === '1.5.16' && again === '1.5.16' && runs().length === 1, `${first}/${again}; ${runs().length} runs`);
    check('the version read runs with agy\'s self-update off', runs().every((value) => value === 'true'), runs().join(','));
    check('the read is traced with the version it found',
      traces.some((trace) => trace.op === 'cli-version' && trace.detail.includes('1.5.16')),
      traces.map((trace) => trace.detail).join(' | '));
    // agy replaces itself: a new image (here a different size and mtime) is read again.
    writeStandIn('1.5.17\n');
    utimesSync(binary, new Date(Date.now() + 60_000), new Date(Date.now() + 60_000));
    const replaced = await agyCliVersion(binary);
    check('a replaced binary is read again', replaced === '1.5.17' && runs().length === 2, `${replaced}; ${runs().length} runs`);
    // An agy that prints no version leaves it unknown, which callers read as current upstream.
    writeFileSync(binary, '#!/bin/sh\nexit 3\n');
    chmodSync(binary, 0o755);
    utimesSync(binary, new Date(Date.now() + 120_000), new Date(Date.now() + 120_000));
    check('a failed read is undefined, not a guess', await agyCliVersion(binary) === undefined);
  } finally {
    resetAgyCliCatalogForTests();
    tree.cleanup();
  }
}

// ── 11. Subagent lineage and the frozen summaries table (P2d) ──────────────
//
// A child is named by ONE thing: a settlement whose sender is a bare
// conversation id. The three other measured sender shapes must not produce a
// link, because each of them would invent a session.
{
  const tree = buildAgyFixtureTree({ withSettlementTaxonomy: true, withSubagentChild: true });
  try {
    const live = FIXTURE.conversationIds.withTranscript;
    const child = FIXTURE.conversationIds.subagentChild;
    const links = scanAgySubagentLinks(tree.roots, [live]);
    check('a bare-conversation-id sender names a CHILD', links.get(child) === live, JSON.stringify([...links]));
    check('exactly one link — the task, `system` and senderless rows name no child',
      links.size === 1, JSON.stringify([...links]));
    check('a `<uuid>/task-N` sender is a task and never a child',
      !links.has(`${live}/task-7`) && ![...links.keys()].some((key) => key.includes('/')));

    let work = 0;
    scanAgySubagentLinks(tree.roots, [live], { onWork: () => { work += 1; } });
    check('every settlement opened is reported as decode work', work > 0, String(work));

    const bounded = scanAgySubagentLinks(tree.roots, [live], { budget: 0 });
    check('a spent budget stops the scan rather than reading on', bounded.size === 0);

    // The inbox's own bookkeeping is not a settlement and must not be reported as
    // an unreadable one: both files parse fine and simply have no `sender`.
    const listed = listAgySettlementFiles(tree.roots, live).map((file) => file.split('/').pop());
    check('the inbox bookkeeping files are excluded, not reported as unparseable',
      !listed.includes('read.json') && !listed.includes('cursor.json'),
      listed.join(','));
    const noise: AgyTrace[] = [];
    scanAgySubagentLinks(tree.roots, [live], { trace: (trace) => noise.push(trace) });
    check('a healthy inbox produces no degradation traces at all',
      noise.length === 0, noise.map((trace) => `${trace.op}:${trace.detail}`).join(' | '));

    // The child has a brain dir and NO summaries row — which is how both real
    // children were found, and why discovery cannot be the table alone.
    const scanned = scanAgyBrainDirs(tree.roots, { only: [child] });
    check('`only` narrows the brain scan to the one conversation asked for',
      scanned.length === 1 && scanned[0]?.conversationId === child,
      scanned.map((row) => row.conversationId).join(','));
    check('the child derives a title from its OWN first user prompt',
      (scanned[0]?.firstUserContent ?? '').startsWith('Reply with the single word'),
      String(scanned[0]?.firstUserContent));
  } finally {
    tree.cleanup();
  }
}

// ── 12. A row that DISCOVERS must OPEN (discovery staleness) ───────────────
{
  const tree = buildAgyFixtureTree({ withSubagentChild: true, withSupplementaryConversation: true });
  const binDir = join(tree.dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, 'agy'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  try {
    const adapter = new AgyAdapter({ roots: tree.roots, env: { PATH: binDir }, trace: () => {} });
    const rows = await adapter.discoverSessions();
    const ids = new Set(rows.map((row) => row.id));
    const child = FIXTURE.conversationIds.subagentChild;
    const supplementary = FIXTURE.conversationIds.supplementary;

    check('a conversation the summaries table never learned about still discovers',
      ids.has(supplementary), [...ids].join(','));
    check('the subagent child discovers too', ids.has(child));

    const childRow = rows.find((row) => row.id === child)!;
    check('a child row carries origin, its parent, and its OWN nativeId',
      childRow.origin === 'subagent'
        && childRow.parentThreadId === FIXTURE.conversationIds.withTranscript
        && childRow.nativeId === child,
      JSON.stringify({ origin: childRow.origin, parent: childRow.parentThreadId, native: childRow.nativeId }));
    check('an ordinary row is NOT marked as somebody\'s child',
      rows.filter((row) => row.origin === 'subagent').length === 1,
      rows.filter((row) => row.origin === 'subagent').map((row) => row.id).join(','));
    // A child belongs to the conversation that started it: never offered Drive, and Drive is refused.
    check('a child row is never offered Drive',
      childRow.control?.drive?.supported === false && childRow.control?.drive?.state === 'unavailable',
      JSON.stringify(childRow.control?.drive));
    check('the parent row is still offered Drive',
      rows.find((row) => row.id === FIXTURE.conversationIds.withTranscript)?.control?.drive?.supported === true);
    let childDrive = '';
    try {
      const refused = await adapter.attach(child, 'resume');
      await refused.close();
    } catch (error) {
      childDrive = String(error);
    }
    check('a Drive attach on a child is refused', /subagent conversation/.test(childDrive), childDrive);
    const childObserve = await adapter.attach(child, 'observe');
    check('an Observe attach on a child carries its lineage and offers no Drive',
      childObserve.info.origin === 'subagent'
        && childObserve.info.parentThreadId === FIXTURE.conversationIds.withTranscript
        && childObserve.info.control?.drive?.supported === false,
      JSON.stringify({ origin: childObserve.info.origin, drive: childObserve.info.control?.drive }));
    await childObserve.close();

    const suppRow = rows.find((row) => row.id === supplementary)!;
    check('a supplementary row takes its cwd from last_conversations, which DOES still update',
      suppRow.cwd === '/fixture/supp-project', String(suppRow.cwd));
    check('a supplementary row carries no currentMode — nothing on disk records one',
      suppRow.currentMode === undefined);

    // The defect this closes: P0 listed these rows and then refused every one of
    // them, because attach demanded a summaries row.
    for (const id of [child, supplementary]) {
      const connection = await adapter.attach(id, 'observe');
      const history = await connection.getHistory();
      check(`a row with no summaries entry OPENS and replays its own transcript (${id.slice(0, 8)})`,
        history.some((message) => message.type === 'user-message'),
        history.map((message) => message.type).join(','));
      await connection.close();
    }
  } finally {
    tree.cleanup();
  }
}

// ── 12b. The global limit binds the UNION, not the summaries table ─────────
//
// Round-2b review finding 1 (both rounds): handing the brain scan only what
// the summaries left over starved the supplement to a zero budget, and even
// with a merged union, excluding summary-known ids from the brain scan left a
// RESUMED conversation stuck with its frozen table timestamp. The two sources
// are merged BY ID, the newest evidence from either side decides recency, and
// the limit binds the merged set.
{
  const tree = buildAgyFixtureTree({ withSupplementaryConversation: true });
  try {
    const live = FIXTURE.conversationIds.withTranscript;
    const supplementary = FIXTURE.conversationIds.supplementary;
    // Deterministic recency: the summary-known transcript is backdated to its
    // own (frozen) summary timestamp, so the supplemental transcript — written
    // at build time, i.e. "now" — is strictly newest.
    const summaryTime = new Date('2026-08-20T10:15:46.027Z');
    utimesSync(tree.transcriptPath, summaryTime, summaryTime);

    const one = new AgyAdapter({ roots: tree.roots, env: { PATH: '' }, trace: () => {}, discoveryLimit: 1 });
    const kept = await one.discoverSessions();
    check('with the limit FULL of summary rows, the NEWER supplemental conversation still wins the slot',
      kept.length === 1 && kept[0]!.id === supplementary,
      kept.map((row) => row.id.slice(0, 8)).join(','));

    const two = new AgyAdapter({ roots: tree.roots, env: { PATH: '' }, trace: () => {}, discoveryLimit: 2 });
    const pair = await two.discoverSessions();
    check('the union is ordered by recency across BOTH sources',
      pair.length === 2 && pair[0]!.id === supplementary && pair[1]!.id === live,
      pair.map((row) => `${row.id.slice(0, 8)}@${row.updatedAt}`).join(','));
  } finally {
    tree.cleanup();
  }
}

// ── 12b′. A RESUMED summary-known conversation outranks the frozen table ───
//
// The second review's repro: the summary-known conversation was resumed AFTER
// the freeze (its transcript mtime is current) while the supplemental one is
// older. Recency must come from the newest evidence in EITHER source — the
// stale table timestamp must not decide — and the row must keep its summary
// enrichment rather than degrade to a supplementary shell.
{
  const tree = buildAgyFixtureTree({ withSupplementaryConversation: true });
  try {
    const live = FIXTURE.conversationIds.withTranscript;
    const supplementary = FIXTURE.conversationIds.supplementary;
    const older = new Date('2026-08-21T00:00:00Z');
    utimesSync(
      join(tree.roots.appData, 'brain', supplementary, '.system_generated', 'logs', 'transcript.jsonl'),
      older, older,
    );

    const adapter = new AgyAdapter({ roots: tree.roots, env: { PATH: '' }, trace: () => {}, discoveryLimit: 1 });
    const rows = await adapter.discoverSessions();
    check('a resumed summary-known conversation outranks an older supplemental one',
      rows.length === 1 && rows[0]!.id === live,
      rows.map((row) => `${row.id.slice(0, 8)}@${row.updatedAt}`).join(','));
    check('...its recency is the transcript mtime, not the frozen table timestamp',
      (rows[0]!.updatedAt ?? 0) > Date.parse('2026-08-21T00:00:00Z'),
      String(rows[0]!.updatedAt));
    check('...and the summary enrichment survives the merge',
      rows[0]!.cwd === '/fixture/demo-project', String(rows[0]!.cwd));
  } finally {
    tree.cleanup();
  }
}

// ── 12b″. Enrichment follows identity, not summary recency ─────────────────
//
// Round-2b third review, finding 1: with both source queries capped
// independently, a conversation that WINS through the brain scan can have its
// stale summary row fall below the summary query's limit — and the merge then
// never saw it, so the row degraded to a derived-prompt title with no cwd.
// The kept winners are re-enriched by an id-batch query after the limit.
{
  const tree = buildAgyFixtureTree();
  try {
    const live = FIXTURE.conversationIds.withTranscript;
    // Another summary is made NEWER than the winner's, so the one-row summary
    // query spends its slot on it; the winner's own (older) summary row is now
    // visible only to the id-batch enrichment. Kept below the brain mtime so it
    // cannot win the union outright.
    const db = new Database(join(tree.roots.appData, 'conversation_summaries.db'));
    db.run(
      "update conversation_summaries set last_modified_time = '2026-08-25 00:00:00.000000000+00:00' where conversation_id = ?",
      [IDS.withoutTranscript],
    );
    db.close();

    const adapter = new AgyAdapter({ roots: tree.roots, env: { PATH: '' }, trace: () => {}, discoveryLimit: 1 });
    const rows = await adapter.discoverSessions();
    check('the active conversation still wins the slot through its transcript mtime',
      rows.length === 1 && rows[0]!.id === live,
      rows.map((row) => `${row.id.slice(0, 8)}@${row.updatedAt}`).join(','));
    check('...with the summary-owned TITLE, not a prompt-derived one',
      rows[0]!.title === 'Demo Project Review', String(rows[0]!.title));
    check('...and the summary-owned cwd, recovered by the id-batch enrichment',
      rows[0]!.cwd === '/fixture/demo-project', String(rows[0]!.cwd));
    check('...while recency stays the newest evidence, the mtime',
      (rows[0]!.updatedAt ?? 0) > Date.parse('2026-08-25T00:00:00Z'), String(rows[0]!.updatedAt));
  } finally {
    tree.cleanup();
  }
}

// ── 12c. Lineage survives the parent falling outside the returned sweep ────
//
// Round-2b review finding 2: the lineage proof lives in the PARENT's inbox,
// so scanning only the returned rows silently unstamped a child whenever its
// parent lost the budget race. The scan covers the pre-limit candidate set.
{
  const tree = buildAgyFixtureTree({ withSubagentChild: true });
  try {
    const live = FIXTURE.conversationIds.withTranscript;
    const child = FIXTURE.conversationIds.subagentChild;
    // Deterministic recency: the parent transcript is backdated to its frozen
    // summary timestamp, so the child — written at build time — is newest.
    const summaryTime = new Date('2026-08-20T10:15:46.027Z');
    utimesSync(tree.transcriptPath, summaryTime, summaryTime);
    const adapter = new AgyAdapter({ roots: tree.roots, env: { PATH: '' }, trace: () => {}, discoveryLimit: 1 });

    const rows = await adapter.discoverSessions();
    check('a one-row limit keeps only the child — the parent is outside the returned sweep',
      rows.length === 1 && rows[0]!.id === child,
      rows.map((row) => row.id.slice(0, 8)).join(','));
    check('...and the child is STILL stamped with its lineage, from the pre-limit candidate set',
      rows[0]!.origin === 'subagent' && rows[0]!.parentThreadId === live && rows[0]!.nativeId === child,
      JSON.stringify({ origin: rows[0]!.origin, parent: rows[0]!.parentThreadId }));

    // A cutoff the parent still SURVIVES, cut only by the one-row limit.
    const cutoff = Date.parse('2026-08-20T00:00:00Z');
    const swept = await adapter.discoverSessions({ updatedAfter: cutoff });
    check('the stamp also survives a cutoff sweep whose limit cut the parent',
      swept.length === 1 && swept[0]!.id === child
        && swept[0]!.origin === 'subagent' && swept[0]!.parentThreadId === live,
      JSON.stringify(swept.map((row) => ({ id: row.id.slice(0, 8), origin: row.origin }))));

    // Round-2b second review, finding 2: a cutoff that excludes the parent from
    // EVERY candidate source — its summary timestamp and its transcript mtime
    // both predate it — while the child's current transcript survives. The
    // lineage universe is built without the cutoff, so the returned child keeps
    // its stamp: `updatedAfter` filters which sessions come back, never the
    // metadata belonging to one that did.
    const excludesParent = Date.parse('2026-08-22T00:00:00Z');
    const incremental = await adapter.discoverSessions({ updatedAfter: excludesParent });
    check('a child returned by a cutoff sweep that excludes its parent everywhere is STILL stamped',
      incremental.length === 1 && incremental[0]!.id === child
        && incremental[0]!.origin === 'subagent' && incremental[0]!.parentThreadId === live,
      JSON.stringify(incremental.map((row) => ({ id: row.id.slice(0, 8), origin: row.origin, parent: row.parentThreadId }))));

    // Round-2b third review, finding 2: the parent crowded out of BOTH capped
    // candidate lists at once — another summary takes the one summary slot, the
    // child takes the one brain slot. The lineage universe is the (bounded)
    // brain enumeration itself, independent of discoveryLimit, so the returned
    // child keeps its stamp anyway.
    const db = new Database(join(tree.roots.appData, 'conversation_summaries.db'));
    db.run(
      "update conversation_summaries set last_modified_time = '2026-08-25 00:00:00.000000000+00:00' where conversation_id = ?",
      [IDS.withoutTranscript],
    );
    db.close();
    const crowded = await adapter.discoverSessions();
    check('a child whose parent lost BOTH capped candidate slots is still stamped',
      crowded.length === 1 && crowded[0]!.id === child
        && crowded[0]!.origin === 'subagent' && crowded[0]!.parentThreadId === live,
      JSON.stringify(crowded.map((row) => ({ id: row.id.slice(0, 8), origin: row.origin, parent: row.parentThreadId }))));
  } finally {
    tree.cleanup();
  }
}

// ── 13. Task-log paths (P2c) ───────────────────────────────────────────────
{
  const tree = buildAgyFixtureTree({ withTaskLog: true });
  try {
    const live = FIXTURE.conversationIds.withTranscript;
    const path = agyTaskLogPath(tree.roots, live, 'task-7');
    check('a task log resolves under the conversation\'s own tasks dir',
      path === join(tree.roots.appData, 'brain', live, '.system_generated', 'tasks', 'task-7.log'), path);
    check('the task-id gate accepts only `task-<digits>`',
      AGY_TASK_ID_SEGMENT.test('task-7') && AGY_TASK_ID_SEGMENT.test('task-107')
        && !AGY_TASK_ID_SEGMENT.test('task-7/../../etc/passwd')
        && !AGY_TASK_ID_SEGMENT.test('../task-7')
        && !AGY_TASK_ID_SEGMENT.test('task-'));
    check('the log the fixture wrote is where the path says it is',
      readFileSync(path, 'utf8').includes('done'));
  } finally {
    tree.cleanup();
  }
}

// ── 14. exportTranscript (P2f) ─────────────────────────────────────────────
{
  const tree = buildAgyFixtureTree();
  const outDir = join(tree.dir, 'exports');
  mkdirSync(outDir, { recursive: true });
  try {
    const adapter = new AgyAdapter({ roots: tree.roots, env: { PATH: '' }, trace: () => {} });
    check('the static export format is declared for the confirm card',
      adapter.transcriptExportFormat === 'json');

    const exported = await adapter.exportTranscript(FIXTURE.conversationIds.withTranscript, {
      tempDir: outDir,
      maxBytes: 5_000_000,
      timeoutMs: 5_000,
    });
    check('the export lands in the BROKER-owned temp dir', exported.path.startsWith(outDir + '/'), exported.path);
    const document = JSON.parse(readFileSync(exported.path, 'utf8')) as {
      steps: unknown[];
      truncated: boolean;
      stepCount: number;
      source: string;
    };
    check('the export is the transcript\'s own lines, all of them',
      document.stepCount === FIXTURE.transcript.length && document.steps.length === document.stepCount,
      `${document.stepCount} of ${FIXTURE.transcript.length}`);
    check('the export names its source rather than implying a native one',
      document.source === 'transcript.jsonl');
    check('an untruncated export says so', document.truncated === false);

    // A byte ceiling the envelope alone exceeds: the document must still be
    // valid JSON and must SAY it was cut, rather than being written whole.
    const tiny = await adapter.exportTranscript(FIXTURE.conversationIds.withTranscript, {
      tempDir: outDir,
      maxBytes: 900,
      timeoutMs: 5_000,
    });
    const small = JSON.parse(readFileSync(tiny.path, 'utf8')) as { truncated: boolean; stepCount: number };
    check('an over-long export is trimmed from the END and states its truncation',
      small.truncated === true && small.stepCount < FIXTURE.transcript.length,
      `${small.stepCount} steps, truncated=${small.truncated}`);

    let refused = '';
    try {
      await adapter.exportTranscript('not-a-uuid', { tempDir: outDir, maxBytes: 1000, timeoutMs: 1000 });
    } catch (error) {
      refused = String(error);
    }
    check('an id that is not a conversation id is refused before any path is built',
      /not a conversation id/.test(refused), refused);
  } finally {
    tree.cleanup();
  }
}

// ── 15. createSession (P3): a pending create is a real row everywhere ──────
{
  const tree = buildAgyFixtureTree();
  try {
    const binDir = join(tree.dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'agy'), '#!/bin/sh\nexit 0\n');
    const adapter = new AgyAdapter({ roots: tree.roots, env: { PATH: binDir }, trace: () => {} });

    const catalog = await adapter.listModels();
    const pick = catalog[0]!;
    const created = await adapter.createSession({
      directory: tree.dir,
      title: 'fresh work',
      model: { providerID: pick.providerID, modelID: pick.modelID },
    });

    check('create mints a native-shaped conversation id',
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(created.id), created.id);
    check('the created row routes the client into a resume attach',
      created.attachMode === 'resume'
        && created.control?.drive.supported === true
        && created.control?.drive.state === 'observing',
      JSON.stringify({ attachMode: created.attachMode, control: created.control?.drive }));
    check('the requested model rides the row with the catalog label, so the first spawn launches it',
      created.currentModel?.modelID === pick.modelID && created.currentModel?.label === pick.label,
      JSON.stringify(created.currentModel));
    check('the chosen directory is the row cwd', created.cwd === tree.dir, String(created.cwd));

    // The roster must not lose the session between create and the first prompt.
    const sessions = await adapter.discoverSessions();
    const listed = sessions.find((session) => session.id === created.id);
    check('a pending create rides the roster before any store knows it',
      !!listed && listed.title === 'fresh work' && listed.control?.drive.supported === true,
      listed ? JSON.stringify({ title: listed.title }) : 'missing');

    // It opens through the ordinary attach path — observe first, like the app does.
    const observe = await adapter.attach(created.id, 'observe');
    check('a pending create attaches with an explicit control state',
      observe.info.control?.drive.state === 'observing', JSON.stringify(observe.info.control));
    await observe.close();
    const drive = await adapter.attach(created.id, 'resume');
    check('a resume attach on a pending create carries the requested model for the launch',
      drive.info.currentModel?.modelID === pick.modelID, JSON.stringify(drive.info.currentModel));
    await drive.close();

    // Once the CLI has written the brain directory, the disk row is the truth
    // and the pending record retires — no duplicate, no zombie.
    const logs = join(tree.roots.appData, 'brain', created.id, '.system_generated', 'logs');
    mkdirSync(logs, { recursive: true });
    writeFileSync(join(logs, 'transcript.jsonl'),
      `${JSON.stringify({ step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: '2026-08-27T10:00:00Z', content: '<USER_REQUEST>\nfresh work begins\n</USER_REQUEST>' })}\n`);
    const after = await adapter.discoverSessions();
    const rows = after.filter((session) => session.id === created.id);
    check('once the store knows the id there is exactly one row for it', rows.length === 1, `${rows.length}`);
    check('and that row is the DISK row, not the retired pending record',
      rows[0]!.title === 'fresh work begins', rows[0]!.title);

    // Refusals stay loud.
    let badDir = '';
    try {
      await adapter.createSession({ directory: join(tree.dir, 'no-such-dir') });
    } catch (error) {
      badDir = String(error);
    }
    check('a create into a missing directory refuses', /does not exist/.test(badDir), badDir);
    const noBinary = new AgyAdapter({ roots: tree.roots, env: { PATH: '' }, trace: () => {} });
    let noBin = '';
    let noBinError: unknown;
    try {
      await noBinary.createSession({ directory: tree.dir });
    } catch (error) {
      noBin = String(error);
      noBinError = error;
    }
    check('a create with no agy on PATH refuses rather than minting an unopenable session',
      /not on PATH/.test(noBin), noBin);
    // The broker answers this typed refusal with the retryable 503 every other agent gives.
    check('that refusal is the typed, retryable create-unavailable error',
      isSessionCreateTemporarilyUnavailableError(noBinError)
        && (noBinError as { detailCode?: string }).detailCode === 'agy-binary-missing',
      noBin);
  } finally {
    tree.cleanup();
  }
}

// ── 16. The live `agy models` catalog outranks the frozen cockpit file ─────
//
// MEASURED 2026-08-27 on 1.1.22: the cockpit cache froze on 2026-08-15 (same
// freeze as the summaries table) while the vocabulary rotated — the frozen file
// held `-tiered` placeholder rows and no entry for the label settings.json
// records, so every join failed and the roster, the composer seed, and the
// picker all went blank or raw. `agy models` prints the live list and does NOT
// refresh the file, so the CLI is the source and the file is the fallback.
{
  resetAgyCliCatalogForTests();
  const parsed = parseAgyCliModels(
    'Fetching available models...\n'
    + 'gemini-9.9-flash-high\tGemini 9.9 Flash (High)\n'
    + 'gemini-9.9-flash-low\tGemini 9.9 Flash (Low)\n'
    + 'not a catalog line\n'
    + '\tno id\n'
    + 'no-label\t\n');
  check('the CLI list parses id<TAB>displayName rows and nothing else',
    parsed.byId.size === 2
      && parsed.byId.get('gemini-9.9-flash-high')?.displayName === 'Gemini 9.9 Flash (High)'
      && parsed.byLabel.get('Gemini 9.9 Flash (Low)')?.length === 1,
    `${parsed.byId.size}`);

  const tree = buildAgyFixtureTree();
  try {
    const binDir = join(tree.dir, 'bin');
    mkdirSync(binDir, { recursive: true });
    const fakeAgy = join(binDir, 'agy');
    writeFileSync(fakeAgy,
      '#!/bin/sh\n'
      + 'if [ "$1" = "models" ]; then\n'
      + '  echo "Fetching available models..."\n'
      + '  printf \'gemini-9.9-flash-high\\tGemini 9.9 Flash (High)\\n\'\n'
      + '  printf \'gemini-9.9-flash-low\\tGemini 9.9 Flash (Low)\\n\'\n'
      + 'fi\n'
      + 'exit 0\n');
    chmodSync(fakeAgy, 0o755);

    // The rotation: settings names a label the frozen file has never heard of.
    writeFileSync(join(tree.roots.appData, 'settings.json'),
      JSON.stringify({ model: 'Gemini 9.9 Flash (High)' }));

    const fetched = await fetchAgyCliCatalog(fakeAgy, { trace: () => {} });
    check('one fetch returns the live rows', fetched?.byId.size === 2, String(fetched?.byId.size));

    resetAgyCliCatalogForTests();
    const adapter = new AgyAdapter({ roots: tree.roots, env: { PATH: binDir }, trace: () => {} });

    // The picker: awaited live list, so the rotated family appears with its
    // effort variants and the frozen file's rows do not.
    const options = await adapter.listModels();
    check('the picker offers the LIVE vocabulary, not the frozen file',
      options.some((option) => option.modelID === 'gemini-9.9-flash-high')
        && !options.some((option) => option.modelID === 'gemini-3.5-flash-low'),
      options.map((option) => option.modelID).join(','));

    // The roster: the settings label now joins, through the cached live list.
    const sessions = await adapter.discoverSessions();
    const row = sessions.find((session) => session.id === IDS.withTranscript);
    check('a roster row joins the settings label against the LIVE list',
      row?.currentModel?.modelID === 'gemini-9.9-flash-high'
        && row?.currentModel?.label === 'Gemini 9.9 Flash (High)',
      JSON.stringify(row?.currentModel));

    // The composer seed: attach awaits the same ensure and lands the same join.
    const connection = await adapter.attach(IDS.withTranscript, 'observe');
    check('an attach seeds the composer with the live-joined model',
      connection.info.currentModel?.modelID === 'gemini-9.9-flash-high',
      JSON.stringify(connection.info.currentModel));
    await connection.close();

    // Single-flight + TTL: the second read spawns nothing new (the fake would
    // still answer, but the cache must not need it).
    const held = cachedAgyCliCatalog(fakeAgy);
    const again = await ensureAgyCliCatalog(fakeAgy, { trace: () => {} });
    check('within the TTL, ensure answers from the cache object itself', again === held);

    // A FAILED fetch keeps the last good list: stale live beats frozen file.
    writeFileSync(fakeAgy, '#!/bin/sh\nexit 3\n');
    resetAgyCliCatalogForTests();
    const primed = await fetchAgyCliCatalog(fakeAgy, {});
    check('a failing binary yields no catalog, never a throw', primed === undefined);

    // No binary at all: the frozen file is still the fallback, and the rotated
    // label honestly refuses to join it.
    resetAgyCliCatalogForTests();
    const fileOnly = new AgyAdapter({ roots: tree.roots, env: { PATH: '' }, trace: () => {} });
    const fallbackRows = await fileOnly.discoverSessions();
    const fallbackRow = fallbackRows.find((session) => session.id === IDS.withTranscript);
    check('with no binary the frozen file is the fallback and the failed join stays an honest undefined',
      fallbackRow !== undefined && fallbackRow.currentModel === undefined,
      JSON.stringify(fallbackRow?.currentModel));
  } finally {
    resetAgyCliCatalogForTests();
    tree.cleanup();
  }
}

// ── 17. A mode the app drove with comes back from the broker's record ───────
//
// agy writes no per-conversation mode, so after a broker restart the only record of the mode a
// conversation was driven with is the broker's own. Rows and attaches carry it; a value agy's
// `--mode` would not accept, or a resolver that throws, publishes nothing.
{
  const tree = buildAgyFixtureTree();
  try {
    const stored = new Map<string, string>([[IDS.withTranscript, 'plan']]);
    const asked: Array<{ tool: string; id: string; nativeId?: string }> = [];
    const adapter = new AgyAdapter({
      roots: tree.roots,
      env: { PATH: '' },
      trace: () => {},
      resolveStoredCurrentMode: (info) => {
        asked.push(info);
        return stored.get(info.id);
      },
    });
    const rows = await adapter.discoverSessions();
    const row = rows.find((session) => session.id === IDS.withTranscript);
    check('a row carries the mode the broker recorded for it', row?.currentMode === 'plan', String(row?.currentMode));
    check('the resolver is asked by the agy id, native id and conversation id alike',
      asked.some((info) => info.tool === 'agy' && info.id === IDS.withTranscript && info.nativeId === IDS.withTranscript),
      JSON.stringify(asked[0]));
    check('a row with no record carries no mode',
      rows.filter((session) => session.id !== IDS.withTranscript).every((session) => session.currentMode === undefined));
    const connection = await adapter.attach(IDS.withTranscript, 'observe');
    check('an attach seeds the composer with the recorded mode',
      connection.info.currentMode === 'plan', String(connection.info.currentMode));
    await connection.close();

    stored.set(IDS.withTranscript, 'yolo');
    const invalid = (await adapter.discoverSessions()).find((session) => session.id === IDS.withTranscript);
    check('a recorded value agy does not accept is never published',
      invalid !== undefined && invalid.currentMode === undefined, String(invalid?.currentMode));

    const traces: Array<{ op: string }> = [];
    const throwing = new AgyAdapter({
      roots: tree.roots,
      env: { PATH: '' },
      trace: (event) => traces.push(event),
      resolveStoredCurrentMode: () => { throw new Error('metadata store unreadable'); },
    });
    const survived = (await throwing.discoverSessions()).find((session) => session.id === IDS.withTranscript);
    check('a resolver that throws costs the mode, never the row',
      survived !== undefined && survived.currentMode === undefined
        && traces.some((event) => event.op === 'stored-mode-unreadable'),
      String(survived?.currentMode));
  } finally {
    tree.cleanup();
  }
}

// ── 18. A model agy renamed is still named (AG-1); a repeated miss is one line (AG-2) ──
//
// MEASURED 2026-11-23 on 1.5.14: `settings.json` still says "Gemini 3.7 Flash (High)" (the
// fixture's own captured label), agy's live list knows only "Gemini 3.8 Flash (High)", and the
// only place agy records the rename is its run log. Before this, the join missed on every sweep,
// the row showed no model at all, and the miss was the broker log's most frequent line.
{
  resetAgyCliCatalogForTests();
  const tree = buildAgyFixtureTree();
  try {
    const binDir = join(tree.dir, 'bin');
    const probe = writeProbeAgy(binDir);
    writeFileSync(probe.serve, AGY_1_5_MODELS);
    const label = 'Gemini 3.7 Flash (High)';
    const renamed = 'Gemini 3.8 Flash (High)';
    check('the fixture\'s captured settings label is the one agy later renamed',
      readAgySettingsModelLabel(tree.roots) === label, String(readAgySettingsModelLabel(tree.roots)));

    const traces: AgyTrace[] = [];
    const adapter = new AgyAdapter({ roots: tree.roots, env: { PATH: binDir }, trace: (event) => traces.push(event) });
    await adapter.listModels();
    check('the picker\'s awaited fetch caches the live list',
      cachedAgyCliCatalog(probe.binary)?.byLabel.has(renamed) === true && probe.runs().length === 1,
      String(probe.runs().length));

    // No run log of agy's yet: nothing says what the saved label became.
    const first = (await adapter.discoverSessions()).find((session) => session.id === IDS.withTranscript);
    check('a label the live list does not know is shown as model text, with no model id invented for it',
      first !== undefined && 'currentModel' in first && first.currentModel === undefined && first.model === label,
      JSON.stringify({ currentModel: first?.currentModel, model: first?.model }));
    await adapter.discoverSessions();
    const textAttach = await adapter.attach(IDS.withTranscript, 'observe');
    check('an attach carries the same label text',
      textAttach.info.currentModel === undefined && textAttach.info.model === label,
      JSON.stringify({ currentModel: textAttach.info.currentModel, model: textAttach.info.model }));
    await textAttach.close();
    const misses = traces.filter((event) => event.op === 'model-join');
    check('AG-2: two sweeps and an attach missing the same way write ONE model-join line',
      misses.length === 1 && misses[0]?.detail === `label not in catalog: ${label}`,
      misses.map((event) => event.detail).join(' | '));

    // agy's run log records the rename: the real line, from a real run.
    writeAgyCliLog(tree.roots.appData, 'cli-20261029_165810.log', CLI_LOG.modelAlias);
    const joined = (await adapter.discoverSessions()).find((session) => session.id === IDS.withTranscript);
    check('AG-1: through the rename agy itself logged, the row names the model agy runs, by its catalog id',
      joined?.currentModel?.modelID === 'gemini-3.8-flash-high'
        && joined?.currentModel?.label === renamed
        && joined?.model === undefined,
      JSON.stringify({ currentModel: joined?.currentModel, model: joined?.model }));
    const aliasAttach = await adapter.attach(IDS.withTranscript, 'observe');
    check('an attach seeds the composer with the same aliased model',
      aliasAttach.info.currentModel?.modelID === 'gemini-3.8-flash-high', JSON.stringify(aliasAttach.info.currentModel));
    await aliasAttach.close();
    await adapter.discoverSessions();
    const aliasLines = traces.filter((event) => event.op === 'model-join' && event.detail.includes('agy\'s own alias'));
    check('the alias join is traced once, not per sweep',
      aliasLines.length === 1 && aliasLines[0]?.detail === `label ${label} resolved through agy's own alias to ${renamed}`,
      aliasLines.map((event) => event.detail).join(' | '));

    // A later run that never signed in resolves nothing and logs no alias line: no evidence,
    // not a retraction.
    writeAgyCliLog(tree.roots.appData, 'cli-20261123_115439.log', CLI_LOG.signInNotRestored);
    const sticky = (await adapter.discoverSessions()).find((session) => session.id === IDS.withTranscript);
    check('a newer log with no alias line keeps the rename agy recorded earlier',
      sticky?.currentModel?.modelID === 'gemini-3.8-flash-high', JSON.stringify(sticky?.currentModel));

    // An alias whose target the catalog does not list joins nothing, and says why.
    const aliases = parseAgyCliLogModelAliases(CLI_LOG.modelAlias.join('\n'));
    const unlistedTraces: AgyTrace[] = [];
    const unlisted = resolveAgyModel(parseAgyCliModels(''), label, (event) => unlistedTraces.push(event), aliases);
    check('agy\'s alias line parses to exactly its own mapping',
      aliases.size === 1 && aliases.get(label) === renamed, JSON.stringify([...aliases]));
    check('an alias whose target the catalog does not list joins nothing and names both labels',
      unlisted === undefined
        && unlistedTraces[0]?.detail === `label not in catalog: ${label} (agy aliases it to ${renamed}, which the catalog does not list)`,
      unlistedTraces.map((event) => event.detail).join(' | '));

    // `cli.log` is followed only to `log/cli-<stamp>.log`.
    const stray = join(tree.roots.appData, 'stray');
    mkdirSync(stray, { recursive: true });
    writeFileSync(join(stray, 'cli-20261029_165810.log'), `${CLI_LOG.modelAlias.join('\n')}\n`);
    rmSync(join(tree.roots.appData, 'cli.log'), { force: true });
    symlinkSync(join('stray', 'cli-20261029_165810.log'), join(tree.roots.appData, 'cli.log'));
    const strayTraces: AgyTrace[] = [];
    const fresh = new AgyAdapter({ roots: tree.roots, env: { PATH: binDir }, trace: (event) => strayTraces.push(event) });
    const refused = (await fresh.discoverSessions()).find((session) => session.id === IDS.withTranscript);
    check('a cli.log that points anywhere but log/cli-*.log is refused, and the row falls back to the label text',
      refused !== undefined && refused.currentModel === undefined && refused.model === label
        && strayTraces.some((event) => event.op === 'cli-log-refused'),
      JSON.stringify({ currentModel: refused?.currentModel, model: refused?.model }));
    check('the cached live list served every read above: one `agy models` child in all', probe.runs().length === 1,
      String(probe.runs().length));
  } finally {
    resetAgyCliCatalogForTests();
    tree.cleanup();
  }
}

// ── 19. A failing `agy models` backs off, and Create says why (AG-3, SP-1) ──
//
// MEASURED 2026-11-23 on 1.5.14: once agy's saved sign-in stopped refreshing, every
// `agy models` the broker ran (one per 15 minutes) waited on it and was killed at the 15 s limit,
// each leaving a run log behind: a model list frozen in the app, and a Create that offered a
// session whose first prompt could not work. Driven here on a controlled clock: the only real
// time spent is one short timeout at the end.
{
  resetAgyCliCatalogForTests();
  const tree = buildAgyFixtureTree();
  try {
    const binDir = join(tree.dir, 'bin');
    const probe = writeProbeAgy(binDir);
    let clock = Date.UTC(2026, 10, 23, 12);
    const traces: AgyTrace[] = [];
    const adapter = new AgyAdapter({
      roots: tree.roots,
      env: { PATH: binDir },
      trace: (event) => traces.push(event),
      now: () => clock,
    });
    // Joins whatever `agy models` run is in flight, and can never start one itself (a clock at 0
    // is inside every window), so a count read after it is settled.
    const settle = () => ensureAgyCliCatalog(probe.binary, { now: () => 0 });
    const refusalOf = (promise: Promise<void>) => promise.then(() => undefined, (error: unknown) => error);
    const detailCodeOf = (error: unknown) => (error as { detailCode?: string } | undefined)?.detailCode;

    const offered = adapter.canCreateSession();
    await settle();
    const first = agyCliCatalogFailure(probe.binary);
    check('before any list settles Create is offered, and the readiness read starts one fetch',
      offered === true && probe.runs().length === 1, String(probe.runs().length));
    check('a failed list is held with its kind, its count and the end of its window',
      first?.kind === 'exit' && first.failures === 1 && first.retryAt === clock + AGY_CLI_MODELS_TTL_MS,
      JSON.stringify(first));
    check('a failed list withdraws Create', adapter.canCreateSession() === false);
    const refusal = await refusalOf(adapter.prepareCreateSession());
    check('Create refuses with the typed, retryable reason and points at agy\'s sign-in',
      isSessionCreateTemporarilyUnavailableError(refusal)
        && detailCodeOf(refusal) === 'agy-model-list-unavailable'
        && String((refusal as Error).message).includes('signed in'),
      String(refusal));

    // Inside the window: sweeps, pickers, readiness reads and Create spawn nothing.
    for (let sweep = 0; sweep < 3; sweep += 1) await adapter.discoverSessions();
    const fallbackOptions = await adapter.listModels();
    adapter.canCreateSession();
    await refusalOf(adapter.prepareCreateSession());
    clock += AGY_CLI_MODELS_TTL_MS - 1;
    await adapter.discoverSessions();
    await adapter.listModels();
    adapter.canCreateSession();
    await refusalOf(adapter.prepareCreateSession());
    await settle();
    check('AG-3: inside the back-off window no read spawns another `agy models`',
      probe.runs().length === 1 && fallbackOptions.length > 0, `${probe.runs().length} runs`);

    // The window ends: Create runs the one retry, and agy's own log says the sign-in is the cause.
    clock += 1;
    writeAgyCliLog(tree.roots.appData, 'cli-20261123_115439.log', CLI_LOG.signInNotRestored);
    const second = await refusalOf(adapter.prepareCreateSession());
    const secondFailure = agyCliCatalogFailure(probe.binary);
    check('when the window ends Create runs exactly one retry, and with agy\'s log blaming the saved sign-in it says to sign in again',
      probe.runs().length === 2
        && secondFailure?.signIn?.state === 'not-restored'
        && isSessionCreateTemporarilyUnavailableError(second)
        && detailCodeOf(second) === 'agy-sign-in-not-restored'
        && String((second as Error).message).includes('sign in again'),
      `${probe.runs().length} runs; ${String(second)}`);
    check('the second failure in a row doubles the window',
      secondFailure?.failures === 2
        && secondFailure.retryAt === clock + 2 * AGY_CLI_MODELS_TTL_MS
        && agyCliModelsBackoffMs(2) === 2 * AGY_CLI_MODELS_TTL_MS,
      JSON.stringify(secondFailure));

    clock += 2 * AGY_CLI_MODELS_TTL_MS - 1;
    await adapter.discoverSessions();
    await adapter.listModels();
    adapter.canCreateSession();
    await settle();
    check('inside the doubled window nothing spawns', probe.runs().length === 2, String(probe.runs().length));

    // A picker opened when a retry is due starts it, and answers without waiting for it.
    clock += 1;
    const pickerOptions = await adapter.listModels();
    const failuresWhenPickerAnswered = agyCliCatalogFailure(probe.binary)?.failures;
    await settle();
    const thirdFailure = agyCliCatalogFailure(probe.binary);
    check('a picker opened after a failure answers at once and leaves its retry running in the background',
      pickerOptions.length > 0 && failuresWhenPickerAnswered === 2
        && probe.runs().length === 3 && thirdFailure?.failures === 3,
      `answered at ${String(failuresWhenPickerAnswered)} failures; ${probe.runs().length} runs`);
    check('the window keeps doubling, up to its two-hour ceiling',
      thirdFailure?.retryAt === clock + 4 * AGY_CLI_MODELS_TTL_MS
        && agyCliModelsBackoffMs(4) === AGY_CLI_MODELS_MAX_BACKOFF_MS
        && agyCliModelsBackoffMs(40) === AGY_CLI_MODELS_MAX_BACKOFF_MS,
      JSON.stringify(thirdFailure));
    check('each failure leaves one back-off trace, not one per read',
      traces.filter((event) => event.op === 'cli-models-backoff').length === 3,
      traces.filter((event) => event.op === 'cli-models-backoff').map((event) => event.detail).join(' | '));

    // agy works again, but nothing that could have fixed it changed: the window stands.
    writeFileSync(probe.serve, AGY_1_5_MODELS);
    adapter.canCreateSession();
    await adapter.discoverSessions();
    await settle();
    check('a recovered agy is not retried early when neither the binary nor the sign-in changed',
      probe.runs().length === 3, String(probe.runs().length));

    // A new sign-in record ends the window at the next read.
    writeFileSync(join(tree.roots.appData, AGY_SIGN_IN_RECORD_FILE), '');
    const stillWithdrawn = adapter.canCreateSession();
    await settle();
    const ready = await refusalOf(adapter.prepareCreateSession());
    check('a new sign-in ends the window early: one retry, the live list is back and Create is offered again',
      stillWithdrawn === false
        && probe.runs().length === 4
        && agyCliCatalogFailure(probe.binary) === undefined
        && cachedAgyCliCatalog(probe.binary)?.byId.has('gemini-3.8-flash-high') === true
        && adapter.canCreateSession() === true
        && ready === undefined,
      `${probe.runs().length} runs; ${String(ready)}`);

    // SP-1: every child above ran with agy's self-update off, whatever the broker's env says.
    check('SP-1: every `agy models` the adapter ran had agy\'s self-update disabled',
      probe.runs().length === 4 && probe.runs().every((value) => value === 'true'), probe.runs().join(','));
    const overridden = agyProbeEnv({ PATH: '/fixture/bin', AGY_CLI_DISABLE_AUTO_UPDATE: '0' });
    check('SP-1: the probe env keeps the broker\'s own and overrides an inherited opt-in to updates',
      overridden.AGY_CLI_DISABLE_AUTO_UPDATE === 'true' && overridden.PATH === '/fixture/bin');
    // AG-4 capture on 1.5.16: only `true` turned the updater off; `1` (what T1 set) did not.
    check('SP-1: the value is the one agy 1.5.16 honoured, not one it ignored',
      MODES_1_5_16.updaterByValue[AGY_NO_AUTO_UPDATE_ENV.AGY_CLI_DISABLE_AUTO_UPDATE!] === 'disabled'
        && MODES_1_5_16.updaterByValue['1'] === 'spawned'
        && MODES_1_5_16.log.updaterDisabled.endsWith('Auto-update disabled via environment variable AGY_CLI_DISABLE_AUTO_UPDATE'),
      AGY_NO_AUTO_UPDATE_ENV.AGY_CLI_DISABLE_AUTO_UPDATE);

    // The measured shape: a child that never answers is killed at the limit and backs off the same way.
    resetAgyCliCatalogForTests();
    writeFileSync(probe.slow, '');
    await ensureAgyCliCatalog(probe.binary, { timeoutMs: 200, now: () => clock, trace: () => {} });
    const timedOut = agyCliCatalogFailure(probe.binary);
    check('a list that does not answer in time is killed, held as a timeout, and backs off like any failure',
      timedOut?.kind === 'timeout' && timedOut.failures === 1 && timedOut.retryAt === clock + AGY_CLI_MODELS_TTL_MS
        && agyCreateUnavailable(timedOut).message.includes('did not answer in time'),
      JSON.stringify(timedOut));
  } finally {
    resetAgyCliCatalogForTests();
    tree.cleanup();
  }
}

// ── 20. Doctor reads agy's sign-in from agy's own newest run log (AG-3, SP-1) ──
//
// The doctor never runs agy for this: its shell is not the service's, so a run from it could
// succeed where the broker's fail. The fixture lines are verbatim from agy's logs.
{
  check('the captured runs classify as agy logged them',
    JSON.stringify(classifyAgyCliLogSignIn(CLI_LOG.signInNotRestored.join('\n'))) === JSON.stringify({ state: 'not-restored', networkError: false })
      && JSON.stringify(classifyAgyCliLogSignIn(CLI_LOG.signInNetworkError.join('\n'))) === JSON.stringify({ state: 'not-restored', networkError: true })
      && classifyAgyCliLogSignIn(CLI_LOG.signInRestored.join('\n'))?.state === 'restored'
      && classifyAgyCliLogSignIn(CLI_LOG.modelAlias.join('\n'))?.state === 'restored'
      && classifyAgyCliLogSignIn(CLI_LOG.signInRestored[0]!) === undefined);

  const home = '/fixture/home';
  const appData = defaultAgyRoots(home).appData;
  const logPath = join(appData, 'log', 'cli-20261123_115439.log');
  const doctor = async (world: {
    lines?: readonly string[];
    linkTo?: string;
    env?: Record<string, string | undefined>;
    binary?: boolean;
  }) => {
    let probeEnv: Readonly<Record<string, string | undefined>> | undefined;
    const linkTo = world.linkTo ?? logPath;
    const context: SetupDiagnosisContext = {
      effects: 'forbidden',
      platform: 'linux',
      arch: 'x64',
      env: world.env ?? {},
      homeDir: home,
      resolveExecutable: (command) => (command === 'agy' && world.binary !== false ? '/fixture/bin/agy' : undefined),
      inspectPath: (path): SetupPathInspection => {
        if (path === appData) return { status: 'directory', readable: true, displayPath: path };
        if (path === join(appData, 'cli.log') && world.lines) {
          return { status: 'other', readable: true, displayPath: path, link: { status: 'file', readable: true, resolvedPath: linkTo } };
        }
        return { status: 'missing', readable: false, displayPath: path };
      },
      readText: () => ({ ok: false, reason: 'missing' }),
      readTextPrefix: (path) => (world.lines && path === linkTo
        ? { ok: true, text: `${world.lines.join('\n')}\n` }
        : { ok: false, reason: 'missing' }),
      readPackageVersion: () => undefined,
      runReadOnly: async (_executable, _args, _timeoutMs, envOverrides): Promise<SetupCommandProbe> => {
        probeEnv = envOverrides;
        // Nothing invented: no `agy --version` output was captured, so the probe answers nothing.
        return { status: 'unavailable', stdout: '', stderr: '' };
      },
      fetchJson: async () => ({ status: 'unreachable' }),
      probeTcp: async () => 'closed',
      listDirectory: () => ({ ok: false, reason: 'missing' }),
      processAlive: () => false,
      displayPath: (path) => path,
    };
    const diagnosis = await diagnoseAgySetup(context);
    return { signIn: diagnosis.checks.find((entry) => entry.id === 'agy.sign-in'), probeEnv };
  };

  const expired = await doctor({ lines: CLI_LOG.signInNotRestored, env: { HTTPS_PROXY: 'http://proxy.invalid:3128' } });
  check('doctor warns that agy could not restore its sign-in and says to sign in again',
    expired.signIn?.status === 'warn'
      && expired.signIn.detailCode === 'sign-in-not-restored'
      && expired.signIn.remediation?.message.startsWith('Run `agy` in a terminal and sign in again.') === true
      && expired.signIn.evidence?.log === logPath,
    JSON.stringify(expired.signIn));
  check('with a proxy in the shell, doctor says the service does not inherit it',
    expired.signIn?.evidence?.shellProxy === true
      && expired.signIn.remediation?.message.includes('does not inherit proxy settings') === true,
    String(expired.signIn?.remediation?.message));
  check('SP-1: doctor\'s `agy --version` probe runs with agy\'s self-update disabled',
    expired.probeEnv?.AGY_CLI_DISABLE_AUTO_UPDATE === 'true', JSON.stringify(expired.probeEnv));

  const network = await doctor({ lines: CLI_LOG.signInNetworkError });
  check('without a proxy, a refresh agy reported as a network error says so',
    network.signIn?.status === 'warn'
      && network.signIn.evidence?.networkError === true
      && network.signIn.evidence?.shellProxy === false
      && network.signIn.remediation?.message.includes('network error') === true,
    JSON.stringify(network.signIn));

  const restored = await doctor({ lines: CLI_LOG.signInRestored });
  check('a run that refreshed the sign-in passes', restored.signIn?.status === 'pass'
    && restored.signIn.detailCode === 'sign-in-restored', JSON.stringify(restored.signIn));

  const noLog = await doctor({});
  check('no run log says nothing either way: skip', noLog.signIn?.status === 'skip'
    && noLog.signIn.detailCode === 'sign-in-unknown', JSON.stringify(noLog.signIn));

  const strayLink = await doctor({ lines: CLI_LOG.signInNotRestored, linkTo: join(appData, 'settings.json') });
  check('a cli.log that does not reach log/cli-*.log is not read', strayLink.signIn?.status === 'skip'
    && strayLink.signIn.detailCode === 'sign-in-unknown', JSON.stringify(strayLink.signIn));

  const noBinary = await doctor({ lines: CLI_LOG.signInNotRestored, binary: false });
  check('with no agy binary the sign-in is not checked', noBinary.signIn?.status === 'skip'
    && noBinary.signIn.detailCode === 'sign-in-not-checked', JSON.stringify(noBinary.signIn));
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
