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
///
/// A reader who is not following the tail is held in place by the scroll
/// position instead (see [_TranscriptScrollPosition]).
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

/// Creates the transcript's scroll position (see [_TranscriptScrollPosition]).
final class _TranscriptScrollController extends ScrollController {
  _TranscriptScrollController({
    required this.contentEnd,
    required this.readerDrift,
  });

  /// See [_TranscriptScrollPosition.contentEnd].
  final double? Function() contentEnd;

  /// See [_TranscriptScrollPosition.readerDrift].
  final double Function(
    _TranscriptScrollPosition position,
    double minScrollExtent,
  )
  readerDrift;

  @override
  ScrollPosition createScrollPosition(
    ScrollPhysics physics,
    ScrollContext context,
    ScrollPosition? oldPosition,
  ) => _TranscriptScrollPosition(
    physics: physics,
    context: context,
    contentEnd: contentEnd,
    readerDrift: readerDrift,
    initialPixels: initialScrollOffset,
    keepScrollOffset: keepScrollOffset,
    oldPosition: oldPosition,
    debugLabel: debugLabel,
  );
}

/// The prefetch policy transcript surfaces created from now on use; tests
/// shorten or disable parts of it.
@visibleForTesting
TranscriptPrefetchPolicy? debugTranscriptPrefetchPolicy;

/// The prefetch bookkeeping of the transcript surface created last.
@visibleForTesting
TranscriptPrefetchController? debugTranscriptPrefetch;

/// The scroll position of a centered transcript.
///
/// It holds the reader's place through every layout. The transcript is a
/// centered scroll view, so rows inserted or released on either side of the
/// center never move the rows around it; what remains is a row between the
/// reader and the center changing height (a tool result, an expansion, a
/// reflow). After each layout pass, before anything is painted, the position
/// asks how far the reader's row moved ([readerDrift]) and moves the offset by
/// the same distance with `correctBy`, which makes the viewport lay out again
/// in the same frame. A drag keeps following the finger from there, and a
/// running fling is not stopped: `correctBy` makes the next pass report new
/// dimensions, and a ballistic activity then restarts from the corrected
/// offset with its current velocity.
///
/// It counts the corrections the viewport applies itself ([rebased]), so the
/// reader's row can tell a row that grew from content a sliver merely
/// re-based: a sliver that finds its estimate was off corrects the offset by
/// exactly the amount its rows moved, and nothing visible moves.
///
/// It also ends the scroll range at the last row. A centered viewport never
/// reports a maximum below zero, so when the rows from the center down are
/// shorter than the viewport it would let the list rest with the center row
/// at the top, blank space below the last row and the rows above the center
/// hidden. Ending the range at the last row's bottom instead keeps the tail
/// at the bottom of the viewport, or a transcript shorter than the viewport
/// at its top, exactly as a list that starts at its first row would.
final class _TranscriptScrollPosition extends ScrollPositionWithSingleContext {
  _TranscriptScrollPosition({
    required super.physics,
    required super.context,
    required this.contentEnd,
    required this.readerDrift,
    super.initialPixels,
    super.keepScrollOffset,
    super.oldPosition,
    super.debugLabel,
  });

  /// Where the last row's bottom is, in scroll coordinates, when it is laid
  /// out.
  final double? Function() contentEnd;

  /// How far the reader's row moved in the layout just completed, in scroll
  /// coordinates, given the new start of the range; zero when there is no
  /// reader to hold. Called only inside layout.
  final double Function(
    _TranscriptScrollPosition position,
    double minScrollExtent,
  )
  readerDrift;

  /// The sum of every [correctBy] the viewport (or a re-centering) applied.
  double rebased = 0;

  /// The sum of every correction that held the reader's row in place.
  double held = 0;

  /// The offset with every correction that moved nothing on screen taken
  /// out: it changes only when the reader scrolls.
  double get travelled => pixels - rebased - held;

  /// The velocity of a fling under way, in pixels per second (positive
  /// toward the newest rows); zero when nothing is flinging.
  double get flingVelocity {
    final current = activity;
    return current is BallisticScrollActivity ? current.velocity : 0;
  }

  @override
  void correctBy(double correction) {
    rebased += correction;
    super.correctBy(correction);
  }

  @override
  bool applyContentDimensions(double minScrollExtent, double maxScrollExtent) {
    var max = maxScrollExtent;
    final end = contentEnd();
    if (end != null && hasViewportDimension) {
      final last = end - viewportDimension;
      if (last < max) max = last < minScrollExtent ? minScrollExtent : last;
    }
    if (haveDimensions) {
      final drift = readerDrift(this, minScrollExtent);
      if (drift != 0) {
        // Never further out of range than the offset already is.
        final low = pixels < minScrollExtent ? pixels : minScrollExtent;
        final high = pixels > max ? pixels : max;
        final target = (pixels + drift).clamp(low, high);
        if (target != pixels) {
          held += target - pixels;
          super.correctBy(target - pixels);
          return false;
        }
      }
    }
    return super.applyContentDimensions(minScrollExtent, max);
  }
}

/// Records a transcript row's own laid-out extent.
///
/// Row geometry is read while the viewport is still laying out (the reader
/// anchor), where reading another box's `size` is not permitted; this value
/// and the sliver's own layout offset are plain fields that are.
class _RowExtentReporter extends SingleChildRenderObjectWidget {
  const _RowExtentReporter({required super.child});

  @override
  _RenderRowExtentReporter createRenderObject(BuildContext context) =>
      _RenderRowExtentReporter();
}

class _RenderRowExtentReporter extends RenderProxyBox {
  double? laidOutHeight;
  double? laidOutWidth;

  @override
  void performLayout() {
    super.performLayout();
    laidOutHeight = size.height;
    laidOutWidth = size.width;
  }
}

/// A row's place in the transcript's scroll coordinates, where 0 is the top of
/// the center row and rows above it are negative.
typedef _RowGeometry = ({double top, double height, double width});

/// Where the last layout put the row whose [RenderObject] tree starts at
/// [element], or null when it is not laid out in a list right now.
///
/// Reads layout-owned fields only (the reporter's extent and the sliver's
/// child offset), so it is valid during layout as well as after it.
_RowGeometry? _laidOutRowGeometry(Element element) {
  final box = element.renderObject;
  if (box is! _RenderRowExtentReporter || !box.attached) return null;
  final height = box.laidOutHeight;
  final width = box.laidOutWidth;
  if (height == null || width == null) return null;
  RenderObject child = box;
  var parent = box.parent;
  while (parent != null && parent is! RenderSliverMultiBoxAdaptor) {
    child = parent;
    parent = parent.parent;
  }
  if (parent is! RenderSliverMultiBoxAdaptor) return null;
  final data = child.parentData;
  if (data is! SliverMultiBoxAdaptorParentData || data.keptAlive) return null;
  final offset = data.layoutOffset;
  if (offset == null) return null;
  // Rows above the center grow upward from it: their layout offset is the
  // distance from the center to their bottom edge.
  final reverse = parent.constraints.growthDirection == GrowthDirection.reverse;
  return (
    top: reverse ? -(offset + height) : offset,
    height: height,
    width: width,
  );
}

