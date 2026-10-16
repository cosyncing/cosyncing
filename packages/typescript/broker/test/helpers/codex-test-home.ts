/**
 * An owned `CODEX_HOME` for in-process Codex adapter tests.
 *
 * The Codex adapter fixes its session store (`$CODEX_HOME/sessions`) when its
 * module loads, and attaches, forks and renames only rollouts inside it. So a
 * test that drives the adapter in process must:
 *
 *  1. import this module BEFORE anything that loads the adapter (module
 *     evaluation follows import order), so the store is this temporary home and
 *     never the developer's `~/.codex`; and
 *  2. write every fixture rollout under {@link CODEX_TEST_SESSIONS}, for
 *     example in a directory from {@link codexTestRolloutDir}.
 *
 * The home is removed when the process exits.
 */
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CODEX_TEST_HOME = mkdtempSync(join(tmpdir(), 'cosyncing-codex-test-home-'));
process.env.CODEX_HOME = CODEX_TEST_HOME;

/** The adapter's session store for this process. */
export const CODEX_TEST_SESSIONS = join(CODEX_TEST_HOME, 'sessions');
mkdirSync(CODEX_TEST_SESSIONS, { recursive: true });

process.on('exit', () => rmSync(CODEX_TEST_HOME, { recursive: true, force: true }));

/** A fresh directory inside the session store, for one fixture's rollouts. */
export function codexTestRolloutDir(prefix: string): string {
  return mkdtempSync(join(CODEX_TEST_SESSIONS, prefix));
}
