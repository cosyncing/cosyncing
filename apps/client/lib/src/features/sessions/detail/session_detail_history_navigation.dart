part of 'session_detail_state.dart';

// Forward paging and reconnect recovery for the bounded transcript window.
//
// A newer page (contract revision 28) fills a gap from its older edge and
// stops at the boundary the newer run starts at, so the two runs meet by the
// broker's own cursor. A reconnect whose frame was capped keeps the pages the
// window already holds, which are still ranges of the same history, instead of
// discarding them. Wherever rows no reload returns cannot stay in place, they
// are kept beside the range they belong to, or the window says they were
// released: no row leaves the window unannounced.

/// A row no reload returns, with the anchor of the reloadable row it followed
/// (null: none did; see [_anchorAfter]).
typedef _AnchoredRow = ({AgentMessage message, String? anchor});

/// The anchor of a row that followed the reloadable row keyed [key] with
/// [keyless] reloadable rows without a key between them (an error card
/// saved, say): a reload holding that row places it after that many such
/// rows after it, where it was shown, rather than before them. Everywhere
/// else an anchor stands for [key] (see [_anchorKey]).
String _anchorAfter(String key, int keyless) =>
    keyless == 0 ? key : '$key$_anchorKeylessMark$keyless';

/// What follows the key in an anchor counting rows without a key. No stable
/// key holds it.
const _anchorKeylessMark = '\u0000';

/// The key of the row [anchor] names.
String _anchorKey(String anchor) {
  final at = anchor.indexOf(_anchorKeylessMark);
  return at < 0 ? anchor : anchor.substring(0, at);
}

/// How many reloadable rows without a key came between the row [anchor]
/// names and the row anchored to it.
int _anchorKeyless(String anchor) {
  final at = anchor.indexOf(_anchorKeylessMark);
  return at < 0 ? 0 : int.parse(anchor.substring(at + 1));
}

/// [rows] with the rows of [after] placed among them: each group after the
/// row keyed by its key, a row whose anchor counts rows without a key (see
/// [_anchorAfter]) after that many of the reloadable rows without a key
/// that follow, placed ones included, and none past the next row a group or
/// an anchor can name. Returns the rows, where each placed row went, and
/// where each of [rows] went.
({List<AgentMessage> messages, List<int> placed, List<int> moved})
_placeAfterAnchors(
  List<AgentMessage> rows,
  Map<String, List<_AnchoredRow>> after,
) {
  final messages = <AgentMessage>[];
  final placed = <int>[];
  final moved = List<int>.filled(rows.length, 0);
  var waiting = <({AgentMessage message, int keyless})>[];
  var next = 0;
  var passed = 0;
  void place({bool all = false}) {
    while (next < waiting.length && (all || waiting[next].keyless <= passed)) {
      final message = waiting[next].message;
      placed.add(messages.length);
      messages.add(message);
      next += 1;
      if (stableTranscriptMessageKey(message) == null &&
          isBackwardPageableTranscriptMessage(message)) {
        passed += 1;
      }
    }
  }

  for (var index = 0; index < rows.length; index++) {
    final message = rows[index];
    final key = stableTranscriptMessageKey(message);
    final pageable = isBackwardPageableTranscriptMessage(message);
    if (key != null && (pageable || after.containsKey(key))) place(all: true);
    moved[index] = messages.length;
    messages.add(message);
    if (key != null) {
      final group = after.remove(key);
      if (group == null) continue;
      waiting = [
        for (final row in group)
          (
            message: row.message,
            keyless: row.anchor != null && _anchorKey(row.anchor!) == key
                ? _anchorKeyless(row.anchor!)
                : 0,
          ),
      ];
      next = 0;
      passed = 0;
      place();
    } else if (pageable) {
      passed += 1;
      place();
    }
  }
  place(all: true);
  return (messages: messages, placed: placed, moved: moved);
}

/// Forward navigation over a [TranscriptHistoryWindow].
extension TranscriptHistoryNavigation on TranscriptHistoryWindow {
  /// Rows a newer page from [cursor] should request to restore exactly the
  /// released range starting there, or null when no such range is known.
  int? forwardReloadLimitFor(String cursor) {
    for (final range in releasedRanges.values) {
      if (range.olderCursor == cursor) return range.pageableRows;
    }
    return null;
  }

  /// Whether the gap reloading from [reloadCursor] is an open range: one
  /// whose row count is unknown (the gap a capped reconnect left). A backward
  /// page cannot know where such a range began, so it fills from its older
  /// edge with newer pages, which stop exactly where it ends.
  bool reloadsOnlyForward(String reloadCursor) {
    final range = releasedRanges[reloadCursor];
    return range != null && range.pageableRows == null;
  }

  /// Rows the open tail received live past its broker boundary — the rows a
  /// boundary refresh can name — and their decoded estimate. Rows the
  /// transcript never renders are not counted: no refresh has to place them.
  ///
  /// Read on every live row, so each row's estimate is computed once for the
  /// row instance (rows a live update leaves alone are the same instances).
  ({int rows, int bytes}) get liveRowsWithoutBoundary {
    final tailIndex = pages.lastIndexWhere((page) => page.isTail);
    if (tailIndex < 0) return (rows: 0, bytes: 0);
    final tail = pages[tailIndex];
    final blockRows = tail.blockRows;
    final start = tail.headReleased || blockRows == null
        ? 0
        : blockRows.clamp(0, tail.messages.length);
    var rows = 0;
    var bytes = 0;
    for (var index = start; index < tail.messages.length; index++) {
      final message = tail.messages[index];
      if (_isUnrenderedTranscriptRow(message)) continue;
      rows += 1;
      bytes += _liveRowBytes[message] ??= estimatedAgentMessageDecodedBytes(
        message,
      );
    }
    return (rows: rows, bytes: bytes);
  }

