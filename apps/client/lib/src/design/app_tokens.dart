import 'package:flutter/material.dart';

/// Semantic design tokens for the cosyncing client.
///
/// [AppTokens] is the single contract every theme fills and every widget reads.
/// Feature code asks for a *semantic role* (`context.tokens.surface`,
/// `context.tokens.statusNeedsInput`) rather than a raw hue, so the whole app
/// re-skins by swapping the active [AppTokens] — no feature edits required.
///
/// Themes live as isolated modules under `lib/src/design/themes/` and are
/// defined by the public theme modules. See `lib/src/design/README.md`.
@immutable
class AppTokens extends ThemeExtension<AppTokens> {
  /// Creates a semantic token set for one brightness of one theme.
  const AppTokens({
    required this.canvas,
    required this.surface,
    required this.surface2,
    required this.separator,
    required this.textPrimary,
    required this.textSecondary,
    required this.textTertiary,
    required this.accent,
    required this.accentInk,
    required this.statusWorking,
    required this.statusNeedsInput,
    required this.statusIdle,
    required this.statusError,
    required this.toolOpencode,
    required this.toolCodex,
    required this.toolClaude,
    required this.toolPi,
    required this.diffAddText,
    required this.diffAddSurface,
    required this.diffRemoveText,
    required this.diffRemoveSurface,
    required this.syntaxKeyword,
    required this.syntaxString,
    required this.syntaxNumber,
    required this.syntaxComment,
    required this.syntaxLiteral,
    required this.radiusXs,
    required this.radiusSm,
    required this.radiusMd,
    required this.radiusLg,
  });

  /// App background, behind all surfaces.
  final Color canvas;

  /// Primary content plane (cards, rows, rails).
  final Color surface;

  /// Secondary fill (chips, inputs, rail).
  final Color surface2;

  /// List/section division — may be a tonal shift rather than a hard border.
  final Color separator;

  /// Primary text.
  final Color textPrimary;

  /// Secondary text / metadata.
  final Color textSecondary;

  /// Tertiary text / disabled / placeholder.
  final Color textTertiary;

  /// Brand accent — also focus and active states.
  final Color accent;

  /// High-emphasis foreground drawn on top of [accent].
  final Color accentInk;

  /// Agent running/active.
  final Color statusWorking;

  /// Agent waiting for the user.
  final Color statusNeedsInput;

  /// Session idle / completed / paused.
  final Color statusIdle;

  /// Failed action or command error.
  final Color statusError;

  /// Stable per-tool identity color: opencode.
  final Color toolOpencode;

  /// Stable per-tool identity color: codex.
  final Color toolCodex;

  /// Stable per-tool identity color: claude.
  final Color toolClaude;

  /// Stable per-tool identity color: pi.
  final Color toolPi;

  /// Diff added-line text (green family), contrast-verified per theme.
  final Color diffAddText;

  /// Diff added-line background tint.
  final Color diffAddSurface;

  /// Diff removed-line text (red family), contrast-verified per theme.
  final Color diffRemoveText;

  /// Diff removed-line background tint.
  final Color diffRemoveSurface;

  /// Fenced-code keyword, contrast-verified against [surface2] per theme.
  final Color syntaxKeyword;

  /// Fenced-code string/character literal, contrast-verified per theme.
  final Color syntaxString;

  /// Fenced-code numeric literal, contrast-verified per theme.
  final Color syntaxNumber;

  /// Fenced-code comment, contrast-verified per theme.
  final Color syntaxComment;

  /// Fenced-code built-in literal (`true`/`false`/`null`), contrast-verified
  /// per theme. Deliberately not an error/status hue: a literal is not a
  /// failure signal.
  final Color syntaxLiteral;

  /// Corner radius — badges / status indicators.
  final double radiusXs;

  /// Corner radius — chips / tiny inputs.
  final double radiusSm;

  /// Corner radius — default controls / buttons / rows.
  final double radiusMd;

  /// Corner radius — panels / dialogs.
  final double radiusLg;

  /// Resolves a tool's identity color from its wire id (`opencode`, `codex`,
  /// `claude`, `pi`); falls back to [textTertiary] for unknown tools.
  Color toolColor(String tool) {
    switch (tool.toLowerCase()) {
      case 'opencode':
        return toolOpencode;
      case 'codex':
        return toolCodex;
      case 'claude':
        return toolClaude;
      case 'pi':
        return toolPi;
      default:
        return textTertiary;
    }
  }

