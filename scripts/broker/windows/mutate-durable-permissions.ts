#!/usr/bin/env bun
/** Sequential mutations on this checkout; always restore before running the next one. Never run with a gate. */
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const broker = 'packages/typescript/broker/src/';
interface Mutation { name: string; file: string; changes: Array<[string, string]>; windows?: boolean; suite?: string }
const plain = (file: string, name: string, from: string, to: string): Mutation => ({ name, file: broker + file, changes: [[from, to]], windows: true });
const mutations: Mutation[] = [
  { name: 'M1-peers-save-plain-write', file: broker + 'transport/transport-pairing.ts',
    suite: process.platform === 'win32' ? undefined : 'packages/typescript/broker/test/broker/test-pairing.ts',
    changes: [
      ["import { existsSync, readFileSync } from 'node:fs';", "import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';"],
      ["import { join } from 'node:path';", "import { join, dirname } from 'node:path';"],
      ["    atomicWriteOwnerOnly(this.path, JSON.stringify({ version: 2, peers: [...peers.values()] } satisfies PairingStoreFile, null, 2) + '\\n');",
       "    mkdirSync(dirname(this.path), { recursive: true }); const tmp = `${this.path}.tmp`; writeFileSync(tmp, JSON.stringify({ version: 2, peers: [...peers.values()] }) + '\\n', { mode: 0o600 }); renameSync(tmp, this.path);"],
    ] },
  { name: 'M2-drop-permission-plan-action', file: broker + 'installation/broker-lifecycle.ts',
    changes: [['    if (inspection.permissionRepairable) {', '    if (false) {']] },
  { name: 'M3-allow-wrong-owner', file: broker + 'security/windows-dacl.ts', windows: true,
    changes: [["  const ownedByUs = snapshot.ownerSid === snapshot.currentUserSid\n    || (snapshot.tokenOwnerSid !== undefined && snapshot.ownerSid === snapshot.tokenOwnerSid);", '  const ownedByUs = true;']] },
  { name: 'M4-drop-update-store-name', file: broker + 'updates/release-upgrade.ts',
    changes: [["schemaProblems.map(durableStateProblemSummary).join(' ')", "'Run `cosy repair`, then `cosy update`.'"]] },
  { name: 'M5-drop-doctor-reason', file: broker + 'installation/doctor.ts',
    changes: [['summary: durableStateProblemSummary(inspection),', 'summary: `${inspection.id} state requires repair or migration.`,']] },
  { name: 'M6-drop-repair-enforcement', file: broker + 'security/durable-state.ts',
    changes: [["    enforceOwnerOnlyFile(repair.path);", "    // mutant: no enforcement"]] },
  { name: 'M7-allow-unknown-and-legacy-schema-permission-repair', file: broker + 'security/durable-state.ts',
    changes: [["  if (options.currentVersionOnly && inspection.status !== 'ok') return 'blocked';", ''],
      ["  return inspection.status === 'ok' || (!options.currentVersionOnly && isRuntimeSecurityMigrationV1(inspection))\n    ? 'tightenable' : 'blocked';", "  return 'tightenable';"]] },
  { name: 'M8-allow-malformed-json-permission-repair', file: broker + 'security/durable-state.ts',
    changes: [["  if (options.currentVersionOnly && inspection.status !== 'ok') return 'blocked';", ''],
      ["  } catch { return 'blocked'; }", "  } catch { return 'tightenable'; }"]] },
  { name: 'M9-skip-current-schema-array-validation', file: broker + 'security/durable-state.ts',
    changes: [["    if (arrayField && !Array.isArray(parsed[arrayField])) return 'blocked';", '']] },
  { name: 'M10-drop-permission-plan-lock-recheck', file: broker + 'installation/broker-lifecycle.ts',
    changes: [["      if (!samePlan(plan, await inspectRepair(options))) return commandResult('blocked', 1, 'repair-plan-changed', 'Repair state changed after confirmation; inspect and confirm the new plan.');", '']] },
  { name: 'M11-drop-repair-confirmation', file: broker + 'installation/broker-lifecycle.ts',
    changes: [["  if (!options.confirmed) return commandResult('cancelled', 2, 'repair-confirmation-required', 'Repair requires confirmation after displaying the mutation plan.');", '']] },
  { name: 'M12-permission-repair-rewrites-peer-content', file: broker + 'security/durable-state.ts',
    changes: [["    enforceOwnerOnlyFile(repair.path);", "    enforceOwnerOnlyFile(repair.path); if (repair.id === 'peers') atomicWriteJsonOwnerOnly(repair.path, { version: 2, peers: [] });"]] },
  { name: 'M13-follow-leaf-link', file: broker + 'security/secure-files.ts',
    changes: [['    const stat = lstatIfPresent(target);', '    const stat = existsSync(target) ? statSync(target) : undefined;']] },
  { name: 'M14-allow-unlisted-DACL-problems', file: broker + 'security/durable-state.ts', windows: true,
    changes: [["  ].includes(file.daclProblem ?? '')) return 'blocked';", "  ].includes(file.daclProblem ?? '') && false) return 'blocked';"]] },
  plain('artifacts/artifact-store.ts', 'M15-artifact-directory-plain-mkdir',
    "    if (process.platform === 'win32') ensureOwnerOnlyDirectory(this.blobDir);", "    if (false) ensureOwnerOnlyDirectory(this.blobDir);"),
  plain('artifacts/artifact-store.ts', 'M16-artifact-blob-plain-write',
    "      if (process.platform === 'win32') atomicWriteOwnerOnly(filePath, bytes);", "      if (false) atomicWriteOwnerOnly(filePath, bytes);"),
  plain('artifacts/artifact-store.ts', 'M17-artifact-index-plain-write',
    "      if (process.platform === 'win32') {\n        atomicWriteOwnerOnly(this.indexFile, serialized);", "      if (false) {\n        atomicWriteOwnerOnly(this.indexFile, serialized);"),
  { name: 'M18-transport-key-plain-write', file: broker + 'transport/transport-pairing.ts', windows: true,
    changes: [["import { existsSync, readFileSync } from 'node:fs';", "import { existsSync, readFileSync, writeFileSync } from 'node:fs';"],
      ['      write: atomicWriteOwnerOnly,', '      write: (path, content) => writeFileSync(path, content, { mode: 0o600 }),']] },
  { name: 'M19-transport-key-directory-plain-mkdir', file: broker + 'transport/transport-pairing.ts', windows: true,
    changes: [["import { existsSync, readFileSync } from 'node:fs';", "import { existsSync, readFileSync, mkdirSync } from 'node:fs';"],
      ['      ensureDirectory: ensureOwnerOnlyDirectory,', '      ensureDirectory: (path) => mkdirSync(path, { recursive: true }),']] },
  { name: 'M20-schedule-plain-write', file: broker + 'scheduling/schedule-store.ts', windows: true,
    changes: [["import { readFileSync, renameSync } from 'node:fs';", "import { readFileSync, renameSync, writeFileSync } from 'node:fs';"],
      ['      atomicWriteOwnerOnly(this.file, JSON.stringify(this.state, null, 2));', "      writeFileSync(this.file + '.tmp', JSON.stringify(this.state, null, 2), { mode: 0o600 }); renameSync(this.file + '.tmp', this.file);"]] },
  { name: 'M21-wake-tokens-plain-write', file: broker + 'transport/push-wake.ts', windows: true,
    changes: [["import { existsSync, readFileSync } from 'node:fs';", "import { existsSync, readFileSync, writeFileSync } from 'node:fs';"],
      ["    atomicWriteOwnerOnly(this.path, JSON.stringify({ version: 2, registrations: [...this.registrations.values()] } satisfies WakeStoreFile, null, 2) + '\\n');", "    writeFileSync(this.path, JSON.stringify({ version: 2, registrations: [...this.registrations.values()] }), { mode: 0o600 });"]] },
  { name: 'M22-protocol-journal-plain-write', file: broker + 'sessions/protocol-journal.ts', windows: true,
    changes: [["import { existsSync, readFileSync, renameSync } from 'node:fs';", "import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';"],
      ["    atomicWriteOwnerOnly(this.path, `${JSON.stringify(file, null, 2)}\\n`);", "    writeFileSync(this.path, JSON.stringify(file), { mode: 0o600 });"]] },
  { name: 'M23-Claude-marketplace-plain-write', file: broker + 'installation/claude-mod-ownership.ts', windows: true,
    changes: [["import {\n  existsSync,", "import {\n  writeFileSync,\n  mkdirSync,\n  existsSync,"],
      ['      atomicWriteOwnerOnly(target, file.content);', '      mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); writeFileSync(target, file.content, { mode: 0o600 });']] },
  { name: 'M24-Claude-snapshot-plain-write', file: broker + 'installation/claude-mod-ownership.ts', windows: true,
    changes: [["import {\n  existsSync,", "import {\n  writeFileSync,\n  existsSync,"],
      ['    atomicWriteOwnerOnly(to, readFileSync(from), { mode: stat.mode & 0o700 });', '    writeFileSync(to, readFileSync(from), { mode: stat.mode & 0o700 });']] },
  { name: 'M25-Claude-restore-noop', file: broker + 'installation/claude-mod-ownership.ts', windows: true,
    changes: [["  if (!existsSync(backupDir)) throw new Error('claude-mod-backup-missing');", "  return; // mutant: skip restoring the snapshot\n  if (!existsSync(backupDir)) throw new Error('claude-mod-backup-missing');"]] },
  { name: 'M26-block-core-permission-drift', file: broker + 'installation/broker-lifecycle.ts',
    changes: [["  if (!env.install.committed || !env.config) {\n    if (!env.install.committed", "  if (!env.install.committed || !env.config) { blockers.push({ detailCode: 'mutant-core', summary: 'cannot repair' });\n    if (!env.install.committed"]] },
  { name: 'M27-report-only-first-update-blocker', file: broker + 'updates/release-upgrade.ts',
    changes: [["schemaProblems.map(durableStateProblemSummary).join(' ')", "schemaProblems.slice(0, 1).map(durableStateProblemSummary).join(' ')"]] },
  plain('sessions/session-metadata-store.ts', 'M28-session-metadata-plain-write',
    "    if (process.platform === 'win32') {", "    if (false) {"),
  { name: 'M29-skip-valid-legacy-key-permission-convergence', file: broker + 'transport/transport-pairing.ts',
    changes: [['      secureExisting: enforceOwnerOnlyFile,', '      secureExisting: () => undefined,']] },
  { name: 'M30-allow-hard-link-permission-repair', file: broker + 'security/durable-state.ts',
    changes: [["      && lstatSync(repair.path).nlink !== 1) return 'blocked';", "      && false) return 'blocked';"]] },
  { name: 'M31-tighten-legacy-keys-before-content-validation', file: 'packages/typescript/crypto/src/key-store.ts',
    changes: [["    const store = validateLocalKeyStore(JSON.parse(storage ? storage.read(path) : readFileSync(path, 'utf8')));\n    storage?.secureExisting?.(path);", "    storage?.secureExisting?.(path);\n    const store = validateLocalKeyStore(JSON.parse(storage ? storage.read(path) : readFileSync(path, 'utf8')));"]] },
  { name: 'M32-drop-durable-doctor-Chinese-catalog', file: broker + 'cli/cli-i18n.ts',
    changes: [['  const durable = translateDurableDoctorText(source);', '  const durable = undefined;']] },
  { name: 'M33-hide-broker-instance-unsupported-version', file: broker + 'security/durable-state.ts',
    changes: [["        if (content.status === 'unsupported-version') return content;", '']] },
];
// Select affected mutations for a follow-up round; unset means run the complete inventory.
const requested = process.env.COSYNCING_PERMISSIONS_MUTATIONS?.split(',').map((id) => id.trim());
assert.ok(!requested || requested.every((id) => mutations.some((mutation) => mutation.name.split('-')[0] === id)),
  'COSYNCING_PERMISSIONS_MUTATIONS must name known mutation IDs, separated by commas');
