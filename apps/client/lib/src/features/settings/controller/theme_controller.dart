import 'package:cosyncing_client/src/design/theme_spec.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/settings/data/ui_preferences_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The user's active theme choice: which [ThemeSpec] and which light/dark mode.
@immutable
class ThemeSelection {
  /// Creates a theme selection.
  const ThemeSelection({required this.themeId, required this.mode});

  /// The selected theme's stable id (see [kAppThemes]).
  final String themeId;

  /// Light / dark / follow-system.
  final ThemeMode mode;

  /// The resolved [ThemeSpec] for [themeId] (falls back to the default theme).
  ThemeSpec get spec => themeSpecById(themeId);

  /// Returns a copy with the given overrides.
  ThemeSelection copyWith({String? themeId, ThemeMode? mode}) => ThemeSelection(
    themeId: themeId ?? this.themeId,
    mode: mode ?? this.mode,
  );
}

/// Default selection used before persistence has loaded or when nothing has
/// been chosen yet: the default theme, following the system light/dark setting.
const ThemeSelection kFallbackThemeSelection = ThemeSelection(
  themeId: kDefaultThemeId,
  mode: ThemeMode.system,
);

String _modeToken(ThemeMode mode) => switch (mode) {
  ThemeMode.light => 'light',
  ThemeMode.dark => 'dark',
  ThemeMode.system => 'system',
};

ThemeMode _modeFromToken(String? token) => switch (token) {
  'light' => ThemeMode.light,
  'dark' => ThemeMode.dark,
  _ => ThemeMode.system,
};

/// Durable theme selection (theme id + light/dark mode).
final themeControllerProvider =
    AsyncNotifierProvider<ThemeController, ThemeSelection>(ThemeController.new);

/// Loads and persists the active [ThemeSelection].
class ThemeController extends AsyncNotifier<ThemeSelection> {
  UiPreferencesStore get _store => ref.read(uiPreferencesStoreProvider);

  @override
  Future<ThemeSelection> build() async {
    final id = await _store.getThemeId() ?? kDefaultThemeId;
    final mode = _modeFromToken(await _store.getThemeMode());
    return ThemeSelection(themeId: themeSpecById(id).id, mode: mode);
  }

  /// Selects a theme by id and persists it.
  Future<void> selectTheme(String themeId) async {
    final resolved = themeSpecById(themeId).id;
    final current = state.valueOrNull;
    state = AsyncData(
      (current ?? kFallbackThemeSelection).copyWith(themeId: resolved),
    );
    await _store.setThemeId(resolved);
  }

  /// Sets the light/dark/system mode and persists it.
  Future<void> setMode(ThemeMode mode) async {
    final current = state.valueOrNull;
    state = AsyncData(
      (current ?? kFallbackThemeSelection).copyWith(mode: mode),
    );
    await _store.setThemeMode(_modeToken(mode));
  }
}
