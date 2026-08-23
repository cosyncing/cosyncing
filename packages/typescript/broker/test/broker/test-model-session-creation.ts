#!/usr/bin/env bun
/**
 * Revision-8 pre-session model contract: generic catalog, immediate creation,
 * scheduled creation, retirement rejection, and revision-7 writable overlap.
 *
 * Scheduled delivery starts only a local fake Claude process. No real agent,
 * provider request, or paid model turn is used.
 */
import { strict as assert } from "node:assert";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isolatedBrokerFixtureEnvironment,
  reserveLoopbackFixturePort,
  waitForBrokerHealth,
} from "../helpers/isolated-broker-fixture.ts";
import { BROKER_CONTRACT } from "../../../protocol/src/index.ts";

type RunningBroker = {
  base: string;
  broker: Bun.Subprocess;
  creationDir: string;
  claudeConfigDir: string;
  deliveryMarker: string;
  opencodeServer: ReturnType<typeof Bun.serve>;
  opencodeCreates: Array<Record<string, unknown>>;
};

const token = "model-session-creation-token";

async function spawnBroker(root: string): Promise<RunningBroker> {
  const creationDir = join(root, "creation-directory");
  const config = join(root, "claude-config");
  const bin = join(root, "bin");
  const deliveryMarker = join(root, "claude-delivery.jsonl");
  mkdirSync(creationDir, { recursive: true });
  mkdirSync(config, { recursive: true });
  mkdirSync(bin, { recursive: true });
  const fakeClaude = join(bin, "claude");
  writeFileSync(
    fakeClaude,
    `#!/usr/bin/env bun
import { appendFileSync } from 'node:fs';
const marker = ${JSON.stringify(deliveryMarker)};
appendFileSync(marker, JSON.stringify({ kind: 'argv', argv: process.argv.slice(2) }) + '\\n');
const decoder = new TextDecoder();
let buffer = '';
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk, { stream: true });
  let newline;
  while ((newline = buffer.indexOf('\\n')) !== -1) {
    const raw = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (raw) appendFileSync(marker, JSON.stringify({ kind: 'stdin', value: JSON.parse(raw) }) + '\\n');
  }
}
`,
  );
  chmodSync(fakeClaude, 0o755);

  const opencodeCreates: Array<Record<string, unknown>> = [];
  const opencodeServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (path === "/provider") {
        return Response.json({
          connected: ["test-provider"],
          all: [
            {
              id: "test-provider",
              name: "Test provider",
              models: {
                "test-model": {
                  id: "test-model",
                  name: "Test model",
                },
              },
            },
          ],
        });
      }
      if (path === "/session" && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        opencodeCreates.push(body);
        if (body.model != null || body.variant != null) {
          return Response.json({ _tag: "BadRequest" }, { status: 400 });
        }
        const now = Date.now();
        return Response.json({
          id: `fake-opencode-${opencodeCreates.length}`,
          title: typeof body.title === "string" ? body.title : "New session",
          directory: url.searchParams.get("directory") ?? creationDir,
          time: { created: now, updated: now },
        });
      }
      if (path === "/session") return Response.json([]);
      if (path === "/session/status") return Response.json({});
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });

  // Leased from the kernel rather than derived from the pid. `40000 + pid %
  // 1000` is unique per process but not per *host*: two concurrent runs whose
  // pids are 1000 apart pick the same number, and the derivation is unowned in
  // between — nothing stops an unrelated process from holding it.
  const portLease = await reserveLoopbackFixturePort();
  const port = portLease.port;
  await portLease.release();
  const broker = Bun.spawn(["bun", "packages/typescript/broker/src/main.ts"], {
    cwd: process.cwd(),
    env: isolatedBrokerFixtureEnvironment(root, {
      overrides: {
        CLAUDE_CONFIG_DIR: config,
        COSYNCING_CLAUDE_BIN: fakeClaude,
        PATH: `${bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        PORT: String(port),
        HOST: "127.0.0.1",
        COSYNCING_HOME: join(root, "cosyncing-home"),
        COSYNCING_TOKEN: token,
        COSYNCING_MACHINE: "model-session-creation-test",
        COSYNCING_DEV_MODE: "1",
        COSYNCING_OPENCODE_NO_AUTOSERVE: "1",
        OPENCODE_URL: `http://127.0.0.1:${opencodeServer.port}`,
      },
    }),
    stdout: "ignore",
    stderr: "ignore",
  });
  const base = `http://127.0.0.1:${port}`;
  // Readiness gets no wall-clock budget of its own: a broker booting beside
  // other suites is slow, not broken, and the fixed 10s here was really a
  // claim about how fast the host is.
  try {
    await waitForBrokerHealth(broker, `${base}/api/health`);
    return {
      base,
      broker,
      creationDir,
      claudeConfigDir: config,
      deliveryMarker,
      opencodeServer,
      opencodeCreates,
    };
  } catch (error) {
    broker.kill();
    await broker.exited.catch(() => undefined);
    opencodeServer.stop(true);
    assert.fail(`broker starts for model session-creation test: ${(error as Error).message}`);
  }
}

