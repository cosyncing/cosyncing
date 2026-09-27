// The ordinary-use matrix for continuous recovery (contract revision 28).
//
// The session controller runs over a simulated broker session: a running
// agent's tool calls, streamed replies, approvals and questions between a call
// and its result (some waiting many rows for an answer), a restated plan,
// error cards and token readings without keys, prompts saved as sent, saved
// late or queued, other agents' shapes (OpenCode parts and step summaries
// rewritten in place, Codex reasoning, Reasonix calls history never holds),
// and the state a broker re-projects at the end of every read. The broker
// ends every frame sent while a turn runs at the running-turn hold, replays
// what it held, refuses a cursor it no longer has, refuses a refresh it could
// not read, and resyncs the socket. With a broker that offers newer history,
// no ordinary use leaves a gap that needs a reconnect: live rows get broker
// boundaries as they arrive, a capped reconnect keeps the pages already read,
// gaps load from either edge, and a refused cursor reattaches. Every row is
// held once (keyed or not), in persisted order, inside its page's boundaries,
// rows never saved stay where they arrived, and every row the session holds
// (or the client received live) is reachable by scrolling, or its release is
// announced. Against a revision-27 broker, which offers none of that, the
// window keeps its earlier behaviour, bounded and in order.
//
// Set COSYNCING_SCROLL_EVIDENCE_DIR to write the measurements as
// `transcript-history-matrix.json` there.
import 'dart:convert';
import 'dart:io';

import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/transcript_history_matrix.dart';

const _scenarios = [
  'longStreamWhileReadingFarBack',
  'repeatedReconnectCycles',
  'readReleaseReloadBothDirections',
  'approvalsWhileMovingBothWays',
];

/// Scenarios a revision-28 broker alone runs, where nothing is lost either.
const _revision28Scenarios = [
  'promptsSavedLateOrQueued',
  'cardsWaitingAcrossFrames',
  'openCodeStepsRewrittenInPlace',
  'codexReasoningKeyedAsHistory',
];

/// More never-saved rows than the budget holds: some give way, announced.
const _overflowScenario = 'approvalOnEveryCallWhileReadingFarBack';

/// Frames that replace the window (a hub resync, the reattach for a cursor a
/// rewind took away): the approval cards in what they replace give way,
/// announced, and every saved row is still reachable.
const _replacingScenarios = [
  'framesWhileACallRuns',
  'rewoundWhileRead',
  'refusedRefreshesAndResyncs',
];

/// A call history never holds (Reasonix), some shown right after a saved
/// row without a key (an error card): each stays reachable, after that row.
const _unsavedCallScenario = 'reasonixCallsHistoryNeverHolds';

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

