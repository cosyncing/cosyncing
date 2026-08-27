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
import { ClaudeAdapter } from '@cosyncing/adapter-claude';
import { KimiAdapter } from '@cosyncing/adapter-kimi';
import { DshAdapter } from '@cosyncing/adapter-dsh';
import { AgyAdapter } from '@cosyncing/adapter-antigravity';
import { managedHostGateEnv } from '../runtime/managed-host.ts';

/**
 * Fresh instances per call, never a shared array: adapters carry per-instance
 * state and a caller that mutated a shared one would reach every other caller.
 */
export function shippedAdapters(): readonly AgentBackend[] {
  return [
    new OpenCodeAdapter(),
    new PiAdapter(),
    new CodexAdapter(),
    new ClaudeAdapter(),
    new KimiAdapter(),
    new DshAdapter(),
    new AgyAdapter(),
  ];
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
