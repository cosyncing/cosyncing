import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/data/active_broker_profile_store.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/pairing/controller/pairing_controller.dart';
import 'package:cosyncing_client/src/features/pairing/view/pairing_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late _SpyCredentialStore credentialStore;
  late _InMemoryBrokerProfileRepository repository;
  late _InMemoryActiveBrokerProfileStore activeStore;

  setUp(() {
    credentialStore = _SpyCredentialStore();
    repository = _InMemoryBrokerProfileRepository();
    activeStore = _InMemoryActiveBrokerProfileStore();
  });

  Widget buildSubject({PairingControllerState? pairingState}) {
    return ProviderScope(
      overrides: [
        credentialStoreProvider.overrideWithValue(credentialStore),
        brokerProfileRepositoryProvider.overrideWithValue(repository),
        activeBrokerProfileStoreProvider.overrideWithValue(activeStore),
        if (pairingState != null)
          pairingControllerProvider.overrideWith(
            () => _FixedPairingController(pairingState),
          ),
      ],
      child: MaterialApp(
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: ThemeData(
          splashFactory: InkRipple.splashFactory,
          extensions: [themeSpecById(kDefaultThemeId).light],
        ),
        home: const PairingPage(),
      ),
    );
  }

  testWidgets('shows validation error for empty payload', (tester) async {
    await tester.pumpWidget(buildSubject());

    await tester.tap(find.byKey(const Key('pairing-import-button')));
    await tester.pumpAndSettle();

    expect(
      find.text('Paste a pairing code or scan a QR code first.'),
      findsOneWidget,
    );
  });

  testWidgets('imports pairing payload and shows success message', (
    tester,
  ) async {
    await tester.pumpWidget(buildSubject());

    await tester.enterText(
      find.byKey(const Key('pairing-payload-field')),
      '{ "brokerUrl": "https://broker.example.com:9443", "displayName": "Desk" }',
    );
    await tester.tap(find.byKey(const Key('pairing-import-button')));
    await tester.pumpAndSettle();

    expect(
      find.text('Pairing complete. This broker is now active.'),
      findsOneWidget,
    );
    expect(
      await repository.getById('https://broker.example.com:9443'),
      isNotNull,
    );
    expect(activeStore.activeProfileId, 'https://broker.example.com:9443');
  });

  testWidgets('shows mobile QR scan action with paste fallback', (
    tester,
  ) async {
    await tester.pumpWidget(buildSubject());

    expect(find.byKey(const Key('pairing-scan-button')), findsOneWidget);
    expect(find.byKey(const Key('pairing-payload-field')), findsOneWidget);
  });

  testWidgets('shows parser error for malformed payload', (tester) async {
    await tester.pumpWidget(buildSubject());

    await tester.enterText(
      find.byKey(const Key('pairing-payload-field')),
      '{ invalid json',
    );
    await tester.tap(find.byKey(const Key('pairing-import-button')));
    await tester.pumpAndSettle();

    expect(find.textContaining("isn't valid"), findsOneWidget);
  });

  testWidgets('renders only the bounded selectable technical detail', (
    tester,
  ) async {
    final oversized = 'pairing-body:${'x' * 5000}:unbounded-tail';
    final state = PairingControllerState(
      notice: PairingNotice.failed,
      technicalDetail: oversized,
    );
    expect(state.technicalDetail!.length, maxTechnicalDetailLength);

    await tester.pumpWidget(buildSubject(pairingState: state));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Technical details'));
    await tester.pumpAndSettle();

    final detail = find.text(state.technicalDetail!);
    expect(detail, findsOneWidget);
    expect(find.textContaining('unbounded-tail'), findsNothing);
    expect(
      find.byWidgetPredicate(
        (widget) =>
            widget is SelectableText && widget.data == state.technicalDetail,
      ),
      findsOneWidget,
    );
  });
}

class _FixedPairingController extends PairingController {
  _FixedPairingController(this.fixedState);

  final PairingControllerState fixedState;

  @override
  PairingControllerState build() => fixedState;
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
  final Map<String, BrokerProfile> _profiles = <String, BrokerProfile>{};

  @override
  Future<List<BrokerProfile>> getAll() async => _profiles.values.toList();

  @override
  Future<BrokerProfile?> getById(String id) async => _profiles[id];

  @override
  Future<BrokerProfile> save(BrokerProfile profile) async {
    _profiles[profile.id] = profile;
    return profile;
  }

  @override
  Future<bool> delete({
    required String id,
    required String? incarnationId,
  }) async => _profiles.remove(id) != null;
}

class _InMemoryActiveBrokerProfileStore implements ActiveBrokerProfileStore {
  String? activeProfileId;

  @override
  Future<String?> getActiveProfileId() async => activeProfileId;

  @override
  Future<void> setActiveProfileId(String? profileId) async {
    activeProfileId = profileId;
  }

  @override
  Future<void> clearActiveProfileId() async {
    activeProfileId = null;
  }
}
