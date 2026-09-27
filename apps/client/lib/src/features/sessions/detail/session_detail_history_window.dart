part of 'session_detail_state.dart';

// The bounded, recoverable transcript history window.
//
// One window is the only owner of decoded transcript rows for an open session.
// It holds cursor-bounded pages plus one open tail, and after EVERY mutation it
// fits one count and decoded-byte budget. Releasing rows to stay inside that
// budget must leave a broker boundary behind so the range reloads through
// ordinary backward paging; only rows delivered live since the last broker
// boundary can ever be released without one, and that is surfaced as a
// reconnect-required range rather than hidden.

/// Rows the open tail may hold: the window budget less one history page, so
/// an older page always has room beside a full tail.
const int kMaxOpenTranscriptTailMessages =
    kMaxActiveTranscriptMessages - kTranscriptHistoryPageMessages;

/// Decoded estimate the open tail may hold, leaving a quarter of the window
/// budget for older pages.
const int kMaxOpenTranscriptTailDecodedBytes =
    kMaxActiveTranscriptDecodedBytes - kMaxActiveTranscriptDecodedBytes ~/ 4;

/// A single row whose decoded estimate exceeds this keeps a readable,
/// flagged prefix of its body instead of crowding out the whole window.
const int kMaxTranscriptRowDecodedBytes = kMaxActiveTranscriptDecodedBytes ~/ 4;

/// Decoded estimate an over-sized row's body is shortened to.
const int kShortenedTranscriptRowDecodedBytes =
    kMaxActiveTranscriptDecodedBytes ~/ 8;

/// Decoded estimate a sealed page may reach by joining the next sealed block:
/// half the window, the share the broker gives one history frame. A joined
/// page can be the reader's page, which no release touches, so it stays
/// bounded like one frame.
const int kMaxJoinedTranscriptPageDecodedBytes =
    kMaxActiveTranscriptDecodedBytes ~/ 2;

/// Released ranges remembered so a reload can request exactly their rows.
const int kMaxReleasedTranscriptRanges = 128;

/// Row types the broker's backward pages never carry (latest-wins state and
/// reset markers). Mirrors the broker's page walk, which counts only the other
/// types toward a page's limit.
const Set<String> _nonPageableHistoryTypes = {
  'task-list-state',
  'goal-state',
  'metadata-update',
  'agent-activity',
  'history-reset',
};

/// Whether a backward history page can carry [message].
bool isBackwardPageableTranscriptMessage(AgentMessage message) {
  final rawType = message.raw['type'];
  final type = rawType is String && rawType.isNotEmpty
      ? rawType
      : message.type.wireValue;
  return !_nonPageableHistoryTypes.contains(type);
}

int _pageableRowCount(List<AgentMessage> messages) {
  var count = 0;
  for (final message in messages) {
    if (isBackwardPageableTranscriptMessage(message)) count++;
  }
  return count;
}

int _estimatedMessagesBytes(Iterable<AgentMessage> messages) {
  var bytes = 0;
  for (final message in messages) {
    bytes += estimatedAgentMessageDecodedBytes(message);
  }
  return bytes;
}

/// [message], with its body shortened when the row alone would exceed
/// [kMaxTranscriptRowDecodedBytes].
///
/// Only the families the broker may shorten (`model-output`, `thinking`,
/// `user-message`) are shortened, and only their `text`; the row keeps its
/// shape and is flagged `bodyTruncated` so the renderer says so. Later
/// streamed deltas are ignored until a full-text restatement (see
/// [mergeStableTranscriptMessage]), because appending to a shortened body
/// would present text that was never contiguous. Every other type is kept
/// whole: its shape cannot be shortened safely.
AgentMessage boundTranscriptRow(AgentMessage message) {
  if (message.type != AgentMessageType.modelOutput &&
      message.type != AgentMessageType.thinking &&
      message.type != AgentMessageType.userMessage) {
    return message;
  }
  final text = message.raw['text'];
  if (text is! String) return message;
  final bytes = estimatedAgentMessageDecodedBytes(message);
  if (bytes <= kMaxTranscriptRowDecodedBytes) return message;
  final textBytes = 24 + text.length * 2;
  final overhead = bytes - textBytes;
  var keep = (kShortenedTranscriptRowDecodedBytes - overhead - 24) ~/ 2;
  if (keep < 0) keep = 0;
  if (keep > text.length) keep = text.length;
  if (keep > 0 && keep < text.length) {
    final last = text.codeUnitAt(keep - 1);
    if (last >= 0xD800 && last <= 0xDBFF) keep--;
  }
  final raw = <String, dynamic>{...message.raw}
    ..['text'] = text.substring(0, keep)
    ..['bodyTruncated'] = true
    ..remove('delta');
  return AgentMessage(
    type: message.type,
    id: message.id,
    seq: message.seq,
    parentId: message.parentId,
    timestamp: message.timestamp,
    raw: raw,
  );
}

const Object _unchanged = Object();

/// One decoded, cursor-bounded native history page.
@immutable
final class TranscriptHistoryPage {
  /// Creates one immutable page with optional precomputed byte accounting.
  TranscriptHistoryPage({
    required List<AgentMessage> messages,
    required this.olderCursor,
    required this.newerCursor,
    required this.isTail,
    int? estimatedBytes,
    this.headReleased = false,
    this.reloadLimit,
    this.sealedFromTail = false,
    this.blockRows,
    this.blockEndCursor,
    this.blockPageableRows,
    this.blockLiveOnlyRows = const [],
    this.liveOnlyRows = const [],
    this.residueAnchors,
    this.shedKeys = const [],
    this.shedUnverifiable = false,
  }) : messages = List<AgentMessage>.unmodifiable(messages),
       estimatedBytes = estimatedBytes ?? _estimatedMessagesBytes(messages);

  /// Canonical messages in native chronological order.
  final List<AgentMessage> messages;

  /// Opaque cursor immediately before this page, when more history exists.
  final String? olderCursor;

  /// Opaque cursor immediately after this page; null for the recent tail.
  final String? newerCursor;

  /// Whether this is the separately retained newest tail.
  final bool isTail;

  /// Conservative decoded-size estimate maintained at mutation time.
  final int estimatedBytes;

  /// Rows between [olderCursor] and this page's first row were released
  /// locally, and no broker boundary reaches them. The range before this page
  /// can only be recovered by a reconnect, and is presented that way.
  final bool headReleased;

  /// Backward-pageable rows this page stands for, so a reload after release
  /// can request exactly them. Null when unknown.
  final int? reloadLimit;

  /// Whether this page was split out of the open tail to keep the reader's row
  /// while newer rows arrived.
  final bool sealedFromTail;

  /// Open tail only: how many leading rows are exactly the broker range from
  /// [olderCursor] to [blockEndCursor]. Null when the tail cannot vouch for it.
  final int? blockRows;

  /// Open tail only: the backward cursor at the end of the newest history
  /// frame, which is also the reconnect position of the tail's live rows.
  final String? blockEndCursor;

  /// Open tail only: backward-pageable raw rows inside the block.
  final int? blockPageableRows;

  /// Open tail only: ascending indices, inside `[0, blockRows)`, of retained
  /// rows the block's reload would not return — a live row not yet persisted,
  /// a live-only row such as an approval card, an overlay. They keep their
  /// reconciled position among the block's rows, and releasing the block keeps
  /// them at the head of the tail instead of dropping them.
  final List<int> blockLiveOnlyRows;

  /// Older pages only: ascending indices of rows this page's reload would not
  /// return (the live-only rows sealed with a block, or woven back into a
  /// reloaded range). Releasing the page keeps them as a residue.
  final List<int> liveOnlyRows;

  /// Set on a residue: the rows kept when a page holding rows no reload can
  /// return was released. It sits, zero-width, at the released range's newer
  /// boundary, so the reloadable gap stays before it; each entry is the
  /// anchor of the reloadable row its row followed (null: the range's first
  /// rows; see [_anchorAfter]), so an exact reload weaves the rows back into
  /// place.
  final List<String?>? residueAnchors;

  /// Open tail only: keys of the live rows released from the head since the
  /// block's release. A frame from the block end heals the release only when
  /// it restates every one of them.
  final List<String> shedKeys;

  /// Open tail only: a released head row had no key, or too many were
  /// released, so no frame can prove it restates them all.
  final bool shedUnverifiable;

  /// Whether this page is a residue (see [residueAnchors]).
  bool get isResidue => residueAnchors != null;

  /// Whether this page only marks where a residue's rows were released: the
  /// gap before it needs a reconnect.
  bool get isReleasedResidueMarker =>
      !isTail && headReleased && messages.isEmpty;

  /// Whether this page contains [key], with optional work instrumentation.
  bool containsStableKey(String key, {TranscriptHistoryWorkCounter? work}) =>
      indexOfStableKey(key, work: work) >= 0;

  /// Index of the row with [key], or -1.
  int indexOfStableKey(String key, {TranscriptHistoryWorkCounter? work}) {
    for (var index = 0; index < messages.length; index++) {
      work?.inspectedMessages += 1;
      if (stableTranscriptMessageKey(messages[index]) == key) return index;
    }
    return -1;
  }

  TranscriptHistoryPage _copyWith({
    List<AgentMessage>? messages,
    int? estimatedBytes,
    Object? olderCursor = _unchanged,
    Object? newerCursor = _unchanged,
    bool? isTail,
    bool? headReleased,
    Object? reloadLimit = _unchanged,
    bool? sealedFromTail,
    Object? blockRows = _unchanged,
    Object? blockEndCursor = _unchanged,
    Object? blockPageableRows = _unchanged,
    List<int>? blockLiveOnlyRows,
    List<int>? liveOnlyRows,
    List<String>? shedKeys,
    bool? shedUnverifiable,
    List<String?>? residueAnchors,
  }) => TranscriptHistoryPage(
    messages: messages ?? this.messages,
    estimatedBytes: messages == null ? this.estimatedBytes : estimatedBytes,
    olderCursor: identical(olderCursor, _unchanged)
        ? this.olderCursor
        : olderCursor as String?,
    newerCursor: identical(newerCursor, _unchanged)
        ? this.newerCursor
        : newerCursor as String?,
    isTail: isTail ?? this.isTail,
    headReleased: headReleased ?? this.headReleased,
    reloadLimit: identical(reloadLimit, _unchanged)
        ? this.reloadLimit
        : reloadLimit as int?,
    sealedFromTail: sealedFromTail ?? this.sealedFromTail,
    blockRows: identical(blockRows, _unchanged)
        ? this.blockRows
        : blockRows as int?,
    blockEndCursor: identical(blockEndCursor, _unchanged)
        ? this.blockEndCursor
        : blockEndCursor as String?,
    blockPageableRows: identical(blockPageableRows, _unchanged)
        ? this.blockPageableRows
        : blockPageableRows as int?,
    // An emptied or unknown block has no rows to keep.
    blockLiveOnlyRows:
        blockLiveOnlyRows ??
        (identical(blockRows, _unchanged) || ((blockRows as int?) ?? 0) > 0
            ? this.blockLiveOnlyRows
            : const []),
    // Rows only ever change in place or lose a suffix here.
    liveOnlyRows:
        liveOnlyRows ??
        (messages == null
            ? this.liveOnlyRows
            : [
                for (final index in this.liveOnlyRows)
                  if (index < messages.length) index,
              ]),
    residueAnchors:
        residueAnchors ??
        (this.residueAnchors == null || messages == null
            ? this.residueAnchors
            : this.residueAnchors!.take(messages.length).toList()),
    shedKeys: shedKeys ?? this.shedKeys,
    shedUnverifiable: shedUnverifiable ?? this.shedUnverifiable,
  );
}

/// Why a decoded range is absent between two retained transcript segments.
enum TranscriptHistoryGapKind {
  /// The newer segment carries an opaque boundary that can reload the gap.
  reloadable,

  /// Locally evicted live rows require a fresh attach to recover.
  reconnectRequired,

  /// Rows that were never saved (a resolved approval card, for example) were
  /// released here to fit the budget. They are not in the session's history,
  /// so neither a reload nor a reconnect can bring them back; the notice says
  /// so rather than offering a recovery that cannot work.
  unsavedReleased,
}

/// Explicit UI/model boundary for omitted decoded messages.
@immutable
final class TranscriptHistoryGapSegment {
  /// Creates an explicit omitted-range boundary.
  const TranscriptHistoryGapSegment({
    required this.id,
    required this.kind,
    this.reloadCursor,
    this.forwardCursor,
  });

  /// Stable row identity.
  final String id;

  /// Whether this gap can be filled with a page or needs reattach.
  final TranscriptHistoryGapKind kind;

  /// Opaque newer-edge cursor for one backward reload page.
  final String? reloadCursor;

  /// Opaque older-edge cursor for one newer page into the gap (contract
  /// revision 28), stopping at [reloadCursor]: the boundary after the run
  /// before the gap. Null when that run ends with no broker boundary.
  final String? forwardCursor;
}

/// One cached cursor-contiguous conversation run plus any omitted range before
/// it.
///
/// Page identities survive live tail replacement, so unchanged older
/// [turns] are reused by the production transcript widget rather than rebuilt
/// from the complete active history window.
@immutable
final class TranscriptConversationSegment {
  /// Creates one renderable contiguous-run projection.
  const TranscriptConversationSegment({
    required this.turns,
    this.gapBefore,
  });

  /// Cached conversation turns for this contiguous page run and display mode.
  final List<ConversationTurn> turns;

  /// Explicit missing range before this run.
  final TranscriptHistoryGapSegment? gapBefore;
}

/// Why an older page was not accepted.
enum TranscriptHistoryPageRejection {
  /// The page was accepted.
  none,

  /// The requested boundary is no longer in the window (a replacement or a
  /// release raced the request). Nothing is wrong; the page is simply moot.
  stale,

