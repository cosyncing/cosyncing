#!/usr/bin/env bun
/**
 * `@cosyncing/acp-client` unit tests against a FAKE ACP stdio child: an
 * in-process bun stub speaking recorded envelopes (the codex `resume-fake.ts`
 * / agy `writeFakeAgyBinary` pattern — the suite writes a fake binary into a
 * temp dir and spawns it). The envelopes live in
 * `fixtures/fake-acp-v0.json`, named by agent+version; the real reasonix
 * step-0 smoke capture (probe R1) files beside it in Phase 1.
 *
 * Covered: handshake, correlation, notification dispatch, cancel, the
 * permission round-trip, extension routing, tolerant decode (string/number
 * `protocolVersion`, unknown fields preserved), dead-child reject, and
 * trace-on-unknown-frame.
 *
 *   bun run packages/typescript/acp-client/test/test-acp-client.ts
 */
export {};
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AcpClient,
  AcpRequestTimeoutError,
  AcpRpcError,
  type AcpClientHooks,
  type AcpExtensionEvent,
  type AcpRequestPermissionParams,
  type AcpSessionUpdateParams,
  type AcpTraceEvent,
} from '../src/index.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
}

// ── The fake ACP child ───────────────────────────────────────────────────────
//
// A config-driven bun stub: it answers `initialize` with a configurable
// `protocolVersion` encoding, speaks `session/new`/`load`/`list`/`prompt`,
// pushes recorded `session/update` notifications and raw frames, can issue a
// `session/request_permission` request mid-prompt, can die before answering,
// and logs every inbound frame to an NDJSON ledger the suite reads back.

