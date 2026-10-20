// What a person reading a long transcript does, and what they see, for the
// history scenarios (F03b): scroll, wheel, throw, page keys, and measure where
// a row sits on screen.
//
// Rows are identified by the `Row N.` marker their text starts with, so a row
// can be found whatever its height. All waiting is fake time.
import 'dart:math' as math;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'app_driver.dart';
import 'cosyncing_app.dart';
import 'fake_broker.dart';
import 'paging_broker.dart';
import 'transcript_wire.dart';

const String _pixel =
    'data:image/png;base64,'
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42'
    'mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

String _paragraph(int index, int p) =>
    'Paragraph $p of row $index explains what the agent changed and why, '
    'with `inline code`, a plain word and '
    'enough words to wrap across several lines at any width.';

/// [paragraphs] paragraphs of prose for row [index].
String markedProse(int index, int paragraphs) => [
  for (var p = 0; p < paragraphs; p++) _paragraph(index, p),
].join('\n\n');

/// Durable row [index] with genuinely different heights: prose, a table, code,
/// a call with its diff, an approval and its answer, an image and an
/// oversized body. Built in tens so a call and its result never straddle a
/// page boundary. Every text row starts `Row N.`.
Map<String, Object?> markedRow(int index) => switch (index % 10) {
  0 => {
    'type': 'user-message',
    'key': 'u$index',
    'text': 'Row $index. Please look at part ${index ~/ 10}.',
  },
  1 => {
    'type': 'model-output',
    'key': 'm$index',
    'text': 'Row $index. ${markedProse(index, 1 + index % 4)}',
    'final': true,
  },
  2 => {
    'type': 'model-output',
    'key': 'm$index',
    'text':
        '## Row $index. Summary\n\n- first point\n- second point\n\n'
        '| file | change |\n|---|---|\n| lib/a.dart | +2 |\n'
        '| lib/b.dart | -1 |\n',
    'final': true,
  },
  3 => {
    'type': 'model-output',
    'key': 'm$index',
    'text':
        'Row $index. The fix:\n\n```dart\nvoid fix$index() {\n'
        '  print($index);\n}\n```',
    'final': true,
  },
  4 => {
    'type': 'tool-call',
    'callId': 'c$index',
    'name': 'edit',
    'toolClass': 'edit',
    'arguments': {'path': 'lib/r$index.dart'},
  },
  5 => {
    'type': 'tool-result',
    'callId': 'c${index - 1}',
    'name': 'edit',
    'toolClass': 'edit',
    'path': 'lib/r${index - 1}.dart',
    'diff':
        '--- a/lib/r.dart\n+++ b/lib/r.dart\n@@ -1,2 +1,3 @@\n'
        ' keep\n-old\n+new\n+extra\n',
    'additions': 2,
    'deletions': 1,
  },
  6 => {
    'type': 'permission-request',
    'requestId': 'p$index',
    'title': 'Run the tests for part ${index ~/ 10}?',
  },
  7 => {
    'type': 'permission-resolved',
    'requestId': 'p${index - 1}',
    'decision': 'allow',
  },
  8 => {
    'type': 'file-artifact',
    'artifactKey': 'image-$index',
    'name': 'screen-$index.png',
    'mimeType': 'image/png',
    'url': _pixel,
  },
  _ => {
    'type': 'model-output',
    'key': 'm$index',
    'text': index % 100 == 49
        ? 'Row $index. ${markedProse(index, 40)}'
        : 'Row $index. Done.',
    'final': true,
  },
};

final Map<int, String> _commandOutputs = {};

