import 'package:broker_contract/broker_contract.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

/// N2-D widget proof: the transcript's right-edge thumb position is derived
/// from stable logical row position and stays monotone through real gestures,
/// while the native `pixels / maxScrollExtent` source it replaced is shown to
/// be unstable on the same fixture.
///
/// The fixture is an immutable 130-turn (~520 row) mixed-height transcript:
/// short user bubbles, long Markdown answers, tool cards with expandable
/// diffs, and completed-turn footers.
List<WireEvent> _mixedTranscript({int turns = 130}) {
  String paragraph(int p) =>
      'Paragraph $p with a long wrapped explanation of what the agent did '
      'and why it matters, plus `inline code` and continued prose to make '
      'the row genuinely tall.';
  final longAnswer = [for (var p = 0; p < 6; p++) paragraph(p)].join('\n\n');
  const diff =
      '--- a/lib/a.dart\n+++ b/lib/a.dart\n@@ -1,3 +1,4 @@\n'
      ' keep\n-old\n+new\n+extra\n';
  return [
    HistoryWireEvent(
      reset: true,
      messages: [
        for (var i = 0; i < turns; i++) ...[
          AgentMessage.fromJson({
            'type': 'user-message',
            'key': 'u$i',
            'text': 'User ask $i',
          }),
          AgentMessage.fromJson({
            'type': 'model-output',
            'key': 'm$i',
            'text': 'Answer $i.\n\n$longAnswer',
            'final': true,
          }),
          AgentMessage.fromJson({
            'type': 'tool-call',
            'callId': 'c$i',
            'name': 'edit',
            'toolClass': 'edit',
            'arguments': {'path': 'lib/a.dart'},
          }),
          AgentMessage.fromJson({
            'type': 'tool-result',
            'callId': 'c$i',
            'name': 'edit',
            'toolClass': 'edit',
            'path': 'lib/a.dart',
            'diff': diff,
            'additions': 2,
            'deletions': 1,
          }),
          AgentMessage.fromJson({
            'type': 'run-summary',
            'key': 'run$i',
            'status': 'done',
            'totalRuntimeMs': 4000,
            'assistantMessageKey': 'm$i',
            'userMessageKey': 'u$i',
          }),
        ],
        // A short sentinel turn at the very end: a findable witness that the
        // LAST rows were genuinely built whenever the indicator reads 100%
        // (tall final turns overflow the viewport, so their own user bubble
        // is not a reliable tail witness).
        AgentMessage.fromJson({
          'type': 'user-message',
          'key': 'u-tail',
          'text': 'Tail sentinel ask',
        }),
        AgentMessage.fromJson({
          'type': 'model-output',
          'key': 'm-tail',
          'text': 'Tail sentinel done.',
          'final': true,
        }),
      ],
    ),
  ];
}

ScrollPosition _position(WidgetTester tester) {
  final scrollable = tester.widget<Scrollable>(
    find
        .descendant(
          of: find.byKey(const Key('session-detail-chat-scroll')),
          matching: find.byType(Scrollable),
        )
        .first,
  );
  return scrollable.controller!.position;
}

/// The displayed logical scrollbar position, read from its top-to-bottom
/// alignment (`0` = top, `1` = bottom).
double? _displayedProgress(WidgetTester tester) {
  final thumb = find.byKey(
    const Key('session-transcript-scrollbar-thumb'),
  );
  if (thumb.evaluate().isEmpty) return null;
  final alignment = tester
      .widget<Align>(thumb)
      .alignment
      .resolve(TextDirection.ltr);
  return (alignment.y + 1) / 2;
}

/// One captured frame of the regression trace. `tailRowBuilt` records whether
/// the LAST turn's content existed in the element tree at capture time — the
/// witness that a 100% reading was truthful.
typedef _Frame = ({
  double pixels,
  double maxExtent,
  double? displayed,
  bool tailRowBuilt,
});

_Frame _captureFrame(WidgetTester tester, String tailMarker) {
  final position = _position(tester);
  return (
    pixels: position.pixels,
    maxExtent: position.maxScrollExtent,
    displayed: _displayedProgress(tester),
    tailRowBuilt: tester.any(find.text(tailMarker)),
  );
}

/// Sweeps downward to the LIVE tail: the estimated extent grows while rows
/// build, so the target is re-read every step.
Future<List<_Frame>> _sweepToTail(
  WidgetTester tester, {
  double step = 519,
  String tailMarker = 'Tail sentinel ask',
}) async {
  final frames = <_Frame>[];
  for (var guard = 0; guard < 2000; guard++) {
    final position = _position(tester);
    if (position.pixels >= position.maxScrollExtent) break;
    position.jumpTo(
      (position.pixels + step).clamp(0.0, position.maxScrollExtent),
    );
    await tester.pump();
    frames.add(_captureFrame(tester, tailMarker));
  }
  // The extent keeps re-estimating as trailing rows build; settle onto the
  // final tail so the last frame is genuinely at the end.
  for (var guard = 0; guard < 20; guard++) {
    final position = _position(tester);
    if (position.pixels >= position.maxScrollExtent) break;
    position.jumpTo(position.maxScrollExtent);
    await tester.pump();
  }
  // A trailing estimate can correct after the very last notification; the
  // indicator re-reads once when its activity fade elapses.
  await tester.pump(const Duration(seconds: 2));
  frames.add(_captureFrame(tester, tailMarker));
  return frames;
}

