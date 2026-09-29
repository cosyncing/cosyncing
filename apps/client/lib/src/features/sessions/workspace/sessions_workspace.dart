import 'dart:async';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/shortcuts/app_shortcuts.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_page.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_tab_strip.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/list/sessions_empty_state.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_pane_surface.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_controller.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_store.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_tabs_strip.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/retained_session_pages.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_focus.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_frame.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_overview.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_pane_key.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_prefs_store.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_split_sash.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Builds the detail pane for the active [SessionRef].
typedef SessionDetailPaneBuilder =
    Widget Function(BuildContext context, SessionRef ref);

/// The Sessions main pane: the opened-session tab strip, the active session's
/// detail (or the Overview), and the optional file pane beside it.
///
/// The roster sidebar belongs to the enclosing [WorkspaceFrame], shared with
/// every other top-level destination. Selecting a roster row opens it in the
/// working set (the list keeps its scroll position — the win over push-nav).
/// The detail pane is injected via [detailBuilder] so the router can supply
/// the real detail surface; the default embeds [SessionDetailPage] in its
/// app-bar-free workspace mode.
///
/// See `docs/architecture/client-ui.md`.
class SessionsWorkspace extends ConsumerStatefulWidget {
  /// Creates the Sessions main pane.
  const SessionsWorkspace({this.detailBuilder, super.key});

  /// The detail pane's workable minimum beside the file pane.
  static const double detailMinPaneWidth = WorkspaceFrame.mainMinPaneWidth;

  /// The file pane's resting minimum. Narrower than this and a source line is
  /// no longer legible beside its gutter, so the pane collapses instead.
  static const double minFilePaneWidth = 320;

  /// Dragging the file pane below this snaps it to the document rail.
  static const double fileCollapseSnapWidth = 240;

  /// The file pane never grows past `windowWidth - detailMinPaneWidth`, so the
  /// transcript it was opened from stays readable beside it.
  static const double maxFilePaneWidth = 720;

  /// How long a resize settles before it is written to the store.
  static const Duration resizePersistDebounce =
      WorkspaceFrame.resizePersistDebounce;

  /// Supplies the detail pane for the active session; defaults to
  /// [SessionDetailPage].
  final SessionDetailPaneBuilder? detailBuilder;

  @override
  ConsumerState<SessionsWorkspace> createState() => _SessionsWorkspaceState();
}

class _SessionsWorkspaceState extends ConsumerState<SessionsWorkspace> {
  Timer? _persistTimer;

  /// File pane width when open, kept meaningful while [_fileCollapsed] so
  /// reopening restores the width the user chose.
  double _fileWidth = workspaceDefaultFilePaneWidth;

  /// Whether the file pane is collapsed to its document rail.
  ///
  /// Unlike the sidebar this starts *expanded*, because the pane only exists
  /// at all once a file is open — and a user who just opened a file wants to
  /// see it, not a rail.
  bool _fileCollapsed = false;

  /// Raw pointer position during the file sash drag, tracked separately so
  /// clamping at the floor cannot swallow further movement, or a slow drag
  /// could never reach the collapse snap.
  double _fileDragWidth = workspaceDefaultFilePaneWidth;
  double _fileDragStartWidth = workspaceDefaultFilePaneWidth;

  @override
  void initState() {
    super.initState();
    unawaited(_restoreFileSplit());
  }

  @override
  void dispose() {
    _persistTimer?.cancel();
    super.dispose();
  }

  /// Restores the file pane's split.
  ///
  /// A null record opens the pane at its default width. The pane only exists
  /// after a file is opened.
  Future<void> _restoreFileSplit() async {
    WorkspaceRosterPrefs? saved;
    try {
      saved = await ref.read(workspacePrefsStoreProvider).loadFilePane();
    } on Object {
      saved = null;
    }
    if (!mounted) return;
    setState(() {
      _fileWidth = saved?.width ?? workspaceDefaultFilePaneWidth;
      _fileCollapsed = saved?.collapsed ?? false;
      _fileDragWidth = _fileWidth;
      _fileDragStartWidth = _fileWidth;
    });
  }

  /// Clamps a file-pane width, leaving the detail pane its workable minimum.
  ///
  /// [available] is the whole window; the frame's sidebar footprint comes off
  /// it first.
  double _clampFileWidth(double width, double available) {
    var upper = SessionsWorkspace.maxFilePaneWidth;
    final windowUpper = available - SessionsWorkspace.detailMinPaneWidth;
    if (windowUpper < upper) upper = windowUpper;
    if (upper < SessionsWorkspace.minFilePaneWidth) {
      upper = SessionsWorkspace.minFilePaneWidth;
    }
    return width.clamp(SessionsWorkspace.minFilePaneWidth, upper);
  }

