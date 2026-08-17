import 'dart:async';
import 'dart:convert';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:test/test.dart';

void main() {
  group('SessionConnection', () {
    late FakeWebSocketAdapter adapter;
    String? streamUrl;
    late SessionConnection connection;
    late List<WireEvent> receivedEvents;
    late List<SessionConnectionState> stateChanges;

    SessionConnection createConnection({
      String tool = 'opencode',
      String sessionId = 'session-1',
      String baseUrl = 'http://127.0.0.1:7734',
      String artifactMode = 'reference',
      String? mode,
      String? reason,
      bool readOnly = false,
      int initialHistory = 100,
    }) {
      final resolver = EndpointResolver(baseUrl: baseUrl);
      return SessionConnection(
        resolver: resolver,
        tool: tool,
        sessionId: sessionId,
        artifactMode: artifactMode,
        mode: mode,
        reason: reason,
        readOnly: readOnly,
        initialHistory: initialHistory,
        adapterFactory: (url) {
          streamUrl = url;
          return adapter = FakeWebSocketAdapter();
        },
      );
    }

    /// Allow microtasks to flush (broadcast stream delivery,
    /// async continuations after await).
    Future<void> flush() => Future<void>.delayed(Duration.zero);

    setUp(() {
      receivedEvents = [];
      stateChanges = [];
      connection = createConnection();
      connection.events.listen(receivedEvents.add);
      connection.stateStream.listen(stateChanges.add);
    });

    tearDown(() async {
      await connection.dispose();
    });

    group('connect', () {
      test('transitions to connecting then connected', () async {
        await connection.connect();
        await flush();
        expect(connection.state, SessionConnectionState.connected);
        expect(
          stateChanges,
          contains(SessionConnectionState.connecting),
        );
        expect(
          stateChanges,
          contains(SessionConnectionState.connected),
        );
      });

      test(
        'requests artifactMode=reference by default for stream URL',
        () async {
          streamUrl = null;
          connection = createConnection();
          connection.events.listen(receivedEvents.add);
          connection.stateStream.listen(stateChanges.add);

          await connection.connect();
          await flush();

          expect(streamUrl, isNotNull);
          expect(
            Uri.parse(streamUrl!).queryParameters['artifactMode'],
            'reference',
          );
        },
      );

      test('requests configured artifactMode on stream URL', () async {
        streamUrl = null;
        connection = createConnection(artifactMode: 'inline');
        connection.events.listen(receivedEvents.add);
        connection.stateStream.listen(stateChanges.add);

        await connection.connect();
        await flush();

        expect(streamUrl, isNotNull);
        expect(
          Uri.parse(streamUrl!).queryParameters['artifactMode'],
          'inline',
        );
      });

      test('requests default initialHistory=100 on stream URL', () async {
        streamUrl = null;
        connection = createConnection();
        connection.events.listen(receivedEvents.add);
        connection.stateStream.listen(stateChanges.add);

        await connection.connect();
        await flush();

        expect(streamUrl, isNotNull);
        expect(
          Uri.parse(streamUrl!).queryParameters['initialHistory'],
          '100',
        );
      });

      test('respects custom initialHistory query parameter', () async {
        streamUrl = null;
        connection = createConnection(initialHistory: 50);
        connection.events.listen(receivedEvents.add);
        connection.stateStream.listen(stateChanges.add);

        await connection.connect();
        await flush();

        expect(streamUrl, isNotNull);
        expect(
          Uri.parse(streamUrl!).queryParameters['initialHistory'],
          '50',
        );
      });

      test('is a no-op when already connected', () async {
        await connection.connect();
        await flush();
        stateChanges.clear();

        await connection.connect();
        await flush();
        expect(stateChanges, isEmpty);
      });
    });

    group('WireEvent parsing', () {
      test(
        'emits AttachConflictWireEvent from attach-conflict frame',
        () async {
          await connection.connect();
          await flush();

          adapter.simulateMessage({
            'kind': 'attach-conflict',
            'requestedMode': 'resume',
            'reason': 'app-restore',
            'code': 'DRIVE_OWNERSHIP_CONFLICT',
            'message': 'A terminal owns this session.',
          });
          await flush();

          expect(receivedEvents, hasLength(1));
          final conflict = receivedEvents.first;
          expect(conflict, isA<AttachConflictWireEvent>());
          conflict as AttachConflictWireEvent;
          expect(conflict.requestedMode, 'resume');
          expect(conflict.reason, 'app-restore');
          expect(conflict.code, 'DRIVE_OWNERSHIP_CONFLICT');
          expect(conflict.message, 'A terminal owns this session.');
          // A structured conflict is informational: the socket continues as
          // Observe, so the connection stays connected.
          expect(connection.state, SessionConnectionState.connected);
          expect(connection.mode, isNull);
          expect(connection.reason, isNull);
        },
      );

      test(
        'downgrades create to app-restore after confirmed Driving',
        () async {
          connection = createConnection(mode: 'resume', reason: 'create');
          connection.events.listen(receivedEvents.add);
          await connection.connect();
          adapter.simulateMessage({
            'kind': 'session',
            'info': {
              'id': 'session-1',
              'tool': 'codex',
              'title': 'Test',
              'status': 'idle',
              'attachMode': 'resume',
              'control': {
                'drive': {'supported': true, 'state': 'driving'},
                'terminalSync': {
                  'supported': true,
                  'syncAvailable': true,
                  'active': false,
                },
              },
            },
          });
          await flush();

          expect(connection.mode, 'resume');
          expect(connection.reason, 'app-restore');
        },
      );

      test(
        'downgrades takeover to lease-restore after confirmed Driving',
        () async {
          connection = createConnection(mode: 'resume', reason: 'takeover');
          connection.events.listen(receivedEvents.add);
          await connection.connect();
          adapter.simulateMessage({
            'kind': 'session',
            'info': {
              'id': 'session-1',
              'tool': 'codex',
              'title': 'Test',
              'status': 'idle',
              'attachMode': 'resume',
              'control': {
                'drive': {'supported': true, 'state': 'driving'},
                'terminalSync': {
                  'supported': true,
                  'syncAvailable': true,
                  'active': false,
                },
              },
            },
          });
          await flush();

          expect(connection.reason, 'lease-restore');
        },
      );

      test('emits SessionWireEvent from session frame', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'session',
          'info': {
            'id': 'session-1',
            'tool': 'opencode',
            'title': 'Test',
            'status': 'idle',
            'attachMode': 'live',
          },
        });
        await flush();

        expect(receivedEvents, hasLength(1));
        expect(receivedEvents.first, isA<SessionWireEvent>());
        expect(connection.sessionInfo, isNotNull);
        expect(connection.sessionInfo!.id, 'session-1');
      });

      test(
        'emits HistoryWireEvent and populates messages',
        () async {
          await connection.connect();
          await flush();

          adapter.simulateMessage({
            'kind': 'history',
            'messages': [
              {'type': 'user-message', 'id': 'msg-1'},
              {'type': 'model-output', 'id': 'msg-2'},
            ],
            'cursor': 'cursor-abc',
          });
          await flush();

          expect(receivedEvents, hasLength(1));
          expect(receivedEvents.first, isA<HistoryWireEvent>());
          expect(connection.messages, hasLength(2));
          expect(connection.cursor, 'cursor-abc');
        },
      );

      test('reset history replaces previously projected messages', () async {
        await connection.connect();
        await flush();

        adapter
          ..simulateMessage({
            'kind': 'history',
            'messages': [
              {'type': 'user-message', 'id': 'old-message'},
            ],
          })
          ..simulateMessage({
            'kind': 'message',
            'seq': 1,
            'message': {'type': 'model-output', 'id': 'old-live'},
          })
          ..simulateMessage({
            'kind': 'history',
            'reset': true,
            'messages': [
              {'type': 'user-message', 'id': 'replacement'},
            ],
          });
        await flush();

        expect(
          connection.messages.map((message) => message.id),
          ['replacement'],
        );
      });

      test('emits MessageWireEvent', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'message',
          'seq': 5,
          'message': {'type': 'status', 'id': 'msg-5'},
        });
        await flush();

        expect(receivedEvents, hasLength(1));
        final event = receivedEvents.first as MessageWireEvent;
        expect(event.seq, 5);
        expect(connection.messages, hasLength(1));
      });

      test('emits CommandsWireEvent', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'commands',
          'commands': [
            {'name': 'build'},
          ],
        });
        await flush();

        expect(receivedEvents, hasLength(1));
        expect(connection.commands, hasLength(1));
        expect(connection.commands.first.name, 'build');
      });

      test('emits OptionsWireEvent with broker fields', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'options',
          'models': [
            {
              'providerID': 'anthropic',
              'modelID': 'claude-sonnet-4-6',
              'label': 'Claude Sonnet',
            },
          ],
          'agents': [
            {'name': 'build', 'description': 'Builder'},
          ],
          'modes': [
            {
              'value': 'ask-permission',
              'label': 'Ask Permission',
              'category': 'ask-permission',
            },
          ],
        });
        await flush();

        expect(receivedEvents, hasLength(1));
        expect(connection.models, hasLength(1));
        expect(connection.models.first.providerID, 'anthropic');
        expect(connection.models.first.modelID, 'claude-sonnet-4-6');
        expect(connection.agents, hasLength(1));
        expect(connection.agents.first.name, 'build');
        expect(connection.modes, hasLength(1));
        expect(connection.modes!.first.value, 'ask-permission');
      });

      test('emits NoticeWireEvent', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'notice',
          'message': 'Session paused',
        });
        await flush();

        expect(receivedEvents, hasLength(1));
        expect(
          (receivedEvents.first as NoticeWireEvent).message,
          'Session paused',
        );
      });

      test('emits ErrorWireEvent', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'error',
          'message': 'Permission denied',
        });
        await flush();

        expect(receivedEvents, hasLength(1));
        expect(
          (receivedEvents.first as ErrorWireEvent).message,
          'Permission denied',
        );
      });

      test(
        'emits UnknownWireEvent for unrecognized kind',
        () async {
          await connection.connect();
          await flush();

          adapter.simulateMessage({
            'kind': 'future-feature',
            'data': 'value',
          });
          await flush();

          expect(receivedEvents, hasLength(1));
          expect(receivedEvents.first, isA<UnknownWireEvent>());
        },
      );

      test(
        'malformed known frame becomes UnknownWireEvent',
        () async {
          await connection.connect();
          await flush();

          // 'session' kind but missing 'info' — should not crash.
          adapter.simulateMessage({
            'kind': 'session',
            'broken': true,
          });
          await flush();

          expect(receivedEvents, hasLength(1));
          expect(receivedEvents.first, isA<UnknownWireEvent>());
          final unknown = receivedEvents.first as UnknownWireEvent;
          expect(unknown.kind, 'session');
        },
      );
    });

    group('history reset', () {
      test('reset clears existing messages', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'history',
          'messages': [
            {'type': 'user-message', 'id': 'msg-1'},
            {'type': 'model-output', 'id': 'msg-2'},
          ],
        });
        await flush();
        expect(connection.messages, hasLength(2));

        adapter.simulateMessage({
          'kind': 'history',
          'messages': [
            {'type': 'user-message', 'id': 'msg-new'},
          ],
          'reset': true,
        });
        await flush();
        expect(connection.messages, hasLength(1));
        expect(connection.messages.first.id, 'msg-new');
      });

      test('non-reset appends to messages', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'history',
          'messages': [
            {'type': 'user-message', 'id': 'msg-1'},
          ],
        });
        await flush();

        adapter.simulateMessage({
          'kind': 'history',
          'messages': [
            {'type': 'model-output', 'id': 'msg-2'},
          ],
        });
        await flush();
        expect(connection.messages, hasLength(2));
      });
    });

    group('cursor tracking', () {
      test('updates cursor from history frame', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'history',
          'messages': <dynamic>[],
          'cursor': 'cursor-v1',
        });
        await flush();
        expect(connection.cursor, 'cursor-v1');

        adapter.simulateMessage({
          'kind': 'history',
          'messages': <dynamic>[],
          'cursor': 'cursor-v2',
        });
        await flush();
        expect(connection.cursor, 'cursor-v2');
      });

      test(
        'preserves cursor when history has no cursor',
        () async {
          await connection.connect();
          await flush();

          adapter.simulateMessage({
            'kind': 'history',
            'messages': <dynamic>[],
            'cursor': 'cursor-v1',
          });
          await flush();

          adapter.simulateMessage({
            'kind': 'history',
            'messages': <dynamic>[],
          });
          await flush();
          expect(connection.cursor, 'cursor-v1');
        },
      );

      test('tracks attach ticket and history gap from history frame', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'history',
          'messages': <dynamic>[],
          'cursor': 'cursor-v1',
          'attachTicket': 'ticket-v1',
          'gap': {
            'code': 'HISTORY_CURSOR_GONE',
            'reason': 'cursor-out-of-range',
            'message': 'full replay was sent',
          },
        });
        await flush();

        expect(connection.attachTicket, 'ticket-v1');
        expect(connection.lastHistoryGap?.code, 'HISTORY_CURSOR_GONE');
        expect(connection.lastHistoryGap?.reason, 'cursor-out-of-range');
        expect(connection.lastHistoryGap?.message, 'full replay was sent');
      });
    });

    group('seq: 0 replay frames', () {
      test('tolerates seq: 0 message frames', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'message',
          'seq': 0,
          'message': {
            'type': 'agent-activity',
            'id': 'replay-1',
          },
        });
        await flush();

        expect(receivedEvents, hasLength(1));
        final event = receivedEvents.first as MessageWireEvent;
        expect(event.seq, 0);
        expect(connection.messages, hasLength(1));
      });
    });

    group('ended frame', () {
      test('transitions to closed on ended frame', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'ended',
          'reason': 'user-disconnect',
        });
        await flush();

        expect(connection.state, SessionConnectionState.closed);
        expect(
          stateChanges,
          contains(SessionConnectionState.closed),
        );
      });
    });

    group('outbound messages', () {
      test('sendPrompt sends text key', () async {
        await connection.connect();
        await flush();
        final clientMessageId = connection.sendPrompt('hello');

        expect(adapter.sentFrames, hasLength(1));
        final frame =
            jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
        expect(frame['kind'], 'prompt');
        expect(frame['text'], 'hello');
        expect(frame.containsKey('content'), isFalse);
        expect(frame['clientMessageId'], clientMessageId);
        expect(clientMessageId, matches(RegExp(r'^[A-Za-z0-9._:-]{1,160}$')));
      });

      test('sendPrompt forwards model and reasoning override', () async {
        await connection.connect();
        await flush();
        connection.sendPrompt(
          'hello',
          model: const SessionCurrentModel(
            providerID: 'openai',
            modelID: 'gpt-5.4',
            reasoningEffort: 'high',
          ),
        );

        final frame =
            jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
        expect(frame['model'], containsPair('modelID', 'gpt-5.4'));
        expect(frame['model'], containsPair('reasoningEffort', 'high'));
      });

      test('sendPrompt forwards the exact selected permission mode', () async {
        await connection.connect();
        await flush();
        connection.sendPrompt('hello', permissionMode: 'auto');

        final frame =
            jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
        // The exact advertised token, unrewritten: the broker validates it
        // against what the adapter published and rejects anything else.
        expect(frame['permissionMode'], 'auto');
      });

      test('sendPrompt omits the mode when none was selected', () async {
        await connection.connect();
        await flush();
        connection
          ..sendPrompt('hello')
          ..sendPrompt('hello again', permissionMode: '');

        for (final sent in adapter.sentFrames) {
          final frame = jsonDecode(sent) as Map<String, dynamic>;
          // Absent, not empty. Omitting it leaves the session in the mode it
          // already holds; an empty token would be rejected as unadvertised
          // and cost the user the whole prompt.
          expect(frame.containsKey('permissionMode'), isFalse);
        }
      });

      test('sendPrompt forwards ordered inline and staged files', () async {
        await connection.connect();
        await flush();
        connection.sendPrompt(
          'inspect',
          clientMessageId: 'cm-files',
          files: const [
            PromptFileAttachment.inline(
              name: 'small.txt',
              mimeType: 'text/plain',
              size: 1,
              data: 'eA==',
            ),
            PromptFileAttachment.staged(
              name: 'large.bin',
              mimeType: 'application/octet-stream',
              size: 300000,
              stagedRef: 'stg1.opaque',
            ),
          ],
        );

        final frame =
            jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
        expect(frame['clientMessageId'], 'cm-files');
        expect(frame['files'], hasLength(2));
        expect(
          (frame['files'] as List).first,
          containsPair('data', 'eA=='),
        );
        expect(
          (frame['files'] as List).last,
          containsPair('stagedRef', 'stg1.opaque'),
        );
      });

      test(
        'sendDraft sends ephemeral shared text without idempotency id',
        () async {
          await connection.connect();
          await flush();
          connection.sendDraft('phone draft');

          final frame =
              jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
          expect(frame, {'kind': 'draft', 'text': 'phone draft'});
          expect(frame.containsKey('clientMessageId'), isFalse);
        },
      );

      test(
        'sendDraft forwards version tokens for a revision-3 broker',
        () async {
          await connection.connect();
          await flush();
          connection.sendDraft(
            'phone draft',
            updateId: 'u-9',
            baseRevision: 4,
          );

          final frame =
              jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
          expect(frame, {
            'kind': 'draft',
            'text': 'phone draft',
            'updateId': 'u-9',
            'baseRevision': 4,
          });
        },
      );

      test('sends plan and artifact interactions with stable ids', () async {
        await connection.connect();
        await flush();

        final planId = connection.sendPlanAction(
          const PlanActionRequest(
            action: PlanActionKind.approve,
            planKey: 'tasks:main',
            planRevision: 'revision-7',
            title: 'Plan',
          ),
          clientMessageId: 'cm.plan-1',
        );
        final artifactId = connection.sendArtifactInteraction(
          const ArtifactInteractionRequest(
            artifactKey: 'artifact-1',
            interaction: {'type': 'click', 'action': 'approve'},
          ),
          clientMessageId: 'cm.artifact-1',
        );

        final frames = adapter.sentFrames
            .map((value) => jsonDecode(value) as Map<String, dynamic>)
            .toList(growable: false);
        expect(planId, 'cm.plan-1');
        expect(frames[0]['kind'], 'plan-action');
        expect(frames[0]['action'], 'approve');
        expect(artifactId, 'cm.artifact-1');
        expect(frames[1]['kind'], 'artifact-interaction');
        expect(frames[1]['artifactKey'], 'artifact-1');
      });

      test('sends explicit attach-ticket ack and nack receipts', () async {
        await connection.connect();
        await flush();

        connection
          ..sendAck('ticket-1')
          ..sendNack('ticket-2', clientMessageId: 'cm.receipt-1');

        final frames = adapter.sentFrames
            .map((value) => jsonDecode(value) as Map<String, dynamic>)
            .toList(growable: false);
        expect(frames[0], {'kind': 'ack', 'attachTicket': 'ticket-1'});
        expect(frames[1], {
          'kind': 'nack',
          'attachTicket': 'ticket-2',
          'clientMessageId': 'cm.receipt-1',
        });
      });

      test('sendCommand sends correct frame', () async {
        await connection.connect();
        await flush();
        final clientMessageId = connection.sendCommand('build');

        final frame =
            jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
        expect(frame['kind'], 'command');
        expect(frame['name'], 'build');
        expect(frame['clientMessageId'], clientMessageId);
      });

      test('sendCommand forwards model override', () async {
        await connection.connect();
        await flush();
        connection.sendCommand(
          'review',
          model: const SessionCurrentModel(
            providerID: 'anthropic',
            modelID: 'claude-opus-4-6',
            reasoningEffort: 'max',
          ),
        );

        final frame =
            jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
        expect(frame['model'], containsPair('modelID', 'claude-opus-4-6'));
      });

      test('sendApprove sends correct frame', () async {
        await connection.connect();
        await flush();
        final clientMessageId = connection.sendApprove('req-1', 'approve');

        final frame =
            jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
        expect(frame['kind'], 'approve');
        expect(frame['requestId'], 'req-1');
        expect(frame['decision'], 'approve');
        expect(frame['clientMessageId'], clientMessageId);
      });

      test('sendAnswer sends string[][]', () async {
        await connection.connect();
        await flush();
        final clientMessageId = connection.sendAnswer('req-2', [
          ['yes'],
          ['option-a', 'option-b'],
        ]);

        final frame =
            jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
        expect(frame['kind'], 'answer');
        expect(frame['requestId'], 'req-2');
        expect(frame['answers'], [
          ['yes'],
          ['option-a', 'option-b'],
        ]);
        expect(frame['clientMessageId'], clientMessageId);
      });

      test('sendRejectQuestion sends correct frame', () async {
        await connection.connect();
        await flush();
        final clientMessageId = connection.sendRejectQuestion('req-3');

        final frame =
            jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
        expect(frame['kind'], 'reject-question');
        expect(frame['requestId'], 'req-3');
        expect(frame['clientMessageId'], clientMessageId);
      });

      test('sendFile sends data key', () async {
        await connection.connect();
        await flush();
        final clientMessageId = connection.sendFile(
          name: 'readme.md',
          data: '# Hello',
          mimeType: 'text/markdown',
        );

        final frame =
            jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
        expect(frame['kind'], 'file');
        expect(frame['name'], 'readme.md');
        expect(frame['data'], '# Hello');
        expect(frame.containsKey('content'), isFalse);
        expect(frame['mimeType'], 'text/markdown');
        expect(frame['clientMessageId'], clientMessageId);
      });

      test('sendHandoff sends an idempotent control frame', () async {
        await connection.connect();
        connection.sendHandoff(clientMessageId: 'cm-handoff');

        expect(jsonDecode(adapter.sentFrames.last), {
          'kind': 'handoff',
          'clientMessageId': 'cm-handoff',
        });
      });

      test('explicit clientMessageId is reused for retry frames', () async {
        await connection.connect();
        await flush();

        final clientMessageId = connection.sendPrompt(
          'retry me',
          clientMessageId: 'cm.retry-1',
        );

        final frame =
            jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
        expect(clientMessageId, 'cm.retry-1');
        expect(frame['clientMessageId'], 'cm.retry-1');
      });

      test(
        'invalid explicit clientMessageId is rejected before send',
        () async {
          await connection.connect();
          await flush();

          expect(
            () => connection.sendPrompt('bad', clientMessageId: 'bad id'),
            throwsA(isA<ArgumentError>()),
          );
          expect(adapter.sentFrames, isEmpty);
        },
      );

      test(
        'outbound frames are dropped when not connected',
        () async {
          expect(
            () => connection.sendPrompt('hello'),
            returnsNormally,
          );
          expect(
            () => connection.sendCommand('build'),
            returnsNormally,
          );
          expect(
            () => connection.sendApprove('r', 'approve'),
            returnsNormally,
          );
        },
      );
    });

    group('read-only declaration', () {
      // The declaration must survive the transport, not just the first attach.
      // An automatic reconnect that silently dropped it would hand the socket
      // back full authority at exactly the moment nobody is watching — and
      // unlike `mode`/`reason`, there is no refusal frame that would reveal it.
      test('rides every reconnect, not only the first attach', () async {
        final connection = createConnection(readOnly: true);
        await connection.connect();
        await flush();
        expect(streamUrl, contains('readOnly=1'));

        streamUrl = '';
        adapter.simulateDisconnect();
        await flush();
        await Future<void>.delayed(const Duration(milliseconds: 1200));
        await flush();

        expect(
          streamUrl,
          contains('readOnly=1'),
          reason: 'the automatic reconnect must keep declaring it',
        );
        await connection.dispose();
      });

      test('is monotone — a later reattach cannot clear it', () async {
        final connection = createConnection(readOnly: true);
        await connection.connect();
        await flush();

        await connection.reattach();
        await flush();
        expect(
          streamUrl,
          contains('readOnly=1'),
          reason: 'a re-attach that asks for nothing must not grant anything',
        );
        expect(connection.readOnly, isTrue);
        await connection.dispose();
      });

      test('is absent unless asked for', () async {
        final connection = createConnection();
        await connection.connect();
        await flush();
        expect(streamUrl, isNot(contains('readOnly')));
        await connection.dispose();
      });
    });

    group('generation suppression', () {
      test(
        'reconnect creates new adapter and processes events',
        () async {
          await connection.connect();
          await flush();

          adapter.simulateMessage({
            'kind': 'notice',
            'message': 'before',
          });
          await flush();
          expect(receivedEvents, hasLength(1));

          // Disconnect triggers reconnect. The reconnect timer
          // (1s) will fire, bump generation, and create a new
          // adapter.
          adapter.simulateDisconnect();
          await flush();

          // Wait for the reconnect timer to fire.
          await Future<void>.delayed(
            const Duration(milliseconds: 1200),
          );
          await flush();

          // New adapter should be active.
          expect(adapter.isConnected, isTrue);
          expect(
            connection.state,
            SessionConnectionState.connected,
          );

          // Events on the new adapter are processed.
          adapter.simulateMessage({
            'kind': 'notice',
            'message': 'after',
          });
          await flush();

          final notices = receivedEvents.whereType<NoticeWireEvent>().toList();
          expect(notices, hasLength(2));
          expect(notices[0].message, 'before');
          expect(notices[1].message, 'after');
        },
      );

      test(
        'manual connect during reconnect cancels old timer',
        () async {
          await connection.connect();
          await flush();

          // Disconnect — reconnect timer scheduled (1s).
          adapter.simulateDisconnect();
          await flush();
          expect(
            connection.state,
            SessionConnectionState.reconnecting,
          );

          // Immediately call connect() again. This should
          // cancel the pending reconnect timer and create a
          // fresh connection with a new generation.
          await connection.connect();
          await flush();
          expect(
            connection.state,
            SessionConnectionState.connected,
          );

          // Only the new adapter should be active.
          adapter.simulateMessage({
            'kind': 'notice',
            'message': 'manual',
          });
          await flush();

          final notices = receivedEvents.whereType<NoticeWireEvent>().toList();
          expect(notices, hasLength(1));
          expect(notices[0].message, 'manual');

          // Wait past the old reconnect timer delay. If the
          // timer was not cancelled, it would fire and create
          // a third adapter, overwriting ours. Verify state
          // is still connected (not stuck in reconnecting).
          await Future<void>.delayed(
            const Duration(milliseconds: 1200),
          );
          await flush();
          expect(
            connection.state,
            SessionConnectionState.connected,
          );
        },
      );

      test(
        'WireEvent.fromJson tolerates malformed known frames',
        () async {
          final event = WireEvent.fromJson({
            'kind': 'session',
            'broken': true,
          });
          expect(event, isA<UnknownWireEvent>());
          expect((event as UnknownWireEvent).kind, 'session');
        },
      );
    });

    group('reconnect', () {
      test('attempts reconnect on disconnect', () async {
        await connection.connect();
        await flush();
        expect(connection.state, SessionConnectionState.connected);

        adapter.simulateDisconnect();
        await flush();

        expect(
          stateChanges,
          contains(SessionConnectionState.reconnecting),
        );
      });

      test('does not reconnect after ended frame', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({'kind': 'ended'});
        await flush();

        expect(connection.state, SessionConnectionState.closed);
      });

      test('reattaches with ticket query from last history cursor', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'history',
          'messages': <dynamic>[],
          'cursor': 'cursor-v1',
        });
        await flush();

        adapter.simulateDisconnect();
        await flush();
        await Future<void>.delayed(const Duration(milliseconds: 1200));
        await flush();

        expect(streamUrl, isNotNull);
        final query = Uri.parse(streamUrl!).queryParameters;
        expect(query['ticket'], 'cursor-v1');
        expect(query.containsKey('since'), isFalse);
      });
    });

    group('reattach', () {
      test('re-attaches under resume mode (Take over)', () async {
        await connection.connect();
        await flush();
        expect(
          Uri.parse(streamUrl!).queryParameters.containsKey('mode'),
          isFalse,
        );

        await connection.reattach(mode: 'resume');
        await flush();

        expect(connection.state, SessionConnectionState.connected);
        expect(Uri.parse(streamUrl!).queryParameters['mode'], 'resume');
        expect(connection.mode, 'resume');
      });

      test('re-attaches back to Observe (hand back) with no mode', () async {
        await connection.reattach(mode: 'resume');
        await flush();
        expect(Uri.parse(streamUrl!).queryParameters['mode'], 'resume');

        await connection.reattach();
        await flush();
        expect(
          Uri.parse(streamUrl!).queryParameters.containsKey('mode'),
          isFalse,
        );
        expect(connection.mode, isNull);
      });

      test('drop-triggered reconnect preserves resume mode', () async {
        await connection.reattach(mode: 'resume');
        await flush();

        adapter.simulateDisconnect();
        await flush();
        await Future<void>.delayed(const Duration(milliseconds: 1200));
        await flush();

        expect(connection.state, SessionConnectionState.connected);
        expect(Uri.parse(streamUrl!).queryParameters['mode'], 'resume');
      });

      test(
        'carries the drive-attach reason and clears it on Observe',
        () async {
          await connection.reattach(mode: 'resume', reason: 'app-restore');
          await flush();

          var query = Uri.parse(streamUrl!).queryParameters;
          expect(query['mode'], 'resume');
          expect(query['reason'], 'app-restore');
          expect(connection.reason, 'app-restore');

          // Hand back to Observe: both mode and reason must drop, so a bare
          // attach can never accidentally re-claim Drive.
          await connection.reattach();
          await flush();
          query = Uri.parse(streamUrl!).queryParameters;
          expect(query.containsKey('mode'), isFalse);
          expect(query.containsKey('reason'), isFalse);
          expect(connection.reason, isNull);
        },
      );

      test(
        'join-existing carries and then clears the exact owner revision',
        () async {
          const revision = SessionOwnerRevision(epoch: 'broker-epoch', seq: 14);
          await connection.reattach(
            mode: 'resume',
            reason: 'join-existing',
            ownerRevision: revision,
          );
          await flush();

          var query = Uri.parse(streamUrl!).queryParameters;
          expect(query['reason'], 'join-existing');
          expect(query['ownerEpoch'], 'broker-epoch');
          expect(query['ownerSeq'], '14');
          expect(connection.ownerRevision?.seq, 14);

          connection.disarmDriveAuthority();
          expect(connection.ownerRevision, isNull);
          await connection.reattach();
          await flush();
          query = Uri.parse(streamUrl!).queryParameters;
          expect(query.containsKey('ownerEpoch'), isFalse);
          expect(query.containsKey('ownerSeq'), isFalse);
        },
      );

      test(
        'drop-triggered reconnect preserves the drive-attach reason',
        () async {
          await connection.reattach(mode: 'resume', reason: 'lease-restore');
          await flush();

          adapter.simulateDisconnect();
          await flush();
          await Future<void>.delayed(const Duration(milliseconds: 1200));
          await flush();

          expect(connection.state, SessionConnectionState.connected);
          final query = Uri.parse(streamUrl!).queryParameters;
          expect(query['mode'], 'resume');
          expect(query['reason'], 'lease-restore');
        },
      );

      test(
        'drop-triggered join reconnect preserves the exact owner revision',
        () async {
          const revision = SessionOwnerRevision(
            epoch: 'join-reconnect-epoch',
            seq: 27,
          );
          await connection.reattach(
            mode: 'resume',
            reason: 'join-existing',
            ownerRevision: revision,
          );
          await flush();

          adapter.simulateDisconnect();
          await flush();
          await Future<void>.delayed(const Duration(milliseconds: 1200));
          await flush();

          expect(connection.state, SessionConnectionState.connected);
          final query = Uri.parse(streamUrl!).queryParameters;
          expect(query['mode'], 'resume');
          expect(query['reason'], 'join-existing');
          expect(query['ownerEpoch'], 'join-reconnect-epoch');
          expect(query['ownerSeq'], '27');
        },
      );

      test(
        'ordinary frames never disarm the drive-attach mode and reason',
        () async {
          await connection.reattach(mode: 'resume', reason: 'app-restore');
          await flush();

          // Every non-arbitration frame the broker can interleave mid-stream:
          // none of them answers the attach-authority request, so none may
          // demote the next reconnect to Observe.
          adapter
            ..simulateMessage({'kind': 'notice', 'message': 'heads up'})
            ..simulateMessage({'kind': 'error', 'message': 'transient'})
            ..simulateMessage({'kind': 'draft', 'text': 'wip', 'at': 1})
            ..simulateMessage({
              'kind': 'ack',
              'ack': 'client-message',
              'clientMessageId': 'm1',
            })
            ..simulateMessage({
              'kind': 'nack',
              'code': 'BAD_PARAM',
              'message': 'rejected',
              'clientMessageId': 'm2',
            })
            ..simulateMessage({'kind': 'future-frame'});
          await flush();

          expect(connection.mode, 'resume');
          expect(connection.reason, 'app-restore');

          adapter.simulateDisconnect();
          await flush();
          await Future<void>.delayed(const Duration(milliseconds: 1200));
          await flush();

          final query = Uri.parse(streamUrl!).queryParameters;
          expect(query['mode'], 'resume');
          expect(query['reason'], 'app-restore');
        },
      );

      test(
        'attach-conflict disarms the authority request before reconnect',
        () async {
          await connection.reattach(
            mode: 'resume',
            reason: 'join-existing',
            ownerRevision: const SessionOwnerRevision(
              epoch: 'owner-before-conflict',
              seq: 9,
            ),
          );
          await flush();

          adapter.simulateMessage({
            'kind': 'attach-conflict',
            'requestedMode': 'resume',
            'reason': 'join-existing',
            'code': 'JOIN_OWNER_STALE',
            'message': 'The owner changed.',
          });
          await flush();

          expect(connection.ownerRevision, isNull);

          adapter.simulateDisconnect();
          await flush();
          await Future<void>.delayed(const Duration(milliseconds: 1200));
          await flush();

          // The denied one-shot authority request must not silently retry.
          final query = Uri.parse(streamUrl!).queryParameters;
          expect(query.containsKey('mode'), isFalse);
          expect(query.containsKey('reason'), isFalse);
        },
      );

      test('close invalidates an in-flight connect continuation', () async {
        final delayedAdapter = _DelayedConnectAdapter();
        final racingConnection = SessionConnection(
          resolver: EndpointResolver(
            baseUrl: 'http://127.0.0.1:7734',
          ),
          tool: 'claude',
          sessionId: 'race-session',
          adapterFactory: (_) => delayedAdapter,
        );
        addTearDown(racingConnection.dispose);
        final racingStates = <SessionConnectionState>[];
        racingConnection.stateStream.listen(racingStates.add);

        final connectFuture = racingConnection.connect();
        await flush();
        await racingConnection.close();
        delayedAdapter.completeConnect();
        await connectFuture;
        await flush();

        expect(racingConnection.state, SessionConnectionState.closed);
        expect(racingStates, isNot(contains(SessionConnectionState.connected)));
      });
    });

    group('dispose', () {
      test('closes streams and sets state to closed', () async {
        await connection.connect();
        await flush();
        await connection.dispose();
        await flush();
        expect(connection.state, SessionConnectionState.closed);
      });
    });

    group('malformed frames', () {
      test('ignores non-JSON messages', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage('not json at all');
        await flush();

        expect(receivedEvents, isEmpty);
      });

      test('ignores null messages', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage(null);
        await flush();

        expect(receivedEvents, isEmpty);
      });
    });
  });
}

class _DelayedConnectAdapter implements WebSocketAdapter {
  final _messages = StreamController<Object?>.broadcast();
  final _connectCompleter = Completer<void>();
  bool _connected = false;
  bool _closed = false;

  @override
  bool get isConnected => _connected;

  void completeConnect() => _connectCompleter.complete();

  @override
  Future<void> connect() async {
    await _connectCompleter.future;
    if (!_closed) {
      _connected = true;
    }
  }

  @override
  Stream<Object?> get messages => _messages.stream;

  @override
  void send(String data) {
    if (!_connected) {
      throw StateError('WebSocket not connected');
    }
  }

  @override
  void sendJson(Object data) => send(jsonEncode(data));

  @override
  Future<void> close() async {
    _closed = true;
    _connected = false;
  }
}
