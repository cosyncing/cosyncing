/**
 * Codex rollout mapping corpus: each `corpus/codex/<case>/` is a native rollout (history.jsonl at attach,
 * tail.jsonl appended while attached) read through the adapter's public attach path.
 */
import { afterAll, describe } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineCase, loadCases, runFileCase } from './lib.ts';

// Owned HOME and CODEX_HOME, and no daemon/sync probing: the adapter never sees the developer's ~/.codex.
const root = mkdtempSync(join(tmpdir(), 'cosy-map-codex-'));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.CODEX_HOME = join(root, 'codex');
process.env.COSYNCING_CODEX_SYNC_SERVER = '0';
delete process.env.COSYNCING_CODEX_LIVE;
const { CodexAdapter } = await import('../../../packages/typescript/adapters/codex/src/index.ts');

afterAll(() => rmSync(root, { recursive: true, force: true }));

const SENTINEL = '__MAPPING_SENTINEL__';
/** An error event: one `error` row, no turn state. */
const sentinel = {
  line: JSON.stringify({ type: 'event_msg', payload: { type: 'error', message: SENTINEL } }),
  is: (m: Record<string, any>) => m.type === 'error' && m.message === SENTINEL,
};

describe('codex rollout mapping corpus', () => {
  const sessions = join(root, 'codex', 'sessions', '2026', '10', '14');
  mkdirSync(sessions, { recursive: true });
  for (const cs of loadCases('codex')) {
    defineCase(cs, async () => {
      const file = join(sessions, `rollout-2026-10-14T00-00-00-${cs.meta.sessionId}.jsonl`);
      return runFileCase({
        cs,
        file,
        attach: (f) => new CodexAdapter().attach(Buffer.from(f, 'utf8').toString('base64url'), 'observe') as any,
        sentinel,
      });
    });
  }
});