  /// Inserts one newer page (contract revision 28) into the gap that starts at
  /// [requestedCursor] and ends at [until].
  ///
  /// The page is accepted only where a retained run ends at [requestedCursor]
  /// and the next run begins at [until], so it lands between them. When the
  /// walk reached [until], the broker names it verbatim and the three runs
  /// join; otherwise the gap narrows to the page's own end cursor. Rows kept
  /// beside the gap's released range (a residue) return next to the rows they
  /// followed once those rows are back (see [_settleResidues]).
  TranscriptHistoryPageMutation insertNewerPage(
    HistoryPageWireEvent event, {
    required String requestedCursor,
    required String until,
    String? preserveMessageKey,
    TranscriptHistoryWorkCounter? work,
  }) {
    final reached = event.cursor;
    if (!initialized ||
        !event.isNewer ||
        requestedCursor.isEmpty ||
        until.isEmpty ||
        reached == null) {
      return TranscriptHistoryPageMutation(
        window: this,
        rejection: TranscriptHistoryPageRejection.stale,
      );
    }
    var previousIndex = -1;
    for (var index = 0; index + 1 < pages.length; index++) {
      final previous = pages[index];
      final next = pages[index + 1];
      if (previous.newerCursor == requestedCursor &&
          next.olderCursor == until &&
          _historyGapBetween(previous, next)?.kind ==
              TranscriptHistoryGapKind.reloadable) {
        previousIndex = index;
        break;
      }
    }
    final reachedUntil = reached == until;
    // A walk that ran off the end of history without meeting [until] names no
    // place in this gap.
    if (previousIndex < 0 || (!reachedUntil && !event.hasMore)) {
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
    final pagePageable = _pageableRowCount(event.messages);
    final next = pages[previousIndex + 1];
    final residueAtUntil =
        next.isResidue &&
        next.olderCursor == until &&
        next.newerCursor == until;
    var inserted = TranscriptHistoryPage(
      messages: pageMessages,
      olderCursor: requestedCursor,
      newerCursor: reached,
      isTail: false,
      estimatedBytes: pageBytes,
      reloadLimit: pagePageable,
    );
    // What becomes of the residue at [until]: kept as it is (the default),
    // consumed whole, or replaced by what is left of it.
    var residueReplaced = false;
    TranscriptHistoryPage? residueLeft;
    // The pages after the residue, when rows it kept go into them.
    List<TranscriptHistoryPage>? runAfter;
    if (residueAtUntil && reachedUntil) {
      // The page covers the whole gap, so every kept row's place is in it or,
      // for one that followed a row of the run after it, there.
      final split = _residueRowsIntoRun(next, {
        for (final message in pageMessages)
          ?stableTranscriptMessageKey(message),
      }, pages.sublist(previousIndex + 2));
      runAfter = split.run;
      final woven = _weaveResidue(
        pageMessages,
        split.residue ?? next._copyWith(messages: const []),
      );
      inserted = TranscriptHistoryPage(
        messages: woven.messages,
        olderCursor: requestedCursor,
        newerCursor: reached,
        isTail: false,
        reloadLimit: pagePageable,
        liveOnlyRows: woven.liveOnly,
      );
      residueReplaced = true;
    } else if (residueAtUntil &&
        releasedRanges[until]?.olderCursor == requestedCursor) {
      // The page starts where the residue's released range started, so the
      // rows that led that range lead this page — unless the page returned
      // them after all.
      final returned = _rowsReturnedBy(pageMessages, _residueRows(next));
      final leading = <_AnchoredRow>[];
      final keep = <int>[];
      for (var index = 0; index < next.messages.length; index++) {
        if (returned.contains(index)) continue;
        if (next.residueAnchors![index] == null) {
          leading.add((message: next.messages[index], anchor: null));
        } else {
          keep.add(index);
        }
      }
      if (keep.length != next.messages.length) {
        inserted = _weaveRowsInto(inserted, leading);
        residueReplaced = true;
        residueLeft = keep.isEmpty ? null : _keepingRows(next, keep);
      }
    }
    if (residueAtUntil && !reachedUntil) {
      // A row that followed the page's last row may lie either side of where
      // the page ended, and one saved later lies past it; either way it leads
      // what is still missing, so it stays beside it with nothing before it
      // (as does whatever followed it).
      final residue = residueReplaced ? residueLeft : next;
      if (residue != null) {
        final led = _ledByLastRow(residue, pageMessages);
        if (!identical(led, residue)) {
          residueLeft = led;
          residueReplaced = true;
        }
      }
    }
    final candidate = <TranscriptHistoryPage>[
      ...pages.take(previousIndex + 1),
      inserted,
      if (residueReplaced) ?residueLeft,
      ...?runAfter,
      if (runAfter == null)
        ...pages.skip(previousIndex + (residueReplaced ? 2 : 1)),
    ];
    final nextReleased = _consumeForwardRanges(
      releasedRanges,
      from: requestedCursor,
      pageable: pagePageable,
      reached: reached,
      until: until,
    );
    final settled = _settleResidues(
      candidate,
      inserted,
      released: releasedRanges,
      releasedAfter: nextReleased,
      keptAfter: true,
    );
    final fitted = _fitTranscriptBudget(
      settled.pages,
      nextReleased,
      protectedKey: preserveMessageKey,
      pinned: settled.inserted,
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
        latestHistoryTruncation: null,
        releasedRanges: fitted.released,
      ),
    );
  }
}

/// [residue] with the rows that followed the last pageable row of [page]
/// re-anchored to nothing: they lead the range still missing after [page].
/// Rows that followed them keep their anchors, so they stay after them.
/// [residue] itself when there are none.
TranscriptHistoryPage _ledByLastRow(
  TranscriptHistoryPage residue,
  List<AgentMessage> page,
) {
  String? last;
  for (final message in page.reversed) {
    final key = stableTranscriptMessageKey(message);
    if (key != null && isBackwardPageableTranscriptMessage(message)) {
      last = key;
      break;
    }
  }
  if (last == null) return residue;
  final anchors = residue.residueAnchors!;
  bool led(String? anchor) => anchor != null && _anchorKey(anchor) == last;
  if (!anchors.any(led)) return residue;
  return residue._copyWith(
    residueAnchors: [for (final anchor in anchors) led(anchor) ? null : anchor],
  );
}

