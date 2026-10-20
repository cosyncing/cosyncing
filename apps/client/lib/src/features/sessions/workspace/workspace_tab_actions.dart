import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_pane_actions.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_controller.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_focus.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_pane_key.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_tab_selection.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Closes only the selected tabs of the focused region, retaining one Undo.
Future<void> closeWorkspaceTabSelection(
  BuildContext context,
  WidgetRef ref, {
  Set<String>? sessionKeys,
}) async {
  if (ModalRoute.of(context)?.isCurrent == false) return;
  final openState = ref.read(openSessionsControllerProvider);
  if (openState.isLoading || openState.hasError) return;
  final open = openState.valueOrNull;
  final source = RosterSource.of(ref.read(activeBrokerProfileProvider));
  final active = open?.active;
  final focused = ref.read(focusedPaneProvider);
  if (sessionKeys == null &&
      active != null &&
      focused != null &&
      isWorkspaceFilePaneKey(focused) &&
      workspacePaneSessionKey(focused) == active.key) {
    final session = SessionDetailKey(tool: active.tool, sessionId: active.id);
    final filesState = ref.read(filePanesControllerProvider);
    if (filesState.isLoading || filesState.hasError) return;
    final files = filesState.valueOrNull;
    final panes = files?.forSession(session) ?? const <SidePaneKey>[];
    final region = 'files:${active.key}';
    final selected = ref.read(workspaceTabSelectionProvider(region)).keys;
    final keys = selected.intersection(panes.map((pane) => pane.key).toSet());
    final closing = panes
        .where(
          (pane) => keys.isEmpty
              ? pane.key == files?.activeFor(session)?.key
              : keys.contains(pane.key),
        )
        .toList();
    ref.read(workspaceTabSelectionProvider(region).notifier).reset();
    await closeWorkspacePanes(context, ref, closing);
    if (context.mounted &&
        source == RosterSource.of(ref.read(activeBrokerProfileProvider)) &&
        ref.read(openSessionsControllerProvider).valueOrNull?.activeKey ==
            active.key) {
      ref.read(focusedPaneProvider.notifier).state =
          ref
              .read(filePanesControllerProvider)
              .valueOrNull
              ?.activeFor(session)
              ?.key ??
          active.key;
    }
    return;
  }
  if (open == null) return;
  final selection =
      sessionKeys ?? ref.read(workspaceTabSelectionProvider('sessions')).keys;
  final keys = selection.intersection(
    open.refs.map((entry) => entry.key).toSet(),
  );
  final closing = keys.isEmpty && sessionKeys == null
      ? {if (open.activeKey != null) open.activeKey!}
      : keys;
  ref.read(workspaceTabSelectionProvider('sessions').notifier).reset();
  final controller = ref.read(openSessionsControllerProvider.notifier);
  final messenger = ScaffoldMessenger.maybeOf(context);
  final l10n = AppLocalizations.of(context);
  final snapshot = await controller.closeSelected(closing);
  if (snapshot == null || !(messenger?.mounted ?? false)) return;
  messenger!.showSnackBar(
    SnackBar(
      content: Text(l10n.workspaceTabsClosed),
      action: SnackBarAction(
        label: l10n.workspaceUndoCloseTabs,
        onPressed: () => controller.restoreClosedTabs(snapshot),
      ),
    ),
  );
}
