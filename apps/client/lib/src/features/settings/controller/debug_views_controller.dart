import 'package:cosyncing_client/src/features/settings/data/ui_preferences_store.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// App-local, device-local "Show debug views" preference.
///
/// Default off in every build. A missing or malformed stored value resolves to
/// `false`. This is a presentation gate only: reading or toggling it adds no
/// subscriptions, polling, history transfer, or broker traffic.
final debugViewsControllerProvider =
    AsyncNotifierProvider<DebugViewsController, bool>(DebugViewsController.new);

/// Loads and persists whether read-only Debug views are shown.
final class DebugViewsController extends AsyncNotifier<bool> {
  UiPreferencesStore get _store => ref.read(uiPreferencesStoreProvider);

  @override
  Future<bool> build() async {
    return await _store.getShowDebugViews() ?? false;
  }

  /// Sets the preference immediately and persists it for this device.
  Future<void> setShowDebugViews({required bool value}) async {
    state = AsyncData(value);
    await _store.setShowDebugViews(value: value);
  }
}
