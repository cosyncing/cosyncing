/** Provider-neutral integration capabilities consumed by broker orchestration. */

export interface ManagedRuntimeIntegration {
  /** A broker-owned child process, or a shared local server coordinated by the broker. */
  readonly kind: 'process' | 'server';
  /** The broker records and diagnoses bounded startup failures for this runtime. */
  readonly failureJournal: true;
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
}
