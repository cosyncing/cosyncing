// Permanent session-truth conformance boundary — client half.
//
// This file is the client half of the required session-truth conformance
// suite. One turn of user -> commentary -> two tool call/result pairs ->
// final response is driven through every delivery mix below. The final
// response must remain after every tool row in canonical AND displayed
// order, with no duplicate rows, no lost streamed text, and unchanged
// call/result pairing. Order may only ever come from the authoritative
// history frame — never from timestamps, message text, tool names, or
// arrival timing. Reverting the authoritative-order reconciliation (for
// example restoring append-only `next.add(message)` placement) MUST fail
// the named tests in the `transcript chronology` and `subagent sessions`
// groups below.
//
// The merge path is session-agnostic: a subagent session is just another
// SessionDetailKey through the same SessionDetailController /
// TranscriptHistoryWindow pipeline, and `SessionInfo.origin ==
// SessionOrigin.subagent` gates only UI affordances. The `subagent
// sessions` group proves main and subagent sessions obey IDENTICAL
// chronology rules by replaying the C1R2 recovery cases against a
// subagent-keyed controller.
//
// The `display turn projection` group pins the display-only mid-turn steer
// boundary: a prompt delivered while the previous turn was still running is
// displayed just after the last output owned by an earlier prompt. Reordering
// a displaced delivered prompt by wall-clock timestamp MUST fail the named
// tests there.

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_conversation_turns.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_transcript_display.dart';
import 'package:cosyncing_client/src/features/sessions/model/tool_display_mode.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_controller_test_harness.dart';

AgentMessage _user(String key) => AgentMessage.fromJson({
  'type': 'user-message',
  'key': key,
  'text': 'prompt $key',
});

AgentMessage _model(String key, String text) => AgentMessage.fromJson({
  'type': 'model-output',
  'key': key,
  'text': text,
});

AgentMessage _call(String callId) => AgentMessage.fromJson({
  'type': 'tool-call',
  'callId': callId,
  'toolName': 'shell',
  'title': 'call $callId',
});

AgentMessage _result(String callId) => AgentMessage.fromJson({
  'type': 'tool-result',
  'callId': callId,
  'toolName': 'shell',
  'output': 'result $callId',
});

/// The native rollout order the adapter mapper already preserves.
List<AgentMessage> _authoritativeTurn() => [
  _user('u1'),
  _model('c1', 'commentary'),
  _call('call-1'),
  _result('call-1'),
  _call('call-2'),
  _result('call-2'),
  _model('f1', 'final response'),
];

List<String> _stableKeys(Iterable<AgentMessage> messages) => [
  for (final message in messages) stableTranscriptMessageKey(message)!,
];

List<String> _authoritativeKeys() => _stableKeys(_authoritativeTurn());

/// What the append-only merge persisted before this correction: the final
/// response retained from live delivery, then every recovered tool row
/// appended behind it.
List<AgentMessage> _malformedPersistedTail() => [
  _user('u1'),
  _model('c1', 'commentary'),
  _model('f1', 'final response'),
  _call('call-1'),
  _result('call-1'),
  _call('call-2'),
  _result('call-2'),
];

void _expectNoDuplicateRetainedRows(TranscriptHistoryWindow window) {
  final retained = [for (final page in window.pages) ...page.messages];
  final counts = <String, int>{};
  for (final message in retained) {
    final key = stableTranscriptMessageKey(message);
    if (key == null) continue;
    counts[key] = (counts[key] ?? 0) + 1;
  }
  expect(
    counts.entries.where((entry) => entry.value > 1).map((e) => e.key),
    isEmpty,
    reason: 'no stable key may be retained twice',
  );
}

void _expectPairing(List<AgentMessage> canonical) {
  for (final callId in const ['call-1', 'call-2']) {
    final callIndex = canonical.indexWhere(
      (message) =>
          message.type == AgentMessageType.toolCall &&
          message.raw['callId'] == callId,
    );
    expect(callIndex, greaterThanOrEqualTo(0), reason: '$callId present');
    final next = canonical[callIndex + 1];
    expect(next.type, AgentMessageType.toolResult, reason: '$callId pairing');
    expect(next.raw['callId'], callId, reason: '$callId pairing');
  }
}

