import { strict as assert } from 'node:assert';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentMessage, AttachMode, HistorySourceIdentity, SessionConnection } from '@cosyncing/adapter-api';
import { AgentRegistry, isNativeSessionRenameUnsupportedError } from '@cosyncing/adapter-api';
import { ClineAdapter } from '../src/implementation.ts';
import { ClineHubDriveConnection } from '../src/hub-drive.ts';
import type { ClineTerminalSummary } from '../src/mapping.ts';
import { Hub } from '../../../broker/src/sessions/hub.ts';
import { AttentionPolicy } from '../../../broker/src/attention/attention-policy.ts';
import { AttentionStore } from '../../../broker/src/attention/attention-store.ts';
import {
  CLINE_HUB_CORE_MINIMUM_VERSION,
  CLINE_HUB_MAX_FRAME_BYTES,
  CLINE_HUB_PROTOCOL_VERSION,
  ClineHubClient,
  clineHubCoreVersionSupported,
  clineHubEpoch,
  clineHubHistoryIdentity,
  probeClineHub,
  readClineHubDiscovery,
  type ClineHubSocketFactory,
  type ClineHubSocketLike,
} from '../src/hub.ts';
import {
  CLINE_MEASURED_HUB_CORE,
  CLINE_MEASURED_VERSIONS,
  CLINE_MINIMUM_SUPPORTED_VERSION,
  clineNativeMessageDigest,
  clineVersionAllowsDrive,
} from '../src/store.ts';
import type { ClineNativeMessage, ClinePromptCorrelation } from '../src/store.ts';
import { buildFakeClineAcp } from './fixtures/fake-acp.ts';

let passed = 0;
function check(name: string, condition: unknown, detail = ''): void {
  assert.ok(condition, `${name}${detail ? ` — ${detail}` : ''}`);
  passed += 1;
  console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}

type Listener = (event: any) => void;
type RunSummary = Extract<AgentMessage, { type: 'run-summary' }>;

function runSummaries(rows: readonly AgentMessage[], key?: string): RunSummary[] {
  return rows.filter((row): row is RunSummary => row.type === 'run-summary'
    && (key === undefined || row.key === key));
}

function hasRunningSummary(rows: readonly AgentMessage[]): boolean {
  return runSummaries(rows).some((row) => row.status === 'running');
}

/** The run-summary frames a turn published, as `status@key` in emission order. */
function runShape(rows: readonly AgentMessage[]): string {
  return JSON.stringify(runSummaries(rows).map((row) => `${row.status}@${row.key}`));
}

class FakeHub {
  readonly sessionId = '1787424308272_2eapl';
  readonly messages: ClineNativeMessage[] = [];
  readonly frames: Array<Record<string, any>> = [];
  readonly protocols: string[][] = [];
  private sockets = new Set<FakeSocket>();
  latestSocket?: FakeSocket;
  private sequence = 0;
  private runCounter = 0;
  private status: string | undefined = 'idle';
  private created = false;
  private abortSucceeds = true;
  private abortRepliesToRun = true;
  private deferNextRunPersistence = false;
  private extraUserBlockNext = false;
  private toolResultNext = false;
  private omitNextAssistant = false;
  private lateUsageNext = false;
  private sessionUpdateMode: 'persist' | 'refuse' | 'lie' = 'persist';
  private rejectNextSessionGet = false;
  private sessionMetadata?: Record<string, any>;
  private snapshotFailureNext?: {
    text: string;
    persistence: 'exact' | 'missing' | 'mismatch';
    terminalBeforeStarted?: boolean;
    commandFails?: boolean;
    terminal?: 'run.failed' | 'run.aborted';
  };
  private heldNextRunPersistence?: { received: () => void; release: Promise<void> };
  private delayedSessionUpdate?: { received: () => void; release: Promise<void> };
  allApprovalsRejected = false;
  private pendingRun?: {
    socket: FakeSocket;
    envelope: Record<string, any>;
    prompt: string;
    userId: string;
    deferPersistence?: boolean;
    extraUserBlock?: boolean;
    toolResultTurn?: boolean;
    omitAssistant?: boolean;
    lateUsage?: boolean;
    trailingAssistantGate?: { received: () => void; release: Promise<void> };
    persistenceGate?: { received: () => void; release: Promise<void> };
  };
  private deferredRun?: { socket: FakeSocket; envelope: Record<string, any> };
  private delayedMessages?: { received: () => void; release: Promise<void> };
  private delayedCreate?: { received: () => void; release: Promise<void> };
  private delayedCreatedReply?: { received: () => void; release: Promise<void> };
  private trailingAssistantNext?: { received: () => void; release: Promise<void> };

  constructor(readonly profile: string, readonly cwd: string) {}


  socketFactory: ClineHubSocketFactory = (url, protocols) => {
    assert.equal(url, 'ws://127.0.0.1:25464/hub');
    this.protocols.push([...protocols]);
    const socket = new FakeSocket(this);
    this.latestSocket = socket;
    this.sockets.add(socket);
    queueMicrotask(() => socket.emit('open', {}));
    return socket;
  };

  close(socket: FakeSocket, code = 1000): void {
    if (!this.sockets.delete(socket)) return;
    socket.emit('close', { code });
  }

