#!/usr/bin/env bun
/** Optional storage scale campaign over isolated fixture state. No CI gate.
 * Seeds metadata by cloning one genuinely ingested artifact while the broker
 * is stopped; all records share its existing blob. No content hashes are made.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { startBroker, type Broker } from '../../e2e/harness/broker.ts';
import { PiBridgeSession } from '../../e2e/harness/fakes/pi-bridge-driver.ts';
const option = (name: string, fallback: string) => {
  const index = Bun.argv.indexOf(name);
  return index < 0 ? fallback : (Bun.argv[index + 1] ?? fallback);
};
const counts = option('--counts', '1000,10000').split(',').map(Number);
if (
  !counts.length ||
  counts.some((n) => !Number.isInteger(n) || n < 1 || n > 16384)
) {
  throw new Error('--counts must contain integers in 1..16384');
}
const out = resolve(
  option(
    '--out',
    'output/review/settings-storage-routes/performance/storage-scale.json'
  )
);
function resources(broker: Broker) {
  if (process.platform !== 'linux' || !broker.pid) return null;
  const root = `/proc/${broker.pid}`;
  const status = readFileSync(join(root, 'status'), 'utf8');
  return {
    rssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]),
    highWaterKiB: Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1]),
    descriptors: readdirSync(join(root, 'fd')).length,
  };
}
const results: unknown[] = [];
for (const count of counts) {
  const broker = await startBroker({
    name: `storage-scale-${count}`,
    env: (paths) => ({
      COSYNCING_CACHE_DIR: join(paths.root, 'cache'),
      COSYNCING_ARTIFACT_CACHE_MAX_RECORDS: '16384',
    }),
  });
  try {
    const cwd = join(broker.paths.root, 'workspace');
    mkdirSync(cwd);
    const file = join(cwd, 'shared.txt');
    writeFileSync(
      file,
      'One shared stored blob for the isolated scale campaign.'
    );
    const agent = await PiBridgeSession.open(broker.client(), { cwd });
    const sent = await agent.sendFile(file);
    if (sent.status !== 200)
      throw new Error(`Artifact setup failed: ${sent.status}`);
    await broker.stop({ keepState: true });
    const indexPath = join(
      broker.paths.root,
      'cache',
      'artifacts',
      'index.json'
    );
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    const original = index.records[0];
    if (!original) throw new Error('Artifact fixture did not persist');
    index.records = Array.from({ length: count }, (_, number) => {
      const artifactKey = `scale-${number}`;
      return {
        ...original,
        artifactKey,
        name: `${artifactKey}.txt`,
        key: [
          original.brokerSource,
          original.tool,
          original.sessionId,
          artifactKey,
        ].join('\0'),
      };
    });
    writeFileSync(indexPath, JSON.stringify(index));
    await broker.start();
    await agent.rehello();
    const client = broker.client();
    const stream = await client.attach('pi', agent.id, {
      artifactMode: 'reference',
    });
    try {
      await stream.waitForKind('history');
      let sequence = 0;
      const foreground = async () => {
        const samples = [];
        for (let round = 0; round < 20; round++) {
          const began = performance.now();
          if ((await client.get('/api/broker/health')).status !== 200)
            throw new Error('Health failed');
          const healthMs = performance.now() - began;
          const marker = `storage-live-${++sequence}`;
          const emitted = performance.now();
          await agent.events({ t: 'delta', key: marker, delta: marker });
          await stream.waitForMessage((message) => message?.delta === marker);
          samples.push({ healthMs, streamMs: performance.now() - emitted });
        }
        return samples;
      };
      const scan = async () => {
        const began = performance.now();
        const response = await client.post('/api/storage/scans');
        if (response.status !== 202)
          throw new Error(`Scan refused: ${response.status}`);
        let state = response.body;
        for (
          let attempt = 0;
          state.state === 'running' && attempt < 30;
          attempt++
        ) {
          state = (
            await client.get(`/api/storage/scans/${state.scanId}?waitMs=10000`)
          ).body;
        }
        if (state.state !== 'completed')
          throw new Error(`Scan failed: ${state.state}`);
        const inventory = (await client.get('/api/storage')).body;
        return { ms: performance.now() - began, inventory };
      };
      const before = resources(broker);
      const quietLatency = await foreground();
      const scans = [];
      for (let round = 0; round < 3; round++) {
        const [result, latency] = await Promise.all([scan(), foreground()]);
        const stored = result.inventory.categories.find(
          (category: any) => category.id === 'stored-files'
        );
        if (stored?.itemCount !== count)
          throw new Error(
            `Expected ${count} objects, got ${stored?.itemCount}`
          );
        scans.push({ ...result, latency, resources: resources(broker) });
      }
      const inventory = scans.at(-1)!.inventory;
      const page = await client.get(
        `/api/storage/items?inventoryId=${inventory.inventoryId}&category=stored-files`
      );
      if (page.status !== 200 || page.body.items.length > 100)
        throw new Error('Review page exceeded its bound');
      const plan = await client.post('/api/storage/cleanup-plans', {
        mode: 'stored-files',
        inventoryId: inventory.inventoryId,
        selectAll: true,
      });
      if (plan.status !== 201 || plan.body.itemCount !== count)
        throw new Error('Finite plan did not cover the inventory');
      const began = performance.now();
      const cleanup = async () => {
        const accepted = await client.post('/api/storage/cleanup-jobs', {
          planId: plan.body.planId,
          idempotencyKey: `scale-cleanup-${count}`,
        });
        if (accepted.status !== 202)
          throw new Error(`Cleanup refused: ${accepted.status}`);
        let job = accepted.body;
        for (
          let attempt = 0;
          ['pending', 'running'].includes(job.state) && attempt < 60;
          attempt++
        ) {
          job = (
            await client.get(
              `/api/storage/cleanup-jobs/${job.jobId}?waitMs=10000`
            )
          ).body;
        }
        if (
          job.state !== 'completed' ||
          job.failed !== 0 ||
          job.removed !== count
        ) {
          throw new Error(`Cleanup incomplete: ${JSON.stringify(job)}`);
        }
        return { ms: performance.now() - began, job };
      };
      const [removed, cleanupLatency] = await Promise.all([
        cleanup(),
        foreground(),
      ]);
      const empty = await scan();
      results.push({
        count,
        before,
        quietLatency,
        scans,
        pageItems: page.body.items.length,
        removed,
        cleanupLatency,
        after: resources(broker),
        empty,
      });
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(
        out,
        JSON.stringify(
          {
            measuredAt: new Date().toISOString(),
            results,
            limitations: [
              'Broker-only generated metadata fixture; no Flutter frames, mobile, or energy evidence.',
              'Three scans and one cleanup per size; timing is descriptive, not a nonregression gate.',
            ],
          },
          null,
          2
        )
      );
    } finally {
      stream.close();
    }
  } finally {
    await broker.stop();
  }
}
console.log(out);
