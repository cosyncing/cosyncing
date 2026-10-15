/**
 * OpenCode mapping corpus: each `corpus/opencode/<case>/` is a transcript as `opencode serve` returns it
 * (history.json) plus the bus events that arrive while attached (tail.json), served by the harness's fake serve
 * on a leased loopback port and read through the adapter's public attach path. `$SESSION` in an event is the
 * session id; `settled` is what the transcript endpoint answers once the tail is over (the resync).
 */
import { afterAll, describe } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eventually } from '../../harness/index.ts';
import { startFakeOpenCode } from '../../harness/fakes/opencode-server.ts';
import { defineCase, loadCases, readIfExists } from './lib.ts';

// Owned HOME; the serve is always the fake's URL, never $OPENCODE_URL and never 4096.
const root = mkdtempSync(join(tmpdir(), 'cosy-map-opencode-'));
process.env.HOME = root;
process.env.USERPROFILE = root;
delete process.env.OPENCODE_URL;
const { OpenCodeAdapter } = await import('../../../packages/typescript/adapters/opencode/src/index.ts');

afterAll(() => rmSync(root, { recursive: true, force: true }));

const MARK = '__MAPPING_MARK__';
const mark = (name: string) => ({ type: 'permission.asked', properties: { id: `${MARK}:${name}`, sessionID: '$SESSION', permission: `${MARK}:${name}`, patterns: [] } });
const isMark = (name: string) => (m: Record<string, any>) => m.type === 'permission-request' && m.title === `${MARK}:${name}`;
const isAnyMark = (m: Record<string, any>) => m.type === 'permission-request' && String(m.title).startsWith(MARK);

const fill = (value: unknown, session: string): unknown => JSON.parse(JSON.stringify(value).replaceAll('$SESSION', session));

describe('opencode mapping corpus', () => {
  let n = 0;
  for (const cs of loadCases('opencode')) {
    defineCase(cs, async () => {
      const session = `ses_map${++n}`;
      const history = JSON.parse(readIfExists(cs.dir, 'history.json') ?? '{"rows":[]}') as { rows: any[]; revert?: string };
      const tail = JSON.parse(readIfExists(cs.dir, 'tail.json') ?? '{"events":[]}') as { events: any[]; settled?: any[]; settledRevert?: string | null };
      const fake = startFakeOpenCode('/work/proj', session);
      fake.setRows(history.rows);
      if (history.revert) fake.setRevert(history.revert);
      const conn = await new OpenCodeAdapter({ baseUrl: fake.url, storageDir: join(root, 'oc') }).attach(session, 'observe');
      try {
        const historyRows = await conn.getHistory();
        const live: Record<string, any>[] = [];
        conn.subscribe((m: any) => live.push(m));
        // The bus is only listened to once the adapter's stream is open: send a probe until it is heard.
        await eventually(() => {
          if (!fake.requests.some((r) => r.endsWith('/event'))) return false;
          fake.publish(fill(mark('probe'), session) as any);
          return live.some(isMark('probe'));
        }, { what: 'the adapter to listen on the event bus' });
        fake.setRows(tail.settled ?? history.rows);
        if (tail.settledRevert === null) fake.setRevert('');
        for (const event of tail.events) fake.publish(fill(event, session) as any);
        fake.publish(fill(mark('end'), session) as any);
        await eventually(() => live.some(isMark('end')), { what: `the end marker of ${cs.name}` });
        const replay = await conn.getHistory();
        const dropMarks = (list: Record<string, any>[]) => list.filter((m) => !isAnyMark(m));
        return { history: historyRows as any[], live, replay: replay as any[], dropSentinel: dropMarks };
      } finally {
        await conn.close();
        fake.stop();
      }
    });
  }
});
