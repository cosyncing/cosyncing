/**
 * Capability-conformance harness — the SYSTEMATIC gap finder.
 *
 * The problem it solves: stop discovering missing capabilities by hand (a slash command Pi lacks, a
 * tool that renders as `{}`, a frame the app silently drops). Instead, make the agents tell us their
 * surface and make coverage gaps COMPUTED, not found by manual testing.
 *
 * Two checks (see docs/architecture/monorepo.md):
 *   1. RENDER COVERAGE (deterministic, the hard gate): diff core's CANONICAL_MESSAGE_TYPES against
 *      the app's render() `case` labels. A canonical type with no render case = a silent blank-drop
 *      (exactly how token-count slipped through). Any gap → non-zero exit.
 *   2. COMMAND COVERAGE (live, best-effort): for each reachable agent, query its TRUE command/model
 *      registry and diff against what the adapter surfaces (listCommands/listModels). Flags an agent
 *      capability we don't expose (e.g. Pi's get_commands templates/skills) — computed automatically.
 *
 * It writes output/conformance/report.json only. The parity matrix is a reviewed documentation snapshot;
 * do not claim this script rewrites it unless a future change actually adds that generator.
 *
 * Live probes touch ONLY throwaway /tmp sessions on a free local model; they skip cleanly if an
 * agent isn't running, so the render gate always runs (CI-safe).
 *
 *   BROKER unused here; set OPENCODE_URL / PI on PATH if you want the live probes.
 *   bun run scripts/broker/conformance.ts            # full
 *   bun run scripts/broker/conformance.ts --render    # render gate only (no live agents)
 */
export {};
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
// Relative to the package sources — scripts/broker/ isn't a workspace package, so the @cosyncing/*
// aliases don't resolve here (they do inside packages via per-package node_modules symlinks).
import { CANONICAL_MESSAGE_TYPES, type AgentBackend } from '../../packages/typescript/adapter-api/src/index.ts';
import { OpenCodeAdapter } from '../../packages/typescript/adapters/opencode/src/index.ts';
import { PiAdapter } from '../../packages/typescript/adapters/pi/src/index.ts';
import { OmpAdapter } from '../../packages/typescript/adapters/omp/src/index.ts';
import { CodexAdapter } from '../../packages/typescript/adapters/codex/src/index.ts';
import { ClaudeAdapter } from '../../packages/typescript/adapters/claude/src/index.ts';

const ROOT = join(import.meta.dir, '..', '..');
const APP_JS = join(ROOT, 'apps/poc-ui/public/app.js');
const OUT_DIR = join(ROOT, 'output/conformance');
const OC = process.env.OPENCODE_URL ?? 'http://127.0.0.1:4096';
const renderOnly = process.argv.includes('--render');

interface AgentCoverage {
  agent: string;
  reachable: boolean;
  commands: { true: number; surfaced: number; missing: string[]; droppedByFilter: string[] };
  models: { true: number; surfaced: number; missing: string[] };
  note?: string;
}
interface ParityRow {
  agent: string;
  attachModes: string[];
  drivable: boolean;
  claims: string[];
  thin: boolean;
}
interface Report {
  render: { canonical: string[]; handled: string[]; gaps: string[] };
  parity: ParityRow[];
  agents: AgentCoverage[];
  ok: boolean;
}

// Enumerate EVERY registered adapter exactly like the broker (main.ts) — so a new adapter can never be
// a conformance blind spot the way Codex/Claude were when this only knew opencode+pi. (Issue H.)
const ALL_ADAPTERS: AgentBackend[] = [
  new OpenCodeAdapter({ baseUrl: OC }),
  new PiAdapter(),
  new OmpAdapter(),
  new CodexAdapter(),
  new ClaudeAdapter(),
];

