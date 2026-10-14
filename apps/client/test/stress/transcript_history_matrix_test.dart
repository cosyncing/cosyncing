// Stress lane (nightly, not per pull request): the ordinary-use matrix for
// continuous recovery (contract revision 28), one scenario to a test so each
// pays only for itself and a failure names it.
//
// The session controller runs over a simulated broker session: a running
// agent's tool calls, streamed replies, approvals and questions, restated
// plans, error cards, prompts saved as sent, late or queued, other agents'
// shapes, a broker that holds frames while a turn runs, refuses a cursor it no
// longer has, refuses a refresh and resyncs the socket. With a broker that
// offers newer history no ordinary use leaves a gap that needs a reconnect,
// every row is held once and in persisted order, and every row is reachable
// by scrolling or its release is announced. Against a revision-27 broker the
// window keeps its earlier behaviour, bounded and in order.
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/transcript_history_matrix.dart';

void _expectNothingLost(MatrixMetrics metrics, {bool announced = false}) {
  if (!announced) {
    expect(metrics.maxUnsavedNotices, 0, reason: 'unsaved rows released');
    expect(metrics.liveOnlyRowsUnreached, 0);
  }
  expect(metrics.maxReconnectGaps, 0, reason: 'reconnect-required gaps');
  expect(metrics.heldTwice, 0, reason: '${metrics.firstHeldTwice}');
  expect(metrics.keylessHeldTwice, 0);
  expect(metrics.outOfOrder, 0);
  expect(metrics.rowsOutsideTheirPage, 0);
  expect(metrics.durableRowsUnreached, 0);
  expect(metrics.rowsNoLongerSavedAtEnd, 0);
  expect(metrics.staleRunSummariesAtEnd, 0);
  expect(metrics.downwardStalls, 0);
  expect(metrics.rejectedPages, 0);
  expect(
    metrics.peakRowsBeyondReader,
    lessThanOrEqualTo(kMaxActiveTranscriptMessages),
  );
  expect(
    metrics.peakBytesBeyondReader,
    lessThanOrEqualTo(kMaxActiveTranscriptDecodedBytes),
  );
}

/// A scenario nothing is lost in, and what it must show it exercised.
const Map<String, void Function(MatrixMetrics)> _nothingLost = {
  'longStreamWhileReadingFarBack': _longStream,
  'repeatedReconnectCycles': _reconnectCycles,
  'readReleaseReloadBothDirections': _bothDirections,
  'approvalsWhileMovingBothWays': _approvals,
  'promptsSavedLateOrQueued': _nothing,
  'cardsWaitingAcrossFrames': _cardsWaiting,
  'openCodeStepsRewrittenInPlace': _openCode,
  'codexReasoningKeyedAsHistory': _nothing,
  // A call history never holds (Reasonix), some shown right after a saved row
  // without a key: each stays reachable, after that row.
  'reasonixCallsHistoryNeverHolds': _nothing,
};

void _nothing(MatrixMetrics metrics) {}

void _longStream(MatrixMetrics stream) {
  expect(stream.refreshes, greaterThan(20));
  expect(stream.newerPages, greaterThan(5));
  expect(stream.replayedRows, greaterThan(0));
}

void _reconnectCycles(MatrixMetrics reconnects) {
  expect(reconnects.reconnects, 10);
  expect(reconnects.cappedReconnects, 10);
  expect(reconnects.cappedKeepingPages, 10);
}

void _bothDirections(MatrixMetrics both) {
  expect(both.olderPages, greaterThan(20));
  expect(both.newerPages, greaterThan(20));
}

void _approvals(MatrixMetrics approvals) {
  expect(approvals.liveOnlyRowsDelivered, greaterThan(150));
}

void _cardsWaiting(MatrixMetrics cards) {
  expect(cards.maxCardsWaiting, greaterThan(4));
  // A card answered while the socket was down stops waiting once the
  // reconnect restates only the cards still waiting.
  expect(cards.maxCardsWithdrawn, greaterThan(0));
  expect(cards.cardsWaitingAtEnd, 0);
}

void _openCode(MatrixMetrics openCode) {
  expect(openCode.broker['runSummariesRewritten'], greaterThan(100));
}

/// Frames that replace the window (a hub resync, the reattach for a cursor a
/// rewind took away): the approval cards in what they replace give way,
/// announced, and every saved row is still reachable.
const Map<String, void Function(MatrixMetrics)> _replacing = {
  'framesWhileACallRuns': _framesWhileACallRuns,
  'rewoundWhileRead': _rewound,
  'refusedRefreshesAndResyncs': _refused,
};

