import 'dart:io';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/router.dart';
import 'package:cosyncing_client/src/app/router/session_routes.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/design/ui_scale.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_runtime.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_inbox_controller.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_feed_settings_store.dart';
import 'package:cosyncing_client/src/features/attention/data/remote_wake_settings_store.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_inbox.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:cosyncing_client/src/features/sessions/data/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/data/workspace_prefs_store.dart';
import 'package:cosyncing_client/src/features/sessions/view/session_detail_page.dart';
import 'package:cosyncing_client/src/features/sessions/view/sessions_workspace.dart';
import 'package:cosyncing_client/src/features/settings/data/session_display_preferences_store.dart';
import 'package:cosyncing_client/src/features/settings/data/session_notification_settings_store.dart';
import 'package:cosyncing_client/src/features/settings/data/ui_preferences_store.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

import '../../../support/in_memory_session_display_preferences_store.dart';
import '../../../support/in_memory_session_live_state_view_store.dart';

void main() {
  group('session routes', () {
    test('builds deep-link-safe session detail locations', () {
      final location = sessionDetailLocation(
        tool: 'claude code/pro?%',
        sessionId: 'session / # ? % 你好',
      );

      expect(
        location,
        '/sessions/claude%20code%2Fpro%3F%25/'
        'session%20%2F%20%23%20%3F%20%25%20%E4%BD%A0%E5%A5%BD',
      );
    });

    test('recognizes session detail locations', () {
      expect(isSessionDetailLocation('/sessions/claude/session-a'), isTrue);
      expect(
        isSessionDetailLocation(
          sessionDetailLocation(tool: 'claude code/pro', sessionId: 'a/b'),
        ),
        isTrue,
      );
    });

    test('does not mistake other locations for session detail', () {
      expect(isSessionDetailLocation('/sessions'), isFalse);
      expect(isSessionDetailLocation('/attention'), isFalse);
      expect(isSessionDetailLocation('/settings/keyboard-shortcuts'), isFalse);
      expect(isSessionDetailLocation('/transfers'), isFalse);
    });

    test('session widgets use centralized route helpers', () {
      final source = File(
        'lib/src/features/sessions/view/sessions_page.dart',
      ).readAsStringSync();

      expect(source, isNot(contains("context.go('/sessions/")));
      expect(source, contains('sessionDetailLocation('));
    });
  });

  group('goRouter', () {
    Future<GoRouter> pumpApp(
      WidgetTester tester, {
      Size? surfaceSize,
      String initialLocation = '/sessions',
      List<Override> overrides = const [],
    }) async {
      if (surfaceSize != null) {
        tester.view
          ..physicalSize = surfaceSize
          ..devicePixelRatio = 1;
        addTearDown(() {
          tester.view.resetPhysicalSize();
          tester.view.resetDevicePixelRatio();
        });
      }

      final router = createGoRouter(initialLocation: initialLocation);
      await tester.pumpWidget(
        ProviderScope(
          overrides: [
            sessionNotificationSettingsStoreProvider.overrideWithValue(
              _InMemorySessionNotificationSettingsStore(),
            ),
            attentionInboxProvider.overrideWith(
              (_) async => AttentionInboxSections.fromEntries(const []),
            ),
            attentionFeedSettingsStoreProvider.overrideWithValue(
              _InMemoryAttentionFeedSettingsStore(),
            ),
            remoteWakeSettingsStoreProvider.overrideWithValue(
              _InMemoryRemoteWakeSettingsStore(),
            ),
            brokerProfileRepositoryProvider.overrideWithValue(
              _InMemoryBrokerProfileRepository(),
            ),
            activeBrokerProfileHydrationProvider.overrideWith((_) async {}),
            sessionListRepositoryProvider.overrideWith(
              (_) async => InMemorySessionListRepository(),
            ),
            // The Expanded /sessions workspace persists its tabs; keep it off the
            // real Drift database in these shell tests.
            openSessionsStoreProvider.overrideWithValue(
              _InMemoryOpenSessionsStore(),
            ),
            sessionLiveStateViewStoreProvider.overrideWithValue(
              InMemorySessionLiveStateViewStore(),
            ),
            sessionDisplayPreferencesStoreProvider.overrideWithValue(
              InMemorySessionDisplayPreferencesStore(),
            ),
            workspacePrefsStoreProvider.overrideWithValue(
              _InMemoryWorkspacePrefsStore(),
            ),
            ...overrides,
          ],
          child: MaterialApp.router(
            theme: ThemeData(
              splashFactory: InkRipple.splashFactory,
              extensions: <ThemeExtension<dynamic>>[
                themeSpecById(kDefaultThemeId).light,
              ],
            ),
            // Settings embeds the fully localized connection gate, so routed
            // screens need the real delegates just as they have them under App.
            localizationsDelegates: AppLocalizations.localizationsDelegates,
            supportedLocales: AppLocalizations.supportedLocales,
            routerConfig: router,
          ),
        ),
      );
      await tester.pumpAndSettle();
      return router;
    }

    /// Opens a Settings category from the hub.
    ///
    /// Settings is two layers deep: the hub lists categories, and the controls
    /// live on the category page. Tests that used to tap a control straight off
    /// the Settings root now step through the category that owns it.
    Future<void> openSettingsCategory(WidgetTester tester, Key category) async {
      final tile = find.byKey(category);
      await tester.scrollUntilVisible(
        tile,
        400,
        scrollable: find.byType(Scrollable).last,
      );
      await tester.pumpAndSettle();
      await tester.tap(tile);
      await tester.pumpAndSettle();
    }

    test('has expected initial location', () {
      expect(goRouter.configuration.routes, isNotEmpty);
    });

    testWidgets('session-to-session navigation replaces detail State', (
      tester,
    ) async {
      final router = await pumpApp(
        tester,
        surfaceSize: const Size(500, 900),
        initialLocation: '/sessions/claude/session-a',
        overrides: [
          sessionArtifactTransferRepositoryProvider.overrideWithValue(
            InMemorySessionArtifactTransferRepository(),
          ),
        ],
      );

      final firstFinder = find.byType(SessionDetailPage);
      final firstPage = tester.widget<SessionDetailPage>(firstFinder);
      final firstState = tester.state(firstFinder);
      expect(firstPage.sessionId, 'session-a');
      expect(
        firstPage.key,
        const ValueKey<SessionDetailKey>(
          SessionDetailKey(tool: 'claude', sessionId: 'session-a'),
        ),
      );

      router.go('/sessions/claude/session-b');
      await tester.pumpAndSettle();

      final secondFinder = find.byType(SessionDetailPage);
      final secondPage = tester.widget<SessionDetailPage>(secondFinder);
      expect(secondPage.sessionId, 'session-b');
      expect(
        secondPage.key,
        const ValueKey<SessionDetailKey>(
          SessionDetailKey(tool: 'claude', sessionId: 'session-b'),
        ),
      );
      expect(tester.state(secondFinder), isNot(same(firstState)));
    });

    testWidgets(
      'leaving the stateful Sessions branch releases its visible-session claim',
      (tester) async {
        final profile = BrokerProfile(
          id: 'attention-source',
          displayName: 'Attention source',
          baseUri: Uri.parse('http://127.0.0.1:7734'),
          createdAt: DateTime(2026),
          incarnationId: 'inc-a',
        );
        final router = await pumpApp(
          tester,
          surfaceSize: const Size(500, 900),
          initialLocation: '/sessions/claude/session-a',
          overrides: [
            brokerClientProvider.overrideWith((_) async => null),
            sessionArtifactTransferRepositoryProvider.overrideWithValue(
              InMemorySessionArtifactTransferRepository(),
            ),
          ],
        );
        final detail = find.byType(SessionDetailPage);
        final container = ProviderScope.containerOf(
          tester.element(detail),
          listen: false,
        );
        container.read(activeBrokerProfileProvider.notifier).state = profile;
        await tester.pump();
        await tester.pump();

        expect(
          container.read(visibleAttentionSessionProvider)?.sessionId,
          'session-a',
        );

        router.go('/attention');
        await tester.pump();
        await tester.pump();

        expect(find.byType(SessionDetailPage), findsNothing);
        expect(
          find.byType(SessionDetailPage, skipOffstage: false),
          findsOneWidget,
          reason: 'the indexed shell retains the inactive Sessions branch',
        );
        expect(container.read(visibleAttentionSessionProvider), isNull);
      },
    );

    testWidgets('settings can open the transfer manager route', (tester) async {
      await pumpApp(
        tester,
        overrides: [
          sessionArtifactTransferRepositoryProvider.overrideWithValue(
            InMemorySessionArtifactTransferRepository(),
          ),
        ],
      );

      await tester.tap(find.text('Settings'));
      await tester.pumpAndSettle();
      await openSettingsCategory(
        tester,
        const Key('settings-category-general'),
      );
      final transfersTile = find.widgetWithText(ListTile, 'Transfers');
      await tester.scrollUntilVisible(
        transfersTile,
        400,
        scrollable: find.byType(Scrollable).last,
      );
      await tester.pumpAndSettle();
      await tester.tap(transfersTile);
      await tester.pumpAndSettle();

      expect(find.text('No transfers'), findsOneWidget);
    });

    testWidgets('settings can open broker profile manager route', (
      tester,
    ) async {
      await pumpApp(tester);

      await tester.tap(find.text('Settings'));
      await tester.pumpAndSettle();
      await openSettingsCategory(tester, const Key('settings-category-broker'));
      final profilesTile = find.widgetWithText(ListTile, 'Broker Profiles');
      await tester.scrollUntilVisible(
        profilesTile,
        400,
        scrollable: find.byType(Scrollable).last,
      );
      await tester.pumpAndSettle();
      await tester.tap(profilesTile);
      await tester.pumpAndSettle();

      expect(find.text('Broker Profiles'), findsAtLeastNWidgets(1));
    });

    testWidgets('settings can open pairing route', (tester) async {
      await pumpApp(tester);

      await tester.tap(find.text('Settings'));
      await tester.pumpAndSettle();
      await openSettingsCategory(tester, const Key('settings-category-broker'));
      final pairingTile = find.byKey(const Key('settings-pairing'));
      await tester.scrollUntilVisible(
        pairingTile,
        400,
        scrollable: find.byType(Scrollable).last,
      );
      await tester.pumpAndSettle();
      await tester.tap(pairingTile);
      await tester.pumpAndSettle();

      expect(find.text('Pairing'), findsOneWidget);
    });

    testWidgets(
      'settings can open keyboard shortcuts help route',
      (tester) async {
        await pumpApp(tester);

        await tester.tap(find.text('Settings'));
        await tester.pumpAndSettle();
        await openSettingsCategory(
          tester,
          const Key('settings-category-general'),
        );
        final shortcutsTile = find.byKey(
          const Key('settings-keyboard-shortcuts'),
        );
        await tester.scrollUntilVisible(
          shortcutsTile,
          400,
          scrollable: find.byType(Scrollable).last,
        );
        await tester.pumpAndSettle();
        await tester.tap(shortcutsTile);
        await tester.pumpAndSettle();
        Future<void> scrollTo(String label) async {
          await tester.scrollUntilVisible(
            find.text(label),
            500,
            scrollable: find.byType(Scrollable).last,
          );
          await tester.pumpAndSettle();
        }

        // These assertions mirror the real bindings in router.dart,
        // sessions_page.dart, session_detail_page.dart and
        // transfer_manager_page.dart. The page previously documented
        // Ctrl+2 as Connection, omitted Notifications entirely, and had every
        // destination after Sessions shifted by one.
        await scrollTo('Navigation');
        expect(find.text('Navigation'), findsOneWidget);
        expect(find.text('Ctrl+1 / \u23181'), findsOneWidget);
        expect(find.text('Go to Sessions'), findsOneWidget);
        expect(find.text('Ctrl+2 / \u23182'), findsOneWidget);
        expect(find.text('Go to Notifications'), findsOneWidget);
        expect(find.text('Ctrl+3 / \u23183'), findsOneWidget);
        expect(find.text('Go to Connection'), findsOneWidget);
        expect(find.text('Ctrl+4 / \u23184'), findsOneWidget);
        expect(find.text('Go to Settings'), findsOneWidget);
        expect(find.text('Ctrl+5 / \u23185'), findsOneWidget);
        expect(find.text('Go to Transfers'), findsOneWidget);

        // Text size was bound in router.dart but documented nowhere.
        await scrollTo('Text size');
        expect(find.text('Text size'), findsOneWidget);
        expect(find.text('Ctrl+= / \u2318='), findsOneWidget);
        expect(find.text('Ctrl+\u2212 / \u2318\u2212'), findsOneWidget);
        expect(find.text('Ctrl+scroll'), findsOneWidget);

        await scrollTo('Session list');
        expect(find.text('F5'), findsOneWidget);
        expect(find.text('Ctrl+R / \u2318R'), findsOneWidget);

        await scrollTo('Session detail');
        expect(find.text('Ctrl+K / \u2318K'), findsOneWidget);

        await scrollTo('Transfers');
        expect(find.text('Ctrl+A / \u2318A'), findsOneWidget);
        expect(find.text('Ctrl+I / \u2318I'), findsOneWidget);
        expect(find.text('Esc'), findsOneWidget);
        expect(find.text('Esc / Del'), findsOneWidget);
      },
    );

    testWidgets(
      'compact shell supports app-level navigation shortcut navigation',
      (tester) async {
        await pumpApp(
          tester,
          surfaceSize: const Size(600, 900),
          initialLocation: '/settings',
        );

        expect(find.byKey(const Key('app-bottom-nav')), findsOneWidget);
        expect(find.widgetWithText(AppBar, 'Settings'), findsOneWidget);

        await _sendAppShortcut(
          tester: tester,
          modifier: LogicalKeyboardKey.controlLeft,
          digit: LogicalKeyboardKey.digit1,
        );
        await tester.pumpAndSettle();

        expect(find.widgetWithText(AppBar, 'Sessions'), findsOneWidget);
      },
    );

    testWidgets(
      'wide shell supports app-level navigation shortcuts to all shell routes',
      (tester) async {
        await pumpApp(
          tester,
          surfaceSize: const Size(1200, 900),
          overrides: [
            sessionArtifactTransferRepositoryProvider.overrideWithValue(
              InMemorySessionArtifactTransferRepository(),
            ),
          ],
        );

        expect(
          find.byKey(const Key('app-desktop-command-surface')),
          findsNothing,
        );

        await _sendAppShortcut(
          tester: tester,
          modifier: LogicalKeyboardKey.controlLeft,
          digit: LogicalKeyboardKey.digit2,
        );
        await tester.pumpAndSettle();
        expect(find.widgetWithText(AppBar, 'Notifications'), findsOneWidget);
        expect(
          find.byKey(const Key('attention-back-to-sessions')),
          findsOneWidget,
        );

        await _sendAppShortcut(
          tester: tester,
          modifier: LogicalKeyboardKey.controlLeft,
          digit: LogicalKeyboardKey.digit3,
        );
        await tester.pumpAndSettle();
        expect(find.widgetWithText(AppBar, 'Connection'), findsOneWidget);

        await _sendAppShortcut(
          tester: tester,
          modifier: LogicalKeyboardKey.controlLeft,
          digit: LogicalKeyboardKey.digit4,
        );
        await tester.pumpAndSettle();
        expect(find.widgetWithText(AppBar, 'Settings'), findsOneWidget);

        await _sendAppShortcut(
          tester: tester,
          modifier: LogicalKeyboardKey.controlLeft,
          digit: LogicalKeyboardKey.digit5,
        );
        await tester.pumpAndSettle();
        expect(find.widgetWithText(AppBar, 'Transfers'), findsOneWidget);

        await _sendAppShortcut(
          tester: tester,
          modifier: LogicalKeyboardKey.controlLeft,
          digit: LogicalKeyboardKey.digit1,
        );
        await tester.pumpAndSettle();
        // At wide width the Sessions branch is the two-pane workspace, with
        // contextual header actions and no permanent app navigation chrome.
        expect(find.byType(SessionsWorkspace), findsOneWidget);
        expect(
          find.byKey(const Key('sessions-workspace-attention')),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'wide shell supports meta app-level navigation shortcuts',
      (tester) async {
        await pumpApp(
          tester,
          surfaceSize: const Size(1200, 900),
          initialLocation: '/settings',
          overrides: [
            sessionArtifactTransferRepositoryProvider.overrideWithValue(
              InMemorySessionArtifactTransferRepository(),
            ),
          ],
        );

        await _sendAppShortcut(
          tester: tester,
          modifier: LogicalKeyboardKey.metaLeft,
          digit: LogicalKeyboardKey.digit5,
        );
        await tester.pumpAndSettle();

        expect(find.widgetWithText(AppBar, 'Transfers'), findsOneWidget);
        expect(
          find.byKey(const Key('app-desktop-command-surface')),
          findsNothing,
        );
        expect(
          find.byKey(const Key('transfers-back-to-sessions')),
          findsOneWidget,
        );
      },
    );

    testWidgets('app shell exposes a single platform command menu bar', (
      tester,
    ) async {
      await pumpApp(
        tester,
        surfaceSize: const Size(1200, 900),
      );

      expect(find.byType(PlatformMenuBar), findsOneWidget);
      final menuBar = _platformMenuBar(tester);
      expect(menuBar.menus, hasLength(1));

      final appMenu = menuBar.menus.single as PlatformMenu;
      expect(appMenu.label, 'Cosyncing');
      expect(appMenu.menus, hasLength(8));
    });

    testWidgets('platform menu labels include existing route actions', (
      tester,
    ) async {
      await pumpApp(
        tester,
        surfaceSize: const Size(1200, 900),
      );

      final menuItemLabels = _platformMenuActionItems(
        tester,
      ).map((item) => item.label).toSet();

      expect(
        menuItemLabels,
        containsAll(
          <String>{
            'Sessions',
            'Notifications',
            'Connection',
            'Settings',
            'Transfers',
            'Broker Profiles',
            'Pairing',
            'Keyboard Shortcuts',
          },
        ),
      );
    });

    testWidgets('platform menu routes can be assigned with Meta shortcuts', (
      tester,
    ) async {
      await pumpApp(
        tester,
        surfaceSize: const Size(1200, 900),
      );

      expect(
        _menuItemShortcutByLabel(tester, label: 'Sessions'),
        equals(const SingleActivator(LogicalKeyboardKey.digit1, meta: true)),
      );
      expect(
        _menuItemShortcutByLabel(tester, label: 'Notifications'),
        equals(const SingleActivator(LogicalKeyboardKey.digit2, meta: true)),
      );
      expect(
        _menuItemShortcutByLabel(tester, label: 'Connection'),
        equals(const SingleActivator(LogicalKeyboardKey.digit3, meta: true)),
      );
      expect(
        _menuItemShortcutByLabel(tester, label: 'Settings'),
        equals(const SingleActivator(LogicalKeyboardKey.digit4, meta: true)),
      );
      expect(
        _menuItemShortcutByLabel(tester, label: 'Transfers'),
        equals(const SingleActivator(LogicalKeyboardKey.digit5, meta: true)),
      );
    });

    // Re-flagged item 26: the Attention destination must carry its unread
    // signal in every layout it is reachable from. The wide roster header and
    // the collapsed rail are covered in sessions_workspace_test; this is the
    // compact layout, where the bottom nav is the only route to Attention.
    testWidgets('compact bottom nav shows the attention unread badge', (
      tester,
    ) async {
      await pumpApp(
        tester,
        surfaceSize: const Size(600, 900),
        overrides: [
          attentionUnreadCountProvider.overrideWith((ref) => 3),
        ],
      );

      expect(find.byKey(const Key('app-bottom-nav')), findsOneWidget);
      final badge = find.descendant(
        of: find.byKey(const Key('app-bottom-nav')),
        matching: find.byType(Badge),
      );
      expect(badge, findsWidgets);
      expect(
        find.descendant(
          of: find.byKey(const Key('app-bottom-nav')),
          matching: find.text('3'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('compact bottom nav hides the badge at zero unread', (
      tester,
    ) async {
      await pumpApp(
        tester,
        surfaceSize: const Size(600, 900),
        overrides: [
          attentionUnreadCountProvider.overrideWith((ref) => 0),
        ],
      );

      expect(
        find.descendant(
          of: find.byKey(const Key('app-bottom-nav')),
          matching: find.text('0'),
        ),
        findsNothing,
      );
    });

    testWidgets(
      'platform menu item can navigate in compact shell without breaking'
      ' bottom nav layout',
      (tester) async {
        await pumpApp(
          tester,
          surfaceSize: const Size(600, 900),
          initialLocation: '/settings',
        );

        expect(find.byKey(const Key('app-bottom-nav')), findsOneWidget);

        await _invokeMenuSelection(tester, label: 'Sessions');
        await tester.pumpAndSettle();

        expect(find.widgetWithText(AppBar, 'Sessions'), findsOneWidget);
        expect(find.byKey(const Key('app-bottom-nav')), findsOneWidget);
      },
    );

    testWidgets(
      'platform menu item can navigate from direct transfer shell and keeps'
      ' contextual navigation available',
      (tester) async {
        await pumpApp(
          tester,
          initialLocation: '/transfers',
          surfaceSize: const Size(1200, 900),
        );

        expect(
          find.byKey(const Key('transfers-back-to-sessions')),
          findsOneWidget,
        );
        expect(find.widgetWithText(AppBar, 'Transfers'), findsOneWidget);

        await _invokeMenuSelection(tester, label: 'Connection');
        await tester.pumpAndSettle();

        expect(find.widgetWithText(AppBar, 'Connection'), findsOneWidget);
        expect(
          find.byKey(const Key('app-desktop-command-surface')),
          findsNothing,
        );
        expect(
          find.byKey(const Key('connection-back-to-sessions')),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'compact width keeps bottom navigation and hides command surface',
      (tester) async {
        await pumpApp(tester, surfaceSize: const Size(600, 900));

        expect(find.byKey(const Key('app-bottom-nav')), findsOneWidget);
        expect(
          find.byKey(const Key('app-desktop-command-surface')),
          findsNothing,
        );
        expect(find.byKey(const Key('app-command-sessions')), findsNothing);
      },
    );

    testWidgets('medium width keeps bottom navigation through 839dp', (
      tester,
    ) async {
      await pumpApp(tester, surfaceSize: const Size(839, 900));

      expect(find.byKey(const Key('app-bottom-nav')), findsOneWidget);
      expect(find.byType(SessionsWorkspace), findsNothing);
      expect(
        find.byKey(const Key('app-desktop-command-surface')),
        findsNothing,
      );
    });

    testWidgets(
      'wide workspace uses contextual actions without permanent navigation',
      (tester) async {
        await pumpApp(
          tester,
          surfaceSize: const Size(1200, 900),
          overrides: [
            sessionArtifactTransferRepositoryProvider.overrideWithValue(
              InMemorySessionArtifactTransferRepository(),
            ),
          ],
        );

        expect(
          find.byKey(const Key('app-desktop-command-surface')),
          findsNothing,
        );
        expect(find.byKey(const Key('app-bottom-nav')), findsNothing);

        await tester.tap(
          find.byKey(const Key('sessions-workspace-attention')),
        );
        await tester.pumpAndSettle();
        expect(find.widgetWithText(AppBar, 'Notifications'), findsOneWidget);
        expect(
          find.byKey(const Key('attention-back-to-sessions')),
          findsOneWidget,
        );

        await tester.tap(
          find.byKey(const Key('attention-back-to-sessions')),
        );
        await tester.pumpAndSettle();
        expect(find.byType(SessionsWorkspace), findsOneWidget);

        await tester.tap(
          find.byKey(const Key('sessions-workspace-settings')),
        );
        await tester.pumpAndSettle();
        expect(find.widgetWithText(AppBar, 'Settings'), findsOneWidget);
        expect(
          find.byKey(const Key('settings-back-to-sessions')),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('app-desktop-command-surface')),
          findsNothing,
        );
        expect(find.byKey(const Key('app-bottom-nav')), findsNothing);
      },
    );

    testWidgets(
      'wide direct transfer route returns contextually to Sessions',
      (tester) async {
        await pumpApp(
          tester,
          initialLocation: '/transfers',
          surfaceSize: const Size(1200, 900),
          overrides: [
            sessionArtifactTransferRepositoryProvider.overrideWithValue(
              InMemorySessionArtifactTransferRepository(),
            ),
          ],
        );

        expect(find.text('Transfers'), findsWidgets);
        expect(
          find.byKey(const Key('app-desktop-command-surface')),
          findsNothing,
        );
        expect(find.byKey(const Key('app-bottom-nav')), findsNothing);
        expect(
          find.byKey(const Key('transfers-back-to-sessions')),
          findsOneWidget,
        );

        await tester.tap(
          find.byKey(const Key('transfers-back-to-sessions')),
        );
        await tester.pumpAndSettle();

        expect(find.byType(SessionsWorkspace), findsOneWidget);
      },
    );

    testWidgets('Ctrl+= and Ctrl+- step the app text size', (tester) async {
      final store = _InMemoryUiPreferencesStore();
      await pumpApp(
        tester,
        surfaceSize: const Size(600, 900),
        overrides: [uiPreferencesStoreProvider.overrideWithValue(store)],
      );

      await _sendAppShortcut(
        tester: tester,
        modifier: LogicalKeyboardKey.controlLeft,
        digit: LogicalKeyboardKey.equal,
      );
      await tester.pumpAndSettle();
      expect(store.values[uiTextScaleSettingKey], UiTextScale.large.token);

      await _sendAppShortcut(
        tester: tester,
        modifier: LogicalKeyboardKey.controlLeft,
        digit: LogicalKeyboardKey.minus,
      );
      await tester.pumpAndSettle();
      expect(store.values[uiTextScaleSettingKey], UiTextScale.standard.token);
    });

    testWidgets('numpad add and subtract step the app text size', (
      tester,
    ) async {
      final store = _InMemoryUiPreferencesStore();
      await pumpApp(
        tester,
        surfaceSize: const Size(600, 900),
        overrides: [uiPreferencesStoreProvider.overrideWithValue(store)],
      );

      await _sendAppShortcut(
        tester: tester,
        modifier: LogicalKeyboardKey.controlLeft,
        digit: LogicalKeyboardKey.numpadSubtract,
      );
      await tester.pumpAndSettle();
      expect(store.values[uiTextScaleSettingKey], UiTextScale.small.token);

      await _sendAppShortcut(
        tester: tester,
        modifier: LogicalKeyboardKey.controlLeft,
        digit: LogicalKeyboardKey.numpadAdd,
      );
      await tester.pumpAndSettle();
      expect(store.values[uiTextScaleSettingKey], UiTextScale.standard.token);
    });

    testWidgets('Cmd+= steps the app text size', (tester) async {
      final store = _InMemoryUiPreferencesStore();
      await pumpApp(
        tester,
        surfaceSize: const Size(600, 900),
        overrides: [uiPreferencesStoreProvider.overrideWithValue(store)],
      );

      await _sendAppShortcut(
        tester: tester,
        modifier: LogicalKeyboardKey.metaLeft,
        digit: LogicalKeyboardKey.equal,
      );
      await tester.pumpAndSettle();
      expect(store.values[uiTextScaleSettingKey], UiTextScale.large.token);
    });

    testWidgets('Ctrl+wheel steps the app text size in both directions', (
      tester,
    ) async {
      final store = _InMemoryUiPreferencesStore();
      await pumpApp(
        tester,
        surfaceSize: const Size(600, 900),
        overrides: [uiPreferencesStoreProvider.overrideWithValue(store)],
      );

      await _sendScroll(tester, deltaY: -120, control: true);
      expect(store.values[uiTextScaleSettingKey], UiTextScale.large.token);

      await _sendScroll(tester, deltaY: 120, control: true);
      expect(store.values[uiTextScaleSettingKey], UiTextScale.standard.token);
    });

    testWidgets('unmodified wheel scrolling never changes the text size', (
      tester,
    ) async {
      final store = _InMemoryUiPreferencesStore();
      await pumpApp(
        tester,
        surfaceSize: const Size(600, 900),
        overrides: [uiPreferencesStoreProvider.overrideWithValue(store)],
      );

      await _sendScroll(tester, deltaY: -120);
      await _sendScroll(tester, deltaY: 120);

      expect(store.values.containsKey(uiTextScaleSettingKey), isFalse);
    });

    testWidgets('unmodified wheel scrolling still scrolls a list', (
      tester,
    ) async {
      final store = _InMemoryUiPreferencesStore();
      await pumpApp(
        tester,
        surfaceSize: const Size(600, 900),
        initialLocation: '/settings/keyboard-shortcuts',
        overrides: [uiPreferencesStoreProvider.overrideWithValue(store)],
      );

      final scrollable = find.byType(Scrollable).last;
      final before = tester.state<ScrollableState>(scrollable).position.pixels;

      await _sendScroll(tester, deltaY: 300, at: tester.getCenter(scrollable));
      await tester.pumpAndSettle();

      final after = tester.state<ScrollableState>(scrollable).position.pixels;
      expect(after, greaterThan(before));
      expect(store.values.containsKey(uiTextScaleSettingKey), isFalse);
    });

    // On web the browser owns zoom, so the shell must not bind the text-scale
    // keyboard activators nor install the Ctrl/Cmd+wheel step. `kIsWeb` is a
    // compile-time constant that is always false under the VM test runner, so
    // these drive the web branch through the `debugBrowserOwnsZoomOverride`
    // seam in router.dart.
    testWidgets(
      'web does not bind Ctrl+= so the browser owns text zoom',
      (tester) async {
        debugBrowserOwnsZoomOverride = true;
        addTearDown(() => debugBrowserOwnsZoomOverride = null);
        final store = _InMemoryUiPreferencesStore();
        await pumpApp(
          tester,
          surfaceSize: const Size(600, 900),
          overrides: [uiPreferencesStoreProvider.overrideWithValue(store)],
        );

        await _sendAppShortcut(
          tester: tester,
          modifier: LogicalKeyboardKey.controlLeft,
          digit: LogicalKeyboardKey.equal,
        );
        await tester.pumpAndSettle();

        expect(store.values.containsKey(uiTextScaleSettingKey), isFalse);
      },
    );

    testWidgets(
      'web does not step text size on Ctrl+wheel so the browser owns zoom',
      (tester) async {
        debugBrowserOwnsZoomOverride = true;
        addTearDown(() => debugBrowserOwnsZoomOverride = null);
        final store = _InMemoryUiPreferencesStore();
        await pumpApp(
          tester,
          surfaceSize: const Size(600, 900),
          overrides: [uiPreferencesStoreProvider.overrideWithValue(store)],
        );

        await _sendScroll(tester, deltaY: -120, control: true);
        await _sendScroll(tester, deltaY: 120, control: true);

        expect(store.values.containsKey(uiTextScaleSettingKey), isFalse);
      },
    );

    testWidgets(
      'web keeps app-level navigation shortcuts working',
      (tester) async {
        debugBrowserOwnsZoomOverride = true;
        addTearDown(() => debugBrowserOwnsZoomOverride = null);
        await pumpApp(
          tester,
          surfaceSize: const Size(600, 900),
          initialLocation: '/settings',
        );

        expect(find.widgetWithText(AppBar, 'Settings'), findsOneWidget);

        await _sendAppShortcut(
          tester: tester,
          modifier: LogicalKeyboardKey.controlLeft,
          digit: LogicalKeyboardKey.digit1,
        );
        await tester.pumpAndSettle();

        expect(find.widgetWithText(AppBar, 'Sessions'), findsOneWidget);
      },
    );

    testWidgets(
      'compact session detail hides bottom navigation but keeps a way back',
      (tester) async {
        await pumpApp(
          tester,
          surfaceSize: const Size(500, 900),
          initialLocation: '/sessions/claude/session-a',
          overrides: [
            sessionArtifactTransferRepositoryProvider.overrideWithValue(
              InMemorySessionArtifactTransferRepository(),
            ),
          ],
        );

        expect(find.byType(SessionDetailPage), findsOneWidget);
        expect(find.byKey(const Key('app-bottom-nav')), findsNothing);

        // Hiding the nav is only safe because detail can be popped.
        final backButton = find.byType(BackButton);
        expect(backButton, findsOneWidget);

        await tester.tap(backButton);
        await tester.pumpAndSettle();

        expect(find.byType(SessionDetailPage), findsNothing);
        expect(find.byKey(const Key('app-bottom-nav')), findsOneWidget);
      },
    );

    testWidgets('compact session roster keeps bottom navigation', (
      tester,
    ) async {
      await pumpApp(tester, surfaceSize: const Size(500, 900));

      expect(find.byKey(const Key('app-bottom-nav')), findsOneWidget);
    });

    testWidgets('wide session detail is unchanged by the compact nav rule', (
      tester,
    ) async {
      await pumpApp(
        tester,
        surfaceSize: const Size(1200, 900),
        initialLocation: '/sessions/claude/session-a',
        overrides: [
          sessionArtifactTransferRepositoryProvider.overrideWithValue(
            InMemorySessionArtifactTransferRepository(),
          ),
        ],
      );

      // Wide layout never had a bottom nav; the rule must not change that.
      expect(find.byKey(const Key('app-bottom-nav')), findsNothing);
    });
  });
}

class _InMemoryUiPreferencesStore implements UiPreferencesStore {
  final Map<String, String> values = <String, String>{};

  @override
  Future<String?> getThemeId() async => values[uiThemeIdSettingKey];

  @override
  Future<void> setThemeId(String themeId) async {
    values[uiThemeIdSettingKey] = themeId;
  }

  @override
  Future<String?> getThemeMode() async => values[uiThemeModeSettingKey];

  @override
  Future<void> setThemeMode(String mode) async {
    values[uiThemeModeSettingKey] = mode;
  }

  @override
  Future<String?> getLocaleTag() async => values[uiLocaleSettingKey];

  @override
  Future<void> setLocaleTag(String tag) async {
    values[uiLocaleSettingKey] = tag;
  }

  @override
  Future<String?> getTextScale() async => values[uiTextScaleSettingKey];

  @override
  Future<void> setTextScale(String token) async {
    values[uiTextScaleSettingKey] = token;
  }

  @override
  Future<String?> getDensity() async => values[uiDensitySettingKey];

  @override
  Future<void> setDensity(String token) async {
    values[uiDensitySettingKey] = token;
  }

  @override
  Future<bool?> getShowDebugViews() async {
    final value = values[uiShowDebugViewsSettingKey];
    return value == null ? null : value == 'true';
  }

  @override
  Future<void> setShowDebugViews({required bool value}) async {
    values[uiShowDebugViewsSettingKey] = value.toString();
  }
}

class _InMemoryWorkspacePrefsStore implements WorkspacePrefsStore {
  WorkspaceRosterPrefs? saved;

  @override
  Future<WorkspaceRosterPrefs?> loadRoster() async => saved;

  @override
  Future<void> saveRoster(WorkspaceRosterPrefs prefs) async {
    saved = prefs;
  }
}

class _InMemoryAttentionFeedSettingsStore
    implements AttentionFeedSettingsStore {
  final Set<String> _disabledProfileIds = {};

  @override
  Future<bool> isFeedEnabled(String brokerProfileId) async =>
      !_disabledProfileIds.contains(brokerProfileId);

  @override
  Future<List<String>> listDisabledProfileIds() async =>
      _disabledProfileIds.toList(growable: false);

  @override
  Future<void> setFeedEnabled({
    required String brokerProfileId,
    required bool enabled,
  }) async {
    if (!enabled) {
      _disabledProfileIds.add(brokerProfileId);
    } else {
      _disabledProfileIds.remove(brokerProfileId);
    }
  }
}

class _InMemoryRemoteWakeSettingsStore implements RemoteWakeSettingsStore {
  bool _enabled = false;

  @override
  Future<bool> isEnabled() async => _enabled;

  @override
  Future<void> setEnabled({required bool enabled}) async {
    _enabled = enabled;
  }
}

final class _InMemorySessionNotificationSettingsStore
    implements SessionNotificationSettingsStore {
  bool value = false;

  @override
  Future<bool> getLocalNotificationEnabled() async => value;

  @override
  Future<void> setLocalNotificationEnabled({required bool enabled}) async {
    value = enabled;
  }
}

class _InMemoryOpenSessionsStore implements OpenSessionsStore {
  @override
  Future<OpenSessionsSnapshot> load(String profileId) async =>
      OpenSessionsSnapshot.empty;

  @override
  Future<void> save(String profileId, OpenSessionsSnapshot snapshot) async {}
}

class _InMemoryBrokerProfileRepository implements BrokerProfileRepository {
  final Map<String, BrokerProfile> _profiles = <String, BrokerProfile>{};

  @override
  Future<List<BrokerProfile>> getAll() async {
    return _profiles.values.toList();
  }

  @override
  Future<BrokerProfile?> getById(String id) async {
    return _profiles[id];
  }

  @override
  Future<BrokerProfile> save(BrokerProfile profile) async {
    _profiles[profile.id] = profile;
    return profile;
  }

  @override
  Future<bool> delete({
    required String id,
    required String? incarnationId,
  }) async {
    return _profiles.remove(id) != null;
  }
}

/// Sends a wheel scroll, optionally with Control held.
///
/// Control is pressed around the signal rather than simulated, because the
/// shell reads [HardwareKeyboard] directly at the moment the signal arrives.
Future<void> _sendScroll(
  WidgetTester tester, {
  required double deltaY,
  bool control = false,
  Offset? at,
}) async {
  if (control) {
    await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
  }
  final pointer = TestPointer(1, PointerDeviceKind.mouse);
  final location = at ?? tester.getCenter(find.byType(MaterialApp));
  tester.binding.handlePointerEvent(pointer.hover(location));
  tester.binding.handlePointerEvent(pointer.scroll(Offset(0, deltaY)));
  await tester.pump();
  if (control) {
    await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
  }
  await tester.pump();
}

Future<void> _sendAppShortcut({
  required WidgetTester tester,
  required LogicalKeyboardKey modifier,
  required LogicalKeyboardKey digit,
}) async {
  await tester.sendKeyDownEvent(modifier);
  await tester.sendKeyDownEvent(digit);
  await tester.sendKeyUpEvent(digit);
  await tester.sendKeyUpEvent(modifier);
  await tester.pump();
}

Object? _menuItemShortcutByLabel(
  WidgetTester tester, {
  required String label,
}) {
  final menuItem = _findPlatformMenuItem(tester, label: label);
  return menuItem.shortcut;
}

Future<void> _invokeMenuSelection(
  WidgetTester tester, {
  required String label,
}) async {
  final menuItem = _findPlatformMenuItem(tester, label: label);
  menuItem.onSelected?.call();
  await tester.pump();
}

PlatformMenuItem _findPlatformMenuItem(
  WidgetTester tester, {
  required String label,
}) {
  final items = _platformMenuActionItems(
    tester,
  ).where((item) => item.label == label).toList();
  expect(items, hasLength(1));
  return items.single;
}

PlatformMenuBar _platformMenuBar(WidgetTester tester) {
  return tester.widget<PlatformMenuBar>(find.byType(PlatformMenuBar));
}

List<PlatformMenuItem> _platformMenuActionItems(WidgetTester tester) {
  final menuBar = _platformMenuBar(tester);
  final appMenu = menuBar.menus.single as PlatformMenu;
  return appMenu.menus;
}
