import 'package:cosyncing_client/src/design/app_tokens.dart';

/// One selectable theme: id, display name, and its light + dark tokens.
///
/// Themes are isolated modules under `lib/src/design/themes/`, generated from
/// the design `tokens.md` files. Registered in `theme_registry.dart` and
/// selected by the user in Settings → Appearance.
class ThemeSpec {
  /// Creates a theme specification.
  const ThemeSpec({
    required this.id,
    required this.name,
    required this.description,
    required this.light,
    required this.dark,
  });

  /// Stable persisted identifier (e.g. `teal-obsidian`).
  final String id;

  /// Human-facing name (e.g. `Teal Obsidian`).
  final String name;

  /// One-line rationale, shown in the theme picker.
  final String description;

  /// Light-mode tokens.
  final AppTokens light;

  /// Dark-mode tokens.
  final AppTokens dark;

  /// The token set for the given brightness (dark when [isDark]).
  AppTokens tokensFor({required bool isDark}) => isDark ? dark : light;
}
