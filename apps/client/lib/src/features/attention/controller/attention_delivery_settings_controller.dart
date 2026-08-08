import 'package:cosyncing_client/src/features/attention/data/attention_feed_settings_store.dart';
import 'package:cosyncing_client/src/features/attention/data/remote_wake_settings_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// User choices for broker feeds and provider-routed opaque wakes.
final class AttentionDeliverySettingsState {
  /// Creates immutable delivery settings.
  AttentionDeliverySettingsState({
    required Set<String> enabledProfileIds,
    required this.remoteWakeEnabled,
  }) : enabledProfileIds = Set.unmodifiable(enabledProfileIds);

  /// Broker profiles whose durable attention feeds are enabled.
  final Set<String> enabledProfileIds;

  /// Whether the app may register an opaque mobile wake token.
  final bool remoteWakeEnabled;
}

/// Durable settings controller for separate feed and remote-wake consent.
final attentionDeliverySettingsControllerProvider =
    AsyncNotifierProvider<
      AttentionDeliverySettingsController,
      AttentionDeliverySettingsState
    >(AttentionDeliverySettingsController.new);

/// Mutates attention-delivery settings and signals runtime reconciliation.
final class AttentionDeliverySettingsController
    extends AsyncNotifier<AttentionDeliverySettingsState> {
  @override
  Future<AttentionDeliverySettingsState> build() async {
    // Feeds are default-on, so the enabled set is every saved profile minus
    // the explicit opt-outs. Watched (not read) so adding or removing a
    // profile refreshes the toggles.
    final profiles = await ref.watch(brokerProfileListProvider.future);
    final disabledProfileIds =
        (await ref
                .read(attentionFeedSettingsStoreProvider)
                .listDisabledProfileIds())
            .toSet();
    final remoteWakeEnabled = await ref
        .read(remoteWakeSettingsStoreProvider)
        .isEnabled();
    return AttentionDeliverySettingsState(
      enabledProfileIds: {
        for (final profile in profiles)
          if (!disabledProfileIds.contains(profile.id)) profile.id,
      },
      remoteWakeEnabled: remoteWakeEnabled,
    );
  }

  /// Enables or disables one broker's durable feed.
  Future<void> setProfileEnabled({
    required String brokerProfileId,
    required bool enabled,
  }) async {
    await ref
        .read(attentionFeedSettingsStoreProvider)
        .setFeedEnabled(brokerProfileId: brokerProfileId, enabled: enabled);
    ref.read(attentionFeedSettingsRevisionProvider.notifier).state += 1;
    ref.invalidateSelf();
    await future;
  }

  /// Enables or disables provider-routed opaque mobile wakes.
  Future<void> setRemoteWakeEnabled({required bool enabled}) async {
    await ref
        .read(remoteWakeSettingsStoreProvider)
        .setEnabled(enabled: enabled);
    ref.read(remoteWakeSettingsRevisionProvider.notifier).state += 1;
    ref.invalidateSelf();
    await future;
  }
}
