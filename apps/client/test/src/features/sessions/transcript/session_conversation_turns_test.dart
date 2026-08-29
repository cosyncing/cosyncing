import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_conversation_turns.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_transcript_display.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/tool_display_mode.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('turn boundaries', () {
    test('each delivered user message opens a turn', () {
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'First'),
          _model('a1', 'Answer one'),
          _user('u2', 'Second'),
          _model('a2', 'Answer two'),
        ],
        mode: ToolDisplayMode.responsive,
      );

      expect(turns, hasLength(2));
      expect(turns[0].userMessage?.raw['text'], 'First');
      expect(turns[0].modelText, 'Answer one');
      expect(turns[1].userMessage?.raw['text'], 'Second');
      expect(turns[1].modelText, 'Answer two');
      expect(turns.every((turn) => !turn.isPartial), isTrue);
    });

    test('a continuation notice opens a non-partial append-only turn', () {
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'Start workers'),
          _model('a1', 'Workers started'),
          _runSummary(
            status: 'done',
            turnId: 'prompt-turn',
            userMessageKey: 'u1',
            assistantMessageKey: 'a1',
            totalRuntimeMs: 100,
          ),
          _msg('notice', {
            'message': 'Worker finished',
            'semantic': {
              'kind': 'continuation',
              'reason': 'task-notification',
              'turnId': 'continuation-turn',
            },
          }),
          _model('a2', 'Continuation answer'),
          _runSummary(
            status: 'done',
            turnId: 'continuation-turn',
            assistantMessageKey: 'a2',
            totalRuntimeMs: 200,
          ),
        ],
        mode: ToolDisplayMode.responsive,
      );

      expect(turns, hasLength(2));
      expect(turns[0].runSummary?.totalRuntimeMs, 100);
      expect(turns[1].openReason, ConversationTurnOpenReason.continuation);
      expect(turns[1].isPartial, isFalse);
      expect(turns[1].userMessage, isNull);
      expect(
        turns[1].continuationNotice?.transcriptContinuationTurnId,
        'continuation-turn',
      );
      expect(turns[1].turnKey, 'turn:continuation:continuation-turn');
      expect(turns[1].modelText, 'Continuation answer');
      expect(turns[1].runSummary?.totalRuntimeMs, 200);
      expect(
        turns[1].content.whereType<MessageTranscriptDisplayEntry>().map(
          (entry) => entry.message.type,
        ),
        [AgentMessageType.notice, AgentMessageType.modelOutput],
      );
    });

    test(
      'consecutive output-free notifications share one continuation boundary',
      () {
        final turns = buildConversationTurns(
          messages: [
            _msg('notice', {
              'message': 'Worker one finished',
              'semantic': {
                'kind': 'continuation',
                'reason': 'task-notification',
                'turnId': 'continuation-one',
              },
            }),
            _msg('notice', {
              'message': 'Worker two finished',
              'semantic': {
                'kind': 'continuation',
                'reason': 'task-notification',
                'turnId': 'continuation-two',
              },
            }),
            _model('a1', 'Combined continuation answer'),
            _runSummary(
              status: 'done',
              turnId: 'continuation-one',
              assistantMessageKey: 'a1',
              totalRuntimeMs: 200,
            ),
          ],
          mode: ToolDisplayMode.responsive,
        );

        expect(turns, hasLength(1));
        expect(
          turns.single.openReason,
          ConversationTurnOpenReason.continuation,
        );
        expect(turns.single.turnKey, 'turn:continuation:continuation-one');
        expect(turns.single.modelText, 'Combined continuation answer');
        expect(turns.single.runSummary?.totalRuntimeMs, 200);
        expect(
          turns.single.content
              .whereType<MessageTranscriptDisplayEntry>()
              .where((entry) => entry.message.type == AgentMessageType.notice)
              .map((entry) => entry.message.raw['message']),
          ['Worker one finished', 'Worker two finished'],
        );
      },
    );

    test('a notification after continuation output opens a new boundary', () {
      final turns = buildConversationTurns(
        messages: [
          _msg('notice', {
            'message': 'Worker one finished',
            'semantic': {
              'kind': 'continuation',
              'reason': 'task-notification',
              'turnId': 'continuation-one',
            },
          }),
          _model('a1', 'First continuation output'),
          _msg('notice', {
            'message': 'Worker two finished',
            'semantic': {
              'kind': 'continuation',
              'reason': 'task-notification',
              'turnId': 'continuation-two',
            },
          }),
        ],
        mode: ToolDisplayMode.responsive,
      );

      expect(turns, hasLength(2));
      expect(turns[0].turnKey, 'turn:continuation:continuation-one');
      expect(turns[1].turnKey, 'turn:continuation:continuation-two');
    });

    test('an error fences notification coalescing', () {
      final turns = buildConversationTurns(
        messages: [
          _msg('notice', {
            'message': 'Worker one finished',
            'semantic': {
              'kind': 'continuation',
              'reason': 'task-notification',
              'turnId': 'continuation-one',
            },
          }),
          _msg('error', {'message': 'Continuation failed'}),
          _runSummary(
            status: 'error',
            turnId: 'continuation-one',
            totalRuntimeMs: 10,
          ),
          _msg('notice', {
            'message': 'Worker two finished',
            'semantic': {
              'kind': 'continuation',
              'reason': 'task-notification',
              'turnId': 'continuation-two',
            },
          }),
          _model('a2', 'Recovered continuation'),
          _runSummary(
            status: 'done',
            turnId: 'continuation-two',
            assistantMessageKey: 'a2',
            totalRuntimeMs: 20,
          ),
        ],
        mode: ToolDisplayMode.responsive,
      );

      expect(turns, hasLength(2));
      expect(turns[0].turnKey, 'turn:continuation:continuation-one');
      expect(turns[0].runSummary?.status, ConversationRunStatus.error);
      expect(turns[1].turnKey, 'turn:continuation:continuation-two');
      expect(turns[1].runSummary?.status, ConversationRunStatus.done);
    });

    test('an interruption notice fences notification coalescing', () {
      final turns = buildConversationTurns(
        messages: [
          _msg('notice', {
            'message': 'Worker one finished',
            'semantic': {
              'kind': 'continuation',
              'reason': 'task-notification',
              'turnId': 'continuation-one',
            },
          }),
          _msg('notice', {
            'message': 'Interrupted by user.',
            'semantic': {'kind': 'interruption', 'reason': 'user'},
          }),
          _runSummary(
            status: 'cancelled',
            turnId: 'continuation-one',
            totalRuntimeMs: 10,
          ),
          _msg('notice', {
            'message': 'Worker two finished',
            'semantic': {
              'kind': 'continuation',
              'reason': 'task-notification',
              'turnId': 'continuation-two',
            },
          }),
          _model('a2', 'Second continuation'),
          _runSummary(
            status: 'done',
            turnId: 'continuation-two',
            assistantMessageKey: 'a2',
            totalRuntimeMs: 20,
          ),
        ],
        mode: ToolDisplayMode.responsive,
      );

      expect(turns, hasLength(2));
      expect(turns[0].turnKey, 'turn:continuation:continuation-one');
      expect(turns[0].runSummary?.status, ConversationRunStatus.cancelled);
      expect(turns[1].turnKey, 'turn:continuation:continuation-two');
      expect(turns[1].runSummary?.status, ConversationRunStatus.done);
    });

    test('a queued prompt stays in the current turn and steals no output', () {
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'First'),
          _model('a1', 'Preamble'),
          _user('u2', 'Queued next', queued: true),
          _model('a2', 'First final'),
        ],
        mode: ToolDisplayMode.responsive,
      );

      expect(turns, hasLength(1), reason: 'a queued prompt opens no turn');
      final turn = turns.single;
      expect(turn.userMessage?.raw['key'], 'u1');
      expect(turn.modelText, 'Preamble\n\nFirst final');
      // The queued prompt is a visible row inside the turn's content.
      final queued = turn.content
          .whereType<MessageTranscriptDisplayEntry>()
          .where((entry) => entry.message.userMessageQueued)
          .toList();
      expect(queued, hasLength(1));
      expect(queued.single.message.raw['key'], 'u2');
    });

    test('a prompt delivered mid-turn does not steal the running turn', () {
      // The delivered `u2` echo is positioned in place at its mid-turn queued
      // slot; the run summaries tell us `a2` belongs to `u1` and `a3` to `u2`.
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'First'),
          _model('a1', 'Preamble'),
          _user('u2', 'Second'), // delivered, but sits mid-turn-1
          _model('a2', 'Final of first'), // belongs to u1
          _runSummary(
            status: 'done',
            assistantMessageKey: 'a2',
            userMessageKey: 'u1',
            totalRuntimeMs: 100,
          ),
          _model('a3', 'Answer to second'), // belongs to u2
          _runSummary(
            status: 'done',
            assistantMessageKey: 'a3',
            userMessageKey: 'u2',
            totalRuntimeMs: 200,
          ),
        ],
        mode: ToolDisplayMode.responsive,
      );

      expect(turns, hasLength(2));
      expect(turns[0].userMessage?.raw['key'], 'u1');
      expect(turns[0].modelText, 'Preamble\n\nFinal of first');
      expect(turns[0].runSummary?.totalRuntimeMs, 100);
      expect(turns[1].userMessage?.raw['key'], 'u2');
      expect(turns[1].modelText, 'Answer to second');
      expect(turns[1].runSummary?.totalRuntimeMs, 200);
    });

    test('an exact same-turn steer retains native canonical key order', () {
      final turns = buildConversationTurns(
        messages: [
          _user('codex:t:u0', 'Open', turnId: 't'),
          _model('codex:t:m0:t', 'Before'),
          _user('codex:t:u1', 'Steer', turnId: 't'),
          _model('codex:t:m1:t', 'After'),
          _runSummary(
            status: 'done',
            turnId: 't',
            userMessageKey: 'codex:t:u0',
            assistantMessageKey: 'codex:t:m1:t',
          ),
          _user('codex:t2:u0', 'Next', turnId: 't2'),
          _model('codex:t2:m0:t2', 'Next answer'),
          _runSummary(
            status: 'done',
            turnId: 't2',
            userMessageKey: 'codex:t2:u0',
            assistantMessageKey: 'codex:t2:m0:t2',
          ),
        ],
        mode: ToolDisplayMode.responsive,
      );

      final keys = <String>[
        for (final turn in turns) ...[
          if (turn.userMessage?.raw['key'] case final String key) key,
          for (final entry
              in turn.content.whereType<MessageTranscriptDisplayEntry>())
            if (entry.message.raw['key'] case final String key) key,
        ],
      ];
      expect(
        keys,
        [
          'codex:t:u0',
          'codex:t:m0:t',
          'codex:t:u1',
          'codex:t:m1:t',
          'codex:t2:u0',
          'codex:t2:m0:t2',
        ],
      );
    });

    test('an interruption stays above the next delivered prompt', () {
      // The delivered `u2` still occupies its optimistic queued slot when the
      // first turn's terminal frames arrive. The interruption belongs below
      // `a1`, not below the next prompt.
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'First'),
          _user('u2', 'Continue'),
          _model('a1', 'Partial answer'),
          _msg('notice', {
            'message': 'Conversation interrupted.',
            'semantic': {
              'kind': 'interruption',
              'reason': 'generic',
              'turnId': 'turn-a',
            },
          }),
          _runSummary(
            status: 'cancelled',
            assistantMessageKey: 'a1',
            userMessageKey: 'u1',
            turnId: 'turn-a',
          ),
        ],
        mode: ToolDisplayMode.responsive,
      );

      expect(turns, hasLength(2));
      expect(turns[0].userMessage?.raw['key'], 'u1');
      expect(turns[1].userMessage?.raw['key'], 'u2');
      final firstTypes = turns[0].content
          .whereType<MessageTranscriptDisplayEntry>()
          .map((entry) => entry.message.type)
          .toList();
      final secondTypes = turns[1].content
          .whereType<MessageTranscriptDisplayEntry>()
          .map((entry) => entry.message.type)
          .toList();
      expect(
        firstTypes,
        [AgentMessageType.modelOutput, AgentMessageType.notice],
      );
      expect(secondTypes, isEmpty);
    });

    test(
      'an exact zero-output interruption stays with its owning prompt',
      () {
        final turns = buildConversationTurns(
          messages: [
            _user('prompt-interrupted', 'First'),
            _user('prompt-later', 'Continue'),
            _msg('history-reset', {
              'notice': 'Compacted the conversation.',
              'semantic': {'kind': 'compaction'},
            }),
            _msg('notice', {
              'key': 'marker-row',
              'message': 'Conversation interrupted.',
              'semantic': {
                'kind': 'interruption',
                'reason': 'generic',
                'turnId': 'turn-interrupted',
              },
            }),
            _runSummary(
              status: 'cancelled',
              userMessageKey: 'prompt-interrupted',
              turnId: 'turn-interrupted',
            ),
          ],
          mode: ToolDisplayMode.responsive,
        );

        expect(turns, hasLength(2));
        expect(turns[0].userMessage?.raw['key'], 'prompt-interrupted');
        expect(
          turns[0].content.whereType<MessageTranscriptDisplayEntry>().map(
            (entry) => entry.message.type,
          ),
          [AgentMessageType.notice],
        );
        expect(turns[1].userMessage?.raw['key'], 'prompt-later');
        expect(
          turns[1].content.whereType<MessageTranscriptDisplayEntry>().map(
            (entry) => entry.message.type,
          ),
          [AgentMessageType.historyReset],
        );
      },
    );

    test('three zero-output prompt and interruption cycles stay ordered', () {
      AgentMessage interruption(String markerKey, String turnId) =>
          _msg('notice', {
            'key': markerKey,
            'message': 'Conversation interrupted.',
            'semantic': {
              'kind': 'interruption',
              'reason': 'generic',
              'turnId': turnId,
            },
          });

      final turns = buildConversationTurns(
        messages: [
          _user('prompt-1', 'First'),
          _user('prompt-2', 'Second'),
          interruption('marker-1', 'turn-1'),
          _runSummary(
            status: 'cancelled',
            userMessageKey: 'prompt-1',
            turnId: 'turn-1',
          ),
          _user('prompt-3', 'Third'),
          interruption('marker-2', 'turn-2'),
          _runSummary(
            status: 'cancelled',
            userMessageKey: 'prompt-2',
            turnId: 'turn-2',
          ),
          interruption('marker-3', 'turn-3'),
          _runSummary(
            status: 'cancelled',
            userMessageKey: 'prompt-3',
            turnId: 'turn-3',
          ),
        ],
        mode: ToolDisplayMode.responsive,
      );

      expect(turns, hasLength(3));
      expect(
        turns.map((turn) => turn.userMessage?.raw['key']),
        ['prompt-1', 'prompt-2', 'prompt-3'],
      );
      for (var index = 0; index < turns.length; index++) {
        final notices = turns[index].content
            .whereType<MessageTranscriptDisplayEntry>()
            .where(
              (entry) => entry.message.type == AgentMessageType.notice,
            )
            .toList();
        expect(notices, hasLength(1), reason: 'turn ${index + 1}');
        expect(
          notices.single.message.raw['key'],
          'marker-${index + 1}',
        );
      }
    });

    test(
      'an unowned Claude marker stays with the interrupted turn despite '
      'distinct row and prompt ids',
      () {
        final turns = buildConversationTurns(
          messages: [
            _user('prompt-interrupted', 'First'),
            _user('prompt-later', 'Continue'),
            _model('assistant-interrupted', 'Partial answer'),
            _msg('notice', {
              'uuid': 'marker-row',
              'message': 'Interrupted by user.',
              'semantic': {
                'kind': 'interruption',
                'reason': 'user',
              },
            }),
            _runSummary(
              status: 'cancelled',
              assistantMessageKey: 'assistant-interrupted',
              userMessageKey: 'prompt-interrupted',
              turnId: 'turn-interrupted',
            ),
          ],
          mode: ToolDisplayMode.responsive,
        );

        expect(turns, hasLength(2));
        expect(turns[0].userMessage?.raw['key'], 'prompt-interrupted');
        expect(
          turns[0].content.whereType<MessageTranscriptDisplayEntry>().map(
            (entry) => entry.message.type,
          ),
          [AgentMessageType.modelOutput, AgentMessageType.notice],
        );
        expect(turns[1].userMessage?.raw['key'], 'prompt-later');
        expect(
          turns[1].content.whereType<MessageTranscriptDisplayEntry>(),
          isEmpty,
        );
      },
    );

    test('a generic notice after the next prompt remains with that prompt', () {
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'First'),
          _user('u2', 'Run a local command'),
          _model('a1', 'Partial answer'),
          _msg('notice', {'message': 'Generic local-command output'}),
          _runSummary(
            status: 'done',
            assistantMessageKey: 'a1',
            userMessageKey: 'u1',
          ),
        ],
        mode: ToolDisplayMode.responsive,
      );

      expect(turns, hasLength(2));
      expect(turns[0].modelText, 'Partial answer');
      expect(
        turns[0].content.whereType<MessageTranscriptDisplayEntry>().map(
          (entry) => entry.message.type,
        ),
        [AgentMessageType.modelOutput],
      );
      expect(
        turns[1].content.whereType<MessageTranscriptDisplayEntry>().map(
          (entry) => entry.message.raw['message'],
        ),
        ['Generic local-command output'],
      );
    });

    test('user-triggered compaction remains with the new prompt', () {
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'First'),
          _user('u2', '/compact'),
          _model('a1', 'Partial answer'),
          _msg('history-reset', {
            'notice': 'Adapter-specific compaction copy',
            'semantic': {'kind': 'compaction'},
          }),
          _runSummary(
            status: 'done',
            assistantMessageKey: 'a1',
            userMessageKey: 'u1',
          ),
        ],
        mode: ToolDisplayMode.responsive,
      );

      expect(turns, hasLength(2));
      expect(turns[0].modelText, 'Partial answer');
      expect(
        turns[0].content.whereType<MessageTranscriptDisplayEntry>().map(
          (entry) => entry.message.type,
        ),
        [AgentMessageType.modelOutput],
      );
      expect(
        turns[1].content.whereType<MessageTranscriptDisplayEntry>().map(
          (entry) => entry.message.type,
        ),
        [AgentMessageType.historyReset],
      );
    });

    test('a mid-turn prompt keeps its still-streaming answer (no summary)', () {
      // The second answer `a3` is still streaming: only `u1`'s run summary
      // exists, so `a3` has no owner yet. It must still land under `u2`.
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'First'),
          _model('a1', 'Preamble'),
          _user('u2', 'Second'), // delivered, sits mid-turn-1
          _model('a2', 'Final of first'), // owned by u1
          _runSummary(
            status: 'done',
            assistantMessageKey: 'a2',
            userMessageKey: 'u1',
          ),
          _model('a3', 'Streaming answer'), // u2's answer, no summary yet
        ],
        mode: ToolDisplayMode.responsive,
      );

      expect(turns, hasLength(2));
      expect(turns[0].userMessage?.raw['key'], 'u1');
      expect(turns[0].modelText, 'Preamble\n\nFinal of first');
      expect(turns[1].userMessage?.raw['key'], 'u2');
      expect(turns[1].modelText, 'Streaming answer');
    });

    test('an unprovable ownership graph never relocates a prompt (CR4b)', () {
      // The reproduced Codex defect: the transcript renders the prompt under
      // one identity while the run summaries name another (a live app-server
      // echo beside a rollout-replayed summary). The prompt is then unowned by
      // every summary, so the old scan dragged it below its own answer.
      final turns = buildConversationTurns(
        messages: [
          _user('live-prompt', 'Only prompt'),
          _model('a1', 'Its answer'),
          _runSummary(
            status: 'done',
            assistantMessageKey: 'a1',
            userMessageKey: 'replayed-prompt',
          ),
        ],
        mode: ToolDisplayMode.responsive,
      );

      expect(turns, hasLength(1));
      expect(turns.single.userMessage?.raw['key'], 'live-prompt');
      expect(
        turns.single.modelText,
        'Its answer',
        reason: 'the prompt must stay above the answer it produced',
      );
    });

    test('a coherent ownership graph still relocates a mid-turn prompt', () {
      // The positive control for the guard above: every summary that describes
      // visible output names a prompt that is visible too, so relocation runs.
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'First'),
          _model('a1', 'Preamble'),
          _user('u2', 'Second'),
          _model('a2', 'Final of first'),
          _runSummary(
            status: 'done',
            assistantMessageKey: 'a2',
            userMessageKey: 'u1',
          ),
          _model('a3', 'Second answer'),
          _runSummary(
            status: 'done',
            assistantMessageKey: 'a3',
            userMessageKey: 'u2',
          ),
        ],
        mode: ToolDisplayMode.responsive,
      );

      expect(turns, hasLength(2));
      expect(turns[0].modelText, 'Preamble\n\nFinal of first');
      expect(turns[1].modelText, 'Second answer');
    });

    test('a terminal summary attaches its footer to the open turn (CR4b)', () {
      // The live Codex path now stamps the canonical prompt/assistant keys on
      // the terminal frame, so the footer lands on the already-rendered turn
      // without waiting for authoritative history to be rebuilt.
      final turns = buildConversationTurns(
        messages: [
          _user('codex:t1:u0', 'Prompt', turnId: 't1'),
          _model('codex:t1:msg_a:t', 'Answer'),
          _runSummary(
            status: 'done',
            turnId: 't1',
            assistantMessageKey: 'codex:t1:msg_a:t',
            userMessageKey: 'codex:t1:u0',
            totalRuntimeMs: 4000,
            completedAt: 1781777404000,
          ),
        ],
        mode: ToolDisplayMode.responsive,
      );

      expect(turns, hasLength(1));
      final summary = turns.single.runSummary;
      expect(summary, isNotNull);
      expect(summary!.hasFooterMetadata, isTrue);
      expect(summary.totalRuntimeMs, 4000);
      expect(summary.completedAt, 1781777404000);
    });

    test('two prompts queued in the same turn each keep their own answer', () {
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'First'),
          _model('a1', 'First answer'),
          _user('u2', 'Second'), // both delivered mid-turn-1
          _user('u3', 'Third'),
          _runSummary(
            status: 'done',
            assistantMessageKey: 'a1',
            userMessageKey: 'u1',
          ),
          _model('a2', 'Second answer'),
          _runSummary(
            status: 'done',
            assistantMessageKey: 'a2',
            userMessageKey: 'u2',
          ),
          _model('a3', 'Third answer'),
          _runSummary(
            status: 'done',
            assistantMessageKey: 'a3',
            userMessageKey: 'u3',
          ),
        ],
        mode: ToolDisplayMode.responsive,
      );

      expect(turns, hasLength(3));
      expect(turns.map((t) => t.userMessage?.raw['key']), ['u1', 'u2', 'u3']);
      expect(turns[0].modelText, 'First answer');
      expect(turns[1].modelText, 'Second answer');
      expect(turns[2].modelText, 'Third answer');
    });

    test(
      'content before the first delivered user message is a partial turn',
      () {
        final turns = buildConversationTurns(
          messages: [
            _model('a0', 'Orphaned answer'),
            _user('u1', 'Real prompt'),
            _model('a1', 'Real answer'),
          ],
          mode: ToolDisplayMode.responsive,
        );

        expect(turns, hasLength(2));
        expect(turns[0].userMessage, isNull);
        expect(turns[0].isPartial, isTrue);
        expect(turns[0].modelText, 'Orphaned answer');
        expect(turns[1].isPartial, isFalse);
      },
    );
  });

  group('model text aggregate', () {
    test(
      'joins every model segment across a tool call, including preamble',
      () {
        final turns = buildConversationTurns(
          messages: [
            _user('u1', 'Do it'),
            _model('a1', 'Let me look'),
            _toolCall('c1', ToolDisplayClass.lookup),
            _toolResult('c1', ToolDisplayClass.lookup),
            _model('a2', 'Done'),
          ],
          mode: ToolDisplayMode.responsive,
        );

        expect(turns.single.modelText, 'Let me look\n\nDone');
      },
    );

    test('excludes thinking and tool output from the aggregate', () {
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'Do it'),
          _msg('thinking', {'text': 'internal reasoning'}),
          _msg('terminal-output', {'output': 'raw stdout'}),
          _model('a1', 'Visible answer'),
        ],
        mode: ToolDisplayMode.responsive,
      );

      expect(turns.single.modelText, 'Visible answer');
    });
  });

  group('distinct tool-call count', () {
    test('a call/result pair counts once', () {
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'x'),
          _toolCall('c1', ToolDisplayClass.execute),
          _toolResult('c1', ToolDisplayClass.execute),
        ],
        mode: ToolDisplayMode.responsive,
      );
      expect(turns.single.distinctToolCallCount, 1);
    });

    test('a lone result (truncated call) is not counted as a call', () {
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'x'),
          _toolResult('c-lost', ToolDisplayClass.execute),
          _model('a1', 'done'),
        ],
        mode: ToolDisplayMode.responsive,
      );
      expect(turns.single.distinctToolCallCount, 0);
    });

    test('distinct call ids count separately', () {
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'x'),
          _toolCall('c1', ToolDisplayClass.execute),
          _toolCall('c2', ToolDisplayClass.lookup),
          _toolResult('c1', ToolDisplayClass.execute),
        ],
        mode: ToolDisplayMode.responsive,
      );
      expect(turns.single.distinctToolCallCount, 2);
    });
  });

  group('run summary association', () {
    test('attaches by assistantMessageKey', () {
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'First'),
          _model('a1', 'One'),
          _user('u2', 'Second'),
          _model('a2', 'Two'),
          _runSummary(
            status: 'done',
            assistantMessageKey: 'a2',
            totalRuntimeMs: 4200,
            completedAt: 1000,
          ),
        ],
        mode: ToolDisplayMode.responsive,
      );

      expect(turns[0].runSummary, isNull);
      expect(turns[1].runSummary?.totalRuntimeMs, 4200);
      expect(turns[1].runSummary?.completedAt, 1000);
      expect(turns[1].runSummary?.status, ConversationRunStatus.done);
    });

    test('falls back to userMessageKey then turnId', () {
      final byUser = buildConversationTurns(
        messages: [
          _user('u1', 'First'),
          _model('a1', 'One'),
          _runSummary(status: 'done', userMessageKey: 'u1', totalRuntimeMs: 10),
        ],
        mode: ToolDisplayMode.responsive,
      );
      expect(byUser.single.runSummary?.totalRuntimeMs, 10);

      final byTurnId = buildConversationTurns(
        messages: [
          _user('u1', 'First', turnId: 't1'),
          _model('a1', 'One'),
          _runSummary(status: 'done', turnId: 't1', totalRuntimeMs: 20),
        ],
        mode: ToolDisplayMode.responsive,
      );
      expect(byTurnId.single.runSummary?.totalRuntimeMs, 20);
    });

    test('a later summary updates the same footer in place', () {
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'First'),
          _model('a1', 'One'),
          _runSummary(
            status: 'done',
            assistantMessageKey: 'a1',
            totalRuntimeMs: 100,
          ),
          _runSummary(
            status: 'done',
            userMessageKey: 'u1',
            totalRuntimeMs: 999,
          ),
        ],
        mode: ToolDisplayMode.responsive,
      );
      expect(turns.single.runSummary?.totalRuntimeMs, 999);
    });

    test('an unassociable summary is omitted, never misattributed', () {
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'First'),
          _model('a1', 'One'),
          _runSummary(
            status: 'done',
            assistantMessageKey: 'unknown-key',
            totalRuntimeMs: 500,
          ),
        ],
        mode: ToolDisplayMode.responsive,
      );
      expect(turns.single.runSummary, isNull);
    });

    test('a running summary never becomes a footer', () {
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'First'),
          _model('a1', 'One'),
          _runSummary(
            status: 'running',
            assistantMessageKey: 'a1',
            totalRuntimeMs: 300,
          ),
        ],
        mode: ToolDisplayMode.responsive,
      );
      expect(turns.single.runSummary, isNull);
    });

    test('parses tokens, cost, and children for the telemetry box', () {
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'First'),
          _model('a1', 'One'),
          _runSummary(
            status: 'done',
            assistantMessageKey: 'a1',
            totalRuntimeMs: 1200,
            agentRuntimeMs: 900,
            executionRuntimeMs: 300,
            tokens: {
              'input': 100,
              'output': 50,
              'cacheRead': 10,
              'cost': 0.02,
            },
            children: [
              {'id': 'child-1', 'title': 'sub', 'status': 'done'},
            ],
          ),
        ],
        mode: ToolDisplayMode.responsive,
      );

      final summary = turns.single.runSummary!;
      expect(summary.totalTokens, 160);
      expect(summary.cost, 0.02);
      expect(summary.agentRuntimeMs, 900);
      expect(summary.executionRuntimeMs, 300);
      expect(summary.children, hasLength(1));
      expect(summary.children.single.title, 'sub');
    });
  });

  group('explicit surfaces stay visible', () {
    test('permission and error surfaces occurring in a turn are kept', () {
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'x'),
          _msg('permission-request', {'requestId': 'p1'}),
          _msg('error', {'message': 'boom'}),
          _model('a1', 'ok'),
        ],
        mode: ToolDisplayMode.responsive,
      );

      final types = turns.single.content
          .whereType<MessageTranscriptDisplayEntry>()
          .map((entry) => entry.message.type)
          .toSet();
      expect(
        types,
        containsAll({
          AgentMessageType.permissionRequest,
          AgentMessageType.error,
        }),
      );
    });

    test('status and run-summary never appear as content rows', () {
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'x'),
          _msg('status', {'status': 'running'}),
          _model('a1', 'ok'),
          _runSummary(status: 'done', assistantMessageKey: 'a1'),
        ],
        mode: ToolDisplayMode.responsive,
      );

      final types = turns.single.content
          .whereType<MessageTranscriptDisplayEntry>()
          .map((entry) => entry.message.type)
          .toSet();
      expect(types, isNot(contains(AgentMessageType.status)));
      expect(types, isNot(contains(AgentMessageType.runSummary)));
    });

    test('request resolutions never appear as content rows (CR2)', () {
      for (final mode in [
        ToolDisplayMode.responsive,
        ToolDisplayMode.finalMessagesOnly,
      ]) {
        final turns = buildConversationTurns(
          messages: [
            _user('u1', 'x'),
            _msg('permission-request', {'requestId': 'p1'}),
            _msg('permission-resolved', {
              'requestId': 'p1',
              'decision': 'approve',
            }),
            // Orphan from an older broker/replayed cache: still invisible.
            _msg('question-resolved', {'requestId': 'ghost'}),
            _model('a1', 'ok'),
          ],
          mode: mode,
        );

        final types = turns.single.content
            .whereType<MessageTranscriptDisplayEntry>()
            .map((entry) => entry.message.type)
            .toSet();
        expect(
          types,
          contains(AgentMessageType.permissionRequest),
          reason: '$mode keeps the request card',
        );
        expect(
          types,
          isNot(contains(AgentMessageType.permissionResolved)),
          reason: '$mode must not render a resolution row',
        );
        expect(
          types,
          isNot(contains(AgentMessageType.questionResolved)),
          reason: '$mode must not render an orphan resolution row',
        );
      }
    });
  });

  group('final-only mode', () {
    test('keeps only the final model segment and safety surfaces', () {
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'x'),
          _model('a1', 'Preamble'),
          _msg('thinking', {'text': 'reason'}),
          _toolCall('c1', ToolDisplayClass.execute),
          _toolResult('c1', ToolDisplayClass.execute),
          _msg('error', {'message': 'note'}),
          _model('a2', 'Final answer'),
        ],
        mode: ToolDisplayMode.finalMessagesOnly,
      );

      final content = turns.single.content
          .whereType<MessageTranscriptDisplayEntry>()
          .map((entry) => entry.message)
          .toList();
      // Only the last model output plus the error surface survive; thinking and
      // tools are dropped.
      expect(
        content.map((message) => message.type),
        containsAll({AgentMessageType.error, AgentMessageType.modelOutput}),
      );
      expect(
        content.where((m) => m.type == AgentMessageType.modelOutput),
        hasLength(1),
      );
      expect(
        content
            .firstWhere((m) => m.type == AgentMessageType.modelOutput)
            .raw['text'],
        'Final answer',
      );
      expect(
        turns.single.content.whereType<ToolTranscriptDisplayEntry>(),
        isEmpty,
      );
      // modelText still aggregates every segment even in final-only mode.
      expect(turns.single.modelText, 'Preamble\n\nFinal answer');
    });
  });

  group('empty transcript', () {
    test('no messages produce no turns', () {
      expect(
        buildConversationTurns(
          messages: const [],
          mode: ToolDisplayMode.responsive,
        ),
        isEmpty,
      );
    });
  });

  // P6. A user-sent artifact arrives as its own top-level `file-artifact`. The
  // ownership link is `userMessageKey`; without it the image rendered as an
  // agent deliverable, detached from the prompt it went with.
  group('user attachments', () {
    List<AgentMessage> artifactsIn(ConversationTurn turn) => [
      for (final entry in turn.content)
        if (entry case MessageTranscriptDisplayEntry(:final message))
          if (message.type == AgentMessageType.fileArtifact) message,
    ];

    test('nests a sent artifact under its own prompt and drops it from '
        'content', () {
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'Look at this'),
          _artifact('screenshot.png', userMessageKey: 'u1'),
          _model('a1', 'I see it'),
        ],
        mode: ToolDisplayMode.responsive,
      );

      final turn = turns.single;
      expect(
        turn.userAttachments.map((m) => m.raw['name']),
        ['screenshot.png'],
      );
      expect(artifactsIn(turn), isEmpty);
      expect(turn.modelText, 'I see it');
    });

    test('preserves order and never duplicates', () {
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'Two files'),
          _artifact('one.png', userMessageKey: 'u1'),
          _artifact('two.png', userMessageKey: 'u1'),
        ],
        mode: ToolDisplayMode.responsive,
      );

      expect(
        turns.single.userAttachments.map((m) => m.raw['name']),
        ['one.png', 'two.png'],
      );
      expect(artifactsIn(turns.single), isEmpty);
    });

    test('keeps an artifact whose owner row is not projected in content', () {
      final turns = buildConversationTurns(
        messages: [
          _user('u1', 'Unrelated'),
          _artifact('evicted.png', userMessageKey: 'u-evicted'),
          _artifact('report.pdf'),
        ],
        mode: ToolDisplayMode.responsive,
      );

      final turn = turns.single;
      expect(turn.userAttachments, isEmpty);
      expect(
        artifactsIn(turn).map((m) => m.raw['name']),
        ['evicted.png', 'report.pdf'],
      );
    });
  });
}

