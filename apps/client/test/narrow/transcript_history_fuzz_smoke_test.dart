// Per-pull-request smoke of the randomized window sessions: two seeds that
// each exposed a defect, over the ordinary and the extended agent, and the
// extended agent with tool calls hidden and shown. The full sweep is
// `test/stress/transcript_history_fuzz_test.dart`.
import 'package:flutter_test/flutter_test.dart';

import '../support/transcript_history_fuzz.dart';

void main() {
  for (final variant in ['ordinary', 'extended', 'toolCallsHidden']) {
    test(
      '$variant: two sessions keep every invariant',
      () => expectFuzzSessionsHold(variant, const [14, 99], 1500),
    );
  }
}
