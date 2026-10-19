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
        tester
            .widget<IconButton>(
              find.byKey(const Key('session-detail-send-button')),
            )
            .onPressed,
        isNull,
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
                tester
                    .widget<IconButton>(
                      find.byKey(const Key('session-detail-send-button')),
                    )
                    .onPressed,
                isNull,
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
        // Image decoding runs outside the fake test clock; await the asset
        // before comparing the complete session surface.
        await tester.runAsync(
          () => precacheImage(
            const AssetImage('assets/agents/claude.png'),
            tester.element(find.byType(Scaffold).first),
          ),
        );
        await tester.pumpAndSettle();
        await expectLater(
          find.byKey(const Key('session-detail-observe-composer-bar')),
          matchesGoldenFile(variant.file),
        );
      }
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

    testWidgets('terminal-attached takeover uses the routine confirm wording', (
      tester,
    ) async {
      // Issue 15a (demote, never fork): the fork confirm is gone. The
      // adapter's terminal-attached warning travels in drive.reason; the
      // confirm itself is the standard, suppressible one.
      final connection = controlConnection(const {
        'drive': {
          'state': 'observing',
          'supported': true,
          'reason': 'A terminal is attached to this session right now.',
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
      await openSheetAndTakeOver(tester);

      expect(find.text('Take over this session'), findsOneWidget);
      expect(find.text('Take over — continue in a fork'), findsNothing);
      expect(
        find.byKey(const Key('session-detail-take-over-never-warn')),
        findsOneWidget,
      );
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

    testWidgets('open dialog tracks a live control change', (tester) async {
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

      // Ownership changes while the confirm is open → the dialog re-derives
      // live and refuses the stale action instead of confirming blind.
      connection.emitSessionControl(const {
        'drive': {'state': 'unavailable', 'supported': false},
        'terminalSync': {
          'supported': false,
          'syncAvailable': false,
          'active': false,
        },
      });
      await tester.pumpAndSettle();

      expect(find.text('Session control changed'), findsOneWidget);
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