  receive(socket: FakeSocket, raw: string): void {
    const frame = JSON.parse(raw) as Record<string, any>;
    this.frames.push(frame);
    if (frame.kind === 'stream.subscribe') {
      if (this.status === 'running') {
        this.event('approval.requested', this.sessionId, {
          approvalId: 'orphan-approval',
          toolCallId: 'orphan-tool',
          toolName: 'write_to_file',
          inputJson: '{"path":"orphan.txt"}',
          policy: 'ask',
        });
      }
      return;
    }
    const envelope = frame.envelope as Record<string, any>;
    const command = envelope.command as string;
    const payload = envelope.payload as Record<string, any>;
    const reply = (value: Record<string, unknown> = {}) => socket.message({
      kind: 'reply',
      envelope: {
        version: CLINE_HUB_PROTOCOL_VERSION,
        requestId: envelope.requestId,
        ok: true,
        payload: value,
      },
    });
    if (command === 'client.register') {
      reply({ clientId: payload.clientId });
      return;
    }
    if (command === 'client.unregister') {
      reply({ clientId: envelope.clientId });
      return;
    }
    if (command === 'session.create') {
      const create = () => {
        if (!this.created) {
          this.created = true;
          this.writeStore(payload);
        }
        const respond = () => {
          reply({ session: { sessionId: this.sessionId }, snapshot: { sessionId: this.sessionId } });
          this.event('session.created', this.sessionId, { session: { sessionId: this.sessionId } });
        };
        const delayedReply = this.delayedCreatedReply;
        if (delayedReply) {
          this.delayedCreatedReply = undefined;
          delayedReply.received();
          void delayedReply.release.then(respond);
        } else {
          respond();
        }
      };
      const delayed = this.delayedCreate;
      if (delayed) {
        this.delayedCreate = undefined;
        delayed.received();
        void delayed.release.then(create);
      } else {
        create();
      }
      return;
    }
    if (command === 'session.messages') {
      const respond = () => reply({ sessionId: this.sessionId, messages: structuredClone(this.messages) });
      const delayed = this.delayedMessages;
      if (delayed) {
        this.delayedMessages = undefined;
        delayed.received();
        void delayed.release.then(respond);
      } else {
        respond();
      }
      return;
    }
    if (command === 'session.get') {
      if (this.rejectNextSessionGet) {
        this.rejectNextSessionGet = false;
        socket.message({
          kind: 'reply',
          envelope: {
            version: CLINE_HUB_PROTOCOL_VERSION,
            requestId: envelope.requestId,
            ok: false,
            error: { code: 'session_get_failed', message: 'fixture rejected session.get' },
          },
        });
        return;
      }
      reply({ session: { sessionId: this.sessionId, status: this.status, metadata: this.sessionMetadata?.metadata } });
      return;
    }
    if (command === 'session.update') {
      const mode = this.sessionUpdateMode;
      const update = () => {
        if (mode === 'refuse') {
          socket.message({
            kind: 'reply',
            envelope: {
              version: CLINE_HUB_PROTOCOL_VERSION,
              requestId: envelope.requestId,
              ok: false,
              error: { code: 'session_update_failed', message: 'fixture refused update' },
            },
          });
          return;
        }
        if (mode === 'persist') {
          this.sessionMetadata = {
            ...this.sessionMetadata,
            metadata: { ...(this.sessionMetadata?.metadata ?? {}), ...(payload.metadata ?? {}) },
          };
          this.writeMetadata();
        }
        reply({ updated: true, session: { sessionId: this.sessionId, metadata: payload.metadata } });
      };
      const delayed = this.delayedSessionUpdate;
      if (delayed) {
        this.delayedSessionUpdate = undefined;
        delayed.received();
        void delayed.release.then(update);
      } else {
        update();
      }
      return;
    }
    if (command === 'near.limit') {
      reply({ padding: 'x'.repeat(32 * 1024 * 1024) });
      return;
    }
    if (command === 'run.start') {
      this.runCounter += 1;
      const userId = `user-${this.runCounter}`;
      const deferPersistence = this.deferNextRunPersistence;
      const extraUserBlock = this.extraUserBlockNext;
      const omitAssistant = this.omitNextAssistant;
      const trailingAssistantGate = this.trailingAssistantNext;
      const persistenceGate = this.heldNextRunPersistence;
      const snapshotFailure = this.snapshotFailureNext;
      const toolResultTurn = this.toolResultNext;
      const lateUsage = this.lateUsageNext;
      this.lateUsageNext = false;
      this.deferNextRunPersistence = false;
      this.extraUserBlockNext = false;
      this.toolResultNext = false;
      this.omitNextAssistant = false;
      this.trailingAssistantNext = undefined;
      this.heldNextRunPersistence = undefined;
      this.snapshotFailureNext = undefined;
      if (payload.delivery === 'queue') {
        this.status = 'running';
        this.messages.push({
          id: userId,
          role: 'user',
          content: [{ type: 'text', text: String(payload.prompt) }],
        });
        this.writeMessages();
        this.event('run.started', this.sessionId, {
          clientId: envelope.clientId,
          runId: `run-${this.runCounter}`,
        });
        this.event('session.pending_prompt_submitted', this.sessionId, {
          clientId: envelope.clientId,
        });
        reply({ snapshot: { sessionId: this.sessionId } });
        queueMicrotask(() => {
          this.status = 'idle';
          if (toolResultTurn) {
            // The measured shape of a tool-using Cline turn: the assistant's tool_use, then the
            // tool result persisted as its own `role: 'user'` row, then the reply.
            this.messages.push({
              id: `assistant-tool-${this.runCounter}`,
              role: 'assistant',
              modelInfo: { provider: 'openai-compatible', id: 'fixture-model' },
              content: [{ type: 'tool_use', id: `tool-${this.runCounter}`, name: 'read_file', input: {} }],
            });
            this.messages.push({
              id: `tool-result-${this.runCounter}`,
              role: 'user',
              content: [{
                type: 'tool_result',
                tool_use_id: `tool-${this.runCounter}`,
                name: 'read_file',
                content: 'fixture file body',
              }],
            });
          }
          this.messages.push({
            id: `assistant-${this.runCounter}`,
            role: 'assistant',
            modelInfo: { provider: 'openai-compatible', id: 'fixture-model' },
            content: [{ type: 'text', text: `answer:${String(payload.prompt)}` }],
          });
          this.writeMessages();
          // Real Cline streams an answer as many small deltas — measured at 43 events for 128
          // characters. Emitting it as a single event hides every row-identity defect, so chunk it.
          for (const chunk of `answer:${String(payload.prompt)}`.match(/.{1,4}/gu) ?? []) {
            this.event('assistant.delta', this.sessionId, { text: chunk });
          }
          this.event('usage.updated', this.sessionId, { totals: { inputTokens: 11, outputTokens: 7 } });
          this.event('agent.done', this.sessionId, { reason: 'completed' });
        });
        return;
      }
      if (snapshotFailure) {
        this.status = 'idle';
        if (snapshotFailure.persistence !== 'missing') {
          this.messages.push({
            id: userId,
            role: 'user',
            content: [{
              type: 'text',
              text: snapshotFailure.persistence === 'exact'
                ? String(payload.prompt)
                : 'foreign replacement prompt',
            }],
          });
          this.writeMessages();
        }
        const started = () => this.event('run.started', this.sessionId, {
          clientId: envelope.clientId,
          runId: `run-${this.runCounter}`,
        });
        const failed = () => this.event(snapshotFailure.terminal ?? 'run.failed', this.sessionId, {
          reason: 'error',
          error: snapshotFailure.text,
          text: snapshotFailure.text,
          snapshot: { sessionId: this.sessionId },
        });
        if (snapshotFailure.terminalBeforeStarted) {
          failed();
          started();
        } else {
          started();
          failed();
        }
        if (snapshotFailure.commandFails) {
          socket.message({
            kind: 'reply',
            envelope: {
              version: CLINE_HUB_PROTOCOL_VERSION,
              requestId: envelope.requestId,
              ok: false,
              error: { code: 'command_failed', message: snapshotFailure.text },
            },
          });
        } else {
          reply({ snapshot: { sessionId: this.sessionId } });
        }
        return;
      }
      this.pendingRun = {
        socket,
        envelope,
        prompt: String(payload.prompt),
        userId,
        deferPersistence,
        extraUserBlock,
        toolResultTurn,
        omitAssistant,
        lateUsage,
        trailingAssistantGate,
        persistenceGate,
      };
      this.status = 'running';
      if (!deferPersistence) {
        this.messages.push({
          id: userId,
          role: 'user',
          content: [
            { type: 'text', text: String(payload.prompt) },
            ...(extraUserBlock ? [{ type: 'text', text: 'unexpected foreign block' }] : []),
          ],
        });
        this.writeMessages();
      }
      this.event('run.started', this.sessionId, { clientId: envelope.clientId, runId: `run-${this.runCounter}` });
      this.event('approval.requested', this.sessionId, {
        approvalId: `approval-${this.runCounter}`,
        toolCallId: `tool-${this.runCounter}`,
        toolName: 'write_to_file',
        inputJson: '{"path":"fixture.txt"}',
        policy: 'ask',
      });
      return;
    }
    if (command === 'approval.respond') {
      assert.equal(payload.payload, undefined);
      reply({ approvalId: payload.approvalId, approved: payload.approved });
      this.event('approval.resolved', this.sessionId, {
        approvalId: payload.approvalId,
        approved: payload.approved,
      });
      const run = this.pendingRun;
      if (payload.approved !== true) return;
      assert.equal(payload.reason, 'Approved in cosyncing.');
      assert.ok(run);
      this.pendingRun = undefined;
      this.status = 'idle';
      const persist = () => {
        if (run.deferPersistence) {
          this.messages.push({
            id: run.userId,
            role: 'user',
            content: [
              { type: 'text', text: run.prompt },
              ...(run.extraUserBlock ? [{ type: 'text', text: 'unexpected foreign block' }] : []),
            ],
          });
        }
        if (run.toolResultTurn) {
          // The measured shape of a tool-using Cline turn: the assistant's tool_use, then the tool
          // result persisted as its own `role: 'user'` row, then the reply.
          this.messages.push({
            id: `assistant-tool-${this.runCounter}`,
            role: 'assistant',
            modelInfo: { provider: 'openai-compatible', id: 'fixture-model' },
            content: [{ type: 'tool_use', id: `tool-${this.runCounter}`, name: 'read_file', input: {} }],
          });
          this.messages.push({
            id: `tool-result-${this.runCounter}`,
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: `tool-${this.runCounter}`,
              name: 'read_file',
              content: 'fixture file body',
            }],
          });
        }
        if (!run.omitAssistant) {
          this.messages.push(
            {
              id: `assistant-${this.runCounter}`,
              role: 'assistant',
              modelInfo: { provider: 'openai-compatible', id: 'fixture-model' },
              content: [{ type: 'text', text: `answer:${run.prompt}` }],
            },
          );
        }
        this.writeMessages();
        if (!run.omitAssistant) {
          for (const chunk of `answer:${run.prompt}`.match(/.{1,4}/gu) ?? []) {
            this.event('assistant.delta', this.sessionId, { text: chunk });
          }
          this.event('usage.updated', this.sessionId, { totals: { inputTokens: 11, outputTokens: 7 } });
        }
      };
      const replyToRun = () => run.socket.message({
        kind: 'reply',
        envelope: {
          version: CLINE_HUB_PROTOCOL_VERSION,
          requestId: run.envelope.requestId,
          ok: true,
          payload: { result: { finishReason: 'completed', text: `answer:${run.prompt}` } },
        },
      });
      if (run.deferPersistence) {
        replyToRun();
        if (run.persistenceGate) {
          run.persistenceGate.received();
          void run.persistenceGate.release.then(persist);
        } else {
          setTimeout(persist, 10);
        }
      } else {
        persist();
        replyToRun();
        if (run.lateUsage) {
          // Cline writes a turn's usage a beat after the reply the settle proof waits for. Land it
          // on an appended assistant row inside the Drive's bounded late-usage poll: after the
          // immediate settle read, before the last re-read at about 400ms.
          setTimeout(() => {
            this.messages.push({
              id: `assistant-usage-${this.runCounter}`,
              role: 'assistant',
              modelInfo: { provider: 'openai-compatible', id: 'fixture-model' },
              content: [{ type: 'text', text: ':usage-tail' }],
              metrics: { inputTokens: 23, outputTokens: 5 },
            });
            this.writeMessages();
          }, 150);
        }
        if (run.trailingAssistantGate) {
          run.trailingAssistantGate.received();
          void run.trailingAssistantGate.release.then(() => {
            this.messages.push({
              id: `assistant-trailing-${this.runCounter}`,
              role: 'assistant',
              modelInfo: { provider: 'openai-compatible', id: 'fixture-model' },
              content: [{ type: 'text', text: ':durable-tail' }],
            });
            this.writeMessages();
          });
        }
      }
      return;
    }
    if (command === 'run.abort' || command === 'session.delete') {
      reply(command === 'session.delete' ? { deleted: true } : { aborted: true });
      if (command === 'run.abort' && this.abortSucceeds) {
        this.status = 'idle';
        this.allApprovalsRejected = true;
      }
      if (command === 'run.abort' && this.abortSucceeds && this.pendingRun) {
        const run = this.pendingRun;
        this.pendingRun = undefined;
        if (this.abortRepliesToRun) {
          run.socket.message({
            kind: 'reply',
            envelope: {
              version: CLINE_HUB_PROTOCOL_VERSION,
              requestId: run.envelope.requestId,
              ok: true,
              payload: { result: { finishReason: 'aborted' } },
            },
          });
        } else {
          // Hold it so a test can deliver it LATE. "Lost" and "late" reach the
          // same demotion, and the difference is the whole question a reader
          // of that read-only session has to answer.
          this.deferredRun = run;
        }
      }
      return;
    }
    if (command === 'capability.respond') {
      reply({ accepted: true });
      return;
    }
    throw new Error(`unexpected fake Hub command ${command}`);
  }

  foreignRun(): void {
    this.status = 'running';
    this.event('run.started', this.sessionId, { clientId: 'foreign-client', runId: 'foreign-run' });
  }

  foreignEnqueue(): void {
    this.status = 'pending';
    this.event('run.enqueued', this.sessionId, { clientId: 'foreign-client', runId: 'foreign-run' });
  }

  orphanRunWithoutPersistence(): void {
    assert.ok(this.latestSocket);
    this.status = 'running';
    this.pendingRun = {
      socket: this.latestSocket,
      envelope: { requestId: 'orphan-run-request' },
      prompt: 'orphan prompt',
      userId: 'orphan-user',
    };
  }

  deliverDeferredRunReply(): void {
    const run = this.deferredRun;
    if (!run) return;
    this.deferredRun = undefined;
    run.socket.message({
      kind: 'reply',
      envelope: {
        version: CLINE_HUB_PROTOCOL_VERSION,
        requestId: run.envelope.requestId,
        ok: true,
        payload: { result: { finishReason: 'aborted' } },
      },
    });
  }

  setAbortSucceeds(value: boolean): void { this.abortSucceeds = value; }
  setAbortRepliesToRun(value: boolean): void { this.abortRepliesToRun = value; }
  setSessionStatus(value: string | undefined): void { this.status = value; }
  failNextSessionGet(): void { this.rejectNextSessionGet = true; }
  setSessionUpdateMode(value: 'persist' | 'refuse' | 'lie'): void { this.sessionUpdateMode = value; }
  setDurableTitle(title: string): void {
    this.sessionMetadata = {
      ...this.sessionMetadata,
      metadata: { ...(this.sessionMetadata?.metadata ?? {}), title },
    };
    this.writeMetadata();
  }
  deferNextCompletedPersistence(): void { this.deferNextRunPersistence = true; }
  addExtraUserBlockToNextRun(): void { this.extraUserBlockNext = true; }
  /** Real Cline persists tool results as `role: 'user'` rows carrying `tool_result` blocks. */
  useToolResultTurnNext(): void { this.toolResultNext = true; }
  omitAssistantFromNextCompletedRun(): void { this.omitNextAssistant = true; }
  landLateUsageAfterNextReply(): void { this.lateUsageNext = true; }
  holdTrailingAssistantAfterNextReply(): { replySent: Promise<void>; release: () => void } {
    let markReplySent!: () => void;
    let release!: () => void;
    const replySent = new Promise<void>((resolve) => { markReplySent = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.trailingAssistantNext = { received: markReplySent, release: gate };
    return { replySent, release };
  }
  failNextRunSnapshotOnly(
    text: string,
    persistence: 'exact' | 'missing' | 'mismatch' = 'exact',
    terminalBeforeStarted = false,
  ): void {
    this.snapshotFailureNext = { text, persistence, terminalBeforeStarted };
  }

  failNextRunCommand(text: string, persistence: 'exact' | 'missing' | 'mismatch' = 'exact'): void {
    this.snapshotFailureNext = { text, persistence, commandFails: true };
  }

  /** A native abort Cosyncing did not request (a native timeout or another stop), reported only
   *  by the owned run's `run.aborted` event. */
  abortNextRunSnapshotOnly(text: string): void {
    this.snapshotFailureNext = { text, persistence: 'exact', terminal: 'run.aborted' };
  }

  holdNextCompletedPersistence(): { replySent: Promise<void>; release: () => void } {
    let markReplySent!: () => void;
    let release!: () => void;
    const replySent = new Promise<void>((resolve) => { markReplySent = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.deferNextRunPersistence = true;
    this.heldNextRunPersistence = { received: markReplySent, release: gate };
    return { replySent, release };
  }

  delayNextMessagesReply(): { received: Promise<void>; release: () => void } {
    let markReceived!: () => void;
    let release!: () => void;
    const received = new Promise<void>((resolve) => { markReceived = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.delayedMessages = { received: markReceived, release: gate };
    return { received, release };
  }

  delayNextCreateReply(): { received: Promise<void>; release: () => void } {
    let markReceived!: () => void;
    let release!: () => void;
    const received = new Promise<void>((resolve) => { markReceived = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.delayedCreate = { received: markReceived, release: gate };
    return { received, release };
  }

  delayNextCreatedReply(): { received: Promise<void>; release: () => void } {
    let markReceived!: () => void;
    let release!: () => void;
    const received = new Promise<void>((resolve) => { markReceived = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.delayedCreatedReply = { received: markReceived, release: gate };
    return { received, release };
  }

  resetCreatedSession(): void {
    this.created = false;
    this.status = 'idle';
    this.messages.length = 0;
    this.sessionMetadata = undefined;
    rmSync(join(this.profile, 'sessions', this.sessionId), { recursive: true, force: true });
  }

  activeSocketCount(): number { return this.sockets.size; }

  delayNextSessionUpdate(): { received: Promise<void>; release: () => void } {
    let markReceived!: () => void;
    let release!: () => void;
    const received = new Promise<void>((resolve) => { markReceived = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.delayedSessionUpdate = { received: markReceived, release: gate };
    return { received, release };
  }

  approvalBurst(count: number): void {
    for (let index = 0; index < count; index += 1) {
      this.event('approval.requested', this.sessionId, {
        approvalId: `burst-approval-${index}`,
        toolCallId: `burst-tool-${index}`,
        toolName: 'write_to_file',
        inputJson: `{"index":${index}}`,
        policy: 'ask',
      });
    }
  }

  rewriteFirstMessage(): void {
    const first = this.messages[0];
    assert.ok(first);
    first.content = [{ type: 'text', text: 'same-id rewritten foreign content' }];
    this.writeMessages();
  }

  snapshotMessages(): ClineNativeMessage[] { return structuredClone(this.messages); }

  restoreMessages(messages: readonly ClineNativeMessage[]): void {
    this.messages.splice(0, this.messages.length, ...structuredClone(messages));
    this.pendingRun = undefined;
    this.status = 'idle';
    this.abortSucceeds = true;
    this.abortRepliesToRun = true;
    this.deferNextRunPersistence = false;
    this.extraUserBlockNext = false;
    this.toolResultNext = false;
    this.omitNextAssistant = false;
    this.snapshotFailureNext = undefined;
    this.heldNextRunPersistence = undefined;
    this.delayedSessionUpdate = undefined;
    this.rejectNextSessionGet = false;
    this.allApprovalsRejected = false;
    this.writeMessages();
  }

  private event(event: string, sessionId: string, payload: Record<string, unknown>): void {
    this.sequence += 1;
    for (const socket of this.sockets) socket.message({
      kind: 'event',
      envelope: {
        version: CLINE_HUB_PROTOCOL_VERSION,
        event,
        eventId: `event-${this.sequence}`,
        sequence: this.sequence,
        sessionId,
        payload,
      },
    });
  }

  private writeStore(create: Record<string, any>): void {
    const sessionDir = join(this.profile, 'sessions', this.sessionId);
    mkdirSync(sessionDir, { recursive: true });
    this.sessionMetadata = {
      session_id: this.sessionId,
      cwd: this.cwd,
      provider: create.modelSelection.provider,
      model: create.modelSelection.model,
      started_at: '2026-09-01T00:00:00.000Z',
      status: 'idle',
      metadata: {
        title: create.metadata.title,
        mode: create.runtimeOptions.mode,
        autoApproveTools: create.runtimeOptions.autoApproveTools,
      },
    };
    this.writeMetadata();
    this.writeMessages();
  }

  private writeMetadata(): void {
    const sessionDir = join(this.profile, 'sessions', this.sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, `${this.sessionId}.json`), `${JSON.stringify(this.sessionMetadata)}\n`);
  }

  private writeMessages(): void {
    const sessionDir = join(this.profile, 'sessions', this.sessionId);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(join(sessionDir, `${this.sessionId}.messages.json`), `${JSON.stringify({
      version: 1,
      agent: 'lead',
      sessionId: this.sessionId,
      // Exact Hub 0.0.81 shape measured from a session.create whose metadata
      // source is cosyncing. This must differ from the terminal CLI fixture.
      origin: { source: 'cosyncing', mode: 'user', sessionId: this.sessionId },
      updated_at: new Date().toISOString(),
      messages: this.messages,
    })}\n`);
  }
}

class FakeSocket implements ClineHubSocketLike {
  readonly readyState = 1;
  private listeners = new Map<string, Set<Listener>>();
  constructor(private readonly hub: FakeHub) {}
  addEventListener(type: 'open' | 'message' | 'error' | 'close', listener: Listener): void {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }
  removeEventListener(type: 'open' | 'message' | 'error' | 'close', listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }
  send(data: string): void { this.hub.receive(this, data); }
  close(code = 1000): void { this.hub.close(this, code); }
  emit(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  message(frame: unknown): void { this.emit('message', { data: JSON.stringify(frame) }); }
  rawMessage(data: string): void { this.emit('message', { data }); }
}

const fake = buildFakeClineAcp();
const profile = join(fake.root, 'managed-cline');
const discoveryPath = join(profile, 'locks', 'hub', 'cosyncing.json');
mkdirSync(join(profile, 'locks', 'hub'), { recursive: true });
writeFileSync(discoveryPath, `${JSON.stringify({
  hubId: 'fixture-hub',
  protocolVersion: CLINE_HUB_PROTOCOL_VERSION,
  capabilities: ['session.create', 'session.run', 'session.abort', 'run.enqueue', 'run.list', 'stream.replay'],
  coreVersion: CLINE_HUB_CORE_MINIMUM_VERSION,
  authToken: 'fixture-owner-token',
  host: '127.0.0.1',
  port: 25464,
  url: 'ws://127.0.0.1:25464/hub',
  pid: process.pid,
  startedAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
})}\n`, { mode: 0o600 });

const fetcher = (async () => new Response(JSON.stringify({
  ok: true,
  draining: false,
  protocolVersion: CLINE_HUB_PROTOCOL_VERSION,
  coreVersion: CLINE_HUB_CORE_MINIMUM_VERSION,
  host: '127.0.0.1',
  port: 25464,
  url: 'ws://127.0.0.1:25464/hub',
}), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof globalThis.fetch;

let brokerSessionHub: Hub | undefined;
try {
  const env: NodeJS.ProcessEnv = {
    ...fake.env,
    COSYNCING_CLINE_PROFILE_DIR: profile,
    COSYNCING_CLINE_HUB_PORT: '25464',
    COSYNCING_CLINE_PROVIDER: 'openai-compatible',
    COSYNCING_CLINE_MODEL: 'fixture-model',
    FAKE_CLINE_MANAGED_DATA_ROOT: profile,
    FAKE_CLINE_MANAGED_SESSION_ID: '1787424308272_2eapl',
  };
  const discovery = await probeClineHub({ env, homeDir: fake.root, fetcher });
  check('owner-only discovery plus exact native health identifies the managed Hub',
    discovery?.hubId === 'fixture-hub');
  const drainingFetcher = (async () => new Response(JSON.stringify({
    ok: true,
    draining: true,
    protocolVersion: CLINE_HUB_PROTOCOL_VERSION,
    coreVersion: CLINE_HUB_CORE_MINIMUM_VERSION,
    host: '127.0.0.1', port: 25464, url: 'ws://127.0.0.1:25464/hub',
  }), { status: 200 })) as unknown as typeof globalThis.fetch;
  check('a draining native Hub fails create readiness despite a successful health response',
    await probeClineHub({ env, homeDir: fake.root, fetcher: drainingFetcher }) === undefined);
  chmodSync(discoveryPath, 0o644);
  check('group/world-readable Hub discovery fails closed',
    await probeClineHub({ env, homeDir: fake.root, fetcher }) === undefined);
  chmodSync(discoveryPath, 0o600);

  // The Hub core floor, end to end.
  //
  // Every fixture above interpolates the CONSTANT as `coreVersion`, on disk and
  // in /health alike, so nothing here had ever fed a Hub off 0.0.82. That is
  // how a half-converted floor survived: `readClineHubDiscovery` was floored
  // while `probeClineHub` kept an exact `!==`, so a Hub one patch above the
  // floor was admitted by the first and refused by the second -- and since
  // `probeClineHub` is the only entry to the managed lane, Create, Drive and
  // Resume went with it. The dev host runs 0.0.82, so no amount of live lane
  // testing could have caught it; it has to be pinned here.
  const writeHubVersion = (coreVersion: string): void => {
    writeFileSync(discoveryPath, `${JSON.stringify({
      hubId: 'fixture-hub',
      protocolVersion: CLINE_HUB_PROTOCOL_VERSION,
      capabilities: ['session.create', 'session.run', 'session.abort', 'run.enqueue', 'run.list', 'stream.replay'],
      coreVersion,
      authToken: 'fixture-owner-token',
      host: '127.0.0.1',
      port: 25464,
      url: 'ws://127.0.0.1:25464/hub',
      pid: process.pid,
      startedAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    })}\n`, { mode: 0o600 });
  };
  const healthAt = (coreVersion: string): typeof globalThis.fetch =>
    (async () => new Response(JSON.stringify({
      ok: true,
      draining: false,
      protocolVersion: CLINE_HUB_PROTOCOL_VERSION,
      coreVersion,
      host: '127.0.0.1', port: 25464, url: 'ws://127.0.0.1:25464/hub',
    }), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof globalThis.fetch;

  for (const newer of ['0.0.83', '0.1.0', '1.0.0']) {
    writeHubVersion(newer);
    const record = await readClineHubDiscovery({ env, homeDir: fake.root });
    check(`a Hub core ${newer} above the floor is admitted by discovery`,
      record?.hubId === 'fixture-hub');
    check(`discovery reports the ${newer} it actually read, not the floor constant`,
      record?.coreVersion === newer);
    check(`a Hub core ${newer} above the floor is admitted by the health probe too`,
      (await probeClineHub({ env, homeDir: fake.root, fetcher: healthAt(newer) }))?.hubId === 'fixture-hub');
  }

  writeHubVersion('0.0.81');
  check('a Hub core below the floor is refused by discovery',
    await readClineHubDiscovery({ env, homeDir: fake.root }) === undefined);
  check('a Hub core below the floor is refused by the health probe',
    await probeClineHub({ env, homeDir: fake.root, fetcher: healthAt('0.0.81') }) === undefined);

  // Flooring the probe must not cost the record-vs-reality check: both values
  // clear the floor here, so the disagreement alone is what refuses them.
  writeHubVersion('0.0.83');
  check('a live Hub that disagrees with its own discovery record is refused',
    await probeClineHub({ env, homeDir: fake.root, fetcher: healthAt('0.0.84') }) === undefined);

  // The CLI floor and the Hub core floor must agree, for every measured build.
  //
  // They did not. 3.0.60 cleared the CLI gate, was advertised by doctor as the
  // minimum, and shipped `@cline/core 0.0.81` -- which this Hub floor refuses.
  // `probeClineHub` is the sole entry to the managed lane, so that operator was
  // told they were supported and then failed every Create, Drive and Resume.
  // The two floors are now derived from one table; this pins them together.
  for (const [cli, core] of Object.entries(CLINE_MEASURED_HUB_CORE)) {
    check(`measured CLI ${cli} and its Hub core ${core} agree on Drive`,
      clineVersionAllowsDrive(cli) === clineHubCoreVersionSupported(core),
      `cliDrives=${clineVersionAllowsDrive(cli)} hubOk=${clineHubCoreVersionSupported(core)}`);
  }
  // Not `clineVersionAllowsDrive(floor)`, which is true of any parsable floor
  // and was therefore true before the derivation existed. What matters is that
  // the floor came OUT of the measured list, so it names a build with evidence
  // behind it rather than an arbitrary version string.
  check('the advertised CLI floor is one of the measured builds',
    CLINE_MEASURED_VERSIONS.includes(CLINE_MINIMUM_SUPPORTED_VERSION),
    `${CLINE_MINIMUM_SUPPORTED_VERSION} in [${CLINE_MEASURED_VERSIONS.join(', ')}]`);
  check('and every measured build below it is refused, in step with its Hub core',
    CLINE_MEASURED_VERSIONS.every((cli) =>
      clineVersionAllowsDrive(cli) === clineHubCoreVersionSupported(CLINE_MEASURED_HUB_CORE[cli])),
    JSON.stringify(CLINE_MEASURED_VERSIONS.map((cli) =>
      `${cli}:${String(clineVersionAllowsDrive(cli))}`)));
  check('the CLI floor ships a Hub core at or above the Hub floor',
    clineHubCoreVersionSupported(CLINE_MEASURED_HUB_CORE[CLINE_MINIMUM_SUPPORTED_VERSION]),
    `${CLINE_MINIMUM_SUPPORTED_VERSION} -> ${String(CLINE_MEASURED_HUB_CORE[CLINE_MINIMUM_SUPPORTED_VERSION])}`);

  writeHubVersion(CLINE_HUB_CORE_MINIMUM_VERSION);

  const hub = new FakeHub(profile, fake.cwd);
  let boundary: HistorySourceIdentity | undefined;
  let storedPromptCorrelations: ClinePromptCorrelation[] = [];
  let storedTerminalSummaries: ClineTerminalSummary[] = [];
  const recordPromptCorrelation = (correlation: ClinePromptCorrelation): void => {
    storedPromptCorrelations = [
      ...storedPromptCorrelations.filter((entry) =>
        entry.nativeMessageId !== correlation.nativeMessageId),
      { ...correlation },
    ].slice(-64);
  };
  const recordBoundary = (record: {
    historyBoundary: HistorySourceIdentity;
    terminalSummary?: ClineTerminalSummary;
  }): void => {
    boundary = { ...record.historyBoundary };
    if (record.terminalSummary) {
      storedTerminalSummaries = [
        ...storedTerminalSummaries.filter((entry) => entry.key !== record.terminalSummary?.key),
        { ...record.terminalSummary },
      ].slice(-64);
    }
  };
  let unsafeStops = 0;
  let revokedStoredEligibility = 0;
  let managedOwnershipChecks = 0;
  const unsafeStop = async () => { unsafeStops += 1; };
  const adapter = new ClineAdapter({
    command: fake.path,
    env,
    homeDir: fake.root,
    fetcher,
    hubSocketFactory: hub.socketFactory,
    isManagedHostOwned: async () => {
      managedOwnershipChecks += 1;
      return true;
    },
    onUnsafeManagedAuthority: unsafeStop,
    authoritySettleTimeoutMs: 100,
    renameTimeoutMs: 1_000,
    resolveStoredDriveState: () => boundary ? {
      currentModel: { providerID: 'openai-compatible', modelID: 'fixture-model' },
      currentMode: 'ask',
      historyBoundary: boundary,
      promptCorrelations: storedPromptCorrelations,
      terminalSummaries: storedTerminalSummaries,
    } : undefined,
    revokeStoredDriveEligibility: () => {
      revokedStoredEligibility += 1;
      boundary = undefined;
      storedPromptCorrelations = [];
      storedTerminalSummaries = [];
    },
    recordStoredDriveBoundary: recordBoundary,
    recordStoredPromptCorrelation: (record) => recordPromptCorrelation(record.correlation),
  });
  check('production Cline advertises managed Hub Create/Resume only when ready and owned',
    adapter.capabilities.integrationKind === 'http-websocket'
      && adapter.capabilities.supportsResume
      && adapter.capabilities.permissionGranularity === 'per-tool'
      && await adapter.canCreateSession());
  const descriptor = await adapter.describeManagedHost();
  // The address triple is the whole isolation guarantee: it is what keeps this
  // Hub off the owner's own default-port Hub. Since 3.0.61 dropped the daemon
  // flag and its address arguments, the environment is the only place left to
  // state it, so assert it there — and assert the removed flag is NOT passed,
  // because 3.0.61 exits 1 on an unknown option rather than ignoring it.
  check('managed descriptor isolates profile, port, discovery, and native daemon launch',
    descriptor.identityKey.includes(profile)
      && descriptor.serving?.port === 25464
      && descriptor.launch?.args.length === 2
      && descriptor.launch?.args[0] === '--cwd'
      && descriptor.launch?.env?.CLINE_RUN_AS_HUB_DAEMON === '1'
      && descriptor.launch?.env?.CLINE_HUB_HOST === '127.0.0.1'
      && descriptor.launch?.env?.CLINE_HUB_PORT === '25464'
      && descriptor.launch?.env?.CLINE_HUB_PATHNAME === '/hub'
      && descriptor.launch?.env?.CLINE_NO_AUTO_UPDATE === '1'
      && descriptor.launch?.env?.CLINE_DATA_DIR === profile
      && descriptor.launch?.env?.CLINE_SESSION_DATA_DIR === join(profile, 'sessions')
      && descriptor.launch?.env?.CLINE_HUB_DISCOVERY_PATH === discoveryPath);

  const createOptions = {
    directory: fake.cwd,
    title: 'Managed Cline fixture',
    model: { providerID: 'openai-compatible', modelID: 'fixture-model' },
    permissionMode: 'ask',
  } as const;
  const foreignCreatedReply = hub.delayNextCreatedReply();
  const deletesBeforeForeignCreate = hub.frames.filter((frame) =>
    frame.envelope?.command === 'session.delete').length;
  const abortsBeforeForeignCreate = hub.frames.filter((frame) =>
    frame.envelope?.command === 'run.abort').length;
  const foreignClaimedCreate = adapter.createSession!(createOptions);
  await foreignCreatedReply.received;
  hub.foreignRun();
  foreignCreatedReply.release();
  await assert.rejects(foreignClaimedCreate, /not exactly idle/u);
  check('managed Create proves an empty idle boundary after subscribing and preserves a pre-reply foreign claim',
    hub.frames.filter((frame) => frame.envelope?.command === 'session.delete').length
      === deletesBeforeForeignCreate
      && hub.frames.filter((frame) => frame.envelope?.command === 'run.abort').length
        === abortsBeforeForeignCreate
      && hub.activeSocketCount() === 0);
  hub.resetCreatedSession();

  const delayedCreateReply = hub.delayNextCreateReply();
  const firstCreate = adapter.createSession!(createOptions);
  await delayedCreateReply.received;
  const delayedWinnerMessages = hub.delayNextMessagesReply();
  const winningCreate = adapter.createSession!(createOptions);
  await delayedWinnerMessages.received;
  const deletesBeforeConcurrentCreate = hub.frames.filter((frame) =>
    frame.envelope?.command === 'session.delete').length;
  delayedCreateReply.release();
  await assert.rejects(firstCreate, /pre-existing or active id/u);
  delayedWinnerMessages.release();
  const created = await winningCreate;
  check('concurrent managed Create atomically reserves one returned id and preserves the loser',
    hub.frames.filter((frame) => frame.envelope?.command === 'session.delete').length
      === deletesBeforeConcurrentCreate
      && hub.activeSocketCount() === 1);
  check('Create propagates exact model/mode, enables tools and subagents, and disables unsupported teams',
    created.id === hub.sessionId
      && created.currentModel?.modelID === 'fixture-model'
      && created.currentMode === 'ask'
      && hub.frames.some((frame) => frame.envelope?.command === 'session.create'
        && frame.envelope.payload.sessionConfig.enableSpawnAgent === true
      && frame.envelope.payload.sessionConfig.enableAgentTeams === false
      && frame.envelope.payload.runtimeOptions.enableTeams === false
        && frame.envelope.payload.modelSelection.model === 'fixture-model'
        && frame.envelope.payload.runtimeOptions.autoApproveTools === false
        && frame.envelope.payload.runtimeOptions.clientContributions === undefined));
  check('Hub credential is sent only as the owner subprotocol',
    hub.protocols.every((protocols) => protocols.length === 1
      && protocols[0] === 'cline-hub-auth.fixture-owner-token')
      && !JSON.stringify(hub.frames).includes('fixture-owner-token'));

  await assert.rejects(
    adapter.attach(created.id),
    /empty created sessions require Resume/u,
  );
  // Was `check(name, true)`. The `assert.rejects` above is what enforces the
  // refusal; this line now carries the OTHER half of its own name — that the
  // refused attach left the created writer intact rather than abandoning it.
  check('a bare attach cannot abandon an empty newly-created Cline writer before its first prompt',
    created.id === hub.sessionId);

  let attachCalls = 0;
  const realAttach = adapter.attach.bind(adapter);
  adapter.attach = ((id: string, mode?: AttachMode): Promise<SessionConnection> => {
    attachCalls += 1;
    return realAttach(id, mode);
  }) as typeof adapter.attach;
  const registry = new AgentRegistry();
  registry.register(adapter);
  // The broker's own attention policy, fed the way production feeds it: the Hub's live `onMessage`
  // hook, serialized, and never a history read. A Cline turn notifies only if this sees `running`
  // and then a terminal under one key.
  const attentionStore = new AttentionStore({
    home: join(fake.root, 'attention'),
    onWarning: () => undefined,
  });
  const attentionPolicy = new AttentionPolicy(attentionStore);
  const attentionFailures: unknown[] = [];
  let attentionTail: Promise<void> = Promise.resolve();
  const drainAttention = async (): Promise<void> => {
    let tail: Promise<void>;
    do {
      tail = attentionTail;
      await tail;
    } while (tail !== attentionTail);
  };
  const runEvents = (kind: 'run-finished' | 'run-failed', turnId?: string) => attentionStore.listEvents()
    .filter((event) => event.kind === kind && event.agent === 'cline' && event.sessionId === created.id
      && (turnId === undefined || event.turnId === turnId));
  brokerSessionHub = new Hub(registry, 15_000, undefined, {
    onMessage: (info, message) => {
      attentionTail = attentionTail
        .then(() => attentionPolicy.handleMessage(info, message))
        .catch((error) => { attentionFailures.push(error); });
    },
  });
  const owner = await brokerSessionHub.ensure('cline', created.id, 'resume');
  const connection = owner.conn;
  const emptyReloadObserver = await brokerSessionHub.ensure('cline', created.id);
  await emptyReloadObserver.conn.getHistory();
  const emptyReloadLive: AgentMessage[] = [];
  emptyReloadObserver.conn.subscribe((message) => emptyReloadLive.push(message));
  check('a hard reload after the first Resume claim observes an empty managed session without consuming its writer',
    emptyReloadObserver !== owner
      && emptyReloadObserver.conn.info.control?.drive.state === 'observing'
      && !(emptyReloadObserver.conn instanceof ClineHubDriveConnection)
      && connection.info.control?.drive.state === 'driving'
      && attachCalls === 2);
  await assert.rejects(
    emptyReloadObserver.conn.sendPrompt({ text: 'empty reload must stay read-only' }),
    /Observe is read-only/u,
  );
  const live: AgentMessage[] = [];
  connection.subscribe((message) => live.push(message));
  const turn = connection.sendPrompt({ text: 'first managed prompt', clientMessageId: 'client-first' });
  for (let attempt = 0; attempt < 40 && !(await connection.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await Bun.sleep(5);
  }
  const permission = (await connection.getPending!()).find((row) => row.type === 'permission-request');
  check('native approval exposes bounded tool and input detail',
    permission?.type === 'permission-request'
      && permission.toolName === 'write_to_file'
      && permission.detail === '{"path":"fixture.txt"}');
  const midTurnHistory = await connection.getHistory();
  // The read-only socket sees the native row before the writer has terminal
  // proof and therefore before the durable app correlation can be published.
  await emptyReloadObserver.conn.getHistory();
  const ownershipChecksBeforeRoster = managedOwnershipChecks;
  const midTurnRoster = await adapter.discoverSessions();
  check('a user row persisted before native completion replaces its queued echo without self-demotion',
    midTurnHistory.filter((row) => row.type === 'user-message' && row.text === 'first managed prompt').length === 1
      && midTurnHistory.some((row) => row.type === 'user-message'
        && row.text === 'first managed prompt' && row.key === 'client-first'
        && row.clientKey === 'client-first' && row.queued === false)
      && midTurnRoster.find((row) => row.id === created.id)?.control?.drive.state === 'driving');
  check('one asynchronous managed-host proof qualifies a complete Cline roster snapshot',
    managedOwnershipChecks === ownershipChecksBeforeRoster + 1,
    `checks=${managedOwnershipChecks - ownershipChecksBeforeRoster}`);
  await connection.respondPermission(permission!.requestId, 'approve');
  await turn;
  check('serialized owner run.start uses Cline direct delivery and waits for a terminal result',
    hub.frames.some((frame) => frame.envelope?.command === 'run.start'
      && frame.envelope.payload.delivery === undefined));
  const history = await connection.getHistory();
  check('direct run reply plus durable reread replaces queued echo with exact correlation',
    history.some((row) => row.type === 'user-message'
      && row.text === 'first managed prompt' && row.key === 'client-first'
      && row.clientKey === 'client-first' && !row.queued)
      && !history.some((row) => row.type === 'user-message' && row.queued));
  const firstTerminal = storedTerminalSummaries.find((row) => row.status === 'done');
  // The live stream now carries this key twice, `running` then `done`; the terminal itself is
  // still published once.
  check('an authoritative completed Hub reply stores and replays one durable Cline run summary',
    firstTerminal !== undefined
      && history.filter((row) => row.type === 'run-summary'
        && row.key === firstTerminal.key
        && row.turnId === firstTerminal.turnId
        && row.status === 'done').length === 1
      && runSummaries(live, firstTerminal.key).filter((row) => row.status !== 'running').length === 1);
  // The broker notifies "turn finished" only for a key it saw `running` on the live stream first.
  // Cline published the terminal alone, so no Cline turn ever notified.
  const firstRunFrames = runSummaries(live, firstTerminal?.key);
  check('a driven Hub turn publishes running then its terminal under one key and one turn id',
    firstTerminal !== undefined
      && firstRunFrames.length === 2
      && firstRunFrames[0]?.status === 'running'
      && firstRunFrames[0].turnId === firstTerminal.turnId
      && firstRunFrames[1]?.status === 'done'
      && firstRunFrames[1].turnId === firstTerminal.turnId
      && runSummaries(live).length === 2,
    runShape(live));
  const emptyReloadHistory = await emptyReloadObserver.conn.getHistory();
  check('an Observe opened before native settlement resets onto the shared durable prompt key',
    emptyReloadLive.some((row) => row.type === 'history-reset')
      && emptyReloadHistory.some((row) => row.type === 'user-message'
        && row.text === 'first managed prompt'
        && row.key === 'client-first'
        && row.clientKey === 'client-first'
        && row.queued === false)
      && emptyReloadHistory.filter((row) => row.type === 'run-summary'
        && row.key === firstTerminal?.key
        && row.status === 'done').length === 1);
  check('running is live-only: the writer history, a reload Observe, and its live stream carry none',
    !hasRunningSummary(history)
      && !hasRunningSummary(emptyReloadHistory)
      && !hasRunningSummary(emptyReloadLive)
      && !hasRunningSummary(await connection.getHistory()),
    runShape([...history, ...emptyReloadHistory, ...emptyReloadLive]));
  await drainAttention();
  check('the broker attention policy raises exactly one turn-finished event for the driven turn',
    attentionFailures.length === 0
      && runEvents('run-finished', firstTerminal?.turnId).length === 1
      && runEvents('run-finished').length === 1
      && runEvents('run-failed').length === 0,
    JSON.stringify(attentionStore.listEvents().map((event) => `${event.kind}:${event.turnId}`)));
  check('a broker-managed Hub session remains present after durable store rediscovery',
    (await adapter.discoverSessions()).some((row) => row.id === created.id));
  // The answer arrives as many deltas, so no single row carries it. Reassemble per key: streamed
  // rows coalesce by `key`, so one key must accumulate the whole answer.
  const answerByKey = new Map<string | undefined, string>();
  let answerChunkCount = 0;
  for (const row of live) {
    if (row.type !== 'model-output') continue;
    const delta = row.delta ?? '';
    if (delta === '') continue;
    answerChunkCount += 1;
    answerByKey.set(row.key, (answerByKey.get(row.key) ?? '') + delta);
  }
  check('native answer and usage events project live without session hooks',
    [...answerByKey.values()].includes('answer:first managed prompt')
      && live.some((row) => row.type === 'token-count' && row.input === 11 && row.output === 7)
      && live.filter((row) => row.type === 'permission-resolved').length === 1,
    JSON.stringify({ keys: [...answerByKey.keys()], texts: [...answerByKey.values()] }));
  // B3: keying each chunk by its own event id gave one transcript row per token — measured in the
  // browser as 43 rows for 128 characters. Fewer keys than chunks is what proves they coalesce.
  check('streamed answer chunks coalesce into one transcript row per turn',
    answerChunkCount > 1 && answerByKey.size < answerChunkCount,
    JSON.stringify({ chunks: answerChunkCount, keys: answerByKey.size }));

  // Late usage re-publishes the settled terminal under the same key. The policy ignores that second
  // terminal because the first one closed the observation, so it is harmless, but only while no
  // second `running` precedes it.
  const liveBeforeLateUsage = live.length;
  hub.landLateUsageAfterNextReply();
  const lateUsageTurn = connection.sendPrompt({ text: 'usage lands after the reply', clientMessageId: 'client-late-usage' });
  for (let attempt = 0; attempt < 40 && !(await connection.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await Bun.sleep(5);
  }
  const lateUsagePermission = (await connection.getPending!()).find((row) => row.type === 'permission-request');
  await connection.respondPermission(lateUsagePermission!.requestId, 'approve');
  await lateUsageTurn;
  const lateUsageFrames = runSummaries(live.slice(liveBeforeLateUsage));
  const lateUsageKey = lateUsageFrames[0]?.key;
  check('late token usage republishes the terminal under its key with no second running',
    lateUsageFrames.length === 3
      && lateUsageFrames[0]?.status === 'running'
      && lateUsageFrames.every((row) => row.key === lateUsageKey && row.turnId === lateUsageFrames[0]?.turnId)
      && lateUsageFrames[1]?.status === 'done' && lateUsageFrames[1].tokens === undefined
      && lateUsageFrames[2]?.status === 'done' && lateUsageFrames[2].tokens?.input === 23
      && lateUsageFrames[2].tokens?.output === 5
      && storedTerminalSummaries.filter((row) => row.key === lateUsageKey).length === 1,
    runShape(live.slice(liveBeforeLateUsage)));
  await drainAttention();
  check('a republished terminal adds no second turn-finished event',
    runEvents('run-finished', lateUsageFrames[0]?.turnId).length === 1
      && runEvents('run-finished').length === 2,
    JSON.stringify(attentionStore.listEvents().map((event) => `${event.kind}:${event.turnId}`)));

  const nativeRenameSpawnsBefore = fake.ledger().filter((entry) => entry.kind === 'spawn'
    && entry.argv?.[0] === 'history' && entry.argv?.[1] === 'update').length;
  const renamed = await adapter.renameSession(created.id, 'Managed Cline renamed');
  const durableRenamed = (await adapter.discoverSessions()).find((row) => row.id === created.id);
  const nativeRenameSpawns = fake.ledger().filter((entry) => entry.kind === 'spawn'
    && entry.argv?.[0] === 'history' && entry.argv?.[1] === 'update');
  check('native rename fences the owned Hub, uses the exact managed store, proves durable rediscovery, and keeps Drive',
    renamed?.title === 'Managed Cline renamed'
      && durableRenamed?.title === 'Managed Cline renamed'
      && connection.info.control?.drive.state === 'driving'
      && nativeRenameSpawns.length === nativeRenameSpawnsBefore + 1
      && nativeRenameSpawns.at(-1)?.noAutoUpdate === '1'
      && nativeRenameSpawns.at(-1)?.dataRoot === profile
      && nativeRenameSpawns.at(-1)?.sessionDataRoot === join(profile, 'sessions'));

  const trailingGate = hub.holdTrailingAssistantAfterNextReply();
  const trailingTurn = connection.sendPrompt({
    text: 'completed reply before durable tail',
    clientMessageId: 'client-durable-tail',
  });
  for (let attempt = 0; attempt < 40 && !(await connection.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await Bun.sleep(5);
  }
  const trailingPermission = (await connection.getPending!()).find((row) => row.type === 'permission-request');
  await connection.respondPermission(trailingPermission!.requestId, 'approve');
  await trailingTurn;
  await trailingGate.replySent;
  await Bun.sleep(125);
  trailingGate.release();
  await Bun.sleep(25);
  const trailingRename = await adapter.renameSession(created.id, 'Cline rename after durable tail');
  check('completed turns retain Drive only after the durable transcript tail is stable enough for native rename',
    trailingRename?.title === 'Cline rename after durable tail'
      && connection.info.control?.drive.state === 'driving'
      && (await connection.getHistory()).some((row) =>
        row.type === 'model-output' && row.text === ':durable-tail'));
  hub.setDurableTitle('Externally renamed Cline session');
  check('managed discovery reflects later native title changes instead of a stale broker cache',
    (await adapter.discoverSessions()).find((row) => row.id === created.id)?.title
      === 'Externally renamed Cline session');
  hub.setDurableTitle('Managed Cline renamed');

  hub.deferNextCompletedPersistence();
  const delayedPersistenceTurn = connection.sendPrompt({
    text: 'reply before durable persistence',
    clientMessageId: 'client-delayed-persistence',
  });
  for (let attempt = 0; attempt < 40 && !(await connection.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await Bun.sleep(5);
  }
  const delayedPermission = (await connection.getPending!()).find((row) => row.type === 'permission-request');
  const midTurnObserver = await brokerSessionHub.ensure('cline', created.id);
  check('a bare background reload during native persistence cannot demote its active Cline writer',
    midTurnObserver === emptyReloadObserver
      && midTurnObserver.conn.info.control?.drive.state === 'observing'
      && !(midTurnObserver.conn instanceof ClineHubDriveConnection)
      && connection.info.control?.drive.state === 'driving'
      && (await connection.getPending!()).some((row) => row.type === 'permission-request'
        && row.requestId === delayedPermission?.requestId)
      && unsafeStops === 0);
  await connection.respondPermission(delayedPermission!.requestId, 'approve');
  await delayedPersistenceTurn;
  const delayedHistory = await connection.getHistory();
  check('a run reply that wins the native persistence race settles to one durable correlated echo',
    delayedHistory.some((row) => row.type === 'user-message'
      && row.text === 'reply before durable persistence'
      && row.key === 'client-delayed-persistence'
      && row.clientKey === 'client-delayed-persistence'
      && row.queued === false)
      && (await adapter.discoverSessions()).find((row) => row.id === created.id)?.control?.drive.state === 'driving');

  const liveBeforeSnapshotFailure = live.length;
  hub.failNextRunSnapshotOnly('fixture provider connection refused');
  await connection.sendPrompt({
    text: 'snapshot-only failed prompt',
    clientMessageId: 'client-snapshot-failed',
  });
  const failedHistory = await connection.getHistory();
  check('an attributable snapshot-only run.failed ACKs the exact durable prompt and preserves correlation',
    failedHistory.filter((row) => row.type === 'user-message'
      && row.text === 'snapshot-only failed prompt').length === 1
      && failedHistory.some((row) => row.type === 'user-message'
        && row.text === 'snapshot-only failed prompt'
        && row.clientKey === 'client-snapshot-failed'
        && row.queued === false)
      && !(await connection.getPending!()).some((row) => row.type === 'user-message'
        && row.clientKey === 'client-snapshot-failed')
      && live.some((row) => row.type === 'error'
        && row.message === 'fixture provider connection refused')
      && connection.info.control?.drive.state === 'driving');
  const snapshotFailureFrames = runSummaries(live.slice(liveBeforeSnapshotFailure));
  check('an owned run.failed publishes running then an error terminal under one key',
    snapshotFailureFrames.length === 2
      && snapshotFailureFrames[0]?.status === 'running'
      && snapshotFailureFrames[1]?.status === 'error'
      && snapshotFailureFrames[0].key === snapshotFailureFrames[1].key
      && snapshotFailureFrames[0].turnId === snapshotFailureFrames[1].turnId,
    runShape(live.slice(liveBeforeSnapshotFailure)));
  await drainAttention();
  check('the broker attention policy raises one turn-failed event for the failed turn',
    runEvents('run-failed', snapshotFailureFrames[1]?.turnId).length === 1
      && runEvents('run-finished', snapshotFailureFrames[1]?.turnId).length === 0);

  const liveBeforeCommandFailure = live.length;
  hub.failNextRunCommand('fixture direct provider connection refused');
  await connection.sendPrompt({
    text: 'direct command-failed prompt',
    clientMessageId: 'client-direct-command-failed',
  });
  const commandFailedHistory = await connection.getHistory();
  check('an attributable direct command_failed reply ACKs only after its exact durable prompt is proved',
    commandFailedHistory.filter((row) => row.type === 'user-message'
      && row.text === 'direct command-failed prompt').length === 1
      && commandFailedHistory.some((row) => row.type === 'user-message'
        && row.text === 'direct command-failed prompt'
        && row.clientKey === 'client-direct-command-failed'
        && row.queued === false)
      && !(await connection.getPending!()).some((row) => row.type === 'user-message'
        && row.clientKey === 'client-direct-command-failed')
      && live.some((row) => row.type === 'error'
        && row.message === 'fixture direct provider connection refused')
      && connection.info.control?.drive.state === 'driving');
  // This terminal settles from the run.failed event after run.start itself failed, so the pairing
  // rests on the owned run.started the Drive saw first.
  const commandFailureFrames = runSummaries(live.slice(liveBeforeCommandFailure));
  check('a failed run.start settled by its own run.started and run.failed events still pairs once',
    commandFailureFrames.length === 2
      && commandFailureFrames[0]?.status === 'running'
      && commandFailureFrames[1]?.status === 'error'
      && commandFailureFrames[0].key === commandFailureFrames[1].key,
    runShape(live.slice(liveBeforeCommandFailure)));

  const liveBeforeNativeAbort = live.length;
  hub.abortNextRunSnapshotOnly('fixture native timeout');
  await connection.sendPrompt({
    text: 'natively aborted prompt',
    clientMessageId: 'client-native-abort',
  });
  const nativeAbortFrames = runSummaries(live.slice(liveBeforeNativeAbort));
  check('a native abort Cosyncing did not request pairs running with a cancelled terminal',
    nativeAbortFrames.length === 2
      && nativeAbortFrames[0]?.status === 'running'
      && nativeAbortFrames[1]?.status === 'cancelled'
      && nativeAbortFrames[0].key === nativeAbortFrames[1].key
      && connection.info.control?.drive.state === 'driving',
    runShape(live.slice(liveBeforeNativeAbort)));
  await drainAttention();
  check('a cancelled terminal clears its observation and raises no attention event',
    nativeAbortFrames[1] !== undefined
      && attentionStore.getObservation(`run:cline:${created.id}:${nativeAbortFrames[1].key}`) === undefined
      && runEvents('run-finished', nativeAbortFrames[1].turnId).length === 0
      && runEvents('run-failed', nativeAbortFrames[1].turnId).length === 0);

  const observer = await brokerSessionHub.ensure('cline', created.id);
  const offer = brokerSessionHub.sessionDetailFrame(observer, true);
  const joined = brokerSessionHub.joinExisting('cline', created.id, offer.joinExisting!.ownerRevision);
  check('a late app socket joins the exact broker-owned Cline writer without a third native attach',
    observer !== owner
      && observer.conn.info.control?.drive.state === 'observing'
      && !(observer.conn instanceof ClineHubDriveConnection)
      && joined === owner
      && joined.conn === connection
      && joined.conn instanceof ClineHubDriveConnection
      && attachCalls === 2);
  await assert.rejects(
    observer.conn.sendPrompt({ text: 'background Observe must refuse' }),
    /Observe is read-only/u,
  );
  check('bare background Observe cannot write and leaves the existing Hub owner driving',
    connection.info.control?.drive.state === 'driving');
  const sharedTurn = connection.sendPrompt({ text: 'cross-client prompt', clientMessageId: 'client-shared' });
  for (let attempt = 0; attempt < 40 && !(await joined.conn.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await Bun.sleep(5);
  }
  const sharedPermission = (await joined.conn.getPending!()).find((row) => row.type === 'permission-request');
  check('the joined socket sees the reconciled prompt and unresolved native permission',
    (await joined.conn.getHistory()).some((row) => row.type === 'user-message'
      && row.clientKey === 'client-shared' && row.queued === false)
      && sharedPermission?.type === 'permission-request');
  await joined.conn.respondPermission(sharedPermission!.requestId, 'approve');
  await sharedTurn;

  const restartTailGate = hub.holdTrailingAssistantAfterNextReply();
  const restartTailTurn = connection.sendPrompt({
    text: 'durable tail crosses broker restart',
    clientMessageId: 'client-restart-tail',
  });
  for (let attempt = 0; attempt < 40 && !(await connection.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await Bun.sleep(5);
  }
  const restartTailPermission = (await connection.getPending!()).find((row) => row.type === 'permission-request');
  await connection.respondPermission(restartTailPermission!.requestId, 'approve');
  await restartTailTurn;
  await restartTailGate.replySent;
  await Bun.sleep(125);
  // Every turn this Hub drove, and nothing else: one event per settled done or error terminal, none
  // for the cancelled one, no open run observation left behind, and no Observe frame counted.
  await drainAttention();
  const drivenTurnIds = (status: ClineTerminalSummary['status']) => storedTerminalSummaries
    .filter((row) => row.status === status).map((row) => row.turnId).sort();
  const eventTurnIds = (kind: 'run-finished' | 'run-failed') => runEvents(kind)
    .map((event) => event.turnId ?? '').sort();
  check('each Hub-driven Cline turn raises exactly one attention event and leaves no open run',
    attentionFailures.length === 0
      && drivenTurnIds('done').length >= 6
      && JSON.stringify(eventTurnIds('run-finished')) === JSON.stringify(drivenTurnIds('done'))
      && JSON.stringify(eventTurnIds('run-failed')) === JSON.stringify(drivenTurnIds('error'))
      && drivenTurnIds('cancelled').length === 1
      && !attentionStore.listObservations().some((observation) => observation.kind === 'run'),
    JSON.stringify({
      finished: eventTurnIds('run-finished'),
      done: drivenTurnIds('done'),
      failed: eventTurnIds('run-failed'),
      error: drivenTurnIds('error'),
      open: attentionStore.listObservations().map((observation) => observation.key),
    }));
  await brokerSessionHub.dispose();
  brokerSessionHub = undefined;
  restartTailGate.release();
  await Bun.sleep(25);

  let lateTailRevocations = 0;
  const lateTailReplacement = new ClineAdapter({
    command: fake.path,
    env,
    homeDir: fake.root,
    fetcher,
    hubSocketFactory: hub.socketFactory,
    isManagedHostOwned: () => true,
    onUnsafeManagedAuthority: unsafeStop,
    authoritySettleTimeoutMs: 100,
    renameTimeoutMs: 1_000,
    resolveStoredDriveState: () => boundary ? {
      currentModel: { providerID: 'openai-compatible', modelID: 'fixture-model' },
      currentMode: 'ask',
      historyBoundary: boundary,
      promptCorrelations: storedPromptCorrelations,
      terminalSummaries: storedTerminalSummaries,
    } : undefined,
    revokeStoredDriveEligibility: () => {
      lateTailRevocations += 1;
      boundary = undefined;
      storedPromptCorrelations = [];
      storedTerminalSummaries = [];
    },
    recordStoredDriveBoundary: recordBoundary,
    recordStoredPromptCorrelation: (record) => recordPromptCorrelation(record.correlation),
  });
  const staleBoundaryBeforeRetry = boundary ? { ...boundary } : undefined;
  hub.failNextSessionGet();
  const unavailableTailRows = await lateTailReplacement.discoverSessions();
  check('a transient Hub proof failure refuses Drive for that discovery without revoking stored provenance',
    lateTailRevocations === 0
      && JSON.stringify(boundary) === JSON.stringify(staleBoundaryBeforeRetry)
      && unavailableTailRows.find((row) => row.id === created.id)?.control?.drive.supported === false);
  const restartObserver = await lateTailReplacement.attach(created.id, 'observe');
  const restartObserveHistory = await restartObserver.getHistory();
  check('a replacement broker restores durable prompt keys into read-only Observe after exact boundary proof',
    restartObserveHistory.some((row) => row.type === 'user-message'
      && row.text === 'durable tail crosses broker restart'
      && row.key === 'client-restart-tail'
      && row.clientKey === 'client-restart-tail'
      && row.queued === false));
  check('a replacement broker replays each stored Cline terminal summary once',
    firstTerminal !== undefined
      && restartObserveHistory.filter((row) => row.type === 'run-summary'
        && row.key === firstTerminal.key).length === 1);
  check('a replacement broker replays stored terminals without inventing a running frame',
    runSummaries(restartObserveHistory).length > 0 && !hasRunningSummary(restartObserveHistory),
    runShape(restartObserveHistory));
  await restartObserver.close();
  const lateTailReopened = await lateTailReplacement.attach(created.id, 'resume');
  const lateTailRename = await lateTailReplacement.renameSession(
    created.id,
    'Cline rename after restart tail',
  );
  check('a restart re-establishes an exact stored prefix plus idle assistant-only tail before Drive and rename',
    lateTailReopened.info.control?.drive.state === 'driving'
      && lateTailRename?.title === 'Cline rename after restart tail'
      && boundary?.appendPosition === hub.messages.length);
  const reopenedHistory = await lateTailReopened.getHistory();
  check('a resumed writer after restart reads stored terminals but no running frame',
    runSummaries(reopenedHistory).length > 0 && !hasRunningSummary(reopenedHistory),
    runShape(reopenedHistory));
  hub.setDurableTitle('Managed Cline renamed');
  await lateTailReopened.close();

  let initializationRaceBoundary = boundary ? { ...boundary } : undefined;
  let initializationRaceRevocations = 0;
  const initializationRaceAdapter = new ClineAdapter({
    command: fake.path,
    env,
    homeDir: fake.root,
    fetcher,
    hubSocketFactory: hub.socketFactory,
    isManagedHostOwned: () => true,
    onUnsafeManagedAuthority: unsafeStop,
    authoritySettleTimeoutMs: 100,
    renameTimeoutMs: 1_000,
    resolveStoredDriveState: () => initializationRaceBoundary ? {
      currentModel: { providerID: 'openai-compatible', modelID: 'fixture-model' },
      currentMode: 'ask',
      historyBoundary: initializationRaceBoundary,
    } : undefined,
    revokeStoredDriveEligibility: () => {
      initializationRaceRevocations += 1;
      initializationRaceBoundary = undefined;
    },
    recordStoredDriveBoundary: (record) => {
      initializationRaceBoundary = { ...record.historyBoundary };
    },
  });
  const delayedInitializationMessages = hub.delayNextMessagesReply();
  const abortsBeforeInitializationRace = hub.frames.filter((frame) =>
    frame.envelope?.command === 'run.abort').length;
  const racedAttach = initializationRaceAdapter.attach(created.id, 'resume');
  await delayedInitializationMessages.received;
  hub.foreignEnqueue();
  delayedInitializationMessages.release();
  await assert.rejects(racedAttach, /read-only|ownership generation changed/u);
  hub.setSessionStatus('idle');
  await assert.rejects(
    initializationRaceAdapter.attach(created.id, 'resume'),
    /limited to sessions created by this authenticated broker installation/u,
  );
  check('a foreign enqueue during Resume initialization revokes once and can never publish a Drive owner',
    initializationRaceRevocations === 1
      && initializationRaceBoundary === undefined
      && hub.frames.filter((frame) => frame.envelope?.command === 'run.abort').length
        === abortsBeforeInitializationRace);

  const replacementAdapter = () => new ClineAdapter({
    command: fake.path,
    env,
    homeDir: fake.root,
    fetcher,
    hubSocketFactory: hub.socketFactory,
    isManagedHostOwned: () => true,
    onUnsafeManagedAuthority: unsafeStop,
    authoritySettleTimeoutMs: 100,
    renameTimeoutMs: 1_000,
    resolveStoredDriveState: () => boundary ? {
      currentModel: { providerID: 'openai-compatible', modelID: 'fixture-model' },
      currentMode: 'ask',
      historyBoundary: boundary,
      promptCorrelations: storedPromptCorrelations,
      terminalSummaries: storedTerminalSummaries,
    } : undefined,
    revokeStoredDriveEligibility: () => {
      boundary = undefined;
      storedPromptCorrelations = [];
      storedTerminalSummaries = [];
    },
    recordStoredDriveBoundary: recordBoundary,
    recordStoredPromptCorrelation: (record) => recordPromptCorrelation(record.correlation),
  });
  const abortsBeforeReattach = hub.frames.filter((frame) => frame.envelope?.command === 'run.abort').length;
  hub.orphanRunWithoutPersistence();
  const unknownRunReplacement = replacementAdapter();
  await assert.rejects(
    unknownRunReplacement.attach(created.id, 'resume'),
    /running native turn without persisted broker ownership proof/u,
  );
  check('a replacement broker refuses an unknown running turn without aborting foreign native work',
    hub.frames.filter((frame) => frame.envelope?.command === 'run.abort').length === abortsBeforeReattach);
  hub.setSessionStatus('idle');
  const replacementBroker = replacementAdapter();
  const reopened = await replacementBroker.attach(created.id, 'resume');
  check('a replacement broker client rejoins only after native idle and the exact durable boundary are proved',
    reopened.info.control?.drive.state === 'driving'
      && reopened.info.currentModel?.modelID === 'fixture-model'
      && hub.frames.filter((frame) => frame.envelope?.command === 'run.abort').length === abortsBeforeReattach
      && (await reopened.getPending!()).length === 0);
  const second = reopened.sendPrompt({ text: 'after broker reconnect', clientMessageId: 'client-second' });
  for (let attempt = 0; attempt < 40 && !(await reopened.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await Bun.sleep(5);
  }
  const secondPermission = (await reopened.getPending!()).find((row) => row.type === 'permission-request');
  await reopened.respondPermission(secondPermission!.requestId, 'approve');
  await second;
  check('the replacement broker client preserves the same durable session identity',
    (await reopened.getHistory()).some((row) => row.type === 'user-message'
      && row.text === 'after broker reconnect' && row.clientKey === 'client-second'));

  const cancelled = reopened.sendPrompt({ text: 'cancel managed prompt', clientMessageId: 'client-cancel' });
  for (let attempt = 0; attempt < 40 && !(await reopened.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await Bun.sleep(5);
  }
  // Consume the pending echo before Stop. Stop must still flush this exact
  // unpublished claim after it proves the final idle boundary.
  await reopened.getHistory();
  await reopened.runCommand!('stop');
  await cancelled;
  for (let attempt = 0; attempt < 40 && !hub.frames.some((frame) =>
    frame.envelope?.command === 'approval.respond' && frame.envelope.payload.approved === false); attempt += 1) {
    await Bun.sleep(5);
  }
  check('Stop aborts the native run and rejects every actionable permission',
    (await reopened.getPending!()).length === 0
      && hub.frames.some((frame) => frame.envelope?.command === 'run.abort')
      && hub.frames.some((frame) => frame.envelope?.command === 'approval.respond'
        && frame.envelope.payload.approved === false));
  check('confirmed Stop advances the durable boundary and keeps the cancelled user correlation',
    (await reopened.getHistory()).some((row) => row.type === 'user-message'
      && row.text === 'cancel managed prompt' && row.clientKey === 'client-cancel' && row.queued === false)
      && storedPromptCorrelations.some((entry) => entry.clientKey === 'client-cancel'));
  const cancelledReplayAdapter = replacementAdapter();
  const cancelledObserver = await cancelledReplayAdapter.attach(created.id, 'observe');
  check('a fresh read-only adapter restores a cancelled prompt consumed before Stop',
    (await cancelledObserver.getHistory()).some((row) => row.type === 'user-message'
      && row.text === 'cancel managed prompt'
      && row.key === 'client-cancel'
      && row.clientKey === 'client-cancel'
      && row.queued === false));
  await cancelledObserver.close();

  const postStop = reopened.sendPrompt({ text: 'prompt after confirmed stop', clientMessageId: 'client-after-stop' });
  for (let attempt = 0; attempt < 40 && !(await reopened.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await Bun.sleep(5);
  }
  const postStopPermission = (await reopened.getPending!()).find((row) => row.type === 'permission-request');
  await reopened.respondPermission(postStopPermission!.requestId, 'approve');
  await postStop;
  check('a prompt after confirmed Stop remains writable and durably correlated',
    (await reopened.getHistory()).some((row) => row.type === 'user-message'
      && row.text === 'prompt after confirmed stop' && row.clientKey === 'client-after-stop'));

  const startsBeforeStopRace = hub.frames.filter((frame) =>
    frame.envelope?.command === 'run.start').length;
  const queuedBeforeStop = reopened.sendPrompt({
    text: 'must not cross Stop boundary',
    clientMessageId: 'client-stop-race',
  });
  void queuedBeforeStop.catch(() => undefined);
  const stopRace = reopened.runCommand!('stop');
  const submittedDuringStop = reopened.sendPrompt({
    text: 'must refuse during Stop',
    clientMessageId: 'client-during-stop',
  });
  void submittedDuringStop.catch(() => undefined);
  await assert.rejects(queuedBeforeStop, /Stop is in progress|ownership generation changed/u);
  await assert.rejects(submittedDuringStop, /Stop is in progress/u);
  await stopRace;
  check('Stop fences prompts queued immediately before and submitted during its boundary transaction',
    hub.frames.filter((frame) => frame.envelope?.command === 'run.start').length === startsBeforeStopRace
      && !(await reopened.getHistory()).some((row) => row.type === 'user-message'
        && (row.text === 'must not cross Stop boundary' || row.text === 'must refuse during Stop')));

  const deletesBeforeDuplicate = hub.frames.filter((frame) => frame.envelope?.command === 'session.delete').length;
  await assert.rejects(replacementBroker.createSession!({
    directory: fake.cwd,
    model: { providerID: 'openai-compatible', modelID: 'fixture-model' },
  }), /pre-existing or active id/u);
  check('a duplicate native create id is preserved and never passed to session.delete',
    hub.frames.filter((frame) => frame.envelope?.command === 'session.delete').length === deletesBeforeDuplicate);

  const stableMessages = hub.snapshotMessages();
  const stableBoundary = boundary ? { ...boundary } : undefined;

  const unprimedObserver = await replacementBroker.attach(created.id, 'observe');
  const unprimedLive: AgentMessage[] = [];
  unprimedObserver.subscribe((message) => unprimedLive.push(message));
  // `hub.allApprovalsRejected` has been true since the Stop earlier in this
  // file and is only reset by `restoreMessages`, which is not called until
  // after the check below — so it proved nothing about THIS demotion. Quiescence
  // is a `run.abort` the demotion issues itself; count it across the transition.
  const abortsBeforeForeignRun = hub.frames.filter(
    (frame) => frame.envelope?.command === 'run.abort').length;
  hub.foreignRun();
  check('a foreign Hub run immediately demotes and retires writer authority',
    reopened.info.attachMode === 'observe' && reopened.info.control?.drive.supported === false);
  await assert.rejects(reopened.sendPrompt({ text: 'must refuse' }), /read-only/u);
  const demotedObserveHistory = await unprimedObserver.getHistory();
  check('writer demotion clears correlations held by an already-open unprimed Observe',
    unprimedLive.some((row) => row.type === 'history-reset')
      && demotedObserveHistory.some((row) => row.type === 'user-message'
        && row.text === 'after broker reconnect'
        && row.key !== 'client-second'
        && row.clientKey === undefined));
  await unprimedObserver.close();
  await reopened.close();
  const abortsAfterForeignRun = hub.frames.filter(
    (frame) => frame.envelope?.command === 'run.abort').length;
  check('foreign-run demotion confirms native quiescence without stopping the owned Hub',
    unsafeStops === 0 && abortsAfterForeignRun > abortsBeforeForeignRun,
    `aborts=${abortsAfterForeignRun - abortsBeforeForeignRun} unsafeStops=${unsafeStops}`);

  const resumeAdapter = () => new ClineAdapter({
    command: fake.path,
    env,
    homeDir: fake.root,
    fetcher,
    hubSocketFactory: hub.socketFactory,
    isManagedHostOwned: () => true,
    onUnsafeManagedAuthority: unsafeStop,
    authoritySettleTimeoutMs: 100,
    renameTimeoutMs: 1_000,
    resolveStoredDriveState: () => boundary ? {
      currentModel: { providerID: 'openai-compatible', modelID: 'fixture-model' },
      currentMode: 'ask',
      historyBoundary: boundary,
    } : undefined,
    revokeStoredDriveEligibility: () => {
      revokedStoredEligibility += 1;
      boundary = undefined;
    },
    recordStoredDriveBoundary: (record) => { boundary = { ...record.historyBoundary }; },
  });

  for (const failedRenameBehavior of ['fail', 'lie'] as const) {
    hub.restoreMessages(stableMessages);
    boundary = stableBoundary;
    env.FAKE_CLINE_RENAME_BEHAVIOR = failedRenameBehavior;
    const failedRenameAdapter = resumeAdapter();
    await assert.rejects(
      failedRenameAdapter.renameSession(created.id, `${failedRenameBehavior} native title`),
      isNativeSessionRenameUnsupportedError,
    );
    check(`${failedRenameBehavior} native history rename revokes unproved stored writer authority`,
      boundary === undefined
        && (await failedRenameAdapter.discoverSessions()).find((row) => row.id === created.id)?.title
          === 'Managed Cline renamed');
  }
  delete env.FAKE_CLINE_RENAME_BEHAVIOR;

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const staleRenameAdapter = resumeAdapter();
  hub.rewriteFirstMessage();
  const staleRenameUpdatesBefore = fake.ledger().filter((entry) => entry.kind === 'spawn'
    && entry.argv?.[0] === 'history' && entry.argv?.[1] === 'update').length;
  await assert.rejects(
    staleRenameAdapter.renameSession(created.id, 'Must not rename from stale ownership'),
    isNativeSessionRenameUnsupportedError,
  );
  check('inactive native rename refuses a stale stored transcript boundary before issuing history update',
    fake.ledger().filter((entry) => entry.kind === 'spawn'
      && entry.argv?.[0] === 'history' && entry.argv?.[1] === 'update').length === staleRenameUpdatesBefore
      && (await staleRenameAdapter.discoverSessions()).find((row) => row.id === created.id)?.title
        === 'Managed Cline renamed');

  for (const invalidStatus of [undefined, 'future-status'] as const) {
    hub.restoreMessages(stableMessages);
    boundary = stableBoundary;
    hub.setSessionStatus(invalidStatus);
    const invalidStatusAdapter = resumeAdapter();
    const invalidStatusSpawnsBefore = fake.ledger().filter((entry) => entry.kind === 'spawn'
      && entry.argv?.[0] === 'history' && entry.argv?.[1] === 'update').length;
    const revocationsBeforeInvalidStatus = revokedStoredEligibility;
    await assert.rejects(
      invalidStatusAdapter.renameSession(created.id, `Invalid status ${String(invalidStatus)}`),
      isNativeSessionRenameUnsupportedError,
    );
    check(`inactive native rename fails closed on ${invalidStatus === undefined ? 'missing' : 'unknown'} Hub status`,
      fake.ledger().filter((entry) => entry.kind === 'spawn'
        && entry.argv?.[0] === 'history' && entry.argv?.[1] === 'update').length === invalidStatusSpawnsBefore
        && revokedStoredEligibility === revocationsBeforeInvalidStatus + 1
        && boundary === undefined);
  }

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const afterStatusAdapter = resumeAdapter();
  const afterStatusGate = join(fake.root, 'after-status-rename.received');
  const afterStatusRelease = join(fake.root, 'after-status-rename.release');
  rmSync(afterStatusGate, { force: true });
  rmSync(afterStatusRelease, { force: true });
  env.FAKE_CLINE_RENAME_GATE = afterStatusGate;
  env.FAKE_CLINE_RENAME_RELEASE = afterStatusRelease;
  const afterStatusRename = afterStatusAdapter.renameSession(created.id, 'Unknown-after native title');
  for (let attempt = 0; attempt < 200 && !existsSync(afterStatusGate); attempt += 1) await Bun.sleep(5);
  assert.ok(existsSync(afterStatusGate));
  hub.setSessionStatus('future-status');
  writeFileSync(afterStatusRelease, 'release');
  delete env.FAKE_CLINE_RENAME_GATE;
  delete env.FAKE_CLINE_RENAME_RELEASE;
  const revocationsBeforeAfterStatus = revokedStoredEligibility;
  await assert.rejects(afterStatusRename, isNativeSessionRenameUnsupportedError);
  check('inactive native rename cannot report success when the post-mutation Hub status is unknown',
    revokedStoredEligibility === revocationsBeforeAfterStatus + 1 && boundary === undefined);
  hub.setDurableTitle('Managed Cline renamed');

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const lockedInactiveAdapter = resumeAdapter();
  const lockedInactiveGate = join(fake.root, 'locked-inactive-rename.received');
  const lockedInactiveRelease = join(fake.root, 'locked-inactive-rename.release');
  rmSync(lockedInactiveGate, { force: true });
  rmSync(lockedInactiveRelease, { force: true });
  env.FAKE_CLINE_RENAME_GATE = lockedInactiveGate;
  env.FAKE_CLINE_RENAME_RELEASE = lockedInactiveRelease;
  const startsBeforeLockedInactive = hub.frames.filter((frame) => frame.envelope?.command === 'run.start').length;
  const lockedInactiveRename = lockedInactiveAdapter.renameSession(created.id, 'Serialized inactive title');
  for (let attempt = 0; attempt < 200 && !existsSync(lockedInactiveGate); attempt += 1) await Bun.sleep(5);
  assert.ok(existsSync(lockedInactiveGate));
  await assert.rejects(
    lockedInactiveAdapter.attach(created.id, 'resume'),
    /native metadata mutation/u,
  );
  await assert.rejects(
    lockedInactiveAdapter.renameSession(created.id, 'Competing inactive title'),
    isNativeSessionRenameUnsupportedError,
  );
  check('inactive native rename reserves the session against concurrent Resume and rename',
    hub.frames.filter((frame) => frame.envelope?.command === 'run.start').length
      === startsBeforeLockedInactive);
  writeFileSync(lockedInactiveRelease, 'release');
  delete env.FAKE_CLINE_RENAME_GATE;
  delete env.FAKE_CLINE_RENAME_RELEASE;
  const lockedInactiveResult = await lockedInactiveRename;
  check('inactive native rename releases its reservation only after complete durable proof',
    lockedInactiveResult?.title === 'Serialized inactive title'
      && hub.frames.filter((frame) => frame.envelope?.command === 'run.start').length
        === startsBeforeLockedInactive);
  hub.setDurableTitle('Managed Cline renamed');

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const rejectedPostStatusAdapter = resumeAdapter();
  const rejectedPostStatusGate = join(fake.root, 'rejected-post-status.received');
  const rejectedPostStatusRelease = join(fake.root, 'rejected-post-status.release');
  rmSync(rejectedPostStatusGate, { force: true });
  rmSync(rejectedPostStatusRelease, { force: true });
  env.FAKE_CLINE_RENAME_GATE = rejectedPostStatusGate;
  env.FAKE_CLINE_RENAME_RELEASE = rejectedPostStatusRelease;
  const revocationsBeforeRejectedPostStatus = revokedStoredEligibility;
  const rejectedPostStatusRename = rejectedPostStatusAdapter.renameSession(
    created.id,
    'Rejected post-status title',
  );
  for (let attempt = 0; attempt < 200 && !existsSync(rejectedPostStatusGate); attempt += 1) await Bun.sleep(5);
  assert.ok(existsSync(rejectedPostStatusGate));
  hub.failNextSessionGet();
  writeFileSync(rejectedPostStatusRelease, 'release');
  delete env.FAKE_CLINE_RENAME_GATE;
  delete env.FAKE_CLINE_RENAME_RELEASE;
  await assert.rejects(rejectedPostStatusRename, isNativeSessionRenameUnsupportedError);
  await assert.rejects(
    rejectedPostStatusAdapter.attach(created.id, 'resume'),
    /not eligible|not app-owned|ownership|Resume/u,
  );
  check('inactive post-mutation session.get failure revokes persisted writer eligibility',
    revokedStoredEligibility === revocationsBeforeRejectedPostStatus + 1 && boundary === undefined);
  hub.setDurableTitle('Managed Cline renamed');

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const foreignInactiveAdapter = resumeAdapter();
  const foreignInactiveGate = join(fake.root, 'inactive-foreign-rename.received');
  const foreignInactiveRelease = join(fake.root, 'inactive-foreign-rename.release');
  rmSync(foreignInactiveGate, { force: true });
  rmSync(foreignInactiveRelease, { force: true });
  env.FAKE_CLINE_RENAME_GATE = foreignInactiveGate;
  env.FAKE_CLINE_RENAME_RELEASE = foreignInactiveRelease;
  const foreignInactiveRename = foreignInactiveAdapter.renameSession(created.id, 'Foreign inactive native title');
  for (let attempt = 0; attempt < 200 && !existsSync(foreignInactiveGate); attempt += 1) await Bun.sleep(5);
  assert.ok(existsSync(foreignInactiveGate));
  const abortsBeforeInactiveForeign = hub.frames.filter((frame) => frame.envelope?.command === 'run.abort').length;
  hub.foreignEnqueue();
  hub.foreignRun();
  writeFileSync(foreignInactiveRelease, 'release');
  delete env.FAKE_CLINE_RENAME_GATE;
  delete env.FAKE_CLINE_RENAME_RELEASE;
  await assert.rejects(foreignInactiveRename, isNativeSessionRenameUnsupportedError);
  await assert.rejects(
    foreignInactiveAdapter.attach(created.id, 'resume'),
    /not eligible|not app-owned|ownership|Resume/u,
  );
  check('inactive foreign enqueue/start revokes persisted Drive eligibility without aborting the foreign run',
    boundary === undefined
      && hub.frames.filter((frame) => frame.envelope?.command === 'run.abort').length
        === abortsBeforeInactiveForeign);
  hub.setDurableTitle('Managed Cline renamed');

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const settleFenceConnection = await resumeAdapter().attach(created.id, 'resume');
  const settleFenceLive: AgentMessage[] = [];
  settleFenceConnection.subscribe((message) => settleFenceLive.push(message));
  const heldForeignPersistence = hub.holdNextCompletedPersistence();
  const settleFenceTurn = settleFenceConnection.sendPrompt({
    text: 'foreign run during durable settle',
    clientMessageId: 'client-settle-fence',
  });
  void settleFenceTurn.catch(() => undefined);
  for (let attempt = 0; attempt < 40 && !(await settleFenceConnection.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await Bun.sleep(5);
  }
  const settleFencePermission = (await settleFenceConnection.getPending!())
    .find((row) => row.type === 'permission-request');
  await settleFenceConnection.respondPermission(settleFencePermission!.requestId, 'approve');
  await heldForeignPersistence.replySent;
  hub.foreignRun();
  heldForeignPersistence.release();
  await assert.rejects(settleFenceTurn, /read-only|ownership generation changed/u);
  const settleFenceHistory = await settleFenceConnection.getHistory();
  check('foreign demotion during durable settle cannot claim the delayed row and revokes its stored boundary',
    boundary === undefined
      && settleFenceConnection.info.attachMode === 'observe'
      && !settleFenceHistory.some((row) => row.type === 'user-message'
        && row.clientKey === 'client-settle-fence'));
  check('a turn demoted by a foreign run before it settles publishes no run summary at all',
    runSummaries(settleFenceLive).length === 0, runShape(settleFenceLive));
  await settleFenceConnection.close();

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const stopGapConnection = await resumeAdapter().attach(created.id, 'resume');
  const stopGapLive: AgentMessage[] = [];
  stopGapConnection.subscribe((message) => stopGapLive.push(message));
  const heldStopPersistence = hub.holdNextCompletedPersistence();
  const stopGapTurn = stopGapConnection.sendPrompt({
    text: 'Stop during durable settle',
    clientMessageId: 'client-stop-settle',
  });
  void stopGapTurn.catch(() => undefined);
  for (let attempt = 0; attempt < 40 && !(await stopGapConnection.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await Bun.sleep(5);
  }
  const stopGapPermission = (await stopGapConnection.getPending!()).find((row) => row.type === 'permission-request');
  await stopGapConnection.respondPermission(stopGapPermission!.requestId, 'approve');
  await heldStopPersistence.replySent;
  const stopGap = stopGapConnection.runCommand!('stop');
  await Bun.sleep(20);
  heldStopPersistence.release();
  await stopGapTurn;
  await stopGap;
  const stopGapIdentity = await stopGapConnection.getHistorySourceIdentity!();
  check('Stop rereads the final durable history after the prior turn settlement gap',
    stopGapIdentity?.sourceId === boundary?.sourceId
      && stopGapIdentity?.appendPosition === boundary?.appendPosition
      && stopGapIdentity?.rewriteToken === boundary?.rewriteToken
      && stopGapIdentity?.revision.startsWith(`${boundary?.revision}:cline-correlation:`) === true
      && (await stopGapConnection.getHistory()).some((row) => row.type === 'user-message'
        && row.text === 'Stop during durable settle'
        && row.clientKey === 'client-stop-settle'
        && row.queued === false));
  // Stop reports no terminal, so an early `running` would stay open with nothing to close it.
  check('a turn stopped from Cosyncing publishes no running frame',
    !hasRunningSummary(stopGapLive), runShape(stopGapLive));
  await stopGapConnection.close();

  hub.restoreMessages(stableMessages);
  let rewrittenStopBoundary: HistorySourceIdentity | undefined = stableBoundary
    ? { ...stableBoundary }
    : undefined;
  let rewrittenStopPublished = 0;
  let rewrittenStopRevoked = 0;
  const rewrittenStopAdapter = new ClineAdapter({
    command: fake.path,
    env,
    homeDir: fake.root,
    fetcher,
    hubSocketFactory: hub.socketFactory,
    isManagedHostOwned: () => true,
    onUnsafeManagedAuthority: unsafeStop,
    authoritySettleTimeoutMs: 100,
    renameTimeoutMs: 1_000,
    resolveStoredDriveState: () => rewrittenStopBoundary ? {
      currentModel: { providerID: 'openai-compatible', modelID: 'fixture-model' },
      currentMode: 'ask',
      historyBoundary: rewrittenStopBoundary,
    } : undefined,
    revokeStoredDriveEligibility: () => {
      rewrittenStopRevoked += 1;
      rewrittenStopBoundary = undefined;
    },
    recordStoredDriveBoundary: (record) => {
      rewrittenStopBoundary = { ...record.historyBoundary };
    },
    recordStoredPromptCorrelation: () => { rewrittenStopPublished += 1; },
  });
  const rewrittenStopConnection = await rewrittenStopAdapter.attach(created.id, 'resume');
  const rewrittenStopTurn = rewrittenStopConnection.sendPrompt({
    text: 'Stop must reject rewritten provisional prefix',
    clientMessageId: 'client-rewritten-stop',
  });
  void rewrittenStopTurn.catch(() => undefined);
  for (let attempt = 0; attempt < 40
    && !(await rewrittenStopConnection.getPending!()).some((row) => row.type === 'permission-request');
    attempt += 1) await Bun.sleep(5);
  // This consumes the queued prompt into an unpublished exact claim.
  await rewrittenStopConnection.getHistory();
  hub.rewriteFirstMessage();
  await assert.rejects(
    rewrittenStopConnection.runCommand!('stop'),
    /unproved final transcript boundary/u,
  );
  await rewrittenStopTurn;
  check('Stop rejects a rewritten prefix after getHistory consumed the provisional prompt claim',
    rewrittenStopRevoked === 1
      && rewrittenStopBoundary === undefined
      && rewrittenStopPublished === 0
      && rewrittenStopConnection.info.control?.drive.state === 'observing');
  await rewrittenStopConnection.close();

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const assistantGapConnection = await resumeAdapter().attach(created.id, 'resume');
  const assistantGapLive: AgentMessage[] = [];
  assistantGapConnection.subscribe((message) => assistantGapLive.push(message));
  hub.omitAssistantFromNextCompletedRun();
  const assistantGapTurn = assistantGapConnection.sendPrompt({
    text: 'completed without durable assistant',
    clientMessageId: 'client-assistant-gap',
  });
  void assistantGapTurn.catch(() => undefined);
  for (let attempt = 0; attempt < 40 && !(await assistantGapConnection.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await Bun.sleep(5);
  }
  const assistantGapPermission = (await assistantGapConnection.getPending!())
    .find((row) => row.type === 'permission-request');
  await assistantGapConnection.respondPermission(assistantGapPermission!.requestId, 'approve');
  await assert.rejects(assistantGapTurn, /durable assistant response/u);
  check('a completed reply without a durable assistant response demotes stale Drive authority',
    assistantGapConnection.info.attachMode === 'observe'
      && assistantGapConnection.info.control?.drive.supported === false);
  check('a completion the Drive cannot prove publishes no run summary at all',
    runSummaries(assistantGapLive).length === 0, runShape(assistantGapLive));
  await assistantGapConnection.close();

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const missingFailedConnection = await resumeAdapter().attach(created.id, 'resume');
  hub.failNextRunSnapshotOnly('missing prompt failure', 'missing');
  await assert.rejects(
    missingFailedConnection.sendPrompt({
      text: 'failed run without durable prompt',
      clientMessageId: 'client-failed-missing',
    }),
    /exact causal user row/u,
  );
  check('snapshot-only run.failed without one exact durable prompt demotes without claiming correlation',
    missingFailedConnection.info.attachMode === 'observe'
      && !(await missingFailedConnection.getHistory()).some((row) => row.type === 'user-message'
        && row.clientKey === 'client-failed-missing'));
  await missingFailedConnection.close();

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const mismatchedFailedConnection = await resumeAdapter().attach(created.id, 'resume');
  hub.failNextRunSnapshotOnly('mismatched prompt failure', 'mismatch');
  await assert.rejects(
    mismatchedFailedConnection.sendPrompt({
      text: 'failed run with mismatched durable prompt',
      clientMessageId: 'client-failed-mismatch',
    }),
    /exact causal user row/u,
  );
  check('snapshot-only run.failed with a different durable prompt demotes without borrowing correlation',
    mismatchedFailedConnection.info.attachMode === 'observe'
      && !(await mismatchedFailedConnection.getHistory()).some((row) => row.type === 'user-message'
        && row.clientKey === 'client-failed-mismatch'));
  await mismatchedFailedConnection.close();

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const unattributedFailedConnection = await resumeAdapter().attach(created.id, 'resume');
  const unattributedFailedLive: AgentMessage[] = [];
  unattributedFailedConnection.subscribe((message) => unattributedFailedLive.push(message));
  hub.failNextRunSnapshotOnly('unattributed terminal failure', 'exact', true);
  await assert.rejects(
    unattributedFailedConnection.sendPrompt({
      text: 'terminal before own run started',
      clientMessageId: 'client-failed-unattributed',
    }),
    /unknown terminal run result/u,
  );
  check('run.failed before the owned run.started event is ignored and cannot claim the durable row',
    unattributedFailedConnection.info.attachMode === 'observe'
      && !(await unattributedFailedConnection.getHistory()).some((row) => row.type === 'user-message'
        && row.clientKey === 'client-failed-unattributed'));
  check('a terminal event that precedes the owned run.started publishes no run summary at all',
    runSummaries(unattributedFailedLive).length === 0, runShape(unattributedFailedLive));
  await unattributedFailedConnection.close();

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const extraBlockConnection = await resumeAdapter().attach(created.id, 'resume');
  hub.addExtraUserBlockToNextRun();
  const extraBlockTurn = extraBlockConnection.sendPrompt({
    text: 'one exact native block only',
    clientMessageId: 'client-extra-block',
  });
  void extraBlockTurn.catch(() => undefined);
  for (let attempt = 0; attempt < 40 && !(await extraBlockConnection.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await Bun.sleep(5);
  }
  const extraBlockPermission = (await extraBlockConnection.getPending!()).find((row) => row.type === 'permission-request');
  await extraBlockConnection.respondPermission(extraBlockPermission!.requestId, 'approve');
  await assert.rejects(extraBlockTurn, /exact causal user row/u);
  const extraBlockHistory = await extraBlockConnection.getHistory();
  check('an extra native user content block is ambiguous and never inherits the queued correlation',
    extraBlockConnection.info.attachMode === 'observe'
      && !extraBlockHistory.some((row) => row.type === 'user-message'
        && row.clientKey === 'client-extra-block'));
  await extraBlockConnection.close();

  // Regression: Cline persists tool results as `role: 'user'` rows carrying `tool_result` blocks,
  // which is exactly what this adapter's own decoder reads back as `tool-result`. Counting them as
  // human prompts made the FIRST tool-using turn of every managed session fail its causal-turn
  // check and demote its own Drive, losing the correlation, the answer and the run summary. A
  // tool-using turn must complete and keep Drive.
  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const toolTurnConnection = await resumeAdapter().attach(created.id, 'resume');
  hub.useToolResultTurnNext();
  const toolTurn = toolTurnConnection.sendPrompt({
    text: 'read the fixture file',
    clientMessageId: 'client-tool-result-turn',
  });
  void toolTurn.catch(() => undefined);
  for (let attempt = 0; attempt < 40 && !(await toolTurnConnection.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await Bun.sleep(5);
  }
  const toolTurnPermission = (await toolTurnConnection.getPending!()).find((row) => row.type === 'permission-request');
  await toolTurnConnection.respondPermission(toolTurnPermission!.requestId, 'approve');
  await toolTurn;
  const toolTurnHistory = await toolTurnConnection.getHistory();
  check('a tool-using turn keeps Drive and correlates its prompt despite the native user-role tool result',
    toolTurnConnection.info.attachMode !== 'observe'
      && toolTurnHistory.some((row) => row.type === 'user-message'
        && row.clientKey === 'client-tool-result-turn')
      && toolTurnHistory.some((row) => row.type === 'tool-result')
      && toolTurnHistory.some((row) => row.type === 'run-summary'),
    JSON.stringify({
      attachMode: toolTurnConnection.info.attachMode,
      types: toolTurnHistory.map((row) => row.type),
    }));
  // Regression: per-turn permission-mode switching is fixed at creation — sendPrompt refuses any
  // change and adapter-support.md F08 records it — so the SESSION-scoped catalog must advertise
  // only the mode this session is actually in. Advertising the whole creation vocabulary let the
  // composer render a picker of modes the session can never enter; selecting one attached it to
  // every later prompt and every one of those prompts failed, with nothing clearing the choice.
  const sessionModes = await toolTurnConnection.listModes!();
  check('a live Cline session advertises only the mode it was created with',
    sessionModes.length === 1 && sessionModes[0]?.value === 'ask',
    JSON.stringify(sessionModes.map((mode) => mode.value)));

  await toolTurnConnection.close();

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const admissionConnection = await resumeAdapter().attach(created.id, 'resume');
  const delayedMessages = hub.delayNextMessagesReply();
  const demotedAdmission = admissionConnection.sendPrompt({
    text: 'must not start after demotion',
    clientMessageId: 'client-demoted-admission',
  });
  void demotedAdmission.catch(() => undefined);
  await delayedMessages.received;
  const startsBeforeAdmissionDemotion = hub.frames.filter((frame) =>
    frame.envelope?.command === 'run.start').length;
  hub.foreignRun();
  delayedMessages.release();
  await assert.rejects(demotedAdmission, /read-only|ownership generation changed/u);
  await admissionConnection.close();
  check('demotion during the preflight snapshot refuses the prompt before native run.start',
    admissionConnection.info.attachMode === 'observe'
      && hub.frames.filter((frame) => frame.envelope?.command === 'run.start').length
        === startsBeforeAdmissionDemotion);

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const closingConnection = await resumeAdapter().attach(created.id, 'resume');
  const closingTurn = closingConnection.sendPrompt({
    text: 'active turn at close',
    clientMessageId: 'client-active-close',
  });
  void closingTurn.catch(() => undefined);
  for (let attempt = 0; attempt < 40 && !(await closingConnection.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await Bun.sleep(5);
  }
  const startsBeforeClose = hub.frames.filter((frame) =>
    frame.envelope?.command === 'run.start').length;
  const closing = closingConnection.close();
  const peerPromptDuringClose = closingConnection.sendPrompt({
    text: 'peer prompt during close',
    clientMessageId: 'client-peer-close',
  });
  void peerPromptDuringClose.catch(() => undefined);
  await assert.rejects(peerPromptDuringClose, /connection is closing/u);
  await closing;
  await closingTurn.catch(() => undefined);
  check('close fences peer prompt admission before aborting the active native turn',
    hub.frames.filter((frame) => frame.envelope?.command === 'run.start').length === startsBeforeClose);

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const lostReplyConnection = await resumeAdapter().attach(created.id, 'resume');
  const lostReplyTurn = lostReplyConnection.sendPrompt({
    text: 'native loses terminal reply',
    clientMessageId: 'client-lost-reply',
  });
  void lostReplyTurn.catch(() => undefined);
  for (let attempt = 0; attempt < 40 && !(await lostReplyConnection.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await Bun.sleep(5);
  }
  hub.setAbortRepliesToRun(false);
  const lostReplyLive: AgentMessage[] = [];
  lostReplyConnection.subscribe((message) => lostReplyLive.push(message));
  await assert.rejects(
    lostReplyConnection.runCommand!('stop'),
    /prior native request did not settle/u,
  );
  check('Stop is bounded and demotes when native idle is proved but the original run reply is lost',
    lostReplyConnection.info.attachMode === 'observe');
  // "Lost" and "late" reach the identical demotion, and only one of them is a
  // reason to size the bound differently. Measured on the installed managed
  // Cline, every Stop leg demotes here with nothing to say which it was.
  hub.deliverDeferredRunReply();
  for (let attempt = 0; attempt < 40 && !lostReplyLive.some((message) => message.type === 'notice'
    && /authority settle bound/u.test(message.message)); attempt += 1) {
    await Bun.sleep(5);
  }
  const lateSettleNotice = lostReplyLive.find((message): message is Extract<AgentMessage, { type: 'notice' }> =>
    message.type === 'notice' && /authority settle bound/u.test(message.message));
  // This fixture DELIVERS the deferred reply, so it models a genuinely late
  // native reply and has to say that, not "never arrived". The report tells the
  // two apart by HOW the chain settles -- resolved means Cline answered late,
  // rejected means demoting the connection released it -- because `demoted`
  // cannot: the caller demotes on the microtask right after the settle wait
  // gives up, so it is always true by the time the chain moves and a check on
  // it can only ever print one of its two messages.
  //
  // Getting this backwards has a cost on record: reading "past the 5000ms
  // bound" as a bound 55ms too tight led to raising it to 15_000, which only
  // moved the reported settle with it -- 5055ms at 5000, 15050ms at 15000.
  check('a run reply that really does arrive after the bound is reported as its own arrival',
    !!lateSettleNotice && /settled \d+ms into the settle wait/u.test(lateSettleNotice.message)
      && /by replying on its own/u.test(lateSettleNotice.message)
      && !/never arrived/u.test(lateSettleNotice.message),
    JSON.stringify(lateSettleNotice));
  await lostReplyConnection.close();
  await lostReplyTurn.catch(() => undefined);

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const rewriteConnection = await resumeAdapter().attach(created.id, 'resume');
  const rewriteTurn = rewriteConnection.sendPrompt({ text: 'rewrite race prompt', clientMessageId: 'client-rewrite' });
  void rewriteTurn.catch(() => undefined);
  for (let attempt = 0; attempt < 40 && !(await rewriteConnection.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await Bun.sleep(5);
  }
  hub.rewriteFirstMessage();
  await rewriteConnection.getHistory();
  check('a same-id rewrite of an earlier row during a turn demotes and clears old correlation',
    rewriteConnection.info.attachMode === 'observe'
      // `client-first` belonged to a DIFFERENT adapter instance and this one
      // never hydrates prompt correlations, so that key was unreachable and the
      // negation was true before the rewrite, after it, and with the rewrite
      // handling deleted. `client-rewrite` is this connection's own in-flight
      // correlation — the one `demote()` actually clears.
      && !(await rewriteConnection.getHistory()).some((row) => row.type === 'user-message'
        && row.clientKey === 'client-rewrite'));
  await rewriteConnection.close();
  await rewriteTurn.catch(() => undefined);

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const transportConnection = await resumeAdapter().attach(created.id, 'resume');
  const transportTurn = transportConnection.sendPrompt({ text: 'transport loss prompt', clientMessageId: 'client-transport' });
  void transportTurn.catch(() => undefined);
  for (let attempt = 0; attempt < 40 && !(await transportConnection.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await Bun.sleep(5);
  }
  const abortsBeforeTransportLoss = hub.frames.filter((frame) => frame.envelope?.command === 'run.abort').length;
  hub.latestSocket!.rawMessage('{');
  for (let attempt = 0; attempt < 40 && hub.frames.filter((frame) => frame.envelope?.command === 'run.abort').length === abortsBeforeTransportLoss; attempt += 1) {
    await Bun.sleep(5);
  }
  await transportConnection.close();
  await transportTurn.catch(() => undefined);
  check('transport loss recovers a management client and proves the native turn stopped',
    transportConnection.info.attachMode === 'observe'
      && hub.frames.filter((frame) => frame.envelope?.command === 'run.abort').length > abortsBeforeTransportLoss
      && unsafeStops === 0);

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const preRewriteRenameAdapter = resumeAdapter();
  const preRewriteRenameConnection = await preRewriteRenameAdapter.attach(created.id, 'resume');
  const preRewriteUpdatesBefore = fake.ledger().filter((entry) => entry.kind === 'spawn'
    && entry.argv?.[0] === 'history' && entry.argv?.[1] === 'update').length;
  hub.rewriteFirstMessage();
  await assert.rejects(
    preRewriteRenameAdapter.renameSession(created.id, 'Pre-rewrite native title'),
    isNativeSessionRenameUnsupportedError,
  );
  check('an unannounced transcript rewrite before active rename demotes Drive without issuing history update',
    preRewriteRenameConnection.info.attachMode === 'observe'
      && fake.ledger().filter((entry) => entry.kind === 'spawn'
        && entry.argv?.[0] === 'history' && entry.argv?.[1] === 'update').length === preRewriteUpdatesBefore);
  await preRewriteRenameConnection.close();

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const rewriteRaceAdapter = resumeAdapter();
  const rewriteRaceConnection = await rewriteRaceAdapter.attach(created.id, 'resume');
  const rewriteRenameGate = join(fake.root, 'rewrite-rename.received');
  const rewriteRenameRelease = join(fake.root, 'rewrite-rename.release');
  rmSync(rewriteRenameGate, { force: true });
  rmSync(rewriteRenameRelease, { force: true });
  env.FAKE_CLINE_RENAME_GATE = rewriteRenameGate;
  env.FAKE_CLINE_RENAME_RELEASE = rewriteRenameRelease;
  const rewriteRacedRename = rewriteRaceAdapter.renameSession(created.id, 'Rewrite-raced native title');
  for (let attempt = 0; attempt < 200 && !existsSync(rewriteRenameGate); attempt += 1) await Bun.sleep(5);
  assert.ok(existsSync(rewriteRenameGate));
  hub.rewriteFirstMessage();
  writeFileSync(rewriteRenameRelease, 'release');
  delete env.FAKE_CLINE_RENAME_GATE;
  delete env.FAKE_CLINE_RENAME_RELEASE;
  await assert.rejects(rewriteRacedRename, isNativeSessionRenameUnsupportedError);
  check('an unannounced transcript rewrite during native rename prevents success and demotes Drive',
    rewriteRaceConnection.info.attachMode === 'observe'
      && rewriteRaceConnection.info.control?.drive.supported === false);
  await rewriteRaceConnection.close();
  hub.setDurableTitle('Managed Cline renamed');

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const rejectedActiveStatusAdapter = resumeAdapter();
  const rejectedActiveStatusConnection = await rejectedActiveStatusAdapter.attach(created.id, 'resume');
  const rejectedActiveStatusGate = join(fake.root, 'active-rejected-post-status.received');
  const rejectedActiveStatusRelease = join(fake.root, 'active-rejected-post-status.release');
  rmSync(rejectedActiveStatusGate, { force: true });
  rmSync(rejectedActiveStatusRelease, { force: true });
  env.FAKE_CLINE_RENAME_GATE = rejectedActiveStatusGate;
  env.FAKE_CLINE_RENAME_RELEASE = rejectedActiveStatusRelease;
  const rejectedActiveStatusRename = rejectedActiveStatusAdapter.renameSession(
    created.id,
    'Active rejected post-status title',
  );
  for (let attempt = 0; attempt < 200 && !existsSync(rejectedActiveStatusGate); attempt += 1) await Bun.sleep(5);
  assert.ok(existsSync(rejectedActiveStatusGate));
  hub.failNextSessionGet();
  writeFileSync(rejectedActiveStatusRelease, 'release');
  delete env.FAKE_CLINE_RENAME_GATE;
  delete env.FAKE_CLINE_RENAME_RELEASE;
  await assert.rejects(rejectedActiveStatusRename, isNativeSessionRenameUnsupportedError);
  await assert.rejects(
    rejectedActiveStatusConnection.sendPrompt({ text: 'must refuse after unproved rename' }),
    /read-only/u,
  );
  check('active post-mutation session.get failure demotes writer authority',
    rejectedActiveStatusConnection.info.attachMode === 'observe'
      && rejectedActiveStatusConnection.info.control?.drive.supported === false);
  await rejectedActiveStatusConnection.close();
  hub.setDurableTitle('Managed Cline renamed');

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const busyRenameAdapter = resumeAdapter();
  const busyRenameConnection = await busyRenameAdapter.attach(created.id, 'resume');
  const busyRenameTurn = busyRenameConnection.sendPrompt({
    text: 'turn survives refused rename',
    clientMessageId: 'client-busy-rename',
  });
  for (let attempt = 0; attempt < 40 && !(await busyRenameConnection.getPending!())
    .some((row) => row.type === 'permission-request'); attempt += 1) {
    await Bun.sleep(5);
  }
  const busyRenamePermission = (await busyRenameConnection.getPending!())
    .find((row) => row.type === 'permission-request');
  assert.ok(busyRenamePermission?.type === 'permission-request');
  const busyRenameSpawnsBefore = fake.ledger().filter((entry) => entry.kind === 'spawn'
    && entry.argv?.[0] === 'history' && entry.argv?.[1] === 'update').length;
  const busyRenameAbortsBefore = hub.frames.filter((frame) => frame.envelope?.command === 'run.abort').length;
  await assert.rejects(
    busyRenameAdapter.renameSession(created.id, 'Must wait for active turn'),
    isNativeSessionRenameUnsupportedError,
  );
  check('rename admission refusal during an active turn preserves its writer and permission',
    busyRenameConnection.info.control?.drive.state === 'driving'
      && (await busyRenameConnection.getPending!()).some((row) =>
        row.type === 'permission-request' && row.requestId === busyRenamePermission.requestId)
      && fake.ledger().filter((entry) => entry.kind === 'spawn'
        && entry.argv?.[0] === 'history' && entry.argv?.[1] === 'update').length
        === busyRenameSpawnsBefore
      && hub.frames.filter((frame) => frame.envelope?.command === 'run.abort').length
        === busyRenameAbortsBefore);
  await busyRenameConnection.respondPermission(busyRenamePermission.requestId, 'approve');
  await busyRenameTurn;
  check('the original turn completes after refused busy rename without native abort',
    busyRenameConnection.info.control?.drive.state === 'driving'
      && (await busyRenameConnection.getHistory()).some((row) =>
        row.type === 'model-output' && row.text === 'answer:turn survives refused rename')
      && hub.frames.filter((frame) => frame.envelope?.command === 'run.abort').length
        === busyRenameAbortsBefore);
  await busyRenameConnection.close();

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const closeDuringRenameAdapter = resumeAdapter();
  const closeDuringRenameConnection = await closeDuringRenameAdapter.attach(created.id, 'resume');
  const closeDuringRenameGate = join(fake.root, 'close-during-rename.received');
  const closeDuringRenameRelease = join(fake.root, 'close-during-rename.release');
  rmSync(closeDuringRenameGate, { force: true });
  rmSync(closeDuringRenameRelease, { force: true });
  env.FAKE_CLINE_RENAME_GATE = closeDuringRenameGate;
  env.FAKE_CLINE_RENAME_RELEASE = closeDuringRenameRelease;
  const startsBeforeCloseDuringRename = hub.frames.filter((frame) => frame.envelope?.command === 'run.start').length;
  const closeDuringRename = closeDuringRenameAdapter.renameSession(
    created.id,
    'Closed writer native title',
  );
  for (let attempt = 0; attempt < 200 && !existsSync(closeDuringRenameGate); attempt += 1) await Bun.sleep(5);
  assert.ok(existsSync(closeDuringRenameGate));
  await closeDuringRenameConnection.close();
  await assert.rejects(
    closeDuringRenameAdapter.attach(created.id, 'resume'),
    /native metadata mutation/u,
  );
  await assert.rejects(
    closeDuringRenameAdapter.renameSession(created.id, 'Competing closed-writer title'),
    isNativeSessionRenameUnsupportedError,
  );
  check('active native rename keeps its adapter reservation after the writer closes',
    hub.frames.filter((frame) => frame.envelope?.command === 'run.start').length
      === startsBeforeCloseDuringRename);
  writeFileSync(closeDuringRenameRelease, 'release');
  delete env.FAKE_CLINE_RENAME_GATE;
  delete env.FAKE_CLINE_RENAME_RELEASE;
  await assert.rejects(closeDuringRename, isNativeSessionRenameUnsupportedError);
  check('closed-writer rename revokes eligibility after the native child settles', boundary === undefined);
  hub.setDurableTitle('Managed Cline renamed');

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const collisionRenameAdapter = resumeAdapter();
  const collisionRenameConnection = await collisionRenameAdapter.attach(created.id, 'resume');
  const collisionRenameGate = join(fake.root, 'collision-rename.received');
  const collisionRenameRelease = join(fake.root, 'collision-rename.release');
  const collisionTitle = 'Ambiguous ordinary-profile title';
  const collisionDir = join(fake.dataRoot, 'sessions', created.id);
  rmSync(collisionRenameGate, { force: true });
  rmSync(collisionRenameRelease, { force: true });
  rmSync(collisionDir, { recursive: true, force: true });
  env.FAKE_CLINE_RENAME_GATE = collisionRenameGate;
  env.FAKE_CLINE_RENAME_RELEASE = collisionRenameRelease;
  const collisionRename = collisionRenameAdapter.renameSession(created.id, collisionTitle);
  for (let attempt = 0; attempt < 200 && !existsSync(collisionRenameGate); attempt += 1) await Bun.sleep(5);
  assert.ok(existsSync(collisionRenameGate));
  mkdirSync(collisionDir, { recursive: true });
  writeFileSync(join(collisionDir, `${created.id}.json`), `${JSON.stringify({
    session_id: created.id,
    cwd: fake.cwd,
    provider: 'openai-compatible',
    model: 'fixture-model',
    started_at: '2026-09-01T00:00:00.000Z',
    status: 'idle',
    metadata: { title: collisionTitle, mode: 'ask', autoApproveTools: false },
  })}\n`);
  writeFileSync(join(collisionDir, `${created.id}.messages.json`), `${JSON.stringify({
    version: 1,
    agent: 'lead',
    sessionId: created.id,
    origin: { source: 'cli', mode: 'user', sessionId: created.id, version: '3.0.60' },
    updated_at: new Date().toISOString(),
    messages: stableMessages,
  })}\n`);
  writeFileSync(collisionRenameRelease, 'release');
  delete env.FAKE_CLINE_RENAME_GATE;
  delete env.FAKE_CLINE_RENAME_RELEASE;
  await assert.rejects(collisionRename, isNativeSessionRenameUnsupportedError);
  check('same-id ordinary-profile collision cannot satisfy managed durable rename proof',
    collisionRenameConnection.info.attachMode === 'observe'
      && collisionRenameConnection.info.control?.drive.supported === false
      && boundary === undefined);
  await collisionRenameConnection.close();
  rmSync(collisionDir, { recursive: true, force: true });
  hub.setDurableTitle('Managed Cline renamed');

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const renameRaceAdapter = resumeAdapter();
  const renameRaceConnection = await renameRaceAdapter.attach(created.id, 'resume');
  const foreignRenameGate = join(fake.root, 'foreign-rename.received');
  const foreignRenameRelease = join(fake.root, 'foreign-rename.release');
  rmSync(foreignRenameGate, { force: true });
  rmSync(foreignRenameRelease, { force: true });
  env.FAKE_CLINE_RENAME_GATE = foreignRenameGate;
  env.FAKE_CLINE_RENAME_RELEASE = foreignRenameRelease;
  const racedRename = renameRaceAdapter.renameSession(created.id, 'Foreign-raced native title');
  for (let attempt = 0; attempt < 200 && !existsSync(foreignRenameGate); attempt += 1) await Bun.sleep(5);
  assert.ok(existsSync(foreignRenameGate));
  hub.foreignRun();
  writeFileSync(foreignRenameRelease, 'release');
  delete env.FAKE_CLINE_RENAME_GATE;
  delete env.FAKE_CLINE_RENAME_RELEASE;
  await assert.rejects(racedRename, isNativeSessionRenameUnsupportedError);
  check('foreign ownership during an active native rename prevents a native-success result and demotes Drive',
    renameRaceConnection.info.attachMode === 'observe'
      && renameRaceConnection.info.control?.drive.supported === false);
  await renameRaceConnection.close();
  hub.setDurableTitle('Managed Cline renamed');

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const failedStopConnection = await resumeAdapter().attach(created.id, 'resume');
  const failedStopTurn = failedStopConnection.sendPrompt({ text: 'native abort failure prompt' });
  void failedStopTurn.catch(() => undefined);
  for (let attempt = 0; attempt < 40 && !(await failedStopConnection.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await Bun.sleep(5);
  }
  hub.setAbortSucceeds(false);
  const unsafeBeforeFailedStop = unsafeStops;
  await assert.rejects(failedStopConnection.runCommand!('stop'), /failed closed/u);
  await failedStopConnection.close();
  await failedStopTurn.catch(() => undefined);
  check('a lying run.abort reply demotes and invokes the proven-owned Hub stop fence',
    failedStopConnection.info.attachMode === 'observe' && unsafeStops === unsafeBeforeFailedStop + 1);

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const failedFenceAdapter = new ClineAdapter({
    command: fake.path,
    env,
    homeDir: fake.root,
    fetcher,
    hubSocketFactory: hub.socketFactory,
    isManagedHostOwned: () => true,
    onUnsafeManagedAuthority: async () => { throw new Error('fixture managed-Hub stop failed'); },
    authoritySettleTimeoutMs: 100,
    resolveStoredDriveState: () => boundary ? {
      currentModel: { providerID: 'openai-compatible', modelID: 'fixture-model' },
      currentMode: 'ask',
      historyBoundary: boundary,
    } : undefined,
    recordStoredDriveBoundary: (record) => { boundary = { ...record.historyBoundary }; },
  });
  const failedFenceConnection = await failedFenceAdapter.attach(created.id, 'resume');
  const failedFenceTurn = failedFenceConnection.sendPrompt({ text: 'failed authority fence prompt' });
  void failedFenceTurn.catch(() => undefined);
  for (let attempt = 0; attempt < 40 && !(await failedFenceConnection.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await Bun.sleep(5);
  }
  hub.setAbortSucceeds(false);
  await assert.rejects(
    failedFenceConnection.close(),
    /closed without proving|stop fence both failed/u,
  );
  await failedFenceTurn.catch(() => undefined);
  check('a failed managed-Hub stop fence makes connection disposal report unsafe surviving authority',
    failedFenceConnection.info.attachMode === 'resume');

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;
  const overflowConnection = await resumeAdapter().attach(created.id, 'resume');
  const overflowTurn = overflowConnection.sendPrompt({ text: 'permission overflow prompt' });
  void overflowTurn.catch(() => undefined);
  for (let attempt = 0; attempt < 40 && !(await overflowConnection.getPending!()).some((row) => row.type === 'permission-request'); attempt += 1) {
    await Bun.sleep(5);
  }
  // Count REJECTIONS, not `hub.allApprovalsRejected`. That flag is set by any
  // successful `run.abort` (see the FakeHub receive handler), and the demotion
  // under test always issues one of its own — so it was true however the 65
  // approvals were handled. `cancelPendingPermissions` dispatches each
  // rejection fire-and-forget; if that dispatch broke, Cline would hold every
  // approval open forever while cosyncing showed none pending, and the old
  // assertion still passed. The delta is the discriminating measure.
  const rejectionsBefore = hub.frames.filter((frame) =>
    frame.envelope?.command === 'approval.respond'
      && frame.envelope.payload.approved === false).length;
  hub.approvalBurst(64);
  await overflowConnection.close();
  await overflowTurn.catch(() => undefined);
  const rejectionsAfter = hub.frames.filter((frame) =>
    frame.envelope?.command === 'approval.respond'
      && frame.envelope.payload.approved === false).length;
  check('permission overflow demotes and natively rejects the complete approval set',
    overflowConnection.info.attachMode === 'observe'
      && (await overflowConnection.getPending!()).length === 0
      && rejectionsAfter - rejectionsBefore >= 65,
    `rejected=${rejectionsAfter - rejectionsBefore}`);

  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;

  assert.ok(discovery);
  const boundedClaimMessages = Array.from({ length: 65 }, (_, index): ClineNativeMessage => ({
    id: `bounded-user-${index}`,
    role: 'user',
    content: [{ type: 'text', text: `bounded prompt ${index}` }],
  }));
  hub.restoreMessages(boundedClaimMessages);
  const boundedClaimBoundary = clineHubHistoryIdentity(
    profile,
    created.id,
    clineHubEpoch(discovery),
    boundedClaimMessages,
  );
  const boundedClaimCorrelations = boundedClaimMessages.map((message, index): ClinePromptCorrelation => ({
    nativeMessageId: message.id,
    nativeMessageDigest: clineNativeMessageDigest(message),
    key: `bounded-key-${index}`,
    clientKey: `bounded-client-${index}`,
  }));
  const boundedClaimAdapter = new ClineAdapter({
    command: fake.path,
    env,
    homeDir: fake.root,
    fetcher,
    hubSocketFactory: hub.socketFactory,
    isManagedHostOwned: () => true,
    resolveStoredDriveState: () => ({
      currentModel: { providerID: 'openai-compatible', modelID: 'fixture-model' },
      currentMode: 'ask',
      historyBoundary: boundedClaimBoundary,
      promptCorrelations: boundedClaimCorrelations,
    }),
  });
  const boundedClaimDrive = await boundedClaimAdapter.attach(created.id, 'resume');
  const boundedClaimObserve = await boundedClaimAdapter.attach(created.id, 'observe');
  const boundedDriveHistory = await boundedClaimDrive.getHistory();
  const boundedObserveHistory = await boundedClaimObserve.getHistory();
  const boundedDriveIdentity = await boundedClaimDrive.getHistorySourceIdentity!();
  const boundedObserveIdentity = await boundedClaimObserve.getHistorySourceIdentity!();
  check('Hub Drive and Observe share the same 64-row FIFO replay-correlation projection',
    boundedDriveHistory.some((row) => row.type === 'user-message'
      && row.text === 'bounded prompt 0'
      && row.key !== 'bounded-key-0'
      && row.clientKey === undefined)
      && boundedObserveHistory.some((row) => row.type === 'user-message'
        && row.text === 'bounded prompt 0'
        && row.key !== 'bounded-key-0'
        && row.clientKey === undefined)
      && boundedDriveHistory.some((row) => row.type === 'user-message'
        && row.text === 'bounded prompt 64'
        && row.key === 'bounded-key-64'
        && row.clientKey === 'bounded-client-64')
      && boundedObserveHistory.some((row) => row.type === 'user-message'
        && row.text === 'bounded prompt 64'
        && row.key === 'bounded-key-64'
        && row.clientKey === 'bounded-client-64')
      && boundedDriveIdentity?.revision.split(':cline-correlation:').at(-1)
        === boundedObserveIdentity?.revision.split(':cline-correlation:').at(-1));
  await boundedClaimObserve.close();
  await boundedClaimDrive.close();
  hub.restoreMessages(stableMessages);
  boundary = stableBoundary;

  const boundedClient = new ClineHubClient({
    discovery,
    clientId: 'bounded-client',
    workspaceRoot: fake.cwd,
    cwd: fake.cwd,
    socketFactory: hub.socketFactory,
  });
  await boundedClient.connect();
  check('a valid near-limit native reply fits inside the separate frame-overhead budget',
    String((await boundedClient.command('near.limit')).padding).length === 32 * 1024 * 1024);
  await assert.rejects(
    boundedClient.command('session.messages', { padding: 'x'.repeat(CLINE_HUB_MAX_FRAME_BYTES) }),
    /outbound frame exceeds/u,
  );
  check('an oversized outbound Hub frame is rejected while the bounded connection stays usable',
    (await boundedClient.command('session.messages', { sessionId: created.id }, created.id)).sessionId === created.id);
  let malformedClosed = false;
  boundedClient.onClose(() => { malformedClosed = true; });
  hub.latestSocket!.rawMessage('{');
  await Bun.sleep(0);
  await assert.rejects(
    boundedClient.command('session.messages', { sessionId: created.id }, created.id),
    /closed/u,
  );
  check('a malformed inbound Hub frame closes the writer transport and rejects further commands', malformedClosed);

  writeFileSync(discoveryPath, `${JSON.stringify({
    hubId: 'replacement-hub',
    protocolVersion: CLINE_HUB_PROTOCOL_VERSION,
    capabilities: ['session.create', 'session.run', 'session.abort', 'run.enqueue', 'run.list', 'stream.replay'],
    coreVersion: CLINE_HUB_CORE_MINIMUM_VERSION,
    authToken: 'fixture-owner-token',
    host: '127.0.0.1', port: 25464, url: 'ws://127.0.0.1:25464/hub', pid: process.pid,
    startedAt: '2026-09-01T00:10:00.000Z', updatedAt: '2026-09-01T00:10:00.000Z',
  })}\n`, { mode: 0o600 });
  let epochRevoked = false;
  const afterHubRestart = new ClineAdapter({
    command: fake.path, env, homeDir: fake.root, fetcher, hubSocketFactory: hub.socketFactory,
    isManagedHostOwned: () => true,
    resolveStoredDriveState: () => boundary ? { historyBoundary: boundary } : undefined,
    revokeStoredDriveEligibility: () => { epochRevoked = true; },
  });
  const afterRestartRows = await afterHubRestart.discoverSessions();
  check('a replacement Hub epoch invalidates durable Drive instead of promising impossible native rehydration',
    epochRevoked
      && afterRestartRows.find((row) => row.id === created.id)?.control?.drive.supported === false);

  const original = [
    { id: 'a', role: 'user', content: [{ type: 'text', text: 'same' }] },
    { id: 'b', role: 'assistant', content: [{ type: 'text', text: 'before' }] },
    { id: 'c', role: 'assistant', content: [{ type: 'text', text: 'same' }] },
  ] as ClineNativeMessage[];
  const rewritten = structuredClone(original);
  (rewritten[1]!.content[0] as Record<string, unknown>).text = 'after';
  check('history identity detects a same-length middle-row rewrite with unchanged ids',
    clineHubHistoryIdentity(profile, created.id, 'fixture-hub:epoch', original).revision
      !== clineHubHistoryIdentity(profile, created.id, 'fixture-hub:epoch', rewritten).revision);
} finally {
  await brokerSessionHub?.dispose();
  fake.cleanup();
}

console.log(`\n${passed} passed, 0 failed`);
