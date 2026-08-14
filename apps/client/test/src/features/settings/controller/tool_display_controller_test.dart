import 'package:cosyncing_client/src/features/sessions/transcript/tool_display_mode.dart';
import 'package:cosyncing_client/src/features/settings/controller/tool_display_controller.dart';
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

  test('defaults unknown and absent values to Responsive', () async {
    expect(
      await container.read(toolDisplayControllerProvider.future),
      ToolDisplayMode.responsive,
    );

    container.dispose();
    store.toolMode = 'future-mode';
    container = ProviderContainer(
      overrides: [
        sessionDisplayPreferencesStoreProvider.overrideWithValue(store),
      ],
    );
    expect(
      await container.read(toolDisplayControllerProvider.future),
      ToolDisplayMode.responsive,
    );
  });

  test('exposes and persists a selected mode', () async {
    await container.read(toolDisplayControllerProvider.future);
    await container
        .read(toolDisplayControllerProvider.notifier)
        .setMode(ToolDisplayMode.finalMessagesOnly);

    expect(store.toolMode, 'final-messages-only');
    expect(
      container.read(toolDisplayControllerProvider).valueOrNull,
      ToolDisplayMode.finalMessagesOnly,
    );
  });
}

final class _MemoryDisplayPreferencesStore
    implements SessionDisplayPreferencesStore {
  String? toolMode;
  bool showBackground = false;
  bool showVscode = true;

  @override
  Future<String?> getToolDisplayMode() async => toolMode;

  @override
  Future<void> setToolDisplayMode(String token) async {
    toolMode = token;
  }

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
