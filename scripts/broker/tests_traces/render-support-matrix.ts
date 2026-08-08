import { readFileSync, writeFileSync } from 'node:fs';
import { SUPPORT_MATRIX_CLAIMS, type SupportClaim } from './support-matrix-claims.ts';
import { TAXONOMY_FUNCTIONS, type TaxonomyFunction } from './trace-manifest.ts';
import type { AgentId } from './scenarios.ts';

const AGENT_ORDER: AgentId[] = ['claude', 'codex', 'opencode', 'pi'];
const AGENT_LABELS: Record<AgentId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
};

const FUNCTION_LABELS: Record<TaxonomyFunction, string> = {
  F01: 'discover/history/reattach',
  F02: 'true sync',
  F03: 'prompt/queue/stop',
  F04: 'answer/thinking streaming',
  F05: 'tool display',
  F06: 'permissions',
  F07: 'questions',
  F08: 'model/effort/mode display/override',
  F09: 'slash commands/skills/templates',
  F10: 'todo/task list',
  F11: 'subagents/workflows/activity',
  F12: 'user-to-agent files',
  F13: 'agent-to-user artifacts',
  F14: 'lifecycle/history mutation',
  F15: 'runtime/tokens/context/status',
  F16: 'security/auth/boundaries',
};

const claimMap = new Map<string, SupportClaim>();
for (const claim of SUPPORT_MATRIX_CLAIMS) claimMap.set(`${claim.agent}:${claim.fn}`, claim);

export function renderSupportMatrixBlock(): string {
  const lines = [
    '| Function | Claude Code | Codex | OpenCode | Pi |',
    '|---|---|---|---|---|',
  ];
  for (const fn of TAXONOMY_FUNCTIONS) {
    const cells = [
      `${fn} ${FUNCTION_LABELS[fn]}`,
      ...AGENT_ORDER.map((agent) => renderClaim(agent, fn)),
    ].map(tableCell);
    lines.push(`| ${cells.join(' | ')} |`);
  }
  return lines.join('\n');
}

function renderClaim(agent: AgentId, fn: TaxonomyFunction): string {
  const claim = claimMap.get(`${agent}:${fn}`);
  if (!claim) return 'missing: no support claim';
  if (claim.support === 'n/a') return `n/a: ${claim.summary}`;
  return `${claim.support}: ${claim.summary}`;
}

function tableCell(value: string): string {
  return value.replace(/\|/g, '\\|');
}

if (import.meta.main) {
  if (process.argv.includes('--write')) {
    const path = 'docs/protocol/adapter-support.md';
    const begin = '<!-- BEGIN GENERATED SUPPORT MATRIX -->';
    const end = '<!-- END GENERATED SUPPORT MATRIX -->';
    const source = readFileSync(path, 'utf8');
    const start = source.indexOf(begin);
    const stop = source.indexOf(end);
    if (start < 0 || stop < 0 || stop <= start) {
      throw new Error(`${path} is missing generated support matrix markers`);
    }
    const generated = `\n\n${renderSupportMatrixBlock()}\n\n`;
    writeFileSync(path, source.slice(0, start + begin.length) + generated + source.slice(stop), 'utf8');
    console.log(`updated ${path}`);
  } else {
    console.log(renderSupportMatrixBlock());
  }
}

export { AGENT_LABELS, FUNCTION_LABELS };
