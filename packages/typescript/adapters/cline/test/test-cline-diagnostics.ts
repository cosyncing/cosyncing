#!/usr/bin/env bun
export {};
import type {
  SetupCommandProbe,
  SetupDiagnosisContext,
  SetupHttpProbe,
  SetupPathInspection,
} from '@cosyncing/adapter-api';
import { CLINE_MINIMUM_VERSION, diagnoseClineSetup } from '../src/diagnostics.ts';
import { CLINE_HUB_CORE_MINIMUM_VERSION } from '../src/hub.ts';
import {
  CLINE_MEASURED_VERSIONS,
  CLINE_MINIMUM_SUPPORTED_VERSION,
  CLINE_VERIFIED_VERSION,
  clineVersionStanding,
} from '../src/store.ts';

interface FakeWorld {
  env?: Record<string, string | undefined>;
  executable?: string;
  version?: string;
  paths?: Record<string, SetupPathInspection['status']>;
  runReadOnly?: SetupDiagnosisContext['runReadOnly'];
}
const HOME = '/fixture/home';
const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}
function context(world: FakeWorld): SetupDiagnosisContext {
  const paths = world.paths ?? {};
  return {
    effects: 'forbidden', platform: 'linux', arch: 'x64', env: world.env ?? {}, homeDir: HOME,
    resolveExecutable: (command) => command === (world.env?.COSYNCING_CLINE_BIN ?? 'cline') ? world.executable : undefined,
    inspectPath: (path): SetupPathInspection => {
      const status = paths[path] ?? 'missing';
      return { status, readable: status !== 'unreadable', displayPath: path };
    },
    readText: () => ({ ok: false, reason: 'missing' }),
    readPackageVersion: () => world.version,
    runReadOnly: world.runReadOnly
      ?? (async (): Promise<SetupCommandProbe> => ({ status: 'unavailable', stdout: '', stderr: '' })),
    fetchJson: async (): Promise<SetupHttpProbe> => ({ status: 'unreachable' }),
    probeTcp: async () => 'closed',
    listDirectory: () => ({ ok: false, reason: 'missing' }),
    processAlive: () => false,
    displayPath: (path) => path,
  };
}
function checkOf(diagnosis: Awaited<ReturnType<typeof diagnoseClineSetup>>, id: string) {
  return diagnosis.checks.find((entry) => entry.id === id);
}

