import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_context_meter.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_telemetry.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('SessionContextMeter', () {
    testWidgets('renders nothing until a context reading arrives', (
      tester,
    ) async {
      await _pump(tester, SessionTelemetry.empty);

      expect(find.byKey(const Key('session-context-meter-ring')), findsNothing);
      expect(tester.getSize(find.byType(SessionContextMeter)), Size.zero);
    });

    testWidgets('renders nothing when only token counts are known', (
      tester,
    ) async {
      // Tokens without a window size cannot yield a percentage; a meter here
      // would be an invented number.
      await _pump(tester, _telemetry(const {'input': 9000, 'output': 200}));

      expect(find.byKey(const Key('session-context-meter-ring')), findsNothing);
    });

    testWidgets('ring renders once a used/max pair arrives', (tester) async {
      await _pump(tester, _contextTelemetry(used: 90000, max: 200000));

      expect(
        find.byKey(const Key('session-context-meter-ring')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-context-meter-verbose')),
        findsNothing,
      );
    });

    testWidgets('verbose style shows used and max in whole thousands', (
      tester,
    ) async {
      await _pump(
        tester,
        _contextTelemetry(used: 258400, max: 972800),
        style: SessionContextMeterStyle.verbose,
      );

      expect(find.text('258k / 973k'), findsOneWidget);
    });

    testWidgets('ring scales with the ambient text scaler (Ctrl +/-)', (
      tester,
    ) async {
      await _pump(tester, _contextTelemetry(used: 1000, max: 10000));
      final standard = tester
          .getSize(find.byKey(const Key('session-context-meter-ring')))
          .width;

      await _pump(
        tester,
        _contextTelemetry(used: 1000, max: 10000),
        textScale: 1.3,
      );
      final enlarged = tester
          .getSize(find.byKey(const Key('session-context-meter-ring')))
          .width;

      expect(standard, SessionContextMeter.baseDiameter);
      expect(enlarged, greaterThan(standard));
      expect(enlarged, closeTo(SessionContextMeter.baseDiameter * 1.3, 0.01));
    });

    testWidgets('stays no larger than the adjacent body text', (tester) async {
      // The control-row rule: a glyph must not out-weigh the text beside it.
      await _pump(tester, _contextTelemetry(used: 1000, max: 10000));

      expect(
        SessionContextMeter.baseDiameter,
        lessThanOrEqualTo(
          const TextTheme().bodyMedium?.fontSize ?? 14,
        ),
      );
    });

    testWidgets('turns critical at the shared 85% threshold, not before', (
      tester,
    ) async {
      final justUnder = _contextTelemetry(used: 84, max: 100);
      final atThreshold = _contextTelemetry(used: 85, max: 100);

      expect(justUnder.isContextCritical, isFalse);
      expect(atThreshold.isContextCritical, isTrue);

      await _pump(tester, atThreshold);
      expect(
        find.byKey(const Key('session-context-meter-ring')),
        findsOneWidget,
      );
    });
  });

  group('context derivation arithmetic', () {
    test('a used/max pair yields a true ratio, not a 100x inflation', () {
      // The shipped regression this guards: 0-1 vs 0-100 confusion.
      final telemetry = _contextTelemetry(used: 1500, max: 200000);

      expect(telemetry.contextPercent, closeTo(0.75, 0.001));
      expect(telemetry.isContextCritical, isFalse);
    });

    test('codex-shaped reading maps to sub-1% rather than 95%', () {
      // 9230 of 972800 is the real rollout sample behind the adapter change.
      final telemetry = _contextTelemetry(used: 9230, max: 972800);

      expect(telemetry.contextPercent, closeTo(0.949, 0.01));
    });

    test('a full window reads 100% and is critical', () {
      final telemetry = _contextTelemetry(used: 200000, max: 200000);

      expect(telemetry.contextPercent, closeTo(100, 0.001));
      expect(telemetry.isContextCritical, isTrue);
    });

    test('an over-full window clamps to 100 rather than overflowing', () {
      final telemetry = _contextTelemetry(used: 260000, max: 200000);

      expect(telemetry.contextPercent, 100);
    });

    test('the newest reading wins', () {
      final telemetry = SessionTelemetry.fromMessages([
        _contextMessage(used: 10000, max: 200000),
        _contextMessage(used: 150000, max: 200000),
      ]);

      expect(telemetry.contextUsedTokens, 150000);
      expect(telemetry.contextPercent, closeTo(75, 0.001));
    });
  });
}

Future<void> _pump(
  WidgetTester tester,
  SessionTelemetry telemetry, {
  SessionContextMeterStyle style = SessionContextMeterStyle.ring,
  double textScale = 1,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      theme: ThemeData(extensions: [themeSpecById(kDefaultThemeId).light]),
      home: MediaQuery(
        data: MediaQueryData(textScaler: TextScaler.linear(textScale)),
        child: Scaffold(
          body: Center(
            child: SessionContextMeter(telemetry: telemetry, style: style),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

SessionTelemetry _telemetry(Map<String, Object?> tokenCount) =>
    SessionTelemetry.fromMessages([
      AgentMessage.fromJson({'type': 'token-count', ...tokenCount}),
    ]);

SessionTelemetry _contextTelemetry({required int used, required int max}) =>
    SessionTelemetry.fromMessages([_contextMessage(used: used, max: max)]);

AgentMessage _contextMessage({required int used, required int max}) =>
    AgentMessage.fromJson({
      'type': 'metadata-update',
      'key': 'contextUsage',
      'value': {'used': used, 'max': max},
    });
