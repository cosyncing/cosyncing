// Behavior files retain a common import set to keep split diffs mechanical.
// ignore_for_file: unused_import, unnecessary_import

import 'dart:async';
import 'dart:ui' show PointerDeviceKind;

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_preview_result.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_page.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/requests/session_command_args_codec.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:cosyncing_client/src/features/settings/data/session_display_preferences_store.dart';
import 'package:cosyncing_client/src/features/settings/data/session_notification_settings_store.dart';
import 'package:cosyncing_client/src/features/transfers/data/local_transfer_file_opener.dart';
import 'package:cosyncing_client/src/features/voice/controller/voice_input_controller.dart';
import 'package:cosyncing_client/src/platform/speech/speech_capabilities.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_recognition_policy.dart';
import 'package:flutter/gestures.dart' show kSecondaryMouseButton;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/in_memory_session_display_preferences_store.dart';
import '../../../../support/in_memory_session_live_state_view_store.dart';
import '../../../../support/session_detail_page_test_harness.dart';

void main() {
  group('SessionDetailPage session control', () {
    ScriptedSessionDetailConnection controlConnection(
      Map<String, dynamic> control, [
      String? launchSurface,
    ]) {
      return ScriptedSessionDetailConnection(
        events: [
          SessionWireEvent(
            info: SessionInfo.fromJson({
              'id': 'session-1',
              'tool': 'claude',
              'title': 'Control test',
              'status': 'idle',
              'attachMode': 'observe',
              if (launchSurface != null) 'launchSurface': launchSurface,
              'control': control,
            }),
          ),
        ],
      );
    }

    Future<void> openStatusSheet(WidgetTester tester) async {
      await openSessionDetailTestTab(tester, 'session-detail-tab-status');
    }

    Future<void> expectTerminalStatusCase({
      required WidgetTester tester,
      required String presence,
      required String? status,
      required bool hasCommand,
      required String action,
      required bool optionalBeforeSheet,
      required bool expectHandoff,
      String? launchSurface,
      bool? behind,
      String? label,
    }) async {
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (_) async => null,
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      final connection = controlConnection(
        {
          'drive': {'state': 'driving', 'supported': true},
          'terminalSync': {
            'supported': true,
            'syncAvailable': false,
            'active': false,
            'presence': presence,
            'action': action,
            if (behind != null) 'behind': behind,
            if (hasCommand) 'command': 'open terminal',
          },
        },
        launchSurface,
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
        ),
      );
      await tester.pumpAndSettle();
      if (optionalBeforeSheet) {
        expect(find.text('Open in terminal (optional)'), findsNothing);
      }
      await openStatusSheet(tester);
      final hasJoinCommand = action == 'join' && hasCommand;
      final hasTerminalSection =
          action != 'join' && (hasCommand || presence == 'private');
      expect(
        find.text('Terminal (optional)'),
        hasTerminalSection ? findsOneWidget : findsNothing,
      );
      expect(
        find.text('Sync with a terminal'),
        hasJoinCommand ? findsOneWidget : findsNothing,
      );
      if (status case final status?) {
        expect(find.text(status), findsOneWidget);
      }
      if (label != null) {
        expect(find.text(label), findsOneWidget);
      }
      expect(
        find.byKey(const Key('session-detail-status-copy-command')),
        hasCommand ? findsOneWidget : findsNothing,
      );
      if (hasCommand) {
        await tester.tap(
          find.byKey(const Key('session-detail-status-copy-command')),
        );
        await tester.pumpAndSettle();
        expect(connection.reattachModes, isEmpty);
        expect(connection.sendHandoffCount, expectHandoff ? 1 : 0);
      }
    }

    testWidgets('sync-active outranks driving — pill shows Synced', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: controlConnection(const {
            'drive': {'state': 'driving', 'supported': true},
            'terminalSync': {
              'supported': true,
              'syncAvailable': true,
              'active': true,
            },
          }),
        ),
      );
      await tester.pumpAndSettle();
      await openStatusSheet(tester);

      expect(
        find.byKey(
          const Key('session-detail-status-sheet-control-pill-synced'),
        ),
        findsOneWidget,
      );
      expect(find.text('Synced'), findsAtLeastNWidgets(1));
    });

    testWidgets('driving with no active sync shows Driving', (tester) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: controlConnection(const {
            'drive': {'state': 'driving', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          }),
        ),
      );
      await tester.pumpAndSettle();
      await openStatusSheet(tester);

      expect(
        find.byKey(
          const Key('session-detail-status-sheet-control-pill-driving'),
        ),
        findsOneWidget,
      );
      expect(find.text('Driving'), findsAtLeastNWidgets(1));
    });

    // Observing prevents broker mutation, not local durable staging. The
    // composer explains that ownership state and replaces the dead Send action
    // with the same Take over flow offered by Status.
    testWidgets('observing preserves a durable draft and offers Take over', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: controlConnection(const {
            'drive': {'state': 'observing', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          }),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-detail-bottom-status-button')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-detail-observe-composer-bar')),
        findsOneWidget,
      );
      expect(
        find.text(
          'The terminal owns input right now. Take over to send from the app.',
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-detail-composer-take-over-button')),
        findsOneWidget,
      );
      expect(
        tester
            .getSemantics(
              find.byKey(const Key('session-detail-observe-composer-bar')),
            )
            .label,
        contains('Observing. The terminal owns input right now.'),
      );
      expect(
        find.byKey(const Key('session-detail-send-button')),
        findsNothing,
      );
      final promptInput = tester.widget<TextField>(
        find.byKey(const Key('session-detail-prompt-input')),
      );
      expect(promptInput.enabled, isTrue);
      expect(promptInput.decoration?.hintText, 'Draft a prompt');
      await tester.enterText(
        find.byKey(const Key('session-detail-prompt-input')),
        'Keep this local draft',
      );
      await tester.pump();
      expect(
        tester
            .widget<TextField>(
              find.byKey(const Key('session-detail-prompt-input')),
            )
            .controller
            ?.text,
        'Keep this local draft',
      );
      semantics.dispose();
    });

    testWidgets('answer-only sync keeps the pill Synced but blocks the '
        'composer', (tester) async {
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });
      tester.view
        ..physicalSize = const Size(360, 760)
        ..devicePixelRatio = 1;
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: controlConnection(const {
            'drive': {'state': 'unavailable', 'supported': false},
            'terminalSync': {
              'supported': true,
              'syncAvailable': true,
              'active': true,
              'input': 'answer-only',
            },
          }),
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-detail-bottom-status-button')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-detail-observe-composer-bar')),
        findsOneWidget,
      );
      expect(
        find.text(
          'Synced with your terminal for answers only. '
          'Answer permission and question cards here; send new prompts from '
          'the terminal.',
        ),
        findsOneWidget,
      );
      expect(
        find.ancestor(
          of: find.byKey(
            const Key('session-detail-observe-composer-description'),
          ),
          matching: find.byType(SelectionArea),
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-detail-composer-take-over-button')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('session-detail-send-button')),
        findsNothing,
      );
      expect(
        tester
            .widget<TextField>(
              find.byKey(const Key('session-detail-prompt-input')),
            )
            .decoration
            ?.hintText,
        'Draft a prompt',
      );
    });

    testWidgets('tapping the pill opens the status sheet with the command', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: controlConnection(const {
            'drive': {'state': 'driving', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
              'command': 'cd /w && claude --resume abc',
            },
          }),
        ),
      );
      await tester.pumpAndSettle();

      await openStatusSheet(tester);

      expect(
        find.byKey(const Key('session-detail-status-sheet')),
        findsOneWidget,
      );
      expect(find.text('cd /w && claude --resume abc'), findsOneWidget);
      expect(
        find.byKey(const Key('session-detail-status-copy-command')),
        findsOneWidget,
      );
    });

    testWidgets(
      'terminal status matrix: shared presence',
      (tester) async {
        await expectTerminalStatusCase(
          tester: tester,
          presence: 'shared',
          status: null,
          hasCommand: false,
          action: 'join',
          expectHandoff: false,
          optionalBeforeSheet: false,
        );
      },
    );

    testWidgets(
      'terminal status matrix: app+absent shows terminal-sync choice only in '
      'Status',
      (tester) async {
        await expectTerminalStatusCase(
          tester: tester,
          presence: 'absent',
          status: null,
          hasCommand: true,
          action: 'join',
          launchSurface: 'app',
          expectHandoff: false,
          optionalBeforeSheet: true,
        );
      },
    );

    testWidgets(
      'terminal status matrix: private join uses terminal-sync choice',
      (tester) async {
        await expectTerminalStatusCase(
          tester: tester,
          presence: 'private',
          status: null,
          hasCommand: true,
          action: 'join',
          expectHandoff: false,
          optionalBeforeSheet: false,
        );
      },
    );

    testWidgets(
      'terminal status matrix: private behind join uses terminal-sync choice',
      (tester) async {
        await expectTerminalStatusCase(
          tester: tester,
          presence: 'private',
          status: null,
          hasCommand: true,
          action: 'join',
          behind: true,
          expectHandoff: false,
          optionalBeforeSheet: false,
        );
      },
    );

    testWidgets(
      'terminal status matrix: unknown triggers handoff command',
      (tester) async {
        await expectTerminalStatusCase(
          tester: tester,
          presence: 'unknown',
          status: null,
          hasCommand: true,
          action: 'handoff',
          label: 'Resume in terminal',
          expectHandoff: true,
          optionalBeforeSheet: false,
        );
      },
    );

    testWidgets('Send later schedules the composer text once and clears it', (
      tester,
    ) async {
      final client = FakeBrokerClient();
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          brokerClient: client,
          connection: controlConnection(const {
            'drive': {'state': 'driving', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          }),
        ),
      );
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('session-detail-prompt-input')),
        'Continue this tonight',
      );
      await showSessionStatusTestItem(
        tester,
        const Key('session-detail-send-later'),
      );
      final sendLater = tester.widget<ListTile>(
        find.byKey(const Key('session-detail-send-later')),
      );
      expect(sendLater.enabled, isTrue);
      sendLater.onTap!();
      await tester.pumpAndSettle();
      expect(find.text('Schedule message'), findsOneWidget);

      await tester.tap(find.byKey(const Key('schedule-message-submit')));
      await tester.pumpAndSettle();
      await openSessionDetailTestTab(tester, 'session-detail-tab-chat');

      final request = client.scheduleRequests.single;
      expect(request, isA<MessageScheduleCreate>());
      expect(request.text, 'Continue this tonight');
      expect(
        find.byKey(const Key('schedule-inline-card-scheduled-1')),
        findsOneWidget,
      );
      expect(find.text('Continue this tonight'), findsOneWidget);
      expect(
        find.byKey(const Key('schedule-inline-state-scheduled-1')),
        findsOneWidget,
      );
      expect(find.text('Scheduled'), findsOneWidget);
      expect(
        tester
            .widget<TextField>(
              find.byKey(const Key('session-detail-prompt-input')),
            )
            .controller!
            .text,
        isEmpty,
      );
    });

    Future<void> openSheetAndTakeOver(WidgetTester tester) async {
      await openStatusSheet(tester);
      await tester.tap(
        find.byKey(const Key('session-detail-take-over-button')),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('composer Take over reuses confirmation and keeps its draft', (
      tester,
    ) async {
      final connection = controlConnection(const {
        'drive': {'state': 'observing', 'supported': true},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      });
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.enterText(input, 'Draft survives ownership change');

      final takeOver = find.byKey(
        const Key('session-detail-composer-take-over-button'),
      );
      final takeOverFocus = Focus.of(
        tester.element(
          find.descendant(of: takeOver, matching: find.text('Take over')),
        ),
      )..requestFocus();
      await tester.pump();
      expect(takeOverFocus.hasFocus, isTrue);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('session-detail-take-over-dialog')),
        findsOneWidget,
      );
      await tester.tap(
        find.byKey(const Key('session-detail-take-over-confirm')),
      );
      await tester.pumpAndSettle();

      expect(connection.reattachModes, ['resume']);
      expect(connection.reattachReasons, ['takeover']);
      expect(
        tester.widget<TextField>(input).controller?.text,
        'Draft survives '
        'ownership change',
      );
    });

    testWidgets(
      'Observe bar stays usable in EN/ZH, light/dark and both widths',
      (tester) async {
        addTearDown(() {
          tester.view.resetPhysicalSize();
          tester.view.resetDevicePixelRatio();
        });
        final spec = themeSpecById(kDefaultThemeId);
        for (final locale in const [Locale('en'), Locale('zh')]) {
          for (final brightness in Brightness.values) {
            for (final width in const [360.0, 1000.0]) {
              tester.view
                ..physicalSize = Size(width, 760)
                ..devicePixelRatio = 1;
              await tester.pumpWidget(
                buildSessionDetailTestPage(
                  events: const [],
                  connection: controlConnection(const {
                    'drive': {'state': 'observing', 'supported': true},
                    'terminalSync': {
                      'supported': false,
                      'syncAvailable': false,
                      'active': false,
                    },
                  }),
                  locale: locale,
                  theme: buildAppTheme(
                    brightness == Brightness.dark ? spec.dark : spec.light,
                    brightness,
                  ),
                ),
              );
              await tester.pumpAndSettle();

              final bar = find.byKey(
                const Key('session-detail-observe-composer-bar'),
              );
              expect(tester.getSize(bar).height, 40);
              expect(
                find.byKey(
                  const Key('session-detail-composer-take-over-button'),
                ),
                findsOneWidget,
              );
              expect(
                find.byKey(const Key('session-detail-send-button')),
                findsNothing,
              );
              final field = tester.widget<TextField>(
                find.byKey(const Key('session-detail-prompt-input')),
              );
              expect(
                field.decoration?.hintText,
                locale.languageCode == 'zh' ? '暂存提示' : 'Draft a prompt',
              );
              expect(tester.takeException(), isNull);
            }
          }
        }
      },
    );

    testWidgets('compact Observe bar goldens cover EN light and ZH dark', (
      tester,
    ) async {
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });
      tester.view
        ..physicalSize = const Size(420, 900)
        ..devicePixelRatio = 1;
      final spec = themeSpecById(kDefaultThemeId);
      for (final variant in [
        (
          locale: const Locale('en'),
          brightness: Brightness.light,
          tokens: spec.light,
          file: 'goldens/observe_composer_compact_light_en.png',
        ),
        (
          locale: const Locale('zh'),
          brightness: Brightness.dark,
          tokens: spec.dark,
          file: 'goldens/observe_composer_compact_dark_zh.png',
        ),
      ]) {
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: controlConnection(const {
              'drive': {'state': 'observing', 'supported': true},
              'terminalSync': {
                'supported': false,
                'syncAvailable': false,
                'active': false,
              },
            }),
            locale: variant.locale,
            theme: buildAppTheme(variant.tokens, variant.brightness),
          ),
        );
        await tester.pumpAndSettle();
        await expectLater(
          find.byKey(const Key('session-detail-observe-composer-bar')),
          matchesGoldenFile(variant.file),
        );
      }
    });

    testWidgets('observing offers Take over → confirm → drives (resume)', (
      tester,
    ) async {
      final connection = controlConnection(const {
        'drive': {'state': 'observing', 'supported': true},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      });
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      await openSheetAndTakeOver(tester);

      expect(
        find.byKey(const Key('session-detail-take-over-dialog')),
        findsOneWidget,
      );

      await tester.tap(
        find.byKey(const Key('session-detail-take-over-confirm')),
      );
      await tester.pumpAndSettle();

      expect(connection.reattachModes, ['resume']);
    });

    testWidgets(
      'sync-available exposes independent terminal and Take over choices',
      (tester) async {
        // `syncAvailable` is a capability, not ownership: the pill may read
        // "Sync available" and Join may be the primary action, but Drive must
        // stay reachable — Join can never be the only path.
        const command = '  codex resume --remote sock thread  ';
        String? copiedText;
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          (call) async {
            if (call.method == 'Clipboard.setData') {
              copiedText =
                  (call.arguments as Map<Object?, Object?>)['text'] as String?;
            }
            return null;
          },
        );
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            SystemChannels.platform,
            null,
          ),
        );
        final connection = controlConnection(const {
          'drive': {'state': 'observing', 'supported': true},
          'terminalSync': {
            'supported': true,
            'syncAvailable': true,
            'active': false,
            'action': 'join',
            'command': command,
          },
        });
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(const Key('session-detail-observe-composer-bar')),
          findsOneWidget,
        );
        expect(
          find.byKey(
            const Key('session-detail-composer-copy-sync-command'),
          ),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('session-detail-composer-take-over-button')),
          findsOneWidget,
        );
        expect(find.text(command), findsNothing);
        expect(
          find.byKey(const Key('session-detail-send-button')),
          findsNothing,
        );
        await tester.tap(
          find.byKey(
            const Key('session-detail-composer-copy-sync-command'),
          ),
        );
        await tester.pumpAndSettle();

        expect(copiedText, command);
        expect(connection.reattachModes, isEmpty);
        expect(
          find.text(
            'Command copied. Run it in a terminal to sync both sides.',
          ),
          findsOneWidget,
        );

        await openSessionDetailTestTab(tester, 'session-detail-tab-status');
        expect(
          find.byKey(
            const Key(
              'session-detail-status-control-pill-syncAvailable',
            ),
          ),
          findsOneWidget,
        );
        expect(
          find.text('Session control'),
          findsOneWidget,
        );
        expect(
          find.text(
            'No terminal is currently synced. Choose how to continue.',
          ),
          findsOneWidget,
        );
        expect(find.text('Sync with a terminal'), findsOneWidget);
        expect(
          find.text(
            'Run this command in a terminal. Once synced, you can send from '
            'either the terminal or Cosyncing.',
          ),
          findsOneWidget,
        );
        expect(find.text(command), findsOneWidget);
        expect(find.text('Continue in Cosyncing'), findsOneWidget);
        expect(
          find.text(
            'Take over to send from Cosyncing without syncing a terminal.',
          ),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('session-detail-take-over-button')),
          findsOneWidget,
        );

        await tester.tap(
          find.byKey(const Key('session-detail-take-over-button')),
        );
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(const Key('session-detail-take-over-confirm')),
        );
        await tester.pumpAndSettle();

        expect(connection.reattachModes, ['resume']);
        expect(connection.reattachReasons, ['takeover']);
      },
    );

    testWidgets('terminal-command-only state shows only the sync choice', (
      tester,
    ) async {
      final connection = controlConnection(const {
        'drive': {'state': 'unavailable', 'supported': false},
        'terminalSync': {
          'supported': true,
          'syncAvailable': true,
          'active': false,
          'action': 'join',
          'command': 'codex resume --remote only-command',
        },
      });
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-detail-composer-copy-sync-command')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-detail-composer-take-over-button')),
        findsNothing,
      );

      await openStatusSheet(tester);
      expect(find.text('Sync with a terminal'), findsOneWidget);
      expect(find.text('Continue in Cosyncing'), findsNothing);
      expect(
        find.byKey(const Key('session-detail-take-over-button')),
        findsNothing,
      );
    });

    testWidgets('join with no usable command falls back to Take over only', (
      tester,
    ) async {
      final connection = controlConnection(const {
        'drive': {'state': 'observing', 'supported': true},
        'terminalSync': {
          'supported': true,
          'syncAvailable': true,
          'active': false,
          'action': 'join',
          'command': '   ',
        },
      });
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-detail-composer-copy-sync-command')),
        findsNothing,
      );
      expect(
        find.text(
          'The terminal owns input right now. Take over to send from the app.',
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-detail-composer-take-over-button')),
        findsOneWidget,
      );

      await openStatusSheet(tester);
      expect(find.text('Sync with a terminal'), findsNothing);
      expect(find.text('Continue in Cosyncing'), findsOneWidget);
      expect(
        find.text(
          'Take over to send from Cosyncing without syncing a terminal.',
        ),
        findsOneWidget,
      );
    });

    testWidgets('join with neither path shows the unavailable explanation', (
      tester,
    ) async {
      for (final command in <String?>[null, '', '   ']) {
        final connection = controlConnection({
          'drive': {'state': 'unavailable', 'supported': false},
          'terminalSync': {
            'supported': true,
            'syncAvailable': true,
            'active': false,
            'action': 'join',
            if (command != null) 'command': command,
          },
        });
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(const Key('session-detail-composer-copy-sync-command')),
          findsNothing,
        );
        expect(
          find.byKey(const Key('session-detail-composer-take-over-button')),
          findsNothing,
        );
        expect(
          find.text(
            'The app can neither take over nor sync this session. You can '
            'only observe it.',
          ),
          findsOneWidget,
        );

        await openStatusSheet(tester);
        expect(find.text('Sync with a terminal'), findsNothing);
        expect(find.text('Continue in Cosyncing'), findsNothing);
        expect(
          find.text(
            'The app can neither take over nor sync this session. You can '
            'only observe it.',
          ),
          findsOneWidget,
        );
      }
    });

    // Regression: the app told the operator a takeable session was untakeable.
    //
    // A Kimi session this broker did not create publishes `supported: false`
    // with `state: observing` and an explicit `takeoverAvailable`. Every branch
    // of the precedence cascade fell through to Unavailable, so the header read
    // "Unavailable" and the status line read "The app can neither take over nor
    // sync this session" — beside a Take over button that worked.
    testWidgets('a foreign session that CAN be taken over reads as Observing', (
      tester,
    ) async {
      final connection = controlConnection(const {
        'drive': {
          'state': 'observing',
          'supported': false,
          'takeoverAvailable': true,
          'takeoverMode': 'live',
        },
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      });
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-detail-composer-take-over-button')),
        findsOneWidget,
      );
      expect(
        find.text(
          'The app can neither take over nor sync this session. You can '
          'only observe it.',
        ),
        findsNothing,
      );

      await openStatusSheet(tester);
      expect(
        find.byKey(
          const Key('session-detail-status-sheet-control-pill-observing'),
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(
          const Key('session-detail-status-sheet-control-pill-unavailable'),
        ),
        findsNothing,
      );
    });

    // The demoted half. `unavailable` is TRUE of that drive generation and the
    // pill goes on saying so — but a takeover opens a fresh generation and is
    // the only way back, so neither the control nor the copy may deny it.
    testWidgets('a demoted session offers take over instead of denying it', (
      tester,
    ) async {
      final connection = controlConnection(const {
        'drive': {
          'state': 'unavailable',
          'supported': false,
          'takeoverAvailable': true,
          'takeoverMode': 'live',
        },
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      });
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-detail-composer-take-over-button')),
        findsOneWidget,
      );
      expect(
        find.text(
          'The app can neither take over nor sync this session. You can '
          'only observe it.',
        ),
        findsNothing,
      );
      expect(
        find.text(
          'The app is not driving this session. Take over to continue it '
          'from the app.',
        ),
        findsWidgets,
      );
    });

    testWidgets('Take over pending disables the composer sync copy action', (
      tester,
    ) async {
      final connection = controlConnection(const {
        'drive': {'state': 'observing', 'supported': true},
        'terminalSync': {
          'supported': true,
          'syncAvailable': true,
          'active': false,
          'action': 'join',
          'command': 'codex resume --remote pending',
        },
      });
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(const Key('session-detail-composer-take-over-button')),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-detail-take-over-dialog')),
        findsOneWidget,
      );
      final copy = find.byKey(
        const Key('session-detail-composer-copy-sync-command'),
        skipOffstage: false,
      );
      expect(copy, findsOneWidget);
      expect(
        tester
            .widget<TextButton>(
              find.descendant(
                of: copy,
                matching: find.byType(TextButton),
                skipOffstage: false,
              ),
            )
            .onPressed,
        isNull,
      );

      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
    });

    testWidgets(
      'terminal-sync choices fit EN/ZH themes and responsive widths',
      (tester) async {
        final semantics = tester.ensureSemantics();
        addTearDown(() {
          tester.view.resetPhysicalSize();
          tester.view.resetDevicePixelRatio();
        });
        final spec = themeSpecById(kDefaultThemeId);
        for (final locale in const [Locale('en'), Locale('zh')]) {
          for (final brightness in Brightness.values) {
            for (final width in const [360.0, 420.0, 600.0, 1000.0]) {
              tester.view
                ..physicalSize = Size(width, 900)
                ..devicePixelRatio = 1;
              await tester.pumpWidget(
                buildSessionDetailTestPage(
                  events: const [],
                  connection: controlConnection(const {
                    'drive': {'state': 'observing', 'supported': true},
                    'terminalSync': {
                      'supported': true,
                      'syncAvailable': true,
                      'active': false,
                      'action': 'join',
                      'command': 'codex resume --remote responsive',
                    },
                  }),
                  locale: locale,
                  theme: buildAppTheme(
                    brightness == Brightness.dark ? spec.dark : spec.light,
                    brightness,
                  ),
                ),
              );
              await tester.pumpAndSettle();

              final bar = find.byKey(
                const Key('session-detail-observe-composer-bar'),
              );
              final barWidth = tester.getSize(bar).width;
              expect(tester.getSize(bar).height, 40);
              expect(
                find.byKey(
                  const Key('session-detail-composer-copy-sync-command'),
                ),
                findsOneWidget,
              );
              expect(
                find.byKey(
                  const Key('session-detail-composer-take-over-button'),
                ),
                findsOneWidget,
              );
              final explanation = locale.languageCode == 'zh'
                  ? barWidth >= 600
                        ? '终端尚未同步。要从 Cosyncing 发送：'
                        : '终端尚未同步：'
                  : barWidth >= 600
                  ? 'Terminal not synced. To send from Cosyncing:'
                  : 'Terminal not synced:';
              expect(find.text(explanation), findsOneWidget);
              expect(
                tester
                    .getSemantics(
                      find.byKey(
                        const Key(
                          'session-detail-composer-copy-sync-command',
                        ),
                      ),
                    )
                    .label,
                contains(
                  locale.languageCode == 'zh'
                      ? '复制终端同步命令'
                      : 'Copy terminal sync command',
                ),
              );
              if (barWidth <= kObserveComposerActionCollapseWidth) {
                expect(
                  tester.getSize(
                    find.byKey(
                      const Key(
                        'session-detail-composer-copy-sync-command',
                      ),
                    ),
                  ),
                  const Size.square(40),
                );
                expect(
                  find.text(locale.languageCode == 'zh' ? '接管' : 'Take over'),
                  findsOneWidget,
                );
              } else {
                expect(
                  find.text(
                    locale.languageCode == 'zh'
                        ? '复制同步命令'
                        : 'Copy sync command',
                  ),
                  findsOneWidget,
                );
              }
              expect(tester.takeException(), isNull);
            }
          }
        }
        semantics.dispose();
      },
    );

    testWidgets('terminal-sync choices grow to two rows at text scale 2', (
      tester,
    ) async {
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });
      for (final width in const [360.0, 420.0, 600.0, 1000.0]) {
        tester.view
          ..physicalSize = Size(width, 1000)
          ..devicePixelRatio = 1;
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: controlConnection(const {
              'drive': {'state': 'observing', 'supported': true},
              'terminalSync': {
                'supported': true,
                'syncAvailable': true,
                'active': false,
                'action': 'join',
                'command': 'codex resume --remote large-text',
              },
            }),
            textScale: 2,
          ),
        );
        await tester.pumpAndSettle();

        expect(
          tester
              .getSize(
                find.byKey(const Key('session-detail-observe-composer-bar')),
              )
              .height,
          greaterThanOrEqualTo(64),
        );
        expect(
          find.byKey(const Key('session-detail-composer-copy-sync-command')),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('session-detail-composer-take-over-button')),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
      }
    });

    testWidgets('willFork shows the fork confirm wording', (tester) async {
      final connection = controlConnection(const {
        'drive': {'state': 'observing', 'supported': true, 'willFork': true},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      });
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      await openSheetAndTakeOver(tester);

      expect(find.text('Take over — continue in a fork'), findsOneWidget);
      expect(find.text('Take over (fork)'), findsOneWidget);
    });

    testWidgets('cancelling the confirm does not drive', (tester) async {
      final connection = controlConnection(const {
        'drive': {'state': 'observing', 'supported': true},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      });
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      await openSheetAndTakeOver(tester);

      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();

      expect(connection.reattachModes, isEmpty);
    });

    testWidgets('"Don\'t warn me again" persists for routine takeovers', (
      tester,
    ) async {
      final prefs = InMemorySessionControlPreferencesStore();
      final connection = controlConnection(const {
        'drive': {'state': 'observing', 'supported': true},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      });
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          controlPreferencesStore: prefs,
        ),
      );
      await tester.pumpAndSettle();
      await openSheetAndTakeOver(tester);

      await tester.tap(
        find.byKey(const Key('session-detail-take-over-never-warn')),
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const Key('session-detail-take-over-confirm')),
      );
      await tester.pumpAndSettle();

      expect(prefs.suppressed, isTrue);
      expect(connection.reattachModes, ['resume']);
    });

    testWidgets('suppression skips a routine takeover confirm', (
      tester,
    ) async {
      final routinePrefs = InMemorySessionControlPreferencesStore()
        ..suppressed = true;
      final routineConnection = controlConnection(const {
        'drive': {'state': 'observing', 'supported': true},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      });
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: routineConnection,
          controlPreferencesStore: routinePrefs,
        ),
      );
      await tester.pumpAndSettle();
      await openSheetAndTakeOver(tester);

      expect(
        find.byKey(const Key('session-detail-take-over-dialog')),
        findsNothing,
      );
      expect(routineConnection.reattachModes, ['resume']);
    });

    testWidgets('suppression never skips a fork confirm', (tester) async {
      final forkPrefs = InMemorySessionControlPreferencesStore()
        ..suppressed = true;
      final forkConnection = controlConnection(const {
        'drive': {'state': 'observing', 'supported': true, 'willFork': true},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      });
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: forkConnection,
          controlPreferencesStore: forkPrefs,
        ),
      );
      await tester.pumpAndSettle();
      await openSheetAndTakeOver(tester);

      expect(
        find.byKey(const Key('session-detail-take-over-dialog')),
        findsOneWidget,
      );
      expect(find.text('Take over — continue in a fork'), findsOneWidget);
      expect(
        find.byKey(const Key('session-detail-take-over-never-warn')),
        findsNothing,
      );
      expect(forkConnection.reattachModes, isEmpty);
    });

    testWidgets('open sheet and dialog track live willFork changes', (
      tester,
    ) async {
      final connection = controlConnection(const {
        'drive': {'state': 'observing', 'supported': true},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      });
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      await openSheetAndTakeOver(tester);
      expect(find.text('Take over this session'), findsOneWidget);

      connection.emitSessionControl(const {
        'drive': {'state': 'observing', 'supported': true, 'willFork': true},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      });
      await tester.pumpAndSettle();

      expect(find.text('Take over — continue in a fork'), findsOneWidget);
      expect(find.text('Take over (fork)'), findsOneWidget);
    });

    testWidgets('Claude Observe hides its structurally unsafe resume command', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: controlConnection(const {
            'drive': {'state': 'observing', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
              'command': 'cd /w && claude --resume original',
            },
          }),
        ),
      );
      await tester.pumpAndSettle();
      await openStatusSheet(tester);

      expect(find.text('cd /w && claude --resume original'), findsNothing);
      expect(
        find.byKey(const Key('session-detail-status-copy-command')),
        findsNothing,
      );
    });

    testWidgets('sync command copy never demotes a sync-available session', (
      tester,
    ) async {
      final connection = controlConnection(const {
        'drive': {'state': 'observing', 'supported': true},
        'terminalSync': {
          'supported': true,
          'syncAvailable': true,
          'active': false,
          'command': 'codex resume --remote socket',
        },
      });
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      await openStatusSheet(tester);
      await tester.tap(
        find.byKey(const Key('session-detail-status-copy-command')),
      );
      await tester.pumpAndSettle();

      expect(connection.reattachModes, isEmpty);
    });

    testWidgets('driving without a command still offers hand back', (
      tester,
    ) async {
      final connection = controlConnection(const {
        'drive': {'state': 'driving', 'supported': true},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      });
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      await openStatusSheet(tester);
      await tester.tap(
        find.byKey(const Key('session-detail-hand-back-button')),
      );
      await tester.pumpAndSettle();

      expect(connection.reattachModes, isEmpty);
      expect(connection.sendHandoffCount, 1);
      expect(connection.disarmDriveAuthorityCount, 1);
    });

    testWidgets('failed clipboard write does not hand control back', (
      tester,
    ) async {
      final connection = controlConnection(const {
        'drive': {'state': 'driving', 'supported': true},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
          'command': 'claude --resume abc',
        },
      });
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            throw PlatformException(code: 'clipboard-unavailable');
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      await openStatusSheet(tester);
      await tester.tap(
        find.byKey(const Key('session-detail-status-copy-command')),
      );
      await tester.pumpAndSettle();

      expect(connection.reattachModes, isEmpty);
      expect(find.text("Couldn't copy the command."), findsOneWidget);
    });

    testWidgets('suppressed routine confirmations can be restored', (
      tester,
    ) async {
      final prefs = InMemorySessionControlPreferencesStore()..suppressed = true;
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: controlConnection(const {
            'drive': {'state': 'observing', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          }),
          controlPreferencesStore: prefs,
        ),
      );
      await tester.pumpAndSettle();
      await openStatusSheet(tester);
      await tester.tap(
        find.byKey(
          const Key('session-detail-restore-takeover-warnings'),
        ),
      );
      await tester.pumpAndSettle();

      expect(prefs.suppressed, isFalse);
    });

    testWidgets('driving: copying the resync command hands back (observe)', (
      tester,
    ) async {
      final connection = controlConnection(const {
        'drive': {'state': 'driving', 'supported': true},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
          'command': 'cd /w && claude --resume abc',
        },
      });
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (_) async => null,
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      await tester.pumpAndSettle();

      await openStatusSheet(tester);
      await tester.tap(
        find.byKey(const Key('session-detail-status-copy-command')),
      );
      await tester.pumpAndSettle();

      expect(connection.reattachModes, isEmpty);
      expect(connection.sendHandoffCount, 1);
      expect(connection.disarmDriveAuthorityCount, 1);
    });

    testWidgets('ownership actions disable while the stream reconnects', (
      tester,
    ) async {
      final connection = controlConnection(const {
        'drive': {'state': 'observing', 'supported': true},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      });
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      await openStatusSheet(tester);

      connection.emitState(SessionDetailConnectionStatus.reconnecting);
      await tester.pumpAndSettle();

      // R0b: the control footprint is the one place that states the session is
      // not currently vouched for. It no longer claims Observing, and no second
      // reconnect sentence is rendered beside it.
      expect(
        find.byKey(
          const Key('session-detail-status-sheet-control-pill-reconnecting'),
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-detail-status-offline-hint')),
        findsNothing,
      );
      expect(
        find.byKey(
          const Key('session-detail-status-sheet-control-pill-observing'),
        ),
        findsNothing,
      );
      expect(connection.reattachModes, isEmpty);
    });
  });
}
