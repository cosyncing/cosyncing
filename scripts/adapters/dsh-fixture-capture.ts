#!/usr/bin/env bun
/** Capture real DSH frames with a bounded local Messages fixture; no provider access. */
export {};
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runDshContractCapture } from './dsh-contract-capture.ts';
import { DshAdapter } from '../../packages/typescript/adapters/dsh/src/implementation.ts';
import type { AgentMessage } from '../../packages/typescript/adapter-api/src/index.ts';

if (process.env['COSYNCING_DSH_FIXTURE_CAPTURE'] !== '1') {
  throw new Error('opt in with COSYNCING_DSH_FIXTURE_CAPTURE=1; this requires an installed 0.2.0-rc.2 host');
}
const scenario = process.argv[2] ?? 'text';
if (!['text', 'reasoning', 'reconnect', 'cancel', 'tool', 'approval-allow', 'approval-deny', 'blocking-question', 'timed-question', 'image-only', 'text-image'].includes(scenario)) throw new Error('unknown fixture scenario');
const imageScenario = scenario === 'image-only' || scenario === 'text-image';
const approvalScenario = scenario.startsWith('approval-');
let approvalPath = '';
const pixel = Buffer.from(await Bun.file(new URL('../../apps/client/web/icons/pwa-icon-192.png', import.meta.url)).arrayBuffer()).toString('base64');
let imageRequests = 0;
let requests = 0;
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    if (request.method !== 'POST' || !new URL(request.url).pathname.endsWith('/messages')) return new Response('not found', { status: 404 });
    requests += 1;
    if (requests > 6) return new Response('fixture request budget exhausted', { status: 400 });
    const body = await request.json() as { messages?: Array<{ content?: unknown }> };
    if (JSON.stringify(body.messages).includes('"type":"image"')) imageRequests += 1;
    const answered = JSON.stringify(body.messages).includes('tool_result');
    const tool = !answered && !imageScenario && !['text', 'reasoning', 'reconnect', 'cancel'].includes(scenario);
    const question = scenario.includes('question');
    const name = question ? 'ask_user_question' : approvalScenario ? 'write' : 'read';
    const args = question ? { questions: [{ id: 'q-fixture', question: 'Choose a fixture option', options: [{ label: 'yes' }, { label: 'no' }] }], ...(scenario === 'timed-question' ? { timeout: 1 } : {}) }
      : approvalScenario ? { file_path: approvalPath, content: 'Disposable approval fixture.\n',
        sandbox_permissions: 'danger-full-access', justification: 'Exercise a one-shot permission decision for this disposable fixture file.' } : { file_path: 'fixture.txt' };
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (type: string, payload: object) => controller.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify({ type, ...payload })}\n\n`));
        emit('message_start', { message: { id: `msg-fixture-${String(requests)}`, type: 'message', role: 'assistant', model: 'fixture-model', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
        if (scenario === 'reasoning') {
          emit('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } });
          emit('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Fixture reasoning.' } });
          emit('content_block_stop', { index: 0 });
        }
        const index = scenario === 'reasoning' ? 1 : 0;
        emit('content_block_start', { index, content_block: tool ? { type: 'tool_use', id: 'call-fixture', name, input: {} } : { type: 'text', text: '' } });
        if (tool) emit('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(args) } });
        else {
          emit('content_block_delta', { index, delta: { type: 'text_delta', text: 'Fixture ' } });
          await Bun.sleep(scenario === 'cancel' ? 2000 : scenario === 'reconnect' ? 500 : 100);
          emit('content_block_delta', { index, delta: { type: 'text_delta', text: 'reply.' } });
        }
        emit('content_block_stop', { index });
        emit('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
        emit('message_stop', {});
        controller.close();
      },
    });
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  },
});
const envName = 'DSH_FIXTURE_CAPTURE_KEY';
process.env[envName] = 'local-fixture-only';
try {
  const code = await runDshContractCapture([
    '--sessions', '--prompt', 'Run the scripted fixture scenario.', '--credential-env', envName,
    '--prompt-timeout', '20000', '--approval', 'deny', ...process.argv.slice(3),
  ], {
    modelSource: 'scripted-local',
    replaceFollowDuringTurn: scenario === 'reconnect',
    ...(imageScenario ? { promptContent: [
      ...(scenario === 'text-image' ? [{ type: 'text', text: 'Describe the fixture image.' }] : []),
      { type: 'image', mediaType: 'image/png', data: pixel },
    ] } : {}),
    beforeTurn: scenario !== 'timed-question' ? async ({ baseUrl, cookieHeader, sessionId, home }) => {
      const equals = cookieHeader.indexOf('=');
      const cookie = { name: cookieHeader.slice(0, equals), value: cookieHeader.slice(equals + 1), expiresAt: Date.now() + 86_400_000 };
      const adapter = new DshAdapter({ baseUrl, env: {}, homeDir: home, dshHome: join(home, '.dsh'),
        credentialStore: { load: async () => cookie, save: async () => {}, clear: async () => {} } });
      const connection = await adapter.attach(sessionId, 'live');
      const messages: AgentMessage[] = []; const decisions = new Set<string>(); const failures: string[] = [];
      const unsubscribe = connection.subscribe((m) => {
        messages.push(m);
        if (approvalScenario && m.type === 'permission-request' && !decisions.has(m.requestId)) {
          decisions.add(m.requestId);
          void connection.respondPermission?.(m.requestId, scenario === 'approval-allow' ? 'approve' : 'reject').catch((error: unknown) => failures.push(String(error)));
        }
        if (scenario === 'cancel' && m.type === 'model-output' && m.final === false && !decisions.has('cancel')) {
          decisions.add('cancel'); void connection.runCommand?.('stop').catch((error: unknown) => failures.push(String(error)));
        }
        if (m.type === 'question-request' && scenario === 'blocking-question' && !decisions.has(m.requestId)) {
          decisions.add(m.requestId);
          void connection.answerQuestion?.(m.requestId, [['yes']]).catch((error: unknown) => failures.push(String(error)));
        }
      });
      const close = async () => { unsubscribe(); await connection.close();
        (adapter as unknown as { remoteHost?: { stop(): void } }).remoteHost?.stop(); };
      try {
        await connection.getHistory();
        const host = (adapter as unknown as { remoteHost: { verify(): Promise<{ ok: boolean }> } }).remoteHost;
        if (!(await host.verify()).ok) throw new Error('product event readiness failed before the scripted prompt');
      } catch (error) { await close(); throw error; }
      return { close, async finish() {
        const outputs = messages.filter((m) => m.type === 'model-output');
        const checks = {
          userEcho: messages.some((m) => m.type === 'user-message' && (!imageScenario || m.imageCount === 1)),
          imageAdmission: !imageScenario || imageRequests === 1,
          durableImageReadback: !imageScenario || messages.some((m) => m.type === 'file-artifact' && !!m.userMessageKey && m.url?.startsWith('data:image/')),
          streamedReply: outputs.some((m) => m.type === 'model-output' && m.final === false && m.text === 'Fixture '),
          settledReply: scenario === 'cancel' || outputs.some((m) => m.type === 'model-output' && m.final === true && m.text === 'Fixture reply.'),
          reasoningVisible: scenario !== 'reasoning' || messages.some((m) => m.type === 'thinking' && m.text === 'Fixture reasoning.'),
          canceledTurn: scenario !== 'cancel' || messages.some((m) => m.type === 'run-summary' && m.status === 'cancelled'),
          toolResult: scenario !== 'tool' || messages.some((m) => m.type === 'tool-result' && String(m.result).includes('Local fixture content.')),
          questionResolved: scenario !== 'blocking-question' || (decisions.size === 1 && !(await connection.getPending?.() ?? []).length),
          approvalResolved: !approvalScenario || (decisions.size === 1 && messages.some((m) => m.type === 'permission-resolved')),
          approvalOutcome: !approvalScenario || existsSync(approvalPath) === (scenario === 'approval-allow'),
          noAnswerFailure: failures.length === 0,
        };
        return { passed: Object.values(checks).every((ok) => ok), modelBacked: false, providerSpending: 0, checks, messages };
      } };
    } : undefined,
    afterTurn: scenario === 'timed-question' ? async ({ baseUrl, cookieHeader, sessionId, home }) => {
      const equals = cookieHeader.indexOf('=');
      const cookie = { name: cookieHeader.slice(0, equals), value: cookieHeader.slice(equals + 1), expiresAt: Date.now() + 86_400_000 };
      const adapter = new DshAdapter({ baseUrl, env: {}, homeDir: home, dshHome: join(home, '.dsh'),
        credentialStore: { load: async () => cookie, save: async () => {}, clear: async () => {} } });
      const messages: AgentMessage[] = [];
      const connection = await adapter.attach(sessionId, 'live');
      const unsubscribe = connection.subscribe((m) => messages.push(m));
      try {
        await connection.getHistory();
        const host = (adapter as unknown as { remoteHost: { verify(): Promise<{ ok: boolean }> } }).remoteHost;
        if (!(await host.verify()).ok) throw new Error('the product event generation did not become ready');
        const pending = await connection.getPending?.() ?? [];
        const question = pending.find((m) => m.type === 'question-request');
        if (question?.type !== 'question-request' || question.blocking !== false) throw new Error('continued question did not appear through the product adapter');
        await connection.answerQuestion?.(question.requestId, [['yes']]);
        const deadline = Date.now() + 5000;
        while (!messages.some((m) => m.type === 'model-output' && m.final) && Date.now() < deadline) await Bun.sleep(50);
        if (!messages.some((m) => m.type === 'model-output' && m.final)) throw new Error('late product answer did not produce a settled local scripted reply');
        return { modelBacked: false, providerSpending: 0, pendingBefore: pending, pendingAfter: await connection.getPending?.(), messages };
      } finally {
        unsubscribe(); await connection.close();
        // This standalone pass owns the adapter and its disposable remote link.
        (adapter as unknown as { remoteHost?: { stop(): void } }).remoteHost?.stop();
      }
    } : undefined,
    launchHost: (executable, port, workspace, env) => {
      const patch = join(env['HOME']!, 'fixture.patch.yml');
      approvalPath = join(env['HOME']!, 'approval-fixture.txt');
      writeFileSync(join(workspace, 'fixture.txt'), 'Local fixture content.\n');
      writeFileSync(patch, [
        '- id: llm-deepseek', '  config:', `    baseURL: http://127.0.0.1:${String(server.port)}`,
        `    apiKeyEnv: ${envName}`, '    thinking: disabled', '    maxTokens: 64',
        '    models:', '      - id: deepseek-flash', '        name: Fixture', '        inputModalities: [text, image]',
        '- id: session-title-llm', '  disabled: true',
        ...(scenario === 'timed-question' ? [
          '- id: preset-standard', '  config:', '    id: standard', '    plugins:',
          '      - id: tool-ask-user', "        name: '@deepseek-ai/dsh-tool-ask-user'", '        config:', '          mode: timed',
        ] : []),
      ].join('\n') + '\n');
      return Bun.spawn([executable, '--profile', 'web', '--patch', patch, '--no-open', '--port', String(port)], {
        cwd: workspace, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
      });
    },
  });
  console.log(`local fixture requests: ${String(requests)}; provider spending: 0`);
  process.exitCode = code;
} finally {
  delete process.env[envName];
  server.stop(true);
}
