import 'package:cosyncing_client/src/features/attention/data/attention_feed_settings_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_list_state.dart';

/// Minimal lifecycle contract owned by the multi-profile coordinator.
abstract interface class AttentionFeedRunner {
  /// Starts polling this broker profile.
  void start();

  /// Stops polling and waits for any in-flight request to retire without
  /// publishing another page.
  Future<void> stop();
}

/// Creates one authenticated runner for a saved broker profile.
typedef AttentionFeedRunnerFactory =
    Future<AttentionFeedRunner> Function(BrokerProfile profile);

/// Reports a profile-scoped worker construction or lifecycle failure.
typedef AttentionFeedProfileErrorHandler =
    void Function(String brokerProfileId, Object error);

/// Keeps exactly one feed worker for each enabled, saved broker profile.
///
/// The global local-notification preference changes presentation only. Durable
/// feed polling remains controlled by per-profile choices so the inbox still
/// catches up when OS notifications are disabled.
///
/// See `docs/architecture/client-ui.md`.
final class AttentionFeedCoordinator {
  /// Creates a coordinator with injected settings and runner construction.
  AttentionFeedCoordinator({
    required this.settingsStore,
    required this.createRunner,
    this.onProfileError,
    this.onSettingsChanged,
  });

  /// Durable per-profile opt-in store.
  final AttentionFeedSettingsStore settingsStore;

  /// Authenticated worker factory.
  final AttentionFeedRunnerFactory createRunner;

  /// Optional diagnostic callback; one bad profile never blocks the others.
  final AttentionFeedProfileErrorHandler? onProfileError;

  /// Optional settings observer for downstream UI refreshes.
  final void Function()? onSettingsChanged;

  final Map<String, _OwnedAttentionFeedRunner> _runners = {};
  Future<void> _serial = Future<void>.value();
  bool _disposed = false;

  /// Profile ids currently owning a running worker.
  Set<String> get runningProfileIds => Set.unmodifiable(_runners.keys);

  /// Reconciles worker ownership with current consent and saved profiles.
  Future<void> reconcile({
    required bool notificationsEnabled,
    required List<BrokerProfile> profiles,
    required String? activeProfileId,
    bool restartExisting = false,
  }) {
    final operation = _serial.then(
      (_) => _reconcileNow(
        notificationsEnabled: notificationsEnabled,
        profiles: profiles,
        activeProfileId: activeProfileId,
        restartExisting: restartExisting,
      ),
    );
    _serial = operation.catchError((Object _) {});
    return operation;
  }

  /// Stops every worker and rejects future reconciliation work.
  Future<void> stop() async {
    _disposed = true;
    await _serial;
    final entries = _runners.entries.toList(growable: false);
    _runners.clear();
    await Future.wait(
      entries.map((entry) => _stopRunner(entry.key, entry.value.runner)),
    );
  }

  Future<void> _reconcileNow({
    required bool notificationsEnabled,
    required List<BrokerProfile> profiles,
    required String? activeProfileId,
    required bool restartExisting,
  }) async {
    if (_disposed) return;

    // Default-on: every saved profile is polled unless the user explicitly
    // disabled its feed. See [AttentionFeedSettingsStore].
    final disabledIds = (await settingsStore.listDisabledProfileIds()).toSet();
    final savedProfiles = {for (final profile in profiles) profile.id: profile};

    final desiredIds = savedProfiles.keys.toSet().difference(disabledIds);
    final obsoleteIds = _runners.keys
        .where((profileId) {
          if (restartExisting || !desiredIds.contains(profileId)) return true;
          final profile = savedProfiles[profileId];
          final owned = _runners[profileId];
          return profile == null ||
              owned == null ||
              owned.source != RosterSource.ofProfile(profile);
        })
        .toList(growable: false);
    for (final profileId in obsoleteIds) {
      final owned = _runners.remove(profileId);
      if (owned != null) await _stopRunner(profileId, owned.runner);
    }

    for (final profileId in desiredIds) {
      if (_runners.containsKey(profileId)) continue;
      final profile = savedProfiles[profileId];
      if (profile == null) continue;
      try {
        final runner = await createRunner(profile);
        if (_disposed) {
          await runner.stop();
          continue;
        }
        _runners[profileId] = _OwnedAttentionFeedRunner(
          source: RosterSource.ofProfile(profile),
          runner: runner,
        );
        runner.start();
      } on Object catch (error) {
        onProfileError?.call(profileId, error);
      }
    }
  }

  Future<void> _stopRunner(
    String profileId,
    AttentionFeedRunner runner,
  ) async {
    try {
      await runner.stop();
    } on Object catch (error) {
      onProfileError?.call(profileId, error);
    }
  }
}

final class _OwnedAttentionFeedRunner {
  const _OwnedAttentionFeedRunner({
    required this.source,
    required this.runner,
  });

  final RosterSource source;
  final AttentionFeedRunner runner;
}