/// Durable row [index] of a session that mostly runs commands, built in turns
/// of [turn] rows: a prompt, a reply, commands with [output] characters of
/// output each, a thought and a closing line. With tool calls hidden a page
/// draws a few short rows, or none. Every drawn row starts `Row N.`.
Map<String, Object?> commandHeavyRow(
  int index, {
  int turn = 40,
  int output = 12000,
}) => switch (index % turn) {
  0 => {
    'type': 'user-message',
    'key': 'u$index',
    'text': 'Row $index. Please run part ${index ~/ turn}.',
  },
  1 => {
    'type': 'model-output',
    'key': 'm$index',
    'text': 'Row $index. ${markedProse(index, 2)}',
    'final': true,
  },
  final slot when slot == turn - 2 => {
    'type': 'thinking',
    'key': 't$index',
    'text': 'Thinking $index.',
  },
  final slot when slot == turn - 1 => {
    'type': 'model-output',
    'key': 'm$index',
    'text': 'Row $index. Part ${index ~/ turn} ran.',
    'final': true,
  },
  final slot when slot.isEven => {
    'type': 'tool-call',
    'callId': 'c$index',
    'name': 'bash',
    'toolClass': 'execute',
    'arguments': {'command': 'make part-$index'},
  },
  _ => {
    'type': 'tool-result',
    'callId': 'c${index - 1}',
    'name': 'bash',
    'toolClass': 'execute',
    'output': _commandOutputs[output] ??= 'x' * output,
  },
};

/// `Row N.` as the first text of a row.
final RegExp rowMarker = RegExp(r'Row (\d+)\.');

/// The transcript list.
Finder get transcriptList =>
    find.byKey(const Key('session-detail-chat-scroll'));

/// Loading notices at either end of what is loaded.
const String loadingEarlier = 'Loading earlier messages…';

/// See [loadingEarlier].
const String loadingNewer = 'Loading newer messages…';

/// The released ranges the list shows between loaded pages.
final Finder releasedRanges = find.byWidgetPredicate((widget) {
  final key = widget.key;
  return key is ValueKey<String> &&
      key.value.startsWith('history-gap-') &&
      !key.value.endsWith('-reload');
}, skipOffstage: false);

/// A marked row on screen: its number and the screen top of its marked text.
typedef ReadRow = ({int index, double top});

/// Reader verbs over the open transcript.
extension TranscriptReader on AppDriver {
  /// The list's scroll position.
  ScrollPosition get position {
    final scrollable = tester.widget<Scrollable>(
      find
          .descendant(of: transcriptList, matching: find.byType(Scrollable))
          .first,
    );
    return scrollable.controller!.position;
  }

  /// Pumps [frames] frames of 16 ms.
  Future<void> frames([int frames = 30]) async {
    for (var frame = 0; frame < frames; frame++) {
      await tester.pump(const Duration(milliseconds: 16));
    }
  }

  /// Pumps frames of [step] until [duration] of fake time has passed.
  Future<void> pumpFor(
    Duration duration, {
    Duration step = const Duration(milliseconds: 16),
  }) async {
    for (var t = Duration.zero; t < duration; t += step) {
      await tester.pump(step);
    }
  }

  /// Reads back [pages] pages from the start of what is loaded, one gesture
  /// each, waiting for each page to land. The broker must answer on its own.
  Future<void> readBack(FixturePagingBroker broker, int pages) async {
    final target = broker.older.length + pages;
    for (var page = broker.older.length; page < target; page++) {
      await askForEarlier();
      expect(broker.older, hasLength(page + 1));
      await frames(10);
    }
  }

  /// One wheel click of [dy] over the list.
  Future<void> wheel(double dy) async {
    await tester.sendEventToBinding(
      PointerScrollEvent(
        position: tester.getCenter(transcriptList),
        scrollDelta: Offset(0, dy),
      ),
    );
    await tester.pump();
  }

  /// A drag of [dy] (positive moves toward the start of the transcript).
  Future<void> drag(double dy) async {
    await tester.drag(transcriptList, Offset(0, dy));
    await tester.pump();
  }

  /// Jumps to the start of what is loaded. The start is an estimate until the
  /// rows there are laid out, so this repeats until it holds, as a reader
  /// scrolling there would find it.
  Future<void> jumpToStart() async {
    final position = this.position;
    for (var attempt = 0; attempt < 20; attempt++) {
      final start = position.minScrollExtent;
      position.jumpTo(start);
      await tester.pump();
      if (position.minScrollExtent == start && position.pixels == start) return;
    }
    fail('the start of the transcript never settled');
  }

