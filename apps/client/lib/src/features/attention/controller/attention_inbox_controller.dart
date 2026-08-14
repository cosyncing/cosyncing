import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_delivery_processor.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_badge_seen_store.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_repository.dart';
import 'package:cosyncing_client/src/features/attention/data/push_installation_id.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_inbox.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Durable attention repository shared by polling and inbox presentation.
final attentionRepositoryProvider = Provider<AttentionRepository>((ref) {
  return DriftAttentionRepository(ref.watch(appDatabaseProvider));
});

/// Stable app-installation identity shared across broker profiles.
final pushInstallationIdStoreProvider = Provider<PushInstallationIdStore>((
  ref,
) {
  return DriftPushInstallationIdStore(database: ref.watch(appDatabaseProvider));
});

/// Stable client id used for attention read/dismiss state on every broker.
final attentionClientIdProvider = FutureProvider<String>((ref) {
  return ref
      .watch(pushInstallationIdStoreProvider)
      .readOrCreateInstallationId();
});

/// Invalidates derived inbox state after a durable feed or local-state change.
final attentionInboxRevisionProvider = StateProvider<int>((_) => 0);

/// Invalidates badge-only state after a successful inbox open.
final attentionBadgeRevisionProvider = StateProvider<int>((_) => 0);

/// All durable attention events across saved broker profiles.
final attentionInboxProvider = FutureProvider<AttentionInboxSections>((
  ref,
) async {
  ref.watch(attentionInboxRevisionProvider);
  final profiles = await ref.watch(brokerProfileListProvider.future);
  final repository = ref.watch(attentionRepositoryProvider);
  final entries = <AttentionInboxEntry>[];
  for (final profile in profiles) {
    final events = await repository.loadEvents(_attentionScopeKey(profile));
    entries.addAll(
      events.map(
        (event) => AttentionInboxEntry(profile: profile, event: event),
      ),
    );
  }
  return AttentionInboxSections.fromEntries(entries);
});

/// Unread badge count for the adaptive shell.
///
/// This is updated only after the inbox or feed has loaded. Keeping it as
/// lightweight shell state avoids opening the database merely to render global
/// navigation in tests or before profile hydration.
final attentionUnreadCountProvider = StateProvider<int>((_) => 0);

/// Durable profile-scoped watermark store for unseen badge events.
final attentionBadgeSeenStoreProvider = Provider<AttentionBadgeSeenStore>((
  ref,
) {
  return DriftAttentionBadgeSeenStore(ref.watch(appDatabaseProvider));
});

/// Actual number of events received since the last successful inbox open.
///
/// This is intentionally independent of event acknowledgement and dismissal.
final attentionUnseenBadgeCountProvider = FutureProvider<int>((ref) async {
  ref
    ..watch(attentionInboxRevisionProvider)
    ..watch(attentionBadgeRevisionProvider);
  final profiles = await ref.watch(brokerProfileListProvider.future);
  final store = ref.watch(attentionBadgeSeenStoreProvider);
  var count = 0;
  for (final profile in profiles) {
    count += await store.loadUnseenCount(_attentionScopeKey(profile));
  }
  return count;
});

/// Root-app runtime that keeps [attentionUnreadCountProvider] synced with the
/// durable inbox.
///
/// Without this, the badge only updated when a feed worker persisted a *new*
/// page or when the user visited the Attention page — so unread events already
/// in the local store never lit the badge after a cold start, and the badge
/// whose whole job is to pull the user toward the inbox only worked after
/// they had been there. Watched once from the app root (like the other
/// attention runtimes); the shell widgets keep reading the lightweight
/// [attentionUnreadCountProvider] so they never open the database themselves.
final attentionUnreadBadgeRuntimeProvider = Provider<void>((ref) {
  ref.listen(
    attentionUnseenBadgeCountProvider,
    (_, next) {
      final count = next.valueOrNull;
      if (count == null) return;
      ref.read(attentionUnreadCountProvider.notifier).state = count;
    },
    fireImmediately: true,
  );
});

/// Badge-only mutations performed when the inbox is successfully shown.
final attentionBadgeActionsProvider = Provider<AttentionBadgeActions>((ref) {
  return AttentionBadgeActions(ref);
});

/// Page-scoped runtime that clears the badge after each successful inbox load.
final AutoDisposeProvider<void> attentionInboxSeenRuntimeProvider =
    Provider.autoDispose<void>((ref) {
      ref.listen(
        attentionInboxProvider,
        (_, next) {
          final sections = next.valueOrNull;
          if (sections == null) return;
          unawaited(
            ref.read(attentionBadgeActionsProvider).markInboxOpened(sections),
          );
        },
        fireImmediately: true,
      );
    });

