#!/usr/bin/env bun

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

interface VerificationResult {
  id: string;
  command: string[];
  exitCode: number;
  passed: boolean;
}

const repositoryRoot = resolve(import.meta.dir, '../../..');
const outputPath = resolve(repositoryRoot, process.argv[2] ?? 'output/windows-broker/phase0-verification.json');

async function capture(command: string[]): Promise<{ exitCode: number; stdout: string }> {
  const child = Bun.spawn(command, {
    cwd: repositoryRoot,
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  return { exitCode, stdout: stdout.trim() };
}

async function verify(id: string, command: string[], env?: Record<string, string>): Promise<VerificationResult> {
  process.stdout.write(`\n[phase0] ${command.join(' ')}\n`);
  const child = Bun.spawn(command, {
    cwd: repositoryRoot,
    env: env ? { ...process.env, ...env } : process.env,
    stdout: 'inherit',
    stderr: 'inherit',
  });
  const exitCode = await child.exited;
  return { id, command, exitCode, passed: exitCode === 0 };
}

const revision = await capture(['git', 'rev-parse', 'HEAD']);
const status = await capture(['git', 'status', '--porcelain', '--untracked-files=all']);
if (revision.exitCode !== 0) throw new Error('Could not resolve the Phase 0 candidate revision.');
if (status.exitCode !== 0) throw new Error('Could not inspect the Phase 0 candidate worktree.');

const startedAt = new Date().toISOString();
const results: VerificationResult[] = [];
results.push(await verify('application-identity', ['bun', 'run', 'test:broker-application-identity']));
results.push(await verify('service-lifecycle', ['bun', 'run', 'test:broker-service']));
results.push(await verify('shell-syntax', ['bash', '-n', 'scripts/broker/windows/stage-phase0.sh']));
const powershell = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe';
const parserCommand = [
  '& { param($p) $tokens=$null; $errors=$null;',
  '[void][System.Management.Automation.Language.Parser]::ParseFile($p,[ref]$tokens,[ref]$errors);',
  'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.ToString() }; exit 1 } }',
].join(' ');
for (const script of [
  'phase0-host-probe.ps1',
  'phase0-runtime-probe.ps1',
  'phase0-behavior-probe.ps1',
  'phase0-scheduler-probe.ps1',
]) {
  const linuxPath = resolve(repositoryRoot, 'scripts/broker/windows', script);
  const windowsPath = await capture(['wslpath', '-w', linuxPath]);
  if (windowsPath.exitCode !== 0) throw new Error(`Could not resolve Windows path for ${script}.`);
  results.push(await verify(`powershell-parse-${script}`, [
    powershell,
    '-NoProfile',
    '-Command',
    parserCommand,
    windowsPath.stdout,
  ]));
}
results.push(await verify('diff-hygiene', ['git', 'diff', '--check']));
results.push(await verify('public-tree', ['bun', 'run', 'ci:check-public-tree']));
results.push(await verify('repository-check', ['bun', 'run', 'check'], { PATH: `/snap/bin:${process.env.PATH ?? ''}` }));

const report = {
  schemaVersion: 1,
  lane: 'native-windows-phase0-verification',
  generatedAt: new Date().toISOString(),
  startedAt,
  candidate: {
    revision: revision.stdout,
    dirtyAtStart: status.stdout.length > 0,
  },
  passed: status.stdout.length === 0 && results.every((result) => result.passed),
  results,
};

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nPhase 0 verification report: ${outputPath}`);
if (!report.passed) process.exit(1);
