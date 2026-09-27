// Continuous recovery for the bounded transcript window (contract revision
// 28): boundary refreshes for live rows, newer pages into gaps, capped
// reconnects that keep what was read, and rows no reload returns kept in
// place or announced — never dropped silently.
//
// Frames and pages follow the broker's cursor rules: boundary `bN` sits
// before durable row N and is the same string wherever it is named; a
// reconnect cursor `rN` follows N durable rows; a backward page walks back its
// pageable rows; a newer page walks forward and names `until` verbatim when it
// reaches it (broker suite `history-cap` cases 17 and 18).
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_controller.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:flutter_test/flutter_test.dart';

AgentMessage row(String key, {int chars = 16, String type = 'model-output'}) =>
    AgentMessage.fromJson({'type': type, 'key': key, 'text': 'x' * chars});

List<AgentMessage> rows(String prefix, int count, {int start = 0}) => [
  for (var index = start; index < start + count; index++) row('$prefix$index'),
];

AgentMessage toolCall(String id) => AgentMessage.fromJson({
  'type': 'tool-call',
  'callId': id,
  'toolName': 'Bash',
  'args': const <String, Object?>{},
});

AgentMessage toolResult(String id) => AgentMessage.fromJson({
  'type': 'tool-result',
  'callId': id,
  'toolName': 'Bash',
  'result': 'ok',
});

/// An approval pair: the agent never persists either row.
List<AgentMessage> approval(String id) => [
  AgentMessage.fromJson({
    'type': 'permission-request',
    'requestId': id,
    'title': 'Run Bash?',
  }),
  AgentMessage.fromJson({
    'type': 'permission-resolved',
    'requestId': id,
    'decision': 'allow',
  }),
];

String keyOf(String key) => 'model-output:key:$key';

TranscriptHistoryWindow live(
  TranscriptHistoryWindow window,
  Iterable<AgentMessage> messages, {
  String? reading,
}) {
  var next = window;
  for (final message in messages) {
    next = next.applyLiveMessage(message, protectedKey: reading);
  }
  return next;
}

List<TranscriptHistoryGapSegment> gapsOf(TranscriptHistoryWindow window) => [
  ?window.leadingGap,
  ...window.gaps,
];

int gapsOfKind(TranscriptHistoryWindow window, TranscriptHistoryGapKind kind) =>
    gapsOf(window).where((gap) => gap.kind == kind).length;

int reconnectGaps(TranscriptHistoryWindow window) =>
    gapsOfKind(window, TranscriptHistoryGapKind.reconnectRequired);

int unsavedGaps(TranscriptHistoryWindow window) =>
    gapsOfKind(window, TranscriptHistoryGapKind.unsavedReleased);

/// How many retained rows carry [key] (a model-output key, or a full stable
/// key), duplicates included.
int held(TranscriptHistoryWindow window, String key) => [
  for (final page in window.pages)
    for (final message in page.messages)
      if (message.raw['key'] == key ||
          stableTranscriptMessageKey(message) == key)
        message,
].length;

bool retainsKey(TranscriptHistoryWindow window, String key) =>
    window.canonicalMessages.any((message) => message.raw['key'] == key);

bool retainsRequest(TranscriptHistoryWindow window, String id) =>
    window.canonicalMessages.any((message) => message.raw['requestId'] == id);

/// The row keys (or request ids) in reading order.
List<Object?> order(TranscriptHistoryWindow window) => [
  for (final message in window.canonicalMessages)
    message.raw['key'] ?? message.raw['requestId'] ?? message.raw['callId'],
];

/// A broker's durable history with the broker's cursor rules.
final class Native {
  Native(this.rows);

  final List<AgentMessage> rows;

  static int boundary(String? cursor) =>
      cursor == null ? 0 : int.parse(cursor.substring(1));

  HistoryWireEvent attach(int from, int through) => HistoryWireEvent(
    messages: rows.sublist(from, through),
    reset: true,
    cursor: 'r$through',
    olderCursor: from > 0 ? 'b$from' : null,
    hasEarlier: from > 0,
    endCursor: 'b$through',
    newerHistory: true,
  );

  /// The frame a reconnect or a boundary refresh from `r[since]` receives.
  HistoryWireEvent delta(int since, int through, {String? clientMessageId}) =>
      HistoryWireEvent(
        messages: rows.sublist(since, through),
        cursor: 'r$through',
        endCursor: 'b$through',
        newerHistory: true,
        clientMessageId: clientMessageId,
      );

  int pageable(String? older, String newer) => [
    for (var index = boundary(older); index < boundary(newer); index++)
      if (isBackwardPageableTranscriptMessage(rows[index])) index,
  ].length;

  HistoryPageWireEvent pageBefore(String cursor, int limit) {
    var at = boundary(cursor);
    final page = <AgentMessage>[];
    while (at > 0 && page.length < limit) {
      at -= 1;
      if (isBackwardPageableTranscriptMessage(rows[at])) {
        page.insert(0, rows[at]);
      }
    }
    return HistoryPageWireEvent(
      messages: page,
      cursor: at > 0 ? 'b$at' : null,
      hasMore: at > 0,
      endOfHistory: at == 0,
    );
  }

  HistoryPageWireEvent pageAfter(String cursor, String until, int limit) {
    final stop = boundary(until);
    var at = boundary(cursor);
    final page = <AgentMessage>[];
    while (at < stop && page.length < limit) {
      final message = rows[at];
      at += 1;
      if (isBackwardPageableTranscriptMessage(message)) page.add(message);
    }
    while (at < stop && !isBackwardPageableTranscriptMessage(rows[at])) {
      at += 1;
    }
    return HistoryPageWireEvent(
      messages: page,
      cursor: at == stop ? until : 'b$at',
      hasMore: at < rows.length,
      endOfHistory: at >= rows.length,
      isNewer: true,
    );
  }
}

/// No durable row is held twice, and the rows held read in persisted order.
void expectHeldOnceInNativeOrder(
  TranscriptHistoryWindow window,
  Native native,
) {
  final position = <String, int>{
    for (final (index, message) in native.rows.indexed)
      ?stableTranscriptMessageKey(message): index,
  };
  final seen = <String>{};
  for (final page in window.pages) {
    for (final message in page.messages) {
      final key = stableTranscriptMessageKey(message);
      if (key == null) continue;
      expect(seen.add(key), isTrue, reason: 'held twice: $key');
    }
  }
  final at = [
    for (final message in window.canonicalMessages)
      ?position[stableTranscriptMessageKey(message)],
  ];
  expect(at, [...at]..sort());
}

/// Every range the window can reload asks for exactly its broker rows.
void expectExactRanges(TranscriptHistoryWindow window, Native native) {
  for (final page in window.pages) {
    final end = page.isTail ? page.blockEndCursor : page.newerCursor;
    final count = page.isTail ? page.blockPageableRows : page.reloadLimit;
    if (end == null || count == null || page.isResidue || page.headReleased) {
      continue;
    }
    expect(count, native.pageable(page.olderCursor, end));
  }
  for (final MapEntry(key: newer, value: range)
      in window.releasedRanges.entries) {
    // No range ends before it starts, whatever its count.
    expect(
      Native.boundary(range.olderCursor),
      lessThanOrEqualTo(Native.boundary(newer)),
      reason: 'released ${range.olderCursor}..$newer',
    );
    if (range.pageableRows == null) continue;
    expect(
      range.pageableRows,
      native.pageable(range.olderCursor, newer),
      reason: 'released ${range.olderCursor}..$newer',
    );
  }
}

/// Fills every reloadable gap from its older edge with newer pages, as a
/// reader moving down does (reading each page's last row as it lands),
/// checking the ranges after each page.
TranscriptHistoryWindow fillForward(
  TranscriptHistoryWindow window,
  Native native, {
  String? reading,
}) {
  var next = window;
  var reader = reading;
  for (var round = 0; round < 200; round++) {
    final gap = next.gaps
        .where((gap) => gap.kind == TranscriptHistoryGapKind.reloadable)
        .firstOrNull;
    if (gap == null) return next;
    final from = gap.forwardCursor!;
    final mutation = next.insertNewerPage(
      native.pageAfter(
        from,
        gap.reloadCursor!,
        next.forwardReloadLimitFor(from) ?? kTranscriptHistoryPageMessages,
      ),
      requestedCursor: from,
      until: gap.reloadCursor!,
      preserveMessageKey: reader,
    );
    expect(mutation.accepted, isTrue, reason: 'newer page from $from');
    next = mutation.window;
    final landed = next.pages.firstWhere((page) => page.olderCursor == from);
    if (landed.messages.isNotEmpty) {
      reader = stableTranscriptMessageKey(landed.messages.last);
    }
    expectExactRanges(next, native);
    expectHeldOnceInNativeOrder(next, native);
  }
  fail('newer pages did not converge');
}

/// Reloads every reloadable gap and the leading edge from their newer edges,
/// as a reader scrolling up does.
TranscriptHistoryWindow reloadBack(
  TranscriptHistoryWindow window,
  Native native, {
  String? reading,
}) {
  var next = window;
  for (var round = 0; round < 64; round++) {
    final gap = next.gaps
        .where((gap) => gap.kind == TranscriptHistoryGapKind.reloadable)
        .firstOrNull;
    final cursor =
        gap?.reloadCursor ??
        (next.leadingEdgeReleased ? null : next.olderHistoryCursor);
    if (cursor == null) return next;
    final mutation = next.prependPage(
      native.pageBefore(
        cursor,
        next.reloadLimitFor(cursor) ?? kTranscriptHistoryPageMessages,
      ),
      requestedCursor: cursor,
      preserveMessageKey: reading,
    );
    expect(mutation.accepted, isTrue, reason: 'older page at $cursor');
    next = mutation.window;
    expectExactRanges(next, native);
    expectHeldOnceInNativeOrder(next, native);
  }
  fail('older pages did not converge');
}

/// Streams [messages] live, answering a boundary refresh whenever the
/// client's policy asks for one. Rows persist as they are sent.
TranscriptHistoryWindow streamWithRefresh(
  TranscriptHistoryWindow window,
  Native native,
  Iterable<AgentMessage> messages, {
  String? reading,
  void Function(TranscriptHistoryWindow window)? afterEach,
}) {
  var next = window;
  for (final message in messages) {
    next = next.applyLiveMessage(message, protectedKey: reading);
    if (historyRefreshDue(
      live: next.liveRowsWithoutBoundary,
      turnEnded: false,
    )) {
      final since = int.parse(next.historyCursor!.substring(1));
      final persisted = native.rows.indexWhere(
        (row) =>
            stableTranscriptMessageKey(row) ==
            stableTranscriptMessageKey(message),
      );
      final through = persisted + 1 < since + 100 ? persisted + 1 : since + 100;
      next = next.applyHistory(
        native.delta(since, through, clientMessageId: 'refresh-$since'),
        preserveMessageKey: reading,
      );
    }
    afterEach?.call(next);
  }
  return next;
}

