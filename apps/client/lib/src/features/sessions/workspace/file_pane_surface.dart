import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_pane_body.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_controller.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_tabs_strip.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_pane_key.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// One session's open files: their tab strip, and the active one below it.
///
/// Shared by both faces on purpose. The workspace's second pane and the
/// compact drill-in route are the same surface at two widths, so a change to
/// either — a notice, a renderer, the strip's ordering — has to reach both,
/// and the only way to guarantee that is for there to be one of it.
class FilePaneSurface extends ConsumerWidget {
  /// Shows [session]'s open files.
  const FilePaneSurface({
    required this.session,
    this.onLastClosed,
    super.key,
  });

  /// Whose files these are.
  final SessionDetailKey session;

  /// Called when the last file closes and this surface has nothing to show.
  ///
  /// The split just stops rendering the pane; the compact route has to pop,
  /// since a route showing nothing is a dead end.
  final VoidCallback? onLastClosed;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final tokens = context.tokens;
    final async = ref.watch(filePanesControllerProvider);
    final state = async.valueOrNull;
    final panes = state?.forSession(session) ?? const <FilePaneKey>[];
    final activeFile = state?.activeFor(session);
    final controller = ref.read(filePanesControllerProvider.notifier);

    // `hasValue` matters: the working set is restored asynchronously, so an
    // unguarded emptiness check reads "no files" on the very first frame and
    // would send the compact route straight back out again.
    if (async.hasValue && panes.isEmpty && onLastClosed != null) {
      // Deferred: this runs during build, and a pop from the build phase is
      // rejected the same way a navigation is.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (context.mounted) onLastClosed!();
      });
    }

    return DecoratedBox(
      decoration: BoxDecoration(color: tokens.surface2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          FileTabsStrip(
            panes: panes,
            activeKey: activeFile?.key,
            onSelect: (pane) => unawaited(controller.activate(pane)),
            onClose: (pane) => unawaited(controller.close(pane)),
            onReorder: (oldIndex, newIndex) =>
                unawaited(controller.reorder(session, oldIndex, newIndex)),
          ),
          Expanded(
            child: activeFile == null
                ? const _NoFilesOpen()
                : WorkspaceFilePaneBody(
                    key: ValueKey<String>(activeFile.key),
                    pane: activeFile,
                  ),
          ),
        ],
      ),
    );
  }
}

/// What a session with no open files shows.
///
/// The split does not collapse under the reader when they switch to a session
/// that has opened nothing: the layout they arranged stays where they put it,
/// and the pane says why it is empty. Only closing the last file *anywhere*
/// takes the pane away.
class _NoFilesOpen extends StatelessWidget {
  const _NoFilesOpen();

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    final theme = Theme.of(context);
    return Center(
      key: const Key('file-pane-no-files'),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              l10n.fileViewerNoFilesTitle,
              textAlign: TextAlign.center,
              style: theme.textTheme.titleSmall?.copyWith(
                color: tokens.textPrimary,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 6),
            Text(
              l10n.fileViewerNoFilesBody,
              textAlign: TextAlign.center,
              style: theme.textTheme.bodySmall?.copyWith(
                color: tokens.textSecondary,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
