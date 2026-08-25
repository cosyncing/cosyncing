#!/usr/bin/env bun
/**
 * Phase 6 slice 1 — Pi on native Windows.
 *
 * Covers exactly four things and claims nothing else: the shared invocation
 * boundary resolving and launching the real npm `pi` shim, Pi runtime
 * readiness against the installed package's own Node contract, bridge
 * installation into a disposable agent directory, and one native `--mode rpc`
 * stdio trace using a non-model command.
 *
 * It never writes to the operator's real `~/.pi`, never sends a prompt, and
 * never contacts a model provider. Paths and provider configuration stay out
 * of the report; only shapes, basenames, and versions are recorded.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { win32 } from 'node:path';
import {
  bunSpawnResolvedInvocation,
  resolveInvocation,
} from '../../../packages/typescript/adapter-api/src/invocation.ts';
import {
  inspectPiBridgeAsset,
  PI_BRIDGE_EMBEDDED_SHA256,
  PI_BRIDGE_EMBEDDED_SOURCE,
} from '../../../packages/typescript/adapters/pi/src/implementation.ts';
import {
  inspectPiRuntimeReadiness,
  PI_DEFAULT_NODE_MINIMUM_VERSION,
  PI_MINIMUM_SUPPORTED_VERSION,
} from '../../../packages/typescript/adapters/pi/src/runtime-readiness.ts';
import { terminateWindowsProcessTree } from '../../../packages/typescript/broker/src/runtime/windows-process.ts';

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Phase 6 Pi probe requires ${name}`);
  return value;
}

const root = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_ROOT');
const runId = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_RUN_ID');
const sourceCommit = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_COMMIT');
const sourceDirty = requiredEnvironment('COSYNCING_WINDOWS_PHASE6_SOURCE_DIRTY');
if (process.platform !== 'win32') {
  throw new Error('Phase 6 Pi probe requires its native Windows runner environment');
}

const agentDir = win32.join(root, 'pi-agent');
const sessionDir = win32.join(root, 'sessions');
const sessionFile = win32.join(sessionDir, `phase6-${runId}.jsonl`);
const observations: Record<string, unknown> = {};
let child: Bun.Subprocess<'pipe', 'pipe', 'pipe'> | undefined;

/** Report basenames, never the operator's directory layout. */
function leaf(path: string): string {
  return win32.basename(path);
}