const defaultData = `${HOME}/.cline/data`;
{
  let probeEnv: Readonly<Record<string, string | undefined>> | undefined;
  const diagnosis = await diagnoseClineSetup(context({
    executable: '/fixture/bin/cline',
    paths: { [defaultData]: 'directory' },
    runReadOnly: async (_executable, _args, _timeoutMs, envOverrides) => {
      probeEnv = envOverrides;
      // A real newline. `\\n` here was an escaping slip: it made the fixture's
      // stdout the literal characters `<version>\n`, which the installed binary
      // never prints and which the hardened version reader correctly refuses.
      return { status: 'ok', exitCode: 0, stdout: `${CLINE_VERIFIED_VERSION}\n`, stderr: '' };
    },
  }));
  check('standalone doctor version probes disable native background self-update',
    probeEnv?.CLINE_NO_AUTO_UPDATE === '1'
      && checkOf(diagnosis, 'cline.version')?.status === 'pass');
}
{
  const diagnosis = await diagnoseClineSetup(context({}));
  check('missing Cline warns for binary and skips absent storage',
    checkOf(diagnosis, 'cline.binary')?.status === 'warn'
      && checkOf(diagnosis, 'cline.version')?.status === 'skip'
      && checkOf(diagnosis, 'cline.storage')?.status === 'skip',
    diagnosis.checks.map((entry) => `${entry.id}=${entry.status}`).join(' '));
  // Deliberately the FLOOR, not `CLINE_VERIFIED_VERSION`. This assertion used to
  // require the two to be equal, which is how doctor came to advertise a minimum
  // of 3.0.61 while 3.0.60 was accepted and driving. The two constants mean
  // different things: one is the oldest build that may Drive, the other is the
  // newest snapshot FORMAT that can be replayed.
  check('doctor advertises the floor it actually enforces',
    diagnosis.minimumVersion === CLINE_MINIMUM_VERSION
      && CLINE_MINIMUM_VERSION.version === CLINE_MINIMUM_SUPPORTED_VERSION);
}
{
  const diagnosis = await diagnoseClineSetup(context({
    // Genuinely NEWER than the pin, which the name has always claimed and the
    // old `3.0.57` literal did not deliver — it was four patches behind. This
    // is the case that actually strands installations: cline updates itself
    // past the measured build, exactly as it did on 2026-09-08.
    executable: '/fixture/bin/cline',
    version: CLINE_VERIFIED_VERSION.replace(/(\d+)(?!.*\d)/, (p) => String(Number(p) + 1)),
    paths: { [defaultData]: 'directory' },
  }));
  check('a newer binary keeps Drive but warns that its own snapshots are not yet replayable',
    checkOf(diagnosis, 'cline.version')?.status === 'warn'
      && checkOf(diagnosis, 'cline.version')?.detailCode === 'version-newer-snapshots-unread',
    JSON.stringify(checkOf(diagnosis, 'cline.version')));
}
// A build that IS measured but below the DERIVED floor. 3.0.60 was recorded on
// 2026-08-30/31 and is listed in the evidence note, yet it ships
// `@cline/core 0.0.81`, below the Hub floor that Create/Drive/Resume run
// through. Reporting it as "older than the measured floor" contradicted the
// same report's own evidence and hid the reason; Observe is unaffected and the
// operator needs to be told that, not sent to a generic upgrade line.
{
  // Asked as the real question rather than "the first one that is not the
  // floor". With another measured version added ABOVE the floor, that picker
  // returns a build whose check is never rewritten, and every assertion below
  // then fails for a reason that has nothing to do with what it tests.
  const belowHub = CLINE_MEASURED_VERSIONS.find(
    (version) => clineVersionStanding(version) === 'below-floor',
  );
  check('a measured build below the Hub-core floor exists to exercise this branch',
    belowHub !== undefined,
    JSON.stringify({ measured: CLINE_MEASURED_VERSIONS, floor: CLINE_MINIMUM_SUPPORTED_VERSION }));
  const diagnosis = await diagnoseClineSetup(context({
    executable: '/fixture/bin/cline',
    version: belowHub ?? CLINE_MINIMUM_SUPPORTED_VERSION,
    paths: { [defaultData]: 'directory', [`${defaultData}/sessions`]: 'directory' },
  }));
  const versionCheck = checkOf(diagnosis, 'cline.version');
  check('a measured build below the Hub-core floor says so, and says Observe survives',
    versionCheck?.status === 'warn'
      && versionCheck.detailCode === 'version-below-hub-core-floor'
      && /Observe is unaffected/.test(versionCheck.summary)
      && !/older than the measured floor/.test(versionCheck.summary),
    JSON.stringify(versionCheck));
  check('and it names the Hub core floor as the cause rather than the CLI floor alone',
    versionCheck?.evidence?.hubCoreMinimumVersion === CLINE_HUB_CORE_MINIMUM_VERSION,
    JSON.stringify(versionCheck?.evidence));
}
{
  const diagnosis = await diagnoseClineSetup(context({
    executable: '/fixture/bin/cline', version: CLINE_VERIFIED_VERSION,
    paths: { [defaultData]: 'directory', [`${defaultData}/sessions`]: 'directory' },
  }));
  check('measured binary and readable snapshot store pass',
    checkOf(diagnosis, 'cline.binary')?.status === 'pass'
      && checkOf(diagnosis, 'cline.version')?.status === 'pass'
      && checkOf(diagnosis, 'cline.storage')?.status === 'pass',
    diagnosis.checks.map((entry) => `${entry.id}=${entry.status}`).join(' '));
}
{
  const diagnosis = await diagnoseClineSetup(context({
    env: { CLINE_DIR: '/fixture/cline', CLINE_DATA_DIR: '/fixture/data', COSYNCING_CLINE_BIN: '/fixture/custom/cline' },
    executable: '/fixture/custom/cline', version: CLINE_VERIFIED_VERSION,
    paths: { '/fixture/data': 'directory' },
  }));
  check('explicit binary and data-root overrides are diagnosed without provider settings',
    checkOf(diagnosis, 'cline.binary')?.evidence?.executable === '/fixture/custom/cline'
      && checkOf(diagnosis, 'cline.storage')?.evidence?.path === '/fixture/data',
    JSON.stringify(diagnosis.checks));
}
{
  const unsafe = await diagnoseClineSetup(context({
    executable: '/fixture/bin/cline', version: CLINE_VERIFIED_VERSION, paths: { [defaultData]: 'file' },
  }));
  check('unsafe storage type fails closed',
    checkOf(unsafe, 'cline.storage')?.status === 'fail'
      && checkOf(unsafe, 'cline.storage')?.detailCode === 'storage-unsafe-type');
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
