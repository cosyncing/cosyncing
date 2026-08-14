#!/usr/bin/env bun
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  launchCandidateParityBrowser,
  withCandidateParityBrowser,
  type CandidateBrowserProcess,
  type CandidateBrowserStartupFailure,
} from '../../release/candidate-browser-startup.ts';
import {
  CANDIDATE_CREDENTIAL_FIELD_LABEL,
  candidateBrokerEnvironment,
  brokerIdentityMatchesCandidate,
  isAddressInUse,
  runCandidateBrokerAttempts,
  webIdentityMatchesCandidate,
  type CandidateBrokerProcess,
} from '../../release/verify-candidate-pair.ts';

assert.equal(CANDIDATE_CREDENTIAL_FIELD_LABEL, 'Server token');
console.log('PASS  publication verifier targets the current server token field');

const webIdentity = {
  version: '1.2.3',
  sourceCommit: 'a'.repeat(40),
  dirty: true,
  baseHref: '/cosy/',
  contract: {
    revision: 8,
    minimumClientRevision: 0,
    clientMinimumBrokerRevision: 2,
    surfaceHash: 'fnv1a32:1234abcd',
  },
};
assert.equal(
  webIdentityMatchesCandidate(webIdentity, {
    version: '1.2.3',
    commit: 'a'.repeat(40),
  }),
  false,
);
console.log('PASS  publication verifier rejects a dirty web identity');
assert.equal(
  webIdentityMatchesCandidate(webIdentity, {
    version: '1.2.3',
    commit: 'a'.repeat(40),
    allowDirtyWebReview: true,
  }),
  true,
);
console.log('PASS  explicit review mode accepts the fingerprint-bound dirty web identity');
const brokerIdentity = {
  version: '1.2.3',
  commit: 'a'.repeat(40),
  packaged: true,
  dirty: true,
  schemaVersions: { brokerContract: 8 },
  contract: {
    revision: 8,
    minimumClientRevision: 0,
    surfaceHash: 'fnv1a32:1234abcd',
  },
};
assert.equal(
  brokerIdentityMatchesCandidate(
    brokerIdentity,
    {
      version: '1.2.3',
      commit: 'a'.repeat(40),
      allowDirtyWebReview: true,
    },
    brokerIdentity.contract,
  ),
  true,
);
console.log('PASS  explicit review mode requires the matching dirty broker identity');
assert.equal(
  brokerIdentityMatchesCandidate(
    { ...brokerIdentity, dirty: false },
    {
      version: '1.2.3',
      commit: 'a'.repeat(40),
      allowDirtyWebReview: true,
    },
    brokerIdentity.contract,
  ),
  false,
);
console.log('PASS  review mode rejects a mixed clean/dirty candidate pair');

{
  const verifierSource = readFileSync(
    new URL('../../release/verify-candidate-pair.ts', import.meta.url),
    'utf8',
  );
  const commitWitness = verifierSource.indexOf('const credentialCommitted');
  const sessionNegotiation = verifierSource.indexOf(
    'const encodedSession',
    commitWitness,
  );
  assert.ok(commitWitness >= 0 && sessionNegotiation > commitWitness);
  const afterCredentialCommit = verifierSource.slice(
    commitWitness,
    sessionNegotiation,
  );
  assert.match(
    afterCredentialCommit,
    /await send\('Page\.reload', \{ ignoreCache: false \}\)/,
  );
  assert.match(afterCredentialCommit, /await send\('Page\.navigate'/);
  assert.ok(
    afterCredentialCommit.indexOf("await send('Page.reload'")
      < afterCredentialCommit.indexOf("await send('Page.navigate'"),
    'the token-bearing document must load before revisiting the deep link',
  );
  console.log(
    'PASS  credential commit reloads before revisiting the deep link',
  );

  const probeStart = verifierSource.indexOf('async function probeBuiltClient');
  const probeEnd = verifierSource.indexOf(
    'export function webIdentityMatchesCandidate',
    probeStart,
  );
  const probeSource = verifierSource.slice(probeStart, probeEnd);
  assert.ok(probeStart >= 0 && probeEnd > probeStart);
  assert.match(probeSource, /await withCandidateParityBrowser\(/);
  assert.doesNotMatch(probeSource, /Bun\.spawn/);
  const startupSource = readFileSync(
    new URL('../../release/candidate-browser-startup.ts', import.meta.url),
    'utf8',
  );
  for (const flag of [
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--disable-features=Vulkan,VizDisplayCompositor',
  ]) {
    assert.ok(startupSource.includes(flag), `startup helper is missing ${flag}`);
  }
  console.log('PASS  candidate parity probe is bound to the bounded startup helper');
}

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

function heldStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
    },
  });
}

