// Real-frame reconnect-order probe for the 2026-08-28 Codex scramble.
//
// Replays frames generated from a real Codex rollout (see
// docs-internal/active/investigations/2026-08-28-claude-code-codex-regression/
// gen-frames.ts) through the production transcript window and asserts complete
// turn projections. Point COSYNCING_TEST_SCRAMBLE_FRAMES at a generated
// frames.json to run it; it skips otherwise. The always-on synthetic coverage
// lives in
// test/src/features/sessions/detail/transcript_history_reconcile_test.dart.
import 'dart:convert';
import 'dart:io';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/tool_display_mode.dart';
import 'package:flutter_test/flutter_test.dart';

final String? framesPath =
    Platform.environment['COSYNCING_TEST_SCRAMBLE_FRAMES'];

List<AgentMessage> _list(dynamic j) => (j as List)
    .map((e) => AgentMessage.fromJson((e as Map).cast<String, dynamic>()))
    .toList();

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

int _telemetryRows(TranscriptHistoryWindow w, String key) => w.canonicalMessages
    .where(
      (m) => m.type == AgentMessageType.metadataUpdate && m.raw['key'] == key,
    )
    .length;

void main() {
  final path = framesPath;
  if (path == null || !File(path).existsSync()) {
    test('real-frame probe (skipped: fixture absent)', () {});
    return;
  }
  final file = File(path);
  final frames = jsonDecode(file.readAsStringSync()) as Map<String, dynamic>;
  final histA = _list(frames['histA']);
  final histB = _list(frames['histB']);
  final suffix = _list((frames['frameB_sinceA'] as Map)['messages']);
  final cursorA = (frames['deltaA'] as Map)['cursor'] as String?;
  final cursorB = (frames['frameB_full'] as Map)['cursor'] as String?;

  const u2 = 'do help me post these to the PR to ask for changes.';
  const u3 = 'review again now';
  const turn1FooterMs = 1347985;
  const turn2FooterMs = 529614;
  const turn3FooterMs = 1007582;

  HistoryWireEvent reset(List<AgentMessage> m, {String? cursor}) =>
      HistoryWireEvent(messages: m, reset: true, cursor: cursor);
  HistoryWireEvent delta(List<AgentMessage> m, {String? cursor}) =>
      HistoryWireEvent(messages: m, cursor: cursor);

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

  void expectEveningShape(String name, TranscriptHistoryWindow w) {
    final turns = turnsOf(w);
    expect(
      turns.map((t) => t.opener).toList(),
      ['<partial>', u2, u3],
      reason: '$name: turn openers must stay chronological',
    );
    // The re-review content belongs to the "review again now" turn alone.
    expect(turns[1].text, contains('I’ll submit one'), reason: name);
    expect(turns[1].text, contains('Posted successfully'), reason: name);
    expect(turns[1].text, isNot(contains('Re-review result')), reason: name);
    expect(turns[1].text, isNot(contains('The author added')), reason: name);
    expect(turns[2].text, contains('I’ll re-review the latest'), reason: name);
    expect(turns[2].text, contains('Re-review result'), reason: name);
    // Footer association and tool cardinality.
    expect(turns[0].footerMs, turn1FooterMs, reason: '$name: turn-1 footer');
    expect(turns[1].footerMs, turn2FooterMs, reason: '$name: turn-2 footer');
    expect(turns[2].footerMs, turn3FooterMs, reason: '$name: turn-3 footer');
    expect(turns[1].tools, 3, reason: '$name: turn-2 tool cardinality');
    expect(turns[2].tools, 10, reason: '$name: turn-3 tool cardinality');
    // One latest canonical telemetry row, bounded raw retention.
    expect(_telemetryRows(w, 'contextUsage'), 1, reason: name);
    expect(
      w.messageCount,
      lessThanOrEqualTo(kRetainedTranscriptTailMessages),
      reason: '$name: bounded retention',
    );
  }

  test('real-frame reconnect and resync scenarios stay ordered', () {
    // S1: fresh evening attach (full reset replay).
    final s1 = const TranscriptHistoryWindow.uninitialized().applyHistory(
      reset(histB, cursor: cursorB),
    );
    expectEveningShape('S1 evening full reset', s1);

    // S2: noon attach + turn 3 delivered live.
    var s2 = const TranscriptHistoryWindow.uninitialized().applyHistory(
      reset(histA, cursor: cursorA),
    );
    s2 = live(s2, suffix);
    expectEveningShape('S2 noon reset + live turn3', s2);

    // S3: the LEGACY hub.resync() shape (brokers predating the 2026-08-28
    // authoritative-resync fix) — the full snapshot arrives as an UNCURSORED
    // non-reset frame. Contents must match a fresh attach, including the
    // first turn's footer (regression: the completed run summary used to
    // collapse to its turn-start position and fall off the bounded tail).
    expectEveningShape(
      'S3 live + resync(full) as delta',
      s2.applyHistory(delta(histB)),
    );

    // S5: the user's timeline — suspend at noon, reconnect after the
    // re-review, receive the incremental suffix (reset:false).
    var s5 = const TranscriptHistoryWindow.uninitialized().applyHistory(
      reset(histA, cursor: cursorA),
    );
    s5 = s5.applyHistory(delta(suffix, cursor: cursorB));
    expectEveningShape('S5 noon window + reconnect suffix delta', s5);

    // S6: live turn 3 already retained, then the same suffix replays as a
    // delta (reattach after a brief drop).
    expectEveningShape(
      'S6 live turn3 + suffix delta replay',
      s2.applyHistory(delta(suffix, cursor: cursorB)),
    );

    // S7: persisted-cache restore (bounded snapshot) + suffix delta.
    final cached = [...histA, ...suffix];
    final tail = cached.length > 500
        ? cached.sublist(cached.length - 500)
        : cached;
    var s7 = const TranscriptHistoryWindow.uninitialized().applyHistory(
      reset(tail, cursor: cursorB),
    );
    s7 = s7.applyHistory(delta(suffix, cursor: cursorB));
    expectEveningShape('S7 cache restore + suffix delta', s7);

    // S9: a window that is ALREADY scrambled (old-bug state, restored from a
    // corrupted cache) is repaired by the next full snapshot delta. Kept to
    // 100 rows so the inverted order survives the reset trim intact.
    final scrambled = [...suffix, ...histA.sublist(161)];
    final s9 = const TranscriptHistoryWindow.uninitialized().applyHistory(
      reset(scrambled, cursor: cursorB),
    );
    expectEveningShape(
      'S9 scrambled cache + full resync delta',
      s9.applyHistory(delta(histB)),
    );

    // S4: a STALE legacy resync (noon snapshot, uncursored non-reset) after
    // turn 3 was retained must not reorder, must keep every footer and tool
    // count, and must not regress latest-wins telemetry to the stale frame's
    // older readings. Current brokers serialize resyncs and mark them reset;
    // this shape survives only from older brokers.
    final s4 = s2.applyHistory(delta(histA));
    expectEveningShape('S4 stale resync(full A) as delta', s4);
    AgentMessage latestTelemetry(List<AgentMessage> rows, String key) =>
        rows.lastWhere(
          (m) =>
              m.type == AgentMessageType.metadataUpdate && m.raw['key'] == key,
        );
    AgentMessage canonicalTelemetry(TranscriptHistoryWindow w, String key) =>
        w.canonicalMessages.lastWhere(
          (m) =>
              m.type == AgentMessageType.metadataUpdate && m.raw['key'] == key,
        );
    expect(
      canonicalTelemetry(s4, 'contextUsage').raw,
      latestTelemetry(histB, 'contextUsage').raw,
      reason: 'S4: contextUsage must keep the newer retained reading',
    );
    expect(
      canonicalTelemetry(s4, 'runtimeTotals').raw,
      latestTelemetry(histB, 'runtimeTotals').raw,
      reason: 'S4: runtimeTotals must keep the newer retained reading',
    );
  });
}
