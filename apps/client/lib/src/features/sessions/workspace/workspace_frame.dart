import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/nav_badge_label.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/app/shortcuts/app_shortcuts.dart';
import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_inbox_controller.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_launch.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_launch_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/new_session_sheet.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_projection.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_prefs_store.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_sidebar.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_split_sash.dart';
import 'package:cosyncing_client/src/platform/update/native_client_update.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

/// The app's shared frame: one sidebar for every top-level destination.
///
/// Sessions, Notifications and Settings all render into [child], the main
/// pane, beside a persistent resizable sidebar on wide windows and under a
/// modal drawer through [drawerBreakpoint]. The frame owns everything that
/// belongs to the sidebar rather than to one page: its width and collapse
/// preference, the roster refresh cadence, the search chord, and the New
/// session flow. See `docs/architecture/client-ui.md`.
class WorkspaceFrame extends ConsumerStatefulWidget {
  /// Creates the frame around [child].
  const WorkspaceFrame({required this.child, this.location, super.key});

  /// The routed page shown in the main pane.
  final Widget child;

  /// The current router path, used to mark the active destination. Null
  /// outside the router (widget tests), where Sessions is assumed.
  final String? location;

  /// Widest window that still uses the modal drawer, tablet portrait included.
  static const double drawerBreakpoint = 900;

  /// Default sidebar width, and the width Home/double-click resets to.
  static const double defaultSidebarWidth = 292;

  /// Narrowest sidebar the user can drag to.
  static const double minSidebarWidth = 120;

  /// Widest sidebar the user can drag to.
  static const double maxSidebarWidth = 480;

  /// Dragging the pointer past this collapses the sidebar to its rail.
  static const double collapseSnapWidth = 100;

  /// The main pane's workable minimum beside the sidebar.
  static const double mainMinPaneWidth = 480;

  /// How long a resize settles before it is written to the store.
  static const Duration resizePersistDebounce = Duration(milliseconds: 300);

  /// Foreground compatibility refresh interval.
  ///
  /// Current brokers keep the roster converged through the revision feed.
  /// While that feed is healthy, this timer's silent load returns before
  /// repository or network access. The tick remains as a fallback for older
  /// brokers and an inactive feed, and is cancelled whenever the app is hidden.
  static const Duration rosterPollInterval = Duration(seconds: 15);

  @override
  ConsumerState<WorkspaceFrame> createState() => _WorkspaceFrameState();
}

