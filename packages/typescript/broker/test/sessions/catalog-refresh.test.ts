/**
 * Narrow, kept on purpose: the races inside the picker refresh of one open session. They need
 * reads held and released at exact points relative to a native catalog notification or a socket
 * close, and the only adapter with native catalog notifications (DSH 0.2) has no e2e fake host.
 * The attach-time behaviour (one failing picker does not blank the others; the bounded ladder
 * resends only a changed catalog) is in e2e/broker/session-pickers.test.ts.
 */
import { expect, test } from 'bun:test';
import { refreshSessionOptions } from '../../src/sessions/session-options.ts';

const conn = (over: Record<string, unknown>): any => ({
  info: { id: 's', tool: 't' },
  getHistory: async () => [],
  subscribe: () => () => {},
  sendPrompt: async () => {},
  respondPermission: async () => {},
  close: async () => {},
  ...over,
});

const drain = async (turns = 60): Promise<void> => {
  for (let index = 0; index < turns; index += 1) await Promise.resolve();
};

test('a native catalog change updates the pickers and commands without reattach, until the socket closes', async () => {
  const controller = new AbortController();
  let changed: (() => void) | undefined;
  let stopped = 0;
  let model = 'before';
  let modes = ['ask'];
  let commands = ['goal'];
  let refuseModels = false;
  const options: any[] = [];
  const commandFrames: any[] = [];
  const refreshed = refreshSessionOptions(conn({
    listModels: async () => {
      if (refuseModels) throw new Error('model service transiently unavailable');
      return model ? [{ providerID: 'fixture', modelID: model, label: model }] : [];
    },
    listModes: async () => modes.map((value) => ({ value, label: value })),
    listCommands: async () => commands.map((name) => ({ name, description: name })),
  }), (value) => options.push(value), {
    delays: [],
    signal: controller.signal,
    watchChanges: (notify) => { changed = notify; return () => { stopped += 1; }; },
    sendCommands: (value) => commandFrames.push(value),
  });
  await drain();
  expect([Boolean(changed), stopped, options.length]).toEqual([true, 0, 1]);

  model = 'after';
  modes = ['read-only'];
  commands = ['compact'];
  changed?.();
  await drain();
  expect(options).toHaveLength(2);
  expect([options[1].models[0].modelID, options[1].modes[0].value]).toEqual(['after', 'read-only']);
  expect(commandFrames.map((frame) => frame[0]?.name)).toEqual(['goal', 'compact']);

  changed?.(); // nothing changed: nothing is sent
  await drain();
  expect([options.length, commandFrames.length]).toEqual([2, 2]);

  refuseModels = true; // a failing picker keeps what the app has; the healthy one updates
  modes = ['workspace-write'];
  changed?.();
  await drain();
  expect([options.at(-1).models[0].modelID, options.at(-1).modes[0].value]).toEqual(['after', 'workspace-write']);

  refuseModels = false; // an answered empty catalog retracts the entries
  model = '';
  modes = [];
  commands = [];
  changed?.();
  await drain();
  expect([options.at(-1).models.length, options.at(-1).modes.length, commandFrames.at(-1).length]).toEqual([0, 0, 0]);

  controller.abort();
  await refreshed;
  const sent = [options.length, commandFrames.length];
  changed?.();
  await drain();
  expect(stopped).toBe(1);
  expect([options.length, commandFrames.length]).toEqual(sent);
});

test('a change while a read is outstanding fences that read and coalesces the burst', async () => {
  const controller = new AbortController();
  let changed: (() => void) | undefined;
  let reads = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const options: any[] = [];
  const refreshed = refreshSessionOptions(conn({
    listModels: async () => {
      reads += 1;
      if (reads === 1) await held;
      return [{ providerID: 'fixture', modelID: reads === 1 ? 'obsolete' : 'current', label: 'model' }];
    },
  }), (value) => options.push(value), {
    delays: [],
    signal: controller.signal,
    watchChanges: (notify) => { changed = notify; return () => {}; },
  });
  await Promise.resolve();
  changed?.();
  changed?.();
  release();
  await drain(30);
  expect(options.map((frame) => frame.models[0].modelID)).toEqual(['current']);
  expect(reads).toBe(2);
  controller.abort();
  await refreshed;
});

test('a read that completes after the socket closed publishes nothing', async () => {
  const controller = new AbortController();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const options: any[] = [];
  let stopped = 0;
  const refreshed = refreshSessionOptions(conn({
    listModels: async () => { await held; return [{ providerID: 'fixture', modelID: 'late', label: 'model' }]; },
  }), (value) => options.push(value), {
    delays: [],
    signal: controller.signal,
    watchChanges: () => () => { stopped += 1; },
  });
  controller.abort();
  release();
  await refreshed;
  expect([options.length, stopped]).toEqual([0, 1]);

  // Closing while options are being delivered stops a later command frame too.
  const closing = new AbortController();
  const commands: any[] = [];
  let releaseCommands!: () => void;
  const heldCommands = new Promise<void>((resolve) => { releaseCommands = resolve; });
  await refreshSessionOptions(conn({
    listModels: async () => [{ providerID: 'fixture', modelID: 'model', label: 'Model' }],
    listCommands: async () => { await heldCommands; return [{ name: 'goal', description: 'Goal' }]; },
  }), () => { closing.abort(); releaseCommands(); }, {
    delays: [],
    signal: closing.signal,
    watchChanges: () => () => {},
    sendCommands: (value) => commands.push(value),
  });
  expect(commands).toEqual([]);
});

