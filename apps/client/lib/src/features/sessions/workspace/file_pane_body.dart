import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_viewer_pane.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_file_browser.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_pane_view_memory.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_controller.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_pane_key.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Where a file pane should land, when a mention carried a line.
///
/// Keyed by [FilePaneKey.key] and deliberately not part of the key itself: an
/// anchor is a property of the navigation that opened the tab, not of the tab.
/// Reopening the workspace restores the file, not the jump — which is also why
/// this is never persisted.
final filePaneAnchorProvider = StateProvider<Map<String, int>>((ref) => {});

/// One file pane's own read.
///
/// Deliberately not the browser notifier's `state.preview`. That holds exactly
/// one preview at a time, so a second pane showing a second file would
/// overwrite the first one's — and the Files slot and the file pane would
/// fight over it every time either opened something. A pane's read is a fact
/// about its own path, so it gets its own provider keyed by the pane.
final AutoDisposeFutureProviderFamily<FileViewerContent, FilePaneKey>
filePaneReadProvider = FutureProvider.autoDispose
    .family<FileViewerContent, FilePaneKey>((ref, pane) async {
      final displayName = pane.path.split('/').last;
      final repository = await ref.watch(
        sessionFileBrowserRepositoryProvider.future,
      );
      if (repository == null) {
        // No connection is not a closed gate, but from the pane's side both
        // are "this file cannot be read right now". An empty explanation means
        // the read had none to give; the widget supplies localized copy,
        // because a provider has no BuildContext to translate with.
        return FileViewerGateClosed(
          path: pane.path,
          displayName: displayName,
          explanation: '',
        );
      }

      final FsReadResult read;
      try {
        read = await repository.readFile(pane.session, path: pane.path);
      } on BrokerException catch (e) {
        // Keyed on the broker's error code, not the status: NOT_FOUND on a
        // nested path is this file having moved or been deleted since the tab
        // opened, while the gate being shut is a different fact and must not
        // read as the same thing.
        return switch (e.error?.code) {
          'NOT_FOUND' => FileViewerGone(
            path: pane.path,
            displayName: displayName,
          ),
          _ => FileViewerGateClosed(
            path: pane.path,
            displayName: displayName,
            explanation: e.message,
          ),
        };
      }

      if (!isPreviewableRead(read)) {
        return FileViewerUnsupported(
          path: pane.path,
          displayName: displayName,
          typeLabel: read.mimeType ?? '',
          size: read.size,
        );
      }

      return FileViewerSource(
        preview: SessionFilePreview(
          path: read.path,
          displayName: displayName,
          mimeType: read.mimeType,
          size: read.size,
          limit: read.limit,
          truncated: read.truncated,
          text: decodeSessionFileReadText(read),
        ),
      );
    });

/// The body of the workspace's second pane: one file, read on its own.
class WorkspaceFilePaneBody extends ConsumerWidget {
  /// Shows [pane].
  const WorkspaceFilePaneBody({required this.pane, super.key});

  /// Which file this pane holds.
  final FilePaneKey pane;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    final displayName = pane.path.split('/').last;
    final read = ref.watch(filePaneReadProvider(pane));
    final anchor = ref.watch(filePaneAnchorProvider)[pane.key];
    final content = read.when(
      data: (content) => switch (content) {
        FileViewerGateClosed(explanation: '') => FileViewerGateClosed(
          path: content.path,
          displayName: content.displayName,
          explanation: l10n.sessionFilesRemoteDisabled,
        ),
        FileViewerSource(:final preview) when anchor != null =>
          FileViewerSource(
            preview: SessionFilePreview(
              path: preview.path,
              displayName: preview.displayName,
              mimeType: preview.mimeType,
              size: preview.size,
              limit: preview.limit,
              truncated: preview.truncated,
              text: preview.text,
              anchorLine: anchor,
            ),
          ),
        _ => content,
      },
      // A retry is a re-read, not a state: the loading skeleton is what the
      // pane shows while one is in flight, exactly as on a first open.
      loading: () =>
          FileViewerReading(path: pane.path, displayName: displayName),
      error: (error, _) => FileViewerGone(
        path: pane.path,
        displayName: displayName,
      ),
    );
    // Read once, at mount: the memory is a handoff across a resize, not a
    // binding. Watching it would make every scroll frame a rebuild.
    final memory = ref.read(filePaneViewMemoryProvider);
    return FileViewerPane(
      content: content,
      initialView: memory.read(pane.key),
      onViewChanged: (view) => memory.write(pane.key, view),
      sessionLabel: '${pane.session.tool} · ${pane.session.sessionId}',
      toolColor: tokens.toolColor(pane.session.tool),
      onRetry: () => ref.invalidate(filePaneReadProvider(pane)),
      onClose: () {
        // Closing a file forgets where you were in it: reopening it later is
        // a new read, not a resumed one.
        memory.forget(pane.key);
        ref.read(filePanesControllerProvider.notifier).close(pane).ignore();
      },
    );
  }
}