class _WorkspaceFrameState extends ConsumerState<WorkspaceFrame>
    with WidgetsBindingObserver {
  Timer? _pollTimer;
  Timer? _persistTimer;
  NewSessionLaunchRequest? _newSessionLaunch;

  /// Sidebar width when open. Kept meaningful while [_collapsed] so reopening
  /// restores the width the user last chose rather than the default.
  double _sidebarWidth = WorkspaceFrame.defaultSidebarWidth;

  /// Keep the sidebar closed during preference hydration to avoid flashing a
  /// saved collapsed layout. A first frame opens once hydration finishes.
  bool _collapsed = true;
  bool _drawerOpen = false;
  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();

  /// Raw pointer position during a drag, tracked separately from
  /// [_sidebarWidth] so clamping at the floor cannot swallow further leftward
  /// movement — that is what lets a slow drag still reach the collapse snap.
  double _dragWidth = WorkspaceFrame.defaultSidebarWidth;

  /// Width the in-flight collapse drag began from; reopening restores this
  /// rather than the floor the pointer dragged through.
  double _dragStartWidth = WorkspaceFrame.defaultSidebarWidth;

  final FocusNode _searchFocusNode = FocusNode(debugLabel: 'roster-search');

  bool get _drawerLayout =>
      MediaQuery.sizeOf(context).width <= WorkspaceFrame.drawerBreakpoint;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // The sidebar is on screen from the first frame on every destination, so
    // the frame, not the Sessions page, starts the roster.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) ref.read(sessionListControllerProvider.notifier).load();
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
        _collapsed = false;
        _sidebarWidth = WorkspaceFrame.defaultSidebarWidth;
      } else {
        _collapsed = saved.collapsed;
        _sidebarWidth = saved.width;
      }
      _dragWidth = _sidebarWidth;
      _dragStartWidth = _sidebarWidth;
    });
  }

  /// Clamps a sidebar width to its range, and never past
  /// `available - mainMinPaneWidth` so the main pane keeps a workable
  /// minimum. A window too narrow to satisfy both pins it to the floor.
  double _clampWidth(double width, double available) {
    var upper = WorkspaceFrame.maxSidebarWidth;
    final windowUpper = available - WorkspaceFrame.mainMinPaneWidth;
    if (windowUpper < upper) upper = windowUpper;
    if (upper < WorkspaceFrame.minSidebarWidth) {
      upper = WorkspaceFrame.minSidebarWidth;
    }
    return width.clamp(WorkspaceFrame.minSidebarWidth, upper);
  }

  void _onDragStart() {
    _dragStartWidth = _sidebarWidth;
    _dragWidth = _sidebarWidth;
  }

  void _onDragDelta(double dx, double available) {
    _dragWidth += dx;
    setState(() {
      if (_dragWidth < WorkspaceFrame.collapseSnapWidth) {
        if (!_collapsed) {
          _collapsed = true;
          _sidebarWidth = _dragStartWidth;
        }
        return;
      }
      _collapsed = false;
      _sidebarWidth = _clampWidth(_dragWidth, available);
    });
  }

  /// Reset to the default split — double-click on the sash, or Home.
  void _resetSplit() {
    setState(() {
      _collapsed = false;
      _sidebarWidth = WorkspaceFrame.defaultSidebarWidth;
      _dragWidth = _sidebarWidth;
    });
    _schedulePersist();
  }

  void _stepSplit(double delta, double available) {
    setState(() {
      _collapsed = false;
      _sidebarWidth = _clampWidth(_sidebarWidth + delta, available);
      _dragWidth = _sidebarWidth;
    });
    _schedulePersist();
  }

  void _expandSidebar() {
    setState(() {
      _collapsed = false;
      _dragWidth = _sidebarWidth;
    });
    _schedulePersist();
  }

  void _collapseSidebar() {
    if (_drawerLayout) {
      _scaffoldKey.currentState?.closeDrawer();
      return;
    }
    setState(() => _collapsed = true);
    _schedulePersist();
  }

  /// Debounces the write so a drag persists once it settles, not per pixel.
  void _schedulePersist() {
    _persistTimer?.cancel();
    _persistTimer = Timer(
      WorkspaceFrame.resizePersistDebounce,
      () => unawaited(_persistSplit()),
    );
  }

  Future<void> _persistSplit() async {
    if (!mounted) return;
    try {
      await ref
          .read(workspacePrefsStoreProvider)
          .saveRoster(
            WorkspaceRosterPrefs(width: _sidebarWidth, collapsed: _collapsed),
          );
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
      WorkspaceFrame.rosterPollInterval,
      (_) => _refreshNow(),
    );
  }

  void _refreshNow() {
    if (!mounted) return;
    unawaited(ref.read(sessionRosterResumeRefreshProvider)());
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

  void _openDrawer() => _scaffoldKey.currentState?.openDrawer();

  void _closeDrawer() => _scaffoldKey.currentState?.closeDrawer();

  /// Puts the caret in the roster's search field, opening the sidebar first.
  void _focusSearch() {
    if (!mounted) return;
    if (_drawerLayout) {
      _openDrawer();
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => _searchFocusNode.requestFocus(),
      );
      return;
    }
    if (_collapsed) {
      setState(() => _collapsed = false);
      unawaited(_persistSplit());
      // The field mounts with the sidebar, one frame from now.
      WidgetsBinding.instance.addPostFrameCallback(
        (_) => _searchFocusNode.requestFocus(),
      );
      return;
    }
    _searchFocusNode.requestFocus();
  }

  /// Whether the Sessions pane is showing its Overview: asked for, or no
  /// session tab is active to show instead.
  ///
  /// Watches only whether a tab is active, not which: switching between
  /// session tabs must not rebuild the frame and, with it, the sidebar.
  bool _overviewShowing() =>
      ref.watch(workspaceOverviewVisibleProvider) ||
      ref.watch(
        openSessionsControllerProvider.select(
          (open) => open.valueOrNull?.activeKey == null,
        ),
      );

  bool get _onSessions {
    final location = widget.location;
    return location == null || location.startsWith(sessionsRoute);
  }

  void _goSessions() {
    if (_onSessions) return;
    GoRouter.maybeOf(context)?.go(sessionsRoute);
  }

  void _showOverview() {
    _closeDrawer();
    ref.read(workspaceOverviewVisibleProvider.notifier).state = true;
    _goSessions();
  }

  void _openSession(SessionRef session) {
    _closeDrawer();
    ref.read(openSessionsControllerProvider.notifier).open(session);
    _goSessions();
  }

  void _go(String route) {
    _closeDrawer();
    GoRouter.maybeOf(context)?.go(route);
  }

  Future<void> _startNewSession({SessionProjectGroup? project}) async {
    _closeDrawer();
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
    _goSessions();
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

  Map<ShortcutActivator, AppShortcutHandler> _frameShortcuts({
    required bool canCreateSession,
  }) => {
    ...appShortcutBindings(
      specs: appShortcutsForScope(AppShortcutScope.workspace),
      handlers: {
        if (canCreateSession)
          AppShortcutId.newSession: () => unawaited(_startNewSession()),
      },
    ),
    ...appShortcutBindings(
      specs: appShortcutsForScope(AppShortcutScope.sessionList),
      handlers: {AppShortcutId.focusRosterSearch: _focusSearch},
    ),
  };

  @override
  Widget build(BuildContext context) {
    // Reload once a real broker client arrives: the active profile (notably the
    // web same-origin default) hydrates asynchronously and the first load can
    // race it. Also keep tab metadata live as the roster refreshes.
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
    final activeSource = RosterSource.of(
      ref.watch(activeBrokerProfileProvider),
    );
    final canCreateSession =
        ref.watch(sessionCreationReadyProvider).availabilityFor(activeSource) ==
        SessionCreationAvailability.available;
    final unreadCount = ref.watch(attentionUnreadCountProvider);
    final settingsAttention = ref.watch(nativeClientUpdateAvailableProvider);
    final location = widget.location ?? sessionsRoute;
    final destination = location.startsWith(attentionRoute)
        ? WorkspaceDestination.notifications
        : location.startsWith(settingsRoute)
        ? WorkspaceDestination.settings
        : location.startsWith(sessionsRoute) && _overviewShowing()
        ? WorkspaceDestination.overview
        : WorkspaceDestination.none;

    return LayoutBuilder(
      builder: (context, constraints) {
        final available = constraints.maxWidth;
        final drawerLayout = available <= WorkspaceFrame.drawerBreakpoint;
        final sidebarWidth = drawerLayout
            ? (available - 36).clamp(0.0, 320.0)
            : _clampWidth(_sidebarWidth, available);
        final footprint = drawerLayout
            ? 0.0
            : _collapsed
            ? workspaceCollapsedRailWidth
            : sidebarWidth + workspaceSashHitWidth;
        Widget sidebar(double width) => WorkspaceSidebar(
          width: width,
          destination: destination,
          drawer: drawerLayout,
          unreadCount: unreadCount,
          settingsAttention: settingsAttention,
          canCreateSession: canCreateSession,
          searchFocusNode: _searchFocusNode,
          onCollapse: _collapseSidebar,
          onNewSession: ({project}) =>
              unawaited(_startNewSession(project: project)),
          onOverview: _showOverview,
          onNotifications: () => _go(attentionRoute),
          onSettings: () => _go(settingsRoute),
          onServer: () => _go(brokerDevicesSettingsRoute),
          onOpenSession: _openSession,
          onRefresh: _refreshRequested,
        );
        return WorkspaceFrameScope(
          drawerLayout: drawerLayout,
          drawerOpen: _drawerOpen,
          sidebarFootprint: footprint,
          openDrawer: _openDrawer,
          startNewSession: canCreateSession
              ? () => unawaited(_startNewSession())
              : null,
          showOverview: _showOverview,
          child: PopScope<Object?>(
            canPop: !_drawerOpen,
            onPopInvokedWithResult: (didPop, result) {
              if (!didPop && _drawerOpen) _closeDrawer();
            },
            child: AppCallbackShortcuts(
              bindings: _frameShortcuts(canCreateSession: canCreateSession),
              child: Scaffold(
                key: _scaffoldKey,
                onDrawerChanged: (open) => setState(() => _drawerOpen = open),
                backgroundColor: tokens.canvas,
                drawer: drawerLayout
                    ? Drawer(
                        width: sidebarWidth,
                        backgroundColor: tokens.sidebar,
                        shape: const RoundedRectangleBorder(),
                        child: SafeArea(child: sidebar(sidebarWidth)),
                      )
                    : null,
                body: Stack(
                  fit: StackFit.expand,
                  children: [
                    Row(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        if (!drawerLayout)
                          SafeArea(
                            right: false,
                            child: _collapsed
                                ? WorkspaceCollapsedRosterRail(
                                    separatorColor: tokens.separator,
                                    unreadCount: unreadCount,
                                    unreadLabel: navBadgeLabel(unreadCount),
                                    settingsAttention: settingsAttention,
                                    onExpand: _expandSidebar,
                                    onNewSession: canCreateSession
                                        ? () => unawaited(_startNewSession())
                                        : null,
                                    onAttention: () => _go(attentionRoute),
                                    onSettings: () => _go(settingsRoute),
                                  )
                                : Row(
                                    children: [
                                      SizedBox(
                                        key: const Key('workspace-roster-pane'),
                                        width: sidebarWidth,
                                        child: sidebar(sidebarWidth),
                                      ),
                                      WorkspaceSplitSash(
                                        key: const Key('workspace-split-sash'),
                                        separatorColor: tokens.separator,
                                        onDragStart: _onDragStart,
                                        onDragDelta: (dx) =>
                                            _onDragDelta(dx, available),
                                        onDragEnd: _schedulePersist,
                                        onReset: _resetSplit,
                                        onStep: (delta) =>
                                            _stepSplit(delta, available),
                                      ),
                                    ],
                                  ),
                          ),
                        Expanded(
                          // Its own semantics container: the page is a
                          // branch Navigator, and every route's modal barrier
                          // carries a BlockSemantics that would otherwise drop
                          // the sidebar, painted before it, from assistive
                          // technology entirely.
                          child: Semantics(
                            container: true,
                            // The sidebar already consumed the leading inset.
                            child: MediaQuery.removePadding(
                              context: context,
                              removeLeft: !drawerLayout,
                              child: widget.child,
                            ),
                          ),
                        ),
                      ],
                    ),
                    if (_newSessionLaunch
                        case final NewSessionLaunchRequest request)
                      Positioned.fill(
                        child: SafeArea(
                          child: NewSessionLaunchPage(
                            key: ValueKey<NewSessionLaunchRequest>(request),
                            request: request,
                            onCreate: (request) => ref
                                .read(newSessionLaunchServiceProvider)
                                .create(request),
                            onOpen: _prepareCreatedSessionDestination,
                            onConnect: _prepareCreatedSessionConnection,
                            onComplete: _openCreatedSession,
                            onBack: _finishNewSessionLaunch,
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
          ),
        );
      },
    );
  }
}

/// What a page inside the [WorkspaceFrame] can ask of it.
class WorkspaceFrameScope extends InheritedWidget {
  /// Publishes the frame's state and actions to [child].
  const WorkspaceFrameScope({
    required this.drawerLayout,
    required this.drawerOpen,
    required this.sidebarFootprint,
    required this.openDrawer,
    required this.startNewSession,
    required this.showOverview,
    required super.child,
    super.key,
  });

  /// Whether the sidebar is a modal drawer at this width.
  final bool drawerLayout;

  /// Whether that drawer is open now.
  final bool drawerOpen;

  /// Width the sidebar (pane plus sash, or its rail) takes from the window.
  final double sidebarFootprint;

  /// Opens the drawer on drawer layouts.
  final VoidCallback openDrawer;

  /// Starts New session, or null while creation is unavailable.
  final VoidCallback? startNewSession;

  /// Shows the Overview in the Sessions pane.
  final VoidCallback showOverview;

  /// The nearest frame, or null outside one.
  static WorkspaceFrameScope? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<WorkspaceFrameScope>();

  /// The drawer button a top-level page puts in its app bar, or null where the
  /// sidebar is already on screen (or there is no frame).
  static Widget? menuButton(BuildContext context) {
    final frame = maybeOf(context);
    if (frame == null || !frame.drawerLayout) return null;
    return IconButton(
      key: const Key('workspace-frame-menu'),
      tooltip: MaterialLocalizations.of(context).openAppDrawerTooltip,
      onPressed: frame.openDrawer,
      icon: const StrokeIcon(StrokeGlyph.menu),
    );
  }

  @override
  bool updateShouldNotify(WorkspaceFrameScope oldWidget) =>
      oldWidget.drawerLayout != drawerLayout ||
      oldWidget.drawerOpen != drawerOpen ||
      oldWidget.sidebarFootprint != sidebarFootprint ||
      (oldWidget.startNewSession == null) != (startNewSession == null);
}
