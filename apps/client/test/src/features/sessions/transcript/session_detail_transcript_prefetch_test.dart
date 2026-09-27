// When the transcript asks for history pages: the prefetch policy (see
// `transcript_prefetch.dart`) driven through the real session page, over a
// broker fake that pages a long mixed history.
import 'dart:math' as math;

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';
import '../../../../support/transcript_scroll_fixture.dart';

Finder get _transcript => find.byKey(const Key('session-detail-chat-scroll'));

ScrollPosition _position(WidgetTester tester) {
  final scrollable = tester.widget<Scrollable>(
    find.descendant(of: _transcript, matching: find.byType(Scrollable)).first,
  );
  return scrollable.controller!.position;
}

/// A one-line row, so a page of a few of them is shorter than a viewport.
AgentMessage _shortRow(int index) => AgentMessage.fromJson({
  'type': 'user-message',
  'key': 'short-$index',
  'text': 'Short row $index.',
});

Future<FixturePagingBroker> _open(
  WidgetTester tester, {
  int total = 3000,
  Duration latency = Duration.zero,
  int? pageRows,
  bool shortRows = false,
}) async {
  useRoomyTestViewport(tester);
  final broker =
      FixturePagingBroker(total: total, row: shortRows ? _shortRow : null)
        ..latency = latency
        ..pageRows = pageRows;
  await tester.pumpWidget(
    buildSessionDetailTestPage(events: const [], connection: broker),
  );
  await tester.pumpAndSettle();
  return broker;
}

/// The window the real controller holds.
TranscriptHistoryWindow _window(WidgetTester tester) =>
    ProviderScope.containerOf(tester.element(_transcript))
        .read(
          sessionDetailControllerProvider(
            const SessionDetailKey(tool: 'claude', sessionId: 'session-1'),
          ),
        )
        .transcriptWindow;

Future<void> _pumpFor(WidgetTester tester, Duration duration) async {
  const frame = Duration(milliseconds: 16);
  for (var t = Duration.zero; t < duration; t += frame) {
    await tester.pump(frame);
  }
}

/// Jumps to the start of what is loaded, until the estimate there holds.
Future<void> _jumpToStart(WidgetTester tester) async {
  final position = _position(tester);
  for (var attempt = 0; attempt < 20; attempt++) {
    final start = position.minScrollExtent;
    position.jumpTo(start);
    await tester.pump();
    if (position.minScrollExtent == start && position.pixels == start) return;
  }
  fail('the start of the transcript never settled');
}

/// Puts the reader [viewports] below the start of what is loaded, without
/// moving them (a jump is not the reader's movement).
Future<void> _placeBelowStart(WidgetTester tester, double viewports) async {
  await _jumpToStart(tester);
  final position = _position(tester);
  position.jumpTo(
    position.minScrollExtent + position.viewportDimension * viewports,
  );
  await tester.pump();
}

Future<void> _wheel(WidgetTester tester, double dy) async {
  await tester.sendEventToBinding(
    PointerScrollEvent(
      position: tester.getCenter(_transcript),
      scrollDelta: Offset(0, dy),
    ),
  );
  await tester.pump();
}

double _distanceToStart(WidgetTester tester) {
  final position = _position(tester);
  return position.pixels - position.minScrollExtent;
}

/// Drags toward the start at [speed] pixels per second, in 16 ms samples,
/// until the first older page is asked for, and returns how far from the
/// start of what was loaded the reader was when it was.
Future<double?> _dragUntilRequest(
  WidgetTester tester,
  FixturePagingBroker broker, {
  required double speed,
}) async {
  final asked = broker.older.length;
  final gesture = await tester.createGesture();
  await gesture.down(tester.getCenter(_transcript));
  const frame = Duration(milliseconds: 16);
  var time = Duration.zero;
  final step = speed * frame.inMicroseconds / 1e6;
  double? distance;
  for (var sample = 0; sample < 400; sample++) {
    // The distance from where the reader stood when the move was reported.
    final before = _distanceToStart(tester);
    time += frame;
    await gesture.moveBy(Offset(0, step), timeStamp: time);
    await tester.pump(frame);
    if (broker.older.length > asked) {
      distance = before;
      break;
    }
  }
  await gesture.up(timeStamp: time + const Duration(milliseconds: 200));
  await _pumpFor(tester, const Duration(seconds: 1));
  return distance;
}

