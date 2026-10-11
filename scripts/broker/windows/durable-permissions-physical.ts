#!/usr/bin/env bun
/** Native Windows acceptance using a temporary home and the actual packaged CLI. No service is started. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { generateIdentityKeyPair, generateX25519KeyPair } from '../../../packages/typescript/crypto/src/index.ts';
import { TransportPairingRegistry } from '../../../packages/typescript/broker/src/transport/transport-pairing.ts';
import { BUILD_INFO } from '../../../packages/typescript/broker/src/runtime/build-info.ts';
import { defaultBrokerConfig, writeBrokerConfig } from '../../../packages/typescript/broker/src/runtime/configuration.ts';
import { committedInstallState, writeInstallState } from '../../../packages/typescript/broker/src/installation/install-state.ts';
import { writeSetupState } from '../../../packages/typescript/broker/src/installation/setup-state.ts';
import { ensureInstallationCredentials } from '../../../packages/typescript/broker/src/security/credentials.ts';
import { atomicWriteOwnerOnly, ensureOwnerOnlyDirectory, inspectOwnerOnlyFile } from '../../../packages/typescript/broker/src/security/secure-files.ts';
import { isolatedBrokerFixtureEnvironment } from '../../../packages/typescript/broker/test/helpers/isolated-broker-fixture.ts';

assert.equal(process.platform, 'win32', 'physical acceptance requires native Windows');
const reportPath = process.argv[2] ?? process.env.COSYNCING_PERMISSIONS_PHYSICAL_OUTPUT;
assert.ok(reportPath, 'set the physical report path');
const root = mkdtempSync(join(tmpdir(), 'cosyncing-pr6a-physical-'));
const home = join(root, 'state');
const cache = join(root, 'cache');
const binary = join(home, 'bin', 'cosyncing');
const checks: Record<string, boolean> = {};
const mark = (name: string, ok: boolean) => { checks[name] = ok; assert.ok(ok, name); };
try {
  ensureOwnerOnlyDirectory(dirname(binary));
  // A JavaScript candidate, with no bundled runtime and no native-broker release.
  const built = await Bun.build({
    entrypoints: [resolve('packages/typescript/broker/src/cli/cli.ts')], target: 'bun',
    define: {
      COSYNCING_BUILD_DISTRIBUTION: JSON.stringify('bootstrap-js'),
      COSYNCING_BUILD_TARGET: JSON.stringify('universal'),
      COSYNCING_BUILD_VERSION: JSON.stringify(BUILD_INFO.version),
      COSYNCING_BUILD_COMMIT: JSON.stringify('pr6a-physical-candidate'),
      COSYNCING_BUILD_DIRTY: 'true',
    },
  });
  assert.ok(built.success, String(built.logs));
  atomicWriteOwnerOnly(binary, new Uint8Array(await built.outputs[0]!.arrayBuffer()));
  writeBrokerConfig(defaultBrokerConfig(), home);
  writeSetupState({ serviceChoice: 'foreground', language: 'en' }, home);
  ensureInstallationCredentials({ home, internalUrl: 'http://127.0.0.1:1' });
  const state = committedInstallState(new Date().toISOString());
  state.resources.push({ id: 'broker-binary', kind: 'binary', target: binary, ownership: {
    proof: 'package-hash', installedSha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
  } });
  writeInstallState(state, home);
  const env = isolatedBrokerFixtureEnvironment(root, { overrides: {
    COSYNCING_HOME: home, COSYNCING_CACHE_DIR: cache,
    PATH: `${dirname(process.execPath)};${process.env.SystemRoot}\\System32`,
  } });
  const cli = async (...args: string[]) => {
    const child = Bun.spawn([process.execPath, binary, ...args], { env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', windowsHide: true });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    assert.equal(stderr.trim(), '', `CLI stderr: ${stderr}`);
    return { exitCode, value: JSON.parse(stdout) };
  };
  const registry = new TransportPairingRegistry({ home });
  registry.accept(registry.createOffer({ clientLabel: 'PR-6a temporary client' }).pairingId, {
    peerId: 'pr6a-physical-client', peerToken: Buffer.alloc(32, 17).toString('base64url'),
    identityPublicKey: generateIdentityKeyPair().publicKey, exchangePublicKey: generateX25519KeyPair().publicKey,
  });
  const peers = join(home, 'transport-peers.json');
  const pairedBytes = readFileSync(peers, 'utf8');
  const peerCheck = (report: any) => report.sections.flatMap((section: any) => section.checks).find((check: any) => check.id === 'state.schema.peers');
  mark('pairedClientHasProtectedOwnerOnlyPeers', inspectOwnerOnlyFile(peers).status === 'ok');
  mark('actualCliDoctorPeersPassesAfterPairing', peerCheck((await cli('doctor', '--json')).value)?.status === 'pass');
  const inherited = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [peers, '/inheritance:e'], { windowsHide: true, encoding: 'utf8' });
  assert.equal(inherited.status, 0, inherited.stderr);
  mark('deliberatelyInheritedCopyIsDetected', inspectOwnerOnlyFile(peers).daclProblem === 'inherited-access');
  const blocked = await cli('update', '--yes', '--json');
  mark('actualCliUpdateNamesFileReasonAndCommands', blocked.exitCode === 1
    && blocked.value.detailCode === 'upgrade-schema-repair-required'
    && blocked.value.summary.includes('transport-peers.json') && blocked.value.summary.includes('inherited Windows permissions')
    && blocked.value.summary.includes('cosy repair') && blocked.value.summary.includes('cosy update'));
  const beforeDoctor = peerCheck((await cli('doctor', '--json')).value);
  mark('actualCliDoctorUsesSameReason', beforeDoctor.summary === blocked.value.summary);
  const repair = await cli('repair', '--yes', '--json');
  mark('actualCliRepairReportsAndAppliesPermissionAction', repair.exitCode === 0
    && repair.value.actions.includes('state.permissions.peers'));
  mark('repairPreservesPairingContents', readFileSync(peers, 'utf8') === pairedBytes);
  mark('actualCliDoctorPeersPassesAfterRepair', peerCheck((await cli('doctor', '--json')).value)?.status === 'pass');
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, JSON.stringify({ schemaVersion: 1, status: 'pass', checkedAt: new Date().toISOString(),
    platform: process.platform, arch: process.arch, bunVersion: Bun.version,
    mode: 'temporary Windows home; programmatic cryptographic client pairing; actual bootstrap-js doctor, repair and update CLI; no broker service started',
    checks, updateSummary: blocked.value.summary, repairActions: repair.value.actions,
  }, null, 2) + '\n');
  console.log(`PASS native Windows physical acceptance (${Object.keys(checks).length} checks): ${reportPath}`);
} finally { rmSync(root, { recursive: true, force: true }); }
