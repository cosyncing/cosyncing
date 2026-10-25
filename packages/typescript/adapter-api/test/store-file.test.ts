/**
 * Reading a native store file only when it is a regular file, and never
 * blocking on one that is not (`src/store-file.ts`).
 *
 * The conformance suite (C21, `e2e/adapters/conformance`) plants FIFOs under
 * session names in every file-store kit and proves the broker keeps answering.
 * These are the helper's own edges: the bytes a regular file reads back, each
 * kind of non-regular entry, a symlink with and without `noFollow`, and the
 * descriptor re-check that closes the stat/open race. FIFO cases are POSIX only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  containedStorePath,
  isNotRegularFileError,
  isRegularFileSync,
  NO_FOLLOW_FLAG,
  NotRegularFileError,
  openRegularFile,
  openRegularFileSync,
  readRegularFileSync,
  STORE_READ_FLAGS,
} from '../src/index.ts';
import { SessionTitleCache } from '../src/session-title.ts';
import { TitleRecordProjection } from '../src/title-record-projection.ts';

const posix = process.platform !== 'win32';
const base = realpathSync(mkdtempSync(join(tmpdir(), 'store-file-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const file = join(base, 'session.jsonl');
const bytes = Buffer.from('{"type":"user","text":"héllo"}\n{"type":"assistant"}\n', 'utf8');
writeFileSync(file, bytes);
const directory = join(base, 'directory.jsonl');
mkdirSync(directory);
const missing = join(base, 'missing.jsonl');

// Exact appends/replacements between a yielded chunk and its validation cannot
// be staged through HTTP. These store faults complement large-file conformance.
describe('metadata while the native store keeps changing', () => {
  // A real writer cannot portably be paused inside an escape or UTF-8 scalar.
  // These recorded-data faults exercise that boundary beside the Pi/OMP flows.
  test('large prompt records preserve text after binary data and validate the original string end', () => {
    const text = '项目 😀 "quoted" \\ path';
    const raw = Buffer.from(JSON.stringify({ type: 'prompt', image: { data: 'A'.repeat(2 * 1024 * 1024) }, text }));
    const split = raw.indexOf(Buffer.from('😀')) + 1;
    const record = new TitleRecordProjection();
    record.append(raw.subarray(0, split));
    expect(record.finish().kind).toBe('malformed');
    const completed = record.clone();
    completed.append(raw.subarray(split));
    const projected = completed.finish();
    expect(projected.kind).toBe('record');
    if (projected.kind === 'record') expect(projected.value.text).toBe(text);
    expect(record.finish().kind).toBe('malformed');
    const escaped = new TitleRecordProjection();
    escaped.append('{"type":"prompt","data":"' + 'A'.repeat(2 * 1024 * 1024) + '\\');
    escaped.append('uD83D\\uDE00","text":"\\u9879\\u76ee"}');
    expect(escaped.finish()).toMatchObject({ kind: 'record', value: { text: '项目' } });
    const malformed = new TitleRecordProjection();
    malformed.append('{"type":"prompt","data":"' + 'A'.repeat(2 * 1024 * 1024) + '\\q","text":"not valid"}');
    expect(malformed.finish().kind).toBe('malformed');
    const invalidUtf8 = new TitleRecordProjection();
    invalidUtf8.append(Buffer.concat([
      Buffer.from('{"data":"' + 'A'.repeat(2 * 1024 * 1024)), Buffer.from([0xc3, 0x28]), Buffer.from('"}'),
    ]));
    expect(invalidUtf8.finish().kind).toBe('malformed');
  });

  test('an unfinished large first record resumes after cold EOF; an opaque row cannot certify a later prompt', async () => {
    const path = join(base, 'large-first-record.jsonl');
    const prefix = '{"type":"prompt","data":"' + 'A'.repeat(2 * 1024 * 1024);
    writeFileSync(path, prefix);
    const cache = new SessionTitleCache<{ prompt?: string; at?: number }>(() => ({}), (row, facts, offset) => {
      if (row.type === 'prompt' && offset < (facts.at ?? Infinity)) { facts.prompt = row.text; facts.at = offset; }
    }, undefined, { tail: true, now: () => 0 });
    expect((await cache.readResult(path)).complete).toBe(false);
    appendFileSync(path, '","text":"first with image"}\n{"type":"prompt","text":"later"}\n');
    const finished = await cache.readResult(path);
    expect(finished.complete).toBe(true);
    expect(finished.facts.prompt).toBe('first with image');
    writeFileSync(`${path}.new`, JSON.stringify({ type: 'prompt', text: ' '.repeat(2 * 1024 * 1024) + 'hidden first text' }) + '\n'
      + '{"type":"prompt","text":"later must remain unproved"}\n');
    renameSync(`${path}.new`, path);
    const opaque = await cache.readResult(path);
    expect(opaque.complete).toBe(false);
    expect(opaque.facts.prompt).toBeUndefined();
  });

  test('a cold backlog finishes despite appends during every chunk, with native precedence and clears intact', async () => {
    const path = join(base, 'growing-titles.jsonl');
    const line = (row: object) => `${JSON.stringify(row)}\n`;
    writeFileSync(path, line({ type: 'prompt', text: 'first prompt' }));
    const padding = line({ type: 'output', text: 'x'.repeat(256 * 1024) });
    for (let index = 0; index < 192; index++) {
      appendFileSync(path, padding);
      if (index === 120) appendFileSync(path, line({ type: 'native', name: 'OMP title in the middle' }));
    }
    appendFileSync(path, line({ type: 'legacy', name: 'Pi name near the end' }));
    type Facts = { prompt?: string; own?: string; ownAt?: number; legacy?: string; legacyAt?: number };
    const cache = new SessionTitleCache<Facts>(() => ({}), (row, facts, offset) => {
      if (row.type === 'prompt' && !facts.prompt) facts.prompt = row.text;
      if (row.type === 'native' && offset >= (facts.ownAt ?? -1)) { facts.own = row.name; facts.ownAt = offset; }
      if (row.type === 'legacy' && offset >= (facts.legacyAt ?? -1)) { facts.legacy = row.name; facts.legacyAt = offset; }
    }, undefined, { tail: true, now: () => 0,
      afterChunk: () => appendFileSync(path, line({ type: 'output', text: 'new activity' })),
    });
    const first = await cache.readResult(path);
    expect(first.complete).toBe(false);
    let result = first;
    for (let read = 0; read < 4 && !result.complete; read++) result = await cache.readResult(path);
    expect(result.complete).toBe(true);
    expect(result.facts.own).toBe('OMP title in the middle');
    appendFileSync(path, line({ type: 'native', name: '' }));
    const cleared = await cache.readResult(path);
    expect(cleared.complete).toBe(true);
    expect((cleared.facts.own ?? cleared.facts.legacy) || cleared.facts.prompt).toBe('first prompt');
  });

  test('append validation retains a first prompt; replacement never reuses a final title', async () => {
    const path = join(base, 'racing-titles.jsonl');
    writeFileSync(path, '{"text":"first"}\n');
    const prompt = new SessionTitleCache<{ text?: string }>(() => ({}), (row, facts) => { facts.text ??= row.text; }, undefined,
      { stopWhen: (facts) => !!facts.text, afterChunk: () => appendFileSync(path, '{"text":"later"}\n') });
    expect(await prompt.read(path)).toEqual({ text: 'first' });
    let replace = false;
    const cache = new SessionTitleCache<{ text?: string }>(() => ({}), (row, facts) => { if (row.text) facts.text = row.text; }, undefined,
      { afterChunk: () => {
        if (!replace) return;
        replace = false;
        writeFileSync(`${path}.new`, '{"text":"replacement"}\n');
        renameSync(`${path}.new`, path);
      } });
    expect((await cache.readResult(path)).complete).toBe(true);
    appendFileSync(path, '{"text":"old generation"}\n');
    replace = true;
    expect((await cache.readResult(path)).complete).toBe(false);
    expect(await cache.read(path)).toEqual({ text: 'replacement' });
  });
});

function fifo(name: string): string {
  const path = join(base, name);
  const made = Bun.spawnSync(['mkfifo', path], { stdout: 'pipe', stderr: 'pipe' });
  if (made.exitCode !== 0) throw new Error(`mkfifo failed: ${made.stderr.toString()}`);
  return path;
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected a throw');
}

describe('a regular file', () => {
  test('reads back exactly the bytes readFileSync does', () => {
    expect(readRegularFileSync(file).equals(readFileSync(file))).toBe(true);
    expect(readRegularFileSync(file, 'utf8')).toBe(readFileSync(file, 'utf8'));
    const fd = openRegularFileSync(file);
    try {
      expect(fstatSync(fd).size).toBe(bytes.length);
      expect(readFileSync(fd).equals(bytes)).toBe(true);
    } finally {
      closeSync(fd);
    }
    expect(isRegularFileSync(file)).toBe(true);
  });

  test('the asynchronous open hands back a readable handle', async () => {
    const handle = await openRegularFile(file);
    try {
      expect((await handle.readFile()).equals(bytes)).toBe(true);
    } finally {
      await handle.close();
    }
  });

  test('a missing file throws ENOENT, as openSync does', async () => {
    expect((thrown(() => openRegularFileSync(missing)) as NodeJS.ErrnoException).code).toBe('ENOENT');
    expect(await openRegularFile(missing).then(() => 'opened', (error) => error.code)).toBe('ENOENT');
    expect(isRegularFileSync(missing)).toBe(false);
  });
});

describe('a directory under a session name', () => {
  test('is refused without a read, synchronously and asynchronously', async () => {
    const error = thrown(() => openRegularFileSync(directory));
    expect(error).toBeInstanceOf(NotRegularFileError);
    expect(isNotRegularFileError(error)).toBe(true);
    expect(isNotRegularFileError(thrown(() => readRegularFileSync(directory, 'utf8')))).toBe(true);
    expect(await openRegularFile(directory).then(() => 'opened', (failure) => isNotRegularFileError(failure))).toBe(true);
    expect(isRegularFileSync(directory)).toBe(false);
  });
});

describe.skipIf(!posix)('a symlink', () => {
  const link = join(base, 'link.jsonl');
  beforeAll(() => symlinkSync(file, link));

  test('is followed by default, like any open', () => {
    expect(readRegularFileSync(link, 'utf8')).toBe(bytes.toString('utf8'));
    expect(isRegularFileSync(link)).toBe(true);
  });

  test('is refused with noFollow', async () => {
    expect(isNotRegularFileError(thrown(() => openRegularFileSync(link, { noFollow: true })))).toBe(true);
    expect(await openRegularFile(link, { noFollow: true }).then(() => 'opened', (error) => isNotRegularFileError(error))).toBe(true);
    expect(isRegularFileSync(link, { noFollow: true })).toBe(false);
  });

  test('to a FIFO is refused through the link', () => {
    const pipeLink = join(base, 'pipe-link.jsonl');
    symlinkSync(fifo('linked.fifo'), pipeLink);
    expect(isNotRegularFileError(thrown(() => openRegularFileSync(pipeLink)))).toBe(true);
  });
});

describe.skipIf(!posix)('a FIFO under a session name', () => {
  // Each of these would block forever (no writer ever comes) if it opened the pipe blocking.
  test('is refused promptly by every reader', async () => {
    const path = fifo('session-fifo.jsonl');
    expect(isNotRegularFileError(thrown(() => openRegularFileSync(path)))).toBe(true);
    expect(isNotRegularFileError(thrown(() => readRegularFileSync(path)))).toBe(true);
    expect(isNotRegularFileError(thrown(() => openRegularFileSync(path, { noFollow: true })))).toBe(true);
    expect(await openRegularFile(path).then(() => 'opened', (error) => isNotRegularFileError(error))).toBe(true);
    expect(isRegularFileSync(path)).toBe(false);
  });

  test('swapped in after the stat, the open itself does not block and the descriptor re-check refuses it', async () => {
    // What a raced swap leaves the reader holding: the flags alone must return at once.
    const path = fifo('raced.jsonl');
    const fd = openSync(path, STORE_READ_FLAGS | NO_FOLLOW_FLAG);
    try {
      expect(fstatSync(fd).isFIFO()).toBe(true);
    } finally {
      closeSync(fd);
    }
    const handle = await open(path, STORE_READ_FLAGS);
    try {
      expect((await handle.stat()).isFIFO()).toBe(true);
    } finally {
      await handle.close();
    }
  });

  test('is refused by the store containment check that asks for a regular file', () => {
    const store = join(base, 'store');
    mkdirSync(store, { recursive: true });
    const regular = join(store, 'regular.jsonl');
    writeFileSync(regular, bytes);
    const piped = join(store, 'piped.jsonl');
    Bun.spawnSync(['mkfifo', piped]);
    const nested = join(store, 'nested.jsonl');
    mkdirSync(nested);
    expect(containedStorePath([store], regular, { regularFile: true })).toBe(regular);
    expect(containedStorePath([store], piped, { regularFile: true })).toBeUndefined();
    expect(containedStorePath([store], nested, { regularFile: true })).toBeUndefined();
    // Without the option the answer is unchanged, and a missing file stays admissible when allowed.
    expect(containedStorePath([store], piped)).toBe(piped);
    expect(containedStorePath([store], join(store, 'later.jsonl'), { allowMissing: true, regularFile: true }))
      .toBe(join(store, 'later.jsonl'));
  });
});

describe('the open flags', () => {
  test('carry only bits this platform defines', () => {
    const expected = constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0);
    expect(STORE_READ_FLAGS).toBe(expected);
    expect(NO_FOLLOW_FLAG).toBe(constants.O_NOFOLLOW ?? 0);
    if (process.platform === 'win32') expect(STORE_READ_FLAGS).toBe(constants.O_RDONLY);
    else expect(STORE_READ_FLAGS & constants.O_NONBLOCK!).toBe(constants.O_NONBLOCK!);
  });
});
