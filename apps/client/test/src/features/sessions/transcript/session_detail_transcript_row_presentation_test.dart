import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/schedules/controller/inline_scheduled_message_controller.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

const _sessionKey = SessionDetailKey(tool: 'claude', sessionId: 'session-1');

final class _HistoryPagingConnection extends ScriptedSessionDetailConnection
    implements SessionHistoryConnection {
  _HistoryPagingConnection({required super.events});

  String? lastHistoryPageClientMessageId;

  @override
  void seedHistoryCursor(String cursor) {}

  @override
  Future<void> requestHistoryPage({
    required String cursor,
    int? limit,
    String? clientMessageId,
  }) async {
    lastHistoryPageClientMessageId = clientMessageId;
  }
}

/// One turn's worth of rows: a prompt, a tool call/result pair, and a reply.
///
/// Mixed row kinds matter here — identity derivation differs per kind, so a
/// transcript of one kind could hide a per-row cost that the real transcript
/// pays.
List<AgentMessage> _turnMessages(int index) => [
  AgentMessage.fromJson({
    'type': 'user-message',
    'key': 'u$index',
    'text': 'Prompt $index',
  }),
  AgentMessage.fromJson({
    'type': 'tool-call',
    'key': 'tc$index',
    'callId': 'call-$index',
    'name': 'search-files',
    'arguments': {'query': 'row $index'},
  }),
  AgentMessage.fromJson({
    'type': 'tool-result',
    'key': 'tr$index',
    'callId': 'call-$index',
    'result': 'hit $index',
  }),
  AgentMessage.fromJson({
    'type': 'model-output',
    'key': 'm$index',
    'text': 'Reply $index',
  }),
];

List<AgentMessage> _page(int start) => [
  for (var index = start; index < start + 25; index++) ..._turnMessages(index),
];

SessionDetailController _controller(WidgetTester tester) {
  final container = ProviderScope.containerOf(
    tester.element(find.byKey(const Key('session-detail-chat-scroll'))),
  );
  return container.read(sessionDetailControllerProvider(_sessionKey).notifier);
}

SessionDetailState _state(WidgetTester tester) {
  final container = ProviderScope.containerOf(
    tester.element(find.byKey(const Key('session-detail-chat-scroll'))),
  );
  return container.read(sessionDetailControllerProvider(_sessionKey));
}

/// Opens a session whose tail is one page deep, then pages [olderPages] more
/// pages of history in, and measures the row work of ONE live tail delta.
Future<TranscriptRowWorkCounter> _measureLiveDelta(
  WidgetTester tester, {
  required int olderPages,
}) async {
  // Tear the previous tree down first: pumping a second page into a live
  // element tree reuses the earlier `ProviderScope` container, so the
  // controller would keep talking to the previous run's connection.
  await tester.pumpWidget(const SizedBox.shrink());
  await tester.pumpAndSettle();

  useRoomyTestViewport(tester);
  final connection = _HistoryPagingConnection(
    events: [
      HistoryWireEvent(
        messages: _page(2400),
        reset: true,
        cursor: 'tail',
        olderCursor: 'cursor-24',
        hasEarlier: true,
      ),
    ],
  );
  await tester.pumpWidget(
    buildSessionDetailTestPage(events: const [], connection: connection),
  );
  await tester.pumpAndSettle();

  for (var page = 23; page > 23 - olderPages; page--) {
    expect(await _controller(tester).loadEarlierHistory(), isTrue);
    await tester.pump();
    connection.emitEvent(
      HistoryPageWireEvent(
        messages: _page(page * 100),
        cursor: 'cursor-$page',
        hasMore: true,
        endOfHistory: false,
        clientMessageId: connection.lastHistoryPageClientMessageId,
      ),
    );
    await tester.pumpAndSettle();
  }

  final counter = TranscriptRowWorkCounter();
  debugTranscriptRowWork = counter;
  addTearDown(() => debugTranscriptRowWork = null);
  connection.emitEvent(
    MessageWireEvent(
      seq: 9001,
      message: AgentMessage.fromJson({
        'type': 'model-output',
        'key': 'm2424',
        'text': 'Reply 2424 with a streamed continuation.',
      }),
    ),
  );
  await tester.pumpAndSettle();
  debugTranscriptRowWork = null;
  return counter;
}

