#!/usr/bin/env bun
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  resolveInvocation,
  spawnResolvedInvocation,
  type ResolvedInvocation,
} from '@cosyncing/adapter-api';
import { createSetupDiagnosisContext } from '../../src/installation/diagnosis-context.ts';
import {
  brokerServiceEnvironmentEntries,
  resolveServiceAgentExecutables,
  servicePathEntries,
} from '../../src/installation/service-manager.ts';

function virtualWindowsResolver(files: readonly string[]) {
  const available = new Set(files.map((path) => path.toLowerCase()));
  return {
    isExecutableFile: (path: string) => available.has(path.toLowerCase()),
    canonicalize: (path: string) => path,
  };
}

const windowsFiles = [
  'C:\\Program Files\\Native Tools\\agent.EXE',
  'C:\\Program Files\\Native Tools\\ordered.CMD',
  'C:\\Program Files\\Native Tools\\ordered.EXE',
  'C:\\工具\\bin\\agent.CMD',
  '\\\\server\\share\\agent.BAT',
  'C:\\outside\\custom.COM',
];
const windowsFixture = virtualWindowsResolver(windowsFiles);
const windowsEnv = {
  Path: 'C:\\Program Files\\Native Tools;C:\\工具\\bin',
  pathext: '.CMD;.EXE;.BAT;.COM',
  ComSpec: 'C:\\Windows\\System32\\cmd.exe',
};

const firstByPathExt = resolveInvocation('agent', {
  platform: 'win32',
  env: windowsEnv,
  cwd: 'C:\\work',
  ...windowsFixture,
});
assert.deepEqual(firstByPathExt, {
  kind: 'native',
  executable: 'C:\\Program Files\\Native Tools\\agent.exe',
  prefixArgs: [],
  originalPath: 'C:\\Program Files\\Native Tools\\agent.exe',
});

const batchByPath = resolveInvocation('agent', {
  platform: 'win32',
  env: { ...windowsEnv, Path: 'C:\\工具\\bin;C:\\Program Files\\Native Tools' },
  cwd: 'C:\\work',
  ...windowsFixture,
});
assert.equal(batchByPath?.kind, 'batch');
assert.equal((batchByPath as Extract<ResolvedInvocation, { kind: 'batch' }>).script, 'C:\\工具\\bin\\agent.cmd');
assert.equal(resolveInvocation('ordered', {
  platform: 'win32',
  env: windowsEnv,
  ...windowsFixture,
})?.originalPath, 'C:\\Program Files\\Native Tools\\ordered.cmd', 'PATHEXT order wins within one PATH directory');

const unc = resolveInvocation('\\\\server\\share\\agent.BAT', {
  platform: 'win32',
  env: windowsEnv,
  ...windowsFixture,
});
assert.equal(unc?.kind, 'batch');
assert.equal(unc?.originalPath, '\\\\server\\share\\agent.BAT');

const explicit = resolveInvocation('C:\\outside\\custom.COM', {
  platform: 'win32',
  env: { PATH: '' },
  ...windowsFixture,
});
assert.equal(explicit?.kind, 'batch');
assert.equal(explicit?.originalPath, 'C:\\outside\\custom.COM');

assert.equal(resolveInvocation('agent', {
  platform: 'win32',
  env: { PATH: '' },
  ...windowsFixture,
}), undefined, 'an empty PATH must not implicitly search cwd');
assert.equal(resolveInvocation('agent', {
  platform: 'win32',
  env: { Path: 'C:\\Program Files\\Native Tools', PATHEXT: '' },
  ...windowsFixture,
}), undefined, 'an empty PATHEXT must not invent executable suffixes');
assert.equal(resolveInvocation('C:\\outside\\profile.ps1', {
  platform: 'win32',
  env: windowsEnv,
  ...virtualWindowsResolver(['C:\\outside\\profile.ps1']),
}), undefined, 'unsupported Windows script types must not be treated as native executables');
assert.equal(resolveInvocation('agent\nmalicious', {
  platform: 'win32',
  env: windowsEnv,
  ...windowsFixture,
}), undefined);

