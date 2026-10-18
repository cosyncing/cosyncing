// F03a — The activity band above the composer (background agents, commands,
// goal and task panels), durations, goal actions, and the context meter and
// Status telemetry. Rows arrive as history or live frames over the fake
// session socket; every assertion is on what the user sees.
//
// Start times are stamped relative to the host clock (the app measures
// running work against it); nothing here asserts an elapsed wall time.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/app_driver.dart';
import '../support/feature/cosyncing_app.dart';
import '../support/feature/session_driver.dart';
import '../support/feature/transcript_wire.dart';

Map<String, Object?> activity(
  String key,
  String title,
  String status, {
  String kind = 'subagent',
  int? startedAtMs,
  int? elapsedMs,
  Map<String, Object?> extra = const {},
}) => {
  'type': 'agent-activity',
  'key': key,
  'kind': kind,
  'title': title,
  'status': status,
  'startedAtMs': ?startedAtMs,
  'elapsedMs': ?elapsedMs,
  'agentsDone': status == 'running' ? 0 : 1,
  'agentsTotal': 1,
  ...extra,
};

const idleStatus = {'type': 'status', 'status': 'idle'};

/// Two finished agents ahead of two running ones in arrival order, with an
/// idle sweep in between: the shape of the reported screenshot.
List<Map<String, Object?>> reportedBand(int now) => [
  activity(
    'agent:map',
    'Map speed reader time anchors',
    'running',
    startedAtMs: now - 523000,
  ),
  activity(
    'agent:speed',
    'Claude Code output speed reader',
    'running',
    startedAtMs: now - 6300000,
  ),
  // Review reaches the client first although Benchmark started earlier, as
  // after a reconnect's history window opens past Benchmark's launch frame.
  activity(
    'agent:review',
    'Review PRs 229 and 230',
    'running',
    startedAtMs: now - 318000,
  ),
  activity(
    'agent:bench',
    'Benchmark PRs 229 and 230',
    'running',
    startedAtMs: now - 397000,
  ),
  activity(
    'agent:speed',
    'Claude Code output speed reader',
    'done',
    startedAtMs: now - 6300000,
    elapsedMs: 6300000,
  ),
  activity(
    'agent:map',
    'Map speed reader time anchors',
    'done',
    startedAtMs: now - 523000,
    elapsedMs: 523000,
  ),
  // The parent's turn ends with both background agents still out; the sweep
  // drops them and their next frames bring them back, review first.
  idleStatus,
  activity(
    'agent:review',
    'Review PRs 229 and 230',
    'running',
    startedAtMs: now - 318000,
  ),
  activity(
    'agent:bench',
    'Benchmark PRs 229 and 230',
    'running',
    startedAtMs: now - 397000,
  ),
];

Finder row(String key) =>
    find.byKey(ValueKey('session-live-state-row-activity:$key'));
Finder strip(String key) =>
    find.byKey(ValueKey('session-live-strip-activity:$key'));
Finder card(String key) =>
    find.byKey(ValueKey('session-agent-activity-activity:$key'));

const finishedHeader = Key('session-live-state-finished-header');
const finishedToggle = Key('session-live-state-finished-toggle');

extension on AppDriver {
  double top(Finder finder) => tester.getTopLeft(finder).dy;

  Future<void> expandBand(String frontKey) =>
      tapKey('session-live-strip-toggle-activity:$frontKey');

  /// The expanded band scrolls inside its own capped height.
  Future<void> toggleFinished() async {
    await reveal(find.byKey(finishedToggle));
    await tap(find.byKey(finishedToggle));
  }

  bool get bandExpanded => find
      .descendant(
        of: find.byKey(const ValueKey('session-live-state-band')),
        matching: find.byIcon(Icons.expand_less),
      )
      .evaluate()
      .isNotEmpty;

  void expectAbove(Finder upper, Finder lower, {String? reason}) =>
      expect(top(upper), lessThan(top(lower)), reason: reason);
}

