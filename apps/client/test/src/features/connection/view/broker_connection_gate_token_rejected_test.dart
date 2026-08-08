import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/in_memory_broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/in_memory_credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/controller/broker_gate_controller.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_gate_state.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/connection/view/broker_connection_gate.dart';
import 'package:cosyncing_client/src/features/settings/controller/broker_credentials_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

/// The gate must tell two 401s apart.
///
/// A token the user just typed being refused is not the same event as a stored
/// credential that used to work being revoked, even though the broker answers
/// 401 to both. Showing "this device is no longer signed in" to someone setting
/// up a brand-new device claims access they never had, and sends them looking
/// for a revocation that never happened instead of at the token they mistyped.
void main() {
  late AppLocalizations en;

  setUpAll(() async {
    en = await AppLocalizations.delegate.load(const Locale('en'));
  });

  BrokerProfile profile() => BrokerProfile(
    id: 'https://broker.example.com:9443',
    displayName: 'broker.example.com',
    baseUri: Uri.parse('https://broker.example.com:9443'),
    createdAt: DateTime(2026),
  );

  Future<ProviderContainer> pumpRejectedGate(
    WidgetTester tester, {
    required bool afterTypingAToken,
  }) async {
    final profiles = InMemoryBrokerProfileRepository();
    final container = ProviderContainer(
      overrides: [
        credentialStoreProvider.overrideWithValue(InMemoryCredentialStore()),
        brokerProfileRepositoryProvider.overrideWithValue(profiles),
        brokerGateControllerProvider.overrideWith(_RejectedGateController.new),
      ],
    );
    addTearDown(container.dispose);

    final savedProfile = await profiles.save(profile());
    container.read(activeBrokerProfileProvider.notifier).state = savedProfile;

    if (afterTypingAToken) {
      // Drive the real controller rather than faking its state: this is
      // exactly what the gate's Save token button does.
      await container
          .read(brokerCredentialsControllerProvider.notifier)
          .saveToken('a-token-the-broker-will-refuse');
    }

    await tester.pumpWidget(
      UncontrolledProviderScope(
        container: container,
        child: MaterialApp(
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          theme: ThemeData(
            extensions: [themeSpecById(kDefaultThemeId).light],
          ),
          home: const Scaffold(
            body: SingleChildScrollView(child: BrokerConnectionGate()),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return container;
  }

  testWidgets(
    'a stored credential that stopped working reads as a lost sign-in',
    (tester) async {
      await pumpRejectedGate(tester, afterTypingAToken: false);

      expect(find.text(en.brokerGateRejectedTitle), findsOneWidget);
      expect(find.text(en.brokerGateTokenRejectedTitle), findsNothing);
    },
  );

  testWidgets(
    'a token the user just entered reads as that token being refused',
    (tester) async {
      await pumpRejectedGate(tester, afterTypingAToken: true);

      expect(find.text(en.brokerGateTokenRejectedTitle), findsOneWidget);
      expect(find.text(en.brokerGateRejectedTitle), findsNothing);
    },
  );

  testWidgets('the just-refused copy blames the token, not lost access', (
    tester,
  ) async {
    await pumpRejectedGate(tester, afterTypingAToken: true);

    final body = en.brokerGateTokenRejectedBody;
    expect(find.text(body), findsOneWidget);
    // It must not imply access that a first-run device never had.
    expect(body, isNot(contains('no longer')));
    expect(body, isNot(contains('revoked')));
  });

  testWidgets('both states still offer pairing and token entry', (
    tester,
  ) async {
    await pumpRejectedGate(tester, afterTypingAToken: true);

    expect(find.byKey(const Key('broker-gate-token-field')), findsOneWidget);
    expect(find.byKey(const Key('broker-gate-pair-device')), findsOneWidget);
  });
}

class _RejectedGateController extends BrokerGateController {
  @override
  Future<BrokerGateState> build() async {
    return const BrokerGateState.unauthorized(
      credentialIssue: BrokerGateCredentialIssue.rejected,
      detail: 'Unauthorized',
    );
  }
}