/// Decoded estimates of live rows, per row instance.
final Expando<int> _liveRowBytes = Expando<int>('liveRowBytes');

/// Records in [ranges] what is left of an open range (its row count unknown)
/// after a backward page from its newer end reached [reached]; [behind] is
/// the range's older boundary, and [stop] the newer boundary of the run
/// before the gap (null at the leading edge). Returns the boundary the rest
/// now ends at, or null when nothing is left.
///
/// Only the ranges behind it say where the page stopped: when [reached] is
/// one of their boundaries the page covered everything down to it; otherwise
/// it ended inside the open range or a range behind it, which no count says,
/// so the rest of the gap becomes one open range ending at [reached]. Either
/// way no range is left ending before the boundary it starts at.
String? _consumeBackwardOpenRange(
  Map<String, TranscriptReleasedRange> ranges, {
  required String? behind,
  required String? reached,
  required String? stop,
}) {
  // The open range's older boundary, then each older boundary of the ranges
  // behind it, down to the run before the gap or the start of what is known.
  final boundaries = <String?>[behind];
  while (true) {
    final at = boundaries.last;
    if (at == null || at == stop) break;
    final range = ranges[at];
    if (range == null || boundaries.contains(range.olderCursor)) break;
    boundaries.add(range.olderCursor);
  }
  final reachedAt = reached == null
      ? boundaries.length - 1
      : boundaries.indexOf(reached);
  final covered = reachedAt < 0 ? boundaries.length - 1 : reachedAt;
  for (var index = 0; index < covered; index++) {
    ranges.remove(boundaries[index]);
  }
  if (reachedAt >= 0 || reached == null) return null;
  ranges[reached] = TranscriptReleasedRange(
    olderCursor: boundaries.last,
    pageableRows: null,
  );
  return reached;
}

/// [ranges] after a newer page from [from] returned [pageable] rows and ended
/// at [reached].
///
/// Released ranges tile a gap from its older edge, each keyed by the boundary
/// after it. A range the page covered is no longer released; a range the page
/// ended inside keeps its rest, which now starts where the page ended — the
/// broker's own cursor, and exact because both count the same pageable rows.
///
/// A range whose row count is unknown (open) cannot say whether the page
/// ended inside it or ran on past it. When [reached] is a boundary further
/// along the gap the page covered everything up to it; otherwise the rest of
/// the gap becomes one open range from [reached] to the gap's end. Either way
/// no range is left starting after the boundary it ends at, or describing
/// rows the page returned.
Map<String, TranscriptReleasedRange> _consumeForwardRanges(
  Map<String, TranscriptReleasedRange> ranges, {
  required String from,
  required int pageable,
  required String reached,
  required String until,
}) {
  final next = Map<String, TranscriptReleasedRange>.of(ranges);
  var cursor = from;
  var remaining = pageable;
  while (true) {
    String? key;
    for (final entry in next.entries) {
      if (entry.value.olderCursor == cursor) {
        key = entry.key;
        break;
      }
    }
    if (key == null) break;
    if (key == reached) {
      next.remove(key);
      break;
    }
    final rows = next[key]!.pageableRows;
    if (rows == null) {
      // The boundaries of this range and those after it, up to the gap's end.
      final chain = <String>[key];
      while (chain.last != until) {
        String? after;
        for (final entry in next.entries) {
          if (entry.value.olderCursor == chain.last) {
            after = entry.key;
            break;
          }
        }
        if (after == null || chain.contains(after)) break;
        chain.add(after);
      }
      final reachedAt = chain.indexOf(reached);
      for (var index = 0; index <= reachedAt; index++) {
        next.remove(chain[index]);
      }
      if (reachedAt < 0) {
        // It ended inside this range or one after it: which, no count says.
        next
          ..removeWhere((boundary, _) => chain.contains(boundary))
          ..[chain.last] = TranscriptReleasedRange(
            olderCursor: reached,
            pageableRows: null,
          );
      }
      break;
    }
    if (remaining >= rows) {
      next.remove(key);
      remaining -= rows;
      cursor = key;
      continue;
    }
    next[key] = TranscriptReleasedRange(
      olderCursor: reached,
      pageableRows: rows - remaining,
    );
    break;
  }
  if (reached == until) next.remove(until);
  return next;
}

/// The rows of an exact reload of a residue's range, with the residue's rows
/// woven back after the reloadable rows they followed.
({List<AgentMessage> messages, List<int> liveOnly}) _weaveResidue(
  List<AgentMessage> reloaded,
  TranscriptHistoryPage residue,
) {
  final reloadedKeys = <String>{
    for (final message in reloaded) ?stableTranscriptMessageKey(message),
  };
  final returned = _rowsReturnedBy(reloaded, _residueRows(residue));
  final leading = <_AnchoredRow>[];
  final trailing = <_AnchoredRow>[];
  final after = <String, List<_AnchoredRow>>{};
  // A row whose anchor the reload does not hold (another kept row, such as
  // the request an approval's resolution followed) goes where the row before
  // it went; with none placed yet, after the reloaded rows.
  List<_AnchoredRow>? slot;
  for (var index = 0; index < residue.messages.length; index++) {
    final message = residue.messages[index];
    // The reload returned it after all.
    if (returned.contains(index)) continue;
    final anchor = residue.residueAnchors![index];
    if (anchor == null) {
      slot = leading;
    } else if (reloadedKeys.contains(_anchorKey(anchor))) {
      slot = after[_anchorKey(anchor)] ??= <_AnchoredRow>[];
    } else {
      slot ??= trailing;
    }
    slot.add((message: message, anchor: anchor));
  }
  final woven = _placeAfterAnchors(reloaded, after);
  final messages = [
    for (final row in leading) row.message,
    ...woven.messages,
    for (final row in trailing) row.message,
  ];
  final liveOnly = [
    for (var index = 0; index < leading.length; index++) index,
    for (final index in woven.placed) leading.length + index,
    for (
      var index = messages.length - trailing.length;
      index < messages.length;
      index++
    )
      index,
  ];
  return (messages: messages, liveOnly: liveOnly);
}

