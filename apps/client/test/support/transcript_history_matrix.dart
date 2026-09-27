// An ordinary-use matrix for the bounded transcript history window.
//
// A simulated broker session keeps a durable history with the broker's cursor
// rules (backward boundary `bN` before durable row N, reconnect cursor `rN`
// after N durable rows, each naming the rows before it, so a rewrite or a
// rewind changes every cursor past it) and streams a running agent's rows
// live: tool calls and results persist as they are sent, a streamed reply
// persists only once it is complete, an approval or a question card arrives
// between a call and its result, waits for its answer and is never persisted,
// a plan is restated under one key, an error card and a token reading carry
// no key, and the token reading still trailing the history is re-projected on
// every read. Turns open with a prompt, saved as sent, saved late (as Claude
// writes it), or queued during the turn before and saved where the agent takes
// it. Other agents' shapes stream too: OpenCode's parts rewritten in place as
// they grow, its running call kept beside its result and a run summary per
// step rewritten `done` when the turn ends; Codex reasoning keyed as history
// keys it; Reasonix calls history never holds. Frames and pages are built
// from their wire JSON.
//
// A revision-28 broker ends every frame sent while a turn runs at the
// running-turn hold and replays the held rows after it, then what the live
// snapshot restates: queued prompts, cards waiting for an answer, the trailing
// state, the running reading, a status tick and the context reading, then the
// session's status. It refuses a cursor it no longer has, refuses a refresh
// whose read fails, and resyncs a socket with an attach-shaped frame.
//
// The client is the real session controller over a fake socket: live rows,
// frames, pages, refreshes, reconnects, restarts and the reader's position all
// go through it, so it decides when to refresh, backs off, catches up across a
// capped reconnect, reattaches for a refused cursor and retries a page,
// exactly as it does in the app. The same driver runs against a revision-28
// broker and a revision-27 broker (none of the above, like every broker
// before 28).
//
// The reader is modelled as a person scrolling: reading back moves to the top
// of the run being read and loads what is above it, reading forward moves to
// the bottom and loads what is below; a range that says it cannot load is
// scrolled past. Every mutation is measured: gaps that need a reconnect,
// notices that unsaved rows were released, rows held twice (keyed or not),
// rows out of persisted order, rows never saved out of the place they arrived
// in, rows a page holds outside its own boundaries, and the retained size with
// and without the reader's page (the budget's one exception).
import 'dart:convert';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_telemetry.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import 'session_detail_controller_test_harness.dart';

const _key = SessionDetailKey(tool: 'claude', sessionId: 'session-1');

/// Whether [message] is state or telemetry restated under one key (or none)
/// throughout a session: it carries no position, so order and duplicate
/// checks leave it to the projections.
bool _isPositionless(AgentMessage message) =>
    isSessionLiveStateMessage(message) ||
    isSessionTelemetryMessage(message) ||
    message.type == AgentMessageType.status ||
    message.type == AgentMessageType.runSummary;

/// The content of a row without a key, independent of field order.
String _signature(AgentMessage message) => jsonEncode(_canonical(message.raw));

Object? _canonical(Object? value) {
  if (value is Map) {
    final keys = [for (final key in value.keys) '$key']..sort();
    return {for (final key in keys) key: _canonical(value[key])};
  }
  if (value is List) return [for (final item in value) _canonical(item)];
  return value;
}

/// A socket that also refreshes, pages forward and restarts its attach,
/// recording each request.
final class _MatrixConnection extends FakeSessionDetailConnection
    implements SessionHistoryNavigationConnection {
  final refreshes = <({String cursor, String id})>[];
  final newerPages = <({String cursor, String until, int? limit, String id})>[];

  /// Whether the controller asked to attach again since the client looked.
  bool restartRequested = false;

  @override
  Future<bool> requestHistoryRefresh({
    required String cursor,
    required String clientMessageId,
    int? limit,
  }) async {
    refreshes.add((cursor: cursor, id: clientMessageId));
    return true;
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
      until: until!,
      limit: limit,
      id: clientMessageId!,
    ));
  }

  @override
  Future<void> restartAttach() async {
    restartRequested = true;
  }
}

/// A broker's durable history for one session, with its cursor rules.
final class SimBroker {
  SimBroker({required this.revision28});

  /// Whether the broker is at contract revision 28: end cursors, newer
  /// history, the state still trailing its history kept out of its cursors,
  /// and every frame sent while a turn runs ended at the running-turn hold,
  /// with the held rows and that state replayed after it. A revision-27
  /// broker offers none of these.
  final bool revision28;

  final List<AgentMessage> durable = [];
  bool turnRunning = false;

  /// The running unit's token reading, re-projected at the end of every read
  /// while the turn runs (never stored: the next read has a new one).
  AgentMessage? projected;

  /// Each durable transcript row's index, by stable key (or, for a row with
  /// no key, by its content).
  final Map<String, int> positionOf = {};

  /// Prompts sent while a turn runs that the agent has not taken yet, by
  /// key: the live snapshot restates them after every attach, and each is
  /// saved where the agent takes it.
  final Map<String, AgentMessage> queued = {};

  /// Cards still waiting for an answer, by request id: the live snapshot
  /// restates them after every attach.
  final Map<String, AgentMessage> pending = {};

  /// Every [nackEvery]th refresh fails to read, and is refused with
  /// HISTORY_PAGE_SOURCE_CHANGED (none when 0).
  int nackEvery = 0;
  var _refreshReads = 0;

  /// The indices at which a row was rewritten or history cut back: a cursor
  /// over more rows than one of them names a history that no longer exists.
  final List<int> _rewrittenAt = [];

  /// What follows the last attach-shaped or reconnect frame, in order: the
  /// rows the running-turn hold kept out of it, the queued prompts, the cards
  /// waiting for an answer, the trailing state, the running reading, a status
  /// tick and the context reading.
  List<AgentMessage> replayed = const [];

  // What the scenarios claim to exercise.
  int heldRowsReplayed = 0;
  int projectedReplayed = 0;
  int projectedCounted = 0;
  int summaryRewrites = 0;
  int refreshNacks = 0;
  int refusedCursors = 0;
  int divergedFrames = 0;

  static final AgentMessage _statusTick = AgentMessage.fromJson({
    'type': 'status',
    'status': 'running',
    'detail': 'working',
  });

  static final AgentMessage _contextReading = AgentMessage.fromJson({
    'type': 'metadata-update',
    'key': 'contextUsage',
    'contextPercent': 40,
  });

  static String? identity(AgentMessage message) =>
      stableTranscriptMessageKey(message) ?? _signature(message);

  /// Appends [message] to history, or rewrites the row with its key in place
  /// (a part that grew, a call whose arguments arrived). A run summary takes
  /// part in cursors by its identity only, so its rewrite moves no boundary;
  /// any other rewrite that changes the row does.
  void persist(AgentMessage message) {
    final key = stableTranscriptMessageKey(message);
    if (key != null && message.type == AgentMessageType.runSummary) {
      final at = durable.indexWhere(
        (row) => stableTranscriptMessageKey(row) == key,
      );
      if (at >= 0) {
        summaryRewrites += 1;
        durable[at] = message;
        return;
      }
    }
    final at = key == null ? null : positionOf[key];
    if (at != null) {
      if (_signature(durable[at]) != _signature(message)) _rewrittenAt.add(at);
      durable[at] = message;
      return;
    }
    if (!_isPositionless(message)) {
      positionOf[identity(message)!] = durable.length;
    }
    durable.add(message);
  }

  /// Cuts history back to its first [rows] rows (the user rewound the
  /// session): every cursor past them now names a history that is gone.
  void rewind(int rows) {
    durable.removeRange(rows, durable.length);
    positionOf.removeWhere((_, at) => at >= rows);
    _rewrittenAt.add(rows);
  }

  /// A cursor of [kind] (`b` backward, `r` reconnect) after [rows] rows: the
  /// broker's cursors carry a hash of the rows before them, so one over a
  /// rewritten row differs from the cursor issued before the rewrite.
  String _cursor(String kind, int rows) {
    final version = _rewrittenAt.where((at) => at < rows).length;
    return version == 0 ? '$kind$rows' : '$kind$rows~$version';
  }

