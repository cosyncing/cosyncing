// Same-library coordinators intentionally access Notifier-owned state.
// ignore_for_file: invalid_use_of_protected_member
// ignore_for_file: invalid_use_of_visible_for_testing_member
part of '../detail/session_detail_controller.dart';

/// Maximum requests in one explicit prompt search, including smaller retries.
const int kPromptNavigationPageLimit = 20;

/// One search never owns the history slot longer than this deadline.
const Duration kPromptNavigationDeadline = Duration(seconds: 30);

/// Outcome of a bounded search without changing the current viewport.
enum PromptNavigationOutcome {
  /// A page was adopted and its user row is ready to become the reader.
  found,

  /// The search reached the actual beginning without an earlier user row.
  start,

  /// A bounded walk can continue from the returned cursor.
  limited,

  /// The request failed; the result separately states whether it is retryable.
  failed,

  /// The reader, source, or connection superseded the intent.
  canceled,
}

/// Result and bounded measurements of one explicit prompt search.
class PromptNavigationResult {
  /// Creates one search result.
  const PromptNavigationResult(
    this.outcome, {
    this.messageKey,
    this.cursor,
    this.sourceCursor,
    this.requests = 0,
    this.scratchBytes = 0,
    this.retryable = false,
  });

  /// How the search ended.
  final PromptNavigationOutcome outcome;

  /// Canonical user row to re-center on after adoption.
  final String? messageKey;

  /// Validated boundary at which Retry or Continue resumes.
  final String? cursor;

  /// Boundary of the original rendered run, retained across Continue/Retry.
  final String? sourceCursor;

  /// Requests sent, including reduced-page retries.
  final int requests;

  /// Largest bounded decoded scratch page observed.
  final int scratchBytes;

  /// Whether retrying this failure can succeed without a source replacement.
  final bool retryable;
}

class _PromptNavigation {
  bool expired = false;
}

extension _SessionDetailPromptNavigation on SessionDetailController {
  void _rememberPromptBoundaries(
    Set<String> destination,
    Iterable<String> cursors,
  ) {
    destination.addAll(cursors);
    while (destination.length > kMaxActiveTranscriptMessages) {
      destination.remove(destination.first);
    }
  }

  Set<String> _visiblePromptKeys(TranscriptHistoryWindow window) {
    final projected = state.copyWith(transcriptWindow: window);
    return {
      for (final segment in projected.transcriptConversationSegments(
        ToolDisplayMode.responsive,
      ))
        for (final turn in segment.turns) ...[
          if (turn.userMessage case final message?)
            ?stableTranscriptMessageKey(message),
          for (final entry in turn.content)
            if (entry is MessageTranscriptDisplayEntry &&
                entry.message.type == AgentMessageType.userMessage &&
                (historyReportView || !transcriptRowBodyElided(entry.message)))
              ?stableTranscriptMessageKey(entry.message),
        ],
    };
  }

  void _wakePromptNavigation() {
    final waiting = _promptSlotChanged;
    _promptSlotChanged = null;
    if (waiting != null && !waiting.isCompleted) waiting.complete();
    scheduleMicrotask(() {
      if (_disposed || promptNavigationActive || state.historyPageLoading) {
        return;
      }
      if (_hiddenRowRefresh?.id == null && _hiddenRowRefresh != null) {
        _askHiddenRowRefresh();
      }
      _drainToolSlotReloads();
    });
  }

  void _cancelPromptNavigation() {
    _promptNavigation = null;
    _releasePromptNavigationWait();
  }

  void _releasePromptNavigationWait() {
    // Complete only the current request. Racing each reply against one
    // search-wide future would retain completed reply futures (and all their
    // decoded pages) on that future's listeners until the search ended.
    final reply = _promptPageReply;
    if (reply != null && !reply.isCompleted) reply.complete();
    _wakePromptNavigation();
  }

  bool _handlePromptNavigationReply(WireEvent event) {
    final reply = _promptPageReply;
    if (reply == null) return false;
    if (event is UnknownWireEvent &&
        event.kind == 'history-page' &&
        event.raw['clientMessageId'] != _historyPageRequestId) {
      // An unattributed/old malformed frame cannot settle a newer intent.
      // Its own request still has a bounded timeout.
      return true;
    }
    final matches = switch (event) {
      HistoryPageWireEvent(:final clientMessageId) =>
        clientMessageId == _historyPageRequestId,
      NackWireEvent(:final clientMessageId) =>
        clientMessageId == _historyPageRequestId,
      UnknownWireEvent(:final kind) => kind == 'history-page',
      _ => false,
    };
    if (!matches) return false;
    _promptPageReply = null;
    _clearHistoryPageTracking();
    state = state.copyWith(historyPageLoading: false);
    _wakePromptNavigation();
    if (!reply.isCompleted) reply.complete(event);
    return true;
  }

