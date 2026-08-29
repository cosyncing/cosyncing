// Regression coverage for the 2026-08-28 Codex reconnect scramble.
//
// An incremental history frame shares recurring latest-wins keys
// (`metadata-update:contextUsage`, run-summary restatements) with the whole
// retained transcript. Anchoring position on those keys mapped dozens of old
// retained positions onto one new frame index and spliced the retained
// transcript into the middle of the frame's turn. Reconciliation now keeps
// two separate identity roles: every stable key deduplicates (upsert), but
// only unique transcript rows carry position. A latest-wins row is emitted at
// its LAST frame restatement so the newest state survives the bounded tail
// trim exactly as a raw reset frame's late re-emission does.
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/tool_display_mode.dart';
import 'package:flutter_test/flutter_test.dart';

AgentMessage msg(Map<String, dynamic> raw) => AgentMessage(
  type: AgentMessageType.fromWire(raw['type'] as String?),
  raw: raw,
);

/// One synthetic turn shaped like the real Codex mapping: a running run
/// summary at turn start, tool steps with a `contextUsage` telemetry row after
/// each, and a completed run summary restating the same key at turn end.
List<AgentMessage> turnRows(int n, {required int toolPairs}) => [
  msg({
    'type': 'run-summary',
    'key': 'run:T$n',
    'status': 'running',
    'turnId': 'T$n',
  }),
  msg({
    'type': 'user-message',
    'key': 'T$n:u0',
    'text': 'prompt $n',
    'turnId': 'T$n',
  }),
  msg({
    'type': 'model-output',
    'key': 'T$n:m0',
    'text': 'opening $n',
    'final': true,
  }),
  for (var i = 0; i < toolPairs; i++) ...[
    msg({
      'type': 'tool-call',
      'callId': 'T$n:c$i',
      'toolName': 'exec',
      'title': 'step $i',
    }),
    msg({'type': 'tool-result', 'callId': 'T$n:c$i', 'toolName': 'exec'}),
    msg({
      'type': 'metadata-update',
      'key': 'contextUsage',
      'value': {'used': n * 100 + i},
    }),
  ],
  msg({
    'type': 'model-output',
    'key': 'T$n:mf',
    'text': 'answer $n',
    'final': true,
  }),
  msg({
    'type': 'run-summary',
    'key': 'run:T$n',
    'status': 'done',
    'turnId': 'T$n',
    'totalRuntimeMs': n * 111000,
    'startedAt': n * 1000000,
    'completedAt': n * 1000000 + n * 111000,
    'userMessageKey': 'T$n:u0',
    'assistantMessageKey': 'T$n:mf',
    'tokens': {'input': n * 10, 'output': n},
  }),
  msg({
    'type': 'metadata-update',
    'key': 'runtimeTotals',
    'value': {'turns': n},
  }),
];

typedef TurnView = ({String opener, int? footerMs, int tools, String text});

List<TurnView> turnsOf(TranscriptHistoryWindow w) {
  final segs = w.transcriptConversationSegmentsWith(
    const [],
    const {},
    mode: ToolDisplayMode.responsive,
  );
  return [
    for (final seg in segs)
      for (final turn in seg.turns)
        (
          opener:
              (turn.userMessage?.raw['text'] ??
                      (turn.isPartial ? '<partial>' : '<no-opener>'))
                  .toString(),
          footerMs: turn.runSummary?.totalRuntimeMs,
          tools: turn.distinctToolCallCount,
          text: turn.modelText,
        ),
  ];
}

List<AgentMessage> telemetryRows(Iterable<AgentMessage> rows, String key) => [
  for (final m in rows)
    if (m.type == AgentMessageType.metadataUpdate && m.raw['key'] == key) m,
];

/// An authoritative replacement frame: attach replay, or a broker resync
/// (hub.resync sends reset + cursor since the 2026-08-28 stale-resync fix).
HistoryWireEvent reset(List<AgentMessage> m) =>
    HistoryWireEvent(messages: m, reset: true, cursor: 'cursor');

/// A cursor-bearing reconnect delta — the broker's incremental replay shape.
HistoryWireEvent delta(List<AgentMessage> m) =>
    HistoryWireEvent(messages: m, cursor: 'cursor');

/// An uncursored non-reset snapshot — the legacy hub.resync() wire shape,
/// still possible from brokers that predate the authoritative-resync fix.
HistoryWireEvent snapshot(List<AgentMessage> m) =>
    HistoryWireEvent(messages: m);

TranscriptHistoryWindow live(
  TranscriptHistoryWindow w,
  Iterable<AgentMessage> msgs,
) {
  var window = w;
  for (final m in msgs) {
    window = window.applyLiveMessage(m);
  }
  return window;
}