  static int boundary(String cursor) {
    final end = cursor.indexOf('~');
    return int.parse(cursor.substring(1, end < 0 ? null : end));
  }

  /// Whether [cursor] still names a boundary of this history.
  bool holds(String cursor) {
    final rows = boundary(cursor);
    return rows <= durable.length && cursor == _cursor(cursor[0], rows);
  }

  NackWireEvent _refuse(String cursor, String clientMessageId) {
    refusedCursors += 1;
    return NackWireEvent(
      code: boundary(cursor) > durable.length
          ? 'HISTORY_CURSOR_GONE'
          : 'HISTORY_CURSOR_DIVERGED',
      message: 'history cursor no longer matches this session',
      clientMessageId: clientMessageId,
    );
  }

  static bool _volatile(AgentMessage message) =>
      message.type == AgentMessageType.tokenCount ||
      (message.type == AgentMessageType.runSummary &&
          message.raw['status'] != null &&
          message.raw['status'] != 'done');

  /// Where the broker's cursor space ends: before the trailing run of state a
  /// read restates (revision 28), else at the end of history.
  int get cursorEnd {
    if (!revision28) return durable.length;
    var end = durable.length;
    while (end > 0 &&
        durable.length - end < 64 &&
        _volatile(durable[end - 1])) {
      end -= 1;
    }
    return end;
  }

  static bool _isStreamedText(AgentMessage message) =>
      (message.type == AgentMessageType.modelOutput ||
          message.type == AgentMessageType.thinking) &&
      message.raw['key'] is String;

  /// The running-turn hold (revision 28): while a turn runs, a frame or page
  /// over the cursor space from [start] to [end] stops before the newest row
  /// when it is streamed text, then before the tool calls just before that,
  /// never below [start].
  int _holdEnd(int start, int end) {
    if (!revision28 || !turnRunning) return end;
    var stop = end;
    if (stop > start && _isStreamedText(durable[stop - 1])) stop -= 1;
    while (stop > start &&
        durable[stop - 1].type == AgentMessageType.toolCall) {
      stop -= 1;
    }
    return stop;
  }

  /// Records what follows a frame that ends at [stop].
  void _replayAfter(int stop) {
    final end = cursorEnd;
    final held = revision28 ? durable.sublist(stop, end) : <AgentMessage>[];
    heldRowsReplayed += held.length;
    final reading = revision28 && turnRunning ? projected : null;
    if (reading != null) projectedReplayed += 1;
    replayed = [
      ...held,
      ...queued.values,
      ...pending.values,
      if (revision28) ...durable.sublist(end),
      ?reading,
      if (turnRunning) _statusTick,
      _contextReading,
    ];
  }

  Map<String, Object?> _frame(
    int from,
    int through, {
    required bool reset,
    String? clientMessageId,
    bool capped = false,
    String? gap,
  }) {
    // A revision-27 broker's frame ends with whatever the read projected, and
    // its cursor counts it.
    final projectedRow = !revision28 && through == durable.length && turnRunning
        ? projected
        : null;
    if (projectedRow != null) projectedCounted += 1;
    if (gap != null) divergedFrames += 1;
    return {
      'kind': 'history',
      'reset': reset,
      'messages': [
        for (final message in durable.sublist(from, through)) message.raw,
        ?projectedRow?.raw,
      ],
      'cursor': _cursor('r', through + (projectedRow == null ? 0 : 1)),
      if (reset) 'olderCursor': from > 0 ? _cursor('b', from) : null,
      if (reset) 'hasEarlier': from > 0,
      if (capped) 'truncated': {'shown': through - from, 'total': through},
      if (gap != null)
        'gap': {
          'code': gap,
          'reason': 'cursor-prefix-mismatch',
          'message': 'history cursor no longer matches this session',
        },
      if (revision28) 'endCursor': _cursor('b', through),
      if (revision28) 'newerHistory': true,
      'clientMessageId': ?clientMessageId,
    };
  }

  HistoryWireEvent _event(Map<String, Object?> json) =>
      WireEvent.fromJson(json) as HistoryWireEvent;

  /// An attach-shaped frame (an attach, a reconnect too far behind, a hub
  /// resync): the newest [limit] rows of the cursor space up to the
  /// running-turn hold, with [gap] when it answers a cursor that is gone.
  HistoryWireEvent attach({
    int limit = kTranscriptHistoryPageMessages,
    String? gap,
  }) {
    final stop = _holdEnd(0, cursorEnd);
    final from = stop > limit ? stop - limit : 0;
    _replayAfter(stop);
    return _event(
      _frame(from, stop, reset: true, capped: from > 0, gap: gap),
    );
  }

  /// A reconnect from [cursor]: the rows persisted since, or, past [limit],
  /// the newest [limit] rows as a reset with no gap (a capped catch-up). A
  /// cursor this history no longer has is answered by a reset that says so.
  HistoryWireEvent reconnect(
    String cursor, {
    int limit = kTranscriptHistoryPageMessages,
  }) {
    final since = boundary(cursor);
    final end = cursorEnd;
    if (revision28 && !holds(cursor)) {
      return attach(
        limit: limit,
        gap: since > durable.length
            ? 'HISTORY_CURSOR_GONE'
            : 'HISTORY_CURSOR_DIVERGED',
      );
    }
    if (since > end) return attach(limit: limit);
    final stop = _holdEnd(since, end);
    if (stop - since > limit) return attach(limit: limit);
    _replayAfter(stop);
    return _event(_frame(since, stop, reset: false));
  }

  /// A boundary refresh from [cursor] (revision 28): a bounded prefix of the
  /// rows persisted since, ending at the running-turn hold. Nothing follows
  /// it: the client received those rows live.
  WireEvent refresh(
    String cursor,
    String clientMessageId, {
    int limit = kTranscriptHistoryPageMessages,
  }) {
    if (!holds(cursor)) return _refuse(cursor, clientMessageId);
    if (nackEvery > 0 && ++_refreshReads % nackEvery == 0) {
      refreshNacks += 1;
      return NackWireEvent(
        code: 'HISTORY_PAGE_SOURCE_CHANGED',
        message: 'This session history could not be read. Try again.',
        clientMessageId: clientMessageId,
      );
    }
    final since = boundary(cursor);
    final end = cursorEnd;
    final held = _holdEnd(since, end);
    final stop = since + limit < held ? since + limit : held;
    return _event(
      _frame(since, stop, reset: false, clientMessageId: clientMessageId),
    );
  }

  /// A backward page ending at [cursor].
  WireEvent pageBefore(String cursor, int limit, String clientMessageId) {
    if (!holds(cursor)) return _refuse(cursor, clientMessageId);
    var at = boundary(cursor);
    final page = <AgentMessage>[];
    while (at > 0 && page.length < limit) {
      at -= 1;
      if (isBackwardPageableTranscriptMessage(durable[at])) {
        page.insert(0, durable[at]);
      }
    }
    return WireEvent.fromJson({
      'kind': 'history-page',
      'messages': [for (final message in page) message.raw],
      'cursor': at > 0 ? _cursor('b', at) : null,
      'hasMore': at > 0,
      'endOfHistory': at == 0,
      'clientMessageId': clientMessageId,
    });
  }

  /// A newer page starting at [cursor], stopping at [until] (revision 28).
  WireEvent pageAfter(
    String cursor,
    String until,
    int limit,
    String clientMessageId,
  ) {
    if (!holds(cursor)) return _refuse(cursor, clientMessageId);
    if (!holds(until)) return _refuse(until, clientMessageId);
    final start = boundary(cursor);
    final stop = boundary(until);
    final page = <AgentMessage>[];
    var at = start;
    while (at < stop && page.length < limit) {
      final message = durable[at];
      at += 1;
      if (isBackwardPageableTranscriptMessage(message)) page.add(message);
    }
    while (at < stop && !isBackwardPageableTranscriptMessage(durable[at])) {
      at += 1;
    }
    final hasMore = at < cursorEnd;
    return WireEvent.fromJson({
      'kind': 'history-page',
      'direction': 'newer',
      'messages': [for (final message in page) message.raw],
      'cursor': at == stop ? until : _cursor('b', at),
      'hasMore': hasMore,
      'endOfHistory': !hasMore,
      'clientMessageId': clientMessageId,
    });
  }
}

