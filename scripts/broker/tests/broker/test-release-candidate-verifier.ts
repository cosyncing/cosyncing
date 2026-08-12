#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
}

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
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
  operation: () => Promise<void>,
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

console.log('\nPASS 10/10 release candidate verifier checks');