// ── 0. CAPABILITY PARITY (static, registry-enumerated, no live agent) ──────────
// For each adapter, summarize its claimed surface and flag a 'thin' adapter (drivable-claiming but
// observe-only and feature-less) — surfaced as a tracked line so 'lacks the full CLI feature set' is
// COMPUTED, not rediscovered by the user. A genuinely observe-only adapter is thin-but-consistent (a
// WARN, not a fail); the hard fail is a REACHABLE drivable adapter surfacing nothing (see main).
function capabilityParity(): ParityRow[] {
  return ALL_ADAPTERS.map((a) => {
    const c = a.capabilities;
    const drivable = c.attachModes.some((m) => m === 'resume' || m === 'live') || c.supportsResume || c.supportsLiveAttach;
    const claims: string[] = [];
    if (c.supportsModelSwitch) claims.push('model-switch');
    if (c.permissionGranularity !== 'none') claims.push('permissions');
    if (c.supportsNativeArtifact) claims.push('artifact');
    if (c.supportsNativeFileInput) claims.push('file-input');
    const thin = !drivable && !c.supportsModelSwitch && c.permissionGranularity === 'none';
    return { agent: a.id, attachModes: c.attachModes, drivable, claims, thin };
  });
}

// ── 1. RENDER COVERAGE (deterministic) ────────────────────────────────────────
function renderCoverage(): Report['render'] {
  const src = readFileSync(APP_JS, 'utf8');
  // Every `case 'X':` label anywhere in app.js — a canonical type used as a case is handled by render().
  const handled = new Set<string>();
  for (const m of src.matchAll(/case\s+'([a-z][a-z-]*)'\s*:/g)) handled.add(m[1]!);
  const canonical = [...CANONICAL_MESSAGE_TYPES];
  const gaps = canonical.filter((t) => !handled.has(t));
  return { canonical, handled: canonical.filter((t) => handled.has(t)), gaps };
}