function fakeProcess(options: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  liveProcesses: Set<CandidateBrokerProcess>;
}): CandidateBrokerProcess {
  let exitCode = options.exitCode ?? null;
  let resolveExit: (code: number) => void = () => {};
  const exited = exitCode === null
    ? new Promise<number>((resolve) => {
      resolveExit = resolve;
    })
    : Promise.resolve(exitCode);
  const process: CandidateBrokerProcess = {
    stdout: stream(options.stdout ?? ''),
    stderr: stream(options.stderr ?? ''),
    exited,
    get exitCode() {
      return exitCode;
    },
    kill() {
      if (exitCode !== null) return;
      exitCode = 143;
      options.liveProcesses.delete(process);
      resolveExit(exitCode);
    },
  };
  if (exitCode === null) options.liveProcesses.add(process);
  return process;
}

function fakeBrowserProcess(options: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  holdOutput?: boolean;
  ignoreGracefulTermination?: boolean;
  signals?: Array<NodeJS.Signals | number | undefined>;
  liveProcesses: Set<CandidateBrowserProcess>;
}): CandidateBrowserProcess {
  let exitCode = options.exitCode ?? null;
  let resolveExit: (code: number) => void = () => {};
  const exited = exitCode === null
    ? new Promise<number>((resolve) => {
      resolveExit = resolve;
    })
    : Promise.resolve(exitCode);
  const browser: CandidateBrowserProcess = {
    stdout: options.holdOutput
      ? heldStream(options.stdout ?? '')
      : stream(options.stdout ?? ''),
    stderr: options.holdOutput
      ? heldStream(options.stderr ?? '')
      : stream(options.stderr ?? ''),
    exited,
    get exitCode() {
      return exitCode;
    },
    kill(signal) {
      options.signals?.push(signal);
      if (exitCode !== null) return;
      if (options.ignoreGracefulTermination && signal !== 'SIGKILL') return;
      exitCode = signal === 'SIGKILL' ? 137 : 143;
      options.liveProcesses.delete(browser);
      resolveExit(exitCode);
    },
  };
  if (exitCode === null) options.liveProcesses.add(browser);
  return browser;
}

function fakeSocket(onClose: () => void = () => {}): WebSocket {
  return { close: onClose } as WebSocket;
}

function browserTestRoot(): string {
  return mkdtempSync(join(tmpdir(), 'cosyncing-browser-startup-test-'));
}

function leaseFactory(activeLeases: Set<number>): () => Promise<{
  port: number;
  release: () => void;
}> {
  let nextPort = 41_000;
  return async () => {
    const port = nextPort;
    nextPort += 1;
    activeLeases.add(port);
    return {
      port,
      release: () => {
        assert.equal(
          activeLeases.delete(port),
          true,
          `port ${port} lease was released more than once`,
        );
      },
    };
  };
}

async function expectFailure(
  operation: () => Promise<unknown>,
  pattern: RegExp,
): Promise<void> {
  await assert.rejects(operation, pattern);
}

const originalWebDirectory = process.env.COSYNCING_WEB_DIR;
try {
  process.env.COSYNCING_WEB_DIR = '/ambient/wrong-build';
  const env = candidateBrokerEnvironment({
    home: '/candidate/home',
    hostHome: '/candidate/host-home',
    webDirectory: '/release/sidecar/app',
  });
  assert.equal(env.COSYNCING_WEB_DIR, '/release/sidecar/app');
  console.log('PASS  release sidecar web directory overwrites the runner environment');
} finally {
  if (originalWebDirectory === undefined) {
    delete process.env.COSYNCING_WEB_DIR;
  } else {
    process.env.COSYNCING_WEB_DIR = originalWebDirectory;
  }
}

