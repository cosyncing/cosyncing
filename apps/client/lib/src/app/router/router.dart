import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/nav_badge_label.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/app/router/session_routes.dart';
import 'package:cosyncing_client/src/app/shortcuts/app_shortcuts.dart';
import 'package:cosyncing_client/src/design/ui_scale.dart';
import 'package:cosyncing_client/src/design/window_size_class.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_inbox_controller.dart';
import 'package:cosyncing_client/src/features/attention/view/attention_page.dart';
import 'package:cosyncing_client/src/features/broker_profiles/view/broker_profiles_page.dart';
import 'package:cosyncing_client/src/features/connection/view/connection_page.dart';
import 'package:cosyncing_client/src/features/pairing/view/pairing_page.dart';
import 'package:cosyncing_client/src/features/schedules/view/schedule_manager_page.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_page.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_file_page.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/list/sessions_branch_screen.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_pane_body.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/file_panes_controller.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_pane_key.dart';
import 'package:cosyncing_client/src/features/settings/controller/ui_scale_controller.dart';
import 'package:cosyncing_client/src/features/settings/view/agents_settings_page.dart';
import 'package:cosyncing_client/src/features/settings/view/appearance_settings_page.dart';
import 'package:cosyncing_client/src/features/settings/view/broker_devices_settings_page.dart';
import 'package:cosyncing_client/src/features/settings/view/display_settings_page.dart';
import 'package:cosyncing_client/src/features/settings/view/general_settings_page.dart';
import 'package:cosyncing_client/src/features/settings/view/keyboard_shortcuts_page.dart';
import 'package:cosyncing_client/src/features/settings/view/notification_settings_page.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_page.dart';
import 'package:cosyncing_client/src/features/settings/view/tool_display_settings_page.dart';
import 'package:cosyncing_client/src/features/transfers/view/transfer_manager_page.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

const double _wideNavigationBreakpoint = 840;

const String _appMenuLabel = 'Cosyncing';

const List<_AppRouteNavItem> _appRouteNavItems = [
  _AppRouteNavItem(
    label: _AppRouteLabel.sessions,
    route: sessionsRoute,
    menuShortcut: SingleActivator(LogicalKeyboardKey.digit1, meta: true),
    shellShortcut: SingleActivator(LogicalKeyboardKey.digit1, control: true),
    role: _AppRouteRole.primary,
  ),
  _AppRouteNavItem(
    label: _AppRouteLabel.notifications,
    route: attentionRoute,
    menuShortcut: SingleActivator(LogicalKeyboardKey.digit2, meta: true),
    shellShortcut: SingleActivator(LogicalKeyboardKey.digit2, control: true),
    role: _AppRouteRole.primary,
  ),
  _AppRouteNavItem(
    label: _AppRouteLabel.connection,
    route: connectionRoute,
    menuShortcut: SingleActivator(LogicalKeyboardKey.digit3, meta: true),
    shellShortcut: SingleActivator(LogicalKeyboardKey.digit3, control: true),
    role: _AppRouteRole.primary,
  ),
  _AppRouteNavItem(
    label: _AppRouteLabel.settings,
    route: settingsRoute,
    menuShortcut: SingleActivator(LogicalKeyboardKey.digit4, meta: true),
    shellShortcut: SingleActivator(LogicalKeyboardKey.digit4, control: true),
    role: _AppRouteRole.primary,
  ),
  _AppRouteNavItem(
    label: _AppRouteLabel.transfers,
    route: transfersRoute,
    menuShortcut: SingleActivator(LogicalKeyboardKey.digit5, meta: true),
    shellShortcut: SingleActivator(LogicalKeyboardKey.digit5, control: true),
    role: _AppRouteRole.primary,
  ),
  _AppRouteNavItem(
    label: _AppRouteLabel.brokerProfiles,
    route: brokerProfilesRoute,
    role: _AppRouteRole.secondary,
  ),
  _AppRouteNavItem(
    label: _AppRouteLabel.pairing,
    route: pairingRoute,
    role: _AppRouteRole.secondary,
  ),
  _AppRouteNavItem(
    label: _AppRouteLabel.keyboardShortcuts,
    route: keyboardShortcutsRoute,
    role: _AppRouteRole.secondary,
  ),
];

