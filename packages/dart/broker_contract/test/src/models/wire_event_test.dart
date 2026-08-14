import 'package:broker_contract/broker_contract.dart';
import 'package:test/test.dart';

void main() {
  group('WireEvent', () {
    test('decodes broker identity and hard-incompatible hello', () {
      final event =
          WireEvent.fromJson({
                'kind': 'hello',
                'broker': {
                  'version': '1.2.3',
                  'contract': {
                    'revision': 3,
                    'minimumClientRevision': 2,
                    'surfaceHash': 'fnv1a32:12345678',
                  },
                },
                'compatibility': {
                  'status': 'hard-incompatible',
                  'readOnly': true,
                  'reason': 'revision gap',
                  'broker': {
                    'revision': 3,
                    'minimumClientRevision': 2,
                    'surfaceHash': 'fnv1a32:12345678',
                  },
                  'client': {
                    'revision': 1,
                    'minimumBrokerRevision': 0,
                    'surfaceHash': 'fnv1a32:87654321',
                  },
                },
              })
              as HelloWireEvent;

      expect(event.brokerVersion, '1.2.3');
      expect(
        event.compatibility.status,
        BrokerClientCompatibilityStatus.hardIncompatible,
      );
      expect(event.compatibility.readOnly, isTrue);
    });

    group('SessionWireEvent', () {
      test('fromJson parses session info', () {
        final json = {
          'kind': 'session',
          'info': {
            'id': 'session-1',
            'tool': 'opencode',
            'title': 'Test',
            'status': 'idle',
            'attachMode': 'live',
          },
        };

        final event = WireEvent.fromJson(json);
        expect(event, isA<SessionWireEvent>());
        final session = event as SessionWireEvent;
        expect(session.info.id, 'session-1');
        expect(session.info.tool, 'opencode');
      });

      test('toJson roundtrip', () {
        final json = {
          'kind': 'session',
          'info': {
            'id': 'session-1',
            'tool': 'opencode',
            'title': 'Test',
            'status': 'idle',
            'attachMode': 'live',
          },
        };

        final event = WireEvent.fromJson(json);
        final restored = WireEvent.fromJson(event.toJson());
        expect(restored, isA<SessionWireEvent>());
        expect(
          (restored as SessionWireEvent).info.id,
          'session-1',
        );
      });

      test('round-trips socket authority and revision-conditional join', () {
        final json = {
          'kind': 'session',
          'info': {
            'id': 'session-1',
            'tool': 'pi',
            'title': 'Test',
            'status': 'idle',
            'attachMode': 'observe',
            'sessionOwner': {
              'revision': {'epoch': 'broker-1', 'seq': 4},
              'state': 'drive',
            },
          },
          'authority': {'canMutate': false, 'prompt': 'none'},
          'joinExisting': {
            'ownerRevision': {'epoch': 'broker-1', 'seq': 4},
          },
        };

        final event = WireEvent.fromJson(json) as SessionWireEvent;
        expect(event.authority?.canMutate, isFalse);
        expect(event.authority?.prompt, SessionPromptAuthority.none);
        expect(event.joinExisting?.ownerRevision.epoch, 'broker-1');
        expect(event.joinExisting?.ownerRevision.seq, 4);

        final restored = WireEvent.fromJson(event.toJson()) as SessionWireEvent;
        expect(restored.info.sessionOwner?.state, SessionOwnerState.drive);
        expect(restored.authority?.prompt, SessionPromptAuthority.none);
        expect(restored.joinExisting?.ownerRevision.seq, 4);
      });
    });

    group('HistoryWireEvent', () {
      test('fromJson parses messages', () {
        final json = {
          'kind': 'history',
          'messages': [
            {
              'type': 'user-message',
              'id': 'msg-1',
              'content': 'hello',
            },
            {
              'type': 'model-output',
              'id': 'msg-2',
              'content': 'hi there',
            },
          ],
        };

        final event = WireEvent.fromJson(json);
        expect(event, isA<HistoryWireEvent>());
        final history = event as HistoryWireEvent;
        expect(history.messages, hasLength(2));
        expect(history.messages.first.type, AgentMessageType.userMessage);
        expect(history.messages.last.type, AgentMessageType.modelOutput);
        expect(history.reset, isFalse);
        expect(history.cursor, isNull);
      });

      test('fromJson parses reset and cursor', () {
        final json = {
          'kind': 'history',
          'messages': <dynamic>[],
          'reset': true,
          'cursor': 'abc123',
        };

        final event = WireEvent.fromJson(json) as HistoryWireEvent;
        expect(event.reset, isTrue);
        expect(event.cursor, 'abc123');
      });

      test('fromJson handles missing messages', () {
        final json = {
          'kind': 'history',
        };

        final event = WireEvent.fromJson(json) as HistoryWireEvent;
        expect(event.messages, isEmpty);
        expect(event.reset, isFalse);
      });

      test('toJson preserves reset and cursor', () {
        final json = {
          'kind': 'history',
          'messages': <dynamic>[],
          'reset': true,
          'cursor': 'xyz',
        };

        final event = WireEvent.fromJson(json);
        final restored = event.toJson();
        expect(restored['reset'], isTrue);
        expect(restored['cursor'], 'xyz');
      });

      test('fromJson parses attachTicket', () {
        final json = {
          'kind': 'history',
          'messages': <dynamic>[],
          'cursor': 'cursor-1',
          'attachTicket': 'cursor-1',
        };

        final event = WireEvent.fromJson(json) as HistoryWireEvent;
        expect(event.attachTicket, 'cursor-1');
      });

      test('toJson round-trips attachTicket', () {
        final json = {
          'kind': 'history',
          'messages': <dynamic>[],
          'cursor': 'c',
          'attachTicket': 'c',
        };

        final restored = WireEvent.fromJson(json).toJson();
        expect(restored['attachTicket'], 'c');
      });

      test('fromJson parses history gap metadata', () {
        final json = {
          'kind': 'history',
          'messages': <dynamic>[],
          'gap': {
            'code': 'HISTORY_CURSOR_DIVERGED',
            'reason': 'cursor-prefix-mismatch',
            'message': 'full replay was sent',
          },
        };

        final event = WireEvent.fromJson(json) as HistoryWireEvent;
        expect(event.gap?.code, 'HISTORY_CURSOR_DIVERGED');
        expect(event.gap?.reason, 'cursor-prefix-mismatch');
        expect(event.gap?.message, 'full replay was sent');
      });

      test('toJson round-trips history gap metadata', () {
        const event = HistoryWireEvent(
          messages: [],
          gap: HistoryGap(
            code: 'HISTORY_CURSOR_INVALID',
            reason: 'invalid-cursor',
            message: 'full replay was sent',
          ),
        );

        final restored = event.toJson();
        expect(restored['gap'], {
          'code': 'HISTORY_CURSOR_INVALID',
          'reason': 'invalid-cursor',
          'message': 'full replay was sent',
        });
      });

      test('round-trips capped-history metadata', () {
        final event =
            WireEvent.fromJson({
                  'kind': 'history',
                  'messages': <dynamic>[],
                  'truncated': {'shown': 500, 'total': 16384},
                })
                as HistoryWireEvent;

        expect(event.truncated?.shown, 500);
        expect(event.truncated?.total, 16384);
        expect(event.toJson()['truncated'], {'shown': 500, 'total': 16384});
      });

      test('malformed capped-history counts fail closed', () {
        final event =
            WireEvent.fromJson({
                  'kind': 'history',
                  'messages': <dynamic>[],
                  'truncated': {'shown': -4, 'total': 'many'},
                })
                as HistoryWireEvent;

        expect(event.truncated?.shown, 0);
        expect(event.truncated?.total, 0);
      });
    });

    group('HistoryPageWireEvent', () {
      test('round-trips chronological page and correlation metadata', () {
        final event =
            WireEvent.fromJson({
                  'kind': 'history-page',
                  'messages': [
                    {
                      'type': 'user-message',
                      'key': 'older-1',
                      'text': 'Earlier',
                    },
                  ],
                  'cursor': 'older:2',
                  'hasMore': true,
                  'endOfHistory': false,
                  'clientMessageId': 'page-1',
                })
                as HistoryPageWireEvent;

        expect(event.messages.single.userMessageKey, 'older-1');
        expect(event.cursor, 'older:2');
        expect(event.hasMore, isTrue);
        expect(event.endOfHistory, isFalse);
        expect(event.clientMessageId, 'page-1');
        expect(event.toJson()['kind'], 'history-page');
      });

      test('fails closed on malformed rows instead of advancing past them', () {
        final event = WireEvent.fromJson({
          'kind': 'history-page',
          'messages': [
            {
              'type': 'user-message',
              'key': 'older-1',
              'text': 'Earlier',
            },
            'malformed-row',
          ],
          'cursor': 'older:2',
          'hasMore': true,
          'endOfHistory': false,
        });

        expect(event, isA<UnknownWireEvent>());
      });
    });

    group('MessageWireEvent', () {
      test('fromJson parses seq and message', () {
        final json = {
          'kind': 'message',
          'seq': 42,
          'message': {
            'type': 'tool-call',
            'id': 'msg-42',
          },
        };

        final event = WireEvent.fromJson(json) as MessageWireEvent;
        expect(event.seq, 42);
        expect(event.message.type, AgentMessageType.toolCall);
      });

      test('fromJson defaults seq to 0 for replay frames', () {
        final json = {
          'kind': 'message',
          'message': {
            'type': 'status',
          },
        };

        final event = WireEvent.fromJson(json) as MessageWireEvent;
        expect(event.seq, 0);
      });
    });

    group('CommandsWireEvent', () {
      test('fromJson parses commands list', () {
        final json = {
          'kind': 'commands',
          'commands': [
            {'name': 'build', 'description': 'Build the project'},
            {'name': 'test'},
          ],
        };

        final event = WireEvent.fromJson(json) as CommandsWireEvent;
        expect(event.commands, hasLength(2));
        expect(event.commands.first.name, 'build');
        expect(event.commands.first.description, 'Build the project');
        expect(event.commands.last.name, 'test');
      });

      test('fromJson handles empty commands', () {
        final json = {
          'kind': 'commands',
        };

        final event = WireEvent.fromJson(json) as CommandsWireEvent;
        expect(event.commands, isEmpty);
      });
    });

    group('OptionsWireEvent', () {
      test('fromJson parses models, agents, and modes', () {
        final json = {
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
            {'value': 'default', 'label': 'Default'},
          ],
        };

        final event = WireEvent.fromJson(json) as OptionsWireEvent;
        expect(event.models, hasLength(1));
        expect(event.models.first.modelID, 'claude-sonnet-4-6');
        expect(event.agents, hasLength(1));
        expect(event.agents.first.name, 'build');
        expect(event.modes, hasLength(1));
        expect(event.modes!.first.value, 'default');
      });

      test('fromJson handles missing modes', () {
        final json = {
          'kind': 'options',
          'models': <dynamic>[],
          'agents': <dynamic>[],
        };

        final event = WireEvent.fromJson(json) as OptionsWireEvent;
        expect(event.modes, isNull);
      });

      test('preserves native Codex Ultra in its owning model only', () {
        final event =
            WireEvent.fromJson({
                  'kind': 'options',
                  'models': [
                    {
                      'providerID': 'openai',
                      'modelID': 'gpt-5.6-sol',
                      'label': 'GPT-5.6 Sol',
                      'reasoningEfforts': [
                        {
                          'effort': 'ultra',
                          'label': 'Ultra',
                          'description':
                              'Maximum reasoning with automatic task '
                              'delegation',
                        },
                      ],
                    },
                    {
                      'providerID': 'openai',
                      'modelID': 'gpt-5.6-luna',
                      'label': 'GPT-5.6 Luna',
                      'reasoningEfforts': [
                        {'effort': 'max', 'label': 'Max'},
                      ],
                    },
                  ],
                  'agents': <dynamic>[],
                })
                as OptionsWireEvent;

        expect(event.models.first.reasoningEfforts!.single.effort, 'ultra');
        expect(
          event.models.last.reasoningEfforts,
          isNot(
            contains(predicate<ReasoningEffort>((e) => e.effort == 'ultra')),
          ),
        );
      });
    });

    group('NoticeWireEvent', () {
      test('fromJson parses message', () {
        final json = {
          'kind': 'notice',
          'message': 'Session paused',
        };

        final event = WireEvent.fromJson(json) as NoticeWireEvent;
        expect(event.message, 'Session paused');
      });
    });

    group('EndedWireEvent', () {
      test('fromJson parses reason', () {
        final json = {
          'kind': 'ended',
          'reason': 'user-disconnect',
        };

        final event = WireEvent.fromJson(json) as EndedWireEvent;
        expect(event.reason, 'user-disconnect');
      });

      test('fromJson handles missing reason', () {
        final json = {
          'kind': 'ended',
        };

        final event = WireEvent.fromJson(json) as EndedWireEvent;
        expect(event.reason, isNull);
      });
    });

    group('ErrorWireEvent', () {
      test('fromJson parses message', () {
        final json = {
          'kind': 'error',
          'message': 'Permission denied',
        };

        final event = WireEvent.fromJson(json) as ErrorWireEvent;
        expect(event.message, 'Permission denied');
      });
    });

    group('DraftWireEvent', () {
      test('fromJson parses text and at', () {
        final event =
            WireEvent.fromJson({
                  'kind': 'draft',
                  'text': 'hello',
                  'at': 1719900000000,
                })
                as DraftWireEvent;
        expect(event.text, 'hello');
        expect(event.at, 1719900000000);
        expect(event.revision, isNull);
        expect(event.updateId, isNull);
      });

      test('fromJson tolerates missing fields', () {
        final event = WireEvent.fromJson({'kind': 'draft'}) as DraftWireEvent;
        expect(event.text, '');
        expect(event.at, 0);
      });

      test('toJson round-trips', () {
        final json = {'kind': 'draft', 'text': 'x', 'at': 5};
        final restored = WireEvent.fromJson(json).toJson();
        expect(restored['kind'], 'draft');
        expect(restored['text'], 'x');
        expect(restored['at'], 5);
      });

      test('versioned frames round-trip revision and updateId', () {
        final event =
            WireEvent.fromJson({
                  'kind': 'draft',
                  'text': 'shared',
                  'at': 7,
                  'revision': 12,
                  'updateId': 'u-1',
                })
                as DraftWireEvent;
        expect(event.revision, 12);
        expect(event.updateId, 'u-1');
        final json = event.toJson();
        expect(json['revision'], 12);
        expect(json['updateId'], 'u-1');
      });

      test('unversioned frames omit the version fields', () {
        const event = DraftWireEvent(text: 'legacy', at: 3);
        final json = event.toJson();
        expect(json.containsKey('revision'), isFalse);
        expect(json.containsKey('updateId'), isFalse);
      });
    });

    group('AckWireEvent', () {
      test('fromJson parses client-message ack', () {
        final event =
            WireEvent.fromJson({
                  'kind': 'ack',
                  'ack': 'client-message',
                  'clientMessageId': 'cm-1',
                  'duplicate': true,
                  'pending': false,
                })
                as AckWireEvent;
        expect(event.ackKind, 'client-message');
        expect(event.clientMessageId, 'cm-1');
        expect(event.duplicate, isTrue);
        expect(event.pending, isFalse);
      });

      test('fromJson parses attach-ticket ack', () {
        final event =
            WireEvent.fromJson({
                  'kind': 'ack',
                  'ack': 'ack',
                  'attachTicket': 't-1',
                })
                as AckWireEvent;
        expect(event.ackKind, 'ack');
        expect(event.attachTicket, 't-1');
      });

      test('toJson omits optional unset fields', () {
        final restored = WireEvent.fromJson({
          'kind': 'ack',
          'ack': 'ack',
        }).toJson();
        expect(restored['kind'], 'ack');
        expect(restored['ack'], 'ack');
        expect(restored.containsKey('attachTicket'), isFalse);
        expect(restored.containsKey('duplicate'), isFalse);
      });

      // DR1: `draftCleared` reports the second half of a prompt handoff. A
      // decoding slip here is silent and expensive — the sender would treat an
      // uncleared shared draft as cleared and delete the row that retries it.
      test('an ack without draftCleared means the draft was cleared', () {
        final event =
            WireEvent.fromJson({
                  'kind': 'ack',
                  'ack': 'client-message',
                  'clientMessageId': 'cm-1',
                })
                as AckWireEvent;
        expect(event.draftCleared, isTrue);
        expect(event.draftRevision, isNull);
      });

      test('an explicit draftCleared false decodes with its revision', () {
        final event =
            WireEvent.fromJson({
                  'kind': 'ack',
                  'ack': 'client-message',
                  'clientMessageId': 'cm-1',
                  'draftCleared': false,
                  'draftRevision': 7,
                })
                as AckWireEvent;
        expect(event.draftCleared, isFalse);
        expect(event.draftRevision, 7);
      });

      test('a failed clear round-trips through toJson', () {
        final json = const AckWireEvent(
          ackKind: 'client-message',
          clientMessageId: 'cm-1',
          draftCleared: false,
          draftRevision: 7,
        ).toJson();
        expect(json['draftCleared'], isFalse);
        expect(json['draftRevision'], 7);
        final restored = WireEvent.fromJson(json) as AckWireEvent;
        expect(restored.draftCleared, isFalse);
        expect(restored.draftRevision, 7);
      });

      test('a successful clear stays off the wire', () {
        final json = const AckWireEvent(
          ackKind: 'client-message',
          clientMessageId: 'cm-1',
        ).toJson();
        expect(json.containsKey('draftCleared'), isFalse);
        expect(json.containsKey('draftRevision'), isFalse);
      });
    });

    group('NackWireEvent', () {
      test('fromJson parses code and message', () {
        final event =
            WireEvent.fromJson({
                  'kind': 'nack',
                  'code': 'ACK_UNKNOWN_TARGET',
                  'message': 'unknown ticket',
                  'attachTicket': 't-2',
                  'clientMessageId': 'cm-2',
                })
                as NackWireEvent;
        expect(event.code, 'ACK_UNKNOWN_TARGET');
        expect(event.message, 'unknown ticket');
        expect(event.attachTicket, 't-2');
        expect(event.clientMessageId, 'cm-2');
      });

      test('fromJson tolerates missing fields', () {
        final event = WireEvent.fromJson({'kind': 'nack'}) as NackWireEvent;
        expect(event.code, '');
        expect(event.message, '');
      });

      test('toJson round-trips required fields', () {
        final restored = WireEvent.fromJson({
          'kind': 'nack',
          'code': 'CLIENT_MESSAGE_FAILED',
          'message': 'boom',
        }).toJson();
        expect(restored['kind'], 'nack');
        expect(restored['code'], 'CLIENT_MESSAGE_FAILED');
        expect(restored['message'], 'boom');
        expect(restored.containsKey('attachTicket'), isFalse);
      });
    });

    group('UnknownWireEvent', () {
      test('fromJson returns UnknownWireEvent for unknown kind', () {
        final json = {
          'kind': 'future-feature',
          'data': 'some value',
        };

        final event = WireEvent.fromJson(json);
        expect(event, isA<UnknownWireEvent>());
        final unknown = event as UnknownWireEvent;
        expect(unknown.kind, 'future-feature');
        expect(unknown.raw['data'], 'some value');
      });

      test('fromJson returns UnknownWireEvent for missing kind', () {
        final json = {
          'data': 'no kind field',
        };

        final event = WireEvent.fromJson(json);
        expect(event, isA<UnknownWireEvent>());
        final unknown = event as UnknownWireEvent;
        expect(unknown.kind, isNull);
      });
    });

    group('tolerance', () {
      test('session event tolerates extra fields in info', () {
        final json = {
          'kind': 'session',
          'info': {
            'id': 's1',
            'tool': 't',
            'title': 'T',
            'status': 'idle',
            'attachMode': 'live',
            'futureField': 42,
            'anotherFuture': 'hello',
          },
        };

        final event = WireEvent.fromJson(json) as SessionWireEvent;
        expect(event.info.id, 's1');
      });

      test('message event tolerates extra fields', () {
        final json = {
          'kind': 'message',
          'seq': 1,
          'message': {
            'type': 'model-output',
            'futureField': true,
          },
          'extraTopLevel': 'ignored',
        };

        final event = WireEvent.fromJson(json) as MessageWireEvent;
        expect(event.message.type, AgentMessageType.modelOutput);
      });
    });
  });
}