  /// Jumps to the newest row.
  Future<void> jumpToEnd() async {
    final position = this.position;
    position.jumpTo(position.maxScrollExtent);
    await tester.pumpAndSettle();
  }

  /// Puts the reader [viewports] below the start of what is loaded, without
  /// the reader's own movement (a jump earns no loading intent).
  Future<void> placeBelowStart(double viewports) async {
    await jumpToStart();
    final position = this.position;
    position.jumpTo(
      position.minScrollExtent + position.viewportDimension * viewports,
    );
    await tester.pump();
  }

  /// Pixels between the reader and the start of what is loaded.
  double get distanceToStart => position.pixels - position.minScrollExtent;

  /// Every marked row that intersects the viewport, by where its marked text
  /// starts, top first.
  List<ReadRow> get markedRows {
    final tops = <int, double>{};
    // Onstage only: a kept-alive row off screen keeps a stale position.
    for (final element
        in find
            .descendant(of: transcriptList, matching: find.byType(RichText))
            .evaluate()) {
      final match = rowMarker.firstMatch(
        (element.widget as RichText).text.toPlainText(),
      );
      if (match == null) continue;
      final box = element.renderObject! as RenderBox;
      if (!box.attached || !box.hasSize) continue;
      final top = box.localToGlobal(Offset.zero).dy;
      final index = int.parse(match.group(1)!);
      final known = tops[index];
      tops[index] = known == null ? top : math.min(known, top);
    }
    return [
      for (final entry in tops.entries) (index: entry.key, top: entry.value),
    ]..sort((a, b) => a.top.compareTo(b.top));
  }

  /// Where row [index]'s marked text is, or null when it is not on screen.
  double? topOf(int index) {
    for (final row in markedRows) {
      if (row.index == index) return row.top;
    }
    return null;
  }

  /// The row the reader is reading: the first marked row whose text starts on
  /// screen, or else the row above that fills the top of the viewport.
  ReadRow get reading {
    final rect = tester.getRect(transcriptList);
    final rows = markedRows;
    expect(rows, isNotEmpty, reason: 'some marked row must be on screen');
    for (final row in rows) {
      if (row.top >= rect.top) return row;
    }
    return rows.last;
  }

  /// Asserts [before] is still where it was, to a logical pixel.
  void expectHeld(ReadRow before, {required String when}) {
    final after = topOf(before.index);
    expect(
      after,
      isNotNull,
      reason: 'row ${before.index} left the screen $when',
    );
    expect(
      after,
      moreOrLessEquals(before.top, epsilon: 1),
      reason: 'row ${before.index} moved $when',
    );
  }

  /// Moves (without earning intent) to [fraction] of a viewport below the
  /// start of what is loaded, then wheels up once: asks for the page above.
  Future<void> askForEarlier({double fraction = 0.6}) async {
    await placeBelowStart(fraction);
    await wheel(-40);
  }

  /// Moves down (without earning intent) until a released range sits in the
  /// lower half of the viewport, then wheels down once, which asks for the
  /// newer page that fills it. Returns the row being read once the request is
  /// in flight, or null when nothing below is released.
  Future<ReadRow?> askForNewer(FixturePagingBroker broker) async {
    final position = this.position;
    final rect = tester.getRect(transcriptList);
    final asked = broker.newer.length;
    for (var step = 0; step < 400; step++) {
      double? gapTop;
      for (final element in releasedRanges.evaluate()) {
        final box = element.renderObject;
        if (box is! RenderBox || !box.attached || !box.hasSize) continue;
        final top = box.localToGlobal(Offset.zero).dy;
        if (top > rect.top + rect.height / 2 && top < rect.bottom - 8) {
          gapTop = top;
          break;
        }
      }
      if (gapTop != null) break;
      if (position.pixels >= position.maxScrollExtent) return null;
      position.jumpTo(
        math.min(
          position.maxScrollExtent,
          position.pixels + position.viewportDimension / 4,
        ),
      );
      await tester.pump();
    }
    await wheel(40);
    if (broker.newer.length == asked) return null;
    await frames(3);
    // The rows the page brings land at the range, below the reader; the row
    // measured is the last one above it, which may start above the viewport.
    final gapTop = firstRangeTop;
    expect(gapTop, isNotNull, reason: 'the range being filled must be built');
    final above = [
      for (final row in markedRows)
        if (row.top < gapTop!) row,
    ];
    expect(above, isNotEmpty, reason: 'a marked row must sit above the range');
    return above.last;
  }

