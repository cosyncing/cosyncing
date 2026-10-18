// F03b: how far ahead a reader's page is asked for, and what moving toward a
// range the window released does. A faster reader asks from farther away, a
// page is asked for once while it is on its way, and a released range fills
// from its older or its newer edge, or says it cannot load. Where a page draws
// little (tool calls hidden), the pages being read stay while the next loads,
// and a range of nothing but tool calls neither shows nor loads.
//
// Split from `transcript_history_paging_test.dart` to keep each file short.
// real stream.
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/app_driver.dart';
import '../support/feature/cosyncing_app.dart';
import '../support/feature/paging_broker.dart';
import '../support/feature/transcript_reader.dart';
import '../support/feature/transcript_wire.dart';

void main() {
  group('when a page is asked for', () {
    tearDown(() => debugTranscriptPrefetchPolicy = null);

    featureTest('a faster reader asks for the page from farther away', (
      f,
    ) async {
      // Pages take a quarter of a second, so that is the latency learned.
      final (app, broker) = await openPaging(
        f,
        total: 3000,
        latency: const Duration(milliseconds: 250),
      );
      final viewport = app.position.viewportDimension;

      await app.placeBelowStart(2.5);
      final slow = await _dragUntilRequest(app, broker, speed: 240);
      expect(slow, isNotNull);
      expect(
        slow,
        lessThanOrEqualTo(viewport + 8),
        reason: 'a slow reader is asked for at the shortest distance',
      );

      await app.placeBelowStart(3.2);
      final fast = await _dragUntilRequest(app, broker, speed: 3600);
      expect(fast, isNotNull);
      expect(
        fast,
        greaterThan(viewport * 1.5),
        reason: 'a fast reader covers more while the page is on its way',
      );
    });

    featureTest('a page is asked for once while it is on its way, and the '
        'wait the reader sat through is what is learned', (f) async {
      final (app, broker) = await openPaging(
        f,
        total: 3000,
        latency: const Duration(milliseconds: 600),
      );
      await app.placeBelowStart(0.5);
      for (var tick = 0; tick < 12; tick++) {
        await app.wheel(-30);
        await f.tester.pump(const Duration(milliseconds: 16));
      }
      expect(broker.older, hasLength(1), reason: 'asked once, not per tick');
      await app.pumpFor(const Duration(milliseconds: 900));
      expect(find.text(loadingEarlier), findsNothing);

      final prefetch = debugTranscriptPrefetch!;
      for (var page = 0; page < 2; page++) {
        await app.placeBelowStart(0.5);
        await app.wheel(-40);
        await app.pumpFor(const Duration(milliseconds: 900));
      }
      expect(broker.older, hasLength(3));
      expect(prefetch.latencySamples, 3);
      expect(
        prefetch.latency.inMilliseconds,
        inInclusiveRange(600, 640),
        reason: 'measured from the request to the frame the page lands in',
      );
    });
  });

  group('moving toward a released range', () {
    featureTest('down, it fills from its older edge with a newer page', (
      f,
    ) async {
      final (app, broker) = await openPaging(f);
      await app.readBack(broker, 8);
      broker.holding = true;
      final asked = broker.older.length;
      final before = await app.askForNewer(broker);
      expect(before, isNotNull);
      expect(broker.newer, hasLength(1));
      final request = broker.newer.single;
      expect(
        int.parse(request.until!.substring(1)),
        greaterThan(int.parse(request.cursor.substring(1))),
        reason: 'a newer walk goes forward, up to the range it fills',
      );
      expect(broker.older, hasLength(asked), reason: 'nothing else is asked');
      broker.release();
      await app.frames();
      app.expectHeld(before!, when: 'as the newer page landed');
    });

    featureTest('up, a closed range pages back from its newer edge', (
      f,
    ) async {
      final (app, broker) = await openPaging(f);
      await app.readBack(broker, 8);
      broker.holding = true;
      await app.jumpToEnd();
      final newerBefore = broker.newer.length;
      final before = await app.askForRangeAbove(broker);
      expect(before, isNotNull, reason: 'a released range must lie above');
      expect(
        broker.older.last.cursor,
        'b1900',
        reason: 'asked from the boundary the newest pages start at',
      );
      expect(broker.newer, hasLength(newerBefore));
      broker.release();
      await app.frames();
      app.expectHeld(before!, when: 'as the page landed above the reader');
    });

    featureTest('down, from a broker that does not page forward, it pages '
        'back from its newer edge', (f) async {
      final (app, broker) = await openPaging(f, newerHistory: false);
      await app.readBack(broker, 8);
      broker.holding = true;
      final asked = broker.older.length;
      await app.bringRangeToLowerHalf();
      await app.wheel(40);
      expect(broker.newer, isEmpty);
      expect(broker.older, hasLength(asked + 1));
    });

    featureTest('a range whose position the broker refused says it cannot '
        'load, offers no retry, and is not asked for again', (f) async {
      final (app, broker) = await openPaging(f);
      await app.readBack(broker, 8);
      await app.bringRangeToLowerHalf();
      broker
        ..failNext = 1
        ..failureCode = 'HISTORY_CURSOR_GONE';
      await app.wheel(40);
      await app.frames(5);
      expect(broker.requests.last.failed, isTrue);
      final asked = broker.requests.length;

      final l10n = await AppLocalizations.delegate.load(const Locale('en'));
      expect(
        find.descendant(
          of: releasedRanges,
          matching: find.text(l10n.sessionHistoryLoadFailed),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: releasedRanges,
          matching: find.text(l10n.sessionHistoryRetry),
        ),
        findsNothing,
        reason: 'a position the broker no longer has cannot be retried',
      );
      await app.wheel(40);
      await app.wheel(-40);
      await app.pumpFor(
        const Duration(seconds: 10),
        step: const Duration(milliseconds: 250),
      );
      expect(broker.requests, hasLength(asked));
    });
  });

  group('with tool calls hidden', () {
    featureTest('a delivered file in a tool-only page stays reachable after '
        'reading past the page and back', (f) async {
      final (app, broker) = await openPaging(
        f,
        row: (index) => {
          ...commandHeavyRow(index, turn: 400),
          if (index == 1600) 'text': 'Row 1600. ${markedProse(1600, 30)}',
        },
      );
      await app.hideToolCalls();
      await app.live(broker.broker, {
        'type': 'file-artifact',
        'artifactKey': 'command-report',
        'path': 'command-report.md',
        'name': 'command-report.md',
        'mimeType': 'text/markdown',
        'transcriptAnchor': {'type': 'tool-result', 'key': 'c1800'},
      });
      final card = find.text('command-report.md');
      var sawFile = false;
      for (var tick = 0; tick < 160; tick++) {
        await app.wheel(-40);
        await f.tester.pump(const Duration(milliseconds: 16));
        sawFile |= card.hitTestable().evaluate().isNotEmpty;
      }
      expect(sawFile, isTrue, reason: 'the original delivery can be read');
      expect(app.markedRows.first.index, lessThanOrEqualTo(1600));
      expect(card.hitTestable(), findsNothing);

      sawFile = false;
      for (var tick = 0; tick < 240; tick++) {
        await app.wheel(40);
        await f.tester.pump(const Duration(milliseconds: 16));
        sawFile |= card.hitTestable().evaluate().isNotEmpty;
      }
      expect(
        sawFile,
        isTrue,
        reason:
            'a tool-only source page with a file must reload in report view',
      );
      expect(app.markedRows.map((row) => row.index), contains(1999));
    });

    featureTest('reading back keeps the pages being read, asks for no page '
        'over and over, and comes back to the newest rows', (f) async {
      // Each page draws a few short rows but holds over half a MiB of command
      // output, so several pages fill a screen and the decoded budget alike.
      final (app, broker) = await openPaging(f, row: commandHeavyRow);
      await app.hideToolCalls();
      for (var tick = 0; tick < 240; tick++) {
        await app.wheel(-40);
        await f.tester.pump(const Duration(milliseconds: 16));
      }
      expect(
        app.markedRows.first.index,
        lessThan(1000),
        reason: 'a page that lands does not release the rows being read',
      );
      for (var tick = 0; tick < 400; tick++) {
        await app.wheel(40);
        await f.tester.pump(const Duration(milliseconds: 16));
      }
      await app.frames();

      expect(
        _askedOverAndOver(broker),
        isEmpty,
        reason:
            'a page with no room yet is asked again once the reader has '
            'moved on, not on every turn',
      );
      expect(app.markedRows.map((row) => row.index), contains(1999));
      expect(releasedRanges, findsNothing);
    });

    featureTest('pages of nothing but tool calls neither hold the reader back '
        'nor show until the tool calls do', (f) async {
      // Turns of 400 rows: pages 1700 and 1800 hold only tool calls.
      final (app, broker) = await openPaging(
        f,
        row: (index) => commandHeavyRow(index, turn: 400),
      );
      await app.hideToolCalls();
      for (var tick = 0; tick < 100; tick++) {
        await app.wheel(-40);
        await f.tester.pump(const Duration(milliseconds: 16));
      }
      expect(
        app.markedRows.map((row) => row.index),
        containsAll([1601, 1999]),
        reason: 'the reply before the tool calls is reached',
      );
      expect(
        releasedRanges,
        findsNothing,
        reason: 'a released range of tool calls draws nothing while hidden',
      );
      expect(_askedOverAndOver(broker), isEmpty);

      await app.showToolCalls();
      expect(
        releasedRanges,
        findsWidgets,
        reason: 'with the tool calls shown, their range is there to load',
      );
    });

    featureTest('a page that times out after one had no room is asked for '
        'again on its own', (f) async {
      final (app, broker) = await openPaging(f, row: commandHeavyRow);
      await app.hideToolCalls();
      final controller = app.container.read(
        sessionDetailControllerProvider(
          const SessionDetailKey(tool: 'codex', sessionId: 's1'),
        ).notifier,
      );
      for (
        var tick = 0;
        tick < 240 && !controller.lastHistoryPageAwaitsReader;
        tick++
      ) {
        await app.wheel(-40);
        await f.tester.pump(const Duration(milliseconds: 16));
      }
      expect(controller.lastHistoryPageAwaitsReader, isTrue);

      // Moving on asks again, and the broker never answers.
      broker.holding = true;
      final waited = broker.requests.length;
      for (
        var tick = 0;
        tick < 240 && broker.requests.length == waited;
        tick++
      ) {
        await app.wheel(-40);
        await f.tester.pump(const Duration(milliseconds: 16));
      }
      expect(broker.requests, hasLength(waited + 1));
      for (
        var tick = 0;
        tick < 100 && app.distanceToStart > app.position.viewportDimension / 2;
        tick++
      ) {
        await app.wheel(-40);
        await f.tester.pump(const Duration(milliseconds: 16));
      }
      await f.tester.pump(const Duration(seconds: 20));
      expect(controller.state.historyPageErrorCode, 'HISTORY_PAGE_TIMEOUT');

      broker.holding = false;
      final timedOut = broker.requests.length;
      await app.pumpFor(const Duration(seconds: 2));
      expect(
        broker.requests.length,
        greaterThan(timedOut),
        reason:
            'a timeout is retried after its backoff, whatever the page '
            'before it was told',
      );
    });
  });
}

