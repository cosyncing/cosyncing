#!/usr/bin/env bun
import {
  existsSync,
  copyFileSync,
  cpSync,
  chmodSync,
  readFileSync,
  statSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { hostSuiteIds, planChecks, type CheckSelection } from '../../ci/check-plan.ts';

const ROOT = resolve(import.meta.dir, '../../..');
const fixture = mkdtempSync(join(tmpdir(), 'cosyncing-release-checkpoint-lifecycle-'));
const fixtureEnv = {...process.env, RELEASE_REHEARSAL: 'false', REHEARSAL_CLIENT_RUN_ID: '', GITHUB_EVENT_NAME: 'push', GITHUB_REF_TYPE: 'tag'};
let checks = 0;

function check(condition: unknown, message: string): void {
  checks += 1;
  if (!condition) throw new Error(message);
}

try {
  const output = join(fixture, 'release-checkpoint');
  const checkReport = join(fixture, 'partial-check.json');
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, 'report.json'),
    `${JSON.stringify({
      schemaVersion: 1,
      kind: 'release-checkpoint',
      status: 'pass',
      publicationEligible: true,
    })}\n`,
  );
  writeFileSync(join(output, 'cosyncing-app.js'), 'stale publishable artifact\n');
  writeFileSync(
    checkReport,
    `${JSON.stringify({
      status: 'pass',
      commit: '0'.repeat(40),
      dirty: false,
      selection: { complete: false },
    })}\n`,
  );

  const rejected = Bun.spawnSync(
    ['bun', 'run', 'scripts/release/verify-release-checkpoint.ts'],
    {
      cwd: ROOT,
      env: {
        ...fixtureEnv,
        COSYNCING_RELEASE_CHECKPOINT_OUTPUT: output,
        COSYNCING_RELEASE_CHECKPOINT_CHECK_REPORT: checkReport,
      },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 20_000,
      killSignal: 'SIGKILL',
    },
  );
  check(
    rejected.exitCode === 1
      && rejected.stderr.toString().includes('absent, partial, failed'),
    'partial check evidence must reject the checkpoint before any build',
  );
  check(
    !existsSync(output),
    'rejection must invalidate the old eligible report and binary',
  );
  check(
    readdirSync(fixture).every((name) => !name.startsWith('.release-checkpoint-')),
    'rejection must leave no staging checkpoint behind',
  );
  await exerciseClientEvidence();
  await exerciseAggregateEvidence();
  exerciseAggregateCheckpoint();
  await exerciseClientEvidence(true);
  await exerciseStagingInputs();
  exerciseBlockedEvidence();
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

console.log(`PASS ${checks}/${checks} release-checkpoint lifecycle checks`);

