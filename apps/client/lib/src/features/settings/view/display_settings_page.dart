import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_projection.dart';
import 'package:cosyncing_client/src/features/settings/controller/session_visibility_controller.dart';
import 'package:cosyncing_client/src/features/settings/view/appearance_settings_page.dart';
import 'package:cosyncing_client/src/features/settings/view/conversation_display_settings.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Settings → Display: everything that changes how the app presents itself,
/// on one page from the broadest choice to the finest.
///
/// Appearance (theme, light or dark, text size, density, language) applies to
/// the whole app; Conversation to transcripts; Session visibility to the
/// roster; the indicator legend explains what the roster shows.
class DisplaySettingsPage extends ConsumerWidget {
  /// Creates the display settings category page.
  const DisplaySettingsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final sessionVisibility =
        ref.watch(sessionVisibilityControllerProvider).valueOrNull ??
        const SessionVisibilityPreferences();
    final visibility = ref.read(sessionVisibilityControllerProvider.notifier);

    return Scaffold(
      appBar: AppBar(title: Text(l10n.settingsCategoryDisplayTitle)),
      body: SettingsPageBody(
        children: [
          const AppearanceSettingsSection(),
          const ConversationDisplaySettings(),
          SettingsSection(
            title: l10n.settingsSessionVisibilityTitle,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                SettingsSwitchRow(
                  tileKey: const Key('settings-show-background-sessions'),
                  title: l10n.settingsShowBackgroundSessionsTitle,
                  subtitle: l10n.settingsShowBackgroundSessionsSubtitle,
                  value: sessionVisibility.showBackgroundSessions,
                  onChanged: (show) => unawaited(
                    visibility.setShowBackgroundSessions(show: show),
                  ),
                ),
                SettingsSwitchRow(
                  tileKey: const Key('settings-show-vscode-sessions'),
                  title: l10n.settingsShowVscodeSessionsTitle,
                  subtitle: l10n.settingsShowVscodeSessionsSubtitle,
                  value: sessionVisibility.showVscodeSessions,
                  onChanged: (show) =>
                      unawaited(visibility.setShowVscodeSessions(show: show)),
                ),
              ],
            ),
          ),
          const SessionIndicatorsSettings(),
        ],
      ),
    );
  }
}
