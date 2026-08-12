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
import 'package:cosyncing_client/src/platform/update/web_handoff_participants.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late _SpyCredentialStore credentialStore;
  late _InMemoryBrokerProfileRepository repository;
  late _InMemoryActiveBrokerProfileStore activeStore;

  setUp(() {
    WebHandoffParticipants.instance.reset();
    credentialStore = _SpyCredentialStore();
    repository = _InMemoryBrokerProfileRepository();
    activeStore = _InMemoryActiveBrokerProfileStore();
  });

  tearDown(WebHandoffParticipants.instance.reset);

  Widget buildSubject({
    PairingControllerState? pairingState,
    TargetPlatform platform = TargetPlatform.android,
    Locale locale = const Locale('en'),
    PairingScannerBuilder? scannerBuilder,
  }) {
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
        locale: locale,
        localizationsDelegates: AppLocalizations.localizationsDelegates,
        supportedLocales: AppLocalizations.supportedLocales,
        theme: ThemeData(
          platform: platform,
          splashFactory: InkRipple.splashFactory,
          extensions: [themeSpecById(kDefaultThemeId).light],
        ),
        home: PairingPage(
          scannerBuilder: scannerBuilder ?? _fakeScannerBuilder,
        ),
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
      find.text('Pairing complete. This server is now active.'),
      findsOneWidget,
    );
    expect(
      await repository.getById('https://broker.example.com:9443'),
      isNotNull,
    );
    expect(activeStore.activeProfileId, 'https://broker.example.com:9443');
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

  testWidgets('supported mobile opens scanner and imports one detection', (
    tester,
  ) async {
    await tester.pumpWidget(buildSubject());

    expect(find.byKey(const Key('pairing-scan-button')), findsOneWidget);
    expect(find.byKey(const Key('pairing-payload-field')), findsOneWidget);

    await tester.tap(find.byKey(const Key('pairing-scan-button')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('pairing-fake-scanner')), findsOneWidget);
    expect(find.text('Scan QR code'), findsOneWidget);

    await tester.tap(find.byKey(const Key('pairing-fake-detect')));
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('pairing-fake-scanner')), findsNothing);
    expect(
      await repository.getById('https://scan.example.com:9443'),
      isNotNull,
    );
    expect(activeStore.activeProfileId, 'https://scan.example.com:9443');
  });

  testWidgets('iOS scanner route can be cancelled without importing', (
    tester,
  ) async {
    await tester.pumpWidget(buildSubject(platform: TargetPlatform.iOS));

    await tester.tap(find.byKey(const Key('pairing-scan-button')));
    await tester.pumpAndSettle();
    expect(find.byKey(const Key('pairing-fake-scanner')), findsOneWidget);

    await tester.pageBack();
    await tester.pumpAndSettle();

    expect(find.byKey(const Key('pairing-fake-scanner')), findsNothing);
    expect(repository.getAll(), completion(isEmpty));
  });

  testWidgets('busy mobile pairing truthfully disables scanner and import', (
    tester,
  ) async {
    await tester.pumpWidget(
      buildSubject(
        pairingState: PairingControllerState(isBusy: true),
      ),
    );

    final scanner = tester.widget<IconButton>(
      find.byKey(const Key('pairing-scan-button')),
    );
    expect(scanner.onPressed, isNull);
    expect(
      tester
          .widget<FilledButton>(
            find.byKey(const Key('pairing-import-button')),
          )
          .onPressed,
      isNull,
    );
  });

  testWidgets('unsupported platforms omit scanner and retain paste import', (
    tester,
  ) async {
    for (final platform in const [
      TargetPlatform.linux,
      TargetPlatform.macOS,
      TargetPlatform.windows,
      TargetPlatform.fuchsia,
    ]) {
      await tester.pumpWidget(buildSubject(platform: platform));
      expect(
        find.byKey(const Key('pairing-scan-button')),
        findsNothing,
        reason: '$platform',
      );
      expect(find.byKey(const Key('pairing-payload-field')), findsOneWidget);
      expect(find.byKey(const Key('pairing-import-button')), findsOneWidget);
    }
  });

  testWidgets('scanner route title is localized in English and Chinese', (
    tester,
  ) async {
    for (final testCase in const [
      (Locale('en'), 'Scan QR code'),
      (Locale('zh'), '扫描二维码'),
    ]) {
      await tester.pumpWidget(
        buildSubject(locale: testCase.$1),
      );
      await tester.tap(find.byKey(const Key('pairing-scan-button')));
      await tester.pumpAndSettle();
      expect(find.text(testCase.$2), findsOneWidget);
      tester.state<NavigatorState>(find.byType(Navigator).first).pop();
      await tester.pumpAndSettle();
    }
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

  testWidgets('does not expose pairing technical details', (
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

    expect(find.text('Technical details'), findsNothing);
    expect(find.text(state.technicalDetail!), findsNothing);
    expect(find.textContaining('unbounded-tail'), findsNothing);
  });
}

Widget _fakeScannerBuilder(
  BuildContext _,
  ValueChanged<String> onDetected,
) {
  return Center(
    key: const Key('pairing-fake-scanner'),
    child: FilledButton(
      key: const Key('pairing-fake-detect'),
      onPressed: () => onDetected(
        '{"brokerUrl":"https://scan.example.com:9443",'
        '"displayName":"Scanned"}',
      ),
      child: const Text('Detect'),
    ),
  );
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
