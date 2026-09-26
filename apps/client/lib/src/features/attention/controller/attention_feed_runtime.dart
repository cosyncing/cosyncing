import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_delivery_settings_controller.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_coordinator.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_delivery_processor.dart'
    hide AttentionFeedForegroundHandler, AttentionFeedRunFailureFocusMatcher;
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_worker.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_inbox_controller.dart';
import 'package:cosyncing_client/src/features/attention/controller/notification_system_controller.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_feed_settings_store.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_repository.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_inbox.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/settings/controller/locale_controller.dart';
import 'package:cosyncing_client/src/features/settings/controller/session_notification_settings_controller.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Exact Session Detail surface currently visible in the foreground.
final class VisibleAttentionSession {
  /// Creates an exact-source visible-session claim.
  const VisibleAttentionSession({
    required this.source,
    required this.tool,
    required this.sessionId,
    required this.owner,
    required this.isStillVisible,
  });

  /// Exact profile, endpoint, and saved-row incarnation on screen.
  final RosterSource source;

  /// Agent tool key.
  final String tool;

  /// Agent session id.
  final String sessionId;

  /// Page incarnation that owns this claim.
  ///
  /// A responsive rebuild can dispose and recreate the same exact session in
  /// one frame. Ownership prevents the retired page's deferred release from
  /// clearing the replacement page's claim.
  final Object owner;

  /// Revalidates that the owning page is mounted and onstage.
  ///
  /// Provider writes from build/dispose are deferred until the frame boundary.
  /// The matcher calls this synchronous lease first, so a retained offstage
  /// page cannot suppress a completion during that deferred window.
  final bool Function() isStillVisible;
}

/// Every onstage session, used only for duplicate terminal-run suppression.
///
/// A list and not one claim, because the workspace can put more than one pane
/// on screen at a time. Suppression has to cover the whole visible set: a pane
/// that is visible but unfocused is still being read, so notifying for it is
/// exactly the duplicate this provider exists to prevent. One claim per owning
/// page incarnation; order is claim order and carries no meaning.
final visibleAttentionSessionsProvider =
    StateProvider<List<VisibleAttentionSession>>((_) => const []);

/// [claims] with [claim] replacing any earlier claim from the same owner.
List<VisibleAttentionSession> withVisibleAttentionClaim(
  List<VisibleAttentionSession> claims,
  VisibleAttentionSession claim,
) {
  return List<VisibleAttentionSession>.unmodifiable(<VisibleAttentionSession>[
    for (final entry in claims)
      if (!identical(entry.owner, claim.owner)) entry,
    claim,
  ]);
}

/// [claims] without the claim owned by [owner].
List<VisibleAttentionSession> withoutVisibleAttentionClaim(
  List<VisibleAttentionSession> claims,
  Object owner,
) {
  if (!claims.any((entry) => identical(entry.owner, owner))) return claims;
  return List<VisibleAttentionSession>.unmodifiable(<VisibleAttentionSession>[
    for (final entry in claims)
      if (!identical(entry.owner, owner)) entry,
  ]);
}

/// The onstage claim for an exact session, or null when none is visible.
///
/// [VisibleAttentionSession.isStillVisible] is consulted per claim because a
/// deferred release can outlive the page that made it by one frame.
VisibleAttentionSession? matchVisibleAttentionSession(
  List<VisibleAttentionSession> claims, {
  required RosterSource? source,
  required String? tool,
  required String? sessionId,
}) {
  if (source == null) return null;
  for (final claim in claims) {
    if (claim.source != source ||
        claim.tool != tool ||
        claim.sessionId != sessionId) {
      continue;
    }
    try {
      if (claim.isStillVisible()) return claim;
    } on Object {
      // A disposed page can briefly leave its deferred claim behind; a lease
      // that throws is not a visible surface.
    }
  }
  return null;
}

/// Latest foreground arrival eligible for app-root aggregation.
final foregroundAttentionEventProvider = StateProvider<AttentionInboxEntry?>(
  (_) => null,
);

/// Per-profile feed capability learned from live polling.
final attentionFeedSupportProvider =
    StateProvider<Map<String, AttentionFeedSupportState>>((_) => const {});

/// One long-lived multi-profile feed coordinator.
final attentionFeedCoordinatorProvider = Provider<AttentionFeedCoordinator>((
  ref,
) {
  final coordinator = AttentionFeedCoordinator(
    settingsStore: ref.watch(attentionFeedSettingsStoreProvider),
    createRunner: (profile) => _createProfileRunner(ref, profile),
    credentialOf: (profile) => _profileCredential(ref, profile),
    onSettingsChanged: () {
      ref.read(attentionFeedSettingsRevisionProvider.notifier).state += 1;
      ref.invalidate(attentionDeliverySettingsControllerProvider);
    },
  );
  ref.onDispose(() => unawaited(coordinator.stop()));
  return coordinator;
});

