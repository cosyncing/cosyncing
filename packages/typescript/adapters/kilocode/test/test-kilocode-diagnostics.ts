#!/usr/bin/env bun
export {};
import type {
  SetupCommandProbe,
  SetupDiagnosisContext,
  SetupHttpProbe,
  SetupPathInspection,
} from '@cosyncing/adapter-api';
import { KILO_MINIMUM_VERSION, diagnoseKiloSetup } from '../src/diagnostics.ts';

interface FakeWorld {
  env?: Record<string, string | undefined>;
  executable?: string;
  version?: string;
  paths?: Record<string, SetupPathInspection['status']>;
  names?: Record<string, string[]>;
  listLimits?: number[];
  portOpen?: boolean;
  portUnknown?: boolean;
}
const HOME = '/fixture/home';
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
function context(world: FakeWorld): SetupDiagnosisContext {
  return {
    effects: 'forbidden', platform: 'linux', arch: 'x64', env: world.env ?? {}, homeDir: HOME,
    resolveExecutable: (command) => command === (world.env?.COSYNCING_KILO_BIN ?? 'kilo') ? world.executable : undefined,
    inspectPath: (path) => {
      const status = world.paths?.[path] ?? 'missing';
      return { status, readable: status !== 'unreadable', displayPath: path };
    },
    readText: () => ({ ok: false, reason: 'missing' }),
    readPackageVersion: () => world.version,
    runReadOnly: async (): Promise<SetupCommandProbe> => ({ status: 'unavailable', stdout: '', stderr: '' }),
    fetchJson: async (): Promise<SetupHttpProbe> => ({ status: 'unreachable' }),
    probeTcp: async () => world.portUnknown ? 'unknown' : world.portOpen ? 'open' : 'closed',
    listDirectory: (path, limit) => {
      world.listLimits?.push(limit ?? 0);
      return { ok: true, names: world.names?.[path] ?? [], truncated: false };
    },
    processAlive: () => false,
    displayPath: (path) => path,
  };
}
function checkOf(diagnosis: Awaited<ReturnType<typeof diagnoseKiloSetup>>, id: string) {
  return diagnosis.checks.find((entry) => entry.id === id);
}

const dataRoot = `${HOME}/.local/share/kilo`;
{
  const listLimits: number[] = [];
  const names = Array.from({ length: 65 }, (_, index) => `unrelated-${index}`);
  names.push('kilo.db');
  const diagnosis = await diagnoseKiloSetup(context({
    paths: { [dataRoot]: 'directory', [`${dataRoot}/kilo.db`]: 'file' },
    names: { [dataRoot]: names }, listLimits,
  }));
  check('doctor scans the same bounded root-entry window as production discovery',
    checkOf(diagnosis, 'kilo.storage')?.status === 'pass' && listLimits[0] === 256,
    JSON.stringify(listLimits));
}
{
  const diagnosis = await diagnoseKiloSetup(context({ portUnknown: true }));
  check('an unknown managed-port probe never claims the port is clear',
    checkOf(diagnosis, 'kilo.port-4097')?.status === 'warn'
      && checkOf(diagnosis, 'kilo.port-4097')?.detailCode === 'managed-port-unknown');
}
{
  const diagnosis = await diagnoseKiloSetup(context({}));
  check('missing Kilo warns for binary and skips absent storage and port',
    checkOf(diagnosis, 'kilo.binary')?.status === 'warn'
      && checkOf(diagnosis, 'kilo.storage')?.status === 'skip'
      && checkOf(diagnosis, 'kilo.port-4097')?.status === 'skip');
  check('doctor records the exact full-sync evidence version',
    diagnosis.minimumVersion === KILO_MINIMUM_VERSION && KILO_MINIMUM_VERSION.version === '7.4.23');
}
{
  const diagnosis = await diagnoseKiloSetup(context({
    paths: { [dataRoot]: 'directory', [`${dataRoot}/kilo.db`]: 'file' },
    names: { [dataRoot]: ['opencode.db', 'kilo.db'] }, portOpen: true,
  }));
  check('storage diagnosis applies kilo-over-legacy precedence without opening the DB',
    checkOf(diagnosis, 'kilo.storage')?.status === 'pass'
      && checkOf(diagnosis, 'kilo.storage')?.evidence?.database === `${dataRoot}/kilo.db`);
  check('a listening managed port still defers identity and auth proof to runtime',
    checkOf(diagnosis, 'kilo.port-4097')?.status === 'pass'
      && checkOf(diagnosis, 'kilo.port-4097')?.detailCode === 'managed-port-listening');
}
{
  const diagnosis = await diagnoseKiloSetup(context({
    paths: { [dataRoot]: 'directory', [`${dataRoot}/kilo.db`]: 'other' },
    names: { [dataRoot]: ['kilo.db'] },
  }));
  check('an unsafe selected database fails storage diagnosis',
    checkOf(diagnosis, 'kilo.storage')?.status === 'fail'
      && checkOf(diagnosis, 'kilo.storage')?.detailCode === 'storage-unsafe-type');
}
{
  // 7.4.24 is NEWER than the measured baseline, so it passes. Kilo ships through
  // npm; warning here would fire on any ordinary `npm update -g` and tell the
  // operator to downgrade, which is not something they should be asked to do.
  const diagnosis = await diagnoseKiloSetup(context({
    executable: '/fixture/bin/kilo', version: '7.4.24', paths: { [dataRoot]: 'directory' },
  }));
  check('a newer binary passes while compatible disk Observe remains separately diagnosed',
    checkOf(diagnosis, 'kilo.version')?.status === 'pass'
      && checkOf(diagnosis, 'kilo.version')?.detailCode === 'version-newer-than-measured',
    JSON.stringify(diagnosis.checks));
}
{
  // Below the floor still warns and still withholds managed Create and Drive.
  const diagnosis = await diagnoseKiloSetup(context({
    executable: '/fixture/bin/kilo', version: '7.4.22', paths: { [dataRoot]: 'directory' },
  }));
  check('a binary below the measured floor warns and keeps managed Create disabled',
    checkOf(diagnosis, 'kilo.version')?.status === 'warn'
      && checkOf(diagnosis, 'kilo.version')?.detailCode === 'version-below-measured-floor',
    JSON.stringify(checkOf(diagnosis, 'kilo.version')));
}
{
  const diagnosis = await diagnoseKiloSetup(context({ executable: '/fixture/bin/kilo', version: '7.4.23' }));
  check('the exact measured CLI version passes the full-sync version gate',
    checkOf(diagnosis, 'kilo.version')?.status === 'pass');
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
