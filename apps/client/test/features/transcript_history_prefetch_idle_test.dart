// F03b: a failed history page the reader has left behind costs nothing while
// they are away. The transcript asks for no frame until the reader, a page or
// the layout gives it a reason, and still asks for the page again once one
// does.
//
// Its own file because it runs under a binding that counts every frame asked
// for; a test pump draws its frame without asking.
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/app_driver.dart';
import '../support/feature/cosyncing_app.dart';
import '../support/feature/paging_broker.dart';
import '../support/feature/transcript_reader.dart';

final class _FrameCountingBinding extends AutomatedTestWidgetsFlutterBinding {
  int framesAsked = 0;

  @override
  void scheduleFrame() {
    framesAsked += 1;
    super.scheduleFrame();
  }
}

Future<(AppDriver, FixturePagingBroker)> _open(FeatureContext f) => openPaging(
  f,
  total: 3000,
  configure: (broker) => broker
    ..failNext = 1
    ..failureCode = 'HISTORY_PAGE_SOURCE_CHANGED',
);

/// The first page from the start of what is loaded fails for a reason that
/// can pass, and the reader then taps Jump to latest, far from it, before its
/// backoff passes.
Future<(AppDriver, FixturePagingBroker)> _failThenJumpToLatest(
  FeatureContext f,
) async {
  final (app, broker) = await _open(f);
  await app.placeBelowStart(0.5);
  await app.wheel(-40);
  await app.frames(1);
  expect(broker.requests, hasLength(1));
  expect(broker.requests.single.failed, isTrue);
  await f.tester.tap(find.byKey(const Key('session-history-jump-latest')));
  await f.tester.pump();
  // Past the backoff, with the reader still away.
  await app.pumpFor(const Duration(seconds: 3));
  expect(broker.requests, hasLength(1));
  expect(
    debugTranscriptPrefetch!.retryDue(
      f.tester.binding.currentSystemFrameTimeStamp,
    ),
    isTrue,
    reason: 'the failure is remembered, and may be asked for again',
  );
  return (app, broker);
}

void main() {
  final binding = _FrameCountingBinding();

  tearDown(() => debugTranscriptPrefetchPolicy = null);

  featureTest('a failed page left behind by Jump to latest asks for no frame '
      'while the reader is idle', (f) async {
    final (app, broker) = await _failThenJumpToLatest(f);
    final before = binding.framesAsked;
    await app.pumpFor(const Duration(seconds: 1));
    expect(
      binding.framesAsked - before,
      0,
      reason: 'nothing moved and nothing was asked for',
    );
    expect(broker.requests, hasLength(1));
  });

  featureTest('a failed page is asked for again when its backoff passes with '
      'the reader still at it, and then nothing more is', (f) async {
    final (app, broker) = await _open(f);
    await app.placeBelowStart(0.5);
    await app.wheel(-40);
    await app.frames(1);
    expect(broker.requests, hasLength(1));
    await app.pumpFor(const Duration(milliseconds: 440));
    expect(broker.requests, hasLength(1));
    await app.pumpFor(const Duration(milliseconds: 120));
    expect(broker.requests, hasLength(2));
    expect(broker.requests.last.cursor, 'b2900');
    expect(broker.requests.last.failed, isFalse);
    await app.pumpFor(const Duration(seconds: 3));
    final before = binding.framesAsked;
    await app.pumpFor(const Duration(seconds: 1));
    expect(binding.framesAsked - before, 0);
    expect(broker.requests, hasLength(2));
  });

  featureTest('a failed page left behind is asked for again when the reader '
      'moves back toward it', (f) async {
    final (app, broker) = await _failThenJumpToLatest(f);
    // Back, beyond the shortest prefetch distance and never nearer: a jump
    // there asks for nothing.
    final position = app.position;
    for (var attempt = 0; attempt < 20; attempt++) {
      final target =
          position.minScrollExtent + position.viewportDimension * 2.5;
      if ((position.pixels - target).abs() < 1) break;
      position.jumpTo(target);
      await f.tester.pump();
    }
    await app.pumpFor(const Duration(seconds: 1));
    expect(
      position.pixels - position.minScrollExtent,
      greaterThan(position.viewportDimension * 2),
    );
    expect(broker.requests, hasLength(1));
    // The reader moves toward it.
    for (var tick = 0; tick < 80 && broker.requests.length == 1; tick++) {
      await app.wheel(-40);
      await f.tester.pump(const Duration(milliseconds: 16));
    }
    expect(broker.requests, hasLength(2));
    expect(broker.requests.last.cursor, 'b2900');
    expect(broker.requests.last.failed, isFalse);
  });

  featureTest('a failed page left behind is asked for again when a jump '
      'brings the reader back to it', (f) async {
    final (app, broker) = await _failThenJumpToLatest(f);
    await app.placeBelowStart(0.5);
    await app.pumpFor(const Duration(milliseconds: 100));
    expect(broker.requests, hasLength(2));
    expect(broker.requests.last.cursor, 'b2900');
    expect(broker.requests.last.failed, isFalse);
  });
}
