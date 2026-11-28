#!/usr/bin/env bun
export {};
import type {
  SetupCommandProbe,
  SetupDiagnosisContext,
  SetupHttpProbe,
  SetupPathInspection,
} from '@cosyncing/adapter-api';
import {
  CLINE_CREATE_CONFIGURATION_CHECK_ID,
  CLINE_MINIMUM_VERSION,
  diagnoseClineSetup,
} from '../src/diagnostics.ts';
import { CLINE_HUB_CORE_MINIMUM_VERSION, clineManagedDataRoot } from '../src/hub.ts';
import {
  CLINE_MEASURED_HUB_CORE,
  CLINE_MEASURED_VERSIONS,
  CLINE_MINIMUM_SUPPORTED_VERSION,
  CLINE_PROVIDER_CATALOG_MINIMUM_VERSION,
  CLINE_VERIFIED_VERSION,
  clineVersionOffersProviderCatalog,
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
// Create's own prerequisite. On the owner's host neither variable was set for
// the service and doctor blamed the runtime, suggesting a restart that comes
// back with the same environment. The check names what is unset and sends the
// operator to setup, which is what copies the pair into the service.
{
  const createCheck = async (env: Record<string, string | undefined>) => checkOf(await diagnoseClineSetup(context({
    env,
    executable: '/fixture/bin/cline',
    version: CLINE_VERIFIED_VERSION,
    paths: { [defaultData]: 'directory', [`${defaultData}/sessions`]: 'directory' },
  })), CLINE_CREATE_CONFIGURATION_CHECK_ID);
  const neither = await createCheck({});
  check('an unset provider/model pair is a Create warning that names both and points at setup, not a restart',
    neither?.status === 'warn'
      && neither.detailCode === 'create-model-unset'
      && /COSYNCING_CLINE_PROVIDER and COSYNCING_CLINE_MODEL are not set/.test(neither.summary)
      && /Observe is unaffected/.test(neither.summary)
      && neither.remediation?.kind === 'command'
      && neither.remediation.command === 'cosyncing setup'
      && /COSYNCING_CLINE_PROVIDER and COSYNCING_CLINE_MODEL/.test(neither.remediation.message)
      && !/restart/i.test(`${neither.summary} ${neither.remediation.message}`),
    JSON.stringify(neither));
  // Setup takes the pair whole: a shell that sets one clears the other, so
  // the remedy names both even when only one is missing.
  const providerOnly = await createCheck({ COSYNCING_CLINE_PROVIDER: 'openai-compatible' });
  check('a half-set pair names only the unset variable, and the remedy still names both',
    providerOnly?.status === 'warn'
      && /COSYNCING_CLINE_MODEL is not set/.test(providerOnly.summary)
      && !/COSYNCING_CLINE_PROVIDER is not set/.test(providerOnly.summary)
      && /COSYNCING_CLINE_PROVIDER and COSYNCING_CLINE_MODEL/.test(providerOnly.remediation?.message ?? ''),
    JSON.stringify(providerOnly));
  const blank = await createCheck({ COSYNCING_CLINE_PROVIDER: 'openai-compatible', COSYNCING_CLINE_MODEL: '  ' });
  check('a blank value counts as unset, exactly as setup and Create treat it',
    blank?.status === 'warn' && /COSYNCING_CLINE_MODEL is not set/.test(blank.summary),
    JSON.stringify(blank));
  const configured = await createCheck({
    COSYNCING_CLINE_PROVIDER: 'openai-compatible',
    COSYNCING_CLINE_MODEL: 'fixture-model',
  });
  check('a configured pair passes and names the pair Create will use',
    configured?.status === 'pass'
      && configured.evidence?.provider === 'openai-compatible'
      && configured.evidence?.model === 'fixture-model'
      && configured.remediation === undefined,
    JSON.stringify(configured));
  check('without a binary there is no Create configuration finding; cline.binary already says why',
    checkOf(await diagnoseClineSetup(context({})), CLINE_CREATE_CONFIGURATION_CHECK_ID) === undefined);

  // A Hub with `providers.list` offers the managed profile's own providers, so the pair is optional
  // once that profile has provider settings. Doctor may not ask the Hub and must not read the file
  // (it holds the API keys), so it inspects the file's presence only.
  const providerSettings = `${clineManagedDataRoot({}, HOME)}/settings/providers.json`;
  const catalogCheck = async (
    version: string,
    status: SetupPathInspection['status'] | undefined,
    env: Record<string, string | undefined> = {},
  ) => {
    let read = false;
    const world = context({
      env,
      executable: '/fixture/bin/cline',
      version,
      paths: {
        [defaultData]: 'directory',
        [`${defaultData}/sessions`]: 'directory',
        ...(status ? { [providerSettings]: status } : {}),
      },
    });
    const finding = checkOf(await diagnoseClineSetup({
      ...world,
      readText: (path, maxBytes) => {
        if (path === providerSettings) read = true;
        return world.readText(path, maxBytes);
      },
    }), CLINE_CREATE_CONFIGURATION_CHECK_ID);
    return { finding, read };
  };
  check('the catalog floor is a measured build whose Hub core has the provider commands',
    CLINE_PROVIDER_CATALOG_MINIMUM_VERSION !== undefined
      && CLINE_MEASURED_VERSIONS.includes(CLINE_PROVIDER_CATALOG_MINIMUM_VERSION)
      && CLINE_MEASURED_HUB_CORE[CLINE_PROVIDER_CATALOG_MINIMUM_VERSION] === '0.2.1'
      && clineVersionOffersProviderCatalog(CLINE_VERIFIED_VERSION)
      && !clineVersionOffersProviderCatalog(CLINE_MINIMUM_SUPPORTED_VERSION),
    String(CLINE_PROVIDER_CATALOG_MINIMUM_VERSION));
  const profileConfigured = await catalogCheck(CLINE_VERIFIED_VERSION, 'file');
  check('a catalog-capable Cline with managed-profile provider settings passes without the pair, unread',
    profileConfigured.finding?.status === 'pass'
      && profileConfigured.finding.detailCode === 'create-providers-in-managed-profile'
      && profileConfigured.finding.evidence?.providerSettings === providerSettings
      && /COSYNCING_CLINE_PROVIDER and COSYNCING_CLINE_MODEL are optional/.test(profileConfigured.finding.summary)
      && profileConfigured.finding.remediation === undefined
      && !profileConfigured.read,
    JSON.stringify(profileConfigured));
  const profileUnreadable = await catalogCheck(CLINE_VERIFIED_VERSION, 'unreadable');
  const profileDirectory = await catalogCheck(CLINE_VERIFIED_VERSION, 'directory');
  check('provider settings that are unreadable or not a file do not pass',
    profileUnreadable.finding?.status === 'warn' && profileUnreadable.finding.detailCode === 'create-model-unset'
      && profileDirectory.finding?.status === 'warn' && profileDirectory.finding.detailCode === 'create-model-unset',
    JSON.stringify([profileUnreadable.finding, profileDirectory.finding]));
  const profileEmpty = await catalogCheck(CLINE_VERIFIED_VERSION, undefined);
  check('without them it still names both variables and setup, and now the managed profile too, never a restart',
    profileEmpty.finding?.status === 'warn'
      && profileEmpty.finding.detailCode === 'create-model-unset'
      && /managed Cline profile/.test(profileEmpty.finding.summary)
      && /COSYNCING_CLINE_PROVIDER and COSYNCING_CLINE_MODEL are not set/.test(profileEmpty.finding.summary)
      && /Observe is unaffected/.test(profileEmpty.finding.summary)
      && profileEmpty.finding.remediation?.command === 'cosyncing setup'
      && /COSYNCING_CLINE_PROVIDER and COSYNCING_CLINE_MODEL/.test(profileEmpty.finding.remediation.message)
      && !/restart/i.test(`${profileEmpty.finding.summary} ${profileEmpty.finding.remediation.message}`),
    JSON.stringify(profileEmpty.finding));
  const preCatalog = await catalogCheck(CLINE_MINIMUM_SUPPORTED_VERSION, 'file');
  check('a Cline whose Hub has no provider commands still needs the pair, whatever the profile holds',
    preCatalog.finding?.status === 'warn'
      && preCatalog.finding.detailCode === 'create-model-unset'
      && !/managed Cline profile/.test(preCatalog.finding.summary)
      && !preCatalog.read,
    JSON.stringify(preCatalog.finding));
  const pairWins = await catalogCheck(CLINE_VERIFIED_VERSION, 'file', {
    COSYNCING_CLINE_PROVIDER: 'openai-compatible',
    COSYNCING_CLINE_MODEL: 'fixture-model',
  });
  check('a configured pair still passes as the pair, which Create prefers',
    pairWins.finding?.status === 'pass'
      && pairWins.finding.detailCode === 'create-model-configured'
      && pairWins.finding.evidence?.model === 'fixture-model',
    JSON.stringify(pairWins.finding));
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
