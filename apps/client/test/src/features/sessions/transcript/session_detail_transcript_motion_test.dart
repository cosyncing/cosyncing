// Stable motion: what the reader is looking at stays where it is while the
// transcript changes around it.
//
// The real session page and controller run over a fake broker that pages a
// long durable history in both directions, so older pages land above the
// reader, newer pages fill released ranges below them, and the window's
// budget releases pages on the far side — all through the production paths.
// Rows mix prose, markdown with tables, code, tool calls with their results,
// approvals, images and an oversized body, so rows have genuinely different
// heights.
//
// Every assertion measures the screen position of one row the reader can
// see: at rest it must not move by more than a logical pixel; under a finger
// it must be exactly where the finger put it; under a fling it must follow
// the same path the same fling takes over a list that did not change.
import 'dart:async';
import 'dart:math' as math;

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart'
    show
        DebugSemanticsDumpOrder,
        GrowthDirection,
        RenderSliverList,
        SemanticsNode;
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

const int _pageRows = 100;

const String _pixel =
    'data:image/png;base64,'
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42'
    'mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

String _paragraph(int index, int p) =>
    'Paragraph $p of row $index explains what the agent changed and why, '
    'with `inline code`, a plain word and '
    'enough words to wrap across several lines at any width.';

String _prose(int index, int paragraphs) => [
  for (var p = 0; p < paragraphs; p++) _paragraph(index, p),
].join('\n\n');

/// Durable row [index] of the session. Rows are built in tens, so a tool
/// call and its result (and an approval and its answer) never straddle a
/// page boundary.
AgentMessage _row(int index) {
  final raw = switch (index % 10) {
    0 => {
      'type': 'user-message',
      'key': 'u$index',
      'text': 'Row $index. Please look at part ${index ~/ 10}.',
    },
    1 => {
      'type': 'model-output',
      'key': 'm$index',
      'text': 'Row $index. ${_prose(index, 1 + index % 4)}',
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
          ? 'Row $index. ${_prose(index, 40)}'
          : 'Row $index. Done.',
      'final': true,
    },
  };
  return AgentMessage.fromJson(raw);
}

List<AgentMessage> _rows(int from, int to) => [
  for (var index = from; index < to; index++) _row(index),
];

/// A broker holding [total] durable rows, whose boundary `bN` sits before row
/// N. It opens on the newest page and answers every page request, older or
/// newer, after [latency] — or when [release] is called, while [holding].
final class _PagingBroker extends ScriptedSessionDetailConnection
    implements SessionHistoryConnection, SessionHistoryNavigationConnection {
  _PagingBroker({required this.total})
    : super(
        events: [
          HistoryWireEvent(
            messages: _rows(total - _pageRows, total),
            reset: true,
            cursor: 'r$total',
            olderCursor: 'b${total - _pageRows}',
            hasEarlier: true,
            endCursor: 'b$total',
            newerHistory: true,
          ),
        ],
      );

  final int total;
  Duration latency = Duration.zero;
  bool holding = false;
  final List<String> older = [];
  final List<({String cursor, String until})> newer = [];
  final List<HistoryPageWireEvent> _held = [];

  int get requests => older.length + newer.length;

  /// Pages answered after [latency] that have not arrived yet.
  int inFlight = 0;

  bool get hasHeld => _held.isNotEmpty;

  /// Delivers every held page.
  void release() {
    final pages = List.of(_held);
    _held.clear();
    for (final page in pages) {
      emitEvent(page);
    }
  }

  @override
  void seedHistoryCursor(String cursor) {}

  @override
  Future<void> requestHistoryPage({
    required String cursor,
    int? limit,
    String? clientMessageId,
  }) async {
    older.add(cursor);
    final end = int.parse(cursor.substring(1));
    final start = math.max(0, end - (limit ?? _pageRows));
    _answer(
      HistoryPageWireEvent(
        messages: _rows(start, end),
        cursor: start > 0 ? 'b$start' : null,
        hasMore: start > 0,
        endOfHistory: start == 0,
        clientMessageId: clientMessageId,
      ),
    );
  }

  @override
  Future<void> requestNewerHistoryPage({
    required String cursor,
    String? until,
    int? limit,
    String? clientMessageId,
  }) async {
    newer.add((cursor: cursor, until: until!));
    final start = int.parse(cursor.substring(1));
    final stop = int.parse(until.substring(1));
    final end = math.min(stop, start + (limit ?? _pageRows));
    _answer(
      HistoryPageWireEvent(
        messages: _rows(start, end),
        cursor: end == stop ? until : 'b$end',
        hasMore: end < stop,
        endOfHistory: false,
        isNewer: true,
        clientMessageId: clientMessageId,
      ),
    );
  }

  void _answer(HistoryPageWireEvent page) {
    if (holding) {
      _held.add(page);
    } else if (latency == Duration.zero) {
      emitEvent(page);
    } else {
      inFlight += 1;
      Timer(latency, () {
        inFlight -= 1;
        emitEvent(page);
      });
    }
  }

  @override
  Future<bool> requestHistoryRefresh({
    required String cursor,
    required String clientMessageId,
    int? limit,
  }) async => false;

  @override
  Future<void> restartAttach() async {}
}

