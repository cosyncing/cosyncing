/**
 * The server boundary: the CLOSED write surface, the instance registry, the
 * identity gate, and the adapter paths that consume a resolved server.
 *
 * The posture rests on the write set being closed by construction rather than
 * by convention, so the first block asserts it structurally — over both class
 * surfaces and over the source text — rather than by "we did not call it": the
 * shared HTTP door names only GET, the one write door exposes exactly ten
 * named POST operations with no generic post, no other adapter source names a
 * mutating verb, and the socket's frame set excludes every mutating frame. The
 * rest asserts the gate fails CLOSED: no live server, several live servers, an
 * unreachable `/meta`, unreadable metadata, a disabled token gate, a record that
 * cannot be bound, a start time outside the binding window, and a version the
 * record contradicts all refuse, on every consuming path rather than on some of
 * them — while the CAPTURED registry record paired with the CAPTURED `/meta`
 * resolves, which is the case a synthesized fixture once hid. A newly observed
 * generation that binds is ADOPTED on the very next call, never refused first;
 * that is asserted too, because the absence of a pin is a decision, not an
 * omission.
 *
 * Runs against a fake server replaying SANITIZED CAPTURES from a real Kimi Code
 * 0.35.0 `kimi web` instance (fixtures/kimi-0.35.0.json). No Kimi process, no
 * model, no network beyond loopback.
 *
 *   bun run packages/typescript/adapters/kimi/test/test-kimi-server.ts   (exit 0 = all pass)
 */
export {};
import { KimiAdapter } from '../src/index.ts';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KimiReadOnlyHttp,
  KIMI_DEFAULT_PORT,
  KIMI_INSTANCE_SCAN_MAX_FILES,
  KIMI_READ_ONLY_WS_FRAMES,
  KIMI_STARTUP_BINDING_WINDOW_MS,
  boundedDirectoryListing,
  decodeKimiInstanceRecord,
  isKimiReadOnlyWsFrame,
  kimiInstancesDirectory,
  kimiServerTokenPath,
  readBoundedText,
  resolveKimiHome,
  resolveVerifiedInstance,
  scanKimiInstances,
  type KimiInstanceScan,
} from '../src/server.ts';
import type { KimiSocketLike } from '../src/observe.ts';
import {
  KIMI_IDEMPOTENT_WRITE_CODES,
  KimiDriveHttp,
  isKimiIdempotentWriteCode,
} from '../src/drive-http.ts';
import { isOwnershipConflictError } from '@cosyncing/adapter-api';
import {
  KIMI_ACTIVE_GAP_CAP_MS,
  KIMI_ACTIVE_TIME_METHOD,
  activeIntervals,
  activeTimeAccount,
  mergedIntervalMs,
} from '../src/timing.ts';
import {
  KIMI_WIRE_MAX_LINE_BYTES,
  KIMI_WIRE_TAIL_CAP_BYTES,
  KIMI_WIRE_TICK_CAP_BYTES,
  KIMI_WIRE_WORKSPACE_SCAN_MAX,
  KimiWireTail,
  defaultKimiWireIo,
  locateKimiWireStreams,
  type KimiWireIo,
} from '../src/usage.ts';

const FIXTURE = await Bun.file(new URL('./fixtures/kimi-0.35.0.json', import.meta.url)).json() as {
  kimiVersion: string;
  sessionId: string;
  rest: Record<string, { code: number; msg: string; data: unknown }>;
  instanceRecord: Record<string, unknown>;
};

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

/**
 * A registry record and the `/api/v1/meta` body that BINDS to it, for the blocks
 * below whose subject is not identity — tokens, transports, reverification.
 *
 * Both sides come from one start time, so they agree the way a real host's do,
 * and the two ids stay DIFFERENT, as upstream mints them. Passing the gate is a
 * precondition of those blocks, not their subject; what matters is that they buy
 * it with a REALISTIC pair rather than by making an identity comparison true by
 * construction. See section 3 for what that cost the last time.
 */
const BOUND_STARTED_AT = 1_786_657_461_604;
function boundInstance(serverId: string, baseUrl: string, port: number) {
  return { baseUrl, port, pid: 4242, serverId, hostVersion: FIXTURE.kimiVersion, startedAt: BOUND_STARTED_AT };
}
function boundMeta(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    server_version: FIXTURE.kimiVersion,
    server_id: 'api-generation-id',
    started_at: new Date(BOUND_STARTED_AT + 200).toISOString(),
    capabilities: { websocket: true },
    dangerous_bypass_auth: false,
    ...extra,
  };
}

// ── 1. Read-only guarantee (structural) ─────────────────────────────────────

{
  const surface = new Set<string>();
  for (
    let proto: object | null = KimiReadOnlyHttp.prototype;
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    for (const key of Object.getOwnPropertyNames(proto)) surface.add(key);
  }
  surface.delete('constructor');
  const mutating = [...surface].filter((name) =>
    /^(post|put|patch|delete|send|write|mutate|request|fetch)/i.test(name));
  check('http helper exposes no mutating operation', mutating.length === 0, [...surface].sort().join(','));

  const source = await Bun.file(new URL('../src/server.ts', import.meta.url)).text();
  const verbs = source.match(/method:\s*'([A-Z]+)'/g) ?? [];
  check(
    'http helper names only the GET method',
    verbs.length > 0 && verbs.every((verb) => verb.includes("'GET'")),
    verbs.join(' '),
  );

  // `drive-http.ts` is deliberately NOT in this list — it is the one file
  // allowed to name POST. Every other source, including the drive CONNECTION,
  // must reach a write only by calling one of that file's ten named methods.
  const adapterSources = [
    'index.ts', 'implementation.ts', 'observe.ts', 'mapping.ts', 'diagnostics.ts',
    'drive.ts', 'usage.ts', 'timing.ts', 'server.ts',
  ];
  let strayVerb = '';
  for (const name of adapterSources) {
    const text = await Bun.file(new URL(`../src/${name}`, import.meta.url)).text();
    if (/method:\s*'(POST|PUT|PATCH|DELETE)'/.test(text)) strayVerb = name;
  }
  check('no adapter source outside the write door names a mutating HTTP verb', strayVerb === '', strayVerb);

  // ── The write door, allowlisted by construction ──────────────────────────
  //
  // The mirror of the read door's proof. `KimiDriveHttp` can write, so what has
  // to be provable is that the set of writes is CLOSED: ten named operations,
  // no generic `post(path, body)`, and no other exported way to reach the
  // transport. An eleventh write must cost an eleventh method, in review.
  {
    const surface = new Set<string>();
    for (
      let proto: object | null = KimiDriveHttp.prototype;
      proto && proto !== Object.prototype;
      proto = Object.getPrototypeOf(proto) as object | null
    ) {
      for (const key of Object.getOwnPropertyNames(proto)) surface.add(key);
    }
    surface.delete('constructor');
    surface.delete('origin');
    const expected = [
      'abortSession', 'activateSkill', 'answerQuestion', 'controlGoal',
      'createSession', 'dismissQuestion', 'renameSession', 'resolveApproval',
      'submitPrompt', 'uploadFile',
    ];
    check('the write door exposes exactly the ten allowlisted operations',
      [...surface].sort().join(',') === expected.join(','),
      [...surface].sort().join(','));

    const driveSource = await Bun.file(new URL('../src/drive-http.ts', import.meta.url)).text();
    const verbs = driveSource.match(/method:\s*'([A-Z]+)'/g) ?? [];
    check('the write door names only the POST method',
      verbs.length > 0 && verbs.every((verb) => verb.includes("'POST'")),
      verbs.join(' '));
    // The transport itself is `private`, which TypeScript erases — so the
    // guarantee that matters at runtime is that nothing exports it and the
    // prototype surface above does not carry it.
    check('the write door exports no generic post/request escape hatch',
      !/export\s+(async\s+)?function\s+(post|request|send|fetchJson)/.test(driveSource)
        && !surface.has('post') && !surface.has('request'),
      [...surface].sort().join(','));
    check('the idempotent write codes are the three success-shaped envelopes',
      KIMI_IDEMPOTENT_WRITE_CODES.join(',') === '40902,40903,40909'
        && isKimiIdempotentWriteCode(40902) && isKimiIdempotentWriteCode(40909)
        && !isKimiIdempotentWriteCode(40401),
      KIMI_IDEMPOTENT_WRITE_CODES.join(','));
  }

  check(
    'read-only ws frame set excludes mutating control frames',
    !KIMI_READ_ONLY_WS_FRAMES.some((frame) => /abort|terminal_|prompt/.test(frame))
      && !isKimiReadOnlyWsFrame('abort')
      && !isKimiReadOnlyWsFrame('terminal_input'),
    KIMI_READ_ONLY_WS_FRAMES.join(','),
  );
}

// ── 2. Home + instance registry ─────────────────────────────────────────────