/// Stateful bridge that detects only explicit off→on global transitions.
final attentionFeedAppBindingProvider = Provider<_AttentionFeedAppBinding>((
  ref,
) {
  return _AttentionFeedAppBinding(
    coordinator: ref.watch(attentionFeedCoordinatorProvider),
  );
});

/// Root-app trigger that reconciles feed workers after consent/profile changes.
final attentionFeedRuntimeProvider = Provider<void>((ref) {
  final binding = ref.watch(attentionFeedAppBindingProvider);
  final globalState = ref.watch(sessionNotificationSettingsControllerProvider);
  final profilesState = ref.watch(brokerProfileListProvider);
  final activeProfile = ref.watch(activeBrokerProfileProvider);
  ref.watch(attentionFeedSettingsRevisionProvider);
  if (globalState.hasValue && profilesState.hasValue) {
    unawaited(
      _ignoreRuntimeError(
        binding.update(
          notificationsEnabled: globalState.value ?? false,
          profiles: profilesState.value ?? const [],
          activeProfileId: activeProfile?.id,
        ),
      ),
    );
  }
});

/// Root-app trigger that re-presents the open requests the OS refused while
/// notification permission was not granted, once it becomes granted.
final attentionPermissionGrantRuntimeProvider = Provider<void>((ref) {
  ref.listen(notificationPermissionControllerProvider, (previous, next) {
    final was = previous?.valueOrNull?.state;
    final now = next.valueOrNull?.state;
    if (was == null || now != NotificationPermissionState.granted) return;
    if (was == NotificationPermissionState.granted) return;
    unawaited(
      _ignoreRuntimeError(
        ref
            .read(attentionFeedCoordinatorProvider)
            .notificationPermissionGranted(),
      ),
    );
  });
});

/// Root-app mutation drain that retries read/dismiss posts for all saved profiles.
final attentionMutationDrainRuntimeProvider = Provider<void>((ref) {
  final runtime = _AttentionMutationDrainRuntime(ref);
  unawaited(_ignoreRuntimeError(runtime.start()));
  ref.onDispose(runtime.dispose);
});

/// The credential a client for [profile] would send, as stored now: the key
/// alone does not change when a token is pasted over an older one.
Future<Object?> _profileCredential(Ref ref, BrokerProfile profile) async {
  final credentialKey = profile.credentialKey;
  if (credentialKey == null) return null;
  final token = await ref
      .read(credentialStoreProvider)
      .readBrokerToken(credentialKey);
  return (credentialKey, token?.trim());
}

Future<AttentionFeedRunner> _createProfileRunner(
  Ref ref,
  BrokerProfile profile,
) async {
  final client = await createAttentionBrokerClient(ref, profile);
  final clientId = await ref.read(attentionClientIdProvider.future);
  final selectedLocale = await ref.read(localeControllerProvider.future);
  final brokerScopeKey = RosterSource.ofProfile(profile).storageKey;
  final worker = AttentionFeedWorker(
    brokerClient: client,
    repository: ref.read(attentionRepositoryProvider),
    brokerProfileId: profile.id,
    brokerScopeKey: brokerScopeKey,
    clientId: clientId,
    lifecycleMonitor: ref.read(sessionNotificationLifecycleMonitorProvider),
    notificationSink: ref.read(sessionNotificationSinkProvider),
    localizations: resolveAppLocalizations(selectedLocale),
    focusMatcher: attentionRunFailureFocusMatcher(ref, profile),
    onForegroundEvent: attentionForegroundHandler(ref, profile),
    resolveSetting: ref.read(attentionNotificationSettingResolverProvider),
    onDelivery: ref.read(attentionNotificationDeliveryRecorderProvider),
    presentationCoordinator: ref.read(attentionPresentationCoordinatorProvider),
    // Re-read the saved profiles: a token saved since this worker started (in
    // this tab or another) changes the credential and replaces the worker.
    onUnauthorized: () {
      try {
        ref.invalidate(brokerProfileListProvider);
      } on Object {
        // The app is shutting down; there is nothing left to refresh.
      }
    },
    onSupportChanged: (support) {
      final current = ref.read(attentionFeedSupportProvider);
      ref.read(attentionFeedSupportProvider.notifier).state = {
        ...current,
        profile.id: support,
      };
    },
    onPagePersisted: (_) async {
      // The revision bump recomputes the inbox, and the root-app badge
      // runtime (`attentionUnreadBadgeRuntimeProvider`) folds the result
      // into the unread count.
      ref.read(attentionInboxRevisionProvider.notifier).state += 1;
    },
  );
  return _OwnedAttentionFeedRunner(worker: worker, client: client);
}

/// Shared exact-session matcher used by polling and opaque-wake refetch.
AttentionFeedRunFailureFocusMatcher attentionRunFailureFocusMatcher(
  Ref ref,
  BrokerProfile profile,
) {
  final source = RosterSource.ofProfile(profile);
  return ({
    required String? tool,
    required String? agent,
    required String? sessionId,
  }) {
    return matchVisibleAttentionSession(
          ref.read(visibleAttentionSessionsProvider),
          source: source,
          tool: tool,
          sessionId: sessionId,
        ) !=
        null;
  };
}

