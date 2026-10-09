// Behavior files retain a common import set to keep split diffs mechanical.
// ignore_for_file: unused_import, unnecessary_import

import 'dart:async';
import 'dart:ui' show PointerDeviceKind;

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/components.dart';
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
  group('SessionDetailPage request actions', () {
    testWidgets(
      'renders permission request metadata and sends approval with sent state',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.permissionRequest,
                raw: {
                  'type': 'permission-request',
                  'requestId': 'perm-1',
                  'permission': 'disk.write',
                  'reason': 'Need to write output',
                  'operation': 'create',
                  'target': '/tmp/report.txt',
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
          ),
        );
        await tester.pumpAndSettle();

        await tester.ensureVisible(
          find.byKey(const Key('session-detail-permission-approve-perm-1')),
        );
        final approveButton = tester.widget<FilledButton>(
          find.byKey(const Key('session-detail-permission-approve-perm-1')),
        );
        expect(approveButton.onPressed, isNotNull);
        approveButton.onPressed?.call();
        await tester.pumpAndSettle();

        expect(connection.sendPermissionDecisionCount, 1);
        expect(connection.lastPermissionDecisionRequestId, 'perm-1');
        expect(connection.lastPermissionDecision, 'approve');
        expect(find.text('permission: disk.write'), findsAtLeastNWidgets(1));
        expect(
          find.text('reason: Need to write output'),
          findsAtLeastNWidgets(1),
        );
        expect(find.text('operation: create'), findsAtLeastNWidgets(1));
        expect(find.text('target: /tmp/report.txt'), findsAtLeastNWidgets(1));
        expect(find.text('Sent'), findsOneWidget);
        final approveButtonAfter = tester.widget<FilledButton>(
          find.byKey(const Key('session-detail-permission-approve-perm-1')),
        );
        final rejectButtonAfter = tester.widget<OutlinedButton>(
          find.byKey(const Key('session-detail-permission-reject-perm-1')),
        );
        expect(approveButtonAfter.onPressed, isNull);
        expect(rejectButtonAfter.onPressed, isNull);
      },
    );

    testWidgets(
      'permission title, body, and actions share one plain selectable decision',
      (
        tester,
      ) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.permissionRequest,
                raw: {
                  'type': 'permission-request',
                  'requestId': 'perm-one-box',
                  'permission': 'disk.write',
                  'reason': 'Save the report',
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        final action = find.byKey(
          const Key('session-detail-permission-approve-perm-one-box'),
        );
        await tester.ensureVisible(action);
        expect(
          find.ancestor(of: action, matching: find.byType(Card)),
          findsNothing,
        );
        final card = find.ancestor(
          of: action,
          matching: find.byType(TranscriptBox),
        );
        expect(card, findsOneWidget);
        expect(
          find.descendant(of: card, matching: find.text('Permission request')),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: card,
            matching: find.text('reason: Save the report'),
          ),
          findsOneWidget,
        );
        expect(
          find.ancestor(of: action, matching: find.byType(SelectionArea)),
          findsOneWidget,
        );
        expect(
          find.descendant(of: card, matching: find.byType(SelectableText)),
          findsNothing,
        );
      },
    );

    testWidgets(
      'question title, input, and actions share one plain selectable decision',
      (
        tester,
      ) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.questionRequest,
                raw: {
                  'type': 'question-request',
                  'requestId': 'question-one-box',
                  'questions': [
                    {'question': 'Which server should run this?'},
                  ],
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        final action = find.byKey(
          const Key(
            'session-detail-question-answer-button-question-one-box',
          ),
        );
        await tester.ensureVisible(action);
        expect(
          find.ancestor(of: action, matching: find.byType(Card)),
          findsNothing,
        );
        final card = find.ancestor(
          of: action,
          matching: find.byType(TranscriptBox),
        );
        expect(card, findsOneWidget);
        expect(
          find.descendant(of: card, matching: find.text('Question')),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: card,
            matching: find.text('Which server should run this?'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(of: card, matching: find.byType(TextField)),
          findsOneWidget,
        );
        expect(
          find.ancestor(of: action, matching: find.byType(SelectionArea)),
          findsOneWidget,
        );
      },
    );

    testWidgets('request actions use pointer and touch target heights', (
      tester,
    ) async {
      for (final testCase in const [
        (TargetPlatform.linux, 32.0),
        (TargetPlatform.windows, 32.0),
        (TargetPlatform.android, 40.0),
        (TargetPlatform.iOS, 40.0),
      ]) {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.permissionRequest,
                raw: {
                  'type': 'permission-request',
                  'requestId': 'perm-target',
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            theme: buildAppTheme(
              themeSpecById(kDefaultThemeId).light,
              Brightness.light,
            ).copyWith(platform: testCase.$1),
          ),
        );
        await tester.pumpAndSettle();

        final action = find.byKey(
          const Key('session-detail-permission-approve-perm-target'),
        );
        await tester.ensureVisible(action);
        expect(
          tester.getSize(action).height,
          testCase.$2,
          reason: '${testCase.$1}',
        );
      }
    });

    testWidgets(
      'keeps permission actions actionable after submit failure '
      'and shows failure text',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.permissionRequest,
                raw: {
                  'type': 'permission-request',
                  'requestId': 'perm-2',
                },
              ),
            ),
          ],
        )..failNextPermissionDecision = true;
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
          ),
        );
        await tester.pumpAndSettle();

        await tester.ensureVisible(
          find.byKey(const Key('session-detail-permission-approve-perm-2')),
        );
        final approveButton = tester.widget<FilledButton>(
          find.byKey(const Key('session-detail-permission-approve-perm-2')),
        );
        expect(approveButton.onPressed, isNotNull);
        approveButton.onPressed?.call();
        await tester.pumpAndSettle();

        expect(connection.sendPermissionDecisionCount, 1);
        expect(find.text('Failed'), findsOneWidget);
        expect(
          find.text('Request action failed. Please retry.'),
          findsOneWidget,
        );

        final approveButtonAfter = tester.widget<FilledButton>(
          find.byKey(const Key('session-detail-permission-approve-perm-2')),
        );
        final rejectButtonAfter = tester.widget<OutlinedButton>(
          find.byKey(const Key('session-detail-permission-reject-perm-2')),
        );
        expect(approveButtonAfter.onPressed, isNotNull);
        expect(rejectButtonAfter.onPressed, isNotNull);
      },
    );

    testWidgets('disables permission actions when disconnected', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          initialState: const SessionDetailState(
            tool: 'claude',
            sessionId: 'session-1',
            bootstrapState: SessionDetailBootstrapState(
              readiness: SessionDetailBootstrapReadiness.ready,
              attempt: 1,
              hasCachedMessages: true,
            ),
            events: [
              MessageWireEvent(
                seq: 1,
                message: AgentMessage(
                  type: AgentMessageType.permissionRequest,
                  raw: {
                    'type': 'permission-request',
                    'requestId': 'perm-1',
                  },
                ),
              ),
            ],
          ),
        ),
      );
      await tester.pumpAndSettle();

      await tester.ensureVisible(
        find.byKey(const Key('session-detail-permission-approve-perm-1')),
      );
      final approveButton = tester.widget<FilledButton>(
        find.byKey(const Key('session-detail-permission-approve-perm-1')),
      );
      final rejectButton = tester.widget<OutlinedButton>(
        find.byKey(const Key('session-detail-permission-reject-perm-1')),
      );
      expect(approveButton.onPressed, isNull);
      expect(rejectButton.onPressed, isNull);
      expect(
        find.text('Connect to the session to reply.'),
        findsAtLeastNWidgets(1),
      );
    });

    testWidgets('Observe makes permission cards inert', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          SessionWireEvent(
            info: SessionInfo.fromJson(const {
              'id': 'session-1',
              'tool': 'claude',
              'title': 'Observe requests',
              'status': 'idle',
              'attachMode': 'observe',
              'control': {
                'drive': {'state': 'observing', 'supported': true},
                'terminalSync': {
                  'supported': false,
                  'syncAvailable': false,
                  'active': false,
                },
              },
            }),
          ),
          const MessageWireEvent(
            seq: 1,
            message: AgentMessage(
              type: AgentMessageType.permissionRequest,
              raw: {
                'type': 'permission-request',
                'requestId': 'perm-observe',
              },
            ),
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      final permissionFinder = find.byKey(
        const Key('session-detail-permission-approve-perm-observe'),
        skipOffstage: false,
      );
      await tester.ensureVisible(permissionFinder);
      await tester.pumpAndSettle();
      final permissionButton = tester.widget<FilledButton>(
        permissionFinder,
      );
      expect(permissionButton.onPressed, isNull);
      expect(connection.sendPermissionDecisionCount, 0);
    });

    testWidgets('Observe makes question cards inert', (tester) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          SessionWireEvent(
            info: SessionInfo.fromJson(const {
              'id': 'session-1',
              'tool': 'claude',
              'title': 'Observe requests',
              'status': 'idle',
              'attachMode': 'observe',
              'control': {
                'drive': {'state': 'observing', 'supported': true},
                'terminalSync': {
                  'supported': false,
                  'syncAvailable': false,
                  'active': false,
                },
              },
            }),
          ),
          const MessageWireEvent(
            seq: 1,
            message: AgentMessage(
              type: AgentMessageType.questionRequest,
              raw: {
                'type': 'question-request',
                'requestId': 'question-observe',
                'question': 'Continue?',
              },
            ),
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      final questionFinder = find.byKey(
        const Key(
          'session-detail-question-answer-button-question-observe',
        ),
        skipOffstage: false,
      );
      await tester.ensureVisible(questionFinder);
      await tester.pumpAndSettle();
      final questionButton = tester.widget<FilledButton>(
        questionFinder,
      );
      expect(questionButton.onPressed, isNull);
      expect(connection.sendQuestionAnswerCount, 0);
    });

    testWidgets(
      'deactivates the permission card after external resolution',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.permissionRequest,
                raw: {
                  'type': 'permission-request',
                  'requestId': 'perm-ext',
                },
              ),
            ),
            MessageWireEvent(
              seq: 2,
              message: AgentMessage(
                type: AgentMessageType.permissionResolved,
                raw: {
                  'type': 'permission-resolved',
                  'requestId': 'perm-ext',
                  'decision': 'external',
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        await tester.ensureVisible(
          find.byKey(const Key('session-detail-permission-approve-perm-ext')),
        );
        final approveButton = tester.widget<FilledButton>(
          find.byKey(const Key('session-detail-permission-approve-perm-ext')),
        );
        final rejectButton = tester.widget<OutlinedButton>(
          find.byKey(const Key('session-detail-permission-reject-perm-ext')),
        );
        expect(approveButton.onPressed, isNull);
        expect(rejectButton.onPressed, isNull);
        expect(
          find.text('Resolved in another client.'),
          findsAtLeastNWidgets(1),
        );
        // The card must never submit a decision on its own.
        expect(connection.sendPermissionDecisionCount, 0);
      },
    );

    testWidgets(
      'a settled approval says which seat answered, even the one that tapped',
      (tester) async {
        // A mod-synced session has two places the same prompt can be answered.
        // While this seat's own send was hiding the resolution lines, the seat
        // that lost the race kept reading "Sent" over a call its terminal had
        // already answered.
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.permissionRequest,
                raw: {
                  'type': 'permission-request',
                  'requestId': 'perm-race',
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        final approveFinder = find.byKey(
          const Key('session-detail-permission-approve-perm-race'),
        );
        await tester.ensureVisible(approveFinder);
        tester.widget<FilledButton>(approveFinder).onPressed?.call();
        await tester.pumpAndSettle();
        expect(find.text('Sent'), findsOneWidget);

        connection.emitEvent(
          const MessageWireEvent(
            seq: 2,
            message: AgentMessage(
              type: AgentMessageType.permissionResolved,
              raw: {
                'type': 'permission-resolved',
                'requestId': 'perm-race',
                'decision': 'reject',
                'decidedBy': 'band',
              },
            ),
          ),
        );
        await tester.pumpAndSettle();

        // This seat's transport badge is no longer the card's story.
        expect(find.text('Sent'), findsNothing);
        expect(find.text('Rejected'), findsAtLeastNWidgets(1));
        expect(
          find.text('Answered in your terminal'),
          findsAtLeastNWidgets(1),
        );
        expect(
          find.byKey(
            const Key('session-detail-permission-decided-by-perm-race'),
            skipOffstage: false,
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'a card this seat answered never says another client answered it',
      (tester) async {
        // `external` is the broker's word for "somebody else settled this", and
        // it is also the word it sends when THIS seat's own answer reached the
        // terminal. The card used to read "Resolved in another client." over
        // the user's own tap, and dropped the badge that was the only proof the
        // tap had happened at all.
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.permissionRequest,
                raw: {
                  'type': 'permission-request',
                  'requestId': 'perm-own',
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        final approveFinder = find.byKey(
          const Key('session-detail-permission-approve-perm-own'),
        );
        await tester.ensureVisible(approveFinder);
        tester.widget<FilledButton>(approveFinder).onPressed?.call();
        await tester.pumpAndSettle();
        expect(find.text('Sent'), findsOneWidget);

        connection.emitEvent(
          const MessageWireEvent(
            seq: 2,
            message: AgentMessage(
              type: AgentMessageType.permissionResolved,
              raw: {
                'type': 'permission-resolved',
                'requestId': 'perm-own',
                'decision': 'external',
              },
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.text('Resolved in another client.'),
          findsNothing,
          reason: 'nobody else answered this, as far as the broker said',
        );
        // With no decision value and no seat to name, this seat's own transport
        // badge is still the truest sentence on the card.
        expect(find.text('Sent'), findsOneWidget);
      },
    );

    testWidgets(
      'and the seat the broker did name wins over that badge',
      (tester) async {
        // The other half of the same rule: the broker CAN say the terminal
        // answered, and then the card says so rather than keeping the app's own
        // "Sent".
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.permissionRequest,
                raw: {
                  'type': 'permission-request',
                  'requestId': 'perm-own2',
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        final approveFinder = find.byKey(
          const Key('session-detail-permission-approve-perm-own2'),
        );
        await tester.ensureVisible(approveFinder);
        tester.widget<FilledButton>(approveFinder).onPressed?.call();
        await tester.pumpAndSettle();

        connection.emitEvent(
          const MessageWireEvent(
            seq: 2,
            message: AgentMessage(
              type: AgentMessageType.permissionResolved,
              raw: {
                'type': 'permission-resolved',
                'requestId': 'perm-own2',
                'decision': 'external',
                'decidedBy': 'band',
              },
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('Answered in your terminal'), findsAtLeastNWidgets(1));
        expect(find.text('Resolved in another client.'), findsNothing);
        expect(find.text('Sent'), findsNothing);
      },
    );

    testWidgets(
      'deactivates the permission card for an unknown resolution decision',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.permissionRequest,
                raw: {
                  'type': 'permission-request',
                  'requestId': 'perm-unk',
                },
              ),
            ),
            MessageWireEvent(
              seq: 2,
              message: AgentMessage(
                type: AgentMessageType.permissionResolved,
                raw: {
                  'type': 'permission-resolved',
                  'requestId': 'perm-unk',
                  // A value whose decode maps to `unknown`: the card must
                  // still deactivate (gate is presence, not decision value).
                  'decision': 'some-future-decision',
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        await tester.ensureVisible(
          find.byKey(const Key('session-detail-permission-approve-perm-unk')),
        );
        final approveButton = tester.widget<FilledButton>(
          find.byKey(const Key('session-detail-permission-approve-perm-unk')),
        );
        final rejectButton = tester.widget<OutlinedButton>(
          find.byKey(const Key('session-detail-permission-reject-perm-unk')),
        );
        expect(approveButton.onPressed, isNull);
        expect(rejectButton.onPressed, isNull);
      },
    );

    testWidgets(
      'a card the reconnect does not send again no longer waits, and one it '
      'sends again does',
      (tester) async {
        // Room for all four cards.
        tester.view
          ..physicalSize = const Size(1200, 4000)
          ..devicePixelRatio = 1;
        addTearDown(tester.view.reset);
        AgentMessage permission(String id) => AgentMessage(
          type: AgentMessageType.permissionRequest,
          raw: {'type': 'permission-request', 'requestId': id},
        );
        AgentMessage question(String id) => AgentMessage(
          type: AgentMessageType.questionRequest,
          raw: {
            'type': 'question-request',
            'requestId': id,
            'question': 'Continue?',
          },
        );
        final connection = ScriptedSessionDetailConnection(
          events: [
            defaultScriptedHello,
            const HistoryWireEvent(messages: [], cursor: 'reconnect-0'),
            MessageWireEvent(seq: 1, message: permission('perm-gone')),
            MessageWireEvent(seq: 2, message: question('q-gone')),
            MessageWireEvent(seq: 3, message: permission('perm-kept')),
            MessageWireEvent(seq: 4, message: question('q-kept')),
            // The socket drops; the reconnect replays only the cards still
            // waiting.
            defaultScriptedHello,
            const HistoryWireEvent(messages: [], cursor: 'reconnect-0'),
            MessageWireEvent(seq: 0, message: permission('perm-kept')),
            MessageWireEvent(seq: 0, message: question('q-kept')),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        await tester.ensureVisible(
          find.byKey(const Key('session-detail-permission-approve-perm-gone')),
        );
        expect(
          tester
              .widget<FilledButton>(
                find.byKey(
                  const Key('session-detail-permission-approve-perm-gone'),
                ),
              )
              .onPressed,
          isNull,
        );
        expect(
          find.byKey(
            const Key('session-detail-permission-withdrawn-perm-gone'),
          ),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('session-detail-question-withdrawn-q-gone')),
          findsOneWidget,
        );
        expect(
          find.text('No longer waiting for an answer.'),
          findsNWidgets(2),
        );
        Future<TextButton> dismiss(String id) async {
          final button = find.byKey(Key('session-detail-question-reject-$id'));
          await tester.ensureVisible(button);
          return tester.widget<TextButton>(button);
        }

        expect((await dismiss('q-gone')).onPressed, isNull);
        expect((await dismiss('q-kept')).onPressed, isNotNull);
        expect(find.text('Resolved in another client.'), findsNothing);
        await tester.ensureVisible(
          find.byKey(const Key('session-detail-permission-approve-perm-kept')),
        );
        expect(
          tester
              .widget<FilledButton>(
                find.byKey(
                  const Key('session-detail-permission-approve-perm-kept'),
                ),
              )
              .onPressed,
          isNotNull,
        );
      },
    );

    testWidgets(
      'deactivates the question card after external resolution',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.questionRequest,
                raw: {
                  'type': 'question-request',
                  'requestId': 'q-ext',
                  'question': 'Continue?',
                },
              ),
            ),
            MessageWireEvent(
              seq: 2,
              message: AgentMessage(
                type: AgentMessageType.questionResolved,
                raw: {
                  'type': 'question-resolved',
                  'requestId': 'q-ext',
                  'decision': 'external',
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        await tester.ensureVisible(
          find.byKey(
            const Key('session-detail-question-answer-button-q-ext'),
          ),
        );
        final answerButton = tester.widget<FilledButton>(
          find.byKey(
            const Key('session-detail-question-answer-button-q-ext'),
          ),
        );
        final dismissButton = tester.widget<TextButton>(
          find.byKey(const Key('session-detail-question-reject-q-ext')),
        );
        expect(answerButton.onPressed, isNull);
        expect(dismissButton.onPressed, isNull);
        // The broker says a question was settled, never by whom: the terminal
        // and another app both send this, so the card names neither alone.
        expect(
          find.text('Settled in your terminal or another app.'),
          findsOneWidget,
        );
        expect(find.text('Resolved in another client.'), findsNothing);
      },
    );

    testWidgets(
      'shows question context and sends answer with sent state',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.questionRequest,
                raw: {
                  'type': 'question-request',
                  'questionId': 'q-1',
                  'question': 'Continue?',
                  'prompt': 'Continue this step?',
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.text('question: Continue?'),
          findsAtLeastNWidgets(1),
        );
        expect(
          find.text('prompt: Continue this step?'),
          findsAtLeastNWidgets(1),
        );

        await tester.enterText(
          find.byKey(const Key('session-detail-question-answer-q-1')),
          'yes\nmaybe later',
        );
        await tester.pump();
        final questionAnswerButton = tester.widget<FilledButton>(
          find.byKey(const Key('session-detail-question-answer-button-q-1')),
        );
        expect(questionAnswerButton.onPressed, isNotNull);
        questionAnswerButton.onPressed?.call();
        await tester.pumpAndSettle();

        expect(connection.sendQuestionAnswerCount, 1);
        expect(connection.lastQuestionRequestId, 'q-1');
        expect(
          connection.lastQuestionAnswers,
          const [
            ['yes'],
            ['maybe later'],
          ],
        );
        expect(find.text('Sent'), findsOneWidget);

        await tester.enterText(
          find.byKey(const Key('session-detail-question-answer-q-1')),
          'ignored',
        );
        await tester.pump();
        final questionAnswerButtonAfter = tester.widget<FilledButton>(
          find.byKey(const Key('session-detail-question-answer-button-q-1')),
        );
        final dismissButtonAfter = tester.widget<TextButton>(
          find.byKey(const Key('session-detail-question-reject-q-1')),
        );
        expect(questionAnswerButtonAfter.onPressed, isNull);
        expect(dismissButtonAfter.onPressed, isNull);
      },
    );

    testWidgets(
      'keeps question text and shows failure state when answer submit fails',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.questionRequest,
                raw: {
                  'type': 'question-request',
                  'questionId': 'q-2',
                  'question': 'Continue?',
                },
              ),
            ),
          ],
        )..failNextQuestionAnswer = true;
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
          ),
        );
        await tester.pumpAndSettle();

        await tester.enterText(
          find.byKey(const Key('session-detail-question-answer-q-2')),
          'retry later',
        );
        await tester.pump();
        final questionAnswerButton = tester.widget<FilledButton>(
          find.byKey(const Key('session-detail-question-answer-button-q-2')),
        );
        expect(questionAnswerButton.onPressed, isNotNull);
        questionAnswerButton.onPressed?.call();
        await tester.pumpAndSettle();

        expect(connection.sendQuestionAnswerCount, 1);
        expect(
          tester
              .widget<TextField>(
                find.byKey(const Key('session-detail-question-answer-q-2')),
              )
              .controller
              ?.text,
          'retry later',
        );
        expect(find.text('Failed'), findsOneWidget);
        expect(
          find.text('Request action failed. Please retry.'),
          findsOneWidget,
        );

        final dismissButton = tester.widget<TextButton>(
          find.byKey(const Key('session-detail-question-reject-q-2')),
        );
        expect(dismissButton.onPressed, isNotNull);
      },
    );

    testWidgets('sends question answer and clears text after success', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: const [
          MessageWireEvent(
            seq: 1,
            message: AgentMessage(
              type: AgentMessageType.questionRequest,
              raw: {
                'type': 'question-request',
                'questionId': 'q-1',
                'question': 'Continue?',
              },
            ),
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
        ),
      );
      await tester.pumpAndSettle();

      await tester.ensureVisible(
        find.byKey(const Key('session-detail-question-answer-q-1')),
      );
      await tester.enterText(
        find.byKey(const Key('session-detail-question-answer-q-1')),
        'yes\nmaybe later',
      );
      await tester.pump();
      final questionAnswerButtonFinder = find.byKey(
        const Key('session-detail-question-answer-button-q-1'),
      );
      final questionAnswerButton = tester.widget<FilledButton>(
        questionAnswerButtonFinder,
      );
      expect(questionAnswerButton.onPressed, isNotNull);
      questionAnswerButton.onPressed?.call();
      await tester.pumpAndSettle();

      expect(connection.sendQuestionAnswerCount, 1);
      expect(connection.lastQuestionRequestId, 'q-1');
      expect(
        connection.lastQuestionAnswers,
        const [
          ['yes'],
          ['maybe later'],
        ],
      );
      expect(
        tester
                .widget<TextField>(
                  find.byKey(const Key('session-detail-question-answer-q-1')),
                )
                .controller
                ?.text ??
            '',
        isEmpty,
      );
    });

    testWidgets('dismisses question before an answer is sent', (tester) async {
      final connection = ScriptedSessionDetailConnection(
        events: const [
          MessageWireEvent(
            seq: 1,
            message: AgentMessage(
              type: AgentMessageType.questionRequest,
              raw: {
                'type': 'question-request',
                'questionId': 'q-dismiss',
                'question': 'Continue?',
              },
            ),
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
        ),
      );
      await tester.pumpAndSettle();

      await tester.ensureVisible(
        find.byKey(const Key('session-detail-question-reject-q-dismiss')),
      );

      final dismissButton = tester.widget<TextButton>(
        find.byKey(const Key('session-detail-question-reject-q-dismiss')),
      );
      expect(dismissButton.onPressed, isNotNull);
      dismissButton.onPressed?.call();
      await tester.pumpAndSettle();

      expect(connection.rejectQuestionCount, 1);
      expect(connection.lastRejectQuestionRequestId, 'q-dismiss');
      expect(find.text('Sent'), findsOneWidget);
    });

    testWidgets(
      'supports alternative permission request id keys',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.permissionRequest,
                raw: {
                  'type': 'permission-request',
                  'permissionId': 'p-id-2',
                  'permission': 'disk.write',
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
          ),
        );
        await tester.pumpAndSettle();

        await tester.ensureVisible(
          find.byKey(const Key('session-detail-permission-reject-p-id-2')),
        );
        final rejectButton = tester.widget<OutlinedButton>(
          find.byKey(
            const Key('session-detail-permission-reject-p-id-2'),
          ),
        );
        expect(rejectButton.onPressed, isNotNull);
        rejectButton.onPressed?.call();
        await tester.pumpAndSettle();

        expect(connection.rejectQuestionCount, 0);
        expect(connection.sendPermissionDecisionCount, 1);
        expect(
          connection.lastPermissionDecisionRequestId,
          'p-id-2',
        );
      },
    );

    testWidgets(
      'renders canonical OpenCode permission title and detail and sends always',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.permissionRequest,
                raw: {
                  'type': 'permission-request',
                  'requestId': 'perm-opencode',
                  'title': 'bash',
                  'detail': '/workspace · bun test',
                  'options': ['approve', 'approve-session', 'reject'],
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('bash'), findsOneWidget);
        expect(find.textContaining('/workspace · bun test'), findsNothing);
        await tester.tap(
          find.byKey(const Key('session-permission-detail-toggle')),
        );
        await tester.pumpAndSettle();
        expect(find.text('/workspace · bun test'), findsOneWidget);
        final alwaysFinder = find.byKey(
          const Key(
            'session-detail-permission-approve-session-perm-opencode',
          ),
        );
        await tester.ensureVisible(alwaysFinder);
        final alwaysButton = tester.widget<FilledButton>(alwaysFinder);
        expect(alwaysButton.onPressed, isNotNull);
        alwaysButton.onPressed?.call();
        await tester.pumpAndSettle();

        expect(connection.lastPermissionDecisionRequestId, 'perm-opencode');
        expect(connection.lastPermissionDecision, 'approve-session');
      },
    );

    testWidgets(
      'shows full Codex command detail and sends the persistent rule decision',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.permissionRequest,
                raw: {
                  'type': 'permission-request',
                  'requestId': 'perm-codex-rule',
                  'title': 'Approve command',
                  'detail':
                      "/bin/bash -lc 'codex app-server daemon restart && "
                      "codex app-server daemon version'\n"
                      'cwd: /home/howard\n'
                      'Reload corrected model catalog configuration',
                  'options': ['approve', 'approve-rule', 'reject'],
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.textContaining('codex app-server daemon restart'),
          findsNothing,
        );
        await tester.tap(
          find.byKey(const Key('session-permission-detail-toggle')),
        );
        await tester.pumpAndSettle();
        expect(
          find.textContaining('codex app-server daemon restart'),
          findsOneWidget,
        );
        expect(
          find.textContaining('Reload corrected model catalog'),
          findsOneWidget,
        );

        final ruleFinder = find.byKey(
          const Key(
            'session-detail-permission-approve-rule-perm-codex-rule',
          ),
        );
        await tester.ensureVisible(ruleFinder);
        tester.widget<FilledButton>(ruleFinder).onPressed?.call();
        await tester.pumpAndSettle();

        expect(connection.lastPermissionDecisionRequestId, 'perm-codex-rule');
        expect(connection.lastPermissionDecision, 'approve-rule');
      },
    );

    testWidgets(
      'hides session approval when the broker does not advertise it',
      (
        tester,
      ) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.permissionRequest,
                raw: {
                  'type': 'permission-request',
                  'requestId': 'perm-once-only',
                  'title': 'Read file',
                  'options': ['approve', 'reject'],
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(
            const Key(
              'session-detail-permission-approve-session-perm-once-only',
            ),
          ),
          findsNothing,
        );
      },
    );

    testWidgets(
      'a permission card with a preview does not repeat it as detail',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.permissionRequest,
                raw: {
                  'type': 'permission-request',
                  'requestId': 'perm-preview',
                  'title': 'Bash permission',
                  'toolName': 'Bash',
                  'inputPreview': 'command: rm -rf build',
                  'detail': 'Bash: rm -rf build',
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        expect(find.text('command: rm -rf build'), findsOneWidget);
        expect(
          find.byKey(const Key('session-permission-detail-toggle')),
          findsNothing,
        );
        expect(find.textContaining('Bash: rm -rf build'), findsNothing);
        expect(
          find.byKey(
            const Key('session-detail-permission-approve-perm-preview'),
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'a permission card leads with the preview and opens to the whole call',
      (tester) async {
        // The preview names one argument and cuts it at 240 characters: enough
        // to recognise a call, not always enough to decide one.
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.permissionRequest,
                raw: {
                  'type': 'permission-request',
                  'requestId': 'perm-full',
                  'title': 'Edit',
                  'toolName': 'Edit',
                  'inputPreview': 'file_path: /work/src/app.ts',
                  'detail':
                      'file_path: /work/src/app.ts\n'
                      'old_string: const retries = 3;\n'
                      'new_string: const retries = 5;',
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        expect(find.text('file_path: /work/src/app.ts'), findsOneWidget);
        expect(find.textContaining('const retries = 5;'), findsNothing);
        await tester.tap(
          find.byKey(const Key('session-permission-detail-toggle')),
        );
        await tester.pumpAndSettle();
        final full = tester.widget<Text>(
          find.byKey(const Key('session-permission-full-detail')),
        );
        expect(full.data, contains('old_string: const retries = 3;'));
        expect(full.data, contains('new_string: const retries = 5;'));
        expect(
          find.byKey(const Key('session-detail-permission-approve-perm-full')),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'a long command cut in the preview is whole behind the toggle',
      (tester) async {
        final command = 'echo ${'x' * 400}';
        final connection = ScriptedSessionDetailConnection(
          events: [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.permissionRequest,
                raw: {
                  'type': 'permission-request',
                  'requestId': 'perm-long',
                  'title': 'Bash',
                  'toolName': 'Bash',
                  'inputPreview':
                      '${'command: $command'.substring(0, 239)}\u2026',
                  'detail': 'command: $command',
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        await tester.tap(
          find.byKey(const Key('session-permission-detail-toggle')),
        );
        await tester.pumpAndSettle();
        expect(
          tester
              .widget<Text>(
                find.byKey(const Key('session-permission-full-detail')),
              )
              .data,
          'command: $command',
        );
      },
    );

    testWidgets(
      'a call with one short field offers no toggle for the same line again',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.permissionRequest,
                raw: {
                  'type': 'permission-request',
                  'requestId': 'perm-short',
                  'title': 'Grep',
                  'toolName': 'Grep',
                  'inputPreview': 'pattern: a',
                  'detail': 'pattern: a',
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(const Key('session-permission-detail-toggle')),
          findsNothing,
        );
      },
    );

    testWidgets(
      'a released permission card keeps its preview behind the detail toggle',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.permissionRequest,
                raw: {
                  'type': 'permission-request',
                  'requestId': 'perm-released-preview',
                  'title': 'Write permission',
                  'toolName': 'Write',
                  'readOnly': true,
                  'blocking': false,
                  'releaseReason': 'mode:bypassPermissions',
                  'inputPreview': 'file_path: /work/notes.md',
                  'detail': 'Write: /work/notes.md',
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        expect(find.textContaining('Write: /work/notes.md'), findsNothing);
        await tester.tap(
          find.byKey(const Key('session-permission-detail-toggle')),
        );
        await tester.pumpAndSettle();
        expect(find.text('Write: /work/notes.md'), findsOneWidget);
      },
    );

    testWidgets('canonical read-only permission stays inert while connected', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: const [
          MessageWireEvent(
            seq: 1,
            message: AgentMessage(
              type: AgentMessageType.permissionRequest,
              raw: {
                'type': 'permission-request',
                'requestId': 'perm-read-only',
                'title': 'Run command',
                'readOnly': true,
                'options': ['approve', 'approve-session', 'reject'],
              },
            ),
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(
          const Key('session-detail-permission-approve-perm-read-only'),
        ),
        findsNothing,
      );
      expect(
        find.byKey(
          const Key(
            'session-detail-permission-approve-session-perm-read-only',
          ),
        ),
        findsNothing,
      );
      expect(
        find.text(
          'This request is read-only. Answer where the agent is running.',
        ),
        findsOneWidget,
      );
    });

    testWidgets(
      'renders canonical OpenCode questions and sends one answer array '
      'per question',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.questionRequest,
                raw: {
                  'type': 'question-request',
                  'requestId': 'question-opencode',
                  'questions': [
                    {
                      'header': 'Migration',
                      'question': 'How should the migration run?',
                      'options': [
                        {
                          'label': 'Apply now',
                          'description': 'Run it before the next turn.',
                        },
                        {'label': 'Defer'},
                      ],
                      'multiple': false,
                    },
                    {
                      'header': 'Checks',
                      'question': 'Which checks should run?',
                      'options': [
                        {'label': 'Tests'},
                        {
                          'label': 'Docs',
                          'description': 'Validate generated documentation.',
                        },
                      ],
                      'multiple': true,
                    },
                  ],
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text('Migration'), findsOneWidget);
        expect(
          find.text('How should the migration run?'),
          findsAtLeastNWidgets(1),
        );
        expect(find.text('Run it before the next turn.'), findsOneWidget);
        expect(find.text('Checks'), findsOneWidget);
        expect(find.text('Validate generated documentation.'), findsOneWidget);

        await tester.tap(
          find.byKey(
            const Key(
              'session-detail-question-option-question-opencode-0-0',
            ),
          ),
        );
        await tester.tap(
          find.byKey(
            const Key(
              'session-detail-question-option-question-opencode-1-0',
            ),
          ),
        );
        await tester.tap(
          find.byKey(
            const Key(
              'session-detail-question-option-question-opencode-1-1',
            ),
          ),
        );
        await tester.pump();

        final submitFinder = find.byKey(
          const Key(
            'session-detail-question-answer-button-question-opencode',
          ),
        );
        await tester.ensureVisible(submitFinder);
        final submitButton = tester.widget<FilledButton>(submitFinder);
        expect(submitButton.onPressed, isNotNull);
        submitButton.onPressed?.call();
        await tester.pumpAndSettle();

        expect(connection.lastQuestionRequestId, 'question-opencode');
        expect(
          connection.lastQuestionAnswers,
          const [
            ['Apply now'],
            ['Tests', 'Docs'],
          ],
        );
      },
    );

    testWidgets(
      'question card state does not leak across rows when history prepends '
      'a message at the same positional slot',
      (tester) async {
        // Regression guard for the unkeyed _MessageRow reuse bug:
        // - Two question-request cards render (q-short: 1 question,
        //   q-long: 2 questions).
        // - Custom answer text is typed into q-long's first field.
        // - A new message is prepended before both, shifting positional slots.
        // Without a stable row key, Flutter re-pairs a State sized for one
        // card with the other, either leaking the typed answer onto the wrong
        // card or throwing RangeError when an undersized State is indexed past
        // its length.
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.questionRequest,
                raw: {
                  'type': 'question-request',
                  'requestId': 'q-short',
                  'questions': [
                    {
                      'question': 'Short one?',
                      'options': [
                        {'label': 'a'},
                      ],
                    },
                  ],
                },
              ),
            ),
            MessageWireEvent(
              seq: 2,
              message: AgentMessage(
                type: AgentMessageType.questionRequest,
                raw: {
                  'type': 'question-request',
                  'requestId': 'q-long',
                  'questions': [
                    {
                      'question': 'Long one A?',
                      'options': [
                        {'label': 'x'},
                      ],
                    },
                    {
                      'question': 'Long one B?',
                      'options': [
                        {'label': 'y'},
                      ],
                    },
                  ],
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
          ),
        );
        await tester.pumpAndSettle();

        // Type custom answer text into q-long's FIRST question custom field.
        await tester.enterText(
          find.byKey(
            const Key('session-detail-question-custom-q-long-0'),
          ),
          'typed-into-q-long',
        );
        await tester.pump();

        // Prepend a user message before both question cards by emitting it
        // as the next event. The transcript re-renders with the new message
        // at index 0, shifting both question cards down by one positional
        // slot - which is the exact reuse path the bug exercises.
        connection.emitEvent(
          const MessageWireEvent(
            seq: 3,
            message: AgentMessage(
              type: AgentMessageType.userMessage,
              raw: {'type': 'user', 'text': 'prepended message'},
            ),
          ),
        );
        // pumpAndSettle reaching this point already proves the crash variant
        // of the bug is fixed: an unkeyed re-pair of a 1-question State onto
        // a 2-question widget throws RangeError during build().
        await tester.pumpAndSettle();

        // Leak variant: q-long's typed answer must not appear on q-short's
        // custom field. With the row key fix, q-short's State is freshly
        // created after the reorder, so its field is empty. Use skipOffstage
        // false so the assertion holds regardless of scroll position.
        final shortFieldFinder = find.byKey(
          const Key('session-detail-question-custom-q-short-0'),
          skipOffstage: false,
        );
        await tester.ensureVisible(shortFieldFinder);
        await tester.pumpAndSettle();
        final shortCustomController = tester
            .widget<TextField>(shortFieldFinder)
            .controller;
        expect(shortCustomController?.text ?? '', isEmpty);

        // q-long's two custom fields must both still render without crashing
        // (proves the State was correctly sized for 2 questions after the
        // re-pair, whether via row key recreation or didUpdateWidget resize).
        for (final fieldKey in const [
          'session-detail-question-custom-q-long-0',
          'session-detail-question-custom-q-long-1',
        ]) {
          final finder = find.byKey(
            Key(fieldKey),
            skipOffstage: false,
          );
          await tester.ensureVisible(finder);
          await tester.pumpAndSettle();
          expect(finder, findsOneWidget);
        }
      },
    );

    testWidgets(
      'a multi-select that takes only its labels offers no free-text field '
      '(MB5b)',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.questionRequest,
                raw: {
                  'type': 'question-request',
                  'requestId': 'question-labels',
                  'questions': [
                    {
                      'question': 'Which checks?',
                      'options': [
                        {'label': 'Lint'},
                        {'label': 'Test'},
                      ],
                      'multiple': true,
                      'freeText': false,
                    },
                    {
                      'question': 'Which build?',
                      'options': [
                        {'label': 'Debug'},
                        {'label': 'Release'},
                      ],
                    },
                  ],
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(
            const Key('session-detail-question-custom-question-labels-0'),
          ),
          findsNothing,
        );
        expect(
          find.byKey(
            const Key('session-detail-question-custom-question-labels-1'),
          ),
          findsOneWidget,
        );

        for (final key in const [
          'session-detail-question-option-question-labels-0-0',
          'session-detail-question-option-question-labels-0-1',
          'session-detail-question-option-question-labels-1-1',
        ]) {
          await tester.ensureVisible(find.byKey(Key(key)));
          await tester.tap(find.byKey(Key(key)));
        }
        await tester.pump();
        final submitFinder = find.byKey(
          const Key('session-detail-question-answer-button-question-labels'),
        );
        await tester.ensureVisible(submitFinder);
        tester.widget<FilledButton>(submitFinder).onPressed?.call();
        await tester.pumpAndSettle();

        expect(connection.lastQuestionRequestId, 'question-labels');
        expect(connection.lastQuestionAnswers, const [
          ['Lint', 'Test'],
          ['Release'],
        ]);
      },
    );

    testWidgets(
      'a number question takes one number in its range, and only that (NQ1)',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.questionRequest,
                raw: {
                  'type': 'question-request',
                  'requestId': 'question-number',
                  'questions': [
                    {
                      'question': 'How many slides?',
                      'options': <Object>[],
                      'kind': 'number',
                      'min': 3,
                      'max': 12,
                      'step': 1,
                      'unit': 'slides',
                    },
                  ],
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        final field = find.byKey(
          const Key('session-detail-question-number-question-number-0'),
        );
        expect(field, findsOneWidget);
        expect(find.text('A number from 3 to 12'), findsOneWidget);
        expect(find.text('slides'), findsOneWidget);
        final submitFinder = find.byKey(
          const Key('session-detail-question-answer-button-question-number'),
        );
        await tester.ensureVisible(submitFinder);

        for (final refused in const ['20', '2', 'five', '1e1', '']) {
          await tester.enterText(field, refused);
          await tester.pump();
          expect(
            tester.widget<FilledButton>(submitFinder).onPressed,
            isNull,
            reason: 'Send waits for a number it takes, not "$refused"',
          );
        }
        expect(find.text('Enter a number from 3 to 12.'), findsNothing);
        await tester.enterText(field, '20');
        await tester.pump();
        expect(find.text('Enter a number from 3 to 12.'), findsOneWidget);

        await tester.enterText(field, '12');
        await tester.pump();
        expect(find.text('Enter a number from 3 to 12.'), findsNothing);
        tester.widget<FilledButton>(submitFinder).onPressed?.call();
        await tester.pumpAndSettle();
        expect(connection.lastQuestionRequestId, 'question-number');
        expect(connection.lastQuestionAnswers, const [
          ['12'],
        ]);
      },
    );

    testWidgets(
      'a question to answer in the terminal is drawn read-only and says '
      'where (MB5b)',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.questionRequest,
                raw: {
                  'type': 'question-request',
                  'requestId': 'question-terminal',
                  'readOnly': true,
                  'blocking': false,
                  'answerInTerminal': true,
                  'questions': [
                    {
                      'question': 'Which sizes?',
                      'options': [
                        {'label': 'Small, cheap'},
                        {'label': 'Large'},
                      ],
                      'multiple': true,
                      'freeText': false,
                    },
                  ],
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.text(
            'This question is waiting in your terminal. Answer it there.',
          ),
          findsOneWidget,
        );
        expect(find.text('Which sizes?'), findsAtLeastNWidgets(1));
        expect(
          find.byKey(
            const Key('session-detail-question-custom-question-terminal-0'),
          ),
          findsNothing,
        );
        expect(
          find.byKey(
            const Key(
              'session-detail-question-answer-button-question-terminal',
            ),
          ),
          findsNothing,
        );
        expect(
          find.byKey(
            const Key('session-detail-question-reject-question-terminal'),
          ),
          findsNothing,
        );
        final chip = tester.widget<FilterChip>(
          find.byKey(
            const Key('session-detail-question-option-question-terminal-0-0'),
          ),
        );
        expect(chip.onSelected, isNull);
        expect(connection.sendQuestionAnswerCount, 0);
      },
    );

    testWidgets(
      'a terminal-only question the app could not read still says where to '
      'answer it (MB5c)',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.questionRequest,
                raw: {
                  'type': 'question-request',
                  'requestId': 'question-unread',
                  'readOnly': true,
                  'blocking': false,
                  'answerInTerminal': true,
                  'questions': <Object?>[],
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.text(
            'This question is waiting in your terminal. Answer it there.',
          ),
          findsOneWidget,
        );
        expect(
          find.byKey(
            const Key('session-detail-question-answer-question-unread'),
          ),
          findsNothing,
        );
      },
    );
  });

  testWidgets(
    'a plan card shows the plan and leaves approving it to the terminal (PM2)',
    (tester) async {
      const plan = '# Ship the release\n\n1. Tag it.\n2. Promote it.';
      final connection = ScriptedSessionDetailConnection(
        events: const [
          MessageWireEvent(
            seq: 1,
            message: AgentMessage(
              type: AgentMessageType.permissionRequest,
              raw: {
                'type': 'permission-request',
                'requestId': 'cm-2@00000000000000b2',
                'toolName': 'ExitPlanMode',
                'readOnly': true,
                'blocking': false,
                'permissionMode': 'plan',
                'releaseReason': 'plan:terminal-only',
                'inputPreview': 'plan: # Ship the release',
                'detail': 'plan: $plan',
              },
            ),
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      // A released card leads with its reason; the plan is its detail.
      expect(find.textContaining('Promote it.'), findsNothing);
      expect(
        find.text(
          "This is Claude's plan. Approving it also picks how Claude carries "
          'on, so answer it in your terminal.',
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(
          const Key('session-detail-permission-approve-cm-2@00000000000000b2'),
        ),
        findsNothing,
      );
      await tester.tap(
        find.byKey(const Key('session-permission-detail-toggle')),
      );
      await tester.pumpAndSettle();
      expect(
        tester
            .widget<Text>(
              find.byKey(const Key('session-permission-full-detail')),
            )
            .data,
        'plan: $plan',
      );
    },
  );

  group('a card left to the terminal (CX1)', () {
    const releasedCard = MessageWireEvent(
      seq: 1,
      message: AgentMessage(
        type: AgentMessageType.permissionRequest,
        raw: {
          'type': 'permission-request',
          'requestId': 'cm-1@00000000000000a1',
          'toolName': 'Write',
          'readOnly': true,
          'blocking': false,
          'permissionMode': 'bypassPermissions',
          'releaseReason': 'mode:bypassPermissions',
          'inputPreview': 'file_path: /work/plan.md',
        },
      ),
    );
    const releasedReason =
        'Claude was bypassing permission checks, and cosyncing leaves any '
        'prompt it still shows to your terminal.';

    testWidgets('an open released card is not pending on this seat', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: const [releasedCard],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      expect(find.text('Approval left to your terminal'), findsOneWidget);
      expect(find.text(releasedReason), findsOneWidget);
      expect(
        find.text(
          'This request is read-only. Answer where the agent is running.',
        ),
        findsOneWidget,
      );
      expect(
        find.text('Pending'),
        findsNothing,
        reason: 'nothing on this card is waiting on this seat',
      );
    });

    testWidgets(
      'once retired, the card says its reason once and that the terminal '
      'settled it',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [releasedCard],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        // The broker retires an explanation card with its own reason attached.
        connection.emitEvent(
          const MessageWireEvent(
            seq: 2,
            message: AgentMessage(
              type: AgentMessageType.permissionResolved,
              raw: {
                'type': 'permission-resolved',
                'requestId': 'cm-1@00000000000000a1',
                'decision': 'external',
                'releaseReason': 'mode:bypassPermissions',
              },
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.text(releasedReason),
          findsOneWidget,
          reason: 'the reason leads the card and is not repeated under it',
        );
        expect(
          find.byKey(
            const Key(
              'session-detail-permission-outcome-cm-1@00000000000000a1',
            ),
          ),
          findsOneWidget,
        );
        expect(find.text('Settled in your terminal.'), findsOneWidget);
        expect(find.text('Resolved in another client.'), findsNothing);
        expect(find.text('Pending'), findsNothing);
        expect(
          find.text(
            'This request is read-only. Answer where the agent is running.',
          ),
          findsNothing,
        );
      },
    );

    testWidgets(
      'a decision on a released card still prints its reason once, and does '
      'not claim the app approved it',
      (tester) async {
        // Nothing a client sends can decide a released card, but the wire can
        // still carry a decision on one: the defect CX3 fixed in the broker
        // broadcast exactly that. The terminal decided it either way.
        final connection = ScriptedSessionDetailConnection(
          events: const [releasedCard],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        connection.emitEvent(
          const MessageWireEvent(
            seq: 2,
            message: AgentMessage(
              type: AgentMessageType.permissionResolved,
              raw: {
                'type': 'permission-resolved',
                'requestId': 'cm-1@00000000000000a1',
                'decision': 'approve',
                'releaseReason': 'mode:bypassPermissions',
              },
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(find.text(releasedReason), findsOneWidget);
        expect(find.text('Settled in your terminal.'), findsOneWidget);
        expect(find.text('Approved'), findsNothing);
      },
    );

    testWidgets('a read-only question is not pending on this seat either', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: const [
          MessageWireEvent(
            seq: 1,
            message: AgentMessage(
              type: AgentMessageType.questionRequest,
              raw: {
                'type': 'question-request',
                'requestId': 'question-watch',
                'readOnly': true,
                'questions': [
                  {
                    'question': 'Which branch?',
                    'options': [
                      {'label': 'main'},
                      {'label': 'release'},
                    ],
                  },
                ],
              },
            ),
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      expect(
        find.text(
          'This request is read-only. Answer where the agent is running.',
        ),
        findsOneWidget,
      );
      expect(find.text('Pending'), findsNothing);
    });

    testWidgets(
      'a question only the terminal could answer is settled in the terminal, '
      'not in another client',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.questionRequest,
                raw: {
                  'type': 'question-request',
                  'requestId': 'cm-2@00000000000000a2',
                  'readOnly': true,
                  'blocking': false,
                  'answerInTerminal': true,
                  'questions': [
                    {
                      'question': 'How many workers?',
                      'options': <Object?>[],
                      'freeText': false,
                    },
                  ],
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        connection.emitEvent(
          const MessageWireEvent(
            seq: 2,
            message: AgentMessage(
              type: AgentMessageType.questionResolved,
              raw: {
                'type': 'question-resolved',
                'requestId': 'cm-2@00000000000000a2',
              },
            ),
          ),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(
            const Key('session-detail-question-outcome-cm-2@00000000000000a2'),
          ),
          findsOneWidget,
        );
        expect(find.text('Settled in your terminal.'), findsOneWidget);
        expect(find.text('Resolved in another client.'), findsNothing);
        expect(
          find.text(
            'This question is waiting in your terminal. Answer it there.',
          ),
          findsNothing,
        );
      },
    );
  });

  group('request resolution lifecycle in clean Chat (CR2)', () {
    const orphanResolutionEvents = [
      MessageWireEvent(
        seq: 1,
        message: AgentMessage(
          type: AgentMessageType.permissionResolved,
          raw: {
            'type': 'permission-resolved',
            'requestId': 'ghost-perm',
            'decision': 'reject',
          },
        ),
      ),
      MessageWireEvent(
        seq: 2,
        message: AgentMessage(
          type: AgentMessageType.questionResolved,
          raw: {'type': 'question-resolved', 'requestId': 'ghost-q'},
        ),
      ),
      MessageWireEvent(
        seq: 3,
        message: AgentMessage(
          type: AgentMessageType.modelOutput,
          raw: {
            'type': 'model-output',
            'key': 'a1',
            'text': 'Ordinary answer',
            'final': true,
          },
        ),
      ),
    ];

    testWidgets(
      'orphan resolution-only history renders no clean-Chat card',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: orphanResolutionEvents,
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        expect(find.text('Ordinary answer'), findsOneWidget);
        expect(find.text('Permission resolved'), findsNothing);
        expect(find.text('Question resolved'), findsNothing);
      },
    );

    testWidgets(
      'request plus resolution is one disabled card with its compact outcome '
      'and no standalone resolution row',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.permissionRequest,
                raw: {
                  'type': 'permission-request',
                  'requestId': 'perm-settled',
                  'permission': 'disk.write',
                },
              ),
            ),
            MessageWireEvent(
              seq: 2,
              message: AgentMessage(
                type: AgentMessageType.permissionResolved,
                raw: {
                  'type': 'permission-resolved',
                  'requestId': 'perm-settled',
                  'decision': 'approve',
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        // One request card, deactivated, with the decision-specific outcome.
        expect(find.text('Permission request'), findsOneWidget);
        expect(find.text('Permission resolved'), findsNothing);
        await tester.ensureVisible(
          find.byKey(
            const Key('session-detail-permission-approve-perm-settled'),
          ),
        );
        final approveButton = tester.widget<FilledButton>(
          find.byKey(
            const Key('session-detail-permission-approve-perm-settled'),
          ),
        );
        expect(approveButton.onPressed, isNull);
        expect(
          find.byKey(
            const Key('session-detail-permission-outcome-perm-settled'),
          ),
          findsOneWidget,
        );
        expect(find.text('Approved'), findsOneWidget);
        // And nothing beside it says the opposite. The outcome badge reports
        // THIS client's own submission, whose initial state is `pending`, so a
        // request answered anywhere else used to render "Approved" above the
        // buttons and "Pending" below them. Measured on the installed client.
        expect(
          find.text('Pending'),
          findsNothing,
          reason: 'a resolved request is not also pending',
        );
      },
    );

    testWidgets(
      'a resolution for one request id cannot cross-pair to another',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.userMessage,
                raw: {
                  'type': 'user-message',
                  'key': 'turn-a-user',
                  'text': 'First turn',
                },
              ),
            ),
            MessageWireEvent(
              seq: 2,
              message: AgentMessage(
                type: AgentMessageType.permissionRequest,
                raw: {'type': 'permission-request', 'requestId': 'perm-a'},
              ),
            ),
            MessageWireEvent(
              seq: 3,
              message: AgentMessage(
                type: AgentMessageType.modelOutput,
                raw: {
                  'type': 'model-output',
                  'key': 'turn-a-answer',
                  'text': 'First answer',
                  'final': true,
                },
              ),
            ),
            MessageWireEvent(
              seq: 4,
              message: AgentMessage(
                type: AgentMessageType.userMessage,
                raw: {
                  'type': 'user-message',
                  'key': 'turn-b-user',
                  'text': 'Second turn',
                },
              ),
            ),
            MessageWireEvent(
              seq: 5,
              message: AgentMessage(
                type: AgentMessageType.permissionRequest,
                raw: {'type': 'permission-request', 'requestId': 'perm-b'},
              ),
            ),
            // Resolves perm-a only — arriving after BOTH requests, in a
            // different turn position from its request.
            MessageWireEvent(
              seq: 6,
              message: AgentMessage(
                type: AgentMessageType.permissionResolved,
                raw: {
                  'type': 'permission-resolved',
                  'requestId': 'perm-a',
                  'decision': 'reject',
                },
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        final resolvedButton = tester.widget<FilledButton>(
          find.byKey(
            const Key('session-detail-permission-approve-perm-a'),
            skipOffstage: false,
          ),
        );
        expect(resolvedButton.onPressed, isNull);
        await tester.ensureVisible(
          find.byKey(
            const Key('session-detail-permission-approve-perm-b'),
            skipOffstage: false,
          ),
        );
        final pendingButton = tester.widget<FilledButton>(
          find.byKey(const Key('session-detail-permission-approve-perm-b')),
        );
        expect(pendingButton.onPressed, isNotNull);
      },
    );

    testWidgets(
      'Debug retains the canonical resolution frame when enabled',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: orphanResolutionEvents,
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            showDebugViews: true,
          ),
        );
        await tester.pumpAndSettle();

        await openSessionDetailTestTab(tester, 'session-detail-tab-debug');
        await tester.ensureVisible(
          find.byKey(const Key('debug-timeline-expander')),
        );
        await tester.tap(find.byKey(const Key('debug-timeline-expander')));
        await tester.pumpAndSettle();

        expect(
          find.text('message: permission-resolved', skipOffstage: false),
          findsOneWidget,
        );
        expect(
          find.text('message: question-resolved', skipOffstage: false),
          findsOneWidget,
        );
      },
    );
  });
}
