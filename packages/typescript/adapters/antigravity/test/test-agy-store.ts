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
import { mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  cachedAgyCliCatalog,
  ensureAgyCliCatalog,
  fetchAgyCliCatalog,
  parseAgyCliModels,
  resetAgyCliCatalogForTests,
} from '../src/cli-catalog.ts';
import {
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
  type AgyTrace,
} from '../src/index.ts';
import { buildAgyFixtureTree, FIXTURE } from './fixtures/tree.ts';

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
    const withoutBinary = new AgyAdapter({ roots: tree.roots, env: { PATH: '' }, trace: () => {} });
    check('unavailable when no agy binary is on PATH', (await withoutBinary.isAvailable()) === false);

    // A fake binary on a fake PATH: availability must need BOTH halves.
    const binDir = join(tree.dir, 'bin');
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'agy'), '#!/bin/sh\nexit 0\n');
    const withBinary = new AgyAdapter({ roots: tree.roots, env: { PATH: binDir }, trace: () => {} });
    check('available when the binary and the app-data root both exist', (await withBinary.isAvailable()) === true);

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

// ── 10. The mode picker (P2b) ──────────────────────────────────────────────
//
// Three values, compiled into the binary's own flag help. The values that are
// NOT here matter as much as the ones that are: `full-access` occurs nowhere in
// the binary, and `request-review`/`always-proceed`/`strict` belong to the
// separate auto-approval axis that has no flag at all.
{
  check('listModes offers exactly the three `--mode` values the binary documents',
    JSON.stringify(AGY_MODES.map((mode) => mode.value)) === JSON.stringify(['default', 'accept-edits', 'plan']),
    AGY_MODES.map((mode) => mode.value).join(','));
  check('`full-access` is not among them — it is not a value agy has',
    !AGY_MODES.some((mode) => mode.value === 'full-access'));
  check('the auto-approval vocabulary is NOT offered as a --mode',
    !AGY_MODES.some((mode) => ['request-review', 'always-proceed', 'strict'].includes(mode.value)));
  check('plan is filed as custom, not as a permission posture',
    AGY_MODES.find((mode) => mode.value === 'plan')?.category === 'custom');
  check('every mode carries the host\'s own one-clause description',
    AGY_MODES.every((mode) => (mode.description ?? '').length > 0));
  check('isAgyMode accepts the three and refuses everything else',
    isAgyMode('plan') && isAgyMode('default') && isAgyMode('accept-edits')
      && !isAgyMode('request-review') && !isAgyMode('full-access') && !isAgyMode(undefined));
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
    try {
      await noBinary.createSession({ directory: tree.dir });
    } catch (error) {
      noBin = String(error);
    }
    check('a create with no agy on PATH refuses rather than minting an unopenable session',
      /not on PATH/.test(noBin), noBin);
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
    const { chmodSync } = await import('node:fs');
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

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
