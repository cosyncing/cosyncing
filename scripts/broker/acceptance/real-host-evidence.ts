#!/usr/bin/env bun
/** Strict schema/validator for evidence collected on real hosts and a real same-tailnet client. */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type EvidenceStatus = 'pass' | 'limitation' | 'excluded' | 'fail' | 'skip';

export interface EvidenceClaim {
  status: EvidenceStatus;
  evidenceId?: string;
  note: string;
}

export interface RealHostEvidence {
  schemaVersion: 1;
  release: {
    version: string;
    sourceCommit: string;
    manifestSha256: string;
    publishedArtifact: boolean;
  };
  hosts: Record<string, { auditId: string; claims: Record<string, EvidenceClaim> }>;
  agents: Record<string, { auditId: string; claims: Record<string, EvidenceClaim> }>;
  client: { auditId: string; claims: Record<string, EvidenceClaim> };
  packagedClaudeHooksSurfaceAbsent: boolean;
  generatedAt: string;
}

export interface EvidenceValidation {
  ok: boolean;
  blockers: string[];
}

export interface EvidenceExpectations {
  version?: string;
  sourceCommit?: string;
  manifestSha256?: string;
}

export const HOST_REQUIREMENTS = Object.freeze({
  'linux-x64': [
    'artifact.install', 'doctor.before-after', 'setup.mutation-review', 'service.reboot-recovery',
    'tailscale.private-serve', 'client.pair', 'broker.roster', 'broker.observe', 'broker.take-over',
    'broker.file-exchange', 'release.upgrade', 'release.unhealthy-rollback', 'uninstall.machine-diff',
  ],
  'linux-arm64': [
    'artifact.install', 'doctor.before-after', 'setup.mutation-review', 'service.reboot-recovery',
    'tailscale.private-serve', 'client.pair', 'broker.roster', 'broker.observe', 'broker.take-over',
    'broker.file-exchange', 'release.upgrade', 'release.unhealthy-rollback', 'uninstall.machine-diff',
  ],
  'wsl-systemd': [
    'artifact.install', 'doctor.before-after', 'setup.mutation-review', 'service.terminate-recovery',
    'wsl.tailscale-topology', 'wsl.supported-network-operation', 'broker.operation', 'uninstall.machine-diff',
  ],
  'wsl-foreground': [
    'artifact.install', 'doctor.before-after', 'setup.mutation-review', 'foreground.restart',
    'wsl.tailscale-topology', 'wsl.supported-network-operation', 'broker.operation', 'uninstall.machine-diff',
  ],
} as const);

export const AGENT_REQUIREMENTS = Object.freeze({
  codex: {
    pass: ['managed-daemon.diagnosis', 'remote-tui.join', 'prompts.both-way', 'approval', 'question', 'reconnect', 'terminal.exit', 'runtime.safe-restart'],
  },
  opencode: {
    pass: ['managed-serve.diagnosis', 'attach', 'prompts.both-way', 'approval', 'reconnect'],
    limitation: ['bare-private-tui.adoption'],
  },
  pi: {
    pass: ['bridge.packaged-install', 'plain-tui.auto-load', 'bridge-join.immediate-typing', 'approval', 'broker.reregistration', 'uninstall.preserve-foreign-extension'],
  },
  claude: {
    pass: ['transcript.observe', 'take-over', 'drive.approval', 'drive.question'],
    excluded: ['hooks.answer-only'],
  },
} as const);

export const CLIENT_REQUIREMENTS = Object.freeze([
  'same-tailnet.scan-accept',
  'peer-token.reconnect',
  'peer-token.revoke',
  'encrypted-control',
]);

function claimBlocker(scope: string, id: string, claim: EvidenceClaim | undefined, expected: EvidenceStatus): string | undefined {
  if (!claim) return `${scope}.${id}: missing`;
  if (claim.status !== expected) return `${scope}.${id}: expected ${expected}, got ${claim.status}`;
  if (!claim.evidenceId?.trim()) return `${scope}.${id}: ${expected} has no evidenceId`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(claim.evidenceId)) {
    return `${scope}.${id}: evidenceId is not a safe opaque reference`;
  }
  if (!claim.note?.trim()) return `${scope}.${id}: note is empty`;
  if (claim.note.length > 500 || /[\r\n]/.test(claim.note)) return `${scope}.${id}: note is not a bounded single line`;
  return undefined;
}

function auditIdBlocker(scope: string, auditId: string | undefined): string | undefined {
  if (!auditId?.trim()) return `${scope}: missing auditId`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(auditId)) return `${scope}: auditId is not a safe opaque reference`;
  return undefined;
}

