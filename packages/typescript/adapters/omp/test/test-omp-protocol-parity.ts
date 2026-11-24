#!/usr/bin/env bun
/**
 * OMP protocol lock: one reviewed surface per captured build (17.4.2 and 19.1.0).
 *
 * The checked-in fixtures are reviewed L2 compatibility evidence, not a deterministic native drift
 * gate. This suite always diffs them against the dialect, the version list and the shared engine.
 * When matching OMP source is installed (or supplied with COSYNCING_OMP_PACKAGE_ROOT), it also
 * audits that build against its own fixture.
 */
export {};
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { OMP_DIALECT } from '../src/dialect.ts';
import { OMP_VERIFIED_VERSION, OMP_VERIFIED_VERSIONS, ompSupportsRpcFork } from '../src/runtime-readiness.ts';

interface SurfaceFixture {
  schemaVersion: number;
  package: string;
  nativeVersion: string;
  /** `eventForwarderPattern`: how that build forwards session events to RPC stdout (17.4.2's
   *  verbatim `output(event)` when absent). */
  source: { commandTypes: string; eventForwarder: string; eventForwarderPattern?: string };
  adapterCommands: string[];
  absentCommands: string[];
  consumedEvents: string[];
}

const fixtures = OMP_VERIFIED_VERSIONS.map((version) => JSON.parse(
  readFileSync(join(import.meta.dir, 'fixtures', `omp-rpc-surface-${version}.json`), 'utf8'),
) as SurfaceFixture);
const newest = fixtures.find((fixture) => fixture.nativeVersion === OMP_VERIFIED_VERSION)!;
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

check('one reviewed fixture per verified version, schema pinned',
  fixtures.length === OMP_VERIFIED_VERSIONS.length
    && fixtures.every((fixture, index) => fixture.schemaVersion === 1 && fixture.nativeVersion === OMP_VERIFIED_VERSIONS[index]),
  fixtures.map((fixture) => fixture.nativeVersion).join(','));
check('omp command alias is get_available_commands', OMP_DIALECT.rpcAliases.getCommands === 'get_available_commands');
check('omp advertises RPC fork and never clone', OMP_DIALECT.lifecycleCommands.fork && !OMP_DIALECT.lifecycleCommands.clone);

// The engine consumes exactly the newest captured surface; an older build's events are a subset
// (17.4.2 has no session_settled), so it is driven by the same handler.
const consumed = engineConsumedEvents(engineSource);
check(
  'newest audited event fixture exactly matches the shared engine consumed set',
  sameStrings(consumed, newest.consumedEvents),
  `fixture=${sorted(newest.consumedEvents).join(',')} engine=${sorted(consumed).join(',')}`,
);
for (const fixture of fixtures) {
  const missing = fixture.consumedEvents.filter((event) => !consumed.has(event));
  check(`omp ${fixture.nativeVersion} events are all consumed by the shared engine`, missing.length === 0, missing.join(','));
  for (const command of fixture.adapterCommands) {
    const carried = command === 'get_available_commands'
      ? engineSource.includes('dialect.rpcAliases.getCommands')
        && OMP_DIALECT.rpcAliases.getCommands === command
      : engineSource.includes(`'${command}'`) || engineSource.includes(`"${command}"`);
    check(`shared engine carries required omp ${fixture.nativeVersion} RPC ${command}`, carried);
  }
  for (const command of fixture.absentCommands) {
    if (command === 'get_commands') continue;
    // fork is gated per version (OmpAdapter.canForkSession); clone is never offered.
    const refused = command === 'fork'
      ? !ompSupportsRpcFork(fixture.nativeVersion)
      : OMP_DIALECT.lifecycleCommands[command as 'fork' | 'clone'] === false;
    check(`omp ${fixture.nativeVersion} is never sent absent RPC ${command}`, refused);
  }
  if (fixture.adapterCommands.includes('fork')) {
    check(`omp ${fixture.nativeVersion} offers its RPC fork`, ompSupportsRpcFork(fixture.nativeVersion));
  }
}

const packageRoot = candidatePackageRoots().find((candidate) => existsSync(join(candidate, 'package.json')));
if (packageRoot) {
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as { name?: string; version?: string };
  const fixture = fixtures.find((candidate) => candidate.nativeVersion === packageJson.version);
  check('installed package version matches an audited fixture', fixture !== undefined, String(packageJson.version));
  if (!fixture) {
    const failed = results.filter((result) => !result.ok).length;
    console.log(`\n${results.length - failed} passed, ${failed} failed`);
    process.exit(1);
  }
  check('installed package identity matches the audited fixture', packageJson.name === fixture.package, String(packageJson.name));
  const typesSource = readFileSync(join(packageRoot, fixture.source.commandTypes), 'utf8');
  const nativeCommands = commandTypes(typesSource);
  for (const command of fixture.adapterCommands) {
    check(`native ${fixture.nativeVersion} exposes ${command}`, nativeCommands.has(command));
  }
  for (const command of fixture.absentCommands) {
    check(`native ${fixture.nativeVersion} omits ${command}`, !nativeCommands.has(command));
  }
  const forwarderSource = readFileSync(join(packageRoot, fixture.source.eventForwarder), 'utf8');
  const forwarder = fixture.source.eventForwarderPattern
    ? new RegExp(fixture.source.eventForwarderPattern, 's')
    : /session\.subscribe\(event\s*=>\s*\{\s*output\(event\);\s*\}\);/s;
  check('native RPC mode forwards every session event', forwarder.test(forwarderSource));
} else {
  console.log('SKIP  matching OMP package source is not installed; L2 fixture/adapter parity still enforced');
}

const failed = results.filter((result) => !result.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
