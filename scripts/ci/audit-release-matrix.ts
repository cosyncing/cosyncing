#!/usr/bin/env bun
/** Check release coverage, staging and rehearsal boundaries before tags exist. */
import { resolve } from 'node:path';
import { coverageUnits, hostSuiteIds, planChecks } from './check-plan.ts';
import { object, requireThat, sameSet } from './check-evidence.ts';
import type { SuiteId } from './suites.ts';

const ROOT = resolve(import.meta.dir, '../..');
try {
  requireThat(process.argv.length <= 4, 'expected optional client and broker workflow paths');
  const path = resolve(process.argv[2] ?? '.github/workflows/client-release.yml');
  const readWorkflow = (file: string): Record<string, unknown> => {
    const parsed = Bun.spawnSync(['ruby', '-ryaml', '-rjson', '-e',
      'puts JSON.generate(YAML.load_file(ARGV[0]))', file], {cwd: ROOT, stdout: 'pipe', stderr: 'pipe'});
    requireThat(parsed.success, `cannot read release workflow: ${parsed.stderr.toString().trim()}`);
    return object(JSON.parse(parsed.stdout.toString()), 'release workflow');
  };
  const client = readWorkflow(path), broker = readWorkflow(resolve(process.argv[3] ?? '.github/workflows/broker-release.yml'));
  const clientJobs = object(client.jobs, 'client jobs'), brokerJobs = object(broker.jobs, 'broker jobs');
  const job = object(clientJobs.verify, 'verification job');
  requireThat(job.name === "verify ${{ matrix.suite }}${{ matrix.shard && format(' {0}', matrix.shard) || '' }}",
    'verification job name must identify the suite and shard');
  const matrix = object(object(job.strategy, 'verification strategy').matrix, 'verification matrix');
  requireThat(Array.isArray(matrix.include), 'release verification needs explicit suite/shard rows');
  const required = hostSuiteIds('linux', true);
  const expected = planChecks({suites: required, repeat: 1, flutterLayout: 'serial-shards'}, 'linux', false)
    .tasks.flatMap(coverageUnits);
  const observed: string[] = [];
  for (const value of matrix.include) {
    const row = object(value, 'verification row');
    requireThat(typeof row.suite === 'string' && required.includes(row.suite as SuiteId), 'unexpected release suite');
    let shard: {index: number; total: number} | undefined;
    if (row.shard !== undefined) {
      const match = typeof row.shard === 'string' && /^(\d+)\/(\d+)$/.exec(row.shard);
      requireThat(match, 'invalid release shard');
      shard = {index: Number(match[1]), total: Number(match[2])};
      requireThat(shard.index >= 1 && shard.total <= 32 && shard.index <= shard.total
        && row.shard === `${shard.index}/${shard.total}`, 'invalid release shard bounds');
    }
    requireThat(row.part === `${row.suite}${shard ? `-${shard.index}-${shard.total}` : ''}`,
      'artifact part must identify exactly its suite and shard');
    const plan = planChecks({suites: [row.suite as SuiteId], repeat: 1, shard, flutterLayout: 'serial-shards'}, 'linux', false);
    requireThat(plan.tasks.length > 0, 'release matrix contains an empty selection');
    if (plan.prepare.some(item => item.task.run[0] === 'flutter')) {
      requireThat(row.flutter === true, 'release row is missing Flutter setup');
    }
    if (row.suite === 'web') requireThat(row.browser === true, 'web verification is missing browser setup');
    observed.push(...plan.tasks.flatMap(coverageUnits));
  }
  sameSet(observed, expected, 'release matrix coverage');
  requireThat(Array.isArray(job.steps) && job.steps.some(value => {
    const step = object(value, 'verification step');
    return typeof step.uses === 'string' && step.uses.startsWith('actions/upload-artifact@')
      && object(step.with, 'verification artifact').name
        === 'client-check-part-${{ github.run_id }}-${{ github.run_attempt }}-${{ matrix.part }}';
  }), 'verification artifact names must preserve run, attempt and suite/shard identity');
  const pushOnly = "${{ github.event_name == 'push' }}";
  const dispatchOnly = "${{ github.event_name == 'workflow_dispatch' }}";
  const publicationDependencies = new Map([
    ['prepare-draft', 'stage-verified'],
    ['publish-candidate', 'prepare-draft'],
  ]);
  const publicationCondition = (dependency: string): string =>
    "${{ !cancelled() && github.event_name == 'push' && needs." + dependency + ".result == 'success' }}";
  const sameCondition = (actual: unknown, expected: string): boolean =>
    typeof actual === 'string' && actual.replace(/\s/g, '') === expected.replace(/\s/g, '');
  const steps = (job: Record<string, unknown>): Record<string, unknown>[] => {
    requireThat(Array.isArray(job.steps), 'release job has no steps');
    return job.steps.map(value => object(value, 'release step'));
  };
  const retained = (job: Record<string, unknown>, target: string, days: number): void => {
    requireThat(steps(job).some(step => typeof step.uses === 'string' && step.uses.startsWith('actions/upload-artifact@')
      && String(object(step.with, 'staging artifact').name).endsWith('-' + target)
      && Number(object(step.with, 'staging artifact')['retention-days']) === days), 'incorrect staging retention');
  };
  for (const workflow of [client, broker]) {
    const jobs = object(workflow.jobs, 'release jobs'), env = object(workflow.env, 'release environment');
    requireThat(Object.hasOwn(object(workflow.on ?? workflow.true, 'release triggers'), 'workflow_dispatch'), 'release workflow needs a no-publish dispatch trigger');
    requireThat(env.RELEASE_REHEARSAL === "${{ github.event_name == 'workflow_dispatch' && 'true' || 'false' }}", 'rehearsal mode must derive from the event, never an overridable input');
    requireThat(typeof env.BUN_VERSION === 'string', 'release workflow needs one Bun version setting');
    for (const [id, value] of Object.entries(jobs)) {
      const job = object(value, 'release job');
      const permissions = object(job.permissions ?? {}, 'job permissions');
      if (job.environment || permissions.contents === 'write' || JSON.stringify(job).includes('secrets.')) {
        const dependency = workflow === client ? publicationDependencies.get(id) : undefined;
        requireThat(sameCondition(job.if, dependency ? publicationCondition(dependency) : pushOnly),
          'signing and release writes must require tag push; publication must tolerate optional skips and require successful verified inputs');
      }
      for (const step of steps(job)) {
        if (typeof step.uses === 'string' && step.uses.startsWith('oven-sh/setup-bun@')) {
          requireThat(object(step.with, 'Bun setup')['bun-version'] === '${{ env.BUN_VERSION }}', 'Bun setup must use the workflow version setting');
        }
        if (typeof step.uses === 'string' && step.uses.startsWith('subosito/flutter-action@')) {
          requireThat(object(step.with, 'Flutter setup')['flutter-version'] === '${{ env.FLUTTER_VERSION }}', 'Flutter setup must use the workflow version setting');
        }
      }
    }
  }
  requireThat(object(client.env, 'client environment').BUN_VERSION === object(broker.env, 'broker environment').BUN_VERSION,
    'client and broker Bun settings must agree before tagging');
  requireThat(object(client.env, 'client environment').FLUTTER_VERSION === object(broker.env, 'broker environment').FLUTTER_VERSION,
    'client and broker Flutter settings must agree before tagging');
  const handoff = object(clientJobs['stage-verified'], 'verified client handoff');
  sameSet(handoff.needs as string[], ['gate','linux','macos','windows','android','android-rehearsal'], 'verified handoff dependencies');
  const handoffCondition = "${{ !cancelled() && needs.gate.result == 'success' && needs.linux.result == 'success' && needs.macos.result == 'success' && needs.windows.result == 'success' && ((github.event_name == 'push' && needs.android.result == 'success') || (github.event_name == 'workflow_dispatch' && needs.android-rehearsal.result == 'success')) }}";
  requireThat(String(handoff.if).replace(/\s/g, '') === handoffCondition.replace(/\s/g, ''), 'verified handoff must require the gate and the matching Android build');
  requireThat(object(handoff.permissions, 'handoff permissions').contents === 'read', 'verified handoff must be read-only');
  retained(handoff, 'complete', 30);
  for (const [id, dependency] of publicationDependencies) {
    const publication = object(clientJobs[id], 'client publication');
    requireThat(publication.needs === dependency, 'client publication must wait for its verified input dependency');
    requireThat(sameCondition(publication.if, publicationCondition(dependency)),
      'client publication must tolerate optional skips while requiring successful inputs and tag push');
  }
  for (const target of ['linux','macos','windows','android','android-rehearsal']) {
    const build = object(clientJobs[target], 'client build');
    requireThat(build.needs === 'source' && object(build.permissions, 'build permissions').contents === 'read', 'builds must be read-only and follow source validation');
    retained(build, target === 'android-rehearsal' ? 'android' : target, target.startsWith('android') ? 1 : 30);
  }
  const androidRehearsal = object(clientJobs['android-rehearsal'], 'Android rehearsal');
  requireThat(androidRehearsal.if === dispatchOnly && !androidRehearsal.environment
    && !JSON.stringify(androidRehearsal).includes('secrets.'), 'Android rehearsal must use no protected environment or release secrets');
  const candidate = object(brokerJobs.candidate, 'broker candidate');
  requireThat(!steps(candidate).some(step => String(step.uses).toLowerCase().startsWith('actions/cache@')), 'protected signing must not restore a browser cache');
  for (const target of ['javascript','web']) retained(object(brokerJobs[target + '-package'], 'broker package'), target, 30);
  const rehearsal = object(brokerJobs['rehearse-candidate'], 'broker rehearsal');
  requireThat(rehearsal.if === dispatchOnly && !rehearsal.environment
    && object(rehearsal.permissions, 'rehearsal permissions').contents === 'read'
    && !JSON.stringify(rehearsal).includes('secrets.'), 'broker rehearsal must be read-only without release secrets');
  console.log(`PASS release matrix covers ${required.join(', ')} exactly once; rehearsal and staging boundaries hold`);
} catch (error) {
  console.error(`FAIL release matrix: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
