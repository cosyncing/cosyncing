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
import { mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  AGY_SETTLEMENT_MAX_FILES,
  AGY_SMALL_JSON_MAX_BYTES,
  AgyAdapter,
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
    check('updatedAt comes from last_modified_time',
      row.updatedAt === Date.parse('2026-08-20T10:15:46.027Z'), String(row.updatedAt));
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
    check('attaching an id with no summaries row refuses cleanly', unknownRefused);
  } finally {
    tree.cleanup();
  }
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
