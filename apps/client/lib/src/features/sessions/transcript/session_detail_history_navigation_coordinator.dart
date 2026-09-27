// Same-library coordinators intentionally access Notifier-owned state.
// ignore_for_file: invalid_use_of_protected_member
// ignore_for_file: invalid_use_of_visible_for_testing_member
part of '../detail/session_detail_controller.dart';

/// Live rows past the tail's broker boundary that ask for a boundary refresh.
///
/// Well inside the open tail's allowance ([kMaxOpenTranscriptTailMessages]),
/// so the rows it names become a releasable block long before live growth
/// would have to release rows with no boundary.
const int kHistoryRefreshLiveRows = 50;

/// Decoded estimate of those live rows that asks for a refresh.
const int kHistoryRefreshLiveBytes = kMaxActiveTranscriptDecodedBytes ~/ 4;

/// After a refresh that named nothing new, how much more must arrive live
/// before the next one (or the turn must end).
const int kHistoryRefreshBackoffRows = 25;

/// The byte counterpart of [kHistoryRefreshBackoffRows].
const int kHistoryRefreshBackoffBytes = kMaxActiveTranscriptDecodedBytes ~/ 8;

/// Refreshes this socket keeps answerable at once, as the transport does: an
/// older one would be dropped there too.
const int _kMaxHistoryRefreshRequests = 64;

/// Refusals after which this attach never asks for a refresh again: the
/// session cannot serve one (unversioned or too large a source, or live rows
/// keyed differently from history), or the request itself was refused.
const Set<String> _terminalHistoryRefreshCodes = {
  'HISTORY_PAGE_SOURCE_UNVERSIONED',
  'HISTORY_PAGE_RESOURCE_LIMIT',
  'NOT_SUPPORTED',
  'BAD_PARAM',
  'BAD_CLIENT_MESSAGE_ID',
  'CLIENT_MESSAGE_FAILED',
};

/// Whether a boundary refresh is due for the [live] rows the tail received
/// past its broker boundary (see
/// [TranscriptHistoryNavigation.liveRowsWithoutBoundary]): enough of them
/// arrived, or the turn just ended. [backoff] is what was live
/// when the last refresh named nothing new; until the turn ends, the next one
/// waits for [kHistoryRefreshBackoffRows] rows (or
/// [kHistoryRefreshBackoffBytes]) more.
bool historyRefreshDue({
  required ({int rows, int bytes}) live,
  required bool turnEnded,
  ({int rows, int bytes})? backoff,
}) {
  if (live.rows == 0) return false;
  if (turnEnded) return true;
  if (live.rows < kHistoryRefreshLiveRows &&
      live.bytes < kHistoryRefreshLiveBytes) {
    return false;
  }
  return backoff == null ||
      live.rows >= backoff.rows + kHistoryRefreshBackoffRows ||
      live.bytes >= backoff.bytes + kHistoryRefreshBackoffBytes;
}

extension _SessionDetailHistoryNavigation on SessionDetailController {
  /// Whether this attach's broker pages newer history (contract revision 28:
  /// its last history frame carried `newerHistory`) and still does.
  bool get _canLoadNewerHistory =>
      _newerHistoryOffered &&
      !_newerPagingRefused &&
      _connection is SessionHistoryNavigationConnection;

  /// Starts a new wire connection epoch for revision-28 navigation: nothing
  /// is offered until this attach's first history frame says so, earlier
  /// refusals no longer apply, and that first frame is the reconnect's own
  /// answer. Only a tail whose block end a frame named can be kept against a
  /// capped one, so a window hydrated from the local snapshot is still
  /// replaced (see [TranscriptHistoryWindow.applyHistory]).
  void _startHistoryNavigationEpoch() {
    _clearToolSlotReloads();
    _clearHistoryRefreshTracking();
    // The attach a cursor recovery started may not start another.
    _historyCursorRecoveryUsed = _historyCursorRecoveryPending;
    _historyCursorRecoveryPending = false;
    _newerHistoryOffered = false;
    _newerPagingRefused = false;
    _historyRefreshDisabled = false;
    _historyRefreshBlockedCursor = null;
    _historyRefreshBackoff = null;
    _awaitingReconnectFrame = state.transcriptWindow.historyCursor != null;
  }

