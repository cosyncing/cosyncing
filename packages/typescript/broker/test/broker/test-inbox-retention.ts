#!/usr/bin/env bun
/**
 * Inbox retention acceptance.
 *
 * A delivered prompt attachment used to leak forever. Completion unlinks the
 * staging METADATA and leaves the bytes in `<cwd>/.cosyncing/inbox`, and an
 * inline attachment never had metadata at all, so the expiry sweep — which
 * walks the metadata tree — never listed an inbox directory at all.
 *
 * Fixed in place here: the three bounds (age, bytes, count), the four
 * never-delete rules, and the boundedness of the sweep itself.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROMPT_ATTACHMENT_LIMITS } from '../../../protocol/src/index.ts';
import { scopedUploadIdentity, UploadStaging } from '../../src/artifacts/upload-staging.ts';

let passed = 0;

function check(name: string, condition: unknown): void {
  if (!condition) throw new Error(`FAIL: ${name}`);
  console.log(`PASS: ${name}`);
  passed += 1;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const RETENTION_MS = PROMPT_ATTACHMENT_LIMITS.inboxRetentionMs;
const FLOOR = PROMPT_ATTACHMENT_LIMITS.maxRetainedClientFiles;

const root = mkdtempSync(join(tmpdir(), 'cosyncing-inbox-retention-'));
const home = join(root, 'state');
const identity = scopedUploadIdentity('shared:credential', 'profile', 'incarnation');

function workspace(name: string): { cwd: string; inbox: string } {
  const cwd = join(root, name);
  mkdirSync(cwd, { recursive: true });
  return { cwd, inbox: join(cwd, '.cosyncing', 'inbox') };
}

function age(path: string, ms: number): void {
  const when = (Date.now() - ms) / 1000;
  utimesSync(path, when, when);
}

function seed(inbox: string, name: string, bytes: number, ageMs: number): string {
  mkdirSync(inbox, { recursive: true });
  const path = join(inbox, name);
  writeFileSync(path, Buffer.alloc(bytes, 1));
  age(path, ageMs);
  return path;
}

function inboxNames(inbox: string): string[] {
  try {
    return readdirSync(inbox).sort();
  } catch {
    return [];
  }
}

/** Deliver one inline attachment and commit it, exactly as a prompt turn does. */
function deliverInline(
  staging: UploadStaging,
  sessionId: string,
  cwd: string,
  name: string,
  body: string,
): string {
  const prepared = staging.preparePromptFiles({
    tool: 'codex',
    sessionId,
    identity,
    clientMessageId: `client-${sessionId}-${name}`,
    sessionCwd: cwd,
    files: [{
      name,
      mimeType: 'text/plain',
      size: body.length,
      data: Buffer.from(body).toString('base64'),
    }],
  });
  staging.commitPreparedPromptFiles('codex', sessionId, prepared);
  return prepared.files[0]!.brokerPath!;
}

/**
 * Register a workspace's inbox without leaving a file in it.
 *
 * A root only enters the registry through `inboxFor`, which a delivery calls.
 * The cap checks below seed their own file sets, so the delivered file is
 * removed again to keep each inbox's contents exactly what the check states.
 */
function registerInbox(staging: UploadStaging, sessionId: string, cwd: string): void {
  const delivered = deliverInline(staging, sessionId, cwd, 'register.txt', 'register');
  rmSync(delivered, { force: true });
}

/** Stage, upload and claim one attachment; the caller decides when to commit. */
async function deliverStaged(
  staging: UploadStaging,
  sessionId: string,
  cwd: string,
  name: string,
  body: string,
): Promise<{ path: string; commit: () => void }> {
  const initialized = staging.init(
    { tool: 'codex', sessionId, name, mimeType: 'text/plain', expectedSize: body.length },
    identity,
  );
  staging.patch('codex', sessionId, initialized.uploadId, '0', Buffer.from(body), identity);
  const completed = await staging.complete('codex', sessionId, initialized.uploadId, cwd, identity);
  const prepared = staging.preparePromptFiles({
    tool: 'codex',
    sessionId,
    identity,
    clientMessageId: `client-${sessionId}-${name}`,
    sessionCwd: cwd,
    files: [{
      name: completed.name,
      mimeType: completed.mimeType,
      size: completed.size,
      stagedRef: completed.stagedRef,
    }],
  });
  return {
    path: prepared.files[0]!.brokerPath!,
    commit: () => staging.commitPreparedPromptFiles('codex', sessionId, prepared),
  };
}