  /// The page cannot fit beside the rows the window must keep. A smaller
  /// page may.
  overBudget,

  /// The page brought no rows and ends where it was asked from, with more
  /// said to follow: it moves nothing, so taking it would only add an empty
  /// page at the same boundary, and asking again at once would get the same
  /// answer. It is retried like a failure that can pass.
  noProgress,
}

/// Whether [event], a page asked for from [requestedCursor], brought no rows
/// and ends there with more to come: it moves no boundary.
bool _pageMakesNoProgress(HistoryPageWireEvent event, String requestedCursor) =>
    event.messages.isEmpty && event.hasMore && event.cursor == requestedCursor;

/// Result of accepting one older page into the active decoded window.
@immutable
final class TranscriptHistoryPageMutation {
  /// Creates an insertion result.
  const TranscriptHistoryPageMutation({
    required this.window,
    this.rejection = TranscriptHistoryPageRejection.none,
    this.adoptedSessionStart = false,
  });

  /// Updated window. Identical to the input when not [accepted].
  final TranscriptHistoryWindow window;

  /// Why the page was refused, or [TranscriptHistoryPageRejection.none].
  final TranscriptHistoryPageRejection rejection;

  /// Whether the page restored a released range that began at the start of
  /// the session. The broker's walk stops once it has the requested rows, so a
  /// session that opens with state rows answers such a reload with more
  /// history to come; the released range still knows it is the start.
  final bool adoptedSessionStart;

  /// Whether the page fit and matched an existing opaque boundary.
  bool get accepted => rejection == TranscriptHistoryPageRejection.none;
}

/// A range released to fit the budget, keyed in the window by the boundary
/// after it (the cursor a reload pages backward from).
@immutable
final class TranscriptReleasedRange {
  /// Creates a released-range descriptor.
  const TranscriptReleasedRange({
    required this.olderCursor,
    required this.pageableRows,
  });

  /// The boundary before the released rows (null at the session start).
  final String? olderCursor;

  /// Backward-pageable rows in the range; null when unknown.
  final int? pageableRows;
}

/// Explicit bounded transcript page table.
///
/// Pages stay in chronological order. Cursor equality proves adjacency.
/// Every mutation ends inside [kMaxActiveTranscriptMessages] and
/// [kMaxActiveTranscriptDecodedBytes]; see [_fitTranscriptBudget] for what may
/// be released and in which order.
@immutable
final class TranscriptHistoryWindow {
  /// Sentinel used before the first transcript-bearing frame.
  const TranscriptHistoryWindow.uninitialized()
    : initialized = false,
      pages = const [],
      historyCursor = null,
      latestHistoryGap = null,
      latestHistoryTruncation = null,
      liveState = null,
      telemetry = SessionTelemetry.empty,
      questionState = SessionQuestionState.empty,
      releasedRanges = const {},
      unsavedReleasedElsewhere = false;

  const TranscriptHistoryWindow._({
    required this.pages,
    required this.historyCursor,
    required this.latestHistoryGap,
    required this.latestHistoryTruncation,
    required this.liveState,
    required this.telemetry,
    required this.questionState,
    required this.releasedRanges,
    this.unsavedReleasedElsewhere = false,
  }) : initialized = true;

  /// Builds the open tail from one authoritative history frame.
  ///
  /// Latest-wins restatements collapse to their last copy first, so the tail
  /// holds exactly ONE canonical reading per state/telemetry key — the same
  /// shape the delta reconciliation emits.
  ///
  /// A frame carrying `endCursor` makes its rows the tail's broker block: a
  /// range the window can later release whole and reload exactly. A frame too
  /// large to keep (only an old broker or a durable snapshot can send one)
  /// keeps its newest rows and marks the released prefix as needing a
  /// reconnect. [headReleased] carries that mark through a snapshot.
  factory TranscriptHistoryWindow.fromHistory(
    HistoryWireEvent event, {
    bool headReleased = false,
  }) {
    var questionState = SessionQuestionState.empty;
    for (final message in event.messages) {
      questionState = questionState.applyMessage(message);
    }
    final tailMessages = [
      for (final message in _collapseLatestWinsRestatements(
        event.messages.map(questionState.restoreMessage).toList(),
      ))
        boundTranscriptRow(message),
    ];
    final endCursor = headReleased ? null : event.endCursor;
    final tail = TranscriptHistoryPage(
      messages: tailMessages,
      olderCursor: event.olderCursor,
      newerCursor: null,
      isTail: true,
      headReleased: headReleased,
      blockRows: endCursor == null ? null : tailMessages.length,
      blockEndCursor: endCursor,
      blockPageableRows: endCursor == null
          ? null
          : _pageableRowCount(event.messages),
    );
    final fitted = _fitTranscriptBudget(
      [tail],
      const {},
      releaseTailBlock: false,
    );
    final retainedTail = fitted.pages.last;
    final prefixReleased = retainedTail.headReleased && !headReleased;
    return TranscriptHistoryWindow._(
      pages: List.unmodifiable(fitted.pages),
      historyCursor: event.cursor,
      latestHistoryGap: event.gap,
      latestHistoryTruncation: prefixReleased
          ? HistoryTruncation(
              shown: retainedTail.messages.length,
              total: event.truncated?.total ?? event.messages.length,
            )
          : event.truncated,
      liveState: SessionLiveState.fromMessages(tailMessages),
      telemetry: SessionTelemetry.fromMessages(tailMessages),
      questionState: questionState,
      releasedRanges: const {},
    );
  }

  /// Legacy fixture adapter. Production controller state never reduces its
  /// transcript from the event log.
  factory TranscriptHistoryWindow.fromEvents(List<WireEvent> events) {
    var window = const TranscriptHistoryWindow.uninitialized();
    for (final event in events) {
      switch (event) {
        case HistoryWireEvent():
          window = window.applyHistory(event);
        case HistoryPageWireEvent():
          final requestedCursor = window.olderHistoryCursor;
          if (requestedCursor != null) {
            window = window
                .prependPage(event, requestedCursor: requestedCursor)
                .window;
          }
        case MessageWireEvent(:final message):
          window = window.applyLiveMessage(message);
        case _:
          break;
      }
    }
    return window.initialized
        ? window
        : TranscriptHistoryWindow._(
            pages: const [],
            historyCursor: null,
            latestHistoryGap: null,
            latestHistoryTruncation: null,
            liveState: SessionLiveState.fromMessages(const []),
            telemetry: SessionTelemetry.empty,
            questionState: SessionQuestionState.empty,
            releasedRanges: const {},
          );
  }

  /// Whether this table has consumed at least one transcript frame.
  final bool initialized;

  /// Retained pages in chronological order.
  final List<TranscriptHistoryPage> pages;

  /// Latest reconnect cursor represented by the recent tail.
  final String? historyCursor;

  /// Latest authoritative reconnect-gap metadata.
  final HistoryGap? latestHistoryGap;

  /// Latest authoritative initial-tail truncation metadata.
  final HistoryTruncation? latestHistoryTruncation;

  /// Incremental latest-wins state projection.
  final SessionLiveState? liveState;

  /// Incremental latest telemetry projection.
  final SessionTelemetry telemetry;

  /// Live question authority retained independently of bounded history pages.
  final SessionQuestionState questionState;

  /// Ranges released to fit the budget, keyed by the boundary after each.
  final Map<String, TranscriptReleasedRange> releasedRanges;

  /// Whether the oldest retained run starts after locally released rows that
  /// no broker boundary reaches. A released-residue marker released only rows
  /// that were never saved; the durable rows before it still page as usual.
  bool get leadingEdgeReleased =>
      pages.isNotEmpty &&
      pages.first.headReleased &&
      !pages.first.isReleasedResidueMarker;

  /// Whether rows that were never saved were released at a place no retained
  /// page marks any more (see [kMaxReleasedResidueMarkers]).
  final bool unsavedReleasedElsewhere;

  /// Rows a reload from [cursor] should request to restore exactly the range
  /// released behind it, or null when no such range is known.
  int? reloadLimitFor(String cursor) => releasedRanges[cursor]?.pageableRows;

  _TranscriptHistoryDerived get _derived {
    final cached = _transcriptHistoryDerivedCache[this];
    if (cached != null) return cached;
    final derived = _TranscriptHistoryDerived.fromWindow(this);
    _transcriptHistoryDerivedCache[this] = derived;
    return derived;
  }

  /// Identity-deduplicated canonical messages, built lazily for rendering.
  List<AgentMessage> get canonicalMessages => _derived.canonicalMessages;

  /// Canonical transcript rows excluding state/telemetry frames.
  List<AgentMessage> get transcriptMessages => _derived.transcriptMessages;

  /// Active terminal-output rows.
  List<AgentMessage> get terminalOutputMessages =>
      List<AgentMessage>.unmodifiable(
        pages.expand(
          (page) => _pageDerived(page).terminalOutputMessages,
        ),
      );

  /// Active file-artifact rows.
  List<AgentMessage> get fileArtifactMessages =>
      List<AgentMessage>.unmodifiable(
        pages.expand(
          (page) => _pageDerived(page).fileArtifactMessages,
        ),
      );

  /// Active file-artifact descriptors.
  List<SessionArtifactDescriptor> get fileArtifactDescriptors =>
      List<SessionArtifactDescriptor>.unmodifiable(
        pages.expand(
          (page) => _pageDerived(page).fileArtifactDescriptors,
        ),
      );

  /// Explicit omitted ranges between retained contiguous runs.
  List<TranscriptHistoryGapSegment> get gaps => _derived.gaps;

  /// Explicit gap before the first segment: its leading rows were released
  /// without a broker boundary, or rows that were never saved were released
  /// there (or somewhere no marker records any more).
  TranscriptHistoryGapSegment? get leadingGap {
    if (leadingEdgeReleased) {
      return const TranscriptHistoryGapSegment(
        id: 'history-gap-leading-local',
        kind: TranscriptHistoryGapKind.reconnectRequired,
      );
    }
    if ((pages.isNotEmpty && pages.first.isReleasedResidueMarker) ||
        unsavedReleasedElsewhere) {
      return const TranscriptHistoryGapSegment(
        id: 'history-gap-leading-unsaved',
        kind: TranscriptHistoryGapKind.unsavedReleased,
      );
    }
    return null;
  }

  /// Whether any retained page has a renderable transcript message.
  bool get hasTranscriptMessages {
    for (final page in pages) {
      if (_pageDerived(page).transcriptMessages.isNotEmpty) return true;
    }
    return false;
  }

  /// Latest request resolutions folded from page-local projections.
  Map<String, String?> get resolvedRequestDecisions {
    final result = <String, String?>{};
    for (final page in pages) {
      result.addAll(_pageDerived(page).resolvedRequestDecisions);
    }
    for (final id in questionState.resolvedRequestIds) {
      result.putIfAbsent(id, () => null);
    }
    return Map<String, String?>.unmodifiable(result);
  }

  /// The cards no longer waiting for an answer although no resolution for
  /// them is held: this connection's attach did not send them again (see
  /// [SessionQuestionState.withdrawnRequestIds]).
  Set<String> get withdrawnRequestIds {
    final withdrawn = questionState.withdrawnRequestIds;
    if (withdrawn.isEmpty) return const {};
    final resolved = resolvedRequestDecisions;
    return Set.unmodifiable(withdrawn.where((id) => !resolved.containsKey(id)));
  }

  /// Cursor immediately before the oldest retained browsing run.
  String? get olderHistoryCursor {
    if (pages.isEmpty) return null;
    return pages.first.olderCursor;
  }

  /// Whether the oldest retained run has another native page before it.
  bool get hasEarlierHistory => olderHistoryCursor != null;

  /// Total estimated decoded bytes retained by all pages.
  int get estimatedBytes =>
      pages.fold<int>(0, (sum, page) => sum + page.estimatedBytes);

  /// Total raw message slots retained by all pages.
  int get messageCount =>
      pages.fold<int>(0, (sum, page) => sum + page.messages.length);

  /// The open tail, as a durable snapshot can represent it.
  ///
  /// Older pages are disposable reads of broker history and never enter the
  /// snapshot; the tail is the one range this client assembled itself (the
  /// newest frame plus live rows). A tail whose leading rows were released
  /// carries no older cursor, because paging from the old boundary would skip
  /// the released rows.
  ({List<AgentMessage> messages, String? olderCursor, bool headReleased})
  persistableTail() {
    final tailIndex = pages.lastIndexWhere((page) => page.isTail);
    if (tailIndex < 0) {
      return (messages: const [], olderCursor: null, headReleased: false);
    }
    final tail = pages[tailIndex];
    return (
      messages: tail.messages,
      olderCursor: tail.headReleased ? null : tail.olderCursor,
      headReleased: tail.headReleased,
    );
  }

  /// Flat optimistic/decorated transcript projection.
  List<AgentMessage> transcriptMessagesWith(
    List<SessionOptimisticPrompt> optimisticPrompts,
    Map<String, String> clientKeys,
  ) => _presentation(optimisticPrompts, clientKeys).messages;

  /// Optimistic/decorated transcript runs that never cross a decoded gap.
  List<List<AgentMessage>> transcriptMessageSegmentsWith(
    List<SessionOptimisticPrompt> optimisticPrompts,
    Map<String, String> clientKeys,
  ) => _presentation(optimisticPrompts, clientKeys).segments;