function exactKeysBlockers(scope: string, value: unknown, allowed: readonly string[]): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [`${scope}: malformed`];
  const permitted = new Set(allowed);
  return Object.keys(value)
    .filter((key) => !permitted.has(key))
    .map((key) => `${scope}.${key}: unexpected field`);
}

function claimShapeBlockers(scope: string, claim: unknown): string[] {
  return exactKeysBlockers(scope, claim, ['status', 'evidenceId', 'note']);
}

function containsCredentialShape(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsCredentialShape);
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (/(?:token|private.?key|authorization|credential|secret)/i.test(key)
        && typeof child === 'string' && child.trim()) return true;
    if (containsCredentialShape(child)) return true;
  }
  return false;
}

export function validateRealHostEvidence(
  value: unknown,
  expected: EvidenceExpectations = {},
): EvidenceValidation {
  const blockers: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ok: false, blockers: ['record: malformed'] };
  const record = value as Partial<RealHostEvidence>;
  blockers.push(...exactKeysBlockers('record', record, [
    'schemaVersion', 'release', 'hosts', 'agents', 'client',
    'packagedClaudeHooksSurfaceAbsent', 'generatedAt',
  ]));
  if (record.schemaVersion !== 1) blockers.push('record.schemaVersion: expected 1');
  blockers.push(...exactKeysBlockers('release', record.release, [
    'version', 'sourceCommit', 'manifestSha256', 'publishedArtifact',
  ]));
  if (!record.release || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(record.release.version ?? '')) {
    blockers.push('release.version: invalid');
  }
  if (!/^[a-f0-9]{40,64}$/.test(record.release?.sourceCommit ?? '')) blockers.push('release.sourceCommit: invalid');
  if (!/^[a-f0-9]{64}$/.test(record.release?.manifestSha256 ?? '')) blockers.push('release.manifestSha256: invalid');
  if (record.release?.publishedArtifact !== true) blockers.push('release.publishedArtifact: must be true');
  if (!record.generatedAt || !Number.isFinite(Date.parse(record.generatedAt))
      || new Date(record.generatedAt).toISOString() !== record.generatedAt) blockers.push('generatedAt: invalid');
  if (record.packagedClaudeHooksSurfaceAbsent !== true) blockers.push('packaged Claude hooks surface: must be absent');
  if (expected.version && record.release?.version !== expected.version) blockers.push('release.version: does not match candidate');
  if (expected.sourceCommit && record.release?.sourceCommit !== expected.sourceCommit) blockers.push('release.sourceCommit: does not match candidate');
  if (expected.manifestSha256 && record.release?.manifestSha256 !== expected.manifestSha256) {
    blockers.push('release.manifestSha256: does not match candidate');
  }

  blockers.push(...exactKeysBlockers('hosts', record.hosts, Object.keys(HOST_REQUIREMENTS)));
  for (const [lane, requirements] of Object.entries(HOST_REQUIREMENTS)) {
    const host = record.hosts?.[lane];
    blockers.push(...exactKeysBlockers(`hosts.${lane}`, host, ['auditId', 'claims']));
    blockers.push(...exactKeysBlockers(`hosts.${lane}.claims`, host?.claims, requirements));
    const auditBlocker = auditIdBlocker(`hosts.${lane}`, host?.auditId);
    if (auditBlocker) blockers.push(auditBlocker);
    for (const id of requirements) {
      blockers.push(...claimShapeBlockers(`hosts.${lane}.${id}`, host?.claims?.[id]));
      const blocker = claimBlocker(`hosts.${lane}`, id, host?.claims?.[id], 'pass');
      if (blocker) blockers.push(blocker);
    }
  }
  blockers.push(...exactKeysBlockers('agents', record.agents, Object.keys(AGENT_REQUIREMENTS)));
  for (const [agent, requirements] of Object.entries(AGENT_REQUIREMENTS)) {
    const result = record.agents?.[agent];
    blockers.push(...exactKeysBlockers(`agents.${agent}`, result, ['auditId', 'claims']));
    const auditBlocker = auditIdBlocker(`agents.${agent}`, result?.auditId);
    if (auditBlocker) blockers.push(auditBlocker);
    const byStatus = requirements as {
      pass?: readonly string[];
      limitation?: readonly string[];
      excluded?: readonly string[];
    };
    const claimIds = ['pass', 'limitation', 'excluded']
      .flatMap((status) => byStatus[status as keyof typeof byStatus] ?? []);
    blockers.push(...exactKeysBlockers(`agents.${agent}.claims`, result?.claims, claimIds));
    for (const expected of ['pass', 'limitation', 'excluded'] as const) {
      for (const id of byStatus[expected] ?? []) {
        blockers.push(...claimShapeBlockers(`agents.${agent}.${id}`, result?.claims?.[id]));
        const blocker = claimBlocker(`agents.${agent}`, id, result?.claims?.[id], expected);
        if (blocker) blockers.push(blocker);
      }
    }
  }
  blockers.push(...exactKeysBlockers('client', record.client, ['auditId', 'claims']));
  blockers.push(...exactKeysBlockers('client.claims', record.client?.claims, CLIENT_REQUIREMENTS));
  const clientAuditBlocker = auditIdBlocker('client', record.client?.auditId);
  if (clientAuditBlocker) blockers.push(clientAuditBlocker);
  for (const id of CLIENT_REQUIREMENTS) {
    blockers.push(...claimShapeBlockers(`client.${id}`, record.client?.claims?.[id]));
    const blocker = claimBlocker('client', id, record.client?.claims?.[id], 'pass');
    if (blocker) blockers.push(blocker);
  }

  const serialized = JSON.stringify(value);
  if (containsCredentialShape(value)
      || /(?:COSYNCING_TOKEN|peerToken|privateKey|authorization)\s*[=:]\s*["']?[A-Za-z0-9+/=_-]{8,}/i.test(serialized)) {
    blockers.push('record: credential-shaped value detected');
  }
  return { ok: blockers.length === 0, blockers };
}