// Release-control cases cross the CLI and REST boundary; product flows cannot
// produce forged/expired workflow artifacts or a misleading passing report.
async function exerciseClientEvidence(aggregate = false): Promise<void> {
  const commit = 'f'.repeat(40);
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const tag = `client-v${version}`;
  const bin = join(fixture, 'bin');
  mkdirSync(bin, {recursive: true});
  writeFileSync(join(bin, 'git'), `#!/usr/bin/env bun
if (process.argv[2] === 'rev-parse') console.log('${commit}');
else if (process.argv[2] !== 'status') process.exit(1);
`);
  chmodSync(join(bin, 'git'), 0o755);
  const selection = { suites: hostSuiteIds('linux', true), repeat: 1, flutterLayout: 'serial-shards' as const };
  const tasks = planChecks(selection, 'linux', false).tasks.map(({suite, task}) => ({
    suite: suite.id, id: task.id, command: task.run, iteration: 1, status: 'pass',
    attempts: [{exitCode: 0, durationMs: 1, timedOut: false, strays: false, summary: '', log: 'fixture.log', ledger: 'fixture.ledger'}],
  }));
  const report = {
    schemaVersion: 7, kind: 'repository-check', commit, dirty: false, status: 'pass',
    host: {platform: 'linux', arch: 'x64', bun: Bun.version},
    selection: {...selection, shard: null, only: null, complete: true},
    counts: {pass: tasks.length, flaky: 0, fail: 0, blocked: 0}, tasks,
  };
  const meta = {schemaVersion: 1, repository: 'cosyncing/cosyncing',
    workflow: `cosyncing/cosyncing/.github/workflows/client-release.yml@refs/tags/${tag}`,
    runId: 201, attempt: 1, job: 'gate', tag, commit, profile: 'linux-release', bun: Bun.version};
  const archive = join(fixture, 'evidence.zip');
  let mode = '';
  const rehearsalBranch = 'agent/rehearsal';
  const producesRehearsal = () => ['valid-rehearsal','production-rehearsal-source'].includes(mode);
  const server = Bun.serve({hostname: '127.0.0.1', port: 0, fetch(request) {
    const url = new URL(request.url);
    if (mode === 'api-failure') return new Response('denied', {status: 403});
    if (url.pathname.endsWith('/client-release.yml/runs')) return Response.json({workflow_runs: mode === 'missing-run' ? [] : [{
      id: 201, run_attempt: ['rerun','carried-gate'].includes(mode) ? 2 : 1,
      head_branch: producesRehearsal() && mode !== 'production-rehearsal-source' ? rehearsalBranch : tag, head_sha: commit,
      path: '.github/workflows/client-release.yml', event: producesRehearsal() ? 'workflow_dispatch' : 'push', repository: {full_name: 'cosyncing/cosyncing'},
      status: 'completed', conclusion: mode === 'failed-run' ? 'failure' : 'success',
    }]});
    if (url.pathname.endsWith('/jobs')) return Response.json({jobs: mode === 'carried-gate' ? [] : [{
      id: 301, name: 'client release contract gate', status: 'completed', conclusion: mode === 'failed-gate' ? 'failure' : 'success',
    }]});
    if (url.pathname.endsWith('/artifacts')) return Response.json({artifacts: mode === 'missing-artifact' ? [] : [{
      id: 401, name: `client-${producesRehearsal() ? 'rehearsal' : 'release'}-check-201-1`, expired: mode === 'expired',
      size_in_bytes: mode.startsWith('oversized') ? 65 << 20 : statSync(archive).size,
      workflow_run: {id: 201, head_sha: mode === 'oversized-wrong-source' ? 'a'.repeat(40) : commit},
    }]});
    if (url.pathname.endsWith('/runs/201')) return Response.json({id: 201, run_attempt: mode === 'changed-attempt' ? 2 : 1,
      head_sha: commit, head_branch: producesRehearsal() ? rehearsalBranch : tag,
      path: '.github/workflows/client-release.yml', event: producesRehearsal() ? 'workflow_dispatch' : 'push',
      repository: {full_name: 'cosyncing/cosyncing'}, status: 'completed', conclusion: 'success'});
    if (url.pathname.endsWith('/artifacts/401/zip')) {
      if (mode === 'download-too-large') {
        let chunks = 65;
        return new Response(new ReadableStream({pull(controller) {
          if (chunks-- > 0) controller.enqueue(new Uint8Array(1 << 20));else controller.close();
        }}));
      }
      return new Response(Bun.file(archive));
    }
    return new Response(url.pathname, {status: 404});
  }});
  try {
    for (const name of aggregate ? ['valid-aggregate'] : ['valid', 'flaky', 'missing-run', 'missing-artifact', 'expired', 'rerun', 'carried-gate',
      'failed-run', 'failed-gate', 'api-failure', 'changed-attempt', 'wrong-commit', 'dirty', 'partial', 'missing-task',
      'duplicate-task', 'wrong-command', 'wrong-provenance', 'oversized', 'oversized-wrong-source',
      'download-too-large', 'different-bun', 'different-bun-invalid', 'valid-rehearsal',
      'production-rehearsal-source', 'rehearsal-push-source', 'rehearsal-with-tag-event']) {
      mode = name;
      const candidate = aggregate ? JSON.parse(readFileSync(join(fixture, 'aggregate-valid/check/report.json'), 'utf8')) : structuredClone(report);
      const provenance = structuredClone(meta);
      if (producesRehearsal()) {
        Object.assign(provenance, {rehearsal: true, tag: rehearsalBranch,
          workflow: `cosyncing/cosyncing/.github/workflows/client-release.yml@refs/heads/${rehearsalBranch}`});
      }
      if (name === 'wrong-commit') candidate.commit = 'a'.repeat(40);
      if (name === 'dirty') candidate.dirty = true;
      if (name === 'partial') candidate.selection.complete = false;
      if (name === 'missing-task') {candidate.tasks.pop(); candidate.counts.pass--;}
      if (name === 'duplicate-task') {candidate.tasks.push(candidate.tasks[0]!); candidate.counts.pass++;}
      if (name === 'wrong-command') candidate.tasks[0]!.command = ['echo', 'not the planned test'];
      if (name === 'wrong-provenance') provenance.attempt = 9;
      if (name.startsWith('different-bun')) {
        provenance.bun = '1.4.0';candidate.host.bun = '1.4.0';
        if (name === 'different-bun-invalid') candidate.commit = 'a'.repeat(40);
      }
      if (name === 'flaky') {
        const task = candidate.tasks[0]!;
        task.status = 'flaky';
        task.attempts.unshift({...task.attempts[0]!, exitCode: 1, summary: 'first failure retained'});
        candidate.counts.pass--; candidate.counts.flaky++;
      }
      writeFileSync(join(fixture, 'report.json'), JSON.stringify(candidate));
      writeFileSync(join(fixture, 'provenance.json'), JSON.stringify(provenance));
      rmSync(archive, {force: true});
      const zip = Bun.spawnSync(['zip', '-q', '-j', archive, join(fixture, 'report.json'), join(fixture, 'provenance.json')]);
      check(zip.success, 'fixture evidence archive can be created');
      const output = join(fixture, name, 'check');
      const callerRehearsal = ['valid-rehearsal','rehearsal-push-source','rehearsal-with-tag-event'].includes(name);
      const child = Bun.spawn(['bun', 'run', 'scripts/release/client-check-evidence.ts', 'resolve'], {
        cwd: ROOT, env: {...fixtureEnv, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
          GITHUB_SHA: commit, GITHUB_REPOSITORY: 'cosyncing/cosyncing', GITHUB_REF_NAME: callerRehearsal ? rehearsalBranch : `broker-v${version}`,
          RELEASE_REHEARSAL: callerRehearsal ? 'true' : 'false', REHEARSAL_CLIENT_RUN_ID: callerRehearsal ? '201' : '',
          GITHUB_EVENT_NAME: callerRehearsal && name !== 'rehearsal-with-tag-event' ? 'workflow_dispatch' : 'push',
          GITHUB_REF_TYPE: callerRehearsal ? 'branch' : 'tag',
          GITHUB_RUN_ID: '501', GITHUB_RUN_ATTEMPT: '1', GITHUB_API_URL: server.url.origin,
          GH_TOKEN: 'fixture', GITHUB_OUTPUT: join(fixture, `${name}.outputs`), GITHUB_STEP_SUMMARY: join(fixture, `${name}.summary`),
          COSYNCING_RELEASE_CHECK_EVIDENCE_OUTPUT: output}, stdout: 'pipe', stderr: 'pipe',
      });
      const deadline = setTimeout(() => child.kill('SIGKILL'), 15_000);
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      clearTimeout(deadline);
      const fallback = ['missing-run','missing-artifact','expired','rerun','carried-gate',
        'oversized','download-too-large','different-bun'].includes(name);
      if (['valid','valid-aggregate','valid-rehearsal','flaky'].includes(name) || fallback) {
        check(exitCode === 0, `${name} completes evidence decision: ${stderr}`);
        const result = JSON.parse(stdout.trim());
        check(result.reused === !fallback, `${name} selects the expected reuse/fallback path`);
        if (!fallback) {
          check(existsSync(join(output, 'client-source-artifact.zip')), 'reused evidence retains original diagnostics');
          check(result.counts.flaky === (name === 'flaky' ? 1 : 0), 'reuse retains flaky counts');
          const summary = readFileSync(join(fixture, `${name}.summary`), 'utf8');
          check(summary.includes(commit) && summary.includes(` ${name === 'flaky' ? 1 : 0} flaky`)
            && summary.includes('/runs/201/attempts/1'), 'reuse summary identifies source and preserves flaky status');
        }
      } else {
        check(exitCode === 1 && stderr.includes('FAIL release check evidence'), `${name} fails closed: ${stderr}`);
        check(!existsSync(join(output, 'reuse-receipt.json')), `${name} cannot leave eligible reused evidence`);
      }
    }
    for (const name of aggregate ? ['valid-aggregate'] : ['valid', 'missing-android']) {
      const candidate = structuredClone(report);
      if (name === 'missing-android') {
        candidate.selection.suites = candidate.selection.suites.filter(suite => suite !== 'android');
        candidate.tasks = candidate.tasks.filter(task => task.suite !== 'android');
        candidate.counts.pass = candidate.tasks.length;
      }
      const output = join(fixture, `executed-${name}`, 'check');
      mkdirSync(output, {recursive: true});
      writeFileSync(join(output, 'report.json'), aggregate
        ? readFileSync(join(fixture, 'aggregate-valid/check/report.json')) : JSON.stringify(candidate));
      const child = Bun.spawnSync([process.execPath, 'scripts/release/client-check-evidence.ts', 'record'], {
        cwd: ROOT, env: {...fixtureEnv, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
          GITHUB_SHA: commit, GITHUB_REPOSITORY: 'cosyncing/cosyncing', GITHUB_JOB: 'gate',
          GITHUB_WORKFLOW_REF: meta.workflow, GITHUB_RUN_ID: '201', GITHUB_RUN_ATTEMPT: '1', GITHUB_REF_NAME: tag,
          COSYNCING_RELEASE_CHECK_EVIDENCE_OUTPUT: output}, stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
      });
      check(child.success === (name !== 'missing-android'), `${name} executed gate requires the fixed release profile: ${child.stderr.toString()}`);
      check(existsSync(join(output, 'provenance.json')), 'executed gate preserves its provenance even on validation failure');
    }
  } finally {
    server.stop(true);
  }
}

