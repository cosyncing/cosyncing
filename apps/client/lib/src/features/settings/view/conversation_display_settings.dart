import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/features/settings/controller/conversation_display_controller.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Transcript appearance and the meaning of the separate session indicators.
class ConversationDisplaySettings extends ConsumerWidget {
  /// Creates display controls.
  const ConversationDisplaySettings({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final prefs =
        ref.watch(conversationDisplayControllerProvider).valueOrNull ??
        const ConversationDisplayPreferences();
    final controller = ref.read(conversationDisplayControllerProvider.notifier);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SettingsSection(
          title: l10n.settingsEnhancementConversation,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(l10n.settingsEnhancementMessageText),
              Wrap(
                spacing: 8,
                children: [
                  for (final size in const [14.0, 15.0, 17.0, 19.0])
                    ChoiceChip(
                      key: Key('conversation-font-${size.toInt()}'),
                      label: Text(
                        l10n.settingsEnhancementFontSize(size.toInt()),
                      ),
                      selected: prefs.fontSize == size,
                      onSelected: (_) =>
                          controller.updatePreferences(fontSize: size),
                    ),
                ],
              ),
              const SizedBox(height: 12),
              Text(l10n.settingsEnhancementMessageSpacing),
              Wrap(
                spacing: 8,
                children: [
                  for (final choice in <(double, String)>[
                    (8, l10n.densityCompact),
                    (12, l10n.densityComfortable),
                    (20, l10n.densitySpacious),
                  ])
                    ChoiceChip(
                      key: Key('conversation-spacing-${choice.$1.toInt()}'),
                      label: Text(choice.$2),
                      selected: prefs.messageSpacing == choice.$1,
                      onSelected: (_) => controller.updatePreferences(
                        messageSpacing: choice.$1,
                      ),
                    ),
                ],
              ),
              const SizedBox(height: 12),
              SwitchListTile(
                key: const Key('conversation-reading-width'),
                contentPadding: EdgeInsets.zero,
                title: Text(l10n.settingsEnhancementReadingWidth),
                subtitle: Text(l10n.settingsEnhancementReadingWidthHint),
                value: prefs.readingWidth,
                onChanged: (value) =>
                    controller.updatePreferences(readingWidth: value),
              ),
            ],
          ),
        ),
        SettingsSection(
          title: l10n.settingsEnhancementIndicators,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Wrap(
                spacing: 12,
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
              const SizedBox(height: 8),
              Text(
                l10n.settingsEnhancementIndicatorsHint,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: tokens.textSecondary),
              ),
            ],
          ),
        ),
      ],
    );
  }
}
