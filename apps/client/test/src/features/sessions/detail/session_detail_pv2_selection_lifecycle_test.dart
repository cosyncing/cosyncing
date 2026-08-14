import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

List<AgentMessage> _rows(int start, int count) => [
  for (var index = start; index < start + count; index++)
    AgentMessage(
      id: 'pv2-lifecycle-$index',
      type: AgentMessageType.userMessage,
      raw: {
        'type': 'user-message',
        'text': 'PV2 lifecycle row $index',
      },
    ),
];

Finder get _transcript => find.byKey(const Key('session-detail-chat-scroll'));

ScrollController _scrollController(WidgetTester tester) =>
    tester.widget<ListView>(_transcript).controller!;

Future<void> _selectAcross(
  WidgetTester tester,
  String startText,
  String endText,
) async {
  final start = tester.getTopLeft(find.text(startText)) + const Offset(2, 8);
  final end = tester.getBottomRight(find.text(endText)) - const Offset(2, 8);
  final gesture = await tester.startGesture(
    start,
    kind: PointerDeviceKind.mouse,
  );
  await gesture.moveTo(end);
  await gesture.up();
  await tester.pumpAndSettle();
}

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
        // framework clipboard path directly at the final assertion.
        // ignore: deprecated_member_use
        .copySelection(SelectionChangedCause.toolbar);
    await tester.pump();
    return text;
  }
}

final class _HistoryConnection extends ScriptedSessionDetailConnection
    implements SessionHistoryConnection {
  _HistoryConnection({required super.events});

  String? clientMessageId;
  String? cursor;

  @override
  void seedHistoryCursor(String cursor) {}

  @override
  Future<void> requestHistoryPage({
    required String cursor,
    int? limit,
    String? clientMessageId,
  }) async {
    this.cursor = cursor;
    this.clientMessageId = clientMessageId;
  }
}

void _expectRange(String? copied, String start, String end) {
  expect(copied, isNotNull);
  expect(copied, contains(start));
  expect(copied, contains(end));
  expect(copied!.indexOf(start), lessThan(copied.indexOf(end)));
}

void _expectLiveRange(
  WidgetTester tester,
  String start,
  String end,
) {
  for (final text in [start, end]) {
    final paragraphs = find.descendant(
      of: find.text(text, skipOffstage: false),
      matching: find.byType(RichText, skipOffstage: false),
      skipOffstage: false,
    );
    expect(paragraphs, findsOneWidget);
    expect(
      tester.renderObject<RenderParagraph>(paragraphs).selections,
      isNotEmpty,
    );
  }
}