void main() {
  tearDown(() => debugTranscriptPrefetchPolicy = null);

  testWidgets('a faster reader asks for the page from farther away', (
    tester,
  ) async {
    // Pages take a quarter of a second, so that is the latency learned.
    final broker = await _open(
      tester,
      latency: const Duration(milliseconds: 250),
    );
    final viewport = _position(tester).viewportDimension;

    await _placeBelowStart(tester, 2.5);
    final slow = await _dragUntilRequest(tester, broker, speed: 240);
    expect(slow, isNotNull);
    expect(
      slow,
      lessThanOrEqualTo(viewport + 8),
      reason: 'a slow reader is asked for at the shortest distance',
    );

    await _placeBelowStart(tester, 3.2);
    final fast = await _dragUntilRequest(tester, broker, speed: 3600);
    expect(fast, isNotNull);
    expect(
      fast,
      greaterThan(viewport * 1.5),
      reason: 'a fast reader covers more while the page is on its way',
    );
  });

  testWidgets('a fling asks for the page from as far as its speed carries '
      'it while the page is on its way', (tester) async {
    final broker = await _open(
      tester,
      latency: const Duration(milliseconds: 250),
    );
    final viewport = _position(tester).viewportDimension;
    // Beyond the longest prefetch distance, so the drag that throws the
    // fling asks for nothing; the fling carries the reader toward the start.
    await _placeBelowStart(tester, 4);
    await tester.flingFrom(
      tester.getCenter(_transcript),
      const Offset(0, 200),
      6000,
    );
    double? askedAt;
    for (var frame = 0; frame < 120 && askedAt == null; frame++) {
      final before = _distanceToStart(tester);
      await tester.pump(const Duration(milliseconds: 16));
      if (broker.older.isNotEmpty) askedAt = before;
    }
    expect(askedAt, isNotNull);
    expect(
      askedAt,
      greaterThan(viewport * 1.5),
      reason: 'at fling speed the page is asked for well before the start',
    );
    await _pumpFor(tester, const Duration(seconds: 2));
  });

  testWidgets('the page latency the reader waits on is what is learned', (
    tester,
  ) async {
    final broker = await _open(
      tester,
      latency: const Duration(milliseconds: 600),
    );
    final prefetch = debugTranscriptPrefetch!;
    for (var page = 0; page < 3; page++) {
      await _placeBelowStart(tester, 0.5);
      await _wheel(tester, -40);
      await _pumpFor(tester, const Duration(milliseconds: 900));
    }
    expect(broker.older, hasLength(3));
    expect(prefetch.latencySamples, 3);
    expect(
      prefetch.latency.inMilliseconds,
      inInclusiveRange(600, 640),
      reason: 'measured from the request to the frame the page lands in',
    );
  });

  testWidgets('a page is asked for once while it is on its way', (
    tester,
  ) async {
    final broker = await _open(tester)
      ..holding = true;
    await _placeBelowStart(tester, 0.5);
    for (var tick = 0; tick < 12; tick++) {
      await _wheel(tester, -30);
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(broker.older, hasLength(1));
    broker.release();
    await _pumpFor(tester, const Duration(milliseconds: 100));
    expect(find.text('Loading earlier messages…'), findsNothing);
  });

  testWidgets('once the reader stops, a page landing asks for no other', (
    tester,
  ) async {
    // Pages of three rows leave the reader inside the prefetch distance
    // after each one lands; only their movement may ask again.
    final broker = await _open(
      tester,
      latency: const Duration(milliseconds: 500),
      pageRows: 3,
      shortRows: true,
    );
    await _placeBelowStart(tester, 0.3);
    await _wheel(tester, -40);
    await _pumpFor(tester, const Duration(seconds: 3));
    expect(broker.older, hasLength(1));
    expect(
      _distanceToStart(tester),
      lessThan(_position(tester).viewportDimension),
    );

    await _wheel(tester, -40);
    await _pumpFor(tester, const Duration(seconds: 1));
    expect(broker.older, hasLength(2), reason: 'moving again asks again');
  });

  testWidgets('a long fast fling asks for a bounded number of pages', (
    tester,
  ) async {
    final broker = await _open(tester, pageRows: 2, shortRows: true);
    await _placeBelowStart(tester, 1.4);
    final gesture = await tester.createGesture();
    await gesture.down(tester.getCenter(_transcript));
    var time = Duration.zero;
    for (var sample = 0; sample < 6; sample++) {
      time += const Duration(milliseconds: 8);
      await gesture.moveBy(const Offset(0, 60), timeStamp: time);
    }
    final atLift = broker.older.length;
    await gesture.up(timeStamp: time);
    await _pumpFor(tester, const Duration(seconds: 4));
    final policy = debugTranscriptPrefetch!.policy;
    expect(
      broker.older.length - atLift,
      lessThanOrEqualTo(policy.flingPages),
      reason: 'after the finger left, the fling may ask for flingPages',
    );
    expect(
      broker.older.length - atLift,
      policy.flingPages,
      reason: 'a fling this long reaches the limit',
    );
    await _pumpFor(tester, const Duration(seconds: 2));
    expect(broker.older.length - atLift, policy.flingPages);
  });

  testWidgets('a page that failed for a passing reason is asked for again '
      'after a doubling backoff', (tester) async {
    final broker = await _open(tester)
      ..failNext = 2
      ..failureCode = 'HISTORY_PAGE_SOURCE_CHANGED';
    await _placeBelowStart(tester, 0.5);
    await _wheel(tester, -40);
    await tester.pump();
    expect(broker.requests, hasLength(1));
    // The reader stays at the boundary; the first retry waits 500 ms.
    await _pumpFor(tester, const Duration(milliseconds: 440));
    expect(broker.requests, hasLength(1));
    await _pumpFor(tester, const Duration(milliseconds: 120));
    expect(broker.requests, hasLength(2));
    // The second waits 1000 ms, and succeeds.
    await _pumpFor(tester, const Duration(milliseconds: 900));
    expect(broker.requests, hasLength(2));
    await _pumpFor(tester, const Duration(milliseconds: 160));
    expect(broker.requests, hasLength(3));
    expect(broker.requests.last.failed, isFalse);
    await _pumpFor(tester, const Duration(seconds: 3));
    expect(broker.requests, hasLength(3), reason: 'nothing more at rest');
  });

  testWidgets('a page that brings nothing and ends where it was asked from '
      'adds nothing, and is asked for again only after the backoff', (
    tester,
  ) async {
    final broker = await _open(tester)
      ..stallNext = 1000;
    final pages = _window(tester).pages.length;
    await _placeBelowStart(tester, 0.5);
    await _wheel(tester, -40);
    await tester.pump();
    expect(broker.requests, hasLength(1));
    // The reader stays at the boundary: 500 ms, then 1, 2 and 4 s (each
    // counted from the frame the last answer landed in, so a frame or two
    // later every time), and no more once the automatic retries are spent.
    for (final (wait, asked) in const [
      (Duration(milliseconds: 440), 1),
      (Duration(milliseconds: 120), 2),
      (Duration(milliseconds: 900), 2),
      (Duration(milliseconds: 160), 3),
      (Duration(milliseconds: 1800), 3),
      (Duration(milliseconds: 250), 4),
      (Duration(milliseconds: 3700), 4),
      (Duration(milliseconds: 400), 5),
      (Duration(seconds: 20), 5),
    ]) {
      await _pumpFor(tester, wait);
      expect(broker.requests, hasLength(asked));
      expect(_window(tester).pages, hasLength(pages));
    }
    expect(broker.requests.map((request) => request.cursor).toSet(), {
      'b2900',
    });
    // The start of what is loaded, just above the reader, says it failed.
    expect(
      find.byKey(
        const Key('session-history-page-error'),
        skipOffstage: false,
      ),
      findsOneWidget,
    );
    // Moving on the spent boundary asks for nothing by itself.
    for (var tick = 0; tick < 5; tick++) {
      await _wheel(tester, -40);
      await _pumpFor(tester, const Duration(milliseconds: 300));
    }
    expect(broker.requests, hasLength(5));
    expect(_window(tester).pages, hasLength(pages));
  });

  testWidgets('a newer page into a released range that brings nothing and '
      'ends where it was asked from adds nothing, and is asked for again only '
      'after the backoff', (tester) async {
    final broker = await _open(tester);
    // Read back until the budget releases rows between the reader and the
    // newest ones.
    for (var page = 0; page < 12 && _window(tester).gaps.isEmpty; page++) {
      await _placeBelowStart(tester, 0.5);
      await _wheel(tester, -40);
      await _pumpFor(tester, const Duration(milliseconds: 600));
    }
    final gap = _window(tester).gaps.first;
    expect(gap.forwardCursor, isNotNull);
    broker.stallNext = 1000;
    final asked = broker.requests.length;
    final pages = _window(tester).pages.length;
    // Down to the range, without earning intent, until it sits in the lower
    // half of the viewport.
    final position = _position(tester);
    final rect = tester.getRect(_transcript);
    for (var step = 0; step < 400; step++) {
      final row = find.byKey(Key(gap.id));
      if (row.evaluate().isNotEmpty) {
        final top = tester.getTopLeft(row).dy;
        if (top > rect.center.dy && top < rect.bottom - 8) break;
      }
      position.jumpTo(position.pixels + position.viewportDimension / 4);
      await tester.pump();
    }
    await _wheel(tester, 40);
    await tester.pump();
    expect(broker.requests, hasLength(asked + 1));
    expect(broker.requests.last.newer, isTrue);
    expect(broker.requests.last.cursor, gap.forwardCursor);
    await _pumpFor(tester, const Duration(seconds: 20));
    final retries = debugTranscriptPrefetch!.policy.retryLimit;
    expect(broker.requests, hasLength(asked + 1 + retries));
    expect(
      broker.requests.skip(asked).map((request) => request.cursor).toSet(),
      {gap.forwardCursor},
    );
    expect(_window(tester).pages, hasLength(pages));
    expect(_window(tester).gaps.first.forwardCursor, gap.forwardCursor);
    await _pumpFor(tester, const Duration(seconds: 10));
    expect(broker.requests, hasLength(asked + 1 + retries));
  });

  for (final code in const ['BAD_PARAM', 'HISTORY_PAGE_RESOURCE_LIMIT']) {
    testWidgets('a refusal that cannot pass ($code) is never asked for again '
        'by itself', (tester) async {
      final broker = await _open(tester)
        ..failNext = 1
        ..failureCode = code;
      await _placeBelowStart(tester, 0.5);
      await _wheel(tester, -40);
      await _pumpFor(tester, const Duration(seconds: 20));
      for (var tick = 0; tick < 5; tick++) {
        await _wheel(tester, -40);
        await _pumpFor(tester, const Duration(milliseconds: 300));
      }
      expect(broker.requests, hasLength(1));
    });
  }

  testWidgets('a transcript replacement forgets what failed before it', (
    tester,
  ) async {
    final broker = await _open(tester)
      ..failNext = 1
      ..failureCode = 'BAD_PARAM';
    await _placeBelowStart(tester, 0.5);
    await _wheel(tester, -40);
    await _pumpFor(tester, const Duration(seconds: 1));
    expect(broker.requests, hasLength(1));

    // The same rows and positions again, as a replacement: the same boundary
    // the reader is at, in a new generation.
    broker.emitEvent(
      HistoryWireEvent(
        messages: fixtureRows(2900, 3000),
        reset: true,
        cursor: 'r3000',
        olderCursor: 'b2900',
        hasEarlier: true,
        endCursor: 'b3000',
        newerHistory: true,
      ),
    );
    await tester.pumpAndSettle();
    await _placeBelowStart(tester, 0.5);
    await _wheel(tester, -40);
    await _pumpFor(tester, const Duration(milliseconds: 300));
    expect(broker.requests, hasLength(2));
    expect(broker.requests.last.cursor, 'b2900');
  });

  testWidgets('turning around at the start does not trade pages back and '
      'forth', (tester) async {
    // Tiny pages: the window releases rows just below the reader as pages
    // land above, so a released range is always close behind them.
    final broker = await _open(tester, pageRows: 3, shortRows: true);
    await _placeBelowStart(tester, 0.2);
    for (var tick = 0; tick < 40; tick++) {
      await _wheel(tester, -60);
      await _pumpFor(tester, const Duration(milliseconds: 48));
    }
    await _pumpFor(tester, const Duration(seconds: 1));
    final before = broker.requests.length;
    // Small strokes the other way and back, each under half a viewport.
    final viewport = _position(tester).viewportDimension;
    final stroke = viewport * 0.3;
    for (var turn = 0; turn < 8; turn++) {
      final down = turn.isEven;
      for (var tick = 0; tick < 3; tick++) {
        await _wheel(tester, (down ? stroke : -stroke) / 3);
        await _pumpFor(tester, const Duration(milliseconds: 32));
      }
    }
    await _pumpFor(tester, const Duration(seconds: 1));
    var reversals = 0;
    final after = broker.requests.sublist(math.max(0, before - 1));
    for (var i = 1; i < after.length; i++) {
      if (after[i].newer != after[i - 1].newer) reversals += 1;
    }
    expect(
      reversals,
      lessThanOrEqualTo(1),
      reason: 'strokes shorter than the reversal distance never alternate',
    );
  });
}
