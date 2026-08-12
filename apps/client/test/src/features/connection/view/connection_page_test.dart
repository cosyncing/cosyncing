import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/data/active_broker_profile_store.dart';
import 'package:cosyncing_client/src/features/connection/model/fake_broker_health_probe.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/connection/view/connection_page.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_participants.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late FakeBrokerHealthProbe fakeProbe;
  late _InMemoryBrokerProfileRepository brokerProfileRepository;
  late _InMemoryActiveBrokerProfileStore activeBrokerProfileStore;
  late _SpyCredentialStore credentialStore;

  setUp(() {
    WebHandoffParticipants.instance.reset();
    fakeProbe = FakeBrokerHealthProbe(delay: Duration.zero);
    brokerProfileRepository = _InMemoryBrokerProfileRepository();
    activeBrokerProfileStore = _InMemoryActiveBrokerProfileStore();
    credentialStore = _SpyCredentialStore();
  });

  tearDown(WebHandoffParticipants.instance.reset);

  Widget buildSubject({
    Locale locale = const Locale('en'),
    Brightness brightness = Brightness.light,
    double textScaleFactor = 1,
  }) {
    final themeSpec = themeSpecById(kDefaultThemeId);
    return ProviderScope(
      overrides: [
        brokerHealthProbeProvider.overrideWithValue(fakeProbe),
        credentialStoreProvider.overrideWithValue(credentialStore),
        brokerProfileRepositoryProvider.overrideWithValue(
          brokerProfileRepository,
        ),
        activeBrokerProfileStoreProvider.overrideWithValue(
          activeBrokerProfileStore,
        ),
      ],
      child: MaterialApp(
        locale: locale,
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: ThemeData(
          brightness: brightness,
          splashFactory: InkRipple.splashFactory,
          extensions: [
            if (brightness == Brightness.dark)
              themeSpec.dark
            else
              themeSpec.light,
          ],
        ),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(
            context,
          ).copyWith(textScaler: TextScaler.linear(textScaleFactor)),
          child: child!,
        ),
        home: const ConnectionPage(),
      ),
    );
  }

  const serverAddressField = Key('connection-server-address-field');

  group('ConnectionPage', () {
    testWidgets('renders form fields and connect button', (tester) async {
      await tester.pumpWidget(buildSubject());

      expect(find.text('Connection'), findsOneWidget);
      expect(find.byType(TextFormField), findsNWidgets(2));
      expect(find.byKey(serverAddressField), findsOneWidget);
      expect(find.byKey(const Key('pairing-payload-field')), findsOneWidget);
      expect(find.text('Connect directly'), findsOneWidget);
      expect(find.text('Pair this device'), findsOneWidget);
      expect(find.text('Connect'), findsOneWidget);
      expect(find.text('Saved servers'), findsOneWidget);
      expect(
        find.byKey(const Key('connection-saved-servers')),
        findsOneWidget,
      );
      expect(find.text('Not connected'), findsOneWidget);
      expect(find.text('cosyncing manages agent runtimes'), findsOneWidget);
      expect(
        find.textContaining('apply Codex and OpenCode updates'),
        findsOneWidget,
      );
    });

    testWidgets('uses the displayed local server when input is empty', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject());

      await tester.tap(find.text('Connect'));
      await tester.pumpAndSettle();

      expect(find.text('Enter a server address.'), findsNothing);
      expect(
        tester
            .widget<TextFormField>(find.byKey(serverAddressField))
            .controller!
            .text,
        'http://127.0.0.1:7734',
      );
      expect(fakeProbe.probeCount, 1);
      expect(find.text('Connected'), findsOneWidget);
      expect(
        await brokerProfileRepository.getById('http://127.0.0.1:7734'),
        isNotNull,
      );
    });

    testWidgets('probe is called after valid input', (tester) async {
      fakeProbe.shouldSucceed = true;

      await tester.pumpWidget(buildSubject());

      await tester.enterText(
        find.byKey(serverAddressField),
        'http://127.0.0.1:7734',
      );
      await tester.tap(find.text('Connect'));
      await tester.pumpAndSettle();

      // The probe was called and we're now in success state.
      expect(fakeProbe.probeCount, 1);
      expect(find.text('Connected'), findsOneWidget);
      expect(find.text('Connected to dev-machine.'), findsOneWidget);
    });

    testWidgets('successful direct Connect commits its handoff text', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject());
      await tester.enterText(
        find.byKey(serverAddressField),
        'http://127.0.0.1:7734',
      );

      expect(await WebHandoffParticipants.instance.prepare(), isFalse);
      await tester.tap(find.text('Connect'));
      await tester.pumpAndSettle();

      expect(find.text('Connected'), findsOneWidget);
      expect(await WebHandoffParticipants.instance.prepare(), isTrue);
    });

    testWidgets('successful Pair clears its one-use handoff payload', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject());
      const payload =
          '{ "brokerUrl": "https://pair.example.com", '
          '"displayName": "Paired" }';
      await tester.enterText(
        find.byKey(const Key('pairing-payload-field')),
        payload,
      );

      expect(await WebHandoffParticipants.instance.prepare(), isFalse);
      await tester.ensureVisible(
        find.byKey(const Key('pairing-import-button')),
      );
      await tester.tap(find.byKey(const Key('pairing-import-button')));
      await tester.pumpAndSettle();

      expect(
        tester
            .widget<TextFormField>(
              find.byKey(const Key('pairing-payload-field')),
            )
            .controller!
            .text,
        isEmpty,
      );
      expect(await WebHandoffParticipants.instance.prepare(), isTrue);
    });

    testWidgets('shows success state after successful probe', (tester) async {
      fakeProbe.shouldSucceed = true;

      await tester.pumpWidget(buildSubject());

      await tester.enterText(
        find.byKey(serverAddressField),
        'http://127.0.0.1:7734',
      );
      await tester.tap(find.text('Connect'));
      await tester.pumpAndSettle();

      expect(find.text('Connected'), findsOneWidget);
      expect(find.text('Connected to dev-machine.'), findsOneWidget);
    });

    testWidgets('shows failure state after failed probe', (tester) async {
      fakeProbe.shouldSucceed = false;

      await tester.pumpWidget(buildSubject());

      await tester.enterText(
        find.byKey(serverAddressField),
        'http://127.0.0.1:7734',
      );
      await tester.tap(find.text('Connect'));
      await tester.pumpAndSettle();

      expect(find.text("Couldn't connect"), findsOneWidget);
      expect(
        find.text(
          "Couldn't reach the server. Check that it's running and that "
          'the address and network are right, then try again.',
        ),
        findsOneWidget,
      );
    });

    testWidgets('reset button clears state', (tester) async {
      fakeProbe.shouldSucceed = true;

      await tester.pumpWidget(buildSubject());

      await tester.enterText(
        find.byKey(serverAddressField),
        'http://127.0.0.1:7734',
      );
      await tester.tap(find.text('Connect'));
      await tester.pumpAndSettle();

      expect(find.text('Connected'), findsOneWidget);

      // Tap reset.
      await tester.ensureVisible(find.widgetWithText(TextButton, 'Reset'));
      await tester.tap(find.widgetWithText(TextButton, 'Reset'));
      await tester.pump();

      expect(find.text('Not connected'), findsOneWidget);
    });

    testWidgets(
      'shows failure on URL that passes form but fails normalization',
      (tester) async {
        await tester.pumpWidget(buildSubject());

        // 'http://' passes the form validator (non-empty) but fails
        // normalization because the host is empty.
        await tester.enterText(find.byKey(serverAddressField), 'http://');
        await tester.tap(find.text('Connect'));
        await tester.pumpAndSettle();

        expect(find.text("Couldn't connect"), findsOneWidget);
      },
    );

    testWidgets('normalizes host:port input', (tester) async {
      fakeProbe.shouldSucceed = true;

      await tester.pumpWidget(buildSubject());

      await tester.enterText(
        find.byKey(serverAddressField),
        '192.168.1.10:8080',
      );
      await tester.tap(find.text('Connect'));
      await tester.pumpAndSettle();

      expect(find.text('Connected'), findsOneWidget);
    });

    testWidgets('keeps a portless Tailnet HTTPS address exact', (
      tester,
    ) async {
      const serverUrl = 'https://fixture.tailnet.ts.net';
      await tester.pumpWidget(buildSubject());

      await tester.enterText(find.byKey(serverAddressField), serverUrl);
      await tester.tap(find.text('Connect'));
      await tester.pumpAndSettle();

      expect(find.text('Connected'), findsOneWidget);
      expect(
        (await brokerProfileRepository.getById(serverUrl))?.baseUri.toString(),
        serverUrl,
      );
      expect(activeBrokerProfileStore.activeProfileId, serverUrl);
    });

    testWidgets('submits direct connection from the keyboard', (tester) async {
      await tester.pumpWidget(buildSubject());

      await tester.enterText(find.byKey(serverAddressField), 'desk.test:7734');
      await tester.testTextInput.receiveAction(TextInputAction.done);
      await tester.pumpAndSettle();

      expect(fakeProbe.probeCount, 1);
      expect(find.text('Connected'), findsOneWidget);
    });

    testWidgets('pairing on the connection screen saves the exact server', (
      tester,
    ) async {
      const pairedUrl = 'https://fixture.tailnet.ts.net:9443';
      await tester.pumpWidget(buildSubject());

      await tester.enterText(
        find.byKey(const Key('pairing-payload-field')),
        '{"brokerUrl":"$pairedUrl","displayName":"Desk"}',
      );
      await tester.ensureVisible(
        find.byKey(const Key('pairing-import-button')),
      );
      await tester.tap(find.byKey(const Key('pairing-import-button')));
      await tester.pumpAndSettle();

      expect(
        find.text('Pairing complete. This server is now active.'),
        findsOneWidget,
      );
      expect(
        (await brokerProfileRepository.getById(pairedUrl))?.baseUri.toString(),
        pairedUrl,
      );
      expect(activeBrokerProfileStore.events, ['set:$pairedUrl']);
      expect(activeBrokerProfileStore.activeProfileId, pairedUrl);
    });

    for (final brightness in Brightness.values) {
      for (final locale in const [Locale('en'), Locale('zh')]) {
        testWidgets(
          'renders both methods in ${brightness.name} ${locale.languageCode}',
          (tester) async {
            await tester.binding.setSurfaceSize(const Size(1100, 900));
            addTearDown(() => tester.binding.setSurfaceSize(null));
            await tester.pumpWidget(
              buildSubject(locale: locale, brightness: brightness),
            );
            await tester.pumpAndSettle();

            final direct = find.byKey(const Key('connection-direct-method'));
            final pair = find.byKey(const Key('connection-pair-method'));
            expect(direct, findsOneWidget);
            expect(pair, findsOneWidget);
            expect(tester.getTopLeft(direct).dy, tester.getTopLeft(pair).dy);
            expect(
              find.text(
                locale.languageCode == 'zh' ? '直接连接' : 'Connect directly',
              ),
              findsOneWidget,
            );
            expect(
              find.text(
                locale.languageCode == 'zh' ? '配对此设备' : 'Pair this device',
              ),
              findsOneWidget,
            );
          },
        );
      }
    }

    testWidgets('compact high-text-scale layout keeps both methods usable', (
      tester,
    ) async {
      await tester.binding.setSurfaceSize(const Size(320, 850));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        buildSubject(locale: const Locale('zh'), textScaleFactor: 2),
      );
      await tester.pumpAndSettle();

      expect(tester.takeException(), isNull);
      final direct = find.byKey(const Key('connection-direct-method'));
      final pair = find.byKey(const Key('connection-pair-method'));
      expect(
        tester.getTopLeft(pair).dy,
        greaterThan(tester.getTopLeft(direct).dy),
      );
      await tester.ensureVisible(
        find.byKey(const Key('pairing-import-button')),
      );
      expect(find.byKey(const Key('pairing-import-button')), findsOneWidget);
    });

    testWidgets('mobile connection screen retains QR scan and paste', (
      tester,
    ) async {
      debugDefaultTargetPlatformOverride = TargetPlatform.iOS;
      await tester.pumpWidget(buildSubject());

      expect(find.byKey(const Key('pairing-scan-button')), findsOneWidget);
      expect(find.byKey(const Key('pairing-payload-field')), findsOneWidget);
      debugDefaultTargetPlatformOverride = null;
    });
  });
}

class _SpyCredentialStore implements CredentialStore {
  @override
  Future<String?> readBrokerToken(String credentialKey) async => null;

  @override
  Future<void> writeBrokerToken(String credentialKey, String token) async {}

  @override
  Future<void> deleteBrokerToken(String credentialKey) async {}
}

class _InMemoryBrokerProfileRepository implements BrokerProfileRepository {
  final Map<String, BrokerProfile> _profiles = {};

  @override
  Future<List<BrokerProfile>> getAll() async {
    return List<BrokerProfile>.from(_profiles.values);
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

class _InMemoryActiveBrokerProfileStore implements ActiveBrokerProfileStore {
  String? _activeProfileId;
  final events = <String>[];

  String? get activeProfileId => _activeProfileId;

  @override
  Future<String?> getActiveProfileId() async {
    return _activeProfileId;
  }

  @override
  Future<void> setActiveProfileId(String? profileId) async {
    events.add('set:$profileId');
    _activeProfileId = profileId;
  }

  @override
  Future<void> clearActiveProfileId() async {
    events.add('clear');
    _activeProfileId = null;
  }
}
