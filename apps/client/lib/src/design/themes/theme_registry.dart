// Public theme registry. Update together with the theme modules.
// ignore_for_file: lines_longer_than_80_chars
import 'package:cosyncing_client/src/design/theme_spec.dart';
import 'package:cosyncing_client/src/design/themes/cyber_amber_theme.dart';
import 'package:cosyncing_client/src/design/themes/flat_white_minimalist_theme.dart';
import 'package:cosyncing_client/src/design/themes/graphite_minimalist_theme.dart';
import 'package:cosyncing_client/src/design/themes/nordic_warmth_theme.dart';
import 'package:cosyncing_client/src/design/themes/royal_navy_theme.dart';
import 'package:cosyncing_client/src/design/themes/soft_minimalist_theme.dart';
import 'package:cosyncing_client/src/design/themes/teal_obsidian_theme.dart';

/// All selectable themes, in display order. Shown in Settings → Appearance.
const List<ThemeSpec> kAppThemes = <ThemeSpec>[
  tealObsidianTheme,
  graphiteMinimalistTheme,
  nordicWarmthTheme,
  flatWhiteMinimalistTheme,
  cyberAmberTheme,
  royalNavyTheme,
  softMinimalistTheme,
];

/// Default theme id used before any user selection.
const String kDefaultThemeId = 'teal-obsidian';

/// Resolves a persisted theme id to its [ThemeSpec], falling back to the first
/// registered theme for unknown / null ids.
ThemeSpec themeSpecById(String? id) {
  for (final theme in kAppThemes) {
    if (theme.id == id) {
      return theme;
    }
  }
  return kAppThemes.first;
}
