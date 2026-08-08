import type { SessionInfo } from '@cosyncing/adapter-api';
import {
  authoritativeLiveOwners,
  overlayAuthoritativeOwner,
  type LiveOverlayEntry,
} from './roster-overlay.ts';

/**
 * The single qualified roster-publication boundary (R0c.1).
 *
 * The runtime has two live status sources for one session: the Hub's exact managed connections and
 * each adapter's `watchSessionInfo` inferred snapshots. Before this boundary existed, the watcher
 * callback journaled its raw inferred snapshot immediately and reconciled the Hub asynchronously —
 * during a bounded rollout catch-up that journaled Idle for a session whose live owner was mid-turn,
 * and Hub reconciliation restored Working, producing Idle↔Working reversals with no native terminal
 * evidence.
 *
 * Every roster-view publication now passes through {@link qualify}: when an exact live Hub owner
 * exists for `tool:id`, its managed status exclusively owns working / needs-input / terminal state
 * (via {@link overlayAuthoritativeOwner}, the same rule discovery reconcile applies); watcher
 * snapshots contribute truthful metadata/control only. Raw watcher status is published only when no
 * live owner exists. Qualification and journaling happen in ONE synchronous step, so publication
 * order can never carry stale authority — a callback held across a newer owner frame re-derives
 * against the newer owner at publish time. Qualification applies to what is JOURNALED; Hub
 * reconciliation still receives the adapter's raw evidence (see {@link drain}).
 *
 * Hub reconciliation of watcher snapshots is serialized and coalesced per exact native identity
 * when available (falling back to `tool\0id`): at most one `reconcile` is in flight and at most the
 * NEWEST snapshot is pending behind it. Complete discovery selects cross-incarnation authority;
 * generation-less watcher frames can never reverse it. Owner replacement/retirement while a
 * reconcile is in flight is also fenced inside `Hub.refreshExternalSession`.
 */
export interface RosterPublicationHooks {
  /** Snapshot of every broker-owned live connection — `hub.liveSnapshot()`. */
  liveOwners(): LiveOverlayEntry[];
  /** Journal one qualified SessionInfo into the bounded roster revision views. */
  publish(info: SessionInfo): void;
  /** Admit a watcher snapshot against the latest complete native-incarnation selection. */
  acceptWatcher?(info: SessionInfo): boolean;
  /** Observe an admitted watcher in ancillary bounded caches. Rejected stale rows never reach it. */
  onWatcherAccepted?(info: SessionInfo): void;
  /** Reconcile the Hub-owned connection from a qualified watcher snapshot. */
  reconcile(info: SessionInfo): Promise<void>;
  onReconcileError?(error: unknown, info: SessionInfo): void;
}

export interface RosterPublicationBoundary {
  /** Publication path for exact managed-connection frames (Hub `onSessionInfo`). */
  publishOwnerFrame(info: SessionInfo): void;
  /** Publication path for adapter `watchSessionInfo` inferred snapshots. */
  submitWatcherSnapshot(info: SessionInfo): void;
  /** Sessions with watcher reconciliation currently pending or in flight (diagnostics/tests). */
  pendingWatcherReconciliations(): number;
  /** Resolves once every currently-submitted watcher snapshot has fully reconciled (tests/shutdown). */
  settle(): Promise<void>;
}

const watcherKey = (info: SessionInfo): string => info.nativeId
  ? `${info.tool}\0native\0${info.nativeId}`
  : `${info.tool}\0session\0${info.id}`;

/** Bounded broker-side publication authority for cross-adapter-id native incarnations.
 *
 * Only a complete adapter discovery snapshot may select a canonical adapter id. Watcher snapshots
 * carry no source generation and therefore can never replace that selection. Ambiguous complete
 * snapshots select nothing and retire nothing. Retained selections protect serialized watcher
 * publication across later partial/windowed discovery passes. */
export class NativeIncarnationPublicationAuthority {
  static readonly maxEntries = 8192;
  private readonly selected = new Map<string, string | null>();

  private key(info: SessionInfo): string | undefined {
    return info.nativeId ? `${info.tool}\0${info.nativeId}` : undefined;
  }

