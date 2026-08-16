import 'package:broker_contract/broker_contract.dart';
import 'package:test/test.dart';

void main() {
  group('AgentInfo', () {
    test('fromJson parses new capability flags', () {
      final json = {
        'id': 'opencode',
        'displayName': 'OpenCode',
        'capabilities': {
          'integrationKind': 'http-sse',
          'attachModes': ['live', 'resume', 'observe'],
          'supportsObserve': true,
          'supportsResume': true,
          'supportsLiveAttach': true,
          'supportsCrossClientDriveSharing': true,
          'supportsNativeArtifact': true,
          'supportsNativeFileInput': true,
          'supportsModelSwitch': true,
          'permissionGranularity': 'per-tool',
        },
        'canCreateSession': true,
        'canSelectModelAtCreation': true,
        'canRenameNative': true,
        'canFork': true,
        'canClone': false,
        'canTranscriptExport': true,
        'syncEnabled': true,
      };

      final agent = AgentInfo.fromJson(json);
      expect(agent.id, 'opencode');
      expect(agent.canCreateSession, isTrue);
      expect(agent.canSelectModelAtCreation, isTrue);
      expect(agent.canRenameNative, isTrue);
      expect(agent.canFork, isTrue);
      expect(agent.canClone, isFalse);
      expect(agent.canTranscriptExport, isTrue);
      expect(agent.syncEnabled, isTrue);
      expect(agent.capabilities.supportsCrossClientDriveSharing, isTrue);
    });

    test('fromJson defaults missing capability flags to false', () {
      final json = {
        'id': 'pi',
        'displayName': 'Pi',
        'capabilities': {
          'integrationKind': 'jsonrpc-stdio',
          'attachModes': ['observe', 'resume', 'live'],
          'supportsObserve': true,
          'supportsResume': true,
          'supportsLiveAttach': true,
          'supportsNativeArtifact': true,
          'supportsNativeFileInput': false,
          'supportsModelSwitch': true,
          'permissionGranularity': 'yolo',
        },
        'canCreateSession': false,
      };

      final agent = AgentInfo.fromJson(json);
      expect(
        agent.canSelectModelAtCreation,
        isFalse,
        reason: 'revision-7 broker responses omit this additive capability',
      );
      expect(agent.canRenameNative, isFalse);
      expect(agent.canFork, isFalse);
      expect(agent.canClone, isFalse);
      expect(agent.canTranscriptExport, isFalse);
      expect(
        agent.capabilities.supportsCrossClientDriveSharing,
        isFalse,
      );
    });

    test('fromJson decodes the http-websocket integration kind', () {
      final json = {
        'id': 'kimi',
        'displayName': 'Kimi Code',
        'capabilities': {
          'integrationKind': 'http-websocket',
          'attachModes': ['observe'],
          'supportsObserve': true,
          'supportsResume': false,
          'supportsLiveAttach': false,
          'supportsNativeArtifact': false,
          'supportsNativeFileInput': false,
          'supportsModelSwitch': false,
          'permissionGranularity': 'none',
        },
        'canCreateSession': false,
      };

      final agent = AgentInfo.fromJson(json);
      expect(agent.id, 'kimi');
      expect(
        agent.capabilities.integrationKind,
        IntegrationKind.httpWebsocket,
      );
      expect(agent.capabilities.attachModes, [AttachMode.observe]);
    });

    test(
      'fromJson degrades an unknown integration kind instead of throwing',
      () {
        // A kind added to the broker after this client was built. Decoding must
        // not throw: `/api/agents` is decoded as ONE list, so a thrown row would
        // take the whole roster down and the client would show no agents at all
        // rather than the several it does support.
        final json = {
          'id': 'an-agent-from-the-future',
          'displayName': 'Future Agent',
          'capabilities': {
            'integrationKind': 'a-kind-this-client-has-never-seen',
            'attachModes': ['observe'],
            'supportsObserve': true,
            'supportsResume': false,
            'supportsLiveAttach': false,
            'supportsNativeArtifact': false,
            'supportsNativeFileInput': false,
            'supportsModelSwitch': false,
            'permissionGranularity': 'none',
          },
          'canCreateSession': false,
        };

        final agent = AgentInfo.fromJson(json);
        expect(agent.capabilities.integrationKind, IntegrationKind.unknown);
      },
    );

    test('a roster keeps its known rows when one row has an unknown kind', () {
      // The whole point of the fallback: one undecodable row must cost exactly
      // itself. This is the shape the client actually decodes — a list.
      Map<String, dynamic> row(String id, String kind) => {
        'id': id,
        'displayName': id,
        'capabilities': {
          'integrationKind': kind,
          'attachModes': ['observe'],
          'supportsObserve': true,
          'supportsResume': false,
          'supportsLiveAttach': false,
          'supportsNativeArtifact': false,
          'supportsNativeFileInput': false,
          'supportsModelSwitch': false,
          'permissionGranularity': 'none',
        },
        'canCreateSession': false,
      };

      final roster = [
        row('opencode', 'http-sse'),
        row('a-future-agent', 'a-kind-this-client-has-never-seen'),
        row('claude', 'sdk-callback'),
      ].map(AgentInfo.fromJson).toList();

      expect(roster.length, 3);
      expect(roster[0].capabilities.integrationKind, IntegrationKind.httpSse);
      expect(roster[1].capabilities.integrationKind, IntegrationKind.unknown);
      expect(
        roster[2].capabilities.integrationKind,
        IntegrationKind.sdkCallback,
      );
    });

    test('fromJson defaults canCreateSession to false when missing', () {
      final json = {
        'id': 'pi',
        'displayName': 'Pi',
        'capabilities': {
          'integrationKind': 'jsonrpc-stdio',
          'attachModes': ['observe'],
          'supportsObserve': true,
          'supportsResume': true,
          'supportsLiveAttach': true,
          'supportsNativeArtifact': false,
          'supportsNativeFileInput': false,
          'supportsModelSwitch': true,
          'permissionGranularity': 'yolo',
        },
      };

      final agent = AgentInfo.fromJson(json);
      expect(agent.canCreateSession, isFalse);
    });
  });
}
