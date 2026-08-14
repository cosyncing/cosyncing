import 'package:flutter/foundation.dart';

/// Logical reading-progress model for the variable-height transcript (N2-D).
///
/// Flutter's lazy list only estimates the extent of unbuilt rows, so the
/// native `pixels / maxScrollExtent` ratio can move backwards during a
/// monotone gesture as tall rows enter layout and the estimate corrects.
/// Progress here is derived from *stable logical row position* instead: the
/// index of the row under the viewport's bottom edge plus the visible
/// fraction of that row, over the total row count. Only currently laid-out
/// rows are consulted, so one reading is `O(visible rows)`.

/// Geometry of one laid-out transcript row, in viewport coordinates.
@immutable
final class TranscriptRowGeometry {
  /// Creates one row geometry sample.
  const TranscriptRowGeometry({
    required this.index,
    required this.viewportTop,
    required this.height,
  });

  /// Stable logical index of the row in the flat transcript row list.
  final int index;

  /// Top edge of the row relative to the viewport's top edge.
  final double viewportTop;

  /// Laid-out height of the row.
  final double height;
}

/// Sub-pixel slack for the tail test: fractional layout rounding must not
/// keep a fully revealed last row from reading as finished.
const double _tailSlackPx = 0.5;

/// True when the transcript's LAST logical row is laid out and fully above
/// the viewport's bottom edge.
///
/// This is the only trustworthy "at the end" signal for a lazy list: the
/// estimated `maxScrollExtent` can transiently equal the current offset while
/// trailing rows are still unbuilt, so a pixel comparison declares the tail
/// early — and a monotone display latch would then hold a false 100%. A row
/// that is not even mounted can never satisfy this predicate.
bool transcriptAtTail({
  required Iterable<TranscriptRowGeometry> mountedRows,
  required int totalRows,
  required double viewportHeight,
}) {
  if (totalRows <= 0 || viewportHeight <= 0) return false;
  for (final row in mountedRows) {
    if (row.index != totalRows - 1) continue;
    return row.viewportTop + row.height <= viewportHeight + _tailSlackPx;
  }
  return false;
}

/// Raw logical progress in `[0, 1]` from the rows currently laid out, or
/// `null` when nothing measurable is mounted.
///
/// The measure is the fraction of logical rows above the viewport's bottom
/// edge. For a fixed transcript it is monotone in the content offset — the
/// boundary row's index and its visible fraction can only advance as the
/// offset grows — and it never reads the list's mutable estimated
/// `maxScrollExtent`.
double? transcriptLogicalProgress({
  required Iterable<TranscriptRowGeometry> mountedRows,
  required int totalRows,
  required double viewportHeight,
  required bool atTail,
}) {
  if (totalRows <= 0 || viewportHeight <= 0) return null;
  if (atTail) return 1;
  TranscriptRowGeometry? boundary;
  TranscriptRowGeometry? lastFullyAbove;
  for (final row in mountedRows) {
    if (row.height <= 0) continue;
    final rowBottom = row.viewportTop + row.height;
    if (row.viewportTop <= viewportHeight && viewportHeight < rowBottom) {
      if (boundary == null || row.index > boundary.index) boundary = row;
    } else if (rowBottom <= viewportHeight) {
      if (lastFullyAbove == null || row.index > lastFullyAbove.index) {
        lastFullyAbove = row;
      }
    }
  }
  final double logicalRowsAbove;
  if (boundary != null) {
    final visibleFraction =
        ((viewportHeight - boundary.viewportTop) / boundary.height).clamp(
          0.0,
          1.0,
        );
    logicalRowsAbove = boundary.index + visibleFraction;
  } else if (lastFullyAbove != null) {
    // The bottom edge sits in the trailing gap after the last mounted row —
    // everything mounted has been read.
    logicalRowsAbove = (lastFullyAbove.index + 1).toDouble();
  } else {
    return null;
  }
  final progress = logicalRowsAbove / totalRows;
  return progress.clamp(0.0, 1.0);
}

/// Direction-aware monotone latch over the raw logical progress.
///
/// The raw index-based value is already stable under lazy-layout estimate
/// corrections; this latch removes the residual wobble and enforces the
/// display contract directly with one movement rule:
///
///  * while the offset moves forward — or holds still (estimate corrections,
///    appends, expansion re-measures) — the displayed value never decreases;
///  * while the offset moves backward, it never increases.
///
/// The rule subsumes the content cases: a live append while reading history
/// shrinks the raw fraction at an unmoved offset and is held; an older-page
/// prepend raises it and is adopted.
final class TranscriptProgressLatch {
  double? _displayed;
  double? _lastOffset;

  /// The currently displayed progress, or `null` before the first sample.
  double? get displayed => _displayed;

  /// Folds one `(raw, offset)` sample into the displayed value.
  ///
  /// A `null` raw (nothing measurable — e.g. a teleport's notifications fire
  /// before relayout, while every mounted row still has far-away geometry)
  /// changes nothing, *including* the direction baseline: recording the new
  /// offset for an unmeasured sample would make the first real reading after
  /// a long jump look stationary and freeze a stale high-water mark.
  double? update({required double? raw, required double offset}) {
    final lastOffset = _lastOffset;
    final previous = _displayed;
    if (raw == null) return previous;
    _lastOffset = offset;
    final double next;
    if (previous == null) {
      next = raw;
    } else if (lastOffset != null && offset < lastOffset) {
      next = raw < previous ? raw : previous;
    } else {
      next = raw > previous ? raw : previous;
    }
    _displayed = next;
    return next;
  }

  /// Forgets all samples (e.g. when the transcript surface remounts).
  void reset() {
    _displayed = null;
    _lastOffset = null;
  }
}
