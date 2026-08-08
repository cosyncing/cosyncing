#!/usr/bin/env bun
/**
 * The one definition of the release web build (N3).
 *
 * There used to be two: `client:build:web` in package.json built with the
 * deployed base href, and `client:check` built with the default `/`. Both
 * "succeeded", so nothing reported a problem — but whichever ran last decided
 * what `apps/client/build/web` actually contained, and a `/`-based artefact is
 * not the deployment shape. The service worker derives its scope from the base
 * href, so a `/` build registers a worker whose scope covers the broker's own
 * `/api/*` routes, and every browser test run after a check was exercising an
 * app mount that will never ship.
 *
 * Every caller now goes through here.
 *
 *   bun run scripts/client/build-web.ts
 */
import {
  readWebSourceIdentity,
  stampWebCache,
  type WebSourceIdentity,
} from './build-web-cache.ts';
import { runClientCommand } from './run-client-command.ts';
import packageJson from '../../package.json';

/**
 * Where the broker serves the client.
 *
 * The API lives at the origin root, so the app is mounted one level down and
 * the worker's scope stays clear of it. `/cosy/` is also what setup prints and
 * what the tailnet Serve route advertises — one path, no redirect (R16).
 */
export const WEB_BASE_HREF = '/cosy/';

/** The release build, exactly as the deployment ships it. */
export function releaseWebBuildCommand(
  source: WebSourceIdentity,
): readonly string[] {
  return [
    'flutter',
    'build',
    'web',
    '--release',
    '--base-href',
    WEB_BASE_HREF,
    `--dart-define=COSYNCING_CLIENT_VERSION=${packageJson.version}`,
    `--dart-define=COSYNCING_CLIENT_SOURCE_COMMIT=${source.sourceCommit}`,
    `--dart-define=COSYNCING_CLIENT_SOURCE_DIRTY=${source.dirty}`,
  ];
}

/** Import-time command shape used by source checks and focused diagnostics. */
export const WEB_BUILD_COMMAND: readonly string[] = releaseWebBuildCommand(
  readWebSourceIdentity(),
);

/**
 * Work a caller can prove is redundant. Neither changes the artifact.
 *
 * The warning at the top of this file is about producing a differently-shaped
 * `build/web`, and these do not: `--no-pub` skips a dependency resolution the
 * caller has already done, and `--no-wasm-dry-run` skips a Wasm compatibility
 * compile that this JavaScript release build discards. Both stay off by
 * default, so the standalone build keeps working for a caller that has not
 * just run `flutter pub get`.
 */
export interface ReleaseWebOptions {
  /** The caller has already resolved dependencies. */
  noPub?: boolean;
  /** The caller does not want the Wasm compatibility dry run. */
  noWasmDryRun?: boolean;
}

/**
 * Builds `apps/client/build/web` and stamps its service worker.
 *
 * Stamping is part of the build, not a step after it: `flutter build web`
 * copies `web/sw.js` verbatim, placeholders and all, so an unstamped build
 * directory holds a worker that cannot run.
 */
export async function buildReleaseWeb(
  options: ReleaseWebOptions = {},
): Promise<number> {
  // Read once. The compiled diagnostic and release sidecar must describe the
  // same source even if a file changes while Flutter is compiling.
  const sourceIdentity = readWebSourceIdentity();
  const exitCode = await runClientCommand([
    ...releaseWebBuildCommand(sourceIdentity),
    ...(options.noPub ? ['--no-pub'] : []),
    ...(options.noWasmDryRun ? ['--no-wasm-dry-run'] : []),
  ]);
  if (exitCode !== 0) return exitCode;
  return await stampWebCache({ sourceIdentity });
}

if (import.meta.main) {
  process.exit(await buildReleaseWeb());
}
