import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/tool_display_mode.dart';
import 'package:cosyncing_client/src/features/settings/controller/tool_display_controller.dart';
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
    return SettingsRow(
      stackTrailing: true,
      title: Text(l10n.toolDisplayPageTitle),
      subtitle: Text(switch (mode) {
        ToolDisplayMode.responsive => l10n.toolDisplayResponsiveBody,
        ToolDisplayMode.tier1Only => l10n.toolDisplayCollapsedBody,
        ToolDisplayMode.finalMessagesOnly => l10n.toolDisplayFinalBody,
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
          SettingsSelectOption(
            value: ToolDisplayMode.finalMessagesOnly,
            label: l10n.toolDisplayFinalTitle,
          ),
        ],
        onChanged: (value) => unawaited(
          ref.read(toolDisplayControllerProvider.notifier).setMode(value),
        ),
      ),
    );
  }
}