  /** Reconcile exact identities observed in one complete adapter snapshot and return only
   * unambiguous replacement rows that may retire older Hub owners. */
  reconcile(sessions: readonly SessionInfo[]): SessionInfo[] {
    const grouped = new Map<string, Map<string, SessionInfo>>();
    for (const info of sessions) {
      const key = this.key(info);
      if (!key) continue;
      const ids = grouped.get(key) ?? new Map<string, SessionInfo>();
      ids.set(info.id, info);
      grouped.set(key, ids);
      if (grouped.size > NativeIncarnationPublicationAuthority.maxEntries) {
        this.selected.clear();
        return [];
      }
    }
    const canonical: SessionInfo[] = [];
    for (const [key, ids] of grouped) {
      const replacement = ids.size === 1 ? ids.values().next().value as SessionInfo : undefined;
      this.selected.delete(key);
      this.selected.set(key, replacement?.id ?? null);
      if (replacement) canonical.push(replacement);
    }
    while (this.selected.size > NativeIncarnationPublicationAuthority.maxEntries) {
      const oldest = this.selected.keys().next().value;
      if (typeof oldest !== 'string') break;
      this.selected.delete(oldest);
    }
    return canonical;
  }

  /** A watcher may refresh only the canonical id. Unknown/ambiguous identities are admitted for
   * non-destructive observation, but cannot retire either side because watcher retirement is not a
   * publication operation. */
  acceptsWatcher(info: SessionInfo): boolean {
    const key = this.key(info);
    if (!key) return true;
    const selected = this.selected.get(key);
    return selected === undefined || selected === null || selected === info.id;
  }
}

export function createRosterPublicationBoundary(hooks: RosterPublicationHooks): RosterPublicationBoundary {
  /** Newest not-yet-applied watcher snapshot per exact tool/session identity (coalesced). */
  const pending = new Map<string, SessionInfo>();
  /** In-flight serialized apply loop per identity; doubles as the settle() barrier. */
  const draining = new Map<string, Promise<void>>();

  /** Owner-qualify one snapshot against the CURRENT live owners. Synchronous by design: the caller
   *  must journal the result in the same microtask, so no newer owner frame can slip in between
   *  derivation and publication. */
  function qualify(info: SessionInfo): SessionInfo {
    const owner = authoritativeLiveOwners(hooks.liveOwners()).get(`${info.tool}:${info.id}`);
    if (!owner) return info;
    const qualified = { ...info };
    overlayAuthoritativeOwner(qualified, owner);
    return qualified;
  }

  async function drain(key: string): Promise<void> {
    while (pending.has(key)) {
      const snapshot = pending.get(key)!;
      pending.delete(key);
      // Cross-incarnation watcher work shares one drain key and is re-qualified at apply time. A
      // delayed old adapter id can neither retire nor republish over the complete-discovery winner.
      if (hooks.acceptWatcher && !hooks.acceptWatcher(snapshot)) continue;
      hooks.onWatcherAccepted?.(snapshot);
      hooks.publish(qualify(snapshot));
      try {
        // Reconcile with the RAW snapshot, not the qualified view: connection-class and control
        // arbitration (e.g. the codex live→observe downgrade-reattach) must keep seeing the
        // adapter's truthful evidence — overlaying the owner's own control here would feed its
        // possibly-stale class back to itself and suppress real downgrades. Run-state authority is
        // enforced inside Hub.refreshExternalSession, after its awaits.
        await hooks.reconcile(snapshot);
      } catch (error) {
        hooks.onReconcileError?.(error, snapshot);
      }
    }
    draining.delete(key);
  }

  return {
    publishOwnerFrame(info: SessionInfo): void {
      hooks.publish(qualify(info));
    },
    submitWatcherSnapshot(info: SessionInfo): void {
      const key = watcherKey(info);
      pending.set(key, info);
      // Schedule after installing the barrier. A rejected stale watcher can drain synchronously;
      // starting it inline would delete the key before this set(), leaving a resolved promise stuck
      // in `draining` and making settle/shutdown wait forever.
      if (!draining.has(key)) draining.set(key, Promise.resolve().then(() => drain(key)));
    },
    pendingWatcherReconciliations(): number {
      return draining.size;
    },
    async settle(): Promise<void> {
      while (draining.size > 0) await Promise.all([...draining.values()]);
    },
  };
}
