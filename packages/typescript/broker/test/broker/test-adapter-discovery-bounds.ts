#!/usr/bin/env bun
/**
 * Direct, deterministic proof of the two bounds roster discovery must hold.
 *
 * WORK: each adapter applies the cutoff before expensive native decoding, so a
 * long history costs the window rather than the store.
 *
 * TIME: no single backend can hold the roster. Both bounds exist for the same
 * reason — the roster is one answer assembled from every adapter — but they
 * fail differently, and the second only became reachable once adapters that
 * talk to a host this broker does not own were registered by default.
 */
export {};

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Database } from 'bun:sqlite';
import {
  ABANDONED_LEG_CARRY_SWEEPS,
  AgentRegistry,
  DISCOVERY_FAN_OUT_LIMIT,
  effectiveDiscoveryBudgetMs,
  EXTERNAL_HOST_DISCOVERY_BUDGET_MS,
  type AgentBackend,
  type AgentCapabilities,
  type AvailabilityOptions,
  type SessionDiscoveryOptions,
  type SessionDiscoveryWork,
  type SessionInfo,
} from '../../../adapter-api/src/index.ts';
import { mergeLegRows } from '../../src/runtime/roster-visibility.ts';

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const root = mkdtempSync(join(tmpdir(), 'cosyncing-adapter-bounds-'));
const now = Date.now();
const cutoff = now - 7 * 86_400_000;
const oldTime = new Date(cutoff - 86_400_000);
const recentTime = new Date(cutoff + 86_400_000);
const decoded = (work: SessionDiscoveryWork[]): string[] =>
  work
    .filter((event): event is Extract<SessionDiscoveryWork, { kind: 'decode-file' }> =>
      event.kind === 'decode-file')
    .map((event) => event.source);

function writeTimed(path: string, contents: string, time: Date): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, contents);
  utimesSync(path, time, time);
}