Finder get _transcript => find.byKey(const Key('session-detail-chat-scroll'));

ScrollPosition _position(WidgetTester tester) {
  final scrollable = tester.widget<Scrollable>(
    find.descendant(of: _transcript, matching: find.byType(Scrollable)).first,
  );
  return scrollable.controller!.position;
}

final RegExp _marker = RegExp(r'Row (\d+)\.');

/// Every marked row that intersects the viewport, by where its marked text
/// starts (above the viewport for a row taller than it), top first.
List<({int index, double top})> _markedRows(WidgetTester tester) {
  final tops = <int, double>{};
  // Onstage only: a kept-alive row off screen keeps a stale position.
  for (final element
      in find
          .descendant(of: _transcript, matching: find.byType(RichText))
          .evaluate()) {
    final match = _marker.firstMatch(
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
  final rows = [
    for (final entry in tops.entries) (index: entry.key, top: entry.value),
  ]..sort((a, b) => a.top.compareTo(b.top));
  return rows;
}

/// Where row [index]'s marked text is, or null when the row is not on screen.
double? _topOf(WidgetTester tester, int index) {
  for (final row in _markedRows(tester)) {
    if (row.index == index) return row.top;
  }
  return null;
}

/// The row the reader is reading: the first marked row whose text starts on
/// screen, or else the row above that fills the top of the viewport.
({int index, double top}) _reading(WidgetTester tester) {
  final rect = tester.getRect(_transcript);
  final rows = _markedRows(tester);
  expect(rows, isNotEmpty, reason: 'some marked row must be on screen');
  for (final row in rows) {
    if (row.top >= rect.top) return row;
  }
  return rows.last;
}

Future<void> _pumpFrames(WidgetTester tester, [int frames = 30]) async {
  for (var frame = 0; frame < frames; frame++) {
    await tester.pump(const Duration(milliseconds: 16));
  }
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

Future<_PagingBroker> _open(WidgetTester tester, {int total = 2000}) async {
  useRoomyTestViewport(tester);
  final broker = _PagingBroker(total: total);
  await tester.pumpWidget(
    buildSessionDetailTestPage(events: const [], connection: broker),
  );
  await tester.pumpAndSettle();
  return broker;
}

/// Moves (without earning intent) to [fraction] of a viewport below the
/// start of what is loaded, then wheels up once, which asks for the page
/// above.
Future<void> _askForEarlier(
  WidgetTester tester, {
  double fraction = 0.6,
}) async {
  await _jumpToStart(tester);
  final position = _position(tester);
  position.jumpTo(
    position.minScrollExtent + position.viewportDimension * fraction,
  );
  await tester.pump();
  await _wheel(tester, -40);
}

final Finder _gapRows = find.byWidgetPredicate((widget) {
  final key = widget.key;
  return key is ValueKey<String> &&
      key.value.startsWith('history-gap-') &&
      !key.value.endsWith('-reload');
}, skipOffstage: false);

/// Moves down (without earning intent) until a released range sits in the
/// lower half of the viewport, then wheels down once, which asks for the
/// newer page that fills it. Returns the row being read once the request is
/// in flight, or null when nothing below is released.
Future<({int index, double top})?> _askForNewer(
  WidgetTester tester,
  _PagingBroker broker,
) async {
  final position = _position(tester);
  final rect = tester.getRect(_transcript);
  final requests = broker.newer.length;
  for (var step = 0; step < 400; step++) {
    double? gapTop;
    for (final element in _gapRows.evaluate()) {
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
  await _wheel(tester, 40);
  if (broker.newer.length == requests) return null;
  await _pumpFrames(tester, 3);
  // The rows the page brings land at the range, below the reader; the row
  // measured is the last one above it, which may start above the viewport.
  final gapTop = _gapTop(tester);
  expect(gapTop, isNotNull, reason: 'the range being filled must be built');
  final above = [
    for (final row in _markedRows(tester))
      if (row.top < gapTop!) row,
  ];
  expect(above, isNotEmpty, reason: 'a marked row must sit above the range');
  return above.last;
}

/// Moves up (without earning intent) until a released range sits in the
/// upper half of the viewport, then wheels up once, which asks for the page
/// that fills it from its newer edge. Returns the row being read once the
/// request is in flight — the first marked row below the range — or null
/// when nothing above is released.
Future<({int index, double top})?> _askForGapAbove(
  WidgetTester tester,
  _PagingBroker broker,
) async {
  final position = _position(tester);
  final rect = tester.getRect(_transcript);
  final requests = broker.older.length;
  RenderBox? found;
  for (var step = 0; step < 400 && found == null; step++) {
    for (final element in _gapRows.evaluate()) {
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
  // starts on screen above it as well as the rows below: the reader moving up
  // into the range is reading below it.
  final lowerEdge = found.localToGlobal(Offset(0, found.size.height)).dy;
  position.jumpTo(
    position.pixels + lowerEdge - (rect.top + rect.height * 0.45),
  );
  await tester.pump();
  final upperEdge = found.localToGlobal(Offset.zero).dy;
  expect(
    _markedRows(tester).any(
      (row) => row.top >= rect.top && row.top < upperEdge,
    ),
    isTrue,
    reason: 'a row must start on screen above the range',
  );
  await _wheel(tester, -40);
  if (broker.older.length == requests) return null;
  await _pumpFrames(tester, 3);
  double? gapBottom;
  for (final element in _gapRows.evaluate()) {
    final box = element.renderObject;
    if (box is! RenderBox || !box.attached || !box.hasSize) continue;
    final bottom = box.localToGlobal(Offset(0, box.size.height)).dy;
    if (bottom > rect.bottom) continue;
    if (gapBottom == null || bottom > gapBottom) gapBottom = bottom;
  }
  expect(gapBottom, isNotNull, reason: 'the range being filled must be built');
  final below = [
    for (final row in _markedRows(tester))
      if (row.top > gapBottom!) row,
  ];
  expect(below, isNotEmpty, reason: 'a marked row must sit below the range');
  return below.first;
}

/// The screen top of the first released range on or below the viewport's
/// middle, or null.
double? _gapTop(WidgetTester tester) {
  final rect = tester.getRect(_transcript);
  double? best;
  for (final element in _gapRows.evaluate()) {
    final box = element.renderObject;
    if (box is! RenderBox || !box.attached || !box.hasSize) continue;
    final top = box.localToGlobal(Offset.zero).dy;
    if (top < rect.top) continue;
    if (best == null || top < best) best = top;
  }
  return best;
}

/// Jumps to the start of what is loaded. The start is an estimate until the
/// rows there are laid out, so this repeats until it holds, as a reader
/// scrolling there would find it.
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

void _expectHeld(
  WidgetTester tester,
  ({int index, double top}) before, {
  required String when,
}) {
  final after = _topOf(tester, before.index);
  expect(after, isNotNull, reason: 'row ${before.index} left the screen $when');
  expect(
    after,
    moreOrLessEquals(before.top, epsilon: 1),
    reason: 'row ${before.index} moved $when',
  );
}

const String _loadingEarlier = 'Loading earlier messages…';
const String _loadingNewer = 'Loading newer messages…';

/// Brings [finder]'s widget on screen, [inset] below the top of the viewport,
/// searching down from the start.
Future<void> _bringToTop(
  WidgetTester tester,
  Finder finder, {
  double inset = 20,
}) async {
  final position = _position(tester);
  final rect = tester.getRect(_transcript);
  await _jumpToStart(tester);
  for (var step = 0; step < 400 && finder.evaluate().isEmpty; step++) {
    if (position.pixels >= position.maxScrollExtent) break;
    position.jumpTo(
      math.min(
        position.maxScrollExtent,
        position.pixels + position.viewportDimension / 2,
      ),
    );
    await tester.pump();
  }
  expect(finder, findsWidgets, reason: 'the row must be reachable');
  for (var attempt = 0; attempt < 4; attempt++) {
    final top = tester.getTopLeft(finder.first).dy;
    final delta = top - (rect.top + inset);
    if (delta.abs() < 0.5) break;
    position.jumpTo(
      (position.pixels + delta).clamp(
        position.minScrollExtent,
        position.maxScrollExtent,
      ),
    );
    await tester.pump();
  }
  await _pumpFrames(tester, 3);
}

/// The marked rows in the order a screen reader moves through them.
List<int> _rowsInReadingOrder(WidgetTester tester) {
  final order = <int>[];
  void visit(SemanticsNode node) {
    final match = _marker.firstMatch(node.label);
    if (match != null) order.add(int.parse(match.group(1)!));
    node
        .debugListChildrenInOrder(DebugSemanticsDumpOrder.traversalOrder)
        .forEach(visit);
  }

  visit(tester.getSemantics(_transcript));
  return order;
}

/// Where the semantics tree places each row, on screen: the union of every
/// node that names it.
Map<int, Rect> _semanticRowRects(WidgetTester tester) {
  final rects = <int, Rect>{};
  final mention = RegExp(r'[Rr]ow (\d+)');
  void visit(SemanticsNode node) {
    final match = mention.firstMatch(node.label);
    if (match != null) {
      var rect = node.rect;
      for (SemanticsNode? n = node; n != null; n = n.parent) {
        final transform = n.transform;
        if (transform != null) {
          rect = MatrixUtils.transformRect(transform, rect);
        }
      }
      final index = int.parse(match.group(1)!);
      rects[index] = rects[index]?.expandToInclude(rect) ?? rect;
    }
    node.visitChildren((child) {
      visit(child);
      return true;
    });
  }

  visit(tester.getSemantics(_transcript));
  return rects;
}

/// Throws the transcript toward its start with a touch that moves [distance]
/// at [speed] pixels per second, in 4 px samples, and lifts.
///
/// A velocity tracker keeps only its last 20 samples, and a drag is a fling
/// only when those span more than the touch slop. Few, coarse samples let a
/// movement shorter than one page of loading intent (40 px) still be a fling.
Future<void> _throw(WidgetTester tester, double distance, double speed) async {
  const step = 4.0;
  final gesture = await tester.createGesture();
  await gesture.down(tester.getCenter(_transcript));
  final interval = Duration(microseconds: (step / speed * 1e6).round());
  var time = Duration.zero;
  for (var moved = 0.0; moved < distance; moved += step) {
    time += interval;
    await gesture.moveBy(const Offset(0, step), timeStamp: time);
  }
  await gesture.up(timeStamp: time);
}

/// Every onstage marked row's screen top, by row.
Map<int, double> _frame(WidgetTester tester) => {
  for (final row in _markedRows(tester)) row.index: row.top,
};

final class _ClipboardRecorder {
  String? text;

  Future<void> install(WidgetTester tester) async {
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          text = (call.arguments as Map<Object?, Object?>)['text'] as String?;
        }
        return null;
      },
    );
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        null,
      ),
    );
  }

  Future<String?> copyTranscript(WidgetTester tester) async {
    text = null;
    final area = find.ancestor(
      of: _transcript,
      matching: find.byType(SelectionArea),
    );
    tester
        .state<SelectionAreaState>(area)
        .selectableRegion
        // No public test hook exposes exact selected content; exercise the
        // framework clipboard path directly.
        // ignore: deprecated_member_use
        .copySelection(SelectionChangedCause.toolbar);
    await tester.pump();
    return text;
  }
}

void main() {
  group('at rest', () {
    testWidgets('pages landing above and below, and pages released on either '
        'side, never move the row being read, across more than five pages '
        'and three changes of direction', (tester) async {
      final broker = await _open(tester);
      broker.holding = true;

      // Read back eight pages: each lands above the reader, and past the
      // budget the window releases pages between the reader and the tail.
      for (var page = 0; page < 8; page++) {
        await _askForEarlier(tester);
        expect(broker.older, hasLength(page + 1));
        await _pumpFrames(tester, 3);
        // The notice at the start may sit just above the viewport.
        expect(find.text(_loadingEarlier, skipOffstage: false), findsOneWidget);
        expect(find.text(_loadingNewer, skipOffstage: false), findsNothing);
        final before = _reading(tester);
        broker.release();
        await _pumpFrames(tester);
        _expectHeld(tester, before, when: 'as older page ${page + 1} landed');
      }

      // Turn around and read forward: the released range below fills with
      // newer pages, and past the budget the window releases pages above.
      for (var page = 0; page < 2; page++) {
        final before = await _askForNewer(tester, broker);
        expect(before, isNotNull, reason: 'a released range must lie below');
        expect(broker.newer, hasLength(page + 1));
        expect(
          find.descendant(of: _gapRows, matching: find.text(_loadingNewer)),
          findsOneWidget,
          reason: 'the range filling below the reader says so',
        );
        expect(find.text(_loadingEarlier, skipOffstage: false), findsNothing);
        broker.release();
        await _pumpFrames(tester);
        _expectHeld(tester, before!, when: 'as newer page ${page + 1} landed');
      }

      // From the newest rows, read back up into the rest of that range: it
      // fills from its newer edge, above the reader.
      final position = _position(tester);
      position.jumpTo(position.maxScrollExtent);
      await tester.pumpAndSettle();
      for (var page = 0; page < 2; page++) {
        final requests = broker.older.length;
        final before = await _askForGapAbove(tester, broker);
        expect(before, isNotNull, reason: 'a released range must lie above');
        expect(broker.older, hasLength(requests + 1));
        expect(
          find.descendant(of: _gapRows, matching: find.text(_loadingEarlier)),
          findsOneWidget,
          reason: 'the range filling above the reader says so',
        );
        expect(find.text(_loadingNewer, skipOffstage: false), findsNothing);
        broker.release();
        await _pumpFrames(tester);
        _expectHeld(tester, before!, when: 'as range page ${page + 1} landed');
      }

      // And once more from the start of what is loaded.
      for (var page = 0; page < 2; page++) {
        await _askForEarlier(tester);
        await _pumpFrames(tester, 3);
        final before = _reading(tester);
        broker.release();
        await _pumpFrames(tester);
        _expectHeld(tester, before, when: 'as leading page ${page + 1} landed');
      }
      expect(broker.requests, 14);
    });

    testWidgets('a row above the reader growing, and a reply streaming at the '
        'tail, move nothing the reader sees; a reader at the tail stays on it '
        'as the reply grows', (tester) async {
      useRoomyTestViewport(tester);
      const pendingCall = {
        'type': 'tool-call',
        'callId': 'c-pending',
        'name': 'edit',
        'toolClass': 'edit',
        'arguments': {'path': 'lib/pending.dart'},
      };
      final connection = ScriptedSessionDetailConnection(
        events: [
          HistoryWireEvent(
            messages: [
              ..._rows(0, 40),
              AgentMessage.fromJson(pendingCall),
              ..._rows(40, 200),
            ],
            reset: true,
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      // Read with the pending call a little above the viewport, still laid
      // out, so its growth is between the reader and the top of the list.
      await _bringToTop(
        tester,
        find.byKey(const ValueKey('tool-c-pending-details')),
      );
      final position = _position(tester);
      position.jumpTo(position.pixels + position.viewportDimension * 0.75);
      await _pumpFrames(tester, 5);
      expect(
        find.byKey(const ValueKey('tool-c-pending-details')),
        findsNothing,
        reason: 'the growing row must be off screen above the reader',
      );
      var before = _reading(tester);
      final diff = [
        '--- a/lib/pending.dart',
        '+++ b/lib/pending.dart',
        '@@ -1,1 +1,40 @@',
        for (var line = 0; line < 40; line++) '+line $line',
      ].join('\n');
      connection.emitEvent(
        MessageWireEvent(
          seq: 1000,
          message: AgentMessage.fromJson({
            'type': 'tool-result',
            'callId': 'c-pending',
            'name': 'edit',
            'toolClass': 'edit',
            'path': 'lib/pending.dart',
            'diff': diff,
            'additions': 40,
            'deletions': 1,
          }),
        ),
      );
      await _pumpFrames(tester);
      _expectHeld(tester, before, when: 'as a row above grew');

      // A reply streaming at the tail while the reader is up here.
      before = _reading(tester);
      for (var chunk = 1; chunk <= 6; chunk++) {
        connection.emitEvent(
          MessageWireEvent(
            seq: 1000 + chunk,
            message: AgentMessage.fromJson({
              'type': 'model-output',
              'key': 'streaming-reply',
              'text': 'Row 9000. ${_prose(9000, chunk * 2)}',
              'final': false,
            }),
          ),
        );
        await _pumpFrames(tester, 2);
        _expectHeld(tester, before, when: 'as the tail streamed');
      }

      // At the tail, the view follows the reply as it grows.
      position.jumpTo(position.maxScrollExtent);
      await tester.pumpAndSettle();
      for (var chunk = 7; chunk <= 12; chunk++) {
        connection.emitEvent(
          MessageWireEvent(
            seq: 1000 + chunk,
            message: AgentMessage.fromJson({
              'type': 'model-output',
              'key': 'streaming-reply',
              'text': 'Row 9000. ${_prose(9000, chunk * 2)}',
              'final': chunk == 12,
            }),
          ),
        );
        await tester.pump();
        expect(
          position.pixels,
          moreOrLessEquals(position.maxScrollExtent, epsilon: 1),
          reason: 'the tail stays pinned in the frame the reply grows',
        );
        await _pumpFrames(tester, 2);
      }
      final lastParagraph = find.textContaining(
        'Paragraph 23 of row 9000',
        findRichText: true,
      );
      expect(lastParagraph, findsWidgets);
      expect(
        tester.getBottomLeft(lastParagraph.last).dy,
        lessThanOrEqualTo(tester.getRect(_transcript).bottom + 1),
        reason: 'the end of the reply is on screen',
      );
    });

    testWidgets('a tool opened at the reader keeps its place, and opening '
        'every tool above the reader keeps the reader on their row', (
      tester,
    ) async {
      await _open(tester);
      final tool = find.byKey(const ValueKey('tool-c1934-details'));
      await _bringToTop(tester, tool, inset: 24);
      final toolTop = tester.getTopLeft(tool).dy;
      await tester.tap(tool);
      await _pumpFrames(tester);
      expect(
        tester.getTopLeft(tool).dy,
        moreOrLessEquals(toolTop, epsilon: 1),
        reason: 'the opened tool must not move',
      );

      // Every tool in the transcript opens at once, above the reader too.
      final position = _position(tester);
      position.jumpTo(position.pixels + position.viewportDimension * 2);
      await _pumpFrames(tester, 5);
      final before = _reading(tester);
      await toggleSessionDetailViewOption(tester, 'expand');
      await _pumpFrames(tester);
      _expectHeld(tester, before, when: 'as every tool above opened');
    });

    testWidgets('resizing the window and scaling the text keep the reader on '
        'the row, and the line, they were reading', (tester) async {
      await _open(tester);
      final rect = tester.getRect(_transcript);
      final row = find.textContaining('Row 1931.', findRichText: true);
      await _bringToTop(tester, row, inset: 12);
      var before = (index: 1931, top: tester.getTopLeft(row.first).dy);

      tester.view.physicalSize = const Size(900, 800);
      await _pumpFrames(tester);
      _expectHeld(tester, before, when: 'as the window narrowed');

      before = (index: 1931, top: _topOf(tester, 1931)!);
      tester.platformDispatcher.textScaleFactorTestValue = 1.3;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await _pumpFrames(tester);
      _expectHeld(tester, before, when: 'as the text grew');

      // Inside a row taller than the viewport, the reader keeps their line.
      tester.platformDispatcher.clearTextScaleFactorTestValue();
      tester.view.physicalSize = const Size(1280, 800);
      await _pumpFrames(tester);
      final tall = find.textContaining('Row 1949.', findRichText: true);
      await _bringToTop(tester, tall);
      final position = _position(tester);
      position.jumpTo(position.pixels + position.viewportDimension * 1.5);
      await _pumpFrames(tester, 3);
      int? lineAtTop() {
        final top = tester.getRect(_transcript).top;
        for (final element
            in find
                .descendant(of: _transcript, matching: find.byType(RichText))
                .evaluate()) {
          final text = (element.widget as RichText).text.toPlainText();
          final match = RegExp(r'Paragraph (\d+) of row 1949').firstMatch(text);
          if (match == null) continue;
          final box = element.renderObject! as RenderBox;
          final y = box.localToGlobal(Offset.zero).dy;
          if (y <= top + 24 && y + box.size.height >= top) {
            return int.parse(match.group(1)!);
          }
        }
        return null;
      }

      final line = lineAtTop();
      expect(line, isNotNull, reason: 'a paragraph must span the top');
      tester.view.physicalSize = const Size(700, 800);
      await _pumpFrames(tester);
      final after = lineAtTop();
      expect(after, isNotNull, reason: 'the tall row must still fill the top');
      expect(
        (after! - line!).abs(),
        lessThanOrEqualTo(1),
        reason: 'the paragraph at the top of the viewport stays there',
      );
      expect(rect.width, greaterThan(0));
    });

    testWidgets('a screen reader meets the rows in transcript order, including '
        'the rows a page brought above the reader', (tester) async {
      final semantics = tester.ensureSemantics();
      await _open(tester);
      await _askForEarlier(tester, fraction: 0.9);
      await _pumpFrames(tester);
      // The page landed above the center, and the reader is below the center
      // line, so every row above the center is laid out off screen.
      final above = tester.allRenderObjects
          .whereType<RenderSliverList>()
          .where(
            (sliver) =>
                sliver.constraints.growthDirection == GrowthDirection.reverse,
          )
          .single;
      expect(above.firstChild, isNotNull);
      expect(above.geometry!.visible, isFalse);

      final order = _rowsInReadingOrder(tester);
      expect(
        order.where((index) => index < 1900),
        isNotEmpty,
        reason: 'rows the page brought are in the semantics tree',
      );
      expect(order, [...order]..sort());
      expect(order.toSet(), hasLength(order.length));
      // And each row is where it is: a row ends above the next one starts,
      // on both sides of the center line.
      final rects = _semanticRowRects(tester);
      final rows = rects.keys.toList()..sort();
      for (var i = 1; i < rows.length; i++) {
        expect(
          rects[rows[i - 1]]!.bottom,
          lessThanOrEqualTo(rects[rows[i]]!.top + 1),
          reason: 'row ${rows[i - 1]} overlaps row ${rows[i]}',
        );
      }
      semantics.dispose();
    });
  });

  group('in motion', () {
    for (final latency in const [0, 100, 500]) {
      testWidgets('a page arriving $latency ms after the request, while the '
          'finger keeps moving, leaves every row where the finger puts it', (
        tester,
      ) async {
        final broker = await _open(tester)
          ..latency = Duration(milliseconds: latency);
        await _jumpToStart(tester);
        final position = _position(tester);
        // Just beyond the shortest prefetch distance (one viewport), so the
        // page is asked for a few frames into the drag, not on its first
        // move.
        position.jumpTo(
          position.minScrollExtent + position.viewportDimension * 1.05,
        );
        await _pumpFrames(tester, 3);

        final gesture = await tester.startGesture(
          tester.getCenter(_transcript),
        );
        // Past the touch slop, so every later move reaches the list.
        await gesture.moveBy(const Offset(0, 24));
        await tester.pump(const Duration(milliseconds: 16));
        await gesture.moveBy(const Offset(0, 4));
        await tester.pump(const Duration(milliseconds: 16));
        final start = _reading(tester);
        final loadedStart = position.minScrollExtent;
        var moved = 0.0;
        int? askedAt;
        int? landedAt;
        for (var frame = 0; frame < (latency + 400) ~/ 16; frame++) {
          await gesture.moveBy(const Offset(0, 4));
          moved += 4;
          await tester.pump(const Duration(milliseconds: 16));
          if (askedAt == null && broker.older.isNotEmpty) askedAt = frame;
          if (landedAt == null &&
              position.minScrollExtent <
                  loadedStart - position.viewportDimension) {
            landedAt = frame;
          }
          if (landedAt == null) {
            expect(
              broker.older.length,
              lessThanOrEqualTo(1),
              reason: 'one page in flight at a time',
            );
          }
          final top = _topOf(tester, start.index);
          expect(top, isNotNull, reason: 'row ${start.index} left the screen');
          expect(
            top,
            moreOrLessEquals(start.top + moved, epsilon: 1),
            reason: 'row ${start.index} left the finger at frame $frame',
          );
        }
        expect(broker.older.first, 'b1900', reason: 'the drag asked');
        expect(askedAt, isNotNull);
        expect(
          landedAt,
          isNotNull,
          reason: 'the page landed while the finger was moving',
        );
        expect(landedAt! - askedAt!, greaterThanOrEqualTo(latency ~/ 16 - 1));
        // Hold still, then lift: no fling, nothing moves, including when a
        // page the drag earned while the first was in flight lands.
        await tester.pump(const Duration(milliseconds: 200));
        await gesture.up();
        await tester.pumpAndSettle();
        for (var wait = 0; wait < 8 && broker.inFlight > 0; wait++) {
          await tester.pump(Duration(milliseconds: latency));
          await tester.pumpAndSettle();
        }
        expect(broker.inFlight, 0);
        expect(
          _topOf(tester, start.index),
          moreOrLessEquals(start.top + moved, epsilon: 1),
        );
      });
    }

    /// One fling toward the start from a viewport outside the loading
    /// threshold, thrown by a touch that moves 32 px, where a page of loading
    /// intent takes 40. When [land] the page arrives 100 ms after it is
    /// asked for, mid-fling; otherwise it never arrives. Returns the rows on
    /// screen at every frame, and the frame the page was asked for.
    Future<({List<Map<int, double>> frames, int? askedAt, bool askedMidFling})>
    fling(WidgetTester tester, {required bool land}) async {
      final broker = await _open(tester)
        ..holding = !land
        ..latency = const Duration(milliseconds: 100);
      await _jumpToStart(tester);
      final position = _position(tester);
      position.jumpTo(
        position.minScrollExtent + position.viewportDimension * 2,
      );
      await _pumpFrames(tester, 3);
      await _throw(tester, 32, 2400);
      final frames = <Map<int, double>>[];
      int? askedAt;
      var askedMidFling = false;
      for (var frame = 0; frame < 90; frame++) {
        await tester.pump(const Duration(milliseconds: 16));
        frames.add(_frame(tester));
        if (askedAt == null && broker.older.isNotEmpty) {
          askedAt = frame;
          askedMidFling = position.isScrollingNotifier.value;
        }
      }
      await tester.pumpAndSettle();
      for (var wait = 0; wait < 8 && broker.inFlight > 0; wait++) {
        await tester.pump(broker.latency);
        await tester.pumpAndSettle();
      }
      if (!land) broker.release();
      await tester.pumpAndSettle();
      return (frames: frames, askedAt: askedAt, askedMidFling: askedMidFling);
    }

    testWidgets('a fling earns the page it reaches, is not stopped when the '
        'page lands, and follows the path it takes over an unchanged list', (
      tester,
    ) async {
      final unchanged = await fling(tester, land: false);
      await tester.pumpWidget(const SizedBox());
      final landing = await fling(tester, land: true);

      expect(
        landing.askedAt,
        isNotNull,
        reason: 'the fling itself must earn the page',
      );
      expect(landing.askedMidFling, isTrue, reason: 'asked while flinging');
      expect(unchanged.askedAt, landing.askedAt);

      var compared = 0;
      var worst = 0.0;
      for (var frame = 0; frame < landing.frames.length; frame++) {
        final a = unchanged.frames[frame];
        final b = landing.frames[frame];
        for (final entry in a.entries) {
          final other = b[entry.key];
          if (other == null) continue;
          compared++;
          worst = math.max(worst, (other - entry.value).abs());
        }
      }
      expect(compared, greaterThan(200));
      expect(
        worst,
        lessThanOrEqualTo(1),
        reason: 'a page landing mid-fling must not bend its path',
      );
    });

    testWidgets('a fling under way when the text reflows is held in place and '
        'keeps going', (tester) async {
      await _open(tester);
      await _jumpToStart(tester);
      final position = _position(tester);
      position.jumpTo(
        position.minScrollExtent + position.viewportDimension * 4,
      );
      await _pumpFrames(tester, 3);
      // Toward the tail, well inside the loaded page, so nothing loads.
      await tester.flingFrom(
        tester.getCenter(_transcript),
        const Offset(0, -50),
        2400,
      );
      Future<List<double>> paces(int frames) async {
        final paces = <double>[];
        var previous = position.pixels;
        for (var frame = 0; frame < frames; frame++) {
          await tester.pump(const Duration(milliseconds: 16));
          paces.add(position.pixels - previous);
          previous = position.pixels;
        }
        return paces;
      }

      await _pumpFrames(tester, 4);
      final before = await paces(4);
      expect(before.last, greaterThan(10), reason: 'the fling is under way');

      // The reflow's frame holds the reader, which moves the offset by
      // however much the rows around them grew.
      final heldFrom = position.pixels;
      tester.platformDispatcher.textScaleFactorTestValue = 1.3;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await tester.pump(const Duration(milliseconds: 16));
      expect(
        position.isScrollingNotifier.value,
        isTrue,
        reason: 'the hold that follows the reflow must not stop the fling',
      );
      expect(
        (position.pixels - heldFrom - before.last).abs(),
        greaterThan(20),
        reason: 'the reflow moved rows around the reader, and was held',
      );
      // From there the fling goes on at the pace it had, slowing as it did,
      // without jumping back to where it would have been without the hold.
      final after = await paces(4);
      expect(after.first, greaterThan(before.last / 2));
      expect(after.first, lessThanOrEqualTo(before.last + 2));
      for (var frame = 1; frame < after.length; frame++) {
        expect(after[frame], greaterThan(0));
        expect(after[frame], lessThanOrEqualTo(after[frame - 1] + 2));
      }
      await tester.pumpAndSettle();
    });

    testWidgets('a selection dragged against the top edge keeps its start and '
        'extends, without a hole, across a page that lands while it scrolls', (
      tester,
    ) async {
      final clipboard = _ClipboardRecorder();
      await clipboard.install(tester);
      final broker = await _open(tester);
      broker.holding = true;
      await _askForEarlier(tester, fraction: 0.9);
      expect(broker.older, hasLength(1));
      await _pumpFrames(tester, 3);

      final rect = tester.getRect(_transcript);
      final start = _markedRows(tester).firstWhere(
        (row) => row.top > rect.top + rect.height / 2,
      );
      final startText = find.textContaining(
        'Row ${start.index}.',
        findRichText: true,
      );
      // From the end of the start row's text, up past the top edge, which
      // scrolls the transcript up under the held selection.
      final gesture = await tester.startGesture(
        tester.getBottomRight(startText.first) - const Offset(4, 6),
        kind: PointerDeviceKind.mouse,
      );
      addTearDown(gesture.removePointer);
      await gesture.moveBy(const Offset(0, -40));
      await tester.pump();
      await gesture.moveTo(Offset(rect.center.dx, rect.top - 60));
      await _pumpFrames(tester, 10);
      final position = _position(tester);
      expect(
        position.isScrollingNotifier.value,
        isTrue,
        reason: 'the edge drag scrolls',
      );
      expect(broker.hasHeld, isTrue);
      broker.release();
      await _pumpFrames(tester, 20);
      // An edge scroll that ran into the old start stops there; the next
      // movement carries it on into the rows that landed.
      await gesture.moveBy(const Offset(0, -4));
      await _pumpFrames(tester, 120);
      await gesture.up();
      await tester.pumpAndSettle();

      final copied = await clipboard.copyTranscript(tester);
      expect(copied, isNotNull);
      // Rows copied whole, by the marker that opens them, and every row the
      // copy reaches into at all, by its marker or a paragraph's own mention.
      final whole = [
        for (final match in _marker.allMatches(copied!))
          int.parse(match.group(1)!),
      ];
      final reached = RegExp(r'[Rr]ow (\d+)')
          .allMatches(copied)
          .map((match) => int.parse(match.group(1)!))
          .reduce(math.min);
      expect(whole.last, start.index, reason: 'the start stayed put');
      expect(
        reached,
        lessThan(1900),
        reason: 'the selection reached into the page that landed',
      );
      expect(
        copied.indexOf('of row $reached'),
        lessThan(copied.indexOf('Row ${whole.first}.')),
        reason: 'the rows that landed come first in the copy',
      );
      // Every row from the first one the page brought to the start, that
      // carries a marker, is in the copy once and in transcript order.
      expect(whole.first, lessThanOrEqualTo(1900));
      expect(whole, [
        for (var index = whole.first; index <= start.index; index++)
          if (const {0, 1, 2, 3, 9}.contains(index % 10)) index,
      ]);
    });
  });

  test('the loading label that follows a newer page is localized', () async {
    for (final locale in const ['en', 'es', 'ja', 'ko', 'zh']) {
      final l10n = await AppLocalizations.delegate.load(Locale(locale));
      expect(l10n.sessionHistoryLoadingNewer, isNotEmpty, reason: locale);
      expect(
        l10n.sessionHistoryLoadingNewer,
        isNot(l10n.sessionHistoryLoadingEarlier),
        reason: locale,
      );
    }
  });
}
