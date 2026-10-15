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