  /// Builds cached production conversation descriptors for contiguous runs.
  ///
  /// Each immutable page owns its canonical projection. A run projection
  /// preserves conversation/tool grouping across adjacent page boundaries,
  /// while a prewarmed prefix excluding the mutable tail lets the next live
  /// update reuse every older turn descriptor.
  List<TranscriptConversationSegment> transcriptConversationSegmentsWith(
    List<SessionOptimisticPrompt> optimisticPrompts,
    Map<String, String> clientKeys, {
    required ToolDisplayMode mode,
    TranscriptHistoryWorkCounter? work,
  }) {
    if (pages.isEmpty) return const [];
    final pageRuns = <List<TranscriptHistoryPage>>[];
    final gapsBeforeRuns = <TranscriptHistoryGapSegment?>[];
    for (final page in pages) {
      if (pageRuns.isEmpty) {
        pageRuns.add([page]);
        gapsBeforeRuns.add(null);
        continue;
      }
      final gap = _historyGapBetween(pageRuns.last.last, page);
      // The recent tail is a presentation checkpoint even when its cursor is
      // adjacent. Only that page changes under streaming; keeping the older
      // run separate lets it retain canonical/turn identity. A partial first
      // tail turn is stitched to the older run below without inventing a gap.
      if (gap == null && !page.isTail) {
        pageRuns.last.add(page);
      } else {
        pageRuns.add([page]);
        gapsBeforeRuns.add(gap);
      }
    }

    // Release first: a page that just stopped owning a run still holds the run
    // it owned last frame, whose pages may already be evicted.
    _releaseNonOwnerRunCaches(pages, pageRuns);
    final derivedRuns = [
      for (final run in pageRuns) _runDerived(run, work: work),
    ];
    final promptBuckets = List<List<SessionOptimisticPrompt>?>.filled(
      pageRuns.length,
      null,
    );
    var runFloor = 0;
    for (final prompt in optimisticPrompts) {
      final deliveredKey = prompt.deliveredMessageKey;
      final anchorKey = prompt.anchorMessageKey;
      final int target;
      if (deliveredKey != null) {
        final runIndex = derivedRuns.indexWhere(
          (run) => run.stableKeys.contains(deliveredKey),
        );
        // A delivered holder whose echo no run carries renders nothing (the
        // run projection skips it). Bucketing it to the last run would only
        // drag every later prompt down through the monotonic floor.
        if (runIndex < 0) continue;
        target = runIndex;
      } else if (anchorKey != null) {
        final runIndex = derivedRuns.indexWhere(
          (run) => run.stableKeys.contains(anchorKey),
        );
        // A pending prompt has no canonical row; when its anchor is gone the
        // last run is the reserved fallback.
        target = runIndex < 0 ? pageRuns.length - 1 : runIndex;
      } else {
        target = 0;
      }
      final resolved = target < runFloor ? runFloor : target;
      runFloor = resolved;
      (promptBuckets[resolved] ??= <SessionOptimisticPrompt>[]).add(prompt);
    }

    final result = <TranscriptConversationSegment>[];
    for (var index = 0; index < pageRuns.length; index++) {
      final messages = derivedRuns[index].present(
        optimisticPrompts: promptBuckets[index] ?? const [],
        clientKeys: clientKeys,
        work: work,
      );
      final turns = _conversationTurnsForRun(
        messages,
        mode: mode,
        work: work,
      );
      var presentedTurns = turns;
      if (index > 0 &&
          gapsBeforeRuns[index] == null &&
          turns.isNotEmpty &&
          turns.first.isPartial &&
          result.last.turns.isNotEmpty) {
        final stitched = _stitchConversationBoundary(
          result.last.turns,
          turns,
        );
        final previous = result.last;
        result[result.length - 1] = TranscriptConversationSegment(
          turns: stitched.previous,
          gapBefore: previous.gapBefore,
        );
        presentedTurns = stitched.current;
      }
      result.add(
        TranscriptConversationSegment(
          turns: presentedTurns,
          gapBefore: gapsBeforeRuns[index],
        ),
      );
    }
    return List<TranscriptConversationSegment>.unmodifiable(result);
  }

  _TranscriptHistoryPresentation _presentation(
    List<SessionOptimisticPrompt> optimisticPrompts,
    Map<String, String> clientKeys,
  ) {
    final cached = _transcriptHistoryPresentationCache[this];
    if (cached != null &&
        identical(cached.optimisticPrompts, optimisticPrompts) &&
        identical(cached.clientKeys, clientKeys)) {
      return cached;
    }
    final projected = projectOptimisticTranscriptMessages(
      transcriptMessages,
      optimisticPrompts,
      clientKeys,
    );
    final boundaryKeys = _derived.segmentStartKeys.skip(1).toSet();
    final result = <List<AgentMessage>>[];
    var current = <AgentMessage>[];
    for (final message in projected) {
      final key = stableTranscriptMessageKey(message);
      if (current.isNotEmpty && key != null && boundaryKeys.contains(key)) {
        result.add(List.unmodifiable(current));
        current = <AgentMessage>[];
      }
      current.add(message);
    }
    if (current.isNotEmpty || result.isEmpty) {
      result.add(List.unmodifiable(current));
    }
    final presentation = _TranscriptHistoryPresentation(
      optimisticPrompts: optimisticPrompts,
      clientKeys: clientKeys,
      messages: projected,
      segments: List.unmodifiable(result),
    );
    _transcriptHistoryPresentationCache[this] = presentation;
    return presentation;
  }

  TranscriptHistoryWindow _with({
    List<TranscriptHistoryPage>? pages,
    Object? historyCursor = _unchanged,
    Object? latestHistoryGap = _unchanged,
    Object? latestHistoryTruncation = _unchanged,
    SessionLiveState? liveState,
    SessionTelemetry? telemetry,
    SessionQuestionState? questionState,
    Map<String, TranscriptReleasedRange>? releasedRanges,
    bool? unsavedReleasedElsewhere,
  }) => TranscriptHistoryWindow._(
    pages: pages == null ? this.pages : List.unmodifiable(pages),
    historyCursor: identical(historyCursor, _unchanged)
        ? this.historyCursor
        : historyCursor as String?,
    latestHistoryGap: identical(latestHistoryGap, _unchanged)
        ? this.latestHistoryGap
        : latestHistoryGap as HistoryGap?,
    latestHistoryTruncation: identical(latestHistoryTruncation, _unchanged)
        ? this.latestHistoryTruncation
        : latestHistoryTruncation as HistoryTruncation?,
    liveState: liveState ?? this.liveState,
    telemetry: telemetry ?? this.telemetry,
    questionState: questionState ?? this.questionState,
    releasedRanges: releasedRanges == null
        ? this.releasedRanges
        : Map.unmodifiable(releasedRanges),
    unsavedReleasedElsewhere:
        unsavedReleasedElsewhere ?? this.unsavedReleasedElsewhere,
  );

  TranscriptHistoryWindow _fitted({
    String? protectedKey,
    TranscriptHistoryWorkCounter? work,
  }) {
    final fitted = _fitTranscriptBudget(
      pages,
      releasedRanges,
      protectedKey: protectedKey,
      notWaiting: questionState.withdrawnRequestIds,
      work: work,
    );
    if (identical(fitted.pages, pages)) return this;
    return _with(
      pages: fitted.pages,
      releasedRanges: fitted.released,
      unsavedReleasedElsewhere:
          unsavedReleasedElsewhere || fitted.unsavedOverflow,
    );
  }

  /// Applies an authoritative replay/delta. A reset starts a new cursor epoch;
  /// an incremental frame reconciles the recent tail into the frame's
  /// native/source order (see [_applyHistoryDelta]).
  ///
  /// [preserveMessageKey] names the reader's row: no release discards the page
  /// holding it, and a reset that no longer covers it keeps that page beside
  /// the replacement with a reloadable gap between them.
  ///
  /// [catchUp] marks a reset that answers this window's own reconnect cursor
  /// with no gap: the broker confirmed that cursor, so the frame was only
  /// capped, and every retained page is still a range of the same history
  /// (see [_caughtUpWindow]).
  TranscriptHistoryWindow applyHistory(
    HistoryWireEvent event, {
    String? preserveMessageKey,
    bool catchUp = false,
  }) {
    if (!initialized) {
      return TranscriptHistoryWindow.fromHistory(event);
    }
    // Every frame but a refresh answer ends an attach. After it the broker
    // sends every request still waiting, so a card carried from the last
    // connection is withdrawn until it is sent again.
    final attached = event.clientMessageId == null
        ? questionState.attached()
        : questionState;
    final base = identical(attached, questionState)
        ? this
        : _with(questionState: attached);
    if (event.reset) {
      final replaced = base._applyReset(
        event,
        preserveMessageKey: preserveMessageKey,
        catchUp: catchUp,
      );
      final kept = replaced.questionState.withdrawing(
        attached.withdrawnRequestIds,
      );
      return identical(kept, replaced.questionState)
          ? replaced
          : replaced._with(questionState: kept);
    }
    var next = base;
    if (event.messages.isNotEmpty || event.endCursor != null) {
      next = next._applyHistoryDelta(event);
    }
    var nextPages = next.pages;
    final preservesUnavailablePaging =
        isHistoryUnavailableGapCode(event.gap?.code) && !event.reset;
    if ((event.olderCursor != null || preservesUnavailablePaging) &&
        nextPages.isNotEmpty) {
      final tailIndex = nextPages.lastIndexWhere((page) => page.isTail);
      final tail = nextPages[tailIndex];
      // An unavailable non-reset frame has no authoritative replacement
      // paging position. Keep the last accepted cursor so Load Earlier
      // remains usable while the visible cached rows are preserved.
      final olderCursor = event.olderCursor ?? tail.olderCursor;
      final moved = olderCursor != tail.olderCursor;
      nextPages = List.unmodifiable([
        ...nextPages.take(tailIndex),
        tail._copyWith(
          olderCursor: olderCursor,
          // A new start boundary no longer describes the old block.
          blockRows: moved ? null : tail.blockRows,
          blockPageableRows: moved ? null : tail.blockPageableRows,
        ),
        ...nextPages.skip(tailIndex + 1),
      ]);
    }
    return next
        ._with(
          pages: nextPages,
          historyCursor: event.cursor ?? next.historyCursor,
          latestHistoryGap: event.gap,
          latestHistoryTruncation:
              event.truncated ?? next.latestHistoryTruncation,
        )
        ._fitted(protectedKey: preserveMessageKey);
  }

  TranscriptHistoryWindow _applyReset(
    HistoryWireEvent event, {
    required String? preserveMessageKey,
    required bool catchUp,
  }) {
    final replacement = TranscriptHistoryWindow.fromHistory(event);
    final held = <String>{
      for (final page in replacement.pages)
        for (final message in page.messages)
          ?stableTranscriptMessageKey(message),
    };
    if (catchUp) {
      final caughtUp = _caughtUpWindow(
        this,
        replacement,
        held,
        preserveMessageKey: preserveMessageKey,
      );
      if (caughtUp != null) return caughtUp;
    }
    // A replacement the reader's row is not in keeps the reader's page.
    final anchorPageIndex =
        preserveMessageKey == null || held.contains(preserveMessageKey)
        ? -1
        : pages.indexWhere(
            (page) => page.containsStableKey(preserveMessageKey),
          );
    // Whatever else goes, rows no reload returns are announced, not dropped
    // silently: the replacement says such rows were released.
    TranscriptHistoryWindow replaced() => replacement._with(
      unsavedReleasedElsewhere:
          unsavedReleasedElsewhere || _dropsUnsavedRows(pages, held),
    );
    if (anchorPageIndex < 0) return replaced();
    final replacementTail = replacement.pages.last;

    // A reset authoritatively replaces the live tail, but browser suspension
    // must not discard the page the user is reading. Keep that page as its
    // own run before the replacement: joined to it when the two overlap,
    // otherwise separated by a gap that pages backward from the replacement's
    // own boundary (or, when the replacement offers none, one that needs a
    // reconnect). Its rows no reload returns stay marked as such.
    final anchor = _resetAnchorPage(pages[anchorPageIndex]);
    TranscriptHistoryPage? retained;
    var replacementPages = replacement.pages;
    if (anchor.newerCursor != null &&
        anchor.newerCursor == replacementTail.olderCursor) {
      retained = anchor;
    } else {
      final joined = _joinOverlappingOlderPage(
        anchor,
        replacementTail,
        protectedKey: preserveMessageKey,
      );
      if (joined != null) {
        retained = joined.page;
        replacementPages = [
          ...replacement.pages.take(replacement.pages.length - 1),
          joined.newer,
        ];
      } else {
        retained = _withoutHeldRows(anchor, held);
      }
    }
    if (retained == null || !retained.containsStableKey(preserveMessageKey!)) {
      return replaced();
    }
    final fitted = _fitTranscriptBudget(
      [retained, ...replacementPages],
      replacement.releasedRanges,
      protectedKey: preserveMessageKey,
      notWaiting: questionState.withdrawnRequestIds,
    );
    return replacement._with(
      pages: fitted.pages,
      releasedRanges: fitted.released,
      unsavedReleasedElsewhere:
          unsavedReleasedElsewhere ||
          fitted.unsavedOverflow ||
          _dropsUnsavedRows([
            for (var index = 0; index < pages.length; index++)
              if (index != anchorPageIndex) pages[index],
          ], held),
    );
  }

  /// This window, guaranteed to hold at least one writable tail page.
  ///
  /// An INITIALIZED window can still hold zero pages — the legacy event
  /// reduce yields one when no transcript-bearing frame ever arrived, which
  /// is exactly the state a transcript export appends its artifact into. Both
  /// that and the uninitialized sentinel need a tail page to append through,
  /// or the tail lookup below indexes an empty list and throws. Carry the
  /// window's own metadata over so bootstrapping never discards a cursor,
  /// gap, or telemetry the window already established.
  TranscriptHistoryWindow get _tailWritableBase =>
      initialized && pages.isNotEmpty
      ? this
      : TranscriptHistoryWindow._(
          pages: [
            TranscriptHistoryPage(
              messages: const [],
              olderCursor: null,
              newerCursor: null,
              isTail: true,
              estimatedBytes: 0,
            ),
          ],
          historyCursor: historyCursor,
          latestHistoryGap: latestHistoryGap,
          latestHistoryTruncation: latestHistoryTruncation,
          liveState: liveState ?? SessionLiveState.fromMessages(const []),
          telemetry: telemetry,
          questionState: questionState,
          releasedRanges: releasedRanges,
        );