void main() {
  late Map<String, MatrixMetrics> after;
  late Map<String, MatrixMetrics> olderBroker;
  setUpAll(() async {
    after = await runOrdinaryUseMatrix(revision28: true);
    olderBroker = await runOrdinaryUseMatrix(revision28: false);
    expect(after.keys, [
      ..._scenarios,
      _overflowScenario,
      _replacingScenarios.first,
      ..._revision28Scenarios.take(2),
      ..._revision28Scenarios.skip(2),
      _unsavedCallScenario,
      ..._replacingScenarios.skip(1),
    ]);
  });

  tearDownAll(() {
    final dir = Platform.environment['COSYNCING_SCROLL_EVIDENCE_DIR'];
    if (dir == null || dir.isEmpty) return;
    File('$dir/transcript-history-matrix.json')
      ..createSync(recursive: true)
      ..writeAsStringSync(
        const JsonEncoder.withIndent('  ').convert({
          'client': 'this tree, through the session controller',
          'revision28Broker': {
            for (final entry in after.entries) entry.key: entry.value.toJson(),
          },
          'revision27Broker': {
            for (final entry in olderBroker.entries)
              entry.key: entry.value.toJson(),
          },
        }),
      );
  });

  group('with a revision-28 broker', () {
    for (final scenario in [..._scenarios, ..._revision28Scenarios]) {
      test('$scenario: no gap needs a reconnect, and nothing is lost', () {
        final metrics = after[scenario]!;
        expect(metrics.firstAnomaly, isNull);
        _expectNothingLost(metrics);
        expect(metrics.liveOnlyOutOfPlace, 0);
      });
    }

    for (final scenario in _replacingScenarios) {
      test('$scenario: no gap needs a reconnect, and what the replacement '
          'drops is announced', () {
        final metrics = after[scenario]!;
        expect(
          metrics.firstAnomalies.keys,
          ['unsaved'],
          reason: metrics.firstAnomalies.values.join('\n\n'),
        );
        _expectNothingLost(metrics, announced: true);
        expect(metrics.liveOnlyOutOfPlace, 0);
      });
    }

    test('$_unsavedCallScenario: nothing is lost, and a call history never '
        'holds stays after the saved row without a key it followed', () {
      final metrics = after[_unsavedCallScenario]!;
      expect(metrics.firstAnomaly, isNull);
      _expectNothingLost(metrics);
      expect(metrics.liveOnlyOutOfPlace, 0);
    });

    test('$_overflowScenario: no gap needs a reconnect, and the never-saved '
        'rows that give way are announced where they were', () {
      final metrics = after[_overflowScenario]!;
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

    test('the scenarios exercise what they claim', () {
      final stream = after['longStreamWhileReadingFarBack']!;
      expect(stream.refreshes, greaterThan(20));
      expect(stream.newerPages, greaterThan(5));
      expect(stream.replayedRows, greaterThan(0));
      final reconnects = after['repeatedReconnectCycles']!;
      expect(reconnects.reconnects, 10);
      expect(reconnects.cappedReconnects, 10);
      expect(reconnects.cappedKeepingPages, 10);
      final approvals = after['approvalsWhileMovingBothWays']!;
      expect(approvals.liveOnlyRowsDelivered, greaterThan(150));
      final both = after['readReleaseReloadBothDirections']!;
      expect(both.olderPages, greaterThan(20));
      expect(both.newerPages, greaterThan(20));
      final held = after['framesWhileACallRuns']!;
      expect(held.resyncs, greaterThan(10));
      expect(held.broker['heldRowsReplayed'], greaterThan(10));
      expect(held.broker['runningReadingsReplayed'], greaterThan(10));
      final cards = after['cardsWaitingAcrossFrames']!;
      expect(cards.maxCardsWaiting, greaterThan(4));
      final openCode = after['openCodeStepsRewrittenInPlace']!;
      expect(openCode.broker['runSummariesRewritten'], greaterThan(100));
      final rewound = after['rewoundWhileRead']!;
      expect(rewound.restarts, 1);
      expect(rewound.broker['cursorsRefused'], greaterThan(0));
      expect(rewound.broker['framesForAGoneCursor'], 1);
      final refused = after['refusedRefreshesAndResyncs']!;
      expect(refused.broker['refreshesRefused'], greaterThan(3));
      expect(refused.resyncs, greaterThan(3));
    });

    test('cards answered while the socket was down stop waiting once the '
        'reconnect replays the cards still waiting', () {
      // The broker's live snapshot restates only the cards still waiting, so
      // one the window holds that the reconnect does not restate was
      // answered meanwhile.
      final cards = after['cardsWaitingAcrossFrames']!;
      expect(cards.maxCardsWithdrawn, greaterThan(0));
      expect(cards.cardsWaitingAtEnd, 0);
    });
  });

  group('with a revision-27 broker', () {
    test('a frame read while a unit runs ends with its reading, which its '
        'cursor counts', () {
      expect(
        olderBroker['framesWhileACallRuns']!.broker['runningReadingsCounted'],
        greaterThan(10),
      );
    });

    for (final scenario in [..._scenarios, 'framesWhileACallRuns']) {
      test('$scenario: the window stays bounded and in order', () {
        final metrics = olderBroker[scenario]!;
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
      });
    }
  });
}
