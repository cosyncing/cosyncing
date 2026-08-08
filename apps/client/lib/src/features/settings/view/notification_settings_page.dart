import 'dart:async';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/errors/localized_user_facing_error.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_delivery_settings_controller.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_runtime.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_worker.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/settings/controller/session_notification_settings_controller.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Settings → Notifications: how and where this device gets told about work.
///
/// Two consents live here and are deliberately kept apart: local OS
/// notifications for sessions on this device, and the per-broker attention feed
/// plus its remote wake channel. See `docs/architecture/client-ui.md`.
class NotificationSettingsPage extends ConsumerWidget {
  /// Creates the notification settings category page.
  const NotificationSettingsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final notificationSettingState = ref.watch(
      sessionNotificationSettingsControllerProvider,
    );
    final permissionRequestState = ref.watch(
      sessionNotificationPermissionRequestControllerProvider,
    );
    final attentionDeliveryState = ref.watch(
      attentionDeliverySettingsControllerProvider,
    );
    final brokerProfilesState = ref.watch(brokerProfileListProvider);
    final attentionSupport = ref.watch(attentionFeedSupportProvider);

    return Scaffold(
      appBar: AppBar(title: Text(l10n.settingsCategoryNotificationsTitle)),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            SettingsSection(
              title: l10n.settingsSectionSessionNotifications,
              child: _LocalSessionNotificationSection(
                enabled: notificationSettingState.valueOrNull ?? false,
                isLoading: notificationSettingState.isLoading,
                isPermissionLoading: permissionRequestState.isLoading,
                error: notificationSettingState.hasError
                    ? localizedFailureMessage(
                        l10n,
                        notificationSettingState.error!,
                        lead: l10n.notificationSettingsLoadFailed,
                      )
                    : null,
                permissionResult: permissionRequestState.valueOrNull,
                onChanged: (value) {
                  unawaited(
                    ref
                        .read(
                          sessionNotificationSettingsControllerProvider
                              .notifier,
                        )
                        .setEnabled(enabled: value),
                  );
                },
                onRequestPermission: () {
                  unawaited(
                    ref
                        .read(
                          sessionNotificationPermissionRequestControllerProvider
                              .notifier,
                        )
                        .requestPermission(),
                  );
                },
              ),
            ),
            const SizedBox(height: 16),
            SettingsSection(
              title: l10n.settingsSectionAttentionDelivery,
              child: _AttentionDeliverySection(
                state: attentionDeliveryState,
                profiles: brokerProfilesState,
                support: attentionSupport,
                onProfileChanged: ({required profileId, required enabled}) =>
                    ref
                        .read(
                          attentionDeliverySettingsControllerProvider.notifier,
                        )
                        .setProfileEnabled(
                          brokerProfileId: profileId,
                          enabled: enabled,
                        ),
                onRemoteWakeChanged: ({required enabled}) => ref
                    .read(attentionDeliverySettingsControllerProvider.notifier)
                    .setRemoteWakeEnabled(enabled: enabled),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _LocalSessionNotificationSection extends StatelessWidget {
  const _LocalSessionNotificationSection({
    required this.enabled,
    required this.isLoading,
    required this.isPermissionLoading,
    required this.onChanged,
    required this.onRequestPermission,
    this.error,
    this.permissionResult,
  });

  final bool enabled;
  final bool isLoading;
  final bool isPermissionLoading;
  final String? error;
  final FlutterLocalNotificationPermissionRequestResult? permissionResult;
  final ValueChanged<bool> onChanged;
  final VoidCallback onRequestPermission;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final permissionOutcome = permissionResult?.outcome;
    final requestMessage = switch (permissionOutcome) {
      FlutterLocalNotificationPermissionRequestOutcome.granted =>
        l10n.settingsNotificationPermissionGranted,
      FlutterLocalNotificationPermissionRequestOutcome.denied =>
        l10n.settingsNotificationPermissionDenied,
      FlutterLocalNotificationPermissionRequestOutcome.unsupported =>
        l10n.settingsNotificationPermissionUnsupported,
      FlutterLocalNotificationPermissionRequestOutcome.failed =>
        l10n.settingsNotificationPermissionFailed,
      null => null,
    };

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SelectableText(
          l10n.settingsLocalNotificationsDescription,
          style: Theme.of(context).textTheme.bodySmall?.copyWith(
            color: Theme.of(context).colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(height: 12),
        SwitchListTile(
          key: const Key('settings-local-session-notifications'),
          contentPadding: EdgeInsets.zero,
          title: Text(l10n.settingsEnableLocalNotifications),
          value: enabled,
          onChanged: isLoading ? null : onChanged,
        ),
        const SizedBox(height: 12),
        OutlinedButton.icon(
          key: const Key('settings-request-os-notification-permission'),
          onPressed: isPermissionLoading ? null : onRequestPermission,
          icon: isPermissionLoading
              ? const SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : const Icon(Icons.notifications_active_outlined),
          label: Text(
            isPermissionLoading
                ? l10n.settingsCheckingPermission
                : l10n.settingsRequestOsPermission,
          ),
        ),
        if (requestMessage != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: SelectableText(
              l10n.settingsNotificationPermissionStatus(requestMessage),
              style: Theme.of(context).textTheme.bodySmall?.copyWith(
                color: Theme.of(context).colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        if (error != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: SelectableText(
              error!,
              style: TextStyle(color: context.tokens.statusError),
            ),
          ),
      ],
    );
  }
}

class _AttentionDeliverySection extends StatelessWidget {
  const _AttentionDeliverySection({
    required this.state,
    required this.profiles,
    required this.support,
    required this.onProfileChanged,
    required this.onRemoteWakeChanged,
  });

  final AsyncValue<AttentionDeliverySettingsState> state;
  final AsyncValue<List<BrokerProfile>> profiles;
  final Map<String, AttentionFeedSupportState> support;
  final Future<void> Function({
    required String profileId,
    required bool enabled,
  })
  onProfileChanged;
  final Future<void> Function({required bool enabled}) onRemoteWakeChanged;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return state.when(
      loading: () => const Center(child: CircularProgressIndicator()),
      error: (error, _) =>
          SelectableText(l10n.settingsAttentionDeliveryUnavailable),
      data: (settings) {
        final savedProfiles = profiles.valueOrNull ?? const <BrokerProfile>[];
        return Column(
          key: const Key('settings-attention-delivery'),
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SelectionArea(
              key: const Key('settings-attention-delivery-description'),
              child: Text(
                l10n.settingsAttentionDeliveryDescription,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: Theme.of(context).colorScheme.onSurfaceVariant,
                ),
              ),
            ),
            const SizedBox(height: 12),
            if (savedProfiles.isEmpty)
              SelectableText(l10n.settingsAttentionNoProfiles)
            else
              for (final profile in savedProfiles)
                Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    SwitchListTile(
                      key: Key('settings-attention-profile-${profile.id}'),
                      contentPadding: EdgeInsets.zero,
                      title: Text(profile.displayName),
                      value: settings.enabledProfileIds.contains(profile.id),
                      onChanged: (enabled) => unawaited(
                        onProfileChanged(
                          profileId: profile.id,
                          enabled: enabled,
                        ),
                      ),
                    ),
                    Padding(
                      padding: const EdgeInsetsDirectional.only(
                        start: 16,
                        end: 16,
                        bottom: 8,
                      ),
                      child: SelectableText(
                        _attentionSupportCopy(l10n, support[profile.id]),
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ),
                  ],
                ),
            const Divider(height: 28),
            SwitchListTile(
              key: const Key('settings-remote-opaque-wake'),
              contentPadding: EdgeInsets.zero,
              title: Text(l10n.settingsRemoteWakeTitle),
              value: settings.remoteWakeEnabled,
              onChanged: (enabled) =>
                  unawaited(onRemoteWakeChanged(enabled: enabled)),
            ),
            Padding(
              padding: const EdgeInsetsDirectional.only(
                start: 16,
                end: 16,
              ),
              child: SelectableText(
                l10n.settingsRemoteWakeSubtitle,
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          ],
        );
      },
    );
  }
}

String _attentionSupportCopy(
  AppLocalizations l10n,
  AttentionFeedSupportState? support,
) {
  return switch (support) {
    AttentionFeedSupportState.supported => l10n.settingsAttentionFeedConnected,
    AttentionFeedSupportState.unsupported =>
      l10n.settingsAttentionFeedUnsupported,
    AttentionFeedSupportState.unknown ||
    null => l10n.settingsAttentionFeedUnknown,
  };
}
