import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/settings/controller/managed_runtime_controller.dart';
import 'package:cosyncing_client/src/features/settings/view/broker_status_settings_section.dart';
import 'package:cosyncing_client/src/platform/update/desktop_client_update.dart';
import 'package:cosyncing_client/src/platform/update/desktop_client_update_provider.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('BrokerStatusSettingsSection desktop build pointer', () {
    late _FakeManagedRuntimeApi api;
    late List<Uri> launched;

    setUp(() {
      api = _FakeManagedRuntimeApi();
      launched = <Uri>[];
    });

    // The pointer is a native-desktop affordance, so the surface under test is
    // pumped on an explicit target platform rather than the host's default.
    Widget buildSubject({
      TargetPlatform platform = TargetPlatform.linux,
      String clientVersion = '1.3.0',
      bool launcherResult = true,
      Error? launcherError,
      Brightness brightness = Brightness.light,
      Locale locale = const Locale('en'),
    }) {
      final themeSpec = themeSpecById(kDefaultThemeId);
      final tokens = brightness == Brightness.dark
          ? themeSpec.dark
          : themeSpec.light;
      return ProviderScope(
        overrides: [
          managedRuntimeApiProvider.overrideWithValue(api),
          // `flutter test` stamps no version into the build, so the compiled-in
          // value is the sentinel that fails closed. Pump a stamped build.
          desktopClientVersionProvider.overrideWithValue(clientVersion),
          desktopDownloadLauncherProvider.overrideWithValue((url) async {
            launched.add(url);
            if (launcherError != null) throw launcherError;
            return launcherResult;
          }),
        ],
        child: MaterialApp(
          key: ValueKey((brightness, locale)),
          theme: ThemeData(
            brightness: brightness,
            platform: platform,
            extensions: [tokens],
          ),
          locale: locale,
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: const Scaffold(
            body: SingleChildScrollView(child: BrokerStatusSettingsSection()),
          ),
        ),
      );
    }

    final pointer = find.byKey(const Key('settings-desktop-build-update'));
    final download = find.byKey(const Key('settings-desktop-build-download'));

    testWidgets('shows the pointer when the broker release is newer', (
      tester,
    ) async {
      api.brokerVersion = '1.4.0';
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(pointer, findsOneWidget);
      expect(find.text('New desktop build available'), findsOneWidget);
      expect(
        find.textContaining('This server runs 1.4.0.'),
        findsOneWidget,
      );
      expect(download, findsOneWidget);
    });

    testWidgets('stays out of the way when the versions match', (tester) async {
      api.brokerVersion = '1.3.0';
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(pointer, findsNothing);
      // The broker's own update row is unaffected by the pointer's absence.
      expect(find.byKey(const Key('settings-broker-version')), findsOneWidget);
    });

    testWidgets('stays out of the way when the broker version is unknown', (
      tester,
    ) async {
      api.brokerVersion = null;
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(pointer, findsNothing);
    });

    testWidgets('stays out of the way on an unstamped desktop build', (
      tester,
    ) async {
      api.brokerVersion = '1.4.0';
      await tester.pumpWidget(buildSubject(clientVersion: '0.0.0-dev'));
      await tester.pumpAndSettle();

      expect(pointer, findsNothing);
    });

    testWidgets('never renders on a non-desktop platform', (tester) async {
      api.brokerVersion = '1.4.0';
      for (final platform in [TargetPlatform.android, TargetPlatform.iOS]) {
        await tester.pumpWidget(buildSubject(platform: platform));
        await tester.pumpAndSettle();
        expect(pointer, findsNothing, reason: '$platform');
      }
    });

    testWidgets('opens the release download page in the system browser', (
      tester,
    ) async {
      api.brokerVersion = '1.4.0';
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      await tester.tap(download);
      await tester.pumpAndSettle();

      expect(launched, [Uri.parse(desktopClientDownloadUrl)]);
      expect(
        launched.single.toString(),
        'https://github.com/cosyncing/cosyncing/releases',
      );
    });

    testWidgets('shows localized feedback when the launcher returns false', (
      tester,
    ) async {
      api.brokerVersion = '1.4.0';
      for (final testCase in const [
        (
          Brightness.light,
          Locale('en'),
          'Couldn’t open the desktop download page. Check your browser '
              'settings and try again.',
        ),
        (
          Brightness.dark,
          Locale('zh'),
          '无法打开桌面版下载页面。请检查浏览器设置后重试。',
        ),
      ]) {
        await tester.pumpWidget(
          buildSubject(
            launcherResult: false,
            brightness: testCase.$1,
            locale: testCase.$2,
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(download);
        await tester.pump();

        expect(
          find.byKey(const Key('settings-desktop-build-download-failure')),
          findsOneWidget,
        );
        expect(find.text(testCase.$3), findsOneWidget);
      }
    });

    testWidgets('maps launcher exceptions to the same localized feedback', (
      tester,
    ) async {
      api.brokerVersion = '1.4.0';
      await tester.pumpWidget(
        buildSubject(launcherError: StateError('launcher unavailable')),
      );
      await tester.pumpAndSettle();

      await tester.tap(download);
      await tester.pump();

      expect(
        find.byKey(const Key('settings-desktop-build-download-failure')),
        findsOneWidget,
      );
    });
  });

  group('BrokerStatusSettingsSection release status honesty', () {
    late _FakeManagedRuntimeApi api;

    setUp(() {
      api = _FakeManagedRuntimeApi();
    });

    Widget buildSubject({
      Brightness brightness = Brightness.light,
      Locale locale = const Locale('en'),
    }) {
      final themeSpec = themeSpecById(kDefaultThemeId);
      final tokens = brightness == Brightness.dark
          ? themeSpec.dark
          : themeSpec.light;
      return ProviderScope(
        overrides: [
          managedRuntimeApiProvider.overrideWithValue(api),
          desktopClientVersionProvider.overrideWithValue('1.4.0'),
          desktopDownloadLauncherProvider.overrideWithValue((_) async => true),
        ],
        child: MaterialApp(
          key: ValueKey((brightness, locale)),
          theme: ThemeData(brightness: brightness, extensions: [tokens]),
          locale: locale,
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          home: const Scaffold(
            body: SingleChildScrollView(child: BrokerStatusSettingsSection()),
          ),
        ),
      );
    }

    final current = find.byKey(const Key('settings-broker-status-current'));
    final unchecked = find.byKey(const Key('settings-broker-status-unchecked'));
    final packageManaged = find.byKey(
      const Key('settings-broker-status-package-managed'),
    );
    final guidance = find.byKey(
      const Key('settings-broker-package-managed-body'),
    );

    // The regression this group exists for: an npm broker never consults the
    // release channel, so reporting it as `Current` is a claim the app has no
    // evidence for and can never acquire.
    testWidgets(
      'an npm-managed broker reads as package-managed, never as current',
      (tester) async {
        api
          ..updateStatus = 'unknown'
          ..updateDetailCode = 'upgrade-package-manager-owned';

        for (final testCase in const [
          (Brightness.light, Locale('en'), 'Managed by npm'),
          (Brightness.dark, Locale('en'), 'Managed by npm'),
          (Brightness.light, Locale('zh'), '由 npm 管理'),
          (Brightness.dark, Locale('zh'), '由 npm 管理'),
        ]) {
          await tester.pumpWidget(
            buildSubject(brightness: testCase.$1, locale: testCase.$2),
          );
          await tester.pumpAndSettle();

          expect(packageManaged, findsOneWidget);
          expect(current, findsNothing);
          expect(find.text(testCase.$3), findsOneWidget);
          expect(find.text('Current'), findsNothing);
          expect(find.text('已是最新'), findsNothing);
        }
      },
    );

    // An honest state that does not say what to do next is half a fix.
    testWidgets(
      'the package-managed state names the commands that do update it',
      (
        tester,
      ) async {
        api
          ..updateStatus = 'unknown'
          ..updateDetailCode = 'upgrade-package-manager-owned';

        for (final locale in const [Locale('en'), Locale('zh')]) {
          await tester.pumpWidget(buildSubject(locale: locale));
          await tester.pumpAndSettle();

          expect(guidance, findsOneWidget);
          expect(
            find.textContaining('npm update --global cosyncing'),
            findsOneWidget,
          );
          expect(find.textContaining('cosyncing setup'), findsOneWidget);
        }
      },
    );

    // An unreachable channel is not a channel that reported good news.
    testWidgets('an unknown status without a reason reads as unchecked', (
      tester,
    ) async {
      api
        ..updateStatus = 'unknown'
        ..updateDetailCode = 'release-channel-unconfigured';
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(unchecked, findsOneWidget);
      expect(current, findsNothing);
      expect(packageManaged, findsNothing);
      expect(guidance, findsNothing);
      expect(find.text('Not checked'), findsOneWidget);
    });

    // The one state that does support the claim still makes it.
    testWidgets(
      'a completed check that found nothing newer still reads as current',
      (
        tester,
      ) async {
        api
          ..updateStatus = 'current'
          ..updateDetailCode = 'current';
        await tester.pumpWidget(buildSubject());
        await tester.pumpAndSettle();

        expect(current, findsOneWidget);
        expect(unchecked, findsNothing);
        expect(packageManaged, findsNothing);
        expect(find.text('Current'), findsOneWidget);
      },
    );

    testWidgets('an available update still offers the update button', (
      tester,
    ) async {
      api
        ..updateStatus = 'update-available'
        ..updateDetailCode = 'update-available';
      await tester.pumpWidget(buildSubject());
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('settings-update-broker')), findsOneWidget);
      expect(current, findsNothing);
      expect(unchecked, findsNothing);
      expect(packageManaged, findsNothing);
    });
  });

  group('BrokerStatusSettingsSection server-health truth', () {
    late _FakeManagedRuntimeApi api;

    setUp(() {
      api = _FakeManagedRuntimeApi();
    });

    Widget buildSubject(Locale locale) {
      final themeSpec = themeSpecById(kDefaultThemeId);
      return ProviderScope(
        key: ValueKey((locale, api.healthStatus)),
        overrides: [
          managedRuntimeApiProvider.overrideWithValue(api),
          desktopClientVersionProvider.overrideWithValue('1.4.0'),
        ],
        child: MaterialApp(
          locale: locale,
          localizationsDelegates: AppLocalizations.localizationsDelegates,
          supportedLocales: AppLocalizations.supportedLocales,
          theme: ThemeData(extensions: [themeSpec.light]),
          home: const Scaffold(body: BrokerStatusSettingsSection()),
        ),
      );
    }

    testWidgets('names persistence health without presenting severity as it', (
      tester,
    ) async {
      for (final testCase in const [
        (
          'critical',
          Locale('en'),
          'Persistence or storage checks need attention.',
        ),
        ('critical', Locale('zh'), '持久化或存储检查需要处理。'),
        (
          'degraded',
          Locale('en'),
          'Persistence or storage checks are degraded.',
        ),
        ('degraded', Locale('zh'), '持久化或存储检查处于降级状态。'),
      ]) {
        api.healthStatus = testCase.$1;
        await tester.pumpWidget(buildSubject(testCase.$2));
        await tester.pumpAndSettle();

        expect(find.text(testCase.$3), findsOneWidget);
        expect(find.textContaining('Status: critical'), findsNothing);
        expect(find.textContaining('状态：critical'), findsNothing);
        expect(find.textContaining('Notifications'), findsNothing);
        expect(find.textContaining('“通知”'), findsNothing);
      }
    });

    testWidgets('unknown health never prints an unrecognized raw status', (
      tester,
    ) async {
      api.healthStatus = 'future-attention-severity';
      await tester.pumpWidget(buildSubject(const Locale('en')));
      await tester.pumpAndSettle();

      expect(
        find.text('Server health checks are unavailable.'),
        findsOneWidget,
      );
      expect(find.textContaining('future-attention-severity'), findsNothing);
    });
  });
}