class _AppRouteNavItem {
  const _AppRouteNavItem({
    required this.label,
    required this.route,
    required this.role,
    this.menuShortcut,
    this.shellShortcut,
  });

  final _AppRouteLabel label;
  final String route;
  final _AppRouteRole role;
  final SingleActivator? menuShortcut;
  final SingleActivator? shellShortcut;
}

enum _AppRouteRole { primary, secondary }

enum _AppRouteLabel {
  sessions,
  notifications,
  connection,
  settings,
  transfers,
  brokerProfiles,
  pairing,
  keyboardShortcuts,
}

String _localizedRouteLabel(AppLocalizations l10n, _AppRouteLabel label) {
  return switch (label) {
    _AppRouteLabel.sessions => l10n.sessionsTitle,
    _AppRouteLabel.notifications => l10n.notificationsTitle,
    _AppRouteLabel.connection => l10n.connectionTitle,
    _AppRouteLabel.settings => l10n.settingsTitle,
    _AppRouteLabel.transfers => l10n.transfersTitle,
    _AppRouteLabel.brokerProfiles => l10n.brokerProfilesTitle,
    _AppRouteLabel.pairing => l10n.pairingTitle,
    _AppRouteLabel.keyboardShortcuts => l10n.keyboardShortcutsTitle,
  };
}

/// Top-level router for the app.
///
/// Placeholder routes — real navigation will be driven by
/// session state and deep links in later modules.
final GoRouter goRouter = createGoRouter();