{
  const activeLeases = new Set<number>();
  const liveProcesses = new Set<CandidateBrokerProcess>();
  let spawnCount = 0;
  await runCandidateBrokerAttempts({
    maxAttempts: 3,
    reservePort: leaseFactory(activeLeases),
    prepare: (port) => ({ port }),
    spawn: () => {
      spawnCount += 1;
      return fakeProcess({
        stderr: spawnCount === 1 ? 'listen EADDRINUSE 127.0.0.1' : '',
        exitCode: spawnCount === 1 ? 1 : undefined,
        liveProcesses,
      });
    },
    drainOutput: async (output) => await new Response(output).text(),
    verify: async ({ attempt, maxAttempts, broker, stdout, stderr }) => {
      if (broker.exitCode === null) return 'complete';
      await broker.exited;
      const output = `${await stdout}\n${await stderr}`;
      return isAddressInUse(output) && attempt < maxAttempts
        ? 'retry'
        : 'complete';
    },
  });
  assert.equal(spawnCount, 2);
  assert.equal(activeLeases.size, 0);
  assert.equal(liveProcesses.size, 0);
  console.log('PASS  EADDRINUSE retries once without leaking leases or processes');
}

{
  const activeLeases = new Set<number>();
  const liveProcesses = new Set<CandidateBrokerProcess>();
  await expectFailure(
    async () => await runCandidateBrokerAttempts({
      maxAttempts: 1,
      reservePort: leaseFactory(activeLeases),
      prepare: () => {
        throw new Error('injected credential setup failure');
      },
      spawn: () => fakeProcess({ liveProcesses }),
      drainOutput: async (output) => await new Response(output).text(),
      verify: () => 'complete',
    }),
    /injected credential setup failure/,
  );
  assert.equal(activeLeases.size, 0);
  assert.equal(liveProcesses.size, 0);
  console.log('PASS  credential setup failure releases the port lease');
}

{
  const activeLeases = new Set<number>();
  const liveProcesses = new Set<CandidateBrokerProcess>();
  await expectFailure(
    async () => await runCandidateBrokerAttempts({
      maxAttempts: 1,
      reservePort: leaseFactory(activeLeases),
      prepare: () => ({}),
      spawn: () => {
        throw new Error('injected spawn failure');
      },
      drainOutput: async (output) => await new Response(output).text(),
      verify: () => 'complete',
    }),
    /injected spawn failure/,
  );
  assert.equal(activeLeases.size, 0);
  assert.equal(liveProcesses.size, 0);
  console.log('PASS  spawn failure releases the port lease');
}

{
  const activeLeases = new Set<number>();
  const liveProcesses = new Set<CandidateBrokerProcess>();
  await expectFailure(
    async () => await runCandidateBrokerAttempts({
      maxAttempts: 1,
      reservePort: leaseFactory(activeLeases),
      prepare: () => ({}),
      spawn: () => fakeProcess({ liveProcesses }),
      drainOutput: () => {
        throw new Error('injected output-drain setup failure');
      },
      verify: () => 'complete',
    }),
    /injected output-drain setup failure/,
  );
  assert.equal(activeLeases.size, 0);
  assert.equal(liveProcesses.size, 0);
  console.log('PASS  output-drain setup failure terminates the broker and releases its lease');
}

