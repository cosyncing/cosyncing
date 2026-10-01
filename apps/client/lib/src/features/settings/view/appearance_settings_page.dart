import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/design/ui_scale.dart';
import 'package:cosyncing_client/src/features/settings/controller/locale_controller.dart';
import 'package:cosyncing_client/src/features/settings/controller/theme_controller.dart';
import 'package:cosyncing_client/src/features/settings/controller/ui_scale_controller.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Settings → Appearance, reachable on its own at its published route. The
/// same section heads Settings → Display.
class AppearanceSettingsPage extends StatelessWidget {
  /// Creates the appearance settings screen.
  const AppearanceSettingsPage({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: Text(AppLocalizations.of(context).appearanceTitle)),
      body: const SettingsPageBody(children: [AppearanceSettingsSection()]),
    );
  }
}

/// Theme, light or dark, text size, density and language: one select each.
class AppearanceSettingsSection extends ConsumerWidget {
  /// Creates the appearance section.
  const AppearanceSettingsSection({super.key});

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
    final brightness = Theme.of(context).brightness;

    return SettingsSection(
      title: l10n.appearanceTitle,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          SettingsRow(
            stackTrailing: true,
            title: Text(l10n.themeModeLabel),
            trailing: SettingsSelect<ThemeMode>(
              key: const Key('appearance-theme-mode'),
              value: selection.mode,
              options: [
                SettingsSelectOption(
                  value: ThemeMode.system,
                  label: l10n.themeModeSystem,
                ),
                SettingsSelectOption(
                  value: ThemeMode.light,
                  label: l10n.themeModeLight,
                ),
                SettingsSelectOption(
                  value: ThemeMode.dark,
                  label: l10n.themeModeDark,
                ),
              ],
              onChanged: (mode) =>
                  ref.read(themeControllerProvider.notifier).setMode(mode),
            ),
          ),
          SettingsRow(
            stackTrailing: true,
            title: Text(l10n.themeLabel),
            subtitle: Text(
              _themeDescription(l10n, selection.themeId),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
            ),
            trailing: SettingsSelect<String>(
              key: const Key('appearance-theme'),
              value: selection.themeId,
              options: [
                for (final theme in kAppThemes)
                  SettingsSelectOption(
                    value: theme.id,
                    label: _themeName(l10n, theme.id),
                    leading: _ThemeSwatch(
                      tokens: brightness == Brightness.dark
                          ? theme.dark
                          : theme.light,
                    ),
                  ),
              ],
              onChanged: (id) =>
                  ref.read(themeControllerProvider.notifier).selectTheme(id),
            ),
          ),
          SettingsRow(
            stackTrailing: true,
            title: Text(l10n.textSizeLabel),
            trailing: SettingsSelect<UiTextScale>(
              key: const Key('appearance-text-scale'),
              value: uiScale.textScale,
              options: [
                for (final scale in UiTextScale.values)
                  SettingsSelectOption(
                    value: scale,
                    label: _textScaleLabel(l10n, scale),
                  ),
              ],
              onChanged: (scale) => ref
                  .read(uiScaleControllerProvider.notifier)
                  .setTextScale(scale),
            ),
          ),
          SettingsRow(
            stackTrailing: true,
            title: Text(l10n.densityLabel),
            trailing: SettingsSelect<UiDensity>(
              key: const Key('appearance-density'),
              value: uiScale.density,
              options: [
                SettingsSelectOption(
                  value: UiDensity.compact,
                  label: l10n.densityCompact,
                ),
                SettingsSelectOption(
                  value: UiDensity.comfortable,
                  label: l10n.densityComfortable,
                ),
                SettingsSelectOption(
                  value: UiDensity.spacious,
                  label: l10n.densitySpacious,
                ),
              ],
              onChanged: (density) => ref
                  .read(uiScaleControllerProvider.notifier)
                  .setDensity(density),
            ),
          ),
          SettingsRow(
            stackTrailing: true,
            title: Text(l10n.languageLabel),
            trailing: SettingsSelect<String>(
              key: const Key('appearance-language'),
              value: activeLanguage,
              options: [
                SettingsSelectOption(
                  value: _systemLanguageValue,
                  label: l10n.languageSystem,
                ),
                // Driven by `kSupportedLocales` so adding a locale changes one
                // loop input rather than duplicating an option. `_languageName`
                // owns the corresponding native-language label.
                for (final locale in kSupportedLocales)
                  SettingsSelectOption(
                    value: locale.languageCode,
                    label: _languageName(l10n, locale.languageCode),
                  ),
              ],
              onChanged: (code) => ref
                  .read(localeControllerProvider.notifier)
                  .setLocale(
                    code == _systemLanguageValue
                        ? null
                        : kSupportedLocales.firstWhere(
                            (locale) => locale.languageCode == code,
                          ),
                  ),
            ),
          ),
        ],
      ),
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
  'quiet-workspace' => l10n.themeQuietWorkspaceName,
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
  'quiet-workspace' => l10n.themeQuietWorkspaceDescription,
  'teal-obsidian' => l10n.themeTealObsidianDescription,
  'graphite-minimalist' => l10n.themeGraphiteMinimalistDescription,
  'nordic-warmth' => l10n.themeNordicWarmthDescription,
  'flat-white-minimalist' => l10n.themeFlatWhiteMinimalistDescription,
  'cyber-amber' => l10n.themeCyberAmberDescription,
  'royal-navy' => l10n.themeRoyalNavyDescription,
  'soft-minimalist' => l10n.themeSoftMinimalistDescription,
  _ => '',
};

/// A theme's canvas with its accent and attention colors, small enough to
/// sit beside the theme's name in the select.
class _ThemeSwatch extends StatelessWidget {
  const _ThemeSwatch({required this.tokens});

  final AppTokens tokens;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 28,
      height: 18,
      decoration: BoxDecoration(
        color: tokens.canvas,
        borderRadius: BorderRadius.circular(tokens.radiusXs),
        border: Border.all(color: context.tokens.separator),
      ),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          _dot(tokens.accent),
          const SizedBox(width: 2),
          _dot(tokens.statusNeedsInput),
        ],
      ),
    );
  }

  Widget _dot(Color color) => Container(
    width: 6,
    height: 6,
    decoration: BoxDecoration(color: color, shape: BoxShape.circle),
  );
}

/// The name of [languageCode], written in that language.
///
/// Every registered locale should appear here. The raw-code fallback keeps
/// Settings usable if registration and localization temporarily drift; tests
/// should catch that drift before release.
String _languageName(AppLocalizations l10n, String languageCode) =>
    switch (languageCode) {
      'en' => l10n.languageEnglish,
      'zh' => l10n.languageChinese,
      'ja' => l10n.languageJapanese,
      'ko' => l10n.languageKorean,
      'es' => l10n.languageSpanish,
      _ => languageCode,
    };
