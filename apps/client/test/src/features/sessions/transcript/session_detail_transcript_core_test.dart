// Behavior files retain a common import set to keep split diffs mechanical.
// ignore_for_file: unused_import, unnecessary_import

import 'dart:async';
import 'dart:ui' show PointerDeviceKind;

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
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
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:cosyncing_client/src/platform/speech/speech_capabilities.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input.dart';
import 'package:cosyncing_client/src/platform/speech/speech_input_state.dart';
import 'package:cosyncing_client/src/platform/speech/speech_recognition_policy.dart';
import 'package:drift/native.dart';
import 'package:flutter/gestures.dart' show kSecondaryMouseButton;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/in_memory_session_display_preferences_store.dart';
import '../../../../support/in_memory_session_live_state_view_store.dart';
import '../../../../support/session_detail_page_test_harness.dart';

void main() {
  group('SessionDetailPage transcript rendering', () {
    testWidgets('shows a preloaded Terminal tab in the first frame', (
      tester,
    ) async {
      const terminalMessage = MessageWireEvent(
        seq: 1,
        message: AgentMessage(
          type: AgentMessageType.terminalOutput,
          id: 'preloaded-terminal',
          raw: {
            'type': 'terminal-output',
            'command': 'pwd',
            'output': '/workspace',
          },
        ),
      );
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
            events: [terminalMessage],
          ),
        ),
      );

      await withSessionDetailViewMenu(tester, () async {
        for (final name in const [
          'chat',
          'status',
          'terminal',
          'files',
        ]) {
          expect(
            find.byKey(Key('session-detail-view-item-$name')),
            findsOneWidget,
            reason: '$name should be a destination',
          );
        }
      });
    });

    testWidgets(
      'renders model and user messages with distinct alignment and colors',
      (tester) async {
        useRoomyTestViewport(tester);
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [
              const MessageWireEvent(
                seq: 1,
                message: AgentMessage(
                  type: AgentMessageType.modelOutput,
                  raw: {
                    'type': 'model-output',
                    'text': 'Model output summary',
                  },
                ),
              ),
              const MessageWireEvent(
                seq: 2,
                message: AgentMessage(
                  type: AgentMessageType.userMessage,
                  raw: {
                    'type': 'user-message',
                    'text': 'Hello user',
                  },
                ),
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        final modelAlign = tester
            .widget<Align>(
              find
                  .ancestor(
                    of: find.text(
                      'Model output summary',
                      skipOffstage: false,
                    ),
                    matching: find.byType(Align),
                  )
                  .first,
            )
            .alignment;

        await tester.drag(
          find.byKey(const Key('session-detail-chat-scroll')),
          const Offset(0, -180),
        );
        await tester.pumpAndSettle();

        final userAlign = tester
            .widget<Align>(
              find
                  .ancestor(
                    of: find.text('Hello user'),
                    matching: find.byType(Align),
                  )
                  .first,
            )
            .alignment;

        // C2: authorship is carried by alignment alone — model output stays
        // left, the user prompt sits right, and neither shows a `Model output`
        // or `User message` header.
        expect(modelAlign, Alignment.centerLeft);
        expect(userAlign, Alignment.centerRight);
        expect(find.text('Model output'), findsNothing);
        expect(find.text('User message'), findsNothing);
      },
    );

    testWidgets('one invocation renders one card despite interleaving', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            const MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.toolCall,
                raw: {
                  'type': 'tool-call',
                  'callId': 'call-1',
                  'name': 'search-files',
                  'arguments': {'query': 'docs'},
                },
              ),
            ),
            const MessageWireEvent(
              seq: 2,
              message: AgentMessage(
                type: AgentMessageType.tokenCount,
                raw: {'type': 'token-count', 'input': 4, 'output': 8},
              ),
            ),
            const MessageWireEvent(
              seq: 3,
              message: AgentMessage(
                type: AgentMessageType.toolResult,
                raw: {
                  'type': 'tool-result',
                  'callId': 'call-1',
                  'name': 'search-files',
                  'output': 'two matches',
                },
              ),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      // The call and its result collapse into a single paired row. C2 drops the
      // `Tool call/result/details` titles; one details toggle proves one row.
      expect(find.text('Tool details'), findsNothing);
      expect(find.text('Tool call details'), findsNothing);
      expect(find.text('Tool result details'), findsNothing);
      expect(find.byKey(const Key('tool-call-1-details')), findsOneWidget);
    });

    testWidgets('an orphan tool result still renders its own card', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            const MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.toolResult,
                raw: {
                  'type': 'tool-result',
                  'callId': 'call-truncated',
                  'name': 'search-files',
                  'output': 'result without its call',
                },
              ),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Tool result details'), findsNothing);
      expect(find.text('Tool details'), findsNothing);
      expect(
        find.byKey(const Key('tool-call-truncated-details')),
        findsOneWidget,
      );
    });

    testWidgets('renders expandable tool details', (tester) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            const MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.toolCall,
                raw: {
                  'type': 'tool-call',
                  'name': 'search-files',
                  'arguments': {'query': 'docs'},
                },
              ),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      tester
          .widget<InkWell>(find.byKey(const Key('tool-call-details')))
          .onTap!();
      await tester.pumpAndSettle();

      expect(find.text('query: docs', findRichText: true), findsOneWidget);
    });

    testWidgets('renders terminal output with monospace detail text', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            const MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.terminalOutput,
                id: 'term-1',
                raw: {
                  'type': 'terminal-output',
                  'command': 'printf',
                  'output': 'line 1\n  indented line 2',
                },
              ),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();
      await openSessionDetailTestTab(
        tester,
        'session-detail-tab-terminal',
      );

      final terminalText = tester
          .widgetList<SelectableText>(find.byType(SelectableText))
          .firstWhere((widget) => widget.data == 'line 1\n  indented line 2');
      expect(terminalText.style?.fontFamily, 'monospace');
      expect(
        find.text('line 1\n  indented line 2'),
        findsOneWidget,
      );
    });

    testWidgets(
      'renders permission and question request actions with request metadata',
      (
        tester,
      ) async {
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [
              const MessageWireEvent(
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
              const MessageWireEvent(
                seq: 2,
                message: AgentMessage(
                  type: AgentMessageType.questionRequest,
                  raw: {
                    'type': 'question-request',
                    'questionId': 'q-1',
                    'question': 'Proceed?',
                    'prompt': 'Continue with risky step?',
                  },
                ),
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        expect(find.textContaining('perm-1'), findsNothing);
        expect(find.textContaining('q-1'), findsNothing);
        expect(find.text('permission: disk.write'), findsAtLeastNWidgets(1));
        expect(
          find.text('reason: Need to write output'),
          findsAtLeastNWidgets(1),
        );
        expect(find.text('operation: create'), findsAtLeastNWidgets(1));
        expect(find.text('target: /tmp/report.txt'), findsAtLeastNWidgets(1));
        expect(find.text('question: Proceed?'), findsAtLeastNWidgets(1));
        expect(
          find.text('prompt: Continue with risky step?'),
          findsAtLeastNWidgets(1),
        );

        expect(
          find.byKey(
            const Key('session-detail-permission-approve-perm-1'),
          ),
          findsOneWidget,
        );
        expect(find.text('Reject'), findsOneWidget);
        expect(find.text('Allow'), findsOneWidget);
        expect(
          find.byKey(
            const Key('session-detail-question-answer-button-q-1'),
          ),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('session-detail-question-reject-q-1')),
          findsOneWidget,
        );
        expect(find.text('Dismiss'), findsOneWidget);
        expect(find.text('Submit'), findsOneWidget);
        expect(find.text('Pending'), findsNWidgets(2));
      },
    );

    testWidgets('keeps debug timeline out of default Chat tab', (tester) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          showDebugViews: true,
          events: [
            const NoticeWireEvent(message: 'agent ready'),
            const MessageWireEvent(
              seq: 2,
              message: AgentMessage(
                type: AgentMessageType.status,
                raw: {
                  'type': 'status',
                  'status': 'alive',
                },
              ),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Debug timeline'), findsNothing);
      expect(find.text('notice: agent ready'), findsNothing);

      await openSessionDetailTestTab(
        tester,
        'session-detail-tab-debug',
      );

      expect(find.text('Debug timeline'), findsOneWidget);
      expect(find.text('notice: agent ready'), findsNothing);
      expect(
        find.descendant(
          of: find.byKey(const Key('debug-timeline-expander')),
          matching: find.byType(SelectableText),
        ),
        findsOneWidget,
      );

      await tester.ensureVisible(
        find.byKey(const Key('debug-timeline-expander')),
      );
      await tester.drag(find.byType(ListView), const Offset(0, -240));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('debug-timeline-expander')));
      await tester.pumpAndSettle();

      expect(find.text('notice: agent ready'), findsOneWidget);
      expect(
        find.ancestor(
          of: find.text('notice: agent ready'),
          matching: find.byType(SelectionArea),
        ),
        findsOneWidget,
      );
      expect(find.text('session: '), findsNothing);
    });

    testWidgets('message menu copies, forks, and exposes broker metadata', (
      tester,
    ) async {
      final brokerClient = FakeBrokerClient();
      String? copiedText;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            final arguments = call.arguments;
            if (arguments is Map<Object?, Object?>) {
              copiedText = arguments['text'] as String?;
            }
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
      final timestamp = DateTime(2026, 7, 18, 14, 35).millisecondsSinceEpoch;
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          brokerClient: brokerClient,
          events: [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                id: 'message-42',
                type: AgentMessageType.userMessage,
                timestamp: timestamp,
                raw: const {
                  'type': 'user-message',
                  'text': 'Fork this point',
                },
              ),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      final region = find.byKey(
        const ValueKey('session-message-context-message-42'),
      );
      await tester.tap(
        region,
        buttons: kSecondaryMouseButton,
        kind: PointerDeviceKind.mouse,
      );
      await tester.pumpAndSettle();
      expect(find.text('Copy text'), findsOneWidget);
      expect(find.text('Fork from here'), findsOneWidget);
      expect(find.text('Details'), findsOneWidget);

      await tester.tap(find.text('Copy text'));
      await tester.pumpAndSettle();
      expect(copiedText, 'Fork this point');

      await tester.tap(
        region,
        buttons: kSecondaryMouseButton,
        kind: PointerDeviceKind.mouse,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Fork from here'));
      await tester.pumpAndSettle();
      expect(brokerClient.lastForkMessageId, 'message-42');

      await tester.tap(
        region,
        buttons: kSecondaryMouseButton,
        kind: PointerDeviceKind.mouse,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('Details'));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('session-message-details-dialog')),
        findsOneWidget,
      );
      expect(find.text('Type: user-message'), findsAtLeastNWidgets(1));
      expect(find.text('Message ID: message-42'), findsAtLeastNWidgets(1));
      expect(find.textContaining('Timestamp: 2026-07-18'), findsOneWidget);
    });

    testWidgets('selection long press owns the message context actions', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                id: 'selectable-message',
                type: AgentMessageType.modelOutput,
                raw: {
                  'type': 'assistant-message',
                  'text': 'Select this response',
                },
              ),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      await tester.longPress(find.text('Select this response'));
      await tester.pumpAndSettle();

      expect(find.text('Copy'), findsOneWidget);
      expect(find.text('Fork from here'), findsOneWidget);
      expect(find.text('Details'), findsOneWidget);
      expect(find.byType(SelectionArea), findsWidgets);
    });

    testWidgets(
      'selection copy and read aloud target only the selected range',
      (
        tester,
      ) async {
        useRoomyTestViewport(tester);
        const sourceText = 'Alpha beta gamma';
        String? copiedText;
        final speechOutput = RecordingSpeechOutput();
        addTearDown(speechOutput.close);
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          (call) async {
            if (call.method == 'Clipboard.setData') {
              final arguments = call.arguments;
              if (arguments is Map<Object?, Object?>) {
                copiedText = arguments['text'] as String?;
              }
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
          buildSessionDetailTestPage(
            speechOutput: speechOutput,
            events: const [
              MessageWireEvent(
                seq: 1,
                message: AgentMessage(
                  id: 'selected-range-message',
                  type: AgentMessageType.modelOutput,
                  raw: {
                    'type': 'model-output',
                    'key': 'selected-range-message',
                    'text': sourceText,
                    'final': true,
                  },
                ),
              ),
            ],
          ),
        );
        await tester.pumpAndSettle();

        await tester.longPress(find.text(sourceText));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Copy'));
        await tester.pumpAndSettle();

        expect(copiedText, isNotNull);
        expect(copiedText, isNotEmpty);
        expect(copiedText, isNot(sourceText));
        expect(sourceText, contains(copiedText));

        await tester.longPress(find.text(sourceText));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Read aloud'));
        await tester.pump();

        expect(speechOutput.spokenTexts, hasLength(1));
        final spokenText = speechOutput.spokenTexts.single;
        expect(spokenText, isNotEmpty);
        expect(spokenText, isNot(sourceText));
        expect(sourceText, contains(spokenText));
      },
    );

    for (final platform in const [
      TargetPlatform.macOS,
      TargetPlatform.windows,
    ]) {
      testWidgets(
        '${platform.name} selection menu exposes working read aloud',
        (tester) async {
          useRoomyTestViewport(tester);
          const sourceText = 'Desktop selected response';
          final speechOutput = RecordingSpeechOutput();
          addTearDown(speechOutput.close);
          final spec = themeSpecById(kDefaultThemeId);
          await tester.pumpWidget(
            buildSessionDetailTestPage(
              speechOutput: speechOutput,
              theme: buildAppTheme(
                spec.light,
                Brightness.light,
              ).copyWith(platform: platform),
              events: const [
                MessageWireEvent(
                  seq: 1,
                  message: AgentMessage(
                    id: 'desktop-selection-message',
                    type: AgentMessageType.modelOutput,
                    raw: {
                      'type': 'model-output',
                      'key': 'desktop-selection-message',
                      'text': sourceText,
                      'final': true,
                    },
                  ),
                ),
              ],
            ),
          );
          await tester.pumpAndSettle();

          await tester.longPress(find.text(sourceText));
          await tester.pumpAndSettle();
          expect(find.text('Read aloud'), findsOneWidget);
          await tester.tap(find.text('Read aloud'));
          await tester.pump();

          expect(speechOutput.spokenTexts, hasLength(1));
          expect(sourceText, contains(speechOutput.spokenTexts.single));
        },
      );
    }

    testWidgets(
      'selection does not pin an evicted transcript payload',
      (tester) async {
        useRoomyTestViewport(tester);
        const selectedText = 'Selected tail paragraph';
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [
              for (var i = 0; i < 80; i++) ...[
                MessageWireEvent(
                  seq: i * 2 + 1,
                  message: AgentMessage(
                    id: 'selection-user-$i',
                    type: AgentMessageType.userMessage,
                    raw: {
                      'type': 'user-message',
                      'key': 'selection-user-$i',
                      'text': 'Question $i',
                    },
                  ),
                ),
                MessageWireEvent(
                  seq: i * 2 + 2,
                  message: AgentMessage(
                    id: 'selection-model-$i',
                    type: AgentMessageType.modelOutput,
                    raw: {
                      'type': 'model-output',
                      'key': 'selection-model-$i',
                      'text': i == 79 ? selectedText : 'Answer $i',
                      'final': true,
                    },
                  ),
                ),
              ],
            ],
          ),
        );
        await tester.pumpAndSettle();

        await tester.longPress(find.text(selectedText));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Copy'));
        await tester.pumpAndSettle();

        tester
            .widget<ListView>(
              find.byKey(const Key('session-detail-chat-scroll')),
            )
            .controller!
            .jumpTo(0);
        await tester.pumpAndSettle();

        expect(
          find.text(selectedText, skipOffstage: false),
          findsNothing,
          reason: 'selection must not pin a row beyond the viewport cache',
        );
        expect(
          find.text('Answer 78', skipOffstage: false),
          findsNothing,
          reason: 'an adjacent unselected row should still be virtualized',
        );
        expect(
          find.byKey(const Key('session-selection-retained')),
          findsNothing,
        );
      },
    );

    testWidgets('message menu hides fork without the broker capability', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          brokerClient: FakeBrokerClient(
            agents: [fakeAgentInfo(canFork: false)],
          ),
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                id: 'no-fork-message',
                type: AgentMessageType.userMessage,
                raw: {'type': 'user-message', 'text': 'No fork capability'},
              ),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(
          const ValueKey('session-message-context-no-fork-message'),
        ),
        buttons: kSecondaryMouseButton,
        kind: PointerDeviceKind.mouse,
      );
      await tester.pumpAndSettle();

      expect(find.text('Copy text'), findsOneWidget);
      expect(find.text('Fork from here'), findsNothing);
      expect(find.text('Details'), findsOneWidget);
    });

    testWidgets('message menu hides fork for an agent-spawned session', (
      tester,
    ) async {
      // CR4: `canFork` from /api/agents is a TOOL capability and is TRUE here.
      // The per-session half is `SessionInfo.origin == subagent` — the same
      // protocol field the broker's SESSION_AGENT_OWNED fork gate reads.
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            agentOwnedSessionEvent(),
            const MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                id: 'child-message',
                type: AgentMessageType.userMessage,
                raw: {'type': 'user-message', 'text': 'Spawned by a parent'},
              ),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(const ValueKey('session-message-context-child-message')),
        buttons: kSecondaryMouseButton,
        kind: PointerDeviceKind.mouse,
      );
      await tester.pumpAndSettle();

      expect(find.text('Copy text'), findsOneWidget);
      expect(find.text('Fork from here'), findsNothing);
      expect(find.text('Details'), findsOneWidget);
    });

    testWidgets('message menu keeps fork for an exec-origin session', (
      tester,
    ) async {
      // Positive control on the NARROWNESS of the gate: `exec` is an automated
      // launch with no owning parent session, so it stays forkable. Without
      // this the test above would also pass for a gate that refused every
      // non-human origin.
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            agentOwnedSessionEvent(origin: 'exec'),
            const MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                id: 'exec-message',
                type: AgentMessageType.userMessage,
                raw: {'type': 'user-message', 'text': 'Started by codex exec'},
              ),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(const ValueKey('session-message-context-exec-message')),
        buttons: kSecondaryMouseButton,
        kind: PointerDeviceKind.mouse,
      );
      await tester.pumpAndSettle();

      expect(find.text('Fork from here'), findsOneWidget);
    });

    testWidgets('report view hides tools and expand all reveals details', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            const MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                id: 'user-1',
                type: AgentMessageType.userMessage,
                raw: {'type': 'user-message', 'text': 'Make a report'},
              ),
            ),
            const MessageWireEvent(
              seq: 2,
              message: AgentMessage(
                id: 'thinking-1',
                type: AgentMessageType.thinking,
                raw: {'type': 'thinking', 'text': 'Reasoning'},
              ),
            ),
            const MessageWireEvent(
              seq: 3,
              message: AgentMessage(
                id: 'tool-1',
                type: AgentMessageType.toolCall,
                raw: {
                  'type': 'tool-call',
                  'callId': 'tool-1',
                  'toolClass': 'execute',
                  'args': {'command': 'flutter test'},
                },
              ),
            ),
            const MessageWireEvent(
              seq: 4,
              message: AgentMessage(
                id: 'model-1',
                type: AgentMessageType.modelOutput,
                raw: {'type': 'model-output', 'text': 'Report ready'},
              ),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byKey(const ValueKey('tool-detail-args')), findsNothing);
      // Variant C moved both transcript toggles out of the composer and into
      // the strip's single overflow menu, as checkable items.
      await toggleSessionDetailViewOption(tester, 'expand');
      await withSessionDetailViewMenu(tester, () async {
        expect(
          find.descendant(
            of: find.byKey(const Key('session-detail-view-item-expand')),
            matching: find.byIcon(Icons.check_box_outlined),
          ),
          findsOneWidget,
        );
      });
      await tester.scrollUntilVisible(
        find.byKey(const ValueKey('tool-tool-1-details')),
        180,
        scrollable: find
            .descendant(
              of: find.byKey(const Key('session-detail-chat-scroll')),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('tool-tool-1-details')),
          matching: find.byIcon(Icons.expand_less),
        ),
        findsOneWidget,
      );

      await toggleSessionDetailViewOption(tester, 'report');
      expect(
        find.byKey(const ValueKey('session-message-context-user-1')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('session-message-context-model-1')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('session-message-context-thinking-1')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('session-message-context-tool-1')),
        findsNothing,
      );
    });

    testWidgets('archives live strips and revives changed action state', (
      tester,
    ) async {
      final store = InMemorySessionLiveStateViewStore();
      // One owned database for all three pumps. The harness builds its own per
      // call, so re-pumping the page here otherwise constructs a second and
      // third `AppDatabase` while the earlier ones are still open — the shape
      // drift warns about. Sharing one also matches what the rebuilds model: a
      // single app returning to the same session, not three installations.
      final database = AppDatabase(NativeDatabase.memory());
      addTearDown(database.close);
      MessageWireEvent goal(String status, String title) => MessageWireEvent(
        seq: 1,
        message: AgentMessage.fromJson({
          'type': 'goal-state',
          'key': 'current',
          'status': status,
          'title': title,
        }),
      );
      const stripKey = ValueKey('session-live-strip-goal:current');

      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [goal('paused', 'Waiting for review')],
          liveStateViewStore: store,
          database: database,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(stripKey), findsOneWidget);
      await tester.tap(
        find.byKey(
          const ValueKey('session-live-strip-archive-goal:current'),
        ),
      );
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pumpAndSettle();
      expect(find.byKey(stripKey), findsNothing);

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [goal('paused', 'Waiting for review')],
          liveStateViewStore: store,
          database: database,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(stripKey), findsNothing);

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pump();
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [goal('blocked', 'Needs a decision')],
          liveStateViewStore: store,
          database: database,
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(stripKey), findsOneWidget);
      expect(find.text('Needs a decision'), findsAtLeastNWidgets(1));
    });

    testWidgets('drag archives the last strip and collapses its gap', (
      tester,
    ) async {
      const stripKey = ValueKey('session-live-strip-task-list:plan');
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage.fromJson({
                'type': 'task-list-state',
                'key': 'plan',
                'status': 'running',
                'items': [
                  {'title': 'Swipe me', 'status': 'in-progress'},
                ],
              }),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      await tester.drag(find.byKey(stripKey), const Offset(110, 0));
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pumpAndSettle();

      expect(find.byKey(stripKey), findsNothing);
      expect(
        tester
            .getSize(
              find.byKey(const Key('session-live-state-surface')),
            )
            .height,
        0,
      );
    });

    testWidgets(
      'live progress preserves expansion and stays archived until action',
      (tester) async {
        MessageWireEvent tasks({
          required int seq,
          required int updatedAt,
          required String itemStatus,
          String key = 'plan',
          bool proposed = false,
        }) => MessageWireEvent(
          seq: seq,
          message: AgentMessage.fromJson({
            'type': 'task-list-state',
            'key': key,
            'status': 'running',
            'updatedAt': updatedAt,
            'items': [
              {
                'id': 'task-1',
                'title': 'Stable task detail',
                'status': itemStatus,
              },
            ],
            if (proposed)
              'semantic': {
                'kind': 'plan',
                'planKey': 'plan:stable',
                'revision': 'rev-$updatedAt',
                'state': 'proposed',
                'actions': {'approve': true, 'edit': true, 'exit': false},
              },
          }),
        );
        const stripKey = ValueKey('session-live-strip-task-list:plan');
        const fullKey = Key('session-task-list-state-task-list:plan');
        final connection = ScriptedSessionDetailConnection(
          events: [
            tasks(seq: 1, updatedAt: 1, itemStatus: 'open'),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        await tester.tap(find.byKey(stripKey));
        await tester.pumpAndSettle();
        expect(find.byKey(fullKey).hitTestable(), findsOneWidget);

        connection.emitEvent(
          tasks(seq: 2, updatedAt: 2, itemStatus: 'in-progress'),
        );
        await tester.pumpAndSettle();
        expect(find.byKey(fullKey).hitTestable(), findsOneWidget);

        await tester.tap(
          find.byKey(
            const ValueKey('session-live-strip-archive-task-list:plan'),
          ),
        );
        await tester.pump(const Duration(milliseconds: 300));
        await tester.pumpAndSettle();
        expect(find.byKey(stripKey), findsNothing);

        connection.emitEvent(
          tasks(seq: 3, updatedAt: 3, itemStatus: 'in-progress'),
        );
        await tester.pumpAndSettle();
        expect(find.byKey(stripKey), findsNothing);

        connection.emitEvent(
          tasks(
            seq: 4,
            updatedAt: 1,
            itemStatus: 'open',
            key: 'new-plan',
          ),
        );
        await tester.pumpAndSettle();
        expect(
          find.byKey(
            const ValueKey('session-live-strip-task-list:new-plan'),
          ),
          findsOneWidget,
        );

        connection.emitEvent(
          tasks(
            seq: 5,
            updatedAt: 4,
            itemStatus: 'in-progress',
            proposed: true,
          ),
        );
        await tester.pumpAndSettle();
        expect(find.byKey(stripKey), findsOneWidget);
        expect(find.byKey(fullKey).hitTestable(), findsOneWidget);
      },
    );

    testWidgets('permission mode picker sends the selected command option', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: const [
          OptionsWireEvent(
            models: [],
            agents: [],
            modes: [
              ModeOption(
                value: 'default',
                label: 'Ask each time',
                category: 'ask-permission',
              ),
              ModeOption(
                value: 'accept-edits',
                label: 'Accept edits',
                category: 'approve-for-me',
              ),
            ],
          ),
          CommandsWireEvent(commands: [SlashCommand(name: '/review')]),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(const Key('session-detail-permission-selector')),
      );
      await tester.pumpAndSettle();
      expect(find.text('Ask permission'), findsOneWidget);
      expect(find.text('Approve for me'), findsOneWidget);
      expect(
        find.byKey(
          const Key('session-detail-permission-scope-copy'),
        ),
        findsOneWidget,
      );
      await tester.tap(
        find.byKey(
          const ValueKey(
            'session-detail-permission-option-accept-edits',
          ),
        ),
      );
      await tester.pumpAndSettle();
      // The composer redesign moves the "· commands" qualifier to the tooltip;
      // the bar now shows the bare mode label.
      expect(find.text('Accept edits'), findsOneWidget);

      await openCommandPickerSheet(tester);
      await tester.tap(
        find.byKey(const Key('session-detail-command-picker')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('/review'));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const Key('session-detail-command-send-button')),
      );
      await tester.pumpAndSettle();
      expect(
        connection.lastCommandArgs,
        const {'permissionMode': 'accept-edits'},
      );
    });

    testWidgets('the picked permission mode also scopes an ordinary prompt', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: const [
          OptionsWireEvent(
            models: [],
            agents: [],
            modes: [
              ModeOption(value: 'manual', label: 'Manual approvals'),
              ModeOption(value: 'auto', label: 'Auto-approve tools'),
            ],
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(const Key('session-detail-permission-selector')),
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('session-detail-permission-option-auto')),
      );
      await tester.pumpAndSettle();
      expect(find.text('Auto-approve tools'), findsOneWidget);

      await tester.enterText(
        find.byKey(const Key('session-detail-prompt-input')),
        'do the thing',
      );
      await tester.pumpAndSettle();
      expect(find.text('do the thing'), findsWidgets);
      await tester.tap(find.byKey(const Key('session-detail-send-button')));
      await tester.pumpAndSettle();

      // The picker used to move slash commands only, so an ordinary prompt ran
      // under whatever mode the session held — the selector said one thing and
      // the prompt did another.
      expect(connection.lastPrompt, 'do the thing');
      expect(connection.lastPromptPermissionMode, 'auto');
    });

    testWidgets('a picker with nothing to pick reads as read-only', (
      tester,
    ) async {
      // A session that must show its model but offers no catalog to choose
      // from — a terminal-synced session, or an adapter advertising none.
      final connection = ScriptedSessionDetailConnection(
        events: [
          SessionWireEvent(
            info: SessionInfo.fromJson(const {
              'id': 'session-1',
              'tool': 'dsh',
              'title': 'Locked model',
              'status': 'idle',
              'attachMode': 'resume',
              'currentModel': {
                'providerID': 'deepseek',
                'modelID': 'deepseek-chat',
              },
              'control': {
                'drive': {'state': 'driving', 'supported': true},
                'terminalSync': {
                  'supported': false,
                  'syncAvailable': false,
                  'active': false,
                },
              },
            }),
          ),
          const OptionsWireEvent(models: [], agents: [], modes: []),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      final selector = find.byKey(const Key('session-detail-model-selector'));
      expect(selector, findsOneWidget);
      // The value stays visible — that part is a product requirement. What
      // must NOT stay is a dropdown chevron promising a menu no tap opens.
      expect(
        find.descendant(
          of: selector,
          matching: find.byIcon(Icons.keyboard_arrow_down),
        ),
        findsNothing,
      );
      final tooltip = tester.widget<Tooltip>(
        find.descendant(of: selector, matching: find.byType(Tooltip)),
      );
      expect(tooltip.message, contains('Read-only'));
    });

    testWidgets('the compact selection pip is the shared component', (
      tester,
    ) async {
      // A hand-rolled circle here drifts from every other status indicator the
      // moment one of them changes. The kit is the single definition.
      final connection = ScriptedSessionDetailConnection(
        events: const [
          OptionsWireEvent(
            models: [],
            agents: [],
            modes: [
              ModeOption(value: 'manual', label: 'Manual approvals'),
              ModeOption(value: 'auto', label: 'Auto-approve tools'),
            ],
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(const Key('session-detail-permission-selector')),
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('session-detail-permission-option-auto')),
      );
      await tester.pumpAndSettle();

      // Narrow enough for the composer's compact rendering, where the label is
      // hidden and the pip is the only signal that a mode is selected.
      tester.view
        ..physicalSize = const Size(420, 900)
        ..devicePixelRatio = 1;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });
      await tester.pumpAndSettle();

      final selector = find.byKey(
        const Key('session-detail-permission-selector'),
      );
      final dots = find.descendant(
        of: selector,
        matching: find.byType(StatusDot),
      );
      expect(
        dots,
        findsOneWidget,
        reason: 'the compact pip must be the shared component, not a Container',
      );
      expect(tester.widget<StatusDot>(dots.first).size, 8.0);
    });

    testWidgets('an offered picker keeps its chevron', (tester) async {
      // The negative control: the affordance must survive where it is real.
      final connection = ScriptedSessionDetailConnection(
        events: const [
          OptionsWireEvent(
            models: [
              ModelOption(
                providerID: 'anthropic',
                modelID: 'claude-haiku-4-5',
                label: 'Haiku',
              ),
            ],
            agents: [],
            modes: [],
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      expect(
        find.descendant(
          of: find.byKey(const Key('session-detail-model-selector')),
          matching: find.byIcon(Icons.keyboard_arrow_down),
        ),
        findsOneWidget,
      );
    });

    testWidgets('a prompt sent without a pick re-asserts no mode', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: const [
          OptionsWireEvent(
            models: [],
            agents: [],
            modes: [
              ModeOption(value: 'manual', label: 'Manual approvals'),
              ModeOption(value: 'auto', label: 'Auto-approve tools'),
            ],
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('session-detail-prompt-input')),
        'do the thing',
      );
      await tester.tap(find.byKey(const Key('session-detail-send-button')));
      await tester.pumpAndSettle();

      // Nothing was chosen, so nothing is claimed: re-asserting the session's
      // own mode on every prompt would silently outrank a change the server
      // made between two sends.
      expect(connection.lastPromptPermissionMode, isNull);
    });

    testWidgets('later broker mode state replaces a local command override', (
      tester,
    ) async {
      SessionWireEvent sessionMode(String mode) => SessionWireEvent(
        info: SessionInfo.fromJson({
          'id': 'session-1',
          'tool': 'claude',
          'title': 'Mode state',
          'status': 'idle',
          'attachMode': 'resume',
          'currentMode': mode,
          'control': const {
            'drive': {'state': 'driving', 'supported': true},
            'terminalSync': {
              'supported': false,
              'syncAvailable': false,
              'active': false,
            },
          },
        }),
      );
      const options = OptionsWireEvent(
        models: [],
        agents: [],
        modes: [
          ModeOption(value: 'default', label: 'Ask each time'),
          ModeOption(value: 'accept-edits', label: 'Accept edits'),
        ],
      );
      final connection = ScriptedSessionDetailConnection(
        events: [sessionMode('default'), options],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(const Key('session-detail-permission-selector')),
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(
          const ValueKey('session-detail-permission-option-accept-edits'),
        ),
      );
      await tester.pumpAndSettle();
      // "· commands" now lives in the tooltip, not the bar label.
      expect(find.text('Accept edits'), findsOneWidget);

      connection.emitEvent(sessionMode('accept-edits'));
      await tester.pumpAndSettle();
      connection.emitEvent(sessionMode('default'));
      await tester.pumpAndSettle();

      expect(find.text('Ask each time'), findsOneWidget);
    });

    testWidgets('defaults to Chat tab', (tester) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
        ),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-detail-tab-panel-chat')),
        findsOneWidget,
      );
      // Chat is the primary view, so the strip shows no sub-view back slot.
      expect(
        find.byKey(const Key('session-detail-view-back')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('session-detail-prompt-input')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-detail-send-button')),
        findsOneWidget,
      );
      expect(find.text('No messages in this session yet.'), findsOneWidget);
      expect(find.text('Debug timeline'), findsNothing);
    });

    // A freshly created/opened session shows an empty transcript while the
    // stream attaches; that surface must read as progress, not as a dead
    // page — the "frozen create" the owner reported twice (item 30).
    testWidgets(
      'an empty transcript waits for authoritative history while attaching',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: const [],
          autoConnect: false,
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            autoConnect: false,
            connection: connection,
          ),
        );
        await tester.pump();

        // Attach in flight: the surface communicates progress.
        // No pumpAndSettle: the indicator animates for as long as the attach
        // is genuinely outstanding.
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 50));

        expect(
          find.byKey(const Key('session-detail-bootstrap-blocking')),
          findsOneWidget,
        );
        expect(find.text('Loading session history…'), findsOneWidget);
        expect(find.text('No messages in this session yet.'), findsNothing);

        // A socket alone is not authoritative. The first history response is
        // what allows the genuine empty state to appear.
        connection.emitState(SessionDetailConnectionStatus.connected);
        await tester.pump();
        expect(
          find.byKey(const Key('session-detail-bootstrap-blocking')),
          findsOneWidget,
        );
        connection.emitEvent(
          const HistoryWireEvent(messages: [], reset: true),
        );
        await tester.pumpAndSettle();
        expect(find.text('No messages in this session yet.'), findsOneWidget);
      },
    );

    testWidgets(
      'a session without authoritative history does not claim to be empty',
      (tester) async {
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], autoConnect: false),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(const Key('session-detail-bootstrap-blocking')),
          findsOneWidget,
        );
        expect(find.text('No messages in this session yet.'), findsNothing);
      },
    );

    testWidgets(
      'a connected empty transcript keeps the plain empty state',
      (tester) async {
        await tester.pumpWidget(buildSessionDetailTestPage(events: const []));
        await tester.pumpAndSettle();

        expect(
          find.byKey(const Key('session-detail-bootstrap-blocking')),
          findsNothing,
        );
        expect(find.text('No messages in this session yet.'), findsOneWidget);
      },
    );

    // The affordance sits in the readable column, which is only ~388dp wide at
    // phone width — it must wrap rather than overflow its Row.
    testWidgets('the connecting affordance does not overflow at 420dp', (
      tester,
    ) async {
      tester.view
        ..physicalSize = const Size(420, 900)
        ..devicePixelRatio = 1;
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      final connection = ScriptedSessionDetailConnection(
        events: const [],
        autoConnect: false,
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          autoConnect: false,
          connection: connection,
        ),
      );
      await tester.pump();
      connection.emitState(SessionDetailConnectionStatus.connecting);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));

      expect(
        find.byKey(const Key('session-detail-bootstrap-blocking')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });

    // U3-C moved the fingerprint out of normal Status. Debug's identity card
    // is its home, and Debug is itself behind the default-off developer
    // preference — so the technical identity is preserved, not deleted, and it
    // no longer sits on the surface that answers "who controls this session".
    testWidgets('Status drops the fingerprint and Debug keeps it', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], showDebugViews: true),
      );
      await tester.pumpAndSettle();

      await openSessionDetailTestTab(tester, 'session-detail-tab-status');
      expect(
        find.byKey(const Key('session-detail-status-panel')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: find.byKey(const Key('session-detail-status-panel')),
          matching: find.textContaining('session-1'),
        ),
        findsNothing,
        reason: 'normal Status must expose no native session id',
      );

      await openSessionDetailTestTab(tester, 'session-detail-tab-debug');
      expect(
        find.byKey(const Key('session-detail-debug-identity')),
        findsOneWidget,
      );
      expect(find.text('claude / session-1'), findsOneWidget);
    });

    testWidgets('late Terminal insertion preserves the selected logical tab', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(events: const []);
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      await openSessionDetailTestTab(tester, 'session-detail-tab-files');

      expect(
        find.byKey(const Key('session-detail-tab-panel-files')).hitTestable(),
        findsOneWidget,
      );

      connection.emitEvent(
        const MessageWireEvent(
          seq: 1,
          message: AgentMessage(
            id: 'late-terminal',
            type: AgentMessageType.terminalOutput,
            raw: {
              'type': 'terminal-output',
              'command': 'printf late',
              'output': 'late output',
            },
          ),
        ),
      );
      await tester.pump();
      await tester.pumpAndSettle();

      // The new destination appears without stealing the view the user is on.
      await expectSessionDetailViewItem(
        tester,
        'terminal',
        matcher: findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-detail-tab-panel-files')).hitTestable(),
        findsOneWidget,
      );
    });

    testWidgets('renders Files tab with breadcrumbs and disabled symlink row', (
      tester,
    ) async {
      final brokerClient = FakeBrokerClient()
        ..fsListing = const FsDirectoryResult(
          path: 'src',
          stat: FsNodeInfo(
            path: 'src',
            type: 'directory',
            size: 0,
            mtimeMs: 0,
            isDirectory: true,
            isRegularFile: false,
            isSymbolicLink: false,
          ),
          entries: [
            FsDirEntry(
              name: 'notes.txt',
              path: 'src/notes.txt',
              type: 'file',
              size: 12,
              mtimeMs: 0,
            ),
            FsDirEntry(
              name: 'nested',
              path: 'src/nested',
              type: 'directory',
              size: 0,
              mtimeMs: 0,
            ),
            FsDirEntry(
              name: 'linked',
              path: 'src/linked',
              type: 'symlink',
              size: 0,
              mtimeMs: 0,
            ),
          ],
        );

      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          brokerClient: brokerClient,
        ),
      );
      await tester.pumpAndSettle();

      await expectSessionDetailViewItem(
        tester,
        'files',
        matcher: findsOneWidget,
      );
      await openSessionDetailTestTab(tester, 'session-detail-tab-files');
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-detail-tab-panel-files')),
        findsOneWidget,
      );
      expect(find.text('Produced by agent'), findsOneWidget);
      expect(find.text('Browse workspace'), findsOneWidget);
      expect(find.text('Workspace'), findsOneWidget);
      expect(find.text('src'), findsOneWidget);
      expect(find.text('nested'), findsOneWidget);
      expect(find.text('notes.txt'), findsOneWidget);
      expect(find.text('linked'), findsOneWidget);
      expect(
        tester
            .widget<ListTile>(
              find.byKey(const ValueKey('session-detail-files-row-src/linked')),
            )
            .enabled,
        isFalse,
      );
    });

    testWidgets('shows FS_REMOTE_DISABLED as Files empty state', (
      tester,
    ) async {
      final brokerClient = FakeBrokerClient()
        ..fsListError = const BrokerException(
          message: 'Request failed',
          statusCode: 403,
          error: BrokerError(
            error: 'Remote file access is disabled',
            code: 'FS_REMOTE_DISABLED',
          ),
        );

      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          brokerClient: brokerClient,
        ),
      );
      await tester.pumpAndSettle();
      await openSessionDetailTestTab(tester, 'session-detail-tab-files');
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-detail-files-remote-disabled-state')),
        findsOneWidget,
      );
      expect(
        find.text(
          'Remote file browsing is disabled by the Server administrator.',
        ),
        findsOneWidget,
      );
    });

    testWidgets(
      'exports transcript through confirmation and surfaces returned artifact',
      (tester) async {
        final brokerClient = FakeBrokerClient();
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            brokerClient: brokerClient,
          ),
        );
        await tester.pumpAndSettle();
        await openSessionDetailTestTab(tester, 'session-detail-tab-status');

        await showSessionStatusTestItem(
          tester,
          const Key('session-detail-export-transcript-button'),
        );

        final exportButton = find.byKey(
          const Key('session-detail-export-transcript-button'),
        );
        expect(exportButton, findsOneWidget);
        expect(
          tester.widget<ListTile>(exportButton).enabled,
          isTrue,
        );
        await tester.tap(exportButton);
        await tester.pumpAndSettle();

        expect(find.text('Export transcript'), findsAtLeastNWidgets(1));
        expect(find.text('Main Session'), findsOneWidget);
        expect(find.text('Format: html'), findsOneWidget);
        expect(find.text('Size cap: 5242880 bytes'), findsOneWidget);
        expect(find.text('Retention: 30 minutes'), findsOneWidget);
        expect(
          find.text(
            'Export a redacted html copy of the full transcript.',
          ),
          findsAtLeastNWidgets(1),
        );

        await tester.tap(
          find.byKey(const Key('session-detail-export-confirm')),
        );
        await tester.pumpAndSettle();

        expect(brokerClient.prepareTranscriptExportCount, 1);
        expect(brokerClient.exportTranscriptCount, 1);
        expect(
          find.text('Transcript export is ready in Files.'),
          findsOneWidget,
        );

        await openSessionDetailTestTab(
          tester,
          'session-detail-tab-artifacts',
        );

        expect(find.text('main-session.html'), findsOneWidget);
        expect(find.text('Download-only export'), findsOneWidget);
        expect(find.text('Format: html'), findsOneWidget);
        expect(find.text('Redaction: 3 secrets redacted'), findsOneWidget);
        expect(find.text('Preview'), findsNothing);
      },
    );

    testWidgets('disables transcript export when agent lacks capability', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          brokerClient: FakeBrokerClient(
            agents: [fakeAgentInfo(canTranscriptExport: false)],
          ),
        ),
      );
      await tester.pumpAndSettle();
      await openSessionDetailTestTab(tester, 'session-detail-tab-status');

      const exportKey = Key('session-detail-export-transcript-button');
      await showSessionStatusTestItem(tester, exportKey);
      final exportButton = find.byKey(exportKey);
      expect(exportButton, findsOneWidget);
      expect(tester.widget<ListTile>(exportButton).enabled, isFalse);
    });

    testWidgets(
      'shows fork and clone buttons enabled when capabilities are present',
      (tester) async {
        final brokerClient = FakeBrokerClient();
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            brokerClient: brokerClient,
          ),
        );
        await tester.pumpAndSettle();
        await openSessionDetailTestTab(tester, 'session-detail-tab-status');

        final forkButton = find.byKey(
          const Key('session-detail-fork-button'),
        );
        final cloneButton = find.byKey(
          const Key('session-detail-clone-button'),
        );
        expect(forkButton, findsOneWidget);
        expect(cloneButton, findsOneWidget);
        expect(tester.widget<ListTile>(forkButton).enabled, isTrue);
        expect(tester.widget<ListTile>(cloneButton).enabled, isTrue);
        expect(find.text('Detach'), findsOneWidget);
        expect(
          find.text(
            'Detach this device. The agent keeps running on the Server.',
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'status panel withholds fork for an agent-spawned session',
      (tester) async {
        // CR4: the same per-session gate as the message menu, at the header
        // entry point. Clone is the in-test positive control — it proves the
        // whole panel was not disabled for some unrelated reason (connection,
        // read-only compatibility, a missing broker client).
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: [agentOwnedSessionEvent()]),
        );
        await tester.pumpAndSettle();
        await openSessionDetailTestTab(tester, 'session-detail-tab-status');

        final forkButton = find.byKey(const Key('session-detail-fork-button'));
        final cloneButton = find.byKey(
          const Key('session-detail-clone-button'),
        );
        expect(tester.widget<ListTile>(forkButton).enabled, isFalse);
        expect(tester.widget<ListTile>(cloneButton).enabled, isTrue);
      },
    );

    testWidgets(
      'status panel keeps fork for an exec-origin session',
      (tester) async {
        // Narrowness control, as above: only `subagent` is agent-OWNED.
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [agentOwnedSessionEvent(origin: 'exec')],
          ),
        );
        await tester.pumpAndSettle();
        await openSessionDetailTestTab(tester, 'session-detail-tab-status');

        expect(
          tester
              .widget<ListTile>(
                find.byKey(const Key('session-detail-fork-button')),
              )
              .enabled,
          isTrue,
        );
      },
    );

    testWidgets(
      'the agent-owned fork refusal renders localized copy in each locale',
      (tester) async {
        // The coordinator's backstop stores a TYPED refusal, not a sentence, so
        // the words are resolved here. Running the same refusal through BOTH
        // shipped locales is what proves it is localized: an English-only
        // assertion would pass just as well against a hard-coded string.
        //
        // The refusal is reached programmatically on purpose — the Fork tile is
        // disabled for exactly this session shape, which is the whole reason
        // the backstop sits behind it.
        //
        // ONE explicitly-owned database for both pumps. The harness builds its
        // own in-memory `AppDatabase` per call, and the first is still open
        // when the second locale pumps, which is exactly the shape drift warns
        // about ("created the database class AppDatabase multiple times"). The
        // warning is real, not noise, and silencing it globally would hide it
        // everywhere else too — so the test owns the instance instead.
        final database = AppDatabase(NativeDatabase.memory());
        addTearDown(database.close);
        Future<String?> refusalTextFor(Locale locale) async {
          await tester.pumpWidget(
            buildSessionDetailTestPage(
              events: [agentOwnedSessionEvent()],
              locale: locale,
              database: database,
            ),
          );
          await tester.pumpAndSettle();
          await openSessionDetailTestTab(tester, 'session-detail-tab-status');
          await ProviderScope.containerOf(
                tester.element(find.byType(SessionDetailPage)),
              )
              .read(
                sessionDetailControllerProvider(
                  const SessionDetailKey(
                    tool: 'claude',
                    sessionId: 'session-1',
                  ),
                ).notifier,
              )
              .forkSession();
          await tester.pumpAndSettle();
          // The status panel is a lazily built ListView, so the refusal line
          // below the Fork tile has to be scrolled into existence.
          await showSessionStatusTestItem(
            tester,
            const Key('session-detail-fork-session-status'),
          );
          return tester
              .widget<SelectableText>(
                find.byKey(const Key('session-detail-fork-session-status')),
              )
              .data;
        }

        final english = await refusalTextFor(const Locale('en'));
        final chinese = await refusalTextFor(const Locale('zh'));

        expect(
          english,
          lookupAppLocalizations(
            const Locale('en'),
          ).sessionForkAgentOwnedRefusal,
        );
        expect(
          chinese,
          lookupAppLocalizations(
            const Locale('zh'),
          ).sessionForkAgentOwnedRefusal,
        );
        expect(chinese, isNot(english));
      },
    );

    testWidgets(
      'a broker-refused fork surfaces the localized refusal as a SnackBar',
      (tester) async {
        // CR4. The refusal's only other home is the Status panel's fork status
        // line, and the callers the backstop exists for — a restored intent, a
        // deep link, a stale Chat-tab widget — are not looking at it, so the
        // failure was silent where it happened.
        //
        // Driven through the REAL affordance, which means the session must not
        // be locally agent-owned (`exec` origin keeps the Fork tile enabled).
        // That is also the exact shape of the defect: no local lineage, so only
        // the broker can refuse, and it does so with a typed 409.
        //
        // Asserted in ZH on purpose. An English assertion would pass just as
        // well against a hard-coded English literal in the SnackBar; only the
        // other shipped locale proves the copy is resolved from
        // `AppLocalizations`.
        const locale = Locale('zh');
        final refusalCopy = lookupAppLocalizations(
          locale,
        ).sessionForkAgentOwnedRefusal;
        expect(
          refusalCopy,
          isNot(
            lookupAppLocalizations(
              const Locale('en'),
            ).sessionForkAgentOwnedRefusal,
          ),
          reason: 'the locales must differ or this test proves nothing',
        );
        final brokerClient = FakeBrokerClient()
          ..forkError = const BrokerException(
            message: 'Broker rejected the fork.',
            statusCode: 409,
            error: BrokerError(
              error:
                  'This session was spawned by another agent session; fork '
                  'its parent instead.',
              code: 'SESSION_AGENT_OWNED',
            ),
          );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [agentOwnedSessionEvent(origin: 'exec')],
            brokerClient: brokerClient,
            locale: locale,
          ),
        );
        await tester.pumpAndSettle();
        await openSessionDetailTestTab(tester, 'session-detail-tab-status');

        final forkButton = find.byKey(const Key('session-detail-fork-button'));
        expect(tester.widget<ListTile>(forkButton).enabled, isTrue);
        await tester.tap(forkButton);
        await tester.pumpAndSettle();

        expect(brokerClient.forkSessionCount, 1);
        // Scoped to the SnackBar: the same words also render in the status
        // line below the tile, so an unscoped `find.text` would pass without
        // any transient feedback existing at all.
        expect(
          find.descendant(
            of: find.byType(SnackBar),
            matching: find.text(refusalCopy),
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'a broker-refused fork withdraws the Fork tile and stops the retry',
      (tester) async {
        // CR4. With no local lineage (`exec` origin) the broker's typed 409 is
        // the ONLY refusal available, and the controller records it as
        // standing. The tile used to read `isAgentOwnedSession` alone, so it
        // kept offering an action the controller had already refused: every
        // tap produced another refusal SnackBar and no request. Both gates now
        // answer the shared `forkBlockedAsAgentOwned` predicate.
        final brokerClient = FakeBrokerClient()
          ..forkError = const BrokerException(
            message: 'Broker rejected the fork.',
            statusCode: 409,
            error: BrokerError(
              error:
                  'This session was spawned by another agent session; fork '
                  'its parent instead.',
              code: 'SESSION_AGENT_OWNED',
            ),
          );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: [agentOwnedSessionEvent(origin: 'exec')],
            brokerClient: brokerClient,
          ),
        );
        await tester.pumpAndSettle();
        await openSessionDetailTestTab(tester, 'session-detail-tab-status');

        final forkTile = find.byKey(const Key('session-detail-fork-button'));
        // Baseline: the tile really is live before the refusal, so "disabled"
        // below cannot pass for an unrelated reason.
        expect(tester.widget<ListTile>(forkTile).enabled, isTrue);

        await tester.tap(forkTile);
        await tester.pumpAndSettle();
        expect(brokerClient.forkSessionCount, 1);
        expect(tester.widget<ListTile>(forkTile).enabled, isFalse);

        // A programmatic retry — the caller class this backstop exists for —
        // still posts nothing.
        await ProviderScope.containerOf(
              tester.element(find.byType(SessionDetailPage)),
            )
            .read(
              sessionDetailControllerProvider(
                const SessionDetailKey(tool: 'claude', sessionId: 'session-1'),
              ).notifier,
            )
            .forkSession();
        await tester.pumpAndSettle();
        expect(brokerClient.forkSessionCount, 1);
      },
    );

    testWidgets(
      'a broker-refused fork withdraws "Fork from here" until a frame '
      'reclassifies the session',
      (tester) async {
        // The Chat-tab half of the same predicate. The baseline that an
        // `exec`-origin session DOES offer this menu item is the neighbouring
        // 'message menu keeps fork for an exec-origin session' test, so this
        // one starts from the refusal and proves the transition back.
        final brokerClient = FakeBrokerClient()
          ..forkError = const BrokerException(
            message: 'Broker rejected the fork.',
            statusCode: 409,
            error: BrokerError(
              error:
                  'This session was spawned by another agent session; fork '
                  'its parent instead.',
              code: 'SESSION_AGENT_OWNED',
            ),
          );
        final connection = ScriptedSessionDetailConnection(
          events: [
            agentOwnedSessionEvent(origin: 'exec'),
            const MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                id: 'refused-message',
                type: AgentMessageType.userMessage,
                raw: {'type': 'user-message', 'text': 'Forkable until refused'},
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            brokerClient: brokerClient,
          ),
        );
        await tester.pumpAndSettle();
        await openSessionDetailTestTab(tester, 'session-detail-tab-status');
        await tester.tap(find.byKey(const Key('session-detail-fork-button')));
        await tester.pumpAndSettle();
        expect(brokerClient.forkSessionCount, 1);

        Future<void> openMessageMenu() async {
          await tester.tap(
            find.byKey(
              const ValueKey('session-message-context-refused-message'),
            ),
            buttons: kSecondaryMouseButton,
            kind: PointerDeviceKind.mouse,
          );
          await tester.pumpAndSettle();
        }

        await openSessionDetailTestTab(tester, 'session-detail-tab-chat');
        await openMessageMenu();
        expect(find.text('Copy text'), findsOneWidget);
        expect(find.text('Fork from here'), findsNothing);
        // Dismiss the menu's modal barrier before the transition.
        await tester.tapAt(const Offset(4, 4));
        await tester.pumpAndSettle();

        // A newer AUTHORITATIVE frame clears the standing refusal.
        connection.emitEvent(agentOwnedSessionEvent(origin: 'exec'));
        await tester.pumpAndSettle();

        await openMessageMenu();
        expect(find.text('Fork from here'), findsOneWidget);
      },
    );

    testWidgets(
      'a reclassifying session frame clears the refusal and re-enables Fork',
      (tester) async {
        // CR4. `sessionInfo` is replaced on every session frame, so the Fork
        // tile re-enables the moment the session stops being `subagent` — but
        // the refusal line underneath it used to survive, leaving an enabled
        // control above text saying the action is impossible.
        final connection = ScriptedSessionDetailConnection(
          events: [agentOwnedSessionEvent()],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();
        await openSessionDetailTestTab(tester, 'session-detail-tab-status');
        await ProviderScope.containerOf(
              tester.element(find.byType(SessionDetailPage)),
            )
            .read(
              sessionDetailControllerProvider(
                const SessionDetailKey(tool: 'claude', sessionId: 'session-1'),
              ).notifier,
            )
            .forkSession();
        await tester.pumpAndSettle();
        await showSessionStatusTestItem(
          tester,
          const Key('session-detail-fork-session-status'),
        );
        // Baseline: the refusal really is standing and the tile really is
        // withheld, so the transition below has something to clear.
        expect(
          find.byKey(const Key('session-detail-fork-session-status')),
          findsOneWidget,
        );
        expect(
          tester
              .widget<ListTile>(
                find.byKey(const Key('session-detail-fork-button')),
              )
              .enabled,
          isFalse,
        );

        // A newer AUTHORITATIVE frame reclassifies the session.
        connection.emitEvent(agentOwnedSessionEvent(origin: 'exec'));
        await tester.pumpAndSettle();

        expect(
          tester
              .widget<ListTile>(
                find.byKey(const Key('session-detail-fork-button')),
              )
              .enabled,
          isTrue,
        );
        expect(
          find.byKey(const Key('session-detail-fork-session-status')),
          findsNothing,
        );
      },
    );

    testWidgets('read aloud starts from the message context menu', (
      tester,
    ) async {
      final speechOutput = RecordingSpeechOutput();
      addTearDown(speechOutput.close);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          speechOutput: speechOutput,
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                id: 'model-9',
                type: AgentMessageType.modelOutput,
                raw: {
                  'type': 'model-output',
                  'key': 'turn-9',
                  'text': 'The gates are green.',
                  'final': true,
                },
              ),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      // No always-visible 48px button on the message any more.
      expect(find.byKey(const ValueKey('read-aloud-turn-9')), findsNothing);

      final region = find.byKey(
        const ValueKey('session-message-context-model-9'),
      );
      await tester.tap(
        region,
        buttons: kSecondaryMouseButton,
        kind: PointerDeviceKind.mouse,
      );
      await tester.pumpAndSettle();
      expect(find.text('Read aloud'), findsOneWidget);

      await tester.tap(find.text('Read aloud'));
      await tester.pumpAndSettle();

      // The per-message context menu still speaks the single message; C2 moves
      // the always-visible inline control to the turn footer.
      expect(speechOutput.spokenMessageKeys, ['turn-9']);
    });
  });
}