/// [page] with [rows] placed among its rows: each after the row keyed by its
/// anchor, a row whose anchor [page] does not hold after the row placed before
/// it, and a row with no anchor (or none placed yet) at the start. Placed rows
/// are marked as rows [page]'s reload does not return.
TranscriptHistoryPage _weaveRowsInto(
  TranscriptHistoryPage page,
  List<_AnchoredRow> rows,
) {
  if (rows.isEmpty) return page;
  final pageKeys = <String>{
    for (final message in page.messages) ?stableTranscriptMessageKey(message),
  };
  final leading = <AgentMessage>[];
  final after = <String, List<_AnchoredRow>>{};
  String? slot;
  for (final row in rows) {
    final anchor = row.anchor;
    if (anchor == null) {
      slot = null;
    } else if (pageKeys.contains(_anchorKey(anchor))) {
      slot = _anchorKey(anchor);
    }
    if (slot == null) {
      leading.add(row.message);
    } else {
      (after[slot] ??= <_AnchoredRow>[]).add(row);
    }
  }
  final woven = _placeAfterAnchors(page.messages, after);
  final messages = [...leading, ...woven.messages];
  final placed = [
    for (var index = 0; index < leading.length; index++) index,
    for (final index in woven.placed) leading.length + index,
  ];
  final moved = [for (final index in woven.moved) leading.length + index];
  if (!page.isTail) {
    return page._copyWith(
      messages: messages,
      liveOnlyRows: [
        for (final index in page.liveOnlyRows) moved[index],
        ...placed,
      ]..sort(),
    );
  }
  final blockRows = page.blockRows;
  final nextBlockRows = blockRows == null
      ? null
      : blockRows == 0
      ? 0
      : moved[blockRows - 1] + 1;
  return page._copyWith(
    messages: messages,
    blockRows: nextBlockRows,
    blockLiveOnlyRows:
        nextBlockRows == null
              ? const []
              : [
                  for (final index in page.blockLiveOnlyRows) moved[index],
                  for (final index in placed)
                    if (index < nextBlockRows) index,
                ]
          ..sort(),
  );
}

/// [page] (not the open tail) keeping only the rows at [keep], ascending,
/// with its row marks carried along. A dropped durable row leaves the page's
/// reload count unknown.
TranscriptHistoryPage _keepingRows(
  TranscriptHistoryPage page,
  List<int> keep,
) {
  final at = <int, int>{
    for (var index = 0; index < keep.length; index++) keep[index]: index,
  };
  final liveOnly = page.liveOnlyRows.toSet();
  var droppedDurable = false;
  for (var index = 0; index < page.messages.length; index++) {
    if (at.containsKey(index) || liveOnly.contains(index)) continue;
    if (isBackwardPageableTranscriptMessage(page.messages[index])) {
      droppedDurable = true;
    }
  }
  return TranscriptHistoryPage(
    messages: [for (final index in keep) page.messages[index]],
    olderCursor: page.olderCursor,
    newerCursor: page.newerCursor,
    isTail: false,
    headReleased: page.headReleased,
    reloadLimit: droppedDurable ? null : page.reloadLimit,
    sealedFromTail: page.sealedFromTail,
    liveOnlyRows: [
      for (final index in page.liveOnlyRows)
        if (at.containsKey(index)) at[index]!,
    ],
    residueAnchors: page.residueAnchors == null
        ? null
        : [for (final index in keep) page.residueAnchors![index]],
  );
}

/// [page] (not the open tail) without its rows whose keys [held] names, or
/// null when it held nothing else. A page with no rows is returned as it is.
TranscriptHistoryPage? _withoutHeldRows(
  TranscriptHistoryPage page,
  Set<String> held,
) {
  if (page.messages.isEmpty || held.isEmpty) return page;
  final keep = <int>[
    for (var index = 0; index < page.messages.length; index++)
      if (!held.contains(stableTranscriptMessageKey(page.messages[index])))
        index,
  ];
  if (keep.length == page.messages.length) return page;
  if (keep.isEmpty) return null;
  return _keepingRows(page, keep);
}

/// [page] (not the open tail) without the rows no reload returns whose keys
/// [held] names: they were saved since, and the copy holding them is the
/// saved one. Null when a residue is left empty.
TranscriptHistoryPage? _withoutLiveOnlyRowsHeld(
  TranscriptHistoryPage page,
  Set<String> held,
) {
  if (page.liveOnlyRows.isEmpty || held.isEmpty) return page;
  final drop = <int>{
    for (final index in page.liveOnlyRows)
      if (held.contains(stableTranscriptMessageKey(page.messages[index])))
        index,
  };
  if (drop.isEmpty) return page;
  final keep = <int>[
    for (var index = 0; index < page.messages.length; index++)
      if (!drop.contains(index)) index,
  ];
  if (keep.isEmpty && page.isResidue) return null;
  return _keepingRows(page, keep);
}

/// Whether [inserted] fills part of the released range [residue] sits beside:
/// it ends where the residue sits (a page back from the range's newer end,
/// where each partial reload moves the residue), starts where the range still
/// begins (a newer page from its older end), or ran into the range or over
/// all of it from a range before it. [released] is the window's ranges before
/// the page was inserted, and [releasedAfter] (for a newer page) after it.
/// Only such a page can hold the saved place of a residue row: every other
/// page lies outside the range the row was released from, however alike
/// their rows.
bool _fillsResidueRange(
  TranscriptHistoryPage residue,
  TranscriptHistoryPage inserted,
  Map<String, TranscriptReleasedRange> released,
  Map<String, TranscriptReleasedRange>? releasedAfter,
) {
  final boundary = residue.olderCursor;
  if (boundary != null && inserted.newerCursor == boundary) return true;
  final range = residue.newerCursor;
  final start = released[range]?.olderCursor;
  if (start == null) return false;
  if (inserted.olderCursor == start) return true;
  if (releasedAfter == null) return false;
  final rest = releasedAfter[range];
  // The rest of the range starts where the page ended, or none is left.
  return rest == null || rest.olderCursor == inserted.newerCursor;
}