/// Advances durable badge watermarks without acknowledging inbox actions.
final class AttentionBadgeActions {
  /// Creates badge actions bound to app providers.
  const AttentionBadgeActions(this.ref);

  /// Provider reference for persistence and invalidation.
  final Ref ref;

  /// Marks the exact successfully loaded inbox snapshot as seen.
  Future<void> markInboxOpened(AttentionInboxSections sections) async {
    final maxCursorByProfile = <String, int>{};
    for (final entry in sections.all) {
      final scopeKey = _attentionScopeKey(entry.profile);
      final prior = maxCursorByProfile[scopeKey] ?? 0;
      if (entry.event.cursor > prior) {
        maxCursorByProfile[scopeKey] = entry.event.cursor;
      }
    }
    var changed = false;
    final store = ref.read(attentionBadgeSeenStoreProvider);
    for (final entry in maxCursorByProfile.entries) {
      changed =
          await store.markSeenThroughCursor(entry.key, entry.value) || changed;
    }
    if (changed) {
      ref.read(attentionBadgeRevisionProvider.notifier).state += 1;
    }
  }
}

/// Builds a short-lived authenticated client for an event's owning profile.
final AutoDisposeFutureProviderFamily<BrokerClient, BrokerProfile>
attentionProfileClientProvider = FutureProvider.autoDispose
    .family<BrokerClient, BrokerProfile>((ref, profile) async {
      final client = await createAttentionBrokerClient(ref, profile);
      ref.onDispose(client.close);
      return client;
    });

/// Builds an authenticated broker client for one saved profile.
Future<BrokerClient> createAttentionBrokerClient(
  Ref ref,
  BrokerProfile profile,
) => createBrokerClientForProfile(ref, profile);

/// Local-first acknowledgement and dismissal actions for inbox rows.
final attentionInboxActionsProvider = Provider<AttentionInboxActions>((ref) {
  return AttentionInboxActions(ref);
});

/// Performs event mutations while keeping local suppression durable offline.
final class AttentionInboxActions {
  /// Creates actions bound to app providers.
  const AttentionInboxActions(this.ref);

  /// Provider reference for repositories and profile clients.
  final Ref ref;

  /// Marks an event read locally, then best-effort syncs broker state.
  Future<void> acknowledge(AttentionInboxEntry entry) async {
    final readAt = DateTime.now();
    final brokerScopeKey = _attentionScopeKey(entry.profile);
    await ref
        .read(attentionRepositoryProvider)
        .markRead(brokerScopeKey, entry.event.id, readAt: readAt);
    _invalidate();
    await _clearNotification(entry);
    final client = await ref.read(
      attentionProfileClientProvider(entry.profile).future,
    );
    final clientId = await ref.read(attentionClientIdProvider.future);
    await client.acknowledgeAttentionEvent(
      entry.event.id,
      clientId: clientId,
    );
    await ref
        .read(attentionRepositoryProvider)
        .markBrokerReadSynced(
          brokerProfileId: brokerScopeKey,
          eventId: entry.event.id,
          brokerReadAt: readAt,
        );
  }

  /// Dismisses locally first, then best-effort syncs broker state.
  Future<void> dismiss(AttentionInboxEntry entry) async {
    final dismissedAt = DateTime.now();
    final brokerScopeKey = _attentionScopeKey(entry.profile);
    await ref
        .read(attentionRepositoryProvider)
        .markDismissed(
          brokerScopeKey,
          entry.event.id,
          dismissedAt: dismissedAt,
        );
    _invalidate();
    await _clearNotification(entry);
    final client = await ref.read(
      attentionProfileClientProvider(entry.profile).future,
    );
    final clientId = await ref.read(attentionClientIdProvider.future);
    await client.dismissAttentionEvent(
      entry.event.id,
      clientId: clientId,
    );
    await ref
        .read(attentionRepositoryProvider)
        .markBrokerDismissedSynced(
          brokerProfileId: brokerScopeKey,
          eventId: entry.event.id,
          brokerDismissedAt: dismissedAt,
        );
  }