  /// Forgets every refresh: a new socket can answer none of them.
  void _clearHistoryRefreshTracking() {
    _historyRefreshRequests.clear();
    for (final timer in _historyRefreshTimeouts.values) {
      timer.cancel();
    }
    _historyRefreshTimeouts.clear();
    _historyRefreshesOverdue.clear();
    _historyRefreshTurnEndQueued = false;
  }

  /// Settles the refresh [clientMessageId]: it can no longer be answered.
  void _settleHistoryRefresh(String clientMessageId) {
    _historyRefreshRequests.remove(clientMessageId);
    _historyRefreshTimeouts.remove(clientMessageId)?.cancel();
    _historyRefreshesOverdue.remove(clientMessageId);
  }

  /// Whether a refresh from [cursor] is still awaited: asked, unanswered, and
  /// not yet overdue.
  bool _awaitsHistoryRefreshFrom(String cursor) =>
      _historyRefreshRequests.entries.any(
        (request) =>
            request.value == cursor &&
            !_historyRefreshesOverdue.contains(request.key),
      );

  /// After [sessionHistoryRefreshTimeoutProvider], the refresh
  /// [clientMessageId] no longer holds back the next one from its cursor: a
  /// read the broker never finishes answers nothing, not even a refusal. It
  /// counts as one that named nothing new, so the next waits for more live
  /// rows (or the turn's end). Its answer, should it come after all, is
  /// still taken: the transport takes it and moves its cursor, so dropping
  /// it here would leave its rows out of the window.
  void _startHistoryRefreshTimeout(String clientMessageId) {
    _historyRefreshTimeouts[clientMessageId] = Timer(
      ref.read(sessionHistoryRefreshTimeoutProvider),
      () {
        _historyRefreshTimeouts.remove(clientMessageId);
        if (_disposed ||
            !_historyRefreshRequests.containsKey(clientMessageId)) {
          return;
        }
        _historyRefreshesOverdue.add(clientMessageId);
        _historyRefreshBackoff = state.transcriptWindow.liveRowsWithoutBoundary;
      },
    );
  }

  /// The broker no longer has the window's own reconnect cursor, so no
  /// refresh from it can succeed, and the next reconnect would be refused
  /// too. A fresh attach from it is answered with a capped reset whose
  /// positions are valid, so the socket attaches again now — at most once
  /// per attach (never from the attach such a restart began), and not again
  /// within [sessionHistoryCursorRecoveryBackoffProvider] of the last one.
  void _recoverRefusedHistoryCursor() {
    if (_historyCursorRecoveryUsed || _historyCursorRecoveryCooldown != null) {
      return;
    }
    final navigation = switch (_connection) {
      final SessionHistoryNavigationConnection value => value,
      _ => null,
    };
    if (navigation == null) return;
    _historyCursorRecoveryUsed = true;
    _historyCursorRecoveryPending = true;
    _historyCursorRecoveryCooldown = Timer(
      ref.read(sessionHistoryCursorRecoveryBackoffProvider),
      () => _historyCursorRecoveryCooldown = null,
    );
    unawaited(
      navigation.restartAttach().catchError((Object _) {
        // The socket's own reconnect takes over; its attach is no recovery.
        _historyCursorRecoveryPending = false;
      }),
    );
  }

  /// Whether [event] answers a refresh this socket was asked, from the cursor
  /// the window still holds. Any other is moot: applying it would restate
  /// rows out of place.
  bool _acceptsHistoryRefreshAnswer(HistoryWireEvent event) {
    final id = event.clientMessageId;
    if (id == null) return false;
    final requestedFrom = _historyRefreshRequests[id];
    _settleHistoryRefresh(id);
    return !event.reset &&
        requestedFrom != null &&
        state.transcriptWindow.historyCursor == requestedFrom;
  }

