import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_roster_projection.dart';
import 'package:cosyncing_client/src/features/settings/controller/session_visibility_controller.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

/// Settings → Display: everything that changes how the app presents itself.
///
/// Theme, text size, density, and language live one level further in on the
/// Appearance page; language is a presentation choice, so it belongs to this
/// category rather than to a top-level entry of its own.
class DisplaySettingsPage extends ConsumerWidget {
  /// Creates the display settings category page.
  const DisplaySettingsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final sessionVisibility =
        ref.watch(sessionVisibilityControllerProvider).valueOrNull ??
        const SessionVisibilityPreferences();

    return Scaffold(
      appBar: AppBar(title: Text(l10n.settingsCategoryDisplayTitle)),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            SettingsLinkGroup(
              tiles: [
                SettingsLinkTile(
                  tileKey: const Key('settings-appearance'),
                  icon: Icons.palette_outlined,
                  title: l10n.appearanceTitle,
                  // Names "text size" so this page is searchable for the
                  // control that actually lives one tap in. The control itself
                  // is on the Appearance page; there is no second one.
                  subtitle: l10n.appearanceSubtitle,
                  onTap: () => context.push(appearanceSettingsRoute),
                ),
                SettingsLinkTile(
                  tileKey: const Key('settings-tool-display'),
                  icon: Icons.build_outlined,
                  title: l10n.settingsToolDisplayTitle,
                  subtitle: l10n.settingsToolDisplaySubtitle,
                  onTap: () => context.push(toolDisplaySettingsRoute),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Card(
              child: Column(
                children: [
                  ListTile(
                    leading: const Icon(Icons.filter_alt_outlined),
                    title: Text(l10n.settingsSessionVisibilityTitle),
                    subtitle: Text(l10n.settingsSessionVisibilitySubtitle),
                  ),
                  SwitchListTile(
                    key: const Key('settings-show-background-sessions'),
                    title: Text(l10n.settingsShowBackgroundSessionsTitle),
                    subtitle: Text(l10n.settingsShowBackgroundSessionsSubtitle),
                    value: sessionVisibility.showBackgroundSessions,
                    onChanged: (show) => unawaited(
                      ref
                          .read(sessionVisibilityControllerProvider.notifier)
                          .setShowBackgroundSessions(show: show),
                    ),
                  ),
                  SwitchListTile(
                    key: const Key('settings-show-vscode-sessions'),
                    title: Text(l10n.settingsShowVscodeSessionsTitle),
                    subtitle: Text(l10n.settingsShowVscodeSessionsSubtitle),
                    value: sessionVisibility.showVscodeSessions,
                    onChanged: (show) => unawaited(
                      ref
                          .read(sessionVisibilityControllerProvider.notifier)
                          .setShowVscodeSessions(show: show),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