void main() {
  // Small fixture: three turns, no bound trims anywhere, so projections can
  // be compared exactly against a fresh full-reset attach.
  final t1 = turnRows(1, toolPairs: 4);
  final t2 = turnRows(2, toolPairs: 4);
  final t3 = turnRows(3, toolPairs: 4);
  final noon = [...t1, ...t2];
  final full = [...noon, ...t3];
  final fresh = turnsOf(
    const TranscriptHistoryWindow.uninitialized().applyHistory(reset(full)),
  );

  void expectFreshProjection(String name, TranscriptHistoryWindow w) {
    final turns = turnsOf(w);
    expect(turns, fresh, reason: '$name: complete turn projections');
    // Restated explicitly so a broken baseline cannot silently pass.
    expect(turns.map((t) => t.opener), ['prompt 1', 'prompt 2', 'prompt 3']);
    for (var n = 1; n <= 3; n++) {
      final turn = turns[n - 1];
      expect(turn.text, 'opening $n\n\nanswer $n', reason: '$name turn $n');
      expect(turn.tools, 4, reason: '$name turn $n tool cardinality');
      expect(turn.footerMs, n * 111000, reason: '$name turn $n footer');
    }
  }

  test('fresh full reset baseline projects three complete turns', () {
    expectFreshProjection(
      'baseline',
      const TranscriptHistoryWindow.uninitialized().applyHistory(reset(full)),
    );
  });

  test('reconnect suffix delta matches the fresh-attach projection', () {
    // The scramble timeline: retained noon window, suspend, reconnect after
    // turn 3, incremental frame (reset:false) whose only shared keys with the
    // retained tail are the recurring telemetry keys.
    var w = const TranscriptHistoryWindow.uninitialized().applyHistory(
      reset(noon),
    );
    w = w.applyHistory(delta(t3));
    expectFreshProjection('suffix delta', w);
  });

  test('full resync as an uncursored snapshot matches the fresh attach', () {
    // The legacy hub.resync() shape: the complete snapshot with no reset flag
    // and no cursor, flowing through the incremental-delta reconciliation.
    var w = const TranscriptHistoryWindow.uninitialized().applyHistory(
      reset(noon),
    );
    w = live(w, t3);
    w = w.applyHistory(snapshot(full));
    expectFreshProjection('full resync', w);
  });

  test('a scrambled retained window is repaired by a full snapshot', () {
    // A window corrupted by the old merge (turn 3 spliced before turns 1-2),
    // e.g. restored from a corrupted persisted cache.
    var w = const TranscriptHistoryWindow.uninitialized().applyHistory(
      reset([...t3, ...noon]),
    );
    w = w.applyHistory(snapshot(full));
    expectFreshProjection('repair', w);
  });

  test(
    'persisted-cache restore plus suffix delta matches the fresh attach',
    () {
      var w = const TranscriptHistoryWindow.uninitialized().applyHistory(
        reset(full),
      );
      w = w.applyHistory(delta(t3));
      expectFreshProjection('cache restore', w);
    },
  );

  test('telemetry keys deduplicate to one latest value and never anchor', () {
    // The naive-fix trap: excluding telemetry from the frame index entirely
    // would keep the retained copy as "uncovered" AND emit the incoming copy.
    // Upsert identity must survive even though positional anchoring does not.
    final merged = reconcileTranscriptHistoryDelta(retained: noon, frame: t3);
    final context = telemetryRows(merged, 'contextUsage');
    expect(context, hasLength(1), reason: 'one canonical telemetry row');
    expect(
      (context.single.raw['value'] as Map)['used'],
      303,
      reason: 'the latest restatement wins',
    );
    expect(telemetryRows(merged, 'runtimeTotals'), hasLength(1));
    // The frame shares no positional anchor with the retained tail, so it
    // appends after it — the same outcome live delivery would have produced.
    final keys = [
      for (final m in merged)
        if (m.type == AgentMessageType.userMessage) m.raw['key'],
    ];
    expect(keys, ['T1:u0', 'T2:u0', 'T3:u0']);
    final t3Start = merged.indexWhere((m) => m.raw['key'] == 'T3:u0');
    final t2End = merged.lastIndexWhere((m) => m.raw['callId'] == 'T2:c3');
    expect(t2End, lessThan(t3Start), reason: 'frame appends, never splices');
  });

  test('a stale uncursored snapshot never regresses latest-wins state', () {
    // The retained window holds turn 3; the frame is an older full snapshot
    // that does not — the shape of a resync read racing live delivery. The
    // frame is detected as superseded (a retained anchor it does not cover
    // sits after the last one it does), so the frame still orders the region
    // it covers, but each covered latest-wins key keeps the newer retained
    // reading — in the canonical rows, the footers, and the folded telemetry
    // projection alike.
    var w = const TranscriptHistoryWindow.uninitialized().applyHistory(
      reset(full),
    );
    w = w.applyHistory(snapshot(noon));
    expectFreshProjection('stale resync', w);
    final context = telemetryRows(w.canonicalMessages, 'contextUsage');
    expect(context, hasLength(1));
    expect(
      (context.single.raw['value'] as Map)['used'],
      303,
      reason: 'canonical telemetry keeps the newer retained reading',
    );
    final totals = telemetryRows(w.canonicalMessages, 'runtimeTotals');
    expect((totals.single.raw['value'] as Map)['turns'], 3);
    expect(
      w.telemetry.inputTokens,
      30,
      reason: 'the folded projection keeps the newest reading',
    );
  });

  test('an authoritative reset frame replaces even a disjoint window', () {
    // The broker now sends every resync as reset + cursor — including after
    // an undo, where the snapshot legitimately does NOT cover the retained
    // tail. Broker authority must win over client retention: the window and
    // the folded projections rebuild from the frame alone, and rows the
    // frame does not carry disappear.
    var w = const TranscriptHistoryWindow.uninitialized().applyHistory(
      reset(full),
    );
    w = w.applyHistory(reset(noon));
    final turns = turnsOf(w);
    expect(turns.map((t) => t.opener), ['prompt 1', 'prompt 2']);
    final context = telemetryRows(w.canonicalMessages, 'contextUsage');
    expect((context.single.raw['value'] as Map)['used'], 203);
    expect(
      w.telemetry.inputTokens,
      20,
      reason: 'projections rebuild from the authoritative frame',
    );
  });

  test('a disjoint stale snapshot reads as a suffix (documented residual)', () {
    // DOCUMENTED RESIDUAL (2026-08-28 disjoint-stale review finding): a stale
    // uncursored snapshot that shares NO positional anchor with the retained
    // tail — a bounded 100-row tail whose overlap was pushed out by enough
    // intervening output — has exactly the shape of a genuine new suffix, and
    // content alone cannot tell the two apart. The client appends it, as it
    // must append a real suffix. This is why hub.resync() now serializes with
    // live delivery and marks its snapshot `reset`: the ambiguous shape can
    // only arrive from a broker that predates that fix. This pin exists so
    // any future client-side heuristic here is a deliberate change.
    var w = const TranscriptHistoryWindow.uninitialized().applyHistory(
      reset([...t2, ...t3]),
    );
    w = w.applyHistory(snapshot(t1)); // stale, covers only the evicted turn 1
    final turns = turnsOf(w);
    expect(turns.map((t) => t.opener), ['prompt 2', 'prompt 3', 'prompt 1']);
    expect(
      w.telemetry.inputTokens,
      10,
      reason: 'the fold cannot know the disjoint frame is stale',
    );
  });

  test('a completed run summary is emitted at its latest restatement', () {
    // The footer for a bounded window's oldest visible turn depends on the
    // completed summary surviving the tail trim, exactly as the raw reset
    // frame's late re-emission does.
    final merged = reconcileTranscriptHistoryDelta(
      retained: const [],
      frame: full,
    );
    final summaryIndex = merged.indexWhere((m) => m.raw['key'] == 'run:T1');
    final finalIndex = merged.indexWhere((m) => m.raw['key'] == 'T1:mf');
    expect(summaryIndex, greaterThan(finalIndex));
    expect(
      merged.where((m) => m.raw['key'] == 'run:T1'),
      hasLength(1),
      reason: 'running and done restatements collapse to one row',
    );
  });

  test('the oldest visible footer survives a full resync across the trim', () {
    // Big fixture: the merged snapshot exceeds the retained tail bound, so
    // the trim evicts the window head. Before the fix the completed summary
    // collapsed to its turn-start position and fell off the tail: the first
    // turn lost its footer after every resync while a fresh attach kept it.
    final big1 = turnRows(1, toolPairs: 16);
    final big2 = turnRows(2, toolPairs: 16);
    final big3 = turnRows(3, toolPairs: 16);
    final bigFull = [...big1, ...big2, ...big3];
    var w = const TranscriptHistoryWindow.uninitialized().applyHistory(
      reset([...big1, ...big2]),
    );
    w = live(w, big3);
    w = w.applyHistory(delta(bigFull));
    expect(
      w.messageCount,
      lessThanOrEqualTo(kRetainedTranscriptTailMessages),
      reason: 'bounded raw retention',
    );
    final turns = turnsOf(w);
    expect(
      turns.first.footerMs,
      111000,
      reason: 'oldest visible turn keeps its footer',
    );
    expect(
      turns.map((t) => t.footerMs).toList(),
      [111000, 222000, 333000],
    );
    expect(
      turns.last.text,
      'opening 3\n\nanswer 3',
      reason: 'the newest turn stays whole and last',
    );
  });
}
