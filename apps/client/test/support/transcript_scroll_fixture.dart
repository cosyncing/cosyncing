// A long, representative transcript and a broker that pages it in both
// directions, for scroll tests and the scroll performance harness.
//
// Rows are built in units of ten, so a tool call and its result (and an
// approval and its answer) never straddle a page boundary. The mix is meant to
// look like real agent sessions: short prompts, prose with inline code and
// links, markdown with headings, lists and tables, fenced code in several
// languages, edits with diffs, shell commands and their output, approvals,
// images, thinking, every fiftieth row an oversized reply (a long answer, a
// long code listing or a pasted log), and every hundredth a large command log.
import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';

import 'session_detail_page_test_harness.dart';

/// Rows per history page, as the client asks for them.
const int kFixturePageRows = 100;

const String _pixel =
    'data:image/png;base64,'
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42'
    'mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

String _paragraph(int index, int p) =>
    'Paragraph $p of row $index explains what the agent changed and why, '
    'with `inline code`, a [reference](https://example.com/docs/$index) and '
    'enough words to wrap across several lines at any width.';

/// [paragraphs] paragraphs of prose for row [index].
String fixtureProse(int index, int paragraphs) => [
  for (var p = 0; p < paragraphs; p++) _paragraph(index, p),
].join('\n\n');

String _code(int index, int lines) {
  final language = const ['dart', 'typescript', 'python'][index % 3];
  final body = StringBuffer();
  for (var line = 0; line < lines; line++) {
    switch (language) {
      case 'dart':
        body.writeln(
          '  final value$line = await fetch$index("item-$line", '
          'limit: ${line * 3}); // step $line',
        );
      case 'typescript':
        body.writeln(
          "  const value$line: number = compute$index('k$line', "
          '${line * 7}); /* step $line */',
        );
      default:
        body.writeln(
          '    value_$line = compute_$index("k$line", ${line * 5})  '
          '# step $line',
        );
    }
  }
  final python = language == 'python';
  final opening = python ? 'def run_$index():' : 'function run$index() {';
  return '```$language\n$opening\n$body${python ? '' : '}\n'}```';
}

String _table(int index, int rows) {
  final buffer = StringBuffer('| file | change | note |\n|---|---:|:---|\n');
  for (var row = 0; row < rows; row++) {
    buffer.writeln(
      '| lib/src/part_${index}_$row.dart | +${row * 3} -$row | '
      'kept the **public** surface |',
    );
  }
  return buffer.toString();
}

String _shellOutput(int index, int lines) => [
  for (var line = 0; line < lines; line++)
    // One log line.
    // ignore: no_adjacent_strings_in_list
    '00:0${line % 10}.${line % 60} test/unit/case_${index}_$line.dart: '
        '+${line * 2}: All tests passed for group $line',
].join('\n');

/// Whether durable row [index] carries an oversized body.
bool fixtureRowIsOversized(int index) => index % 50 == 49;

