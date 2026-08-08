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
        expect(
          find.text('Resolved in another client.'),
          findsAtLeastNWidgets(1),
        );
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
        expect(find.textContaining('/workspace · bun test'), findsOneWidget);
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

      final approve = tester.widget<FilledButton>(
        find.byKey(
          const Key('session-detail-permission-approve-perm-read-only'),
        ),
      );
      final always = tester.widget<FilledButton>(
        find.byKey(
          const Key(
            'session-detail-permission-approve-session-perm-read-only',
          ),
        ),
      );
      expect(approve.onPressed, isNull);
      expect(always.onPressed, isNull);
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