Future<List<_Frame>> _sweepUp(
  WidgetTester tester, {
  double step = 519,
  String tailMarker = 'Tail sentinel ask',
}) async {
  final frames = <_Frame>[];
  for (var guard = 0; guard < 600; guard++) {
    final position = _position(tester);
    if (position.pixels <= 0) break;
    position.jumpTo((position.pixels - step).clamp(0.0, double.infinity));
    await tester.pump();
    frames.add(_captureFrame(tester, tailMarker));
  }
  return frames;
}

/// The displayed value may read 100% ONLY in frames where the last turn's
/// content was actually built — a pixel-extent shortcut latching 1.0 mid-list
/// fails here.
void _expectNoPrematureEnd(List<_Frame> frames) {
  for (final frame in frames) {
    final displayed = frame.displayed;
    if (displayed == null || displayed < 1.0 - 1e-9) continue;
    expect(
      frame.tailRowBuilt,
      isTrue,
      reason:
          'displayed 100% at pixels=${frame.pixels} '
          '(max=${frame.maxExtent}) before the last logical rows were built',
    );
  }
}

void _expectMonotone(List<_Frame> frames, {required bool increasing}) {
  double? previous;
  for (final frame in frames) {
    final displayed = frame.displayed;
    if (displayed == null) continue;
    if (previous != null) {
      if (increasing) {
        expect(
          displayed,
          greaterThanOrEqualTo(previous - 1e-9),
          reason: 'displayed progress reversed at pixels=${frame.pixels}',
        );
      } else {
        expect(
          displayed,
          lessThanOrEqualTo(previous + 1e-9),
          reason: 'displayed progress reversed at pixels=${frame.pixels}',
        );
      }
    }
    previous = displayed;
  }
  expect(previous, isNotNull, reason: 'the indicator never produced a value');
}

