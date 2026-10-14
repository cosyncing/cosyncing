// A broker that serves one long durable history and pages it over the wire
// (F03b): the real session controller asks for older and newer pages with
// `history-page` frames, for boundaries with `history-refresh`, and reconnects
// with the cursor it last held; this answers the way a contract-28 broker does.
//
// Boundary `bN` sits before durable row N and the reconnect cursor `rN`
// follows N durable rows. One class replaces the private paging fakes the
// scroll, motion, prefetch, progress, gap and navigation tests each carried.
//
// Every delay is a fake-time timer, so a test crosses it with
// `app.elapse(...)`; nothing reads the wall clock.
import 'dart:async';
import 'dart:math' as math;

import 'package:flutter_test/flutter_test.dart' show fail;

import 'fake_broker.dart';

/// Rows per page when the client does not say.
const int kPagingPageRows = 100;

/// One `history-page` request the broker received.
class PagingRequest {
  PagingRequest({
    required this.cursor,
    required this.newer,
    required this.limit,
    required this.requestedAt,
    this.until,
  });

  /// The boundary asked from.
  final String cursor;

  /// The boundary a newer walk stops at.
  final String? until;

  /// Whether the page was asked for in the newer direction.
  final bool newer;

  /// Rows the client asked for.
  final int limit;

  /// Fake time the request arrived at.
  final DateTime requestedAt;

  /// Fake time the page was handed to the client, null while pending.
  DateTime? answeredAt;

  /// Rows the answer carried.
  int rows = 0;

  /// Whether the broker refused it.
  bool failed = false;
}

/// One durable row of the session as a wire message.
typedef PagingRow = Map<String, Object?> Function(int index);

/// A one-line prompt row.
Map<String, Object?> shortPagingRow(int index) => {
  'type': 'user-message',
  'key': 'short-$index',
  'text': 'Short row $index.',
};

/// A broker holding [total] durable rows of session [id] on [broker].
///
/// Opens on the newest page and answers every page request after [latency],
/// or when [release] is called while [holding]. [failNext] refuses that many
/// requests with [failureCode]; [stallNext] answers that many with a page that
/// brings nothing and ends where it was asked from.
class FixturePagingBroker {
  /// Serves [total] rows of session [id] from [broker].
  FixturePagingBroker(
    this.broker, {
    required this.total,
    required this.row,
    required this.now,
    this.id = 's1',
    this.newerHistory = true,
    this.latency = Duration.zero,
  }) {
    broker
      ..attachFrames = _attach
      ..onFrame = _onFrame;
  }

  /// The broker the page frames travel through.
  final FakeBroker broker;

  /// The session served.
  final String id;

  /// Durable rows when the session opened.
  final int total;

  /// Durable row `index` as a wire message.
  final PagingRow row;

  /// Whether frames offer newer history and end cursors (contract 28).
  bool newerHistory;

  /// Time a page takes to arrive (fake time).
  Duration latency;

  /// The hello this broker opens every stream with (a version, a compatibility
  /// verdict); null sends the standard one.
  Map<String, Object?> Function()? hello;

  /// The fake clock.
  final DateTime Function() now;

  /// Hold every page until [release].
  bool holding = false;

  /// Refuse this many next requests.
  int failNext = 0;

  /// The code of a refusal.
  String failureCode = 'HISTORY_PAGE_SOURCE_CHANGED';

  /// Answer this many next requests with an empty page that goes nowhere.
  int stallNext = 0;

  /// The most rows one page carries, when smaller than asked for.
  int? pageRows;

  /// Whether boundary refreshes are answered.
  bool answerRefreshes = true;

  /// Rows past which a reconnect gets a capped reset instead of the suffix.
  int reconnectCap = 400;

  /// Every page request, oldest first.
  final List<PagingRequest> requests = [];

  /// Refresh requests received (cursor and correlation id).
  final List<({String cursor, String id})> refreshes = [];

  /// Attach parameters of every attach, oldest first.
  final List<Map<String, String>> attaches = [];

