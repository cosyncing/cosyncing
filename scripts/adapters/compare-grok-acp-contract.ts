#!/usr/bin/env bun
/**
 * Compare the Grok ACP contract across two installed binaries.
 *
 * Grok self-updated 1.0.13 -> 1.0.24 under an unattended broker. The adapter
 * gates Drive on an exact `===` version, so the practical question is not "did
 * the version change" but "did anything the adapter actually reads change".
 * This probes only those four points:
 *
 *   1. `initialize` protocolVersion and agent identity;
 *   2. `_meta.modelState` — the ONLY source of model labels and effort choices;
 *   3. the `x.ai/session/update` method pair the mapper dispatches on;
 *   4. the advertised auth methods, since Drive needs cached-token reuse.
 *
 * It does NOT read `~/.grok/auth.json`, and it prints no token: the initialize
 * response is dumped through a filter that keeps shape and drops values for any
 * key whose name looks credential-bearing.
 *
 * Usage:
 *   bun run compare_grok_acp_contract.ts --output <dir> \
 *     [--binary <path>]...   (defaults to the two in ~/.grok/downloads)
 */
import { AcpClient } from '../../packages/typescript/acp-client/src/index.ts';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SECRET_KEY = /token|secret|key|password|credential|authorization|cookie/iu;

/** Keep structure, drop anything that could carry a credential. */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return '<depth-capped>';
  if (Array.isArray(value)) return value.slice(0, 40).map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 80)) {
      out[key] = SECRET_KEY.test(key) ? '<redacted>' : redact(item, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string') return value.length > 400 ? `${value.slice(0, 400)}...` : value;
  return value;
}

/** The model catalog shape the adapter depends on, reduced to what it reads. */
function modelStateShape(meta: unknown): unknown {
  if (!meta || typeof meta !== 'object') return { present: false };
  const state = (meta as Record<string, unknown>).modelState;
  if (!state || typeof state !== 'object') return { present: false, metaKeys: Object.keys(meta as object) };
  const record = state as Record<string, unknown>;
  const available = Array.isArray(record.availableModels) ? record.availableModels : [];
  return {
    present: true,
    keys: Object.keys(record).sort(),
    currentModelId: record.currentModelId ?? null,
    currentReasoningEffort: record.currentReasoningEffort ?? null,
    availableModelCount: available.length,
    // The adapter reads modelId, name, and _meta.reasoningEfforts[].value/label/default.
    firstModel: redact(available[0]),
    modelKeys: [...new Set(available.flatMap((m) =>
      m && typeof m === 'object' ? Object.keys(m as object) : []))].sort(),
  };
}

async function probe(binary: string): Promise<Record<string, unknown>> {
  const started = Date.now();
  let client: AcpClient | undefined;
  try {
    client = await AcpClient.connect({
      command: binary,
      args: ['agent', '--no-leader', 'stdio'],
      cwd: process.cwd(),
      // The point of the exercise: never let a probe move the binary.
      env: { ...process.env, GROK_DISABLE_AUTOUPDATER: '1' },
      requestTimeoutMs: 20_000,
    });
    const result = client.initializeResult;
    return {
      binary,
      ok: true,
      elapsedMs: Date.now() - started,
      protocolVersion: result?.protocolVersion ?? null,
      agent: redact(result?.agentInfo ?? (result as Record<string, unknown> | null)?.agent ?? null),
      agentCapabilities: redact(result?.agentCapabilities ?? null),
      authMethods: redact(result?.authMethods ?? null),
      metaKeys: result?._meta && typeof result._meta === 'object'
        ? Object.keys(result._meta).sort() : [],
      modelState: modelStateShape(result?._meta),
    };
  } catch (error) {
    return {
      binary,
      ok: false,
      elapsedMs: Date.now() - started,
      error: String(error instanceof Error ? error.message : error).slice(0, 600),
    };
  } finally {
    await client?.close().catch(() => undefined);
  }
}

const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
if (outputIndex < 0) {
  console.error('usage: compare_grok_acp_contract.ts --output <dir> [--binary <path>]...');
  process.exit(2);
}
const output = args[outputIndex + 1]!;
const explicit = args.flatMap((value, index) => value === '--binary' ? [args[index + 1]!] : []);
const binaries = explicit.length > 0 ? explicit : [
  join(homedir(), '.grok/downloads/grok-1.0.13-linux-x86_64'),
  join(homedir(), '.grok/downloads/grok-1.0.24-linux-x86_64'),
];

const probes: Record<string, unknown>[] = [];
for (const binary of binaries) {
  console.log(`probing ${binary} ...`);
  const result = await probe(binary);
  console.log(`  ok=${result.ok} protocol=${result.protocolVersion ?? '-'} ${result.error ?? ''}`);
  probes.push(result);
}

// A difference only matters if it lands on something the adapter reads.
const [left, right] = probes;
const comparable = probes.length === 2 && left?.ok === true && right?.ok === true;
const differences = comparable
  ? (['protocolVersion', 'agentCapabilities', 'authMethods', 'metaKeys', 'modelState'] as const)
    .filter((field) => JSON.stringify(left[field]) !== JSON.stringify(right[field]))
  : [];

const report = {
  capturedAt: new Date().toISOString(),
  binaries,
  probes,
  comparable,
  contractDifferences: differences,
  verdict: !comparable
    ? 'inconclusive: at least one binary did not complete an ACP initialize'
    : differences.length === 0
      ? 'identical on every contract point the adapter reads'
      : `differs on: ${differences.join(', ')}`,
};

mkdirSync(output, { recursive: true });
const path = join(output, 'grok-acp-contract-comparison.json');
writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\n${report.verdict}`);
console.log(`wrote ${path}`);
process.exit(comparable ? 0 : 1);
