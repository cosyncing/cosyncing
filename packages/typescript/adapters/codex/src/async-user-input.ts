/**
 * Codex asynchronous user-input questions (the `request_user_input_async` tool).
 *
 * Measured against installed Codex 0.154.0 (2026-09-14), no feature flags required:
 *
 * - The model's tool call surfaces on the live stream as an `agentMessage` thread item with
 *   `delivery: "async"` and `questions: [{ title, options: string[] | null }]`. The FULL question
 *   set is present on `item/started` and repeated identically on `item/completed`; the item id is
 *   the tool call id (`call_*`), stable across both. No `item/agentMessage/delta` is ever emitted
 *   for the item, but its `text` repeats the question as plain markdown ("Q\n- A\n- B"), which the
 *   question card already renders — so the text must NOT also become a model-output message.
 * - The agent keeps working without waiting. A client answer arrives "as a new user message"
 *   (native tool description): mid-turn via `turn/steer` (accepted with the SAME turn id and
 *   consumed at the next input boundary), after turn end as an ordinary new turn. The durable
 *   answer text used `> <title>\n\n<answer>` blocks; Codex 0.163 also writes a structured
 *   `send_user_message_question_reply` envelope carrying the tool-call id and question index.
 * - The durable rollout stores the question as `event_msg/item_completed` with a PascalCase
 *   `AgentMessage` item carrying the same `delivery`/`questions`, plus a
 *   `response_item/function_call` named `request_user_input_async` whose arguments carry the same
 *   questions and whose output is always `{"accepted":true}` (the tool returns immediately).
 * - Skip (Esc / ctrl+]) records NOTHING — no wire event, no rollout line — and a resumed thread
 *   does NOT re-queue pending async questions natively. A terminal answer is therefore observable
 *   only as the recorded `> <title>` user message; a terminal skip is not observable at all.
 */
import type { AgentMessage } from '@cosyncing/adapter-api';

/** One native async question: the card title plus suggested answers (null = free-text only). */
export interface CodexAsyncQuestion {
  title: string;
  options: string[] | null;
}

export interface CodexAsyncQuestionEntry {
  requestId: string;
  /** Native item id (the `request_user_input_async` tool call id) this question came from. */
  itemId: string;
  /** Turn that produced the question. Async questions OUTLIVE it: a late answer starts a new turn. */
  turnId: string;
  questions: CodexAsyncQuestion[];
}

const REQUEST_PREFIX = 'codex:aq:';

/** Canonical request identity for one async question item. Native item identity only — never the
 *  question prose — so a repeated delivery (started/completed) or a history re-read cannot mint a
 *  second card for the same question. */
export function asyncQuestionRequestId(itemId: string): string {
  return `${REQUEST_PREFIX}${itemId}`;
}

export function isAsyncQuestionRequestId(requestId: string): boolean {
  return requestId.startsWith(REQUEST_PREFIX);
}

/**
 * Parse the async-question payload off an agent-message thread item. Accepts both the live v2
 * shape (`type: "agentMessage"`) and the durable rollout item (`type: "AgentMessage"`); the
 * `delivery`/`questions` fields are spelled identically in both. Returns undefined for ordinary
 * assistant text, non-async deliveries, and malformed payloads (a missing/empty title is not a
 * renderable question).
 */
export function asyncQuestionsFromAgentItem(item: any): CodexAsyncQuestion[] | undefined {
  if (!item || typeof item !== 'object') return undefined;
  if (item.type !== 'agentMessage' && item.type !== 'AgentMessage') return undefined;
  if (item.delivery !== 'async') return undefined;
  const raw = item.questions;
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  const questions: CodexAsyncQuestion[] = [];
  for (const q of raw) {
    const title = typeof q?.title === 'string' ? q.title : '';
    if (!title.trim()) return undefined;
    const options = Array.isArray(q?.options)
      ? q.options.filter((o: unknown): o is string => typeof o === 'string' && o.length > 0)
      : null;
    questions.push({ title, options: options?.length ? options : null });
  }
  return questions;
}

/** True when a rollout/live function call is the async-question tool itself. The question card
 *  (from the agent item) covers it; the call and its `{"accepted":true}` output must not render as
 *  a raw-JSON tool card. */
export function isAsyncQuestionToolCall(name: unknown): boolean {
  return name === 'request_user_input_async';
}

/** The canonical card. Async questions never block the turn: `blocking: false` keeps the broker
 *  from forcing `needs-input` while the agent continues. */
