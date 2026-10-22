#!/usr/bin/env bun
/** Optional matched broker transfer campaign. No timing assertions or CI task.
 * Run from the root with --baseline-source <frozen checkout> --rounds 20.
 * Downloads are consumed incrementally; no body copy or checksum is collected.
 */
import { mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { startBroker, type Broker } from "../../e2e/harness/broker.ts";
import type { SessionStream } from "../../e2e/harness/client.ts";
import { PiBridgeSession } from "../../e2e/harness/fakes/pi-bridge-driver.ts";

const option = (name: string, fallback: string) => {
  const index = Bun.argv.indexOf(name);
  return index < 0 ? fallback : (Bun.argv[index + 1] ?? fallback);
};
const baseline = option("--baseline-source", "");
if (!baseline) throw new Error("--baseline-source is required");
const rounds = Number(option("--rounds", "20"));
const bytes = Number(option("--bytes", String(32 * 1024 * 1024)));
if (
  !Number.isInteger(rounds) ||
  rounds < 3 ||
  rounds > 100 ||
  !Number.isInteger(bytes) ||
  bytes % 2 !== 0 ||
  bytes < 4096 ||
  bytes > 256 * 1024 * 1024
) {
  throw new Error(
    "Use 3..100 rounds and an even byte count in 4096..268435456",
  );
}
const out = resolve(
  option(
    "--out",
    "output/review/settings-storage-routes/performance/transfers.json",
  ),
);
type Run = {
  name: string;
  source: string;
  runtime: { path: string; version: string };
  broker: Broker;
  stream: SessionStream;
  agent: PiBridgeSession;
  url: string;
  samples: Record<string, unknown>[];
};
function resources(broker: Broker) {
  if (process.platform !== "linux" || !broker.pid) return null;
  const root = `/proc/${broker.pid}`;
  const status = readFileSync(join(root, "status"), "utf8");
  const fields = readFileSync(join(root, "stat"), "utf8")
    .split(") ")
    .at(-1)!
    .split(" ");
  return {
    rssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]),
    highWaterKiB: Number(status.match(/^VmHWM:\s+(\d+)/m)?.[1]),
    userTicks: Number(fields[11]),
    systemTicks: Number(fields[12]),
    descriptors: readdirSync(join(root, "fd")).length,
  };
}
async function setup(name: string, source: string): Promise<Run> {
  // A runtime upgrade is part of the candidate. An explicit baseline runtime
  // measures the full before/after change; omitting it isolates source changes.
  const runtimePath = resolve(option(`--${name}-runtime`, process.execPath));
  const version = Bun.spawnSync([runtimePath, '--version'], { stdout: 'pipe', stderr: 'pipe' });
  if (version.exitCode !== 0) throw new Error(`Cannot identify ${name} runtime`);
  const runtime = { path: runtimePath, version: version.stdout.toString().trim() };
  const broker = await startBroker({
    name: `storage-transfer-${name}`,
    sourceDirectory: source,
    setup: (paths) => symlinkSync(runtimePath, join(paths.bin, 'bun')),
  });
  try {
    if (process.platform === 'linux' &&
        realpathSync(`/proc/${broker.pid}/exe`) !== realpathSync(runtimePath)) {
      throw new Error(`${name} broker did not use its selected runtime`);
    }
    const cwd = join(broker.paths.root, "workspace");
    mkdirSync(cwd);
    const file = join(cwd, "large.bin");
    writeFileSync(file, Buffer.alloc(bytes, 97));
    const agent = await PiBridgeSession.open(broker.client(), {
      cwd,
      title: "Transfer benchmark",
    });
    const stream = await broker
      .client()
      .attach("pi", agent.id, { artifactMode: "reference" });
    await stream.waitForKind("history");
    const sent = await agent.sendFile(file);
    if (sent.status !== 200)
      throw new Error(`Fixture delivery failed (${sent.status})`);
    const artifact = await stream.waitForMessage(
      (message) =>
        message?.type === "file-artifact" && message.name === "large.bin",
    );
    return {
      name,
      source,
      runtime,
      broker,
      stream,
      agent,
      url: new URL(artifact.fetchUrl, broker.url).href,
      samples: [],
    };
  } catch (error) {
    await broker.stop();
    throw error;
  }
}
async function download(run: Run, range?: string) {
  const began = performance.now();
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(run.url, {
      headers: range ? { range } : undefined,
      signal: controller.signal,
    });
    if (response.status !== (range ? 206 : 200))
      throw new Error(`Download failed (${response.status})`);
    const reader = response.body!.getReader();
    let received = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      received += chunk.value.byteLength;
    }
    const expected = range ? bytes / 2 : bytes;
    if (received !== expected)
      throw new Error(`Expected ${expected} bytes, received ${received}`);
    return {
      milliseconds: performance.now() - began,
      bytes: received,
      contentLength: response.headers.get("content-length"),
    };
  } finally {
    clearTimeout(deadline);
    controller.abort();
  }
}
async function sample(run: Run, round: number) {
  await run.agent.events({ t: "status", running: false });
  const before = resources(run.broker);
  const health = async () => {
    const samples: number[] = [];
    for (let index = 0; index < 20; index++) {
      const began = performance.now();
      const response = await run.broker.client().get("/api/broker/health");
      if (response.status !== 200)
        throw new Error(`Health failed (${response.status})`);
      samples.push(performance.now() - began);
    }
    return samples;
  };
  const [full, healthMs] = await Promise.all([download(run), health()]);
  const ranged = await download(run, `bytes=0-${bytes / 2 - 1}`);
  const marker = `transfer-round-${round}`;
  const began = performance.now();
  await run.agent.events({ t: "delta", key: marker, delta: marker });
  await run.stream.waitForMessage((message) => message?.delta === marker);
  return {
    round,
    full,
    ranged,
    healthMs,
    streamMs: performance.now() - began,
    before,
    after: resources(run.broker),
  };
}
const runs: Run[] = [];
try {
  runs.push(await setup("baseline", resolve(baseline)));
  runs.push(
    await setup("candidate", resolve(option("--candidate-source", "."))),
  );
  for (const run of runs) await sample(run, -1);
  for (let index = 0; index < rounds; index++) {
    for (const [order, run] of (index % 2
      ? [...runs].reverse()
      : runs
    ).entries()) {
      run.samples.push({ ...(await sample(run, index)), order });
    }
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(
    out,
    JSON.stringify(
      {
        measuredAt: new Date().toISOString(),
        bun: Bun.version,
        bytes,
        rounds,
        runs: runs.map(({ name, source, runtime, samples }) => ({
          name,
          source,
          runtime,
          samples,
        })),
        limitations: [
          "Loopback Direct transport only.",
          "No Flutter UI, native proxy, mobile or energy measurements.",
          "CPU ticks are OS counters; timing includes the fixture client.",
        ],
      },
      null,
      2,
    ),
  );
  console.log(out);
} catch (error) {
  mkdirSync(dirname(out), { recursive: true });
  for (const run of runs) {
    writeFileSync(`${out}.${run.name}.failure.log`, run.broker.output());
  }
  throw error;
} finally {
  for (const run of runs) {
    run.stream.close();
    await run.broker.stop();
  }
}
