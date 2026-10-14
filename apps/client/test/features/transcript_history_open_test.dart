// F03b: opening a long session and following it. The session lands on the
// newest row without corrective motion, a following reader stays on the tail
// through a whole turn, a reading reader is never pulled down, and the
// scrollbar's reading never runs backwards.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/cosyncing_app.dart';
import '../support/feature/fake_broker.dart';
import '../support/feature/transcript_reader.dart';
import '../support/feature/transcript_wire.dart';

List<Map<String, Object?>> prompts(int count, {int from = 1}) => [
  for (var i = from; i < from + count; i++) userRow('Message $i', key: 'u$i'),
];

void main() {
  group('opening a session settles on the newest row', () {
    for (final (name, viewport) in [
      ('on a desktop', FeatureViewport.desktop),
      ('on a phone', FeatureViewport.phone),
    ]) {
      featureTest('a long transcript $name', (f) async {
        final (app, _) = await launchWithTranscript(
          f,
          prompts(240),
          viewport: viewport,
        );
        await expectTailReveal(
          app,
          anyRow: find.textContaining('Message '),
          newestRow: find.textContaining('Message 240'),
        );
      });
    }

    featureTest('a transcript the device already holds, replaced by the '
        "broker's authoritative history", (f) async {
      final (first, studio) = await launchWithTranscript(f, prompts(240));
      await first.go('/sessions/codex/s1');
      expect(first.shown('Message 240'), greaterThan(0));
      await first.elapse(const Duration(seconds: 5));
      await f.quit();

      // The authoritative window is shorter than the cache and extends it,
      // and arrives only after the cached rows are on screen.
      studio.transcripts['s1'] = prompts(110, from: 141);
      studio.transcripts['s1'] = [
        ...studio.transcripts['s1']!,
        ...prompts(10, from: 251),
      ];
      final held = <Map<String, Object?>>[];
      studio.attachFrames = (socket, session) => [
        studio.helloFrame(),
        {
          'kind': 'session',
          'info': {...session, 'control': FakeBroker.drivingControl},
        },
      ];
      final app = await f.restart();
      await expectTailReveal(
        app,
        anyRow: find.textContaining('Message '),
        newestRow: find.textContaining('Message 260'),
        newestAt: (frame) =>
            find.textContaining(frame < 7 ? 'Message 240' : 'Message 260'),
        atFrame: (frame) async {
          if (frame != 6) return;
          expect(
            app.shown('Message 240'),
            greaterThan(0),
            reason: 'the saved rows are on screen before the broker answers',
          );
          held.add({
            'kind': 'history',
            'messages': studio.transcripts['s1'],
            'reset': true,
            'cursor': 'tail-cursor',
          });
          app.socket(studio).emit(held.single);
        },
      );
    });

    featureTest('long rows of different heights', (f) async {
      final (app, _) = await launchWithTranscript(f, [
        for (var index = 1; index <= 120; index++)
          answerRow(
            '## Plan $index\n\n'
            '${'Variable row $index wraps. ' * (index % 5 + 1)}'
            '\n```dart\n${'code $index\n' * (index % 4)}```',
            key: 'md-$index',
          ),
      ]);
      await expectTailReveal(
        app,
        anyRow: find.textContaining('Variable row '),
        newestRow: find.textContaining('Plan 120'),
      );
    });

    featureTest('a tool-heavy transcript keeps its expansion working', (
      f,
    ) async {
      final (app, _) = await launchWithTranscript(f, [
        for (var index = 1; index <= 40; index++) ...[
          userRow('Message $index', key: 'p$index'),
          toolCallRow(
            'call-$index',
            toolClass: 'search',
            toolName: 'search-files',
            extra: {
              'arguments': {'query': 'q$index'},
            },
          ),
          toolResultRow(
            'call-$index',
            toolClass: 'search',
            toolName: 'search-files',
            extra: {'output': 'found $index'},
          ),
        ],
        userRow('Final message', key: 'final'),
      ]);
      await expectTailReveal(
        app,
        anyRow: find.textContaining('Message '),
        newestRow: find.textContaining('Final message'),
      );
      await app.toggleTool('call-40');
      expect(app.shown('q40'), greaterThan(0));
    });

    featureTest('with live rows already arriving behind the history', (
      f,
    ) async {
      final (app, _) = await launchWithTranscript(
        f,
        prompts(120),
        setup: (studio) => attachWithLive(studio, [
          for (var i = 1; i <= 20; i++) userRow('Live $i', key: 'live-$i'),
        ]),
      );
      await expectTailReveal(
        app,
        anyRow: find.textContaining(RegExp('Message |Live ')),
        newestRow: find.textContaining('Live 20'),
      );
    });

    featureTest('moving from one session to another settles on the new '
        'tail', (f) async {
      final (app, studio) = await launchWithTranscript(f, prompts(120));
      await expectTailReveal(
        app,
        anyRow: find.textContaining('Message '),
        newestRow: find.textContaining('Message 120'),
      );
      studio
        ..addSession('s2', 'Second', cwd: '/work/studio')
        ..transcripts['s2'] = [
          for (var i = 1; i <= 180; i++) userRow('Second $i', key: 'v$i'),
        ];
      await app.go('/sessions');
      await expectTailReveal(
        app,
        id: 's2',
        anyRow: find.textContaining('Second '),
        newestRow: find.textContaining('Second 180'),
      );
    });

    featureTest('with large text', (f) async {
      final (app, _) = await launchWithTranscript(
        f,
        prompts(120),
        textScale: 1.3,
      );
      await expectTailReveal(
        app,
        anyRow: find.textContaining('Message '),
        newestRow: find.textContaining('Message 120'),
      );
      expect(f.tester.takeException(), isNull);
    });
  });

  group('following and reading', () {
    for (final focused in [false, true]) {
      final label = focused ? 'focused' : 'unfocused';
      featureTest('a following reader stays on the real last row through a '
          'whole turn, composer $label', (f) async {
        final (app, studio) = await launchWithTranscript(f, prompts(60));
        await app.go('/sessions/codex/s1');
        if (focused) {
          // A focused composer grows and takes height from the transcript.
          await app.tapKey('session-detail-prompt-input');
          await app.enterText(
            find.byKey(const Key('session-detail-prompt-input')),
            'a draft the user is typing while the answer streams in',
          );
        }
        final steps = <Map<String, Object?>>[
          userRow('Frame trace prompt', key: 'frame-prompt'),
          answerDelta(
            'Streaming answer that is long enough to change the row height '
                'when it grows.',
            'frame-answer',
          ),
          answerDelta(
            ' And a second streamed chunk, longer still, to force another '
                'height change at the tail.',
            'frame-answer',
          ),
          // A row that changes height in place is the case a post-frame chase
          // cannot get right: the extent it chased was measured before the
          // reflow.
          toolResultRow(
            'frame-tool',
            toolClass: 'terminal',
            extra: {'result': 'one line of terminal output'},
          ),
          toolResultRow(
            'frame-tool',
            toolClass: 'terminal',
            extra: {
              'result': List<String>.generate(
                24,
                (line) =>
                    'terminal output line $line with enough text to wrap at '
                    'the desktop test width',
              ).join('\n'),
            },
          ),
          answerRow(
            'Streaming answer that is long enough to change the row height '
            'when it grows. And a second streamed chunk, longer still, to '
            'force another height change at the tail.',
            key: 'frame-answer',
          ),
          runSummaryRow('frame-turn', key: 'frame-run'),
          row('status', {'status': 'idle'}),
        ];
        // A corrective scroll is observable; a layout-phase correction is not.
        // `jumpTo` notifies (the superseded post-frame chase, which runs after
        // the frame the user already saw); the tail physics' own correction
        // during layout is silent. Zero notifications while following is
        // exactly "no frame was painted off the tail and walked back".
        final tracked = app.position;
        var correctiveScrolls = 0;
        void countScroll() => correctiveScrolls++;
        tracked.addListener(countScroll);
        addTearDown(() => tracked.removeListener(countScroll));

        expectTailRowVisible(f.tester, reason: 'before the turn starts');
        var seq = 900;
        for (final step in steps) {
          app.socket(studio).emit({
            'kind': 'message',
            'seq': ++seq,
            'message': step,
          });
          // Exactly one frame per mutation.
          await app.flushRealAsync();
          await f.tester.pump();
          expect(
            identical(app.position, tracked),
            isTrue,
            reason: 'the viewport must not be remounted by ordinary growth',
          );
          expect(
            app.position.pixels,
            closeTo(app.position.maxScrollExtent, 1),
            reason: 'a following viewport stays settled on the actual tail',
          );
          expectTailRowVisible(f.tester, reason: 'frame for seq $seq');
          expect(
            correctiveScrolls,
            0,
            reason:
                'growth must be absorbed during layout; a corrective scroll '
                'after the frame is the visible drop-then-reflect',
          );
        }
        await app.settle();
        expectTailRowVisible(f.tester, reason: 'after the turn settles');
        expect(
          find.byKey(const Key('session-history-jump-latest')),
          findsNothing,
          reason: 'the user never left the tail, so no catch-up affordance',
        );
      });
    }

    featureTest('a reader of earlier rows is not pulled down by new rows, '
        'and scrolling back to the end resumes following', (f) async {
      final (app, studio) = await launchWithTranscript(f, prompts(60));
      await app.go('/sessions/codex/s1');
      await app.jumpToStart();
      await app.settle();
      final top = app.position.minScrollExtent;
      expect(app.position.pixels, top);

      await app.liveAll(studio, [
        for (var i = 0; i < 10; i++) userRow('Late $i', key: 'late-$i'),
      ]);
      expect(
        app.position.pixels,
        top,
        reason: 'the user was reading history, so the view must stay put',
      );

      await app.jumpToEnd();
      await app.liveAll(studio, [
        for (var i = 0; i < 10; i++) userRow('Later $i', key: 'later-$i'),
      ]);
      expect(
        app.position.pixels,
        closeTo(app.position.maxScrollExtent, 1),
        reason: 'back at the end the transcript follows again',
      );
      expectTailRowVisible(f.tester, reason: 'after following resumed');
    });
  });
}