/// One item of the transcript as a reader scrolls it.
sealed class _Item {}

final class _RowItem extends _Item {
  _RowItem(this.key);
  final String key;
}

final class _GapItem extends _Item {
  _GapItem(this.gap);
  final TranscriptHistoryGapSegment gap;
}

/// Measurements over one scenario.
final class MatrixMetrics {
  int mutations = 0;
  int maxReconnectGaps = 0;
  int finalReconnectGaps = 0;
  int mutationsWithReconnectGap = 0;
  int maxUnsavedNotices = 0;
  int heldTwice = 0;
  int keylessHeldTwice = 0;
  int outOfOrder = 0;
  int liveOnlyOutOfPlace = 0;
  int rowsOutsideTheirPage = 0;
  int peakRows = 0;
  int peakBytes = 0;
  int peakRowsBeyondReader = 0;
  int peakBytesBeyondReader = 0;
  int refreshes = 0;
  int olderPages = 0;
  int newerPages = 0;
  int downwardStalls = 0;
  int rejectedPages = 0;
  int reconnects = 0;
  int cappedReconnects = 0;
  int cappedKeepingPages = 0;
  int restarts = 0;
  int resyncs = 0;
  int refusedRangesPassed = 0;
  int liveRowsDelivered = 0;
  int liveOnlyRowsDelivered = 0;
  int replayedRows = 0;
  int maxCardsWaiting = 0;
  int maxCardsWithdrawn = 0;
  int durableRowsUnreached = 0;
  int liveOnlyRowsUnreached = 0;
  int rowsNoLongerSavedAtEnd = 0;
  int staleRunSummariesAtEnd = 0;
  int cardsWaitingAtEnd = 0;
  final Map<String, int> broker = {};
  final Set<String> firstHeldTwice = {};

  /// The window just after the first anomaly of each kind (a reconnect gap,
  /// an unsaved notice, a row held twice, a row out of order, a row never
  /// saved out of place, a row outside its page, pages out of order, the
  /// budget exceeded beyond the reader's page), and the operation that led to
  /// it.
  final Map<String, String> firstAnomalies = {};

  String? get firstAnomaly =>
      firstAnomalies.isEmpty ? null : firstAnomalies.values.first;

  Map<String, Object?> toJson() => {
    'mutations': mutations,
    'reconnectRequiredGaps': {
      'max': maxReconnectGaps,
      'final': finalReconnectGaps,
      'mutationsShowingOne': mutationsWithReconnectGap,
    },
    'unsavedReleasedNoticesMax': maxUnsavedNotices,
    'rowsHeldTwice': heldTwice,
    'keylessRowsHeldTwice': keylessHeldTwice,
    'rowsOutOfPersistedOrder': outOfOrder,
    'neverSavedRowsOutOfPlace': liveOnlyOutOfPlace,
    'rowsOutsideTheirPageBoundaries': rowsOutsideTheirPage,
    'peak': {
      'rows': peakRows,
      'bytes': peakBytes,
      'rowsBeyondReaderPage': peakRowsBeyondReader,
      'bytesBeyondReaderPage': peakBytesBeyondReader,
      'budgetRows': kMaxActiveTranscriptMessages,
      'budgetBytes': kMaxActiveTranscriptDecodedBytes,
    },
    'requests': {
      'refreshes': refreshes,
      'olderPages': olderPages,
      'newerPages': newerPages,
      'rejectedPages': rejectedPages,
    },
    'reconnects': reconnects,
    'cappedReconnects': cappedReconnects,
    'cappedReconnectsKeepingPagesRead': cappedKeepingPages,
    'restartsForARefusedCursor': restarts,
    'hubResyncs': resyncs,
    'refusedRangesScrolledPast': refusedRangesPassed,
    'downwardStalls': downwardStalls,
    'liveRowsDelivered': liveRowsDelivered,
    'liveOnlyRowsDelivered': liveOnlyRowsDelivered,
    'rowsReplayedAfterFrames': replayedRows,
    'maxCardsWaiting': maxCardsWaiting,
    'maxCardsWithdrawn': maxCardsWithdrawn,
    'unreachedAfterFullTraversal': {
      'durable': durableRowsUnreached,
      'liveOnly': liveOnlyRowsUnreached,
    },
    'atEnd': {
      'rowsNoLongerSaved': rowsNoLongerSavedAtEnd,
      'staleRunSummaries': staleRunSummariesAtEnd,
      'cardsWaitingTheBrokerNoLongerHas': cardsWaitingAtEnd,
    },
    'broker': broker,
    'anomalies': firstAnomalies.keys.toList(),
    if (firstHeldTwice.isNotEmpty)
      'heldTwiceSample': firstHeldTwice.take(5).toList(),
  };
}

/// The client side of one scenario: the session controller, the reader, the
/// socket.
final class MatrixClient {
  MatrixClient(this.broker);

  final SimBroker broker;
  final MatrixMetrics metrics = MatrixMetrics();
  final _MatrixConnection _connection = _MatrixConnection();
  late final ProviderContainer _container;

  SessionDetailController get _controller =>
      _container.read(sessionDetailControllerProvider(_key).notifier);

  SessionDetailState get _state =>
      _container.read(sessionDetailControllerProvider(_key));

  TranscriptHistoryWindow get window => _state.transcriptWindow;

  /// The stable key of the row being read, or null while following the tail.
  String? reading;
  bool connected = true;
  var _seq = 0;
  var _answeredRefreshes = 0;
  var _answeredNewerPages = 0;
  var _restarting = false;

  // Refresh answers the broker read when asked, each delivered after
  // [refreshLatencyRows] more live rows (the socket carries live rows
  // meanwhile).
  final List<({WireEvent answer, int due})> _refreshAnswers = [];

  /// The reader's row as the window last saw it (what its budget spared).
  String? _protected;

  /// What the client last did, for anomaly reports.
  String lastOperation = 'nothing';

  /// Keys of rows never saved this client received, each with the key of the
  /// row delivered just before it.
  final Map<String, String?> _liveOnlyAfter = {};
  String? _lastDelivered;

  /// Keys present in the window at some point during the last traversal.
  final Set<String> _traversed = {};
  bool _tracing = false;

  static const int refreshLatencyRows = 3;

  /// Delivers [event] with the reader's position in force: the window fits
  /// its budget around the row being read as it applies the event. A restart
  /// the controller asked for meanwhile closes the socket and attaches again.
  Future<void> _emit(WireEvent event) async {
    _protected = reading;
    _controller.protectHistoryViewportAnchor(reading);
    _connection.emitEvent(event);
    await drainSessionDetailMicrotasks();
    if (_connection.restartRequested && !_restarting) {
      _connection.restartRequested = false;
      _restarting = true;
      metrics.restarts += 1;
      final operation = lastOperation;
      await disconnect();
      await reconnect();
      lastOperation = 'restart after $operation';
      _restarting = false;
    }
  }

  /// Opens the session and receives its attach frame.
  Future<void> attach() async {
    _container = buildControllerContainer(
      _key,
      _connection,
      FakeControllerAttachmentPicker(),
    );
    keepSessionDetailAlive(_container, _key);
    await _controller.attach();
    await _emit(defaultControllerHello);
    lastOperation = 'attach';
    await _frame(broker.attach());
  }

  /// A history frame, then what the broker replays after it, then the
  /// session's status.
  Future<void> _frame(HistoryWireEvent event) async {
    await _emit(event);
    _observe();
    for (final message in broker.replayed) {
      metrics.replayedRows += 1;
      // A card first seen in a replay arrived after nothing in particular.
      if (_isCard(message)) {
        _liveOnlyAfter.putIfAbsent(_keyOf(message), () => null);
      }
      await _emit(MessageWireEvent(seq: ++_seq, message: message));
    }
    await _status(broker.turnRunning ? 'working' : 'idle');
    _observe();
    await _takeRefreshRequests();
  }

  static String _keyOf(AgentMessage message) => SimBroker.identity(message)!;