async function exerciseAggregateEvidence(): Promise<void> {
  const commit = 'f'.repeat(40);
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const workflow = `cosyncing/cosyncing/.github/workflows/client-release.yml@refs/tags/client-v${version}`;
  const definitions: CheckSelection[] = hostSuiteIds('linux', true).flatMap<CheckSelection>(suite => suite === 'client'
    ? [1,2,3].map(index => ({suites: [suite], shard: {index, total: 3}, repeat: 1, flutterLayout: 'serial-shards' as const}))
    : [{suites: [suite], shard: undefined, repeat: 1, flutterLayout: 'serial-shards' as const}]);
  const rerunCases = ['rerun','latest-failed','cancelled-rerun','old-malformed','latest-missing'];
  for (const name of ['valid','missing-android','overlap','mixed-commit','filtered','future-attempt',...rerunCases]) {
    const input = join(fixture, `aggregate-${name}`, 'parts');
    const output = join(fixture, `aggregate-${name}`, 'check');
    mkdirSync(input, {recursive: true});
    const reportFor = (selection: CheckSelection) => {
      const tasks = planChecks(selection, 'linux', false).tasks.map(({suite, task}) => ({
        suite: suite.id, id: task.id, iteration: 1, command: task.run, status: 'pass',
        attempts: [{exitCode: 0, durationMs: 1, timedOut: false, strays: false}],
      }));
      return {schemaVersion: 7, kind: 'repository-check', commit, dirty: false, status: 'pass',
        host: {platform: 'linux', arch: 'x64', bun: Bun.version},
        selection: {...selection, shard: selection.shard ? `${selection.shard.index}/${selection.shard.total}` : null,
          complete: false, only: null as string[] | null},
        counts: {pass: tasks.length, flaky: 0, fail: 0, blocked: 0}, tasks};
    };
    for (const selection of definitions) {
      if (name === 'missing-android' && selection.suites[0] === 'android') continue;
      const report = reportFor(selection);
      const meta = {schemaVersion: 1, repository: 'cosyncing/cosyncing', workflow, runId: 201,
        attempt: name === 'future-attempt' ? 2 : 1, job: 'verify', commit, profile: 'linux-release', bun: Bun.version};
      if (name === 'mixed-commit' && selection.suites[0] === 'android') report.commit = 'a'.repeat(40);
      if (name === 'filtered' && selection.suites[0] === 'android') report.selection.only = ['native-jvm'];
      const save = (r: typeof report, m: typeof meta) => {
        const part = `${selection.suites[0]}${selection.shard ? `-${selection.shard.index}-3` : ''}`;
        const directory = join(input, `client-check-part-201-${m.attempt}-${part}`);
        mkdirSync(directory);writeFileSync(join(directory, 'report.json'), JSON.stringify(r));
        writeFileSync(join(directory, 'provenance.json'), JSON.stringify(m));
      };
      if (rerunCases.includes(name) && selection.suites[0] === 'android') {
        const first = structuredClone(report), second = structuredClone(report);
        if (name === 'rerun') first.status = 'fail';
        else if (name === 'latest-failed') second.status = 'fail';
        save(first, meta);save(second, {...meta, attempt: 2});
        if (name === 'cancelled-rerun' || name === 'old-malformed' || name === 'latest-missing') {
          const directory = join(input, `client-check-part-201-${name === 'latest-missing' ? 2 : 1}-android`);
          rmSync(join(directory, 'report.json'));
          rmSync(join(directory, 'provenance.json'));
          writeFileSync(join(directory, 'cancelled.log'), 'interrupted before a report could be written');
          if (name === 'old-malformed') writeFileSync(join(directory, 'report.json'), '{ interrupted JSON');
        }
      } else save(report, meta);
    }
    if (name === 'overlap') {
      const report = reportFor({suites: ['client'], repeat: 1, flutterLayout: 'serial-shards', shard: undefined});
      const directory = join(input, 'client-check-part-201-1-client');mkdirSync(directory);
      writeFileSync(join(directory, 'report.json'), JSON.stringify(report));
      writeFileSync(join(directory, 'provenance.json'), JSON.stringify({schemaVersion: 1, repository: 'cosyncing/cosyncing',
        workflow, runId: 201, attempt: 1, job: 'verify', commit, profile: 'linux-release', bun: Bun.version}));
    }
    const child = Bun.spawn(['bun','run','scripts/ci/aggregate-checks.ts',input], {
      cwd: ROOT, env: {...fixtureEnv, PATH: `${join(fixture, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}`, GITHUB_SHA: commit, GITHUB_REPOSITORY: 'cosyncing/cosyncing',
        GITHUB_WORKFLOW_REF: workflow, GITHUB_RUN_ID: '201', GITHUB_RUN_ATTEMPT: rerunCases.includes(name) ? '2' : '1',
        COSYNCING_RELEASE_CHECK_EVIDENCE_OUTPUT: output, GITHUB_STEP_SUMMARY: join(fixture, `${name}-aggregate-summary`)},
      stdout: 'pipe', stderr: 'pipe',
    });
    const deadline = setTimeout(() => child.kill('SIGKILL'), 15_000);
    const [exitCode, , stderr] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    clearTimeout(deadline);
    const aggregate = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'));
    const success = ['valid','rerun','cancelled-rerun','old-malformed'].includes(name);
    check(exitCode === (success ? 0 : 1) && aggregate.status === (success ? 'pass' : 'fail'), `${name} aggregate result: ${stderr}`);
    if (name === 'rerun') check(aggregate.superseded.length === 1 && aggregate.superseded[0].report.status === 'fail', 'rerun retains superseded failure evidence');
    if (name === 'cancelled-rerun' || name === 'old-malformed') {
      check(aggregate.superseded[0].reportUnavailable === true
        && existsSync(join(output, 'parts/client-check-part-201-1-android/cancelled.log')),
      'incomplete older attempts do not poison reruns and retain their diagnostic logs');
    }
  }
}