function writeFakeAcpBinary(dir: string): string {
  const binPath = join(dir, 'fake-acp.js');
  writeFileSync(
    binPath,
    `import { appendFileSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
const config = JSON.parse(readFileSync(process.env.FAKE_ACP_CONFIG, 'utf8'));
const log = (entry) => appendFileSync(config.log, JSON.stringify(entry) + '\\n');
const send = (frame) => process.stdout.write(JSON.stringify(frame) + '\\n');
if (Number.isSafeInteger(config.emitStderrBytes) && config.emitStderrBytes > 0) {
  process.stderr.write('e'.repeat(config.emitStderrBytes));
}
let pendingPromptId = null;
let permissionId = null;
function handle(frame) {
  log({ received: frame });
  // A response to an agent-issued request (the permission answer, or the
  // client's error answer to the terminal/create probe).
  if (frame.method === undefined) {
    if (permissionId !== null && String(frame.id) === String(permissionId) && pendingPromptId !== null) {
      send({ jsonrpc: '2.0', id: pendingPromptId, result: {
        stopReason: 'end_turn',
        permissionEcho: frame.result === undefined ? null : frame.result,
        permissionError: frame.error === undefined ? null : frame.error,
      } });
      pendingPromptId = null;
      permissionId = null;
    }
    return;
  }
  if (frame.id === undefined) return; // a notification; the ledger line is enough
  if (frame.method === 'initialize') {
    if (config.blockInitialize) return;
    if (config.initializeError) {
      send({ jsonrpc: '2.0', id: frame.id, error: config.initializeError });
      return;
    }
    const result = {
      protocolVersion: config.protocolVersion === undefined ? 1 : config.protocolVersion,
      agentCapabilities: { loadSession: true },
      agentInfo: { name: 'fake-acp', version: '0.0.0-fake' },
    };
    if (config.initializeExtra) Object.assign(result, config.initializeExtra);
    send({ jsonrpc: '2.0', id: frame.id, result: result });
    if (config.closeStdinAfterInitialize) {
      setInterval(() => {}, 1_000);
      process.stdin.pause();
      process.stdin._handle.close();
    }
    if (config.emitMalformed) process.stdout.write('{ not json\\n');
    if (config.emitUnterminatedBytes) process.stdout.write('x'.repeat(config.emitUnterminatedBytes));
    return;
  }
  if (frame.method === 'session/new') {
    send({ jsonrpc: '2.0', id: frame.id, result: { sessionId: config.sessionId || 'fake-session-1' } });
    return;
  }
  if (frame.method === 'authenticate') {
    if (config.authenticateError) {
      send({ jsonrpc: '2.0', id: frame.id, error: config.authenticateError });
    } else {
      send({ jsonrpc: '2.0', id: frame.id, result: { authenticated: true, methodId: frame.params && frame.params.methodId } });
    }
    return;
  }
  if (frame.method === 'session/load') {
    send({ jsonrpc: '2.0', method: 'session/update', params: {
      sessionId: frame.params && frame.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'loaded history' } },
    } });
    send({ jsonrpc: '2.0', id: frame.id, result: {
      modes: { currentModeId: 'normal', availableModes: [] },
      configOptions: config.configOptions || [],
    } });
    return;
  }
  if (frame.method === 'session/set_config_option') {
    send({ jsonrpc: '2.0', id: frame.id, result: { configOptions: config.configOptions || [] } });
    return;
  }
  if (frame.method === 'session/close') {
    if (config.closeFinalFrame) send(config.closeFinalFrame);
    send({ jsonrpc: '2.0', id: frame.id, result: {} });
    return;
  }
  if (frame.method === 'session/list') {
    if (config.listError) { send({ jsonrpc: '2.0', id: frame.id, error: config.listError }); return; }
    setTimeout(() => {
      send({ jsonrpc: '2.0', id: config.stringifyListResponseId ? String(frame.id) : frame.id, result: { sessions: [{ sessionId: config.sessionId || 'fake-session-1', title: 'fake' }] } });
    }, config.slowListMs || 0);
    return;
  }
  if (frame.method === 'session/prompt') {
    const plan = config.prompt || {};
    for (const note of plan.updates || []) send({ jsonrpc: '2.0', method: 'session/update', params: note });
    for (const raw of plan.frames || []) send(raw);
    if (plan.dieBeforeResponse) process.exit(1);
    if (plan.exitWithHeldStdout) {
      const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 600)'], { stdio: ['ignore', 'inherit', 'ignore'] });
      log({ heldStdoutPid: holder.pid });
      process.exit(0);
    }
    if (plan.neverAnswer) return;
    if (plan.splitResponseAndExit) {
      const response = JSON.stringify({ jsonrpc: '2.0', id: frame.id, result: { stopReason: 'end_turn' } }) + '\\n';
      const split = Math.max(1, Math.floor(response.length / 2));
      process.stdout.write(response.slice(0, split));
      setImmediate(() => process.stdout.write(response.slice(split), () => process.exit(0)));
      return;
    }
    if (plan.requestPermission) {
      permissionId = 'perm-1';
      pendingPromptId = frame.id;
      send({ jsonrpc: '2.0', id: permissionId, method: 'session/request_permission', params: {
        sessionId: frame.params && frame.params.sessionId,
        toolCall: { toolCallId: 'tc-1', title: 'fake tool call' },
        options: [{ optionId: 'allow-once', name: 'Allow once' }, { optionId: 'deny', name: 'Deny' }],
      } });
      return;
    }
    send({ jsonrpc: '2.0', id: frame.id, result: { stopReason: plan.stopReason || 'end_turn' } });
    return;
  }
  send({ jsonrpc: '2.0', id: frame.id, error: { code: -32601, message: 'fake-acp: unknown method ' + frame.method } });
}
let buffer = '';
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (!line.trim()) continue;
    let frame;
    try { frame = JSON.parse(line); } catch { log({ unparsable: line }); continue; }
    handle(frame);
  }
});
process.stdin.on('end', () => { log({ stdinEnded: true }); process.exit(0); });
`,
  );
  return binPath;
}

// ── Harness ──────────────────────────────────────────────────────────────────

interface FakeRun {
  client: AcpClient | null;
  error: Error | null;
  traces: AcpTraceEvent[];
  updates: AcpSessionUpdateParams[];
  permissions: AcpRequestPermissionParams[];
  extensionCalls: AcpExtensionEvent[];
  readLog: () => Array<Record<string, unknown>>;
}

