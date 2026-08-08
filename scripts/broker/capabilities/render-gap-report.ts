import type { GapRecord, GapReport } from './types.ts';
import { readJsonFile } from './read-json.ts';

function list(values: string[]): string {
  return values.join(',');
}

function row(gap: GapRecord): string {
  return `| ${gap.id} | ${gap.nativeId} | ${list(gap.functions)} | ${gap.productStatus} | ${gap.mappedStatus} | ${list(gap.evidenceRequired)} | ${list(gap.evidencePresent)} | ${gap.riskClass} | ${gap.risk} | ${gap.reviewRequired ? 'yes' : 'no'} |`;
}

export function renderGapReport(report: GapReport): string {
  const titleAgent = report.agent === 'opencode' ? 'OpenCode' : report.agent;
  const lines = [
    `# Capability gaps: ${titleAgent} ${report.mode} snapshot`,
    '',
    `Agent: ${report.agent}`,
    `Version: ${report.version}`,
    `Source lock: ${report.sourceLock}`,
    `Mode: ${report.mode}`,
    `Generated: ${report.generatedAt}`,
    '',
    '## Open gaps',
    '',
    '| Gap id | Native id | F mapping | Product status | Mapped status | Evidence required | Evidence present | Risk class | Risk label | Review |',
    '|---|---|---:|---|---|---|---|---|---|---|',
    ...(report.openGaps.length ? report.openGaps.map(row) : ['| _none_ |  |  |  |  |  |  |  |  |  |']),
    '',
    '## Deliberately blocked in this snapshot',
    '',
    '| Native id | F mapping | Product status | Risk class | Reason |',
    '|---|---:|---|---|---|',
    ...(report.blocked.length
      ? report.blocked.map((gap) => `| ${gap.nativeId} | ${list(gap.functions)} | ${gap.productStatus} | ${gap.riskClass} | ${gap.deliberateExclusionReason ?? gap.reason} |`)
      : ['| _none_ |  |  |  |  |']),
    '',
  ];
  return lines.join('\n');
}

if (import.meta.main) {
  const input = process.argv[2];
  if (!input) throw new Error('usage: bun scripts/broker/capabilities/render-gap-report.ts <gap-report.json>');
  console.log(renderGapReport(readJsonFile<GapReport>(input)));
}
