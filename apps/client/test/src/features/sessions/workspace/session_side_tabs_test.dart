import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_store.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/side_pane_scope.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_pane_key.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  const a = SessionDetailKey(tool: 'claude', sessionId: 'a');
  const b = SessionDetailKey(tool: 'codex', sessionId: 'b');
  const files = SessionPanelKey(session: a, kind: SessionPanelKind.files);
  const status = SessionPanelKey(session: a, kind: SessionPanelKind.status);
  const artifact = ArtifactPaneKey(
    session: a,
    artifactId: 'sent',
    name: 'report.md',
  );
  const workspace = FilePaneKey(session: a, path: 'report.md');
  test('mixed tabs restore, activate and close within their own session', () {
    final state = FilePanesState.empty
        .openedPane(files)
        .openedPane(status)
        .openedPane(artifact)
        .openedPane(workspace)
        .openedPane(
          const SessionPanelKey(session: b, kind: SessionPanelKind.files),
        );
    final restored = FilePanesState.fromJsonString(state.toJsonString());
    expect(restored.forSession(a), [files, status, artifact, workspace]);
    expect(restored.activeFor(a), workspace);
    expect(restored.activated(files).activeFor(a), files);
    expect(restored.closed(workspace).activeFor(a), artifact);
    expect(restored.forSession(b), hasLength(1));
    expect(restored.toJsonString(), isNot(contains('fetchUrl')));
  });
  test('non-file tabs cannot collide with workspace paths', () {
    expect(
      artifact.key,
      isNot(const FilePaneKey(session: a, path: 'artifact:sent').key),
    );
    expect(
      status.key,
      isNot(const FilePaneKey(session: a, path: 'panel:status').key),
    );
    for (final pane in [files, status, artifact, workspace]) {
      expect(workspacePaneSessionKey(pane.key), 'claude/a');
      expect(WorkspacePaneKey.fromJson(pane.toJson()), pane);
    }
  });
  test('only a wide landscape workspace defaults to the right panel', () {
    expect(
      canShowSidePane(const Size(1440, 900), 1100, drawerLayout: false),
      isTrue,
    );
    expect(
      canShowSidePane(const Size(1000, 1400), 800, drawerLayout: false),
      isFalse,
    );
    expect(
      canShowSidePane(const Size(844, 390), 700, drawerLayout: true),
      isFalse,
    );
    expect(
      canShowSidePane(const Size(1440, 900), 480, drawerLayout: false),
      isFalse,
    );
  });
}
