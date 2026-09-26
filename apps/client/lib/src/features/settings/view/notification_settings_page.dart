import 'dart:async';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/errors/localized_user_facing_error.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_delivery_settings_controller.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_runtime.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_worker.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_remote_wake_runtime.dart';
import 'package:cosyncing_client/src/features/attention/controller/notification_system_controller.dart';
import 'package:cosyncing_client/src/features/attention/controller/push_token_provider.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_notification_type_settings_store.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_notification_type.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/settings/controller/session_notification_settings_controller.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:cosyncing_client/src/platform/android/android_background_connection.dart';
import 'package:cosyncing_client/src/platform/desktop/desktop_keep_running.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Settings → Notifications: how and where this device gets told about work.
///
/// Three layers, top to bottom: the master switch with the OS permission it
/// needs, the per-type list (on Android each type is a system channel the
/// user owns in Android settings), and the per-Server feed.
/// See `docs/architecture/client-ui.md`.
class NotificationSettingsPage extends ConsumerWidget {
  /// Creates the notification settings category page.
  const NotificationSettingsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final masterState = ref.watch(
      sessionNotificationSettingsControllerProvider,
    );
    final attentionDeliveryState = ref.watch(
      attentionDeliverySettingsControllerProvider,
    );
    final brokerProfilesState = ref.watch(brokerProfileListProvider);
    final attentionSupport = ref.watch(attentionFeedSupportProvider);
    final remoteWakeAvailable =
        ref.watch(pushTokenProviderProvider) is! NoopPushTokenProvider;

