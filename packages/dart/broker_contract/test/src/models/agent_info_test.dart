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
