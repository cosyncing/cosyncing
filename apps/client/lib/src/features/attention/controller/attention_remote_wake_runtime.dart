import 'dart:async';
import 'dart:ui' as ui;

import 'package:broker_client/broker_client.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_delivery_settings_controller.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_delivery_processor.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_runtime.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_inbox_controller.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_profile_sync_gate.dart';
import 'package:cosyncing_client/src/features/attention/controller/push_token_coordinator.dart';
import 'package:cosyncing_client/src/features/attention/controller/push_token_provider.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_feed_settings_store.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/settings/controller/locale_controller.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Deployment-owned APNs/FCM adapter. Unsupported builds use a no-op source.
final pushTokenProviderProvider = Provider<PushTokenProvider>(
  (_) => const NoopPushTokenProvider(),
);

/// Opaque wake signal adapter; a real mobile build overrides this provider.
final pushWakeSignalProvider = Provider<PushWakeSignalProvider>(
  (ref) {
    final tokenProvider = ref.watch(pushTokenProviderProvider);
    return tokenProvider is PushWakeSignalProvider
        ? tokenProvider as PushWakeSignalProvider
        : const NoopPushTokenProvider();
  },
);

/// Remote wake registration runtime for enabled broker feeds.
final remoteWakeCoordinatorProvider = Provider<RemoteWakeCoordinator>((ref) {
  final coordinator = RemoteWakeCoordinator(
    createRegistration: (profile) => _createRegistration(ref, profile),
  );
  ref.onDispose(() => unawaited(coordinator.stop(revoke: false)));
  return coordinator;
});

/// Root-app reconciliation and opaque-wake refetch trigger.
final attentionRemoteWakeRuntimeProvider = Provider<void>((ref) {
  final settingsState = ref.watch(attentionDeliverySettingsControllerProvider);
  final profilesState = ref.watch(brokerProfileListProvider);
  final coordinator = ref.watch(remoteWakeCoordinatorProvider);
  final signalProvider = ref.watch(pushWakeSignalProvider);

  final settings = settingsState.valueOrNull;
  if (settings != null && settings.remoteWakeEnabled) {
    final subscription = signalProvider.wakeSignals().listen((_) {
      unawaited(_ignoreRemoteWakeError(_refetchEnabledProfiles(ref)));
    });
    ref.onDispose(subscription.cancel);
  }

  if (profilesState.hasValue && settings != null) {
    unawaited(
      _ignoreRemoteWakeError(
        coordinator.reconcile(
          enabled: settings.remoteWakeEnabled,
          profiles: profilesState.value ?? const [],
          enabledProfileIds: settings.enabledProfileIds,
        ),
      ),
    );
  }
});

/// One profile's registration lifecycle.
abstract interface class RemoteWakeRegistration {
  /// Starts initial registration and token-rotation tracking.
  Future<void> start();

  /// Stops token tracking.
  Future<void> stop();

  /// Revokes this installation from the owning broker.
  Future<void> revoke();
}

Future<void> _ignoreRemoteWakeError(Future<void> operation) async {
  try {
    await operation;
  } on Object {
    // Remote wake is best-effort. Durable foreground polling remains the
    // recovery path and Settings exposes unsupported/unavailable states.
  }
}

/// Creates one authenticated profile registration.
typedef RemoteWakeRegistrationFactory =
    Future<RemoteWakeRegistration> Function(BrokerProfile profile);

/// Owns remote token registration for all enabled saved broker profiles.
final class RemoteWakeCoordinator {
  /// Creates a coordinator with injected profile registration construction.
  RemoteWakeCoordinator({
    required this.createRegistration,
    this.onProfileError,
  });

  /// Authenticated registration factory.
  final RemoteWakeRegistrationFactory createRegistration;

  /// Optional observer for one profile's registration/revocation failure.
  final void Function(String profileId, Object error)? onProfileError;

  final Map<String, _OwnedRemoteWakeRegistrationEntry> _registrations = {};
  Future<void> _serial = Future<void>.value();