  /// Ends live question authority without changing history or its cursors.
  /// The same adapter restores pending cards through live replay. A replacement
  /// can return an empty delta with no pending requests.
  ///
  /// The cards are carried to the next connection, whose attach frame
  /// withdraws every one of them it does not send again (see
  /// [SessionQuestionState]); one resolved meanwhile stays resolved.
  TranscriptHistoryWindow invalidateQuestionAuthority() {
    if (!initialized) return this;
    final historical = _mapQuestionPages(
      pages,
      SessionQuestionState.historicalMessage,
    );
    return _with(
      pages: historical,
      questionState: SessionQuestionState.carrying(
        _actionableRequestIds(historical),
      ),
    );
  }

  /// Applies one live message: an upsert of the row wherever the window holds
  /// it (the open tail, a block a frame sealed, the reader's split, a page
  /// read back), else an append to the open tail; then the budget.
  ///
  /// A row whose key lies in a released range is not held anywhere, so its
  /// update is appended to the tail as a live row. A reload of that range
  /// returns the saved copy, which takes the row's place, and the live copy
  /// goes (see [_withoutLiveTailRowsHeld]).
  ///
  /// [protectedKey] names the reader's row, which no release discards.
  TranscriptHistoryWindow applyLiveMessage(
    AgentMessage incomingMessage, {
    TranscriptHistoryWorkCounter? work,
    String? protectedKey,
  }) {
    final base = _tailWritableBase;
    final nextQuestionState = base.questionState
        .applyMessage(incomingMessage)
        .restated(incomingMessage);
    final message = nextQuestionState.restoreMessage(incomingMessage);
    final tailIndex = base.pages.lastIndexWhere((page) => page.isTail);
    final safeTailIndex = tailIndex < 0 ? base.pages.length - 1 : tailIndex;
    final tail = base.pages[safeTailIndex];
    final key = stableTranscriptMessageKey(message);
    final nextPages = List<TranscriptHistoryPage>.of(base.pages);
    var existingIndex = key == null
        ? -1
        : tail.indexOfStableKey(key, work: work);
    var targetIndex = safeTailIndex;
    if (existingIndex < 0 && key != null) {
      // An update of a row sealed or read into an older page (a streaming
      // row the reader kept by splitting the tail, a tool call a refresh
      // sealed pages ago) belongs to that copy, not a second one in the tail.
      // An older page's key index is derived once per page, as its rendering
      // is, so the lookup does not scan the pages again on every row.
      for (var index = safeTailIndex - 1; index >= 0; index--) {
        final at = _pageDerived(
          base.pages[index],
          work: work,
        ).rowIndexByKey[key];
        if (at != null) {
          existingIndex = at;
          targetIndex = index;
          break;
        }
      }
    }
    if (existingIndex < 0 &&
        key == null &&
        _isRepeatableReading(message) &&
        _repeatsLatestReading(tail.messages, message, work: work) &&
        base.telemetry.applyMessage(message) == base.telemetry) {
      // The broker replays the readings still trailing its history (a token
      // count) after every frame: the same reading again is held once. Only
      // a reading that changes nothing counts: a live-state event (Codex's
      // snapshot of the commands still running) retires cards whatever it
      // repeats, and a reading equal to the last of its kind but not to the
      // current value (a run summary's totals came between) restores it.
      return this;
    }
    final target = base.pages[targetIndex];
    final nextMessages = List<AgentMessage>.of(target.messages);
    var nextBytes = target.estimatedBytes;
    if (existingIndex >= 0) {
      final previous = nextMessages[existingIndex];
      final merged = boundTranscriptRow(
        mergeStableTranscriptMessage(previous, message),
      );
      work?.estimatedMessages += 2;
      nextBytes -= estimatedAgentMessageDecodedBytes(previous);
      nextBytes += estimatedAgentMessageDecodedBytes(merged);
      nextMessages[existingIndex] = merged;
    } else {
      final admitted = boundTranscriptRow(message);
      work?.estimatedMessages += 1;
      nextMessages.add(admitted);
      nextBytes += estimatedAgentMessageDecodedBytes(admitted);
    }
    nextPages[targetIndex] = target._copyWith(
      messages: nextMessages,
      estimatedBytes: nextBytes,
    );
    return base
        ._with(
          pages: identical(nextQuestionState, base.questionState)
              ? nextPages
              : _mapQuestionPages(nextPages, nextQuestionState.restoreMessage),
          liveState: (base.liveState ?? SessionLiveState.fromMessages(const []))
              .applyMessage(message),
          telemetry: base.telemetry.applyMessage(message),
          questionState: nextQuestionState,
        )
        ._fitted(protectedKey: protectedKey, work: work);
  }

  /// Applies one authoritative incremental history frame to the recent tail.
  ///
  /// Unlike live delivery, the frame carries native/source order, so it can
  /// REPAIR order, not just extend it: a row the tail never retained (missed
  /// live delivery, cache restore) returns to its authoritative position
  /// among the rows the frame shares with the tail instead of appending
  /// behind an already-retained later row. Older pages and cursor identity are
  /// untouched — the reconciliation writes only the tail page.
  ///
  /// With `endCursor` the frame's rows become the tail's broker block. The
  /// frame starts at the tail's reconnect position, which is the previous
  /// block's end boundary, so a previous block that still holds rows, all of
  /// them ahead of the frame's, is sealed there as its own older page (joined
  /// to a contiguous one while they fit one page) and the tail starts at that
  /// boundary; a block the frame's rows arrived among grows through them.
  /// Releasing a block then never takes a newer frame's rows with it: a client
  /// that reconnects often keeps its newest rows instead of releasing the
  /// whole tail at once. When the tail's leading live rows were released with
  /// no boundary, a frame that begins exactly there delivers them again and
  /// the release is healed.
  TranscriptHistoryWindow _applyHistoryDelta(HistoryWireEvent event) {
    final messages = event.messages;
    final base = _tailWritableBase;
    final tailIndex = base.pages.lastIndexWhere((page) => page.isTail);
    final safeTailIndex = tailIndex < 0 ? base.pages.length - 1 : tailIndex;
    final tail = base.pages[safeTailIndex];
    final tailBlockRows = tail.blockRows;
    final tailLiveOnly = tail.blockLiveOnlyRows.toSet();
    final reconciled = reconcileTranscriptHistoryDeltaDetailed(
      retained: tail.messages,
      frame: messages,
      isLiveRow: tailBlockRows == null
          ? null
          : (index) => index >= tailBlockRows,
      // The block's own rows: a frame placed each of them.
      isFixedRow: tailBlockRows == null
          ? null
          : (index) => index < tailBlockRows && !tailLiveOnly.contains(index),
    );
    var nextQuestionState = base.questionState;
    if (!reconciled.frameSuperseded) {
      for (final message in messages) {
        nextQuestionState = nextQuestionState.applyMessage(message);
      }
    }
    var tailMessages = reconciled.messages;
    final endCursor = event.endCursor;
    var headReleased = tail.headReleased;
    int? blockRows;
    int? blockPageableRows;
    var blockLiveOnlyRows = const <int>[];
    var tailOlderCursor = tail.olderCursor;
    // The previous block's rows, when they are sealed as their own page, and
    // which of them its reload would not return.
    List<AgentMessage>? previousBlock;
    var previousBlockLiveOnly = const <int>[];
    // A heal whose frame skipped released rows that were never saved.
    var healedOverUnsaved = false;
    // The rows released from the tail's head no frame has restated yet.
    var nextShedKeys = tail.shedKeys;
    var previousBlockPageable = tail.blockPageableRows;
    if (endCursor != null) {
      final framePageable = _pageableRowCount(messages);
      // Whether the block grows through the frame's rows, and how many of
      // the tail's own leading rows are already inside it (null: unknown, the
      // rows ahead of the frame are taken as the contiguous durable start).
      var extendsBlock = false;
      var sealsPreviousBlock = false;
      int? ownedBlockRows;
      if (tail.headReleased) {
        // Healable only while the tail still begins where its block was
        // released: the frame then starts there too, so it restates every
        // released row that was saved before the newest row it restates. A
        // released row the frame skips while restating one released or
        // retained after it was never saved (an approval card): the heal
        // leaves a notice where it was instead of hiding it. One after the
        // last row the frame restates may still be saved later, so the
        // release stays until a frame reaches past it.
        final frameKeys = <String>{
          for (final message in messages) ?stableTranscriptMessageKey(message),
        };
        final restatesRetained = tail.messages.any(
          (message) => frameKeys.contains(stableTranscriptMessageKey(message)),
        );
        final atRelease =
            tail.blockEndCursor != null &&
            tail.blockRows == 0 &&
            messages.isNotEmpty;
        final lastRestated = tail.shedKeys.lastIndexWhere(frameKeys.contains);
        if (atRelease &&
            !tail.shedUnverifiable &&
            (restatesRetained ||
                (lastRestated >= 0 &&
                    lastRestated == tail.shedKeys.length - 1))) {
          headReleased = false;
          extendsBlock = true;
          ownedBlockRows = 0;
          blockPageableRows = framePageable;
          healedOverUnsaved = !tail.shedKeys.every(frameKeys.contains);
        } else if (atRelease && !restatesRetained) {
          // The frame restates only released rows (or rows the tail never
          // held), all saved before any row the tail still holds: they are
          // the range from the release point to the frame's end, and the
          // release restarts there. What it did not restate stays released,
          // and one it skipped before a row it restated was never saved.
          previousBlock = messages;
          previousBlockPageable = framePageable;
          tailMessages = tail.messages;
          tailOlderCursor = endCursor;
          blockRows = 0;
          blockPageableRows = 0;
          healedOverUnsaved = [
            for (var index = 0; index < lastRestated; index++)
              if (!frameKeys.contains(tail.shedKeys[index])) index,
          ].isNotEmpty;
          // A row the notice stands for is no longer waiting for a frame.
          nextShedKeys = tail.shedKeys.sublist(lastRestated + 1);
        }
      } else if (tail.blockRows != null) {
        if (messages.isEmpty) {
          blockRows = tail.blockRows!.clamp(0, tailMessages.length);
          blockLiveOnlyRows = [
            for (final index in tail.blockLiveOnlyRows)
              if (index < blockRows) index,
          ];
        } else {
          extendsBlock = true;
          ownedBlockRows = tail.blockRows;
          sealsPreviousBlock =
              tail.blockRows! > 0 && tail.blockEndCursor != null;
        }
        blockPageableRows = tail.blockPageableRows == null
            ? null
            : tail.blockPageableRows! + framePageable;
      } else if (messages.isNotEmpty) {
        // The tail's rows were contiguous from its start boundary but their
        // pageable count is unknown (a snapshot or an older broker's frame).
        extendsBlock = true;
      }
      if (extendsBlock && previousBlock == null) {
        final sealed = _sealFrameRange(
          tailMessages,
          reconciled.lastFrameIndex,
          frame: messages,
          retained: tail.messages,
          ownedBlockRows: ownedBlockRows,
          ownedLiveOnly: ownedBlockRows == null
              ? const []
              : tail.blockLiveOnlyRows,
          splitOwned: sealsPreviousBlock,
        );
        tailMessages = sealed.messages;
        blockRows = sealed.blockRows;
        blockLiveOnlyRows = sealed.liveOnly;
        if (sealed.sealed.isNotEmpty) {
          previousBlock = sealed.sealed;
          previousBlockLiveOnly = sealed.sealedLiveOnly;
          tailOlderCursor = tail.blockEndCursor;
          blockPageableRows = framePageable;
        } else if (blockPageableRows != null) {
          // Rows the frame restated are already counted in the block.
          blockPageableRows -= sealed.restatedPageable;
        }
      }
    }
    // A durable row an older page holds that the frame restated (a frame from
    // before the tail's start) keeps its older, bounded place: the tail drops
    // its copy, so the row is held once, and the block's count no longer
    // describes an exact reload.
    final restated = _restatedOlderRows(
      base.pages.take(safeTailIndex),
      messages,
    );
    if (restated.isNotEmpty) {
      final keep = <int>[
        for (var index = 0; index < tailMessages.length; index++)
          if (!restated.contains(
            stableTranscriptMessageKey(tailMessages[index]),
          ))
            index,
      ];
      final at = <int, int>{
        for (var index = 0; index < keep.length; index++) keep[index]: index,
      };
      final keptBlockRows = blockRows;
      if (keptBlockRows != null) {
        blockRows = keep.where((index) => index < keptBlockRows).length;
        blockPageableRows = null;
      }
      blockLiveOnlyRows = [
        for (final index in blockLiveOnlyRows)
          if (at.containsKey(index)) at[index]!,
      ];
      tailMessages = [for (final index in keep) tailMessages[index]];
    }
    final nextTailMessages = [
      for (final message in tailMessages)
        boundTranscriptRow(nextQuestionState.restoreMessage(message)),
    ];
    final nextTail = TranscriptHistoryPage(
      messages: nextTailMessages,
      olderCursor: tailOlderCursor,
      newerCursor: null,
      isTail: true,
      headReleased: headReleased,
      blockRows: blockRows,
      blockEndCursor: endCursor,
      blockPageableRows: blockPageableRows,
      blockLiveOnlyRows: blockLiveOnlyRows,
      // A release no frame healed still needs every row it dropped restated.
      shedKeys: headReleased ? nextShedKeys : const [],
      shedUnverifiable: headReleased && tail.shedUnverifiable,
    );
    var nextPages = List<TranscriptHistoryPage>.of(base.pages);
    nextPages[safeTailIndex] = nextTail;
    if (previousBlock != null) {
      final sealedRows = [
        for (final message in previousBlock)
          boundTranscriptRow(nextQuestionState.restoreMessage(message)),
      ];
      final sealedPage = TranscriptHistoryPage(
        messages: sealedRows,
        olderCursor: tail.olderCursor,
        newerCursor: tailOlderCursor,
        isTail: false,
        reloadLimit: previousBlockPageable,
        sealedFromTail: true,
        liveOnlyRows: previousBlockLiveOnly,
      );
      final before = safeTailIndex > 0 ? nextPages[safeTailIndex - 1] : null;
      if (before != null &&
          before.sealedFromTail &&
          !before.headReleased &&
          before.newerCursor != null &&
          before.newerCursor == tail.olderCursor &&
          before.messages.length + sealedRows.length <=
              kTranscriptHistoryPageMessages &&
          before.estimatedBytes + sealedPage.estimatedBytes <=
              kMaxJoinedTranscriptPageDecodedBytes) {
        // Contiguous by the broker's own boundary: one range, one reload.
        final beforeLimit = before.reloadLimit;
        final sealedLimit = sealedPage.reloadLimit;
        nextPages[safeTailIndex - 1] = TranscriptHistoryPage(
          messages: [...before.messages, ...sealedRows],
          olderCursor: before.olderCursor,
          newerCursor: tailOlderCursor,
          isTail: false,
          estimatedBytes: before.estimatedBytes + sealedPage.estimatedBytes,
          reloadLimit: beforeLimit == null || sealedLimit == null
              ? null
              : beforeLimit + sealedLimit,
          sealedFromTail: true,
          liveOnlyRows: [
            ...before.liveOnlyRows,
            for (final index in previousBlockLiveOnly)
              before.messages.length + index,
          ],
        );
      } else {
        nextPages.insert(safeTailIndex, sealedPage);
      }
    }
    // A row an older page keeps only because no reload returned it (a prompt
    // sealed into a block before it was saved) is saved now if the frame
    // carries it: the frame's copy is the saved one, in its saved place, so
    // the older copies go.
    final framePlaced = <String>{
      for (final message in messages) ?stableTranscriptMessageKey(message),
    };
    if (framePlaced.isNotEmpty) {
      nextPages = [
        for (final page in nextPages)
          if (page.isTail)
            page
          else
            ?_withoutLiveOnlyRowsHeld(page, framePlaced),
      ];
    }
    final currentTailIndex = nextPages.lastIndexWhere((page) => page.isTail);
    if (tail.headReleased && !headReleased && currentTailIndex > 0) {
      // The healed tail may restate rows a page split from it still holds.
      final previous = nextPages[currentTailIndex - 1];
      if (previous.sealedFromTail && previous.newerCursor == null) {
        final tailKeys = <String>{
          for (final message in nextTailMessages)
            ?stableTranscriptMessageKey(message),
        };
        final kept = _withoutKeys(previous.messages, tailKeys);
        if (kept.isEmpty) {
          nextPages.removeAt(currentTailIndex - 1);
        } else if (kept.length != previous.messages.length) {
          nextPages[currentTailIndex - 1] = previous._copyWith(messages: kept);
        }
      }
    }
    var unsavedOverflow = false;
    if (healedOverUnsaved) {
      // The notice sits where the release began: at the tail's start, after
      // any page split from the tail before it.
      final at = nextPages.lastIndexWhere((page) => page.isTail);
      unsavedOverflow = _markReleasedResidue(
        nextPages,
        at,
        TranscriptHistoryPage(
          messages: const [],
          olderCursor: tailOlderCursor,
          newerCursor: tailOlderCursor,
          isTail: false,
        ),
        focus: at,
      );
    }
    var liveState = base.liveState ?? SessionLiveState.fromMessages(const []);
    var telemetry = base.telemetry;
    // A superseded frame restates values older than rows the projections have
    // already folded; applying it would silently regress latest-wins state.
    if (!reconciled.frameSuperseded) {
      for (final message in messages) {
        liveState = liveState.applyMessage(message);
        telemetry = telemetry.applyMessage(message);
      }
    }
    return base._with(
      pages: identical(nextQuestionState, base.questionState)
          ? nextPages
          : _mapQuestionPages(nextPages, nextQuestionState.restoreMessage),
      liveState: liveState,
      telemetry: telemetry,
      questionState: nextQuestionState,
      unsavedReleasedElsewhere:
          base.unsavedReleasedElsewhere || unsavedOverflow,
    );
  }

