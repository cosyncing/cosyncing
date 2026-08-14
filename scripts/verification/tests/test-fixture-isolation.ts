#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import {
  captureProcessOutput,
  freshModuleSpecifier,
  isolatedBrokerFixtureEnvironment,
  settledProcessOutput,
  waitForBrokerHealth,
} from '../../../packages/typescript/broker/test/helpers/isolated-broker-fixture.ts';
import { entryPointsFor, scanSource } from '../audit-suite-isolation.ts';

let checks = 0;
function assert(condition: unknown, message: string): asserts condition {
  checks += 1;
  if (!condition) throw new Error(message);
}

const root = mkdtempSync(join(tmpdir(), 'cosyncing-fixture-isolation-'));
try {
  const hostile = {
    ...process.env,
    HOME: '/host/home',
    XDG_CONFIG_HOME: '/host/config',
    XDG_STATE_HOME: '/host/state',
    XDG_CACHE_HOME: '/host/cache',
    CLAUDE_CONFIG_DIR: '/host/claude',
    PI_CODING_AGENT_DIR: '/host/pi',
    PI_CODING_AGENT_SESSION_DIR: '/host/pi-sessions',
    ANTHROPIC_API_KEY: 'host-secret',
    ANTHROPIC_AUTH_TOKEN: 'host-secret',
    ANTHROPIC_BASE_URL: 'https://host-provider.invalid',
    CLAUDE_CODE_API_KEY_HELPER: '/host/credential-helper',
    OPENAI_API_KEY: 'host-secret',
    COSYNCING_TOKEN: 'host-secret',
    COSYNCING_HOME: '/host/cosyncing',
    PORT: '7734',
  };
  const isolated = isolatedBrokerFixtureEnvironment(root, {
    source: hostile,
    overrides: {
      PORT: '18734',
      HOST: '127.0.0.1',
      CLAUDE_CONFIG_DIR: join(root, 'explicit-claude'),
    },
  });

  assert(isolated.HOME === join(root, 'home'), 'HOME must be fixture-owned');
  assert(
    isolated.XDG_CONFIG_HOME === join(root, 'xdg-config'),
    'XDG config must be fixture-owned',
  );
  assert(
    isolated.XDG_STATE_HOME === join(root, 'xdg-state'),
    'XDG state must be fixture-owned',
  );
  assert(
    isolated.CLAUDE_CONFIG_DIR === join(root, 'explicit-claude'),
    'an explicit Claude fixture must override the isolated default',
  );
  assert(
    isolated.PI_CODING_AGENT_DIR === join(root, 'pi-agent'),
    'Pi discovery must be fixture-owned',
  );
  assert(
    isolated.PI_CODING_AGENT_SESSION_DIR === join(root, 'pi-sessions'),
    'Pi sessions must be fixture-owned',
  );
  assert(
    isolated.COSYNCING_HOME === join(root, 'cosyncing-home'),
    'broker state must be fixture-owned',
  );
  assert(isolated.PORT === '18734', 'explicit fixture port must be retained');
  for (const key of [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_API_KEY_HELPER',
    'OPENAI_API_KEY',
    'COSYNCING_TOKEN',
  ]) {
    assert(!(key in isolated), `${key} must not reach a spawned broker`);
  }

  const bridgePath = resolve(
    import.meta.dir,
    '../../../packages/typescript/adapters/pi/agent-extensions/cosyncing-bridge/index.ts',
  );
  await import(
    resolve(
      import.meta.dir,
      '../../../packages/typescript/adapters/pi/src/bridge-asset.ts',
    )
  );
  const firstSpecifier = freshModuleSpecifier(bridgePath, root);
  const secondSpecifier = freshModuleSpecifier(bridgePath, root);
  assert(
    firstSpecifier !== secondSpecifier,
    'fresh module specifiers must bypass process module cache',
  );
  const first = await import(firstSpecifier);
  const second = await import(secondSpecifier);
  assert(
    typeof first.dangerousBashCommand === 'function'
      && typeof second.dangerousBashCommand === 'function',
    'fresh Pi bridge imports must retain dangerousBashCommand visibility',
  );
  assert(
    first.dangerousBashCommand('sudo -n true') === true
      && second.dangerousBashCommand(
        "printf 'rm -fr /tmp/cosyncing-danger'",
      ) === false,
    'dangerous command policy must survive repeated fresh imports',
  );

  /* ---------------- readiness waits are bounded, in every direction ------- */

  // Each case is a way the wait used to be able to outlive its own deadline,
  // which is what put a suite's readiness budget on the critical path.
  const listening = createServer();
  // Every connection the silent server accepts, so a probe that is still
  // running after its wait ended is observable rather than inferred.
  const probeSockets = new Set<Socket>();
  listening.on('connection', (socket) => {
    probeSockets.add(socket);
    socket.on('close', () => probeSockets.delete(socket));
  });
  const answering = createServer((_, response) => { response.end('ok'); });
  try {
    await new Promise<void>((done) => answering.listen(0, '127.0.0.1', done));
    const answeringPort = (answering.address() as { port: number }).port;
    const live = { exitCode: null, exited: new Promise<number>(() => {}) };

    await waitForBrokerHealth(live, `http://127.0.0.1:${answeringPort}/health`, {
      timeoutMs: 5_000,
    });
    assert(true, 'a broker that answers is ready at once');

    const exitedEarly = { exitCode: null as number | null, exited: Promise.resolve(3) };
    const exitFailure = await waitForBrokerHealth(
      exitedEarly,
      'http://127.0.0.1:1/health',
      { timeoutMs: 30_000 },
    ).then(() => null, (error: Error) => error.message);
    assert(
      exitFailure?.includes('exited with code 3'),
      `an exit must fail the wait at once, not at the deadline (${exitFailure})`,
    );

    // Accepts the connection and never replies: the case a per-request timeout
    // exists for. Without one this hung until the outer suite timeout.
    await new Promise<void>((done) => listening.listen(0, '127.0.0.1', done));
    const silentPort = (listening.address() as { port: number }).port;
    const startedAt = Date.now();
    const silentFailure = await waitForBrokerHealth(
      live,
      `http://127.0.0.1:${silentPort}/health`,
      { timeoutMs: 1_500, probeTimeoutMs: 200 },
    ).then(() => null, (error: Error) => error.message);
    const elapsed = Date.now() - startedAt;
    assert(
      silentFailure?.includes('did not become healthy'),
      `a server that never answers must hit the deadline (${silentFailure})`,
    );
    assert(
      elapsed < 6_000,
      `the deadline must bound an unanswered probe (waited ${elapsed}ms)`,
    );

    // A wait that has ended must not leave its probe running. The deadline
    // here is far shorter than the per-probe timeout, so an uncancelled probe
    // shows up two ways: the call itself waits out the probe, or the
    // connection is still open after the call rejected. Bounding what the
    // caller awaits was only half the fix — the losing work has to stop too,
    // because the caller's next move is to kill the broker it is talking to.
    const cancelStartedAt = Date.now();
    const cancelFailure = await waitForBrokerHealth(
      live,
      `http://127.0.0.1:${silentPort}/health`,
      { timeoutMs: 300, probeTimeoutMs: 30_000 },
    ).then(() => null, (error: Error) => error.message);
    const cancelElapsed = Date.now() - cancelStartedAt;
    assert(
      cancelFailure?.includes('did not become healthy'),
      `the short deadline must be what fails (${cancelFailure})`,
    );
    assert(
      cancelElapsed < 5_000,
      `the call must not wait out its own probe (took ${cancelElapsed}ms)`,
    );
    for (let waited = 0; waited < 40 && probeSockets.size > 0; waited += 1) {
      await Bun.sleep(25);
    }
    assert(
      probeSockets.size === 0,
      `no probe may outlive the wait (${probeSockets.size} still open)`,
    );
  } finally {
    listening.close();
    answering.close();
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

/**
 * The isolation lint has to catch hazards written the way this repo writes
 * them.
 *
 * `host-environment-passthrough` was present, documented, and dead: rules ran a
 * line at a time, and the prevailing style puts `...process.env` on the line
 * after the `env:` that carries it. Ten suites were in the parallel group on
 * the strength of a rule that had never matched anything. A rule that matches
 * nothing looks exactly like a rule with nothing to find, so each one is given
 * text it must flag and text it must not.
 */
const rulesOf = (source: string): string[] =>
  [...new Set(scanSource(source, 'fixture.ts').map((hazard) => hazard.rule))].sort();

{
  const packageEntryPoints = entryPointsFor([
    'bun',
    'run',
    'packages/typescript/broker/test/broker/test-tool-semantics.ts',
  ]);
  assert(
    packageEntryPoints.some((path) =>
      path.endsWith('packages/typescript/broker/test/broker/test-tool-semantics.ts')
    ),
    'the isolation audit must resolve package-owned test entry points',
  );

  const multiline = rulesOf(
    "const child = Bun.spawn(['bun', 'x'], {\n"
      + '  env: {\n'
      + '    ...process.env,\n'
      + "    PORT: '1',\n"
      + '  },\n'
      + '});\n',
  );
  assert(
    multiline.includes('host-environment-passthrough'),
    `a spread on the line after \`env: {\` must be caught (${multiline.join(', ')})`,
  );

  const inline = rulesOf("Bun.spawn(['x'], { env: { ...process.env } });\n");
  assert(
    inline.includes('host-environment-passthrough'),
    `the single-line spelling must still be caught (${inline.join(', ')})`,
  );

  const hazard = scanSource(
    'const a = 1;\nconst options = {\n  env: {\n    ...process.env,\n  },\n};\n',
    'fixture.ts',
  ).find((found) => found.rule === 'host-environment-passthrough');
  assert(
    hazard?.line === 4,
    `the hazard must be reported at the spread itself (${hazard?.line})`,
  );

  // The copy is the hazard, not the `env:` that happens to carry it. A fixture
  // that builds the environment into a variable and spawns with it two hundred
  // lines later is doing the same thing, and an `env:`-anchored rule read that
  // as clean.
  const viaVariable = rulesOf(
    'const brokerEnv = { ...process.env };\ndelete brokerEnv.ONE;\nspawn({ env: brokerEnv });\n',
  );
  assert(
    viaVariable.includes('host-environment-passthrough'),
    `a spread into a variable is still a passthrough (${viaVariable.join(', ')})`,
  );

  // Reading one variable is not copying all of them.
  const singleRead = rulesOf(
    "spawn({ env: { PATH: `${bin}:${process.env.PATH ?? ''}` } });\n",
  );
  assert(
    !singleRead.includes('host-environment-passthrough'),
    `naming one variable is not a passthrough (${singleRead.join(', ')})`,
  );

  const commented = rulesOf('// env: { ...process.env }\n');
  assert(
    !commented.includes('host-environment-passthrough'),
    'prose about a hazard is not a hazard',
  );

  // `require` and `allow` decide on the surrounding code, so they must survive
  // matching against whole-file source rather than one line.
  const payloadPath = rulesOf("const expected = { cwd: '/tmp/recorded-run' };\n");
  assert(
    !payloadPath.includes('fixed-temp-path'),
    `an unopened path in fixture data is not a collision (${payloadPath.join(', ')})`,
  );

  const usedPath = rulesOf("writeFileSync('/tmp/cosyncing-fixture', body);\n");
  assert(
    usedPath.includes('fixed-temp-path'),
    `a fixed path that is written must be caught (${usedPath.join(', ')})`,
  );

  const uniquePath = rulesOf(
    "const dir = mkdtempSync('/tmp/cosyncing-fixture-');\nwriteFileSync(dir, body);\n",
  );
  assert(
    !uniquePath.includes('fixed-temp-path'),
    `an mkdtemp prefix cannot collide (${uniquePath.join(', ')})`,
  );
}

/**
 * A capture has to say when it is finished, not only what it has.
 *
 * The readers are separate async tasks, so a child's exit does not mean its
 * pipes have been drained. Assertions about the COMPLETE output — "the
 * shutdown line was printed once", "this credential appears nowhere" — read
 * through that race if they sample instead of awaiting, and the end of the log
 * is exactly where a shutdown path prints.
 */
/**
 * A capture has to say when it is finished, not only what it has.
 *
 * The readers are separate async tasks, so nothing in the API says they have
 * drained when `child.exited` resolves. Assertions about the COMPLETE output —
 * "the shutdown line was printed once", "this credential appears nowhere" —
 * read through that gap if they sample instead of awaiting, and the end of the
 * log is exactly where a shutdown path prints.
 *
 * Driven over a stream this test controls rather than a real child. Trying to
 * lose the race against a spawned process proved nothing: Bun drained every
 * volume tried here before `exited` resolved, so a passing sample would have
 * been a statement about one runtime's scheduling, not about the contract.
 */
{
  let push: (chunk: string) => void = () => {};
  let finish: () => void = () => {};
  const pending = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      push = (chunk) => controller.enqueue(encoder.encode(chunk));
      finish = () => controller.close();
    },
  });
  const capture = captureProcessOutput({ stdout: pending }, { maxChars: Infinity });
  push('first\n');
  await Bun.sleep(10);
  push('LAST-LINE\n');
  // Not yet closed: this is the state a caller is in when it samples after an
  // exit, and the sample is allowed to be short.
  let settled = false;
  void capture.done.then(() => { settled = true; });
  await Bun.sleep(10);
  assert(!settled, 'done must not resolve while the stream is still open');
  finish();
  const complete = await settledProcessOutput(capture);
  assert(settled, 'done must resolve once the stream closes');
  assert(
    complete.includes('first') && complete.includes('LAST-LINE'),
    `awaiting EOF must yield the whole stream (${JSON.stringify(complete)})`,
  );

  // The bound is the point: a grandchild holding the inherited write end means
  // EOF never arrives, and that must not become the test.
  const neverCloses = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('early\n'));
    },
  });
  const held = captureProcessOutput({ stdout: neverCloses }, { maxChars: Infinity });
  const startedAt = Date.now();
  const partial = await settledProcessOutput(held, 200);
  assert(
    Date.now() - startedAt < 3_000,
    `an unclosed pipe must not hold the assertion open (${Date.now() - startedAt}ms)`,
  );
  assert(partial.includes('early'), 'a bounded wait still returns what was read');

  // A character split across two chunks needs no flush — the decoder completes
  // it when the second chunk arrives.
  const split = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0x63, 0x61, 0x66, 0xc3]));
      controller.enqueue(new Uint8Array([0xa9]));
      controller.close();
    },
  });
  assert(
    (await settledProcessOutput(
      captureProcessOutput({ stdout: split }, { maxChars: Infinity }),
    )) === 'caf\u00e9',
    'a character split across chunks must be reassembled',
  );

  // A stream that ENDS mid-character is what the flush is for: a killed
  // process can cut its own output anywhere. Without the flush the trailing
  // bytes vanish and the log silently claims to be complete; with it they
  // become the replacement character, which says the output was truncated.
  const truncated = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0x63, 0x61, 0x66, 0xc3]));
      controller.close();
    },
  });
  assert(
    (await settledProcessOutput(
      captureProcessOutput({ stdout: truncated }, { maxChars: Infinity }),
    )) === 'caf\ufffd',
    'a stream ending mid-character must flush to a replacement, not drop it',
  );
}

console.log(`PASS ${checks}/${checks} fixture-isolation checks`);