  void _onFileDragStart() {
    _fileDragStartWidth = _fileWidth;
    _fileDragWidth = _fileWidth;
  }

  /// The file sash sits to the *right* of the detail pane, so a rightward drag
  /// shrinks the file pane rather than growing it.
  void _onFileDragDelta(double dx, double available) {
    _fileDragWidth -= dx;
    setState(() {
      if (_fileDragWidth < SessionsWorkspace.fileCollapseSnapWidth) {
        if (!_fileCollapsed) {
          _fileCollapsed = true;
          _fileWidth = _fileDragStartWidth;
        }
        return;
      }
      _fileCollapsed = false;
      _fileWidth = _clampFileWidth(_fileDragWidth, available);
    });
  }

  void _resetFileSplit() {
    setState(() {
      _fileCollapsed = false;
      _fileWidth = workspaceDefaultFilePaneWidth;
      _fileDragWidth = _fileWidth;
    });
    _schedulePersist();
  }

  void _stepFileSplit(double delta, double available) {
    setState(() {
      _fileCollapsed = false;
      // Negated for the same reason the drag is: this sash's left edge grows
      // the pane, and the arrow keys have to agree with the drag.
      _fileWidth = _clampFileWidth(_fileWidth - delta, available);
      _fileDragWidth = _fileWidth;
    });
    _schedulePersist();
  }

  void _expandFilePane() {
    setState(() {
      _fileCollapsed = false;
      _fileDragWidth = _fileWidth;
    });
    _schedulePersist();
  }

  /// Debounces the write so a drag persists once it settles, not per pixel.
  void _schedulePersist() {
    _persistTimer?.cancel();
    _persistTimer = Timer(
      SessionsWorkspace.resizePersistDebounce,
      () => unawaited(_persistFileSplit()),
    );
  }

  Future<void> _persistFileSplit() async {
    if (!mounted) return;
    try {
      await ref
          .read(workspacePrefsStoreProvider)
          .saveFilePane(
            WorkspaceRosterPrefs(width: _fileWidth, collapsed: _fileCollapsed),
          );
    } on Object {
      // Best effort: a layout preference is never worth surfacing an error for.
    }
  }

  /// Activates the open session at [index] (0-based, strip order).
  ///
  /// Past the end is a no-op, matching Chrome: the ordinal names a position
  /// that may simply not be there.
  void _activateOrdinal(OpenSessionsState open, int index) {
    if (index < 0 || index >= open.refs.length) return;
    ref
        .read(openSessionsControllerProvider.notifier)
        .activate(open.refs[index].key);
  }

  /// Activates the LAST open session — Chrome's rule for `9`.
  void _activateLastSession(OpenSessionsState open) {
    if (open.refs.isEmpty) return;
    ref
        .read(openSessionsControllerProvider.notifier)
        .activate(open.refs.last.key);
  }

  /// Moves [delta] tabs along the strip, wrapping at both ends.
  void _cycleSession(OpenSessionsState open, int delta) {
    if (open.refs.length < 2) return;
    final current = open.refs.indexWhere(
      (entry) => entry.key == open.activeKey,
    );
    final from = current < 0 ? 0 : current;
    // Dart's `%` is non-negative for a positive divisor, so this wraps both
    // ways without a sign fix.
    final next = (from + delta) % open.refs.length;
    ref
        .read(openSessionsControllerProvider.notifier)
        .activate(open.refs[next].key);
  }

  /// Closes the active tab, the same working-set-only close the tab strip's
  /// button performs. The agent keeps running.
  ///
  /// Unawaited on purpose: the close is fire-and-forget from a keystroke, and
  /// the draft-durability barrier it waits on lives inside the controller, so
  /// nothing here has to sequence after it.
  void _closeActiveSession(OpenSessionsState open) {
    final key = open.activeKey;
    if (key == null) return;
    unawaited(ref.read(openSessionsControllerProvider.notifier).close(key));
  }