  /// After a history frame left the window at [cursor]: every refresh asked
  /// from another cursor is settled. The transport delivers an answer only
  /// while the cursor it was asked from is still its own, which follows the
  /// frames the window applies, and drops any other without a word, so none
  /// of those could ever be answered. A [reset] settles every refresh: the
  /// transport drops any answer asked before one, even from a cursor the
  /// reset restores. A new frame also moves the live count a backoff was
  /// measured against, and a frame that is no refresh's answer ends that
  /// backoff.
  void _afterHistoryFrame(
    String? cursor, {
    required bool refreshAnswer,
    required bool reset,
  }) {
    [
      for (final request in _historyRefreshRequests.entries)
        if (reset || request.value != cursor) request.key,
    ].forEach(_settleHistoryRefresh);
    if (!refreshAnswer) _historyRefreshBackoff = null;
  }

  /// Backs off after a refresh answer that gave no live row a boundary: the
  /// rows without one were [before] it and are [after] it. It may have named
  /// nothing new, or restated rows the window cannot place (live rows it
  /// released with no boundary). Either way the same request would not help,
  /// so the next waits until more arrives live or the turn ends.
  void _onHistoryRefreshAnswered({
    required ({int rows, int bytes}) before,
    required ({int rows, int bytes}) after,
  }) {
    _historyRefreshBackoff = after.rows > 0 && after.rows >= before.rows
        ? after
        : null;
  }

  /// Whether [clientMessageId] names a refresh this socket may still answer.
  bool _isHistoryRefreshRequest(String? clientMessageId) =>
      clientMessageId != null &&
      _historyRefreshRequests.containsKey(clientMessageId);

  /// Settles a refused refresh by what the refusal says about retrying.
  void _onHistoryRefreshRefused(String clientMessageId, String code) {
    final cursor = _historyRefreshRequests[clientMessageId];
    _settleHistoryRefresh(clientMessageId);
    if (_terminalHistoryRefreshCodes.contains(code)) {
      _historyRefreshDisabled = true;
    } else if (isHistoryCursorRefusalCode(code)) {
      // No refresh from it can succeed; the next frame brings a new one. It
      // is the window's own reconnect cursor (a frame that moves the window
      // settles every refresh asked from another), so the socket attaches
      // again from it.
      _historyRefreshBlockedCursor = cursor;
      _recoverRefusedHistoryCursor();
    } else {
      _historyRefreshBackoff = state.transcriptWindow.liveRowsWithoutBoundary;
    }
  }

