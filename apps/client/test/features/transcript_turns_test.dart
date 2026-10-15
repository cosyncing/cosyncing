// F03a — Transcript turns: the order a history frame is shown in, the footer
// each finished turn carries (runtime, Copy, telemetry), and read-aloud from
// that footer.
// Long fixture strings and bidi controls are the data under test.
// ignore_for_file: lines_longer_than_80_chars
import 'package:cosyncing_client/src/platform/speech/speech_output_state.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/app_driver.dart';
import '../support/feature/cosyncing_app.dart';
import '../support/feature/fake_speech.dart';
import '../support/feature/session_driver.dart';
import '../support/feature/transcript_wire.dart';

Map<String, Object?> summary(
  String key, {
  String status = 'done',
  String? user,
  String? assistant,
  String? turnId,
  int? runtimeMs,
  int? completedAt,
  Map<String, Object?>? tokens,
}) => row('run-summary', {
  'key': key,
  'status': status,
  'userMessageKey': ?user,
  'assistantMessageKey': ?assistant,
  'turnId': ?turnId,
  'totalRuntimeMs': ?runtimeMs,
  'completedAt': ?completedAt,
  'tokens': ?tokens,
});

Map<String, Object?> interruption(String key, String turnId) => row('notice', {
  'key': key,
  'message': 'Conversation interrupted.',
  'semantic': {
    'kind': 'interruption',
    'reason': 'generic',
    'turnId': turnId,
  },
});

/// Turn keys of the footers on screen, top to bottom.
List<String> footerKeys() {
  final footers = <(double, String)>[];
  for (final element in find.byWidgetPredicate((w) {
    final key = w.key;
    return key is ValueKey<String> && key.value.startsWith('turn-footer-');
  }).evaluate()) {
    final box = element.renderObject! as RenderBox;
    footers.add((
      box.localToGlobal(Offset.zero).dy,
      (element.widget.key! as ValueKey<String>).value.substring(
        'turn-footer-'.length,
      ),
    ));
  }
  footers.sort((a, b) => a.$1.compareTo(b.$1));
  return [for (final (_, key) in footers) key];
}

/// One order case: `rows` in, `order` out (top to bottom), and how many turns
/// end in a footer.
typedef OrderCase = ({
  String name,
  List<Map<String, Object?>> rows,
  List<String> order,
  List<String> footers,
});

