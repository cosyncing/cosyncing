/**
 * OpenCode session-control-state regression.
 *
 * Contract: docs/architecture/client-ui.md
 * Uses a fake OpenCode HTTP server, so this is zero model cost and does not need a real opencode
 * binary. It proves the adapter reports explicit Observe+Drive / True Sync metadata instead of
 * relying on the older terminalSyncHint UI fallback.
 *
 *   bun run scripts/broker/tests/opencode/test-opencode-control.ts
 */
export {};
import { mkdirSync } from 'node:fs';
import {
  OpenCodeAdapter,
  OPENCODE_MAX_CONNECTED_PROVIDERS,
  OPENCODE_MAX_MODEL_OPTIONS,
  OPENCODE_MAX_MODELS_PER_PROVIDER,
  OPENCODE_MAX_PROVIDER_RECORDS,
  OPENCODE_MAX_VARIANTS_PER_MODEL,
  normalizeOpenCodeProviderCatalog,
} from '../../../../packages/typescript/adapters/opencode/src/index.ts';

const PORT = Number(process.env.COSYNCING_TEST_PORT ?? 45000 + Math.floor(Math.random() * 10000));
const BASE = `http://127.0.0.1:${PORT}`;
const DIR = "/tmp/cosyncing opencode 'control' $(x)";
const STORE = `/tmp/cosyncing-opencode-control-store-${PORT}`;
const SESSION = {
  id: 'ses_control',
  slug: 'control',
  directory: DIR,
  title: 'control session',
  model: { id: 'model-a', providerID: 'provider-a', modelID: 'model-a', variant: 'fast' },
  agent: 'build',
  time: { created: 1, updated: 2 },
};
const SESSION_NO_VARIANT = {
  id: 'ses_no_variant',
  slug: 'no-variant',
  directory: DIR,
  title: 'no variant current model',
  model: { id: 'MiniMax-M3', providerID: 'minimax', modelID: 'MiniMax-M3' },
  time: { created: 1, updated: 2 },
};
const MODELS = [
  {
    providerID: 'minimax',
    id: 'MiniMax-M3',
    name: 'MiniMax-M3',
    capabilities: { tools: false },
    variants: [
      { id: 'default', body: { stream_options: { include_usage: true } } },
      { id: 'fast', headers: { 'X-Api-Key': '${OPENCODE_RUNTIME_OWNS_THIS}' } },
    ],
  },
  { providerID: 'variant-dedupe', id: 'same-id', name: 'Same ID' },
  { providerID: 'variant-dedupe', id: 'same-id', name: 'Same ID', variants: [{ id: 'default' }] },
  { providerID: 'vllm-hpc', id: 'qwen3.6-27B-FP8', name: 'qwen3.6-27B-FP8', capabilities: { tools: false } },
  { providerID: 'openai', id: 'gpt-5.2', name: 'GPT-5.2', capabilities: { tools: true } },
  { providerID: 'legacy-shape', modelID: 'model-id-only', name: 'Model ID only', capabilities: { tools: false } },
  { providerID: '', id: 'invalid' },
];
const AGENTS = [
  { name: 'build', mode: 'primary', description: 'Implementation agent' },
  { name: 'plan', mode: 'primary', description: 'Read-only planning agent' },
  { name: 'summary', mode: 'internal', description: '' },
  { name: 'title', mode: 'primary', description: '' },
];
const promptBodies: any[] = [];
const renameBodies: any[] = [];
const forkBodies: any[] = [];
const agentSwitchBodies: any[] = [];
const createBodies: any[] = [];
let failNextAgentSwitch = false;
const eventClients = new Set<any>();
let eventStreamStarts = 0;
let failNextRename = false;
let failNextFork = false;
let modelResponse: any[] = MODELS;
let modelStatus = 200;
let providerConfig: any = null;
let providerResponse: any = null;

const results: { name: string; ok: boolean; detail?: string }[] = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