/// Shared foreground presenter used by polling and opaque-wake refetch.
AttentionFeedForegroundHandler attentionForegroundHandler(
  Ref ref,
  BrokerProfile profile,
) {
  return (event) async {
    ref.read(foregroundAttentionEventProvider.notifier).state =
        AttentionInboxEntry(profile: profile, event: event);
  };
}

Future<void> _ignoreRuntimeError(Future<void> operation) async {
  try {
    await operation;
  } on Object {
    // Per-profile errors surface through support state and retry in workers.
  }
}

final class _OwnedAttentionFeedRunner implements AttentionFeedRunner {
  _OwnedAttentionFeedRunner({required this.worker, required this.client});

  final AttentionFeedWorker worker;
  final BrokerClient client;

  @override
  void start() => worker.start();

  @override
  Future<void> stop() async {
    try {
      await worker.stop();
    } finally {
      client.close();
    }
  }

  @override
  Future<void> presentPermissionBlockedRequests() =>
      worker.presentPermissionBlockedRequests();
}

final class _AttentionFeedAppBinding {
  _AttentionFeedAppBinding({required this.coordinator});

  final AttentionFeedCoordinator coordinator;
  bool? _lastNotificationsEnabled;

  Future<void> update({
    required bool notificationsEnabled,
    required List<BrokerProfile> profiles,
    required String? activeProfileId,
  }) async {
    final restartExisting =
        _lastNotificationsEnabled != null &&
        _lastNotificationsEnabled != notificationsEnabled;
    _lastNotificationsEnabled = notificationsEnabled;
    await coordinator.reconcile(
      notificationsEnabled: notificationsEnabled,
      profiles: profiles,
      activeProfileId: activeProfileId,
      restartExisting: restartExisting,
    );
  }
}

final class _AttentionMutationDrainRuntime {
  _AttentionMutationDrainRuntime(this._ref);

  final Ref _ref;
  Timer? _timer;
  bool _isDraining = false;
  bool _isDisposed = false;

  Future<void> start() async {
    if (_isDisposed) return;
    _timer ??= Timer.periodic(
      const Duration(minutes: 2),
      (_) {
        unawaited(_ignoreMutationDrainError(_drainAllProfiles()));
      },
    );
    await _drainAllProfiles();
  }

  Future<void> _drainAllProfiles() async {
    if (_isDisposed || _isDraining) return;
    _isDraining = true;
    try {
      final profiles = await _ref.read(brokerProfileListProvider.future);
      final repository = _ref.read(attentionRepositoryProvider);
      final lifecycleMonitor = _ref.read(
        sessionNotificationLifecycleMonitorProvider,
      );
      final clientId = await _ref.read(attentionClientIdProvider.future);

      for (final profile in profiles) {
        await _ignoreMutationDrainError(
          _drainProfile(
            profile: profile,
            repository: repository,
            clientId: clientId,
            lifecycleMonitor: lifecycleMonitor,
          ),
        );
      }
    } on Object {
      // Profile loading and client-id bootstrap errors are transient.
    } finally {
      _isDraining = false;
    }
  }

  Future<void> _drainProfile({
    required BrokerProfile profile,
    required AttentionRepository repository,
    required String clientId,
    required BrokerAppLifecycleMonitor lifecycleMonitor,
  }) async {
    final brokerScopeKey = RosterSource.ofProfile(profile).storageKey;
    final pending = await repository.loadPendingMutations(brokerScopeKey);
    if (pending.isEmpty) return;

    final client = await createAttentionBrokerClient(_ref, profile);
    try {
      final processor = AttentionFeedDeliveryProcessor(
        repository: repository,
        brokerProfileId: profile.id,
        brokerScopeKey: brokerScopeKey,
        lifecycleMonitor: lifecycleMonitor,
        notificationSink: const NoopBrokerNotificationSink(),
        onForegroundEvent: (_) async {},
        isCurrentSource: () async {
          if (_isDisposed) return false;
          final current = await _ref
              .read(brokerProfileRepositoryProvider)
              .getById(profile.id);
          return !_isDisposed &&
              current != null &&
              RosterSource.ofProfile(current) ==
                  RosterSource.ofProfile(profile);
        },
        focusMatcher: _ignoreMutationsFocusMatcher,
      );
      final releasedStale = await processor.reconcileMutations(
        brokerClient: client,
        clientId: clientId,
      );
      if (releasedStale > 0) {
        _ref.read(attentionInboxRevisionProvider.notifier).state += 1;
      }
    } finally {
      client.close();
    }
  }

  void dispose() {
    _isDisposed = true;
    _timer?.cancel();
    _timer = null;
  }
}

bool _ignoreMutationsFocusMatcher({
  required String? tool,
  required String? agent,
  required String? sessionId,
}) {
  return false;
}

Future<void> _ignoreMutationDrainError(Future<void> operation) async {
  try {
    await operation;
  } on Object {
    // Keep draining across failures in one profile while retrying others.
  }
}