  /// Moves up (without earning intent) until a released range sits in the
  /// upper half of the viewport, then wheels up once, which asks for the page
  /// that fills it from its newer edge. Returns the row being read once the
  /// request is in flight, or null when nothing above is released.
  Future<ReadRow?> askForRangeAbove(FixturePagingBroker broker) async {
    final position = this.position;
    final rect = tester.getRect(transcriptList);
    final asked = broker.older.length;
    RenderBox? found;
    for (var step = 0; step < 400 && found == null; step++) {
      for (final element in releasedRanges.evaluate()) {
        final box = element.renderObject;
        if (box is! RenderBox || !box.attached || !box.hasSize) continue;
        final bottom = box.localToGlobal(Offset(0, box.size.height)).dy;
        if (bottom > rect.top + 8 && bottom < rect.top + rect.height / 2) {
          found = box;
          break;
        }
      }
      if (found != null) break;
      if (position.pixels <= position.minScrollExtent) return null;
      position.jumpTo(
        math.max(
          position.minScrollExtent,
          position.pixels - position.viewportDimension / 4,
        ),
      );
      await tester.pump();
    }
    if (found == null) return null;
    // Put the range's lower edge a little above the middle, with a row that
    // starts on screen above it as well as the rows below.
    final lowerEdge = found.localToGlobal(Offset(0, found.size.height)).dy;
    position.jumpTo(
      position.pixels + lowerEdge - (rect.top + rect.height * 0.45),
    );
    await tester.pump();
    final upperEdge = found.localToGlobal(Offset.zero).dy;
    expect(
      markedRows.any((row) => row.top >= rect.top && row.top < upperEdge),
      isTrue,
      reason: 'a row must start on screen above the range',
    );
    await wheel(-40);
    if (broker.older.length == asked) return null;
    await frames(3);
    double? gapBottom;
    for (final element in releasedRanges.evaluate()) {
      final box = element.renderObject;
      if (box is! RenderBox || !box.attached || !box.hasSize) continue;
      final bottom = box.localToGlobal(Offset(0, box.size.height)).dy;
      if (bottom > rect.bottom) continue;
      if (gapBottom == null || bottom > gapBottom) gapBottom = bottom;
    }
    expect(
      gapBottom,
      isNotNull,
      reason: 'the range being filled must be built',
    );
    final below = [
      for (final row in markedRows)
        if (row.top > gapBottom!) row,
    ];
    expect(below, isNotEmpty, reason: 'a marked row must sit below the range');
    return below.first;
  }

  /// Jumps down (without earning intent) until a released range sits in the
  /// lower half of the viewport.
  Future<void> bringRangeToLowerHalf() async {
    final position = this.position;
    final rect = tester.getRect(transcriptList);
    for (var step = 0; step < 400; step++) {
      for (final element in releasedRanges.evaluate()) {
        final box = element.renderObject;
        if (box is! RenderBox || !box.attached || !box.hasSize) continue;
        final top = box.localToGlobal(Offset.zero).dy;
        if (top > rect.top + rect.height / 2 && top < rect.bottom - 8) return;
      }
      position.jumpTo(position.pixels + position.viewportDimension / 4);
      await tester.pump();
    }
    fail('no released range came into the lower half');
  }