{
  check(
    'KIMI_CODE_HOME overrides the default home',
    resolveKimiHome({ KIMI_CODE_HOME: '/custom/home' }, '/fixture/home') === '/custom/home'
      && resolveKimiHome({}, '/fixture/home') === '/fixture/home/.kimi-code',
  );

  // Ports are derived from the adapter's own constant rather than written as
  // literals: this suite binds nothing on them, and a literal `host:port` reads
  // to the suite-isolation audit as a fixed listen port, which would hold an
  // otherwise parallel-safe suite out of the parallel group.
  const livePort = KIMI_DEFAULT_PORT;
  const live = { server_id: 's1', pid: 10, host: '127.0.0.1', port: livePort };
  const dead = { server_id: 's2', pid: 11, host: '127.0.0.1', port: livePort + 1 };
  const remote = { server_id: 's3', pid: 12, host: '10.0.0.4', port: livePort + 2 };
  const records: Record<string, unknown> = {
    'live.json': live,
    'dead.json': dead,
    'remote.json': remote,
    'garbage.json': { server_id: 's4' },
    'ignored.txt': live,
  };
  const scan = scanKimiInstances('/h', {
    listFiles: () => ({ names: Object.keys(records), truncated: false }),
    readJson: (path) => records[path.slice(path.lastIndexOf('/') + 1)],
    pidAlive: (pid) => pid !== 11,
  });
  check('dead-pid instance records are filtered', scan.stale === 1, `stale=${scan.stale}`);
  check('non-loopback + malformed records are refused', scan.invalid === 2, `invalid=${scan.invalid}`);
  check(
    'one live loopback instance yields a base url',
    scan.live.length === 1 && scan.live[0]?.baseUrl === `http://127.0.0.1:${livePort}`,
    scan.live[0]?.baseUrl ?? 'none',
  );
  check(
    'the real captured instance record decodes',
    decodeKimiInstanceRecord(FIXTURE.instanceRecord)?.port === 58911,
  );

  // The scan is BOUNDED even against an io that ignored its own bounding
  // duty: a registry stuffed with files costs at most
  // KIMI_INSTANCE_SCAN_MAX_FILES reads + probes, and the excess surfaces as
  // truncation — never as a silently chosen subset.
  const readPaths: string[] = [];
  const flooded = scanKimiInstances('/h', {
    listFiles: () => ({
      names: Array.from({ length: 200 }, (_unused, index) => `r${String(index).padStart(3, '0')}.json`),
      truncated: false,
    }),
    readJson: (path) => {
      readPaths.push(path);
      return { ...live, server_id: `s-${path}` };
    },
    pidAlive: () => false,
  });
  check('a flooded registry is examined only up to the file cap',
    readPaths.length === KIMI_INSTANCE_SCAN_MAX_FILES, `read=${readPaths.length}`);
  check('the defensive re-cap reports truncation', flooded.truncated === true);
  check('capped examination still classifies what it read',
    flooded.stale === KIMI_INSTANCE_SCAN_MAX_FILES, `stale=${flooded.stale}`);

  // THE HIDDEN-LIVE-INSTANCE CASE the bound must never mishandle: 33 records
  // where the 1st and the 33rd both describe live servers. The bounded io
  // surfaces 32 and reports truncation — and the scan must carry that
  // truncation so resolution refuses, because accepting record 1 as "the one
  // server" would talk to the wrong server with the user's token.
  const hidden = scanKimiInstances('/h', {
    listFiles: () => ({
      names: Array.from({ length: KIMI_INSTANCE_SCAN_MAX_FILES }, (_unused, index) => `r${String(index).padStart(3, '0')}.json`),
      truncated: true, // the 33rd record exists but was not enumerated
    }),
    readJson: (path) => (path.endsWith('r000.json') ? live : dead),
    pidAlive: (pid) => pid === live.pid,
  });
  check('a truncated registry scan carries the truncation', hidden.truncated === true,
    JSON.stringify({ live: hidden.live.length, truncated: hidden.truncated }));
  check('the one visible live server is still parsed', hidden.live.length === 1);

  // Bounded io helpers, against a real directory.
  const boundedRoot = mkdtempSync(join(tmpdir(), 'kimi-bounded-'));
  try {
    for (let index = 0; index < 40; index += 1) {
      writeFileSync(join(boundedRoot, `f${String(index).padStart(2, '0')}.json`), '{}');
    }
    const listed = boundedDirectoryListing(boundedRoot, 32);
    check('boundedDirectoryListing stops at the ceiling and reports truncation',
      listed.names.length === 32 && listed.truncated === true,
      `names=${listed.names.length} truncated=${listed.truncated}`);
    const exact = boundedDirectoryListing(boundedRoot, 40);
    check('a listing at exactly the ceiling is not truncated',
      exact.names.length === 40 && exact.truncated === false,
      `names=${exact.names.length} truncated=${exact.truncated}`);
    writeFileSync(join(boundedRoot, 'small.txt'), 'tiny');
    writeFileSync(join(boundedRoot, 'big.txt'), 'x'.repeat(10_000));
    check('readBoundedText returns a small file whole',
      readBoundedText(join(boundedRoot, 'small.txt'), 8_192) === 'tiny');
    let oversizedThrew = false;
    try {
      readBoundedText(join(boundedRoot, 'big.txt'), 8_192);
    } catch {
      oversizedThrew = true;
    }
    check('readBoundedText throws on an oversized file instead of reading it whole', oversizedThrew);

    // A byte ceiling bounds what a file COSTS, not how long opening one takes.
    // open(2) on a FIFO for read waits for a writer, so a FIFO dropped at
    // server.token or under instances/ would hang the broker's discovery path
    // with the ceiling fully intact. The reader must refuse anything that is
    // not a regular file, and refuse it promptly.
    const fifoPath = join(boundedRoot, 'waiting.json');
    let fifoMade = false;
    try {
      fifoMade = Bun.spawnSync(['mkfifo', fifoPath]).success;
    } catch {
      fifoMade = false;
    }
    if (fifoMade) {
      const startedAt = Date.now();
      let fifoThrew = false;
      try {
        readBoundedText(fifoPath, 8_192);
      } catch {
        fifoThrew = true;
      }
      const elapsed = Date.now() - startedAt;
      check('readBoundedText refuses a FIFO instead of waiting for a writer',
        fifoThrew && elapsed < 2_000, `threw=${fifoThrew} ms=${elapsed}`);
    } else {
      check('readBoundedText refuses a FIFO instead of waiting for a writer', true,
        'mkfifo unavailable');
    }

    // A symlink points wherever whoever dropped it chose, and the open must
    // refuse the path itself rather than resolve it.
    const linkPath = join(boundedRoot, 'link.txt');
    symlinkSync(join(boundedRoot, 'small.txt'), linkPath);
    let symlinkThrew = false;
    try {
      readBoundedText(linkPath, 8_192);
    } catch {
      symlinkThrew = true;
    }
    check('readBoundedText refuses a symlinked path rather than following it', symlinkThrew);
  } finally {
    rmSync(boundedRoot, { recursive: true, force: true });
  }

  // The same hazard end to end, on the path the broker actually walks: a FIFO
  // in the registry directory must be counted invalid, and must not hold up
  // the live records around it.
  const fifoHome = mkdtempSync(join(tmpdir(), 'kimi-fifo-home-'));
  try {
    const registry = kimiInstancesDirectory(fifoHome);
    mkdirSync(registry, { recursive: true });
    writeFileSync(join(registry, 'live.json'), JSON.stringify({
      server_id: 's-fifo-neighbour', pid: 4, host: '127.0.0.1', port: KIMI_DEFAULT_PORT,
    }));
    let registryFifo = false;
    try {
      registryFifo = Bun.spawnSync(['mkfifo', join(registry, 'x.json')]).success;
    } catch {
      registryFifo = false;
    }
    const scanned = scanKimiInstances(fifoHome, {
      listFiles: (directory) => boundedDirectoryListing(directory, KIMI_INSTANCE_SCAN_MAX_FILES),
      readJson: (path) => JSON.parse(readBoundedText(path, 8 * 1024)),
      pidAlive: () => true,
    });
    check('a FIFO in the registry is counted invalid without stalling the scan',
      !registryFifo || (scanned.invalid === 1 && scanned.live.length === 1),
      registryFifo
        ? `invalid=${scanned.invalid} live=${scanned.live.length}`
        : 'mkfifo unavailable');
  } finally {
    rmSync(fifoHome, { recursive: true, force: true });
  }
}

// ── 3. The identity gate, in isolation ──────────────────────────────────────
//
// Exercised directly here so its refusal reasons are pinned independently of
// how any one adapter path happens to translate them.
//
// EVERY instance here is decoded from the CAPTURED registry record and paired
// with the CAPTURED `/api/v1/meta`, exactly as upstream writes both. That is the
// point of this block, not a stylistic preference. The previous version of this
// suite built its instances by copying the meta `server_id` into a synthetic
// registry record, which made "registry id equals meta id" true by construction
// — so it proved the comparator and never once tested the premise. The premise
// was false: upstream mints the two ids with separate `ulid()` calls, so they
// never match on a real host, and the gate they justified rejected 100% of
// genuine Kimi servers until a live host proved it. A fixture that synthesizes
// either side of an identity check cannot fail that way. Do not reintroduce one.

