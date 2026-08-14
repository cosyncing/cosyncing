import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/tool_display_mode.dart';
import 'package:cosyncing_client/src/features/settings/controller/tool_display_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Settings → Tool display.
///
/// Governing docs: `docs/architecture/client-ui.md` and
/// `docs/architecture/client-ui.md`.
class ToolDisplaySettingsPage extends ConsumerWidget {
  /// Creates the global transcript display settings page.
  const ToolDisplaySettingsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final mode =
        ref.watch(toolDisplayControllerProvider).valueOrNull ??
        ToolDisplayMode.responsive;
    return Scaffold(
      appBar: AppBar(title: Text(l10n.toolDisplayPageTitle)),
      body: ListView(
        padding: const EdgeInsets.symmetric(vertical: 8),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
            child: SelectableText(l10n.toolDisplayIntro),
          ),
          RadioGroup<ToolDisplayMode>(
            groupValue: mode,
            onChanged: (value) {
              if (value == null) return;
              unawaited(
                ref.read(toolDisplayControllerProvider.notifier).setMode(value),
              );
            },
            child: Column(
              children: [
                RadioListTile<ToolDisplayMode>(
                  key: const Key('tool-display-responsive'),
                  value: ToolDisplayMode.responsive,
                  title: Text(l10n.toolDisplayResponsiveTitle),
                  subtitle: Text(l10n.toolDisplayResponsiveBody),
                ),
                RadioListTile<ToolDisplayMode>(
                  key: const Key('tool-display-tier1'),
                  value: ToolDisplayMode.tier1Only,
                  title: Text(l10n.toolDisplayCollapsedTitle),
                  subtitle: Text(l10n.toolDisplayCollapsedBody),
                ),
                RadioListTile<ToolDisplayMode>(
                  key: const Key('tool-display-final-only'),
                  value: ToolDisplayMode.finalMessagesOnly,
                  title: Text(l10n.toolDisplayFinalTitle),
                  subtitle: Text(l10n.toolDisplayFinalBody),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
