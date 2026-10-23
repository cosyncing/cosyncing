import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/design/ui_scale.dart';
import 'package:cosyncing_client/src/features/settings/view/quota_status_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    await (FontLoader('Lato')
          ..addFont(rootBundle.load('assets/fonts/Lato-Regular.ttf'))
          ..addFont(rootBundle.load('assets/fonts/Lato-Bold.ttf')))
        .load();
  });

  test('quota identities keep provider names separate from usage sources', () {
    expect(quotaProviderDisplayName('commandcode'), 'Command Code');
    expect(quotaProviderDisplayName('zai'), 'Z.ai');
    expect(quotaProviderDisplayName('opencode_go'), 'OpenCode Go');
  });

  final now = DateTime(2026, 8, 1, 12);

  int epochSeconds(DateTime value) => value.millisecondsSinceEpoch ~/ 1000;

  // Every fixture goes through TokdashQuotaResponse.fromJson with the shape
  // the broker's read-only proxy actually emits (epoch-second timestamps, no
  // client-only fields), so the tests exercise the real broker JSON → Dart
  // model → widget path end to end.
  Map<String, dynamic> bucketJson({
    String id = '5h',
    String label = '5-hour window',
    double? remaining = 42,
    DateTime? resetsAt,
    DateTime? capturedAt,
  }) {
    return {
      'account': 'default',
      'bucket': id,
      'bucket_label': label,
      'used_percent': remaining == null ? null : 100 - remaining,
      'remaining_percent': remaining,
      'resets_at': resetsAt == null ? null : epochSeconds(resetsAt),
      'captured_at': capturedAt == null ? 0 : epochSeconds(capturedAt),
      'source': 'test',
      'status': 'ok',
    };
  }

  Map<String, dynamic> providerJson({
    required String id,
    List<Map<String, dynamic>>? buckets,
    bool networkEnabled = true,
    bool estimated = false,
    String status = 'ok',
    String? statusDetail,
    DateTime? statusAt,
    DateTime? updatedAt,
    Map<String, dynamic>? resetCredits,
  }) {
    return {
      if (resetCredits != null) 'reset_credits': resetCredits,
      'provider': id,
      'network_enabled': networkEnabled,
      'buckets': buckets ?? const [],
      'status': status,
      'status_detail': statusDetail,
      'status_at': statusAt == null ? null : epochSeconds(statusAt),
      'updated_at': updatedAt == null ? null : epochSeconds(updatedAt),
      'sources': const ['test'],
      'estimated': estimated,
    };
  }

  /// A `reset_credits` block in the shape the broker forwards: expiries in
  /// epoch seconds, or as Codex's ISO 8601 strings when [iso] is set.
  Map<String, dynamic> resetCreditsJson({
    required int count,
    required List<DateTime> expiries,
    bool iso = false,
  }) {
    return {
      'available_count': count,
      'credits': [
        for (final (index, expiry) in expiries.indexed)
          {
            'id': 'rc-$index',
            'title': 'Full reset',
            'expires_at': iso
                ? expiry.toUtc().toIso8601String()
                : epochSeconds(expiry),
          },
      ],
    };
  }

  TokdashQuotaResponse quota({
    required Map<String, Map<String, dynamic>> providers,
    bool enabled = true,
  }) {
    return TokdashQuotaResponse.fromJson({
      'ok': true,
      'data': {
        'enabled': enabled,
        'timestamp': epochSeconds(now.subtract(const Duration(minutes: 12))),
        'providers': providers,
      },
    });
  }

  Widget buildSubject({
    TokdashQuotaResponse? response,
    bool loading = false,
    Locale locale = const Locale('en'),
    Brightness brightness = Brightness.light,
    UiDensity density = UiDensity.compact,
    bool reduceMotion = true,
    bool tickersEnabled = true,
  }) {
    final spec = themeSpecById(kDefaultThemeId);
    final tokens = brightness == Brightness.dark ? spec.dark : spec.light;
    return MaterialApp(
      locale: locale,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      theme: buildAppTheme(tokens, brightness, density: density.visualDensity),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(disableAnimations: reduceMotion),
        child: TickerMode(enabled: tickersEnabled, child: child!),
      ),
      home: Scaffold(
        body: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: QuotaStatusPanel(quota: response, loading: loading, now: now),
        ),
      ),
    );
  }

  TokdashQuotaResponse freshQuota() {
    return quota(
      providers: {
        'claude': providerJson(
          id: 'claude',
          buckets: [
            bucketJson(
              id: 'session',
              remaining: 96,
              resetsAt: now.add(const Duration(hours: 3)),
            ),
            bucketJson(
              id: 'weekly_all',
              label: 'Weekly',
              remaining: 21,
              resetsAt: now.add(const Duration(days: 1)),
            ),
            bucketJson(
              id: 'weekly_scoped_fable',
              label: 'Fable Weekly',
              remaining: 100,
              resetsAt: now.add(const Duration(days: 1)),
            ),
          ],
        ),
        'codex': providerJson(
          id: 'codex',
          updatedAt: now.subtract(const Duration(minutes: 12)),
          resetCredits: resetCreditsJson(
            count: 1,
            expiries: [now.add(const Duration(days: 11, hours: 3))],
            iso: true,
          ),
          buckets: [
            bucketJson(
              resetsAt: now.add(const Duration(hours: 3)),
              capturedAt: now.subtract(const Duration(minutes: 12)),
            ),
            bucketJson(
              id: '7d',
              label: 'Weekly',
              remaining: 80,
              resetsAt: now.add(const Duration(days: 4)),
              capturedAt: now.subtract(const Duration(minutes: 12)),
            ),
          ],
        ),
      },
    );
  }

  group('QuotaStatusPanel', () {
    testWidgets('loading state shows a spinner and loading copy', (
      tester,
    ) async {
      await tester.pumpWidget(buildSubject(loading: true));
      // The spinner animates indefinitely, so this state never settles.
      await tester.pump();

      expect(find.byType(CircularProgressIndicator), findsOneWidget);
      expect(find.text('Reading quota data…'), findsOneWidget);
      expect(
        find.ancestor(
          of: find.text('Reading quota data…'),
          matching: find.byType(SelectionArea),
        ),
        findsOneWidget,
      );
    });

    testWidgets('lays out without overflow at narrow phone width', (
      tester,
    ) async {
      tester.view
        ..physicalSize = const Size(360, 640)
        ..devicePixelRatio = 1;
      addTearDown(() {
        tester.view
          ..resetPhysicalSize()
          ..resetDevicePixelRatio();
      });
      final response = quota(
        providers: {
          'claude': providerJson(
            id: 'claude',
            estimated: true,
            buckets: [
              bucketJson(id: 'session', remaining: 0),
              bucketJson(id: 'weekly_all', label: 'Weekly', remaining: 8),
            ],
          ),
          'codex': providerJson(
            id: 'codex',
            buckets: [
              bucketJson(remaining: 100),
              bucketJson(id: '7d', label: 'Weekly', remaining: null),
            ],
          ),
        },
      );
      await tester.pumpWidget(buildSubject(response: response));
      await tester.pumpAndSettle();

      expect(find.text('Claude'), findsOneWidget);
      expect(find.text('Estimated'), findsOneWidget);
      expect(find.text('0%'), findsOneWidget);
      expect(find.text('100%'), findsOneWidget);
      expect(find.text('—'), findsOneWidget);
      expect(tester.takeException(), isNull);

      // Observe the painted reserve under the controlled widget clock. The
      // app-driver journey covers reads; this visual scenario isolates motion
      // and pause behavior from unrelated animations elsewhere in the app.
      Future<List<int>> pixels() async => (await tester.runAsync(() async {
        final image = await captureImage(
          tester.element(
            find.byKey(const Key('settings-quota-row-claude-weekly_all')),
          ),
        );
        try {
          return (await image.toByteData())!.buffer.asUint8List();
        } finally {
          image.dispose();
        }
      }))!;
      await tester.pumpWidget(
        buildSubject(response: response, reduceMotion: false),
      );
      final moving = await pixels();
      await tester.pump(const Duration(seconds: 1));
      expect(await pixels(), isNot(orderedEquals(moving)));
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.inactive);
      final inactive = await pixels();
      await tester.pump(const Duration(seconds: 1));
      expect(await pixels(), orderedEquals(inactive));
      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.resumed);
      await tester.pump(const Duration(seconds: 1));
      expect(await pixels(), isNot(orderedEquals(inactive)));
      await tester.pumpWidget(buildSubject(response: response));
      final reduced = await pixels();
      await tester.pump(const Duration(seconds: 1));
      expect(await pixels(), orderedEquals(reduced));
      await tester.pumpWidget(
        buildSubject(
          response: response,
          reduceMotion: false,
          tickersEnabled: false,
        ),
      );
      final hidden = await pixels();
      await tester.pump(const Duration(seconds: 1));
      expect(await pixels(), orderedEquals(hidden));
      tester.platformDispatcher.textScaleFactorTestValue = 2;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await tester.pumpWidget(buildSubject(response: response));
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      expect(
        tester
            .getTopLeft(find.byKey(const Key('settings-quota-provider-codex')))
            .dy,
        greaterThan(
          tester
              .getTopLeft(
                find.byKey(const Key('settings-quota-provider-claude')),
              )
              .dy,
        ),
      );
    });

    group('golden evidence', () {
      Future<void> pumpGolden(
        WidgetTester tester, {
        required String name,
        required TokdashQuotaResponse? response,
        Size size = const Size(720, 520),
        Locale locale = const Locale('en'),
        Brightness brightness = Brightness.light,
        UiDensity density = UiDensity.compact,
        bool loading = false,
      }) async {
        tester.view
          ..physicalSize = size
          ..devicePixelRatio = 1;
        addTearDown(() {
          tester.view
            ..resetPhysicalSize()
            ..resetDevicePixelRatio();
        });
        await tester.pumpWidget(
          buildSubject(
            response: response,
            loading: loading,
            locale: locale,
            brightness: brightness,
            density: density,
          ),
        );
        await tester.pumpAndSettle();
        // The provider logos are vector assets decoded off the frame clock; the
        // first golden in a process would otherwise be shot before they land.
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 100)),
        );
        await tester.pumpAndSettle();
        await expectLater(
          find.byType(Scaffold),
          matchesGoldenFile('goldens/$name.png'),
        );
      }

      testWidgets('fresh, light, compact density, en', (tester) async {
        await pumpGolden(
          tester,
          name: 'quota_fresh_light_compact_en',
          response: freshQuota(),
        );
      });

      testWidgets('multiple providers, dark, roomy density, en', (
        tester,
      ) async {
        final response = quota(
          providers: {
            'claude': providerJson(
              id: 'claude',
              updatedAt: now.subtract(const Duration(minutes: 12)),
              resetCredits: resetCreditsJson(
                count: 1,
                expiries: [now.add(const Duration(days: 16, hours: 1))],
              ),
              buckets: [
                bucketJson(
                  id: 'session',
                  remaining: 61,
                  resetsAt: now.add(const Duration(hours: 2)),
                  capturedAt: now.subtract(const Duration(minutes: 12)),
                ),
                bucketJson(
                  id: 'weekly_all',
                  label: 'Weekly',
                  remaining: 90,
                  resetsAt: now.add(const Duration(days: 5)),
                  capturedAt: now.subtract(const Duration(minutes: 12)),
                ),
              ],
            ),
            'codex': providerJson(
              id: 'codex',
              updatedAt: now.subtract(const Duration(minutes: 12)),
              // Two credits, the sooner in its use-or-lose window.
              resetCredits: resetCreditsJson(
                count: 2,
                expiries: [
                  now.add(const Duration(hours: 30)),
                  now.add(const Duration(days: 20)),
                ],
                iso: true,
              ),
              buckets: [
                bucketJson(
                  resetsAt: now.add(const Duration(hours: 3)),
                  capturedAt: now.subtract(const Duration(minutes: 12)),
                ),
              ],
            ),
            'zeta': providerJson(
              id: 'zeta',
              updatedAt: now.subtract(const Duration(minutes: 12)),
              buckets: [
                bucketJson(
                  id: 'limit_9',
                  label: 'Turbo credits',
                  remaining: 33,
                  capturedAt: now.subtract(const Duration(minutes: 12)),
                ),
              ],
            ),
          },
        );
        await pumpGolden(
          tester,
          name: 'quota_multi_dark_roomy_en',
          response: response,
          brightness: Brightness.dark,
          density: UiDensity.spacious,
        );
      });

      testWidgets('warning and critical, light, roomy density, zh', (
        tester,
      ) async {
        final response = quota(
          providers: {
            'codex': providerJson(
              id: 'codex',
              updatedAt: now.subtract(const Duration(minutes: 12)),
              resetCredits: resetCreditsJson(
                count: 2,
                expiries: [
                  now.add(const Duration(days: 22, hours: 8)),
                  now.add(const Duration(days: 29)),
                ],
                iso: true,
              ),
              buckets: [
                bucketJson(
                  remaining: 20,
                  resetsAt: now.add(const Duration(hours: 3)),
                  capturedAt: now.subtract(const Duration(minutes: 12)),
                ),
                bucketJson(
                  id: '7d',
                  label: 'Weekly',
                  remaining: 8,
                  resetsAt: now.add(const Duration(days: 4)),
                  capturedAt: now.subtract(const Duration(minutes: 12)),
                ),
              ],
            ),
          },
        );
        await pumpGolden(
          tester,
          name: 'quota_warning_critical_light_roomy_zh',
          response: response,
          locale: const Locale('zh'),
          density: UiDensity.spacious,
        );
      });

      testWidgets('stale and estimated, dark, compact density, zh', (
        tester,
      ) async {
        final response = quota(
          providers: {
            'codex': providerJson(
              id: 'codex',
              estimated: true,
              status: 'fetch_error',
              statusDetail: 'fetch_error',
              statusAt: now.subtract(const Duration(minutes: 2)),
              buckets: [
                bucketJson(
                  remaining: 55,
                  resetsAt: now.add(const Duration(hours: 1)),
                  capturedAt: now.subtract(const Duration(hours: 2)),
                ),
              ],
            ),
          },
        );
        await pumpGolden(
          tester,
          name: 'quota_stale_estimated_dark_compact_zh',
          response: response,
          locale: const Locale('zh'),
          brightness: Brightness.dark,
        );
      });

      testWidgets('unavailable, light, compact density, en', (tester) async {
        await pumpGolden(
          tester,
          name: 'quota_unavailable_light_compact_en',
          response: null,
        );
      });

      testWidgets('fresh rows at narrow phone width', (tester) async {
        await pumpGolden(
          tester,
          name: 'quota_fresh_light_narrow_en',
          response: freshQuota(),
          size: const Size(360, 640),
        );
      });
    });
  });
}