  Future<void> _status(String status) => _emit(
    SessionWireEvent(
      info: SessionInfo.fromJson({
        'id': 'session-1',
        'tool': 'claude',
        'title': 'Matrix',
        'status': status,
        'attachMode': 'observe',
      }),
    ),
  );

  Future<void> turnStart() async {
    broker.turnRunning = true;
    if (connected) await _status('working');
  }

  /// A row the agent sends live; [persist] also appends it to history. A row
  /// that [anchors] is the one the next never-saved row arrived after (a
  /// queued prompt is not: it is saved where the agent takes it).
  Future<void> live(
    AgentMessage message, {
    bool persist = true,
    bool liveOnly = false,
    bool anchors = true,
  }) async {
    if (persist) broker.persist(message);
    if (!connected) return;
    final key = _keyOf(message);
    metrics.liveRowsDelivered += 1;
    if (liveOnly) {
      metrics.liveOnlyRowsDelivered += 1;
      _liveOnlyAfter.putIfAbsent(key, () => _lastDelivered);
    }
    if (!_isPositionless(message) && anchors) _lastDelivered = key;
    lastOperation = 'live $key';
    await _emit(MessageWireEvent(seq: ++_seq, message: message));
    _observe();
    await _takeRefreshRequests();
    await _deliverDueRefreshes(elapsed: 1);
  }

  /// A durable row that reaches history without being sent live now (a
  /// streamed reply's final row, or rows persisted while disconnected).
  void persistOnly(AgentMessage message) => broker.persist(message);

  Future<void> turnEnd() async {
    broker.turnRunning = false;
    if (!connected) return;
    await _deliverDueRefreshes(all: true);
    await _status('idle');
    await _takeRefreshRequests();
    await _deliverDueRefreshes(all: true);
  }

  /// Reads the answer to every refresh the controller asked for since the
  /// last look, from the history as it is now.
  Future<void> _takeRefreshRequests() async {
    while (_answeredRefreshes < _connection.refreshes.length) {
      final request = _connection.refreshes[_answeredRefreshes++];
      metrics.refreshes += 1;
      _refreshAnswers.add((
        answer: broker.refresh(request.cursor, request.id),
        due: refreshLatencyRows,
      ));
    }
  }

  Future<void> _deliverDueRefreshes({int elapsed = 0, bool all = false}) async {
    for (var index = 0; index < _refreshAnswers.length; index++) {
      final pending = _refreshAnswers[index];
      _refreshAnswers[index] = (
        answer: pending.answer,
        due: pending.due - elapsed,
      );
    }
    while (_refreshAnswers.isNotEmpty &&
        (all || _refreshAnswers.first.due <= 0)) {
      final answer = _refreshAnswers.removeAt(0).answer;
      lastOperation = switch (answer) {
        final HistoryWireEvent frame =>
          'refresh answer ${frame.clientMessageId}: '
              '${frame.messages.length} rows to ${frame.cursor}',
        final NackWireEvent nack =>
          'refresh ${nack.clientMessageId} refused ${nack.code}',
        _ => 'refresh answer',
      };
      await _emit(answer);
      _observe();
      await _takeRefreshRequests();
    }
  }

  Future<void> disconnect() async {
    connected = false;
    // The socket is gone: nothing it was asked can be answered.
    _refreshAnswers.clear();
    _connection.emitState(SessionDetailConnectionStatus.reconnecting);
    await drainSessionDetailMicrotasks();
  }

  Future<void> reconnect() async {
    connected = true;
    metrics.reconnects += 1;
    _connection.emitState(SessionDetailConnectionStatus.connected);
    await _emit(defaultControllerHello);
    final cursor = window.historyCursor;
    final event = cursor == null ? broker.attach() : broker.reconnect(cursor);
    final capped = event.reset && event.truncated != null;
    if (capped) metrics.cappedReconnects += 1;
    lastOperation =
        'reconnect from $cursor: ${event.reset ? 'reset' : 'delta'} '
        '${event.messages.length} rows, older ${event.olderCursor}'
        '${event.gap == null ? '' : ', ${event.gap!.code}'}';
    await _frame(event);
    // A capped reset that kept the pages read before it (a catch-up).
    final frameStart = SimBroker.boundary(event.olderCursor ?? 'b0');
    if (capped &&
        event.gap == null &&
        window.pages.any(
          (page) =>
              !page.isTail &&
              !page.headReleased &&
              SimBroker.boundary(page.olderCursor ?? 'b0') < frameStart,
        )) {
      metrics.cappedKeepingPages += 1;
    }
  }

  /// The hub resyncs the socket: an attach-shaped frame, with no reconnect
  /// before it.
  Future<void> resync() async {
    if (!connected) return;
    metrics.resyncs += 1;
    lastOperation = 'hub resync';
    await _frame(broker.attach());
  }

  /// The transcript as a reader scrolls it: rows, with the gap notices
  /// between the runs they separate.
  List<_Item> _items() {
    final items = <_Item>[];
    final leading = window.leadingGap;
    if (leading != null) items.add(_GapItem(leading));
    final gaps = window.gaps;
    var gapIndex = 0;
    TranscriptHistoryPage? previous;
    final seen = <String>{};
    for (final page in window.pages) {
      if (previous != null) {
        final connectedRun =
            previous.newerCursor != null &&
            previous.newerCursor == page.olderCursor;
        if (page.headReleased || !connectedRun) {
          items.add(_GapItem(gaps[gapIndex++]));
        }
      }
      for (final message in page.messages) {
        final key = stableTranscriptMessageKey(message);
        if (key != null && seen.add(key)) items.add(_RowItem(key));
      }
      previous = page;
    }
    if (gapIndex != gaps.length) {
      throw StateError('gap walk out of step: $gapIndex of ${gaps.length}');
    }
    return items;
  }

  int _readerAt(List<_Item> items) {
    final key = reading;
    if (key != null) {
      final at = items.indexWhere(
        (item) => item is _RowItem && item.key == key,
      );
      if (at >= 0) return at;
    }
    return items.lastIndexWhere((item) => item is _RowItem);
  }

  /// Whether [gap] only says something: nothing to load, or a range the
  /// broker refused a position of, which says it cannot load.
  bool _isNotice(TranscriptHistoryGapSegment gap) {
    if (gap.kind != TranscriptHistoryGapKind.reloadable) return true;
    if (!_state.historyGapRefused(gap)) return false;
    metrics.refusedRangesPassed += 1;
    return true;
  }

  /// Reads back toward the start, loading at most [loads] pages (all the way
  /// to the start when null).
  Future<void> readBack({int? loads}) async {
    var remaining = loads ?? 1 << 30;
    for (var guard = 0; guard < 4000 && remaining > 0; guard++) {
      final items = _items();
      var at = _readerAt(items);
      if (at < 0) return;
      while (at > 0 && items[at - 1] is _RowItem) {
        at -= 1;
      }
      reading = (items[at] as _RowItem).key;
      final gapAbove = at > 0 ? (items[at - 1] as _GapItem).gap : null;
      final rowAbove = at > 1
          ? items.take(at - 1).whereType<_RowItem>().lastOrNull
          : null;
      final notice = gapAbove != null && _isNotice(gapAbove);
      if (notice && rowAbove != null) {
        // A notice: the reader scrolls past it to the run above.
        reading = rowAbove.key;
        continue;
      }
      if (gapAbove != null && !notice) {
        final forward = gapAbove.forwardCursor;
        if (window.reloadsOnlyForward(gapAbove.reloadCursor!) &&
            forward != null &&
            _controller.canLoadNewerHistory) {
          await _loadNewer(forward, gapAbove.reloadCursor!);
        } else {
          await _loadOlder(gapAbove.reloadCursor!);
        }
        remaining -= 1;
        continue;
      }
      final cursor = window.olderHistoryCursor;
      if (window.leadingEdgeReleased || cursor == null) return;
      if (_state.olderHistoryRefusal != null) {
        metrics.refusedRangesPassed += 1;
        return;
      }
      await _loadOlder(cursor);
      remaining -= 1;
    }
  }

