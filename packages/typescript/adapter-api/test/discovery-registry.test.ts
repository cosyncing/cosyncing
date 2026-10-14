/**
 * The discovery registry's rules for a leg that does not finish cleanly.
 *
 * `e2e/broker/roster-discovery-bounds.test.ts` proves the outcomes a client
 * sees with a real broker and a wedged Kilo host: abandonment at the budget,
 * the carry of last good rows, the five-sweep cap, a narrow memory never
 * carried into a wider sweep, removals withheld for an unread backend. The
 * rules here decide which sessions every client loses or keeps, but no shipped
 * adapter can drive them through the product: a backend that ignores its
 * abort, partial rows a leg salvaged (and the malformed or misfiled ones it
 * must not), a caller cancelling a sweep, a leg that throws, the whole-sweep
 * ceiling and who gets the next turn after it, a declared budget that is
 * nonsense, and how a carry is windowed and borrowed. Fake backends stand in
 * for adapters; every wait below is the registry's own budget.
 */
import { describe, expect, test } from 'bun:test';
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
} from '../src/index.ts';

const CAPABILITIES: AgentCapabilities = {
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

const row = (tool: string, id: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
  id, tool, title: id, status: 'idle', attachMode: 'live', ...extra,
});
const never = <T>(): Promise<T> => new Promise<T>(() => {});
const idsOf = (rows: SessionInfo[]): string[] => rows.map((info) => info.id);

/** A backend scripted per call: each entry answers, wedges, or throws. */
class ScriptedBackend implements AgentBackend {
  readonly displayName = 'scripted';
  readonly capabilities = CAPABILITIES;
  calls = 0;
  constructor(
    readonly id: string,
    readonly discoveryBudgetMs: number | undefined,
    private readonly script: ((options?: SessionDiscoveryOptions) => Promise<SessionInfo[]>)[],
  ) {}
  async isAvailable(): Promise<boolean> {
    return true;
  }
  async discoverSessions(options?: SessionDiscoveryOptions): Promise<SessionInfo[]> {
    const step = this.script[Math.min(this.calls, this.script.length - 1)]!;
    this.calls += 1;
    return step(options);
  }
  async attach(): Promise<never> {
    throw new Error('not reachable');
  }
}

const answers = (...rows: SessionInfo[]) => async () => rows;
const wedges = () => never<SessionInfo[]>();

function registryOf(...backends: AgentBackend[]): AgentRegistry {
  const registry = new AgentRegistry();
  for (const backend of backends) registry.register(backend);
  return registry;
}

describe('a leg that does not finish', () => {
  test('a backend that ignores its abort still delays nothing', async () => {
    class Deaf extends ScriptedBackend {
      override async isAvailable(_options?: AvailabilityOptions): Promise<boolean> {
        return never<boolean>(); // never settles and never looks at its signal
      }
    }
    const registry = registryOf(
      new ScriptedBackend('established', undefined, [answers(row('established', 'e1'))]),
      new Deaf('deaf', 25, [answers()]),
    );
    expect(idsOf(await registry.discoverAll())).toEqual(['e1']);
  });

  test('rows a leg finished before its budget survive, but never a malformed or misfiled one', async () => {
    const work: SessionDiscoveryWork[] = [];
    const reported: string[] = [];
    const registry = registryOf(
      new ScriptedBackend('established', undefined, [answers(row('established', 'e1'))]),
      new ScriptedBackend('partial', 25, [async (options) => {
        options?.onPartialRows?.([row('partial', 'p1'), row('established', 'misfiled'), { id: 'malformed' } as SessionInfo]);
        options?.onPartialRows?.([row('partial', 'p2')]);
        return never();
      }]),
    );
    const rows = await registry.discoverAll({
      onWork: (event) => work.push(event),
      onPartialRows: (partial) => reported.push(...partial.map((info) => `${info.tool}:${info.id}`)),
    });
    expect(idsOf(rows)).toEqual(['e1', 'p1', 'p2']);
    expect(reported).toEqual(['partial:p1', 'partial:p2']);
    expect(work.find((event) => event.kind === 'leg-abandoned')).toMatchObject({
      backendId: 'partial', budgetMs: 25, budgetKind: 'leg', salvagedRows: 2,
    });
  });

  test('a leg that throws carries its last good rows and is reported as failed, not empty', async () => {
    const work: SessionDiscoveryWork[] = [];
    const registry = registryOf(new ScriptedBackend('flaky', 1_000, [
      answers(row('flaky', 'f1')),
      async () => { throw new Error('host refused'); },
    ]));
    expect(idsOf(await registry.discoverAll())).toEqual(['f1']);
    expect(idsOf(await registry.discoverAll({ onWork: (event) => work.push(event) }))).toEqual(['f1']);
    expect(work.find((event) => event.kind === 'leg-failed')).toMatchObject({
      backendId: 'flaky', reason: expect.stringContaining('host refused'), carriedRows: 1,
    });
  });

  test('a leg that answers empty replaces the memory, so a later overrun cannot resurrect it', async () => {
    const registry = registryOf(new ScriptedBackend('emptied', 25, [
      answers(row('emptied', 'gone')),
      answers(),
      wedges,
    ]));
    expect(idsOf(await registry.discoverAll())).toEqual(['gone']);
    expect(idsOf(await registry.discoverAll())).toEqual([]);
    expect(idsOf(await registry.discoverAll())).toEqual([]);
  });

  test("a caller's own cancellation is not an overrun, overwrites no memory, and spends no carry", async () => {
    const work: SessionDiscoveryWork[] = [];
    let entered!: () => void;
    const running = new Promise<void>((resolve) => { entered = resolve; });
    // Unbudgeted, so the cancellation reaches the failure path rather than the abandon race.
    const registry = registryOf(new ScriptedBackend('cancelled', undefined, [
      answers(row('cancelled', 'kept')),
      async (options) => {
        entered();
        await new Promise<void>((resolve) => options?.signal?.addEventListener('abort', () => resolve(), { once: true }));
        throw new Error('aborted');
      },
      async () => { throw new Error('host refused'); },
    ]));
    await registry.discoverAll();
    const canceller = new AbortController();
    const cancelling = registry.discoverAll({ signal: canceller.signal, onWork: (event) => work.push(event) });
    await running;
    canceller.abort();
    expect(await cancelling).toEqual([]);
    expect(work.map((event) => event.kind)).toEqual(['leg-elapsed']);
    // Five genuine failures still each carry the first sweep's row.
    const carried: number[] = [];
    for (let attempt = 0; attempt < 5; attempt += 1) carried.push((await registry.discoverAll()).length);
    expect(carried).toEqual([1, 1, 1, 1, 1]);
  });
});