try {
  // Adapter roots are resolved at module import, so isolate every one before
  // loading the workspace packages.
  const codexHome = join(root, 'codex');
  const claudeConfig = join(root, 'claude');
  const piAgent = join(root, 'pi-agent');
  const piSessions = join(piAgent, 'sessions');
  const emptyWrappers = join(root, 'claude-wrappers');
  mkdirSync(emptyWrappers, { recursive: true });
  process.env.CODEX_HOME = codexHome;
  process.env.COSYNCING_CODEX_SYNC_SERVER = '1';
  process.env.CLAUDE_CONFIG_DIR = claudeConfig;
  process.env.COSYNCING_CLAUDE_WRAPPER_DIR = emptyWrappers;
  process.env.PI_CODING_AGENT_DIR = piAgent;
  process.env.COSYNCING_PI_SESSIONS_ROOT = piSessions;
  process.env.PI_CODING_AGENT_SESSION_DIR = piSessions;
  // Keep discovery offline even when the developer machine has agent CLIs.
  process.env.PATH = '/usr/bin:/bin';

  const fakeClaude = join(root, 'fake-claude');
  const claudeOldLiveId = '22222222-2222-4222-8222-222222222222';
  writeFileSync(
    fakeClaude,
    `#!/bin/sh
if [ "$1" = "agents" ] && [ "$2" = "--json" ]; then
  printf '%s\\n' '[{"sessionId":"${claudeOldLiveId}","status":"waiting"}]'
  exit 0
fi
exit 0
`,
  );
  chmodSync(fakeClaude, 0o755);
  process.env.COSYNCING_CLAUDE_BIN = fakeClaude;

  const { CodexAdapter } = await import('../../../adapters/codex/src/index.ts');
  const {
    ClaudeAdapter,
    CLAUDE_STORE_STATUS_CONCURRENCY,
    readClaudeStoreStatuses,
  } = await import('../../../adapters/claude/src/index.ts');
  const { PiAdapter } = await import('../../../adapters/pi/src/index.ts');
  const { OpenCodeAdapter } = await import('../../../adapters/opencode/src/index.ts');

  // First discovery after broker startup has no cached `agents --json` result.
  // Store probes are independent; serial waits multiply the native 2s ceiling
  // by every configured wrapper and can consume the whole sweep budget.
  let activeClaudeStoreReads = 0;
  let peakClaudeStoreReads = 0;
  const statusStores = ['default', 'wrapper-a', 'wrapper-b', 'wrapper-c', 'wrapper-d', 'wrapper-e']
    .map((configDir, index) => ({
      configDir,
      projectsRoot: configDir,
      bin: 'claude',
      isDefault: index === 0,
    }));
  const statusReadOrder = await readClaudeStoreStatuses(statusStores, async (store) => {
    activeClaudeStoreReads += 1;
    peakClaudeStoreReads = Math.max(peakClaudeStoreReads, activeClaudeStoreReads);
    await new Promise((resolve) => setTimeout(resolve, 20));
    activeClaudeStoreReads -= 1;
    return store.configDir;
  });
  check(
    'Claude bounds concurrent store-status probes and preserves store order',
    peakClaudeStoreReads === CLAUDE_STORE_STATUS_CONCURRENCY
      && statusReadOrder.join(',') === statusStores.map((store) => store.configDir).join(','),
    `peak=${peakClaudeStoreReads} order=${statusReadOrder.join(',')}`,
  );

  const codexDir = join(codexHome, 'sessions', '2026', '07', '29');
  const codexOldIdleId = '11111111-1111-4111-8111-111111111111';
  const codexOldLiveId = '22222222-2222-4222-8222-222222222222';
  const codexRecentId = '33333333-3333-4333-8333-333333333333';
  const codexPath = (id: string) =>
    join(codexDir, `rollout-2026-07-29T00-00-00-${id}.jsonl`);
  const codexLine = (id: string) =>
    `${JSON.stringify({
      timestamp: new Date(now).toISOString(),
      type: 'session_meta',
      payload: { id, cwd: root },
    })}\n`;
  writeTimed(codexPath(codexOldIdleId), codexLine(codexOldIdleId), oldTime);
  writeTimed(codexPath(codexOldLiveId), codexLine(codexOldLiveId), oldTime);
  writeTimed(codexPath(codexRecentId), codexLine(codexRecentId), recentTime);
  const codexWork: SessionDiscoveryWork[] = [];
  const codexLoadedRolloutId = basename(codexPath(codexOldLiveId))
    .replace(/^rollout-.*?-([0-9a-f-]+)\.jsonl$/i, '$1');
  const codexRows = await new CodexAdapter({
    queryLoadedThreadIds: async () => new Set([codexLoadedRolloutId]),
    scanCodexTuiPresence: async () => ({
      attributed: new Set(),
      unattributed: [],
      privateThreadIds: new Set(),
      privateUnattributed: [],
      unknownUnattributed: [],
      unknownThreadIds: new Set(),
      candidates: [],
      socketDiagAvailable: true,
      processScanAvailable: true,
    }),
  }).discoverSessions({ updatedAfter: cutoff, onWork: (work) => codexWork.push(work) });
  const codexDecoded = decoded(codexWork).map((path) => basename(path));
  check(
    'Codex skips old idle rollout parsing but decodes recent and old loaded sessions',
    !codexDecoded.some((path) => path.includes(codexOldIdleId)) &&
      codexDecoded.some((path) => path.includes(codexOldLiveId)) &&
      codexDecoded.some((path) => path.includes(codexRecentId)) &&
      codexRows.some((row) => row.nativeId === codexOldLiveId),
    JSON.stringify(codexDecoded),
  );

  const claudeDir = join(claudeConfig, 'projects', '-fixture');
  const claudeOldIdleId = '11111111-1111-4111-8111-111111111111';
  const claudeRecentId = '33333333-3333-4333-8333-333333333333';
  const claudePath = (id: string) => join(claudeDir, `${id}.jsonl`);
  const claudeLine = (id: string) =>
    `${JSON.stringify({
      type: 'user',
      uuid: `user-${id}`,
      timestamp: new Date(now).toISOString(),
      cwd: root,
      message: { content: `prompt ${id}` },
    })}\n`;
  writeTimed(claudePath(claudeOldIdleId), claudeLine(claudeOldIdleId), oldTime);
  writeTimed(claudePath(claudeOldLiveId), claudeLine(claudeOldLiveId), oldTime);
  writeTimed(claudePath(claudeRecentId), claudeLine(claudeRecentId), recentTime);
  const claudeWork: SessionDiscoveryWork[] = [];
  const claudeRows = await new ClaudeAdapter().discoverSessions({
    updatedAfter: cutoff,
    onWork: (work) => claudeWork.push(work),
  });
  const claudeDecoded = decoded(claudeWork).map((path) => basename(path));
  check(
    'Claude skips old idle transcript parsing but decodes recent and old needs-input sessions',
    !claudeDecoded.includes(`${claudeOldIdleId}.jsonl`) &&
      claudeDecoded.includes(`${claudeOldLiveId}.jsonl`) &&
      claudeDecoded.includes(`${claudeRecentId}.jsonl`) &&
      claudeRows.some((row) => row.id === Buffer.from(claudePath(claudeOldLiveId)).toString('base64url')),
    JSON.stringify(claudeDecoded),
  );

  const piDir = join(piSessions, '--fixture--');
  const piOld = join(piDir, '2026-07-01_old.jsonl');
  const piRecent = join(piDir, '2026-07-29_recent.jsonl');
  const piLine = `${JSON.stringify({ type: 'session', id: 'pi-session', cwd: root })}\n`;
  writeTimed(piOld, piLine, oldTime);
  writeTimed(piRecent, piLine, recentTime);
  const piWork: SessionDiscoveryWork[] = [];
  const piRows = await new PiAdapter({ brokerUrl: 'http://127.0.0.1:1' }).discoverSessions({
    updatedAfter: cutoff,
    onWork: (work) => piWork.push(work),
  });
  const piDecoded = decoded(piWork);
  check(
    'Pi skips old session parsing before reading JSONL content',
    !piDecoded.includes(piOld) && piDecoded.includes(piRecent) && piRows.length === 1,
    JSON.stringify(piDecoded),
  );

  const opencodeData = join(root, 'opencode');
  mkdirSync(opencodeData, { recursive: true });
  const dbPath = join(opencodeData, 'opencode.db');
  const db = new Database(dbPath);
  db.run(`
    create table session (
      id text primary key,
      parent_id text,
      slug text,
      directory text,
      title text,
      model text,
      revert text,
      time_created integer,
      time_updated integer,
      time_archived integer
    )
  `);
  db.query(
    `insert into session
      (id, parent_id, slug, directory, title, time_created, time_updated, time_archived)
      values (?, null, ?, ?, ?, ?, ?, null)`,
  ).run('old', 'old', root, 'Old', oldTime.getTime(), oldTime.getTime());
  db.query(
    `insert into session
      (id, parent_id, slug, directory, title, time_created, time_updated, time_archived)
      values (?, null, ?, ?, ?, ?, ?, null)`,
  ).run('recent', 'recent', root, 'Recent', recentTime.getTime(), recentTime.getTime());
  db.close();
  const opencodeWork: SessionDiscoveryWork[] = [];
  const opencodeRows = await new OpenCodeAdapter({
    baseUrl: 'http://127.0.0.1:1',
    storageDir: opencodeData,
  }).discoverSessions({
    updatedAfter: cutoff,
    onWork: (work) => opencodeWork.push(work),
  });
  const sql = opencodeWork.find(
    (work): work is Extract<SessionDiscoveryWork, { kind: 'sqlite-query' }> =>
      work.kind === 'sqlite-query',
  );
  check(
    'OpenCode applies the cutoff in SQLite instead of decoding/filtering all rows',
    sql?.bounded === true &&
      sql.cutoff === cutoff &&
      opencodeRows.some((row) => row.id === 'recent') &&
      !opencodeRows.some((row) => row.id === 'old'),
    JSON.stringify({ sql, rows: opencodeRows.map((row) => row.id) }),
  );

  // ── TIME: one wedged host must not hold the whole roster ───────────────────
  //
  // The shape that matters is a host that ACCEPTS the connection and then never
  // answers. Nothing fails, so no error path runs; the leg simply never
  // completes, and `discoverAll` answers only when every backend has. Before the
  // budget this made the roster hostage to a host the broker does not own — and
  // the established agents, which had already answered in microseconds, waited
  // with it.
  //
  // These fakes stand in for that host deliberately. A real one would need a
  // socket that accepts and stalls, which proves the same thing less directly
  // and less reliably; what is under test is the registry's bound, not TCP.
  const externalCapabilities: AgentCapabilities = {
    integrationKind: 'http-websocket',
    attachModes: ['live'],
    supportsObserve: false,
    supportsResume: false,
    supportsLiveAttach: true,
    supportsNativeArtifact: false,
    supportsNativeFileInput: false,
    supportsModelSwitch: false,
    permissionGranularity: 'none',
  };

  /** An established local adapter: answers at once, declares no budget. */
  class SettledBackend implements AgentBackend {
    constructor(readonly id: string) {}
    readonly displayName = 'settled';
    readonly capabilities: AgentCapabilities = {
      ...externalCapabilities,
      integrationKind: 'jsonrpc-stdio',
    };
    async isAvailable(): Promise<boolean> {
      return true;
    }
    async discoverSessions(): Promise<SessionInfo[]> {
      return [{
        id: `${this.id}-session`,
        tool: this.id,
        title: 'settled',
        status: 'idle',
        attachMode: 'live',
      }];
    }
    async attach(): Promise<never> {
      throw new Error('not reachable in this fixture');
    }
  }

  /**
   * A host that accepts and never answers. `cooperative` decides whether it
   * honours the abort — the uncooperative variant is the one that proves the
   * bound is the registry's own, not the adapter's good behaviour.
   */
  class WedgedHostBackend implements AgentBackend {
    aborted = false;
    sawSignal = false;
    constructor(readonly id: string, readonly budgetMs: number, private readonly cooperative: boolean) {}
    readonly displayName = 'wedged';
    readonly capabilities = externalCapabilities;
    get discoveryBudgetMs(): number {
      return this.budgetMs;
    }
    async isAvailable(options?: AvailabilityOptions): Promise<boolean> {
      this.sawSignal = options?.signal !== undefined;
      return await new Promise<boolean>((resolve) => {
        if (!this.cooperative) return; // never settles, by construction
        options?.signal?.addEventListener('abort', () => {
          this.aborted = true;
          resolve(false);
        }, { once: true });
      });
    }
    async discoverSessions(_options?: SessionDiscoveryOptions): Promise<SessionInfo[]> {
      return [];
    }
    async attach(): Promise<never> {
      throw new Error('not reachable in this fixture');
    }
  }

  const cooperative = new WedgedHostBackend('wedged-cooperative', 25, true);
  const cooperativeRegistry = new AgentRegistry();
  cooperativeRegistry.register(new SettledBackend('established'));
  cooperativeRegistry.register(cooperative);
  // No timing assertion, deliberately: the wedged leg has NO other way to
  // settle, so `discoverAll` resolving at all is the proof. Under the old
  // unbounded `Promise.all` this line never returns and the suite times out.
  const cooperativeRows = await cooperativeRegistry.discoverAll();
  check(
    'a wedged external host is abandoned at its budget and cannot withhold an established agent',
    cooperativeRows.map((row) => row.id).join(',') === 'established-session',
    JSON.stringify(cooperativeRows.map((row) => row.id)),
  );
  check(
    'the abandoned leg is CANCELLED, not merely ignored',
    cooperative.sawSignal && cooperative.aborted,
    `sawSignal=${cooperative.sawSignal} aborted=${cooperative.aborted}`,
  );

  const uncooperative = new WedgedHostBackend('wedged-uncooperative', 25, false);
  const uncooperativeRegistry = new AgentRegistry();
  uncooperativeRegistry.register(new SettledBackend('established'));
  uncooperativeRegistry.register(uncooperative);
  const uncooperativeRows = await uncooperativeRegistry.discoverAll();
  check(
    'a backend that IGNORES its abort still delays nothing',
    uncooperativeRows.map((row) => row.id).join(',') === 'established-session',
    JSON.stringify(uncooperativeRows.map((row) => row.id)),
  );

  // The budget is a ceiling on the WAIT, never a cutoff applied to work that
  // finished inside it: a healthy host's rows must survive it untouched.
  class PromptHostBackend extends SettledBackend {
    readonly discoveryBudgetMs = EXTERNAL_HOST_DISCOVERY_BUDGET_MS;
  }
  const healthyRegistry = new AgentRegistry();
  healthyRegistry.register(new PromptHostBackend('prompt-host'));
  const healthyRows = await healthyRegistry.discoverAll();
  check(
    'a budgeted backend that answers inside its budget keeps every row',
    healthyRows.map((row) => row.id).join(',') === 'prompt-host-session',
    JSON.stringify(healthyRows.map((row) => row.id)),
  );

  // ── The bound's cost must be REPORTED, not inferred ────────────────────────
  //
  // An abandoned leg returns `[]`, indistinguishable from an adapter with no
  // sessions. That silence, not the truncation, is what makes this expensive to
  // diagnose: a roster missing every session of one adapter reads as an adapter
  // that had nothing. The report has to be honest in both directions, so the
  // false-positive cases are tested next to the true one.
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const abandonedOf = (work: SessionDiscoveryWork[]) =>
    work.filter((event): event is Extract<SessionDiscoveryWork, { kind: 'leg-abandoned' }> =>
      event.kind === 'leg-abandoned');
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]): void => {
    warnings.push(args.map((arg) => String(arg)).join(' '));
  };
  try {
    {
      const work: SessionDiscoveryWork[] = [];
      const registry = new AgentRegistry();
      registry.register(new SettledBackend('established'));
      registry.register(new WedgedHostBackend('wedged-reported', 25, false));
      const rows = await registry.discoverAll({ onWork: (event) => work.push(event) });
      const events = abandonedOf(work);
      check(
        'an abandoned leg is reported, naming the backend whose sessions the roster lost',
        events.length === 1 &&
          events[0]?.backendId === 'wedged-reported' &&
          events[0]?.budgetMs === 25 &&
          typeof events[0]?.elapsedMs === 'number' &&
          events[0].elapsedMs >= 25 &&
          rows.map((row) => row.id).join(',') === 'established-session',
        JSON.stringify({ events, rows: rows.map((row) => row.id) }),
      );
      check(
        'the abandonment also reaches the operator log, saying the sessions are ABSENT',
        warnings.some((line) =>
          line.includes('wedged-reported') &&
          line.includes('25ms budget') &&
          line.includes('absent from this roster sweep')),
        JSON.stringify(warnings),
      );
    }

    // The listener that reports this outlives the race, so the expiry still
    // fires after a leg that already answered. Reporting THAT would mark every
    // healthy budgeted adapter as broken once per sweep — noise that would get
    // the message ignored, which is the state this whole change exists to end.
    {
      class BriefBudgetBackend extends SettledBackend {
        readonly discoveryBudgetMs = 25;
      }
      const work: SessionDiscoveryWork[] = [];
      const registry = new AgentRegistry();
      registry.register(new BriefBudgetBackend('prompt-brief'));
      const before = warnings.length;
      const rows = await registry.discoverAll({ onWork: (event) => work.push(event) });
      await sleep(4 * 25); // outlive the budget with the leg long since answered
      check(
        'a leg that ANSWERED inside its budget is never reported as abandoned, even after the budget passes',
        abandonedOf(work).length === 0 &&
          warnings.length === before &&
          rows.map((row) => row.id).join(',') === 'prompt-brief-session',
        JSON.stringify({ work, added: warnings.slice(before), rows: rows.map((row) => row.id) }),
      );
    }

    // ── Abandonment must not be DESTRUCTIVE ──────────────────────────────────
    //
    // The rows a leg finished before the budget fired are already in hand.
    // Discarding them is the worst available answer, and for the adapter this
    // was measured on it is the difference between most of its sessions and
    // none of them.
    {
      /** Reports rows as they finish, then never returns — abandoned mid-map. */
      class PartialThenWedgedBackend implements AgentBackend {
        constructor(readonly id: string, readonly finished: number) {}
        readonly displayName = 'partial';
        readonly capabilities = externalCapabilities;
        readonly discoveryBudgetMs = 25;
        async isAvailable(): Promise<boolean> {
          return true;
        }
        async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionInfo[]> {
          for (let index = 0; index < this.finished; index += 1) {
            options?.onPartialRows?.([{
              id: `${this.id}-${index}`,
              tool: this.id,
              title: `row ${index}`,
              status: 'idle',
              attachMode: 'live',
            }]);
          }
          // A malformed row must not ride in on the salvage path.
          options?.onPartialRows?.([{ id: '', tool: '' } as unknown as SessionInfo]);
          // Nor a row filed under ANOTHER backend's tool. Salvaged rows reach
          // the sweep's return value without ever passing the completed-leg
          // check, so the partition has to hold here on its own; otherwise the
          // next per-leg merge for 'established' deletes rows this leg invented
          // for it.
          options?.onPartialRows?.([{
            id: 'stolen', tool: 'established', title: 'filed under established',
            status: 'idle', attachMode: 'live',
          }]);
          return await new Promise<SessionInfo[]>(() => {}); // never settles
        }
        async attach(): Promise<never> {
          throw new Error('not reachable in this fixture');
        }
      }
      const work: SessionDiscoveryWork[] = [];
      const observed: SessionInfo[] = [];
      const registry = new AgentRegistry();
      registry.register(new SettledBackend('established'));
      registry.register(new PartialThenWedgedBackend('partial-wedged', 4));
      const rows = await registry.discoverAll({
        onWork: (event) => work.push(event),
        onPartialRows: (partial) => observed.push(...partial),
      });
      const kept = rows.filter((row) => row.tool === 'partial-wedged').map((row) => row.id);
      const events = abandonedOf(work);
      check(
        'rows the abandoned leg had already finished SURVIVE instead of being discarded',
        kept.join(',') === 'partial-wedged-0,partial-wedged-1,partial-wedged-2,partial-wedged-3' &&
          rows.some((row) => row.id === 'established-session'),
        JSON.stringify({ kept, all: rows.map((row) => row.id) }),
      );
      check(
        'but a salvaged row filed under another backend\'s tool is withheld',
        !rows.some((row) => row.id === 'stolen'),
        JSON.stringify(rows.filter((row) => row.tool === 'established').map((row) => row.id)),
      );
      // The caller's own partial-row hook must see the SAME withholding. It
      // used to receive the original batch, so a row the roster refused was
      // still handed to an observer as if it had been accepted.
      check(
        'and the caller\'s partial-row callback never sees a withheld row either',
        observed.length === 4 && observed.every((row) => row.tool === 'partial-wedged')
          && !observed.some((row) => row.id === 'stolen' || row.id === ''),
        JSON.stringify(observed.map((row) => `${row.tool}:${row.id}`)),
      );
      check(
        'the report states how many rows survived, so a partial roster is not read as a whole one',
        events.length === 1 && events[0]?.salvagedRows === 4 &&
          // The count the roster actually KEEPS, which is what a reader needs.
          // This backend has no previous successful sweep to carry from, so the
          // kept total is the salvaged total; the carrying case is asserted
          // separately below.
          warnings.some((line) =>
            line.includes('partial-wedged')
              && line.includes('4 mapped this sweep')
              && line.includes('keeps 4 partial-wedged session(s)')),
        JSON.stringify({ events, warnings: warnings.slice(-2) }),
      );
      check(
        'a MALFORMED partial row is withheld — salvage is not a way around validation',
        !kept.includes('') && kept.length === 4 &&
          warnings.some((line) => line.includes('malformed partial discovery row')),
        JSON.stringify({ kept }),
      );
    }

    // Opt-in means opt-in: an adapter that reports nothing must behave exactly
    // as it did before this existed, or the change is not additive.
    {
      const work: SessionDiscoveryWork[] = [];
      const registry = new AgentRegistry();
      registry.register(new SettledBackend('established'));
      registry.register(new WedgedHostBackend('wedged-silent', 25, false));
      const rows = await registry.discoverAll({ onWork: (event) => work.push(event) });
      check(
        'an adapter that reports no partial rows still contributes none, and says so',
        rows.map((row) => row.id).join(',') === 'established-session' &&
          abandonedOf(work)[0]?.salvagedRows === 0 &&
          warnings.some((line) =>
            line.includes('wedged-silent') && line.includes('EVERY wedged-silent session is absent')),
        JSON.stringify({ rows: rows.map((row) => row.id), work }),
      );
    }

    // A caller that cancels the sweep aborted this leg on purpose. It is the
    // same abort, on the same signal, and it is not a budget overrun.
    {
      const work: SessionDiscoveryWork[] = [];
      const registry = new AgentRegistry();
      registry.register(new WedgedHostBackend('wedged-caller-cancelled', 5_000, true));
      const controller = new AbortController();
      const before = warnings.length;
      setTimeout(() => controller.abort(), 20);
      const rows = await registry.discoverAll({
        signal: controller.signal,
        onWork: (event) => work.push(event),
      });
      check(
        'a sweep the CALLER cancelled is not reported as a budget overrun',
        abandonedOf(work).length === 0 && warnings.length === before && rows.length === 0,
        JSON.stringify({ work, added: warnings.slice(before), rows: rows.length }),
      );
    }
  } finally {
    console.warn = realWarn;
  }


  // ── Discovery is SERIAL and yields to unrelated broker work ────────────────
  //
  // The cap of six improved an isolated throughput benchmark but failed in the
  // real broker: six promise continuations together kept health/status behind a
  // 36-48s cohort. Production runs one leg at a time and takes a macrotask turn
  // before each one. Registration order and eventual reconciliation stay the
  // same; only overlap changes.
  {
    let inFlight = 0;
    let peak = 0;
    class CountingBackend extends SettledBackend {
      override async discoverSessions(): Promise<SessionInfo[]> {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 15));
        inFlight -= 1;
        return [{
          id: `${this.id}-session`,
          tool: this.id,
          title: 'counted',
          status: 'idle',
          attachMode: 'live',
        }];
      }
    }
    const registry = new AgentRegistry();
    const ids = Array.from({ length: 20 }, (_, index) => `counted-${String(index).padStart(2, '0')}`);
    for (const id of ids) registry.register(new CountingBackend(id));
    const rows = await registry.discoverAll();
    check(
      'production discovery runs one leg at a time',
      DISCOVERY_FAN_OUT_LIMIT === 1 && peak === 1,
      `peak=${peak} limit=${DISCOVERY_FAN_OUT_LIMIT}`,
    );
    check(
      'every backend still runs, and the roster keeps registration order',
      rows.length === ids.length
        && rows.map((row) => row.tool).join(',') === ids.join(','),
      `rows=${rows.length}/${ids.length}`,
    );
  }

  // Production has several cached windows, each of which may start its own
  // `discoverAll()` while another is still running. Per-sweep serialisation is
  // insufficient: those calls otherwise overlap on the same registry and
  // recreate the cohort that starved the broker in the installed product.
  {
    let inFlight = 0;
    let peak = 0;
    class CrossWindowBackend extends SettledBackend {
      override async discoverSessions(): Promise<SessionInfo[]> {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30));
        inFlight -= 1;
        return super.discoverSessions();
      }
    }
    const registry = new AgentRegistry();
    for (const id of ['cross-window-a', 'cross-window-b', 'cross-window-c']) {
      registry.register(new CrossWindowBackend(id));
    }
    const [sevenDays, allTime] = await Promise.all([
      registry.discoverAll({ scopeKey: '7d', sweepBudgetMs: 140 }),
      registry.discoverAll({ scopeKey: 'all', sweepBudgetMs: 140 }),
    ]);
    check(
      'concurrent roster windows own one full production sweep without spending each other\'s budget',
      peak === 1 && sevenDays.length === 3 && allTime.length === 3,
      `peak=${peak} rows=${sevenDays.length}/${allTime.length}`,
    );
  }

  // A real lightweight HTTP endpoint on the SAME event loop. Each fake leg
  // performs a modest synchronous projection, matching the shape of native
  // snapshot decode/validation. Six of them queued together miss the deadline;
  // a macrotask turn between serial legs lets the endpoint answer immediately.
  {
    class CpuProjectionBackend extends SettledBackend {
      override async discoverSessions(): Promise<SessionInfo[]> {
        const until = performance.now() + 50;
        while (performance.now() < until) { /* deliberate synchronous projection */ }
        return super.discoverSessions();
      }
    }
    const registry = new AgentRegistry();
    for (let index = 0; index < 8; index += 1) {
      registry.register(new CpuProjectionBackend(`projection-${index}`));
    }
    const health = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => Response.json({ ok: true }),
    });
    try {
      const intendedAt = performance.now();
      const lightweight = new Promise<number>((resolve, reject) => {
        setTimeout(() => {
          void fetch(`http://127.0.0.1:${health.port}/api/health`)
            .then((response) => {
              if (!response.ok) throw new Error(`health status ${response.status}`);
              resolve(performance.now() - intendedAt);
            }, reject);
        }, 5);
      });
      const sweep = registry.discoverAll();
      const [healthElapsed, rows] = await Promise.all([lightweight, sweep]);
      check(
        'a large sweep cannot make a lightweight broker endpoint miss its normal deadline',
        healthElapsed < 200 && rows.length === 8,
        `health=${healthElapsed.toFixed(1)}ms rows=${rows.length}`,
      );
    } finally {
      health.stop(true);
    }
  }

  // Per-leg ceilings cannot bind an adapter that deliberately has none. The
  // whole-sweep ceiling must abandon that leg, carry its last confirmed row,
  // and say the result is unconfirmed rather than silently completing it.
  {
    class WholeSweepBackend extends SettledBackend {
      wedged = false;
      override async discoverSessions(): Promise<SessionInfo[]> {
        if (!this.wedged) return super.discoverSessions();
        return new Promise<SessionInfo[]>(() => {});
      }
    }
    class TrailingBackend extends SettledBackend {
      calls = 0;
      override async discoverSessions(): Promise<SessionInfo[]> {
        this.calls += 1;
        return super.discoverSessions();
      }
    }
    const backend = new WholeSweepBackend('whole-sweep');
    const trailing = new TrailingBackend('trailing');
    const registry = new AgentRegistry();
    registry.register(backend);
    registry.register(trailing);
    await registry.discoverAll({ scopeKey: '7d' });
    trailing.calls = 0;
    backend.wedged = true;
    const work: SessionDiscoveryWork[] = [];
    const startedAt = Date.now();
    const rows = await registry.discoverAll({
      scopeKey: '7d',
      sweepBudgetMs: 60,
      onWork: (event) => work.push(event),
    });
    const abandoned = work.find(
      (event): event is Extract<SessionDiscoveryWork, { kind: 'leg-abandoned' }> =>
        event.kind === 'leg-abandoned',
    );
    const elapsed = Date.now() - startedAt;
    check(
      'the whole-sweep wall-clock ceiling abandons an unbudgeted wedged leg',
      elapsed < 250 && abandoned?.backendId === 'whole-sweep'
        && abandoned.budgetKind === 'sweep' && abandoned.budgetMs === 60,
      JSON.stringify({ elapsed, abandoned }),
    );
    check(
      'a whole-sweep abandonment carries bounded prior rows but remains unconfirmed',
      rows.map((row) => row.id).join(',') === 'whole-sweep-session,trailing-session'
        && work.some((event) => event.kind === 'leg-elapsed' && event.abandoned),
      JSON.stringify({ rows: rows.map((row) => row.id), work }),
    );
    check(
      'the expired sweep does not invoke later adapters before abandoning their lanes',
      trailing.calls === 0
        && work.some((event) => event.kind === 'leg-abandoned'
          && event.backendId === 'trailing' && event.budgetKind === 'sweep'),
      JSON.stringify({ calls: trailing.calls, work }),
    );
    const nextWork: SessionDiscoveryWork[] = [];
    const nextRows = await registry.discoverAll({
      scopeKey: '7d',
      sweepBudgetMs: 60,
      onWork: (event) => nextWork.push(event),
    });
    check(
      'the sweep after an aggregate expiry gives the denied trailing adapter a turn',
      trailing.calls === 1
        && nextRows.some((row) => row.id === 'trailing-session')
        && nextWork.some((event) => event.kind === 'leg-elapsed'
          && event.backendId === 'trailing' && !event.abandoned),
      JSON.stringify({ calls: trailing.calls, rows: nextRows.map((row) => row.id), work: nextWork }),
    );
  }

  // A DECLARED budget that is not a usable number must not read as "no budget".
  // That is the fail-open direction on the one code path whose whole reason to
  // exist is that the work behind it can hang, so every unusable value falls
  // back to the standard budget instead.
  check(
    'a declared-but-unusable discovery budget falls back to the standard one, never to unbounded',
    [0, -1, Number.NaN, Number.POSITIVE_INFINITY, -0]
      .every((value) => effectiveDiscoveryBudgetMs(value) === EXTERNAL_HOST_DISCOVERY_BUDGET_MS),
    JSON.stringify([0, -1, 'NaN', 'Infinity'].map((value) => effectiveDiscoveryBudgetMs(Number(value)))),
  );
  check(
    'a usable declared budget is honoured exactly, and an absent one still means no budget',
    effectiveDiscoveryBudgetMs(25) === 25 && effectiveDiscoveryBudgetMs(undefined) === undefined,
    `${effectiveDiscoveryBudgetMs(25)}/${effectiveDiscoveryBudgetMs(undefined)}`,
  );
  {
    // ...and end to end: a wedged host declaring a broken budget still cannot
    // hold the roster. Under a fail-open reading this line never returns.
    const broken = new WedgedHostBackend('wedged-broken-budget', 0, true);
    const brokenRegistry = new AgentRegistry();
    brokenRegistry.register(new SettledBackend('established'));
    brokenRegistry.register(broken);
    const rows = await brokenRegistry.discoverAll();
    check(
      'a wedged host that declares a broken budget is still abandoned, not waited on forever',
      rows.map((row) => row.id).join(',') === 'established-session' && broken.aborted,
      JSON.stringify({ rows: rows.map((row) => row.id), aborted: broken.aborted }),
    );
  }

  // An abandoned leg must not DELETE a healthy adapter's sessions. The budget is
  // wall-clock, so load trips it on adapters that are not at fault; publishing
  // "this adapter has no sessions" because the host was busy is the only
  // user-visible harm abandonment causes.
  {
    class FlakyBackend implements AgentBackend {
      calls = 0;
      constructor(readonly id: string) {}
      readonly displayName = 'flaky';
      readonly capabilities = externalCapabilities;
      readonly discoveryBudgetMs = 40;
      async isAvailable(): Promise<boolean> {
        return true;
      }
      async discoverSessions(): Promise<SessionInfo[]> {
        this.calls += 1;
        // 1: answers. 2: wedges. 3: answers EMPTY. 4: wedges again.
        if (this.calls === 1) {
          return [{
            id: 'flaky-1', tool: this.id, title: 'kept', status: 'idle', attachMode: 'live',
          }];
        }
        if (this.calls === 3) return [];
        return await new Promise<SessionInfo[]>(() => {}); // never settles
      }
      async attach(): Promise<never> {
        throw new Error('not reachable in this fixture');
      }
    }
    const registry = new AgentRegistry();
    registry.register(new FlakyBackend('flaky'));
    const answered = await registry.discoverAll();
    const carriedWork: SessionDiscoveryWork[] = [];
    const carried = await registry.discoverAll({ onWork: (event) => carriedWork.push(event) });
    check(
      'an abandoned leg carries the rows its last successful sweep returned',
      answered.map((row) => row.id).join(',') === 'flaky-1'
        && carried.map((row) => row.id).join(',') === 'flaky-1'
        && abandonedOf(carriedWork).length === 1,
      JSON.stringify({
        answered: answered.map((row) => row.id), carried: carried.map((row) => row.id),
      }),
    );
    // An adapter whose sessions are genuinely gone must be able to SAY so, or
    // carrying would outlive the thing it covers for and the roster would show
    // sessions that no longer exist for as long as the host stayed slow.
    const emptied = await registry.discoverAll();
    const afterEmpty = await registry.discoverAll();
    check(
      'a leg that ANSWERS with nothing replaces the memory, so carrying cannot resurrect it',
      emptied.length === 0 && afterEmpty.length === 0,
      JSON.stringify({ emptied: emptied.length, afterEmpty: afterEmpty.length }),
    );
  }

  // A CALLER-cancelled leg is not an answer, and must not become the memory a
  // later genuine overrun carries forward. Reported by adversarial review.
  {
    class CancelWedgedBackend implements AgentBackend {
      calls = 0;
      constructor(readonly id: string) {}
      readonly displayName = 'cancel-wedged';
      readonly capabilities = externalCapabilities;
      readonly discoveryBudgetMs = 10_000;
      async isAvailable(): Promise<boolean> {
        return true;
      }
      async discoverSessions(): Promise<SessionInfo[]> {
        this.calls += 1;
        if (this.calls === 1) {
          return [{
            id: 'cancel-1', tool: this.id, title: 'kept', status: 'idle', attachMode: 'live',
          }];
        }
        return await new Promise<SessionInfo[]>(() => {}); // never settles
      }
      async attach(): Promise<never> {
        throw new Error('not reachable in this fixture');
      }
    }
    const registry = new AgentRegistry();
    registry.register(new CancelWedgedBackend('cancel-wedged'));
    await registry.discoverAll();
    // Caller cancels — NOT the registry's own budget, which is 10s away.
    const canceller = new AbortController();
    const cancelled = registry.discoverAll({ signal: canceller.signal });
    canceller.abort();
    const cancelledRows = await cancelled;
    // Now a genuine overrun: it must still carry the FIRST sweep's rows.
    const afterCancel = await registry.discoverAll();
    check(
      'a caller-cancelled leg does not overwrite the memory a later overrun carries',
      cancelledRows.length === 0 && afterCancel.map((row) => row.id).join(',') === 'cancel-1',
      JSON.stringify({
        cancelled: cancelledRows.map((row) => row.id),
        afterCancel: afterCancel.map((row) => row.id),
      }),
    );
  }

  // A cancellation is the CALLER's decision, not a defect. Reporting it as a
  // failed leg trains the reader to ignore the one message that names a real
  // outage, and — the part that is not cosmetic — it spends one of the five
  // consecutive carries a genuine outage is allowed. Reported by adversarial
  // review, which measured a genuine failure going uncarried on the fifth try
  // after a single cancellation.
  {
    class CancelCountingBackend implements AgentBackend {
      calls = 0;
      constructor(readonly id: string) {}
      readonly displayName = 'cancel-counting';
      readonly capabilities = externalCapabilities;
      // UNBUDGETED on purpose. A budgeted leg resolves a caller cancel through
      // the abandon promise, which carries no failure and so never reached the
      // reporting branch; the unbudgeted path has no such promise and hands the
      // cancellation string straight to it.
      readonly discoveryBudgetMs = undefined;
      async isAvailable(): Promise<boolean> {
        return true;
      }
      entered?: () => void;
      async discoverSessions(options?: { signal?: AbortSignal }): Promise<SessionInfo[]> {
        this.calls += 1;
        if (this.calls === 1) {
          return [{ id: 'kept-1', tool: this.id, title: 'kept', status: 'idle', attachMode: 'live' }];
        }
        if (this.calls === 2) {
          // Cancelled by the caller: announce that the leg is genuinely running
          // — aborting before that and the sweep never reaches the resolution
          // this case is about — then wedge until the signal fires and throw the
          // way an abort-aware adapter does.
          this.entered?.();
          await new Promise<void>((resolve) => {
            options?.signal?.addEventListener('abort', () => { resolve(); }, { once: true });
          });
          throw new Error('aborted');
        }
        throw new Error('host refused');
      }
      async attach(): Promise<never> {
        throw new Error('not reachable in this fixture');
      }
    }
    const registry = new AgentRegistry();
    const backend = new CancelCountingBackend('cancel-counting');
    registry.register(backend);
    await registry.discoverAll();
    const events: Array<Record<string, unknown>> = [];
    const canceller = new AbortController();
    const running = new Promise<void>((resolve) => { backend.entered = resolve; });
    const cancelling = registry.discoverAll({
      signal: canceller.signal,
      onWork: (event) => events.push(event as unknown as Record<string, unknown>),
    });
    await running;
    canceller.abort();
    await cancelling;
    const cancelReported = events.some((event) => event.kind === 'leg-failed');
    // Five genuine failures must still each carry; the cancellation above must
    // not have spent one of them.
    const carried: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      carried.push((await registry.discoverAll()).length);
    }
    check(
      'a caller cancellation is not reported as a failed leg and does not spend a carry',
      !cancelReported && carried.join(',') === '1,1,1,1,1',
      JSON.stringify({ cancelReported, carried, events: events.map((event) => event.kind) }),
    );
  }

  // The carry must not admit a row the ADAPTER would have filtered out: kilo
  // excludes on `updatedAt ?? createdAt`, so a row carrying only `createdAt`
  // belongs to the window its creation time puts it in. Reported by review.
  {
    class StampedBackend implements AgentBackend {
      calls = 0;
      constructor(readonly id: string, private readonly rows: SessionInfo[]) {}
      readonly displayName = 'stamped';
      readonly capabilities = externalCapabilities;
      readonly discoveryBudgetMs = 40;
      async isAvailable(): Promise<boolean> {
        return true;
      }
      async discoverSessions(): Promise<SessionInfo[]> {
        this.calls += 1;
        if (this.calls === 1) return this.rows;
        return await new Promise<SessionInfo[]>(() => {}); // never settles
      }
      async attach(): Promise<never> {
        throw new Error('not reachable in this fixture');
      }
    }
    const nowMs = Date.now();
    const registry = new AgentRegistry();
    registry.register(new StampedBackend('stamped', [
      // created long ago, never updated — exactly kilo's live-row shape
      { id: 'old-created-only', tool: 'stamped', title: 'old', status: 'idle',
        attachMode: 'live', createdAt: nowMs - 200 * 86_400_000 },
      { id: 'recent', tool: 'stamped', title: 'recent', status: 'idle',
        attachMode: 'live', updatedAt: nowMs - 60_000 },
    ]));
    await registry.discoverAll();
    const narrow = await registry.discoverAll({ updatedAfter: nowMs - 86_400_000 });
    check(
      'a carried row is filtered by `updatedAt ?? createdAt`, so it cannot enter a window it predates',
      narrow.map((row) => row.id).join(',') === 'recent',
      JSON.stringify({ narrow: narrow.map((row) => row.id) }),
    );
  }

  // ... and the OTHER direction must not carry at all. One memory serves every
  // window because the broker sweeps each window key concurrently against the
  // same registry, so a successful narrow leg is the last thing a wide leg
  // remembers. Replaying it answers "all time" with a 1-day roster, and since
  // the carry is the sweep's RETURN value the runtime writes that into the
  // all-time cache with a fresh `at` and reconciles it -- deleting every older
  // session from every client. Filtering cannot save this case: the rows the
  // narrow sweep never read are not there to filter.
  {
    class WindowedBackend implements AgentBackend {
      calls = 0;
      constructor(readonly id: string, private readonly rows: SessionInfo[]) {}
      readonly displayName = 'windowed';
      readonly capabilities = externalCapabilities;
      readonly discoveryBudgetMs = 40;
      async isAvailable(): Promise<boolean> {
        return true;
      }
      async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionInfo[]> {
        this.calls += 1;
        if (this.calls === 1) {
          const cutoff = options?.updatedAfter;
          return cutoff === undefined
            ? this.rows
            : this.rows.filter((row) => (row.updatedAt ?? row.createdAt ?? 0) >= cutoff);
        }
        return await new Promise<SessionInfo[]>(() => {}); // never settles
      }
      async attach(): Promise<never> {
        throw new Error('not reachable in this fixture');
      }
    }
    const nowMs = Date.now();
    const registry = new AgentRegistry();
    registry.register(new WindowedBackend('windowed', [
      { id: 'ancient', tool: 'windowed', title: 'ancient', status: 'idle',
        attachMode: 'live', updatedAt: nowMs - 200 * 86_400_000 },
      { id: 'recent', tool: 'windowed', title: 'recent', status: 'idle',
        attachMode: 'live', updatedAt: nowMs - 60_000 },
    ]));
    // A successful NARROW sweep is what the memory now holds.
    const narrowFirst = await registry.discoverAll({ updatedAfter: nowMs - 86_400_000 });
    // The wide sweep is abandoned, so it reaches for that memory.
    const wide = await registry.discoverAll();
    check(
      'a narrow memory is NOT carried into a wider sweep, which would delete every older session',
      narrowFirst.map((row) => row.id).join(',') === 'recent' && wide.length === 0,
      JSON.stringify({ narrowFirst: narrowFirst.map((row) => row.id), wide: wide.map((row) => row.id) }),
    );
  }

  // The sequence that matters in production: the wide scope ALREADY has a good
  // answer when the narrow sweep succeeds. One memory per backend made the
  // narrow success overwrite it, and the abandoned wide leg then carried a
  // 1-day roster as the all-time one -- or, once that was refused on the
  // cutoff, carried nothing and deleted the lane outright, which is worse. The
  // memory is scoped, so each window keeps its own last good answer.
  {
    class ScopedBackend implements AgentBackend {
      calls = 0;
      constructor(readonly id: string, private readonly rows: SessionInfo[]) {}
      readonly displayName = 'scoped';
      readonly capabilities = externalCapabilities;
      readonly discoveryBudgetMs = 40;
      async isAvailable(): Promise<boolean> {
        return true;
      }
      async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionInfo[]> {
        this.calls += 1;
        // Two real answers, then wedge: the third sweep is the abandoned one.
        if (this.calls <= 2) {
          const cut = options?.updatedAfter;
          return cut === undefined
            ? this.rows
            : this.rows.filter((row) => (row.updatedAt ?? row.createdAt ?? 0) >= cut);
        }
        return await new Promise<SessionInfo[]>(() => {}); // never settles
      }
      async attach(): Promise<never> {
        throw new Error('not reachable in this fixture');
      }
    }
    const nowMs = Date.now();
    const registry = new AgentRegistry();
    registry.register(new ScopedBackend('scoped', [
      { id: 'ancient', tool: 'scoped', title: 'ancient', status: 'idle',
        attachMode: 'live', updatedAt: nowMs - 200 * 86_400_000 },
      { id: 'recent', tool: 'scoped', title: 'recent', status: 'idle',
        attachMode: 'live', updatedAt: nowMs - 60_000 },
    ]));
    const wideGood = await registry.discoverAll({ scopeKey: 'all' });
    const narrowGood = await registry.discoverAll({
      scopeKey: '604800000', updatedAfter: nowMs - 86_400_000,
    });
    const wideAbandoned = await registry.discoverAll({ scopeKey: 'all' });
    check(
      'a successful NARROW sweep does not evict the wide scope\'s last good answer',
      wideGood.map((row) => row.id).join(',') === 'ancient,recent'
        && narrowGood.map((row) => row.id).join(',') === 'recent'
        && wideAbandoned.map((row) => row.id).join(',') === 'ancient,recent',
      JSON.stringify({
        wideGood: wideGood.map((row) => row.id),
        narrowGood: narrowGood.map((row) => row.id),
        wideAbandoned: wideAbandoned.map((row) => row.id),
      }),
    );
  }

  // THE CAP'S UPPER BOUND, which nothing asserted before: a backend nobody can
  // reach stops being advertised after ABANDONED_LEG_CARRY_SWEEPS carries. The
  // whole point of the cap is that the roster eventually stops promising
  // sessions it has not confirmed, and until this test a change that disabled
  // it entirely would have gone through green.
  {
    class WedgedAfterOneBackend implements AgentBackend {
      calls = 0;
      readonly id = 'wedged-cap';
      readonly displayName = 'wedged';
      readonly capabilities = externalCapabilities;
      readonly discoveryBudgetMs = 25;
      async isAvailable(): Promise<boolean> {
        return true;
      }
      async discoverSessions(): Promise<SessionInfo[]> {
        this.calls += 1;
        if (this.calls === 1) {
          return [{
            id: 'only', tool: 'wedged-cap', title: 'only',
            status: 'idle', attachMode: 'live',
          }];
        }
        return await new Promise<SessionInfo[]>(() => {}); // never settles again
      }
      async attach(): Promise<never> {
        throw new Error('not reachable in this fixture');
      }
    }
    const registry = new AgentRegistry();
    registry.register(new WedgedAfterOneBackend());
    const seen: number[] = [];
    for (let sweep = 0; sweep < ABANDONED_LEG_CARRY_SWEEPS + 3; sweep += 1) {
      seen.push((await registry.discoverAll()).length);
    }
    const carriesServed = seen.slice(1).filter((count) => count > 0).length;
    check(
      'a backend nobody can reach stops being carried after the cap, and stays stopped',
      seen[0] === 1
        && carriesServed === ABANDONED_LEG_CARRY_SWEEPS
        && seen.slice(1 + ABANDONED_LEG_CARRY_SWEEPS).every((count) => count === 0),
      JSON.stringify({ seen, cap: ABANDONED_LEG_CARRY_SWEEPS }),
    );
  }

  // ... but the cap must not blank a lane while the SAME backend is answering
  // for another window. The cap counts sweeps spent serving rows nobody has
  // re-confirmed; rows borrowed from a scope that succeeded after the run began
  // are confirmed, this sweep. Without the reset the narrow lane emptied on the
  // sixth sweep and stayed empty until it next succeeded -- never, for a wedged
  // leg -- with fresh rows for that backend sitting in the wide scope.
  {
    class OneScopeHealthyBackend implements AgentBackend {
      readonly id = 'half-wedged';
      readonly displayName = 'half-wedged';
      readonly capabilities = externalCapabilities;
      readonly discoveryBudgetMs = 25;
      async isAvailable(): Promise<boolean> {
        return true;
      }
      async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionInfo[]> {
        if (options?.scopeKey === 'all') {
          return [{
            id: 'live', tool: 'half-wedged', title: 'live', status: 'idle',
            attachMode: 'live', updatedAt: Date.now(),
          }];
        }
        return await new Promise<SessionInfo[]>(() => {}); // only the narrow leg wedges
      }
      async attach(): Promise<never> {
        throw new Error('not reachable in this fixture');
      }
    }
    const registry = new AgentRegistry();
    registry.register(new OneScopeHealthyBackend());
    const narrowRows: number[] = [];
    for (let sweep = 0; sweep < ABANDONED_LEG_CARRY_SWEEPS + 4; sweep += 1) {
      await registry.discoverAll({ scopeKey: 'all' });
      narrowRows.push((await registry.discoverAll({
        scopeKey: '86400000', updatedAfter: Date.now() - 86_400_000,
      })).length);
    }
    check(
      'a scope whose lender keeps succeeding is never blanked by the carry cap',
      narrowRows.every((count) => count === 1),
      JSON.stringify({ narrowRows, cap: ABANDONED_LEG_CARRY_SWEEPS }),
    );
  }

  // Every leg reports what it cost, not only the ones that overran. Without
  // this a slow sweep is one opaque number, which is how an adapter that
  // answers in ~140ms on its own came to look like the cause of a 5000ms
  // overrun. Both paths report: SettledBackend declares no budget (the
  // unbudgeted return), the wedged one does (after the race).
  {
    const elapsedRegistry = new AgentRegistry();
    // Uncooperative, so the leg NEVER settles and `abandoned` is decided by the
    // budget rather than by a race between two abort handlers.
    const wedged = new WedgedHostBackend('wedged-elapsed', 50, false);
    elapsedRegistry.register(new SettledBackend('elapsed-local'));
    elapsedRegistry.register(wedged);
    const seen: Extract<SessionDiscoveryWork, { kind: 'leg-elapsed' }>[] = [];
    await elapsedRegistry.discoverAll({
      onWork: (work) => {
        if (work.kind === 'leg-elapsed') seen.push(work);
      },
    });
    const local = seen.find((leg) => leg.backendId === 'elapsed-local');
    const overrun = seen.find((leg) => leg.backendId === 'wedged-elapsed');
    check(
      'every leg reports what it cost, whether or not it declares a budget',
      seen.length === 2
        && local?.abandoned === false && local?.rows === 1
        && overrun?.abandoned === true && overrun?.rows === 0,
      JSON.stringify(seen),
    );
    check(
      'an overrun leg reports the wait the sweep actually took, not zero',
      (overrun?.elapsedMs ?? -1) >= 40,
      JSON.stringify(seen.map((leg) => [leg.backendId, leg.elapsedMs])),
    );
    // Production serialisation makes each elapsed number attributable: no leg
    // inherits the wait caused by a sibling sharing its event loop.
    check(
      'production leg timing reports no sibling overlap',
      local?.concurrentPeak === 1 && overrun?.concurrentPeak === 1,
      JSON.stringify(seen.map((leg) => [leg.backendId, leg.concurrentPeak])),
    );
  }

  // One leg and nothing to share the loop with: `concurrentPeak` must be 1,
  // which is the only case where `elapsedMs` IS that adapter's own cost.
  {
    const soloRegistry = new AgentRegistry();
    soloRegistry.register(new SettledBackend('solo-local'));
    const soloSeen: Extract<SessionDiscoveryWork, { kind: 'leg-elapsed' }>[] = [];
    await soloRegistry.discoverAll({
      onWork: (work) => {
        if (work.kind === 'leg-elapsed') soloSeen.push(work);
      },
    });
    check(
      'a leg that ran alone reports concurrentPeak 1',
      soloSeen.length === 1 && soloSeen[0]?.concurrentPeak === 1,
      JSON.stringify(soloSeen.map((leg) => [leg.backendId, leg.concurrentPeak])),
    );
  }

  // Which adapters carry the budget, asserted against the shipped ones rather
  // than restated. External-host adapters need it; the local ones must NOT have
  // acquired it, because a budget on a filesystem read would be a deadline on
  // work that cannot hang and can only lose sessions.
  const { KimiAdapter } = await import('../../../adapters/kimi/src/index.ts');
  const { DshAdapter } = await import('../../../adapters/dsh/src/index.ts');
  const { ClineAdapter } = await import('../../../adapters/cline/src/index.ts');
  const { KiloAdapter } = await import('../../../adapters/kilocode/src/index.ts');
  // Read through the SPI, which is how the registry reads it — and, for the
  // local four, the only way it typechecks at all: the property is genuinely
  // absent from those classes rather than present and undefined.
  //
  // Every external-host adapter belongs here. This list stood at two while four
  // adapters declared the budget, so the two newest — the two whose hosts are
  // the most expensive to talk to — could have lost the bound without failing
  // anything. Add an adapter to this list when it starts talking to a host the
  // broker does not own.
  const external: AgentBackend[] = [
    new KimiAdapter(), new DshAdapter(), new ClineAdapter(), new KiloAdapter(),
  ];
  check(
    'every external-host adapter declares the shared discovery budget',
    external.every((adapter) => adapter.discoveryBudgetMs === EXTERNAL_HOST_DISCOVERY_BUDGET_MS),
    JSON.stringify(external.map((adapter) => [adapter.id, adapter.discoveryBudgetMs])),
  );
  const local: AgentBackend[] = [
    new CodexAdapter(), new ClaudeAdapter(), new PiAdapter(), new OpenCodeAdapter(),
  ];
  check(
    'the local adapters declare no budget, so their discovery is never cut short',
    local.every((adapter) => adapter.discoveryBudgetMs === undefined),
    JSON.stringify(local.map((adapter) => [adapter.id, adapter.discoveryBudgetMs])),
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

// PUBLICATION: a fast leg's rows must not wait for a slow one.
//
// `discoverAll` answers only when the LAST leg settles, so a fast adapter's rows
// sat unpublished behind a slow one. Measured
// in production as `omp=153ms/209r` inside a sweep that took `22641ms` because
// `reasonix=22631ms` was still running -- and a terminal-started session has no
// live owner to push it, so for those 22 seconds it did not exist as far as the
// roster was concerned.
{
  const caps: AgentCapabilities = {
    integrationKind: 'http-websocket',
    attachModes: ['live'],
    supportsObserve: false,
    supportsResume: false,
    supportsLiveAttach: true,
    supportsNativeArtifact: false,
    supportsNativeFileInput: false,
    supportsModelSwitch: false,
    permissionGranularity: 'none',
  };
  const row = (id: string): SessionInfo => ({
    id: `${id}-session`, tool: id, title: id, status: 'idle', attachMode: 'live',
  });
  class TimedBackend implements AgentBackend {
    constructor(readonly id: string, private readonly delayMs: number) {}
    readonly displayName = 'timed';
    readonly capabilities = caps;
    async isAvailable(): Promise<boolean> { return true; }
    async discoverSessions(): Promise<SessionInfo[]> {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      return [row(this.id)];
    }
    async attach(): Promise<never> { throw new Error('not reachable in this fixture'); }
  }

  const registry = new AgentRegistry();
  registry.register(new TimedBackend('fast', 5));
  registry.register(new TimedBackend('slow', 400));
  const seen: { backendId: string; at: number; rows: number }[] = [];
  const startedAt = Date.now();
  const sessions = await registry.discoverAll({
    onLegRows: (backendId, rows) => seen.push({ backendId, at: Date.now() - startedAt, rows: rows.length }),
  });
  const sweepMs = Date.now() - startedAt;
  const fast = seen.find((entry) => entry.backendId === 'fast');
  const slow = seen.find((entry) => entry.backendId === 'slow');

  check('every leg reports its rows', seen.length === 2 && fast?.rows === 1 && slow?.rows === 1,
    JSON.stringify(seen));
  check('the fast leg publishes long before the sweep answers',
    fast !== undefined && fast.at < sweepMs / 2,
    `fast at ${String(fast?.at)}ms, sweep ${sweepMs}ms`);
  check('the slow leg still publishes only when it settles',
    slow !== undefined && fast !== undefined && slow.at > fast.at,
    `fast ${String(fast?.at)}ms vs slow ${String(slow?.at)}ms`);
  check('and the end-of-sweep answer is unchanged by reporting',
    sessions.length === 2
      && sessions.some((entry) => entry.tool === 'fast')
      && sessions.some((entry) => entry.tool === 'slow'),
    `${sessions.length} row(s)`);
}

// PUBLICATION vs CARRY: an abandoned leg must publish NOTHING.
//
// A consumer merges these into a snapshot it is already serving, so the bar is
// "better than what is there now", not "what will this sweep return". An
// abandoned leg returns CARRIED rows, and `lastGoodRows` is keyed by backend id
// and not by `updatedAfter` -- the broker sweeps each window key concurrently,
// so a narrow-window leg's memory can be republished as the all-time roster and
// delete every session outside that window. Leaving the previous rows in place
// is what the carry is trying to express anyway.
{
  const caps: AgentCapabilities = {
    integrationKind: 'http-websocket',
    attachModes: ['live'],
    supportsObserve: false,
    supportsResume: false,
    supportsLiveAttach: true,
    supportsNativeArtifact: false,
    supportsNativeFileInput: false,
    supportsModelSwitch: false,
    permissionGranularity: 'none',
  };
  class FlipBackend implements AgentBackend {
    wedge = false;
    constructor(readonly id: string) {}
    readonly displayName = 'flip';
    readonly capabilities = caps;
    readonly discoveryBudgetMs = 60;
    async isAvailable(): Promise<boolean> { return true; }
    async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionInfo[]> {
      if (!this.wedge) {
        return [{ id: 'carried-session', tool: this.id, title: 'carried', status: 'idle', attachMode: 'live' }];
      }
      await new Promise((resolve) => { options?.signal?.addEventListener('abort', () => resolve(null), { once: true }); });
      return [];
    }
    async attach(): Promise<never> { throw new Error('not reachable in this fixture'); }
  }

  const registry = new AgentRegistry();
  const backend = new FlipBackend('flip');
  registry.register(backend);
  await registry.discoverAll();

  backend.wedge = true;
  const reported: number[] = [];
  const abandonedSweep = await registry.discoverAll({
    onLegRows: (_backendId, rows) => reported.push(rows.length),
  });
  check('an abandoned leg publishes nothing at all',
    reported.length === 0, JSON.stringify(reported));
  check('while the sweep itself still returns that leg\'s carried rows',
    abandonedSweep.filter((entry) => entry.tool === 'flip').length === 1,
    `${abandonedSweep.length} row(s) swept`);
}

// PARTITION KEY: a row must be filed under the backend that produced it.
//
// Every roster consumer groups on `tool` -- publication authority, owner
// retirement, the revision store, and the leg-at-a-time merge -- but
// `decodeSessionInfo` only checks that `tool` is a non-empty string. A row filed
// under someone else's tool makes a tool-partitioned merge drop rows it should
// keep and keep rows the sweep deleted.
{
  const caps: AgentCapabilities = {
    integrationKind: 'http-websocket',
    attachModes: ['live'],
    supportsObserve: false,
    supportsResume: false,
    supportsLiveAttach: true,
    supportsNativeArtifact: false,
    supportsNativeFileInput: false,
    supportsModelSwitch: false,
    permissionGranularity: 'none',
  };
  class MisfiledBackend implements AgentBackend {
    readonly id = 'bridge';
    readonly displayName = 'misfiled';
    readonly capabilities = caps;
    async isAvailable(): Promise<boolean> { return true; }
    async discoverSessions(): Promise<SessionInfo[]> {
      return [
        { id: 'own', tool: 'bridge', title: 'own', status: 'idle', attachMode: 'live' },
        { id: 'stolen', tool: 'omp', title: 'filed under omp', status: 'idle', attachMode: 'live' },
      ];
    }
    async attach(): Promise<never> { throw new Error('not reachable in this fixture'); }
  }

  const registry = new AgentRegistry();
  registry.register(new MisfiledBackend());
  const published: { backendId: string; tools: string[] }[] = [];
  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
  let swept: SessionInfo[] = [];
  try {
    swept = await registry.discoverAll({
      onLegRows: (backendId, rows) => published.push({ backendId, tools: rows.map((r) => r.tool) }),
    });
  } finally {
    console.warn = realWarn;
  }

  check('a row filed under another backend\'s tool is withheld from the sweep',
    swept.length === 1 && swept[0]?.id === 'own', JSON.stringify(swept.map((r) => `${r.tool}:${r.id}`)));
  check('and withheld from the per-leg publication too, so a merge stays partitioned',
    published.length === 1 && published[0]?.tools.every((tool) => tool === 'bridge') === true,
    JSON.stringify(published));
  check('and the withholding is reported rather than silent',
    warnings.some((line) => /filed under tool/.test(line) && line.includes('omp')),
    JSON.stringify(warnings).slice(0, 160));
}

// ... and the UNBUDGETED path owes the caller the same contract. It cannot be
// abandoned, so it has no salvage set, and it used to hand the caller's
// `onPartialRows` straight to the adapter -- which meant the documented promise
// that the registry validates every partial row was simply untrue there.
{
  const caps: AgentCapabilities = {
    integrationKind: 'jsonrpc-stdio',
    attachModes: ['observe'],
    supportsObserve: true,
    supportsResume: false,
    supportsLiveAttach: false,
    supportsNativeArtifact: false,
    supportsNativeFileInput: false,
    supportsModelSwitch: false,
    permissionGranularity: 'none',
  };
  /** Declares NO discoveryBudgetMs, so it takes the unbudgeted branch. */
  class UnbudgetedPartialBackend implements AgentBackend {
    readonly id = 'local';
    readonly displayName = 'local';
    readonly capabilities = caps;
    async isAvailable(): Promise<boolean> { return true; }
    async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionInfo[]> {
      options?.onPartialRows?.([
        { id: 'mine', tool: 'local', title: 'mine', status: 'idle', attachMode: 'observe' },
        { id: 'theirs', tool: 'omp', title: 'misfiled', status: 'idle', attachMode: 'observe' },
        { id: '', tool: '' } as unknown as SessionInfo,
      ]);
      return [{ id: 'mine', tool: 'local', title: 'mine', status: 'idle', attachMode: 'observe' }];
    }
    async attach(): Promise<never> { throw new Error('not reachable in this fixture'); }
  }
  const registry = new AgentRegistry();
  registry.register(new UnbudgetedPartialBackend());
  const observed: SessionInfo[] = [];
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    await registry.discoverAll({ onPartialRows: (rows) => observed.push(...rows) });
  } finally {
    console.warn = realWarn;
  }
  check('an unbudgeted leg validates partial rows before the caller sees them',
    observed.length === 1 && observed[0]?.id === 'mine',
    JSON.stringify(observed.map((row) => `${row.tool}:${row.id}`)));
}

