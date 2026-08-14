import 'package:cosyncing_client/src/features/settings/data/session_display_preferences_store.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Device-local roster query window saved across restarts.
enum SessionRosterQueryWindow {
  /// Explicit unbounded history.
  any('all'),

  /// Sessions active today.
  today('1d'),

  /// Fresh-install default.
  last7Days('7d'),

  /// Sessions active in the last thirty days.
  last30Days('1m');

  const SessionRosterQueryWindow(this.queryValue);

  /// Broker `window` query value.
  final String queryValue;
}

/// Persists the user's roster time choice; fresh installs use seven days.
final sessionRosterWindowProvider =
    AsyncNotifierProvider<
      SessionRosterWindowController,
      SessionRosterQueryWindow
    >(SessionRosterWindowController.new);

/// Controller for the durable query-window preference.
class SessionRosterWindowController
    extends AsyncNotifier<SessionRosterQueryWindow> {
  @override
  Future<SessionRosterQueryWindow> build() async {
    final value = await ref
        .read(sessionDisplayPreferencesStoreProvider)
        .getSessionRosterWindow();
    return SessionRosterQueryWindow.values.firstWhere(
      (window) => window.queryValue == value,
      orElse: () => SessionRosterQueryWindow.last7Days,
    );
  }

  /// Saves [window] before publishing it to request owners.
  Future<void> setWindow(SessionRosterQueryWindow window) async {
    final previous = state.valueOrNull ?? SessionRosterQueryWindow.last7Days;
    if (previous == window) return;
    state = const AsyncLoading();
    try {
      await ref
          .read(sessionDisplayPreferencesStoreProvider)
          .setSessionRosterWindow(window.queryValue);
      state = AsyncData(window);
    } on Object catch (error, stackTrace) {
      state = AsyncData(previous);
      Error.throwWithStackTrace(error, stackTrace);
    }
  }
}
