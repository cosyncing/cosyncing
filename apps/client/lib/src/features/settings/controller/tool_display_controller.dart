import 'package:cosyncing_client/src/features/sessions/transcript/tool_display_mode.dart';
import 'package:cosyncing_client/src/features/settings/data/session_display_preferences_store.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Device-global D9 transcript display mode.
final toolDisplayControllerProvider =
    AsyncNotifierProvider<ToolDisplayController, ToolDisplayMode>(
      ToolDisplayController.new,
    );

/// Loads and persists [ToolDisplayMode].
final class ToolDisplayController extends AsyncNotifier<ToolDisplayMode> {
  SessionDisplayPreferencesStore get _store =>
      ref.read(sessionDisplayPreferencesStoreProvider);

  @override
  Future<ToolDisplayMode> build() async {
    return ToolDisplayMode.fromToken(await _store.getToolDisplayMode());
  }

  /// Selects [mode] immediately and persists it for this device.
  Future<void> setMode(ToolDisplayMode mode) async {
    state = AsyncData(mode);
    await _store.setToolDisplayMode(mode.token);
  }
}
