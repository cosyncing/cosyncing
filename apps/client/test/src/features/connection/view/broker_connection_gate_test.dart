import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_credential.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/controller/broker_gate_controller.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_auth_probe.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_gate_state.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/connection/view/broker_connection_gate.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  Future<void> pumpGate(
    WidgetTester tester,
    BrokerGateState state, {
    Locale? locale,
  }) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          brokerAuthProbeProvider.overrideWithValue(_StaticAuthProbe(state)),
          // Keep a different current profile mounted so unreachable tests
          // prove the completed probe renders only its bound identity.
          brokerGateControllerProvider.overrideWith(
            () => _StubGateController(state),
          ),
          activeBrokerProfileProvider.overrideWith(
            (ref) => state.status == BrokerGateStatus.unselected
                ? null
                : BrokerProfile(
                    id: 'studio',
                    displayName: 'Studio server',
                    baseUri: Uri.parse('https://studio.example:9443'),
                    createdAt: DateTime(2026),
                  ),
          ),
        ],
        child: MaterialApp(
          locale: locale,
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          theme: buildAppTheme(
            themeSpecById(kDefaultThemeId).light,
            Brightness.light,
          ),
          // Mirrors how the gate is actually mounted: the auth barrier wraps it
          // in a SingleChildScrollView and the settings page in a ListView.
          // The card is a tall first-run surface by design.
          home: const Scaffold(
            body: SingleChildScrollView(child: BrokerConnectionGate()),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  /// The English strings this screen must render, read from the ARB-generated
  /// localizations rather than duplicated as literals — a copy edit should not
  /// require touching assertions.
  late AppLocalizations en;

  setUpAll(() async {
    en = await AppLocalizations.delegate.load(const Locale('en'));
  });

  group('connected', () {
    testWidgets('renders nothing and blocks no UI', (tester) async {
      await pumpGate(
        tester,
        const BrokerGateState.connected(machine: 'agent-one'),
      );

      expect(find.byKey(const Key('broker-gate-connected')), findsOneWidget);
      expect(find.byKey(const Key('broker-gate-unreachable')), findsNothing);
      expect(find.byKey(const Key('broker-gate-token-field')), findsNothing);
    });
  });

  group('unselected', () {
    testWidgets('offers only the connection route', (tester) async {
      await pumpGate(tester, const BrokerGateState.unselected());

      expect(find.byKey(const Key('broker-gate-unselected')), findsOneWidget);
      expect(find.text(en.brokerGateUnselectedTitle), findsNWidgets(2));
      expect(find.text(en.brokerGateUnselectedBody), findsOneWidget);
      expect(
        find.byKey(const Key('broker-gate-connect-server')),
        findsOneWidget,
      );
      expect(find.byKey(const Key('broker-gate-retry')), findsNothing);
      expect(find.byKey(const Key('broker-gate-token-field')), findsNothing);
      expect(find.byKey(const Key('broker-gate-token-help')), findsNothing);
      expect(
        find.byKey(const Key('broker-gate-technical-details')),
        findsNothing,
      );
    });
  });

  group('unreachable', () {
    testWidgets('shows the saved server name, address, and recovery routes', (
      tester,
    ) async {
      await pumpGate(
        tester,
        BrokerGateState.unreachable(
          detail: 'Connection refused',
          brokerUrl: Uri.parse('http://127.0.0.1:7734'),
          profileId: 'laptop',
          profileDisplayName: 'Laptop server',
        ),
      );

      expect(find.byKey(const Key('broker-gate-unreachable')), findsOneWidget);
      expect(
        find.text(en.brokerGateUnreachableTitle('Laptop server')),
        findsOneWidget,
      );
      expect(find.byKey(const Key('broker-gate-retry')), findsOneWidget);
      expect(
        find.byKey(const Key('broker-gate-switch-server')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('broker-gate-add-server')),
        findsOneWidget,
      );
      // The address belongs in the copy: it is what the user has to check.
      expect(
        find.textContaining('http://127.0.0.1:7734'),
        findsOneWidget,
      );
      expect(find.textContaining('https://studio.example:9443'), findsNothing);
      expect(find.textContaining('server is running'), findsOneWidget);
      expect(find.textContaining('correct network'), findsOneWidget);
      expect(find.textContaining('sign-in details'), findsNothing);
    });

    testWidgets('never offers credential entry', (tester) async {
      await pumpGate(
        tester,
        const BrokerGateState.unreachable(detail: 'Connection refused'),
      );

      // The critical requirement: a broker that is merely down must not train
      // the user to re-paste a credential that was never the problem.
      expect(find.byKey(const Key('broker-gate-token-field')), findsNothing);
      expect(find.byKey(const Key('broker-gate-token-help')), findsNothing);
      expect(find.byKey(const Key('broker-gate-save-token')), findsNothing);
      expect(find.byKey(const Key('broker-gate-pair-device')), findsNothing);
    });
  });

  group('unauthorized', () {
    testWidgets('missing credential names the no-credential case', (
      tester,
    ) async {
      await pumpGate(
        tester,
        const BrokerGateState.unauthorized(
          credentialIssue: BrokerGateCredentialIssue.missing,
        ),
      );

      expect(
        find.byKey(const Key('broker-gate-credential-missing')),
        findsOneWidget,
      );
      expect(find.text(en.brokerGateMissingTitle), findsOneWidget);
      expect(find.byKey(const Key('broker-gate-pair-device')), findsOneWidget);
      expect(find.text(en.brokerGatePairDevice), findsOneWidget);
    });

    testWidgets('rejected credential is a distinct, named case', (
      tester,
    ) async {
      await pumpGate(
        tester,
        const BrokerGateState.unauthorized(
          credentialIssue: BrokerGateCredentialIssue.rejected,
        ),
      );

      expect(
        find.byKey(const Key('broker-gate-credential-rejected')),
        findsOneWidget,
      );
      expect(find.text(en.brokerGateRejectedTitle), findsOneWidget);
      expect(
        find.byKey(const Key('broker-gate-credential-missing')),
        findsNothing,
      );
      // The rejected case must still say *why* the stored credential stopped
      // working, otherwise it collapses into the missing-credential case.
      expect(
        find.textContaining('revoked or renewed'),
        findsOneWidget,
      );
      expect(find.text(en.brokerGatePairDeviceAgain), findsOneWidget);
    });

    testWidgets('token entry and pairing are both offered up front', (
      tester,
    ) async {
      await pumpGate(
        tester,
        const BrokerGateState.unauthorized(
          credentialIssue: BrokerGateCredentialIssue.rejected,
        ),
      );

      // Both ways in are visible without discovering a toggle first.
      expect(find.byKey(const Key('broker-gate-token-field')), findsOneWidget);
      expect(find.byKey(const Key('broker-gate-save-token')), findsOneWidget);
      expect(find.byKey(const Key('broker-gate-pair-device')), findsOneWidget);
    });

    testWidgets('says where to find the token and how to pair', (
      tester,
    ) async {
      await pumpGate(
        tester,
        const BrokerGateState.unauthorized(
          credentialIssue: BrokerGateCredentialIssue.missing,
        ),
      );

      // A first-run user cannot guess either of these.
      expect(find.byKey(const Key('broker-gate-token-help')), findsOneWidget);
      expect(
        find.text('cat ~/.cosyncing/secrets/broker-token'),
        findsOneWidget,
      );
      expect(find.text('cosy pair'), findsOneWidget);
      expect(find.text(en.brokerGateTokenHelpGuidance), findsOneWidget);
      expect(find.byType(CopyableCodeLine), findsNWidgets(2));

      // And the body names both routes in, not just one.
      expect(find.textContaining('Paste a server token'), findsOneWidget);
      // Body copy plus the button label.
      expect(find.textContaining('pairing QR code'), findsWidgets);
    });

    testWidgets('credential fields declare autofill hints', (tester) async {
      await pumpGate(
        tester,
        const BrokerGateState.unauthorized(
          credentialIssue: BrokerGateCredentialIssue.missing,
        ),
      );

      expect(
        find.byKey(const Key('broker-gate-autofill-group')),
        findsOneWidget,
      );

      final tokenField = tester.widget<TextField>(
        find.descendant(
          of: find.byKey(const Key('broker-gate-token-field')),
          matching: find.byType(TextField),
        ),
      );
      expect(tokenField.autofillHints, contains(AutofillHints.password));
      expect(tokenField.obscureText, isTrue);

      final identityField = tester.widget<TextField>(
        find.descendant(
          of: find.byKey(const Key('broker-gate-identity-field')),
          matching: find.byType(TextField),
        ),
      );
      expect(identityField.autofillHints, contains(AutofillHints.username));
    });
  });

  group('diagnostics stay out of the primary reading path', () {
    testWidgets('raw broker error is hidden behind Technical details', (
      tester,
    ) async {
      await pumpGate(
        tester,
        const BrokerGateState.unauthorized(
          credentialIssue: BrokerGateCredentialIssue.rejected,
          detail: 'DioException: the response has status code 401',
        ),
      );

      // The headline explains the situation in plain language...
      expect(find.text(en.brokerGateRejectedTitle), findsOneWidget);
      // ...and the raw exception text is not on screen at all until asked for.
      expect(find.textContaining('status code 401'), findsNothing);
      expect(find.textContaining('DioException'), findsNothing);
      expect(find.byKey(const Key('broker-gate-detail')), findsNothing);

      // It remains reachable for support.
      final disclosure = find.byKey(const Key('broker-gate-technical-details'));
      expect(disclosure, findsOneWidget);
      // The disclosure sits below the fold on a first-run card, so scroll it
      // into view before tapping.
      await tester.ensureVisible(disclosure);
      await tester.pumpAndSettle();
      await tester.tap(find.text(en.brokerGateTechnicalDetails));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('broker-gate-detail')), findsOneWidget);
      expect(find.textContaining('status code 401'), findsOneWidget);
      expect(
        find.ancestor(
          of: find.byKey(const Key('broker-gate-detail')),
          matching: find.byType(SelectionArea),
        ),
        findsOneWidget,
      );
    });

    testWidgets('no disclosure renders when there is no diagnostic', (
      tester,
    ) async {
      await pumpGate(
        tester,
        const BrokerGateState.unauthorized(
          credentialIssue: BrokerGateCredentialIssue.missing,
        ),
      );

      expect(
        find.byKey(const Key('broker-gate-technical-details')),
        findsNothing,
      );
    });

    testWidgets('user-visible copy carries no developer jargon', (
      tester,
    ) async {
      for (final state in const [
        BrokerGateState.unauthorized(
          credentialIssue: BrokerGateCredentialIssue.missing,
        ),
        BrokerGateState.unauthorized(
          credentialIssue: BrokerGateCredentialIssue.rejected,
        ),
        BrokerGateState.unreachable(),
      ]) {
        await pumpGate(tester, state);

        final rendered = tester
            .widgetList<Text>(find.byType(Text))
            .map((text) => text.data ?? '')
            .join('\n');

        for (final jargon in const [
          '401',
          'Exception',
          'HTTP',
          'status code',
          'null',
          'Dio',
        ]) {
          expect(
            rendered.contains(jargon),
            isFalse,
            reason: 'gate copy for $state must not contain "$jargon"',
          );
        }
      }
    });
  });

  group('text is selectable', () {
    testWidgets('gate content sits inside a SelectionArea', (tester) async {
      await pumpGate(
        tester,
        BrokerGateState.unreachable(
          detail: 'Connection refused',
          brokerUrl: Uri.parse('http://127.0.0.1:7734'),
          profileId: 'support',
          profileDisplayName: 'Support server',
        ),
      );

      // People need to copy the address and the error to ask for help.
      expect(find.byType(SelectionArea), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(SelectionArea),
          matching: find.text(
            en.brokerGateUnreachableTitle('Support server'),
          ),
        ),
        findsOneWidget,
      );
    });

    testWidgets('selection does not break buttons or the token field', (
      tester,
    ) async {
      await pumpGate(
        tester,
        const BrokerGateState.unauthorized(
          credentialIssue: BrokerGateCredentialIssue.missing,
          detail: 'the response has status code 401',
        ),
      );

      // A disclosure inside the SelectionArea still responds to taps.
      expect(find.byKey(const Key('broker-gate-detail')), findsNothing);
      final disclosure = find.byKey(const Key('broker-gate-technical-details'));
      await tester.ensureVisible(disclosure);
      await tester.pumpAndSettle();
      await tester.tap(disclosure);
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('broker-gate-detail')), findsOneWidget);

      // And the field still accepts input.
      await tester.enterText(
        find.byKey(const Key('broker-gate-token-field')),
        'secret-value',
      );
      await tester.pump();

      final tokenField = tester.widget<TextField>(
        find.descendant(
          of: find.byKey(const Key('broker-gate-token-field')),
          matching: find.byType(TextField),
        ),
      );
      expect(tokenField.controller?.text, 'secret-value');
    });

    testWidgets('token guidance and commands are selectable', (tester) async {
      await pumpGate(
        tester,
        const BrokerGateState.unauthorized(
          credentialIssue: BrokerGateCredentialIssue.missing,
        ),
      );

      expect(
        find.ancestor(
          of: find.text(en.brokerGateTokenHelpGuidance),
          matching: find.byType(SelectionArea),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: find.byType(CopyableCodeLine),
          matching: find.byType(SelectableText),
        ),
        findsNWidgets(2),
      );
    });

    testWidgets('credential errors stay selectable without exposing a token', (
      tester,
    ) async {
      await pumpGate(
        tester,
        const BrokerGateState.unauthorized(
          credentialIssue: BrokerGateCredentialIssue.missing,
        ),
      );
      await tester.enterText(
        find.byKey(const Key('broker-gate-token-field')),
        '   ',
      );
      await tester.tap(find.byKey(const Key('broker-gate-save-token')));
      await tester.pumpAndSettle();

      final error = find.byKey(const Key('broker-gate-token-error'));
      expect(error, findsOneWidget);
      expect(
        find.ancestor(of: error, matching: find.byType(SelectionArea)),
        findsOneWidget,
      );
      expect(find.textContaining('   '), findsNothing);
    });
  });

  group('localization', () {
    testWidgets('renders the unselected state in Chinese', (tester) async {
      final zh = await AppLocalizations.delegate.load(const Locale('zh'));
      await pumpGate(
        tester,
        const BrokerGateState.unselected(),
        locale: const Locale('zh'),
      );

      expect(find.text(zh.brokerGateUnselectedTitle), findsNWidgets(2));
      expect(find.text(zh.brokerGateUnselectedBody), findsOneWidget);
      expect(find.text(zh.brokerGateConnectServer), findsNWidgets(2));
    });

    testWidgets('renders Chinese copy under a zh locale', (tester) async {
      final zh = await AppLocalizations.delegate.load(const Locale('zh'));
      await pumpGate(
        tester,
        const BrokerGateState.unauthorized(
          credentialIssue: BrokerGateCredentialIssue.rejected,
        ),
        locale: const Locale('zh'),
      );

      expect(find.text(zh.brokerGateRejectedTitle), findsOneWidget);
      expect(find.text(zh.brokerGatePairDeviceAgain), findsOneWidget);
      // Guards against an English placeholder slipping into the zh ARB.
      expect(zh.brokerGateRejectedTitle, isNot(en.brokerGateRejectedTitle));
      expect(find.text(en.brokerGateRejectedTitle), findsNothing);
    });

    testWidgets('every gate string is localized, not a Dart literal', (
      tester,
    ) async {
      // Renders the same state in both locales; if any string were hardcoded it
      // would appear identically in both renderings.
      final shared = <String>{};
      for (final locale in const [Locale('en'), Locale('zh')]) {
        await pumpGate(
          tester,
          const BrokerGateState.unauthorized(
            credentialIssue: BrokerGateCredentialIssue.rejected,
          ),
          locale: locale,
        );

        final rendered = tester
            .widgetList<Text>(find.byType(Text))
            .map((text) => (text.data ?? '').trim())
            .where((text) => text.isNotEmpty)
            .toSet();

        expect(rendered, isNotEmpty);
        if (shared.isEmpty) {
          shared.addAll(rendered);
        } else {
          shared.retainAll(rendered);
        }
      }

      // Literal commands render in SelectableText; no ordinary Text copy may
      // survive a locale switch.
      expect(shared, isEmpty);
    });
  });
}

class _StaticAuthProbe implements BrokerAuthProbe {
  const _StaticAuthProbe(this.state);

  final BrokerGateState state;

  @override
  Future<BrokerGateState> probe({
    required Uri baseUrl,
    String? credential,
    BrokerCredentialKind credentialKind = BrokerCredentialKind.sharedToken,
  }) async => state;
}

class _StubGateController extends BrokerGateController {
  _StubGateController(this.result);

  final BrokerGateState result;

  @override
  Future<BrokerGateState> build() async => result;
}
