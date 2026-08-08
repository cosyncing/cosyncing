/// Shared building blocks for the Settings hub and its category pages.
///
/// Settings is a two-layer hierarchy: a hub of categories, then one page per
/// category. These widgets are what keep the two layers looking like one
/// surface, so they live here rather than being re-declared per page.
library;

import 'package:cosyncing_client/l10n/app_localizations.dart';
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
  });

  /// Widget key for tests and deep-link targeting.
  final Key? tileKey;

  /// Leading glyph.
  final IconData icon;

  /// Row label.
  final String title;

  /// Supporting line under [title].
  final String subtitle;

  /// Invoked when the row is tapped.
  final VoidCallback onTap;
}

/// A set of related navigation rows sharing one card.
///
/// Settings used to give every destination its own [Card]. A dozen identical
/// single-row cards read as one undifferentiated column: nothing signalled that
/// Appearance and Tool display are the same kind of setting while Pairing is
/// not, and each card spent its own margin and elevation to say nothing.
/// Collapsing each category into a single card with hairline dividers gives the
/// page a scannable shape and reclaims the inter-card gaps.
///
/// [title] is optional because the hub's own card needs no heading — the page
/// title already names it. Inside a category page, where several groups stack,
/// the heading states the shape the dividers only imply.
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
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (title != null)
          Padding(
            padding: const EdgeInsets.only(left: 4, bottom: 8),
            child: Text(
              title!,
              style: theme.textTheme.labelLarge?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
          ),
        Card(
          margin: EdgeInsets.zero,
          child: Column(
            children: [
              for (var index = 0; index < tiles.length; index++) ...[
                if (index > 0) const Divider(height: 1, indent: 56),
                ListTile(
                  key: tiles[index].tileKey,
                  leading: Icon(tiles[index].icon),
                  title: Text(tiles[index].title),
                  subtitle: Text(tiles[index].subtitle),
                  trailing: const Icon(Icons.chevron_right),
                  onTap: tiles[index].onTap,
                ),
              ],
            ],
          ),
        ),
      ],
    );
  }
}

/// A titled card holding one block of controls.
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
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(title, style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 12),
            child,
          ],
        ),
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
      data: theme.copyWith(dividerColor: Colors.transparent),
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
