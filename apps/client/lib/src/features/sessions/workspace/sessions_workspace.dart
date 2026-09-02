import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/nav_badge_label.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/app/shortcuts/app_shortcuts.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_inbox_controller.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_page.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_launch.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_launch_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_sheet.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_tab_strip.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_freshness.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_pane.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/list/sessions_empty_state.dart';
import 'package:cosyncing_client/src/features/sessions/roster/roster_freshness_slot.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_projection.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_window_controller.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_pane_surface.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_controller.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_store.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_tabs_strip.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/retained_session_pages.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_focus.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_pane_key.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_prefs_store.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_split_sash.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

/// Builds the detail pane for the active [SessionRef].
typedef SessionDetailPaneBuilder =
    Widget Function(BuildContext context, SessionRef ref);

/// The Expanded two-pane Sessions surface: a persistent roster on the left, the
/// opened-session tab strip and the active session's detail on the right.
///
/// Selecting a roster row opens it in the working set (the list keeps its
/// scroll position — the win over push-nav). The detail pane is injected via
/// [detailBuilder] so the router can supply the real detail surface; the
/// default embeds [SessionDetailPage] in its app-bar-free workspace mode.
///
/// See `docs/architecture/client-ui.md`.
class SessionsWorkspace extends ConsumerStatefulWidget {
  /// Creates the two-pane Sessions workspace.
  const SessionsWorkspace({this.detailBuilder, super.key});

  /// Default width of the roster pane, and the width Home/double-click resets
  /// to.
  static const double defaultListPaneWidth = 320;

  /// Width of the roster pane.
  ///
  /// Retained as the historical name for [defaultListPaneWidth]; the split is
  /// user-adjustable, so this is only the starting point.
  static const double listPaneWidth = defaultListPaneWidth;

  /// Narrowest roster the user can drag to — the "sliver roster" floor, where
  /// names truncate hard but status dots and project grouping still scan.
  static const double minListPaneWidth = 120;

  /// Widest roster the user can drag to.
  static const double maxListPaneWidth = 480;

  /// Dragging the pointer past this collapses the roster. The 20dp dead zone
  /// between [minListPaneWidth] and here is what separates "narrowest roster"
  /// from "close it".
  static const double collapseSnapWidth = 100;

  /// The detail pane's workable minimum: the roster never grows past
  /// `windowWidth - detailMinPaneWidth`.
  static const double detailMinPaneWidth = 480;

  /// The file pane's resting minimum. Narrower than this and a source line is
  /// no longer legible beside its gutter, so the pane collapses instead.
  static const double minFilePaneWidth = 320;

  /// Dragging the file pane below this snaps it to the document rail.
  static const double fileCollapseSnapWidth = 240;

  /// The file pane never grows past `windowWidth - detailMinPaneWidth`, so the
  /// transcript it was opened from stays readable beside it.
  static const double maxFilePaneWidth = 720;

  /// How long a resize settles before it is written to the store.
  static const Duration resizePersistDebounce = Duration(milliseconds: 300);

  /// Roster width below which the header sheds its secondary destinations, so
  /// a sliver roster degrades instead of overflowing its action row.
  ///
  /// Kept as low as the compact icon buttons actually fit (they need ~120dp
  /// plus the row's 18dp padding, plus the shared freshness slot), because
  /// dropping Attention and Settings costs reachability: at Expanded width the
  /// roster header and the collapsed rail are the only routes to them.
  ///
  /// R0b added the roster's shared refresh/status slot to this row. It is a
  /// primary affordance — it is the only place the roster states that its rows
  /// are stale — so it never sheds; the threshold moved up by its footprint
  /// instead.
  static const double compactHeaderWidth = 152 + RosterFreshnessSlot.slotExtent;

  /// Foreground compatibility refresh interval.
  ///
  /// Current brokers keep the roster converged through the revision feed.
  /// While that feed is healthy, this timer's silent load returns before
  /// repository or network access. The tick remains as a fallback for older
  /// brokers and an inactive feed, and is cancelled whenever the app is hidden.
  static const Duration rosterPollInterval = Duration(seconds: 15);

  /// Supplies the detail pane for the active session; defaults to
  /// [SessionDetailPage].
  final SessionDetailPaneBuilder? detailBuilder;

