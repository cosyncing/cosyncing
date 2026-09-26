import 'dart:async';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/attention/controller/notification_system_controller.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/settings/controller/session_notification_settings_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Whether to offer system notifications: the user has never chosen, a
/// Server is paired, and turning them on can work here — permission is
/// granted or not yet asked. (Refused, unsupported, or broken platforms are
/// explained in Settings instead of offering a switch that does nothing.)
final notificationOnboardingVisibleProvider = Provider<bool>((ref) {
  final preference = ref.watch(sessionNotificationPreferenceProvider);
  if (!preference.hasValue || preference.value != null) return false;
  final profiles = ref.watch(brokerProfileListProvider).valueOrNull;
  if (profiles == null || profiles.isEmpty) return false;
  final permission = ref
      .watch(notificationPermissionControllerProvider)
      .valueOrNull
      ?.state;
  return permission == NotificationPermissionState.granted ||
      permission == NotificationPermissionState.notGranted;
});

/// First-run offer to turn on system notifications.
///
/// "Turn on" enables them and shows the OS prompt in the same tap (browsers
/// only prompt inside a user gesture). "Not now" records an explicit choice,
/// so the card never comes back; Settings keeps the switch.
class NotificationOnboardingBanner extends ConsumerWidget {
  /// Creates the banner.
  const NotificationOnboardingBanner({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final controller = ref.read(
      sessionNotificationSettingsControllerProvider.notifier,
    );

    return SafeArea(
      child: Align(
        alignment: Alignment.bottomCenter,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Material(
            key: const Key('notification-onboarding-banner'),
            color: colors.secondaryContainer,
            elevation: 2,
            borderRadius: BorderRadius.circular(tokens.radiusMd),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 560),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 12, 8),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Icon(
                          Icons.notifications_active_outlined,
                          size: 18,
                          color: colors.onSecondaryContainer,
                        ),
                        const SizedBox(width: 8),
                        Flexible(
                          child: Text(
                            l10n.notificationOnboardingTitle,
                            style: theme.textTheme.labelLarge?.copyWith(
                              color: colors.onSecondaryContainer,
                            ),
                          ),
                        ),
                      ],
                    ),
                    const SizedBox(height: 4),
                    Text(
                      l10n.notificationOnboardingBody,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: colors.onSecondaryContainer,
                      ),
                    ),
                    const SizedBox(height: 4),
                    Row(
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: [
                        TextButton(
                          key: const Key('notification-onboarding-dismiss'),
                          onPressed: () =>
                              unawaited(controller.setEnabled(enabled: false)),
                          child: Text(l10n.notificationOnboardingDismiss),
                        ),
                        const SizedBox(width: 8),
                        FilledButton(
                          key: const Key('notification-onboarding-enable'),
                          onPressed: () =>
                              unawaited(controller.setEnabled(enabled: true)),
                          child: Text(l10n.notificationOnboardingEnable),
                        ),
                      ],
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