void _expectAuthoritativeChronology(
  TranscriptHistoryWindow window, {
  List<String> prefixKeys = const [],
}) {
  final expectedKeys = [...prefixKeys, ..._authoritativeKeys()];
  final canonical = window.transcriptMessages;
  expect(
    _stableKeys(canonical),
    expectedKeys,
    reason: 'canonical order is the authoritative native order',
  );
  final displayed = window.transcriptMessagesWith(const [], const {});
  expect(
    _stableKeys(displayed),
    expectedKeys,
    reason: 'displayed order is the authoritative native order',
  );
  _expectNoDuplicateRetainedRows(window);
  _expectPairing(canonical);
  expect(
    canonical.last.raw['text'],
    'final response',
    reason: 'no streamed or recovered text is lost',
  );
}

void main() {
  group('session-truth conformance', () {
    group('transcript chronology', () {
      test('live-only delivery keeps native order', () {
        var window = const TranscriptHistoryWindow.uninitialized();
        for (final message in _authoritativeTurn()) {
          window = window.applyLiveMessage(message);
        }

        _expectAuthoritativeChronology(window);
      });

      test('history-only attach keeps native order', () {
        final window = TranscriptHistoryWindow.fromHistory(
          HistoryWireEvent(
            messages: _authoritativeTurn(),
            reset: true,
            cursor: 'attach-cursor',
          ),
        );

        _expectAuthoritativeChronology(window);
      });

      test(
        'incremental history recovers missed-live tool rows before the '
        'retained final response',
        () {
          var window = const TranscriptHistoryWindow.uninitialized();
          window = window.applyLiveMessage(_user('u1'));
          window = window.applyLiveMessage(_model('c1', 'commentary'));
          // The final response streams in live while the tool rows never do.
          window = window.applyLiveMessage(
            AgentMessage.fromJson({
              'type': 'model-output',
              'key': 'f1',
              'delta': 'final ',
            }),
          );
          window = window.applyLiveMessage(
            AgentMessage.fromJson({
              'type': 'model-output',
              'key': 'f1',
              'delta': 'response',
            }),
          );
          expect(
            _stableKeys(window.transcriptMessages),
            [
              'user-message:key:u1',
              'model-output:key:c1',
              'model-output:key:f1',
            ],
            reason: 'setup: the malformed pre-recovery state is live-only',
          );

          window = window.applyHistory(
            HistoryWireEvent(
              messages: _authoritativeTurn(),
              cursor: 'recovery-cursor',
            ),
          );

          _expectAuthoritativeChronology(window);
          expect(window.historyCursor, 'recovery-cursor');
        },
      );

      test(
        'history/live overlap with duplicate stable keys keeps one row each '
        'in native order',
        () {
          var window = const TranscriptHistoryWindow.uninitialized();
          for (final message in [
            _user('u1'),
            _model('c1', 'commentary'),
            _call('call-1'),
          ]) {
            window = window.applyLiveMessage(message);
          }

          window = window.applyHistory(
            HistoryWireEvent(
              messages: [
                _model('c1', 'commentary'),
                _call('call-1'),
                _result('call-1'),
                _call('call-2'),
                _result('call-2'),
                _model('f1', 'final response'),
              ],
              cursor: 'overlap-cursor',
            ),
          );

          _expectAuthoritativeChronology(window);
        },
      );

      test('reconnect reset replay remains an authoritative replacement', () {
        var window = const TranscriptHistoryWindow.uninitialized();
        for (final message in [
          _user('u1'),
          _model('c1', 'commentary'),
          _model('f1', 'final response'),
        ]) {
          window = window.applyLiveMessage(message);
        }

        window = window.applyHistory(
          HistoryWireEvent(
            messages: _authoritativeTurn(),
            reset: true,
            cursor: 'reconnect-cursor',
          ),
        );

        _expectAuthoritativeChronology(window);
        expect(window.historyCursor, 'reconnect-cursor');
      });

      test(
        'persisted-cache restore repairs under incremental reconciliation',
        () {
          final restored = TranscriptHistoryWindow.fromHistory(
            HistoryWireEvent(
              messages: _malformedPersistedTail(),
              reset: true,
              cursor: 'cached-cursor',
            ),
          );
          expect(
            _stableKeys(restored.transcriptMessages),
            _stableKeys(_malformedPersistedTail()),
            reason: 'setup: the restore itself replays the persisted order',
          );

          final repaired = restored.applyHistory(
            HistoryWireEvent(
              messages: _authoritativeTurn(),
              cursor: 'recovery-cursor',
            ),
          );

          _expectAuthoritativeChronology(repaired);
        },
      );

      test(
        'controller repair reaches the displayed window and the persisted '
        'snapshot after a cache restore',
        () async {
          const key = SessionDetailKey(tool: 'codex', sessionId: 'session-1');
          final connection = FakeSessionDetailConnection();
          final transcriptRepository = RecordingSessionTranscriptRepository()
            ..stored = SessionTranscriptSnapshot(
              brokerProfileId: fakeControllerBrokerScope(),
              sessionKey: key,
              messages: _malformedPersistedTail(),
              cursor: 'cached-cursor',
              hasEarlier: false,
              updatedAt: DateTime.utc(2026, 8, 4),
            );
          final container = buildControllerContainer(
            key,
            connection,
            FakeControllerAttachmentPicker(),
            transcriptRepository: transcriptRepository,
          );
          addTearDown(container.dispose);
          keepSessionDetailAlive(container, key);

          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();
          await drainSessionDetailMicrotasks();

          final restored = container.read(sessionDetailControllerProvider(key));
          expect(
            _stableKeys(restored.transcriptWindow.transcriptMessages),
            _stableKeys(_malformedPersistedTail()),
            reason: 'setup: hydration replays the malformed persisted order',
          );

          connection.emitEvent(
            HistoryWireEvent(
              messages: _authoritativeTurn(),
              cursor: 'recovery-cursor',
            ),
          );
          await drainSessionDetailMicrotasks();
          await drainSessionDetailMicrotasks();

          _expectAuthoritativeChronology(
            container
                .read(sessionDetailControllerProvider(key))
                .transcriptWindow,
          );
          expect(
            _stableKeys(transcriptRepository.stored!.messages),
            _authoritativeKeys(),
            reason: 'the repaired order is what gets persisted again',
          );
        },
      );

      test(
        'reconciliation repairs the bounded tail without disturbing an older '
        'page boundary',
        () {
          var window = TranscriptHistoryWindow.fromHistory(
            HistoryWireEvent(
              messages: [_user('u1'), _model('c1', 'commentary')],
              reset: true,
              cursor: 'tail-cursor',
              olderCursor: 'page-1',
              hasEarlier: true,
            ),
          );
          final mutation = window.prependPage(
            HistoryPageWireEvent(
              messages: [_user('older-1')],
              cursor: 'page-0',
              hasMore: false,
              endOfHistory: true,
            ),
            requestedCursor: 'page-1',
          );
          expect(mutation.accepted, isTrue);
          window = mutation.window;
          final olderPageBefore = window.pages.first;

          // The final response is retained from live delivery before the
          // incremental frame recovers the tool rows.
          window = window.applyLiveMessage(_model('f1', 'final response'));
          window = window.applyHistory(
            HistoryWireEvent(
              messages: _authoritativeTurn(),
              cursor: 'recovery-cursor',
            ),
          );

          expect(window.pages.length, 2);
          expect(
            identical(window.pages.first, olderPageBefore),
            isTrue,
            reason: 'the older page payload and cursors are untouched',
          );
          _expectAuthoritativeChronology(
            window,
            prefixKeys: const ['user-message:key:older-1'],
          );
        },
      );

      test(
        'recovery inside a full bounded tail evicts from the front and keeps '
        'the final response after every tool row',
        () {
          final filler = [
            for (var index = 0; index < 97; index++)
              _model('g$index', 'filler $index'),
          ];
          var window = TranscriptHistoryWindow.fromHistory(
            HistoryWireEvent(
              messages: [...filler, _user('u1'), _model('c1', 'commentary')],
              reset: true,
              cursor: 'tail-cursor',
              olderCursor: 'page-1',
              hasEarlier: true,
            ),
          );
          // 99 retained rows; the live final response fills the tail to the
          // 100-row cap before the tool rows are recovered.
          window = window.applyLiveMessage(_model('f1', 'final response'));
          expect(
            window.messageCount,
            kRetainedTranscriptTailMessages,
            reason: 'setup: the retained tail sits exactly at the cap',
          );

          window = window.applyHistory(
            HistoryWireEvent(
              messages: _authoritativeTurn(),
              cursor: 'recovery-cursor',
            ),
          );

          expect(
            window.messageCount,
            lessThanOrEqualTo(kRetainedTranscriptTailMessages),
          );
          expect(
            window.estimatedBytes,
            lessThanOrEqualTo(kMaxActiveTranscriptDecodedBytes),
          );
          expect(window.tailPrefixEvicted, isTrue);
          expect(
            window.leadingGap?.kind,
            TranscriptHistoryGapKind.reconnectRequired,
          );
          // Four recovered rows evict the four oldest filler rows (g0-g3).
          _expectAuthoritativeChronology(
            window,
            prefixKeys: [
              for (var index = 4; index < 97; index++)
                'model-output:key:g$index',
            ],
          );
        },
      );
    });

    group('run identity', () {
      // R0c.4 round 4: canonical run identity across reused Codex turn
      // generations.
      //
      // Canonical transcript identity is exactly type+key
      // ([stableTranscriptMessageKey]), and the projection MERGES equal pairs
      // — by design, so a redelivered frame updates its row instead of
      // duplicating it. That same merge is what makes a reused turn id
      // dangerous: two genuinely distinct generations sharing one
      // `codex:run:<id>` key collapse into one row, the second footer
      // silently replacing the first. The adapter therefore
      // generation-qualifies the second generation's key (`…@g2`); these
      // tests pin the projection half of that contract with the production
      // reducer.
      SessionDetailState stateWith(List<String> runKeys) => SessionDetailState(
        tool: 'codex',
        sessionId: 'session-run-identity',
        events: [
          for (final (index, key) in runKeys.indexed)
            MessageWireEvent(
              seq: index + 1,
              message: AgentMessage(
                type: AgentMessageType.runSummary,
                raw: {
                  'type': 'run-summary',
                  'key': key,
                  'turnId': 'turn-reused',
                  'status': 'done',
                  'completedAt': 1754000000000 + index * 30000,
                },
              ),
            ),
        ],
      );

      List<AgentMessage> summaries(SessionDetailState state) => state
          .transcriptMessageEvents
          .where((m) => m.type == AgentMessageType.runSummary)
          .toList();

      test('equal run keys merge into one row — the redelivery contract', () {
        final state = stateWith([
          'codex:run:turn-reused',
          'codex:run:turn-reused',
        ]);
        final rows = summaries(state);
        expect(rows, hasLength(1));
        // The later emission won the merge: that is exactly the replacement a
        // reused generation would suffer under a shared key.
        expect(rows.single.raw['completedAt'], 1754000030000);
      });

      test(
        'generation-qualified keys keep two reused generations distinct',
        () {
          final state = stateWith([
            'codex:run:turn-reused',
            'codex:run:turn-reused@g2',
          ]);
          final rows = summaries(state);
          expect(rows, hasLength(2));
          expect(rows[0].raw['key'], 'codex:run:turn-reused');
          expect(rows[1].raw['key'], 'codex:run:turn-reused@g2');
          // Both footers survive with their own terminal evidence.
          expect(rows[0].raw['completedAt'], 1754000000000);
          expect(rows[1].raw['completedAt'], 1754000030000);
        },
      );
    });

    group('subagent sessions', () {
      // A subagent session is just another SessionDetailKey through the same
      // SessionDetailController / TranscriptHistoryWindow pipeline;
      // `SessionInfo.origin == SessionOrigin.subagent` gates only UI
      // affordances (fork refusal, action visibility). These tests replay the
      // C1R2 recovery cases against a subagent-keyed controller to prove the
      // chronology rules are IDENTICAL for main and subagent sessions.
      SessionWireEvent subagentSessionEvent(String sessionId) =>
          SessionWireEvent(
            info: SessionInfo.fromJson({
              'id': sessionId,
              'tool': 'codex',
              'title': 'Subagent session',
              'status': 'working',
              'attachMode': 'observe',
              'origin': 'subagent',
              'parentThreadId': 'session-1',
            }),
          );

      test(
        'incremental history recovers missed-live tool rows before the '
        'retained final response',
        () async {
          const key = SessionDetailKey(
            tool: 'codex',
            sessionId: 'subagent-session-1',
          );
          final connection = FakeSessionDetailConnection();
          final container = buildControllerContainer(
            key,
            connection,
            FakeControllerAttachmentPicker(),
          );
          addTearDown(container.dispose);
          keepSessionDetailAlive(container, key);

          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();
          await drainSessionDetailMicrotasks();

          // Register the origin: this gates UI affordances only and must not
          // change how the transcript merge orders rows.
          connection.emitEvent(subagentSessionEvent(key.sessionId));
          var seq = 0;
          void emitLive(AgentMessage message) {
            connection.emitEvent(
              MessageWireEvent(seq: ++seq, message: message),
            );
          }

          emitLive(_user('u1'));
          emitLive(_model('c1', 'commentary'));
          // The final response streams in live while the tool rows never do.
          emitLive(
            AgentMessage.fromJson({
              'type': 'model-output',
              'key': 'f1',
              'delta': 'final ',
            }),
          );
          emitLive(
            AgentMessage.fromJson({
              'type': 'model-output',
              'key': 'f1',
              'delta': 'response',
            }),
          );
          await drainSessionDetailMicrotasks();

          final liveOnly = container.read(sessionDetailControllerProvider(key));
          expect(
            liveOnly.sessionInfo?.origin,
            SessionOrigin.subagent,
            reason: 'setup: the controller session is a subagent session',
          );
          expect(
            _stableKeys(liveOnly.transcriptWindow.transcriptMessages),
            [
              'user-message:key:u1',
              'model-output:key:c1',
              'model-output:key:f1',
            ],
            reason: 'setup: the malformed pre-recovery state is live-only',
          );

          connection.emitEvent(
            HistoryWireEvent(
              messages: _authoritativeTurn(),
              cursor: 'recovery-cursor',
            ),
          );
          await drainSessionDetailMicrotasks();
          await drainSessionDetailMicrotasks();

          final repaired = container.read(
            sessionDetailControllerProvider(key),
          );
          _expectAuthoritativeChronology(repaired.transcriptWindow);
          expect(
            repaired.sessionInfo?.origin,
            SessionOrigin.subagent,
            reason: 'recovery leaves the subagent identity untouched',
          );
        },
      );

      test(
        'persisted-cache restore repairs under incremental reconciliation',
        () async {
          const key = SessionDetailKey(
            tool: 'codex',
            sessionId: 'subagent-session-2',
          );
          final connection = FakeSessionDetailConnection();
          final transcriptRepository = RecordingSessionTranscriptRepository()
            ..stored = SessionTranscriptSnapshot(
              brokerProfileId: fakeControllerBrokerScope(),
              sessionKey: key,
              messages: _malformedPersistedTail(),
              cursor: 'cached-cursor',
              hasEarlier: false,
              updatedAt: DateTime.utc(2026, 8, 4),
            );
          final container = buildControllerContainer(
            key,
            connection,
            FakeControllerAttachmentPicker(),
            transcriptRepository: transcriptRepository,
          );
          addTearDown(container.dispose);
          keepSessionDetailAlive(container, key);

          await container
              .read(sessionDetailControllerProvider(key).notifier)
              .attach();
          await drainSessionDetailMicrotasks();

          connection.emitEvent(subagentSessionEvent(key.sessionId));
          await drainSessionDetailMicrotasks();

          final restored = container.read(sessionDetailControllerProvider(key));
          expect(
            restored.sessionInfo?.origin,
            SessionOrigin.subagent,
            reason: 'setup: the controller session is a subagent session',
          );
          expect(
            restored.isAgentOwnedSession,
            isTrue,
            reason: 'origin gates UI affordances — not transcript chronology',
          );
          expect(
            _stableKeys(restored.transcriptWindow.transcriptMessages),
            _stableKeys(_malformedPersistedTail()),
            reason: 'setup: hydration replays the malformed persisted order',
          );

          connection.emitEvent(
            HistoryWireEvent(
              messages: _authoritativeTurn(),
              cursor: 'recovery-cursor',
            ),
          );
          await drainSessionDetailMicrotasks();
          await drainSessionDetailMicrotasks();

          _expectAuthoritativeChronology(
            container
                .read(sessionDetailControllerProvider(key))
                .transcriptWindow,
          );
          expect(
            _stableKeys(transcriptRepository.stored!.messages),
            _authoritativeKeys(),
            reason: 'the repaired order is what gets persisted again',
          );
        },
      );
    });

    group('display turn projection', () {
      // Mid-turn steer boundary: a prompt delivered while the previous
      // turn was still running is re-emitted at its queued slot in the
      // canonical list, above that turn's later output. The production
      // projection (`transcriptConversationSegmentsWith` →
      // `buildConversationTurns` → `_reorderDeliveredPrompts`) moves it to
      // just after the last output owned by an earlier prompt, using
      // run-summary `assistantMessageKey → userMessageKey` linkage and exact
      // native turn ids. Wall-clock fields never participate: these tests
      // fail if displaced delivered prompts are ever ordered by timestamp.
      AgentMessage prompt(
        String key,
        String text, {
        String? turnId,
        int? timestamp,
      }) => AgentMessage.fromJson({
        'type': 'user-message',
        'key': key,
        'text': text,
        if (turnId != null) 'turnId': turnId,
        if (timestamp != null) 'timestamp': timestamp,
      });

      AgentMessage output(String key, String text, {int? timestamp}) =>
          AgentMessage.fromJson({
            'type': 'model-output',
            'key': key,
            'text': text,
            'final': true,
            if (timestamp != null) 'timestamp': timestamp,
          });

      AgentMessage summary({
        required String status,
        String? turnId,
        String? userMessageKey,
        String? assistantMessageKey,
        int? totalRuntimeMs,
        int? completedAt,
      }) => AgentMessage.fromJson({
        'type': 'run-summary',
        'key':
            'rs-${assistantMessageKey ?? userMessageKey ?? turnId ?? status}',
        'status': status,
        if (turnId != null) 'turnId': turnId,
        if (userMessageKey != null) 'userMessageKey': userMessageKey,
        if (assistantMessageKey != null)
          'assistantMessageKey': assistantMessageKey,
        if (totalRuntimeMs != null) 'totalRuntimeMs': totalRuntimeMs,
        if (completedAt != null) 'completedAt': completedAt,
      });

      TranscriptHistoryWindow windowOf(List<AgentMessage> messages) {
        var window = const TranscriptHistoryWindow.uninitialized();
        for (final message in messages) {
          window = window.applyLiveMessage(message);
        }
        return window;
      }

      List<ConversationTurn> displayedTurns(TranscriptHistoryWindow window) => [
        for (final segment in window.transcriptConversationSegmentsWith(
          const [],
          const {},
          mode: ToolDisplayMode.responsive,
        ))
          ...segment.turns,
      ];

      List<String> contentKeys(ConversationTurn turn) => [
        for (final entry
            in turn.content.whereType<MessageTranscriptDisplayEntry>())
          if (entry.message.raw['key'] case final String key) key,
      ];

      /// Canonical delivery mix of one mid-turn steer: `u2` was typed while
      /// turn one ran, so the broker re-emitted it at its queued slot above
      /// turn one's later output `m2`. The run summaries own `m2` to `u1`
      /// (turn-1) and `m3` to `u2` (turn-2).
      List<AgentMessage> steerFixture({required int steerTimestamp}) => [
        prompt('u1', 'First', turnId: 'turn-1', timestamp: 1000),
        output('m1', 'Preamble', timestamp: 2000),
        prompt('u2', 'Steer', timestamp: steerTimestamp),
        output('m2', 'Turn-one final', timestamp: 3000),
        summary(
          status: 'done',
          turnId: 'turn-1',
          userMessageKey: 'u1',
          assistantMessageKey: 'm2',
          totalRuntimeMs: 100,
          completedAt: 4000,
        ),
        output('m3', 'Steer answer', timestamp: 5000),
        summary(
          status: 'done',
          turnId: 'turn-2',
          userMessageKey: 'u2',
          assistantMessageKey: 'm3',
          totalRuntimeMs: 200,
          completedAt: 6000,
        ),
      ];

      const steerCanonicalKeys = [
        'user-message:key:u1',
        'model-output:key:m1',
        'user-message:key:u2',
        'model-output:key:m2',
        'run-summary:key:rs-m2',
        'model-output:key:m3',
        'run-summary:key:rs-m3',
      ];

      void expectSteerBoundary(
        TranscriptHistoryWindow window,
        List<ConversationTurn> turns,
      ) {
        expect(
          _stableKeys(window.transcriptMessages),
          steerCanonicalKeys,
          reason: 'the projection never mutates the canonical list',
        );
        expect(turns, hasLength(2), reason: 'the steer opens one new turn');
        expect(turns[0].userMessage?.raw['key'], 'u1');
        expect(
          contentKeys(turns[0]),
          ['m1', 'm2'],
          reason: "turn one keeps its full output above the steer's bubble",
        );
        expect(turns[0].modelText, 'Preamble\n\nTurn-one final');
        expect(turns[0].runSummary?.totalRuntimeMs, 100);
        expect(
          turns[1].userMessage?.raw['key'],
          'u2',
          reason:
              'the steer displays just after the last earlier-owned '
              'output, at its exact boundary',
        );
        expect(contentKeys(turns[1]), ['m3']);
        expect(turns[1].modelText, 'Steer answer');
        expect(turns[1].runSummary?.totalRuntimeMs, 200);
      }

      test(
        'a mid-turn steer displays just after the last earlier-owned output',
        () {
          // The steer was typed mid-turn, so its wall-clock sits between the
          // earlier turn's outputs — placement still comes only from run
          // ownership, never from the timestamps.
          final window = windowOf(steerFixture(steerTimestamp: 2500));

          expectSteerBoundary(window, displayedTurns(window));
        },
      );

      test(
        'equal or older wall-clock timestamps never reorder a mid-turn steer',
        () {
          // 2000 equals m1's wall-clock; 1500 is older than every earlier
          // output. Placement must be identical either way: timestamps never
          // determine order.
          for (final steerTimestamp in [2000, 1500]) {
            final window = windowOf(
              steerFixture(steerTimestamp: steerTimestamp),
            );

            expectSteerBoundary(window, displayedTurns(window));
          }
        },
      );

      test(
        'an interruption-owned boundary keeps the delivered prompt below the '
        'marker',
        () {
          // A terminal summary with a userMessageKey but no
          // assistantMessageKey proves ownership of a turn that emitted no
          // assistant text: the delivered prompt between the owning opener
          // and the interruption arrived after that opener and belongs below
          // the marker.
          final window = windowOf([
            prompt('prompt-interrupted', 'First'),
            prompt('prompt-later', 'Continue'),
            AgentMessage.fromJson({
              'type': 'notice',
              'key': 'marker-1',
              'message': 'Conversation interrupted.',
              'semantic': {
                'kind': 'interruption',
                'reason': 'generic',
                'turnId': 'turn-interrupted',
              },
            }),
            summary(
              status: 'cancelled',
              turnId: 'turn-interrupted',
              userMessageKey: 'prompt-interrupted',
            ),
          ]);

          final turns = displayedTurns(window);
          expect(
            _stableKeys(window.transcriptMessages),
            [
              'user-message:key:prompt-interrupted',
              'user-message:key:prompt-later',
              'notice:key:marker-1',
              'run-summary:key:rs-prompt-interrupted',
            ],
            reason: 'the projection never mutates the canonical list',
          );
          expect(turns, hasLength(2));
          expect(turns[0].userMessage?.raw['key'], 'prompt-interrupted');
          expect(
            contentKeys(turns[0]),
            ['marker-1'],
            reason: 'the interruption marker stays with its owning turn',
          );
          expect(
            turns[1].userMessage?.raw['key'],
            'prompt-later',
            reason:
                'the delivered prompt displays below the interruption '
                'marker',
          );
          expect(
            turns[1].content.whereType<MessageTranscriptDisplayEntry>(),
            isEmpty,
          );
        },
      );
    });
  });
}