/// Whether [message] is a prompt shown when sent and not delivered to the
/// agent yet: it is saved where the agent takes it, after rows that followed
/// it on screen, so it is no anchor for where they belong.
bool _isQueuedPrompt(AgentMessage message) => message.userMessageQueued;

/// The rows of [rows] (each with the key of the reloadable row it followed)
/// that [reload] returned: a row with a key wherever [reload] holds that key;
/// a row without one by what it says, and only where its saved copy can lie —
/// after the row it followed when [reload] holds that row (at the start when
/// it followed none), and before the next row of [rows] with a key [reload]
/// holds, which followed it — once per copy, in order. A prompt it followed
/// bounds nothing: a prompt is saved where the agent takes it, which can be
/// after rows shown after it. Positions in [skip] are rows woven in beside
/// [reload]'s own, not rows it returned.
Set<int> _rowsReturnedBy(
  List<AgentMessage> reload,
  List<_AnchoredRow> rows, {
  Set<int> skip = const {},
}) {
  final at = <String, int>{};
  for (var index = 0; index < reload.length; index++) {
    if (skip.contains(index)) continue;
    final key = stableTranscriptMessageKey(reload[index]);
    if (key != null) at.putIfAbsent(key, () => index);
  }
  // For each row, where the next row of [rows] that [reload] holds lies.
  final until = List<int>.filled(rows.length, reload.length);
  var next = reload.length;
  for (var index = rows.length - 1; index >= 0; index--) {
    until[index] = next;
    final key = stableTranscriptMessageKey(rows[index].message);
    final held = key == null ? null : at[key];
    if (held != null) next = held;
  }
  final returned = <int>{};
  final taken = <int>{};
  final signatureAt = <int, String>{};
  String signatureOf(int index) =>
      signatureAt[index] ??= _keylessRowSignature(reload[index]);
  var floor = 0;
  for (var index = 0; index < rows.length; index++) {
    final message = rows[index].message;
    final key = stableTranscriptMessageKey(message);
    if (key != null) {
      if (at.containsKey(key)) returned.add(index);
      continue;
    }
    final anchor = rows[index].anchor;
    final anchorAt = anchor == null ? null : at[_anchorKey(anchor)];
    final from =
        anchorAt != null &&
            anchorAt + 1 > floor &&
            reload[anchorAt].type != AgentMessageType.userMessage
        ? anchorAt + 1
        : floor;
    final signature = _keylessRowSignature(message);
    for (var candidate = from; candidate < until[index]; candidate++) {
      if (skip.contains(candidate) || taken.contains(candidate)) continue;
      if (stableTranscriptMessageKey(reload[candidate]) != null) continue;
      if (signatureOf(candidate) != signature) continue;
      returned.add(index);
      taken.add(candidate);
      floor = candidate + 1;
      break;
    }
  }
  return returned;
}

/// The rows of [page] (a residue) with their anchors.
List<_AnchoredRow> _residueRows(TranscriptHistoryPage page) => [
  for (var index = 0; index < page.messages.length; index++)
    (message: page.messages[index], anchor: page.residueAnchors![index]),
];