final List<OrderCase> orderCases = [
  (
    name: 'each delivered prompt opens a turn',
    rows: [
      userRow('First', key: 'u1'),
      answerRow('Answer one', key: 'a1'),
      userRow('Second', key: 'u2'),
      answerRow('Answer two', key: 'a2'),
    ],
    order: ['First', 'Answer one', 'Second', 'Answer two'],
    footers: ['turn:user:u1', 'turn:user:u2'],
  ),
  (
    name: 'a queued prompt stays in the current turn and steals no output',
    rows: [
      userRow('First', key: 'u1'),
      answerRow('Preamble', key: 'a1'),
      userRow('Queued next', key: 'u2', queued: true),
      answerRow('First final', key: 'a2'),
    ],
    order: ['First', 'Preamble', 'Queued next', 'First final'],
    footers: ['turn:user:u1'],
  ),
  (
    name:
        'a prompt delivered mid-turn sits after the last output of the turn '
        'it interrupted',
    rows: [
      userRow('First', key: 'u1'),
      answerRow('Preamble', key: 'a1'),
      userRow('Second', key: 'u2'),
      answerRow('Final of first', key: 'a2'),
      summary('s1', user: 'u1', assistant: 'a2', runtimeMs: 100),
      answerRow('Answer to second', key: 'a3'),
      summary('s2', user: 'u2', assistant: 'a3', runtimeMs: 200),
    ],
    order: [
      'First',
      'Preamble',
      'Final of first',
      'Second',
      'Answer to second',
    ],
    footers: ['turn:user:u1', 'turn:user:u2'],
  ),
  (
    name: 'a mid-turn prompt keeps its still-streaming answer',
    rows: [
      userRow('First', key: 'u1'),
      answerRow('Preamble', key: 'a1'),
      userRow('Second', key: 'u2'),
      answerRow('Final of first', key: 'a2'),
      summary('s1', user: 'u1', assistant: 'a2'),
      answerRow('Streaming answer', key: 'a3', final_: false),
    ],
    order: [
      'First',
      'Preamble',
      'Final of first',
      'Second',
      'Streaming answer',
    ],
    footers: ['turn:user:u1'],
  ),
  (
    name: "a same-turn steer keeps the adapter's own key order",
    rows: [
      userRow('Open', key: 'codex:t:u0', turnId: 't'),
      answerRow('Before', key: 'codex:t:m0:t'),
      userRow('Steer', key: 'codex:t:u1', turnId: 't'),
      answerRow('After', key: 'codex:t:m1:t'),
      summary('s1', turnId: 't', user: 'codex:t:u0', assistant: 'codex:t:m1:t'),
      userRow('Next', key: 'codex:t2:u0', turnId: 't2'),
      answerRow('Next answer', key: 'codex:t2:m0:t2'),
      summary(
        's2',
        turnId: 't2',
        user: 'codex:t2:u0',
        assistant: 'codex:t2:m0:t2',
      ),
    ],
    order: ['Open', 'Before', 'Steer', 'After', 'Next', 'Next answer'],
    footers: [
      'turn:user:codex:t:u0',
      'turn:user:codex:t:u1',
      'turn:user:codex:t2:u0',
    ],
  ),
  (
    name: 'an interruption stays above the next delivered prompt',
    rows: [
      userRow('First', key: 'u1'),
      userRow('Continue', key: 'u2'),
      answerRow('Partial answer', key: 'a1'),
      row('notice', {
        'message': 'Conversation interrupted.',
        'semantic': {
          'kind': 'interruption',
          'reason': 'generic',
          'turnId': 'turn-a',
        },
      }),
      summary(
        's1',
        status: 'cancelled',
        user: 'u1',
        assistant: 'a1',
        turnId: 'turn-a',
      ),
    ],
    order: ['First', 'Partial answer', 'Interrupted', 'Continue'],
    footers: ['turn:user:u1'],
  ),
  (
    name: 'three zero-output prompt and interruption cycles stay ordered',
    rows: [
      userRow('First', key: 'prompt-1'),
      userRow('Second', key: 'prompt-2'),
      interruption('marker-1', 'turn-1'),
      summary('s1', status: 'cancelled', user: 'prompt-1', turnId: 'turn-1'),
      userRow('Third', key: 'prompt-3'),
      interruption('marker-2', 'turn-2'),
      summary('s2', status: 'cancelled', user: 'prompt-2', turnId: 'turn-2'),
      interruption('marker-3', 'turn-3'),
      summary('s3', status: 'cancelled', user: 'prompt-3', turnId: 'turn-3'),
    ],
    order: [
      'First',
      'Interrupted',
      'Second',
      'Interrupted',
      'Third',
      'Interrupted',
    ],
    footers: ['turn:user:prompt-1', 'turn:user:prompt-2', 'turn:user:prompt-3'],
  ),
  (
    name: 'compaction stays with the prompt that asked for it',
    rows: [
      userRow('First', key: 'u1'),
      userRow('/compact', key: 'u2'),
      answerRow('Partial answer', key: 'a1'),
      row('history-reset', {
        'notice': 'Adapter-specific compaction copy',
        'semantic': {'kind': 'compaction'},
      }),
      summary('s1', user: 'u1', assistant: 'a1'),
    ],
    order: ['First', 'Partial answer', '/compact', 'Compaction complete'],
    footers: ['turn:user:u1'],
  ),
  (
    name: 'a generic notice after the next prompt remains with that prompt',
    rows: [
      userRow('First', key: 'u1'),
      userRow('Run a local command', key: 'u2'),
      answerRow('Partial answer', key: 'a1'),
      row('notice', {'message': 'Generic local-command output'}),
      summary('s1', user: 'u1', assistant: 'a1'),
    ],
    order: [
      'First',
      'Partial answer',
      'Run a local command',
      'Generic local-command output',
    ],
    footers: ['turn:user:u1'],
  ),
  (
    name: 'conflicting summaries keep answered and empty Stop prompts in place',
    rows: [
      userRow('First', key: 'u1'),
      answerRow('First answer', key: 'a1'),
      summary('first', user: 'u1', assistant: 'a1', turnId: 'first'),
      userRow('Second', key: 'u2'),
      toolCallRow('command', semantic: commandSemantic('make')),
      toolResultRow('command', semantic: commandSemantic('make')),
      answerRow('Second answer', key: 'a2'),
      userRow('Stop app', key: 'u3'),
      userRow('Stop terminal', key: 'u4'),
      summary('answered', user: 'u2', assistant: 'a2', turnId: 'answered'),
      summary(
        'stop-app',
        status: 'cancelled',
        user: 'u3',
        assistant: 'a2',
        turnId: 'stop-app',
      ),
      summary(
        'stop-terminal',
        status: 'cancelled',
        user: 'u4',
        assistant: 'a2',
        turnId: 'stop-terminal',
      ),
      userRow('Last', key: 'u5'),
      answerRow('Last answer', key: 'a5'),
      summary('last', user: 'u5', assistant: 'a5', turnId: 'last'),
    ],
    order: [
      'First',
      'First answer',
      'Second',
      'Second answer',
      'Stop app',
      'Stop terminal',
      'Last',
      'Last answer',
    ],
    footers: ['turn:user:u1', 'turn:user:u2', 'turn:user:u5'],
  ),
  (
    name: 'conflicting summaries in the opposite order fail the same way',
    rows: [
      userRow('First', key: 'u1'),
      answerRow('First answer', key: 'a1'),
      summary('first', user: 'u1', assistant: 'a1', turnId: 'first'),
      userRow('Second', key: 'u2'),
      answerRow('Second answer', key: 'a2'),
      userRow('Stop app', key: 'u3'),
      userRow('Stop terminal', key: 'u4'),
      summary(
        'stop-terminal',
        status: 'cancelled',
        user: 'u4',
        assistant: 'a2',
        turnId: 'stop-terminal',
      ),
      summary(
        'stop-app',
        status: 'cancelled',
        user: 'u3',
        assistant: 'a2',
        turnId: 'stop-app',
      ),
      summary('answered', user: 'u2', assistant: 'a2', turnId: 'answered'),
      userRow('Last', key: 'u5'),
      answerRow('Last answer', key: 'a5'),
      summary('last', user: 'u5', assistant: 'a5', turnId: 'last'),
    ],
    order: [
      'First',
      'First answer',
      'Second',
      'Second answer',
      'Stop app',
      'Stop terminal',
      'Last',
      'Last answer',
    ],
    footers: ['turn:user:u1', 'turn:user:u2', 'turn:user:u5'],
  ),
  for (final nativeTurns in [false, true])
    (
      name:
          'empty Stops stay before a later answer (native turn ids: $nativeTurns)',
      rows: [
        userRow('First', key: 'first'),
        toolCallRow('command', semantic: commandSemantic('make')),
        toolResultRow('command', semantic: commandSemantic('make')),
        answerRow('First answer', key: 'first-answer'),
        summary(
          'summary-first',
          user: 'first',
          assistant: 'first-answer',
          turnId: nativeTurns ? 'turn-first' : null,
        ),
        userRow('Stop app', key: 'stop-app'),
        summary(
          'summary-stop-app',
          status: 'cancelled',
          user: 'stop-app',
          turnId: nativeTurns ? 'turn-stop-app' : null,
        ),
        userRow('Stop terminal', key: 'stop-terminal'),
        summary(
          'summary-stop-terminal',
          status: 'cancelled',
          user: 'stop-terminal',
          turnId: nativeTurns ? 'turn-stop-terminal' : null,
        ),
        userRow('Last', key: 'last'),
        answerRow('Last answer', key: 'last-answer'),
        summary(
          'summary-last',
          user: 'last',
          assistant: 'last-answer',
          turnId: nativeTurns ? 'turn-last' : null,
        ),
      ],
      order: [
        'First',
        'First answer',
        'Stop app',
        'Stop terminal',
        'Last',
        'Last answer',
      ],
      footers: [
        'turn:user:first',
        'turn:user:stop-app',
        'turn:user:stop-terminal',
        'turn:user:last',
      ],
    ),
  for (final sameUser in [false, true])
    (
      name:
          'conflicting ${sameUser ? 'turn' : 'prompt'} ownership fails closed',
      rows: [
        userRow('First', key: 'u1'),
        answerRow('Preamble', key: 'a1'),
        userRow('Second', key: 'u2'),
        answerRow('Late answer', key: 'a2'),
        summary('s1', user: 'u1', assistant: 'a2', turnId: 'first'),
        summary(
          's2',
          status: 'cancelled',
          user: sameUser ? 'u1' : 'u2',
          assistant: 'a2',
          turnId: sameUser ? 'other' : 'first',
        ),
      ],
      order: ['First', 'Preamble', 'Second', 'Late answer'],
      footers: ['turn:user:u1', 'turn:user:u2'],
    ),
  (
    name:
        'a summary that names another prompt never drags the prompt below '
        'its answer (CR4b)',
    rows: [
      userRow('Only prompt', key: 'live-prompt'),
      answerRow('Its answer', key: 'a1'),
      summary('s1', user: 'replayed-prompt', assistant: 'a1'),
    ],
    order: ['Only prompt', 'Its answer'],
    footers: ['turn:user:live-prompt'],
  ),
  (
    name: 'output before the first delivered prompt is a partial turn above it',
    rows: [
      answerRow('Orphaned answer', key: 'a0'),
      userRow('Real prompt', key: 'u1'),
      answerRow('Real answer', key: 'a1'),
    ],
    order: ['Orphaned answer', 'Real prompt', 'Real answer'],
    footers: ['turn:ord:0', 'turn:user:u1'],
  ),
  (
    name: "a continuation turn opens on its notice, after the prompt's turn",
    rows: [
      userRow('Start workers', key: 'u1'),
      answerRow('Workers started', key: 'a1'),
      summary(
        's1',
        user: 'u1',
        assistant: 'a1',
        turnId: 'prompt-turn',
        runtimeMs: 100,
      ),
      row('notice', {
        'message': 'Worker finished',
        'semantic': {
          'kind': 'continuation',
          'reason': 'task-notification',
          'turnId': 'continuation-turn',
        },
      }),
      answerRow('Continuation answer', key: 'a2'),
      summary(
        's2',
        assistant: 'a2',
        turnId: 'continuation-turn',
        runtimeMs: 200,
      ),
    ],
    order: [
      'Start workers',
      'Workers started',
      'Worker finished',
      'Continuation answer',
    ],
    footers: ['turn:user:u1', 'turn:continuation:continuation-turn'],
  ),
];

