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
  AgentRegistry,
  effectiveDiscoveryBudgetMs,
  EXTERNAL_HOST_DISCOVERY_BUDGET_MS,
  type AgentBackend,
  type AgentCapabilities,
  type AvailabilityOptions,
  type SessionDiscoveryOptions,
  type SessionDiscoveryWork,
  type SessionInfo,
} from '../../../adapter-api/src/index.ts';

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
  const { ClaudeAdapter } = await import('../../../adapters/claude/src/index.ts');
  const { PiAdapter } = await import('../../../adapters/pi/src/index.ts');
  const { OpenCodeAdapter } = await import('../../../adapters/opencode/src/index.ts');

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

  // Which adapters carry the budget, asserted against the shipped ones rather
  // than restated. External-host adapters need it; the local ones must NOT have
  // acquired it, because a budget on a filesystem read would be a deadline on
  // work that cannot hang and can only lose sessions.
  const { KimiAdapter } = await import('../../../adapters/kimi/src/index.ts');
  const { DshAdapter } = await import('../../../adapters/dsh/src/index.ts');
  // Read through the SPI, which is how the registry reads it — and, for the
  // local four, the only way it typechecks at all: the property is genuinely
  // absent from those classes rather than present and undefined.
  const external: AgentBackend[] = [new KimiAdapter(), new DshAdapter()];
  check(
    'both external-host adapters declare the shared discovery budget',
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

const failed = results.filter((result) => !result.ok);
console.log(`\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} adapter discovery-bound checks passed.`);
if (failed.length) process.exit(1);