  @override
  AppTokens copyWith({
    Color? canvas,
    Color? surface,
    Color? surface2,
    Color? separator,
    Color? textPrimary,
    Color? textSecondary,
    Color? textTertiary,
    Color? accent,
    Color? accentInk,
    Color? statusWorking,
    Color? statusNeedsInput,
    Color? statusIdle,
    Color? statusError,
    Color? toolOpencode,
    Color? toolCodex,
    Color? toolClaude,
    Color? toolPi,
    Color? diffAddText,
    Color? diffAddSurface,
    Color? diffRemoveText,
    Color? diffRemoveSurface,
    Color? syntaxKeyword,
    Color? syntaxString,
    Color? syntaxNumber,
    Color? syntaxComment,
    Color? syntaxLiteral,
    double? radiusXs,
    double? radiusSm,
    double? radiusMd,
    double? radiusLg,
  }) {
    return AppTokens(
      canvas: canvas ?? this.canvas,
      surface: surface ?? this.surface,
      surface2: surface2 ?? this.surface2,
      separator: separator ?? this.separator,
      textPrimary: textPrimary ?? this.textPrimary,
      textSecondary: textSecondary ?? this.textSecondary,
      textTertiary: textTertiary ?? this.textTertiary,
      accent: accent ?? this.accent,
      accentInk: accentInk ?? this.accentInk,
      statusWorking: statusWorking ?? this.statusWorking,
      statusNeedsInput: statusNeedsInput ?? this.statusNeedsInput,
      statusIdle: statusIdle ?? this.statusIdle,
      statusError: statusError ?? this.statusError,
      toolOpencode: toolOpencode ?? this.toolOpencode,
      toolCodex: toolCodex ?? this.toolCodex,
      toolClaude: toolClaude ?? this.toolClaude,
      toolPi: toolPi ?? this.toolPi,
      diffAddText: diffAddText ?? this.diffAddText,
      diffAddSurface: diffAddSurface ?? this.diffAddSurface,
      diffRemoveText: diffRemoveText ?? this.diffRemoveText,
      diffRemoveSurface: diffRemoveSurface ?? this.diffRemoveSurface,
      syntaxKeyword: syntaxKeyword ?? this.syntaxKeyword,
      syntaxString: syntaxString ?? this.syntaxString,
      syntaxNumber: syntaxNumber ?? this.syntaxNumber,
      syntaxComment: syntaxComment ?? this.syntaxComment,
      syntaxLiteral: syntaxLiteral ?? this.syntaxLiteral,
      radiusXs: radiusXs ?? this.radiusXs,
      radiusSm: radiusSm ?? this.radiusSm,
      radiusMd: radiusMd ?? this.radiusMd,
      radiusLg: radiusLg ?? this.radiusLg,
    );
  }

  @override
  AppTokens lerp(covariant ThemeExtension<AppTokens>? other, double t) {
    if (other is! AppTokens) {
      return this;
    }
    return AppTokens(
      canvas: Color.lerp(canvas, other.canvas, t)!,
      surface: Color.lerp(surface, other.surface, t)!,
      surface2: Color.lerp(surface2, other.surface2, t)!,
      separator: Color.lerp(separator, other.separator, t)!,
      textPrimary: Color.lerp(textPrimary, other.textPrimary, t)!,
      textSecondary: Color.lerp(textSecondary, other.textSecondary, t)!,
      textTertiary: Color.lerp(textTertiary, other.textTertiary, t)!,
      accent: Color.lerp(accent, other.accent, t)!,
      accentInk: Color.lerp(accentInk, other.accentInk, t)!,
      statusWorking: Color.lerp(statusWorking, other.statusWorking, t)!,
      statusNeedsInput: Color.lerp(
        statusNeedsInput,
        other.statusNeedsInput,
        t,
      )!,
      statusIdle: Color.lerp(statusIdle, other.statusIdle, t)!,
      statusError: Color.lerp(statusError, other.statusError, t)!,
      toolOpencode: Color.lerp(toolOpencode, other.toolOpencode, t)!,
      toolCodex: Color.lerp(toolCodex, other.toolCodex, t)!,
      toolClaude: Color.lerp(toolClaude, other.toolClaude, t)!,
      toolPi: Color.lerp(toolPi, other.toolPi, t)!,
      diffAddText: Color.lerp(diffAddText, other.diffAddText, t)!,
      diffAddSurface: Color.lerp(diffAddSurface, other.diffAddSurface, t)!,
      diffRemoveText: Color.lerp(diffRemoveText, other.diffRemoveText, t)!,
      diffRemoveSurface: Color.lerp(
        diffRemoveSurface,
        other.diffRemoveSurface,
        t,
      )!,
      syntaxKeyword: Color.lerp(syntaxKeyword, other.syntaxKeyword, t)!,
      syntaxString: Color.lerp(syntaxString, other.syntaxString, t)!,
      syntaxNumber: Color.lerp(syntaxNumber, other.syntaxNumber, t)!,
      syntaxComment: Color.lerp(syntaxComment, other.syntaxComment, t)!,
      syntaxLiteral: Color.lerp(syntaxLiteral, other.syntaxLiteral, t)!,
      radiusXs: _lerpDouble(radiusXs, other.radiusXs, t),
      radiusSm: _lerpDouble(radiusSm, other.radiusSm, t),
      radiusMd: _lerpDouble(radiusMd, other.radiusMd, t),
      radiusLg: _lerpDouble(radiusLg, other.radiusLg, t),
    );
  }

  static double _lerpDouble(double a, double b, double t) => a + (b - a) * t;
}

/// Ergonomic access to the active [AppTokens] from any [BuildContext].
///
/// `context.tokens` reads the active [AppTokens]. Every app theme attaches one
/// via `buildAppTheme`, so it is non-null under the app's MaterialApp.
extension AppTokensContext on BuildContext {
  /// The active semantic tokens for the current theme + brightness.
  AppTokens get tokens => Theme.of(this).extension<AppTokens>()!;
}
