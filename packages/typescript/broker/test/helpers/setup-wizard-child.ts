/**
 * The interactive `setup` run, as a child a suite drives through a pseudo-terminal.
 *
 * `runCli(['setup', ...flags])` with no `--yes` builds the REAL clack presenter, which only runs on a
 * terminal: a suite that wants the wizard's own yes or no has to give it one, which script(1) does. This
 * file is that child. It points the real argv parser, presenter and `runSetup` at a suite's scratch home
 * and fake `claude`, with the same pinned-closed probes the in-process fixtures use, and prints
 * `RESULT=<exit code>` last.
 *
 * Only a source build runs here: a packaged one would offer the durable service, and a fixture never
 * touches a service.
 */
import { join } from 'node:path';
import { BUILD_INFO } from '../../src/runtime/build-info.ts';
import { createSetupDiagnosisContext } from '../../src/installation/diagnosis-context.ts';
import { runCli } from '../../src/cli/cli.ts';
import type { SetupDiagnosisContext } from '../../../adapter-api/src/index.ts';

export interface SetupWizardChildInput {
  userHome: string;
  home: string;
  fakeBinDir: string;
  fakeConfigDir: string;
  /** The build version this run claims, so a rerun on a committed install has real work to do. */
  version: string;
  flags: string[];
  now: string;
}

if (import.meta.main) {
  const input = JSON.parse(process.argv[2] ?? '{}') as SetupWizardChildInput;
  if (BUILD_INFO.packaged) {
    console.log('RESULT=refused-packaged-build');
    process.exit(3);
  }
  const context: SetupDiagnosisContext = {
    ...createSetupDiagnosisContext({
      homeDir: input.userHome,
      platform: 'linux',
      arch: 'x64',
      env: {
        HOME: input.userHome,
        PATH: input.fakeBinDir,
        COSYNCING_HOME: input.home,
        COSYNCING_CACHE_DIR: join(input.userHome, '.cache', 'cosyncing'),
        CODEX_HOME: join(input.userHome, '.codex'),
        PI_CODING_AGENT_DIR: join(input.userHome, '.pi', 'agent'),
        COSYNCING_OMP_AGENT_DIR: join(input.userHome, '.omp', 'agent'),
        CLAUDE_CONFIG_DIR: input.fakeConfigDir,
      },
    }),
    probeTcp: async () => 'closed' as const,
    fetchJson: async () => ({ status: 'unreachable' as const }),
    listenerProcess: async () => undefined,
  };
  const writer = { write: (text: string) => { process.stdout.write(text); } };
  const exitCode = await runCli(['setup', ...input.flags], {
    buildInfo: { ...BUILD_INFO, version: input.version },
    stdout: writer,
    stderr: writer,
    setupOverrides: {
      executablePath: join(input.userHome, 'bin', 'cosyncing'),
      home: input.home,
      context,
      now: () => new Date(input.now),
      claudePolicyRoots: [join(input.userHome, 'no-managed-policy')],
    },
  });
  console.log(`RESULT=${exitCode}`);
  process.exit(exitCode);
}
