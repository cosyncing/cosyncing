import 'dart:async';

import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_store.dart';
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
  Future<void> open(SessionDetailKey session, String path) =>
      _mutate((current) => current.opened(session, path));

  /// Closes one file pane.
  Future<void> close(FilePaneKey pane) =>
      _mutate((current) => current.closed(pane));

  /// Makes [pane] the active file within its session.
  Future<void> activate(FilePaneKey pane) =>
      _mutate((current) => current.activated(pane));

  /// Moves one session's file tab from [oldIndex] to [newIndex].
  Future<void> reorder(SessionDetailKey session, int oldIndex, int newIndex) =>
      _mutate((current) => current.reordered(session, oldIndex, newIndex));

  /// Closes every file pane belonging to [session].
  Future<void> closeSession(SessionDetailKey session) =>
      _mutate((current) => current.sessionClosed(session));

  Future<void> _mutate(FilePanesState Function(FilePanesState) change) {
    // Serialized: two rapid opens must not both read the same prior state and
    // write back a set missing one of them.
    final work = _tail.then((_) async {
      final sourceKey = _sourceKey;
      if (sourceKey == null) return;
      final current = state.valueOrNull ?? FilePanesState.empty;
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
