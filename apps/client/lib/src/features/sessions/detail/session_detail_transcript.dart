part of 'session_detail_page.dart';

/// Keeps a following viewport pinned to the real tail during layout (U5b).
///
/// U5's opening reveal stays exactly as it is: it is the only correct answer
/// for an authoritative transcript REPLACEMENT, where the list must not paint
/// at all until the actual last row is measured. This physics covers the other,
/// far more frequent case — ordinary growth of an already-visible transcript.
///
/// The old mechanism was a post-frame `jumpTo(maxScrollExtent)` re-armed from
/// every build. That is one frame too late by construction: appending the
/// optimistic prompt, a streamed chunk, a tool row, or the terminal footer
/// paints once at the pre-append offset (the new content below the fold), and
/// only then corrects — the visible drop. And because a lazy list's
/// `maxScrollExtent` is an ESTIMATE until the trailing rows are built, the
/// correction itself lands short of or past the real end, which is the upward
/// reflection that follows.
///
/// [ScrollPhysics.adjustPositionForNewDimensions] is called from
/// `ScrollPosition.applyContentDimensions` — inside layout, before anything is
/// painted — and a returned offset is applied with `correctPixels`, which makes
/// the viewport re-run layout in the SAME frame. Pinning to the new extent
/// means every painted frame is already settled on the tail, and each later
/// estimate correction re-pins the same way. No animation, no timer, no delay,
/// no repeated post-frame chase, and nothing is hidden while it happens.
class _TailFollowingScrollPhysics extends ScrollPhysics {
  const _TailFollowingScrollPhysics({
    required this.shouldFollowTail,
    super.parent,
  });

  /// Read at correction time, never captured: the user scrolling away must stop
  /// the correction on the very next layout, not on the next rebuild.
  final bool Function() shouldFollowTail;

  @override
  _TailFollowingScrollPhysics applyTo(ScrollPhysics? ancestor) =>
      _TailFollowingScrollPhysics(
        shouldFollowTail: shouldFollowTail,
        parent: buildParent(ancestor),
      );

  @override
  double adjustPositionForNewDimensions({
    required ScrollMetrics oldPosition,
    required ScrollMetrics newPosition,
    required bool isScrolling,
    required double velocity,
  }) {
    final adjusted = super.adjustPositionForNewDimensions(
      oldPosition: oldPosition,
      newPosition: newPosition,
      isScrolling: isScrolling,
      velocity: velocity,
    );
    // A drag or a fling owns the offset outright; correcting under the user's
    // finger is the one motion that would feel like the view fighting back.
    if (isScrolling || velocity != 0) return adjusted;
    if (!shouldFollowTail()) return adjusted;
    return newPosition.maxScrollExtent;
  }
}

String _messageIdentity(AgentMessage message) {
  final type = message.type.wireValue;
  // An app-sent user row keeps ONE identity across its optimistic → queued →
  // delivered transitions: the send correlation token is the only key all
  // three emissions share, so keying by it is what stops the bubble from
  // remounting (and jumping) when the canonical echo replaces the local row.
  if (message.userMessageClientKey case final String clientKey?) {
    return 'clientkey:$type:$clientKey';
  }
  if (extractRequestIdFromMessage(message) case final String requestId
      when requestId.isNotEmpty) {
    return 'request:$type:$requestId';
  }
  final id = message.id;
  if (id != null && id.isNotEmpty) return 'id:$type:$id';
  final seq = message.seq;
  if (seq != null) return 'seq:$type:$seq';
  final rawKey = message.raw['key'];
  if (rawKey is String && rawKey.isNotEmpty) return 'rawkey:$type:$rawKey';
  return 'raw:$type:${identityHashCode(message)}';
}

String _toolTranscriptIdentity(ToolTranscriptDisplayEntry entry) {
  final callId = entry.callId;
  if (callId != null && callId.isNotEmpty) return 'call-id:$callId';
  final call = entry.call;
  if (call != null) return 'call:${_messageIdentity(call)}';
  return 'result:${_messageIdentity(entry.result!)}';
}

/// Builds a stable identity for a transcript row so positional `ListView`
/// reuse cannot re-pair a `State`-bearing row (e.g. question/permission/action)
/// with a different message after older-page prepends.
String _transcriptRowIdentity(
  SessionTranscriptDisplayEntry entry,
) => switch (entry) {
  MessageTranscriptDisplayEntry(:final message) =>
    'message:${_messageIdentity(message)}',
  final ToolTranscriptDisplayEntry tool =>
    'tool:${_toolTranscriptIdentity(tool)}',
  LookupGroupTranscriptDisplayEntry(:final tools) =>
    'lookup:'
        '${tools.map(_toolTranscriptIdentity).join(',')}',
};

/// Test-only counter proving transcript row presentation work is bounded by
/// the retained window rather than by how much history has been paged in.
///
/// Row derivation — the identity string and the canonical message key — is
/// cached per message, per display entry, and per conversation turn, so a live
/// tail update only derives rows that actually changed. Reconciliation
/// (concatenating retained segments, de-duping identities, re-registering row
/// keys) stays deliberately linear in the RETAINED row count, which H1 bounds
/// at five pages / 500 messages / 4 MiB. Neither number grows with history
/// depth.
@visibleForTesting
final class TranscriptRowWorkCounter {
  /// Rows whose identity and canonical message key were computed from scratch.
  int derivedRows = 0;

  /// Rows reused from a cached message, entry, turn, or segment projection.
  int reusedRows = 0;

  /// Rows walked while reconciling identities and the row-key registry.
  int reconciledRows = 0;
}

/// Test-only sink for [TranscriptRowWorkCounter]; null in production builds.
@visibleForTesting
TranscriptRowWorkCounter? debugTranscriptRowWork;

/// One flattened chat row for the virtualized transcript list.
///
/// C2 groups the transcript into conversation turns, but the list stays flat so
/// N2-C's per-row virtualization, tail-follow, and anchor restoration are
/// preserved: a turn with many tool rows is still many list items, not one.
///
/// [identity] and [canonicalMessageKey] are computed once at construction, not
/// on every read: the build path reads both for every retained row, and a row
/// instance is cached for as long as the message, entry, or turn behind it
/// survives.
sealed class _ChatItem {
  const _ChatItem();

  /// Stable identity for the list registry and anchor keys.
  String get identity;

  /// Whether this row can serve as a history-anchor reference point.
  bool get isAnchorRow;

  /// Canonical controller identity used to preserve the visible decoded page.
  String? get canonicalMessageKey;
}

/// The turn's opening user message, right-aligned.
///
/// Identity is the user message's own stable identity, never the turn key: a
/// truncated leading turn's key is derived from its first content row and would
/// change under older-page prepends, breaking N2-C's anchor registry. Holding
/// the message rather than the turn is also what lets one instance outlive the
/// stitched turns that re-wrap it.
class _ChatUserItem extends _ChatItem {
  _ChatUserItem(this.message, {this.attachments = const []})
    : identity = 'user:${_messageIdentity(message)}',
      canonicalMessageKey = stableTranscriptMessageKey(message);

  final AgentMessage message;

  /// File artifacts the user sent with this prompt, drawn inside the bubble.
  final List<AgentMessage> attachments;

  @override
  final String identity;

  @override
  bool get isAnchorRow => true;

  @override
  final String? canonicalMessageKey;
}

/// One content row (model output, thinking, tool, request, error, …).
class _ChatEntryItem extends _ChatItem {
  _ChatEntryItem(this.entry)
    : identity = _transcriptRowIdentity(entry),
      canonicalMessageKey = stableTranscriptMessageKey(
        switch (entry) {
          MessageTranscriptDisplayEntry(:final message) => message,
          ToolTranscriptDisplayEntry(:final primaryMessage) => primaryMessage,
          LookupGroupTranscriptDisplayEntry(:final tools) =>
            tools.first.primaryMessage,
        },
      );

  final SessionTranscriptDisplayEntry entry;

  @override
  final String identity;

  @override
  bool get isAnchorRow => true;

  @override
  final String? canonicalMessageKey;
}

/// The turn's action + runtime footer.
///
/// The footer is not an anchor row, so a leading turn's shifting key only
/// rebuilds the (stateless) footer under prepends — it never moves an anchor.
class _ChatFooterItem extends _ChatItem {
  _ChatFooterItem(this.turn) : identity = 'turn-footer:${turn.turnKey}';

  final ConversationTurn turn;

  @override
  final String identity;

  @override
  bool get isAnchorRow => false;

  @override
  String? get canonicalMessageKey => null;
}

/// Explicit omitted-range row. It prevents conversation-turn grouping from
/// pairing rows across an evicted middle range.
class _ChatHistoryGapItem extends _ChatItem {
  const _ChatHistoryGapItem(this.gap);

  final TranscriptHistoryGapSegment gap;

  @override
  String get identity => gap.id;

  @override
  bool get isAnchorRow => false;

  @override
  String? get canonicalMessageKey => null;
}

/// Returns [identities] with any repeat suffixed so every entry is unique.
///
/// The list registry maps identities to `GlobalKey`s; a duplicate would hand
/// two live rows the same key and crash the transcript. Order is preserved and
/// the first occurrence keeps its identity, so anchor stability is unaffected.
List<String> _uniqueRowIdentities(List<String> identities) {
  final seen = <String, int>{};
  return [
    for (final identity in identities)
      if (seen.update(identity, (count) => count + 1, ifAbsent: () => 0)
          case final count when count > 0)
        '$identity#$count'
      else
        identity,
  ];
}

final Expando<_FlattenedConversationTurnsCache>
_flattenedConversationTurnsCache = Expando<_FlattenedConversationTurnsCache>(
  'flattened conversation turns',
);
final Expando<_ChatUserItem> _chatUserRowCache = Expando<_ChatUserItem>(
  'transcript user row',
);
final Expando<_ChatEntryItem> _chatEntryRowCache = Expando<_ChatEntryItem>(
  'transcript entry row',
);
final Expando<_TurnRowCache> _turnRowCache = Expando<_TurnRowCache>(
  'transcript turn rows',
);

final class _FlattenedConversationTurnsCache {
  List<_ChatItem>? full;
  List<_ChatItem>? report;
}

final class _TurnRowCache {
  List<_ChatItem>? full;
  List<_ChatItem>? report;
  _ChatFooterItem? footer;
}

bool _reportVisibleEntry(SessionTranscriptDisplayEntry entry) =>
    entry is MessageTranscriptDisplayEntry &&
    (entry.message.type == AgentMessageType.modelOutput ||
        entry.message.type == AgentMessageType.userMessage);

_ChatUserItem _chatUserRow(
  AgentMessage message, {
  TranscriptRowWorkCounter? work,
}) {
  final cached = _chatUserRowCache[message];
  if (cached != null) {
    work?.reusedRows += 1;
    return cached;
  }
  work?.derivedRows += 1;
  return _chatUserRowCache[message] = _ChatUserItem(message);
}

_ChatEntryItem _chatEntryRow(
  SessionTranscriptDisplayEntry entry, {
  TranscriptRowWorkCounter? work,
}) {
  final cached = _chatEntryRowCache[entry];
  if (cached != null) {
    work?.reusedRows += 1;
    return cached;
  }
  work?.derivedRows += 1;
  return _chatEntryRowCache[entry] = _ChatEntryItem(entry);
}

/// Rows for one conversation [turn], cached per turn and display filter.
///
/// A stitched page-boundary turn is a NEW `ConversationTurn` wrapping the SAME
/// entry objects, so this list is rebuilt while every row inside it is reused
/// from [_chatEntryRowCache] — the rebuild costs pointer copies, not identity
/// or canonical-key derivation.
List<_ChatItem> _turnRows(
  ConversationTurn turn, {
  required bool reportView,
  TranscriptRowWorkCounter? work,
}) {
  final cache = _turnRowCache[turn] ?? _TurnRowCache();
  _turnRowCache[turn] = cache;
  final cached = reportView ? cache.report : cache.full;
  if (cached != null) {
    work?.reusedRows += cached.length;
    return cached;
  }

  final items = <_ChatItem>[];
  if (turn.userMessage case final userMessage?) {
    if (turn.userAttachments.isEmpty) {
      items.add(_chatUserRow(userMessage, work: work));
    } else {
      // Not message-cached: an attachment can be delivered after its prompt
      // row, and the per-message cache would hand back the attachment-less
      // instance forever. The row identity is unchanged, so anchors hold.
      work?.derivedRows += 1;
      items.add(_ChatUserItem(userMessage, attachments: turn.userAttachments));
    }
  }
  for (final entry in turn.content) {
    if (reportView && !_reportVisibleEntry(entry)) continue;
    items.add(_chatEntryRow(entry, work: work));
  }
  if (turn.hasModelText || turn.runSummary != null) {
    final footer = cache.footer;
    if (footer == null) {
      work?.derivedRows += 1;
      items.add(cache.footer = _ChatFooterItem(turn));
    } else {
      work?.reusedRows += 1;
      items.add(footer);
    }
  }
  final result = List<_ChatItem>.unmodifiable(items);
  if (reportView) {
    cache.report = result;
  } else {
    cache.full = result;
  }
  return result;
}

