import 'package:flutter/material.dart';

/// User-tunable text size for the whole app.
///
/// [UiTextScale.system] follows the operating-system text-scaling accessibility
/// setting; every other value pins the app to a fixed [TextScaler] regardless
/// of the OS setting. The active value is applied once at the app root
/// (`MaterialApp.builder`) so list, tabs, transcript and settings all shift
/// together — see `docs/architecture/client-ui.md`.
enum UiTextScale {
  /// Follow the operating-system text-scaling setting.
  system,

  /// Small — 0.85×.
  small,

  /// Standard — 1.0×, ignoring the OS setting.
  standard,

  /// Large — 1.15×.
  large,

  /// Extra large — 1.3×.
  extraLarge;

  /// The fixed linear scale factor, or `null` to follow the OS setting.
  double? get factor => switch (this) {
    UiTextScale.system => null,
    UiTextScale.small => 0.85,
    UiTextScale.standard => 1,
    UiTextScale.large => 1.15,
    UiTextScale.extraLarge => 1.3,
  };

  /// The stable token persisted for this value.
  String get token => name;

  /// The concrete (pinned) values, ordered smallest factor first.
  ///
  /// [UiTextScale.system] is deliberately excluded. It is enum index 0, but it
  /// carries a `null` factor meaning "follow the OS" — it is not the smallest
  /// size. Anything that walks text sizes in order (keyboard zoom, Ctrl+wheel)
  /// must step along this ladder, never along [values].
  static const List<UiTextScale> ladder = [
    UiTextScale.small,
    UiTextScale.standard,
    UiTextScale.large,
    UiTextScale.extraLarge,
  ];

  /// The [ladder] entry whose factor sits closest to [factor].
  ///
  /// Used to resolve [UiTextScale.system] to a concrete rung before stepping,
  /// so the first keyboard zoom continues from the size the user currently
  /// sees rather than jumping. Ties resolve to the smaller size.
  static UiTextScale nearestTo(double factor) {
    var nearest = ladder.first;
    var nearestDelta = (ladder.first.factor! - factor).abs();
    for (final value in ladder.skip(1)) {
      final delta = (value.factor! - factor).abs();
      if (delta < nearestDelta) {
        nearest = value;
        nearestDelta = delta;
      }
    }
    return nearest;
  }

  /// Parses a persisted [token]; an unknown or null token falls back to
  /// [UiTextScale.system].
  static UiTextScale fromToken(String? token) => values.firstWhere(
    (value) => value.name == token,
    orElse: () => UiTextScale.system,
  );
}

/// User-tunable interface density for Material components.
///
/// Applied via [VisualDensity] on the Material theme, so buttons, list rows and
/// inputs tighten or loosen together. [UiDensity.comfortable] preserves the
/// platform-adaptive default.
enum UiDensity {
  /// Tighter spacing and control sizes.
  compact,

  /// Platform-appropriate default spacing.
  comfortable,

  /// Roomier spacing and larger touch targets.
  spacious;

  /// The [VisualDensity] applied to the Material theme for this value.
  VisualDensity get visualDensity => switch (this) {
    UiDensity.compact => VisualDensity.compact,
    UiDensity.comfortable => VisualDensity.adaptivePlatformDensity,
    UiDensity.spacious => const VisualDensity(horizontal: 1, vertical: 1),
  };

  /// The stable token persisted for this value.
  String get token => name;

  /// Parses a persisted [token]; an unknown or null token falls back to
  /// [UiDensity.comfortable].
  static UiDensity fromToken(String? token) => values.firstWhere(
    (value) => value.name == token,
    orElse: () => UiDensity.comfortable,
  );
}

/// The user's combined UI-size choice: text size + interface density.
@immutable
class UiScaleSettings {
  /// Creates a UI-size settings snapshot.
  const UiScaleSettings({
    this.textScale = UiTextScale.system,
    this.density = UiDensity.comfortable,
  });

  /// Active text-size choice.
  final UiTextScale textScale;

  /// Active interface-density choice.
  final UiDensity density;

  /// Returns a copy with the given overrides.
  UiScaleSettings copyWith({UiTextScale? textScale, UiDensity? density}) =>
      UiScaleSettings(
        textScale: textScale ?? this.textScale,
        density: density ?? this.density,
      );

  @override
  bool operator ==(Object other) =>
      other is UiScaleSettings &&
      other.textScale == textScale &&
      other.density == density;

  @override
  int get hashCode => Object.hash(textScale, density);
}

/// Default UI-size settings: follow the OS text size at platform-default
/// density. Used before persistence loads or when nothing has been chosen.
const UiScaleSettings kDefaultUiScaleSettings = UiScaleSettings();
