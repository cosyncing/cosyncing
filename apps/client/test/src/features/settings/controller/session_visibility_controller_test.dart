import 'package:cosyncing_client/src/features/settings/controller/session_visibility_controller.dart';
import 'package:cosyncing_client/src/features/settings/data/session_display_preferences_store.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late _MemoryDisplayPreferencesStore store;
  late ProviderContainer container;

  setUp(() {
    store = _MemoryDisplayPreferencesStore();
    container = ProviderContainer(
      overrides: [
        sessionDisplayPreferencesStoreProvider.overrideWithValue(store),
      ],
    );
  });

  tearDown(() => container.dispose());

  test('hydrates the global default filters', () async {
    final settings = await container.read(
      sessionVisibilityControllerProvider.future,
    );
    expect(settings.showBackgroundSessions, isFalse);
    expect(settings.showVscodeSessions, isTrue);
  });

  test('persists background and VS Code choices', () async {
    await container.read(sessionVisibilityControllerProvider.future);
    await container
        .read(sessionVisibilityControllerProvider.notifier)
        .setShowBackgroundSessions(show: true);
    await container
        .read(sessionVisibilityControllerProvider.notifier)
        .setShowVscodeSessions(show: false);

    final settings = container
        .read(sessionVisibilityControllerProvider)
        .valueOrNull!;
    expect(settings.showBackgroundSessions, isTrue);
    expect(settings.showVscodeSessions, isFalse);
    expect(store.showBackground, isTrue);
    expect(store.showVscode, isFalse);
  });
}

final class _MemoryDisplayPreferencesStore
    implements SessionDisplayPreferencesStore {
  bool showBackground = false;
  bool showVscode = true;

  @override
  Future<String?> getToolDisplayMode() async => null;

  @override
  Future<void> setToolDisplayMode(String token) async {}

  @override
  Future<bool> getShowBackgroundSessions() async => showBackground;

  @override
  Future<void> setShowBackgroundSessions({required bool show}) async {
    showBackground = show;
  }

  @override
  Future<bool> getShowVscodeSessions() async => showVscode;

  @override
  Future<void> setShowVscodeSessions({required bool show}) async {
    showVscode = show;
  }

  @override
  Future<String?> getSessionRosterWindow() async => null;

  @override
  Future<void> setSessionRosterWindow(String token) async {}
}
