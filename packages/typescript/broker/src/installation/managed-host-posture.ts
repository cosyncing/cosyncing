/**
 * WHICH of an agent's external hosts is cosyncing responsible for on this
 * machine?
 *
 * One question, asked before diagnosis, because it changes what a diagnosis may
 * tell a user to DO. Where cosyncing manages the host, "start it yourself" and
 * "restart it yourself" are both wrong: the service starts and supervises that
 * host, so a manual start races its recovery, and a manual restart opens the
 * window the supervisor fills — either way two servers end up on one home, the
 * ambiguity the whole ownership proof exists to prevent.
 *
 * WHICH, not whether. Management is a property of a CONFIGURATION, not of an
 * agent: the installed service manages the host its own environment resolves,
 * and an operator's shell can point the same adapter at a different home or at a
 * host on another machine entirely. An agent-wide answer is wrong in both
 * directions at once — it describes an operator's private host as supervised,
 * and it lets a diagnosis hand out a local start command whose host would
 * collide with the managed one. So the answer is a set of identity keys per
 * agent, in the adapter's own identity space, and a diagnosis applies the
 * managed posture only to the identity it actually resolved.
 *
 * TWO INDEPENDENT SIGNALS, because either alone is wrong at exactly the moment
 * it matters most.
 *
 * THE COMMITTED SERVICE RECEIPT is the first, and it is read as a receipt rather
 * than as configuration. Managed hosts are DEFAULT-ON in the environment setup
 * writes, and that file is receipt-owned rather than a supported opt-out: a
 * service already running has loaded `=1` into its own process environment, and
 * editing, breaking, or deleting the file afterwards does not reach back into
 * that process. So a missing, unreadable, or drifted environment — `="0"`
 * included — cannot be evidence that nothing is managing the host. It is only
 * evidence that the file no longer says what the running service was started
 * with. The receipt is therefore taken to mean MANAGED, and the file's contents
 * are deliberately not consulted at all: reading them could only produce a less
 * safe answer than the one the receipt already justifies.
 *
 * AN OWNERSHIP RECORD is the second, and it covers what the receipt cannot: a
 * foreground broker with no service at all, and a host left behind by a failed
 * stop. It counts only while it still identifies a process, through the same
 * classification every signal in this codebase uses — a live host (`owned`) or
 * one this machine will not describe (`indeterminate`) suppresses manual
 * instructions, while a record whose process is provably gone (`absent`, or
 * `foreign` where the pid now belongs to someone else) does not. A stale record
 * must not leave an unmanaged operator with no way to start their host. The
 * record carries the identity it was written for, so it scopes itself.
 *
 * The answer is deliberately not derived from the CURRENT process environment:
 * `cosyncing doctor` runs in an operator's shell, whose variables say nothing
 * about how the broker was launched.
 *
 * TWO HOMES, NEVER ONE. cosyncing's STATE home (`~/.cosyncing`) is where the
 * receipt and the ownership records live; the USER's home is where an agent
 * keeps its own directory, and it is the one an adapter resolves an identity
 * against. They are different paths, and collapsing them is not a cosmetic
 * error: an identity resolved under the state home names `~/.cosyncing/.kimi-code`,
 * which no host has ever used, so it matches nothing the diagnosis resolves and
 * the receipt silently stops applying — putting `kimi web` back in front of an
 * operator whose service is managing that host. Every parameter here says which
 * home it is.
 *
 * Nothing here names an agent. The set comes from adapters that declare
 * `externalHost.managed`, and each identity comes from the adapter itself, so an
 * adapter that gains a host is covered without this file changing.
 */

import type { AgentBackend } from '@cosyncing/adapter-api';
import {
  classifyManagedHost,
  defaultManagedHostEffects,
  readManagedHostOwnership,
  type ManagedHostEffects,
} from '../runtime/managed-host.ts';
import { inspectInstallState } from './install-state.ts';

/** Injected so a suite can describe an install and a process table it does not have. */
export interface ManagedHostPostureSources {
  readonly serviceInstalled?: (stateHome: string) => boolean;
  readonly effects?: ManagedHostEffects;
}