describe('the whole-sweep ceiling', () => {
  test('abandons an unbudgeted wedged leg, starts no later adapter, and gives that adapter the next turn', async () => {
    const trailingCalls: number[] = [];
    const wedge = new ScriptedBackend('wedged-local', undefined, [answers(row('wedged-local', 'w1')), wedges]);
    const trailing = new ScriptedBackend('trailing', undefined, [async () => {
      trailingCalls.push(Date.now());
      return [row('trailing', 't1')];
    }]);
    const registry = registryOf(wedge, trailing);
    expect(idsOf(await registry.discoverAll({ sweepBudgetMs: 5_000 }))).toEqual(['w1', 't1']);
    trailingCalls.length = 0;

    const work: SessionDiscoveryWork[] = [];
    const expired = await registry.discoverAll({ sweepBudgetMs: 60, onWork: (event) => work.push(event) });
    // Both lanes carried, both unconfirmed; the trailing adapter was never started.
    expect(idsOf(expired)).toEqual(['w1', 't1']);
    expect(trailingCalls).toEqual([]);
    expect(work.filter((event) => event.kind === 'leg-abandoned').map((event) => (event as any).budgetKind))
      .toEqual(['sweep', 'sweep']);

    // The next sweep starts with the adapter the ceiling denied.
    const next: SessionDiscoveryWork[] = [];
    await registry.discoverAll({ sweepBudgetMs: 60, onWork: (event) => next.push(event) });
    expect(trailingCalls).toHaveLength(1);
    expect(next.find((event) => event.kind === 'leg-elapsed' && event.backendId === 'trailing'))
      .toMatchObject({ abandoned: false });
  });
});

describe('budgets', () => {
  test('a declared but unusable budget means the standard one, never "wait forever"', async () => {
    for (const declared of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(effectiveDiscoveryBudgetMs(declared)).toBe(EXTERNAL_HOST_DISCOVERY_BUDGET_MS);
    }
    expect(effectiveDiscoveryBudgetMs(undefined)).toBeUndefined();
    // The test cap stands in for the standard budget, so the wait is short.
    const registry = new AgentRegistry({ discoveryBudgetCapMs: 50 });
    registry.register(new ScriptedBackend('established', undefined, [answers(row('established', 'e1'))]));
    registry.register(new ScriptedBackend('broken-budget', 0, [wedges]));
    expect(idsOf(await registry.discoverAll())).toEqual(['e1']);
  });

  test('the test cap shortens a declared budget and leaves an undeclared leg unbudgeted', async () => {
    const registry = new AgentRegistry({ discoveryBudgetCapMs: 20 });
    registry.register(new ScriptedBackend('local', undefined, [answers(row('local', 'l1'))]));
    registry.register(new ScriptedBackend('external', 60_000, [wedges]));
    const work: SessionDiscoveryWork[] = [];
    expect(idsOf(await registry.discoverAll({ onWork: (event) => work.push(event) }))).toEqual(['l1']);
    expect(work.filter((event) => event.kind === 'leg-abandoned')).toEqual([
      expect.objectContaining({ backendId: 'external', budgetMs: 20, budgetKind: 'leg' }),
    ]);
  });
});

describe('the carry', () => {
  test('is windowed by updatedAt, or createdAt when that is all a row has', async () => {
    const now = Date.now();
    const registry = registryOf(new ScriptedBackend('stamped', 25, [
      answers(
        row('stamped', 'recent', { updatedAt: now }),
        row('stamped', 'old-update', { updatedAt: now - 30 * 86_400_000 }),
        row('stamped', 'old-creation', { createdAt: now - 30 * 86_400_000 }),
        row('stamped', 'undated'),
      ),
      wedges,
    ]));
    await registry.discoverAll({ scopeKey: 'all' });
    const narrow = await registry.discoverAll({ scopeKey: '7d', updatedAfter: now - 7 * 86_400_000 });
    expect(idsOf(narrow).sort()).toEqual(['recent', 'undated']);
  });

  test('a scope borrowing from a wider one that keeps succeeding is never blanked by the cap', async () => {
    let wideCalls = 0;
    const backend = new ScriptedBackend('lender', 25, [async (options) => {
      if (options?.updatedAfter === undefined) {
        wideCalls += 1;
        return [row('lender', 'r1', { updatedAt: Date.now() })];
      }
      return never(); // the narrow scope always wedges
    }]);
    const registry = registryOf(backend);
    const narrowRows: number[] = [];
    for (let sweep = 0; sweep < 8; sweep += 1) {
      await registry.discoverAll({ scopeKey: 'all' });
      narrowRows.push((await registry.discoverAll({ scopeKey: '7d', updatedAfter: Date.now() - 7 * 86_400_000 })).length);
    }
    expect(wideCalls).toBe(8);
    expect(narrowRows).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
  });
});
