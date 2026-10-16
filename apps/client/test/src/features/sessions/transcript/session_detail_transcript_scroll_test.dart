import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/sessions/requests/session_request_action_helpers.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
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

/// Jumps to the top of the transcript. The list is centered, so once rows sit
/// above its center the scroll range starts below zero.
void _jumpToStart(WidgetTester tester) {
  final position = _transcriptPosition(tester);
  position.jumpTo(position.minScrollExtent);
}

double _transcriptViewportTop(WidgetTester tester) =>
    tester.getTopLeft(find.byKey(const Key('session-detail-chat-scroll'))).dy;

double _findInViewportTop(WidgetTester tester, Finder finder) =>
    tester.getTopLeft(finder).dy - _transcriptViewportTop(tester);

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
      'continued trackpad movement pages again, and holding still chains a '
      'bounded number',
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
        _jumpToStart(tester);
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
        // Two-row pages keep each older boundary within one viewport of the
        // reader, so the chain ends at the fling limit rather than because a
        // page's rows pushed the next boundary out of reach.
        connection.emitEvent(
          HistoryPageWireEvent(
            messages: _agentMessages(2, startSeq: 199),
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
            messages: _agentMessages(2, startSeq: 197),
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
              'after the trackpad lifts, a page that lands with the reader '
              'still at the start calls for the next',
        );
        connection.emitEvent(
          HistoryPageWireEvent(
            messages: _agentMessages(2, startSeq: 195),
            cursor: 'page-before-0',
            hasMore: true,
            endOfHistory: false,
            clientMessageId: connection.lastHistoryPageClientMessageId,
          ),
        );
        for (
          var frame = 0;
          frame < 20 && connection.historyPageRequestCount < 4;
          frame++
        ) {
          await tester.pump(const Duration(milliseconds: 16));
        }
        expect(connection.historyPageRequestCount, 4);
        connection.emitEvent(
          HistoryPageWireEvent(
            messages: _agentMessages(2, startSeq: 193),
            cursor: 'page-before-1',
            hasMore: true,
            endOfHistory: false,
            clientMessageId: connection.lastHistoryPageClientMessageId,
          ),
        );
        await tester.pumpAndSettle();
        expect(
          connection.historyPageRequestCount,
          4,
          reason:
              'without the reader moving, at most two pages follow the last '
              'one their movement asked for',
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
          var offset = position.minScrollExtent;
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
        position.jumpTo(position.minScrollExtent);
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

    for (final refusal in const {
      'HISTORY_PAGE_RESOURCE_LIMIT':
          'The server cannot load this history within its resource limits.',
      'HISTORY_PAGE_CLIENT_RESOURCE_LIMIT':
          'This page is too large to load safely on this device.',
    }.entries) {
      testWidgets(
        'resource refusal is terminal, localized, and has no retry affordance: '
        '${refusal.key}',
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
            buildSessionDetailTestPage(
              events: const [],
              connection: connection,
            ),
          );
          await tester.pumpAndSettle();
          _jumpToStart(tester);
          await tester.pump();

          await tester.drag(
            find.byKey(const Key('session-detail-chat-scroll')),
            const Offset(0, 80),
          );
          await tester.pump();
          expect(connection.historyPageRequestCount, 1);
          connection.emitEvent(
            NackWireEvent(
              code: refusal.key,
              message: 'The bounded snapshot is too large.',
              clientMessageId: connection.lastHistoryPageClientMessageId,
            ),
          );
          await tester.pump();

          expect(
            find.text(refusal.value),
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
    }

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

        _jumpToStart(tester);
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

        _jumpToStart(tester);
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
      position.jumpTo(position.minScrollExtent);
      await tester.pumpAndSettle();

      expect(
        find.text('Message 1'),
        findsOneWidget,
        reason:
            'all 240 live messages fit the active window, so the oldest is '
            'still retained (and only built once scrolled into view)',
      );
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
        final position = _transcriptPosition(tester);
        _jumpToStart(tester);
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

  group('history start marker rejects a locally evicted prefix', () {
    // A reset can sit under the broker's message cap yet exceed the client's
    // decoded-byte budget; `fromHistory` then evicts the frame's own prefix
    // and the window's head is no longer the session start, whatever
    // `hasEarlier`/`truncated` claim. The marker and the released banner must
    // never render together.
    testWidgets(
      'network-first byte-heavy reset shows the released banner, '
      'not Start of session',
      (tester) async {
        useRoomyTestViewport(tester);
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [
              HistoryWireEvent(
                messages: _byteHeavyAgentMessages(6),
                reset: true,
                cursor: 'tail-cursor',
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(const Key('session-history-start-marker')),
          findsNothing,
        );
        expect(
          find.byKey(const Key('history-gap-leading-local')),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets('a complete small reset still shows Start of session', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            HistoryWireEvent(
              messages: _agentMessages(5),
              reset: true,
              cursor: 'tail-cursor',
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-history-start-marker')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('history-gap-leading-local')),
        findsNothing,
      );
      expect(tester.takeException(), isNull);
    });
  });
}

/// The follow logic allows a small slack from the very end (see
/// `_TranscriptSurfaceState._bottomThreshold`), so assert closeness rather
/// than exact equality.
Matcher monotonicallyCloseTo(double value) => closeTo(value, 32);

/// Builds [count] user [AgentMessage]s whose combined decoded-byte estimate
/// exceeds [kMaxActiveTranscriptDecodedBytes] while staying far under every
/// message-count limit. The bulk sits in an unrendered raw field so the rows
/// lay out cheaply; only the byte limb of the eviction gate trips.
List<AgentMessage> _byteHeavyAgentMessages(int count) {
  final pad = 'x' * 500000;
  return [
    for (var i = 0; i < count; i++)
      AgentMessage(
        type: AgentMessageType.userMessage,
        id: 'heavy-message-${i + 1}',
        raw: {'type': 'user-message', 'text': 'Heavy ${i + 1}', 'pad': pad},
      ),
  ];
}

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