/// The raw wire form of durable row [index].
Map<String, Object?> fixtureRowJson(int index) {
  final oversized = fixtureRowIsOversized(index);
  return switch (index % 10) {
    0 => {
      'type': 'user-message',
      'key': 'u$index',
      'text': 'Row $index. Please look at part ${index ~/ 10} and fix it.',
    },
    1 => {
      'type': 'model-output',
      'key': 'm$index',
      'text': 'Row $index. ${fixtureProse(index, 1 + index % 4)}',
      'final': true,
    },
    2 => {
      'type': 'model-output',
      'key': 'm$index',
      'text':
          '## Row $index. Summary\n\n- first point\n- second point with '
          '`code`\n- third point\n\n${_table(index, 3 + index % 4)}',
      'final': true,
    },
    3 => {
      'type': 'model-output',
      'key': 'm$index',
      'text': 'Row $index. The fix:\n\n${_code(index, 8 + index % 24)}',
      'final': true,
    },
    4 =>
      (index ~/ 10).isEven
          ? {
              'type': 'tool-call',
              'callId': 'c$index',
              'name': 'edit',
              'toolClass': 'edit',
              'arguments': {'path': 'lib/r$index.dart'},
            }
          : {
              'type': 'tool-call',
              'callId': 'c$index',
              'name': 'bash',
              'toolClass': 'execute',
              'args': {'command': 'flutter test test/part_${index ~/ 10}'},
            },
    5 =>
      ((index - 1) ~/ 10).isEven
          ? {
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
            }
          : {
              'type': 'tool-result',
              'callId': 'c${index - 1}',
              'name': 'bash',
              'toolClass': 'execute',
              // Every hundredth row's run printed a large log: a heavy body in
              // a card that stays collapsed.
              'result': _shellOutput(index, index % 100 == 15 ? 900 : 24),
              'durationMs': 1200 + index,
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
    8 =>
      index % 20 == 8
          ? {
              'type': 'file-artifact',
              'artifactKey': 'image-$index',
              'name': 'screen-$index.png',
              'mimeType': 'image/png',
              'url': _pixel,
            }
          : {
              'type': 'thinking',
              'key': 't$index',
              'text': 'Row $index. ${fixtureProse(index, 1)}',
            },
    _ => {
      'type': 'model-output',
      'key': 'm$index',
      'text': switch (oversized ? (index ~/ 50) % 3 : -1) {
        0 => 'Row $index. ${fixtureProse(index, 40)}',
        1 => 'Row $index. A long listing:\n\n${_code(index, 160)}',
        2 =>
          'Row $index. The whole run:\n\n```text\n'
              '${_shellOutput(index, 120)}\n```',
        _ => 'Row $index. Done.',
      },
      'final': true,
    },
  };
}

/// Durable row [index] of the fixture session.
AgentMessage fixtureRow(int index) =>
    AgentMessage.fromJson(fixtureRowJson(index));

/// Durable rows [from] (inclusive) to [to] (exclusive).
List<AgentMessage> fixtureRows(int from, int to) => [
  for (var index = from; index < to; index++) fixtureRow(index),
];

/// Encoded size of [messages], as the broker would send them.
int fixtureWireBytes(List<AgentMessage> messages) {
  var bytes = 0;
  for (final message in messages) {
    bytes += utf8.encode(jsonEncode(message.raw)).length;
  }
  return bytes;
}

/// One page request the broker received.
final class FixturePageRequest {
  FixturePageRequest({
    required this.cursor,
    required this.newer,
    required this.limit,
    required this.requestedAt,
    this.until,
  });

  final String cursor;
  final String? until;
  final bool newer;
  final int limit;
  final Duration requestedAt;

  /// When the page was handed to the client, or null while it is pending.
  Duration? answeredAt;

  /// Encoded bytes of the page's rows.
  int bytes = 0;

  /// Rows the page carried.
  int rows = 0;

  /// Whether the broker refused it (a transient failure).
  bool failed = false;
}

/// A broker holding [total] durable rows, whose boundary `bN` sits before row
/// N. It opens on the newest page and answers every page request, older or
/// newer, after [latency] — or when [release] is called, while [holding].
///
/// [failNext] refuses that many of the next requests with [failureCode], a
/// transient refusal, before answering again. [stallNext] answers that many
/// with a page that brings nothing and ends where it was asked from.
class FixturePagingBroker extends ScriptedSessionDetailConnection
    implements SessionHistoryConnection, SessionHistoryNavigationConnection {
  FixturePagingBroker({
    required this.total,
    Duration Function()? clock,
    AgentMessage Function(int index)? row,
  }) : _clock = clock ?? _stopwatchClock(),
       _row = row ?? fixtureRow,
       super(
         events: [
           HistoryWireEvent(
             messages: [
               for (var i = total - kFixturePageRows; i < total; i++)
                 (row ?? fixtureRow)(i),
             ],
             reset: true,
             cursor: 'r$total',
             olderCursor: 'b${total - kFixturePageRows}',
             hasEarlier: true,
             endCursor: 'b$total',
             newerHistory: true,
           ),
         ],
       );

  static Duration Function() _stopwatchClock() {
    final stopwatch = Stopwatch()..start();
    return () => stopwatch.elapsed;
  }

  final Duration Function() _clock;
  final AgentMessage Function(int index) _row;
  final int total;

  /// Rows saved after the session opened (see [appendDurable]).
  final List<AgentMessage> _appended = [];

  /// Whether boundary refreshes are answered, as a current broker does.
  bool answerRefreshes = true;

  /// Refreshes answered.
  int refreshes = 0;
  Duration latency = Duration.zero;

  /// The most rows one page carries, when smaller than the page asked for.
  int? pageRows;
  bool holding = false;
  int failNext = 0;
  String failureCode = 'HISTORY_PAGE_SOURCE_CHANGED';
  int stallNext = 0;

  /// Every page request, in order.
  final List<FixturePageRequest> requests = [];
  final List<String> older = [];
  final List<({String cursor, String until})> newer = [];
  final List<(HistoryPageWireEvent, FixturePageRequest)> _held = [];

  /// Called when a page is handed to the client.
  void Function(FixturePageRequest request)? onAnswered;

  /// Pages answered after [latency] that have not arrived yet.
  int inFlight = 0;

  bool get hasHeld => _held.isNotEmpty;

  /// Durable rows the session holds now.
  int get durableCount => total + _appended.length;

  /// Saves [message] after the durable rows, as a broker persists a row.
  void appendDurable(AgentMessage message) => _appended.add(message);

  List<AgentMessage> _durableRows(int from, int to) => [
    for (var index = from; index < to; index++)
      index < total ? _row(index) : _appended[index - total],
  ];

  /// Delivers every held page.
  void release() {
    final pages = List.of(_held);
    _held.clear();
    for (final (page, request) in pages) {
      _deliver(page, request);
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
    final request = FixturePageRequest(
      cursor: cursor,
      newer: false,
      limit: limit ?? kFixturePageRows,
      requestedAt: _clock(),
    );
    requests.add(request);
    if (_refuse(request, clientMessageId)) return;
    if (_stall(request, clientMessageId, newer: false)) return;
    final end = int.parse(cursor.substring(1));
    final start = math.max(0, end - _pageLimit(limit));
    final messages = _durableRows(start, end);
    request
      ..rows = messages.length
      ..bytes = fixtureWireBytes(messages);
    _answer(
      HistoryPageWireEvent(
        messages: messages,
        cursor: start > 0 ? 'b$start' : null,
        hasMore: start > 0,
        endOfHistory: start == 0,
        clientMessageId: clientMessageId,
      ),
      request,
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
    final request = FixturePageRequest(
      cursor: cursor,
      until: until,
      newer: true,
      limit: limit ?? kFixturePageRows,
      requestedAt: _clock(),
    );
    requests.add(request);
    if (_refuse(request, clientMessageId)) return;
    if (_stall(request, clientMessageId, newer: true)) return;
    final start = int.parse(cursor.substring(1));
    final stop = int.parse(until.substring(1));
    final end = math.min(stop, start + _pageLimit(limit));
    final messages = _durableRows(start, end);
    request
      ..rows = messages.length
      ..bytes = fixtureWireBytes(messages);
    _answer(
      HistoryPageWireEvent(
        messages: messages,
        cursor: end == stop ? until : 'b$end',
        hasMore: end < stop,
        endOfHistory: false,
        isNewer: true,
        clientMessageId: clientMessageId,
      ),
      request,
    );
  }

  int _pageLimit(int? limit) {
    final asked = limit ?? kFixturePageRows;
    final most = pageRows;
    return most != null && most < asked ? most : asked;
  }

  bool _refuse(FixturePageRequest request, String? clientMessageId) {
    if (failNext <= 0) return false;
    failNext -= 1;
    request.failed = true;
    final code = failureCode;
    void nack() {
      request.answeredAt = _clock();
      emitEvent(
        NackWireEvent(
          code: code,
          message: 'The source was still changing.',
          clientMessageId: clientMessageId,
        ),
      );
    }

    if (latency == Duration.zero) {
      nack();
    } else {
      Timer(latency, nack);
    }
    return true;
  }

  bool _stall(
    FixturePageRequest request,
    String? clientMessageId, {
    required bool newer,
  }) {
    if (stallNext <= 0) return false;
    stallNext -= 1;
    _answer(
      HistoryPageWireEvent(
        messages: const [],
        cursor: request.cursor,
        hasMore: true,
        endOfHistory: false,
        isNewer: newer,
        clientMessageId: clientMessageId,
      ),
      request,
    );
    return true;
  }

  void _answer(HistoryPageWireEvent page, FixturePageRequest request) {
    if (holding) {
      _held.add((page, request));
    } else if (latency == Duration.zero) {
      _deliver(page, request);
    } else {
      inFlight += 1;
      Timer(latency, () {
        inFlight -= 1;
        _deliver(page, request);
      });
    }
  }

  void _deliver(HistoryPageWireEvent page, FixturePageRequest request) {
    request.answeredAt = _clock();
    emitEvent(page);
    onAnswered?.call(request);
  }

  @override
  Future<bool> requestHistoryRefresh({
    required String cursor,
    required String clientMessageId,
    int? limit,
  }) async {
    if (!answerRefreshes || !cursor.startsWith('r')) return false;
    final from = int.parse(cursor.substring(1));
    final to = math.min(durableCount, from + (limit ?? kFixturePageRows));
    final frame = HistoryWireEvent(
      messages: _durableRows(from, to),
      cursor: 'r$to',
      endCursor: 'b$to',
      newerHistory: true,
      hasEarlier: true,
      clientMessageId: clientMessageId,
    );
    refreshes += 1;
    if (latency == Duration.zero) {
      scheduleMicrotask(() => emitEvent(frame));
    } else {
      Timer(latency, () => emitEvent(frame));
    }
    return true;
  }

  @override
  Future<void> restartAttach() async {}
}

/// Segment [segment] of a streamed reply: a paragraph, and every fourth one a
/// short code block.
String _replySegment(int reply, int segment) =>
    segment % 4 == 3 ? _code(reply + segment, 6) : _paragraph(reply, segment);

/// A reply streamed at the tail: [chunks] growing copies of one model-output
/// row keyed [key], each one segment longer than the last, the last final.
List<MessageWireEvent> fixtureStreamedReply({
  required String key,
  required int firstSeq,
  required int chunks,
}) {
  final segments = <String>[];
  return [
    for (var chunk = 1; chunk <= chunks; chunk++)
      MessageWireEvent(
        seq: firstSeq + chunk,
        message: AgentMessage.fromJson({
          'type': 'model-output',
          'key': key,
          'text': [
            'Streaming reply $key.',
            ...segments..add(_replySegment(firstSeq, chunk - 1)),
          ].join('\n\n'),
          'final': chunk == chunks,
        }),
      ),
  ];
}
