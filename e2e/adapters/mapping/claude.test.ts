/**
 * Claude Code transcript mapping corpus: each `corpus/claude/<case>/` is a native transcript (history.jsonl at
 * attach, tail.jsonl appended while attached) read through the adapter's public attach path.
 */
import { afterAll, describe } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineCase, loadCases, runFileCase } from './lib.ts';

// An owned config dir and HOME: the adapter's store discovery never sees the developer's ~/.claude.
const root = mkdtempSync(join(tmpdir(), 'cosy-map-claude-'));
process.env.HOME = root;
process.env.USERPROFILE = root;
process.env.CLAUDE_CONFIG_DIR = join(root, 'claude');
const { ClaudeAdapter } = await import('../../../packages/typescript/adapters/claude/src/index.ts');

afterAll(() => rmSync(root, { recursive: true, force: true }));

const SENTINEL = '__MAPPING_SENTINEL__';
/** A local-command notice: one `notice` row, no turn, no run-summary. */
const sentinel = {
  line: JSON.stringify({ type: 'system', subtype: 'local_command', level: 'info', uuid: 'sentinel', content: `<local-command-stdout>${SENTINEL}</local-command-stdout>` }),
  is: (m: Record<string, any>) => m.type === 'notice' && m.message === SENTINEL,
};

describe('claude transcript mapping corpus', () => {
  const projects = join(root, 'claude', 'projects', '-work-proj');
  mkdirSync(projects, { recursive: true });
  for (const cs of loadCases('claude')) {
    defineCase(cs, async () => {
      const file = join(projects, `${cs.meta.sessionId}.jsonl`);
      return runFileCase({
        cs,
        file,
        attach: (f) => new ClaudeAdapter().attach(Buffer.from(f, 'utf8').toString('base64url'), 'observe') as any,
        sentinel,
      });
    });
  }
});