/// The ranges [broker] was asked for more than twice, with how often.
List<String> _askedOverAndOver(FixturePagingBroker broker) {
  final asked = <String, int>{};
  for (final request in broker.requests) {
    final range =
        '${request.newer ? 'newer' : 'older'} '
        '${request.cursor}..${request.until}';
    asked[range] = (asked[range] ?? 0) + 1;
  }
  return [
    for (final MapEntry(:key, :value) in asked.entries)
      if (value > 2) '$key x$value',
  ];
}

/// Drags toward the start at [speed] pixels per second, in 16 ms samples,
/// until the first older page is asked for, and returns how far from the
/// start of what was loaded the reader was when it was.
Future<double?> _dragUntilRequest(
  AppDriver app,
  FixturePagingBroker broker, {
  required double speed,
}) async {
  final tester = app.tester;
  final asked = broker.older.length;
  final gesture = await tester.createGesture();
  await gesture.down(tester.getCenter(transcriptList));
  const frame = Duration(milliseconds: 16);
  var time = Duration.zero;
  final step = speed * frame.inMicroseconds / 1e6;
  double? distance;
  for (var sample = 0; sample < 400; sample++) {
    // The distance from where the reader stood when the move was reported.
    final before = app.distanceToStart;
    time += frame;
    await gesture.moveBy(Offset(0, step), timeStamp: time);
    await tester.pump(frame);
    if (broker.older.length > asked) {
      distance = before;
      break;
    }
  }
  await gesture.up(timeStamp: time + const Duration(milliseconds: 200));
  await app.pumpFor(const Duration(seconds: 1));
  return distance;
}
