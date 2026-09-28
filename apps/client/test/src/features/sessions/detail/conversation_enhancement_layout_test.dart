import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

void main() {
  setUpAll(() async {
    TestWidgetsFlutterBinding.ensureInitialized();
    final font = FontLoader('Lato')
      ..addFont(rootBundle.load('assets/fonts/Lato-Regular.ttf'))
      ..addFont(rootBundle.load('assets/fonts/Lato-Semibold.ttf'))
      ..addFont(rootBundle.load('assets/fonts/Lato-Bold.ttf'));
    await font.load();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });
  for (final variant in [
    (width: 320.0, height: 568.0, dark: false),
    (width: 390.0, height: 844.0, dark: false),
    (width: 390.0, height: 844.0, dark: true),
    (width: 390.0, height: 420.0, dark: false),
    (width: 820.0, height: 900.0, dark: true),
    (width: 1440.0, height: 1080.0, dark: false),
  ]) {
    testWidgets('working composer ${variant.width}x${variant.height} '
        '${variant.dark ? "dark" : "light"}', (tester) async {
      tester.view
        ..physicalSize = Size(variant.width, variant.height)
        ..devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final tokens = themeSpecById(kDefaultThemeId);
      final touch = variant.width < 1000;
      final theme =
          buildAppTheme(
            variant.dark ? tokens.dark : tokens.light,
            variant.dark ? Brightness.dark : Brightness.light,
          ).copyWith(
            platform: touch ? TargetPlatform.android : TargetPlatform.linux,
          );
      await tester.pumpWidget(
        RepaintBoundary(
          key: const Key('conversation-enhancement-preview'),
          child: buildSessionDetailTestPage(
            tool: 'codex',
            theme: theme,
            events: [
              SessionWireEvent(
                info: SessionInfo.fromJson(const {
                  'id': 'session-1',
                  'tool': 'codex',
                  'title': 'Review the token pipeline',
                  'projectName': 'Cosyncing',
                  'status': 'working',
                  'attachMode': 'resume',
                  'currentMode': 'ask',
                  'currentModel': {
                    'providerID': 'openai',
                    'modelID': 'gpt-5',
                    'label': 'GPT-5',
                    'reasoningEffort': 'high',
                  },
                  'control': {
                    'drive': {'state': 'driving', 'supported': true},
                    'terminalSync': {
                      'supported': false,
                      'syncAvailable': false,
                      'active': false,
                    },
                    'input': 'full',
                  },
                }),
              ),
              const OptionsWireEvent(
                models: [
                  ModelOption(
                    providerID: 'openai',
                    modelID: 'gpt-5',
                    label: 'GPT-5',
                    reasoningEfforts: [
                      ReasoningEffort(effort: 'high', label: 'High'),
                    ],
                  ),
                ],
                agents: [],
                modes: [ModeOption(value: 'ask', label: 'Ask permission')],
              ),
              const CommandsWireEvent(
                commands: [
                  SlashCommand(
                    name: 'stop',
                    kind: SlashCommandKind.action,
                  ),
                ],
              ),
              HistoryWireEvent(
                reset: true,
                messages: [
                  AgentMessage.fromJson(const {
                    'type': 'user-message',
                    'key': 'u1',
                    'text':
                        'Please review the token pipeline. '
                        'Keep the changes focused and explain the result.',
                  }),
                  AgentMessage.fromJson(const {
                    'type': 'model-output',
                    'key': 'a1',
                    'text':
                        'Tracing usage events through the broker.\n\n'
                        'I am working through the next step. You can open '
                        'another session while this continues.',
                  }),
                  AgentMessage.fromJson(const {
                    'type': 'metadata-update',
                    'key': 'contextUsage',
                    'value': {'used': 74000, 'max': 200000},
                  }),
                ],
              ),
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('session-detail-prompt-input')),
        'Keep working; check the edge case.',
      );
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      final composer = tester.getRect(
        find.byKey(const Key('session-detail-composer')),
      );
      for (final key in [
        'session-detail-composer-menu',
        'session-detail-permission-selector',
        'session-detail-model-selector',
        'session-detail-voice-input-button',
        'session-detail-interrupt-button',
        'session-detail-send-button',
      ]) {
        final rect = tester.getRect(find.byKey(Key(key)));
        expect(rect.left, greaterThanOrEqualTo(composer.left));
        expect(rect.right, lessThanOrEqualTo(composer.right));
        expect(rect.height, greaterThanOrEqualTo(touch ? 40 : 20), reason: key);
      }
      expect(tester.getSize(find.text('GPT-5')).width, greaterThan(24));
      final input = tester.getRect(
        find.byKey(const Key('session-detail-prompt-input')),
      );
      final meter = tester.getRect(
        find.byKey(
          Key(
            variant.width < 420
                ? 'session-context-meter-ring'
                : 'session-context-meter-verbose',
          ),
        ),
      );
      expect(meter.left, greaterThanOrEqualTo(input.right));
      await expectLater(
        find.byKey(const Key('conversation-enhancement-preview')),
        matchesGoldenFile(
          'goldens/conversation_enhancement_'
          '${variant.width.toInt()}_${variant.height.toInt()}_'
          '${variant.dark ? "dark" : "light"}.png',
        ),
      );
      await openComposerMenu(tester);
      expect(
        find.byKey(const Key('session-detail-command-picker-button')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-detail-attach-button')),
        findsOneWidget,
      );
      // Primary controls have one home; the menu adds no second picker/mic.
      expect(
        find.byKey(const Key('session-detail-model-selector')),
        findsOneWidget,
      );
    });
  }
}
