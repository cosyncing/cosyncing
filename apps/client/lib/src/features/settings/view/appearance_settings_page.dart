import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/theme_spec.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/design/ui_scale.dart';
import 'package:cosyncing_client/src/features/settings/controller/locale_controller.dart';
import 'package:cosyncing_client/src/features/settings/controller/theme_controller.dart';
import 'package:cosyncing_client/src/features/settings/controller/ui_scale_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Settings → Appearance: pick the theme, the light/dark mode, and the language.
class AppearanceSettingsPage extends ConsumerWidget {
  /// Creates the appearance settings screen.
  const AppearanceSettingsPage({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final selection =
        ref.watch(themeControllerProvider).valueOrNull ??
        kFallbackThemeSelection;
    final locale = ref.watch(localeControllerProvider).valueOrNull;
    final activeLanguage = locale?.languageCode ?? _systemLanguageValue;
    final uiScale =
        ref.watch(uiScaleControllerProvider).valueOrNull ??
        kDefaultUiScaleSettings;

    return Scaffold(
      appBar: AppBar(title: Text(l10n.appearanceTitle)),
      body: ListView(
        padding: const EdgeInsets.symmetric(vertical: 8),
        children: [
          SectionHeader(l10n.themeModeLabel),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
            child: SegmentedButton<ThemeMode>(
              segments: [
                ButtonSegment(
                  value: ThemeMode.system,
                  label: Text(l10n.themeModeSystem),
                ),
                ButtonSegment(
                  value: ThemeMode.light,
                  label: Text(l10n.themeModeLight),
                ),
                ButtonSegment(
                  value: ThemeMode.dark,
                  label: Text(l10n.themeModeDark),
                ),
              ],
              selected: {selection.mode},
              onSelectionChanged: (selected) => ref
                  .read(themeControllerProvider.notifier)
                  .setMode(selected.first),
            ),
          ),
          const Divider(height: 1),
          SectionHeader(l10n.themeLabel),
          for (final theme in kAppThemes)
            _ThemeTile(
              spec: theme,
              name: _themeName(l10n, theme.id),
              description: _themeDescription(l10n, theme.id),
              selected: theme.id == selection.themeId,
              onTap: () => ref
                  .read(themeControllerProvider.notifier)
                  .selectTheme(theme.id),
            ),
          const Divider(height: 1),
          SectionHeader(l10n.textSizeLabel),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
            child: Wrap(
              spacing: 8,
              children: [
                for (final scale in UiTextScale.values)
                  ChoiceChip(
                    key: Key('appearance-text-scale-${scale.name}'),
                    label: Text(_textScaleLabel(l10n, scale)),
                    selected: uiScale.textScale == scale,
                    onSelected: (_) => ref
                        .read(uiScaleControllerProvider.notifier)
                        .setTextScale(scale),
                  ),
              ],
            ),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
            child: _SizePreview(
              title: l10n.appearancePreviewSessionTitle,
              meta: l10n.appearancePreviewSessionMeta,
              label: l10n.appearancePreviewLabel,
            ),
          ),
          const Divider(height: 1),
          SectionHeader(l10n.densityLabel),
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 12),
            child: SegmentedButton<UiDensity>(
              // The selected segment's leading checkmark takes ~26px out of an
              // already-tight third of a 420px screen, which pushed
              // "Comfortable" into a mid-word wrap ("Comfortabl / e"). Selection
              // is already carried by the segment's fill colour, so the tick is
              // redundant as well as expensive.
              showSelectedIcon: false,
              segments: [
                ButtonSegment(
                  value: UiDensity.compact,
                  label: _SegmentLabel(l10n.densityCompact),
                ),
                ButtonSegment(
                  value: UiDensity.comfortable,
                  label: _SegmentLabel(l10n.densityComfortable),
                ),
                ButtonSegment(
                  value: UiDensity.spacious,
                  label: _SegmentLabel(l10n.densitySpacious),
                ),
              ],
              selected: {uiScale.density},
              onSelectionChanged: (selected) => ref
                  .read(uiScaleControllerProvider.notifier)
                  .setDensity(selected.first),
            ),
          ),
          const Divider(height: 1),
          SectionHeader(l10n.languageLabel),
          _ChoiceTile(
            title: l10n.languageSystem,
            selected: activeLanguage == _systemLanguageValue,
            onTap: () =>
                ref.read(localeControllerProvider.notifier).setLocale(null),
          ),
          _ChoiceTile(
            title: l10n.languageEnglish,
            selected: activeLanguage == 'en',
            onTap: () => ref
                .read(localeControllerProvider.notifier)
                .setLocale(const Locale('en')),
          ),
          _ChoiceTile(
            title: l10n.languageChinese,
            selected: activeLanguage == 'zh',
            onTap: () => ref
                .read(localeControllerProvider.notifier)
                .setLocale(const Locale('zh')),
          ),
        ],
      ),
    );
  }
}

