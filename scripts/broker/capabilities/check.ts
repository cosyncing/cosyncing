import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { AgentId } from '../tests_traces/scenarios.ts';
import type { AdapterSupportManifest, CapabilitySourceLock, DiscoveredCapabilitiesFile, ProductPolicyFile } from './types.ts';
import { readJsonFile } from './read-json.ts';
import { buildGapReport } from './gap-engine.ts';
import { renderGapReport } from './render-gap-report.ts';
import { renderCard } from './render-card.ts';

const ROOT = join(import.meta.dir, '..', '..', '..');

interface Args {
  agent: AgentId;
  mode: 'fixture' | 'live';
  fixture?: string;
  sourceLock?: string;
  manifest?: string;
  policy?: string;
  writeOutput: string;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = { agent: 'opencode', mode: 'fixture' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--agent' && next) {
      out.agent = next as AgentId;
      i++;
    } else if (arg === '--mode' && next) {
      out.mode = next as Args['mode'];
      i++;
    } else if (arg === '--fixture' && next) {
      out.fixture = next;
      i++;
    } else if (arg === '--source-lock' && next) {
      out.sourceLock = next;
      i++;
    } else if (arg === '--manifest' && next) {
      out.manifest = next;
      i++;
    } else if (arg === '--policy' && next) {
      out.policy = next;
      i++;
    } else if (arg === '--write-output' && next) {
      out.writeOutput = next;
      i++;
    } else {
      throw new Error(`unknown or incomplete argument: ${arg}`);
    }
  }
  if (out.agent !== 'opencode' && out.agent !== 'pi' && out.agent !== 'codex' && out.agent !== 'claude') throw new Error('capability check currently supports --agent opencode|pi|codex|claude');
  if (out.mode !== 'fixture') throw new Error('live collection is opt-in via collect-opencode-live.ts; check.ts supports fixture mode in this slice');
  out.writeOutput ??= join(ROOT, `output/capabilities/${out.agent}/fixture`);
  return out as Args;
}

function displayPath(path: string): string {
  const rel = relative(ROOT, path);
  return rel && !rel.startsWith('..') && !rel.startsWith('/') ? rel : path;
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function runCapabilityCheck(args: Args): void {
  const fixturePath = args.fixture ?? join(ROOT, `scripts/broker/capabilities/fixtures/${args.agent}/discovered.seed.json`);
  const sourceLockPath = args.sourceLock ?? join(ROOT, `scripts/broker/capabilities/fixtures/${args.agent}/source-lock.seed.json`);
  const manifestPath = args.manifest ?? join(ROOT, `scripts/broker/capabilities/manifests/${args.agent}.adapter-support.json`);
  const policyPath = args.policy ?? join(ROOT, 'scripts/broker/capabilities/policies/productization-policy.json');
  const discovered = readJsonFile<DiscoveredCapabilitiesFile>(fixturePath);
  const sourceLock = readJsonFile<CapabilitySourceLock>(sourceLockPath);
  const manifest = readJsonFile<AdapterSupportManifest>(manifestPath);
  const policyAll = readJsonFile<ProductPolicyFile>(policyPath);
  const policy: ProductPolicyFile = { ...policyAll, policies: policyAll.policies.filter((entry) => entry.agent === discovered.agent) };
  const report = buildGapReport(discovered, sourceLock, manifest, policy, args.mode, displayPath(sourceLockPath));
  const cardDir = join(args.writeOutput, 'cards');
  rmSync(cardDir, { recursive: true, force: true });
  for (const gap of report.openGaps) {
    gap.cardPath = `cards/${gap.id}.md`;
  }
  write(join(args.writeOutput, 'gap-report.json'), JSON.stringify(report, null, 2) + '\n');
  write(join(args.writeOutput, 'gap-report.md'), renderGapReport(report));
  for (const gap of report.openGaps) {
    if (gap.cardPath) write(join(cardDir, `${gap.id}.md`), renderCard(gap));
  }
  console.log(`Capability gaps: ${report.openGaps.length} open, ${report.blocked.length} blocked`);
  console.log(`report: ${join(args.writeOutput, 'gap-report.json')}`);
}

if (import.meta.main) {
  try {
    runCapabilityCheck(parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
