import assert from 'node:assert/strict';
import { sign } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  assembleRelease, sha256, type ReleaseAssemblyOptions,
} from '../../release/release-files.ts';
import { stagingAssetBlockers } from '../../release/verify-staging-assets.ts';
import { promotionAssetBlockers } from '../../release/verify-promotion-assets.ts';
import {
  releaseManifestSigningPayload, verifySignedManifest, verifyReleaseManifest,
  type ReleaseManifest,
} from '../../../../packages/typescript/broker/src/updates/release-upgrade.ts';

/** Run against the same signed release the real shell installer acceptance uses. */
export function javaScriptReleaseRegressions(options: ReleaseAssemblyOptions): void {
  const candidate = options.outputDirectory;
  const root = join(candidate, '..', 'javascript-regressions');
  mkdirSync(root, { recursive: true });
  const manifest: ReleaseManifest = JSON.parse(readFileSync(join(candidate, 'release-manifest.json'), 'utf8'));
  const trusted = { [options.keyId]: options.publicKeyPem };
  const signed = (value: ReleaseManifest): ReleaseManifest => {
    const { signature, ...unsigned } = value;
    return { ...unsigned, signature: { ...signature,
      value: sign(null, releaseManifestSigningPayload(unsigned), options.privateKeyPem).toString('base64'),
    } };
  };
  assert.equal(manifest.artifacts.length, 0);
  assert.equal(verifySignedManifest(manifest, trusted).jsApp?.target, 'universal');
  assert.throws(() => verifyReleaseManifest({ value: manifest, target: 'linux-x64', trustedKeys: trusted }), /release-target-unavailable/);
  assert.throws(() => verifySignedManifest(manifest, {}), /release-signing-key-untrusted/);
  assert.throws(() => verifySignedManifest({ ...manifest, version: '99.0.0' }, trusted), /release-manifest-signature-invalid/);
  for (const key of ['jsApp', 'webApp', 'contract'] as const) {
    const incomplete = structuredClone(manifest);
    delete incomplete[key];
    assert.throws(() => verifySignedManifest(signed(incomplete), trusted), /release-manifest-invalid/, key);
  }
  for (const mutate of [
    (m: any) => { m.jsApp.name = 'cosyncing-linux-x64'; },
    (m: any) => { m.jsApp.url = 'http://releases.example/app.js'; },
    (m: any) => { m.jsApp.url = 'https://user:secret@releases.example/app.js'; },
    (m: any) => { m.jsApp.provenanceUrl = 'file:///app'; },
    (m: any) => { m.jsApp.size = 0; },
    (m: any) => { m.jsApp.size = 1e12; },
    (m: any) => { m.jsApp.sha256 = 'invalid'; },
    (m: any) => { m.jsApp.minimumBunVersion = 'latest'; },
    (m: any) => { m.jsApp.target = 'linux-x64'; },
    (m: any) => { m.webApp.size = -1; },
    (m: any) => { m.webApp.sha256 = 'invalid'; },
    (m: any) => { m.webApp.url = 'http://releases.example/web.tar.gz'; },
    (m: any) => { m.webApp.mount = '/'; },
    (m: any) => { m.webApp.fileCount = 0; },
    (m: any) => { m.contract.surfaceHash = 'invalid'; },
    (m: any) => { m.contract.minimumClientRevision = m.contract.revision + 1; },
  ]) {
    const malformed = structuredClone(manifest);
    mutate(malformed);
    assert.throws(() => verifySignedManifest(signed(malformed), trusted), /release-manifest-invalid/);
  }
  console.log('PASS  signed native-free manifests require complete valid metadata, trusted keys and valid signatures');

  const staging = join(root, 'staging');
  mkdirSync(staging);
  for (const name of ['cosyncing-app.js', 'cosyncing-web-app.tar.gz']) {
    cpSync(join(options.artifactDirectory, name), join(staging, name));
    cpSync(join(options.evidenceDirectory, `${name}.evidence.json`), join(staging, `${name}.evidence.json`));
  }
  assert.deepEqual(stagingAssetBlockers(staging), []);
  const stagedJs = join(staging, 'cosyncing-app.js');
  rmSync(stagedJs);
  symlinkSync(join(options.artifactDirectory, 'cosyncing-app.js'), stagedJs);
  assert.ok(stagingAssetBlockers(staging).some((message) => message.includes('regular file')));
  rmSync(stagedJs);
  cpSync(join(options.artifactDirectory, 'cosyncing-app.js'), stagedJs);
  for (const extra of ['cosyncing-linux-x64', 'cosyncing-darwin-arm64', 'bun-linux-x64.zip', '.hidden-runtime', 'unexpected.txt']) {
    for (const directory of [staging, options.artifactDirectory, candidate]) {
      const path = join(directory, extra);
      writeFileSync(path, 'unexpected payload');
      try {
        if (directory === staging) assert.ok(stagingAssetBlockers(directory).length > 0);
        else if (directory === candidate) assert.ok(promotionAssetBlockers(directory).length > 0);
        else assert.throws(() => assembleRelease({ ...options, outputDirectory: join(root, 'rejected') }), /asset set mismatch/);
      } finally { rmSync(path); }
    }
  }
  mkdirSync(join(candidate, '.hidden-directory'));
  assert.ok(promotionAssetBlockers(candidate).length > 0);
  rmSync(join(candidate, '.hidden-directory'), { recursive: true });
  console.log('PASS  staging, assembly and promotion reject native brokers, runtime archives and unexpected hidden assets');

  const jsPath = join(options.artifactDirectory, 'cosyncing-app.js');
  const evidencePath = join(options.evidenceDirectory, 'cosyncing-app.js.evidence.json');
  const original = readFileSync(jsPath);
  const evidenceBytes = readFileSync(evidencePath);
  for (const field of ['distribution', 'contract', 'schemaVersions', 'offlineVersionCheck', 'sha256']) {
    const incomplete = JSON.parse(evidenceBytes.toString());
    delete incomplete[field];
    writeFileSync(evidencePath, JSON.stringify(incomplete));
    assert.throws(() => assembleRelease({ ...options, outputDirectory: join(root, `missing-js-${field}`) }), /JavaScript package evidence is invalid/);
  }
  writeFileSync(evidencePath, evidenceBytes);
  // Update evidence and sign the substituted manifest: a trusted digest is not a format check.
  let payloadCase = 0;
  for (const payload of [Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from([0xcf, 0xfa, 0xed, 0xfe]),
    Buffer.from('MZ runtime'), Buffer.from('PK\x03\x04'), Buffer.from('#!/usr/bin/env bash\nexit 0\n'),
    Buffer.from('#!/usr/bin/env bun\n\x00MZ'), Buffer.from('#!/usr/bin/env bun\nconst = ;')]) {
    writeFileSync(join(staging, 'cosyncing-app.js'), payload);
    assert.ok(stagingAssetBlockers(staging).length > 0);
    const evidence = JSON.parse(evidenceBytes.toString());
    evidence.size = payload.length; evidence.sha256 = sha256(payload);
    writeFileSync(jsPath, payload);
    writeFileSync(evidencePath, JSON.stringify(evidence));
    assert.throws(() => assembleRelease({ ...options, outputDirectory: join(root, `rejected-format-${payloadCase++}`) }));
    const altered = join(root, 'altered');
    rmSync(altered, { recursive: true, force: true });
    cpSync(candidate, altered, { recursive: true });
    writeFileSync(join(altered, 'cosyncing-app.js'), payload);
    const substituted = structuredClone(manifest);
    substituted.jsApp!.size = payload.length; substituted.jsApp!.sha256 = evidence.sha256;
    writeFileSync(join(altered, 'release-manifest.json'), JSON.stringify(signed(substituted)));
    assert.ok(promotionAssetBlockers(altered).some((message) => message.includes('signed broker/web pairing is invalid')));
  }
  writeFileSync(jsPath, original);
  writeFileSync(evidencePath, evidenceBytes);
  console.log('PASS  executable headers, archives, shell wrappers and malformed JavaScript cannot masquerade as a signed JS broker');

  for (const asset of ['release-manifest.json.sig', 'release-manifest.json.p256.sig',
    'release-manifest.json.p256.der.sig', 'SHA256SUMS.sig', 'cosyncing-app.js.intoto.jsonl.sig']) {
    const path = join(candidate, asset); const bytes = readFileSync(path);
    writeFileSync(path, Buffer.alloc(bytes.length));
    assert.ok(promotionAssetBlockers(candidate).some((message) => message.includes('invalid signature')));
    writeFileSync(path, bytes);
  }
  const manifestPath = join(candidate, 'release-manifest.json');
  const manifestBytes = readFileSync(manifestPath);
  const mismatch = structuredClone(manifest);
  mismatch.contract!.surfaceHash = 'fnv1a32:00000000';
  writeFileSync(manifestPath, JSON.stringify(signed(mismatch)));
  assert.ok(promotionAssetBlockers(candidate).some((message) => message.includes('provenance disagrees')));
  writeFileSync(manifestPath, manifestBytes);
  const nativeDescriptor = structuredClone(manifest);
  nativeDescriptor.artifacts = [{
    name: 'cosyncing-linux-x64', target: 'linux-x64', platform: 'linux', arch: 'x64',
    size: 100, sha256: '1'.repeat(64), url: `${options.baseUrl}/cosyncing-linux-x64`,
    provenanceUrl: `${options.baseUrl}/cosyncing-linux-x64.intoto.jsonl`,
  }];
  const legacySigned = signed(nativeDescriptor);
  assert.equal(verifyReleaseManifest({ value: legacySigned, target: 'linux-x64', trustedKeys: trusted }).artifact.target, 'linux-x64');
  writeFileSync(manifestPath, JSON.stringify(legacySigned));
  assert.ok(promotionAssetBlockers(candidate).some((message) => message.includes('must not describe native')));
  writeFileSync(manifestPath, manifestBytes);
  assert.deepEqual(promotionAssetBlockers(candidate), []);
  const cli = [process.execPath, 'scripts/broker/release/verify-promotion-assets.ts', candidate];
  assert.equal(Bun.spawnSync([...cli, '--version', options.version, '--commit', options.sourceCommit]).exitCode, 0);
  assert.notEqual(Bun.spawnSync([...cli, '--version', '99.0.0', '--commit', options.sourceCommit]).exitCode, 0);
  console.log('PASS  promotion verifies detached signatures and contract provenance while accepting matching Flutter desktop archives');
}
