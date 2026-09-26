import 'dart:async';
import 'package:cosyncing_client/src/features/settings/controller/locale_controller.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// App setting: whether closing the desktop window keeps the app running.
const String desktopKeepRunningSettingKey = 'desktop_keep_running';

/// Where closing the window can keep the app running: macOS (the Dock) and
/// Windows (the notification area).
bool get desktopKeepRunningSupported =>
    !kIsWeb &&
    (defaultTargetPlatform == TargetPlatform.macOS ||
        defaultTargetPlatform == TargetPlatform.windows);

/// Durable keep-running choice. Missing means on: a closed window should not
/// silence notifications unless the user asked for that.
abstract interface class DesktopKeepRunningStore {
  /// Returns the stored choice, or true when none was made.
  Future<bool> get();

  /// Persists the choice.
  Future<void> set({required bool enabled});
}

/// Drift-backed [DesktopKeepRunningStore].
class DriftDesktopKeepRunningStore implements DesktopKeepRunningStore {
  /// Creates the store over [database].
  DriftDesktopKeepRunningStore(this.database);

  /// App-local durable database.
  final AppDatabase database;

  @override
  Future<bool> get() async {
    final row =
        await (database.select(database.appSettingRows)..where(
              (table) => table.key.equals(desktopKeepRunningSettingKey),
            ))
            .getSingleOrNull();
    return row?.value != 'false';
  }

  @override
  Future<void> set({required bool enabled}) async {
    await database
        .into(database.appSettingRows)
        .insertOnConflictUpdate(
          AppSettingRowsCompanion.insert(
            key: desktopKeepRunningSettingKey,
            value: enabled.toString(),
            updatedAt: DateTime.now(),
          ),
        );
  }
}

/// Persisted keep-running store.
final desktopKeepRunningStoreProvider = Provider<DesktopKeepRunningStore>(
  (ref) => DriftDesktopKeepRunningStore(ref.watch(appDatabaseProvider)),
);

/// The keep-running choice as Settings shows and changes it.
final desktopKeepRunningControllerProvider =
    AsyncNotifierProvider<DesktopKeepRunningController, bool>(
      DesktopKeepRunningController.new,
    );

/// Loads and persists the keep-running choice.
class DesktopKeepRunningController extends AsyncNotifier<bool> {
  @override
  Future<bool> build() => ref.read(desktopKeepRunningStoreProvider).get();

  /// Persists [enabled] and applies it to the window.
  Future<void> setEnabled({required bool enabled}) async {
    state = AsyncValue.data(enabled);
    await ref.read(desktopKeepRunningStoreProvider).set(enabled: enabled);
  }
}

/// The native window host: raising the window, and what closing it does.
class DesktopWindowChannel {
  /// Creates the channel wrapper.
  const DesktopWindowChannel();

  static const _channel = MethodChannel('com.cosyncing.client/window');

  /// Shows the window and brings it to the front, including from the Dock or
  /// the notification area after it was closed.
  Future<void> raise() async {
    await _channel.invokeMethod<bool>('raise');
  }

  /// Sets whether closing the window keeps the app running, with the labels
  /// of the notification-area menu (Windows).
  Future<void> setKeepRunning({
    required bool enabled,
    required String openLabel,
    required String quitLabel,
  }) async {
    await _channel.invokeMethod<void>('setKeepRunning', {
      'enabled': enabled,
      'tooltip': 'Cosyncing',
      'openLabel': openLabel,
      'quitLabel': quitLabel,
    });
  }
}

/// Native window host, replaceable in tests.
final desktopWindowChannelProvider = Provider<DesktopWindowChannel>(
  (_) => const DesktopWindowChannel(),
);

/// Root-app trigger that tells the native host what closing the window does,
/// at start and whenever the choice or the app language changes. Until it
/// runs, closing the window quits, as it always did.
final desktopKeepRunningRuntimeProvider = Provider<void>((ref) {
  if (!desktopKeepRunningSupported) return;
  final enabled = ref.watch(desktopKeepRunningControllerProvider).valueOrNull;
  final locale = ref.watch(localeControllerProvider);
  if (enabled == null || !locale.hasValue) return;
  final l10n = resolveAppLocalizations(locale.value);
  unawaited(
    ref
        .read(desktopWindowChannelProvider)
        .setKeepRunning(
          enabled: enabled,
          openLabel: l10n.desktopTrayOpen,
          quitLabel: l10n.desktopTrayQuit,
        )
        .catchError((Object _) {
          // An older runner without the method keeps quitting on close.
        }),
  );
});