async function request(
  base: string,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-cosyncing-token": token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json().catch(() => ({})),
  };
}

async function waitForSchedule(
  base: string,
  id: string,
  predicate: (schedule: any) => boolean,
): Promise<any> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request(base, "/api/schedules");
    const schedule = response.body.schedules?.find(
      (candidate: any) => candidate.id === id,
    );
    if (schedule && predicate(schedule)) return schedule;
    await Bun.sleep(50);
  }
  assert.fail(`schedule ${id} did not reach the expected outcome`);
}

function deliveryRecords(path: string): any[] {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function waitForDeliveryRecords(path: string): Promise<any[]> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const records = deliveryRecords(path);
    if (
      records.some((record) => record.kind === "argv") &&
      records.some(
        (record) => record.kind === "stdin" && record.value?.type === "user",
      )
    ) {
      return records;
    }
    await Bun.sleep(20);
  }
  assert.fail("fake Claude did not record the scheduled delivery");
}

const root = mkdtempSync(join(tmpdir(), "cosyncing-model-create-"));
let running: RunningBroker | undefined;
try {
  running = await spawnBroker(root);
  const agents = await request(running.base, "/api/agents");
  assert.equal(agents.status, 200);
  assert.equal(
    agents.body.find((agent: any) => agent.id === "claude")
      ?.canSelectModelAtCreation,
    true,
    "agent roster advertises pre-session model selection capability",
  );
  const catalog = await request(running.base, "/api/agents/claude/models");
  assert.equal(catalog.status, 200, "generic capability catalog loads");
  assert.equal(catalog.body.tool, "claude");
  const opus = catalog.body.models.filter(
    (model: any) =>
      model.providerID === "anthropic" && model.modelID === "opus",
  );
  assert.equal(opus.length, 1, "Claude alias has one selectable identity");
  assert.equal(opus[0].label, "Opus", "Claude alias label is version-neutral");
  assert.equal(typeof catalog.body.refreshedAt, "number");

  const openCodeCatalog = await request(
    running.base,
    "/api/agents/opencode/models",
  );
  assert.equal(openCodeCatalog.status, 200, "OpenCode model catalog loads");
  const openCodeModel = openCodeCatalog.body.models.find(
    (model: any) =>
      model.providerID === "test-provider" &&
      model.modelID === "test-model",
  );
  assert.ok(openCodeModel, "OpenCode catalog exposes the fake model");
  const openCodeCreate = await request(
    running.base,
    "/api/sessions/opencode",
    "POST",
    {
      directory: running.creationDir,
      title: "Selected OpenCode model",
      model: openCodeModel,
    },
  );
  assert.equal(
    openCodeCreate.status,
    200,
    "OpenCode selected-model create omits prompt-only fields from POST /session",
  );
  assert.deepEqual(
    openCodeCreate.body.session.currentModel,
    {
      providerID: "test-provider",
      modelID: "test-model",
    },
    "OpenCode selected model remains available for the first prompt",
  );
  assert.equal(
    openCodeCreate.body.attachMode,
    "live",
    "a live-only create returns an explicit foreground attach instruction",
  );
  assert.deepEqual(
    running.opencodeCreates,
    [{ title: "Selected OpenCode model" }],
    "OpenCode native create receives only session-creation fields",
  );

  const selected = {
    providerID: "anthropic",
    modelID: "opus",
    reasoningEffort: "high",
  };
  const immediate = await request(
    running.base,
    "/api/sessions/claude",
    "POST",
    { directory: running.creationDir, title: "Selected Opus", model: selected },
  );
  assert.equal(
    immediate.status,
    200,
    "immediate selected-model create succeeds",
  );
  assert.deepEqual(
    immediate.body.session.currentModel,
    // The adapter authors the roster label from its own catalog; the selection
    // itself (provider, id, effort) must arrive exactly as sent.
    { ...selected, label: "Opus" },
    "exact immediate selection reaches the adapter",
  );

  const defaultCreate = await request(
    running.base,
    "/api/sessions/claude",
    "POST",
    { directory: running.creationDir, title: "Tool default" },
  );
  assert.equal(defaultCreate.status, 200, "tool-default create remains valid");
  assert.equal(
    defaultCreate.body.session.currentModel,
    undefined,
    "tool-default create does not invent a selection",
  );

  const scheduled = await request(running.base, "/api/schedules", "POST", {
    kind: "new-session",
    tool: "claude",
    directory: running.creationDir,
    text: "future prompt",
    at: Date.now() + 3_600_000,
    model: selected,
  });
  assert.equal(
    scheduled.status,
    201,
    "scheduled selected-model create succeeds",
  );
  assert.deepEqual(
    scheduled.body.schedule.model,
    selected,
    "scheduled record preserves the exact optional model",
  );
  const runAvailable = await request(
    running.base,
    `/api/schedules/${scheduled.body.schedule.id}/actions`,
    "POST",
    {
      action: "run-now",
      expectedRevision: scheduled.body.schedule.revision,
    },
  );
  assert.equal(runAvailable.status, 200, "available schedule starts now");
  const delivered = await waitForSchedule(
    running.base,
    scheduled.body.schedule.id,
    (schedule) => schedule.lastOutcome === "delivered",
  );
  assert.equal(delivered.lastOutcome, "delivered");
  const deliveredRecords = await waitForDeliveryRecords(running.deliveryMarker);
  const deliveredArgv = deliveredRecords.find(
    (record) => record.kind === "argv",
  )?.argv;
  const deliveredPrompt = deliveredRecords.find(
    (record) => record.kind === "stdin" && record.value?.type === "user",
  )?.value;
  assert.equal(
    deliveredArgv?.[deliveredArgv.indexOf("--model") + 1],
    "opus",
    "scheduled delivery launches the exact selected Claude alias",
  );
  assert.equal(
    deliveredArgv?.[deliveredArgv.indexOf("--effort") + 1],
    "high",
    "scheduled delivery launches the exact selected effort",
  );
  assert.equal(
    deliveredPrompt?.message?.content?.[0]?.text,
    "future prompt",
    "scheduled prompt reaches the selected adapter",
  );

  const retireAtDelivery = await request(
    running.base,
    "/api/schedules",
    "POST",
    {
      kind: "new-session",
      tool: "claude",
      directory: running.creationDir,
      text: "must be blocked after retirement",
      at: Date.now() + 3_600_000,
      model: selected,
    },
  );
  assert.equal(retireAtDelivery.status, 201);
  writeFileSync(
    join(running.claudeConfigDir, ".claude.json"),
    JSON.stringify({
      cachedGrowthBookFeatures: {
        "tengu-model-error-overrides": {
          "claude-opus-5": { block: "retired in test" },
        },
      },
    }),
  );
  const markerCountBeforeRetirement = deliveryRecords(
    running.deliveryMarker,
  ).length;
  const runRetired = await request(
    running.base,
    `/api/schedules/${retireAtDelivery.body.schedule.id}/actions`,
    "POST",
    {
      action: "run-now",
      expectedRevision: retireAtDelivery.body.schedule.revision,
    },
  );
  assert.equal(runRetired.status, 200);
  const retiredAtDelivery = await waitForSchedule(
    running.base,
    retireAtDelivery.body.schedule.id,
    (schedule) => schedule.lastOutcome === "failed",
  );
  assert.match(
    retiredAtDelivery.lastError,
    /no longer available/,
    "delivery-time retirement is rejected without substitution",
  );
  assert.equal(
    deliveryRecords(running.deliveryMarker).length,
    markerCountBeforeRetirement,
    "retired selection never starts the adapter",
  );

  const temporarilyUnavailable = await request(
    running.base,
    "/api/schedules",
    "POST",
    {
      kind: "new-session",
      tool: "opencode",
      directory: running.creationDir,
      text: "must wait for catalog recovery",
      at: Date.now() + 3_600_000,
      model: {
        providerID: "test-provider",
        modelID: "test-model",
      },
    },
  );
  assert.equal(
    temporarilyUnavailable.status,
    201,
    "connected OpenCode model is accepted while its catalog is available",
  );
  running.opencodeServer.stop(true);
  const runUnavailable = await request(
    running.base,
    `/api/schedules/${temporarilyUnavailable.body.schedule.id}/actions`,
    "POST",
    {
      action: "run-now",
      expectedRevision: temporarilyUnavailable.body.schedule.revision,
    },
  );
  assert.equal(runUnavailable.status, 200);
  const unavailableAtDelivery = await waitForSchedule(
    running.base,
    temporarilyUnavailable.body.schedule.id,
    (schedule) => schedule.lastOutcome === "failed",
  );
  assert.match(
    unavailableAtDelivery.lastError,
    /fetch failed|unreachable|catalog|unable to connect|temporarily unavailable/i,
    "temporary readiness/catalog outage fails delivery distinctly from retirement",
  );
  assert.doesNotMatch(
    unavailableAtDelivery.lastError,
    /no longer available/i,
    "catalog outage is not mislabeled as a retired selection",
  );

  const retired = { providerID: "anthropic", modelID: "retired-alias" };
  const retiredImmediate = await request(
    running.base,
    "/api/sessions/claude",
    "POST",
    { directory: running.creationDir, model: retired },
  );
  assert.equal(retiredImmediate.status, 409);
  assert.equal(
    retiredImmediate.body.code,
    "MODEL_SELECTION_UNSUPPORTED",
    "immediate retired selection is rejected without substitution",
  );
  const retiredScheduled = await request(
    running.base,
    "/api/schedules",
    "POST",
    {
      kind: "new-session",
      tool: "claude",
      text: "must not substitute",
      at: Date.now() + 3_600_000,
      model: retired,
    },
  );
  assert.equal(retiredScheduled.status, 409);
  assert.equal(
    retiredScheduled.body.code,
    "MODEL_SELECTION_UNSUPPORTED",
    "scheduled retired selection is rejected without substitution",
  );

  // Revision 16 raises the WebSocket client floor, but this request body is
  // unchanged and remains accepted through the REST compatibility window. The
  // eventual stream hello is what declares the stale client read-only.
  const previousRevisionQuery =
    "contractRevision=15&minimumBrokerRevision=2&" +
    "contractSurfaceHash=fnv1a32%3A095f3c3c&clientVersion=0.9.9";
  const previousRevision = await request(
    running.base,
    `/api/sessions/claude?${previousRevisionQuery}`,
    "POST",
    { directory: running.creationDir },
  );
  assert.equal(BROKER_CONTRACT.revision, 16);
  assert.equal(
    previousRevision.status,
    200,
    "previous-revision REST request body remains writable",
  );

  console.log(
    "PASS model catalog and immediate/scheduled session creation contract",
  );
} finally {
  if (running) {
    running.broker.kill();
    await running.broker.exited.catch(() => undefined);
    try {
      running.opencodeServer.stop(true);
    } catch {
      // The temporary-unavailability case intentionally stopped it already.
    }
  }
  rmSync(root, { recursive: true, force: true });
}
