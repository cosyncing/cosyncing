/// Shared building blocks for the Settings hub and its category pages.
///
/// Settings is a two-layer hierarchy: a hub of categories, then one page per
/// category. These widgets are what keep the two layers looking like one
/// surface, so they live here rather than being re-declared per page.
library;

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:flutter/material.dart';

/// One navigation row inside a [SettingsLinkGroup].
class SettingsLinkTile {
  /// Creates a link row.
  const SettingsLinkTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
    this.tileKey,
    this.showAttentionDot = false,
  });

  /// Widget key for tests and deep-link targeting.
  final Key? tileKey;

  /// Shows a small attention dot on the leading icon.
  final bool showAttentionDot;

  /// Leading glyph.
  final IconData icon;

  /// Row label.
  final String title;

  /// Supporting line under [title].
  final String subtitle;

  /// Invoked when the row is tapped.
  final VoidCallback onTap;
}

/// Quiet navigation rows. Selection and hover belong to the row itself.
/// [title] is optional when the surrounding page already names the group.
class SettingsLinkGroup extends StatelessWidget {
  /// Creates a link group.
  const SettingsLinkGroup({required this.tiles, this.title, super.key});

  /// Category name shown above the card.
  final String? title;

  /// Rows in display order.
  final List<SettingsLinkTile> tiles;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (title != null)
          SectionHeader(title!, padding: const EdgeInsets.only(bottom: 8)),
        for (final tile in tiles)
          ListTile(
            key: tile.tileKey,
            contentPadding: const EdgeInsets.symmetric(
              horizontal: 8,
              vertical: 4,
            ),
            minLeadingWidth: 20,
            horizontalTitleGap: 12,
            shape: RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(tokens.radiusMd),
            ),
            leading: Semantics(
              label: tile.showAttentionDot
                  ? AppLocalizations.of(
                      context,
                    ).settingsClientUpdateAvailableSemantics
                  : null,
              child: Stack(
                clipBehavior: Clip.none,
                children: [
                  Icon(tile.icon, size: 20, color: tokens.textSecondary),
                  if (tile.showAttentionDot)
                    Positioned(
                      top: -2,
                      right: -2,
                      child: StatusDot(color: tokens.statusNeedsInput),
                    ),
                ],
              ),
            ),
            title: Text(tile.title, style: theme.textTheme.bodyMedium),
            subtitle: Text(
              tile.subtitle,
              style: theme.textTheme.bodySmall?.copyWith(
                color: tokens.textTertiary,
              ),
            ),
            trailing: Icon(
              Icons.chevron_right,
              size: 16,
              color: tokens.textTertiary,
            ),
            onTap: tile.onTap,
          ),
      ],
    );
  }
}

/// A borderless settings block with a shared section heading.
class SettingsSection extends StatelessWidget {
  /// Creates a settings section.
  const SettingsSection({
    required this.title,
    required this.child,
    super.key,
  });

  /// Section heading.
  final String title;

  /// Section body.
  final Widget child;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SectionHeader(title, padding: const EdgeInsets.only(bottom: 12)),
          child,
        ],
      ),
    );
  }
}

/// Collapsed disclosure holding a raw diagnostic string.
///
/// Mirrors the connection gate's `_TechnicalDetails`: the diagnostic stays
/// available and selectable for a support request, but never occupies the
/// primary reading path.
class SettingsTechnicalDetailsDisclosure extends StatelessWidget {
  /// Creates the disclosure.
  const SettingsTechnicalDetailsDisclosure({
    required this.detail,
    super.key,
  });

  /// Raw diagnostic text.
  final String detail;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Theme(
      data: theme.copyWith(
        dividerColor: context.tokens.separator.withValues(alpha: 0),
      ),
      child: ExpansionTile(
        key: const Key('settings-technical-details'),
        tilePadding: EdgeInsets.zero,
        childrenPadding: EdgeInsets.zero,
        expandedCrossAxisAlignment: CrossAxisAlignment.start,
        visualDensity: VisualDensity.compact,
        title: Text(
          AppLocalizations.of(context).brokerGateTechnicalDetails,
          style: theme.textTheme.bodySmall?.copyWith(
            color: theme.colorScheme.onSurfaceVariant,
          ),
        ),
        children: [
          Align(
            alignment: Alignment.centerLeft,
            child: SelectableText(
              detail,
              key: const Key('settings-technical-detail-text'),
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
                fontFamily: 'monospace',
              ),
            ),
          ),
          const SizedBox(height: 8),
        ],
      ),
    );
  }
}

/// Cancel action for the confirmation dialogs in Settings.
class SettingsDialogCancelButton extends StatelessWidget {
  /// Creates the cancel button.
  const SettingsDialogCancelButton({super.key});

  @override
  Widget build(BuildContext context) {
    return TextButton(
      onPressed: () => Navigator.pop(context, false),
      child: Text(AppLocalizations.of(context).cancel),
    );
  }
}

/// Confirm action for the confirmation dialogs in Settings.
class SettingsDialogConfirmButton extends StatelessWidget {
  /// Creates the confirm button.
  const SettingsDialogConfirmButton({required this.label, super.key});

  /// Button label.
  final String label;

  @override
  Widget build(BuildContext context) {
    return FilledButton(
      onPressed: () => Navigator.pop(context, true),
      child: Text(label),
    );
  }
}