{
  const record = decodeKimiInstanceRecord(FIXTURE.instanceRecord)!;
  const capturedMeta = FIXTURE.rest.meta!.data as Record<string, unknown>;
  const registryStartedAt = record.startedAt!;
  const metaStartedAtMs = Date.parse(capturedMeta.started_at as string);
  const instance = {
    baseUrl: `http://127.0.0.1:${record.port}`,
    port: record.port,
    pid: record.pid,
    serverId: record.serverId,
    hostVersion: record.hostVersion,
    startedAt: registryStartedAt,
  };

  // The captured pair, stated as the fact this suite rests on: two DIFFERENT
  // ids, one boot. If a future capture makes them equal, this fails loudly here
  // rather than quietly restoring the old false premise everywhere else.
  check('the captured registry id and the captured meta id DIFFER — siblings, not copies',
    record.serverId !== capturedMeta.server_id,
    `${record.serverId} vs ${String(capturedMeta.server_id)}`);
  check('the captured meta start follows the captured registry start, inside the binding window',
    metaStartedAtMs >= registryStartedAt
    && metaStartedAtMs - registryStartedAt <= KIMI_STARTUP_BINDING_WINDOW_MS,
    `${metaStartedAtMs - registryStartedAt}ms`);

  const gateClient = (patch?: (data: Record<string, unknown>) => Record<string, unknown>) => () =>
    new KimiReadOnlyHttp({
      baseUrl: instance.baseUrl,
      fetchImpl: async () => ({
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          msg: 'success',
          data: patch ? patch({ ...capturedMeta }) : capturedMeta,
          request_id: 'fixture',
        }),
      }),
    });
  const without = (key: string) => (data: Record<string, unknown>) => {
    delete data[key];
    return data;
  };
  const unreachableClient = () => new KimiReadOnlyHttp({
    baseUrl: instance.baseUrl,
    fetchImpl: async () => {
      throw new Error('connection refused');
    },
  });

  const none = await resolveVerifiedInstance({ live: [], stale: 0, invalid: 0, truncated: false }, gateClient());
  check('no live instance refuses with `none`', !none.ok && none.reason === 'none');

  // The 33-record shape end to end: one live server visible, truncation set.
  // The gate must refuse rather than accept the visible server — the record it
  // never enumerated may describe ANOTHER live one.
  const incomplete = await resolveVerifiedInstance(
    { live: [instance], stale: 0, invalid: 0, truncated: true },
    gateClient(),
  );
  check('a truncated scan refuses with `incomplete`, even with one visible live server',
    !incomplete.ok && incomplete.reason === 'incomplete',
    JSON.stringify(incomplete));

  const ambiguous = await resolveVerifiedInstance(
    { live: [instance, { ...instance, serverId: 'server-two', port: 2 }], stale: 0, invalid: 0, truncated: false },
    gateClient(),
  );
  check('several live instances refuse with `ambiguous`',
    !ambiguous.ok && ambiguous.reason === 'ambiguous');

  const one: KimiInstanceScan = { live: [instance], stale: 0, invalid: 0, truncated: false };
  const unreachable = await resolveVerifiedInstance(one, unreachableClient);
  check('an unanswerable /meta refuses with `unreachable`',
    !unreachable.ok && unreachable.reason === 'unreachable');

  // THE REGRESSION: the captured pair, unmodified, through the real gate.
  const matched = await resolveVerifiedInstance(one, gateClient());
  check('the CAPTURED registry record and the CAPTURED meta resolve — the shape a real host serves',
    matched.ok && matched.instance.serverId === record.serverId,
    matched.ok ? 'ok' : matched.reason);
  check('the resolution reports BOTH ids, unconflated, plus the version that answered',
    matched.ok
    && matched.identity.registryServerId === record.serverId
    && matched.identity.apiServerId === capturedMeta.server_id
    && matched.identity.apiServerId !== matched.identity.registryServerId
    && matched.identity.apiStartedAtMs === metaStartedAtMs
    && matched.identity.serverVersion === record.hostVersion);

  for (const field of ['server_id', 'server_version', 'started_at']) {
    const dropped = await resolveVerifiedInstance(one, gateClient(without(field)));
    check(`a /meta without ${field} refuses — unverifiable is not verified`,
      !dropped.ok && dropped.reason === 'metadata-invalid',
      dropped.ok ? 'resolved' : dropped.reason);
  }
  for (const [field, value] of [['server_id', 42], ['server_version', null], ['started_at', 'not-a-date']] as const) {
    const malformed = await resolveVerifiedInstance(one, gateClient((data) => ({ ...data, [field]: value })));
    check(`a malformed ${field} refuses`, !malformed.ok && malformed.reason === 'metadata-invalid');
  }

  // A server that answers ANY caller has not proved it is this user's server:
  // the authenticated probe that "verified" it authenticated nothing.
  const bypassed = await resolveVerifiedInstance(one,
    gateClient((data) => ({ ...data, dangerous_bypass_auth: true })));
  check('a server with its token gate disabled refuses with `auth-bypassed`',
    !bypassed.ok && bypassed.reason === 'auth-bypassed');

  // No `started_at` in the registry record leaves NOTHING tying it to the
  // process answering, and the version alone would not: a replacement server
  // almost certainly reports the same version.
  const { startedAt: _unbound, ...unboundInstance } = instance;
  const unbindable = await resolveVerifiedInstance(
    { live: [unboundInstance], stale: 0, invalid: 0, truncated: false },
    gateClient(),
  );
  check('a registry record with no start time refuses with `unbindable`',
    !unbindable.ok && unbindable.reason === 'unbindable');

  const late = await resolveVerifiedInstance(
    { live: [{ ...instance, startedAt: registryStartedAt - KIMI_STARTUP_BINDING_WINDOW_MS - 1 }], stale: 0, invalid: 0, truncated: false },
    gateClient(),
  );
  check('an API start beyond the window after the record refuses with `startup-mismatch`',
    !late.ok && late.reason === 'startup-mismatch');

  // The PREVIOUS server still holding the port while a newer `kimi web` writes
  // a record and fails to bind: it reports a start from before that record.
  const early = await resolveVerifiedInstance(
    { live: [{ ...instance, startedAt: metaStartedAtMs + 1 }], stale: 0, invalid: 0, truncated: false },
    gateClient(),
  );
  check('an API start BEFORE the record refuses — a predecessor still holding the port',
    !early.ok && early.reason === 'startup-mismatch');

  const versionDrift = await resolveVerifiedInstance(one,
    gateClient((data) => ({ ...data, server_version: '9.9.9' })));
  check('a server reporting a version its record does not refuses with `version-mismatch`',
    !versionDrift.ok && versionDrift.reason === 'version-mismatch');

  // A record without `host_version` is not an older shape to accommodate: every
  // supported version writes it, so its absence is a record the gate cannot
  // check, and skipping the comparison it enables would fail open.
  const { hostVersion: _versionless, ...versionlessInstance } = instance;
  const versionless = await resolveVerifiedInstance(
    { live: [versionlessInstance], stale: 0, invalid: 0, truncated: false },
    gateClient(),
  );
  check('a record without host_version refuses with `unbindable`',
    !versionless.ok && versionless.reason === 'unbindable');

  // The FAIL-OPEN EDGES, both reached by malformed input rather than by an
  // attacker: a present-but-empty `host_version` must not decode into a record
  // that merely looks unversioned, and a missing `dangerous_bypass_auth` must
  // not read as "the token gate is on".
  check('a present-but-empty host_version invalidates the whole record, rather than dropping the field',
    decodeKimiInstanceRecord({ ...FIXTURE.instanceRecord, host_version: '' }) === undefined);
  check('a present-but-malformed started_at invalidates the whole record',
    decodeKimiInstanceRecord({ ...FIXTURE.instanceRecord, started_at: Number.NaN }) === undefined);
  const bypassAbsent = await resolveVerifiedInstance(one, gateClient(without('dangerous_bypass_auth')));
  check('a /meta without dangerous_bypass_auth refuses — a security field is never defaulted',
    !bypassAbsent.ok && bypassAbsent.reason === 'metadata-invalid');
  const bypassNonBoolean = await resolveVerifiedInstance(one,
    gateClient((data) => ({ ...data, dangerous_bypass_auth: 'false' })));
  check('a non-boolean dangerous_bypass_auth refuses rather than being coerced',
    !bypassNonBoolean.ok && bypassNonBoolean.reason === 'metadata-invalid');

  // NO CROSS-CALL PIN, asserted rather than assumed. A resolution carries no
  // memory of the previous one, so an ordinary `kimi web` restart — a new API
  // generation over a fresh registry record — resolves immediately instead of
  // spending a refusal on whichever operation happened to run first.
  const restarted = await resolveVerifiedInstance(one,
    gateClient((data) => ({ ...data, server_id: `${String(data.server_id)}-next` })));
  check('a new API generation resolves on its own merits — no operation is spent on a stale pin',
    restarted.ok && restarted.identity.apiServerId === `${String(capturedMeta.server_id)}-next`,
    restarted.ok ? 'ok' : restarted.reason);
}

// ── 4. The response-body ceiling ────────────────────────────────────────────
//
// The ceiling must hold AT the read: an oversized body is refused while it is
// still arriving, never materialized whole and measured afterwards. Stated
// precisely, because the difference matters — RETENTION is bounded by the
// ceiling, and consumption stops within one transport chunk past it (plus the
// stream's read-ahead). That is a bounded-retention guarantee, not an exact
// cap on transported bytes.
//
// It is counted in BYTES — a UTF-16 length undercounts every multi-byte
// character, which is how a body several times the ceiling slips past a
// code-unit check. And an answer this client will not act on is TORN DOWN,
// not merely left unread.

{
  /** A stream that hands out one chunk per pull, recording pulls and cancellation. */
  function chunkedStream(chunks: Uint8Array[]): {
    stream: ReadableStream<Uint8Array>;
    pulled: () => number;
    cancelled: () => boolean;
  } {
    let index = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index >= chunks.length) {
          controller.close();
          return;
        }
        controller.enqueue(chunks[index]!);
        index += 1;
      },
      cancel() {
        cancelled = true;
      },
    });
    return { stream, pulled: () => index, cancelled: () => cancelled };
  }

  const streamingClient = (stream: ReadableStream<Uint8Array>, maxBytes: number) => new KimiReadOnlyHttp({
    baseUrl: 'http://127.0.0.1:1',
    maxBytes,
    fetchImpl: async () => ({
      status: 200,
      body: stream,
      text: async () => {
        throw new Error('a response with a body stream must never fall back to text()');
      },
    }),
  });

  const oversized = chunkedStream(Array.from({ length: 12 }, () => new Uint8Array(32)));
  const tooLarge = await streamingClient(oversized.stream, 64).getJson('/api/v1/meta');
  check('an oversized streamed body is cancelled a bounded distance past the ceiling',
    !tooLarge.ok && tooLarge.reason === 'too-large'
      && oversized.cancelled() && oversized.pulled() < 12 && oversized.pulled() <= 5,
    `pulled=${oversized.pulled()}/12 cancelled=${oversized.cancelled()} `
    + '— ceiling 64B, chunk 32B: overflow is seen on the chunk that crosses it, not at the exact byte');

  // Multi-chunk UTF-8 with a character SPLIT across the chunk boundary: a
  // per-chunk decode without `{stream: true}` would corrupt it into
  // replacement characters and the envelope would come back wrong.
  const payload = JSON.stringify({
    code: 0, msg: 'success', data: { text: 'héllo 漢字 ✓' }, request_id: 'r-stream',
  });
  const encoded = new TextEncoder().encode(payload);
  const multiByteAt = encoded.findIndex((byte) => byte >= 0x80);
  const splitAt = multiByteAt + 1; // one byte into a multi-byte sequence
  const under = chunkedStream([encoded.subarray(0, splitAt), encoded.subarray(splitAt)]);
  const parsed = await streamingClient(under.stream, 64 * 1024).getJson<{ text?: unknown }>('/api/v1/meta');
  check('a streamed body under the ceiling decodes across chunk boundaries',
    multiByteAt > 0 && parsed.ok && parsed.data.text === 'héllo 漢字 ✓'
      && parsed.requestId === 'r-stream',
    `split=${splitAt} of ${encoded.byteLength} bytes`);

  // The bytes-not-code-units pin, on the defensive re-cap path an injected
  // text()-only fake takes.
  const ceiling = 200;
  const wideBody = JSON.stringify({
    code: 0, msg: 'success', data: { text: '漢'.repeat(60) }, request_id: 'r-wide',
  });
  const wide = await new KimiReadOnlyHttp({
    baseUrl: 'http://127.0.0.1:1',
    maxBytes: ceiling,
    fetchImpl: async () => ({ status: 200, text: async () => wideBody }),
  }).getJson('/api/v1/meta');
  check('the body ceiling counts bytes, not UTF-16 code units',
    wideBody.length <= ceiling && Buffer.byteLength(wideBody, 'utf8') > ceiling
      && !wide.ok && wide.reason === 'too-large',
    `codeUnits=${wideBody.length} bytes=${Buffer.byteLength(wideBody, 'utf8')} ceiling=${ceiling}`);

  // An unauthorized answer carries nothing this client acts on, so its body
  // must not be read at all. Both accessors trap.
  let bodyTouched = false;
  const trap = await new KimiReadOnlyHttp({
    baseUrl: 'http://127.0.0.1:1',
    maxBytes: 64,
    fetchImpl: async () => ({
      status: 401,
      get body(): ReadableStream<Uint8Array> | null {
        bodyTouched = true;
        return null;
      },
      text: async () => {
        bodyTouched = true;
        throw new Error('the body of an unauthorized answer must not be read');
      },
    }),
  }).getJson('/api/v1/meta');
  check('an unauthorized answer is refused without reading its body',
    !trap.ok && trap.reason === 'unauthorized' && trap.status === 401 && !bodyTouched,
    `touched=${bodyTouched}`);

  // Not reading the body is only half of it. The body of an answer we refuse
  // is never consumed, so the TRANSPORT has to come down: left alone, the
  // stream keeps arriving for as long as an endpoint that just failed to
  // authenticate us cares to feed it. The stream carries a zero high-water
  // mark, so a pull can only mean somebody read from it.
  let unauthorizedPulls = 0;
  let unauthorizedTextCalled = false;
  let capturedSignal: AbortSignal | undefined;
  const liveBody = new ReadableStream<Uint8Array>({
    pull(controller) {
      unauthorizedPulls += 1;
      controller.enqueue(new Uint8Array(32));
    },
  }, { highWaterMark: 0 });
  const torndown = await new KimiReadOnlyHttp({
    baseUrl: 'http://127.0.0.1:1',
    maxBytes: 64,
    fetchImpl: async (_url, init) => {
      capturedSignal = init.signal;
      return {
        status: 401,
        body: liveBody,
        text: async () => {
          unauthorizedTextCalled = true;
          throw new Error('the body of an unauthorized answer must not be read');
        },
      };
    },
  }).getJson('/api/v1/meta');
  check('an unauthorized answer aborts its transport rather than leaving the stream live',
    !torndown.ok && torndown.reason === 'unauthorized'
      && unauthorizedPulls === 0 && !unauthorizedTextCalled
      && capturedSignal?.aborted === true,
    `pulls=${unauthorizedPulls} text=${unauthorizedTextCalled} aborted=${capturedSignal?.aborted}`);
}

