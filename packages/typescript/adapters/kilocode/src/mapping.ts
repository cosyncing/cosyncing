import type { AgentMessage, AgentOption } from '@cosyncing/adapter-api';
import { mapOpenCodePart, type OpenCodeServerReport } from '@cosyncing/opencode-wire';

const KILO_MAX_AGENTS = 256;
const KILO_MAX_AGENT_NAME_CHARS = 120;
const KILO_MAX_AGENT_DESCRIPTION_CHARS = 2_000;

/** Kilo 7.4.23 persists the OpenCode-lineage part vocabulary unchanged. */
export interface KiloMapTrace { op: 'unknown-part'; detail: string }

function record(value: unknown): Record<string, any> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, any>
    : undefined;
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function stringFields(value: Record<string, any>, keys: readonly string[]): boolean {
  return keys.every((key) => optionalString(value[key]));
}

function timeShape(value: unknown): boolean {
  if (value === undefined) return true;
  const time = record(value);
  return !!time && ['created', 'updated', 'completed', 'start', 'end']
    .every((key) => optionalFiniteNumber(time[key]));
}

export function validateKiloMessage(message: Record<string, any>): boolean {
  if (!['user', 'assistant'].includes(message.role) || !optionalString(message.parentID)
    || !optionalString(message.finish) || !timeShape(message.time) || !optionalFiniteNumber(message.cost)) return false;
  if (message.tokens !== undefined) {
    const tokens = record(message.tokens);
    const cache = tokens && message.tokens.cache === undefined ? undefined : record(tokens?.cache);
    if (!tokens || (tokens.cache !== undefined && !cache)
      || !['input', 'output', 'total'].every((key) => optionalFiniteNumber(tokens[key]))
      || !['read', 'write'].every((key) => optionalFiniteNumber(cache?.[key]))) return false;
  }
  return message.error === undefined || !!record(message.error);
}

export function validateKiloPart(part: Record<string, any>): boolean {
  if (typeof part.type !== 'string' || !timeShape(part.time)
    || !optionalFiniteNumber(part.timeCreated) || !optionalFiniteNumber(part.timeUpdated)) return false;
  if (part.type === 'text' || part.type === 'reasoning') return typeof part.text === 'string';
  if (part.type === 'file') return ['filename', 'url', 'mime'].every((key) => optionalString(part[key]));
  if (part.type === 'tool') {
    const state = record(part.state);
    if (typeof part.tool !== 'string' || !optionalString(part.callID) || !state
      || !optionalString(state.status) || !optionalString(state.title)) return false;
    const input = state.input === undefined ? {} : record(state.input);
    const metadata = state.metadata === undefined ? {} : record(state.metadata);
    if (!input || !metadata
      || !stringFields(input, ['command', 'description', 'cwd', 'filePath', 'path', 'pattern', 'query',
        'url', 'glob', 'include', 'subagent_type', 'prompt'])
      || !stringFields(metadata, ['filepath', 'preview', 'diff', 'output'])
      || !['count', 'matches', 'totalLines', 'lines', 'exit'].every((key) => optionalFiniteNumber(metadata[key]))) return false;
    if (metadata.filediff !== undefined) {
      const fileDiff = record(metadata.filediff);
      if (!fileDiff || !stringFields(fileDiff, ['file', 'patch'])
        || !['additions', 'deletions'].every((key) => optionalFiniteNumber(fileDiff[key]))) return false;
    }
    return true;
  }
  return Object.keys(part).length <= 128;
}

export function mapKiloPart(
  part: unknown,
  historical = true,
  trace?: (event: KiloMapTrace) => void,
): AgentMessage[] {
  const mapped = mapOpenCodePart(part, { historical, productId: 'kilo' });
  if (mapped.length > 0 || typeof part !== 'object' || part === null || Array.isArray(part)) return mapped;
  const record = part as Record<string, unknown>;
  const type = typeof record.type === 'string' ? record.type : 'unknown';
  if (['text', 'reasoning', 'file', 'tool', 'step-start', 'step-finish'].includes(type)) return [];
  trace?.({ op: 'unknown-part', detail: `Kilo part type ${type} has no measured canonical mapping` });
  return [{
    type: 'event',
    name: 'context.injection',
    payload: {
      source: 'Kilo Code part (unmapped)',
      body: `type=${type} keys=${Object.keys(record).sort().join(',')}`,
    },
  }];
}

/**
 * Kilo's own report rows: a background task's completion (7.4+) and a scheduled wakeup (7.7+). Kilo
 * posts each to the session as a user message whose text part carries `synthetic: true` and
 * `metadata.background: true`; a wakeup adds `metadata.wakeup: true` (captured on 7.5.16 and 7.8.32,
 * 2026-11-26, live and in kilo.db). The message itself carries no mark.
 *
 * Strict on purpose: EVERY part must be such a text part. A goal loop's turn (synthetic, no metadata),
 * a prompt with a typed part, a file part, or synthetic text a client can inject is not Kilo's report,
 * so a real second writer still ends Drive.
 */
export function kiloServerReport(parts: readonly unknown[]): OpenCodeServerReport | undefined {
  if (parts.length === 0) return undefined;
  let wakeup = false;
  const bodies: string[] = [];
  for (const part of parts) {
    const value = record(part);
    const metadata = record(value?.metadata);
    if (!value || !metadata || value.type !== 'text' || value.synthetic !== true || typeof value.text !== 'string'
      || metadata.background !== true) return undefined;
    if (metadata.wakeup === true) wakeup = true;
    bodies.push(value.text);
  }
  return { source: wakeup ? 'Kilo scheduled wakeup' : 'Kilo background task', body: bodies.join('\n') };
}

/**
 * The agents a Kilo prompt may name, from `GET /agent` (captured on 7.5.16 and 7.8.40, 2026-11-28: the
 * same ten agents on both). Offered as the OpenCode adapter offers them: the primary agents that carry
 * a description, in Kilo's order. Kilo's subagents (`explore`, `general`) run only through its task
 * tool, and its internal agents (`compaction`, `summary`, `title`) are hidden and carry no description.
 * A deprecated agent (`orchestrator`) still runs and Kilo's own picker still lists it, marked as
 * deprecated, so it is offered with that mark. A name is kept exactly as Kilo gave it: a prompt must
 * name it so. Anything but a list is unknown (undefined), not an empty list.
 */
export function kiloAgentOptions(raw: unknown): AgentOption[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const agents: AgentOption[] = [];
  const seen = new Set<string>();
  for (const entry of raw.slice(0, KILO_MAX_AGENTS)) {
    const agent = record(entry);
    const name = agent?.name;
    const description = typeof agent?.description === 'string' ? agent.description.trim() : '';
    if (!agent || agent.mode !== 'primary' || agent.hidden === true || typeof name !== 'string' || !name
      || name.length > KILO_MAX_AGENT_NAME_CHARS || /[\u0000-\u001f\u007f]/u.test(name) || !description
      || seen.has(name)) continue;
    seen.add(name);
    const shown = description.slice(0, KILO_MAX_AGENT_DESCRIPTION_CHARS);
    agents.push({ name, description: agent.deprecated === true ? `Deprecated. ${shown}` : shown });
  }
  return agents;
}
