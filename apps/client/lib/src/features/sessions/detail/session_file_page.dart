import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/session_routes.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/compact_file_strip.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_pane_body.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_controller.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_pane_key.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

/// Resolves legacy file URLs into the session's shared reader shell.
/// The route never presents a second independent file viewer.
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
  bool _started = false;
  SessionDetailKey get _key =>
      SessionDetailKey(tool: widget.tool, sessionId: widget.sessionId);

  void _open() {
    // A deep link into this route may name a file the working set has never
    // heard of, so opening it here is what makes the route self-sufficient.
    // Opening an already-open file just activates its tab.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final source = RosterSource.of(
        ref.read(activeBrokerProfileProvider),
      )?.storageKey;
      final pane = FilePaneKey(session: _key, path: widget.path);
      ref
          .read(filePaneAnchorProvider.notifier)
          .update((anchors) => {...anchors}..remove(pane.key));
      final line = widget.line;
      if (line != null) {
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
              if (!mounted ||
                  RosterSource.of(
                        ref.read(activeBrokerProfileProvider),
                      )?.storageKey !=
                      source) {
                return;
              }
              final pane = FilePaneKey(session: _key, path: widget.path);
              final opened =
                  ref
                      .read(filePanesControllerProvider)
                      .valueOrNull
                      ?.panes
                      .any((p) => p.key == pane.key) ??
                  false;
              ref.read(compactFileSelectedProvider(_key).notifier).state =
                  opened;
              if (!opened) {
                ScaffoldMessenger.of(context).showSnackBar(
                  SnackBar(
                    content: Text(
                      AppLocalizations.of(context).fileLimitReached,
                    ),
                  ),
                );
              }
              GoRouter.of(context).go(
                sessionDetailLocation(
                  tool: widget.tool,
                  sessionId: widget.sessionId,
                ),
              );
            }),
      );
    });
  }

  @override
  Widget build(BuildContext context) {
    final profile = ref.watch(activeBrokerProfileProvider);
    if (!_started && profile != null) {
      _started = true;
      _open();
    }
    return const Scaffold(body: Center(child: CircularProgressIndicator()));
  }
}