// ── 5. The runtime token read: bounded, and read ONCE per operation ─────────
//
// Diagnosis already reads `server.token` through a 4KB ceiling; the runtime
// read must agree. Something larger than that ceiling is not a token, so it
// must yield NO credential rather than an unbounded read followed by a bearer
// header carrying whatever the file held.
//
// And one operation takes ONE snapshot of it. An attach that read the token
// twice — once for the verified HTTP client, once for the socket — would, on a
// rotation landing between the two reads, produce a single connection whose
// two transports authenticate as different identities.

{
  // Mirrored from implementation.ts's SERVER_TOKEN_MAX_BYTES, which stays
  // package-internal: the facade exports the adapter and the gate, nothing else.
  const tokenCeiling = 4 * 1024;
  const tokenHome = mkdtempSync(join(tmpdir(), 'kimi-token-'));
  try {
    const authorizations: Array<string | undefined> = [];
    const tokenAdapter = () => new KimiAdapter({
      env: { KIMI_CODE_HOME: tokenHome },
      homeDir: '/fixture/home',
      instanceScan: () => ({
        live: [boundInstance('token-server', 'http://127.0.0.1:1', 1)],
        stale: 0, invalid: 0, truncated: false,
      }),
      fetchImpl: async (_url, init) => {
        authorizations.push(init.headers.authorization);
        return {
          status: 200,
          text: async () => JSON.stringify({
            code: 0, msg: 'success', data: boundMeta({ ok: true }), request_id: 'r',
          }),
        };
      },
    });

    writeFileSync(kimiServerTokenPath(tokenHome), 'x'.repeat(tokenCeiling + 1));
    await tokenAdapter().isAvailable();
    check('an oversized server.token yields no credential at all',
      authorizations.length > 0 && authorizations.every((value) => value === undefined),
      `requests=${authorizations.length}`);

    authorizations.length = 0;
    writeFileSync(kimiServerTokenPath(tokenHome), 'a-real-token\n');
    await tokenAdapter().isAvailable();
    check('a token within the ceiling is still carried as a bearer credential',
      authorizations.length > 0 && authorizations.every((value) => value === 'Bearer a-real-token'),
      `requests=${authorizations.length}`);
  } finally {
    rmSync(tokenHome, { recursive: true, force: true });
  }

  // An injected reader owes the same ceiling the file read applies. One that
  // ignores it must still yield no credential, never a bearer header carrying
  // whatever it returned.
  const injectedAuthorizations: Array<string | undefined> = [];
  await new KimiAdapter({
    env: {}, homeDir: '/fixture/home',
    instanceScan: () => ({
      live: [boundInstance('injected-server', 'http://127.0.0.1:1', 1)],
      stale: 0, invalid: 0, truncated: false,
    }),
    readToken: () => 'x'.repeat(tokenCeiling + 1),
    fetchImpl: async (_url, init) => {
      injectedAuthorizations.push(init.headers.authorization);
      return {
        status: 200,
        text: async () => JSON.stringify({
          code: 0, msg: 'success', data: boundMeta({ ok: true }), request_id: 'r',
        }),
      };
    },
  }).isAvailable();
  check('an oversized INJECTED token yields no credential either',
    injectedAuthorizations.length > 0
      && injectedAuthorizations.every((value) => value === undefined),
    `requests=${injectedAuthorizations.length}`);

  // The snapshot: a reader that hands out a NEW token on every call. If attach
  // read it twice, the socket would carry `token-2` while the HTTP client
  // carried `token-1`.
  let tokenReads = 0;
  const attachAuthorizations: Array<string | undefined> = [];
  const socketTokens: Array<string | undefined> = [];
  const rotating = new KimiAdapter({
    env: {}, homeDir: '/fixture/home',
    instanceScan: () => ({
      live: [boundInstance('rotating-server', 'http://127.0.0.1:1', 1)],
      stale: 0, invalid: 0, truncated: false,
    }),
    readToken: () => `token-${(tokenReads += 1)}`,
    fetchImpl: async (_url, init) => {
      attachAuthorizations.push(init.headers.authorization);
      return {
        status: 200,
        text: async () => JSON.stringify({
          code: 0, msg: 'success',
          data: boundMeta({ items: [], has_more: false }),
          request_id: 'r',
        }),
      };
    },
    observe: {
      socketFactory: (_url, token) => {
        socketTokens.push(token);
        return { send: () => {}, close: () => {}, addEventListener: () => {} };
      },
      setInterval: () => 0,
      clearInterval: () => {},
    },
  });
  const rotatingConnection = await rotating.attach('s-rotating');
  rotatingConnection.subscribe(() => {}); // opening the socket is what spends the token
  await rotatingConnection.close();
  const carried = [...new Set(attachAuthorizations.map((value) => value?.replace(/^Bearer /, '')))];
  check('one attach takes one token snapshot and both transports carry it',
    carried.length === 1 && socketTokens.length === 1 && socketTokens[0] === carried[0],
    `http=${carried.join(',')} socket=${socketTokens.join(',')} reads=${tokenReads}`);

  // ONE snapshot per attach, and a NEW one per generation. The attach verifies
  // an identity for a moment; the connection outlives it, so a server that
  // restarts on another port with another token would otherwise receive the old
  // proof for as long as the connection lives. The reverifier attach installs
  // must therefore re-run the WHOLE gate — a fresh registry scan, the identity
  // check against it, and one new token snapshot for both transports.
  {
    class WiringSocket implements KimiSocketLike {
      private readonly listeners = new Map<string, Array<(event: unknown) => void>>();
      send(): void {}
      close(): void {}
      addEventListener(type: string, listener: (event: unknown) => void): void {
        const list = this.listeners.get(type) ?? [];
        list.push(listener);
        this.listeners.set(type, list);
      }
      fire(type: string): void {
        for (const listener of this.listeners.get(type) ?? []) listener({});
      }
    }

    let generation = 1;
    let scans = 0;
    const sockets: WiringSocket[] = [];
    const socketOpens: Array<{ url: string; token: string | undefined }> = [];
    const httpCalls: Array<{ origin: string; authorization: string | undefined }> = [];
    let wiringTick: (() => void) | undefined;
    const wiring = new KimiAdapter({
      env: {}, homeDir: '/fixture/home',
      // The server this adapter can find, and the credential it can read, both
      // change when the generation does — as they do across a Kimi restart.
      instanceScan: () => {
        scans += 1;
        return {
          live: [boundInstance(
            `wiring-server-${generation}`,
            `http://127.0.0.1:${8_000 + generation}`,
            8_000 + generation,
          )],
          stale: 0, invalid: 0, truncated: false,
        };
      },
      readToken: () => `wiring-token-${generation}`,
      fetchImpl: async (url, init) => {
        httpCalls.push({ origin: new URL(url).origin, authorization: init.headers.authorization });
        return {
          status: 200,
          text: async () => JSON.stringify({
            code: 0, msg: 'success',
            // A restart is a NEW API generation, so its meta id moves too.
            data: boundMeta({ server_id: `api-generation-${generation}`, items: [], has_more: false }),
            request_id: 'r',
          }),
        };
      },
      observe: {
        socketFactory: (url, token) => {
          socketOpens.push({ url, token });
          const socket = new WiringSocket();
          sockets.push(socket);
          return socket;
        },
        setInterval: (handler) => { wiringTick = handler; return 1; },
        clearInterval: () => { wiringTick = undefined; },
      },
    });

    const wiringConnection = await wiring.attach('s-wiring');
    wiringConnection.subscribe(() => {}); // opens the first generation's socket
    const scansAtAttach = scans;
    generation = 2; // the Kimi server restarts: new port, new server id, new token
    sockets[0]!.fire('close');
    await Bun.sleep(30);
    wiringTick?.();
    await Bun.sleep(60);
    check('attach installs a reverifier that re-runs the whole gate on a fresh token snapshot',
      scans > scansAtAttach
        && socketOpens.length === 2
        && socketOpens[1]?.url === 'ws://127.0.0.1:8002/api/v1/ws'
        && socketOpens[1]?.token === 'wiring-token-2'
        && httpCalls.some((call) => call.origin === 'http://127.0.0.1:8002'
          && call.authorization === 'Bearer wiring-token-2'),
      `scans=${scans} (${scansAtAttach} at attach) sockets=${JSON.stringify(socketOpens)}`);
    check('nothing after the restart still speaks to the generation that ended',
      !httpCalls.slice(httpCalls.findIndex((call) => call.origin === 'http://127.0.0.1:8002'))
        .some((call) => call.origin === 'http://127.0.0.1:8001'),
      httpCalls.map((call) => call.origin).join(','));
    await wiringConnection.close();
  }
}

// ── 6. Active/agent time: the capped-inter-event-gap arithmetic ─────────────
//
// The journal records WHEN work happened and never how long it took, so both
// figures are estimates and the ESTIMATOR is what has to be pinned. Two
// properties carry the whole account: a gap counts only up to the cap, and
// overlap between concurrent streams counts ONCE as wall clock while counting
// per stream as agent work.

