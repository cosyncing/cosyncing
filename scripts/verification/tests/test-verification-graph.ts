#!/usr/bin/env bun
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  loadVerificationGraph,
  gatesForProfile,
  sourceFingerprint,
  validateFixtureIsolationSources,
  validateVerificationGraph,
  verificationBindingFingerprint,
  verificationEnvironment,
  type VerificationGraph,
} from '../verification-graph.ts';
import { gateOutcome } from '../gate-outcome.ts';

const ROOT = resolve(import.meta.dir, '../../..');
let checks = 0;

function assert(condition: unknown, message: string): asserts condition {
  checks += 1;
  if (!condition) throw new Error(message);
}

function clone(graph: VerificationGraph): VerificationGraph {
  return structuredClone(graph);
}

function errorsFor(graph: VerificationGraph): string[] {
  return validateVerificationGraph(graph, ROOT);
}

function expectMutation(
  name: string,
  mutate: (graph: VerificationGraph) => void,
  expected: RegExp,
): void {
  const graph = clone(loadVerificationGraph(ROOT));
  mutate(graph);
  const errors = errorsFor(graph);
  assert(
    errors.some((error) => expected.test(error)),
    `${name} mutation did not fail as expected: ${errors.join('; ')}`,
  );
}

const graph = loadVerificationGraph(ROOT);
const baselineErrors = errorsFor(graph);
assert(
  baselineErrors.length === 0,
  `committed verification graph is invalid: ${baselineErrors.join('; ')}`,
);
const fixtureIsolationErrors = validateFixtureIsolationSources(ROOT);
assert(
  fixtureIsolationErrors.length === 0,
  `committed fixture sources are not isolated: ${fixtureIsolationErrors.join('; ')}`,
);
const aggregateEnvironment = verificationEnvironment({
  PATH: '/fixture/bin',
  PORT: '36021',
  HOST: '127.0.0.1',
  OPENCODE_URL: 'http://host.invalid',
  COSYNCING_HOME: '/host/state',
  COSYNCING_TOKEN: 'host-secret',
});
assert(
  aggregateEnvironment.PATH === '/fixture/bin'
    && aggregateEnvironment.PORT === undefined
    && aggregateEnvironment.HOST === undefined
    && aggregateEnvironment.OPENCODE_URL === undefined
    && aggregateEnvironment.COSYNCING_HOME === undefined
    && aggregateEnvironment.COSYNCING_TOKEN === undefined,
  'direct aggregate execution must not inherit broker state or listener overrides',
);
const fixturePath =
  'scripts/broker/tests/pi/test-pi-bridge-reload.ts';
const fixtureSource = await Bun.file(join(ROOT, fixturePath)).text();
const fixtureMutationErrors = validateFixtureIsolationSources(ROOT, {
  [fixturePath]: fixtureSource.replaceAll(
    'isolatedBrokerFixtureEnvironment',
    'unisolatedEnvironment',
  ),
});
assert(
  fixtureMutationErrors.some((error) =>
    error.includes('does not construct an isolated broker environment')
  ),
  'fixture-isolation mutation did not fail closed',
);

