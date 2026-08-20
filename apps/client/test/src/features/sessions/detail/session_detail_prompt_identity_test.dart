// Behavior files retain a common import set to keep split diffs mechanical.
// ignore_for_file: unused_import, unnecessary_import

import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_runtime.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_conversation_turns.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_transcript_display.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/tool_display_mode.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_controller_test_harness.dart';

/// C1R regression coverage: a locally accepted prompt keeps ONE stable
/// display identity and ONE stable logical position while its native
/// user-message echo is delayed, and converges to exactly one canonical row.
void main() {
  late FakeSessionDetailConnection fakeConnection;
  late RecordingSessionOutboxRepository fakeOutboxRepository;
  late RecordingSessionTranscriptRepository fakeTranscriptRepository;
  late ProviderContainer container;

  setUp(() {
    fakeConnection = FakeSessionDetailConnection();
    fakeOutboxRepository = RecordingSessionOutboxRepository();
    fakeTranscriptRepository = RecordingSessionTranscriptRepository();
    container = ProviderContainer(
      overrides: [
        ...dr1DurableDraftTestOverrides(),
        activeBrokerProfileProvider.overrideWith(
          (ref) => fakeControllerBrokerProfile(),
        ),
        brokerClientProvider.overrideWith(
          (ref) async => FakeControllerBrokerClient(),
        ),
        sessionNotificationLifecycleMonitorProvider.overrideWithValue(
          StubBrokerAppLifecycleMonitor(
            currentState: BrokerAppLifecycleState.paused,
          ),
        ),
        sessionNotificationSinkProvider.overrideWithValue(
          CollectingNotificationSink(),
        ),
        sessionDetailConnectionFactoryProvider.overrideWithValue(
          ({required resolver, required sessionId, required tool}) {
            fakeConnection
              ..sessionId = sessionId
              ..tool = tool;
            return fakeConnection;
          },
        ),
        sessionArtifactFileServiceProvider.overrideWithValue(
          FakeControllerArtifactFileService(),
        ),
        sessionAttachmentPickerProvider.overrideWithValue(
          FakeControllerAttachmentPicker(),
        ),
        sessionArtifactTransferRepositoryProvider.overrideWithValue(
          InMemorySessionArtifactTransferRepository(),
        ),
        sessionOutboxRepositoryProvider.overrideWithValue(
          fakeOutboxRepository,
        ),
        sessionTranscriptRepositoryProvider.overrideWithValue(
          fakeTranscriptRepository,
        ),
        sessionDriveIntentStoreProvider.overrideWithValue(
          InMemoryControllerDriveIntentStore(),
        ),
        sessionListRepositoryProvider.overrideWith(
          (ref) async => InMemorySessionListRepository(),
        ),
        sessionListControllerProvider.overrideWith(
          StubSessionListController.new,
        ),
      ],
    );
  });

  tearDown(() {
    container.dispose();
  });

  const key = SessionDetailKey(tool: 'codex', sessionId: 'session-c1r');

  SessionDetailState read() =>
      container.read(sessionDetailControllerProvider(key));

  Future<SessionDetailController> attach() async {
    keepSessionDetailAlive(container, key);
    final controller = container.read(
      sessionDetailControllerProvider(key).notifier,
    );
    await controller.attach();
    return controller;
  }

  AgentMessage message(Map<String, dynamic> json) =>
      AgentMessage.fromJson(json);

  void emitMessage(Map<String, dynamic> json, {int seq = 0}) {
    fakeConnection.emitEvent(
      MessageWireEvent(seq: seq, message: message(json)),
    );
  }

  /// One projected transcript frame: `type:key[:queued]` per row, so a trace
  /// asserts order AND identity, not just final contents.
  List<String> projectedRows() {
    String describe(AgentMessage m) {
      final identity = m.raw['clientKey'] ?? m.raw['key'] ?? m.id ?? '?';
      final queued = m.userMessageQueued ? ':queued' : '';
      return '${m.type.wireValue}:$identity$queued';
    }

    return [for (final m in read().transcriptMessageEvents) describe(m)];
  }

  List<String> turnKeys() => [
    for (final turn in buildConversationTurns(
      messages: read().transcriptMessageEvents,
      mode: ToolDisplayMode.responsive,
    ))
      turn.turnKey,
  ];

  const seedHistory = HistoryWireEvent(reset: true, messages: []);

  Future<void> seedEarlierTurn() async {
    fakeConnection.emitEvent(
      HistoryWireEvent(
        reset: true,
        messages: [
          message(const {
            'type': 'user-message',
            'key': 'u0',
            'text': 'earlier ask',
          }),
          message(const {
            'type': 'model-output',
            'key': 'm0',
            'text': 'earlier answer',
            'final': true,
          }),
        ],
      ),
    );
    await Future<void>.delayed(Duration.zero);
  }

  group('C1R prompt identity and position', () {
    test(
      'idle send: answer streaming before the echo never overtakes the '
      'prompt, and the delayed echo adopts the same position and identity',
      () async {
        final controller = await attach();
        await seedEarlierTurn();

        await controller.sendPrompt('what next');
        final clientMessageId = fakeConnection.lastPromptClientMessageId!;

        // Frame 1 — accepted locally: one optimistic row after the canonical
        // tail, opening its own turn keyed by the send correlation.
        expect(projectedRows(), [
          'user-message:u0',
          'model-output:m0',
          'user-message:$clientMessageId',
        ]);
        expect(turnKeys(), [
          'turn:user:u0',
          'turn:user-send:$clientMessageId',
        ]);

        // Frame 2 — the answer streams in before the user echo. It cannot
        // move in front of the prompt.
        emitMessage(const {
          'type': 'model-output',
          'key': 'a1',
          'text': 'the answer',
        });
        await Future<void>.delayed(Duration.zero);
        expect(projectedRows(), [
          'user-message:u0',
          'model-output:m0',
          'user-message:$clientMessageId',
          'model-output:a1',
        ]);

        // Frame 3 — the delayed echo arrives AFTER its own answer. Canonical
        // arrival order keeps the echo last…
        emitMessage({
          'type': 'user-message',
          'key': 'native-1',
          'clientKey': clientMessageId,
          'text': 'what next',
        });
        await Future<void>.delayed(Duration.zero);
        expect(
          read().messageEvents.last.userMessageKey,
          'native-1',
          reason: 'the canonical event list is never reordered',
        );
        // …but the DISPLAYED row is the canonical echo at the prompt's stable
        // boundary, still in front of its answer, same turn identity.
        expect(projectedRows(), [
          'user-message:u0',
          'model-output:m0',
          'user-message:$clientMessageId',
          'model-output:a1',
        ]);
        final userRows = read().transcriptMessageEvents
            .where((m) => m.type == AgentMessageType.userMessage)
            .toList();
        expect(userRows, hasLength(2));
        expect(userRows.last.userMessageKey, 'native-1');
        expect(userRows.last.userMessageClientKey, clientMessageId);
        expect(turnKeys(), [
          'turn:user:u0',
          'turn:user-send:$clientMessageId',
        ]);
        expect(read().optimisticPrompts.single.isDelivered, isTrue);
      },
    );

    test(
      'queued mid-turn: the previous final answer and run summary are '
      'retained, and the queued row neither opens a turn nor steals output',
      () async {
        final controller = await attach();
        fakeConnection
          ..emitEvent(
            HistoryWireEvent(
              reset: true,
              messages: [
                message(const {
                  'type': 'user-message',
                  'key': 'uA',
                  'text': 'first ask',
                }),
                message(const {
                  'type': 'model-output',
                  'key': 'mA',
                  'text': 'first answer',
                  'final': true,
                }),
                message(const {
                  'type': 'run-summary',
                  'key': 'runA',
                  'status': 'done',
                  'totalRuntimeMs': 1200,
                  'assistantMessageKey': 'mA',
                  'userMessageKey': 'uA',
                }),
                message(const {
                  'type': 'user-message',
                  'key': 'uB',
                  'text': 'second ask',
                }),
                message(const {
                  'type': 'model-output',
                  'key': 'b1',
                  'text': 'second answer part 1',
                }),
              ],
            ),
          )
          ..emitSessionControl(
            const {
              'drive': {'state': 'driving', 'supported': true},
              'terminalSync': {
                'supported': false,
                'syncAvailable': false,
                'active': false,
              },
            },
            status: 'working',
          );
        await Future<void>.delayed(Duration.zero);

        await controller.sendPrompt('third ask');
        final clientMessageId = fakeConnection.lastPromptClientMessageId!;
        expect(read().optimisticPrompts.single.queued, isTrue);

        // The running turn keeps streaming after the queued send.
        emitMessage(const {
          'type': 'model-output',
          'key': 'b2',
          'text': 'second answer part 2',
        });
        await Future<void>.delayed(Duration.zero);

        expect(projectedRows(), [
          'user-message:uA',
          'model-output:mA',
          'run-summary:runA',
          'user-message:uB',
          'model-output:b1',
          'user-message:$clientMessageId:queued',
          'model-output:b2',
        ]);
        final turns = buildConversationTurns(
          messages: read().transcriptMessageEvents,
          mode: ToolDisplayMode.responsive,
        );
        // The queued row does NOT open a turn: turn B keeps both output rows.
        expect(turns, hasLength(2));
        expect(turns[0].runSummary, isNotNull);
        expect(turns[0].runSummary!.totalRuntimeMs, 1200);
        expect(
          turns[1].content.map((e) => e.runtimeType.toString()),
          isNotEmpty,
        );
        expect(turns[1].modelText, isEmpty, reason: 'b1/b2 not final yet');
      },
    );

    test('an ack alone never removes the optimistic row before its echo, and '
        'a run summary before the echo cannot displace it', () async {
      final controller = await attach();
      await seedEarlierTurn();
      await controller.sendPrompt('acked early');
      final clientMessageId = fakeConnection.lastPromptClientMessageId!;

      fakeConnection.emitEvent(
        AckWireEvent(
          ackKind: 'client-message',
          clientMessageId: clientMessageId,
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(read().optimisticPrompts.single.isDelivered, isFalse);
      expect(projectedRows().last, 'user-message:$clientMessageId');

      emitMessage(const {
        'type': 'run-summary',
        'key': 'run0',
        'status': 'done',
        'totalRuntimeMs': 900,
        'assistantMessageKey': 'm0',
        'userMessageKey': 'u0',
      });
      await Future<void>.delayed(Duration.zero);
      expect(read().optimisticPrompts.single.isDelivered, isFalse);
      // The summary appended after the send cannot displace the prompt: the
      // row keeps the boundary it captured at acceptance.
      expect(projectedRows(), [
        'user-message:u0',
        'model-output:m0',
        'user-message:$clientMessageId',
        'run-summary:run0',
      ]);

      emitMessage({
        'type': 'user-message',
        'key': 'native-ack',
        'clientKey': clientMessageId,
        'text': 'acked early',
      });
      await Future<void>.delayed(Duration.zero);
      final userRows = read().transcriptMessageEvents
          .where((m) => m.type == AgentMessageType.userMessage)
          .toList();
      expect(userRows, hasLength(2));
      expect(userRows.last.userMessageKey, 'native-ack');
    });

    test('an id-stamped echo adopts by id even when the adapter transformed '
        'the text; equal text is never used when an id is present', () async {
      final controller = await attach();
      await seedEarlierTurn();
      await controller.sendPrompt('send the file');
      final clientMessageId = fakeConnection.lastPromptClientMessageId!;

      emitMessage({
        'type': 'user-message',
        'key': 'native-x',
        'clientKey': clientMessageId,
        'text':
            'send the file\n\nAttached file(s) — read them from '
            'these paths:\n- notes.txt',
      });
      await Future<void>.delayed(Duration.zero);

      // Adopted by id despite the transformed text — and because the echo
      // landed exactly at the anchored boundary, the holder retires on the
      // spot (bounded state) while the canonical row keeps the identity.
      expect(read().optimisticPrompts, isEmpty);
      final userRows = read().transcriptMessageEvents
          .where((m) => m.type == AgentMessageType.userMessage)
          .toList();
      expect(userRows, hasLength(2));
      expect(userRows.last.userMessageKey, 'native-x');
      expect(userRows.last.userMessageClientKey, clientMessageId);
    });

    test('a stamped echo that matches no local send adopts nothing', () async {
      final controller = await attach();
      await seedEarlierTurn();
      await controller.sendPrompt('mine');
      final clientMessageId = fakeConnection.lastPromptClientMessageId!;

      // Another client's send: same text, different correlation id.
      emitMessage(const {
        'type': 'user-message',
        'key': 'native-other',
        'clientKey': 'ca.other-device.0',
        'text': 'mine',
      });
      await Future<void>.delayed(Duration.zero);

      expect(read().optimisticPrompts.single.isDelivered, isFalse);
      expect(
        read().optimisticPrompts.single.clientMessageId,
        clientMessageId,
      );
      final userRows = read().transcriptMessageEvents
          .where((m) => m.type == AgentMessageType.userMessage)
          .toList();
      // The other client's row AND our still-pending row both render.
      expect(userRows, hasLength(3));
    });

    test('a legacy no-id echo adopts the oldest exact-text row only, and a '
        'mismatching text adopts nothing', () async {
      final controller = await attach();
      await seedEarlierTurn();
      await controller.sendPrompt('legacy hello');
      final clientMessageId = fakeConnection.lastPromptClientMessageId!;

      emitMessage(const {
        'type': 'user-message',
        'key': 'native-miss',
        'text': 'legacy hello there', // not exact, not "text\n…" — no match
      });
      await Future<void>.delayed(Duration.zero);
      expect(read().optimisticPrompts.single.isDelivered, isFalse);

      emitMessage(const {
        'type': 'user-message',
        'key': 'native-hit',
        'text': 'legacy hello',
      });
      await Future<void>.delayed(Duration.zero);
      expect(read().optimisticPrompts.single.isDelivered, isTrue);
      expect(
        read().optimisticPrompts.single.deliveredMessageKey,
        contains('native-hit'),
      );
      expect(
        read().optimisticPrompts.single.clientMessageId,
        clientMessageId,
      );
    });

    test('two identical prompts keep distinct identities and converge '
        'one-to-one by clientMessageId', () async {
      final controller = await attach();
      await seedEarlierTurn();

      await controller.sendPrompt('same words');
      final firstId = fakeConnection.lastPromptClientMessageId!;
      await controller.sendPrompt('same words');
      final secondId = fakeConnection.lastPromptClientMessageId!;
      expect(firstId, isNot(secondId));
      expect(projectedRows(), [
        'user-message:u0',
        'model-output:m0',
        'user-message:$firstId',
        'user-message:$secondId',
      ]);

      // The SECOND send's echo arrives first: it must adopt only its own row.
      emitMessage({
        'type': 'user-message',
        'key': 'native-2',
        'clientKey': secondId,
        'text': 'same words',
      });
      await Future<void>.delayed(Duration.zero);
      expect(
        read().optimisticPrompts.map((p) => p.isDelivered),
        [false, true],
      );

      emitMessage({
        'type': 'user-message',
        'key': 'native-1',
        'clientKey': firstId,
        'text': 'same words',
      });
      await Future<void>.delayed(Duration.zero);
      expect(
        read().optimisticPrompts.map((p) => p.isDelivered),
        [true, true],
      );
      // Both rows render, in send order, never merged by their equal text.
      expect(projectedRows(), [
        'user-message:u0',
        'model-output:m0',
        'user-message:$firstId',
        'user-message:$secondId',
      ]);
      final userRows = read().transcriptMessageEvents
          .where((m) => m.type == AgentMessageType.userMessage)
          .toList();
      expect(
        userRows.map((m) => m.userMessageKey),
        ['u0', 'native-1', 'native-2'],
      );
    });

    test(
      'history replacement while a row is pending keeps it visible and '
      'newest; a replay containing the echo converges to one canonical row',
      () async {
        final controller = await attach();
        await seedEarlierTurn();
        await controller.sendPrompt('survive the replay');
        final clientMessageId = fakeConnection.lastPromptClientMessageId!;

        // Reconnect-style full replay WITHOUT the echo: the pending row
        // survives, re-pinned after the replay tail.
        fakeConnection.emitEvent(
          HistoryWireEvent(
            reset: true,
            messages: [
              message(const {
                'type': 'user-message',
                'key': 'u0',
                'text': 'earlier ask',
              }),
              message(const {
                'type': 'model-output',
                'key': 'm0',
                'text': 'earlier answer',
                'final': true,
              }),
              message(const {
                'type': 'user-message',
                'key': 'x1',
                'text': 'typed in the terminal meanwhile',
              }),
            ],
          ),
        );
        await Future<void>.delayed(Duration.zero);
        expect(read().optimisticPrompts.single.isDelivered, isFalse);
        expect(projectedRows(), [
          'user-message:u0',
          'model-output:m0',
          'user-message:x1',
          'user-message:$clientMessageId',
        ]);

        // The next replay carries the echo in native order: exactly one
        // canonical row remains and the local holder retires.
        fakeConnection.emitEvent(
          HistoryWireEvent(
            reset: true,
            messages: [
              message(const {
                'type': 'user-message',
                'key': 'u0',
                'text': 'earlier ask',
              }),
              message(const {
                'type': 'model-output',
                'key': 'm0',
                'text': 'earlier answer',
                'final': true,
              }),
              message(const {
                'type': 'user-message',
                'key': 'x1',
                'text': 'typed in the terminal meanwhile',
              }),
              message({
                'type': 'user-message',
                'key': 'native-r',
                'clientKey': clientMessageId,
                'text': 'survive the replay',
              }),
            ],
          ),
        );
        await Future<void>.delayed(Duration.zero);
        expect(read().optimisticPrompts, isEmpty);
        expect(projectedRows(), [
          'user-message:u0',
          'model-output:m0',
          'user-message:x1',
          'user-message:$clientMessageId',
        ]);
        final userRows = read().transcriptMessageEvents
            .where((m) => m.type == AgentMessageType.userMessage)
            .toList();
        expect(userRows.last.userMessageKey, 'native-r');
      },
    );

    test('an older-page prepend leaves the pending row at its boundary, and '
        'the delayed echo after paging adopts it there', () async {
      final controller = await attach();
      // Seed an opaque older boundary so there is a real cursor to page from.
      // A page is only merged when it answers the request that is actually in
      // flight, so the fixture has to request one and echo its correlation id
      // back — an unsolicited page is correctly ignored.
      fakeConnection.emitEvent(
        HistoryWireEvent(
          reset: true,
          cursor: 'tail-cursor',
          olderCursor: 'page-1',
          hasEarlier: true,
          messages: [
            message(const {
              'type': 'user-message',
              'key': 'u0',
              'text': 'earlier ask',
            }),
            message(const {
              'type': 'model-output',
              'key': 'm0',
              'text': 'earlier answer',
              'final': true,
            }),
          ],
        ),
      );
      await Future<void>.delayed(Duration.zero);
      await controller.sendPrompt('page me');
      final clientMessageId = fakeConnection.lastPromptClientMessageId!;

      expect(await controller.loadEarlierHistory(), isTrue);
      expect(fakeConnection.lastHistoryPageCursor, 'page-1');
      fakeConnection.emitEvent(
        HistoryPageWireEvent(
          messages: [
            message(const {
              'type': 'user-message',
              'key': 'u-old',
              'text': 'much older ask',
            }),
            message(const {
              'type': 'model-output',
              'key': 'm-old',
              'text': 'much older answer',
              'final': true,
            }),
          ],
          hasMore: false,
          endOfHistory: true,
          clientMessageId: fakeConnection.lastHistoryPageClientMessageId,
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(projectedRows(), [
        'user-message:u-old',
        'model-output:m-old',
        'user-message:u0',
        'model-output:m0',
        'user-message:$clientMessageId',
      ]);

      emitMessage({
        'type': 'user-message',
        'key': 'native-p',
        'clientKey': clientMessageId,
        'text': 'page me',
      });
      await Future<void>.delayed(Duration.zero);
      // The in-order echo settles the row instantly; the holder retires and
      // the canonical echo stands at the same boundary under the same id.
      expect(read().optimisticPrompts, isEmpty);
      final userRows = read().transcriptMessageEvents
          .where((m) => m.type == AgentMessageType.userMessage)
          .toList();
      expect(
        userRows.map((m) => m.userMessageKey),
        ['u-old', 'u0', 'native-p'],
      );
      expect(userRows.last.userMessageClientKey, clientMessageId);
    });

    test('a nack removes exactly the failed row and leaves other pending '
        'rows untouched', () async {
      final controller = await attach();
      await seedEarlierTurn();
      await controller.sendPrompt('will fail');
      final failedId = fakeConnection.lastPromptClientMessageId!;
      await controller.sendPrompt('will deliver');
      final okId = fakeConnection.lastPromptClientMessageId!;

      fakeConnection.emitEvent(
        NackWireEvent(
          code: 'CLIENT_MESSAGE_FAILED',
          message: 'nope',
          clientMessageId: failedId,
        ),
      );
      await Future<void>.delayed(Duration.zero);

      expect(read().optimisticPrompts.single.clientMessageId, okId);
      expect(projectedRows().last, 'user-message:$okId');
    });

    test('a prompt anchored to a vanished key falls back to the end '
        'instead of disappearing', () {
      const state = SessionDetailState(
        tool: 'codex',
        sessionId: 'session-anchor',
        events: [seedHistory],
        optimisticPrompts: [
          SessionOptimisticPrompt(
            clientMessageId: 'cm-lost-anchor',
            text: 'still visible',
            sentAt: 1,
            queued: false,
            anchorMessageKey: 'user-message:key:gone',
          ),
        ],
      );
      expect(state.transcriptMessageEvents, hasLength(1));
      expect(
        state.transcriptMessageEvents.single.raw['text'],
        'still visible',
      );
    });

    test('a delivered echo whose anchored boundary left the window renders at '
        'its canonical index and drags no later prompt down', () {
      // The steered send anchored to a mid-turn tool row the window has since
      // evicted, but its canonical echo is known and present at index 2. The
      // last-index fallback is reserved for the still-pending prompt behind
      // it — and that prompt's own anchor resolves, so nothing may move.
      final state = SessionDetailState(
        tool: 'codex',
        sessionId: 'session-anchor-evicted',
        events: [
          HistoryWireEvent(
            reset: true,
            messages: [
              message(const {
                'type': 'user-message',
                'key': 'u1',
                'text': 'first',
              }),
              message(const {
                'type': 'model-output',
                'key': 'm1',
                'text': 'one',
                'final': true,
              }),
              message(const {
                'type': 'user-message',
                'key': 'e1',
                'clientKey': 'cm-1',
                'text': 'steered',
              }),
              message(const {
                'type': 'model-output',
                'key': 'm2',
                'text': 'two',
                'final': true,
              }),
              message(const {
                'type': 'model-output',
                'key': 'm3',
                'text': 'three',
                'final': true,
              }),
            ],
          ),
        ],
        optimisticPrompts: const [
          SessionOptimisticPrompt(
            clientMessageId: 'cm-1',
            text: 'steered',
            sentAt: 1,
            queued: true,
            anchorMessageKey: 'tool-call:key:gone',
            deliveredMessageKey: 'user-message:key:e1',
          ),
          SessionOptimisticPrompt(
            clientMessageId: 'cm-2',
            text: 'next',
            sentAt: 2,
            queued: true,
            anchorMessageKey: 'model-output:key:m2',
          ),
        ],
      );
      expect(
        [for (final m in state.transcriptMessageEvents) m.raw['key']],
        ['u1', 'm1', 'e1', 'm2', 'optimistic:cm-2', 'm3'],
      );
    });

    test('a steered prompt whose mid-turn anchor is evicted from the window '
        'converges at its canonical position, retires, and drags no later '
        'prompt down', () async {
      final controller = await attach();
      await seedEarlierTurn();
      fakeConnection.emitSessionControl(
        const {
          'drive': {'state': 'driving', 'supported': true},
          'terminalSync': {
            'supported': false,
            'syncAvailable': false,
            'active': false,
          },
        },
        status: 'working',
      );
      await Future<void>.delayed(Duration.zero);

      // A mid-turn tool row is the insertion boundary the steer pins to.
      emitMessage(const {
        'type': 'tool-call',
        'key': 'tc1',
        'name': 'search-files',
        'arguments': {'query': 'docs'},
      });
      await Future<void>.delayed(Duration.zero);

      await controller.sendPrompt('steer mid-turn');
      final steeredId = fakeConnection.lastPromptClientMessageId!;
      expect(
        read().optimisticPrompts.single.anchorMessageKey,
        'tool-call:key:tc1',
      );

      // The turn keeps running: output streams past the send, then the
      // queued steer's echo lands at its queued slot, mid-stream.
      for (var i = 1; i <= 60; i++) {
        emitMessage({
          'type': 'model-output',
          'key': 'o$i',
          'text': 'output $i',
        });
      }
      emitMessage({
        'type': 'user-message',
        'key': 'steer-echo',
        'clientKey': steeredId,
        'text': 'steer mid-turn',
      });
      await Future<void>.delayed(Duration.zero);

      // While the anchor resolves, the holder pins the echo at its boundary.
      expect(read().optimisticPrompts.single.isDelivered, isTrue);
      expect(projectedRows().take(4), [
        'user-message:u0',
        'model-output:m0',
        'tool-call:tc1',
        'user-message:$steeredId',
      ]);

      // The turn runs long: the bounded tail evicts the anchor row while the
      // echo stays in the window, followed by more of the turn's output.
      for (var i = 61; i <= 140; i++) {
        emitMessage({
          'type': 'model-output',
          'key': 'o$i',
          'text': 'output $i',
        });
      }
      await Future<void>.delayed(Duration.zero);

      // With the anchor gone the holder has nothing left to enforce: it
      // retires, and the echo renders at its canonical position — NOT
      // dragged to the tail behind the output it precedes.
      expect(read().optimisticPrompts, isEmpty);
      final rows = projectedRows();
      final echoIndex = rows.indexOf('user-message:$steeredId');
      expect(echoIndex, isNonNegative);
      expect(rows[echoIndex - 1], 'model-output:o60');
      expect(rows[echoIndex + 1], 'model-output:o61');
      expect(echoIndex, lessThan(rows.length - 1));

      // A later send anchors to the live tail and converges normally: no
      // leaked holder blocks its retirement, no floor drags it down.
      await controller.sendPrompt('follow up');
      final followId = fakeConnection.lastPromptClientMessageId!;
      emitMessage({
        'type': 'user-message',
        'key': 'follow-echo',
        'clientKey': followId,
        'text': 'follow up',
      });
      await Future<void>.delayed(Duration.zero);
      expect(read().optimisticPrompts, isEmpty);
      expect(projectedRows().last, 'user-message:$followId');
    });
  });

  group('bounded holder state over a long-lived session', () {
    test('a continuously attached session retains no delivered holders when '
        'echoes arrive in order — id-stamped and legacy alike', () async {
      final controller = await attach();
      fakeConnection.emitEvent(seedHistory);
      await Future<void>.delayed(Duration.zero);

      for (var i = 0; i < 40; i++) {
        await controller.sendPrompt('turn $i');
        final clientMessageId = fakeConnection.lastPromptClientMessageId!;
        // Alternate stamped and legacy echoes so both correlation paths feed
        // the same retirement rule.
        emitMessage({
          'type': 'user-message',
          'key': 'echo$i',
          if (i.isEven) 'clientKey': clientMessageId,
          'text': 'turn $i',
        });
        emitMessage({
          'type': 'model-output',
          'key': 'answer$i',
          'text': 'Answer $i',
          'final': true,
        });
        await Future<void>.delayed(Duration.zero);
        expect(
          read().optimisticPrompts,
          isEmpty,
          reason: 'holder for turn $i must retire once its echo settles',
        );
      }
      // Legacy display-identity associations stay bounded too.
      expect(
        read().transcriptClientKeys.length,
        lessThanOrEqualTo(kMaxRetainedTranscriptClientKeys),
      );
      // The rendered transcript still shows every turn exactly once, each
      // user row under its send identity.
      final userRows = read().transcriptMessageEvents
          .where((m) => m.type == AgentMessageType.userMessage)
          .toList();
      expect(userRows, hasLength(40));
      expect(userRows.every((m) => m.userMessageClientKey != null), isTrue);
    });

    test('pathological out-of-order echoes keep at most the capped number of '
        'holders, and the overflow releases oldest-first without reordering '
        'newer rows', () async {
      final controller = await attach();
      fakeConnection.emitEvent(seedHistory);
      await Future<void>.delayed(Duration.zero);

      const turns = kMaxDeliveredOptimisticHolders + 4;
      final ids = <String>[];
      for (var i = 0; i < turns; i++) {
        await controller.sendPrompt('late echo $i');
        ids.add(fakeConnection.lastPromptClientMessageId!);
        // The answer streams BEFORE the echo, so the echo is out of order and
        // its holder is doing real work (pinning it in front of the answer).
        emitMessage({
          'type': 'model-output',
          'key': 'answer$i',
          'text': 'Answer $i',
          'final': true,
        });
        emitMessage({
          'type': 'user-message',
          'key': 'echo$i',
          'clientKey': ids[i],
          'text': 'late echo $i',
        });
        await Future<void>.delayed(Duration.zero);
      }
      final holders = read().optimisticPrompts;
      expect(holders.length, kMaxDeliveredOptimisticHolders);
      expect(holders.every((p) => p.isDelivered), isTrue);
      // The newest sends keep their guarantee; the oldest were released.
      expect(
        holders.map((p) => p.clientMessageId),
        ids.sublist(turns - kMaxDeliveredOptimisticHolders),
      );
      // Every echo still renders exactly once and send order never reverses:
      // a held row shows before its answer, a released one at its canonical
      // arrival spot — but user rows themselves stay in send order.
      final userRows = read().transcriptMessageEvents
          .where((m) => m.type == AgentMessageType.userMessage)
          .toList();
      expect(
        userRows.map((m) => m.userMessageClientKey),
        ids,
      );
    });

    test('a delivered holder whose anchor left the window retires and '
        'unblocks the holders behind it', () {
      final canonical = [
        message(const {'type': 'user-message', 'key': 'u1', 'text': 'first'}),
        message(const {
          'type': 'model-output',
          'key': 'm1',
          'text': 'one',
          'final': true,
        }),
        message(const {
          'type': 'user-message',
          'key': 'e1',
          'clientKey': 'cm-1',
          'text': 'steered',
        }),
        message(const {
          'type': 'user-message',
          'key': 'e2',
          'clientKey': 'cm-2',
          'text': 'settled',
        }),
      ];
      final retired = retireSettledOptimisticHolders(
        const [
          // Head: delivered, but its mid-turn anchor is gone from the window,
          // so its echo renders at the canonical index with or without it.
          SessionOptimisticPrompt(
            clientMessageId: 'cm-1',
            text: 'steered',
            sentAt: 1,
            queued: true,
            anchorMessageKey: 'tool-call:key:gone',
            deliveredMessageKey: 'user-message:key:e1',
          ),
          // Behind it: delivered and settled — the lost-anchor head must not
          // block its retirement.
          SessionOptimisticPrompt(
            clientMessageId: 'cm-2',
            text: 'settled',
            sentAt: 2,
            queued: true,
            anchorMessageKey: 'user-message:key:e1',
            deliveredMessageKey: 'user-message:key:e2',
          ),
        ],
        canonical,
      );
      expect(retired, isEmpty);

      // A resolved anchor with a displaced echo is still doing work: kept.
      final holding = retireSettledOptimisticHolders(
        const [
          SessionOptimisticPrompt(
            clientMessageId: 'cm-3',
            text: 'out of order',
            sentAt: 3,
            queued: true,
            anchorMessageKey: 'user-message:key:u1',
            deliveredMessageKey: 'user-message:key:e1',
          ),
        ],
        canonical,
      );
      expect(holding, hasLength(1));
    });
  });

  group('optimistic prompt run bucketing', () {
    test('a delivered holder whose echo left the window claims no run and '
        'drags no later prompt into the tail run', () {
      final older = [
        message(const {
          'type': 'user-message',
          'key': 'u-old',
          'text': 'older ask',
        }),
        message(const {
          'type': 'model-output',
          'key': 'm-old',
          'text': 'older answer',
          'final': true,
        }),
      ];
      var window = TranscriptHistoryWindow.fromHistory(
        HistoryWireEvent(
          reset: true,
          olderCursor: 'page-1',
          hasEarlier: true,
          messages: [
            message(const {
              'type': 'user-message',
              'key': 'u-new',
              'text': 'newer ask',
            }),
            message(const {
              'type': 'model-output',
              'key': 'm-new',
              'text': 'newer answer',
              'final': true,
            }),
          ],
        ),
      );
      final mutation = window.prependPage(
        HistoryPageWireEvent(
          messages: older,
          hasMore: false,
          endOfHistory: true,
        ),
        requestedCursor: 'page-1',
      );
      expect(mutation.accepted, isTrue);
      window = mutation.window;

      final segments = window.transcriptConversationSegmentsWith(
        const [
          // Delivered, but neither its echo nor its anchor is in any loaded
          // run: it renders nothing and must not move the floor.
          SessionOptimisticPrompt(
            clientMessageId: 'cm-gone',
            text: 'evicted echo',
            sentAt: 1,
            queued: false,
            anchorMessageKey: 'user-message:key:gone',
            deliveredMessageKey: 'user-message:key:gone-too',
          ),
          // A later pending prompt anchored in the OLDER run.
          SessionOptimisticPrompt(
            clientMessageId: 'cm-pending',
            text: 'pending in older run',
            sentAt: 2,
            queued: false,
            anchorMessageKey: 'model-output:key:m-old',
          ),
        ],
        const {},
        mode: ToolDisplayMode.responsive,
      );
      expect(segments, hasLength(2));
      List<String> rowKeys(TranscriptConversationSegment segment) => [
        for (final turn in segment.turns) ...[
          if (turn.userMessage?.raw['key'] case final String opened) opened,
          for (final entry
              in turn.content.whereType<MessageTranscriptDisplayEntry>())
            if (entry.message.raw['key'] case final String key) key,
        ],
      ];
      expect(
        rowKeys(segments[0]),
        contains('optimistic:cm-pending'),
        reason: 'the pending row keeps its anchored run',
      );
      expect(rowKeys(segments[1]), isNot(contains('optimistic:cm-pending')));
      expect(
        [
          ...rowKeys(segments[0]),
          ...rowKeys(segments[1]),
        ].where((key) => key.contains('cm-gone')),
        isEmpty,
        reason: 'a delivered holder with no canonical echo renders nothing',
      );
    });
  });
}