{
  const cap = KIMI_ACTIVE_GAP_CAP_MS;
  check('the gap cap is five minutes and the method is named',
    cap === 5 * 60 * 1000 && KIMI_ACTIVE_TIME_METHOD === 'capped-inter-event-gap',
    `${cap}ms ${KIMI_ACTIVE_TIME_METHOD}`);

  // Nothing precedes a stream's first event, so a lone event measures ZERO —
  // never "active for as long as the cap allows".
  const single = activeTimeAccount(new Map([['main', [1_000]]]), cap);
  check('a single-event stream measures zero',
    activeIntervals([1_000], cap).length === 0 && single.activeMs === 0 && single.agentMs === 0,
    JSON.stringify(single));

  // 0s / 60s / 600s with a 300s cap: the 60s gap counts whole, the 540s gap
  // truncates to the cap, and the two intervals do not touch.
  const capped = activeTimeAccount(new Map([['main', [0, 60_000, 600_000]]]), 300_000);
  check('a gap past the cap counts only the cap',
    capped.activeMs === 360_000 && capped.agentMs === 360_000,
    JSON.stringify(capped));

  // A repeated or out-of-order timestamp is not work.
  const repeated = activeTimeAccount(new Map([['main', [5_000, 5_000, 4_000]]]), cap);
  check('a non-positive gap contributes nothing',
    repeated.activeMs === 1_000 && repeated.agentMs === 1_000, JSON.stringify(repeated));

  // THE CASE THE TWO FIGURES EXIST FOR: a subagent works one minute inside the
  // main stream's two. Wall clock is still two minutes; agent work is three.
  const parallel = activeTimeAccount(new Map([
    ['main', [0, 60_000, 120_000]],
    ['agent-1', [30_000, 90_000]],
  ]), cap);
  check('a parallel subagent minute adds agentMs and no activeMs',
    parallel.activeMs === 120_000 && parallel.agentMs === 180_000, JSON.stringify(parallel));

  // Disjoint streams have nothing to merge, so the two figures agree.
  const disjoint = activeTimeAccount(new Map([
    ['main', [0, 60_000]],
    ['agent-1', [600_000, 660_000]],
  ]), cap);
  check('disjoint streams add up without double counting',
    disjoint.activeMs === 120_000 && disjoint.agentMs === 120_000, JSON.stringify(disjoint));

  check('merging counts overlapping wall clock once',
    mergedIntervalMs([[0, 100], [50, 150], [400, 500]]) === 250,
    String(mergedIntervalMs([[0, 100], [50, 150], [400, 500]])));
}

// ── 7. The wire-journal reader ──────────────────────────────────────────────
//
// A read-only sidecar over files another product appends to at will, so it owes
// the same discipline as every other reader here: bounded at the ITERATION and
// at the READ, truncation REPORTED rather than silently applied, and the file
// type proven on the opened descriptor. The cases below are the ones where a
// reader that merely "reads the file" goes wrong — a huge journal, a hot
// journal, a half-written line, a rotated file, and a path that is not a file
// at all.

