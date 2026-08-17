/** Provider-neutral integration capabilities consumed by broker orchestration. */

export interface ManagedRuntimeIntegration {
  /** A broker-owned child process, or a shared local server coordinated by the broker. */
  readonly kind: 'process' | 'server';
  /** The broker records and diagnoses bounded startup failures for this runtime. */
  readonly failureJournal: true;
}

/**
 * Where a running external host can be found, expressed as DATA.
 *
 * The broker resolves this to a pid using its own process-table access, which is
 * the whole point of describing it rather than doing it: locating a process is a
 * host effect, and adapters do not perform host effects. An adapter says "it is
 * whatever listens on port 3080" or "my registry records pid 4242"; the broker
 * turns that into an identity it can compare against an ownership record.
 *
 * `unknown` is not a failure to be tidied away — it is the honest answer when a
 * host is reachable but its process cannot be named, and it must stay
 * expressible, because the broker's response to it is to touch nothing.
 *
 * `absent` is its opposite and is just as load-bearing: an adapter POSITIVELY
 * asserting that no host is running. It is the only locator that authorizes the
 * broker to start one, so an adapter may return it only from a lookup that
 * actually succeeded and actually found nothing — never from a failed, partial,
 * or truncated one, which is what `unknown` is for.
 */
export type ManagedHostLocator =
  | { readonly kind: 'tcp-port'; readonly port: number }
  | { readonly kind: 'pid'; readonly pid: number }
  | { readonly kind: 'absent' }
  | { readonly kind: 'unknown' };

/** How to start a host, as data the broker executes. */
export interface ManagedHostLaunchSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** Extra environment for the child; the broker's own environment is inherited. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * Working directory for the child.
   *
   * Worth pinning rather than inheriting: a broker started as a service runs
   * from `/`, and a host that resolves anything — state, profiles, relative
   * paths — against its cwd would then behave differently depending on how the
   * broker itself was launched.
   */
  readonly cwd?: string;
}

/**
 * The environment a host identity is resolved against.
 *
 * `homeDir` is separate from `env.HOME` deliberately: it is the home the BROKER
 * resolved, and an adapter that read the variable instead would answer for
 * whichever shell happened to call it.
 */
export interface ManagedHostIdentityInputs {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly homeDir: string;
}

/**
 * An adapter's description of the external host it talks to.
 *
 * Returned by {@link AgentBackend.describeManagedHost}, and deliberately inert:
 * every field is a value the broker reads, never an action the adapter takes.
 * The broker supplies readiness (the adapter's own `isAvailable`), the process
 * table, the ownership record, and the decision.
 */
export interface ManagedHostDescriptor {
  /**
   * The address or home this host serves. Ownership records are scoped to it, so
   * it must change when the host would be a DIFFERENT host — repointing the
   * adapter at another origin must not let an old record prove anything about
   * the new one.
   */
  readonly identityKey: string;
  readonly locator: ManagedHostLocator;
  /**
   * How to start it, or `null` when it cannot be started right now — the binary
   * is not installed, or the operator pointed the adapter at a host that is not
   * this machine's to run. `null` means the broker will still classify and
   * report a running host; it just will not create one.
   */
  readonly launch: ManagedHostLaunchSpec | null;
  /**
   * What the host reports about ITSELF, when there is one running.
   *
   * Read by the broker after a host becomes ready and stored as ownership
   * evidence: an operator reading `doctor` learns which port the host actually
   * bound rather than which one it was asked for, and a later broker can look
   * for it by address instead of trusting a pid. Absent fields are absent facts
   * — a host that publishes no real version reports none rather than a
   * placeholder.
   */
  readonly serving?: {
    readonly port?: number;
    readonly version?: string;
    readonly profile?: string;
  };
  /** How long a freshly started host has to become ready before it is a failure. */
  readonly readyTimeoutMs: number;
  /** How long a stop waits after SIGTERM before escalating. */
  readonly stopGraceMs: number;
}

/**
 * Optional host integration attached to an adapter.
 *
 * This is intentionally data-only. Adapters describe native capabilities;
 * broker-owned setup, transaction, persistence, and process code performs host
 * effects. Resource reconciliation fields will be added when the Pi/OpenCode
 * migrations establish their common primitive set.
 */
export interface AgentIntegration {
  readonly managedRuntime?: ManagedRuntimeIntegration;
  /**
   * Declares that this agent's host is EXTERNAL — a process that exists
   * independently of the broker, which the broker may nonetheless start.
   *
   * Presence of this flag is what makes {@link AgentBackend.describeManagedHost}
   * meaningful, and it is read generically: no broker code may branch on which
   * agent it is.
   */
  readonly externalHost?: { readonly managed: true };
}
