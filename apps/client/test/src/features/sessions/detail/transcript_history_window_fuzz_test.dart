// Randomized sessions for the bounded transcript window (contract revision
// 28), against a simulated broker with the broker's cursor rules.
//
// Each session runs an agent (prompts sent live and saved late, streamed
// replies, tool calls with approvals, a restated plan, error cards, token
// readings) while the reader moves, pages load from either edge, boundary
// refreshes are answered late, and the socket drops and reconnects. The
// extended variants add prompts queued while a turn runs, cards answered
// many rows later (some while the socket is down), run summaries rewritten
// in place, readings the broker re-projects after its cursor, and live
// restatements of replies saved far back. After every change to the window
// the session checks that no row is held twice, the rows the window vouches
// for read in saved order, every range reloads exactly its rows, the window
// stays within its budget beyond the reader, no gap needs a reconnect, no
// row never saved leaves unannounced, no answer reads before its request,
// and no card waits that the broker no longer offers; at the end the reader
// reaches every saved row by scrolling up and then down.
//
// The seeds below each exposed a defect at some point, with a spread. Set
// COSYNCING_TRANSCRIPT_FUZZ_SEEDS to a count to run seeds 0 to count - 1
// instead, and COSYNCING_TRANSCRIPT_FUZZ_STEPS to change the 1,500 steps of
// each session.
import 'dart:io';
import 'dart:math';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_controller.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:flutter_test/flutter_test.dart';

bool _isState(AgentMessage m) =>
    m.type == AgentMessageType.taskListState ||
    m.type == AgentMessageType.status ||
    m.type == AgentMessageType.tokenCount ||
    m.type == AgentMessageType.runSummary;

/// A row's identity: its stable key, or for a keyless error card its content.
String? _identityOf(AgentMessage m) =>
    stableTranscriptMessageKey(m) ??
    (m.type == AgentMessageType.error
        ? 'keyless:error:${m.raw['message']}'
        : null);

final class _Sim {
  final durable = <AgentMessage>[];
  bool running = false;
  bool volatileTail = false;

  /// Where the cursor space ends: before the trailing run of token readings,
  /// at most 64 of them.
  int get cursorEnd {
    if (!volatileTail) return durable.length;
    var end = durable.length;
    while (end > 0 &&
        durable.length - end < 64 &&
        (durable[end - 1].type == AgentMessageType.tokenCount ||
            (durable[end - 1].type == AgentMessageType.runSummary &&
                durable[end - 1].raw['status'] != 'done'))) {
      end -= 1;
    }
    return end;
  }

  /// The rows the running-turn hold kept out of the last attach or
  /// reconnect frame.
  List<AgentMessage> held = const [];

  /// What follows an attach or reconnect frame before the live snapshot:
  /// the held rows, then the trailing volatile rows.
  List<AgentMessage> get replayed => [...held, ...durable.sublist(cursorEnd)];

  /// The running-turn hold: while a turn runs, a frame over rows
  /// from [start] to [end] stops before the newest row when it is streamed
  /// text, then before the tool calls just before it, never below [start].
  int holdEnd(int start, int end) {
    if (!running) return end;
    var stop = end;
    if (stop > start &&
        (durable[stop - 1].type == AgentMessageType.modelOutput ||
            durable[stop - 1].type == AgentMessageType.thinking)) {
      stop -= 1;
    }
    while (stop > start &&
        durable[stop - 1].type == AgentMessageType.toolCall) {
      stop -= 1;
    }
    return stop;
  }

  /// The row index a cursor names.
  static int b(String c) => int.parse(c.substring(1));

  int pageable(int from, int to) {
    var n = 0;
    for (var i = from; i < to; i++) {
      if (isBackwardPageableTranscriptMessage(durable[i])) n++;
    }
    return n;
  }

  HistoryWireEvent frame(
    int from,
    int through, {
    required bool reset,
    String? id,
    bool capped = false,
  }) {
    return HistoryWireEvent(
      messages: durable.sublist(from, through),
      reset: reset,
      cursor: 'r$through',
      olderCursor: reset && from > 0 ? 'b$from' : null,
      hasEarlier: reset && from > 0,
      endCursor: 'b$through',
      newerHistory: true,
      clientMessageId: id,
      truncated: capped
          ? HistoryTruncation(shown: through - from, total: through)
          : null,
    );
  }

  HistoryWireEvent attach() {
    final end = cursorEnd;
    final stop = holdEnd(0, end);
    held = durable.sublist(stop, end);
    final from = stop > 100 ? stop - 100 : 0;
    return frame(from, stop, reset: true, capped: from > 0);
  }

