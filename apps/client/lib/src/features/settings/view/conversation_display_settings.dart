import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/features/settings/controller/conversation_display_controller.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:cosyncing_client/src/features/settings/view/tool_display_settings_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// How a transcript reads: message text size, spacing between turns, line
/// length, and how much tool work shows.
class ConversationDisplaySettings extends ConsumerWidget {
  /// Creates the conversation section.
  const ConversationDisplaySettings({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final prefs =
        ref.watch(conversationDisplayControllerProvider).valueOrNull ??
        const ConversationDisplayPreferences();
    final controller = ref.read(conversationDisplayControllerProvider.notifier);
    return SettingsSection(
      title: l10n.settingsEnhancementConversation,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SettingsRow(
            stackTrailing: true,
            title: Text(l10n.settingsEnhancementMessageText),
            trailing: SettingsSelect<double>(
              key: const Key('conversation-font'),
              value: prefs.fontSize,
              options: [
                for (final size in const [14.0, 15.0, 17.0, 19.0])
                  SettingsSelectOption(
                    value: size,
                    label: l10n.settingsEnhancementFontSize(size.toInt()),
                  ),
              ],
              onChanged: (size) => controller.updatePreferences(fontSize: size),
            ),
          ),
          SettingsRow(
            stackTrailing: true,
            title: Text(l10n.settingsEnhancementMessageSpacing),
            trailing: SettingsSelect<double>(
              key: const Key('conversation-spacing'),
              value: prefs.messageSpacing,
              options: [
                SettingsSelectOption(value: 8, label: l10n.densityCompact),
                SettingsSelectOption(value: 12, label: l10n.densityComfortable),
                SettingsSelectOption(value: 20, label: l10n.densitySpacious),
              ],
              onChanged: (spacing) =>
                  controller.updatePreferences(messageSpacing: spacing),
            ),
          ),
          SettingsSwitchRow(
            tileKey: const Key('conversation-reading-width'),
            title: l10n.settingsEnhancementReadingWidth,
            subtitle: l10n.settingsEnhancementReadingWidthHint,
            value: prefs.readingWidth,
            onChanged: (value) =>
                controller.updatePreferences(readingWidth: value),
          ),
          const ToolDisplaySettingRow(),
        ],
      ),
    );
  }
}

/// What the roster and tab indicators mean, drawn with the indicators
/// themselves.
class SessionIndicatorsSettings extends StatelessWidget {
  /// Creates the indicator legend.
  const SessionIndicatorsSettings({super.key});

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    return SettingsSection(
      title: l10n.settingsEnhancementIndicators,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SizedBox(height: 8),
          Wrap(
            spacing: 16,
            runSpacing: 8,
            crossAxisAlignment: WrapCrossAlignment.center,
            children: [
              StatusPill(
                label: l10n.settingsEnhancementWorking,
                color: tokens.statusWorking,
              ),
              StatusPill(
                label: l10n.settingsEnhancementNeedsInput,
                color: tokens.statusNeedsInput,
              ),
              Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  StatusDot(color: tokens.statusError),
                  const SizedBox(width: 4),
                  Text(
                    l10n.settingsEnhancementReadyReview,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ],
          ),
          const SizedBox(height: 12),
          Text(
            l10n.settingsEnhancementIndicatorsHint,
            style: Theme.of(
              context,
            ).textTheme.bodySmall?.copyWith(color: tokens.textTertiary),
          ),
        ],
      ),
    );
  }
}