/// Creates an app router instance.
///
/// Widget tests should use a fresh router instance to avoid carrying navigation
/// state across tests.
GoRouter createGoRouter({String initialLocation = sessionsRoute}) {
  return GoRouter(
    initialLocation: initialLocation,
    routes: [
      ShellRoute(
        builder: (context, state, child) => _AppCommandShell(child: child),
        routes: [
          StatefulShellRoute.indexedStack(
            builder: (context, state, navigationShell) {
              return _ScaffoldWithNav(navigationShell: navigationShell);
            },
            branches: [
              StatefulShellBranch(
                routes: [
                  GoRoute(
                    path: sessionsRoute,
                    builder: (context, state) => const SessionsBranchScreen(),
                    routes: [
                      GoRoute(
                        path: ':tool/:id',
                        // On Expanded width the detail is a workspace pane; a
                        // deep link opens a tab and collapses to /sessions.
                        // Compact/Medium keep today's push route.
                        redirect: (context, state) {
                          // Route-level redirects run root-first and the first
                          // non-null wins, so redirecting here would swallow
                          // every child of this route -- the file drill-in
                          // would lose its path and land on the roster. Stand
                          // down unless this route is the leaf.
                          if (state.matchedLocation != state.uri.path) {
                            return null;
                          }
                          if (!_expandedShowsWorkspace(context)) {
                            return null;
                          }
                          final tool = state.pathParameters['tool'] ?? '';
                          final id = state.pathParameters['id'] ?? '';
                          if (tool.isEmpty || id.isEmpty) {
                            return null;
                          }
                          _openSessionTab(context, tool: tool, id: id);
                          return sessionsRoute;
                        },
                        builder: (context, state) {
                          final tool = state.pathParameters['tool'] ?? '';
                          final sessionId = state.pathParameters['id'] ?? '';
                          return SessionDetailPage(
                            key: ValueKey<SessionDetailKey>(
                              SessionDetailKey(
                                tool: tool,
                                sessionId: sessionId,
                              ),
                            ),
                            tool: tool,
                            sessionId: sessionId,
                          );
                        },
                        routes: [
                          GoRoute(
                            path: 'file',
                            // At expanded width the file belongs beside its
                            // session, not over it, so the route resolves into
                            // the second pane and collapses to /sessions --
                            // the same shape the detail route uses, and the
                            // reason the second pane never enters the URL.
                            redirect: (context, state) {
                              final tool = state.pathParameters['tool'] ?? '';
                              final id = state.pathParameters['id'] ?? '';
                              final path = state.uri.queryParameters['path'];
                              // A file route naming no file is the session it
                              // belongs to. Left alone it read the workspace
                              // root, which the broker refuses as
                              // NOT_REGULAR_FILE, so a truncated link landed
                              // on an error panel instead of the session the
                              // rest of the URL already names.
                              if ((path == null || path.isEmpty) &&
                                  tool.isNotEmpty &&
                                  id.isNotEmpty) {
                                return sessionDetailLocation(
                                  tool: tool,
                                  sessionId: id,
                                );
                              }
                              if (!_expandedShowsWorkspace(context)) {
                                return null;
                              }
                              if (tool.isEmpty ||
                                  id.isEmpty ||
                                  path == null ||
                                  path.isEmpty) {
                                return null;
                              }
                              _openSessionTab(context, tool: tool, id: id);
                              _openFilePane(
                                context,
                                tool: tool,
                                id: id,
                                path: path,
                                line: int.tryParse(
                                  state.uri.queryParameters['line'] ?? '',
                                ),
                              );
                              return sessionsRoute;
                            },
                            builder: (context, state) {
                              final path =
                                  state.uri.queryParameters['path'] ?? '';
                              final tool = state.pathParameters['tool'] ?? '';
                              final id = state.pathParameters['id'] ?? '';
                              return SessionFilePage(
                                key: ValueKey<String>('$tool/$id#$path'),
                                tool: tool,
                                sessionId: id,
                                path: path,
                                line: int.tryParse(
                                  state.uri.queryParameters['line'] ?? '',
                                ),
                              );
                            },
                          ),
                        ],
                      ),
                    ],
                  ),
                ],
              ),
              StatefulShellBranch(
                routes: [
                  GoRoute(
                    path: attentionRoute,
                    builder: (context, state) =>
                        AttentionPage(showSessionsBack: _isWideLayout(context)),
                  ),
                ],
              ),
              StatefulShellBranch(
                routes: [
                  GoRoute(
                    path: connectionRoute,
                    builder: (context, state) => ConnectionPage(
                      showSessionsBack: _isWideLayout(context),
                    ),
                  ),
                ],
              ),
              StatefulShellBranch(
                routes: [
                  GoRoute(
                    path: settingsRoute,
                    builder: (context, state) =>
                        SettingsPage(showSessionsBack: _isWideLayout(context)),
                    routes: [
                      // Category pages (layer two of the Settings hierarchy).
                      GoRoute(
                        path: 'display',
                        builder: (context, state) =>
                            const DisplaySettingsPage(),
                      ),
                      GoRoute(
                        path: 'notifications',
                        builder: (context, state) =>
                            const NotificationSettingsPage(),
                      ),
                      GoRoute(
                        path: 'broker-devices',
                        builder: (context, state) =>
                            const BrokerDevicesSettingsPage(),
                      ),
                      GoRoute(
                        path: 'agents',
                        builder: (context, state) => const AgentsSettingsPage(),
                      ),
                      GoRoute(
                        path: 'general',
                        builder: (context, state) =>
                            const GeneralSettingsPage(),
                      ),
                      // Leaf pages. These predate the hierarchy and keep their
                      // original paths so existing deep links stay valid.
                      GoRoute(
                        path: 'appearance',
                        builder: (context, state) =>
                            const AppearanceSettingsPage(),
                      ),
                      GoRoute(
                        path: 'tool-display',
                        builder: (context, state) =>
                            const ToolDisplaySettingsPage(),
                      ),
                      GoRoute(
                        path: 'scheduled-sends',
                        builder: (context, state) =>
                            const ScheduleManagerPage(),
                      ),
                      GoRoute(
                        path: 'broker-profiles',
                        builder: (context, state) => const BrokerProfilesPage(),
                      ),
                      GoRoute(
                        path: 'keyboard-shortcuts',
                        builder: (context, state) =>
                            const KeyboardShortcutsPage(),
                      ),
                      GoRoute(
                        path: 'pairing',
                        builder: (context, state) => const PairingPage(),
                      ),
                    ],
                  ),
                ],
              ),
            ],
          ),
          GoRoute(
            path: transfersRoute,
            builder: (context, state) =>
                TransferManagerPage(showSessionsBack: _isWideLayout(context)),
          ),
        ],
      ),
    ],
  );
}