    return Scaffold(
      appBar: AppBar(title: Text(l10n.settingsCategoryNotificationsTitle)),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            SettingsSection(
              title: l10n.settingsSystemNotificationsTitle,
              child: _SystemNotificationsSection(
                enabled: masterState.valueOrNull ?? false,
                isLoading: masterState.isLoading,
                error: masterState.hasError
                    ? localizedFailureMessage(
                        l10n,
                        masterState.error!,
                        lead: l10n.notificationSettingsLoadFailed,
                      )
                    : null,
              ),
            ),
            const SizedBox(height: 16),
            SettingsSection(
              title: l10n.settingsNotificationTypesTitle,
              child: const _NotificationTypesSection(),
            ),
            const SizedBox(height: 16),
            SettingsSection(
              title: l10n.settingsSectionAttentionDelivery,
              child: _AttentionDeliverySection(
                state: attentionDeliveryState,
                profiles: brokerProfilesState,
                support: attentionSupport,
                remoteWakeAvailable: remoteWakeAvailable,
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

class _SystemNotificationsSection extends ConsumerWidget {
  const _SystemNotificationsSection({
    required this.enabled,
    required this.isLoading,
    this.error,
  });

  final bool enabled;
  final bool isLoading;
  final String? error;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final secondary = theme.textTheme.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    final permission = ref
        .watch(notificationPermissionControllerProvider)
        .valueOrNull;
    final lastDelivery = ref.watch(lastAttentionNotificationDeliveryProvider);

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SwitchListTile(
          key: const Key('settings-local-session-notifications'),
          contentPadding: EdgeInsets.zero,
          title: Text(l10n.settingsSystemNotificationsTitle),
          subtitle: Text(l10n.settingsSystemNotificationsSubtitle),
          value: enabled,
          onChanged: isLoading
              ? null
              : (value) => unawaited(
                  ref
                      .read(
                        sessionNotificationSettingsControllerProvider.notifier,
                      )
                      .setEnabled(enabled: value),
                ),
        ),
        if (permission != null) ...[
          const SizedBox(height: 8),
          _PermissionStatus(status: permission),
        ],
        if (desktopKeepRunningSupported) const _DesktopKeepRunningSwitch(),
        if (androidBackgroundConnectionSupported)
          _AndroidBackgroundConnectionSwitch(notificationsEnabled: enabled),
        const SizedBox(height: 12),
        Wrap(
          spacing: 12,
          runSpacing: 8,
          crossAxisAlignment: WrapCrossAlignment.center,
          children: [
            OutlinedButton.icon(
              key: const Key('settings-send-test-notification'),
              onPressed: () => unawaited(
                sendAttentionTestNotification(
                  ProviderScope.containerOf(context),
                  l10n,
                ),
              ),
              icon: const Icon(Icons.notifications_active_outlined, size: 16),
              label: Text(l10n.settingsNotificationSendTest),
            ),
            if (lastDelivery != null)
              SelectableText(
                l10n.settingsNotificationLastDelivery(
                  _deliveryCopy(l10n, lastDelivery.result),
                ),
                key: const Key('settings-last-notification-delivery'),
                style: secondary,
              ),
          ],
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

/// Whether closing the window keeps the app, and so its notifications,
/// running (macOS and Windows).
class _DesktopKeepRunningSwitch extends ConsumerWidget {
  const _DesktopKeepRunningSwitch();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final state = ref.watch(desktopKeepRunningControllerProvider);
    return SwitchListTile(
      key: const Key('settings-desktop-keep-running'),
      contentPadding: EdgeInsets.zero,
      title: Text(l10n.desktopKeepRunningTitle),
      subtitle: Text(
        defaultTargetPlatform == TargetPlatform.macOS
            ? l10n.desktopKeepRunningSubtitleMacos
            : l10n.desktopKeepRunningSubtitleWindows,
      ),
      value: state.valueOrNull ?? true,
      onChanged: state.hasValue
          ? (value) => unawaited(
              ref
                  .read(desktopKeepRunningControllerProvider.notifier)
                  .setEnabled(enabled: value),
            )
          : null,
    );
  }
}

/// Whether the app stays connected, and so notifies, after the user leaves
/// it. It only runs while notifications are on.
class _AndroidBackgroundConnectionSwitch extends ConsumerWidget {
  const _AndroidBackgroundConnectionSwitch({
    required this.notificationsEnabled,
  });

  final bool notificationsEnabled;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final state = ref.watch(androidBackgroundConnectionControllerProvider);
    return SwitchListTile(
      key: const Key('settings-android-background-connection'),
      contentPadding: EdgeInsets.zero,
      title: Text(l10n.androidBackgroundConnectionTitle),
      subtitle: Text(l10n.androidBackgroundConnectionSubtitle),
      value: notificationsEnabled && (state.valueOrNull ?? false),
      onChanged: notificationsEnabled && state.hasValue
          ? (value) => unawaited(
              ref
                  .read(androidBackgroundConnectionControllerProvider.notifier)
                  .setEnabled(enabled: value),
            )
          : null,
    );
  }
}

class _PermissionStatus extends ConsumerWidget {
  const _PermissionStatus({required this.status});

  final NotificationPermissionStatus status;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final secondary = theme.textTheme.bodySmall?.copyWith(
      color: theme.colorScheme.onSurfaceVariant,
    );
    final launcher = ref.watch(notificationSystemSettingsLauncherProvider);
    final label = switch (status.state) {
      NotificationPermissionState.granted =>
        l10n.settingsNotificationPermissionGranted,
      NotificationPermissionState.notGranted =>
        l10n.settingsNotificationPermissionNotRequested,
      NotificationPermissionState.denied =>
        l10n.settingsNotificationPermissionDenied,
      NotificationPermissionState.unsupported =>
        l10n.settingsNotificationPermissionUnsupported,
      NotificationPermissionState.error =>
        l10n.settingsNotificationPermissionErrorWithReason(
          status.reason ?? '',
        ),
    };
    final help = switch (status.state) {
      NotificationPermissionState.denied =>
        kIsWeb
            ? l10n.settingsNotificationDeniedHelpWeb
            : l10n.settingsNotificationDeniedHelp,
      NotificationPermissionState.unsupported => switch (status.reason) {
        'insecure-context' => l10n.settingsNotificationInsecureContext,
        'group-policy' || 'manifest' => l10n.settingsNotificationManagedOff,
        _ => l10n.settingsNotificationNoApi,
      },
      _ => null,
    };

    return Column(
      key: const Key('settings-notification-permission'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SelectableText(
          l10n.settingsNotificationPermissionStatus(label),
          style: secondary,
        ),
        if (help != null) ...[
          const SizedBox(height: 4),
          SelectableText(help, style: secondary),
        ],
        if (status.state == NotificationPermissionState.notGranted)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: TextButton(
              key: const Key('settings-request-os-notification-permission'),
              onPressed: () => unawaited(
                ref
                    .read(notificationPermissionControllerProvider.notifier)
                    .request(),
              ),
              child: Text(l10n.settingsNotificationAllow),
            ),
          ),
        if (status.state == NotificationPermissionState.denied &&
            launcher.isSupported)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: TextButton(
              key: const Key('settings-open-system-notification-settings'),
              onPressed: () => unawaited(launcher.open()),
              child: Text(l10n.settingsNotificationOpenSystemSettings),
            ),
          ),
      ],
    );
  }
}

class _NotificationTypesSection extends ConsumerWidget {
  const _NotificationTypesSection();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final systemManaged = ref
        .watch(sessionLocalNotificationAdapterProvider)
        .systemManagesChannels;
    final settings =
        ref
            .watch(attentionNotificationTypeSettingsControllerProvider)
            .valueOrNull ??
        AttentionNotificationTypeSettings.defaults();
    final channels = systemManaged
        ? ref.watch(attentionNotificationChannelStatesProvider).valueOrNull ??
              const <String, NotificationChannelState>{}
        : const <String, NotificationChannelState>{};