  /// Reads forward toward the latest row, loading at most [loads] pages (all
  /// the way when null). A client that cannot page forward loads nothing on
  /// the way down: the reader stalls at the gap and nudges back up, which
  /// loads it from its newer edge.
  Future<void> readForward({int? loads}) async {
    var remaining = loads ?? 1 << 30;
    for (var guard = 0; guard < 4000 && remaining > 0; guard++) {
      final items = _items();
      var at = _readerAt(items);
      if (at < 0) return;
      while (at + 1 < items.length && items[at + 1] is _RowItem) {
        at += 1;
      }
      reading = (items[at] as _RowItem).key;
      if (at + 1 >= items.length) {
        reading = null;
        return;
      }
      final gap = (items[at + 1] as _GapItem).gap;
      if (_isNotice(gap)) {
        final below = items
            .skip(at + 2)
            .firstWhere(
              (item) => item is _RowItem,
              orElse: () => _GapItem(gap),
            );
        if (below is! _RowItem) return;
        reading = below.key;
        continue;
      }
      final forward = gap.forwardCursor;
      if (forward == null || !_controller.canLoadNewerHistory) {
        metrics.downwardStalls += 1;
        await _loadOlder(gap.reloadCursor!);
      } else {
        await _loadNewer(forward, gap.reloadCursor!);
      }
      remaining -= 1;
    }
  }

  /// Answers every older page the controller asked for (a page too large to
  /// keep is asked for again, smaller).
  Future<void> _loadOlder(String cursor) async {
    lastOperation = 'older page at $cursor (reading $reading)';
    metrics.olderPages += 1;
    var answered = _connection.historyPageRequestCount;
    final sent = await _controller.loadEarlierHistory(
      cursor: cursor,
      limit: window.reloadLimitFor(cursor) ?? kTranscriptHistoryPageMessages,
    );
    if (!sent) _refused('older page from $cursor was not sent');
    for (
      var guard = 0;
      answered < _connection.historyPageRequestCount;
      guard++
    ) {
      if (guard > 8) _refused('older page from $cursor asked $guard times');
      answered = _connection.historyPageRequestCount;
      await _emit(
        broker.pageBefore(
          _connection.lastHistoryPageCursor!,
          _connection.lastHistoryPageLimit ?? kTranscriptHistoryPageMessages,
          _connection.lastHistoryPageClientMessageId!,
        ),
      );
    }
    _pageSettled('older page from $cursor');
  }

  /// Answers every newer page the controller asked for, retries included.
  Future<void> _loadNewer(String cursor, String until) async {
    lastOperation = 'newer page $cursor..$until (reading $reading)';
    metrics.newerPages += 1;
    final sent = await _controller.loadNewerHistory(
      cursor: cursor,
      until: until,
    );
    if (!sent) _refused('newer page from $cursor was not sent');
    for (
      var guard = 0;
      _answeredNewerPages < _connection.newerPages.length;
      guard++
    ) {
      if (guard > 8) _refused('newer page from $cursor asked $guard times');
      final request = _connection.newerPages[_answeredNewerPages++];
      await _emit(
        broker.pageAfter(
          request.cursor,
          request.until,
          request.limit ?? kTranscriptHistoryPageMessages,
          request.id,
        ),
      );
    }
    _pageSettled('newer page from $cursor');
  }

  void _pageSettled(String what) {
    if (_state.historyPageLoading || _state.historyPageErrorCode != null) {
      metrics.rejectedPages += 1;
      _refused(
        '$what: loading ${_state.historyPageLoading}, '
        'error ${_state.historyPageErrorCode}',
      );
    }
    _observe();
  }

  Never _refused(String what) => throw StateError('$what\n${describe()}');

  /// The window's pages, for a failure message: each page's boundaries,
  /// kind and row types, starred where it holds [marking].
  String describe({String? marking}) {
    final head =
        'reading=$reading rows=${window.messageCount} '
        'bytes=${window.estimatedBytes}';
    String line(TranscriptHistoryPage page) {
      final types = <String, int>{};
      var marked = false;
      for (final message in page.messages) {
        final type = '${message.raw['type']}';
        types[type] = (types[type] ?? 0) + 1;
        if (marking != null && SimBroker.identity(message) == marking) {
          marked = true;
        }
      }
      final counts = [
        for (final MapEntry(:key, :value) in types.entries) '${key}x$value',
      ];
      return '${marked ? '* ' : '  '}'
          '[${page.olderCursor}..${page.newerCursor}] '
          '${page.isTail ? 'tail block=${page.blockRows} '
                    'end=${page.blockEndCursor} ' : ''}'
          '${page.isResidue ? 'residue ' : ''}'
          '${page.headReleased ? 'released ' : ''}'
          'rows=${page.messages.length} bytes=${page.estimatedBytes} '
          '${counts.join(' ')}';
    }

