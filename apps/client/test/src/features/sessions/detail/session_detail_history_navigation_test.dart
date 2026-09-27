// The controller's side of continuous recovery (contract revision 28): when
// it asks for a boundary refresh and what it does with the answer or the
// refusal, when a reconnect keeps the pages already read, and how a newer page
// is asked for, routed and refused.
//
// Frames follow the broker's cursor rules, as in
// `transcript_history_window_recovery_test.dart`: boundary `bN` sits before
// durable row N, and a reconnect cursor `rN` follows N durable rows.
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_controller_test_harness.dart';

const _key = SessionDetailKey(tool: 'claude', sessionId: 'session-1');

AgentMessage _row(String key, {int chars = 16}) => AgentMessage.fromJson({
  'type': 'model-output',
  'key': key,
  'text': 'x' * chars,
});

List<AgentMessage> _rows(int count) => [
  for (var index = 0; index < count; index++) _row('m$index'),
];

/// A transport that can refresh and page forward, recording each request.
final class _NavigatingConnection extends FakeSessionDetailConnection
    implements SessionHistoryNavigationConnection {
  final refreshes = <({String cursor, String clientMessageId})>[];
  final newerPages =
      <({String cursor, String? until, int? limit, String? clientMessageId})>[];

  /// Whether [requestHistoryRefresh] reports the request as sent.
  bool refreshSends = true;

  /// How often the controller asked the socket to attach again as it was.
  int restarts = 0;

  @override
  Future<void> restartAttach() async {
    restarts += 1;
  }

  @override
  Future<bool> requestHistoryRefresh({
    required String cursor,
    required String clientMessageId,
    int? limit,
  }) async {
    refreshes.add((cursor: cursor, clientMessageId: clientMessageId));
    return refreshSends;
  }

  @override
  Future<void> requestNewerHistoryPage({
    required String cursor,
    String? until,
    int? limit,
    String? clientMessageId,
  }) async {
    newerPages.add((
      cursor: cursor,
      until: until,
      limit: limit,
      clientMessageId: clientMessageId,
    ));
  }
}

final class _Session {
  _Session(this.connection, this.container, this.rows);

  final _NavigatingConnection connection;
  final ProviderContainer container;
  final List<AgentMessage> rows;
  var _seq = 0;

  SessionDetailController get controller =>
      container.read(sessionDetailControllerProvider(_key).notifier);

  SessionDetailState get state =>
      container.read(sessionDetailControllerProvider(_key));

  TranscriptHistoryWindow get window => state.transcriptWindow;

  Future<void> emit(WireEvent event) async {
    connection.emitEvent(event);
    await drainSessionDetailMicrotasks();
  }

  /// Rows [from]..[through] arriving live, one message frame each.
  Future<void> live(int from, int through) async {
    for (var index = from; index < through; index++) {
      connection.emitEvent(
        MessageWireEvent(seq: ++_seq, message: rows[index]),
      );
    }
    await drainSessionDetailMicrotasks();
  }

  HistoryWireEvent attachFrame(
    int from,
    int through, {
    bool newerHistory = true,
  }) => HistoryWireEvent(
    messages: rows.sublist(from, through),
    reset: true,
    cursor: 'r$through',
    olderCursor: from > 0 ? 'b$from' : null,
    hasEarlier: from > 0,
    endCursor: 'b$through',
    newerHistory: newerHistory,
  );

  /// The incremental frame a reconnect or refresh from `r[since]` receives.
  HistoryWireEvent delta(int since, int through, {String? clientMessageId}) =>
      HistoryWireEvent(
        messages: rows.sublist(since, through),
        cursor: 'r$through',
        endCursor: 'b$through',
        newerHistory: true,
        clientMessageId: clientMessageId,
      );

  Future<void> status(String status) => emit(
    SessionWireEvent(
      info: SessionInfo.fromJson({
        'id': 'session-1',
        'tool': 'claude',
        'title': 'Navigation test',
        'status': status,
        'attachMode': 'observe',
      }),
    ),
  );

  /// The socket drops and reconnects; the next frame is the reconnect's own.
  Future<void> reconnect() async {
    connection
      ..emitState(SessionDetailConnectionStatus.reconnecting)
      ..emitState(SessionDetailConnectionStatus.connected);
    await drainSessionDetailMicrotasks();
    await emit(defaultControllerHello);
  }

  int held(String key) => [
    for (final page in window.pages)
      for (final message in page.messages)
        if (message.raw['key'] == key) message,
  ].length;

  bool retains(String key) => held(key) > 0;
}

Future<_Session> _attach({
  Duration? timeout,
  Duration? refreshTimeout,
  Duration? recoveryBackoff,
  int rows = 400,
  int from = 0,
  int through = 10,
  bool newerHistory = true,
}) async {
  final connection = _NavigatingConnection();
  final container = buildControllerContainer(
    _key,
    connection,
    FakeControllerAttachmentPicker(),
    historyPageTimeout: timeout,
    historyRefreshTimeout: refreshTimeout,
    historyCursorRecoveryBackoff: recoveryBackoff,
  );
  addTearDown(container.dispose);
  keepSessionDetailAlive(container, _key);
  final session = _Session(connection, container, _rows(rows));
  await session.controller.attach();
  await session.emit(defaultControllerHello);
  await session.emit(
    session.attachFrame(from, through, newerHistory: newerHistory),
  );
  return session;
}

Future<void> _wait(Duration duration) => Future<void>.delayed(duration);

