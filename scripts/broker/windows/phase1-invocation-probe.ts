#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  bunSpawnResolvedInvocation,
  resolveInvocation,
  spawnResolvedInvocation,
} from '../../../packages/typescript/adapter-api/src/invocation.ts';

if (process.platform !== 'win32') throw new Error('This probe must run under native Windows Bun.');

const root = join(dirname(import.meta.path), 'output', 'space (parentheses) & caret ^ %COSYNCING_PHASE1_EXPAND% Unicode 雪');
const capture = join(root, 'capture-argv.ts');
const shim = join(root, 'cosyncing probe.cmd');
const batShim = join(root, 'cosyncing probe.bat');
rmSync(join(dirname(import.meta.path), 'output'), { recursive: true, force: true });
mkdirSync(root, { recursive: true });
writeFileSync(capture, 'process.stdout.write(JSON.stringify(Bun.argv.slice(2)));\n');
const shimSource = `@echo off\r\nsetlocal DisableDelayedExpansion\r\n"${process.execPath}" "%~dp0capture-argv.ts" %*\r\n`;
writeFileSync(shim, shimSource);
writeFileSync(batShim, shimSource);

const invocation = resolveInvocation(shim, { platform: 'win32', env: process.env });
assert.equal(invocation?.kind, 'batch');

const expected = [
  '',
  ' ',
  'space value',
  'Unicode 雪',
  '&',
  '|',
  '<',
  '>',
  '(',
  ')',
  '^',
  '%COSYNCING_PHASE1_EXPAND%',
  '%1',
  '%%',
  'literal%percent',
  '!',
  'embedded"quote',
  'trailing\\',
  'trailing space and slash\\',
];
const proc = bunSpawnResolvedInvocation(invocation!, expected, {
  env: { ...process.env, COSYNCING_PHASE1_EXPAND: 'EXPANDED_MUST_NOT_APPEAR' },
  cwd: root,
  stdin: 'ignore',
  stdout: 'pipe',
  stderr: 'pipe',
  windowsHide: true,
});
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
  proc.exited,
]);
assert.equal(exitCode, 0, stderr);
assert.deepEqual(JSON.parse(stdout), expected);

const nodeResult = await new Promise<{ stdout: string; stderr: string; exitCode: number | null }>((resolve, reject) => {
  const child = spawnResolvedInvocation(invocation!, expected, {
    env: { ...process.env, COSYNCING_PHASE1_EXPAND: 'EXPANDED_MUST_NOT_APPEAR' },
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let nodeStdout = '';
  let nodeStderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { nodeStdout += chunk; });
  child.stderr?.on('data', (chunk: string) => { nodeStderr += chunk; });
  child.once('error', reject);
  child.once('close', (code) => resolve({ stdout: nodeStdout, stderr: nodeStderr, exitCode: code }));
});
assert.equal(nodeResult.exitCode, 0, nodeResult.stderr);
assert.deepEqual(JSON.parse(nodeResult.stdout), expected);

const batInvocation = resolveInvocation(batShim, { platform: 'win32', env: process.env });
assert.equal(batInvocation?.kind, 'batch');
const batProc = bunSpawnResolvedInvocation(batInvocation!, expected, {
  env: { ...process.env, COSYNCING_PHASE1_EXPAND: 'EXPANDED_MUST_NOT_APPEAR' },
  cwd: root,
  stdin: 'ignore',
  stdout: 'pipe',
  stderr: 'pipe',
  windowsHide: true,
});
const [batStdout, batStderr, batExitCode] = await Promise.all([
  new Response(batProc.stdout).text(),
  new Response(batProc.stderr).text(),
  batProc.exited,
]);
assert.equal(batExitCode, 0, batStderr);
assert.deepEqual(JSON.parse(batStdout), expected);

const chcpCom = resolveInvocation(join(process.env.SystemRoot!, 'System32', 'chcp.com'), {
  platform: 'win32',
  env: process.env,
});
assert.equal(chcpCom?.kind, 'batch');
const comProc = bunSpawnResolvedInvocation(chcpCom!, [], {
  stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true,
});
const [comStdout, comStderr, comExitCode] = await Promise.all([
  new Response(comProc.stdout).text(),
  new Response(comProc.stderr).text(),
  comProc.exited,
]);
assert.equal(comExitCode, 0, comStderr);
assert.ok(comStdout.trim().length > 0);

for (const invalid of ['nul\0value', 'cr\rvalue', 'lf\nvalue']) {
  assert.throws(() => bunSpawnResolvedInvocation(invocation!, [invalid], {}), /NUL, CR, or LF/);
}

const report = {
  schema: 1,
  runId: process.env.COSYNCING_PHASE1_RUN_ID ?? 'manual',
  sourceCommit: process.env.COSYNCING_PHASE1_SOURCE_COMMIT ?? 'unrecorded',
  sourceDirty: process.env.COSYNCING_PHASE1_SOURCE_COMMIT ? false : undefined,
  candidateArchiveMode: process.env.COSYNCING_PHASE1_SOURCE_COMMIT ? 'clean-commit' : 'manual-staging',
  platform: process.platform,
  arch: process.arch,
  bunVersion: Bun.version,
  status: 'passed',
  assertions: (expected.length * 3) + 7,
  launchers: ['cmd:Bun.spawn', 'cmd:node:child_process', 'bat:Bun.spawn', 'com:Bun.spawn'],
  scriptPathClass: 'NTFS path with spaces, parentheses, cmd metacharacters, percent expansion syntax, and Unicode',
};
writeFileSync(join(dirname(import.meta.path), 'phase1-invocation-report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(report));
