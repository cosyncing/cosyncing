import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, type SpawnSyncReturns } from 'node:child_process';

const ROOT = join(import.meta.dir, '..', '..', '..', '..', '..');
let failed = 0;

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) console.log(`PASS ${name}`);
  else {
    failed++;
    console.error(`FAIL ${name}${detail ? ` - ${detail}` : ''}`);
  }
}

function run(args: string[]): SpawnSyncReturns<string> {
  return spawnSync('bun', args, { cwd: ROOT, encoding: 'utf8', timeout: 15_000 }) as SpawnSyncReturns<string>;
}

const outDir = mkdtempSync(join(tmpdir(), 'cosyncing-capabilities-'));
try {
  mkdirSync(join(outDir, 'cards'), { recursive: true });
  writeFileSync(join(outDir, 'cards', 'opencode.server.session.rename.md'), 'stale closed rename card');
  const result = run(['run', 'scripts/broker/capabilities/check.ts', '--agent', 'opencode', '--mode', 'fixture', '--write-output', outDir]);
  check('fixture command exits successfully', result.status === 0, result.stderr || result.stdout);

  const jsonPath = join(outDir, 'gap-report.json');
  const mdPath = join(outDir, 'gap-report.md');
  const cardPath = join(outDir, 'cards', 'opencode.server.session.rename.md');
  const expectedOpenCardIds = [
    'opencode.server.session.timeline',
  ];
  check('writes gap-report.json', existsSync(jsonPath));
  check('writes gap-report.md', existsSync(mdPath));
  check('does not regenerate rename card after capability is mapped', !existsSync(cardPath));

  if (existsSync(jsonPath)) {
    const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
    const openIds = new Set((report.openGaps ?? []).map((g: any) => g.id));
    const blockedNative = new Set((report.blocked ?? []).map((g: any) => g.nativeId));
    check('rename gap is closed', !openIds.has('opencode.server.session.rename'));
    check('fork gap is closed', !openIds.has('opencode.server.session.fork'));
    check('export gap is closed by Slice 6 transcriptExport evidence', !openIds.has('opencode.cli.export'));
    check('model variants gap is closed', !openIds.has('opencode.server.model.variants'));
    check('timeline gap is present', openIds.has('opencode.server.session.timeline'));
    check(
      'every open OpenCode gap has a deterministic card path',
      (report.openGaps ?? []).every((g: any) => g.cardPath === `cards/${g.id}.md`),
      JSON.stringify((report.openGaps ?? []).map((g: any) => ({ id: g.id, cardPath: g.cardPath }))),
    );
    check('connect reviewed exclusion is present', blockedNative.has('opencode:tui:/connect'));
    check('delete reviewed exclusion is present', blockedNative.has('opencode:server:DELETE:/session/{sessionID}'));
    check(
      'reviewed exclusions use reviewed-exclusion reason',
      (report.blocked ?? []).every((g: any) => g.reason === 'reviewed-exclusion'),
      JSON.stringify(report.blocked ?? []),
    );
    check(
      'report sourceLock uses actual path provenance',
      report.sourceLock === 'scripts/broker/capabilities/fixtures/opencode/source-lock.seed.json',
      String(report.sourceLock),
    );
    check('gap report reflects Slice 6 export closure (timeline open, delete/connect blocked)', (report.openGaps ?? []).length === 1 && (report.blocked ?? []).length === 2, JSON.stringify({ open: [...openIds], blocked: [...blockedNative] }));
  }

  for (const id of expectedOpenCardIds) {
    const path = join(outDir, 'cards', `${id}.md`);
    check(`writes generic card for ${id}`, existsSync(path));
    if (existsSync(path)) {
      const card = readFileSync(path, 'utf8');
      check(
        `generic card for ${id} includes review constraints`,
        card.includes('## Review lane') && card.includes('Do not implement productize-after-review gaps before maintainer review.'),
        card,
      );
      if (id === 'opencode.server.session.timeline') {
        check(
          'timeline card records L3 semantics research prerequisite',
          card.includes('L3') &&
            card.includes('timeline vs undo/redo') &&
            card.includes('server-vs-TUI divergence'),
          card,
        );
      }
    }
  }
  for (const id of ['opencode.server.session.fork', 'opencode.server.model.variants', 'opencode.cli.export']) {
    check(`does not regenerate closed card for ${id}`, !existsSync(join(outDir, 'cards', `${id}.md`)));
  }

  if (existsSync(mdPath)) {
    const md = readFileSync(mdPath, 'utf8');
    check('markdown report names OpenCode fixture snapshot', md.includes('# Capability gaps: OpenCode fixture snapshot'));
    check('markdown report shows blocked section', md.includes('Deliberately blocked in this snapshot'));
  }

  const seedPath = join(ROOT, 'scripts/broker/capabilities/fixtures/opencode/discovered.seed.json');
  if (existsSync(seedPath)) {
    const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
    const manifest = JSON.parse(readFileSync(join(ROOT, 'scripts/broker/capabilities/manifests/opencode.adapter-support.json'), 'utf8'));
    const manifestIds = new Set((manifest.capabilities ?? []).map((c: any) => c.id));
    const mappedSeedRows = (seed.capabilities ?? []).filter((c: any) => c.mappedStatus === 'mapped' || c.mappedStatus === 'partial');
    const notApplicableSeedRows = (seed.capabilities ?? []).filter((c: any) => c.mappedStatus === 'not-applicable');
    const renameSeed = (seed.capabilities ?? []).find((c: any) => c.id === 'opencode.server.session.rename');
    const forkSeed = (seed.capabilities ?? []).find((c: any) => c.id === 'opencode.server.session.fork');
    const variantsSeed = (seed.capabilities ?? []).find((c: any) => c.id === 'opencode.server.model.variants');
    check('seed covers full reviewed OpenCode surface', (seed.capabilities ?? []).length >= 19, `count=${(seed.capabilities ?? []).length}`);
    check(
      'every mapped seed row is manifest-backed',
      mappedSeedRows.every((c: any) => manifestIds.has(c.id)),
      JSON.stringify(mappedSeedRows.filter((c: any) => !manifestIds.has(c.id)).map((c: any) => c.id)),
    );
    check(
      'every not-applicable seed row is manifest-backed',
      notApplicableSeedRows.every((c: any) => manifestIds.has(c.id)),
      JSON.stringify(notApplicableSeedRows.filter((c: any) => !manifestIds.has(c.id)).map((c: any) => c.id)),
    );
    check(
      'rename seed row is mapped after native implementation evidence',
      renameSeed?.mappedStatus === 'mapped' &&
        renameSeed?.productStatus === 'productize-now' &&
        renameSeed?.riskClass === 'R1' &&
        renameSeed?.reviewRequired === false,
      JSON.stringify(renameSeed),
    );
    check(
      'fork seed row is mapped with honest command-surface evidence (D,L0 — no L1 button)',
      forkSeed?.mappedStatus === 'mapped' &&
        forkSeed?.productStatus === 'productize-after-review' &&
        forkSeed?.riskClass === 'R1' &&
        forkSeed?.appSurface === 'command' &&
        forkSeed?.evidenceRequired?.join(',') === 'D,L0',
      JSON.stringify(forkSeed),
    );
    const exportSeed = (seed.capabilities ?? []).find((c: any) => c.id === 'opencode.cli.export');
    check(
      'export seed row is mapped as a command-surface R2 transcriptExport after L0+L1 evidence',
      exportSeed?.mappedStatus === 'mapped' &&
        exportSeed?.riskClass === 'R2' &&
        exportSeed?.appSurface === 'command' &&
        exportSeed?.evidenceRequired?.join(',') === 'D,L0,L1',
      JSON.stringify(exportSeed),
    );
    check(
      'model variants seed row is mapped after existing variant picker evidence',
      variantsSeed?.mappedStatus === 'mapped' &&
        variantsSeed?.productStatus === 'productize-after-review' &&
        variantsSeed?.riskClass === 'R1',
      JSON.stringify(variantsSeed),
    );

    const badFixture = join(outDir, 'bad-duplicate.json');
    const fixture = JSON.parse(readFileSync(seedPath, 'utf8'));
    fixture.capabilities.push(fixture.capabilities[0]);
    writeFileSync(badFixture, JSON.stringify(fixture, null, 2));
    const bad = run(['run', 'scripts/broker/capabilities/check.ts', '--agent', 'opencode', '--mode', 'fixture', '--fixture', badFixture, '--write-output', join(outDir, 'bad')]);
    check('duplicate capability ids fail validation', bad.status !== 0 && /duplicate capability id/.test(bad.stderr + bad.stdout), bad.stderr || bad.stdout);

    const mappedNoManifest = join(outDir, 'bad-mapped-no-manifest.json');
    const mappedFixture = JSON.parse(readFileSync(seedPath, 'utf8'));
    // timeline is still an unmapped open gap with no adapter-manifest entry — a seed self-declaring it
    // `mapped` must fail validation (Slice 2 finding). export can no longer serve as this example: it is
    // now legitimately mapped + manifest-backed after Slice 6.
    const mappedGap = mappedFixture.capabilities.find((c: any) => c.id === 'opencode.server.session.timeline');
    mappedGap.mappedStatus = 'mapped';
    writeFileSync(mappedNoManifest, JSON.stringify(mappedFixture, null, 2));
    const mappedBad = run([
      'run',
      'scripts/broker/capabilities/check.ts',
      '--agent',
      'opencode',
      '--mode',
      'fixture',
      '--fixture',
      mappedNoManifest,
      '--write-output',
      join(outDir, 'mapped-bad'),
    ]);
    check(
      'seed claiming mapped without manifest fails validation',
      mappedBad.status !== 0 && /claims mapped but has no adapter manifest entry/.test(mappedBad.stderr + mappedBad.stdout),
      mappedBad.stderr || mappedBad.stdout,
    );

    const notApplicableNoManifest = join(outDir, 'bad-not-applicable-no-manifest.json');
    const notApplicableManifest = join(outDir, 'empty-not-applicable-manifest.json');
    const notApplicablePolicy = join(outDir, 'empty-not-applicable-policy.json');
    const notApplicableFixture = JSON.parse(readFileSync(seedPath, 'utf8'));
    notApplicableFixture.capabilities = notApplicableFixture.capabilities.filter((c: any) => c.id === 'opencode.server.global.health');
    writeFileSync(notApplicableNoManifest, JSON.stringify(notApplicableFixture, null, 2));
    writeFileSync(notApplicableManifest, JSON.stringify({ schemaVersion: 1, agent: 'opencode', version: '1.16.2', capabilities: [] }, null, 2));
    writeFileSync(notApplicablePolicy, JSON.stringify({ schemaVersion: 1, policies: [] }, null, 2));
    const notApplicableBad = run([
      'run',
      'scripts/broker/capabilities/check.ts',
      '--agent',
      'opencode',
      '--mode',
      'fixture',
      '--fixture',
      notApplicableNoManifest,
      '--manifest',
      notApplicableManifest,
      '--policy',
      notApplicablePolicy,
      '--write-output',
      join(outDir, 'not-applicable-bad'),
    ]);
    check(
      'seed claiming not-applicable without manifest fails validation',
      notApplicableBad.status !== 0 && /claims not-applicable but has no adapter manifest entry/.test(notApplicableBad.stderr + notApplicableBad.stdout),
      notApplicableBad.stderr || notApplicableBad.stdout,
    );

    const manifestShortfall = join(outDir, 'manifest-shortfall.json');
    const emptyPolicy = join(outDir, 'empty-policy.json');
    const shortfallOut = join(outDir, 'shortfall');
    const shortfallFixture = JSON.parse(readFileSync(seedPath, 'utf8'));
    shortfallFixture.capabilities = shortfallFixture.capabilities.filter((c: any) => c.id === 'opencode.server.session.rename');
    const shortfallRename = shortfallFixture.capabilities.find((c: any) => c.id === 'opencode.server.session.rename');
    shortfallRename.mappedStatus = 'mapped';
    writeFileSync(join(outDir, 'shortfall-fixture.json'), JSON.stringify(shortfallFixture, null, 2));
    writeFileSync(
      manifestShortfall,
      JSON.stringify({
        schemaVersion: 1,
        agent: 'opencode',
        version: '1.16.2',
        capabilities: [
          {
            schemaVersion: 1,
            id: 'opencode.server.session.rename',
            nativeId: 'opencode:server:PATCH:/session/{sessionID}',
            agent: 'opencode',
            version: '1.16.2',
            mappedStatus: 'mapped',
            evidencePresent: ['D'],
            adapterRefs: ['packages/typescript/adapters/opencode/src/implementation.ts (renameSession)'],
          },
        ],
      }, null, 2),
    );
    writeFileSync(emptyPolicy, JSON.stringify({ schemaVersion: 1, policies: [] }, null, 2));
    const shortfall = run([
      'run',
      'scripts/broker/capabilities/check.ts',
      '--agent',
      'opencode',
      '--mode',
      'fixture',
      '--fixture',
      join(outDir, 'shortfall-fixture.json'),
      '--manifest',
      manifestShortfall,
      '--policy',
      emptyPolicy,
      '--write-output',
      shortfallOut,
    ]);
    const shortfallReport = existsSync(join(shortfallOut, 'gap-report.json'))
      ? JSON.parse(readFileSync(join(shortfallOut, 'gap-report.json'), 'utf8'))
      : undefined;
    check(
      'mapped manifest with missing evidence emits mapped-missing-evidence gap',
      shortfall.status === 0 &&
        !!shortfallReport?.openGaps?.some((g: any) => g.id === 'opencode.server.session.rename' && g.reason === 'mapped-missing-evidence'),
      shortfall.stderr || shortfall.stdout,
    );

    const customLock = join(outDir, 'custom-source-lock.json');
    writeFileSync(
      customLock,
      JSON.stringify({
        schemaVersion: 1,
        agent: 'opencode',
        version: '1.16.2',
        captured_at: '2026-07-02T00:00:00.000Z',
        sources: [
          {
            id: 'opencode-openapi-1.16.2',
            source_url: 'fixture',
            checksum: 'a'.repeat(64),
            trust_level: 'reviewed-seed',
          },
          {
            id: 'opencode-cli-docs-2026-07-01',
            source_url: 'fixture',
            checksum: 'b'.repeat(64),
            trust_level: 'reviewed-seed',
          },
          {
            id: 'opencode-tui-docs-2026-07-01',
            source_url: 'fixture',
            checksum: 'c'.repeat(64),
            trust_level: 'reviewed-seed',
          },
        ],
      }, null, 2),
    );
    const customOut = join(outDir, 'custom-source-lock');
    const custom = run([
      'run',
      'scripts/broker/capabilities/check.ts',
      '--agent',
      'opencode',
      '--mode',
      'fixture',
      '--source-lock',
      customLock,
      '--write-output',
      customOut,
    ]);
    const customReport = existsSync(join(customOut, 'gap-report.json'))
      ? JSON.parse(readFileSync(join(customOut, 'gap-report.json'), 'utf8'))
      : undefined;
    check(
      'custom source-lock path is preserved in report provenance',
      custom.status === 0 && customReport?.sourceLock === customLock,
      custom.stderr || custom.stdout || JSON.stringify(customReport),
    );
  } else {
    check('seed fixture exists for duplicate validation', false, seedPath);
  }

  const liveFixture = join(outDir, 'live-capture-fixture.json');
  writeFileSync(liveFixture, JSON.stringify({
    '/global/health': { version: '1.16.2' },
    '/doc': { openapi: '3.1.0', paths: {} },
    '/command': [],
    '/agent': [],
    '/provider': [],
  }, null, 2));
  const liveOut = join(outDir, 'live-capture');
  const live = run(['run', 'scripts/broker/capabilities/collect-opencode-live.ts', '--fixture', liveFixture, '--out', join(liveOut, 'raw')]);
  const lockPath = join(liveOut, 'source-lock.json');
  const lock = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : undefined;
  check(
    'live collector writes checksummed source-lock',
    live.status === 0 &&
      lock?.version === '1.16.2' &&
      Array.isArray(lock.sources) &&
      lock.sources.length >= 5 &&
      lock.sources.every((s: any) => typeof s.checksum === 'string' && /^[a-f0-9]{64}$/.test(s.checksum)),
    live.stderr || live.stdout || JSON.stringify(lock),
  );
  check(
    'fixture collector source-lock uses reviewed-seed trust',
    Array.isArray(lock?.sources) && lock.sources.every((s: any) => s.trust_level === 'reviewed-seed'),
    JSON.stringify(lock?.sources),
  );

  const driftOut = join(outDir, 'drift');
  const drift = run([
    'run',
    'scripts/broker/capabilities/check-discovery-drift.ts',
    '--agent',
    'opencode',
    '--openapi',
    'scripts/broker/capabilities/fixtures/opencode/openapi.synthetic-drift.json',
    '--write-output',
    driftOut,
  ]);
  const driftReport = existsSync(join(driftOut, 'discovery-drift.json'))
    ? JSON.parse(readFileSync(join(driftOut, 'discovery-drift.json'), 'utf8'))
    : undefined;
  check(
    'discovery drift detects synthetic new endpoint and exits report-only',
    drift.status === 0 &&
      !!driftReport?.sourceDrift?.some((d: any) => d.nativeId === 'opencode:server:POST:/synthetic/new-endpoint' && d.change === 'added'),
    drift.stderr || drift.stdout || JSON.stringify(driftReport),
  );

  const piOut = join(outDir, 'pi-fixture');
  const pi = run(['run', 'scripts/broker/capabilities/check.ts', '--agent', 'pi', '--mode', 'fixture', '--write-output', piOut]);
  const piReport = existsSync(join(piOut, 'gap-report.json'))
    ? JSON.parse(readFileSync(join(piOut, 'gap-report.json'), 'utf8'))
    : undefined;
  const piOpenIds = new Set((piReport?.openGaps ?? []).map((g: any) => g.id));
  const piBlockedIds = new Set((piReport?.blocked ?? []).map((g: any) => g.id));
  check('Pi fixture command exits successfully', pi.status === 0 && !!piReport, pi.stderr || pi.stdout);
  check('Pi rename gap is closed by generic hook evidence', !piOpenIds.has('pi.rpc.set_session_name'), JSON.stringify(piReport?.openGaps ?? []));
  check('Pi stats gap is closed by native stats evidence', !piOpenIds.has('pi.rpc.get_session_stats'), JSON.stringify(piReport?.openGaps ?? []));
  check('Pi fork gap is closed by native fork evidence', !piOpenIds.has('pi.rpc.fork'), JSON.stringify(piReport?.openGaps ?? []));
  check('Pi clone gap is closed by distinct native clone evidence', !piOpenIds.has('pi.rpc.clone'), JSON.stringify(piReport?.openGaps ?? []));
  check('Pi import surface is blocked by reviewed unsafe policy', piBlockedIds.has('pi.rpc.import'), JSON.stringify(piReport?.blocked ?? []));
  check('Pi switch_session is blocked by reviewed not-productized policy', piBlockedIds.has('pi.rpc.switch_session'), JSON.stringify(piReport?.blocked ?? []));
  check('Pi export_html gap is closed by Slice 6 transcriptExport evidence', !piOpenIds.has('pi.rpc.export_html'), JSON.stringify(piReport?.openGaps ?? []));
  check(
    'Pi report has no open gaps after Slice 6 (import + switch_session blocked)',
    piOpenIds.size === 0 && piBlockedIds.size === 2 && !existsSync(join(piOut, 'cards', 'pi.rpc.export_html.md')),
    JSON.stringify({ open: [...piOpenIds], blocked: [...piBlockedIds] }),
  );

  const piDriftOut = join(outDir, 'pi-drift');
  const piDrift = run([
    'run',
    'scripts/broker/capabilities/check-discovery-drift.ts',
    '--agent',
    'pi',
    '--rpc-types',
    'scripts/broker/capabilities/fixtures/pi/rpc-types.synthetic-drift.d.ts',
    '--write-output',
    piDriftOut,
  ]);
  const piDriftReport = existsSync(join(piDriftOut, 'discovery-drift.json'))
    ? JSON.parse(readFileSync(join(piDriftOut, 'discovery-drift.json'), 'utf8'))
    : undefined;
  check(
    'Pi discovery drift detects synthetic RpcCommand and exits report-only',
    piDrift.status === 0 &&
      !!piDriftReport?.sourceDrift?.some((d: any) => d.nativeId === 'pi:rpc:synthetic_new_command' && d.change === 'added'),
    piDrift.stderr || piDrift.stdout || JSON.stringify(piDriftReport),
  );

  const branchOut = join(outDir, 'tool-branches');
  const branch = run(['run', 'scripts/broker/capabilities/check-no-tool-branches.ts', '--write-output', branchOut]);
  const branchReport = existsSync(join(branchOut, 'tool-branches.json'))
    ? JSON.parse(readFileSync(join(branchOut, 'tool-branches.json'), 'utf8'))
    : undefined;
  const branchFindings = branchReport?.findings ?? [];
  const appFindings = branchFindings.filter((f: any) => String(f.file).startsWith('apps/poc-ui/'));
  const brokerFindings = branchFindings.filter((f: any) => String(f.file).startsWith('packages/typescript/broker/'));
  check(
    'tool branch checker exits report-only and writes report',
    branch.status === 0 && !!branchReport,
    branch.stderr || branch.stdout,
  );
  check(
    'tool branch checker keeps app baseline clean',
    appFindings.length === 0,
    JSON.stringify(appFindings),
  );
  const reviewedBrokerBranches = brokerFindings.map((finding: any) =>
    `${finding.file}:${finding.expression}`,
  );
  // Every entry is a reviewed per-agent branch: each one selects agent-specific *presentation or
  // setup plumbing* keyed to a surface only that agent has, and none of them decides a tool
  // capability. Capability answers stay adapter-hook-derived (see the canTranscriptExport comment
  // in runtime.ts). Adding a line here means that review was done; a new finding fails this test.
  //   runtime.ts b.id === 'codex'      /api/agents attaches `syncEnabled` only for Codex, the one
  //                                    agent with a persisted enable; the capability fields above it
  //                                    are unbranched. Absent field != disabled for the others.
  //   setup.ts  id === 'pi'            reads the Pi-only Node-runtime readiness check; it changes
  //                                    setup presentation, not a capability answer.
  //   setup.ts  id === 'codex'         reads the `codex.standalone-install` doctor check, which no
  //                                    other agent emits; only adds a managedRuntimeWarning.
  //   setup.ts  id === 'claude'        display-name fallback when the version matrix has no row.
  //   setup.ts  behavior[id]           per-agent managed-behavior prose, one entry per agent.
  //   setup.ts  agent.id === 'pi'      (x3) Pi bridge blocker + install step + known-legacy migration
  //                                    prompt; all require Pi to be `supported` and gate only its bridge file.
  //   setup.ts  agent.id === 'codex'   records `agents.codex` support in persisted setup state.
  const expectedBrokerBranches = [
    "packages/typescript/broker/src/installation/setup.ts:id === 'pi'",
    "packages/typescript/broker/src/installation/setup.ts:id === 'codex'",
    "packages/typescript/broker/src/installation/setup.ts:id === 'claude'",
    'packages/typescript/broker/src/installation/setup.ts:behavior[id]',
    "packages/typescript/broker/src/installation/setup.ts:agent.id === 'pi'",
    "packages/typescript/broker/src/installation/setup.ts:agent.id === 'codex'",
    "packages/typescript/broker/src/installation/setup.ts:agent.id === 'pi'",
    "packages/typescript/broker/src/installation/setup.ts:agent.id === 'pi'",
    "packages/typescript/broker/src/runtime/runtime.ts:b.id === 'codex'",
  ];
  check(
    'tool branch checker matches the reviewed broker setup/runtime baseline exactly',
    JSON.stringify(reviewedBrokerBranches) === JSON.stringify(expectedBrokerBranches),
    JSON.stringify(reviewedBrokerBranches),
  );

  const branchFixture = join(outDir, 'synthetic-tool-branches.ts');
  writeFileSync(
    branchFixture,
    [
      "const table = { claude: () => 1, codex: () => 2 };",
      "export function switches(tool: string) { switch (tool) { case 'codex': return 1; default: return 0; } }",
      "export function includes(tool: string) { return ['claude', 'codex'].includes(tool); }",
      "export function setHas(tool: string) { return new Set(['opencode', 'pi']).has(tool); }",
      "export function objectDispatch(tool: string) { return table[tool]?.(); }",
      "export function regex(tool: string) { return /^(claude|codex)$/.test(tool); }",
      '',
    ].join('\n'),
  );
  const syntheticBranchOut = join(outDir, 'tool-branches-synthetic');
  const syntheticBranch = run([
    'run',
    'scripts/broker/capabilities/check-no-tool-branches.ts',
    '--include',
    branchFixture,
    '--write-output',
    syntheticBranchOut,
  ]);
  const syntheticBranchReport = existsSync(join(syntheticBranchOut, 'tool-branches.json'))
    ? JSON.parse(readFileSync(join(syntheticBranchOut, 'tool-branches.json'), 'utf8'))
    : undefined;
  const syntheticExpressions = (syntheticBranchReport?.findings ?? []).map((f: any) => String(f.expression));
  check(
    'tool branch checker catches switch/includes/set/object/regex synthetic patterns',
    syntheticBranch.status === 0 &&
      syntheticExpressions.some((e: string) => e.includes("case 'codex'")) &&
      syntheticExpressions.some((e: string) => e.includes('.includes(tool)')) &&
      syntheticExpressions.some((e: string) => e.includes('.has(tool)')) &&
      syntheticExpressions.some((e: string) => e.includes('table[tool]')) &&
      syntheticExpressions.some((e: string) => e.includes('/^(claude|codex)$/')),
    syntheticBranch.stderr || syntheticBranch.stdout || JSON.stringify(syntheticExpressions),
  );

  const support = run(['run', 'scripts/broker/tests_traces/check-support-matrix-coverage.ts']);
  check(
    'support checker validates capability references',
    support.status === 0 && /capability references validated/.test(support.stdout + support.stderr),
    support.stderr || support.stdout,
  );
} finally {
  rmSync(outDir, { recursive: true, force: true });
}

if (failed) {
  console.error(`\nFAIL: ${failed} capability test(s) failed.`);
  process.exit(1);
}

console.log('\nPASS');