/// [pages] after [inserted] joined them.
///
/// A row kept beside a released range (in a residue, or as a row an older
/// page's reload does not return) or received live by the open tail that
/// [inserted] holds is dropped: a reload returned its saved copy after all.
///
/// A residue row goes back into [inserted] only when [inserted] fills the
/// residue's own released range (see [_fillsResidueRange]): after a row
/// [inserted] holds that it followed, and a row without a key is recognised
/// there by content, between the rows it came between (see
/// [_rowsReturnedBy]). A page outside that range can hold a row the residue
/// row followed on screen — a live update to a row saved far back, or a row
/// saved later than it was shown — but not the residue row's place. When such
/// a page returns a residue row, the rows that followed it take the row it
/// followed as theirs.
///
/// When the rows a residue keeps stay after [inserted] ([keptAfter]: a newer
/// page, whose range's rest lies after it), [inserted] takes only rows before
/// the first row kept, so residue rows keep their order (see
/// [_residueRowsTaken]).
///
/// Emptied residues go. A residue row with no anchor stays: only the caller
/// knows whether [inserted] starts its released range.
({List<TranscriptHistoryPage> pages, TranscriptHistoryPage inserted})
_settleResidues(
  List<TranscriptHistoryPage> pages,
  TranscriptHistoryPage inserted, {
  required Map<String, TranscriptReleasedRange> released,
  required bool keptAfter,
  Map<String, TranscriptReleasedRange>? releasedAfter,
}) {
  final keys = <String>{
    for (final message in inserted.messages)
      ?stableTranscriptMessageKey(message),
  };
  final reloadedLiveOnly = inserted.liveOnlyRows.toSet();
  final reloadsKeyless = [
    for (var index = 0; index < inserted.messages.length; index++)
      if (!reloadedLiveOnly.contains(index) &&
          stableTranscriptMessageKey(inserted.messages[index]) == null)
        index,
  ].isNotEmpty;
  if (keys.isEmpty && !reloadsKeyless) {
    return (pages: pages, inserted: inserted);
  }
  final carried = <_AnchoredRow>[];
  final out = <TranscriptHistoryPage>[];
  var insertedAt = -1;
  var changed = false;
  for (final page in pages) {
    if (identical(page, inserted)) {
      insertedAt = out.length;
      out.add(page);
      continue;
    }
    if (page.isTail) {
      final kept = _withoutLiveTailRowsHeld(page, keys);
      if (!identical(kept, page)) changed = true;
      out.add(kept);
      continue;
    }
    if (!page.isResidue) {
      final kept = _withoutLiveOnlyRowsHeld(page, keys);
      if (!identical(kept, page)) changed = true;
      if (kept != null) out.add(kept);
      continue;
    }
    final fills = _fillsResidueRange(page, inserted, released, releasedAfter);
    final residueRows = _residueRows(page);
    final returned = fills
        ? _rowsReturnedBy(
            inserted.messages,
            residueRows,
            skip: reloadedLiveOnly,
          )
        : {
            for (var index = 0; index < residueRows.length; index++)
              if (keys.contains(
                stableTranscriptMessageKey(residueRows[index].message),
              ))
                index,
          };
    // The row each row followed, and for a row returned by a page outside
    // the range, the row it followed, for the rows that followed it.
    final anchors = <String?>[];
    final inherited = <String, String?>{};
    for (var index = 0; index < page.messages.length; index++) {
      var anchor = page.residueAnchors![index];
      while (anchor != null && inherited.containsKey(_anchorKey(anchor))) {
        anchor = inherited[_anchorKey(anchor)];
      }
      anchors.add(anchor);
      final key = stableTranscriptMessageKey(page.messages[index]);
      if (returned.contains(index) && !fills && key != null) {
        inherited[key] = anchor;
      }
    }
    final taken = fills
        ? _residueRowsTaken(
            page,
            anchors,
            returned,
            keys,
            keptAfter: keptAfter,
          )
        : const <int>{};
    final keep = <int>[];
    final keptAnchors = <String?>[];
    for (var index = 0; index < page.messages.length; index++) {
      if (returned.contains(index)) continue;
      if (taken.contains(index)) {
        carried.add((message: page.messages[index], anchor: anchors[index]));
        continue;
      }
      keep.add(index);
      keptAnchors.add(anchors[index]);
    }
    if (keep.length == page.messages.length) {
      out.add(page);
      continue;
    }
    changed = true;
    if (keep.isNotEmpty) {
      out.add(_keepingRows(page, keep)._copyWith(residueAnchors: keptAnchors));
    }
  }
  if (!changed || insertedAt < 0) return (pages: pages, inserted: inserted);
  final woven = _weaveRowsInto(inserted, carried);
  out[insertedAt] = woven;
  return (pages: out, inserted: woven);
}

/// The rows of [residue] (less those in [returned]) that go into a page
/// holding the rows keyed [keys]: each after the row it followed ([anchors]),
/// when the page holds that row or takes it. When the rows left stay after
/// the page ([keptAfter]), it takes none after the first row left: a row
/// taken from after it would read before it.
Set<int> _residueRowsTaken(
  TranscriptHistoryPage residue,
  List<String?> anchors,
  Set<int> returned,
  Set<String> keys, {
  required bool keptAfter,
}) {
  final taken = <int>{};
  // A row that followed a row taken (an approval's resolution after its
  // request) goes with it.
  final takenKeys = <String>{};
  for (var index = 0; index < residue.messages.length; index++) {
    if (returned.contains(index)) continue;
    final anchor = anchors[index];
    if (anchor == null ||
        !(keys.contains(_anchorKey(anchor)) ||
            takenKeys.contains(_anchorKey(anchor)))) {
      if (keptAfter) break;
      continue;
    }
    taken.add(index);
    final key = stableTranscriptMessageKey(residue.messages[index]);
    if (key != null) takenKeys.add(key);
  }
  return taken;
}

/// Splits the rows of [residue], whose released range is now filled by the
/// rows keyed [reloaded], by where they go: a row that followed a row of
/// [run] (the pages after the residue), or followed such a row, was never
/// saved (a saved one would have been reloaded), and goes after that row
/// there. Returns [run] with those rows woven in and the residue keeping the
/// rest (null when none is left), for the reload to take back.
({List<TranscriptHistoryPage> run, TranscriptHistoryPage? residue})
_residueRowsIntoRun(
  TranscriptHistoryPage residue,
  Set<String> reloaded,
  List<TranscriptHistoryPage> run,
) {
  final anchors = residue.residueAnchors!;
  // Run page each carried row went to, by its key.
  final carriedTo = <String, int>{};
  final carried = <int, List<_AnchoredRow>>{};
  final keep = <int>[];
  for (var index = 0; index < residue.messages.length; index++) {
    final message = residue.messages[index];
    final key = stableTranscriptMessageKey(message);
    final anchor = anchors[index];
    final anchorKey = anchor == null ? null : _anchorKey(anchor);
    int? at;
    if (anchorKey != null &&
        !reloaded.contains(anchorKey) &&
        (key == null || !reloaded.contains(key))) {
      at = carriedTo[anchorKey];
      if (at == null) {
        for (var page = 0; page < run.length; page++) {
          if (!run[page].isResidue && run[page].containsStableKey(anchorKey)) {
            at = page;
            break;
          }
        }
      }
    }
    if (at == null) {
      keep.add(index);
      continue;
    }
    (carried[at] ??= <_AnchoredRow>[]).add((message: message, anchor: anchor));
    if (key != null) carriedTo[key] = at;
  }
  if (carried.isEmpty) return (run: run, residue: residue);
  final next = List<TranscriptHistoryPage>.of(run);
  carried.forEach((at, rows) => next[at] = _weaveRowsInto(next[at], rows));
  return (
    run: next,
    residue: keep.isEmpty ? null : _keepingRows(residue, keep),
  );
}

