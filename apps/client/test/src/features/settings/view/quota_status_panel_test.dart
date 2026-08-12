import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/design/ui_scale.dart';
import 'package:cosyncing_client/src/features/settings/view/quota_status_panel.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
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
  }) {
    return {
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

  /// An unconfigured provider shell exactly as Tokdash ships one.
  Map<String, dynamic> emptyShellJson(String id) =>
      providerJson(id: id, networkEnabled: false, status: 'unavailable');

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
  }) {
    final spec = themeSpecById(kDefaultThemeId);
    final tokens = brightness == Brightness.dark ? spec.dark : spec.light;
    return MaterialApp(
      locale: locale,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      theme: buildAppTheme(
        tokens,
        brightness,
        density: density.visualDensity,
      ),
      home: Scaffold(
        body: SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: QuotaStatusPanel(
            quota: response,
            loading: loading,
            now: now,
          ),
        ),
      ),
    );
  }

  TokdashQuotaResponse freshQuota() {
    return quota(
      providers: {
        'codex': providerJson(
          id: 'codex',
          updatedAt: now.subtract(const Duration(minutes: 12)),
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

    testWidgets('unavailable state never leaks raw errors or endpoints', (
      tester,
    ) async {
      const response = TokdashQuotaResponse(
        ok: false,
        baseUrl: 'http://127.0.0.1:55423',
        endpoint: '/api/quota',
        error: 'GET http://127.0.0.1:55423/api/quota failed: ECONNREFUSED',
      );
      await tester.pumpWidget(buildSubject(response: response));
      await tester.pumpAndSettle();

      expect(
        find.text('Quota readings are unavailable right now.'),
        findsOneWidget,
      );
      expect(find.textContaining('ECONNREFUSED'), findsNothing);
      expect(find.textContaining('127.0.0.1'), findsNothing);
      expect(find.textContaining('/api/quota'), findsNothing);
    });

    testWidgets('monitoring-off state is reported without naming internals', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSubject(response: quota(providers: const {}, enabled: false)),
      );
      await tester.pumpAndSettle();

      expect(find.text('Usage monitoring is turned off.'), findsOneWidget);
    });

    testWidgets(
      'fresh readings render window rows with bars, reset, and freshness',
      (tester) async {
        await tester.pumpWidget(buildSubject(response: freshQuota()));
        await tester.pumpAndSettle();

        expect(find.text('Codex'), findsOneWidget);
        expect(find.text('5-hour'), findsOneWidget);
        expect(find.text('Weekly'), findsOneWidget);
        expect(find.text('42%'), findsOneWidget);
        expect(find.text('80%'), findsOneWidget);
        // The fixtures carry epoch-second wire timestamps; correct reset and
        // freshness copy proves the model boundary normalized them to the
        // documented milliseconds.
        expect(find.text('Resets in 3 h'), findsOneWidget);
        expect(find.text('Resets in 4 days'), findsOneWidget);
        expect(find.text('Updated 12 min ago'), findsOneWidget);

        final tokens = themeSpecById(kDefaultThemeId).light;
        final bars = tester.widgetList<LinearProgressIndicator>(
          find.byType(LinearProgressIndicator),
        );
        expect(bars.map((bar) => bar.value), [0.42, 0.8]);
        for (final bar in bars) {
          expect(bar.color, tokens.statusWorking);
        }
        expect(find.text('Estimated'), findsNothing);
        expect(find.text('Stale'), findsNothing);
      },
    );

    testWidgets('warning and critical thresholds color the bars', (
      tester,
    ) async {
      final response = quota(
        providers: {
          'codex': providerJson(
            id: 'codex',
            buckets: [
              bucketJson(remaining: 20),
              bucketJson(id: '7d', label: 'Weekly', remaining: 8),
            ],
          ),
        },
      );
      await tester.pumpWidget(buildSubject(response: response));
      await tester.pumpAndSettle();

      final tokens = themeSpecById(kDefaultThemeId).light;
      final bars = tester
          .widgetList<LinearProgressIndicator>(
            find.byType(LinearProgressIndicator),
          )
          .toList();
      expect(bars[0].color, tokens.statusNeedsInput);
      expect(bars[1].color, tokens.statusError);
    });

    testWidgets('estimated and stale pills mark local and last-known data', (
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
                capturedAt: now.subtract(const Duration(hours: 2)),
              ),
            ],
          ),
        },
      );
      await tester.pumpWidget(buildSubject(response: response));
      await tester.pumpAndSettle();

      expect(find.text('Estimated'), findsOneWidget);
      expect(find.text('Stale'), findsOneWidget);
      // Last-known readings stay visible while the refresh is failing.
      expect(find.text('55%'), findsOneWidget);
      expect(find.text('Updated 2 h ago'), findsOneWidget);
    });

    testWidgets(
      'multiple providers and unknown future bucket types render generically',
      (tester) async {
        final response = quota(
          providers: {
            'claude': providerJson(
              id: 'claude',
              buckets: [
                bucketJson(id: 'session', remaining: 61),
                bucketJson(id: 'weekly_all', label: 'Weekly', remaining: 90),
              ],
            ),
            'codex': providerJson(id: 'codex', buckets: [bucketJson()]),
            'zeta': providerJson(
              id: 'zeta',
              buckets: [
                bucketJson(
                  id: 'limit_9',
                  label: 'Turbo credits',
                  remaining: 33,
                ),
              ],
            ),
          },
        );
        await tester.pumpWidget(buildSubject(response: response));
        await tester.pumpAndSettle();

        expect(find.text('Claude'), findsOneWidget);
        expect(find.text('Codex'), findsOneWidget);
        // Unknown future providers and bucket types fall back without
        // tool-name branching: capitalized id plus server-provided label.
        expect(find.text('Zeta'), findsOneWidget);
        expect(find.text('Turbo credits'), findsOneWidget);
        // Codex `5h` and Claude `session` canonicalize to the same label.
        expect(find.text('5-hour'), findsNWidgets(2));
        expect(find.text('Weekly'), findsOneWidget);
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'Antigravity collapses per-model readings into two shared quota pools',
      (tester) async {
        final response = quota(
          providers: {
            'antigravity': providerJson(
              id: 'antigravity',
              buckets: [
                bucketJson(
                  id: 'gemini-2.5-pro',
                  label: 'Gemini 2.5 Pro',
                  remaining: 73,
                ),
                bucketJson(
                  id: 'gemini-3-pro',
                  label: 'Gemini 3 Pro',
                  remaining: 41,
                  resetsAt: now.add(const Duration(hours: 3)),
                ),
                bucketJson(
                  id: 'claude-sonnet',
                  label: 'Claude Sonnet',
                  remaining: 82,
                ),
                bucketJson(
                  id: 'gpt-oss',
                  label: 'GPT OSS',
                  remaining: 24,
                  resetsAt: now.add(const Duration(hours: 2)),
                ),
                bucketJson(
                  id: 'experimental-model',
                  label: 'Experimental model',
                  remaining: 3,
                ),
                bucketJson(
                  id: 'gemini-no-reading',
                  label: 'Gemini no reading',
                  remaining: null,
                ),
              ],
            ),
          },
        );

        await tester.pumpWidget(buildSubject(response: response));
        await tester.pumpAndSettle();

        expect(find.text('Antigravity'), findsOneWidget);
        expect(find.text('Gemini models'), findsOneWidget);
        expect(find.text('Claude and GPT models'), findsOneWidget);
        expect(find.text('5-hour'), findsNWidgets(2));
        expect(find.text('41%'), findsOneWidget);
        expect(find.text('24%'), findsOneWidget);
        expect(find.text('73%'), findsNothing);
        expect(find.text('82%'), findsNothing);
        expect(find.text('3%'), findsNothing);
        expect(find.text('Gemini 3 Pro'), findsNothing);
        expect(find.text('Experimental model'), findsNothing);

        final bars = tester
            .widgetList<LinearProgressIndicator>(
              find.byType(LinearProgressIndicator),
            )
            .toList();
        expect(bars.map((bar) => bar.value), [0.41, 0.24]);

        final geminiSemantics = tester.getSemantics(
          find.byKey(
            const Key('settings-quota-row-antigravity-pool-gemini'),
          ),
        );
        expect(
          geminiSemantics.label,
          contains('Antigravity Gemini models 5-hour'),
        );

        await tester.pumpWidget(
          buildSubject(response: response, locale: const Locale('zh')),
        );
        await tester.pumpAndSettle();
        expect(find.text('Gemini 模型'), findsOneWidget);
        expect(find.text('Claude 和 GPT 模型'), findsOneWidget);
      },
    );

    testWidgets('a null remaining reading shows a visible no-reading state', (
      tester,
    ) async {
      // The broker proxy cannot carry an `unlimited` flag through its parser,
      // so a null percentage must render a visible status, not silent blank.
      final response = quota(
        providers: {
          'minimax': providerJson(
            id: 'minimax',
            buckets: [
              bucketJson(
                id: 'global_general_7d',
                label: 'Weekly',
                remaining: null,
              ),
            ],
          ),
        },
      );
      await tester.pumpWidget(buildSubject(response: response));
      await tester.pumpAndSettle();

      expect(find.text('MiniMax'), findsOneWidget);
      expect(find.text('Weekly'), findsOneWidget);
      expect(find.text('No recent readings.'), findsOneWidget);
      expect(find.byType(LinearProgressIndicator), findsNothing);
      expect(find.textContaining('%'), findsNothing);
    });

    testWidgets(
      'empty provider shells are skipped unless they carry a failure detail',
      (tester) async {
        final response = quota(
          providers: {
            'antigravity': emptyShellJson('antigravity'),
            'claude': emptyShellJson('claude'),
            'codex': providerJson(id: 'codex', buckets: [bucketJson()]),
            'grok': emptyShellJson('grok'),
            'kimi': emptyShellJson('kimi'),
            'minimax': emptyShellJson('minimax'),
          },
        );
        await tester.pumpWidget(buildSubject(response: response));
        await tester.pumpAndSettle();

        expect(find.text('Codex'), findsOneWidget);
        expect(find.text('Claude'), findsNothing);
        expect(find.text('Kimi'), findsNothing);
        expect(find.text('Stale'), findsNothing);
        expect(find.text('No recent readings.'), findsNothing);
      },
    );

    testWidgets('a failing empty shell shows stale with no readings', (
      tester,
    ) async {
      final response = quota(
        providers: {
          'claude': providerJson(
            id: 'claude',
            status: 'fetch_error',
            statusDetail: 'fetch_error',
            statusAt: now.subtract(const Duration(minutes: 2)),
          ),
        },
      );
      await tester.pumpWidget(buildSubject(response: response));
      await tester.pumpAndSettle();

      expect(find.text('Claude'), findsOneWidget);
      expect(find.text('Stale'), findsOneWidget);
      expect(find.text('No recent readings.'), findsOneWidget);
    });

    testWidgets(
      'a failing empty provider without detail still renders stale',
      (tester) async {
        // A fetch failure can arrive with status_detail: null; only the
        // genuine "unavailable" shell shape may be skipped.
        final response = quota(
          providers: {
            'grok': providerJson(id: 'grok', status: 'fetch_error'),
          },
        );
        await tester.pumpWidget(buildSubject(response: response));
        await tester.pumpAndSettle();

        expect(find.text('Grok'), findsOneWidget);
        expect(find.text('Stale'), findsOneWidget);
        expect(find.text('No recent readings.'), findsOneWidget);
      },
    );

    testWidgets('a failed bucket inside a healthy provider reads as stale', (
      tester,
    ) async {
      final response = quota(
        providers: {
          'codex': providerJson(
            id: 'codex',
            buckets: [
              bucketJson(remaining: 55),
              {
                ...bucketJson(id: '7d', label: 'Weekly', remaining: 80),
                'status': 'fetch_error',
              },
            ],
          ),
        },
      );
      await tester.pumpWidget(buildSubject(response: response));
      await tester.pumpAndSettle();

      // One inline Stale pill on the failed weekly row; the provider header
      // and the healthy 5-hour row stay unmarked.
      expect(find.text('Stale'), findsOneWidget);
      final staleSemantics = tester.getSemantics(
        find.byKey(const Key('settings-quota-row-codex-7d')),
      );
      expect(staleSemantics.label, contains('Stale'));
      final freshSemantics = tester.getSemantics(
        find.byKey(const Key('settings-quota-row-codex-5h')),
      );
      expect(freshSemantics.label, isNot(contains('Stale')));
    });

    testWidgets('unconfigured shells alone render the global unavailable', (
      tester,
    ) async {
      final response = quota(
        providers: {
          'antigravity': emptyShellJson('antigravity'),
          'claude': emptyShellJson('claude'),
          'codex': emptyShellJson('codex'),
          'grok': emptyShellJson('grok'),
          'kimi': emptyShellJson('kimi'),
          'minimax': emptyShellJson('minimax'),
        },
      );
      await tester.pumpWidget(buildSubject(response: response));
      await tester.pumpAndSettle();

      expect(
        find.text('Quota readings are unavailable right now.'),
        findsOneWidget,
      );
      expect(find.text('Stale'), findsNothing);
    });

    testWidgets('rows expose a single accessibility summary', (tester) async {
      await tester.pumpWidget(buildSubject(response: freshQuota()));
      await tester.pumpAndSettle();

      final semantics = tester.getSemantics(
        find.byKey(const Key('settings-quota-row-codex-5h')),
      );
      expect(semantics.label, contains('Codex 5-hour'));
      expect(semantics.label, contains('42% remaining'));
      expect(semantics.label, contains('Resets in 3 h'));
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
              bucketJson(id: 'session', remaining: 20),
              bucketJson(id: 'weekly_all', label: 'Weekly', remaining: 8),
            ],
          ),
          'codex': providerJson(id: 'codex', buckets: [bucketJson()]),
        },
      );
      await tester.pumpWidget(buildSubject(response: response));
      await tester.pumpAndSettle();

      expect(find.text('Claude'), findsOneWidget);
      expect(find.text('Estimated'), findsOneWidget);
      expect(tester.takeException(), isNull);
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
