import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_presentation.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_pane_body.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_controller.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_tabs_strip.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_pane_key.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// How a session names itself on a file pane: `codex · refactor auth`.
///
/// The file pane is the one surface in the app that shows a session it is not
/// inside, so it has to name that session the way the tab strip and the detail
/// header do. Never the session id: it is a native fingerprint, it disagrees
/// with every other surface naming the same session, and in the pane header it
/// is the text that gets ellipsised first — leaving `codex · 01JQ…` where the
/// design asked for a name.
///
/// [open] is the opened-sessions working set, the same source the tab strip
/// reads, so the two labels cannot drift apart.
String workspaceSessionLabel({
  required SessionDetailKey session,
  required OpenSessionsState? open,
  required AppLocalizations l10n,
}) {
  final paneKey = SessionPaneKey(session: session).key;
  String? title;
  for (final ref in open?.refs ?? const <SessionRef>[]) {
    if (ref.key != paneKey) continue;
    title = knownSessionTitle([ref.title], sessionId: ref.id);
    break;
  }
  return '${session.tool} · ${title ?? l10n.sessionDetailTitleUntitled}';
}

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
    final l10n = AppLocalizations.of(context);
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
                    sessionLabel: workspaceSessionLabel(
                      session: session,
                      open: ref
                          .watch(openSessionsControllerProvider)
                          .valueOrNull,
                      l10n: l10n,
                    ),
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
