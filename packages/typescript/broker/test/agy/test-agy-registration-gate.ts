#!/usr/bin/env bun
/**
 * Antigravity registration, the facts no conformance scenario can observe: the shipped-adapter list, doctor, the
 * installed service's environment, and setup's agent preflight.
 *
 * What agy serves and does once registered is `e2e/adapters/conformance/agy.test.ts`: the roster row and its
 * capabilities for every client revision (C01), the attach contract (C03, C04, C08), a drive that spawns nothing
 * until its first prompt (C08), and a missing binary (C17 and the no-binary extra). This file keeps only the checks
 * on the registration lists themselves, which run in-process with no broker, no fixture tree and no child.
 *
 * agy carries NO `minimumClientRevision`, and that is a claim with evidence rather than an omission: its values
 * (`sdk-callback`, `observe`, `resume`) predate both decode tolerances, so a floor would hide the agent from a
 * released client generation that decodes it perfectly.
 *
 *   bun run packages/typescript/broker/test/agy/test-agy-registration-gate.ts
 */
export {};
import { ATTACH_MODES_KNOWN_BEFORE_TOLERANT_DECODE } from '@cosyncing/protocol';
import { AGY_CAPABILITIES } from '../../../adapters/antigravity/src/index.ts';
import { shippedAdapters } from '../../src/installation/shipped-adapters.ts';
import { agentSummaries } from '../../src/installation/setup.ts';
import { setupMessages } from '../../src/installation/setup-i18n.ts';
import { defaultDoctorAdapters } from '../../src/installation/doctor.ts';
import { managedHostGateEnv } from '../../src/runtime/managed-host.ts';
import { brokerServiceEnvironmentEntries } from '../../src/installation/service-manager.ts';

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
function check(name: string, ok: boolean, detail = ''): void {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

try {
  // Two lists, and they must never disagree: the runtime registry is what `/api/agents` serves, and
  // `shippedAdapters()` is what doctor diagnoses and what the service environment derives managed hosts from.
  const shipped = shippedAdapters().map((adapter) => adapter.id);
  check('agy is on the shipped-adapter list, exactly once',
    shipped.filter((id) => id === 'agy').length === 1, shipped.join(','));
  const doctorIds = defaultDoctorAdapters({}).map((adapter) => adapter.id);
  check('doctor diagnoses agy, with no flag set', doctorIds.includes('agy'), doctorIds.join(','));
  // An adapter on the shipped list with no `diagnoseSetup` does not degrade quietly: `diagnoseAgents` synthesizes a
  // hard failure telling the operator to install a build that does not exist.
  const agyShipped = shippedAdapters().find((adapter) => adapter.id === 'agy');
  check('...and can actually answer, rather than being failed as undiagnosable',
    typeof agyShipped?.diagnoseSetup === 'function', String(typeof agyShipped?.diagnoseSetup));

  // Serving the row to everyone is only correct while every value in it predates both decode tolerances.
  const needingTolerance = AGY_CAPABILITIES.attachModes.filter(
    (mode) => !ATTACH_MODES_KNOWN_BEFORE_TOLERANT_DECODE.includes(mode as never));
  check('every attach mode agy publishes predates the attach-mode tolerance',
    AGY_CAPABILITIES.attachModes.length > 0 && needingTolerance.length === 0,
    `published=${AGY_CAPABILITIES.attachModes.join(',')} needing-tolerance=${needingTolerance.join(',')}`);
  check('...and the adapter therefore declares no minimum client revision at all',
    agyShipped?.minimumClientRevision === undefined, String(agyShipped?.minimumClientRevision));

  // There is no daemon: nothing listens between invocations, so the installed service has no host to start,
  // supervise or stop, and the durable service environment must not name one.
  const serviceEnvironment = brokerServiceEnvironmentEntries({
    homeDir: '/fixture/home',
    stateHome: '/fixture/state',
    cacheRoot: '/fixture/cache',
    executablePath: '/fixture/bin/cosyncing',
    webDir: '/fixture/web',
  }).map(([name]) => name);
  check('the durable service environment activates no managed agy host, because agy has none',
    !serviceEnvironment.includes(managedHostGateEnv('agy'))
      && !serviceEnvironment.some((name) => /AGY|ANTIGRAVITY/i.test(name)),
    serviceEnvironment.join(','));
  check('...and the adapter declares no external host to manage',
    agyShipped?.integration?.externalHost === undefined,
    JSON.stringify(agyShipped?.integration?.externalHost));

  // Setup's agent preflight LISTS agy. It is delivered by the broker itself, so it belongs on the delivered list the
  // way claude does, not behind the managed-host filter. The physical 0.4.1 pass found `cosy setup` showing six
  // agents and no Antigravity while every other check was green.
  const summaryFor = (agents: string[]) => agentSummaries({
    minimumVersions: agents.map((agent) => ({
      agent, displayName: agent, version: '0.0.0',
      requiredFeature: 'fixture', evidenceUrl: '', evidenceNote: 'fixture',
    })),
    sections: [{ id: 'agents', title: 'Agents', checks: [] }],
  } as never).map((row) => row.id as string);
  check('setup lists agy on the delivered-agents preflight',
    summaryFor(['codex', 'opencode', 'pi', 'claude']).includes('agy'),
    summaryFor(['codex', 'opencode', 'pi', 'claude']).join(','));
  for (const language of ['en', 'zh-Hans'] as const) {
    const copy = setupMessages(language).agentBehavior('agy');
    check(`the preflight behavior line is agy's own, not the managed-host fallback (${language})`,
      /Antigravity/.test(copy) && !/external host|外部 host/.test(copy), copy);
  }
  // No daemon means no managed-runtime consent: the disclosure names the hosts the service will start and stop.
  for (const language of ['en', 'zh-Hans'] as const) {
    const body = setupMessages(language).managedRuntimeBody('cosyncing');
    check(`the managed-runtime consent does NOT name agy (${language})`,
      !/agy/.test(body), body.slice(0, 160));
  }
} catch (error) {
  check('test harness completed', false, error instanceof Error ? error.message : String(error));
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
