import 'package:cosyncing_client/src/design/ui_scale.dart';
import 'package:cosyncing_client/src/features/settings/data/ui_preferences_store.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Durable UI-size selection: text size + interface density.
///
/// One source of truth so the list, tabs, transcript and settings shift
/// together. See `docs/architecture/client-ui.md`.
final uiScaleControllerProvider =
    AsyncNotifierProvider<UiScaleController, UiScaleSettings>(
      UiScaleController.new,
    );

/// Loads and persists the user's [UiScaleSettings].
class UiScaleController extends AsyncNotifier<UiScaleSettings> {
  UiPreferencesStore get _store => ref.read(uiPreferencesStoreProvider);

  @override
  Future<UiScaleSettings> build() async {
    final textScale = UiTextScale.fromToken(await _store.getTextScale());
    final density = UiDensity.fromToken(await _store.getDensity());
    return UiScaleSettings(textScale: textScale, density: density);
  }

  /// Sets the text size and persists it.
  Future<void> setTextScale(UiTextScale textScale) async {
    final current = state.valueOrNull ?? kDefaultUiScaleSettings;
    state = AsyncData(current.copyWith(textScale: textScale));
    await _store.setTextScale(textScale.token);
  }

  /// Steps the text size one rung along [UiTextScale.ladder].
  ///
  /// [direction] greater than zero grows the text, less than zero shrinks it,
  /// and zero is a no-op. Both ends clamp: stepping past
  /// [UiTextScale.extraLarge] or below [UiTextScale.small] leaves the setting
  /// untouched. This is the single implementation shared by the keyboard
  /// (Ctrl/Cmd +/-) and Ctrl+wheel paths — neither clamps on its own.
  ///
  /// [UiTextScale.system] is not on the ladder, so it is resolved first.
  /// [ambientFactor] should be the effective OS text-scale factor when known
  /// (the caller reads it from the ambient `MediaQuery`); the nearest rung
  /// becomes
  /// the starting point, so the first step continues from the size the user is
  /// actually looking at instead of snapping to an arbitrary end. Without it we
  /// assume 1.0, which resolves to [UiTextScale.standard]. Stepping always
  /// leaves `system` behind and pins a concrete size — that is the point of the
  /// gesture, and the settings page can restore "follow the OS".
  Future<void> stepTextScale(int direction, {double? ambientFactor}) async {
    if (direction == 0) {
      return;
    }
    // Unlike an absolute set, stepping is read-modify-write, so it has to run
    // against hydrated state. Stepping mid-load would write a value that the
    // in-flight load then overwrites, and the next step would start from the
    // stale size.
    final current =
        state.valueOrNull ??
        await future.catchError((Object _) => kDefaultUiScaleSettings);
    final resolved = current.textScale == UiTextScale.system
        ? UiTextScale.nearestTo(ambientFactor ?? 1)
        : current.textScale;
    final next = UiTextScale.ladder.indexOf(resolved) + direction.sign;
    if (next < 0 || next >= UiTextScale.ladder.length) {
      return;
    }
    await setTextScale(UiTextScale.ladder[next]);
  }

  /// Sets the interface density and persists it.
  Future<void> setDensity(UiDensity density) async {
    final current = state.valueOrNull ?? kDefaultUiScaleSettings;
    state = AsyncData(current.copyWith(density: density));
    await _store.setDensity(density.token);
  }
}