async function exerciseStagingInputs(): Promise<void> {
  const version = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  for (const kind of ['client', 'client-verified', 'broker'] as const) {
    const clients = {linux: [`cosyncing-client-${version}-linux-x64.tar.gz`],
      macos: [`cosyncing-client-${version}-macos-arm64-unsigned.dmg`,`cosyncing-client-${version}-macos-arm64-unsigned.zip`],
      windows: [`cosyncing-client-${version}-windows-x64-unsigned.zip`], android: [`cosyncing-client-${version}-android.apk`]};
    const inventories: Record<string, string[]> = kind === 'client' ? clients
      : kind === 'client-verified' ? {complete: Object.values(clients).flat()}
      : {javascript: ['cosyncing-app.js','cosyncing-app.js.evidence.json'],
        web: ['cosyncing-web-app.tar.gz','cosyncing-web-app.tar.gz.evidence.json']};
    const changingTarget = kind === 'client' ? 'android' : kind === 'client-verified' ? 'complete' : 'web';
    const prefix = kind === 'client' ? 'client-build' : kind === 'client-verified' ? 'client-verified' : 'broker-package';
    for (const name of ['valid','missing','foreign-run','future-attempt','wrong-file','rerun','rehearsal','production-refuses-rehearsal']) {
      const input = join(fixture, `${kind}-builds-${name}`, 'inputs'), output = join(fixture, `${kind}-builds-${name}`, 'dist');
      mkdirSync(input, {recursive: true});
      for (const [target, files] of Object.entries(inventories)) {
        if (name === 'missing' && target === changingTarget) continue;
        const producerAttempt = name === 'future-attempt' ? 2 : 1;
        const artifactPrefix = name.includes('rehearsal') ? prefix.replace('-', '-rehearsal-') : prefix;
        const directory = join(input, `${artifactPrefix}-${name === 'foreign-run' ? 999 : 201}-${producerAttempt}-${target}`);
        mkdirSync(directory);
        for (const file of files) writeFileSync(join(directory, file), target + '-original');
        if (name === 'wrong-file' && target === changingTarget) writeFileSync(join(directory, 'unexpected.bin'), 'bad');
        if (name === 'rerun' && target === changingTarget) {
          const replacement = join(input, `${prefix}-201-2-${target}`);mkdirSync(replacement);
          for (const file of files) writeFileSync(join(replacement, file), target + '-rerun');
        }
      }
      const child = Bun.spawnSync(['bun','run','scripts/release/collect-build-artifacts.ts',kind,input,output], {
      cwd: ROOT, env: {...fixtureEnv, GITHUB_RUN_ID: '201', GITHUB_RUN_ATTEMPT: name === 'rerun' ? '2' : '1',
        GITHUB_REF_NAME: name === 'rehearsal' ? 'agent/rehearsal' : `${kind === 'broker' ? 'broker' : 'client'}-v${version}`,
        GITHUB_SHA: 'f'.repeat(40), GITHUB_REPOSITORY: 'cosyncing/cosyncing',
        RELEASE_REHEARSAL: name === 'rehearsal' ? 'true' : 'false',
        GITHUB_EVENT_NAME: name === 'rehearsal' ? 'workflow_dispatch' : 'push',
        GITHUB_REF_TYPE: name === 'rehearsal' ? 'branch' : 'tag'},
        stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
      });
      check(child.success === ['valid','rerun','rehearsal'].includes(name), `${kind}/${name} staging input result: ${child.stderr.toString()}`);
      if (name === 'rerun') check(readFileSync(join(output,inventories[changingTarget]![0]!), 'utf8') === changingTarget + '-rerun', 'staging selects the newest successful current-run build');
    }
  }
}