{
  const usageRow = (
    time: number,
    counts: Partial<{ inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number }> = {},
    extra: Record<string, unknown> = {},
  ) => `${JSON.stringify({
    type: 'usage.record',
    model: 'kimi-code/k3',
    usage: {
      inputOther: counts.inputOther ?? 10,
      output: counts.output ?? 1,
      inputCacheRead: counts.inputCacheRead ?? 0,
      inputCacheCreation: counts.inputCacheCreation ?? 0,
    },
    usageScope: 'turn',
    time,
    ...extra,
  })}\n`;

  const wireHome = mkdtempSync(join(tmpdir(), 'kimi-wire-'));
  const wireRoot = join(wireHome, 'sessions');
  const sessionId = 'session_fixture';
  const agentsDirectory = join(wireRoot, 'wd_fixture_a1b2', sessionId, 'agents');
  const wirePath = (stream: string) => join(agentsDirectory, stream, 'wire.jsonl');
  const writeStream = (stream: string, body: string) => {
    mkdirSync(join(agentsDirectory, stream), { recursive: true });
    writeFileSync(wirePath(stream), body);
    return { streamId: stream, wirePath: wirePath(stream) };
  };
  const stubIo = (overrides: Partial<KimiWireIo>): KimiWireIo => ({ ...defaultKimiWireIo, ...overrides });

  try {
    // A decoy workspace that holds a DIFFERENT session: discovery must probe it
    // and move on rather than reading somebody else's journal.
    mkdirSync(join(wireRoot, 'wd_decoy_0000', 'session_someone_else', 'agents', 'main'), { recursive: true });

    const main = writeStream('main', [
      '{"type":"turn.prompt","time":1}',
      usageRow(1_000, { inputOther: 100, output: 10, inputCacheRead: 5, inputCacheCreation: 1 }).trim(),
      'not json at all {{{',
      '{"type":"llm.request","time":2}',
      usageRow(2_000, { inputOther: 200, output: 20 }, { usageScope: 'session' }).trim(),
      '',
    ].join('\n'));
    const subagent = writeStream('agent-1', usageRow(1_500));

    const found = locateKimiWireStreams(wireRoot, sessionId);
    check('discovery finds every agent stream of one session',
      found.streams.map((stream) => stream.streamId).join(',') === 'agent-1,main'
        && found.streams[1]?.wirePath === main.wirePath
        && found.truncated === false,
      found.streams.map((stream) => stream.streamId).join(','));
    check('a session with no journal yields no streams at all',
      locateKimiWireStreams(wireRoot, 'session_absent').streams.length === 0);

    const mainTail = new KimiWireTail([main]);
    const firstRead = mainTail.read();
    check('only usage rows are decoded; every other line is skipped without error',
      firstRead.records.length === 2 && firstRead.failedStreams === 0
        && firstRead.records[0]?.inputOther === 100 && firstRead.records[0]?.output === 10
        && firstRead.records[0]?.inputCacheRead === 5 && firstRead.records[0]?.inputCacheCreation === 1,
      JSON.stringify(firstRead.records));
    check('a session-scoped usage row is kept — compaction is real usage',
      firstRead.records[1]?.timeMs === 2_000 && firstRead.records[1]?.inputOther === 200,
      JSON.stringify(firstRead.records[1]));
    check('a journal inside the tail cap is not reported clipped',
      firstRead.clipped === false && firstRead.oversizedLines === 0);

    appendFileSync(main.wirePath, usageRow(1_000, { inputOther: 100, output: 10, inputCacheRead: 5, inputCacheCreation: 1 }));
    check('an identical usage row appended again is counted once',
      mainTail.read().records.length === 0);
    appendFileSync(main.wirePath, usageRow(3_000));
    check('a genuinely new usage row is read on the next tick',
      mainTail.read().records.map((record) => record.timeMs).join(',') === '3000');

    // A journal is appended to WHILE it is read, so the last line is routinely
    // half-written. Half a line is not a row: it is held until its newline.
    const partial = writeStream('partial', `${usageRow(10_000).trim()}\n${usageRow(11_000).trim().slice(0, 40)}`);
    const partialTail = new KimiWireTail([partial]);
    const held = partialTail.read();
    appendFileSync(partial.wirePath, `${usageRow(11_000).trim().slice(40)}\n`);
    const completed = partialTail.read();
    check('a trailing partial line is held and parsed once it completes',
      held.records.length === 1 && held.records[0]?.timeMs === 10_000
        && completed.records.length === 1 && completed.records[0]?.timeMs === 11_000,
      `held=${held.records.length} completed=${completed.records.length}`);

    // One line must never become unbounded retention.
    const oversized = writeStream('oversized', [
      usageRow(20_000, {}, { pad: 'p'.repeat(KIMI_WIRE_MAX_LINE_BYTES + 1_024) }).trim(),
      usageRow(21_000).trim(),
      '',
    ].join('\n'));
    const oversizedRead = new KimiWireTail([oversized]).read();
    check('an oversized line is dropped, counted, and the next line still parses',
      oversizedRead.oversizedLines === 1 && oversizedRead.records.length === 1
        && oversizedRead.records[0]?.timeMs === 21_000,
      `oversized=${oversizedRead.oversizedLines} records=${oversizedRead.records.length}`);

    // A hot journal must not make ONE tick unbounded: the tick cap is consumed
    // now and the remainder on the next read, with nothing lost in between.
    const rowsPerTick = 400;
    const padded = Array.from({ length: rowsPerTick }, (_unused, index) =>
      usageRow(30_000 + index, {}, { pad: 'p'.repeat(900) })).join('');
    const hot = writeStream('hot', padded);
    const hotTail = new KimiWireTail([hot]);
    const tick1 = hotTail.read();
    const tick2 = hotTail.read();
    const tick3 = hotTail.read();
    const consumed = tick1.records.length + tick2.records.length + tick3.records.length;
    check('the per-tick byte cap defers the remainder to the next read',
      padded.length > KIMI_WIRE_TICK_CAP_BYTES
        && tick1.records.length > 0 && tick1.records.length < rowsPerTick
        && consumed === rowsPerTick
        && new Set([...tick1.records, ...tick2.records, ...tick3.records].map((r) => r.timeMs)).size === rowsPerTick,
      `bytes=${padded.length} ticks=${tick1.records.length}/${tick2.records.length}/${tick3.records.length}`);

    // A pass reports the BYTES it took, not only the rows it decoded. That is
    // the only signal a caller draining a window can trust: rows can be zero
    // while a whole tick cap of tool lines went past. The observe baseline
    // repeats read() until a pass takes nothing at all, so a no-change tick has
    // to report exactly zero.
    const meteredBody = usageRow(50_000) + usageRow(51_000);
    const metered = writeStream('metered', meteredBody);
    const meteredTail = new KimiWireTail([metered]);
    const meteredFirst = meteredTail.read();
    const meteredIdle = meteredTail.read();
    check('a read reports the bytes it consumed, and reports zero when nothing changed',
      meteredFirst.bytesConsumed === Buffer.byteLength(meteredBody)
        && meteredFirst.records.length === 2 && meteredIdle.bytesConsumed === 0,
      `first=${meteredFirst.bytesConsumed} body=${Buffer.byteLength(meteredBody)} idle=${meteredIdle.bytesConsumed}`);

    // A journal older than the tail cap is read from the tail, and the window
    // it could not see is reported for the rest of the connection.
    const filler = `${'f'.repeat(1_023)}\n`;
    const huge = writeStream('huge', filler.repeat(Math.ceil(KIMI_WIRE_TAIL_CAP_BYTES / 1_024) + 200));
    const hugeRead = new KimiWireTail([huge]).read();
    check('a journal past the tail cap is read from its tail and reports the window clipped',
      hugeRead.clipped === true, `clipped=${hugeRead.clipped}`);

    // The WORST placement of that cut: exactly at the start of a complete usage
    // row. Nothing in the bytes says so — the row parses perfectly — so a reader
    // that leans on the parser to reject a mid-line suffix counts a row it may
    // only be seeing half of on some other cut. The contract is the cheaper one:
    // a mid-file start always discards up to the next newline, which here costs
    // one whole row inside a window the same arithmetic already clipped.
    //
    // The fixture makes the cut land there by construction: the region from that
    // row to EOF is EXACTLY one tail cap, so `size - cap` is its first byte.
    const cutRow = usageRow(60_000);
    const afterCut = usageRow(61_000) + usageRow(62_000);
    const cutFillerLine = `${'#'.repeat(1_023)}\n`;
    const cutPadBytes = KIMI_WIRE_TAIL_CAP_BYTES - Buffer.byteLength(cutRow + afterCut);
    const cutWholeLines = Math.floor(cutPadBytes / cutFillerLine.length);
    const cutRestBytes = cutPadBytes - cutWholeLines * cutFillerLine.length;
    const cutTailRegion = cutRow + afterCut + cutFillerLine.repeat(cutWholeLines)
      + (cutRestBytes > 0 ? `${'#'.repeat(cutRestBytes - 1)}\n` : '');
    // Anything at all ahead of the cut; it exists only to push the cut off byte
    // zero, and is never read.
    const cutStream = writeStream('cut', cutFillerLine.repeat(4) + cutTailRegion);
    const cutRead = new KimiWireTail([cutStream]).read();
    check('a tail cut landing exactly at a line start drops that row and keeps the next ones',
      Buffer.byteLength(cutTailRegion) === KIMI_WIRE_TAIL_CAP_BYTES
        && cutRead.records.map((record) => record.timeMs).join(',') === '61000,62000'
        && cutRead.clipped === true,
      `tail=${Buffer.byteLength(cutTailRegion)} cap=${KIMI_WIRE_TAIL_CAP_BYTES}`
      + ` records=${cutRead.records.map((record) => record.timeMs).join(',')} clipped=${cutRead.clipped}`);

    // Rotation/truncation: the held offset now addresses bytes that are gone,
    // and the dedupe memory describes a file that no longer exists.
    const rotating = writeStream('rotating', usageRow(40_000) + usageRow(41_000) + usageRow(42_000));
    const rotatingTail = new KimiWireTail([rotating]);
    const beforeShrink = rotatingTail.read();
    writeFileSync(rotating.wirePath, usageRow(40_000));
    const afterShrink = rotatingTail.read();
    check('a shrunken journal re-tails, clears its dedupe memory, and reports itself clipped',
      beforeShrink.records.length === 3 && beforeShrink.clipped === false
        && afterShrink.records.length === 1 && afterShrink.records[0]?.timeMs === 40_000
        && afterShrink.clipped === true,
      `before=${beforeShrink.records.length} after=${afterShrink.records.length} clipped=${afterShrink.clipped}`);

    // A byte ceiling says nothing about how long an OPEN takes. open(2) on a
    // FIFO for read waits for a writer, so a FIFO dropped where a journal
    // belongs would hang a poll tick with every other bound intact.
    mkdirSync(join(agentsDirectory, 'fifo'), { recursive: true });
    const fifoStream = { streamId: 'fifo', wirePath: wirePath('fifo') };
    let fifoMade = false;
    try {
      fifoMade = Bun.spawnSync(['mkfifo', fifoStream.wirePath]).success;
    } catch {
      fifoMade = false;
    }
    if (fifoMade) {
      const fifoTail = new KimiWireTail([fifoStream]);
      const startedAt = Date.now();
      let fifoThrew = false;
      try {
        fifoTail.readStream(fifoStream);
      } catch {
        fifoThrew = true;
      }
      const elapsed = Date.now() - startedAt;
      check('a FIFO in place of a wire journal is refused instead of waited on',
        fifoThrew && elapsed < 2_000 && fifoTail.read().failedStreams === 1,
        `threw=${fifoThrew} ms=${elapsed}`);
    } else {
      check('a FIFO in place of a wire journal is refused instead of waited on', true,
        'mkfifo unavailable');
    }

    // A symlink points wherever whoever dropped it chose; the open refuses the
    // path itself rather than resolving it.
    mkdirSync(join(agentsDirectory, 'linked'), { recursive: true });
    const linkedStream = { streamId: 'linked', wirePath: wirePath('linked') };
    symlinkSync(main.wirePath, linkedStream.wirePath);
    let symlinkThrew = false;
    try {
      new KimiWireTail([linkedStream]).readStream(linkedStream);
    } catch {
      symlinkThrew = true;
    }
    check('a symlinked wire journal is refused rather than followed', symlinkThrew);

    check('an unreadable stream is counted, not allowed to fail the whole pass',
      new KimiWireTail([{ streamId: 'gone', wirePath: join(agentsDirectory, 'gone', 'wire.jsonl') }, main])
        .read().failedStreams === 1);

    // Truncation must TRAVEL: telemetry built on a partial listing reports
    // itself clipped rather than presenting a partial account as a whole one.
    const workspaceClipped = locateKimiWireStreams(wireRoot, sessionId, stubIo({
      listNames: (directory, maxEntries) => ({
        ...defaultKimiWireIo.listNames(directory, maxEntries),
        truncated: directory === wireRoot,
      }),
    }));
    check('a truncated workspace listing is reported alongside what it did find',
      workspaceClipped.truncated === true && workspaceClipped.streams.length > 0,
      `streams=${workspaceClipped.streams.length}`);

    const agentsClipped = locateKimiWireStreams(wireRoot, sessionId, stubIo({
      listNames: (directory, maxEntries) => ({
        ...defaultKimiWireIo.listNames(directory, maxEntries),
        truncated: directory === agentsDirectory,
      }),
    }));
    check('a truncated agents listing is reported — an unread stream is missing work',
      agentsClipped.truncated === true && agentsClipped.streams.length > 0,
      `streams=${agentsClipped.streams.length}`);

    // The defensive re-cap, the same one scanKimiInstances applies: an io that
    // ignores its own ceiling must still cost bounded work, and its excess must
    // surface as truncation rather than as a silently chosen subset.
    let probes = 0;
    const flooded = locateKimiWireStreams(wireRoot, sessionId, stubIo({
      listNames: (directory, maxEntries) => (directory === wireRoot
        ? {
          names: Array.from({ length: KIMI_WIRE_WORKSPACE_SCAN_MAX + 40 }, (_unused, index) =>
            `wd_flood_${String(index).padStart(4, '0')}`),
          truncated: false,
        }
        : defaultKimiWireIo.listNames(directory, maxEntries)),
      isDirectory: (path) => {
        probes += 1;
        return defaultKimiWireIo.isDirectory(path);
      },
    }));
    check('an io that ignores the workspace ceiling is re-capped and reports truncation',
      flooded.truncated === true && probes === KIMI_WIRE_WORKSPACE_SCAN_MAX,
      `probes=${probes} truncated=${flooded.truncated}`);

    // ── The session id is a PATH COMPONENT, and it comes from outside ───────
    //
    // `join(wireRoot, workspace, sessionId, 'agents')` turns a caller- or
    // server-supplied string into a filesystem path this reader then opens. One
    // separator is all it takes to leave the Kimi home entirely. A rejected id
    // yields NO streams — the honest "no telemetry" answer this module already
    // has for a session with no journal — and never a throw, because this runs
    // inside a poll tick.
    //
    // NEGATIVE CONTROL on the injected io: a rejected id must cost ZERO io
    // calls, which is a stronger statement than "no call outside the root".
    const hostileIds: Array<[string, string]> = [
      ['a parent-directory traversal', '../../etc'],
      ['a bare parent directory', '..'],
      ['a bare current directory', '.'],
      ['an absolute path', '/etc/passwd'],
      ['a forward separator', 'session/../../etc'],
      ['a backslash separator', 'session\\..\\..\\etc'],
      ['a NUL byte', 'session\0/etc'],
      ['an empty id', ''],
    ];
    const admitted: string[] = [];
    for (const [name, hostileId] of hostileIds) {
      let ioCalls = 0;
      const counting = stubIo({
        listNames: (directory, maxEntries) => {
          ioCalls += 1;
          return defaultKimiWireIo.listNames(directory, maxEntries);
        },
        isDirectory: (path) => {
          ioCalls += 1;
          return defaultKimiWireIo.isDirectory(path);
        },
        openRead: (path) => {
          ioCalls += 1;
          return defaultKimiWireIo.openRead(path);
        },
      });
      let threw = '';
      let streams = -1;
      try {
        streams = locateKimiWireStreams(wireRoot, hostileId, counting).streams.length;
      } catch (error) {
        threw = String(error);
      }
      if (streams !== 0 || ioCalls !== 0 || threw !== '') {
        admitted.push(`${name}: streams=${streams} io=${ioCalls} ${threw}`);
      }
    }
    check('an unsafe session id yields zero streams, issues ZERO io calls, and never throws',
      admitted.length === 0, admitted.join(' | '));

    // The workspace name comes from a directory another product writes, so it
    // gets the same rule — and the resolved-path containment behind it is what
    // holds if the component rule ever misses a form.
    let escapeProbed = '';
    const escapingListing = locateKimiWireStreams(wireRoot, sessionId, stubIo({
      listNames: (directory, maxEntries) => (directory === wireRoot
        ? { names: ['..', '../..', 'wd_fixture_a1b2'], truncated: false }
        : defaultKimiWireIo.listNames(directory, maxEntries)),
      isDirectory: (path) => {
        if (!path.startsWith(wireRoot)) escapeProbed = path;
        return defaultKimiWireIo.isDirectory(path);
      },
    }));
    // ...and a legitimate id still resolves, so the rule refuses hostility
    // rather than telemetry: the escaping listing must find exactly what an
    // unmolested one does.
    const honestListing = locateKimiWireStreams(wireRoot, sessionId);
    check('an escaping workspace name is skipped, and the real one is still found',
      escapeProbed === ''
        && honestListing.streams.length > 0
        && escapingListing.streams.map((stream) => stream.streamId).join(',')
          === honestListing.streams.map((stream) => stream.streamId).join(','),
      `probed=${escapeProbed} streams=${escapingListing.streams.map((s) => s.streamId).join(',')}`);
  } finally {
    rmSync(wireHome, { recursive: true, force: true });
  }
}

// ── 8. Fake server + the adapter paths that consume it ──────────────────────

