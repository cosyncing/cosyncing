// Same-library coordinators intentionally access Notifier-owned state.
// ignore_for_file: invalid_use_of_protected_member
// ignore_for_file: invalid_use_of_visible_for_testing_member
part of '../detail/session_detail_controller.dart';

/// The report view holds the rows it does not draw as shells (see
/// [TranscriptHistoryWindow.prependPage]). Shown again, every page of shells
/// is released and reloads whole as the reader reaches it, except the page the
/// reader is on: one page asked for from its newer boundary replaces it, so
/// the reader stays on their row while the rows around it load. A request
/// that fails in passing is asked again, twice at most; should the page still
/// not come, the reader's page is released too.
extension _SessionDetailHiddenRowRestore on SessionDetailController {
  void _restoreHiddenRows() {
    _finishHiddenRowRefresh();
    final window = state.transcriptWindow;
    if (!window.holdsHiddenRowShells) return;
    final restored = window.releaseHiddenRowShells(
      keepKey: _hiddenRowConnection == null ? null : _historyViewportAnchorKey,
    );
    _adoptRestoredWindow(restored.window);
    final cursor = restored.refreshCursor;
    final limit = restored.refreshLimit;
    if (cursor == null || limit == null) return;
    _hiddenRowRefresh = (id: null, cursor: cursor, limit: limit, attempts: 0);
    _askHiddenRowRefresh();
  }

  SessionHistoryConnection? get _hiddenRowConnection =>
      state.connectionStatus == SessionDetailConnectionStatus.connected
      ? switch (_connection) {
          final SessionHistoryConnection value => value,
          _ => null,
        }
      : null;

  void _askHiddenRowRefresh() {
    final refresh = _hiddenRowRefresh;
    // Slot wakeups never shorten retry backoff or duplicate an active request.
    if (_disposed ||
        refresh == null ||
        refresh.id != null ||
        _hiddenRowRefreshTimer != null) {
      return;
    }
    if (state.historyPageLoading ||
        promptNavigationActive ||
        _toolSlotInFlight != null) {
      return;
    }
    final connection = _hiddenRowConnection;
    if (connection == null) {
      _giveUpHiddenRowRefresh();
      return;
    }
    final id = _nextHistoryNavigationId();
    _hiddenRowRefresh = (
      id: id,
      cursor: refresh.cursor,
      limit: refresh.limit,
      attempts: refresh.attempts,
    );
    _hiddenRowRefreshTimer = Timer(
      ref.read(sessionHistoryPageTimeoutProvider),
      () => _failHiddenRowRefresh(id, transient: true),
    );
    unawaited(
      connection
          .requestHistoryPage(
            cursor: refresh.cursor,
            limit: refresh.limit,
            clientMessageId: id,
          )
          .catchError((Object _) => _failHiddenRowRefresh(id, transient: true)),
    );
  }

  void _failHiddenRowRefresh(String id, {required bool transient}) {
    final refresh = _hiddenRowRefresh;
    if (refresh == null || refresh.id != id) return;
    _hiddenRowRefreshTimer?.cancel();
    if (!transient || refresh.attempts >= 2 || historyReportView) {
      _giveUpHiddenRowRefresh();
      return;
    }
    _hiddenRowRefresh = (
      id: null,
      cursor: refresh.cursor,
      limit: refresh.limit,
      attempts: refresh.attempts + 1,
    );
    _hiddenRowRefreshTimer = Timer(
      Duration(milliseconds: 500 * (1 << refresh.attempts)),
      () {
        _hiddenRowRefreshTimer = null;
        _askHiddenRowRefresh();
      },
    );
    _wakePromptNavigation();
  }

  bool _handleHiddenRowRefreshReply(WireEvent event) {
    final active = _hiddenRowRefresh;
    final id = active?.id;
    if (active == null || id == null) return false;
    if (event is NackWireEvent && event.clientMessageId == id) {
      _failHiddenRowRefresh(
        id,
        transient: isTransientHistoryPageErrorCode(event.code),
      );
      return true;
    }
    if (event is! HistoryPageWireEvent || event.clientMessageId != id) {
      return false;
    }
    _finishHiddenRowRefresh();
    var window = state.transcriptWindow
        .replaceHiddenRowShells(
          event,
          requestedCursor: active.cursor,
          preserveMessageKey: _historyViewportAnchorKey,
          inView: historyViewportRowKeys,
          reportView: historyReportView,
        )
        .window;
    // Refused, the reader's page reloads as any released range does.
    if (!historyReportView) window = window.releaseHiddenRowShells().window;
    _adoptRestoredWindow(window);
    return true;
  }

  void _giveUpHiddenRowRefresh() {
    _finishHiddenRowRefresh();
    if (_disposed || historyReportView) return;
    final window = state.transcriptWindow;
    if (!window.holdsHiddenRowShells) return;
    _adoptRestoredWindow(window.releaseHiddenRowShells().window);
  }

  void _finishHiddenRowRefresh() {
    _hiddenRowRefreshTimer?.cancel();
    _hiddenRowRefreshTimer = null;
    _hiddenRowRefresh = null;
    _wakePromptNavigation();
  }

  // The start of the session stays reached only while the window still
  // begins there (as every page frame decides it).
  void _adoptRestoredWindow(TranscriptHistoryWindow window) {
    if (identical(window, state.transcriptWindow)) return;
    state = state.copyWith(
      transcriptWindow: window,
      historyStartReached:
          state.historyStartReached &&
          window.olderHistoryCursor == null &&
          !window.leadingEdgeReleased,
    );
  }
}
