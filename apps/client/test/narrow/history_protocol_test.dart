// F03b: the history protocol's narrow tests, in one file so the suite pays
// for one process and one compile. They drive the window, the session
// controller and the broker's wire frames with no UI at all, where the case
// is about a rule (budgets, chronology, reconciliation, boundary refusal,
// navigation) and not about anything a person sees; what a person sees of
// the same history is in `test/features/transcript_history_*_test.dart`.
//
//   budget     the window's row and byte budgets, release and reload
//   recovery   continuous recovery: cursors, suffixes, capped reconnects
//   reconcile  reconciling a window with a fresh frame, identities and turns
//   navigation boundary paging, refresh, newer history and the retry rules
//   refusal    localized refusal copy and the unreadable-history codes
//   matrix     two cheap ordinary-use scenarios (the full matrix is nightly)
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/transcript_history_matrix.dart';
import 'history_protocol/budget_cases.dart';
import 'history_protocol/navigation_cases.dart';
import 'history_protocol/reconcile_cases.dart';
import 'history_protocol/recovery_cases.dart';
import 'history_protocol/refusal_cases.dart';

void main() {
  group('budget', defineBudgetCases);
  group('recovery', defineRecoveryCases);
  group('reconcile', defineReconcileCases);
  group('navigation', defineNavigationCases);
  group('refusal', defineRefusalCases);

  group('ordinary-use matrix, smoke', () {
    for (final scenario in const [
      'approvalsWhileMovingBothWays',
      'refusedRefreshesAndResyncs',
    ]) {
      test('$scenario: nothing is lost and no gap needs a reconnect', () async {
        final results = await runOrdinaryUseMatrix(
          revision28: true,
          only: {scenario},
        );
        final metrics = results[scenario]!;
        expect(metrics.maxReconnectGaps, 0);
        expect(metrics.heldTwice, 0, reason: '${metrics.firstHeldTwice}');
        expect(metrics.keylessHeldTwice, 0);
        expect(metrics.outOfOrder, 0);
        expect(metrics.durableRowsUnreached, 0);
        expect(metrics.rejectedPages, 0);
        expect(
          metrics.peakRowsBeyondReader,
          lessThanOrEqualTo(kMaxActiveTranscriptMessages),
        );
      });
    }
  });
}
