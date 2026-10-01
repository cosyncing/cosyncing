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
import 'package:flutter/rendering.dart' show OverflowBoxFit;

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
    final tokens = context.tokens;
    final updateSemantics = AppLocalizations.of(
      context,
    ).settingsClientUpdateAvailableSemantics;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        if (title != null)
          SectionHeader(
            title!,
            color: tokens.textPrimary,
            padding: const EdgeInsets.only(bottom: 8),
          ),
        for (final tile in tiles)
          SettingsRow(
            key: tile.tileKey,
            leading: Semantics(
              label: tile.showAttentionDot ? updateSemantics : null,
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
            title: Text(tile.title),
            subtitle: Text(tile.subtitle),
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
///
/// The heading is the only boundary a section draws: rows inside it are
/// separated by spacing, never by cards or outlines.
class SettingsSection extends StatelessWidget {
  /// Creates a settings section.
  const SettingsSection({
    required this.title,
    required this.child,
    this.description,
    super.key,
  });

  /// Section heading.
  final String title;

  /// Optional one-line explanation under [title].
  final String? description;

  /// Section body.
  final Widget child;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final description = this.description;
    return Padding(
      padding: const EdgeInsets.only(top: 16, bottom: 8),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SectionHeader(
            title,
            color: tokens.textPrimary,
            fontWeight: FontWeight.w700,
            padding: EdgeInsets.only(bottom: description == null ? 4 : 0),
          ),
          if (description != null)
            Padding(
              padding: const EdgeInsets.only(top: 4, bottom: 4),
              child: Text(
                description,
                style: Theme.of(
                  context,
                ).textTheme.bodySmall?.copyWith(color: tokens.textTertiary),
              ),
            ),
          child,
        ],
      ),
    );
  }
}

/// The scrolling body every Settings category page shares: one column, a
/// comfortable reading width, and the same gutters at every size.
class SettingsPageBody extends StatelessWidget {
  /// Creates a category page body.
  const SettingsPageBody({required this.children, super.key});

  /// Sections and rows, top to bottom.
  final List<Widget> children;

  /// Widest the settings column grows; long rows stay readable on desktop.
  static const double maxContentWidth = 760;

  @override
  Widget build(BuildContext context) {
    return SafeArea(
      child: LayoutBuilder(
        builder: (context, constraints) {
          final gutter = constraints.maxWidth < 600 ? 16.0 : 24.0;
          final spare = constraints.maxWidth - maxContentWidth - 2 * gutter;
          final side = spare > 0 ? gutter + spare / 2 : gutter;
          return ListView(
            padding: EdgeInsets.fromLTRB(side, 8, side, 32),
            children: children,
          );
        },
      ),
    );
  }
}

/// One settings line: what it is, why it matters, and its control.
///
/// Below [stackBelowWidth] a wide [trailing] control (a select, a button)
/// moves under the text at full width instead of squeezing the label.
class SettingsRow extends StatelessWidget {
  /// Creates a settings row.
  const SettingsRow({
    required this.title,
    this.subtitle,
    this.leading,
    this.trailing,
    this.onTap,
    this.stackTrailing = false,
    this.stackBelowWidth = 440,
    super.key,
  });

  /// Primary label.
  final Widget title;

  /// Supporting line under [title].
  final Widget? subtitle;

  /// Optional glyph or logo before the text.
  final Widget? leading;

  /// The row's control or status.
  final Widget? trailing;

  /// Makes the whole row activate, with a hover and press fill.
  final VoidCallback? onTap;

  /// Whether [trailing] moves under the text on narrow widths.
  final bool stackTrailing;

  /// Width under which a stacking [trailing] moves under the text.
  final double stackBelowWidth;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final text = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        DefaultTextStyle.merge(
          style: theme.textTheme.bodyMedium?.copyWith(
            color: tokens.textPrimary,
          ),
          child: title,
        ),
        if (subtitle case final subtitle?) ...[
          const SizedBox(height: 2),
          DefaultTextStyle.merge(
            style: theme.textTheme.bodySmall?.copyWith(
              color: tokens.textTertiary,
            ),
            child: subtitle,
          ),
        ],
      ],
    );
    final row = LayoutBuilder(
      builder: (context, constraints) {
        final trailing = this.trailing;
        final leading = this.leading;
        final stacked =
            trailing != null &&
            stackTrailing &&
            constraints.maxWidth < stackBelowWidth;
        final head = Row(
          children: [
            if (leading != null) ...[leading, const SizedBox(width: 12)],
            Expanded(child: text),
            if (trailing != null && !stacked) ...[
              const SizedBox(width: 16),
              trailing,
            ],
          ],
        );
        return ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 48),
          child: Padding(
            padding: const EdgeInsets.symmetric(vertical: 8),
            child: stacked
                ? Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    mainAxisSize: MainAxisSize.min,
                    children: [head, const SizedBox(height: 8), trailing],
                  )
                : head,
          ),
        );
      },
    );
    final onTap = this.onTap;
    if (onTap == null) return row;
    return SettingsHoverBleed(onTap: onTap, child: row);
  }
}

