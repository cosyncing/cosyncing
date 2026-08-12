import 'package:cosyncing_client/src/features/voice/data/read_aloud_preferences_store.dart';

/// In-memory read-aloud preferences for controller and widget tests.
final class InMemoryReadAloudPreferencesStore
    implements ReadAloudPreferencesStore {
  /// Creates the store with an optional persisted value.
  InMemoryReadAloudPreferencesStore({this.value});

  /// Stored multiplier text.
  String? value;

  @override
  Future<String?> getRate() async => value;

  @override
  Future<void> setRate(double rate) async {
    value = rate.toString();
  }
}