try {
  mkdirSync(sessionDir, { recursive: true });

  // 1. Invocation. On Windows the npm launcher is a `.cmd`, so the shared
  //    resolver must classify it as batch and hand back fixed cmd.exe argv
  //    rather than a caller-composed shell string.
  const invocation = resolveInvocation('pi');
  if (!invocation) throw new Error('Pi did not resolve through the shared invocation boundary');
  observations.invocation = invocation.kind === 'batch'
    ? {
      kind: invocation.kind,
      cmdExe: leaf(invocation.cmdExe),
      script: leaf(invocation.script),
      prefixArgs: invocation.prefixArgs,
      originalPath: leaf(invocation.originalPath),
    }
    : {
      kind: invocation.kind,
      executable: leaf(invocation.executable),
      prefixArgs: invocation.prefixArgs,
      originalPath: leaf(invocation.originalPath),
    };

  // 2. Runtime readiness. This is MEASURED, not asserted: qualification exists to record what the
  //    adapter actually reports on this host, and a not-ready verdict is a finding rather than a
  //    reason to abandon the remaining evidence. The launcher facts are recorded alongside it so a
  //    not-ready verdict can be attributed rather than guessed at.
  const readiness = inspectPiRuntimeReadiness();
  const launcherPrefix = readFileSync(invocation.originalPath, 'utf8').slice(0, 512);
  const packageJsonBesideShim = win32.join(
    win32.dirname(invocation.originalPath),
    'node_modules', '@earendil-works', 'pi-coding-agent', 'package.json',
  );
  observations.runtimeReadiness = {
    ready: readiness.ready,
    detailCode: readiness.detailCode,
    packageVersion: readiness.packageVersion,
    nodeVersion: readiness.nodeVersion,
    requiredNodeVersion: readiness.requiredNodeVersion,
    executable: readiness.executable ? leaf(readiness.executable) : undefined,
    nodeExecutable: readiness.nodeExecutable ? leaf(readiness.nodeExecutable) : undefined,
    adapterFloor: PI_MINIMUM_SUPPORTED_VERSION,
    defaultNodeFloor: PI_DEFAULT_NODE_MINIMUM_VERSION,
    launcher: {
      resolverKind: invocation.kind,
      hasShebang: launcherPrefix.startsWith('#!'),
      // A Windows npm shim names its package target instead of being a symlink into it, so the
      // POSIX walk-up that finds Pi's engines.node contract has nothing to walk through.
      namesPackageTarget: launcherPrefix.includes('node_modules'),
      packageJsonBesideShimExists: existsSync(packageJsonBesideShim),
    },
  };

  // 3. Bridge installation into a DISPOSABLE agent directory. Setup owns this
  //    file in production; the probe only proves the asset lands with the
  //    embedded identity and is classified as owned on NTFS.
  const bridgeDir = win32.join(agentDir, 'extensions', 'cosyncing-bridge');
  mkdirSync(bridgeDir, { recursive: true });
  const before = inspectPiBridgeAsset(agentDir);
  writeFileSync(win32.join(bridgeDir, 'index.ts'), PI_BRIDGE_EMBEDDED_SOURCE);
  const after = inspectPiBridgeAsset(agentDir);
  if (before.status !== 'missing' || after.status !== 'owned') {
    throw new Error(`bridge install did not converge: ${before.status} -> ${after.status}`);
  }
  if (after.actualSha256 !== PI_BRIDGE_EMBEDDED_SHA256) {
    throw new Error('installed bridge does not match the embedded identity');
  }
  observations.bridgeInstall = {
    before: before.status,
    after: after.status,
    identityMatches: true,
    requiresConfirmation: after.requiresConfirmation,
    path: leaf(after.path),
  };

  // 4. One native RPC trace. `get_messages` reads the session and contacts no
  //    provider, so this proves the stdio transport without spending a model
  //    call or needing the operator's provider credentials.
  writeFileSync(sessionFile, '');
  child = bunSpawnResolvedInvocation(invocation, ['--mode', 'rpc', '--session', sessionFile], {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: root,
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      COSYNCING_NO_BRIDGE: '1',
    },
  }) as Bun.Subprocess<'pipe', 'pipe', 'pipe'>;

  const requestId = `phase6-${runId}-1`;
  child.stdin.write(`${JSON.stringify({ id: requestId, type: 'get_messages' })}\n`);
  child.stdin.flush();

  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  const deadline = Date.now() + 30_000;
  let buffered = '';
  let response: Record<string, unknown> | undefined;
  let lines = 0;
  while (Date.now() < deadline && !response) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<{ done: true; value: undefined }>((resolveTimeout) => {
        setTimeout(() => resolveTimeout({ done: true, value: undefined }), 2_000);
      }),
    ]);
    if (chunk.value) buffered += decoder.decode(chunk.value, { stream: true });
    else if (chunk.done && !chunk.value && child.exitCode !== null) break;
    let newline = buffered.indexOf('\n');
    while (newline >= 0) {
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      newline = buffered.indexOf('\n');
      if (!line) continue;
      lines += 1;
      let parsed: Record<string, unknown> | undefined;
      try { parsed = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
      if (parsed?.type === 'response' && parsed.id === requestId) {
        response = parsed;
        break;
      }
    }
  }
  reader.releaseLock();
  if (!response) throw new Error(`Pi RPC produced no response to ${requestId} (${lines} framed lines)`);
  observations.rpcTrace = {
    command: 'get_messages',
    transport: 'jsonl-stdio',
    responded: true,
    responseType: response.type,
    correlatedById: response.id === requestId,
    // The payload is the operator's own session content; only its shape is recorded.
    payloadKeys: Object.keys(response).sort(),
    framedLines: lines,
  };

  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    runId,
    slice: 'pi-invocation-readiness-bridge-rpc',
    source: { commit: sourceCommit, dirty: sourceDirty === 'true' },
    host: { platform: process.platform, arch: process.arch },
    runtime: { bun: Bun.version },
    observations,
    deferred: [
      'live model turn and provider credentials',
      'create/resume/send/abort/model/permission trace',
      'session discovery against the operator real session root',
      'file attachment and teardown under broker ownership',
    ],
    result: readiness.ready ? 'pass' : 'finding',
  })}\n`);
} finally {
  if (child?.pid) {
    try { child.stdin.end(); } catch { /* the child may already be gone */ }
    terminateWindowsProcessTree(child.pid, false);
    await Promise.race([child.exited.catch(() => undefined), Bun.sleep(3_000)]);
    if (child.exitCode === null) terminateWindowsProcessTree(child.pid, true);
  }
  rmSync(root, { recursive: true, force: true });
}