  Future<PromptNavigationResult> _findPreviousPrompt(
    String from, {
    String? sourceCursor,
  }) async {
    _cancelPromptNavigation();
    final search = _PromptNavigation();
    _promptNavigation = search;
    final timer = Timer(kPromptNavigationDeadline, () {
      if (!identical(_promptNavigation, search)) return;
      search.expired = true;
      _releasePromptNavigationWait();
    });
    var cursor = from;
    var requests = 0;
    var peakBytes = 0;
    var limit = kTranscriptHistoryPageMessages;
    final visited = <String>{};
    final crossedPageEnds = <String>{};
    // Reservation can release an already inspected, empty intervening page.
    // Keep only its cursor link, so proof/refusal still covers the widened
    // boundary afterward; never retain decoded pages on this search's stack.
    final emptyPageLinks = [
      for (final page in state.transcriptWindow.pages)
        if (!page.headReleased &&
            !page.isResidue &&
            page.olderCursor != null &&
            page.newerCursor != null &&
            !page.messages.any(
              (row) => row.type == AgentMessageType.userMessage,
            ))
          (older: page.olderCursor!, newer: page.newerCursor!),
    ];
    PromptNavigationResult result(
      PromptNavigationOutcome outcome, {
      String? key,
      bool retryable = false,
    }) {
      final boundaries = {from, sourceCursor ?? from, ...visited, cursor};
      var grew = true;
      while (grew) {
        grew = false;
        for (final link in emptyPageLinks) {
          if (boundaries.contains(link.older) && boundaries.add(link.newer)) {
            grew = true;
          }
        }
      }
      if (outcome == PromptNavigationOutcome.start) {
        _rememberPromptBoundaries(_promptStartCursors, boundaries);
      } else if (outcome == PromptNavigationOutcome.failed && !retryable) {
        _rememberPromptBoundaries(_promptFailedCursors, boundaries);
      }
      return PromptNavigationResult(
        outcome,
        messageKey: key,
        cursor: cursor,
        sourceCursor: sourceCursor ?? from,
        requests: requests,
        scratchBytes: peakBytes,
        retryable: retryable,
      );
    }

    bool getCanceled() => _disposed || !identical(_promptNavigation, search);
    try {
      while (!getCanceled()) {
        if (promptStartKnownAt(cursor)) {
          return result(PromptNavigationOutcome.start);
        }
        if (search.expired || requests >= kPromptNavigationPageLimit) {
          return result(PromptNavigationOutcome.limited);
        }
        if (state.connectionStatus != SessionDetailConnectionStatus.connected ||
            state.historyPagingBlockedAt(cursor) ||
            promptSearchBlockedAt(cursor) ||
            !canFindPreviousPrompt) {
          return result(
            PromptNavigationOutcome.failed,
            retryable:
                state.connectionStatus !=
                SessionDetailConnectionStatus.connected,
          );
        }
        if (state.historyPageLoading ||
            _hiddenRowRefresh?.id != null ||
            _toolSlotInFlight != null) {
          final wake = _promptSlotChanged ??= Completer<void>();
          await wake.future;
          continue;
        }
        // Reuse a page supplied by a prefetch already in flight on activation.
        final retained = state.transcriptWindow.pages
            .where(
              (page) =>
                  !page.isTail && !page.isResidue && page.newerCursor == cursor,
            )
            .firstOrNull;
        if (retained != null) {
          final visibleKeys = _visiblePromptKeys(state.transcriptWindow);
          final prompt = retained.messages.reversed
              .where(
                (message) =>
                    message.type == AgentMessageType.userMessage &&
                    visibleKeys.contains(stableTranscriptMessageKey(message)),
              )
              .firstOrNull;
          final key = prompt == null
              ? null
              : stableTranscriptMessageKey(prompt);
          if (key != null) {
            _historyViewportAnchorKey = key;
            return result(PromptNavigationOutcome.found, key: key);
          }
          crossedPageEnds.add(cursor);
          final next = retained.olderCursor;
          if (next == null) {
            return result(
              retained.headReleased
                  ? PromptNavigationOutcome.failed
                  : PromptNavigationOutcome.start,
            );
          }
          if (!visited.add(cursor) || visited.contains(next)) {
            return result(PromptNavigationOutcome.failed);
          }
          cursor = next;
          continue;
        }
        // The previous scratch page is out of scope before the next request.
        // Live mutations reserve the same allowance while this reader exists.
        state = state.copyWith(
          transcriptWindow: state.transcriptWindow.reservePromptNavigation(
            preserveMessageKey: _historyViewportAnchorKey,
            inView: historyViewportRowKeys,
          ),
        );
        final reply = Completer<WireEvent?>();
        _promptPageReply = reply;
        final id = _nextHistoryNavigationId();
        _historyPageRequestId = id;
        _historyPageCursorInFlight = cursor;
        _historyPageLimitInFlight = limit;
        _lastHistoryPageAwaitsReader = false;
        _startHistoryPageTimeout(id);
        state = state.copyWith(historyPageLoading: true);
        requests += 1;
        unawaited(
          (_connection! as SessionHistoryConnection)
              .requestHistoryPage(
                cursor: cursor,
                limit: limit,
                clientMessageId: id,
              )
              .catchError((Object _) {
                if (_historyPageRequestId != id) return;
                _clearHistoryPageTracking();
                if (!_disposed) {
                  state = state.copyWith(historyPageLoading: false);
                }
              }),
        );
        final answer = await reply.future;
        if (getCanceled()) return result(PromptNavigationOutcome.canceled);
        if (search.expired) {
          return result(PromptNavigationOutcome.limited);
        }
        if (answer is NackWireEvent) {
          if (answer.code == 'NOT_SUPPORTED') {
            _promptNavigationUnsupported = true;
          } else if (isHistoryCursorRefusalCode(answer.code)) {
            state = state.copyWith(
              historyRefusedCursors: {
                ...state.historyRefusedCursors,
                cursor: answer.code,
              },
            );
          } else if (isTerminalHistoryPageErrorCode(answer.code)) {
            state = state.copyWith(historyPageErrorCode: answer.code);
          }
          return result(
            PromptNavigationOutcome.failed,
            retryable: isTransientHistoryPageErrorCode(answer.code),
          );
        }
        if (answer is! HistoryPageWireEvent || answer.isNewer) {
          return result(
            PromptNavigationOutcome.failed,
            retryable: answer == null,
          );
        }
        if ((!answer.hasMore && !answer.endOfHistory) ||
            (answer.hasMore &&
                (answer.cursor == null ||
                    answer.cursor == cursor ||
                    visited.contains(answer.cursor)))) {
          return result(PromptNavigationOutcome.failed);
        }
        // Restore authority and bound oversized row bodies before retention.
        final page = [
          for (final message in answer.messages)
            boundTranscriptRow(
              state.transcriptWindow.questionState.restoreMessage(message),
            ),
        ];
        final bytes = page.fold<int>(
          0,
          (sum, message) => sum + estimatedAgentMessageDecodedBytes(message),
        );
        if (bytes > kPromptNavigationScratchBytes ||
            page.length > kPromptNavigationScratchRows) {
          if (limit <= 1) return result(PromptNavigationOutcome.failed);
          limit = limit ~/ 2;
          continue;
        }
        if (bytes > peakBytes) peakBytes = bytes;
        for (final prompt in page.reversed.where(
          (message) => message.type == AgentMessageType.userMessage,
        )) {
          final key = stableTranscriptMessageKey(prompt);
          if (key == null) return result(PromptNavigationOutcome.failed);
          final adopted = state.transcriptWindow.adoptPromptNavigationPage(
            messages: page,
            requestedCursor: cursor,
            olderCursor: answer.hasMore ? answer.cursor : null,
            targetKey: key,
            sourceCursor: sourceCursor ?? from,
            crossedPageEnds: crossedPageEnds,
          );
          if (!adopted.accepted) return result(PromptNavigationOutcome.failed);
          // Optimistic/acknowledged reconciliation and projection can omit a
          // canonical user frame. Never report a destination with no row.
          if (!_visiblePromptKeys(adopted.window).contains(key)) continue;
          _historyViewportAnchorKey = key;
          state = state.copyWith(
            transcriptWindow: adopted.window,
            historyStartReached:
                !answer.hasMore &&
                adopted.window.olderHistoryCursor == null &&
                !adopted.window.leadingEdgeReleased,
          );
          return result(PromptNavigationOutcome.found, key: key);
        }
        if (!answer.hasMore) return result(PromptNavigationOutcome.start);
        final scannedKeys = {
          for (final message in page) ?stableTranscriptMessageKey(message),
        };
        for (final held in state.transcriptWindow.pages) {
          if (held.newerCursor != null &&
              held.messages.any(
                (message) =>
                    scannedKeys.contains(stableTranscriptMessageKey(message)),
              )) {
            crossedPageEnds.add(held.newerCursor!);
          }
        }
        final next = answer.cursor;
        if (next == null ||
            next == cursor ||
            !visited.add(cursor) ||
            visited.contains(next)) {
          return result(PromptNavigationOutcome.failed);
        }
        cursor = next;
        // Keep a smaller fitting page size for the rest of this walk instead
        // of redownloading an oversized page at every older boundary.
      }
      return result(PromptNavigationOutcome.canceled);
    } finally {
      timer.cancel();
      if (identical(_promptNavigation, search)) _promptNavigation = null;
      _wakePromptNavigation();
    }
  }
}
