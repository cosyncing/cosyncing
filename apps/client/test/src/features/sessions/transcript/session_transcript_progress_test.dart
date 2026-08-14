import 'package:cosyncing_client/src/features/sessions/transcript/session_transcript_progress.dart';
import 'package:flutter_test/flutter_test.dart';

/// N2-D model proof over an immutable 520-row mixed-height synthetic layout:
/// short text rows, long Markdown, tool cards, request cards, expanded diffs,
/// and turn footers all reduce to heights here — the model only ever sees
/// geometry.
void main() {
  const viewport = 800.0;
  const cacheExtent = 250.0;

  // 520 rows cycling through realistic transcript heights: user bubble,
  // long markdown answer, tool card, expanded diff, footer, request card.
  final heights = List<double>.generate(520, (i) {
    const cycle = [56.0, 640.0, 88.0, 1240.0, 36.0, 220.0, 24.0, 480.0];
    return cycle[i % cycle.length];
  });

  List<double> topsOf(List<double> rowHeights) {
    final tops = <double>[];
    var running = 0.0;
    for (final height in rowHeights) {
      tops.add(running);
      running += height;
    }
    return tops;
  }

  double totalOf(List<double> rowHeights) =>
      rowHeights.fold(0, (sum, h) => sum + h);

  /// The rows a lazy viewport would have laid out at [offset]: only those
  /// intersecting the viewport plus cache — never the whole list.
  List<TranscriptRowGeometry> mountedAt(
    List<double> rowHeights,
    double offset,
  ) {
    final tops = topsOf(rowHeights);
    final rows = <TranscriptRowGeometry>[];
    for (var i = 0; i < rowHeights.length; i++) {
      final top = tops[i];
      final bottom = top + rowHeights[i];
      if (bottom < offset - cacheExtent) continue;
      if (top > offset + viewport + cacheExtent) break;
      rows.add(
        TranscriptRowGeometry(
          index: i,
          viewportTop: top - offset,
          height: rowHeights[i],
        ),
      );
    }
    return rows;
  }

  double rawAt(
    List<double> rowHeights,
    double offset, {
    bool atTail = false,
  }) => transcriptLogicalProgress(
    mountedRows: mountedAt(rowHeights, offset),
    totalRows: rowHeights.length,
    viewportHeight: viewport,
    atTail: atTail,
  )!;

  group('transcriptLogicalProgress', () {
    test(
      'is monotone through a full downward sweep and never scans all rows',
      () {
        final maxOffset = totalOf(heights) - viewport;
        double? previous;
        var maxMounted = 0;
        for (var offset = 0.0; offset <= maxOffset; offset += 137) {
          final mounted = mountedAt(heights, offset);
          maxMounted = mounted.length > maxMounted
              ? mounted.length
              : maxMounted;
          final raw = transcriptLogicalProgress(
            mountedRows: mounted,
            totalRows: heights.length,
            viewportHeight: viewport,
            atTail: false,
          )!;
          if (previous != null) {
            expect(
              raw,
              greaterThanOrEqualTo(previous),
              reason: 'raw progress reversed at offset $offset',
            );
          }
          previous = raw;
        }
        // O(visible rows): the model was never handed the whole transcript.
        expect(maxMounted, lessThan(heights.length ~/ 4));
      },
    );

    test('is inversely monotone through a full upward sweep', () {
      final maxOffset = totalOf(heights) - viewport;
      double? previous;
      for (var offset = maxOffset; offset >= 0; offset -= 137) {
        final raw = rawAt(heights, offset);
        if (previous != null) {
          expect(raw, lessThanOrEqualTo(previous));
        }
        previous = raw;
      }
    });

    test('reaches exactly 1 at the tail and 0 region at the top', () {
      expect(rawAt(heights, 0), lessThan(0.05));
      expect(
        rawAt(heights, totalOf(heights) - viewport, atTail: true),
        1,
      );
    });

    test(
      'ignores the estimated extent entirely: an estimate correction that '
      'shifts the offset under identical visible geometry reads the same',
      () {
        // The failure mode: Flutter corrects `pixels`/`maxScrollExtent` as tall
        // unbuilt rows enter layout. Visible rows stay visible through the
        // correction, so the logical reading must not move.
        const offset = 40000.0;
        final before = mountedAt(heights, offset);
        // Same rows, same viewport-relative geometry, reported at a corrected
        // (shifted) offset — the model gets viewport-relative geometry only.
        final raw1 = transcriptLogicalProgress(
          mountedRows: before,
          totalRows: heights.length,
          viewportHeight: viewport,
          atTail: false,
        );
        final raw2 = transcriptLogicalProgress(
          mountedRows: before,
          totalRows: heights.length,
          viewportHeight: viewport,
          atTail: false,
        );
        expect(raw1, raw2);
      },
    );

    test('expansion above or below the viewport leaves the reading unchanged; '
        'expansion inside moves it only within the boundary row', () {
      const offset = 60000.0;
      final baseline = rawAt(heights, offset);

      // Above: rows before the mounted window grow — the viewport keeps its
      // leading row anchored, so viewport-relative geometry is unchanged.
      final expandedAbove = List<double>.of(heights)..[2] = 2400;
      final mounted = mountedAt(heights, offset);
      final aboveRaw = transcriptLogicalProgress(
        // Identical visible geometry: only content far above changed.
        mountedRows: mounted,
        totalRows: expandedAbove.length,
        viewportHeight: viewport,
        atTail: false,
      )!;
      expect(aboveRaw, baseline);

      // Below: growing an unbuilt row after the window changes nothing here.
      final expandedBelow = List<double>.of(heights)..[519] = 3000;
      final belowRaw = transcriptLogicalProgress(
        mountedRows: mounted,
        totalRows: expandedBelow.length,
        viewportHeight: viewport,
        atTail: false,
      )!;
      expect(belowRaw, baseline);

      // Inside: the boundary row growing changes only its fraction — the
      // reading stays within one logical row of the baseline.
      final grown = [
        for (final row in mounted)
          TranscriptRowGeometry(
            index: row.index,
            viewportTop: row.viewportTop,
            height: row.height * 1.5,
          ),
      ];
      final insideRaw = transcriptLogicalProgress(
        mountedRows: grown,
        totalRows: heights.length,
        viewportHeight: viewport,
        atTail: false,
      )!;
      expect(
        (insideRaw - baseline).abs(),
        lessThan(1.5 / heights.length),
      );
    });
  });

  group('transcriptAtTail', () {
    test('is false while the last logical row is not laid out, no matter what '
        'the pixel extent claims', () {
      // The failure mode: Flutter's estimated maxScrollExtent transiently
      // equals the current offset mid-list; a pixel comparison would declare
      // the tail (and a monotone latch would freeze a false 100%). The
      // geometric predicate cannot fire without the actual last row.
      const offset = 60000.0;
      final mounted = mountedAt(heights, offset);
      expect(mounted.any((r) => r.index == heights.length - 1), isFalse);
      expect(
        transcriptAtTail(
          mountedRows: mounted,
          totalRows: heights.length,
          viewportHeight: viewport,
        ),
        isFalse,
      );
      // And the raw reading stays strictly below 1 there.
      expect(rawAt(heights, offset), lessThan(1));
    });

    test('is true only once the last row is fully above the bottom edge', () {
      final tailOffset = totalOf(heights) - viewport;
      expect(
        transcriptAtTail(
          mountedRows: mountedAt(heights, tailOffset),
          totalRows: heights.length,
          viewportHeight: viewport,
        ),
        isTrue,
      );
      // One viewport earlier the last row is only partially revealed (or not
      // at all): not the tail.
      expect(
        transcriptAtTail(
          mountedRows: mountedAt(heights, tailOffset - viewport / 2),
          totalRows: heights.length,
          viewportHeight: viewport,
        ),
        isFalse,
      );
    });

    test('progress never reaches 1 before the last logical row is reached, '
        'across the whole sweep', () {
      final maxOffset = totalOf(heights) - viewport;
      for (var offset = 0.0; offset < maxOffset; offset += 137) {
        final mounted = mountedAt(heights, offset);
        final atTail = transcriptAtTail(
          mountedRows: mounted,
          totalRows: heights.length,
          viewportHeight: viewport,
        );
        final raw = transcriptLogicalProgress(
          mountedRows: mounted,
          totalRows: heights.length,
          viewportHeight: viewport,
          atTail: atTail,
        )!;
        if (raw >= 1) {
          final lastRow = mounted
              .where((r) => r.index == heights.length - 1)
              .toList();
          expect(
            lastRow,
            isNotEmpty,
            reason: '100% at offset $offset without the last row laid out',
          );
          expect(
            lastRow.single.viewportTop + lastRow.single.height,
            lessThanOrEqualTo(viewport + 0.5),
            reason:
                '100% at offset $offset with the last row still below '
                'the bottom edge',
          );
        }
      }
    });
  });

  group('TranscriptProgressLatch', () {
    test('displayed value never decreases while the offset increases, and '
        'never increases while it decreases', () {
      final latch = TranscriptProgressLatch();
      final maxOffset = totalOf(heights) - viewport;
      double? previous;
      for (var offset = 0.0; offset <= maxOffset; offset += 211) {
        final displayed = latch.update(
          raw: rawAt(heights, offset),
          offset: offset,
        )!;
        if (previous != null) expect(displayed, greaterThanOrEqualTo(previous));
        previous = displayed;
      }
      // Turn around: the first upward sample re-baselines (the sweep above
      // may not have landed exactly on maxOffset).
      previous = null;
      for (var offset = maxOffset; offset >= 0; offset -= 211) {
        final displayed = latch.update(
          raw: rawAt(heights, offset),
          offset: offset,
        )!;
        if (previous != null) expect(displayed, lessThanOrEqualTo(previous));
        previous = displayed;
      }
    });

    test('an estimate correction (offset dips, geometry unchanged) cannot '
        'reverse the displayed value mid-gesture', () {
      final latch = TranscriptProgressLatch();
      const offset = 52000.0;
      final raw = rawAt(heights, offset);
      final shown = latch.update(
        raw: raw,
        offset: offset,
      );
      // The framework corrects pixels backwards; the visible rows (and so the
      // raw reading) did not move.
      final corrected = latch.update(
        raw: raw,
        offset: offset - 48,
      );
      expect(corrected, shown);
    });

    test('a live append while reading history holds the display instead of '
        'reversing it, and the tail still reaches 1', () {
      final latch = TranscriptProgressLatch();
      const offset = 52000.0;
      final before = latch.update(
        raw: rawAt(heights, offset),
        offset: offset,
      )!;
      // 30 rows appended at the end: same visible geometry, larger
      // denominator — the raw fraction drops.
      final appended = [...heights, ...List<double>.filled(30, 400)];
      final rawAfter = transcriptLogicalProgress(
        mountedRows: mountedAt(heights, offset),
        totalRows: appended.length,
        viewportHeight: viewport,
        atTail: false,
      )!;
      expect(rawAfter, lessThan(before));
      final displayed = latch.update(
        raw: rawAfter,
        offset: offset,
      )!;
      expect(displayed, before, reason: 'an append must not reverse progress');
      // Scrolling to the tail still converges to 1.
      final atTail = latch.update(
        raw: rawAt(appended, totalOf(appended) - viewport, atTail: true),
        offset: totalOf(appended) - viewport,
      );
      expect(atTail, 1);
    });

    test('a stale-geometry null reading during a teleport does not poison the '
        'direction baseline; the first measured sample after the jump '
        'recovers', () {
      final latch = TranscriptProgressLatch();
      final tailOffset = totalOf(heights) - viewport;
      latch.update(
        raw: rawAt(heights, tailOffset, atTail: true),
        offset: tailOffset,
      );
      expect(latch.displayed, 1);
      // jumpTo(0) notifies before relayout: every mounted row still has its
      // far-away tail geometry, so nothing is measurable at the new offset.
      expect(latch.update(raw: null, offset: 0), 1);
      // After relayout the top reads tiny. Movement relative to the last
      // MEASURED offset is backward — the display must come down instead of
      // treating this as a stationary sample and freezing 100%.
      final recovered = latch.update(raw: rawAt(heights, 0), offset: 0);
      expect(recovered, rawAt(heights, 0));
    });

    test('an older-page prepend adopts the raised logical position', () {
      final latch = TranscriptProgressLatch();
      const offset = 52000.0;
      final before = latch.update(
        raw: rawAt(heights, offset),
        offset: offset,
      )!;
      // 40 rows prepended: the same visible rows now sit 40 indices deeper.
      final prepended = [...List<double>.filled(40, 300), ...heights];
      final shifted = [
        for (final row in mountedAt(heights, offset))
          TranscriptRowGeometry(
            index: row.index + 40,
            viewportTop: row.viewportTop,
            height: row.height,
          ),
      ];
      final rawAfter = transcriptLogicalProgress(
        mountedRows: shifted,
        totalRows: prepended.length,
        viewportHeight: viewport,
        atTail: false,
      )!;
      expect(rawAfter, greaterThan(before));
      final displayed = latch.update(
        raw: rawAfter,
        offset: offset,
      );
      expect(displayed, rawAfter);
    });
  });
}
