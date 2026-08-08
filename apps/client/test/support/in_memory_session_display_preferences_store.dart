import 'package:cosyncing_client/src/features/settings/data/session_display_preferences_store.dart';

/// Deterministic, database-free display preferences for widget tests.
final class InMemorySessionDisplayPreferencesStore
    implements SessionDisplayPreferencesStore {
  String? toolDisplayMode;
  String? sessionRosterWindow;
  bool showBackgroundSessions = false;
  bool showVscodeSessions = true;

  @override
  Future<String?> getToolDisplayMode() async => toolDisplayMode;

  @override
  Future<void> setToolDisplayMode(String token) async {
    toolDisplayMode = token;
  }

  @override
  Future<bool> getShowBackgroundSessions() async => showBackgroundSessions;

  @override
  Future<void> setShowBackgroundSessions({required bool show}) async {
    showBackgroundSessions = show;
  }

  @override
  Future<bool> getShowVscodeSessions() async => showVscodeSessions;

  @override
  Future<void> setShowVscodeSessions({required bool show}) async {
    showVscodeSessions = show;
  }

  @override
  Future<String?> getSessionRosterWindow() async => sessionRosterWindow;

  @override
  Future<void> setSessionRosterWindow(String token) async {
    sessionRosterWindow = token;
  }
}