/// Whether the current window is at Expanded (two-pane workspace) width.
///
/// Used from the deep-link redirect, where a full [MediaQuery] may be absent;
/// falls back to the render [View] size, then to `false` (Compact push nav,
/// which always works).
bool _expandedShowsWorkspace(BuildContext context) {
  final media = MediaQuery.maybeOf(context);
  if (media != null) {
    return WindowSizeClass.fromWidth(media.size.width).showListDetail;
  }
  final view = View.maybeOf(context);
  if (view != null) {
    final width = view.physicalSize.width / view.devicePixelRatio;
    return WindowSizeClass.fromWidth(width).showListDetail;
  }
  return false;
}

bool _isWideLayout(BuildContext context) =>
    MediaQuery.sizeOf(context).width >= _wideNavigationBreakpoint;

/// Opens a deep-linked session as a tab in the workspace working set.
///
/// Uses the roster's title/status when the session is already loaded, otherwise
/// a placeholder the workspace refreshes once the roster arrives. Deferred to a
/// post-frame callback so the redirect stays free of build-phase mutations.
/// Opens a deep-linked file as a pane in the workspace working set.
///
/// Mirrors [_openSessionTab], and deferred for the same reason: a redirect
/// runs inside the router's build, where a provider mutation is rejected.
void _openFilePane(
  BuildContext context, {
  required String tool,
  required String id,
  required String path,
  int? line,
}) {
  final container = ProviderScope.containerOf(context, listen: false);
  final session = SessionDetailKey(tool: tool, sessionId: id);
  WidgetsBinding.instance.addPostFrameCallback((_) {
    if (line != null) {
      final pane = FilePaneKey(session: session, path: path);
      container
          .read(filePaneAnchorProvider.notifier)
          .update((anchors) => {...anchors, pane.key: line});
    }
    unawaited(
      container.read(filePanesControllerProvider.notifier).open(session, path),
    );
  });
}

void _openSessionTab(
  BuildContext context, {
  required String tool,
  required String id,
}) {
  final container = ProviderScope.containerOf(context, listen: false);
  final roster = container.read(sessionListControllerProvider).sessions;
  SessionInfo? match;
  for (final session in roster) {
    if (session.tool == tool && session.id == id) {
      match = session;
      break;
    }
  }
  final SessionRef ref;
  if (match != null) {
    ref = SessionRef.fromSession(match);
  } else {
    // A deep link that lands before the roster resolves knows the identity and
    // nothing else. Keep the title the working set already carries — a restored
    // or cached tab has a real one — and make no status claim; the workspace
    // fills both in from the authoritative roster.
    final open = container.read(openSessionsControllerProvider).valueOrNull;
    String? knownTitle;
    for (final candidate in open?.refs ?? const <SessionRef>[]) {
      if (candidate.key == '$tool/$id') {
        knownTitle = candidate.title;
        break;
      }
    }
    ref = SessionRef.cachedIdentity(
      tool: tool,
      id: id,
      title: knownTitle ?? id,
    );
  }
  WidgetsBinding.instance.addPostFrameCallback((_) {
    // Wait for the working set to finish restoring before adding to it. The
    // controller's mutations write `state` synchronously, so one applied while
    // build() is still in flight is overwritten the moment the restore
    // resolves — and a deep link is precisely the case that arrives first, so
    // the tab it opened would be dropped every time.
    //
    // That is only half the race, and the controller owns the other half: on a
    // cold start this future resolves against a build that has no broker
    // source yet, and the profile's arrival rebuilds over it. `open` holds the
    // request until a build has a source rather than dropping it here.
    unawaited(
      container.read(openSessionsControllerProvider.future).then((_) {
        container.read(openSessionsControllerProvider.notifier).open(ref);
      }),
    );
  });
}