void main() {
  group('boundary refresh', () {
    test('rows received live past the boundary are what a refresh counts', () {
      final native = Native([...rows('a', 10), ...rows('l', 20)]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 10));
      window = live(window, native.rows.sublist(10, 30));
      expect(window.liveRowsWithoutBoundary.rows, 20);
      expect(window.liveRowsWithoutBoundary.bytes, greaterThan(0));
      // A status tick is never rendered, so no refresh has to place it.
      window = window.applyLiveMessage(
        AgentMessage.fromJson(const {'type': 'status', 'status': 'running'}),
      );
      expect(window.liveRowsWithoutBoundary.rows, 20);

      window = window.applyHistory(native.delta(10, 25));
      expect(window.liveRowsWithoutBoundary.rows, 5);
      expect(window.historyCursor, 'r25');
    });

    test('the policy asks at 50 rows, at a quarter of the budget in bytes, and '
        'when the turn ends, and waits after an answer that named nothing', () {
      expect(
        historyRefreshDue(live: (rows: 49, bytes: 0), turnEnded: false),
        isFalse,
      );
      expect(
        historyRefreshDue(live: (rows: 50, bytes: 0), turnEnded: false),
        isTrue,
      );
      expect(
        historyRefreshDue(
          live: (rows: 1, bytes: kMaxActiveTranscriptDecodedBytes ~/ 4),
          turnEnded: false,
        ),
        isTrue,
      );
      expect(
        historyRefreshDue(live: (rows: 1, bytes: 0), turnEnded: true),
        isTrue,
      );
      expect(
        historyRefreshDue(live: (rows: 0, bytes: 0), turnEnded: true),
        isFalse,
      );
      const backoff = (rows: 60, bytes: 1000);
      expect(
        historyRefreshDue(
          live: (rows: 84, bytes: 1000),
          turnEnded: false,
          backoff: backoff,
        ),
        isFalse,
      );
      expect(
        historyRefreshDue(
          live: (rows: 85, bytes: 1000),
          turnEnded: false,
          backoff: backoff,
        ),
        isTrue,
      );
      expect(
        historyRefreshDue(
          live: (rows: 61, bytes: 1000 + kMaxActiveTranscriptDecodedBytes ~/ 8),
          turnEnded: false,
          backoff: backoff,
        ),
        isTrue,
      );
      expect(
        historyRefreshDue(
          live: (rows: 61, bytes: 1000),
          turnEnded: true,
          backoff: backoff,
        ),
        isTrue,
      );
    });

    test('with refreshes, 2,000 live rows never release a row without a '
        'boundary, and every released range reloads exactly', () {
      final native = Native([...rows('a', 100), ...rows('l', 2000)]);
      final reading = keyOf('a0');
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = streamWithRefresh(
        window,
        native,
        native.rows.sublist(100),
        reading: reading,
        afterEach: (window) {
          // The release a heal would have to repair never happens.
          expect(window.pages.any((page) => page.headReleased), isFalse);
        },
      );
      expect(reconnectGaps(window), 0);
      expect(unsavedGaps(window), 0);
      expectExactRanges(window, native);
      expectHeldOnceInNativeOrder(window, native);
      window = fillForward(window, native, reading: reading);
      expect(gapsOf(window), isEmpty);
      expect(retainsKey(window, 'l1999'), isTrue);
    });

    test('without them, the same stream needs a reconnect (the older-broker '
        'limit)', () {
      final native = Native([...rows('a', 100), ...rows('l', 2000)]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, native.rows.sublist(100), reading: keyOf('a0'));
      expect(reconnectGaps(window), 1);
    });
  });

  group('a refresh frame whose last row has no fixed place', () {
    AgentMessage reply(int n) => row('t$n');
    final ending = <String, AgentMessage>{
      'a plan': AgentMessage.fromJson(const {
        'type': 'task-list-state',
        'key': 'plan',
        'items': [
          {'id': 'a', 'text': 'u1', 'status': 'in_progress'},
        ],
      }),
      'a token count': AgentMessage.fromJson(const {
        'type': 'token-count',
        'input': 1,
        'output': 1,
      }),
      'a status tick': AgentMessage.fromJson(const {
        'type': 'status',
        'status': 'running',
      }),
      'an error': AgentMessage.fromJson(const {
        'type': 'error',
        'message': 'rate limited',
      }),
    };
    String label(AgentMessage message) =>
        (message.raw['key'] ??
                message.raw['callId'] ??
                message.raw['requestId'] ??
                message.raw['type'])
            as String;
    List<String> rowsOf(TranscriptHistoryWindow window) => [
      for (final page in window.pages)
        for (final message in page.messages) label(message),
    ];

    for (final MapEntry(key: name, value: last) in ending.entries) {
      test('ending with $name keeps the rows received after it out of its '
          'block, and holds it once', () {
        final native = Native([
          toolCall('c0'),
          toolResult('c0'),
          reply(0),
          toolCall('c1'),
          toolResult('c1'),
          last,
          reply(1),
          toolCall('c2'),
        ]);
        var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 3));
        window = live(window, [
          toolCall('c1'),
          toolResult('c1'),
          last,
          reply(1),
          ...approval('p1'),
        ]);
        window = window.applyHistory(native.delta(3, 6));
        final tail = window.pages.last;
        expect(tail.blockRows, 3);
        expect(tail.blockLiveOnlyRows, isEmpty);
        expect(rowsOf(window), [
          'c0',
          'c0',
          't0',
          'c1',
          'c1',
          label(last),
          't1',
          'p1',
          'p1',
        ]);

        window = live(window, [toolCall('c2')]);
        window = window.applyHistory(native.delta(6, 8));
        expect(rowsOf(window), [
          'c0',
          'c0',
          't0',
          'c1',
          'c1',
          label(last),
          't1',
          'p1',
          'p1',
          'c2',
        ]);
        expectHeldOnceInNativeOrder(window, native);
      });
    }
  });

  group('newer pages', () {
    /// A long session read from its start: the pages nearest the tail were
    /// released on the way, each remembered with its exact row count.
    ({TranscriptHistoryWindow window, Native native}) readToStart() {
      final native = Native(rows('n', 800));
      var window = TranscriptHistoryWindow.fromHistory(native.attach(700, 800));
      for (var cursor = window.olderHistoryCursor; cursor != null;) {
        final page = native.pageBefore(cursor, 100);
        final mutation = window.prependPage(
          page,
          requestedCursor: cursor,
          preserveMessageKey: stableTranscriptMessageKey(page.messages.first),
        );
        expect(mutation.accepted, isTrue);
        window = mutation.window;
        cursor = window.olderHistoryCursor;
      }
      expect(window.gaps, hasLength(1));
      expectExactRanges(window, native);
      return (window: window, native: native);
    }

    test('a released range reloads forward with exactly its rows and joins '
        'the runs on both sides by their cursors', () {
      final (:window, :native) = readToStart();
      final gap = window.gaps.single;
      expect(gap.kind, TranscriptHistoryGapKind.reloadable);
      final from = gap.forwardCursor!;
      final until = gap.reloadCursor!;
      final limit = window.forwardReloadLimitFor(from);
      expect(limit, native.pageable(from, 'b${Native.boundary(from) + 100}'));

      // The reader moves down onto the page, so the start of the session is
      // what gives way.
      final mutation = window.insertNewerPage(
        native.pageAfter(from, until, limit!),
        requestedCursor: from,
        until: until,
      );
      expect(mutation.accepted, isTrue);
      final next = mutation.window;
      expect(next.forwardReloadLimitFor(from), isNull);
      expectExactRanges(next, native);
      expectHeldOnceInNativeOrder(next, native);
      // The gap narrowed from its older edge to the page's end.
      final narrowed = next.gaps.single;
      expect(narrowed.forwardCursor, 'b${Native.boundary(from) + 100}');
      expect(narrowed.reloadCursor, until);
    });

    test('a page that ends inside a released range leaves the rest of it '
        'released from where the page ended', () {
      final (:window, :native) = readToStart();
      final gap = window.gaps.single;
      final from = gap.forwardCursor!;
      final mutation = window.insertNewerPage(
        native.pageAfter(from, gap.reloadCursor!, 40),
        requestedCursor: from,
        until: gap.reloadCursor!,
      );
      expect(mutation.accepted, isTrue);
      final next = mutation.window;
      final rest = 'b${Native.boundary(from) + 40}';
      expect(next.forwardReloadLimitFor(rest), 60);
      expect(next.gaps.single.forwardCursor, rest);
      expectExactRanges(next, native);
    });

    test('a page for a gap the window does not have, a page that ran off the '
        'end of history, and a page of the wrong direction are refused as '
        'moot', () {
      final (:window, :native) = readToStart();
      final gap = window.gaps.single;
      final from = gap.forwardCursor!;
      expect(
        window
            .insertNewerPage(
              native.pageAfter('b1', gap.reloadCursor!, 10),
              requestedCursor: 'b1',
              until: gap.reloadCursor!,
            )
            .rejection,
        TranscriptHistoryPageRejection.stale,
      );
      expect(
        window
            .insertNewerPage(
              const HistoryPageWireEvent(
                messages: [],
                cursor: 'b800',
                hasMore: false,
                endOfHistory: true,
                isNewer: true,
              ),
              requestedCursor: from,
              until: gap.reloadCursor!,
            )
            .rejection,
        TranscriptHistoryPageRejection.stale,
      );
      expect(
        window
            .insertNewerPage(
              native.pageBefore(gap.reloadCursor!, 10),
              requestedCursor: from,
              until: gap.reloadCursor!,
            )
            .rejection,
        TranscriptHistoryPageRejection.stale,
      );
      expect(
        window
            .prependPage(
              native.pageAfter(from, gap.reloadCursor!, 10),
              requestedCursor: gap.reloadCursor!,
            )
            .rejection,
        TranscriptHistoryPageRejection.stale,
      );
    });

    test('rows kept beside a released range return to their places when a '
        'newer page reaches the range end', () {
      final native = Native([
        ...rows('b', 100),
        toolCall('call1'),
        toolResult('call1'),
        row('after'),
        ...rows('x', 50),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, [
        native.rows[100],
        ...approval('req1'),
        native.rows[101],
        native.rows[102],
      ]);
      window = window.applyHistory(native.delta(100, 103));
      window = window.applyHistory(native.delta(103, 153));
      final reading = keyOf('b0');
      window = live(window, rows('live-', 346), reading: reading);
      final gap = window.gaps.single;
      expect(gap.forwardCursor, 'b100');
      expect(gap.reloadCursor, 'b103');
      expect(retainsRequest(window, 'req1'), isTrue);

      final mutation = window.insertNewerPage(
        native.pageAfter('b100', 'b103', window.forwardReloadLimitFor('b100')!),
        requestedCursor: 'b100',
        until: 'b103',
        preserveMessageKey: reading,
      );
      expect(mutation.accepted, isTrue);
      window = mutation.window;
      expect(gapsOf(window), isEmpty);
      expect(
        [for (final m in window.pages[1].messages) m.raw['type']],
        [
          'tool-call',
          'permission-request',
          'permission-resolved',
          'tool-result',
          'model-output',
        ],
      );
      expectHeldOnceInNativeOrder(window, native);
      // Released again, the approval stays beside the range once more.
      window = live(window, [row('live-more')], reading: reading);
      expect(retainsRequest(window, 'req1'), isTrue);
      expect(window.gaps.single.reloadCursor, 'b103');
    });

    test('a page too large to keep beside the rows the window must hold is '
        'refused as over budget', () {
      final (:window, native: _) = readToStart();
      final gap = window.gaps.single;
      final mutation = window.insertNewerPage(
        HistoryPageWireEvent(
          messages: [for (var i = 0; i < 100; i++) row('wide$i', chars: 30000)],
          cursor: 'b${Native.boundary(gap.forwardCursor) + 100}',
          hasMore: true,
          endOfHistory: false,
          isNewer: true,
        ),
        requestedCursor: gap.forwardCursor!,
        until: gap.reloadCursor!,
        preserveMessageKey: keyOf('n0'),
      );
      expect(mutation.rejection, TranscriptHistoryPageRejection.overBudget);
      expect(identical(mutation.window, window), isTrue);
    });

    test('a page that brings nothing and ends where it was asked from moves '
        'nothing, in either direction, however often it comes', () {
      final (:window, native: _) = readToStart();
      final gap = window.gaps.single;
      final from = gap.forwardCursor!;
      final until = gap.reloadCursor!;
      final pages = window.pages.length;
      final released = Map.of(window.releasedRanges);
      var next = window;
      for (var attempt = 0; attempt < 1000; attempt++) {
        final forward = next.insertNewerPage(
          HistoryPageWireEvent(
            messages: const [],
            cursor: from,
            hasMore: true,
            endOfHistory: false,
            isNewer: true,
          ),
          requestedCursor: from,
          until: until,
        );
        expect(forward.rejection, TranscriptHistoryPageRejection.noProgress);
        expect(identical(forward.window, next), isTrue);
        final backward = forward.window.prependPage(
          HistoryPageWireEvent(
            messages: const [],
            cursor: until,
            hasMore: true,
            endOfHistory: false,
          ),
          requestedCursor: until,
        );
        expect(backward.rejection, TranscriptHistoryPageRejection.noProgress);
        expect(identical(backward.window, next), isTrue);
        next = backward.window;
      }
      expect(next.pages, hasLength(pages));
      expect(next.releasedRanges, released);
      expect(next.gaps.single.forwardCursor, from);
      expect(next.gaps.single.reloadCursor, until);
    });

    test('an older page that brings nothing and ends at the start of what is '
        'loaded moves nothing', () {
      final native = Native(rows('n', 800));
      final window = TranscriptHistoryWindow.fromHistory(
        native.attach(700, 800),
      );
      final cursor = window.olderHistoryCursor!;
      var next = window;
      for (var attempt = 0; attempt < 100; attempt++) {
        final mutation = next.prependPage(
          HistoryPageWireEvent(
            messages: const [],
            cursor: cursor,
            hasMore: true,
            endOfHistory: false,
          ),
          requestedCursor: cursor,
        );
        expect(mutation.rejection, TranscriptHistoryPageRejection.noProgress);
        next = mutation.window;
      }
      expect(identical(next, window), isTrue);
      expect(next.pages, hasLength(1));
      expect(next.olderHistoryCursor, cursor);
      // A page that did reach the start still ends there.
      final start = next.prependPage(
        const HistoryPageWireEvent(
          messages: [],
          hasMore: false,
          endOfHistory: true,
        ),
        requestedCursor: cursor,
      );
      expect(start.accepted, isTrue);
      expect(start.window.olderHistoryCursor, isNull);
    });
  });

  group('a capped reconnect (catch-up)', () {
    /// A session attached at rows a0..a99; the tail then received c0..c4 live
    /// (persisted as sent) with an approval after c2 and a prompt not yet
    /// saved; while the socket was down 200 more rows were persisted.
    ({TranscriptHistoryWindow window, Native native}) disconnectedWindow() {
      final native = Native([
        ...rows('a', 100),
        ...rows('c', 5),
        ...rows('d', 200),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, [
        ...native.rows.sublist(100, 103),
        ...approval('req1'),
        ...native.rows.sublist(103, 105),
      ]);
      return (window: window, native: native);
    }

    test('a newer page into the gap it left that brings nothing and ends '
        'where it was asked from moves nothing, however often it comes', () {
      final native = Native(rows('n', 350));
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = window.applyHistory(native.attach(250, 350), catchUp: true);
      final gap = window.gaps.single;
      expect(gap.forwardCursor, 'b100');
      expect(gap.reloadCursor, 'b250');
      final pages = window.pages.length;
      final held = window.canonicalMessages.length;
      final released = Map.of(window.releasedRanges);
      for (var attempt = 0; attempt < 1000; attempt++) {
        final mutation = window.insertNewerPage(
          const HistoryPageWireEvent(
            messages: [],
            cursor: 'b100',
            hasMore: true,
            endOfHistory: false,
            isNewer: true,
          ),
          requestedCursor: 'b100',
          until: 'b250',
        );
        expect(mutation.rejection, TranscriptHistoryPageRejection.noProgress);
        window = mutation.window;
      }
      expect(window.pages, hasLength(pages));
      expect(window.canonicalMessages, hasLength(held));
      expect(window.releasedRanges, released);
      expect(window.gaps.single.forwardCursor, 'b100');
      expect(window.reloadsOnlyForward('b250'), isTrue);
      // The page it should have been still fills it.
      final filled = window.insertNewerPage(
        native.pageAfter('b100', 'b250', 150),
        requestedCursor: 'b100',
        until: 'b250',
      );
      expect(filled.accepted, isTrue);
      expect(gapsOf(filled.window), isEmpty);
      expectHeldOnceInNativeOrder(filled.window, native);
    });

    test('keeps the pages already read, and leaves a gap that fills from '
        'its older edge', () {
      final (:window, :native) = disconnectedWindow();
      final reading = keyOf('a50');
      final caughtUp = window.applyHistory(
        native.attach(205, 305),
        preserveMessageKey: reading,
        catchUp: true,
      );
      expect(retainsKey(caughtUp, 'a0'), isTrue);
      expect(retainsKey(caughtUp, 'd199'), isTrue);
      expect(reconnectGaps(caughtUp), 0);
      expect(unsavedGaps(caughtUp), 0);
      final gap = caughtUp.gaps.single;
      expect(gap.kind, TranscriptHistoryGapKind.reloadable);
      expect(gap.forwardCursor, 'b100');
      expect(gap.reloadCursor, 'b205');
      expect(caughtUp.reloadsOnlyForward('b205'), isTrue);
      expect(caughtUp.forwardReloadLimitFor('b100'), isNull);
      expect(caughtUp.latestHistoryTruncation, isNull);
      expect(caughtUp.historyCursor, 'r305');
      // The rows received live stay, beside the gap they belong to.
      expect(retainsKey(caughtUp, 'c0'), isTrue);
      expect(retainsRequest(caughtUp, 'req1'), isTrue);

      final filled = fillForward(caughtUp, native);
      expect(gapsOf(filled), isEmpty);
      expect(held(filled, 'c0'), 1);
      expect(held(filled, 'c4'), 1);
      final ordered = order(filled);
      expect(
        ordered.sublist(ordered.indexOf('c0'), ordered.indexOf('c4') + 1),
        ['c0', 'c1', 'c2', 'req1', 'req1', 'c3', 'c4'],
      );
      expect(held(filled, 'permission-resolved:request:req1'), 1);
    });

    test('a newer page that runs past the gap it left, into a range released '
        'after it, leaves the rest as one range from where it ended', () {
      final native = Native([...rows('a', 100), ...rows('d', 200)]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(50, 100));
      // Only 50 rows fall in the gap the catch-up leaves (b100..b150).
      window = window.applyHistory(native.attach(150, 250), catchUp: true);
      expect(window.releasedRanges['b150']?.pageableRows, isNull);
      // Live growth then releases the replacement's block after the gap.
      window = live(window, rows('live-', 301));
      expect(window.releasedRanges['b250']?.pageableRows, 100);
      final gap = window.gaps.single;
      expect(gap.forwardCursor, 'b100');
      expect(gap.reloadCursor, 'b250');
      expect(window.forwardReloadLimitFor('b100'), isNull);

      // A page of 100 rows from the open range's start ends inside the range
      // after it.
      final mutation = window.insertNewerPage(
        native.pageAfter('b100', 'b250', kTranscriptHistoryPageMessages),
        requestedCursor: 'b100',
        until: 'b250',
      );
      expect(mutation.accepted, isTrue);
      window = mutation.window;
      expect(window.releasedRanges.containsKey('b150'), isFalse);
      expect(window.releasedRanges['b250']?.olderCursor, 'b200');
      expect(window.releasedRanges['b250']?.pageableRows, isNull);
      expectExactRanges(window, native);
      window = fillForward(window, native);
      expect(gapsOf(window), isEmpty);
      expectHeldOnceInNativeOrder(window, native);
    });

    test('a newer page from an open range that ends on a boundary after it '
        'covers every range up to it', () {
      final native = Native([...rows('a', 100), ...rows('d', 200)]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(50, 100));
      window = window.applyHistory(native.attach(150, 250), catchUp: true);
      window = live(window, rows('live-', 301));
      final mutation = window.insertNewerPage(
        native.pageAfter('b100', 'b250', 150),
        requestedCursor: 'b100',
        until: 'b250',
      );
      expect(mutation.accepted, isTrue);
      window = mutation.window;
      expect(window.releasedRanges.containsKey('b150'), isFalse);
      expect(window.releasedRanges.containsKey('b250'), isFalse);
      expect(gapsOf(window), isEmpty);
      expectHeldOnceInNativeOrder(window, native);
    });

    test('an older page from an open range at the leading edge that runs '
        'past it leaves no range ending before it starts', () {
      final native = Native([...rows('a', 100), ...rows('d', 200)]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = window.applyHistory(native.attach(150, 250), catchUp: true);
      // Live growth releases the page read before the gap and the
      // replacement's block, so the open range lies between two released
      // ranges, ahead of the tail.
      window = live(window, rows('live-', 301));
      expect(window.releasedRanges['b100']?.pageableRows, 100);
      expect(window.releasedRanges['b150']?.pageableRows, isNull);
      expect(window.releasedRanges['b250']?.pageableRows, 100);
      var cursor = window.olderHistoryCursor;
      expect(cursor, 'b250');
      var reads = 0;
      while (cursor != null && reads++ < 10) {
        final page = native.pageBefore(
          cursor,
          window.reloadLimitFor(cursor) ?? kTranscriptHistoryPageMessages,
        );
        final mutation = window.prependPage(
          page,
          requestedCursor: cursor,
          preserveMessageKey: stableTranscriptMessageKey(page.messages.first),
        );
        expect(mutation.accepted, isTrue, reason: 'older page from $cursor');
        window = mutation.window;
        expectExactRanges(window, native);
        if (cursor == 'b150') {
          // The page from the open range ran on past its older edge (b100):
          // what is missing is one open range from the start.
          expect(window.releasedRanges.containsKey('b100'), isFalse);
          expect(window.releasedRanges['b50']?.olderCursor, isNull);
          expect(window.releasedRanges['b50']?.pageableRows, isNull);
        }
        cursor = window.olderHistoryCursor;
      }
      expect(cursor, isNull);
      // Pages the budget released on the way reload exactly.
      window = fillForward(window, native);
      expect(gapsOf(window), isEmpty);
    });

    test('an older page that ends exactly where an open range began keeps the '
        'range behind it exact', () {
      final native = Native([...rows('a', 100), ...rows('d', 200)]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = window.applyHistory(native.attach(150, 250), catchUp: true);
      window = live(window, rows('live-', 301));
      var mutation = window.prependPage(
        native.pageBefore('b250', 100),
        requestedCursor: 'b250',
      );
      expect(mutation.accepted, isTrue);
      window = mutation.window;
      mutation = window.prependPage(
        native.pageBefore('b150', 50),
        requestedCursor: 'b150',
      );
      expect(mutation.accepted, isTrue);
      window = mutation.window;
      expect(window.releasedRanges.containsKey('b150'), isFalse);
      expect(window.releasedRanges['b100']?.olderCursor, isNull);
      expect(window.reloadLimitFor('b100'), 100);
      expectExactRanges(window, native);
    });

    test('the first newer page takes the rows that led the gap, and later '
        'ones settle the rest in place', () {
      final (:window, :native) = disconnectedWindow();
      var caughtUp = window.applyHistory(
        native.attach(205, 305),
        catchUp: true,
      );
      final first = caughtUp.insertNewerPage(
        native.pageAfter('b100', 'b205', 2),
        requestedCursor: 'b100',
        until: 'b205',
      );
      expect(first.accepted, isTrue);
      caughtUp = first.window;
      expect(held(caughtUp, 'c0'), 1);
      expect(held(caughtUp, 'c1'), 1);
      expect(caughtUp.gaps.single.forwardCursor, 'b102');
      expect(caughtUp.reloadsOnlyForward('b205'), isTrue);
      expect(caughtUp.forwardReloadLimitFor('b102'), isNull);
      expectHeldOnceInNativeOrder(caughtUp, native);

      final second = caughtUp.insertNewerPage(
        native.pageAfter('b102', 'b205', 1),
        requestedCursor: 'b102',
        until: 'b205',
      );
      caughtUp = second.window;
      // The approval followed c2: with c2 back, it is back after it.
      final ordered = order(caughtUp);
      expect(ordered.indexOf('req1'), ordered.indexOf('c2') + 1);
      expectHeldOnceInNativeOrder(caughtUp, native);
      caughtUp = fillForward(caughtUp, native);
      expect(gapsOf(caughtUp), isEmpty);
      expect(held(caughtUp, 'permission-request:request:req1'), 1);
    });

    test('an older page into the gap closes it where it meets the run '
        'before it, and keeps the rows that led it there', () {
      final native = Native([
        ...rows('a', 100),
        ...approval('lead'),
        ...rows('c', 3),
        ...rows('d', 200),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, [
        ...approval('lead'),
        ...native.rows.sublist(102, 105),
      ]);
      final durable = Native([
        ...rows('a', 100),
        ...rows('c', 3),
        ...rows('d', 200),
      ]);
      window = window.applyHistory(durable.attach(203, 303), catchUp: true);
      expect(window.reloadsOnlyForward('b203'), isTrue);
      // A partial older page leaves the rest open from where it began.
      final partial = window.prependPage(
        durable.pageBefore('b203', 50),
        requestedCursor: 'b203',
      );
      expect(partial.accepted, isTrue);
      window = partial.window;
      expect(window.reloadsOnlyForward('b153'), isTrue);
      expect(window.gaps.single.reloadCursor, 'b153');
      expect(retainsRequest(window, 'lead'), isTrue);
      // The next one runs past where the gap began and joins the run before
      // it by the rows they share.
      final closing = window.prependPage(
        durable.pageBefore('b153', 100),
        requestedCursor: 'b153',
      );
      expect(closing.accepted, isTrue);
      window = closing.window;
      expect(gapsOf(window), isEmpty);
      expect(window.releasedRanges, isEmpty);
      final ordered = order(window);
      expect(ordered.indexOf('lead'), ordered.indexOf('a99') + 1);
      expect(ordered.indexOf('c0'), ordered.indexOf('lead') + 2);
      expectHeldOnceInNativeOrder(window, durable);
    });

    test('is not used for a tail whose leading live rows were released, or '
        'for a replacement that starts at the start of history', () {
      final native = Native([...rows('a', 20), ...rows('l', 420)]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(10, 20));
      window = live(window, native.rows.sublist(20, 440));
      expect(window.pages.last.headReleased, isTrue);
      final reset = window.applyHistory(native.attach(340, 440), catchUp: true);
      expect(retainsKey(reset, 'a10'), isFalse);
      expect(retainsKey(reset, 'l100'), isFalse);
      expect(reset.gaps, isEmpty);

      final short = Native(rows('s', 50));
      var fresh = TranscriptHistoryWindow.fromHistory(short.attach(0, 20));
      fresh = live(fresh, [...approval('req1')]);
      final whole = fresh.applyHistory(short.attach(0, 50), catchUp: true);
      expect(whole.gaps, isEmpty);
      // The approval is not in the replacement, and its release is said.
      expect(retainsRequest(whole, 'req1'), isFalse);
      expect(unsavedGaps(whole), 1);
    });

    test('is not used for a tail no frame named a block end for, such as '
        'one hydrated from the local snapshot', () {
      final native = Native(rows('a', 400));
      // What hydration builds: the stored rows and their start boundary, but
      // no end boundary for the rows the window holds.
      final hydrated = TranscriptHistoryWindow.fromHistory(
        HistoryWireEvent(
          messages: native.rows.sublist(100, 150),
          reset: true,
          cursor: 'r150',
          olderCursor: 'b100',
          hasEarlier: true,
        ),
      );
      expect(hydrated.pages.single.blockEndCursor, isNull);
      final reset = hydrated.applyHistory(
        native.attach(300, 400),
        catchUp: true,
      );
      expect(retainsKey(reset, 'a100'), isFalse);
      expect(reset.pages.where((page) => page.isResidue), isEmpty);
      expect(reset.releasedRanges, isEmpty);
      expect(gapsOf(reset), isEmpty);
      expect(order(reset).first, 'a300');
    });

    test('drops from the kept pages the rows the replacement holds; a row '
        'that followed one of them waits beside the gap, and returns after '
        'it once the gap fills', () {
      final native = Native(rows('a', 300));
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      // Rows a100..a249 arrive live, with an approval after a220; the
      // reconnect restates a200..a299.
      window = live(window, [
        ...native.rows.sublist(100, 221),
        ...approval('req1'),
        ...native.rows.sublist(221, 250),
      ]);
      final caughtUp = window.applyHistory(
        native.attach(200, 300),
        catchUp: true,
      );
      expect(held(caughtUp, 'a220'), 1);
      expect(held(caughtUp, 'a120'), 1);
      expect(held(caughtUp, 'permission-request:request:req1'), 1);
      // Beside the gap, not in the replacement: the replacement holds none of
      // the rows it keeps.
      final residue = caughtUp.pages.singleWhere((page) => page.isResidue);
      expect(
        [
          for (final message in residue.messages)
            message.raw['key'] ?? message.raw['requestId'],
        ],
        [for (var index = 100; index < 200; index++) 'a$index', 'req1', 'req1'],
      );
      expect(retainsRequest(caughtUp, 'req1'), isTrue);
      expectHeldOnceInNativeOrder(caughtUp, native);
      final filled = fillForward(caughtUp, native);
      expect(gapsOf(filled), isEmpty);
      expect(filled.pages.where((page) => page.isResidue), isEmpty);
      final ordered = order(filled);
      expect(ordered.indexOf('req1'), ordered.indexOf('a220') + 1);
      expect(ordered.indexOf('a221'), ordered.indexOf('req1') + 2);
      expect(held(filled, 'permission-request:request:req1'), 1);
      expect(held(filled, 'permission-resolved:request:req1'), 1);
      expectHeldOnceInNativeOrder(filled, native);

      // Filled from its newer edge instead, as a reader scrolling up does.
      final back = reloadBack(caughtUp, native);
      expect(gapsOf(back), isEmpty);
      expect(back.pages.where((page) => page.isResidue), isEmpty);
      final backOrder = order(back);
      expect(backOrder.indexOf('req1'), backOrder.indexOf('a220') + 1);
      expect(held(back, 'permission-request:request:req1'), 1);
    });

    // Rows 100..106 arrive live, an error card without a key among them
    // (first, or after three rows); then [saved] more rows are saved and the
    // capped reconnect restates the newest 100: from row 101 (the card can be
    // among them), from row 127 (the gap fills with one page) and from row 257
    // (with two).
    for (final errorAt in [0, 3]) {
      for (final saved in [94, 120, 250]) {
        test('a card saved without a key, received live before the socket '
            'dropped, is held once across the reconnect and when the gap '
            'fills from either edge (row $errorAt of those received live, '
            '$saved rows saved since)', () {
          final error = AgentMessage.fromJson({
            'type': 'error',
            'message': 'rate limited',
          });
          final native = Native([
            ...rows('a', 100),
            ...rows('c', errorAt),
            error,
            ...rows('c', 6 - errorAt, start: errorAt),
            ...rows('d', saved),
          ]);
          final end = native.rows.length;
          var window = TranscriptHistoryWindow.fromHistory(
            native.attach(0, 100),
          );
          window = live(window, native.rows.sublist(100, 107));
          final caughtUp = window.applyHistory(
            native.attach(end - 100, end),
            catchUp: true,
          );
          int errors(TranscriptHistoryWindow window) => [
            for (final page in window.pages)
              for (final message in page.messages)
                if (message.type == AgentMessageType.error) message,
          ].length;
          expect(errors(caughtUp), 1);
          expect(caughtUp.gaps, hasLength(1));

          final after = errorAt == 0 ? 'a99' : 'c${errorAt - 1}';
          final filled = fillForward(caughtUp, native);
          expect(gapsOf(filled), isEmpty);
          expect(errors(filled), 1);
          expect(filled.pages.where((page) => page.isResidue), isEmpty);
          final ordered = [
            for (final message in filled.canonicalMessages)
              message.raw['key'] ?? message.type.wireValue,
          ];
          expect(ordered.indexOf('error'), ordered.indexOf(after) + 1);

          final back = reloadBack(caughtUp, native);
          expect(gapsOf(back), isEmpty);
          expect(errors(back), 1);
          expect(back.pages.where((page) => page.isResidue), isEmpty);
        });
      }
    }

    test('rows that followed a prompt queued live, saved ahead of it, are '
        'held once and in saved order after the gap fills', () {
      final durable = <AgentMessage>[...rows('a', 100)];
      var window = TranscriptHistoryWindow.fromHistory(
        Native(durable).attach(0, 100),
      );
      // Queued while the agent works: shown live now, saved only when the
      // agent takes it.
      window = live(window, [
        AgentMessage.fromJson({
          'type': 'user-message',
          'key': 'q',
          'text': 'follow-up',
          'queued': true,
        }),
        ...rows('x', 20),
      ]);
      durable
        ..addAll(rows('x', 20))
        ..addAll(rows('y', 150))
        ..add(row('q', type: 'user-message'))
        ..addAll(rows('z', 10));
      final native = Native(durable);
      final end = durable.length;
      final caughtUp = window.applyHistory(
        native.attach(end - 100, end),
        catchUp: true,
      );
      expect(held(caughtUp, 'x0'), 1);
      expect(held(caughtUp, 'user-message:key:q'), 1);
      expectHeldOnceInNativeOrder(caughtUp, native);
      final filled = fillForward(caughtUp, native);
      expect(gapsOf(filled), isEmpty);
      for (var index = 0; index < 20; index++) {
        expect(held(filled, 'x$index'), 1, reason: 'x$index');
      }
      expect(filled.pages.where((page) => page.isResidue), isEmpty);
      expectHeldOnceInNativeOrder(filled, native);
      final ordered = order(filled);
      expect(ordered.indexOf('x0'), ordered.indexOf('a99') + 1);
      expect(ordered.indexOf('q'), ordered.indexOf('y149') + 1);
    });

    test('with no gap after all, the rows received live join the frame that '
        'starts at the boundary', () {
      final native = Native(rows('a', 300));
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, approval('req1'));
      // Exactly the rows saved since the boundary, capped to the newest 100.
      final caughtUp = window.applyHistory(
        native.attach(100, 200),
        catchUp: true,
      );
      expect(gapsOf(caughtUp), isEmpty);
      expect(caughtUp.pages.where((page) => page.isResidue), isEmpty);
      final ordered = order(caughtUp);
      expect(ordered.indexOf('req1'), ordered.indexOf('a99') + 1);
      expect(ordered.indexOf('a100'), ordered.indexOf('req1') + 2);
      expect(held(caughtUp, 'permission-request:request:req1'), 1);
    });

    test('a prompt never saved, and the approval that followed it, return '
        'with the gap in the order they arrived', () {
      final native = Native([
        ...rows('a', 100),
        ...rows('c', 50),
        ...rows('d', 100),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, [
        native.rows[100],
        row('u1', type: 'user-message'),
        ...approval('req1'),
        ...native.rows.sublist(101, 103),
      ]);
      final caughtUp = window.applyHistory(
        native.attach(150, 250),
        catchUp: true,
      );
      final filled = fillForward(caughtUp, native);
      expect(gapsOf(filled), isEmpty);
      final ordered = order(filled);
      expect(
        ordered.sublist(ordered.indexOf('c0'), ordered.indexOf('c2') + 1),
        ['c0', 'u1', 'req1', 'req1', 'c1', 'c2'],
      );
      expect(held(filled, 'permission-request:request:req1'), 1);
    });

    test('an older page that ends where the gap began closes it by that '
        'boundary', () {
      final (:window, :native) = disconnectedWindow();
      final caughtUp = window.applyHistory(
        native.attach(205, 305),
        catchUp: true,
      );
      final closing = caughtUp.prependPage(
        native.pageBefore('b205', 105),
        requestedCursor: 'b205',
      );
      expect(closing.accepted, isTrue);
      final closed = closing.window;
      expect(gapsOf(closed), isEmpty);
      expect(closed.releasedRanges, isEmpty);
      expect(closed.pages.where((page) => page.isResidue), isEmpty);
      final ordered = order(closed);
      expect(
        ordered.sublist(ordered.indexOf('c0'), ordered.indexOf('c4') + 1),
        ['c0', 'c1', 'c2', 'req1', 'req1', 'c3', 'c4'],
      );
      expectHeldOnceInNativeOrder(closed, native);
    });

    test('an older page that runs past the gap into the run before it keeps '
        "that run's rows no reload returns there, once", () {
      final native = Native(rows('a', 300));
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 10));
      window = live(window, [
        ...native.rows.sublist(10, 13),
        ...approval('req1'),
        ...native.rows.sublist(13, 50),
      ]);
      // The approval sits inside the block the frame seals.
      window = window.applyHistory(native.delta(10, 50));
      final caughtUp = window.applyHistory(
        native.attach(150, 250),
        catchUp: true,
      );
      expect(caughtUp.reloadsOnlyForward('b150'), isTrue);
      final overshoot = caughtUp.prependPage(
        native.pageBefore('b150', 110),
        requestedCursor: 'b150',
      );
      expect(overshoot.accepted, isTrue);
      final joined = overshoot.window;
      expect(gapsOf(joined), isEmpty);
      expect(joined.releasedRanges, isEmpty);
      expect(held(joined, 'permission-request:request:req1'), 1);
      final ordered = order(joined);
      expect(ordered.indexOf('req1'), ordered.indexOf('a12') + 1);
      expectHeldOnceInNativeOrder(joined, native);
    });
  });

  group('state the broker replays after every frame', () {
    AgentMessage tokens(int input) => AgentMessage.fromJson({
      'type': 'token-count',
      'input': input,
      'output': 5,
    });
    int readings(TranscriptHistoryWindow window) => [
      for (final page in window.pages)
        for (final message in page.messages)
          if (message.type == AgentMessageType.tokenCount) message,
    ].length;

    test('the same reading again is held once, and a new one is kept', () {
      final native = Native(rows('a', 20));
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 20));
      for (var round = 0; round < 5; round++) {
        // An incremental frame (a reconnect or a refresh), then the reading
        // still trailing the history, replayed after it.
        window = window.applyHistory(native.delta(20, 20));
        window = window.applyLiveMessage(tokens(10));
      }
      expect(readings(window), 1);
      window = window.applyLiveMessage(tokens(11));
      expect(readings(window), 2);
      // And the new reading, replayed, is held once too.
      window = window.applyLiveMessage(tokens(11));
      expect(readings(window), 2);
    });

    test('a snapshot of the commands still running is applied whatever it '
        'repeats: it retires a card an earlier row left running', () {
      AgentMessage snapshot(List<String> keys) => AgentMessage.fromJson({
        'type': 'event',
        'name': 'codex.background-running-snapshot',
        'payload': {'keys': keys},
      });
      AgentMessage command(String key) => AgentMessage.fromJson({
        'type': 'agent-activity',
        'key': key,
        'kind': 'command',
        'title': 'Build',
        'status': 'running',
      });
      final native = Native(rows('a', 5));
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 5));
      window = live(window, [
        command('cmd:codex:current'),
        snapshot(['cmd:codex:current']),
        // A card whose withdrawal was lost, restated as running ...
        command('cmd:codex:old'),
        // ... and the same snapshot again, which says it is not.
        snapshot(['cmd:codex:current']),
      ]);
      expect(
        [for (final activity in window.liveState!.activities) activity.key],
        ['cmd:codex:current'],
      );
    });

    test('a reading equal to the last of its kind, but not to the value a run '
        'summary set since, is kept', () {
      final native = Native(rows('a', 5));
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 5));
      window = live(window, [
        tokens(10),
        AgentMessage.fromJson({
          'type': 'run-summary',
          'key': 'turn-1',
          'status': 'done',
          'tokens': {'input': 99, 'output': 9},
        }),
      ]);
      expect(window.telemetry.inputTokens, 99);
      window = window.applyLiveMessage(tokens(10));
      expect(window.telemetry.inputTokens, 10);
      expect(readings(window), 2);
    });
  });

  group('a prompt shown when sent and saved once the agent takes it', () {
    AgentMessage prompt(String key) => AgentMessage.fromJson({
      'type': 'user-message',
      'key': key,
      'text': key,
    });
    final error = AgentMessage.fromJson({
      'type': 'error',
      'message': 'rate limited',
    });

    for (final refresh in [true, false]) {
      test('an error card without a key received after it is held once by '
          '${refresh ? 'a refresh answer' : 'a reconnect frame'} that '
          'restates both', () {
        final native = Native([...rows('a', 20), error, prompt('u')]);
        var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 20));
        window = live(window, [prompt('u'), error]);
        window = window.applyHistory(
          native.delta(20, 22, clientMessageId: refresh ? 'refresh-1' : null),
        );
        expect(
          [
            for (final page in window.pages)
              for (final message in page.messages)
                if (message.type == AgentMessageType.error) message,
          ],
          hasLength(1),
        );
        expect(order(window).skip(18), ['a18', 'a19', null, 'u']);
      });
    }

    test('a saved row received live after it keeps its saved place once a '
        'frame names it, when the next frame saves the prompt', () {
      final native = Native([
        ...rows('a', 40),
        row('x'),
        toolCall('c0'),
        toolCall('c1'),
        prompt('u'),
        row('y'),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 40));
      window = live(window, [prompt('u'), native.rows[40]]);
      // A reconnect: x, saved, arrives in a frame; the prompt is not saved yet.
      window = window.applyHistory(native.delta(40, 41));
      window = live(window, native.rows.sublist(41, 43));
      // The agent takes the prompt, then writes more.
      window = window.applyHistory(native.delta(41, 45));
      expect(order(window).skip(38), ['a38', 'a39', 'x', 'c0', 'c1', 'u', 'y']);
      expectHeldOnceInNativeOrder(window, native);
      expectExactRanges(window, native);
    });
    test('an error card saved before it, and shown after it, is held once '
        'when the gap they fell into fills', () {
      final native = Native([
        ...rows('a', 100),
        row('c0'),
        error,
        prompt('u'),
        ...rows('d', 150),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, [row('c0'), prompt('u'), error]);
      window = window.applyHistory(native.attach(153, 253), catchUp: true);
      final filled = fillForward(window, native);
      expect(gapsOf(filled), isEmpty);
      expect(
        [
          for (final message in filled.canonicalMessages)
            if (message.type == AgentMessageType.error) message,
        ],
        hasLength(1),
      );
      expect(order(filled).skip(99).take(4), ['a99', 'c0', null, 'u']);
    });

    test('an approval shown after it, while it waited, stays before the rows '
        'saved ahead of it when a catch-up restates them', () {
      final native = Native([...rows('a', 100), ...rows('x', 5), prompt('q')]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, [
        AgentMessage.fromJson({
          'type': 'user-message',
          'key': 'q',
          'text': 'q',
          'queued': true,
        }),
        ...approval('p'),
        ...native.rows.sublist(100, 105),
      ]);
      window = window.applyHistory(native.attach(100, 106), catchUp: true);
      expect(order(window).skip(99), [
        'a99',
        'p',
        'p',
        'x0',
        'x1',
        'x2',
        'x3',
        'x4',
        'q',
      ]);
    });

    test('an approval shown after it, while it waited, stays before the rows '
        'saved ahead of it when a refresh restates them', () {
      final native = Native([
        ...rows('a', 20),
        row('d0'),
        prompt('u'),
        row('d1'),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 20));
      window = live(window, [
        AgentMessage.fromJson({
          'type': 'user-message',
          'key': 'u',
          'text': 'u',
          'queued': true,
        }),
        approval('p').first,
        row('d0'),
      ]);
      window = window.applyHistory(
        native.delta(20, 23, clientMessageId: 'refresh-20'),
      );
      expect(order(window).skip(19), ['a19', 'p', 'd0', 'u', 'd1']);
    });

    test('a pending approval kept inside the block stays after its call when '
        'a refresh saves the prompt shown before the call', () {
      final native = Native([
        ...rows('a', 20),
        toolCall('c0'),
        toolResult('c0'),
        row('d0'),
        prompt('u'),
        row('d1'),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 20));
      window = live(window, [
        prompt('u'),
        toolCall('c0'),
        approval('p').first,
        toolResult('c0'),
      ]);
      // A frame names the call and its result; the prompt and the approval
      // stay where they were shown, inside the block.
      window = window.applyHistory(
        native.delta(20, 22, clientMessageId: 'refresh-20'),
      );
      expect(order(window).skip(19), ['a19', 'u', 'c0', 'p', 'c0']);
      window = live(window, [row('d0')]);
      window = window.applyHistory(
        native.delta(22, 25, clientMessageId: 'refresh-22'),
      );
      expect(order(window).skip(19), ['a19', 'c0', 'p', 'c0', 'd0', 'u', 'd1']);
    });

    // A prompt queued during a turn, an approval that waits after it, the
    // agent's next rows, then the prompt taken (its copy loses the flag in
    // place) and the approval answered: the answer stays after its request
    // however the frame that saves the prompt places it.
    AgentMessage queued(String key) => AgentMessage.fromJson({
      'type': 'user-message',
      'key': key,
      'text': key,
      'queued': true,
    });

    test('an answer stays after its request when a refresh vouched for rows '
        'shown after the request, before the prompt was taken', () {
      final native = Native([...rows('a', 20), row('d0'), prompt('q')]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 20));
      final [request, answer] = approval('p');
      window = live(window, [queued('q'), request, row('d0')]);
      window = window.applyHistory(
        native.delta(20, 21, clientMessageId: 'refresh-20'),
      );
      window = live(window, [prompt('q'), answer]);
      window = window.applyHistory(native.delta(21, 22));
      final keys = order(window);
      expect(keys.indexOf('p'), lessThan(keys.lastIndexOf('p')));
      expect(keys.where((key) => key == 'q'), hasLength(1));
      expect(keys.skip(19), ['a19', 'p', 'd0', 'q', 'p']);
    });

    test('an answer stays after its request when the frame that saves the '
        'prompt also places rows shown after the request', () {
      final native = Native([...rows('a', 20), row('d0'), prompt('q')]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 20));
      final [request, answer] = approval('p');
      window = live(window, [queued('q'), request, row('d0')]);
      window = live(window, [prompt('q'), answer]);
      window = window.applyHistory(native.delta(20, 22));
      final keys = order(window);
      expect(keys.indexOf('p'), lessThan(keys.lastIndexOf('p')));
      expect(keys.skip(19), ['a19', 'p', 'd0', 'q', 'p']);
    });
  });

  group("a reset that keeps the reader's page beside it", () {
    test('a saved row without a key the reset restates is held once, not '
        'carried from the page it replaces', () {
      final error = AgentMessage.fromJson({
        'type': 'error',
        'message': 'rate limited',
      });
      // The tail, then rows received live: one without a key between them.
      var window = TranscriptHistoryWindow.fromHistory(
        HistoryWireEvent(
          messages: rows('k', 100),
          reset: true,
          cursor: 'r100',
          endCursor: 'b100',
          newerHistory: true,
        ),
      );
      final reading = keyOf('k5');
      window = live(window, [
        row('k100'),
        error,
        row('k101'),
      ], reading: reading);
      // A reset of the newest rows (a hub resync), which restates them all.
      window = window.applyHistory(
        HistoryWireEvent(
          messages: [
            ...rows('k', 50, start: 50),
            row('k100'),
            error,
            row('k101'),
          ],
          reset: true,
          cursor: 'r103',
          olderCursor: 'b50',
          hasEarlier: true,
          endCursor: 'b103',
          newerHistory: true,
        ),
        preserveMessageKey: reading,
      );
      final held = [
        for (final page in window.pages)
          for (final message in page.messages)
            if (message.type == AgentMessageType.error) message,
      ];
      expect(held, hasLength(1));
      expect(window.pages.first.containsStableKey(reading), isTrue);
      expect(window.pages.first.newerCursor, 'b50');
    });

    test('a row no reload returns is still carried into the reset beside the '
        'row it followed', () {
      var window = TranscriptHistoryWindow.fromHistory(
        HistoryWireEvent(
          messages: rows('k', 100),
          reset: true,
          cursor: 'r100',
          endCursor: 'b100',
          newerHistory: true,
        ),
      );
      final reading = keyOf('k5');
      final card = approval('p1').first;
      window = live(window, [row('k100'), card, row('k101')], reading: reading);
      window = window.applyHistory(
        HistoryWireEvent(
          messages: [...rows('k', 50, start: 50), row('k100'), row('k101')],
          reset: true,
          cursor: 'r102',
          olderCursor: 'b50',
          hasEarlier: true,
          endCursor: 'b102',
          newerHistory: true,
        ),
        preserveMessageKey: reading,
      );
      final keys = [
        for (final message in window.canonicalMessages)
          stableTranscriptMessageKey(message),
      ];
      final at = keys.indexOf('permission-request:request:p1');
      expect(at, greaterThan(0));
      expect(keys[at - 1], keyOf('k100'));
      expect(keys[at + 1], keyOf('k101'));
    });

    for (final saved in [true, false]) {
      test('a row no reload returns that followed a row without a key '
          '${saved ? 'the reset restates' : 'never saved'} is carried in '
          'after that row', () {
        final error = AgentMessage.fromJson({
          'type': 'error',
          'message': 'rate limited',
        });
        var window = TranscriptHistoryWindow.fromHistory(
          HistoryWireEvent(
            messages: rows('k', 100),
            reset: true,
            cursor: 'r100',
            endCursor: 'b100',
            newerHistory: true,
          ),
        );
        final reading = keyOf('k5');
        window = live(window, [
          row('k100'),
          error,
          toolCall('call'),
          row('k101'),
        ], reading: reading);
        final restated = [
          ...rows('k', 50, start: 50),
          row('k100'),
          if (saved) error,
          row('k101'),
        ];
        window = window.applyHistory(
          HistoryWireEvent(
            messages: restated,
            reset: true,
            cursor: 'r${50 + restated.length}',
            olderCursor: 'b50',
            hasEarlier: true,
            endCursor: 'b${50 + restated.length}',
            newerHistory: true,
          ),
          preserveMessageKey: reading,
        );
        final order = [
          for (final message in window.canonicalMessages)
            message.raw['key'] ??
                message.raw['callId'] ??
                message.type.wireValue,
        ];
        expect(order.where((row) => row == 'error'), hasLength(1));
        expect(order.where((row) => row == 'call'), hasLength(1));
        final at = order.indexOf('call');
        expect(order.sublist(at - 2, at + 2), [
          'k100',
          'error',
          'call',
          'k101',
        ]);
      });
    }
  });

  group('rows kept beside a released range', () {
    AgentMessage prompt(String key) => AgentMessage.fromJson({
      'type': 'user-message',
      'key': key,
      'text': key,
    });
    final error = AgentMessage.fromJson({
      'type': 'error',
      'message': 'rate limited',
    });

    // A call history never holds, shown right after an error card saved
    // without a key, which followed a row with a key.
    List<Object?> readOrder(TranscriptHistoryWindow window) => [
      for (final message in window.canonicalMessages)
        message.raw['key'] ?? message.raw['callId'] ?? message.type.wireValue,
    ];
    void expectCallAfterError(TranscriptHistoryWindow window) {
      final ordered = readOrder(window);
      expect(ordered.where((row) => row == 'call'), hasLength(1));
      expect(ordered.where((row) => row == 'error'), hasLength(1));
      expect(ordered.indexOf('error'), ordered.indexOf('k') + 1);
      expect(ordered.indexOf('call'), ordered.indexOf('error') + 1);
    }

    test('one that followed a saved row without a key returns after that row '
        'when its range reloads', () {
      final native = Native([
        ...rows('a', 100),
        row('k'),
        error,
        ...rows('y', 700),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, [native.rows[100], error, toolCall('call')]);
      window = streamWithRefresh(window, native, native.rows.sublist(102));
      expect(retainsKey(window, 'k'), isFalse);
      expect(
        window.pages.where(
          (page) =>
              page.isResidue &&
              page.messages.any((message) => message.raw['callId'] == 'call'),
        ),
        hasLength(1),
      );
      // The reader scrolls up to it: the range before it reloads.
      const call = 'tool-call:call:call';
      var back = window;
      for (var round = 0; round < 8; round++) {
        final residue = back.pages
            .where((page) => page.isResidue && page.containsStableKey(call))
            .firstOrNull;
        if (residue == null) break;
        final cursor = residue.olderCursor!;
        final mutation = back.prependPage(
          native.pageBefore(
            cursor,
            back.reloadLimitFor(cursor) ?? kTranscriptHistoryPageMessages,
          ),
          requestedCursor: cursor,
          preserveMessageKey: call,
        );
        expect(mutation.accepted, isTrue);
        back = mutation.window;
      }
      expectCallAfterError(back);
    });

    test('one that followed a row without a key never saved returns after '
        'it, before a saved row without a key shown after it', () {
      final overloaded = AgentMessage.fromJson({
        'type': 'error',
        'message': 'overloaded',
      });
      final native = Native([
        ...rows('a', 100),
        row('k'),
        overloaded,
        ...rows('y', 700),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, [
        native.rows[100],
        error,
        toolCall('call'),
        overloaded,
      ]);
      window = streamWithRefresh(window, native, native.rows.sublist(102));
      expect(retainsKey(window, 'k'), isFalse);
      const call = 'tool-call:call:call';
      var back = window;
      for (var round = 0; round < 8; round++) {
        final residue = back.pages
            .where((page) => page.isResidue && page.containsStableKey(call))
            .firstOrNull;
        if (residue == null) break;
        final cursor = residue.olderCursor!;
        final mutation = back.prependPage(
          native.pageBefore(
            cursor,
            back.reloadLimitFor(cursor) ?? kTranscriptHistoryPageMessages,
          ),
          requestedCursor: cursor,
          preserveMessageKey: call,
        );
        expect(mutation.accepted, isTrue);
        back = mutation.window;
      }
      final ordered = [
        for (final message in back.canonicalMessages)
          message.raw['key'] ?? message.raw['callId'] ?? message.raw['message'],
      ];
      final at = ordered.indexOf('k');
      expect(ordered.sublist(at, at + 4), [
        'k',
        'rate limited',
        'call',
        'overloaded',
      ]);
      expect(ordered.where((row) => row == 'call'), hasLength(1));
    });

    for (final (name, saved) in [('no gap', 93), ('a gap', 150)]) {
      test('one that followed a saved row without a key stays after it '
          'across a capped reconnect that leaves $name', () {
        final native = Native([
          ...rows('a', 100),
          row('k'),
          error,
          ...rows('c', 5),
          ...rows('d', saved),
        ]);
        final end = native.rows.length;
        var window = TranscriptHistoryWindow.fromHistory(
          native.attach(0, 100),
        );
        window = live(window, [
          native.rows[100],
          error,
          toolCall('call'),
          ...native.rows.sublist(102, 107),
        ]);
        final caughtUp = window.applyHistory(
          native.attach(end - 100, end),
          catchUp: true,
        );
        if (saved == 93) expectCallAfterError(caughtUp);
        expectCallAfterError(fillForward(caughtUp, native));
        expectCallAfterError(reloadBack(caughtUp, native));
      });
    }

    test('stay beside it when a page outside it holds the row they followed '
        '(a prompt saved after them)', () {
      final native = Native([
        ...rows('a', 100),
        ...rows('x', 10),
        ...rows('y', 150),
        prompt('u'),
        ...rows('l', 450),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, [
        prompt('u'),
        ...native.rows.sublist(100, 104),
        ...approval('p'),
        ...native.rows.sublist(104, 110),
      ]);
      window = window.applyHistory(native.attach(161, 261), catchUp: true);
      window = streamWithRefresh(window, native, native.rows.sublist(261));
      // The reader scrolls up from the bottom: the range the prompt is in
      // reloads first.
      expect(window.releasedRanges['b261']?.olderCursor, 'b161');
      final mutation = window.prependPage(
        native.pageBefore('b261', window.reloadLimitFor('b261')!),
        requestedCursor: 'b261',
      );
      expect(mutation.accepted, isTrue);
      window = mutation.window;
      expectHeldOnceInNativeOrder(window, native);
      expect(retainsKey(window, 'u'), isTrue);
      expect(held(window, 'x0'), 1);
      expect(held(window, 'permission-request:request:p'), 1);
      expect(
        order(window).indexOf('x0'),
        lessThan(order(window).indexOf('y51')),
      );

      // Still beside the range they came from (now the leading edge), in the
      // order they were shown, ahead of the page that holds the prompt.
      expect(order(window).take(13), [
        'x0',
        'x1',
        'x2',
        'x3',
        'p',
        'p',
        'x4',
        'x5',
        'x6',
        'x7',
        'x8',
        'x9',
        'y51',
      ]);
    });

    test('that followed a live copy of a row saved far back lead the range '
        'once that row is back where it was saved', () {
      final native = Native([...rows('a', 100), row('x0'), ...rows('d', 200)]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(50, 100));
      // A live update to a5, saved far back, then an approval and x0.
      window = live(window, [
        native.rows[5],
        ...approval('p'),
        native.rows[100],
      ]);
      window = window.applyHistory(native.attach(201, 301), catchUp: true);
      final mutation = window.prependPage(
        native.pageBefore('b50', window.reloadLimitFor('b50') ?? 50),
        requestedCursor: 'b50',
      );
      expect(mutation.accepted, isTrue);
      window = mutation.window;
      expect(held(window, 'a5'), 1);
      expect(
        order(window).indexOf('p'),
        greaterThan(order(window).indexOf('a99')),
      );

      final filled = fillForward(window, native);
      expect(gapsOf(filled), isEmpty);
      final ordered = order(filled);
      expect(ordered.sublist(ordered.indexOf('a99'), ordered.indexOf('d0')), [
        'a99',
        'p',
        'p',
        'x0',
      ]);
    });

    test('keep their order when a newer page runs into their range from the '
        'one before it and holds only the row one of them followed', () {
      final native = Native([
        ...rows('a', 100),
        ...rows('x', 30),
        ...rows('y', 150),
        ...rows('z', 300),
      ]);
      final reading = keyOf('a50');
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      // A capped reconnect leaves b100..b130 open; its frame holds y0 only.
      window = window.applyHistory(native.attach(130, 131), catchUp: true);
      // An approval asked before y1 and answered after y5, both live.
      final (request, resolution) = (approval('p')[0], approval('p')[1]);
      window = live(window, [
        request,
        ...native.rows.sublist(131, 136),
        resolution,
        ...native.rows.sublist(136, 280),
      ], reading: reading);
      window = window.applyHistory(
        native.delta(131, 280, clientMessageId: 'refresh-131'),
        preserveMessageKey: reading,
      );
      // Live growth releases that block; the approval stays beside it.
      window = live(window, native.rows.sublist(280), reading: reading);
      expect(window.releasedRanges['b280']?.olderCursor, 'b131');
      expect(window.releasedRanges['b130']?.pageableRows, isNull);
      final gap = window.gaps.single;
      expect((gap.forwardCursor, gap.reloadCursor), ('b100', 'b280'));

      // One page from the open range's start runs past y5, not to b280.
      final mutation = window.insertNewerPage(
        native.pageAfter('b100', 'b280', kTranscriptHistoryPageMessages),
        requestedCursor: 'b100',
        until: 'b280',
        preserveMessageKey: reading,
      );
      expect(mutation.accepted, isTrue);
      final approvalRows = [
        for (final message in mutation.window.canonicalMessages)
          if (message.raw['requestId'] == 'p') message.type,
      ];
      expect(approvalRows, [
        AgentMessageType.permissionRequest,
        AgentMessageType.permissionResolved,
      ]);
    });

    test('a never-saved error card keeps its place when an identical one is '
        'saved elsewhere in the range', () {
      final native = Native([
        ...rows('a', 100),
        ...rows('x', 5),
        ...rows('y', 41),
        error,
        ...rows('y', 109, start: 41),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, [
        ...native.rows.sublist(100, 103),
        error,
        ...native.rows.sublist(103, 105),
      ]);
      window = window.applyHistory(native.attach(156, 256), catchUp: true);
      final filled = fillForward(window, native);
      expect(gapsOf(filled), isEmpty);
      final ordered = order(filled);
      expect(
        [
          for (final message in filled.canonicalMessages)
            if (message.type == AgentMessageType.error) message,
        ],
        hasLength(2),
      );
      expect(ordered.sublist(ordered.indexOf('x2'), ordered.indexOf('x4')), [
        'x2',
        null,
        'x3',
      ]);
      expect(ordered.sublist(ordered.indexOf('y40'), ordered.indexOf('y42')), [
        'y40',
        null,
        'y41',
      ]);
    });
  });

  group('no row is announced as never saved while it can still come back', () {
    AgentMessage queuedPrompt(String key) => AgentMessage.fromJson({
      'type': 'user-message',
      'key': key,
      'text': key,
      'queued': true,
    });

    test('a prompt not delivered yet, released from the head, when a frame '
        'heals the release', () {
      final native = Native([
        ...rows('a', 3),
        for (var index = 0; index < 4; index++)
          row('c$index', chars: 450 * 1024),
        AgentMessage.fromJson({
          'type': 'user-message',
          'key': 'q',
          'text': 'q',
        }),
        row('z0'),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 3));
      window = live(window, [queuedPrompt('q'), ...native.rows.sublist(3, 7)]);
      expect(retainsKey(window, 'q'), isFalse);
      window = window.applyHistory(native.delta(3, 7));
      expect(unsavedGaps(window), 0);
      expect(reconnectGaps(window), 0);
      // The agent takes the prompt; the next frame saves it.
      window = live(window, [native.rows[8]]);
      window = window.applyHistory(native.delta(7, 9));
      expect(retainsKey(window, 'q'), isTrue);
      expect(unsavedGaps(window), 0);
    });

    for (final withApproval in [false, true]) {
      test('rows received live beside the gap a capped reconnect left, '
          'released to make room${withApproval ? ', except an approval '
                    'among them' : ''}', () {
        final native = Native([
          ...rows('a', 100),
          ...rows('x', 120),
          ...rows('d', 200),
        ]);
        var window = TranscriptHistoryWindow.fromHistory(
          native.attach(0, 100),
        );
        window = live(window, [
          ...native.rows.sublist(100, 160),
          if (withApproval) ...approval('p'),
          ...native.rows.sublist(160, 220),
        ]);
        window = window.applyHistory(native.attach(320, 420), catchUp: true);
        expect(window.releasedRanges['b320']?.pageableRows, isNull);
        expect(held(window, 'x0'), 1);
        window = live(window, rows('live-', 400));
        // The rows beside the gap gave way; the saved ones are in the gap.
        expect(retainsKey(window, 'x0'), isFalse);
        expect(unsavedGaps(window), withApproval ? 1 : 0);
      });
    }
  });

  group('rows received live after the tail was read from its snapshot', () {
    test('a card the snapshot kept is kept beside the block when it is '
        'released', () {
      final native = Native(rows('m', 200));
      var window = TranscriptHistoryWindow.fromHistory(
        HistoryWireEvent(
          messages: [...native.rows.sublist(100, 150), ...approval('p')],
          reset: true,
          cursor: 'r150',
          olderCursor: 'b100',
          hasEarlier: true,
        ),
      );
      window = window.applyHistory(native.delta(150, 200));
      expect(window.pages.last.blockLiveOnlyRows, [50, 51]);
      window = live(window, rows('live-', 400));
      expect(retainsKey(window, 'm100'), isFalse);
      expect(retainsRequest(window, 'p'), isTrue);
      expect(held(window, 'permission-resolved:request:p'), 1);
    });
  });

  group('a latest-wins row received live', () {
    test('keeps its newer reading when an older page restates the copy read '
        'before it', () {
      AgentMessage summary(String status) => AgentMessage.fromJson({
        'type': 'run-summary',
        'key': 'run:T1',
        'status': status,
        'turnId': 'T1',
      });
      final native = Native([
        ...rows('a', 60),
        summary('running'),
        ...rows('a', 39, start: 61),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(70, 100));
      window = live(window, [summary('done')]);
      final mutation = window.prependPage(
        native.pageBefore('b70', 100),
        requestedCursor: 'b70',
      );
      expect(mutation.accepted, isTrue);
      expect(
        [
          for (final message in mutation.window.canonicalMessages)
            if (message.type == AgentMessageType.runSummary)
              message.raw['status'],
        ],
        ['done'],
      );
    });
  });

  group('a head released with no boundary', () {
    AgentMessage bigResult(String id) => AgentMessage.fromJson({
      'type': 'tool-result',
      'callId': id,
      'toolName': 'Read',
      'result': 'r' * (450 * 1024),
    });
    AgentMessage request(String id) => AgentMessage.fromJson({
      'type': 'permission-request',
      'requestId': id,
      'title': 'Read?',
    });
    // An approval already answered: never saved, and nothing left to act on.
    List<AgentMessage> answered(String id) => [
      request(id),
      AgentMessage.fromJson({
        'type': 'permission-resolved',
        'requestId': id,
        'decision': 'allow',
      }),
    ];

    test('heals when a frame from its release point restates a row released '
        'after one it skips, and leaves a notice for the one never saved', () {
      final native = Native([
        ...rows('a', 100),
        for (var index = 0; index < 4; index++) bigResult('c$index'),
        ...rows('b', 60),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, [
        ...answered('p1'),
        for (var index = 0; index < 4; index++) bigResult('c$index'),
      ]);
      var tail = window.pages.last;
      expect(tail.headReleased, isTrue);
      expect(tail.shedKeys.first, 'permission-request:request:p1');
      expect(reconnectGaps(window), 1);

      window = window.applyHistory(native.delta(100, 104));
      tail = window.pages.last;
      expect(tail.headReleased, isFalse);
      expect(window.liveRowsWithoutBoundary.rows, 0);
      expect(reconnectGaps(window), 0);
      expect(unsavedGaps(window), 1);
      expect(retainsRequest(window, 'p1'), isFalse);

      // Rows after it get their boundaries as usual, one refresh at a time.
      var refreshes = 0;
      for (var index = 104; index < 164; index++) {
        window = live(window, [native.rows[index]]);
        if (historyRefreshDue(
          live: window.liveRowsWithoutBoundary,
          turnEnded: false,
        )) {
          refreshes++;
          final since = int.parse(window.historyCursor!.substring(1));
          window = window.applyHistory(native.delta(since, index + 1));
        }
      }
      expect(refreshes, 1);
      expect(window.pages.last.headReleased, isFalse);
    });

    test('a frame that restates only released rows seals them where the '
        'release began, and the release restarts at its end', () {
      final native = Native([
        ...rows('a', 100),
        for (var index = 0; index < 5; index++) bigResult('c$index'),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, [
        bigResult('c0'),
        ...answered('p1'),
        for (var index = 1; index < 5; index++) bigResult('c$index'),
      ]);
      expect(window.pages.last.shedKeys, [
        'tool-result:call:c0',
        'permission-request:request:p1',
        'permission-resolved:request:p1',
        'tool-result:call:c1',
      ]);
      // A frame that stops after c0 proves nothing about the rows released
      // after it, but it places c0: sealed at its saved boundary, and the
      // release now starts after it.
      window = window.applyHistory(native.delta(100, 101));
      var tail = window.pages.last;
      expect(tail.headReleased, isTrue);
      expect(tail.olderCursor, 'b101');
      expect(tail.shedKeys, [
        'permission-request:request:p1',
        'permission-resolved:request:p1',
        'tool-result:call:c1',
      ]);
      final sealed = window.pages[window.pages.length - 2];
      expect(sealed.newerCursor, 'b101');
      expect(sealed.containsStableKey('tool-result:call:c0'), isTrue);
      expect(reconnectGaps(window), 1);
      expect(unsavedGaps(window), 0);
      // One that restates c1 heals it, and shows p1 was never saved: a notice
      // stands where the release began.
      window = window.applyHistory(native.delta(101, 102));
      tail = window.pages.last;
      expect(tail.headReleased, isFalse);
      expect(reconnectGaps(window), 0);
      expect(unsavedGaps(window), 1);
      expect(retainsRequest(window, 'p1'), isFalse);
      expect(
        window.pages
            .singleWhere((page) => page.headReleased && page.messages.isEmpty)
            .olderCursor,
        'b101',
      );
      window = window.applyHistory(native.delta(102, 105));
      expect(window.liveRowsWithoutBoundary.rows, 0);
      expect(unsavedGaps(window), 1);
      for (final key in ['c2', 'c3', 'c4']) {
        expect(held(window, 'tool-result:call:$key'), 1);
      }
    });
  });

  group('rows no reload returns are never lost silently', () {
    test("(a, b) the reader's page kept across a reset keeps the rows no "
        'reload returns, in place, through the reload that joins it', () {
      final native = Native([
        ...rows('a', 100),
        ...rows('x', 10),
        ...rows('y', 200),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, [
        ...native.rows.sublist(100, 106),
        ...approval('req1'),
        ...native.rows.sublist(106, 110),
      ]);
      final reading = keyOf('x2');
      // A replacement (a history-reset push, not a reconnect's answer).
      window = window.applyHistory(
        native.attach(160, 310),
        preserveMessageKey: reading,
      );
      final anchor = window.pages.first;
      expect(anchor.containsStableKey(reading), isTrue);
      final approvalAt = anchor.messages.indexWhere(
        (m) => m.raw['requestId'] == 'req1',
      );
      expect(anchor.liveOnlyRows, contains(approvalAt));
      expect(window.gaps.single.reloadCursor, 'b160');

      // The older page overlaps the kept page from a60 on: the join trims
      // the kept copy of the rows it restates, and the approval moves into
      // it after the row it followed.
      final reload = window.prependPage(
        native.pageBefore('b160', 100),
        requestedCursor: 'b160',
        preserveMessageKey: reading,
      );
      expect(reload.accepted, isTrue);
      window = reload.window;
      expect(gapsOf(window), isEmpty);
      expect(held(window, 'permission-request:request:req1'), 1);
      final ordered = order(window);
      expect(ordered.indexOf('req1'), ordered.indexOf('x5') + 1);
      // The request and its resolution, then the row that followed them.
      expect(ordered.indexOf('x6'), ordered.indexOf('req1') + 2);
      expectHeldOnceInNativeOrder(window, native);
    });

    test('(a) a reset that cannot keep a row no reload returns says so', () {
      final native = Native([...rows('a', 100), ...rows('z', 200)]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, [...approval('req1'), native.rows[100]]);
      window = window.applyHistory(native.delta(100, 101));
      expect(unsavedGaps(window), 0);
      final replaced = window.applyHistory(native.attach(200, 300));
      expect(retainsRequest(replaced, 'req1'), isFalse);
      expect(unsavedGaps(replaced), 1);
      expect(reconnectGaps(replaced), 0);
      // Nothing is claimed when everything dropped is durable.
      var durable = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      durable = durable.applyHistory(native.delta(100, 150));
      expect(unsavedGaps(durable.applyHistory(native.attach(200, 300))), 0);
    });

    test('(c) where unsaved rows gave way, a notice stands in their place; '
        'past the marker cap the farthest is given up and the window still '
        'says rows were released', () {
      // Each frame persists a tool call, its result and 60 replies; ten
      // approvals arrived live between the call and its result, so each
      // sealed page keeps twenty rows no reload returns.
      final durableRows = <AgentMessage>[...rows('s', 10)];
      final frames = <int>[10];
      for (var index = 0; index < 90; index++) {
        durableRows
          ..add(toolCall('call$index'))
          ..add(toolResult('call$index'))
          ..addAll(rows('f$index-', 60));
        frames.add(durableRows.length);
      }
      final native = Native(durableRows);
      final reading = keyOf('s0');
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 10));
      var markers = 0;
      // Every boundary a marker ever stood at: the reader is at the start, so
      // a marker's distance from it is its boundary's row.
      final everMarked = <int>{};
      for (var index = 0; index < 90; index++) {
        final start = frames[index];
        window = live(window, [
          native.rows[start],
          for (var n = 0; n < 10; n++) ...approval('req$index-$n'),
          ...native.rows.sublist(start + 1, frames[index + 1]),
        ], reading: reading);
        window = window.applyHistory(
          native.delta(start, frames[index + 1]),
          preserveMessageKey: reading,
        );
        expect(reconnectGaps(window), 0, reason: 'frame $index');
        final now = window.pages
            .where((page) => page.isReleasedResidueMarker)
            .length;
        everMarked.addAll([
          for (final page in window.pages)
            if (page.isReleasedResidueMarker) Native.boundary(page.newerCursor),
        ]);
        expect(now, lessThanOrEqualTo(kMaxReleasedResidueMarkers));
        if (now > markers) markers = now;
        expect(
          window.messageCount - window.pages.first.messages.length,
          lessThanOrEqualTo(kMaxActiveTranscriptMessages),
        );
      }
      expect(markers, kMaxReleasedResidueMarkers);
      // Those that stay are the nearest to the reader of all there ever were.
      final kept = {
        for (final page in window.pages)
          if (page.isReleasedResidueMarker) Native.boundary(page.newerCursor),
      };
      expect(
        kept,
        (everMarked.toList()..sort()).take(kMaxReleasedResidueMarkers).toSet(),
      );
      // More residues gave way than markers remain: the window still says
      // unsaved rows were released, at its start.
      expect(window.unsavedReleasedElsewhere, isTrue);
      expect(window.leadingGap?.kind, TranscriptHistoryGapKind.unsavedReleased);
      // Those farthest from the reader gave way, announced; those beside
      // the reader and the newest stay.
      expect(retainsRequest(window, 'req40-0'), isFalse);
      expect(retainsRequest(window, 'req1-0'), isTrue);
      expect(retainsRequest(window, 'req89-9'), isTrue);
    });

    test('(d) a frame that restates rows an older page holds keeps them '
        'there, once', () {
      final native = Native(rows('a', 130));
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = window.applyHistory(native.delta(100, 110));
      expect(window.pages.first.newerCursor, 'b100');
      // A frame from before the tail's start (a stale cursor) restates
      // a90..a109, which the sealed attach page and the tail already hold.
      window = window.applyHistory(native.delta(90, 120));
      expect(held(window, 'a95'), 1);
      expect(held(window, 'a105'), 1);
      expect(held(window, 'a115'), 1);
      expectHeldOnceInNativeOrder(window, native);
      expectExactRanges(window, native);
    });
  });
}
