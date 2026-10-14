/**
 * Captures one normalized Observe history frame per adapter for the Flutter feature tests.
 *
 *   OUT_DIR=apps/client/test/support/feature/fixtures bun test ./e2e/adapters/kits/capture-history-frames.ts
 *
 * Each adapter's conformance kit starts a real broker over the kit's fake native agent, seeds a two-turn session
 * (`fake.seedSession`), attaches bare (Observe) and saves the session frame and the `history` frame exactly as the
 * broker sent them. The rows are real broker output for a fake agent's store: weaker evidence than a capture from
 * the real agent, and the store holds plain conversation only (no tools or edits).
 * Not a test: only this file's `bun test` entry point runs it; the conformance suites do not import it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { type Broker, startBroker } from '../../harness/index.ts';
import type { ConformanceKit, FakeController } from './kit.ts';
import { claudeKit } from './claude.ts';
import { codexKit } from './codex.ts';
import { grokKit } from './grok.ts';
import { ompKit } from './omp.ts';
import { opencodeKit } from './opencode.ts';
import { piKit } from './pi.ts';
import { reasonixKit } from './reasonix.ts';

const outDir = resolve(process.env.OUT_DIR ?? 'apps/client/test/support/feature/fixtures');
const kits: ConformanceKit[] = [claudeKit, codexKit, grokKit, ompKit, opencodeKit, piKit, reasonixKit];

describe('capture normalized history frames', () => {
  for (const kit of kits) {
    describe(kit.profile.agent, () => {
      let broker: Broker;
      let fake: FakeController;
      beforeAll(async () => {
        broker = await startBroker({
          name: `capture-${kit.profile.agent}`,
          token: true,
          env: kit.env,
          setup: async (paths) => {
            fake = await kit.install(paths);
          },
        });
      });
      afterAll(async () => {
        await fake?.cleanup?.();
        await broker?.stop();
      });
      test('history frame', async () => {
        const client = broker.client();
        const seeded = fake.seedSession({ turns: 2, title: 'Captured conversation' });
        await client.waitForSession((row) => row.id === seeded.id);
        const stream = await client.attach(kit.profile.agent, seeded.id);
        const history = await stream.waitForKind('history');
        const session = stream.frames.find((frame) => frame.kind === 'session')!;
        expect((history.messages as unknown[]).length).toBeGreaterThan(0);
        // The fixture root is a throwaway directory; make the paths stable. Its `home/` would read as a
        // personal home path to the public-tree scan, so it is renamed too.
        const text = JSON.stringify({ agent: kit.profile.agent, texts: seeded.texts, session, history }, null, 2)
          .split(broker.paths.root)
          .join('/captured')
          .replaceAll('/captured/home/', '/captured/user-home/');
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, `history-${kit.profile.agent}.json`), `${text}\n`);
        stream.close();
        client.closeAll();
      });
    });
  }
});
