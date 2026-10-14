/**
 * Kimi transcript mapping corpus. Kimi's observe path folds native REST message pages (newest-first, as the server
 * answers them) through one per-connection mapping state; a case is the page read at attach (history.json), the
 * page of newer rows that arrives after (tail.json, mapped through the SAME state: correlations resolve across
 * the boundary), and a resync (the whole transcript folded with a fresh state). A case may instead point at a
 * committed capture (`source`, with `tailNewest` rows held back as the tail).
 */
import { describe, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from '../../harness/index.ts';
import { createKimiMappingState, mapKimiMessagePage } from '../../../packages/typescript/adapters/kimi/src/mapping.ts';
import { defineCase, loadCases, readIfExists } from './lib.ts';

interface Page { items: unknown[] }

function inputs(cs: ReturnType<typeof loadCases>[number]): { history: Page; tail: Page } {
  const source = cs.meta.source as { fixture: string; path: string; tailNewest: number } | undefined;
  if (source) {
    const data = source.path.split('.').reduce((v: any, k) => v[k], JSON.parse(readFileSync(join(REPO_ROOT, source.fixture), 'utf8')));
    return { history: { items: data.items.slice(source.tailNewest) }, tail: { items: data.items.slice(0, source.tailNewest) } };
  }
  return {
    history: JSON.parse(readIfExists(cs.dir, 'history.json') ?? '{"items":[]}'),
    tail: JSON.parse(readIfExists(cs.dir, 'tail.json') ?? '{"items":[]}'),
  };
}

describe('kimi transcript mapping corpus', () => {
  for (const cs of loadCases('kimi')) {
    defineCase(cs, async () => {
      const { history, tail } = inputs(cs);
      const state = createKimiMappingState();
      const attached = mapKimiMessagePage(history as never, state);
      const followed = mapKimiMessagePage(tail as never, state);
      const resync = mapKimiMessagePage({ items: [...tail.items, ...history.items] } as never, createKimiMappingState());
      // every native row has one identity, across the attach, the tail and the resync
      const identities = resync.rows.map((r) => r.identity);
      expect(new Set(identities).size, 'a unique identity per mapped row').toBe(identities.length);
      expect([...attached.rows, ...followed.rows].map((r) => r.identity)).toEqual(identities);
      return {
        history: attached.rows.map((r) => r.message) as any[],
        live: followed.rows.map((r) => r.message) as any[],
        replay: resync.rows.map((r) => r.message) as any[],
      };
    });
  }
});