    final gaps = [
      for (final gap in [?window.leadingGap, ...window.gaps])
        '${gap.kind.name} ${gap.forwardCursor}..${gap.reloadCursor}',
    ];
    return [
      head,
      for (final page in window.pages) line(page),
      'gaps: ${gaps.join(', ')}',
    ].join('\n');
  }

  /// Starts recording which rows the window holds while a reader traverses
  /// the whole transcript.
  void startTraversal() {
    _traversed.clear();
    _tracing = true;
    _observe();
  }

  /// Stops recording, counts rows no step of the traversal held, and what
  /// the window still holds that the broker no longer does.
  void endTraversal() {
    _tracing = false;
    final durableKeys = {
      for (final message in broker.durable)
        if (!_isPositionless(message)) _keyOf(message),
    };
    metrics.durableRowsUnreached = durableKeys.difference(_traversed).length;
    metrics.liveOnlyRowsUnreached = _liveOnlyAfter.keys
        .toSet()
        .difference(_traversed)
        .length;
    final summaries = {
      for (final message in broker.durable)
        if (message.type == AgentMessageType.runSummary)
          stableTranscriptMessageKey(message)!: _signature(message),
    };
    final waiting = _waitingCards();
    for (final page in window.pages) {
      for (final message in page.messages) {
        final key = _keyOf(message);
        if (message.type == AgentMessageType.runSummary) {
          final saved = summaries[stableTranscriptMessageKey(message)];
          if (saved != null && saved != _signature(message)) {
            metrics.staleRunSummariesAtEnd += 1;
          }
          continue;
        }
        if (_isPositionless(message)) continue;
        if (!durableKeys.contains(key) && !_liveOnlyAfter.containsKey(key)) {
          metrics.rowsNoLongerSavedAtEnd += 1;
        }
        final id = message.raw['requestId'];
        if (_isCard(message) &&
            waiting.contains(id) &&
            !broker.pending.containsKey(id)) {
          metrics.cardsWaitingAtEnd += 1;
        }
      }
    }
    metrics.broker.addAll({
      'heldRowsReplayed': broker.heldRowsReplayed,
      'runningReadingsReplayed': broker.projectedReplayed,
      'runningReadingsCounted': broker.projectedCounted,
      'runSummariesRewritten': broker.summaryRewrites,
      'refreshesRefused': broker.refreshNacks,
      'cursorsRefused': broker.refusedCursors,
      'framesForAGoneCursor': broker.divergedFrames,
    });
  }

  void _observe() {
    if (!window.initialized) return;
    metrics.mutations += 1;
    final gaps = [?window.leadingGap, ...window.gaps];
    final reconnect = gaps
        .where((gap) => gap.kind == TranscriptHistoryGapKind.reconnectRequired)
        .length;
    final unsaved = gaps
        .where((gap) => gap.kind == TranscriptHistoryGapKind.unsavedReleased)
        .length;
    void anomaly(String kind, String what, {String? marking}) =>
        metrics.firstAnomalies.putIfAbsent(
          kind,
          () => 'after $lastOperation: $what\n${describe(marking: marking)}',
        );
    if (reconnect > 0) anomaly('reconnect', '$reconnect reconnect gaps');
    // Pages in history order: each starts no earlier than the one before.
    var floor = 0;
    for (final page in window.pages) {
      final older = page.olderCursor;
      final start = older == null ? 0 : SimBroker.boundary(older);
      if (start < floor) {
        anomaly('pageOrder', 'a page from $older after one from b$floor');
      }
      if (start > floor) floor = start;
    }
    if (unsaved > 0) anomaly('unsaved', '$unsaved unsaved notices');
    if (reconnect > metrics.maxReconnectGaps) {
      metrics.maxReconnectGaps = reconnect;
    }
    if (reconnect > 0) metrics.mutationsWithReconnectGap += 1;
    metrics.finalReconnectGaps = reconnect;
    if (unsaved > metrics.maxUnsavedNotices) {
      metrics.maxUnsavedNotices = unsaved;
    }
    final position = broker.positionOf;
    // Held once: no row in two retained copies, keyed or not. Within its
    // page: a saved row a page vouches for lies between that page's
    // boundaries.
    final held = <String>{};
    for (final page in window.pages) {
      final newer = page.isTail ? page.blockEndCursor : page.newerCursor;
      final vouched = page.isResidue || page.headReleased || newer == null
          ? 0
          : page.isTail
          ? page.blockRows ?? 0
          : page.messages.length;
      final unvouched = page.isTail
          ? page.blockLiveOnlyRows
          : page.liveOnlyRows;
      final start = page.olderCursor == null
          ? 0
          : SimBroker.boundary(page.olderCursor!);
      final end = newer == null ? 0 : SimBroker.boundary(newer);
      for (var index = 0; index < page.messages.length; index++) {
        final message = page.messages[index];
        if (_isPositionless(message)) continue;
        final key = _keyOf(message);
        if (!held.add(key)) {
          final keyless = stableTranscriptMessageKey(message) == null;
          anomaly(
            keyless ? 'keylessHeldTwice' : 'heldTwice',
            '$key held twice',
            marking: key,
          );
          if (keyless) {
            metrics.keylessHeldTwice += 1;
          } else {
            metrics.heldTwice += 1;
          }
          if (metrics.firstHeldTwice.length < 5) {
            metrics.firstHeldTwice.add(key);
          }
        }
        if (_tracing) _traversed.add(key);
        final at = position[key];
        if (index < vouched &&
            !unvouched.contains(index) &&
            at != null &&
            (at < start || at >= end)) {
          metrics.rowsOutsideTheirPage += 1;
          anomaly(
            'pageBounds',
            '$key (row $at) in a page from b$start to b$end',
            marking: key,
          );
        }
      }
    }
    // Persisted order: durable rows read in the order history holds them
    // (a prompt is saved where the agent takes it, so it has no order to
    // keep); a row never saved right after the row it arrived after, while
    // that row is held.
    var last = -1;
    String? previous;
    for (final message in window.canonicalMessages) {
      if (_isPositionless(message)) continue;
      final key = _keyOf(message);
      if (message.type == AgentMessageType.userMessage) {
        previous = key;
        continue;
      }
      final at = position[key];
      if (at != null) {
        if (at < last) {
          metrics.outOfOrder += 1;
          anomaly('order', '$key (row $at) after row $last');
        }
        last = at;
      } else if (_liveOnlyAfter.containsKey(key)) {
        final after = _liveOnlyAfter[key];
        if (after != null && held.contains(after) && previous != after) {
          metrics.liveOnlyOutOfPlace += 1;
          anomaly(
            'liveOnlyPlace',
            '$key after $previous, arrived after $after',
          );
        }
      }
      previous = key;
    }
    final rows = window.messageCount;
    final bytes = window.estimatedBytes;
    if (rows > metrics.peakRows) metrics.peakRows = rows;
    if (bytes > metrics.peakBytes) metrics.peakBytes = bytes;
    final key = _protected;
    final readerPage = key == null
        ? null
        : window.pages
              .where((page) => !page.isTail && page.containsStableKey(key))
              .firstOrNull;
    // The budget's exceptions: the reader's page, and the newest cards still
    // waiting for an answer that the tail or a residue holds.
    final waiting = _waitingCards();
    if (waiting.length > metrics.maxCardsWaiting) {
      metrics.maxCardsWaiting = waiting.length;
    }
    final withdrawn = window.withdrawnRequestIds.length;
    if (withdrawn > metrics.maxCardsWithdrawn) {
      metrics.maxCardsWithdrawn = withdrawn;
    }
    var beyondRows = rows - (readerPage?.messages.length ?? 0);
    var beyondBytes = bytes - (readerPage?.estimatedBytes ?? 0);
    for (final page in window.pages) {
      if (!page.isTail && !page.isResidue) continue;
      for (final message in page.messages) {
        if (!waiting.contains(message.raw['requestId'])) continue;
        if (!_isCard(message)) continue;
        beyondRows -= 1;
        beyondBytes -= estimatedAgentMessageDecodedBytes(message);
      }
    }
    if (beyondRows > kMaxActiveTranscriptMessages ||
        beyondBytes > kMaxActiveTranscriptDecodedBytes) {
      anomaly('budget', '$beyondRows rows, $beyondBytes bytes beyond reader');
    }
    if (beyondRows > metrics.peakRowsBeyondReader) {
      metrics.peakRowsBeyondReader = beyondRows;
    }
    if (beyondBytes > metrics.peakBytesBeyondReader) {
      metrics.peakBytesBeyondReader = beyondBytes;
    }
  }
}

bool _isCard(AgentMessage message) =>
    message.type == AgentMessageType.permissionRequest ||
    message.type == AgentMessageType.questionRequest;

extension on MatrixClient {
  /// The request ids of the newest [kMaxPinnedActionableRequests] cards the
  /// window holds with no resolution held.
  /// The cards the window shows waiting, as many as it pins: those with no
  /// resolution held that this connection has not withdrawn.
  Set<String> _waitingCards() {
    final answered = <String>{...window.withdrawnRequestIds};
    final cards = <String>[];
    for (final page in window.pages) {
      for (final message in page.messages) {
        final id = message.raw['requestId'];
        if (id is! String) continue;
        if (message.type == AgentMessageType.permissionResolved ||
            message.type == AgentMessageType.questionResolved) {
          answered.add(id);
        } else if (_isCard(message)) {
          cards.add(id);
        }
      }
    }
    return {
      for (final id in cards.reversed)
        if (!answered.contains(id)) id,
    }.take(kMaxPinnedActionableRequests).toSet();
  }
}

/// Whose rows a [SimAgent] streams.
enum SimShape {
  /// A call and its result, a streamed reply saved once complete, a reading.
  claude,

  /// Reasoning and text saved as they stream (each part rewritten in place
  /// as it grows), a running tool saved as its call and its arguments filled
  /// in place, the call kept beside its result, and a run summary per step,
  /// `running` until the turn ends and then rewritten `done` in place.
  openCode,

  /// Claude's shape, with each step's reasoning streamed live and saved once
  /// complete under the key the live row has.
  codex,

  /// Claude's shape, with a live call history never holds: history keeps only
  /// the result.
  reasonix,
}

/// A running agent: each unit is a tool call and its result (persisted as
/// sent), a reply streamed in three growing chunks (persisted once complete)
/// and the unit's token reading (persisted, without a key). While a unit
/// runs, its reading is re-projected at the end of every read. Every
/// [approvalEvery] units an approval card (and every [questionEvery] units a
/// question card) arrives between the call and its result, which no history
/// ever holds, answered [answerAfter] units later (at once when 0); every
/// tenth unit restates the plan under one key, and every [errorEvery] units an
/// error card without a key is saved. Other agents stream their own [shape].
final class SimAgent {
  SimAgent(
    this.client, {
    this.approvalEvery = 25,
    this.errorEvery = 40,
    this.questionEvery = 0,
    this.answerAfter = 0,
    this.shape = SimShape.claude,
  });

  final MatrixClient client;
  final int approvalEvery;
  final int errorEvery;
  final int questionEvery;
  final int answerAfter;
  final SimShape shape;
  int _unit = 0;
  int _turn = 0;

  /// Answers due at the start of a unit, by unit.
  final Map<int, List<({String id, AgentMessage answer})>> _answers = {};

  /// This turn's step summaries (OpenCode).
  final List<String> _steps = [];

  static AgentMessage toolCall(int unit, {Map<String, Object?>? args}) =>
      AgentMessage.fromJson({
        'type': 'tool-call',
        'callId': 'c$unit',
        'toolName': 'Bash',
        'args': args ?? const <String, Object?>{},
      });

