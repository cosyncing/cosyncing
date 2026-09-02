import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

/// The Settings hub: layer one of a two-layer information architecture.
///
/// This page lists categories and nothing else. Every control lives on the
/// category page it belongs to, so the hub stays short enough to scan in one
/// screen rather than being the flat wall of every setting in the app that it
/// used to be.
///
class SettingsPage extends StatelessWidget {
  /// Creates the [SettingsPage].
  const SettingsPage({this.showSessionsBack = false, super.key});

  /// Shows contextual navigation back to the wide Sessions workspace.
  final bool showSessionsBack;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);

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
                  tileKey: const Key('settings-category-usage'),
                  icon: Icons.query_stats_outlined,
                  title: l10n.usageHubTileTitle,
                  subtitle: l10n.usageHubTileSubtitle,
                  onTap: () => context.push(usageReportRoute),
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
          ],
        ),
      ),
    );
  }
}
