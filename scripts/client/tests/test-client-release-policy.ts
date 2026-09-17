#!/usr/bin/env bun
import { createPublicKey } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import packageJson from '../../../package.json';
import { REPOSITORY_ROOT } from '../run-client-command.ts';

let failures = 0;

function check(ok: unknown, message: string): void {
  if (ok) {
    console.log(`PASS ${message}`);
  } else {
    failures += 1;
    console.error(`FAIL ${message}`);
  }
}

const read = (path: string): Promise<string> =>
  readFile(join(REPOSITORY_ROOT, path), 'utf8');

const [
  pubspec,
  gradle,
  candidate,
  promotion,
  brokerRelease,
  notes,
  androidCertificate,
  releaseKey,
  androidUpdate,
  androidActivity,
] =
  await Promise.all([
    read('apps/client/pubspec.yaml'),
    read('apps/client/android/app/build.gradle.kts'),
    read('.github/workflows/client-release.yml'),
    read('.github/workflows/client-release-promote.yml'),
    read('.github/workflows/broker-release.yml'),
    read('docs/release/client-release-notes.md'),
    read('docs/release/android-signing-certificate.sha256'),
    read('docs/release/release-public-key.txt'),
    read('apps/client/lib/src/platform/update/android_client_update.dart'),
    read('apps/client/android/app/src/main/kotlin/com/cosyncing/client/MainActivity.kt'),
  ]);

const pubspecVersion = /^version:\s*([0-9]+\.[0-9]+\.[0-9]+)\+[0-9]+$/m
  .exec(pubspec)?.[1];
check(
  pubspecVersion === packageJson.version,
  'Flutter and product release versions have the same semantic version',
);

for (const name of [
  'COSYNCING_ANDROID_KEYSTORE_PATH',
  'COSYNCING_ANDROID_KEYSTORE_PASSWORD',
  'COSYNCING_ANDROID_KEY_ALIAS',
  'COSYNCING_ANDROID_KEY_PASSWORD',
  'COSYNCING_REQUIRE_ANDROID_RELEASE_SIGNING',
]) {
  check(gradle.includes(name), `Android release signing consumes ${name}`);
}
check(
  gradle.includes('if (requireReleaseSigning && !hasReleaseSigning)'),
  'required Android release signing fails closed before Gradle configures a build',
);
check(
  gradle.includes('signingConfigs.getByName("cosyncingRelease")'),
  'protected Android releases select the project-owned signing config',
);
check(
  gradle.includes('signingConfigs.getByName("debug")'),
  'local release-mode smoke retains its explicitly scoped debug fallback',
);

const assetSuffixes = [
  '-android.apk',
  '-linux-x64.tar.gz',
  '-macos-arm64-unsigned.dmg',
  // The same macOS app as the DMG, in the archive the all-in-one installer can unpack unattended.
  '-macos-arm64-unsigned.zip',
  '-windows-x64-unsigned.zip',
];
for (const suffix of assetSuffixes) {
  check(candidate.includes(suffix), `candidate workflow names ${suffix} explicitly`);
  check(promotion.includes(suffix), `promotion verifies ${suffix} explicitly`);
}

check(
  !/(flutter build ios|\.ipa\b)/.test(candidate),
  'client release does not claim an iOS distribution',
);
check(
  candidate.includes('COSYNCING_REQUIRE_ANDROID_RELEASE_SIGNING: \'true\''),
  'candidate workflow requires protected Android signing',
);
check(
  candidate.includes('apksigner" verify --verbose --print-certs'),
  'candidate workflow verifies the final Android APK signature',
);
check(
  /^[0-9a-f]{64}\n$/.test(androidCertificate),
  'reviewed Android signing certificate is one normalized SHA-256 digest',
);
check(
  candidate.includes('docs/release/android-signing-certificate.sha256') &&
    candidate.includes('extract-android-signer-digest.sh') &&
    candidate.includes('actual_signer') &&
    candidate.includes('expected_signer'),
  'candidate binds the Android APK to the reviewed signing certificate',
);
check(
  candidate.includes('aapt" dump badging') &&
    candidate.includes(
      'test "$actual_version_code" = "$expected_version_code"',
    ),
  'candidate binds the APK versionCode to the reviewed pubspec build number',
);
check(
  candidate.includes('Android versionCode must increase') &&
    candidate.includes('gh release list') &&
    candidate.includes('gh release download'),
  'candidate refuses a versionCode that cannot upgrade the prior stable APK',
);
const releaseKeyDer = createPublicKey(releaseKey).export({
  format: 'der',
  type: 'spki',
}).toString('base64url');
check(
  androidUpdate.includes(`'${releaseKeyDer}'`) &&
    brokerRelease.includes(
      'cmp docs/release/release-public-key.txt "$RUNNER_TEMP/cosyncing-release.pub.pem"',
    ),
  'Android embeds the exact public key that signs promoted release manifests',
);
check(
  brokerRelease.includes('aapt" dump badging') &&
    brokerRelease.includes('versionName') &&
    brokerRelease.includes('extract-android-signer-digest.sh'),
  'broker signing independently validates the accepted APK identity',
);
check(
  androidActivity.indexOf('archive.versionName != expectedVersion') <
      androidActivity.indexOf('canRequestPackageInstalls()'),
  'native APK identity is validated before requesting install-source permission',
);

