#!/usr/bin/env bun
/**
 * PERMANENT regression guard (issues-part2 re-flag, recurring): "no model selection for a newly
 * created session — only after the first message".
 *
 * Root shape: the attach path collected models/agents/modes with one `Promise.all`; a SINGLE
 * rejecting surface (codex `model/list` timing out while the daemon spawns the just-created thread,
 * a managed opencode serve still booting) rejected the whole combine, the caller swallowed it, and
 * the socket never got an options frame — pickers dead until reattach. collectSessionOptions must
 * isolate surfaces and report all-empty as null so the attach path keeps retrying.
 */
import {
  collectSessionOptions,
  optionsChanged,
  refreshSessionOptions,
  sessionOptionsSignature,
  SESSION_OPTIONS_RETRY_DELAYS_MS,
} from '../../../../packages/typescript/broker/src/session-options.ts';

let failures = 0;
const check = (label: string, ok: boolean, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  — ${extra}` : ''}`);
  if (!ok) failures++;
};

const conn = (over: Record<string, unknown>): any => ({
  info: { id: 's', tool: 't' },
  getHistory: async () => [],
  subscribe: () => () => {},
  sendPrompt: async () => {},
  respondPermission: async () => {},
  close: async () => {},
  ...over,
});

// 1) one surface REJECTING must not blank the others (the recurring regression)
{
  const options = await collectSessionOptions(conn({
    listModels: async () => { throw new Error('daemon busy spawning the created thread'); },
    listAgents: async () => [{ name: 'build' }],
    listModes: async () => [{ value: 'ask' }],
  }));
  check('a rejecting listModels does not blank agents/modes', options !== null && options.agents.length === 1 && options.modes.length === 1);
}

// 2) models survive when the OTHER surfaces reject
{
  const options = await collectSessionOptions(conn({
    listModels: async () => [{ modelID: 'm1' }],
    listAgents: async () => { throw new Error('nope'); },
  }));
  check('models survive rejecting agents (and absent modes)', options !== null && options.models.length === 1);
}

// 3) all-empty → null so the attach path RETRIES (backing service still starting)
{
  const options = await collectSessionOptions(conn({ listModels: async () => [], listAgents: async () => [] }));
  check('all-empty reports null (caller retries)', options === null);
}

// 4) everything rejecting → null, never a throw (caller retry path must stay alive)
{
  const options = await collectSessionOptions(conn({
    listModels: async () => { throw new Error('x'); },
    listAgents: async () => { throw new Error('x'); },
    listModes: async () => { throw new Error('x'); },
  })).catch(() => 'THREW');
  check('total failure reports null, never throws', options === null);
}

// 5) the retry ladder is bounded, near-term first, and long enough to cover a serve restart (~20s)
check(
  'retry ladder is bounded (no infinite polling), near-term first, covers a serve restart',
  SESSION_OPTIONS_RETRY_DELAYS_MS.length >= 2 &&
    SESSION_OPTIONS_RETRY_DELAYS_MS.length <= 6 &&
    SESSION_OPTIONS_RETRY_DELAYS_MS[0]! <= 5000 &&
    SESSION_OPTIONS_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0) >= 20000,
);

// 6) partial frames: agents-only must be sendable AND must not satisfy the ladder — the recurring
//    opencode shape was "agent chip present, NO model selection" on a fresh session.
{
  const partial = await collectSessionOptions(conn({
    listModels: async () => { throw new Error('serve restarting'); },
    listAgents: async () => [{ name: 'build' }],
  }));
  check('agents-only partial is sendable (fast agent picker)', partial !== null && partial.models.length === 0);
  check('a first frame always sends', optionsChanged(partial!, null));
  const richer = await collectSessionOptions(conn({
    listModels: async () => [{ modelID: 'm1' }],
    listAgents: async () => [{ name: 'build' }],
  }));
  check('recovered models change the catalog → the richer frame resends', optionsChanged(richer!, partial));
  check('an identical result does not respam the socket', !optionsChanged(richer!, richer));
}

