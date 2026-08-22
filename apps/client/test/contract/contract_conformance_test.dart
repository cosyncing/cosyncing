import 'dart:io';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/renderers/message_renderer_registry.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late final String snapshotSource;

  setUpAll(() {
    snapshotSource = File(
      '../../contracts/generated/broker-client.snapshot.ts',
    ).readAsStringSync();
  });

  test('WireEvent.fromJson decodes all canonical kinds', () {
    final samples = <String, Map<String, dynamic>>{
      'hello': {
        'kind': 'hello',
        'broker': {
          'version': '0.1.0',
          'contract': {
            'revision': cosyncingClientContractRevision,
            'minimumClientRevision': 0,
            'surfaceHash': cosyncingClientContractSurfaceHash,
          },
        },
        'clientVersion': cosyncingClientVersion,
        'compatibility': {
          'status': 'compatible',
          'readOnly': false,
          'reason': 'contract revisions match',
          'broker': {
            'revision': cosyncingClientContractRevision,
            'minimumClientRevision': 0,
            'surfaceHash': cosyncingClientContractSurfaceHash,
          },
          'client': {
            'revision': cosyncingClientContractRevision,
            'minimumBrokerRevision': cosyncingClientMinimumBrokerRevision,
            'surfaceHash': cosyncingClientContractSurfaceHash,
          },
        },
      },
      'session': {
        'kind': 'session',
        'info': _sampleSessionInfo,
      },
      'history': {
        'kind': 'history',
        'messages': [
          {'type': 'model-output', 'content': 'warm-up'},
          {'type': 'user-message', 'content': 'run check'},
        ],
        'reset': true,
        'cursor': 'cursor:1',
      },
      'history-page': {
        'kind': 'history-page',
        'messages': [
          {'type': 'model-output', 'content': 'older output'},
        ],
        'cursor': 'cursor:older',
        'hasMore': true,
        'endOfHistory': false,
        'clientMessageId': 'page-1',
      },
      'message': {
        'kind': 'message',
        'seq': 9,
        'message': {'type': 'status', 'status': 'working'},
      },
      'commands': {
        'kind': 'commands',
        'commands': [
          {'name': 'help', 'description': 'show', 'usage': 'help'},
        ],
      },
      'options': {
        'kind': 'options',
        'models': [
          {
            'providerID': 'anthropic',
            'modelID': 'opus',
            'label': 'Claude',
          },
        ],
        'agents': [
          {'name': 'agent-a', 'description': 'primary agent'},
        ],
        'modes': [
          {
            'value': 'ask-permission',
            'label': 'Ask permission',
          },
        ],
      },
      'notice': {
        'kind': 'notice',
        'message': 'ready',
      },
      'ended': {
        'kind': 'ended',
        'reason': 'completed',
      },
      'error': {
        'kind': 'error',
        'message': 'something failed',
      },
      'draft': {
        'kind': 'draft',
        'text': 'half-typed',
        'at': 1719900000000,
      },
      'ack': {
        'kind': 'ack',
        'ack': 'client-message',
        'clientMessageId': 'cm-1',
      },
      'nack': {
        'kind': 'nack',
        'code': 'CLIENT_MESSAGE_FAILED',
        'message': 'boom',
        'clientMessageId': 'cm-2',
      },
      'attach-conflict': {
        'kind': 'attach-conflict',
        'requestedMode': 'resume',
        'reason': 'app-restore',
        'code': 'DRIVE_OWNERSHIP_CONFLICT',
        'message': 'A terminal owns this session.',
      },
    };

    for (final entry in samples.entries) {
      final decoded = WireEvent.fromJson(entry.value);

      expect(
        decoded,
        isNot(
          isA<UnknownWireEvent>(),
        ),
        reason: 'kind=${entry.key} must not be treated as unknown',
      );
    }

    // Every registry wire frame kind must have a typed sample so a new broker
    // frame kind cannot land without WireEvent coverage.
    expect(
      samples.keys.toSet(),
      brokerWireFrameKinds.toSet(),
      reason: 'WireEvent samples must cover every brokerWireFrameKinds entry',
    );
  });

  test(
    'snapshot canonical message list matches AgentMessageType values',
    () {
      final canonicalMessageTypes = {
        for (final type in AgentMessageType.values)
          if (type != AgentMessageType.unknown) type,
      };
      final snapshotTypes = _canonicalMessageTypesFromSnapshot(
        snapshotSource,
      );

      for (final type in canonicalMessageTypes) {
        expect(
          snapshotTypes,
          contains(type.wireValue),
          reason: 'snapshot missing AgentMessage type: ${type.wireValue}',
        );
      }

      expect(
        snapshotTypes.toSet(),
        canonicalMessageTypes.map((type) => type.wireValue).toSet(),
        reason: 'snapshot and Dart AgentMessageType values must stay aligned',
      );
    },
  );

  test('snapshot contains the broker protocol source marker', () {
    expect(
      snapshotSource,
      contains('@cosyncing/protocol'),
      reason:
          'snapshot should be copied from broker packages/typescript/protocol/src/index.ts',
    );
    expect(
      snapshotSource,
      contains('CANONICAL_MESSAGE_TYPES'),
      reason: 'snapshot should include the broker canonical message list',
    );
  });

  test('snapshot exposes the reviewed Part 3 contract surface', () {
    for (final pattern in <RegExp>[
      RegExp(
        r"type\s+ToolDisplayClass\s*=\s*'execute'\s*\|\s*'edit'"
        r"\s*\|\s*'lookup'\s*\|\s*'other'",
      ),
      RegExp(r'toolClass\?:\s*ToolDisplayClass'),
      RegExp(r'durationMs\?:\s*number'),
      RegExp(r'queued\?:\s*boolean'),
      RegExp(
        r"origin\?:\s*'subagent'\s*\|\s*'exec'\s*\|\s*'vscode'",
      ),
      RegExp(r'parentThreadId\?:\s*string'),
      RegExp(r'nativeId\?:\s*string'),
      RegExp(r'interface\s+ScheduleRecord'),
      RegExp(r'type\s+ScheduleCreate\s*='),
      RegExp(r'interface\s+ScheduleListResponse'),
      RegExp(r'type\s+ScheduleDeleteResponse\s*='),
    ]) {
      expect(
        pattern.hasMatch(snapshotSource),
        isTrue,
        reason: 'snapshot missing reviewed Part 3 contract: $pattern',
      );
    }

    expect(
      _registryFromSnapshot(snapshotSource, 'BROKER_ROUTES'),
      containsAll(<String>['/api/schedules', '/api/schedules/{id}']),
    );
  });

  test(
    'client preserves additive terminal provenance from the broker line',
    () {
      const terminalSync = SessionTerminalSync(
        supported: true,
        syncAvailable: true,
        active: false,
        behind: true,
        presence: TerminalSyncPresence.shared,
        action: TerminalSyncAction.join,
      );

      expect(terminalSync.toJson(), containsPair('presence', 'shared'));
      expect(terminalSync.toJson(), containsPair('action', 'join'));
      expect(terminalSync.toJson(), containsPair('behind', true));
    },
  );

  test('snapshot exposes broker client-prerequisite semantics', () {
    for (final pattern in <RegExp>[
      RegExp(r'interface\s+PlanSemantic'),
      RegExp(r'semantic\?:\s*PlanSemantic'),
      RegExp(r'interactionPolicy\?:\s*\{'),
      RegExp(r'interface\s+MachineSessionIdentity'),
      RegExp(r'interface\s+MachineSessionResolution'),
      RegExp(r'interface\s+ScheduleUpdate'),
      RegExp(r"type\s+ScheduleAction\s*=\s*'pause'"),
    ]) {
      expect(
        pattern.hasMatch(snapshotSource),
        isTrue,
        reason: 'snapshot missing client prerequisite: $pattern',
      );
    }
    expect(brokerWireFrameKinds, contains('history-page'));
    expect(brokerClientMessageKinds, contains('history-page'));
  });

  test('snapshot exposes semantic inbound client methods and fields', () {
    for (final pattern in [
      RegExp(r'interface\s+PromptInput[\s\S]*?\btext:\s*string'),
      RegExp(
        r'interface\s+FileInput[\s\S]*?\bname:\s*string'
        r'[\s\S]*?\bmimeType:\s*string[\s\S]*?\bdata\?:\s*string'
        r'[\s\S]*?\bstagedRef\?:\s*string'
        r'[\s\S]*?\bbrokerPath\?:\s*string',
      ),
      RegExp(
        r'respondPermission\('
        r'\s*requestId:\s*string,\s*decision:\s*PermissionDecision',
      ),
      RegExp(
        r"type:\s*'permission-resolved';[\s\S]*?"
        r"decision:\s*PermissionDecision\s*\|\s*'external'",
      ),
      RegExp(
        r'answerQuestion\?\('
        r'\s*requestId:\s*string,\s*answers:\s*string\[\]\[\]',
      ),
      RegExp(r'rejectQuestion\?\(\s*requestId:\s*string'),
      RegExp(
        r'sendFile\?\(\s*file:\s*FileInput\s*\)',
      ),
      RegExp(
        r'runCommand\?\('
        r'\s*name:\s*string,\s*args\?:\s*string,'
        r'\s*input\?:\s*CommandInput',
      ),
    ]) {
      expect(
        pattern.hasMatch(snapshotSource),
        isTrue,
        reason: 'snapshot missing semantic inbound contract: $pattern',
      );
    }
  });

  test('snapshot does not yet export raw websocket frame unions', () {
    expect(
      snapshotSource,
      isNot(
        contains('type WireEvent'),
      ),
      reason: 'when broker exports WireEvent, update this test to diff it',
    );
    expect(
      snapshotSource,
      isNot(
        contains('type ClientOutboundFrame'),
      ),
      reason: 'when broker exports frame unions, update this test to diff it',
    );
  });

  test('message renderer coverage is explicit for all modeled types', () {
    final canonicalTypes = {
      for (final type in AgentMessageType.values)
        if (type != AgentMessageType.unknown) type,
    };
    final registeredTypes = agentMessageRendererRegistry.keys.toSet();
    final missing = canonicalTypes.difference(registeredTypes);

    expect(
      missing,
      isEmpty,
      reason:
          'non-unknown AgentMessageType values should be in renderer'
          ' registry',
    );

    expect(
      _hasExplicitRendererFallback(),
      isTrue,
      reason:
          'registry fallback is expected for malformed/future message types',
    );
  });

  group('outbound frames', () {
    test(
      'client frame constructors match broker frame kinds and required fields',
      () {
        expect(
          OutboundFrame.prompt('hello'),
          equals({'kind': 'prompt', 'text': 'hello'}),
        );
        expect(
          OutboundFrame.command('run', args: {'model': 'opus'}),
          equals({'kind': 'command', 'name': 'run', 'model': 'opus'}),
        );
        expect(
          OutboundFrame.approve('request-id', 'approve'),
          equals({
            'kind': 'approve',
            'requestId': 'request-id',
            'decision': 'approve',
          }),
        );
        expect(
          OutboundFrame.answer('request-id', [
            ['A'],
          ]),
          equals({
            'kind': 'answer',
            'requestId': 'request-id',
            'answers': [
              ['A'],
            ],
          }),
        );
        expect(
          OutboundFrame.rejectQuestion('request-id'),
          equals({
            'kind': 'reject-question',
            'requestId': 'request-id',
          }),
        );
        expect(
          OutboundFrame.file(
            name: 'notes.txt',
            data: 'SGVsbG8=',
            mimeType: 'text/plain',
          ),
          equals({
            'kind': 'file',
            'name': 'notes.txt',
            'data': 'SGVsbG8=',
            'mimeType': 'text/plain',
          }),
        );
        expect(
          OutboundFrame.ack(attachTicket: 't-1', clientMessageId: 'cm-1'),
          equals({
            'kind': 'ack',
            'attachTicket': 't-1',
            'clientMessageId': 'cm-1',
          }),
        );
        expect(
          OutboundFrame.nack(attachTicket: 't-2'),
          equals({'kind': 'nack', 'attachTicket': 't-2'}),
        );
        expect(
          OutboundFrame.historyPage(
            cursor: 'older:1',
            limit: 100,
            clientMessageId: 'page-1',
          ),
          equals({
            'kind': 'history-page',
            'cursor': 'older:1',
            'limit': 100,
            'clientMessageId': 'page-1',
          }),
        );
      },
    );

    test('client frame constructors stay inside documented frame kinds', () {
      final frames = [
        OutboundFrame.prompt('hello'),
        OutboundFrame.command('run'),
        OutboundFrame.approve('request-id', 'approve'),
        OutboundFrame.answer('request-id', [
          ['A'],
        ]),
        OutboundFrame.rejectQuestion('request-id'),
        OutboundFrame.file(
          name: 'notes.txt',
          data: 'SGVsbG8=',
          mimeType: 'text/plain',
        ),
        OutboundFrame.ack(attachTicket: 't-1'),
        OutboundFrame.nack(attachTicket: 't-2'),
        OutboundFrame.historyPage(cursor: 'older:1'),
        OutboundFrame.draft('draft'),
        OutboundFrame.planAction(
          const PlanActionRequest(
            action: PlanActionKind.approve,
            planKey: 'plan:1',
            planRevision: 'revision:1',
          ),
        ),
        OutboundFrame.artifactInteraction(
          const ArtifactInteractionRequest(
            artifactKey: 'artifact:1',
            interactionRef: 'signed:1',
            interaction: {'type': 'action'},
          ),
        ),
      ];

      // Every emitted kind must be a member of the broker client-message
      // registry; no rogue frames.
      for (final frame in frames) {
        final kind = frame['kind']! as String;
        expect(
          brokerClientMessageKinds,
          contains(kind),
          reason: 'OutboundFrame emits kind outside registry: $kind',
        );
      }
    });
  });

  group('machine-readable registries', () {
    test('snapshot exposes all five broker registries', () {
      for (final name in const [
        'BROKER_ROUTES',
        'BROKER_INTEGRATION_ROUTES',
        'BROKER_ERROR_CODES',
        'BROKER_WIRE_FRAME_KINDS',
        'BROKER_CLIENT_MESSAGE_KINDS',
      ]) {
        expect(
          snapshotSource,
          contains('export const $name = ['),
          reason: 'snapshot missing registry: $name',
        );
      }
    });

    test('Dart registries match snapshot registries', () {
      expect(
        _registryFromSnapshot(
          snapshotSource,
          'BROKER_INTEGRATION_ROUTES',
        ).toSet(),
        brokerIntegrationRoutes.toSet(),
        reason: 'brokerIntegrationRoutes drifted from snapshot',
      );
      expect(
        _registryFromSnapshot(snapshotSource, 'BROKER_ROUTES').toSet(),
        brokerRoutes.toSet(),
        reason: 'brokerRoutes drifted from snapshot BROKER_ROUTES',
      );
      expect(
        _registryFromSnapshot(snapshotSource, 'BROKER_ERROR_CODES').toSet(),
        brokerErrorCodes.toSet(),
        reason: 'brokerErrorCodes drifted from snapshot BROKER_ERROR_CODES',
      );
      expect(
        _registryFromSnapshot(
          snapshotSource,
          'BROKER_WIRE_FRAME_KINDS',
        ).toSet(),
        brokerWireFrameKinds.toSet(),
        reason: 'brokerWireFrameKinds drifted from snapshot',
      );
      expect(
        _registryFromSnapshot(
          snapshotSource,
          'BROKER_CLIENT_MESSAGE_KINDS',
        ).toSet(),
        brokerClientMessageKinds.toSet(),
        reason: 'brokerClientMessageKinds drifted from snapshot',
      );
    });

    test('BROKER_ERROR_CODES has 103 entries and typed control failures', () {
      final codes = _registryFromSnapshot(snapshotSource, 'BROKER_ERROR_CODES');
      expect(codes, hasLength(103));
      expect(codes, isNot(contains('DUPLICATE_CLIENT_MESSAGE_ID')));
      expect(
        codes,
        containsAll(<String>[
          'AUTH_REQUIRED',
          'ACK_INVALID',
          'ACK_CONFLICT',
          'BAD_CLIENT_MESSAGE_ID',
          'ACK_UNKNOWN_TARGET',
          'CLIENT_MESSAGE_FAILED',
          'PAIRING_NOT_FOUND',
          'PAIRING_RATE_LIMITED',
          'DRIVE_OWNERSHIP_CONFLICT',
          'DRIVE_OWNERSHIP_UNKNOWN',
          'DRIVE_NATIVE_SESSION_UNRESUMABLE',
          'DRIVE_RESTORE_FAILED',
          'JOIN_OWNER_NOT_FOUND',
          'JOIN_OWNER_STALE',
          'JOIN_NOT_SUPPORTED',
          'HISTORY_PAGE_RESOURCE_LIMIT',
          // H1b: a source that moved while it was indexed is retriable, and is
          // reported separately from a measured resource limit.
          'HISTORY_PAGE_SOURCE_CHANGED',
          'HISTORY_PAGE_SOURCE_UNVERSIONED',
          'ATTACHMENT_DELIVERY_FAILED',
          'ATTACHMENT_INVALID',
          'ATTACHMENT_LIMIT_EXCEEDED',
          'ATTACHMENT_UNSUPPORTED',
          'STAGED_ATTACHMENT_EXPIRED',
          'STAGED_ATTACHMENT_NOT_FOUND',
          'STAGED_ATTACHMENT_SCOPE_MISMATCH',
          'UPLOAD_CAPACITY',
          'UPLOAD_SCOPE_MISMATCH',
          'MODEL_CATALOG_UNAVAILABLE',
          'MODEL_SELECTION_UNSUPPORTED',
          'SESSION_CREATE_TEMPORARILY_UNAVAILABLE',
          // CR4: a user-initiated fork of an agent-spawned session is a typed
          // 409 refusal, not the generic "native session fork failed" 502.
          'SESSION_AGENT_OWNED',
        ]),
      );
      expect(brokerErrorCodes, hasLength(103));
    });

    test('ack and nack are typed wire frame and client message kinds', () {
      expect(brokerWireFrameKinds, containsAll(<String>['ack', 'nack']));
      expect(
        brokerClientMessageKinds,
        containsAll(<String>['ack', 'nack']),
      );
      expect(
        WireEvent.fromJson({'kind': 'ack', 'ack': 'client-message'}),
        isA<AckWireEvent>(),
      );
      expect(
        WireEvent.fromJson({
          'kind': 'nack',
          'code': 'ACK_UNKNOWN_TARGET',
          'message': 'nope',
        }),
        isA<NackWireEvent>(),
      );
    });
  });
}

