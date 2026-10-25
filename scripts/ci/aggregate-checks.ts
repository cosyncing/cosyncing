#!/usr/bin/env bun
/** Combine the release's isolated suite reports, keeping every original result. */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { combineChecks, object, requireThat } from './check-evidence.ts';
import { hostSuiteIds } from './check-plan.ts';
import { suites } from './suites.ts';
import { isReleaseRehearsal } from '../release/rehearsal.ts';

const ROOT = resolve(import.meta.dir, '../..');
const input = resolve(process.argv[2] ?? join(ROOT, 'output/client-check-parts'));
const output = resolve(process.env.COSYNCING_RELEASE_CHECK_EVIDENCE_OUTPUT?.trim() || join(ROOT, 'output/check'));
const commit = process.env.GITHUB_SHA ?? '';
mkdirSync(output, {recursive: true});
try {
  requireThat(process.argv.length <= 3 && /^[0-9a-f]{40}$/.test(commit), 'expected input directory and workflow commit');
  requireThat(input !== output && !output.startsWith(input + '/'), 'aggregate output must be outside its inputs');
  const head = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], {cwd: ROOT, stdout: 'pipe', stderr: 'pipe'});
  const status = Bun.spawnSync(['git', 'status', '--porcelain', '--untracked-files=normal'], {cwd: ROOT, stdout: 'pipe', stderr: 'pipe'});
  requireThat(head.success && head.stdout.toString().trim() === commit && status.success
    && status.stdout.toString().trim() === '', 'aggregation requires the exact clean workflow checkout');
  type Part = {artifact: string; attempt: number; suite: string; shard: string | null};
  const selected = new Map<string, Part>();
  const superseded: unknown[] = [];
  const retainSuperseded = (part: Part): void => {
    // Old cancelled attempts can contain only logs. Their contents are diagnostic
    // data and must not become a prerequisite for accepting a newer attempt.
    const path = join(input, part.artifact, 'report.json');
    let report: unknown;
    try {
      if (lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()) report = JSON.parse(readFileSync(path, 'utf8'));
    } catch { /* The original directory is retained under parts/. */ }
    superseded.push({...part, ...(report === undefined ? {reportUnavailable: true} : {report})});
  };
  for (const name of readdirSync(input).sort()) {
    const directory = join(input, name);
    requireThat(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(), 'unexpected contributor path');
    const match = /^client-check-part-(\d+)-(\d+)-(.+)$/.exec(name);
    requireThat(match && match[1] === process.env.GITHUB_RUN_ID, 'unexpected contributor workflow run');
    const attempt = Number(match[2]);
    requireThat(Number.isSafeInteger(attempt) && attempt >= 1 && String(attempt) === match[2]
      && attempt <= Number(process.env.GITHUB_RUN_ATTEMPT), 'invalid contributor attempt');
    const partition = match[3]!;
    const suite = suites.find(({id}) => partition === id || partition.startsWith(id + '-')
      && /^\d+-\d+$/.test(partition.slice(id.length + 1)))?.id;
    requireThat(suite, 'unknown contributor suite/partition');
    const shardParts = partition === suite ? null : partition.slice(suite.length + 1).split('-').map(Number);
    requireThat(!shardParts || shardParts[0]! >= 1 && shardParts[1]! <= 32 && shardParts[0]! <= shardParts[1]!, 'invalid contributor shard');
    const shard = shardParts ? `${shardParts[0]}/${shardParts[1]}` : null;
    requireThat(partition === `${suite}${shard ? '-' + shard.replace('/', '-') : ''}`, 'noncanonical contributor partition');
    const key = JSON.stringify([suite, shard]);
    const previous = selected.get(key);
    const candidate: Part = {artifact: name, attempt, suite, shard};
    requireThat(!previous || previous.attempt !== attempt, 'duplicate contributor attempt');
    if (!previous || previous.attempt < attempt) {
      if (previous) retainSuperseded(previous);
      selected.set(key, candidate);
    } else retainSuperseded(candidate);
  }
  cpSync(input, join(output, 'parts'), {recursive: true, dereference: false});
  const contributors = [...selected.values()].map(part => {
    const report = join(input, part.artifact, 'report.json'), meta = join(input, part.artifact, 'provenance.json');
    requireThat(existsSync(report) && existsSync(meta) && lstatSync(report).isFile() && lstatSync(meta).isFile()
      && !lstatSync(report).isSymbolicLink() && !lstatSync(meta).isSymbolicLink(), 'newest contributor is missing report/provenance');
    const result = object(JSON.parse(readFileSync(report, 'utf8')), 'contributor report');
    const provenance = object(JSON.parse(readFileSync(meta, 'utf8')), 'contributor provenance');
    const selection = object(result.selection, 'contributor selection');
    requireThat(provenance.runId === Number(process.env.GITHUB_RUN_ID) && provenance.attempt === part.attempt
      && JSON.stringify(selection.suites) === JSON.stringify([part.suite]) && selection.shard === part.shard,
    'contributor artifact name differs from its provenance/selection');
    return {artifact: part.artifact, report: result, provenance};
  });
  const aggregate = combineChecks(contributors, {
    commit, platform: 'linux', bun: Bun.version, requiredSuites: hostSuiteIds('linux', true),
    provenance: {repository: process.env.GITHUB_REPOSITORY, workflow: process.env.GITHUB_WORKFLOW_REF,
      runId: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
      commit, profile: 'linux-release', bun: Bun.version},
  });
  aggregate.superseded = superseded;
  aggregate.rehearsal = isReleaseRehearsal();
  writeFileSync(join(output, 'report.json'), JSON.stringify(aggregate, null, 2) + '\n');
  const counts = object(aggregate.counts, 'aggregate counts');
  const summary = `Complete release verification: ${counts.pass} passed, ${counts.flaky} flaky, ${contributors.length} isolated reports.\n`;
  writeFileSync(join(output, 'report.md'), summary);
  if (process.env.GITHUB_STEP_SUMMARY) {
    const {appendFileSync} = await import('node:fs');
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
  }
  console.log(summary.trim());
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  writeFileSync(join(output, 'report.json'), JSON.stringify({schemaVersion: 1, kind: 'repository-check-aggregate',
    status: 'fail', commit, dirty: false, reason}, null, 2) + '\n');
  console.error(`FAIL aggregate verification: ${reason}`);
  process.exitCode = 1;
}