  @override
  ConsumerState<SessionsWorkspace> createState() => _SessionsWorkspaceState();
}

class _SessionsWorkspaceState extends ConsumerState<SessionsWorkspace>
    with WidgetsBindingObserver {
  Timer? _pollTimer;
  Timer? _persistTimer;
  NewSessionLaunchRequest? _newSessionLaunch;

  /// Roster width when open. Kept meaningful while [_collapsed] so reopening
  /// restores the width the user last chose rather than the default.
  double _rosterWidth = SessionsWorkspace.defaultListPaneWidth;

  /// Whether the roster is closed.
  ///
  /// Starts closed, and only [_restoreSplit] can open it — a saved record
  /// saying the roster was expanded. Defaulting the other way would flash the
  /// 320dp roster for a frame before the async store read collapsed it, and
  /// because restoring never writes, a user who keeps the roster closed keeps
  /// null prefs forever and would see that flash on *every* launch, not just
  /// the first.
  bool _collapsed = true;

  /// File pane width when open, kept meaningful while [_fileCollapsed] so
  /// reopening restores the width the user chose.
  double _fileWidth = workspaceDefaultFilePaneWidth;

  /// Whether the file pane is collapsed to its document rail.
  ///
  /// Unlike the roster this starts *expanded*, because the pane only exists at
  /// all once a file is open — and a user who just opened a file wants to see
  /// it, not a rail.
  bool _fileCollapsed = false;

  /// Raw pointer position during the file sash drag, tracked separately for
  /// the same reason [_dragWidth] is: clamping at the floor must not swallow
  /// further movement, or a slow drag can never reach the collapse snap.
  double _fileDragWidth = workspaceDefaultFilePaneWidth;
  double _fileDragStartWidth = workspaceDefaultFilePaneWidth;

  /// Raw pointer position during a drag, tracked separately from [_rosterWidth]
  /// so clamping at the floor cannot swallow further leftward movement — that
  /// is what lets a slow drag still reach the collapse snap.
  double _dragWidth = SessionsWorkspace.defaultListPaneWidth;

  /// Width the in-flight collapse drag began from; reopening restores this
  /// rather than the floor the pointer dragged through.
  double _dragStartWidth = SessionsWorkspace.defaultListPaneWidth;

  /// Owned here, handed to the roster pane, so the search chord has something
  /// to focus.
  final FocusNode _searchFocusNode = FocusNode(debugLabel: 'roster-search');

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // Trigger the initial roster load, like SessionsPage does for the drill-in
    // route, so the workspace is self-sufficient when rendered at /sessions.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        ref.read(sessionListControllerProvider.notifier).load();
      }
    });
    unawaited(_restoreSplit());
    _startPolling();
  }

  @override
  void dispose() {
    _pollTimer?.cancel();
    _persistTimer?.cancel();
    _searchFocusNode.dispose();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  /// Restores the persisted split, or opens collapsed on a genuine first run.
  ///
  /// A null record means the user has never set a split. Product wants the
  /// roster closed until they ask for it, so that case collapses while keeping
  /// [SessionsWorkspace.defaultListPaneWidth] as the reopen width. A store that
  /// cannot be read is treated the same way rather than wedging the workspace.
  Future<void> _restoreSplit() async {
    WorkspaceRosterPrefs? saved;
    try {
      saved = await ref.read(workspacePrefsStoreProvider).loadRoster();
    } on Object {
      saved = null;
    }
    if (!mounted) return;
    setState(() {
      if (saved == null) {
        _collapsed = true;
        _rosterWidth = SessionsWorkspace.defaultListPaneWidth;
      } else {
        _collapsed = saved.collapsed;
        _rosterWidth = saved.width;
      }
      _dragWidth = _rosterWidth;
      _dragStartWidth = _rosterWidth;
    });
    await _restoreFileSplit();
  }

  /// Restores the file pane's split.
  ///
  /// A null record opens the pane at its default width rather than collapsing
  /// it: the pane exists only once a file is open, so the roster's
  /// "closed until asked for" default would hide the thing just opened.
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
  double _clampFileWidth(double width, double available) {
    var upper = SessionsWorkspace.maxFilePaneWidth;
    final windowUpper =
        available - SessionsWorkspace.detailMinPaneWidth - _rosterFootprint();
    if (windowUpper < upper) upper = windowUpper;
    if (upper < SessionsWorkspace.minFilePaneWidth) {
      upper = SessionsWorkspace.minFilePaneWidth;
    }
    return width.clamp(SessionsWorkspace.minFilePaneWidth, upper);
  }

  /// What the roster side currently occupies, rail or pane plus its sash.
  double _rosterFootprint() => _collapsed
      ? workspaceCollapsedRailWidth
      : _rosterWidth + workspaceSashHitWidth;

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

  void _onFileDragEnd() => _schedulePersist();

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

  /// Clamps a roster width to 120–480dp, and never past `available - 480` so
  /// the detail pane keeps a workable minimum. A window too narrow to satisfy
  /// both pins the roster to its floor.
  double _clampWidth(double width, double available) {
    var upper = SessionsWorkspace.maxListPaneWidth;
    final windowUpper = available - SessionsWorkspace.detailMinPaneWidth;
    if (windowUpper < upper) upper = windowUpper;
    if (upper < SessionsWorkspace.minListPaneWidth) {
      upper = SessionsWorkspace.minListPaneWidth;
    }
    return width.clamp(SessionsWorkspace.minListPaneWidth, upper);
  }

  void _onDragStart() {
    _dragStartWidth = _rosterWidth;
    _dragWidth = _rosterWidth;
  }

  void _onDragDelta(double dx, double available) {
    _dragWidth += dx;
    setState(() {
      if (_dragWidth < SessionsWorkspace.collapseSnapWidth) {
        if (!_collapsed) {
          _collapsed = true;
          _rosterWidth = _dragStartWidth;
        }
        return;
      }
      _collapsed = false;
      _rosterWidth = _clampWidth(_dragWidth, available);
    });
  }

  void _onDragEnd() => _schedulePersist();

  /// Reset to the default split — double-click on the sash, or Home.
  void _resetSplit() {
    setState(() {
      _collapsed = false;
      _rosterWidth = SessionsWorkspace.defaultListPaneWidth;
      _dragWidth = _rosterWidth;
    });
    _schedulePersist();
  }

  void _stepSplit(double delta, double available) {
    setState(() {
      _collapsed = false;
      _rosterWidth = _clampWidth(_rosterWidth + delta, available);
      _dragWidth = _rosterWidth;
    });
    _schedulePersist();
  }

  void _expandRoster() {
    setState(() {
      _collapsed = false;
      _dragWidth = _rosterWidth;
    });
    _schedulePersist();
  }

  /// Debounces the write so a drag persists once it settles, not per pixel.
  void _schedulePersist() {
    _persistTimer?.cancel();
    _persistTimer = Timer(
      SessionsWorkspace.resizePersistDebounce,
      () => unawaited(_persistSplit()),
    );
  }

  Future<void> _persistSplit() async {
    if (!mounted) return;
    final prefs = WorkspaceRosterPrefs(
      width: _rosterWidth,
      collapsed: _collapsed,
    );
    final filePrefs = WorkspaceRosterPrefs(
      width: _fileWidth,
      collapsed: _fileCollapsed,
    );
    try {
      final store = ref.read(workspacePrefsStoreProvider);
      await store.saveRoster(prefs);
      await store.saveFilePane(filePrefs);
    } on Object {
      // Best effort: a layout preference is never worth surfacing an error for.
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.resumed:
        // On web this fires for `visibilitychange`. Refetch immediately rather
        // than waiting out the poll interval: returning to the tab is exactly
        // when the roster is most likely stale and most visibly wrong.
        _refreshNow();
        _startPolling();
      case AppLifecycleState.inactive:
        break;
      case AppLifecycleState.hidden:
      case AppLifecycleState.paused:
      case AppLifecycleState.detached:
        _pollTimer?.cancel();
        _pollTimer = null;
    }
  }

  void _startPolling() {
    _pollTimer?.cancel();
    _pollTimer = Timer.periodic(
      SessionsWorkspace.rosterPollInterval,
      (_) => _refreshNow(),
    );
  }

  void _refreshNow() {
    if (!mounted) return;
    unawaited(ref.read(sessionRosterResumeRefreshProvider)());
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

  /// The opened-sessions chords for the wide layout.
  ///
  /// Wide and compact bind the same registry specs to different handlers,
  /// because close already means two different things in the two layouts:
  /// here the detail pane is embedded and the controller call is the whole
  /// action, while the compact page must also route to a neighbour. The
  /// draft-durability barrier is NOT one of those differences — it lives
  /// inside `OpenSessionsController.close`, so both layouts get it.
  Map<ShortcutActivator, AppShortcutHandler> _workspaceShortcuts(
    OpenSessionsState open, {
    required bool canCreateSession,
  }) => {
    ...appShortcutBindings(
      specs: appShortcutsForScope(AppShortcutScope.workspace),
      handlers: {
        AppShortcutId.closeSession: () => _closeActiveSession(open),
        AppShortcutId.nextSession: () => _cycleSession(open, 1),
        AppShortcutId.previousSession: () => _cycleSession(open, -1),
        AppShortcutId.jumpToLastSession: () => _activateLastSession(open),
        if (canCreateSession)
          AppShortcutId.newSession: () => unawaited(_openNewSession()),
      },
    ),
    ...appShortcutOrdinalBindings(
      kSessionOrdinalActivators,
      (index) => _activateOrdinal(open, index),
    ),
    // The roster is mounted in this layout too, so the search chord is bound
    // here as well — a help-page row that works in one width and not the
    // other is the defect the registry exists to prevent.
    ...appShortcutBindings(
      specs: appShortcutsForScope(AppShortcutScope.sessionList),
      handlers: {AppShortcutId.focusRosterSearch: _focusRosterSearch},
    ),
  };

  /// Puts the caret in the roster's search field, opening the roster first.
  ///
  /// The pane is collapsed by default here, and focusing a field inside a
  /// zero-width pane would consume the chord and show nothing.
  void _focusRosterSearch() {
    if (!mounted) return;
    if (_collapsed) {
      setState(() => _collapsed = false);
      unawaited(_persistSplit());
    }
    _searchFocusNode.requestFocus();
  }

  /// The shared status slot's explicit user action.
  ///
  /// Deliberately not [_refreshNow]: a background tick is silent by contract,
  /// and pressing Refresh must both force a fetch and be visible in the one
  /// slot that reports it.
  Future<void> _refreshRequested() async {
    if (!mounted) return;
    await Future.wait<void>([
      ref.read(sessionListControllerProvider.notifier).load(),
      ref.read(sessionCreationReadyProvider.notifier).refresh(),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    // Reload once a real broker client arrives: the active profile (notably the
    // web same-origin default) hydrates asynchronously and the first load can
    // race it (mirrors SessionsPage). Also keep tab metadata live as the roster
    // refreshes.
    ref
      ..listen(brokerClientProvider, (previous, next) {
        final hadClient = previous?.valueOrNull != null;
        final hasClient = next.valueOrNull != null;
        if (!hadClient && hasClient && mounted) {
          ref.read(sessionListControllerProvider.notifier).load();
        }
      })
      // Open-tab metadata reads the same overlaid rows the roster renders, so a
      // tab's status can never disagree with its row or with the open detail.
      ..listen(rosterSessionsProvider, (_, next) {
        ref.read(openSessionsControllerProvider.notifier).refreshMetadata(next);
      });

    final tokens = context.tokens;
    final l10n = AppLocalizations.of(context);
    final listState = ref.watch(sessionListControllerProvider);
    final hasActiveBrokerClient = ref
        .watch(brokerClientProvider)
        .maybeWhen(data: (client) => client != null, orElse: () => false);
    final activeSource = RosterSource.of(
      ref.watch(activeBrokerProfileProvider),
    );
    final creationAvailability = ref
        .watch(sessionCreationReadyProvider)
        .availabilityFor(activeSource);
    final canCreateSession =
        creationAvailability == SessionCreationAvailability.available;
    final hasRosterSessions = ref.watch(rosterSessionsProvider).isNotEmpty;
    final hasCompletedEmptyRoster =
        listState.status == SessionListStatus.loaded && !hasRosterSessions;
    final emptyRosterMessage = switch (creationAvailability) {
      SessionCreationAvailability.checking =>
        l10n.sessionsWorkspaceEmptyCreationChecking,
      SessionCreationAvailability.available => l10n.sessionsWorkspaceEmpty,
      SessionCreationAvailability.unavailable =>
        l10n.sessionsWorkspaceEmptyCreationUnavailable,
      SessionCreationAvailability.failed =>
        l10n.sessionsWorkspaceEmptyCreationCheckFailed,
    };
    final unreadCount = ref.watch(attentionUnreadCountProvider);
    final openAsync = ref.watch(openSessionsControllerProvider);
    // Never render a previous source's tab membership while the source-keyed
    // controller is rehydrating. AsyncValue may retain its old value during a
    // dependency reload; treating loading/error as empty is the presentation
    // fence that prevents those identities from mounting against the new
    // broker even for one frame.
    final open = openAsync.isLoading || openAsync.hasError
        ? const OpenSessionsState()
        : openAsync.valueOrNull ?? const OpenSessionsState();
    final active = open.active;
    final buildDetail = widget.detailBuilder ?? _defaultDetail;

    return AppCallbackShortcuts(
      bindings: _workspaceShortcuts(
        open,
        canCreateSession: canCreateSession,
      ),
      child: _buildSplit(
        tokens: tokens,
        l10n: l10n,
        listState: listState,
        open: open,
        active: active,
        activeSource: activeSource,
        buildDetail: buildDetail,
        unreadCount: unreadCount,
        hasActiveBrokerClient: hasActiveBrokerClient,
        hasCompletedEmptyRoster: hasCompletedEmptyRoster,
        canCreateSession: canCreateSession,
        emptyRosterMessage: emptyRosterMessage,
      ),
    );
  }

  /// The second pane: one session's open files, with their own strip.
  ///
  /// The strip is in the pane, never in the top scroller — that one stays
  /// sessions-only, so the two kinds can never be confused there.
  Widget _buildSplit({
    required AppTokens tokens,
    required AppLocalizations l10n,
    required SessionListState listState,
    required OpenSessionsState open,
    required SessionRef? active,
    required RosterSource? activeSource,
    required SessionDetailPaneBuilder buildDetail,
    required int unreadCount,
    required bool hasActiveBrokerClient,
    required bool hasCompletedEmptyRoster,
    required bool canCreateSession,
    required String emptyRosterMessage,
  }) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final available = constraints.maxWidth;
        final rosterWidth = _clampWidth(_rosterWidth, available);
        // No phantom pane: the second sash and the file pane exist precisely
        // while *some* session has a file open. With none, this is exactly
        // today's two-column workspace and there is no empty third column.
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
            activeSession != null &&
            hasReachableFilePane &&
            available >=
                SessionsWorkspace.detailMinPaneWidth +
                    SessionsWorkspace.minFilePaneWidth;
        return Stack(
          children: [
            Row(
              children: [
                if (_collapsed)
                  WorkspaceCollapsedRosterRail(
                    separatorColor: tokens.separator,
                    unreadCount: unreadCount,
                    unreadLabel: navBadgeLabel(unreadCount),
                    onExpand: _expandRoster,
                    onNewSession: canCreateSession
                        ? () => unawaited(_openNewSession())
                        : null,
                    onAttention: () => context.go(attentionRoute),
                    onSettings: () => context.go(settingsRoute),
                  )
                else ...[
                  SizedBox(
                    key: const Key('workspace-roster-pane'),
                    width: rosterWidth,
                    child: _buildRoster(
                      context,
                      listState,
                      open,
                      unreadCount,
                      rosterWidth,
                      hasActiveBrokerClient,
                      canCreateSession,
                      emptyRosterMessage,
                    ),
                  ),
                  WorkspaceSplitSash(
                    key: const Key('workspace-split-sash'),
                    separatorColor: tokens.separator,
                    onDragStart: _onDragStart,
                    onDragDelta: (dx) => _onDragDelta(dx, available),
                    onDragEnd: _onDragEnd,
                    onReset: _resetSplit,
                    onStep: (delta) => _stepSplit(delta, available),
                  ),
                ],
                Expanded(
                  child: WorkspaceFocusablePane(
                    paneKey: sessionPaneKey,
                    enabled: showFilePane,
                    child: Column(
                      children: [
                        OpenSessionsTabStrip(
                          refs: open.refs,
                          activeKey: open.activeKey,
                          // The controller's reorder had no production caller
                          // until now; the strip had no way to ask for one.
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
                          child: active == null
                              ? !hasActiveBrokerClient
                                    ? const SessionsEmptyState(
                                        hasActiveBrokerClient: false,
                                        creationAvailability:
                                            SessionCreationAvailability
                                                .checking,
                                      )
                                    : hasCompletedEmptyRoster
                                    ? _PaneMessage(
                                        icon: Icons.inbox_outlined,
                                        message: emptyRosterMessage,
                                      )
                                    : _PaneMessage(
                                        icon: Icons.terminal_outlined,
                                        message:
                                            l10n.sessionsWorkspaceSelectPrompt,
                                      )
                              : RetainedSessionPages(
                                  source: activeSource,
                                  open: open,
                                  builder: buildDetail,
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
                      onDragEnd: _onFileDragEnd,
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
            if (_newSessionLaunch case final NewSessionLaunchRequest request)
              Positioned.fill(
                child: NewSessionLaunchPage(
                  key: ValueKey<NewSessionLaunchRequest>(request),
                  request: request,
                  onCreate: (request) =>
                      ref.read(newSessionLaunchServiceProvider).create(request),
                  onOpen: _prepareCreatedSessionDestination,
                  onConnect: _prepareCreatedSessionConnection,
                  onComplete: _openCreatedSession,
                  onBack: _finishNewSessionLaunch,
                ),
              ),
          ],
        );
      },
    );
  }

  /// Builds the roster pane.
  ///
  /// [rosterWidth] governs how much of the header survives: a sliver roster has
  /// no room for three action buttons beside the title, and a `RenderFlex`
  /// overflow there would be a visible break rather than a graceful narrow
  /// state. Below [SessionsWorkspace.compactHeaderWidth] the secondary
  /// destinations (Attention, Settings) drop out — both remain reachable from
  /// the app's primary navigation — and New session, the roster's own action,
  /// stays.
  Widget _buildRoster(
    BuildContext context,
    SessionListState listState,
    OpenSessionsState open,
    int unreadCount,
    double rosterWidth,
    bool hasActiveBrokerClient,
    bool canCreateSession,
    String emptyRosterMessage,
  ) {
    final l10n = AppLocalizations.of(context);
    final showSecondaryActions =
        rosterWidth >= SessionsWorkspace.compactHeaderWidth;
    final sessions = ref.watch(rosterSessionsProvider);
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(12, 7, 6, 7),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      l10n.sessionsTitle,
                      // A sliver roster leaves the title very little room; let
                      // it ellipsize rather than wrap the header taller.
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                  ],
                ),
              ),
              if (showSecondaryActions) ...[
                IconButton(
                  key: const Key('sessions-workspace-attention'),
                  tooltip: l10n.notificationsTitle,
                  visualDensity: VisualDensity.compact,
                  onPressed: () => context.go(attentionRoute),
                  icon: Badge(
                    isLabelVisible: unreadCount > 0,
                    label: Text(navBadgeLabel(unreadCount)),
                    child: const Icon(Icons.notifications_outlined),
                  ),
                ),
                IconButton(
                  key: const Key('sessions-workspace-settings'),
                  tooltip: l10n.settingsTitle,
                  visualDensity: VisualDensity.compact,
                  onPressed: () => context.go(settingsRoute),
                  icon: const Icon(Icons.settings_outlined),
                ),
              ],
              IconButton.filledTonal(
                key: const Key('sessions-workspace-global-new'),
                tooltip: l10n.newSessionTitle,
                visualDensity: VisualDensity.compact,
                onPressed: canCreateSession
                    ? () => unawaited(_openNewSession())
                    : null,
                icon: const Icon(Icons.add, size: 19),
              ),
              // R0b: the same slot, in the same top-right position, that
              // Compact renders — so a rotation or resize never moves it and
              // never leaves two indicators describing one transition.
              RosterFreshnessSlot(
                presentation: RosterFreshnessPresentation.fromListState(
                  listState,
                ),
                onRefresh: _refreshRequested,
              ),
            ],
          ),
        ),
        Expanded(
          child: SessionListPane(
            searchFocusNode: _searchFocusNode,
            queryWindow:
                ref.watch(sessionRosterWindowProvider).valueOrNull ??
                SessionRosterQueryWindow.last7Days,
            onQueryWindowChanged: (window) => unawaited(
              ref.read(sessionRosterWindowProvider.notifier).setWindow(window),
            ),
            sessions: sessions,
            status: listState.status,
            error: listState.error,
            cachedRoster: listState.cachedRoster,
            activeKey: open.activeKey,
            onOpen: (session) => ref
                .read(openSessionsControllerProvider.notifier)
                .open(SessionRef.fromSession(session)),
            // A cached row opens on its exact identity, with the tab's status
            // left explicitly UNKNOWN — the snapshot stores no activity, so
            // there is nothing truthful to put there. `refreshMetadata` fills
            // it in as soon as the authoritative roster lands.
            onOpenCached: (identity) => ref
                .read(openSessionsControllerProvider.notifier)
                .open(
                  SessionRef.cachedIdentity(
                    tool: identity.tool,
                    id: identity.sessionId,
                    title: identity.title.isNotEmpty
                        ? identity.title
                        : identity.sessionId,
                  ),
                ),
            onNewProject: canCreateSession
                ? (project) => unawaited(_openNewSession(project: project))
                : null,
            onRenameProject: (project) =>
                unawaited(renameProjectAliasFromList(context, ref, project)),
            onRetry: _refreshRequested,
            emptyState: _PaneMessage(
              icon: Icons.inbox_outlined,
              message: !hasActiveBrokerClient
                  ? l10n.sessionsEmptyBody
                  : emptyRosterMessage,
            ),
          ),
        ),
      ],
    );
  }

  Future<void> _openNewSession({SessionProjectGroup? project}) async {
    final result = await showNewSessionSheet(
      context,
      initialDirectory: project?.cwd ?? '',
      projectName: project?.label,
      onImmediateLaunch: _beginNewSessionLaunch,
    );
    if (!mounted || result == null) return;
    switch (result) {
      case ImmediateNewSessionResult():
        // The callback already started this before the sheet's exit animation.
        // Replaying the result could create a duplicate if a very fast launch
        // completed before the bottom-sheet route finished dismissing.
        return;
      case ScheduledNewSessionResult(:final schedule):
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(
              AppLocalizations.of(context).sessionScheduledFor(
                DateTime.fromMillisecondsSinceEpoch(schedule.at).toString(),
              ),
            ),
          ),
        );
    }
  }

  void _beginNewSessionLaunch(NewSessionLaunchRequest request) {
    if (!mounted || _newSessionLaunch != null) return;
    setState(() => _newSessionLaunch = request);
  }

  Future<void> _prepareCreatedSessionDestination(SessionInfo _) =>
      Future<void>.value();

  void _openCreatedSession(SessionInfo session) {
    if (!mounted) return;
    // Keep the embedded detail and its background Observe supervisor out of
    // the provider family until the launch-owned reason-tagged Resume attach
    // has completed. Opening here still happens while NewSessionLaunchPage
    // holds its handoff lease through the destination's first rendered frame.
    ref
        .read(openSessionsControllerProvider.notifier)
        .open(SessionRef.fromSession(session));
    setState(() => _newSessionLaunch = null);
    // The create response is authoritative: never wait for the roster before
    // opening it. Let the roster catch up silently in the background.
    unawaited(
      ref.read(sessionListControllerProvider.notifier).load(silent: true),
    );
  }

  Future<NewSessionConnectionHandoff> _prepareCreatedSessionConnection(
    SessionInfo session,
  ) => ref.read(newSessionConnectionPreparerProvider)(
    ProviderScope.containerOf(context, listen: false),
    session,
  );

  void _finishNewSessionLaunch() {
    if (!mounted || _newSessionLaunch == null) return;
    setState(() => _newSessionLaunch = null);
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

/// A centered icon + message used for the workspace's empty panes.
class _PaneMessage extends StatelessWidget {
  const _PaneMessage({required this.icon, required this.message});

  final IconData icon;
  final String message;

  @override
  Widget build(BuildContext context) {
    final tokens = context.tokens;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 40, color: tokens.textTertiary),
            const SizedBox(height: 12),
            SelectableText(
              message,
              textAlign: TextAlign.center,
              style: Theme.of(
                context,
              ).textTheme.bodyMedium?.copyWith(color: tokens.textSecondary),
            ),
          ],
        ),
      ),
    );
  }
}