    return Column(
      key: const Key('settings-notification-types'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SelectableText(
          systemManaged
              ? l10n.settingsNotificationTypesAndroidHint
              : l10n.settingsNotificationTypesHint,
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        for (final family in AttentionNotificationFamily.values) ...[
          const SizedBox(height: 16),
          Text(
            attentionNotificationFamilyName(family, l10n),
            style: theme.textTheme.labelMedium?.copyWith(
              color: theme.colorScheme.onSurfaceVariant,
            ),
          ),
          for (final type in AttentionNotificationType.values)
            if (type.family == family)
              _NotificationTypeRow(
                type: type,
                setting: settings[type],
                channel: systemManaged ? channels[type.channelId] : null,
                systemManaged: systemManaged,
              ),
        ],
      ],
    );
  }
}

class _NotificationTypeRow extends ConsumerWidget {
  const _NotificationTypeRow({
    required this.type,
    required this.setting,
    required this.channel,
    required this.systemManaged,
  });

  final AttentionNotificationType type;
  final AttentionNotificationTypeSetting setting;
  final NotificationChannelState? channel;
  final bool systemManaged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    final enabled = systemManaged
        ? channel?.enabled ?? type.defaultEnabled
        : setting.enabled;
    final Widget trailing;
    if (systemManaged) {
      final sound = channel?.sound ?? type.defaultSound;
      trailing = Text(
        !enabled
            ? l10n.settingsNotificationTypeOff
            : sound
            ? l10n.settingsNotificationTypeOn
            : l10n.settingsNotificationTypeSilent,
        style: theme.textTheme.labelMedium?.copyWith(
          color: enabled
              ? theme.colorScheme.onSurface
              : theme.colorScheme.onSurfaceVariant,
        ),
      );
    } else {
      trailing = Switch(
        value: enabled,
        onChanged: (value) => unawaited(
          ref
              .read(
                attentionNotificationTypeSettingsControllerProvider.notifier,
              )
              .set(type, setting.copyWith(enabled: value)),
        ),
      );
    }

    return ListTile(
      key: Key('settings-notification-type-${type.id}'),
      contentPadding: EdgeInsets.zero,
      title: Text(attentionNotificationTypeName(type, l10n)),
      subtitle: Text(attentionNotificationTypeDescription(type, l10n)),
      trailing: trailing,
      onTap: () => unawaited(
        showDialog<void>(
          context: context,
          builder: (_) => _NotificationTypeDialog(
            type: type,
            systemManaged: systemManaged,
          ),
        ),
      ),
    );
  }
}

