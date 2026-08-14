import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('OpenSessionsSnapshot', () {
    test('JSON string round-trips refs and active key', () {
      const snapshot = OpenSessionsSnapshot(
        refs: [
          SessionRef(
            tool: 'claude',
            id: 'a',
            title: 'One',
            status: SessionStatus.working,
          ),
          SessionRef(
            tool: 'codex',
            id: 'b',
            title: 'Two',
            status: SessionStatus.needsInput,
          ),
        ],
        activeKey: 'codex/b',
      );

      final restored = OpenSessionsSnapshot.fromJsonString(
        snapshot.toJsonString(),
      );
      expect(restored.activeKey, 'codex/b');
      expect(restored.refs.map((ref) => ref.key), ['claude/a', 'codex/b']);
      expect(restored.refs.last.status, SessionStatus.needsInput);
    });

    test('malformed JSON decodes to empty (never wedges startup)', () {
      expect(OpenSessionsSnapshot.fromJsonString('not json').refs, isEmpty);
      expect(OpenSessionsSnapshot.fromJsonString('[]').refs, isEmpty);
      expect(OpenSessionsSnapshot.fromJsonString('{}').refs, isEmpty);
      expect(
        OpenSessionsSnapshot.fromJsonString('{}').activeKey,
        isNull,
      );
    });

    test('skips malformed ref entries', () {
      const value =
          '{"active":null,"refs":[42,{"tool":"pi","id":"x",'
          '"title":"X","status":"idle"}]}';
      final restored = OpenSessionsSnapshot.fromJsonString(value);
      expect(restored.refs.map((ref) => ref.key), ['pi/x']);
    });
  });
}
