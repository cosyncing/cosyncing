import type { AgentMessage } from '@cosyncing/adapter-api';
import { finite, nativeId, object, type Native } from './mapping.ts';

type Activity = Extract<AgentMessage, { type: 'agent-activity' }>;

/** The first service version that lists background jobs (`GET /api/experimental/job`). */
export const JOB_LIST_MINIMUM_VERSION = '2.2.6';
/** The first service version that reports job changes as `experimental.job.updated` events. */
export const JOB_EVENT_MINIMUM_VERSION = '2.4.0';
/** How often a service without job events is asked again while one of a session's jobs runs. */
export const JOB_POLL_MS = 2_000;
/** Jobs tracked per session; later ones are ignored rather than evicting a running row. */
const JOB_LIMIT = 32;

const STATUSES = new Set(['running', 'completed', 'error', 'cancelled']);
const bounded = (value: string, limit: number): string => value.length > limit ? value.slice(0, limit - 1) + '…' : value;
const text = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * One background job that outlived the turn that started it: a subagent, or a shell command past
 * its timeout. Other kinds (image, video, Code Mode) are not shown. The job list carries only
 * running jobs (a finished job leaves it once OpenCode delivers its report), and from 2.4.0 the
 * same shape arrives as `experimental.job.updated` with each status change.
 */
export function backgroundJob(value: unknown, sessionId: string): Native | undefined {
  if (!object(value) || typeof value.id !== 'string' || !value.id || value.id.length > 256) return undefined;
  if (!nativeId(value.sessionID, 'ses') || value.sessionID !== sessionId) return undefined;
  if (!STATUSES.has(value.status) || !object(value.time) || !finite(value.time.started)) return undefined;
  if (value.kind === 'subagent' || value.kind === 'shell') return value;
  return undefined;
}

/** The job as the existing background row: a subagent card, or a background command card. A
 *  cancelled job did not finish its work and reads as failed; the exit code is not part of the
 *  job (OpenCode reports it only in its text), so a command card never carries one. */
export function jobCard(job: Native, status: Activity['status'] = job.status === 'running' ? 'running' : job.status === 'completed' ? 'done' : 'error'): Activity {
  const started = job.time.started as number;
  const completed = finite(job.time.completed) && job.time.completed >= started ? job.time.completed : undefined;
  const timing = status === 'running' ? { startedAtMs: started }
    : completed !== undefined ? { startedAtMs: started, elapsedMs: completed - started } : {};
  if (job.kind === 'subagent') {
    const agent = text(job.agent);
    return {
      type: 'agent-activity', key: `agent:${job.id}`, kind: 'subagent',
      title: bounded(text(job.description) ?? text(job.title) ?? agent ?? 'Subagent task', 120),
      ...(agent ? { subtitle: bounded(agent, 120) } : {}),
      status, ...timing, agentsDone: status === 'running' ? 0 : 1, agentsTotal: 1,
    };
  }
  const command = text(job.command) ?? text(job.title) ?? 'Background command';
  return {
    type: 'agent-activity', key: `cmd:${job.id}`, kind: 'command',
    title: bounded(command.split('\n').find((line) => line.trim())!.trim(), 120),
    subtitle: bounded(command, 200),
    status, ...timing,
  };
}

/**
 * The background rows of one session. A complete list read is authoritative for what still runs:
 * a tracked job missing from it ended while no change was observed, so its row is retired rather
 * than given an outcome nobody saw. A job event carries the job's own outcome.
 */
export class V2JobRows {
  private readonly running = new Map<string, Native>();
  private readonly emitted = new Map<string, string>();

  constructor(private readonly sessionId: string, private readonly emit: (message: AgentMessage) => void) {}

  get size(): number { return this.running.size; }

  /** Take over the rows a replaced connection showed, so the next list read can retire the ones
   *  that did not survive a service restart. */
  adopt(previous: V2JobRows): void {
    for (const [id, job] of previous.running) if (this.running.size < JOB_LIMIT) this.running.set(id, job);
    for (const [key, signature] of previous.emitted) this.emitted.set(key, signature);
  }

  /** A complete list of this session's jobs. */
  snapshot(values: unknown[]): void {
    const listed = new Map<string, Native>();
    for (const value of values) {
      const job = backgroundJob(value, this.sessionId);
      if (job && !listed.has(job.id)) listed.set(job.id, job);
    }
    for (const [id, job] of [...this.running]) if (!listed.has(id)) this.finish(job, 'retired');
    for (const job of listed.values()) this.update(job);
  }

  /** One job's current state. */
  update(value: unknown): void {
    const job = backgroundJob(value, this.sessionId);
    if (!job) return;
    if (job.status !== 'running') { this.finish(job); return; }
    if (!this.running.has(job.id) && this.running.size >= JOB_LIMIT) return;
    this.running.set(job.id, job);
    this.publish(jobCard(job));
  }

  /** Running rows, for a transcript read or a reattach. */
  cards(): Activity[] { return [...this.running.values()].map((job) => jobCard(job)); }

  /** An idle session status ends every running subagent row on the client, but a background
   *  subagent outlives its parent's turn: restate the rows that still run. */
  restateAfterIdle(): void {
    for (const job of this.running.values()) if (job.kind === 'subagent') this.publish(jobCard(job), true);
  }

  private finish(job: Native, status?: Activity['status']): void {
    const tracked = this.running.delete(job.id);
    if (status === 'retired' && !tracked) return;
    this.publish(jobCard(job, status));
  }

  private publish(card: Activity, force = false): void {
    const signature = JSON.stringify(card);
    if (!force && this.emitted.get(card.key) === signature) return;
    this.emitted.set(card.key, signature);
    while (this.emitted.size > JOB_LIMIT * 2) this.emitted.delete(this.emitted.keys().next().value!);
    this.emit(card);
  }
}