AgentMessage _artifact(
  String name, {
  String? userMessageKey,
}) => _msg('file-artifact', {
  'artifactKey': 'artifact-$name',
  'name': name,
  if (userMessageKey != null) 'userMessageKey': userMessageKey,
});

AgentMessage _user(
  String key,
  String text, {
  bool queued = false,
  String? turnId,
}) => _msg('user-message', {
  'key': key,
  'text': text,
  if (queued) 'queued': true,
  if (turnId != null) 'turnId': turnId,
});

AgentMessage _model(String key, String text, {bool isFinal = true}) =>
    _msg('model-output', {'key': key, 'text': text, 'final': isFinal});

AgentMessage _toolCall(String callId, ToolDisplayClass displayClass) =>
    _msg('tool-call', {'callId': callId, 'toolClass': displayClass.wireValue});

AgentMessage _toolResult(String callId, ToolDisplayClass displayClass) => _msg(
  'tool-result',
  {'callId': callId, 'toolClass': displayClass.wireValue},
);

AgentMessage _runSummary({
  required String status,
  String? assistantMessageKey,
  String? userMessageKey,
  String? turnId,
  int? totalRuntimeMs,
  int? agentRuntimeMs,
  int? executionRuntimeMs,
  int? completedAt,
  Map<String, dynamic>? tokens,
  List<Map<String, dynamic>>? children,
}) => _msg('run-summary', {
  'key': 'rs-${assistantMessageKey ?? userMessageKey ?? turnId ?? status}',
  'turnId': turnId ?? 'turn',
  'status': status,
  if (assistantMessageKey != null) 'assistantMessageKey': assistantMessageKey,
  if (userMessageKey != null) 'userMessageKey': userMessageKey,
  if (totalRuntimeMs != null) 'totalRuntimeMs': totalRuntimeMs,
  if (agentRuntimeMs != null) 'agentRuntimeMs': agentRuntimeMs,
  if (executionRuntimeMs != null) 'executionRuntimeMs': executionRuntimeMs,
  if (completedAt != null) 'completedAt': completedAt,
  if (tokens != null) 'tokens': tokens,
  if (children != null) 'children': children,
});

AgentMessage _msg(String type, Map<String, dynamic> fields) =>
    AgentMessage.fromJson({'type': type, ...fields});