// THE BROKER-SIDE MERGE. Everything above proves what the registry PUBLISHES;
// this proves what the broker does with it. Each leg replaces its own tool's
// slice of the served snapshot and nothing else, and `at` is deliberately not
// advanced by the caller so the TTL keeps measuring the last FULL sweep.
{
  type Row = { tool: string; id: string };
  const snapshot: Row[] = [
    { tool: 'cline', id: 'cline-old-1' },
    { tool: 'cline', id: 'cline-old-2' },
    { tool: 'omp', id: 'omp-1' },
    { tool: 'kilo', id: 'kilo-1' },
  ];
  const merged = mergeLegRows(snapshot, 'cline', [{ tool: 'cline', id: 'cline-new' }]);
  check('a leg replaces its OWN tool\'s rows rather than adding to them',
    merged.filter((row) => row.tool === 'cline').map((row) => row.id).join(',') === 'cline-new',
    JSON.stringify(merged.map((row) => row.id)));
  check('and leaves every other backend\'s rows exactly as they were',
    merged.filter((row) => row.tool !== 'cline').map((row) => row.id).join(',') === 'omp-1,kilo-1',
    JSON.stringify(merged.map((row) => `${row.tool}:${row.id}`)));

  // A completed leg is authoritative for its own tool, so a session it stopped
  // reporting is GONE. Merging by id instead would resurrect it and the roster
  // would never shed a closed session between full sweeps.
  const emptied = mergeLegRows(snapshot, 'cline', []);
  check('a leg that completes with nothing CLEARS its slice instead of keeping stale rows',
    emptied.map((row) => row.id).join(',') === 'omp-1,kilo-1',
    JSON.stringify(emptied.map((row) => row.id)));

  // The input is never mutated: the caller stores the result as a new snapshot
  // and the old array may still be held by a client mid-serialization.
  check('the served snapshot it was given is not mutated',
    snapshot.length === 4 && snapshot.map((row) => row.id).join(',')
      === 'cline-old-1,cline-old-2,omp-1,kilo-1',
    JSON.stringify(snapshot.map((row) => row.id)));

  // A backend with no rows in the snapshot yet simply gains them.
  const added = mergeLegRows(snapshot, 'grok', [{ tool: 'grok', id: 'grok-1' }]);
  check('a backend absent from the snapshot is added without disturbing the rest',
    added.length === 5 && added.some((row) => row.id === 'grok-1')
      && added.filter((row) => row.tool === 'cline').length === 2,
    JSON.stringify(added.map((row) => row.id)));
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} adapter discovery-bound checks passed.`);
if (failed.length) process.exit(1);
