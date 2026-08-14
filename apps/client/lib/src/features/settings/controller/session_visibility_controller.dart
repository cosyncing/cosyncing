import 'package:cosyncing_client/src/features/sessions/roster/session_roster_projection.dart';
import 'package:cosyncing_client/src/features/settings/data/session_display_preferences_store.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Device-global origin filters used by compact and expanded rosters.
final sessionVisibilityControllerProvider =
    AsyncNotifierProvider<
      SessionVisibilityController,
      SessionVisibilityPreferences
    >(SessionVisibilityController.new);

/// Loads and persists roster visibility settings.
final class SessionVisibilityController
    extends AsyncNotifier<SessionVisibilityPreferences> {
  SessionDisplayPreferencesStore get _store =>
      ref.read(sessionDisplayPreferencesStoreProvider);

  @override
  Future<SessionVisibilityPreferences> build() async {
    final (showBackground, showVscode) = await (
      _store.getShowBackgroundSessions(),
      _store.getShowVscodeSessions(),
    ).wait;
    return SessionVisibilityPreferences(
      showBackgroundSessions: showBackground,
      showVscodeSessions: showVscode,
    );
  }

  /// Shows or hides subagent and automated-exec rows.
  Future<void> setShowBackgroundSessions({required bool show}) async {
    final current = state.valueOrNull ?? const SessionVisibilityPreferences();
    state = AsyncData(current.copyWith(showBackgroundSessions: show));
    await _store.setShowBackgroundSessions(show: show);
  }

  /// Shows or hides IDE-extension rows.
  Future<void> setShowVscodeSessions({required bool show}) async {
    final current = state.valueOrNull ?? const SessionVisibilityPreferences();
    state = AsyncData(current.copyWith(showVscodeSessions: show));
    await _store.setShowVscodeSessions(show: show);
  }
}