expectMutation(
  'duplicate ownership',
  (value) => value.gates[1]!.claimIds.push(value.gates[0]!.claimIds[0]!),
  /duplicate owner/i,
);
expectMutation(
  'missing ownership',
  (value) => value.gates[0]!.claimIds.splice(0, 1),
  /has no owner/i,
);
expectMutation(
  'missing artifact declaration',
  (value) => {
    value.gates[0]!.expectedArtifacts = [];
  },
  /expected artifact/i,
);
expectMutation(
  'milestone-only release name',
  (value) => {
    value.gates[0]!.id = 'bpc99-release-round';
  },
  /milestone-only/i,
);
expectMutation(
  'milestone-only owned source content',
  (value) => {
    value.gates[0]!.sourceOwners.push(
      'scripts/verification/tests/test-verification-graph.ts',
    );
  },
  /milestone-only release name in source owner/i,
);
expectMutation(
  'dangling package command',
  (value) => {
    value.gates[0]!.command = ['bun', 'run', 'definitely:missing'];
  },
  /missing package script/i,
);
expectMutation(
  'undeclared exclusion',
  (value) => {
    value.profiles.check.exclusions.push('unregistered-host');
  },
  /undeclared exclusion/i,
);
expectMutation(
  'heavyweight parallel scheduling',
  (value) => {
    const heavyGroup = value.executionGroups.find(
      (group) => group.resourceClass === 'heavyweight',
    )!;
    heavyGroup.mode = 'parallel';
  },
  /heavyweight.*serial/i,
);
expectMutation(
  'dependency cycle',
  (value) => {
    value.gates.find((gate) => gate.id === 'contract')!.dependencies = [
      'client',
    ];
  },
  /dependency cycle/i,
);
expectMutation(
  'broker sub-suite command substitution',
  (value) => {
    const suite = value.gates
      .find((gate) => gate.id === 'broker-deterministic')!
      .subSuites!.find((item) => item.id === 'pi-tool-result')!;
    suite.command = ['bun', 'run', 'typecheck'];
  },
  /completeness anchor binding mismatch.*pi-tool-result/i,
);
expectMutation(
  'broker sub-suite source-owner substitution',
  (value) => {
    const suite = value.gates
      .find((gate) => gate.id === 'broker-deterministic')!
      .subSuites!.find((item) => item.id === 'pi-tool-result')!;
    suite.sourceOwners = ['tsconfig.json'];
  },
  /completeness anchor binding mismatch.*pi-tool-result/i,
);
expectMutation(
  'artifact isolation suite registration removal',
  (value) => {
    const broker = value.gates.find(
      (gate) => gate.id === 'broker-deterministic',
    )!;
    broker.subSuites = broker.subSuites!.filter(
      (suite) => suite.id !== 'artifact-session-isolation',
    );
    for (const group of broker.subSuiteGroups!) {
      group.subSuites = group.subSuites.filter(
        (id) => id !== 'artifact-session-isolation',
      );
    }
  },
  /completeness anchor.*artifact-session-isolation/i,
);
expectMutation(
  'web artifact production-path registration removal',
  (value) => {
    const browser = value.gates.find((gate) => gate.id === 'web-browser')!;
    browser.claimIds = browser.claimIds.filter(
      (claimId) => claimId !== 'browser.artifact-session-isolation',
    );
    browser.sourceOwners = browser.sourceOwners.filter(
      (owner) => owner !== 'scripts/client/tests/test-web-artifact-session-isolation.ts',
    );
  },
  /completeness anchor.*web-browser/i,
);
expectMutation(
  'web browser verdict removal',
  (value) => {
    const browser = value.gates.find((gate) => gate.id === 'web-browser')!;
    browser.expectedArtifacts = browser.expectedArtifacts.filter(
      (artifact) => artifact.path !== 'output/artifact-session-isolation/verdict.json',
    );
  },
  /completeness anchor binding mismatch.*web-browser/i,
);

