import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_focus.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_pane_key.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_tab_actions.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_tab_selection.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Height of the file pane's own tab strip.
const double fileTabStripHeight = 32;

/// Width of the rail shown in place of a collapsed file pane.
const double workspaceDocumentRailWidth = 44;

/// The right panel's tabs: files, delivered artifacts, and session views.
/// Session tabs remain in the main strip. File previews carry a read-only
/// marker; Status and Files keep their own available actions.
class FileTabsStrip extends ConsumerWidget {
  /// Creates the strip for one session's open files.
  const FileTabsStrip({
    required this.panes,
    required this.activeKey,
    required this.onSelect,
    required this.onClose,
    required this.onReorder,
    super.key,
  });

  /// The active session's open files, in strip order.
  final List<SidePaneKey> panes;

  /// The [SidePaneKey.key] of the shown file.
  final String? activeKey;

  /// Selects one file.
  final ValueChanged<SidePaneKey> onSelect;

  /// Closes one file.
  final ValueChanged<SidePaneKey> onClose;

  /// Moves a tab within this session's strip.
  ///
  /// `onReorderItem` semantics: `newIndex` is already adjusted for the removal
  /// at `oldIndex`, so it is the destination index in the resulting list.
  final void Function(int oldIndex, int newIndex) onReorder;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final sessionKey = panes.isEmpty
        ? ''
        : workspacePaneSessionKey(panes.first.key);
    final region = 'files:$sessionKey';
    final selected = ref.watch(workspaceTabSelectionProvider(region)).keys;
    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    return WorkspaceTabSelectionRegion(
      region: region,
      activeKey: activeKey,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: tokens.surface,
          border: Border(bottom: BorderSide(color: tokens.separator)),
        ),
        child: SizedBox(
          height: fileTabStripHeight,
          child: Row(
            children: [
              Expanded(
                child: ReorderableListView.builder(
                  key: const Key('file-tabs-strip'),
                  scrollDirection: Axis.horizontal,
                  buildDefaultDragHandles: false,
                  itemCount: panes.length,
                  onReorderItem: onReorder,
                  proxyDecorator: (child, index, animation) => child,
                  itemBuilder: (context, index) {
                    final pane = panes[index];
                    return WorkspaceTabReorderListener(
                      key: ValueKey<String>(pane.key),
                      index: index,
                      child: _FileTab(
                        pane: pane,
                        selected: pane.key == activeKey,
                        grouped: selected.contains(pane.key),
                        tokens: tokens,
                        onSelect: () {
                          final activate = ref
                              .read(
                                workspaceTabSelectionProvider(region).notifier,
                              )
                              .select(
                                pane.key,
                                panes.map((pane) => pane.key).toList(),
                                activeKey,
                              );
                          ref.read(focusedPaneProvider.notifier).state =
                              activate ? pane.key : activeKey ?? pane.key;
                          if (activate) onSelect(pane);
                        },
                        onClose: () => onClose(pane),
                      ),
                    );
                  },
                ),
              ),
              if (selected
                      .intersection(panes.map((pane) => pane.key).toSet())
                      .length >
                  1)
                Semantics(
                  liveRegion: true,
                  child: IconButton(
                    key: const Key('file-close-selected-tabs'),
                    tooltip: l10n.workspaceCloseSelectedTabs(selected.length),
                    onPressed: () =>
                        unawaited(closeWorkspaceTabSelection(context, ref)),
                    icon: const StrokeIcon(StrokeGlyph.close, size: 16),
                  ),
                ),
              if (!panes.any(
                (pane) => pane.key == activeKey && pane is SessionPanelKey,
              ))
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 12),
                  child: Text(
                    l10n.fileViewerReadOnly,
                    key: const Key('file-tabs-read-only'),
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      color: tokens.textTertiary,
                      letterSpacing: 0.6,
                    ),
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _FileTab extends StatelessWidget {
  const _FileTab({
    required this.pane,
    required this.selected,
    required this.tokens,
    required this.onSelect,
    required this.onClose,
    this.grouped = false,
  });

  final SidePaneKey pane;
  final bool selected;
  final bool grouped;
  final AppTokens tokens;
  final VoidCallback onSelect;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final l10n = AppLocalizations.of(context);
    final name = sidePaneLabel(pane, l10n);
    return Semantics(
      selected: grouped,
      value: selected ? l10n.workspaceActiveTab : null,
      child: InkWell(
        onTap: () {
          focusWorkspaceTabSelection(context);
          onSelect();
        },
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: selected
                ? tokens.surface2
                : grouped
                ? tokens.surfaceHover
                : null,
            border: Border(
              bottom: BorderSide(
                color: selected
                    ? tokens.accent
                    : tokens.surface.withValues(alpha: 0),
                width: 2,
              ),
            ),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                // Neutral ink, never the tool colour: the owning session is
                // named once in the pane header, not colour-coded per tab.
                if (pane case SessionPanelKey(:final kind))
                  StrokeIcon(
                    kind == SessionPanelKind.files
                        ? StrokeGlyph.folder
                        : StrokeGlyph.overview,
                    size: 16,
                    color: tokens.textSecondary,
                  )
                else
                  FileMarkGlyph(
                    color: tokens.textSecondary,
                    foldColor: selected ? tokens.surface2 : tokens.surface,
                    height: 11,
                  ),
                const SizedBox(width: 8),
                ConstrainedBox(
                  constraints: const BoxConstraints(maxWidth: 160),
                  child: Text(
                    name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: theme.textTheme.labelSmall?.copyWith(
                      color: selected
                          ? tokens.textPrimary
                          : tokens.textSecondary,
                      fontWeight: selected
                          ? FontWeight.w600
                          : FontWeight.normal,
                    ),
                  ),
                ),
                const SizedBox(width: 4),
                InkWell(
                  key: Key('file-tab-close-${pane.key}'),
                  onTap: onClose,
                  child: Padding(
                    padding: const EdgeInsets.all(4),
                    child: Icon(
                      Icons.close,
                      size: 12,
                      color: tokens.textTertiary,
                    ),
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

/// The 44dp rail shown in place of a collapsed file pane.
///
/// Mirrors the collapsed roster rail: collapsing must not strand the files a
/// session has open, so the rail keeps them one tap away rather than closing
/// them.
class WorkspaceDocumentRail extends StatelessWidget {
  /// Creates the rail for [panes].
  const WorkspaceDocumentRail({
    required this.panes,
    required this.separatorColor,
    required this.tokens,
    required this.onExpand,
    super.key,
  });

  /// The active session's open files.
  final List<SidePaneKey> panes;

  /// Resting 1dp line colour.
  final Color separatorColor;

  /// Resolved design tokens.
  final AppTokens tokens;

  /// Reopens the pane at its remembered width.
  final VoidCallback onExpand;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      width: workspaceDocumentRailWidth,
      key: const Key('workspace-document-rail'),
      child: DecoratedBox(
        decoration: BoxDecoration(
          border: Border(left: BorderSide(color: separatorColor)),
        ),
        child: Column(
          children: [
            const SizedBox(height: 4),
            IconButton(
              key: const Key('workspace-document-rail-expand'),
              icon: const Icon(Icons.chevron_left, size: 18),
              color: tokens.textSecondary,
              tooltip: AppLocalizations.of(context).sessionFilesBrowse,
              onPressed: onExpand,
            ),
            Expanded(
              child: ListView.builder(
                padding: const EdgeInsets.symmetric(vertical: 4),
                itemCount: panes.length,
                itemBuilder: (context, index) => Padding(
                  padding: const EdgeInsets.symmetric(vertical: 8),
                  child: Center(
                    child: FileMarkGlyph(
                      color: tokens.textTertiary,
                      foldColor: tokens.canvas,
                    ),
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

/// Localized name shared by the tab strip and its accessible labels.
String sidePaneLabel(SidePaneKey pane, AppLocalizations l10n) => switch (pane) {
  FilePaneKey(:final path) => path.split('/').last,
  ArtifactPaneKey(:final name) => name,
  SessionPanelKey(kind: SessionPanelKind.status) => l10n.sessionViewStatus,
  SessionPanelKey(kind: SessionPanelKind.files) => l10n.sessionFilesTitle,
};
