import 'package:cosyncing_client/src/features/voice/data/read_aloud_preferences_store.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// User-selectable read-aloud multipliers.
const List<double> kReadAloudRates = <double>[0.75, 1, 1.25, 1.5];

/// Default read-aloud multiplier.
const double kDefaultReadAloudRate = 1;

/// Whether [rate] is one of the product-supported multipliers.
bool isSupportedReadAloudRate(double rate) => kReadAloudRates.contains(rate);

/// Formats a supported multiplier for UI, including the 1.0 decimal.
String formatReadAloudRate(double rate) {
  return rate == rate.roundToDouble()
      ? '${rate.toStringAsFixed(1)}×'
      : '$rate×';
}

/// Loads and persists the device-local read-aloud multiplier.
final readAloudRateControllerProvider =
    AsyncNotifierProvider<ReadAloudRateController, double>(
      ReadAloudRateController.new,
    );

/// Durable controller for read-aloud speed.
final class ReadAloudRateController extends AsyncNotifier<double> {
  ReadAloudPreferencesStore get _store =>
      ref.read(readAloudPreferencesStoreProvider);

  @override
  Future<double> build() async {
    final stored = double.tryParse(await _store.getRate() ?? '');
    if (stored == null || !isSupportedReadAloudRate(stored)) {
      return kDefaultReadAloudRate;
    }
    return stored;
  }

  /// Sets and persists one of [kReadAloudRates].
  Future<void> setRate(double rate) async {
    if (!isSupportedReadAloudRate(rate)) {
      throw ArgumentError.value(rate, 'rate', 'unsupported read-aloud rate');
    }
    state = AsyncData(rate);
    await _store.setRate(rate);
  }
}
