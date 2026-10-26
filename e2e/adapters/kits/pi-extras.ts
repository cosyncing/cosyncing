/**
 * Pi-family conformance extras: what Pi and omp do that the shared scenarios cannot say.
 *
 * Every extra drives the broker over HTTP and the session socket the way the app does, against the
 * kit's fake runtime, and asserts what a client receives, what the runtime receives (its ledger) and
 * what lands in the session file the product reads back. Pi and omp share the engine, so most extras
 * run for both dialects; the few that differ (fork and clone exist only on Pi, omp persists the
 * app's prompt correlation, omp rejects empty names) branch on the dialect, never on a tool name.
 */
import { expect } from 'bun:test';
import { BROKER_CONTRACT_REVISION } from '../../../packages/typescript/protocol/src/index.ts';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { eventually, type SessionStream } from '../../harness/index.ts';
import type { ConformanceContext, ConformanceExtra } from './kit.ts';
import { type PiFake, type PiFamilyDialect, promptText, piFileOf, piRowId, piUuidOf } from './pi-family.ts';
import { PI_COLLAB_PROMPT_PREFIX, piHeader, piModelEntry, piTitleEntry, appendLines, lastEntryId } from './fakes/pi-agent.ts';

const asFake = (context: ConformanceContext): PiFake => context.fake as PiFake;

const text = (message: any): string =>
  typeof message?.text === 'string' ? message.text : typeof message?.delta === 'string' ? message.delta : '';

/** Terminal run summaries after a frame index, by key. */
function terminals(stream: SessionStream, from: number): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const frame of stream.frames.slice(from)) {
    if (frame.kind !== 'message' || frame.message?.type !== 'run-summary') continue;
    out.set(frame.message.key, [...(out.get(frame.message.key) ?? []), frame.message.status]);
  }
  return out;
}

/** The native commands one fake process received, in order. */
function commandsOf(fake: PiFake, pid: number, from = 0): any[] {
  return fake.ledger.since(from).filter((entry) => entry.kind === 'recv' && entry.pid === pid).map((entry) => entry.frame);
}

async function post(context: ConformanceContext, path: string, body?: unknown) {
  return context.client.post(path, body ?? {});
}