void main() {
  testWidgets(
    'live range survives resume, touch, wheel, trackpad, and keyboard paging',
    (tester) async {
      useRoomyTestViewport(tester);
      final clipboard = _ClipboardRecorder();
      await clipboard.install(tester);
      final touchTheme = ThemeData(
        platform: TargetPlatform.android,
        useMaterial3: false,
        extensions: [themeSpecById(kDefaultThemeId).light],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          theme: touchTheme,
          events: [
            HistoryWireEvent(messages: _rows(1, 20), reset: true),
          ],
        ),
      );
      await tester.pumpAndSettle();
      tester.binding.handleAppLifecycleStateChanged(
        AppLifecycleState.resumed,
      );
      await tester.pump();

      const start = 'PV2 lifecycle row 18';
      const end = 'PV2 lifecycle row 19';
      await _selectAcross(tester, start, end);
      _expectLiveRange(tester, start, end);

      final transcriptRect = tester.getRect(_transcript);
      final touchScroll = await tester.startGesture(
        Offset(transcriptRect.right - 12, transcriptRect.center.dy),
      );
      await touchScroll.moveBy(const Offset(0, 80));
      await tester.pump();
      _expectLiveRange(tester, start, end);
      await touchScroll.up();
      await tester.pumpAndSettle();
      _expectLiveRange(tester, start, end);

      final position = tester.getCenter(_transcript);
      await tester.sendEventToBinding(
        PointerScrollEvent(
          position: position,
          scrollDelta: const Offset(0, -18),
        ),
      );
      await tester.pumpAndSettle();
      _expectLiveRange(tester, start, end);

      const trackpadPointer = 32;
      await tester.sendEventToBinding(
        PointerPanZoomStartEvent(
          pointer: trackpadPointer,
          position: position,
        ),
      );
      await tester.sendEventToBinding(
        PointerPanZoomUpdateEvent(
          pointer: trackpadPointer,
          position: position,
          pan: const Offset(0, 18),
          panDelta: const Offset(0, 18),
        ),
      );
      await tester.sendEventToBinding(
        PointerPanZoomEndEvent(
          pointer: trackpadPointer,
          position: position,
        ),
      );
      await tester.pumpAndSettle();
      _expectLiveRange(tester, start, end);

      await tester.sendKeyEvent(LogicalKeyboardKey.pageUp);
      await tester.pumpAndSettle();
      _expectRange(await clipboard.copyTranscript(tester), start, end);
    },
  );

  testWidgets('live range survives an H1 prepend and a streamed append', (
    tester,
  ) async {
    useRoomyTestViewport(tester);
    final clipboard = _ClipboardRecorder();
    await clipboard.install(tester);
    final connection = _HistoryConnection(
      events: [
        HistoryWireEvent(
          messages: _rows(11, 10),
          reset: true,
          cursor: 'tail',
          olderCursor: 'page-1',
          hasEarlier: true,
        ),
      ],
    );
    await tester.pumpWidget(
      buildSessionDetailTestPage(events: const [], connection: connection),
    );
    await tester.pumpAndSettle();
    _scrollController(tester).jumpTo(0);
    await tester.pumpAndSettle();

    const start = 'PV2 lifecycle row 11';
    const end = 'PV2 lifecycle row 12';
    await _selectAcross(tester, start, end);
    _expectLiveRange(tester, start, end);

    await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.pageUp);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
    await tester.pump();
    expect(connection.cursor, 'page-1');
    connection.emitEvent(
      HistoryPageWireEvent(
        messages: _rows(1, 10),
        cursor: 'history-start',
        hasMore: false,
        endOfHistory: true,
        clientMessageId: connection.clientMessageId,
      ),
    );
    await tester.pumpAndSettle();
    _expectLiveRange(tester, start, end);

    connection.emitEvent(
      MessageWireEvent(seq: 21, message: _rows(21, 1).single),
    );
    await tester.pumpAndSettle();
    _expectRange(await clipboard.copyTranscript(tester), start, end);
  });

  testWidgets('touch handle edge drag autoscrolls one transcript range', (
    tester,
  ) async {
    useRoomyTestViewport(tester);
    final clipboard = _ClipboardRecorder();
    await clipboard.install(tester);
    final androidTheme = ThemeData(
      platform: TargetPlatform.android,
      useMaterial3: false,
      extensions: [themeSpecById(kDefaultThemeId).light],
    );
    await tester.pumpWidget(
      buildSessionDetailTestPage(
        theme: androidTheme,
        events: [
          HistoryWireEvent(messages: _rows(1, 30), reset: true),
        ],
      ),
    );
    await tester.pumpAndSettle();
    final controller = _scrollController(tester)..jumpTo(0);
    await tester.pumpAndSettle();

    const first = 'PV2 lifecycle row 1';
    final transcriptRect = tester.getRect(_transcript);
    var initialLastVisibleRow = 1;
    for (var index = 1; index <= 30; index++) {
      final row = find.text(
        'PV2 lifecycle row $index',
        skipOffstage: false,
      );
      if (row.evaluate().isEmpty) continue;
      final center = tester.getCenter(row);
      if (transcriptRect.contains(center)) {
        initialLastVisibleRow = index;
      }
    }
    expect(initialLastVisibleRow, lessThan(30));
    final later = 'PV2 lifecycle row ${initialLastVisibleRow + 1}';

    await tester.longPress(find.text(first));
    await tester.pumpAndSettle();
    final paragraph = tester.renderObject<RenderParagraph>(
      find.descendant(
        of: find.text(first),
        matching: find.byType(RichText),
      ),
    );
    expect(paragraph.selections, isNotEmpty);
    final box = paragraph
        .getBoxesForSelection(paragraph.selections.single)
        .single
        .toRect();
    final handle = paragraph.localToGlobal(box.bottomRight);
    final gesture = await tester.startGesture(handle);
    addTearDown(gesture.removePointer);
    await gesture.moveTo(
      tester.getBottomRight(_transcript) + const Offset(0, 40),
    );
    await tester.pump();
    await tester.pump(const Duration(seconds: 1));
    expect(controller.offset, greaterThan(0));
    await gesture.up();
    await tester.pump();
    _expectRange(await clipboard.copyTranscript(tester), first, later);
  });

  testWidgets('H1 eviction may end a range without pinning its payload', (
    tester,
  ) async {
    useRoomyTestViewport(tester);
    final clipboard = _ClipboardRecorder();
    await clipboard.install(tester);
    final connection = ScriptedSessionDetailConnection(
      events: [
        HistoryWireEvent(messages: _rows(1, 100), reset: true),
      ],
    );
    await tester.pumpWidget(
      buildSessionDetailTestPage(events: const [], connection: connection),
    );
    await tester.pumpAndSettle();
    _scrollController(tester).jumpTo(0);
    await tester.pumpAndSettle();

    await _selectAcross(
      tester,
      'PV2 lifecycle row 1',
      'PV2 lifecycle row 2',
    );
    _expectLiveRange(
      tester,
      'PV2 lifecycle row 1',
      'PV2 lifecycle row 2',
    );

    connection
      ..emitEvent(
        MessageWireEvent(seq: 101, message: _rows(101, 1).single),
      )
      ..emitEvent(
        MessageWireEvent(seq: 102, message: _rows(102, 1).single),
      );
    await tester.pumpAndSettle();

    expect(
      find.text('PV2 lifecycle row 1', skipOffstage: false),
      findsNothing,
    );
    expect(
      find.text('PV2 lifecycle row 2', skipOffstage: false),
      findsNothing,
    );
    expect(
      find.byKey(const Key('session-selection-retained')),
      findsNothing,
    );
    expect(await clipboard.copyTranscript(tester), anyOf(isNull, isEmpty));
  });
}