  /// The screen top of the first released range on or below the top of the
  /// viewport, or null.
  double? get firstRangeTop {
    final rect = tester.getRect(transcriptList);
    double? best;
    for (final element in releasedRanges.evaluate()) {
      final box = element.renderObject;
      if (box is! RenderBox || !box.attached || !box.hasSize) continue;
      final top = box.localToGlobal(Offset.zero).dy;
      if (top < rect.top) continue;
      if (best == null || top < best) best = top;
    }
    return best;
  }

  /// Throws the transcript toward its start with a touch that moves [distance]
  /// at [speed] pixels per second, in 4 px samples, and lifts.
  Future<void> throwToStart(double distance, double speed) async {
    const step = 4.0;
    final gesture = await tester.createGesture();
    await gesture.down(tester.getCenter(transcriptList));
    final interval = Duration(microseconds: (step / speed * 1e6).round());
    var time = Duration.zero;
    for (var moved = 0.0; moved < distance; moved += step) {
      time += interval;
      await gesture.moveBy(const Offset(0, step), timeStamp: time);
    }
    await gesture.up(timeStamp: time);
  }

  /// Presses Alt+PageUp or PageUp (page up) [times] times.
  Future<void> pageKey(
    LogicalKeyboardKey key, {
    int times = 1,
    bool alt = false,
  }) async {
    if (alt) await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
    for (var i = 0; i < times; i++) {
      await tester.sendKeyEvent(key);
      await tester.pump();
    }
    if (alt) await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
  }

  /// Hides tool calls from the View menu: only what was said is drawn.
  Future<void> hideToolCalls() async {
    await _setToolCallsHidden(true);
  }

  /// Shows the tool calls [hideToolCalls] hid.
  Future<void> showToolCalls() async {
    await _setToolCallsHidden(false);
  }

  Future<void> _setToolCallsHidden(bool hidden) async {
    await tapKey('session-detail-view-menu');
    final toggle = find.byKey(const Key('session-tool-visibility-toggle'));
    if (toggle.evaluate().isNotEmpty) {
      final checked = tester
          .widget<CheckedPopupMenuItem<dynamic>>(toggle)
          .checked;
      if (checked != hidden) {
        await tap(toggle);
      } else {
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await settle();
      }
      return;
    }
    await tapKey('session-tool-visibility');
    await tap(find.text(hidden ? 'Hide tool calls' : 'Show tool calls').last);
  }
}

/// A session of [total] durable rows, opened in the real App on its newest
/// page.
///
/// [configure] runs before the app launches (latency, holding, failures).
/// Returns the app and the broker that pages the history.
Future<(AppDriver, FixturePagingBroker)> openPaging(
  FeatureContext f, {
  int total = 2000,
  PagingRow row = markedRow,
  FeatureViewport viewport = FeatureViewport.desktop,
  Duration latency = Duration.zero,
  bool newerHistory = true,
  int? pageRows,
  String id = 's1',
  String? textScale,
  bool deepLink = false,
  void Function(FixturePagingBroker broker)? configure,
}) async {
  late FixturePagingBroker paging;
  final app = await openTranscript(
    f,
    const [],
    id: id,
    viewport: viewport,
    textScale: textScale,
    deepLink: deepLink,
    setup: (server) {
      paging = FixturePagingBroker(
        server,
        id: id,
        total: total,
        row: row,
        now: () => f.tester.binding.clock.now(),
        newerHistory: newerHistory,
        latency: latency,
      )..pageRows = pageRows;
      configure?.call(paging);
    },
  );
  return (app, paging);
}