// A gate's requirement decides whether its red blocks the release, so it is
// part of the anchored binding. Demoting a required gate to advisory leaves
// every executable input untouched; without these inputs in the fingerprint
// the anchor still validated and the gate silently stopped counting.
expectMutation(
  'gate requirement demotion',
  (value) => {
    value.gates.find((gate) => gate.id === 'public-tree')!.requirement = 'advisory';
  },
  /completeness anchor binding mismatch.*public-tree/i,
);
expectMutation(
  'Flutter golden registry input removal',
  (value) => {
    const registry = 'scripts/ci/flutter-golden-registry.json';
    for (const gateId of ['public-tree', 'public-tree-policy']) {
      const gate = value.gates.find((item) => item.id === gateId)!;
      gate.sourceOwners = gate.sourceOwners.filter((owner) => owner !== registry);
    }
  },
  /completeness anchor binding mismatch.*public-tree/i,
);
expectMutation(
  'docs-only workflow verdict input removal',
  (value) => {
    const owners = new Set([
      'scripts/ci/classify-docs-only.rb',
      'scripts/ci/tests/test-docs-only-policy.rb',
    ]);
    const gate = value.gates.find((item) => item.id === 'workflow-policy')!;
    gate.sourceOwners = gate.sourceOwners.filter((owner) => !owners.has(owner));
  },
  /completeness anchor binding mismatch.*workflow-policy/i,
);
expectMutation(
  'candidate browser release-gate input removal',
  (value) => {
    const owners = new Set([
      'scripts/broker/release/candidate-browser-startup.ts',
      'scripts/broker/release/verify-candidate-pair.ts',
    ]);
    const gate = value.gates.find((item) => item.id === 'release-candidate-pair')!;
    gate.sourceOwners = gate.sourceOwners.filter((owner) => !owners.has(owner));
  },
  /completeness anchor binding mismatch.*release-candidate-pair/i,
);
expectMutation(
  'candidate browser release-sub-suite input removal',
  (value) => {
    const owners = new Set([
      'scripts/broker/release/candidate-browser-startup.ts',
      'scripts/broker/release/verify-candidate-pair.ts',
    ]);
    const suite = value.gates
      .find((gate) => gate.id === 'broker-deterministic')!
      .subSuites!.find((item) => item.id === 'release-supply-chain')!;
    suite.sourceOwners = suite.sourceOwners.filter((owner) => !owners.has(owner));
  },
  /completeness anchor binding mismatch.*release-supply-chain/i,
);
// The same protection must not be specific to one gate.
expectMutation(
  'gate requirement demotion is generic',
  (value) => {
    value.gates.find((gate) => gate.id === 'contract')!.requirement = 'advisory';
  },
  /completeness anchor binding mismatch.*contract/i,
);
// A baseline does not excuse a required gate's failures, but it does change
// how advisory results are interpreted, so attaching one must move the
// fingerprint just like a demotion does.
expectMutation(
  'gate advisory baseline injection',
  (value) => {
    value.gates.find((gate) => gate.id === 'public-tree')!.advisoryBaseline =
      'source-boundaries';
  },
  /completeness anchor binding mismatch.*public-tree/i,
);

{
  const packageScripts = JSON.parse(
    readFileSync(join(ROOT, 'package.json'), 'utf8'),
  ).scripts as Record<string, string>;
  const execution = {
    command: ['bun', 'run', 'ci:check-public-tree'],
    sourceOwners: ['scripts/ci/check-public-tree.rb'],
    claimIds: ['repository.public-tree'],
  };
  const asRequired = verificationBindingFingerprint(
    { ...execution, requirement: 'required' as const },
    packageScripts,
  );
  const asAdvisory = verificationBindingFingerprint(
    { ...execution, requirement: 'advisory' as const },
    packageScripts,
  );
  const withBaseline = verificationBindingFingerprint(
    { ...execution, requirement: 'required' as const, advisoryBaseline: 'public-tree' },
    packageScripts,
  );
  const withVerdict = verificationBindingFingerprint(
    {
      ...execution,
      requirement: 'required' as const,
      expectedArtifacts: [
        { path: 'output/browser/verdict.json', kind: 'report' as const },
      ],
    },
    packageScripts,
  );
  assert(
    asRequired !== asAdvisory,
    'two bindings differing only in requirement must fingerprint differently',
  );
  assert(
    asRequired !== withBaseline,
    'attaching an advisory baseline must change the fingerprint',
  );
  assert(
    asRequired !== withVerdict,
    'attaching an evidence contract must change the fingerprint',
  );
  // Sub-suites declare no requirement. Their bindings must stay distinguishable
  // from a gate's, and stable across this composition change.
  const withoutRequirement = verificationBindingFingerprint(execution, packageScripts);
  assert(
    withoutRequirement !== asRequired,
    'an absent requirement must not fingerprint as an explicit one',
  );
}