function exerciseAggregateCheckpoint(): void {
  // Consuming Linux release evidence must retain Android coverage even on a
  // review host where Android cannot execute. Stop at the first build boundary.
  const checkout = join(fixture, 'checkpoint-consumer');
  for (const directory of ['scripts/ci', 'scripts/release', 'apps/client/build/web', 'bin']) {
    mkdirSync(join(checkout, directory), {recursive: true});
  }
  for (const file of ['check-plan.ts', 'check-evidence.ts']) {
    copyFileSync(join(ROOT, 'scripts/ci', file), join(checkout, 'scripts/ci', file));
  }
  copyFileSync(join(ROOT, 'scripts/release/verify-release-checkpoint.ts'), join(checkout, 'scripts/release/verify-release-checkpoint.ts'));
  const selection = {suites: hostSuiteIds('linux', true), repeat: 1, flutterLayout: 'serial-shards' as const};
  const plan = planChecks(selection, 'linux', false).tasks;
  const manifest = selection.suites.map(id => ({id, tasks: plan.filter(item => item.suite.id === id).map(item => item.task)}));
  writeFileSync(join(checkout, 'scripts/ci/suites.ts'), `export const DEFAULT_TIMEOUT_MS=180000;
export const suites=${JSON.stringify(manifest)};
export const suiteRunsOn=(suite)=>suite.id!=='android';\n`);
  writeFileSync(join(checkout, 'package.json'), readFileSync(join(ROOT, 'package.json')));
  writeFileSync(join(checkout, 'apps/client/build/web/index.html'), 'controlled web fixture');
  writeFileSync(join(checkout, 'bin/git'), `#!/bin/sh
case "$1" in rev-parse) printf '%s\\n' '${'f'.repeat(40)}';; status|diff) ;; show) echo 1700000000;; *) exit 1;; esac\n`);
  writeFileSync(join(checkout, 'bin/bun'), '#!/bin/sh\necho "controlled build boundary" >&2\nexit 42\n');
  for (const name of ['git', 'bun']) chmodSync(join(checkout, 'bin', name), 0o755);
  const child = Bun.spawnSync([process.execPath, join(checkout, 'scripts/release/verify-release-checkpoint.ts')], {
    cwd: checkout, env: {...fixtureEnv, PATH: `${join(checkout, 'bin')}:${process.env.PATH}`,
      COSYNCING_RELEASE_CHECKPOINT_OUTPUT: join(checkout, 'output/release-checkpoint'),
      COSYNCING_RELEASE_CHECKPOINT_CHECK_REPORT: join(fixture, 'aggregate-valid/check/report.json')},
    stdout: 'pipe', stderr: 'pipe', timeout: 15_000,
  });
  check(child.exitCode === 42 && child.stdout.toString().includes('FAIL build-broker'),
    `complete Linux aggregate reaches the build boundary without a local Android SDK: ${child.stderr.toString()}`);
}