  /// Inserts one page at the exact requested opaque boundary.
  ///
  /// A reload of a released range that returns exactly the range's rows takes
  /// the range's older boundary, so it joins its older neighbour by cursor
  /// equality even when the broker's walk stopped past leading state rows. A
  /// reload that returns only the newest rows of a released range leaves the
  /// rest released, exactly reloadable from where the page begins, and the
  /// rows kept beside the range that belong to that rest move with it. A page
  /// that overlaps an older neighbour it cannot join by cursor is joined by
  /// the rows they share (see [_joinOverlappingOlderPage]). Rows kept beside
  /// any range that the page returns, or that followed rows it returns, come
  /// back into place (see [_settleResidues]).
  TranscriptHistoryPageMutation prependPage(
    HistoryPageWireEvent event, {
    required String requestedCursor,
    String? preserveMessageKey,
    TranscriptHistoryWorkCounter? work,
  }) {
    if (!initialized || requestedCursor.isEmpty || event.isNewer) {
      return TranscriptHistoryPageMutation(
        window: this,
        rejection: TranscriptHistoryPageRejection.stale,
      );
    }
    final insertionIndex = pages.indexWhere(
      (page) => page.olderCursor == requestedCursor,
    );
    if (insertionIndex < 0) {
      return TranscriptHistoryPageMutation(
        window: this,
        rejection: TranscriptHistoryPageRejection.stale,
      );
    }
    if (_pageMakesNoProgress(event, requestedCursor)) {
      return TranscriptHistoryPageMutation(
        window: this,
        rejection: TranscriptHistoryPageRejection.noProgress,
      );
    }
    final pageMessages = [
      for (final message in event.messages)
        boundTranscriptRow(questionState.restoreMessage(message)),
    ];
    final pageBytes = pageMessages.fold<int>(0, (sum, message) {
      work?.estimatedMessages += 1;
      return sum + estimatedAgentMessageDecodedBytes(message);
    });
    if (pageBytes > kMaxActiveTranscriptDecodedBytes ||
        pageMessages.length > kMaxActiveTranscriptMessages) {
      return TranscriptHistoryPageMutation(
        window: this,
        rejection: TranscriptHistoryPageRejection.overBudget,
      );
    }
    final released = releasedRanges[requestedCursor];
    final releasedRows = released?.pageableRows;
    // The broker's walk counts only pageable rows, so a page stands for — and
    // exactly reloads — that many, whatever state rows it also carries.
    final pagePageable = _pageableRowCount(event.messages);
    final exactReload =
        releasedRows != null &&
        releasedRows == pagePageable &&
        pagePageable > 0;
    final pageStart = event.hasMore ? event.cursor : null;
    final partialReload =
        releasedRows != null &&
        pagePageable > 0 &&
        pagePageable < releasedRows &&
        pageStart != null;
    // A range whose row count is unknown (the gap a capped reconnect left) is
    // closed only once the page meets the run before it.
    final openRange = released != null && releasedRows == null;
    // An exact reload of a range whose unreloadable rows were kept takes them
    // back into place; a partial one takes those that followed its rows and
    // leaves the rest beside what is still released; any other reload leaves
    // them beside it.
    final residue = pages[insertionIndex];
    final residueHere =
        residue.isResidue &&
        residue.olderCursor == requestedCursor &&
        residue.newerCursor == requestedCursor;
    final weaves = exactReload && residueHere;
    final woven = weaves ? _weaveResidue(pageMessages, residue) : null;
    final inserted = TranscriptHistoryPage(
      messages: woven?.messages ?? pageMessages,
      olderCursor: exactReload ? released!.olderCursor : pageStart,
      newerCursor: requestedCursor,
      isTail: false,
      estimatedBytes: woven == null ? pageBytes : null,
      reloadLimit: pagePageable,
      liveOnlyRows: woven?.liveOnly ?? const [],
    );
    final candidate = <TranscriptHistoryPage>[
      ...pages.take(insertionIndex),
      inserted,
      ...pages.skip(weaves ? insertionIndex + 1 : insertionIndex),
    ];
    var insertedPage = inserted;
    var closesOpenRange = false;
    // Where the open range began in the page: after the last of its rows the
    // run before it already held (null: at its start).
    String? openRangeStart;
    if (insertionIndex > 0) {
      final previous = candidate[insertionIndex - 1];
      final meetsOpenRange =
          openRange &&
          previous.newerCursor != null &&
          previous.newerCursor == released.olderCursor;
      if (previous.newerCursor == null ||
          previous.newerCursor != inserted.olderCursor) {
        final joined = _joinOverlappingOlderPage(
          previous,
          inserted,
          protectedKey: preserveMessageKey,
        );
        if (joined != null) {
          if (meetsOpenRange) {
            closesOpenRange = true;
            final before = <String>{
              for (final message in previous.messages)
                ?stableTranscriptMessageKey(message),
            };
            for (final message in inserted.messages) {
              final key = stableTranscriptMessageKey(message);
              if (key != null && before.contains(key)) openRangeStart = key;
            }
          }
          insertedPage = joined.newer;
          candidate[insertionIndex] = insertedPage;
          if (joined.page == null) {
            candidate.removeAt(insertionIndex - 1);
          } else {
            candidate[insertionIndex - 1] = joined.page!;
          }
        }
      } else {
        closesOpenRange = meetsOpenRange;
      }
    }
    final settled = _settleResidues(
      candidate,
      insertedPage,
      released: releasedRanges,
      keptAfter: false,
    );
    var nextPages = settled.pages;
    insertedPage = settled.inserted;
    final nextReleased = Map<String, TranscriptReleasedRange>.of(
      releasedRanges,
    )..remove(requestedCursor);
    if (closesOpenRange && residueHere) {
      // Every row kept beside the range has its place in the joined run: a
      // row that led the range where the range began.
      final at = nextPages.indexWhere(
        (page) =>
            page.isResidue &&
            page.olderCursor == requestedCursor &&
            page.newerCursor == requestedCursor,
      );
      if (at >= 0) {
        nextPages = List<TranscriptHistoryPage>.of(nextPages);
        final kept = nextPages.removeAt(at);
        // One that followed a row of the run after the range goes there.
        final split = _residueRowsIntoRun(kept, {
          for (final message in insertedPage.messages)
            ?stableTranscriptMessageKey(message),
        }, nextPages.sublist(at));
        nextPages.replaceRange(at, nextPages.length, split.run);
        final insertedAt = nextPages.indexWhere(
          (page) => identical(page, insertedPage),
        );
        final rest = split.residue;
        if (rest != null) {
          insertedPage = _weaveRowsInto(insertedPage, [
            for (var index = 0; index < rest.messages.length; index++)
              (
                message: rest.messages[index],
                anchor: rest.residueAnchors![index] ?? openRangeStart,
              ),
          ]);
          nextPages[insertedAt] = insertedPage;
        }
      }
    }
    String? remainderStart;
    if (partialReload) {
      remainderStart = pageStart;
      nextReleased[pageStart] = TranscriptReleasedRange(
        olderCursor: released!.olderCursor,
        pageableRows: releasedRows - pagePageable,
      );
    } else if (openRange && !closesOpenRange) {
      remainderStart = _consumeBackwardOpenRange(
        nextReleased,
        behind: released.olderCursor,
        reached: pageStart,
        stop: insertionIndex > 0 ? pages[insertionIndex - 1].newerCursor : null,
      );
    }
    if (remainderStart != null) {
      if (residueHere) {
        // What is left of the residue belongs to the rest of the range, so it
        // sits where that rest now ends: before this page.
        nextPages = List<TranscriptHistoryPage>.of(nextPages);
        final at = nextPages.indexWhere(
          (page) =>
              page.isResidue &&
              page.olderCursor == requestedCursor &&
              page.newerCursor == requestedCursor,
        );
        if (at >= 0) {
          final rest = nextPages.removeAt(at);
          final insertedAt = nextPages.indexWhere(
            (page) => identical(page, insertedPage),
          );
          nextPages.insert(
            insertedAt,
            rest._copyWith(
              olderCursor: remainderStart,
              newerCursor: remainderStart,
            ),
          );
        }
      }
    }
    final fitted = _fitTranscriptBudget(
      nextPages,
      nextReleased,
      protectedKey: preserveMessageKey,
      pinned: insertedPage,
      shedTail: false,
      notWaiting: questionState.withdrawnRequestIds,
      work: work,
    );
    if (!fitted.fits) {
      return TranscriptHistoryPageMutation(
        window: this,
        rejection: TranscriptHistoryPageRejection.overBudget,
      );
    }
    return TranscriptHistoryPageMutation(
      window: _with(
        pages: fitted.pages,
        // The attach-tail count no longer describes the active page table once
        // one older page is present. Explicit gaps carry the truthful scope.
        latestHistoryTruncation: null,
        releasedRanges: fitted.released,
      ),
      adoptedSessionStart: exactReload && released!.olderCursor == null,
    );
  }
}