/// Flattens conversation [turns] into the virtualized chat row list.
List<_ChatItem> _flattenConversationTurns({
  required List<ConversationTurn> turns,
  required bool reportView,
  TranscriptRowWorkCounter? work,
}) {
  final cache =
      _flattenedConversationTurnsCache[turns] ??
      _FlattenedConversationTurnsCache();
  _flattenedConversationTurnsCache[turns] = cache;
  final cached = reportView ? cache.report : cache.full;
  if (cached != null) {
    work?.reusedRows += cached.length;
    return cached;
  }

  final items = <_ChatItem>[];
  for (final turn in turns) {
    items.addAll(_turnRows(turn, reportView: reportView, work: work));
  }
  final result = List<_ChatItem>.unmodifiable(items);
  if (reportView) {
    cache.report = result;
  } else {
    cache.full = result;
  }
  return result;
}

class _CompatibilityNotice extends StatelessWidget {
  const _CompatibilityNotice({required this.message});

  final String message;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final colors = Theme.of(context).colorScheme;
    return Container(
      key: const Key('session-detail-compatibility-notice'),
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: colors.tertiaryContainer.withValues(alpha: 0.55),
        borderRadius: BorderRadius.circular(tokens.radiusMd),
        border: Border.all(color: colors.tertiary),
      ),
      child: SelectionArea(
        child: Row(
          children: [
            Icon(Icons.system_update_alt, size: 18, color: colors.tertiary),
            const SizedBox(width: 8),
            Expanded(child: Text(message)),
          ],
        ),
      ),
    );
  }
}

final class _SemanticViewportCapture {
  const _SemanticViewportCapture({
    required this.key,
    required this.membershipGeneration,
    required this.followTail,
    this.anchorMessageKey,
    this.anchorViewportTop,
  });

  final SessionViewportKey key;
  final int membershipGeneration;
  final bool followTail;
  final String? anchorMessageKey;
  final double? anchorViewportTop;
}

class _TranscriptSurface extends ConsumerStatefulWidget {
  const _TranscriptSurface({
    required this.state,
    required this.controller,
    required this.isConnected,
    required this.hasActiveBrokerClient,
    required this.canFork,
    required this.toolDisplayMode,
    required this.onForkFromMessage,
    required this.reportView,
    required this.toolsExpanded,
    required this.toolExpansionRevision,
    required this.bootstrapRetrying,
    required this.onRetryBootstrap,
  });

  final SessionDetailState state;
  final SessionDetailController controller;
  final bool isConnected;
  final bool hasActiveBrokerClient;
  final bool canFork;
  final ToolDisplayMode toolDisplayMode;
  final ValueChanged<String> onForkFromMessage;
  final bool reportView;
  final bool toolsExpanded;
  final int toolExpansionRevision;

  /// Forwarded to the bootstrap loading treatment shown while the U5 tail
  /// reveal settles, so a failed bootstrap keeps its working retry action.
  final bool bootstrapRetrying;
  final Future<void> Function() onRetryBootstrap;

  @override
  ConsumerState<_TranscriptSurface> createState() => _TranscriptSurfaceState();
}

class _TranscriptSurfaceState extends ConsumerState<_TranscriptSurface> {
  /// Owned so the list is not the `primary` view (which would add a second,
  /// pixel-estimate-driven scrollbar on desktop), and so tail/paging behavior
  /// and the logical right-edge indicator share one position.
  final ScrollController _scrollController = ScrollController();
  late final FocusNode _historyShortcutFocusNode;
  final _TranscriptSelectionRegistry _selectionRegistry =
      _TranscriptSelectionRegistry();
  String? _selectedTranscriptText;

  /// How close to the end counts as "at the bottom", in logical pixels.
  ///
  /// Not zero: a fractional layout, a resize, or the last row growing by a
  /// pixel would otherwise silently drop the user out of follow mode.
  static const double _bottomThreshold = 32;

  /// Whether new content should pull the view down.
  ///
  /// Starts true, which is what makes entering a session land on the newest
  /// message: the transcript is empty at first layout (history is loaded from
  /// the cache and then the broker, both after mount), so there is nothing to
  /// jump to yet. Rather than race that with a one-shot post-frame `jumpTo`,
  /// the surface simply follows the end of the list until the user scrolls
  /// away — which covers first paint, cache hydration, late history pages and
  /// live streaming with one rule.
  bool _followTail = true;

  /// The layout-phase tail invariant (U5b). Built once so the `ListView` sees a
  /// stable physics instance across rebuilds.
  late final ScrollPhysics _transcriptPhysics = _TailFollowingScrollPhysics(
    shouldFollowTail: () => _followTail && !_tailRevealPending,
  );

  /// Whether transcript content is hidden behind the bootstrap loading
  /// treatment while the tail layout of an authoritative transcript settles
  /// (U5).
  ///
  /// A lazy variable-height list only discovers its real extent over several
  /// frames, so the opening `jumpTo(maxScrollExtent)` chase paints earlier
  /// positions before reaching the true tail — the visible drop/bounce. While
  /// this is set the list still lays out (so the extent can converge) but
  /// paints nothing; it is revealed once [_isTailSettled] confirms the actual
  /// last row's geometry, never on the estimate alone.
  bool _tailRevealPending = true;

  /// Settle attempts used by the current reveal generation (bounded, then the
  /// best-known tail is revealed rather than looping forever).
  int _tailRevealAttempts = 0;

  /// Set while a settle check is already queued.
  bool _tailRevealScheduled = false;

  /// The transcript-replacement generation this surface has consumed, or null
  /// before the first one.
  ///
  /// This is the ONLY re-arm signal for the reveal gate:
  /// [SessionDetailState.transcriptResetGeneration] advances exactly when the
  /// controller accepts a `HistoryWireEvent(reset: true)` — fresh open, cache
  /// hydration, cache replaced by broker history, retry, and the automatic
  /// reconnect replay that happens INSIDE the existing connection without a
  /// new bootstrap attempt. Display-row shape is deliberately NOT consulted —
  /// live appends, history prepends, notice/inline-row churn, and
  /// tool-projection changes all alter row identities and counts during an
  /// already-visible session without replacing it.
  int? _lastTranscriptResetGeneration;

  /// Hard bound on post-frame settle checks per reveal generation.
  static const int _maxTailRevealAttempts = 12;

  /// Index-to-key map used by the list's child-index callback.
  final Map<GlobalKey<State<StatefulWidget>>, int> _itemIndexByKey = {};

  /// Ordered list of keys for this build pass.
  final List<GlobalKey<State<StatefulWidget>>> _orderedItemKeys = [];

  /// The subset of item keys that are transcript message rows.
  final Set<GlobalKey<State<StatefulWidget>>> _messageItemKeys = {};
  final Map<GlobalKey<State<StatefulWidget>>, String>
  _messageStableKeyByItemKey = {};

  final Map<String, GlobalKey<State<StatefulWidget>>> _itemKeysByIdentity = {};
  final Map<String, GlobalKey<State<StatefulWidget>>>
  _itemKeyByStableMessageKey = {};

  /// Currently laid-out row contexts, maintained by each row's
  /// [_TranscriptRowGeometryTracker] on mount/unmount, so one progress
  /// reading walks `O(visible rows)` — never the whole transcript.
  final Map<GlobalKey<State<StatefulWidget>>, BuildContext>
  _mountedRowContexts = {};

  /// Total flat row count of the current build, the progress denominator.
  int _totalRowCount = 0;

  /// Monotone displayed reading progress (see N2-D contract).
  final TranscriptProgressLatch _progressLatch = TranscriptProgressLatch();
  final ValueNotifier<double?> _progressValue = ValueNotifier<double?>(null);
  final ValueNotifier<double> _progressViewportFraction = ValueNotifier<double>(
    1,
  );

  /// Whether the passive indicator is currently shown (scroll activity).
  final ValueNotifier<bool> _progressActive = ValueNotifier<bool>(false);
  final ValueNotifier<bool> _showJumpLatest = ValueNotifier<bool>(false);
  Timer? _progressFadeTimer;
  bool _progressRefreshScheduled = false;

  bool _historyPageWasLoading = false;
  GlobalKey<State<StatefulWidget>>? _historyAnchorKey;
  double? _historyAnchorRevealDelta;
  bool _historyAnchorRestorePending = false;
  bool _historyAnchorRestoreScheduled = false;
  int _historyAnchorRestoreAttempts = 0;
  int _historyAnchorStableChecks = 0;
  String? _automaticHistoryCursorInFlight;
  int _upwardHistoryIntentCredits = 0;
  double _upwardHistoryIntentRemainder = 0;
  bool _historyIntentResumeScheduled = false;
  final Map<GlobalKey<State<StatefulWidget>>, String>
  _reloadableGapCursorByItemKey = {};

  static const int _maxHistoryAnchorRestoreAttempts = 8;
  static const int _requiredHistoryAnchorStableChecks = 2;
  static const double _historyAnchorTolerance = 0.5;
  static const int _maxUpwardHistoryIntentCredits = 5;
  static const double _upwardHistoryPixelsPerCredit = 40;

  SessionViewportKey? _viewportKey;
  int? _viewportMembershipGeneration;
  SessionViewportRecord? _semanticRestoreRecord;
  GlobalKey<State<StatefulWidget>>? _semanticRestoreItemKey;
  bool _semanticViewportRestorePending = false;
  bool _semanticViewportRestoreScheduled = false;
  int _semanticViewportRestoreAttempts = 0;
  int _semanticViewportStableChecks = 0;
  bool _viewportCaptureScheduled = false;
  late final SessionViewportRegistry _viewportRegistry;

  static const int _maxSemanticViewportRestoreAttempts = 24;
  static const int _requiredSemanticViewportStableChecks = 2;
  static const double _semanticViewportTolerance = 0.5;

  @override
  void initState() {
    super.initState();
    _historyShortcutFocusNode = FocusNode(
      debugLabel: 'session-history-shortcuts',
      onKeyEvent: (_, event) => _handleHistoryKeyEvent(event),
    );
    _viewportRegistry = ref.read(sessionViewportRegistryProvider.notifier);
    _scrollController.addListener(_onScroll);
    _initializeSemanticViewport();
  }

  @override
  void dispose() {
    _scheduleCapturedViewportCommit(_semanticViewportCapture());
    _progressFadeTimer?.cancel();
    _progressValue.dispose();
    _progressViewportFraction.dispose();
    _progressActive.dispose();
    _showJumpLatest.dispose();
    _selectionRegistry.dispose();
    _historyShortcutFocusNode.dispose();
    _scrollController
      ..removeListener(_onScroll)
      ..dispose();
    super.dispose();
  }