const workdir = mkdtempSync(join(tmpdir(), 'cosyncing-acp-client-test-'));
const fixture = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-acp-v0.json'), 'utf8'),
) as Record<string, unknown>;
const reasonixFixture = JSON.parse(
  readFileSync(join(
    dirname(fileURLToPath(import.meta.url)),
    'fixtures',
    'reasonix-v1.25.2.json',
  ), 'utf8'),
) as Record<string, unknown>;
const fakeBin = writeFakeAcpBinary(workdir);
let configCounter = 0;

function readLedger(logPath: string): Array<Record<string, unknown>> {
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Connect against the fake; a connect failure is returned, never thrown. */
async function startFake(
  config: Record<string, unknown>,
  options: {
    hookless?: boolean;
    command?: string;
    requestTimeoutMs?: number;
    promptTimeoutMs?: number;
    maxFrameBytes?: number;
    signal?: AbortSignal;
  } = {},
): Promise<FakeRun> {
  const configPath = join(workdir, `fake-config-${configCounter++}.json`);
  const logPath = `${configPath}.log`;
  writeFileSync(logPath, '');
  writeFileSync(configPath, JSON.stringify({ ...config, log: logPath }));
  const traces: AcpTraceEvent[] = [];
  const updates: AcpSessionUpdateParams[] = [];
  const permissions: AcpRequestPermissionParams[] = [];
  const extensionCalls: AcpExtensionEvent[] = [];
  const hooks: AcpClientHooks = options.hookless
    ? {}
    : {
        onSessionUpdate: (params) => updates.push(params),
        onPermissionRequest: (params) => {
          permissions.push(params);
          return { outcome: { outcome: 'selected', optionId: 'allow-once' } };
        },
        extensions: {
          reasonix: (event) => {
            extensionCalls.push(event);
            return event.kind === 'notification' ? null : undefined;
          },
          xai: (event) => {
            extensionCalls.push(event);
            return event.kind === 'notification' ? null : undefined;
          },
        },
      };
  let client: AcpClient | null = null;
  let error: Error | null = null;
  try {
    client = await AcpClient.connect({
      command: options.command ?? process.execPath,
      args: options.command === undefined ? [fakeBin] : [],
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? workdir,
        FAKE_ACP_CONFIG: configPath,
      },
      trace: (event) => traces.push(event),
      hooks,
      requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
      promptTimeoutMs: options.promptTimeoutMs,
      maxFrameBytes: options.maxFrameBytes,
      signal: options.signal,
    });
  } catch (caught) {
    error = caught instanceof Error ? caught : new Error(String(caught));
    const traceDetail = traces
      .map((event) => `${event.kind}:${event.op}:${event.message}`)
      .join(' | ');
    if (traceDetail.length > 0) error.message = `${error.message}; ${traceDetail}`;
  }
  return {
    client,
    error,
    traces,
    updates,
    permissions,
    extensionCalls,
    readLog: () => readLedger(logPath),
  };
}

function initializeFrame(run: FakeRun): Record<string, unknown> | undefined {
  const entry = run.readLog().find((row) => (row.received as Record<string, unknown>)?.method === 'initialize');
  return entry?.received as Record<string, unknown> | undefined;
}

