/**
 * Reasonix transcript mapping corpus. Reasonix v1.25.2 writes one flat JSONL transcript; the observe path maps the
 * records read at attach by position, then each appended record at its absolute line index, and a resync maps the
 * whole file again. A case is the records at attach (history.jsonl), the records appended after (tail.jsonl), and
 * optionally the display-index entries (`display`) that name each record's native index and authored turn.
 */
import { describe, expect } from 'bun:test';
import {
  mapReasonixInterruptedTail,
  mapReasonixRecord,
  mapReasonixTranscript,
  type ReasonixMapTrace,
} from '../../../packages/typescript/adapters/reasonix/src/mapping.ts';
import { defineCase, loadCases, readIfExists } from './lib.ts';

const lines = (text: string | undefined): any[] => (text ?? '').split('\n').filter(Boolean).map((l) => JSON.parse(l));

describe('reasonix transcript mapping corpus', () => {
  for (const cs of loadCases('reasonix')) {
    defineCase(cs, async () => {
      const history = lines(readIfExists(cs.dir, 'history.jsonl'));
      const tail = lines(readIfExists(cs.dir, 'tail.jsonl'));
      const display = (cs.meta.display as any[] | undefined) ?? [];
      const sessionId = String(cs.meta.sessionId);
      const traces: ReasonixMapTrace[] = [];
      const trace = (e: ReasonixMapTrace) => void traces.push(e);
      const attached = mapReasonixTranscript(sessionId, history, display, trace);
      const byIndex = new Map(display.map((d) => [d.index, d]));
      const followed = tail.flatMap((record, i) => mapReasonixRecord(record, {
        sessionId, lineIndex: history.length + i, display: byIndex.get(history.length + i), trace,
      }));
      const resyncTraces: ReasonixMapTrace[] = [];
      const replay = mapReasonixTranscript(sessionId, [...history, ...tail], display, (e) => void resyncTraces.push(e));
      if (cs.meta.traceOps) expect(resyncTraces.map((t) => t.op) as string[]).toEqual(cs.meta.traceOps as string[]);
      expect(traces.map((t) => t.op), 'incremental and resync trace the same drift').toEqual(resyncTraces.map((t) => t.op));
      if (cs.meta.interrupted) {
        const interrupted = mapReasonixInterruptedTail(sessionId, history, display) as any;
        expect(interrupted?.status).toBe(cs.meta.interrupted);
        expect(interrupted?.userMessageKey).toBe((replay as any[]).find((m: any) => m.type === 'user-message' && m.text === (cs.meta.userTexts as string[]).at(-1))?.key);
        expect(mapReasonixInterruptedTail(sessionId, [...history, { role: 'assistant', content: 'late' }], display)).toBeUndefined();
      }
      return { history: attached as any[], live: followed as any[], replay: replay as any[] };
    });
  }
});