/// The transcript's centered scroll view, built on [_TranscriptViewport].
class _TranscriptScrollView extends CustomScrollView {
  const _TranscriptScrollView({
    super.key,
    super.controller,
    super.physics,
    super.center,
    super.scrollCacheExtent,
    super.semanticChildCount,
    super.slivers,
  });

  @override
  Widget buildViewport(
    BuildContext context,
    ViewportOffset offset,
    AxisDirection axisDirection,
    List<Widget> slivers,
  ) => _TranscriptViewport(
    axisDirection: axisDirection,
    offset: offset,
    slivers: slivers,
    center: center,
    anchor: anchor,
    scrollCacheExtent: scrollCacheExtent,
    paintOrder: paintOrder,
    clipBehavior: clipBehavior,
  );
}

class _TranscriptViewport extends Viewport {
  _TranscriptViewport({
    required super.axisDirection,
    required super.offset,
    required super.slivers,
    required super.center,
    required super.anchor,
    required super.scrollCacheExtent,
    required super.paintOrder,
    required super.clipBehavior,
  });

  @override
  RenderViewport createRenderObject(BuildContext context) =>
      _RenderTranscriptViewport(
        axisDirection: axisDirection,
        crossAxisDirection:
            crossAxisDirection ??
            Viewport.getDefaultCrossAxisDirection(context, axisDirection),
        anchor: anchor,
        offset: offset,
        scrollCacheExtent: scrollCacheExtent,
        paintOrder: paintOrder,
        clipBehavior: clipBehavior,
      );
}

/// Places the rows above the center where they are even when the center line
/// has scrolled above the viewport's top edge.
///
/// [RenderViewport] clamps the layout offset of a sliver before the center to
/// the viewport's extent once the center line is above the top edge, so every
/// row that sliver keeps laid out in its cache reports a transform pinned to
/// the top edge instead of its real place above the center. Nothing is
/// painted or hit-tested there, but selection orders and extends its
/// selectables through those transforms, and semantics reads their rects from
/// them: a page that landed above the reader during a drag selection was
/// ordered below rows it sits above, and left a hole in the copy. Only a
/// sliver with no paint extent is moved, so painting and hit testing are
/// unchanged.
final class _RenderTranscriptViewport extends RenderViewport {
  _RenderTranscriptViewport({
    required super.axisDirection,
    required super.crossAxisDirection,
    required super.offset,
    super.anchor,
    super.scrollCacheExtent,
    super.paintOrder,
    super.clipBehavior,
  });

  @override
  void updateChildLayoutOffset(
    RenderSliver child,
    double layoutOffset,
    GrowthDirection growthDirection,
  ) {
    var placed = layoutOffset;
    final center = this.center;
    if (growthDirection == GrowthDirection.reverse &&
        center != null &&
        !child.geometry!.visible) {
      final extent = axis == Axis.vertical ? size.height : size.width;
      // How far the center line sits from the viewport's leading edge; the
      // same value [RenderViewport] lays out from.
      final centerOffset =
          extent * anchor - (offset.pixels + center.centerOffsetAdjustment);
      if (centerOffset < 0) placed -= centerOffset;
    }
    super.updateChildLayoutOffset(child, placed, growthDirection);
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
  late final _TranscriptScrollController _scrollController =
      _TranscriptScrollController(
        contentEnd: _contentEnd,
        readerDrift: _readerDrift,
      );
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

  /// The layout-phase tail invariant (U5b). Built once so the scroll view sees
  /// a stable physics instance across rebuilds.
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
  final Map<GlobalKey<State<StatefulWidget>>, String> _identityByItemKey = {};
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
  String? _automaticHistoryCursorInFlight;

  /// Which way the page in flight extends the transcript from the reader:
  /// earlier rows above them, or newer rows below. It names the loading row.
  bool _historyLoadUpward = true;

  /// The released range the page in flight fills, from its request through
  /// the frame it lands in; null for a page at the start of the list.
  String? _fillingRangeIdentity;

  /// Decides when the reader's movement asks for the next page (see
  /// [TranscriptPrefetchController]).
  late final TranscriptPrefetchController _prefetch =
      TranscriptPrefetchController(
        policy:
            debugTranscriptPrefetchPolicy ?? const TranscriptPrefetchPolicy(),
      );

  /// Which way the reader last moved.
  TranscriptPrefetchDirection? _movingToward;

  /// The reader's recent drag, wheel and trackpad movement, newest last, as
  /// (event time, signed distance toward the newest rows), for their speed.
  final ListQueue<({Duration time, double delta})> _movementSamples =
      ListQueue();

  /// Ends the reader's movement once it has been still for the policy's
  /// settle delay.
  Timer? _prefetchSettleTimer;

  /// Fires when a failed page may be asked for again.
  Timer? _prefetchRetryTimer;
  bool _prefetchEvaluationScheduled = false;

  /// Advances each time the transport connects again: a page asked for on
  /// an earlier connection answers nothing on this one.
  int _connectionEpoch = 0;

  /// Whether the scroll in progress began with the user's own drag, so the
  /// fling that continues it counts as the user's movement too.
  bool _userDrivenScroll = false;
  final Map<GlobalKey<State<StatefulWidget>>, TranscriptHistoryGapSegment>
  _reloadableGapByItemKey = {};

  /// Row identities of the last build, in order.
  List<String> _rowIdentities = const [];

  /// The row the scroll view is centered on (scroll offset 0 is its top).
  ///
  /// Rows added or released above it grow the list upward and rows below it
  /// grow it downward, so neither moves what the reader sees. It changes only
  /// when a mutation reaches between it and the reader's row, or removes it;
  /// see [_resolveCenter].
  String? _centerIdentity;

  /// Advances with every re-centering, so both lists are rebuilt from the new
  /// center rather than re-indexing rows whose positions no longer hold.
  int _centerGeneration = 0;

  /// The reader anchor: the topmost visible row, where the last completed
  /// layout put it (see [_readerDrift]).
  GlobalKey<State<StatefulWidget>>? _anchorKey;
  double _anchorTop = 0;
  double _anchorHeight = 0;
  double _anchorWidth = 0;

  /// [_TranscriptScrollPosition.rebased] when the anchor was taken.
  double _anchorRebased = 0;

  /// Set when text reflows for a reason the anchor row's width cannot show (a
  /// text scale change), so the next layout keeps the reader's place inside
  /// the row proportionally.
  bool _anchorReflowPending = false;

  /// The anchor row's index when it was taken, and — when the reader was
  /// then resting at the very start of the range — that offset.
  int? _anchorIndex;
  double? _anchorStart;
  double? _lastTextScale;

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
    _prefetch.startGeneration(_prefetchGeneration);
    debugTranscriptPrefetch = _prefetch;
  }