try {
  // ── Real-agent fixture: R1 smoke, captured 2026-08-27 ────────────────────
  {
    const initialize = reasonixFixture.initializeResult as Record<string, unknown>;
    const identity = reasonixFixture.storeIdentity as Record<string, unknown>;
    const promptResult = reasonixFixture.promptResult as Record<string, unknown>;
    const sessionLoad = reasonixFixture.sessionLoadProbe as Record<string, unknown>;
    const permission = reasonixFixture.permissionProbe as Record<string, unknown>;
    const modelSwitch = reasonixFixture.modelSwitchProbe as Record<string, unknown>;
    check('reasonix v1.25.2 R1 fixture pins numeric ACP protocolVersion 1',
      initialize.protocolVersion === 1);
    check('reasonix R1 proves ACP id, metadata id, transcript id, and file stem are unified',
      identity.allEqual === true);
    check('reasonix R1 completed one real turn with end_turn and no client degradation',
      promptResult.stopReason === 'end_turn'
        && Array.isArray(reasonixFixture.traceKinds)
        && reasonixFixture.traceKinds.length === 0);
    check('reasonix R3 loads the requested session by replaying history without returning a replacement id',
      sessionLoad.requestedSessionId === '<session-id>'
        && sessionLoad.responseIncludesSessionId === false
        && sessionLoad.replayedSessionId === '<session-id>');
    check('reasonix R2 proves per-tool permission options and cancellation without the write',
      permission.requestCount === 1
        && permission.promptStopReason === 'cancelled'
        && permission.outsideWorkspaceTargetCreated === false
        && Array.isArray(permission.options)
        && permission.options.length === 3);
    check('reasonix R9 pins existing-session model switching unsupported',
      modelSwitch.modelChanged === false
        && modelSwitch.storedModelBefore === modelSwitch.storedModelAfter
        && modelSwitch.capabilityDecision === 'supportsModelSwitch=false');
  }

  // ── Scenario A: the full happy path plus every degrade ────────────────────
  {
    const run = await startFake({
      protocolVersion: 1,
      initializeExtra: fixture.initializeExtra,
      emitMalformed: true,
      slowListMs: 150,
      prompt: {
        updates: fixture.updates,
        frames: fixture.frames,
        requestPermission: true,
      },
    });
    const client = run.client;
    check('handshake: connect succeeds against a numeric protocolVersion 1',
      client !== null && run.error === null, String(run.error));
    if (client) {
      check('...and the negotiated protocol major is pinned to 1',
        client.protocolVersion === 1 && client.alive, String(client.protocolVersion));

      const initialize = initializeFrame(run);
      const capabilities = (initialize?.params as Record<string, unknown> | undefined)
        ?.clientCapabilities as Record<string, unknown> | undefined;
      check('the v1 handshake declares fs and terminal ABSENT in clientCapabilities',
        capabilities !== undefined && !('fs' in capabilities) && !('terminal' in capabilities),
        JSON.stringify(capabilities));

      const result = client.initializeResult as Record<string, unknown>;
      check('unknown initialize fields and raw _meta are preserved verbatim',
        JSON.stringify(result.vendorField)
            === JSON.stringify((fixture.initializeExtra as Record<string, unknown>).vendorField)
          && JSON.stringify(result._meta)
            === JSON.stringify((fixture.initializeExtra as Record<string, unknown>)._meta),
        JSON.stringify({ vendorField: result.vendorField, _meta: result._meta }));

      const malformedTraced = await waitFor(
        () => run.traces.some((event) => event.kind === 'malformed-envelope'),
      );
      check('a malformed line from the child is traced as malformed-envelope and survived',
        malformedTraced && client.alive,
        run.traces.map((event) => event.kind).join(','));

      // Correlation: a SLOW list overlaps a fast session/new; each must resolve
      // to its own result.
      const [listResult, newResult] = await Promise.all([
        client.sessionList(),
        client.sessionNew({ cwd: '/tmp/fake' }),
      ]);
      check('correlation: overlapping requests resolve to their OWN results',
        Array.isArray(listResult.sessions)
          && (listResult.sessions[0] as Record<string, unknown>).sessionId === 'fake-session-1'
          && newResult.sessionId === 'fake-session-1'
          && (newResult as Record<string, unknown>).sessions === undefined,
        JSON.stringify({ listResult, newResult }));

      const promptResult = await client.sessionPrompt({
        sessionId: 'fake-session-1',
        prompt: [{ type: 'text', text: 'hello' }],
      });

      check('notification dispatch: session/update reaches onSessionUpdate with content intact',
        run.updates.some((params) => {
          const update = params.update as Record<string, unknown>;
          const content = update.content as Record<string, unknown> | undefined;
          return update.sessionUpdate === 'agent_message_chunk' && content?.text === 'hello from the fake agent';
        }),
        run.updates.map((params) => String(params.update?.sessionUpdate)).join(','));

      const unknownUpdate = run.updates.find((params) => params.update?.sessionUpdate === 'mystery_update');
      check('an unknown sessionUpdate value is still delivered, raw fields preserved',
        unknownUpdate !== undefined
          && JSON.stringify((unknownUpdate.update as Record<string, unknown>).vendorPayload)
            === JSON.stringify({ anything: 'goes' }),
        JSON.stringify(unknownUpdate?.update));
      check('...and the swallow is traced, naming the value',
        run.traces.some((event) => event.kind === 'unknown-session-update'
          && event.message.includes('mystery_update')),
        run.traces.filter((event) => event.kind === 'unknown-session-update').map((event) => event.message).join(' | '));
      check('a non-2.0 JSON-RPC envelope is traced and never dispatched',
        !run.updates.some((params) => params.update?.sessionUpdate === 'must_not_dispatch')
          && run.traces.some((event) => event.kind === 'malformed-envelope'
            && event.message.includes('JSON-RPC version 2.0')),
        run.traces.map((event) => `${event.kind}:${event.message}`).join(' | '));

      check('extension routing: _reasonix.io/* plus both measured/documented x.ai spellings reach typed hooks',
        run.extensionCalls.some((event) => event.namespace === 'reasonix'
            && event.method === '_reasonix.io/session/status_update')
          && run.extensionCalls.some((event) => event.namespace === 'xai'
            && event.method === 'x.ai/usage')
          && run.extensionCalls.some((event) => event.namespace === 'xai'
            && event.method === '_x.ai/session/update'),
        run.extensionCalls.map((event) => event.method).join(','));
      check('...while any other _* namespace is traced and NEVER executed',
        !run.extensionCalls.some((event) => event.method.startsWith('_other.io/'))
          && run.traces.some((event) => event.kind === 'unhandled-extension'
            && event.op === '_other.io/ping'),
        run.traces.filter((event) => event.kind === 'unhandled-extension').map((event) => event.op).join(','));
      check('an unimplemented request in a registered extension namespace gets method-not-found',
        run.readLog().some((row) => {
          const received = row.received as Record<string, unknown> | undefined;
          const error = received?.error as Record<string, unknown> | undefined;
          return received?.id === 'reasonix-unknown-1' && error?.code === -32601;
        }));
      check('a valid JSON-RPC null request id is preserved in the error response',
        run.readLog().some((row) => {
          const received = row.received as Record<string, unknown> | undefined;
          const error = received?.error as Record<string, unknown> | undefined;
          return 'id' in (received ?? {}) && received?.id === null && error?.code === -32601;
        }));

      check('a terminal frame against the unoffered capability is traced and answered with a capability error',
        run.traces.some((event) => event.kind === 'capability-refused' && event.op === 'terminal/create')
          && run.readLog().some((row) => {
            const received = row.received as Record<string, unknown> | undefined;
            const error = received?.error as Record<string, unknown> | undefined;
            return received?.id === 'term-1' && error?.code === -32601;
          }),
        run.traces.filter((event) => event.kind === 'capability-refused').map((event) => event.op).join(','));

      const echo = (promptResult as Record<string, unknown>).permissionEcho as Record<string, unknown> | null;
      const outcome = echo?.outcome as Record<string, unknown> | undefined;
      check('permission round-trip: the agent-issued request is answered by the hook and completes the turn',
        run.permissions.length === 1
          && (run.permissions[0]?.toolCall as Record<string, unknown> | undefined)?.toolCallId === 'tc-1'
          && promptResult.stopReason === 'end_turn'
          && outcome?.outcome === 'selected'
          && outcome?.optionId === 'allow-once',
        JSON.stringify(promptResult));

      client.sessionCancel('fake-session-1');
      const cancelSeen = await waitFor(() =>
        run.readLog().some((row) => {
          const received = row.received as Record<string, unknown> | undefined;
          return received?.method === 'session/cancel'
            && (received.params as Record<string, unknown> | undefined)?.sessionId === 'fake-session-1';
        }));
      check('cancel: session/cancel is sent as a notification with the session id', cancelSeen);

      const configResult = await client.sessionSetConfigOption({
        sessionId: 'fake-session-1',
        configId: 'model',
        value: 'provider/model',
      });
      check('set_config_option uses the typed ACP request surface',
        Array.isArray(configResult.configOptions)
          && run.readLog().some((row) => {
            const received = row.received as Record<string, unknown> | undefined;
            const params = received?.params as Record<string, unknown> | undefined;
            return received?.method === 'session/set_config_option'
              && params?.sessionId === 'fake-session-1'
              && params?.configId === 'model'
              && params?.value === 'provider/model';
          }));

      await client.sessionClose({ sessionId: 'fake-session-1' });
      check('session/close releases the exact live session before process teardown',
        run.readLog().some((row) => {
          const received = row.received as Record<string, unknown> | undefined;
          return received?.method === 'session/close'
            && (received?.params as Record<string, unknown> | undefined)?.sessionId === 'fake-session-1';
        }));

      await client.close();
      check('close() is clean and idempotent',
        !client.alive && (await client.close()) === undefined);
    }
  }

  // ── Cross-type response ids are not correlated ──────────────────────────
  // `requestTimeoutMs` is the only handle on how long `sessionList` waits, and
  // it bounds the HANDSHAKE too. At 50ms the handshake was the thing that lost
  // on a loaded machine: connect threw, `run.client?.` short-circuited, and the
  // scenario reported `undefined` — not "a string id resolved a numeric
  // request", just "we never asked". Budget the handshake honestly, check it
  // separately so a connect failure says so, and pay the wait on the one
  // request that is SUPPOSED to time out.
  {
    const run = await startFake(
      { protocolVersion: 1, stringifyListResponseId: true },
      { requestTimeoutMs: 1_000 },
    );
    check('cross-type id setup: the handshake completes before the id is tested',
      run.client !== null && run.error === null, String(run.error));
    let rejected: unknown;
    try {
      await run.client?.sessionList();
    } catch (error) {
      rejected = error;
    }
    check('a string response id cannot resolve the same-valued numeric request id',
      rejected instanceof AcpRequestTimeoutError
        && run.traces.some((event) => event.kind === 'uncorrelated-response'),
      String(rejected));
    await run.client?.close();
  }

  // ── Scenario B: tolerant decode of a STRING protocolVersion ───────────────
  {
    const run = await startFake({ protocolVersion: '1' });
    check('tolerant decode: a string "1" protocolVersion is accepted',
      run.client !== null && run.client.protocolVersion === 1, String(run.error));
    await run.client?.close();
  }

  // ── Scenario C/D: untested majors and garbage fail CLOSED ─────────────────
  for (const [label, protocolVersion] of [
    ['major 2', 2],
    ['garbage "abc"', 'abc'],
    ['fractional number 1.9', 1.9],
    ['fractional string "1.5"', '1.5'],
  ] as const) {
    const run = await startFake({ protocolVersion });
    check(`protocol pinning: ${label} fails closed`,
      run.client === null && run.error !== null && /unsupported ACP protocol version/.test(run.error.message),
      String(run.error));
    check('...with the version recorded on the trace',
      run.traces.some((event) => event.kind === 'unsupported-protocol-version'
        && event.message.includes(JSON.stringify(protocolVersion))),
      run.traces.map((event) => `${event.kind}:${event.message}`).join(' | '));
  }

  // ── Scenario E: a rejected handshake reaps its child ─────────────────────
  {
    const run = await startFake({ initializeError: { code: -32603, message: 'init refused' } });
    const stdinEnded = await waitFor(() => run.readLog().some((row) => row.stdinEnded === true));
    check('a rejected initialize closes and reaps the child',
      run.client === null
        && run.error instanceof AcpRpcError
        && run.error.code === -32603
        && stdinEnded,
      String(run.error));
  }

  // ── Scenario F: an unknown error code rejects AND is traced ───────────────
  {
    const run = await startFake({ listError: { code: 12345, message: 'vendor weirdness' } });
    check('a response with an unknown error code rejects with the code intact',
      run.client !== null,
      String(run.error));
    if (run.client) {
      let caught: unknown;
      try {
        await run.client.sessionList();
      } catch (error) {
        caught = error;
      }
      check('...the pending request rejects with an AcpRpcError carrying code 12345',
        caught instanceof AcpRpcError && caught.code === 12345,
        String(caught));
      check('...and the unknown error code is traced',
        run.traces.some((event) => event.kind === 'unknown-error-code' && event.message.includes('12345')),
        run.traces.map((event) => event.kind).join(','));
      await run.client.close();
    }
  }

  // ── Scenario G: child death ────────────────────────────────────────────────
  {
    const run = await startFake({ prompt: { dieBeforeResponse: true } });
    const client = run.client;
    check('dead child: setup connects', client !== null, String(run.error));
    if (client) {
      let promptError: unknown;
      try {
        await client.sessionPrompt({ sessionId: 'fake-session-1', prompt: [{ type: 'text', text: 'die' }] });
      } catch (error) {
        promptError = error;
      }
      check('the in-flight turn REJECTS on child exit rather than hanging',
        promptError instanceof Error && /exited/.test(promptError.message),
        String(promptError));
      check('...and the exit is traced with its code',
        run.traces.some((event) => event.kind === 'child-exit' && event.message.includes('code 1')),
        run.traces.filter((event) => event.kind === 'child-exit').map((event) => event.message).join(' | '));

      const secondSend = await Promise.race([
        client.sessionNew({ cwd: '/tmp/fake' }).then(
          () => 'resolved',
          (error: unknown) => `rejected:${error instanceof Error ? error.message : String(error)}`,
        ),
        sleep(500).then(() => 'timeout'),
      ]);
      check('a send against the dead child rejects BEFORE touching run state (never hangs)',
        typeof secondSend === 'string' && secondSend.startsWith('rejected:') && /not running/.test(secondSend),
        String(secondSend));
      let cancelThrew = false;
      try {
        client.sessionCancel('fake-session-1');
      } catch {
        cancelThrew = true;
      }
      check('...and a notification against the dead child throws rather than vanishing', cancelThrew);
      await client.close();
      check('close() still reaps a dead child cleanly', !client.alive);
    }
  }

  // ── Scenario H: a timed-out turn force-closes ────────────────────────────
  {
    const run = await startFake({ prompt: { neverAnswer: true } }, { promptTimeoutMs: 50 });
    check('prompt timeout: setup connects', run.client !== null, String(run.error));
    if (run.client) {
      let caught: unknown;
      try {
        await run.client.sessionPrompt({ sessionId: 'fake-session-1', prompt: [{ type: 'text', text: 'hang' }] });
      } catch (error) {
        caught = error;
      }
      const stopped = await waitFor(() => !run.client!.alive);
      check('a timed-out turn force-closes its child before another request can start',
        caught instanceof AcpRequestTimeoutError && stopped,
        String(caught));
    }
  }

  // ── Scenario H2: stdout drains after process exit ───────────────────────
  {
    const run = await startFake({ prompt: { splitResponseAndExit: true } });
    check('split final response: setup connects', run.client !== null, String(run.error));
    if (run.client) {
      let result: unknown;
      let caught: unknown;
      try {
        result = await run.client.sessionPrompt({
          sessionId: 'fake-session-1',
          prompt: [{ type: 'text', text: 'final split' }],
        });
      } catch (error) {
        caught = error;
      }
      const stopped = await waitFor(() => !run.client!.alive);
      check('a split response written immediately before exit resolves before child-death handling',
        caught === undefined
          && (result as Record<string, unknown> | undefined)?.stopReason === 'end_turn'
          && stopped,
        String(caught));
      await run.client.close();
    }
  }

  // ── Scenario H3: process exit cannot hang behind an inherited stdout fd ─
  {
    const run = await startFake({ prompt: { exitWithHeldStdout: true } });
    check('held stdout after exit: setup connects', run.client !== null, String(run.error));
    if (run.client) {
      const started = Date.now();
      let rejected = false;
      try {
        await run.client.sessionPrompt({ sessionId: 'fake-session-1', prompt: [{ type: 'text', text: 'exit' }] });
      } catch {
        rejected = true;
      }
      check('process exit rejects promptly even when a descendant keeps stdout open',
        rejected && Date.now() - started < 550 && !run.client.alive,
        `elapsed=${Date.now() - started}`);
      const holderPid = run.readLog()
        .find((row) => typeof row.heldStdoutPid === 'number')?.heldStdoutPid as number | undefined;
      const holderExited = holderPid !== undefined && await waitFor(() => {
        try {
          process.kill(holderPid, 0);
          return false;
        } catch {
          return true;
        }
      });
      check('the intentional stdout-holder exits before suite teardown',
        holderExited,
        `pid=${String(holderPid)}`);
    }
  }

  // ── Scenario H4: abort interrupts the initialize handshake ──────────────
  {
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 50);
    const run = await startFake(
      { blockInitialize: true },
      { requestTimeoutMs: 5_000, signal: controller.signal },
    );
    check('connect abort force-closes a child blocked in initialize',
      run.client === null
        && run.error?.message.includes('ACP connect aborted') === true
        && Date.now() - started < 1_000,
      `${String(run.error)} elapsed=${Date.now() - started}`);
  }

  // ── Scenario I: a permission ask with NO hook answers, never hangs ────────
  {
    const run = await startFake({ prompt: { requestPermission: true } }, { hookless: true });
    check('permission without a hook: setup connects', run.client !== null, String(run.error));
    if (run.client) {
      const promptResult = await run.client.sessionPrompt({
        sessionId: 'fake-session-1',
        prompt: [{ type: 'text', text: 'hello' }],
      });
      const permissionError = (promptResult as Record<string, unknown>).permissionError as Record<string, unknown> | null;
      check('...the agent gets a method-not-found answer and the turn completes',
        permissionError?.code === -32601 && promptResult.stopReason === 'end_turn',
        JSON.stringify(promptResult));
      check('...and the missing handler is traced, naming the operation',
        run.traces.some((event) => event.kind === 'unknown-method'
          && event.op === 'session/request_permission'),
        run.traces.map((event) => `${event.kind}:${event.op}`).join(' | '));
      await run.client.close();
    }
  }

  // ── Scenario J: stderr diagnostics and unterminated frames are bounded ───
  {
    const run = await startFake({ emitStderrBytes: 256 * 1024 });
    check('stderr flood: setup connects', run.client !== null, String(run.error));
    if (run.client) {
      await run.client.close();
      const summarized = await waitFor(() => run.traces.some((event) =>
        event.kind === 'child-stderr' && event.message.includes('suppressed')));
      const stderrTraces = run.traces.filter((event) => event.kind === 'child-stderr');
      check('stderr trace callbacks are rate-bounded and summarize suppressed bytes',
        summarized
          && stderrTraces.length <= 65
          && stderrTraces.every((event) => event.message.includes('content redacted')
            || event.message.includes('suppressed'))
          && !JSON.stringify(run.traces).includes('e'.repeat(64)),
        stderrTraces.map((event) => event.message).join(' | '));
    }
  }

  {
    const run = await startFake({ emitUnterminatedBytes: 512 }, { maxFrameBytes: 256 });
    check('oversized unterminated frame: setup initially completes', run.client !== null, String(run.error));
    if (run.client) {
      const stopped = await waitFor(() => !run.client!.alive);
      check('an unterminated stdout frame is bounded, traced, and closes the child',
        stopped && run.traces.some((event) => event.kind === 'oversized-frame'),
        run.traces.map((event) => `${event.kind}:${event.message}`).join(' | '));
      await run.client.close();
    }
  }

  // ── Scenario K: a command that does not exist rejects the handshake ───────
  {
    const run = await startFake({}, { command: 'definitely-not-a-real-acp-binary-xyz' });
    check('a child that never spawns rejects connect instead of hanging',
      run.client === null && run.error !== null && /failed to spawn/.test(run.error.message),
      String(run.error));
    check('...with the spawn failure traced as a child exit',
      run.traces.some((event) => event.kind === 'child-exit'),
      run.traces.map((event) => `${event.kind}:${event.message}`).join(' | '));
  }

  // ── Scenario L: established child closes its stdin read end ─────────────
  {
    const run = await startFake({ closeStdinAfterInitialize: true });
    check('closed child stdin: setup connects before the pipe closes', run.client !== null, String(run.error));
    if (run.client) {
      await sleep(50);
      let caught: unknown;
      try { await run.client.sessionList(); } catch (error) { caught = error; }
      const stopped = await waitFor(() => !run.client!.alive);
      check('an asynchronous stdin EPIPE is handled, rejects pending work, and reaps the child',
        caught instanceof Error && /stdio|not running/.test(caught.message) && stopped,
        JSON.stringify({ caught: String(caught), stopped, alive: run.client.alive, log: run.readLog() }));
      await run.client.close();
    }
  }
} catch (error) {
  check('test harness completed', false, error instanceof Error ? error.message : String(error));
} finally {
  rmSync(workdir, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
