import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/session_routes.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_pane_body.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_pane_surface.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_controller.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_pane_key.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

/// The compact drill-in: one session's files, full width.
///
/// Below the split's width there is no room for a third column, and a stacked
/// vertical split is not an option either — the live chat collapses under
/// 360dp of height. So the file becomes a pushed route over the session it
/// belongs to, with the transcript still underneath it on the stack.
///
/// The route only carries which file to open. Everything it shows comes from
/// the same working set the workspace pane reads, so the tab strip here is the
/// same strip, in the same order, with the same active tab.
class SessionFilePage extends ConsumerStatefulWidget {
  /// Opens [path] in [tool]/[sessionId], optionally anchored at [line].
  const SessionFilePage({
    required this.tool,
    required this.sessionId,
    required this.path,
    this.line,
    super.key,
  });

  /// Owning tool.
  final String tool;

  /// Owning session.
  final String sessionId;

  /// The file to show.
  final String path;

  /// Where to land, when a transcript mention carried a line.
  final int? line;

  @override
  ConsumerState<SessionFilePage> createState() => _SessionFilePageState();
}

class _SessionFilePageState extends ConsumerState<SessionFilePage> {
  /// Whether this route's own open has landed in the working set.
  ///
  /// Until it has, an empty working set means "not restored yet", not "nothing
  /// left to show", and leaving on it would bounce the route straight back out
  /// before it ever painted.
  bool _opened = false;

  /// Guards against leaving twice.
  bool _leaving = false;

  SessionDetailKey get _key =>
      SessionDetailKey(tool: widget.tool, sessionId: widget.sessionId);

  @override
  void initState() {
    super.initState();
    // A deep link into this route may name a file the working set has never
    // heard of, so opening it here is what makes the route self-sufficient.
    // Opening an already-open file just activates its tab.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final line = widget.line;
      if (line != null) {
        final pane = FilePaneKey(session: _key, path: widget.path);
        ref
            .read(filePaneAnchorProvider.notifier)
            .update((anchors) => {...anchors, pane.key: line});
      }
      unawaited(
        ref
            .read(filePanesControllerProvider.notifier)
            .open(_key, widget.path)
            .then((
              _,
            ) {
              if (mounted) setState(() => _opened = true);
            }),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return Scaffold(
      key: const Key('session-file-page'),
      appBar: AppBar(
        title: Text(l10n.sessionFilesTitle),
        leading: BackButton(
          key: const Key('session-file-page-back'),
          onPressed: () => _leave(context),
        ),
      ),
      body: SafeArea(
        child: FilePaneSurface(
          session: _key,
          onLastClosed: _opened ? () => _leave(context) : null,
        ),
      ),
    );
  }

  /// Leaves the drill-in for the session it belongs to.
  ///
  /// `pop` when there is something to pop, so Back behaves; `go` otherwise,
  /// which is the deep-link case where this route is the whole stack.
  void _leave(BuildContext context) {
    if (_leaving) return;
    _leaving = true;
    final router = GoRouter.of(context);
    if (router.canPop()) {
      router.pop();
    } else {
      router.go(
        sessionDetailLocation(tool: widget.tool, sessionId: widget.sessionId),
      );
    }
  }
}
