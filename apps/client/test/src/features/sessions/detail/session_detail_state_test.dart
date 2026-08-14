import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/tool_display_mode.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('SessionDetailState.activeTransientRetryStatus', () {
    const source = RosterSource(
      profileId: 'profile-a',
      endpoint: 'https://broker-a.example',
    );
    const retry = SessionTransientRetryStatus(
      providerDetail: 'opaque provider detail',
      source: source,
      sessionId: 'session-1',
      attachGeneration: 4,
      eventSequence: 9,
    );

    test('accepts only an exact source, session, and attach match', () {
      const state = SessionDetailState(
        tool: 'opencode',
        sessionId: 'session-1',
        source: source,
        bootstrapState: SessionDetailBootstrapState(attempt: 4),
        transientRetryStatus: retry,
      );

      expect(state.activeTransientRetryStatus, same(retry));
      expect(
        state
            .copyWith(
              bootstrapState: const SessionDetailBootstrapState(attempt: 5),
            )
            .activeTransientRetryStatus,
        isNull,
      );
      expect(
        const SessionDetailState(
          tool: 'opencode',
          sessionId: 'session-2',
          source: source,
          bootstrapState: SessionDetailBootstrapState(attempt: 4),
          transientRetryStatus: retry,
        ).activeTransientRetryStatus,
        isNull,
      );
      expect(
        const SessionDetailState(
          tool: 'claude',
          sessionId: 'session-1',
          source: source,
          bootstrapState: SessionDetailBootstrapState(attempt: 4),
          transientRetryStatus: retry,
        ).activeTransientRetryStatus,
        isNull,
      );
      expect(
        const SessionDetailState(
          tool: 'opencode',
          sessionId: 'session-1',
          source: RosterSource(
            profileId: 'profile-a',
            endpoint: 'https://broker-b.example',
          ),
          bootstrapState: SessionDetailBootstrapState(attempt: 4),
          transientRetryStatus: retry,
        ).activeTransientRetryStatus,
        isNull,
      );
    });

    test('clearTransientRetryStatus removes the live-only value', () {
      const state = SessionDetailState(
        tool: 'opencode',
        sessionId: 'session-1',
        source: source,
        bootstrapState: SessionDetailBootstrapState(attempt: 4),
        transientRetryStatus: retry,
      );

      expect(
        state.copyWith(clearTransientRetryStatus: true).transientRetryStatus,
        isNull,
      );
    });
  });

  group('SessionDetailState.messageEvents', () {
    test('modes uses the latest options event', () {
      const state = SessionDetailState(
        tool: 'claude',
        sessionId: 'session-modes',
        events: [
          OptionsWireEvent(
            models: [],
            agents: [],
            modes: [ModeOption(value: 'default', label: 'Default')],
          ),
          OptionsWireEvent(
            models: [],
            agents: [],
            modes: [
              ModeOption(
                value: 'accept-edits',
                label: 'Accept edits',
                category: 'approve-for-me',
              ),
            ],
          ),
        ],
      );

      expect(state.modes.map((mode) => mode.value), ['accept-edits']);
    });

    test('latestDraft uses broker timestamp and preserves explicit clear', () {
      const state = SessionDetailState(
        tool: 'claude',
        sessionId: 'session-draft',
        events: [
          DraftWireEvent(text: 'newer', at: 20),
          DraftWireEvent(text: 'stale arrival', at: 10),
          DraftWireEvent(text: '', at: 30),
        ],
      );

      expect(state.latestDraft?.text, isEmpty);
      expect(state.latestDraft?.at, 30);
    });

    test('history reset replaces the projected transcript', () {
      const state = SessionDetailState(
        tool: 'claude',
        sessionId: 'session-1',
        events: [
          HistoryWireEvent(
            messages: [
              AgentMessage(
                id: 'old-history',
                type: AgentMessageType.userMessage,
              ),
            ],
          ),
          MessageWireEvent(
            seq: 1,
            message: AgentMessage(
              id: 'old-live',
              type: AgentMessageType.modelOutput,
            ),
          ),
          HistoryWireEvent(
            reset: true,
            messages: [
              AgentMessage(
                id: 'replacement',
                type: AgentMessageType.userMessage,
              ),
            ],
          ),
          MessageWireEvent(
            seq: 2,
            message: AgentMessage(
              id: 'new-live',
              type: AgentMessageType.modelOutput,
            ),
          ),
        ],
      );

      expect(
        state.messageEvents.map((message) => message.id),
        ['replacement', 'new-live'],
      );
    });

    test('incremental history remains additive', () {
      const state = SessionDetailState(
        tool: 'opencode',
        sessionId: 'session-2',
        events: [
          HistoryWireEvent(
            messages: [
              AgentMessage(
                id: 'first',
                type: AgentMessageType.userMessage,
              ),
            ],
          ),
          HistoryWireEvent(
            messages: [
              AgentMessage(
                id: 'second',
                type: AgentMessageType.modelOutput,
              ),
            ],
          ),
        ],
      );

      expect(
        state.messageEvents.map((message) => message.id),
        ['first', 'second'],
      );
    });

    test('delivered user message replaces its queued bubble by key', () {
      const state = SessionDetailState(
        tool: 'codex',
        sessionId: 'session-queued',
        events: [
          MessageWireEvent(
            seq: 1,
            message: AgentMessage(
              type: AgentMessageType.userMessage,
              raw: {
                'type': 'user-message',
                'key': 'user-message-1',
                'text': 'Run the checks',
                'queued': true,
              },
            ),
          ),
          MessageWireEvent(
            seq: 2,
            message: AgentMessage(
              type: AgentMessageType.modelOutput,
              raw: {'type': 'model-output', 'text': 'Current turn answer'},
            ),
          ),
          MessageWireEvent(
            seq: 3,
            message: AgentMessage(
              type: AgentMessageType.userMessage,
              raw: {
                'type': 'user-message',
                'key': 'user-message-1',
                'text': 'Run the checks',
              },
            ),
          ),
        ],
      );

      expect(state.messageEvents, hasLength(2));
      expect(state.messageEvents.first.type, AgentMessageType.userMessage);
      expect(state.messageEvents.first.userMessageQueued, isFalse);
      expect(
        state.messageEvents.last.type,
        AgentMessageType.modelOutput,
        reason: 'delivery updates the queued row in place',
      );
    });

    test('identical user text with different keys stays distinct', () {
      const state = SessionDetailState(
        tool: 'codex',
        sessionId: 'session-distinct',
        events: [
          MessageWireEvent(
            seq: 1,
            message: AgentMessage(
              type: AgentMessageType.userMessage,
              raw: {
                'type': 'user-message',
                'key': 'user-1',
                'text': 'Continue',
              },
            ),
          ),
          MessageWireEvent(
            seq: 2,
            message: AgentMessage(
              type: AgentMessageType.userMessage,
              raw: {
                'type': 'user-message',
                'key': 'user-2',
                'text': 'Continue',
              },
            ),
          ),
        ],
      );

      expect(state.messageEvents, hasLength(2));
    });

    test('same-key streaming deltas coalesce into one transcript row', () {
      final state = SessionDetailState(
        tool: 'codex',
        sessionId: 'session-stream',
        events: [
          MessageWireEvent(
            seq: 1,
            message: AgentMessage.fromJson({
              'type': 'model-output',
              'key': 'turn-1:text',
              'delta': 'Hello',
            }),
          ),
          MessageWireEvent(
            seq: 2,
            message: AgentMessage.fromJson({
              'type': 'model-output',
              'key': 'turn-1:text',
              'delta': ' world',
            }),
          ),
          MessageWireEvent(
            seq: 3,
            message: AgentMessage.fromJson({
              'type': 'model-output',
              'key': 'turn-1:text',
              'final': true,
            }),
          ),
        ],
      );

      expect(state.messageEvents, hasLength(1));
      expect(state.messageEvents.single.modelOutputText, 'Hello world');
      expect(state.messageEvents.single.modelOutputFinal, isTrue);
      expect(state.messageEvents.single.raw, isNot(contains('delta')));
    });

    test('authoritative same-key snapshot replaces accumulated deltas', () {
      final state = SessionDetailState(
        tool: 'claude',
        sessionId: 'session-stream-final',
        events: [
          MessageWireEvent(
            seq: 1,
            message: AgentMessage.fromJson({
              'type': 'model-output',
              'key': 'answer',
              'delta': 'partial',
            }),
          ),
          HistoryWireEvent(
            messages: [
              AgentMessage.fromJson({
                'type': 'model-output',
                'key': 'answer',
                'text': 'Complete answer',
                'final': true,
              }),
            ],
          ),
        ],
      );

      expect(state.messageEvents, hasLength(1));
      expect(state.messageEvents.single.modelOutputText, 'Complete answer');
      expect(state.messageEvents.single.modelOutputFinal, isTrue);
    });

    test('a same-key catch-up copy neither duplicates nor demotes the '
        'delivered final', () {
      // The attach boundary a joining client can land on: the answer is already
      // in saved history while the producer's live buffer still holds it, so it
      // arrives twice under one identity. It is one message, and it stays a
      // completed one — read-aloud, Copy and turn telemetry all gate on that.
      final state = SessionDetailState(
        tool: 'codex',
        sessionId: 'session-attach-overlap',
        events: [
          HistoryWireEvent(
            messages: [
              AgentMessage.fromJson({
                'type': 'model-output',
                'key': 'codex:turn-1:msg_abc:t',
                'text': 'The answer is 42.',
                'final': true,
              }),
            ],
          ),
          MessageWireEvent(
            seq: 1,
            message: AgentMessage.fromJson({
              'type': 'model-output',
              'key': 'codex:turn-1:msg_abc:t',
              'text': 'The answer is 42.',
            }),
          ),
        ],
      );

      expect(state.messageEvents, hasLength(1));
      expect(state.messageEvents.single.modelOutputText, 'The answer is 42.');
      expect(state.messageEvents.single.modelOutputFinal, isTrue);
    });

    test('stable request and call identities dedupe replayed frames', () {
      final state = SessionDetailState(
        tool: 'opencode',
        sessionId: 'session-replay-dedupe',
        events: [
          HistoryWireEvent(
            messages: [
              AgentMessage.fromJson({
                'type': 'permission-request',
                'requestId': 'permission-1',
                'title': 'Old title',
              }),
              AgentMessage.fromJson({
                'type': 'tool-call',
                'callId': 'call-1',
                'toolName': 'shell',
              }),
            ],
          ),
          MessageWireEvent(
            seq: 0,
            message: AgentMessage.fromJson({
              'type': 'permission-request',
              'requestId': 'permission-1',
              'title': 'Current title',
            }),
          ),
          MessageWireEvent(
            seq: 0,
            message: AgentMessage.fromJson({
              'type': 'tool-call',
              'callId': 'call-1',
              'toolName': 'shell',
              'title': 'Current call',
            }),
          ),
        ],
      );

      expect(state.messageEvents, hasLength(2));
      expect(state.messageEvents.first.raw['title'], 'Current title');
      expect(state.messageEvents.last.raw['title'], 'Current call');
    });

    test('future message types keep independent stable-key namespaces', () {
      final state = SessionDetailState(
        tool: 'future-agent',
        sessionId: 'future-message-types',
        events: [
          MessageWireEvent(
            seq: 1,
            message: AgentMessage.fromJson({
              'type': 'future-alpha',
              'key': 'shared',
              'text': 'alpha',
            }),
          ),
          MessageWireEvent(
            seq: 2,
            message: AgentMessage.fromJson({
              'type': 'future-beta',
              'key': 'shared',
              'text': 'beta',
            }),
          ),
        ],
      );

      expect(state.messageEvents, hasLength(2));
      expect(
        state.messageEvents.map((message) => message.raw['type']),
        ['future-alpha', 'future-beta'],
      );
    });

    test('projects goal/task state by key and removes terminal state', () {
      AgentMessage stateMessage(Map<String, dynamic> raw) =>
          AgentMessage.fromJson(raw);
      final state = SessionDetailState(
        tool: 'codex',
        sessionId: 'session-state',
        events: [
          MessageWireEvent(
            seq: 1,
            message: stateMessage({
              'type': 'goal-state',
              'key': 'goal-a',
              'status': 'active',
              'title': 'Old title',
            }),
          ),
          MessageWireEvent(
            seq: 2,
            message: stateMessage({
              'type': 'goal-state',
              'key': 'goal-a',
              'status': 'paused',
              'title': 'New title',
            }),
          ),
          MessageWireEvent(
            seq: 3,
            message: stateMessage({
              'type': 'goal-state',
              'key': 'goal-b',
              'status': 'active',
            }),
          ),
          MessageWireEvent(
            seq: 4,
            message: stateMessage({
              'type': 'goal-state',
              'key': 'goal-b',
              'status': 'done',
            }),
          ),
          MessageWireEvent(
            seq: 5,
            message: stateMessage({
              'type': 'task-list-state',
              'key': 'tasks',
              'status': 'running',
              'items': [
                {'title': 'First', 'status': 'open'},
              ],
            }),
          ),
          MessageWireEvent(
            seq: 6,
            message: stateMessage({
              'type': 'task-list-state',
              'key': 'tasks',
              'status': 'done',
              'items': [
                {'title': 'First', 'status': 'done'},
              ],
            }),
          ),
        ],
      );

      expect(state.liveState.goals, hasLength(1));
      expect(state.liveState.goals.single.title, 'New title');
      expect(state.liveState.goals.single.status, GoalStateStatus.paused);
      expect(state.liveState.taskLists, hasLength(1));
      expect(
        state.liveState.taskLists.single.status,
        TaskListStateStatus.done,
      );
      expect(
        state.liveState.taskLists.single.items.single.status,
        TaskItemStatus.done,
      );
      expect(state.transcriptMessageEvents, isEmpty);
    });

    test('future lifecycle status clears stale actionable pinned state', () {
      final state = SessionDetailState(
        tool: 'codex',
        sessionId: 'future-state-status',
        events: [
          MessageWireEvent(
            seq: 1,
            message: AgentMessage.fromJson({
              'type': 'goal-state',
              'key': 'goal',
              'status': 'active',
              'title': 'Do not leave actionable',
            }),
          ),
          MessageWireEvent(
            seq: 2,
            message: AgentMessage.fromJson({
              'type': 'agent-activity',
              'key': 'activity',
              'kind': 'subagent',
              'status': 'running',
              'title': 'Do not leave running',
            }),
          ),
          MessageWireEvent(
            seq: 3,
            message: AgentMessage.fromJson({
              'type': 'goal-state',
              'key': 'goal',
              'status': 'future-terminal',
            }),
          ),
          MessageWireEvent(
            seq: 4,
            message: AgentMessage.fromJson({
              'type': 'agent-activity',
              'key': 'activity',
              'kind': 'subagent',
              'status': 'future-terminal',
              'title': 'Future state',
            }),
          ),
        ],
      );

      expect(state.liveState.goals, isEmpty);
      expect(state.liveState.activities, isEmpty);
    });

    test('history reset also replaces pinned state projection', () {
      final state = SessionDetailState(
        tool: 'codex',
        sessionId: 'session-reset-state',
        events: [
          MessageWireEvent(
            seq: 1,
            message: AgentMessage.fromJson({
              'type': 'goal-state',
              'status': 'active',
              'title': 'Obsolete',
            }),
          ),
          const HistoryWireEvent(reset: true, messages: []),
        ],
      );

      expect(state.liveState.isEmpty, isTrue);
    });

    test(
      'running activity upserts by key and terminal activity removes it',
      () {
        SessionDetailState stateWithStatus(
          String status, {
          int elapsed = 1000,
        }) {
          return SessionDetailState(
            tool: 'claude',
            sessionId: 'session-activity',
            events: [
              MessageWireEvent(
                seq: 1,
                message: AgentMessage.fromJson({
                  'type': 'agent-activity',
                  'key': 'agent:one',
                  'kind': 'subagent',
                  'title': 'Old title',
                  'status': 'running',
                  'elapsedMs': 100,
                }),
              ),
              MessageWireEvent(
                seq: 2,
                message: AgentMessage.fromJson({
                  'type': 'agent-activity',
                  'key': 'agent:one',
                  'kind': 'subagent',
                  'title': 'Current title',
                  'status': status,
                  'elapsedMs': elapsed,
                }),
              ),
            ],
          );
        }

        final running = stateWithStatus('running', elapsed: 5000);
        expect(running.liveState.activities, hasLength(1));
        expect(running.liveState.activities.single.title, 'Current title');
        expect(running.liveState.activities.single.elapsedMs, 5000);
        expect(running.transcriptMessageEvents, isEmpty);

        final done = stateWithStatus('done');
        expect(done.liveState.activities, isEmpty);
        expect(done.transcriptMessageEvents, isEmpty);
      },
    );

    test('authoritative idle clears stale running activity', () {
      final state = SessionDetailState(
        tool: 'codex',
        sessionId: 'session-idle-activity',
        events: [
          MessageWireEvent(
            seq: 1,
            message: AgentMessage.fromJson({
              'type': 'agent-activity',
              'key': 'agent:stale',
              'kind': 'subagent',
              'title': 'Stale child',
              'status': 'running',
            }),
          ),
          MessageWireEvent(
            seq: 2,
            message: AgentMessage.fromJson({
              'type': 'status',
              'status': 'idle',
            }),
          ),
        ],
      );

      expect(state.liveState.activities, isEmpty);
    });

    test('activity after an earlier idle boundary remains visible', () {
      final state = SessionDetailState(
        tool: 'codex',
        sessionId: 'session-new-activity',
        events: [
          MessageWireEvent(
            seq: 1,
            message: AgentMessage.fromJson({
              'type': 'status',
              'status': 'idle',
            }),
          ),
          MessageWireEvent(
            seq: 2,
            message: AgentMessage.fromJson({
              'type': 'agent-activity',
              'key': 'agent:new',
              'kind': 'subagent',
              'title': 'New child',
              'status': 'running',
            }),
          ),
        ],
      );

      expect(state.liveState.activities.single.title, 'New child');
    });

    test('latest history epoch owns gap and truncation diagnostics', () {
      const withDiagnostics = SessionDetailState(
        tool: 'codex',
        sessionId: 'session-history-diagnostics',
        events: [
          HistoryWireEvent(
            messages: [],
            gap: HistoryGap(
              code: 'HISTORY_CURSOR_GONE',
              message: 'A full replay was sent.',
            ),
            truncated: HistoryTruncation(shown: 500, total: 1200),
          ),
        ],
      );
      expect(withDiagnostics.latestHistoryGap?.code, 'HISTORY_CURSOR_GONE');
      expect(withDiagnostics.latestHistoryTruncation?.shown, 500);

      const clearedByNextEpoch = SessionDetailState(
        tool: 'codex',
        sessionId: 'session-history-diagnostics',
        events: [
          HistoryWireEvent(
            messages: [],
            gap: HistoryGap(
              code: 'HISTORY_CURSOR_GONE',
              message: 'A full replay was sent.',
            ),
          ),
          HistoryWireEvent(messages: []),
        ],
      );
      expect(clearedByNextEpoch.latestHistoryGap, isNull);
      expect(clearedByNextEpoch.latestHistoryTruncation, isNull);
    });
  });

  test('optimistic prompts use the canonical user-message renderer shape', () {
    const state = SessionDetailState(
      tool: 'codex',
      sessionId: 'session-optimistic',
      optimisticPrompts: [
        SessionOptimisticPrompt(
          clientMessageId: 'cm-1',
          text: 'Visible now',
          sentAt: 1000,
          queued: true,
        ),
      ],
    );

    expect(state.transcriptMessageEvents, hasLength(1));
    expect(
      state.transcriptMessageEvents.single.type,
      AgentMessageType.userMessage,
    );
    expect(state.transcriptMessageEvents.single.userMessageQueued, isTrue);
    expect(state.transcriptMessageEvents.single.raw['text'], 'Visible now');
  });

  test('memoizes event-derived projections for one immutable event log', () {
    final events = <WireEvent>[
      MessageWireEvent(
        seq: 1,
        message: AgentMessage.fromJson(const {
          'type': 'model-output',
          'key': 'answer',
          'text': 'Projected once',
        }),
      ),
      MessageWireEvent(
        seq: 2,
        message: AgentMessage.fromJson(const {
          'type': 'goal-state',
          'key': 'goal',
          'status': 'active',
          'title': 'Current goal',
        }),
      ),
    ];
    final optimisticPrompts = <SessionOptimisticPrompt>[
      const SessionOptimisticPrompt(
        clientMessageId: 'cm-cached',
        text: 'Queued locally',
        sentAt: 1000,
        queued: true,
      ),
    ];
    final state = SessionDetailState(
      tool: 'codex',
      sessionId: 'session-cached',
      events: events,
      optimisticPrompts: optimisticPrompts,
    );

    expect(identical(state.messageEvents, state.messageEvents), isTrue);
    expect(identical(state.liveState, state.liveState), isTrue);
    expect(
      identical(
        state.transcriptMessageEvents,
        state.transcriptMessageEvents,
      ),
      isTrue,
    );
    expect(identical(state.eventSummaries, state.eventSummaries), isTrue);

    final metadataOnlyCopy = state.copyWith(error: 'metadata changed');
    expect(
      identical(state.messageEvents, metadataOnlyCopy.messageEvents),
      isTrue,
    );
    expect(identical(state.liveState, metadataOnlyCopy.liveState), isTrue);
    expect(
      identical(
        state.transcriptMessageEvents,
        metadataOnlyCopy.transcriptMessageEvents,
      ),
      isTrue,
    );
  });

  test('models returns the latest authoritative options catalog', () {
    const state = SessionDetailState(
      tool: 'codex',
      sessionId: 'session-3',
      events: [
        OptionsWireEvent(
          models: [
            ModelOption(
              providerID: 'openai',
              modelID: 'old',
              label: 'Old',
            ),
          ],
          agents: [],
        ),
        OptionsWireEvent(
          models: [
            ModelOption(
              providerID: 'openai',
              modelID: 'gpt-5.4',
              label: 'GPT-5.4',
            ),
          ],
          agents: [],
        ),
      ],
    );

    expect(state.models.map((model) => model.modelID), ['gpt-5.4']);
  });

  group('compactSessionDetailEvents', () {
    test(
      'keeps transcript payloads out of the bounded debug/control log',
      () {
        final hugeText = List.filled(64 * 1024, 'x').join();
        final history = HistoryWireEvent(
          reset: true,
          messages: [
            AgentMessage.fromJson({
              'type': 'model-output',
              'key': 'tail',
              'text': hugeText,
            }),
          ],
          cursor: 'tail-cursor',
          olderCursor: 'older-cursor',
          hasEarlier: true,
        );
        var events = appendSessionDetailEventLog(const [], history);
        expect(events.single, isA<UnknownWireEvent>());
        expect(events.single.toJson().containsValue(hugeText), isFalse);
        expect(
          describeWireEvent(events.single),
          'history: 1 message',
        );

        events = appendSessionDetailEventLog(
          events,
          const CommandsWireEvent(
            commands: [SlashCommand(name: '/latest')],
          ),
        );
        events = appendSessionDetailEventLog(
          events,
          const OptionsWireEvent(
            models: [
              ModelOption(
                providerID: 'openai',
                modelID: 'gpt-latest',
                label: 'Latest',
              ),
            ],
            agents: [],
          ),
        );
        events = appendSessionDetailEventLog(
          events,
          const DraftWireEvent(text: 'latest draft', at: 9),
        );

        for (var index = 0; index < 300; index++) {
          events = appendSessionDetailEventLog(
            events,
            MessageWireEvent(
              seq: index,
              message: AgentMessage.fromJson({
                'type': 'model-output',
                'key': 'stream-$index',
                'text': hugeText,
              }),
            ),
          );
        }
        final state = SessionDetailState(
          tool: 'claude',
          sessionId: 'session-compact',
          events: events,
          transcriptWindow: TranscriptHistoryWindow.fromHistory(history),
        );

        expect(
          events.length,
          lessThanOrEqualTo(kMaxRetainedSessionDetailEvents),
        );
        expect(
          events.whereType<MessageWireEvent>(),
          isEmpty,
          reason: 'debug state must not duplicate decoded transcript bodies',
        );
        expect(state.commands.single.name, '/latest');
        expect(state.models.single.modelID, 'gpt-latest');
        expect(state.latestDraft?.text, 'latest draft');
        expect(state.transcriptMessageEvents.single.raw['text'], hugeText);
      },
    );

    test('returns the same list unchanged when within the cap', () {
      final events = <WireEvent>[
        const DraftWireEvent(text: 'hi', at: 1),
        MessageWireEvent(
          seq: 1,
          message: AgentMessage.fromJson(const {
            'type': 'user-message',
            'key': 'u1',
            'text': 'only',
          }),
        ),
      ];

      expect(identical(compactSessionDetailEvents(events), events), isTrue);
    });
  });

  test('hard-incompatible hello makes session state read only', () {
    const broker = BrokerContractIdentity(
      revision: 3,
      minimumClientRevision: 2,
      surfaceHash: 'fnv1a32:12345678',
    );
    const state = SessionDetailState(
      tool: 'codex',
      sessionId: 'session-1',
      events: [
        HelloWireEvent(
          brokerVersion: '1.2.3',
          brokerContract: broker,
          compatibility: BrokerClientCompatibility(
            status: BrokerClientCompatibilityStatus.hardIncompatible,
            readOnly: true,
            reason: 'revision gap',
            broker: broker,
          ),
        ),
      ],
    );

    expect(state.hello?.brokerVersion, '1.2.3');
    expect(state.compatibilityReadOnly, isTrue);
  });

  group('SessionDetailState.telemetry', () {
    const telemetryState = SessionDetailState(
      tool: 'claude',
      sessionId: 'session-telemetry',
      events: [
        MessageWireEvent(
          seq: 1,
          message: AgentMessage(
            type: AgentMessageType.modelOutput,
            raw: {'type': 'model-output', 'text': 'Working on it'},
          ),
        ),
        MessageWireEvent(
          seq: 2,
          message: AgentMessage(
            type: AgentMessageType.tokenCount,
            raw: {'type': 'token-count', 'input': 4, 'output': 567},
          ),
        ),
        MessageWireEvent(
          seq: 3,
          message: AgentMessage(
            type: AgentMessageType.metadataUpdate,
            raw: {
              'type': 'metadata-update',
              'key': 'contextUsage',
              'value': {'used': 90, 'max': 100},
            },
          ),
        ),
        MessageWireEvent(
          seq: 4,
          message: AgentMessage(
            type: AgentMessageType.metadataUpdate,
            raw: {
              'type': 'metadata-update',
              'key': 'sessionStats',
              'value': {
                'sessionId': 'pi-session',
                'tokens': {'input': 4, 'output': 567},
              },
            },
          ),
        ),
      ],
    );

    test('streaming telemetry stays out of the transcript', () {
      expect(
        telemetryState.transcriptMessageEvents.map((m) => m.type),
        [AgentMessageType.modelOutput],
        reason: 'token and context frames are read as a value, not a message',
      );
    });

    test('telemetry is still reachable as the latest reading', () {
      expect(telemetryState.telemetry.totalTokens, 571);
      expect(telemetryState.telemetry.contextPercent, closeTo(90, 0.001));
      expect(telemetryState.telemetry.isContextCritical, isTrue);
    });

    test('every raw frame stays in the canonical list for Debug', () {
      expect(telemetryState.messageEvents, hasLength(4));
    });

    test('a run summary keeps its transcript row', () {
      const state = SessionDetailState(
        tool: 'claude',
        sessionId: 'session-run-summary',
        events: [
          MessageWireEvent(
            seq: 1,
            message: AgentMessage(
              type: AgentMessageType.runSummary,
              raw: {
                'type': 'run-summary',
                'turnId': 'turn-1',
                'status': 'completed',
              },
            ),
          ),
        ],
      );

      expect(
        state.transcriptMessageEvents.map((m) => m.type),
        [AgentMessageType.runSummary],
      );
    });
  });

  group('describeWireEvent debug evidence', () {
    const answer = 'The answer is 42.';
    const message = AgentMessage(
      type: AgentMessageType.modelOutput,
      id: 'msg_abc',
      seq: 7,
      raw: {
        'type': 'model-output',
        'key': 'codex:t1:msg_abc:t',
        'turnId': 't1',
        'text': answer,
        'final': true,
      },
    );

    test('carries the identity needed to tell one message from two', () {
      final summary = describeWireEvent(
        const MessageWireEvent(seq: 7, message: message),
      );

      expect(summary, contains('model-output'));
      expect(summary, contains('key=codex:t1:msg_abc:t'));
      expect(summary, contains('id=msg_abc'));
      expect(summary, contains('seq=7'));
      expect(summary, contains('turn=t1'));
      // `String.length` counts UTF-16 code units, so the unit says so: an
      // emoji or a CJK body would make a byte label read wrong.
      expect(summary, contains('text=${answer.length}cu/'));
    });

    test('sizes text in the unit it actually measures', () {
      // One astral character: two code units, four UTF-8 bytes, one rune.
      final summary = describeWireEvent(
        const MessageWireEvent(
          seq: 1,
          message: AgentMessage(
            type: AgentMessageType.modelOutput,
            raw: {'type': 'model-output', 'key': 'k', 'text': '\u{1F600}'},
          ),
        ),
      );

      expect(summary, contains('text=2cu/'));
    });

    test('never puts transcript text on screen', () {
      final summary = describeWireEvent(
        const MessageWireEvent(seq: 7, message: message),
      );

      expect(summary.contains(answer), isFalse);
      expect(summary.contains('answer is'), isFalse);
    });

    test('two copies of one message fingerprint alike, two answers do not', () {
      String summaryOf(String text) => describeWireEvent(
        MessageWireEvent(
          seq: 1,
          message: AgentMessage(
            type: AgentMessageType.modelOutput,
            raw: {'type': 'model-output', 'key': 'k', 'text': text},
          ),
        ),
      );

      expect(summaryOf(answer), summaryOf(answer));
      expect(summaryOf(answer), isNot(summaryOf('A different answer.')));
    });

    test('never puts the composer draft on screen either', () {
      const draft = 'my unsent password reset note';
      final summary = describeWireEvent(
        const DraftWireEvent(text: draft, at: 1, revision: 3),
      );

      expect(summary, isNot(contains(draft)));
      expect(summary, isNot(contains('unsent')));
      expect(summary, contains('draft: ${draft.length}cu/'));
    });

    test('a cleared draft stays distinguishable from a short one', () {
      String draftSummary(String text) =>
          describeWireEvent(DraftWireEvent(text: text, at: 1));

      expect(draftSummary(''), 'draft: cleared');
      expect(draftSummary('x'), isNot(contains('cleared')));
    });
  });

  group('H1 active transcript resource window', () {
    AgentMessage message(int index, {int textBytes = 16}) =>
        AgentMessage.fromJson({
          'type': 'model-output',
          'key': 'm$index',
          // Equal visible text is deliberate: identity must never come from it.
          'text': 'same '.padRight(textBytes, 'x'),
        });

    test('tail byte eviction is explicit and remains within the named cap', () {
      final window = TranscriptHistoryWindow.fromHistory(
        HistoryWireEvent(
          messages: [
            for (var index = 0; index < 100; index++)
              message(index, textBytes: 64 * 1024),
          ],
          reset: true,
          cursor: 'tail',
          olderCursor: 'older',
          hasEarlier: true,
          truncated: const HistoryTruncation(shown: 100, total: 1000),
        ),
      );

      expect(window.messageCount, lessThan(kRetainedTranscriptTailMessages));
      expect(
        window.estimatedBytes,
        lessThanOrEqualTo(kMaxActiveTranscriptDecodedBytes),
      );
      expect(window.tailPrefixEvicted, isTrue);
      expect(
        window.leadingGap?.kind,
        TranscriptHistoryGapKind.reconnectRequired,
      );
      expect(window.canonicalMessages.last.raw['key'], 'm99');
    });

    test(
      'explicit pages retain contiguous runs and expose reloadable middle gaps',
      () {
        var window = TranscriptHistoryWindow.fromHistory(
          HistoryWireEvent(
            messages: [for (var i = 2400; i < 2500; i++) message(i)],
            reset: true,
            cursor: 'tail',
            olderCursor: 'cursor-24',
            hasEarlier: true,
            truncated: const HistoryTruncation(shown: 100, total: 2500),
          ),
        );
        for (var page = 23; page >= 16; page--) {
          final start = page * 100;
          final mutation = window.prependPage(
            HistoryPageWireEvent(
              messages: [
                for (var index = start; index < start + 100; index++)
                  message(index),
              ],
              cursor: 'cursor-$page',
              hasMore: true,
              endOfHistory: false,
            ),
            requestedCursor: 'cursor-${page + 1}',
            preserveMessageKey: 'model-output:key:m${start + 100}',
          );
          expect(mutation.accepted, isTrue);
          window = mutation.window;
        }

        expect(
          window.pages.length,
          lessThanOrEqualTo(kMaxActiveTranscriptPages),
        );
        expect(
          window.messageCount,
          lessThanOrEqualTo(kMaxActiveTranscriptMessages),
        );
        expect(
          window.estimatedBytes,
          lessThanOrEqualTo(kMaxActiveTranscriptDecodedBytes),
        );
        expect(window.gaps, isNotEmpty);
        expect(
          window.gaps.every(
            (gap) =>
                gap.kind == TranscriptHistoryGapKind.reloadable &&
                gap.reloadCursor != null,
          ),
          isTrue,
        );
        expect(
          window.transcriptMessageSegmentsWith(const [], const {}).length,
          window.gaps.length + 1,
        );
        expect(
          window.latestHistoryTruncation,
          isNull,
          reason:
              'attach-tail metadata must not describe a non-contiguous '
              'page table',
        );

        final reloadCursor = window.gaps.last.reloadCursor!;
        final page = int.parse(reloadCursor.split('-').last) - 1;
        final start = page * 100;
        final reloaded = window.prependPage(
          HistoryPageWireEvent(
            messages: [
              for (var index = start; index < start + 100; index++)
                message(index),
            ],
            cursor: 'cursor-$page',
            hasMore: true,
            endOfHistory: false,
          ),
          requestedCursor: reloadCursor,
          preserveMessageKey: 'model-output:key:m2400',
        );
        expect(reloaded.accepted, isTrue);
        expect(
          reloaded.window.canonicalMessages.any(
            (item) => item.raw['key'] == 'm$start',
          ),
          isTrue,
        );
      },
    );

    test(
      'repeated middle load/evict cycles keep derived-run retention constant',
      () {
        HistoryPageWireEvent pageEvent(String cursor, int start) =>
            HistoryPageWireEvent(
              messages: [
                for (var index = start; index < start + 100; index++)
                  message(index),
              ],
              cursor: cursor,
              hasMore: true,
              endOfHistory: false,
            );

        var window = TranscriptHistoryWindow.fromHistory(
          HistoryWireEvent(
            messages: [for (var i = 2400; i < 2500; i++) message(i)],
            reset: true,
            cursor: 'tail',
            olderCursor: 'cursor-24',
            hasEarlier: true,
          ),
        );
        // Fill the five-page window so every later load forces an eviction.
        for (var page = 23; page >= 20; page--) {
          final mutation = window.prependPage(
            pageEvent('cursor-$page', page * 100),
            requestedCursor: 'cursor-${page + 1}',
          );
          expect(mutation.accepted, isTrue);
          window = mutation.window;
        }

        List<TranscriptConversationSegment> render(
          TranscriptHistoryWindow window,
        ) => SessionDetailState(
          tool: 'codex',
          sessionId: 'derived-run-churn',
          transcriptWindow: window,
        ).transcriptConversationSegments(ToolDisplayMode.responsive);

        // The memory contract has to hold on EVERY frame, not just the last
        // one. A page stops owning a run the moment an older page is prepended
        // in front of it, and that intermediate frame — not the settled one —
        // is where a stale run would still pin pages the window just evicted.
        void expectRetentionContract(
          TranscriptHistoryWindow window,
          String frame,
        ) {
          final segments = render(window);
          final active = window.pages.toSet();
          final reachable = <TranscriptHistoryPage>{};
          for (final page in window.pages) {
            reachable.addAll(debugRetainedDerivedRunPages(page));
          }
          expect(
            reachable.difference(active),
            isEmpty,
            reason:
                '$frame: a cache reachable from the active window must not '
                'retain a page the window already evicted',
          );
          // Every active page belongs to exactly one run, and every run is
          // cached at its owner — so retention is not merely a SUBSET of the
          // window, it is exactly the window. Anything extra is a superseded
          // run still holding pages; anything missing is a run that failed to
          // cache. Equality catches both, where a subset check would let a
          // second retained combination slip through.
          expect(
            reachable,
            equals(active),
            reason: '$frame: retained pages must be exactly the active window',
          );
          expect(
            window.pages.where(
              (page) => debugRetainedDerivedRunCount(page) > 0,
            ),
            hasLength(segments.length),
            reason: '$frame: only current run owners may keep a projection',
          );
          expect(
            reachable.length,
            lessThanOrEqualTo(kMaxActiveTranscriptPages),
            reason: '$frame: retained pages exceed the H1 page budget',
          );
          expect(
            reachable.fold<int>(0, (sum, page) => sum + page.messages.length),
            lessThanOrEqualTo(kMaxActiveTranscriptMessages),
            reason: '$frame: retained messages exceed the H1 message budget',
          );
          expect(
            reachable.fold<int>(0, (sum, page) => sum + page.estimatedBytes),
            lessThanOrEqualTo(kMaxActiveTranscriptDecodedBytes),
            reason: '$frame: retained bytes exceed the H1 byte budget',
          );
        }

        final owner = window.pages.first;
        final everySeenPage = <TranscriptHistoryPage>{...window.pages};
        expectRetentionContract(window, 'seed');

        // Load one older page (evicting the newest retained page and
        // reopening the reloadable gap), then reload that gap. Each cycle
        // hands the SAME owner page a fresh run composition, which is exactly
        // the churn that used to append an entry per cycle.
        const cycles = 12;
        for (var cycle = 0; cycle < cycles; cycle++) {
          final older = window.prependPage(
            pageEvent('cursor-older-$cycle', 1000 - cycle * 100),
            requestedCursor: window.pages.first.olderCursor!,
          );
          expect(older.accepted, isTrue);
          window = older.window;
          everySeenPage.addAll(window.pages);
          expectRetentionContract(window, 'cycle $cycle after older load');

          final reloaded = window.prependPage(
            pageEvent('cursor-23', 2300),
            requestedCursor: 'cursor-24',
          );
          expect(reloaded.accepted, isTrue);
          window = reloaded.window;
          everySeenPage.addAll(window.pages);
          expectRetentionContract(window, 'cycle $cycle after gap reload');
        }

        expect(
          window.pages.first,
          same(owner),
          reason:
              'the churn must keep one owner page visible, or it would not '
              'exercise the per-owner derived-run cache at all',
        );
        expect(
          debugRetainedDerivedRunCount(owner),
          1,
          reason: 'an owner retains only its current run',
        );
        // Entry COUNT was never the contract — one entry referencing an
        // evicted page still pins that page's messages, keys, and
        // presentation. `expectRetentionContract` asserts the real thing on
        // every frame above: the unique page set reachable from the active
        // window's caches, held inside H1's five-page/4 MiB budget.
        expect(
          everySeenPage.length,
          greaterThan(cycles),
          reason: 'the churn must really have produced fresh page objects',
        );
        expect(
          everySeenPage.length,
          greaterThan(window.pages.length),
          reason:
              'pages must actually have been evicted, or nothing above could '
              'have retained a stale one',
        );
      },
    );

    test(
      'one live delta inspects only the recent tail at every history depth',
      () {
        final shallow = TranscriptHistoryWindow.fromHistory(
          HistoryWireEvent(
            messages: [for (var i = 2400; i < 2500; i++) message(i)],
            reset: true,
            cursor: 'tail',
            olderCursor: 'cursor-24',
            hasEarlier: true,
          ),
        );
        var deep = shallow;
        for (var page = 23; page >= 20; page--) {
          final start = page * 100;
          deep = deep
              .prependPage(
                HistoryPageWireEvent(
                  messages: [
                    for (var index = start; index < start + 100; index++)
                      message(index),
                  ],
                  cursor: 'cursor-$page',
                  hasMore: true,
                  endOfHistory: false,
                ),
                requestedCursor: 'cursor-${page + 1}',
              )
              .window;
        }
        expect(deep.messageCount, greaterThan(shallow.messageCount));

        final shallowWork = TranscriptHistoryWorkCounter();
        final deepWork = TranscriptHistoryWorkCounter();
        shallow.applyLiveMessage(message(2500), work: shallowWork);
        deep.applyLiveMessage(message(2500), work: deepWork);

        expect(shallowWork.inspectedMessages, kRetainedTranscriptTailMessages);
        expect(deepWork.inspectedMessages, shallowWork.inspectedMessages);
        expect(deepWork.estimatedMessages, shallowWork.estimatedMessages);
        expect(
          deepWork.inspectedMessages,
          lessThanOrEqualTo(kTranscriptHistoryPageMessages),
        );
      },
    );

    test(
      'production conversation presentation reuses every unchanged older page',
      () {
        AgentMessage presentationMessage(int index) => index % 20 == 1
            ? AgentMessage.fromJson({
                'type': 'user-message',
                'key': 'u$index',
                'text': 'prompt $index',
              })
            : message(index);
        final shallow = TranscriptHistoryWindow.fromHistory(
          HistoryWireEvent(
            messages: [
              for (var i = 2400; i < 2500; i++) presentationMessage(i),
            ],
            reset: true,
            cursor: 'tail',
            olderCursor: 'cursor-24',
            hasEarlier: true,
          ),
        );
        var deep = shallow;
        for (var page = 23; page >= 20; page--) {
          final start = page * 100;
          deep = deep
              .prependPage(
                HistoryPageWireEvent(
                  messages: [
                    for (var index = start; index < start + 100; index++)
                      presentationMessage(index),
                  ],
                  cursor: 'cursor-$page',
                  hasMore: true,
                  endOfHistory: false,
                ),
                requestedCursor: 'cursor-${page + 1}',
              )
              .window;
        }

        const optimisticPrompts = [
          SessionOptimisticPrompt(
            clientMessageId: 'pending-tail',
            text: 'Pending at the recent tail',
            sentAt: 1,
            queued: true,
            anchorMessageKey: 'model-output:key:m2499',
          ),
        ];
        const clientKeys = {
          'user-message:key:u2201': 'older-decoration-fixture',
        };
        SessionDetailState stateFor(TranscriptHistoryWindow window) =>
            SessionDetailState(
              tool: 'codex',
              sessionId: 'presentation-depth',
              transcriptWindow: window,
              optimisticPrompts: optimisticPrompts,
              transcriptClientKeys: clientKeys,
            );
        final shallowBefore = stateFor(
          shallow,
        ).transcriptConversationSegments(ToolDisplayMode.responsive);
        final deepBefore =
            stateFor(
              deep,
            ).transcriptConversationSegments(
              ToolDisplayMode.responsive,
            );
        expect(shallowBefore, hasLength(1));
        expect(deepBefore.length, greaterThan(shallowBefore.length));

        final liveUpdate = AgentMessage.fromJson({
          'type': 'model-output',
          'key': 'm2499',
          'text': 'updated live tail',
        });
        final shallowAfterWindow = shallow.applyLiveMessage(liveUpdate);
        final deepAfterWindow = deep.applyLiveMessage(liveUpdate);
        final shallowWork = TranscriptHistoryWorkCounter();
        final deepWork = TranscriptHistoryWorkCounter();
        final shallowAfter = stateFor(shallowAfterWindow)
            .transcriptConversationSegments(
              ToolDisplayMode.responsive,
              work: shallowWork,
            );
        final deepAfter =
            stateFor(
              deepAfterWindow,
            ).transcriptConversationSegments(
              ToolDisplayMode.responsive,
              work: deepWork,
            );

        expect(deepWork.derivedMessages, shallowWork.derivedMessages);
        expect(deepWork.projectedMessages, shallowWork.projectedMessages);
        expect(deepWork.conversationMessages, shallowWork.conversationMessages);
        expect(
          deepWork.derivedMessages,
          lessThanOrEqualTo(kTranscriptHistoryPageMessages * 2),
        );
        expect(
          deepWork.projectedMessages,
          lessThanOrEqualTo(kTranscriptHistoryPageMessages),
        );
        expect(
          deepWork.conversationMessages,
          lessThanOrEqualTo(
            kTranscriptHistoryPageMessages + optimisticPrompts.length,
          ),
        );
        expect(deepWork.reusedDerivedRuns, greaterThanOrEqualTo(1));
        expect(deepWork.reusedConversationSegments, greaterThanOrEqualTo(1));
        expect(shallowWork.reusedDerivedRuns, 0);
        expect(shallowWork.reusedConversationSegments, 0);
        expect(
          deepAfter.first.turns.first,
          same(deepBefore.first.turns.first),
          reason: 'unchanged older turn descriptors must retain identity',
        );
        expect(deepAfter.length, deepBefore.length);
        expect(shallowAfter, hasLength(1));
      },
    );
  });

  group('SessionDetailState.forActiveSource', () {
    const brokerA = RosterSource(
      profileId: 'profile-a',
      endpoint: 'http://alpha.invalid:7734',
    );
    const brokerB = RosterSource(
      profileId: 'profile-b',
      endpoint: 'http://beta.invalid:7734',
    );
    // The SAME profile, re-pointed at another machine. Its id is unchanged, so
    // this is exactly the case an id comparison could not see.
    const brokerAMoved = RosterSource(
      profileId: 'profile-a',
      endpoint: 'http://gamma.invalid:7734',
    );

    /// Everything one broker can report about its own session.
    const owned = SessionDetailState(
      tool: 'claude',
      sessionId: 'session-1',
      source: brokerA,
      connectionStatus: SessionDetailConnectionStatus.connected,
      sessionInfo: SessionInfo(
        id: 'session-1',
        tool: 'claude',
        title: 'Profile A title',
        status: SessionStatus.idle,
        attachMode: AttachMode.live,
      ),
      events: [
        HistoryWireEvent(
          messages: [
            AgentMessage(id: 'a-history', type: AgentMessageType.userMessage),
          ],
        ),
        MessageWireEvent(
          seq: 1,
          message: AgentMessage(
            id: 'a-live',
            type: AgentMessageType.modelOutput,
          ),
        ),
        DraftWireEvent(text: 'profile A draft', at: 20),
        CommandsWireEvent(commands: [SlashCommand(name: 'a-command')]),
        OptionsWireEvent(
          models: [
            ModelOption(
              providerID: 'a-provider',
              modelID: 'a-model',
              label: 'A model',
            ),
          ],
          agents: [],
          modes: [ModeOption(value: 'a-mode', label: 'A mode')],
        ),
      ],
      error: 'profile A error',
      draftSurface: SessionDraftSurface(
        text: 'profile A draft',
        token: 3,
        kind: SessionDraftSurfaceKind.replace,
      ),
      optimisticPrompts: [
        SessionOptimisticPrompt(
          clientMessageId: 'a-prompt',
          text: 'profile A prompt',
          sentAt: 1,
          queued: false,
        ),
      ],
      renameSessionActionState: SessionActionState(
        phase: SessionActionPhase.inProgress,
      ),
      interruptPhase: SessionInterruptPhase.requested,
      historyPageError: 'profile A paging error',
    );

    test('the same broker keeps every field', () {
      expect(owned.forActiveSource(brokerA), same(owned));
    });

    test('the same profile at another endpoint keeps nothing', () {
      // A profile is an editable pointer: its id survives the edit, the broker
      // behind it does not.
      final projected = owned.forActiveSource(brokerAMoved);
      expect(projected.source, isNull);
      expect(projected.sessionInfo, isNull);
      expect(projected.events, isEmpty);
    });

    test('an unstamped state is passed through', () {
      // Nothing resolved a profile yet, so there is no broker content to hide.
      const unstamped = SessionDetailState(tool: 'claude', sessionId: 's');
      expect(unstamped.forActiveSource(brokerB), same(unstamped));
    });

    test('a mismatched broker keeps no broker-owned payload', () {
      // Not just the session frame: the transcript, the draft the composer
      // would apply, the error banner, the commands and models the controls
      // offer, and every in-flight action all belong to profile A's session.
      const neutral = SessionDetailState(
        tool: 'claude',
        sessionId: 'session-1',
      );
      final projected = owned.forActiveSource(brokerB);

      expect(projected.sessionInfo, isNull);
      expect(projected.events, isEmpty);
      expect(projected.messageEvents, isEmpty);
      expect(projected.terminalOutputMessages, isEmpty);
      expect(projected.latestDraft, isNull);
      expect(projected.draftSurface, isNull);
      expect(projected.error, isNull);
      expect(projected.historyPageError, isNull);
      expect(projected.commands, isEmpty);
      expect(projected.models, isEmpty);
      expect(projected.modes, isEmpty);
      expect(projected.optimisticPrompts, isEmpty);
      expect(projected.renameSessionActionState.phase, SessionActionPhase.idle);
      expect(projected.interruptPhase, SessionInterruptPhase.idle);
      expect(projected.connectionStatus, neutral.connectionStatus);
      expect(
        projected.bootstrapState.readiness,
        neutral.bootstrapState.readiness,
      );
      expect(projected.source, isNull);

      // The session it addresses is unchanged — this is the same page, with
      // nothing on it yet.
      expect(projected.tool, 'claude');
      expect(projected.sessionId, 'session-1');
    });

    test('the source state is left intact', () {
      // The projection is a view for one consumer, not a mutation: the
      // controller still owns profile A's content until its own reset lands.
      owned.forActiveSource(brokerB);
      expect(owned.sessionInfo?.title, 'Profile A title');
      expect(owned.events, isNotEmpty);
    });
  });
}