  /// Frames sent to the app by the broker's own initiative are numbered here.
  final Map<FakeBrokerSocket, int> _seq = {};

  final List<Map<String, Object?>> _appended = [];
  final List<(FakeBrokerSocket, Map<String, Object?>, PagingRequest?)> _held =
      [];

  /// Older-direction requests.
  List<PagingRequest> get older => [
    for (final request in requests)
      if (!request.newer) request,
  ];

  /// Newer-direction requests.
  List<PagingRequest> get newer => [
    for (final request in requests)
      if (request.newer) request,
  ];

  /// Whether pages are waiting for [release].
  bool get hasHeld => _held.isNotEmpty;

  /// Durable rows now.
  int get durableCount => total + _appended.length;

  /// The newest open socket of the session.
  FakeBrokerSocket get socket => broker.socketsFor(id).last;

  Map<String, Object?> _durable(int index) =>
      index < total ? row(index) : _appended[index - total];

  List<Map<String, Object?>> _rows(int from, int to) => [
    for (var index = from; index < to; index++) _durable(index),
  ];

  /// Saves [message] after the durable rows (the agent persisted it) and, with
  /// [live], streams it to the open socket as a live row.
  void append(Map<String, Object?> message, {bool live = true}) {
    _appended.add(message);
    if (live) this.live(message);
  }

  /// Streams [message] to the open socket without saving it (a card, a
  /// streamed chunk).
  void live(Map<String, Object?> message) {
    final target = socket;
    target.emit({
      'kind': 'message',
      'seq': _seq[target] = (_seq[target] ?? 0) + 1,
      'message': message,
    });
  }

  /// Delivers every held page.
  void release() {
    final pages = List.of(_held);
    _held.clear();
    for (final (target, frame, request) in pages) {
      _deliver(target, frame, request);
    }
  }

  /// A fresh attach frame: the newest page as a reset.
  Map<String, Object?> tailFrame({int? clientMessageId}) {
    final count = durableCount;
    final from = math.max(0, count - kPagingPageRows);
    return {
      'kind': 'history',
      'messages': _rows(from, count),
      'reset': true,
      'cursor': 'r$count',
      if (from > 0) 'olderCursor': 'b$from',
      'hasEarlier': from > 0,
      if (newerHistory) 'endCursor': 'b$count',
      if (newerHistory) 'newerHistory': true,
    };
  }

  /// The incremental frame a reconnect or refresh from `r[since]` receives.
  Map<String, Object?> suffixFrame(int since, int through, {String? echo}) => {
    'kind': 'history',
    'messages': _rows(since, through),
    'cursor': 'r$through',
    if (newerHistory) 'endCursor': 'b$through',
    if (newerHistory) 'newerHistory': true,
    'clientMessageId': ?echo,
  };

  /// Sends a fresh attach frame to the open socket, as a hub resync does.
  void resync() => socket.emit(tailFrame());

  List<Map<String, Object?>> _attach(
    FakeBrokerSocket target,
    Map<String, Object?> session,
  ) {
    if (session['id'] != id) return const [];
    attaches.add(Map.of(target.attachParams));
    final cursor = target.attachParams['ticket'];
    final since = cursor != null && cursor.startsWith('r')
        ? int.tryParse(cursor.substring(1))
        : null;
    final history =
        since != null &&
            since <= durableCount &&
            durableCount - since <= reconnectCap
        ? suffixFrame(since, durableCount)
        : tailFrame();
    return [
      (hello ?? broker.helloFrame)(),
      {
        'kind': 'session',
        'info': {...session, 'control': FakeBroker.drivingControl},
      },
      history,
    ];
  }

  void _onFrame(FakeBrokerSocket target, Map<String, dynamic> frame) {
    switch (frame['kind']) {
      case 'history-page':
        _page(target, frame);
      case 'history-refresh':
        _refresh(target, frame);
    }
  }

