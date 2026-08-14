import 'dart:async';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_feed_settings_store.dart';
import 'package:cosyncing_client/src/features/attention/data/remote_wake_settings_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/controller/broker_gate_controller.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_identity_store.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_gate_state.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/settings/controller/managed_runtime_controller.dart';
import 'package:cosyncing_client/src/features/settings/controller/session_notification_settings_controller.dart';
import 'package:cosyncing_client/src/features/settings/data/session_display_preferences_store.dart';
import 'package:cosyncing_client/src/features/settings/data/session_notification_settings_store.dart';
import 'package:cosyncing_client/src/features/settings/view/agents_settings_page.dart';
import 'package:cosyncing_client/src/features/settings/view/broker_devices_settings_page.dart';
import 'package:cosyncing_client/src/features/settings/view/general_settings_page.dart';
import 'package:cosyncing_client/src/features/settings/view/notification_settings_page.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_page.dart';
import 'package:cosyncing_client/src/features/voice/data/read_aloud_preferences_store.dart';
import 'package:cosyncing_client/src/platform/update/desktop_client_update_provider.dart';
import 'package:cosyncing_client/src/platform/update/web_client_update.dart';
import 'package:cosyncing_client/src/platform/update/web_client_update_provider.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_participants.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/in_memory_read_aloud_preferences_store.dart';
import '../../../../support/in_memory_session_display_preferences_store.dart';