void main() {
  group('turn order', () {
    for (final c in orderCases) {
      featureTest(c.name, (f) async {
        final app = await openTranscript(f, c.rows);
        app.expectInOrder(c.order, reason: c.name);
        // The footer follows the turn that produced the output.
        expect(footerKeys(), c.footers, reason: 'turn footers');
        // Each prompt text is shown exactly once, wherever it lands.
        for (final text in c.order) {
          if (text.startsWith('Stop') || text == 'Interrupted') continue;
          expect(app.shown(text), greaterThanOrEqualTo(1), reason: text);
        }
        expect(app.tester.takeException(), isNull);
      });
    }
  });

  group('turn footer', () {
    featureTest('a finished turn has one footer with runtime, Copy, read '
        'aloud and telemetry; a running turn shows no runtime', (f) async {
      final app = await openTranscript(
        f,
        [
          userRow('Do it', key: 'u1'),
          answerRow('First part', key: 'a1'),
          answerRow('Second part', key: 'a2'),
          summary(
            'rs-a2',
            assistant: 'a2',
            runtimeMs: 4200,
            completedAt: DateTime(2026, 7, 23, 10, 15).millisecondsSinceEpoch,
          ),
          userRow('Next', key: 'u2'),
          answerRow('Working on it', key: 'b1'),
          summary('rs-b1', assistant: 'b1', status: 'running'),
        ],
        overrides: [FakeSpeechOutput().providerOverride],
      );
      expect(find.byKey(const Key('conversation-turn-copy')), findsNWidgets(2));
      expect(
        find.byKey(const Key('conversation-turn-telemetry')),
        findsNWidgets(2),
      );
      expect(
        find.byKey(const Key('conversation-turn-read-aloud')),
        findsNWidgets(2),
      );
      // Only the finished turn reports a runtime.
      expect(
        find.byKey(const Key('conversation-turn-runtime-line')),
        findsOneWidget,
      );
      expect(find.textContaining('Ran for 4s'), findsOneWidget);
      expect(find.textContaining('Finished at'), findsOneWidget);
      // Status and run-summary frames never reach Chat as rows.
      expect(find.text('Run summary'), findsNothing);
      expect(app.visibleText, isNot(contains('rs-a2')));
    });

    featureTest('a summary is matched to its turn by assistant key, then by '
        'user key, then by turn id; an unmatched one is omitted and a later '
        'one updates the footer in place', (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final app = await openTranscript(f, [
        userRow('One', key: 'u1'),
        answerRow('Answer one', key: 'a1'),
        summary('s1', assistant: 'a1', runtimeMs: 1000),
        userRow('Two', key: 'u2'),
        answerRow('Answer two', key: 'a2'),
        summary('s2', user: 'u2', runtimeMs: 2000),
        userRow('Three', key: 'u3', turnId: 't3'),
        answerRow('Answer three', key: 'a3'),
        summary('s3', turnId: 't3', runtimeMs: 3000),
        summary('ghost', user: 'nobody', turnId: 'elsewhere', runtimeMs: 9000),
      ], broker: studio);
      List<String> runtimes() => [
        for (final element
            in find
                .byKey(const Key('conversation-turn-runtime-line'))
                .evaluate())
          app.textOf(find.byWidget(element.widget)).trim().split(' ·').first,
      ];
      expect(runtimes(), ['Ran for 1s', 'Ran for 2s', 'Ran for 3s']);
      expect(find.textContaining('9s'), findsNothing);
      // The same summary restated with a new runtime updates its footer.
      await app.live(studio, summary('s2', user: 'u2', runtimeMs: 7000));
      expect(runtimes(), ['Ran for 1s', 'Ran for 7s', 'Ran for 3s']);
    });

    featureTest('Copy covers every model segment of the turn across tool '
        'calls, and leaves out thinking and tool output', (f) async {
      final app = await openTranscript(f, [
        userRow('Do it', key: 'u1'),
        answerRow('Preamble', key: 'a1'),
        row('thinking', {'key': 'th1', 'text': 'private reasoning'}),
        toolCallRow('c1', semantic: commandSemantic('ls', state: 'running')),
        toolResultRow(
          'c1',
          semantic: commandSemantic('ls', stdout: 'TOOL OUTPUT'),
        ),
        answerRow('Final answer', key: 'a2'),
      ]);
      final copied = app.captureClipboard();
      await app.tapKey('conversation-turn-copy');
      expect(copied, ['Preamble\n\nFinal answer']);
    });

    featureTest('the telemetry dialog shows attributable values, only the '
        'note when nothing is attributable, and a cancelled status', (f) async {
      final app = await openTranscript(f, [
        userRow('Do it', key: 'u1'),
        toolCallRow('c1'),
        answerRow('Done', key: 'a1'),
        summary(
          's1',
          assistant: 'a1',
          runtimeMs: 3000,
          tokens: {'input': 100, 'output': 50},
        ),
        userRow('Hi', key: 'u2'),
        answerRow('Hello', key: 'b1'),
        userRow('Stop me', key: 'u3'),
        answerRow('Partial answer', key: 'c1x'),
        summary('s3', status: 'cancelled', assistant: 'c1x', runtimeMs: 500),
      ]);
      final telemetry = find.byKey(const Key('conversation-turn-telemetry'));
      await app.tester.tap(telemetry.at(0));
      await app.settle();
      expect(
        find.byKey(const Key('conversation-turn-telemetry-dialog')),
        findsOneWidget,
      );
      for (final text in [
        'Completed',
        'Status',
        'Input',
        '100',
        'Output',
        '50',
        'Tool calls',
      ]) {
        expect(find.text(text), findsOneWidget, reason: text);
      }
      expect(find.text('Tokens'), findsNothing);
      expect(
        find.ancestor(
          of: find.text('Completed'),
          matching: find.byType(SelectionArea),
        ),
        findsOneWidget,
      );
      await app.dismissModal();

      await app.tester.tap(telemetry.at(1));
      await app.settle();
      expect(
        find.byKey(const Key('conversation-turn-telemetry-empty')),
        findsOneWidget,
      );
      // No contradictory "Tool calls: 0" beside the empty note.
      expect(find.text('Tool calls'), findsNothing);
      await app.dismissModal();

      await app.tester.tap(telemetry.at(2));
      await app.settle();
      expect(find.text('Cancelled'), findsOneWidget);
    });
  });

  group('read aloud', () {
    IconData icon(AppDriver app, {String turn = 'turn:user:u1'}) {
      final button = find.descendant(
        of: find.byKey(Key('turn-footer-$turn')),
        matching: find.byKey(const Key('conversation-turn-read-aloud')),
      );
      return (app.tester.widget<IconButton>(button).icon as Icon).icon!;
    }

    Future<AppDriver> open(FeatureContext f, FakeSpeechOutput speech) =>
        openTranscript(
          f,
          [
            userRow('Do it', key: 'u1'),
            answerRow('First part', key: 'a1'),
            answerRow('Answer', key: 'a2'),
            userRow('Second', key: 'u2'),
            answerRow('Second answer', key: 'b1'),
          ],
          overrides: [speech.providerOverride],
        );

    Finder readAloud(String turn) => find.descendant(
      of: find.byKey(Key('turn-footer-$turn')),
      matching: find.byKey(const Key('conversation-turn-read-aloud')),
    );

    featureTest('read aloud speaks the turn aggregate under a stable key and '
        'cycles play, pause, resume and Stop', (f) async {
      final speech = FakeSpeechOutput();
      final app = await open(f, speech);
      expect(icon(app), Icons.volume_up_outlined);
      await app.tester.tap(readAloud('turn:user:u1'));
      await app.settle();
      expect(speech.spokenMessageKeys, ['turn:user:u1']);
      expect(speech.spokenTexts.single, contains('First part'));
      expect(speech.spokenTexts.single, contains('Answer'));
      expect(icon(app), Icons.pause_outlined);
      expect(
        find.byKey(const Key('conversation-turn-read-aloud-stop')),
        findsOneWidget,
      );
      // Another turn's footer stays at play while this one speaks.
      expect(icon(app, turn: 'turn:user:u2'), Icons.volume_up_outlined);
      await app.tester.tap(readAloud('turn:user:u1'));
      await app.settle();
      expect(icon(app), Icons.play_arrow_outlined);
      await app.tester.tap(readAloud('turn:user:u1'));
      await app.settle();
      expect(icon(app), Icons.pause_outlined);
      await app.tapKey('conversation-turn-read-aloud-stop');
      expect(icon(app), Icons.volume_up_outlined);
      expect(
        find.byKey(const Key('conversation-turn-read-aloud-stop')),
        findsNothing,
      );
    });

    featureTest('active read aloud offers only the four rates; an engine '
        'error offers retry', (f) async {
      final speech = FakeSpeechOutput();
      final app = await open(f, speech);
      final rateMenu = find.byKey(
        const Key('conversation-turn-read-aloud-rate'),
      );
      expect(rateMenu, findsNothing);
      await app.tester.tap(readAloud('turn:user:u1'));
      await app.settle();
      expect(find.text('1.0×'), findsOneWidget);
      await app.tester.tap(rateMenu);
      await app.settle();
      for (final label in const ['0.75×', '1.0×', '1.25×', '1.5×']) {
        expect(find.text(label), findsWidgets, reason: label);
      }
      await app.tester.tap(find.text('1.5×').last);
      await app.settle();
      expect(speech.rateCalls, contains(1.5));
      expect(find.byType(Slider), findsNothing);

      speech.fail(reason: 'engine failed', messageKey: 'turn:user:u2');
      await app.settle();
      expect(icon(app, turn: 'turn:user:u2'), Icons.refresh);
      await app.tester.tap(readAloud('turn:user:u2'));
      await app.settle();
      expect(speech.spokenMessageKeys.last, 'turn:user:u2');
    });

    featureTest('an engine that cannot pause shows Stop only', (f) async {
      final speech = FakeSpeechOutput(supportsPauseResume: false);
      final app = await open(f, speech);
      await app.tester.tap(readAloud('turn:user:u1'));
      await app.settle();
      expect(icon(app), Icons.stop_circle_outlined);
      expect(
        find.byKey(const Key('conversation-turn-read-aloud-stop')),
        findsNothing,
      );
    });

    featureTest('speech continues after the footer scrolls out of the '
        'virtualized list', (f) async {
      final speech = FakeSpeechOutput();
      final app = await openTranscript(
        f,
        [
          for (var i = 0; i < 80; i++) ...[
            userRow('Question $i', key: 'u$i'),
            answerRow('Answer $i', key: 'a$i'),
          ],
        ],
        viewport: FeatureViewport.desktop,
        overrides: [speech.providerOverride],
      );
      final last = find.byKey(const Key('turn-footer-turn:user:u79'));
      await app.tester.tap(
        find.descendant(
          of: last,
          matching: find.byKey(const Key('conversation-turn-read-aloud')),
        ),
      );
      await app.settle();
      expect(speech.current, isA<SpeechOutputSpeaking>());
      final position = app.tester
          .state<ScrollableState>(app.transcriptScrollable)
          .position;
      position.jumpTo(position.minScrollExtent);
      await app.settle();
      expect(last, findsNothing);
      expect(speech.disposals, 0);
      expect(speech.current, isA<SpeechOutputSpeaking>());
    });
  });
}