// Both gates must live in the group being inverted, so this pairs `contract`
// with a dependent that shares it. `client` used to play that role and now has
// its own heavyweight group, where there is no declared order left to invert.
const inverted = clone(graph);
const checkGroup = inverted.executionGroups.find(
  (group) => group.id === 'check-standard',
)!;
const contractIndex = checkGroup.gates.indexOf('contract');
const historyIndex = checkGroup.gates.indexOf('contract-history');
assert(
  contractIndex !== -1 && historyIndex !== -1,
  'the inversion fixture needs both gates in check-standard',
);
[checkGroup.gates[contractIndex], checkGroup.gates[historyIndex]] = [
  checkGroup.gates[historyIndex]!,
  checkGroup.gates[contractIndex]!,
];
const invertedSchedule = gatesForProfile(inverted, 'check').map(
  (gate) => gate.id,
);
assert(
  invertedSchedule.indexOf('contract') < invertedSchedule.indexOf('contract-history'),
  'dependency-aware scheduling must repair a declared-order inversion',
);

const removedRegression = clone(graph);
const broker = removedRegression.gates.find(
  (gate) => gate.id === 'broker-deterministic',
)!;
broker.subSuites = broker.subSuites!.filter(
  (suite) => suite.id !== 'pi-tool-result',
);
for (const group of broker.subSuiteGroups!) {
  group.subSuites = group.subSuites.filter((id) => id !== 'pi-tool-result');
}
broker.claimIds = broker.claimIds.filter(
  (claimId) => claimId !== 'broker.pi-tool-result',
);
removedRegression.claims = removedRegression.claims.filter(
  (claim) => claim.id !== 'broker.pi-tool-result',
);
assert(
  errorsFor(removedRegression).some((error) =>
    /completeness anchor.*pi-tool-result/i.test(error)
  ),
  'removing a claim, sub-suite, and ownership together must fail completeness',
);

