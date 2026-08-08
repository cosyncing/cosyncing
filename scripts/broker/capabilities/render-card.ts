import type { GapRecord } from './types.ts';
import type { TaxonomyFunction } from '../tests_traces/trace-manifest.ts';
import { CANONICAL_MESSAGE_TYPES } from '../../../packages/typescript/adapter-api/src/index.ts';
import { readJsonFile } from './read-json.ts';

const FUNCTION_LABELS: Record<TaxonomyFunction, string> = {
  F01: 'session discovery and attach/resume',
  F02: 'control-state and sync affordances',
  F03: 'prompt/stop steering',
  F04: 'model output and thinking lanes',
  F05: 'tool call/result enrichment',
  F06: 'approval and permission flow',
  F07: 'question/input flow',
  F08: 'model, mode, and option controls',
  F09: 'native command registry',
  F10: 'plan/task/action surfaces',
  F11: 'goal and background activity',
  F12: 'file input',
  F13: 'file/artifact output',
  F14: 'session lifecycle and history mutation',
  F15: 'runtime, token, and summary telemetry',
  F16: 'security, auth, and transport invariants',
};

type CanonicalMessageType = (typeof CANONICAL_MESSAGE_TYPES)[number];

const CANONICAL_TARGETS_BY_FUNCTION: Partial<Record<TaxonomyFunction, CanonicalMessageType[]>> = {
  F06: ['permission-request', 'status', 'error'],
  F07: ['question-request', 'status', 'error'],
  F08: ['metadata-update', 'status', 'error'],
  F10: ['task-list-state', 'status', 'error'],
  F13: ['file-artifact', 'status', 'error'],
  F14: ['metadata-update', 'status', 'error'],
  F15: ['token-count', 'run-summary', 'metadata-update', 'status', 'error'],
};

const WIRE_ACTIONS_BY_FUNCTION: Partial<Record<TaxonomyFunction, string[]>> = {
  F10: ['plan-action'],
};

const canonicalMessageTypeSet = new Set<string>(CANONICAL_MESSAGE_TYPES);
for (const [fn, targets] of Object.entries(CANONICAL_TARGETS_BY_FUNCTION)) {
  for (const target of targets) {
    if (!canonicalMessageTypeSet.has(target)) throw new Error(`invalid canonical target for ${fn}: ${target}`);
  }
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function canonicalTargets(functions: readonly TaxonomyFunction[]): string[] {
  const targets = unique(functions.flatMap((fn) => CANONICAL_TARGETS_BY_FUNCTION[fn] ?? ['status', 'error']));
  return targets.length ? targets : ['status', 'error'];
}

function wireActions(functions: readonly TaxonomyFunction[]): string[] {
  return unique(functions.flatMap((fn) => WIRE_ACTIONS_BY_FUNCTION[fn] ?? []));
}

function reviewLane(gap: GapRecord): string {
  if (gap.productStatus === 'productize-now' && !gap.reviewRequired && gap.riskClass === 'R0') return 'review-free implementation candidate';
  if (gap.productStatus === 'productize-now' && !gap.reviewRequired) return 'implementation candidate after existing card checks';
  if (gap.productStatus === 'productize-after-review') return 'maintainer review required before implementation';
  if (gap.reviewRequired) return 'review required before implementation';
  return 'report-only unless product policy changes';
}

function bulletList(values: readonly string[]): string {
  return values.map((value) => `- ${value}`).join('\n');
}

export function renderCard(gap: GapRecord): string {
  const functions = gap.functions.map((fn) => `${fn} ${FUNCTION_LABELS[fn] ?? 'unlabeled capability function'}`);
  const targets = canonicalTargets(gap.functions);
  const actions = wireActions(gap.functions);
  const summary = gap.summary ? `\nSummary: ${gap.summary}\n` : '';
  return `# Gap: ${gap.title ?? gap.id}

Gap id: ${gap.id}
Capability id: ${gap.capabilityId}
Native id: ${gap.nativeId}
Agent: ${gap.agent}
Native version: ${gap.version}
Reason: ${gap.reason}
Product status: ${gap.productStatus}
Mapped status: ${gap.mappedStatus}
Risk class: ${gap.riskClass}
Risk: ${gap.risk}
Review required: ${gap.reviewRequired ? 'yes' : 'no'}${summary}
## Function mapping

${bulletList(functions)}

## Canonical behavior

Use existing canonical message types only:

${bulletList(targets)}

${actions.length ? `Wire actions involved, but not emitted as canonical messages:\n\n${bulletList(actions)}\n` : ''}

No new canonical message type unless the card is explicitly revised.
No tool-specific branch in broker/app; dispatch by capability/interface, not agent name.

## Review lane

${reviewLane(gap)}.

Do not implement productize-after-review gaps before maintainer review.
Do not implement unsafe, not-productized, or research-follow-up gaps from this card.
Do not promote F-claims or support claims until required evidence is present in the adapter manifest.

## Implementation evidence required

${bulletList(gap.evidenceRequired.map((level) => `${level}${gap.evidencePresent.includes(level) ? ' (already present)' : ' (missing)'}`))}

## Acceptance checklist

- Adapter behavior lives inside the owning adapter or a shared capability interface.
- Broker/app behavior is selected from capabilities, attach mode, or optional interface presence.
- L0 fixture or unit coverage proves success and non-secret failure mapping.
- L1/L2 evidence is added only when the real or fake-native path exists.
- Adapter manifest and source lock entries are updated in the same change as implementation evidence.
`;
}

if (import.meta.main) {
  const input = process.argv[2];
  const id = process.argv[3];
  if (!input || !id) throw new Error('usage: bun scripts/broker/capabilities/render-card.ts <gap-report.json> <gap-id>');
  const report = readJsonFile<{ openGaps: GapRecord[] }>(input);
  const gap = report.openGaps.find((g) => g.id === id);
  if (!gap) throw new Error(`gap not found: ${id}`);
  console.log(renderCard(gap));
}
