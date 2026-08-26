import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/sessions/requests/session_request_action_helpers.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/rich_text_finder.dart';
import '../../../../support/session_detail_page_test_harness.dart';

final class _HistoryCapableScriptedConnection
    extends ScriptedSessionDetailConnection
    implements SessionHistoryConnection {
  _HistoryCapableScriptedConnection({
    required super.events,
    this.hold,
  });

  final Completer<void>? hold;
  String? lastHistoryPageCursor;
  int? lastHistoryPageLimit;
  String? lastHistoryPageClientMessageId;
  int historyPageRequestCount = 0;
  final List<String> historyPageCursors = [];

  @override
  void seedHistoryCursor(String cursor) {}

  @override
  Future<void> requestHistoryPage({
    required String cursor,
    int? limit,
    String? clientMessageId,
  }) async {
    historyPageRequestCount++;
    historyPageCursors.add(cursor);
    lastHistoryPageCursor = cursor;
    lastHistoryPageLimit = limit;
    lastHistoryPageClientMessageId = clientMessageId;
    if (hold != null) await hold!.future;
  }
}

final class _CountingDiffBodyLoader implements DiffBodyLoader {
  int attempts = 0;

  @override
  Future<String> load({
    required String url,
    required String contentHash,
    int? expectedBytes,
  }) async {
    attempts++;
    return '@@ -1 +1 @@\n-old\n+new';
  }
}

final class _GapPagingController extends SeededSessionDetailController {
  _GapPagingController(super.initialState);

  final List<String> requestedCursors = [];

  void failHistoryRequestRetryably() {
    state = state.copyWith(
      historyPageLoading: false,
      historyPageError: const LocalizedFailure.notice(
        FailureLead.loadEarlierHistory,
      ),
      historyPageErrorCode: 'HISTORY_PAGE_SOURCE_CHANGED',
    );
  }

  void completeHistoryRequest() {
    state = state.copyWith(
      historyPageLoading: false,
      clearHistoryPageError: true,
    );
  }

  @override
  Future<bool> loadEarlierHistory({
    int limit = kTranscriptHistoryPageMessages,
    String? cursor,
  }) async {
    if (cursor == null) return false;
    requestedCursors.add(cursor);
    state = state.copyWith(
      historyPageLoading: true,
      clearHistoryPageError: true,
    );
    return true;
  }
}

/// Builds [count] user messages, oldest first, matching the wire order the
/// broker sends.
List<WireEvent> _messages(int count, {int startSeq = 1}) {
  return [
    for (var i = 0; i < count; i++)
      MessageWireEvent(
        seq: startSeq + i,
        message: AgentMessage(
          type: AgentMessageType.userMessage,
          id: 'message-${startSeq + i}',
          raw: {'type': 'user-message', 'text': 'Message ${startSeq + i}'},
        ),
      ),
  ];
}

ScrollPosition _transcriptPosition(WidgetTester tester) {
  final scrollable = tester.widget<Scrollable>(
    find
        .descendant(
          of: find.byKey(const Key('session-detail-chat-scroll')),
          matching: find.byType(Scrollable),
        )
        .first,
  );
  return (scrollable.controller!).position;
}

double _transcriptViewportTop(WidgetTester tester) =>
    tester.getTopLeft(find.byKey(const Key('session-detail-chat-scroll'))).dy;

double _findInViewportTop(WidgetTester tester, Finder finder) =>
    tester.getTopLeft(finder).dy - _transcriptViewportTop(tester);

/// Where the transcript's ACTUAL last row sits, and whether it is even mounted.
///
/// `pixels == maxScrollExtent` is not the invariant U5b needs: a lazy list
/// reports the extent it has estimated, so that comparison held true in frames
/// where the real tail row was never built and nothing of it was on screen.
/// This reads the sliver's own last child instead — its index, so it is the
/// last item and not merely the last one that happened to be laid out, and its
/// painted rectangle in viewport coordinates.
({int index, int itemCount, double top, double bottom, double viewportBottom})
_tailRowGeometry(WidgetTester tester) {
  final listFinder = find.byKey(const Key('session-detail-chat-scroll'));
  final listView = tester.widget<ListView>(listFinder);
  final itemCount = listView.childrenDelegate.estimatedChildCount ?? 0;
  final sliver = tester.renderObject<RenderSliverMultiBoxAdaptor>(
    find.descendant(of: listFinder, matching: find.byType(SliverList)),
  );
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
  final viewportTop = _transcriptViewportTop(tester);
  final viewport = tester.getRect(listFinder);
  final parentData = last.parentData! as SliverMultiBoxAdaptorParentData;
  final topLeft = last.localToGlobal(Offset.zero);
  return (
    index: parentData.index ?? -1,
    itemCount: itemCount,
    top: topLeft.dy - viewportTop,
    bottom: topLeft.dy + last.size.height - viewportTop,
    viewportBottom: viewport.height,
  );
}

/// Asserts the real last row is mounted and fully inside the viewport.
void _expectTailRowVisible(WidgetTester tester, {required String reason}) {
  final tail = _tailRowGeometry(tester);
  expect(
    tail.index,
    tail.itemCount - 1,
    reason: 'the mounted tail must BE the last item — $reason',
  );
  expect(
    tail.bottom,
    lessThanOrEqualTo(tail.viewportBottom + 0.5),
    reason: 'the last row must not hang below the viewport — $reason',
  );
  expect(
    tail.bottom,
    greaterThan(0),
    reason: 'the last row must actually be on screen — $reason',
  );
}

