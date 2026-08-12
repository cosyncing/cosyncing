import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/features/settings/controller/debug_views_controller.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:cosyncing_client/src/features/voice/controller/read_aloud_rate_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

/// Settings → General: what belongs to no other category.
///
/// Scheduled sends and Transfers are queue managers rather than preferences,
/// so they have no natural home among the setting categories; they are grouped
/// here as ongoing activity rather than dropped from Settings entirely.
class GeneralSettingsPage extends ConsumerWidget {
  /// Creates the general settings category page.
  const GeneralSettingsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final showDebugViews =
        ref.watch(debugViewsControllerProvider).value ?? false;
    final readAloudRate = ref.watch(readAloudRateControllerProvider);

    return Scaffold(
      appBar: AppBar(title: Text(l10n.settingsCategoryGeneralTitle)),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            SettingsLinkGroup(
              tiles: [
                SettingsLinkTile(
                  tileKey: const Key('settings-keyboard-shortcuts'),
                  icon: Icons.keyboard_alt_outlined,
                  title: l10n.keyboardShortcutsTitle,
                  subtitle: l10n.settingsKeyboardShortcutsSubtitle,
                  onTap: () => context.push(keyboardShortcutsRoute),
                ),
              ],
            ),
            const SizedBox(height: 16),
            SettingsLinkGroup(
              title: l10n.settingsGroupActivity,
              tiles: [
                SettingsLinkTile(
                  tileKey: const Key('settings-scheduled-sends'),
                  icon: Icons.event_outlined,
                  title: l10n.settingsScheduledSendsTitle,
                  subtitle: l10n.settingsScheduledSendsSubtitle,
                  onTap: () => context.push(scheduledSendsRoute),
                ),
                SettingsLinkTile(
                  icon: Icons.sync_alt_outlined,
                  title: l10n.settingsTransfersTitle,
                  subtitle: l10n.settingsTransfersSubtitle,
                  onTap: () => context.push(transfersRoute),
                ),
              ],
            ),
            const SizedBox(height: 16),
            SettingsSection(
              key: const Key('settings-read-aloud-section'),
              title: l10n.settingsReadAloudTitle,
              child: ListTile(
                key: const Key('settings-read-aloud-rate'),
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.record_voice_over_outlined),
                title: Text(l10n.readAloudSpeed),
                subtitle: Text(l10n.settingsReadAloudSpeedSubtitle),
                trailing: DropdownButton<double>(
                  key: const Key('settings-read-aloud-rate-menu'),
                  value: readAloudRate.value ?? kDefaultReadAloudRate,
                  onChanged: readAloudRate.isLoading
                      ? null
                      : (rate) {
                          if (rate == null) return;
                          ref
                              .read(readAloudRateControllerProvider.notifier)
                              .setRate(rate);
                        },
                  items: [
                    for (final rate in kReadAloudRates)
                      DropdownMenuItem(
                        value: rate,
                        child: Text(formatReadAloudRate(rate)),
                      ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 16),
            SettingsSection(
              title: l10n.settingsDeveloperOptionsTitle,
              child: SwitchListTile.adaptive(
                key: const Key('settings-show-debug-views'),
                contentPadding: EdgeInsets.zero,
                value: showDebugViews,
                onChanged: (value) => ref
                    .read(debugViewsControllerProvider.notifier)
                    .setShowDebugViews(value: value),
                title: Text(l10n.settingsShowDebugViewsTitle),
                subtitle: Text(l10n.settingsShowDebugViewsSubtitle),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
