import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_controller.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_tabs_strip.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_pane_key.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Closes one document, with the same Undo action from every opening surface.
Future<void> closeWorkspacePane(
  BuildContext context,
  WidgetRef ref,
  SidePaneKey pane,
) => closeWorkspacePanes(context, ref, [pane]);

/// Closes a selection with one Undo action, preserving pins and reader modes.
Future<void> closeWorkspacePanes(
  BuildContext context,
  WidgetRef ref,
  List<SidePaneKey> panes,
) async {
  if (panes.isEmpty) return;

  final container = ProviderScope.containerOf(context, listen: false);
  final source = RosterSource.of(
    ref.read(activeBrokerProfileProvider),
  )?.storageKey;
  final state = ref.read(filePanesControllerProvider).valueOrNull;
  final controller = ref.read(filePanesControllerProvider.notifier);
  final l10n = AppLocalizations.of(context);
  final messenger = ScaffoldMessenger.maybeOf(context);
  final label = l10n.fileClosed(
    panes.map((pane) => sidePaneLabel(pane, l10n)).join(', '),
  );
  final undo = l10n.workspaceUndoCloseTabs;
  for (final pane in panes) {
    if (RosterSource.of(
          container.read(activeBrokerProfileProvider),
        )?.storageKey !=
        source) {
      return;
    }
    await controller.close(pane);
  }
  if (!(messenger?.mounted ?? false)) return;
  messenger!.showSnackBar(
    SnackBar(
      content: Text(label),
      action: SnackBarAction(
        label: undo,
        onPressed: () {
          if (RosterSource.of(
                container.read(activeBrokerProfileProvider),
              )?.storageKey ==
              source) {
            for (final pane in panes) {
              unawaited(
                controller.reopen(
                  pane,
                  pinned: state?.pinned.contains(pane.key) ?? false,
                  mode: state?.modes[pane.key],
                ),
              );
            }
          }
        },
      ),
    ),
  );
}
