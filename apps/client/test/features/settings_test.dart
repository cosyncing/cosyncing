// F09 — Settings and appearance, through the real App.
//
// Journeys, each one launch with several assertions along the way:
//   1. appearance: theme, mode, text size, density and language apply to the
//      running app, survive a relaunch, and a malformed stored value falls back
//      on its own.
//   2. device preferences: debug views, tool display, session visibility and
//      conversation display survive a relaunch; one changed before the store
//      has loaded is kept next to the hydrated ones.
//   3. language: the system language is followed, an unshipped one gets
//      English.
//   4. agents: the runtime policy, the restart table, quota, owner and paired
//      peer, and a broker switch with calls in flight.
//   5. platform toggles: keep running when closed, stay connected on Android.
import 'dart:async';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/design/ui_scale.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/settings/controller/locale_controller.dart';
import 'package:cosyncing_client/src/features/settings/data/conversation_display_store.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/app_driver.dart';
import '../support/feature/cosyncing_app.dart';
import '../support/feature/fake_broker.dart';
import '../support/feature/roster_driver.dart';
import '../support/feature/session_driver.dart';
import '../support/feature/settings_driver.dart';
import '../support/feature/settings_wire.dart';
import '../support/notification_test_support.dart';

final AppLocalizations en = lookupAppLocalizations(const Locale('en'));
final AppLocalizations ja = lookupAppLocalizations(const Locale('ja'));
final AppLocalizations zh = lookupAppLocalizations(const Locale('zh'));

Future<FakeBroker> studioSeeded(FeatureContext f) async {
  final studio = f.network.add('http://studio.test:7734');
  await f.storage.seedServer(studio);
  return studio;
}