test('closing releases the refresh at once, without waiting for an optional read', async () => {
  const controller = new AbortController();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let stopped = 0;
  let finished = false;
  const commands: any[] = [];
  const refreshed = refreshSessionOptions(conn({ listCommands: async () => { await held; return [{ name: 'late' }]; } }), () => {}, {
    delays: [],
    signal: controller.signal,
    watchChanges: () => () => { stopped += 1; },
    sendCommands: (value) => commands.push(value),
  }).then(() => { finished = true; });
  controller.abort();
  await drain(40);
  expect([finished, stopped]).toEqual([true, 1]);
  release();
  await refreshed;
  await drain(40);
  expect(commands).toEqual([]);
});

test('closing during the ladder’s wait clears its timer and stops every later collection', async () => {
  let collections = 0;
  const abort = new AbortController();
  // Were the 10-second wait not cleared, this would outlive the test's own deadline.
  await refreshSessionOptions(conn({
    listModels: async () => {
      collections += 1;
      return [{ providerID: 'openai', modelID: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' }];
    },
  }), () => { queueMicrotask(() => abort.abort()); }, { delays: [10_000], signal: abort.signal });
  expect(collections).toBe(1);
});

test('a catalog change made while its own frame is delivered converges without a stale overwrite', async () => {
  const controller = new AbortController();
  let changed: (() => void) | undefined;
  let catalog = 'before';
  const commands: any[] = [];
  const options: any[] = [];
  const refreshed = refreshSessionOptions(conn({
    listModels: async () => [{ providerID: 'fixture', modelID: catalog, label: catalog }],
    listCommands: async () => [{ name: catalog, description: catalog }],
  }), (value) => {
    options.push(value);
    if (catalog === 'before') { catalog = 'after'; changed?.(); }
  }, {
    delays: [],
    signal: controller.signal,
    watchChanges: (notify) => { changed = notify; return () => {}; },
    sendCommands: (value) => commands.push(value),
  });
  await drain(50);
  const names = commands.map((frame) => frame[0]?.name);
  expect(options).toHaveLength(2);
  expect(names.at(-1)).toBe('after');
  expect(names.filter((name) => name === 'after')).toHaveLength(1);
  expect(names.slice(names.indexOf('after') + 1)).not.toContain('before');
  controller.abort();
  await refreshed;
});

for (const slow of ['commands', 'options'] as const) {
  test(`a pending ${slow} read never delays the other surface, and is fenced when it returns`, async () => {
    const controller = new AbortController();
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let changed: (() => void) | undefined;
    let version = 'before';
    const options: any[] = [];
    const commands: any[] = [];
    const refreshed = refreshSessionOptions(conn({
      listModels: async () => {
        const value = version;
        if (slow === 'options') await held;
        return [{ providerID: 'fixture', modelID: value, label: value }];
      },
      listCommands: async () => {
        const value = version;
        if (slow === 'commands') await held;
        return [{ name: value, description: value }];
      },
    }), (value) => options.push(value), {
      delays: [],
      signal: controller.signal,
      watchChanges: (notify) => { changed = notify; return () => {}; },
      sendCommands: (value) => commands.push(value),
    });
    await drain();
    const fast = slow === 'commands' ? options : commands;
    const deferred = slow === 'commands' ? commands : options;
    expect([fast.length, deferred.length]).toEqual([1, 0]);
    version = 'after';
    changed?.();
    await drain();
    expect([fast.length, deferred.length]).toEqual([2, 0]);
    release();
    await drain();
    expect(deferred).toHaveLength(1);
    expect(slow === 'commands' ? commands[0][0].name : options[0].models[0].modelID).toBe('after');
    controller.abort();
    await refreshed;
  });
}

test('a stalled command read cannot hold the bounded model retry ladder', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const options: any[] = [];
  let modelReads = 0;
  const refreshed = refreshSessionOptions(conn({
    listModels: async () => [{ providerID: 'fixture', modelID: String(++modelReads), label: 'Model' }],
    listCommands: async () => { await held; return []; },
  }), (value) => options.push(value), { delays: [1, 2], wait: async () => {}, sendCommands: () => {} });
  await drain(80);
  expect([modelReads, options.length]).toEqual([3, 3]);
  release();
  await refreshed;
});
