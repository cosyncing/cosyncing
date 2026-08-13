import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

export type Requirement = 'required' | 'advisory';
export type ResourceClass = 'standard' | 'heavyweight';
export type ExecutionMode = 'serial' | 'parallel';

export interface ExpectedArtifact {
  path: string;
  kind: 'log' | 'report' | 'directory' | 'artifact';
}

export interface BrokerSubSuite {
  id: string;
  claimId: string;
  command: string[];
  sourceOwners: string[];
  timeoutClass?: 'short' | 'medium' | 'long';
}

export interface SubSuiteGroup {
  id: string;
  mode: ExecutionMode;
  resourceClass: ResourceClass;
  subSuites: string[];
}

export interface VerificationGate {
  id: string;
  releaseDomain: string;
  claimIds: string[];
  command: string[];
  cwd?: string;
  focusedDiagnostics: string[][];
  dependencies: string[];
  expectedArtifacts: ExpectedArtifact[];
  timeoutClass: 'short' | 'medium' | 'long' | 'cumulative';
  resourceClass: ResourceClass;
  requirement?: Requirement;
  advisoryBaseline?: string;
  platformExclusions: string[];
  sourceOwners: string[];
  subSuiteGroups?: SubSuiteGroup[];
  subSuites?: BrokerSubSuite[];
}

export interface VerificationProfile {
  command: string[];
  executionGroups: string[];
  exclusions: string[];
  expectedArtifacts: string[];
  dependencies?: string[];
}

export interface VerificationGraph {
  schemaVersion: number;
  inventoryId: string;
  profiles: {
    check: VerificationProfile;
    releaseCheckpoint: VerificationProfile;
  };
  exclusions: Array<{
    id: string;
    description: string;
    owners: string[];
  }>;
  claims: Array<{ id: string; description: string }>;
  executionGroups: Array<{
    id: string;
    mode: ExecutionMode;
    resourceClass: ResourceClass;
    gates: string[];
  }>;
  gates: VerificationGate[];
}

interface VerificationBindingAnchor {
  id: string;
  fingerprint: string;
}

interface VerificationCompletenessAnchor {
  schemaVersion: number;
  acceptedBase: string;
  requiredClaimIds: string[];
  requiredGateBindings: VerificationBindingAnchor[];
  requiredBrokerSubSuiteBindings: VerificationBindingAnchor[];
}

export interface SourceFingerprint {
  commit: string;
  dirty: boolean;
  sha256: string;
}

export function verificationEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment = { ...source };
  for (const key of Object.keys(environment)) {
    if (key.startsWith('COSYNCING_')) delete environment[key];
  }
  delete environment.PORT;
  delete environment.HOST;
  delete environment.OPENCODE_URL;
  return environment;
}

const MAX_BUFFER_BYTES = 64 << 20;
const MILESTONE_NAME = /(?:^|[^a-z0-9])(?:rg|bpc)\d+(?:[^a-z0-9]|$)/i;

export function graphPath(root: string): string {
  return join(root, 'scripts', 'verification', 'verification-graph.json');
}

function completenessAnchorPath(root: string): string {
  return join(
    root,
    'scripts',
    'verification',
    'verification-completeness-anchor.json',
  );
}

function loadCompletenessAnchor(
  root: string,
): VerificationCompletenessAnchor | undefined {
  const path = completenessAnchorPath(root);
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as VerificationCompletenessAnchor;
}

