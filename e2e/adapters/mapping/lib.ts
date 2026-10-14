/**
 * The mapping corpus kit: every agent's native transcript data in, canonical messages out, compared to an
 * explicit golden file. One directory per case under `corpus/<agent>/<case>/`:
 *
 *   case.json     provenance (required), description, and the explicit invariants for the case
 *   history.*     native input read at attach (file-based agents: `history.jsonl`, written verbatim except that
 *                 a `<<binary-line>>` line becomes raw control bytes)
 *   tail.*        native input appended while the connection is attached (optional)
 *   golden.json   `{ history, live, replay }` projections, regenerated ONLY with COSYNCING_UPDATE_GOLDENS=1
 *
 * Goldens are plain JSON a reviewer reads in a diff, never bun snapshots, and are never written when `CI` is set.
 * The invariants (B2 3.B) are checked independently of the golden, from what `case.json` declares.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test } from 'bun:test';

export const CORPUS_ROOT = join(import.meta.dir, 'corpus');

const PROVENANCE = /^(captured [a-z0-9-]+ \S+ \d{4}-\d{2}-\d{2}( .*)?|synthetic, derived from \S.*)$/;

export interface CaseMeta {
  /** `captured <agent> <version> <date>` or `synthetic, derived from <file>`. */
  provenance: string;
  description: string;
  /** Distinct user-bubble texts in first-appearance order: the only real user rows (sentinel excluded). */
  userTexts?: string[];
  /** Texts that must replay as exactly one row each (a streamed answer is one row, not one per chunk). */
  oneRow?: string[];
  /**
   * A product bug this case reproduces. The case runs as `test.failing` (its invariants only, no golden), so it
   * stays red-in-spirit until the product is fixed; then delete this field and generate the golden.
   */
  knownBug?: string;
  /** Regex the recorded failure message must match. */
  knownBugMatch?: string;
  /** The tail deletes content (a removed message), so history identities may be absent from the resync. */
  identitiesMayVanish?: boolean;
  /** Types whose key is rewritten in place by design (state frames); default run-summary/status/metadata-update. */
  upsertTypes?: string[];
  /** Extra per-adapter inputs: file names inside the case directory. */
  [extra: string]: unknown;
}

export interface CaseDir {
  name: string;
  dir: string;
  meta: CaseMeta;
}

export function loadCases(agent: string): CaseDir[] {
  const base = join(CORPUS_ROOT, agent);
  const out: CaseDir[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDirectory()) continue;
    const dir = join(base, entry.name);
    const meta = JSON.parse(readFileSync(join(dir, 'case.json'), 'utf8')) as CaseMeta;
    if (typeof meta.provenance !== 'string' || !PROVENANCE.test(meta.provenance)) {
      throw new Error(`${agent}/${entry.name}: case.json provenance must be 'captured <agent> <version> <date>' or 'synthetic, derived from <file>', got ${JSON.stringify(meta.provenance)}`);
    }
    out.push({ name: entry.name, dir, meta });
  }
  if (out.length === 0) throw new Error(`no cases under ${base}`);
  return out;
}

/** A line that stands for raw control bytes, so the committed corpus stays plain text for the public-tree scan. */
const BINARY_LINE = '<<binary-line>>';

export function readIfExists(dir: string, file: string | undefined): string | undefined {
  if (!file) return undefined;
  const path = join(dir, file);
  if (!existsSync(path)) return undefined;
  return readFileSync(path, 'utf8').replaceAll(BINARY_LINE, '\u0000\u0001\u0002 binary \u007f');
}

// ── projection ────────────────────────────────────────────────────────────────────────────────

const VOLATILE = new Set(['timestamp', 'ts']);
const STRING_CAP = 1000;