/// Gives an activating row a hover and press fill that reaches [bleed] past
/// its text on both sides, so its label stays aligned with the section
/// heading and with rows that cannot be tapped.
class SettingsHoverBleed extends StatelessWidget {
  /// Creates the fill.
  const SettingsHoverBleed({
    required this.onTap,
    required this.child,
    this.bleed = 8,
    super.key,
  });

  /// Activation.
  final VoidCallback onTap;

  /// Row content, laid out at the parent's width.
  final Widget child;

  /// How far the fill reaches past each side.
  final double bleed;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final radius = BorderRadius.circular(tokens.radiusMd);
    return LayoutBuilder(
      builder: (context, constraints) {
        final width = constraints.maxWidth + 2 * bleed;
        // Sized by the row, not by the incoming constraints: inside a list
        // the height is unbounded, and only the width may overhang.
        return OverflowBox(
          fit: OverflowBoxFit.deferToChild,
          minWidth: width,
          maxWidth: width,
          child: Material(
            type: MaterialType.transparency,
            child: InkWell(
              borderRadius: radius,
              hoverColor: tokens.surfaceHover,
              onTap: onTap,
              child: Padding(
                padding: EdgeInsets.symmetric(horizontal: bleed),
                child: child,
              ),
            ),
          ),
        );
      },
    );
  }
}

/// A settings switch: the row's text on the left, the switch on the right,
/// and the whole row toggles it.
class SettingsSwitchRow extends StatelessWidget {
  /// Creates a switch row.
  const SettingsSwitchRow({
    required this.title,
    required this.value,
    required this.onChanged,
    this.subtitle,
    this.tileKey,
    super.key,
  });

  /// Key on the inner [SwitchListTile], for tests that read its value.
  final Key? tileKey;

  /// Primary label.
  final String title;

  /// Supporting line under [title].
  final String? subtitle;

  /// Current state.
  final bool value;

  /// Called with the new state, or null to disable the row.
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final subtitle = this.subtitle;
    return SwitchListTile(
      key: tileKey,
      contentPadding: EdgeInsets.zero,
      title: Text(
        title,
        style: theme.textTheme.bodyMedium?.copyWith(color: tokens.textPrimary),
      ),
      subtitle: subtitle == null
          ? null
          : Text(
              subtitle,
              style: theme.textTheme.bodySmall?.copyWith(
                color: tokens.textTertiary,
              ),
            ),
      value: value,
      onChanged: onChanged,
    );
  }
}

/// One choice in a [SettingsSelect].
class SettingsSelectOption<T> {
  /// Creates a choice.
  const SettingsSelectOption({
    required this.value,
    required this.label,
    this.leading,
  });

  /// The value this choice selects.
  final T value;

  /// What the choice is called.
  final String label;

  /// Optional swatch or glyph before [label].
  final Widget? leading;
}

/// A borderless, filled select: the current choice and a chevron, with the
/// choices in a menu. Replaces chips, segmented buttons and radio lists for a
/// setting that holds one of a few named values.
class SettingsSelect<T> extends StatelessWidget {
  /// Creates a select.
  const SettingsSelect({
    required this.value,
    required this.options,
    required this.onChanged,
    this.width = 240,
    super.key,
  });

  /// The selected value; must be one of [options].
  final T value;

  /// Choices, in menu order.
  final List<SettingsSelectOption<T>> options;

  /// Called with a newly chosen value, or null to disable the control.
  final ValueChanged<T>? onChanged;

  /// Width when the select sits beside its label; stacked, it fills the row.
  final double width;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final onChanged = this.onChanged;
    Widget label(SettingsSelectOption<T> option) => Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (option.leading case final leading?) ...[
          leading,
          const SizedBox(width: 8),
        ],
        Flexible(
          child: Text(
            option.label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
        ),
      ],
    );
    final select = DecoratedBox(
      decoration: BoxDecoration(
        color: tokens.surface2,
        borderRadius: BorderRadius.circular(tokens.radiusMd),
      ),
      child: DropdownButtonHideUnderline(
        child: DropdownButton<T>(
          value: value,
          isExpanded: true,
          isDense: true,
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
          borderRadius: BorderRadius.circular(tokens.radiusMd),
          dropdownColor: tokens.surface,
          focusColor: tokens.surfaceHover,
          style: theme.textTheme.bodyMedium?.copyWith(
            color: tokens.textPrimary,
          ),
          icon: Icon(
            Icons.keyboard_arrow_down,
            size: 16,
            color: tokens.textSecondary,
          ),
          items: [
            for (final option in options)
              DropdownMenuItem<T>(value: option.value, child: label(option)),
          ],
          onChanged: onChanged == null
              ? null
              : (next) {
                  if (next != null && next != value) onChanged(next);
                },
        ),
      ),
    );
    // Beside a label a Row offers unbounded width, so the select takes its
    // own; stacked under the label it fills the row.
    return LayoutBuilder(
      builder: (context, constraints) => SizedBox(
        width: constraints.hasBoundedWidth ? constraints.maxWidth : width,
        child: select,
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