interface ServerLog { method: string; path: string }
const requests: ServerLog[] = [];
const profilePosts: Array<{ id: string; title: unknown }> = [];
/** Multipart uploads the fake server received, parsed into plain fields for assertions. */
const uploadPosts: Array<{ name: string; mediaType: string; text: string }> = [];
let sessionPages = 0;
/** undefined = serve the captured meta verbatim; otherwise patch its `data` first. */
let metaPatch: ((data: Record<string, unknown>) => Record<string, unknown>) | undefined;

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    requests.push({ method: request.method, path: url.pathname });
    const authorized = request.headers.get('authorization') === 'Bearer fixture-token';
    if (request.method === 'POST') {
      // The two writes the fake serves: the native rename route, answering with
      // the success envelope around a session-shaped row like upstream's
      // `sessionProfile.ts` handler does, and the file store's multipart
      // upload, answering the `FileMeta` the door turns into a content part.
      const profile = url.pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/profile$/);
      if (!authorized) return Response.json(FIXTURE.rest.metaUnauthorized, { status: 401 });
      if (url.pathname === '/api/v1/files') {
        const form = await request.formData();
        const part = form.get('file');
        if (!(part instanceof File)) {
          return Response.json({ code: 40001, msg: 'missing `file` field', data: null, request_id: 'fixture' });
        }
        const text = await part.text();
        uploadPosts.push({ name: part.name, mediaType: part.type, text });
        return Response.json({
          code: 0,
          msg: 'success',
          data: {
            id: 'file_fixture_1', name: part.name,
            media_type: part.type || 'application/octet-stream',
            size: text.length, created_at: '2026-08-14T09:00:00.000Z',
          },
          request_id: 'fixture',
        });
      }
      if (profile) {
        const body = await request.json() as { title?: unknown };
        profilePosts.push({ id: decodeURIComponent(profile[1]!), title: body?.title });
        return Response.json({
          code: 0,
          msg: 'success',
          data: { id: decodeURIComponent(profile[1]!), title: body?.title },
          request_id: 'fixture',
        });
      }
      return new Response('method not allowed', { status: 405 });
    }
    if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
    if (url.pathname === '/api/v1/healthz') return Response.json(FIXTURE.rest.healthz);
    if (!authorized) return Response.json(FIXTURE.rest.metaUnauthorized, { status: 401 });
    if (url.pathname === '/api/v1/meta') {
      if (!metaPatch) return Response.json(FIXTURE.rest.meta);
      return Response.json({
        code: 0,
        msg: 'success',
        data: metaPatch({ ...(FIXTURE.rest.meta!.data as Record<string, unknown>) }),
        request_id: 'fixture',
      });
    }
    if (url.pathname === '/api/v2/sessions') {
      sessionPages += 1;
      const body = structuredClone(FIXTURE.rest.v2Sessions) as {
        data: { items: unknown[]; has_more: boolean; next_page_token: string | null };
      };
      if (!url.searchParams.get('page_token')) {
        body.data.has_more = true;
        body.data.next_page_token = 'page-2';
      }
      return Response.json(body);
    }
    return Response.json(FIXTURE.rest.messagesUnknownSession);
  },
});

const listenPort = server.port ?? 0;
const baseUrl = `http://127.0.0.1:${listenPort}`;
// The adapter paths below run against the registry record AS CAPTURED —
// upstream's own `server_id`, `host_version`, and `started_at` — with only the
// address redirected at the fake server on its ephemeral port. Deriving any of
// those three from the served `/meta` instead is what let a gate that no real
// host could pass look healthy across this whole suite.
const FIXTURE_RECORD = decodeKimiInstanceRecord(FIXTURE.instanceRecord)!;
const fixtureInstance = {
  baseUrl,
  port: listenPort,
  pid: FIXTURE_RECORD.pid,
  serverId: FIXTURE_RECORD.serverId,
  hostVersion: FIXTURE_RECORD.hostVersion,
  startedAt: FIXTURE_RECORD.startedAt,
};
const scan: KimiInstanceScan = {
  live: [fixtureInstance],
  stale: 0,
  invalid: 0,
  truncated: false,
};

