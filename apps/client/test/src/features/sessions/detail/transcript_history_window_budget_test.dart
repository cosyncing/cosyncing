// Corrected retention invariants for the bounded transcript history window.
//
// The window is the only owner of decoded transcript rows. After every
// mutation it fits one count and decoded-byte budget, and a release must leave
// a broker boundary the range reloads from. Frame and page shapes mirror the
// broker's: `endCursor` pages back to exactly the frame's rows with the frame's
// `olderCursor` (broker suites `history-cap` case 9 and `history-paging-wire`),
// and a frame that starts with a state row reloads with a cursor one row past
// it (`history-cap` case 11).
import 'dart:convert';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:flutter_test/flutter_test.dart';

AgentMessage row(String key, {int chars = 16, String type = 'model-output'}) =>
    AgentMessage.fromJson({'type': type, 'key': key, 'text': 'x' * chars});

List<AgentMessage> rows(
  String prefix,
  int count, {
  int start = 0,
  int chars = 16,
  String type = 'model-output',
}) => [
  for (var index = start; index < start + count; index++)
    row('$prefix$index', chars: chars, type: type),
];

HistoryWireEvent frame(
  List<AgentMessage> messages, {
  String? olderCursor = 'older-0',
  String? endCursor = 'end-0',
  String cursor = 'reconnect-0',
}) => HistoryWireEvent(
  messages: messages,
  reset: true,
  cursor: cursor,
  olderCursor: olderCursor,
  hasEarlier: olderCursor != null,
  endCursor: endCursor,
);

HistoryPageWireEvent page(List<AgentMessage> messages, {String? cursor}) =>
    HistoryPageWireEvent(
      messages: messages,
      cursor: cursor,
      hasMore: cursor != null,
      endOfHistory: cursor == null,
    );

/// An incremental (non-reset) frame, as a reconnect from the tail's cursor
/// delivers it.
HistoryWireEvent delta(
  List<AgentMessage> messages, {
  required String cursor,
  String? endCursor,
}) =>
    HistoryWireEvent(messages: messages, cursor: cursor, endCursor: endCursor);

AgentMessage stateRow(String key, {String type = 'task-list-state'}) =>
    AgentMessage.fromJson({
      'type': type,
      'key': key,
      'title': 'Plan',
      'status': 'running',
      'items': const <Object?>[],
    });

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

int reconnectGaps(TranscriptHistoryWindow window) => gapsOf(
  window,
).where((gap) => gap.kind == TranscriptHistoryGapKind.reconnectRequired).length;

/// Notices that rows no history holds were released (a reload or a reconnect
/// cannot bring them back, so none is offered).
int unsavedGaps(TranscriptHistoryWindow window) => gapsOf(
  window,
).where((gap) => gap.kind == TranscriptHistoryGapKind.unsavedReleased).length;

bool retains(TranscriptHistoryWindow window, String key) =>
    window.canonicalMessages.any((message) => message.raw['key'] == key);

/// How many rows with [key] the window's pages hold, duplicates included.
int held(TranscriptHistoryWindow window, String key) => [
  for (final page in window.pages)
    for (final message in page.messages)
      if (message.raw['key'] == key) message,
].length;

