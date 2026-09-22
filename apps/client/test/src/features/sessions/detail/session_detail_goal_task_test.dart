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

    testWidgets('expanded task rows render at the transcript body scale', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            mutableSession(),
            MessageWireEvent(
              seq: 1,
              message: AgentMessage.fromJson({
                'type': 'task-list-state',
                'key': 'plan',
                'status': 'running',
                'title': 'Launch checklist',
                'items': [
                  {
                    'title': 'Current task',
                    'status': 'in-progress',
                    'detail': 'Halfway there',
                    'priority': 'high',
                  },
                ],
              }),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(const ValueKey('session-live-strip-task-list:plan')),
      );
      await tester.pumpAndSettle();

      final row = find.byKey(const Key('session-task-item-0'));
      expect(row, findsOneWidget);
      final tile = tester.widget<ListTile>(row);
      expect(tile.dense, isNot(true));

      // P3a. The 2026-08-19 change answered a request for a taller panel with
      // headline text and a 40px icon; the rows now match their transcript
      // siblings and the height comes from the panel's own cap.
      final icon = tester.widget<Icon>(
        find.descendant(of: row, matching: find.byIcon(Icons.pending_outlined)),
      );
      expect(icon.size, 20);

      final textTheme = Theme.of(tester.element(row)).textTheme;
      final title = tester.widget<Text>(
        find.descendant(of: row, matching: find.text('Current task')),
      );
      expect(title.style?.fontSize, textTheme.bodyLarge?.fontSize);
      final detail = tester.widget<Text>(
        find.descendant(of: row, matching: find.text('Halfway there')),
      );
      expect(detail.style?.fontSize, textTheme.bodyMedium?.fontSize);
    });

    // P3b. A finished list used to arm a 3-second auto-archive at initState,
    // re-armed on every update and never cancelled by expansion, so opening it
    // to read one row deleted it mid-read. The predicate also compared the
    // LOCALIZED status label, so it fired in English and never in Chinese.
    for (final locale in const [Locale('en'), Locale('zh')]) {
      testWidgets(
        'keeps a finished task list pinned in ${locale.languageCode}',
        (tester) async {
          await tester.pumpWidget(
            buildSessionDetailTestPage(
              locale: locale,
              events: [
                mutableSession(),
                MessageWireEvent(
                  seq: 1,
                  message: AgentMessage.fromJson({
                    'type': 'task-list-state',
                    'key': 'plan',
                    'status': 'done',
                    'title': 'Launch checklist',
                    'items': [
                      {'title': 'Ship it', 'status': 'done'},
                    ],
                  }),
                ),
              ],
            ),
          );
          await tester.pumpAndSettle();

          final strip = find.byKey(
            const ValueKey('session-live-strip-task-list:plan'),
          );
          expect(strip, findsOneWidget);

          await tester.pump(const Duration(seconds: 4));
          await tester.pumpAndSettle();
          expect(strip, findsOneWidget);

          await tester.tap(strip);
          await tester.pumpAndSettle();
          // A done list opens collapsed inside the card, so the reader has to
          // open it too — which is exactly when the timer used to fire.
          await tester.tap(
            find.byKey(const Key('session-task-list-expansion')),
          );
          await tester.pumpAndSettle();
          expect(find.text('Ship it'), findsOneWidget);

          await tester.pump(const Duration(seconds: 4));
          await tester.pumpAndSettle();
          expect(strip, findsOneWidget);
          expect(find.text('Ship it'), findsOneWidget);
        },
      );
    }

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
        // A terminal activity is NOT retired automatically: it stays until the
        // reader archives it, so the expanded card is still on screen. The key
        // is namespaced by the live-state item id ('activity:' + the broker
        // key), which is what this used to get wrong -- it asserted
        // findsNothing against a key no widget has ever carried, so it
        // passed vacuously.
        expect(
          find.byKey(
            const Key('session-agent-activity-activity:agent:review'),
          ),
          findsOneWidget,
        );
        expect(
          find.byKey(
            const ValueKey('session-live-strip-activity:agent:review'),
          ),
          findsOneWidget,
        );
        // Both surfaces report the status, and both report the SAME one. The
        // expanded card's pill used to be hardcoded to 'Running', so a finished
        // activity announced itself as still running and this expectation read
        // findsOneWidget only because one of the two was lying.
        expect(find.text('Done'), findsNWidgets(2));
        expect(find.text('Running'), findsNothing);
      },
    );

    testWidgets(
      'an archived background command comes back when it ends',
      (tester) async {
        // The adapter stamps the SAME startedAtMs on a command's running and
        // terminal frames, so the fixture must too. Leaving it off the terminal
        // frame made the archive identity differ on that field alone, and the
        // card re-surfaced whether or not the identity carried how the work
        // ended — the test passed with the running/ended component deleted.
        final startedAtMs = DateTime.now().millisecondsSinceEpoch - 5000;
        final connection = ScriptedSessionDetailConnection(
          events: [
            mutableSession(),
            MessageWireEvent(
              seq: 1,
              message: AgentMessage.fromJson({
                'type': 'agent-activity',
                'key': 'cmd:toolu_1',
                'kind': 'command',
                'title': 'Build the bundle',
                'status': 'running',
                'startedAtMs': startedAtMs,
              }),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        const strip = ValueKey('session-live-strip-activity:cmd:toolu_1');
        expect(find.byKey(strip), findsOneWidget);

        // Dismissing a RUNNING command means "not now", not "never tell me".
        await tester.tap(
          find.byKey(
            const ValueKey(
              'session-live-strip-archive-activity:cmd:toolu_1',
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.byKey(strip), findsNothing);

        connection.emitEvent(
          MessageWireEvent(
            seq: 2,
            message: AgentMessage.fromJson({
              'type': 'agent-activity',
              'key': 'cmd:toolu_1',
              'kind': 'command',
              'title': 'Build the bundle',
              'status': 'error',
              'exitCode': 1,
              'elapsedMs': 7000,
              'startedAtMs': startedAtMs,
            }),
          ),
        );
        await tester.pumpAndSettle();

        // The archive identity carries whether the work has ended, so the
        // terminal frame is a different identity and the card returns once,
        // carrying the outcome. Without that, dismissing a running command
        // would silently discard how it finished.
        expect(find.byKey(strip), findsOneWidget);
        expect(find.text('Failed'), findsWidgets);
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