/// Whether the host browser owns zoom instead of the app's `UiTextScale`.
///
/// On web the browser owns Ctrl/Cmd +/- , Ctrl/Cmd+0 and Ctrl/Cmd+wheel: it
/// scales the whole page, unbounded, which is the wanted behavior. The app
/// therefore must not intercept those on web, where doing so would trap the
/// events on a text-only, clamped `UiTextScale` step (and, over the transcript,
/// do nothing at all because `Scrollable` claims the wheel first). On native
/// desktop there is no browser, so the keyboard and wheel handlers stay bound
/// and `UiTextScale` is the only zoom.
///
/// This is the same question as every other reserved chord, so it reads the one
/// flag in `app/shortcuts/app_shortcuts.dart` rather than a private copy;
/// `debugWebReservedChordsOverride` drives the web branch in tests.
bool get _browserOwnsZoom => appShortcutsWebReserved;

/// Releases every key [HardwareKeyboard] still believes is pressed by feeding
/// it synthesized key-ups.
///
/// [HardwareKeyboard.clearState] is not an option here: it is
/// `@visibleForTesting`, does not synthesize cancel key-ups, and clears the
/// registered handler list along with the pressed keys (dropping, for example,
/// an open [MenuAnchor]'s keyboard handler). Synthesized key-ups clear only
/// the pressed-key state and notify handlers through the normal dispatch path.
void _releaseLatchedKeyboardKeys() {
  final keyboard = HardwareKeyboard.instance;
  // physicalKeysPressed returns a copy, so mutating the pressed-key map via
  // handleKeyEvent while iterating is safe.
  for (final physicalKey in keyboard.physicalKeysPressed) {
    final logicalKey = keyboard.lookUpLayout(physicalKey);
    if (logicalKey == null) {
      continue;
    }
    keyboard.handleKeyEvent(
      KeyUpEvent(
        physicalKey: physicalKey,
        logicalKey: logicalKey,
        timeStamp: Duration.zero,
        synthesized: true,
      ),
    );
  }
}

/// Clears modifier state [HardwareKeyboard] latched while the app is unfocused.
///
/// Switching a Windows virtual desktop with Ctrl+Win+Arrow moves focus away
/// before the Ctrl key-up is delivered, so `HardwareKeyboard.isControlPressed`
/// stays latched true and the next plain wheel scroll is misread as
/// Ctrl+scroll text zoom ([_AppCommandShell._handlePointerSignal]); the
/// composer's send chord and the attachment paste chord read the same latched
/// state. Desktop window blur maps to `AppLifecycleState.inactive` (followed
/// by `hidden`), so both callbacks release the latched keys. On platforms
/// where neither lifecycle event fires on blur, nothing changes.
class _LatchedKeyboardStateGuard extends StatefulWidget {
  const _LatchedKeyboardStateGuard({required this.child});

  final Widget child;

  @override
  State<_LatchedKeyboardStateGuard> createState() =>
      _LatchedKeyboardStateGuardState();
}

