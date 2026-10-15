// Stress lane (nightly, not per pull request): every seed that ever exposed a
// defect, plus a spread, across every variant. Set
// COSYNCING_TRANSCRIPT_FUZZ_SEEDS to a count to run seeds 0 to count - 1
// instead, and COSYNCING_TRANSCRIPT_FUZZ_STEPS to change the 1,500 steps of
// each session. The per-pull-request smoke is
// `test/narrow/transcript_history_fuzz_smoke_test.dart`.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

import '../support/transcript_history_fuzz.dart';

void main() {
  final sweep = int.tryParse(
    Platform.environment['COSYNCING_TRANSCRIPT_FUZZ_SEEDS'] ?? '',
  );
  final steps =
      int.tryParse(
        Platform.environment['COSYNCING_TRANSCRIPT_FUZZ_STEPS'] ?? '',
      ) ??
      1500;
  for (final variant in fuzzVariantNames) {
    final seeds = sweep != null
        ? [for (var seed = 0; seed < sweep; seed++) seed]
        : fuzzSeedsFor(variant);
    test(
      '$variant: ${seeds.length} sessions of $steps steps keep every '
      'invariant',
      () => expectFuzzSessionsHold(variant, seeds, steps),
    );
  }
}