void _framesWhileACallRuns(MatrixMetrics held) {
  expect(held.resyncs, greaterThan(10));
  expect(held.broker['heldRowsReplayed'], greaterThan(10));
  expect(held.broker['runningReadingsReplayed'], greaterThan(10));
}

void _rewound(MatrixMetrics rewound) {
  expect(rewound.restarts, 1);
  expect(rewound.broker['cursorsRefused'], greaterThan(0));
  expect(rewound.broker['framesForAGoneCursor'], 1);
}

void _refused(MatrixMetrics refused) {
  expect(refused.broker['refreshesRefused'], greaterThan(3));
  expect(refused.resyncs, greaterThan(3));
}

/// More never-saved rows than the budget holds: some give way, announced.
const _overflowScenario = 'approvalOnEveryCallWhileReadingFarBack';

/// Scenarios a revision-27 broker also runs.
const _olderBrokerScenarios = [
  'longStreamWhileReadingFarBack',
  'repeatedReconnectCycles',
  'readReleaseReloadBothDirections',
  'approvalsWhileMovingBothWays',
  'framesWhileACallRuns',
];

Future<MatrixMetrics> _run(String scenario, {required bool revision28}) async {
  final results = await runOrdinaryUseMatrix(
    revision28: revision28,
    only: {scenario},
  );
  expect(results.keys, [scenario]);
  return results[scenario]!;
}

void main() {
  group('with a revision-28 broker', () {
    _nothingLost.forEach((scenario, exercised) {
      test(
        '$scenario: no gap needs a reconnect, and nothing is lost',
        () async {
          final metrics = await _run(scenario, revision28: true);
          expect(metrics.firstAnomaly, isNull);
          _expectNothingLost(metrics);
          expect(metrics.liveOnlyOutOfPlace, 0);
          exercised(metrics);
        },
      );
    });

    _replacing.forEach((scenario, exercised) {
      test('$scenario: no gap needs a reconnect, and what the replacement '
          'drops is announced', () async {
        final metrics = await _run(scenario, revision28: true);
        expect(
          metrics.firstAnomalies.keys,
          ['unsaved'],
          reason: metrics.firstAnomalies.values.join('\n\n'),
        );
        _expectNothingLost(metrics, announced: true);
        expect(metrics.liveOnlyOutOfPlace, 0);
        exercised(metrics);
      });
    });

    test('$_overflowScenario: no gap needs a reconnect, and the never-saved '
        'rows that give way are announced where they were', () async {
      final metrics = await _run(_overflowScenario, revision28: true);
      expect(
        metrics.firstAnomalies.keys,
        ['unsaved'],
        reason: metrics.firstAnomalies.values.join('\n\n'),
      );
      expect(metrics.maxReconnectGaps, 0);
      expect(metrics.heldTwice, 0, reason: '${metrics.firstHeldTwice}');
      expect(metrics.keylessHeldTwice, 0);
      expect(metrics.outOfOrder, 0);
      expect(metrics.liveOnlyOutOfPlace, 0);
      expect(metrics.durableRowsUnreached, 0);
      expect(metrics.liveOnlyRowsUnreached, greaterThan(0));
      expect(metrics.maxUnsavedNotices, greaterThan(0));
      expect(metrics.rejectedPages, 0);
      expect(
        metrics.peakRowsBeyondReader,
        lessThanOrEqualTo(kMaxActiveTranscriptMessages),
      );
    });
  });

  group('with a revision-27 broker', () {
    for (final scenario in _olderBrokerScenarios) {
      test('$scenario: the window stays bounded and in order', () async {
        final metrics = await _run(scenario, revision28: false);
        expect(metrics.refreshes, 0);
        expect(metrics.newerPages, 0);
        expect(metrics.heldTwice, 0, reason: metrics.firstAnomaly);
        expect(metrics.keylessHeldTwice, 0, reason: metrics.firstAnomaly);
        expect(metrics.outOfOrder, 0, reason: metrics.firstAnomaly);
        expect(metrics.rejectedPages, 0);
        expect(
          metrics.peakRowsBeyondReader,
          lessThanOrEqualTo(kMaxActiveTranscriptMessages),
        );
        expect(
          metrics.peakBytesBeyondReader,
          lessThanOrEqualTo(kMaxActiveTranscriptDecodedBytes),
        );
        if (scenario == 'framesWhileACallRuns') {
          // A frame read while a unit runs ends with its reading, which its
          // cursor counts.
          expect(metrics.broker['runningReadingsCounted'], greaterThan(10));
        }
      });
    }
  });
}
