import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:flutter_test/flutter_test.dart';

SessionInfo _session({
  String tool = 'claude',
  String id = 'abc',
  String title = 'Fix login',
  SessionStatus status = SessionStatus.working,
}) => SessionInfo(
  id: id,
  tool: tool,
  title: title,
  status: status,
  attachMode: AttachMode.observe,
);

void main() {
  group('SessionRef', () {
    test('fromSession copies identity, title and status', () {
      final ref = SessionRef.fromSession(_session());
      expect(ref.tool, 'claude');
      expect(ref.id, 'abc');
      expect(ref.title, 'Fix login');
      expect(ref.status, SessionStatus.working);
      expect(ref.key, 'claude/abc');
    });

    test('fromSession falls back to id when title is empty', () {
      final ref = SessionRef.fromSession(_session(title: ''));
      expect(ref.title, 'abc');
    });

    test('JSON round-trips', () {
      final ref = SessionRef.fromSession(
        _session(status: SessionStatus.needsInput),
      );
      expect(SessionRef.fromJson(ref.toJson()), ref);
    });

    test('value equality includes title and status but key does not', () {
      const base = SessionRef(
        tool: 'codex',
        id: '1',
        title: 'A',
        status: SessionStatus.idle,
      );
      const renamed = SessionRef(
        tool: 'codex',
        id: '1',
        title: 'B',
        status: SessionStatus.idle,
      );
      expect(renamed == base, isFalse);
      expect(renamed.key, base.key);
    });

    group('unknown status (N3 cached identity)', () {
      test('a cached-identity ref makes no status claim', () {
        const ref = SessionRef.cachedIdentity(
          tool: 'codex',
          id: 'abc',
          title: 'Cached session',
        );
        expect(
          ref.status,
          isNull,
          reason: 'the snapshot stores no activity, so neither may the tab',
        );
        expect(ref.key, 'codex/abc');
        expect(ref.toString(), contains('unknown'));
      });

      test('an unknown status is omitted from JSON, not defaulted', () {
        const ref = SessionRef.cachedIdentity(
          tool: 'codex',
          id: 'abc',
          title: 'Cached session',
        );
        final json = ref.toJson();
        expect(
          json.containsKey('status'),
          isFalse,
          reason:
              'persisting `idle` would invent a status this client '
              'never received',
        );
        expect(SessionRef.fromJson(json).status, isNull);
        expect(SessionRef.fromJson(json), ref);
      });

      test('an unrecognised persisted token reads as unknown, not idle', () {
        // A broker newer than this client. Guessing `idle` is how a working
        // session gets drawn as finished.
        final ref = SessionRef.fromJson(const <String, dynamic>{
          'tool': 'codex',
          'id': 'abc',
          'title': 'A',
          'status': 'someFutureState',
        });
        expect(ref.status, isNull);
      });

      test('authoritative metadata replaces the unknown status', () {
        const cached = SessionRef.cachedIdentity(
          tool: 'claude',
          id: 'abc',
          title: 'Cached session',
        );
        final resolved = SessionRef.fromSession(_session());
        expect(cached.key, resolved.key);
        expect(resolved.status, SessionStatus.working);
      });
    });
  });
}
