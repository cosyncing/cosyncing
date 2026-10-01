import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/broker_profiles/controller/broker_profile_manager_controller.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/in_memory_broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/in_memory_credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/workspace_server_switcher.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late InMemoryBrokerProfileRepository profiles;
  late BrokerProfile home;
  late BrokerProfile lab;

  setUp(() async {
    profiles = InMemoryBrokerProfileRepository();
    home = await profiles.save(
      BrokerProfile(
        id: 'http://home.test:7734',
        displayName: 'Home',
        baseUri: Uri.parse('http://home.test:7734'),
        createdAt: DateTime(2026, 7),
      ),
    );
    lab = await profiles.save(
      BrokerProfile(
        id: 'http://lab.test:7734',
        displayName: 'Lab',
        baseUri: Uri.parse('http://lab.test:7734'),
        createdAt: DateTime(2026, 7),
      ),
    );
  });

  Future<ProviderContainer> pumpSwitcher(
    WidgetTester tester, {
    List<Override> overrides = const [],
  }) async {
    final database = AppDatabase(NativeDatabase.memory());
    addTearDown(database.close);
    final container = ProviderContainer(
      overrides: [
        appDatabaseProvider.overrideWithValue(database),
        brokerProfileRepositoryProvider.overrideWithValue(profiles),
        credentialStoreProvider.overrideWithValue(InMemoryCredentialStore()),
        activeBrokerProfileProvider.overrideWith((_) => home),
        ...overrides,
      ],
    );
    addTearDown(container.dispose);
    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          theme: buildAppTheme(
            themeSpecById(kDefaultThemeId).light,
            Brightness.light,
          ),
          home: Scaffold(
            body: Align(
              alignment: Alignment.bottomLeft,
              child: SizedBox(
                width: 280,
                child: WorkspaceServerSwitcher(
                  activeSubtitle: null,
                  onAddServer: () {},
                  onManageServers: () {},
                  builder: (context, toggle) => TextButton(
                    key: const Key('switcher-anchor'),
                    onPressed: toggle,
                    child: const Text('Server'),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return container;
  }

  Future<void> pickServer(WidgetTester tester, BrokerProfile profile) async {
    await tester.tap(find.byKey(const Key('switcher-anchor')));
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(Key('workspace-server-option-${profile.id}')),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('picking another server makes it the active one', (
    tester,
  ) async {
    final container = await pumpSwitcher(tester);

    await pickServer(tester, lab);

    // The menu closes before MenuItemButton runs onPressed, so the switch
    // must not depend on anything that lived inside the menu.
    expect(container.read(activeBrokerProfileProvider)?.id, lab.id);
    expect(
      find.byKey(Key('workspace-server-option-${lab.id}')),
      findsNothing,
      reason: 'the menu closes once a server is picked',
    );
  });

  testWidgets('a failed switch says so instead of failing silently', (
    tester,
  ) async {
    final container = await pumpSwitcher(
      tester,
      overrides: [
        brokerProfileManagerControllerProvider.overrideWith(
          _RefusingController.new,
        ),
      ],
    );

    await pickServer(tester, lab);

    expect(container.read(activeBrokerProfileProvider)?.id, home.id);
    expect(
      find.text(
        AppLocalizations.of(
          tester.element(find.byType(Scaffold)),
        ).brokerProfileActivateFailed,
      ),
      findsOneWidget,
    );
  });

  testWidgets('picking the server in use only closes the menu', (
    tester,
  ) async {
    final container = await pumpSwitcher(tester);

    await pickServer(tester, home);

    expect(container.read(activeBrokerProfileProvider)?.id, home.id);
    expect(
      find.byKey(Key('workspace-server-option-${home.id}')),
      findsNothing,
    );
  });
}

/// Refuses every switch the way a retired or deleted profile does.
class _RefusingController extends BrokerProfileManagerController {
  _RefusingController(super.ref);

  @override
  Future<void> setActiveProfile(
    String profileId, {
    BrokerProfile? expectedProfile,
  }) async {
    throw const BrokerProfileManagerException('refused');
  }
}
