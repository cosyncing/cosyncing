import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/router.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/in_memory_credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/data/active_broker_profile_store.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late _InMemoryBrokerProfileRepository repository;
  late _SpyActiveBrokerProfileStore activeStore;

  setUp(() {
    repository = _InMemoryBrokerProfileRepository();
    activeStore = _SpyActiveBrokerProfileStore();
  });

  ProviderContainer createContainer(
    BrokerProfile? activeProfile, {
    CredentialStore? credentialStore,
  }) {
    final database = AppDatabase(NativeDatabase.memory());
    addTearDown(database.close);
    final container = ProviderContainer(
      overrides: [
        appDatabaseProvider.overrideWithValue(database),
        brokerProfileRepositoryProvider.overrideWithValue(repository),
        activeBrokerProfileStoreProvider.overrideWithValue(activeStore),
        credentialStoreProvider.overrideWithValue(
          credentialStore ?? InMemoryCredentialStore(),
        ),
      ],
    );

    if (activeProfile != null) {
      container.read(activeBrokerProfileProvider.notifier).state =
          activeProfile;
    }

    return container;
  }

  Widget buildSubject({
    required ProviderContainer container,
    String initialLocation = '/settings/broker-profiles',
  }) {
    return UncontrolledProviderScope(
      container: container,
      child: MaterialApp.router(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: ThemeData(
          splashFactory: InkRipple.splashFactory,
          extensions: [themeSpecById(kDefaultThemeId).light],
        ),
        routerConfig: createGoRouter(initialLocation: initialLocation),
      ),
    );
  }

  group('BrokerProfilesPage', () {
    testWidgets('shows an empty state and links to connection', (tester) async {
      final container = createContainer(null);
      await tester.pumpWidget(
        buildSubject(container: container),
      );
      await tester.pumpAndSettle();

      expect(find.text('No broker profiles yet'), findsOneWidget);
      expect(
        find.byKey(const Key('broker-profile-empty-open-connection')),
        findsOneWidget,
      );

      await tester.tap(
        find.byKey(const Key('broker-profile-empty-open-connection')),
      );
      await tester.pumpAndSettle();

      expect(find.text('Broker URL'), findsOneWidget);
      expect(
        find.byKey(const Key('broker-profile-empty-open-connection')),
        findsNothing,
      );
      container.dispose();
    });

    testWidgets('does not expose profile repository diagnostics', (
      tester,
    ) async {
      repository.getAllError = StateError('private profile diagnostic');
      final container = createContainer(null);

      await tester.pumpWidget(buildSubject(container: container));
      await tester.pumpAndSettle();

      expect(
        find.text(
          "Couldn't load broker profiles. Try again. If it keeps happening, "
          'the technical details can help support.',
        ),
        findsOneWidget,
      );
      expect(find.textContaining('private profile diagnostic'), findsNothing);
      expect(find.textContaining('Bad state'), findsNothing);
      container.dispose();
    });

    testWidgets('renders all profiles and marks the active profile', (
      tester,
    ) async {
      final localProfile = BrokerProfile(
        id: 'http://127.0.0.1:7734',
        displayName: 'Local',
        baseUri: Uri.parse('http://127.0.0.1:7734'),
        createdAt: DateTime(2026, 6),
      );
      final remoteProfile = BrokerProfile(
        id: 'http://broker.example.com:9443',
        displayName: 'Remote',
        baseUri: Uri.parse('http://broker.example.com:9443'),
        createdAt: DateTime(2026, 6, 2),
      );
      await repository.save(localProfile);
      await repository.save(remoteProfile);

      final container = createContainer(remoteProfile);
      await tester.pumpWidget(
        buildSubject(container: container),
      );
      await tester.pumpAndSettle();

      expect(find.text('Local'), findsOneWidget);
      expect(find.text('Remote'), findsOneWidget);
      expect(find.text('http://127.0.0.1:7734'), findsOneWidget);
      expect(find.text('http://broker.example.com:9443'), findsOneWidget);
      expect(find.text('Active'), findsOneWidget);
      expect(
        find.byKey(const Key('broker-profile-activate-http_127_0_0_1_7734')),
        findsOneWidget,
      );
      expect(
        find.byKey(
          const Key('broker-profile-activate-http_broker_example_com_9443'),
        ),
        findsNothing,
      );
      container.dispose();
    });

    testWidgets('switches active profile without probing broker', (
      tester,
    ) async {
      final remoteProfile = BrokerProfile(
        id: 'http://broker.example.com:9443',
        displayName: 'Remote',
        baseUri: Uri.parse('http://broker.example.com:9443'),
        createdAt: DateTime(2026, 6, 2),
      );
      await repository.save(remoteProfile);

      final container = createContainer(null);
      await tester.pumpWidget(
        buildSubject(container: container),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.widgetWithText(FilledButton, 'Use'),
      );
      await tester.pumpAndSettle();

      final activeProfile = container.read(activeBrokerProfileProvider);
      expect(activeProfile, isNotNull);
      expect(activeProfile!.id, remoteProfile.id);
      expect(activeStore.activeProfileId, remoteProfile.id);
      container.dispose();
    });

    testWidgets('validates edited broker URL and saves valid updates', (
      tester,
    ) async {
      final profile = BrokerProfile(
        id: 'http://broker.example.com:9443',
        displayName: 'Remote',
        baseUri: Uri.parse('http://broker.example.com:9443'),
        createdAt: DateTime(2026, 6, 2),
      );
      await repository.save(profile);
      await activeStore.setActiveProfileId(profile.id);

      final container = createContainer(null);
      await tester.pumpWidget(
        buildSubject(container: container),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.descendant(
          of: find.ancestor(
            of: find.text('Remote'),
            matching: find.byType(ListTile),
          ),
          matching: find.byIcon(Icons.edit_outlined),
        ),
      );
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('broker-profile-edit-display-name-field')),
        'Renamed Remote',
      );
      await tester.enterText(
        find.byKey(const Key('broker-profile-edit-base-uri-field')),
        'http://',
      );
      await tester.tap(find.byKey(const Key('broker-profile-edit-save')));
      await tester.pumpAndSettle();

      expect(
        find.textContaining("Couldn't save these changes"),
        findsOneWidget,
      );

      await tester.enterText(
        find.byKey(const Key('broker-profile-edit-base-uri-field')),
        'broker.updated:99999',
      );
      await tester.tap(find.byKey(const Key('broker-profile-edit-save')));
      await tester.pumpAndSettle();

      expect(
        find.textContaining("Couldn't save these changes"),
        findsOneWidget,
      );

      await tester.enterText(
        find.byKey(const Key('broker-profile-edit-base-uri-field')),
        'broker.updated:9443',
      );
      await tester.tap(find.byKey(const Key('broker-profile-edit-save')));
      await tester.pumpAndSettle();

      final updated = await repository.getById(profile.id);
      expect(updated, isNotNull);
      expect(updated!.displayName, 'Renamed Remote');
      expect(updated.baseUri.toString(), 'http://broker.updated:9443');
      expect(updated.id, profile.id);
      expect(updated.createdAt, profile.createdAt);
      expect(container.read(activeBrokerProfileProvider)?.id, profile.id);
      expect(
        container.read(activeBrokerProfileProvider)?.baseUri.toString(),
        'http://broker.updated:9443',
      );
      expect(activeStore.activeProfileId, profile.id);
      container.dispose();
    });

    testWidgets('deletes an active profile and clears active selection', (
      tester,
    ) async {
      final activeProfile = BrokerProfile(
        id: 'http://127.0.0.1:7734',
        displayName: 'Local',
        baseUri: Uri.parse('http://127.0.0.1:7734'),
        createdAt: DateTime(2026, 6),
        credentialKey: 'broker-token:http://127.0.0.1:7734',
      );
      final unusedProfile = BrokerProfile(
        id: 'http://broker.example.com:9443',
        displayName: 'Remote',
        baseUri: Uri.parse('http://broker.example.com:9443'),
        createdAt: DateTime(2026, 6, 2),
      );
      await repository.save(activeProfile);
      await repository.save(unusedProfile);
      await activeStore.setActiveProfileId(activeProfile.id);

      final container = createContainer(activeProfile);
      await tester.pumpWidget(
        buildSubject(container: container),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.descendant(
          of: find.ancestor(
            of: find.text('Local'),
            matching: find.byType(ListTile),
          ),
          matching: find.byIcon(Icons.delete_outline),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.textContaining('removes its saved token'), findsOneWidget);
      await tester.tap(find.byKey(const Key('broker-profile-delete-confirm')));
      await tester.pumpAndSettle();

      expect(container.read(activeBrokerProfileProvider), isNull);
      expect(activeStore.wasCleared, isTrue);
      expect(await repository.getById(activeProfile.id), isNull);
      expect(find.text('Local'), findsNothing);
      expect(find.text('Remote'), findsOneWidget);
      container.dispose();
    });

    testWidgets(
      'deletes persisted active profile when provider is not loaded',
      (
        tester,
      ) async {
        final activeProfile = BrokerProfile(
          id: 'http://127.0.0.1:7734',
          displayName: 'Local',
          baseUri: Uri.parse('http://127.0.0.1:7734'),
          createdAt: DateTime(2026, 6),
        );
        await repository.save(activeProfile);
        await activeStore.setActiveProfileId(activeProfile.id);

        final container = createContainer(null);
        await tester.pumpWidget(
          buildSubject(container: container),
        );
        await tester.pumpAndSettle();

        await tester.tap(
          find.descendant(
            of: find.ancestor(
              of: find.text('Local'),
              matching: find.byType(ListTile),
            ),
            matching: find.byIcon(Icons.delete_outline),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const Key('broker-profile-delete-confirm')),
        );
        await tester.pumpAndSettle();

        expect(container.read(activeBrokerProfileProvider), isNull);
        expect(activeStore.wasCleared, isTrue);
        expect(await repository.getById(activeProfile.id), isNull);
        container.dispose();
      },
    );
  });
}

class _InMemoryBrokerProfileRepository implements BrokerProfileRepository {
  final Map<String, BrokerProfile> _profiles = <String, BrokerProfile>{};
  Error? getAllError;

  @override
  Future<List<BrokerProfile>> getAll() async {
    final error = getAllError;
    if (error != null) throw error;
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

class _SpyActiveBrokerProfileStore implements ActiveBrokerProfileStore {
  String? activeProfileId;
  bool wasCleared = false;

  @override
  Future<String?> getActiveProfileId() async {
    return activeProfileId;
  }

  @override
  Future<void> setActiveProfileId(String? profileId) async {
    activeProfileId = profileId;
    wasCleared = false;
  }

  @override
  Future<void> clearActiveProfileId() async {
    activeProfileId = null;
    wasCleared = true;
  }
}