function duplicateValues(values: string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function packageScriptClosure(
  command: string[],
  packageScripts: Record<string, string>,
): Record<string, string> {
  if (command[0] !== 'bun' || command[1] !== 'run') return {};
  const root = command[2];
  if (!root || packageScripts[root] === undefined) return {};
  const pending = [root];
  const closure = new Map<string, string>();
  while (pending.length > 0) {
    const id = pending.shift()!;
    if (closure.has(id)) continue;
    const body = packageScripts[id];
    if (body === undefined) continue;
    closure.set(id, body);
    for (const match of body.matchAll(/\bbun\s+run\s+([a-zA-Z0-9:_-]+)/g)) {
      const dependency = match[1]!;
      if (packageScripts[dependency] !== undefined && !closure.has(dependency)) {
        pending.push(dependency);
      }
    }
  }
  return Object.fromEntries(
    [...closure.entries()].sort(([left], [right]) => left.localeCompare(right)),
  );
}

/**
 * Binds what a gate runs to what its result is allowed to mean.
 *
 * `requirement`, `advisoryBaseline`, and `expectedArtifacts` are part of the
 * fingerprint because they decide how a gate's result counts against the
 * release. Without them a gate could be demoted, reinterpreted, or allowed to
 * pass without its committed evidence while the anchor still validated.
 *
 * Callers pass the EFFECTIVE requirement, not the declared one, so a gate that
 * omits the field and a gate that spells out "required" agree.
 *
 * Broker sub-suites carry no requirement or artifact contract of their own.
 * They leave those keys undefined, `JSON.stringify` drops them, and their
 * fingerprints stay byte-identical across this composition change.
 */
export function verificationBindingFingerprint(
  binding: {
    command: string[];
    sourceOwners: string[];
    workingDirectory?: string;
    claimIds: string[];
    requirement?: Requirement;
    advisoryBaseline?: string;
    expectedArtifacts?: ExpectedArtifact[];
  },
  packageScripts: Record<string, string>,
): string {
  const canonical = JSON.stringify({
    command: binding.command,
    packageScripts: packageScriptClosure(binding.command, packageScripts),
    workingDirectory: binding.workingDirectory ?? null,
    claimIds: [...binding.claimIds].sort(),
    sourceOwners: [...binding.sourceOwners].sort(),
    requirement: binding.requirement,
    advisoryBaseline: binding.advisoryBaseline,
    expectedArtifacts: binding.expectedArtifacts === undefined
      ? undefined
      : [...binding.expectedArtifacts].sort((left, right) =>
        `${left.path}\0${left.kind}`.localeCompare(`${right.path}\0${right.kind}`)
      ),
  });
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

function acceptedBaseError(root: string, acceptedBase: string): string | undefined {
  const resolved = Bun.spawnSync(
    ['git', 'rev-parse', '--verify', `${acceptedBase}^{commit}`],
    { cwd: root, stdout: 'ignore', stderr: 'ignore' },
  );
  if (!resolved.success) return `accepted base ${acceptedBase} does not resolve`;
  const ancestor = Bun.spawnSync(
    ['git', 'merge-base', '--is-ancestor', acceptedBase, 'HEAD'],
    { cwd: root, stdout: 'ignore', stderr: 'ignore' },
  );
  return ancestor.success
    ? undefined
    : `accepted base ${acceptedBase} is not an ancestor of HEAD`;
}

function dependencyCycles(
  nodes: string[],
  dependenciesFor: (node: string) => string[],
): string[] {
  const nodeSet = new Set(nodes);
  const state = new Map<string, 'visiting' | 'visited'>();
  const stack: string[] = [];
  const cycles = new Set<string>();
  const visit = (node: string): void => {
    if (state.get(node) === 'visited') return;
    if (state.get(node) === 'visiting') {
      const start = stack.indexOf(node);
      cycles.add([...stack.slice(start), node].join(' -> '));
      return;
    }
    state.set(node, 'visiting');
    stack.push(node);
    for (const dependency of dependenciesFor(node)) {
      if (nodeSet.has(dependency)) visit(dependency);
    }
    stack.pop();
    state.set(node, 'visited');
  };
  for (const node of nodes) visit(node);
  return [...cycles].sort();
}

export function loadVerificationGraph(root: string): VerificationGraph {
  return JSON.parse(readFileSync(graphPath(root), 'utf8')) as VerificationGraph;
}

function gitOutput(root: string, args: string[]): Buffer {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: root,
    stdout: 'pipe',
    stderr: 'pipe',
    maxBuffer: MAX_BUFFER_BYTES,
  });
  if (!result.success) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.toString().trim()}`,
    );
  }
  return Buffer.from(result.stdout);
}

export function sourceFingerprint(root: string): SourceFingerprint {
  const commit = gitOutput(root, ['rev-parse', 'HEAD']).toString().trim();
  const status = gitOutput(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=normal',
  ]);
  const index = gitOutput(root, ['ls-files', '--stage', '-z']);
  const trackedChanges = gitOutput(root, [
    'diff',
    '--no-ext-diff',
    '--binary',
    '--full-index',
    'HEAD',
    '--',
  ]);
  const untracked = gitOutput(root, [
    'ls-files',
    '-z',
    '--others',
    '--exclude-standard',
  ]);
  const hash = createHash('sha256');
  const add = (label: string, value: Uint8Array | string): void => {
    hash.update(`${label}\0`);
    hash.update(value);
    hash.update('\0');
  };
  add('commit', commit);
  add('status', status);
  add('index', index);
  add('tracked-changes', trackedChanges);
  const untrackedPaths = untracked.toString().split('\0').filter(Boolean).sort();
  for (const path of untrackedPaths) {
    const absolute = join(root, path);
    const stat = lstatSync(absolute);
    add('untracked-path', path);
    add('untracked-mode', stat.mode.toString(8));
    if (stat.isSymbolicLink()) add('untracked-link', readlinkSync(absolute));
    else if (stat.isFile()) add('untracked-bytes', readFileSync(absolute));
    else add('untracked-type', 'unsupported');
  }
  return {
    commit,
    dirty: status.length > 0,
    sha256: `sha256:${hash.digest('hex')}`,
  };
}

function commandError(
  command: string[],
  root: string,
  packageScripts: Record<string, string>,
): string | undefined {
  if (command.length === 0) return 'empty command';
  if (command[0]?.startsWith('internal:')) return undefined;
  if (command[0] === 'bun' && command[1] === 'run') {
    const target = command[2];
    if (!target) return 'bun run command has no target';
    if (target.includes('/') || /\.(?:ts|mjs|js|sh)$/.test(target)) {
      return existsSync(resolve(root, target))
        ? undefined
        : `dangling command path ${target}`;
    }
    return packageScripts[target] === undefined
      ? `missing package script ${target}`
      : undefined;
  }
  if (command[0] === 'bash') {
    const target = command[1];
    return target && existsSync(resolve(root, target))
      ? undefined
      : `dangling command path ${target ?? '<missing>'}`;
  }
  if (['git', 'flutter', 'dart', 'node', 'bunx'].includes(command[0]!)) {
    return undefined;
  }
  return `unsupported canonical command ${command.join(' ')}`;
}

export function validateVerificationGraph(
  graph: VerificationGraph,
  root: string,
): string[] {
  const errors: string[] = [];
  if (graph.schemaVersion !== 1) errors.push('unsupported schemaVersion');
  const packageJson = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  ) as { scripts?: Record<string, string> };
  const packageScripts = packageJson.scripts ?? {};

  const anchor = loadCompletenessAnchor(root);
  if (!anchor) {
    errors.push('verification completeness anchor is missing');
  } else {
    if (anchor.schemaVersion !== 4) {
      errors.push('verification completeness anchor has unsupported schemaVersion');
    }
    if (!/^[0-9a-f]{40}$/.test(anchor.acceptedBase)) {
      errors.push('verification completeness anchor has invalid accepted base');
    } else {
      const problem = acceptedBaseError(root, anchor.acceptedBase);
      if (problem) errors.push(`verification completeness anchor ${problem}`);
    }
    for (const [label, values] of [
      ['claim', anchor.requiredClaimIds],
      ['gate binding', anchor.requiredGateBindings.map((item) => item.id)],
      [
        'broker sub-suite binding',
        anchor.requiredBrokerSubSuiteBindings.map((item) => item.id),
      ],
    ] as const) {
      for (const duplicate of duplicateValues(values)) {
        errors.push(`verification completeness anchor duplicates ${label} ${duplicate}`);
      }
    }
    for (const binding of [
      ...anchor.requiredGateBindings,
      ...anchor.requiredBrokerSubSuiteBindings,
    ]) {
      if (!/^sha256:[0-9a-f]{64}$/.test(binding.fingerprint)) {
        errors.push(
          `verification completeness anchor has invalid binding fingerprint ${binding.id}`,
        );
      }
    }
  }

  const claimIds = new Set<string>();
  for (const claim of graph.claims) {
    if (!claim.id || !claim.description) errors.push('claim is missing id or description');
    if (claimIds.has(claim.id)) errors.push(`duplicate claim ${claim.id}`);
    claimIds.add(claim.id);
  }

  const gateIds = new Set<string>();
  const ownership = new Map<string, string[]>();
  for (const gate of graph.gates) {
    if (gateIds.has(gate.id)) errors.push(`duplicate gate ${gate.id}`);
    gateIds.add(gate.id);
    if (MILESTONE_NAME.test(JSON.stringify({
      id: gate.id,
      releaseDomain: gate.releaseDomain,
      command: gate.command,
      expectedArtifacts: gate.expectedArtifacts,
      sourceOwners: gate.sourceOwners,
    }))) {
      errors.push(`milestone-only release name in gate ${gate.id}`);
    }
    if (gate.claimIds.length === 0) {
      errors.push(`gate ${gate.id} owns no claim`);
    }
    for (const claimId of gate.claimIds) {
      const owners = ownership.get(claimId) ?? [];
      owners.push(gate.id);
      ownership.set(claimId, owners);
      if (!claimIds.has(claimId)) {
        errors.push(`gate ${gate.id} owns undeclared claim ${claimId}`);
      }
    }
    if (gate.expectedArtifacts.length === 0) {
      errors.push(`gate ${gate.id} has no expected artifact`);
    }
    for (const artifact of gate.expectedArtifacts) {
      if (!artifact.path || !artifact.kind) {
        errors.push(`gate ${gate.id} has an invalid expected artifact`);
      }
    }
    const commandProblem = commandError(gate.command, root, packageScripts);
    if (commandProblem) errors.push(`gate ${gate.id}: ${commandProblem}`);
    for (const diagnostic of gate.focusedDiagnostics) {
      const problem = commandError(diagnostic, root, packageScripts);
      if (problem) errors.push(`gate ${gate.id} diagnostic: ${problem}`);
    }
    for (const owner of gate.sourceOwners) {
      if (!existsSync(resolve(root, owner))) {
        errors.push(`gate ${gate.id} has missing source owner ${owner}`);
      }
    }
  }

  for (const claimId of claimIds) {
    const owners = ownership.get(claimId) ?? [];
    if (owners.length === 0) errors.push(`claim ${claimId} has no owner`);
    if (owners.length > 1) {
      errors.push(`claim ${claimId} has duplicate owners: ${owners.join(', ')}`);
    }
  }
  if (anchor) {
    for (const claimId of anchor.requiredClaimIds) {
      if (!claimIds.has(claimId)) {
        errors.push(`verification completeness anchor is missing claim ${claimId}`);
      }
    }
    for (const binding of anchor.requiredGateBindings) {
      const gate = graph.gates.find((item) => item.id === binding.id);
      if (!gate) {
        errors.push(`verification completeness anchor is missing gate ${binding.id}`);
        continue;
      }
      const fingerprint = verificationBindingFingerprint({
        command: gate.command,
        sourceOwners: gate.sourceOwners,
        workingDirectory: gate.cwd,
        claimIds: gate.claimIds,
        requirement: gate.requirement ?? 'required',
        advisoryBaseline: gate.advisoryBaseline,
        expectedArtifacts: gate.expectedArtifacts,
      }, packageScripts);
      if (fingerprint !== binding.fingerprint) {
        errors.push(
          `verification completeness anchor binding mismatch for gate ${binding.id}`,
        );
      }
    }
  }

  const declaredExclusions = new Set(graph.exclusions.map((item) => item.id));
  for (const profile of Object.values(graph.profiles)) {
    for (const exclusion of profile.exclusions) {
      if (!declaredExclusions.has(exclusion)) {
        errors.push(`profile has undeclared exclusion ${exclusion}`);
      }
    }
    if (profile.expectedArtifacts.length === 0) {
      errors.push('profile has no expected artifacts');
    }
  }
  for (const gate of graph.gates) {
    for (const exclusion of gate.platformExclusions) {
      if (!declaredExclusions.has(exclusion)) {
        errors.push(`gate ${gate.id} has undeclared exclusion ${exclusion}`);
      }
    }
  }

  const gateById = new Map(graph.gates.map((gate) => [gate.id, gate]));
  for (const cycle of dependencyCycles(
    [...gateIds],
    (id) => gateById.get(id)?.dependencies.filter((item) => gateIds.has(item))
      ?? [],
  )) {
    errors.push(`gate dependency cycle: ${cycle}`);
  }

  const profileIds = Object.keys(graph.profiles);
  for (const [profileId, profile] of Object.entries(graph.profiles)) {
    for (const dependency of profile.dependencies ?? []) {
      if (!profileIds.includes(dependency)) {
        errors.push(`profile ${profileId} has missing dependency ${dependency}`);
      }
    }
  }
  for (const cycle of dependencyCycles(
    profileIds,
    (id) => graph.profiles[id as keyof typeof graph.profiles].dependencies ?? [],
  )) {
    errors.push(`profile dependency cycle: ${cycle}`);
  }

  for (const [profileId, profile] of Object.entries(graph.profiles)) {
    const scheduled = new Set(
      profile.executionGroups.flatMap((groupId) =>
        graph.executionGroups.find((group) => group.id === groupId)?.gates ?? []
      ),
    );
    for (const gateId of scheduled) {
      const gate = gateById.get(gateId);
      if (!gate) continue;
      for (const dependency of gate.dependencies) {
        if (gateIds.has(dependency) && !scheduled.has(dependency)) {
          errors.push(
            `profile ${profileId} schedules ${gateId} without gate dependency ${dependency}`,
          );
        }
        if (
          profileIds.includes(dependency)
          && !(profile.dependencies ?? []).includes(dependency)
        ) {
          errors.push(
            `profile ${profileId} schedules ${gateId} without profile dependency ${dependency}`,
          );
        }
      }
    }
  }
  for (const exclusion of graph.exclusions) {
    if (exclusion.owners.length === 0) {
      errors.push(`exclusion ${exclusion.id} has no source owner`);
    }
    for (const owner of exclusion.owners) {
      if (!existsSync(resolve(root, owner))) {
        errors.push(`exclusion ${exclusion.id} has missing owner ${owner}`);
      }
    }
  }

  const groupIds = new Set<string>();
  const groupedGates = new Map<string, string[]>();
  for (const group of graph.executionGroups) {
    if (groupIds.has(group.id)) errors.push(`duplicate execution group ${group.id}`);
    groupIds.add(group.id);
    if (group.resourceClass === 'heavyweight' && group.mode !== 'serial') {
      errors.push(`heavyweight group ${group.id} must be serial`);
    }
    for (const gateId of group.gates) {
      if (!gateIds.has(gateId)) errors.push(`group ${group.id} has missing gate ${gateId}`);
      const owners = groupedGates.get(gateId) ?? [];
      owners.push(group.id);
      groupedGates.set(gateId, owners);
    }
  }
  for (const [profileId, profile] of Object.entries(graph.profiles)) {
    for (const groupId of profile.executionGroups) {
      if (!groupIds.has(groupId)) {
        errors.push(`profile ${profileId} has missing group ${groupId}`);
      }
    }
  }
  for (const gate of graph.gates) {
    const groups = groupedGates.get(gate.id) ?? [];
    if (groups.length === 0) errors.push(`gate ${gate.id} is not scheduled`);
    if (groups.length > 1) errors.push(`gate ${gate.id} is scheduled more than once`);
    if (gate.resourceClass === 'heavyweight') {
      const group = graph.executionGroups.find((item) => item.id === groups[0]);
      if (!group || group.resourceClass !== 'heavyweight' || group.mode !== 'serial') {
        errors.push(`heavyweight gate ${gate.id} must be in one heavyweight serial group`);
      }
    }
  }

  const releaseOwnerPaths = new Set<string>();
  for (const gate of graph.gates) {
    for (const owner of gate.sourceOwners) releaseOwnerPaths.add(owner);
    for (const suite of gate.subSuites ?? []) {
      for (const owner of suite.sourceOwners) releaseOwnerPaths.add(owner);
    }
  }
  for (const owner of releaseOwnerPaths) {
    const absolute = resolve(root, owner);
    if (!existsSync(absolute) || !lstatSync(absolute).isFile()) continue;
    if (MILESTONE_NAME.test(readFileSync(absolute, 'utf8'))) {
      errors.push(`milestone-only release name in source owner ${owner}`);
    }
  }

  for (const gate of graph.gates) {
    if (!gate.subSuites || !gate.subSuiteGroups) continue;
    const subSuiteIds = new Set(gate.subSuites.map((suite) => suite.id));
    const grouped = new Map<string, string[]>();
    for (const group of gate.subSuiteGroups) {
      if (group.resourceClass === 'heavyweight' && group.mode !== 'serial') {
        errors.push(`heavyweight sub-suite group ${group.id} must be serial`);
      }
      for (const id of group.subSuites) {
        if (!subSuiteIds.has(id)) {
          errors.push(`sub-suite group ${group.id} has missing suite ${id}`);
        }
        const owners = grouped.get(id) ?? [];
        owners.push(group.id);
        grouped.set(id, owners);
      }
    }
    for (const suite of gate.subSuites) {
      if (!gate.claimIds.includes(suite.claimId)) {
        errors.push(`sub-suite ${suite.id} claim ${suite.claimId} is not owned by ${gate.id}`);
      }
      const groups = grouped.get(suite.id) ?? [];
      if (groups.length !== 1) {
        errors.push(`sub-suite ${suite.id} must be scheduled exactly once`);
      }
      const problem = commandError(suite.command, root, packageScripts);
      if (problem) errors.push(`sub-suite ${suite.id}: ${problem}`);
      for (const owner of suite.sourceOwners) {
        if (!existsSync(resolve(root, owner))) {
          errors.push(`sub-suite ${suite.id} has missing source owner ${owner}`);
        }
      }
    }
    const supplyGroup = gate.subSuiteGroups.find((group) =>
      group.subSuites.includes('release-supply-chain')
    );
    if (
      !supplyGroup
      || supplyGroup.resourceClass !== 'heavyweight'
      || supplyGroup.mode !== 'serial'
    ) {
      errors.push('release-supply-chain must be in a heavyweight serial group');
    }
  }

  if (anchor) {
    const brokerGate = graph.gates.find((gate) =>
      gate.id === 'broker-deterministic'
    );
    const brokerSubSuites = new Map(
      brokerGate?.subSuites?.map((suite) => [suite.id, suite]) ?? [],
    );
    for (const binding of anchor.requiredBrokerSubSuiteBindings) {
      const suite = brokerSubSuites.get(binding.id);
      if (!suite) {
        errors.push(
          `verification completeness anchor is missing broker sub-suite ${binding.id}`,
        );
        continue;
      }
      const fingerprint = verificationBindingFingerprint({
        command: suite.command,
        sourceOwners: suite.sourceOwners,
        claimIds: [suite.claimId],
      }, packageScripts);
      if (fingerprint !== binding.fingerprint) {
        errors.push(
          `verification completeness anchor binding mismatch for broker sub-suite ${binding.id}`,
        );
      }
    }
  }

  for (const gate of graph.gates) {
    for (const dependency of gate.dependencies) {
      if (!gateIds.has(dependency) && !(dependency in graph.profiles)) {
        errors.push(`gate ${gate.id} has missing dependency ${dependency}`);
      }
    }
  }
  return errors.sort();
}

const ISOLATED_BROKER_FIXTURES = [
  'scripts/broker/tests/pi/test-tool-result-enrich.ts',
  'scripts/broker/tests/pi/test-pi-bridge-reload.ts',
  'scripts/broker/tests/claude/test-claude-hooks.ts',
  'scripts/broker/tests/claude/test-claude-hooks-surface.ts',
];

export function validateFixtureIsolationSources(
  root: string,
  sourceOverrides: Record<string, string> = {},
): string[] {
  const errors: string[] = [];
  for (const path of ISOLATED_BROKER_FIXTURES) {
    const source = sourceOverrides[path]
      ?? readFileSync(resolve(root, path), 'utf8');
    if (!source.includes('isolatedBrokerFixtureEnvironment')) {
      errors.push(`${path} does not construct an isolated broker environment`);
    }
    if (/env:\s*\{\s*\.\.\.process\.env/.test(source)) {
      errors.push(`${path} passes the host environment directly to a broker`);
    }
  }
  const toolResultPath =
    'scripts/broker/tests/pi/test-tool-result-enrich.ts';
  const toolResult = sourceOverrides[toolResultPath]
    ?? readFileSync(resolve(root, toolResultPath), 'utf8');
  if (!toolResult.includes('freshModuleSpecifier')) {
    errors.push(`${toolResultPath} does not bypass the Pi text-module cache`);
  }
  return errors.sort();
}

export function gatesForProfile(
  graph: VerificationGraph,
  profile: keyof VerificationGraph['profiles'],
): VerificationGate[] {
  const byId = new Map(graph.gates.map((gate) => [gate.id, gate]));
  const declared = graph.profiles[profile].executionGroups.flatMap((groupId) => {
    const group = graph.executionGroups.find((item) => item.id === groupId);
    if (!group) throw new Error(`missing execution group ${groupId}`);
    return group.gates.map((gateId) => {
      const gate = byId.get(gateId);
      if (!gate) throw new Error(`missing gate ${gateId}`);
      return gate;
    });
  });
  const originalIndex = new Map(
    declared.map((gate, index) => [gate.id, index]),
  );
  const scheduledIds = new Set(declared.map((gate) => gate.id));
  const remainingDependencies = new Map(
    declared.map((gate) => [
      gate.id,
      new Set(gate.dependencies.filter((id) => scheduledIds.has(id))),
    ]),
  );
  const ready = declared
    .filter((gate) => remainingDependencies.get(gate.id)!.size === 0)
    .map((gate) => gate.id);
  const ordered: VerificationGate[] = [];
  while (ready.length > 0) {
    ready.sort((left, right) =>
      originalIndex.get(left)! - originalIndex.get(right)!
    );
    const id = ready.shift()!;
    ordered.push(byId.get(id)!);
    for (const gate of declared) {
      const dependencies = remainingDependencies.get(gate.id)!;
      if (!dependencies.delete(id) || dependencies.size !== 0) continue;
      if (!ordered.some((item) => item.id === gate.id)) ready.push(gate.id);
    }
  }
  if (ordered.length !== declared.length) {
    const blocked = declared
      .filter((gate) => !ordered.some((item) => item.id === gate.id))
      .map((gate) => gate.id);
    throw new Error(`gate dependency cycle blocks ${blocked.join(', ')}`);
  }
  return ordered;
}