const eventStream = () =>
  new Response(new ReadableStream({
    start(controller: any) {
      eventStreamStarts++;
      eventClients.add(controller);
    },
    cancel() { /* stale controllers are pruned on next send */ },
  }), {
    headers: { 'content-type': 'text/event-stream' },
  });

function sendEvent(event: unknown): void {
  const frame = `data: ${JSON.stringify({ payload: event })}\n\n`;
  for (const c of [...eventClients]) {
    try {
      c.enqueue(frame);
    } catch {
      eventClients.delete(c);
    }
  }
}

async function waitFor(checkFn: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (checkFn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return checkFn();
}

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/global/event') return eventStream();
    if (url.pathname === '/project') return Response.json([{ worktree: DIR }]);
    if (url.pathname === '/provider') {
      if (providerResponse == null) return new Response('older server', { status: 404 });
      return Response.json(providerResponse);
    }
    if (url.pathname === '/api/model') {
      if (modelStatus !== 200) return new Response('model catalog exploded', { status: modelStatus });
      return Response.json({ data: modelResponse });
    }
    if (url.pathname === '/config/providers') {
      if (providerConfig == null) return new Response('no provider config', { status: 404 });
      return Response.json(providerConfig);
    }
    if (url.pathname === '/agent') return Response.json(AGENTS);
    if (url.pathname === '/session' && req.method === 'GET') return Response.json([SESSION, SESSION_NO_VARIANT]);
    if (url.pathname === '/session' && req.method === 'POST') {
      const body = await req.json() as any;
      createBodies.push(body);
      if (body.model != null || body.variant != null) {
        return Response.json({ _tag: 'BadRequest' }, { status: 400 });
      }
      return Response.json({
        ...SESSION,
        id: 'ses_created',
        title: body.title || 'Created session',
        directory: url.searchParams.get('directory') ?? undefined,
        model: undefined,
      });
    }
    if (url.pathname === `/session/${SESSION.id}` && req.method === 'PATCH') {
      const body = await req.json();
      renameBodies.push(body);
      if (failNextRename) {
        failNextRename = false;
        return Response.json({ error: 'native rename failed with secret=SHOULD_NOT_LEAK' }, { status: 500 });
      }
      return Response.json({ ...SESSION, title: String(body.title ?? '') || undefined, time: { ...SESSION.time, updated: 4 } });
    }
    if (url.pathname === `/session/${SESSION.id}/fork` && req.method === 'POST') {
      const body = await req.json();
      forkBodies.push(body);
      if (failNextFork) {
        failNextFork = false;
        return Response.json({ error: 'native fork failed with secret=SHOULD_NOT_LEAK' }, { status: 500 });
      }
      return Response.json({
        ...SESSION,
        id: 'ses_forked',
        slug: 'forked',
        title: 'Forked session',
        time: { ...SESSION.time, created: 5, updated: 6 },
      });
    }
    if (url.pathname === `/session/${SESSION.id}` && req.method === 'GET') return Response.json(SESSION);
    if (url.pathname === `/session/${SESSION_NO_VARIANT.id}` && req.method === 'GET') return Response.json(SESSION_NO_VARIANT);
    if (url.pathname === `/session/${SESSION.id}/message` || url.pathname === `/session/${SESSION_NO_VARIANT.id}/message`) return Response.json([]);
    if ((url.pathname === `/session/${SESSION.id}/prompt_async` || url.pathname === `/session/${SESSION_NO_VARIANT.id}/prompt_async`) && req.method === 'POST') {
      promptBodies.push(await req.json());
      return new Response(null, { status: 204 });
    }
    if (url.pathname === `/api/session/${SESSION.id}/agent` && req.method === 'POST') {
      agentSwitchBodies.push(await req.json());
      if (failNextAgentSwitch) {
        failNextAgentSwitch = false;
        return Response.json({ error: 'switch failed with secret=SHOULD_NOT_LEAK' }, { status: 400 });
      }
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/question' || url.pathname === '/permission') return Response.json([]);
    return new Response('not found', { status: 404 });
  },
});
let serverStopped = false;