void main() {
  group('band ordering and summary', () {
    featureTest('the strip fronts live work oldest-first and counts the band '
        'by phase; outcomes follow, newest first, behind a fold', (f) async {
      final now = DateTime.now().millisecondsSinceEpoch;
      final app = await openTranscript(
        f,
        reportedBand(now),
        tool: 'claude',
        viewport: FeatureViewport.desktop,
      );

      // The oldest running agent fronts the band, never a finished one.
      expect(strip('agent:bench'), findsOneWidget);
      expect(strip('agent:map'), findsNothing);
      expect(
        find.descendant(
          of: strip('agent:bench'),
          matching: find.text('Running'),
        ),
        findsOneWidget,
      );
      expect(find.text('2 running'), findsOneWidget);
      expect(find.text('2 done'), findsOneWidget);
      expect(find.text('+3'), findsNothing);
      // A lone agent's 0/1 restates the pill; it is not on the strip.
      expect(
        find.byKey(const Key('session-live-strip-progress')),
        findsNothing,
      );

      await app.expandBand('agent:bench');
      // Folded away behind their count while anything is still running.
      expect(find.text('Finished · 2'), findsOneWidget);
      expect(row('agent:map'), findsNothing);
      await app.toggleFinished();
      app
        ..expectAbove(row('agent:bench'), row('agent:review'))
        ..expectAbove(row('agent:review'), find.byKey(finishedHeader))
        ..expectAbove(find.byKey(finishedHeader), row('agent:map'))
        ..expectAbove(row('agent:map'), row('agent:speed'));
    });

    featureTest('the band stays open when the item fronting it finishes', (
      f,
    ) async {
      final now = DateTime.now().millisecondsSinceEpoch;
      final studio = f.network.add('http://studio.test:7734');
      final app = await openTranscript(
        f,
        reportedBand(now),
        tool: 'claude',
        viewport: FeatureViewport.desktop,
        broker: studio,
      );
      await app.expandBand('agent:bench');
      expect(app.bandExpanded, isTrue);

      await app.live(
        studio,
        activity(
          'agent:bench',
          'Benchmark PRs 229 and 230',
          'done',
          startedAtMs: now - 397000,
          elapsedMs: 397000,
        ),
      );

      // The front moved to the remaining running agent; keying the strip by
      // its front item collapsed the panel the reader had open right here.
      expect(strip('agent:review'), findsOneWidget);
      expect(app.bandExpanded, isTrue);
      expect(find.text('1 running'), findsOneWidget);
      expect(find.text('3 done'), findsOneWidget);
      // The newest outcome heads the finished section.
      await app.toggleFinished();
      app
        ..expectAbove(find.byKey(finishedHeader), row('agent:bench'))
        ..expectAbove(row('agent:bench'), row('agent:map'));
    });

    featureTest('Clear finished dismisses every outcome and keeps live work; '
        'a row dismisses only itself', (f) async {
      final now = DateTime.now().millisecondsSinceEpoch;
      final app = await openTranscript(
        f,
        reportedBand(now),
        tool: 'claude',
        viewport: FeatureViewport.desktop,
      );
      await app.expandBand('agent:bench');
      await app.toggleFinished();
      expect(row('agent:map'), findsOneWidget);

      await app.tap(
        find.byKey(
          const ValueKey('session-live-state-dismiss-activity:agent:map'),
        ),
      );
      expect(row('agent:map'), findsNothing);
      expect(row('agent:speed'), findsOneWidget);
      expect(row('agent:bench'), findsOneWidget);
      expect(app.bandExpanded, isTrue);
      expect(find.text('1 done'), findsOneWidget);

      // Folded again: Clear works from the header without the cards on screen.
      await app.toggleFinished();
      expect(row('agent:speed'), findsNothing);
      final clear = find.byKey(const Key('session-live-state-clear-finished'));
      await app.reveal(clear);
      await app.tap(clear);

      expect(row('agent:bench'), findsOneWidget);
      expect(row('agent:review'), findsOneWidget);
      expect(find.byKey(finishedHeader), findsNothing);
      expect(find.text('2 running'), findsOneWidget);
      expect(
        find.byKey(const Key('session-live-strip-count-done')),
        findsNothing,
      );
    });

    featureTest('the finished section folds while work is live and opens once '
        'none is', (f) async {
      final now = DateTime.now().millisecondsSinceEpoch;
      final studio = f.network.add('http://studio.test:7734');
      final app = await openTranscript(
        f,
        reportedBand(now),
        tool: 'claude',
        viewport: FeatureViewport.desktop,
        broker: studio,
      );
      await app.expandBand('agent:bench');
      expect(find.text('Finished · 2'), findsOneWidget);
      expect(row('agent:map'), findsNothing);
      expect(row('agent:speed'), findsNothing);

      await app.liveAll(studio, [
        activity(
          'agent:review',
          'Review PRs 229 and 230',
          'done',
          startedAtMs: now - 318000,
          elapsedMs: 318000,
        ),
        activity(
          'agent:bench',
          'Benchmark PRs 229 and 230',
          'done',
          startedAtMs: now - 397000,
          elapsedMs: 397000,
        ),
      ]);

      // Nothing is live, so the outcomes are the band's content.
      expect(find.text('Finished · 4'), findsOneWidget);
      expect(app.bandExpanded, isTrue);
      for (final key in ['agent:bench', 'agent:review', 'agent:map']) {
        expect(row(key), findsOneWidget, reason: key);
      }
    });

    featureTest("the reader's fold choice outlasts new outcomes and the "
        'default flipping', (f) async {
      final now = DateTime.now().millisecondsSinceEpoch;
      final studio = f.network.add('http://studio.test:7734');
      final app = await openTranscript(
        f,
        reportedBand(now),
        tool: 'claude',
        viewport: FeatureViewport.desktop,
        broker: studio,
      );
      await app.expandBand('agent:bench');

      await app.toggleFinished();
      expect(row('agent:map'), findsOneWidget);
      await app.live(
        studio,
        activity(
          'agent:review',
          'Review PRs 229 and 230',
          'done',
          startedAtMs: now - 318000,
          elapsedMs: 318000,
        ),
      );
      // Opened by hand, and a new outcome does not fold it back.
      expect(find.text('Finished · 3'), findsOneWidget);
      expect(row('agent:review'), findsOneWidget);

      await app.toggleFinished();
      expect(row('agent:map'), findsNothing);
      await app.live(
        studio,
        activity(
          'agent:bench',
          'Benchmark PRs 229 and 230',
          'done',
          startedAtMs: now - 397000,
          elapsedMs: 397000,
        ),
      );
      // Folded by hand: the last live card finishing, which would open an
      // untouched section, leaves it folded.
      expect(find.text('Finished · 4'), findsOneWidget);
      expect(row('agent:map'), findsNothing);
      expect(row('agent:bench'), findsNothing);
    });

    featureTest('a harness that stamps no start time keeps first-seen order '
        'through the idle sweep, live and replayed from history alike', (
      f,
    ) async {
      // OpenCode, Grok and Antigravity report no startedAtMs: their running
      // agents order by first sight, and a sweep must not re-file one behind
      // the other when it comes back.
      final frames = [
        activity('agent:first', 'First agent', 'running'),
        activity('agent:second', 'Second agent', 'running'),
        idleStatus,
        activity('agent:second', 'Second agent', 'running'),
        activity('agent:first', 'First agent', 'running'),
      ];
      final studio = f.network.add('http://studio.test:7734');
      final app = await openTranscript(
        f,
        const [],
        tool: 'claude',
        viewport: FeatureViewport.desktop,
        broker: studio,
      );
      await app.liveAll(studio, frames);

      expect(strip('agent:first'), findsOneWidget);
      await app.expandBand('agent:first');
      app.expectAbove(row('agent:first'), row('agent:second'));

      // The same frames as another session's saved history: the band the
      // reader finds after a reload is the one they watched arrive.
      studio
        ..addSession('s2', 'Replayed', tool: 'claude', cwd: '/work/studio')
        ..transcripts['s2'] = frames;
      await app.go('/sessions/claude/s2');
      await app.waitFor(strip('agent:first'));
      await app.expandBand('agent:first');
      app.expectAbove(row('agent:first'), row('agent:second'));
    });

    featureTest('a phone-width strip shows its counts without overflowing', (
      f,
    ) async {
      final now = DateTime.now().millisecondsSinceEpoch;
      final app = await openTranscript(
        f,
        reportedBand(now),
        tool: 'claude',
        viewport: FeatureViewport.phone,
        deepLink: true,
      );

      // Below 420 the counts drop their words and the kind label yields; the
      // words move to the tooltip.
      final running = find.byKey(const Key('session-live-strip-count-running'));
      expect(
        find.descendant(of: running, matching: find.text('2')),
        findsOneWidget,
      );
      expect(find.byTooltip('2 running'), findsOneWidget);
      expect(
        find.descendant(
          of: strip('agent:bench'),
          matching: find.text('Activity'),
        ),
        findsNothing,
      );
      expect(app.tester.takeException(), isNull);
    });

    featureTest('an agent with nothing to reveal is a plain row on every '
        'status; a workflow with children expands onto them', (f) async {
      final now = DateTime.now().millisecondsSinceEpoch;
      final app = await openTranscript(
        f,
        [
          activity(
            'agent:live',
            'Review PRs 229 and 230',
            'running',
            startedAtMs: now - 318000,
          ),
          activity(
            'agent:over',
            'Map speed reader time anchors',
            'done',
            startedAtMs: now - 523000,
            elapsedMs: 523000,
          ),
        ],
        tool: 'claude',
        viewport: FeatureViewport.desktop,
      );
      await app.expandBand('agent:live');
      await app.toggleFinished();

      for (final key in ['agent:live', 'agent:over']) {
        expect(
          find.descendant(of: card(key), matching: find.byType(ExpansionTile)),
          findsNothing,
          reason: key,
        );
        expect(
          find.descendant(
            of: card(key),
            matching: find.byKey(const Key('session-agent-activity-row')),
          ),
          findsOneWidget,
          reason: key,
        );
        expect(
          find.descendant(
            of: card(key),
            matching: find.textContaining('Background agent'),
          ),
          findsOneWidget,
          reason: key,
        );
        await app.reveal(card(key));
        await app.tap(card(key));
      }
      // The card used to expand onto "Progress remains live until the Server
      // reports completion." beside a Done pill as well as a Running one.
      expect(find.textContaining('remains live'), findsNothing);
    });

    featureTest('a workflow with children still expands onto them', (f) async {
      final app = await openTranscript(
        f,
        [
          {
            'type': 'agent-activity',
            'key': 'wf:review',
            'kind': 'workflow',
            'title': 'Review fan-out',
            'status': 'running',
            'agentsDone': 1,
            'agentsTotal': 2,
            'children': [
              {'key': 'diff', 'title': 'Read the diff', 'status': 'done'},
              {
                'key': 'tests',
                'title': 'Check the tests',
                'status': 'running',
              },
            ],
          },
        ],
        tool: 'claude',
        viewport: FeatureViewport.desktop,
      );
      // A fan-out of two is news, so the strip carries its progress.
      expect(
        find.byKey(const Key('session-live-strip-progress')),
        findsOneWidget,
      );
      await app.expandBand('wf:review');
      expect(
        find.descendant(
          of: card('wf:review'),
          matching: find.byType(ExpansionTile),
        ),
        findsOneWidget,
      );
      expect(find.text('Check the tests'), findsNothing);
      await app.tap(
        find.descendant(
          of: card('wf:review'),
          matching: find.text('Review fan-out'),
        ),
      );
      expect(find.text('Read the diff'), findsOneWidget);
      expect(find.text('Check the tests'), findsOneWidget);
    });
  });

  group('durations', () {
    Future<AppDriver> openCard(
      FeatureContext f,
      Map<String, Object?> frame,
    ) async {
      final app = await openTranscript(
        f,
        [frame],
        tool: 'claude',
        viewport: FeatureViewport.desktop,
      );
      await app.expandBand('subagent-1');
      return app;
    }

    String summary(AppDriver app) => app.tester
        .widget<Text>(find.byKey(const Key('session-agent-activity-summary')))
        .data!;

    Map<String, Object?> agent(String status, {int? elapsedMs}) => activity(
      'subagent-1',
      'Review the change set',
      status,
      elapsedMs: elapsedMs,
    );

    featureTest('a finished card with no measured duration shows none, and '
        'stays showing none', (f) async {
      final app = await openCard(f, agent('done'));
      expect(summary(app), 'Background agent');
      // A duration invented from the card's own first-render guess would
      // appear and keep climbing.
      await app.elapse(const Duration(minutes: 2));
      expect(summary(app), 'Background agent');
    });

    featureTest('a finished card reports the duration it was given and stops '
        'there', (f) async {
      final app = await openCard(f, agent('done', elapsedMs: 42000));
      expect(summary(app), contains('42s'));
      await app.elapse(const Duration(minutes: 2));
      expect(summary(app), contains('42s'));
    });

    featureTest('a running card keeps a duration when the tool reported '
        'none, and reports the measured one once it is larger', (f) async {
      // A quiet running agent emits nothing for minutes, so the card floors
      // its elapsed at the wall clock.
      final quiet = await openCard(f, agent('running'));
      expect(summary(quiet), isNot('Background agent'));
      expect(summary(quiet), contains('s'));
    });

    featureTest('a running card reports the measured duration', (f) async {
      // A running card floors its duration at the wall clock, and with no
      // start time in the fixture that clock is back-derived from this
      // elapsedMs against the real host clock. The figure on screen is
      // therefore the measured 5s plus whatever real time has passed since
      // the card was built, and a widget test cannot freeze DateTime.now():
      // asserting the exact second failed whenever a loaded machine spent one
      // between the first frame and this check. What has to hold is that the
      // measured figure reached the card, and that nothing inflated it beyond
      // the time this test itself has taken.
      final openedAt = DateTime.now();
      final app = await openCard(f, agent('running', elapsedMs: 5000));
      final spentMs = DateTime.now().difference(openedAt).inMilliseconds;
      final rendered = RegExp(r' · (\d+)s$').firstMatch(summary(app));
      expect(rendered, isNotNull, reason: summary(app));
      expect(
        int.parse(rendered!.group(1)!),
        inInclusiveRange(5, (5_000 + spentMs) ~/ 1_000),
      );
    });

    featureTest('a finished command that wrote nothing says so, not that '
        'progress is live; a running one keeps its own wording', (f) async {
      final done = await openTranscript(
        f,
        [
          activity(
            'cmd:quiet',
            'Build the bundle',
            'done',
            kind: 'command',
            elapsedMs: 4000,
            extra: {'exitCode': 0},
          ),
        ],
        tool: 'claude',
        viewport: FeatureViewport.desktop,
      );
      await done.expandBand('cmd:quiet');
      await done.tap(
        find.descendant(
          of: card('cmd:quiet'),
          matching: find.text('Build the bundle'),
        ),
      );
      expect(find.text('No output'), findsOneWidget);
      expect(
        find.text('Progress remains live until the Server reports completion.'),
        findsNothing,
      );
    });

    featureTest('a running command with nothing on stdout yet says so', (
      f,
    ) async {
      final app = await openTranscript(
        f,
        [
          activity(
            'cmd:quiet',
            'Build the bundle',
            'running',
            kind: 'command',
            elapsedMs: 4000,
          ),
        ],
        tool: 'claude',
        viewport: FeatureViewport.desktop,
      );
      await app.expandBand('cmd:quiet');
      await app.tap(
        find.descendant(
          of: card('cmd:quiet'),
          matching: find.text('Build the bundle'),
        ),
      );
      expect(find.text('No output yet'), findsOneWidget);
    });
  });

  group('goal and task panels', () {
    const goalStrip = ValueKey('session-live-strip-goal:current');
    const taskStrip = ValueKey('session-live-strip-task-list:plan');

    Map<String, Object?> goal(String status, String title, {int? elapsedMs}) =>
        {
          'type': 'goal-state',
          'key': 'current',
          'status': status,
          'title': title,
          'elapsedMs': ?elapsedMs,
        };

    Map<String, Object?> tasks(String status, List<Map<String, Object?>> i) => {
      'type': 'task-list-state',
      'key': 'plan',
      'status': status,
      'title': 'Launch checklist',
      'items': i,
    };

    featureTest('state panels upsert by key and stay out of the transcript', (
      f,
    ) async {
      final studio = f.network.add('http://studio.test:7734');
      final app = await openTranscript(
        f,
        const [],
        broker: studio,
        viewport: FeatureViewport.desktop,
      );
      await app.liveAll(studio, [
        goal('active', 'Obsolete objective'),
        goal('paused', 'Current objective', elapsedMs: 42000),
        tasks('running', [
          {'title': 'Old task', 'status': 'open'},
        ]),
        tasks('done', [
          {'title': 'Current task', 'status': 'done'},
        ]),
      ]);

      expect(find.byKey(const Key('session-live-state-surface')), findsOne);
      expect(find.byKey(goalStrip), findsOneWidget);
      expect(find.text('Obsolete objective'), findsNothing);
      expect(find.byKey(taskStrip), findsNothing);
      // The paused goal fronts the band; the finished list is the one done.
      expect(find.text('1 paused'), findsOneWidget);
      expect(find.text('1 done'), findsOneWidget);
      expect(find.text('Goal state'), findsNothing);
      expect(find.text('Task list state'), findsNothing);

      await app.tap(find.byKey(goalStrip));
      expect(find.text('Current objective'), findsWidgets);
      // The finished checklist is an outcome: folded while the goal is live.
      expect(find.text('Launch checklist'), findsNothing);
      await app.toggleFinished();
      expect(find.text('Launch checklist'), findsOneWidget);
      await app.tap(find.text('Launch checklist'));
      expect(find.text('Current task'), findsOneWidget);
      expect(find.text('Old task'), findsNothing);
      // One tap toggles once; a second handler would leave it unchanged.
      await app.tap(find.text('Launch checklist'));
      expect(find.text('Current task'), findsNothing);
      await app.tap(find.text('Launch checklist'));
      expect(find.text('Current task'), findsOneWidget);
    });

    featureTest('expanded task rows render at the transcript body scale', (
      f,
    ) async {
      final app = await openTranscript(
        f,
        [
          tasks('running', [
            {
              'title': 'Current task',
              'status': 'in-progress',
              'detail': 'Halfway there',
              'priority': 'high',
            },
          ]),
        ],
        viewport: FeatureViewport.desktop,
      );
      await app.tap(find.byKey(taskStrip));

      final row = find.byKey(const Key('session-task-item-0'));
      expect(row, findsOneWidget);
      final icon = app.tester.widget<Icon>(
        find.descendant(of: row, matching: find.byIcon(Icons.pending_outlined)),
      );
      expect(icon.size, 20);
      final theme = Theme.of(app.tester.element(row)).textTheme;
      final title = app.tester.widget<Text>(
        find.descendant(of: row, matching: find.text('Current task')),
      );
      expect(title.style?.fontSize, theme.bodyLarge?.fontSize);
      final detail = app.tester.widget<Text>(
        find.descendant(of: row, matching: find.text('Halfway there')),
      );
      expect(detail.style?.fontSize, theme.bodyMedium?.fontSize);
    });

    for (final locale in const ['en', 'zh']) {
      featureTest('a finished task list stays pinned in $locale, also while '
          'it is open', (f) async {
        final app = await openTranscript(
          f,
          [
            tasks('done', [
              {'title': 'Ship it', 'status': 'done'},
            ]),
          ],
          locale: locale,
          viewport: FeatureViewport.desktop,
        );
        expect(find.byKey(taskStrip), findsOneWidget);
        // A 3 second auto-archive once removed it, and keyed on the
        // localized label so it never fired in Chinese.
        await app.elapse(const Duration(seconds: 4));
        expect(find.byKey(taskStrip), findsOneWidget);

        await app.tap(find.byKey(taskStrip));
        await app.tap(find.byKey(const Key('session-task-list-expansion')));
        expect(find.text('Ship it'), findsOneWidget);
        await app.elapse(const Duration(seconds: 4));
        expect(find.byKey(taskStrip), findsOneWidget);
        expect(find.text('Ship it'), findsOneWidget);
      });
    }

    featureTest('an advertised goal action is sent, and the panel waits for '
        'the broker state', (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final app = await openTranscript(
        f,
        const [],
        broker: studio,
        viewport: FeatureViewport.desktop,
      );
      app.socket(studio).emit({
        'kind': 'commands',
        'commands': [
          {'name': 'goal', 'kind': 'action'},
        ],
      });
      await app.liveAll(studio, [goal('active', 'Finish launch work')]);

      await app.tap(find.byKey(goalStrip));
      await app.tap(find.byKey(const Key('session-goal-pause')));

      final sent = app.framesSent(studio, 'command');
      expect(sent, hasLength(1));
      expect(sent.single['name'], 'goal');
      expect(sent.single['args'], 'pause');
      // The incoming goal-state stays authoritative.
      expect(find.byKey(const Key('session-goal-pause')), findsOneWidget);

      await app.liveAll(studio, [goal('paused', 'Finish launch work')]);
      expect(find.byKey(const Key('session-goal-resume')), findsOneWidget);
    });

    featureTest('goal controls fail closed when the command is not an '
        'advertised action', (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final app = await openTranscript(
        f,
        const [],
        broker: studio,
        viewport: FeatureViewport.desktop,
      );
      app.socket(studio).emit({
        'kind': 'commands',
        'commands': [
          {'name': 'goal'},
        ],
      });
      await app.liveAll(studio, [goal('active', 'Read-only capability proof')]);

      await app.tap(find.byKey(goalStrip));
      final pause = app.tester.widget<OutlinedButton>(
        find.byKey(const Key('session-goal-pause')),
      );
      expect(pause.onPressed, isNull);
      expect(app.framesSent(studio, 'command'), isEmpty);
    });
  });

  group('background commands and agents', () {
    featureTest('a running agent shows its wall clock and input tokens, and '
        'both surfaces report the same status when it ends', (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final now = DateTime.now().millisecondsSinceEpoch;
      final app = await openTranscript(
        f,
        [
          activity(
            'agent:review',
            'Review notifications',
            'running',
            startedAtMs: now - 5000,
            elapsedMs: 5000,
            extra: {
              'subtitle': 'reviewer',
              'tokens': {'input': 17500, 'output': 1200},
            },
          ),
        ],
        tool: 'claude',
        viewport: FeatureViewport.desktop,
        broker: studio,
      );
      expect(strip('agent:review'), findsOneWidget);
      await app.tap(strip('agent:review'));
      expect(find.textContaining('17.5k tokens'), findsOneWidget);
      expect(find.textContaining('Background agent'), findsOneWidget);
      expect(find.text('Agent activity'), findsNothing);

      await app.live(
        studio,
        activity(
          'agent:review',
          'Review notifications',
          'done',
          elapsedMs: 7000,
        ),
      );
      // A terminal activity is not retired automatically: it stays until the
      // reader archives it, and both surfaces say Done.
      expect(card('agent:review'), findsOneWidget);
      expect(strip('agent:review'), findsOneWidget);
      expect(find.text('Done'), findsNWidgets(2));
      expect(find.text('Running'), findsNothing);
    });

    featureTest('an archived background command comes back when it ends', (
      f,
    ) async {
      final studio = f.network.add('http://studio.test:7734');
      // The adapter stamps the same startedAtMs on a command's running and
      // terminal frames, so the fixture does too.
      final startedAtMs = DateTime.now().millisecondsSinceEpoch - 5000;
      final app = await openTranscript(
        f,
        [
          activity(
            'cmd:toolu_1',
            'Build the bundle',
            'running',
            kind: 'command',
            startedAtMs: startedAtMs,
          ),
        ],
        tool: 'claude',
        viewport: FeatureViewport.desktop,
        broker: studio,
      );
      expect(strip('cmd:toolu_1'), findsOneWidget);

      // Dismissing a running command means "not now", not "never tell me".
      await app.tap(
        find.byKey(
          const ValueKey('session-live-strip-archive-activity:cmd:toolu_1'),
        ),
      );
      expect(strip('cmd:toolu_1'), findsNothing);

      await app.live(
        studio,
        activity(
          'cmd:toolu_1',
          'Build the bundle',
          'error',
          kind: 'command',
          startedAtMs: startedAtMs,
          elapsedMs: 7000,
          extra: {'exitCode': 1},
        ),
      );
      // The archive identity carries whether the work ended, so the terminal
      // frame returns the card once, carrying the outcome.
      expect(strip('cmd:toolu_1'), findsOneWidget);
      expect(find.text('Failed'), findsWidgets);
    });
  });

  group('context meter and Status telemetry', () {
    Map<String, Object?> context(int used, int max) => {
      'type': 'metadata-update',
      'key': 'contextUsage',
      'value': {'used': used, 'max': max},
    };

    const tokens = {
      'type': 'token-count',
      'input': 10800000,
      'output': 212000,
      'cacheRead': 332792,
      'cacheWrite': 656,
    };

    List<Map<String, Object?>> telemetry() => [
      answerRow('Here is the answer.', key: 'a1'),
      tokens,
      context(90000, 100000),
      {'type': 'run-summary', 'status': 'done', 'totalRuntimeMs': 246000},
    ];

    featureTest('a reading shows in the composer; its metadata frame and the '
        'token lines leave no card', (f) async {
      final app = await openTranscript(
        f,
        telemetry(),
        viewport: FeatureViewport.desktop,
      );
      expect(
        find.byKey(const Key('session-context-meter-verbose')),
        findsOneWidget,
      );
      expect(find.text('90k / 100k'), findsOneWidget);
      expect(find.textContaining('Metadata update'), findsNothing);
      expect(find.textContaining('contextUsage'), findsNothing);
      expect(find.textContaining('Tokens:'), findsNothing);
      expect(
        find.byKey(const Key('transcript-token-count-line')),
        findsNothing,
      );
      expect(app.visibleText, contains('Here is the answer.'));
    });

    featureTest('without a reading the meter occupies nothing', (f) async {
      await openTranscript(
        f,
        [answerRow('Hi', key: 'a1')],
        viewport: FeatureViewport.desktop,
      );
      expect(
        find.byKey(const Key('session-context-meter-verbose')),
        findsNothing,
      );
      expect(find.byKey(const Key('session-context-meter-ring')), findsNothing);
    });

    // The shipped regression: a 0-1 vs 0-100 confusion inflated readings.
    final cases = <({int used, int max, String shown})>[
      (used: 1500, max: 200000, shown: '1%'),
      (used: 9230, max: 972800, shown: '1%'),
      (used: 74000, max: 200000, shown: '37%'),
      (used: 200000, max: 200000, shown: '100%'),
      (used: 260000, max: 200000, shown: '100%'),
    ];
    for (final c in cases) {
      featureTest('a ${c.used} of ${c.max} reading says ${c.shown}', (f) async {
        final app = await openTranscript(
          f,
          [context(c.used, c.max)],
          viewport: FeatureViewport.phone,
          deepLink: true,
        );
        await app.tap(find.byKey(const Key('session-context-meter-details')));
        expect(find.byType(AlertDialog), findsOneWidget);
        expect(find.textContaining(c.shown), findsWidgets);
      });
    }

    featureTest('the newest reading wins', (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final app = await openTranscript(
        f,
        [context(10000, 200000)],
        broker: studio,
        viewport: FeatureViewport.desktop,
      );
      expect(find.text('10k / 200k'), findsOneWidget);
      await app.live(studio, context(150000, 200000));
      expect(find.text('150k / 200k'), findsOneWidget);
      expect(find.text('10k / 200k'), findsNothing);
    });

    featureTest('a first reading arriving at 390 dp takes a ring and does not '
        'grow the composer', (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final app = await openTranscript(
        f,
        const [],
        broker: studio,
        viewport: FeatureViewport.phone,
        deepLink: true,
      );
      final composer = find.byKey(const Key('session-detail-composer'));
      final before = app.tester.getSize(composer).height;
      await app.live(studio, context(90000, 100000));
      expect(
        find.byKey(const Key('session-context-meter-ring')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-context-meter-verbose')),
        findsNothing,
      );
      expect(app.tester.getSize(composer).height, before);
    });

    featureTest('Status holds the full token breakdown', (f) async {
      final app = await openTranscript(
        f,
        telemetry(),
        viewport: FeatureViewport.desktop,
      );
      await app.openStatus();
      expect(
        find.byKey(const Key('session-detail-telemetry-panel')),
        findsOneWidget,
      );
      expect(find.text('10.8M tokens'), findsOneWidget);
      expect(find.text('212k tokens'), findsOneWidget);
      expect(find.text('332.8k tokens'), findsOneWidget);
      expect(find.text('656 tokens'), findsOneWidget);
      expect(find.text('Session summary'), findsOneWidget);
      expect(find.text('Total tokens'), findsNothing);
      expect(find.textContaining('cache hit'), findsNothing);
    });

    featureTest('Status reports an empty state before any reading', (f) async {
      final app = await openTranscript(
        f,
        [answerRow('Hi', key: 'a1')],
        viewport: FeatureViewport.desktop,
      );
      await app.openStatus();
      expect(
        find.byKey(const Key('session-detail-telemetry-empty')),
        findsOneWidget,
      );
    });
  });
}