void main() {
  featureTest('General opens Storage and cache cleanup requires confirmation', (
    f,
  ) async {
    await studioSeeded(f);
    final app = await f.launch(
      initialLocation: generalSettingsRoute,
      viewport: FeatureViewport.phone,
    );
    await app.tapKey('settings-storage');
    expect(find.text(en.storageDataDescription), findsOneWidget);
    await app.tapKey('storage-clear-cache');
    expect(find.text(en.sessionClearAllCacheConfirmTitle), findsOneWidget);
    await app.dismissModal();
    await app.tapKey('storage-clear-cache');
    await app.tapKey('storage-clear-cache-confirm');
    expect(find.text(en.sessionAllCacheCleared), findsOneWidget);
    expect(find.text(en.storageDataDescription), findsOneWidget);
  });

  group('appearance', () {
    featureTest('a restyled app stays restyled after a relaunch', (f) async {
      await studioSeeded(f);
      var app = await f.launch(
        viewport: FeatureViewport.phone,
        initialLocation: settingsRoute,
      );

      // The hub lists every category and carries no controls of its own.
      for (final (key, title) in [
        ('display', en.settingsCategoryDisplayTitle),
        ('notifications', en.settingsCategoryNotificationsTitle),
        ('broker', en.settingsCategoryBrokerTitle),
        ('agents', en.settingsEnhancementAgentsQuota),
        ('usage', en.usageHubTileTitle),
        ('general', en.settingsCategoryGeneralTitle),
      ]) {
        expect(
          find.descendant(
            of: find.byKey(Key('settings-category-$key')),
            matching: find.text(title),
          ),
          findsOneWidget,
          reason: key,
        );
      }
      for (final moved in [
        'appearance-theme',
        'settings-managed-runtimes',
        'settings-broker-token-field',
        'settings-local-session-notifications',
      ]) {
        expect(find.byKey(Key(moved)), findsNothing, reason: moved);
      }

      // Out of the box: the default theme, light, the OS text size, default
      // density.
      await app.openCategory('display');
      final defaults = themeSpecById(kDefaultThemeId);
      expect(app.tokens.canvas, defaults.light.canvas);
      expect(app.theme.brightness, Brightness.light);
      expect(app.textScale, 1);

      // At phone width every select stacks under its label.
      final density = find.byKey(const Key('appearance-density'));
      await app.reveal(density);
      expect(app.tester.getSize(density).width, greaterThan(300));
      expect(
        app.tester.getTopLeft(density).dy,
        greaterThan(app.tester.getTopLeft(find.text(en.densityLabel)).dy + 8),
      );

      await app.pick('appearance-theme', en.themeGraphiteMinimalistName);
      await app.pick('appearance-theme-mode', en.themeModeDark);
      await app.pick('appearance-text-scale', en.textSizeLarge);
      await app.pick('appearance-density', en.densitySpacious);

      // The running app is re-themed, not just the setting stored.
      final graphite = themeSpecById('graphite-minimalist');
      expect(app.tokens.canvas, graphite.dark.canvas);
      expect(app.theme.brightness, Brightness.dark);
      expect(app.textScale, UiTextScale.large.factor);
      expect(
        app.theme.visualDensity,
        UiDensity.spacious.visualDensity,
      );
      expect(app.tester.takeException(), isNull);

      // Language applies to every screen it reaches.
      await app.pick('appearance-language', ja.languageJapanese);
      expect(app.locale, const Locale('ja'));
      expect(find.text(ja.settingsCategoryDisplayTitle), findsWidgets);
      expect(find.text(ja.appearanceTitle), findsWidgets);

      // A relaunch over the same device storage: every choice is still there.
      app = await f.restart(initialLocation: displaySettingsRoute);
      expect(app.tokens.canvas, graphite.dark.canvas);
      expect(app.theme.brightness, Brightness.dark);
      expect(app.textScale, UiTextScale.large.factor);
      expect(app.theme.visualDensity, UiDensity.spacious.visualDensity);
      expect(app.locale, const Locale('ja'));
      expect(app.selected('appearance-theme'), ja.themeGraphiteMinimalistName);

      // Stored values that no build writes fall back on their own: the unknown
      // theme and density, a garbled text size; the language and mode stay.
      await f.storage.preferences.setThemeId('no-such-theme');
      await f.storage.preferences.setDensity('cramped');
      await f.storage.preferences.setTextScale('gigantic');
      app = await f.restart(initialLocation: displaySettingsRoute);
      expect(app.tokens.canvas, defaults.dark.canvas);
      expect(app.theme.brightness, Brightness.dark);
      expect(app.textScale, 1);
      expect(app.theme.visualDensity, UiDensity.comfortable.visualDensity);
      expect(app.locale, const Locale('ja'));

      // "System default" follows the device: its first language the app ships,
      // and English, not an error, when it ships none of them.
      final device = app.tester.platformDispatcher;
      addTearDown(device.clearLocalesTestValue);
      await app.pick('appearance-language', ja.languageSystem);
      device.localesTestValue = const [
        Locale('fr'),
        Locale('ko'),
        Locale('es'),
      ];
      await app.settle();
      expect(app.locale.languageCode, 'ko');
      device.localesTestValue = const [Locale('fr'), Locale('de')];
      await app.settle();
      expect(app.locale.languageCode, 'en');
      expect(find.text(en.settingsCategoryDisplayTitle), findsWidgets);
      // A chosen language wins over the device's.
      await app.pick('appearance-language', en.languageSpanish);
      expect(app.locale.languageCode, 'es');
    });

    featureTest('the text size steps along the ladder and stops at its ends', (
      f,
    ) async {
      await studioSeeded(f);
      await f.storage.preferences.setTextScale(UiTextScale.standard.token);
      final app = await f.launch(initialLocation: displaySettingsRoute);
      expect(app.textScale, 1);

      Future<void> chord(LogicalKeyboardKey key) async {
        await app.tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
        await app.tester.sendKeyEvent(key);
        await app.tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
        await app.settle();
      }

      await chord(LogicalKeyboardKey.equal);
      expect(app.textScale, UiTextScale.large.factor);
      await chord(LogicalKeyboardKey.equal);
      await chord(LogicalKeyboardKey.equal);
      expect(app.textScale, UiTextScale.extraLarge.factor);
      for (var i = 0; i < 4; i++) {
        await chord(LogicalKeyboardKey.minus);
      }
      expect(app.textScale, UiTextScale.small.factor);

      // Following the system, stepping resolves the device's own factor to the
      // nearest rung first: 1.14 is already near Large, so growing lands on
      // Extra large; stepping down from 1.0 lands on Small, not stuck.
      final device = app.tester.platformDispatcher;
      addTearDown(device.clearTextScaleFactorTestValue);
      await f.storage.preferences.setTextScale(UiTextScale.system.token);
      device.textScaleFactorTestValue = 1.14;
      final grown = await f.restart(initialLocation: displaySettingsRoute);
      expect(grown.textScale, 1.14);
      await chord(LogicalKeyboardKey.equal);
      expect(grown.textScale, UiTextScale.extraLarge.factor);
      await f.storage.preferences.setTextScale(UiTextScale.system.token);
      device.textScaleFactorTestValue = 1;
      final shrunk = await f.restart(initialLocation: displaySettingsRoute);
      await chord(LogicalKeyboardKey.minus);
      expect(shrunk.textScale, UiTextScale.small.factor);
    });
  });

  group('device preferences', () {
    featureTest('every device-wide preference survives a relaunch', (f) async {
      await studioSeeded(f);
      final store = GatedConversationDisplayStore(
        DriftConversationDisplayStore(f.storage.database),
      );
      final overrides = [
        conversationDisplayStoreProvider.overrideWithValue(store),
      ];
      var app = await f.launch(
        overrides: overrides,
        initialLocation: settingsRoute,
      );

      // Out of the box: background sessions hidden, IDE sessions shown, tool
      // display Responsive, the approved conversation defaults.
      expect(app.isOn('settings-show-background-sessions'), isFalse);
      expect(app.isOn('settings-show-vscode-sessions'), isTrue);
      expect(app.selected('tool-display-mode'), en.toolDisplayResponsiveTitle);
      expect(
        app.selected('conversation-font'),
        en.settingsEnhancementFontSize(15),
      );
      expect(app.selected('conversation-spacing'), en.densityComfortable);
      expect(app.isOn('conversation-reading-width'), isFalse);

      await app.toggle('settings-show-background-sessions');
      await app.toggle('settings-show-vscode-sessions');
      await app.pick('tool-display-mode', en.toolDisplayFinalTitle);
      await app.pick('conversation-font', en.settingsEnhancementFontSize(19));
      await app.toggle('conversation-reading-width');
      await app.openCategory('general');
      expect(
        find.byKey(const Key('settings-keyboard-shortcuts')),
        findsOneWidget,
      );
      expect(app.isOn('settings-show-debug-views'), isFalse);
      await app.toggle('settings-show-debug-views');
      expect(app.isOn('settings-show-debug-views'), isTrue);

      app = await f.restart(initialLocation: settingsRoute);
      expect(app.isOn('settings-show-background-sessions'), isTrue);
      expect(app.isOn('settings-show-vscode-sessions'), isFalse);
      expect(app.selected('tool-display-mode'), en.toolDisplayFinalTitle);
      expect(
        app.selected('conversation-font'),
        en.settingsEnhancementFontSize(19),
      );
      expect(app.isOn('conversation-reading-width'), isTrue);
      await app.openCategory('general');
      expect(app.isOn('settings-show-debug-views'), isTrue);

      // Stored values no build writes fall back on their own: each preference
      // returns to its default while its neighbours keep what they hold.
      await app.writeRawSetting('show_background_sessions', 'banana');
      await app.writeRawSetting('show_vscode_sessions', 'false');
      await app.writeRawSetting('tool_display_mode', 'sideways');
      await app.writeRawSetting('ui_show_debug_views', 'maybe');
      await app.writeRawSetting(
        'conversation_display',
        '{"fontSize": 99, "messageSpacing": 20, "readingWidth": true}',
      );
      app = await f.restart(initialLocation: settingsRoute);
      expect(app.isOn('settings-show-background-sessions'), isFalse);
      expect(app.isOn('settings-show-vscode-sessions'), isFalse);
      expect(app.selected('tool-display-mode'), en.toolDisplayResponsiveTitle);
      expect(
        app.selected('conversation-font'),
        en.settingsEnhancementFontSize(15),
      );
      expect(app.selected('conversation-spacing'), en.densitySpacious);
      expect(app.isOn('conversation-reading-width'), isTrue);
      await app.openCategory('general');
      expect(app.isOn('settings-show-debug-views'), isFalse);

      // A choice made before the stored ones have loaded is kept next to them.
      await app.writeRawSetting(
        'conversation_display',
        '{"fontSize": 19, "messageSpacing": 12, "readingWidth": false}',
      );
      store.gate = Completer<void>();
      app = await f.restart(initialLocation: settingsRoute);
      await app.pick('conversation-spacing', en.densitySpacious);
      store.gate!.complete();
      await app.settle();
      expect(
        app.selected('conversation-font'),
        en.settingsEnhancementFontSize(19),
      );
      expect(app.selected('conversation-spacing'), en.densitySpacious);
    });
  });

  group('agents', () {
    featureTest('an owner reads the runtimes and manages them', (f) async {
      final studio = await studioSeeded(f);
      final desk = RuntimeDesk(studio);
      final opencode = runtimeStatus(
        agent: 'opencode',
        displayName: 'OpenCode',
        managed: false,
        state: 'unavailable',
        updateAvailable: false,
        pendingChanges: const [],
        runningVersion: null,
        installedVersion: null,
        blockers: null,
        composition: null,
      );
      desk.updates = [runtimeStatus(), opencode];
      final app = await f.launch(initialLocation: settingsRoute);
      await app.openCategory('agents');

      // Ownership policy, recovery controls and what each runtime is doing.
      expect(find.text(en.settingsRuntimeOwnershipNotice), findsOneWidget);
      expect(find.byKey(const Key('settings-runtime-policy')), findsOneWidget);
      expect(find.text(en.settingsUpdateReady), findsOneWidget);
      expect(
        find.text(
          en.settingsRuntimeVersionsRowConfigChanged(
            en.settingsRuntimeVersionsRow('0.144.1', '0.144.1'),
          ),
        ),
        findsOneWidget,
      );
      expect(
        find.text(en.settingsRuntimeBlockersComposition('0', '0', '1', '0')),
        findsOneWidget,
      );
      expect(find.text(en.settingsRestartNow), findsOneWidget);
      expect(find.text(en.settingsForceRestartRuntimeAction), findsNothing);
      // A runtime the server does not own offers no restart at all.
      expect(find.text('OpenCode'), findsOneWidget);
      expect(
        find.byKey(const Key('settings-restart-runtime-opencode')),
        findsNothing,
      );
      expect(app.isOn('settings-quota-warnings'), isFalse);

      // The idle policy warns first; cancelling reaches the broker with
      // nothing.
      await app.pick('settings-runtime-policy', en.settingsPolicyWhenIdle);
      expect(
        find.text(en.settingsIdleTerminalsDisconnectTitle),
        findsOneWidget,
      );
      await app.cancelDialog();
      expect(desk.policyWrites, isEmpty);
      expect(
        app.selected('settings-runtime-policy'),
        en.settingsPolicyWhenDetached,
      );
      await app.pick('settings-runtime-policy', en.settingsPolicyWhenIdle);
      await app.confirm(en.settingsUseIdlePolicy);
      expect(desk.policyWrites, ['when-idle']);
      expect(
        app.selected('settings-runtime-policy'),
        en.settingsPolicyWhenIdle,
      );

      // A runtime with a change pending restarts to apply it; once nothing is
      // pending the same control is a forced restart with its own wording.
      desk.onRestart = (_) => desk.updates = [currentRuntime(), opencode];
      await app.tapKey('settings-restart-runtime-codex');
      expect(
        find.text(en.settingsRestartRuntimeConfirmTitle('Codex')),
        findsOneWidget,
      );
      expect(
        find.text(en.settingsForceRestartRuntimeConfirmBody),
        findsNothing,
      );
      await app.confirm(en.settingsRestartNow);
      expect(desk.restarts, ['codex']);
      expect(find.text(en.settingsRuntimeNoRestartNeeded), findsOneWidget);
      expect(find.text(en.settingsUpdateReady), findsNothing);
      await app.tapKey('settings-restart-runtime-codex');
      expect(
        find.text(en.settingsForceRestartRuntimeConfirmTitle('Codex')),
        findsOneWidget,
      );
      expect(
        find.text(en.settingsForceRestartRuntimeConfirmBody),
        findsOneWidget,
      );
      await app.cancelDialog();
      expect(desk.restarts, ['codex']);

      // A restart that fails says so and keeps the last status on screen.
      desk.restartFails = true;
      await app.tapKey('settings-restart-runtime-codex');
      await app.confirm(en.settingsForceRestartRuntimeAction);
      expect(
        find.byKey(const Key('settings-runtime-action-error')),
        findsOneWidget,
      );
      expect(find.text(en.settingsRuntimeNoRestartNeeded), findsOneWidget);
      expect(desk.restarts, ['codex']);

      // Restart everything asks first.
      await app.tapKey('settings-restart-everything');
      expect(
        find.text(en.settingsRestartEverythingConfirmTitle),
        findsOneWidget,
      );
      await app.cancelDialog();
      expect(desk.restartAllCalls, 0);
      await app.tapKey('settings-restart-everything');
      await app.confirm(en.settingsRestartEverythingAction);
      expect(desk.restartAllCalls, 1);
      expect(find.widgetWithText(SelectableText, 'scheduled'), findsOneWidget);

      // A pending runtime that cleared its own gate is never called blocked.
      desk.updates = [
        runtimeStatus(
          agent: 'opencode',
          displayName: 'OpenCode',
          autoRestartReady: true,
          pendingChanges: const ['binary-version'],
          runningVersion: '1.0.0',
          installedVersion: '1.1.0',
          blockers: null,
          composition: null,
        ),
      ];
      expect(app.isOn('settings-quota-warnings'), isFalse);
      await app.toggle('settings-quota-warnings');
      expect(desk.quotaPreferenceWrites, [true]);
      expect(app.isOn('settings-quota-warnings'), isTrue);
      expect(find.text(en.settingsUpdateReady), findsOneWidget);
      expect(find.text(en.settingsRuntimeNoBlockingSessions), findsOneWidget);
      expect(find.text(en.settingsRuntimeActivityUnavailable), findsNothing);
    });
  });

  group('quota', () {
    featureTest(
      'the quota panel states what remains in every window it can read',
      semantics: true,
      (f) async {
        final studio = await studioSeeded(f);
        final desk = RuntimeDesk(studio);
        final app = await f.launch(initialLocation: settingsRoute);
        final now = DateTime.now();

        // Each snapshot is read when the Agents page opens, so leaving the page
        // and coming back is a new read.
        Future<void> read(Map<String, Object?> body) async {
          desk.quotaBody = body;
          await app.openCategory('general');
          await app.openCategory('agents');
          await app.waitFor(find.byKey(const Key('settings-quota-panel')));
        }

        final panel = find.byKey(const Key('settings-quota-panel'));
        Finder inPanel(String text) =>
            find.descendant(of: panel, matching: find.text(text));
        List<LinearProgressIndicator> bars() => app.tester
            .widgetList<LinearProgressIndicator>(
              find.descendant(
                of: panel,
                matching: find.byType(LinearProgressIndicator),
              ),
            )
            .toList();
        String label(String key) =>
            app.tester.getSemantics(find.byKey(Key(key))).label;

        // One recorded multi-provider reading.
        await read(
          quotaSnapshot({
            'codex': quotaProvider(
              'codex',
              resetCredits: quotaResetCredits(2, [
                now.add(const Duration(days: 29, hours: 2)),
                now.add(const Duration(days: 22, hours: 8)),
              ]),
              buckets: [
                quotaBucket(
                  resetsAt: now.add(const Duration(hours: 3, minutes: 30)),
                ),
                quotaBucket(
                  id: '7d',
                  label: 'Weekly',
                  remaining: 80,
                  resetsAt: now.add(const Duration(days: 4, hours: 2)),
                ),
                quotaBucket(
                  id: 'codex_bengalfox_5h',
                  label: 'GPT-5.3-Codex-Spark \u00b7 5-hour',
                  remaining: 100,
                ),
                quotaBucket(
                  id: 'codex_redpanda_7d',
                  label: 'GPT-6-Codex-Nova \u00b7 7-day',
                  remaining: 90,
                ),
              ],
            ),
            'claude': quotaProvider(
              'claude',
              estimated: true,
              buckets: [
                quotaBucket(id: 'session', label: 'Session', remaining: 20),
                quotaBucket(
                  id: 'weekly_all',
                  label: 'Weekly All',
                  remaining: 8,
                ),
                quotaBucket(
                  id: 'weekly_scoped_fable',
                  label: 'Fable',
                  remaining: 60,
                ),
              ],
            ),
            'opencode_go': quotaProvider(
              'opencode_go',
              buckets: [
                quotaBucket(
                  id: 'rolling',
                  label: 'Rolling (5h)',
                  remaining: 73,
                ),
                quotaBucket(id: 'monthly', label: 'Monthly', remaining: 62),
              ],
            ),
            'zai': quotaProvider(
              'zai',
              buckets: [
                quotaBucket(id: 'primary', remaining: 92),
                quotaBucket(id: 'win_15h', label: '15h burst', remaining: 50),
              ],
            ),
            'antigravity': quotaProvider(
              'antigravity',
              buckets: [
                quotaBucket(
                  id: 'gemini-2.5-pro',
                  label: 'Gemini 2.5 Pro',
                  remaining: 74,
                ),
                quotaBucket(
                  id: 'gemini-3-pro',
                  label: 'Gemini 3 Pro',
                  remaining: 41,
                  resetsAt: now.add(const Duration(hours: 3, minutes: 30)),
                ),
                quotaBucket(
                  id: 'claude-sonnet',
                  label: 'Claude Sonnet',
                  remaining: 82,
                ),
                quotaBucket(
                  id: 'gpt-oss',
                  label: 'GPT OSS',
                  remaining: 24,
                  resetsAt: now.add(const Duration(hours: 2, minutes: 30)),
                ),
                quotaBucket(
                  id: 'experimental-model',
                  label: 'Experimental model',
                  remaining: 3,
                ),
              ],
            ),
            'zeta': quotaProvider(
              'zeta',
              buckets: [
                quotaBucket(
                  id: 'limit_9',
                  label: 'Turbo credits',
                  remaining: 33,
                ),
              ],
            ),
            'minimax': quotaProvider(
              'minimax',
              buckets: [
                quotaBucket(
                  id: 'global_general_7d',
                  label: 'Weekly',
                  remaining: null,
                ),
              ],
            ),
            'kimi': quotaEmptyShell('kimi'),
          }),
        );
        for (final name in [
          'Codex',
          'Claude',
          'OpenCode Go',
          'Z.ai',
          'Antigravity',
          'Zeta',
          'MiniMax',
        ]) {
          expect(inPanel(name), findsOneWidget, reason: name);
        }
        // An unconfigured provider shell is not a provider.
        expect(inPanel('Kimi'), findsNothing);
        // Every five-hour window reads "5-hour", whatever its id; only a whole
        // "5h" is one; a model-scoped pool names its model; Claude's scoped
        // Fable quota stays apart from weekly-all.
        expect(find.text('Rolling (5h)'), findsNothing);
        expect(find.text('5-hour window'), findsNothing);
        expect(inPanel('15h burst'), findsOneWidget);
        expect(inPanel('Monthly'), findsOneWidget);
        expect(inPanel('Sparks 5-hour'), findsOneWidget);
        expect(inPanel('GPT-6-Codex-Nova Weekly'), findsOneWidget);
        expect(inPanel('Fable Weekly'), findsOneWidget);
        expect(find.text('Weekly All'), findsNothing);
        // Antigravity's per-model readings collapse into two pools.
        expect(
          inPanel(en.settingsQuotaAntigravityGeminiModels),
          findsOneWidget,
        );
        expect(
          inPanel(en.settingsQuotaAntigravityClaudeGptModels),
          findsOneWidget,
        );
        expect(inPanel('41% remaining'), findsOneWidget);
        expect(inPanel('24% remaining'), findsOneWidget);
        expect(find.text('74% remaining'), findsNothing);
        expect(find.text('Experimental model'), findsNothing);
        expect(
          label('settings-quota-row-antigravity-pool-gemini'),
          contains('Antigravity Gemini models 5-hour'),
        );
        // A reading the broker could not give is stated, not drawn as a bar.
        expect(inPanel(en.settingsQuotaNoReadings), findsOneWidget);
        // Fresh rows: percent, reset time, one spoken summary per row.
        expect(inPanel('42% remaining'), findsOneWidget);
        expect(inPanel('80% remaining'), findsOneWidget);
        expect(inPanel('Resets in 3 h'), findsWidgets);
        expect(inPanel('Resets in 4 days'), findsOneWidget);
        final codex5h = label('settings-quota-row-codex-5h');
        expect(codex5h, contains('Codex 5-hour'));
        expect(codex5h, contains('42% remaining'));
        expect(codex5h, contains('Resets in 3 h'));
        // A window that is running low colours its bar; healthy ones stay
        // quiet.
        final claudeBars = app.tester
            .widgetList<LinearProgressIndicator>(
              find.descendant(
                of: find.byKey(const Key('settings-quota-row-claude-session')),
                matching: find.byType(LinearProgressIndicator),
              ),
            )
            .single;
        expect(claudeBars.color, app.tokens.statusNeedsInput);
        final critical = app.tester
            .widgetList<LinearProgressIndicator>(
              find.descendant(
                of: find.byKey(
                  const Key('settings-quota-row-claude-weekly_all'),
                ),
                matching: find.byType(LinearProgressIndicator),
              ),
            )
            .single;
        expect(critical.color, app.tokens.statusError);
        expect(
          bars().where((bar) => bar.color == app.tokens.textSecondary),
          isNotEmpty,
        );
        expect(inPanel(en.settingsQuotaEstimated), findsOneWidget);
        // Reset credits sit under their provider's windows, only for those that
        // hold some.
        expect(inPanel(en.settingsQuotaResetCredits), findsOneWidget);
        expect(
          inPanel(en.settingsQuotaResetCreditsAvailable(2)),
          findsOneWidget,
        );
        expect(
          inPanel(en.settingsQuotaResetCreditsExpireInDays(2, 22)),
          findsOneWidget,
        );
        expect(
          label('settings-quota-reset-credits-codex'),
          contains('2 available'),
        );
        expect(
          app.tester
              .getTopLeft(
                find.byKey(const Key('settings-quota-reset-credits-codex')),
              )
              .dy,
          greaterThan(
            app.tester
                .getBottomLeft(
                  find.byKey(const Key('settings-quota-row-codex-7d')),
                )
                .dy,
          ),
        );
        expect(
          find.byKey(const Key('settings-quota-reset-credits-zai')),
          findsNothing,
        );

        // A provider that is failing keeps its last readings, marked Stale; a
        // failing bucket marks only its own row; a shell with no detail but a
        // failing status is still a failure.
        await read(
          quotaSnapshot({
            'codex': quotaProvider(
              'codex',
              status: 'fetch_error',
              statusDetail: 'fetch_error',
              buckets: [quotaBucket(remaining: 55)],
            ),
            'claude': quotaProvider(
              'claude',
              status: 'fetch_error',
              statusDetail: 'fetch_error',
            ),
            'grok': quotaProvider('grok', status: 'fetch_error'),
            'zai': quotaProvider(
              'zai',
              buckets: [
                quotaBucket(remaining: 77),
                quotaBucket(
                  id: '7d',
                  label: 'Weekly',
                  remaining: 80,
                  status: 'fetch_error',
                ),
              ],
            ),
          }),
        );
        expect(inPanel('55% remaining'), findsOneWidget);
        expect(inPanel(en.settingsQuotaStale), findsNWidgets(4));
        expect(inPanel(en.settingsQuotaNoReadings), findsNWidgets(2));
        expect(label('settings-quota-row-zai-7d'), contains('Stale'));
        expect(label('settings-quota-row-zai-5h'), isNot(contains('Stale')));

        // Reset credits: none to spend, no row; the last two days read amber;
        // an expired credit is ignored; with no future expiry the count stands
        // alone.
        await read(
          quotaSnapshot({
            'codex': quotaProvider(
              'codex',
              resetCredits: quotaResetCredits(1, [
                now.subtract(const Duration(days: 1)),
                now.add(const Duration(hours: 30)),
              ]),
              buckets: [quotaBucket()],
            ),
            'claude': quotaProvider(
              'claude',
              resetCredits: quotaResetCredits(0, const []),
              buckets: [quotaBucket(id: 'session')],
            ),
            'zai': quotaProvider(
              'zai',
              resetCredits: quotaResetCredits(1, [
                now.subtract(const Duration(hours: 1)),
              ]),
              buckets: [quotaBucket()],
            ),
          }),
        );
        final tomorrow = app.tester.widget<Text>(
          inPanel(en.settingsQuotaResetCreditsExpireTomorrow(1)),
        );
        expect(tomorrow.style?.color, app.tokens.statusNeedsInput);
        expect(inPanel(en.settingsQuotaResetCredits), findsNWidgets(2));
        expect(
          find.byKey(const Key('settings-quota-reset-credits-claude')),
          findsNothing,
        );
        expect(
          find.descendant(
            of: find.byKey(const Key('settings-quota-reset-credits-zai')),
            matching: find.textContaining('xpires'),
          ),
          findsNothing,
        );

        // The language of the app is the language of the plurals.
        await app.container
            .read(localeControllerProvider.notifier)
            .setLocale(const Locale('es'));
        await read(
          quotaSnapshot({
            'codex': quotaProvider(
              'codex',
              resetCredits: quotaResetCredits(1, [
                now.add(const Duration(days: 5, hours: 1)),
              ]),
              buckets: [quotaBucket()],
            ),
          }),
        );
        expect(inPanel('Créditos de reinicio'), findsOneWidget);
        expect(inPanel('1 disponible'), findsOneWidget);
        expect(inPanel('Caduca en 5 días'), findsOneWidget);
        await app.container
            .read(localeControllerProvider.notifier)
            .setLocale(const Locale('en'));
        await app.settle();

        // What no reading can be made of says so without naming internals.
        for (final body in <Map<String, Object?>>[
          quotaSnapshot({
            'codex': quotaEmptyShell('codex'),
            'kimi': quotaEmptyShell('kimi'),
          }),
          {
            'ok': false,
            'baseUrl': 'http://127.0.0.1:55423',
            'endpoint': '/api/quota',
            'error':
                'GET http://127.0.0.1:55423/api/quota failed: ECONNREFUSED',
          },
        ]) {
          await read(body);
          expect(inPanel(en.settingsQuotaUnavailable), findsOneWidget);
          expect(find.textContaining('ECONNREFUSED'), findsNothing);
          expect(find.textContaining('127.0.0.1'), findsNothing);
        }
        desk.quotaFails = true;
        await read(const {});
        expect(inPanel(en.settingsQuotaUnavailable), findsOneWidget);
        // Settings itself still works with the quota read down.
        expect(
          find.byKey(const Key('settings-runtime-policy')),
          findsOneWidget,
        );
        desk.quotaFails = false;
        await read(quotaSnapshot(const {}, enabled: false));
        expect(inPanel(en.settingsQuotaMonitoringOff), findsOneWidget);
        expect(app.tester.takeException(), isNull);
      },
    );
  });

  group('switching servers', () {
    featureTest(
      'a paired peer and a held answer from another server change nothing here',
      (f) async {
        final studio = await studioSeeded(f);
        final tower = f.network.add('http://tower.test:7734', machine: 'tower');
        await f.storage.seedServer(tower, active: false);
        final studioDesk = RuntimeDesk(studio)
          ..workspaceBrowsing = false
          ..quotaBody = quotaSnapshot({
            'codex': quotaProvider('codex', buckets: [quotaBucket()]),
          });
        final towerDesk = RuntimeDesk(tower)
          ..principal = 'peer'
          ..workspaceBrowsing = true
          ..updates = [
            runtimeStatus(
              agent: 'opencode',
              displayName: 'OpenCode',
              state: 'current',
              updateAvailable: false,
              pendingChanges: const [],
              blockers: null,
              composition: null,
            ),
          ]
          ..quotaBody = quotaSnapshot({
            'zai': quotaProvider('zai', buckets: [quotaBucket(remaining: 77)]),
          });
        final app = await f.launch(initialLocation: settingsRoute);
        await app.openCategory('agents');
        expect(find.text('Codex'), findsWidgets);
        expect(
          find.byKey(const Key('settings-runtime-policy')),
          findsOneWidget,
        );
        expect(find.text('42% remaining'), findsOneWidget);

        // Owner on studio: the workspace-browsing gate asks before it moves.
        await app.openCategory('broker');
        expect(app.isOn('settings-workspace-browsing'), isFalse);
        await app.toggle('settings-workspace-browsing');
        expect(
          find.text(en.settingsWorkspaceBrowsingEnableTitle),
          findsOneWidget,
        );
        await app.cancelDialog();
        expect(studioDesk.workspaceWrites, isEmpty);
        await app.toggle('settings-workspace-browsing');
        await app.confirm(en.settingsWorkspaceBrowsingEnableAction);
        expect(studioDesk.workspaceWrites, [true]);

        // Studio's quota read and its restart-everything are both still out
        // when the user moves to the tower.
        await app.openCategory('general');
        final quotaHold = studio.hold('GET', '/api/tokdash/quota');
        final restartHold = studio.hold('POST', '/api/broker/restart-all');
        await app.openCategory('agents');
        expect(quotaHold.arrivals, 1);
        await app.tapKey('settings-restart-everything');
        await app.confirm(en.settingsRestartEverythingAction);
        expect(restartHold.arrivals, 1);
        await app.switchServer(tower.baseUri.toString());
        await app.waitFor(find.text('OpenCode'));

        // Settings follows the switch with no reload, and a paired peer sees
        // the
        // status but none of the owner's controls.
        expect(find.text('OpenCode'), findsOneWidget);
        expect(find.text('Codex'), findsNothing);
        for (final key in [
          'settings-runtime-policy',
          'settings-restart-everything',
          'settings-quota-warnings',
        ]) {
          expect(find.byKey(Key(key)), findsNothing, reason: key);
        }
        await app.waitFor(find.text('77% remaining'));

        // The answers studio gives now land nowhere.
        quotaHold.release();
        restartHold.release();
        await app.settle();
        await app.elapse(const Duration(seconds: 1));
        expect(find.text('42% remaining'), findsNothing);
        expect(find.text('77% remaining'), findsOneWidget);
        expect(find.text('scheduled'), findsNothing);

        // A peer can see the workspace-browsing gate and not move it.
        await app.openCategory('broker');
        expect(app.isOn('settings-workspace-browsing'), isTrue);
        expect(app.isEnabled('settings-workspace-browsing'), isFalse);
        expect(
          find.text(en.settingsWorkspaceBrowsingOwnerOnly),
          findsOneWidget,
        );

        // Back on studio, a change reaches studio and only studio.
        await app.switchServer(studio.baseUri.toString());
        await app.openCategory('agents');
        await app.waitFor(find.byKey(const Key('settings-runtime-policy')));
        await app.pick('settings-runtime-policy', en.settingsPolicyWhenIdle);
        await app.confirm(en.settingsUseIdlePolicy);
        expect(studioDesk.policyWrites, ['when-idle']);
        expect(towerDesk.policyWrites, isEmpty);
        expect(towerDesk.restartAllCalls, 0);

        // With Settings closed no server's quota is read on a switch.
        await app.openCategory('general');
        final reads = (studioDesk.quotaReads, towerDesk.quotaReads);
        await app.switchServer(tower.baseUri.toString());
        await app.switchServer(studio.baseUri.toString());
        expect((studioDesk.quotaReads, towerDesk.quotaReads), reads);
      },
    );
  });

  group('platform switches', () {
    featureTest('closing and background switches show only where they apply', (
      f,
    ) async {
      await studioSeeded(f);
      var launched = false;
      Future<AppDriver> launchOn(TargetPlatform platform) async {
        debugDefaultTargetPlatformOverride = platform;
        if (launched) {
          return f.restart(initialLocation: notificationSettingsRoute);
        }
        launched = true;
        return f.launch(
          initialLocation: notificationSettingsRoute,
          // The notification page asks the OS plugin what it manages.
          overrides: [
            sessionLocalNotificationAdapterProvider.overrideWithValue(
              FlutterLocalNotificationSink(backend: FakeNotificationBackend()),
            ),
          ],
        );
      }

      const keepRunning = 'settings-desktop-keep-running';
      const background = 'settings-android-background-connection';
      Finder none(String key) => find.byKey(Key(key));

      // Windows and macOS keep running in the background until told otherwise.
      var app = await launchOn(TargetPlatform.windows);
      expect(app.isOn(keepRunning), isTrue);
      expect(
        find.descendant(
          of: none(keepRunning),
          matching: find.text(en.desktopKeepRunningSubtitleWindows),
        ),
        findsOneWidget,
      );
      expect(none(background), findsNothing);
      await app.toggle(keepRunning);
      expect(app.isOn(keepRunning), isFalse);
      app = await launchOn(TargetPlatform.macOS);
      expect(app.isOn(keepRunning), isFalse);
      expect(
        find.descendant(
          of: none(keepRunning),
          matching: find.text(en.desktopKeepRunningSubtitleMacos),
        ),
        findsOneWidget,
      );
      await app.toggle(keepRunning);
      app = await launchOn(TargetPlatform.macOS);
      expect(app.isOn(keepRunning), isTrue);
      expect(none(background), findsNothing);

      // Where closing the window quits there is nothing to keep running.
      app = await launchOn(TargetPlatform.linux);
      expect(none(keepRunning), findsNothing);
      expect(none(background), findsNothing);

      // Android stays connected in the background only once enabled, and only
      // while notifications are on.
      app = await launchOn(TargetPlatform.android);
      expect(none(keepRunning), findsNothing);
      expect(app.isOn(background), isFalse);
      expect(app.isEnabled(background), isFalse);
      await app.writeRawSetting('local_session_notifications_enabled', 'true');
      app = await launchOn(TargetPlatform.android);
      expect(app.isOn(background), isFalse);
      expect(app.isEnabled(background), isTrue);
      await app.toggle(background);
      expect(app.isOn(background), isTrue);
      app = await launchOn(TargetPlatform.android);
      expect(app.isOn(background), isTrue);
      await app.writeRawSetting('local_session_notifications_enabled', 'false');
      app = await launchOn(TargetPlatform.android);
      expect(app.isOn(background), isFalse);
      expect(app.isEnabled(background), isFalse);
    });
  });
}
