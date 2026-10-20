import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_pane_actions.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_controller.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_tabs_strip.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_focus.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_pane_key.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_tab_actions.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_tab_selection.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

IconData _pinIcon(bool pinned) =>
    pinned ? Icons.push_pin : Icons.push_pin_outlined;

/// Presentation selection, reset when switching broker sources.
final StateProviderFamily<bool, SessionDetailKey> compactFileSelectedProvider =
    StateProvider.family<bool, SessionDetailKey>((ref, session) {
      ref.watch(activeBrokerProfileProvider);
      return false;
    });

/// A single 40dp row preserving document access while the phone shows chat.
class CompactFileStrip extends ConsumerWidget {
  /// Creates the shared compact navigation strip.
  const CompactFileStrip({
    required this.session,
    required this.reading,
    required this.chatSelected,
    required this.onChat,
    required this.onRead,
    required this.onBrowse,
    this.filesSelected = false,
    super.key,
  });

  /// Session owning these documents.
  final SessionDetailKey session;

  /// Whether a document currently fills the main body.
  final bool reading;

  /// Chat is the selected destination rather than another session view.
  final bool chatSelected;

  /// Whether the directory browser is the selected destination.
  final bool filesSelected;

  /// Returns to the retained chat and composer.
  final VoidCallback onChat;

  /// Shows the selected document.
  final VoidCallback onRead;