{
  const root = browserTestRoot();
  const liveProcesses = new Set<CandidateBrowserProcess>();
  const profiles: string[] = [];
  const failures: CandidateBrowserStartupFailure[] = [];
  const firstSignals: Array<NodeJS.Signals | number | undefined> = [];
  const liveProcessesBeforeSpawn: number[] = [];
  let spawnCount = 0;
  try {
    const session = await launchCandidateParityBrowser({
      executable: '/test/chromium-headless-shell',
      profileRoot: root,
      startupTimeoutMs: 5,
      pollIntervalMs: 1,
      terminationTimeoutMs: 3,
      outputDrainTimeoutMs: 3,
      spawn: (_executable, profile) => {
        liveProcessesBeforeSpawn.push(liveProcesses.size);
        spawnCount += 1;
        profiles.push(profile);
        if (spawnCount === 2) {
          writeFileSync(join(profile, 'DevToolsActivePort'), '41234\n/devtools/browser/test\n');
        }
        return fakeBrowserProcess({
          liveProcesses,
          ignoreGracefulTermination: spawnCount === 1,
          holdOutput: spawnCount === 1,
          signals: spawnCount === 1 ? firstSignals : undefined,
        });
      },
      connect: async () => fakeSocket(),
      reportFailure: (failure) => failures.push(failure),
    });
    assert.equal(spawnCount, 2);
    assert.deepEqual(liveProcessesBeforeSpawn, [0, 0]);
    assert.equal(new Set(profiles).size, 2);
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.attempt, 1);
    assert.equal(failures[0]!.devToolsActivePort.existed, false);
    assert.deepEqual(firstSignals, ['SIGTERM', 'SIGKILL']);
    assert.equal(failures[0]!.cleanup.gracefulTimedOut, true);
    assert.equal(failures[0]!.cleanup.forceKillSent, true);
    assert.equal(failures[0]!.cleanup.forceKillTimedOut, false);
    assert.equal(failures[0]!.cleanup.stdoutDrainTimedOut, true);
    assert.equal(failures[0]!.cleanup.stderrDrainTimedOut, true);
    await session.cleanup();
    assert.equal(liveProcesses.size, 0);
    assert.deepEqual(readdirSync(root), []);
    console.log('PASS  delayed first browser startup retries once with a fresh profile');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = browserTestRoot();
  const liveProcesses = new Set<CandidateBrowserProcess>();
  const signals: Array<NodeJS.Signals | number | undefined> = [];
  try {
    const session = await launchCandidateParityBrowser({
      executable: '/test/stubborn-ready-browser',
      profileRoot: root,
      terminationTimeoutMs: 3,
      outputDrainTimeoutMs: 3,
      spawn: (_executable, profile) => {
        writeFileSync(join(profile, 'DevToolsActivePort'), '41238\n');
        return fakeBrowserProcess({
          liveProcesses,
          ignoreGracefulTermination: true,
          holdOutput: true,
          signals,
        });
      },
      connect: async () => fakeSocket(),
    });
    const started = performance.now();
    await expectFailure(
      async () => await session.cleanup(),
      /stdout drain timed out; stderr drain timed out/,
    );
    assert.ok(performance.now() - started < 500);
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(liveProcesses.size, 0);
    assert.deepEqual(readdirSync(root), []);
    console.log('PASS  normal cleanup force-kills and bounds retained output pipes');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = browserTestRoot();
  const liveProcesses = new Set<CandidateBrowserProcess>();
  const failures: CandidateBrowserStartupFailure[] = [];
  try {
    await expectFailure(
      async () => await launchCandidateParityBrowser({
        executable: '/test/early-exit-browser',
        profileRoot: root,
        maxAttempts: 1,
        startupTimeoutMs: 10,
        pollIntervalMs: 1,
        spawn: () => fakeBrowserProcess({
          stdout: 'x'.repeat(5_000),
          stderr: 'browser exploded',
          exitCode: 17,
          liveProcesses,
        }),
        reportFailure: (failure) => failures.push(failure),
      }),
      /failed after 1 attempts/,
    );
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.executable, '/test/early-exit-browser');
    assert.equal(failures[0]!.attempt, 1);
    assert.ok(failures[0]!.elapsedMs >= 0);
    assert.deepEqual(failures[0]!.browserExitState, {
      beforeCleanup: 17,
      afterCleanup: 17,
    });
    assert.equal(failures[0]!.devToolsActivePort.existed, false);
    assert.equal(failures[0]!.stdout.length, 4_096);
    assert.equal(failures[0]!.stderr, 'browser exploded');
    assert.equal(liveProcesses.size, 0);
    assert.deepEqual(readdirSync(root), []);
    console.log('PASS  early browser exit reports bounded startup diagnostics');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = browserTestRoot();
  const liveProcesses = new Set<CandidateBrowserProcess>();
  const profiles: string[] = [];
  const failures: CandidateBrowserStartupFailure[] = [];
  const liveProcessesBeforeSpawn: number[] = [];
  let clock = 0;
  let connectCount = 0;
  try {
    await expectFailure(
      async () => await launchCandidateParityBrowser({
        executable: '/test/never-ready-browser',
        profileRoot: root,
        startupTimeoutMs: 4,
        pollIntervalMs: 1,
        spawn: (_executable, profile) => {
          liveProcessesBeforeSpawn.push(liveProcesses.size);
          profiles.push(profile);
          writeFileSync(join(profile, 'DevToolsActivePort'), '41239\n');
          return fakeBrowserProcess({ liveProcesses });
        },
        connect: async () => {
          connectCount += 1;
          throw new Error(`injected CDP connection failure ${connectCount}`);
        },
        now: () => clock,
        sleep: async (milliseconds) => { clock += milliseconds; },
        reportFailure: (failure) => failures.push(failure),
      }),
      /failed after 2 attempts/,
    );
    assert.deepEqual(failures.map(({ attempt }) => attempt), [1, 2]);
    assert.ok(failures.every(({ failure }) =>
      failure.includes('last CDP connection error: injected CDP connection failure')));
    assert.deepEqual(liveProcessesBeforeSpawn, [0, 0]);
    assert.equal(new Set(profiles).size, 2);
    assert.equal(liveProcesses.size, 0);
    assert.deepEqual(readdirSync(root), []);
    console.log('PASS  two exhausted browser starts leave no process or profile');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = browserTestRoot();
  const liveProcesses = new Set<CandidateBrowserProcess>();
  let closeCount = 0;
  try {
    const session = await launchCandidateParityBrowser({
      executable: '/test/ready-browser',
      profileRoot: root,
      spawn: (_executable, profile) => {
        writeFileSync(join(profile, 'DevToolsActivePort'), '41235\n');
        return fakeBrowserProcess({ liveProcesses });
      },
      connect: async () => fakeSocket(() => {
        closeCount += 1;
      }),
    });
    await session.cleanup();
    await session.cleanup();
    assert.equal(closeCount, 1);
    assert.equal(liveProcesses.size, 0);
    assert.deepEqual(readdirSync(root), []);
    console.log('PASS  browser cleanup is idempotent and removes its profile');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = browserTestRoot();
  const liveProcesses = new Set<CandidateBrowserProcess>();
  const failures: CandidateBrowserStartupFailure[] = [];
  const profiles: string[] = [];
  let spawnCount = 0;
  let connectCount = 0;
  try {
    const session = await launchCandidateParityBrowser({
      executable: '/test/cdp-failure-browser',
      profileRoot: root,
      pollIntervalMs: 1,
      spawn: (_executable, profile) => {
        spawnCount += 1;
        profiles.push(profile);
        writeFileSync(join(profile, 'DevToolsActivePort'), '41236\n');
        return fakeBrowserProcess({ liveProcesses });
      },
      connect: async () => {
        connectCount += 1;
        if (connectCount === 1) {
          throw new Error('injected WebSocket failure');
        }
        return fakeSocket();
      },
      reportFailure: (failure) => failures.push(failure),
    });
    assert.equal(spawnCount, 1);
    assert.equal(connectCount, 2);
    assert.equal(new Set(profiles).size, 1);
    assert.equal(failures.length, 0);
    await session.cleanup();
    assert.equal(liveProcesses.size, 0);
    assert.deepEqual(readdirSync(root), []);
    console.log('PASS  a transient CDP connection failure retries within the same live profile');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

{
  const root = browserTestRoot();
  const liveProcesses = new Set<CandidateBrowserProcess>();
  let spawnCount = 0;
  let closeCount = 0;
  try {
    await expectFailure(
      async () => await withCandidateParityBrowser({
        executable: '/test/product-failure-browser',
        profileRoot: root,
        spawn: (_executable, profile) => {
          spawnCount += 1;
          writeFileSync(join(profile, 'DevToolsActivePort'), '41237\n');
          return fakeBrowserProcess({ liveProcesses });
        },
        connect: async () => fakeSocket(() => {
          closeCount += 1;
        }),
      }, async () => {
        throw new Error('injected credential contract failure');
      }),
      /injected credential contract failure/,
    );
    assert.equal(spawnCount, 1);
    assert.equal(closeCount, 1);
    assert.equal(liveProcesses.size, 0);
    assert.deepEqual(readdirSync(root), []);
    console.log('PASS  post-CDP product failure is cleaned up without retry');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

console.log('\nPASS 19/19 release candidate verifier checks');