void main() {
  group('SessionDetailPage transcript scroll position', () {
    testWidgets(
      'semantic viewport seed restores history before paint instead of tail',
      (tester) async {
        useRoomyTestViewport(tester);
        final messages = _variableHeightAgentMessages(120);
        final connection = ScriptedSessionDetailConnection(
          events: [
            HistoryWireEvent(messages: messages, reset: true, cursor: 'tail'),
          ],
        );

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            viewportSeed: const SessionViewportSeed(
              followTail: false,
              anchorMessageKey: 'user-message:id:variable-message-55',
              anchorViewportTop: 24,
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.textContaining('Variable-height message 55.'),
          findsOneWidget,
        );
        expect(
          find.textContaining('Variable-height message 120.'),
          findsNothing,
        );
        expect(
          _transcriptPosition(tester).pixels,
          lessThan(_transcriptPosition(tester).maxScrollExtent - 32),
          reason:
              'without semantic restoration the default U5 path settles tail',
        );
        expect(
          find.byKey(const Key('session-detail-bootstrap-blocking')),
          findsNothing,
          reason: 'the transcript only paints after anchor settlement',
        );

        // A reconnect replay can prepend and append around the anchor. The
        // mounted reader is hidden and restored against the same canonical row
        // rather than flashing the replacement tail.
        connection.emitEvent(
          HistoryWireEvent(
            messages: [
              ..._variableHeightAgentMessages(20, startSeq: -19),
              ...messages,
              ..._variableHeightAgentMessages(10, startSeq: 121),
            ],
            reset: true,
            cursor: 'replayed-tail',
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.textContaining('Variable-height message 55.'),
          findsOneWidget,
        );
        expect(
          find.textContaining('Variable-height message 130.'),
          findsNothing,
        );
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'initial open never pages and intentional upward gestures load one '
      '100-message page at a time through the true start',
      (tester) async {
        useRoomyTestViewport(tester);
        final diffLoader = _CountingDiffBodyLoader();
        final connection = _HistoryCapableScriptedConnection(
          events: [
            HistoryWireEvent(
              messages: _agentMessages(100, startSeq: 201),
              reset: true,
              cursor: 'tail',
              olderCursor: 'page-2',
              hasEarlier: true,
              truncated: const HistoryTruncation(shown: 100, total: 300),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            diffBodyLoader: diffLoader,
          ),
        );
        await tester.pumpAndSettle();

        expect(
          connection.historyPageRequestCount,
          0,
          reason: 'initial open/U5 tail settling must never page',
        );

        final position = _transcriptPosition(tester);
        position.jumpTo(position.viewportDimension + 40);
        await tester.pump();
        expect(
          connection.historyPageRequestCount,
          0,
          reason: 'programmatic transcript movement must never page',
        );

        await tester.drag(
          find.byKey(const Key('session-detail-chat-scroll')),
          const Offset(0, 120),
        );
        await tester.pump();
        expect(connection.historyPageRequestCount, 1);
        expect(connection.lastHistoryPageLimit, 100);
        expect(connection.historyPageCursors, ['page-2']);

        // Remaining in the threshold while the page is slow cannot duplicate
        // the in-flight cursor.
        await tester.drag(
          find.byKey(const Key('session-detail-chat-scroll')),
          const Offset(0, -20),
        );
        await tester.pump();
        expect(connection.historyPageRequestCount, 1);

        connection.emitEvent(
          HistoryPageWireEvent(
            messages: [
              AgentMessage.fromJson(const {
                'type': 'tool-result',
                'callId': 'older-lazy-diff',
                'toolName': 'edit',
                'toolClass': 'edit',
                'diffRef': {
                  'fetchUrl': 'https://invalid.example/diff',
                  'contentHash': 'older-diff-hash',
                  'byteSize': 120000,
                },
              }),
              ..._agentMessages(99, startSeq: 102),
            ],
            cursor: 'page-1',
            hasMore: true,
            endOfHistory: false,
            clientMessageId: connection.lastHistoryPageClientMessageId,
          ),
        );
        await tester.pumpAndSettle();

        final progressed = _transcriptPosition(tester);
        progressed.jumpTo(progressed.viewportDimension + 40);
        await tester.pump();
        await tester.drag(
          find.byKey(const Key('session-detail-chat-scroll')),
          const Offset(0, 120),
        );
        await tester.pump();
        expect(connection.historyPageRequestCount, 2);
        expect(connection.historyPageCursors, ['page-2', 'page-1']);

        connection.emitEvent(
          HistoryPageWireEvent(
            messages: _agentMessages(100),
            hasMore: false,
            endOfHistory: true,
            clientMessageId: connection.lastHistoryPageClientMessageId,
          ),
        );
        await tester.pumpAndSettle();

        _transcriptPosition(tester).jumpTo(0);
        await tester.pump();
        expect(
          find.byKey(const Key('session-history-start-marker')),
          findsOneWidget,
        );
        await tester.drag(
          find.byKey(const Key('session-detail-chat-scroll')),
          const Offset(0, 160),
        );
        await tester.pump();
        expect(
          connection.historyPageRequestCount,
          2,
          reason: 'authoritative start must permanently stop page requests',
        );

        final beforeJumpRequests = connection.historyPageRequestCount;
        expect(
          find.byKey(const Key('session-history-jump-latest')),
          findsOneWidget,
        );
        await tester.tap(
          find.byKey(const Key('session-history-jump-latest')),
        );
        await tester.pumpAndSettle();
        expect(
          _transcriptPosition(tester).pixels,
          monotonicallyCloseTo(_transcriptPosition(tester).maxScrollExtent),
        );
        expect(connection.historyPageRequestCount, beforeJumpRequests);
        expect(
          diffLoader.attempts,
          0,
          reason: 'paging must not fetch a referenced diff body',
        );
      },
    );

    testWidgets(
      'one mobile swipe credits three variable-height pages before any '
      'response',
      (tester) async {
        useRoomyTestViewport(tester);
        final connection = _HistoryCapableScriptedConnection(
          events: [
            HistoryWireEvent(
              messages: _agentMessages(100, startSeq: 301),
              reset: true,
              cursor: 'tail',
              olderCursor: 'page-3',
              hasEarlier: true,
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();
        _transcriptPosition(tester).jumpTo(0);
        await tester.pump();

        final surface = find.byKey(
          const Key('session-detail-chat-scroll'),
        );
        final gesture = await tester.startGesture(tester.getCenter(surface));
        // All physical intent arrives before page 3 returns. A single natural
        // swipe must retain enough bounded credit for three pages; requiring a
        // fresh move during every response reproduces the physical dead zone.
        await gesture.moveBy(const Offset(0, 140));
        await gesture.up();
        await tester.pump();
        expect(connection.historyPageCursors, ['page-3']);

        connection.emitEvent(
          HistoryPageWireEvent(
            messages: _variableHeightAgentMessages(100, startSeq: 201),
            cursor: 'page-2',
            hasMore: true,
            endOfHistory: false,
            clientMessageId: connection.lastHistoryPageClientMessageId,
          ),
        );
        for (
          var frame = 0;
          frame < 20 && connection.historyPageRequestCount < 2;
          frame++
        ) {
          await tester.pump(const Duration(milliseconds: 16));
        }
        expect(
          connection.historyPageCursors,
          ['page-3', 'page-2'],
          reason: 'the second credit survives page 3 and exact anchor restore',
        );

        connection.emitEvent(
          HistoryPageWireEvent(
            messages: _variableHeightAgentMessages(100, startSeq: 101),
            cursor: 'page-1',
            hasMore: true,
            endOfHistory: false,
            clientMessageId: connection.lastHistoryPageClientMessageId,
          ),
        );
        for (
          var frame = 0;
          frame < 80 && connection.historyPageRequestCount < 3;
          frame++
        ) {
          await tester.pump(const Duration(milliseconds: 16));
        }
        expect(
          connection.historyPageCursors,
          ['page-3', 'page-2', 'page-1'],
          reason: 'one completed swipe reaches three pages without later input',
        );

        // The physical budget is exhausted after the third page. Cursor
        // progress alone cannot recurse into page 0 while stationary.
        connection.emitEvent(
          HistoryPageWireEvent(
            messages: _variableHeightAgentMessages(100),
            cursor: 'page-0',
            hasMore: true,
            endOfHistory: false,
            clientMessageId: connection.lastHistoryPageClientMessageId,
          ),
        );
        await tester.pumpAndSettle();
        expect(
          connection.historyPageRequestCount,
          3,
          reason: 'stationary cursor/layout progress must not recurse',
        );
      },
    );

    testWidgets(
      'continued trackpad intent pages again without idle recursion',
      (tester) async {
        useRoomyTestViewport(tester);
        final connection = _HistoryCapableScriptedConnection(
          events: [
            HistoryWireEvent(
              messages: _agentMessages(100, startSeq: 201),
              reset: true,
              cursor: 'tail',
              olderCursor: 'page-2',
              hasEarlier: true,
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();
        _transcriptPosition(tester).jumpTo(0);
        await tester.pump();
        final position = tester.getCenter(
          find.byKey(const Key('session-detail-chat-scroll')),
        );

        const trackpadPointer = 41;
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
            pan: const Offset(0, 80),
            panDelta: const Offset(0, 80),
          ),
        );
        await tester.pump();
        expect(connection.historyPageCursors, ['page-2']);
        await tester.sendEventToBinding(
          PointerPanZoomUpdateEvent(
            pointer: trackpadPointer,
            position: position,
            pan: const Offset(0, 120),
            panDelta: const Offset(0, 40),
          ),
        );
        await tester.pump();
        expect(connection.historyPageRequestCount, 1);
        connection.emitEvent(
          HistoryPageWireEvent(
            messages: _agentMessages(5, startSeq: 196),
            cursor: 'page-1',
            hasMore: true,
            endOfHistory: false,
            clientMessageId: connection.lastHistoryPageClientMessageId,
          ),
        );
        for (
          var frame = 0;
          frame < 20 && connection.historyPageRequestCount < 2;
          frame++
        ) {
          await tester.pump(const Duration(milliseconds: 16));
        }
        expect(
          connection.historyPageCursors,
          ['page-2', 'page-1'],
          reason: 'continued trackpad input survives the prepend restore',
        );
        await tester.sendEventToBinding(
          PointerPanZoomEndEvent(
            pointer: trackpadPointer,
            position: position,
          ),
        );
        connection.emitEvent(
          HistoryPageWireEvent(
            messages: _agentMessages(5, startSeq: 191),
            cursor: 'page-0',
            hasMore: true,
            endOfHistory: false,
            clientMessageId: connection.lastHistoryPageClientMessageId,
          ),
        );
        for (
          var frame = 0;
          frame < 20 && connection.historyPageRequestCount < 3;
          frame++
        ) {
          await tester.pump(const Duration(milliseconds: 16));
        }
        expect(
          connection.historyPageCursors,
          ['page-2', 'page-1', 'page-0'],
          reason:
              'all three credits came from the 120px trackpad movement, '
              'not cursor progression',
        );
        connection.emitEvent(
          HistoryPageWireEvent(
            messages: _agentMessages(5, startSeq: 186),
            cursor: 'page-before-0',
            hasMore: true,
            endOfHistory: false,
            clientMessageId: connection.lastHistoryPageClientMessageId,
          ),
        );
        await tester.pumpAndSettle();
        expect(
          connection.historyPageRequestCount,
          3,
          reason: 'exhausted physical credit does not recurse while stationary',
        );
      },
    );

    testWidgets(
      'history start still permits approached and retried internal gaps but '
      'blocks the true leading edge',
      (tester) async {
        useRoomyTestViewport(tester);
        AgentMessage row(int index) => AgentMessage.fromJson({
          'type': 'model-output',
          'key': 'gap-$index',
          'text': 'Gap fixture row $index',
        });
        var window = TranscriptHistoryWindow.fromHistory(
          HistoryWireEvent(
            messages: [for (var i = 2400; i < 2500; i++) row(i)],
            reset: true,
            cursor: 'tail',
            olderCursor: 'cursor-24',
            hasEarlier: true,
          ),
        );
        for (var page = 23; page >= 16; page--) {
          final start = page * 100;
          final mutation = window.prependPage(
            HistoryPageWireEvent(
              messages: [
                for (var index = start; index < start + 100; index++)
                  row(index),
              ],
              cursor: 'cursor-$page',
              hasMore: true,
              endOfHistory: false,
            ),
            requestedCursor: 'cursor-${page + 1}',
            preserveMessageKey: stableTranscriptMessageKey(row(start + 100)),
          );
          expect(mutation.accepted, isTrue);
          window = mutation.window;
        }
        final gap = window.gaps.first;
        final initialState = SessionDetailState(
          tool: 'claude',
          sessionId: 'session-1',
          connectionStatus: SessionDetailConnectionStatus.connected,
          bootstrapState: const SessionDetailBootstrapState(
            readiness: SessionDetailBootstrapReadiness.ready,
            attempt: 1,
            hasCachedMessages: true,
          ),
          transcriptWindow: window,
          historyStartReached: true,
          transcriptResetGeneration: 1,
        );
        final controller = _GapPagingController(initialState);
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            seededController: controller,
          ),
        );
        await tester.pumpAndSettle();

        final gapFinder = find.byKey(Key(gap.id));
        final position = _transcriptPosition(tester);
        var found = false;
        for (
          var offset = 0.0;
          offset <= position.maxScrollExtent;
          offset += position.viewportDimension / 2
        ) {
          position.jumpTo(offset);
          await tester.pump();
          if (gapFinder.evaluate().isNotEmpty) {
            found = true;
            break;
          }
        }
        expect(found, isTrue, reason: 'the retained middle gap must render');
        expect(find.byKey(Key('${gap.id}-reload')), findsNothing);
        expect(controller.requestedCursors, isEmpty);

        await tester.sendEventToBinding(
          PointerScrollEvent(
            position: tester.getCenter(
              find.byKey(const Key('session-detail-chat-scroll')),
            ),
            scrollDelta: const Offset(0, -40),
          ),
        );
        await tester.pump();
        expect(controller.requestedCursors, [gap.reloadCursor]);

        controller.failHistoryRequestRetryably();
        await tester.pump();
        final gapRetry = find.byKey(Key('${gap.id}-reload'));
        expect(gapRetry, findsOneWidget);
        await tester.tap(gapRetry);
        await tester.pump();
        expect(
          controller.requestedCursors,
          [gap.reloadCursor, gap.reloadCursor],
          reason: 'Retry must target the internal gap after native start',
        );

        controller.completeHistoryRequest();
        await tester.pump();
        position.jumpTo(0);
        await tester.pump();
        await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
        await tester.sendKeyEvent(LogicalKeyboardKey.pageUp);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
        await tester.pump();
        expect(
          controller.requestedCursors,
          [gap.reloadCursor, gap.reloadCursor],
          reason: 'the true leading edge stays terminal after native start',
        );
      },
    );

    testWidgets(
      'offline threshold and reconnect alone do not page; keyboard fallback '
      'loads after renewed intent',
      (tester) async {
        useRoomyTestViewport(tester);
        final connection = _HistoryCapableScriptedConnection(
          events: [
            HistoryWireEvent(
              messages: _agentMessages(100, startSeq: 101),
              reset: true,
              cursor: 'tail',
              olderCursor: 'older',
              hasEarlier: true,
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        connection.emitState(SessionDetailConnectionStatus.reconnecting);
        await tester.pump();
        _transcriptPosition(tester).jumpTo(0);
        await tester.pump();
        await tester.drag(
          find.byKey(const Key('session-detail-chat-scroll')),
          const Offset(0, 120),
        );
        await tester.pump();
        expect(connection.historyPageRequestCount, 0);
        expect(
          find.text('Reconnect to load earlier messages.'),
          findsNothing,
          reason: 'ordinary offline history is not a non-reloadable cursor gap',
        );

        connection.emitState(SessionDetailConnectionStatus.connected);
        await tester.pump();
        expect(
          connection.historyPageRequestCount,
          0,
          reason: 'reconnect alone must not consume the retained cursor',
        );

        expect(
          find.byKey(const Key('session-history-load-earlier')),
          findsNothing,
          reason: 'healthy paging has no visible load button',
        );
        expect(
          tester
              .widget<SelectionArea>(
                find.byKey(const Key('session-history-shortcut-focus')),
              )
              .focusNode!
              .hasFocus,
          isTrue,
          reason: 'the production transcript must make its shortcut reachable',
        );
        await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
        await tester.sendKeyEvent(LogicalKeyboardKey.pageUp);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
        await tester.pump();
        expect(connection.historyPageRequestCount, 1);
        expect(connection.lastHistoryPageLimit, 100);
      },
    );

    testWidgets(
      'resource refusal is terminal, localized, and has no retry affordance',
      (tester) async {
        useRoomyTestViewport(tester);
        final connection = _HistoryCapableScriptedConnection(
          events: [
            HistoryWireEvent(
              messages: _agentMessages(100, startSeq: 101),
              reset: true,
              cursor: 'tail',
              olderCursor: 'older',
              hasEarlier: true,
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();
        _transcriptPosition(tester).jumpTo(0);
        await tester.pump();

        await tester.drag(
          find.byKey(const Key('session-detail-chat-scroll')),
          const Offset(0, 80),
        );
        await tester.pump();
        expect(connection.historyPageRequestCount, 1);
        connection.emitEvent(
          NackWireEvent(
            code: 'HISTORY_PAGE_RESOURCE_LIMIT',
            message: 'The bounded snapshot is too large.',
            clientMessageId: connection.lastHistoryPageClientMessageId,
          ),
        );
        await tester.pump();

        expect(
          find.text('This history is too large to page safely on this device.'),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('session-history-load-earlier')),
          findsNothing,
        );
        await tester.drag(
          find.byKey(const Key('session-detail-chat-scroll')),
          const Offset(0, 80),
        );
        await tester.pump();
        expect(connection.historyPageRequestCount, 1);
      },
    );

    testWidgets('ten Page Up and Page Down actions stay live without a mouse', (
      tester,
    ) async {
      final connection = _HistoryCapableScriptedConnection(
        events: [
          HistoryWireEvent(
            messages: _agentMessages(100, startSeq: 101),
            reset: true,
            cursor: 'tail',
            olderCursor: 'older',
            hasEarlier: true,
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      final position = _transcriptPosition(tester);
      final tail = position.pixels;
      for (var i = 0; i < 10; i++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.pageUp);
        await tester.pump();
      }
      final afterUp = position.pixels;
      expect(afterUp, lessThan(tail));
      expect(
        tester
            .widget<SelectionArea>(
              find.byKey(const Key('session-history-shortcut-focus')),
            )
            .focusNode!
            .hasFocus,
        isTrue,
      );

      for (var i = 0; i < 10; i++) {
        await tester.sendKeyEvent(LogicalKeyboardKey.pageDown);
        await tester.pump();
      }
      expect(position.pixels, greaterThan(afterUp));
      expect(
        tester
            .widget<SelectionArea>(
              find.byKey(const Key('session-history-shortcut-focus')),
            )
            .focusNode!
            .hasFocus,
        isTrue,
      );
    });

    testWidgets('Retry appears only after a retryable paging failure', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      final connection = _HistoryCapableScriptedConnection(
        events: [
          HistoryWireEvent(
            messages: _agentMessages(100, startSeq: 101),
            reset: true,
            cursor: 'tail',
            olderCursor: 'older',
            hasEarlier: true,
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      _transcriptPosition(tester).jumpTo(0);
      await tester.pump();
      expect(
        find.byKey(const Key('session-history-load-earlier')),
        findsNothing,
      );

      await tester.drag(
        find.byKey(const Key('session-detail-chat-scroll')),
        const Offset(0, 80),
      );
      await tester.pump();
      connection.emitEvent(
        NackWireEvent(
          code: 'HISTORY_PAGE_SOURCE_CHANGED',
          message: 'The source was still changing.',
          clientMessageId: connection.lastHistoryPageClientMessageId,
        ),
      );
      await tester.pump();

      final retry = find.byKey(
        const Key('session-history-load-earlier'),
      );
      expect(retry, findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);
      await tester.tap(retry);
      await tester.pump();
      expect(connection.historyPageRequestCount, 2);
      expect(connection.historyPageCursors, ['older', 'older']);
    });

    testWidgets(
      'healthy Compact dark history is chrome-free and loading is localized',
      (tester) async {
        _useViewport(tester, const Size(360, 760));
        final tokens = themeSpecById(kDefaultThemeId).dark;
        final connection = _HistoryCapableScriptedConnection(
          events: [
            HistoryWireEvent(
              messages: _agentMessages(20),
              reset: true,
              cursor: 'tail',
              olderCursor: 'older',
              hasEarlier: true,
              truncated: const HistoryTruncation(shown: 20, total: 120),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            locale: const Locale('zh'),
            theme: buildAppTheme(tokens, Brightness.dark),
          ),
        );
        await tester.pumpAndSettle();

        _transcriptPosition(tester).jumpTo(0);
        await tester.pump();
        expect(find.text('加载较早的消息'), findsNothing);
        expect(find.text('正在显示最新的 20/120 条消息。'), findsNothing);
        expect(
          find.byKey(const Key('session-history-recovery-notice')),
          findsOneWidget,
          reason: 'the silent slot keeps loading geometry position-stable',
        );
        await tester.drag(
          find.byKey(const Key('session-detail-chat-scroll')),
          const Offset(0, 80),
        );
        await tester.pump();
        expect(find.text('正在加载较早的消息…'), findsOneWidget);
        expect(
          find.byKey(const Key('session-history-recovery-notice')),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'healthy Roomy light history has no button and keeps keyboard access',
      (tester) async {
        useRoomyTestViewport(tester);
        final tokens = themeSpecById(kDefaultThemeId).light;
        final connection = _HistoryCapableScriptedConnection(
          events: [
            HistoryWireEvent(
              messages: _agentMessages(20),
              reset: true,
              cursor: 'tail',
              olderCursor: 'older',
              hasEarlier: true,
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            theme: buildAppTheme(tokens, Brightness.light),
          ),
        );
        await tester.pumpAndSettle();

        _transcriptPosition(tester).jumpTo(0);
        await tester.pump();
        expect(find.text('Load earlier messages'), findsNothing);
        await tester.drag(
          find.byKey(const Key('session-detail-chat-scroll')),
          const Offset(0, 80),
        );
        await tester.pump();
        expect(find.text('Loading earlier messages…'), findsOneWidget);
      },
    );

    testWidgets('lazy transcript construction only builds visible rows', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: _messages(240)),
      );
      await tester.pumpAndSettle();

      final position = _transcriptPosition(tester);
      expect(position.pixels, greaterThan(0));
      expect(find.text('Message 1'), findsNothing);
      expect(find.text('Message 240'), findsOneWidget);

      position.jumpTo(position.maxScrollExtent);
      await tester.pumpAndSettle();

      expect(find.text('Message 240'), findsOneWidget);
      position.jumpTo(0);
      await tester.pumpAndSettle();

      expect(
        find.text('Message 141'),
        findsOneWidget,
        reason: 'the active live tail retains only the newest 100 messages',
      );
    });

    testWidgets('entering a session lands on the newest message', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: _messages(60)),
      );
      await tester.pumpAndSettle();

      final position = _transcriptPosition(tester);
      // A transcript this long must actually overflow, or the assertion below
      // would pass trivially at offset 0.
      expect(position.maxScrollExtent, greaterThan(0));
      expect(position.pixels, monotonicallyCloseTo(position.maxScrollExtent));
    });

    testWidgets('messages streaming in after first layout keep the tail', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      final connection = ScriptedSessionDetailConnection(
        events: _messages(40),
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      final before = _transcriptPosition(tester).maxScrollExtent;

      // Arrive well after mount, the way live broker frames do.
      for (final event in _messages(20, startSeq: 100)) {
        connection.emitEvent(event);
      }
      await tester.pumpAndSettle();

      final position = _transcriptPosition(tester);
      expect(
        position.maxScrollExtent,
        greaterThan(before),
        reason: 'the streamed messages should have grown the transcript',
      );
      expect(position.pixels, monotonicallyCloseTo(position.maxScrollExtent));
    });

    for (final composerFocused in [false, true]) {
      final focusLabel = composerFocused ? 'focused' : 'unfocused';
      testWidgets(
        'every painted frame keeps the real last row on screen through a '
        'whole turn, composer $focusLabel (U5b frame trace)',
        (tester) async {
          useRoomyTestViewport(tester);
          final connection = ScriptedSessionDetailConnection(
            events: _messages(60),
          );
          await tester.pumpWidget(
            buildSessionDetailTestPage(
              events: const [],
              connection: connection,
            ),
          );
          await tester.pumpAndSettle();

          if (composerFocused) {
            // A focused composer grows and takes viewport height away from the
            // transcript. The tail invariant has to survive that, not just the
            // idle layout.
            await tester.tap(
              find.byKey(const Key('session-detail-prompt-input')),
            );
            await tester.pumpAndSettle();
            await tester.enterText(
              find.byKey(const Key('session-detail-prompt-input')),
              'a draft the user is typing while the answer streams in',
            );
            await tester.pumpAndSettle();
          }

          // One turn, frame by frame: optimistic prompt, streamed growth, a
          // tool row whose body changes height, the terminal footer metadata,
          // and the idle transition. A SINGLE pump per step is the point — the
          // old post-frame `jumpTo` ran after this frame had already painted at
          // the pre-append offset.
          final steps = <WireEvent>[
            const MessageWireEvent(
              seq: 900,
              message: AgentMessage(
                type: AgentMessageType.userMessage,
                id: 'frame-prompt',
                raw: {'type': 'user-message', 'text': 'Frame trace prompt'},
              ),
            ),
            const MessageWireEvent(
              seq: 901,
              message: AgentMessage(
                type: AgentMessageType.modelOutput,
                id: 'frame-answer',
                raw: {
                  'type': 'model-output',
                  'key': 'frame-answer',
                  'delta':
                      'Streaming answer that is long enough to change the '
                      'row height when it grows.',
                },
              ),
            ),
            const MessageWireEvent(
              seq: 902,
              message: AgentMessage(
                type: AgentMessageType.modelOutput,
                id: 'frame-answer',
                raw: {
                  'type': 'model-output',
                  'key': 'frame-answer',
                  'delta':
                      ' And a second streamed chunk, longer still, to force '
                      'another height change at the tail.',
                },
              ),
            ),
            // Variable-height terminal output: a short result, then the same
            // row replaced by a tall multi-line one. A row that changes height
            // in place is the case a post-frame chase cannot get right, because
            // the extent it chased was measured before the reflow.
            const MessageWireEvent(
              seq: 903,
              message: AgentMessage(
                type: AgentMessageType.toolResult,
                id: 'frame-tool',
                raw: {
                  'type': 'tool-result',
                  'callId': 'frame-tool',
                  'toolName': 'bash',
                  'toolClass': 'terminal',
                  'result': 'one line of terminal output',
                },
              ),
            ),
            MessageWireEvent(
              seq: 904,
              message: AgentMessage(
                type: AgentMessageType.toolResult,
                id: 'frame-tool',
                raw: {
                  'type': 'tool-result',
                  'callId': 'frame-tool',
                  'toolName': 'bash',
                  'toolClass': 'terminal',
                  'result': List<String>.generate(
                    24,
                    (line) =>
                        'terminal output line $line with enough text to '
                        'wrap at the roomy test width',
                  ).join('\n'),
                },
              ),
            ),
            const MessageWireEvent(
              seq: 905,
              message: AgentMessage(
                type: AgentMessageType.modelOutput,
                id: 'frame-answer',
                raw: {
                  'type': 'model-output',
                  'key': 'frame-answer',
                  'final': true,
                  'text':
                      'Streaming answer that is long enough to change the '
                      'row height when it grows. And a second streamed chunk, '
                      'longer still, to force another height change at the '
                      'tail.',
                },
              ),
            ),
            const MessageWireEvent(
              seq: 906,
              message: AgentMessage(
                type: AgentMessageType.runSummary,
                id: 'frame-run',
                raw: {
                  'type': 'run-summary',
                  'key': 'frame-run',
                  'turnId': 'frame-turn',
                  'status': 'done',
                  'userMessageKey': 'frame-prompt',
                  'assistantMessageKey': 'frame-answer',
                  'totalRuntimeMs': 4000,
                  'completedAt': 1781777404000,
                },
              ),
            ),
            const MessageWireEvent(
              seq: 907,
              message: AgentMessage(
                type: AgentMessageType.status,
                id: 'frame-idle',
                raw: {'type': 'status', 'status': 'idle'},
              ),
            ),
          ];

          // A corrective scroll is observable; a layout-phase correction is
          // not. `ScrollPosition.jumpTo` goes through `forcePixels`, which
          // notifies — that is the superseded one-shot chase, and it runs AFTER
          // the frame the user already saw. `correctPixels`, which the tail
          // physics uses during layout, is silent by design. So "zero
          // notifications while following" is exactly "no frame was painted off
          // the tail and then walked back".
          final tracked = _transcriptPosition(tester);
          var correctiveScrolls = 0;
          void countScroll() => correctiveScrolls++;
          tracked.addListener(countScroll);
          addTearDown(() => tracked.removeListener(countScroll));

          _expectTailRowVisible(tester, reason: 'before the turn starts');

          for (final step in steps) {
            connection.emitEvent(step);
            // Exactly one frame per mutation.
            await tester.pump();
            final position = _transcriptPosition(tester);
            expect(
              identical(position, tracked),
              isTrue,
              reason: 'the viewport must not be remounted by ordinary growth',
            );
            expect(
              position.pixels,
              monotonicallyCloseTo(position.maxScrollExtent),
              reason: 'a following viewport stays settled on the actual tail',
            );
            // The load-bearing assertion: the LAST ROW itself, not the extent
            // the lazy list estimated for it.
            _expectTailRowVisible(
              tester,
              reason:
                  'frame for seq ${(step as MessageWireEvent).seq}, '
                  'composer $focusLabel',
            );
            expect(
              correctiveScrolls,
              0,
              reason:
                  'growth must be absorbed during layout; a corrective scroll '
                  'after the frame is the visible drop-then-reflect',
            );
          }

          await tester.pumpAndSettle();
          final settled = _transcriptPosition(tester);
          expect(settled.pixels, monotonicallyCloseTo(settled.maxScrollExtent));
          _expectTailRowVisible(tester, reason: 'after the turn settles');
          expect(
            find.byKey(const Key('session-history-jump-latest')),
            findsNothing,
            reason: 'the user never left the tail, so no catch-up affordance',
          );
        },
      );
    }

    testWidgets('reading history is not yanked back down by new messages', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      final connection = ScriptedSessionDetailConnection(
        events: _messages(60),
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      // Scroll up into the history, far enough to clear the follow threshold.
      _transcriptPosition(tester).jumpTo(0);
      await tester.pumpAndSettle();
      expect(_transcriptPosition(tester).pixels, 0);

      for (final event in _messages(10, startSeq: 200)) {
        connection.emitEvent(event);
      }
      await tester.pumpAndSettle();

      expect(
        _transcriptPosition(tester).pixels,
        0,
        reason: 'the user was reading history, so the view must stay put',
      );
    });

    testWidgets('scrolling back to the end resumes following', (tester) async {
      useRoomyTestViewport(tester);
      final connection = ScriptedSessionDetailConnection(
        events: _messages(60),
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      _transcriptPosition(tester).jumpTo(0);
      await tester.pumpAndSettle();

      // Return to the end, which re-arms the follow.
      _transcriptPosition(tester).jumpTo(
        _transcriptPosition(tester).maxScrollExtent,
      );
      await tester.pumpAndSettle();

      for (final event in _messages(10, startSeq: 300)) {
        connection.emitEvent(event);
      }
      await tester.pumpAndSettle();

      final position = _transcriptPosition(tester);
      expect(position.pixels, monotonicallyCloseTo(position.maxScrollExtent));
    });

    testWidgets(
      'load-earlier preserves question-card viewport anchor while retaining '
      'live messages',
      (tester) async {
        useRoomyTestViewport(tester);
        final hold = Completer<void>();
        final connection = _HistoryCapableScriptedConnection(
          hold: hold,
          events: [
            HistoryWireEvent(
              messages: [
                AgentMessage.fromJson(const {
                  'type': 'question-request',
                  'requestId': 'q-anchor',
                  'questions': [
                    {
                      'question': 'Which path do you want to take?',
                      'options': [
                        {'label': 'Blue'},
                        {'label': 'Green'},
                      ],
                    },
                  ],
                }),
                AgentMessage.fromJson(const {
                  'type': 'tool-call',
                  'callId': 'anchor-call',
                  'name': 'search-files',
                  'arguments': {'query': 'history anchor'},
                }),
                for (var index = 1; index <= 20; index++)
                  AgentMessage(
                    type: AgentMessageType.modelOutput,
                    id: 'initial-tail-$index',
                    raw: {
                      'type': 'model-output',
                      'text': 'Tail message $index',
                    },
                  ),
              ],
              reset: true,
              cursor: 'tail-cursor',
              olderCursor: 'page-2',
              hasEarlier: true,
            ),
          ],
        );

        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        final questionText = find.byKey(
          const Key('session-detail-question-text-q-anchor-0'),
        );
        final questionOption = find.byKey(
          const Key('session-detail-question-option-q-anchor-0-0'),
        );
        final toolDetails = find.byKey(
          const Key('tool-anchor-call-details'),
        );
        final position = _transcriptPosition(tester)..jumpTo(0);
        await tester.pumpAndSettle();

        expect(
          find.byKey(const Key('session-history-load-earlier')),
          findsNothing,
        );
        expect(questionText, findsOneWidget);
        expect(
          position.pixels,
          lessThan(position.maxScrollExtent - 32),
        );
        expect(
          tester.widget<FilterChip>(questionOption).selected,
          isFalse,
        );

        await tester.tap(questionOption);
        await tester.pump();
        expect(
          tester.widget<FilterChip>(questionOption).selected,
          isTrue,
        );
        await tester.tap(toolDetails);
        await tester.pumpAndSettle();
        expect(richTextFinder('query: history anchor'), findsOneWidget);

        final anchorBefore = _findInViewportTop(tester, questionOption);
        await tester.sendKeyDownEvent(LogicalKeyboardKey.altLeft);
        await tester.sendKeyEvent(LogicalKeyboardKey.pageUp);
        await tester.sendKeyUpEvent(LogicalKeyboardKey.altLeft);
        await tester.pump();

        connection.emitEvent(
          const MessageWireEvent(
            seq: 101,
            message: AgentMessage(
              type: AgentMessageType.modelOutput,
              id: 'live-during-load',
              raw: {
                'type': 'model-output',
                'key': 'live-during-load',
                'text':
                    'A live update should survive the page request while anchor'
                    ' is held.',
              },
            ),
          ),
        );
        await tester.pump();

        final container = ProviderScope.containerOf(
          tester.element(find.byKey(const Key('session-detail-chat-scroll'))),
        );
        final loadingState = container.read(
          sessionDetailControllerProvider(
            const SessionDetailKey(
              tool: 'claude',
              sessionId: 'session-1',
            ),
          ),
        );
        expect(loadingState.historyPageLoading, isTrue);
        expect(loadingState.historyPageError, isNull);
        expect(
          _findInViewportTop(tester, questionOption),
          closeTo(anchorBefore, 1),
          reason: 'the inline loading treatment must not move the anchor',
        );

        connection.emitEvent(
          HistoryPageWireEvent(
            messages: [
              const AgentMessage(
                type: AgentMessageType.modelOutput,
                raw: {
                  'type': 'model-output',
                  'key': 'older-1',
                  'text':
                      'Older prepended row one.\n'
                      'It is intentionally tall because it has a long wrapped\n'
                      'body with multiple lines.',
                },
                id: 'older-1',
              ),
              const AgentMessage(
                type: AgentMessageType.modelOutput,
                raw: {
                  'type': 'model-output',
                  'key': 'older-2',
                  'text':
                      'Older prepended row two.\n'
                      'Also tall with more content and extra spacing.',
                },
                id: 'older-2',
              ),
            ],
            cursor: 'page-1',
            hasMore: false,
            endOfHistory: true,
            clientMessageId: connection.lastHistoryPageClientMessageId,
          ),
        );
        await tester.pumpAndSettle();

        final anchorAfter = _findInViewportTop(tester, questionOption);
        expect(anchorBefore, closeTo(anchorAfter, 4));
        expect(connection.lastHistoryPageCursor, 'page-2');
        expect(connection.lastHistoryPageLimit, 100);
        expect(
          tester.widget<FilterChip>(questionOption).selected,
          isTrue,
        );
        expect(richTextFinder('query: history anchor'), findsOneWidget);

        final state = container.read(
          sessionDetailControllerProvider(
            const SessionDetailKey(
              tool: 'claude',
              sessionId: 'session-1',
            ),
          ),
        );
        final olderIndex = state.messageEvents.indexWhere(
          (message) => message.id == 'older-1',
        );
        final anchorIndex = state.messageEvents.indexWhere(
          (message) => extractRequestIdFromMessage(message) == 'q-anchor',
        );
        expect(olderIndex, greaterThanOrEqualTo(0));
        expect(anchorIndex, greaterThan(olderIndex));
        expect(
          state.messageEvents.any(
            (message) => message.id == 'live-during-load',
          ),
          isTrue,
        );
        hold.complete();
        await tester.pumpAndSettle();
      },
    );

    testWidgets('tool expansion survives live result completion', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      final connection = ScriptedSessionDetailConnection(
        events: const [
          MessageWireEvent(
            seq: 1,
            message: AgentMessage(
              type: AgentMessageType.toolCall,
              id: 'tool-call-message',
              raw: {
                'type': 'tool-call',
                'callId': 'stable-call',
                'name': 'search-files',
                'arguments': {'query': 'docs'},
              },
            ),
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('tool-stable-call-details')));
      await tester.pumpAndSettle();
      expect(richTextFinder('query: docs'), findsOneWidget);

      connection.emitEvent(
        const MessageWireEvent(
          seq: 2,
          message: AgentMessage(
            type: AgentMessageType.toolResult,
            id: 'tool-result-message',
            raw: {
              'type': 'tool-result',
              'callId': 'stable-call',
              'name': 'search-files',
              'output': 'two matches',
            },
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('tool-stable-call-details')),
        findsOneWidget,
      );
      expect(richTextFinder('query: docs'), findsOneWidget);
      expect(richTextFinder('two matches'), findsOneWidget);
    });
  });

  group('session open settles on the tail without corrective motion (U5)', () {
    testWidgets('network-first long transcript (Roomy and Compact)', (
      tester,
    ) async {
      for (final size in const [Size(1280, 800), Size(360, 760)]) {
        _useViewport(tester, size);
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [
              HistoryWireEvent(
                messages: _agentMessages(240),
                reset: true,
                cursor: 'tail-cursor',
              ),
            ],
          ),
        );
        await _traceTailReveal(
          tester,
          anyRow: find.textContaining('Message '),
          newestRow: find.text('Message 240'),
        );
        // Unmount so the next viewport models an independent open rather
        // than a reused page element (production keys pages by session).
        await tester.pumpWidget(const SizedBox());
        await tester.pump();
      }
    });

    testWidgets('cached-first transcript replaced by authoritative history', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      final transcripts = InMemorySessionTranscriptRepository()
        ..snapshot = SessionTranscriptSnapshot(
          brokerProfileId: 'local',
          sessionKey: const SessionDetailKey(
            tool: 'claude',
            sessionId: 'session-1',
          ),
          messages: _agentMessages(240),
          hasEarlier: false,
          updatedAt: DateTime(2026, 7, 26),
        );
      // The authoritative tail window is shorter than the retained cache and
      // extends it, so the first visible row identity changes mid-open.
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          transcriptRepository: transcripts,
          events: [
            HistoryWireEvent(
              messages: _agentMessages(110, startSeq: 141),
              reset: true,
              cursor: 'tail-cursor',
            ),
          ],
        ),
      );
      await _traceTailReveal(
        tester,
        anyRow: find.textContaining('Message '),
        newestRow: find.text('Message 250'),
      );
    });

    testWidgets('long variable-height markdown rows', (tester) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            HistoryWireEvent(
              messages: [
                for (var index = 1; index <= 120; index++)
                  AgentMessage(
                    type: AgentMessageType.modelOutput,
                    id: 'md-$index',
                    raw: {
                      'type': 'model-output',
                      'text':
                          '## Plan $index\n\n'
                          '${'Variable row $index wraps. ' * (index % 5 + 1)}'
                          '\n```dart\n${'code $index\n' * (index % 4)}```',
                    },
                  ),
              ],
              reset: true,
              cursor: 'tail-cursor',
            ),
          ],
        ),
      );
      await _traceTailReveal(
        tester,
        anyRow: find.textContaining('Variable row '),
        newestRow: find.textContaining('Plan 120'),
      );
    });

    testWidgets('tool-heavy transcript with expansion state', (tester) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            HistoryWireEvent(
              messages: [
                for (var index = 1; index <= 40; index++) ...[
                  AgentMessage(
                    type: AgentMessageType.userMessage,
                    id: 'prompt-$index',
                    raw: {
                      'type': 'user-message',
                      'text': 'Message $index',
                    },
                  ),
                  AgentMessage(
                    type: AgentMessageType.toolCall,
                    id: 'call-$index',
                    raw: {
                      'type': 'tool-call',
                      'callId': 'call-$index',
                      'name': 'search-files',
                      'arguments': {'query': 'q$index'},
                    },
                  ),
                  AgentMessage(
                    type: AgentMessageType.toolResult,
                    id: 'result-$index',
                    raw: {
                      'type': 'tool-result',
                      'callId': 'call-$index',
                      'name': 'search-files',
                      'output': 'found $index',
                    },
                  ),
                ],
                const AgentMessage(
                  type: AgentMessageType.userMessage,
                  id: 'final-prompt',
                  raw: {'type': 'user-message', 'text': 'Final message'},
                ),
              ],
              reset: true,
              cursor: 'tail-cursor',
            ),
          ],
        ),
      );
      await _traceTailReveal(
        tester,
        anyRow: find.textContaining('Message '),
        newestRow: find.text('Final message'),
      );
      // Expansion state still works after the gated reveal.
      await tester.tap(find.byKey(const Key('tool-call-40-details')));
      await tester.pumpAndSettle();
      expect(richTextFinder('query: q40'), findsOneWidget);
    });

    testWidgets('network-first with live events in flight', (tester) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            HistoryWireEvent(
              messages: _agentMessages(120),
              reset: true,
              cursor: 'tail-cursor',
            ),
            for (var index = 1; index <= 20; index++)
              MessageWireEvent(
                seq: 200 + index,
                message: AgentMessage(
                  type: AgentMessageType.userMessage,
                  id: 'live-$index',
                  raw: {'type': 'user-message', 'text': 'Live $index'},
                ),
              ),
          ],
        ),
      );
      await _traceTailReveal(
        tester,
        anyRow: find.textContaining(RegExp('Message |Live ')),
        newestRow: find.text('Live 20'),
      );
    });

    testWidgets('session-to-session navigation re-settles on the new tail', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            HistoryWireEvent(
              messages: _agentMessages(120),
              reset: true,
              cursor: 'tail-cursor',
            ),
          ],
        ),
      );
      await _traceTailReveal(
        tester,
        anyRow: find.textContaining('Message '),
        newestRow: find.text('Message 120'),
      );

      // Production keys SessionDetailPage by session, so opening another
      // session is a fresh surface: unmount, then its open must settle the
      // same way.
      await tester.pumpWidget(const SizedBox());
      await tester.pump();
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          sessionId: 'session-2',
          events: [
            HistoryWireEvent(
              messages: _agentMessages(180),
              reset: true,
              cursor: 'tail-cursor-2',
            ),
          ],
        ),
      );
      await _traceTailReveal(
        tester,
        anyRow: find.textContaining('Message '),
        newestRow: find.text('Message 180'),
      );
    });

    testWidgets('large text scale', (tester) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          textScale: 1.3,
          events: [
            HistoryWireEvent(
              messages: _agentMessages(120),
              reset: true,
              cursor: 'tail-cursor',
            ),
          ],
        ),
      );
      await _traceTailReveal(
        tester,
        anyRow: find.textContaining('Message '),
        newestRow: find.text('Message 120'),
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('empty authoritative transcript reveals the empty state', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(buildSessionDetailTestPage(events: const []));
      await _traceTailReveal(
        tester,
        anyRow: find.byKey(const Key('session-detail-transcript-empty')),
        newestRow: find.byKey(const Key('session-detail-transcript-empty')),
      );
    });

    testWidgets('the settle loop schedules its own frames until reveal', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            HistoryWireEvent(
              messages: _agentMessages(240),
              reset: true,
              cursor: 'tail-cursor',
            ),
          ],
        ),
      );
      final gateFinder = find.byKey(
        const Key('session-transcript-tail-reveal-gate'),
      );
      var sawHiddenGate = false;
      var revealed = false;
      for (var frame = 0; frame < 20 && !revealed; frame++) {
        if (frame > 0) await tester.pump();
        if (gateFinder.evaluate().isEmpty) continue; // bootstrap phase
        final hidden = tester.widget<Offstage>(gateFinder).offstage;
        if (!hidden) {
          revealed = true;
          continue;
        }
        sawHiddenGate = true;
        // `addPostFrameCallback` does NOT schedule a frame, so the settle
        // loop must request its own (via `scheduleFrame`) or a no-jump settle
        // step leaves the transcript hidden forever in production.
        //
        // Structural coverage, not an isolated proof of that fix: in
        // flutter_test `tester.pump()` forces frames regardless, and in this
        // fixture every hidden frame ALSO has a frame scheduled by the
        // settle jump itself and by the loading overlay's
        // CircularProgressIndicator — so this assertion passes even with the
        // `scheduleFrame` call reverted. What it pins is the invariant: no
        // hidden-gate frame may ever observe `hasScheduledFrame == false`,
        // and the gate must reveal within bounded pumps with no user input.
        expect(
          tester.binding.hasScheduledFrame,
          isTrue,
          reason:
              'frame $frame: the gate is hidden but no frame is scheduled; '
              'the settle loop must request its own frames',
        );
      }
      expect(
        sawHiddenGate,
        isTrue,
        reason: 'this fixture must exercise the hidden gate',
      );
      expect(
        revealed,
        isTrue,
        reason:
            'the gate must reveal within bounded frames, without user input '
            'or an unrelated rebuild',
      );
      expect(find.text('Message 240'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('ordinary updates after reveal never re-hide the transcript', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      final connection = _HistoryCapableScriptedConnection(
        events: [
          HistoryWireEvent(
            messages: _agentMessages(240),
            reset: true,
            cursor: 'tail-cursor',
            olderCursor: 'older-cursor',
            hasEarlier: true,
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(connection: connection, events: const []),
      );
      await _traceTailReveal(
        tester,
        anyRow: find.textContaining('Message '),
        newestRow: find.text('Message 240'),
      );

      final gateFinder = find.byKey(
        const Key('session-transcript-tail-reveal-gate'),
      );
      final loadingFinder = find.byKey(
        const Key('session-detail-bootstrap-blocking'),
      );
      // Every pumped frame is inspected — a one-frame loading flash between
      // the event and the check cannot pass.
      Future<void> expectNeverRehides(String step, {int frames = 3}) async {
        for (var frame = 0; frame < frames; frame++) {
          await tester.pump();
          final hidden =
              gateFinder.evaluate().isNotEmpty &&
              tester.widget<Offstage>(gateFinder).offstage;
          expect(
            hidden,
            isFalse,
            reason: '$step re-hid the open transcript on frame $frame',
          );
          expect(
            loadingFinder,
            findsNothing,
            reason: '$step flashed the loading treatment on frame $frame',
          );
        }
      }

      // A live append after reveal: streaming never re-arms the gate.
      connection.emitEvent(
        const MessageWireEvent(
          seq: 300,
          message: AgentMessage(
            type: AgentMessageType.userMessage,
            id: 'live-append',
            raw: {'type': 'user-message', 'text': 'Live append'},
          ),
        ),
      );
      await expectNeverRehides('live append');
      expect(find.text('Live append'), findsOneWidget);

      // A history page prepends rows above the visible transcript.
      final container = ProviderScope.containerOf(
        tester.element(find.byKey(const Key('session-detail-chat-scroll'))),
      );
      final controller = container.read(
        sessionDetailControllerProvider(
          const SessionDetailKey(tool: 'claude', sessionId: 'session-1'),
        ).notifier,
      );
      expect(await controller.loadEarlierHistory(), isTrue);
      connection.emitEvent(
        HistoryPageWireEvent(
          messages: const [
            AgentMessage(
              type: AgentMessageType.userMessage,
              id: 'earlier-1',
              raw: {'type': 'user-message', 'text': 'Earlier page row'},
            ),
          ],
          cursor: 'older-cursor-2',
          hasMore: true,
          endOfHistory: false,
          clientMessageId: connection.lastHistoryPageClientMessageId,
        ),
      );
      await expectNeverRehides('history prepend');
      // The prepended row sits at the top of a lazy list, so it is not
      // mounted to find — confirm the projection through the controller.
      final afterPrepend = container.read(
        sessionDetailControllerProvider(
          const SessionDetailKey(tool: 'claude', sessionId: 'session-1'),
        ),
      );
      expect(afterPrepend.messageEvents.first.id, 'earlier-1');

      // End of history removes the earlier-history notice: the row count
      // shrinks and the first display row changes — still an ordinary update,
      // not an authoritative reset.
      expect(await controller.loadEarlierHistory(), isTrue);
      connection.emitEvent(
        HistoryPageWireEvent(
          messages: const [],
          hasMore: false,
          endOfHistory: true,
          clientMessageId: connection.lastHistoryPageClientMessageId,
        ),
      );
      await expectNeverRehides('notice removal');
      expect(find.text('Message 240'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('an authoritative reset re-arms the gate behind the loading '
        'treatment', (tester) async {
      useRoomyTestViewport(tester);
      final connection = ScriptedSessionDetailConnection(
        events: [
          HistoryWireEvent(
            messages: _agentMessages(120),
            reset: true,
            cursor: 'tail-cursor',
          ),
        ],
        reattachEvents: [
          HistoryWireEvent(
            messages: _agentMessages(300),
            reset: true,
            cursor: 'reattach-cursor',
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(connection: connection, events: const []),
      );
      await _traceTailReveal(
        tester,
        anyRow: find.textContaining('Message '),
        newestRow: find.text('Message 120'),
      );

      final container = ProviderScope.containerOf(
        tester.element(find.byKey(const Key('session-detail-chat-scroll'))),
      );
      // Re-attach through the real controller: a new bootstrap attempt whose
      // authoritative replay replaces the visible transcript. `runAsync`
      // because the attach path awaits stream-subscription cancellations,
      // whose completion futures do not advance inside the fake-async zone.
      await tester.runAsync(
        () => container
            .read(
              sessionDetailControllerProvider(
                const SessionDetailKey(tool: 'claude', sessionId: 'session-1'),
              ).notifier,
            )
            .attach(force: true),
      );

      final gateFinder = find.byKey(
        const Key('session-transcript-tail-reveal-gate'),
      );
      final loadingFinder = find.byKey(
        const Key('session-detail-bootstrap-blocking'),
      );
      var sawRearm = false;
      var sawNewTail = false;
      for (var frame = 0; frame < 40 && !sawNewTail; frame++) {
        await tester.pump();
        final hidden =
            gateFinder.evaluate().isNotEmpty &&
            tester.widget<Offstage>(gateFinder).offstage;
        final contentVisible =
            !hidden && find.textContaining('Message ').evaluate().isNotEmpty;
        final loadingVisible = loadingFinder.evaluate().isNotEmpty;
        expect(
          contentVisible || loadingVisible,
          isTrue,
          reason:
              'frame $frame after re-attach: the transcript region must '
              'always show content or the loading treatment — never neither',
        );
        if (hidden) sawRearm = true;
        if (contentVisible && find.text('Message 300').evaluate().isNotEmpty) {
          sawNewTail = true;
        }
      }
      expect(
        sawRearm,
        isTrue,
        reason: 'the authoritative reset must re-arm the reveal gate',
      );
      expect(
        sawNewTail,
        isTrue,
        reason: 'the re-attach transcript must reveal at its own tail',
      );
      final position = _transcriptPosition(tester);
      expect(position.pixels, monotonicallyCloseTo(position.maxScrollExtent));
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'an automatic reconnect replay re-arms without a new bootstrap '
      'attempt',
      (tester) async {
        useRoomyTestViewport(tester);
        final connection = ScriptedSessionDetailConnection(
          events: [
            HistoryWireEvent(
              messages: _agentMessages(120),
              reset: true,
              cursor: 'tail-cursor',
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(connection: connection, events: const []),
        );
        await _traceTailReveal(
          tester,
          anyRow: find.textContaining('Message '),
          newestRow: find.text('Message 120'),
        );

        final container = ProviderScope.containerOf(
          tester.element(find.byKey(const Key('session-detail-chat-scroll'))),
        );
        const sessionKey = SessionDetailKey(
          tool: 'claude',
          sessionId: 'session-1',
        );
        final provider = sessionDetailControllerProvider(sessionKey);
        final attemptBefore = container.read(provider).bootstrapState.attempt;

        final gateFinder = find.byKey(
          const Key('session-transcript-tail-reveal-gate'),
        );
        final loadingFinder = find.byKey(
          const Key('session-detail-bootstrap-blocking'),
        );

        // The transport reconnects INSIDE the existing connection: no
        // attach(), no new bootstrap attempt. When the reconnect cursor is
        // invalid/gone/diverged/capped the broker answers with a full
        // reset:true replay on the same event stream.
        connection.emitState(SessionDetailConnectionStatus.reconnecting);
        await tester.pump();
        connection.emitState(SessionDetailConnectionStatus.connected);
        await tester.pump();
        connection.emitEvent(
          HistoryWireEvent(
            messages: _agentMessages(300),
            reset: true,
            cursor: 'reconnect-cursor',
          ),
        );

        var sawRearm = false;
        var sawNewTail = false;
        for (var frame = 0; frame < 40 && !sawNewTail; frame++) {
          await tester.pump();
          final hidden =
              gateFinder.evaluate().isNotEmpty &&
              tester.widget<Offstage>(gateFinder).offstage;
          final contentVisible =
              !hidden && find.textContaining('Message ').evaluate().isNotEmpty;
          final loadingVisible = loadingFinder.evaluate().isNotEmpty;
          expect(
            contentVisible || loadingVisible,
            isTrue,
            reason:
                'frame $frame after the reconnect replay: the transcript '
                'region must show content or the loading treatment — never '
                'neither',
          );
          if (contentVisible) {
            final position = _transcriptPosition(tester);
            expect(
              find.text('Message 300').evaluate().isNotEmpty &&
                  position.pixels >= position.maxScrollExtent - 4,
              isTrue,
              reason:
                  'frame $frame after the reconnect replay: visible content '
                  'is not the settled replacement tail (pixels='
                  '${position.pixels}, maxExtent=${position.maxScrollExtent})'
                  ' — the replacement must never visibly chase',
            );
            sawNewTail = true;
          }
          if (hidden) sawRearm = true;
        }
        expect(
          sawRearm,
          isTrue,
          reason:
              'the reconnect replay must re-arm the reveal gate behind the '
              'loading treatment',
        );
        expect(
          sawNewTail,
          isTrue,
          reason: 'the reconnect transcript must reveal at its own tail',
        );
        expect(
          container.read(provider).bootstrapState.attempt,
          attemptBefore,
          reason:
              'the automatic reconnect must not create a new bootstrap '
              'attempt',
        );
        final position = _transcriptPosition(tester);
        expect(position.pixels, monotonicallyCloseTo(position.maxScrollExtent));

        // An incremental (reset:false) frame on the same automatic-reconnect
        // path is an ordinary update: it must never re-hide the transcript.
        connection.emitState(SessionDetailConnectionStatus.reconnecting);
        await tester.pump();
        connection.emitState(SessionDetailConnectionStatus.connected);
        await tester.pump();
        connection.emitEvent(
          HistoryWireEvent(
            messages: _agentMessages(20, startSeq: 301),
            cursor: 'reconnect-cursor-2',
          ),
        );
        for (var frame = 0; frame < 4; frame++) {
          await tester.pump();
          final hidden =
              gateFinder.evaluate().isNotEmpty &&
              tester.widget<Offstage>(gateFinder).offstage;
          expect(
            hidden,
            isFalse,
            reason:
                'the reset:false reconnect frame re-hid the transcript on '
                'frame $frame',
          );
          expect(
            loadingFinder,
            findsNothing,
            reason:
                'the reset:false reconnect frame flashed the loading '
                'treatment on frame $frame',
          );
        }
        expect(find.text('Message 320'), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );
  });
}

/// The follow logic allows a small slack from the very end (see
/// `_TranscriptSurfaceState._bottomThreshold`), so assert closeness rather
/// than exact equality.
Matcher monotonicallyCloseTo(double value) => closeTo(value, 32);

/// Builds [count] user [AgentMessage]s, oldest first, for history frames and
/// cached snapshots.
List<AgentMessage> _agentMessages(int count, {int startSeq = 1}) {
  return [
    for (var i = 0; i < count; i++)
      AgentMessage(
        type: AgentMessageType.userMessage,
        id: 'message-${startSeq + i}',
        raw: {'type': 'user-message', 'text': 'Message ${startSeq + i}'},
      ),
  ];
}

List<AgentMessage> _variableHeightAgentMessages(
  int count, {
  int startSeq = 1,
}) {
  return [
    for (var i = 0; i < count; i++)
      AgentMessage(
        type: AgentMessageType.userMessage,
        id: 'variable-message-${startSeq + i}',
        raw: {
          'type': 'user-message',
          'text': List.filled(
            i.isEven ? 1 : 8,
            'Variable-height message ${startSeq + i}.',
          ).join(' '),
        },
      ),
  ];
}

void _useViewport(WidgetTester tester, Size size) {
  addTearDown(() {
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
  });
  tester.view
    ..physicalSize = size
    ..devicePixelRatio = 1;
}

/// Pumps frame by frame from session open and asserts two rules on every
/// frame:
///
/// 1. Every frame in which transcript content is visible already shows the
///    settled tail (the U5 reproduction: it never calls `pumpAndSettle`, so
///    the old behavior — paint an early position, then chase the growing lazy
///    extent through visible post-frame `jumpTo` corrections — fails here).
/// 2. A frame with no visible transcript content always shows the existing
///    bootstrap loading treatment — never a blank region.
Future<void> _traceTailReveal(
  WidgetTester tester, {
  required Finder anyRow,
  required Finder newestRow,
  int frames = 30,
}) async {
  final scrollFinder = find.byKey(const Key('session-detail-chat-scroll'));
  final gateFinder = find.byKey(
    const Key('session-transcript-tail-reveal-gate'),
  );
  final loadingFinder = find.byKey(
    const Key('session-detail-bootstrap-blocking'),
  );
  final trace = <String>[];
  final violations = <String>[];
  var sawVisibleContent = false;
  double? lastVisiblePixels;

  for (var frame = 0; frame < frames; frame++) {
    // Frame 0 inspects the first painted frame right after pumpWidget.
    if (frame > 0) await tester.pump();
    final loadingVisible = loadingFinder.evaluate().isNotEmpty;
    if (scrollFinder.evaluate().isEmpty) {
      trace.add('frame $frame: no transcript yet (loading=$loadingVisible)');
      if (!loadingVisible) {
        violations.add(
          'frame $frame: neither the loading treatment nor a transcript',
        );
      }
      continue;
    }
    // While the reveal gate hides the list the rows exist but are not
    // painted; only ungated frames count as visible content.
    final hidden =
        gateFinder.evaluate().isNotEmpty &&
        tester.widget<Offstage>(gateFinder).offstage;
    final rowVisible = anyRow.evaluate().isNotEmpty;
    final contentVisible = !hidden && rowVisible;
    final position = _transcriptPosition(tester);
    var newestFullyVisible = false;
    if (newestRow.evaluate().isNotEmpty) {
      final viewport = tester.getRect(scrollFinder);
      final rowRect = tester.getRect(newestRow);
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
      // A hidden break starts a new settle generation: motion continuity is
      // only meaningful across consecutive visible frames.
      lastVisiblePixels = null;
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
    if (previous != null && position.pixels < previous - 1) {
      violations.add(
        'frame $frame: corrective upward motion across visible frames '
        '($previous -> ${position.pixels})',
      );
    }
    lastVisiblePixels = position.pixels;
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
    reason:
        'frame trace:\n${trace.join('\n')}\nviolations:\n'
        '${violations.join('\n')}',
  );
  expect(tester.takeException(), isNull);
}