export function asyncQuestionCard(
  requestId: string,
  questions: CodexAsyncQuestion[],
  readOnly?: boolean,
): Extract<AgentMessage, { type: 'question-request' }> {
  return {
    type: 'question-request',
    requestId,
    blocking: false,
    ...(readOnly ? { readOnly: true } : {}),
    questions: questions.map((q) => ({
      question: q.title,
      options: (q.options ?? []).map((label) => ({ label })),
    })),
  };
}

/**
 * Serialize card answers the way the native TUI writes them: one `> <title>` quote block per
 * answered question followed by the answer text, blocks separated by a blank line. Questions with
 * no answer are omitted; a fully empty submission serializes to '' and must not be sent at all.
 */
export function serializeAsyncAnswers(questions: CodexAsyncQuestion[], answers: string[][]): string {
  const blocks: string[] = [];
  for (let i = 0; i < questions.length; i++) {
    const chosen = (answers[i] ?? []).map((a) => String(a).trim()).filter(Boolean);
    if (!chosen.length) continue;
    blocks.push(`> ${questions[i]!.title}\n\n${chosen.join(', ')}`);
  }
  return blocks.join('\n\n');
}

/**
 * Whether a live user message IS the native answer to the given question. The measured durable
 * form is exactly `> <title>\n\n<answer>`; matching that shape (and nothing looser) is how a
 * terminal-side answer resolves the app card without ever treating an arbitrary later message as
 * an answer.
 */
export function isAsyncAnswerText(title: string, userText: string): boolean {
  const prefix = `> ${title}\n\n`;
  return userText.startsWith(prefix) && userText.slice(prefix.length).trim().length > 0;
}

/** A native reply names the exact tool-call item and question index (Codex 0.163). */
export interface CodexStructuredQuestionAnswer {
  itemId: string;
  index: number;
  title: string;
  answer: string;
}

/** Parses only the complete native envelope, never quoted prose or embedded examples. */
export function structuredAsyncAnswers(text: string): CodexStructuredQuestionAnswer[] | undefined {
  const match = /^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/.exec(text.trim());
  if (!match || text.length > 262144) return undefined;
  try {
    const rows = JSON.parse(match[1]!);
    if (!Array.isArray(rows) || !rows.length || rows.length > 128) return undefined;
    const out: CodexStructuredQuestionAnswer[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (typeof row?.questionItemId !== 'string' || typeof row.answer !== 'string'
        || !row.answer.trim() || typeof row.question !== 'string') return undefined;
      const identity = JSON.parse(row.questionItemId);
      if (!Array.isArray(identity) || identity.length !== 3 || identity[0] !== 'request_user_input_async'
        || typeof identity[1] !== 'string' || !identity[1] || identity[1].length > 256
        || !Number.isSafeInteger(identity[2]) || identity[2] < 0 || identity[2] >= 128) return undefined;
      const key = JSON.stringify(identity);
      if (seen.has(key)) return undefined;
      seen.add(key);
      out.push({ itemId: identity[1], index: identity[2], title: row.question, answer: row.answer });
    }
    return out;
  } catch { return undefined; }
}

/**
 * Connection-local pending registry for async questions. Lifecycle is deliberately separate from
 * the RPC `pendingQuestions` map: an async question survives the turn that asked it (a late answer
 * simply opens a new turn), so turn-end settlement must NOT resolve these. They leave the map only
 * when answered through this connection, dismissed locally, exactly matched by a native answer
 * echo, or when the connection closes.
 */
export class CodexAsyncQuestionTracker {
  constructor(private readonly budget = Number.POSITIVE_INFINITY) {}
  private readonly answerValues = new Map<string, Map<number, string[]>>();
  private readonly settlements = new Map<string, string[][]>();

  /** Selected answers retained briefly for live/history resolution frames. */
  answersFor(requestId: string): string[][] | undefined { return this.settlements.get(requestId); }
  private readonly pending = new Map<string, CodexAsyncQuestionEntry>();
  // Keep native identities after settlement: a delayed item/completed cannot reopen a card.
  private readonly seen = new Set<string>();
  private readonly answered = new Map<string, Set<number>>();
  private readonly seenUserMessages = new Set<string>();
  private readonly submissions = new Map<string, { result: Promise<boolean> }>();
  // A transport failure leaves acceptance uncertain. Retain every attempted text until native
  // evidence settles the card, including earlier attempts when a user retries with new answers.
  private readonly submittedTexts = new Map<string, Set<string>>();