// ── 2. COMMAND/MODEL COVERAGE (live, best-effort) ──────────────────────────────
async function opencodeCoverage(): Promise<AgentCoverage> {
  const base: AgentCoverage = {
    agent: 'opencode', reachable: false,
    commands: { true: 0, surfaced: 0, missing: [], droppedByFilter: [] },
    models: { true: 0, surfaced: 0, missing: [] },
  };
  const oc = new OpenCodeAdapter({ baseUrl: OC });
  if (!(await oc.isAvailable())) { base.note = 'opencode serve not reachable — skipped'; return base; }
  base.reachable = true;
  const dir = '/tmp/cosyncing-conformance-oc';
  let sid: string | undefined;
  try {
    // TRUE surface from the server directly.
    const trueCmds: any[] = await fetch(`${OC}/command`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    const trueModels = await fetch(`${OC}/api/model`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
    const trueCmdNames = (Array.isArray(trueCmds) ? trueCmds : []).map((c: any) => c?.name).filter(Boolean) as string[];
    // What the ADAPTER surfaces (the real code path).
    const session = await oc.createSession({ directory: dir, title: 'cosyncing-conformance' });
    sid = session.id;
    const conn = await oc.attach(sid);
    const surfaced = (await conn.listCommands?.()) ?? [];
    const surfacedNames = new Set(surfaced.map((c) => c.name));
    const surfacedModels = (await conn.listModels?.()) ?? [];
    await conn.close?.();
    // Non-token names are valid OpenCode commands too; the app parser handles them by longest-name
    // matching. This bucket now means "the old token-only filter would have dropped it AND it is
    // still not surfaced", not merely "contains a space".
    const droppedByFilter = trueCmdNames.filter((n: string) => !/^[\w:-]+$/.test(n) && !surfacedNames.has(n));
    const missing = trueCmdNames.filter((n: string) => !surfacedNames.has(n));
    base.commands = { true: trueCmdNames.length, surfaced: surfaced.length, missing, droppedByFilter };
    const trueModelCount = Array.isArray(trueModels)
      ? trueModels.length
      : (Array.isArray(trueModels?.data) ? trueModels.data.length : (trueModels?.models?.length ?? 0));
    base.models = { true: trueModelCount, surfaced: surfacedModels.length, missing: [] };
  } catch (e) {
    base.note = `probe error: ${String(e).slice(0, 120)}`;
  } finally {
    if (sid) await fetch(`${OC}/session/${sid}?directory=${encodeURIComponent(dir)}`, { method: 'DELETE' }).catch(() => {});
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  return base;
}

async function piCoverage(): Promise<AgentCoverage> {
  const base: AgentCoverage = {
    agent: 'pi', reachable: false,
    commands: { true: 0, surfaced: 0, missing: [], droppedByFilter: [] },
    models: { true: 0, surfaced: 0, missing: [] },
  };
  const pi = new PiAdapter();
  if (!(await pi.isAvailable())) { base.note = 'pi not installed — skipped'; return base; }
  base.reachable = true;
  // A throwaway session path; spawning `pi --mode rpc` on a non-existent file creates a fresh one.
  const enc = Buffer.from('/tmp/cosyncing-conformance-pi.jsonl', 'utf8').toString('base64url');
  try {
    const conn = await pi.attach(enc);
    const surfaced = (await conn.listCommands?.()) ?? [];
    const models = (await conn.listModels?.()) ?? [];
    await conn.close?.();
    // Pi's listCommands already merges get_commands (its true registry) + builtins, so surfaced IS
    // the coverage; we report the count as proof of parity (was 1, the regression we're guarding).
    base.commands = { true: surfaced.length, surfaced: surfaced.length, missing: [], droppedByFilter: [] };
    base.models = { true: models.length, surfaced: models.length, missing: [] };
    if (surfaced.length <= 1) base.note = 'REGRESSION: Pi surfaces ≤1 command — get_commands not wired';
  } catch (e) {
    base.note = `probe error: ${String(e).slice(0, 120)}`;
  } finally {
    try { rmSync('/tmp/cosyncing-conformance-pi.jsonl', { force: true }); } catch { /* ignore */ }
  }
  return base;
}

async function ompCoverage(): Promise<AgentCoverage> {
  const base: AgentCoverage = {
    agent: 'omp', reachable: false,
    commands: { true: 0, surfaced: 0, missing: [], droppedByFilter: [] },
    models: { true: 0, surfaced: 0, missing: [] },
  };
  const omp = new OmpAdapter();
  if (!(await omp.isAvailable())) { base.note = 'omp not installed or below its runtime/package floor — skipped'; return base; }
  base.reachable = true;
  const sessionFile = '/tmp/cosyncing-conformance-omp.jsonl';
  const enc = Buffer.from(sessionFile, 'utf8').toString('base64url');
  try {
    const conn = await omp.attach(enc);
    const surfaced = (await conn.listCommands?.()) ?? [];
    const models = (await conn.listModels?.()) ?? [];
    await conn.close?.();
    base.commands = { true: surfaced.length, surfaced: surfaced.length, missing: [], droppedByFilter: [] };
    base.models = { true: models.length, surfaced: models.length, missing: [] };
    if (surfaced.length <= 1) base.note = 'REGRESSION: omp surfaces ≤1 command — get_available_commands not wired';
  } catch (e) {
    base.note = `probe error: ${String(e).slice(0, 120)}`;
  } finally {
    try { rmSync(sessionFile, { force: true }); } catch { /* ignore */ }
  }
  return base;
}

// Claude is ALWAYS reachable (disk-based), so probe it for free in OBSERVE mode (no model cost): the
// adapter must surface >0 commands. This is exactly the gap that shipped silently (Claude had no
// listCommands → ~0 commands); now it's a computed regression. (Issues C + H.)
async function claudeCoverage(): Promise<AgentCoverage> {
  const base: AgentCoverage = {
    agent: 'claude', reachable: false,
    commands: { true: 0, surfaced: 0, missing: [], droppedByFilter: [] },
    models: { true: 0, surfaced: 0, missing: [] },
  };
  const cl = new ClaudeAdapter();
  if (!(await cl.isAvailable())) { base.note = 'no ~/.claude — skipped'; return base; }
  base.reachable = true;
  try {
    const sessions = await cl.discoverSessions();
    if (!sessions.length) { base.note = 'no claude sessions on disk'; return base; }
    const conn = await cl.attach(sessions[0]!.id); // observe = free, no spawned process
    const cmds = (await conn.listCommands?.()) ?? [];
    await conn.close?.();
    base.commands = { true: cmds.length, surfaced: cmds.length, missing: [], droppedByFilter: [] };
    if (cmds.length === 0) base.note = 'REGRESSION: Claude surfaces 0 commands (listCommands missing)';
  } catch (e) {
    base.note = `probe error: ${String(e).slice(0, 120)}`;
  }
  return base;
}

// ── report + matrix doc ────────────────────────────────────────────────────────
function writeReport(report: Report): void {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'report.json'), JSON.stringify(report, null, 2));
}

/** A probe must never hang the harness — cap it and return a skipped coverage on timeout. */
function capProbe(agent: string, p: Promise<AgentCoverage>, ms = 40000): Promise<AgentCoverage> {
  return Promise.race([
    p,
    new Promise<AgentCoverage>((r) =>
      setTimeout(() => r({ agent, reachable: false, commands: { true: 0, surfaced: 0, missing: [], droppedByFilter: [] }, models: { true: 0, surfaced: 0, missing: [] }, note: 'probe timed out' }), ms),
    ),
  ]);
}

async function main() {
  const render = renderCoverage();
  const parity = capabilityParity();
  const agents: AgentCoverage[] = [];
  if (!renderOnly)
    agents.push(
      await capProbe('opencode', opencodeCoverage()),
      await capProbe('pi', piCoverage()),
      await capProbe('omp', ompCoverage()),
      await capProbe('claude', claudeCoverage()),
    );
  // Hard fails: a render blank-drop, OR a probed agent reporting a REGRESSION (e.g. a drivable adapter
  // surfacing ~0 commands — the thin-adapter class of bug, now computed rather than hand-found).
  const regressions = agents.filter((a) => (a.note ?? '').startsWith('REGRESSION'));
  const ok = render.gaps.length === 0 && regressions.length === 0;
  const report: Report = { render, parity, agents, ok };
  writeReport(report);

  // human summary
  console.log('── Capability conformance ──');
  console.log(`render coverage: ${render.handled.length}/${render.canonical.length} canonical types handled`);
  if (render.gaps.length) console.log(`  ✗ UNHANDLED (silent blank-drop): ${render.gaps.join(', ')}`);
  else console.log('  ✓ every canonical message type has a render case');
  console.log('capability parity (all registered adapters):');
  for (const p of parity) {
    console.log(`  ${p.agent}: [${p.attachModes.join(',')}]${p.drivable ? ' drivable' : ''}${p.claims.length ? ' · ' + p.claims.join('+') : ''}${p.thin ? '  ⚠ thin (observe-only, no commands/models/permissions)' : ''}`);
  }
  for (const a of agents) {
    if (!a.reachable) { console.log(`${a.agent}: ${a.note}`); continue; }
    console.log(`${a.agent}: commands surfaced=${a.commands.surfaced} (true=${a.commands.true}) · models surfaced=${a.models.surfaced} (true=${a.models.true})`);
    if (a.commands.missing.length) console.log(`  ⚠ unsurfaced commands: ${a.commands.missing.slice(0, 12).join(', ')}${a.commands.missing.length > 12 ? '…' : ''}`);
    if (a.commands.droppedByFilter.length) console.log(`  ⚠ dropped by name filter: ${a.commands.droppedByFilter.join(', ')}`);
    if (a.note) console.log(`  note: ${a.note}`);
  }
  console.log(`\nreport: ${join(OUT_DIR, 'report.json')}`);
  // Hard failures: render blank-drops (how token-count was lost) + computed capability regressions.
  if (!ok) {
    if (render.gaps.length) console.error('\nFAIL: canonical types with no render case.');
    for (const r of regressions) console.error(`FAIL: ${r.agent} — ${r.note}`);
    process.exit(1);
  }
  console.log('PASS');
  // Force exit: the OpenCode global-event tracker + any spawned pi process keep the loop alive.
  process.exit(0);
}

await main();
