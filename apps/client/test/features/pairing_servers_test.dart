// F01 — Pairing, the connection gate, and saved servers.
//
// Every scenario runs the real App against wire-level fake brokers
// (`test/support/feature/`): the real REST client, probes, pairing crypto,
// Drift database and secure storage all run; only the broker, the installer
// inbox and time are fake. Waits are bounded pumps of fake time; nothing
// sleeps on the wall clock.
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/data/active_broker_profile_store.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/pairing/controller/installer_pairing_handoff_controller.dart';
import 'package:cosyncing_client/src/features/pairing/data/transport_pairing_store.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/roster/roster_snapshot_store.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:cosyncing_client/src/features/settings/view/settings_common.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_participants.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/app_driver.dart';
import '../support/feature/cosyncing_app.dart';
import '../support/feature/fake_broker.dart';
import '../support/feature/store_faults.dart';

final AppLocalizations en = lookupAppLocalizations(const Locale('en'));
final AppLocalizations zh = lookupAppLocalizations(const Locale('zh'));

const _addressField = Key('connection-server-address-field');

void main() {
  group('first connection', () {
    featureTest(
      'a fresh install offers only the way to connect and asks no server for '
      'anything',
      (f) async {
        final local = f.network.add('http://127.0.0.1:7734');
        final app = await f.launch();

        expect(find.text(en.sessionsEmptyTitle), findsWidgets);
        expect(find.byKey(const Key('sessions-empty-connect')), findsOneWidget);
        expect(find.byKey(const Key('broker-gate-token-field')), findsNothing);
        expect(app.activeServer, isNull);

        await app.tapKey('sessions-empty-connect');
        expect(
          find.byKey(const Key('connection-direct-method')),
          findsOneWidget,
        );
        expect(find.text(en.connectionIdleTitle), findsOneWidget);
        // Not even the displayed local default is probed until asked.
        expect(local.requests, isEmpty);
      },
    );

    featureTest(
      'Connect normalizes every address shape, saves and activates that '
      'exact server, and its roster loads',
      (f) async {
        const rows = <(String typed, String server)>[
          ('studio.test:8080', 'http://studio.test:8080'),
          ('desk.test', 'http://desk.test:7734'),
          ('localhost', 'http://127.0.0.1:7734'),
          ('http://lab.test:7734/api/health?x=1#frag', 'http://lab.test:7734'),
          ('https://fixture.tailnet.ts.net', 'https://fixture.tailnet.ts.net'),
          ('  http://192.0.2.10  ', 'http://192.0.2.10:7734'),
        ];
        final brokers = {
          for (final (_, server) in rows)
            server: f.network.add(server, machine: Uri.parse(server).host),
        };
        final app = await f.launch(initialLocation: connectionRoute);

        for (final (typed, server) in rows) {
          final broker = brokers[server]!;
          final probesBefore = broker.requestsTo('/api/health').length;
          await app.connectTo(typed);
          await app.waitFor(find.text(en.connectionConnectedTitle));

          expect(
            broker.requestsTo('/api/health'),
            hasLength(probesBefore + 1),
            reason: '"$typed" probes $server',
          );
          expect(app.activeServer?.id, server, reason: typed);
          expect(app.activeServer?.baseUri.toString(), server);
          expect(await f.storage.activeServer.getActiveProfileId(), server);
          expect(
            find.text(en.connectionConnectedMachine(broker.machine)),
            findsOneWidget,
          );
        }
        expect(
          (await app.savedServers()).map((s) => s.id).toSet(),
          brokers.keys.toSet(),
        );

        // An empty field connects to the local server it displays, and Enter
        // submits from the keyboard.
        await app.enterText(find.byKey(_addressField), '');
        await app.tap(find.widgetWithText(FilledButton, en.connectionConnect));
        await app.waitFor(find.text(en.connectionConnectedTitle));
        expect(app.activeServer?.id, 'http://127.0.0.1:7734');
        await app.enterText(find.byKey(_addressField), 'desk.test');
        await f.tester.testTextInput.receiveAction(TextInputAction.done);
        await app.pumpUntil(
          () => app.activeServer?.id == 'http://desk.test:7734',
          reason: 'Enter connects to desk.test',
        );

        await app.go(sessionsRoute);
        await app.pumpUntil(
          () => brokers['http://desk.test:7734']!
              .requestsTo('/api/sessions')
              .isNotEmpty,
          reason: 'the active server roster loads',
        );
      },
    );

    featureTest(
      'an invalid address is refused on the spot and nothing is probed',
      (f) async {
        final app = await f.launch(initialLocation: connectionRoute);
        for (final typed in const [
          'http://',
          'ftp://studio.test',
          '127.0.0.1:0',
          'studio.test:70000',
          'not a server!',
        ]) {
          await app.connectTo(typed);
          expect(find.text(en.connectionFailedTitle), findsOneWidget);
          expect(find.text(en.connectionInvalidUrl), findsOneWidget);
        }
        expect(
          f.network.requests.where((r) => r.path.startsWith('/api/')),
          isEmpty,
        );
        expect(app.activeServer, isNull);
        expect(await app.savedServers(), isEmpty);
      },
    );

    featureTest(
      'a failed probe leaves the active server alone; Reset clears the '
      'selection but keeps the saved server',
      (f) async {
        final studio = f.network.add('http://studio.test:7734');
        f.network.add('http://sick.test:7734').healthy = false;
        await f.storage.seedServer(studio);
        final app = await f.launch(initialLocation: connectionRoute);
        expect(app.activeServer?.id, 'http://studio.test:7734');

        await app.connectTo('offline.test');
        expect(find.text(en.connectionFailedTitle), findsOneWidget);
        expect(find.text(en.connectionBrokerUnreachable), findsOneWidget);
        app.expectNoRawErrorLeak();
        expect(app.activeServer?.id, 'http://studio.test:7734');

        await app.connectTo('sick.test');
        expect(find.text(en.connectionBrokerUnhealthy), findsOneWidget);
        expect(app.activeServer?.id, 'http://studio.test:7734');
        expect(
          (await app.savedServers()).map((s) => s.id),
          ['http://studio.test:7734'],
        );

        await app.tap(find.widgetWithText(TextButton, en.connectionReset));
        expect(find.text(en.connectionIdleTitle), findsOneWidget);
        expect(app.activeServer, isNull);
        expect(await f.storage.activeServer.getActiveProfileId(), isNull);
        expect(await app.savedServers(), hasLength(1));
      },
    );

    featureTest(
      'a late probe answer after Reset or after picking a saved server is '
      'ignored',
      (f) async {
        // Regression: a slow direct-connect probe used to land after the user
        // had moved on, re-activating and saving the abandoned server.
        final slow = f.network.add('http://slow.test:7734');
        final other = f.network.add('http://other.test:7734');
        await f.storage.seedServer(other, active: false, displayName: 'Other');
        final app = await f.launch(initialLocation: connectionRoute);

        var held = slow.hold('GET', '/api/health');
        await app.connectTo('slow.test');
        await app.pumpUntil(() => held.pending == 1, reason: 'probe parked');
        expect(find.text(en.connectionCheckingTitle), findsOneWidget);
        await app.tap(find.widgetWithText(TextButton, en.connectionReset));
        held.release();
        await app.settle();
        expect(find.text(en.connectionIdleTitle), findsOneWidget);
        expect(app.activeServer, isNull);
        expect(
          (await app.savedServers()).map((s) => s.id),
          ['http://other.test:7734'],
        );

        held = slow.hold('GET', '/api/health');
        await app.connectTo('slow.test');
        await app.pumpUntil(() => held.pending == 1, reason: 'probe parked');
        await app.tapKey('connection-saved-servers');
        await app.useSavedServer('http://other.test:7734');
        held.release();
        await app.settle();
        expect(app.activeServer?.id, 'http://other.test:7734');
        expect(
          await f.storage.activeServer.getActiveProfileId(),
          'http://other.test:7734',
        );
        expect(
          (await app.savedServers()).map((s) => s.id),
          ['http://other.test:7734'],
        );
      },
    );

    featureTest(
      'reconnecting to a saved server keeps its name, age and credential, and '
      'moves it to the top of the list',
      (f) async {
        final studio = f.network.add(
          'http://studio.test:7734',
          ownerToken: 'owner-studio',
        );
        final desk = f.network.add('http://desk.test:7734');
        await f.storage.seedServer(
          studio,
          displayName: 'Studio desk',
          ownerToken: 'owner-studio',
          active: false,
          createdAt: DateTime.utc(2026, 6, 25),
          lastUsedAt: DateTime.utc(2026, 6, 25),
        );
        await f.storage.seedServer(
          desk,
          createdAt: DateTime.utc(2026, 7),
          lastUsedAt: DateTime.utc(2026, 7),
        );
        final app = await f.launch(initialLocation: connectionRoute);

        await app.connectTo('studio.test');
        await app.waitFor(find.text(en.connectionConnectedTitle));
        final studioRow = (await app.savedServers()).firstWhere(
          (s) => s.id == 'http://studio.test:7734',
        );
        expect(studioRow.displayName, 'Studio desk');
        expect(studioRow.createdAt.toUtc(), DateTime.utc(2026, 6, 25));
        expect(
          studioRow.credentialKey,
          'broker-token:http://studio.test:7734',
        );
        expect(studioRow.lastUsedAt!.isAfter(DateTime.utc(2026, 7)), isTrue);
        expect(
          await f.storage.token('broker-token:http://studio.test:7734'),
          'owner-studio',
        );

        await app.go(brokerProfilesRoute);
        final studioTop = f.tester.getTopLeft(
          AppDriver.savedServer('http://studio.test:7734'),
        );
        final deskTop = f.tester.getTopLeft(
          AppDriver.savedServer('http://desk.test:7734'),
        );
        expect(studioTop.dy, lessThan(deskTop.dy));
      },
    );

    featureTest(
      'a restart reopens the remembered server; a remembered server that was '
      'deleted falls back to connecting',
      (f) async {
        final studio = f.network.add('http://studio.test:7734');
        var app = await f.launch(initialLocation: connectionRoute);
        await app.connectTo('studio.test');
        await app.waitFor(find.text(en.connectionConnectedTitle));

        final probes = studio.requestsTo('/api/health').length;
        app = await f.restart();
        expect(app.activeServer?.id, 'http://studio.test:7734');
        await app.pumpUntil(
          () => studio.requests.any(
            (r) => r.path == '/api/sessions' && r.uri.hasQuery,
          ),
          reason: 'the restored server roster loads',
        );
        // Restoring a server is not a fresh Connect: no direct probe runs.
        expect(studio.requestsTo('/api/health'), hasLength(probes));

        await f.storage.activeServer.setActiveProfileId(
          'http://gone.test:7734',
        );
        app = await f.restart();
        expect(app.activeServer, isNull);
        expect(await f.storage.activeServer.getActiveProfileId(), isNull);
        expect(find.byKey(const Key('sessions-empty-connect')), findsOneWidget);
      },
    );

    featureTest(
      'the connection screen offers both ways in side by side, commits a '
      'typed address only on success, and stays usable small, large and in '
      'Chinese',
      (f) async {
        f.network.add('http://studio.test:7734');
        var app = await f.launch(initialLocation: connectionRoute);
        final direct = find.byKey(const Key('connection-direct-method'));
        final pair = find.byKey(const Key('connection-pair-method'));
        expect(f.tester.getTopLeft(direct).dy, f.tester.getTopLeft(pair).dy);
        expect(find.byKey(const Key('pairing-payload-field')), findsOneWidget);
        expect(find.byKey(const Key('pairing-scan-button')), findsNothing);
        expect(find.text(en.connectionDirectTitle), findsOneWidget);
        expect(find.text(en.connectionPairTitle), findsOneWidget);

        // A half-typed address holds a web-update handoff; a connected one
        // no longer does.
        await app.enterText(find.byKey(_addressField), 'studio.test');
        expect(await WebHandoffParticipants.instance.prepare(), isFalse);
        await app.tap(find.widgetWithText(FilledButton, en.connectionConnect));
        await app.waitFor(find.text(en.connectionConnectedTitle));
        expect(await WebHandoffParticipants.instance.prepare(), isTrue);

        await f.storage.preferences.setLocaleTag('zh');
        await f.storage.preferences.setThemeMode('dark');
        f.tester.platformDispatcher.textScaleFactorTestValue = 2;
        addTearDown(f.tester.platformDispatcher.clearTextScaleFactorTestValue);
        await f.quit();
        app = await f.launch(
          viewport: FeatureViewport.narrowPhone,
          initialLocation: connectionRoute,
        );
        expect(f.tester.takeException(), isNull);
        expect(find.text(zh.connectionDirectTitle), findsOneWidget);
        expect(find.text(zh.connectionPairTitle), findsOneWidget);
        expect(
          f.tester.getTopLeft(pair).dy,
          greaterThan(f.tester.getTopLeft(direct).dy),
        );
        await f.tester.ensureVisible(
          find.byKey(const Key('pairing-import-button')),
        );
        await app.settle();
        expect(
          Theme.of(f.tester.element(direct)).brightness,
          Brightness.dark,
        );
      },
    );
  });

  group('connection gate and credentials', () {
    featureTest(
      'an unreachable server is named with its address and ways out, never '
      'asks for a credential, and keeps raw errors behind Technical details',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..reachable = false;
        await f.storage.seedServer(studio, displayName: 'Studio');
        final app = await f.launch(initialLocation: brokerDevicesSettingsRoute);
        final card = find.byKey(const Key('broker-gate-unreachable'));
        await app.waitFor(card);

        // Down is not unauthorized: nothing blocks the rest of the app.
        expect(find.byKey(const Key('broker-auth-barrier')), findsNothing);
        expect(find.text(en.brokerGateUnreachableTitle('Studio')), findsOne);
        expect(
          find.text(en.brokerGateUnreachableBodyAt('http://studio.test:7734')),
          findsOne,
        );
        for (final key in const [
          'broker-gate-retry',
          'broker-gate-switch-server',
          'broker-gate-add-server',
        ]) {
          expect(find.byKey(Key(key)), findsOneWidget, reason: key);
        }
        for (final key in const [
          'broker-gate-token-field',
          'broker-gate-token-help',
          'broker-gate-pair-device',
        ]) {
          expect(find.byKey(Key(key)), findsNothing, reason: key);
        }
        expect(
          find.ancestor(
            of: find.text(en.brokerGateUnreachableTitle('Studio')),
            matching: find.byType(SelectionArea),
          ),
          findsOneWidget,
          reason: 'people copy the address and error to ask for help',
        );
        _expectNoJargon(app, card);
        app.expectNoRawErrorLeak();
        await app.openGateTechnicalDetails();
        final detail = find.byKey(const Key('broker-gate-detail'));
        expect(f.tester.widget<Text>(detail).data, contains(rawLeakSentinel));
        expect(
          find.ancestor(of: detail, matching: find.byType(SelectionArea)),
          findsOneWidget,
        );

        // A 503 is still "can't reach", never a credential problem; Retry
        // re-probes and recovers once the server answers.
        studio
          ..reachable = true
          ..respondNext(
            'GET',
            '/api/broker/health',
            FakeBrokerResponse.error(503, 'UNAVAILABLE', 'starting up'),
          );
        await app.tapKey('broker-gate-retry');
        expect(card, findsOneWidget);
        expect(find.byKey(const Key('broker-gate-token-field')), findsNothing);
        await app.tapKey('broker-gate-retry');
        await app.waitFor(find.byKey(const Key('broker-gate-connected')));
      },
    );

    featureTest(
      'a device with no token is shown how to connect; a token it just typed '
      'and the server refused is blamed on the token, not on lost access',
      (f) async {
        // Regression: new devices were told they had "lost access" they never
        // had when the first token they typed was refused.
        final studio = f.network.add(
          'http://studio.test:7734',
          ownerToken: 'owner-secret',
        );
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.waitFor(find.byKey(const Key('broker-auth-barrier')));

        expect(
          find.byKey(const Key('broker-gate-credential-missing')),
          findsOneWidget,
        );
        expect(find.text(en.brokerGateMissingTitle), findsOneWidget);
        expect(find.text(en.brokerGatePairDevice), findsOneWidget);
        expect(find.byKey(const Key('broker-gate-token-help')), findsOne);
        expect(find.text('cat ~/.cosyncing/secrets/broker-token'), findsOne);
        expect(find.text('cosy pair'), findsOneWidget);
        final tokenField = f.tester.widget<TextField>(
          find.descendant(
            of: find.byKey(const Key('broker-gate-token-field')),
            matching: find.byType(TextField),
          ),
        );
        expect(tokenField.obscureText, isTrue);
        expect(tokenField.autofillHints, contains(AutofillHints.password));
        expect(
          f.tester
              .widget<TextField>(
                find.descendant(
                  of: find.byKey(const Key('broker-gate-identity-field')),
                  matching: find.byType(TextField),
                ),
              )
              .autofillHints,
          contains(AutofillHints.username),
        );
        // The broker's raw 401 text stays behind the disclosure.
        expect(find.textContaining('Unauthorized: broker'), findsNothing);
        _expectNoJargon(app, find.byKey(const Key('broker-auth-barrier')));

        const key = 'broker-token:http://studio.test:7734';
        await app.saveGateToken('   ');
        final error = find.byKey(const Key('broker-gate-token-error'));
        expect(error, findsOneWidget);
        expect(
          find.ancestor(of: error, matching: find.byType(SelectionArea)),
          findsOneWidget,
        );
        expect(await f.storage.token(key), isNull);

        await app.saveGateToken('mistyped-token');
        await app.waitFor(find.text(en.brokerGateTokenRejectedTitle));
        expect(find.text(en.brokerGateTokenRejectedBody), findsOneWidget);
        expect(find.text(en.brokerGateRejectedTitle), findsNothing);
        expect(find.text(en.brokerGatePairDeviceAgain), findsOneWidget);
        expect(find.textContaining('mistyped-token'), findsNothing);

        await app.saveGateToken('owner-secret');
        await app.waitForAbsent(find.byKey(const Key('broker-auth-barrier')));
        expect(await f.storage.token(key), 'owner-secret');
        expect(app.activeServer?.credentialKey, key);
        await app.pumpUntil(
          () => studio.requests.any(
            (r) => r.path == '/api/sessions' && r.ownerToken == 'owner-secret',
          ),
          reason: 'the roster loads with the saved token',
        );
      },
    );

    featureTest(
      'a stored token that stopped working says the device is no longer '
      'signed in, in English and in Chinese with no shared literal',
      (f) async {
        final studio = f.network.add(
          'http://studio.test:7734',
          ownerToken: 'owner-secret',
        );
        await f.storage.seedServer(studio, ownerToken: 'revoked-token');
        final barrier = find.byKey(const Key('broker-auth-barrier'));
        var app = await f.launch();
        await app.waitFor(barrier);
        expect(
          find.byKey(const Key('broker-gate-credential-rejected')),
          findsOneWidget,
        );
        expect(find.text(en.brokerGateRejectedTitle), findsOneWidget);
        expect(find.textContaining('revoked or renewed'), findsOneWidget);
        expect(find.text(en.brokerGateTokenRejectedTitle), findsNothing);
        expect(find.byKey(const Key('broker-gate-token-field')), findsOne);
        final english = _texts(barrier);

        await f.storage.preferences.setLocaleTag('zh');
        app = await f.restart();
        await app.waitFor(find.text(zh.brokerGateRejectedTitle));
        expect(find.text(zh.brokerGatePairDeviceAgain), findsOneWidget);
        expect(find.text(en.brokerGateRejectedTitle), findsNothing);
        expect(
          english.intersection(_texts(barrier)),
          isEmpty,
          reason: 'every gate string is localized, none is a Dart literal',
        );
      },
    );

    featureTest(
      'a token that cannot be saved with its server leaves the previous '
      'sign-in exactly as it was',
      (f) async {
        final studio = f.network.add(
          'http://studio.test:7734',
          ownerToken: 'owner-secret',
        );
        await f.storage.seedServer(studio, ownerToken: 'revoked-token');
        final profiles = FaultyProfileRepository(f.storage.profiles);
        final app = await f.launch(
          overrides: [
            brokerProfileRepositoryProvider.overrideWithValue(profiles),
          ],
        );
        const key = 'broker-token:http://studio.test:7734';
        await app.waitFor(
          find.byKey(const Key('broker-gate-credential-rejected')),
        );

        profiles.saves.failNext = true;
        await app.saveGateToken('owner-secret');
        await app.waitFor(find.byKey(const Key('broker-gate-token-error')));
        expect(app.visibleText, isNot(contains('injected')));
        expect(
          await f.storage.token(key),
          'revoked-token',
          reason: 'the half-saved token was rolled back',
        );
        expect(find.byKey(const Key('broker-auth-barrier')), findsOneWidget);

        await app.saveGateToken('owner-secret');
        await app.waitForAbsent(find.byKey(const Key('broker-auth-barrier')));
        expect(await f.storage.token(key), 'owner-secret');
      },
    );

    featureTest(
      'a paired device authenticates with its peer token and an owner with '
      'the owner token, on the probe and on every REST call',
      (f) async {
        final studio = f.network.add(
          'http://studio.test:7734',
          ownerToken: 'owner-studio',
        )..peerTokens.add('peer-phone');
        final desk = f.network.add(
          'http://desk.test:7734',
          ownerToken: 'owner-desk',
        );
        await f.storage.seedServer(studio, peerToken: 'peer-phone');
        await f.storage.seedServer(
          desk,
          ownerToken: 'owner-desk',
          active: false,
        );
        final app = await f.launch(initialLocation: brokerDevicesSettingsRoute);
        await app.pumpUntil(
          () => studio.requestsTo('/api/sessions').isNotEmpty,
          reason: 'the paired server roster loads',
        );
        _expectAuthenticatedAs(studio, peer: 'peer-phone');

        await app.useSavedServer('http://desk.test:7734');
        await app.pumpUntil(
          () => desk.requestsTo('/api/sessions').isNotEmpty,
          reason: 'the owner server roster loads',
        );
        _expectAuthenticatedAs(desk, owner: 'owner-desk');
        expect(find.byKey(const Key('broker-auth-barrier')), findsNothing);
      },
    );

    featureTest(
      'an unreadable credential store probes anonymously and never sends '
      'anonymous REST calls',
      (f) async {
        final studio = f.network.add(
          'http://studio.test:7734',
          ownerToken: 'owner-secret',
        );
        await f.storage.seedServer(studio, ownerToken: 'owner-secret');
        final credentials = FaultyCredentialStore(f.storage.credentials);
        credentials.reads.fail = true;
        final app = await f.launch(
          overrides: [credentialStoreProvider.overrideWithValue(credentials)],
        );
        await app.waitFor(
          find.byKey(const Key('broker-gate-credential-missing')),
        );
        expect(studio.requestsTo('/api/broker/health').first.anonymous, isTrue);
        expect(
          studio.requests.where((r) => r.path != '/api/broker/health'),
          isEmpty,
          reason: 'a configured credential never silently downgrades',
        );
      },
    );

    featureTest(
      'a blank stored token counts as no token: the gate asks for one '
      'instead of reporting a lost sign-in',
      (f) async {
        final studio = f.network.add(
          'http://studio.test:7734',
          ownerToken: 'owner-secret',
        );
        await f.storage.seedServer(studio, ownerToken: '   ');
        final app = await f.launch();
        await app.waitFor(
          find.byKey(const Key('broker-gate-credential-missing')),
        );
        expect(
          find.byKey(const Key('broker-gate-credential-rejected')),
          findsNothing,
        );
        expect(
          studio.requests.where((r) => !r.anonymous),
          isEmpty,
          reason: 'a blank token is never sent',
        );
      },
    );

    featureTest(
      'a configured token missing from storage fails closed, and a loopback '
      'server still gets its token',
      (f) async {
        final studio = f.network.add(
          'http://studio.test:7734',
          ownerToken: 'owner-secret',
        );
        await f.storage.seedServer(studio, ownerToken: 'owner-secret');
        await f.storage.credentials.deleteBrokerToken(
          'broker-token:http://studio.test:7734',
        );
        var app = await f.launch();
        await app.waitFor(find.byKey(const Key('broker-auth-barrier')));
        expect(
          studio.requests.where(
            (r) => r.anonymous && r.path != '/api/broker/health',
          ),
          isEmpty,
        );

        final local = f.network.add(
          'http://127.0.0.1:7734',
          ownerToken: 'local-owner',
        );
        await f.storage.seedServer(local, ownerToken: 'local-owner');
        app = await f.restart();
        await app.pumpUntil(
          () => local.requestsTo('/api/sessions').isNotEmpty,
          reason: 'the loopback roster loads',
        );
        _expectAuthenticatedAs(local, owner: 'local-owner');
      },
    );

    featureTest(
      'a retry still pending for the old server never replaces the new '
      "server's verdict",
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..reachable = false;
        final desk = f.network.add('http://desk.test:7734');
        await f.storage.seedServer(studio, displayName: 'Studio');
        await f.storage.seedServer(desk, active: false);
        final app = await f.launch(initialLocation: brokerDevicesSettingsRoute);
        await app.waitFor(find.byKey(const Key('broker-gate-unreachable')));

        final attempts = studio.requestsTo('/api/broker/health').length;
        studio.reachable = true;
        final held = studio.hold('GET', '/api/broker/health');
        await app.tapKey('broker-gate-retry');
        expect(
          studio.requestsTo('/api/broker/health'),
          hasLength(attempts + 1),
        );
        expect(find.byKey(const Key('broker-gate-checking')), findsOneWidget);

        await app.useSavedServer('http://desk.test:7734');
        await app.waitFor(find.byKey(const Key('broker-gate-connected')));
        held.release(
          FakeBrokerResponse.error(401, 'AUTH_REQUIRED', 'late answer for A'),
        );
        await app.settle();
        expect(find.byKey(const Key('broker-gate-connected')), findsOneWidget);
        expect(find.byKey(const Key('broker-auth-barrier')), findsNothing);
        expect(app.activeServer?.id, 'http://desk.test:7734');
      },
    );

    featureTest(
      'Sign out removes the stored token and the server credential reference '
      'for owner, loopback and paired servers',
      (f) async {
        final studio = f.network.add('http://studio.test:7734');
        final local = f.network.add('http://127.0.0.1:7734');
        final phone = f.network.add('http://phone.test:7734')
          ..peerTokens.add('peer-phone');
        await f.storage.seedServer(studio, ownerToken: 'owner-studio');
        await f.storage.seedServer(
          local,
          ownerToken: 'owner-local',
          active: false,
        );
        await f.storage.seedServer(
          phone,
          peerToken: 'peer-phone',
          active: false,
        );
        final app = await f.launch(initialLocation: brokerDevicesSettingsRoute);
        final signOut = find.byKey(const Key('servers-remove-credential'));

        for (final (server, key) in const [
          ('http://studio.test:7734', 'broker-token:http://studio.test:7734'),
          ('http://127.0.0.1:7734', 'broker-token:http://127.0.0.1:7734'),
          (
            'http://phone.test:7734',
            'broker-peer-token:http://phone.test:7734',
          ),
        ]) {
          if (app.activeServer?.id != server) {
            await app.useSavedServer(server);
          }
          await app.reveal(signOut);
          expect(find.text(en.settingsSignOutSubtitleHasCredential), findsOne);
          await app.tap(signOut);
          await app.tap(find.text(en.settingsSignOutAction).last);
          await app.waitFor(find.text(en.settingsSignOutSubtitleNoCredential));
          expect(await f.storage.token(key), isNull, reason: server);
          final saved = (await app.savedServers()).firstWhere(
            (s) => s.id == server,
          );
          expect(saved.credentialKey, isNull, reason: server);
          expect(app.activeServer?.credentialKey, isNull, reason: server);
        }
        // With nothing stored, Sign out says so and cannot be pressed.
        final row = f.tester.widget<SettingsRow>(signOut);
        expect(row.onTap, isNull);
      },
    );
  });

  group('pairing by paste and QR', () {
    featureTest(
      'a pasted pairing payload creates and activates its server, storing a '
      'token only when the payload carries one',
      (f) async {
        for (final host in const ['desk', 'home', 'alias', 'plain']) {
          f.network.add('https://$host.test:9443');
        }
        final app = await f.launch(initialLocation: pairingRoute);
        final payloadField = find.byKey(const Key('pairing-payload-field'));
        const rows = <(String, String, String, String?)>[
          (
            '{"brokerUrl":"https://desk.test:9443","token":"abc",'
                '"displayName":"Workstation"}',
            'https://desk.test:9443',
            'Workstation',
            'abc',
          ),
          (
            '{"baseUrl":"https://home.test:9443","displayName":"Home"}',
            'https://home.test:9443',
            'Home',
            null,
          ),
          (
            '{"url":"https://alias.test:9443","token":"from-alias"}',
            'https://alias.test:9443',
            'alias.test',
            'from-alias',
          ),
          (
            'https://plain.test:9443',
            'https://plain.test:9443',
            'plain.test',
            null,
          ),
        ];
        for (final (payload, server, name, token) in rows) {
          await app.importPairing(payload);
          expect(find.text(en.pairingSuccess), findsOneWidget, reason: payload);
          expect(app.activeServer?.id, server);
          final saved = (await app.savedServers()).firstWhere(
            (s) => s.id == server,
          );
          expect(saved.displayName, name);
          expect(
            saved.credentialKey,
            token == null ? isNull : 'broker-token:$server',
          );
          if (token != null) {
            expect(await f.storage.token('broker-token:$server'), token);
          }
          // A pairing link is a one-use secret: it does not linger on screen.
          expect(
            f.tester.widget<TextFormField>(payloadField).controller!.text,
            isEmpty,
          );
          expect(await WebHandoffParticipants.instance.prepare(), isTrue);
        }

        // Re-pairing a saved server keeps its age and credential slot.
        final before = (await app.savedServers()).firstWhere(
          (s) => s.id == 'https://desk.test:9443',
        );
        await app.importPairing(
          '{"brokerUrl":"https://desk.test:9443","token":"rotated"}',
        );
        final after = (await app.savedServers()).firstWhere(
          (s) => s.id == 'https://desk.test:9443',
        );
        expect(after.createdAt, before.createdAt);
        expect(after.credentialKey, before.credentialKey);
        expect(after.displayName, 'Workstation');
        expect(
          await f.storage.token('broker-token:https://desk.test:9443'),
          'rotated',
        );
      },
    );

    featureTest(
      'an empty or malformed pairing payload explains itself in plain words '
      'and stores nothing',
      (f) async {
        final app = await f.launch(initialLocation: pairingRoute);
        for (final (payload, message) in [
          ('', en.pairingEmptyError),
          ('{ "token": "abc" }', en.pairingInvalidError),
          ('http://', en.pairingInvalidError),
          ('cosyncing://pair?payload=not-base64!', en.pairingQrInvalidError),
          // The legacy query-string link form is no longer importable: every
          // cosyncing://pair link is read as a transport QR code.
          (
            'cosyncing://pair?brokerUrl=https%3A%2F%2Fdesk.test%3A9443&token=abc',
            en.pairingQrInvalidError,
          ),
        ]) {
          await app.importPairing(payload);
          expect(find.text(message), findsOneWidget, reason: payload);
        }
        expect(find.text(en.brokerGateTechnicalDetails), findsNothing);
        expect(await app.savedServers(), isEmpty);
        expect(app.activeServer, isNull);
        expect(
          f.network.requests.where((r) => r.path.startsWith('/api/')),
          isEmpty,
        );
      },
    );

    featureTest(
      'a QR v2 code is accepted by its broker and the device signs in with '
      'its own revocable peer token',
      (f) async {
        final studio = f.network.add(
          'http://studio.test:7734',
          ownerToken: 'owner-secret',
        );
        final offer = await studio.issuePairingOffer(version: 2);
        final app = await f.launch(initialLocation: pairingRoute);

        final accept = studio.hold(
          'POST',
          '/api/transport/pairings/${offer.pairingId}/accept',
        );
        await app.importPairing(offer.qr);
        await app.pumpUntil(() => accept.pending == 1, reason: 'accept sent');
        expect(find.text(en.pairingImporting), findsOneWidget);
        expect(
          f.tester
              .widget<FilledButton>(
                find.byKey(const Key('pairing-import-button')),
              )
              .onPressed,
          isNull,
        );
        accept.release();
        await app.waitFor(find.text(en.pairingDeviceSuccess));

        const server = 'http://studio.test:7734';
        expect(app.activeServer?.id, server);
        expect(app.activeServer?.displayName, studio.brokerId);
        expect(app.activeServer?.credentialKey, 'broker-peer-token:$server');
        final peerToken = await f.storage.token('broker-peer-token:$server');
        expect(peerToken, 'peer-token-${offer.pairingId}');
        final acceptRequest = studio.requests.firstWhere(
          (r) => r.method == 'POST',
        );
        expect(acceptRequest.anonymous, isTrue);
        final peerId = (acceptRequest.body! as Map)['peerId'] as String;
        expect(peerId, startsWith('client-'));
        final transport = await SecureTransportPairingStore().read(
          '${studio.brokerId}:$peerId',
        );
        expect(transport?.brokerPeerToken, peerToken);
        expect(transport?.identityPrivateKey, isNotEmpty);
        expect(transport?.brokerUrl, Uri.parse(server));

        await app.go(sessionsRoute);
        await app.pumpUntil(
          () => studio.requestsTo('/api/sessions').isNotEmpty,
          reason: 'the paired server roster loads',
        );
        _expectAuthenticatedAs(studio, peer: peerToken);
      },
    );

    featureTest(
      'a URL-free QR v3 code asks for the Broker URL only because it omits it',
      (f) async {
        final studio = f.network.add('http://studio.test:7734');
        final offer = await studio.issuePairingOffer(includeUrl: false);
        final app = await f.launch(initialLocation: pairingRoute);

        await app.importPairing(offer.qr);
        expect(find.text(en.pairingBrokerUrlRequiredError), findsOneWidget);
        await app.importPairing(offer.qr, brokerUrl: 'ftp://nowhere');
        expect(find.text(en.pairingBrokerUrlInvalidError), findsOneWidget);
        expect(offer.acceptCalls, 0);

        await app.importPairing(offer.qr, brokerUrl: 'studio.test');
        await app.waitFor(find.text(en.pairingDeviceSuccess));
        expect(offer.acceptCalls, 1);
        expect(app.activeServer?.id, 'http://studio.test:7734');
      },
    );

    featureTest(
      'a QR acceptance that does not prove the scanned broker, an offer used '
      'twice, and an old v1 code all store nothing',
      (f) async {
        final studio = f.network.add('http://studio.test:7734');
        final app = await f.launch(initialLocation: pairingRoute);

        Future<void> expectRefused(String message, {String? reason}) async {
          expect(find.text(message), findsOneWidget, reason: reason);
          expect(await app.savedServers(), isEmpty, reason: reason);
          expect(app.activeServer, isNull, reason: reason);
          expect(
            await f.storage.token('broker-peer-token:http://studio.test:7734'),
            isNull,
            reason: reason,
          );
        }

        studio.acceptBrokerPeerIdOverride = 'some-other-broker';
        await app.importPairing((await studio.issuePairingOffer()).qr);
        await expectRefused(en.pairingUnlockError, reason: 'peer mismatch');
        studio
          ..acceptBrokerPeerIdOverride = null
          ..acceptIdentityOverride = 'MCowBQYDK2VwAyEAnot-the-scanned-key';
        await app.importPairing((await studio.issuePairingOffer()).qr);
        await expectRefused(en.pairingUnlockError, reason: 'identity mismatch');
        studio
          ..acceptIdentityOverride = null
          ..forgeAcceptanceSignature = true;
        await app.importPairing((await studio.issuePairingOffer()).qr);
        await expectRefused(en.pairingUnlockError, reason: 'forged signature');

        // Somebody else already redeemed this code: a possible leak, said as
        // such rather than as a generic failure.
        studio.forgeAcceptanceSignature = false;
        final used = await studio.issuePairingOffer();
        used.accepted = true;
        await app.importPairing(used.qr);
        await expectRefused(en.pairingUsedError, reason: 'already accepted');

        final v1 = await studio.issuePairingOffer(version: 1);
        final acceptsBefore = studio.requests.where((r) => r.method == 'POST');
        await app.importPairing(v1.qr);
        await expectRefused(en.pairingQrOldError, reason: 'legacy v1');
        expect(
          studio.requests.where((r) => r.method == 'POST'),
          hasLength(acceptsBefore.length),
        );

        // An oversized broker answer is reduced to plain copy on screen.
        final oversized = await studio.issuePairingOffer();
        studio.respondNext(
          'POST',
          '/api/transport/pairings/${oversized.pairingId}/accept',
          FakeBrokerResponse.error(
            500,
            'PAIRING_FAILED',
            '${'x' * 20000}unbounded-tail',
          ),
        );
        await app.importPairing(oversized.qr);
        await expectRefused(en.pairingGenericError, reason: 'oversized body');
        expect(find.textContaining('unbounded-tail'), findsNothing);
      },
    );

    featureTest(
      'a pairing that fails halfway leaves the previous credential and '
      'selection exactly as they were',
      (f) async {
        final studio = f.network.add('http://studio.test:7734');
        const server = 'http://studio.test:7734';
        await f.storage.seedServer(
          studio,
          ownerToken: 'old-owner',
          active: false,
        );
        final profiles = FaultyProfileRepository(f.storage.profiles);
        final active = FaultyActiveServerStore(f.storage.activeServer);
        final pairing = FaultyTransportPairingStore(
          SecureTransportPairingStore(),
        );
        final app = await f.launch(
          initialLocation: pairingRoute,
          overrides: [
            brokerProfileRepositoryProvider.overrideWithValue(profiles),
            activeBrokerProfileStoreProvider.overrideWithValue(active),
            transportPairingStoreProvider.overrideWithValue(pairing),
          ],
        );

        // Token written, then the profile save fails: the old token is back.
        profiles.saves.failNext = true;
        await app.importPairing('{"brokerUrl":"$server","token":"new-owner"}');
        expect(find.text(en.pairingSaveProfileError), findsOneWidget);
        expect(await f.storage.token('broker-token:$server'), 'old-owner');
        expect(app.activeServer, isNull);

        // Saved, but activation fails: profile and token are kept, unselected.
        active.sets.failNext = true;
        await app.importPairing('{"brokerUrl":"$server","token":"new-owner"}');
        expect(find.text(en.pairingActivateProfileError), findsOneWidget);
        expect(await f.storage.token('broker-token:$server'), 'new-owner');
        expect(app.activeServer, isNull);

        // A QR pairing whose profile adoption fails restores the previous
        // peer token and removes the half-written device credentials.
        await f.storage.credentials.writeBrokerToken(
          'broker-peer-token:$server',
          'previous-peer',
        );
        profiles.saves.failNext = true;
        await app.importPairing((await studio.issuePairingOffer()).qr);
        expect(find.text(en.pairingGenericError), findsOneWidget);
        expect(
          await f.storage.token('broker-peer-token:$server'),
          'previous-peer',
        );
        final firstPeer =
            (studio.requests.lastWhere((r) => r.method == 'POST').body!
                    as Map)['peerId']
                as String;
        expect(
          await pairing.read('${studio.brokerId}:$firstPeer'),
          isNull,
        );
        expect(app.activeServer, isNull);

        // Paired, but activation fails: the paired credential is kept.
        active.sets.failNext = true;
        await app.importPairing((await studio.issuePairingOffer()).qr);
        expect(find.text(en.pairingDeviceActivateError), findsOneWidget);
        final secondPeer =
            (studio.requests.lastWhere((r) => r.method == 'POST').body!
                    as Map)['peerId']
                as String;
        expect(
          await pairing.read('${studio.brokerId}:$secondPeer'),
          isNotNull,
        );
        expect(
          (await app.savedServers()).single.credentialKey,
          'broker-peer-token:$server',
        );
        expect(app.activeServer, isNull);
      },
    );

    featureTest(
      'on a phone the scanner imports exactly one detection, and cancelling '
      'it imports nothing',
      platform: TargetPlatform.iOS,
      (f) async {
        final studio = f.network.add('http://studio.test:7734');
        final camera = f.camera;
        final app = await f.launch(
          viewport: FeatureViewport.phone,
          initialLocation: pairingRoute,
        );
        final scan = find.byKey(const Key('pairing-scan-button'));
        expect(scan, findsOneWidget);
        expect(find.byKey(const Key('pairing-payload-field')), findsOneWidget);

        await app.tap(scan);
        await app.waitFor(find.byKey(const Key('fake-camera-view')));
        expect(find.text(en.pairingScanQr), findsWidgets);
        await f.tester.pageBack();
        await app.settle();
        expect(find.byKey(const Key('fake-camera-view')), findsNothing);
        expect(await app.savedServers(), isEmpty);

        final offer = await studio.issuePairingOffer();
        await app.tap(scan);
        await app.waitFor(find.byKey(const Key('fake-camera-view')));
        camera
          ..detect(offer.qr)
          ..detect(offer.qr);
        await app.waitFor(find.text(en.pairingDeviceSuccess));
        expect(find.byKey(const Key('fake-camera-view')), findsNothing);
        expect(offer.acceptCalls, 1, reason: 'one detection, one import');
        expect(app.activeServer?.id, 'http://studio.test:7734');
      },
    );

    featureTest(
      'while a pairing is importing, the scanner and Import are both disabled',
      platform: TargetPlatform.android,
      (f) async {
        f.camera;
        final studio = f.network.add('http://studio.test:7734');
        final offer = await studio.issuePairingOffer();
        final accept = studio.hold(
          'POST',
          '/api/transport/pairings/${offer.pairingId}/accept',
        );
        final app = await f.launch(
          viewport: FeatureViewport.phone,
          initialLocation: pairingRoute,
        );
        bool enabled(String key) {
          final button = f.tester.widget(find.byKey(Key(key)));
          return switch (button) {
            IconButton(:final onPressed) => onPressed != null,
            ButtonStyleButton(:final onPressed) => onPressed != null,
            _ => throw StateError('not a button: $button'),
          };
        }

        expect(enabled('pairing-scan-button'), isTrue);
        await app.importPairing(offer.qr);
        await app.pumpUntil(() => accept.pending == 1, reason: 'accept sent');
        expect(enabled('pairing-scan-button'), isFalse);
        expect(enabled('pairing-import-button'), isFalse);

        accept.release();
        await app.waitFor(find.text(en.pairingDeviceSuccess));
        expect(enabled('pairing-scan-button'), isTrue);
        expect(enabled('pairing-import-button'), isTrue);
      },
    );

    featureTest(
      'the scanner route is titled in Chinese, and a desktop offers paste only',
      platform: TargetPlatform.android,
      (f) async {
        f.camera;
        await f.storage.preferences.setLocaleTag('zh');
        final app = await f.launch(
          viewport: FeatureViewport.phone,
          initialLocation: pairingRoute,
        );
        await app.tapKey('pairing-scan-button');
        await app.waitFor(find.byKey(const Key('fake-camera-view')));
        expect(find.text(zh.pairingScanQr), findsWidgets);
        expect(find.text(en.pairingScanQr), findsNothing);

        debugDefaultTargetPlatformOverride = TargetPlatform.windows;
        await f.restart(initialLocation: pairingRoute);
        expect(find.byKey(const Key('pairing-scan-button')), findsNothing);
        expect(find.byKey(const Key('pairing-import-button')), findsOneWidget);
      },
    );
  });

  group('installer handoff on first launch', () {
    const barrier = Key('installer-pairing-startup-barrier');
    // A fresh install's way in: no server yet, nothing asked of anyone.
    const connectCta = Key('sessions-empty-connect');
    const local = 'http://127.0.0.1:7734';
    String acceptPath(FakePairingOffer offer) =>
        '/api/transport/pairings/${offer.pairingId}/accept';

    /// The installer asks [broker] for an offer and leaves it in the inbox.
    Future<FakePairingOffer> installerOffer(
      FeatureContext f,
      FakeBroker broker, {
      Duration? expiresIn = const Duration(minutes: 5),
      bool notify = false,
    }) async {
      final offer = await broker.issuePairingOffer();
      f.storage.installerInbox.dropOffer(
        offer.qr,
        brokerUrl: broker.baseUri.toString(),
        expiresAt: expiresIn == null
            ? null
            : f.tester.binding.clock.now().add(expiresIn),
        notify: notify,
      );
      return offer;
    }

    for (final port in [7734, 7735]) {
      featureTest(
        'a live offer for a broker on port $port finishes setup behind '
        '"Finishing setup…" and lands signed in with a peer token',
        (f) async {
          final url = 'http://127.0.0.1:$port';
          final broker = f.network.add(url, ownerToken: 'installer-owner');
          final offer = await installerOffer(f, broker);
          final accept = broker.hold('POST', acceptPath(offer));
          final inbox = f.storage.installerInbox;

          final app = await f.launch();
          await app.pumpUntil(
            () => accept.pending == 1,
            reason: 'the broker receives the acceptance',
          );
          expect(find.byKey(barrier), findsOneWidget);
          expect(find.text(en.installerPairingFinishingTitle), findsOneWidget);
          expect(
            find.byKey(connectCta),
            findsNothing,
            reason: 'no route and no sign-in prompt shows under the barrier',
          );
          // Readiness first; the reusable offer is erased BEFORE the one-use
          // acceptance leaves the device.
          expect(broker.requests.first.path, '/api/health');
          expect(inbox.operations, ['read', 'discard']);
          expect(inbox.holdsOffer, isFalse);

          accept.release();
          await app.waitForAbsent(find.byKey(barrier));
          expect(app.activeServer?.id, url);
          final key = 'broker-peer-token:$url';
          expect(app.activeServer?.credentialKey, key);
          final token = await f.storage.token(key);
          expect(token, 'peer-token-${offer.pairingId}');
          await app.pumpUntil(
            () => broker.requestsTo('/api/sessions').isNotEmpty,
            reason: 'the roster loads',
          );
          _expectAuthenticatedAs(broker, peer: token);

          final relaunched = await f.restart();
          expect(find.byKey(barrier), findsNothing);
          expect(relaunched.activeServer?.id, url);
          expect(offer.acceptCalls, 1);
        },
      );
    }

    for (final (label, fault) in <(String, void Function(FakeBroker, String))>[
      (
        'refuses',
        (broker, path) => broker.respondNext(
          'POST',
          path,
          FakeBrokerResponse.error(410, 'PAIRING_EXPIRED', 'Pairing expired'),
        ),
      ),
      (
        'loses its answer to',
        (broker, path) => broker.loseNextAnswer('POST', path),
      ),
    ]) {
      featureTest(
        'when the broker $label the acceptance, setup says so before manual '
        'sign-in and never redeems the offer again',
        (f) async {
          final broker = f.network.add(local);
          final offer = await installerOffer(f, broker);
          fault(broker, acceptPath(offer));

          final app = await f.launch();
          await app.waitFor(
            find.byKey(const Key('installer-pairing-import-error')),
          );
          expect(find.text(en.installerPairingFailedTitle), findsOneWidget);
          app.expectNoRawErrorLeak();
          expect(app.activeServer, isNull);
          expect(await f.storage.token('broker-peer-token:$local'), isNull);
          expect(f.storage.installerInbox.holdsOffer, isFalse);

          await app.tap(find.text(en.installerPairingContinue));
          await app.waitFor(find.byKey(connectCta));
          await app.tapKey('sessions-empty-connect');
          expect(
            find.byKey(const Key('connection-direct-method')),
            findsOneWidget,
          );

          await f.restart();
          expect(find.byKey(connectCta), findsOneWidget);
          expect(
            broker.requestsTo(acceptPath(offer), method: 'POST'),
            hasLength(1),
            reason: 'a consumed or ambiguous offer is never sent twice',
          );
        },
      );
    }

    featureTest(
      'an expired, malformed or unreadable handoff is set aside and the app '
      'starts normally',
      (f) async {
        final broker = f.network.add(local);
        final inbox = f.storage.installerInbox;

        // Expired exactly at its deadline.
        await installerOffer(f, broker, expiresIn: Duration.zero);
        var app = await f.launch();
        await app.waitFor(find.byKey(connectCta));
        expect(inbox.holdsOffer, isFalse);

        inbox.drop('{ not json');
        app = await f.restart();
        await app.waitFor(find.byKey(connectCta));
        expect(inbox.holdsOffer, isFalse);

        await installerOffer(f, broker);
        inbox.failRead = true;
        app = await f.restart();
        await app.waitFor(find.byKey(connectCta));
        expect(find.byKey(barrier), findsNothing);

        expect(broker.requests, isEmpty, reason: 'nothing was redeemed');
        expect(app.activeServer, isNull);
      },
    );

    featureTest(
      'an offer with no stated expiry, waiting behind an expired claim, is '
      'still redeemed',
      (f) async {
        final broker = f.network.add(local);
        final stale = await installerOffer(
          f,
          broker,
          expiresIn: const Duration(minutes: -1),
        );
        final fresh = await installerOffer(f, broker, expiresIn: null);

        final app = await f.launch();
        await app.pumpUntil(
          () => app.activeServer?.id == local,
          reason: 'the fresh offer is redeemed',
        );
        expect(stale.acceptCalls, 0);
        expect(fresh.acceptCalls, 1);
        expect(f.storage.installerInbox.holdsOffer, isFalse);
      },
    );

    featureTest(
      'an offer that cannot be erased is never redeemed; Try again proceeds '
      'once it can be',
      (f) async {
        final broker = f.network.add(local);
        final inbox = f.storage.installerInbox;
        const discardError = Key('installer-pairing-discard-error');

        // A malformed offer that cannot be removed is reported, not skipped.
        inbox
          ..drop('{ not json')
          ..failDiscard = true;
        final app = await f.launch();
        await app.waitFor(find.byKey(discardError));
        expect(find.text(en.installerPairingDiscardTitle), findsOneWidget);
        expect(broker.requests, isEmpty);

        inbox.failDiscard = false;
        await app.tap(find.text(en.installerPairingRetry));
        await app.waitFor(find.byKey(connectCta));

        // A good offer whose reusable bytes cannot be erased: readiness is
        // checked, the one-use acceptance is not sent.
        inbox.failDiscard = true;
        final offer = await installerOffer(f, broker, notify: true);
        await app.waitFor(find.byKey(discardError));
        expect(broker.requestsTo('/api/health'), isNotEmpty);
        expect(broker.requestsTo(acceptPath(offer)), isEmpty);
        expect(inbox.holdsOffer, isTrue);

        inbox.failDiscard = false;
        await app.tap(find.text(en.installerPairingRetry));
        await app.pumpUntil(
          () => app.activeServer?.id == local,
          reason: 'the offer is redeemed after Try again',
        );
        expect(offer.acceptCalls, 1);
      },
    );

    featureTest(
      'a keyring that is not ready is retried, then explained with Try again '
      'while the offer is kept',
      (f) async {
        final broker = f.network.add(local);
        final offer = await installerOffer(f, broker);
        final inbox = f.storage.installerInbox;
        final keyring = UnreadyKeyring();
        const storageError = Key('installer-pairing-storage-error');

        final app = await f.launch(
          overrides: [
            installerPairingStoragePreflightProvider.overrideWithValue(
              keyring.preflight,
            ),
          ],
        );
        expect(find.byKey(barrier), findsOneWidget);
        await app.waitFor(find.byKey(storageError));
        expect(find.text(en.installerPairingStorageTitle), findsOneWidget);
        expect(keyring.preflights, 5, reason: 'one try and four retries');
        expect(
          broker.requests,
          isEmpty,
          reason: 'the broker is not asked before the keyring is ready',
        );
        expect(inbox.holdsOffer, isTrue);
        expect(inbox.isClaimed, isFalse, reason: 'the claim was released');

        keyring.ready = true;
        await app.tap(find.text(en.installerPairingRetry));
        await app.pumpUntil(
          () => app.activeServer?.id == local,
          reason: 'the offer is redeemed once the keyring is ready',
        );
        expect(offer.acceptCalls, 1);
      },
    );

    featureTest(
      'an offer that expires while the keyring is still locked is discarded '
      'and the app starts normally',
      (f) async {
        final broker = f.network.add(local);
        await installerOffer(f, broker, expiresIn: const Duration(seconds: 1));
        final keyring = UnreadyKeyring();

        final app = await f.launch(
          overrides: [
            installerPairingStoragePreflightProvider.overrideWithValue(
              keyring.preflight,
            ),
          ],
        );
        await app.waitFor(find.byKey(connectCta));
        expect(
          find.byKey(const Key('installer-pairing-storage-error')),
          findsNothing,
        );
        expect(f.storage.installerInbox.holdsOffer, isFalse);
        expect(broker.requests, isEmpty);
      },
    );

    featureTest(
      'a broker still starting up is retried until ready and the offer is '
      'accepted exactly once',
      (f) async {
        final broker = f.network.add(local)..reachable = false;
        final offer = await installerOffer(f, broker);

        final app = await f.launch();
        await app.pumpUntil(
          () => broker.requestsTo('/api/health').length >= 3,
          reason: 'three readiness checks',
          every: const Duration(milliseconds: 500),
          steps: 40,
        );
        expect(find.byKey(barrier), findsOneWidget);
        expect(
          f.storage.installerInbox.isClaimed,
          isTrue,
          reason: 'the offer stays claimed and unconsumed meanwhile',
        );
        expect(broker.requestsTo(acceptPath(offer)), isEmpty);

        broker.reachable = true;
        await app.pumpUntil(
          () => app.activeServer?.id == local,
          reason: 'the offer is redeemed once the broker answers',
          every: const Duration(milliseconds: 500),
          steps: 80,
        );
        expect(broker.requestsTo(acceptPath(offer)), hasLength(1));
        expect(offer.acceptCalls, 1);
      },
    );

    featureTest(
      'a broker that never answers its readiness check is explained with Try '
      'again, and every timed-out check closes its connection',
      (f) async {
        final broker = f.network.add(local);
        final offer = await installerOffer(f, broker);
        final health = broker.hold('GET', '/api/health');
        const brokerError = Key('installer-pairing-broker-error');

        final app = await f.launch();
        await app.pumpUntil(
          () => health.arrivals == 1,
          reason: 'the first readiness check',
        );
        final openWhileFirstCheckWaits = f.network.openHttpClients;

        await app.pumpUntil(
          () => find.byKey(brokerError).evaluate().isNotEmpty,
          reason: 'six 5 s checks with backoff, then the explanation',
          every: const Duration(seconds: 1),
          steps: 90,
        );
        expect(find.text(en.installerPairingBrokerTitle), findsOneWidget);
        expect(health.arrivals, 6, reason: 'one check and five retries');
        expect(
          f.network.openHttpClients,
          openWhileFirstCheckWaits - 1,
          reason: 'no timed-out readiness client is left open',
        );
        expect(broker.requestsTo(acceptPath(offer)), isEmpty);
        expect(f.storage.installerInbox.holdsOffer, isTrue);

        health.release();
        await app.tap(find.text(en.installerPairingRetry));
        await app.pumpUntil(
          () => app.activeServer?.id == local,
          reason: 'the offer is redeemed after Try again',
        );
        expect(offer.acceptCalls, 1);
      },
    );

    featureTest(
      'an already open client redeems a handoff that lands while it runs',
      (f) async {
        final broker = f.network.add(local);
        final app = await f.launch();
        await app.waitFor(find.byKey(connectCta));

        final offer = await installerOffer(f, broker, notify: true);
        await app.pumpUntil(
          () => app.activeServer?.id == local,
          reason: 'the open client rechecks its inbox and redeems the offer',
        );
        expect(offer.acceptCalls, 1);
      },
    );
  });

  group('saved servers', () {
    const studioUrl = 'http://studio.test:7734';
    const labUrl = 'http://lab.test:7734';

    /// The live roster's project row for sessions [broker] serves.
    Finder projectOf(FakeBroker broker) =>
        find.byKey(ValueKey('project-header-/work/${broker.machine}'));

    /// The same project as the cached roster shows it while reconnecting.
    Finder cachedProjectOf(FakeBroker broker) =>
        find.text('/work/${broker.machine}');

    featureTest(
      'Saved servers lists every server with the one in use marked, links '
      'to connecting when empty, and explains a load failure plainly',
      (f) async {
        var app = await f.launch(initialLocation: brokerProfilesRoute);
        expect(find.text(en.brokerProfileEmptyTitle), findsOneWidget);
        await app.tapKey('broker-profile-empty-open-connection');
        expect(
          find.byKey(const Key('connection-direct-method')),
          findsOneWidget,
        );

        final home = f.network.add(studioUrl);
        final lab = f.network.add(labUrl);
        await f.storage.seedServer(home, displayName: 'Studio');
        await f.storage.seedServer(lab, displayName: 'Lab', active: false);
        app = await f.restart(initialLocation: brokerProfilesRoute);
        for (final (id, name, inUse) in [
          (studioUrl, 'Studio', true),
          (labUrl, 'Lab', false),
        ]) {
          final row = AppDriver.savedServer(id);
          expect(
            find.descendant(of: row, matching: find.text(name)),
            findsOneWidget,
          );
          expect(
            find.descendant(
              of: row,
              matching: find.text(en.brokerProfileActive),
            ),
            inUse ? findsOneWidget : findsNothing,
          );
          expect(
            AppDriver.savedServer(id, 'activate'),
            inUse ? findsNothing : findsOneWidget,
          );
        }

        await f.quit();
        final profiles = FaultyProfileRepository(f.storage.profiles);
        profiles.reads.fail = true;
        app = await f.launch(
          initialLocation: brokerProfilesRoute,
          overrides: [
            brokerProfileRepositoryProvider.overrideWithValue(profiles),
          ],
        );
        await app.waitFor(find.textContaining(en.brokerProfilesLoadFailed));
        expect(app.visibleText, isNot(contains('injected')));
        expect(app.visibleText, isNot(contains('StateError')));
      },
    );

    featureTest(
      'Use and the workspace switcher change servers without a connection '
      'test; the current server only closes the menu; a failed switch says '
      'so',
      (f) async {
        final studio = f.network.add(studioUrl);
        final lab = f.network.add(labUrl);
        await f.storage.seedServer(studio, displayName: 'Studio');
        final labServer = await f.storage.seedServer(
          lab,
          displayName: 'Lab',
          active: false,
        );
        final active = FaultyActiveServerStore(f.storage.activeServer);
        final app = await f.launch(
          initialLocation: brokerProfilesRoute,
          overrides: [
            activeBrokerProfileStoreProvider.overrideWithValue(active),
          ],
        );

        await app.useSavedServer(labUrl);
        expect(app.activeServer?.id, labUrl);
        expect(find.text(en.brokerProfileActivated('Lab')), findsOneWidget);
        expect(await f.storage.activeServer.getActiveProfileId(), labUrl);
        expect(
          lab.requestsTo('/api/health'),
          isEmpty,
          reason: 'picking a saved server is not a connection test',
        );

        await app.waitForAbsent(find.byType(SnackBar));
        await app.go(sessionsRoute);
        Finder option(String id) =>
            find.byKey(Key('workspace-server-option-$id'));
        Future<void> pick(String id) async {
          await app.tapKey('workspace-server-row');
          await app.tap(option(id));
        }

        await pick(studioUrl);
        expect(app.activeServer?.id, studioUrl);
        expect(option(labUrl), findsNothing, reason: 'the menu closed');

        final writes = active.sets.calls;
        await pick(studioUrl);
        expect(app.activeServer?.id, studioUrl);
        expect(option(studioUrl), findsNothing, reason: 'the menu closed');
        expect(active.sets.calls, writes, reason: 'nothing to switch');

        // Lab is deleted elsewhere (another window) while the menu is open.
        await app.tapKey('workspace-server-row');
        await f.storage.profiles.delete(
          id: labUrl,
          incarnationId: labServer.incarnationId,
        );
        await app.tap(option(labUrl));
        expect(find.text(en.brokerProfileActivateFailed), findsOneWidget);
        expect(app.activeServer?.id, studioUrl);
      },
    );

    featureTest(
      'renaming a server keeps its sign-in; pointing it at another address '
      'signs out and forgets the roster it cached (N3)',
      (f) async {
        final studio = f.network.add(studioUrl)
          ..addSession('s-old', 'Old broker task');
        final moved = f.network.add('http://moved.test:7734');
        final saved = await f.storage.seedServer(
          studio,
          displayName: 'Studio',
          ownerToken: 'studio-owner',
        );
        final key = saved.credentialKey!;
        var app = await f.launch();
        await app.waitFor(projectOf(studio));

        // The cached roster is what shows while a slow broker answers.
        final slow = studio.hold('GET', '/api/sessions');
        app = await f.restart();
        await app.waitFor(find.text(en.sessionRosterCachedReconnecting));
        expect(cachedProjectOf(studio), findsOneWidget);
        slow.release();

        await app.go(brokerProfilesRoute);
        await app.editSavedServer(studioUrl, name: 'Studio Mac');
        expect(find.text(en.brokerProfileUpdated), findsOneWidget);
        var server = (await app.savedServers()).single;
        expect(server.displayName, 'Studio Mac');
        expect(server.credentialKey, key);
        expect(await f.storage.token(key), 'studio-owner');

        await app.editSavedServer(studioUrl, address: 'ftp://');
        expect(find.text(en.brokerProfileSaveFailed), findsOneWidget);
        await app.tapKey('broker-profile-edit-cancel');
        expect((await app.savedServers()).single.baseUri, studio.baseUri);

        await app.editSavedServer(studioUrl, address: 'moved.test');
        expect(find.text(en.brokerProfileUpdated), findsOneWidget);
        server = (await app.savedServers()).single;
        expect(server.id, studioUrl, reason: 'the server keeps its identity');
        expect(server.baseUri, moved.baseUri);
        expect(server.credentialKey, isNull);
        expect(await f.storage.token(key), isNull);
        expect(
          await f.storage.database
              .customSelect('SELECT * FROM roster_snapshot_rows')
              .get(),
          isEmpty,
          reason: "the old broker's roster is deleted, not just ignored",
        );

        moved.hold('GET', '/api/sessions');
        final askedOfOldAddress = studio.requests.length;
        app = await f.restart();
        await app.pumpUntil(
          () => moved.requestsTo('/api/sessions').isNotEmpty,
          reason: 'the roster is asked of the new address',
        );
        expect(studio.requests, hasLength(askedOfOldAddress));
        expect(find.text(en.sessionRosterCachedReconnecting), findsNothing);
        expect(
          cachedProjectOf(studio),
          findsNothing,
          reason: "the old broker's sessions never show as the new one's",
        );
      },
    );

    featureTest(
      'an address edit that cannot finish leaves the server and its sign-in '
      'exactly as they were',
      (f) async {
        final studio = f.network.add(studioUrl);
        final saved = await f.storage.seedServer(
          studio,
          displayName: 'Studio',
          ownerToken: 'studio-owner',
        );
        final key = saved.credentialKey!;
        final credentials = FaultyCredentialStore(f.storage.credentials);
        final profiles = FaultyProfileRepository(f.storage.profiles);
        final app = await f.launch(
          initialLocation: brokerProfilesRoute,
          overrides: [
            credentialStoreProvider.overrideWithValue(credentials),
            brokerProfileRepositoryProvider.overrideWithValue(profiles),
          ],
        );

        Future<void> expectUnchanged() async {
          final server = (await app.savedServers()).single;
          expect(server.baseUri, studio.baseUri);
          expect(server.credentialKey, key);
          expect(await f.storage.token(key), 'studio-owner');
        }

        // The old sign-in cannot be removed: the edit stops before saving.
        credentials.deletes.failNext = true;
        await app.editSavedServer(studioUrl, address: 'moved.test');
        expect(find.text(en.brokerProfileSaveFailed), findsOneWidget);
        expect(profiles.saves.calls, 0);
        await expectUnchanged();

        // The save fails after the sign-in was removed: it is put back.
        profiles.saves.failNext = true;
        await app.tapKey('broker-profile-edit-save');
        expect(find.text(en.brokerProfileSaveFailed), findsOneWidget);
        expect(credentials.deletes.calls, 2);
        await expectUnchanged();
        await app.tapKey('broker-profile-edit-cancel');
        expect(app.activeServer?.credentialKey, key);
      },
    );

    featureTest(
      'deleting a server removes everything this device kept for it, and '
      'adding it back starts from nothing',
      (f) async {
        final studio = f.network.add(studioUrl)
          ..addSession('s-old', 'Old broker task');
        final lab = f.network.add(labUrl);
        final saved = await f.storage.seedServer(
          studio,
          displayName: 'Studio',
          ownerToken: 'studio-owner',
        );
        final other = await f.storage.seedServer(
          lab,
          displayName: 'Lab',
          active: false,
        );
        await _seedEarlierUse(f.storage, saved);
        await _seedEarlierUse(f.storage, other);

        final app = await f.launch();
        await app.waitFor(projectOf(studio));
        await app.go(brokerProfilesRoute);
        final studioRows = await _rowsNaming(f.storage, 'studio.test');
        final labRows = await _rowsNaming(f.storage, 'lab.test');
        expect(
          studioRows.length,
          greaterThan(7),
          reason: 'the app and earlier use left durable traces: $studioRows',
        );

        await app.deleteSavedServer(studioUrl);
        expect(find.text(en.brokerProfileDeleted('Studio')), findsOneWidget);
        expect(AppDriver.savedServer(studioUrl), findsNothing);
        expect(app.activeServer, isNull);
        expect(await f.storage.token(saved.credentialKey!), isNull);
        expect(
          await _rowsNaming(f.storage, 'studio.test'),
          isEmpty,
          reason: 'nothing on this device still speaks for the server',
        );
        expect(
          await _rowsNaming(f.storage, 'lab.test'),
          unorderedEquals(labRows),
          reason: "another server's data is untouched",
        );

        // Adding it back is a new trust decision: nothing comes back.
        final rosterAsks = studio.requestsTo('/api/sessions').length;
        studio.hold('GET', '/api/sessions');
        await app.openConnection();
        await app.connectTo(studioUrl);
        await app.pumpUntil(
          () => studio.requestsTo('/api/sessions').length > rosterAsks,
          reason: 'the re-added server is asked for its roster',
        );
        expect(app.activeServer?.id, studioUrl);
        expect(app.activeServer?.incarnationId, isNot(saved.incarnationId));
        expect(app.activeServer?.credentialKey, isNull);
        expect(find.text(en.sessionRosterCachedReconnecting), findsNothing);
        expect(cachedProjectOf(studio), findsNothing);
        expect(projectOf(studio), findsNothing);
      },
    );

    featureTest(
      'a delete that cannot finish keeps the server, its sign-in and its '
      'data, whichever step failed',
      (f) async {
        final studio = f.network.add(studioUrl)
          ..addSession('s-old', 'Old broker task');
        final saved = await f.storage.seedServer(
          studio,
          displayName: 'Studio',
          ownerToken: 'studio-owner',
        );
        final key = saved.credentialKey!;
        final credentials = FaultyCredentialStore(f.storage.credentials);
        final profiles = FaultyProfileRepository(f.storage.profiles);
        final active = FaultyActiveServerStore(f.storage.activeServer);
        final snapshotDeletes = StoreFault();
        final app = await f.launch(
          overrides: [
            credentialStoreProvider.overrideWithValue(credentials),
            brokerProfileRepositoryProvider.overrideWithValue(profiles),
            activeBrokerProfileStoreProvider.overrideWithValue(active),
            rosterSnapshotRepositoryProvider.overrideWith(
              (ref) => FaultyRosterSnapshots(
                DriftRosterSnapshotRepository(
                  ref.watch(appDatabaseProvider),
                  writeFence: ref.watch(sessionCacheWriteFenceProvider),
                ),
                deletes: snapshotDeletes,
              ),
            ),
          ],
        );
        await app.waitFor(projectOf(studio));
        await app.go(brokerProfilesRoute);
        final before = await _rowsNaming(f.storage, 'studio.test');

        Future<void> failedDelete(StoreFault fault, String step) async {
          fault.failNext = true;
          await app.deleteSavedServer(studioUrl);
          expect(
            find.text(en.brokerProfileDeleteFailed),
            findsOneWidget,
            reason: step,
          );
          expect(AppDriver.savedServer(studioUrl), findsOneWidget);
          expect(await f.storage.token(key), 'studio-owner', reason: step);
          expect(
            await _rowsNaming(f.storage, 'studio.test'),
            unorderedEquals(before),
            reason: '$step: every local delete rolled back',
          );
          await app.elapse(const Duration(seconds: 5)); // snack bar leaves
        }

        await failedDelete(active.clears, 'the in-use mark cannot be cleared');
        expect(app.activeServer?.id, studioUrl);

        await failedDelete(
          credentials.deletes,
          'the sign-in cannot be removed',
        );
        expect(
          app.activeServer,
          isNull,
          reason: 'the server stopped speaking before its token was touched',
        );

        await failedDelete(snapshotDeletes, 'its cached data cannot be purged');
        await failedDelete(profiles.deletes, 'its row cannot be removed');

        await app.deleteSavedServer(studioUrl);
        expect(find.text(en.brokerProfileDeleted('Studio')), findsOneWidget);
        expect(await _rowsNaming(f.storage, 'studio.test'), isEmpty);
        expect(await f.storage.token(key), isNull);
      },
    );

    featureTest(
      'a roster answer that arrives after its server was deleted and added '
      'back is neither shown nor cached for the new one',
      (f) async {
        final studio = f.network.add(studioUrl)
          ..addSession('s-old', 'Old broker task');
        await f.storage.seedServer(studio, displayName: 'Studio');
        var asks = 0;
        final firstRoster = studio.holdWhere(
          (r) => r.path == '/api/sessions' && asks++ == 0,
        );
        final app = await f.launch();
        await app.pumpUntil(
          () => firstRoster.pending == 1,
          reason: 'the first roster request is in flight',
        );
        final staleAnswer = studio.rosterAnswer();

        await app.go(brokerProfilesRoute);
        await app.deleteSavedServer(studioUrl);
        studio
          ..sessions.clear()
          ..addSession('s-new', 'New broker task');
        await app.openConnection();
        await app.connectTo(studioUrl);
        await app.pumpUntil(
          () => app.activeServer?.id == studioUrl,
          reason: 'the server is added back',
        );

        firstRoster.release(staleAnswer);
        await app.go(sessionsRoute);
        await app.waitFor(projectOf(studio));
        await app.tap(projectOf(studio));
        expect(find.text('New broker task'), findsOneWidget);
        expect(find.text('Old broker task'), findsNothing);

        studio.hold('GET', '/api/sessions');
        final relaunched = await f.restart();
        await relaunched.waitFor(
          find.text(en.sessionRosterCachedReconnecting),
        );
        final cached = await f.storage.database
            .customSelect('SELECT rows_json FROM roster_snapshot_rows')
            .get();
        expect(cached.single.read<String>('rows_json'), contains('s-new'));
        expect(
          cached.single.read<String>('rows_json'),
          isNot(contains('s-old')),
        );
      },
    );
  });
}

