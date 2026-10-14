/**
 * Antigravity (agy) transcript mapping corpus. agy's observe path folds each native step (and each host settlement
 * message written beside the transcript) with one per-conversation state and one key function; the stream and the
 * file share the fold. A case is the steps read at attach, the lines that arrive after (same state), and a resync
 * (everything folded again with a fresh state). `refs` point at the committed 1.1.17 capture instead of copying it.
 */
import { describe, expect } from 'bun:test';
import {
  classifyAgySettlementSender,
  createAgyMapState,
  mapAgySettlement,
  mapAgyStep,
  mapAgyUnmappedSettlement,
  parseAgySettlement,
  parseAgyStep,
} from '../../../packages/typescript/adapters/antigravity/src/index.ts';
import { caseLines, defineCase, loadCases } from './lib.ts';

const CONVERSATION = '11111111-1111-4111-8111-111111111111';

/** One native line: a step, else a settlement document, else nothing (the adapter skips what it cannot parse). */
function fold(line: string, state: ReturnType<typeof createAgyMapState>): any[] {
  const step = parseAgyStep(line);
  if (step) return mapAgyStep(step, state) as any[];
  const settlement = parseAgySettlement(line);
  if (!settlement) return [];
  const source = classifyAgySettlementSender(settlement.sender);
  return (source.category === 'system' || source.category === 'unknown'
    ? [mapAgyUnmappedSettlement(settlement)]
    : mapAgySettlement(settlement, CONVERSATION)) as any[];
}

describe('agy transcript mapping corpus', () => {
  for (const cs of loadCases('agy')) {
    defineCase(cs, async () => {
      const liveChild = cs.meta.liveChild === true;
      const history = caseLines(cs, 'history');
      const tail = caseLines(cs, 'tail');
      const state = () => createAgyMapState(CONVERSATION, { liveChild });
      const attached = state();
      const rows = history.flatMap((line) => fold(line, attached));
      const live = tail.flatMap((line) => fold(line, attached));
      const fresh = state();
      const replay = [...history, ...tail].flatMap((line) => fold(line, fresh));
      expect([...rows, ...live], 'the live fold and a fresh replay agree row for row').toEqual(replay);
      return { history: rows, live, replay };
    });
  }
});
