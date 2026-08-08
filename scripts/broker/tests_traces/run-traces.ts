/**
 * Scenario trace catalog runner.
 *
 * This is intentionally catalog-only for now: it lists and exports the product-level scenarios that
 * future trace drivers must execute. Do not treat this as a green test suite until a scenario has a
 * real driver that records frames, UI state, files, and native agent state.
 *
 * Examples:
 *   bun run scripts/broker/tests_traces/run-traces.ts --list
 *   bun run scripts/broker/tests_traces/run-traces.ts --agent opencode --priority p0 --list
 *   bun run scripts/broker/tests_traces/run-traces.ts --write-catalog
 */
export {};
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS, TRACE_SCENARIOS, scenariosFor, type AgentId, type TracePriority } from './scenarios.ts';

const ROOT = join(import.meta.dir, '..', '..', '..');
const OUT_DIR = join(ROOT, 'output', 'traces');

interface Args {
  agent?: AgentId;
  priority?: TracePriority;
  scenario?: string;
  list: boolean;
  writeCatalog: boolean;
  execute: boolean;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { list: false, writeCatalog: false, execute: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--write-catalog') out.writeCatalog = true;
    else if (a === '--execute') out.execute = true;
    else if (a === '--agent') out.agent = parseAgent(argv[++i]);
    else if (a === '--priority') out.priority = parsePriority(argv[++i]);
    else if (a === '--scenario') out.scenario = String(argv[++i] ?? '').toUpperCase();
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  if (!out.list && !out.writeCatalog && !out.execute) out.list = true;
  return out;
}

function parseAgent(v?: string): AgentId {
  if (AGENTS.includes(v as AgentId)) return v as AgentId;
  throw new Error(`--agent must be one of: ${AGENTS.join(', ')}`);
}

function parsePriority(v?: string): TracePriority {
  if (v === 'p0' || v === 'p1' || v === 'p2') return v;
  throw new Error('--priority must be one of: p0, p1, p2');
}

function selected(args: Args) {
  return scenariosFor(args.agent)
    .filter((s) => !args.priority || s.priority === args.priority)
    .filter((s) => !args.scenario || s.id === args.scenario);
}

function printList(args: Args): void {
  const rows = selected(args);
  console.log(`Scenario trace catalog: ${rows.length}/${TRACE_SCENARIOS.length}`);
  for (const s of rows) {
    const agents = s.agents === 'all' ? 'all' : s.agents.join(',');
    console.log(`${s.id.padEnd(5)} ${s.priority.padEnd(2)} ${s.tier.padEnd(13)} ${agents.padEnd(24)} ${s.title}`);
  }
}

function writeCatalog(args: Args): void {
  mkdirSync(OUT_DIR, { recursive: true });
  const path = join(OUT_DIR, 'catalog.json');
  writeFileSync(
    path,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        note: 'Catalog only. Scenario execution must write per-run trace artifacts before it can be used as a pass/fail suite.',
        filters: { agent: args.agent, priority: args.priority, scenario: args.scenario },
        scenarios: selected(args),
      },
      null,
      2,
    ),
  );
  console.log(path);
}

function printHelp(): void {
  console.log(`Usage: bun run scripts/broker/tests_traces/run-traces.ts [options]

Options:
  --list                 Print scenario rows. Default when no action is provided.
  --write-catalog        Write output/traces/catalog.json for the selected rows.
  --agent <agent>        Filter: ${AGENTS.join('|')}.
  --priority <p0|p1|p2>  Filter by priority.
  --scenario <id>        Filter by scenario id, e.g. ST-17.
  --execute              Reserved for real drivers; exits non-zero today.`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) printList(args);
  if (args.writeCatalog) writeCatalog(args);
  if (args.execute) {
    console.error('Scenario execution is not implemented yet. This runner is a catalog/export tool only.');
    process.exit(2);
  }
}

await main();
