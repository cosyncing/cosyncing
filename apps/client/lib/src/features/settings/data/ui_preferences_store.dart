import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Setting key for the active theme id.
const String uiThemeIdSettingKey = 'ui_theme_id';

/// Setting key for the light/dark/system mode token.
const String uiThemeModeSettingKey = 'ui_theme_mode';

/// Setting key for the UI locale language tag.
const String uiLocaleSettingKey = 'ui_locale';

/// Setting key for the text-size token.
const String uiTextScaleSettingKey = 'ui_text_scale';

/// Setting key for the interface-density token.
const String uiDensitySettingKey = 'ui_density';

/// Setting key for the default-off Developer options "Show debug views" gate.
const String uiShowDebugViewsSettingKey = 'ui_show_debug_views';

/// Durable abstraction for user-selected UI preferences: which theme is active,
/// the light/dark mode, and the language.
///
/// All values are optional; a missing value means "not yet chosen" and the
/// controllers fall back to their defaults (default theme, system mode, system
/// locale).
abstract interface class UiPreferencesStore {
  /// Persisted theme id, or null if unset.
  Future<String?> getThemeId();

  /// Persists the active theme id.
  Future<void> setThemeId(String themeId);

  /// Persisted theme-mode token (`system` | `light` | `dark`), or null.
  Future<String?> getThemeMode();

  /// Persists the theme-mode token.
  Future<void> setThemeMode(String mode);

  /// Persisted locale tag (e.g. `en`, `zh`); empty = system; null if unset.
  Future<String?> getLocaleTag();

  /// Persists the locale language tag (empty string means "follow system").
  Future<void> setLocaleTag(String tag);

  /// Persisted text-size token, or null if unset.
  Future<String?> getTextScale();

  /// Persists the text-size token.
  Future<void> setTextScale(String token);

  /// Persisted interface-density token, or null if unset.
  Future<String?> getDensity();

  /// Persists the interface-density token.
  Future<void> setDensity(String token);

  /// Whether read-only Debug views are shown; null (or malformed) means unset,
  /// which the controller resolves to the default-off state.
  Future<bool?> getShowDebugViews();

  /// Persists the "Show debug views" developer preference.
  Future<void> setShowDebugViews({required bool value});
}

/// Drift-backed [UiPreferencesStore] over the shared app settings table.
class DriftUiPreferencesStore implements UiPreferencesStore {
  /// Creates the store over [database].
  DriftUiPreferencesStore(this.database);

  /// App-local durable database.
  final AppDatabase database;

  Future<String?> _read(String key) async {
    final row = await (database.select(
      database.appSettingRows,
    )..where((table) => table.key.equals(key))).getSingleOrNull();
    return row?.value;
  }

  Future<void> _write(String key, String value) async {
    await database
        .into(database.appSettingRows)
        .insertOnConflictUpdate(
          AppSettingRowsCompanion.insert(
            key: key,
            value: value,
            updatedAt: DateTime.now(),
          ),
        );
  }

  @override
  Future<String?> getThemeId() => _read(uiThemeIdSettingKey);

  @override
  Future<void> setThemeId(String themeId) =>
      _write(uiThemeIdSettingKey, themeId);

  @override
  Future<String?> getThemeMode() => _read(uiThemeModeSettingKey);

  @override
  Future<void> setThemeMode(String mode) => _write(uiThemeModeSettingKey, mode);

  @override
  Future<String?> getLocaleTag() => _read(uiLocaleSettingKey);

  @override
  Future<void> setLocaleTag(String tag) => _write(uiLocaleSettingKey, tag);

  @override
  Future<String?> getTextScale() => _read(uiTextScaleSettingKey);

  @override
  Future<void> setTextScale(String token) =>
      _write(uiTextScaleSettingKey, token);

  @override
  Future<String?> getDensity() => _read(uiDensitySettingKey);

  @override
  Future<void> setDensity(String token) => _write(uiDensitySettingKey, token);

  @override
  Future<bool?> getShowDebugViews() async {
    final value = await _read(uiShowDebugViewsSettingKey);
    if (value == null) return null;
    // Any non-`true` stored value (including a malformed one) reads as false.
    return value == 'true';
  }

  @override
  Future<void> setShowDebugViews({required bool value}) =>
      _write(uiShowDebugViewsSettingKey, value.toString());
}

/// Provider for the durable UI preferences store.
final uiPreferencesStoreProvider = Provider<UiPreferencesStore>((ref) {
  return DriftUiPreferencesStore(ref.watch(appDatabaseProvider));
});