/// The open [tail] without the rows it received live (past its block, or
/// marked live-only inside it) whose keys [held] names: an inserted page
/// restates them, and the copy holding them there is the saved one. Only a
/// row with a place in history goes: a latest-wins row received live (a run
/// summary rewritten in place) is a newer reading than the page's copy, which
/// may have been read before it. A tail with no block cannot tell its live
/// rows from a frame's, and keeps them.
TranscriptHistoryPage _withoutLiveTailRowsHeld(
  TranscriptHistoryPage tail,
  Set<String> held,
) {
  final blockRows = tail.blockRows;
  if (blockRows == null) return tail;
  final liveOnly = tail.blockLiveOnlyRows.toSet();
  final keep = <int>[];
  for (var index = 0; index < tail.messages.length; index++) {
    final key = stableTranscriptMessageKey(tail.messages[index]);
    final live = index >= blockRows || liveOnly.contains(index);
    if (live &&
        key != null &&
        held.contains(key) &&
        _isReconcilePositionAnchor(tail.messages[index])) {
      continue;
    }
    keep.add(index);
  }
  if (keep.length == tail.messages.length) return tail;
  final at = <int, int>{
    for (var index = 0; index < keep.length; index++) keep[index]: index,
  };
  return tail._copyWith(
    messages: [for (final index in keep) tail.messages[index]],
    blockRows: keep.where((index) => index < blockRows).length,
    blockLiveOnlyRows: [
      for (final index in tail.blockLiveOnlyRows)
        if (at.containsKey(index)) at[index]!,
    ],
  );
}

/// Whether releasing [pages] for a reset whose replacement holds the rows
/// keyed [held] would drop a row the transcript shows that no reload returns:
/// a row an older page or a residue keeps as such, a row the open tail
/// received live since its last frame, or a marker's note that such rows were
/// already released. A tail row the tail cannot vouch for (no frame boundary)
/// is not counted; see the window's recorded limits.
bool _dropsUnsavedRows(
  Iterable<TranscriptHistoryPage> pages,
  Set<String> held,
) {
  bool unsaved(AgentMessage message) {
    if (_isUnrenderedTranscriptRow(message)) return false;
    final key = stableTranscriptMessageKey(message);
    return key == null || !held.contains(key);
  }

  for (final page in pages) {
    if (page.isReleasedResidueMarker) return true;
    if (!page.isTail) {
      for (final index in page.liveOnlyRows) {
        if (unsaved(page.messages[index])) return true;
      }
      continue;
    }
    if (page.headReleased &&
        (page.shedUnverifiable ||
            page.shedKeys.any((k) => !held.contains(k)))) {
      return true;
    }
    final blockRows = page.blockRows;
    if (blockRows == null) continue;
    for (final index in page.blockLiveOnlyRows) {
      if (index < page.messages.length && unsaved(page.messages[index])) {
        return true;
      }
    }
    for (var index = blockRows; index < page.messages.length; index++) {
      if (unsaved(page.messages[index])) return true;
    }
  }
  return false;
}

/// [page] as the reader's page kept beside a reset's replacement: question
/// rows become history, and the rows its reload would not return stay marked,
/// so a later release keeps them rather than dropping them.
TranscriptHistoryPage _resetAnchorPage(TranscriptHistoryPage page) {
  final messages = [
    for (final message in page.messages)
      SessionQuestionState.historicalMessage(message),
  ];
  if (!page.isTail) {
    return TranscriptHistoryPage(
      messages: messages,
      olderCursor: page.olderCursor,
      newerCursor: page.newerCursor,
      isTail: false,
      headReleased: page.headReleased,
      reloadLimit: page.reloadLimit,
      sealedFromTail: page.sealedFromTail,
      liveOnlyRows: page.liveOnlyRows,
      residueAnchors: page.residueAnchors,
    );
  }
  final blockRows = page.blockRows;
  // A tail that is exactly its broker block keeps the block's end boundary.
  final wholeBlock =
      !page.headReleased &&
      blockRows != null &&
      blockRows == messages.length &&
      page.blockEndCursor != null;
  return TranscriptHistoryPage(
    messages: messages,
    olderCursor: page.olderCursor,
    newerCursor: wholeBlock ? page.blockEndCursor : null,
    isTail: false,
    headReleased: page.headReleased,
    reloadLimit: wholeBlock ? page.blockPageableRows : null,
    sealedFromTail: true,
    liveOnlyRows: blockRows == null
        ? [for (var index = 0; index < messages.length; index++) index]
        : [
            for (final index in page.blockLiveOnlyRows)
              if (index < blockRows) index,
            for (var index = blockRows; index < messages.length; index++) index,
          ],
  );
}