/// Launches the App on the roster with session [id] holding [messages] as its
/// history, without opening it. [broker] defaults to a fresh one.
Future<(AppDriver, FakeBroker)> launchWithTranscript(
  FeatureContext f,
  List<Map<String, Object?>> messages, {
  String id = 's1',
  String tool = 'codex',
  FeatureViewport viewport = FeatureViewport.desktop,
  double? textScale,
  FakeBroker? broker,
  void Function(FakeBroker broker)? setup,
}) async {
  final studio = broker ?? f.network.add('http://studio.test:7734');
  if (!studio.sessions.any((s) => s['id'] == id)) {
    studio.addSession(id, 'Fix login', tool: tool, cwd: '/work/studio');
  }
  studio.transcripts[id] = messages;
  setup?.call(studio);
  if (textScale != null) {
    f.tester.platformDispatcher.textScaleFactorTestValue = textScale;
    addTearDown(f.tester.platformDispatcher.clearTextScaleFactorTestValue);
  }
  await f.storage.seedServer(studio);
  final app = await f.launch(viewport: viewport);
  return (app, studio);
}

/// Opens session [id] by route and checks every frame of the open: a frame
/// either shows the bootstrap loading treatment or the settled tail (the
/// newest row fully on screen), the list never moves up between visible
/// frames, and the transcript does become visible.
///
/// [anyRow] matches a row of the transcript, [newestRow] its newest row.
Future<void> expectTailReveal(
  AppDriver app, {
  required Finder anyRow,
  required Finder newestRow,
  String tool = 'codex',
  String id = 's1',
  int frames = 30,
  Future<void> Function(int frame)? atFrame,
  Finder Function(int frame)? newestAt,
}) async {
  final tester = app.tester;
  final gate = find.byKey(const Key('session-transcript-tail-reveal-gate'));
  final loading = find.byKey(const Key('session-detail-bootstrap-blocking'));
  final trace = <String>[];
  final violations = <String>[];
  var sawVisibleContent = false;
  double? lastVisiblePixels;
  double? lastVisibleMax;

  app.router.go('/sessions/$tool/$id');
  for (var frame = 0; frame < frames; frame++) {
    await atFrame?.call(frame);
    await app.flushRealAsync();
    await tester.pump();
    final loadingVisible = loading.evaluate().isNotEmpty;
    if (transcriptList.evaluate().isEmpty) {
      trace.add('frame $frame: no transcript yet (loading=$loadingVisible)');
      continue;
    }
    // While the reveal gate hides the list the rows exist but are not
    // painted; only ungated frames count as visible content.
    final hidden =
        gate.evaluate().isNotEmpty && tester.widget<Offstage>(gate).offstage;
    final contentVisible = !hidden && anyRow.evaluate().isNotEmpty;
    if (!hidden && !contentVisible) {
      // Another session's transcript is still on screen (a workspace keeps
      // the open session while the route changes): not this open's frame.
      trace.add('frame $frame: another transcript is showing');
      continue;
    }
    final position = app.position;
    var newestFullyVisible = false;
    final newest = newestAt?.call(frame) ?? newestRow;
    if (newest.evaluate().isNotEmpty) {
      final viewport = tester.getRect(transcriptList);
      final rowRect = tester.getRect(newest);
      newestFullyVisible =
          rowRect.top >= viewport.top - 0.5 &&
          rowRect.bottom <= viewport.bottom + 0.5;
    }
    trace.add(
      'frame $frame: visible=$contentVisible pixels=${position.pixels} '
      'maxExtent=${position.maxScrollExtent} newestAtTail=$newestFullyVisible '
      'loading=$loadingVisible',
    );
    if (!contentVisible) {
      if (!loadingVisible) {
        violations.add(
          'frame $frame: transcript hidden but the loading treatment is '
          'absent (blank region)',
        );
      }
      // A hidden break starts a new settle generation.
      lastVisiblePixels = null;
      lastVisibleMax = null;
      continue;
    }
    sawVisibleContent = true;
    final atTail =
        newestFullyVisible && position.pixels >= position.maxScrollExtent - 4;
    if (!atTail) {
      violations.add(
        'frame $frame: visible content is not the settled tail '
        '(pixels=${position.pixels}, maxExtent=${position.maxScrollExtent}, '
        'newestAtTail=$newestFullyVisible)',
      );
    }
    final previous = lastVisiblePixels;
    // A list that got shorter (a replacement) moves its own tail up; only a
    // list that did not shrink may not move up.
    final shrank =
        lastVisibleMax != null && position.maxScrollExtent < lastVisibleMax - 1;
    if (previous != null && !shrank && position.pixels < previous - 1) {
      violations.add(
        'frame $frame: corrective upward motion across visible frames '
        '($previous -> ${position.pixels})',
      );
    }
    lastVisiblePixels = position.pixels;
    lastVisibleMax = position.maxScrollExtent;
  }
  expect(
    sawVisibleContent,
    isTrue,
    reason:
        'the transcript must become visible during the trace\n'
        'frame trace:\n${trace.join('\n')}',
  );
  expect(
    violations,
    isEmpty,
    reason: '${violations.join('\n')}\nframe trace:\n${trace.join('\n')}',
  );
}