  /// The opened-sessions chords.
  ///
  /// Wide and compact bind the same registry specs to different handlers,
  /// because close already means two different things in the two layouts:
  /// here the detail pane is embedded and the controller call is the whole
  /// action, while the compact page must also route to a neighbour. The
  /// draft-durability barrier is NOT one of those differences — it lives
  /// inside `OpenSessionsController.close`, so both layouts get it. New
  /// session and roster search are the frame's, bound once for every page.
  Map<ShortcutActivator, AppShortcutHandler> _workspaceShortcuts(
    OpenSessionsState open,
  ) => {
    ...appShortcutBindings(
      specs: appShortcutsForScope(AppShortcutScope.workspace),
      handlers: {
        AppShortcutId.closeSession: () => _closeActiveSession(open),
        AppShortcutId.nextSession: () => _cycleSession(open, 1),
        AppShortcutId.previousSession: () => _cycleSession(open, -1),
        AppShortcutId.jumpToLastSession: () => _activateLastSession(open),
      },
    ),
    ...appShortcutOrdinalBindings(
      kSessionOrdinalActivators,
      (index) => _activateOrdinal(open, index),
    ),
  };

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    final frame = WorkspaceFrameScope.maybeOf(context);
    final drawerLayout = frame?.drawerLayout ?? false;
    final listState = ref.watch(sessionListControllerProvider);
    final hasActiveBrokerClient = ref
        .watch(brokerClientProvider)
        .maybeWhen(data: (client) => client != null, orElse: () => false);
    final activeSource = RosterSource.of(
      ref.watch(activeBrokerProfileProvider),
    );
    final openAsync = ref.watch(openSessionsControllerProvider);
    // Never render a previous source's tab membership while the source-keyed
    // controller is rehydrating. AsyncValue may retain its old value during a
    // dependency reload; treating loading/error as empty is the presentation
    // fence that prevents those identities from mounting against the new
    // broker even for one frame.
    final open = openAsync.isLoading || openAsync.hasError
        ? const OpenSessionsState()
        : openAsync.valueOrNull ?? const OpenSessionsState();
    final overviewVisible = ref.watch(workspaceOverviewVisibleProvider);
    final active = overviewVisible ? null : open.active;
    final buildDetail = widget.detailBuilder ?? _defaultDetail;