/** The receipt id the durable service environment is installed under. */
const SERVICE_ENVIRONMENT_RESOURCE = 'service-environment';

/**
 * The environment the installed service resolves its host identities in.
 *
 * EMPTY, and that is a fact about the service rather than a simplification:
 * `brokerServiceEnvironmentEntries` writes HOME, PATH, and the broker's own
 * `COSYNCING_*` state paths, and no agent host variable at all — no
 * `KIMI_CODE_HOME`, no `COSYNCING_DSH_BASE_URL`. A service therefore manages
 * exactly the host each adapter resolves by default under its home, which is
 * what an empty environment plus that home reproduces.
 *
 * Guarded by a test that resolves both shipped managed adapters against the
 * REAL service entries and asserts they agree with this reconstruction, so an
 * entry added there fails loudly here instead of silently mis-scoping a posture.
 */
const SERVICE_HOST_ENVIRONMENT: Readonly<Record<string, string | undefined>> = Object.freeze({});

/**
 * Did setup commit a durable service environment on this machine?
 *
 * The RECEIPT is the question, not the file. See the header: the file is not a
 * live opt-out, so its absence or contents cannot withdraw what the receipt
 * records.
 */
function committedServiceEnvironment(stateHome: string): boolean {
  const install = inspectInstallState(stateHome);
  if (!install.committed) return false;
  return install.state.resources.some((resource) => resource.id === SERVICE_ENVIRONMENT_RESOURCE);
}

/**
 * The identity of a recorded host that still identifies a process, or `null`.
 *
 * The record's OWN identity key, never a recomputed one: it names the host that
 * was actually started, which is the only thing a record can prove and the only
 * scope in which suppressing manual instructions is honest.
 */
function recordedHostIdentity(agent: string, stateHome: string, effects: ManagedHostEffects): string | null {
  const record = readManagedHostOwnership(agent, stateHome);
  if (!record) return null;
  const verdict = classifyManagedHost(record, effects.liveProcess(record.pid), record.identityKey);
  // 'absent' is proven gone and 'foreign' means the pid belongs to something
  // else, which proves OUR process is gone; both leave nothing for cosyncing to
  // be managing. 'owned' and 'indeterminate' do not, and an operator must not be
  // told to start a second host on either.
  return verdict === 'owned' || verdict === 'indeterminate' ? record.identityKey : null;
}

/**
 * Which external hosts this machine's cosyncing is responsible for, per agent.
 *
 * An agent absent from the map — or present with an identity the diagnosis did
 * not resolve — is unmanaged, which is the posture where manual instructions are
 * correct. An adapter that declares no external host is simply never in it.
 *
 * An adapter that declares a managed host but implements no
 * {@link AgentBackend.managedHostIdentity} contributes no service identity,
 * because there is nothing to scope one to. That is a contract violation rather
 * than a supported shape, and it is asserted against the shipped adapter list;
 * scoping it agent-wide instead would reintroduce exactly the false claims this
 * map exists to prevent.
 */
export function brokerManagedHostIdentities(
  /** cosyncing's own state home: where the receipt and the ownership records are. */
  stateHome: string,
  /** The USER home the service resolves agent directories against — never the state home. */
  serviceHomeDir: string,
  adapters: readonly AgentBackend[],
  sources: ManagedHostPostureSources = {},
): ReadonlyMap<string, ReadonlySet<string>> {
  const serviceInstalled = (sources.serviceInstalled ?? committedServiceEnvironment)(stateHome);
  const effects = sources.effects ?? defaultManagedHostEffects();
  const managed = new Map<string, ReadonlySet<string>>();
  for (const adapter of adapters) {
    if (adapter.integration?.externalHost?.managed !== true) continue;
    const identities = new Set<string>();
    if (serviceInstalled) {
      const serviceIdentity = adapter.managedHostIdentity?.({
        env: SERVICE_HOST_ENVIRONMENT,
        homeDir: serviceHomeDir,
      });
      if (serviceIdentity) identities.add(serviceIdentity);
    }
    const recorded = recordedHostIdentity(adapter.id, stateHome, effects);
    if (recorded) identities.add(recorded);
    if (identities.size > 0) managed.set(adapter.id, identities);
  }
  return managed;
}