  static AgentMessage toolResult(int unit) => AgentMessage.fromJson({
    'type': 'tool-result',
    'callId': 'c$unit',
    'toolName': 'Bash',
    'result': 'ok $unit',
  });

  static AgentMessage reply(int unit, int chunks) => AgentMessage.fromJson({
    'type': 'model-output',
    'key': 't$unit',
    'text': 'reply $unit ${'x' * (40 * chunks)}',
  });

  static AgentMessage reasoning(String key, int chunks) =>
      AgentMessage.fromJson({
        'type': 'thinking',
        'key': key,
        'text': 'reasoning ${'y' * (30 * chunks)}',
      });

  static AgentMessage tokens(int unit, int stage) => AgentMessage.fromJson({
    'type': 'token-count',
    'input': unit * 10 + stage,
    'output': unit,
  });

  static AgentMessage plan(int unit) => AgentMessage.fromJson({
    'type': 'task-list-state',
    'key': 'plan',
    'items': [
      {'id': 'step', 'text': 'unit $unit', 'status': 'in_progress'},
    ],
  });

  static AgentMessage error(int unit) => AgentMessage.fromJson({
    'type': 'error',
    'message': 'rate limited before unit $unit',
  });

  static AgentMessage prompt(String key, {bool queued = false}) =>
      AgentMessage.fromJson({
        'type': 'user-message',
        'key': key,
        'text': 'prompt $key',
        if (queued) 'queued': true,
      });

  static AgentMessage runSummary(
    int turn, {
    required String key,
    required bool done,
  }) => AgentMessage.fromJson({
    'type': 'run-summary',
    'key': key,
    'turnId': 'turn-$turn',
    'status': done ? 'done' : 'running',
    if (done) 'completedAt': '2026-09-26T10:00:00Z',
    if (done) 'totalRuntimeMs': 1000 + turn,
  });

  /// Durable history the session already had: [units] complete units.
  void history(int units) {
    for (var index = 0; index < units; index++) {
      final unit = _unit++;
      client
        ..persistOnly(toolCall(unit))
        ..persistOnly(toolResult(unit))
        ..persistOnly(reply(unit, 3))
        ..persistOnly(tokens(unit, 3));
      if (unit % 10 == 0) client.persistOnly(plan(unit));
    }
  }

  /// One turn: a prompt (the one queued during the turn before, if any),
  /// [units] units, and the turn's run summary. A [lagged] prompt is saved
  /// only once the turn's first call is, as Claude writes it. With
  /// [queueFollowUp] a prompt is queued halfway through, which the next turn
  /// takes. [after] and [during] are as for [stream].
  Future<void> turn(
    int units, {
    bool lagged = false,
    bool queueFollowUp = false,
    Future<void> Function(int unit)? after,
    Future<void> Function(int unit)? during,
  }) async {
    final broker = client.broker;
    final turn = _turn++;
    final taken = broker.queued.keys.firstOrNull;
    if (taken != null) broker.queued.remove(taken);
    final opening = prompt(taken ?? 'u$turn');
    await client.turnStart();
    await client.live(opening, persist: !lagged);
    _steps.clear();
    await stream(
      units,
      during: (index) async {
        if (lagged && index == 0) client.persistOnly(opening);
        await during?.call(index);
      },
      after: (index) async {
        if (queueFollowUp && index == units ~/ 2) {
          final follow = prompt('q$turn', queued: true);
          broker.queued['q$turn'] = follow;
          await client.live(follow, persist: false, anchors: false);
        }
        await after?.call(index);
      },
    );
    if (shape == SimShape.openCode) {
      // The turn went idle: every step's summary is rewritten as done.
      for (final step in _steps) {
        await client.live(runSummary(turn, key: step, done: true));
      }
    } else {
      await client.live(runSummary(turn, key: 'run:$turn', done: true));
    }
    await client.turnEnd();
  }

  /// Streams [units] units live. While [client] is disconnected the rows
  /// still reach history; the client just never receives them. [during] runs
  /// while each unit's call is still running (the newest rows are the call and
  /// its reading), [after] after each unit, each with its index in this
  /// stream.
  Future<void> stream(
    int units, {
    Future<void> Function(int unit)? after,
    Future<void> Function(int unit)? during,
  }) async {
    final broker = client.broker;
    if (!broker.turnRunning) await client.turnStart();
    for (var index = 0; index < units; index++) {
      final unit = _unit++;
      await _answerDue(unit);
      if (errorEvery > 0 && unit % errorEvery == errorEvery - 1) {
        await client.live(error(unit));
      }
      switch (shape) {
        case SimShape.openCode:
          await _openCodeUnit(unit, () async => during?.call(index));
        case SimShape.claude || SimShape.codex || SimShape.reasonix:
          await _unitOf(unit, () async => during?.call(index));
      }
      await after?.call(index);
    }
  }

  Future<void> _unitOf(int unit, Future<void> Function() during) async {
    final broker = client.broker;
    if (shape == SimShape.codex) {
      final key = 'codex:turn-$_turn:item-$unit:r';
      await client.live(reasoning(key, 1), persist: false);
      await client.live(reasoning(key, 2), persist: false);
      client.persistOnly(reasoning(key, 2));
    }
    broker.projected = tokens(unit, 0);
    if (shape == SimShape.reasonix) {
      // History never holds this call; its result names it.
      await client.live(toolCall(unit), persist: false, liveOnly: true);
    } else {
      await client.live(toolCall(unit));
    }
    await client.live(broker.projected = tokens(unit, 1), persist: false);
    await during();
    await _cards(unit);
    await client.live(toolResult(unit));
    await client.live(broker.projected = tokens(unit, 2), persist: false);
    await client.live(reply(unit, 1), persist: false);
    await client.live(reply(unit, 2), persist: false);
    await client.live(reply(unit, 3), persist: false);
    client.persistOnly(reply(unit, 3));
    broker.projected = null;
    await client.live(tokens(unit, 3));
    if (unit % 10 == 0) await client.live(plan(unit));
  }

  Future<void> _openCodeUnit(int unit, Future<void> Function() during) async {
    final key = 'oc:$unit:r';
    await client.live(reasoning(key, 1));
    await client.live(reasoning(key, 2));
    await client.live(reply(unit, 1));
    await client.live(reply(unit, 2));
    await client.live(reply(unit, 3));
    await client.live(toolCall(unit));
    await during();
    await client.live(toolCall(unit, args: {'command': 'ls $unit'}));
    await _cards(unit);
    await client.live(toolResult(unit));
    final step = 'step:$unit';
    _steps.add(step);
    await client.live(runSummary(_turn, key: step, done: false));
  }

  /// The cards due at [unit], each waiting for its answer.
  Future<void> _cards(int unit) async {
    if (approvalEvery > 0 && unit % approvalEvery == approvalEvery - 1) {
      await _card(
        'p$unit',
        AgentMessage.fromJson({
          'type': 'permission-request',
          'requestId': 'p$unit',
          'title': 'Run Bash?',
        }),
        AgentMessage.fromJson({
          'type': 'permission-resolved',
          'requestId': 'p$unit',
          'decision': 'allow',
        }),
        unit,
      );
    }
    if (questionEvery > 0 && unit % questionEvery == questionEvery - 1) {
      await _card(
        'q$unit',
        AgentMessage.fromJson({
          'type': 'question-request',
          'requestId': 'q$unit',
          'question': 'Which one?',
        }),
        AgentMessage.fromJson({
          'type': 'question-resolved',
          'requestId': 'q$unit',
          'answer': 'the first',
        }),
        unit,
      );
    }
  }

  Future<void> _card(
    String id,
    AgentMessage request,
    AgentMessage answer,
    int unit,
  ) async {
    client.broker.pending[id] = request;
    await client.live(request, persist: false, liveOnly: true);
    if (answerAfter == 0) {
      client.broker.pending.remove(id);
      await client.live(answer, persist: false, liveOnly: true);
      return;
    }
    (_answers[unit + answerAfter] ??= []).add((id: id, answer: answer));
  }