function clip(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.length > STRING_CAP ? `${value.slice(0, STRING_CAP)}…[${value.length} chars]` : value;
  if (Array.isArray(value)) return depth > 8 ? '[deep]' : value.map((v) => clip(v, depth + 1));
  if (value && typeof value === 'object') {
    if (depth > 8) return '[deep]';
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE.has(k) || v === undefined) continue;
      out[k] = clip(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** A message as the golden records it: type, key, role, and every canonical field, strings clipped. */
export function project(message: unknown): Record<string, unknown> {
  const clipped = clip(message) as Record<string, unknown>;
  return clipped;
}

export const projectAll = (messages: readonly unknown[]): Record<string, unknown>[] => messages.map(project);

// ── golden files ──────────────────────────────────────────────────────────────────────────────

/** One message per line keeps a golden diff readable. */
function renderGolden(golden: Record<string, unknown[]>): string {
  const sections = Object.entries(golden).map(([name, rows]) => {
    const body = rows.map((row) => `    ${JSON.stringify(row)}`).join(',\n');
    return `  ${JSON.stringify(name)}: [${rows.length ? `\n${body}\n  ` : ''}]`;
  });
  return `{\n${sections.join(',\n')}\n}\n`;
}

export function expectGolden(dir: string, actual: Record<string, unknown[]>): void {
  const path = join(dir, 'golden.json');
  const rendered = renderGolden(actual);
  if (process.env.COSYNCING_UPDATE_GOLDENS === '1') {
    if (process.env.CI) throw new Error('refusing to rewrite goldens when CI is set');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, rendered);
    return;
  }
  if (!existsSync(path)) throw new Error(`missing ${path}; generate it with COSYNCING_UPDATE_GOLDENS=1 and review the diff`);
  expect(JSON.parse(rendered)).toEqual(JSON.parse(readFileSync(path, 'utf8')));
}

// ── invariants ────────────────────────────────────────────────────────────────────────────────

type Msg = Record<string, any>;
const DEFAULT_UPSERT = ['run-summary', 'status', 'metadata-update', 'task-list-state', 'agent-activity', 'goal-state'];
/** Content rows a client reduces by identity; a resync must reproduce each of them under the same key. */
const CONTENT = new Set(['user-message', 'model-output', 'thinking', 'tool-call', 'tool-result']);

export function identityOf(m: Msg): string | undefined {
  if (typeof m.key === 'string') return `${m.type}#${m.key}`;
  if ((m.type === 'tool-call' || m.type === 'tool-result') && typeof m.callId === 'string' && m.callId !== '') return `${m.type}@${m.callId}`;
  return undefined;
}

export interface Streams {
  history: Msg[];
  live: Msg[];
  replay: Msg[];
}

/**
 * The B2 invariants. `canonicalTypes` is the adapter-api list. Returns nothing; throws via `expect` with a
 * message naming the invariant, so a failing case says which rule broke.
 */
export function assertInvariants(meta: CaseMeta, streams: Streams, canonicalTypes: readonly string[]): void {
  const upsert = new Set(meta.upsertTypes ?? DEFAULT_UPSERT);
  const all = [...streams.history, ...streams.live, ...streams.replay];

  // fail open: unknown input costs a neutral row or nothing, never a non-canonical type
  const bad = all.map((m) => m.type).filter((t) => !canonicalTypes.includes(t));
  expect(bad, 'every emitted type is canonical').toEqual([]);

  // only real user rows become user bubbles
  if (meta.userTexts) {
    const seen: string[] = [];
    for (const m of streams.replay) {
      if (m.type !== 'user-message') continue;
      const text = String(m.text ?? '');
      if (!seen.includes(text)) seen.push(text);
    }
    expect(seen, 'user bubbles are exactly the real prompts').toEqual(meta.userTexts);
  }

  // keys are unique within one read (state frames and queued bubbles are upserts by design)
  for (const [label, list] of [['history', streams.history], ['replay', streams.replay]] as const) {
    const seen = new Map<string, Msg>();
    for (const m of list) {
      if (upsert.has(m.type)) continue;
      const id = identityOf(m);
      if (!id) continue;
      const prev = seen.get(id);
      const queuedUpsert = prev && m.type === 'user-message' && prev.queued === true && !m.queued;
      if (prev && !queuedUpsert) throw new Error(`${label}: identity ${id} used twice: ${JSON.stringify(prev).slice(0, 200)} / ${JSON.stringify(m).slice(0, 200)}`);
      seen.set(id, m);
    }
  }
  // history and live partition the stream: no content identity is delivered twice (queued upsert aside)
  const histIds = new Set(streams.history.filter((m) => !upsert.has(m.type)).map(identityOf).filter(Boolean));
  for (const m of streams.live) {
    if (upsert.has(m.type) || m.queued === false || m.delta !== undefined) continue;
    const id = identityOf(m);
    if (id && histIds.has(id) && !(m.type === 'user-message')) throw new Error(`live re-delivered a history identity ${id}`);
  }

  // stable across resync: whatever history or the tail delivered is in the replay under the same identity
  const replayIds = new Set(streams.replay.map(identityOf).filter(Boolean));
  for (const m of [...streams.history, ...streams.live]) {
    if (!CONTENT.has(m.type) || m.delta !== undefined || meta.identitiesMayVanish) continue;
    const id = identityOf(m);
    if (id) expect(replayIds.has(id), `resync keeps identity ${id}`).toBe(true);
  }
  // a streamed answer: its snapshot plus its deltas add up to the one row the resync returns
  const streamed = new Map<string, string>();
  for (const m of streams.live) {
    if (typeof m.key !== 'string' || !(m.type === 'model-output' || m.type === 'thinking')) continue;
    if (m.delta !== undefined) streamed.set(m.key, (streamed.get(m.key) ?? '') + String(m.delta));
    else if (streamed.has(m.key) || m.text !== undefined) streamed.set(m.key, String(m.text ?? ''));
  }
  for (const [key, text] of streamed) {
    const row = streams.replay.find((m) => m.key === key && (m.type === 'model-output' || m.type === 'thinking'));
    if (row) expect(row.text, `the streamed text of ${key} equals its resync row`).toBe(text);
  }

  // ...and says the same thing there: the tail's last word on an identity equals the replay's
  const lastBy = (list: Msg[]) => {
    const map = new Map<string, Msg>();
    for (const m of list) {
      const id = CONTENT.has(m.type) && m.type !== 'tool-call' && m.delta === undefined ? identityOf(m) : undefined;
      if (id) map.set(id, m);
    }
    return map;
  };
  const replayLast = lastBy(streams.replay);
  for (const [id, m] of lastBy([...streams.history, ...streams.live])) {
    if (meta.identitiesMayVanish && !replayLast.has(id)) continue;
    expect(project(m), `tail/history and resync agree on ${id}`).toEqual(project(replayLast.get(id)));
  }

  // a streamed answer replays as one row
  for (const text of meta.oneRow ?? []) {
    const rows = streams.replay.filter((m) => m.text === text);
    expect(rows.length, `one row for ${JSON.stringify(text)}`).toBe(1);
  }

  // run-summary anchored to its turn
  const userKeys = new Set(streams.replay.filter((m) => m.type === 'user-message').map((m) => m.key));
  const answerKeys = new Set(streams.replay.filter((m) => m.type === 'model-output' || m.type === 'thinking').map((m) => m.key));
  for (const m of streams.replay) {
    if (m.type !== 'run-summary') continue;
    if (m.userMessageKey !== undefined) expect(userKeys.has(m.userMessageKey), `run-summary ${m.key} anchors to a user row`).toBe(true);
    if (m.assistantMessageKey !== undefined) expect(answerKeys.has(m.assistantMessageKey), `run-summary ${m.key} anchors to a rendered answer or thinking row`).toBe(true);
  }
}

// ── the file-backed runner (claude, codex, pi, omp) ───────────────────────────────────────────

import { appendFileSync } from 'node:fs';
import { CANONICAL_MESSAGE_TYPES } from '../../../packages/typescript/adapter-api/src/index.ts';
import { eventually } from '../../harness/index.ts';

interface Conn {
  getHistory(): Promise<Msg[]>;
  subscribe(handler: (m: Msg) => void): () => void;
  close(): Promise<void>;
}

export interface FileCaseOptions {
  cs: CaseDir;
  /** Path the transcript is written to (the adapter must be able to discover it there). */
  file: string;
  attach(file: string): Promise<Conn>;
  /** A line the adapter maps to exactly one recognizable message and nothing else (the tail's end marker). */
  sentinel: { line: string; is(m: Msg): boolean };
}

/** Attach observe, read history, append the tail, wait for the sentinel, then resync from the same connection. */
export async function runFileCase(o: FileCaseOptions): Promise<Streams & { dropSentinel(l: Msg[]): Msg[] }> {
  const history = readIfExists(o.cs.dir, 'history.jsonl') ?? '';
  const tail = readIfExists(o.cs.dir, 'tail.jsonl');
  writeFileSync(o.file, history);
  const conn = await o.attach(o.file);
  try {
    const historyRows = await conn.getHistory();
    const live: Msg[] = [];
    conn.subscribe((m) => live.push(m));
    const prefix = history.length > 0 && !history.endsWith('\n') ? '\n' : '';
    appendFileSync(o.file, `${prefix}${tail ?? ''}${tail && !tail.endsWith('\n') ? '\n' : ''}${o.sentinel.line}\n`);
    // A history-reset tells the client to re-read (the hub does); after one the sentinel may only be in the re-read.
    await eventually(async () => live.some(o.sentinel.is) || (live.some((m) => m.type === 'history-reset') && (await conn.getHistory()).some(o.sentinel.is)),
      { what: `the tail sentinel of ${o.cs.name}` });
    const replay = await conn.getHistory();
    const dropSentinel = (list: Msg[]) => list.filter((m) => !o.sentinel.is(m));
    return { history: historyRows, live, replay, dropSentinel };
  } finally {
    await conn.close();
  }
}

/** Run the invariants and the golden for one finished stream triple. */
export function checkCase(cs: CaseDir, s: Streams & { dropSentinel?(l: Msg[]): Msg[] }): void {
  const strip = s.dropSentinel ?? ((l: Msg[]) => l);
  const streams = { history: strip(s.history), live: strip(s.live), replay: strip(s.replay) };
  assertInvariants(cs.meta, streams, CANONICAL_MESSAGE_TYPES as readonly string[]);
  if (cs.meta.knownBug) return; // the golden would pin the wrong output; the invariants carry the correct behaviour
  expectGolden(cs.dir, { history: projectAll(streams.history), live: projectAll(streams.live), replay: projectAll(streams.replay) });
}

/**
 * Register one case. A case with `knownBug` runs twice: as `test.failing` (the correct behaviour, red today, flips
 * the moment the bug is fixed) and as a plain test that insists the failure is the recorded one, so a harness fault
 * or a different regression cannot hide behind `failing`.
 */
export function defineCase<S extends Streams & { dropSentinel?(l: Msg[]): Msg[] }>(cs: CaseDir, run: () => Promise<S>): void {
  if (!cs.meta.knownBug) {
    test(cs.name, async () => checkCase(cs, await run()));
    return;
  }
  test.failing(`${cs.name} (known bug)`, async () => checkCase(cs, await run()));
  test(`${cs.name} (known bug reproduces as recorded)`, async () => {
    let failure = '';
    try {
      checkCase(cs, await run());
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    expect(failure, 'the invariant that records this bug').toMatch(new RegExp(String(cs.meta.knownBugMatch)));
  });
}

// ── committed captures, referenced rather than copied ─────────────────────────────────────────

/** `a.b[3:9]` into a parsed JSON document: key path, then an optional slice. */
function pick(doc: unknown, path: string): unknown {
  const match = /^([^[]*)(?:\[(\d*):(\d*)\])?$/.exec(path);
  if (!match) throw new Error(`bad corpus path ${path}`);
  let value: any = doc;
  for (const key of match[1]!.split('.').filter(Boolean)) value = value?.[key];
  if (match[2] !== undefined) value = (value as unknown[]).slice(match[2] === '' ? 0 : Number(match[2]), match[3] === '' ? undefined : Number(match[3]));
  return value;
}

/** The lines of one side of a case: its `refs` into committed captures first, then its own `<side>.jsonl` lines. */
export function caseLines(cs: CaseDir, side: 'history' | 'tail'): string[] {
  const refs = (cs.meta.refs as Record<string, { fixture: string; path: string }[]> | undefined)?.[side] ?? [];
  const lines: string[] = [];
  for (const ref of refs) {
    const value = pick(JSON.parse(readFileSync(join(REPO, ref.fixture), 'utf8')), ref.path);
    for (const item of Array.isArray(value) ? value : [value]) lines.push(JSON.stringify(item));
  }
  const own = readIfExists(cs.dir, `${side}.jsonl`);
  if (own) lines.push(...own.split('\n'));
  return lines;
}
const REPO = join(import.meta.dir, '..', '..', '..');