  HistoryWireEvent reconnect(String cursor) {
    final since = b(cursor);
    final end = cursorEnd;
    if (since > end) return attach();
    final stop = holdEnd(since, end);
    held = durable.sublist(stop, end);
    if (stop - since > 100) {
      return frame(stop - 100, stop, reset: true, capped: true);
    }
    return frame(since, stop, reset: false);
  }

  HistoryWireEvent refresh(String cursor, String id, int limit) {
    final since = b(cursor);
    final end = cursorEnd;
    final stop = min(since + limit, holdEnd(since, end));
    return frame(since, stop, reset: false, id: id);
  }

  HistoryPageWireEvent pageBefore(String cursor, int limit) {
    var at = b(cursor);
    final page = <AgentMessage>[];
    while (at > 0 && page.length < limit) {
      at -= 1;
      if (isBackwardPageableTranscriptMessage(durable[at])) {
        page.insert(0, durable[at]);
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
    final stop = b(until);
    var at = b(cursor);
    final page = <AgentMessage>[];
    while (at < stop && page.length < limit) {
      final m = durable[at];
      at += 1;
      if (isBackwardPageableTranscriptMessage(m)) page.add(m);
    }
    while (at < stop && !isBackwardPageableTranscriptMessage(durable[at])) {
      at += 1;
    }
    return HistoryPageWireEvent(
      messages: page,
      cursor: at == stop ? until : 'b$at',
      hasMore: at < cursorEnd,
      endOfHistory: at >= cursorEnd,
      isNewer: true,
    );
  }
}

final class _Violation implements Exception {
  _Violation(this.message);
  final String message;
  @override
  String toString() => message;
}

final class _Run {
  _Run(
    this.seed, {
    this.stateRows = true,
    this.approvals = true,
    this.lag = true,
    this.ext = false,
  }) : rng = Random(seed) {
    sim.volatileTail = ext;
  }
  final bool ext;

  /// Resolutions (and request updates) due after some agent steps.
  final scheduled = <({int due, AgentMessage message})>[];
  final persistedTexts = <String>[];

  /// Requests not yet answered, as the hub's pendingInput holds them (the
  /// latest version of each), replayed after every attach frame.
  final pendingRequests = <String, AgentMessage>{};

  /// Prompts queued while a turn ran, restated after every attach, taken
  /// (and saved) when the turn ends.
  final queuedPrompts = <AgentMessage>[];
  int turns = 0;
  String? runKey;
  final int seed;
  final Random rng;
  final bool stateRows;
  final bool approvals;
  final bool lag;
  final sim = _Sim();
  TranscriptHistoryWindow w = const TranscriptHistoryWindow.uninitialized();
  String? reading;
  bool connected = true;
  int liveSinceRefresh = 0;
  HistoryWireEvent? pendingAnswer;
  String? pendingFrom;
  int pendingDelay = 0;
  ({int rows, int bytes})? backoff;
  int ids = 0;
  int n = 0;
  final pendingPersist = <AgentMessage>[];
  final liveOnly = <String>{};
  final durableKeys = <String>{};
  final trace = <String>[];
  final pos = <String, int>{};
  int unexpectedStale = 0;
  int refreshes = 0;
  int newerPages = 0;
  int olderPages = 0;
  int catchUps = 0;
  final everSeen = <String>{};

  void log(String s) {
    trace.add(s);
    if (trace.length > 400) trace.removeAt(0);
  }

  AgentMessage text(String key, String t) =>
      AgentMessage.fromJson({'type': 'model-output', 'key': key, 'text': t});

  void persist(AgentMessage m) {
    final key = _identityOf(m) ?? 'state';
    if (!_isState(m)) {
      if (pos.containsKey(key)) throw _Violation('sim persisted $key twice');
      pos[key] = sim.durable.length;
      durableKeys.add(key);
    }
    sim.durable.add(m);
  }

  void deliver(AgentMessage m, {bool liveOnlyRow = false}) {
    if (ext) {
      final id = m.raw['requestId'];
      if (id is String) {
        if (m.type == AgentMessageType.permissionRequest) {
          pendingRequests[id] = m;
        } else if (m.type == AgentMessageType.permissionResolved) {
          pendingRequests.remove(id);
        }
      }
    }
    if (!connected) return;
    if (liveOnlyRow) liveOnly.add(stableTranscriptMessageKey(m)!);
    w = w.applyLiveMessage(m, protectedKey: reading);
    check('live ${_identityOf(m) ?? m.raw['type']}');
    liveSinceRefresh++;
    if (pendingAnswer != null && --pendingDelay <= 0) deliverAnswer();
    maybeRefresh(turnEnded: false);
  }

  void flushLag({bool all = false}) {
    while (pendingPersist.isNotEmpty && (all || rng.nextInt(3) == 0)) {
      persist(pendingPersist.removeAt(0));
    }
  }

  void runScheduled() {
    for (final item in [...scheduled]) {
      if (item.due <= n) {
        scheduled.remove(item);
        deliver(item.message, liveOnlyRow: true);
      }
    }
  }

  void agentStep() {
    final r = rng.nextInt(100);
    n++;
    if (ext) runScheduled();
    if (r < 10 && ext && sim.running && rng.nextBool()) {
      // A prompt sent while the turn runs: queued, saved when taken.
      final m = AgentMessage.fromJson({
        'type': 'user-message',
        'key': 'u$n',
        'text': 'prompt $n',
        'queued': true,
      });
      queuedPrompts.add(m);
      deliver(m);
    } else if (r < 10) {
      // A prompt: sent live now, saved now or some steps later.
      final m = AgentMessage.fromJson({
        'type': 'user-message',
        'key': 'u$n',
        'text': 'prompt $n',
      });
      if (lag && rng.nextBool()) {
        pendingPersist.add(m);
      } else {
        persist(m);
      }
      deliver(m);
      startTurn();
    } else if (r < 40) {
      // Streamed text: three chunks live, saved whole with the last.
      final key = 't$n';
      deliver(text(key, 'a'));
      deliver(text(key, 'ab'));
      final full = text(key, 'abc');
      persist(full);
      deliver(full);
      persistedTexts.add(key);
    } else if (r < 70) {
      final c = AgentMessage.fromJson({
        'type': 'tool-call',
        'callId': 'c$n',
        'toolName': 'Bash',
        'args': const <String, Object?>{},
      });
      persist(c);
      deliver(c);
      if (approvals && rng.nextInt(3) == 0) {
        final req = AgentMessage.fromJson({
          'type': 'permission-request',
          'requestId': 'p$n',
          'title': 'Run?',
        });
        deliver(req, liveOnlyRow: true);
        final res = AgentMessage.fromJson({
          'type': 'permission-resolved',
          'requestId': 'p$n',
          'decision': 'allow',
        });
        if (ext && rng.nextBool()) {
          // Answered later, possibly after many rows; sometimes the card is
          // restated (updated) before that.
          final later = n + 1 + rng.nextInt(80);
          if (rng.nextInt(3) == 0) {
            scheduled.add((
              due: n + 1 + rng.nextInt(later - n),
              message: AgentMessage.fromJson({
                'type': 'permission-request',
                'requestId': 'p$n',
                'title': 'Run? (updated)',
              }),
            ));
          }
          scheduled.add((due: later, message: res));
        } else {
          deliver(res, liveOnlyRow: true);
        }
      }
      final res = AgentMessage.fromJson({
        'type': 'tool-result',
        'callId': 'c$n',
        'toolName': 'Bash',
        'result': 'ok $n',
      });
      persist(res);
      deliver(res);
      if (ext) {
        final t = AgentMessage.fromJson({
          'type': 'token-count',
          'input': n,
          'output': n,
        });
        persist(t);
        deliver(t);
      }
    } else if (r < 78 && stateRows) {
      final s = AgentMessage.fromJson({
        'type': 'task-list-state',
        'key': 'plan',
        'status': 'running',
        'title': 'Plan',
        'items': [
          {'title': 'task $n', 'status': 'open'},
        ],
      });
      persist(s);
      deliver(s);
    } else if (r < 82) {
      // The turn ends.
      flushLag(all: true);
      endTurn();
      if (connected) {
        if (pendingAnswer != null) deliverAnswer();
        maybeRefresh(turnEnded: true);
        if (pendingAnswer != null) deliverAnswer();
      }
      if (queuedPrompts.isNotEmpty) {
        // The next turn takes the first queued prompt: saved where it is
        // taken, and sent live again without the flag.
        final queued = queuedPrompts.removeAt(0);
        final taken = AgentMessage.fromJson({
          for (final entry in queued.raw.entries)
            if (entry.key != 'queued') entry.key: entry.value,
        });
        persist(taken);
        deliver(taken);
        startTurn();
      }
    } else if (ext && r < 86) {
      final e = AgentMessage.fromJson({
        'type': 'error',
        'message': 'rate limited $n',
      });
      persist(e);
      deliver(e);
    } else if (ext && r < 88 && persistedTexts.isNotEmpty) {
      // A live restatement of a saved reply, possibly sealed far back.
      final key = persistedTexts[rng.nextInt(persistedTexts.length)];
      deliver(text(key, 'abc'));
    } else {
      final m = text('x$n', 'filler $n');
      persist(m);
      deliver(m);
    }
    if (lag) flushLag();
  }

  /// A turn starts: with [ext], its run summary is saved `running`.
  void startTurn() {
    if (sim.running) return;
    sim.running = true;
    if (!ext) return;
    final key = 'run:${turns++}';
    runKey = key;
    final summary = AgentMessage.fromJson({
      'type': 'run-summary',
      'key': key,
      'status': 'running',
    });
    persist(summary);
    deliver(summary);
  }

  /// The turn ends: its run summary is rewritten `done` in place (identity
  /// only, so no cursor moves) and sent live under the same key.
  void endTurn() {
    sim.running = false;
    final key = runKey;
    if (key == null) return;
    runKey = null;
    final done = AgentMessage.fromJson({
      'type': 'run-summary',
      'key': key,
      'status': 'done',
      'totalRuntimeMs': 1000 + n,
    });
    final at = sim.durable.indexWhere(
      (m) => stableTranscriptMessageKey(m) == stableTranscriptMessageKey(done),
    );
    if (at >= 0) sim.durable[at] = done;
    deliver(done);
  }

  void maybeRefresh({required bool turnEnded}) {
    if (!connected || pendingAnswer != null) return;
    final cursor = w.historyCursor;
    if (cursor == null) return;
    if (!historyRefreshDue(
      live: w.liveRowsWithoutBoundary,
      turnEnded: turnEnded,
      backoff: backoff,
    )) {
      return;
    }
    refreshes++;
    pendingFrom = cursor;
    pendingAnswer = sim.refresh(cursor, 'r${ids++}', 100);
    pendingDelay = rng.nextInt(6);
  }

  void deliverAnswer() {
    final a = pendingAnswer!;
    final from = pendingFrom;
    pendingAnswer = null;
    pendingFrom = null;
    if (w.historyCursor != from) return;
    final before = w.liveRowsWithoutBoundary;
    w = w.applyHistory(a, preserveMessageKey: reading);
    final after = w.liveRowsWithoutBoundary;
    // As the controller backs off after a refresh answer.
    backoff = after.rows > 0 && after.rows >= before.rows ? after : null;
    check('refresh answer from $from ${a.messages.length} rows -> ${a.cursor}');
  }

  void disconnect() {
    connected = false;
    pendingAnswer = null;
    pendingFrom = null;
    log('disconnect');
  }

  void reconnect() {
    connected = true;
    backoff = null;
    // The new connection's hello ends the last one's authority.
    w = w.invalidateQuestionAuthority();
    final cursor = w.historyCursor;
    final e = cursor == null ? sim.attach() : sim.reconnect(cursor);
    final catchUp =
        e.reset && e.gap == null && e.newerHistory && cursor != null;
    if (catchUp) catchUps++;
    w = w.applyHistory(e, preserveMessageKey: reading, catchUp: catchUp);
    check(
      'reconnect from $cursor reset=${e.reset} rows=${e.messages.length} '
      'older=${e.olderCursor} catchUp=$catchUp',
    );
    for (final m in [...sim.held, ...queuedPrompts]) {
      w = w.applyLiveMessage(m, protectedKey: reading);
      check('replayed ${m.raw['type']}');
    }
    for (final m in sim.durable.sublist(sim.cursorEnd)) {
      w = w.applyLiveMessage(m, protectedKey: reading);
      check('replayed ${m.raw['type']}');
    }
    // The hub's liveSnapshot replays cards still waiting for an answer.
    for (final m in pendingRequests.values) {
      liveOnly.add(stableTranscriptMessageKey(m)!);
      w = w.applyLiveMessage(m, protectedKey: reading);
      check('replayed pending ${stableTranscriptMessageKey(m)}');
    }
    // Once the replay is in, no card waits that the broker no longer has.
    if (ext) {
      final resolved = w.resolvedRequestDecisions;
      final withdrawn = w.withdrawnRequestIds;
      for (final p in w.pages) {
        for (final m in p.messages) {
          final id = m.raw['requestId'];
          if (m.type != AgentMessageType.permissionRequest || id is! String) {
            continue;
          }
          if (resolved.containsKey(id) || withdrawn.contains(id)) continue;
          if (!pendingRequests.containsKey(id)) {
            throw _Violation('card $id waits after the reconnect replay');
          }
        }
      }
    }
  }

  List<TranscriptHistoryGapSegment> reloadableGaps() => [
    for (final g in w.gaps)
      if (g.kind == TranscriptHistoryGapKind.reloadable) g,
  ];

  bool pageOp({bool preferForward = false}) {
    final gaps = reloadableGaps();
    final leading = w.olderHistoryCursor;
    final options = <int>[];
    if (gaps.isNotEmpty) options.add(0);
    if (leading != null && !w.leadingEdgeReleased) options.add(1);
    if (options.isEmpty) return false;
    final pick = options[rng.nextInt(options.length)];
    if (pick == 0) {
      final g = gaps[rng.nextInt(gaps.length)];
      final reload = g.reloadCursor!;
      final forward = g.forwardCursor;
      final onlyForward = w.reloadsOnlyForward(reload);
      final goForward =
          forward != null && (onlyForward || preferForward || rng.nextBool());
      if (goForward) {
        var limit = w.forwardReloadLimitFor(forward) ?? 100;
        for (var attempt = 0; attempt < 8; attempt++) {
          final page = sim.pageAfter(forward, reload, limit);
          final mut = w.insertNewerPage(
            page,
            requestedCursor: forward,
            until: reload,
            preserveMessageKey: reading,
          );
          if (mut.rejection == TranscriptHistoryPageRejection.overBudget &&
              limit > 1) {
            limit = max(1, limit ~/ 2);
            continue;
          }
          if (mut.rejection == TranscriptHistoryPageRejection.stale) {
            unexpectedStale++;
            log('STALE newer $forward..$reload');
            return true;
          }
          if (!mut.accepted) return true;
          w = mut.window;
          newerPages++;
          final landed = w.pages
              .where((p) => p.olderCursor == forward)
              .firstOrNull;
          // The budget is checked against the reader the page was fitted
          // for; the reader moves into the page afterwards.
          check(
            'newer $forward..$reload limit $limit -> ${page.cursor} '
            '(${page.messages.length})',
          );
          if (landed != null && landed.messages.isNotEmpty && rng.nextBool()) {
            reading = stableTranscriptMessageKey(landed.messages.last);
          }
          return true;
        }
        return true;
      }
      var limit = w.reloadLimitFor(reload) ?? 100;
      for (var attempt = 0; attempt < 8; attempt++) {
        final page = sim.pageBefore(reload, limit);
        final mut = w.prependPage(
          page,
          requestedCursor: reload,
          preserveMessageKey: reading,
        );
        if (mut.rejection == TranscriptHistoryPageRejection.overBudget &&
            limit > 1) {
          limit = max(1, limit ~/ 2);
          continue;
        }
        if (mut.rejection == TranscriptHistoryPageRejection.stale) {
          unexpectedStale++;
          log('STALE older $reload');
          return true;
        }
        if (!mut.accepted) return true;
        w = mut.window;
        olderPages++;
        final landed = w.pages
            .where((p) => p.newerCursor == reload)
            .firstOrNull;
        check(
          'older gap $reload limit $limit -> ${page.cursor} '
          '(${page.messages.length})',
        );
        if (landed != null && landed.messages.isNotEmpty && rng.nextBool()) {
          reading = stableTranscriptMessageKey(landed.messages.first);
        }
        return true;
      }
      return true;
    }
    var limit = w.reloadLimitFor(leading!) ?? 100;
    for (var attempt = 0; attempt < 8; attempt++) {
      final page = sim.pageBefore(leading, limit);
      final mut = w.prependPage(
        page,
        requestedCursor: leading,
        preserveMessageKey: reading,
      );
      if (mut.rejection == TranscriptHistoryPageRejection.overBudget &&
          limit > 1) {
        limit = max(1, limit ~/ 2);
        continue;
      }
      if (mut.rejection == TranscriptHistoryPageRejection.stale) {
        unexpectedStale++;
        log('STALE leading $leading');
        return true;
      }
      if (!mut.accepted) return true;
      w = mut.window;
      olderPages++;
      check('leading $leading limit $limit -> ${page.cursor}');
      if (w.pages.first.messages.isNotEmpty && rng.nextBool()) {
        reading = stableTranscriptMessageKey(w.pages.first.messages.first);
      }
      return true;
    }
    return true;
  }

  void moveReader() {
    final r = rng.nextInt(4);
    if (r == 0) {
      reading = null;
      log('reader follows tail');
      return;
    }
    final all = [
      for (final p in w.pages)
        for (final m in p.messages)
          if (!_isState(m)) ?stableTranscriptMessageKey(m),
    ];
    if (all.isEmpty) return;
    reading = all[rng.nextInt(all.length)];
    log('reader at $reading');
  }

  void check(String op) {
    log(op);
    final counts = <String, int>{};
    final order = <int>[];
    final orderKeys = <String>[];
    for (final p in w.pages) {
      final vouchedEnd = p.isTail
          ? (p.headReleased || p.blockRows == null ? 0 : p.blockRows!)
          : p.messages.length;
      final notVouched = p.isTail
          ? p.blockLiveOnlyRows.toSet()
          : p.isResidue
          ? {for (var i = 0; i < p.messages.length; i++) i}
          : p.liveOnlyRows.toSet();
      for (var i = 0; i < p.messages.length; i++) {
        final m = p.messages[i];
        final key = _identityOf(m);
        if (key == null) continue;
        everSeen.add(key);
        if (_isState(m)) continue;
        counts[key] = (counts[key] ?? 0) + 1;
        if (i >= vouchedEnd || notVouched.contains(i)) continue;
        if ((lag || ext) && m.type == AgentMessageType.userMessage) continue;
        final at = pos[key];
        if (at != null) {
          order.add(at);
          orderKeys.add(key);
        }
      }
    }
    for (final e in counts.entries) {
      if (e.value > 1) throw _Violation('held twice ${e.key} after $op');
    }
    for (var i = 1; i < order.length; i++) {
      if (order[i] < order[i - 1]) {
        throw _Violation(
          '${orderKeys[i - 1]} (saved at ${order[i - 1]}) reads '
          'before ${orderKeys[i]} (saved at ${order[i]}) after $op',
        );
      }
    }
    // Every range claims exactly the rows it reloads.
    for (final p in w.pages) {
      final end = p.isTail ? p.blockEndCursor : p.newerCursor;
      final count = p.isTail ? p.blockPageableRows : p.reloadLimit;
      if (end == null || count == null || p.isResidue || p.headReleased) {
        continue;
      }
      final from = p.olderCursor == null ? 0 : _Sim.b(p.olderCursor!);
      final to = _Sim.b(end);
      if (to < from) throw _Violation('inverted page $from..$to after $op');
      final real = sim.pageable(from, to);
      if (real != count) {
        throw _Violation(
          'page ${p.olderCursor}..$end claims $count, holds '
          '$real after $op',
        );
      }
    }
    for (final e in w.releasedRanges.entries) {
      final from = e.value.olderCursor == null
          ? 0
          : _Sim.b(e.value.olderCursor!);
      final to = _Sim.b(e.key);
      if (to < from) {
        throw _Violation(
          'released ${e.value.olderCursor}..${e.key} ends '
          'before it starts after $op',
        );
      }
      final c = e.value.pageableRows;
      if (c != null && c != sim.pageable(from, to)) {
        throw _Violation(
          'released ${e.value.olderCursor}..${e.key} claims $c '
          'holds ${sim.pageable(from, to)} after $op',
        );
      }
    }
    // Pages ordered by cursor.
    var last = -1;
    for (final p in w.pages) {
      final o = p.olderCursor == null ? 0 : _Sim.b(p.olderCursor!);
      if (o < last) {
        throw _Violation(
          'page older cursor ${p.olderCursor} before $last '
          'after $op',
        );
      }
      if (p.newerCursor != null) last = _Sim.b(p.newerCursor!);
      if (p.isTail && p.olderCursor != null) last = _Sim.b(p.olderCursor!);
    }
    // The budget beyond the reader's page.
    var readerRows = 0;
    var readerBytes = 0;
    final rk = reading;
    if (rk != null) {
      for (final p in w.pages) {
        if (!p.isTail && p.containsStableKey(rk)) {
          readerRows = p.messages.length;
          readerBytes = p.estimatedBytes;
        }
      }
    }
    // The pinned exemption: the newest 16 unanswered cards held
    // in the tail or a residue (not in a non-tail reader page).
    final answered = <String>{...w.withdrawnRequestIds};
    final waiting = <String>[];
    for (final p in w.pages) {
      for (final m in p.messages) {
        final id = m.raw['requestId'];
        if (id is! String) continue;
        if (m.type == AgentMessageType.permissionResolved) {
          answered.add(id);
        } else if (m.type == AgentMessageType.permissionRequest) {
          waiting.add(id);
        }
      }
    }
    final pinned = <String>{};
    for (final id in waiting.reversed) {
      if (answered.contains(id)) continue;
      pinned.add(id);
      if (pinned.length >= 16) break;
    }
    for (final p in w.pages) {
      if (!p.isTail && !p.isResidue) continue;
      if (rk != null && !p.isTail && p.containsStableKey(rk)) continue;
      for (final m in p.messages) {
        if (m.type == AgentMessageType.permissionRequest &&
            pinned.contains(m.raw['requestId'])) {
          readerRows += 1;
          readerBytes += estimatedAgentMessageDecodedBytes(m);
        }
      }
    }
    if (w.messageCount - readerRows > kMaxActiveTranscriptMessages) {
      throw _Violation(
        'rows beyond reader ${w.messageCount - readerRows} '
        'after $op',
      );
    }
    if (w.estimatedBytes - readerBytes > kMaxActiveTranscriptDecodedBytes) {
      throw _Violation('bytes beyond reader after $op');
    }
    final gaps = [?w.leadingGap, ...w.gaps];
    if (gaps.any((g) => g.kind == TranscriptHistoryGapKind.reconnectRequired)) {
      throw _Violation('a gap needs a reconnect after $op');
    }
    // No row never saved leaves unannounced.
    final announced =
        w.unsavedReleasedElsewhere ||
        w.pages.any((p) => p.isReleasedResidueMarker) ||
        gaps.any(
          (g) =>
              g.kind == TranscriptHistoryGapKind.unsavedReleased ||
              g.kind == TranscriptHistoryGapKind.reconnectRequired,
        );
    if (!announced) {
      final heldKeys = {
        for (final p in w.pages)
          for (final m in p.messages) ?stableTranscriptMessageKey(m),
      };
      for (final k in liveOnly) {
        if (!heldKeys.contains(k)) {
          throw _Violation('live-only $k gone silently after $op');
        }
      }
    }
    // No answer reads before its request.
    final flat = [
      for (final m in w.canonicalMessages) stableTranscriptMessageKey(m),
    ];
    for (var i = 0; i < flat.length; i++) {
      final k = flat[i];
      if (k != null && k.startsWith('permission-resolved:request:')) {
        final id = k.substring('permission-resolved:request:'.length);
        final req = flat.indexOf('permission-request:request:$id');
        if (req > i) {
          throw _Violation('resolution before request $id after $op');
        }
      }
    }
  }

  void finalTraversal() {
    flushLag(all: true);
    for (final queued in [...queuedPrompts]) {
      queuedPrompts.remove(queued);
      final taken = AgentMessage.fromJson({
        for (final entry in queued.raw.entries)
          if (entry.key != 'queued') entry.key: entry.value,
      });
      persist(taken);
      deliver(taken);
    }
    endTurn();
    if (!connected) reconnect();
    if (pendingAnswer != null) deliverAnswer();
    for (final item in [...scheduled]) {
      scheduled.remove(item);
      deliver(item.message, liveOnlyRow: true);
    }
    // Rows saved after the last frame reach the window through a reconnect.
    disconnect();
    reconnect();
    everSeen.clear();
    check('final start');
    // A. Up to the session start, reading the top row.
    var guard = 0;
    int? halved;
    while (guard++ < 400) {
      final leading = w.olderHistoryCursor;
      if (leading == null || w.leadingEdgeReleased) break;
      final limit = halved ?? (w.reloadLimitFor(leading) ?? 100);
      final page = sim.pageBefore(leading, limit);
      final mut = w.prependPage(
        page,
        requestedCursor: leading,
        preserveMessageKey: reading,
      );
      if (!mut.accepted) {
        if (mut.rejection == TranscriptHistoryPageRejection.overBudget &&
            limit > 1) {
          halved = max(1, limit ~/ 2);
          continue;
        }
        throw _Violation('final leading page refused ${mut.rejection}');
      }
      halved = null;
      w = mut.window;
      final firstKeyed = w.pages.first.messages
          .map(stableTranscriptMessageKey)
          .whereType<String>()
          .firstOrNull;
      if (firstKeyed != null) reading = firstKeyed;
      check('final leading $leading');
    }
    for (final p in w.pages) {
      final k = p.messages
          .map(stableTranscriptMessageKey)
          .whereType<String>()
          .firstOrNull;
      if (k != null) {
        reading = k;
        break;
      }
    }
    // B. Down through every gap, reading each page's last row.
    guard = 0;
    int? halvedB;
    while (guard++ < 2000) {
      final rk = reading;
      var readerAt = rk == null
          ? 0
          : w.pages.indexWhere((p) => p.containsStableKey(rk));
      if (readerAt < 0) readerAt = 0;
      TranscriptHistoryGapSegment? next;
      for (var i = readerAt; i + 1 < w.pages.length; i++) {
        final g = _gapBetween(w.pages[i], w.pages[i + 1]);
        if (g != null && g.kind == TranscriptHistoryGapKind.reloadable) {
          next = g;
          break;
        }
      }
      if (next == null) break;
      final forward = next.forwardCursor!;
      final reload = next.reloadCursor!;
      final limit = halvedB ?? (w.forwardReloadLimitFor(forward) ?? 100);
      final page = sim.pageAfter(forward, reload, limit);
      final mut = w.insertNewerPage(
        page,
        requestedCursor: forward,
        until: reload,
        preserveMessageKey: reading,
      );
      if (!mut.accepted) {
        if (mut.rejection == TranscriptHistoryPageRejection.overBudget &&
            limit > 1) {
          halvedB = max(1, limit ~/ 2);
          continue;
        }
        throw _Violation('final newer page refused ${mut.rejection}');
      }
      halvedB = null;
      w = mut.window;
      final landed = w.pages
          .where((p) => p.olderCursor == forward && !p.isResidue)
          .firstOrNull;
      final lastKeyed = landed?.messages
          .map(stableTranscriptMessageKey)
          .whereType<String>()
          .lastOrNull;
      if (lastKeyed != null) reading = lastKeyed;
      check('final newer $forward..$reload');
    }
    // Rows after the last gap are in the pages after the reader.
    final missing = [
      for (final k in durableKeys)
        if (!everSeen.contains(k)) k,
    ];
    if (missing.isNotEmpty) {
      throw _Violation(
        'final traversal missed ${missing.length} durable rows, '
        'e.g. ${missing.take(5).toList()} ${trace.last} (gaps '
        '${[?w.leadingGap, ...w.gaps].map((g) => g.kind.name).toList()})',
      );
    }
  }

  TranscriptHistoryGapSegment? _gapBetween(
    TranscriptHistoryPage a,
    TranscriptHistoryPage b,
  ) {
    for (final g in w.gaps) {
      if (g.reloadCursor != null &&
          g.reloadCursor == b.olderCursor &&
          g.forwardCursor == a.newerCursor) {
        return g;
      }
    }
    return null;
  }

  void step() {
    final r = rng.nextInt(100);
    if (r < 55) {
      agentStep();
    } else if (r < 75) {
      if (connected) pageOp(preferForward: rng.nextInt(3) == 0);
    } else if (r < 88) {
      moveReader();
    } else if (r < 94) {
      if (connected) {
        disconnect();
      } else {
        reconnect();
      }
    } else {
      if (!connected) {
        // While the socket is down, the agent keeps going.
        for (var i = 0; i < rng.nextInt(80); i++) {
          agentStep();
        }
      } else if (pendingAnswer != null) {
        deliverAnswer();
      }
    }
  }
}

/// What a session's agent and broker do beyond the ordinary.
enum _Variant {
  ordinary,
  noStateRows(stateRows: false),
  noApprovals(approvals: false),
  promptsSavedAsSent(lag: false),
  extended(ext: true),
  extendedSavedAsSent(ext: true, lag: false);

  const _Variant({
    this.stateRows = true,
    this.approvals = true,
    this.lag = true,
    this.ext = false,
  });

  /// Whether the agent restates its plan under one key.
  final bool stateRows;

  /// Whether calls wait for approvals.
  final bool approvals;

  /// Whether a prompt can be saved some steps after it was sent.
  final bool lag;

  /// Queued prompts, late answers, run summaries, re-projected readings,
  /// error cards and live restatements (see the file comment).
  final bool ext;
}

/// Seeds that exposed a defect at some point, in some variant.
const _regressionSeeds = [0, 1, 6, 14, 17, 19, 21, 36, 37, 39, 42, 99];

/// A spread of the rest.
const _spreadSeeds = [9, 27, 55, 71];

void main() {
  final environment = Platform.environment;
  final sweep = int.tryParse(
    environment['COSYNCING_TRANSCRIPT_FUZZ_SEEDS'] ?? '',
  );
  final steps =
      int.tryParse(environment['COSYNCING_TRANSCRIPT_FUZZ_STEPS'] ?? '') ??
      1500;
  for (final variant in _Variant.values) {
    final seeds = sweep != null
        ? [for (var seed = 0; seed < sweep; seed++) seed]
        : variant.ext
        ? [..._regressionSeeds, ..._spreadSeeds]
        : [..._regressionSeeds.take(4), ..._spreadSeeds];
    test('${variant.name}: ${seeds.length} sessions of $steps steps keep '
        'every invariant', () {
      final failures = <String>[];
      var refreshes = 0;
      var newerPages = 0;
      var olderPages = 0;
      var catchUps = 0;
      var stale = 0;
      for (final seed in seeds) {
        final run = _Run(
          seed,
          stateRows: variant.stateRows,
          approvals: variant.approvals,
          lag: variant.lag,
          ext: variant.ext,
        );
        run.w = run.w.applyHistory(run.sim.attach());
        try {
          for (var index = 0; index < steps; index++) {
            run.step();
          }
          run.finalTraversal();
        } on _Violation catch (violation) {
          final trace = run.trace.skip(max(0, run.trace.length - 25));
          failures.add(
            'seed $seed: $violation\n  after:\n    ${trace.join('\n    ')}',
          );
        }
        refreshes += run.refreshes;
        newerPages += run.newerPages;
        olderPages += run.olderPages;
        catchUps += run.catchUps;
        stale += run.unexpectedStale;
      }
      expect(
        failures,
        isEmpty,
        reason:
            '${failures.length} of ${seeds.length} sessions failed; the '
            'first:\n\n${failures.take(3).join('\n\n')}',
      );
      // The sessions exercised what they are for.
      expect(refreshes, greaterThan(seeds.length));
      expect(newerPages, greaterThan(seeds.length));
      expect(olderPages, greaterThan(seeds.length));
      expect(catchUps, greaterThan(0));
      expect(stale, 0, reason: 'pages refused as stale');
    });
  }
}