  /// Reconciles registrations; removal revokes before disposal.
  Future<void> reconcile({
    required bool enabled,
    required List<BrokerProfile> profiles,
    required Set<String> enabledProfileIds,
  }) {
    final operation = _serial.then((_) async {
      final profileById = {for (final profile in profiles) profile.id: profile};
      final desiredIds = enabled
          ? enabledProfileIds.intersection(profileById.keys.toSet())
          : <String>{};
      final obsolete = _registrations.keys
          .where((id) {
            if (!desiredIds.contains(id)) return true;
            final profile = profileById[id];
            final owned = _registrations[id];
            return profile == null ||
                owned == null ||
                owned.source != RosterSource.ofProfile(profile);
          })
          .toList(growable: false);
      for (final id in obsolete) {
        final owned = _registrations.remove(id);
        if (owned == null) continue;
        try {
          await owned.registration.revoke();
        } on Object catch (error) {
          onProfileError?.call(id, error);
        } finally {
          await owned.registration.stop();
        }
      }
      for (final id in desiredIds) {
        if (_registrations.containsKey(id)) continue;
        final profile = profileById[id];
        if (profile == null) continue;
        RemoteWakeRegistration? registration;
        try {
          registration = await createRegistration(profile);
          await registration.start();
          _registrations[id] = _OwnedRemoteWakeRegistrationEntry(
            source: RosterSource.ofProfile(profile),
            registration: registration,
          );
        } on Object catch (error) {
          if (registration != null) await registration.stop();
          onProfileError?.call(id, error);
        }
      }
    });
    _serial = operation.catchError((Object _) {});
    return operation;
  }

  /// Stops every registration, optionally revoking broker tokens first.
  Future<void> stop({required bool revoke}) async {
    await _serial;
    final registrations = _registrations.values
        .map((owned) => owned.registration)
        .toList(growable: false);
    _registrations.clear();
    for (final registration in registrations) {
      if (revoke) await registration.revoke();
      await registration.stop();
    }
  }
}

final class _OwnedRemoteWakeRegistrationEntry {
  const _OwnedRemoteWakeRegistrationEntry({
    required this.source,
    required this.registration,
  });

  final RosterSource source;
  final RemoteWakeRegistration registration;
}

Future<RemoteWakeRegistration> _createRegistration(
  Ref ref,
  BrokerProfile profile,
) async {
  final client = await createAttentionBrokerClient(ref, profile);
  final coordinator = PushTokenCoordinator(
    brokerClient: client,
    brokerProfileId: profile.id,
    tokenProvider: ref.read(pushTokenProviderProvider),
    installationIdStore: ref.read(pushInstallationIdStoreProvider),
    registrationLabel: profile.displayName,
  );
  return _OwnedRemoteWakeRegistration(coordinator: coordinator, client: client);
}

Future<void> _refetchEnabledProfiles(Ref ref) async {
  final profiles = await ref.read(brokerProfileListProvider.future);
  // Feeds are default-on: refetch every saved profile except explicit
  // opt-outs. See [AttentionFeedSettingsStore].
  final disabledIds =
      (await ref
              .read(attentionFeedSettingsStoreProvider)
              .listDisabledProfileIds())
          .toSet();
  final enabledIds = {
    for (final profile in profiles)
      if (!disabledIds.contains(profile.id)) profile.id,
  };
  final clientId = await ref.read(attentionClientIdProvider.future);
  final repository = ref.read(attentionRepositoryProvider);
  final lifecycleMonitor = ref.read(
    sessionNotificationLifecycleMonitorProvider,
  );
  final notificationSink = ref.read(sessionNotificationSinkProvider);

  await refetchAttentionProfilesAfterWake(
    profiles: profiles,
    enabledProfileIds: enabledIds,
    clientId: clientId,
    repository: repository,
    createClient: (profile) => createAttentionBrokerClient(ref, profile),
    isCurrentSource: (profile) => _isCurrentAttentionSource(ref, profile),
    createDeliveryProcessor: (profile, isCurrentSource) =>
        AttentionFeedDeliveryProcessor(
          repository: repository,
          brokerProfileId: profile.id,
          brokerScopeKey: RosterSource.ofProfile(profile).storageKey,
          lifecycleMonitor: lifecycleMonitor,
          notificationSink: notificationSink,
          localizations: lookupAppLocalizations(
            ref.read(localeControllerProvider).valueOrNull ??
                ui.PlatformDispatcher.instance.locale,
          ),
          onForegroundEvent: attentionForegroundHandler(ref, profile),
          isCurrentSource: isCurrentSource,
          focusMatcher: attentionRunFailureFocusMatcher(ref, profile),
        ),
  );
  ref.read(attentionInboxRevisionProvider.notifier).state += 1;
  ref.invalidate(attentionInboxProvider);
}

/// Creates an authenticated client for one wake-refetch profile.
typedef AttentionWakeClientFactory =
    Future<BrokerClient> Function(BrokerProfile profile);

/// Creates the shared presentation processor for one wake-refetch profile.
typedef AttentionWakeDeliveryProcessorFactory =
    AttentionFeedDeliveryProcessor Function(
      BrokerProfile profile,
      AttentionDeliveryAdmission isCurrentSource,
    );