/// Serves one broker version; every other read is the quiet, healthy answer so
/// only the version drives what the section renders.
final class _FakeManagedRuntimeApi implements ManagedRuntimeApi {
  String? brokerVersion = '1.4.0';
  String healthStatus = 'healthy';
  // The broker's own answer about the release channel. An npm install reports
  // `unknown` with `upgrade-package-manager-owned`, because it declines to
  // probe a manifest that describes native artifacts.
  String updateStatus = 'current';
  String updateDetailCode = 'current';

  @override
  Future<RuntimeUpdatesResponse> getRuntimeUpdates({
    bool fresh = false,
  }) async => const RuntimeUpdatesResponse(ok: true);

  @override
  Future<CodexUpdatePolicyResponse> getPolicy() async =>
      const CodexUpdatePolicyResponse(ok: true, codexUpdatePolicy: 'never');

  @override
  Future<CodexUpdatePolicyResponse> setPolicy(String value) async =>
      CodexUpdatePolicyResponse(ok: true, codexUpdatePolicy: value);

  @override
  Future<BrokerHealthResponse> getHealth() async =>
      BrokerHealthResponse(status: healthStatus, checkedAt: 1);

  @override
  Future<HealthResponse> getProductHealth() async =>
      HealthResponse(ok: true, version: brokerVersion);