const fixture = mkdtempSync(join(tmpdir(), 'cosyncing-source-fingerprint-'));
try {
  const git = (args: string[]) => {
    const result = Bun.spawnSync(['git', ...args], {
      cwd: fixture,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert(
      result.success,
      `git ${args.join(' ')} failed: ${result.stderr.toString()}`,
    );
  };
  git(['init', '-q']);
  git(['config', 'user.name', 'Verification fixture']);
  git(['config', 'user.email', 'verification@example.invalid']);
  writeFileSync(join(fixture, 'source.txt'), 'before\n');
  git(['add', 'source.txt']);
  git(['commit', '-qm', 'fixture']);
  const before = sourceFingerprint(fixture);
  writeFileSync(join(fixture, 'source.txt'), 'after\n');
  const after = sourceFingerprint(fixture);
  assert(
    before.sha256 !== after.sha256,
    'tracked source mutation must change the cumulative-run fingerprint',
  );
} finally {
  rmSync(fixture, { recursive: true, force: true });
}

/* ---------------- what a gate's run means ------------------------------- */

/**
 * The precedence is the decision. Each rule below overrides the ones above it,
 * and the order is only visible when two apply at once.
 */
{
  const base = {
    declaredRequirement: 'required' as const,
    success: true,
    timedOut: false,
    strays: false,
    timeoutMs: 120_000,
    timeoutClass: 'short',
    observedSummary: 'PASS everything',
    missingArtifacts: [] as string[],
  };
  const matching = {
    matches: true,
    added: 0,
    removed: 0,
    expectedCount: 80,
    actualCount: 80,
  };

  const clean = gateOutcome(base);
  assert(clean.status === 'pass', 'a clean run passes');

  const leaked = gateOutcome({ ...base, strays: true });
  assert(leaked.status === 'fail', 'a gate that leaks processes fails');
  assert(
    leaked.requirement === 'required',
    'a leak is a required failure, whatever the gate is declared as',
  );
  assert(
    leaked.summary.includes('leaving processes behind'),
    `the summary must say what happened (${leaked.summary})`,
  );

  // The case this rule exists for: an advisory gate whose findings match its
  // recorded baseline is an expected failure, and that must not also excuse a
  // leaked process. A baseline describes findings, not the process tree.
  const advisoryLeak = gateOutcome({
    ...base,
    declaredRequirement: 'advisory',
    success: false,
    strays: true,
    baseline: matching,
  });
  assert(
    advisoryLeak.requirement === 'required' && advisoryLeak.status === 'fail',
    'a matching advisory baseline must not shelter a leak',
  );
  assert(
    advisoryLeak.summary.includes('leaving processes behind'),
    `the leak must be what is reported (${advisoryLeak.summary})`,
  );

  // Without the leak, the same gate is the advisory failure it is declared to
  // be — the rule must not promote everything.
  const advisoryExpected = gateOutcome({
    ...base,
    declaredRequirement: 'advisory',
    success: false,
    baseline: matching,
  });
  assert(
    advisoryExpected.requirement === 'advisory'
      && advisoryExpected.status === 'fail',
    'a matching advisory baseline stays advisory',
  );

  const drifted = gateOutcome({
    ...base,
    declaredRequirement: 'advisory',
    success: false,
    baseline: { matches: false, added: 2, removed: 1, expectedCount: 80, actualCount: 81 },
  });
  assert(
    drifted.requirement === 'required' && drifted.summary.includes('+2 -1'),
    `baseline drift is a required failure (${drifted.summary})`,
  );

  const missing = gateOutcome({ ...base, missingArtifacts: ['output/x.json'] });
  assert(
    missing.requirement === 'required' && missing.summary.includes('output/x.json'),
    'a gate that produced no evidence has not run',
  );

  const failedAndMissing = gateOutcome({
    ...base,
    success: false,
    observedSummary: 'browser click timed out',
    missingArtifacts: ['output/browser/verdict.json'],
  });
  assert(
    failedAndMissing.summary.includes('browser click timed out')
      && failedAndMissing.summary.includes('output/browser/verdict.json'),
    `missing evidence must not mask the command failure (${failedAndMissing.summary})`,
  );

  const timedOutAndMissing = gateOutcome({
    ...base,
    success: false,
    timedOut: true,
    missingArtifacts: ['output/browser/verdict.json'],
  });
  assert(
    timedOutAndMissing.summary.includes('timed out after 120000ms (short)')
      && timedOutAndMissing.summary.includes('output/browser/verdict.json'),
    `missing evidence must not mask the timeout (${timedOutAndMissing.summary})`,
  );

  const advisoryAndMissing = gateOutcome({
    ...base,
    declaredRequirement: 'advisory',
    success: false,
    baseline: {
      matches: false,
      added: 1,
      removed: 0,
      expectedCount: 2,
      actualCount: 3,
    },
    missingArtifacts: ['output/browser/verdict.json'],
  });
  assert(
    advisoryAndMissing.status === 'fail'
      && advisoryAndMissing.requirement === 'required'
      && advisoryAndMissing.summary.startsWith('FAIL ')
      && advisoryAndMissing.summary.includes('advisory baseline changed')
      && advisoryAndMissing.summary.includes('output/browser/verdict.json'),
    `missing evidence must promote advisory drift without masking it (${advisoryAndMissing.summary})`,
  );

  // A leak outranks a missing artifact: both are required failures, but the
  // leak is the one that affects the next gate to run.
  const both = gateOutcome({
    ...base,
    strays: true,
    missingArtifacts: ['output/x.json'],
  });
  assert(
    both.summary.includes('leaving processes behind'),
    `a leak is reported ahead of a missing artifact (${both.summary})`,
  );

  const timedOut = gateOutcome({ ...base, success: false, timedOut: true });
  assert(
    timedOut.summary.includes('timed out after 120000ms (short)'),
    `a timeout names its own bound (${timedOut.summary})`,
  );
}

console.log(`PASS ${checks}/${checks} verification graph checks`);