  /** Independent history evidence at a rollout boundary. Live submissions and their uncertain
   * acceptance never transfer into a history reader. */
  cloneForHistory(): CodexAsyncQuestionTracker {
    const copy = new CodexAsyncQuestionTracker(this.budget);
    for (const [id, entry] of this.pending) copy.pending.set(id, {
      ...entry,
      questions: entry.questions.map((question) => ({
        ...question, options: question.options ? [...question.options] : null,
      })),
    });
    for (const id of this.seen) copy.seen.add(id);
    for (const key of this.seenUserMessages) copy.seenUserMessages.add(key);
    for (const [id, indices] of this.answered) copy.answered.set(id, new Set(indices));
    for (const [id, values] of this.answerValues) copy.answerValues.set(id,
      new Map([...values].map(([index, answers]) => [index, [...answers]])));
    for (const [id, answers] of this.settlements) copy.settlements.set(id,
      answers.map((values) => [...values]));
    return copy;
  }

  observe(item: any, turnId: string): AgentMessage | undefined {
    const questions = asyncQuestionsFromAgentItem(item);
    if (!questions) return undefined;
    const itemId = typeof item?.id === 'string' && item.id ? item.id : undefined;
    if (!itemId) return undefined;
    const requestId = asyncQuestionRequestId(itemId);
    if (this.seen.has(requestId)) return undefined;
    this.seen.add(requestId);
    this.pending.set(requestId, { requestId, itemId, turnId, questions });
    while (this.seen.size > this.budget) {
      const oldest = this.seen.values().next().value!;
      this.seen.delete(oldest);
      this.settle(oldest);
    }
    return asyncQuestionCard(requestId, questions);
  }

  /** Native structured answers carry exact identities; older quote blocks require a unique
   *  title match. Keep the card open until every question has an answer. */
  resolveFromUserText(text: string, messageKey: string, acceptedHistory = false): string[] {
    if (this.seenUserMessages.has(messageKey)) return [];
    this.seenUserMessages.add(messageKey);
    while (this.seenUserMessages.size > this.budget * 4) this.seenUserMessages.delete(this.seenUserMessages.values().next().value!);
    const structured = structuredAsyncAnswers(text);
    if (structured) {
      const resolved: string[] = [];
      for (const reply of structured) {
        const requestId = asyncQuestionRequestId(reply.itemId);
        const entry = this.pending.get(requestId);
        if (!entry || entry.questions[reply.index]?.title !== reply.title) continue;
        const answered = this.answered.get(requestId) ?? new Set<number>();
        const values = this.answerValues.get(requestId) ?? new Map<number, string[]>();
        answered.add(reply.index);
        values.set(reply.index, [reply.answer]);
        this.answered.set(requestId, answered);
        this.answerValues.set(requestId, values);
        if (answered.size === entry.questions.length && this.settle(requestId)) resolved.push(requestId);
      }
      return resolved;
    }
    // An exact echo of this connection's submitted text also covers compound card answers.
    const submitted = [...this.submittedTexts].filter(([id, texts]) =>
      this.pending.has(id) && texts.has(text));
    if (submitted.length === 1) {
      const requestId = submitted[0]![0];
      this.settle(requestId);
      return [requestId];
    }
    // A durable accepted follow-up can contain the whole set. Never use that inferred
    // correlation to settle LIVE authority after a rejected/uncertain submission.
    const compound: { entry: CodexAsyncQuestionEntry; values: string[] }[] = [];
    for (const entry of this.pending.values()) {
      if (!acceptedHistory || entry.questions.length < 2) continue;
      let rest = text;
      const values: string[] = [];
      for (let index = 0; index < entry.questions.length; index++) {
        const prefix = `> ${entry.questions[index]!.title}\n\n`;
        if (!rest.startsWith(prefix)) break;
        rest = rest.slice(prefix.length);
        const next = entry.questions[index + 1];
        const boundary = next ? rest.indexOf(`\n\n> ${next.title}\n\n`) : rest.length;
        if (boundary < 0 || !rest.slice(0, boundary).trim()) break;
        values.push(rest.slice(0, boundary).trim());
        rest = rest.slice(boundary + (next ? 2 : 0));
      }
      if (values.length === entry.questions.length && !rest) compound.push({ entry, values });
    }
    if (compound.length === 1) {
      const { entry, values } = compound[0]!;
      this.answerValues.set(entry.requestId, new Map(values.map((value, index) => [index, [value]])));
      this.settle(entry.requestId);
      return [entry.requestId];
    }
    const matches: { entry: CodexAsyncQuestionEntry; index: number }[] = [];
    for (const entry of this.pending.values()) {
      entry.questions.forEach((q, index) => {
        if (isAsyncAnswerText(q.title, text)) matches.push({ entry, index });
      });
    }
    // Repeated titles are ambiguous, including two questions in the same card. Do not guess.
    if (matches.length !== 1) return [];
    const { entry, index } = matches[0]!;
    const answered = this.answered.get(entry.requestId) ?? new Set<number>();
    answered.add(index);
    const values = this.answerValues.get(entry.requestId) ?? new Map<number, string[]>();
    values.set(index, [text.slice(`> ${entry.questions[index]!.title}\n\n`.length).trim()]);
    this.answerValues.set(entry.requestId, values);
    this.answered.set(entry.requestId, answered);
    if (answered.size !== entry.questions.length) return [];
    this.settle(entry.requestId);
    return [entry.requestId];
  }