  Future<void> _answerDue(int unit) async {
    for (final due
        in _answers.remove(unit) ??
            const <({String id, AgentMessage answer})>[]) {
      client.broker.pending.remove(due.id);
      await client.live(due.answer, persist: false, liveOnly: true);
    }
  }

  /// Answers every card still waiting.
  Future<void> answerAll() async {
    for (final unit in [..._answers.keys]..sort()) {
      await _answerDue(unit);
    }
  }
}

/// Reads the whole transcript back to its start and forward again, as a
/// person checking nothing is lost.
Future<void> _traverse(MatrixClient session) async {
  session.startTraversal();
  await session.readForward();
  await session.readBack();
  await session.readForward();
  session.endTraversal();
}

/// The ordinary-use scenarios. Each returns its metrics.
Future<Map<String, MatrixMetrics>> runOrdinaryUseMatrix({
  required bool revision28,
}) async {
  MatrixClient client() => MatrixClient(SimBroker(revision28: revision28));
  final results = <String, MatrixMetrics>{};

  // S1: a long turn streams while the reader is at the start of history.
  {
    final session = client();
    final agent = SimAgent(session)..history(100);
    await session.attach();
    await session.readBack();
    await agent.stream(700);
    await session.turnEnd();
    await _traverse(session);
    results['longStreamWhileReadingFarBack'] = session.metrics;
  }

  // S2: the socket drops every 60 units of a long turn, and each time the
  // agent persists 50 units the client never receives live.
  {
    final session = client();
    final agent = SimAgent(session)..history(100);
    await session.attach();
    await session.readBack(loads: 2);
    await agent.stream(
      600,
      after: (index) async {
        if (index % 60 != 59) return;
        await session.disconnect();
        await agent.stream(50);
        await session.reconnect();
      },
    );
    await session.turnEnd();
    await _traverse(session);
    results['repeatedReconnectCycles'] = session.metrics;
  }

  // S3: a long session read to its start and back to the latest row twice.
  {
    final session = client();
    SimAgent(session).history(1000);
    await session.attach();
    session.startTraversal();
    await session.readBack();
    await session.readForward();
    await session.readBack();
    await session.readForward();
    session.endTraversal();
    results['readReleaseReloadBothDirections'] = session.metrics;
  }

  // S4: an approval every fifth unit while the reader moves back and forth
  // through a streaming turn.
  {
    final session = client();
    final agent = SimAgent(session, approvalEvery: 5)..history(100);
    await session.attach();
    await agent.stream(
      500,
      after: (index) async {
        if (index % 100 == 49) await session.readBack(loads: 3);
        if (index % 100 == 99) await session.readForward();
      },
    );
    await session.turnEnd();
    session.startTraversal();
    await session.readBack();
    await session.readForward();
    session.endTraversal();
    results['approvalsWhileMovingBothWays'] = session.metrics;
  }

  // S5: an approval on every tool call of a long turn, read from the start.
  // More never-saved rows arrive than the budget can hold beside the rows
  // being read, so some give way — each release announced where it was.
  {
    final session = client();
    final agent = SimAgent(session, approvalEvery: 1)..history(100);
    await session.attach();
    await session.readBack();
    await agent.stream(400);
    await session.turnEnd();
    session.startTraversal();
    await session.readForward();
    await session.readBack();
    session.endTraversal();
    results['approvalOnEveryCallWhileReadingFarBack'] = session.metrics;
  }

  // S6: the socket drops and the hub resyncs while each unit's call is still
  // running, so the frames end at the running-turn hold and replay the held
  // call and the running reading after them.
  {
    final session = client();
    final agent = SimAgent(session)..history(100);
    await session.attach();
    await session.readBack(loads: 2);
    await agent.stream(
      300,
      during: (index) async {
        if (index % 20 == 9) {
          await session.disconnect();
          await session.reconnect();
        } else if (index % 20 == 19) {
          await session.resync();
        }
      },
      after: (index) async {
        if (index % 100 == 49) await session.readBack(loads: 3);
        if (index % 100 == 99) await session.readForward();
      },
    );
    await session.turnEnd();
    await _traverse(session);
    results['framesWhileACallRuns'] = session.metrics;
  }
  if (!revision28) return results;

  // S7: turns that open with a prompt: saved as sent, saved only after the
  // turn's first call (as Claude writes it), or queued during the turn before
  // and saved where the agent takes it. The reader moves and the socket drops
  // meanwhile.
  {
    final session = client();
    final agent = SimAgent(session, approvalEvery: 7)..history(100);
    await session.attach();
    await session.readBack(loads: 2);
    for (var turn = 0; turn < 12; turn++) {
      await agent.turn(
        30,
        lagged: turn % 3 == 1,
        queueFollowUp: turn % 4 == 2,
        during: (index) async {
          if (index == 15 && turn % 3 == 0) {
            await session.disconnect();
            await session.reconnect();
          }
        },
        after: (index) async {
          if (index == 10 && turn.isEven) await session.readBack(loads: 2);
          if (index == 20) await session.readForward();
        },
      );
    }
    await _traverse(session);
    results['promptsSavedLateOrQueued'] = session.metrics;
  }

  // S8: approvals and questions that wait fifteen units for an answer, across
  // refreshes, pages, a reconnect after rows the client never received live,
  // and the cards the broker restates after each attach.
  {
    final session = client();
    final agent = SimAgent(
      session,
      approvalEvery: 4,
      questionEvery: 9,
      answerAfter: 15,
    )..history(100);
    await session.attach();
    await agent.stream(
      300,
      after: (index) async {
        if (index % 50 == 25) await session.readBack(loads: 3);
        if (index % 50 == 49) await session.readForward();
        if (index % 70 == 69) {
          await session.disconnect();
          await agent.stream(10);
          await session.reconnect();
        }
      },
    );
    await agent.answerAll();
    await session.turnEnd();
    await _traverse(session);
    results['cardsWaitingAcrossFrames'] = session.metrics;
  }

  // S9-S11: other agents' shapes, over turns with a reconnect while a call
  // runs and a reader moving both ways.
  for (final (name, shape) in [
    ('openCodeStepsRewrittenInPlace', SimShape.openCode),
    ('codexReasoningKeyedAsHistory', SimShape.codex),
    ('reasonixCallsHistoryNeverHolds', SimShape.reasonix),
  ]) {
    final session = client();
    final agent = SimAgent(session, approvalEvery: 6, shape: shape)
      ..history(60);
    await session.attach();
    await session.readBack(loads: 2);
    for (var turn = 0; turn < 8; turn++) {
      await agent.turn(
        25,
        during: (index) async {
          if (index == 12) {
            await session.disconnect();
            await session.reconnect();
          }
        },
        after: (index) async {
          if (index == 6 && turn.isEven) await session.readBack(loads: 2);
          if (index == 18) await session.readForward();
        },
      );
    }
    await _traverse(session);
    results[name] = session.metrics;
  }

  // S12: the user rewinds the session to before the rows the window holds
  // at its end, then the agent carries on: the window's own cursor is gone.
  {
    final session = client();
    final agent = SimAgent(session)..history(150);
    await session.attach();
    await session.readBack(loads: 3);
    await agent.stream(40);
    await session.turnEnd();
    session.broker.rewind(session.broker.durable.length - 70);
    await agent.stream(
      60,
      after: (index) async {
        if (index == 30) await session.readBack(loads: 2);
      },
    );
    await session.turnEnd();
    await _traverse(session);
    results['rewoundWhileRead'] = session.metrics;
  }

  // S13: every third refresh fails to read, and the hub resyncs the socket
  // every 40 units, while the reader moves both ways.
  {
    final session = client();
    session.broker.nackEvery = 3;
    final agent = SimAgent(session, approvalEvery: 10)..history(100);
    await session.attach();
    await session.readBack(loads: 3);
    await agent.stream(
      300,
      after: (index) async {
        if (index % 40 == 20) await session.resync();
        if (index % 50 == 30) await session.readBack(loads: 2);
        if (index % 50 == 45) await session.readForward();
      },
    );
    await session.turnEnd();
    await _traverse(session);
    results['refusedRefreshesAndResyncs'] = session.metrics;
  }
  return results;
}
