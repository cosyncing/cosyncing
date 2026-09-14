import 'package:broker_contract/broker_contract.dart';
import 'package:test/test.dart';

void main() {
  group('ListSessionsResponse', () {
    test('fromJson parses machine and sessions', () {
      final json = {
        'machine': 'test-machine',
        'revision': 12,
        'sessions': [
          {
            'id': 'session-1',
            'tool': 'opencode',
            'title': 'Session 1',
            'status': 'idle',
            'attachMode': 'live',
          },
          {
            'id': 'session-2',
            'tool': 'pi',
            'title': 'Session 2',
            'status': 'working',
            'attachMode': 'resume',
          },
        ],
      };

      final response = ListSessionsResponse.fromJson(json);
      expect(response.machine, 'test-machine');
      expect(response.revision, 12);
      expect(response.sessions, hasLength(2));
      expect(response.sessions.first.id, 'session-1');
      expect(response.sessions.last.id, 'session-2');
    });

    test('fromJson handles empty sessions list', () {
      final json = {
        'machine': 'test-machine',
        'sessions': <Map<String, dynamic>>[],
      };

      final response = ListSessionsResponse.fromJson(json);
      expect(response.sessions, isEmpty);
    });

    test('an omitted complete flag reads as a whole roster', () {
      // What a broker older than contract revision 23 sends — revision 22
      // included, since the field arrived with 23. Those brokers never answered
      // ahead of a sweep, so every roster they gave WAS the whole one; reading
      // the absence as "incomplete" would make the client stop trusting
      // removals against every one of them.
      final response = ListSessionsResponse.fromJson({
        'machine': 'test-machine',
        'sessions': <Map<String, dynamic>>[],
      });
      expect(response.complete, isTrue);
    });

    test('an explicit false is carried, and survives a round trip', () {
      final response = ListSessionsResponse.fromJson({
        'machine': 'test-machine',
        'sessions': <Map<String, dynamic>>[],
        'complete': false,
      });
      expect(response.complete, isFalse);
      final round = ListSessionsResponse.fromJson(response.toJson());
      expect(round.complete, isFalse);
    });

    test('a null complete reads as a whole roster rather than throwing', () {
      final response = ListSessionsResponse.fromJson({
        'machine': 'test-machine',
        'sessions': <Map<String, dynamic>>[],
        'complete': null,
      });
      expect(response.complete, isTrue);
    });
  });

  group('CreateSessionResponse', () {
    test('fromJson parses session and attachMode', () {
      final json = {
        'session': {
          'id': 'new-session',
          'tool': 'opencode',
          'title': 'New Session',
          'status': 'idle',
          'attachMode': 'live',
        },
        'attachMode': 'live',
      };

      final response = CreateSessionResponse.fromJson(json);
      expect(response.session.id, 'new-session');
      expect(response.attachMode, 'live');
    });
  });

  group('RenameSessionResponse', () {
    test('fromJson parses ok and title', () {
      final json = {
        'ok': true,
        'title': 'New Title',
      };

      final response = RenameSessionResponse.fromJson(json);
      expect(response.ok, isTrue);
      expect(response.title, 'New Title');
    });

    test('fromJson handles null title', () {
      final json = {
        'ok': true,
        'title': null,
      };

      final response = RenameSessionResponse.fromJson(json);
      expect(response.ok, isTrue);
      expect(response.title, isNull);
    });

    test('fromJson parses optional session', () {
      final json = {
        'ok': true,
        'title': 'New Title',
        'session': {
          'id': 'session-1',
          'tool': 'opencode',
          'title': 'New Title',
          'status': 'idle',
          'attachMode': 'live',
        },
      };

      final response = RenameSessionResponse.fromJson(json);
      expect(response.session, isNotNull);
      expect(response.session!.title, 'New Title');
    });
  });

  group('RenameProjectResponse', () {
    test('round-trips the exact cwd and display alias', () {
      final response = RenameProjectResponse.fromJson({
        'ok': true,
        'cwd': '/repo/project',
        'projectName': 'Release work',
      });

      expect(response.ok, isTrue);
      expect(response.cwd, '/repo/project');
      expect(response.projectName, 'Release work');
      expect(response.toJson(), {
        'ok': true,
        'cwd': '/repo/project',
        'projectName': 'Release work',
      });
    });

    test('allows a reset alias while retaining cwd', () {
      final response = RenameProjectResponse.fromJson({
        'ok': true,
        'cwd': '/repo/project',
        'projectName': null,
      });

      expect(response.cwd, '/repo/project');
      expect(response.projectName, isNull);
    });
  });

  group('ClearSessionCacheResponse', () {
    test('fromJson parses ok and clearedArtifacts', () {
      final json = {
        'ok': true,
        'clearedArtifacts': 5,
      };

      final response = ClearSessionCacheResponse.fromJson(json);
      expect(response.ok, isTrue);
      expect(response.clearedArtifacts, 5);
    });

    test('fromJson handles null clearedArtifacts', () {
      final json = {
        'ok': true,
      };

      final response = ClearSessionCacheResponse.fromJson(json);
      expect(response.ok, isTrue);
      expect(response.clearedArtifacts, isNull);
    });
  });

  group('ForkSessionResponse', () {
    test('fromJson parses ok and session', () {
      final json = {
        'ok': true,
        'session': {
          'id': 'session-2',
          'tool': 'opencode',
          'title': 'Forked Session',
          'status': 'idle',
          'attachMode': 'live',
        },
      };

      final response = ForkSessionResponse.fromJson(json);
      expect(response.ok, isTrue);
      expect(response.session, isNotNull);
      expect(response.session!.id, 'session-2');
      expect(response.session!.title, 'Forked Session');
    });

    test('fromJson handles missing optional session', () {
      final json = {'ok': true};
      final response = ForkSessionResponse.fromJson(json);
      expect(response.ok, isTrue);
      expect(response.session, isNull);
    });
  });

  group('CloneSessionResponse', () {
    test('fromJson parses ok and session', () {
      final json = {
        'ok': true,
        'session': {
          'id': 'session-3',
          'tool': 'opencode',
          'title': 'Cloned Session',
          'status': 'idle',
          'attachMode': 'live',
        },
      };

      final response = CloneSessionResponse.fromJson(json);
      expect(response.ok, isTrue);
      expect(response.session, isNotNull);
      expect(response.session!.id, 'session-3');
    });

    test('fromJson handles missing optional session', () {
      final json = {'ok': false};
      final response = CloneSessionResponse.fromJson(json);
      expect(response.ok, isFalse);
      expect(response.session, isNull);
    });
  });

  group('TranscriptExportPreflightResponse', () {
    test('fromJson parses confirm payload', () {
      final json = {
        'ok': true,
        'nonce': 'nonce-1',
        'expiresAt': 1719000000000,
        'confirm': {
          'action': 'transcriptExport',
          'tool': 'opencode',
          'sessionId': 'session-1',
          'sessionTitle': 'Main Session',
          'format': 'html',
          'redactionMode': 'redacted-full',
          'tier': 'local',
          'retentionMinutes': 5,
          'sizeCapBytes': 5242880,
          'irreversible': false,
          'message': 'Download now',
        },
      };

      final response = TranscriptExportPreflightResponse.fromJson(json);
      expect(response.ok, isTrue);
      expect(response.nonce, 'nonce-1');
      expect(response.expiresAt, 1719000000000);
      expect(response.confirm.format, 'html');
      expect(response.confirm.sizeCapBytes, 5242880);
    });
  });

  group('TranscriptExportResponse', () {
    test('fromJson parses ok and artifact', () {
      final json = {
        'ok': true,
        'artifact': {
          'path': '/artifacts/session-1/transcript.html',
          'name': 'transcript.html',
          'mimeType': 'text/html',
          'size': 2048,
          'fetchUrl': 'https://cdn.example/transcript.html',
          'deliveryClass': 'export-attachment',
          'format': 'html',
          'redactionSummary': 'redacted secrets',
          'expiresAt': 1719000000000,
        },
      };

      final response = TranscriptExportResponse.fromJson(json);
      expect(response.ok, isTrue);
      expect(response.artifact, isNotNull);
      expect(response.artifact!.deliveryClass, 'export-attachment');
      expect(response.artifact!.format, 'html');
      expect(response.artifact!.expiresAt, 1719000000000);
    });

    test('fromJson handles missing optional artifact', () {
      final json = {'ok': false};
      final response = TranscriptExportResponse.fromJson(json);
      expect(response.ok, isFalse);
      expect(response.artifact, isNull);
    });
  });
}