/// Every non-empty [Text] string under [scope].
Set<String> _texts(Finder scope) => {
  for (final element
      in find.descendant(of: scope, matching: find.byType(Text)).evaluate())
    if (((element.widget as Text).data ?? '').trim() case final text
        when text.isNotEmpty)
      text,
};

/// Gate copy is for people: no status codes, exception names or HTTP talk.
void _expectNoJargon(AppDriver app, Finder scope) {
  final rendered = _texts(scope).join('\n');
  for (final jargon in const [
    '401',
    'Exception',
    'HTTP',
    'status code',
    'null',
    'Dio',
  ]) {
    expect(rendered, isNot(contains(jargon)), reason: 'jargon "$jargon"');
  }
}

/// Every credentialed request to [broker] carried exactly the expected
/// scheme, and no secret ever rode in a URL.
///
/// The public health probe and a pairing acceptance (which proves itself with
/// the scanned offer, before any token exists) are anonymous by design.
void _expectAuthenticatedAs(FakeBroker broker, {String? owner, String? peer}) {
  final credentialed = broker.requests.where(
    (r) =>
        r.path != '/api/health' &&
        !r.path.startsWith('/api/transport/pairings/'),
  );
  expect(credentialed, isNotEmpty);
  for (final request in credentialed) {
    expect(request.ownerToken, owner, reason: '$request owner header');
    expect(request.peerToken, peer, reason: '$request peer header');
    expect(request.uri.toString(), isNot(contains(owner ?? peer!)));
  }
}