/// Fits [input] into the active count and decoded-byte budget, and the open
/// tail into its own allowance ([kMaxOpenTranscriptTailMessages],
/// [kMaxOpenTranscriptTailDecodedBytes]).
///
/// Releases, in order, until both fit:
///
/// 1. Whole non-tail pages, farthest from the focus first. The focus is the
///    page holding [protectedKey] (the reader's row), else [pinned] (a page
///    being inserted), else the open tail. Neither the focus, [pinned], nor
///    the page holding [protectedKey] is ever released. Each release is
///    remembered as a [TranscriptReleasedRange] so the reload is exact.
///    Rows of such a page that no reload can return (live-only rows sealed
///    with a block) stay behind as a residue beside the reloadable gap, and an
///    exact reload weaves them back into place.
/// 2. The open tail's broker block, when [releaseTailBlock]: released whole,
///    leaving the tail's live rows behind the block's end boundary — or, when
///    the block holds the reader's row, split off as its own page instead.
///    Then, when [shedTail] and still over the budget, residues, farthest
///    first: their rows go, and a marker notes that never-saved rows were
///    released there.
/// 3. When [shedTail], the tail's oldest live rows. These were delivered since
///    the last broker boundary, so no cursor reaches them: the tail is marked
///    [TranscriptHistoryPage.headReleased] and the range reads as needing a
///    reconnect. The reader's row is split off rather than dropped, and the
///    newest row always stays.
///
/// An approval or question card still waiting for an answer (see
/// [_pinnedActionableRequests]) is never released by steps 2b and 3: it is
/// the only place the reader can answer it. It keeps its place (in its
/// residue, or at the tail's head, where the rows after it are released
/// instead), and no phase of the budget counts it, so the window can exceed
/// the budget by those rows: at most [kMaxPinnedActionableRequests] of them
/// and [kMaxPinnedActionableRequestBytes] between them, or the newest one
/// alone whatever its size.
/// Steps 1 and 2 still release the pages and blocks such a card was saved in,
/// since a reload returns it.
///
/// The reader's page is the one exception to the budget. Phase 1 still counts
/// it, so other older pages give way to it first (they reload exactly), but
/// phases 2 and 3 and the refusal below measure everything EXCEPT a non-tail
/// reader page: however large that page is, the open tail keeps its whole
/// allowance and no live row is released on its account.
///
/// Without [shedTail] a window that still does not fit is refused (`fits`
/// false) and [input] is returned unchanged. With it, the result can exceed
/// the budget only by the reader's page or one row whose shape cannot be
/// shortened.
///
/// A released residue leaves a marker unless a marker already touches its
/// boundary, and at most [kMaxReleasedResidueMarkers] markers stay; one given
/// up past that is reported as `unsavedOverflow`, so the window can still say
/// that never-saved rows were released.
({
  List<TranscriptHistoryPage> pages,
  Map<String, TranscriptReleasedRange> released,
  bool fits,
  bool unsavedOverflow,
})
_fitTranscriptBudget(
  List<TranscriptHistoryPage> input,
  Map<String, TranscriptReleasedRange> releasedRanges, {
  String? protectedKey,
  TranscriptHistoryPage? pinned,
  bool releaseTailBlock = true,
  bool shedTail = true,
  Set<String> notWaiting = const {},
  TranscriptHistoryWorkCounter? work,
}) {
  var entries = 0;
  var bytes = 0;
  for (final page in input) {
    entries += page.messages.length;
    bytes += page.estimatedBytes;
  }
  // Rows the budget does not count: unanswered cards no step releases.
  var exempt = (rows: 0, bytes: 0);
  var pinnedRequests = const <String>{};
  bool isPinned(AgentMessage message) =>
      pinnedRequests.isNotEmpty &&
      _isActionableRequestRow(message) &&
      pinnedRequests.contains(message.raw['requestId']);
  ({int rows, int bytes}) pinnedWeight(Iterable<AgentMessage> messages) {
    var rows = 0;
    var bytes = 0;
    for (final message in messages) {
      if (!isPinned(message)) continue;
      rows += 1;
      bytes += estimatedAgentMessageDecodedBytes(message);
    }
    return (rows: rows, bytes: bytes);
  }

  bool over() =>
      entries - exempt.rows > kMaxActiveTranscriptMessages ||
      bytes - exempt.bytes > kMaxActiveTranscriptDecodedBytes;
  TranscriptHistoryPage? measuredTail;
  var tailExempt = (rows: 0, bytes: 0);
  bool tailOver(List<TranscriptHistoryPage> pages) {
    final tailAt = pages.lastIndexWhere((page) => page.isTail);
    if (tailAt < 0) return false;
    final tail = pages[tailAt];
    if (!identical(tail, measuredTail)) {
      measuredTail = tail;
      tailExempt = pinnedWeight(tail.messages);
    }
    return tail.messages.length - tailExempt.rows >
            kMaxOpenTranscriptTailMessages ||
        tail.estimatedBytes - tailExempt.bytes >
            kMaxOpenTranscriptTailDecodedBytes;
  }

  if (!over() && !tailOver(input)) {
    return (
      pages: input,
      released: releasedRanges,
      fits: true,
      unsavedOverflow: false,
    );
  }
  pinnedRequests = _pinnedActionableRequests(input, notWaiting: notWaiting);
  if (pinnedRequests.isNotEmpty) measuredTail = null;
  var unsavedOverflow = false;

  final pages = List<TranscriptHistoryPage>.of(input);
  final released = Map<String, TranscriptReleasedRange>.of(releasedRanges);
  void remember(String? newerCursor, TranscriptReleasedRange range) {
    if (newerCursor == null) return;
    released
      ..remove(newerCursor)
      ..[newerCursor] = range;
    while (released.length > kMaxReleasedTranscriptRanges) {
      released.remove(released.keys.first);
    }
  }

  int protectedIndex() => protectedKey == null
      ? -1
      : pages.indexWhere(
          (page) => page.containsStableKey(protectedKey, work: work),
        );
  TranscriptHistoryPage? readerPage() {
    final at = protectedIndex();
    return at < 0 ? null : pages[at];
  }

  // The pinned rows no step releases: those in residues and in the tail, and
  // not in a non-tail reader page, which the budget leaves out whole.
  void measureExempt() {
    if (pinnedRequests.isEmpty) return;
    final reader = readerPage();
    var rows = 0;
    var bytes = 0;
    for (final page in pages) {
      if (!page.isTail && (!page.isResidue || identical(page, reader))) {
        continue;
      }
      final weight = pinnedWeight(page.messages);
      rows += weight.rows;
      bytes += weight.bytes;
    }
    exempt = (rows: rows, bytes: bytes);
  }

  measureExempt();

  // The budget with a non-tail reader page left out of the count. The cards
  // waiting for an answer are left out as [over] leaves them out (the reader
  // page's own are already outside [exempt]); otherwise a phase this measure
  // drives would release live rows the one before it had just made room for.
  bool overBeyond(TranscriptHistoryPage? reader) {
    if (reader == null || reader.isTail) return over();
    return entries - reader.messages.length - exempt.rows >
            kMaxActiveTranscriptMessages ||
        bytes - reader.estimatedBytes - exempt.bytes >
            kMaxActiveTranscriptDecodedBytes;
  }

  // 1. Whole non-tail pages, farthest from the focus first.
  while (true) {
    measureExempt();
    if (!over()) break;
    final protectedAt = protectedIndex();
    final pinnedAt = pinned == null
        ? -1
        : pages.indexWhere((page) => identical(page, pinned));
    final tailAt = pages.lastIndexWhere((page) => page.isTail);
    final focus = protectedAt >= 0
        ? protectedAt
        : pinnedAt >= 0
        ? pinnedAt
        : tailAt >= 0
        ? tailAt
        : pages.length - 1;
    // A residue holds only rows no reload can return (see step 2b), and a
    // marker holds nothing.
    var victim = -1;
    var victimDistance = -1;
    for (var index = 0; index < pages.length; index++) {
      final candidate = pages[index];
      if (candidate.isTail ||
          index == protectedAt ||
          index == pinnedAt ||
          candidate.isResidue ||
          candidate.isReleasedResidueMarker) {
        continue;
      }
      final distance = (index - focus).abs();
      if (distance > victimDistance) {
        victim = index;
        victimDistance = distance;
      }
    }
    if (victim < 0) break;
    final page = pages.removeAt(victim);
    entries -= page.messages.length;
    bytes -= page.estimatedBytes;
    if (page.headReleased) continue;
    final kept = _unreloadableRows(page, pages);
    if (kept.isNotEmpty) {
      // The rows no reload can return stay, in order, beside the released
      // range: zero-width at its newer boundary, so the reloadable gap stays
      // before them. A range with nothing to reload keeps its boundaries.
      final nothingToReload = page.reloadLimit == 0;
      final at = nothingToReload ? page.olderCursor : page.newerCursor;
      final residue = TranscriptHistoryPage(
        messages: [for (final row in kept) row.message],
        olderCursor: at,
        newerCursor: page.newerCursor,
        isTail: false,
        reloadLimit: 0,
        liveOnlyRows: [for (var index = 0; index < kept.length; index++) index],
        residueAnchors: [for (final row in kept) row.anchor],
      );
      pages.insert(victim, residue);
      entries += residue.messages.length;
      bytes += residue.estimatedBytes;
      if (nothingToReload) continue;
      remember(
        page.newerCursor,
        TranscriptReleasedRange(
          olderCursor: page.olderCursor,
          pageableRows: page.reloadLimit,
        ),
      );
      continue;
    }
    if (page.reloadLimit == 0) {
      // Nothing a page can return lies in this range (an empty terminal page,
      // or only state rows). Its newer neighbour takes its older boundary —
      // the broker's own, and equivalent for paging, since a backward walk
      // skips such rows — so nothing needs reloading and a released start of
      // history stays the start.
      if (victim < pages.length &&
          page.newerCursor != null &&
          pages[victim].olderCursor == page.newerCursor) {
        pages[victim] = pages[victim]._copyWith(olderCursor: page.olderCursor);
      }
      continue;
    }
    remember(
      page.newerCursor,
      TranscriptReleasedRange(
        olderCursor: page.olderCursor,
        pageableRows: page.reloadLimit,
      ),
    );
  }

  // 2. The open tail's broker block.
  var reader = readerPage();
  if ((overBeyond(reader) || tailOver(pages)) && releaseTailBlock) {
    final tailAt = pages.lastIndexWhere((page) => page.isTail);
    final tail = tailAt < 0 ? null : pages[tailAt];
    final blockRows = tail?.blockRows;
    final blockEnd = tail?.blockEndCursor;
    if (tail != null &&
        blockRows != null &&
        blockRows > 0 &&
        blockEnd != null &&
        !tail.headReleased) {
      final block = tail.messages.sublist(0, blockRows);
      final blockBytes = _estimatedMessagesBytes(block);
      // Rows the block's reload cannot return stay, in order, at the head of
      // the tail; only the block's own rows are released.
      final liveOnly = {
        for (final index in tail.blockLiveOnlyRows)
          if (index < blockRows) index,
      };
      final kept = [for (final index in liveOnly) block[index]];
      final members = [
        for (var index = 0; index < blockRows; index++)
          if (!liveOnly.contains(index)) block[index],
      ];
      final memberBytes = blockBytes - _estimatedMessagesBytes(kept);
      // A block no page can return (only state rows) leaves the tail on the
      // block's own older boundary: equivalent for paging, and nothing to
      // reload.
      final nothingPageable = tail.blockPageableRows == 0;
      final holdsReader =
          protectedKey != null &&
          members.any(
            (message) => stableTranscriptMessageKey(message) == protectedKey,
          );
      // A block kept whole as the reader's page takes its live-only rows with
      // it, in place, and stays joined to the tail at its end boundary.
      final nextTail = tail._copyWith(
        messages: [
          if (!holdsReader) ...kept,
          ...tail.messages.sublist(blockRows),
        ],
        estimatedBytes:
            tail.estimatedBytes - (holdsReader ? blockBytes : memberBytes),
        olderCursor: nothingPageable && !holdsReader
            ? tail.olderCursor
            : blockEnd,
        blockRows: 0,
        blockPageableRows: 0,
      );
      if (holdsReader) {
        pages
          ..[tailAt] = nextTail
          ..insert(
            tailAt,
            TranscriptHistoryPage(
              messages: block,
              olderCursor: tail.olderCursor,
              newerCursor: blockEnd,
              isTail: false,
              estimatedBytes: blockBytes,
              reloadLimit: tail.blockPageableRows,
              sealedFromTail: true,
              liveOnlyRows: [...liveOnly]..sort(),
            ),
          );
      } else if (nothingPageable) {
        pages[tailAt] = nextTail;
        entries -= members.length;
        bytes -= memberBytes;
      } else {
        // The rows the reload cannot return stay beside the released range,
        // as a released page's do: at its end boundary, where its reload
        // (from either edge) weaves them back into place. Kept at the tail's
        // head instead, they would drift into the next block's range and,
        // while every block is released as soon as it is sealed, pile up
        // there until the tail had to release them with no boundary.
        pages[tailAt] = nextTail._copyWith(
          messages: tail.messages.sublist(blockRows),
          estimatedBytes: tail.estimatedBytes - blockBytes,
        );
        final residue = _unreloadableRows(
          TranscriptHistoryPage(
            messages: block,
            olderCursor: tail.olderCursor,
            newerCursor: blockEnd,
            isTail: false,
            estimatedBytes: blockBytes,
            reloadLimit: tail.blockPageableRows,
            liveOnlyRows: [...liveOnly]..sort(),
          ),
          pages,
        );
        entries -= blockRows;
        bytes -= blockBytes;
        if (residue.isNotEmpty) {
          final kept = TranscriptHistoryPage(
            messages: [for (final row in residue) row.message],
            olderCursor: blockEnd,
            newerCursor: blockEnd,
            isTail: false,
            reloadLimit: 0,
            liveOnlyRows: [
              for (var index = 0; index < residue.length; index++) index,
            ],
            residueAnchors: [for (final row in residue) row.anchor],
          );
          pages.insert(tailAt, kept);
          entries += kept.messages.length;
          bytes += kept.estimatedBytes;
        }
        remember(
          blockEnd,
          TranscriptReleasedRange(
            olderCursor: tail.olderCursor,
            pageableRows: tail.blockPageableRows,
          ),
        );
      }
    }
  }
  reader = readerPage();
  measureExempt();
  // 2b. Residues, farthest from the reader first, once nothing reloadable is
  // left to release. Their rows go, and a marker says where: those rows were
  // never saved, so the notice offers no reload or reconnect, and the durable
  // rows around it still reload as usual. A card still waiting for an answer
  // stays, in its place.
  while (shedTail && overBeyond(reader)) {
    final readerAt = protectedIndex();
    final tailAt = pages.lastIndexWhere((page) => page.isTail);
    final focus = readerAt >= 0
        ? readerAt
        : tailAt >= 0
        ? tailAt
        : pages.length - 1;
    var victim = -1;
    var victimDistance = -1;
    for (var index = 0; index < pages.length; index++) {
      final candidate = pages[index];
      if (!candidate.isResidue ||
          index == readerAt ||
          candidate.messages.every(isPinned)) {
        continue;
      }
      final distance = (index - focus).abs();
      if (distance > victimDistance) {
        victim = index;
        victimDistance = distance;
      }
    }
    if (victim < 0) break;
    final residue = pages.removeAt(victim);
    entries -= residue.messages.length;
    bytes -= residue.estimatedBytes;
    final pinnedRows = <int>[
      for (var index = 0; index < residue.messages.length; index++)
        if (isPinned(residue.messages[index])) index,
    ];
    var releasedRows = residue;
    var focusAt = victim < focus ? focus - 1 : focus;
    if (pinnedRows.isNotEmpty) {
      final kept = _keepingRows(residue, pinnedRows);
      pages.insert(victim, kept);
      entries += kept.messages.length;
      bytes += kept.estimatedBytes;
      focusAt = focus;
      final pinnedAt = pinnedRows.toSet();
      releasedRows = _keepingRows(residue, [
        for (var index = 0; index < residue.messages.length; index++)
          if (!pinnedAt.contains(index)) index,
      ]);
    }
    // A residue beside an open range (the gap a capped reconnect left) keeps
    // the rows received live that its frame did not restate: a row the agent
    // saves (one with a key, of a kind history holds) is in that range and
    // returns when it fills, so only the others were never saved.
    final rangeOpen =
        released.containsKey(residue.newerCursor) &&
        released[residue.newerCursor]!.pageableRows == null;
    final unsaved = [
      for (final row in _unreloadableRows(releasedRows, pages))
        if (!rangeOpen || !_isSavedKind(row.message)) row,
    ];
    if (unsaved.isNotEmpty) {
      unsavedOverflow =
          _markReleasedResidue(pages, victim, releasedRows, focus: focusAt) ||
          unsavedOverflow;
    }
  }
  if (!overBeyond(reader) && !tailOver(pages)) {
    return (
      pages: pages,
      released: released,
      fits: true,
      unsavedOverflow: unsavedOverflow,
    );
  }
  if (!shedTail) {
    // Only the global budget can refuse; a paging request never grows the
    // tail past its allowance.
    return overBeyond(reader)
        ? (
            pages: input,
            released: releasedRanges,
            fits: false,
            unsavedOverflow: false,
          )
        : (
            pages: pages,
            released: released,
            fits: true,
            unsavedOverflow: unsavedOverflow,
          );
  }

  // 3. Rows delivered since the last broker boundary, oldest first. A card
  // still waiting for an answer keeps its place at the tail's head, and the
  // rows after it go instead.
  while (overBeyond(reader) || tailOver(pages)) {
    final tailAt = pages.lastIndexWhere((page) => page.isTail);
    if (tailAt < 0) break;
    final tail = pages[tailAt];
    var at = 0;
    while (at < tail.messages.length && isPinned(tail.messages[at])) {
      at += 1;
    }
    // The newest row always stays.
    if (at >= tail.messages.length - 1) break;
    final head = tail.messages[at];
    final headBytes = estimatedAgentMessageDecodedBytes(head);
    final blockRows = tail.blockRows;
    final readerAtHead =
        protectedKey != null &&
        stableTranscriptMessageKey(head) == protectedKey;
    // A heal must restate what was dropped; a row split off for the reader is
    // still held. A prompt not delivered yet is saved only once the agent
    // takes it, after whatever a heal restates, so no heal waits for it.
    final headKey = stableTranscriptMessageKey(head);
    final records =
        !readerAtHead && !tail.shedUnverifiable && !_isQueuedPrompt(head);
    final shedUnverifiable =
        tail.shedUnverifiable ||
        (records && (headKey == null || tail.shedKeys.length >= _kMaxShedKeys));
    // The reader's row goes with the cards ahead of it, so they keep their
    // order.
    final split = readerAtHead ? tail.messages.sublist(0, at + 1) : null;
    final nextTail = tail._copyWith(
      messages: [
        if (split == null) ...tail.messages.sublist(0, at),
        ...tail.messages.sublist(at + 1),
      ],
      estimatedBytes:
          tail.estimatedBytes -
          (split == null ? headBytes : _estimatedMessagesBytes(split)),
      headReleased: true,
      // Dropping a block row leaves no boundary before the rest of the block.
      blockRows: blockRows != null && blockRows > 0 ? null : blockRows,
      blockPageableRows: blockRows != null && blockRows > 0
          ? null
          : tail.blockPageableRows,
      shedKeys: records && !shedUnverifiable
          ? [...tail.shedKeys, headKey!]
          : shedUnverifiable
          ? const []
          : tail.shedKeys,
      shedUnverifiable: shedUnverifiable,
    );
    if (split != null) {
      final splitPage = TranscriptHistoryPage(
        messages: split,
        olderCursor: tail.olderCursor,
        newerCursor: null,
        isTail: false,
        headReleased: tail.headReleased,
        sealedFromTail: true,
      );
      pages
        ..[tailAt] = nextTail
        ..insert(tailAt, splitPage);
      reader = splitPage;
      measureExempt();
    } else {
      pages[tailAt] = nextTail;
      entries -= 1;
      bytes -= headBytes;
    }
  }
  return (
    pages: pages,
    released: released,
    fits: !overBeyond(reader),
    unsavedOverflow: unsavedOverflow,
  );
}