  @override
  Future<BrokerUpdateResponse> getBrokerUpdate({bool refresh = false}) async =>
      BrokerUpdateResponse(
        ok: true,
        update: BrokerUpdateSnapshot(
          status: updateStatus,
          currentVersion: brokerVersion ?? 'unknown',
          checkedAt: '2026-08-05T00:00:00Z',
          detailCode: updateDetailCode,
        ),
      );

  @override
  Future<BrokerUpdateTriggerResponse> triggerBrokerUpdate() async =>
      BrokerUpdateTriggerResponse(
        ok: true,
        accepted: false,
        message: 'Already current',
        update: BrokerUpdateSnapshot(
          status: 'current',
          currentVersion: brokerVersion ?? 'unknown',
          checkedAt: '2026-08-05T00:00:00Z',
          detailCode: 'current',
        ),
      );

  @override
  Future<TokdashQuotaPreferenceResponse> getQuotaPreference() async =>
      const TokdashQuotaPreferenceResponse(ok: true, enabled: false);

  @override
  Future<TokdashQuotaPreferenceResponse> setQuotaPreference({
    required bool enabled,
  }) async => TokdashQuotaPreferenceResponse(ok: true, enabled: enabled);

  @override
  Future<TokdashQuotaResponse> getQuota() async =>
      const TokdashQuotaResponse(ok: true);

  @override
  Future<RuntimeUpdateRestartResponse> restartRuntime(String agent) async =>
      const RuntimeUpdateRestartResponse(ok: true);

  @override
  Future<BrokerRestartAllResponse> restartAll() async =>
      const BrokerRestartAllResponse(ok: true, message: 'scheduled');
}