void main() {
  group('SettingsPage', () {
    late _SpyCredentialStore store;
    late _InMemoryBrokerProfileRepository repository;
    late _InMemorySessionNotificationSettingsStore notificationSettingsStore;
    late _FakePermissionRequester permissionRequester;
    late _FakeManagedRuntimeApi managedRuntimeApi;
    late _MemoryAttentionFeedSettingsStore attentionFeedSettingsStore;
    late _MemoryRemoteWakeSettingsStore remoteWakeSettingsStore;
    late _MemoryBrokerIdentityStore brokerIdentityStore;

    setUp(() {
      store = _SpyCredentialStore();
      repository = _InMemoryBrokerProfileRepository();
      notificationSettingsStore = _InMemorySessionNotificationSettingsStore();
      permissionRequester = _FakePermissionRequester();
      managedRuntimeApi = _FakeManagedRuntimeApi();
      attentionFeedSettingsStore = _MemoryAttentionFeedSettingsStore();
      remoteWakeSettingsStore = _MemoryRemoteWakeSettingsStore();
      brokerIdentityStore = _MemoryBrokerIdentityStore();
    });

    // Settings is a hub of categories; every control below lives on the
    // category page that owns it, so each test pumps that page directly.
    Widget buildSubject({
      Widget home = const SettingsPage(),
      BrokerProfile? activeProfile,
      BrokerGateState gateState = const BrokerGateState.connected(),
      WebClientUpdateState webUpdate = const WebClientUpdateState(
        updateReady: false,
        handoffFailed: false,
      ),
      String clientVersion = cosyncingClientVersion,
      TargetPlatform platform = TargetPlatform.linux,
      ManagedRuntimeApi Function(BrokerProfile?)? managedRuntimeApiForProfile,
    }) {
      final overrides = <Override>[
        // The connection gate renders nothing while connected. Pin it so tests
        // unrelated to the gate do not depend on broker reachability.
        brokerGateControllerProvider.overrideWith(
          () => _StubGateController(gateState),
        ),
        credentialStoreProvider.overrideWithValue(store),
        brokerProfileRepositoryProvider.overrideWithValue(repository),
        sessionNotificationSettingsStoreProvider.overrideWithValue(
          notificationSettingsStore,
        ),
        sessionNotificationPermissionRequesterProvider.overrideWithValue(
          permissionRequester.call,
        ),
        managedRuntimeApiProvider.overrideWith((ref) {
          final resolver = managedRuntimeApiForProfile;
          if (resolver == null) return managedRuntimeApi;
          return resolver(ref.watch(activeBrokerProfileProvider));
        }),
        attentionFeedSettingsStoreProvider.overrideWithValue(
          attentionFeedSettingsStore,
        ),
        remoteWakeSettingsStoreProvider.overrideWithValue(
          remoteWakeSettingsStore,
        ),
        brokerIdentityStoreProvider.overrideWithValue(brokerIdentityStore),
        webClientUpdateProvider.overrideWith(
          (ref) => Stream.value(webUpdate),
        ),
        desktopClientVersionProvider.overrideWithValue(clientVersion),
        sessionDisplayPreferencesStoreProvider.overrideWithValue(
          InMemorySessionDisplayPreferencesStore(),
        ),
        readAloudPreferencesStoreProvider.overrideWithValue(
          InMemoryReadAloudPreferencesStore(),
        ),
      ];

      if (activeProfile != null) {
        overrides.add(
          activeBrokerProfileProvider.overrideWith((_) => activeProfile),
        );
      }

      return ProviderScope(
        overrides: overrides,
        child: MaterialApp(
          theme: ThemeData(
            splashFactory: InkRipple.splashFactory,
            platform: platform,
            extensions: [themeSpecById(kDefaultThemeId).light],
          ),
          // The embedded connection gate is fully localized, so it needs the
          // real delegates here just as it has them under App.
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: home,
        ),
      );
    }

    Future<void> expectSettledRuntimeErrorFallback(
      WidgetTester tester, {
      required String brokerVersion,
    }) async {
      final betaProfile = BrokerProfile(
        id: 'broker-b',
        displayName: 'Broker B',
        baseUri: Uri.parse('http://beta.test'),
        createdAt: DateTime(2026),
        incarnationId: 'beta',
      );
      const broker = BrokerContractIdentity(
        revision: 6,
        minimumClientRevision: 0,
        surfaceHash: 'fnv1a32:095fc995',
      );
      await brokerIdentityStore.writeHello(
        RosterSource.ofProfile(betaProfile).storageKey,
        HelloWireEvent(
          brokerVersion: brokerVersion,
          brokerContract: broker,
          clientVersion: '1.3.0',
          compatibility: const BrokerClientCompatibility(
            status: BrokerClientCompatibilityStatus.clientBehind,
            readOnly: false,
            reason: 'client contract is one revision behind',
            broker: broker,
            client: ClientContractIdentity(
              revision: cosyncingClientContractRevision,
              minimumBrokerRevision: cosyncingClientMinimumBrokerRevision,
              surfaceHash: cosyncingClientContractSurfaceHash,
            ),
          ),
        ),
      );
      final betaApi = _FakeManagedRuntimeApi()
        ..runtimeUpdatesError = StateError('runtime endpoint unavailable');

      await tester.pumpWidget(
        buildSubject(
          home: const BrokerDevicesSettingsPage(),
          activeProfile: betaProfile,
          clientVersion: '1.3.0',
          managedRuntimeApiForProfile: (_) => betaApi,
        ),
      );
      await tester.pumpAndSettle();

      final container = ProviderScope.containerOf(
        tester.element(find.byType(BrokerDevicesSettingsPage)),
      );
      final runtime = container.read(managedRuntimeControllerProvider);
      expect(runtime.hasError, isTrue);
      expect(runtime.isLoading, isFalse);
      expect(
        find.byKey(const Key('settings-desktop-build-update')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('settings-client-behind-compatibility')),
        findsOneWidget,
      );
    }

    // Layer one is the whole point of the hierarchy: the hub lists categories
    // and carries no controls of its own.
    testWidgets('hub lists every category', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      for (final entry in const [
        ('settings-category-display', 'Display'),
        ('settings-category-notifications', 'Notifications'),
        ('settings-category-broker', 'Servers'),
        ('settings-category-agents', 'Agents & usage'),
        ('settings-category-general', 'General'),
      ]) {
        expect(find.byKey(Key(entry.$1)), findsOneWidget);
        expect(find.widgetWithText(ListTile, entry.$2), findsOneWidget);
      }

      expect(find.byKey(const Key('servers-remove-credential')), findsNothing);
      expect(find.byIcon(Icons.chevron_right), findsNWidgets(5));

      // Controls that moved to layer two must not linger on the hub.
      expect(find.byKey(const Key('settings-managed-runtimes')), findsNothing);
      expect(
        find.byKey(const Key('settings-broker-token-field')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('settings-local-session-notifications')),
        findsNothing,
      );
    });

    testWidgets('shows empty state when no active profile', (tester) async {
      await tester.pumpWidget(
        buildSubject(home: const BrokerDevicesSettingsPage()),
      );

      expect(
        find.text(
          'Connect to a server first, then add a token for a remote '
          'server here.',
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('settings-broker-token-field')),
        findsNothing,
      );
    });

    testWidgets('shows keyboard shortcuts settings row', (tester) async {
      await tester.pumpWidget(buildSubject(home: const GeneralSettingsPage()));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.byKey(const Key('settings-keyboard-shortcuts')),
        300,
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('settings-keyboard-shortcuts')),
        findsOneWidget,
      );
      expect(find.text('Keyboard Shortcuts'), findsOneWidget);
      expect(find.text('View available keyboard shortcuts'), findsOneWidget);
    });

    testWidgets('keeps feed and remote wake consent separate', (tester) async {
      final profile = BrokerProfile(
        id: 'workstation',
        displayName: 'Test workstation',
        baseUri: Uri.parse('http://127.0.0.1:7734'),
        createdAt: DateTime(2026),
      );
      await repository.save(profile);
      await tester.pumpWidget(
        buildSubject(
          home: const NotificationSettingsPage(),
          activeProfile: profile,
        ),
      );
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.byKey(const Key('settings-attention-delivery')),
        300,
        scrollable: find
            .descendant(
              of: find.byType(ListView),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.pumpAndSettle();

      tester
          .state<SelectableRegionState>(
            find.descendant(
              of: find.byKey(
                const Key('settings-attention-delivery-description'),
              ),
              matching: find.byType(SelectableRegion),
            ),
          )
          .selectAll();
      await tester.pump();

      final scrollable = find
          .descendant(
            of: find.byType(ListView),
            matching: find.byType(Scrollable),
          )
          .first;
      final beforeScroll = tester
          .state<ScrollableState>(scrollable)
          .position
          .pixels;
      await tester.drag(scrollable, const Offset(0, 24));
      await tester.pumpAndSettle();
      expect(
        tester.state<ScrollableState>(scrollable).position.pixels,
        lessThan(beforeScroll),
      );

      // Feeds are default-on, so the first tap is an explicit opt-out.
      await tester.tap(
        find.byKey(const Key('settings-attention-profile-workstation')),
      );
      await tester.pumpAndSettle();
      expect(attentionFeedSettingsStore.disabled, {'workstation'});
      expect(remoteWakeSettingsStore.enabled, isFalse);

      // Remote wake stays a separate, explicit opt-in.
      await tester.scrollUntilVisible(
        find.byKey(const Key('settings-remote-opaque-wake')),
        50,
        scrollable: scrollable,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('settings-remote-opaque-wake')));
      await tester.pumpAndSettle();
      expect(remoteWakeSettingsStore.enabled, isTrue);
      expect(attentionFeedSettingsStore.disabled, {'workstation'});
    });

    testWidgets('shows local session notifications toggle off by default', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSubject(home: const NotificationSettingsPage()),
      );
      await tester.pumpAndSettle();

      final switchTile = tester.widget<SwitchListTile>(
        find.byKey(const Key('settings-local-session-notifications')),
      );
      expect(switchTile.value, isFalse);
    });

    testWidgets('shows managed ownership policy and recovery controls', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject(home: const AgentsSettingsPage()));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.byKey(const Key('settings-managed-runtimes')),
        300,
      );
      await tester.pumpAndSettle();

      expect(find.text('Managed Agent Runtimes'), findsOneWidget);
      expect(
        find.textContaining('cosyncing owns the managed server'),
        findsOneWidget,
      );
      expect(find.byKey(const Key('settings-runtime-policy')), findsOneWidget);
      expect(find.text('Update ready'), findsOneWidget);
      expect(
        find.text(
          'Running 0.144.1  •  Installed 0.144.1  •  '
          'Configuration also changed',
        ),
        findsOneWidget,
      );
      expect(
        find.text('0 working, 0 needs input, 1 idle, 0 unknown blocker(s).'),
        findsOneWidget,
      );
      expect(
        find.ancestor(
          of: find.textContaining('Running 0.144.1'),
          matching: find.byType(SelectionArea),
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('settings-restart-runtime-codex')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('settings-restart-everything')),
        findsOneWidget,
      );
      expect(find.byKey(const Key('settings-quota-warnings')), findsOneWidget);
    });

    testWidgets('shows quota status bars while quota warnings stay off', (
      tester,
    ) async {
      managedRuntimeApi.quota = const TokdashQuotaResponse(
        ok: true,
        data: TokdashQuotaData(
          enabled: true,
          timestamp: 0,
          providers: {
            'codex': TokdashQuotaProvider(
              provider: 'codex',
              networkEnabled: true,
              buckets: [
                TokdashQuotaBucket(
                  account: 'default',
                  bucket: '5h',
                  bucketLabel: '5-hour window',
                  usedPercent: 58,
                  remainingPercent: 42,
                  resetsAt: null,
                  capturedAt: 0,
                  source: 'codex_api',
                  status: 'ok',
                ),
              ],
              status: 'ok',
              sources: ['codex_api'],
              estimated: false,
              raw: {},
            ),
          },
        ),
      );
      await tester.pumpWidget(buildSubject(home: const AgentsSettingsPage()));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.byKey(const Key('settings-quota-panel')),
        300,
      );
      await tester.pumpAndSettle();

      final warningsSwitch = tester.widget<SwitchListTile>(
        find.byKey(const Key('settings-quota-warnings')),
      );
      expect(warningsSwitch.value, isFalse);
      final panel = find.byKey(const Key('settings-quota-panel'));
      expect(
        find.descendant(of: panel, matching: find.text('Usage limits')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: panel, matching: find.text('Codex')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: panel, matching: find.text('5-hour')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: panel, matching: find.text('42%')),
        findsOneWidget,
      );
    });

    testWidgets('idle policy warning can cancel without a broker mutation', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject(home: const AgentsSettingsPage()));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.byKey(const Key('settings-managed-runtimes')),
        300,
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(
        find.byKey(const Key('settings-runtime-policy')),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('settings-runtime-policy')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('When no session is working').last);
      await tester.pumpAndSettle();

      expect(find.text('Idle terminals may disconnect'), findsOneWidget);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(managedRuntimeApi.policyWrites, isEmpty);
    });

    testWidgets('restart everything requires confirmation', (tester) async {
      await tester.pumpWidget(buildSubject(home: const AgentsSettingsPage()));
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.byKey(const Key('settings-managed-runtimes')),
        300,
      );
      await tester.pumpAndSettle();
      await tester.ensureVisible(
        find.byKey(const Key('settings-restart-everything')),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('settings-restart-everything')));
      await tester.pumpAndSettle();
      expect(find.text('Restart everything?'), findsOneWidget);
      expect(
        find.textContaining('Codex, OpenCode, and the server'),
        findsOneWidget,
      );

      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      expect(managedRuntimeApi.restartAllCalls, 0);

      await tester.tap(find.byKey(const Key('settings-restart-everything')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.text('Restart everything'),
        ),
      );
      await tester.pumpAndSettle();
      expect(managedRuntimeApi.restartAllCalls, 1);
      expect(
        find.widgetWithText(SelectableText, 'scheduled'),
        findsOneWidget,
      );
    });

    testWidgets('persists notification setting from the settings toggle', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSubject(home: const NotificationSettingsPage()),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(const Key('settings-local-session-notifications')),
      );
      await tester.pumpAndSettle();

      expect(notificationSettingsStore.value, isTrue);
      final switchTile = tester.widget<SwitchListTile>(
        find.byKey(const Key('settings-local-session-notifications')),
      );
      expect(switchTile.value, isTrue);
      expect(permissionRequester.requests, 0);
    });

    testWidgets('shows granted permission request state', (tester) async {
      permissionRequester.nextResult =
          const FlutterLocalNotificationPermissionRequestResult(
            outcome: FlutterLocalNotificationPermissionRequestOutcome.granted,
          );

      await tester.pumpWidget(
        buildSubject(home: const NotificationSettingsPage()),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(
          const Key('settings-request-os-notification-permission'),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.text('Notification permission: Granted'),
        findsOneWidget,
      );
    });

    testWidgets('shows denied permission request state', (tester) async {
      permissionRequester.nextResult =
          const FlutterLocalNotificationPermissionRequestResult(
            outcome: FlutterLocalNotificationPermissionRequestOutcome.denied,
          );

      await tester.pumpWidget(
        buildSubject(home: const NotificationSettingsPage()),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(
          const Key('settings-request-os-notification-permission'),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Notification permission: Denied'), findsOneWidget);
    });

    testWidgets('shows unsupported permission request state', (tester) async {
      permissionRequester
          .nextResult = const FlutterLocalNotificationPermissionRequestResult(
        outcome: FlutterLocalNotificationPermissionRequestOutcome.unsupported,
      );

      await tester.pumpWidget(
        buildSubject(home: const NotificationSettingsPage()),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(
          const Key('settings-request-os-notification-permission'),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Notification permission: Unsupported'), findsOneWidget);
    });

    testWidgets('shows failed permission request state', (tester) async {
      permissionRequester.throwOnRequest = true;

      await tester.pumpWidget(
        buildSubject(home: const NotificationSettingsPage()),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(
          const Key('settings-request-os-notification-permission'),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.text('Notification permission: Failed'),
        findsOneWidget,
      );
      expect(find.textContaining('permission request failed'), findsNothing);
    });

    // A loopback broker still requires a token once one is provisioned, so it
    // gets the same credential controls as any other host. Previously this
    // surface replaced them with a "no token required" hint, which left the
    // user unable to authenticate against their own local broker.
    testWidgets('offers token controls when active profile is loopback', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSubject(
          home: const BrokerDevicesSettingsPage(),
          activeProfile: BrokerProfile(
            id: 'http://127.0.0.1:7734',
            displayName: 'local',
            baseUri: Uri.parse('http://127.0.0.1:7734'),
            createdAt: DateTime(2026),
          ),
        ),
      );

      expect(
        find.byKey(const Key('settings-broker-token-field')),
        findsOneWidget,
      );
    });

    testWidgets(
      'shows profile-qualified client update fallback without a waiting build',
      (tester) async {
        final profile = BrokerProfile(
          id: 'workstation',
          displayName: 'Test workstation',
          baseUri: Uri.parse('http://127.0.0.1:7734'),
          createdAt: DateTime(2026),
          incarnationId: 'current',
        );
        const broker = BrokerContractIdentity(
          revision: 6,
          minimumClientRevision: 0,
          surfaceHash: 'fnv1a32:095fc995',
        );
        await brokerIdentityStore.writeHello(
          RosterSource.ofProfile(profile).storageKey,
          const HelloWireEvent(
            brokerVersion: '1.0.0',
            brokerContract: broker,
            clientVersion: '1.0.0',
            compatibility: BrokerClientCompatibility(
              status: BrokerClientCompatibilityStatus.clientBehind,
              readOnly: false,
              reason: 'client is one revision behind',
              broker: broker,
              client: ClientContractIdentity(
                revision: cosyncingClientContractRevision,
                minimumBrokerRevision: cosyncingClientMinimumBrokerRevision,
                surfaceHash: cosyncingClientContractSurfaceHash,
              ),
            ),
          ),
        );

        await tester.pumpWidget(
          buildSubject(
            home: const BrokerDevicesSettingsPage(),
            activeProfile: profile,
            clientVersion: '1.0.0',
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(const Key('settings-client-behind-compatibility')),
          findsOneWidget,
        );
        expect(
          find.text(
            'Client update recommended for Test workstation. Install the '
            'latest signed app release to match this server.',
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'desktop pointer replaces duplicate compatibility fallback when behind',
      (tester) async {
        managedRuntimeApi.brokerVersion = '1.4.0';
        final profile = BrokerProfile(
          id: 'workstation',
          displayName: 'Test workstation',
          baseUri: Uri.parse('http://127.0.0.1:7734'),
          createdAt: DateTime(2026),
          incarnationId: 'current',
        );
        const broker = BrokerContractIdentity(
          revision: 6,
          minimumClientRevision: 0,
          surfaceHash: 'fnv1a32:095fc995',
        );
        await brokerIdentityStore.writeHello(
          RosterSource.ofProfile(profile).storageKey,
          const HelloWireEvent(
            brokerVersion: '1.4.0',
            brokerContract: broker,
            clientVersion: '1.3.0',
            compatibility: BrokerClientCompatibility(
              status: BrokerClientCompatibilityStatus.clientBehind,
              readOnly: false,
              reason: 'client is one revision behind',
              broker: broker,
              client: ClientContractIdentity(
                revision: cosyncingClientContractRevision,
                minimumBrokerRevision: cosyncingClientMinimumBrokerRevision,
                surfaceHash: cosyncingClientContractSurfaceHash,
              ),
            ),
          ),
        );

        await tester.pumpWidget(
          buildSubject(
            home: const BrokerDevicesSettingsPage(),
            activeProfile: profile,
            clientVersion: '1.3.0',
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(const Key('settings-desktop-build-update')),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('settings-client-behind-compatibility')),
          findsNothing,
        );
      },
    );

    testWidgets(
      'held A snapshot cannot arbitrate B update guidance during a switch',
      (tester) async {
        final alphaProfile = BrokerProfile(
          id: 'broker-a',
          displayName: 'Broker A',
          baseUri: Uri.parse('http://alpha.test'),
          createdAt: DateTime(2026),
          incarnationId: 'alpha',
        );
        final betaProfile = BrokerProfile(
          id: 'broker-b',
          displayName: 'Broker B',
          baseUri: Uri.parse('http://beta.test'),
          createdAt: DateTime(2026),
          incarnationId: 'beta',
        );
        const broker = BrokerContractIdentity(
          revision: 6,
          minimumClientRevision: 0,
          surfaceHash: 'fnv1a32:095fc995',
        );
        const client = ClientContractIdentity(
          revision: cosyncingClientContractRevision,
          minimumBrokerRevision: cosyncingClientMinimumBrokerRevision,
          surfaceHash: cosyncingClientContractSurfaceHash,
        );
        await brokerIdentityStore.writeHello(
          RosterSource.ofProfile(alphaProfile).storageKey,
          const HelloWireEvent(
            brokerVersion: '1.3.0',
            brokerContract: broker,
            clientVersion: '1.3.0',
            compatibility: BrokerClientCompatibility(
              status: BrokerClientCompatibilityStatus.compatible,
              readOnly: false,
              reason: 'versions match',
              broker: broker,
              client: client,
            ),
          ),
        );
        await brokerIdentityStore.writeHello(
          RosterSource.ofProfile(betaProfile).storageKey,
          const HelloWireEvent(
            brokerVersion: '1.4.0',
            brokerContract: broker,
            clientVersion: '1.3.0',
            compatibility: BrokerClientCompatibility(
              status: BrokerClientCompatibilityStatus.clientBehind,
              readOnly: false,
              reason: 'client is one revision behind',
              broker: broker,
              client: client,
            ),
          ),
        );

        final betaRuntimeGate = Completer<void>();
        final alphaApi = _FakeManagedRuntimeApi()..brokerVersion = '1.3.0';
        final betaApi = _FakeManagedRuntimeApi()
          ..brokerVersion = '1.4.0'
          ..runtimeUpdatesGate = betaRuntimeGate;

        await tester.pumpWidget(
          buildSubject(
            home: const BrokerDevicesSettingsPage(),
            activeProfile: alphaProfile,
            clientVersion: '1.3.0',
            managedRuntimeApiForProfile: (profile) =>
                profile?.id == betaProfile.id ? betaApi : alphaApi,
          ),
        );
        await tester.pumpAndSettle();

        final container = ProviderScope.containerOf(
          tester.element(find.byType(BrokerDevicesSettingsPage)),
        );
        expect(
          container
              .read(managedRuntimeControllerProvider)
              .valueOrNull
              ?.brokerScopeKey,
          RosterSource.ofProfile(alphaProfile).storageKey,
        );

        container.read(activeBrokerProfileProvider.notifier).state =
            betaProfile;
        final betaHello = await container.read(
          brokerHelloIdentityProvider(
            RosterSource.ofProfile(betaProfile).storageKey,
          ).future,
        );
        expect(
          betaHello?.compatibility.status,
          BrokerClientCompatibilityStatus.clientBehind,
        );
        for (var index = 0; index < 10; index++) {
          await tester.pump();
        }

        expect(
          container
              .read(managedRuntimeControllerProvider)
              .valueOrNull
              ?.brokerScopeKey,
          RosterSource.ofProfile(alphaProfile).storageKey,
          reason: "B's runtime read is still held",
        );
        expect(
          find.byKey(const Key('settings-client-behind-compatibility')),
          findsNothing,
          reason: "A's equal version cannot display B's fallback",
        );
        expect(
          find.byKey(const Key('settings-desktop-build-update')),
          findsNothing,
        );

        betaRuntimeGate.complete();
        await tester.pumpAndSettle();

        expect(
          container
              .read(managedRuntimeControllerProvider)
              .valueOrNull
              ?.brokerScopeKey,
          RosterSource.ofProfile(betaProfile).storageKey,
        );
        expect(
          find.byKey(const Key('settings-desktop-build-update')),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('settings-client-behind-compatibility')),
          findsNothing,
        );
      },
    );

    testWidgets(
      'settled B runtime error preserves equal-version compatibility fallback',
      (tester) async {
        await expectSettledRuntimeErrorFallback(
          tester,
          brokerVersion: '1.3.0',
        );
      },
    );

    testWidgets(
      'settled B runtime error lets compatibility own a newer hello version',
      (tester) async {
        await expectSettledRuntimeErrorFallback(
          tester,
          brokerVersion: '1.4.0',
        );
      },
    );

    testWidgets(
      'hides fallback for read-only or stale compiled-client identities',
      (tester) async {
        final profile = BrokerProfile(
          id: 'workstation',
          displayName: 'Test workstation',
          baseUri: Uri.parse('http://127.0.0.1:7734'),
          createdAt: DateTime(2026),
          incarnationId: 'current',
        );
        const broker = BrokerContractIdentity(
          revision: 7,
          minimumClientRevision: 0,
          surfaceHash: 'fnv1a32:nextbroker',
        );
        const currentClient = ClientContractIdentity(
          revision: cosyncingClientContractRevision,
          minimumBrokerRevision: cosyncingClientMinimumBrokerRevision,
          surfaceHash: cosyncingClientContractSurfaceHash,
        );
        const cases = <String, HelloWireEvent>{
          'read-only': HelloWireEvent(
            brokerVersion: '0.2.0',
            brokerContract: broker,
            clientVersion: cosyncingClientVersion,
            compatibility: BrokerClientCompatibility(
              status: BrokerClientCompatibilityStatus.clientBehind,
              readOnly: true,
              reason: 'client may not write',
              broker: broker,
              client: currentClient,
            ),
          ),
          'stale version': HelloWireEvent(
            brokerVersion: '0.2.0',
            brokerContract: broker,
            clientVersion: 'previous-client',
            compatibility: BrokerClientCompatibility(
              status: BrokerClientCompatibilityStatus.clientBehind,
              readOnly: false,
              reason: 'old client should update',
              broker: broker,
              client: currentClient,
            ),
          ),
          'stale contract': HelloWireEvent(
            brokerVersion: '0.2.0',
            brokerContract: broker,
            clientVersion: cosyncingClientVersion,
            compatibility: BrokerClientCompatibility(
              status: BrokerClientCompatibilityStatus.clientBehind,
              readOnly: false,
              reason: 'old contract should update',
              broker: broker,
              client: ClientContractIdentity(
                revision: cosyncingClientContractRevision - 1,
                minimumBrokerRevision: cosyncingClientMinimumBrokerRevision,
                surfaceHash: cosyncingClientContractSurfaceHash,
              ),
            ),
          ),
        };

        for (final entry in cases.entries) {
          await brokerIdentityStore.writeHello(
            RosterSource.ofProfile(profile).storageKey,
            entry.value,
          );
          await tester.pumpWidget(
            buildSubject(
              home: const BrokerDevicesSettingsPage(),
              activeProfile: profile,
            ),
          );
          await tester.pumpAndSettle();

          expect(
            find.byKey(const Key('settings-client-behind-compatibility')),
            findsNothing,
            reason: entry.key,
          );
        }
      },
    );

    testWidgets(
      'waiting web build owns update guidance instead of Settings fallback',
      (tester) async {
        final profile = BrokerProfile(
          id: 'workstation',
          displayName: 'Test workstation',
          baseUri: Uri.parse('http://127.0.0.1:7734'),
          createdAt: DateTime(2026),
        );
        const broker = BrokerContractIdentity(
          revision: 6,
          minimumClientRevision: 0,
          surfaceHash: 'fnv1a32:095fc995',
        );
        await brokerIdentityStore.writeHello(
          RosterSource.ofProfile(profile).storageKey,
          const HelloWireEvent(
            brokerVersion: '0.1.0',
            brokerContract: broker,
            compatibility: BrokerClientCompatibility(
              status: BrokerClientCompatibilityStatus.clientBehind,
              readOnly: false,
              reason: 'client is one revision behind',
              broker: broker,
            ),
          ),
        );

        await tester.pumpWidget(
          buildSubject(
            home: const BrokerDevicesSettingsPage(),
            activeProfile: profile,
            webUpdate: const WebClientUpdateState(
              updateReady: true,
              handoffFailed: false,
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(const Key('settings-client-behind-compatibility')),
          findsNothing,
        );
      },
    );

    testWidgets('compatibility history never crosses a profile endpoint edit', (
      tester,
    ) async {
      final oldProfile = BrokerProfile(
        id: 'workstation',
        displayName: 'Test workstation',
        baseUri: Uri.parse('http://127.0.0.1:7734'),
        createdAt: DateTime(2026),
      );
      const broker = BrokerContractIdentity(
        revision: 6,
        minimumClientRevision: 0,
        surfaceHash: 'fnv1a32:095fc995',
      );
      await brokerIdentityStore.writeHello(
        RosterSource.ofProfile(oldProfile).storageKey,
        const HelloWireEvent(
          brokerVersion: '0.1.0',
          brokerContract: broker,
          compatibility: BrokerClientCompatibility(
            status: BrokerClientCompatibilityStatus.clientBehind,
            readOnly: false,
            reason: 'client is one revision behind',
            broker: broker,
          ),
        ),
      );
      final editedProfile = oldProfile.copyWith(
        baseUri: Uri.parse('http://127.0.0.1:8844'),
      );

      await tester.pumpWidget(
        buildSubject(
          home: const BrokerDevicesSettingsPage(),
          activeProfile: editedProfile,
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('settings-client-behind-compatibility')),
        findsNothing,
      );
    });

    testWidgets('allows saving a remote token', (tester) async {
      const profileId = 'https://broker.example.com:9443';
      const token = 'new-token';
      await repository.save(
        BrokerProfile(
          id: profileId,
          displayName: 'remote',
          baseUri: Uri.parse(profileId),
          createdAt: DateTime(2026),
        ),
      );

      await tester.pumpWidget(
        buildSubject(
          home: const BrokerDevicesSettingsPage(),
          activeProfile: BrokerProfile(
            id: profileId,
            displayName: 'remote',
            baseUri: Uri.parse(profileId),
            createdAt: DateTime(2026),
          ),
        ),
      );

      await tester.enterText(
        find.byKey(const Key('settings-broker-token-field')),
        token,
      );
      await tester.ensureVisible(find.byKey(const Key('settings-save-token')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('settings-save-token')));
      await tester.pumpAndSettle();

      expect(await store.readBrokerToken('broker-token:$profileId'), token);
      expect(find.text('Token saved.'), findsOneWidget);
    });

    // N3b central review round 3: a persisted token is durable, so leaving it
    // in the field kept this tab deferring web-update handoffs forever after
    // a successful save.
    testWidgets('a saved token stops deferring the web-update handoff', (
      tester,
    ) async {
      const profileId = 'https://broker.example.com:9443';
      const token = 'durable-once-saved';
      final profile = BrokerProfile(
        id: profileId,
        displayName: 'remote',
        baseUri: Uri.parse(profileId),
        createdAt: DateTime(2026),
      );
      await repository.save(profile);

      final registry = WebHandoffParticipants.instance..reset();
      var hints = 0;
      WebHandoffParticipants.readinessHook = () => hints++;
      addTearDown(() {
        WebHandoffParticipants.readinessHook = null;
        registry.reset();
      });

      await tester.pumpWidget(
        buildSubject(
          home: const BrokerDevicesSettingsPage(),
          activeProfile: profile,
        ),
      );
      await tester.enterText(
        find.byKey(const Key('settings-broker-token-field')),
        token,
      );
      expect(
        await registry.prepare(),
        isFalse,
        reason: 'an unsaved token is losable and defers',
      );

      hints = 0;
      await tester.ensureVisible(find.byKey(const Key('settings-save-token')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('settings-save-token')));
      await tester.pumpAndSettle();

      expect(
        find.text(token),
        findsNothing,
        reason: 'the persisted token left the field',
      );
      expect(
        await registry.prepare(),
        isTrue,
        reason: 'a durable token holds nothing back',
      );
      expect(
        hints,
        greaterThanOrEqualTo(1),
        reason:
            'and the tab announced readiness instead of waiting out '
            'the retry cadence',
      );
    });

    testWidgets('typing during an in-flight save survives the clear', (
      tester,
    ) async {
      const profileId = 'https://broker.example.com:9443';
      final gated = _GatedCredentialStore();
      store = gated;
      final profile = BrokerProfile(
        id: profileId,
        displayName: 'remote',
        baseUri: Uri.parse(profileId),
        createdAt: DateTime(2026),
      );
      await repository.save(profile);

      final registry = WebHandoffParticipants.instance..reset();
      addTearDown(registry.reset);

      gated.writeGate = Completer<void>();
      await tester.pumpWidget(
        buildSubject(
          home: const BrokerDevicesSettingsPage(),
          activeProfile: profile,
        ),
      );
      const field = Key('settings-broker-token-field');
      await tester.enterText(find.byKey(field), 'first-token');
      await tester.ensureVisible(find.byKey(const Key('settings-save-token')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('settings-save-token')));
      await tester.pump();

      // The user keeps typing while the write is still in flight.
      await tester.enterText(find.byKey(field), 'newer-token');

      gated.writeGate!.complete();
      gated.writeGate = null;
      await tester.pumpAndSettle();

      expect(
        find.text('newer-token'),
        findsOneWidget,
        reason:
            'nobody persisted the newer credential, so nobody may '
            'discard it',
      );
      expect(
        await gated.readBrokerToken('broker-token:$profileId'),
        'first-token',
      );
      expect(
        await registry.prepare(),
        isFalse,
        reason: 'and it still defers the handoff',
      );
    });

    testWidgets('a failed save keeps the unsaved token in the field', (
      tester,
    ) async {
      const profileId = 'https://broker.example.com:9443';
      final gated = _GatedCredentialStore()
        ..writeError = StateError('keyring gone');
      store = gated;
      final profile = BrokerProfile(
        id: profileId,
        displayName: 'remote',
        baseUri: Uri.parse(profileId),
        createdAt: DateTime(2026),
      );
      await repository.save(profile);

      final registry = WebHandoffParticipants.instance..reset();
      addTearDown(registry.reset);

      await tester.pumpWidget(
        buildSubject(
          home: const BrokerDevicesSettingsPage(),
          activeProfile: profile,
        ),
      );
      await tester.enterText(
        find.byKey(const Key('settings-broker-token-field')),
        'not-actually-saved',
      );
      await tester.ensureVisible(find.byKey(const Key('settings-save-token')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('settings-save-token')));
      await tester.pumpAndSettle();

      expect(
        find.text('not-actually-saved'),
        findsOneWidget,
        reason: 'only a confirmed save may empty the field',
      );
      expect(
        await registry.prepare(),
        isFalse,
        reason: 'an unpersisted token still defers the handoff',
      );
    });

    testWidgets('outer Servers action removes a stored credential', (
      tester,
    ) async {
      const profileId = 'https://broker.example.com:9443';
      const token = 'stored-token';
      const credentialKey = 'broker-token:$profileId';
      await store.writeBrokerToken(credentialKey, token);
      await repository.save(
        BrokerProfile(
          id: profileId,
          displayName: 'remote',
          baseUri: Uri.parse(profileId),
          createdAt: DateTime(2026),
          credentialKey: credentialKey,
        ),
      );

      await tester.pumpWidget(
        buildSubject(
          home: const BrokerDevicesSettingsPage(),
          activeProfile: BrokerProfile(
            id: profileId,
            displayName: 'remote',
            baseUri: Uri.parse(profileId),
            createdAt: DateTime(2026),
            credentialKey: credentialKey,
          ),
        ),
      );

      await tester.scrollUntilVisible(
        find.byKey(const Key('servers-remove-credential')),
        300,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.tap(find.byKey(const Key('servers-remove-credential')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.text('Sign out'),
        ),
      );
      await tester.pumpAndSettle();

      expect(await store.readBrokerToken(credentialKey), isNull);
      expect(
        find.text('Signed out. Server credentials were removed.'),
        findsOneWidget,
      );
      expect(
        find.widgetWithText(
          SelectableText,
          'Signed out. Server credentials were removed.',
        ),
        findsOneWidget,
      );
    });

    testWidgets('gate stays out of the way while connected', (tester) async {
      await tester.pumpWidget(
        buildSubject(home: const BrokerDevicesSettingsPage()),
      );
      await tester.pumpAndSettle();
      await tester.drag(find.byType(ListView), const Offset(0, -500));
      await tester.pumpAndSettle();

      // A connected gate occupies no space and shows no recovery UI.
      expect(find.byKey(const Key('broker-gate-unreachable')), findsNothing);
      expect(
        find.byKey(const Key('broker-gate-credential-rejected')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('broker-gate-credential-missing')),
        findsNothing,
      );
      expect(find.text('Server Credentials'), findsOneWidget);
    });

    testWidgets('gate reports an offline broker without asking for a token', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSubject(
          home: const BrokerDevicesSettingsPage(),
          gateState: BrokerGateState.unreachable(
            detail: 'Connection refused',
            brokerUrl: Uri.parse('http://127.0.0.1:7734'),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('broker-gate-unreachable')), findsOneWidget);
      expect(find.byKey(const Key('broker-gate-token-field')), findsNothing);
      expect(find.byKey(const Key('broker-gate-token-help')), findsNothing);
    });

    testWidgets('gate names a rejected credential in settings', (tester) async {
      await tester.pumpWidget(
        buildSubject(
          home: const BrokerDevicesSettingsPage(),
          gateState: const BrokerGateState.unauthorized(
            credentialIssue: BrokerGateCredentialIssue.rejected,
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('broker-gate-credential-rejected')),
        findsOneWidget,
      );
      expect(find.byKey(const Key('broker-gate-pair-device')), findsOneWidget);
    });

    testWidgets('sign out is cancellable and retains credentials', (
      tester,
    ) async {
      const profileId = 'https://broker.example.com:9443';
      const credentialKey = 'broker-token:$profileId';
      await store.writeBrokerToken(credentialKey, 'stored-token');
      final profile = BrokerProfile(
        id: profileId,
        displayName: 'remote',
        baseUri: Uri.parse(profileId),
        createdAt: DateTime(2026),
        credentialKey: credentialKey,
      );
      await repository.save(profile);

      await tester.pumpWidget(
        buildSubject(
          home: const BrokerDevicesSettingsPage(),
          activeProfile: profile,
        ),
      );
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.byKey(const Key('servers-remove-credential')),
        300,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('servers-remove-credential')));
      await tester.pumpAndSettle();
      expect(find.text('Sign out of this server?'), findsOneWidget);

      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      // Retention is deliberate: nothing is cleared without confirmation.
      expect(await store.readBrokerToken(credentialKey), 'stored-token');
    });

    testWidgets('confirmed sign out clears the stored credential', (
      tester,
    ) async {
      const profileId = 'https://broker.example.com:9443';
      const credentialKey = 'broker-token:$profileId';
      await store.writeBrokerToken(credentialKey, 'stored-token');
      final profile = BrokerProfile(
        id: profileId,
        displayName: 'remote',
        baseUri: Uri.parse(profileId),
        createdAt: DateTime(2026),
        credentialKey: credentialKey,
      );
      await repository.save(profile);

      await tester.pumpWidget(
        buildSubject(
          home: const BrokerDevicesSettingsPage(),
          activeProfile: profile,
        ),
      );
      await tester.pumpAndSettle();
      await tester.scrollUntilVisible(
        find.byKey(const Key('servers-remove-credential')),
        300,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('servers-remove-credential')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.text('Sign out'),
        ),
      );
      await tester.pumpAndSettle();

      expect(await store.readBrokerToken(credentialKey), isNull);
      expect(
        (await repository.getById(profileId))?.credentialKey,
        isNull,
      );
    });
  });
}

class _StubGateController extends BrokerGateController {
  _StubGateController(this.result);

  final BrokerGateState result;

  @override
  Future<BrokerGateState> build() async => result;
}

final class _MemoryAttentionFeedSettingsStore
    implements AttentionFeedSettingsStore {
  final Set<String> disabled = {};

  @override
  Future<bool> isFeedEnabled(String brokerProfileId) async =>
      !disabled.contains(brokerProfileId);

  @override
  Future<List<String>> listDisabledProfileIds() async => disabled.toList();

  @override
  Future<void> setFeedEnabled({
    required String brokerProfileId,
    required bool enabled,
  }) async {
    if (!enabled) {
      disabled.add(brokerProfileId);
    } else {
      disabled.remove(brokerProfileId);
    }
  }
}

final class _MemoryRemoteWakeSettingsStore implements RemoteWakeSettingsStore {
  bool enabled = false;

  @override
  Future<bool> isEnabled() async => enabled;

  @override
  Future<void> setEnabled({required bool enabled}) async {
    this.enabled = enabled;
  }
}

final class _FakePermissionRequester {
  int requests = 0;
  bool throwOnRequest = false;
  FlutterLocalNotificationPermissionRequestResult nextResult =
      const FlutterLocalNotificationPermissionRequestResult(
        outcome: FlutterLocalNotificationPermissionRequestOutcome.granted,
      );

  Future<FlutterLocalNotificationPermissionRequestResult> call() async {
    requests += 1;
    if (throwOnRequest) {
      throw Exception('permission request failed');
    }
    return nextResult;
  }
}

final class _FakeManagedRuntimeApi implements ManagedRuntimeApi {
  final List<String> policyWrites = [];
  int restartAllCalls = 0;
  String? brokerVersion = '1.0.0';
  Completer<void>? runtimeUpdatesGate;
  Error? runtimeUpdatesError;

  @override
  Future<RuntimeUpdatesResponse> getRuntimeUpdates({bool fresh = false}) async {
    final gate = runtimeUpdatesGate;
    if (gate != null) await gate.future;
    final error = runtimeUpdatesError;
    if (error != null) throw error;
    return const RuntimeUpdatesResponse(
      ok: true,
      updates: [
        AgentRuntimeUpdateStatus(
          agent: 'codex',
          displayName: 'Codex',
          managed: true,
          state: 'pending',
          updateAvailable: true,
          autoRestartReady: false,
          pendingChanges: ['configuration'],
          checkedAt: 1,
          runningVersion: '0.144.1',
          installedVersion: '0.144.1',
          blockers: 1,
          blockerComposition: AgentRuntimeBlockerComposition(
            idle: 1,
            working: 0,
            needsInput: 0,
            unknown: 0,
          ),
        ),
      ],
    );
  }

  @override
  Future<CodexUpdatePolicyResponse> getPolicy() async =>
      const CodexUpdatePolicyResponse(
        codexUpdatePolicy: 'when-detached',
        ok: true,
      );

  @override
  Future<BrokerHealthResponse> getHealth() async =>
      const BrokerHealthResponse(status: 'healthy', checkedAt: 1);

  @override
  Future<HealthResponse> getProductHealth() async =>
      HealthResponse(ok: true, version: brokerVersion);

  @override
  Future<BrokerUpdateResponse> getBrokerUpdate({bool refresh = false}) async =>
      BrokerUpdateResponse(
        ok: true,
        update: BrokerUpdateSnapshot(
          status: 'current',
          currentVersion: brokerVersion ?? 'unknown',
          checkedAt: '2026-07-18T00:00:00Z',
          detailCode: 'current',
        ),
      );

  @override
  Future<BrokerUpdateTriggerResponse> triggerBrokerUpdate() async =>
      const BrokerUpdateTriggerResponse(
        ok: true,
        accepted: false,
        message: 'Already current',
        update: BrokerUpdateSnapshot(
          status: 'current',
          currentVersion: '1.0.0',
          checkedAt: '2026-07-18T00:00:00Z',
          detailCode: 'current',
        ),
      );

  @override
  Future<TokdashQuotaPreferenceResponse> getQuotaPreference() async =>
      const TokdashQuotaPreferenceResponse(ok: true, enabled: false);

  TokdashQuotaResponse quota = const TokdashQuotaResponse(ok: true);

  @override
  Future<TokdashQuotaResponse> getQuota() async => quota;

  @override
  Future<CodexUpdatePolicyResponse> setPolicy(String value) async {
    policyWrites.add(value);
    return CodexUpdatePolicyResponse(codexUpdatePolicy: value, ok: true);
  }

  @override
  Future<TokdashQuotaPreferenceResponse> setQuotaPreference({
    required bool enabled,
  }) async => TokdashQuotaPreferenceResponse(ok: true, enabled: enabled);

  @override
  Future<RuntimeUpdateRestartResponse> restartRuntime(String agent) async =>
      const RuntimeUpdateRestartResponse(ok: true);

  @override
  Future<BrokerRestartAllResponse> restartAll() async {
    restartAllCalls += 1;
    return const BrokerRestartAllResponse(ok: true, message: 'scheduled');
  }
}

final class _SpyCredentialStore implements CredentialStore {
  final Map<String, String> _tokens = <String, String>{};

  @override
  Future<String?> readBrokerToken(String credentialKey) async =>
      _tokens[credentialKey];

  @override
  Future<void> writeBrokerToken(String credentialKey, String token) async {
    _tokens[credentialKey] = token;
  }

  @override
  Future<void> deleteBrokerToken(String credentialKey) async {
    _tokens.remove(credentialKey);
  }
}

/// A credential store whose write can be held open or made to fail, so tests
/// can observe the field mid-save and after an unconfirmed save.
final class _GatedCredentialStore extends _SpyCredentialStore {
  Completer<void>? writeGate;
  Error? writeError;

  @override
  Future<void> writeBrokerToken(String credentialKey, String token) async {
    final gate = writeGate;
    if (gate != null) await gate.future;
    final error = writeError;
    if (error != null) throw error;
    await super.writeBrokerToken(credentialKey, token);
  }
}

final class _MemoryBrokerIdentityStore implements BrokerIdentityStore {
  final Map<String, HealthResponse> _health = {};
  final Map<String, HelloWireEvent> _hello = {};

  @override
  Future<HealthResponse?> read(String brokerScopeKey) async =>
      _health[brokerScopeKey];

  @override
  Future<void> write(
    String brokerScopeKey,
    HealthResponse health,
  ) async {
    _health[brokerScopeKey] = health;
  }

  @override
  Future<HelloWireEvent?> readHello(String brokerScopeKey) async =>
      _hello[brokerScopeKey];

  @override
  Future<void> writeHello(
    String brokerScopeKey,
    HelloWireEvent hello,
  ) async {
    _hello[brokerScopeKey] = hello;
  }
}

final class _InMemorySessionNotificationSettingsStore
    implements SessionNotificationSettingsStore {
  _InMemorySessionNotificationSettingsStore() : value = false;

  bool value;

  @override
  Future<bool> getLocalNotificationEnabled() async => value;

  @override
  Future<void> setLocalNotificationEnabled({required bool enabled}) async {
    value = enabled;
  }
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
