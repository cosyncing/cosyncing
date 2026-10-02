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

  final theme = ThemeData(
    useMaterial3: true,
    fontFamily: 'Lato',
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
    // The scheme leaves secondaryContainer to default to secondary, the
    // accent, which is also the bar's fill: every determinate bar drew full
    // whatever its value. The separator is the unfilled hairline instead.
    progressIndicatorTheme: ProgressIndicatorThemeData(
      linearTrackColor: t.separator,
    ),
    scrollbarTheme: ScrollbarThemeData(
      thickness: const WidgetStatePropertyAll(4),
      radius: Radius.circular(t.radiusXs),
      // A map, not `resolveWith`: a closure is a new object on every call, so
      // two themes built from the same tokens never compared equal, and every
      // rebuild above MaterialApp read as a theme change that rebuilt the app.
      thumbColor: WidgetStateProperty<Color?>.fromMap({
        WidgetState.dragged: t.textTertiary.withValues(alpha: 0.6),
        WidgetState.any: t.textTertiary.withValues(alpha: 0.3),
      }),
      trackVisibility: const WidgetStatePropertyAll(false),
    ),
    dividerTheme: DividerThemeData(color: t.separator, space: 1, thickness: 1),
  );
  return theme.copyWith(
    textTheme: _untracked(theme.textTheme),
    primaryTextTheme: _untracked(theme.primaryTextTheme),
  );
}

/// Material 3's per-role tracking (0.1-0.5 logical pixels) spaces Lato out
/// noticeably at the small sizes this app uses; the reviewed design sets
/// every role at the font's natural spacing.
TextTheme _untracked(TextTheme theme) {
  TextStyle? flat(TextStyle? style) => style?.copyWith(letterSpacing: 0);
  return theme.copyWith(
    displayLarge: flat(theme.displayLarge),
    displayMedium: flat(theme.displayMedium),
    displaySmall: flat(theme.displaySmall),
    headlineLarge: flat(theme.headlineLarge),
    headlineMedium: flat(theme.headlineMedium),
    headlineSmall: flat(theme.headlineSmall),
    titleLarge: flat(theme.titleLarge),
    titleMedium: flat(theme.titleMedium),
    titleSmall: flat(theme.titleSmall),
    bodyLarge: flat(theme.bodyLarge),
    bodyMedium: flat(theme.bodyMedium),
    bodySmall: flat(theme.bodySmall),
    labelLarge: flat(theme.labelLarge),
    labelMedium: flat(theme.labelMedium),
    labelSmall: flat(theme.labelSmall),
  );
}