/** A raw JSONL row's entries, parsed. */
function readEntries(file: string): any[] {
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

export function piFamilyExtras(dialect: PiFamilyDialect): ConformanceExtra[] {
  const omp = dialect.name === 'omp';
  const agent = dialect.name;
  const extras: ConformanceExtra[] = [];

  if (!omp) extras.push({
    title: 'an acknowledged prompt can be steered before native agent_start arrives',
    async run(context) {
      const fake = asFake(context);
      const session = await context.drivableSession('delayed-native-start');
      const owner = await context.openDrive(session);
      const other = await context.client.attach(agent, session.id, { mode: 'resume' });
      await other.waitForKind('history');
      try {
        expect((await owner.sendAndAwait({ kind: 'prompt', text: '[[hold-start:delayed-native-start]] first waiting prompt' })).kind).toBe('ack');
        const second = await other.sendAndAwait({ kind: 'prompt', text: 'second waiting prompt' });
        expect(second.kind, JSON.stringify(second)).toBe('ack');
        fake.release('delayed-native-start');
        await owner.waitForMessage((message) => message.type === 'model-output' && text(message) === 'answer: second waiting prompt');
      } finally {
        fake.release('delayed-native-start');
        owner.close();
        other.close();
      }
    },
  });

  extras.push({
    title: 'session naming keeps the first prompt through follow-ups, native renames, clears and large output',
    async run(context) {
      const fake = asFake(context);
      const empty = fake.seedSession({ title: '', turns: 0 });
      await context.client.waitForSession((row) => row.id === empty.id && !row.titlePending && row.title === '');
      fake.appendForeignUser(empty, 'First prompt after a cold empty scan');
      await context.client.waitForSession((row) => row.id === empty.id && !row.titlePending
        && row.title === 'First prompt after a cold empty scan');
      const largePrompt = 'First oversized prompt 😀 '.repeat(12);
      const imagePrompt = '分析图片 😀 / "quoted" \\ path';
      for (const variant of [
        { expected: imagePrompt, content: [
          { type: 'image', mimeType: 'image/png', data: 'A'.repeat(2 * 1024 * 1024) },
          { type: 'text', text: imagePrompt },
        ] },
        { expected: Array.from(largePrompt).slice(0, 160).join(''), content: [
          { type: 'text', text: largePrompt + 'x'.repeat(2 * 1024 * 1024) },
        ] },
      ]) {
        const large = fake.seedSession({ title: '', turns: 0 });
        fake.appendRaw(large, [{
          type: 'message', id: crypto.randomUUID(), parentId: lastEntryId(piFileOf(large.id)),
          timestamp: new Date().toISOString(), message: { role: 'user', content: variant.content },
        }]);
        fake.appendForeignUser(large, 'A later small prompt must not become the title');
        await context.client.waitForSession((row) => row.id === large.id && !row.titlePending && row.title === variant.expected);
      }
      const session = fake.seedSession({ title: '', turns: 0 });
      const path = 'coordination/relay/2026-10-24/r62_A.md';
      fake.appendForeignUser(session, path);
      const row = await context.client.waitForSession((row) => row.id === session.id && row.title === path);
      const stream = await context.client.attach(agent, session.id, { mode: 'observe' });
      await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info?.title === path);
      await stream.waitForFrame((frame) => frame.kind === 'history');
      fake.appendTurn(session, 'A later prompt', 'A later answer');
      await stream.waitForFrame((frame) => frame.kind === 'message' && text(frame.message).includes('A later answer'));
      const active = await context.client.waitForSession((candidate) => candidate.id === session.id && candidate.updatedAt! > row.updatedAt!);
      fake.appendRaw(session, [piTitleEntry(agent, lastEntryId(piFileOf(session.id)), '项目 / Native.md', Date.now())]);
      const named = await context.client.waitForSession((row) => row.id === session.id && row.title === '项目 / Native.md');
      expect(named.updatedAt).toBe(active.updatedAt);
      await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info?.title === '项目 / Native.md');
      // Push the name outside both old discovery windows without changing it.
      const appendOutput = (target: { id: string }): void => {
        let parentId = lastEntryId(piFileOf(target.id));
        const output = Array.from({ length: 65 }, () => {
          const id = crypto.randomUUID();
          const row = { type: 'custom', id, parentId, customType: 'naming-output', data: 'x'.repeat(320 * 1024) };
          parentId = id;
          return row;
        });
        fake.appendRaw(target, output);
      };
      appendOutput(session);
      const renamed = await context.client.waitForSession((row) => row.id === session.id && row.title === '项目 / Native.md');
      expect(renamed.cwd).toBe(row.cwd);
      expect(renamed.updatedAt).toBe(active.updatedAt);
      fake.appendTurn(session, 'Tail activity after 16 MiB', 'large naming sentinel');
      await stream.waitForFrame((frame) => frame.kind === 'message' && text(frame.message).includes('large naming sentinel'));
      const latest = await context.client.waitForSession((candidate) => candidate.id === session.id && candidate.updatedAt! > active.updatedAt!);
      fake.appendRaw(session, [piTitleEntry(agent, lastEntryId(piFileOf(session.id)), '', Date.now())]);
      const cleared = (await context.client.sessions({ refresh: true, window: 'all' })).find((candidate) => candidate.id === session.id)!;
      expect(cleared.title).toBe(cleared.titlePending ? '项目 / Native.md' : path);
      await context.client.waitForSession((candidate) => candidate.id === session.id && !candidate.titlePending && candidate.title === path);
      expect(cleared.updatedAt).toBe(latest.updatedAt);
      await stream.waitForFrame((frame) => frame.kind === 'session' && frame.info?.title === path);
      stream.close();
      await context.broker.restart();
      const cold = (await context.client.sessions({ refresh: true, window: 'all' })).find((candidate) => candidate.id === session.id)!;
      expect(cold.title).toBe(path);
      await context.client.waitForSession((candidate) => candidate.id === session.id && !candidate.titlePending && candidate.title === path);
      expect(cold.updatedAt).toBe(latest.updatedAt);
      const growing = fake.seedSession({ title: '', turns: 0 });
      fake.appendForeignUser(growing, path);
      appendOutput(growing);
      await context.broker.restart();
      const pending = (await context.client.sessions({ refresh: true, window: 'all' })).find((candidate) => candidate.id === growing.id)!;
      expect(pending.titlePending).toBe(true);
      expect(pending.updatedAt).toBeGreaterThan(0);
      const settled = await eventually(async () => {
        fake.appendRaw(growing, [{ type: 'custom', id: crypto.randomUUID(), parentId: lastEntryId(piFileOf(growing.id)), data: 'keeps growing' }]);
        const row = (await context.client.sessions({ refresh: true, window: 'all' })).find((candidate) => candidate.id === growing.id);
        return row && !row.titlePending ? row : undefined;
      }, { what: 'a growing unnamed transcript to finish its original backlog' });
      expect(settled.title).toBe(path);
      expect((await context.client.sessions({ window: '7d', refresh: true })).some((row) => row.id === growing.id)).toBe(true);
      if (!omp) {
        // Retain a known disk title even without an open connection or an app
        // rename fence. Raw pending rows must not replace the last-good cache.
        fake.appendRaw(growing, [piTitleEntry(agent, lastEntryId(piFileOf(growing.id)), 'Known terminal name', Date.now())]);
        await context.client.waitForSession((row) => row.id === growing.id && !row.titlePending && row.title === 'Known terminal name');
        appendOutput(growing);
        appendOutput(growing);
        fake.appendRaw(growing, [piTitleEntry(agent, lastEntryId(piFileOf(growing.id)), '', Date.now())]);
        const idlePending = (await context.client.sessions({ refresh: true, window: 'all' })).find((row) => row.id === growing.id)!;
        expect(idlePending.titlePending).toBe(true);
        expect(idlePending.title).toBe('Known terminal name');
        await context.client.waitForSession((row) => row.id === growing.id && !row.titlePending && row.title === path);
        // The HTTP mutation must retain the last accepted title while its
        // native clear is still behind an unscanned append range.
        const observer = await context.client.attach(agent, growing.id, { mode: 'observe' });
        await observer.waitForKind('history');
        const renamed = await context.client.request('PATCH', `/api/sessions/${agent}/${encodeURIComponent(growing.id)}/rename`, { title: 'Before pending clear' });
        expect(renamed.status, renamed.text).toBe(200);
        appendOutput(growing);
        appendOutput(growing);
        const result = await context.client.request('PATCH', `/api/sessions/${agent}/${encodeURIComponent(growing.id)}/rename`, { title: null });
        expect(result.status, result.text).toBe(200);
        expect(result.body.session.titlePending).toBe(true);
        expect(result.body.session.title).toBe('Before pending clear');
        await context.client.waitForSession((row) => row.id === growing.id && !row.titlePending && row.title === path);
        observer.close();
      } else {
        // A migrated Pi name in the suffix cannot settle an OMP title hidden
        // in the middle of the still-unread original range.
        fake.appendRaw(growing, [piTitleEntry(agent, lastEntryId(piFileOf(growing.id)), 'Native OMP middle', Date.now())]);
        appendOutput(growing);
        fake.appendRaw(growing, [{ type: 'session_info', id: crypto.randomUUID(), parentId: lastEntryId(piFileOf(growing.id)), name: 'Legacy Pi suffix' }]);
        await context.broker.restart();
        const first = (await context.client.sessions({ refresh: true, window: 'all' })).find((row) => row.id === growing.id)!;
        expect(first.titlePending).toBe(true);
        expect(first.title).not.toBe('Legacy Pi suffix');
        await context.client.waitForSession((row) => row.id === growing.id && !row.titlePending && row.title === 'Native OMP middle');
      }
    },
  });

  // ----------------------------------------------------------------- create
  extras.push({
    title: 'create applies the model, thinking level and name, in that order, before it reads the state back',
    async run(context) {
      const fake = asFake(context);
      const id = fake.prepareCreate();
      const cwd = fake.workspace('create-order');
      const mark = fake.ledger.mark();
      const created = await post(context, `/api/sessions/${agent}`, {
        directory: cwd,
        title: 'Named at create',
        model: { providerID: 'fake', modelID: 'pi-reason', reasoningEffort: 'high' },
      });
      expect(created.status, created.text).toBe(200);
      expect(created.body.session.id).toBe(id);
      expect(created.body.session.currentModel).toEqual({ providerID: 'fake', modelID: 'pi-reason', reasoningEffort: 'high' });
      const start = fake.ledger.spawns(mark).find((entry) => entry.cwd === cwd)!;
      expect(start.argv).toContain('--mode');
      expect(start.session).toBeNull();
      // The runtime is told the exact model and level before anything reads the state the broker publishes.
      const commands = commandsOf(fake, start.pid, mark);
      expect(commands.map((command) => command.type)).toEqual([
        'get_state', 'set_model', 'set_thinking_level', 'get_state', 'set_session_name', 'get_state',
      ]);
      expect(commands[1]).toMatchObject({ provider: 'fake', modelId: 'pi-reason' });
      expect(commands[2]).toMatchObject({ level: 'high' });
      expect(commands[4]).toMatchObject({ name: 'Named at create' });
      // What the runtime would not have written for a session with no turn yet is on disk for the next process.
      const entries = readEntries(piFileOf(id));
      expect(entries.some((entry) => entry.type === 'session' && entry.cwd === cwd)).toBe(true);
      expect(JSON.stringify(entries)).toContain('Named at create');
      const row = await context.client.waitForSession((candidate) => candidate.id === id && candidate.title === 'Named at create');
      expect(row.currentModel).toMatchObject({ providerID: 'fake', modelID: 'pi-reason' });
    },
  });

  extras.push({
    title: 'a create the runtime answers with a session already in the store is refused, and nothing is written into that session',
    async run(context) {
      const fake = asFake(context);
      const existing = fake.seedSession({ title: 'Already stored' });
      await context.client.waitForSession((candidate) => candidate.id === existing.id);
      const file = piFileOf(existing.id);
      const before = readFileSync(file);
      fake.prepareCreate(existing.id);
      const mark = fake.ledger.mark();
      const refused = await post(context, `/api/sessions/${agent}`, {
        directory: existing.cwd,
        title: 'Claimed by create',
        model: { providerID: 'fake', modelID: 'pi-reason', reasoningEffort: 'high' },
      });
      expect(refused.ok, refused.text).toBe(false);
      // Refused at the first state read: no model or name reached the runtime, and no byte reached the file.
      const start = fake.ledger.spawns(mark).find((entry) => entry.cwd === existing.cwd && entry.session === null)!;
      expect(commandsOf(fake, start.pid, mark).map((command) => command.type)).toEqual(['get_state']);
      expect(readFileSync(file).equals(before)).toBe(true);
      const row = await context.client.waitForSession((candidate) => candidate.id === existing.id);
      expect(row.title).toBe('Already stored');
      expect(row.control?.drive?.state).toBe('observing');
    },
  });

  // ------------------------------------------------------------- fork and clone
  if (omp) {
    extras.push({
      title: 'omp offers neither fork nor clone: both are refused before any runtime starts',
      async run(context) {
        const fake = asFake(context);
        const stored = fake.seedSession({ title: 'no fork on omp' });
        await context.client.waitForSession((row) => row.id === stored.id);
        const mark = fake.ledger.mark();
        const fork = await post(context, `/api/sessions/${agent}/${stored.id}/fork`, { messageId: 'any' });
        const clone = await post(context, `/api/sessions/${agent}/${stored.id}/clone`);
        expect([fork.status, clone.status]).toEqual([501, 501]);
        expect(fake.ledger.spawns(mark)).toEqual([]);
        const agents = (await context.client.get(`/api/agents?contractRevision=${BROKER_CONTRACT_REVISION}`)).body;
        const row = (Array.isArray(agents) ? agents : agents.agents).find((candidate: any) => candidate.id === agent);
        expect([row.canFork, row.canClone]).toEqual([false, false]);
      },
    });
  } else {
    extras.push({
      title: 'fork and clone start a new session from a stored one, and a bare fork is the runtime\'s clone',
      async run(context) {
        const fake = asFake(context);
        const source = fake.seedSession({ title: 'fork source', turns: 2 });
        await context.client.waitForSession((row) => row.id === source.id);
        const sourceFile = piFileOf(source.id);
        const before = readFileSync(sourceFile, 'utf8');
        const userEntries = readEntries(sourceFile).filter((entry) => entry.type === 'message' && entry.message?.role === 'user');
        const mark = fake.ledger.mark();

        // Fork at the second prompt: the copy holds the conversation before it.
        const forked = await post(context, `/api/sessions/${agent}/${source.id}/fork`, { messageId: userEntries[1].id });
        expect(forked.status, forked.text).toBe(200);
        const forkRow = forked.body.session;
        expect(forkRow.id).not.toBe(source.id);
        expect(forkRow.control?.drive?.supported).toBe(true);
        const forkCommand = fake.ledger.commands('fork', mark)[0]!;
        expect(forkCommand.frame).toMatchObject({ type: 'fork', entryId: userEntries[1].id });
        // The runtime that forked was the one holding the source session.
        expect(fake.ledger.spawns(mark).some((entry) => entry.pid === forkCommand.pid && entry.session === sourceFile)).toBe(true);
        const forkHistory = await context.client.attach(agent, forkRow.id);
        const forkMessages = (await forkHistory.waitForKind('history')).messages as any[];
        expect(forkMessages.filter((message) => message.type === 'user-message').map(text)).toEqual([source.texts[0]!]);
        forkHistory.close();

        // A bare fork has no fork RPC of its own: it is the runtime's clone, at the current leaf.
        const bareMark = fake.ledger.mark();
        const bare = await post(context, `/api/sessions/${agent}/${source.id}/fork`);
        expect(bare.status, bare.text).toBe(200);
        expect(fake.ledger.commands('fork', bareMark)).toEqual([]);
        expect(fake.ledger.commands('clone', bareMark).length).toBe(1);

        const clone = await post(context, `/api/sessions/${agent}/${source.id}/clone`);
        expect(clone.status, clone.text).toBe(200);
        const cloneHistory = await context.client.attach(agent, clone.body.session.id);
        const cloneMessages = (await cloneHistory.waitForKind('history')).messages as any[];
        expect(cloneMessages.filter((message) => message.type === 'user-message').map(text)).toEqual([source.texts[0]!, source.texts[2]!]);
        cloneHistory.close();
        // Every copy is its own session in the roster; the source is untouched.
        const ids = [forkRow.id, bare.body.session.id, clone.body.session.id];
        expect(new Set([source.id, ...ids]).size).toBe(4);
        for (const copy of ids) await context.client.waitForSession((row) => row.id === copy);
        expect(readFileSync(sourceFile, 'utf8')).toBe(before);
      },
    });

    extras.push({
      title: 'a fork a runtime extension cancels is refused without a copy, and a failed one leaks no native text',
      async run(context) {
        const fake = asFake(context);
        const source = fake.seedSession({ title: 'fork cancelled', turns: 2 });
        await context.client.waitForSession((row) => row.id === source.id);
        const userEntries = readEntries(piFileOf(source.id)).filter((entry) => entry.type === 'message' && entry.message?.role === 'user');
        const rowsBefore = (await context.client.sessions({ refresh: true })).filter((row) => row.tool === agent).length;
        fake.patchConfig({ cancelFork: true });
        try {
          const cancelled = await post(context, `/api/sessions/${agent}/${source.id}/fork`, { messageId: userEntries[1].id });
          expect(cancelled.status, cancelled.text).toBe(502);
          expect(cancelled.body.error).toBe('native session fork failed');
          const clone = await post(context, `/api/sessions/${agent}/${source.id}/clone`);
          expect(clone.status).toBe(502);
        } finally {
          fake.patchConfig({ cancelFork: false });
        }
        // A fork point that is not an entry of the session is refused by the runtime, in words with no path or id in them.
        const bad = await post(context, `/api/sessions/${agent}/${source.id}/fork`, { messageId: 'not-an-entry' });
        expect(bad.status).toBe(502);
        expect(bad.text).not.toContain(piFileOf(source.id));
        const rowsAfter = (await context.client.sessions({ refresh: true })).filter((row) => row.tool === agent).length;
        expect(rowsAfter).toBe(rowsBefore);
      },
    });

    extras.push({
      title: 'a subagent session cannot be forked: it belongs to its parent run',
      async run(context) {
        const fake = asFake(context);
        const parent = fake.seedSession({ title: 'fork parent' });
        const child = fake.seedSession({ title: 'fork child', childOf: parent });
        await context.client.waitForSession((row) => row.id === child.id);
        const mark = fake.ledger.mark();
        const refused = await post(context, `/api/sessions/${agent}/${child.id}/fork`);
        expect(refused.status).toBe(409);
        expect(refused.body.code).toBe('SESSION_AGENT_OWNED');
        expect(fake.ledger.spawns(mark)).toEqual([]);
      },
    });
  }

  // ------------------------------------------------------------------ rename
  extras.push({
    title: omp
      ? 'rename trims, persists a title_change, fails without native text, and cannot clear an omp title'
      : 'rename trims, persists a session_info, fails without native text, and can clear a Pi title',
    async run(context) {
      const fake = asFake(context);
      const stored = fake.seedSession({ title: 'before rename' });
      await context.client.waitForSession((row) => row.id === stored.id);
      const mark = fake.ledger.mark();
      const nativeTitle = 'n'.repeat(159) + '🧪';
      const renamed = await context.client.request('PATCH', `/api/sessions/${agent}/${stored.id}/rename`, { title: `  ${nativeTitle}  ` });
      expect(renamed.status, renamed.text).toBe(200);
      expect(renamed.body.title).toBe(nativeTitle);
      expect(fake.ledger.commands('set_session_name', mark)[0]!.frame).toMatchObject({ name: nativeTitle });
      // The name is a durable entry in the dialect's own shape.
      const entry = readEntries(piFileOf(stored.id)).filter((row) => row.type === (omp ? 'title_change' : 'session_info')).at(-1);
      expect(omp ? entry?.title : entry?.name).toBe(nativeTitle);
      expect(readFileSync(piFileOf(stored.id), 'utf8')).not.toContain(omp ? '"session_info"' : '"title_change"');
      await context.client.waitForSession((row) => row.id === stored.id && row.title === nativeTitle);

      // A native failure reaches the client as a bare failure: no runtime text, path or credential.
      const failed = await context.client.request('PATCH', `/api/sessions/${agent}/${stored.id}/rename`, { title: 'fail-secret' });
      expect(failed.status).toBe(502);
      for (const leak of ['FAKE_RUNTIME_SECRET', 'sk-fixture-secret', '/root/.pi']) expect(failed.text).not.toContain(leak);

      // Clearing: Pi drops the name, omp's runtime rejects an empty one and the title stays.
      const cleared = await context.client.request('PATCH', `/api/sessions/${agent}/${stored.id}/rename`, { title: null });
      if (omp) {
        expect(cleared.status).toBe(502);
        expect((await context.client.waitForSession((row) => row.id === stored.id)).title).toBe(nativeTitle);
      } else {
        expect(cleared.status, cleared.text).toBe(200);
        await context.client.waitForSession((row) => row.id === stored.id && row.title !== nativeTitle);
      }
    },
  });

  // ------------------------------------------------------------- runs and retries
  extras.push({
    title: 'a retried turn keeps one running summary key and closes once; a retry that gives up ends in one error',
    async run(context) {
      const session = await context.drivableSession('retry');
      const stream = await context.openDrive(session);
      const from = stream.frames.length;
      expect((await context.prompt(stream, '[[retry]] flaky provider')).kind).toBe('ack');
      await stream.waitForMessage((message) => message.type === 'model-output' && text(message) === 'answer: flaky provider');
      const banner = await stream.waitForFrame((frame) => frame.kind === 'message' && frame.message.type === 'status'
        && String(frame.message.detail ?? '').startsWith('Retrying 1/3'), { after: from });
      expect(String(banner.message.detail)).toContain('429 rate limited');
      await eventually(() => [...terminals(stream, from)].some(([, statuses]) => statuses.includes('done')), { what: 'the retried turn to close' });
      const retried = [...terminals(stream, from)];
      expect(retried.length).toBe(1);
      expect(retried[0]![1].filter((status) => status !== 'running')).toEqual(['done']);

      const mark = stream.frames.length;
      expect((await context.prompt(stream, '[[retryfail]] hopeless provider')).kind).toBe('ack');
      await stream.waitForMessage((message) => message.type === 'error' && String(message.message).startsWith('API retry gave up'));
      await eventually(() => [...terminals(stream, mark)].some(([, statuses]) => statuses.includes('error')), { what: 'the failed turn to close' });
      const failed = [...terminals(stream, mark)];
      expect(failed.length).toBe(1);
      expect(failed[0]![1].filter((status) => status !== 'running')).toEqual(['error']);
      // The banner message is one line: the runtime's multi-line detail does not leak a second line.
      const gaveUp = stream.messages().find((message) => message.type === 'error' && String(message.message).startsWith('API retry gave up'));
      expect(String(gaveUp.message)).not.toContain('retry-after');
      // The session is usable straight away.
      expect((await context.prompt(stream, 'after the failure')).kind).toBe('ack');
      await stream.waitForMessage((message) => message.type === 'model-output' && text(message) === 'answer: after the failure');
      stream.close();
    },
  });

  extras.push({
    title: 'compaction is asked of the runtime and every client re-reads the rewritten history',
    async run(context) {
      const fake = asFake(context);
      const session = await context.drivableSession('compact');
      const owner = await context.openDrive(session);
      const tab = await context.client.attach(agent, session.id, { mode: 'resume', reason: 'takeover' });
      await tab.waitForKind('session');
      expect((await context.prompt(owner, 'before compaction')).kind).toBe('ack');
      await owner.waitForMessage((message) => message.type === 'run-summary' && message.status === 'done');
      const mark = fake.ledger.mark();
      const fromOwner = owner.frames.length;
      const fromTab = tab.frames.length;
      const reply = await owner.sendAndAwait({ kind: 'command', name: 'compact', args: 'keep the plan' });
      expect(reply.kind).toBe('ack');
      await eventually(() => fake.ledger.commands('compact', mark).length === 1, { what: 'the runtime to receive compact' });
      expect(fake.ledger.commands('compact', mark)[0]!.frame).toMatchObject({ type: 'compact', customInstructions: 'keep the plan' });
      // The compaction rewrote the file, so every client reloads its history rather than patching it.
      for (const [stream, after] of [[owner, fromOwner], [tab, fromTab]] as const) {
        await stream.waitForFrame((frame) => frame.kind === 'history', { after, what: 'a history reload after compaction' });
        await stream.waitForFrame((frame) => frame.kind === 'message' && frame.message.type === 'status' && frame.message.status === 'idle', { after });
      }
      expect((await context.prompt(owner, 'after compaction')).kind).toBe('ack');
      await tab.waitForMessage((message) => message.type === 'model-output' && text(message) === 'answer: after compaction');
      owner.close();
      tab.close();
    },
  });

  // ------------------------------------------------------- extension dialogs
  extras.push({
    title: 'an extension select is a question card answered with the user\'s own choice, a text dialog takes free text, and a dismissal cancels',
    async run(context) {
      const fake = asFake(context);
      const session = await context.drivableSession('dialogs');
      const owner = await context.openDrive(session);
      const mark = fake.ledger.mark();

      const select = context.prompt(owner, '[[question]] pick a path');
      const card = await owner.waitForMessage((message) => message.type === 'question-request' && String(message.requestId).startsWith('question-'));
      expect(card.questions[0].options.map((option: any) => option.label)).toEqual(['Left', 'Right']);
      expect(owner.messages().some((message) => message.type === 'permission-request')).toBe(false);
      // A late tab holds the open card exactly once.
      const late = await context.client.attach(agent, session.id, { mode: 'resume', reason: 'takeover' });
      await late.waitForMessage((message) => message.type === 'question-request' && message.requestId === card.requestId);
      expect((await late.sendAndAwait({ kind: 'answer', requestId: card.requestId, answers: [['Right']] })).kind).toBe('ack');
      await owner.waitForMessage((message) => message.type === 'question-resolved' && message.requestId === card.requestId);
      expect((await select).kind).toBe('ack');
      await owner.waitForMessage((message) => message.type === 'model-output' && text(message).includes('answered Right'));
      expect(fake.ledger.commands('extension_ui_response', mark).map((entry) => entry.frame)).toEqual([
        { type: 'extension_ui_response', id: card.requestId, value: 'Right' },
      ]);

      // A free-text dialog arrives as a question with no options; the typed text is the value.
      const typedMark = fake.ledger.mark();
      const typed = context.prompt(owner, '[[input]] name it');
      const input = await owner.waitForMessage((message) => message.type === 'question-request' && String(message.requestId).endsWith('-input'));
      expect(input.questions[0].options).toEqual([]);
      expect((await owner.sendAndAwait({ kind: 'answer', requestId: input.requestId, answers: [['Moby']] })).kind).toBe('ack');
      expect((await typed).kind).toBe('ack');
      await owner.waitForMessage((message) => message.type === 'model-output' && text(message).includes('typed Moby'));
      expect(fake.ledger.commands('extension_ui_response', typedMark)[0]!.frame).toMatchObject({ id: input.requestId, value: 'Moby' });

      // Dismissing a question cancels the dialog; denying a confirm cancels it too and the runtime says so.
      const rejectedMark = fake.ledger.mark();
      const rejected = context.prompt(owner, '[[question]] pick again');
      const second = await owner.waitForMessage((message) => message.type === 'question-request' && message.requestId !== card.requestId && message.requestId !== input.requestId);
      expect((await owner.sendAndAwait({ kind: 'reject-question', requestId: second.requestId })).kind).toBe('ack');
      expect((await rejected).kind).toBe('ack');
      await owner.waitForMessage((message) => message.type === 'model-output' && text(message).includes('question unanswered'));
      expect(fake.ledger.commands('extension_ui_response', rejectedMark)[0]!.frame).toMatchObject({ id: second.requestId, cancelled: true });

      const deniedMark = fake.ledger.mark();
      const denied = context.prompt(owner, '[[permission]] risky');
      const confirm = await owner.waitForMessage((message) => message.type === 'permission-request' && message.requestId.startsWith('permission-')
        && !owner.messages().some((other) => other.type === 'permission-resolved' && other.requestId === message.requestId));
      expect((await owner.sendAndAwait({ kind: 'approve', requestId: confirm.requestId, decision: 'reject' })).kind).toBe('ack');
      expect((await denied).kind).toBe('ack');
      await owner.waitForMessage((message) => message.type === 'model-output' && text(message).includes('permission deny'));
      expect(fake.ledger.commands('extension_ui_response', deniedMark)[0]!.frame).toMatchObject({ id: confirm.requestId, cancelled: true });
      owner.close();
      late.close();
    },
  });

  extras.push({
    title: 'a notification raises no card, and a blocking dialog the product does not know is cancelled rather than left hanging',
    async run(context) {
      const fake = asFake(context);
      const session = await context.drivableSession('quiet dialogs');
      const stream = await context.openDrive(session);
      const mark = fake.ledger.mark();
      const heldBefore = stream.messages().length;
      expect((await context.prompt(stream, '[[notify]] [[unknowndialog]] quiet')).kind).toBe('ack');
      await stream.waitForMessage((message) => message.type === 'model-output' && text(message) === 'answer: quiet');
      const live = stream.messages().slice(heldBefore);
      expect(live.some((message) => message.type === 'permission-request' || message.type === 'question-request')).toBe(false);
      // The unknown dialog was answered with a cancel at once: the turn did not wait on a user.
      const cancelled = fake.ledger.commands('extension_ui_response', mark).map((entry) => entry.frame);
      expect(cancelled.length).toBe(1);
      expect(cancelled[0]).toMatchObject({ cancelled: true });
      expect(String(cancelled[0]!.id).startsWith('dialog-')).toBe(true);
      const skipped = stream.messages().find((message) => message.type === 'event' && message.name === 'dialog-skipped');
      expect(skipped?.payload?.method).toBe('custom-widget');
      stream.close();
    },
  });

  // -------------------------------------------------------- tools and keys
  extras.push({
    title: 'a tool call and its result reach the client, and every row streamed live carries the key its session-file copy has',
    async run(context) {
      const session = await context.drivableSession('keys');
      const owner = await context.openDrive(session);
      const from = owner.frames.length;
      expect((await context.prompt(owner, '[[tool]] list files', { clientMessageId: 'keys-client' })).kind).toBe('ack');
      await owner.waitForMessage((message) => message.type === 'model-output' && text(message) === 'answer: list files');
      await eventually(() => [...terminals(owner, from)].some(([, statuses]) => statuses.includes('done')), { what: 'the turn to close' });
      const live = owner.frames.slice(from).filter((frame) => frame.kind === 'message').map((frame) => frame.message);
      const call = live.find((message) => message.type === 'tool-call');
      const result = live.find((message) => message.type === 'tool-result');
      expect(call).toMatchObject({ toolName: 'bash', args: { command: 'echo fixture' } });
      expect(result).toMatchObject({ callId: call.callId, toolName: 'bash', isError: false, exitCode: 0, result: 'fixture\n' });

      // A fresh reader of the file holds the same rows under the same keys.
      const fresh = await context.client.attach(agent, session.id);
      const history = (await fresh.waitForKind('history')).messages as any[];
      for (const row of live.filter((message) => message.type === 'model-output' || message.type === 'thinking')) {
        expect(history.some((entry) => entry.type === row.type && entry.key === row.key && text(entry).includes('answer: list files')), `${row.type} ${row.key}`).toBe(true);
      }
      expect(history.some((entry) => entry.type === 'tool-call' && entry.callId === call.callId)).toBe(true);
      expect(history.some((entry) => entry.type === 'tool-result' && entry.callId === result.callId && entry.exitCode === 0)).toBe(true);
      const own = history.filter((entry) => entry.type === 'user-message' && text(entry) === '[[tool]] list files');
      expect(own.length).toBe(1);
      const sent = live.find((message) => message.type === 'user-message' && message.clientKey === 'keys-client');
      // The fresh reader keys the sender's row as the sender held it. omp persists the key and clientKey on
      // the entry itself; upstream Pi's entry carries neither, and the Drive prompt's echo correlation does.
      expect(own[0].key).toBe(sent.key);
      expect(own[0].clientKey).toBe('keys-client');
      // Every turn closed under one key, matching the summary a reload computes for it.
      const summaries = history.filter((entry) => entry.type === 'run-summary' && entry.userMessageKey === own[0].key);
      expect(summaries.length).toBe(1);
      expect(summaries[0].status).toBe('done');
      fresh.close();
      owner.close();
    },
  });

  extras.push({
    title: 'an Observe tab on a driven session shows each Drive prompt under the sender\'s key, live and after a reload, repeated text included',
    async run(context) {
      const session = await context.drivableSession('watched');
      const owner = await context.openDrive(session);
      const watcher = await context.client.attach(agent, session.id);
      await watcher.waitForKind('history');
      const texts = ['watched prompt', 'same text', 'same text'];
      const sent: any[] = [];
      for (const [index, prompt] of texts.entries()) {
        const clientMessageId = `watched-${index}`;
        expect((await context.prompt(owner, prompt, { clientMessageId })).kind).toBe('ack');
        sent.push(await owner.waitForMessage((message) => message.type === 'user-message' && message.clientKey === clientMessageId));
        // The watcher's tail reads the entry the runtime wrote, one window per prompt.
        await watcher.waitForMessage((message) => message.type === 'user-message' && message.key === sent[index].key);
      }
      const keys = sent.map((message) => message.key);
      expect(new Set(keys).size).toBe(3);
      const watched = watcher.messages().filter((message) => message.type === 'user-message' && texts.includes(text(message)));
      expect(watched.map((message) => [message.key, text(message)])).toEqual(keys.map((key, index) => [key, texts[index]]));
      // A tab that opens after those prompts goes on from them: the next same-text prompt takes its own key.
      const late = await context.client.attach(agent, session.id);
      await late.waitForKind('history');
      expect((await context.prompt(owner, 'same text', { clientMessageId: 'watched-late' })).kind).toBe('ack');
      const lastSent = await owner.waitForMessage((message) => message.type === 'user-message' && message.clientKey === 'watched-late');
      keys.push(lastSent.key);
      await late.waitForMessage((message) => message.type === 'user-message' && message.key === lastSent.key);
      expect(late.messages().filter((message) => message.type === 'user-message' && text(message) === 'same text')
        .map((message) => message.key)).toEqual(keys.slice(1));
      const reload = await context.client.attach(agent, session.id);
      const history = (await reload.waitForKind('history')).messages as any[];
      expect(history.filter((message) => message.type === 'user-message' && [...texts, 'same text'].includes(text(message)))
        .map((message) => message.key)).toEqual(keys);
      reload.close();
      late.close();
      watcher.close();
      owner.close();
    },
  });

  extras.push({
    title: 'the runtime\'s native context usage and session stats ride every finished turn, in the shape Pi documents',
    async run(context) {
      const session = await context.drivableSession('stats');
      const owner = await context.openDrive(session);
      expect((await context.prompt(owner, 'measure me')).kind).toBe('ack');
      const usage = await owner.waitForMessage((message) => message.type === 'metadata-update' && message.key === 'contextUsage');
      expect(usage.value).toMatchObject({ max: 200_000 });
      expect(usage.value.used).toBeGreaterThan(1000);
      const stats = await owner.waitForMessage((message) => message.type === 'metadata-update' && message.key === 'sessionStats');
      // Cost sits at the root and the window inside contextUsage: not the other way round.
      expect(stats.value.cost).toBe(0.0042);
      expect(stats.value.tokens).toMatchObject({ input: expect.any(Number), total: expect.any(Number) });
      expect(stats.value.contextUsage).toMatchObject({ tokens: usage.value.used, contextWindow: 200_000 });
      // A client that joins afterwards is told the same without waiting for another turn.
      const late = await context.client.attach(agent, session.id, { mode: 'resume', reason: 'takeover' });
      const replayed = await late.waitForMessage((message) => message.type === 'metadata-update' && message.key === 'contextUsage');
      expect(replayed.value.max).toBe(200_000);
      late.close();
      owner.close();
    },
  });

  // -------------------------------------------------------- prompts and files
  extras.push({
    title: 'a prompt on another model and thinking level switches the runtime first; a switch it refuses delivers nothing',
    async run(context) {
      const fake = asFake(context);
      const session = await context.drivableSession('switch');
      const stream = await context.openDrive(session);
      const mark = fake.ledger.mark();
      expect((await context.prompt(stream, 'think hard', { model: { providerID: 'fake', modelID: 'pi-reason', reasoningEffort: 'high' } })).kind).toBe('ack');
      // (The broker may check the model against the runtime's catalog first.)
      const types = fake.ledger.since(mark).filter((entry) => entry.kind === 'recv').map((entry) => entry.frame!.type)
        .filter((type) => type !== 'get_available_models');
      expect(types.slice(0, 4)).toEqual(['get_state', 'set_model', 'set_thinking_level', 'prompt']);
      expect(fake.ledger.commands('set_model', mark)[0]!.frame).toMatchObject({ provider: 'fake', modelId: 'pi-reason' });
      expect(fake.ledger.commands('set_thinking_level', mark)[0]!.frame).toMatchObject({ level: 'high' });
      await stream.waitForMessage((message) => message.type === 'model-output' && text(message) === 'answer: think hard');

      // A model the runtime does not have: the prompt is refused, nothing reaches the runtime, no row is left queued.
      const refusedMark = fake.ledger.mark();
      const refused = await context.prompt(stream, 'on a missing model', { model: { providerID: 'fake', modelID: 'does-not-exist' } });
      expect(refused.kind).toBe('nack');
      expect(fake.ledger.requests('session/prompt', refusedMark)).toEqual([]);
      expect((await context.prompt(stream, 'still works')).kind).toBe('ack');
      await stream.waitForMessage((message) => message.type === 'model-output' && text(message) === 'answer: still works');
      // The refused prompt's optimistic row was withdrawn, and the next turn is linked to its own prompt.
      const stuck = stream.messages().filter((message) => message.type === 'user-message' && text(message) === 'on a missing model' && message.queued !== true);
      expect(stuck).toEqual([]);
      stream.close();
    },
  });

  extras.push({
    title: 'a prompt that arrives while a run is open is sent as a steer, once, and answered in order',
    async run(context) {
      const fake = asFake(context);
      const session = await context.drivableSession('steer');
      const stream = await context.openDrive(session);
      const tab = await context.client.attach(agent, session.id, { mode: 'resume', reason: 'takeover' });
      await tab.waitForKind('session');
      const mark = fake.ledger.mark();
      const first = context.prompt(stream, '[[hold:steer-1]] first');
      await eventually(() => fake.ledger.commands('prompt', mark).length === 1, { what: 'the first prompt to reach the runtime' });
      const second = context.prompt(tab, 'steered second');
      await eventually(() => fake.ledger.commands('prompt', mark).length === 2, { what: 'the steer to reach the runtime' });
      const [one, two] = fake.ledger.commands('prompt', mark).map((entry) => entry.frame!);
      expect(one!.streamingBehavior).toBeUndefined();
      expect(two!.streamingBehavior).toBe('steer');
      // The steer is a row both clients hold while it waits.
      await stream.waitForMessage((message) => message.type === 'user-message' && text(message) === 'steered second');
      fake.release('steer-1');
      expect((await first).kind).toBe('ack');
      expect((await second).kind).toBe('ack');
      await stream.waitForMessage((message) => message.type === 'model-output' && text(message) === 'answer: steered second');
      // Two prompts, two turns, each closed once under its own key.
      await eventually(() => [...terminals(stream, 0)].filter(([, statuses]) => statuses.includes('done')).length >= 2, { what: 'both turns to close' });
      stream.close();
      tab.close();
    },
  });

  extras.push({
    title: 'a file sent in Drive lands in the workspace inbox and the runtime is told its path in the turn',
    async run(context) {
      const fake = asFake(context);
      const session = await context.drivableSession('send file');
      const stream = await context.openDrive(session);
      const mark = fake.ledger.mark();
      const reply = await stream.sendAndAwait({
        kind: 'file', name: 'notes.txt', mimeType: 'text/plain', data: Buffer.from('file-contents-ok').toString('base64'),
      });
      expect(reply.kind, JSON.stringify(reply)).toBe('ack');
      const stored = join(session.cwd, '.cosyncing', 'inbox', 'notes.txt');
      expect(existsSync(stored)).toBe(true);
      expect(readFileSync(stored, 'utf8')).toBe('file-contents-ok');
      await eventually(() => fake.ledger.promptTexts(mark).length === 1, { what: 'the runtime to receive the file turn' });
      const delivered = fake.ledger.promptTexts(mark)[0]!;
      expect(delivered).toContain('Attached file(s)');
      expect(delivered).toContain(stored);
      expect(delivered).toContain('notes.txt (text/plain)');
      stream.close();
    },
  });

  // ---------------------------------------------------- terminal handoff
  extras.push({
    title: 'the terminal handoff command names the exact session file and the executable that was verified',
    async run(context) {
      const fake = asFake(context);
      const stored = fake.seedSession({ title: 'handoff' });
      const row = await context.client.waitForSession((candidate) => candidate.id === stored.id);
      const command = row.control.terminalSync.command as string;
      // The broker's own address rides along, because a terminal started by hand cannot guess it.
      expect(command).toBe(`COSYNCING_BROKER='${context.broker.url}' '${fake.executable}' --session '${piFileOf(stored.id)}'`);
      expect(row.control.terminalSync.syncAvailable).toBe(true);
      expect(row.control.terminalSync.active).toBe(false);
      void piUuidOf;
    },
  });

  // ------------------------------------------------ correlation on the wire
  extras.push({
    title: omp
      ? 'omp is sent a correlated prompt: the app\'s key, client key and clock travel inside the native command'
      : 'Pi is sent the prompt as plain text; the app\'s keys never enter the native command',
    async run(context) {
      const fake = asFake(context);
      const session = await context.drivableSession('correlation');
      const stream = await context.openDrive(session);
      const mark = fake.ledger.mark();
      expect((await context.prompt(stream, 'carry my key', { clientMessageId: 'wire-client' })).kind).toBe('ack');
      const command = fake.ledger.commands('prompt', mark)[0]!.frame!;
      if (omp) {
        expect(String(command.message).startsWith(PI_COLLAB_PROMPT_PREFIX)).toBe(true);
        const payload = JSON.parse(Buffer.from(String(command.message).slice(PI_COLLAB_PROMPT_PREFIX.length), 'base64url').toString('utf8'));
        expect(payload).toMatchObject({ text: 'carry my key', clientKey: 'wire-client' });
        expect(String(payload.messageKey).startsWith('u:remote:')).toBe(true);
        expect(typeof payload.sentAt).toBe('number');
        // The broker accepted the prompt only once the runtime's own message carried that correlation back.
        const echoed = await stream.waitForMessage((message) => message.type === 'user-message' && message.key === payload.messageKey && message.queued === false);
        expect(echoed.clientKey).toBe('wire-client');
      } else {
        expect(command.message).toBe('carry my key');
        expect(promptText(String(command.message))).toBe('carry my key');
      }
      stream.close();
    },
  });

  // --------------------------------------------------------- roster details
  extras.push({
    title: omp
      ? 'omp titles follow the leading slot and later title_change entries, last write wins, and model ids split at the first slash'
      : 'Pi titles follow session_info entries, last write wins, and the model comes from the entry\'s own fields',
    async run(context) {
      const fake = asFake(context);
      const cwd = fake.workspace('title-rules');
      const uuid = crypto.randomUUID();
      const at = Date.now() - 60_000;
      const file = join(fake.sessionsRoot, `--title-rules-${uuid.slice(0, 6)}--`, `${new Date(at).toISOString().replace(/[:.]/g, '-')}_${uuid}.jsonl`);
      const model = omp ? { provider: 'openrouter', id: 'anthropic/claude-x' } : { provider: 'fake', id: 'pi-reason' };
      // The first title a file carries: omp's leading slot, Pi's first session_info.
      appendLines(file, omp ? piHeader('omp', uuid, cwd, at, 'Leading slot title') : [...piHeader('pi', uuid, cwd, at), piTitleEntry('pi', null, 'First title', at)]);
      appendLines(file, [piModelEntry(dialect.name, null, model, at)]);
      const id = piRowId(file);
      const first = await context.client.waitForSession((row) => row.id === id);
      expect(first.title).toBe(omp ? 'Leading slot title' : 'First title');
      expect(first.currentModel).toMatchObject({ providerID: model.provider, modelID: model.id });
      appendLines(file, [piTitleEntry(dialect.name, null, 'Second title', Date.now())]);
      await context.client.waitForSession((row) => row.id === id && row.title === 'Second title');
      appendLines(file, [piTitleEntry(dialect.name, null, 'Third title', Date.now() + 1)]);
      const last = await context.client.waitForSession((row) => row.id === id && row.title === 'Third title');
      expect(last.title).toBe('Third title');
    },
  });

  extras.push({
    title: 'a subagent of a subagent is published once, under its direct parent, observe-only',
    async run(context) {
      const fake = asFake(context);
      const root = fake.seedSession({ title: 'tree root' });
      const child = fake.seedSession({ title: 'tree child', childOf: root });
      const grandchild = fake.seedSession({ title: 'tree grandchild', childOf: child });
      const rows = await context.client.waitForSession((row) => row.id === grandchild.id);
      const all = (await context.client.sessions({ refresh: true })).filter((row) => [root.id, child.id, grandchild.id].includes(row.id));
      expect(all.map((row) => row.id).sort()).toEqual([root.id, child.id, grandchild.id].sort());
      expect(rows.origin).toBe('subagent');
      expect(rows.parentThreadId).toBe(child.storeKey);
      expect(rows.control?.drive?.supported).toBe(false);
      expect(all.find((row) => row.id === child.id).parentThreadId).toBe(root.storeKey);
      expect(all.find((row) => row.id === root.id).origin).toBeUndefined();
      // Driving a subagent is refused, whatever the roster says.
      const refused = await context.client.attach(agent, grandchild.id, { mode: 'resume', reason: 'takeover' });
      const outcome = await refused.waitForFrame((frame) => frame.kind === 'error' || frame.kind === 'attach-conflict' || frame.kind === 'session');
      if (outcome.kind === 'session') expect(outcome.authority?.canMutate).toBe(false);
      refused.close();
    },
  });

  extras.push({
    title: 'a prompt on the model and thinking level the session already runs switches nothing before it is sent',
    async run(context) {
      const fake = asFake(context);
      const session = await context.drivableSession('same model');
      const owner = await context.openDrive(session);
      const target = { providerID: 'fake', modelID: 'pi-reason', reasoningEffort: 'high' };
      const switched = fake.ledger.mark();
      expect((await context.prompt(owner, 'onto the reasoning model', { model: target })).kind).toBe('ack');
      expect(fake.ledger.commands('set_model', switched)).toHaveLength(1);
      expect(fake.ledger.commands('set_thinking_level', switched)).toHaveLength(1);
      const same = fake.ledger.mark();
      const entries = readEntries(piFileOf(session.id)).length;
      expect((await context.prompt(owner, 'still on it', { model: target })).kind).toBe('ack');
      expect(fake.ledger.commands('set_model', same)).toEqual([]);
      expect(fake.ledger.commands('set_thinking_level', same)).toEqual([]);
      expect(context.prompted(session, same)).toEqual(['still on it']);
      // No model entry joins the file for a switch that changed nothing.
      await owner.waitForMessage((message) => message.type === 'model-output' && text(message).includes('still on it'));
      expect(readEntries(piFileOf(session.id)).slice(entries).filter((entry) => entry.type === 'model_change')).toEqual([]);
      // A different level is still a switch.
      const level = fake.ledger.mark();
      expect((await context.prompt(owner, 'thinking less', { model: { ...target, reasoningEffort: 'low' } })).kind).toBe('ack');
      expect(fake.ledger.commands('set_thinking_level', level).map((entry) => entry.frame?.level)).toEqual(['low']);
      owner.close();
    },
  });

  extras.push({
    title: 'a dialog takes one decision, only of its own kind, and a stopped turn closes the dialogs it raised',
    async run(context) {
      const fake = asFake(context);
      const session = await context.drivableSession('dialog decisions');
      const owner = await context.openDrive(session);
      const mark = fake.ledger.mark();
      const replies = (from: number) => fake.ledger.commands('extension_ui_response', from).map((entry) => entry.frame);
      const asked = context.prompt(owner, '[[question]] pick once');
      const card = await owner.waitForMessage((message) => message.type === 'question-request' && String(message.requestId).startsWith('question-'));
      // An id the runtime never asked under is refused, and nothing reaches the runtime.
      expect((await owner.sendAndAwait({ kind: 'answer', requestId: `${card.requestId}-forged`, answers: [['Left']] })).kind).toBe('nack');
      expect((await owner.sendAndAwait({ kind: 'reject-question', requestId: `${card.requestId}-forged` })).kind).toBe('nack');
      expect(replies(mark)).toEqual([]);
      expect((await owner.sendAndAwait({ kind: 'answer', requestId: card.requestId, answers: [['Left']] })).kind).toBe('ack');
      // Already answered: a second decision is refused, not delivered again.
      expect((await owner.sendAndAwait({ kind: 'reject-question', requestId: card.requestId })).kind).toBe('nack');
      expect((await owner.sendAndAwait({ kind: 'answer', requestId: card.requestId, answers: [['Right']] })).kind).toBe('nack');
      expect((await asked).kind).toBe('ack');
      await owner.waitForMessage((message) => message.type === 'model-output' && text(message).includes('answered Left'));
      expect(replies(mark)).toEqual([{ type: 'extension_ui_response', id: card.requestId, value: 'Left' }]);

      // A confirm is a permission: answering it as a question is refused.
      const stopMark = fake.ledger.mark();
      const from = owner.frames.length;
      const held = context.prompt(owner, '[[permission]] then stop');
      const confirm = await owner.waitForMessage((message) => message.type === 'permission-request' && String(message.requestId).startsWith('permission-')
        && !owner.messages().some((other) => other.type === 'permission-resolved' && other.requestId === message.requestId));
      expect((await owner.sendAndAwait({ kind: 'answer', requestId: confirm.requestId, answers: [['yes']] })).kind).toBe('nack');
      expect(replies(stopMark)).toEqual([]);
      // Stop while the turn waits on it: the card closes, the runtime is told the dialog is cancelled
      // (it would otherwise hold the stopped turn open), and the turn ends.
      expect((await owner.sendAndAwait({ kind: 'command', name: 'stop' })).kind).toBe('ack');
      await owner.waitForMessage((message) => message.type === 'permission-resolved' && message.requestId === confirm.requestId);
      expect((await held).kind).toBe('ack');
      await owner.waitForFrame((frame) => frame.kind === 'message' && frame.message?.type === 'run-summary'
        && frame.message.status === 'cancelled', { after: from, what: 'the stopped turn' });
      expect(replies(stopMark)).toEqual([{ type: 'extension_ui_response', id: confirm.requestId, cancelled: true }]);
      // Nothing is pending any more: a tab that joins the Drive now holds no card, and a late decision
      // is refused.
      const after = await context.client.attach(agent, session.id, { mode: 'resume', reason: 'takeover' });
      await after.waitForKind('history');
      await Bun.sleep(200);
      expect(after.messages().some((message) => message.type === 'permission-request' && message.requestId === confirm.requestId)).toBe(false);
      expect((await owner.sendAndAwait({ kind: 'approve', requestId: confirm.requestId, decision: 'approve' })).kind).toBe('nack');
      expect(replies(stopMark)).toHaveLength(1);

      // A dialog the runtime settled by itself during the run (its timeout) closes when the run ends.
      const expiring = context.prompt(owner, '[[expiringconfirm]] nobody answers');
      const lapsed = await owner.waitForMessage((message) => message.type === 'permission-request' && String(message.requestId).endsWith('-expiring'));
      expect((await expiring).kind).toBe('ack');
      await owner.waitForMessage((message) => message.type === 'permission-resolved' && message.requestId === lapsed.requestId
        && message.decision === 'external');
      const later = await context.client.attach(agent, session.id, { mode: 'resume', reason: 'takeover' });
      await later.waitForKind('history');
      await Bun.sleep(200);
      expect(later.messages().some((message) => message.type === 'permission-request' && message.requestId === lapsed.requestId)).toBe(false);
      expect((await owner.sendAndAwait({ kind: 'approve', requestId: lapsed.requestId, decision: 'approve' })).kind).toBe('nack');
      later.close();
      after.close();
      owner.close();
    },
  });

  extras.push({
    title: omp
      ? 'Drive keeps driving through what omp itself writes between turns: an extension entry, a touch, its own whole-body rewrite'
      : 'Drive keeps driving through an extension entry and a touch between turns, and ends on a whole-body rewrite Pi never makes',
    async run(context) {
      const fake = asFake(context);
      const session = await context.drivableSession('own writes');
      const owner = await context.openDrive(session);
      const demoted = (frame: any) => frame.kind === 'session' && frame.info?.control?.drive?.state !== 'driving';
      const turn = async (prompt: string): Promise<void> => {
        const from = owner.frames.length;
        expect((await context.prompt(owner, prompt)).kind).toBe('ack');
        await owner.waitForFrame((frame) => frame.kind === 'message' && frame.message?.type === 'status'
          && frame.message.status === 'idle', { after: from, what: `the end of "${prompt}"` });
      };
      await turn('before own writes');
      const from = owner.frames.length;
      // An extension's entry and a bare touch: no conversation row, nobody else's prompt.
      fake.watcherNoise(session);
      await Bun.sleep(1_000);
      expect(owner.frames.slice(from).filter(demoted)).toEqual([]);
      await turn('after an extension entry');
      // What omp writes when it rewrites a session: a new file, renamed onto the path, that starts with
      // its 256-byte title slot and holds every entry it had, as it loaded them (omp migrates and
      // sanitizes entries at load, and the next write after that rewrites the whole file).
      const file = piFileOf(session.id);
      let sanitized = false;
      const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
        .filter((line) => JSON.parse(line).type !== 'title')
        .map((line) => {
          const entry = JSON.parse(line);
          if (sanitized || entry.message?.role !== 'assistant') return line;
          sanitized = true;
          delete entry.message.api;
          return JSON.stringify(entry);
        });
      expect(sanitized).toBe(true);
      const slot = { type: 'title', v: 1, title: 'own writes', updatedAt: new Date().toISOString(), pad: '' };
      slot.pad = ' '.repeat(255 - Buffer.byteLength(JSON.stringify(slot)));
      writeFileSync(`${file}.rewrite`, `${JSON.stringify(slot)}\n${lines.join('\n')}\n`);
      renameSync(`${file}.rewrite`, file);
      const mark = fake.ledger.mark();
      if (omp) {
        await Bun.sleep(1_000);
        expect(owner.frames.slice(from).filter(demoted)).toEqual([]);
        await turn('after its own rewrite');
        expect(context.prompted(session, mark)).toEqual(['after its own rewrite']);
      } else {
        await owner.waitForFrame(demoted, { after: from, what: 'Drive demoted after a rewrite Pi never makes' });
        expect((await context.prompt(owner, 'after the rewrite')).kind).toBe('nack');
        expect(context.prompted(session, mark)).toEqual([]);
        // Taking over again drives a runtime that reads the file as it is now.
        const again = await context.client.attach(agent, session.id, { mode: 'resume', reason: 'takeover' });
        expect((await again.waitForKind('session')).authority?.canMutate).toBe(true);
        expect((await context.prompt(again, 'after taking over again')).kind).toBe('ack');
        await again.waitForMessage((message) => message.type === 'model-output' && text(message).includes('after taking over again'));
        expect(context.prompted(session, mark)).toEqual(['after taking over again']);
        again.close();
      }
      owner.close();
    },
  });

  void writeFileSync;
  return extras;
}
