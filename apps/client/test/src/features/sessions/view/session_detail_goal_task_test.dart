// Behavior files retain a common import set to keep split diffs mechanical.
// ignore_for_file: unused_import, unnecessary_import

import 'dart:async';
import 'dart:ui' show PointerDeviceKind;

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/components/selectable_tap_region.dart';
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
  group('SessionDetailPage keyed goal and task state', () {
    SessionWireEvent mutableSession() => SessionWireEvent(
      info: SessionInfo.fromJson({
        'id': 'session-1',
        'tool': 'codex',
        'title': 'Launch work',
        'status': 'working',
        'attachMode': 'resume',
        'control': const {
          'drive': {'state': 'driving', 'supported': true},
          'terminalSync': {
            'supported': false,
            'syncAvailable': false,
            'active': false,
          },
          'input': 'full',
        },
      }),
    );

    testWidgets(
      'upserts state panels and keeps them out of transcript bubbles',
      (
        tester,
      ) async {
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [
              mutableSession(),
              const CommandsWireEvent(
                commands: [
                  SlashCommand(
                    name: 'goal',
                    kind: SlashCommandKind.action,
                  ),
                ],
              ),
              MessageWireEvent(
                seq: 1,
                message: AgentMessage.fromJson({
                  'type': 'goal-state',
                  'key': 'current',
                  'status': 'active',
                  'title': 'Obsolete objective',
                }),
              ),
              MessageWireEvent(
                seq: 2,
                message: AgentMessage.fromJson({
                  'type': 'goal-state',
                  'key': 'current',
                  'status': 'paused',
                  'title': 'Current objective',
                  'elapsedMs': 42000,
                }),
              ),
              MessageWireEvent(
                seq: 3,
                message: AgentMessage.fromJson({
                  'type': 'task-list-state',
                  'key': 'plan',
                  'status': 'running',
                  'title': 'Launch checklist',
                  'items': [
                    {'title': 'Old task', 'status': 'open'},
                  ],
                }),
              ),
              MessageWireEvent(
                seq: 4,
                message: AgentMessage.fromJson({
                  'type': 'task-list-state',
                  'key': 'plan',
                  'status': 'done',
                  'title': 'Launch checklist',
                  'items': [
                    {'title': 'Current task', 'status': 'done'},
                  ],
                }),
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(const Key('session-live-state-surface')),
          findsOneWidget,
        );
        expect(
          find.byKey(
            const ValueKey('session-live-strip-goal:current'),
          ),
          findsOneWidget,
        );
        expect(find.text('Obsolete objective'), findsNothing);
        expect(
          find.byKey(
            const ValueKey('session-live-strip-task-list:plan'),
          ),
          findsNothing,
        );
        expect(find.text('+1'), findsOneWidget);
        expect(find.text('Goal state'), findsNothing);
        expect(find.text('Task list state'), findsNothing);

        await tester.tap(
          find.byKey(
            const ValueKey('session-live-strip-goal:current'),
          ),
        );
        await tester.pumpAndSettle();
        expect(
          find.ancestor(
            of: find.text('Current objective'),
            matching: find.byType(SelectionArea),
          ),
          findsOneWidget,
        );
        expect(
          find.ancestor(
            of: find.text('Launch checklist'),
            matching: find.byType(SelectionArea),
          ),
          findsOneWidget,
        );
        final taskExpansion = find.byKey(
          const Key('session-task-list-expansion'),
        );
        expect(taskExpansion, findsOneWidget);
        await tester.ensureVisible(find.text('Launch checklist'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Launch checklist'));
        await tester.pumpAndSettle();
        expect(find.text('Current task'), findsOneWidget);
        expect(
          find.ancestor(
            of: find.text('Current task'),
            matching: find.byType(SelectionArea),
          ),
          findsOneWidget,
        );
        // The card composes its own region: SelectableTapRegion stopped
        // creating one, and this card sits outside the transcript with no
        // shared region to join, so it wraps its own header.
        expect(
          find.descendant(
            of: taskExpansion,
            matching: find.descendant(
              of: find.byType(SelectionArea),
              matching: find.byType(SelectableTapRegion),
            ),
          ),
          findsOneWidget,
          reason:
              'the task card header must be a tap region inside its own '
              'selection region',
        );
        // And the header toggle fires exactly ONCE per tap. A second handler —
        // the state this card is one `onTap` away from — toggles twice and
        // leaves the card exactly where it was, which an expand-only assertion
        // cannot see. Collapsing and reopening is what makes it visible.
        await tester.tap(find.text('Launch checklist'));
        await tester.pumpAndSettle();
        expect(
          find.text('Current task'),
          findsNothing,
          reason: 'one tap must collapse the card, not toggle it twice',
        );
        await tester.tap(find.text('Launch checklist'));
        await tester.pumpAndSettle();
        expect(find.text('Current task'), findsOneWidget);
        expect(find.text('Old task'), findsNothing);
      },
    );

    testWidgets(
      'dispatches advertised goal actions and waits for broker state',
      (
        tester,
      ) async {
        final connection = ScriptedSessionDetailConnection(
          events: [
            mutableSession(),
            const CommandsWireEvent(
              commands: [
                SlashCommand(
                  name: 'goal',
                  kind: SlashCommandKind.action,
                ),
              ],
            ),
            MessageWireEvent(
              seq: 1,
              message: AgentMessage.fromJson({
                'type': 'goal-state',
                'status': 'active',
                'title': 'Finish launch work',
              }),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        final pauseButton = find.byKey(const Key('session-goal-pause'));
        tester.widget<OutlinedButton>(pauseButton).onPressed!();
        await tester.pump();

        expect(connection.sendCommandCount, 1);
        expect(connection.lastCommandName, 'goal');
        expect(connection.lastCommandArgs, const {'args': 'pause'});
        expect(
          find.byKey(const Key('session-goal-pause')),
          findsOneWidget,
          reason: 'incoming goal-state remains authoritative',
        );

        connection.emitEvent(
          MessageWireEvent(
            seq: 2,
            message: AgentMessage.fromJson({
              'type': 'goal-state',
              'status': 'paused',
              'title': 'Finish launch work',
            }),
          ),
        );
        await tester.pumpAndSettle();
        expect(
          find.byKey(const Key('session-goal-resume')),
          findsOneWidget,
        );
      },
    );

    testWidgets('goal controls fail closed without advertised action kind', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          mutableSession(),
          const CommandsWireEvent(
            commands: [SlashCommand(name: 'goal')],
          ),
          MessageWireEvent(
            seq: 1,
            message: AgentMessage.fromJson({
              'type': 'goal-state',
              'status': 'active',
              'title': 'Read-only capability proof',
            }),
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      final pause = tester.widget<OutlinedButton>(
        find.byKey(const Key('session-goal-pause')),
      );
      expect(pause.onPressed, isNull);
      expect(connection.sendCommandCount, 0);
    });

    testWidgets(
      'upserts running agent activity with wall clock and input tokens',
      (tester) async {
        final startedAt = DateTime.now().millisecondsSinceEpoch - 5000;
        final connection = ScriptedSessionDetailConnection(
          events: [
            mutableSession(),
            MessageWireEvent(
              seq: 1,
              message: AgentMessage.fromJson({
                'type': 'agent-activity',
                'key': 'agent:review',
                'kind': 'subagent',
                'title': 'Review notifications',
                'subtitle': 'reviewer',
                'status': 'running',
                'startedAtMs': startedAt,
                'elapsedMs': 5000,
                'tokens': {'input': 17500, 'output': 1200},
                'agentsDone': 0,
                'agentsTotal': 1,
              }),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(
            const ValueKey('session-live-strip-activity:agent:review'),
          ),
          findsOneWidget,
        );
        await tester.tap(
          find.byKey(
            const ValueKey('session-live-strip-activity:agent:review'),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.textContaining('17.5k tokens'), findsOneWidget);
        expect(find.textContaining('Background agent'), findsOneWidget);
        expect(find.text('Agent activity'), findsNothing);

        connection.emitEvent(
          MessageWireEvent(
            seq: 2,
            message: AgentMessage.fromJson({
              'type': 'agent-activity',
              'key': 'agent:review',
              'kind': 'subagent',
              'title': 'Review notifications',
              'status': 'done',
              'elapsedMs': 7000,
            }),
          ),
        );
        await tester.pumpAndSettle();
        expect(
          find.byKey(const Key('session-agent-activity-agent:review')),
          findsNothing,
        );
      },
    );
  });
}
