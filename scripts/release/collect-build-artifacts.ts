#!/usr/bin/env bun
/** Select current-run staging inputs, including successful jobs carried through a rerun. */
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { requireThat } from '../ci/check-evidence.ts';
import { isReleaseRehearsal } from './rehearsal.ts';

const [kind, inputArgument, outputArgument] = process.argv.slice(2);
const clientInventories = {
  linux: ['cosyncing-client-VERSION-linux-x64.tar.gz'],
  macos: ['cosyncing-client-VERSION-macos-arm64-unsigned.dmg', 'cosyncing-client-VERSION-macos-arm64-unsigned.zip'],
  windows: ['cosyncing-client-VERSION-windows-x64-unsigned.zip'],
  android: ['cosyncing-client-VERSION-android.apk'],
};
const inventories: Record<string, string[]> | undefined = kind === 'client' ? clientInventories
  : kind === 'client-verified' ? {complete: Object.values(clientInventories).flat()}
  : kind === 'broker' ? {
  javascript: ['cosyncing-app.js', 'cosyncing-app.js.evidence.json'],
  web: ['cosyncing-web-app.tar.gz', 'cosyncing-web-app.tar.gz.evidence.json'],
} : undefined;
try {
  requireThat(inventories && inputArgument && outputArgument && process.argv.length === 5, 'expected client|client-verified|broker INPUT OUTPUT');
  const runId = process.env.GITHUB_RUN_ID, attempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  const rehearsal = isReleaseRehearsal();
  const releaseKind = kind === 'broker' ? 'broker' : 'client';
  const version: string | undefined = rehearsal
    ? JSON.parse(readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8')).version
    : new RegExp(`^${releaseKind}-v(\\d+\\.\\d+\\.\\d+)$`).exec(process.env.GITHUB_REF_NAME ?? '')?.[1];
  requireThat(runId && /^\d+$/.test(runId) && Number.isSafeInteger(attempt) && attempt >= 1
    && version && /^\d+\.\d+\.\d+$/.test(version), 'invalid staging workflow identity');
  if (rehearsal) console.log('NO-PUBLISH REHEARSAL: staging inputs are not production release assets');
  const prefix = kind === 'broker' ? `broker-${rehearsal ? 'rehearsal-' : ''}package`
    : kind === 'client-verified' ? `client-${rehearsal ? 'rehearsal-' : ''}verified`
    : `client-${rehearsal ? 'rehearsal-' : ''}build`;
  const input = resolve(inputArgument), output = resolve(outputArgument);
  requireThat(input !== output && !input.startsWith(output + '/'), 'staging output must be separate from inputs');
  const selected = new Map<string, {attempt: number; path: string}>();
  for (const name of readdirSync(input)) {
    const match = new RegExp(`^${prefix}-${runId}-(\\d+)-([a-z]+)$`).exec(name);
    requireThat(match, `unexpected staging artifact ${name}`);
    const producerAttempt = Number(match[1]), target = match[2]!;
    requireThat(producerAttempt >= 1 && producerAttempt <= attempt && Object.hasOwn(inventories, target), 'unexpected staging target/attempt');
    const directory = join(input, name);
    requireThat(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), 'unsafe staging directory');
    const expected = inventories[target]!.map((file) => file.replace('VERSION', version));
    const actual = readdirSync(directory).sort();
    requireThat(JSON.stringify(actual) === JSON.stringify([...expected].sort()), 'staging inventory differs from expected target');
    for (const file of actual) requireThat(lstatSync(join(directory, file)).isFile() && !lstatSync(join(directory, file)).isSymbolicLink(), 'unsafe staging file');
    const previous = selected.get(target);
    if (!previous || previous.attempt < producerAttempt) selected.set(target, {attempt: producerAttempt, path: directory});
  }
  requireThat(selected.size === Object.keys(inventories).length, 'missing staging build artifacts');
  mkdirSync(output, {recursive: true});
  requireThat(readdirSync(output).length === 0, 'staging output must be empty');
  for (const [target, producer] of selected) {
    for (const file of readdirSync(producer.path)) copyFileSync(join(producer.path, file), join(output, file));
    console.log(`${target}: workflow ${runId}, attempt ${producer.attempt}`);
  }
} catch (error) {
  console.error(`FAIL staging inputs: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
}
