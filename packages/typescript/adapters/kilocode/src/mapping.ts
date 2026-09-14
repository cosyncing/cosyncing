import type { AgentMessage } from '@cosyncing/adapter-api';
import { mapOpenCodePart } from '@cosyncing/opencode-wire';

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
