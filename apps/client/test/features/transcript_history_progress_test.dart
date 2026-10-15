// F03b: the scrollbar's reading of a long session. It is derived from the
// reader's logical place among the rows, not from the extent the lazy list
// estimates, so it never runs backwards while they re-estimate, and it reads
// 100% only once the last row is really there.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/app_driver.dart';
import '../support/feature/cosyncing_app.dart';
import '../support/feature/transcript_reader.dart';
import '../support/feature/transcript_wire.dart';

final Finder _thumb = find.byKey(
  const Key('session-transcript-scrollbar-thumb'),
);

/// The displayed logical scrollbar position (`0` = top, `1` = bottom).
double? displayedProgress(WidgetTester tester) {
  if (_thumb.evaluate().isEmpty) return null;
  final alignment = tester
      .widget<Align>(_thumb)
      .alignment
      .resolve(TextDirection.ltr);
  return (alignment.y + 1) / 2;
}

/// A mixed-height transcript of [turns] turns and a short sentinel turn at the
/// very end: a findable witness that the last rows were really built whenever
/// the indicator reads 100%.
List<Map<String, Object?>> mixedTranscript({int turns = 60}) {
  String paragraph(int p) =>
      'Paragraph $p with a long wrapped explanation of what the agent did '
      'and why it matters, plus `inline code` and continued prose to make '
      'the row genuinely tall.';
  final longAnswer = [for (var p = 0; p < 6; p++) paragraph(p)].join('\n\n');
  return [
    for (var i = 0; i < turns; i++) ...[
      userRow('User ask $i', key: 'u$i'),
      answerRow('Answer $i.\n\n$longAnswer', key: 'm$i'),
      toolCallRow(
        'c$i',
        toolClass: 'edit',
        toolName: 'edit',
        extra: {
          'arguments': {'path': 'lib/a.dart'},
        },
      ),
      toolResultRow(
        'c$i',
        toolClass: 'edit',
        toolName: 'edit',
        extra: {
          'path': 'lib/a.dart',
          'diff':
              '--- a/lib/a.dart\n+++ b/lib/a.dart\n@@ -1,3 +1,4 @@\n'
              ' keep\n-old\n+new\n+extra\n',
          'additions': 2,
          'deletions': 1,
        },
      ),
      runSummaryRow('t$i', key: 'run$i', totalRuntimeMs: 4000),
    ],
    userRow('Tail sentinel ask', key: 'u-tail'),
    answerRow('Tail sentinel done.', key: 'm-tail'),
  ];
}

typedef _Frame = ({
  double pixels,
  double maxExtent,
  double? displayed,
  bool tailRowBuilt,
});

_Frame _capture(AppDriver app) => (
  pixels: app.position.pixels,
  maxExtent: app.position.maxScrollExtent,
  displayed: displayedProgress(app.tester),
  tailRowBuilt: app.shown('Tail sentinel ask') > 0,
);

/// Sweeps downward to the LIVE tail: the estimated extent grows while rows
/// build, so the target is re-read every step.
Future<List<_Frame>> _sweepToTail(AppDriver app, {double step = 519}) async {
  final frames = <_Frame>[];
  for (var guard = 0; guard < 2000; guard++) {
    final position = app.position;
    if (position.pixels >= position.maxScrollExtent) break;
    position.jumpTo(
      (position.pixels + step).clamp(0.0, position.maxScrollExtent),
    );
    await app.tester.pump();
    frames.add(_capture(app));
  }
  // The extent keeps re-estimating as trailing rows build; settle onto the
  // final tail so the last frame is genuinely at the end.
  for (var guard = 0; guard < 20; guard++) {
    final position = app.position;
    if (position.pixels >= position.maxScrollExtent) break;
    position.jumpTo(position.maxScrollExtent);
    await app.tester.pump();
  }
  // The indicator re-reads once when its activity fade elapses.
  await app.tester.pump(const Duration(seconds: 2));
  frames.add(_capture(app));
  return frames;
}

Future<List<_Frame>> _sweepUp(AppDriver app, {double step = 519}) async {
  final frames = <_Frame>[];
  for (var guard = 0; guard < 600; guard++) {
    final position = app.position;
    if (position.pixels <= 0) break;
    position.jumpTo((position.pixels - step).clamp(0.0, double.infinity));
    await app.tester.pump();
    frames.add(_capture(app));
  }
  return frames;
}

/// The displayed value may read 100% ONLY in frames where the last turn's
/// content was actually built.
void _expectNoPrematureEnd(List<_Frame> frames) {
  for (final frame in frames) {
    final displayed = frame.displayed;
    if (displayed == null || displayed < 1.0 - 1e-9) continue;
    expect(
      frame.tailRowBuilt,
      isTrue,
      reason:
          'displayed 100% at pixels=${frame.pixels} (max=${frame.maxExtent}) '
          'before the last logical rows were built',
    );
  }
}

void _expectMonotone(List<_Frame> frames, {required bool increasing}) {
  double? previous;
  for (final frame in frames) {
    final displayed = frame.displayed;
    if (displayed == null) continue;
    if (previous != null) {
      expect(
        increasing
            ? displayed >= previous - 1e-9
            : displayed <= previous + 1e-9,
        isTrue,
        reason:
            'displayed progress reversed at pixels=${frame.pixels}: '
            '$previous -> $displayed',
      );
    }
    previous = displayed;
  }
  expect(previous, isNotNull, reason: 'the indicator never produced a value');
}

void main() {
  featureTest('the reading is monotone through a long sweep down and back up, '
      'and reads the end only at the tail', (f) async {
    final (app, _) = await launchWithTranscript(f, mixedTranscript());
    await app.go('/sessions/codex/s1');
    // Lazy construction: rows far from the tail are not built.
    expect(app.shown('User ask 3'), 0);

    app.position.jumpTo(0);
    await app.settle();
    final down = await _sweepToTail(app);
    _expectMonotone(down, increasing: true);
    _expectNoPrematureEnd(down);
    // The native source really is unstable on this fixture: the estimated
    // extent changed as unbuilt rows entered layout, so a thumb driven by
    // pixels / maxScrollExtent could not have been monotone.
    expect(
      down.map((frame) => frame.maxExtent).toSet().length,
      greaterThan(1),
      reason: 'expected lazy extent estimates to correct during the sweep',
    );
    expect(down.last.displayed, 1.0);

    final up = await _sweepUp(app);
    _expectMonotone(up, increasing: false);
  });

  featureTest('a live append and an older page landing never run the reading '
      'backwards, and following the tail converges back to 1', (f) async {
    final (app, broker) = await openPaging(f);
    final position = app.position;
    position.jumpTo(position.maxScrollExtent / 2);
    await app.settle();
    final before = displayedProgress(f.tester);
    expect(before, isNotNull);

    for (var i = 0; i < 10; i++) {
      broker.append(markedRow(2000 + i));
    }
    await app.settle();
    expect(
      displayedProgress(f.tester),
      greaterThanOrEqualTo(before! - 1e-9),
      reason: 'a live append must not reverse the reading position',
    );

    await app.placeBelowStart(0.5);
    await app.frames(3);
    final atTop = displayedProgress(f.tester);
    await app.wheel(-40);
    await app.frames(10);
    expect(broker.older, hasLength(1), reason: 'the older page landed');
    expect(
      displayedProgress(f.tester),
      greaterThanOrEqualTo(atTop! - 1e-9),
      reason: 'rows prepended above the reader must not reverse the reading',
    );

    await app.jumpToEnd();
    expect(displayedProgress(f.tester), 1.0);
  });
}
