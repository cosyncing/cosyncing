/** Permission-only regression checks, also run natively on Windows by the lifecycle suite. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { windowsFfi } from '@cosyncing/adapter-api';
import { generateIdentityKeyPair, generateX25519KeyPair } from '@cosyncing/crypto';
import { TransportPairingRegistry } from '../../src/transport/transport-pairing.ts';
import { WakePushRegistry } from '../../src/transport/push-wake.ts';
import { ScheduleStore } from '../../src/scheduling/schedule-store.ts';
import { ProtocolJournal } from '../../src/sessions/protocol-journal.ts';
import { SessionMetadataStore } from '../../src/sessions/session-metadata-store.ts';
import { ArtifactStore } from '../../src/artifacts/artifact-store.ts';
import { inspectRuntimeAssets } from '../../src/runtime/runtime-assets.ts';
import { BUILD_INFO } from '../../src/runtime/build-info.ts';
import { loadOrCreateBrokerInstanceId } from '../../src/runtime/broker-instance.ts';
import { defaultBrokerConfig, writeBrokerConfig } from '../../src/runtime/configuration.ts';
import { committedInstallState, writeInstallState } from '../../src/installation/install-state.ts';
import { writeSetupState } from '../../src/installation/setup-state.ts';
import { createSetupDiagnosisContext } from '../../src/installation/diagnosis-context.ts';
import { collectDoctorReport } from '../../src/installation/doctor.ts';
import { inspectRepair, runRepair } from '../../src/installation/broker-lifecycle.ts';
import { runUpgrade } from '../../src/updates/release-upgrade.ts';
import { atomicWriteOwnerOnly, ensureOwnerOnlyDirectory, inspectOwnerOnlyDirectory, inspectOwnerOnlyFile } from '../../src/security/secure-files.ts';
import { inspectDurableSchemas, durableStateLayout, durableStateProblemSummary } from '../../src/security/durable-state.ts';
import { translateDoctorTextToChinese } from '../../src/cli/cli-i18n.ts';
import { windowsOwnerOnlySddl } from '../../src/security/windows-dacl.ts';
import { writeClaudeModMarketplace, snapshotClaudeModMarketplace, restoreClaudeModMarketplace } from '../../src/installation/claude-mod-ownership.ts';

export async function runDurablePermissionChecks(check: (name: string, ok: boolean, detail?: string) => void): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cosyncing-durable-permissions-'));
  const home = join(root, 'state');
  const cache = join(root, 'cache');
  ensureOwnerOnlyDirectory(home);
  const layout = durableStateLayout({ stateRoot: home, cacheRoot: cache });
  const ffi = windowsFfi();
  const createdDirectories = new Set<string>();
  const createDirectory = ffi?.createDirectory;
  if (ffi) ffi.createDirectory = (path, sddl) => {
    createDirectory!(path, sddl);
    createdDirectories.add(path);
  };
  const weaken = (path: string) => {
    if (ffi) {
      const changed = spawnSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'icacls.exe'), [path, '/inheritance:e'], { windowsHide: true, encoding: 'utf8' });
      assert.equal(changed.status, 0, changed.stderr);
    }
    else chmodSync(path, 0o644);
  };
  const treeSecure = (path: string): boolean => inspectOwnerOnlyDirectory(path).status === 'ok'
    && readdirSync(path, { withFileTypes: true }).every((entry) => entry.isDirectory()
      ? treeSecure(join(path, entry.name)) : inspectOwnerOnlyFile(join(path, entry.name)).status === 'ok');
  try {
    const translatedCases = [
      { status: 'unsafe' as const, permissionProblem: 'inherited-access' as const, permissionRepairable: true, expected: '继承' },
      { status: 'unsafe' as const, permissionProblem: 'wrong-owner' as const, expected: '另一个账户' },
      { status: 'unsafe' as const, permissionProblem: 'symlink' as const, expected: '符号链接' },
      { status: 'unsafe' as const, permissionProblem: 'hard-link' as const, expected: '硬链接' },
      { status: 'unsafe' as const, permissionProblem: 'missing-principal' as const, permissionRepairable: true, expected: '缺少' },
      { status: 'unsafe' as const, permissionProblem: 'unsafe-dacl' as const, contentProblem: 'invalid current-schema content', expected: '内容无效' },
      { status: 'migration-required' as const, expected: '迁移' },
      { status: 'unsupported-version' as const, version: 999, expected: '999 不受支持' },
      { status: 'malformed' as const, expected: '格式错误' },
    ];
    check('Chinese doctor retains durable filenames, the specific cause and recovery commands', translatedCases.every(({ expected, ...inspection }) => {
      const summary = durableStateProblemSummary({ id: 'peers', detailCode: 'peers-fixture', ...inspection });
      const localized = translateDoctorTextToChinese(summary);
      return !!localized?.includes('transport-peers.json') && localized.includes(expected) && localized.includes('cosy ')
        && (!('permissionProblem' in inspection) || inspection.permissionProblem !== 'inherited-access'
          || (summary.includes('instead of owner-only permissions') && !summary.includes('DACL') && !localized.includes('DACL')));
    }));
    writeBrokerConfig(defaultBrokerConfig(), home);
    loadOrCreateBrokerInstanceId(home);
    writeSetupState({ serviceChoice: 'foreground' }, home);
    const binary = join(home, 'bin', 'cosyncing');
    atomicWriteOwnerOnly(binary, 'fixture-binary', { mode: 0o700 });
    const ledger = committedInstallState('2026-10-10T00:00:00.000Z');
    ledger.resources.push({ id: 'broker-binary', kind: 'binary', target: binary,
      ownership: { proof: 'package-hash', installedSha256: createHash('sha256').update('fixture-binary').digest('hex') } });
    writeInstallState(ledger, home);
    const registry = new TransportPairingRegistry({ home });
    const initialOffer = registry.createOffer();
    check('new transport keys are owner-only before any later read can tighten permissions', treeSecure(layout.transportKeys));
    const input = { peerId: 'permissions-client', peerToken: Buffer.alloc(32, 7).toString('base64url'),
      identityPublicKey: generateIdentityKeyPair().publicKey, exchangePublicKey: generateX25519KeyPair().publicKey };
    registry.accept(initialOffer.pairingId, input);
    check('pairing persists protected owner-only peers and transport keys',
      inspectOwnerOnlyFile(layout.peers).status === 'ok' && treeSecure(layout.transportKeys)
      && (!ffi || createdDirectories.has(layout.transportKeys)));
    const keysPath = join(layout.transportKeys, 'cosyncing-keys.json');
    const keysContent = readFileSync(keysPath, 'utf8');
    weaken(keysPath);
    registry.createOffer();
    check('valid legacy transport key permission drift converges without rotating keys', inspectOwnerOnlyFile(keysPath).status === 'ok'
      && readFileSync(keysPath, 'utf8') === keysContent);
    atomicWriteOwnerOnly(keysPath, '{"version":999}'); weaken(keysPath);
    assert.throws(() => registry.createOffer());
    check('malformed legacy keys are refused without tightening their permissions', inspectOwnerOnlyFile(keysPath).status === 'unsafe');
    atomicWriteOwnerOnly(keysPath, keysContent);
    registry.revoke(input.peerId);
    check('peer revocation preserves owner-only peers', inspectOwnerOnlyFile(layout.peers).status === 'ok');
    registry.accept(registry.createOffer().pairingId, input);
    check('re-pairing preserves owner-only peers', inspectOwnerOnlyFile(layout.peers).status === 'ok');

    const context = createSetupDiagnosisContext({ homeDir: root,
      env: { HOME: root, USERPROFILE: root, PATH: '', COSYNCING_HOME: home, COSYNCING_CACHE_DIR: cache } });
    const quietContext = { ...context,
      runReadOnly: async () => ({ status: 'unavailable' as const, stdout: '', stderr: '' }),
      fetchJson: async () => ({ status: 'unreachable' as const }),
      probeTcp: async () => 'closed' as const,
    };
    const options = { home, cacheRoot: cache, buildInfo: BUILD_INFO, executablePath: binary, context: quietContext };
    const doctorPeer = async () => (await collectDoctorReport({ buildInfo: BUILD_INFO, context: quietContext,
      stateHome: home, adapters: [], assetReport: inspectRuntimeAssets() })).sections.flatMap((section) => section.checks).find((item) => item.id === 'state.schema.peers');
    check('doctor peers line passes after actual client pairing', (await doctorPeer())?.status === 'pass');

    // The cache and marketplace audit covers every node, including the index and backup/restore paths.
    const store = new ArtifactStore('http://127.0.0.1:17734', cache);
    if (ffi) check('Windows artifact blob directory is secured at creation', inspectOwnerOnlyDirectory(layout.artifactBlobs).status === 'ok'
      && createdDirectories.has(layout.artifactBlobs));
    store.putBytes({ tool: 'codex', id: 'permissions' }, { type: 'file-artifact', artifactKey: 'permissions',
      path: 'permissions.txt', name: 'permissions.txt', mimeType: 'text/plain', size: 8 }, Buffer.from('artifact'));
    if (ffi) check('Windows artifact directories, blobs and index are owner-only', treeSecure(join(cache, 'artifacts')));
    atomicWriteOwnerOnly(layout.schedules, '{\"version\":1,\"schedules\":[]}');
    new ScheduleStore({ path: layout.schedules });
    check('schedule migration persists an owner-only current store', inspectOwnerOnlyFile(layout.schedules).status === 'ok'
      && JSON.parse(readFileSync(layout.schedules, 'utf8')).version === 2);
    const metadata = new SessionMetadataStore(cache);
    metadata.renameSession('codex', 'permissions', 'Temporary permissions fixture');
    if (ffi) check('Windows session metadata persists owner-only', inspectOwnerOnlyFile(join(cache, 'session-metadata.json')).status === 'ok');
    const wake = new WakePushRegistry(home);
    wake.register({ platform: 'fcm', token: 'fixture', deviceId: 'permissions' }, { kind: 'owner' });
    const journal = new ProtocolJournal({ path: join(home, 'protocol-journal.json') });
    journal.claim({ identity: 'owner', tool: 'codex', sessionId: 'permissions' }, 'message', 'prompt', 'fixture');
    check('wake tokens and protocol journal persist owner-only',
      inspectOwnerOnlyFile(layout.wakeRegistrations).status === 'ok'
      && inspectOwnerOnlyFile(join(home, 'protocol-journal.json')).status === 'ok');
    const marketplace = join(home, 'claude-mod', 'marketplace');
    const backup = join(home, 'backups', 'marketplace');
    writeClaudeModMarketplace(marketplace, BUILD_INFO.version);
    check('Claude mod writes every marketplace node owner-only', treeSecure(marketplace));
    const firstFile = join(marketplace, '.claude-plugin', 'marketplace.json');
    const firstContent = readFileSync(firstFile, 'utf8');
    snapshotClaudeModMarketplace(marketplace, backup);
    check('Claude mod snapshot writes every backup node owner-only', treeSecure(backup));
    writeClaudeModMarketplace(marketplace, '9.9.9');
    restoreClaudeModMarketplace(marketplace, backup, true);
    check('Claude mod forward, snapshot and restore trees are owner-only', treeSecure(marketplace) && treeSecure(backup) && readFileSync(firstFile, 'utf8') === firstContent);

    const original = readFileSync(layout.peers, 'utf8');
    weaken(layout.peers);
    const drift = inspectOwnerOnlyFile(layout.peers);
    check('permission drift retains the precise host permission reason', drift.status === 'unsafe'
      && (ffi ? drift.daclProblem === 'inherited-access' : drift.problem === 'unsafe-mode'));
    const plan = await inspectRepair(options);
    check('repair displays a named permission action for a valid owner-held current store',
      plan.blockers.length === 0 && plan.actions.some((action) => action.id === 'state.permissions.peers'
        && action.summary.includes('transport-peers.json')));
    const before = readFileSync(binary, 'utf8');
    const updateOptions = { ...options, buildInfo: { ...BUILD_INFO, packaged: true, distribution: 'native' as const },
      service: { inspect: async () => ({ active: false }), stop: async () => { throw new Error('must not stop'); }, start: async () => { throw new Error('must not start'); } },
      fetch: (async () => { throw new Error('must not download'); }) as unknown as typeof fetch };
    const upgrade = await runUpgrade(updateOptions);
    check('update names every unsafe store, permission reason and repair command before downloading or stopping',
      upgrade.detailCode === 'upgrade-schema-repair-required' && upgrade.summary.includes('transport-peers.json')
      && upgrade.summary.includes(ffi ? 'inherited Windows permissions' : 'other accounts')
      && upgrade.summary.includes('cosy repair') && upgrade.summary.includes('cosy update')
      && readFileSync(binary, 'utf8') === before);
    atomicWriteOwnerOnly(layout.attention, '{\"version\":999}');
    const instanceContent = readFileSync(layout.brokerInstance, 'utf8');
    atomicWriteOwnerOnly(layout.brokerInstance, JSON.stringify({ ...JSON.parse(instanceContent), version: 999 }));
    const multiple = await runUpgrade(updateOptions);
    check('update reports every blocking store and each specific recovery', multiple.summary.includes('transport-peers.json')
      && multiple.summary.includes('attention-events.json') && multiple.summary.includes('unsupported schema version 999')
      && multiple.summary.includes('`broker-instance.json` has unsupported schema version 999'));
    atomicWriteOwnerOnly(layout.brokerInstance, instanceContent);
    rmSync(layout.attention);
    check('doctor and update use the same actionable peers wording', (await doctorPeer())?.summary === upgrade.summary);
    const cancelled = await runRepair({ ...options, confirmed: false, allowLegacyIntegrations: false, expectedPlan: plan });
    check('permission repair still requires the displayed confirmation', cancelled.exitCode === 2 && inspectOwnerOnlyFile(layout.peers).status === 'unsafe');
    const repaired = await runRepair({ ...options, confirmed: true, allowLegacyIntegrations: false, expectedPlan: plan });
    check('confirmed repair restores permissions without changing peer contents or keys', repaired.exitCode === 0
      && repaired.actions?.includes('state.permissions.peers') === true && readFileSync(layout.peers, 'utf8') === original
      && inspectOwnerOnlyFile(layout.peers).status === 'ok' && (await doctorPeer())?.status === 'pass');

    // Native files can retain these ACL faults; Windows normalizes file inheritance flags away.
    if (ffi) {
      const sid = ffi.currentUserSid();
      const safe = windowsOwnerOnlySddl(sid, 'file');
      for (const [problem, sddl] of [
        ['unexpected-principal', safe + '(A;;FR;;;S-1-5-11)'],
        ['missing-principal', safe.replace('(A;;FA;;;S-1-5-18)', '')],
        ['insufficient-access', safe.replace('(A;;FA;;;S-1-5-18)', '(A;;FR;;;S-1-5-18)')],
      ] as const) {
        ffi.applySecurity(layout.peers, sddl);
        const driftPlan = await inspectRepair(options);
        const result = await runRepair({ ...options, confirmed: true, allowLegacyIntegrations: false, expectedPlan: driftPlan });
        check(`Windows repair handles ${problem} without rewriting content`, result.exitCode === 0
          && driftPlan.actions.some((action) => action.id === 'state.permissions.peers')
          && readFileSync(layout.peers, 'utf8') === original && inspectOwnerOnlyFile(layout.peers).status === 'ok');
      }
      // Exercise the remaining classification with a descriptor seam. Native enforcement still runs
      // and clears the seam only when the product actually applies security to this temporary file.
      const nativeRead = ffi.readSecurity;
      const nativeApply = ffi.applySecurity;
      let unsafeInheritance = true;
      ffi.readSecurity = (path) => {
        const snapshot = nativeRead(path);
        return path === layout.peers && unsafeInheritance ? { ...snapshot,
          aces: snapshot.aces.map((ace) => ace.sid === 'S-1-5-18' ? { ...ace, inheritanceFlags: 1 } : ace),
        } : snapshot;
      };
      ffi.applySecurity = (path, sddl) => { nativeApply(path, sddl); if (path === layout.peers) unsafeInheritance = false; };
      try {
        const driftPlan = await inspectRepair(options);
        const result = await runRepair({ ...options, confirmed: true, allowLegacyIntegrations: false, expectedPlan: driftPlan });
        check('Windows repair handles unsafe-inheritance without rewriting content', result.exitCode === 0
          && driftPlan.actions.some((action) => action.id === 'state.permissions.peers') && !unsafeInheritance
          && readFileSync(layout.peers, 'utf8') === original && inspectOwnerOnlyFile(layout.peers).status === 'ok');
      } finally { ffi.readSecurity = nativeRead; ffi.applySecurity = nativeApply; }
      // Do not require elevated privilege to assign someone else's real SID. Only this temp file's
      // owner read is substituted, and the same snapshot is used by every product inspection.
      const realRead = ffi.readSecurity;
      ffi.readSecurity = (path) => path === layout.peers ? { ...realRead(path), ownerSid: 'S-1-5-18' } : realRead(path);
      try {
        const wrongOwner = await inspectRepair(options);
        check('repair refuses and names a wrong-owner file without changing it', wrongOwner.blockers.some((item) => item.summary.includes('transport-peers.json')
          && item.summary.includes('owned by another account')) && !wrongOwner.actions.some((action) => action.id === 'state.permissions.peers')
          && readFileSync(layout.peers, 'utf8') === original);
      } finally { ffi.readSecurity = realRead; }
      for (const [problem, sddl] of [
        ['deny-access', safe + '(D;;FR;;;S-1-5-11)'],
      ]) {
        ffi.applySecurity(layout.peers, sddl!);
        const blocked = await inspectRepair(options);
        check(`Windows repair refuses ${problem}`, blocked.blockers.some((item) => item.summary.includes('transport-peers.json'))
          && !blocked.actions.some((action) => action.id === 'state.permissions.peers'));
        ffi.applySecurity(layout.peers, safe);
      }
      // Windows coalesces identical grants when applying an ACL. Supply a duplicate descriptor to
      // exercise refusal, while leaving the native temporary file and its contents untouched.
      ffi.readSecurity = (path) => {
        const snapshot = realRead(path);
        return path === layout.peers ? { ...snapshot, aces: [...snapshot.aces, snapshot.aces[0]!] } : snapshot;
      };
      try {
        const blocked = await inspectRepair(options);
        check('Windows repair refuses duplicate-principal', blocked.blockers.some((item) => item.summary.includes('transport-peers.json')
          && item.summary.includes('duplicate Windows permission entries'))
          && !blocked.actions.some((action) => action.id === 'state.permissions.peers') && readFileSync(layout.peers, 'utf8') === original);
      } finally { ffi.readSecurity = realRead; }
    }
    for (const [name, bytes] of [['malformed', '{broken'], ['unknown-version', '{"version":999,"peers":[]}'],
      ['legacy-version', '{"version":1,"peers":[]}'], ['bad-current-content', '{"version":2,"peers":false}']] as const) {
      atomicWriteOwnerOnly(layout.peers, bytes); weaken(layout.peers);
      const blocked = await inspectRepair(options);
      check(`permission repair refuses ${name} content and names its file`, blocked.blockers.some((item) => item.summary.includes('transport-peers.json')
        && item.summary.includes(name === 'unknown-version' ? 'unsupported schema version 999'
          : name === 'legacy-version' ? 'schema migration required' : name === 'malformed' ? 'malformed JSON' : 'invalid current-schema content'))
        && !blocked.actions.some((action) => action.id === 'state.permissions.peers'));
    }
    atomicWriteOwnerOnly(layout.peers, original);
    // A changed owner/content invalidates a confirmed plan, including the narrow permissions-only path.
    weaken(layout.peers);
    const confirmedPlan = await inspectRepair(options);
    atomicWriteOwnerOnly(layout.peers, '{"version":999,"peers":[]}'); weaken(layout.peers);
    const changed = await runRepair({ ...options, confirmed: true, allowLegacyIntegrations: false, expectedPlan: confirmedPlan });
    check('repair rechecks permission-only plans under the installation lock', changed.detailCode === 'repair-plan-changed');
    atomicWriteOwnerOnly(layout.peers, original);
    // Configuration and install ledger drift is repaired before their bytes authorize other actions.
    for (const path of [layout.config, layout.install, layout.brokerInstance]) weaken(path);
    const corePlan = await inspectRepair(options);
    const coreRepair = await runRepair({ ...options, confirmed: true, allowLegacyIntegrations: false, expectedPlan: corePlan });
    check('repair safely handles configuration, install-ledger and broker-identity permission drift', corePlan.blockers.length === 0
      && ['config', 'install', 'broker-instance'].every((id) => corePlan.actions.some((action) => action.id === `state.permissions.${id}`))
      && coreRepair.exitCode === 0 && inspectDurableSchemas(layout).every((store) => store.status === 'ok' || store.status === 'missing'));
    const hardLink = join(home, 'peers-alias.json');
    linkSync(layout.peers, hardLink); weaken(layout.peers);
    const aliased = await inspectRepair(options);
    check('repair refuses a hard-link substitution and names the file', aliased.blockers.some((item) => item.summary.includes('transport-peers.json')
      && item.summary.includes('hard-linked')) && !aliased.actions.some((action) => action.id === 'state.permissions.peers'));
    rmSync(hardLink); atomicWriteOwnerOnly(layout.peers, original);
    // NTFS junctions exercise real link substitution without requiring symlink-creation privilege.
    const real = join(root, ffi ? 'linked-peers-tree' : 'real-peers.json');
    if (ffi) { ensureOwnerOnlyDirectory(real); atomicWriteOwnerOnly(join(real, 'peers.json'), original); }
    else atomicWriteOwnerOnly(real, original);
    rmSync(layout.peers);
    symlinkSync(real, layout.peers, ffi ? 'junction' : undefined);
    const linked = await inspectRepair(options);
    check('repair refuses a link substitution and names the file', linked.blockers.some((item) => item.summary.includes('transport-peers.json')
      && item.summary.includes('link')) && !linked.actions.some((action) => action.id === 'state.permissions.peers'));
  } finally {
    if (ffi && createDirectory) ffi.createDirectory = createDirectory;
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) await runDurablePermissionChecks((name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
  assert.ok(ok, name);
});
