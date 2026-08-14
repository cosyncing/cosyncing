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
  group('SessionDetailPage slash command picker', () {
    testWidgets('shows compact progress until broker completion signal', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: const [
          CommandsWireEvent(
            commands: [SlashCommand(name: '/compact')],
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      await openCommandPickerSheet(tester);

      await tester.tap(
        find.byKey(const Key('session-detail-command-picker')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('/compact'));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const Key('session-detail-command-send-button')),
      );
      await tester.pump();

      expect(
        find.byKey(
          const ValueKey('session-live-strip-command:compact'),
        ),
        findsOneWidget,
      );
      tester
          .widget<InkWell>(
            find.byKey(
              const ValueKey('session-live-strip-toggle-command:compact'),
            ),
          )
          .onTap!();
      await tester.pump(const Duration(milliseconds: 250));
      expect(
        find.byKey(const Key('session-command-progress-indicator')),
        findsOneWidget,
      );

      connection.emitEvent(
        const NoticeWireEvent(message: 'Compacting the conversation...'),
      );
      await tester.pump();
      expect(
        find.byKey(
          const ValueKey('session-live-strip-command:compact'),
        ),
        findsOneWidget,
      );

      connection.emitEvent(
        MessageWireEvent(
          seq: 1,
          message: AgentMessage.fromJson({
            'type': 'history-reset',
            'notice': 'Compacted the conversation.',
          }),
        ),
      );
      await tester.pump();
      expect(
        find.byKey(
          const ValueKey('session-live-strip-command:compact'),
        ),
        findsNothing,
      );
    });

    testWidgets(
      'disables command picker when disconnected',
      (tester) async {
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            initialState: const SessionDetailState(
              tool: 'claude',
              sessionId: 'session-1',
              bootstrapState: SessionDetailBootstrapState(
                readiness: SessionDetailBootstrapReadiness.ready,
                attempt: 1,
              ),
              events: [
                CommandsWireEvent(
                  commands: [SlashCommand(name: '/help')],
                ),
              ],
            ),
          ),
        );
        await tester.pumpAndSettle();
        await openCommandPickerSheet(tester);

        final picker = tester.widget<DropdownButtonFormField<String>>(
          find.byKey(const Key('session-detail-command-picker')),
        );
        expect(picker.onChanged, isNull);

        final commandSendButton = tester.widget<IconButton>(
          find.byKey(const Key('session-detail-command-send-button')),
        );
        expect(commandSendButton.onPressed, isNull);
      },
    );

    testWidgets(
      'disables command picker when no commands are available',
      (tester) async {
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
          ),
        );
        await tester.pumpAndSettle();
        await openCommandPickerSheet(tester);

        final picker = tester.widget<DropdownButtonFormField<String>>(
          find.byKey(const Key('session-detail-command-picker')),
        );
        expect(picker.onChanged, isNull);
      },
    );

    testWidgets(
      'sends selected command with default args when set on the command',
      (tester) async {
        useRoomyTestViewport(tester);
        final connection = ScriptedSessionDetailConnection(
          events: const [
            CommandsWireEvent(
              commands: [
                SlashCommand(
                  name: '/files',
                  description: 'List available files',
                  usage: 'Usage: /files',
                  args: {'path': '/tmp'},
                ),
              ],
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();
        await openCommandPickerSheet(tester);

        await tester.tap(
          find.byKey(const Key('session-detail-command-picker')),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.text('/files'));
        await tester.pumpAndSettle();
        expect(find.text('List available files'), findsOneWidget);
        expect(find.text('Usage: /files'), findsOneWidget);
        expect(
          tester
              .widget<TextField>(
                find.byKey(const Key('session-detail-command-args-input')),
              )
              .controller
              ?.text,
          contains('"path": "/tmp"'),
        );
        await tester.tap(
          find.byKey(const Key('session-detail-command-send-button')),
        );
        await tester.pumpAndSettle();

        expect(connection.sendCommandCount, 1);
        expect(connection.lastCommandName, '/files');
        expect(connection.lastCommandArgs, {'path': '/tmp'});
      },
    );

    testWidgets('sends edited valid JSON args', (tester) async {
      useRoomyTestViewport(tester);
      final connection = ScriptedSessionDetailConnection(
        events: const [
          CommandsWireEvent(
            commands: [
              SlashCommand(
                name: '/files',
                description: 'List available files',
                usage: 'Usage: /files',
                args: {'path': '/tmp'},
              ),
            ],
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      await openCommandPickerSheet(tester);

      await tester.tap(
        find.byKey(const Key('session-detail-command-picker')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('/files'));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('session-detail-command-args-input')),
        '{"path": "/home/user", "depth": 2}',
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(const Key('session-detail-command-send-button')),
      );
      await tester.pumpAndSettle();

      expect(connection.sendCommandCount, 1);
      expect(connection.lastCommandName, '/files');
      expect(
        connection.lastCommandArgs,
        const {'path': '/home/user', 'depth': 2},
      );
    });

    testWidgets('sends null when the command args editor is empty', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      final connection = ScriptedSessionDetailConnection(
        events: const [
          CommandsWireEvent(
            commands: [
              SlashCommand(
                name: '/files',
                description: 'List available files',
                usage: 'Usage: /files',
                args: {'path': '/tmp'},
              ),
            ],
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      await openCommandPickerSheet(tester);

      await tester.tap(
        find.byKey(const Key('session-detail-command-picker')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('/files'));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('session-detail-command-args-input')),
        '',
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(const Key('session-detail-command-send-button')),
      );
      await tester.pumpAndSettle();

      expect(connection.sendCommandCount, 1);
      expect(connection.lastCommandName, '/files');
      expect(connection.lastCommandArgs, isNull);
    });

    testWidgets('blocks send and validates invalid command args JSON', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: const [
          CommandsWireEvent(
            commands: [
              SlashCommand(name: '/files', args: {'path': '/tmp'}),
            ],
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      await openCommandPickerSheet(tester);

      await tester.tap(
        find.byKey(const Key('session-detail-command-picker')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('/files'));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('session-detail-command-args-input')),
        '{"path":',
      );
      await tester.pump();
      expect(find.text('Invalid JSON for command arguments.'), findsOneWidget);

      final sendButton = tester.widget<IconButton>(
        find.byKey(const Key('session-detail-command-send-button')),
      );
      expect(sendButton.onPressed, isNull);
      await tester.tap(
        find.byKey(const Key('session-detail-command-send-button')),
      );
      expect(connection.sendCommandCount, 0);
    });

    testWidgets('rejects non-object JSON as command args', (tester) async {
      final connection = ScriptedSessionDetailConnection(
        events: const [
          CommandsWireEvent(
            commands: [
              SlashCommand(name: '/files', args: {'path': '/tmp'}),
            ],
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      await openCommandPickerSheet(tester);

      await tester.tap(
        find.byKey(const Key('session-detail-command-picker')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('/files'));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('session-detail-command-args-input')),
        '["a", "b"]',
      );
      await tester.pump();

      expect(
        find.text('Command arguments must be a JSON object.'),
        findsOneWidget,
      );

      final sendButton = tester.widget<IconButton>(
        find.byKey(const Key('session-detail-command-send-button')),
      );
      expect(sendButton.onPressed, isNull);
      await tester.tap(
        find.byKey(const Key('session-detail-command-send-button')),
      );
      expect(connection.sendCommandCount, 0);
    });

    testWidgets('resets args editor when selecting a different command', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: const [
          CommandsWireEvent(
            commands: [
              SlashCommand(
                name: '/files',
                description: 'List available files',
                args: {'path': '/tmp', 'limit': 5},
              ),
              SlashCommand(
                name: '/status',
                description: 'Session status',
                args: {'verbose': true},
              ),
            ],
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      await openCommandPickerSheet(tester);

      await tester.tap(
        find.byKey(const Key('session-detail-command-picker')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('/files'));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('session-detail-command-args-input')),
        '{"path": "/custom"}',
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(const Key('session-detail-command-picker')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('/status'));
      await tester.pumpAndSettle();

      expect(
        tester
            .widget<TextField>(
              find.byKey(const Key('session-detail-command-args-input')),
            )
            .controller
            ?.text,
        allOf(
          isNot(contains('/custom')),
          contains('verbose'),
        ),
      );
    });
  });
}