const selected = requested ? mutations.filter((mutation) => requested.includes(mutation.name.split('-')[0]!)) : mutations;
const output = resolve(process.env.COSYNCING_PERMISSIONS_MUTATION_OUTPUT ?? 'output/windows-permissions/mutations.json');
mkdirSync(dirname(output), { recursive: true });
const results: Array<{ name: string; result: string; exitCode?: number; failure?: string }> = [];
const helper = 'packages/typescript/broker/test/helpers/durable-permission-checks.ts';
const baseline = Bun.spawn([process.execPath, 'run', helper], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', windowsHide: true });
const [baselineOut, baselineErr, baselineCode] = await Promise.all([
  new Response(baseline.stdout).text(), new Response(baseline.stderr).text(), baseline.exited,
]);
assert.equal(baselineCode, 0, `unmutated baseline failed: ${baselineOut}\n${baselineErr}`);
for (const mutation of selected) {
  if (mutation.windows && process.platform !== 'win32') { results.push({ name: mutation.name, result: 'native-windows-only' }); continue; }
  const original = readFileSync(mutation.file, 'utf8');
  let edited = original;
  for (const [from, to] of mutation.changes) {
    assert.ok(edited.includes(from), `${mutation.name}: source selector no longer matches`);
    edited = edited.replaceAll(from, to);
  }
  try {
    writeFileSync(mutation.file, edited);
    const child = Bun.spawn([process.execPath, 'run', mutation.suite ?? helper], { stdout: 'pipe', stderr: 'pipe', stdin: 'ignore', windowsHide: true });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    // A compilation failure does not count as a killed mutation.
    assert.ok(!/SyntaxError|ParseError|Cannot find module|Export named/.test(stderr), `${mutation.name}: invalid mutant: ${stderr}`);
    const failure = [...stdout.split(/\r?\n/), ...stderr.split(/\r?\n/)].find((line) => /FAIL |AssertionError|error:/.test(line));
    const result = exitCode === 0 ? 'SURVIVED' : 'KILLED';
    results.push({ name: mutation.name, result, exitCode, failure });
    console.log(`${result} ${mutation.name}${failure ? ` — ${failure}` : ''}`);
  } finally { writeFileSync(mutation.file, original); }
  writeFileSync(output, JSON.stringify({ platform: process.platform, bunVersion: Bun.version, results }, null, 2) + '\n');
}
assert.ok(results.every((result) => result.result !== 'SURVIVED'), 'every regression mutation must be killed');
console.log(`PASS durable permission mutations: ${results.filter((r) => r.result === 'KILLED').length} killed`);