/// The window's row keys in reading order, without the flood of live rows.
List<Object?> durableOrder(TranscriptHistoryWindow window) => [
  for (final message in window.canonicalMessages)
    if (!'${message.raw['key']}'.startsWith('live-')) message.raw['key'],
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

bool retainsRequest(TranscriptHistoryWindow window, String id) =>
    window.canonicalMessages.any((message) => message.raw['requestId'] == id);

/// A broker's durable history, cut into frames and backward pages with the
/// broker's cursor rules: boundary `bN` sits before native row N, a frame
/// ends at the boundary after its last row, and a backward page walks from a
/// boundary until it holds the requested pageable rows.
final class NativeHistory {
  NativeHistory(this.rows);

  final List<AgentMessage> rows;

  static int boundary(String? cursor) =>
      cursor == null ? 0 : int.parse(cursor.substring(1));

  HistoryWireEvent attach(int from, int through) => HistoryWireEvent(
    messages: rows.sublist(from, through),
    reset: true,
    cursor: 'reconnect-$through',
    olderCursor: from > 0 ? 'b$from' : null,
    hasEarlier: from > 0,
    endCursor: 'b$through',
  );

  /// The delta a reconnect from boundary [since] receives.
  HistoryWireEvent delta(int since, int through) => HistoryWireEvent(
    messages: rows.sublist(since, through),
    cursor: 'reconnect-$through',
    endCursor: 'b$through',
  );

  /// Backward-pageable rows between two boundaries.
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
}

/// Every range the window can reload asks for exactly its broker rows: the
/// open block, each older page and each released range.
void expectExactRanges(TranscriptHistoryWindow window, NativeHistory native) {
  for (final page in window.pages) {
    final end = page.isTail ? page.blockEndCursor : page.newerCursor;
    final count = page.isTail ? page.blockPageableRows : page.reloadLimit;
    if (end == null || count == null || page.isResidue || page.headReleased) {
      continue;
    }
    expect(
      count,
      native.pageable(page.olderCursor, end),
      reason: '${page.isTail ? 'block' : 'page'} ${page.olderCursor}..$end',
    );
  }
  for (final MapEntry(key: newer, value: range)
      in window.releasedRanges.entries) {
    if (range.pageableRows == null) continue;
    expect(
      range.pageableRows,
      native.pageable(range.olderCursor, newer),
      reason: 'released ${range.olderCursor}..$newer',
    );
  }
}

/// No broker row is held twice, and the rows held read in persisted order.
void expectHeldOnceInNativeOrder(
  TranscriptHistoryWindow window,
  NativeHistory native,
) {
  final position = <String, int>{
    for (final (index, message) in native.rows.indexed)
      if (isBackwardPageableTranscriptMessage(message))
        ?stableTranscriptMessageKey(message): index,
  };
  final seen = <String>{};
  for (final page in window.pages) {
    for (final message in page.messages) {
      final key = stableTranscriptMessageKey(message);
      if (key == null || !position.containsKey(key)) continue;
      expect(seen.add(key), isTrue, reason: 'held twice: $key');
    }
  }
  final order = [
    for (final message in window.canonicalMessages)
      ?position[stableTranscriptMessageKey(message)],
  ];
  expect(order, [...order]..sort());
}

/// Reloads every reloadable gap and the leading edge exactly, as a reader
/// scrolling back would, checking every range after each reload.
TranscriptHistoryWindow reloadAll(
  TranscriptHistoryWindow window,
  NativeHistory native, {
  String? reading,
}) {
  var next = window;
  for (var round = 0; round < 16; round++) {
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
    expect(mutation.accepted, isTrue, reason: 'reload from $cursor');
    next = mutation.window;
    expectExactRanges(next, native);
  }
  fail('reloads did not converge');
}

String keyOf(String key) => 'model-output:key:$key';

void expectWithinBudget(TranscriptHistoryWindow window) {
  expect(window.messageCount, lessThanOrEqualTo(kMaxActiveTranscriptMessages));
  expect(
    window.estimatedBytes,
    lessThanOrEqualTo(kMaxActiveTranscriptDecodedBytes),
  );
  final tail = window.pages.lastWhere((page) => page.isTail);
  expect(
    tail.messages.length,
    lessThanOrEqualTo(kMaxOpenTranscriptTailMessages),
  );
  expect(
    tail.estimatedBytes,
    lessThanOrEqualTo(kMaxOpenTranscriptTailDecodedBytes),
  );
}

/// [expectWithinBudget], with the non-tail page holding [readerKey] left out
/// of the global count, as the budget itself measures it.
void expectWithinBudgetBeyondReader(
  TranscriptHistoryWindow window,
  String readerKey,
) {
  final reader = window.pages.singleWhere(
    (page) => page.containsStableKey(readerKey),
  );
  expect(reader.isTail, isFalse);
  expect(
    window.messageCount - reader.messages.length,
    lessThanOrEqualTo(kMaxActiveTranscriptMessages),
  );
  expect(
    window.estimatedBytes - reader.estimatedBytes,
    lessThanOrEqualTo(kMaxActiveTranscriptDecodedBytes),
  );
}

void main() {
  group('live growth', () {
    test('the 101st live entry is retained without a reconnect gap', () {
      for (final endCursor in ['end-0', null]) {
        final window = TranscriptHistoryWindow.fromHistory(
          frame(rows('t', 100), endCursor: endCursor),
        ).applyLiveMessage(row('live-100'));

        expect(window.messageCount, 101, reason: 'endCursor=$endCursor');
        expect(retains(window, 't0'), isTrue);
        expect(retains(window, 'live-100'), isTrue);
        expect(gapsOf(window), isEmpty);
        expect(window.olderHistoryCursor, 'older-0');
      }
    });

    test('growth past the tail allowance releases the attach frame whole, '
        'and one exact page restores it', () {
      var window = TranscriptHistoryWindow.fromHistory(frame(rows('t', 100)));
      window = live(window, rows('live-', 350));

      expectWithinBudget(window);
      expect(retains(window, 't0'), isFalse);
      expect(retains(window, 'live-0'), isTrue);
      expect(reconnectGaps(window), 0);
      // The frame's end boundary is now the window's leading edge, and the
      // released range remembers exactly how many rows reload it.
      expect(window.olderHistoryCursor, 'end-0');
      expect(window.reloadLimitFor('end-0'), 100);

      final reload = window.prependPage(
        page(rows('t', 100), cursor: 'older-0'),
        requestedCursor: 'end-0',
      );
      expect(reload.accepted, isTrue);
      window = reload.window;
      expect(retains(window, 't0'), isTrue);
      expect(window.gaps, isEmpty);
      expect(window.olderHistoryCursor, 'older-0');
      expectWithinBudget(window);
    });

    test('a reload that stops past a leading state row joins through the '
        'released range', () {
      final plan = AgentMessage.fromJson(const {
        'type': 'task-list-state',
        'key': 'plan',
        'title': 'Plan',
        'status': 'running',
        'items': <Object?>[],
      });
      var window = TranscriptHistoryWindow.fromHistory(
        frame([plan, ...rows('t', 99)]),
      );
      window = live(window, rows('live-', 350));
      expect(window.reloadLimitFor('end-0'), 99);

      // The broker's walk counts only pageable rows, so it stops after the
      // state row: its cursor is not the frame's own older boundary.
      final reload = window.prependPage(
        page(rows('t', 99), cursor: 'walk-stopped-after-plan'),
        requestedCursor: 'end-0',
      );
      expect(reload.accepted, isTrue);
      expect(reload.window.olderHistoryCursor, 'older-0');
      expect(reload.window.gaps, isEmpty);
    });

    test('live growth releases the page farthest from the reader first, '
        'keeping one contiguous run', () {
      var window = TranscriptHistoryWindow.fromHistory(frame(rows('t', 100)));
      for (final (index, prefix) in ['p', 'q', 'r'].indexed) {
        final mutation = window.prependPage(
          page(rows(prefix, 100), cursor: 'older-${index + 1}'),
          requestedCursor: 'older-$index',
        );
        expect(mutation.accepted, isTrue);
        window = mutation.window;
      }
      window = live(window, rows('live-', 150));

      expectWithinBudget(window);
      expect(retains(window, 'r0'), isFalse);
      expect(retains(window, 'q0'), isTrue);
      expect(retains(window, 'p0'), isTrue);
      expect(window.gaps, isEmpty);
      expect(window.olderHistoryCursor, 'older-2');
      expect(window.reloadLimitFor('older-2'), 100);
    });

    test('2,000 live entries stay inside the budget; only rows delivered '
        'since the last broker boundary can need a reconnect', () {
      var window = TranscriptHistoryWindow.fromHistory(frame(rows('t', 100)));
      window = live(window, rows('live-', 2000));

      expectWithinBudget(window);
      expect(retains(window, 'live-1999'), isTrue);
      // The attach frame left a boundary behind; the live rows had none.
      expect(window.reloadLimitFor('end-0'), 100);
      expect(window.leadingEdgeReleased, isTrue);
      expect(reconnectGaps(window), 1);

      // A reconnect delivers an authoritative frame again, and the residual
      // range is gone with it.
      window = window.applyHistory(
        frame(
          rows('live-', 100, start: 1900),
          olderCursor: 'older-1',
          endCursor: 'end-1',
          cursor: 'reconnect-1',
        ),
      );
      expect(reconnectGaps(window), 0);
    });
  });

  group('decoded bytes', () {
    test('a live mutation over the combined budget releases older pages '
        'recoverably, never the rows just delivered', () {
      var window = TranscriptHistoryWindow.fromHistory(frame(rows('t', 100)));
      final paged = window.prependPage(
        page(rows('o', 100, chars: 9000), cursor: 'older-1'),
        requestedCursor: 'older-0',
      );
      expect(paged.accepted, isTrue);
      window = paged.window;

      window = live(window, rows('big-', 3, chars: 450000));

      expectWithinBudget(window);
      expect(retains(window, 'o0'), isFalse);
      expect(retains(window, 'big-2'), isTrue);
      expect(reconnectGaps(window), 0);
      expect(window.olderHistoryCursor, 'older-0');
      expect(window.reloadLimitFor('older-0'), 100);
    });

    test('one oversized body keeps a flagged, readable preview', () {
      var window = TranscriptHistoryWindow.fromHistory(frame(rows('t', 100)));
      window = window.applyLiveMessage(row('huge', chars: 1000000));

      expectWithinBudget(window);
      final huge = window.canonicalMessages.singleWhere(
        (message) => message.raw['key'] == 'huge',
      );
      expect(huge.bodyTruncated, isTrue);
      expect(
        estimatedAgentMessageDecodedBytes(huge),
        lessThanOrEqualTo(kMaxTranscriptRowDecodedBytes),
      );
      final preview = huge.raw['text'] as String;

      // A continuation cannot be appended to text this client no longer
      // holds; a full restatement replaces the preview.
      window = window.applyLiveMessage(
        AgentMessage.fromJson(const {
          'type': 'model-output',
          'key': 'huge',
          'delta': 'more',
        }),
      );
      expect(
        window.canonicalMessages
            .singleWhere((message) => message.raw['key'] == 'huge')
            .raw['text'],
        preview,
      );
      window = window.applyLiveMessage(row('huge', chars: 10));
      final restated = window.canonicalMessages.singleWhere(
        (message) => message.raw['key'] == 'huge',
      );
      expect(restated.raw['text'], 'x' * 10);
      expect(restated.bodyTruncated, isFalse);
    });

    test('the decoded estimate matches the broker frame bound literal', () {
      // The broker measures frames with a mirror of this estimator; the same
      // literal is pinned in its history-cap suite.
      expect(
        estimatedAgentMessageDecodedBytes(
          AgentMessage.fromJson(const {
            'type': 'model-output',
            'key': 'k',
            'text': 'abc',
          }),
        ),
        334,
      );
    });

    test('the decoded estimate matches the broker across frame shapes', () {
      // The same JSON and the same numbers are pinned in the broker's
      // history-cap suite, measured after the same JSON round trip.
      final shapes = <(String, int)>[
        (
          [
            '{"type":"user-message","key":"u1",',
            '"text":"héllo 👋","sentAt":1700000000000}',
          ].join(),
          422,
        ),
        (
          [
            '{"type":"tool-call","callId":"c1","toolName":"bash",',
            '"title":"Run","args":{"command":"ls -la","timeout":30,',
            '"env":null,"flags":[true,false]}}',
          ].join(),
          930,
        ),
        (
          [
            '{"type":"tool-result","callId":"c1","toolName":"edit",',
            '"title":"Edited a.ts","path":"a.ts","isError":false,',
            '"additions":3,"deletions":1,"fileChanges":[{"path":"a.ts",',
            '"operation":"edit","additions":3,"deletions":1}],',
            '"diffRef":{"fetchUrl":',
            '"/api/sessions/claude/s/artifact/k?expires=1&sig=z",',
            '"contentHash":"${'ab' * 32}","byteSize":1234,"lineCount":40}}',
          ].join(),
          2004,
        ),
        (
          [
            '{"type":"task-list-state","key":"plan","title":"Plan",',
            '"status":"running","items":[{"id":"1","title":"step one",',
            '"status":"completed"},{"id":"2","title":"step two",',
            '"status":"in-progress"}]}',
          ].join(),
          1242,
        ),
        (
          [
            '{"type":"metadata-update","key":"runtimeTotals",',
            '"value":{"tokens":[],"cost":{},"ratio":0.5}}',
          ].join(),
          686,
        ),
        (
          '{"type":"model-output","key":"long","text":"${'x' * 1000}",'
              ' "final":true}',
          2408,
        ),
      ];
      for (final (json, expected) in shapes) {
        final message = AgentMessage.fromJson(
          jsonDecode(json) as Map<String, dynamic>,
        );
        expect(
          estimatedAgentMessageDecodedBytes(message),
          expected,
          reason: json,
        );
      }
    });
  });

  group('frame size mismatch', () {
    test('an oversized legacy reset keeps the tail allowance and names the '
        'rest', () {
      final window = TranscriptHistoryWindow.fromHistory(
        frame(rows('s', 500), endCursor: null),
      );

      expectWithinBudget(window);
      expect(window.messageCount, kMaxOpenTranscriptTailMessages);
      expect(retains(window, 's499'), isTrue);
      expect(
        window.leadingGap?.kind,
        TranscriptHistoryGapKind.reconnectRequired,
      );
      expect(
        window.latestHistoryTruncation?.shown,
        kMaxOpenTranscriptTailMessages,
      );
      expect(window.latestHistoryTruncation?.total, 500);
    });

    test('a snapshot the window wrote hydrates whole', () {
      var window = TranscriptHistoryWindow.fromHistory(frame(rows('t', 100)));
      window = live(window, rows('live-', 290));
      final snapshot = window.persistableTail();
      expect(snapshot.messages, hasLength(390));

      final hydrated = TranscriptHistoryWindow.fromHistory(
        HistoryWireEvent(
          messages: snapshot.messages,
          reset: true,
          olderCursor: snapshot.olderCursor,
          hasEarlier: snapshot.olderCursor != null,
        ),
        headReleased: snapshot.headReleased,
      );
      expect(hydrated.messageCount, 390);
      expect(gapsOf(hydrated), isEmpty);
      expect(hydrated.olderHistoryCursor, 'older-0');
    });

    test('a tail that released rows without a boundary persists no cursor', () {
      var window = TranscriptHistoryWindow.fromHistory(frame(rows('t', 100)));
      window = live(window, rows('live-', 1000));
      final snapshot = window.persistableTail();

      expect(snapshot.headReleased, isTrue);
      expect(snapshot.olderCursor, isNull);
    });
  });

  group("the reader's row", () {
    test('an attach row being read survives any amount of live growth', () {
      var window = TranscriptHistoryWindow.fromHistory(frame(rows('t', 100)));
      window = live(window, rows('live-', 2000), reading: keyOf('t0'));

      expect(
        window.messageCount,
        lessThanOrEqualTo(kMaxActiveTranscriptMessages),
      );
      expect(retains(window, 't0'), isTrue);
      // The whole frame is kept as its own page, still joined by cursor to
      // everything before it.
      final kept = window.pages.first;
      expect(kept.containsStableKey(keyOf('t0')), isTrue);
      expect(kept.containsStableKey(keyOf('t99')), isTrue);
      expect(kept.olderCursor, 'older-0');
      expect(kept.newerCursor, 'end-0');
    });

    test('a live row being read survives live growth past it', () {
      var window = TranscriptHistoryWindow.fromHistory(frame(rows('t', 100)));
      window = live(window, rows('live-', 20));
      window = live(window, rows('more-', 2000), reading: keyOf('live-10'));

      expect(retains(window, 'live-10'), isTrue);
      expect(retains(window, 'more-1999'), isTrue);
      expect(
        window.messageCount,
        lessThanOrEqualTo(kMaxActiveTranscriptMessages),
      );
    });

    test('an older page being read is kept while the pages around it are '
        'released, and the middle gap reloads exactly', () {
      var window = TranscriptHistoryWindow.fromHistory(frame(rows('t', 100)));
      for (final (index, prefix) in ['p', 'q'].indexed) {
        final mutation = window.prependPage(
          page(rows(prefix, 100), cursor: 'older-${index + 1}'),
          requestedCursor: 'older-$index',
        );
        expect(mutation.accepted, isTrue);
        window = mutation.window;
      }
      // Oldest first: q (older-2 .. older-1), p (older-1 .. older-0), tail.
      expect(window.olderHistoryCursor, 'older-2');

      window = live(window, rows('live-', 250), reading: keyOf('q0'));
      expectWithinBudget(window);
      expect(retains(window, 'q0'), isTrue);
      expect(retains(window, 'p0'), isFalse);
      expect(reconnectGaps(window), 0);
      final middle = window.gaps.single;
      expect(middle.kind, TranscriptHistoryGapKind.reloadable);
      expect(middle.reloadCursor, 'older-0');
      expect(window.reloadLimitFor('older-0'), 100);

      final reload = window.prependPage(
        page(rows('p', 100), cursor: 'older-1'),
        requestedCursor: 'older-0',
        preserveMessageKey: keyOf('q0'),
      );
      expect(reload.accepted, isTrue);
      // The reader's page is the one exception to the budget: the reload is
      // measured without it, so the open tail keeps its whole allowance.
      expectWithinBudgetBeyondReader(reload.window, keyOf('q0'));
      expect(retains(reload.window, 't0'), isTrue);
      expect(retains(reload.window, 'q0'), isTrue);
      expect(retains(reload.window, 'p0'), isTrue);
      expect(reconnectGaps(reload.window), 0);
    });

    test('a reset keeps the page being read joined to an overlapping '
        'replacement', () {
      final old = TranscriptHistoryWindow.fromHistory(
        frame(rows('k', 100, type: 'user-message')),
      );
      final reset = old.applyHistory(
        frame(
          rows('k', 100, start: 50, type: 'user-message'),
          olderCursor: 'older-50',
          endCursor: 'end-1',
          cursor: 'reconnect-1',
        ),
        preserveMessageKey: 'user-message:key:k10',
      );

      expect(retains(reset, 'k10'), isTrue);
      expect(gapsOf(reset), isEmpty);
      expect(reset.messageCount, 150);
      expect(reset.pages.first.newerCursor, 'older-50');
    });

    test('a reset while reading a large page keeps the whole replacement, and '
        'the open tail keeps its allowance', () {
      final reading = keyOf('r10');
      final old = TranscriptHistoryWindow.fromHistory(
        frame(rows('r', 390, chars: 3600)),
      );
      var window = old.applyHistory(
        frame(
          rows('n', 100, chars: 7000),
          olderCursor: 'older-9',
          endCursor: 'end-9',
          cursor: 'reconnect-9',
        ),
        preserveMessageKey: reading,
      );
      // Together they exceed the byte budget; only the reader's page does.
      expect(
        window.estimatedBytes,
        greaterThan(kMaxActiveTranscriptDecodedBytes),
      );
      expectWithinBudgetBeyondReader(window, reading);
      expect(retains(window, 'r10'), isTrue);
      expect(retains(window, 'n0'), isTrue);
      expect(retains(window, 'n99'), isTrue);
      expect(reconnectGaps(window), 0);

      window = live(window, rows('live-', 50), reading: reading);
      expect(retains(window, 'n0'), isTrue);
      expect(reconnectGaps(window), 0);

      window = live(window, rows('more-', 400), reading: reading);
      expectWithinBudgetBeyondReader(window, reading);
      expect(retains(window, 'r10'), isTrue);
      expect(
        window.pages.last.messages.length,
        kMaxOpenTranscriptTailMessages,
      );
    });
  });

  group('incremental frames with endCursor', () {
    test('each frame seals the previous block as its own page, so repeated '
        'reconnects keep the newest rows', () {
      var window = TranscriptHistoryWindow.fromHistory(
        frame([stateRow('plan'), ...rows('t', 99)]),
      );
      for (var index = 1; index <= 5; index++) {
        window = window.applyHistory(
          delta(
            rows('f$index-', 100),
            cursor: 'reconnect-$index',
            endCursor: 'end-$index',
          ),
        );
        expectWithinBudget(window);
        expect(retains(window, 'f$index-0'), isTrue, reason: 'frame $index');
        expect(window.pages.last.messages.length, 100);
        expect(window.pages.last.olderCursor, 'end-${index - 1}');
      }
      // The attach frame gave way whole, and reloads exactly its pageable
      // rows (the plan is not one).
      expect(retains(window, 't0'), isFalse);
      expect(retains(window, 'f1-0'), isTrue);
      expect(reconnectGaps(window), 0);
      expect(window.gaps, isEmpty);
      expect(window.olderHistoryCursor, 'end-0');
      expect(window.reloadLimitFor('end-0'), 99);
    });

    test('small frames join the contiguous sealed page while it fits one '
        'page', () {
      var window = TranscriptHistoryWindow.fromHistory(frame(rows('t', 30)));
      for (final (index, prefix) in ['a', 'b', 'c', 'd'].indexed) {
        window = window.applyHistory(
          delta(
            rows(prefix, 30),
            cursor: 'reconnect-${index + 1}',
            endCursor: 'end-${index + 1}',
          ),
        );
      }
      expect(window.pages, hasLength(3));
      final [joined, next, tail] = window.pages;
      expect(joined.messages, hasLength(90));
      expect(joined.olderCursor, 'older-0');
      expect(joined.newerCursor, 'end-2');
      expect(joined.reloadLimit, 90);
      expect(next.olderCursor, 'end-2');
      expect(next.newerCursor, 'end-3');
      expect(next.reloadLimit, 30);
      expect(tail.olderCursor, 'end-3');
      expect(tail.messages.map((m) => m.raw['key']).first, 'd0');
      expect(window.gaps, isEmpty);
    });

    test('a frame and the block it seals each reload exactly their own '
        'pageable rows', () {
      var window = TranscriptHistoryWindow.fromHistory(
        frame([stateRow('plan'), ...rows('t', 9)]),
      );
      window = window.applyHistory(
        delta(
          [...rows('d', 4), stateRow('plan-2'), ...rows('d', 3, start: 4)],
          cursor: 'reconnect-1',
          endCursor: 'end-1',
        ),
      );
      final sealed = window.pages.first;
      expect(sealed.messages, hasLength(10));
      expect(sealed.reloadLimit, 9);
      expect(sealed.newerCursor, 'end-0');

      window = live(window, rows('live-', 400));
      expect(retains(window, 'd0'), isFalse);
      expect(retains(window, 't0'), isTrue);
      expect(reconnectGaps(window), 0);
      final gap = window.gaps.single;
      expect(gap.kind, TranscriptHistoryGapKind.reloadable);
      expect(gap.reloadCursor, 'end-1');
      expect(window.reloadLimitFor('end-1'), 7);
    });

    test('a frame after the block was released starts a new block through '
        'the rows it restates', () {
      var window = TranscriptHistoryWindow.fromHistory(frame(rows('t', 100)));
      window = live(window, rows('live-', 350));
      expect(window.olderHistoryCursor, 'end-0');

      window = window.applyHistory(
        delta(
          [...rows('live-', 350), ...rows('d', 10)],
          cursor: 'reconnect-1',
          endCursor: 'end-1',
        ),
      );
      window = live(window, rows('after-', 50));
      expectWithinBudget(window);
      expect(retains(window, 'd9'), isFalse);
      expect(retains(window, 'after-0'), isTrue);
      expect(reconnectGaps(window), 0);
      expect(window.olderHistoryCursor, 'end-1');
      expect(window.reloadLimitFor('end-1'), 360);
      expect(window.reloadLimitFor('end-0'), 100);
    });

    test('a frame from the released block end heals a head-released tail', () {
      // A state-only block: its release leaves the tail on the block's own
      // older boundary, so healing cannot key on that boundary.
      var window = TranscriptHistoryWindow.fromHistory(
        frame([stateRow('plan')]),
      );
      window = live(window, rows('live-', 401));
      expect(window.leadingEdgeReleased, isTrue);
      expect(reconnectGaps(window), 1);

      window = window.applyHistory(
        delta(rows('live-', 401), cursor: 'reconnect-1', endCursor: 'end-1'),
      );
      expect(window.leadingEdgeReleased, isFalse);
      expect(reconnectGaps(window), 0);
      // The restated rows are one broker range now, released whole to fit.
      expect(window.olderHistoryCursor, 'end-1');
      expect(window.reloadLimitFor('end-1'), 401);
    });

    test('a live row the frame does not carry follows it, outside the block, '
        'and stays in the tail when the block is released', () {
      var window = TranscriptHistoryWindow.fromHistory(frame(rows('t', 10)));
      // A prompt just sent, not yet persisted, ahead of a state-only frame.
      window = window.applyLiveMessage(row('u1', type: 'user-message'));
      window = window.applyHistory(
        delta([stateRow('plan')], cursor: 'reconnect-1', endCursor: 'end-1'),
      );
      // Not saved by the frame's end, so saved (if ever) after it: the block
      // ends with the frame, and the prompt still waits for a boundary.
      expect(window.pages.last.messages.map((m) => m.raw['key']), [
        'plan',
        'u1',
      ]);
      expect(window.pages.last.blockRows, 1);
      expect(window.liveRowsWithoutBoundary.rows, 1);

      window = live(window, rows('live-', 399));
      expect(retains(window, 'u1'), isTrue);
      expect(retains(window, 'plan'), isFalse);
      expect(window.pages.last.messages.first.raw['key'], 'u1');
      expect(reconnectGaps(window), 0);
    });

    test('a prompt no frame has saved yet follows the frame rows, including '
        'one the tail missed, and stays after their block once it is '
        'released', () {
      var window = TranscriptHistoryWindow.fromHistory(frame(rows('m', 1)));
      window = window.applyLiveMessage(row('u1', type: 'user-message'));
      window = window.applyHistory(
        delta(
          [row('m0'), row('m1')],
          cursor: 'reconnect-1',
          endCursor: 'end-1',
        ),
      );
      // `m1` was saved before the prompt, which no frame holds yet.
      expect(window.pages.last.messages.map((m) => m.raw['key']), [
        'm0',
        'm1',
        'u1',
      ]);
      expect(window.pages.last.blockRows, 2);
      // A frame from an older cursor restates `m1`, a row the block already
      // holds: the block grows through the frame instead of sealing, and the
      // prompt stays after it.
      window = window.applyHistory(
        delta([row('m1'), row('y')], cursor: 'reconnect-2', endCursor: 'end-2'),
      );
      expect(window.pages.last.messages.map((m) => m.raw['key']), [
        'm0',
        'm1',
        'y',
        'u1',
      ]);
      expect(window.pages.last.blockRows, 3);
      window = live(window, rows('live-', 398));
      // Released whole, the block leaves the prompt at the head of the rows
      // received live: after the reloadable gap, before the live rows.
      expect(window.pages.where((page) => page.isResidue), isEmpty);
      expect(window.pages.last.messages.first.raw['key'], 'u1');
      expect(window.pages.last.messages[1].raw['key'], 'live-0');
      // The released block leads the window: loading earlier reloads it,
      // exactly.
      expect(window.olderHistoryCursor, 'end-2');
      expect(window.reloadLimitFor('end-2'), 3);
      expect(reconnectGaps(window), 0);
    });
    test('a live-only approval keeps its place among the frame rows, and '
        'survives the release of their block', () {
      var window = TranscriptHistoryWindow.fromHistory(frame(rows('b', 3)));
      final call = AgentMessage.fromJson(const {
        'type': 'tool-call',
        'callId': 'call1',
        'toolName': 'Bash',
        'args': <String, Object?>{},
      });
      final result = AgentMessage.fromJson(const {
        'type': 'tool-result',
        'callId': 'call1',
        'toolName': 'Bash',
        'result': 'ok',
      });
      // The agent never persists approval rows, so no frame carries them.
      window = live(window, [
        call,
        AgentMessage.fromJson(const {
          'type': 'permission-request',
          'requestId': 'req1',
          'title': 'Run Bash?',
        }),
        AgentMessage.fromJson(const {
          'type': 'permission-resolved',
          'requestId': 'req1',
          'decision': 'allow',
        }),
        result,
        row('after'),
      ]);
      window = window.applyHistory(
        delta(
          [call, result, row('after'), row('x1')],
          cursor: 'reconnect-1',
          endCursor: 'end-1',
        ),
      );
      String identity(AgentMessage message) {
        final raw = message.raw;
        return '${raw['key'] ?? raw['requestId'] ?? raw['callId']}';
      }

      List<String> order(Iterable<AgentMessage> messages) => [
        for (final message in messages)
          '${message.raw['type']}:${identity(message)}',
      ];
      expect(order(window.canonicalMessages), [
        'model-output:b0',
        'model-output:b1',
        'model-output:b2',
        'tool-call:call1',
        'permission-request:req1',
        'permission-resolved:req1',
        'tool-result:call1',
        'model-output:after',
        'model-output:x1',
      ]);

      window = live(window, rows('live-', 396));
      expect(retains(window, 'x1'), isFalse);
      // The released block's rows reload behind a gap; the approval stays
      // beside it, before everything that followed it.
      final beside = window.pages[window.pages.length - 2];
      expect(beside.isResidue, isTrue);
      expect(order(beside.messages), [
        'permission-request:req1',
        'permission-resolved:req1',
      ]);
      expect(order(window.pages.last.messages.take(1)), [
        'model-output:live-0',
      ]);
      expect(reconnectGaps(window), 0);
      expect(window.reloadLimitFor('end-1'), 4);
    });

    test('a live row the next frame saves after a row the tail missed '
        'follows that row, and everything reloads once in saved '
        'order', () {
      final native = NativeHistory([
        ...rows('a', 4),
        row('x'),
        row('y'),
        row('L'),
        row('z'),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 4));
      window = live(window, [row('x'), row('L')]);
      window = window.applyHistory(native.delta(4, 6));
      // `y` was saved before `L`, which no frame holds yet.
      expect(window.pages.last.messages.map((m) => m.raw['key']), [
        'x',
        'y',
        'L',
      ]);
      expect(window.pages.last.blockRows, 2);
      expect(window.pages.last.blockLiveOnlyRows, isEmpty);
      window = window.applyHistory(native.delta(6, 8));
      final tail = window.pages.last;
      expect(tail.messages.map((m) => m.raw['key']), ['L', 'z']);
      expect(tail.blockRows, 2);
      expectExactRanges(window, native);
      expectHeldOnceInNativeOrder(window, native);

      // One row past the tail's allowance releases the block whole.
      window = live(window, rows('live-', 399));
      expect(retains(window, 'L'), isFalse);
      expect(retains(window, 'z'), isFalse);
      window = reloadAll(window, native);
      expect(durableOrder(window).take(8), [
        'a0',
        'a1',
        'a2',
        'a3',
        'x',
        'y',
        'L',
        'z',
      ]);
      for (final key in ['x', 'L', 'y', 'z']) {
        expect(held(window, key), 1, reason: key);
      }
      expect(gapsOf(window), isEmpty);
    });
    test('a prompt the frame after a missed row saves opens the next block, '
        'which reloads exactly', () {
      var window = TranscriptHistoryWindow.fromHistory(frame([row('a')]));
      // A prompt just sent, then persisted only after the next row.
      window = window.applyLiveMessage(row('u', type: 'user-message'));
      window = window.applyHistory(
        delta([row('y')], cursor: 'reconnect-1', endCursor: 'end-1'),
      );
      // Not saved by the frame's end: it follows the frame's rows, outside
      // the block.
      expect(window.pages.last.messages.map((m) => m.raw['key']), ['y', 'u']);
      expect(window.pages.last.blockRows, 1);
      expect(window.pages.last.blockLiveOnlyRows, isEmpty);
      window = window.applyHistory(
        delta(
          [row('u', type: 'user-message'), row('z')],
          cursor: 'reconnect-2',
          endCursor: 'end-2',
        ),
      );
      // The frame saved it after `y`: `y`'s block is sealed at its boundary,
      // and the prompt opens the next.
      final tail = window.pages.last;
      expect(tail.messages.map((m) => m.raw['key']), ['u', 'z']);
      expect(tail.blockRows, 2);
      expect(tail.blockLiveOnlyRows, isEmpty);
      expect(tail.olderCursor, 'end-1');
      expect(durableOrder(window), ['a', 'y', 'u', 'z']);

      window = live(window, rows('live-', 399));
      expect(retains(window, 'u'), isFalse);
      expect(window.reloadLimitFor('end-2'), 2);
      final reloaded = window.prependPage(
        page([row('u', type: 'user-message'), row('z')], cursor: 'end-1'),
        requestedCursor: 'end-2',
      );
      expect(reloaded.accepted, isTrue);
      window = reloaded.window;
      expect(durableOrder(window), ['a', 'y', 'u', 'z']);
      for (final key in ['u', 'y', 'z']) {
        expect(held(window, key), 1, reason: key);
      }
      expect(gapsOf(window), isEmpty);
    });

    test('a live row a later frame saves on its own is sealed after the '
        'block it followed, and reloads once', () {
      final native = NativeHistory([
        ...rows('a', 4),
        row('x'),
        row('y'),
        row('L'),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 4));
      window = live(window, [row('x'), row('L')]);
      window = window.applyHistory(native.delta(4, 6));
      window = window.applyHistory(native.delta(6, 7));
      final tail = window.pages.last;
      expect(tail.messages.map((m) => m.raw['key']), ['L']);
      expect(tail.blockRows, 1);
      expect(tail.blockLiveOnlyRows, isEmpty);
      expectExactRanges(window, native);
      expectHeldOnceInNativeOrder(window, native);

      window = live(window, rows('live-', 400));
      expect(retains(window, 'L'), isFalse);
      window = reloadAll(window, native);
      expect(durableOrder(window).take(7), [
        'a0',
        'a1',
        'a2',
        'a3',
        'x',
        'y',
        'L',
      ]);
      for (final key in ['x', 'L', 'y']) {
        expect(held(window, key), 1, reason: key);
      }
      expect(gapsOf(window), isEmpty);
    });
    test("a superseded frame's state row stays inside the frame's block, "
        'before the prompt it predates', () {
      var window = TranscriptHistoryWindow.fromHistory(frame(rows('t', 10)));
      window = live(window, [
        stateRow('plan'),
        row('x'),
        // Not yet persisted: the frame below predates it.
        row('y', type: 'user-message'),
      ]);
      window = window.applyHistory(
        delta(
          [row('x'), stateRow('plan')],
          cursor: 'reconnect-1',
          endCursor: 'end-1',
        ),
      );
      // The merge keeps the newer retained reading of the plan, but the row
      // is still the frame's: the block ends after it, and the prompt no
      // frame holds follows it.
      expect(window.pages.last.messages.map((m) => m.raw['key']), [
        'x',
        'plan',
        'y',
      ]);
      expect(window.pages.last.blockRows, 2);
      window = live(window, rows('live-', 398));
      expect(retains(window, 'x'), isFalse);
      expect(retains(window, 'plan'), isFalse);
      expect(window.pages.where((page) => page.isResidue), isEmpty);
      expect(window.pages.last.messages.first.raw['key'], 'y');
    });
  });

  group('stale frames', () {
    test("frames from stale cursors that restate the block's rows grow it, "
        'and it reloads exactly once released', () {
      final native = NativeHistory([
        ...rows('p', 10),
        ...rows('a', 110),
        ...rows('b', 50),
        ...rows('y', 50),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(10, 120));
      window = window.applyLiveMessage(row('u1', type: 'user-message'));
      // Each reconnect starts before the block's end, so each frame restates
      // rows the block already holds.
      window = window.applyHistory(native.delta(10, 170));
      expectExactRanges(window, native);
      window = window.applyHistory(native.delta(120, 220));
      expectExactRanges(window, native);
      expect(window.pages, hasLength(1));
      expect(window.pages.single.olderCursor, 'b10');
      expect(window.pages.single.blockPageableRows, 210);

      window = live(window, rows('live-', 190));
      expect(retains(window, 'a0'), isFalse);
      expect(window.reloadLimitFor('b220'), 210);
      expectExactRanges(window, native);
      window = reloadAll(window, native);
      expectHeldOnceInNativeOrder(window, native);
      expect(held(window, 'u1'), 1);
      expect(gapsOf(window), isEmpty);
      expect(window.olderHistoryCursor, isNull);
    });

    test("a stale state row the merge keeps at the frame's first row reloads "
        'exactly whether or not the block before it seals', () {
      // The equality case of the seal guard: the frame restates the block's
      // own plan first, and being superseded (the prompt after its last row
      // is not in it) the merge keeps the tail's copy.
      final native = NativeHistory([
        stateRow('plan'),
        ...rows('t', 100),
        stateRow('plan'),
        ...rows('x', 50),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 101));
      window = live(window, native.rows.sublist(102, 152));
      window = window.applyLiveMessage(row('y', type: 'user-message'));
      window = window.applyHistory(native.delta(101, 152));
      expectExactRanges(window, native);

      // Live growth releases every range: the block's page (if sealed) by the
      // window budget, the block by the tail allowance.
      window = live(window, rows('live-', 349));
      expect(retains(window, 't0'), isFalse);
      expect(retains(window, 'x0'), isFalse);
      expectExactRanges(window, native);
      window = reloadAll(window, native);
      expectHeldOnceInNativeOrder(window, native);
      expect(held(window, 'y'), 1);
      expect(gapsOf(window), isEmpty);
      expect(window.olderHistoryCursor, isNull);
    });
  });

  group('rows no reload returns', () {
    test('an approval sealed into a page stays beside the released range and '
        'returns to its place on the exact reload', () {
      final native = NativeHistory([
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
      expect(window.pages[1].liveOnlyRows, [1, 2]);

      final reading = keyOf('b0');
      window = live(window, rows('live-', 346), reading: reading);
      expect(retains(window, 'after'), isFalse);
      expect(retainsRequest(window, 'req1'), isTrue);
      final gap = window.gaps.single;
      expect(gap.kind, TranscriptHistoryGapKind.reloadable);
      expect(gap.reloadCursor, 'b103');
      expect(window.reloadLimitFor('b103'), 3);
      expectExactRanges(window, native);

      final reloaded = window.prependPage(
        native.pageBefore('b103', 3),
        requestedCursor: 'b103',
        preserveMessageKey: reading,
      );
      expect(reloaded.accepted, isTrue);
      window = reloaded.window;
      final page = window.pages[1];
      expect(
        [for (final m in page.messages) m.raw['type']],
        [
          'tool-call',
          'permission-request',
          'permission-resolved',
          'tool-result',
          'model-output',
        ],
      );
      expect(gapsOf(window), isEmpty);
      expectHeldOnceInNativeOrder(window, native);
      expectExactRanges(window, native);

      // Released again, it leaves the same residue.
      window = live(window, [row('live-more')], reading: reading);
      expect(retains(window, 'after'), isFalse);
      expect(retainsRequest(window, 'req1'), isTrue);
      expect(window.gaps.single.reloadCursor, 'b103');
    });

    test("an approval in the reader's block page stays when that page is "
        'released later', () {
      final native = NativeHistory([
        ...rows('b', 90),
        toolCall('call1'),
        toolResult('call1'),
        ...rows('z', 100),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 90));
      window = live(window, [
        native.rows[90],
        ...approval('req1'),
        native.rows[91],
      ]);
      window = window.applyHistory(native.delta(90, 192));
      // Reading the call keeps its block whole as the reader's page.
      window = live(
        window,
        rows('live-', 297),
        reading: 'tool-call:call:call1',
      );
      final split = window.pages.singleWhere(
        (page) =>
            !page.isTail && page.containsStableKey('tool-call:call:call1'),
      );
      expect(split.liveOnlyRows, [1, 2]);

      // The reader moves back; the block's page gives way to the budget.
      final reading = keyOf('b0');
      window = live(window, rows('more-', 10), reading: reading);
      expect(retains(window, 'z0'), isFalse);
      expect(retainsRequest(window, 'req1'), isTrue);
      expect(window.gaps.single.reloadCursor, 'b192');
      final reloaded = window.prependPage(
        native.pageBefore('b192', window.reloadLimitFor('b192')!),
        requestedCursor: 'b192',
        preserveMessageKey: reading,
      );
      expect(reloaded.accepted, isTrue);
      window = reloaded.window;
      expect(
        [for (final m in window.pages[1].messages.take(5)) m.raw['type']],
        [
          'tool-call',
          'permission-request',
          'permission-resolved',
          'tool-result',
          'model-output',
        ],
      );
      expect(gapsOf(window), isEmpty);
      expectHeldOnceInNativeOrder(window, native);
    });

    test('an approval sealed onto a joined page keeps its place through the '
        "joined range's release and reload", () {
      final native = NativeHistory([
        ...rows('b', 3, chars: 200000),
        toolCall('call1'),
        toolResult('call1'),
        row('after'),
        row('x', chars: 450000),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 3));
      window = live(window, [
        native.rows[3],
        ...approval('req1'),
        native.rows[4],
        native.rows[5],
      ]);
      window = window.applyHistory(native.delta(3, 6));
      window = window.applyHistory(native.delta(6, 7));
      // One contiguous sealed range: the attach frame and the approval block.
      expect(window.pages.first.olderCursor, isNull);
      expect(window.pages.first.newerCursor, 'b6');
      expect(window.pages.first.liveOnlyRows, [4, 5]);

      var index = 0;
      while (!window.releasedRanges.containsKey('b6') && index < 400) {
        window = window.applyLiveMessage(row('live-$index', chars: 10000));
        index += 1;
      }
      expect(retains(window, 'b0'), isFalse);
      expect(retainsRequest(window, 'req1'), isTrue);
      expect(window.reloadLimitFor('b6'), 6);
      expectExactRanges(window, native);
      final reloaded = window.prependPage(
        native.pageBefore('b6', 6),
        requestedCursor: 'b6',
      );
      expect(reloaded.accepted, isTrue);
      window = reloaded.window;
      expectExactRanges(window, native);
      expect(
        [for (final m in window.pages.first.messages) m.raw['type']],
        [
          'model-output',
          'model-output',
          'model-output',
          'tool-call',
          'permission-request',
          'permission-resolved',
          'tool-result',
          'model-output',
        ],
      );
      expectHeldOnceInNativeOrder(window, native);
    });

    test('a sealed prompt that a later frame persisted is not kept twice', () {
      final prompt = row('u', type: 'user-message');
      final native = NativeHistory([
        ...rows('b', 100),
        row('c'),
        row('d'),
        prompt,
        row('e'),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, [prompt, native.rows[100]]);
      window = window.applyHistory(native.delta(100, 101));
      window = window.applyHistory(native.delta(101, 102));
      expect(window.pages[1].liveOnlyRows, [0]);
      // The prompt is persisted after `d`, and the frame carrying it lands
      // in the tail.
      window = window.applyHistory(native.delta(102, 104));

      window = live(window, rows('live-', 397), reading: keyOf('b0'));
      expect(retains(window, 'c'), isFalse);
      expect(held(window, 'u'), 1);
      expectHeldOnceInNativeOrder(window, native);
    });

    test('residues give way last, and where their rows were released says so '
        'without offering a recovery', () {
      final native = NativeHistory([
        ...rows('b', 10),
        for (var index = 0; index < 60; index++) ...[
          toolCall('call$index'),
          toolResult('call$index'),
        ],
        row('x'),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 10));
      for (var index = 0; index < 60; index++) {
        window = live(window, [
          native.rows[10 + 2 * index],
          ...approval('req$index'),
          native.rows[11 + 2 * index],
        ]);
      }
      window = window.applyHistory(native.delta(10, 130));
      window = window.applyHistory(native.delta(130, 131));
      expect(window.pages[1].liveOnlyRows, hasLength(120));

      window = live(window, rows('live-', 260));
      // The approvals outlived their page and the older one.
      expect(retains(window, 'b0'), isFalse);
      expect(retainsRequest(window, 'req0'), isTrue);
      expect(reconnectGaps(window), 0);

      // Only once the tail's block is gone too do they give way, visibly: a
      // notice that rows no history holds were released there. A reconnect
      // would not bring them back either, so none is asked for.
      window = live(window, rows('more-', 121));
      expect(retainsRequest(window, 'req0'), isFalse);
      expect(unsavedGaps(window), 1);
      expect(reconnectGaps(window), 0);
      expectExactRanges(window, native);
      expect(
        window.messageCount,
        lessThanOrEqualTo(kMaxActiveTranscriptMessages),
      );
    });

    test('an approval in a released block stays beside it, so live growth '
        'past the allowance releases only rows a frame restates, and that '
        'frame heals the release', () {
      final native = NativeHistory([
        ...rows('b', 3),
        toolCall('call1'),
        toolResult('call1'),
        ...rows('live-', 420),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 3));
      window = live(window, [
        native.rows[3],
        ...approval('req1'),
        native.rows[4],
      ]);
      window = window.applyHistory(native.delta(3, 5));
      // The approval stays beside the block when the block goes; live growth
      // past the allowance then releases only rows delivered live since.
      window = live(window, native.rows.sublist(5, 406));
      expect(retainsRequest(window, 'req1'), isTrue);
      expect(window.pages.last.headReleased, isTrue);
      expect(reconnectGaps(window), 1);

      // The frame restates every row the release dropped, so it heals.
      window = window.applyHistory(native.delta(5, 425));
      expect(reconnectGaps(window), 0);
      expect(retainsRequest(window, 'req1'), isTrue);
    });
  });

  group('cards waiting for an answer', () {
    AgentMessage waiting(String id) => AgentMessage.fromJson({
      'type': 'permission-request',
      'requestId': id,
      'title': 'Run Bash?',
    });
    AgentMessage bigResult(String id) => AgentMessage.fromJson({
      'type': 'tool-result',
      'callId': id,
      'toolName': 'Read',
      'result': 'r' * (450 * 1024),
    });
    int heldCards(TranscriptHistoryWindow window, String id) => [
      for (final page in window.pages)
        for (final message in page.messages)
          if (message.type == AgentMessageType.permissionRequest &&
              message.raw['requestId'] == id)
            message,
    ].length;
    bool actionable(TranscriptHistoryWindow window, String id) {
      final card = window.canonicalMessages.singleWhere(
        (message) =>
            message.type == AgentMessageType.permissionRequest &&
            message.raw['requestId'] == id,
      );
      return !card.requestIsReadOnly &&
          !window.resolvedRequestDecisions.containsKey(id);
    }

    test('one sealed beside a released range outlives the residues that give '
        'way, and the budget does not count it', () {
      final native = NativeHistory([
        ...rows('b', 10),
        for (var index = 0; index < 60; index++) ...[
          toolCall('call$index'),
          toolResult('call$index'),
        ],
        row('x'),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 10));
      for (var index = 0; index < 60; index++) {
        window = live(window, [
          native.rows[10 + 2 * index],
          if (index == 30) waiting('wait') else ...approval('req$index'),
          native.rows[11 + 2 * index],
        ]);
      }
      window = window.applyHistory(native.delta(10, 130));
      window = window.applyHistory(native.delta(130, 131));
      window = live(window, rows('live-', 260));
      window = live(window, rows('more-', 140));
      // The answered approvals gave way, with a notice ...
      expect(retainsRequest(window, 'req0'), isFalse);
      expect(unsavedGaps(window), greaterThanOrEqualTo(1));
      // ... but the one still waiting stays, and can still be answered.
      expect(heldCards(window, 'wait'), 1);
      expect(actionable(window, 'wait'), isTrue);
      expect(
        window.messageCount - 1,
        lessThanOrEqualTo(kMaxActiveTranscriptMessages),
      );
      expectExactRanges(window, native);
    });

    test('one at the head of the tail keeps its place while the live rows '
        'after it are released, and through the frame that heals them', () {
      final native = NativeHistory([
        ...rows('a', 100),
        for (var index = 0; index < 4; index++) bigResult('c$index'),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, [
        waiting('p1'),
        for (var index = 0; index < 4; index++) native.rows[100 + index],
      ]);
      var tail = window.pages.last;
      expect(tail.headReleased, isTrue);
      expect(tail.messages.first.raw['requestId'], 'p1');
      expect(tail.shedKeys, isNotEmpty);
      expect(tail.shedKeys, isNot(contains('permission-request:request:p1')));
      expect(reconnectGaps(window), 1);

      window = window.applyHistory(native.delta(100, 104));
      tail = window.pages.last;
      expect(tail.headReleased, isFalse);
      expect(reconnectGaps(window), 0);
      // Nothing that was never saved was released.
      expect(unsavedGaps(window), 0);
      expect(heldCards(window, 'p1'), 1);
      expect(actionable(window, 'p1'), isTrue);
    });

    test('the tail allowance does not count it', () {
      final native = NativeHistory(rows('a', 10));
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 10));
      window = live(window, [waiting('p1'), ...rows('live-', 450)]);
      final tail = window.pages.last;
      expect(tail.messages.first.raw['requestId'], 'p1');
      expect(tail.messages, hasLength(kMaxOpenTranscriptTailMessages + 1));
    });

    test('the window budget does not count it either', () {
      AgentMessage sized(String id, int chars) => AgentMessage.fromJson({
        'type': 'tool-result',
        'callId': id,
        'toolName': 'Read',
        'result': 'r' * chars,
      });
      final native = NativeHistory([
        ...rows('b', 3),
        toolCall('d0'),
        toolResult('d0'),
        for (var index = 0; index < 7; index++) sized('c$index', 200000),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 3));
      // A large card, sealed with its block as a row no reload returns.
      window = live(window, [
        native.rows[3],
        AgentMessage.fromJson({
          'type': 'permission-request',
          'requestId': 'p1',
          'title': 'Write the file?',
          'detail': 'x' * 760000,
        }),
        native.rows[4],
      ]);
      window = window.applyHistory(native.delta(3, 5));
      window = live(window, native.rows.sublist(5, 12));
      expect(heldCards(window, 'p1'), 1);
      expect(window.pages.last.headReleased, isFalse);
      expect(
        window.estimatedBytes,
        greaterThan(kMaxActiveTranscriptDecodedBytes),
      );
    });

    test("the reader's row after it is split off with it, in order", () {
      final native = NativeHistory(rows('a', 10));
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 10));
      window = live(window, [waiting('p1'), row('r')]);
      window = live(window, rows('live-', 450), reading: keyOf('r'));
      final split = window.pages[window.pages.length - 2];
      expect(split.isTail, isFalse);
      expect(split.messages.map((m) => m.raw['requestId'] ?? m.raw['key']), [
        'p1',
        'r',
      ]);
      expect(actionable(window, 'p1'), isTrue);
    });

    test('once answered it is an ordinary row again', () {
      final native = NativeHistory(rows('a', 100));
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, [
        waiting('p1'),
        for (var index = 0; index < 4; index++) bigResult('c$index'),
      ]);
      expect(retainsRequest(window, 'p1'), isTrue);
      window = live(window, [
        AgentMessage.fromJson({
          'type': 'permission-resolved',
          'requestId': 'p1',
          'decision': 'allow',
        }),
        bigResult('c4'),
      ]);
      expect(
        window.pages.last.messages.any(
          (message) =>
              message.type == AgentMessageType.permissionRequest &&
              message.raw['requestId'] == 'p1',
        ),
        isFalse,
      );
    });

    // A reconnect: the new connection's attach frame, after which the broker
    // sends again every card still waiting.
    TranscriptHistoryWindow reconnected(
      TranscriptHistoryWindow window,
      HistoryWireEvent frame, {
      String? reading,
    }) => window.invalidateQuestionAuthority().applyHistory(
      frame,
      preserveMessageKey: reading,
    );

    test('one the reconnect does not send again stops waiting and is '
        'released like an answered one', () {
      final native = NativeHistory(rows('a', 100));
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, [
        waiting('p1'),
        for (var index = 0; index < 4; index++) bigResult('c$index'),
      ]);
      expect(retainsRequest(window, 'p1'), isTrue);
      window = reconnected(window, native.delta(100, 100));
      expect(window.withdrawnRequestIds, {'p1'});
      expect(window.resolvedRequestDecisions, isNot(contains('p1')));
      window = live(window, [bigResult('c4')]);
      expect(retainsRequest(window, 'p1'), isFalse);
    });

    test('one the reconnect sends again keeps waiting', () {
      final native = NativeHistory(rows('a', 100));
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, [
        waiting('p1'),
        for (var index = 0; index < 4; index++) bigResult('c$index'),
      ]);
      window = reconnected(window, native.delta(100, 100));
      window = live(window, [waiting('p1'), bigResult('c4')]);
      expect(window.withdrawnRequestIds, isEmpty);
      expect(retainsRequest(window, 'p1'), isTrue);
      expect(actionable(window, 'p1'), isTrue);
    });

    test('one resolved after the reconnect shows its resolution', () {
      final native = NativeHistory(rows('a', 100));
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, [waiting('p1')]);
      window = reconnected(window, native.delta(100, 100));
      window = live(window, [approval('p1').last]);
      expect(window.withdrawnRequestIds, isEmpty);
      expect(window.resolvedRequestDecisions['p1'], 'allow');
    });

    test('the attach frame withdraws them, not a refresh answered before '
        'it', () {
      final native = NativeHistory(rows('a', 100));
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, [waiting('p1')]).invalidateQuestionAuthority();
      window = window.applyHistory(
        const HistoryWireEvent(
          messages: [],
          cursor: 'reconnect-100',
          clientMessageId: 'refresh-1',
        ),
      );
      expect(window.withdrawnRequestIds, isEmpty);
      window = window.applyHistory(native.delta(100, 100));
      expect(window.withdrawnRequestIds, {'p1'});
    });

    test('a reset attach frame keeps withdrawn the ones it keeps', () {
      final native = NativeHistory(rows('a', 100));
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, [waiting('p1'), row('r')]);
      window = reconnected(
        window,
        NativeHistory([...rows('z', 10)]).attach(0, 10),
        reading: keyOf('r'),
      );
      expect(retainsRequest(window, 'p1'), isTrue);
      expect(window.withdrawnRequestIds, {'p1'});
    });

    test("beside a small reader's page, they release no live row while "
        'pages that reload remain', () {
      final native = NativeHistory(rows('a', 900));
      var window = TranscriptHistoryWindow.fromHistory(
        native.attach(500, 600),
      );
      for (final at in [500, 400, 300, 200]) {
        final mutation = window.prependPage(
          native.pageBefore('b$at', 100),
          requestedCursor: 'b$at',
        );
        expect(mutation.accepted, isTrue);
        window = mutation.window;
      }
      // The reader reads a one-row page at the leading edge.
      final reader = keyOf('a99');
      final one = window.prependPage(
        native.pageBefore('b100', 1),
        requestedCursor: 'b100',
        preserveMessageKey: reader,
      );
      expect(one.accepted, isTrue);
      window = live(one.window, [
        waiting('p0'),
        waiting('p1'),
      ], reading: reader);
      for (var index = 600; index < 900; index++) {
        window = live(window, [native.rows[index]], reading: reader);
        expect(reconnectGaps(window), 0, reason: 'after a$index');
      }
      expect(heldCards(window, 'p0'), 1);
      expect(heldCards(window, 'p1'), 1);
      expect(
        window.messageCount - 1 - 2,
        lessThanOrEqualTo(kMaxActiveTranscriptMessages),
      );
      expectExactRanges(window, native);
    });

    test('between them they hold at most '
        '$kMaxPinnedActionableRequestBytes decoded bytes, newest first', () {
      AgentMessage heavy(String id) => AgentMessage.fromJson({
        'type': 'permission-request',
        'requestId': id,
        'title': 'Write the file?',
        'detail': 'x' * (150 * 1024),
      });
      final native = NativeHistory(rows('a', 100));
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      window = live(window, [
        for (var index = 0; index < 8; index++) heavy('h$index'),
        for (var index = 0; index < 5; index++) bigResult('c$index'),
      ]);
      final size = estimatedAgentMessageDecodedBytes(heavy('h0'));
      final fit = kMaxPinnedActionableRequestBytes ~/ size;
      expect(fit, inInclusiveRange(1, 7));
      for (var index = 0; index < 8 - fit; index++) {
        expect(retainsRequest(window, 'h$index'), isFalse, reason: 'h$index');
      }
      for (var index = 8 - fit; index < 8; index++) {
        expect(retainsRequest(window, 'h$index'), isTrue, reason: 'h$index');
      }
    });

    test('only the newest $kMaxPinnedActionableRequests are kept', () {
      final native = NativeHistory(rows('a', 100));
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 100));
      const extra = 4;
      window = live(window, [
        for (
          var index = 0;
          index < kMaxPinnedActionableRequests + extra;
          index++
        )
          waiting('q$index'),
        for (var index = 0; index < 5; index++) bigResult('c$index'),
      ]);
      for (var index = 0; index < extra; index++) {
        expect(retainsRequest(window, 'q$index'), isFalse, reason: 'q$index');
      }
      for (
        var index = extra;
        index < kMaxPinnedActionableRequests + extra;
        index++
      ) {
        expect(retainsRequest(window, 'q$index'), isTrue, reason: 'q$index');
      }
    });
  });

  group('a live update to a row the window holds', () {
    int heldKey(TranscriptHistoryWindow window, String key) => [
      for (final page in window.pages)
        for (final message in page.messages)
          if (stableTranscriptMessageKey(message) == key) message,
    ].length;

    test('lands on that row however many pages back it was sealed', () {
      final native = NativeHistory([
        ...rows('a', 3),
        toolCall('x'),
        ...rows('b', 60),
        ...rows('c', 60),
        ...rows('d', 10),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 3));
      window = live(window, native.rows.sublist(3, 64));
      window = window.applyHistory(native.delta(3, 64));
      window = live(window, native.rows.sublist(64, 124));
      window = window.applyHistory(native.delta(64, 124));
      window = live(window, native.rows.sublist(124, 134));
      window = window.applyHistory(native.delta(124, 134));
      final holder = window.pages.indexWhere(
        (page) => page.containsStableKey('tool-call:call:x'),
      );
      final tailAt = window.pages.lastIndexWhere((page) => page.isTail);
      expect(tailAt - holder, greaterThanOrEqualTo(2));

      window = window.applyLiveMessage(
        AgentMessage.fromJson({
          'type': 'tool-call',
          'callId': 'x',
          'toolName': 'Bash',
          'args': {'command': 'ls'},
        }),
      );
      expect(heldKey(window, 'tool-call:call:x'), 1);
      final updated = window.pages[holder].messages.singleWhere(
        (message) => stableTranscriptMessageKey(message) == 'tool-call:call:x',
      );
      expect((updated.raw['args'] as Map)['command'], 'ls');
    });

    test('released with its range, it is held live until a reload returns '
        'the saved copy', () {
      final native = NativeHistory([
        ...rows('a', 3),
        toolCall('x'),
        ...rows('b', 60),
      ]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 3));
      window = live(window, native.rows.sublist(3, 64));
      window = window.applyHistory(native.delta(3, 64));
      // Live growth releases the block that holds it.
      window = live(window, rows('live-', 399));
      expect(heldKey(window, 'tool-call:call:x'), 0);
      window = window.applyLiveMessage(
        AgentMessage.fromJson({
          'type': 'tool-call',
          'callId': 'x',
          'toolName': 'Bash',
          'args': {'command': 'ls'},
        }),
      );
      expect(heldKey(window, 'tool-call:call:x'), 1);
      final limit = window.reloadLimitFor('b64');
      expect(limit, isNotNull);
      final reload = window.prependPage(
        native.pageBefore('b64', limit!),
        requestedCursor: 'b64',
      );
      expect(reload.accepted, isTrue);
      window = reload.window;
      expect(heldKey(window, 'tool-call:call:x'), 1);
      expect(window.pages.last.containsStableKey('tool-call:call:x'), isFalse);
    });
  });

  group('released live rows', () {
    test('a released row with no key keeps the release visible through a '
        'frame from the block end', () {
      final native = NativeHistory([...rows('b', 3), ...rows('live-', 401)]);
      var window = TranscriptHistoryWindow.fromHistory(native.attach(0, 3));
      window = window.applyLiveMessage(
        AgentMessage.fromJson(const {'type': 'model-output', 'text': 'aside'}),
      );
      window = live(window, native.rows.sublist(3, 404));
      expect(window.pages.last.headReleased, isTrue);
      expect(reconnectGaps(window), 1);
      // Nothing can show the keyless row was restated.
      window = window.applyHistory(native.delta(3, 404));
      expect(reconnectGaps(window), 1);
    });
  });

  group("the reader's page stays bounded", () {
    test('a sealed page joins the next block only within one frame of '
        'bytes', () {
      final reading = keyOf('r0');
      var window = TranscriptHistoryWindow.fromHistory(
        frame([row('r0', chars: 450000)]),
      );
      for (var index = 1; index <= 8; index++) {
        window = window.applyHistory(
          delta(
            [row('r$index', chars: 450000)],
            cursor: 'reconnect-$index',
            endCursor: 'end-$index',
          ),
          preserveMessageKey: reading,
        );
        for (final page in window.pages.where((page) => !page.isTail)) {
          expect(
            page.estimatedBytes,
            lessThanOrEqualTo(kMaxJoinedTranscriptPageDecodedBytes),
            reason: 'frame $index',
          );
        }
        expectWithinBudgetBeyondReader(window, reading);
      }
      expect(retains(window, 'r0'), isTrue);
      expect(retains(window, 'r8'), isTrue);
      expect(reconnectGaps(window), 0);
    });

    test("a state-only block kept as the reader's page stays joined to the "
        'tail', () {
      final goal = AgentMessage.fromJson(const {
        'type': 'goal-state',
        'key': 'goal',
        'status': 'paused',
        'title': 'Goal',
      });
      var window = TranscriptHistoryWindow.fromHistory(frame([goal]));
      window = live(window, rows('live-', 400), reading: 'goal-state:key:goal');
      expect(window.pages, hasLength(2));
      final [kept, tail] = window.pages;
      expect(kept.containsStableKey('goal-state:key:goal'), isTrue);
      expect(kept.newerCursor, 'end-0');
      expect(tail.olderCursor, 'end-0');
      expect(gapsOf(window), isEmpty);
    });
  });

  group('ranges no page can return', () {
    test('releasing an empty terminal page keeps the start of history and '
        'remembers nothing', () {
      var window = TranscriptHistoryWindow.fromHistory(frame(rows('t', 100)));
      for (final (cursor, next) in [
        ('older-0', page(rows('p', 100), cursor: 'older-1')),
        ('older-1', page(const [])),
      ]) {
        final mutation = window.prependPage(next, requestedCursor: cursor);
        expect(mutation.accepted, isTrue);
        window = mutation.window;
      }
      expect(window.olderHistoryCursor, isNull);

      window = live(window, rows('live-', 400), reading: keyOf('p0'));
      expect(retains(window, 'p0'), isTrue);
      expect(window.pages.first.containsStableKey(keyOf('p0')), isTrue);
      expect(window.olderHistoryCursor, isNull);
      expect(window.leadingEdgeReleased, isFalse);
      expect(window.reloadLimitFor('older-1'), isNull);
    });

    test('an exact reload of the released start page restores the start, '
        'though the walk reports more history', () {
      var window = TranscriptHistoryWindow.fromHistory(frame(rows('t', 100)));
      for (final (cursor, next) in [
        ('older-0', page(rows('p', 100), cursor: 'older-1')),
        ('older-1', page(const [])),
      ]) {
        window = window.prependPage(next, requestedCursor: cursor).window;
      }
      window = live(window, rows('live-', 301));
      expect(window.reloadLimitFor('older-0'), 100);
      window = window
          .prependPage(
            page(rows('t', 100), cursor: 'older-0'),
            requestedCursor: 'end-0',
          )
          .window;
      // A page that is not the released range's exact reload proves nothing.
      final partial = window.prependPage(
        page(rows('p', 99, start: 1), cursor: 'walk-stopped-after-p1'),
        requestedCursor: 'older-0',
      );
      expect(partial.accepted, isTrue);
      expect(partial.adoptedSessionStart, isFalse);
      expect(partial.window.olderHistoryCursor, 'walk-stopped-after-p1');

      // The session opens with state rows, so the walk stops after `p0` and
      // reports more history behind it.
      final reload = window.prependPage(
        page(rows('p', 100), cursor: 'walk-stopped-after-p0'),
        requestedCursor: 'older-0',
      );
      expect(reload.accepted, isTrue);
      expect(reload.adoptedSessionStart, isTrue);
      expect(reload.window.olderHistoryCursor, isNull);
    });

    test('a state-only page is released like an empty one', () {
      var window = TranscriptHistoryWindow.fromHistory(frame(rows('t', 100)));
      for (final (cursor, next) in [
        ('older-0', page(rows('p', 100), cursor: 'older-1')),
        ('older-1', page([stateRow('plan')])),
      ]) {
        final mutation = window.prependPage(next, requestedCursor: cursor);
        expect(mutation.accepted, isTrue);
        window = mutation.window;
      }
      window = live(window, rows('live-', 400), reading: keyOf('p0'));
      expect(window.olderHistoryCursor, isNull);
      expect(window.reloadLimitFor('older-1'), isNull);
    });

    test('a state-only block is released without a reload descriptor', () {
      var window = TranscriptHistoryWindow.fromHistory(
        frame([stateRow('plan')]),
      );
      window = live(window, rows('live-', 400));
      expect(retains(window, 'live-0'), isTrue);
      expect(reconnectGaps(window), 0);
      // Paging from the block's own older boundary returns what paging from
      // its end would: a backward walk skips state rows.
      expect(window.olderHistoryCursor, 'older-0');
      expect(window.reloadLimitFor('end-0'), isNull);
      expect(window.releasedRanges, isEmpty);
    });
  });

  group('frames without endCursor', () {
    test('live growth sheds the oldest live rows and needs a reconnect, as '
        'before endCursor existed', () {
      var window = TranscriptHistoryWindow.fromHistory(
        frame(rows('t', 100), endCursor: null),
      );
      window = live(window, rows('live-', 350));
      expectWithinBudget(window);
      expect(window.releasedRanges, isEmpty);
      expect(window.leadingEdgeReleased, isTrue);
      expect(gapsOf(window).map((gap) => gap.kind), [
        TranscriptHistoryGapKind.reconnectRequired,
      ]);
      expect(window.persistableTail().olderCursor, isNull);

      // An incremental frame without endCursor cannot heal it; a reset can.
      window = window.applyHistory(
        delta(rows('live-', 10, start: 340), cursor: 'reconnect-1'),
      );
      expect(window.leadingEdgeReleased, isTrue);
      window = window.applyHistory(
        frame(rows('live-', 100, start: 250), endCursor: null),
      );
      expect(window.leadingEdgeReleased, isFalse);
      expect(window.releasedRanges, isEmpty);
    });
  });

  group('paging', () {
    test('a page for a boundary the window no longer holds is refused '
        'silently', () {
      final window = TranscriptHistoryWindow.fromHistory(frame(rows('t', 100)));
      final mutation = window.prependPage(
        page(rows('o', 100), cursor: 'older-1'),
        requestedCursor: 'a-boundary-a-reset-replaced',
      );

      expect(mutation.accepted, isFalse);
      expect(mutation.rejection, TranscriptHistoryPageRejection.stale);
      expect(identical(mutation.window, window), isTrue);
    });

    test(
      'a page that cannot fit beside the kept rows asks for a smaller one',
      () {
        var window = TranscriptHistoryWindow.fromHistory(frame(rows('t', 100)));
        window = live(window, rows('live-', 300, chars: 4000));
        final mutation = window.prependPage(
          page(rows('o', 100, chars: 9000), cursor: 'older-1'),
          requestedCursor: 'older-0',
        );

        expect(mutation.rejection, TranscriptHistoryPageRejection.overBudget);
        expect(identical(mutation.window, window), isTrue);
      },
    );

    test('releasing the session start retracts the start of history', () {
      var window = TranscriptHistoryWindow.fromHistory(
        frame(rows('t', 100), olderCursor: null),
      );
      expect(window.olderHistoryCursor, isNull);

      window = live(window, rows('live-', 350));
      expect(window.olderHistoryCursor, 'end-0');
      expect(window.reloadLimitFor('end-0'), 100);
    });
  });
}
