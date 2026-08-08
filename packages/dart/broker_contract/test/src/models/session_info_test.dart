import 'package:broker_contract/broker_contract.dart';
import 'package:test/test.dart';

void main() {
  group('SessionInfo', () {
    test('fromJson parses all fields', () {
      final json = {
        'id': 'session-1',
        'lineageId': 'lineage-1',
        'liveUuid': 'live-123',
        'tool': 'opencode',
        'machine': 'test-machine',
        'title': 'Test Session',
        'slug': 'test-session',
        'cwd': '/workspace/project',
        'projectName': 'My Project',
        'origin': 'subagent',
        'parentThreadId': 'parent-native-id',
        'nativeId': 'child-native-id',
        'status': 'idle',
        'attachMode': 'live',
        'model': 'claude-sonnet-4-6',
        'currentModel': {
          'providerID': 'anthropic',
          'modelID': 'claude-sonnet-4-6',
          'label': 'Sonnet 4.6',
        },
        'currentAgent': 'build',
        'currentMode': 'default',
        'createdAt': 1719000000000,
        'updatedAt': 1719000000000,
        'control': {
          'drive': {
            'state': 'observing',
            'supported': true,
            'willFork': true,
          },
          'terminalSync': {
            'supported': true,
            'syncAvailable': true,
            'active': true,
            'label': 'Synced',
          },
        },
      };

      final session = SessionInfo.fromJson(json);
      expect(session.id, 'session-1');
      expect(session.lineageId, 'lineage-1');
      expect(session.liveUuid, 'live-123');
      expect(session.tool, 'opencode');
      expect(session.machine, 'test-machine');
      expect(session.title, 'Test Session');
      expect(session.origin, SessionOrigin.subagent);
      expect(session.parentThreadId, 'parent-native-id');
      expect(session.nativeId, 'child-native-id');
      expect(session.status, SessionStatus.idle);
      expect(session.attachMode, AttachMode.live);
      expect(session.currentModel?.label, 'Sonnet 4.6');
      expect(session.control, isNotNull);
      expect(session.control!.drive.state, DriveState.observing);
      expect(session.control!.drive.willFork, isTrue);
      expect(session.control!.terminalSync.active, isTrue);
    });

    test('fromJson handles null fields', () {
      final json = {
        'id': 'session-1',
        'tool': 'opencode',
        'title': 'Test Session',
        'status': 'idle',
        'attachMode': 'live',
      };

      final session = SessionInfo.fromJson(json);
      expect(session.id, 'session-1');
      expect(session.launchSurface, isNull);
      expect(session.lineageId, isNull);
      expect(session.machine, isNull);
      expect(session.cwd, isNull);
      expect(session.origin, isNull);
      expect(session.parentThreadId, isNull);
      expect(session.nativeId, isNull);
      expect(session.control, isNull);
    });

    test(
      'launch surface and terminal provenance enums decode and tolerate '
      'unknowns',
      () {
        final known = SessionInfo.fromJson({
          'id': 'session-1',
          'tool': 'opencode',
          'title': 'Terminal Provenance',
          'status': 'idle',
          'attachMode': 'live',
          'launchSurface': 'app',
          'control': {
            'drive': {'state': 'driving', 'supported': true},
            'terminalSync': {
              'supported': true,
              'syncAvailable': false,
              'active': false,
              'presence': 'private',
              'action': 'handoff',
              'behind': false,
            },
          },
        });
        final roundTrip = SessionInfo.fromJson(known.toJson());
        final unknown = SessionInfo.fromJson(
          {
            'id': 'session-2',
            'tool': 'opencode',
            'title': 'Future enums',
            'status': 'idle',
            'attachMode': 'live',
            'launchSurface': 'future-surface',
            'control': {
              'drive': {'state': 'unavailable', 'supported': false},
              'terminalSync': {
                'supported': true,
                'syncAvailable': false,
                'active': false,
                'presence': 'future',
                'action': 'future',
              },
            },
          },
        );

        expect(known.launchSurface, SessionLaunchSurface.app);
        expect(
          known.control?.terminalSync.presence,
          TerminalSyncPresence.private,
        );
        expect(known.control?.terminalSync.action, TerminalSyncAction.handoff);
        expect(known.control?.terminalSync.behind, isFalse);
        expect(roundTrip.launchSurface, SessionLaunchSurface.app);

        expect(unknown.launchSurface, SessionLaunchSurface.unknown);
        expect(
          unknown.control?.terminalSync.presence,
          TerminalSyncPresence.unknown,
        );
        expect(
          unknown.control?.terminalSync.action,
          TerminalSyncAction.unknown,
        );
      },
    );

    test('parses known origins and fails open on future origins', () {
      SessionInfo parseOrigin(String origin) => SessionInfo.fromJson({
        'id': 'session-$origin',
        'tool': 'opencode',
        'title': 'Test Session',
        'status': 'idle',
        'attachMode': 'live',
        'origin': origin,
      });

      expect(parseOrigin('subagent').origin, SessionOrigin.subagent);
      expect(parseOrigin('exec').origin, SessionOrigin.exec);
      expect(parseOrigin('vscode').origin, SessionOrigin.vscode);
      expect(parseOrigin('future-origin').origin, SessionOrigin.unknown);
    });

    test('fromJson parses session status values', () {
      final workingJson = {
        'id': '1',
        'tool': 't',
        'title': 'T',
        'status': 'working',
        'attachMode': 'live',
      };
      expect(SessionInfo.fromJson(workingJson).status, SessionStatus.working);

      final needsInputJson = {
        'id': '1',
        'tool': 't',
        'title': 'T',
        'status': 'needs-input',
        'attachMode': 'live',
      };
      expect(
        SessionInfo.fromJson(needsInputJson).status,
        SessionStatus.needsInput,
      );
    });

    test('fromJson parses attach mode values', () {
      final liveJson = {
        'id': '1',
        'tool': 't',
        'title': 'T',
        'status': 'idle',
        'attachMode': 'live',
      };
      expect(SessionInfo.fromJson(liveJson).attachMode, AttachMode.live);

      final resumeJson = {
        'id': '1',
        'tool': 't',
        'title': 'T',
        'status': 'idle',
        'attachMode': 'resume',
      };
      expect(SessionInfo.fromJson(resumeJson).attachMode, AttachMode.resume);

      final observeJson = {
        'id': '1',
        'tool': 't',
        'title': 'T',
        'status': 'idle',
        'attachMode': 'observe',
      };
      expect(SessionInfo.fromJson(observeJson).attachMode, AttachMode.observe);
    });

    test('roundtrip serialization', () {
      final json = {
        'id': 'session-1',
        'lineageId': 'lineage-1',
        'liveUuid': 'live-123',
        'tool': 'opencode',
        'machine': 'test-machine',
        'title': 'Test Session',
        'origin': 'exec',
        'parentThreadId': 'parent-native-id',
        'nativeId': 'native-id',
        'status': 'idle',
        'attachMode': 'live',
        'control': {
          'drive': {
            'state': 'observing',
            'supported': true,
            'willFork': false,
          },
          'terminalSync': {
            'supported': true,
            'syncAvailable': true,
            'active': true,
          },
        },
      };

      final session = SessionInfo.fromJson(json);
      final restored = SessionInfo.fromJson(session.toJson());
      expect(restored.id, session.id);
      expect(restored.lineageId, session.lineageId);
      expect(restored.liveUuid, session.liveUuid);
      expect(restored.tool, session.tool);
      expect(restored.title, session.title);
      expect(restored.origin, SessionOrigin.exec);
      expect(restored.parentThreadId, 'parent-native-id');
      expect(restored.nativeId, 'native-id');
      expect(restored.status, session.status);
      expect(restored.attachMode, session.attachMode);
      expect(restored.control!.drive.willFork, isFalse);
    });

    test('tolerates unknown fields', () {
      final json = {
        'id': 'session-1',
        'tool': 'opencode',
        'title': 'Test Session',
        'status': 'idle',
        'attachMode': 'live',
        'unknownField': 'should be ignored',
        'anotherUnknown': 42,
      };

      final session = SessionInfo.fromJson(json);
      expect(session.id, 'session-1');
    });
  });

  group('SessionControlState', () {
    test('fromJson parses drive and terminalSync', () {
      final json = {
        'drive': {
          'state': 'driving',
          'supported': true,
          'reason': 'User is driving',
        },
        'terminalSync': {
          'supported': true,
          'syncAvailable': true,
          'active': false,
          'label': 'Not synced',
        },
      };

      final control = SessionControlState.fromJson(json);
      expect(control.drive.state, DriveState.driving);
      expect(control.drive.supported, isTrue);
      expect(control.drive.reason, 'User is driving');
      expect(control.terminalSync.active, isFalse);
    });
  });
}