void main() {
  group('reserved tool result recovery', () {
    AgentMessage slot(String id, {bool pending = true}) =>
        AgentMessage.fromJson({
          'type': 'tool-result',
          'callId': id,
          'toolName': 'bash',
          'historySlot': true,
          'pending': pending,
          if (pending) 'reloadCursor': 'slot-$id',
          if (!pending) 'result': 'finished $id',
        });

    Future<void> seed(_Session session) => session.emit(
      HistoryWireEvent(
        messages: [_row('before'), slot('a'), slot('b'), _row('after')],
        reset: true,
        cursor: 'r4',
        endCursor: 'b4',
        newerHistory: true,
      ),
    );

    Future<void> answer(_Session session, String id, {bool pending = false}) =>
        session.emit(
          HistoryPageWireEvent(
            messages: [slot(id, pending: pending)],
            cursor: 'before-$id',
            hasMore: true,
            endOfHistory: false,
            clientMessageId: session.connection.lastHistoryPageClientMessageId,
          ),
        );

    test(
      'reconnect reloads pending slots one at a time without moving rows',
      () async {
        final session = await _attach();
        await seed(session);
        expect(session.connection.lastHistoryPageCursor, 'slot-a');
        expect(session.connection.lastHistoryPageLimit, 1);
        expect(session.connection.historyPageRequestCount, 1);
        await answer(session, 'a', pending: true);
        expect(session.connection.lastHistoryPageCursor, 'slot-b');
        await answer(session, 'b', pending: true);
        expect(session.connection.historyPageRequestCount, 2);
        await session.reconnect();
        await session.emit(
          const HistoryWireEvent(
            messages: [],
            cursor: 'r4',
            endCursor: 'b4',
            newerHistory: true,
          ),
        );
        expect(session.connection.historyPageRequestCount, 3);
        await answer(session, 'a');
        await answer(session, 'b');
        expect(session.connection.historyPageRequestCount, 4);
        expect(
          session.window.canonicalMessages.map(
            (row) => row.raw['key'] ?? row.toolCallId,
          ),
          ['before', 'a', 'b', 'after'],
        );
        final results = session.window.canonicalMessages.where(
          (row) => row.type == AgentMessageType.toolResult,
        );
        expect(results.map((row) => row.raw['pending']), [false, false]);
        expect(session.window.liveRowsWithoutBoundary.rows, 0);
        expect(session.state.historyPageError, isNull);
      },
    );

    test('live completion wins over a delayed pending response', () async {
      final session = await _attach();
      await seed(session);
      await session.emit(
        MessageWireEvent(seq: 1, message: slot('a', pending: false)),
      );
      await answer(session, 'a', pending: true);
      await answer(session, 'b');
      await session.emit(MessageWireEvent(seq: 2, message: slot('a')));
      final a = session.window.canonicalMessages.singleWhere(
        (row) => row.toolCallId == 'a',
      );
      expect(a.raw['pending'], false);
      expect(a.raw['result'], 'finished a');
    });

    test(
      'a response from before Hello cannot overwrite the new transcript',
      () async {
        final session = await _attach();
        await seed(session);
        final oldId = session.connection.lastHistoryPageClientMessageId;
        await session.reconnect();
        await session.emit(session.attachFrame(0, 3));
        await session.emit(
          HistoryPageWireEvent(
            messages: [slot('a', pending: false)],
            cursor: 'old',
            hasMore: true,
            endOfHistory: false,
            clientMessageId: oldId,
          ),
        );
        expect(session.window.canonicalMessages.map((row) => row.raw['key']), [
          'm0',
          'm1',
          'm2',
        ]);
      },
    );

    test(
      'transient refusal retries after a pause and completion settles it',
      () async {
        final session = await _attach();
        await seed(session);
        await session.emit(
          NackWireEvent(
            code: 'HISTORY_PAGE_SOURCE_CHANGED',
            message: 'still writing',
            clientMessageId: session.connection.lastHistoryPageClientMessageId,
          ),
        );
        expect(session.connection.historyPageRequestCount, 1);
        await _wait(const Duration(milliseconds: 550));
        expect(session.connection.historyPageRequestCount, 2);
        await answer(session, 'a');
        await answer(session, 'b');
        expect(session.connection.historyPageRequestCount, 3);
        expect(session.state.error, isNull);
      },
    );
  });

  group('boundary refresh', () {
    test('asks from the frame reconnect cursor once 50 live rows arrive, one '
        'at a time, and its answer gives those rows their boundary', () async {
      final session = await _attach();
      await session.live(10, 59);
      expect(session.connection.refreshes, isEmpty);
      await session.live(59, 60);
      expect(session.connection.refreshes.single.cursor, 'r10');

      await session.live(60, 90);
      expect(session.connection.refreshes, hasLength(1), reason: 'in flight');

      final id = session.connection.refreshes.single.clientMessageId;
      await session.emit(session.delta(10, 90, clientMessageId: id));
      expect(session.window.historyCursor, 'r90');
      expect(session.window.liveRowsWithoutBoundary.rows, 0);
      expect(session.held('m50'), 1);
      expect(session.state.historyPageError, isNull);

      await session.live(90, 140);
      expect(session.connection.refreshes, hasLength(2));
      expect(session.connection.refreshes.last.cursor, 'r90');
    });

    test('never asks where the frame does not offer newer history (an older '
        'broker)', () async {
      final session = await _attach(newerHistory: false);
      await session.status('working');
      await session.live(10, 90);
      await session.status('idle');
      expect(session.connection.refreshes, isEmpty);
      expect(session.controller.canLoadNewerHistory, isFalse);
    });

    test(
      'the end of a turn asks for the rows that arrived, however few',
      () async {
        final session = await _attach();
        await session.status('working');
        await session.live(10, 13);
        expect(session.connection.refreshes, isEmpty);
        await session.status('idle');
        expect(session.connection.refreshes.single.cursor, 'r10');
      },
    );

    test('after an answer that names nothing new it waits for 25 more rows or '
        'the end of the turn', () async {
      final session = await _attach();
      await session.status('working');
      await session.live(10, 60);
      final first = session.connection.refreshes.single.clientMessageId;
      // Nothing persisted yet.
      await session.emit(session.delta(10, 10, clientMessageId: first));
      await session.live(60, 84);
      expect(session.connection.refreshes, hasLength(1));
      await session.live(84, 85);
      expect(session.connection.refreshes, hasLength(2));

      final second = session.connection.refreshes.last.clientMessageId;
      await session.emit(session.delta(10, 10, clientMessageId: second));
      await session.live(85, 86);
      expect(session.connection.refreshes, hasLength(2));
      await session.status('idle');
      expect(session.connection.refreshes, hasLength(3));
    });

    test('an answer whose rows give no live row a boundary waits like one '
        'that names nothing new', () async {
      final session = await _attach();
      await session.status('working');
      await session.live(10, 60);
      final first = session.connection.refreshes.single.clientMessageId;
      // A saved row the live stream never carried: every live row is still
      // without a boundary, so asking again at once could not help.
      await session.emit(
        HistoryWireEvent(
          messages: [_row('saved-elsewhere')],
          cursor: 'r11',
          endCursor: 'b11',
          newerHistory: true,
          clientMessageId: first,
        ),
      );
      expect(session.window.historyCursor, 'r11');
      expect(session.window.liveRowsWithoutBoundary.rows, 50);
      await session.live(60, 84);
      expect(session.connection.refreshes, hasLength(1));
      await session.live(84, 85);
      expect(session.connection.refreshes, hasLength(2));
      expect(session.connection.refreshes.last.cursor, 'r11');
    });

    test(
      'a slow answer is waited for: nothing more is asked from its cursor '
      'while it can still be answered, and it applies when it comes',
      () async {
        final session = await _attach(
          timeout: const Duration(milliseconds: 20),
        );
        await session.live(10, 60);
        final first = session.connection.refreshes.single;
        await _wait(const Duration(milliseconds: 50));
        await session.live(60, 120);
        await session.status('working');
        await session.status('idle');
        expect(session.connection.refreshes, hasLength(1));

        await session.emit(
          session.delta(10, 100, clientMessageId: first.clientMessageId),
        );
        expect(session.window.historyCursor, 'r100');
        expect(session.held('m60'), 1);
        expect(session.state.historyPageError, isNull);
        await session.live(120, 150);
        expect(session.connection.refreshes, hasLength(2));
        expect(session.connection.refreshes.last.cursor, 'r100');
      },
    );

    test('an answer to no refresh this socket asked for is dropped', () async {
      final session = await _attach();
      await session.live(10, 60);
      final asked = session.connection.refreshes.single;
      await session.emit(session.delta(10, 30, clientMessageId: 'unasked'));
      expect(session.window.historyCursor, 'r10');
      // The one it did ask for is still answerable.
      await session.emit(
        session.delta(10, 60, clientMessageId: asked.clientMessageId),
      );
      expect(session.window.historyCursor, 'r60');
      // And only once.
      await session.emit(
        session.delta(10, 30, clientMessageId: asked.clientMessageId),
      );
      expect(session.window.historyCursor, 'r60');
    });

    test('one asked from a cursor a frame has since moved the window off is '
        'settled: the transport can never deliver its answer, and a late '
        'refusal of it changes nothing', () async {
      final session = await _attach();
      await session.live(10, 60);
      final stale = session.connection.refreshes.single;
      // The broker replaces the history on this socket (a resync).
      await session.emit(
        HistoryWireEvent(
          messages: session.rows.sublist(250, 300),
          reset: true,
          cursor: 'r300',
          olderCursor: 'b250',
          hasEarlier: true,
          endCursor: 'b300',
          newerHistory: true,
        ),
      );
      await session.emit(
        NackWireEvent(
          code: 'NOT_SUPPORTED',
          message: 'refused after the cursor moved',
          clientMessageId: stale.clientMessageId,
        ),
      );
      expect(session.state.error, isNull);
      await session.live(300, 350);
      expect(session.connection.refreshes, hasLength(2));
      expect(session.connection.refreshes.last.cursor, 'r300');
    });

    test('a reset settles every refresh asked before it, so the next is '
        'asked even from a cursor the reset restores', () async {
      final session = await _attach();
      await session.live(10, 60);
      expect(session.connection.refreshes.single.cursor, 'r10');
      // The history is replaced at the same position (the rows after it were
      // reverted); the transport drops any answer to the earlier refresh.
      await session.emit(session.attachFrame(0, 10));
      expect(session.window.historyCursor, 'r10');
      await session.live(60, 110);
      expect(session.connection.refreshes, hasLength(2));
      expect(session.connection.refreshes.last.cursor, 'r10');
    });

    test('a turn that ends while a refresh is unanswered is asked for once '
        'that answer lands', () async {
      final session = await _attach();
      await session.status('working');
      await session.live(10, 60);
      final first = session.connection.refreshes.single;
      await session.live(60, 70);
      await session.status('idle');
      expect(session.connection.refreshes, hasLength(1));
      await session.emit(
        session.delta(10, 60, clientMessageId: first.clientMessageId),
      );
      expect(session.connection.refreshes, hasLength(2));
      expect(session.connection.refreshes.last.cursor, 'r60');
      // Asked once: the next answer that leaves nothing live asks no more.
      await session.emit(
        session.delta(
          60,
          70,
          clientMessageId: session.connection.refreshes.last.clientMessageId,
        ),
      );
      await session.live(70, 71);
      expect(session.connection.refreshes, hasLength(2));
    });

    test('a frame that answers no refresh ends the backoff an empty answer '
        'set', () async {
      final session = await _attach();
      await session.status('working');
      await session.live(10, 60);
      await session.emit(
        session.delta(
          10,
          10,
          clientMessageId: session.connection.refreshes.single.clientMessageId,
        ),
      );
      // A resync on this socket gives every row so far its boundary.
      await session.emit(
        HistoryWireEvent(
          messages: session.rows.sublist(250, 300),
          reset: true,
          cursor: 'r300',
          olderCursor: 'b250',
          hasEarlier: true,
          endCursor: 'b300',
          newerHistory: true,
        ),
      );
      await session.live(300, 350);
      expect(session.connection.refreshes, hasLength(2));
      expect(session.connection.refreshes.last.cursor, 'r300');
    });

    test('a refusal saying the session cannot refresh stops asking for this '
        'attach, is not the reader error, and the next attach asks '
        'again', () async {
      final session = await _attach();
      await session.live(10, 60);
      await session.emit(
        NackWireEvent(
          code: 'NOT_SUPPORTED',
          message: 'live rows are keyed differently from history',
          clientMessageId: session.connection.refreshes.single.clientMessageId,
        ),
      );
      expect(session.state.historyPageError, isNull);
      expect(session.state.historyPageErrorCode, isNull);
      expect(session.state.error, isNull);
      await session.status('working');
      await session.live(60, 150);
      await session.status('idle');
      expect(session.connection.refreshes, hasLength(1));

      await session.reconnect();
      await session.emit(session.delta(10, 150));
      await session.live(150, 200);
      expect(session.connection.refreshes, hasLength(2));
      expect(session.connection.refreshes.last.cursor, 'r150');
    });

    test('a refusal of the cursor waits for the frame that moves it', () async {
      final session = await _attach();
      await session.live(10, 60);
      await session.emit(
        NackWireEvent(
          code: 'HISTORY_CURSOR_GONE',
          message: 'gone',
          clientMessageId: session.connection.refreshes.single.clientMessageId,
        ),
      );
      await session.status('working');
      await session.live(60, 120);
      await session.status('idle');
      expect(session.connection.refreshes, hasLength(1));
      // It was the window's own cursor: the socket attaches again from it.
      expect(session.connection.restarts, 1);

      await session.emit(session.delta(10, 120));
      expect(session.window.historyCursor, 'r120');
      await session.live(120, 170);
      expect(session.connection.refreshes, hasLength(2));
      expect(session.connection.refreshes.last.cursor, 'r120');
    });

    test('any other refusal waits like an empty answer', () async {
      final session = await _attach();
      await session.live(10, 60);
      await session.emit(
        NackWireEvent(
          code: 'RATE_LIMITED',
          message: 'slow down',
          clientMessageId: session.connection.refreshes.single.clientMessageId,
        ),
      );
      await session.live(60, 84);
      expect(session.connection.refreshes, hasLength(1));
      await session.live(84, 85);
      expect(session.connection.refreshes, hasLength(2));
      expect(session.connection.refreshes.last.cursor, 'r10');
    });

    test('one the broker never answers holds back the next only until it is '
        'overdue, and its answer is still taken if it comes', () async {
      final session = await _attach(
        refreshTimeout: const Duration(milliseconds: 40),
      );
      await session.live(10, 60);
      final first = session.connection.refreshes.single.clientMessageId;
      await session.live(60, 90);
      expect(session.connection.refreshes, hasLength(1), reason: 'in flight');

      await _wait(const Duration(milliseconds: 80));
      // Overdue, it counts as an answer that named nothing new.
      await session.live(90, 114);
      expect(session.connection.refreshes, hasLength(1));
      await session.live(114, 115);
      expect(session.connection.refreshes, hasLength(2));
      expect(session.connection.refreshes.last.cursor, 'r10');

      // The slow read finishes after all.
      await session.emit(session.delta(10, 90, clientMessageId: first));
      expect(session.window.historyCursor, 'r90');
      expect(session.held('m50'), 1);
      // The second, asked from the cursor the answer moved past, is moot.
      final second = session.connection.refreshes.last.clientMessageId;
      await session.emit(session.delta(10, 115, clientMessageId: second));
      expect(session.window.historyCursor, 'r90');
      expect(session.held('m100'), 1);
    });

    test('overdue ones stay answerable only as far back as the transport keeps '
        'them', () async {
      final session = await _attach(
        refreshTimeout: const Duration(milliseconds: 1),
      );
      var through = 60;
      await session.live(10, through);
      // Each turn's end asks again, the one before it overdue.
      for (var round = 0; round < 70; round++) {
        await _wait(const Duration(milliseconds: 5));
        await session.status('working');
        await session.live(through, through + 1);
        through += 1;
        await session.status('idle');
      }
      final refreshes = session.connection.refreshes;
      expect(refreshes, hasLength(71));
      expect(refreshes.every((refresh) => refresh.cursor == 'r10'), isTrue);
      // Beyond the newest 64, the transport drops an answer, and so does the
      // window.
      await session.emit(
        session.delta(10, 60, clientMessageId: refreshes[6].clientMessageId),
      );
      expect(session.window.historyCursor, 'r10');
      await session.emit(
        session.delta(10, 60, clientMessageId: refreshes[7].clientMessageId),
      );
      expect(session.window.historyCursor, 'r60');
    });

    test('a request the transport could not send waits for the frame that '
        'moves the cursor', () async {
      final session = await _attach();
      session.connection.refreshSends = false;
      await session.live(10, 60);
      await session.status('working');
      await session.live(60, 100);
      await session.status('idle');
      expect(session.connection.refreshes, hasLength(1));

      session.connection.refreshSends = true;
      await session.emit(session.delta(10, 100));
      await session.live(100, 150);
      expect(session.connection.refreshes, hasLength(2));
      expect(session.connection.refreshes.last.cursor, 'r100');
    });

    test('its answer is not the reader page: a page in flight stays in flight '
        'and still lands', () async {
      final session = await _attach(through: 100);
      await session.reconnect();
      await session.emit(_capped(session));
      final gap = session.window.gaps.single;
      expect(
        await session.controller.loadNewerHistory(
          cursor: gap.forwardCursor!,
          until: gap.reloadCursor!,
        ),
        isTrue,
      );
      await session.live(300, 350);
      final refresh = session.connection.refreshes.single;
      await session.emit(
        session.delta(300, 350, clientMessageId: refresh.clientMessageId),
      );
      expect(session.state.historyPageLoading, isTrue);

      final request = session.connection.newerPages.single;
      await session.emit(_pageAfter(session, request));
      expect(session.state.historyPageLoading, isFalse);
      expect(session.retains('m100'), isTrue);
    });
  });

  group('a refused history read', () {
    test("is not a failed send, and leaves OpenCode's retry notice "
        'standing', () async {
      const key = SessionDetailKey(tool: 'opencode', sessionId: 'session-1');
      final connection = _NavigatingConnection();
      final container = buildControllerContainer(
        key,
        connection,
        FakeControllerAttachmentPicker(),
      );
      addTearDown(container.dispose);
      keepSessionDetailAlive(container, key);
      final controller = container.read(
        sessionDetailControllerProvider(key).notifier,
      );
      SessionDetailState state() =>
          container.read(sessionDetailControllerProvider(key));
      Future<void> emit(WireEvent event) async {
        connection.emitEvent(event);
        await drainSessionDetailMicrotasks();
      }

      final rows = _rows(200);
      await controller.attach();
      await emit(defaultControllerHello);
      await emit(
        HistoryWireEvent(
          messages: rows.sublist(100, 110),
          reset: true,
          cursor: 'r110',
          olderCursor: 'b100',
          hasEarlier: true,
          endCursor: 'b110',
          newerHistory: true,
        ),
      );
      await emit(
        SessionWireEvent(
          info: SessionInfo.fromJson(const {
            'id': 'session-1',
            'tool': 'opencode',
            'title': 'Retry test',
            'status': 'working',
            'attachMode': 'observe',
          }),
        ),
      );
      await emit(
        MessageWireEvent(
          seq: 1,
          message: AgentMessage.fromJson(const {
            'type': 'status',
            'status': 'running',
            'detail': 'provider retry',
          }),
        ),
      );
      expect(state().transientRetryStatus?.providerDetail, 'provider retry');

      expect(await controller.loadEarlierHistory(), isTrue);
      await emit(
        NackWireEvent(
          code: 'HISTORY_PAGE_SOURCE_CHANGED',
          message: 'Try again.',
          clientMessageId: connection.lastHistoryPageClientMessageId,
        ),
      );
      expect(state().historyPageErrorCode, 'HISTORY_PAGE_SOURCE_CHANGED');
      expect(state().error, isNull);
      expect(state().transientRetryStatus?.providerDetail, 'provider retry');

      for (var index = 110; index < 160; index++) {
        connection.emitEvent(
          MessageWireEvent(seq: index, message: rows[index]),
        );
      }
      await drainSessionDetailMicrotasks();
      await emit(
        NackWireEvent(
          code: 'HISTORY_PAGE_SOURCE_CHANGED',
          message: 'Try again.',
          clientMessageId: connection.refreshes.single.clientMessageId,
        ),
      );
      expect(state().error, isNull);
    });
  });

  group('a history position the broker no longer has', () {
    test('stops the range it is an edge of from loading either way, while '
        'every other range pages as usual, until a frame replaces the window '
        'positions', () async {
      final session = await _attach(from: 50, through: 100);
      await session.reconnect();
      await session.emit(_capped(session));
      final gap = session.window.gaps.single;
      expect(
        await session.controller.loadEarlierHistory(cursor: gap.reloadCursor),
        isTrue,
      );
      final asked = session.connection.historyPageRequestCount;
      await session.emit(
        NackWireEvent(
          code: 'HISTORY_CURSOR_DIVERGED',
          message: 'backward history cursor no longer matches this session',
          clientMessageId: session.connection.lastHistoryPageClientMessageId,
        ),
      );
      expect(session.state.historyPageError, isNull);
      expect(session.state.historyRefusedCursors, {
        gap.reloadCursor: 'HISTORY_CURSOR_DIVERGED',
      });
      expect(session.state.historyGapRefused(gap), isTrue);
      expect(
        await session.controller.loadEarlierHistory(cursor: gap.reloadCursor),
        isFalse,
      );
      expect(
        await session.controller.loadNewerHistory(
          cursor: gap.forwardCursor!,
          until: gap.reloadCursor!,
        ),
        isFalse,
      );
      expect(session.connection.historyPageRequestCount, asked);
      expect(session.connection.newerPages, isEmpty);
      // The rows before the gap still page back.
      expect(session.state.olderHistoryCursor, 'b50');
      expect(session.state.olderHistoryRefusal, isNull);
      expect(await session.controller.loadEarlierHistory(), isTrue);
      expect(session.connection.historyPageRequestCount, asked + 1);
      // A page position is not the window's reconnect cursor: no restart.
      expect(session.connection.restarts, 0);

      await session.reconnect();
      await session.emit(session.delta(300, 310));
      expect(session.state.historyRefusedCursors, isEmpty);
      final reopened = session.window.gaps.single;
      expect(
        await session.controller.loadNewerHistory(
          cursor: reopened.forwardCursor!,
          until: reopened.reloadCursor!,
        ),
        isTrue,
      );
    });

    test('attaches again when it is the window reconnect cursor, once per '
        'attach and not again until the backoff has passed', () async {
      const backoff = Duration(milliseconds: 60);
      final session = await _attach(recoveryBackoff: backoff);
      var through = 10;
      // An attach from a cursor the broker still has, then enough live rows
      // for a refresh, which the broker refuses: it no longer has the cursor.
      Future<void> attachAndRefuse({required bool reconnect}) async {
        if (reconnect) {
          await session.reconnect();
          await session.emit(session.attachFrame(through - 10, through));
        }
        await session.live(through, through + 50);
        expect(session.connection.refreshes.last.cursor, 'r$through');
        through += 50;
        await session.emit(
          NackWireEvent(
            code: 'HISTORY_CURSOR_GONE',
            message: 'gone',
            clientMessageId: session.connection.refreshes.last.clientMessageId,
          ),
        );
      }

      await attachAndRefuse(reconnect: false);
      expect(session.connection.restarts, 1);
      // The attach it started refuses too, after the backoff: that attach
      // does not start another.
      await _wait(backoff * 1.5);
      await attachAndRefuse(reconnect: true);
      expect(session.connection.restarts, 1);
      // Any other attach may.
      await attachAndRefuse(reconnect: true);
      expect(session.connection.restarts, 2);
      // Not within the backoff, though.
      await attachAndRefuse(reconnect: true);
      await attachAndRefuse(reconnect: true);
      expect(session.connection.restarts, 2);
      await _wait(backoff * 1.5);
      await attachAndRefuse(reconnect: true);
      expect(session.connection.restarts, 3);
    });
  });

  group('a capped reconnect', () {
    test('keeps the pages already read, with the gap between loadable from '
        'its older edge, when the reconnect frame offers newer '
        'history', () async {
      final session = await _attach(through: 100);
      await session.reconnect();
      await session.emit(_capped(session));
      expect(session.retains('m0'), isTrue);
      expect(session.retains('m250'), isTrue);
      final gap = session.window.gaps.single;
      expect(gap.kind, TranscriptHistoryGapKind.reloadable);
      expect(gap.forwardCursor, 'b100');
      expect(gap.reloadCursor, 'b250');
      expect(session.controller.canLoadNewerHistory, isTrue);
      expect(session.window.reloadsOnlyForward('b250'), isTrue);
    });

    test('replaces the window when the reconnect frame does not offer newer '
        'history', () async {
      final session = await _attach(through: 100);
      await session.reconnect();
      await session.emit(_capped(session, newerHistory: false));
      expect(session.retains('m0'), isFalse);
      expect(session.retains('m250'), isTrue);
    });

    test('replaces a window hydrated from the local snapshot: its rows '
        'carry no boundary this controller received', () async {
      final connection = _NavigatingConnection();
      final rows = _rows(400);
      final repository = RecordingSessionTranscriptRepository()
        ..stored = SessionTranscriptSnapshot(
          brokerProfileId: fakeControllerBrokerScope(),
          sessionKey: _key,
          messages: rows.sublist(100, 150),
          cursor: 'r150',
          olderCursor: 'b100',
          hasEarlier: true,
          updatedAt: DateTime(2026, 9, 2),
        );
      final container = buildControllerContainer(
        _key,
        connection,
        FakeControllerAttachmentPicker(),
        transcriptRepository: repository,
      );
      addTearDown(container.dispose);
      keepSessionDetailAlive(container, _key);
      final session = _Session(connection, container, rows);
      await session.controller.attach();
      await drainSessionDetailMicrotasks();
      expect(session.window.historyCursor, 'r150');
      expect(connection.seededHistoryCursor, 'r150');
      await session.emit(defaultControllerHello);
      // The broker validated r150, but 250 rows were persisted since: its
      // first frame is capped, with no gap.
      await session.emit(
        HistoryWireEvent(
          messages: rows.sublist(300, 400),
          reset: true,
          cursor: 'r400',
          olderCursor: 'b300',
          hasEarlier: true,
          endCursor: 'b400',
          newerHistory: true,
        ),
      );
      expect(session.retains('m100'), isFalse);
      expect(session.retains('m149'), isFalse);
      expect(session.window.gaps, isEmpty);
      expect(session.window.releasedRanges, isEmpty);
      expect(session.window.pages.single.olderCursor, 'b300');
      expect(session.state.messageEvents.first.raw['key'], 'm300');

      // A later capped reconnect of that live window keeps it.
      final more = _rows(700);
      await session.reconnect();
      await session.emit(
        HistoryWireEvent(
          messages: more.sublist(650, 700),
          reset: true,
          cursor: 'r700',
          olderCursor: 'b650',
          hasEarlier: true,
          endCursor: 'b700',
          newerHistory: true,
        ),
      );
      expect(session.retains('m300'), isTrue);
      expect(session.window.gaps.single.forwardCursor, 'b400');
    });

    test('replaces the window on a reset that is not the reconnect own '
        'frame', () async {
      final session = await _attach(through: 100);
      await session.emit(_capped(session));
      expect(session.retains('m0'), isFalse);
    });

    test(
      'replaces the window on a reset after the reconnect own frame',
      () async {
        final session = await _attach(through: 100);
        await session.reconnect();
        // The reconnect was answered incrementally; a later reset (after a
        // compaction, say) is no capped reconnect.
        await session.emit(session.delta(100, 120));
        expect(session.window.historyCursor, 'r120');
        await session.emit(_capped(session));
        expect(session.retains('m0'), isFalse);
        expect(session.retains('m250'), isTrue);
      },
    );

    test('fills the gap with newer pages that never claim the start of the '
        'session', () async {
      final session = await _attach(through: 100);
      await session.reconnect();
      await session.emit(_capped(session));
      var gap = session.window.gaps.single;
      expect(
        await session.controller.loadNewerHistory(
          cursor: gap.forwardCursor!,
          until: gap.reloadCursor!,
        ),
        isTrue,
      );
      final request = session.connection.newerPages.single;
      expect(request.cursor, 'b100');
      expect(request.until, 'b250');
      expect(request.limit, kTranscriptHistoryPageMessages);
      expect(session.connection.historyPageRequestCount, 0);

      await session.emit(_pageAfter(session, request));
      expect(session.state.historyPageLoading, isFalse);
      expect(session.held('m100'), 1);
      gap = session.window.gaps.single;
      expect(gap.forwardCursor, 'b200');
      expect(gap.reloadCursor, 'b250');

      // Whatever a newer page says of the end it reached (here, as if the
      // gap ran to the current end), that end is never the session start.
      expect(
        await session.controller.loadNewerHistory(
          cursor: gap.forwardCursor!,
          until: gap.reloadCursor!,
        ),
        isTrue,
      );
      final last = _pageAfter(session, session.connection.newerPages.last);
      expect(last.cursor, 'b250');
      await session.emit(
        HistoryPageWireEvent(
          messages: last.messages,
          cursor: last.cursor,
          hasMore: false,
          endOfHistory: true,
          isNewer: true,
          clientMessageId: last.clientMessageId,
        ),
      );
      expect(session.state.historyStartReached, isFalse);
      expect(session.window.gaps, isEmpty);
      for (final key in ['m0', 'm100', 'm200', 'm249', 'm250']) {
        expect(session.held(key), 1, reason: key);
      }
    });
  });

  group('newer pages', () {
    test('an older page answering a newer request is refused, and newer '
        'paging stays off until the next attach', () async {
      final session = await _attach(through: 100);
      await session.reconnect();
      await session.emit(_capped(session));
      final gap = session.window.gaps.single;
      await session.controller.loadNewerHistory(
        cursor: gap.forwardCursor!,
        until: gap.reloadCursor!,
      );
      final request = session.connection.newerPages.single;
      await session.emit(
        HistoryPageWireEvent(
          messages: session.rows.sublist(150, 250),
          cursor: 'b150',
          hasMore: true,
          endOfHistory: false,
          clientMessageId: request.clientMessageId,
        ),
      );
      expect(session.retains('m150'), isFalse);
      expect(session.state.historyPageLoading, isFalse);
      expect(session.controller.canLoadNewerHistory, isFalse);
      expect(
        await session.controller.loadNewerHistory(
          cursor: gap.forwardCursor!,
          until: gap.reloadCursor!,
        ),
        isFalse,
      );
      expect(session.connection.newerPages, hasLength(1));

      await session.reconnect();
      await session.emit(session.delta(300, 300));
      expect(session.controller.canLoadNewerHistory, isTrue);
    });

    test('share one request slot with older pages', () async {
      final session = await _attach(through: 100);
      await session.reconnect();
      await session.emit(_capped(session));
      final gap = session.window.gaps.single;
      expect(
        await session.controller.loadNewerHistory(
          cursor: gap.forwardCursor!,
          until: gap.reloadCursor!,
        ),
        isTrue,
      );
      expect(
        await session.controller.loadEarlierHistory(cursor: gap.reloadCursor),
        isFalse,
      );
      expect(
        await session.controller.loadNewerHistory(
          cursor: gap.forwardCursor!,
          until: gap.reloadCursor!,
        ),
        isFalse,
      );
      expect(session.connection.historyPageRequestCount, 0);
      expect(session.connection.newerPages, hasLength(1));
    });

    test('one too large for the budget is asked for again smaller, in the '
        'same direction', () async {
      final session = await _attach(through: 100);
      await session.reconnect();
      await session.emit(_capped(session));
      session.controller.protectHistoryViewportAnchor(
        stableTranscriptMessageKey(session.rows[0]),
      );
      final gap = session.window.gaps.single;
      await session.controller.loadNewerHistory(
        cursor: gap.forwardCursor!,
        until: gap.reloadCursor!,
      );
      final request = session.connection.newerPages.single;
      await session.emit(
        HistoryPageWireEvent(
          messages: [
            for (var index = 0; index < 100; index++)
              _row('wide$index', chars: 30000),
          ],
          cursor: 'b200',
          hasMore: true,
          endOfHistory: false,
          isNewer: true,
          clientMessageId: request.clientMessageId,
        ),
      );
      await drainSessionDetailMicrotasks();
      expect(session.retains('wide0'), isFalse);
      expect(session.connection.newerPages, hasLength(2));
      final retry = session.connection.newerPages.last;
      expect(retry.cursor, request.cursor);
      expect(retry.until, request.until);
      expect(retry.limit, request.limit! ~/ 2);
      expect(session.connection.historyPageRequestCount, 0);
    });

    test('one that brings nothing and ends where it was asked from changes '
        'nothing, fails as a failure that can pass, and is asked for again '
        'by nobody but the reader', () async {
      final session = await _attach(through: 100);
      await session.reconnect();
      await session.emit(_capped(session));
      final gap = session.window.gaps.single;
      final pages = session.window.pages.length;
      final held = session.window.canonicalMessages.length;
      final released = Map.of(session.window.releasedRanges);
      for (var attempt = 0; attempt < 50; attempt++) {
        expect(
          await session.controller.loadNewerHistory(
            cursor: gap.forwardCursor!,
            until: gap.reloadCursor!,
          ),
          isTrue,
        );
        expect(session.connection.newerPages, hasLength(attempt + 1));
        final request = session.connection.newerPages.last;
        final before = session.window;
        await session.emit(
          HistoryPageWireEvent(
            messages: const [],
            cursor: request.cursor,
            hasMore: true,
            endOfHistory: false,
            isNewer: true,
            clientMessageId: request.clientMessageId,
          ),
        );
        expect(identical(session.window, before), isTrue);
        expect(session.state.historyPageLoading, isFalse);
        expect(session.state.historyPageError, isNotNull);
        expect(session.state.historyPageErrorCode, kHistoryPageNoProgressCode);
        expect(
          isTransientHistoryPageErrorCode(session.state.historyPageErrorCode),
          isTrue,
        );
        expect(
          isTerminalHistoryPageErrorCode(session.state.historyPageErrorCode),
          isFalse,
        );
        await drainSessionDetailMicrotasks();
        // The controller asks again for nothing by itself.
        expect(session.connection.newerPages, hasLength(attempt + 1));
      }
      expect(session.window.pages, hasLength(pages));
      expect(session.window.canonicalMessages, hasLength(held));
      expect(session.window.releasedRanges, released);
      expect(session.window.gaps.single.forwardCursor, gap.forwardCursor);
      expect(session.connection.historyPageRequestCount, 0);
      expect(session.controller.canLoadNewerHistory, isTrue);

      // The page it should have been still fills the gap, and clears the
      // failure.
      await session.controller.loadNewerHistory(
        cursor: gap.forwardCursor!,
        until: gap.reloadCursor!,
      );
      await session.emit(
        _pageAfter(session, session.connection.newerPages.last),
      );
      expect(session.state.historyPageError, isNull);
      expect(session.held('m100'), 1);
      expect(session.window.gaps.single.forwardCursor, 'b200');
    });

    test('an older page that brings nothing and ends where it was asked from '
        'changes nothing either', () async {
      final session = await _attach(from: 100, through: 200);
      final cursor = session.window.olderHistoryCursor!;
      final before = session.window;
      for (var attempt = 0; attempt < 50; attempt++) {
        expect(
          await session.controller.loadEarlierHistory(cursor: cursor),
          isTrue,
        );
        expect(session.connection.historyPageRequestCount, attempt + 1);
        await session.emit(
          HistoryPageWireEvent(
            messages: const [],
            cursor: cursor,
            hasMore: true,
            endOfHistory: false,
            clientMessageId: session.connection.lastHistoryPageClientMessageId,
          ),
        );
        expect(identical(session.window, before), isTrue);
        expect(session.state.historyPageLoading, isFalse);
        expect(session.state.historyPageErrorCode, kHistoryPageNoProgressCode);
        expect(session.state.historyStartReached, isFalse);
        await drainSessionDetailMicrotasks();
        expect(session.connection.historyPageRequestCount, attempt + 1);
      }
      expect(session.window.pages, hasLength(1));
      expect(session.window.olderHistoryCursor, cursor);
    });

    test('are not asked for where the broker does not page forward', () async {
      final session = await _attach(through: 100, newerHistory: false);
      expect(
        await session.controller.loadNewerHistory(
          cursor: 'b100',
          until: 'b250',
        ),
        isFalse,
      );
      expect(session.connection.newerPages, isEmpty);
      expect(session.state.historyPageLoading, isFalse);
    });
  });
  // Brokers without newer history. A revision-27 broker (the newest published
  // revision) is inside the one-revision overlap window: its hello says
  // `broker-behind`, writable. A shipped revision-26 broker is two revisions
  // away: its hello says `hard-incompatible`, read-only, and the session can
  // still be read. Neither frame names an end cursor or newer history, so the
  // client behaves as it did before revision 28: no refresh, no newer page,
  // and a capped reconnect replaces the window.
  for (final (:revision, :surfaceHash, :status, :readOnly, :reason) in const [
    (
      revision: 27,
      surfaceHash: 'fnv1a32:63d88dbb',
      status: BrokerClientCompatibilityStatus.brokerBehind,
      readOnly: false,
      reason: 'broker contract 27 is behind client contract 28',
    ),
    (
      revision: 26,
      surfaceHash: 'fnv1a32:caf34ce7',
      status: BrokerClientCompatibilityStatus.hardIncompatible,
      readOnly: true,
      reason:
          'contract revisions differ by more than the 1-revision overlap '
          'window',
    ),
  ]) {
    group('against a revision-$revision broker', () {
      final broker = BrokerContractIdentity(
        revision: revision,
        minimumClientRevision: 17,
        surfaceHash: surfaceHash,
      );
      final brokerHello = HelloWireEvent(
        brokerVersion: revision == 26 ? '0.5.13' : '0.5.14',
        brokerContract: broker,
        compatibility: BrokerClientCompatibility(
          status: status,
          readOnly: readOnly,
          reason: reason,
          broker: broker,
        ),
      );

      test(
        'is ${readOnly ? 'read-only' : 'writable'}, never refreshes or '
        'pages forward, and a capped reconnect replaces the window',
        () async {
          final connection = _NavigatingConnection();
          final container = buildControllerContainer(
            _key,
            connection,
            FakeControllerAttachmentPicker(),
          );
          addTearDown(container.dispose);
          keepSessionDetailAlive(container, _key);
          final session = _Session(connection, container, _rows(400));
          await session.controller.attach();
          await session.emit(brokerHello);
          await session.emit(
            HistoryWireEvent(
              messages: session.rows.sublist(50, 100),
              reset: true,
              cursor: 'r100',
              olderCursor: 'b50',
              hasEarlier: true,
            ),
          );
          expect(session.state.compatibilityReadOnly, readOnly);
          expect(session.state.hello?.compatibility.status, status);

          await session.status('working');
          await session.live(100, 180);
          await session.status('idle');
          expect(connection.refreshes, isEmpty);
          expect(session.controller.canLoadNewerHistory, isFalse);

          connection
            ..emitState(SessionDetailConnectionStatus.reconnecting)
            ..emitState(SessionDetailConnectionStatus.connected);
          await drainSessionDetailMicrotasks();
          await session.emit(brokerHello);
          await session.emit(
            HistoryWireEvent(
              messages: session.rows.sublist(250, 300),
              reset: true,
              cursor: 'r300',
              olderCursor: 'b250',
              hasEarlier: true,
            ),
          );
          expect(session.retains('m50'), isFalse);
          expect(session.retains('m150'), isFalse);
          expect(session.retains('m250'), isTrue);
          expect(session.window.gaps, isEmpty);
          expect(session.window.pages.first.olderCursor, 'b250');
          expect(
            await session.controller.loadNewerHistory(
              cursor: 'b100',
              until: 'b250',
            ),
            isFalse,
          );
          await session.live(300, 360);
          expect(connection.refreshes, isEmpty);
          expect(connection.newerPages, isEmpty);

          // Older paging, which that broker does serve, still works.
          expect(await session.controller.loadEarlierHistory(), isTrue);
          expect(connection.historyPageRequestCount, 1);
          expect(connection.lastHistoryPageCursor, 'b250');
        },
      );
    });
  }
}

/// The reconnect frame for a session that persisted rows 100..299 while the
/// socket was down: the broker caps it to the newest 50.
HistoryWireEvent _capped(_Session session, {bool newerHistory = true}) =>
    HistoryWireEvent(
      messages: session.rows.sublist(250, 300),
      reset: true,
      cursor: 'r300',
      olderCursor: 'b250',
      hasEarlier: true,
      endCursor: 'b300',
      newerHistory: newerHistory,
    );

/// The broker's answer to [request]: rows forward from its cursor, stopping at
/// its `until` and naming it verbatim when reached.
HistoryPageWireEvent _pageAfter(
  _Session session,
  ({String cursor, String? until, int? limit, String? clientMessageId}) request,
) {
  final from = int.parse(request.cursor.substring(1));
  final stop = int.parse(request.until!.substring(1));
  final through = from + request.limit! < stop ? from + request.limit! : stop;
  return HistoryPageWireEvent(
    messages: session.rows.sublist(from, through),
    cursor: through == stop ? request.until : 'b$through',
    hasMore: true,
    endOfHistory: false,
    isNewer: true,
    clientMessageId: request.clientMessageId,
  );
}