  /// Dismisses the exact successfully loaded visible inbox snapshot.
  Future<AttentionClearAllResult> clearAll(
    AttentionInboxSections sections,
  ) async {
    final entries = List<AttentionInboxEntry>.unmodifiable(sections.all);
    if (entries.isEmpty) return const AttentionClearAllResult();

    final snapshots = [
      for (final entry in entries)
        AttentionEventSnapshot(
          brokerProfileId: _attentionScopeKey(entry.profile),
          eventId: entry.event.id,
          revision: entry.event.revision,
        ),
    ];
    final entriesBySnapshot = {
      for (final entry in entries)
        _snapshotKey(
          _attentionScopeKey(entry.profile),
          entry.event.id,
          entry.event.revision,
        ): entry,
    };

    final repository = ref.read(attentionRepositoryProvider);
    final locallyDismissed = await repository.markSnapshotDismissed(snapshots);
    if (locallyDismissed.isEmpty) return const AttentionClearAllResult();
    _invalidate();

    final notificationIds = <String>{};
    for (final snapshot in locallyDismissed) {
      final entry =
          entriesBySnapshot[_snapshotKey(
            snapshot.brokerProfileId,
            snapshot.eventId,
            snapshot.revision,
          )];
      if (entry == null) continue;
      notificationIds.addAll(
        attentionNotificationIdsForEvent(
          brokerProfileId: entry.profile.id,
          event: entry.event,
        ),
      );
    }
    try {
      await ref
          .read(sessionLocalNotificationSinkProvider)
          .clearMany(notificationIds);
    } on Object {
      // The durable local dismissal wins over platform notification-center
      // failures.
    }

    final profilesByScope = {
      for (final entry in entries)
        _attentionScopeKey(entry.profile): entry.profile,
    };
    final pendingByProfile = <String, List<AttentionEventSnapshot>>{};
    for (final item in locallyDismissed) {
      pendingByProfile.putIfAbsent(item.brokerProfileId, () => []).add(item);
    }

    var pendingProfiles = 0;
    var staleEvents = 0;
    String? clientId;
    try {
      clientId = await ref.read(attentionClientIdProvider.future);
    } on Object {
      pendingProfiles = pendingByProfile.length;
    }
    if (clientId != null) {
      for (final profileEntry in pendingByProfile.entries) {
        final profile = profilesByScope[profileEntry.key];
        if (profile == null) {
          pendingProfiles += 1;
          continue;
        }
        try {
          final client = await ref.read(
            attentionProfileClientProvider(profile).future,
          );
          for (
            var offset = 0;
            offset < profileEntry.value.length;
            offset += attentionBulkDismissMax
          ) {
            final end =
                offset + attentionBulkDismissMax < profileEntry.value.length
                ? offset + attentionBulkDismissMax
                : profileEntry.value.length;
            final result = await client.dismissAttentionEvents(
              profileEntry.value
                  .sublist(offset, end)
                  .map((snapshot) => snapshot.bulkItem)
                  .toList(growable: false),
              clientId: clientId,
            );
            staleEvents += await repository.reconcileBulkDismissResult(
              brokerProfileId: profileEntry.key,
              result: result,
            );
          }
        } on Object {
          // Local revision-scoped dismissals stay durable for the profile
          // mutation drain.
          pendingProfiles += 1;
        }
      }
    }
    if (staleEvents > 0) {
      // This is a broker conflict correction, not a second Clear-all
      // invalidation: the newer rows must become visible again.
      _invalidate();
    }
    return AttentionClearAllResult(
      locallyDismissed: locallyDismissed.length,
      pendingProfiles: pendingProfiles,
      staleEvents: staleEvents,
    );
  }

  static String _snapshotKey(
    String brokerProfileId,
    String eventId,
    int revision,
  ) => '$brokerProfileId\u0000$eventId\u0000$revision';

  void _invalidate() {
    ref.read(attentionInboxRevisionProvider.notifier).state += 1;
  }

  Future<void> _clearNotification(AttentionInboxEntry entry) async {
    // Clear through the concrete local sink even when presentation has since
    // been disabled. A notification shown before the setting changed must
    // still disappear when its inbox event is read or dismissed. The event-id
    // alias also removes a permission/question notification left by a client
    // version from before the cold-start identity handoff.
    final ids = attentionNotificationIdsForEvent(
      brokerProfileId: entry.profile.id,
      event: entry.event,
    );
    try {
      await ref.read(sessionLocalNotificationSinkProvider).clearMany(ids);
    } on Object {
      // Local read/dismiss state is authoritative. Platform cleanup remains
      // best effort and does not block durable mutation or broker retry.
    }
  }
}

String _attentionScopeKey(BrokerProfile profile) =>
    RosterSource.ofProfile(profile).storageKey;

/// Result of one exact-snapshot Clear all operation.
final class AttentionClearAllResult {
  /// Creates a Clear all result.
  const AttentionClearAllResult({
    this.locallyDismissed = 0,
    this.pendingProfiles = 0,
    this.staleEvents = 0,
  });

  /// Rows changed by the one local transaction.
  final int locallyDismissed;

  /// Profiles with at least one bounded bulk chunk still pending offline.
  final int pendingProfiles;

  /// Obsolete local dismissals released after broker conflict.
  final int staleEvents;

  /// Whether any broker profile will retry later.
  bool get hasPendingSync => pendingProfiles > 0;
}
