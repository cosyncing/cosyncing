import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { AgentId } from '../tests_traces/scenarios.ts';
import type { DiscoveredCapabilitiesFile } from './types.ts';
import { readJsonFile } from './read-json.ts';
import { normalizeOpenCodeOpenApiEndpoints } from './opencode-openapi.ts';

const ROOT = join(import.meta.dir, '..', '..', '..');

interface Args {
  agent: AgentId;
  openapi?: string;
  rpcTypes?: string;
  methods?: string;
  seed: string;
  writeOutput: string;
}

function parseArgs(argv: string[]): Args {
  const out: Partial<Args> = {
    agent: 'opencode',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--agent' && next) {
      out.agent = next as AgentId;
      i++;
    } else if (arg === '--openapi' && next) {
      out.openapi = next;
      i++;
    } else if (arg === '--rpc-types' && next) {
      out.rpcTypes = next;
      i++;
    } else if (arg === '--methods' && next) {
      out.methods = next;
      i++;
    } else if (arg === '--seed' && next) {
      out.seed = next;
      i++;
    } else if (arg === '--write-output' && next) {
      out.writeOutput = next;
      i++;
    } else {
      throw new Error(`unknown or incomplete argument: ${arg}`);
    }
  }
  if (out.agent !== 'opencode' && out.agent !== 'pi' && out.agent !== 'codex') throw new Error('discovery drift currently supports --agent opencode|pi|codex');
  out.seed ??= join(ROOT, `scripts/broker/capabilities/fixtures/${out.agent}/discovered.seed.json`);
  if (out.agent === 'opencode' && !out.openapi) throw new Error('--openapi is required for opencode drift');
  if (out.agent === 'pi' && !out.rpcTypes) throw new Error('--rpc-types is required for pi drift');
  if (out.agent === 'codex' && !out.methods) throw new Error('--methods is required for codex drift');
  out.writeOutput ??= join(ROOT, `output/capabilities/${out.agent}/fixture-drift`);
  return out as Args;
}

function displayPath(path: string): string {
  const rel = relative(ROOT, path);
  return rel && !rel.startsWith('..') && !rel.startsWith('/') ? rel : path;
}

function seedServerNativeIds(seed: DiscoveredCapabilitiesFile): Set<string> {
  const out = new Set<string>();
  for (const cap of seed.capabilities) {
    if (/^opencode:server:[A-Z]+:\//.test(cap.nativeId)) out.add(cap.nativeId);
  }
  return out;
}

function seedRpcNativeIds(seed: DiscoveredCapabilitiesFile): Set<string> {
  const out = new Set<string>();
  for (const cap of seed.capabilities) {
    if (/^pi:rpc:[\w:-]+$/.test(cap.nativeId)) out.add(cap.nativeId);
  }
  return out;
}

function normalizePiRpcCommands(text: string): Array<{ command: string; nativeId: string }> {
  const commands = new Set<string>();
  for (const match of text.matchAll(/type\s*:\s*['"]([\w:-]+)['"]/g)) {
    if (match[1]) commands.add(match[1]);
  }
  return [...commands].sort().map((command) => ({ command, nativeId: `pi:rpc:${command}` }));
}

function seedAppserverNativeIds(seed: DiscoveredCapabilitiesFile): Set<string> {
  const out = new Set<string>();
  for (const cap of seed.capabilities) {
    if (/^codex:appserver:[\w/-]+$/.test(cap.nativeId)) out.add(cap.nativeId);
  }
  return out;
}

/** Codex app-server drift source: a `{ methods: string[] }` snapshot of the ClientRequest method set
 *  (analogous to OpenCode's OpenAPI paths / Pi's RpcCommand union). Each `thread/fork`-shaped method
 *  maps to `codex:appserver:<method>`. */
function normalizeCodexAppServerMethods(text: string): Array<{ command: string; nativeId: string }> {
  const parsed = JSON.parse(text) as { methods?: unknown };
  const methods = Array.isArray(parsed.methods) ? parsed.methods.filter((m): m is string => typeof m === 'string') : [];
  return [...new Set(methods)].sort().map((command) => ({ command, nativeId: `codex:appserver:${command}` }));
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

export function runDiscoveryDrift(args: Args): void {
  const seed = readJsonFile<DiscoveredCapabilitiesFile>(args.seed);
  const discovered = args.agent === 'pi'
    ? normalizePiRpcCommands(readFileSync(args.rpcTypes!, 'utf8'))
    : args.agent === 'codex'
      ? normalizeCodexAppServerMethods(readFileSync(args.methods!, 'utf8'))
      : normalizeOpenCodeOpenApiEndpoints(JSON.parse(readFileSync(args.openapi!, 'utf8')));
  const seedIds = args.agent === 'pi' ? seedRpcNativeIds(seed) : args.agent === 'codex' ? seedAppserverNativeIds(seed) : seedServerNativeIds(seed);
  const liveIds = new Set(discovered.map((entry) => entry.nativeId));
  const sourceDrift = [
    ...discovered
      .filter((entry) => !seedIds.has(entry.nativeId))
      .map((entry) => ({ change: 'added' as const, reason: 'source-drift' as const, ...entry })),
    ...[...seedIds]
      .filter((nativeId) => !liveIds.has(nativeId))
      .sort()
      .map((nativeId) => {
        if (args.agent === 'pi') return { change: 'removed' as const, reason: 'source-drift' as const, command: nativeId.replace(/^pi:rpc:/, ''), nativeId };
        if (args.agent === 'codex') return { change: 'removed' as const, reason: 'source-drift' as const, command: nativeId.replace(/^codex:appserver:/, ''), nativeId };
        const [, , method, ...pathParts] = nativeId.split(':');
        return { change: 'removed' as const, reason: 'source-drift' as const, method: method ?? '', path: pathParts.join(':'), nativeId };
      }),
  ];
  const report = {
    schemaVersion: 1,
    agent: args.agent,
    version: seed.version,
    generatedAt: '2026-07-02T00:00:00.000Z',
    ...(args.openapi ? { openapi: displayPath(args.openapi) } : {}),
    ...(args.rpcTypes ? { rpcTypes: displayPath(args.rpcTypes) } : {}),
    ...(args.methods ? { methods: displayPath(args.methods) } : {}),
    seed: displayPath(args.seed),
    discoveredCount: discovered.length,
    sourceDrift,
  };
  write(join(args.writeOutput, 'discovery-drift.json'), JSON.stringify(report, null, 2) + '\n');
  write(
    join(args.writeOutput, 'discovery-drift.md'),
    [
      `# ${args.agent === 'pi' ? 'Pi' : args.agent === 'codex' ? 'Codex' : 'OpenCode'} discovery drift`,
      '',
      ...(args.openapi ? [`OpenAPI: ${displayPath(args.openapi)}`] : []),
      ...(args.rpcTypes ? [`RPC types: ${displayPath(args.rpcTypes)}`] : []),
      ...(args.methods ? [`App-server methods: ${displayPath(args.methods)}`] : []),
      `Seed: ${report.seed}`,
      '',
      '| Change | Native id |',
      '|---|---|',
      ...(sourceDrift.length ? sourceDrift.map((d) => `| ${d.change} | ${d.nativeId} |`) : ['| _none_ |  |']),
      '',
    ].join('\n'),
  );
  console.log(`Discovery drift: ${sourceDrift.length} change(s)`);
  console.log(`report: ${join(args.writeOutput, 'discovery-drift.json')}`);
}

if (import.meta.main) {
  try {
    runDiscoveryDrift(parseArgs(process.argv.slice(2)));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
