import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_controller.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_presentation.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_visibility_action.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_participants.dart';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Rename for tabs; Rename and Hide/Unhide actions for roster rows.
class SessionRenameRegion extends StatelessWidget {
  /// Adds right-click, long-press and accessible rename to [child].
  const SessionRenameRegion({
    required this.tool,
    required this.sessionId,
    required this.title,
    required this.child,
    this.session,
    super.key,
  });

  /// Owning agent.
  final String tool;

  /// Native session identity.
  final String sessionId;

  /// Known title, before presentation placeholders.
  final String title;

  /// Navigation surface whose normal tap remains unchanged.
  final Widget child;

  /// Roster context; tabs retain their existing rename-only behavior.
  final SessionInfo? session;

  Future<void> _rename(BuildContext context) async {
    final ref = ProviderScope.containerOf(context, listen: false);
    final source = RosterSource.of(ref.read(activeBrokerProfileProvider));
    final l10n = AppLocalizations.of(context);
    if (source == null) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(l10n.sessionRenameRequiresServer)));
      return;
    }
    bool current() =>
        context.mounted &&
        RosterSource.of(ref.read(activeBrokerProfileProvider)) == source;
    final next = await WebHandoffParticipants.instance.holdOpen(
      () => showDialog<String>(
        context: context,
        builder: (_) => _RenameDialog(
          initial: knownSessionTitle([title], sessionId: sessionId) ?? '',
        ),
      ),
    );
    if (next == null || !current()) return;
    var message = l10n.sessionRenameRejected;
    try {
      final client = await ref.read(brokerClientProvider.future);
      if (!current()) return;
      if (client == null) {
        message = l10n.sessionRenameRequiresServer;
      } else {
        final result = await client.renameSession(
          tool,
          sessionId,
          next.trim().isEmpty ? null : next.trim(),
        );
        if (!current()) return;
        if (result.ok) {
          final accepted = result.session?.title ?? result.title ?? next.trim();
          ref
              .read(sessionListControllerProvider.notifier)
              .renameSessionTitle(tool, sessionId, accepted);
          await ref.read(openSessionsControllerProvider.future);
          if (!current()) return;
          ref
              .read(openSessionsControllerProvider.notifier)
              .renameSessionTitle(tool, sessionId, accepted);
          final provider = sessionDetailControllerProvider(
            SessionDetailKey(tool: tool, sessionId: sessionId),
          );
          if (ref.exists(provider)) {
            ref.read(provider.notifier).acceptRenamedTitle(source, accepted);
          }
          message = l10n.sessionRenameSucceeded;
        }
      }
    } on BrokerException {
      message = l10n.sessionRenameRejected;
    } on Object {
      message = l10n.failureLeadRenameSession;
    }
    if (!context.mounted || !current()) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _actions(BuildContext context, [Offset? position]) async {
    final info = session;
    if (info == null) return _rename(context);
    final l10n = AppLocalizations.of(context);
    final container = ProviderScope.containerOf(context, listen: false);
    final source = RosterSource.of(container.read(activeBrokerProfileProvider));
    final roster = container.read(sessionListControllerProvider);
    final reason = sessionVisibilityDisabledReason(
      l10n,
      info,
      connected:
          roster.status != SessionListStatus.error &&
          container.read(brokerClientProvider).valueOrNull != null,
    );
    final overlay =
        Overlay.of(context).context.findRenderObject()! as RenderBox;
    final box = context.findRenderObject()! as RenderBox;
    final point =
        position ?? box.localToGlobal(Offset(box.size.width, box.size.height));
    final selected = await showMenu<String>(
      context: context,
      position: RelativeRect.fromRect(
        Rect.fromLTWH(point.dx, point.dy, 0, 0),
        Offset.zero & overlay.size,
      ),
      items: [
        PopupMenuItem(
          value: 'rename',
          child: Text(l10n.sessionDetailRenameTooltip),
        ),
        PopupMenuItem(
          value: 'visibility',
          enabled: reason == null,
          child: Tooltip(
            message: reason ?? '',
            child: Text(
              info.appHidden ?? false ? l10n.sessionUnhide : l10n.sessionHide,
            ),
          ),
        ),
      ],
    );
    if (!context.mounted ||
        RosterSource.of(container.read(activeBrokerProfileProvider)) !=
            source) {
      return;
    }
    if (selected == 'rename') {
      await _rename(context);
    } else if (selected == 'visibility') {
      await changeSessionVisibility(
        context,
        info,
        hidden: info.appHidden != true,
      );
    }
  }

  @override
  Widget build(BuildContext context) => Semantics(
    customSemanticsActions: {
      CustomSemanticsAction(
        label: AppLocalizations.of(context).sessionDetailRenameTooltip,
      ): () =>
          unawaited(_rename(context)),
      if (session != null)
        CustomSemanticsAction(
          label: AppLocalizations.of(context).sessionActionsMenu,
        ): () =>
            unawaited(_actions(context)),
    },
    child: CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.contextMenu): () =>
            unawaited(_actions(context)),
        const SingleActivator(LogicalKeyboardKey.f10, shift: true): () =>
            unawaited(_actions(context)),
      },
      child: GestureDetector(
        behavior: HitTestBehavior.translucent,
        onSecondaryTapUp: (details) =>
            unawaited(_actions(context, details.globalPosition)),
        onLongPress: () => unawaited(_actions(context)),
        child: session == null
            ? child
            : Row(
                children: [
                  Expanded(child: child),
                  IconButton(
                    key: Key('session-actions-$tool-$sessionId'),
                    tooltip: AppLocalizations.of(context).sessionActionsMenu,
                    icon: const StrokeIcon(StrokeGlyph.more),
                    constraints: const BoxConstraints.tightFor(
                      width: 40,
                      height: 40,
                    ),
                    padding: EdgeInsets.zero,
                    style: IconButton.styleFrom(
                      tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                    ),
                    onPressed: () => unawaited(_actions(context)),
                  ),
                ],
              ),
      ),
    ),
  );
}

class _RenameDialog extends StatefulWidget {
  const _RenameDialog({required this.initial});
  final String initial;
  @override
  State<_RenameDialog> createState() => _RenameDialogState();
}

class _RenameDialogState extends State<_RenameDialog> {
  late final _text = TextEditingController(text: widget.initial)
    ..selection = TextSelection(
      baseOffset: 0,
      extentOffset: widget.initial.length,
    );
  bool get _changed => _text.text.trim() != widget.initial.trim();
  @override
  void dispose() {
    _text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    return AlertDialog(
      title: Text(l10n.sessionDetailRenameTooltip),
      content: TextField(
        key: const Key('session-rename-dialog-input'),
        controller: _text,
        autofocus: true,
        decoration: InputDecoration(
          labelText: l10n.sessionDetailRenameFieldLabel,
        ),
        onChanged: (_) => setState(() {}),
        onSubmitted: (_) {
          if (_changed) Navigator.of(context).pop(_text.text);
        },
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: Text(l10n.cancel),
        ),
        TextButton(
          onPressed: _changed
              ? () => Navigator.of(context).pop(_text.text)
              : null,
          child: Text(l10n.save),
        ),
      ],
    );
  }
}