const signerExtractor = join(
  REPOSITORY_ROOT,
  'scripts/client/extract-android-signer-digest.sh',
);
const signerFixtureRoot = await mkdtemp(
  join(tmpdir(), 'cosyncing-android-signer-'),
);
try {
  const digest = 'e999815a834075ce1d358c1e346a8e29f2be7669fe43873bf7bf4dfb0e6aaf56';
  const cases = [
    {
      name: 'current V2 apksigner label',
      content: `V2 Signer: certificate SHA-256 digest: ${digest}\n`,
      expected: digest,
    },
    {
      name: 'legacy numbered apksigner label',
      content: `Signer #1 certificate SHA-256 digest: ${digest.toUpperCase()}\n`,
      expected: digest,
    },
  ];
  for (const fixture of cases) {
    const path = join(signerFixtureRoot, `${fixture.name.replaceAll(' ', '-')}.txt`);
    await writeFile(path, fixture.content);
    const result = Bun.spawnSync([signerExtractor, path], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    check(
      result.exitCode === 0 && result.stdout.toString().trim() === fixture.expected,
      `Android signer extraction accepts the ${fixture.name}`,
    );
  }

  for (const fixture of [
    {
      name: 'missing certificate digest',
      content: `V2 Signer: public key SHA-256 digest: ${digest}\n`,
    },
    {
      name: 'multiple certificate digests',
      content:
        `V2 Signer: certificate SHA-256 digest: ${digest}\n` +
        `Signer #2 certificate SHA-256 digest: ${digest}\n`,
    },
  ]) {
    const path = join(signerFixtureRoot, `${fixture.name.replaceAll(' ', '-')}.txt`);
    await writeFile(path, fixture.content);
    const result = Bun.spawnSync([signerExtractor, path], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    check(
      result.exitCode !== 0,
      `Android signer extraction refuses ${fixture.name}`,
    );
  }
} finally {
  await rm(signerFixtureRoot, { recursive: true, force: true });
}
check(
  candidate.includes('--prerelease=true --latest=false'),
  'candidate remains a prerelease until physical acceptance',
);
check(
  /publish-candidate:[\s\S]*?GH_REPO: \$\{\{ github\.repository \}\}/.test(
    candidate,
  ),
  'checkout-free candidate publication binds GitHub CLI to this repository',
);
check(
  promotion.includes("inputs.confirm == 'PROMOTE'"),
  'stable promotion requires typed owner confirmation',
);
check(
  promotion.includes('--prerelease=false --latest=false'),
  'accepted assets promote to stable without taking the latest pointer',
);
// Spelled as its own check because the one above would pass on `--latest` too: `--latest=false` contains
// it as a substring, so a rule stated only as "includes --prerelease=false --latest" is satisfied by both
// answers. GitHub keeps ONE latest release per repository and every installed broker compiles
// `releases/latest/download/release-manifest.json` in as its update channel, so a client release holding
// that pointer 404s every broker's update check. The broker release is the only one that may hold it.
check(
  // Comments stripped, because the workflow NAMES the flag to explain why it does not pass it.
  !/--latest(?!=false)/.test(
    promotion.split('\n').map((line) => line.replace(/(^|\s)#.*$/, '')).join('\n'),
  ),
  'client promotion never claims the latest pointer the broker update channel resolves through',
);
check(
  !/(flutter build|client:build|gh release upload)/.test(promotion),
  'stable promotion cannot rebuild or replace candidate assets',
);

check(
  /macOS[\s\S]*not Developer ID signed or[\s\S]*notarized/.test(notes),
  'release notes disclose unsigned and unnotarized macOS status',
);
check(
  /Windows[\s\S]*intentionally unsigned[\s\S]*SmartScreen/.test(notes),
  'release notes disclose unsigned Windows SmartScreen behavior',
);
check(
  /iOS is not distributed[\s\S]*Apple Developer Program/.test(notes),
  'release notes explain why iOS distribution is deferred',
);

if (failures > 0) process.exit(1);