// 7) Same-length native catalogs can change in every meaningful dimension. CR3 originally lost
//    Ultra in this shape because the retry path compared only list counts.
{
  const base = {
    models: [{
      providerID: 'openai',
      modelID: 'gpt-5.6-sol',
      variant: 'default',
      label: 'GPT-5.6 Sol',
      description: 'Sol',
      reasoningEfforts: [{ effort: 'max', label: 'Max', description: 'Most reasoning' }],
      defaultReasoningEffort: 'max',
    }],
    agents: [{ name: 'default', description: 'Default agent' }],
    modes: [{ value: 'ask', label: 'Ask', description: 'Ask first', category: 'ask-permission' as const }],
  };
  const sameValue = {
    models: base.models.map((model) => ({
      ...model,
      reasoningEfforts: model.reasoningEfforts.map((effort) => ({ ...effort })),
    })),
    agents: base.agents.map((agent) => ({ ...agent })),
    modes: base.modes.map((mode) => ({ ...mode })),
  };
  check('semantic signature is stable across equivalent object instances', sessionOptionsSignature(base) === sessionOptionsSignature(sameValue));

  const changes = [
    { ...base, models: [{ ...base.models[0]!, modelID: 'gpt-5.6-terra' }] },
    { ...base, models: [{ ...base.models[0]!, providerID: 'azure-openai' }] },
    { ...base, models: [{ ...base.models[0]!, variant: 'fast' }] },
    { ...base, models: [{ ...base.models[0]!, description: 'Updated Sol' }] },
    { ...base, models: [{ ...base.models[0]!, defaultReasoningEffort: 'ultra' }] },
    {
      ...base,
      models: [{
        ...base.models[0]!,
        reasoningEfforts: [{
          effort: 'ultra',
          label: 'Ultra',
          description: 'Maximum reasoning with automatic task delegation',
        }],
      }],
    },
    { ...base, agents: [{ name: 'planner', description: 'Default agent' }] },
    { ...base, modes: [{ ...base.modes[0]!, value: 'full-access' }] },
  ];
  check(
    'same-count changes to model, effort, agent, and mode semantics resend',
    changes.every((changed) => optionsChanged(changed, base)),
  );
}

// 8) Caller-level attach refresh: a first non-empty model list is not necessarily complete.
//    Keep collecting through the bounded ladder, emit the same-count Ultra enrichment once, and
//    suppress every identical result that follows.
{
  let collections = 0;
  const maxOnly = [{
    providerID: 'openai',
    modelID: 'gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    reasoningEfforts: [{ effort: 'max', label: 'Max' }],
    defaultReasoningEffort: 'max',
  }];
  const withUltra = [{
    ...maxOnly[0]!,
    reasoningEfforts: [
      ...maxOnly[0]!.reasoningEfforts,
      {
        effort: 'ultra',
        label: 'Ultra',
        description: 'Maximum reasoning with automatic task delegation',
      },
    ],
  }];
  const frames: any[] = [];
  await refreshSessionOptions(
    conn({
      listModels: async () => {
        collections++;
        return collections === 1 ? maxOnly : withUltra;
      },
    }),
    (options) => frames.push(options),
    {
      delays: SESSION_OPTIONS_RETRY_DELAYS_MS,
      wait: async () => {},
    },
  );
  check(
    'attach refresh sends Sol/max then same-count Sol/max+ultra exactly once',
    frames.length === 2 &&
      frames[0]?.models.length === 1 &&
      frames[0]?.models[0]?.reasoningEfforts.length === 1 &&
      frames[1]?.models.length === 1 &&
      frames[1]?.models[0]?.reasoningEfforts.some((effort: any) => effort.effort === 'ultra'),
    `collections=${collections} frames=${frames.length}`,
  );
  check(
    'attach refresh stops after the bounded ladder without resending identical catalogs',
    collections === SESSION_OPTIONS_RETRY_DELAYS_MS.length + 1 && frames.length === 2,
    `collections=${collections} frames=${frames.length}`,
  );
}

// 9) Closing an attached socket aborts its refresh ladder. The runtime creates this signal when the
//    socket opens and aborts it on close; no later retry may retain/use the old ManagedConn.
{
  let collections = 0;
  const abort = new AbortController();
  const startedAt = Date.now();
  await refreshSessionOptions(
    conn({
      listModels: async () => {
        collections++;
        return [{ providerID: 'openai', modelID: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }];
      },
    }),
    () => {
      // Let refresh enter its real 10-second timer wait before simulating the
      // socket close. Abort must clear that timer and release the connection.
      queueMicrotask(() => abort.abort());
    },
    {
      delays: [10_000],
      signal: abort.signal,
    },
  );
  const elapsedMs = Date.now() - startedAt;
  check(
    'cancelling attach refresh clears its timer and prevents every later collection',
    collections === 1 && elapsedMs < 1000,
    `collections=${collections} elapsedMs=${elapsedMs}`,
  );
}

console.log(failures ? `\nFAIL: ${failures} check(s) failed.` : '\nAll session-options checks passed.');
process.exit(failures ? 1 : 0);