bool _sourceContainsQuotedLiteral(String source, String literal) {
  return source.contains("'$literal'") || source.contains('"$literal"');
}

/// Extracts the single-quoted string entries of a broker `as const` registry
/// (e.g. `BROKER_ROUTES`) from the snapshot source.
List<String> _registryFromSnapshot(String source, String name) {
  final match = RegExp(
    '$name\\s*=\\s*\\[([\\s\\S]*?)\\]\\s+as\\s+const',
  ).firstMatch(source);
  expect(match, isNotNull, reason: 'snapshot missing registry: $name');
  final body = match!.group(1)!;
  return RegExp("'([^']+)'").allMatches(body).map((m) => m.group(1)!).toList();
}

List<String> _canonicalMessageTypesFromSnapshot(String source) {
  final match = RegExp(
    r'CANONICAL_MESSAGE_TYPES\s*=\s*\[([\s\S]*?)\]\s+as\s+const',
  ).firstMatch(source);
  expect(match, isNotNull, reason: 'snapshot missing CANONICAL_MESSAGE_TYPES');
  final listBody = match!.group(1)!;
  final values = RegExp("'([^']+)'")
      .allMatches(listBody)
      .map((match) => match.group(1)!)
      .where((value) => _sourceContainsQuotedLiteral(listBody, value))
      .toList();
  expect(values, hasLength(23));
  return values;
}

bool _hasExplicitRendererFallback() {
  final registrySource = File(
    'lib/src/features/sessions/renderers/message_renderer_registry.dart',
  ).readAsStringSync();

  return registrySource.contains(
        'agentMessageRendererRegistry[message.type] ??',
      ) &&
      registrySource.contains('_unknownMessageRenderer');
}

final Map<String, dynamic> _sampleSessionInfo = {
  'id': 'session-1',
  'tool': 'opencode',
  'title': 'Contract fixture session',
  'status': 'idle',
  'attachMode': 'live',
  'control': {
    'drive': {
      'state': 'driving',
      'supported': true,
    },
    'terminalSync': {
      'supported': true,
      'syncAvailable': false,
      'active': false,
    },
  },
};
