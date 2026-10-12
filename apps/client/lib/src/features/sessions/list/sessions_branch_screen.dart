import 'package:cosyncing_client/src/app/router/session_routes.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_controller.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/open_session_sync_supervisor.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/sessions_workspace.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/side_pane_scope.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_frame.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_pane_key.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

/// One retained workspace across phone, tablet, and desktop sizes. The roster
/// switches between a modal drawer and a resizable sidebar.
class SessionsBranchScreen extends ConsumerStatefulWidget {
  /// Creates the responsive workspace.
  const SessionsBranchScreen({super.key});
  @override
  ConsumerState<SessionsBranchScreen> createState() =>
      _SessionsBranchScreenState();
}

class _SessionsBranchScreenState extends ConsumerState<SessionsBranchScreen> {
  bool? _wasSideAvailable;
  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final sideAvailable = canShowSidePane(
        MediaQuery.sizeOf(context),
        constraints.maxWidth,
        drawerLayout:
            WorkspaceFrameScope.maybeOf(context)?.drawerLayout ?? false,
      );
      final collapsed = (_wasSideAvailable ?? false) && !sideAvailable;
      _wasSideAvailable = sideAvailable;
      // Files use a drill-in route when the split no longer fits.
      // Sessions retain their workspace, preserving drafts and scroll.
      // Portrait has already left the split. Further narrowing must not
      // open a remembered file over Status / Files chosen since then.
      if (collapsed && !ref.read(workspaceOverviewVisibleProvider)) {
        final active = ref
            .read(openSessionsControllerProvider)
            .valueOrNull
            ?.active;
        if (active != null) {
          final file = ref
              .read(filePanesControllerProvider)
              .valueOrNull
              ?.activeFor(
                SessionDetailKey(tool: active.tool, sessionId: active.id),
              );
          if (file is FilePaneKey) {
            WidgetsBinding.instance.addPostFrameCallback((_) {
              if (!mounted || (_wasSideAvailable ?? true)) return;
              context.go(
                sessionFileLocation(
                  tool: active.tool,
                  sessionId: active.id,
                  path: file.path,
                ),
              );
            });
          }
        }
      }
      return const OpenSessionSyncSupervisor(child: SessionsWorkspace());
    },
  );
}