  int _limit(Object? asked) {
    final wanted = asked is int ? asked : kPagingPageRows;
    final most = pageRows;
    return most != null && most < wanted ? most : wanted;
  }

  void _page(FakeBrokerSocket target, Map<String, dynamic> frame) {
    final cursor = frame['cursor'] as String;
    final newerPage = frame['direction'] == 'newer';
    final echo = frame['clientMessageId'];
    final request = PagingRequest(
      cursor: cursor,
      until: frame['until'] as String?,
      newer: newerPage,
      limit: frame['limit'] as int? ?? kPagingPageRows,
      requestedAt: now(),
    );
    requests.add(request);
    if (failNext > 0) {
      failNext -= 1;
      request.failed = true;
      _after(
        target,
        {
          'kind': 'nack',
          'code': failureCode,
          'message': 'The source was still changing.',
          'clientMessageId': echo,
        },
        request,
        hold: false,
      );
      return;
    }
    if (stallNext > 0) {
      stallNext -= 1;
      _after(target, {
        'kind': 'history-page',
        'messages': const <Object?>[],
        'cursor': cursor,
        'hasMore': true,
        'endOfHistory': false,
        if (newerPage) 'direction': 'newer',
        'clientMessageId': echo,
      }, request);
      return;
    }
    final Map<String, Object?> page;
    if (newerPage) {
      final start = int.parse(cursor.substring(1));
      final stop = int.parse((request.until ?? 'b$durableCount').substring(1));
      final end = math.min(stop, start + _limit(frame['limit']));
      request.rows = end - start;
      page = {
        'kind': 'history-page',
        'messages': _rows(start, end),
        'cursor': end == stop ? request.until : 'b$end',
        'hasMore': end < stop,
        'endOfHistory': false,
        'direction': 'newer',
        'clientMessageId': echo,
      };
    } else {
      final end = int.parse(cursor.substring(1));
      final start = math.max(0, end - _limit(frame['limit']));
      request.rows = end - start;
      page = {
        'kind': 'history-page',
        'messages': _rows(start, end),
        if (start > 0) 'cursor': 'b$start',
        'hasMore': start > 0,
        'endOfHistory': start == 0,
        'clientMessageId': echo,
      };
    }
    _after(target, page, request);
  }

  void _refresh(FakeBrokerSocket target, Map<String, dynamic> frame) {
    final cursor = frame['cursor'] as String;
    final echo = frame['clientMessageId'] as String;
    refreshes.add((cursor: cursor, id: echo));
    if (!answerRefreshes || !cursor.startsWith('r')) {
      _after(target, {
        'kind': 'nack',
        'code': 'HISTORY_REFRESH_UNAVAILABLE',
        'message': 'This session cannot refresh history.',
        'clientMessageId': echo,
      }, null);
      return;
    }
    final from = int.parse(cursor.substring(1));
    final to = math.min(
      durableCount,
      from + (frame['limit'] as int? ?? kPagingPageRows),
    );
    _after(target, suffixFrame(from, to, echo: echo), null, hold: false);
  }

  void _after(
    FakeBrokerSocket target,
    Map<String, Object?> frame,
    PagingRequest? request, {
    bool hold = true,
  }) {
    if (hold && holding) {
      _held.add((target, frame, request));
    } else if (latency == Duration.zero) {
      _deliver(target, frame, request);
    } else {
      Timer(latency, () => _deliver(target, frame, request));
    }
  }

  void _deliver(
    FakeBrokerSocket target,
    Map<String, Object?> frame,
    PagingRequest? request,
  ) {
    request?.answeredAt = now();
    target.emit(frame);
  }

  /// Fails the test unless exactly [count] page requests were received.
  void expectRequests(int count, {String? reason}) {
    if (requests.length != count) {
      fail(
        '${reason ?? 'page requests'}: expected $count, got '
        '${requests.length}: ${requests.map(_describe).toList()}',
      );
    }
  }
}

String _describe(PagingRequest r) =>
    '${r.newer ? 'newer' : 'older'} ${r.cursor}';
