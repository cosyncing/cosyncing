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
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_repository.dart';
import 'package:cosyncing_client/src/features/settings/data/session_display_preferences_store.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/in_memory_session_display_preferences_store.dart';
import '../../../../support/session_detail_page_test_harness.dart';

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
        // Every routed page sits beside the shared sidebar, whose roster would
        // otherwise fetch over the network and persist through drift.
        sessionListRepositoryProvider.overrideWith(
          (_) async => InMemorySessionListRepository(),
        ),
        openSessionsStoreProvider.overrideWithValue(
          InMemoryOpenSessionsStore(),
        ),
        sessionDisplayPreferencesStoreProvider.overrideWithValue(
          InMemorySessionDisplayPreferencesStore(),
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
              matching: _profileRow,
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

/// A saved server's row, found by the key every row carries.
final Finder _profileRow = find.byWidgetPredicate(
  (widget) =>
      widget.key is ValueKey<String> &&
      (widget.key! as ValueKey<String>).value.startsWith(
        'broker-profile-row-',
      ),
);