/// The window after a reconnect whose frame was capped (a catch-up): the
/// broker confirmed this window's reconnect cursor, so every retained page is
/// still a range of the same history, and the replacement holds the newest
/// rows with a reloadable gap before them.
///
/// The retained pages stay. The open tail's broker block becomes a page ending
/// at its end boundary. The tail's rows after it (received live since its last
/// frame) belong to the gap: those the replacement holds are dropped (its copy
/// is the saved one; one without a key is recognised by content); the rest
/// stay as a residue at the gap's newer edge, each with the row it followed,
/// and the gap's older edge is remembered as an open released range, so each
/// reload from either edge settles them in place (see [_settleResidues])
/// and, once the gap is filled, a row that followed a row of the replacement
/// returns after it (see [_residueRowsIntoRun]). Where there is no gap after
/// all, those rows join the replacement directly. Rows the replacement holds
/// are dropped from the retained pages too.
///
/// Null when the window cannot be kept this way: a tail whose leading live
/// rows were already released (nothing vouches for where the rest belong), no
/// block end a frame named for the tail's rows, or a replacement with no
/// boundary before it.
TranscriptHistoryWindow? _caughtUpWindow(
  TranscriptHistoryWindow old,
  TranscriptHistoryWindow replacement,
  Set<String> held, {
  required String? preserveMessageKey,
}) {
  if (replacement.pages.isEmpty) return null;
  final replacementTail = replacement.pages.last;
  final gapEnd = replacement.pages.first.olderCursor;
  // A replacement that starts at the start of history left nothing out:
  // there is no gap for the retained pages to stand before.
  if (!replacementTail.isTail ||
      replacementTail.headReleased ||
      replacementTail.olderCursor == null ||
      gapEnd == null) {
    return null;
  }
  final tailIndex = old.pages.lastIndexWhere((page) => page.isTail);
  if (tailIndex < 0) return null;
  final tail = old.pages[tailIndex];
  if (tail.headReleased) return null;
  final blockRows = tail.blockRows;
  final blockEnd = tail.blockEndCursor;
  // Only a boundary a frame named after its own rows says where the rows the
  // window already holds end. A tail with none (hydrated from the local
  // snapshot, or given a start boundary that no longer describes its block)
  // is replaced.
  if (blockRows == null || blockEnd == null) return null;
  final boundary = blockEnd;
  final vouched = blockRows.clamp(0, tail.messages.length);
  final kept = <TranscriptHistoryPage>[];
  for (var index = 0; index < old.pages.length; index++) {
    if (index == tailIndex) continue;
    final page = _withoutHeldRows(old.pages[index], held);
    if (page != null) kept.add(page);
  }
  if (vouched > 0) {
    final block = _withoutHeldRows(
      TranscriptHistoryPage(
        messages: tail.messages.sublist(0, vouched),
        olderCursor: tail.olderCursor,
        newerCursor: boundary,
        isTail: false,
        reloadLimit: tail.blockPageableRows,
        sealedFromTail: true,
        liveOnlyRows: [
          for (final index in tail.blockLiveOnlyRows)
            if (index < vouched) index,
        ],
      ),
      held,
    );
    if (block != null) kept.add(block);
  }
  final besideGap = <_AnchoredRow>[];
  final intoReplacement = <_AnchoredRow>[];
  // With no gap, every row saved since the boundary is in the replacement, so
  // a row that followed one it holds (and was not saved with it) goes after
  // it there; keys of rows going in carry a row that followed them (an
  // approval's resolution after its request) along. With a gap, where a row
  // was delivered says nothing about where it was saved: a prompt queued
  // before rows saved ahead of it is saved after them, so the rows that
  // followed it live lie in the gap. Every row then stays beside the gap with
  // its anchor until the gap is filled (see [_residueRowsIntoRun]).
  final noGap = boundary == gapEnd;
  final intoKeys = <String>{};
  // Each live row with the row it followed. A prompt not delivered yet is
  // saved where the agent takes it, so the rows after it are anchored to the
  // row before it instead. A row without a key between them counts whether
  // or not it was saved: kept, it goes before the rows after it anyway.
  final liveRows = <_AnchoredRow>[];
  String? anchor;
  var keyless = 0;
  for (var index = vouched; index < tail.messages.length; index++) {
    final message = tail.messages[index];
    final key = stableTranscriptMessageKey(message);
    liveRows.add((
      message: message,
      anchor: anchor == null ? null : _anchorAfter(anchor, keyless),
    ));
    if (!isBackwardPageableTranscriptMessage(message)) continue;
    if (key == null) {
      keyless += 1;
    } else if (!_isQueuedPrompt(message)) {
      anchor = key;
      keyless = 0;
    }
  }
  // A row without a key the replacement restates (an error card received
  // live, and saved) is recognised by content, where it can lie.
  final restatedRows = _rowsReturnedBy([
    for (final page in replacement.pages) ...page.messages,
  ], liveRows);
  for (var index = 0; index < liveRows.length; index++) {
    final (:message, :anchor) = liveRows[index];
    final key = stableTranscriptMessageKey(message);
    if (!restatedRows.contains(index)) {
      if (!_isUnrenderedTranscriptRow(message)) {
        final row = (
          message: SessionQuestionState.historicalMessage(message),
          anchor: anchor,
        );
        if (noGap &&
            anchor != null &&
            (held.contains(_anchorKey(anchor)) ||
                intoKeys.contains(_anchorKey(anchor)))) {
          intoReplacement.add(row);
          if (key != null) intoKeys.add(key);
        } else {
          besideGap.add(row);
        }
      }
    }
  }
  final replacementPages = List<TranscriptHistoryPage>.of(replacement.pages);
  if (intoReplacement.isNotEmpty) {
    // The frame's rows are sealed into its first page; the open tail after it
    // holds none of them yet.
    final into = replacementPages.first.isTail
        ? replacementPages.length - 1
        : 0;
    replacementPages[into] = _weaveRowsInto(
      replacementPages[into],
      intoReplacement,
    );
  }
  if (besideGap.isNotEmpty && noGap) {
    // No gap after all: the rows follow the boundary the frame starts at.
    replacementPages[0] = _weaveRowsInto(replacementPages[0], [
      for (final row in besideGap) (message: row.message, anchor: null),
    ]);
    besideGap.clear();
  }
  final released = Map<String, TranscriptReleasedRange>.of(old.releasedRanges);
  final pages = <TranscriptHistoryPage>[
    ..._mapQuestionPages(kept, SessionQuestionState.historicalMessage),
    if (besideGap.isNotEmpty)
      TranscriptHistoryPage(
        messages: [for (final row in besideGap) row.message],
        olderCursor: gapEnd,
        newerCursor: gapEnd,
        isTail: false,
        reloadLimit: 0,
        liveOnlyRows: [
          for (var index = 0; index < besideGap.length; index++) index,
        ],
        residueAnchors: [for (final row in besideGap) row.anchor],
      ),
    ...replacementPages,
  ];
  if (!noGap) {
    released[gapEnd] = TranscriptReleasedRange(
      olderCursor: boundary,
      pageableRows: null,
    );
  }
  final fitted = _fitTranscriptBudget(
    pages,
    released,
    protectedKey: preserveMessageKey,
    notWaiting: old.questionState.withdrawnRequestIds,
  );
  return replacement._with(
    pages: fitted.pages,
    // The replacement's "last N of M" no longer describes a window that also
    // holds older pages; the explicit gap does.
    latestHistoryTruncation: null,
    releasedRanges: fitted.released,
    unsavedReleasedElsewhere:
        old.unsavedReleasedElsewhere || fitted.unsavedOverflow,
  );
}