try {
  mkdirSync(`${STORE}/storage/session`, { recursive: true });
  const adapter = new OpenCodeAdapter({ baseUrl: BASE, storageDir: STORE });
  check('shared-server mode advertises app new-session create', await adapter.canCreateSession());
  const created = await adapter.createSession({
    directory: DIR,
    title: 'Exact selected create',
    model: {
      providerID: 'minimax-cn-coding-plan',
      modelID: 'MiniMax-M2.5',
      variant: 'fast',
    },
  });
  check(
    'new OpenCode session keeps prompt-only model fields out of native create',
    JSON.stringify(createBodies[0]) === JSON.stringify({ title: 'Exact selected create' }) &&
      created.currentModel?.providerID === 'minimax-cn-coding-plan' &&
      created.currentModel?.modelID === 'MiniMax-M2.5' &&
      created.currentModel?.variant === 'fast',
    JSON.stringify({ body: createBodies[0], current: created.currentModel }),
  );
  const sessions = await adapter.discoverSessions();
  const s = sessions.find((x) => x.id === SESSION.id);
  check('discovery returned fake session', !!s, `count=${sessions.length}`);
  check('discovery reports explicit control', !!s?.control, JSON.stringify(s?.control));
  check('drive state is already app-drivable', s?.control?.drive.supported === true && s.control.drive.state === 'driving');
  check('terminal sync is supported but not falsely active', s?.control?.terminalSync.supported === true && s.control.terminalSync.active === false);
  check('terminal sync command uses opencode attach', /opencode attach/.test(s?.control?.terminalSync.command ?? ''));
  check('terminal sync command targets same server and session', (s?.control?.terminalSync.command ?? '').includes(BASE) && (s?.control?.terminalSync.command ?? '').includes(SESSION.id));
  check('terminal sync command shell-quotes cwd', /--dir '\/tmp\/cosyncing opencode '\\''control'\\'' \$\(x\)'/.test(s?.control?.terminalSync.command ?? ''), s?.control?.terminalSync.command ?? '');
  const renamed = await adapter.renameSession?.(SESSION.id, '  Readable native title  ');
  check('native OpenCode rename PATCHes trimmed title', renameBodies[0]?.title === 'Readable native title', JSON.stringify(renameBodies[0]));
  check('native OpenCode rename returns server title', renamed?.title === 'Readable native title', JSON.stringify(renamed));
  failNextRename = true;
  let renameFailed = false;
  let renameFailureMessage = '';
  try {
    await adapter.renameSession?.(SESSION.id, 'next title');
  } catch (err) {
    renameFailed = true;
    renameFailureMessage = err instanceof Error ? err.message : String(err);
  }
  check('native OpenCode rename failure throws non-secret error', renameFailed && !/SHOULD_NOT_LEAK/.test(renameFailureMessage), renameFailureMessage);
  const forked = await adapter.forkSession?.(SESSION.id, { messageId: 'msg_123' });
  check('native OpenCode fork POSTs selected messageID', forkBodies[0]?.messageID === 'msg_123', JSON.stringify(forkBodies[0]));
  check('native OpenCode fork returns child session', forked?.id === 'ses_forked' && forked.title === 'Forked session', JSON.stringify(forked));
  failNextFork = true;
  let forkFailed = false;
  let forkFailureMessage = '';
  try {
    await adapter.forkSession?.(SESSION.id);
  } catch (err) {
    forkFailed = true;
    forkFailureMessage = err instanceof Error ? err.message : String(err);
  }
  check('native OpenCode fork failure throws non-secret error', forkFailed && !/SHOULD_NOT_LEAK/.test(forkFailureMessage), forkFailureMessage);

  const conn = await adapter.attach(SESSION.id);
  check('attach frame keeps control metadata', conn.info.control?.drive.state === 'driving' && conn.info.control?.terminalSync.active === false);
  check('attach frame preserves current model variant', conn.info.currentModel?.variant === 'fast', JSON.stringify(conn.info.currentModel));
  check('OpenCode does not advertise a fake global permission-mode picker', conn.listModes === undefined, 'permission cards are per-request only');
  const agents = await conn.listAgents?.();
  check(
    'agent roster exposes only native primary OpenCode agents including plan',
    !!agents?.some((a) => a.name === 'build') &&
      !!agents?.some((a) => a.name === 'plan') &&
      !agents?.some((a) => a.name === 'summary' || a.name === 'title'),
    JSON.stringify(agents),
  );
  providerResponse = {
    connected: ['minimax-cn-coding-plan', 'custom-connected'],
    all: [
      {
        id: 'disconnected-global',
        models: {
          hidden: { id: 'hidden', providerID: 'disconnected-global', name: 'Hidden' },
        },
      },
      {
        id: 'minimax-cn-coding-plan',
        models: {
          'MiniMax-M2.5': {
            id: 'MiniMax-M2.5',
            providerID: 'minimax-cn-coding-plan',
            name: 'MiniMax M2.5',
            variants: {
              default: {},
              fast: { reasoningEffort: 'high' },
            },
          },
        },
      },
      {
        id: 'custom-connected',
        models: [
          { id: 'custom-model', name: 'Custom model', variants: ['one', { id: 'two', name: 'Second' }] },
          { id: 'custom-model', name: 'Duplicate model', variants: ['one'] },
        ],
      },
    ],
  };
  const connectedModels = await conn.listModels?.();
  check(
    'real /provider connected/all shape includes MiniMax Coding Plan',
    !!connectedModels?.some((m) => m.providerID === 'minimax-cn-coding-plan' && m.modelID === 'MiniMax-M2.5'),
    JSON.stringify(connectedModels),
  );
  check(
    'real /provider object variants preserve exact identities',
    !!connectedModels?.some((m) => m.providerID === 'minimax-cn-coding-plan' && m.variant === 'default') &&
      !!connectedModels?.some((m) => m.providerID === 'minimax-cn-coding-plan' && m.variant === 'fast'),
    JSON.stringify(connectedModels),
  );
  check(
    'custom connected provider array variants are normalized and exact duplicates are removed',
    connectedModels?.filter((m) => m.providerID === 'custom-connected').length === 2,
    JSON.stringify(connectedModels?.filter((m) => m.providerID === 'custom-connected')),
  );
  check(
    'disconnected global providers remain absent',
    !connectedModels?.some((m) => m.providerID === 'disconnected-global'),
    JSON.stringify(connectedModels),
  );

  providerResponse = {
    connected: { 'object-provider': true, disconnected: false },
    all: {
      'object-provider': {
        models: {
          'object-model': { name: 'Object model', variants: { precise: {} } },
        },
      },
      disconnected: { models: { nope: { name: 'Nope' } } },
    },
  };
  const objectModels = await conn.listModels?.();
  check(
    'object provider/connected response variant is normalized',
    objectModels?.length === 1 &&
      objectModels[0]?.providerID === 'object-provider' &&
      objectModels[0]?.modelID === 'object-model' &&
      objectModels[0]?.variant === 'precise',
    JSON.stringify(objectModels),
  );

  const bounded = normalizeOpenCodeProviderCatalog({
    connected: Array.from({ length: OPENCODE_MAX_CONNECTED_PROVIDERS + 20 }, (_v, i) => `p-${i}`),
    all: Array.from({ length: OPENCODE_MAX_PROVIDER_RECORDS + 20 }, (_v, i) => ({
      id: `p-${i}`,
      models: Array.from({ length: OPENCODE_MAX_MODELS_PER_PROVIDER + 20 }, (_m, j) => ({
        id: `m-${j}`,
        variants: Object.fromEntries(
          Array.from({ length: OPENCODE_MAX_VARIANTS_PER_MODEL + 20 }, (_x, k) => [`v-${k}`, {}]),
        ),
      })),
    })),
  });
  check(
    'provider/model/variant catalog processing is explicitly bounded',
    !!bounded &&
      bounded.length === OPENCODE_MAX_MODEL_OPTIONS &&
      bounded.every((m) => Number(m.providerID.slice(2)) < OPENCODE_MAX_CONNECTED_PROVIDERS) &&
      bounded.every((m) => Number(m.modelID.slice(2)) < OPENCODE_MAX_MODELS_PER_PROVIDER) &&
      bounded.every((m) => Number(m.variant?.slice(2)) < OPENCODE_MAX_VARIANTS_PER_MODEL),
    JSON.stringify({ count: bounded?.length }),
  );

  providerResponse = null;
  const models = await conn.listModels?.();
  check('model roster includes non-tool Minimax model', !!models?.some((m) => m.providerID === 'minimax' && m.modelID === 'MiniMax-M3'));
  check(
    'model roster expands real OpenCode variants[]',
    !!models?.some((m) => m.providerID === 'minimax' && m.modelID === 'MiniMax-M3' && m.variant === 'fast') &&
      !!models?.some((m) => m.providerID === 'minimax' && m.modelID === 'MiniMax-M3' && m.variant === 'default'),
    JSON.stringify(models?.filter((m) => m.providerID === 'minimax')),
  );
  check(
    'model roster keeps default variant distinct from no-variant identity',
    new Set((models ?? []).filter((m) => m.providerID === 'variant-dedupe' && m.modelID === 'same-id').map((m) => m.variant ?? '')).size === 2,
    JSON.stringify(models?.filter((m) => m.providerID === 'variant-dedupe')),
  );
  check('model roster includes non-tool vLLM HPC model', !!models?.some((m) => m.providerID === 'vllm-hpc' && m.modelID === 'qwen3.6-27B-FP8'));
  check('model roster accepts modelID-only OpenCode shape', !!models?.some((m) => m.providerID === 'legacy-shape' && m.modelID === 'model-id-only'));
  check('model roster injects current model when /api/model omits it', !!models?.some((m) => m.providerID === 'provider-a' && m.modelID === 'model-a'));
  providerConfig = { data: [{ id: 'minimax' }, { id: 'openai' }] };
  modelResponse = [
    ...MODELS,
    ...Array.from({ length: 5000 }, (_v, i) => ({ providerID: `dump-${i}`, id: `catalog-${i}`, name: `Catalog ${i}` })),
  ];
  const filteredModels = await conn.listModels?.();
  const filteredProviders = new Set((filteredModels ?? []).map((m) => m.providerID));
  check(
    'model roster filters huge catalog dumps to configured providers when /config/providers succeeds',
    filteredModels!.length > 0 &&
      [...filteredProviders].every((p) => p === 'minimax' || p === 'openai') &&
      filteredModels!.some((m) => m.providerID === 'minimax') &&
      filteredModels!.some((m) => m.providerID === 'openai'),
    JSON.stringify({ count: filteredModels?.length, providers: [...filteredProviders] }),
  );
  providerConfig = null;
  modelResponse = MODELS;
  modelStatus = 500;
  const warnLines: string[] = [];
  const oldWarn = console.warn;
  console.warn = (...args: unknown[]) => warnLines.push(args.map(String).join(' '));
  const failedModels = await conn.listModels?.();
  let preSessionRefreshRejected = false;
  try {
    await adapter.listModels();
  } catch {
    preSessionRefreshRejected = true;
  }
  console.warn = oldWarn;
  modelStatus = 200;
  check(
    'model roster HTTP 500 preserves the last catalog and logs status/body snippet',
    Array.isArray(failedModels) &&
      JSON.stringify(failedModels) === JSON.stringify(filteredModels) &&
      warnLines.some((l) => l.includes('/api/model returned 500') && l.includes('model catalog exploded')),
    JSON.stringify({ failedModels, warnLines }),
  );
  check(
    'pre-session OpenCode refresh rejects stale data instead of relabeling it fresh',
    preSessionRefreshRejected,
  );
  let sessionInfoMeta: any;
  const unsub = conn.subscribe((m) => {
    if (m.type === 'metadata-update' && m.key === 'sessionInfo') sessionInfoMeta = m;
  });
  sendEvent({
    type: 'session.updated',
    properties: {
      info: {
        ...SESSION,
        model: { id: 'qwen3.6-27B-FP8', providerID: 'vllm-hpc', modelID: 'qwen3.6-27B-FP8' },
        time: { ...SESSION.time, updated: 3 },
      },
    },
  });
  await waitFor(() => conn.info.currentModel?.providerID === 'vllm-hpc' && conn.info.currentModel?.modelID === 'qwen3.6-27B-FP8');
  unsub();
  check(
    'native session.updated refreshes OpenCode currentModel',
    conn.info.currentModel?.providerID === 'vllm-hpc' && conn.info.currentModel?.modelID === 'qwen3.6-27B-FP8',
    JSON.stringify(conn.info.currentModel),
  );
  check(
    'native model update emits sessionInfo metadata for broker/app session frame',
    sessionInfoMeta?.value?.currentModel?.providerID === 'vllm-hpc' && sessionInfoMeta?.value?.currentModel?.modelID === 'qwen3.6-27B-FP8',
    JSON.stringify(sessionInfoMeta),
  );
  const noVariantConn = await adapter.attach(SESSION_NO_VARIANT.id);
  const noVariantModels = await noVariantConn.listModels?.();
  check(
    'model roster does not inject bare current-model row when variants already cover provider/model',
    !noVariantModels?.some((m) => m.providerID === 'minimax' && m.modelID === 'MiniMax-M3' && m.variant === undefined),
    JSON.stringify(noVariantModels?.filter((m) => m.providerID === 'minimax')),
  );
  await noVariantConn.close();
  await conn.sendPrompt?.({ text: 'use selected model', model: { providerID: 'minimax', modelID: 'MiniMax-M3', variant: 'default' } });
  check(
    'prompt_async carries exact providerID/modelID plus top-level variant',
    promptBodies[0]?.model?.providerID === 'minimax' &&
      promptBodies[0]?.model?.modelID === 'MiniMax-M3' &&
      promptBodies[0]?.model?.variant === undefined &&
      promptBodies[0]?.variant === 'default',
    JSON.stringify({ model: promptBodies[0]?.model ?? null, variant: promptBodies[0]?.variant ?? null }),
  );
  // The "minimax X-Api-Key login fail" is NOT a cosyncing bug: CA forwards model IDENTITY verbatim but must
  // NEVER carry the provider's `X-Api-Key`/credential header (that variant header is owned by the opencode serve
  // runtime — see the MODELS fixture). Pin the secret-free contract so a refactor can't start leaking it.
  check(
    'prompt_async never forwards the provider secret (no X-Api-Key / headers)',
    !/x-api-key/i.test(JSON.stringify(promptBodies[0] ?? {})) && promptBodies[0]?.headers === undefined && promptBodies[0]?.model?.headers === undefined,
    JSON.stringify(promptBodies[0] ?? {}),
  );
  await conn.sendPrompt?.({ text: 'use native plan agent', agent: 'plan' });
  check(
    'prompt_async forwards OpenCode plan as agent, not permissionMode',
    promptBodies[1]?.agent === 'plan' && promptBodies[1]?.permissionMode === undefined,
    JSON.stringify(promptBodies[1] ?? {}),
  );
  check(
    'discovery reports the session\'s REAL agent (no hardcoded build)',
    s?.currentAgent === 'build' && conn.info.currentAgent === 'build',
    JSON.stringify({ discovered: s?.currentAgent, attached: conn.info.currentAgent }),
  );
  let agentMeta: any;
  const unsubAgent = conn.subscribe((m) => {
    if (m.type === 'metadata-update' && m.key === 'sessionInfo' && (m.value as any)?.currentAgent) agentMeta = m;
  });
  await conn.setAgent?.('plan');
  check(
    'setAgent POSTs native v2 switchAgent body',
    agentSwitchBodies[0]?.agent === 'plan',
    JSON.stringify(agentSwitchBodies[0] ?? {}),
  );
  check(
    'setAgent updates currentAgent and emits sessionInfo metadata',
    conn.info.currentAgent === 'plan' && (agentMeta?.value as any)?.currentAgent === 'plan',
    JSON.stringify({ info: conn.info.currentAgent, meta: agentMeta?.value ?? null }),
  );
  agentMeta = undefined;
  sendEvent({
    type: 'session.next.agent.switched',
    properties: { sessionID: SESSION.id, messageID: 'msg_switch', agent: 'build' },
  });
  await waitFor(() => conn.info.currentAgent === 'build');
  check(
    'terminal-side agent switch (SSE) flips currentAgent and emits sessionInfo metadata',
    conn.info.currentAgent === 'build' && (agentMeta?.value as any)?.currentAgent === 'build',
    JSON.stringify({ info: conn.info.currentAgent, meta: agentMeta?.value ?? null }),
  );
  unsubAgent();
  failNextAgentSwitch = true;
  let switchFailed = false;
  let switchFailureMessage = '';
  try {
    await conn.setAgent?.('bogus');
  } catch (err) {
    switchFailed = true;
    switchFailureMessage = err instanceof Error ? err.message : String(err);
  }
  check(
    'setAgent failure throws non-secret error and keeps currentAgent',
    switchFailed && !/SHOULD_NOT_LEAK/.test(switchFailureMessage) && conn.info.currentAgent === 'build',
    JSON.stringify({ switchFailureMessage, currentAgent: conn.info.currentAgent }),
  );
  const streamStartsBeforeCleanDrop = eventStreamStarts;
  for (const c of [...eventClients]) {
    try {
      c.close();
    } catch {
      eventClients.delete(c);
    }
  }
  await waitFor(() => eventStreamStarts >= streamStartsBeforeCleanDrop + 1, 3000);
  const beforeCleanDropPromptCount = promptBodies.length;
  await conn.sendPrompt?.({ text: 'after transient sse drop' });
  check(
    'transient OpenCode SSE stream end reconnects without downgrading Drive',
    eventStreamStarts >= streamStartsBeforeCleanDrop + 1 &&
      conn.info.attachMode === 'live' &&
      conn.info.control?.drive.state === 'driving' &&
      promptBodies.length === beforeCleanDropPromptCount + 1,
    `starts=${eventStreamStarts} before=${streamStartsBeforeCleanDrop} control=${JSON.stringify(conn.info.control)}`,
  );
  const fastIdleAdapter = new OpenCodeAdapter({ baseUrl: BASE, storageDir: STORE, sseIdleMs: 150 });
  const deletedConn = await fastIdleAdapter.attach(SESSION_NO_VARIANT.id);
  const streamStartsBeforeIdle = eventStreamStarts;
  let deletedMeta: any;
  let deletedError: any;
  const unsubDeleted = deletedConn.subscribe((m) => {
    if (m.type === 'metadata-update' && m.key === 'sessionInfo') deletedMeta = m;
    if (m.type === 'error') deletedError = m;
  });
  await waitFor(() => eventStreamStarts >= streamStartsBeforeIdle + 1, 3000);
  check('silent OpenCode SSE idle timeout reconnects instead of blocking forever', eventStreamStarts >= streamStartsBeforeIdle + 1, `starts=${eventStreamStarts} before=${streamStartsBeforeIdle}`);
  sendEvent({ type: 'session.deleted', properties: { sessionID: SESSION_NO_VARIANT.id } });
  await waitFor(() => deletedConn.info.attachMode === 'observe' && deletedConn.info.control?.drive.state === 'unavailable' && !!deletedMeta, 3000);
  const beforeDeletedPromptCount = promptBodies.length;
  let deletedPromptRejected = false;
  try {
    await deletedConn.sendPrompt?.({ text: 'SHOULD_NOT_REACH_AFTER_SESSION_DELETED' });
  } catch {
    deletedPromptRejected = true;
  }
  unsubDeleted();
  await deletedConn.close();
  check(
    'session.deleted downgrades only the deleted OpenCode session while server stays alive',
    deletedMeta?.value?.attachMode === 'observe' &&
      deletedConn.info.control?.drive.state === 'unavailable' &&
      /deleted/i.test(deletedError?.message ?? ''),
    `meta=${JSON.stringify(deletedMeta)} error=${JSON.stringify(deletedError)}`,
  );
  check(
    'deleted OpenCode session rejects direct prompts before HTTP send',
    deletedPromptRejected && promptBodies.length === beforeDeletedPromptCount,
    `rejected=${deletedPromptRejected} before=${beforeDeletedPromptCount} after=${promptBodies.length}`,
  );
  // issues-part2 item 5 re-flag: ONE abort surfaces on BOTH session.error and the aborted assistant
  // message's message.updated — the user must read exactly one "Interrupted by user." notice.
  const interruptNotices: any[] = [];
  const unsubInterrupt = conn.subscribe((m: any) => {
    if (m.type === 'notice' && /interrupted by user/i.test(m.message ?? '')) interruptNotices.push(m);
  });
  sendEvent({ type: 'session.error', properties: { sessionID: SESSION.id, error: { name: 'MessageAbortedError', data: { message: 'The message was aborted' } } } });
  sendEvent({
    type: 'message.updated',
    properties: { sessionID: SESSION.id, info: { id: 'msg_abort1', role: 'assistant', error: { name: 'MessageAbortedError', data: { message: 'The message was aborted' } } } },
  });
  await waitFor(() => interruptNotices.length >= 1, 4000);
  await new Promise((resolve) => setTimeout(resolve, 400)); // window for the duplicate branch to (wrongly) fire
  unsubInterrupt();
  check(
    'a user abort emits exactly one structured interruption notice',
    interruptNotices.length === 1
      && interruptNotices[0]?.semantic?.kind === 'interruption'
      && interruptNotices[0]?.semantic?.reason === 'user',
    JSON.stringify(interruptNotices),
  );

  let disconnectMeta: any;
  let disconnectError: any;
  const unsubDisconnect = conn.subscribe((m) => {
    if (m.type === 'metadata-update' && m.key === 'sessionInfo') disconnectMeta = m;
    if (m.type === 'error') disconnectError = m;
  });
  server.stop(true);
  serverStopped = true;
  await waitFor(() => conn.info.attachMode === 'observe' && conn.info.control?.terminalSync.active === false && !!disconnectMeta, 5000);
  unsubDisconnect();
  check(
    'shared-server disconnect downgrades OpenCode connection promptly at default reconnect window',
    conn.info.attachMode === 'observe' &&
      conn.info.status === 'idle' &&
      conn.info.control?.drive.state === 'unavailable' &&
      conn.info.control?.terminalSync.active === false,
    JSON.stringify(conn.info.control),
  );
  check(
    'shared-server disconnect emits sessionInfo metadata and an error notice',
    disconnectMeta?.value?.control?.terminalSync?.active === false && /disconnected/i.test(disconnectError?.message ?? ''),
    `meta=${JSON.stringify(disconnectMeta)} error=${JSON.stringify(disconnectError)}`,
  );
  await conn.close();
} finally {
  if (!serverStopped) server.stop(true);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
