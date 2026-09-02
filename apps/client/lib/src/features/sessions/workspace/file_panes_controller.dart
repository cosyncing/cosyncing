import 'dart:async';

import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_store.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_focus.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_pane_key.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The open file panes for the active broker source.
///
/// Scoped by `RosterSource.storageKey`, the same key the opened-sessions
/// working set uses: a file pane names a path inside one broker's workspace,
/// so carrying it to another broker would point at a file that may not exist.
class FilePanesController extends AsyncNotifier<FilePanesState> {
  String? _sourceKey;
  Future<void> _tail = Future<void>.value();

  FilePanesStore get _store => ref.read(filePanesStoreProvider);

  @override
  Future<FilePanesState> build() async {
    final source = RosterSource.of(ref.watch(activeBrokerProfileProvider));
    _sourceKey = source?.storageKey;
    final sourceKey = _sourceKey;
    if (sourceKey == null) return FilePanesState.empty;
    return _store.load(sourceKey);
  }

  /// Opens [path] in [session], or activates it when already open.
  Future<void> open(SessionDetailKey session, String path) async {
    await _mutate((current) => current.opened(session, path));
    _followFocus(FilePaneKey(session: session, path: path));
  }

  /// Closes one file pane.
  Future<void> close(FilePaneKey pane) async {
    await _mutate((current) => current.closed(pane));
    _releaseFocus(pane.key);
  }

  /// Makes [pane] the active file within its session.
  Future<void> activate(FilePaneKey pane) async {
    await _mutate((current) => current.activated(pane));
    _followFocus(pane);
  }

  /// Moves one session's file tab from [oldIndex] to [newIndex].
  Future<void> reorder(SessionDetailKey session, int oldIndex, int newIndex) =>
      _mutate((current) => current.reordered(session, oldIndex, newIndex));

  /// Closes every file pane belonging to [session].
  Future<void> closeSession(SessionDetailKey session) async {
    await _mutate((current) => current.sessionClosed(session));
    final sessionKey = SessionPaneKey(session: session).key;
    final focused = ref.read(focusedPaneProvider);
    if (focused != null &&
        isWorkspaceFilePaneKey(focused) &&
        workspacePaneSessionKey(focused) == sessionKey) {
      _releaseFocus(focused);
    }
  }

  /// Keeps a focused file pane pointing at the file it is actually showing.
  ///
  /// Focus moves on a click — that is the whole rule — but the pane's content
  /// can change under a focus that never moved: a transcript link opens a
  /// second file into the pane the reader is already in. Without this the
  /// stored key names a tab that is no longer on top, and the hairline goes
  /// out on a pane that plainly still has focus.
  ///
  /// Deliberately does nothing when the session pane holds focus. Opening a
  /// file from the transcript is a click in the transcript, and the design's
  /// rule is that focus follows the click, not the content.
  void _followFocus(FilePaneKey pane) {
    final notifier = ref.read(focusedPaneProvider.notifier);
    final current = notifier.state;
    if (current == null || !isWorkspaceFilePaneKey(current)) return;
    if (workspacePaneSessionKey(current) != workspacePaneSessionKey(pane.key)) {
      return;
    }
    if (current != pane.key) notifier.state = pane.key;
  }

  /// Hands focus back to the owning session after [paneKey] stops existing.
  ///
  /// Closing the focused file is the one way the focused pane can vanish while
  /// the workspace stays exactly as it was, and nothing else republishes: the
  /// session page's own publish deliberately refuses to take focus off a file
  /// of its session, so without this the hairline would sit on a pane that is
  /// no longer there and the composer would keep explaining a focus the reader
  /// had just closed.
  void _releaseFocus(String paneKey) {
    final notifier = ref.read(focusedPaneProvider.notifier);
    if (notifier.state != paneKey) return;
    notifier.state = workspacePaneSessionKey(paneKey);
  }

  Future<void> _mutate(FilePanesState Function(FilePanesState) change) {
    // Serialized: two rapid opens must not both read the same prior state and
    // write back a set missing one of them.
    final work = _tail.then((_) async {
      // Wait for the restore before mutating. Writing on top of an in-flight
      // build() is silently undone when it resolves and overwrites `state`,
      // and that is not a theoretical window: a deep link into a file opens a
      // pane on its first frame, before the set has finished loading, so the
      // pane it opened would vanish every single time.
      final current = await future;
      final sourceKey = _sourceKey;
      if (sourceKey == null) return;
      final next = change(current);
      state = AsyncData(next);
      await _store.save(sourceKey, next);
    });
    _tail = work.catchError((_) {});
    return work;
  }
}

/// The open file panes for the active broker source.
final filePanesControllerProvider =
    AsyncNotifierProvider<FilePanesController, FilePanesState>(
      FilePanesController.new,
    );