/// Released head rows whose keys the tail remembers for a heal; beyond this no
/// frame is trusted to restate them all.
const int _kMaxShedKeys = 2 * kMaxActiveTranscriptMessages;

/// Released-residue markers a window keeps. Each marks where rows that were
/// never saved were released; past this the one farthest from the reader is
/// given up and the window reports the release instead (see
/// [TranscriptHistoryWindow.unsavedReleasedElsewhere]).
const int kMaxReleasedResidueMarkers = 32;

/// Leaves a marker at [at] for [residue], whose rows were just released.
///
/// A marker already touching the residue's boundary absorbs it: two notices
/// side by side say nothing one does not. Returns whether a marker (the one
/// farthest from [focus]) had to be given up to stay within
/// [kMaxReleasedResidueMarkers].
bool _markReleasedResidue(
  List<TranscriptHistoryPage> pages,
  int at,
  TranscriptHistoryPage residue, {
  required int focus,
}) {
  final before = at > 0 ? pages[at - 1] : null;
  final after = at < pages.length ? pages[at] : null;
  if (before != null &&
      before.isReleasedResidueMarker &&
      before.newerCursor == residue.olderCursor) {
    pages[at - 1] = before._copyWith(newerCursor: residue.newerCursor);
    return false;
  }
  if (after != null &&
      after.isReleasedResidueMarker &&
      after.olderCursor == residue.newerCursor) {
    pages[at] = after._copyWith(olderCursor: residue.olderCursor);
    return false;
  }
  pages.insert(
    at,
    TranscriptHistoryPage(
      messages: const [],
      olderCursor: residue.olderCursor,
      newerCursor: residue.newerCursor,
      isTail: false,
      estimatedBytes: 0,
      headReleased: true,
    ),
  );
  final markers = [
    for (var index = 0; index < pages.length; index++)
      if (pages[index].isReleasedResidueMarker) index,
  ];
  if (markers.length <= kMaxReleasedResidueMarkers) return false;
  final center = focus >= at ? focus + 1 : focus;
  var farthest = markers.first;
  for (final index in markers) {
    if ((index - center).abs() > (farthest - center).abs()) farthest = index;
  }
  pages.removeAt(farthest);
  return true;
}

/// The rows of [page] no reload can return and no other page in [others]
/// holds, each with the anchor of the reloadable row it followed in [page]
/// (null when none precedes it; see [_anchorAfter]).
///
/// A row the transcript never renders (see [_isUnrenderedTranscriptRow]) is
/// not kept: the window's own projections already folded it, so releasing it
/// loses nothing the reader sees, and keeping it would make a marker claim a
/// loss.
List<({AgentMessage message, String? anchor})> _unreloadableRows(
  TranscriptHistoryPage page,
  List<TranscriptHistoryPage> others,
) {
  if (page.liveOnlyRows.isEmpty) return const [];
  Set<String>? heldElsewhere;
  final liveOnly = page.liveOnlyRows.toSet();
  final kept = <({AgentMessage message, String? anchor})>[];
  String? anchor;
  var keyless = 0;
  for (var index = 0; index < page.messages.length; index++) {
    final message = page.messages[index];
    final key = stableTranscriptMessageKey(message);
    if (liveOnly.contains(index)) {
      if (_isUnrenderedTranscriptRow(message)) continue;
      if (key != null) {
        // A row persisted since (a prompt a later frame carried) is held
        // there.
        heldElsewhere ??= {
          for (final other in others)
            for (final row in other.messages) ?stableTranscriptMessageKey(row),
        };
        if (heldElsewhere.contains(key)) continue;
      }
      kept.add((
        message: message,
        anchor: page.isResidue
            ? page.residueAnchors![index]
            : anchor == null
            ? null
            : _anchorAfter(anchor, keyless),
      ));
      // A row without a key kept here is counted too: it goes back before
      // the rows kept after it, and so does its saved copy if it has one.
      if (key != null) continue;
    }
    if (!isBackwardPageableTranscriptMessage(message)) continue;
    if (key != null) {
      anchor = key;
      keyless = 0;
    } else {
      keyless += 1;
    }
  }
  return kept;
}

/// Whether [message] is an approval or question card, or its answer: rows the
/// client shows while the agent waits, which no history holds.
bool _isInteractionCard(AgentMessage message) => switch (message.type) {
  AgentMessageType.permissionRequest ||
  AgentMessageType.permissionResolved ||
  AgentMessageType.questionRequest ||
  AgentMessageType.questionResolved => true,
  _ => false,
};

/// Whether [message] is a row the agent saves where it was shown: one with a
/// key, of a kind history holds, that is no card.
bool _isSavedKind(AgentMessage message) =>
    stableTranscriptMessageKey(message) != null &&
    isBackwardPageableTranscriptMessage(message) &&
    !_isInteractionCard(message);

/// Whether [message] never appears as a transcript row: pinned state,
/// telemetry, or a status tick. Its reading lives in the window's projections.
bool _isUnrenderedTranscriptRow(AgentMessage message) =>
    message.type == AgentMessageType.status ||
    isSessionLiveStateMessage(message) ||
    isSessionTelemetryMessage(message);

/// Whether [message] is a reading a repeat of which may be held once: a
/// telemetry reading or a status tick. A live-state event is never one: the
/// projection folds it in order, so a repeat after other rows still changes
/// what it shows.
bool _isRepeatableReading(AgentMessage message) =>
    message.type == AgentMessageType.status ||
    isSessionTelemetryMessage(message);

/// Whether [message], a row without a key the transcript never renders, has
/// the same content as the newest row of its type in [rows].
bool _repeatsLatestReading(
  List<AgentMessage> rows,
  AgentMessage message, {
  TranscriptHistoryWorkCounter? work,
}) {
  for (var index = rows.length - 1; index >= 0; index--) {
    work?.inspectedMessages += 1;
    final row = rows[index];
    if (row.type != message.type || row.raw['type'] != message.raw['type']) {
      continue;
    }
    return stableTranscriptMessageKey(row) == null &&
        _keylessRowSignature(row) == _keylessRowSignature(message);
  }
  return false;
}

/// Unanswered cards the budget keeps at most: the newest this many.
const int kMaxPinnedActionableRequests = 16;

/// Decoded estimate of the unanswered cards the budget keeps, newest first.
/// The newest card is kept whatever its size: it is one row whose shape
/// cannot be shortened, and the only place the reader can answer it.
const int kMaxPinnedActionableRequestBytes =
    kMaxActiveTranscriptDecodedBytes ~/ 4;

/// Whether [message] is an approval or question card the reader can act on.
bool _isActionableRequestRow(AgentMessage message) =>
    (message.type == AgentMessageType.permissionRequest ||
        message.type == AgentMessageType.questionRequest) &&
    !message.requestIsReadOnly &&
    message.raw['requestId'] is String &&
    (message.raw['requestId'] as String).isNotEmpty;

/// The request ids of the cards in [pages] still waiting for an answer: not
/// read-only (a question settled on this connection is restored read-only
/// even where its resolution was released), with no resolution held and not
/// in [notWaiting] (cards this connection's attach did not send again). Only
/// the newest count, at most [kMaxPinnedActionableRequests] of them and
/// [kMaxPinnedActionableRequestBytes] between them (the newest always), so a
/// session that never resolves its requests cannot hold the window past its
/// budget without bound.
Set<String> _pinnedActionableRequests(
  List<TranscriptHistoryPage> pages, {
  Set<String> notWaiting = const {},
}) {
  final answered = <String>{};
  final waiting = <AgentMessage>[];
  for (final page in pages) {
    for (final message in page.messages) {
      if (message.type == AgentMessageType.permissionResolved ||
          message.type == AgentMessageType.questionResolved) {
        final id = message.raw['requestId'];
        if (id is String) answered.add(id);
      } else if (_isActionableRequestRow(message)) {
        waiting.add(message);
      }
    }
  }
  final pinned = <String>{};
  var bytes = 0;
  for (final card in waiting.reversed) {
    final id = card.raw['requestId'] as String;
    if (answered.contains(id) ||
        pinned.contains(id) ||
        notWaiting.contains(id)) {
      continue;
    }
    final size = estimatedAgentMessageDecodedBytes(card);
    if (pinned.isNotEmpty && bytes + size > kMaxPinnedActionableRequestBytes) {
      break;
    }
    pinned.add(id);
    bytes += size;
    if (pinned.length >= kMaxPinnedActionableRequests) break;
  }
  return pinned;
}