  /** Keep the card replayable until acceptance. Concurrent submissions share the outcome;
   *  only the first caller emits settlement, and a failed send leaves the same card retryable. */
  async answer(requestId: string, answers: string[][], send: (text: string, isPending: () => boolean) => Promise<void>): Promise<boolean> {
    const existing = this.submissions.get(requestId);
    if (existing) {
      await existing.result;
      return false;
    }
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    const isPending = () => this.pending.get(requestId) === entry;
    const text = serializeAsyncAnswers(entry.questions, answers);
    const texts = this.submittedTexts.get(requestId) ?? new Set<string>();
    const alreadyUncertain = texts.has(text);
    if (text) {
      texts.add(text);
      this.submittedTexts.set(requestId, texts);
    }
    const submission = Promise.resolve().then(async () => {
      // A delayed echo may settle the old attempt before a queued retry begins sending.
      if (!isPending()) return false;
      // The transport must also check at its queue head and after any recovery await.
      if (text) await send(text, isPending);
      return isPending() && this.settle(requestId);
    }).catch((error: unknown) => {
      // A native user-message echo can prove acceptance before a lost RPC reply. Never restore
      // or report failure for a card that authoritative live evidence has already settled.
      if (this.seen.has(requestId) && !this.pending.has(requestId)) return false;
      // A native RPC rejection proves this attempt was refused. It says nothing about an
      // earlier timed-out attempt with the same text, whose echo can still arrive later.
      if (error instanceof Error && (error as Error & { rpcRejected?: boolean }).rpcRejected === true && !alreadyUncertain) {
        texts.delete(text);
        if (!texts.size) this.submittedTexts.delete(requestId);
      }
      throw error;
    }).finally(() => { this.submissions.delete(requestId); });
    this.submissions.set(requestId, { result: submission });
    return submission;
  }

  /** Whether a decision for [requestId] can still reach Codex: its card is pending, or an answer
   *  to it is being sent (a concurrent decision shares that outcome). */
  isOpen(requestId: string): boolean {
    return this.pending.has(requestId) || this.submissions.has(requestId);
  }

  async dismiss(requestId: string): Promise<boolean> {
    // A competing dismiss shares the answer's outcome instead of acknowledging a failed send.
    const submission = this.submissions.get(requestId);
    if (submission) {
      await submission.result;
      return false;
    }
    return this.settle(requestId);
  }

  private settle(requestId: string): boolean {
    const entry = this.pending.get(requestId);
    const values = this.answerValues.get(requestId);
    if (entry && values?.size === entry.questions.length) {
      this.settlements.set(requestId, entry.questions.map((_, index) => values.get(index) ?? []));
      while (this.settlements.size > Math.min(this.budget, 256)) this.settlements.delete(this.settlements.keys().next().value!);
    }
    this.answerValues.delete(requestId);
    this.answered.delete(requestId);
    this.submittedTexts.delete(requestId);
    return this.pending.delete(requestId);
  }

  cards(): AgentMessage[] {
    return [...this.pending.values()].map((entry) => asyncQuestionCard(entry.requestId, entry.questions));
  }

  clear(): void {
    this.pending.clear();
    this.answerValues.clear();
    this.settlements.clear();
    this.seen.clear();
    this.answered.clear();
    this.seenUserMessages.clear();
    this.submissions.clear();
    this.submittedTexts.clear();
  }
}