function usage(): never {
  console.error(
    'Usage: bun run evidence:broker-real-host INPUT.json ' +
    '[--expect-version VERSION] [--expect-commit HEX] [--expect-manifest-sha256 HEX] ' +
    '[--result OUTPUT.json] [--audit OUTPUT.md]',
  );
  process.exit(2);
}

function humanAudit(record: Partial<RealHostEvidence>, validation: EvidenceValidation): string {
  const rows = [
    ...Object.entries(record.hosts ?? {}).map(([id, lane]) => `| host | \`${id}\` | \`${lane.auditId}\` | ${Object.keys(lane.claims ?? {}).length} |`),
    ...Object.entries(record.agents ?? {}).map(([id, agent]) => `| agent | \`${id}\` | \`${agent.auditId}\` | ${Object.keys(agent.claims ?? {}).length} |`),
    ...(record.client ? [`| client | \`same-tailnet\` | \`${record.client.auditId}\` | ${Object.keys(record.client.claims ?? {}).length} |`] : []),
  ];
  const blockers = validation.blockers.length
    ? `\n## Blocking findings\n\n${validation.blockers.map((item) => `- ${item}`).join('\n')}\n`
    : '';
  return `# Real-host broker acceptance audit\n\n` +
    `- Status: **${validation.ok ? 'PASS' : 'FAIL'}**\n` +
    `- Version: \`${record.release?.version ?? 'missing'}\`\n` +
    `- Source commit: \`${record.release?.sourceCommit ?? 'missing'}\`\n` +
    `- Manifest SHA-256: \`${record.release?.manifestSha256 ?? 'missing'}\`\n` +
    `- Generated: ${record.generatedAt ?? 'missing'}\n` +
    `- Claude packaged hooks surface absent: ${record.packagedClaudeHooksSurfaceAbsent === true ? 'yes' : 'no'}\n\n` +
    `| Scope | Lane | Audit ID | Claims |\n|---|---|---|---:|\n${rows.join('\n')}\n${blockers}`;
}

if (import.meta.main) {
  const input = process.argv[2];
  if (!input) usage();
  let resultPath: string | undefined;
  let auditPath: string | undefined;
  const expected: EvidenceExpectations = {};
  for (let index = 3; index < process.argv.length; index += 2) {
    const flag = process.argv[index];
    const argument = process.argv[index + 1];
    if (!argument) usage();
    if (flag === '--result') resultPath = resolve(argument);
    else if (flag === '--audit') auditPath = resolve(argument);
    else if (flag === '--expect-version') expected.version = argument;
    else if (flag === '--expect-commit') expected.sourceCommit = argument;
    else if (flag === '--expect-manifest-sha256') expected.manifestSha256 = argument;
    else usage();
  }
  const record = JSON.parse(readFileSync(resolve(input), 'utf8')) as Partial<RealHostEvidence>;
  const validation = validateRealHostEvidence(record, expected);
  const output = `${JSON.stringify({ schemaVersion: 1, lane: 'broker-real-host', ...validation }, null, 2)}\n`;
  if (resultPath) writeFileSync(resultPath, output);
  if (auditPath) writeFileSync(auditPath, humanAudit(record, validation));
  process.stdout.write(output);
  if (!validation.ok) process.exit(1);
}
