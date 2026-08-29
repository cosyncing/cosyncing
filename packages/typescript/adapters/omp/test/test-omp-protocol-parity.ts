#!/usr/bin/env bun
/**
 * OMP 17.4.2 protocol lock.
 *
 * The checked-in fixture is reviewed L2 compatibility evidence, not a deterministic native drift
 * gate. This suite always diffs it against the dialect and shared engine. When matching OMP source
 * is installed (or supplied with COSYNCING_OMP_PACKAGE_ROOT), it also performs an optional audit.
 */
export {};
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { OMP_DIALECT } from '../src/dialect.ts';

interface SurfaceFixture {
  schemaVersion: number;
  package: string;
  nativeVersion: string;
  source: { commandTypes: string; eventForwarder: string };
  adapterCommands: string[];
  absentCommands: string[];
  consumedEvents: string[];
}

const fixturePath = join(import.meta.dir, 'fixtures', 'omp-rpc-surface-17.4.2.json');
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as SurfaceFixture;
const enginePath = resolve(import.meta.dir, '../../../pi-engine/src/implementation.ts');
const engineSource = readFileSync(enginePath, 'utf8');
const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function sameStrings(left: Iterable<string>, right: Iterable<string>): boolean {
  return JSON.stringify(sorted(left)) === JSON.stringify(sorted(right));
}

function commandTypes(source: string): Set<string> {
  const commandUnion = source.match(/export type RpcCommand\s*=([\s\S]*?)\/\/ ={20,}\s*\/\/ RPC State/)?.[1] ?? '';
  return new Set([...commandUnion.matchAll(/type:\s*["']([^"']+)["']/g)].map((match) => match[1]!));
}

function engineConsumedEvents(source: string): Set<string> {
  const handler = source.match(/private handleEvent\(ev: any\): void \{([\s\S]*?)\n  \}\n\n  async getHistory/)?.[1] ?? '';
  return new Set([...handler.matchAll(/case\s+["']([^"']+)["']/g)].map((match) => match[1]!));
}

function candidatePackageRoots(): string[] {
  const roots: string[] = [];
  const explicit = process.env.COSYNCING_OMP_PACKAGE_ROOT?.trim();
  if (explicit) roots.push(resolve(explicit));
  const binary = Bun.which(process.env.COSYNCING_OMP_BIN?.trim() || 'omp');
  if (binary) {
    try {
      const target = realpathSync(binary);
      if (target.endsWith('/dist/cli.js')) roots.push(dirname(dirname(target)));
    } catch {
      /* unresolved binary: the deterministic fixture checks below still run */
    }
  }
  const home = process.env.HOME?.trim();
  if (home) roots.push(join(home, '.bun', 'install', 'global', 'node_modules', '@oh-my-pi', 'pi-coding-agent'));
  return [...new Set(roots)];
}

check('fixture schema and reviewed version are pinned', fixture.schemaVersion === 1 && fixture.nativeVersion === '17.4.2');
check('omp command alias is get_available_commands', OMP_DIALECT.rpcAliases.getCommands === 'get_available_commands');
check('omp advertises neither fork nor clone RPC lifecycle', !OMP_DIALECT.lifecycleCommands.fork && !OMP_DIALECT.lifecycleCommands.clone);

const consumed = engineConsumedEvents(engineSource);
check(
  'audited event fixture exactly matches the shared engine consumed set',
  sameStrings(consumed, fixture.consumedEvents),
  `fixture=${sorted(fixture.consumedEvents).join(',')} engine=${sorted(consumed).join(',')}`,
);
for (const command of fixture.adapterCommands) {
  const carried = command === 'get_available_commands'
    ? engineSource.includes('dialect.rpcAliases.getCommands')
      && OMP_DIALECT.rpcAliases.getCommands === command
    : engineSource.includes(`'${command}'`) || engineSource.includes(`"${command}"`);
  check(`shared engine carries required omp RPC ${command}`, carried);
}
for (const command of fixture.absentCommands) {
  if (command === 'get_commands') continue;
  check(`omp dialect refuses absent RPC ${command}`, OMP_DIALECT.lifecycleCommands[command as 'fork' | 'clone'] === false);
}

const packageRoot = candidatePackageRoots().find((candidate) => existsSync(join(candidate, 'package.json')));
if (packageRoot) {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { name?: string; version?: string };
  check('installed package identity matches the audited fixture', packageJson.name === fixture.package, String(packageJson.name));
  check('installed package version matches the audited fixture', packageJson.version === fixture.nativeVersion, String(packageJson.version));
  const typesSource = readFileSync(join(packageRoot, fixture.source.commandTypes), 'utf8');
  const nativeCommands = commandTypes(typesSource);
  for (const command of fixture.adapterCommands) {
    check(`native ${fixture.nativeVersion} exposes ${command}`, nativeCommands.has(command));
  }
  for (const command of fixture.absentCommands) {
    check(`native ${fixture.nativeVersion} omits ${command}`, !nativeCommands.has(command));
  }
  const forwarderSource = readFileSync(join(packageRoot, fixture.source.eventForwarder), 'utf8');
  check(
    'native RPC mode forwards session events verbatim',
    /session\.subscribe\(event\s*=>\s*\{\s*output\(event\);\s*\}\);/s.test(forwarderSource),
  );
} else {
  console.log('SKIP  matching OMP package source is not installed; L2 fixture/adapter parity still enforced');
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