/// Per-type detail, the app's counterpart of Android's channel page.
class _NotificationTypeDialog extends ConsumerWidget {
  const _NotificationTypeDialog({
    required this.type,
    required this.systemManaged,
  });

  final AttentionNotificationType type;
  final bool systemManaged;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final settings =
        ref
            .watch(attentionNotificationTypeSettingsControllerProvider)
            .valueOrNull ??
        AttentionNotificationTypeSettings.defaults();
    final setting = settings[type];
    final launcher = ref.watch(notificationSystemSettingsLauncherProvider);
    final controller = ref.read(
      attentionNotificationTypeSettingsControllerProvider.notifier,
    );

    return AlertDialog(
      key: Key('settings-notification-type-dialog-${type.id}'),
      title: Text(attentionNotificationTypeName(type, l10n)),
      content: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(attentionNotificationTypeDescription(type, l10n)),
            const SizedBox(height: 8),
            if (!systemManaged) ...[
              SwitchListTile(
                key: Key('settings-notification-type-enabled-${type.id}'),
                contentPadding: EdgeInsets.zero,
                title: Text(attentionNotificationTypeName(type, l10n)),
                value: setting.enabled,
                onChanged: (value) => unawaited(
                  controller.set(type, setting.copyWith(enabled: value)),
                ),
              ),
              SwitchListTile(
                key: Key('settings-notification-type-sound-${type.id}'),
                contentPadding: EdgeInsets.zero,
                title: Text(l10n.settingsNotificationTypeSound),
                value: setting.sound,
                onChanged: setting.enabled
                    ? (value) => unawaited(
                        controller.set(type, setting.copyWith(sound: value)),
                      )
                    : null,
              ),
            ],
            SwitchListTile(
              key: Key('settings-notification-type-title-${type.id}'),
              contentPadding: EdgeInsets.zero,
              title: Text(l10n.settingsNotificationTypeShowTitle),
              subtitle: Text(l10n.settingsNotificationTypeShowTitleSubtitle),
              value: setting.showSessionTitle,
              onChanged: (value) => unawaited(
                controller.set(
                  type,
                  setting.copyWith(showSessionTitle: value),
                ),
              ),
            ),
          ],
        ),
      ),
      actions: [
        if (systemManaged && launcher.isSupported)
          TextButton(
            key: Key('settings-notification-type-system-${type.id}'),
            onPressed: () =>
                unawaited(launcher.open(channelId: type.channelId)),
            child: Text(l10n.settingsNotificationOpenSystemSettings),
          ),
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(MaterialLocalizations.of(context).closeButtonLabel),
        ),
      ],
    );
  }
}

String _deliveryCopy(
  AppLocalizations l10n,
  BrokerNotificationDeliveryResult result,
) {
  final reason = result.reason ?? '';
  return switch (result.outcome) {
    BrokerNotificationDeliveryOutcome.shown =>
      l10n.settingsNotificationDeliveryShown,
    BrokerNotificationDeliveryOutcome.blocked =>
      l10n.settingsNotificationDeliveryBlocked(reason),
    BrokerNotificationDeliveryOutcome.unavailable =>
      l10n.settingsNotificationDeliveryUnavailable(reason),
    BrokerNotificationDeliveryOutcome.failed =>
      l10n.settingsNotificationDeliveryFailed(reason),
  };
}

class _AttentionDeliverySection extends StatelessWidget {
  const _AttentionDeliverySection({
    required this.state,
    required this.profiles,
    required this.support,
    required this.remoteWakeAvailable,
    required this.onProfileChanged,
    required this.onRemoteWakeChanged,
  });

  final AsyncValue<AttentionDeliverySettingsState> state;
  final AsyncValue<List<BrokerProfile>> profiles;
  final Map<String, AttentionFeedSupportState> support;

  /// Whether this build has a push provider; without one the remote-wake
  /// switch would be a control that does nothing, so it is not shown.
  final bool remoteWakeAvailable;
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
            if (remoteWakeAvailable) ...[
              const Divider(height: 24),
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
