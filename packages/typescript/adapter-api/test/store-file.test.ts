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
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
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

const posix = process.platform !== 'win32';
const base = realpathSync(mkdtempSync(join(tmpdir(), 'store-file-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const file = join(base, 'session.jsonl');
const bytes = Buffer.from('{"type":"user","text":"héllo"}\n{"type":"assistant"}\n', 'utf8');
writeFileSync(file, bytes);
const directory = join(base, 'directory.jsonl');
mkdirSync(directory);
const missing = join(base, 'missing.jsonl');

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
