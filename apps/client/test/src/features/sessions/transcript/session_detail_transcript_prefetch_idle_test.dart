// A failed history page the reader has left behind costs nothing while they
// are away: the transcript asks for no frame until the reader, a page or the
// layout gives it a reason, and still asks for the page again once one does.
//
// The real session page runs over a broker fake that pages a long history,
// under a binding that counts every frame asked for.
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';
import '../../../../support/transcript_scroll_fixture.dart';

/// Counts every frame asked for. A test pump draws its frame without asking.
final class _FrameCountingBinding extends AutomatedTestWidgetsFlutterBinding {
  int framesAsked = 0;

  @override
  void scheduleFrame() {
    framesAsked += 1;
    super.scheduleFrame();
  }
}

Finder get _transcript => find.byKey(const Key('session-detail-chat-scroll'));

ScrollPosition _position(WidgetTester tester) {
  final scrollable = tester.widget<Scrollable>(
    find.descendant(of: _transcript, matching: find.byType(Scrollable)).first,
  );
  return scrollable.controller!.position;
}

Future<FixturePagingBroker> _open(WidgetTester tester) async {
  useRoomyTestViewport(tester);
  final broker = FixturePagingBroker(total: 3000)
    ..failNext = 1
    ..failureCode = 'HISTORY_PAGE_SOURCE_CHANGED';
  await tester.pumpWidget(
    buildSessionDetailTestPage(events: const [], connection: broker),
  );
  await tester.pumpAndSettle();
  return broker;
}

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

/// The first page from the start of what is loaded fails for a reason that
/// can pass, and the reader then taps Jump to latest, far from it, before its
/// backoff passes.
Future<FixturePagingBroker> _failThenJumpToLatest(WidgetTester tester) async {
  final broker = await _open(tester);
  await _placeBelowStart(tester, 0.5);
  await _wheel(tester, -40);
  await tester.pump();
  expect(broker.requests, hasLength(1));
  expect(broker.requests.single.failed, isTrue);
  await tester.tap(find.byKey(const Key('session-history-jump-latest')));
  await tester.pump();
  // Past the backoff, with the reader still away.
  await _pumpFor(tester, const Duration(seconds: 3));
  expect(broker.requests, hasLength(1));
  expect(
    debugTranscriptPrefetch!.retryDue(
      tester.binding.currentSystemFrameTimeStamp,
    ),
    isTrue,
    reason: 'the failure is remembered, and may be asked for again',
  );
  return broker;
}

void main() {
  final binding = _FrameCountingBinding();

  tearDown(() => debugTranscriptPrefetchPolicy = null);

  testWidgets('a failed page left behind by Jump to latest asks for no frame '
      'while the reader is idle', (tester) async {
    final broker = await _failThenJumpToLatest(tester);
    final before = binding.framesAsked;
    await _pumpFor(tester, const Duration(seconds: 1));
    expect(
      binding.framesAsked - before,
      0,
      reason: 'nothing moved and nothing was asked for',
    );
    expect(broker.requests, hasLength(1));
  });

  testWidgets('a failed page is asked for again when its backoff passes with '
      'the reader still at it, and then nothing more is', (tester) async {
    final broker = await _open(tester);
    await _placeBelowStart(tester, 0.5);
    await _wheel(tester, -40);
    await tester.pump();
    expect(broker.requests, hasLength(1));
    await _pumpFor(tester, const Duration(milliseconds: 440));
    expect(broker.requests, hasLength(1));
    await _pumpFor(tester, const Duration(milliseconds: 120));
    expect(broker.requests, hasLength(2));
    expect(broker.requests.last.cursor, 'b2900');
    expect(broker.requests.last.failed, isFalse);
    await _pumpFor(tester, const Duration(seconds: 3));
    final before = binding.framesAsked;
    await _pumpFor(tester, const Duration(seconds: 1));
    expect(binding.framesAsked - before, 0);
    expect(broker.requests, hasLength(2));
  });

  testWidgets('a failed page left behind is asked for again when the reader '
      'moves back toward it', (tester) async {
    final broker = await _failThenJumpToLatest(tester);
    // Back, beyond the shortest prefetch distance and never nearer: a jump
    // there asks for nothing.
    final position = _position(tester);
    for (var attempt = 0; attempt < 20; attempt++) {
      final target =
          position.minScrollExtent + position.viewportDimension * 2.5;
      if ((position.pixels - target).abs() < 1) break;
      position.jumpTo(target);
      await tester.pump();
    }
    await _pumpFor(tester, const Duration(seconds: 1));
    expect(
      position.pixels - position.minScrollExtent,
      greaterThan(position.viewportDimension * 2),
    );
    expect(broker.requests, hasLength(1));
    // The reader moves toward it.
    for (var tick = 0; tick < 80 && broker.requests.length == 1; tick++) {
      await _wheel(tester, -40);
      await tester.pump(const Duration(milliseconds: 16));
    }
    expect(broker.requests, hasLength(2));
    expect(broker.requests.last.cursor, 'b2900');
    expect(broker.requests.last.failed, isFalse);
  });

  testWidgets('a failed page left behind is asked for again when a jump '
      'brings the reader back to it', (tester) async {
    final broker = await _failThenJumpToLatest(tester);
    await _placeBelowStart(tester, 0.5);
    await _pumpFor(tester, const Duration(milliseconds: 100));
    expect(broker.requests, hasLength(2));
    expect(broker.requests.last.cursor, 'b2900');
    expect(broker.requests.last.failed, isFalse);
  });
}