/// A segmented-button label that shrinks rather than wrapping.
///
/// A three-up [SegmentedButton] gets about a third of the screen per segment,
/// which at 420px is narrower than "Comfortable" renders at the app's label
/// scale. The default behaviour breaks the line inside the word
/// ("Comfortabl / e"); scaling the glyphs down keeps the three options
/// readable and comparable at a glance, which is the point of the control.
class _SegmentLabel extends StatelessWidget {
  const _SegmentLabel(this.text);

  final String text;

  @override
  Widget build(BuildContext context) {
    return FittedBox(
      fit: BoxFit.scaleDown,
      child: Text(text, maxLines: 1, softWrap: false),
    );
  }
}

const String _systemLanguageValue = 'system';

String _textScaleLabel(AppLocalizations l10n, UiTextScale scale) =>
    switch (scale) {
      UiTextScale.system => l10n.textSizeSystem,
      UiTextScale.small => l10n.textSizeSmall,
      UiTextScale.standard => l10n.textSizeStandard,
      UiTextScale.large => l10n.textSizeLarge,
      UiTextScale.extraLarge => l10n.textSizeExtraLarge,
    };

String _themeName(AppLocalizations l10n, String id) => switch (id) {
  'teal-obsidian' => l10n.themeTealObsidianName,
  'graphite-minimalist' => l10n.themeGraphiteMinimalistName,
  'nordic-warmth' => l10n.themeNordicWarmthName,
  'flat-white-minimalist' => l10n.themeFlatWhiteMinimalistName,
  'cyber-amber' => l10n.themeCyberAmberName,
  'royal-navy' => l10n.themeRoyalNavyName,
  'soft-minimalist' => l10n.themeSoftMinimalistName,
  _ => id,
};

String _themeDescription(AppLocalizations l10n, String id) => switch (id) {
  'teal-obsidian' => l10n.themeTealObsidianDescription,
  'graphite-minimalist' => l10n.themeGraphiteMinimalistDescription,
  'nordic-warmth' => l10n.themeNordicWarmthDescription,
  'flat-white-minimalist' => l10n.themeFlatWhiteMinimalistDescription,
  'cyber-amber' => l10n.themeCyberAmberDescription,
  'royal-navy' => l10n.themeRoyalNavyDescription,
  'soft-minimalist' => l10n.themeSoftMinimalistDescription,
  _ => '',
};

/// A representative "session row" that reflects the active text size and theme
/// so the user can see the effect of their choice in place.
class _SizePreview extends StatelessWidget {
  const _SizePreview({
    required this.title,
    required this.meta,
    required this.label,
  });

  final String title;
  final String meta;
  final String label;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label.toUpperCase(),
          style: theme.textTheme.labelSmall?.copyWith(
            color: tokens.textTertiary,
            letterSpacing: 0.8,
          ),
        ),
        const SizedBox(height: 6),
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: tokens.surface,
            borderRadius: BorderRadius.circular(tokens.radiusLg),
            border: Border.all(color: tokens.separator),
          ),
          child: Row(
            children: [
              Container(
                width: 10,
                height: 10,
                decoration: BoxDecoration(
                  color: tokens.statusWorking,
                  shape: BoxShape.circle,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: theme.textTheme.titleSmall?.copyWith(
                        color: tokens.textPrimary,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    const SizedBox(height: 2),
                    Text(
                      meta,
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: tokens.textSecondary,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _ThemeTile extends StatelessWidget {
  const _ThemeTile({
    required this.spec,
    required this.name,
    required this.description,
    required this.selected,
    required this.onTap,
  });

  final ThemeSpec spec;
  final String name;
  final String description;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      onTap: onTap,
      leading: _ThemeSwatch(tokens: spec.dark),
      title: SelectionArea(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(name),
            Text(
              description,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.bodyMedium,
            ),
          ],
        ),
      ),
      trailing: selected
          ? Icon(
              Icons.check_circle,
              color: Theme.of(context).colorScheme.primary,
            )
          : null,
    );
  }
}

class _ThemeSwatch extends StatelessWidget {
  const _ThemeSwatch({required this.tokens});

  final AppTokens tokens;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 44,
      height: 30,
      decoration: BoxDecoration(
        color: tokens.canvas,
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: tokens.separator),
      ),
      child: Center(
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            _dot(tokens.accent),
            const SizedBox(width: 3),
            _dot(tokens.statusNeedsInput),
            const SizedBox(width: 3),
            _dot(tokens.textSecondary),
          ],
        ),
      ),
    );
  }

  Widget _dot(Color color) => Container(
    width: 8,
    height: 8,
    decoration: BoxDecoration(color: color, shape: BoxShape.circle),
  );
}

class _ChoiceTile extends StatelessWidget {
  const _ChoiceTile({
    required this.title,
    required this.selected,
    required this.onTap,
  });

  final String title;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return ListTile(
      onTap: onTap,
      title: Text(title),
      trailing: selected
          ? Icon(
              Icons.check_circle,
              color: Theme.of(context).colorScheme.primary,
            )
          : null,
    );
  }
}
