import 'package:cosyncing_client/src/features/settings/data/session_display_preferences_store.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Device-local roster query window saved across restarts.
@immutable
final class SessionRosterQueryWindow {
  const SessionRosterQueryWindow._(this.days);

  /// A custom rolling window, up to one hundred years.
  const SessionRosterQueryWindow.custom(int days)
    : assert(days > 0 && days <= 36500, 'Days must be between 1 and 36500'),
      days = days;

  /// Restores presets and valid custom choices from device storage.
  factory SessionRosterQueryWindow.parse(String? value) {
    for (final preset in values) {
      if (preset.queryValue == value) return preset;
    }
    final match = RegExp(r'^(\d+)d$').firstMatch(value ?? '');
    final days = int.tryParse(match?.group(1) ?? '');
    return days != null && days > 0 && days <= 36500
        ? SessionRosterQueryWindow.custom(days)
        : last7Days;
  }

  /// Rolling day count, or null for all time.
  final int? days;

  /// All sessions regardless of activity.
  static const any = SessionRosterQueryWindow._(null);

  /// Last twenty-four hours.
  static const today = SessionRosterQueryWindow._(1);

  /// Last seven days, the default.
  static const last7Days = SessionRosterQueryWindow._(7);

  /// Last thirty days.
  static const last30Days = SessionRosterQueryWindow._(30);

  /// Compact preset choices.
  static const List<SessionRosterQueryWindow> values = [
    any,
    today,
    last7Days,
    last30Days,
  ];

  /// Broker query and persisted preference value.
  String get queryValue => days == null
      ? 'all'
      : days == 30
      ? '1m'
      : '${days}d';
  @override
  bool operator ==(Object other) =>
      other is SessionRosterQueryWindow && other.days == days;
  @override
  int get hashCode => days.hashCode;
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
    return SessionRosterQueryWindow.parse(value);
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