void main() {
  group('transcript row presentation stays bounded (H1)', () {
    testWidgets('a live tail delta derives the same rows at any depth', (
      tester,
    ) async {
      final shallow = await _measureLiveDelta(tester, olderPages: 0);
      final shallowRetained = _state(tester).canonicalTranscriptMessages.length;

      final deep = await _measureLiveDelta(tester, olderPages: 4);
      final deepRetained = _state(tester).canonicalTranscriptMessages.length;

      expect(
        deepRetained,
        greaterThan(shallowRetained),
        reason: 'the deep case must really hold more retained history',
      );
      expect(
        deep.derivedRows,
        shallow.derivedRows,
        reason:
            'row identity and canonical-key derivation must depend on what '
            'changed, not on how much history is loaded',
      );
      expect(
        deep.reusedRows,
        greaterThan(shallow.reusedRows),
        reason: 'the extra retained rows must be served from cache',
      );
      // The live tail page is the only run a delta rebuilds, so the derived
      // rows have a named ceiling rather than an incidental one.
      expect(
        deep.derivedRows,
        lessThanOrEqualTo(kTranscriptHistoryPageMessages),
      );
    });

    testWidgets('reconciliation stays inside the retained-window cap', (
      tester,
    ) async {
      final deep = await _measureLiveDelta(tester, olderPages: 4);
      final state = _state(tester);

      expect(
        state.canonicalTranscriptMessages.length,
        lessThanOrEqualTo(kMaxActiveTranscriptMessages),
      );
      // Identity de-duping and the row-key registry are order-sensitive over
      // the whole list, so they stay linear in the RETAINED rows by design.
      // H1 caps that at five pages / 500 messages, and a row is at most one
      // per retained message plus the gap and notice rows, so the per-frame
      // reconciliation cost has a hard ceiling instead of growing with the
      // session's history.
      expect(
        deep.reconciledRows,
        lessThanOrEqualTo(kMaxActiveTranscriptMessages + 8),
      );
    });

    // The transcript renders the inline schedules, so it watches their
    // controller; it must not rebuild for the controller's own bookkeeping.
    // A poll or an onstage return publishes `loading` and then the same empty
    // list, and each of those used to rebuild every row.
    testWidgets(
      'an inline schedule refresh with nothing new rebuilds no rows',
      (
        tester,
      ) async {
        useRoomyTestViewport(tester);
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [
              HistoryWireEvent(messages: _page(0), reset: true, cursor: 'tail'),
            ],
          ),
        );
        await tester.pumpAndSettle();

        final container = ProviderScope.containerOf(
          tester.element(find.byKey(const Key('session-detail-chat-scroll'))),
        );
        final inline = inlineScheduledMessageControllerProvider(
          InlineScheduledMessageKey(
            tool: _sessionKey.tool,
            sessionId: _sessionKey.sessionId,
          ),
        );
        var published = 0;
        final subscription = container.listen(inline, (_, _) => published++);
        addTearDown(subscription.close);
        final counter = TranscriptRowWorkCounter();
        debugTranscriptRowWork = counter;
        addTearDown(() => debugTranscriptRowWork = null);

        await container.read(inline.notifier).refresh(force: true);
        await tester.pumpAndSettle();
        debugTranscriptRowWork = null;

        expect(published, greaterThan(0), reason: 'the refresh really ran');
        expect(container.read(inline).schedules, isEmpty);
        expect(counter.reconciledRows, 0);
      },
    );
  });
}
