import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:flutter/material.dart';

/// Builds a Material [ThemeData] from a semantic [AppTokens] set.
///
/// The [AppTokens] are attached as a theme extension, so feature widgets can
/// read semantic roles via `context.tokens` while Material components inherit a
/// consistent [ColorScheme] derived from the same tokens.
/// Per-tool identity colors, including omp, remain on [AppTokens] because they
/// are feature identities rather than global Material color roles.
///
/// [density] tunes Material component spacing (see the user-facing Density
/// control in Settings → Appearance); it defaults to the platform-adaptive
/// value.
ThemeData buildAppTheme(
  AppTokens t,
  Brightness brightness, {
  VisualDensity? density,
}) {
  final isDark = brightness == Brightness.dark;

  final colorScheme = ColorScheme(
    brightness: brightness,
    primary: t.accent,
    onPrimary: t.accentInk,
    primaryContainer: t.surface2,
    onPrimaryContainer: t.textPrimary,
    secondary: t.accent,
    onSecondary: t.accentInk,
    tertiary: t.accent,
    onTertiary: t.accentInk,
    error: t.statusError,
    onError: isDark ? Colors.black : Colors.white,
    errorContainer: t.statusError.withValues(alpha: 0.16),
    onErrorContainer: t.textPrimary,
    surface: t.surface,
    onSurface: t.textPrimary,
    surfaceContainerLowest: t.canvas,
    surfaceContainerLow: t.surface,
    surfaceContainer: t.surface2,
    surfaceContainerHigh: t.surface2,
    surfaceContainerHighest: t.surface2,
    onSurfaceVariant: t.textSecondary,
    outline: t.separator,
    outlineVariant: t.separator,
    shadow: Colors.black,
    scrim: Colors.black,
    inverseSurface: t.textPrimary,
    onInverseSurface: t.surface,
    inversePrimary: t.accent,
  );

  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    colorScheme: colorScheme,
    scaffoldBackgroundColor: t.canvas,
    visualDensity: density ?? VisualDensity.adaptivePlatformDensity,
    extensions: <ThemeExtension<dynamic>>[t],
    appBarTheme: AppBarTheme(
      backgroundColor: t.canvas,
      foregroundColor: t.textPrimary,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
    ),
    dividerTheme: DividerThemeData(color: t.separator, space: 1, thickness: 1),
  );
}