/// Where the transcript's ACTUAL last row sits, and whether it is even mounted.
///
/// `pixels == maxScrollExtent` is not the invariant a following reader needs: a
/// lazy list reports the extent it has estimated. This reads the sliver's own
/// last child instead: its index (so it is the last item, not merely the last
/// one laid out) and its painted rectangle in viewport coordinates.
({int index, int itemCount, double top, double bottom, double viewportBottom})
tailRowGeometry(WidgetTester tester) {
  final scrollView = tester.widget<CustomScrollView>(transcriptList);
  final itemCount = scrollView.semanticChildCount ?? 0;
  // The transcript is centered: the rows before the center are one list, laid
  // out upward, and the center row onward is the other. The tail is the last
  // child of the second, whose index counts from the center.
  final lists = find.descendant(
    of: transcriptList,
    matching: find.byType(SliverList, skipOffstage: false),
    skipOffstage: false,
  );
  final rowsBefore = tester.widget<SliverList>(lists.first);
  final centerIndex = rowsBefore.delegate.estimatedChildCount ?? 0;
  final sliver = tester.renderObject<RenderSliverMultiBoxAdaptor>(lists.last);
  final last = sliver.lastChild;
  if (last == null) {
    return (
      index: -1,
      itemCount: itemCount,
      top: double.nan,
      bottom: double.nan,
      viewportBottom: double.nan,
    );
  }
  final viewportTop = tester.getTopLeft(transcriptList).dy;
  final viewport = tester.getRect(transcriptList);
  final parentData = last.parentData! as SliverMultiBoxAdaptorParentData;
  final topLeft = last.localToGlobal(Offset.zero);
  return (
    index: parentData.index == null ? -1 : centerIndex + parentData.index!,
    itemCount: itemCount,
    top: topLeft.dy - viewportTop,
    bottom: topLeft.dy + last.size.height - viewportTop,
    viewportBottom: viewport.height,
  );
}

/// Asserts the real last row is mounted and fully inside the viewport.
void expectTailRowVisible(WidgetTester tester, {required String reason}) {
  final tail = tailRowGeometry(tester);
  expect(
    tail.index,
    tail.itemCount - 1,
    reason: 'the mounted tail must BE the last item: $reason',
  );
  expect(
    tail.bottom,
    lessThanOrEqualTo(tail.viewportBottom + 0.5),
    reason: 'the last row must not hang below the viewport: $reason',
  );
  expect(
    tail.bottom,
    greaterThan(0),
    reason: 'the last row must actually be on screen: $reason',
  );
}

/// Makes [studio]'s attach frames carry [liveRows] right after the history,
/// as a running session's stream does.
void attachWithLive(FakeBroker studio, List<Map<String, Object?>> liveRows) {
  studio.attachFrames = (socket, session) => [
    studio.helloFrame(),
    {
      'kind': 'session',
      'info': {...session, 'control': FakeBroker.drivingControl},
    },
    {
      'kind': 'history',
      'messages': studio.transcripts[session['id']] ?? const <Object?>[],
      'cursor': 'cursor-1',
    },
    for (var i = 0; i < liveRows.length; i++)
      {'kind': 'message', 'seq': 200 + i + 1, 'message': liveRows[i]},
  ];
}