/// Durable traces of earlier use of [server]: a Drive intent, a queued
/// prompt, a cached transcript, a model choice and an open tab.
Future<void> _seedEarlierUse(
  FeatureStorage storage,
  BrokerProfile server,
) async {
  final database = storage.database;
  final scope = RosterSource.ofProfile(server).storageKey;
  const session = SessionDetailKey(tool: 'codex', sessionId: 'earlier-1');
  await DriftSessionDriveIntentStore(database).rememberAppCreated(
    brokerProfileId: scope,
    tool: session.tool,
    sessionId: session.sessionId,
  );
  await DriftSessionOutboxRepository(database).upsert(
    SessionOutboxMessage.create(
      sessionKey: session,
      brokerProfileId: scope,
      clientMessageId: 'queued-${server.displayName}',
      kind: SessionOutboxMessageKind.prompt,
      payload: const {'text': 'queued earlier'},
    ),
  );
  await DriftSessionTranscriptRepository(database).upsert(
    SessionTranscriptSnapshot(
      brokerProfileId: scope,
      sessionKey: session,
      messages: const [
        AgentMessage(
          type: AgentMessageType.userMessage,
          raw: {'type': 'cached-earlier'},
        ),
      ],
      hasEarlier: false,
      updatedAt: DateTime.utc(2026, 10),
    ),
  );
  await DriftSessionModelPreferenceStore(database).save(
    SessionModelPreferenceKey(
      brokerProfileId: scope,
      tool: session.tool,
      lineageId: 'lineage-1',
    ),
    const SessionCurrentModel(providerID: 'anthropic', modelID: 'opus'),
  );
  await DriftOpenSessionsStore(database).openMember(
    scope,
    const SessionRef.cachedIdentity(
      tool: 'codex',
      id: 'earlier-tab',
      title: 'Earlier tab',
    ),
  );
}

/// Every database row that names [host], in any encoding the stores use
/// (raw, percent-encoded or hex scope keys).
Future<List<String>> _rowsNaming(FeatureStorage storage, String host) async {
  final hex = [
    for (final unit in host.codeUnits) unit.toRadixString(16).padLeft(2, '0'),
  ].join();
  final database = storage.database;
  final tables = await database
      .customSelect(
        "SELECT name FROM sqlite_master WHERE type = 'table' "
        "AND name NOT LIKE 'sqlite_%'",
      )
      .get();
  final found = <String>[];
  for (final table in tables) {
    final name = table.read<String>('name');
    final rows = await database.customSelect('SELECT * FROM "$name"').get();
    for (final row in rows) {
      final names = row.data.values.any(
        (value) =>
            value is String && (value.contains(host) || value.contains(hex)),
      );
      if (names) found.add('$name ${row.data}');
    }
  }
  return found;
}