try {
  // 1 — a delivered inline attachment older than the retention age is removed.
  {
    const staging = new UploadStaging({ home });
    const ws = workspace('inline-aged');
    const delivered = deliverInline(staging, 'inline-aged', ws.cwd, 'inline.txt', 'hello');
    check('commit leaves a delivered inline attachment on disk', existsSync(delivered));
    age(delivered, RETENTION_MS + DAY_MS);
    const result = staging.sweepInboxes();
    check(
      'a delivered inline attachment older than the retention age is removed',
      !existsSync(delivered) && result.removed === 1 && result.bytes === 5,
    );
  }

  // 2 — a delivered staged attachment older than the retention age is removed.
  {
    const staging = new UploadStaging({ home });
    const ws = workspace('staged-aged');
    const staged = await deliverStaged(staging, 'staged-aged', ws.cwd, 'staged.txt', 'abcdef');
    staged.commit();
    check(
      'a delivered staged attachment lands in the inbox byte-exact',
      readFileSync(staged.path, 'utf8') === 'abcdef',
    );
    age(staged.path, RETENTION_MS + DAY_MS);
    staging.sweepInboxes();
    check(
      'a delivered staged attachment older than the retention age is removed',
      !existsSync(staged.path),
    );
  }

  // 3 — a file inside the grace window survives while a live session holds the cwd.
  //
  // The grace window (24 h) is shorter than the retention age (14 d), so the
  // age rule can never reach a file inside it. Grace exists for the CAP rules,
  // which can: this inbox is over its file cap with nothing old enough to age
  // out, so without the live session every file past the floor would go.
  {
    const staging = new UploadStaging({ home, maxInboxFiles: FLOOR + 2 });
    const ws = workspace('grace');
    registerInbox(staging, 'grace', ws.cwd);
    for (let i = 0; i < FLOOR + 4; i += 1) {
      seed(ws.inbox, `recent-${String(i).padStart(2, '0')}.bin`, 16, i * 60_000);
    }
    const before = inboxNames(ws.inbox);
    const held = staging.sweepInboxes(Date.now(), { liveCwds: () => [ws.cwd] });
    check(
      'a file inside the grace window survives while a live session holds that cwd',
      held.removed === 0
        && held.scanned === FLOOR + 4
        && inboxNames(ws.inbox).length === before.length,
    );
    const swept = staging.sweepInboxes(Date.now(), { liveCwds: () => [] });
    check(
      'the same over-cap inbox is trimmed to its cap once no live session holds the cwd',
      swept.removed === 2 && inboxNames(ws.inbox).length === FLOOR + 2,
    );
  }

  // 4 — an unexpired claimed record's dataPath survives even when old.
  {
    const staging = new UploadStaging({ home });
    const ws = workspace('claimed');
    const staged = await deliverStaged(staging, 'claimed', ws.cwd, 'claimed.txt', 'in flight');
    age(staged.path, RETENTION_MS + DAY_MS);
    staging.sweepInboxes();
    check(
      "an unexpired claimed record's dataPath survives even when old",
      existsSync(staged.path),
    );
    staged.commit();
    age(staged.path, RETENTION_MS + DAY_MS);
    staging.sweepInboxes();
    check(
      'the same file is collected once the prompt turn has committed it',
      !existsSync(staged.path),
    );
  }

  // 5 — over-cap by bytes deletes oldest-first and stops at the floor.
  {
    const fileBytes = 1024;
    const staging = new UploadStaging({ home, maxInboxBytes: fileBytes * 2 });
    const ws = workspace('cap-bytes');
    registerInbox(staging, 'cap-bytes', ws.cwd);
    const seeded: string[] = [];
    const count = FLOOR + 6;
    for (let i = 0; i < count; i += 1) {
      // Index 0 is the OLDEST. Every age stays inside the retention window, so
      // the byte cap is the only rule that can fire.
      seeded.push(seed(ws.inbox, `cap-${String(i).padStart(2, '0')}.bin`, fileBytes, (count - i) * 60_000));
    }
    staging.sweepInboxes();
    check(
      'over-cap by bytes stops at the retained-file floor',
      inboxNames(ws.inbox).length === FLOOR,
    );
    check(
      'over-cap by bytes deletes oldest-first',
      seeded.slice(0, count - FLOOR).every((path) => !existsSync(path))
        && seeded.slice(count - FLOOR).every((path) => existsSync(path)),
    );
  }

  // 6 — over-cap by count likewise.
  {
    // A cap BELOW the floor, so the floor is what stops the eviction rather
    // than the cap being satisfied first.
    const staging = new UploadStaging({ home, maxInboxFiles: FLOOR - 3 });
    const ws = workspace('cap-count');
    registerInbox(staging, 'cap-count', ws.cwd);
    const seeded: string[] = [];
    const count = FLOOR + 7;
    for (let i = 0; i < count; i += 1) {
      seeded.push(seed(ws.inbox, `count-${String(i).padStart(2, '0')}.bin`, 8, (count - i) * 60_000));
    }
    staging.sweepInboxes();
    check(
      'over-cap by count stops at the retained-file floor',
      inboxNames(ws.inbox).length === FLOOR,
    );
    check(
      'over-cap by count deletes oldest-first',
      seeded.slice(0, count - FLOOR).every((path) => !existsSync(path))
        && seeded.slice(count - FLOOR).every((path) => existsSync(path)),
    );
  }

  // 7 — a symlink inside the inbox is neither followed nor deleted.
  {
    const staging = new UploadStaging({ home });
    const ws = workspace('symlink-entry');
    const anchor = deliverInline(staging, 'symlink-entry', ws.cwd, 'anchor.txt', 'anchor');
    const outside = join(root, 'symlink-entry-outside');
    mkdirSync(outside, { recursive: true });
    const target = join(outside, 'target.txt');
    writeFileSync(target, 'must survive');
    age(target, RETENTION_MS + 30 * DAY_MS);
    symlinkSync(target, join(ws.inbox, 'link.txt'));
    symlinkSync(outside, join(ws.inbox, 'link-dir'));
    age(anchor, RETENTION_MS + DAY_MS);
    staging.sweepInboxes();
    check(
      'an aged regular file beside the symlinks is still collected',
      !existsSync(anchor),
    );
    check(
      'a symlink inside the inbox is neither followed nor deleted',
      readFileSync(target, 'utf8') === 'must survive'
        && inboxNames(ws.inbox).includes('link.txt')
        && inboxNames(ws.inbox).includes('link-dir'),
    );
  }

  // 8 — a file outside the inbox reached through a symlinked inbox parent is
  //     never touched: `.cosyncing` must resolve to itself or the root is refused.
  {
    const staging = new UploadStaging({ home });
    const ws = workspace('symlink-parent');
    deliverInline(staging, 'symlink-parent', ws.cwd, 'anchor.txt', 'anchor');
    rmSync(join(ws.cwd, '.cosyncing'), { recursive: true, force: true });
    const elsewhere = join(root, 'symlink-parent-elsewhere');
    mkdirSync(join(elsewhere, 'inbox'), { recursive: true });
    const victim = join(elsewhere, 'inbox', 'victim.bin');
    writeFileSync(victim, 'not inside any workspace');
    age(victim, RETENTION_MS + 30 * DAY_MS);
    symlinkSync(elsewhere, join(ws.cwd, '.cosyncing'));
    const result = staging.sweepInboxes();
    check(
      'a symlinked `.cosyncing` is refused rather than swept',
      existsSync(victim) && result.refused === 1,
    );
  }

  // 9 — the root registry survives a restart, and a removed directory is dropped.
  {
    const restartHome = join(root, 'restart-state');
    const first = new UploadStaging({ home: restartHome });
    const kept = workspace('restart-kept');
    const removed = workspace('restart-removed');
    deliverInline(first, 'restart-kept', kept.cwd, 'kept.txt', 'kept');
    deliverInline(first, 'restart-removed', removed.cwd, 'gone.txt', 'gone');
    const registryPath = join(restartHome, 'uploads', 'inbox-roots.json');
    check('inboxFor records each session cwd in the root registry', existsSync(registryPath));

    rmSync(removed.cwd, { recursive: true, force: true });
    const second = new UploadStaging({ home: restartHome });
    const aged = join(kept.inbox, 'kept.txt');
    age(aged, RETENTION_MS + DAY_MS);
    const result = second.sweepInboxes();
    check(
      'the root registry survives a restart and still reaches the surviving inbox',
      !existsSync(aged) && result.dropped === 1,
    );
    const registry = JSON.parse(readFileSync(registryPath, 'utf8')) as { roots: string[] };
    check(
      'a removed directory is dropped from the registry',
      registry.roots.length === 1
        && !registry.roots.some((entry) => entry.endsWith('restart-removed')),
    );
  }

  // 10 — the sweep is bounded and its round-robin cursor advances.
  {
    const boundedHome = join(root, 'bounded-state');
    const staging = new UploadStaging({ home: boundedHome });
    const inboxes: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const ws = workspace(`bounded-${String(i).padStart(2, '0')}`);
      deliverInline(staging, `bounded-${i}`, ws.cwd, 'aged.txt', 'aged');
      age(join(ws.inbox, 'aged.txt'), RETENTION_MS + DAY_MS);
      inboxes.push(ws.inbox);
    }
    const first = staging.sweepInboxes();
    const remaining = inboxes.filter((inbox) => existsSync(join(inbox, 'aged.txt'))).length;
    check(
      'one sweep inspects no more than 32 roots',
      first.roots === 32 && first.removed === 32 && remaining === 8,
    );
    const registryPath = join(boundedHome, 'uploads', 'inbox-roots.json');
    const cursor = (JSON.parse(readFileSync(registryPath, 'utf8')) as { cursor: number }).cursor;
    check('the round-robin cursor advances by the roots inspected', cursor === 32);
    staging.sweepInboxes();
    check(
      'the next sweep reaches the roots the first one did not',
      inboxes.every((inbox) => !existsSync(join(inbox, 'aged.txt'))),
    );
  }

  // 11 — a live session's workspace is adopted even though nothing registered it.
  //
  // `inboxFor` is the registry's only other writer, so every inbox that filled
  // before this collector existed is invisible to it — the exact directories
  // this work exists to clean. Adoption is what reaches them, and it is bounded
  // to a workspace that already has an inbox.
  {
    const adoptHome = join(root, 'adopt-state');
    const staging = new UploadStaging({ home: adoptHome });
    const leaked = workspace('adopt-leaked');
    const bare = workspace('adopt-no-inbox');
    const stale = seed(leaked.inbox, 'leaked.png', 64, RETENTION_MS + DAY_MS);
    const unregistered = staging.sweepInboxes();
    check(
      'an inbox that predates the collector is in no registry',
      unregistered.roots === 0 && existsSync(stale),
    );

    const adopted = staging.sweepInboxes(Date.now(), {
      liveCwds: () => [leaked.cwd, bare.cwd],
    });
    check(
      "a live session's pre-existing inbox is adopted and swept",
      adopted.roots === 1 && adopted.removed === 1 && !existsSync(stale),
    );
    const roots = (JSON.parse(
      readFileSync(join(adoptHome, 'uploads', 'inbox-roots.json'), 'utf8'),
    ) as { roots: string[] }).roots;
    check(
      'a live workspace with no inbox is neither registered nor given one',
      roots.length === 1 && roots[0]!.endsWith('adopt-leaked') && !existsSync(bare.inbox),
    );
  }

  // The documented rollback knob.
  {
    const staging = new UploadStaging({ home, inboxRetentionMs: 0 });
    const ws = workspace('disabled');
    const delivered = deliverInline(staging, 'disabled', ws.cwd, 'kept.txt', 'kept');
    age(delivered, RETENTION_MS + 30 * DAY_MS);
    const result = staging.sweepInboxes();
    check(
      'a zero retention disables the inbox sweep entirely',
      existsSync(delivered) && result.removed === 0 && result.roots === 0,
    );
  }

  console.log(`\n${passed} inbox retention checks passed.`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