class _LatchedKeyboardStateGuardState
    extends State<_LatchedKeyboardStateGuard> {
  late final AppLifecycleListener _lifecycle;

  @override
  void initState() {
    super.initState();
    _lifecycle = AppLifecycleListener(
      onInactive: _releaseLatchedKeyboardKeys,
      onHide: _releaseLatchedKeyboardKeys,
    );
  }

  @override
  void dispose() {
    _lifecycle.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// App-level shell for broker-independent shortcuts and platform menus.
///
/// See `docs/architecture/client-ui.md`.
class _AppCommandShell extends ConsumerWidget {
  const _AppCommandShell({required this.child});

  final Widget child;

  /// Steps the app text size, sharing one implementation with the keyboard and
  /// Ctrl+wheel paths so clamping lives in exactly one place.
  ///
  /// The ambient [TextScaler] is read here rather than in the controller: this
  /// shell sits below `MaterialApp.builder`, so while the user is still on
  /// `UiTextScale.system` the scaler it sees is the untouched OS one.
  void _stepTextScale(BuildContext context, WidgetRef ref, int direction) {
    final ambient = MediaQuery.maybeTextScalerOf(context);
    unawaited(
      ref
          .read(uiScaleControllerProvider.notifier)
          .stepTextScale(direction, ambientFactor: ambient?.scale(1)),
    );
  }

  /// Pins the app text size back to [UiTextScale.standard] — Chrome's Ctrl+0,
  /// the third of the zoom triad.
  ///
  /// An absolute set, not a step, so it never has to resolve `system` against
  /// an ambient scaler first. Like stepping, it leaves "follow the OS" behind
  /// and pins a concrete size; the appearance settings restore it.
  void _resetTextScale(WidgetRef ref) {
    unawaited(
      ref
          .read(uiScaleControllerProvider.notifier)
          .setTextScale(UiTextScale.standard),
    );
  }

  /// Handles Ctrl/Cmd+wheel as a text-size step.
  ///
  /// Unmodified scrolling is left completely alone — without the zoom modifier
  /// this returns before touching the event, so every scrollable behaves
  /// exactly as before. Note that [Listener] observes pointer signals from
  /// above the hit-tested [Scrollable], which registers with
  /// [PointerSignalResolver] first and therefore still consumes the modified
  /// scroll as well; a Ctrl+wheel over a list both resizes text and nudges the
  /// list. Suppressing that would mean swapping in
  /// [NeverScrollableScrollPhysics] whenever Control is held, which would
  /// rebuild the whole app on every unrelated Ctrl shortcut.
  void _handlePointerSignal(
    BuildContext context,
    WidgetRef ref,
    PointerSignalEvent event,
  ) {
    if (event is! PointerScrollEvent) {
      return;
    }
    final keyboard = HardwareKeyboard.instance;
    if (!keyboard.isControlPressed && !keyboard.isMetaPressed) {
      return;
    }
    final delta = event.scrollDelta.dy;
    if (delta == 0) {
      return;
    }
    // Browser convention: wheel up (negative delta) enlarges.
    _stepTextScale(context, ref, delta < 0 ? 1 : -1);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // On web the browser owns zoom (Ctrl/Cmd +/- and Ctrl/Cmd+wheel), so the
    // app must not intercept it; on native desktop UiTextScale is the only
    // zoom and stays bound. See [_browserOwnsZoom].
    final browserOwnsZoom = _browserOwnsZoom;
    final l10n = AppLocalizations.of(context);

    // App-level navigation shortcuts are shell-scoped, not tool-aware.
    // See `docs/architecture/client-ui.md`.
    final shortcutBindings = <ShortcutActivator, AppShortcutHandler>{
      for (final item in _appRouteNavItems)
        if (item.role == _AppRouteRole.primary)
          if (item.shellShortcut != null)
            item.shellShortcut!: appShortcutAlways(
              () => context.go(item.route),
            ),
      for (final item in _appRouteNavItems)
        if (item.role == _AppRouteRole.primary)
          if (item.menuShortcut != null)
            item.menuShortcut!: appShortcutAlways(
              () => context.go(item.route),
            ),
      // Text size comes from the registry, which carries only native
      // activators for it: on web the browser owns the whole triad and these
      // contribute nothing.
      ...appShortcutBindings(
        specs: appShortcutsForScope(AppShortcutScope.global),
        handlers: {
          AppShortcutId.increaseTextSize: () => _stepTextScale(context, ref, 1),
          AppShortcutId.decreaseTextSize: () =>
              _stepTextScale(context, ref, -1),
          AppShortcutId.resetTextSize: () => _resetTextScale(ref),
        },
        webReserved: browserOwnsZoom,
      ),
    };

    final Widget shellChild = Focus(
      autofocus: true,
      child: FocusScope(
        // On web the browser handles Ctrl/Cmd+wheel zoom; only install the
        // pointer-signal text-scale step on native platforms.
        child: browserOwnsZoom
            ? child
            : Listener(
                onPointerSignal: (event) =>
                    _handlePointerSignal(context, ref, event),
                child: child,
              ),
      ),
    );

    final menuBar = PlatformMenuBar(
      menus: [
        PlatformMenu(
          label: _appMenuLabel,
          menus: [
            for (final item in _appRouteNavItems)
              PlatformMenuItem(
                label: _localizedRouteLabel(l10n, item.label),
                shortcut: item.menuShortcut,
                onSelected: () => context.go(item.route),
              ),
          ],
        ),
      ],
      child: AppCallbackShortcuts(
        bindings: shortcutBindings,
        child: shellChild,
      ),
    );

    return _LatchedKeyboardStateGuard(child: menuBar);
  }
}

/// Shell scaffold with a bottom navigation bar for the three
/// top-level destinations.
class _ScaffoldWithNav extends StatelessWidget {
  const _ScaffoldWithNav({required this.navigationShell});

  final StatefulNavigationShell navigationShell;

  @override
  Widget build(BuildContext context) {
    final isWideLayout =
        MediaQuery.of(context).size.width >= _wideNavigationBreakpoint;
    // Session detail is a drilled-in view, not a top-level destination. On
    // compact layouts it owns the full viewport so the composer keeps its
    // vertical space; the AppBar back button is the way out. Wide layouts are
    // unaffected — they already have no bottom navigation.
    final isDrilledIn = isDrilledInSessionLocation(
      GoRouterState.of(context).uri.path,
    );
    final showBottomNav = !isWideLayout && !isDrilledIn;

    return Scaffold(
      body: navigationShell,
      bottomNavigationBar: showBottomNav
          ? _CompactBottomNav(navigationShell: navigationShell)
          : null,
    );
  }
}

class _CompactBottomNav extends ConsumerWidget {
  const _CompactBottomNav({required this.navigationShell});

  final StatefulNavigationShell navigationShell;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final l10n = AppLocalizations.of(context);
    final unreadCount = ref.watch(attentionUnreadCountProvider);
    const branchIndexes = <int>[0, 1, 3];
    final displayedIndex = branchIndexes.indexOf(
      navigationShell.currentIndex,
    );
    return NavigationBar(
      key: const Key('app-bottom-nav'),
      // `/connection` remains a compact deep/recovery route, but is no longer
      // a destination. Leave Sessions selected while that branch is showing;
      // every actual destination derives its index from [branchIndexes].
      selectedIndex: displayedIndex < 0 ? 0 : displayedIndex,
      onDestinationSelected: (index) {
        final branchIndex = branchIndexes[index];
        navigationShell.goBranch(
          branchIndex,
          initialLocation: branchIndex == navigationShell.currentIndex,
        );
      },
      destinations: [
        NavigationDestination(
          icon: const Icon(Icons.terminal_outlined),
          selectedIcon: const Icon(Icons.terminal),
          label: l10n.sessionsTitle,
        ),
        NavigationDestination(
          icon: Badge(
            isLabelVisible: unreadCount > 0,
            label: Text(navBadgeLabel(unreadCount)),
            child: const Icon(Icons.notifications_outlined),
          ),
          selectedIcon: Badge(
            isLabelVisible: unreadCount > 0,
            label: Text(navBadgeLabel(unreadCount)),
            child: const Icon(Icons.notifications),
          ),
          label: l10n.notificationsTitle,
        ),
        NavigationDestination(
          icon: const Icon(Icons.settings_outlined),
          selectedIcon: const Icon(Icons.settings),
          label: l10n.settingsTitle,
        ),
      ],
    );
  }
}
