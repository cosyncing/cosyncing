#!/usr/bin/env bun
/** Record client evidence, or consume it in the broker gate with an explicit fallback. */
import { appendFileSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hostSuiteIds } from '../ci/check-plan.ts';
import { object, requireThat, validateCompleteEvidence } from '../ci/check-evidence.ts';
import { isReleaseRehearsal } from './rehearsal.ts';

const ROOT = resolve(import.meta.dir, '../..');
const OUTPUT = resolve(process.env.COSYNCING_RELEASE_CHECK_EVIDENCE_OUTPUT?.trim() || join(ROOT, 'output/check'));
const DECISION = join(dirname(OUTPUT), 'release-check-decision.json');
const REPOSITORY = 'cosyncing/cosyncing';
const MAX_ARCHIVE_BYTES = 64 << 20;

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

function source(): { commit: string; version: string } {
  const git = (args: string[]): string => {
    const result = Bun.spawnSync(['git', ...args], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    requireThat(result.success, result.stderr.toString());
    return result.stdout.toString().trim();
  };
  const commit = git(['rev-parse', 'HEAD']);
  requireThat(commit === process.env.GITHUB_SHA && git(['status', '--porcelain', '--untracked-files=normal']) === '', 'evidence requires the exact clean workflow commit');
  requireThat(process.env.GITHUB_REPOSITORY === REPOSITORY, 'unexpected evidence repository');
  return { commit, version: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version };
}

function provenance(commit: string): Record<string, unknown> {
  return {
    schemaVersion: 1, repository: REPOSITORY, workflow: process.env.GITHUB_WORKFLOW_REF,
    runId: Number(process.env.GITHUB_RUN_ID), attempt: Number(process.env.GITHUB_RUN_ATTEMPT),
    job: process.env.GITHUB_JOB, tag: process.env.GITHUB_REF_NAME, commit,
    profile: 'linux-release', bun: Bun.version,
    rehearsal: isReleaseRehearsal(),
  };
}

async function api(path: string): Promise<Response> {
  const base = process.env.GITHUB_API_URL ?? 'https://api.github.com';
  requireThat(base === 'https://api.github.com' || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base), 'unsupported GitHub API origin');
  const response = await fetch(`${base}/repos/${REPOSITORY}/${path}`, {
    headers: { Authorization: `Bearer ${process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? ''}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    redirect: 'manual', signal: AbortSignal.timeout(30_000),
  });
  requireThat(response.ok || response.status === 302, `GitHub API ${response.status} for ${path}`);
  return response;
}

async function entries(path: string, field: string): Promise<Record<string, unknown>[]> {
  const result: Record<string, unknown>[] = [];
  for (let page = 1; page <= 100; page++) {
    const response = object(await (await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)).json(), 'GitHub list');
    requireThat(Array.isArray(response[field]), `missing GitHub ${field}`);
    const items = (response[field] as unknown[]).map((item) => object(item, field));
    result.push(...items);
    if (items.length < 100) return result;
  }
  throw new Error('GitHub evidence pagination limit exceeded');
}

function decision(reused: boolean, reason: string, extra: Record<string, unknown> = {}): void {
  mkdirSync(dirname(OUTPUT), { recursive: true });
  const value = { schemaVersion: 1, reused, reason, ...extra };
  writeJson(DECISION, value);
  if (reused) writeJson(join(OUTPUT, 'reuse-receipt.json'), value);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `reused=${reused}\n`);
  const message = `Repository verification: ${reused ? 'reused' : 'full check required'} — ${reason}`;
  const summary = [message];
  if (extra.runId) summary.push(`Producer: [run ${extra.runId}, attempt ${extra.attempt}](https://github.com/${REPOSITORY}/actions/runs/${extra.runId}/attempts/${extra.attempt}).`);
  if (extra.commit) summary.push(`Source commit: \`${extra.commit}\`. Profile: linux-release.`);
  if (extra.counts) {
    const counts = object(extra.counts, 'reused counts');
    summary.push(`Complete discovered coverage: ${counts.pass} passed, ${counts.flaky} flaky, ${counts.fail} failed, ${counts.blocked} blocked. Original attempts and logs are retained.`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.join('\n\n') + '\n');
  console.log(JSON.stringify(value));
}

function archiveJson(archive: string, name: string): unknown {
  const result = Bun.spawnSync(['unzip', '-p', archive, name], {
    cwd: ROOT, stdout: 'pipe', stderr: 'pipe', timeout: 10_000, maxBuffer: 16 << 20,
  });
  requireThat(result.success, `cannot read evidence ${name}`);
  return JSON.parse(result.stdout.toString());
}

async function resolveEvidence(): Promise<void> {
  const { commit, version } = source();
  const tag = `client-v${version}`;
  const rehearsal = isReleaseRehearsal();
  const rehearsalRun = process.env.REHEARSAL_CLIENT_RUN_ID?.trim();
  requireThat(rehearsal || !rehearsalRun, 'a production gate cannot consume a rehearsal run');
  let runs: Record<string, unknown>[];
  if (rehearsal) {
    if (!rehearsalRun) return decision(false, 'no client rehearsal run was supplied');
    requireThat(/^[1-9]\d*$/.test(rehearsalRun), 'invalid client rehearsal run ID');
    runs = [object(await (await api(`actions/runs/${rehearsalRun}`)).json(), 'client rehearsal run')];
  } else {
    requireThat(process.env.GITHUB_REF_NAME === `broker-v${version}`, 'unexpected broker version tag');
    const clientTag = Bun.spawnSync(['git', 'rev-parse', `${tag}^{commit}`], { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    requireThat(clientTag.success && clientTag.stdout.toString().trim() === commit, 'matching client tag is not at the broker commit');
    runs = (await entries(`actions/workflows/client-release.yml/runs?event=push&branch=${encodeURIComponent(tag)}`, 'workflow_runs'))
      .filter((run) => run.head_branch === tag).sort((a, b) => Number(b.id) - Number(a.id));
  }
  if (!runs.length) return decision(false, 'matching client workflow is absent');
  const run = runs[0]!;
  requireThat(!rehearsal || run.id === Number(rehearsalRun), 'producer run differs from the requested rehearsal');
  requireThat(run.head_sha === commit && run.path === '.github/workflows/client-release.yml'
    && run.event === (rehearsal ? 'workflow_dispatch' : 'push') && typeof run.head_branch === 'string'
    && object(run.repository, 'producer repository').full_name === REPOSITORY, 'producer identity differs from release');
  requireThat(run.status === 'completed' && run.conclusion === 'success', 'selected client workflow did not complete successfully');
  const runId = Number(run.id), attempt = Number(run.run_attempt);
  requireThat(Number.isSafeInteger(runId) && Number.isSafeInteger(attempt) && attempt >= 1, 'invalid producer run identity');
  const jobs = await entries(`actions/runs/${runId}/attempts/${attempt}/jobs`, 'jobs');
  const gates = jobs.filter((job) => job.name === 'client release contract gate');
  if (!gates.length && attempt > 1) {
    return decision(false, 'current attempt carried forward a gate without qualifying evidence', {runId, attempt});
  }
  requireThat(gates.length === 1 && gates[0]!.status === 'completed' && gates[0]!.conclusion === 'success', 'producer contract gate did not pass');
  const artifacts = await entries(`actions/runs/${runId}/artifacts`, 'artifacts');
  const matches = artifacts.filter((artifact) => artifact.name === `client-${rehearsal ? 'rehearsal' : 'release'}-check-${runId}-${attempt}`);
  if (!matches.length) return decision(false, 'current-attempt client evidence is absent or legacy', { runId, attempt });
  requireThat(matches.length === 1, 'ambiguous client evidence artifacts');
  const artifact = matches[0]!;
  if (artifact.expired === true) return decision(false, 'client evidence expired', { runId, attempt });
  requireThat(Number.isSafeInteger(artifact.id) && Number(artifact.id) > 0
    && Number.isSafeInteger(artifact.size_in_bytes) && Number(artifact.size_in_bytes) >= 0, 'invalid evidence artifact metadata');
  const associated = object(artifact.workflow_run, 'artifact run');
  requireThat(associated.id === runId && associated.head_sha === commit, 'artifact belongs to a different source');
  if (Number(artifact.size_in_bytes) > MAX_ARCHIVE_BYTES) {
    return decision(false, 'client evidence exceeds the import size limit', {runId, attempt, artifactId: artifact.id});
  }
  const response = await api(`actions/artifacts/${artifact.id}/zip`);
  let archiveResponse = response;
  if (response.status === 302) {
    const location = response.headers.get('location');
    requireThat(location && new URL(location).protocol === 'https:', 'invalid artifact download redirect');
    archiveResponse = await fetch(location, { signal: AbortSignal.timeout(30_000) });
    requireThat(archiveResponse.ok, `artifact download ${archiveResponse.status}`);
  }
  requireThat(archiveResponse.body, 'evidence archive has no body');
  const reader = archiveResponse.body.getReader(), chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const {done, value} = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_ARCHIVE_BYTES) {
      await reader.cancel();
      return decision(false, 'downloaded client evidence exceeds the import size limit', {runId, attempt, artifactId: artifact.id});
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {bytes.set(chunk, offset);offset += chunk.byteLength;}
  mkdirSync(OUTPUT, { recursive: true });
  const archive = join(OUTPUT, 'client-source-artifact.zip');
  writeFileSync(archive, bytes);
  const meta = object(archiveJson(archive, 'provenance.json'), 'evidence provenance');
  requireThat(meta.schemaVersion === 1 && meta.repository === REPOSITORY
    && meta.workflow === `${REPOSITORY}/.github/workflows/client-release.yml@refs/${rehearsal ? 'heads' : 'tags'}/${rehearsal ? run.head_branch : tag}`
    && meta.runId === runId && meta.attempt === attempt && meta.commit === commit
    && meta.tag === (rehearsal ? run.head_branch : tag) && meta.job === 'gate' && meta.profile === 'linux-release'
    && (rehearsal ? meta.rehearsal === true : meta.rehearsal !== true)
    && typeof meta.bun === 'string' && /^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(meta.bun),
  'artifact provenance differs from producer');
  const raw = archiveJson(archive, 'report.json');
  const check = validateCompleteEvidence(raw, { commit, bun: meta.bun as string, platform: 'linux',
    requiredSuites: hostSuiteIds('linux', true), provenance: meta });
  const current = object(await (await api(`actions/runs/${runId}`)).json(), 'current producer');
  requireThat(current.run_attempt === attempt && current.head_sha === commit
    && current.status === 'completed' && current.conclusion === 'success',
  'producer changed while its evidence was being validated');
  if (meta.bun !== Bun.version) {
    return decision(false, 'client evidence uses a different Bun version', {runId, attempt,
      artifactId: artifact.id, producerBun: meta.bun, requiredBun: Bun.version});
  }
  writeJson(join(OUTPUT, 'report.json'), raw);
  writeJson(join(OUTPUT, 'provenance.json'), meta);
  decision(true, `complete client ${rehearsal ? 'rehearsal' : 'release'} check at the same clean commit`, {
    commit, runId, attempt, jobId: gates[0]!.id, artifactId: artifact.id,
    counts: check.counts, rehearsal, consumerRunId: process.env.GITHUB_RUN_ID, consumerAttempt: process.env.GITHUB_RUN_ATTEMPT,
  });
}

if (import.meta.main) {
  try {
    if (process.argv[2] === 'record' && process.argv.length === 3) {
      const reportPath = join(OUTPUT, 'report.json');
      requireThat(existsSync(reportPath), 'check report is absent');
      const report = object(JSON.parse(readFileSync(reportPath, 'utf8')), 'check report');
      // Failure diagnostics are preserved too; this does not mark the report passed.
      writeJson(join(OUTPUT, 'provenance.json'), provenance(String(report.commit)));
      const diagnostics = join(ROOT, 'output/artifact-session-isolation');
      if (existsSync(diagnostics)) cpSync(diagnostics, join(OUTPUT, 'artifact-session-isolation'), {recursive: true});
      if (existsSync(DECISION)) copyFileSync(DECISION, join(OUTPUT, 'reuse-receipt.json'));
      if (report.status === 'pass' && process.env.GITHUB_JOB === 'gate') {
        const {commit} = source();
        validateCompleteEvidence(report, {commit, platform: 'linux', bun: Bun.version,
          requiredSuites: hostSuiteIds('linux', true), provenance: provenance(commit)});
      }
    } else if (process.argv[2] === 'resolve' && process.argv.length === 3) {
      await resolveEvidence();
    } else throw new Error('Usage: client-check-evidence.ts record|resolve');
  } catch (error) {
    console.error(`FAIL release check evidence: ${error instanceof Error ? error.message : error}`);
    process.exitCode = 1;
  }
}
