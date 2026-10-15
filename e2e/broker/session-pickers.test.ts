/**
 * Session pickers: when the app opens a session, the broker sends the model, agent and mode
 * pickers the agent offers (`options` frames), and keeps them right while the session stays open.
 *
 * The recurring failure this guards: a newly created session showed no model picker until its first
 * message, because one slow or failing catalog (models from a serve that is still starting) blanked
 * the whole frame. Each picker now stands alone, and the broker retries on a bounded ladder,
 * resending only a catalog that changed — including a change that keeps the same number of entries.
 *
 * The agent is an OpenCode server the test controls; it holds every model-catalog read until the
 * test answers it, so the test decides exactly what each attempt of the ladder sees. The ladder's
 * delays are shortened (`COSYNCING_TEST_SESSION_OPTIONS_RETRY_MS`); its length is the product's.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { type Broker, type BrokerClient, type Frame, type SessionStream, startBroker } from '../harness/index.ts';
import { CATALOG_PROVIDER, type FakeOpenCodeCatalog, startFakeOpenCodeCatalog } from '../harness/fakes/opencode-catalog.ts';

const BUILD = { name: 'build', description: 'Build things' };

function options(stream: SessionStream): Frame[] {
  return stream.ofKind('options');
}

function modelLabels(frame: Frame): string[] {
  return frame.models.map((model: any) => `${model.providerID}/${model.modelID}: ${model.label}`);
}

describe('session pickers', () => {
  let broker: Broker;
  let client: BrokerClient;
  let opencode: FakeOpenCodeCatalog;
  let workspace: string;

  beforeAll(async () => {
    broker = await startBroker({
      name: 'pickers',
      setup: (paths) => {
        workspace = join(paths.home, 'project');
        mkdirSync(workspace, { recursive: true });
        opencode = startFakeOpenCodeCatalog(workspace, { agents: [BUILD] });
      },
      env: () => ({ OPENCODE_URL: opencode.url, COSYNCING_TEST_SESSION_OPTIONS_RETRY_MS: '1,1,1,1' }),
    });
    client = broker.client();
  });
  afterAll(async () => {
    client?.closeAll();
    await broker?.stop();
    opencode?.stop();
  });

  test('a new session gets its agent picker at once and its model picker on retry, with no first message', async () => {
    const created = await client.post('/api/sessions/opencode', { directory: workspace, title: 'Fresh session' });
    expect(created.status).toBe(200);
    opencode.holdCatalogReads();
    const stream = await client.attach('opencode', created.body.session.id, { mode: created.body.attachMode });

    // The model catalog fails (the serve is still loading it): the agent picker is sent anyway.
    (await opencode.nextCatalogRead()).answer(500);
    const first = await stream.waitForKind('options');
    expect(first.models).toEqual([]);
    expect(first.agents).toEqual([BUILD]);

    // The next attempt of the ladder finds the models; the pickers fill in on the open session.
    (await opencode.nextCatalogRead()).answer([{ id: 'test-model', name: 'Test model' }]);
    const second = await stream.waitForFrame((frame) => frame.kind === 'options' && frame.models.length > 0, { what: 'the model picker' });
    expect(second.models.map((model: any) => [model.providerID, model.modelID])).toEqual([[CATALOG_PROVIDER, 'test-model']]);
    expect(second.agents).toEqual([BUILD]);

    // Same number of models, different meaning: resent. Identical: not resent. Changed again: resent.
    (await opencode.nextCatalogRead()).answer([{ id: 'test-model', name: 'Test model, renamed' }]);
    const renamed = await stream.waitForFrame((frame) => frame.kind === 'options' && modelLabels(frame).some((label) => label.includes('renamed')), {
      what: 'the renamed model',
    });
    expect(renamed.models).toHaveLength(1);
    (await opencode.nextCatalogRead()).answer([{ id: 'test-model', name: 'Test model, renamed' }]);
    (await opencode.nextCatalogRead()).answer([{ id: 'test-model', name: 'Test model, renamed' }, { id: 'second-model', name: 'Second model' }]);
    await stream.waitForFrame((frame) => frame.kind === 'options' && frame.models.length === 2, { what: 'the added model' });
    // Each frame follows the one before on the socket: the identical attempt sent nothing.
    expect(options(stream).map((frame) => frame.models.length)).toEqual([0, 1, 1, 2]);
    stream.close();
  });

  test('a failing agent list does not blank the model picker', async () => {
    opencode.holdCatalogReads(false);
    opencode.setModels([{ id: 'test-model', name: 'Test model' }]);
    opencode.setAgents(503);
    try {
      const stream = await client.attach('opencode', opencode.sessionId);
      const frame = await stream.waitForFrame((candidate) => candidate.kind === 'options' && candidate.models.length > 0, { what: 'the model picker' });
      expect(frame.agents).toEqual([]);
      expect(frame.models.map((model: any) => model.modelID)).toEqual(['test-model']);
      stream.close();
    } finally {
      opencode.setAgents([BUILD]);
    }
  });
});
