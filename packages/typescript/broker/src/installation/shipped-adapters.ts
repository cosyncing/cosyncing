/**
 * The adapters this build ships, in one place.
 *
 * Two consumers need this list and must never disagree about it: `doctor`
 * diagnoses every shipped agent, and the installed service's environment
 * activates managed hosts for every shipped agent that has one. A second
 * hand-maintained copy is exactly how a newly added adapter ships diagnosed but
 * unmanaged — or managed but undiagnosed — so there is one list and both read
 * it.
 */

import type { AgentBackend } from '@cosyncing/adapter-api';
import { CodexAdapter } from '@cosyncing/adapter-codex';
import { OpenCodeAdapter } from '@cosyncing/adapter-opencode';
import { PiAdapter } from '@cosyncing/adapter-pi';
import { OmpAdapter } from '@cosyncing/adapter-omp';
import { ReasonixAdapter } from '@cosyncing/adapter-reasonix';
import { GrokAdapter } from '@cosyncing/adapter-grok';
import { ClineAdapter } from '@cosyncing/adapter-cline';
import { KiloAdapter } from '@cosyncing/adapter-kilocode';
import { ClaudeAdapter } from '@cosyncing/adapter-claude';
import { KimiAdapter } from '@cosyncing/adapter-kimi';
import { DshAdapter } from '@cosyncing/adapter-dsh';
import { AgyAdapter } from '@cosyncing/adapter-antigravity';
import { managedHostGateEnv } from '../runtime/managed-host.ts';
import { createDshCredentialStore } from '../security/dsh-credentials.ts';

/**
 * Fresh instances per call, never a shared array: adapters carry per-instance
 * state and a caller that mutated a shared one would reach every other caller.
 */
export function shippedAdapters(): readonly AgentBackend[] {
  return [
    new OpenCodeAdapter(),
    new PiAdapter(),
    new OmpAdapter(),
    new ReasonixAdapter(),
    new GrokAdapter(),
    new ClineAdapter(),
    new KiloAdapter(),
    new CodexAdapter(),
    new ClaudeAdapter(),
    new KimiAdapter(),
    shippedDshAdapter(),
    new AgyAdapter(),
  ];
}

/**
 * The DeepSeek Harness adapter with the broker's cookie store attached.
 *
 * Exported rather than inlined twice because the RUNNING broker and the read-only
 * inspection paths have to resolve the same credential for the same host. An
 * adapter built without the store can still authenticate for the life of its own
 * process — and then has to be re-enrolled after every restart, which for an
 * external host means the operator goes hunting for a URL the host printed once.
 * A doctor that built its own instead would report "not enrolled" about a host
 * the operator is logged into. One construction site is the only thing keeping
 * those three answers identical.
 */
export function shippedDshAdapter(): AgentBackend {
  return new DshAdapter({ credentialStore: createDshCredentialStore() });
}

/**
 * Managed-host activation for the durable service environment.
 *
 * Derived from what each adapter DECLARES rather than from a list of tool
 * names — the same rule the broker and UI follow — so an adapter that gains an
 * external host is managed by the installed service without anyone editing
 * this file, and one that loses it stops being.
 *
 * Enabled by default, and enabled HERE, because this list is the receipt-hashed
 * service environment: an operator who never sets a variable gets a service
 * that starts, supervises, and stops the hosts their agents need, and `repair`
 * restores exactly this. Authorization is not ownership — the broker still acts
 * only on a process it can prove it started — so defaulting it on cannot reach
 * a host the operator is running themselves.
 */
export function managedHostServiceEnvironmentEntries(
  adapters: readonly AgentBackend[] = shippedAdapters(),
): Array<readonly [string, string]> {
  return adapters
    .filter((adapter) => adapter.integration?.externalHost?.managed === true)
    .map((adapter) => [managedHostGateEnv(adapter.id), '1'] as const);
}
