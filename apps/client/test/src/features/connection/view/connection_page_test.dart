import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/data/active_broker_profile_store.dart';
import 'package:cosyncing_client/src/features/connection/model/fake_broker_health_probe.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/connection/view/connection_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late FakeBrokerHealthProbe fakeProbe;
  late _InMemoryBrokerProfileRepository brokerProfileRepository;
  late _InMemoryActiveBrokerProfileStore activeBrokerProfileStore;

  setUp(() {
    fakeProbe = FakeBrokerHealthProbe(delay: Duration.zero);
    brokerProfileRepository = _InMemoryBrokerProfileRepository();
    activeBrokerProfileStore = _InMemoryActiveBrokerProfileStore();
  });

  Widget buildSubject() {
    return ProviderScope(
      overrides: [
        brokerHealthProbeProvider.overrideWithValue(fakeProbe),
        brokerProfileRepositoryProvider.overrideWithValue(
          brokerProfileRepository,
        ),
        activeBrokerProfileStoreProvider.overrideWithValue(
          activeBrokerProfileStore,
        ),
      ],
      child: MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: ThemeData(
          splashFactory: InkRipple.splashFactory,
          extensions: [themeSpecById(kDefaultThemeId).light],
        ),
        home: const ConnectionPage(),
      ),
    );
  }

  group('ConnectionPage', () {
    testWidgets('renders form fields and connect button', (tester) async {
      await tester.pumpWidget(buildSubject());

      expect(find.text('Connection'), findsOneWidget);
      expect(find.byType(TextFormField), findsOneWidget);
      expect(find.text('Connect'), findsOneWidget);
      expect(find.text('Not connected'), findsOneWidget);
      expect(find.text('cosyncing manages agent runtimes'), findsOneWidget);
      expect(
        find.textContaining('apply Codex and OpenCode updates'),
        findsOneWidget,
      );
    });

    testWidgets('shows validation error on empty input', (tester) async {
      await tester.pumpWidget(buildSubject());

      await tester.tap(find.text('Connect'));
      await tester.pump();

      expect(find.text('Enter a broker URL.'), findsOneWidget);
    });

    testWidgets('probe is called after valid input', (tester) async {
      fakeProbe.shouldSucceed = true;

      await tester.pumpWidget(buildSubject());

      await tester.enterText(
        find.byType(TextFormField),
        'http://127.0.0.1:7734',
      );
      await tester.tap(find.text('Connect'));
      await tester.pumpAndSettle();

      // The probe was called and we're now in success state.
      expect(fakeProbe.probeCount, 1);
      expect(find.text('Connected'), findsOneWidget);
      expect(find.text('Connected to dev-machine.'), findsOneWidget);
    });

    testWidgets('shows success state after successful probe', (tester) async {
      fakeProbe.shouldSucceed = true;

      await tester.pumpWidget(buildSubject());

      await tester.enterText(
        find.byType(TextFormField),
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
        find.byType(TextFormField),
        'http://127.0.0.1:7734',
      );
      await tester.tap(find.text('Connect'));
      await tester.pumpAndSettle();

      expect(find.text("Couldn't connect"), findsOneWidget);
      expect(
        find.text(
          "Couldn't reach the broker. Check that it's running and that "
          'the address and network are right, then try again.',
        ),
        findsOneWidget,
      );
    });

    testWidgets('reset button clears state', (tester) async {
      fakeProbe.shouldSucceed = true;

      await tester.pumpWidget(buildSubject());

      await tester.enterText(
        find.byType(TextFormField),
        'http://127.0.0.1:7734',
      );
      await tester.tap(find.text('Connect'));
      await tester.pumpAndSettle();

      expect(find.text('Connected'), findsOneWidget);

      // Tap reset.
      await tester.tap(find.text('Reset'));
      await tester.pump();

      expect(find.text('Not connected'), findsOneWidget);
    });

    testWidgets(
      'shows failure on URL that passes form but fails normalization',
      (tester) async {
        await tester.pumpWidget(buildSubject());

        // 'http://' passes the form validator (non-empty) but fails
        // normalization because the host is empty.
        await tester.enterText(find.byType(TextFormField), 'http://');
        await tester.tap(find.text('Connect'));
        await tester.pumpAndSettle();

        expect(find.text("Couldn't connect"), findsOneWidget);
      },
    );

    testWidgets('normalizes host:port input', (tester) async {
      fakeProbe.shouldSucceed = true;

      await tester.pumpWidget(buildSubject());

      await tester.enterText(
        find.byType(TextFormField),
        '192.168.1.10:8080',
      );
      await tester.tap(find.text('Connect'));
      await tester.pumpAndSettle();

      expect(find.text('Connected'), findsOneWidget);
    });
  });
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

  @override
  Future<String?> getActiveProfileId() async {
    return _activeProfileId;
  }

  @override
  Future<void> setActiveProfileId(String? profileId) async {
    _activeProfileId = profileId;
  }

  @override
  Future<void> clearActiveProfileId() async {
    _activeProfileId = null;
  }
}