  /// Asks the broker to name boundaries for the rows this window received
  /// live since its last frame, once enough of them have arrived or the turn
  /// just ended (contract revision 28).
  ///
  /// Only from the window's own reconnect cursor, only while the attach's
  /// frames offer it, and never while a request from that cursor can still be
  /// answered: a slow answer is waited for rather than asked for twice, and a
  /// turn that ends meanwhile is remembered and asked for once it settles. The
  /// answer is an ordinary incremental frame: its rows become the tail's
  /// broker block, so the budget can later release them whole and reload them
  /// exactly instead of releasing live rows that no boundary reaches.
  void _maybeRequestHistoryRefresh({required bool turnEnded}) {
    if (!_newerHistoryOffered ||
        _historyRefreshDisabled ||
        state.connectionStatus != SessionDetailConnectionStatus.connected) {
      return;
    }
    final navigation = switch (_connection) {
      final SessionHistoryNavigationConnection value => value,
      _ => null,
    };
    if (navigation == null) return;
    final window = state.transcriptWindow;
    final cursor = window.historyCursor;
    if (cursor == null || cursor == _historyRefreshBlockedCursor) return;
    if (_awaitsHistoryRefreshFrom(cursor)) {
      if (turnEnded) _historyRefreshTurnEndQueued = true;
      return;
    }
    final due = historyRefreshDue(
      live: window.liveRowsWithoutBoundary,
      turnEnded: turnEnded || _historyRefreshTurnEndQueued,
      backoff: _historyRefreshBackoff,
    );
    // A turn end asks once for what arrived by then; with nothing left live
    // there is nothing to ask for.
    _historyRefreshTurnEndQueued = false;
    if (!due) return;
    final clientMessageId = _nextHistoryNavigationId();
    _historyRefreshRequests[clientMessageId] = cursor;
    _startHistoryRefreshTimeout(clientMessageId);
    while (_historyRefreshRequests.length > _kMaxHistoryRefreshRequests) {
      _settleHistoryRefresh(_historyRefreshRequests.keys.first);
    }
    void unsent() {
      if (!_historyRefreshRequests.containsKey(clientMessageId)) return;
      _settleHistoryRefresh(clientMessageId);
      // The transport no longer holds this cursor: the frame that moves it
      // brings the next one.
      _historyRefreshBlockedCursor = cursor;
    }

    unawaited(
      navigation
          .requestHistoryRefresh(
            cursor: cursor,
            clientMessageId: clientMessageId,
          )
          .then(
            (sent) {
              if (!sent) unsent();
            },
            onError: (Object _) => unsent(),
          ),
    );
  }

  /// Loads one page NEWER than [cursor] into the gap that ends at [until]
  /// (contract revision 28), sharing the older-page request slot: one page
  /// request of either direction is in flight at a time.
  Future<bool> _loadNewerHistoryCoordinated({
    required String cursor,
    required String until,
    int limit = kTranscriptHistoryPageMessages,
  }) async {
    if (!_canLoadNewerHistory || state.historyPageLoading) return false;
    if (state.historyPagingBlockedAt(cursor, until: until)) return false;
    if (cursor.trim().isEmpty || until.trim().isEmpty) return false;
    final navigation = switch (_connection) {
      final SessionHistoryNavigationConnection value => value,
      _ => null,
    };
    if (navigation == null ||
        state.connectionStatus != SessionDetailConnectionStatus.connected) {
      state = state.copyWith(
        historyPageErrorCode: 'HISTORY_PAGE_OFFLINE',
        historyPageError: const LocalizedFailure.notice(
          FailureLead.historyPageOffline,
        ),
      );
      return false;
    }
    // A released range reloads with exactly its own row count, so the page
    // ends on the range's newer boundary.
    final releasedRows = state.activeTranscriptWindow.forwardReloadLimitFor(
      cursor,
    );
    final requested = releasedRows != null && releasedRows < limit
        ? releasedRows
        : limit;
    final pageLimit = requested < 1 ? 1 : requested;
    final clientMessageId = _nextHistoryNavigationId();
    _historyPageRequestId = clientMessageId;
    _historyPageCursorInFlight = cursor;
    _historyPageLimitInFlight = pageLimit;
    _historyPageNewer = true;
    _historyPageUntilInFlight = until;
    _startHistoryPageTimeout(clientMessageId);
    state = state.copyWith(
      historyPageLoading: true,
      clearHistoryPageError: true,
    );
    try {
      await navigation.requestNewerHistoryPage(
        cursor: cursor,
        until: until,
        limit: pageLimit,
        clientMessageId: clientMessageId,
      );
      return true;
    } on Object catch (error) {
      if (_historyPageRequestId == clientMessageId) {
        _clearHistoryPageTracking();
        state = state.copyWith(
          historyPageLoading: false,
          historyPageErrorCode: 'HISTORY_PAGE_TRANSPORT',
          historyPageError: LocalizedFailure.from(
            error,
            lead: FailureLead.loadEarlierHistory,
          ),
        );
      }
      return false;
    }
  }
}