try {
  const adapter = new KimiAdapter({
    env: {},
    homeDir: '/fixture/home',
    instanceScan: () => scan,
    readToken: () => 'fixture-token',
  });

  // The posture is observe-FIRST and drive-for-owned. `observe` leads
  // `attachModes` because it is the mode every session supports; `live` is
  // reachable only for a session this process created (proved in the drive
  // suite). Resume stays false — the adapter never owns a Kimi process, so
  // there is nothing for it to resume into.
  check('adapter declares the http-websocket observe-plus-drive posture',
    adapter.capabilities.integrationKind === 'http-websocket'
      && adapter.capabilities.attachModes.join(',') === 'observe,live'
      && adapter.capabilities.supportsObserve === true
      && adapter.capabilities.supportsLiveAttach === true
      && adapter.capabilities.supportsResume === false
      && adapter.capabilities.supportsModelSwitch === true
      && adapter.capabilities.permissionGranularity === 'per-session',
    JSON.stringify(adapter.capabilities));
  // Native file input is ON: the prompt schema's image/file content parts are
  // backed by a real pipeline (inline base64 images, `/api/v1/files` uploads),
  // so the capability the broker and client both gate on tells the truth.
  check('adapter advertises native file input and still no artifact signal',
    adapter.capabilities.supportsNativeFileInput === true
      && adapter.capabilities.supportsNativeArtifact === false);
  // Cross-client Drive sharing is a claim about the CONNECTION, not the wire:
  // a joining socket is handed the existing drive connection, so the session
  // keeps exactly one writer. Without the flag the broker offers a second
  // client no join at all and it observes forever. The wire behaviour itself is
  // proved in `broker/test/broker/test-kimi-cross-client-join.ts`.
  check('adapter declares that two clients may share one drive connection',
    adapter.capabilities.supportsCrossClientDriveSharing === true);
  check('adapter advertises session creation and its readiness boundary',
    typeof (adapter as { createSession?: unknown }).createSession === 'function'
      && typeof (adapter as { canCreateSession?: unknown }).canCreateSession === 'function'
      && typeof (adapter as { prepareCreateSession?: unknown }).prepareCreateSession === 'function'
      && typeof (adapter as { listModels?: unknown }).listModels === 'function');

  // ── The DRIVE GATE's off surface ──────────────────────────────────────────
  //
  // Default-off, because nothing in the app can currently REQUEST `mode='live'`
  // — for any adapter — so advertising Drive would put affordances in front of
  // the user that end in a refused attach. With the gate off this adapter is
  // the K1 observe surface exactly.
  // THE WRITE SURFACE IS PRESENT, and presence is what the broker reads.
  //
  // These four used to appear only when `COSYNCING_KIMI_DRIVE` was set, and
  // their ABSENCE was the mechanism of the off state — deliberately absent
  // rather than throwing, because the broker decides what a tool can do by
  // asking whether the method EXISTS: `typeof b.createSession === 'function'`
  // builds the roster row (`runtime.ts:5136-5139`) and `!backend?.createSession`
  // answers the create route (`runtime.ts:4496`). The gate is gone, so the same
  // probe must now find all four.
  const writeSurface = ['createSession', 'canCreateSession', 'prepareCreateSession', 'listModels'] as const;
  check('the create surface is present, so the broker advertises a creatable tool',
    writeSurface.every((name) => typeof (adapter as unknown as Record<string, unknown>)[name] === 'function'),
    writeSurface.map((name) => `${name}=${typeof (adapter as unknown as Record<string, unknown>)[name]}`).join(','));
  check('the adapter advertises observe-first with live attach and model switching',
    adapter.capabilities.attachModes.join(',') === 'observe,live'
      && adapter.capabilities.supportsObserve === true
      && adapter.capabilities.supportsLiveAttach === true
      && adapter.capabilities.supportsModelSwitch === true
      && adapter.capabilities.supportsResume === false
      && adapter.capabilities.integrationKind === 'http-websocket',
    JSON.stringify(adapter.capabilities));
  // OWNERSHIP, not configuration, is what refuses a write now. This fixture
  // created nothing, so every session on it is foreign and a plain `live`
  // attach still refuses through the ownership conflict — the same refusal the
  // rollout gate used to produce as a side effect, arrived at by the rule that
  // was always doing the real work.
  const foreignLive = await adapter.attach(FIXTURE.sessionId, 'live')
    .then(() => undefined, (error: Error) => error);
  check('a live attach on a session this process does not own still refuses',
    isOwnershipConflictError(foreignLive), `${foreignLive?.name ?? '(did not throw)'}`);
  // Every OTHER write-class native action stays absent: each needs its own
  // transcript semantics, and an unimplemented one must not be advertised.
  // Rename is the exception — implemented natively through the profile route,
  // which is also what flips the broker's `canRenameNative`.
  check('adapter advertises native rename and no other unimplemented write action',
    typeof (adapter as unknown as Record<string, unknown>).renameSession === 'function'
      && ['forkSession', 'cloneSession', 'exportTranscript', 'setAgent']
        .every((name) => typeof (adapter as unknown as Record<string, unknown>)[name] !== 'function'));
  // The distinction between the two integration kinds, asserted rather than
  // assumed. `managedRuntime` means a runtime the broker OWNS as its own child
  // and may restart at will — Codex's daemon, OpenCode's serve. `kimi web` is
  // not that: it is a program the user may already be running, so it declares
  // `externalHost`, whose entire contract is that nothing is stopped without
  // proof this broker started it. Claiming the wrong one here would hand a
  // user's own server to code that restarts runtimes freely.
  const integration = (adapter as { integration?: Record<string, unknown> }).integration;
  check('adapter declares an EXTERNAL host, never a broker-owned managed runtime',
    integration?.managedRuntime === undefined
      && (integration?.externalHost as { managed?: unknown } | undefined)?.managed === true,
    JSON.stringify(integration));

  check('isAvailable follows the health contract', await adapter.isAvailable());

  const discovered = await adapter.discoverSessions();
  check('discovery paginates and stops at the bounded page ceiling',
    sessionPages > 1 && discovered.length === sessionPages,
    `pages=${sessionPages} sessions=${discovered.length}`);
  check('discovered rows are all observe-only',
    discovered.every((row) => row.attachMode === 'observe' && row.tool === 'kimi'));

  // A second roster read, kept here after the page-counting check above because
  // every sweep bumps the fixture's page counter. Nothing was created, so the
  // owned set is empty and every row maps foreign — unsupported for Drive, and
  // now carrying the takeover the user can authorize explicitly.
  const foreignRoster = await adapter.discoverSessions();
  check('every listed session maps foreign-shaped, with takeover advertised',
    foreignRoster.length > 0
      && foreignRoster.every((row) => row.attachMode === 'observe'
        && row.control?.drive.supported === false
        && row.control.drive.reason === 'kimi-terminal-owned'
        && row.control.drive.takeoverAvailable === true),
    foreignRoster.map((row) => `${row.attachMode}:${row.control?.drive.supported}`).join(','));

  // Several live servers on one home are NOT interchangeable (each owns
  // whichever sessions it loaded), so the adapter refuses instead of guessing.
  const twoLive: KimiInstanceScan = {
    live: [
      fixtureInstance,
      { ...fixtureInstance, port: listenPort + 1, serverId: 'another-server' },
    ],
    stale: 0,
    invalid: 0,
    truncated: false,
  };
  const ambiguous = new KimiAdapter({
    env: {}, homeDir: '/fixture/home',
    instanceScan: () => twoLive,
    readToken: () => 'fixture-token',
  });
  check('two live instances make the adapter unavailable', !(await ambiguous.isAvailable()));
  check('two live instances yield no sessions rather than one server\'s guess',
    (await ambiguous.discoverSessions()).length === 0);
  check('two live instances refuse attach',
    await ambiguous.attach(FIXTURE.sessionId).then(() => false, (error: Error) => /several Kimi servers/.test(error.message)));

  // The hidden-33rd-record shape on the ADAPTER paths: one visible live
  // server, truncation set — every consuming path refuses.
  const truncatedAdapter = new KimiAdapter({
    env: {}, homeDir: '/fixture/home',
    instanceScan: () => ({ ...scan, truncated: true }),
    readToken: () => 'fixture-token',
  });
  check('a truncated registry makes the adapter unavailable',
    !(await truncatedAdapter.isAvailable()));
  check('a truncated registry yields no sessions rather than one server\'s view',
    (await truncatedAdapter.discoverSessions()).length === 0);
  check('a truncated registry refuses attach',
    await truncatedAdapter.attach('any').then(() => false, (error) =>
      error instanceof Error && error.message.includes('partial view')));

  // A registry record proves only that SOME process holds the pid. The earliest
  // identity evidence available is the authenticated metadata, so a server whose
  // start time the record contradicts must refuse rather than read another
  // server's sessions. NOTE what an impostor is here and what it is not: a
  // registry `server_id` differing from the meta `server_id` is the NORMAL case
  // on every real host, so it is not evidence of anything.
  const impostor = new KimiAdapter({
    env: {}, homeDir: '/fixture/home',
    instanceScan: () => ({
      live: [{ ...fixtureInstance, startedAt: FIXTURE_RECORD.startedAt! - KIMI_STARTUP_BINDING_WINDOW_MS - 1 }],
      stale: 0, invalid: 0, truncated: false,
    }),
    readToken: () => 'fixture-token',
  });
  check('a server whose start time contradicts its registry record is unavailable',
    !(await impostor.isAvailable()));
  check('a contradicted start time refuses attach',
    await impostor.attach(FIXTURE.sessionId).then(() => false, (error: Error) => /registry record/.test(error.message)));

  // The gate must cover EVERY consuming path, not merely the first one checked.
  const verified = new KimiAdapter({
    env: {}, homeDir: '/fixture/home',
    instanceScan: () => scan,
    readToken: () => 'fixture-token',
  });
  const drop = (key: string) => (data: Record<string, unknown>) => {
    delete data[key];
    return data;
  };
  for (const field of ['server_id', 'server_version', 'started_at']) {
    metaPatch = drop(field);
    check(`a /meta without ${field} is unavailable, not trusted`, !(await verified.isAvailable()));
    check(`a /meta without ${field} yields no sessions — discovery cannot fail open`,
      (await verified.discoverSessions()).length === 0);
    check(`a /meta without ${field} refuses attach`,
      await verified.attach(FIXTURE.sessionId).then(() => false, (error: Error) => /cannot read/.test(error.message)));
  }

  metaPatch = (data) => ({ ...data, started_at: new Date(FIXTURE_RECORD.startedAt! - 1).toISOString() });
  check('a server started before its record is unavailable', !(await verified.isAvailable()));
  check('a server started before its record yields no sessions',
    (await verified.discoverSessions()).length === 0);
  check('a server started before its record refuses attach',
    await verified.attach(FIXTURE.sessionId).then(() => false, (error: Error) => /registry record/.test(error.message)));

  metaPatch = (data) => ({ ...data, server_version: '9.9.9' });
  check('a server whose version its record contradicts is unavailable', !(await verified.isAvailable()));
  check('a contradicted version refuses attach',
    await verified.attach(FIXTURE.sessionId).then(() => false, (error: Error) => /different version/.test(error.message)));

  metaPatch = (data) => ({ ...data, dangerous_bypass_auth: true });
  check('a server with its token gate disabled is unavailable — its answer proves nothing',
    !(await verified.isAvailable()));
  check('a token-gate-disabled server refuses attach',
    await verified.attach(FIXTURE.sessionId).then(() => false, (error: Error) => /token gate disabled/.test(error.message)));

  metaPatch = (data) => ({ ...data, server_id: 123 });
  check('a non-string server_id is refused', !(await verified.isAvailable()));
  metaPatch = undefined;
  check('the verified path still works once the captured record and metadata bind',
    (await verified.isAvailable()) && (await verified.discoverSessions()).length > 0);

  // A `kimi web` restarted under a live adapter. Every operation verifies the
  // answering server against the registry record on its own, so the new
  // generation is adopted immediately: no operation is spent refusing, and which
  // operation would have paid — an invisible availability poll, or the user's
  // attach — never becomes a coin flip.
  const restarting = new KimiAdapter({
    env: {}, homeDir: '/fixture/home',
    instanceScan: () => scan,
    readToken: () => 'fixture-token',
  });
  check('an adapter resolves the generation in front of it', await restarting.isAvailable());
  metaPatch = (data) => ({ ...data, server_id: `${String(data.server_id)}-restarted` });
  check('a restarted Kimi is adopted by the very next operation, not refused once first',
    await restarting.isAvailable());
  check('and by the one after it', await restarting.isAvailable());
  metaPatch = undefined;

  const noServer = new KimiAdapter({
    env: {}, homeDir: '/fixture/home',
    instanceScan: () => ({ live: [], stale: 1, invalid: 0, truncated: false }),
    readToken: () => undefined,
  });
  check('no running server yields no sessions and no availability',
    (await noServer.discoverSessions()).length === 0 && !(await noServer.isAvailable()));
  check('no running server refuses attach',
    await noServer.attach(FIXTURE.sessionId).then(() => false, (error: Error) => /no local Kimi server/.test(error.message)));

  // A FOREIGN session (nothing here created it) refuses a live attach with the
  // TYPED conflict, so the broker can relay a structured `attach-conflict` and
  // fall back to Observe on the same socket instead of surfacing a generic
  // socket failure.
  check('a live attach on a foreign session raises the typed ownership conflict',
    await adapter.attach(FIXTURE.sessionId, 'live').then(() => 'resolved', (error: unknown) =>
      isOwnershipConflictError(error) && error.conflict === 'kimi-foreign-session' ? 'conflict' : String(error))
      === 'conflict');
  check('attach still refuses resume outright',
    await adapter.attach(FIXTURE.sessionId, 'resume').then(() => false, (error: Error) =>
      !isOwnershipConflictError(error) && /resume/.test(error.message)));

  // ── Native rename through the profile route ───────────────────────────────
  //
  // The broker's rename endpoint passes a title, or null when the user clears
  // a display-title override. Null has no native expression (the profile schema
  // requires a non-empty string), so it resolves to the session's cwd basename
  // — the same name codex uses for a cleared title.
  //
  // The rename block runs LAST among the server-consuming checks: it is the one
  // path here allowed to POST, and the GET-only audit below is taken over the
  // requests that precede it.
  const getOnlyRequestCount = requests.length;
  {
    const renamed = await adapter.renameSession(FIXTURE.sessionId, 'Renamed from cosyncing');
    const post = profilePosts.at(-1);
    check('rename posts the title to the session profile route',
      post?.id === FIXTURE.sessionId && post.title === 'Renamed from cosyncing',
      JSON.stringify(post));
    check('rename returns the session info patched to the accepted title',
      !!renamed && renamed.id === FIXTURE.sessionId && renamed.title === 'Renamed from cosyncing'
        && renamed.tool === 'kimi' && renamed.cwd === '/fixture/workspace',
      JSON.stringify(renamed));

    // The fixture row's cwd is `/fixture/workspace`, so a cleared override is
    // written back as its basename rather than sent as an empty title the
    // upstream schema would refuse.
    const cleared = await adapter.renameSession(FIXTURE.sessionId, null);
    check('a cleared override renames to the cwd basename, codex-style',
      profilePosts.at(-1)?.title === 'workspace'
        && !!cleared && cleared.title === 'workspace',
      JSON.stringify(profilePosts.at(-1)));

    // An unknown session has no cwd on record: nothing honest to write, so the
    // call is a no-op rather than a guess at a title.
    const beforeUnknown = profilePosts.length;
    const unknown = await adapter.renameSession('session-not-listed', null);
    check('clearing the title of an unlisted session writes nothing',
      unknown === undefined && profilePosts.length === beforeUnknown);

    const down = new KimiAdapter({
      env: {}, homeDir: '/fixture/home',
      instanceScan: () => ({ live: [], stale: 1, invalid: 0, truncated: false }),
      readToken: () => undefined,
    });
    check('rename with no running server refuses',
      await down.renameSession(FIXTURE.sessionId, 'x').then(() => false, (error: Error) =>
        /no local Kimi server/.test(error.message)));
  }

  // ── The upload write door, against the same fake server ──────────────────
  //
  // Exercised DIRECTLY (not through an adapter): the connection-level assembly
  // — broker-staged bytes in, a `file` content part out — is pinned in the
  // drive suite; what belongs here is the door itself, one multipart POST with
  // the part's filename and content-type carrying the name and media type.
  {
    const door = new KimiDriveHttp({ baseUrl, token: 'fixture-token' });
    const outcome = await door.uploadFile({
      name: 'notes.txt', mediaType: 'text/plain',
      bytes: new TextEncoder().encode('hello from the upload door'),
    });
    const upload = uploadPosts.at(-1);
    check('upload posts one multipart file field to /api/v1/files',
      upload?.name === 'notes.txt' && upload.mediaType.split(';')[0] === 'text/plain'
        && upload.text === 'hello from the upload door',
      JSON.stringify(upload));
    check('upload returns the server FileMeta with the file id the prompt part needs',
      outcome.code === 0
        && (outcome.data as { id?: unknown })?.id === 'file_fixture_1'
        && (outcome.data as { size?: unknown })?.size === 'hello from the upload door'.length,
      JSON.stringify(outcome.data));
  }

  // The whole K1 surface — availability, discovery, observe attach, history —
  // ran above the rename block. None of it may have issued anything but a GET:
  // the write door is reachable only from a drive connection on an owned
  // session (and the reviewed rename hook), and this adapter never created one.
  check('the fake server saw only GET requests before the rename block',
    getOnlyRequestCount > 0
      && requests.slice(0, getOnlyRequestCount).every((entry) => entry.method === 'GET'),
    `${getOnlyRequestCount} requests`);
  check('the only POSTs the fake server ever saw are the profile renames and the upload-door test',
    requests.slice(getOnlyRequestCount).filter((entry) => entry.method !== 'GET')
      .every((entry) => entry.method === 'POST'
        && (entry.path.endsWith('/profile') || entry.path === '/api/v1/files'))
      && profilePosts.length === 2 && uploadPosts.length === 1,
    requests.slice(getOnlyRequestCount).filter((entry) => entry.method !== 'GET')
      .map((entry) => `${entry.method} ${entry.path}`).join(','));
} catch (error) {
  check('test harness completed', false, error instanceof Error ? error.message : String(error));
} finally {
  server.stop(true);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