void main() {
  group('SessionDetailPage transcript logical progress', () {
    testWidgets(
      'displayed progress is monotone through a long downward gesture while '
      'the native estimated extent is demonstrably unstable, and reaches the '
      'end at the tail',
      (tester) async {
        useRoomyTestViewport(tester);
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: _mixedTranscript()),
        );
        await tester.pumpAndSettle();

        // Lazy construction: rows far from the tail are not built.
        expect(find.text('User ask 3'), findsNothing);

        _position(tester).jumpTo(0);
        await tester.pumpAndSettle();
        final frames = await _sweepToTail(tester);

        _expectMonotone(frames, increasing: true);
        _expectNoPrematureEnd(frames);
        // The native source really is unstable on this fixture: the estimated
        // extent changed as unbuilt rows entered layout, so a thumb driven by
        // pixels/maxScrollExtent could not have been monotone.
        final extents = frames.map((f) => f.maxExtent).toSet();
        expect(
          extents.length,
          greaterThan(1),
          reason: 'expected lazy extent estimates to correct during the sweep',
        );
        expect(frames.last.displayed, 1.0);
      },
    );

    testWidgets(
      'one jump to the estimated pixel tail never reads 100% before the last '
      'logical row is actually reached, and settling converges to exactly 1',
      (tester) async {
        useRoomyTestViewport(tester);
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: _mixedTranscript()),
        );
        await tester.pumpAndSettle();
        _position(tester).jumpTo(0);
        await tester.pumpAndSettle();

        // The reviewer scenario: the offset lands ON the (still-estimated)
        // maxScrollExtent while trailing rows are unbuilt. A pixel-derived
        // at-tail check reads 1.0 here and the monotone latch would then
        // refuse to come back down once the extent expands.
        final position = _position(tester);
        position.jumpTo(position.maxScrollExtent);
        await tester.pump();
        final jumped = _captureFrame(tester, 'Tail sentinel ask');
        if (!jumped.tailRowBuilt) {
          expect(
            jumped.displayed,
            anyOf(isNull, lessThan(1.0)),
            reason:
                'read 100% at pixels=${jumped.pixels} while the last '
                'turn was not built',
          );
        }

        final frames = await _sweepToTail(tester);
        _expectMonotone([jumped, ...frames], increasing: true);
        _expectNoPrematureEnd([jumped, ...frames]);
        expect(frames.last.displayed, 1.0);
        expect(frames.last.tailRowBuilt, isTrue);
      },
    );

    testWidgets('displayed progress is inversely monotone scrolling up', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: _mixedTranscript()),
      );
      await tester.pumpAndSettle();

      final frames = await _sweepUp(tester);
      _expectMonotone(frames, increasing: false);
    });

    testWidgets(
      'a live append while reading history never reverses the displayed '
      'progress, and following the tail converges back to 1',
      (tester) async {
        useRoomyTestViewport(tester);
        final connection = ScriptedSessionDetailConnection(
          events: _mixedTranscript(),
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        final position = _position(tester);
        position.jumpTo(position.maxScrollExtent / 2);
        await tester.pumpAndSettle();
        final before = _displayedProgress(tester);
        expect(before, isNotNull);

        for (var i = 0; i < 10; i++) {
          connection.emitEvent(
            MessageWireEvent(
              seq: 1000 + i,
              message: AgentMessage.fromJson({
                'type': 'model-output',
                'key': 'late$i',
                'text': 'Late streamed output $i',
              }),
            ),
          );
        }
        await tester.pumpAndSettle();
        expect(
          _displayedProgress(tester),
          greaterThanOrEqualTo(before! - 1e-9),
          reason: 'a live append must not reverse the reading position',
        );

        _position(tester).jumpTo(_position(tester).maxScrollExtent);
        await tester.pumpAndSettle();
        expect(_displayedProgress(tester), 1.0);
      },
    );

    testWidgets(
      'an older-page prepend never reverses the displayed progress',
      (tester) async {
        useRoomyTestViewport(tester);
        final connection = ScriptedSessionDetailConnection(
          events: _mixedTranscript(),
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        final position = _position(tester);
        position.jumpTo(position.maxScrollExtent / 2);
        await tester.pumpAndSettle();
        final before = _displayedProgress(tester);
        expect(before, isNotNull);

        connection.emitEvent(
          HistoryPageWireEvent(
            messages: [
              for (var i = 0; i < 40; i++)
                AgentMessage.fromJson({
                  'type': 'model-output',
                  'key': 'older$i',
                  'text': 'Older prepended output $i',
                }),
            ],
            hasMore: false,
            endOfHistory: true,
          ),
        );
        await tester.pumpAndSettle();
        expect(
          _displayedProgress(tester),
          greaterThanOrEqualTo(before! - 1e-9),
        );
      },
    );

    testWidgets(
      'expanding a tool card inside the viewport moves the reading only '
      'marginally and keeps later scrolling monotone',
      (tester) async {
        useRoomyTestViewport(tester);
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: _mixedTranscript()),
        );
        await tester.pumpAndSettle();

        final position = _position(tester);
        position.jumpTo(position.maxScrollExtent / 2);
        await tester.pumpAndSettle();
        final before = _displayedProgress(tester);
        expect(before, isNotNull);

        final details = find.byWidgetPredicate(
          (widget) =>
              widget.key != null &&
              widget.key.toString().contains('tool-c') &&
              widget.key.toString().contains('-details'),
        );
        expect(details, findsWidgets);
        await tester.tap(details.first);
        await tester.pumpAndSettle();

        final after = _displayedProgress(tester);
        expect(after, isNotNull);
        expect(
          (after! - before!).abs(),
          lessThan(0.05),
          reason: 'an in-viewport expansion re-measures only the boundary row',
        );

        final frames = await _sweepToTail(tester);
        _expectMonotone(frames, increasing: true);
        _expectNoPrematureEnd(frames);
      },
    );

    testWidgets(
      'the compact touch layout keeps the same monotone passive indicator',
      (tester) async {
        addTearDown(() {
          tester.view.resetPhysicalSize();
          tester.view.resetDevicePixelRatio();
        });
        tester.view
          ..physicalSize = const Size(400, 800)
          ..devicePixelRatio = 1;
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: _mixedTranscript(turns: 60)),
        );
        await tester.pumpAndSettle();

        _position(tester).jumpTo(0);
        await tester.pumpAndSettle();
        final frames = await _sweepToTail(tester);
        _expectMonotone(frames, increasing: true);
        _expectNoPrematureEnd(frames);
        expect(frames.last.displayed, 1.0);
        // Passive affordance only: nothing interactive was added over the
        // transcript's touch surface.
        expect(
          find.byKey(const Key('session-transcript-scrollbar')),
          findsOneWidget,
        );
      },
    );

    testWidgets('the logical indicator is vertical on the right edge', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: _mixedTranscript(turns: 30)),
      );
      await tester.pumpAndSettle();

      _position(tester).jumpTo(_position(tester).maxScrollExtent / 2);
      await tester.pump();

      final scroll = find.byKey(const Key('session-detail-chat-scroll'));
      final indicator = find.byKey(
        const Key('session-transcript-scrollbar'),
      );
      final indicatorSize = tester.getSize(indicator);
      expect(indicatorSize.height, greaterThan(indicatorSize.width));
      expect(
        tester.getTopRight(indicator).dx,
        closeTo(tester.getTopRight(scroll).dx, 0.1),
      );
    });
  });
}