const windowsContext = createSetupDiagnosisContext({
  platform: 'win32',
  homeDir: 'C:\\Users\\名字',
  env: windowsEnv,
});
assert.equal(windowsContext.displayPath('C:\\Users\\名字\\state\\receipt.json'), '~/state/receipt.json');
assert.equal(windowsContext.displayPath('C:\\Users\\other\\file'), 'C:\\Users\\other\\file');

const windowsServicePath = servicePathEntries(
  'C:\\Users\\名字',
  'C:\\Users\\名字\\AppData\\Local\\Cosyncing\\bin\\cosyncing.exe',
  ['C:\\Program Files\\Node', 'C:\\Tools\\Agent'],
  'C:\\Users\\名字\\.bun\\bin\\bun.exe',
  'win32',
);
assert.deepEqual(windowsServicePath, [
  'C:\\Program Files\\Node',
  'C:\\Tools\\Agent',
  'C:\\Users\\名字\\AppData\\Local\\Cosyncing\\bin',
  'C:\\Users\\名字\\.bun\\bin',
]);
assert.ok(windowsServicePath.every((entry) => !entry.startsWith('/')));
const windowsServiceEnv = Object.fromEntries(brokerServiceEnvironmentEntries({
  homeDir: 'C:\\Users\\名字',
  stateHome: 'C:\\Users\\名字\\AppData\\Local\\Cosyncing',
  cacheRoot: 'C:\\Users\\名字\\AppData\\Local\\Cosyncing\\cache',
  executablePath: 'C:\\Users\\名字\\AppData\\Local\\Cosyncing\\bin\\cosyncing.exe',
  runtimePath: 'C:\\Users\\名字\\.bun\\bin\\bun.exe',
  agentExecutableDirectories: ['C:\\Program Files\\Node'],
  webDir: 'C:\\Users\\名字\\AppData\\Local\\Cosyncing\\versions\\0.4.1\\web',
  platform: 'win32',
}));
assert.equal(windowsServiceEnv.PATH, [
  'C:\\Program Files\\Node',
  'C:\\Users\\名字\\AppData\\Local\\Cosyncing\\bin',
  'C:\\Users\\名字\\.bun\\bin',
].join(';'));
assert.equal(windowsServiceEnv.COSYNCING_TOKEN_FILE, 'C:\\Users\\名字\\AppData\\Local\\Cosyncing\\secrets\\broker-token');
const windowsOverrides = resolveServiceAgentExecutables({
  platform: 'win32',
  env: { cosyncing_codex_bin: 'C:\\Custom Tools\\codex.cmd', Path: '' },
  resolveExecutable: (command) => command === 'C:\\Custom Tools\\codex.cmd' ? command : undefined,
});
assert.deepEqual(windowsOverrides, [{
  id: 'codex',
  executablePath: 'C:\\Custom Tools\\codex.cmd',
  directory: 'C:\\Custom Tools',
  overrideVariable: 'COSYNCING_CODEX_BIN',
}]);

const root = mkdtempSync(join(tmpdir(), 'cosyncing-invocation-'));
try {
  const executable = join(root, 'echo-argv');
  writeFileSync(executable, '#!/bin/sh\nprintf \'%s\\n\' "$@"\n');
  chmodSync(executable, 0o755);
  const invocation = resolveInvocation(executable, { platform: process.platform });
  assert.equal(invocation?.kind, 'native');
  const args = ['', ' ', 'space value', 'Unicode-雪', '&|<>()^', '%VAR%', '!', 'quote"', 'slash\\'];
  const child = spawnResolvedInvocation(invocation!, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
  const exitCode = await new Promise<number | null>((resolve) => child.once('close', resolve));
  assert.equal(exitCode, 0);
  assert.deepEqual(stdout.trimEnd().split('\n'), args);

  assert.throws(
    () => spawnResolvedInvocation(invocation!, ['bad\rargument']),
    /NUL, CR, or LF/,
  );
} finally {
  rmSync(root, { recursive: true, force: true });
}

console.log('PASS  shared invocation resolution and native argv preservation');