    return PopScope<Object?>(
      canPop: !drawerLayout || active == null,
      onPopInvokedWithResult: (didPop, result) {
        // An open drawer is the frame's first Back step.
        if (didPop || (frame?.drawerOpen ?? false)) return;
        _showOverview();
      },
      child: AppCallbackShortcuts(
        bindings: _workspaceShortcuts(open),
        child: Focus(
          autofocus: true,
          child: _buildSplit(
            tokens: tokens,
            listState: listState,
            open: open,
            active: active,
            activeSource: activeSource,
            buildDetail: buildDetail,
            hasActiveBrokerClient: hasActiveBrokerClient,
            frame: frame,
          ),
        ),
      ),
    );
  }

  /// The main pane, and the second pane: one session's open files, with
  /// their own strip.
  ///
  /// The strip is in the pane, never in the top scroller — that one stays
  /// sessions-only, so the two kinds can never be confused there.
  Widget _buildSplit({
    required AppTokens tokens,
    required SessionListState listState,
    required OpenSessionsState open,
    required SessionRef? active,
    required RosterSource? activeSource,
    required SessionDetailPaneBuilder buildDetail,
    required bool hasActiveBrokerClient,
    required WorkspaceFrameScope? frame,
  }) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final available = constraints.maxWidth;
        final drawerLayout = frame?.drawerLayout ?? false;
        // No phantom pane: the second sash and the file pane exist precisely
        // while *some* session has a file open. With none, this is exactly
        // the one-column main pane and there is no empty second column.
        //
        // Deliberately the whole working set, not the active session's slice.
        // Keying it on the active session would collapse the layout out from
        // under a reader every time they switched tabs, and rebuild it when
        // they switched back; a session that has opened nothing rests instead.
        final activeSession = active == null
            ? null
            : SessionDetailKey(tool: active.tool, sessionId: active.id);
        final fileState =
            ref.watch(filePanesControllerProvider).valueOrNull ??
            FilePanesState.empty;
        final filePanes = activeSession == null
            ? const <FilePaneKey>[]
            : fileState.forSession(activeSession);
        // The split is an Expanded-width affordance. Below that the compact
        // route carries the file instead, so a narrow window never has to fit
        // three columns.
        final fileWidth = _clampFileWidth(_fileWidth, available);
        final focusedPane = ref.watch(focusedPaneProvider);
        // The tick names the session that still owns typing, which is only a
        // question worth answering while the focused pane is a file.
        final promptTargetKey =
            focusedPane != null && isWorkspaceFilePaneKey(focusedPane)
            ? workspacePaneSessionKey(focusedPane)
            : null;
        final sessionPaneKey = activeSession == null
            ? null
            : SessionPaneKey(session: activeSession).key;
        // Reachable, not merely open. A file pane belongs to one session and
        // is only ever shown while that session is the active tab, so files
        // left behind by a closed session can never be displayed — and holding
        // the split open for them put a second pane on screen that said "No
        // files open" and could not be filled from anywhere.
        //
        // They are kept in the working set rather than deleted: reopening the
        // session brings its files back, which is the design's "a file tab
        // outlives its session" in the only form per-session scoping allows.
        final openSessionKeys = <String>{
          for (final ref in open.refs) ref.key,
        };
        final hasReachableFilePane = fileState.panes.any(
          (pane) => openSessionKeys.contains(
            SessionPaneKey(session: pane.session).key,
          ),
        );
        final showFilePane =
            !drawerLayout &&
            activeSession != null &&
            hasReachableFilePane &&
            available >=
                SessionsWorkspace.detailMinPaneWidth +
                    SessionsWorkspace.minFilePaneWidth;
        return Material(
          color: tokens.canvas,
          child: SafeArea(
            child: Row(
              children: [
                Expanded(
                  child: WorkspaceFocusablePane(
                    paneKey: sessionPaneKey,
                    enabled: showFilePane,
                    child: Column(
                      children: [
                        OpenSessionsTabStrip(
                          refs: open.refs,
                          activeKey: active?.key,
                          onOverview: _showOverview,
                          unreadCompletionKeys: ref.watch(
                            workspaceUnreadCompletionKeysProvider,
                          ),
                          onCloseAll: () => unawaited(_closeAllTabs()),
                          onOpenRoster: drawerLayout ? frame?.openDrawer : null,
                          showLiveStatus:
                              listState.cachedRoster == null &&
                              listState.status != SessionListStatus.error &&
                              listState.status != SessionListStatus.loading,
                          onReorder: (oldIndex, newIndex) => ref
                              .read(openSessionsControllerProvider.notifier)
                              .reorder(oldIndex, newIndex),
                          onSelect: (key) => ref
                              .read(openSessionsControllerProvider.notifier)
                              .activate(key),
                          onClose: (key) => unawaited(
                            ref
                                .read(openSessionsControllerProvider.notifier)
                                .close(key),
                          ),
                          promptTargetKey: promptTargetKey,
                        ),
                        Expanded(
                          child: Stack(
                            fit: StackFit.expand,
                            children: [
                              RetainedSessionPages(
                                source: activeSource,
                                open: open,
                                visibleKeys: active == null
                                    ? const {}
                                    : {active.key},
                                builder: buildDetail,
                              ),
                              if (active == null)
                                hasActiveBrokerClient
                                    ? WorkspaceOverview(onOpen: _openSession)
                                    : const SessionsEmptyState(
                                        hasActiveBrokerClient: false,
                                        creationAvailability:
                                            SessionCreationAvailability
                                                .checking,
                                      ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                if (showFilePane) ...[
                  if (_fileCollapsed)
                    WorkspaceDocumentRail(
                      panes: filePanes,
                      separatorColor: tokens.separator,
                      tokens: tokens,
                      onExpand: _expandFilePane,
                    )
                  else ...[
                    WorkspaceSplitSash(
                      key: const Key('workspace-file-split-sash'),
                      separatorColor: tokens.separator,
                      onDragStart: _onFileDragStart,
                      onDragDelta: (dx) => _onFileDragDelta(dx, available),
                      onDragEnd: _schedulePersist,
                      onReset: _resetFileSplit,
                      onStep: (delta) => _stepFileSplit(delta, available),
                    ),
                    SizedBox(
                      key: const Key('workspace-file-pane'),
                      width: fileWidth,
                      child: WorkspaceFocusablePane(
                        paneKey: fileState.activeFor(activeSession)?.key,
                        child: FilePaneSurface(session: activeSession),
                      ),
                    ),
                  ],
                ],
              ],
            ),
          ),
        );
      },
    );
  }

  void _showOverview() {
    ref.read(workspaceOverviewVisibleProvider.notifier).state = true;
  }

  void _openSession(SessionRef session) {
    ref.read(openSessionsControllerProvider.notifier).open(session);
  }

  Future<void> _closeAllTabs() async {
    final closed = await ref
        .read(openSessionsControllerProvider.notifier)
        .closeAll();
    if (!mounted || closed == null) return;
    final l10n = AppLocalizations.of(context);
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(
        content: Text(l10n.workspaceTabsClosed),
        persist: MediaQuery.accessibleNavigationOf(context),
        showCloseIcon: true,
        action: SnackBarAction(
          label: l10n.workspaceUndoCloseTabs,
          onPressed: () => ref
              .read(openSessionsControllerProvider.notifier)
              .restoreClosedTabs(closed),
        ),
      ),
    );
  }

  static Widget _defaultDetail(BuildContext context, SessionRef ref) =>
      SessionDetailPage(
        key: ValueKey<SessionDetailKey>(
          SessionDetailKey(tool: ref.tool, sessionId: ref.id),
        ),
        tool: ref.tool,
        sessionId: ref.id,
        embedded: true,
      );
}
