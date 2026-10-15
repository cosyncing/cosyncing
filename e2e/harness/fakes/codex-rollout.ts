/**
 * Codex rollouts on disk, where the product's Codex adapter finds them
 * (`$HOME/.codex/sessions/YYYY/MM/DD/rollout-<stamp>-<uuid>.jsonl`), for
 * history tests that need a native store larger than any scripted session.
 *
 * Records are written in batches, never materialized whole. A sparse rollout
 * (`ftruncate` past a ceiling, rows written after the hole) costs no disk and
 * reads at memory speed, which keeps the over-ceiling cases cheap; it needs a
 * filesystem with sparse files (Linux, macOS).
 */
import { appendFileSync, closeSync, ftruncateSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';

export const MiB = 1024 * 1024;

export interface Rollout {
  readonly path: string;
  /** The broker's session id for it: the rollout path, base64url. */
  readonly id: string;
  append(records: Array<Record<string, unknown>>): void;
}

const DEFAULT_DAY = '2026-07-28';

export function codexUser(text: string, timestamp = `${DEFAULT_DAY}T00:00:00.000Z`): Record<string, unknown> {
  return { timestamp, type: 'event_msg', payload: { type: 'user_message', message: text } };
}

export function codexAgent(text: string, timestamp = `${DEFAULT_DAY}T00:00:01.000Z`): Record<string, unknown> {
  return { timestamp, type: 'event_msg', payload: { type: 'agent_message', message: text } };
}

export function codexTurnStarted(turnId: string, timestamp = `${DEFAULT_DAY}T00:00:02.000Z`): Record<string, unknown> {
  return { timestamp, type: 'event_msg', payload: { type: 'task_started', turn_id: turnId } };
}

/** An `update_plan` call, which Codex history maps to the session's plan (task-list state). */
export function codexPlan(step: string, callId = 'plan', pad = 0): Record<string, unknown> {
  return {
    timestamp: `${DEFAULT_DAY}T00:00:00.000Z`,
    type: 'response_item',
    payload: {
      type: 'function_call',
      name: 'update_plan',
      call_id: callId,
      arguments: JSON.stringify({ plan: [{ step: `${step}${'x'.repeat(pad)}`, status: 'in_progress' }] }),
    },
  };
}

function uuidFor(serial: number): string {
  return `00000000-0000-4000-8000-${serial.toString(16).padStart(12, '0')}`;
}

let serial = 0x0e2e0000;

/**
 * A rollout under `home`. `rows` are written after the session header; a
 * function producing rows is called in batches of `batch` so huge fixtures
 * stream to disk.
 */
export function writeRollout(
  home: string,
  options: {
    rows?: Array<Record<string, unknown>>;
    generate?: { count: number; row: (index: number) => Record<string, unknown> };
    /** Start the rows past a sparse hole of this many bytes (no session header then). */
    sparseBytes?: number;
    day?: string;
  } = {},
): Rollout {
  const day = options.day ?? DEFAULT_DAY;
  const [year, month, date] = day.split('-');
  const directory = join(home, '.codex', 'sessions', year!, month!, date!);
  mkdirSync(directory, { recursive: true });
  const uuid = uuidFor(++serial);
  const path = join(directory, `rollout-${day}T00-00-00-${uuid}.jsonl`);
  const fd = openSync(path, 'w');
  try {
    let offset = 0;
    const write = (text: string) => {
      offset += writeSync(fd, text, offset);
    };
    if (options.sparseBytes) {
      ftruncateSync(fd, options.sparseBytes);
      offset = options.sparseBytes;
      write('\n');
    } else {
      write(`${JSON.stringify({ timestamp: `${day}T00:00:00.000Z`, type: 'session_meta', payload: { id: uuid, cwd: home } })}\n`);
    }
    if (options.rows?.length) write(`${options.rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
    if (options.generate) {
      const { count, row } = options.generate;
      for (let base = 0; base < count; base += 500) {
        const lines: string[] = [];
        for (let index = base; index < Math.min(base + 500, count); index += 1) lines.push(JSON.stringify(row(index)));
        write(`${lines.join('\n')}\n`);
      }
    }
  } finally {
    closeSync(fd);
  }
  return {
    path,
    id: Buffer.from(path, 'utf8').toString('base64url'),
    append(records) {
      appendFileSync(path, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
    },
  };
}

/** One raw record of `bytes` bytes (a user message), written in chunks: past any per-record ceiling. */
export function appendOversizedRecord(path: string, bytes: number): void {
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, '{"type":"event_msg","payload":{"type":"user_message","message":"');
    const chunk = Buffer.alloc(MiB, 0x78);
    for (let written = 0; written < bytes; written += chunk.length) writeSync(fd, chunk);
    writeSync(fd, '"}}\n');
  } finally {
    closeSync(fd);
  }
}