  @override
  void didUpdateWidget(_TranscriptSurface oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.state.source != widget.state.source) {
      _viewportKey = null;
      _viewportMembershipGeneration = null;
      _semanticRestoreRecord = null;
      _semanticRestoreItemKey = null;
      _semanticViewportRestorePending = false;
      _followTail = true;
      _showJumpLatest.value = false;
      _tailRevealPending = true;
      _tailRevealAttempts = 0;
      _initializeSemanticViewport();
    } else if (oldWidget.state.transcriptResetGeneration !=
            widget.state.transcriptResetGeneration &&
        !_followTail) {
      // Capture against the still-mounted old row geometry, then hide the
      // replacement transcript until that semantic row is exact again.
      final capture = _semanticViewportCapture();
      _scheduleCapturedViewportCommit(capture);
      _armSemanticViewportRestore(capture: capture);
    }
    if (oldWidget.isConnected != widget.isConnected ||
        oldWidget.state.sessionId != widget.state.sessionId ||
        oldWidget.state.source != widget.state.source) {
      _clearUpwardHistoryIntent();
      _automaticHistoryCursorInFlight = null;
    }
    if (oldWidget.state.historyPageError != widget.state.historyPageError &&
        widget.state.historyPageError != null) {
      _clearUpwardHistoryIntent();
    }
    if (oldWidget.state.historyPageLoading &&
        !widget.state.historyPageLoading) {
      _automaticHistoryCursorInFlight = null;
    }
    if (oldWidget.state.olderHistoryCursor != widget.state.olderHistoryCursor) {
      _automaticHistoryCursorInFlight = null;
      // A healthy local/production page can round-trip inside one Flutter
      // frame. In that case build never observes `historyPageLoading == true`,
      // so the ordinary loading-to-ready transition cannot start restoration.
      // Cursor advancement with our captured anchor is equivalent completion
      // evidence and keeps the fast path from stranding both anchor and credit.
      if (_historyAnchorKey != null &&
          !widget.state.historyPageLoading &&
          !_followTail) {
        _historyAnchorRestorePending = true;
        _historyAnchorRestoreAttempts = 0;
        _historyAnchorStableChecks = 0;
        _scheduleHistoryAnchorRestore();
      }
    }
  }

  /// One `O(visible rows)` logical-progress reading from the mounted rows.
  ///
  /// Never touches the mutable estimated `maxScrollExtent`: the offset/extent
  /// ratio is not the progress source, and even the at-tail latch is decided
  /// from the LAST logical row's own geometry — a transiently converged pixel
  /// extent while trailing rows are unbuilt must not read as 100%.
  ({double? progress, double viewportFraction}) _computeRawProgress(
    ScrollPosition position,
  ) {
    final rows = <TranscriptRowGeometry>[];
    for (final entry in _mountedRowContexts.entries) {
      final index = _itemIndexByKey[entry.key];
      if (index == null || !entry.value.mounted) continue;
      final renderObject = entry.value.findRenderObject();
      if (renderObject is! RenderBox || !renderObject.attached) continue;
      final viewport = RenderAbstractViewport.maybeOf(renderObject);
      if (viewport == null) continue;
      final revealOffset = viewport.getOffsetToReveal(renderObject, 0).offset;
      rows.add(
        TranscriptRowGeometry(
          index: index,
          viewportTop: revealOffset - position.pixels,
          height: renderObject.size.height,
        ),
      );
    }
    var visibleLogicalRows = 0.0;
    for (final row in rows) {
      if (row.height <= 0) continue;
      final rowBottom = row.viewportTop + row.height;
      final visibleTop = row.viewportTop < 0 ? 0.0 : row.viewportTop;
      final visibleBottom = rowBottom > position.viewportDimension
          ? position.viewportDimension
          : rowBottom;
      if (visibleBottom > visibleTop) {
        visibleLogicalRows += (visibleBottom - visibleTop) / row.height;
      }
    }
    final viewportFraction = _totalRowCount <= 0
        ? 1.0
        : (visibleLogicalRows / _totalRowCount).clamp(0.0, 1.0);
    return (
      progress: transcriptLogicalProgress(
        mountedRows: rows,
        totalRows: _totalRowCount,
        viewportHeight: position.viewportDimension,
        atTail: transcriptAtTail(
          mountedRows: rows,
          totalRows: _totalRowCount,
          viewportHeight: position.viewportDimension,
        ),
      ),
      viewportFraction: viewportFraction,
    );
  }

  void _updateProgress({required bool markActive}) {
    if (!mounted) return;
    final position = _positionOrNull();
    if (position == null || !position.hasContentDimensions) return;
    if (position.maxScrollExtent <= 0) {
      // Nothing scrolls: no reading position to indicate.
      _progressValue.value = null;
      _progressViewportFraction.value = 1;
      _progressActive.value = false;
      return;
    }
    final sample = _computeRawProgress(position);
    final displayed = _progressLatch.update(
      raw: sample.progress,
      offset: position.pixels,
    );
    _progressViewportFraction.value = sample.viewportFraction;
    if (displayed != null) _progressValue.value = displayed;
    if (markActive) _markProgressActive();
  }

  /// Lights the passive indicator and arms its fade.
  ///
  /// Split from [_updateProgress] because the geometry reading is not legal
  /// in every context a scroll notification can arrive from (a ballistic
  /// start/stop dispatched while an extent correction applies mid-layout),
  /// while setting the flag always is.
  void _markProgressActive() {
    _progressActive.value = true;
    _progressFadeTimer?.cancel();
    _progressFadeTimer = Timer(const Duration(milliseconds: 1200), () {
      _progressFadeTimer = null;
      if (!mounted) return;
      // A lazy extent estimate can correct after the last notification of a
      // gesture (a trailing row re-measuring) with no rebuild at all;
      // re-read once before fading so the resting value is honest.
      _updateProgress(markActive: false);
      _progressActive.value = false;
    });
  }

  /// Refreshes the reading after this frame lays out (list growth, prepends,
  /// expansion) without marking scroll activity.
  void _scheduleProgressRefresh() {
    if (_progressRefreshScheduled) return;
    _progressRefreshScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _progressRefreshScheduled = false;
      if (mounted) _updateProgress(markActive: false);
    });
  }

  bool _onScrollNotification(ScrollNotification notification) {
    if (notification.depth != 0) return false;
    if (notification is ScrollUpdateNotification ||
        notification is ScrollEndNotification) {
      // The flag is safe to set in any notification context, but the geometry
      // reading is not: a ballistic start/stop can be dispatched while an
      // extent correction applies mid-layout, so the reading is deferred to
      // after the frame (coalesced by `_scheduleProgressRefresh`).
      if (notification is ScrollUpdateNotification) _markProgressActive();
      _scheduleProgressRefresh();
      if (_upwardHistoryIntentCredits > 0) {
        _maybeRequestEarlierFromScroll();
      }
      if (notification is ScrollEndNotification) {
        _scheduleSemanticViewportCapture();
      }
    }
    return false;
  }

  bool get _historyIntentCanArm =>
      !widget.state.historyPageLoading &&
      widget.state.historyPageError == null &&
      _automaticHistoryCursorInFlight == null &&
      !_historyAnchorRestorePending &&
      !_historyAnchorRestoreScheduled &&
      _historyAnchorKey == null;

  /// Records fresh physical input, never layout/cursor/reconnect movement.
  ///
  /// Every 40 logical pixels of upward movement earns one page authorization,
  /// bounded by the five-page client window. This preserves multiple units of
  /// a natural swipe that arrive before the first page response. Page/cursor
  /// progression never earns credit, so the finite physical budget cannot turn
  /// into unbounded stationary paging.
  void _recordRealScrollMovement({
    required bool upward,
    double distance = 0,
    bool discrete = false,
  }) {
    if (!upward) {
      _clearUpwardHistoryIntent();
      return;
    }
    if (!widget.isConnected || widget.state.historyPageError != null) return;
    if (discrete) {
      _addUpwardHistoryIntentCredits(1);
    } else {
      _upwardHistoryIntentRemainder += distance.abs();
      final earned =
          (_upwardHistoryIntentRemainder / _upwardHistoryPixelsPerCredit)
              .floor();
      if (earned > 0) {
        _upwardHistoryIntentRemainder -= earned * _upwardHistoryPixelsPerCredit;
        _addUpwardHistoryIntentCredits(earned);
      }
    }
    if (_upwardHistoryIntentCredits == 0 || !_historyIntentCanArm) {
      return;
    }
    final gapCursor = _approachedReloadableGapCursor(upward: true);
    if (gapCursor != null) {
      _requestHistoryCursor(
        gapCursor,
        leadingEdge: false,
        consumeIntentCredit: true,
      );
      return;
    }
    _maybeRequestEarlierFromScroll();
  }

  void _addUpwardHistoryIntentCredits(int credits) {
    final next = _upwardHistoryIntentCredits + credits;
    _upwardHistoryIntentCredits = next > _maxUpwardHistoryIntentCredits
        ? _maxUpwardHistoryIntentCredits
        : next;
  }

  void _clearUpwardHistoryIntent() {
    _upwardHistoryIntentCredits = 0;
    _upwardHistoryIntentRemainder = 0;
  }

  /// Tracks whether the user has scrolled away from the end.
  ///
  /// Reading history turns following off; scrolling back to the end turns it
  /// on again, so the user can opt back in without a dedicated control.
  void _onScroll() {
    final position = _positionOrNull();
    if (position == null) return;
    final atBottom =
        position.pixels >= position.maxScrollExtent - _bottomThreshold;
    if (atBottom != _followTail) {
      _followTail = atBottom;
      _showJumpLatest.value = !atBottom;
      _scheduleSemanticViewportCapture();
    }
  }

  bool _insideHistoryThreshold() {
    final position = _positionOrNull();
    if (position == null || !position.hasContentDimensions) return false;
    return position.pixels <= position.viewportDimension;
  }

  void _maybeRequestEarlierFromScroll() {
    if (_upwardHistoryIntentCredits == 0 || !_insideHistoryThreshold()) return;
    if (!widget.isConnected) {
      // A gesture made while offline is not a standing subscription. Reconnect
      // and layout notifications must not turn it into an automatic request.
      _clearUpwardHistoryIntent();
      return;
    }
    final state = widget.state;
    final cursor = state.olderHistoryCursor;
    if (state.historyStartReached) {
      _clearUpwardHistoryIntent();
      return;
    }
    if (state.historyPageLoading ||
        state.historyPageError != null ||
        cursor == null ||
        cursor.isEmpty ||
        _automaticHistoryCursorInFlight == cursor) {
      return;
    }
    _requestHistoryCursor(
      cursor,
      leadingEdge: true,
      consumeIntentCredit: true,
    );
  }

  void _requestEarlierExplicitly() {
    final state = widget.state;
    final cursor = state.olderHistoryCursor;
    final terminalFailure = isTerminalHistoryPageErrorCode(
      state.historyPageErrorCode,
    );
    if (!widget.isConnected ||
        state.historyStartReached ||
        state.historyPageLoading ||
        terminalFailure ||
        cursor == null ||
        cursor.isEmpty) {
      return;
    }
    _requestHistoryCursor(cursor, leadingEdge: true);
  }

  KeyEventResult _handleHistoryKeyEvent(KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final key = event.logicalKey;
    final upward =
        key == LogicalKeyboardKey.arrowUp ||
        key == LogicalKeyboardKey.pageUp ||
        key == LogicalKeyboardKey.home;
    final downward =
        key == LogicalKeyboardKey.arrowDown ||
        key == LogicalKeyboardKey.pageDown ||
        key == LogicalKeyboardKey.end;
    if (!upward && !downward) return KeyEventResult.ignored;

    _recordRealScrollMovement(upward: upward, discrete: true);
    final position = _positionOrNull();
    if (position == null || !position.hasContentDimensions) {
      return KeyEventResult.handled;
    }
    final page = position.viewportDimension * 0.9;
    final target = switch (key) {
      LogicalKeyboardKey.home => position.minScrollExtent,
      LogicalKeyboardKey.end => position.maxScrollExtent,
      LogicalKeyboardKey.pageUp => (position.pixels - page).clamp(
        position.minScrollExtent,
        position.maxScrollExtent,
      ),
      LogicalKeyboardKey.pageDown => (position.pixels + page).clamp(
        position.minScrollExtent,
        position.maxScrollExtent,
      ),
      LogicalKeyboardKey.arrowUp => (position.pixels - 40).clamp(
        position.minScrollExtent,
        position.maxScrollExtent,
      ),
      _ => (position.pixels + 40).clamp(
        position.minScrollExtent,
        position.maxScrollExtent,
      ),
    };
    position.jumpTo(target);
    // Handling the key ourselves prevents the browser's page-scroll default
    // from moving focus outside the transcript after lazy-list reshaping.
    if (!_historyShortcutFocusNode.hasFocus) {
      _historyShortcutFocusNode.requestFocus();
    }
    return KeyEventResult.handled;
  }

  void _requestHistoryCursor(
    String cursor, {
    required bool leadingEdge,
    bool consumeIntentCredit = false,
  }) {
    final state = widget.state;
    if (!widget.isConnected ||
        (leadingEdge && state.historyStartReached) ||
        state.historyPageLoading ||
        cursor.isEmpty ||
        _automaticHistoryCursorInFlight == cursor ||
        (consumeIntentCredit && _upwardHistoryIntentCredits == 0)) {
      return;
    }
    if (consumeIntentCredit) _upwardHistoryIntentCredits -= 1;
    _automaticHistoryCursorInFlight = cursor;
    _captureHistoryAnchor();
    unawaited(widget.controller.loadEarlierHistory(cursor: cursor));
  }

  String? _approachedReloadableGapCursor({required bool upward}) {
    final position = _positionOrNull();
    if (position == null || !position.hasContentDimensions) return null;
    for (final entry in _reloadableGapCursorByItemKey.entries) {
      final rowContext = entry.key.currentContext;
      if (rowContext == null) continue;
      final renderObject = rowContext.findRenderObject();
      if (renderObject is! RenderBox || !renderObject.attached) continue;
      final viewport = RenderAbstractViewport.maybeOf(renderObject);
      if (viewport == null) continue;
      final rowTop =
          viewport.getOffsetToReveal(renderObject, 0).offset - position.pixels;
      final rowBottom = rowTop + renderObject.size.height;
      final intersectsViewport =
          rowBottom >= 0 && rowTop <= position.viewportDimension;
      final liesAhead = upward
          ? rowBottom >= -position.viewportDimension && rowTop < 0
          : rowTop <= position.viewportDimension * 2 &&
                rowBottom > position.viewportDimension;
      if (intersectsViewport || liesAhead) {
        return entry.value;
      }
    }
    return null;
  }

  void _jumpToLatest() {
    final position = _positionOrNull();
    if (position == null || !position.hasContentDimensions) return;
    _followTail = true;
    _showJumpLatest.value = false;
    _scheduleSemanticViewportCapture();
    // One jump to the best-known end; the tail physics keeps it there as the
    // lazy extent converges, so this needs no post-frame chase of its own.
    position.jumpTo(position.maxScrollExtent);
  }

  /// The single attached position, or null.
  ///
  /// [ScrollController.position] throws when a controller has no clients or
  /// more than one, which can happen for a frame while the layout swaps
  /// between the roomy and compact chat branches.
  ScrollPosition? _positionOrNull() {
    if (_scrollController.positions.length != 1) return null;
    return _scrollController.positions.first;
  }

  /// Queues one post-frame settle check for the hidden opening reveal (U5).
  ///
  /// The loop self-chains, so it also covers lazy extent corrections that
  /// arrive without a rebuild — the case a build-driven jump cannot see.
  /// `addPostFrameCallback` alone does NOT schedule a frame: when a settle
  /// step neither jumps nor reveals (the estimated extent already equals the
  /// offset while the real last row is still unmounted), nothing else may be
  /// left to produce the next frame, and the gate would stay hidden forever.
  /// So every queue also requests the frame explicitly, exactly like
  /// [_scheduleHistoryAnchorRestore].
  void _scheduleTailRevealSettle() {
    if (_tailRevealScheduled) return;
    _tailRevealScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _tailRevealScheduled = false;
      if (!mounted || !_tailRevealPending) return;
      _settleTailReveal();
    });
    WidgetsBinding.instance.scheduleFrame();
  }

  /// One settle step: chase the best-known tail, then reveal only when the
  /// actual last row is laid out at it. Bounded per reveal generation; on
  /// exhaustion the best-known tail is revealed rather than looping forever.
  void _settleTailReveal() {
    // Nothing to chase: the user scrolled away before the reveal, or the
    // transcript is empty (the genuine empty state needs no settle).
    if (!_followTail || _orderedItemKeys.isEmpty) {
      _revealTail();
      return;
    }
    _tailRevealAttempts += 1;
    final position = _positionOrNull();
    if (position != null && position.hasContentDimensions) {
      final target = position.maxScrollExtent;
      // An over-estimated lazy extent can leave the offset BEYOND the real
      // end after a jump, and nothing clamps that on its own — so the chase
      // must correct in both directions, not only downward.
      if ((target - position.pixels).abs() > 0.5) position.jumpTo(target);
      if (_isTailSettled(position)) {
        _revealTail();
        return;
      }
    }
    if (_tailRevealAttempts >= _maxTailRevealAttempts) {
      _revealTail();
      return;
    }
    _scheduleTailRevealSettle();
  }

  /// Whether the actual last row is laid out and fully inside the viewport
  /// with the scroll offset at the real extent.
  ///
  /// This deliberately reads the last row's own geometry instead of trusting
  /// the lazy list's estimated `maxScrollExtent`, which converges only over
  /// several frames for variable-height rows.
  bool _isTailSettled(ScrollPosition position) {
    if (_orderedItemKeys.isEmpty) return true;
    if (!position.hasContentDimensions) return false;
    // The offset must sit AT the real extent — neither short of it nor past
    // it (an over-estimated jump can overshoot, which is not a settled tail).
    if ((position.pixels - position.maxScrollExtent).abs() > 0.5) return false;
    final lastContext = _orderedItemKeys.last.currentContext;
    if (lastContext == null) return false;
    final renderObject = lastContext.findRenderObject();
    if (renderObject is! RenderBox || !renderObject.attached) return false;
    final viewport = RenderAbstractViewport.maybeOf(renderObject);
    if (viewport == null) return false;
    final revealOffset = viewport.getOffsetToReveal(renderObject, 0).offset;
    final rowBottom = revealOffset + renderObject.size.height;
    final viewportBottom = position.pixels + position.viewportDimension;
    return rowBottom <= viewportBottom + 0.5;
  }

  void _revealTail() {
    if (!_tailRevealPending) return;
    setState(() => _tailRevealPending = false);
    // The shortcut Focus is initially offstage while the bounded tail-settle
    // gate runs, so its autofocus request can be skipped. Arm it once the
    // transcript is visible, but never steal focus from the composer or
    // another editor the user already entered.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final primary = FocusManager.instance.primaryFocus;
      final focusContext = primary?.context;
      final editorOwnsFocus =
          focusContext?.widget is EditableText ||
          focusContext?.findAncestorStateOfType<EditableTextState>() != null;
      if (!editorOwnsFocus) {
        _historyShortcutFocusNode.requestFocus();
      }
    });
  }

  void _onTranscriptSelectionChanged(SelectedContent? content) {
    _selectedTranscriptText = content?.plainText;
  }

  void _focusHistoryAfterCompletedTap() {
    _historyShortcutFocusNode.requestFocus();
  }

  void _readTranscriptSelection(
    SelectableRegionState selection,
    List<_TranscriptSelectionMessage> selectedMessages,
  ) {
    final text = _selectedTranscriptText;
    if (text == null || text.isEmpty) return;
    selection.hideToolbar();
    final anchor = selectedMessages.firstOrNull?.message;
    unawaited(
      ref
          .read(readAloudControllerProvider.notifier)
          .speakText(
            messageKey: anchor == null
                ? 'transcript-selection'
                : resolveReadAloudIdentity(anchor) ?? _messageIdentity(anchor),
            text: text,
          ),
    );
  }

  Widget _transcriptSelectionMenu(
    BuildContext context,
    SelectableRegionState selection,
  ) {
    final selectedMessages = _selectionRegistry.selectedMessages;
    final singleMessage = selectedMessages.length == 1
        ? selectedMessages.single
        : null;
    final messageId = singleMessage?.message.id;
    final canReadAloud = ref
        .read(readAloudControllerProvider)
        .capabilities
        .canAttemptSynthesis;
    return AdaptiveTextSelectionToolbar.buttonItems(
      anchors: selection.contextMenuAnchors,
      buttonItems: [
        for (final item in selection.contextMenuButtonItems)
          if (item.type != ContextMenuButtonType.selectAll) item,
        if (canReadAloud && (_selectedTranscriptText?.isNotEmpty ?? false))
          ContextMenuButtonItem(
            label: AppLocalizations.of(context).sessionSelectionReadAloud,
            onPressed: () =>
                _readTranscriptSelection(selection, selectedMessages),
          ),
        if (singleMessage != null &&
            singleMessage.canFork &&
            messageId != null &&
            messageId.isNotEmpty)
          ContextMenuButtonItem(
            label: AppLocalizations.of(context).sessionSelectionForkFromHere,
            onPressed: () {
              selection.hideToolbar();
              singleMessage.onForkFromMessage(messageId);
            },
          ),
        if (singleMessage != null)
          ContextMenuButtonItem(
            label: AppLocalizations.of(context).sessionSelectionDetails,
            onPressed: () {
              selection.hideToolbar();
              unawaited(
                showDialog<void>(
                  context: context,
                  builder: (context) =>
                      _MessageDetailsDialog(message: singleMessage.message),
                ),
              );
            },
          ),
      ],
    );
  }

  void _clearHistoryAnchorState() {
    _historyAnchorKey = null;
    _historyAnchorRevealDelta = null;
    _historyAnchorRestorePending = false;
    _historyAnchorRestoreScheduled = false;
    _historyAnchorRestoreAttempts = 0;
    _historyAnchorStableChecks = 0;
    final record = _viewportRecord();
    widget.controller.protectHistoryViewportAnchor(
      (record?.followTail ?? true) ? null : record?.anchorMessageKey,
    );
    _scheduleSemanticViewportCapture();
    _scheduleBlockedHistoryIntentResume();
  }

  void _scheduleBlockedHistoryIntentResume() {
    if (_upwardHistoryIntentCredits == 0 || _historyIntentResumeScheduled) {
      return;
    }
    _historyIntentResumeScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _historyIntentResumeScheduled = false;
      if (!mounted || _upwardHistoryIntentCredits == 0) return;
      if (!_historyIntentCanArm) return;
      if (!widget.isConnected || widget.state.historyPageError != null) return;

      final gapCursor = _approachedReloadableGapCursor(upward: true);
      if (gapCursor != null) {
        _requestHistoryCursor(
          gapCursor,
          leadingEdge: false,
          consumeIntentCredit: true,
        );
        return;
      }
      final state = widget.state;
      final cursor = state.olderHistoryCursor;
      if (!state.historyStartReached &&
          !state.historyPageLoading &&
          cursor != null &&
          cursor.isNotEmpty) {
        // Exact anchor restoration may increase the raw pixel offset by the
        // prepended rows' height, but it does not move the user's logical
        // reading position away from the edge. Consume one finite unit from
        // the already-recorded physical movement without a second threshold
        // test.
        _requestHistoryCursor(
          cursor,
          leadingEdge: true,
          consumeIntentCredit: true,
        );
        return;
      }
      if (state.historyStartReached) {
        _clearUpwardHistoryIntent();
        return;
      }
      _maybeRequestEarlierFromScroll();
    });
    WidgetsBinding.instance.scheduleFrame();
  }

  int? _findChildIndex(Key? key) {
    if (key == null) return null;
    if (key is! GlobalKey<State<StatefulWidget>>) return null;
    return _itemIndexByKey[key];
  }

  void _syncItemRegistry({
    required List<String> identities,
    required Set<int> messageIndices,
    required List<String?> canonicalMessageKeys,
  }) {
    final activeIdentities = identities.toSet();
    _itemKeysByIdentity.removeWhere(
      (identity, key) => !activeIdentities.contains(identity),
    );
    _orderedItemKeys.clear();
    _itemIndexByKey.clear();
    _messageItemKeys.clear();
    _messageStableKeyByItemKey.clear();
    _itemKeyByStableMessageKey.clear();

    for (var index = 0; index < identities.length; index++) {
      final identity = identities[index];
      final key = _itemKeysByIdentity.putIfAbsent(
        identity,
        () => GlobalKey<State<StatefulWidget>>(debugLabel: identity),
      );
      _orderedItemKeys.add(key);
      _itemIndexByKey[key] = index;
      if (messageIndices.contains(index)) {
        _messageItemKeys.add(key);
        final stableMessageKey = canonicalMessageKeys[index];
        if (stableMessageKey != null) {
          _messageStableKeyByItemKey[key] = stableMessageKey;
          _itemKeyByStableMessageKey.putIfAbsent(
            stableMessageKey,
            () => key,
          );
        }
      }
    }
  }

  void _captureHistoryAnchor() {
    final position = _positionOrNull();
    if (position == null || position.viewportDimension <= 0) {
      return;
    }

    for (final key in _orderedItemKeys) {
      if (!_messageItemKeys.contains(key)) continue;
      final keyContext = key.currentContext;
      if (keyContext == null) continue;
      final renderObject = keyContext.findRenderObject();
      if (renderObject is! RenderBox) continue;
      final viewport = RenderAbstractViewport.maybeOf(renderObject);
      if (viewport == null) continue;

      final revealOffset = viewport.getOffsetToReveal(renderObject, 0).offset;
      final viewportTop = revealOffset - position.pixels;
      final viewportBottom = viewportTop + renderObject.size.height;
      if (viewportBottom < 0 || viewportTop > position.viewportDimension) {
        continue;
      }

      _historyAnchorKey = key;
      _historyAnchorRevealDelta = viewportTop;
      widget.controller.protectHistoryViewportAnchor(
        _messageStableKeyByItemKey[key],
      );
      return;
    }
  }

  void _initializeSemanticViewport() {
    final source = widget.state.source;
    if (source == null) return;
    final key = SessionViewportKey.forSource(
      source: source,
      tool: widget.state.tool,
      sessionId: widget.state.sessionId,
    );
    final registry = _viewportRegistry;
    final generation = registry.membershipGenerationFor(key);
    if (generation == null) return;
    _viewportKey = key;
    _viewportMembershipGeneration = generation;
    final record = registry.recordFor(key);
    if (record == null || record.membershipGeneration != generation) return;
    _followTail = record.followTail;
    _showJumpLatest.value = !record.followTail;
    if (!record.followTail &&
        record.anchorMessageKey != null &&
        record.anchorViewportTop != null) {
      _semanticRestoreRecord = record;
      _semanticViewportRestorePending = true;
      _tailRevealPending = false;
      widget.controller.protectHistoryViewportAnchor(record.anchorMessageKey);
    }
  }

  void _ensureViewportAdmission() {
    if (_viewportKey != null && _viewportMembershipGeneration != null) return;
    final source = widget.state.source;
    if (source == null) return;
    final key = SessionViewportKey.forSource(
      source: source,
      tool: widget.state.tool,
      sessionId: widget.state.sessionId,
    );
    final generation = _viewportRegistry.membershipGenerationFor(key);
    if (generation == null) return;
    _viewportKey = key;
    _viewportMembershipGeneration = generation;
  }

  SessionViewportRecord? _viewportRecord() {
    final key = _viewportKey;
    if (key == null) return null;
    return _viewportRegistry.recordFor(key);
  }

  void _scheduleSemanticViewportCapture() {
    if (_viewportCaptureScheduled) return;
    _viewportCaptureScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _viewportCaptureScheduled = false;
      if (mounted) _captureSemanticViewport();
    });
  }

  void _captureSemanticViewport() {
    final capture = _semanticViewportCapture();
    if (capture == null) return;
    _commitSemanticViewportCapture(capture);
  }

  _SemanticViewportCapture? _semanticViewportCapture() {
    _ensureViewportAdmission();
    final key = _viewportKey;
    final generation = _viewportMembershipGeneration;
    if (key == null || generation == null) return null;
    if (_followTail) {
      return _SemanticViewportCapture(
        key: key,
        membershipGeneration: generation,
        followTail: true,
      );
    }

    final anchor = _firstUsefulVisibleMessage();
    if (anchor == null) return null;
    return _SemanticViewportCapture(
      key: key,
      membershipGeneration: generation,
      followTail: false,
      anchorMessageKey: anchor.stableMessageKey,
      anchorViewportTop: anchor.viewportTop,
    );
  }

  void _commitSemanticViewportCapture(_SemanticViewportCapture capture) {
    _viewportRegistry.capture(
      key: capture.key,
      membershipGeneration: capture.membershipGeneration,
      followTail: capture.followTail,
      anchorMessageKey: capture.anchorMessageKey,
      anchorViewportTop: capture.anchorViewportTop,
    );
    widget.controller.protectHistoryViewportAnchor(
      capture.followTail ? null : capture.anchorMessageKey,
    );
  }

  void _scheduleCapturedViewportCommit(_SemanticViewportCapture? capture) {
    if (capture == null) return;
    final registry = _viewportRegistry;
    final controller = widget.controller;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      registry.capture(
        key: capture.key,
        membershipGeneration: capture.membershipGeneration,
        followTail: capture.followTail,
        anchorMessageKey: capture.anchorMessageKey,
        anchorViewportTop: capture.anchorViewportTop,
      );
      controller.protectHistoryViewportAnchor(
        capture.followTail ? null : capture.anchorMessageKey,
      );
    });
    WidgetsBinding.instance.scheduleFrame();
  }

  ({String stableMessageKey, double viewportTop})?
  _firstUsefulVisibleMessage() {
    final position = _positionOrNull();
    if (position == null || position.viewportDimension <= 0) return null;
    for (final key in _orderedItemKeys) {
      final stableMessageKey = _messageStableKeyByItemKey[key];
      if (stableMessageKey == null) continue;
      final rowContext = key.currentContext;
      if (rowContext == null) continue;
      final renderObject = rowContext.findRenderObject();
      if (renderObject is! RenderBox || !renderObject.attached) continue;
      final viewport = RenderAbstractViewport.maybeOf(renderObject);
      if (viewport == null) continue;
      final viewportTop =
          viewport.getOffsetToReveal(renderObject, 0).offset - position.pixels;
      final viewportBottom = viewportTop + renderObject.size.height;
      if (viewportBottom < 0 || viewportTop > position.viewportDimension) {
        continue;
      }
      return (
        stableMessageKey: stableMessageKey,
        viewportTop: viewportTop,
      );
    }
    return null;
  }

  void _armSemanticViewportRestore({_SemanticViewportCapture? capture}) {
    final record = capture == null
        ? _viewportRecord()
        : SessionViewportRecord(
            followTail: capture.followTail,
            anchorMessageKey: capture.anchorMessageKey,
            anchorViewportTop: capture.anchorViewportTop,
            membershipGeneration: capture.membershipGeneration,
          );
    if (record == null ||
        record.followTail ||
        record.anchorMessageKey == null ||
        record.anchorViewportTop == null) {
      return;
    }
    _semanticRestoreRecord = record;
    _semanticRestoreItemKey = null;
    _semanticViewportRestoreAttempts = 0;
    _semanticViewportStableChecks = 0;
    _semanticViewportRestorePending = true;
    widget.controller.protectHistoryViewportAnchor(record.anchorMessageKey);
  }

  void _prepareSemanticViewportRestore() {
    if (!_semanticViewportRestorePending) return;
    final record = _semanticRestoreRecord;
    final stableKey = record?.anchorMessageKey;
    if (record == null || stableKey == null) {
      _finishSemanticViewportRestore();
      return;
    }
    final target = _itemKeyByStableMessageKey[stableKey];
    if (target != null) {
      _semanticRestoreItemKey = target;
      _scheduleSemanticViewportRestore();
      return;
    }
    if (_orderedItemKeys.isEmpty) {
      _scheduleSemanticViewportRestore();
      return;
    }
    if (!_bootstrapHasSettledTranscript(widget.state)) {
      _scheduleSemanticViewportRestore();
      return;
    }

    // The canonical row was genuinely compacted out. Clear that stale memory,
    // then fall back to the deterministic oldest retained message boundary.
    final viewportKey = _viewportKey;
    final generation = _viewportMembershipGeneration;
    if (viewportKey != null && generation != null) {
      final registry = _viewportRegistry;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        registry.clearRecord(
          key: viewportKey,
          membershipGeneration: generation,
        );
      });
      WidgetsBinding.instance.scheduleFrame();
    }
    _semanticRestoreItemKey = _messageItemKeys.isEmpty
        ? _orderedItemKeys.first
        : _orderedItemKeys.firstWhere(_messageItemKeys.contains);
    _semanticRestoreRecord = SessionViewportRecord(
      followTail: false,
      anchorMessageKey: _messageStableKeyByItemKey[_semanticRestoreItemKey!],
      anchorViewportTop: 0,
      membershipGeneration: generation ?? record.membershipGeneration,
    );
    _scheduleSemanticViewportRestore();
  }

  void _scheduleSemanticViewportRestore() {
    if (_semanticViewportRestoreScheduled) return;
    _semanticViewportRestoreScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _semanticViewportRestoreScheduled = false;
      if (mounted) _restoreSemanticViewport();
    });
    WidgetsBinding.instance.scheduleFrame();
  }

  void _restoreSemanticViewport() {
    if (!_semanticViewportRestorePending) return;
    _semanticViewportRestoreAttempts++;
    final position = _positionOrNull();
    final targetKey = _semanticRestoreItemKey;
    final record = _semanticRestoreRecord;
    if (position == null ||
        !position.hasContentDimensions ||
        targetKey == null ||
        record?.anchorViewportTop == null) {
      _retrySemanticViewportRestore();
      return;
    }

    final targetContext = targetKey.currentContext;
    if (targetContext == null) {
      _seekSemanticViewportTarget(position, targetKey);
      _retrySemanticViewportRestore();
      return;
    }
    final renderObject = targetContext.findRenderObject();
    if (renderObject is! RenderBox || !renderObject.attached) {
      _retrySemanticViewportRestore();
      return;
    }
    final viewport = RenderAbstractViewport.maybeOf(renderObject);
    if (viewport == null) {
      _retrySemanticViewportRestore();
      return;
    }
    final revealOffset = viewport.getOffsetToReveal(renderObject, 0).offset;
    final targetOffset = (revealOffset - record!.anchorViewportTop!).clamp(
      position.minScrollExtent,
      position.maxScrollExtent,
    );
    final delta = targetOffset - position.pixels;
    if (delta.abs() <= _semanticViewportTolerance) {
      _semanticViewportStableChecks++;
      if (_semanticViewportStableChecks >=
          _requiredSemanticViewportStableChecks) {
        _finishSemanticViewportRestore();
      } else {
        _retrySemanticViewportRestore();
      }
      return;
    }
    _semanticViewportStableChecks = 0;
    position.jumpTo(targetOffset);
    _retrySemanticViewportRestore();
  }

  void _seekSemanticViewportTarget(
    ScrollPosition position,
    GlobalKey<State<StatefulWidget>> targetKey,
  ) {
    final targetIndex = _itemIndexByKey[targetKey];
    if (targetIndex == null || _mountedRowContexts.isEmpty) return;
    final mounted = <({int index, double offset, double height})>[];
    for (final entry in _mountedRowContexts.entries) {
      final index = _itemIndexByKey[entry.key];
      final renderObject = entry.value.findRenderObject();
      if (index == null ||
          renderObject is! RenderBox ||
          !renderObject.attached) {
        continue;
      }
      final viewport = RenderAbstractViewport.maybeOf(renderObject);
      if (viewport == null) continue;
      mounted.add((
        index: index,
        offset: viewport.getOffsetToReveal(renderObject, 0).offset,
        height: renderObject.size.height,
      ));
    }
    if (mounted.isEmpty) return;
    mounted.sort((a, b) => a.index.compareTo(b.index));
    final first = mounted.first;
    final last = mounted.last;
    final averageExtent =
        mounted.fold<double>(0, (sum, row) => sum + row.height) /
        mounted.length;
    final estimated = targetIndex < first.index
        ? first.offset - (first.index - targetIndex) * averageExtent
        : last.offset + (targetIndex - last.index) * averageExtent;
    final target = estimated.clamp(
      position.minScrollExtent,
      position.maxScrollExtent,
    );
    if ((target - position.pixels).abs() > _semanticViewportTolerance) {
      position.jumpTo(target);
    }
  }

  void _retrySemanticViewportRestore() {
    if (_semanticViewportRestoreAttempts >=
        _maxSemanticViewportRestoreAttempts) {
      _finishSemanticViewportRestore();
      return;
    }
    _scheduleSemanticViewportRestore();
  }

  void _finishSemanticViewportRestore() {
    if (!_semanticViewportRestorePending) return;
    _semanticViewportRestorePending = false;
    _semanticViewportStableChecks = 0;
    _semanticViewportRestoreAttempts = 0;
    _semanticRestoreItemKey = null;
    _semanticRestoreRecord = null;
    _captureSemanticViewport();
    setState(() {});
  }

  void _retryHistoryAnchorRestore() {
    if (_historyAnchorRestoreAttempts >= _maxHistoryAnchorRestoreAttempts) {
      _clearHistoryAnchorState();
      return;
    }
    _scheduleHistoryAnchorRestore();
  }

  void _restoreHistoryAnchor() {
    final position = _positionOrNull();
    if (!_historyAnchorRestorePending) return;
    _historyAnchorRestoreAttempts += 1;
    if (position == null || !position.hasContentDimensions) {
      _historyAnchorStableChecks = 0;
      _retryHistoryAnchorRestore();
      return;
    }

    if (_followTail) {
      _clearHistoryAnchorState();
      return;
    }

    final key = _historyAnchorKey;
    final anchorRevealDelta = _historyAnchorRevealDelta;
    if (key == null || anchorRevealDelta == null) {
      _clearHistoryAnchorState();
      return;
    }

    final keyContext = key.currentContext;
    if (keyContext == null) {
      _historyAnchorStableChecks = 0;
      _retryHistoryAnchorRestore();
      return;
    }

    final renderObject = keyContext.findRenderObject();
    if (renderObject is! RenderBox || !renderObject.attached) {
      _historyAnchorStableChecks = 0;
      _retryHistoryAnchorRestore();
      return;
    }

    final viewport = RenderAbstractViewport.maybeOf(renderObject);
    if (viewport == null) {
      _historyAnchorStableChecks = 0;
      _retryHistoryAnchorRestore();
      return;
    }

    final revealOffset = viewport.getOffsetToReveal(renderObject, 0).offset;
    final targetOffset = revealOffset - anchorRevealDelta;
    final offsetDelta = targetOffset - position.pixels;
    if (offsetDelta.abs() <= _historyAnchorTolerance) {
      _historyAnchorStableChecks += 1;
      if (_historyAnchorStableChecks >= _requiredHistoryAnchorStableChecks) {
        _clearHistoryAnchorState();
      } else {
        _retryHistoryAnchorRestore();
      }
      return;
    }
    _historyAnchorStableChecks = 0;
    final newOffset = (position.pixels + offsetDelta).clamp(
      0.0,
      position.maxScrollExtent,
    );
    if (newOffset == position.pixels) {
      _retryHistoryAnchorRestore();
      return;
    }
    position.jumpTo(newOffset);
    _retryHistoryAnchorRestore();
  }

  void _scheduleHistoryAnchorRestore() {
    if (_historyAnchorRestoreScheduled) return;
    _historyAnchorRestoreScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _historyAnchorRestoreScheduled = false;
      if (!mounted) return;
      _restoreHistoryAnchor();
    });
    WidgetsBinding.instance.scheduleFrame();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final inlineTarget = InlineScheduledMessageKey(
      tool: widget.state.tool,
      sessionId: widget.state.sessionId,
    );
    final inlineState = ref.watch(
      inlineScheduledMessageControllerProvider(inlineTarget),
    );
    // U6: the schedule controller's automatic work rides the transport state
    // this surface already renders — no probe, endpoint, or second timer. It is
    // reported rather than watched, and it is NOT part of the family key: both
    // would rebuild the notifier on every connect/disconnect frame and drop the
    // cached cards. Repeated frames of the same value are a no-op inside the
    // controller, and nothing here writes provider state during this build.
    final inlineController =
        ref.read(
            inlineScheduledMessageControllerProvider(inlineTarget).notifier,
          )
          ..setHostVisible(visible: TickerMode.valuesOf(context).enabled)
          ..setTransportConnected(connected: widget.isConnected);
    final rowWork = debugTranscriptRowWork;
    final conversationPageSegments = widget.state
        .transcriptConversationSegments(widget.toolDisplayMode);
    final leadingTranscriptGap = widget.state.leadingTranscriptHistoryGap;
    final historyGap = widget.state.latestHistoryGap;
    final chatItems = <_ChatItem>[];
    if (leadingTranscriptGap != null) {
      chatItems.add(_ChatHistoryGapItem(leadingTranscriptGap));
    }
    for (final segment in conversationPageSegments) {
      if (segment.gapBefore case final gap?) {
        chatItems.add(_ChatHistoryGapItem(gap));
      }
      chatItems.addAll(
        _flattenConversationTurns(
          turns: segment.turns,
          reportView: widget.reportView,
          work: rowWork,
        ),
      );
    }
    // Requests whose resolution already arrived — locally, or from another
    // client of the shared owner (incl. `decision: external`) — must not keep a
    // live action card. The gate is the *presence* of a `*-resolved` message
    // for the requestId, not its decision value, so external/unknown/any future
    // decision all deactivate the card. Pairing is by canonical request id
    // ONLY — never by text, nearest row, event type alone, or turn position —
    // and the ids come from the canonical transcript, so the request card
    // keeps its compact outcome even though resolution frames render no
    // standalone clean-Chat row (CR2).
    // See docs/project/implementation-status.md (WP1).
    final resolvedRequestDecisions = widget.state.resolvedRequestDecisions;
    final resolvedRequestIds = resolvedRequestDecisions.keys.toSet();
    // Permission/question cards are mutating (not prompt-class), so they ride
    // the broader gate: actionable only when the app owns input (driving or
    // active sync, incl. answer-only). On a read-only Observe session the
    // broker rejects the answer, so the buttons stay inert here too. — WP2.
    final canMutate =
        !widget.state.compatibilityReadOnly &&
        SessionControlView.fromSessionDetailState(widget.state).canMutate;
    final inlineWidgets = <Widget>[
      for (final schedule in inlineState.schedules)
        InlineScheduledMessageCard(
          schedule: schedule,
          busy: inlineState.mutatingIds.contains(schedule.id),
          onEdit: () => unawaited(
            _editInlineSchedule(
              context,
              schedule,
              inlineController,
            ),
          ),
          onCancel: () => unawaited(inlineController.cancel(schedule.id)),
        ),
    ];

    return ToolDisplayModeScope(
      mode: widget.toolDisplayMode,
      toolsExpanded: widget.toolsExpanded,
      expansionRevision: widget.toolExpansionRevision,
      child: Builder(
        builder: (scopedContext) {
          final showHistoryNotice =
              historyGap != null ||
              widget.state.hasEarlierHistory ||
              widget.state.historyPageLoading ||
              widget.state.historyPageError != null ||
              widget.state.historyStartReached;
          // Every explicit edit, cancellation, or manual refresh failure
          // reaches this row. A passive lifecycle refresh reaches it only when
          // the next poll cannot resolve the failure without the user —
          // authentication and structured rejections. Ordinary connectivity
          // noise records staleness in controller state instead, so a dropped
          // connection no longer paints red transcript text that a later
          // successful poll silently removes.
          final inlineError = inlineState.mutationError;
          final historyLoading = widget.state.historyPageLoading;
          final historyAnchorTransitionToLoading =
              !_historyPageWasLoading && historyLoading && !_followTail;
          final historyAnchorTransitionToReady =
              _historyPageWasLoading && !historyLoading && !_followTail;

          if (historyAnchorTransitionToLoading) {
            _historyAnchorRestorePending = false;
            _historyAnchorRestoreAttempts = 0;
            _historyAnchorStableChecks = 0;
          } else if (historyAnchorTransitionToReady) {
            _historyAnchorRestorePending = _historyAnchorKey != null;
            if (!_historyAnchorRestorePending) {
              _scheduleBlockedHistoryIntentResume();
            }
          }
          _historyPageWasLoading = historyLoading;

          Widget wrapContextRegion(AgentMessage message, Widget child) {
            return _MessageContextRegion(
              message: message,
              canFork: widget.isConnected && widget.canFork,
              onForkFromMessage: widget.onForkFromMessage,
              child: TranscriptMessageMetadataScope(
                timestamp: message.timestamp,
                child: child,
              ),
            );
          }

          Widget buildTurnEntryRow(SessionTranscriptDisplayEntry entry) {
            return switch (entry) {
              MessageTranscriptDisplayEntry(:final message) =>
                switch (message.type) {
                  AgentMessageType.modelOutput => wrapContextRegion(
                    message,
                    buildConversationModelOutput(scopedContext, message),
                  ),
                  AgentMessageType.thinking => wrapContextRegion(
                    message,
                    buildConversationThinkingRow(scopedContext, message),
                  ),
                  // A queued prompt inside a turn is still a user bubble (the
                  // opener is rendered separately); route it to the same clean,
                  // header-less bubble so it dims with a localized badge.
                  AgentMessageType.userMessage => wrapContextRegion(
                    message,
                    buildConversationUserBubble(scopedContext, message),
                  ),
                  // Requests, errors, notices, artifacts, and system surfaces
                  // keep their dedicated row (permission/question actions).
                  _ => _MessageRow(
                    message: message,
                    controller: widget.controller,
                    isConnected: widget.isConnected,
                    hasActiveBrokerClient: widget.hasActiveBrokerClient,
                    canFork: widget.canFork,
                    canMutate: canMutate,
                    onExtractRequestId: extractRequestIdFromMessage,
                    isNewestEligibleForIdentity: false,
                    resolvedRequestIds: resolvedRequestIds,
                    resolvedRequestDecisions: resolvedRequestDecisions,
                    onForkFromMessage: widget.onForkFromMessage,
                    artifactActionState: _artifactActionStateForMessage(
                      widget.state,
                      message,
                    ),
                  ),
                },
              ToolTranscriptDisplayEntry(:final primaryMessage) =>
                _MessageContextRegion(
                  message: primaryMessage,
                  canFork: widget.isConnected && widget.canFork,
                  onForkFromMessage: widget.onForkFromMessage,
                  child: TranscriptMessageMetadataScope(
                    timestamp: primaryMessage.timestamp,
                    child: buildToolTranscriptRenderer(
                      scopedContext,
                      entry,
                      toolsExpanded: widget.toolsExpanded,
                      expansionRevision: widget.toolExpansionRevision,
                    ),
                  ),
                ),
              LookupGroupTranscriptDisplayEntry(:final tools) =>
                _MessageContextRegion(
                  message: tools.first.primaryMessage,
                  canFork: widget.isConnected && widget.canFork,
                  onForkFromMessage: widget.onForkFromMessage,
                  child: buildLookupGroupRenderer(
                    scopedContext,
                    entry,
                    toolsExpanded: widget.toolsExpanded,
                    expansionRevision: widget.toolExpansionRevision,
                  ),
                ),
            };
          }

          // The artifact the user sent keeps the same download/open control
          // the standalone artifact row has; only its placement changes.
          Widget? userAttachmentAction(AgentMessage attachment) {
            final descriptor = SessionArtifactDescriptor.fromMessage(
              attachment,
            );
            if (descriptor == null || !descriptor.isDownloadable) return null;
            return _TranscriptArtifactDownloadAction(
              descriptor: descriptor,
              actionState: _artifactActionStateForMessage(
                widget.state,
                attachment,
              ),
              hasActiveBrokerClient: widget.hasActiveBrokerClient,
              onDownload: () => widget.controller.downloadArtifact(descriptor),
            );
          }

          Widget buildChatItem(_ChatItem item) {
            return switch (item) {
              _ChatUserItem(:final message, :final attachments) =>
                wrapContextRegion(
                  message,
                  buildConversationUserBubble(
                    scopedContext,
                    message,
                    attachments: attachments,
                    attachmentActionBuilder: userAttachmentAction,
                  ),
                ),
              _ChatEntryItem(:final entry) => buildTurnEntryRow(entry),
              _ChatFooterItem(:final turn) => _ConversationTurnFooter(
                key: ValueKey('turn-footer-${turn.turnKey}'),
                turn: turn,
              ),
              _ChatHistoryGapItem(:final gap) => _HistoryDecodedGapRow(
                gap: gap,
                connected: widget.isConnected,
                loading: widget.state.historyPageLoading,
                failed: widget.state.historyPageError != null,
                terminalFailure: isTerminalHistoryPageErrorCode(
                  widget.state.historyPageErrorCode,
                ),
                onRetry: gap.reloadCursor == null
                    ? null
                    : () {
                        _requestHistoryCursor(
                          gap.reloadCursor!,
                          leadingEdge: false,
                        );
                      },
              ),
            };
          }

          // "No messages in this session yet" is a claim about the SESSION. A
          // history the broker could not read says nothing about it, and
          // pairing that copy with the recovery notice above is exactly the
          // contradiction H1c reproduces. The notice is the whole answer here.
          final showEmptyTranscript =
              chatItems.isEmpty &&
              inlineWidgets.isEmpty &&
              !isHistoryUnavailableGapCode(historyGap?.code) &&
              _bootstrapHasSettledTranscript(widget.state);
          final emptyTranscript = !widget.state.hasTranscriptMessages
              ? AppLocalizations.of(context).sessionDetailTranscriptEmpty
              : AppLocalizations.of(context).sessionDetailTranscriptReportEmpty;

          final messageCount = chatItems.length;
          final noticeCount = showHistoryNotice ? 1 : 0;
          final messageOffset = noticeCount;
          final emptyOffset = messageOffset + messageCount;
          final emptyCount = showEmptyTranscript ? 1 : 0;
          final inlineOffset = emptyOffset + emptyCount;
          final inlineCount = inlineWidgets.length;
          final errorOffset = inlineOffset + inlineCount;
          final totalItems =
              noticeCount +
              messageCount +
              emptyCount +
              inlineCount +
              (inlineError == null ? 0 : 1);
          // De-dupe so no two rows ever share a GlobalKey. A split tool
          // call/result pair (call in one turn, result in the next) resolves to
          // the same call-id identity; suffixing a repeat keeps that a harmless
          // duplicate row instead of a duplicate-GlobalKey crash.
          final itemIdentities = _uniqueRowIdentities(<String>[
            if (showHistoryNotice) 'history-notice',
            for (final item in chatItems) item.identity,
            if (showEmptyTranscript) 'session-detail-empty-row',
            for (final schedule in inlineState.schedules)
              'inline:${schedule.id}',
            if (inlineError != null) 'inline-error',
          ]);
          final canonicalMessageKeys = <String?>[
            if (showHistoryNotice) null,
            for (final item in chatItems) item.canonicalMessageKey,
            if (showEmptyTranscript) null,
            for (final _ in inlineState.schedules) null,
            if (inlineError != null) null,
          ];
          final messageIndices = <int>{
            for (var index = 0; index < chatItems.length; index++)
              if (chatItems[index].isAnchorRow) messageOffset + index,
          };
          assert(
            itemIdentities.length == totalItems,
            'Every logical transcript item must have a stable identity.',
          );
          // Identity de-duping and the row-key registry walk every retained
          // row, by design: both are order-sensitive over the whole list.
          // H1 caps that list, so the cost is bounded (five pages / 500
          // messages / 4 MiB) and constant in history depth — unlike the
          // per-row derivation above, which is cached and only touches rows
          // that actually changed.
          rowWork?.reconciledRows += totalItems;
          _syncItemRegistry(
            identities: itemIdentities,
            messageIndices: messageIndices,
            canonicalMessageKeys: canonicalMessageKeys,
          );
          _reloadableGapCursorByItemKey.clear();
          for (var index = 0; index < chatItems.length; index++) {
            final item = chatItems[index];
            if (item case _ChatHistoryGapItem(
              gap: TranscriptHistoryGapSegment(
                kind: TranscriptHistoryGapKind.reloadable,
                reloadCursor: final cursor?,
              ),
            )) {
              _reloadableGapCursorByItemKey[_orderedItemKeys[messageOffset +
                      index]] =
                  cursor;
            }
          }
          _totalRowCount = totalItems;
          _prepareSemanticViewportRestore();

          // Every row registers its laid-out geometry under its stable key so
          // the logical progress reading walks only mounted rows.
          Widget rowShell(
            GlobalKey<State<StatefulWidget>> key,
            Widget child,
          ) => _TranscriptRowGeometryTracker(
            key: key,
            registryKey: key,
            registry: _mountedRowContexts,
            // A row entering/leaving layout is exactly when the lazy extent
            // estimate corrects — often with no notification and no rebuild —
            // so it must refresh the reading itself.
            onGeometryChanged: _scheduleProgressRefresh,
            child: _ReadableColumn(child: child),
          );

          Widget buildScrollItem(int index) {
            final key = _orderedItemKeys[index];
            if (showHistoryNotice && index == 0) {
              return rowShell(
                key,
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: _HistoryScopeNotice(
                    gap: historyGap,
                    hasEarlier: widget.state.hasEarlierHistory,
                    startReached: widget.state.historyStartReached,
                    connected: widget.isConnected,
                    loading: historyLoading,
                    pagingError: widget.state.historyPageError,
                    pagingErrorCode: widget.state.historyPageErrorCode,
                    onLoadEarlier: widget.isConnected
                        ? _requestEarlierExplicitly
                        : null,
                  ),
                ),
              );
            }

            final messageIndex = index - messageOffset;
            if (messageIndex >= 0 && messageIndex < messageCount) {
              final item = chatItems[messageIndex];
              return rowShell(
                key,
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: buildChatItem(item),
                ),
              );
            }

            if (showEmptyTranscript && index == emptyOffset) {
              return rowShell(
                key,
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Text(
                    emptyTranscript,
                    key: const Key('session-detail-transcript-empty'),
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: context.tokens.textSecondary,
                    ),
                  ),
                ),
              );
            }

            final inlineIndex = index - inlineOffset;
            if (inlineIndex >= 0 && inlineIndex < inlineCount) {
              return rowShell(
                key,
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: inlineWidgets[inlineIndex],
                ),
              );
            }

            if (inlineError != null && index == errorOffset) {
              return rowShell(
                key,
                Padding(
                  padding: const EdgeInsets.only(bottom: 8),
                  child: Text(
                    inlineScheduleActionMessage(
                      AppLocalizations.of(scopedContext),
                      inlineError,
                    ),
                    key: const Key('schedule-inline-error'),
                    style: theme.textTheme.bodyMedium?.copyWith(
                      color: context.tokens.statusError,
                    ),
                  ),
                ),
              );
            }

            return rowShell(key, const SizedBox.shrink());
          }

          // U5b: nothing to re-arm here. The tail invariant lives in the
          // scroll physics below, which corrects during layout — so growth
          // never paints an un-settled frame that a post-frame jump then has
          // to walk back.
          // U5: an accepted `HistoryWireEvent(reset: true)` is the modeled
          // boundary at which an authoritative transcript replaces the visible
          // one (fresh open, cached snapshot replaced by broker history,
          // reconnect replay, retry after failure). Only that boundary re-arms
          // the gate — never display-row shape: live appends, history
          // prepends, notice/inline-row churn, and tool-projection changes all
          // alter row identities and counts during an already-visible session
          // without replacing it, and hiding an already-open transcript on
          // those would be a blank flash. The generation marker still advances
          // while the user reads history (`!_followTail`), so a replacement
          // that lands mid-read is consumed without a later re-arm.
          final resetGeneration = widget.state.transcriptResetGeneration;
          if (resetGeneration != _lastTranscriptResetGeneration) {
            _lastTranscriptResetGeneration = resetGeneration;
            if (_followTail && totalItems > 0) {
              _tailRevealPending = true;
              _tailRevealAttempts = 0;
            }
          }
          if (_tailRevealPending && !_semanticViewportRestorePending) {
            _scheduleTailRevealSettle();
          }
          // List growth, prepends, and expansion change row geometry without a
          // gesture; refresh the reading once this frame lays out.
          _scheduleProgressRefresh();
          if (_historyAnchorRestorePending) {
            _scheduleHistoryAnchorRestore();
          }
          // The scroll view spans the full tab width; readability comes from
          // constraining each row instead of the viewport (see
          // `_ReadableColumn`). The native scrollbar is suppressed: its thumb
          // position derives from the ESTIMATED extent of unbuilt
          // variable-height rows, which reverses mid-gesture as estimates
          // correct. The passive right-edge thumb below uses logical row
          // progress instead (N2-D); drag-to-position would need a real
          // index-aware virtualized controller, so no fake draggable thumb is
          // offered.
          final scrollSurface = NotificationListener<ScrollMetricsNotification>(
            // Fired when the scrollable's metrics change WITHOUT a scroll —
            // exactly the lazy-extent correction case — so the reading (and
            // its at-tail latch) never goes stale between gestures. The
            // notification is dispatched mid-layout, and reading row geometry
            // there is illegal, so the reading is deferred to after the frame.
            onNotification: (notification) {
              if (notification.depth == 0) {
                _scheduleProgressRefresh();
              }
              return false;
            },
            child: NotificationListener<ScrollNotification>(
              onNotification: _onScrollNotification,
              child: Listener(
                behavior: HitTestBehavior.translucent,
                onPointerMove: (event) {
                  if (event.delta.dy.abs() > 0.01) {
                    _recordRealScrollMovement(
                      upward: event.delta.dy > 0,
                      distance: event.delta.dy.abs(),
                    );
                  }
                },
                onPointerCancel: (_) => _clearUpwardHistoryIntent(),
                onPointerSignal: (event) {
                  if (event is PointerScrollEvent &&
                      event.scrollDelta.dy.abs() > 0.01) {
                    _recordRealScrollMovement(
                      upward: event.scrollDelta.dy < 0,
                      distance: event.scrollDelta.dy.abs(),
                    );
                  }
                },
                onPointerPanZoomUpdate: (event) {
                  if (event.panDelta.dy.abs() > 0.01) {
                    _recordRealScrollMovement(
                      upward: event.panDelta.dy > 0,
                      distance: event.panDelta.dy.abs(),
                    );
                  }
                },
                child: GestureDetector(
                  behavior: HitTestBehavior.translucent,
                  onTap: _focusHistoryAfterCompletedTap,
                  child: CallbackShortcuts(
                    bindings: {
                      const SingleActivator(
                        LogicalKeyboardKey.pageUp,
                        alt: true,
                      ): _requestEarlierExplicitly,
                    },
                    child: SelectionArea(
                      key: const Key('session-history-shortcut-focus'),
                      focusNode: _historyShortcutFocusNode,
                      onSelectionChanged: _onTranscriptSelectionChanged,
                      contextMenuBuilder: _transcriptSelectionMenu,
                      child: _TranscriptSelectionScope(
                        registry: _selectionRegistry,
                        child: Stack(
                          children: [
                            ScrollConfiguration(
                              behavior: ScrollConfiguration.of(
                                context,
                              ).copyWith(scrollbars: false),
                              child: ListView.builder(
                                key: const Key('session-detail-chat-scroll'),
                                controller: _scrollController,
                                scrollCacheExtent:
                                    const ScrollCacheExtent.viewport(
                                      2,
                                    ),
                                // U5b: the tail invariant. Applied to the
                                // ambient physics so platform scroll feel
                                // (bounce, clamp, fling) is untouched.
                                physics: _transcriptPhysics.applyTo(
                                  ScrollConfiguration.of(
                                    context,
                                  ).getScrollPhysics(
                                    context,
                                  ),
                                ),
                                findChildIndexCallback: _findChildIndex,
                                itemCount: totalItems,
                                itemBuilder: (context, index) =>
                                    buildScrollItem(index),
                              ),
                            ),
                            Positioned(
                              top: 0,
                              bottom: 0,
                              right: 0,
                              width: 8,
                              child: _TranscriptReadingScrollbar(
                                progress: _progressValue,
                                viewportFraction: _progressViewportFraction,
                                active: _progressActive,
                              ),
                            ),
                            Positioned(
                              right: 16,
                              bottom: 16,
                              child: ValueListenableBuilder<bool>(
                                valueListenable: _showJumpLatest,
                                builder: (context, visible, _) => Offstage(
                                  offstage: !visible,
                                  child: IconButton.filledTonal(
                                    key: const Key(
                                      'session-history-jump-latest',
                                    ),
                                    onPressed: _jumpToLatest,
                                    tooltip: AppLocalizations.of(
                                      context,
                                    ).sessionHistoryJumpLatest,
                                    icon: const Icon(Icons.arrow_downward),
                                  ),
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          );
          // U5 opening gate: the list keeps laying out (the lazy extent must
          // converge) but paints nothing until `_isTailSettled` confirms the
          // actual last row at the real tail, so the opening chase never
          // becomes visible motion. Revealed once, in place — no delay or
          // animation is added. While hidden, the region shows the same
          // bootstrap loading treatment the page uses before the transcript
          // is ready — never a blank region. The [Offstage] and [Stack]
          // shapes are constant, so toggling never remounts the scroll
          // subtree or its rows.
          return Stack(
            children: [
              Offstage(
                key: const Key('session-transcript-tail-reveal-gate'),
                offstage: _tailRevealPending || _semanticViewportRestorePending,
                child: scrollSurface,
              ),
              if (_tailRevealPending || _semanticViewportRestorePending)
                Positioned.fill(
                  child: _SessionDetailBootstrapSurface(
                    bootstrap: widget.state.bootstrapState,
                    retrying: widget.bootstrapRetrying,
                    onRetry: widget.onRetryBootstrap,
                  ),
                ),
            ],
          );
        },
      ),
    );
  }
}

SessionArtifactActionState _artifactActionStateForMessage(
  SessionDetailState state,
  AgentMessage message,
) {
  final descriptor = SessionArtifactDescriptor.fromMessage(message);
  return descriptor == null
      ? const SessionArtifactActionState(
          phase: SessionArtifactActionPhase.idle,
        )
      : state.actionStateFor(descriptor.actionStateKey);
}

/// Registers one transcript row's [BuildContext] while it is mounted, so the
/// progress reading can measure exactly the laid-out rows — `O(visible rows)`
/// per reading — instead of scanning the whole transcript.
///
/// Carries the row's registry [GlobalKey] itself (as its widget key), so the
/// anchor-restore machinery keeps resolving `key.currentContext` to the same
/// render subtree as before.
class _TranscriptRowGeometryTracker extends StatefulWidget {
  const _TranscriptRowGeometryTracker({
    required this.registryKey,
    required this.registry,
    required this.onGeometryChanged,
    required this.child,
    super.key,
  });

  final GlobalKey<State<StatefulWidget>> registryKey;
  final Map<GlobalKey<State<StatefulWidget>>, BuildContext> registry;
  final VoidCallback onGeometryChanged;
  final Widget child;

  @override
  State<_TranscriptRowGeometryTracker> createState() =>
      _TranscriptRowGeometryTrackerState();
}

class _TranscriptRowGeometryTrackerState
    extends State<_TranscriptRowGeometryTracker> {
  @override
  void initState() {
    super.initState();
    widget.registry[widget.registryKey] = context;
    widget.onGeometryChanged();
  }

  @override
  void didUpdateWidget(_TranscriptRowGeometryTracker oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.registryKey != widget.registryKey) {
      if (identical(oldWidget.registry[oldWidget.registryKey], context)) {
        oldWidget.registry.remove(oldWidget.registryKey);
      }
      widget.registry[widget.registryKey] = context;
    }
  }

  @override
  void dispose() {
    if (identical(widget.registry[widget.registryKey], context)) {
      widget.registry.remove(widget.registryKey);
    }
    widget.onGeometryChanged();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// Passive monotone right-edge scrollbar for the transcript (N2-D).
///
/// It looks and behaves visually like the platform's auto-hiding vertical
/// indicator, but its thumb position and extent come from mounted logical rows
/// rather than Flutter's unstable estimated pixel extent. It is intentionally
/// passive: a trustworthy draggable thumb requires an index-aware virtualized
/// controller.
class _TranscriptReadingScrollbar extends StatelessWidget {
  const _TranscriptReadingScrollbar({
    required this.progress,
    required this.viewportFraction,
    required this.active,
  });

  final ValueListenable<double?> progress;
  final ValueListenable<double> viewportFraction;
  final ValueListenable<bool> active;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return IgnorePointer(
      child: ExcludeSemantics(
        child: ValueListenableBuilder<bool>(
          valueListenable: active,
          builder: (context, visible, child) => AnimatedOpacity(
            key: const Key('session-transcript-scrollbar'),
            opacity: visible ? 1 : 0,
            duration: const Duration(milliseconds: 200),
            child: child,
          ),
          child: Stack(
            fit: StackFit.expand,
            children: [
              Align(
                alignment: AlignmentDirectional.centerEnd,
                child: SizedBox(
                  width: 2,
                  height: double.infinity,
                  child: ColoredBox(color: tokens.separator),
                ),
              ),
              ValueListenableBuilder<double?>(
                valueListenable: progress,
                builder: (context, value, _) {
                  if (value == null) return const SizedBox.shrink();
                  return ValueListenableBuilder<double>(
                    valueListenable: viewportFraction,
                    builder: (context, extentValue, _) {
                      final logicalExtent = extentValue.clamp(0.0, 1.0);
                      final logicalRange = 1 - logicalExtent;
                      final logicalTop = logicalRange <= 0
                          ? 0.0
                          : ((value - logicalExtent) / logicalRange).clamp(
                              0.0,
                              1.0,
                            );
                      return LayoutBuilder(
                        builder: (context, constraints) {
                          final proportionalHeight =
                              constraints.maxHeight * logicalExtent;
                          final preferredHeight = proportionalHeight < 40
                              ? 40.0
                              : proportionalHeight;
                          final thumbHeight =
                              preferredHeight > constraints.maxHeight
                              ? constraints.maxHeight
                              : preferredHeight;
                          return Align(
                            key: const Key(
                              'session-transcript-scrollbar-thumb',
                            ),
                            alignment: AlignmentDirectional(
                              1,
                              logicalTop * 2 - 1,
                            ),
                            child: SizedBox(
                              width: 4,
                              height: thumbHeight,
                              child: ColoredBox(color: tokens.textSecondary),
                            ),
                          );
                        },
                      );
                    },
                  );
                },
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Constrains one transcript/composer row to a readable measure while keeping
/// the phone gutter.
///
/// The measure scales with the pane above [minWidth] — see [widthFraction].
/// Below it the [ConstrainedBox] is a no-op, so the horizontal padding is what
/// stops content from hitting the screen edge on a phone — it must sit *inside*
/// the constraint, not outside it, or narrow viewports lose the gutter
/// entirely.
class _ReadableColumn extends StatelessWidget {
  const _ReadableColumn({required this.child});

  /// Floor for the transcript measure, in logical pixels.
  ///
  /// The old 800 was a pure prose measure, but transcript rows are mostly not
  /// prose: fenced code, diffs, and command output all read worse when wrapped
  /// early, and on a 1440px window 800 left roughly 300px of dead gutter on
  /// each side. 1180 keeps paragraphs inside a readable line length at the
  /// default text scale while giving block content room to breathe.
  ///
  /// This is now a *floor*, not a cap: see [widthFraction]. Below it the
  /// [ConstrainedBox] is a no-op, so the horizontal padding is what stops
  /// content from hitting the screen edge on a phone.
  ///
  /// This is the single place the transcript measure is defined — the bubble's
  /// own width factor is expressed relative to it rather than as a second
  /// independent magic number.
  static const double minWidth = 1180;

  /// Share of the pane the transcript takes once the pane is wider than
  /// [minWidth] / [widthFraction] (≈1388dp).
  ///
  /// A fixed 1180 cap was fine at 1440 but starved a 4K pane: measured, the
  /// chat pane is 3511dp at 3840 and the rows inside it ran 1148dp — 32.7% of
  /// the pane, with the rest dead gutter. Scaling with the pane instead puts
  /// that surplus back into content and leaves one number to tune.
  ///
  /// Expressed as `max(minWidth, available * widthFraction)` so the measure is
  /// monotone in the pane width and never *narrower* than it used to be at any
  /// size — mid-size windows and phones are untouched.
  static const double widthFraction = 0.85;

  /// Resolved measure for a pane of [available] logical pixels.
  static double measureFor(double available) {
    if (!available.isFinite) return minWidth;
    final proportional = available * widthFraction;
    return proportional > minWidth ? proportional : minWidth;
  }

  final Widget child;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        return Center(
          child: ConstrainedBox(
            constraints: BoxConstraints(
              maxWidth: measureFor(constraints.maxWidth),
            ),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: child,
            ),
          ),
        );
      },
    );
  }
}

Future<void> _editInlineSchedule(
  BuildContext context,
  ScheduleRecord schedule,
  InlineScheduledMessageController controller,
) async {
  final update = await showScheduleMessageEditSheet(
    context,
    schedule: schedule,
  );
  if (update != null) await controller.update(schedule.id, update);
}

class _HistoryDecodedGapRow extends StatelessWidget {
  const _HistoryDecodedGapRow({
    required this.gap,
    required this.connected,
    required this.loading,
    required this.failed,
    required this.terminalFailure,
    required this.onRetry,
  });

  final TranscriptHistoryGapSegment gap;
  final bool connected;
  final bool loading;
  final bool failed;
  final bool terminalFailure;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final reloadable = gap.kind == TranscriptHistoryGapKind.reloadable;
    return Semantics(
      container: true,
      label: reloadable
          ? l10n.sessionHistoryDecodedGap
          : l10n.sessionHistoryDecodedGapReconnect,
      child: ConstrainedBox(
        key: Key(gap.id),
        constraints: const BoxConstraints(minHeight: 36),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (loading && reloadable)
                const SizedBox.square(
                  dimension: 14,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              else
                Icon(
                  failed && reloadable ? Icons.error_outline : Icons.more_horiz,
                  size: 16,
                  color: failed && reloadable
                      ? tokens.statusError
                      : tokens.textTertiary,
                ),
              const SizedBox(width: 8),
              Flexible(
                child: Text(
                  !reloadable
                      ? l10n.sessionHistoryDecodedGapReconnect
                      : failed
                      ? l10n.sessionHistoryLoadFailed
                      : loading
                      ? l10n.sessionHistoryLoadingEarlier
                      : l10n.sessionHistoryDecodedGap,
                  style: Theme.of(context).textTheme.labelSmall?.copyWith(
                    color: failed && reloadable
                        ? tokens.statusError
                        : tokens.textTertiary,
                  ),
                  textAlign: TextAlign.center,
                ),
              ),
              if (reloadable && failed && !terminalFailure) ...[
                const SizedBox(width: 8),
                TextButton(
                  key: Key('${gap.id}-reload'),
                  onPressed: connected && !loading ? onRetry : null,
                  child: Text(l10n.sessionHistoryRetry),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _HistoryScopeNotice extends StatelessWidget {
  const _HistoryScopeNotice({
    required this.gap,
    required this.hasEarlier,
    required this.startReached,
    required this.connected,
    required this.loading,
    required this.pagingError,
    required this.pagingErrorCode,
    required this.onLoadEarlier,
  });

  final HistoryGap? gap;
  final bool hasEarlier;
  final bool startReached;
  final bool connected;
  final bool loading;
  final String? pagingError;
  final String? pagingErrorCode;
  final VoidCallback? onLoadEarlier;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    final gapMessage = gap?.message.trim();
    final failure = pagingError != null;
    final terminalFailure = isTerminalHistoryPageErrorCode(pagingErrorCode);

    Widget statusRow() {
      if (startReached) {
        return Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(
              Icons.first_page,
              size: 16,
              color: tokens.textTertiary,
            ),
            const SizedBox(width: 8),
            Text(
              l10n.sessionHistoryStart,
              key: const Key('session-history-start-marker'),
              style: theme.textTheme.labelSmall?.copyWith(
                color: tokens.textTertiary,
              ),
            ),
          ],
        );
      }
      if (loading) {
        return Semantics(
          liveRegion: true,
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const SizedBox.square(
                dimension: 16,
                child: CircularProgressIndicator(strokeWidth: 2),
              ),
              const SizedBox(width: 8),
              Text(
                l10n.sessionHistoryLoadingEarlier,
                style: theme.textTheme.labelSmall?.copyWith(
                  color: tokens.textSecondary,
                ),
              ),
            ],
          ),
        );
      }
      if (failure) {
        final failureMessage = switch (pagingErrorCode) {
          // "Too large" is reserved for measured resource overflow. A session
          // that was mid-write while its history was indexed is a retry, and
          // says so (H1b).
          'HISTORY_PAGE_RESOURCE_LIMIT' ||
          'HISTORY_PAGE_CLIENT_RESOURCE_LIMIT' =>
            l10n.sessionHistoryResourceLimit,
          'HISTORY_PAGE_SOURCE_UNVERSIONED' =>
            l10n.sessionHistorySourceUnversioned,
          'HISTORY_PAGE_SOURCE_CHANGED' => l10n.sessionHistoryRetryable,
          _ => l10n.sessionHistoryLoadFailed,
        };
        return Semantics(
          liveRegion: true,
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(
                Icons.error_outline,
                size: 16,
                color: tokens.statusError,
              ),
              const SizedBox(width: 8),
              Flexible(
                child: Text(
                  failureMessage,
                  key: const Key('session-history-page-error'),
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: tokens.statusError,
                  ),
                ),
              ),
              if (!terminalFailure) ...[
                const SizedBox(width: 8),
                TextButton(
                  key: const Key('session-history-load-earlier'),
                  onPressed: connected ? onLoadEarlier : null,
                  child: Text(l10n.sessionHistoryRetry),
                ),
              ],
            ],
          ),
        );
      }
      if (hasEarlier) {
        // Keep the healthy/loading row height identical (including at large
        // text scale) without exposing idle copy or an animating hidden
        // progress indicator. The slot is what prevents a loading flash from
        // shifting the variable-height transcript before anchor restoration.
        return ExcludeSemantics(
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const SizedBox.square(dimension: 16),
              const SizedBox(width: 8),
              Text(
                '\u200b',
                style: theme.textTheme.labelSmall?.copyWith(
                  color: tokens.textSecondary,
                ),
              ),
            ],
          ),
        );
      }
      return const SizedBox.shrink();
    }

    return Padding(
      key: const Key('session-history-recovery-notice'),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (gap case final value?) ...[
            // Localized copy ONLY. The broker's `gap.message` is English prose
            // written for an operator; appending it here rendered a Chinese
            // sentence followed by an English one. The code it carries is
            // already in the localized string, and the raw text stays one tap
            // away below. (H1c / S2 boundary.)
            Text(
              // "the broker sent a full replay" is true of a stale CURSOR, and
              // false of a history the broker could not read — which is when it
              // used to be printed above an empty transcript.
              isHistoryUnavailableGapCode(value.code)
                  ? l10n.sessionHistoryUnavailable(value.code)
                  : l10n.sessionHistoryCursorUnavailable(value.code),
              key: const Key('session-history-gap-text'),
              style: theme.textTheme.bodySmall?.copyWith(
                color: tokens.textSecondary,
              ),
              textAlign: TextAlign.center,
            ),
            if (gapMessage != null && gapMessage.isNotEmpty)
              Material(
                type: MaterialType.transparency,
                child: ExpansionTile(
                  key: const Key('session-history-gap-technical-details'),
                  tilePadding: EdgeInsets.zero,
                  dense: true,
                  title: Text(
                    l10n.technicalDetails,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: tokens.textTertiary,
                    ),
                  ),
                  children: [
                    SelectableText(
                      gapMessage,
                      key: const Key('session-history-gap-detail'),
                      style: theme.textTheme.bodySmall?.copyWith(
                        color: tokens.textTertiary,
                      ),
                    ),
                  ],
                ),
              ),
          ],
          statusRow(),
        ],
      ),
    );
  }
}