/// The request ids of the actionable cards in [pages].
Set<String> _actionableRequestIds(List<TranscriptHistoryPage> pages) => {
  for (final page in pages)
    for (final message in page.messages)
      if (_isActionableRequestRow(message)) message.raw['requestId'] as String,
};

/// The frame range an incremental frame adds to the tail's broker block, as
/// `[0, blockRows)` of the returned rows, with no row moved.
///
/// A block's reload from its end boundary returns the block's own rows and
/// the rows the frame placed. The reconciliation can leave a retained row the
/// frame does not carry among them: a live row not yet persisted (a prompt
/// just sent), a row the agent never persists (an approval card), a
/// broker-injected or derived overlay. Such a row keeps its reconciled
/// position — moving it would reorder what the reader sees — and is listed in
/// `liveOnly` instead, so releasing the block keeps it rather than dropping a
/// row the reload cannot return.
///
/// A row the frame placed is recognised by its stable key (the merge may keep
/// the retained instance, as for a superseded frame's state row), and a
/// keyless one by identity with the frame's own row.
///
/// [ownedBlockRows] is how many leading rows of [retained] the block already
/// holds, of which [ownedLiveOnly] are not its own; null means unknown, and
/// the rows ahead of the frame's first row are taken as the contiguous durable
/// start (a snapshot or an older broker's frame), less the cards among them.
/// The block's own rows stay inside the returned range wherever the merge put
/// them, and only a row that is neither the frame's nor the block's counts as
/// live-only.
///
/// With [splitOwned], when every row the block held sits ahead of the frame's
/// first row, those rows (and the live-only rows among them) are returned
/// apart as `sealed` — the caller seals them, in place, as the previous
/// block's own page — and the new range holds only the frame's rows and
/// live-only ones. When a row of the block follows the frame's first row, the
/// live delivery order differed from the persist order, and no prefix is the
/// previous block's range: nothing is sealed, and the block grows through the
/// frame from its own older boundary.
///
/// A frame that restates a reloadable row the block already holds began
/// before the block's end (a reconnect from a stale cursor), so its range
/// overlaps the block's: nothing is sealed either, and the block's rows the
/// frame restated are returned as `restatedPageable`, for the caller to count
/// once in the grown block's reload.
({
  List<AgentMessage> sealed,
  List<int> sealedLiveOnly,
  List<AgentMessage> messages,
  int blockRows,
  List<int> liveOnly,
  int restatedPageable,
})
_sealFrameRange(
  List<AgentMessage> merged,
  int lastFrameIndex, {
  required List<AgentMessage> frame,
  required List<AgentMessage> retained,
  required int? ownedBlockRows,
  List<int> ownedLiveOnly = const [],
  bool splitOwned = false,
}) {
  if (lastFrameIndex < 0) {
    return (
      sealed: const <AgentMessage>[],
      sealedLiveOnly: const <int>[],
      messages: merged,
      blockRows: 0,
      liveOnly: const <int>[],
      restatedPageable: 0,
    );
  }
  final frameKeys = <String>{
    for (final message in frame) ?stableTranscriptMessageKey(message),
  };
  final frameRows = Set<AgentMessage>.identity()..addAll(frame);
  bool placedByFrame(AgentMessage message) {
    final key = stableTranscriptMessageKey(message);
    return key == null ? frameRows.contains(message) : frameKeys.contains(key);
  }

  final retainedRows = Set<AgentMessage>.identity()..addAll(retained);
  final owned = Set<AgentMessage>.identity();
  if (ownedBlockRows != null) {
    final notOwned = ownedLiveOnly.toSet();
    for (
      var index = 0;
      index < ownedBlockRows && index < retained.length;
      index++
    ) {
      if (!notOwned.contains(index)) owned.add(retained[index]);
    }
  } else {
    for (final message in merged) {
      if (placedByFrame(message) || !retainedRows.contains(message)) break;
      // No history holds a card (an approval or a question), so no frame
      // vouched for one a snapshot kept: it is the tail's own live row.
      if (!_isInteractionCard(message)) owned.add(message);
    }
  }
  // The newest row the block held that the merge kept as the tail's own copy
  // (a row the frame restates normally becomes the frame's copy). The merge
  // keeps such a row after the frame row it followed, which can be past the
  // frame's last row.
  var lastOwned = -1;
  for (var index = merged.length - 1; index >= 0; index--) {
    if (owned.contains(merged[index])) {
      lastOwned = index;
      break;
    }
  }
  var restatedPageable = 0;
  for (final message in owned) {
    if (placedByFrame(message) &&
        isBackwardPageableTranscriptMessage(message)) {
      restatedPageable += 1;
    }
  }
  var sealedCount = 0;
  if (splitOwned && restatedPageable == 0) {
    var firstPlaced = 0;
    while (firstPlaced < lastFrameIndex &&
        !placedByFrame(merged[firstPlaced])) {
      firstPlaced += 1;
    }
    // Rows of the block after the frame's first row mean the frame's rows
    // were delivered among them: no prefix is the previous block's range.
    if (lastOwned <= firstPlaced) {
      for (var index = firstPlaced - 1; index >= 0; index--) {
        if (owned.contains(merged[index])) {
          sealedCount = index + 1;
          break;
        }
      }
    }
  }
  final rest = sealedCount == 0 ? merged : merged.sublist(sealedCount);
  final blockRows =
      (lastOwned > lastFrameIndex ? lastOwned : lastFrameIndex) +
      1 -
      sealedCount;
  final liveOnly = <int>[
    for (var index = 0; index < blockRows; index++)
      if (!placedByFrame(rest[index]) && !owned.contains(rest[index])) index,
  ];
  return (
    sealed: sealedCount == 0
        ? const <AgentMessage>[]
        : merged.sublist(0, sealedCount),
    sealedLiveOnly: <int>[
      for (var index = 0; index < sealedCount; index++)
        if (!owned.contains(merged[index])) index,
    ],
    messages: rest,
    blockRows: blockRows,
    liveOnly: liveOnly,
    restatedPageable: restatedPageable,
  );
}

/// Joins [older] to a newer page [newer] that overlaps it, by trimming the
/// rows of [older] that [newer] also carries.
///
/// Used where cursor equality cannot relate two pages: a page kept across a
/// reset beside the replacement, or a reload whose walk overshot a released
/// range. Only rows whose identity is position-unique in a native history
/// (user messages, tool calls and results, model output and thinking) are
/// evidence; a latest-wins state key recurs throughout a session and proves
/// nothing about position. The first evidence row of [older] that [newer]
/// also holds marks where [newer] begins, so [older] keeps only the rows
/// before it and takes [newer]'s older boundary as its newer one — adjacency
/// by the broker's own cursor, never one derived locally.
///
/// The trimmed rows of [older] that no reload returns (an approval card, a
/// prompt not yet saved) are not [newer]'s to carry, so they are woven into
/// it after the rows they followed (returned as `newer`) instead of being
/// trimmed away — unless [newer] holds them after all: by key, or, for a row
/// without one, by what it says between the rows it came between.
///
/// Returns null when there is no evidence of overlap, or when trimming would
/// drop the reader's row ([protectedKey]) that [newer] does not hold. A
/// returned null `page` means [older] is wholly covered.
({TranscriptHistoryPage? page, TranscriptHistoryPage newer})?
_joinOverlappingOlderPage(
  TranscriptHistoryPage older,
  TranscriptHistoryPage newer, {
  String? protectedKey,
}) {
  final boundary = newer.olderCursor;
  if (boundary == null || newer.headReleased) return null;
  final evidence = <String>{
    for (final message in newer.messages)
      if (_isOverlapEvidence(message)) ?stableTranscriptMessageKey(message),
  };
  if (evidence.isEmpty) return null;
  var first = -1;
  for (var index = 0; index < older.messages.length; index++) {
    final message = older.messages[index];
    if (!_isOverlapEvidence(message)) continue;
    final key = stableTranscriptMessageKey(message);
    if (key != null && evidence.contains(key)) {
      first = index;
      break;
    }
  }
  if (first < 0) return null;
  if (protectedKey != null) {
    final readerAt = older.indexOfStableKey(protectedKey);
    if (readerAt >= first && !newer.containsStableKey(protectedKey)) {
      return null;
    }
  }
  final liveOnly = older.isResidue
      ? {for (var index = 0; index < older.messages.length; index++) index}
      : older.liveOnlyRows.toSet();
  final trimmed = <_AnchoredRow>[];
  // Each carried row follows the row before it, whichever that was: a row
  // [newer] also holds places it exactly, and one it does not (another row
  // no reload returns) keeps the carried rows in their order. Rows without
  // a key between them count whether or not [newer] holds them: carried,
  // they go before the rows carried after them too.
  String? anchor;
  var keyless = 0;
  for (var index = 0; index < older.messages.length; index++) {
    final message = older.messages[index];
    final key = stableTranscriptMessageKey(message);
    if (liveOnly.contains(index) &&
        index >= first &&
        !_isUnrenderedTranscriptRow(message)) {
      trimmed.add((
        message: message,
        anchor: anchor == null ? null : _anchorAfter(anchor, keyless),
      ));
    }
    if (!isBackwardPageableTranscriptMessage(message)) continue;
    if (key != null) {
      anchor = key;
      keyless = 0;
    } else {
      keyless += 1;
    }
  }
  final returned = _rowsReturnedBy(newer.messages, trimmed);
  final joinedNewer = _weaveRowsInto(newer, [
    for (var index = 0; index < trimmed.length; index++)
      if (!returned.contains(index)) trimmed[index],
  ]);
  if (first == 0) return (page: null, newer: joinedNewer);
  return (
    page: older._copyWith(
      messages: older.messages.sublist(0, first),
      newerCursor: boundary,
      reloadLimit: null,
    ),
    newer: joinedNewer,
  );
}

/// Keys of rows in [frame] that a page in [older] already holds as a durable
/// row with a position in history (see [_isReconcilePositionAnchor]).
///
/// Only a page with a newer boundary counts: a residue or a row no reload
/// returns has no durable place, and a page split from the tail for the reader
/// (no newer boundary) is healed by the tail's own rules.
Set<String> _restatedOlderRows(
  Iterable<TranscriptHistoryPage> older,
  List<AgentMessage> frame,
) {
  final framed = <String>{
    for (final message in frame)
      if (_isReconcilePositionAnchor(message))
        ?stableTranscriptMessageKey(message),
  };
  if (framed.isEmpty) return const {};
  final restated = <String>{};
  for (final page in older) {
    if (page.isResidue || page.isTail || page.newerCursor == null) continue;
    final liveOnly = page.liveOnlyRows.toSet();
    for (var index = 0; index < page.messages.length; index++) {
      if (liveOnly.contains(index)) continue;
      final key = stableTranscriptMessageKey(page.messages[index]);
      if (key != null && framed.contains(key)) restated.add(key);
    }
  }
  return restated;
}

List<AgentMessage> _withoutKeys(
  List<AgentMessage> messages,
  Set<String> keys,
) => [
  for (final message in messages)
    if (!keys.contains(stableTranscriptMessageKey(message))) message,
];

bool _isOverlapEvidence(AgentMessage message) => switch (message.type) {
  AgentMessageType.userMessage ||
  AgentMessageType.toolCall ||
  AgentMessageType.toolResult ||
  AgentMessageType.modelOutput ||
  AgentMessageType.thinking => stableTranscriptMessageKey(message) != null,
  _ => false,
};

List<TranscriptHistoryPage> _mapQuestionPages(
  List<TranscriptHistoryPage> pages,
  AgentMessage Function(AgentMessage) restoreMessage,
) => List.unmodifiable([
  for (final page in pages)
    if (page.messages.every((m) => identical(m, restoreMessage(m))))
      page
    else
      page._copyWith(messages: page.messages.map(restoreMessage).toList()),
]);

TranscriptHistoryGapSegment? _historyGapBetween(
  TranscriptHistoryPage previous,
  TranscriptHistoryPage page,
) {
  final connected =
      previous.newerCursor != null && previous.newerCursor == page.olderCursor;
  if (page.isReleasedResidueMarker) {
    // The marker's own notice sits where it is. Durable rows missing before
    // it still reload; once they are back the two runs meet at the marker's
    // boundary and the notice shows in place.
    if (connected || page.olderCursor == null) {
      return TranscriptHistoryGapSegment(
        id:
            'history-gap-${previous.newerCursor ?? 'local'}-'
            '${page.olderCursor ?? 'tail'}-unsaved',
        kind: TranscriptHistoryGapKind.unsavedReleased,
      );
    }
  } else if (page.headReleased) {
    return TranscriptHistoryGapSegment(
      id:
          'history-gap-${previous.newerCursor ?? 'local'}-'
          '${page.olderCursor ?? 'tail'}-released',
      kind: TranscriptHistoryGapKind.reconnectRequired,
    );
  }
  if (connected) return null;
  final reloadCursor = page.olderCursor;
  return TranscriptHistoryGapSegment(
    id:
        'history-gap-${previous.newerCursor ?? 'local'}-'
        '${page.olderCursor ?? 'tail'}',
    kind: reloadCursor == null
        ? TranscriptHistoryGapKind.reconnectRequired
        : TranscriptHistoryGapKind.reloadable,
    reloadCursor: reloadCursor,
    forwardCursor: reloadCursor == null ? null : previous.newerCursor,
  );
}
