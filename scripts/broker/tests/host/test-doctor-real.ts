#!/usr/bin/env bun
/**
 * Opt-in, no-cost doctor verification against the four CLIs installed on this host.
 * This calls adapter diagnosis only: no discovery, daemon start, serve launch, extension install, or LLM turn.
 */
import type { AgentBackend, AgentSetupDiagnosis } from '../../../../packages/typescript/adapter-api/src/index.ts';
import { ClaudeAdapter } from '../../../../packages/typescript/adapters/claude/src/index.ts';
import { CodexAdapter } from '../../../../packages/typescript/adapters/codex/src/index.ts';
import { OpenCodeAdapter } from '../../../../packages/typescript/adapters/opencode/src/index.ts';
import { PiAdapter } from '../../../../packages/typescript/adapters/pi/src/index.ts';
import { createSetupDiagnosisContext } from '../../../../packages/typescript/broker/src/installation/diagnosis-context.ts';

if (process.env.COSYNCING_DOCTOR_REAL_AGENT !== '1') {
  console.log(JSON.stringify({
    schemaVersion: 1,
    lane: 'doctor-real-installed-agent',
    status: 'skip',
    reason: 'Set COSYNCING_DOCTOR_REAL_AGENT=1 to run read-only checks against installed CLIs.',
  }, null, 2));
  process.exit(0);
}

const context = createSetupDiagnosisContext();
const adapters: AgentBackend[] = [
  new CodexAdapter(),
  new OpenCodeAdapter(),
  new PiAdapter(),
  new ClaudeAdapter(),
];

const diagnoses: AgentSetupDiagnosis[] = [];
for (const adapter of adapters) {
  if (!adapter.diagnoseSetup) throw new Error(`${adapter.id} has no setup diagnosis`);
  diagnoses.push(await adapter.diagnoseSetup(context));
}

const agents = diagnoses.map((diagnosis) => {
  const binary = diagnosis.checks.find((check) => check.id === `${diagnosis.agent}.binary`);
  const version = diagnosis.checks.find((check) => check.id === `${diagnosis.agent}.version`);
  const installed = typeof version?.evidence?.installedVersion === 'string'
    ? version.evidence.installedVersion
    : undefined;
  const readiness = diagnosis.checks.some((check) => check.status === 'fail')
    ? 'fail'
    : diagnosis.checks.some((check) => check.status === 'warn') ? 'warn' : 'pass';
  return {
    agent: diagnosis.agent,
    displayName: diagnosis.displayName,
    minimumVersion: diagnosis.minimumVersion.version,
    ...(installed ? { installedVersion: installed } : {}),
    minimumStatus: binary?.status === 'pass' && version?.status === 'pass' ? 'pass' : 'fail',
    readiness,
    checks: diagnosis.checks.map(({ id, status, detailCode, summary, remediation }) => ({
      id,
      status,
      detailCode,
      summary,
      ...(remediation ? { remediation } : {}),
    })),
  };
});

const report = {
  schemaVersion: 1,
  lane: 'doctor-real-installed-agent',
  effects: 'forbidden',
  modelCalls: 0,
  ok: agents.every((agent) => agent.minimumStatus === 'pass'),
  ready: agents.every((agent) => agent.readiness !== 'fail'),
  agents,
};
const json = JSON.stringify(report, null, 2);
if (/COSYNCING_TOKEN\s*[=:]|Authorization\s*:/i.test(json)) {
  throw new Error('real-agent report contains credential-shaped output');
}
console.log(json);
if (!report.ok) process.exitCode = 1;
