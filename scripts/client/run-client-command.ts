#!/usr/bin/env bun
import { resolve } from 'node:path';

export const REPOSITORY_ROOT = resolve(import.meta.dir, '../..');
export const CLIENT_ROOT = resolve(REPOSITORY_ROOT, 'apps/client');

function platformExecutable(executable: string): string {
  if (process.platform !== 'win32') return executable;
  if (executable === 'flutter') return 'flutter.bat';
  if (executable === 'dart') return 'dart.exe';
  return executable;
}

export async function runClientCommand(args: string[]): Promise<number> {
  if (args.length === 0) throw new Error('client command is required');
  const [executable, ...rest] = args;
  const child = Bun.spawn([platformExecutable(executable!), ...rest], {
    cwd: CLIENT_ROOT,
    env: process.env,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  return child.exited;
}

if (import.meta.main) {
  process.exit(await runClientCommand(Bun.argv.slice(2)));
}
