/**
 * Pi and omp session mapping corpus: each `corpus/<pi|omp>/<case>/` is a native session JSONL (history.jsonl at
 * attach, tail.jsonl appended while attached) read through the engine's public attach path. The two dialects
 * share one engine; omp's cases pin what its descriptor changes (event-key namespace, sources, combined models).
 */
import { afterAll, describe } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OMP_DIALECT } from '../../../packages/typescript/adapters/omp/src/dialect.ts';
import { PI_DIALECT, PiEngineAdapter, resolvePiDialectRuntime, type PiDialect } from '../../../packages/typescript/pi-engine/src/index.ts';
import { defineCase, loadCases, runFileCase } from './lib.ts';

const root = mkdtempSync(join(tmpdir(), 'cosy-map-pi-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A runtime over an owned agent dir and sessions root, with no binary, no bridge install and no broker. */
function adapterFor(dialect: PiDialect, agent: string): PiEngineAdapter {
  const prefix = dialect.toolId === 'omp' ? 'COSYNCING_OMP' : 'COSYNCING_PI';
  const env = { HOME: root, [`${prefix}_AGENT_DIR`]: join(root, agent, 'agent'), [`${prefix}_SESSIONS_ROOT`]: join(root, agent, 'sessions') };
  const runtime = resolvePiDialectRuntime(dialect, env, {
    hooks: { readiness: () => ({ ready: false, message: 'mapping fixture: no runtime', detailCode: 'fixture' }), diagnose: async () => ({}) as any },
    bridgeAsset: { source: '', sha256: '' },
  });
  return new PiEngineAdapter(runtime, { brokerUrl: 'http://127.0.0.1:1' });
}

const sentinel = {
  // No entry id: an id without a parentId would switch the engine's active-branch pruning off for the whole file.
  line: JSON.stringify({ type: 'message', message: { role: 'toolResult', toolCallId: '__sentinel__', toolName: '__sentinel__', content: [{ type: 'text', text: 'end of tail' }] } }),
  is: (m: Record<string, any>) => m.type === 'tool-result' && m.callId === '__sentinel__',
};

for (const [agent, dialect] of [['pi', PI_DIALECT], ['omp', OMP_DIALECT]] as const) {
  describe(`${agent} session mapping corpus`, () => {
    const adapter = adapterFor(dialect, agent);
    const sessions = join(root, agent, 'sessions', '--work-proj--');
    mkdirSync(sessions, { recursive: true });
    for (const cs of loadCases(agent)) {
      defineCase(cs, () => runFileCase({
        cs,
        file: join(sessions, `2026-10-14T00-00-00-000Z_${cs.meta.sessionId}.jsonl`),
        attach: (f) => adapter.attach(Buffer.from(f, 'utf8').toString('base64url'), 'observe') as any,
        sentinel,
      }));
    }
  });
}
