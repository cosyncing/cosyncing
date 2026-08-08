import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/settings/controller/broker_credentials_controller.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

/// The Settings hub: layer one of a two-layer information architecture.
///
/// This page lists categories and nothing else. Every control lives on the
/// category page it belongs to, so the hub stays short enough to scan in one
/// screen rather than being the flat wall of every setting in the app that it
/// used to be.
///
/// Sign out is the exception. It is an action rather than a category, so it
/// sits below the list, separated, in the error colour and without a chevron —
/// the row does not lead anywhere, it does something.
class SettingsPage extends ConsumerWidget {
  /// Creates the [SettingsPage].
  const SettingsPage({this.showSessionsBack = false, super.key});

  /// Shows contextual navigation back to the wide Sessions workspace.
  final bool showSessionsBack;

  Future<void> _signOut(BuildContext context, WidgetRef ref) async {
    final l10n = AppLocalizations.of(context);
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(l10n.settingsSignOutConfirmTitle),
        content: Text(l10n.settingsSignOutConfirmBody),
        actions: [
          const SettingsDialogCancelButton(),
          SettingsDialogConfirmButton(label: l10n.settingsSignOutAction),
        ],
      ),
    );
    if (confirmed != true || !context.mounted) return;
    await ref.read(brokerCredentialsControllerProvider.notifier).signOut();
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final activeProfile = ref.watch(activeBrokerProfileProvider);
    final credentialState = ref.watch(brokerCredentialsControllerProvider);

    return Scaffold(
      appBar: AppBar(
        leading: showSessionsBack
            ? IconButton(
                key: const Key('settings-back-to-sessions'),
                tooltip: l10n.settingsBackToSessions,
                onPressed: () => context.go(sessionsRoute),
                icon: const Icon(Icons.arrow_back),
              )
            : null,
        title: Text(l10n.settingsTitle),
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            SettingsLinkGroup(
              tiles: [
                SettingsLinkTile(
                  tileKey: const Key('settings-category-display'),
                  icon: Icons.palette_outlined,
                  title: l10n.settingsCategoryDisplayTitle,
                  subtitle: l10n.settingsCategoryDisplaySubtitle,
                  onTap: () => context.push(displaySettingsRoute),
                ),
                SettingsLinkTile(
                  tileKey: const Key('settings-category-notifications'),
                  icon: Icons.notifications_outlined,
                  title: l10n.settingsCategoryNotificationsTitle,
                  subtitle: l10n.settingsCategoryNotificationsSubtitle,
                  onTap: () => context.push(notificationSettingsRoute),
                ),
                SettingsLinkTile(
                  tileKey: const Key('settings-category-broker'),
                  icon: Icons.storage_outlined,
                  title: l10n.settingsCategoryBrokerTitle,
                  subtitle: l10n.settingsCategoryBrokerSubtitle,
                  onTap: () => context.push(brokerDevicesSettingsRoute),
                ),
                SettingsLinkTile(
                  tileKey: const Key('settings-category-agents'),
                  icon: Icons.smart_toy_outlined,
                  title: l10n.settingsCategoryAgentsTitle,
                  subtitle: l10n.settingsCategoryAgentsSubtitle,
                  onTap: () => context.push(agentsSettingsRoute),
                ),
                SettingsLinkTile(
                  tileKey: const Key('settings-category-general'),
                  icon: Icons.tune_outlined,
                  title: l10n.settingsCategoryGeneralTitle,
                  subtitle: l10n.settingsCategoryGeneralSubtitle,
                  onTap: () => context.push(generalSettingsRoute),
                ),
              ],
            ),
            const SizedBox(height: 24),
            _SignOutSection(
              isBusy: credentialState.isBusy,
              hasCredential: activeProfile?.credentialKey != null,
              onSignOut: () => _signOut(context, ref),
            ),
          ],
        ),
      ),
    );
  }
}

/// Destructive sign-out control.
///
/// Clearing credentials is user-initiated only. Stored credentials are
/// deliberately retained indefinitely otherwise; this is the escape hatch, not
/// an expiry mechanism. See `docs/architecture/client-ui.md`.
class _SignOutSection extends StatelessWidget {
  const _SignOutSection({
    required this.isBusy,
    required this.hasCredential,
    required this.onSignOut,
  });

  final bool isBusy;
  final bool hasCredential;
  final Future<void> Function() onSignOut;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final colors = Theme.of(context).colorScheme;
    return Card(
      margin: EdgeInsets.zero,
      child: ListTile(
        key: const Key('settings-sign-out'),
        leading: Icon(Icons.logout, color: colors.error),
        title: Text(
          l10n.settingsSignOutAction,
          style: TextStyle(color: colors.error),
        ),
        subtitle: Text(
          hasCredential
              ? l10n.settingsSignOutSubtitleHasCredential
              : l10n.settingsSignOutSubtitleNoCredential,
        ),
        enabled: !isBusy,
        onTap: isBusy ? null : () => unawaited(onSignOut()),
      ),
    );
  }
}