  @override
  void dispose() {
    _scheduleCapturedViewportCommit(_semanticViewportCapture());
    _progressFadeTimer?.cancel();
    _prefetchSettleTimer?.cancel();
    _prefetchRetryTimer?.cancel();
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
    if (!oldWidget.isConnected && widget.isConnected) _connectionEpoch += 1;
    if (oldWidget.isConnected != widget.isConnected ||
        oldWidget.state.sessionId != widget.state.sessionId ||
        oldWidget.state.source != widget.state.source) {
      _automaticHistoryCursorInFlight = null;
    }
    // A new session, source, connection or transcript replacement starts a
    // new generation: whatever was asked for before it answers nothing now.
    _startPrefetchGeneration();
    if (oldWidget.state.historyPageLoading &&
        !widget.state.historyPageLoading) {
      _automaticHistoryCursorInFlight = null;
      _completePrefetchRequest();
    }
    if (oldWidget.state.olderHistoryCursor != widget.state.olderHistoryCursor) {
      final hadRequest = _automaticHistoryCursorInFlight != null;
      _automaticHistoryCursorInFlight = null;
      // A healthy local/production page can round-trip inside one Flutter
      // frame. In that case build never observes `historyPageLoading == true`,
      // so the ordinary loading-to-ready transition never fires. Cursor
      // advancement is equivalent completion evidence, and keeps the fast path
      // from stranding the reader's remaining credit.
      if (hadRequest && !widget.state.historyPageLoading) {
        _completePrefetchRequest();
        _onHistoryPageSettled();
      }
    } else if (_automaticHistoryCursorInFlight != null &&
        !oldWidget.state.historyPageLoading &&
        !widget.state.historyPageLoading) {
      // A page into a gap, of either direction, leaves the oldest cursor
      // alone. Loading neither before nor after the request is the same
      // completion evidence: it settled before any frame showed it loading.
      _automaticHistoryCursorInFlight = null;
      _completePrefetchRequest();
      _onHistoryPageSettled();
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
      final element = entry.value;
      if (index == null || !element.mounted || element is! Element) continue;
      final geometry = _laidOutRowGeometry(element);
      if (geometry == null) continue;
      rows.add(
        TranscriptRowGeometry(
          index: index,
          viewportTop: geometry.top - position.pixels,
          height: geometry.height,
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
    _refreshReaderAnchor();
    // The list is centered, so rows above its center have negative offsets
    // and a range can end below zero while the rows before it still scroll:
    // only the range between the two extents says whether anything does.
    if (position.maxScrollExtent - position.minScrollExtent <= 0) {
      // Nothing scrolls: no reading position to indicate.
      _progressValue.value = null;
      _progressViewportFraction.value = 1;
      _progressActive.value = false;
      return;
    }
    final sample = _computeRawProgress(position);
    final displayed = _progressLatch.update(
      raw: sample.progress,
      // Corrections that held the reader or re-based the list are not the
      // reader moving.
      offset: position is _TranscriptScrollPosition
          ? position.travelled
          : position.pixels,
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
    // A fling is the user's movement as much as the drag that threw it: its
    // travel earns loading intent the way pointer movement does, so reaching a
    // released range or the loaded edge at speed asks for that side's page
    // instead of stopping there. Only a scroll that began with the user's own
    // drag counts; a jump, an animation or a layout correction never does.
    if (notification is ScrollStartNotification) {
      _userDrivenScroll = notification.dragDetails != null;
    } else if (notification is ScrollUpdateNotification &&
        (notification.dragDetails != null || _userDrivenScroll)) {
      // After the list has moved, so the boundary ahead is measured from
      // where the reader now is. A drag's own speed comes from its pointer
      // events; a fling's from the fling.
      final delta = notification.scrollDelta ?? 0;
      if (delta.abs() > 0.01) {
        _recordRealScrollMovement(
          upward: delta < 0,
          physical: notification.dragDetails != null,
        );
      }
    }
    if (notification is ScrollUpdateNotification ||
        notification is ScrollEndNotification) {
      // The flag is safe to set in any notification context, but the geometry
      // reading is not: a ballistic start/stop can be dispatched while an
      // extent correction applies mid-layout, so the reading is deferred to
      // after the frame (coalesced by `_scheduleProgressRefresh`).
      if (notification is ScrollUpdateNotification) _markProgressActive();
      _scheduleProgressRefresh();
      if (notification is ScrollEndNotification) {
        _userDrivenScroll = false;
        _movementSamples.clear();
        _scheduleSemanticViewportCapture();
      }
    }
    return false;
  }

  /// Records the reader's own movement: a drag, the fling it threw, a wheel,
  /// a trackpad or a key; never a layout correction, a jump or a page
  /// landing. [physical] is movement under the reader's hand, as opposed to a
  /// fling carrying on after the finger left. [delta] is the signed distance
  /// toward the newest rows, with [time] its event time, for the reader's
  /// speed; a fling reports its own.
  void _recordRealScrollMovement({
    required bool upward,
    bool physical = true,
    Duration? time,
    double delta = 0,
  }) {
    final direction = upward
        ? TranscriptPrefetchDirection.older
        : TranscriptPrefetchDirection.newer;
    if (_movingToward != direction) _movementSamples.clear();
    _movingToward = direction;
    if (time != null && delta != 0) {
      _movementSamples.addLast((time: time, delta: delta));
      while (_movementSamples.length > 1 &&
          time - _movementSamples.first.time > _velocityWindow) {
        _movementSamples.removeFirst();
      }
    }
    _prefetch.recordMovement(direction: direction, physical: physical);
    _prefetchSettleTimer?.cancel();
    _prefetchSettleTimer = Timer(
      _prefetch.policy.settleDelay,
      _onPrefetchSettleTimer,
    );
    _evaluatePrefetch();
  }

  /// The span the reader's pointer speed is averaged over.
  static const Duration _velocityWindow = Duration(milliseconds: 100);

  void _onPrefetchSettleTimer() {
    if (!mounted) return;
    final position = _positionOrNull();
    if (position is _TranscriptScrollPosition && position.flingVelocity != 0) {
      // Still carried by a fling: it settles when the fling ends.
      _prefetchSettleTimer = Timer(
        _prefetch.policy.settleDelay,
        _onPrefetchSettleTimer,
      );
      return;
    }
    _prefetch.settle();
    _movementSamples.clear();
  }

  /// The reader's speed toward the newest rows, in pixels per second: the
  /// fling's while one carries the list, otherwise their pointer, wheel or
  /// trackpad movement over the last [_velocityWindow].
  double _readerVelocity(ScrollPosition position) {
    if (position is _TranscriptScrollPosition && position.flingVelocity != 0) {
      return position.flingVelocity;
    }
    if (_movementSamples.isEmpty) return 0;
    final newest = _movementSamples.last.time;
    var distance = 0.0;
    for (final sample in _movementSamples) {
      if (newest - sample.time <= _velocityWindow) distance += sample.delta;
    }
    return distance *
        Duration.microsecondsPerSecond /
        _velocityWindow.inMicroseconds;
  }

  /// The time the prefetch bookkeeping runs on: the current frame's.
  Duration _prefetchNow() =>
      WidgetsBinding.instance.currentSystemFrameTimeStamp;

  /// What the prefetch bookkeeping belongs to: this session, source,
  /// connection and transcript replacement.
  Object get _prefetchGeneration => (
    widget.state.source,
    widget.state.sessionId,
    widget.state.transcriptResetGeneration,
    _connectionEpoch,
  );

  void _startPrefetchGeneration() {
    final generation = _prefetchGeneration;
    if (_prefetch.generation == generation) return;
    _prefetch.startGeneration(generation);
    _movingToward = null;
    _movementSamples.clear();
    _prefetchSettleTimer?.cancel();
    _prefetchRetryTimer?.cancel();
  }

  /// Asks for the page beyond the boundary the reader is heading for when
  /// the prefetch policy says it is time (see [TranscriptPrefetchController]).
  void _evaluatePrefetch() {
    final direction = _movingToward;
    if (direction == null || !mounted) return;
    final state = widget.state;
    if (!widget.isConnected ||
        state.historyPageLoading ||
        _automaticHistoryCursorInFlight != null) {
      return;
    }
    final position = _positionOrNull();
    if (position == null ||
        !position.hasContentDimensions ||
        position.viewportDimension <= 0) {
      return;
    }
    final target = _nearestPrefetchTarget(direction, position);
    if (target == null) return;
    final decision = _prefetch.decide(
      direction: direction,
      key: target.key,
      distance: target.distance,
      velocity: _readerVelocity(position),
      viewport: position.viewportDimension,
      now: _prefetchNow(),
    );
    if (decision == TranscriptPrefetchDecision.request) target.request();
    _armPrefetchRetry();
  }

  /// Evaluates after this frame lays out, when a page landed or the list
  /// changed under a reader who may still be moving.
  void _schedulePrefetchEvaluation() {
    if (_prefetchEvaluationScheduled) return;
    _prefetchEvaluationScheduled = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _prefetchEvaluationScheduled = false;
      if (mounted) _evaluatePrefetch();
    });
    WidgetsBinding.instance.scheduleFrame();
  }

  /// Wakes the evaluation when a failed boundary's backoff passes.
  ///
  /// Only a backoff still running is waited for. Once one has passed, its
  /// boundary is asked for by the next evaluation that finds the reader
  /// there, and everything that could bring them there (their movement, a
  /// page landing, the layout changing) evaluates by itself; waking for it
  /// meanwhile would schedule a frame whose evaluation wakes for it again,
  /// for as long as the reader stays away.
  void _armPrefetchRetry() {
    _prefetchRetryTimer?.cancel();
    _prefetchRetryTimer = null;
    final now = _prefetchNow();
    final at = _prefetch.nextRetryAfter(now);
    if (at == null) return;
    _prefetchRetryTimer = Timer(at - now, () {
      _prefetchRetryTimer = null;
      if (mounted) _schedulePrefetchEvaluation();
    });
  }

  /// The boundary nearest the reader in [direction] that can load: the start
  /// of what is loaded, or a released range, with its distance beyond the
  /// viewport edge (zero on screen) and how to ask for it.
  ({String key, double distance, VoidCallback request})? _nearestPrefetchTarget(
    TranscriptPrefetchDirection direction,
    ScrollPosition position,
  ) {
    final upward = direction == TranscriptPrefetchDirection.older;
    final viewport = position.viewportDimension;
    ({String key, double distance, VoidCallback request})? nearest;
    void consider(String key, double distance, VoidCallback request) {
      final value = distance < 0 ? 0.0 : distance;
      if (nearest == null || value < nearest!.distance) {
        nearest = (key: key, distance: value, request: request);
      }
    }

    final state = widget.state;
    final cursor = state.olderHistoryCursor;
    if (upward &&
        !state.historyStartReached &&
        cursor != null &&
        cursor.isNotEmpty &&
        !state.historyPagingBlockedAt(cursor)) {
      // The list is centered, so its start is the minimum extent, not zero.
      final key = 'older:$cursor';
      consider(
        key,
        position.pixels - position.minScrollExtent,
        () => _requestHistoryCursor(
          cursor,
          leadingEdge: true,
          prefetchKey: key,
        ),
      );
    }
    final estimate = _mountedRowSpan();
    for (final entry in _reloadableGapByItemKey.entries) {
      final gap = entry.value;
      // A gap the broker refused a position of loads no more on this attach.
      if (state.historyGapRefused(gap)) continue;
      double? top;
      double? bottom;
      final geometry = _rowGeometry(entry.key);
      if (geometry != null) {
        top = geometry.top - position.pixels;
        bottom = top + geometry.height;
      } else if (estimate != null) {
        // Not laid out: place it by its index among the rows that are.
        final index = _itemIndexByKey[entry.key];
        if (index == null) continue;
        if (index < estimate.firstIndex) {
          bottom =
              estimate.top -
              (estimate.firstIndex - index - 1) * estimate.rowHeight -
              position.pixels;
          top = bottom - estimate.rowHeight;
        } else if (index > estimate.lastIndex) {
          top =
              estimate.bottom +
              (index - estimate.lastIndex - 1) * estimate.rowHeight -
              position.pixels;
          bottom = top + estimate.rowHeight;
        }
      }
      if (top == null || bottom == null) continue;
      final onScreen = bottom >= 0 && top <= viewport;
      final key = 'gap:${gap.id}';
      void request() => _requestGapFill(gap, upward: upward, prefetchKey: key);
      if (onScreen) {
        consider(key, 0, request);
      } else if (upward && bottom < 0) {
        consider(key, -bottom, request);
      } else if (!upward && top > viewport) {
        consider(key, top - viewport, request);
      }
    }
    return nearest;
  }

  /// The laid-out rows' first and last index, their extent, and their mean
  /// height, for placing rows that are not laid out.
  ({
    int firstIndex,
    int lastIndex,
    double top,
    double bottom,
    double rowHeight,
  })?
  _mountedRowSpan() {
    int? firstIndex;
    int? lastIndex;
    double? top;
    double? bottom;
    for (final entry in _mountedRowContexts.entries) {
      final index = _itemIndexByKey[entry.key];
      final element = entry.value;
      if (index == null || !element.mounted || element is! Element) continue;
      final geometry = _laidOutRowGeometry(element);
      if (geometry == null) continue;
      if (firstIndex == null || index < firstIndex) {
        firstIndex = index;
        top = geometry.top;
      }
      if (lastIndex == null || index > lastIndex) {
        lastIndex = index;
        bottom = geometry.top + geometry.height;
      }
    }
    if (firstIndex == null || lastIndex == null || top == null) return null;
    final rows = lastIndex - firstIndex + 1;
    return (
      firstIndex: firstIndex,
      lastIndex: lastIndex,
      top: top,
      bottom: bottom!,
      rowHeight: (bottom - top) / rows,
    );
  }

  /// Settles the prefetch bookkeeping for the page that just finished,
  /// successful or not.
  void _completePrefetchRequest() {
    if (_prefetch.inFlightKey == null) return;
    final now = _prefetchNow();
    if (widget.state.historyPageError == null) {
      _prefetch.finish(now, applied: true);
    } else {
      _prefetch.fail(
        now,
        transient: isTransientHistoryPageErrorCode(
          widget.state.historyPageErrorCode,
        ),
      );
    }
    _armPrefetchRetry();
  }

  /// Settles a request the controller declined to send. Its refusal is in
  /// the state the next build brings, or nowhere: either way, not retried
  /// until the reader asks explicitly or a new generation starts.
  void _declinePrefetchRequest(String key) {
    if (_prefetch.inFlightKey != key) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _prefetch.inFlightKey != key) return;
      final code = widget.state.historyPageErrorCode;
      _prefetch.fail(
        _prefetchNow(),
        transient:
            widget.state.historyPageError != null &&
            isTransientHistoryPageErrorCode(code),
      );
      _armPrefetchRetry();
    });
    WidgetsBinding.instance.scheduleFrame();
  }

  /// Loads into [gap].
  ///
  /// Moving down, the gap fills from its older edge with a newer page where
  /// the broker pages forward (contract revision 28), so the rows arrive where
  /// the reader is heading. Moving up, it fills from its newer edge — unless
  /// it is an open range (see
  /// [TranscriptHistoryNavigation.reloadsOnlyForward]), which only a newer
  /// page can fill without running past where it began. Without forward
  /// paging, both directions page back from the newer edge.
  void _requestGapFill(
    TranscriptHistoryGapSegment gap, {
    required bool upward,
    required String prefetchKey,
  }) {
    final reload = gap.reloadCursor!;
    final forward = gap.forwardCursor;
    final forwardWanted =
        !upward ||
        widget.state.activeTranscriptWindow.reloadsOnlyForward(reload);
    if (forward != null &&
        forwardWanted &&
        widget.controller.canLoadNewerHistory) {
      _requestNewerHistoryCursor(
        forward,
        until: reload,
        upward: upward,
        range: gap.id,
        prefetchKey: prefetchKey,
      );
      return;
    }
    _requestHistoryCursor(
      reload,
      leadingEdge: false,
      upward: upward,
      range: gap.id,
      prefetchKey: prefetchKey,
    );
  }

  void _requestNewerHistoryCursor(
    String cursor, {
    required String until,
    required bool upward,
    required String range,
    required String prefetchKey,
  }) {
    if (!widget.isConnected ||
        widget.state.historyPageLoading ||
        cursor.isEmpty ||
        _automaticHistoryCursorInFlight == cursor) {
      return;
    }
    _beginPrefetchRequest(prefetchKey, upward: upward);
    _automaticHistoryCursorInFlight = cursor;
    _historyLoadUpward = upward;
    _fillingRangeIdentity = range;
    _protectVisibleHistoryRow();
    unawaited(
      widget.controller.loadNewerHistory(cursor: cursor, until: until).then((
        sent,
      ) {
        // A request the controller declined never loads, so nothing would
        // release the slot.
        if (sent || !mounted || _automaticHistoryCursorInFlight != cursor) {
          return;
        }
        _automaticHistoryCursorInFlight = null;
        _declinePrefetchRequest(prefetchKey);
        _onHistoryPageSettled();
      }),
    );
  }

  void _beginPrefetchRequest(String key, {required bool upward}) {
    _prefetch
      ..begin(
        key: key,
        direction: upward
            ? TranscriptPrefetchDirection.older
            : TranscriptPrefetchDirection.newer,
      )
      ..markSent(_prefetchNow());
  }

  /// Tracks whether the user has scrolled away from the end.
  ///
  /// Reading history turns following off; scrolling back to the end turns it
  /// on again, so the user can opt back in without a dedicated control.
  void _onScroll() {
    final position = _positionOrNull();
    if (position == null) return;
    if (position is _TranscriptScrollPosition) {
      _prefetch.observeOffset(position.travelled);
    }
    final atBottom =
        position.pixels >= position.maxScrollExtent - _bottomThreshold;
    if (atBottom != _followTail) {
      _followTail = atBottom;
      _showJumpLatest.value = !atBottom;
      _scheduleSemanticViewportCapture();
    }
  }

  void _requestEarlierExplicitly() {
    final state = widget.state;
    final cursor = state.olderHistoryCursor;
    final terminalFailure = state.historyPagingBlockedAt(cursor);
    if (!widget.isConnected ||
        state.historyStartReached ||
        state.historyPageLoading ||
        terminalFailure ||
        cursor == null ||
        cursor.isEmpty) {
      return;
    }
    // Asking explicitly is its own retry: whatever the automatic backoff
    // holds for this boundary no longer applies.
    final key = 'older:$cursor';
    _prefetch.forgetFailure(key);
    _requestHistoryCursor(cursor, leadingEdge: true, prefetchKey: key);
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

    if (key == LogicalKeyboardKey.end) {
      // A jump to the latest rows reads no released range on the way.
      _prefetchSettleTimer?.cancel();
      _prefetch.settle();
    } else {
      // Before the jump, from what the reader was looking at when they
      // pressed it: a released range on screen is filled even when the jump
      // carries them past it.
      _recordRealScrollMovement(upward: upward);
    }
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
    // And again from where the jump put them.
    if (key != LogicalKeyboardKey.end) _schedulePrefetchEvaluation();
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
    required String prefetchKey,
    bool upward = true,
    String? range,
  }) {
    final state = widget.state;
    if (!widget.isConnected ||
        (leadingEdge && state.historyStartReached) ||
        state.historyPageLoading ||
        cursor.isEmpty ||
        // Every automatic or explicit request passes here; a position the
        // broker refused loads no more on this attach.
        state.historyPagingBlockedAt(cursor) ||
        _automaticHistoryCursorInFlight == cursor) {
      return;
    }
    _beginPrefetchRequest(prefetchKey, upward: upward);
    _automaticHistoryCursorInFlight = cursor;
    _historyLoadUpward = upward;
    _fillingRangeIdentity = range;
    _protectVisibleHistoryRow();
    unawaited(
      widget.controller.loadEarlierHistory(cursor: cursor).then((sent) {
        // A request the controller declined never loads, so nothing would
        // release the slot.
        if (sent || !mounted || _automaticHistoryCursorInFlight != cursor) {
          return;
        }
        _automaticHistoryCursorInFlight = null;
        _declinePrefetchRequest(prefetchKey);
        _onHistoryPageSettled();
      }),
    );
  }

  /// Whether [gap]'s row sits in the lower half of the viewport or below it,
  /// so the rows it holds are newer than what the reader is reading.
  bool _gapBelowReader(TranscriptHistoryGapSegment gap) {
    final position = _positionOrNull();
    final key = _itemKeysByIdentity[gap.id];
    if (position == null || !position.hasContentDimensions || key == null) {
      return false;
    }
    final row = _rowGeometry(key);
    if (row == null) return false;
    return row.top - position.pixels > position.viewportDimension / 2;
  }

  /// The bottom of the last row, when the viewport has laid it out.
  double? _contentEnd() {
    if (_orderedItemKeys.isEmpty) return null;
    final row = _rowGeometry(_orderedItemKeys.last);
    return row == null ? null : row.top + row.height;
  }

  /// Where the last layout put the row for [key] (see [_laidOutRowGeometry]).
  _RowGeometry? _rowGeometry(GlobalKey<State<StatefulWidget>> key) {
    final element = key.currentContext;
    if (element is! Element) return null;
    return _laidOutRowGeometry(element);
  }

  /// The row the reader is reading, optionally only among [survivors]: a
  /// message row over a footer, notice or gap, and the first one that starts
  /// in the upper half of the viewport over one that only reaches into it
  /// from above; failing both, the topmost row on screen.
  ///
  /// While a page fills a released range on screen, the rows on the reader's
  /// side of that range come first: below it for a page that brings the rows
  /// above them (they are moving up into it), above it for one that brings
  /// the rows below. The page then lands on the far side of the reader's row
  /// instead of pushing it away.
  ({GlobalKey<State<StatefulWidget>> key, String identity, _RowGeometry row})?
  _readerRow(ScrollPosition position, {Set<String>? survivors}) {
    if (!position.hasPixels || position.viewportDimension <= 0) return null;
    final viewportTop = position.pixels;
    final viewportBottom = viewportTop + position.viewportDimension;
    final rangeKey = _fillingRangeIdentity == null
        ? null
        : _itemKeysByIdentity[_fillingRangeIdentity];
    final range = rangeKey == null ? null : _rowGeometry(rangeKey);
    final onScreenRange =
        range != null &&
            range.top + range.height > viewportTop &&
            range.top < viewportBottom
        ? range
        : null;
    ({GlobalKey<State<StatefulWidget>> key, String identity, _RowGeometry row})?
    best;
    var bestIsMessage = false;
    var bestOnReaderSide = false;
    var bestStartsOnScreen = false;
    final upperHalf = viewportTop + position.viewportDimension / 2;
    for (final entry in _mountedRowContexts.entries) {
      final element = entry.value;
      if (element is! Element) continue;
      final identity = _identityByItemKey[entry.key];
      if (identity == null) continue;
      if (survivors != null && !survivors.contains(identity)) continue;
      final row = _laidOutRowGeometry(element);
      if (row == null || row.height <= 0) continue;
      if (row.top + row.height <= viewportTop || row.top >= viewportBottom) {
        continue;
      }
      final isMessage = _messageItemKeys.contains(entry.key);
      final onReaderSide =
          onScreenRange != null &&
          (_historyLoadUpward
              ? row.top >= onScreenRange.top + onScreenRange.height - 0.5
              : row.top + row.height <= onScreenRange.top + 0.5);
      final startsOnScreen =
          row.top >= viewportTop - 0.5 && row.top < upperHalf;
      final better =
          best == null ||
          (onReaderSide && !bestOnReaderSide) ||
          (onReaderSide == bestOnReaderSide &&
              ((isMessage && !bestIsMessage) ||
                  (isMessage == bestIsMessage &&
                      ((startsOnScreen && !bestStartsOnScreen) ||
                          (startsOnScreen == bestStartsOnScreen &&
                              row.top < best.row.top)))));
      if (better) {
        best = (key: entry.key, identity: identity, row: row);
        bestIsMessage = isMessage;
        bestOnReaderSide = onReaderSide;
        bestStartsOnScreen = startsOnScreen;
      }
    }
    return best;
  }

  /// Re-takes the reader anchor from the completed layout, and — for a
  /// transcript whose reading place is recorded at all — tells the window
  /// which row the reader is on, so a page released to fit the budget while a
  /// fling is still moving is not the one they have reached.
  void _refreshReaderAnchor() {
    final position = _transcriptPosition();
    if (position == null || !position.hasContentDimensions) return;
    final reader = _readerRow(position);
    if (reader == null) return;
    _anchorKey = reader.key;
    _anchorTop = reader.row.top;
    _anchorHeight = reader.row.height;
    _anchorWidth = reader.row.width;
    _anchorRebased = position.rebased;
    _anchorIndex = _itemIndexByKey[reader.key];
    _anchorStart = position.pixels <= position.minScrollExtent + 0.5
        ? position.pixels
        : null;
    if (_viewportKey != null &&
        _viewportMembershipGeneration != null &&
        !_followTail &&
        !_semanticViewportRestorePending) {
      final stableKey = _messageStableKeyByItemKey[reader.key];
      if (stableKey != null) {
        widget.controller.protectHistoryViewportAnchor(stableKey);
      }
    }
  }

  /// How far the reader's row moved in the layout just completed (see
  /// [_TranscriptScrollPosition]).
  ///
  /// Called from inside the viewport's layout, after every row this frame
  /// needs has been laid out. The anchor is where the last completed layout
  /// put the reader's row, so the reader's own movement since — a drag, a
  /// fling, a key press, however long a page took to arrive — is already in
  /// the position and is kept; only the row's displacement by the content
  /// around it is undone.
  double _readerDrift(
    _TranscriptScrollPosition position,
    double minScrollExtent,
  ) {
    if (_followTail || _tailRevealPending || _semanticViewportRestorePending) {
      return 0;
    }
    final key = _anchorKey;
    if (key == null) return 0;
    final row = _rowGeometry(key);
    if (row == null) return 0;
    // A sliver that re-bases its rows corrects the offset by the same amount;
    // for rows in that sliver, that moved nothing the reader can see.
    final rebasedSince = position.rebased - _anchorRebased;
    final expectedTop = _anchorTop + rebasedSince;
    final pixels = position.pixels;
    var drift = row.top - expectedTop;
    final reflowed =
        _anchorReflowPending || (row.width - _anchorWidth).abs() > 0.5;
    final into = pixels - expectedTop;
    if (reflowed && _anchorHeight > 0 && into > 0 && into < _anchorHeight) {
      // The row's own text re-wrapped: keep the same share of it above the
      // reader, so the line they were on stays near the top.
      drift = row.top + into / _anchorHeight * row.height - pixels;
    }
    final start = _anchorStart;
    if (start != null &&
        _itemIndexByKey[key] == _anchorIndex &&
        (pixels - rebasedSince - start).abs() <= 0.5) {
      // A reader resting at the very start sees the rows above their row
      // too: the history notice, the start marker. With nothing inserted
      // above, one of those changing size keeps its top edge, as the start of
      // a list does, and moves what is below it.
      drift = minScrollExtent - pixels;
      _anchorStart = minScrollExtent;
    } else {
      _anchorStart = null;
    }
    _anchorTop = row.top;
    _anchorHeight = row.height;
    _anchorWidth = row.width;
    _anchorRebased = position.rebased;
    _anchorReflowPending = false;
    return drift;
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

  _TranscriptScrollPosition? _transcriptPosition() {
    final position = _positionOrNull();
    return position is _TranscriptScrollPosition ? position : null;
  }

  /// Queues one post-frame settle check for the hidden opening reveal (U5).
  ///
  /// The loop self-chains, so it also covers lazy extent corrections that
  /// arrive without a rebuild — the case a build-driven jump cannot see.
  /// `addPostFrameCallback` alone does NOT schedule a frame: when a settle
  /// step neither jumps nor reveals (the estimated extent already equals the
  /// offset while the real last row is still unmounted), nothing else may be
  /// left to produce the next frame, and the gate would stay hidden forever.
  /// So every queue also requests the frame explicitly.
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
    final last = _rowGeometry(_orderedItemKeys.last);
    if (last == null) return false;
    final rowBottom = last.top + last.height;
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

  /// A page request of either direction finished (or was declined): record
  /// the reader's place, and see whether a reader still moving needs the
  /// next page.
  void _onHistoryPageSettled() {
    _forgetFillingRangeAfterFrame();
    final record = _viewportRecord();
    widget.controller.protectHistoryViewportAnchor(
      (record?.followTail ?? true) ? null : record?.anchorMessageKey,
    );
    _scheduleSemanticViewportCapture();
    _schedulePrefetchEvaluation();
  }

  /// Keeps [_fillingRangeIdentity] through the frame being built — the one
  /// the page lands in, whose re-centering still needs to know which side of
  /// the range the reader is on — and forgets it after.
  void _forgetFillingRangeAfterFrame() {
    final range = _fillingRangeIdentity;
    if (range == null) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_fillingRangeIdentity == range && !widget.state.historyPageLoading) {
        _fillingRangeIdentity = null;
      }
    });
  }

  int? _findChildIndex(Key? key) {
    if (key == null) return null;
    if (key is! GlobalKey<State<StatefulWidget>>) return null;
    return _itemIndexByKey[key];
  }

  /// Chooses the row the scroll view is centered on for this build, from last
  /// frame's rows and geometry.
  ///
  /// The center is kept while every row from it to the reader's row is the
  /// same, in the same order, as last frame: whatever was added or released
  /// then lies beyond one of the two, and the list grows or shrinks away from
  /// the reader. Otherwise — a page landed or was released between them, or
  /// the center row itself left — the list is re-centered on the reader's row
  /// and the offset corrected by exactly that row's distance from the old
  /// center, before this frame's layout, so nothing on screen moves.
  int _resolveCenter(List<String> identities, {required int preferredIndex}) {
    final previous = _rowIdentities;
    _rowIdentities = identities;
    if (identities.isEmpty) {
      _centerIdentity = null;
      return 0;
    }
    final oldCenter = _centerIdentity;
    final centerIndex = oldCenter == null ? -1 : identities.indexOf(oldCenter);
    final position = _transcriptPosition();
    final reader = position == null || !position.hasContentDimensions
        ? null
        : _readerRow(position, survivors: identities.toSet());
    if (position == null || reader == null) {
      if (centerIndex >= 0) return centerIndex;
      // Nothing laid out survives to hold the place: start over.
      final start = preferredIndex.clamp(0, identities.length - 1);
      _centerIdentity = identities[start];
      _centerGeneration += 1;
      _anchorKey = null;
      return start;
    }
    if (centerIndex >= 0 &&
        _runUnchanged(previous, identities, oldCenter!, reader.identity)) {
      return centerIndex;
    }
    _centerIdentity = reader.identity;
    _centerGeneration += 1;
    // The reader's row becomes scroll offset 0: move the offset by the same
    // distance so its place on screen is unchanged. This runs before this
    // frame's layout, which is the one that first lays out the new center.
    position.correctBy(-reader.row.top);
    _anchorKey = reader.key;
    _anchorTop = 0;
    _anchorHeight = reader.row.height;
    _anchorWidth = reader.row.width;
    _anchorRebased = position.rebased;
    _anchorStart = null;
    return identities.indexOf(reader.identity);
  }

  /// Whether the rows from [from] to [to] (inclusive) are the same rows, in
  /// the same order, in [previous] and [next].
  static bool _runUnchanged(
    List<String> previous,
    List<String> next,
    String from,
    String to,
  ) {
    final oldFrom = previous.indexOf(from);
    final oldTo = previous.indexOf(to);
    final newFrom = next.indexOf(from);
    final newTo = next.indexOf(to);
    if (oldFrom < 0 || oldTo < 0 || newFrom < 0 || newTo < 0) return false;
    if (oldTo - oldFrom != newTo - newFrom) return false;
    final shift = newFrom - oldFrom;
    final low = oldFrom < oldTo ? oldFrom : oldTo;
    final high = oldFrom < oldTo ? oldTo : oldFrom;
    for (var index = low; index <= high; index++) {
      if (previous[index] != next[index + shift]) return false;
    }
    return true;
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
    _identityByItemKey.clear();
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
      _identityByItemKey[key] = identity;
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

  /// Tells the window which row the reader is on as a page is requested, so
  /// the budget the page is fitted into keeps it. The position itself needs no
  /// capture here: the reader anchor is re-taken from every layout, so the
  /// page lands against where the reader is when it arrives.
  void _protectVisibleHistoryRow() {
    final visible = _firstUsefulVisibleMessage();
    if (visible == null) return;
    widget.controller.protectHistoryViewportAnchor(visible.stableMessageKey);
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
      final row = _rowGeometry(key);
      if (row == null) continue;
      final viewportTop = row.top - position.pixels;
      final viewportBottom = viewportTop + row.height;
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

    if (targetKey.currentContext == null) {
      _seekSemanticViewportTarget(position, targetKey);
      _retrySemanticViewportRestore();
      return;
    }
    final target = _rowGeometry(targetKey);
    if (target == null) {
      _retrySemanticViewportRestore();
      return;
    }
    final targetOffset = (target.top - record!.anchorViewportTop!).clamp(
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
      final element = entry.value;
      if (index == null || element is! Element) continue;
      final row = _laidOutRowGeometry(element);
      if (row == null) continue;
      mounted.add((index: index, offset: row.top, height: row.height));
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

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // A text scale change re-wraps every row without changing the reader's
    // row width, which is how the anchor otherwise recognizes a reflow.
    final textScale = MediaQuery.textScalerOf(context).scale(16);
    if (_lastTextScale != null && _lastTextScale != textScale) {
      _anchorReflowPending = true;
    }
    _lastTextScale = textScale;
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
          // A page that finished while the reader is still moving may call
          // for the next. The page itself needs no settling: the centered
          // list and the layout-time anchor placed it already.
          if (_historyPageWasLoading && !historyLoading) {
            _forgetFillingRangeAfterFrame();
            if (!_followTail) _schedulePrefetchEvaluation();
          }
          _historyPageWasLoading = historyLoading;
          // Which way the page in flight extends the list, and which range it
          // fills. A request this surface did not make (a retry the controller
          // issued itself) is not tied to any one range.
          final loadingUpward = _historyLoadUpward;
          final cursorInFlight = _automaticHistoryCursorInFlight;

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
                    withdrawnRequestIds: widget.state.withdrawnRequestIds,
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
                loading:
                    widget.state.historyPageLoading &&
                    !widget.state.historyGapRefused(gap) &&
                    (cursorInFlight == null ||
                        cursorInFlight == gap.reloadCursor ||
                        cursorInFlight == gap.forwardCursor),
                loadingNewer: !loadingUpward,
                failed:
                    widget.state.historyPageError != null ||
                    widget.state.historyGapRefused(gap),
                terminalFailure:
                    isTerminalHistoryPageErrorCode(
                      widget.state.historyPageErrorCode,
                    ) ||
                    widget.state.historyGapRefused(gap),
                onRetry: gap.reloadCursor == null
                    ? null
                    : () {
                        // Asking explicitly is its own retry: whatever the
                        // automatic backoff holds for this range no longer
                        // applies.
                        final key = 'gap:${gap.id}';
                        _prefetch.forgetFailure(key);
                        _requestHistoryCursor(
                          gap.reloadCursor!,
                          leadingEdge: false,
                          upward: !_gapBelowReader(gap),
                          range: gap.id,
                          prefetchKey: key,
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
          // Decided against last frame's rows and geometry, so this runs
          // before the registry below is replaced.
          final centerIndex = _resolveCenter(
            itemIdentities,
            preferredIndex: messageCount > 0 ? messageOffset : 0,
          );
          final centerGeneration = _centerGeneration;
          _syncItemRegistry(
            identities: itemIdentities,
            messageIndices: messageIndices,
            canonicalMessageKeys: canonicalMessageKeys,
          );
          _reloadableGapByItemKey.clear();
          for (var index = 0; index < chatItems.length; index++) {
            final item = chatItems[index];
            if (item case _ChatHistoryGapItem(
              gap: final gap &&
                  TranscriptHistoryGapSegment(
                    kind: TranscriptHistoryGapKind.reloadable,
                    reloadCursor: _?,
                  ),
            )) {
              _reloadableGapByItemKey[_orderedItemKeys[messageOffset + index]] =
                  gap;
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
                    // The top of the list shows only a page that extends it
                    // upward; a range filling below the reader says so there.
                    loading: historyLoading && loadingUpward,
                    pagingError:
                        widget.state.historyPageError ??
                        (widget.state.olderHistoryRefusal == null
                            ? null
                            : const LocalizedFailure.notice(
                                FailureLead.historyPageDiverged,
                              )),
                    pagingErrorCode:
                        widget.state.historyPageErrorCode ??
                        widget.state.olderHistoryRefusal,
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
                // A failed boundary whose backoff passed while the reader was
                // away is asked for again once a change like this one (a
                // jump, a row changing height) brings it back into reach.
                if (_prefetch.retryDue(_prefetchNow())) {
                  _schedulePrefetchEvaluation();
                }
              }
              return false;
            },
            child: NotificationListener<ScrollNotification>(
              onNotification: _onScrollNotification,
              child: Listener(
                behavior: HitTestBehavior.translucent,
                // A drag moves the content with the finger, so the reader
                // heads the other way; a wheel scrolls the way it turns.
                onPointerMove: (event) {
                  if (event.delta.dy.abs() > 0.01) {
                    _recordRealScrollMovement(
                      upward: event.delta.dy > 0,
                      time: event.timeStamp,
                      delta: -event.delta.dy,
                    );
                  }
                },
                onPointerCancel: (_) {
                  _prefetchSettleTimer?.cancel();
                  _prefetch.settle();
                },
                onPointerSignal: (event) {
                  if (event is PointerScrollEvent &&
                      event.scrollDelta.dy.abs() > 0.01) {
                    _recordRealScrollMovement(
                      upward: event.scrollDelta.dy < 0,
                      time: event.timeStamp,
                      delta: event.scrollDelta.dy,
                    );
                    // The wheel moves the list after this event; the
                    // boundary ahead is measured again from there.
                    _schedulePrefetchEvaluation();
                  }
                },
                onPointerPanZoomUpdate: (event) {
                  if (event.panDelta.dy.abs() > 0.01) {
                    _recordRealScrollMovement(
                      upward: event.panDelta.dy > 0,
                      time: event.timeStamp,
                      delta: -event.panDelta.dy,
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
                              child: _TranscriptScrollView(
                                key: const Key('session-detail-chat-scroll'),
                                controller: _scrollController,
                                // Scroll offset 0 is the center row's top:
                                // rows before it are laid out upward from
                                // there, rows after it downward, so adding or
                                // releasing rows at either end never shifts
                                // the ones around the reader.
                                center: ValueKey<String>(
                                  'transcript-rows-from-$centerGeneration',
                                ),
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
                                semanticChildCount: totalItems,
                                slivers: [
                                  SliverList(
                                    key: ValueKey<String>(
                                      'transcript-rows-before-'
                                      '$centerGeneration',
                                    ),
                                    delegate: SliverChildBuilderDelegate(
                                      (context, index) => buildScrollItem(
                                        centerIndex - 1 - index,
                                      ),
                                      childCount: centerIndex,
                                      findChildIndexCallback: (key) {
                                        final index = _findChildIndex(key);
                                        if (index == null ||
                                            index >= centerIndex) {
                                          return null;
                                        }
                                        return centerIndex - 1 - index;
                                      },
                                      semanticIndexCallback: (_, index) =>
                                          centerIndex - 1 - index,
                                    ),
                                  ),
                                  SliverList(
                                    key: ValueKey<String>(
                                      'transcript-rows-from-$centerGeneration',
                                    ),
                                    delegate: SliverChildBuilderDelegate(
                                      (context, index) =>
                                          buildScrollItem(centerIndex + index),
                                      childCount: totalItems - centerIndex,
                                      findChildIndexCallback: (key) {
                                        final index = _findChildIndex(key);
                                        if (index == null ||
                                            index < centerIndex) {
                                          return null;
                                        }
                                        return index - centerIndex;
                                      },
                                      semanticIndexCallback: (_, index) =>
                                          centerIndex + index,
                                    ),
                                  ),
                                ],
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
  Widget build(BuildContext context) => _RowExtentReporter(child: widget.child);
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
    required this.loadingNewer,
    required this.failed,
    required this.terminalFailure,
    required this.onRetry,
  });

  final TranscriptHistoryGapSegment gap;
  final bool connected;
  final bool loading;

  /// Whether the page filling this range brings the rows below the reader
  /// (newer than what they are reading) rather than the rows above.
  final bool loadingNewer;
  final bool failed;
  final bool terminalFailure;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final tokens = context.tokens;
    final reloadable = gap.kind == TranscriptHistoryGapKind.reloadable;
    final label = switch (gap.kind) {
      TranscriptHistoryGapKind.reloadable => l10n.sessionHistoryDecodedGap,
      TranscriptHistoryGapKind.reconnectRequired =>
        l10n.sessionHistoryDecodedGapReconnect,
      TranscriptHistoryGapKind.unsavedReleased =>
        l10n.sessionHistoryUnsavedReleased,
    };
    return Semantics(
      container: true,
      label: label,
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
                      ? label
                      : failed
                      ? l10n.sessionHistoryLoadFailed
                      : loading
                      ? (loadingNewer
                            ? l10n.sessionHistoryLoadingNewer
                            : l10n.sessionHistoryLoadingEarlier)
                      : label,
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
  final LocalizedFailure? pagingError;
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