function exerciseBlockedEvidence(): void {
  const checkout = join(fixture, 'blocked-checkout'), bin = join(checkout, 'bin');
  const ci = join(checkout, 'scripts/ci'), output = join(checkout, 'output/check');
  mkdirSync(bin, {recursive: true});mkdirSync(ci, {recursive: true});
  for (const name of ['run.ts','check-plan.ts']) copyFileSync(join(ROOT, 'scripts/ci', name), join(ci, name));
  cpSync(join(ROOT, 'scripts/ci/lib'), join(ci, 'lib'), {recursive: true});
  writeFileSync(join(ci, 'suites.ts'), `export const DEFAULT_TIMEOUT_MS=10000;
export const suiteRunsOn=()=>true;
export const suites=[{id:'client',prepare:[{id:'pub-get',run:['flutter','pub','get']}],
tasks:[{id:'release-policy',run:['bun','-e','process.exit(0)']}]}];\n`);
  writeFileSync(join(bin, 'flutter'), '#!/bin/sh\necho "controlled dependency setup failure" >&2\nexit 42\n');
  chmodSync(join(bin, 'flutter'), 0o755);
  const result = Bun.spawnSync([process.execPath,join(ci, 'run.ts'),'client','--only','release-policy','--flutter-layout','serial-shards','--no-retry'], {
    cwd: checkout, env: {...fixtureEnv, PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH}`,
      COSYNCING_CHECK_OUTPUT: output}, stdout: 'pipe', stderr: 'pipe', timeout: 20_000,
  });
  check(result.exitCode === 1 && !result.stderr.toString().includes('TypeError'), 'failed preparation leaves a readable failed report');
  const report = JSON.parse(readFileSync(join(output, 'report.json'), 'utf8'));
  check(report.status === 'fail' && report.counts.blocked === 1 && report.counts.fail === 1,
    'blocked checks retain failed and unexecuted evidence instead of crashing report generation');
}