  /// Returns to the retained directory listing.
  final VoidCallback onBrowse;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final loaded = ref.watch(filePanesControllerProvider);
    final state = loaded.isLoading || loaded.hasError
        ? null
        : loaded.valueOrNull;
    final panes =
        state
            ?.forSession(session)
            .where((p) => p is! SessionPanelKey)
            .toList() ??
        [];
    final ordered = [
      ...panes.where((p) => state!.pinned.contains(p.key)),
      ...panes.where((p) => !state!.pinned.contains(p.key)),
    ];
    final region = 'files:${SessionPaneKey(session: session).key}';
    final selection = ref.watch(workspaceTabSelectionProvider(region)).keys;
    final l10n = AppLocalizations.of(context);
    final t = context.tokens;
    final iconNavigation = MediaQuery.sizeOf(context).width < 600;
    final controller = ref.read(filePanesControllerProvider.notifier);
    final source = RosterSource.of(
      ref.watch(activeBrokerProfileProvider),
    )?.storageKey;
    return WorkspaceTabSelectionRegion(
      region: region,
      activeKey: state?.activeFor(session)?.key,
      child: SizedBox(
        height: 40,
        child: Row(
          children: [
            Tooltip(
              message: l10n.sessionViewChat,
              excludeFromSemantics: iconNavigation,
              child: TextButton(
                key: const Key('compact-chat'),
                onPressed: onChat,
                style: TextButton.styleFrom(
                  backgroundColor: chatSelected ? t.surface2 : null,
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(t.radiusSm),
                  ),
                  minimumSize: const Size(40, 40),
                  padding: const EdgeInsets.symmetric(horizontal: 8),
                ),
                child: Semantics(
                  label: iconNavigation ? l10n.sessionViewChat : null,
                  selected: chatSelected,
                  child: iconNavigation
                      ? const StrokeIcon(StrokeGlyph.chat, size: 20)
                      : Text(
                          l10n.sessionViewChat,
                          style: Theme.of(context).textTheme.labelSmall,
                        ),
                ),
              ),
            ),
            Expanded(
              child: ListView(
                scrollDirection: Axis.horizontal,
                children: [
                  for (final pane in ordered)
                    ColoredBox(
                      key: ValueKey(pane.key),
                      color: selection.contains(pane.key)
                          ? t.surfaceHover
                          : t.canvas,
                      child: _CompactFileTab(
                        pane: pane,
                        pinned: state!.pinned.contains(pane.key),
                        grouped: selection.contains(pane.key),
                        selected:
                            reading &&
                            state.activeFor(session)?.key == pane.key,
                        onTap: () {
                          final activate = ref
                              .read(
                                workspaceTabSelectionProvider(region).notifier,
                              )
                              .select(
                                pane.key,
                                ordered.map((pane) => pane.key).toList(),
                                state.activeFor(session)?.key,
                              );
                          ref
                              .read(focusedPaneProvider.notifier)
                              .state = activate
                              ? pane.key
                              : state.activeFor(session)?.key ?? pane.key;
                          if (activate) {
                            unawaited(controller.activate(pane));
                            onRead();
                          }
                        },
                      ),
                    ),
                ],
              ),
            ),
            if (selection.length > 1)
              Semantics(
                liveRegion: true,
                child: IconButton(
                  key: const Key('compact-file-close-selected-tabs'),
                  tooltip: l10n.workspaceCloseSelectedTabs(selection.length),
                  onPressed: () =>
                      unawaited(closeWorkspaceTabSelection(context, ref)),
                  icon: const StrokeIcon(StrokeGlyph.close, size: 16),
                ),
              ),
            TextButton(
              key: const Key('compact-manage-files'),
              style: TextButton.styleFrom(
                backgroundColor: filesSelected ? t.surface2 : null,
                minimumSize: const Size(40, 40),
                padding: const EdgeInsets.symmetric(horizontal: 8),
              ),
              onPressed: panes.isEmpty
                  ? onBrowse
                  : () => showModalBottomSheet<void>(
                      context: context,
                      isScrollControlled: true,
                      builder: (context) => Consumer(
                        builder: (context, ref, _) {
                          if (RosterSource.of(
                                ref.watch(activeBrokerProfileProvider),
                              )?.storageKey !=
                              source) {
                            WidgetsBinding.instance.addPostFrameCallback((_) {
                              if (context.mounted) Navigator.pop(context);
                            });
                            return const SizedBox.shrink();
                          }
                          final loading = ref.watch(
                            filePanesControllerProvider,
                          );
                          final current = loading.isLoading || loading.hasError
                              ? null
                              : loading.valueOrNull;
                          final files =
                              current
                                  ?.forSession(session)
                                  .where((p) => p is! SessionPanelKey)
                                  .toList() ??
                              [];
                          final pinned = files
                              .where((p) => current!.pinned.contains(p.key))
                              .toList();
                          final unpinned = files
                              .where((p) => !current!.pinned.contains(p.key))
                              .toList();
                          final arranged = [...pinned, ...unpinned];
                          void move(SidePaneKey pane, int direction) {
                            final group = current!.pinned.contains(pane.key)
                                ? pinned
                                : unpinned;
                            final index = group.indexOf(pane);
                            final target = index + direction;
                            if (target < 0 || target >= group.length) return;
                            final all = current.forSession(session);
                            final from = all.indexOf(pane);
                            final to = all.indexOf(group[target]);
                            unawaited(
                              controller.reorder(
                                session,
                                from,
                                to,
                              ),
                            );
                          }

                          return SafeArea(
                            child: ConstrainedBox(
                              constraints: BoxConstraints(
                                maxHeight:
                                    MediaQuery.sizeOf(context).height * .7,
                              ),
                              child: Column(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  ListTile(
                                    title: Text(l10n.fileManage),
                                    trailing: Row(
                                      mainAxisSize: MainAxisSize.min,
                                      children: [
                                        PopupMenuButton<bool>(
                                          key: const Key(
                                            'compact-file-actions',
                                          ),
                                          tooltip: l10n.fileManage,
                                          icon: const Icon(Icons.more_vert),
                                          onSelected: (othersOnly) {
                                            final active = current
                                                ?.activeFor(session)
                                                ?.key;
                                            final closing = unpinned
                                                .where(
                                                  (p) =>
                                                      !othersOnly ||
                                                      p.key != active,
                                                )
                                                .toList();
                                            Navigator.pop(context);
                                            unawaited(
                                              closeWorkspacePanes(
                                                context,
                                                ref,
                                                closing,
                                              ),
                                            );
                                          },
                                          itemBuilder: (context) => [
                                            PopupMenuItem(
                                              value: true,
                                              child: Text(l10n.fileCloseOthers),
                                            ),
                                            PopupMenuItem(
                                              value: false,
                                              child: Text(
                                                l10n.fileCloseUnpinned,
                                              ),
                                            ),
                                          ],
                                        ),
                                        IconButton(
                                          tooltip: l10n.close,
                                          key: const Key('compact-files-close'),
                                          onPressed: () =>
                                              Navigator.pop(context),
                                          icon: const Icon(Icons.close),
                                        ),
                                      ],
                                    ),
                                  ),
                                  ListTile(
                                    leading: const Icon(Icons.folder_open),
                                    title: Text(l10n.sessionViewFiles),
                                    onTap: () {
                                      Navigator.pop(context);
                                      onBrowse();
                                    },
                                  ),
                                  Flexible(
                                    child: ListView(
                                      shrinkWrap: true,
                                      children: [
                                        for (final pane in arranged) ...[
                                          if (pane == pinned.firstOrNull)
                                            SectionHeader(
                                              l10n.filePinned,
                                              padding:
                                                  const EdgeInsets.fromLTRB(
                                                    16,
                                                    8,
                                                    16,
                                                    4,
                                                  ),
                                            ),
                                          if (pane == unpinned.firstOrNull)
                                            SectionHeader(
                                              l10n.fileOtherOpen,
                                              padding:
                                                  const EdgeInsets.fromLTRB(
                                                    16,
                                                    8,
                                                    16,
                                                    4,
                                                  ),
                                            ),
                                          ListTile(
                                            selected:
                                                reading &&
                                                current
                                                        ?.activeFor(session)
                                                        ?.key ==
                                                    pane.key,
                                            title: Text(
                                              sidePaneLabel(pane, l10n),
                                              maxLines: 1,
                                              overflow: TextOverflow.ellipsis,
                                            ),
                                            subtitle: pane is FilePaneKey
                                                ? Text(
                                                    pane.path,
                                                    maxLines: 1,
                                                    overflow:
                                                        TextOverflow.ellipsis,
                                                  )
                                                : null,
                                            onTap: () {
                                              unawaited(
                                                controller.activate(pane),
                                              );
                                              Navigator.pop(context);
                                              onRead();
                                            },
                                            trailing: Row(
                                              mainAxisSize: MainAxisSize.min,
                                              children: [
                                                IconButton(
                                                  tooltip:
                                                      current!.pinned.contains(
                                                        pane.key,
                                                      )
                                                      ? l10n.fileUnpin
                                                      : l10n.filePin,
                                                  icon: Icon(
                                                    _pinIcon(
                                                      current.pinned.contains(
                                                        pane.key,
                                                      ),
                                                    ),
                                                    color: t.textSecondary,
                                                    size: 18,
                                                  ),
                                                  onPressed: () => unawaited(
                                                    controller.togglePin(pane),
                                                  ),
                                                ),
                                                PopupMenuButton<int>(
                                                  tooltip: l10n.fileManage,
                                                  icon: const Icon(
                                                    Icons.more_vert,
                                                    size: 18,
                                                  ),
                                                  onSelected: (direction) =>
                                                      move(pane, direction),
                                                  itemBuilder: (context) {
                                                    final group =
                                                        current.pinned.contains(
                                                          pane.key,
                                                        )
                                                        ? pinned
                                                        : unpinned;
                                                    final index = group.indexOf(
                                                      pane,
                                                    );
                                                    return [
                                                      PopupMenuItem(
                                                        value: -1,
                                                        enabled: index > 0,
                                                        child: Text(
                                                          l10n.fileMoveEarlier,
                                                        ),
                                                      ),
                                                      PopupMenuItem(
                                                        value: 1,
                                                        enabled:
                                                            index <
                                                            group.length - 1,
                                                        child: Text(
                                                          l10n.fileMoveLater,
                                                        ),
                                                      ),
                                                    ];
                                                  },
                                                ),
                                                IconButton(
                                                  tooltip: l10n.close,
                                                  icon: const Icon(
                                                    Icons.close,
                                                    size: 18,
                                                  ),
                                                  onPressed: () => unawaited(
                                                    closeWorkspacePane(
                                                      context,
                                                      ref,
                                                      pane,
                                                    ),
                                                  ),
                                                ),
                                              ],
                                            ),
                                          ),
                                        ],
                                      ],
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          );
                        },
                      ),
                    ),
              child: Tooltip(
                message: l10n.sessionViewFiles,
                excludeFromSemantics: iconNavigation,
                child: Semantics(
                  label: iconNavigation ? l10n.sessionViewFiles : null,
                  selected: filesSelected,
                  child: iconNavigation
                      ? Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const StrokeIcon(StrokeGlyph.folder, size: 20),
                            if (panes.isNotEmpty) ...[
                              const SizedBox(width: 4),
                              Text(
                                MaterialLocalizations.of(
                                  context,
                                ).formatDecimal(panes.length),
                                style: Theme.of(context).textTheme.labelSmall,
                              ),
                            ],
                          ],
                        )
                      : Text(
                          panes.isEmpty
                              ? l10n.sessionViewFiles
                              : '${l10n.sessionViewFiles} ${panes.length}',
                          style: Theme.of(context).textTheme.labelSmall,
                        ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _CompactFileTab extends StatefulWidget {
  const _CompactFileTab({
    required this.pane,
    required this.pinned,
    required this.selected,
    required this.grouped,
    required this.onTap,
  });
  final SidePaneKey pane;
  final bool pinned;
  final bool selected;
  final bool grouped;
  final VoidCallback onTap;
  @override
  State<_CompactFileTab> createState() => _CompactFileTabState();
}

class _CompactFileTabState extends State<_CompactFileTab> {
  void _reveal() {
    if (widget.selected) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) Scrollable.ensureVisible(context, alignment: .5);
      });
    }
  }

  @override
  void initState() {
    super.initState();
    _reveal();
  }

  @override
  void didUpdateWidget(covariant _CompactFileTab old) {
    super.didUpdateWidget(old);
    if (old.selected != widget.selected) _reveal();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tokens;
    return Semantics(
      selected: widget.grouped,
      value: widget.selected
          ? AppLocalizations.of(context).workspaceActiveTab
          : null,
      child: Tooltip(
        message: widget.pane is FilePaneKey
            ? (widget.pane as FilePaneKey).path
            : sidePaneLabel(widget.pane, AppLocalizations.of(context)),
        child: InkWell(
          onTap: () {
            focusWorkspaceTabSelection(context);
            widget.onTap();
          },
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 8),
            constraints: const BoxConstraints(maxWidth: 176),
            decoration: BoxDecoration(
              color: widget.selected ? t.surface2 : null,
              border: Border(
                bottom: BorderSide(
                  width: 2,
                  color: widget.selected
                      ? t.accent
                      : t.surface.withValues(alpha: 0),
                ),
              ),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (widget.pinned) ...[
                  Icon(
                    Icons.push_pin_outlined,
                    size: 12,
                    color: t.textSecondary,
                  ),
                  const SizedBox(width: 4),
                ],
                Flexible(
                  child: Text(
                    sidePaneLabel(widget.pane, AppLocalizations.of(context)),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
