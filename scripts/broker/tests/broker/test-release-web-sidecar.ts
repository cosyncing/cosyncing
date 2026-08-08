#!/usr/bin/env bun
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import packageJson from '../../../../package.json';
import { writeStampedWebBuild } from '../../tests/helpers/stamped-web-build.ts';
import {
  stageWebSidecarDirectory,
  validateWebBuildForPackaging,
  validateWebBuildShape,
  writeWebSidecarArchive,
} from '../../release/package-web-sidecar.ts';

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, ok: boolean, detail?: string): void {
  results.push({ name, ok, ...(detail ? { detail } : {}) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

function rejectsMutation(
  name: string,
  task: () => void,
  expectedPath: string,
): void {
  try {
    task();
    check(name, false, 'accepted a mutated cached asset');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, message.includes(expectedPath), message);
  }
}

const buildDirectory = mkdtempSync(join(tmpdir(), 'cosyncing-release-web-'));
const archiveDirectory = mkdtempSync(
  join(tmpdir(), 'cosyncing-release-archive-'),
);
try {
  const { buildVersion, sourceCommit } = await writeStampedWebBuild(buildDirectory);
  const options = {
    buildDirectory,
    version: packageJson.version,
    sourceCommit,
  };
  const validated = validateWebBuildForPackaging(options);
  check(
    'canonical stamped worker and every manifest-listed byte pass',
    validated.cacheManifest.buildVersion === buildVersion
      && validated.paths.includes('assets/NOTICES'),
  );
  const artifactPath = join(archiveDirectory, 'web.tar.gz');
  writeWebSidecarArchive({
    buildDirectory,
    artifactPath,
    buildDate: '2026-07-30T00:00:00.000Z',
    paths: validated.paths,
  });
  const archiveListing = Bun.spawnSync(
    ['tar', '-tzf', artifactPath],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  check(
    'release archive contains uncached NOTICE bytes',
    archiveListing.success
      && archiveListing.stdout.toString().split('\n')
        .includes('app/assets/NOTICES'),
    archiveListing.stderr.toString().trim(),
  );

  // The npm channel ships the same closed set as a plain directory beside the binary rather than as a signed
  // tarball, because a packaged broker resolves its web root as `dirname(<executable>)/cosyncing-web-<ver>`.
  // Same validated paths, same bytes, same shape validation — only the container differs.
  {
    const staged = join(archiveDirectory, `cosyncing-web-${packageJson.version}`);
    stageWebSidecarDirectory({
      buildDirectory,
      targetDirectory: staged,
      paths: validated.paths,
    });
    const stagedPaths = validated.paths.filter(
      (path) => existsSync(join(staged, ...path.split('/'))),
    );
    check(
      'the npm sidecar directory carries every validated path and nothing else',
      stagedPaths.length === validated.paths.length
        && readdirSync(staged).length
          === new Set(validated.paths.map((path) => path.split('/')[0])).size
        && readFileSync(join(staged, 'index.html'), 'utf8')
          .includes('<base href="/cosy/">'),
      `${stagedPaths.length}/${validated.paths.length} entries=${readdirSync(staged).sort().join(',')}`,
    );
    // The /cosy/ mount is what the stamper refuses to produce; the shape check is what keeps one out of an
    // npm tarball, and it must refuse a `/`-mounted build that is internally consistent in every other
    // respect — the npm path asserts no source commit and no clean tree, so this is the only guard left.
    const rootShell = mkdtempSync(join(tmpdir(), 'cosyncing-web-root-'));
    try {
      await writeStampedWebBuild(rootShell, '/');
      rejectsMutation(
        'a self-consistent non-/cosy/ build is still refused by the shape validation npm packaging uses',
        () => validateWebBuildShape({ buildDirectory: rootShell }),
        'web build identity',
      );
    } finally {
      rmSync(rootShell, { recursive: true, force: true });
    }
  }

  const indexPath = join(buildDirectory, 'index.html');
  const originalIndex = readFileSync(indexPath);
  writeFileSync(indexPath, Buffer.concat([originalIndex, Buffer.from('x')]));
  rejectsMutation(
    'one-byte precache mutation is rejected before packaging',
    () => validateWebBuildForPackaging(options),
    'index.html',
  );
  writeFileSync(indexPath, originalIndex);

  const runtimePath = join(
    buildDirectory,
    'canvaskit',
    'canvaskit.wasm',
  );
  const originalRuntime = readFileSync(runtimePath);
  writeFileSync(
    runtimePath,
    Buffer.concat([originalRuntime, Buffer.from('x')]),
  );
  rejectsMutation(
    'one-byte runtime mutation is rejected before packaging',
    () => validateWebBuildForPackaging(options),
    'canvaskit/canvaskit.wasm',
  );
  writeFileSync(runtimePath, originalRuntime);

  const noticesPath = join(buildDirectory, 'assets', 'NOTICES');
  const originalNotices = readFileSync(noticesPath);
  writeFileSync(
    noticesPath,
    Buffer.concat([originalNotices, Buffer.from('x')]),
  );
  rejectsMutation(
    'one-byte release-only NOTICE mutation is rejected before packaging',
    () => validateWebBuildForPackaging(options),
    'web build identity',
  );
  writeFileSync(noticesPath, originalNotices);
} finally {
  rmSync(buildDirectory, { recursive: true, force: true });
  rmSync(archiveDirectory, { recursive: true, force: true });
}

const failed = results.filter((result) => !result.ok);
if (failed.length > 0) {
  console.error(
    `FAIL: ${failed.length}/${results.length} release web sidecar checks`,
  );
  process.exit(1);
}
console.log(
  `PASS ${results.length}/${results.length} release web sidecar checks`,
);
