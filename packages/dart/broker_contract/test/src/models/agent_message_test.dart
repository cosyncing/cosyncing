import 'package:broker_contract/broker_contract.dart';
import 'package:test/test.dart';

void main() {
  group('artifact interaction policy', () {
    test('accepts only versioned signed structured actions', () {
      final policy = ArtifactInteractionPolicy.fromJson({
        'mode': 'structured',
        'bridgeVersion': 1,
        'schemaVersion': 1,
        'allowedActions': ['form-submit', 'action'],
        'interactionRef': 'signed-ref',
        'expiresAt': 1900000000000,
      });

      expect(policy?.canInteract, isTrue);
      expect(policy?.allowedActions, [
        ArtifactInteractionAction.formSubmit,
        ArtifactInteractionAction.action,
      ]);
    });

    test('fails closed for absent signatures and future versions', () {
      expect(
        ArtifactInteractionPolicy.fromJson({
          'mode': 'structured',
          'bridgeVersion': 2,
          'schemaVersion': 1,
          'allowedActions': ['action'],
          'interactionRef': 'signed-ref',
        }),
        isNull,
      );
      expect(
        ArtifactInteractionPolicy.fromJson({
          'mode': 'display-only',
          'bridgeVersion': 1,
          'schemaVersion': 1,
          'allowedActions': <Object?>[],
        })?.canInteract,
        isFalse,
      );
    });
  });

  group('AgentMessageType', () {
    test('fromWire parses all 23 canonical types', () {
      expect(
        AgentMessageType.fromWire('model-output'),
        AgentMessageType.modelOutput,
      );
      expect(
        AgentMessageType.fromWire('thinking'),
        AgentMessageType.thinking,
      );
      expect(
        AgentMessageType.fromWire('status'),
        AgentMessageType.status,
      );
      expect(
        AgentMessageType.fromWire('tool-call'),
        AgentMessageType.toolCall,
      );
      expect(
        AgentMessageType.fromWire('tool-result'),
        AgentMessageType.toolResult,
      );
      expect(
        AgentMessageType.fromWire('fs-edit'),
        AgentMessageType.fsEdit,
      );
      expect(
        AgentMessageType.fromWire('file-artifact'),
        AgentMessageType.fileArtifact,
      );
      expect(
        AgentMessageType.fromWire('permission-request'),
        AgentMessageType.permissionRequest,
      );
      expect(
        AgentMessageType.fromWire('permission-resolved'),
        AgentMessageType.permissionResolved,
      );
      expect(
        AgentMessageType.fromWire('question-request'),
        AgentMessageType.questionRequest,
      );
      expect(
        AgentMessageType.fromWire('question-resolved'),
        AgentMessageType.questionResolved,
      );
      expect(
        AgentMessageType.fromWire('terminal-output'),
        AgentMessageType.terminalOutput,
      );
      expect(
        AgentMessageType.fromWire('notice'),
        AgentMessageType.notice,
      );
      expect(
        AgentMessageType.fromWire('metadata-update'),
        AgentMessageType.metadataUpdate,
      );
      expect(
        AgentMessageType.fromWire('token-count'),
        AgentMessageType.tokenCount,
      );
      expect(
        AgentMessageType.fromWire('run-summary'),
        AgentMessageType.runSummary,
      );
      expect(
        AgentMessageType.fromWire('user-message'),
        AgentMessageType.userMessage,
      );
      expect(
        AgentMessageType.fromWire('event'),
        AgentMessageType.event,
      );
      expect(
        AgentMessageType.fromWire('goal-state'),
        AgentMessageType.goalState,
      );
      expect(
        AgentMessageType.fromWire('task-list-state'),
        AgentMessageType.taskListState,
      );
      expect(
        AgentMessageType.fromWire('agent-activity'),
        AgentMessageType.agentActivity,
      );
      expect(
        AgentMessageType.fromWire('history-reset'),
        AgentMessageType.historyReset,
      );
      expect(
        AgentMessageType.fromWire('error'),
        AgentMessageType.error,
      );
    });

    test('fromWire returns unknown for unrecognized type', () {
      expect(
        AgentMessageType.fromWire('future-type'),
        AgentMessageType.unknown,
      );
    });

    test('fromWire returns unknown for null', () {
      expect(
        AgentMessageType.fromWire(null),
        AgentMessageType.unknown,
      );
    });

    test('wireValue matches broker wire format', () {
      expect(AgentMessageType.modelOutput.wireValue, 'model-output');
      expect(AgentMessageType.toolCall.wireValue, 'tool-call');
      expect(
        AgentMessageType.permissionRequest.wireValue,
        'permission-request',
      );
      expect(AgentMessageType.notice.wireValue, 'notice');
      expect(AgentMessageType.userMessage.wireValue, 'user-message');
    });
  });

  group('AgentMessage', () {
    test('fromJson parses known type', () {
      final json = {
        'type': 'user-message',
        'id': 'msg-1',
        'content': 'hello',
      };

      final msg = AgentMessage.fromJson(json);
      expect(msg.type, AgentMessageType.userMessage);
      expect(msg.id, 'msg-1');
    });

    test('status accessor parses lifecycle and fails closed', () {
      expect(
        AgentMessage.fromJson({
          'type': 'status',
          'status': 'running',
        }).agentMessageStatus,
        AgentMessageStatus.running,
      );
      expect(
        AgentMessage.fromJson({
          'type': 'status',
          'status': 'idle',
        }).agentMessageStatus,
        AgentMessageStatus.idle,
      );
      expect(
        AgentMessage.fromJson({
          'type': 'status',
          'status': 'future',
        }).agentMessageStatus,
        AgentMessageStatus.unknown,
      );
      expect(
        AgentMessage.fromJson({
          'type': 'notice',
          'message': 'idle',
        }).agentMessageStatus,
        isNull,
      );
      expect(
        ArtifactInteractionPolicy.fromJson({
          'mode': 'structured',
          'bridgeVersion': 1,
          'schemaVersion': 1,
          'allowedActions': <Object?>[],
          'interactionRef': 'signed-ref',
        })?.canInteract,
        isFalse,
      );
    });

    test('status detail is trimmed, typed, and status-only', () {
      expect(
        AgentMessage.fromJson({
          'type': 'status',
          'status': 'running',
          'detail': '  provider retry  ',
        }).statusDetail,
        'provider retry',
      );
      expect(
        AgentMessage.fromJson({
          'type': 'status',
          'status': 'running',
          'detail': 7,
        }).statusDetail,
        isNull,
      );
      expect(
        AgentMessage.fromJson({
          'type': 'notice',
          'detail': 'provider retry',
        }).statusDetail,
        isNull,
      );
    });

    test('transcript semantics are typed without inspecting display text', () {
      final interruption = AgentMessage.fromJson({
        'type': 'notice',
        'message': 'adapter text may change',
        'semantic': {
          'kind': 'interruption',
          'reason': 'automatic-approval-denied-repeatedly',
          'turnId': 'turn-7',
        },
      });
      expect(
        interruption.transcriptNoticeSemanticKind,
        TranscriptNoticeSemanticKind.interruption,
      );
      expect(
        interruption.transcriptInterruptionReason,
        TranscriptInterruptionReason.automaticApprovalDeniedRepeatedly,
      );
      expect(interruption.transcriptInterruptionTurnId, 'turn-7');

      final generic = AgentMessage.fromJson({
        'type': 'notice',
        'message': 'Conversation interrupted.',
      });
      expect(generic.transcriptNoticeSemanticKind, isNull);
      expect(generic.transcriptInterruptionReason, isNull);

      final compaction = AgentMessage.fromJson({
        'type': 'history-reset',
        'notice': 'adapter text may change',
        'semantic': {'kind': 'compaction'},
      });
      expect(
        compaction.historyResetSemanticKind,
        HistoryResetSemanticKind.compaction,
      );
      expect(
        AgentMessage.fromJson({
          'type': 'history-reset',
          'semantic': {'kind': 'future'},
        }).historyResetSemanticKind,
        HistoryResetSemanticKind.unknown,
      );
    });

    test('fromJson preserves all fields in raw', () {
      final json = {
        'type': 'model-output',
        'id': 'msg-2',
        'content': 'response',
        'toolName': 'bash',
        'nested': {'key': 'value'},
      };

      final msg = AgentMessage.fromJson(json);
      expect(msg.raw['content'], 'response');
      expect(msg.raw['toolName'], 'bash');
      expect(msg.raw['nested'], isA<Map<String, dynamic>>());
    });

    test('fromJson preserves new file-artifact export metadata fields', () {
      final json = {
        'type': 'file-artifact',
        'name': 'transcript.html',
        'deliveryClass': 'export-attachment',
        'format': 'html',
        'redactionSummary': 'redacted secrets',
        'expiresAt': 1719000000000,
        'mimeType': 'text/html',
      };

      final msg = AgentMessage.fromJson(json);
      expect(msg.type, AgentMessageType.fileArtifact);
      expect(msg.raw['deliveryClass'], 'export-attachment');
      expect(msg.raw['format'], 'html');
      expect(msg.raw['redactionSummary'], 'redacted secrets');
      expect(msg.raw['expiresAt'], 1719000000000);
    });

    test('permission-resolved types the external decision', () {
      final message = AgentMessage.fromJson({
        'type': 'permission-resolved',
        'requestId': 'perm-1',
        'decision': 'external',
      });

      expect(
        message.permissionResolutionDecision,
        PermissionResolutionDecision.external,
      );
    });

    test('permission-resolved tolerates future and malformed decisions', () {
      final future = AgentMessage.fromJson({
        'type': 'permission-resolved',
        'decision': 'future-decision',
      });
      final malformed = AgentMessage.fromJson({
        'type': 'permission-resolved',
        'decision': 42,
      });

      expect(
        future.permissionResolutionDecision,
        PermissionResolutionDecision.unknown,
      );
      expect(
        malformed.permissionResolutionDecision,
        PermissionResolutionDecision.unknown,
      );
    });

    test('types canonical permission request fields', () {
      final message = AgentMessage.fromJson({
        'type': 'permission-request',
        'requestId': 'perm-1',
        'title': 'bash',
        'detail': '/workspace',
        'options': ['approve', 'approve-session', 42, '  reject  '],
      });

      expect(message.permissionRequestTitle, 'bash');
      expect(message.permissionRequestDetail, '/workspace');
      expect(message.requestIsReadOnly, isFalse);
      expect(
        message.permissionRequestOptions,
        ['approve', 'approve-session', 'reject'],
      );
    });

    test('marks display-only request messages as read-only', () {
      expect(
        AgentMessage.fromJson({
          'type': 'question-request',
          'readOnly': true,
          'questions': <Object?>[],
        }).requestIsReadOnly,
        isTrue,
      );
      expect(
        AgentMessage.fromJson({
          'type': 'notice',
          'readOnly': true,
        }).requestIsReadOnly,
        isFalse,
      );
    });

    test('types canonical structured questions and drops malformed rows', () {
      final message = AgentMessage.fromJson({
        'type': 'question-request',
        'requestId': 'question-1',
        'questions': [
          {
            'header': 'Checks',
            'question': 'Which checks?',
            'options': [
              {'label': 'Tests', 'description': 'Run the suite.'},
              {'label': '  Docs  '},
              {'description': 'missing label'},
            ],
            'multiple': true,
          },
          {'header': 'missing question'},
        ],
      });

      expect(message.questionRequestQuestions, hasLength(1));
      final question = message.questionRequestQuestions.single;
      expect(question.header, 'Checks');
      expect(question.question, 'Which checks?');
      expect(question.multiple, isTrue);
      expect(question.options.map((option) => option.label), ['Tests', 'Docs']);
      expect(question.options.first.description, 'Run the suite.');
    });

    test('fromJson handles unknown type gracefully', () {
      final json = {
        'type': 'future-message-type',
        'id': 'msg-3',
      };

      final msg = AgentMessage.fromJson(json);
      expect(msg.type, AgentMessageType.unknown);
      expect(msg.id, 'msg-3');
      expect(msg.raw['type'], 'future-message-type');
    });

    test('fromJson handles missing type', () {
      final json = {
        'id': 'msg-4',
        'content': 'no type',
      };

      final msg = AgentMessage.fromJson(json);
      expect(msg.type, AgentMessageType.unknown);
    });

    test('fromJson parses seq and timestamp', () {
      final json = {
        'type': 'status',
        'seq': 5,
        'timestamp': 1719000000000,
      };

      final msg = AgentMessage.fromJson(json);
      expect(msg.seq, 5);
      expect(msg.timestamp, 1719000000000);
    });

    test('fromJson handles null optional fields', () {
      final json = {
        'type': 'error',
      };

      final msg = AgentMessage.fromJson(json);
      expect(msg.id, isNull);
      expect(msg.seq, isNull);
      expect(msg.parentId, isNull);
      expect(msg.timestamp, isNull);
    });

    test('toJson preserves all raw fields', () {
      final json = {
        'type': 'tool-result',
        'id': 'msg-5',
        'output': 'result data',
        'extra': 42,
      };

      final msg = AgentMessage.fromJson(json);
      final out = msg.toJson();
      expect(out['type'], 'tool-result');
      expect(out['id'], 'msg-5');
      expect(out['output'], 'result data');
      expect(out['extra'], 42);
    });

    test('toString includes type', () {
      final json = {'type': 'user-message'};
      final msg = AgentMessage.fromJson(json);
      expect(msg.toString(), contains('user-message'));
    });
  });

  group('Part 3 typed metadata', () {
    test('parses every adapter-owned tool display class', () {
      for (final entry in <String, ToolDisplayClass>{
        'execute': ToolDisplayClass.execute,
        'edit': ToolDisplayClass.edit,
        'lookup': ToolDisplayClass.lookup,
        'other': ToolDisplayClass.other,
      }.entries) {
        final message = AgentMessage.fromJson({
          'type': 'tool-call',
          'callId': 'call-1',
          'toolClass': entry.key,
        });

        expect(message.toolDisplayClass, entry.value);
        expect(message.toolCallId, 'call-1');
      }
    });

    test('missing and future tool classes keep conservative fallbacks', () {
      final missing = AgentMessage.fromJson({
        'type': 'tool-call',
        'callId': 'call-1',
      });
      final future = AgentMessage.fromJson({
        'type': 'tool-result',
        'callId': 'call-1',
        'toolClass': 'future-class',
      });

      expect(missing.toolDisplayClass, isNull);
      expect(future.toolDisplayClass, ToolDisplayClass.unknown);
    });

    test('exposes only authoritative finite non-negative duration', () {
      AgentMessage result(Object? duration) => AgentMessage.fromJson({
        'type': 'tool-result',
        'callId': 'call-1',
        'durationMs': duration,
      });

      expect(result(1250).toolDurationMs, 1250);
      expect(result(12.5).toolDurationMs, 12.5);
      expect(result(-1).toolDurationMs, isNull);
      expect(result(double.nan).toolDurationMs, isNull);
      expect(result('1250').toolDurationMs, isNull);
      expect(
        AgentMessage.fromJson({
          'type': 'tool-call',
          'durationMs': 1250,
        }).toolDurationMs,
        isNull,
      );
    });

    test('types queued user messages by stable key', () {
      final queued = AgentMessage.fromJson({
        'type': 'user-message',
        'key': 'user-1',
        'text': 'Follow up',
        'queued': true,
      });
      final delivered = AgentMessage.fromJson({
        'type': 'user-message',
        'key': 'user-1',
        'text': 'Follow up',
      });

      expect(queued.userMessageKey, 'user-1');
      expect(queued.userMessageQueued, isTrue);
      expect(delivered.userMessageKey, 'user-1');
      expect(delivered.userMessageQueued, isFalse);
    });

    test('exposes the app-send correlation token separately from identity', () {
      final stamped = AgentMessage.fromJson({
        'type': 'user-message',
        'key': 'native-1',
        'clientKey': 'ca.send.1',
        'text': 'Sent from the app',
      });
      final legacy = AgentMessage.fromJson({
        'type': 'user-message',
        'key': 'native-2',
        'text': 'Typed in the terminal',
      });
      final wrongType = AgentMessage.fromJson({
        'type': 'model-output',
        'clientKey': 'ca.send.1',
        'text': 'not a user message',
      });

      expect(stamped.userMessageClientKey, 'ca.send.1');
      expect(stamped.userMessageKey, 'native-1');
      expect(legacy.userMessageClientKey, isNull);
      expect(wrongType.userMessageClientKey, isNull);
    });

    test('links a sent artifact to the user-message it travelled with', () {
      final attachment = AgentMessage.fromJson({
        'type': 'file-artifact',
        'artifactKey': 'artifact-1',
        'name': 'screenshot.png',
        'userMessageKey': 'user-1',
      });
      final produced = AgentMessage.fromJson({
        'type': 'file-artifact',
        'artifactKey': 'artifact-2',
        'name': 'report.pdf',
      });
      final blank = AgentMessage.fromJson({
        'type': 'file-artifact',
        'artifactKey': 'artifact-3',
        'userMessageKey': '   ',
      });
      final wrongType = AgentMessage.fromJson({
        'type': 'model-output',
        'userMessageKey': 'user-1',
        'text': 'not an artifact',
      });

      expect(attachment.fileArtifactUserMessageKey, 'user-1');
      expect(attachment.isUserAttachment, isTrue);
      expect(produced.fileArtifactUserMessageKey, isNull);
      expect(produced.isUserAttachment, isFalse);
      expect(blank.fileArtifactUserMessageKey, isNull);
      expect(blank.isUserAttachment, isFalse);
      expect(wrongType.fileArtifactUserMessageKey, isNull);
    });
  });

  group('typed session state messages', () {
    test('decodes goal state with a stable default key', () {
      final goal = GoalStateSnapshot.fromMessage(
        AgentMessage.fromJson({
          'type': 'goal-state',
          'status': 'blocked',
          'title': 'Ship the client',
          'detail': 'Waiting for signing',
          'elapsedMs': 1250,
        }),
      );

      expect(goal, isNotNull);
      expect(goal?.key, 'current');
      expect(goal?.status, GoalStateStatus.blocked);
      expect(goal?.title, 'Ship the client');
      expect(goal?.elapsedMs, 1250);
    });

    test('rejects malformed or future goal lifecycle state', () {
      expect(
        GoalStateSnapshot.fromMessage(
          AgentMessage.fromJson({
            'type': 'goal-state',
            'status': 'future-state',
          }),
        ),
        isNull,
      );
      expect(
        GoalStateSnapshot.fromMessage(
          AgentMessage.fromJson({'type': 'goal-state', 'status': 4}),
        ),
        isNull,
      );
    });

    test('decodes task list and tolerates malformed individual rows', () {
      final tasks = TaskListStateSnapshot.fromMessage(
        AgentMessage.fromJson({
          'type': 'task-list-state',
          'key': 'plan-1',
          'status': 'running',
          'title': 'Launch plan',
          'items': [
            {'id': 'a', 'title': 'Audit', 'status': 'done'},
            {'id': 'b', 'title': 'Package', 'status': 'in-progress'},
            {'id': 'bad', 'status': 'open'},
          ],
        }),
      );

      expect(tasks, isNotNull);
      expect(tasks?.key, 'plan-1');
      expect(tasks?.items, hasLength(2));
      expect(tasks?.items.last.status, TaskItemStatus.inProgress);
    });

    test('decodes exact plan semantic identity, revision, and actions', () {
      final tasks = TaskListStateSnapshot.fromMessage(
        AgentMessage.fromJson({
          'type': 'task-list-state',
          'key': 'plan-1',
          'status': 'running',
          'items': <Object?>[],
          'semantic': {
            'kind': 'plan',
            'planKey': 'plan:authoritative',
            'revision': 'rev-7',
            'state': 'proposed',
            'actions': {'approve': true, 'edit': true, 'exit': false},
          },
        }),
      );

      expect(tasks?.semantic?.planKey, 'plan:authoritative');
      expect(tasks?.semantic?.revision, 'rev-7');
      expect(tasks?.semantic?.state, PlanSemanticState.proposed);
      expect(tasks?.semantic?.canApprove, isTrue);
      expect(tasks?.semantic?.canEdit, isTrue);
      expect(tasks?.semantic?.canExit, isFalse);
    });

    test('fails closed for malformed plan semantics', () {
      final tasks = TaskListStateSnapshot.fromMessage(
        AgentMessage.fromJson({
          'type': 'task-list-state',
          'key': 'plan-1',
          'status': 'running',
          'items': <Object?>[],
          'semantic': {
            'kind': 'plan',
            'planKey': 'plan:authoritative',
            'revision': 'rev-7',
            'state': 'proposed',
            'actions': {'approve': true},
          },
        }),
      );

      expect(tasks?.semantic, isNull);
      expect(
        PlanSemantic.fromJson({
          'kind': 'plan',
          'planKey': ' plan-with-space ',
          'revision': 'rev-7',
          'state': 'proposed',
          'actions': {'approve': true, 'edit': true, 'exit': true},
        }),
        isNull,
      );
    });

    test('rejects task lists without their required key and item array', () {
      expect(
        TaskListStateSnapshot.fromMessage(
          AgentMessage.fromJson({
            'type': 'task-list-state',
            'status': 'running',
            'items': const <Object?>[],
          }),
        ),
        isNull,
      );
      expect(
        TaskListStateSnapshot.fromMessage(
          AgentMessage.fromJson({
            'type': 'task-list-state',
            'key': 'plan',
            'status': 'running',
            'items': 'bad',
          }),
        ),
        isNull,
      );
    });

    test('decodes agent activity with TUI-equivalent input tokens', () {
      final activity = AgentActivitySnapshot.fromMessage(
        AgentMessage.fromJson({
          'type': 'agent-activity',
          'key': 'agent:call-1',
          'kind': 'subagent',
          'title': 'Audit notifications',
          'subtitle': 'reviewer',
          'status': 'running',
          'startedAtMs': 1000,
          'elapsedMs': 5000,
          'tokens': {'input': 17500, 'output': 1200},
          'agentsDone': 0,
          'agentsTotal': 1,
          'children': [
            {
              'key': 'child-1',
              'title': 'Inspect Android',
              'status': 'running',
            },
          ],
        }),
      );

      expect(activity, isNotNull);
      expect(activity?.kind, AgentActivityKind.subagent);
      expect(activity?.status, AgentActivityStatus.running);
      expect(activity?.tokens?.input, 17500);
      expect(activity?.tokens?.output, 1200);
      expect(activity?.children.single.title, 'Inspect Android');
    });

    test('rejects malformed activity but tolerates future kind', () {
      expect(
        AgentActivitySnapshot.fromMessage(
          AgentMessage.fromJson({
            'type': 'agent-activity',
            'key': 'missing-title',
            'kind': 'subagent',
            'status': 'running',
          }),
        ),
        isNull,
      );
      final future = AgentActivitySnapshot.fromMessage(
        AgentMessage.fromJson({
          'type': 'agent-activity',
          'key': 'job-1',
          'kind': 'future-job',
          'title': 'Future work',
          'status': 'running',
        }),
      );
      expect(future?.kind, AgentActivityKind.unknown);
    });
  });
}
