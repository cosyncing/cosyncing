import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

/// The chat band's ordering, summary and dismissal.
///
/// The band used to front whichever item its source list happened to hold
/// first, which was map insertion order: a finished agent could front two that
/// were still running, and an idle sweep re-filed a swept subagent behind every
/// card that had finished meanwhile. The strip only said "+15", and only the
/// fronted item could be archived.
void main() {
  SessionWireEvent workingSession({String tool = 'claude'}) => SessionWireEvent(
    info: SessionInfo.fromJson({
      'id': 'session-1',
      'tool': tool,
      'title': 'Speed reader work',
      'status': 'working',
      'attachMode': 'observe',
      'control': const {
        'drive': {'state': 'observing', 'supported': false},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      },
    }),
  );

  MessageWireEvent activity(
    int seq,
    String key,
    String title,
    String status, {
    int? startedAtMs,
    int? elapsedMs,
  }) => MessageWireEvent(
    seq: seq,
    message: AgentMessage.fromJson({
      'type': 'agent-activity',
      'key': key,
      'kind': 'subagent',
      'title': title,
      'status': status,
      if (startedAtMs != null) 'startedAtMs': startedAtMs,
      if (elapsedMs != null) 'elapsedMs': elapsedMs,
      'agentsDone': status == 'running' ? 0 : 1,
      'agentsTotal': 1,
    }),
  );

  MessageWireEvent idle(int seq) => MessageWireEvent(
    seq: seq,
    message: AgentMessage.fromJson(const {'type': 'status', 'status': 'idle'}),
  );

  Finder row(String key) =>
      find.byKey(ValueKey('session-live-state-row-activity:$key'));

  Finder strip(String key) =>
      find.byKey(ValueKey('session-live-strip-activity:$key'));

  double top(WidgetTester tester, Finder finder) =>
      tester.getTopLeft(finder).dy;

  Future<void> expandBand(WidgetTester tester, String frontKey) async {
    await tester.tap(
      find.byKey(ValueKey('session-live-strip-toggle-activity:$frontKey')),
    );
    await tester.pumpAndSettle();
  }

  Future<void> toggleFinished(WidgetTester tester) async {
    // The expanded band scrolls inside its own capped height.
    final toggle = find.byKey(const Key('session-live-state-finished-toggle'));
    await tester.ensureVisible(toggle);
    await tester.pumpAndSettle();
    await tester.tap(toggle);
    await tester.pumpAndSettle();
  }

  bool bandExpanded() => find
      .descendant(
        of: find.byKey(const ValueKey('session-live-state-band')),
        matching: find.byIcon(Icons.expand_less),
      )
      .evaluate()
      .isNotEmpty;

  /// The shape of the reported screenshot: two finished agents ahead of two
  /// running ones in arrival order, and an idle sweep in between.
  List<WireEvent> reportedBand(int now) => [
    workingSession(),
    activity(
      1,
      'agent:map',
      'Map speed reader time anchors',
      'running',
      startedAtMs: now - 523000,
    ),
    activity(
      2,
      'agent:speed',
      'Claude Code output speed reader',
      'running',
      startedAtMs: now - 6300000,
    ),
    // Review reaches this client first although Benchmark started earlier,
    // as when a reconnect's history window opens after Benchmark's launch
    // frame. First-seen order alone would front the wrong one.
    activity(
      3,
      'agent:review',
      'Review PRs 229 and 230',
      'running',
      startedAtMs: now - 318000,
    ),
    activity(
      4,
      'agent:bench',
      'Benchmark PRs 229 and 230',
      'running',
      startedAtMs: now - 397000,
    ),
    activity(
      5,
      'agent:speed',
      'Claude Code output speed reader',
      'done',
      startedAtMs: now - 6300000,
      elapsedMs: 6300000,
    ),
    activity(
      6,
      'agent:map',
      'Map speed reader time anchors',
      'done',
      startedAtMs: now - 523000,
      elapsedMs: 523000,
    ),
    // The parent's turn ends with both background agents still out. The
    // sweep drops them; their next progress frames bring them back, review
    // first, which is the order map re-insertion used to show.
    idle(7),
    activity(
      8,
      'agent:review',
      'Review PRs 229 and 230',
      'running',
      startedAtMs: now - 318000,
    ),
    activity(
      9,
      'agent:bench',
      'Benchmark PRs 229 and 230',
      'running',
      startedAtMs: now - 397000,
    ),
  ];

  testWidgets('the strip fronts live work and counts the band by phase', (
    tester,
  ) async {
    useRoomyTestViewport(tester);
    final now = DateTime.now().millisecondsSinceEpoch;
    await tester.pumpWidget(
      buildSessionDetailTestPage(events: reportedBand(now)),
    );
    await tester.pumpAndSettle();

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
    expect(find.byKey(const Key('session-live-strip-progress')), findsNothing);

    await expandBand(tester, 'agent:bench');

    // Live work oldest-first by the adapter's start time, whatever order the
    // sweep re-inserted it in; then the outcomes, newest-first, folded away
    // behind their count while anything is still running.
    final finishedHeader = find.byKey(
      const Key('session-live-state-finished-header'),
    );
    expect(find.text('Finished · 2'), findsOneWidget);
    expect(row('agent:map'), findsNothing);
    await toggleFinished(tester);
    expect(
      top(tester, row('agent:bench')),
      lessThan(top(tester, row('agent:review'))),
    );
    expect(
      top(tester, row('agent:review')),
      lessThan(top(tester, finishedHeader)),
    );
    expect(
      top(tester, finishedHeader),
      lessThan(top(tester, row('agent:map'))),
    );
    expect(
      top(tester, row('agent:map')),
      lessThan(top(tester, row('agent:speed'))),
    );
  });

  testWidgets(
    'the band stays open when the item fronting it finishes',
    (tester) async {
      useRoomyTestViewport(tester);
      final now = DateTime.now().millisecondsSinceEpoch;
      final connection = ScriptedSessionDetailConnection(
        events: reportedBand(now),
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      await expandBand(tester, 'agent:bench');
      expect(bandExpanded(), isTrue);

      connection.emitEvent(
        activity(
          10,
          'agent:bench',
          'Benchmark PRs 229 and 230',
          'done',
          startedAtMs: now - 397000,
          elapsedMs: 397000,
        ),
      );
      await tester.pumpAndSettle();

      // The front moved to the remaining running agent. Keying the strip by
      // its front item collapsed the panel the reader had open right here.
      expect(strip('agent:review'), findsOneWidget);
      expect(bandExpanded(), isTrue);
      expect(find.text('1 running'), findsOneWidget);
      expect(find.text('3 done'), findsOneWidget);
      // The newest outcome heads the finished section.
      await toggleFinished(tester);
      final finishedHeader = find.byKey(
        const Key('session-live-state-finished-header'),
      );
      expect(
        top(tester, finishedHeader),
        lessThan(top(tester, row('agent:bench'))),
      );
      expect(
        top(tester, row('agent:bench')),
        lessThan(top(tester, row('agent:map'))),
      );
    },
  );

  testWidgets('Clear finished dismisses every outcome and keeps live work', (
    tester,
  ) async {
    useRoomyTestViewport(tester);
    final store = InMemorySessionLiveStateViewStoreProbe();
    final now = DateTime.now().millisecondsSinceEpoch;
    await tester.pumpWidget(
      buildSessionDetailTestPage(
        events: reportedBand(now),
        liveStateViewStore: store,
      ),
    );
    await tester.pumpAndSettle();
    await expandBand(tester, 'agent:bench');
    // Opened only so the cards' disappearance below means something: a folded
    // section builds no cards at all.
    await toggleFinished(tester);
    expect(row('agent:map'), findsOneWidget);
    await toggleFinished(tester);

    // Clear works from the folded header; it never needs the cards on screen.
    expect(row('agent:map'), findsNothing);
    final clear = find.byKey(const Key('session-live-state-clear-finished'));
    await tester.ensureVisible(clear);
    await tester.pumpAndSettle();
    await tester.tap(clear);
    await tester.pumpAndSettle();

    expect(row('agent:bench'), findsOneWidget);
    expect(row('agent:review'), findsOneWidget);
    expect(
      find.byKey(const Key('session-live-state-finished-header')),
      findsNothing,
    );
    expect(find.text('2 running'), findsOneWidget);
    expect(
      find.byKey(const Key('session-live-strip-count-done')),
      findsNothing,
    );
    // One write for the whole batch, and it is durable.
    expect(store.saves, 1);
    expect(
      store.lastSaved.keys,
      unorderedEquals([
        'activity:agent:map',
        'activity:agent:speed',
      ]),
    );
  });

  testWidgets('a row dismisses only itself', (tester) async {
    useRoomyTestViewport(tester);
    final now = DateTime.now().millisecondsSinceEpoch;
    await tester.pumpWidget(
      buildSessionDetailTestPage(events: reportedBand(now)),
    );
    await tester.pumpAndSettle();
    await expandBand(tester, 'agent:bench');
    await toggleFinished(tester);

    // No ensureVisible here: opening the section scrolls the band's capped
    // height to it, so its first card is already where a finger can reach.
    final dismiss = find.byKey(
      const ValueKey('session-live-state-dismiss-activity:agent:map'),
    );
    await tester.tap(dismiss);
    await tester.pumpAndSettle();

    expect(row('agent:map'), findsNothing);
    expect(row('agent:speed'), findsOneWidget);
    expect(row('agent:bench'), findsOneWidget);
    expect(bandExpanded(), isTrue);
    expect(find.text('1 done'), findsOneWidget);
  });

  testWidgets(
    'the finished section folds while work is live and opens once none is',
    (tester) async {
      useRoomyTestViewport(tester);
      final now = DateTime.now().millisecondsSinceEpoch;
      final connection = ScriptedSessionDetailConnection(
        events: reportedBand(now),
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      await expandBand(tester, 'agent:bench');
      expect(find.text('Finished · 2'), findsOneWidget);
      expect(row('agent:map'), findsNothing);
      expect(row('agent:speed'), findsNothing);

      for (final (seq, key, title, startedAgo) in [
        (10, 'agent:review', 'Review PRs 229 and 230', 318000),
        (11, 'agent:bench', 'Benchmark PRs 229 and 230', 397000),
      ]) {
        connection.emitEvent(
          activity(
            seq,
            key,
            title,
            'done',
            startedAtMs: now - startedAgo,
            elapsedMs: startedAgo,
          ),
        );
      }
      await tester.pumpAndSettle();

      // Nothing is live, so the outcomes are the band's content.
      expect(find.text('Finished · 4'), findsOneWidget);
      expect(bandExpanded(), isTrue);
      for (final key in ['agent:bench', 'agent:review', 'agent:map']) {
        expect(row(key), findsOneWidget, reason: key);
      }
    },
  );

  testWidgets(
    "the reader's fold choice outlasts new outcomes and the default flipping",
    (tester) async {
      useRoomyTestViewport(tester);
      final now = DateTime.now().millisecondsSinceEpoch;
      final connection = ScriptedSessionDetailConnection(
        events: reportedBand(now),
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      await expandBand(tester, 'agent:bench');

      await toggleFinished(tester);
      expect(row('agent:map'), findsOneWidget);
      connection.emitEvent(
        activity(
          10,
          'agent:review',
          'Review PRs 229 and 230',
          'done',
          startedAtMs: now - 318000,
          elapsedMs: 318000,
        ),
      );
      await tester.pumpAndSettle();
      // Opened by hand, and a new outcome does not fold it back.
      expect(find.text('Finished · 3'), findsOneWidget);
      expect(row('agent:review'), findsOneWidget);

      await toggleFinished(tester);
      expect(row('agent:map'), findsNothing);
      connection.emitEvent(
        activity(
          11,
          'agent:bench',
          'Benchmark PRs 229 and 230',
          'done',
          startedAtMs: now - 397000,
          elapsedMs: 397000,
        ),
      );
      await tester.pumpAndSettle();
      // Folded by hand, and the last live card finishing — which would open an
      // untouched section — leaves it folded.
      expect(find.text('Finished · 4'), findsOneWidget);
      expect(row('agent:map'), findsNothing);
      expect(row('agent:bench'), findsNothing);
    },
  );

  testWidgets(
    'a harness that stamps no start time keeps first-seen order through '
    'the idle sweep',
    (tester) async {
      // OpenCode, Grok and Antigravity report no startedAtMs. Their running
      // agents order by when the projection first saw them, and a sweep must
      // not re-file one behind the other when it comes back.
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          tool: 'opencode',
          events: [
            workingSession(tool: 'opencode'),
            activity(1, 'agent:first', 'First agent', 'running'),
            activity(2, 'agent:second', 'Second agent', 'running'),
            idle(3),
            activity(4, 'agent:second', 'Second agent', 'running'),
            activity(5, 'agent:first', 'First agent', 'running'),
          ],
        ),
      );
      await tester.pumpAndSettle();

      expect(strip('agent:first'), findsOneWidget);
      await expandBand(tester, 'agent:first');
      expect(
        top(tester, row('agent:first')),
        lessThan(top(tester, row('agent:second'))),
      );
    },
  );

  testWidgets('a phone-width strip shows its counts without overflowing', (
    tester,
  ) async {
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    tester.view
      ..physicalSize = const Size(360, 800)
      ..devicePixelRatio = 1;
    final semantics = tester.ensureSemantics();
    final now = DateTime.now().millisecondsSinceEpoch;
    await tester.pumpWidget(
      buildSessionDetailTestPage(events: reportedBand(now)),
    );
    await tester.pumpAndSettle();

    // Below 420 the counts drop their words and the kind label yields to
    // them; the words move to the tooltip and the semantics label.
    final running = find.byKey(const Key('session-live-strip-count-running'));
    expect(
      find.descendant(of: running, matching: find.text('2')),
      findsOneWidget,
    );
    expect(find.byTooltip('2 running'), findsOneWidget);
    // The strip is one button, so the words merge into its label rather than
    // standing as a node of their own.
    expect(find.bySemanticsLabel(RegExp('2 running')), findsOneWidget);
    expect(
      find.descendant(
        of: strip('agent:bench'),
        matching: find.text('Activity'),
      ),
      findsNothing,
    );
    expect(tester.takeException(), isNull);
    semantics.dispose();
  });

  testWidgets(
    'an agent with nothing to reveal is a plain row, on every status',
    (tester) async {
      // No harness sends children for a plain agent (only Claude workflows
      // do) or output (only shells do). The card used to expand onto "Progress
      // remains live until the Server reports completion." -- beside a Done
      // pill as well as a Running one.
      useRoomyTestViewport(tester);
      final now = DateTime.now().millisecondsSinceEpoch;
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            workingSession(),
            activity(
              1,
              'agent:live',
              'Review PRs 229 and 230',
              'running',
              startedAtMs: now - 318000,
            ),
            activity(
              2,
              'agent:over',
              'Map speed reader time anchors',
              'done',
              startedAtMs: now - 523000,
              elapsedMs: 523000,
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();
      await expandBand(tester, 'agent:live');
      await toggleFinished(tester);

      for (final key in ['agent:live', 'agent:over']) {
        final card = find.byKey(
          ValueKey('session-agent-activity-activity:$key'),
        );
        expect(
          find.descendant(of: card, matching: find.byType(ExpansionTile)),
          findsNothing,
          reason: key,
        );
        expect(
          find.descendant(
            of: card,
            matching: find.byKey(const Key('session-agent-activity-row')),
          ),
          findsOneWidget,
          reason: key,
        );
        // The summary line keeps everything the card knows.
        expect(
          find.descendant(
            of: card,
            matching: find.textContaining('Background agent'),
          ),
          findsOneWidget,
          reason: key,
        );
        await tester.ensureVisible(card);
        await tester.pumpAndSettle();
        await tester.tap(card);
        await tester.pumpAndSettle();
      }
      expect(find.textContaining('remains live'), findsNothing);
    },
  );

  testWidgets('a workflow with children still expands onto them', (
    tester,
  ) async {
    useRoomyTestViewport(tester);
    await tester.pumpWidget(
      buildSessionDetailTestPage(
        events: [
          workingSession(),
          MessageWireEvent(
            seq: 1,
            message: AgentMessage.fromJson(const {
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
            }),
          ),
        ],
      ),
    );
    await tester.pumpAndSettle();
    // A fan-out of two is news, so the strip carries its progress.
    expect(
      find.byKey(const Key('session-live-strip-progress')),
      findsOneWidget,
    );
    await expandBand(tester, 'wf:review');

    final card = find.byKey(
      const ValueKey('session-agent-activity-activity:wf:review'),
    );
    expect(
      find.descendant(of: card, matching: find.byType(ExpansionTile)),
      findsOneWidget,
    );
    expect(find.text('Check the tests'), findsNothing);
    await tester.tap(
      find.descendant(of: card, matching: find.text('Review fan-out')),
    );
    await tester.pumpAndSettle();
    expect(find.text('Read the diff'), findsOneWidget);
    expect(find.text('Check the tests'), findsOneWidget);
  });

  group('SessionLiveState activity order', () {
    AgentMessage message(Map<String, Object?> json) =>
        AgentMessage.fromJson(json);

    Map<String, Object?> agent(String key, String status) => {
      'type': 'agent-activity',
      'key': key,
      'kind': 'subagent',
      'title': key,
      'status': status,
    };

    test('a swept subagent keeps its first-seen ordinal when it returns', () {
      final state = SessionLiveState.fromMessages([
        message(agent('a', 'running')),
        message(agent('b', 'running')),
        message(const {'type': 'status', 'status': 'idle'}),
        message(agent('b', 'running')),
        message(agent('a', 'running')),
      ]);

      // The list itself is map order, which the sweep reshuffled.
      expect(state.activities.map((a) => a.key), ['b', 'a']);
      expect(
        state.activityOrder('a')!.seen,
        lessThan(state.activityOrder('b')!.seen),
      );
    });

    test('the finished ordinal is set once, by the first terminal frame', () {
      var state = SessionLiveState.fromMessages([
        message(agent('a', 'running')),
        message(agent('b', 'running')),
        message(agent('b', 'done')),
        message(agent('a', 'error')),
      ]);
      final bEnded = state.activityOrder('b')!.ended!;
      expect(state.activityOrder('a')!.ended, greaterThan(bEnded));

      // A repeated terminal frame restates the outcome; it does not move it.
      state = state.applyMessage(message(agent('b', 'done')));
      expect(state.activityOrder('b')!.ended, bEnded);
      expect(state.activityOrder('a')!.ended, greaterThan(bEnded));
    });

    test('a withdrawn card drops its order entry', () {
      final state = SessionLiveState.fromMessages([
        message(agent('a', 'running')),
        message(agent('a', 'retired')),
      ]);
      expect(state.activityOrder('a'), isNull);
    });

    test('order entries for cards that never return are bounded', () {
      var state = SessionLiveState.fromMessages(const []);
      for (var index = 0; index < 200; index++) {
        state = state
            .applyMessage(message(agent('agent-$index', 'running')))
            .applyMessage(message(const {'type': 'status', 'status': 'idle'}));
      }
      expect(state.activities, isEmpty);
      // The newest swept entries survive; the oldest are pruned.
      expect(state.activityOrder('agent-199'), isNotNull);
      expect(state.activityOrder('agent-0'), isNull);
    });
  });
}

/// Counts writes so a batch dismissal can be told from one write per card.
final class InMemorySessionLiveStateViewStoreProbe
    implements SessionLiveStateViewStore {
  final Map<SessionDetailKey, Map<String, String>> _archived = {};
  int saves = 0;
  Map<String, String> lastSaved = const {};

  @override
  Future<Map<String, String>> loadArchived(SessionDetailKey sessionKey) async {
    return Map.unmodifiable(_archived[sessionKey] ?? const {});
  }

  @override
  Future<void> saveArchived(
    SessionDetailKey sessionKey,
    Map<String, String> archived,
  ) async {
    saves++;
    lastSaved = Map.of(archived);
    _archived[sessionKey] = Map.of(archived);
  }
}