/// Revalidates that an opaque wake still owns the exact durable source.
typedef AttentionWakeCurrentSourceMatcher =
    Future<bool> Function(BrokerProfile profile);

/// Maximum page size used for wake-triggered refetch.
///
/// See `docs/architecture/client-ui.md`.
const int attentionWakePageSize = 100;

/// Maximum pages fetched for one profile after an opaque wake.
const int attentionWakeMaxPages = 5;

/// Result metadata from a wake-triggered refetch.
final class AttentionWakeRefetchResult {
  /// Creates immutable wake-refetch result metadata.
  factory AttentionWakeRefetchResult({
    required Set<String> deferredProfileIds,
  }) => AttentionWakeRefetchResult._(Set.unmodifiable(deferredProfileIds));

  AttentionWakeRefetchResult._(this.deferredProfileIds);

  /// Profiles whose remaining pages are left to resident feed polling.
  final Set<String> deferredProfileIds;
}

/// Fetches and fully reconciles attention pages after one opaque wake.
///
/// A wake is only a lossy signal. This path deliberately shares the durable
/// presentation processor used by resident polling so cursor advancement can
/// never strand an unpresented revision.
Future<AttentionWakeRefetchResult> refetchAttentionProfilesAfterWake({
  required List<BrokerProfile> profiles,
  required Set<String> enabledProfileIds,
  required String clientId,
  required AttentionRepository repository,
  required AttentionWakeClientFactory createClient,
  required AttentionWakeDeliveryProcessorFactory createDeliveryProcessor,
  required AttentionWakeCurrentSourceMatcher isCurrentSource,
  AttentionProfileSyncGate? profileSyncGate,
}) async {
  final gate = profileSyncGate ?? sharedAttentionProfileSyncGate;
  final deferredProfileIds = <String>{};
  for (final profile in profiles) {
    if (!enabledProfileIds.contains(profile.id)) continue;
    if (!await isCurrentSource(profile)) continue;
    final brokerScopeKey = RosterSource.ofProfile(profile).storageKey;
    await gate.run(brokerScopeKey, () async {
      if (!await isCurrentSource(profile)) return;
      final client = await createClient(profile);
      final deliveryProcessor = createDeliveryProcessor(
        profile,
        () => isCurrentSource(profile),
      );
      try {
        if (!await isCurrentSource(profile)) return;
        var cursor = await repository.loadCursor(brokerScopeKey);
        for (
          var pageIndex = 0;
          pageIndex < attentionWakeMaxPages;
          pageIndex += 1
        ) {
          final page = await client.getAttentionEvents(
            clientId: clientId,
            after: cursor,
            limit: attentionWakePageSize,
          );
          if (!await isCurrentSource(profile)) return;
          await repository.persistAttentionEventsPage(
            brokerProfileId: brokerScopeKey,
            page: page,
          );
          // An exact-scoped late commit is harmless to a replacement inbox,
          // but presenting it is not. Revalidate after the opaque persistence
          // await and again immediately before reconciliation.
          if (!await isCurrentSource(profile)) return;
          cursor = await repository.loadCursor(brokerScopeKey);
          if (!await isCurrentSource(profile)) return;
          await deliveryProcessor.reconcile(
            brokerClient: client,
            clientId: clientId,
          );
          if (!page.hasMore) break;
          if (pageIndex == attentionWakeMaxPages - 1) {
            // The resident feed worker continues after this gate is released.
            deferredProfileIds.add(profile.id);
          }
        }
      } on Object {
        // A wake is a best-effort refetch hint. One offline broker must not
        // prevent catch-up from the remaining enabled profiles.
      } finally {
        client.close();
      }
    });
  }

  return AttentionWakeRefetchResult(deferredProfileIds: deferredProfileIds);
}

Future<bool> _isCurrentAttentionSource(
  Ref ref,
  BrokerProfile expected,
) async {
  final current = await ref
      .read(brokerProfileRepositoryProvider)
      .getById(expected.id);
  return current != null &&
      RosterSource.ofProfile(current) == RosterSource.ofProfile(expected);
}

final class _OwnedRemoteWakeRegistration implements RemoteWakeRegistration {
  _OwnedRemoteWakeRegistration({
    required this.coordinator,
    required this.client,
  });

  final PushTokenCoordinator coordinator;
  final BrokerClient client;

  @override
  Future<void> start() => coordinator.start();

  @override
  Future<void> revoke() => coordinator.revokeRegistration();

  @override
  Future<void> stop() async {
    await coordinator.stop();
    client.close();
  }
}
