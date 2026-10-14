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
        // The strip counts the band by phase instead of a bare "+1": the
        // paused goal fronts it, and the finished list is the one done.
        expect(
          find.byKey(const Key('session-live-strip-count-paused')),
          findsOneWidget,
        );
        expect(find.text('1 paused'), findsOneWidget);
        expect(find.text('1 done'), findsOneWidget);
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
        // The finished checklist is an outcome, so it folds behind the
        // Finished header while the goal is still live.
        expect(find.text('Launch checklist'), findsNothing);
        final finishedToggle = find.byKey(
          const Key('session-live-state-finished-toggle'),
        );
        await tester.ensureVisible(finishedToggle);
        await tester.pumpAndSettle();
        await tester.tap(finishedToggle);
        await tester.pumpAndSettle();
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
  });

  // P3c. The projection chain used to open with the idle sweep as the FIRST
  // branch of an if/else, so any frame carrying an idle status skipped the
  // whole type dispatch behind it.
  group('SessionLiveState idle sweep', () {
    AgentMessage message(Map<String, Object?> json) =>
        AgentMessage.fromJson(json);

    test('an idle status frame clears activities and keeps task lists', () {
      final state = SessionLiveState.fromMessages([
        message(const {
          'type': 'agent-activity',
          'key': 'agent:one',
          'title': 'Explore',
          'status': 'running',
        }),
        message(const {
          'type': 'task-list-state',
          'key': 'plan',
          'status': 'running',
          'items': [
            {'title': 'Ship it', 'status': 'open'},
          ],
        }),
        message(const {'type': 'status', 'status': 'idle'}),
      ]);

      expect(state.activities, isEmpty);
      expect(state.taskLists.single.key, 'plan');
    });

    test('a task-list frame is dispatched and never sweeps activities', () {
      // `task-list-state` carries its own `status` field. The sweep is gated on
      // the frame TYPE so that field can never be read as a turn boundary, and
      // it no longer stands in front of the type dispatch.
      final state = SessionLiveState.fromMessages([
        message(const {
          'type': 'agent-activity',
          'key': 'agent:one',
          'title': 'Explore',
          'status': 'running',
        }),
        message(const {
          'type': 'task-list-state',
          'key': 'plan',
          'status': 'running',
          'items': [
            {'title': 'Ship it', 'status': 'open'},
          ],
        }),
      ]);

      expect(state.taskLists.single.key, 'plan');
      expect(state.activities.single.key, 'agent:one');
    });

    test('an idle status frame never sweeps a running background command', () {
      // A background command outlives the turn that launched it -- that is the
      // whole reason it is surfaced. The turn boundary says nothing about
      // whether the process is still running, so sweeping it here would retire
      // the card at the exact moment it becomes the only sign of live work.
      final state = SessionLiveState.fromMessages([
        message(const {
          'type': 'agent-activity',
          'key': 'cmd:toolu_1',
          'kind': 'command',
          'title': 'Build the bundle',
          'status': 'running',
        }),
        message(const {
          'type': 'agent-activity',
          'key': 'agent:one',
          'kind': 'subagent',
          'title': 'Explore',
          'status': 'running',
        }),
        message(const {'type': 'status', 'status': 'idle'}),
      ]);

      // The subagent IS still swept: it is work inside the turn that
      // just ended.
      expect(state.activities.single.key, 'cmd:toolu_1');
      expect(state.activities.single.kind, AgentActivityKind.command);
    });

    test('a command card is retired by its own terminal frame', () {
      final state = SessionLiveState.fromMessages([
        message(const {
          'type': 'agent-activity',
          'key': 'cmd:toolu_1',
          'kind': 'command',
          'title': 'Build the bundle',
          'status': 'running',
        }),
        message(const {
          'type': 'agent-activity',
          'key': 'cmd:toolu_1',
          'kind': 'command',
          'title': 'Build the bundle',
          'status': 'error',
          'exitCode': 1,
        }),
        message(const {'type': 'status', 'status': 'idle'}),
      ]);

      // Terminal, so it survives the sweep for a different reason: it is no
      // longer running. It stays until the reader archives it, carrying how the
      // command ended -- which is the fact the card exists to deliver.
      expect(state.activities.single.status, AgentActivityStatus.error);
      expect(state.activities.single.exitCode, 1);
    });

    test('a retired frame withdraws a command card the server gave up on', () {
      // Every activity frame is an upsert, and a command is exempt from the
      // idle sweep, so nothing else can take this card off screen. Without an
      // explicit withdrawal a command that went silent sits at Running for as
      // long as the client stays connected.
      final state = SessionLiveState.fromMessages([
        message(const {
          'type': 'agent-activity',
          'key': 'cmd:toolu_1',
          'kind': 'command',
          'title': 'Build the bundle',
          'status': 'running',
        }),
        message(const {
          'type': 'agent-activity',
          'key': 'cmd:toolu_1',
          'kind': 'command',
          'title': 'Build the bundle',
          'status': 'retired',
        }),
      ]);

      expect(state.activities, isEmpty);
    });

    test(
      'Codex reconnect removes forgotten running cards but keeps outcomes',
      () {
        final before = SessionLiveState.fromMessages([
          for (final entry in {
            'cmd:codex:old': 'running',
            'cmd:codex:current': 'running',
            'cmd:codex:failed': 'error',
            'cmd:claude:other': 'running',
          }.entries)
            message({
              'type': 'agent-activity',
              'key': entry.key,
              'kind': 'command',
              'title': 'Build',
              'status': entry.value,
            }),
        ]);
        final snapshot = message(const {
          'type': 'event',
          'name': 'codex.background-running-snapshot',
          'payload': {
            'keys': ['cmd:codex:current'],
          },
        });
        expect(isSessionLiveStateMessage(snapshot), isTrue);
        final after = before.applyMessage(snapshot);
        expect(after.activities.map((a) => a.key), [
          'cmd:codex:current',
          'cmd:codex:failed',
          'cmd:claude:other',
        ]);
        for (final keys in [
          null,
          ['cmd:claude:other'],
          [42],
        ]) {
          final invalid = message({
            'type': 'event',
            'name': 'codex.background-running-snapshot',
            'payload': {'keys': keys},
          });
          expect(before.applyMessage(invalid).activities.length, 4);
        }
        final restarted = after.applyMessage(
          message(const {
            'type': 'event',
            'name': 'codex.background-running-snapshot',
            'payload': {'keys': <String>[]},
          }),
        );
        expect(restarted.activities.map((a) => a.key), [
          'cmd:codex:failed',
          'cmd:claude:other',
        ]);
      },
    );

    test('an unrecognized future status also withdraws the card', () {
      // A client that predates `retired` must still drop the row rather than
      // keep a card the server has stopped vouching for.
      final state = SessionLiveState.fromMessages([
        message(const {
          'type': 'agent-activity',
          'key': 'cmd:toolu_1',
          'kind': 'command',
          'title': 'Build the bundle',
          'status': 'running',
        }),
        message(const {
          'type': 'agent-activity',
          'key': 'cmd:toolu_1',
          'kind': 'command',
          'title': 'Build the bundle',
          'status': 'a-status-from-the-future',
        }),
      ]);

      expect(state.activities, isEmpty);
    });
  });
}
