import 'package:cosyncing_client/src/app/router/session_routes.dart';
import 'package:cosyncing_client/src/design/window_size_class.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/sessions_page.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_controller.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/open_session_sync_supervisor.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/sessions_workspace.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

/// The Sessions destination, resolved by window width.
///
/// Expanded (≥840dp) renders the two-pane [SessionsWorkspace] (roster + tabs
/// + detail); Compact/Medium keep the single-pane [SessionsPage] with today's
/// push detail route. Reads **logical** width, so the text-size control never
/// collapses the two-pane split.
///
/// ## Carrying the open session across a width change
///
/// The two layouts represent "a session is open" differently: Expanded keeps it
/// as the active tab of the working set while the location stays `/sessions`,
/// whereas Compact/Medium push `/sessions/<tool>/<id>`. Nothing used to bridge
/// them, so shrinking the window while a session was open dropped the user back
/// on the bare roster — the location was still `/sessions` and this widget
/// simply swapped in [SessionsPage]. That reads as losing your place.
///
/// On the Expanded → Compact transition we now push the active tab's detail
/// route, so the open session survives the resize.
///
/// The redirect is deliberately bound to the *transition*, not to "compact and
/// something is open". Redirecting on every compact build would make Back
/// unusable: popping the detail route returns to `/sessions`, which would
/// immediately push the detail route again. It would also hijack a cold start
/// at phone width, where landing on the roster is correct.
///
/// See `docs/architecture/client-ui.md`.
class SessionsBranchScreen extends ConsumerStatefulWidget {
  /// Creates the width-aware Sessions destination.
  const SessionsBranchScreen({super.key});

  @override
  ConsumerState<SessionsBranchScreen> createState() =>
      _SessionsBranchScreenState();
}

class _SessionsBranchScreenState extends ConsumerState<SessionsBranchScreen> {
  /// Whether the previous build rendered the two-pane workspace. Null until the
  /// first build, so a cold start never counts as a transition.
  bool? _wasListDetail;

  @override
  Widget build(BuildContext context) {
    final showListDetail = WindowSizeClass.of(context).showListDetail;
    final collapsed = (_wasListDetail ?? false) && !showListDetail;
    _wasListDetail = showListDetail;

    if (collapsed) {
      final open = ref.read(openSessionsControllerProvider).valueOrNull;
      final active = open?.active;
      if (active != null) {
        // Deferred: this runs during build, and go_router rejects navigation
        // from the build phase.
        // A file pane open in the split is what the reader was looking at, so
        // the collapse carries the file rather than the session under it. `go`
        // rather than `push`: go_router builds /sessions -> detail -> file as
        // the stack, so Back still lands on the transcript.
        final file = ref
            .read(filePanesControllerProvider)
            .valueOrNull
            ?.activeFor(
              SessionDetailKey(tool: active.tool, sessionId: active.id),
            );
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (!mounted) return;
          GoRouter.of(context).go(
            file == null
                ? sessionDetailLocation(
                    tool: active.tool,
                    sessionId: active.id,
                  )
                : sessionFileLocation(
                    tool: active.tool,
                    sessionId: active.id,
                    path: file.path,
                  ),
          );
        });
      }
    }

    return OpenSessionSyncSupervisor(
      child: showListDetail ? const SessionsWorkspace() : const SessionsPage(),
    );
  }
}
