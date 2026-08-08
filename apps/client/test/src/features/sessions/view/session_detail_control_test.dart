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
import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:cosyncing_client/src/features/sessions/data/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_command_args_codec.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/view/session_artifact_preview_result.dart';
import 'package:cosyncing_client/src/features/sessions/view/session_detail_page.dart';
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
      required String status,
      required bool hasCommand,
      required String action,
      required bool optionalBeforeSheet,
      required bool expectReattachNull,
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
      expect(find.text('Terminal (optional)'), findsOneWidget);
      expect(find.text(status), findsOneWidget);
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
        expect(connection.reattachModes, expectReattachNull ? [null] : isEmpty);
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
    // redundant full-width banner remains absent because the header already
    // carries the state; states the pill cannot express still get the banner.
    testWidgets('observing keeps local editing without restating the status '
        'pill', (
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
        find.byKey(const Key('session-detail-composer-blocked-hint')),
        findsNothing,
        reason: 'the header status pill already says Observing',
      );
      // The state itself must still be on screen — this de-duplicates, it does
      // not drop information.
      expect(find.text('Observing'), findsWidgets);
      final promptInput = tester.widget<TextField>(
        find.byKey(const Key('session-detail-prompt-input')),
      );
      expect(promptInput.enabled, isTrue);
    });

    testWidgets('answer-only sync keeps the pill Synced but blocks the '
        'composer', (tester) async {
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
        find.byKey(const Key('session-detail-composer-blocked-hint')),
        findsOneWidget,
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
          status: 'Terminal connected and synced.',
          hasCommand: false,
          action: 'join',
          expectReattachNull: false,
          optionalBeforeSheet: false,
        );
      },
    );

    testWidgets(
      'terminal status matrix: app+absent shows optional join and no command '
      'before sheet',
      (tester) async {
        await expectTerminalStatusCase(
          tester: tester,
          presence: 'absent',
          status: 'Driving in the app. No terminal is open or behind.',
          hasCommand: true,
          action: 'join',
          launchSurface: 'app',
          label: 'Open in terminal (optional)',
          expectReattachNull: false,
          optionalBeforeSheet: true,
        );
      },
    );

    testWidgets(
      'terminal status matrix: private without behind',
      (tester) async {
        await expectTerminalStatusCase(
          tester: tester,
          presence: 'private',
          status: 'This terminal needs a restart to join cosyncing.',
          hasCommand: true,
          action: 'join',
          label: 'Open in terminal (optional)',
          expectReattachNull: false,
          optionalBeforeSheet: false,
        );
      },
    );

    testWidgets(
      'terminal status matrix: private behind',
      (tester) async {
        await expectTerminalStatusCase(
          tester: tester,
          presence: 'private',
          status: 'This terminal is behind. Restart or resume it to rejoin.',
          hasCommand: true,
          action: 'join',
          behind: true,
          label: 'Open in terminal (optional)',
          expectReattachNull: false,
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
          status: 'The terminal connection could not be confirmed.',
          hasCommand: true,
          action: 'handoff',
          label: 'Resume in terminal',
          expectReattachNull: true,
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
      'observing with sync merely available still offers Take over (CR1)',
      (tester) async {
        // `syncAvailable` is a capability, not ownership: the pill may read
        // "Sync available" and Join may be the primary action, but Drive must
        // stay reachable — Join can never be the only path.
        final connection = controlConnection(const {
          'drive': {'state': 'observing', 'supported': true},
          'terminalSync': {
            'supported': true,
            'syncAvailable': true,
            'active': false,
            'action': 'join',
            'command': 'codex resume --remote sock thread',
          },
        });
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

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

      expect(connection.reattachModes, [null]);
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

      expect(connection.reattachModes, [null]);
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
