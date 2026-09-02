import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_store.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_pane_key.dart';
import 'package:flutter_test/flutter_test.dart';

const _a = SessionDetailKey(tool: 'codex', sessionId: 'a');
const _b = SessionDetailKey(tool: 'claude', sessionId: 'b');

void main() {
  group('WorkspacePaneKey', () {
    test('both kinds round-trip through their persisted form', () {
      const session = SessionPaneKey(session: _a);
      const file = FilePaneKey(session: _a, path: 'lib/main.dart');

      expect(WorkspacePaneKey.fromJson(session.toJson()), session);
      expect(WorkspacePaneKey.fromJson(file.toJson()), file);
      expect(session.key, 'codex/a');
      expect(file.key, 'codex/a#lib/main.dart');
    });

    test('two files in one session are different panes', () {
      const one = FilePaneKey(session: _a, path: 'lib/one.dart');
      const two = FilePaneKey(session: _a, path: 'lib/two.dart');
      expect(one, isNot(two));
      expect(one.key, isNot(two.key));
    });

    test('the same path in two sessions is two panes', () {
      const one = FilePaneKey(session: _a, path: 'lib/main.dart');
      const two = FilePaneKey(session: _b, path: 'lib/main.dart');
      expect(one, isNot(two));
    });

    test('a session pane never equals a file pane', () {
      expect(
        const SessionPaneKey(session: _a),
        isNot(const FilePaneKey(session: _a, path: 'x')),
      );
    });

    test('an absent kind is a session pane, not a dropped row', () {
      // Rows written before this union existed carry no discriminator, and
      // every one of them was a session.
      final restored = WorkspacePaneKey.fromJson({
        'tool': 'codex',
        'id': 'a',
        'title': 'legacy',
      });
      expect(restored, const SessionPaneKey(session: _a));
    });

    test('an unknown kind is dropped, not guessed at', () {
      expect(
        WorkspacePaneKey.fromJson({
          'kind': 'terminal',
          'tool': 'codex',
          'id': 'a',
        }),
        isNull,
      );
    });

    test('a malformed row is dropped rather than half-built', () {
      expect(WorkspacePaneKey.fromJson({'kind': 'session'}), isNull);
      expect(WorkspacePaneKey.fromJson({'tool': '', 'id': 'a'}), isNull);
      expect(
        WorkspacePaneKey.fromJson({'kind': 'file', 'tool': 'c', 'id': 'a'}),
        isNull,
      );
    });
  });

  group('FilePanesState', () {
    FilePanesState opened(List<(SessionDetailKey, String)> files) {
      var state = FilePanesState.empty;
      for (final (session, path) in files) {
        state = state.opened(session, path);
      }
      return state;
    }

    test('working sets are per session', () {
      final state = opened([
        (_a, 'lib/one.dart'),
        (_b, 'lib/other.dart'),
        (_a, 'lib/two.dart'),
      ]);
      expect(state.forSession(_a).map((pane) => pane.path), [
        'lib/one.dart',
        'lib/two.dart',
      ]);
      expect(state.forSession(_b).map((pane) => pane.path), ['lib/other.dart']);
      // Switching the session tab swaps the strip rather than merging them.
      expect(state.activeFor(_a)?.path, 'lib/two.dart');
      expect(state.activeFor(_b)?.path, 'lib/other.dart');
    });

    test('reopening an open file activates it without duplicating it', () {
      final state = opened([
        (_a, 'lib/one.dart'),
        (_a, 'lib/two.dart'),
        (_a, 'lib/one.dart'),
      ]);
      expect(state.forSession(_a), hasLength(2));
      expect(state.activeFor(_a)?.path, 'lib/one.dart');
    });

    test('closing the active file falls to a sibling, not to nothing', () {
      var state = opened([(_a, 'lib/one.dart'), (_a, 'lib/two.dart')]);
      state = state.closed(state.activeFor(_a)!);
      // The split must not collapse under the user while files remain.
      expect(state.isEmpty, isFalse);
      expect(state.activeFor(_a)?.path, 'lib/one.dart');
    });

    test('closing the last file in a session leaves no active entry', () {
      var state = opened([(_a, 'lib/one.dart'), (_b, 'lib/other.dart')]);
      state = state.closed(state.forSession(_a).single);
      expect(state.activeFor(_a), isNull);
      expect(state.forSession(_b), hasLength(1));
      expect(state.isEmpty, isFalse);
    });

    test('closing a session takes its files and nothing else', () {
      var state = opened([
        (_a, 'lib/one.dart'),
        (_b, 'lib/other.dart'),
        (_a, 'lib/two.dart'),
      ]);
      state = state.sessionClosed(_a);
      expect(state.forSession(_a), isEmpty);
      expect(state.activeFor(_a), isNull);
      expect(state.forSession(_b), hasLength(1));
    });

    test('reordering one session leaves every other session alone', () {
      var state = opened([
        (_a, 'one'),
        (_b, 'x'),
        (_a, 'two'),
        (_b, 'y'),
        (_a, 'three'),
      ]);
      state = state.reordered(_a, 2, 0);
      expect(state.forSession(_a).map((pane) => pane.path), [
        'three',
        'one',
        'two',
      ]);
      expect(state.forSession(_b).map((pane) => pane.path), ['x', 'y']);
    });

    test('an out-of-range reorder is a no-op rather than a throw', () {
      final state = opened([(_a, 'one'), (_a, 'two')]);
      expect(state.reordered(_a, 5, 0).forSession(_a), hasLength(2));
      expect(state.reordered(_b, 0, 1).forSession(_a), hasLength(2));
    });

    test('the working set round-trips through persistence', () {
      final state = opened([(_a, 'lib/one.dart'), (_b, 'lib/other.dart')]);
      final restored = FilePanesState.fromJsonString(state.toJsonString());
      expect(restored.forSession(_a).single.path, 'lib/one.dart');
      expect(restored.activeFor(_b)?.path, 'lib/other.dart');
    });

    test("a newer client's rows are dropped, not fatal", () {
      const stored =
          '{"panes":['
          '{"kind":"file","tool":"codex","id":"a","path":"keep.dart"},'
          '{"kind":"terminal","tool":"codex","id":"a","path":"drop"},'
          '{"kind":"session","tool":"codex","id":"a"}'
          '],"active":{}}';
      final restored = FilePanesState.fromJsonString(stored);
      // The unknown kind goes, the session pane is not a file pane, and the
      // one row this client understands survives.
      expect(restored.panes.map((pane) => pane.path), ['keep.dart']);
    });

    test('malformed storage decodes to empty rather than wedging startup', () {
      expect(FilePanesState.fromJsonString('not json').isEmpty, isTrue);
      expect(FilePanesState.fromJsonString('[]').isEmpty, isTrue);
      expect(FilePanesState.fromJsonString('{"panes":7}').isEmpty, isTrue);
    });

    test('a file row inside the sessions array becomes a phantom tab', () {
      // This is why file panes get their own rows rather than a `kind` field
      // in `refs`. OpenSessionsSnapshot decodes every entry through
      // SessionRef.fromJson with no discriminator check, and SessionRef needs
      // only tool and id -- both of which a file row carries. An older client
      // would therefore show a session tab for a session nobody opened.
      // Unknown-kind tolerance protects a reader that has the branch; this
      // reader is already shipped and does not.
      final leaked = OpenSessionsSnapshot.fromJsonString(
        '{"refs":[{"kind":"file","tool":"codex","id":"a","path":"x.dart"}]}',
      );
      expect(leaked.refs, hasLength(1));
      expect(leaked.refs.single.key, 'codex/a');
    });
  });
}
