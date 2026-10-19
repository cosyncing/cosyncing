import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/tool_display_mode.dart';
import 'package:cosyncing_client/src/features/settings/controller/tool_display_controller.dart';
import 'package:cosyncing_client/src/features/settings/controller/tool_visibility_controller.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Settings → Tool display, reachable on its own at its published route. The
/// same row sits in Settings → Display under Conversation.
///
/// Governing doc: `docs/architecture/client-ui.md`.
class ToolDisplaySettingsPage extends StatelessWidget {
  /// Creates the global transcript display settings page.
  const ToolDisplaySettingsPage({super.key});

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Scaffold(
      appBar: AppBar(title: Text(l10n.toolDisplayPageTitle)),
      body: SettingsPageBody(
        children: [
          SettingsSection(
            title: l10n.toolDisplayPageTitle,
            description: l10n.toolDisplayIntro,
            child: const ToolDisplaySettingRow(),
          ),
        ],
      ),
    );
  }
}

/// How much tool work every transcript shows. The line under the label
/// describes the mode that is selected now.
class ToolDisplaySettingRow extends ConsumerWidget {
  /// Creates the tool display row.
  const ToolDisplaySettingRow({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final mode =
        ref.watch(toolDisplayControllerProvider).valueOrNull ??
        ToolDisplayMode.responsive;
    final preferences = ref.watch(toolVisibilityControllerProvider).valueOrNull;
    final controller = ref.read(toolVisibilityControllerProvider.notifier);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SettingsSwitchRow(
          tileKey: const Key('tools-hide-default'),
          title: l10n.toolsHideDefault,
          subtitle: l10n.toolsHideDefaultHint,
          value: preferences?.hideByDefault ?? false,
          onChanged: preferences == null
              ? null
              : (value) => controller.setDefault(hide: value),
        ),
        if (preferences?.saveFailed ?? false)
          TextButton(
            onPressed: controller.retry,
            child: Text(l10n.toolsSaveRetry),
          ),
        if (preferences != null && preferences.overrides.isNotEmpty)
          SettingsRow(
            stackTrailing: true,
            title: Text(l10n.toolsOverridesCount(preferences.overrides.length)),
            trailing: TextButton(
              onPressed: () async {
                final saved = await controller.resetOverrides();
                if (!context.mounted) return;
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(
                    content: Text(l10n.toolsOverridesReset),
                    action: SnackBarAction(
                      label: l10n.workspaceUndoCloseTabs,
                      onPressed: () =>
                          unawaited(controller.restoreOverrides(saved)),
                    ),
                  ),
                );
              },
              child: Text(l10n.toolsResetOverrides),
            ),
          ),
        SettingsRow(
          stackTrailing: true,
          title: Text(l10n.toolsAssistantMessages),
          trailing: SettingsSelect<bool>(
            value: preferences?.finalAssistantOnly ?? false,
            options: [
              SettingsSelectOption(value: false, label: l10n.toolsAssistantAll),
              SettingsSelectOption(
                value: true,
                label: l10n.toolDisplayFinalTitle,
              ),
            ],
            onChanged: preferences == null
                ? null
                : (value) => controller.setFinalAssistantOnly(value: value),
          ),
        ),
        SettingsRow(
          stackTrailing: true,
          title: Text(l10n.toolsDetails),
          subtitle: Text(switch (mode) {
            ToolDisplayMode.responsive => l10n.toolDisplayResponsiveBody,
            ToolDisplayMode.tier1Only => l10n.toolDisplayCollapsedBody,
            ToolDisplayMode.finalMessagesOnly ||
            ToolDisplayMode.finalAssistant => l10n.toolDisplayFinalBody,
          }),
          trailing: SettingsSelect<ToolDisplayMode>(
            key: const Key('tool-display-mode'),
            value: mode,
            options: [
              SettingsSelectOption(
                value: ToolDisplayMode.responsive,
                label: l10n.toolDisplayResponsiveTitle,
              ),
              SettingsSelectOption(
                value: ToolDisplayMode.tier1Only,
                label: l10n.toolDisplayCollapsedTitle,
              ),
            ],
            onChanged: (value) => unawaited(
              ref.read(toolDisplayControllerProvider.notifier).setMode(value),
            ),
          ),
        ),
      ],
    );
  }
}
