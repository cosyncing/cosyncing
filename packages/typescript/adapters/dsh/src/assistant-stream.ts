/** Process-local 0.2 assistant attempts. Durable events remain the settlement authority. */
import type { AgentMessage } from '@cosyncing/adapter-api';

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function index(value: unknown): value is number { return Number.isSafeInteger(value) && (value as number) >= 0; }
interface Attempt { id: string; turn: number; step: number; nextIndex: number; text: string; reasoning: string;
  blocks: Map<number, { kind: 'text' | 'reasoning'; text: string }> }
const MAX_TEXT = 1_048_576;

export class DshAssistantStream {
  private revision = 0;
  private attempt?: Attempt;
  private suspended = false;
  constructor(private readonly sessionId: string) {}

  /** Hide an unverified overlay while retaining its identity for the next baseline's retraction. */
  suspend(): void { this.suspended = true; }

  settle(turn: unknown, step: unknown): void {
    if (this.attempt && this.attempt.turn === turn && this.attempt.step === step) this.attempt = undefined;
  }

  /** Full replacements make reconnect baselines and retransmitted chunks idempotent. */
  messages(): AgentMessage[] {
    const a = this.attempt;
    if (!a || this.suspended) return [];
    const key = `dsh:${this.sessionId}:turn${String(a.turn)}:step${String(a.step)}`;
    return [
      ...(a.text ? [{ type: 'model-output' as const, text: a.text, key, final: false }] : []),
      ...(a.reasoning ? [{ type: 'thinking' as const, text: a.reasoning, key: `${key}:reasoning` }] : []),
    ];
  }

  baseline(raw: unknown): AgentMessage[] {
    this.suspended = false;
    const baseline = object(raw);
    if (!baseline || !index(baseline.revision)) return this.invalidate();
    const previous = this.attempt;
    this.attempt = undefined;
    this.revision = baseline.revision;
    const active = object(baseline.activeAttempt);
    if (active) {
      if (typeof active.attemptId !== 'string' || !index(active.turn) || !index(active.step)
          || !index(active.nextIndex) || !index(active.startedAfterSeq) || !Array.isArray(active.stream)) return this.invalidate(previous);
      const a: Attempt = { id: active.attemptId, turn: active.turn, step: active.step, nextIndex: 0, text: '', reasoning: '', blocks: new Map() };
      for (const rawRecord of active.stream) {
        const r = object(rawRecord);
        if (!r) return this.invalidate(previous);
        if (r.type === 'chunk') {
          if (!this.chunk(a, r.chunk)) return this.invalidate(previous);
          a.nextIndex += 1;
        } else if (r.type === 'text-chunks' || r.type === 'reasoning-chunks' || r.type === 'tool-call-chunks') {
          const members = r.type === 'tool-call-chunks' ? r.args : r.texts;
          if (!Array.isArray(members) || !members.length || !members.every((s) => typeof s === 'string')
              || !Array.isArray(r.dt) || r.dt.length !== members.length - 1 || !index(r.index)) return this.invalidate(previous);
          if (r.type !== 'tool-call-chunks' && !this.chunk(a, {
            type: r.type === 'text-chunks' ? 'text-delta' : 'reasoning-delta', index: r.index, text: members.join(''),
          })) return this.invalidate(previous);
          a.nextIndex += members.length;
        } else return this.invalidate(previous);
      }
      if (a.nextIndex !== active.nextIndex) return this.invalidate(previous);
      this.attempt = a;
    }
    // Upstream restarts its attempt counter with each Agent lifecycle. The
    // durable turn/step disambiguates an ID reused after a host/agent restart.
    const replaced = previous && (previous.id !== this.attempt?.id
      || previous.turn !== this.attempt?.turn || previous.step !== this.attempt?.step);
    return [...(replaced ? this.resetMessages() : []), ...this.messages()];
  }

  frame(raw: unknown): AgentMessage[] {
    if (this.suspended) return [];
    const f = object(raw);
    if (!f || !index(f.revision) || typeof f.attemptId !== 'string') return this.invalidate();
    // A new Agent lifecycle starts its own dense revision counter at one.
    if (f.type === 'start' && f.revision === 1 && this.revision !== 0) {
      if (this.attempt?.id === f.attemptId && this.attempt.turn === f.turn && this.attempt.step === f.step) return [];
      const reset = this.invalidate(); this.revision = 0;
      return [...reset, ...this.frame(f)];
    }
    if (f.revision <= this.revision) return [];
    if (f.revision !== this.revision + 1) { this.revision = f.revision; return this.invalidate(); }
    this.revision = f.revision;
    if (f.type === 'start') {
      if (!index(f.turn) || !index(f.step) || !index(f.startedAfterSeq)) return this.invalidate();
      const reset = this.invalidate();
      this.attempt = { id: f.attemptId, turn: f.turn, step: f.step, nextIndex: 0, text: '', reasoning: '', blocks: new Map() };
      return reset;
    }
    const a = this.attempt;
    if (!a || a.id !== f.attemptId || f.index !== a.nextIndex) return this.invalidate();
    if (f.type === 'chunk') {
      if (!this.chunk(a, f.chunk)) return this.invalidate();
      a.nextIndex += 1;
      return this.messages();
    }
    if (f.type === 'end') {
      const outcome = object(f.outcome);
      if (outcome?.kind === 'committed' && outcome.eventType === 'assistant/message' && index(outcome.seq)) {
        this.attempt = undefined; return [];
      }
      return this.invalidate();
    }
    return this.invalidate();
  }

  private chunk(a: Attempt, raw: unknown): boolean {
    const c = object(raw);
    if (!c || typeof c.type !== 'string') return false;
    if (c.type === 'text-delta' || c.type === 'reasoning-delta') {
      if (typeof c.text !== 'string' || !index(c.index)) return false;
      const kind = c.type === 'text-delta' ? 'text' : 'reasoning';
      const previous = a.blocks.get(c.index);
      if (previous && previous.kind !== kind) return false;
      a.blocks.set(c.index, { kind, text: (previous?.text ?? '') + c.text });
    } else if (c.type === 'block-end') {
      const b = object(c.block);
      if (!b || !index(c.index)) return false;
      if (b.type === 'text' || b.type === 'reasoning') {
        if (typeof b.text !== 'string') return false;
        a.blocks.set(c.index, { kind: b.type, text: b.text });
      }
    } else if (!['block-start', 'tool-call-delta', 'usage', 'finish'].includes(c.type)) {
      return false;
    }
    const blocks = [...a.blocks.entries()].sort(([left], [right]) => left - right).map(([, b]) => b);
    a.text = blocks.filter((b) => b.kind === 'text').map((b) => b.text).join('');
    a.reasoning = blocks.filter((b) => b.kind === 'reasoning').map((b) => b.text).join('');
    return a.text.length + a.reasoning.length <= MAX_TEXT;
  }
  private invalidate(previous = this.attempt): AgentMessage[] {
    this.attempt = undefined;
    return previous && (previous.text || previous.reasoning) ? this.resetMessages() : [];
  }
  private resetMessages(): AgentMessage[] { return [{ type: 'history-reset' }]; }
}
