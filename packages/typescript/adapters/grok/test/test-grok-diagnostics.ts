#!/usr/bin/env bun
/** Grok doctor stays read-only, Observe-aware, and exact about Drive evidence. */
export {};
import type {
  SetupCommandProbe,
  SetupDiagnosisContext,
  SetupHttpProbe,
  SetupPathInspection,
} from '@cosyncing/adapter-api';
import { diagnoseGrokSetup, GROK_MINIMUM_VERSION } from '../src/diagnostics.ts';

interface FakeWorld {
  env?: Record<string, string | undefined>;
  executable?: string;
  version?: string;
  paths?: Record<string, SetupPathInspection['status']>;
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
    effects: 'forbidden',
    platform: 'linux',
    arch: 'x64',
    env: world.env ?? {},
    homeDir: HOME,
    resolveExecutable: (command) => command === (world.env?.COSYNCING_GROK_BIN ?? 'grok')
      ? world.executable
      : undefined,
    inspectPath: (path): SetupPathInspection => {
      const status = paths[path] ?? 'missing';
      return { status, readable: status !== 'unreadable', displayPath: path };
    },
    readText: () => ({ ok: false, reason: 'missing' }),
    readPackageVersion: () => world.version,
    runReadOnly: async (): Promise<SetupCommandProbe> => ({ status: 'unavailable', stdout: '', stderr: '' }),
    fetchJson: async (): Promise<SetupHttpProbe> => ({ status: 'unreachable' }),
    probeTcp: async () => 'closed',
    listDirectory: () => ({ ok: false, reason: 'missing' }),
    processAlive: () => false,
    displayPath: (path) => path,
  };
}

function checkOf(diagnosis: Awaited<ReturnType<typeof diagnoseGrokSetup>>, id: string) {
  return diagnosis.checks.find((entry) => entry.id === id);
}

const defaultRoot = `${HOME}/.grok`;

{
  const diagnosis = await diagnoseGrokSetup(context({}));
  check('missing Grok warns for the binary and skips version and storage claims',
    checkOf(diagnosis, 'grok.binary')?.status === 'warn'
      && checkOf(diagnosis, 'grok.version')?.status === 'skip'
      && checkOf(diagnosis, 'grok.storage')?.status === 'skip',
    diagnosis.checks.map((entry) => `${entry.id}=${entry.status}`).join(' '));
  check('the doctor floor is the exact measured native build',
    diagnosis.minimumVersion === GROK_MINIMUM_VERSION
      && GROK_MINIMUM_VERSION.version === '1.0.13');
}

{
  const diagnosis = await diagnoseGrokSetup(context({
    executable: '/fixture/bin/grok',
    version: '1.0.13',
    paths: {
      [defaultRoot]: 'directory',
      [`${defaultRoot}/sessions`]: 'directory',
    },
  }));
  check('the exact binary and readable session store pass',
    checkOf(diagnosis, 'grok.binary')?.status === 'pass'
      && checkOf(diagnosis, 'grok.version')?.status === 'pass'
      && checkOf(diagnosis, 'grok.storage')?.status === 'pass',
    diagnosis.checks.map((entry) => `${entry.id}=${entry.status}`).join(' '));
}

{
  const diagnosis = await diagnoseGrokSetup(context({
    executable: '/fixture/bin/grok',
    version: '0.2.115',
    paths: { [defaultRoot]: 'directory' },
  }));
  // 0.2.115 sorts BELOW 1.0.13. This fixture was described as "a newer but
  // unmeasured binary", which it never was — the exact-match gate warned on any
  // difference, so the mislabel could not fail. Ordering matters now, so the two
  // cases are split and each uses a version really on the side it claims.
  check('a binary below the measured floor warns while retaining Observe-only support',
    checkOf(diagnosis, 'grok.version')?.status === 'warn'
      && checkOf(diagnosis, 'grok.version')?.detailCode === 'version-below-measured-floor',
    JSON.stringify(checkOf(diagnosis, 'grok.version')));
}

{
  // The property the exact-version gate denied: Grok updates itself, so an
  // ordinary self-update must not cost the operator Create and Resume — and must
  // not warn either, since a warning on every release trains them to ignore
  // doctor entirely.
  const diagnosis = await diagnoseGrokSetup(context({
    executable: '/fixture/bin/grok',
    version: '9.9.9',
    paths: { [defaultRoot]: 'directory' },
  }));
  check('a binary newer than every measured version passes without a warning',
    checkOf(diagnosis, 'grok.version')?.status === 'pass'
      && checkOf(diagnosis, 'grok.version')?.detailCode === 'version-newer-than-measured',
    JSON.stringify(checkOf(diagnosis, 'grok.version')));
}

{
  const customRoot = '/fixture/custom-grok';
  const customBin = '/fixture/custom-bin/grok-build';
  const diagnosis = await diagnoseGrokSetup(context({
    env: { GROK_HOME: customRoot, COSYNCING_GROK_BIN: customBin },
    executable: customBin,
    version: '1.0.13',
    paths: { [customRoot]: 'directory' },
  }));
  check('GROK_HOME and COSYNCING_GROK_BIN select deliberate nonstandard paths',
    checkOf(diagnosis, 'grok.binary')?.evidence?.executable === customBin
      && checkOf(diagnosis, 'grok.storage')?.evidence?.path === customRoot,
    JSON.stringify(diagnosis.checks));
}

{
  const missing = await diagnoseGrokSetup(context({
    executable: '/fixture/bin/grok',
    version: '1.0.13',
  }));
  const unsafe = await diagnoseGrokSetup(context({
    executable: '/fixture/bin/grok',
    version: '1.0.13',
    paths: { [defaultRoot]: 'file' },
  }));
  check('an absent store warns but an unsafe store type fails',
    checkOf(missing, 'grok.storage')?.detailCode === 'storage-missing'
      && checkOf(missing, 'grok.storage')?.status === 'warn'
      && checkOf(unsafe, 'grok.storage')?.detailCode === 'storage-unsafe-type'
      && checkOf(unsafe, 'grok.storage')?.status === 'fail');
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
