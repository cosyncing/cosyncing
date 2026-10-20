import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/window_size_class.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_frame.dart';
import 'package:cosyncing_client/src/features/settings/view/agents_settings_page.dart';
import 'package:cosyncing_client/src/features/settings/view/broker_devices_settings_page.dart';
import 'package:cosyncing_client/src/features/settings/view/display_settings_page.dart';
import 'package:cosyncing_client/src/features/settings/view/general_settings_page.dart';
import 'package:cosyncing_client/src/features/settings/view/notification_settings_page.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:cosyncing_client/src/features/usage/view/usage_report_page.dart';
import 'package:cosyncing_client/src/platform/update/desktop_client_update_provider.dart';
import 'package:cosyncing_client/src/platform/update/native_client_update.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

/// Settings adapts its category navigation to available width.
/// Phones open a separate category detail page; expanded layouts keep a quiet
/// category rail beside the selected page. Each category retains its services.

class SettingsPage extends ConsumerStatefulWidget {
  /// Creates the [SettingsPage].
  const SettingsPage({this.showSessionsBack = false, super.key});

  /// Shows contextual navigation back to the wide Sessions workspace.
  final bool showSessionsBack;

  @override
  ConsumerState<SettingsPage> createState() => _SettingsPageState();
}

class _SettingsPageState extends ConsumerState<SettingsPage> {
  int _selected = 0;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final updateSemantics = l10n.settingsClientUpdateAvailableSemantics;
    final clientUpdateAvailable = ref.watch(
      nativeClientUpdateAvailableProvider,
    );
    final nativeUpdatesSupported = supportsNativeClientUpdates(
      ref.watch(clientTargetPlatformProvider),
      isWeb: ref.watch(clientIsWebProvider),
    );

    final wide = WindowSizeClass.of(context) == WindowSizeClass.expanded;
    void openCategory(int index, String route) {
      if (wide) {
        setState(() => _selected = index);
      } else {
        context.push(route);
      }
    }

    final categories = <SettingsLinkTile>[
      SettingsLinkTile(
        tileKey: const Key('settings-category-display'),
        icon: Icons.palette_outlined,
        title: l10n.settingsCategoryDisplayTitle,
        subtitle: l10n.settingsCategoryDisplaySubtitle,
        onTap: () => openCategory(0, displaySettingsRoute),
      ),
      SettingsLinkTile(
        tileKey: const Key('settings-category-notifications'),
        icon: Icons.notifications_outlined,
        title: l10n.settingsCategoryNotificationsTitle,
        subtitle: l10n.settingsCategoryNotificationsSubtitle,
        onTap: () => openCategory(1, notificationSettingsRoute),
      ),
      SettingsLinkTile(
        tileKey: const Key('settings-category-broker'),
        icon: Icons.storage_outlined,
        title: l10n.settingsCategoryBrokerTitle,
        subtitle: l10n.settingsCategoryBrokerSubtitle,
        onTap: () => openCategory(2, brokerDevicesSettingsRoute),
      ),
      SettingsLinkTile(
        tileKey: const Key('settings-category-agents'),
        icon: Icons.smart_toy_outlined,
        title: l10n.settingsEnhancementAgentsQuota,
        subtitle: l10n.settingsEnhancementAgentsQuotaHint,
        onTap: () => openCategory(3, agentsSettingsRoute),
      ),
      SettingsLinkTile(
        tileKey: const Key('settings-category-usage'),
        icon: Icons.query_stats_outlined,
        title: l10n.usageHubTileTitle,
        subtitle: l10n.usageHubTileSubtitle,
        onTap: () => openCategory(4, usageReportRoute),
      ),
      SettingsLinkTile(
        tileKey: const Key('settings-category-general'),
        icon: Icons.tune_outlined,
        title: l10n.settingsCategoryGeneralTitle,
        subtitle: nativeUpdatesSupported
            ? l10n.settingsCategoryGeneralNativeSubtitle
            : l10n.settingsCategoryGeneralSubtitle,
        showAttentionDot: clientUpdateAvailable,
        onTap: () => openCategory(5, generalSettingsRoute),
      ),
    ];
    return Scaffold(
      appBar: AppBar(
        leading: widget.showSessionsBack
            ? IconButton(
                key: const Key('settings-back-to-sessions'),
                tooltip: l10n.settingsBackToSessions,
                onPressed: () => context.go(sessionsRoute),
                icon: const Icon(Icons.arrow_back),
              )
            : WorkspaceFrameScope.leadingButton(context),
        title: Text(l10n.settingsTitle),
      ),
      body: SafeArea(
        child: wide
            ? Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SizedBox(
                    width: 224,
                    child: ListView(
                      padding: const EdgeInsets.all(16),
                      children: [
                        for (var index = 0; index < categories.length; index++)
                          Padding(
                            padding: const EdgeInsets.only(bottom: 4),
                            child: ListTile(
                              key: categories[index].tileKey,
                              contentPadding: const EdgeInsets.symmetric(
                                horizontal: 12,
                              ),
                              minLeadingWidth: 16,
                              horizontalTitleGap: 8,
                              leading: Icon(categories[index].icon, size: 16),
                              title: Text(
                                categories[index].title,
                                style: Theme.of(context).textTheme.bodySmall,
                              ),
                              trailing: categories[index].showAttentionDot
                                  ? Semantics(
                                      label: updateSemantics,
                                      child: StatusDot(
                                        color: context.tokens.statusNeedsInput,
                                      ),
                                    )
                                  : null,
                              selected: _selected == index,
                              selectedTileColor: context.tokens.surface2,
                              shape: RoundedRectangleBorder(
                                borderRadius: BorderRadius.circular(
                                  context.tokens.radiusMd,
                                ),
                              ),
                              onTap: categories[index].onTap,
                            ),
                          ),
                      ],
                    ),
                  ),
                  Expanded(
                    child: switch (_selected) {
                      0 => const DisplaySettingsPage(),
                      1 => const NotificationSettingsPage(),
                      2 => const BrokerDevicesSettingsPage(),
                      3 => const AgentsSettingsPage(),
                      4 => const UsageReportPage(),
                      _ => const GeneralSettingsPage(),
                    },
                  ),
                ],
              )
            : SettingsPageBody(
                children: [SettingsLinkGroup(tiles: categories)],
              ),
      ),
    );
  }
}
