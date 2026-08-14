// Behavior files retain a common import set to keep split diffs mechanical.
// ignore_for_file: unused_import, unnecessary_import

import 'dart:async';
import 'dart:ui' show PointerDeviceKind;

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
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
  group('SessionDetailPage composer bottom bar', () {
    SessionWireEvent sessionEvent({
      required Map<String, dynamic> control,
      Map<String, dynamic>? currentModel,
      String? currentAgent,
      String? lineageId,
      String status = 'idle',
    }) {
      return SessionWireEvent(
        info: SessionInfo.fromJson({
          'id': 'session-1',
          'tool': 'claude',
          'title': 'Model controls',
          'status': status,
          'attachMode': 'observe',
          if (lineageId != null) 'lineageId': lineageId,
          if (currentModel != null) 'currentModel': currentModel,
          if (currentAgent != null) 'currentAgent': currentAgent,
          'control': control,
        }),
      );
    }

    const models = [
      ModelOption(
        providerID: 'openai',
        modelID: 'gpt-5.4',
        label: 'GPT-5.4',
        reasoningEfforts: [
          ReasoningEffort(effort: 'low', label: 'Low'),
          ReasoningEffort(effort: 'high', label: 'High'),
        ],
        defaultReasoningEffort: 'low',
      ),
      ModelOption(
        providerID: 'anthropic',
        modelID: 'claude-opus-4-6',
        label: 'Claude Opus 4.6',
        reasoningEfforts: [
          ReasoningEffort(effort: 'high', label: 'High'),
          ReasoningEffort(effort: 'max', label: 'Max'),
        ],
        defaultReasoningEffort: 'high',
      ),
    ];

    const codexUltraModels = [
      ModelOption(
        providerID: 'openai',
        modelID: 'gpt-5.6-sol',
        label: 'GPT-5.6 Sol',
        reasoningEfforts: [
          ReasoningEffort(effort: 'low', label: 'Low'),
          ReasoningEffort(effort: 'medium', label: 'Medium'),
          ReasoningEffort(effort: 'max', label: 'Max'),
          ReasoningEffort(
            effort: 'ultra',
            label: 'Ultra',
            description: 'Maximum reasoning with automatic task delegation',
          ),
        ],
        defaultReasoningEffort: 'medium',
      ),
      ModelOption(
        providerID: 'openai',
        modelID: 'gpt-5.6-luna',
        label: 'GPT-5.6 Luna',
        reasoningEfforts: [
          ReasoningEffort(effort: 'low', label: 'Low'),
          ReasoningEffort(effort: 'medium', label: 'Medium'),
          ReasoningEffort(effort: 'max', label: 'Max'),
        ],
        defaultReasoningEffort: 'medium',
      ),
    ];

    const drivingControl = {
      'drive': {'state': 'driving', 'supported': true},
      'terminalSync': {
        'supported': false,
        'syncAvailable': false,
        'active': false,
      },
    };

    const observingControl = {
      'drive': {'state': 'observing', 'supported': true},
      'terminalSync': {
        'supported': false,
        'syncAvailable': false,
        'active': false,
      },
    };

    Future<void> selectModelAndEffort(
      WidgetTester tester, {
      required String modelKey,
      required String effort,
    }) async {
      await tester.tap(
        find.byKey(const Key('session-detail-model-selector')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(Key(modelKey)));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(Key('session-detail-effort-option-$effort')),
      );
      await tester.pumpAndSettle();
    }

    testWidgets('shows authoritative model, effort, and status controls', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(
            control: drivingControl,
            currentModel: const {
              'providerID': 'openai',
              'modelID': 'gpt-5.4',
              'reasoningEffort': 'low',
            },
          ),
          const OptionsWireEvent(models: models, agents: []),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-detail-composer-bottom-bar')),
        findsOneWidget,
      );
      expect(find.text('GPT-5.4'), findsOneWidget);
      expect(
        find.byKey(const Key('session-detail-bottom-status-button')),
        findsOneWidget,
      );
    });

    testWidgets(
      'compatibility notice is localized and selectable',
      (
        tester,
      ) async {
        const brokerContract = BrokerContractIdentity(
          revision: 6,
          minimumClientRevision: 0,
          surfaceHash: 'fnv1a32:095fc995',
        );
        final connection = ScriptedSessionDetailConnection(
          events: [
            sessionEvent(control: observingControl),
            const HelloWireEvent(
              brokerVersion: '0.1.0',
              brokerContract: brokerContract,
              compatibility: BrokerClientCompatibility(
                status: BrokerClientCompatibilityStatus.hardIncompatible,
                readOnly: true,
                reason: 'equal revisions advertise different public surfaces',
                broker: brokerContract,
              ),
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        final notice = find.byKey(
          const Key('session-detail-compatibility-notice'),
        );
        final selectionArea = find.descendant(
          of: notice,
          matching: find.byType(SelectionArea),
        );
        final l10n = AppLocalizations.of(tester.element(notice));

        expect(notice, findsOneWidget);
        expect(selectionArea, findsOneWidget);
        expect(
          find.descendant(
            of: notice,
            matching: find.text(l10n.sessionCompatibilityHardIncompatible),
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets('writable client-behind overlap has no session notice', (
      tester,
    ) async {
      const brokerContract = BrokerContractIdentity(
        revision: 6,
        minimumClientRevision: 0,
        surfaceHash: 'fnv1a32:095fc995',
      );
      final connection = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(control: observingControl),
          const HelloWireEvent(
            brokerVersion: '0.1.0',
            brokerContract: brokerContract,
            compatibility: BrokerClientCompatibility(
              status: BrokerClientCompatibilityStatus.clientBehind,
              readOnly: false,
              reason: 'client contract 5 is one revision behind broker 6',
              broker: brokerContract,
            ),
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-detail-compatibility-notice')),
        findsNothing,
      );
    });

    testWidgets('shows interrupt only for an advertised working turn', (
      tester,
    ) async {
      final unsupported = ScriptedSessionDetailConnection(
        events: [sessionEvent(control: drivingControl, status: 'working')],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: unsupported),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-detail-interrupt-button')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('session-detail-send-button')),
        findsOneWidget,
      );

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();

      final readOnly = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(control: observingControl, status: 'working'),
          const CommandsWireEvent(
            commands: [
              SlashCommand(name: 'stop', kind: SlashCommandKind.action),
            ],
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: readOnly),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('session-detail-interrupt-button')),
        findsNothing,
      );

      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();

      final supported = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(control: drivingControl, status: 'working'),
          const CommandsWireEvent(
            commands: [
              SlashCommand(name: 'stop', kind: SlashCommandKind.action),
            ],
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: supported),
      );
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('session-detail-interrupt-button')),
        findsOneWidget,
      );
      // Send stays available during a working turn so a prompt can be
      // queued/steered; the controller and broker support mid-turn sends.
      expect(
        find.byKey(const Key('session-detail-send-button')),
        findsOneWidget,
      );
    });

    testWidgets(
      'queues a steer prompt during a working turn without interrupting',
      (tester) async {
        // Regression guard for F3: Send must remain tappable during a working
        // turn on an interrupt-capable agent so a prompt can be queued/steered.
        // The controller tags the optimistic prompt as queued when the session
        // is working; the broker and adapters (Claude queuedSends, Codex
        // bootstrapQueue, Pi) all support mid-turn delivery.
        final connection = ScriptedSessionDetailConnection(
          events: [
            sessionEvent(control: drivingControl, status: 'working'),
            const CommandsWireEvent(
              commands: [
                SlashCommand(name: 'stop', kind: SlashCommandKind.action),
              ],
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        // Both buttons render during working.
        expect(
          find.byKey(const Key('session-detail-interrupt-button')),
          findsOneWidget,
        );
        final sendFinder = find.byKey(const Key('session-detail-send-button'));
        expect(sendFinder, findsOneWidget);

        // Type a steer prompt. Send becomes tappable (effectiveCanSend is true
        // once text is non-empty and we are outside the brief HTTP window).
        await tester.enterText(
          find.byKey(const Key('session-detail-prompt-input')),
          'steer this turn',
        );
        await tester.pump();
        expect(tester.widget<IconButton>(sendFinder).onPressed, isNotNull);

        // Tapping Send must deliver the prompt - not trigger an interrupt.
        await tester.tap(sendFinder);
        await tester.pumpAndSettle();

        expect(connection.sendPromptCount, 1);
        expect(connection.lastPrompt, 'steer this turn');
        // The interrupt command was NOT invoked.
        expect(connection.sendCommandCount, 0);
      },
    );

    testWidgets('interrupt restores the accepted prompt without replaying it', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(control: drivingControl),
          const CommandsWireEvent(
            commands: [
              SlashCommand(name: '/stop', kind: SlashCommandKind.action),
            ],
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      final prompt = find.byKey(const Key('session-detail-prompt-input'));
      await tester.enterText(prompt, 'revise this prompt');
      await tester.pump();
      await tester.tap(find.byKey(const Key('session-detail-send-button')));
      await tester.pumpAndSettle();
      expect(connection.lastPrompt, 'revise this prompt');
      expect(tester.widget<TextField>(prompt).controller?.text, isEmpty);

      connection.emitSessionControl(drivingControl, status: 'working');
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const Key('session-detail-interrupt-button')),
      );
      await tester.pumpAndSettle();

      expect(connection.sendCommandCount, 1);
      expect(connection.lastCommandName, '/stop');
      expect(
        tester.widget<TextField>(prompt).controller?.text,
        'revise this prompt',
      );
    });

    testWidgets('normal completion clears the interrupt restore prompt', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(control: drivingControl),
          const CommandsWireEvent(
            commands: [
              SlashCommand(name: 'stop', kind: SlashCommandKind.action),
            ],
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      final prompt = find.byKey(const Key('session-detail-prompt-input'));
      await tester.enterText(prompt, 'completed prompt');
      await tester.pump();
      await tester.tap(find.byKey(const Key('session-detail-send-button')));
      await tester.pumpAndSettle();

      connection.emitSessionControl(drivingControl, status: 'working');
      await tester.pumpAndSettle();
      connection.emitSessionControl(drivingControl);
      await tester.pumpAndSettle();
      connection.emitSessionControl(drivingControl, status: 'working');
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const Key('session-detail-interrupt-button')),
      );
      await tester.pumpAndSettle();

      expect(connection.sendCommandCount, 1);
      expect(tester.widget<TextField>(prompt).controller?.text, isEmpty);
    });

    testWidgets('failed interrupt reports the failure and allows retry', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(control: drivingControl, status: 'working'),
          const CommandsWireEvent(
            commands: [
              SlashCommand(name: 'stop', kind: SlashCommandKind.action),
            ],
          ),
        ],
      )..failNextCommand = true;
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      final interrupt = find.byKey(
        const Key('session-detail-interrupt-button'),
      );
      await tester.tap(interrupt);
      await tester.pumpAndSettle();

      expect(connection.sendCommandCount, 1);
      expect(
        find.text('Could not interrupt the current turn. Try again.'),
        findsOneWidget,
      );
      expect(tester.widget<IconButton>(interrupt).onPressed, isNotNull);

      // The fixed SnackBar occupies the composer's bottom-right hit region in
      // this compact test viewport. Dismiss the transient feedback before
      // tapping again; the assertion above proves the production control was
      // re-enabled immediately after the failed transport write.
      ScaffoldMessenger.of(
        tester.element(interrupt),
      ).hideCurrentSnackBar();
      await tester.pumpAndSettle();

      await tester.tap(interrupt);
      await tester.pumpAndSettle();
      expect(connection.sendCommandCount, 2);
    });

    testWidgets('interrupt control uses semantic tokens in light and dark', (
      tester,
    ) async {
      final spec = themeSpecById(kDefaultThemeId);
      for (final brightness in Brightness.values) {
        final tokens = brightness == Brightness.dark ? spec.dark : spec.light;
        final connection = ScriptedSessionDetailConnection(
          events: [
            sessionEvent(control: drivingControl, status: 'working'),
            const CommandsWireEvent(
              commands: [
                SlashCommand(name: 'stop', kind: SlashCommandKind.action),
              ],
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            theme: buildAppTheme(tokens, brightness),
          ),
        );
        await tester.pumpAndSettle();

        final button = tester.widget<IconButton>(
          find.byKey(const Key('session-detail-interrupt-button')),
        );
        expect(button.style?.backgroundColor?.resolve({}), tokens.statusError);

        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pumpAndSettle();
      }
    });

    testWidgets('Escape closes the slash palette before interrupting', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(control: drivingControl, status: 'working'),
          const CommandsWireEvent(
            commands: [
              SlashCommand(name: 'stop', kind: SlashCommandKind.action),
              SlashCommand(name: 'goal', kind: SlashCommandKind.prompt),
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
        '/',
      );
      await tester.pump();
      expect(
        find.byKey(const Key('session-detail-slash-palette')),
        findsOneWidget,
      );

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(connection.sendCommandCount, 0);
      expect(
        find.byKey(const Key('session-detail-slash-palette')),
        findsNothing,
      );

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(connection.sendCommandCount, 1);
      expect(connection.lastCommandName, 'stop');
    });

    testWidgets('effort picker back returns to the model picker', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(
            control: drivingControl,
            currentModel: const {
              'providerID': 'openai',
              'modelID': 'gpt-5.4',
              'reasoningEffort': 'low',
            },
          ),
          const OptionsWireEvent(models: models, agents: []),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(const Key('session-detail-model-selector')),
      );
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(
          const Key(
            'session-detail-model-option-anthropic/claude-opus-4-6/',
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Reasoning effort'), findsOneWidget);

      await tester.tap(
        find.byKey(const Key('session-detail-effort-back')),
      );
      await tester.pumpAndSettle();

      expect(find.text('Choose model'), findsOneWidget);
      expect(
        find.byKey(const Key('session-detail-model-filter')),
        findsOneWidget,
      );
    });

    testWidgets(
      'model picker keeps every distinct provider/model, even when two '
      'providers share a modelID',
      (tester) async {
        // Regression guard: the model list must stay keyed by
        // providerID + modelID + variant, matching the OpenCode adapter. A
        // modelID-only collapse would drop volcengine-plan/glm-5.2 behind
        // lab-litellm/glm-5.2, and could hide the official LongCat behind a
        // gateway LongCat of the same modelID. Every distinct triple the broker
        // advertises must reach the picker.
        useRoomyTestViewport(tester);
        const catalog = [
          ModelOption(
            providerID: 'opencode',
            modelID: 'grok-code',
            label: 'opencode · grok-code',
          ),
          ModelOption(
            providerID: 'volcengine-plan',
            modelID: 'glm-5.2',
            label: 'volcengine-plan · glm-5.2',
          ),
          ModelOption(
            providerID: 'lab-litellm',
            modelID: 'glm-5.2',
            label: 'lab-litellm · glm-5.2',
          ),
          ModelOption(
            providerID: 'volcengine-plan',
            modelID: 'doubao-seed-code',
            label: 'volcengine-plan · doubao-seed-code',
          ),
          ModelOption(
            providerID: 'LongCat',
            modelID: 'LongCat-2.0',
            label: 'LongCat · LongCat-2.0',
          ),
        ];
        final connection = ScriptedSessionDetailConnection(
          events: const [OptionsWireEvent(models: catalog, agents: [])],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        await tester.tap(
          find.byKey(const Key('session-detail-model-selector')),
        );
        await tester.pumpAndSettle();

        for (final key in const [
          'session-detail-model-option-volcengine-plan/glm-5.2/',
          'session-detail-model-option-lab-litellm/glm-5.2/',
          'session-detail-model-option-volcengine-plan/doubao-seed-code/',
          'session-detail-model-option-LongCat/LongCat-2.0/',
        ]) {
          expect(
            find.byKey(Key(key)),
            findsOneWidget,
            reason: 'model picker dropped $key',
          );
        }
      },
    );

    testWidgets('restores an exact model preference for the session lineage', (
      tester,
    ) async {
      final store = InMemorySessionModelPreferenceStore();
      await store.save(
        SessionModelPreferenceKey(
          brokerProfileId: testBrokerScope(),
          tool: 'claude',
          lineageId: 'lineage-1',
        ),
        const SessionCurrentModel(
          providerID: 'anthropic',
          modelID: 'claude-opus-4-6',
          reasoningEffort: 'max',
        ),
      );
      final connection = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(
            control: drivingControl,
            lineageId: 'lineage-1',
            currentModel: const {
              'providerID': 'openai',
              'modelID': 'gpt-5.4',
              'reasoningEffort': 'low',
            },
          ),
          const OptionsWireEvent(models: models, agents: []),
        ],
      );

      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          modelPreferenceStore: store,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('Claude Opus 4.6'), findsOneWidget);
      await tester.enterText(
        find.byKey(const Key('session-detail-prompt-input')),
        'Use the restored selection',
      );
      await tester.pump();
      await tester.tap(find.byKey(const Key('session-detail-send-button')));
      await tester.pumpAndSettle();
      expect(connection.lastPromptModel?.modelID, 'claude-opus-4-6');
      expect(connection.lastPromptModel?.reasoningEffort, 'max');
    });

    testWidgets('does not restore a model absent from broker options', (
      tester,
    ) async {
      final store = InMemorySessionModelPreferenceStore();
      await store.save(
        SessionModelPreferenceKey(
          brokerProfileId: testBrokerScope(),
          tool: 'claude',
          lineageId: 'lineage-1',
        ),
        const SessionCurrentModel(
          providerID: 'anthropic',
          modelID: 'claude-fable-gated',
          reasoningEffort: 'max',
        ),
      );
      final connection = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(
            control: drivingControl,
            lineageId: 'lineage-1',
            currentModel: const {
              'providerID': 'openai',
              'modelID': 'gpt-5.4',
              'reasoningEffort': 'low',
            },
          ),
          const OptionsWireEvent(models: models, agents: []),
        ],
      );

      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          modelPreferenceStore: store,
        ),
      );
      await tester.pumpAndSettle();

      expect(find.text('GPT-5.4'), findsOneWidget);
      expect(find.textContaining('Fable'), findsNothing);
    });

    testWidgets('persists exact model and effort selection by lineage', (
      tester,
    ) async {
      final store = InMemorySessionModelPreferenceStore();
      final connection = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(
            control: drivingControl,
            lineageId: 'lineage-1',
            currentModel: const {
              'providerID': 'openai',
              'modelID': 'gpt-5.4',
              'reasoningEffort': 'low',
            },
          ),
          const OptionsWireEvent(models: models, agents: []),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          modelPreferenceStore: store,
        ),
      );
      await tester.pumpAndSettle();

      await selectModelAndEffort(
        tester,
        modelKey: 'session-detail-model-option-anthropic/claude-opus-4-6/',
        effort: 'max',
      );

      final saved = await store.load(
        SessionModelPreferenceKey(
          brokerProfileId: testBrokerScope(),
          tool: 'claude',
          lineageId: 'lineage-1',
        ),
      );
      expect(saved?.providerID, 'anthropic');
      expect(saved?.modelID, 'claude-opus-4-6');
      expect(saved?.reasoningEffort, 'max');
    });

    testWidgets('a model pick also updates the per-tool default', (
      tester,
    ) async {
      final store = InMemorySessionModelPreferenceStore();
      final connection = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(
            control: drivingControl,
            lineageId: 'lineage-1',
            currentModel: const {
              'providerID': 'openai',
              'modelID': 'gpt-5.4',
              'reasoningEffort': 'low',
            },
          ),
          const OptionsWireEvent(models: models, agents: []),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          modelPreferenceStore: store,
        ),
      );
      await tester.pumpAndSettle();

      await selectModelAndEffort(
        tester,
        modelKey: 'session-detail-model-option-anthropic/claude-opus-4-6/',
        effort: 'max',
      );

      final toolDefault = await store.loadToolDefault(
        brokerProfileId: testBrokerScope(),
        tool: 'claude',
      );
      expect(toolDefault?.providerID, 'anthropic');
      expect(toolDefault?.modelID, 'claude-opus-4-6');
      expect(toolDefault?.reasoningEffort, 'max');
    });

    testWidgets('reselecting the current model preserves its effort', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(
            control: drivingControl,
            currentModel: const {
              'providerID': 'openai',
              'modelID': 'gpt-5.4',
              // The catalog default is low; reselecting this exact model must
              // preserve the session's authoritative high effort.
              'reasoningEffort': 'high',
            },
          ),
          const OptionsWireEvent(models: models, agents: []),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      await selectModelAndEffort(
        tester,
        modelKey: 'session-detail-model-option-openai/gpt-5.4/',
        effort: 'high',
      );

      expect(find.text('GPT-5.4'), findsOneWidget);
      await tester.enterText(
        find.byKey(const Key('session-detail-prompt-input')),
        'Keep the current effort',
      );
      await tester.pump();
      await tester.tap(find.byKey(const Key('session-detail-send-button')));
      await tester.pumpAndSettle();
      expect(connection.lastPromptModel?.reasoningEffort, 'high');
    });

    testWidgets('returning to the session model restores its live effort', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(
            control: drivingControl,
            currentModel: const {
              'providerID': 'openai',
              'modelID': 'gpt-5.4',
              'reasoningEffort': 'high',
            },
          ),
          const OptionsWireEvent(models: models, agents: []),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      await selectModelAndEffort(
        tester,
        modelKey: 'session-detail-model-option-anthropic/claude-opus-4-6/',
        effort: 'high',
      );
      await selectModelAndEffort(
        tester,
        modelKey: 'session-detail-model-option-openai/gpt-5.4/',
        effort: 'high',
      );

      expect(find.text('GPT-5.4'), findsOneWidget);
      await tester.enterText(
        find.byKey(const Key('session-detail-prompt-input')),
        'Restore the live effort',
      );
      await tester.pump();
      await tester.tap(find.byKey(const Key('session-detail-send-button')));
      await tester.pumpAndSettle();
      expect(connection.lastPromptModel?.providerID, 'openai');
      expect(connection.lastPromptModel?.modelID, 'gpt-5.4');
      expect(connection.lastPromptModel?.reasoningEffort, 'high');
    });

    testWidgets('model override rejects a model command arg inline', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(
            control: drivingControl,
            currentModel: const {
              'providerID': 'openai',
              'modelID': 'gpt-5.4',
              'reasoningEffort': 'low',
            },
          ),
          const OptionsWireEvent(models: models, agents: []),
          const CommandsWireEvent(
            commands: [SlashCommand(name: '/review')],
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      await selectModelAndEffort(
        tester,
        modelKey: 'session-detail-model-option-anthropic/claude-opus-4-6/',
        effort: 'high',
      );
      await openCommandPickerSheet(tester);
      await tester.tap(
        find.byKey(const Key('session-detail-command-picker')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.text('/review'));
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('session-detail-command-args-input')),
        '{"model": "legacy-model-arg"}',
      );
      await tester.pumpAndSettle();

      expect(find.text(sessionCommandModelArgError), findsOneWidget);
      final sendButton = tester.widget<IconButton>(
        find.byKey(const Key('session-detail-command-send-button')),
      );
      expect(sendButton.onPressed, isNull);
      expect(connection.sendCommandCount, 0);
    });

    testWidgets('sends the selected model and reasoning effort exactly', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(
            control: drivingControl,
            currentModel: const {
              'providerID': 'openai',
              'modelID': 'gpt-5.4',
              'reasoningEffort': 'low',
            },
          ),
          const OptionsWireEvent(models: models, agents: []),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      await selectModelAndEffort(
        tester,
        modelKey: 'session-detail-model-option-anthropic/claude-opus-4-6/',
        effort: 'max',
      );
      expect(find.text('Claude Opus 4.6'), findsOneWidget);

      await tester.enterText(
        find.byKey(const Key('session-detail-prompt-input')),
        'Use the selected model',
      );
      await tester.pump();
      await tester.tap(find.byKey(const Key('session-detail-send-button')));
      await tester.pumpAndSettle();

      expect(connection.sendPromptCount, 1);
      expect(connection.lastPromptModel?.providerID, 'anthropic');
      expect(connection.lastPromptModel?.modelID, 'claude-opus-4-6');
      expect(connection.lastPromptModel?.reasoningEffort, 'max');
      expect(connection.lastPromptModel?.variant, isNull);
    });

    testWidgets(
      'Codex Ultra uses advertised copy, sends exactly, and stays model-scoped',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: [
            sessionEvent(
              control: drivingControl,
              currentModel: const {
                'providerID': 'openai',
                'modelID': 'gpt-5.6-sol',
                'reasoningEffort': 'medium',
              },
            ),
            const OptionsWireEvent(models: codexUltraModels, agents: []),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        await tester.tap(
          find.byKey(const Key('session-detail-model-selector')),
        );
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(
            const Key('session-detail-model-option-openai/gpt-5.6-sol/'),
          ),
        );
        await tester.pumpAndSettle();
        expect(
          find.byKey(const Key('session-detail-effort-option-ultra')),
          findsOneWidget,
        );
        expect(
          find.text('Maximum reasoning with automatic task delegation'),
          findsOneWidget,
        );
        await tester.ensureVisible(
          find.byKey(const Key('session-detail-effort-option-ultra')),
        );
        await tester.tap(
          find.byKey(const Key('session-detail-effort-option-ultra')),
        );
        await tester.pumpAndSettle();
        expect(
          find.byKey(const Key('session-detail-effort-option-ultra')),
          findsNothing,
        );

        await tester.enterText(
          find.byKey(const Key('session-detail-prompt-input')),
          'Use native Codex Ultra',
        );
        await tester.pump();
        await tester.tap(find.byKey(const Key('session-detail-send-button')));
        await tester.pumpAndSettle();
        expect(connection.lastPromptModel?.providerID, 'openai');
        expect(connection.lastPromptModel?.modelID, 'gpt-5.6-sol');
        expect(connection.lastPromptModel?.reasoningEffort, 'ultra');

        await tester.tap(
          find.byKey(const Key('session-detail-model-selector')),
        );
        await tester.pumpAndSettle();
        await tester.tap(
          find.byKey(
            const Key('session-detail-model-option-openai/gpt-5.6-luna/'),
          ),
        );
        await tester.pumpAndSettle();
        expect(
          find.byKey(const Key('session-detail-effort-option-ultra')),
          findsNothing,
        );
        expect(
          find.text('Maximum reasoning with automatic task delegation'),
          findsNothing,
        );
      },
    );

    testWidgets(
      'partial options never downgrade a persisted Ultra selection',
      (tester) async {
        final store = InMemorySessionModelPreferenceStore();
        final preferenceKey = SessionModelPreferenceKey(
          brokerProfileId: testBrokerScope(),
          tool: 'claude',
          lineageId: 'codex-lineage',
        );
        await store.save(
          preferenceKey,
          const SessionCurrentModel(
            providerID: 'openai',
            modelID: 'gpt-5.6-sol',
            reasoningEffort: 'ultra',
          ),
        );
        const partialModels = [
          ModelOption(
            providerID: 'openai',
            modelID: 'gpt-5.6-sol',
            label: 'GPT-5.6 Sol',
            reasoningEfforts: [
              ReasoningEffort(effort: 'max', label: 'Max'),
            ],
            defaultReasoningEffort: 'max',
          ),
        ];
        final connection = ScriptedSessionDetailConnection(
          events: [
            sessionEvent(
              control: drivingControl,
              lineageId: 'codex-lineage',
              currentModel: const {
                'providerID': 'openai',
                'modelID': 'gpt-5.6-sol',
                'reasoningEffort': 'ultra',
              },
            ),
            const OptionsWireEvent(models: partialModels, agents: []),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            modelPreferenceStore: store,
          ),
        );
        await tester.pumpAndSettle();

        Future<void> sendAndExpectUltra(String text) async {
          await tester.enterText(
            find.byKey(const Key('session-detail-prompt-input')),
            text,
          );
          await tester.pump();
          await tester.tap(
            find.byKey(const Key('session-detail-send-button')),
          );
          await tester.pumpAndSettle();
          expect(connection.lastPromptModel?.reasoningEffort, 'ultra');
        }

        await sendAndExpectUltra('Keep Ultra through partial options');
        connection.emitEvent(
          const OptionsWireEvent(models: codexUltraModels, agents: []),
        );
        await tester.pumpAndSettle();
        await sendAndExpectUltra('Keep Ultra after the full catalog refresh');
        expect(connection.sendPromptCount, 2);
      },
    );

    testWidgets(
      'stale Ultra stays dormant until the catalog advertises it',
      (tester) async {
        final store = InMemorySessionModelPreferenceStore();
        final preferenceKey = SessionModelPreferenceKey(
          brokerProfileId: testBrokerScope(),
          tool: 'claude',
          lineageId: 'codex-lineage',
        );
        await store.save(
          preferenceKey,
          const SessionCurrentModel(
            providerID: 'openai',
            modelID: 'gpt-5.6-sol',
            reasoningEffort: 'ultra',
          ),
        );
        const maxOnlyModels = [
          ModelOption(
            providerID: 'openai',
            modelID: 'gpt-5.6-sol',
            label: 'GPT-5.6 Sol',
            reasoningEfforts: [
              ReasoningEffort(effort: 'max', label: 'Max'),
            ],
            defaultReasoningEffort: 'max',
          ),
        ];
        final connection = ScriptedSessionDetailConnection(
          events: [
            sessionEvent(
              control: drivingControl,
              lineageId: 'codex-lineage',
              currentModel: const {
                'providerID': 'openai',
                'modelID': 'gpt-5.6-sol',
                'reasoningEffort': 'medium',
              },
            ),
            const OptionsWireEvent(models: maxOnlyModels, agents: []),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            modelPreferenceStore: store,
          ),
        );
        await tester.pumpAndSettle();

        await tester.enterText(
          find.byKey(const Key('session-detail-prompt-input')),
          'Do not send stale Ultra',
        );
        await tester.pump();
        await tester.tap(find.byKey(const Key('session-detail-send-button')));
        await tester.pumpAndSettle();
        expect(
          connection.lastPromptModel,
          isNull,
          reason:
              'the authoritative live Sol/Medium session must remain active',
        );

        connection.emitEvent(
          const OptionsWireEvent(models: codexUltraModels, agents: []),
        );
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const Key('session-detail-prompt-input')),
          'Activate Ultra after advertisement',
        );
        await tester.pump();
        await tester.tap(find.byKey(const Key('session-detail-send-button')));
        await tester.pumpAndSettle();
        expect(connection.lastPromptModel?.providerID, 'openai');
        expect(connection.lastPromptModel?.modelID, 'gpt-5.6-sol');
        expect(connection.lastPromptModel?.reasoningEffort, 'ultra');
        expect(connection.sendPromptCount, 2);
      },
    );

    testWidgets(
      'post-frame restore revalidates a newer authoritative effort',
      (tester) async {
        final store = InMemorySessionModelPreferenceStore()
          ..loadGate = Completer<void>()
          ..loadStarted = Completer<void>();
        final preferenceKey = SessionModelPreferenceKey(
          brokerProfileId: testBrokerScope(),
          tool: 'claude',
          lineageId: 'codex-lineage',
        );
        await store.save(
          preferenceKey,
          const SessionCurrentModel(
            providerID: 'openai',
            modelID: 'gpt-5.6-sol',
            reasoningEffort: 'ultra',
          ),
        );
        const maxOnlyModels = [
          ModelOption(
            providerID: 'openai',
            modelID: 'gpt-5.6-sol',
            label: 'GPT-5.6 Sol',
            reasoningEfforts: [
              ReasoningEffort(effort: 'max', label: 'Max'),
            ],
            defaultReasoningEffort: 'max',
          ),
        ];
        final connection = ScriptedSessionDetailConnection(
          events: [
            sessionEvent(
              control: drivingControl,
              lineageId: 'codex-lineage',
              currentModel: const {
                'providerID': 'openai',
                'modelID': 'gpt-5.6-sol',
                'reasoningEffort': 'ultra',
              },
            ),
            const OptionsWireEvent(models: maxOnlyModels, agents: []),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            modelPreferenceStore: store,
          ),
        );
        await tester.pumpAndSettle();
        expect(store.loadStarted?.isCompleted, isTrue);

        // Unblock the saved Ultra load first so the old authoritative state
        // schedules a restore, then queue a newer Medium session before the
        // post-frame application can run.
        store.loadGate!.complete();
        connection.emitEvent(
          sessionEvent(
            control: drivingControl,
            lineageId: 'codex-lineage',
            currentModel: const {
              'providerID': 'openai',
              'modelID': 'gpt-5.6-sol',
              'reasoningEffort': 'medium',
            },
          ),
        );
        await tester.pumpAndSettle();

        await tester.enterText(
          find.byKey(const Key('session-detail-prompt-input')),
          'Keep the newer Medium session',
        );
        await tester.pump();
        await tester.tap(find.byKey(const Key('session-detail-send-button')));
        await tester.pumpAndSettle();
        expect(
          connection.lastPromptModel,
          isNull,
          reason: 'the stale post-frame Ultra restore must remain dormant',
        );

        connection.emitEvent(
          const OptionsWireEvent(models: codexUltraModels, agents: []),
        );
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const Key('session-detail-prompt-input')),
          'Activate Ultra after advertisement',
        );
        await tester.pump();
        await tester.tap(find.byKey(const Key('session-detail-send-button')));
        await tester.pumpAndSettle();
        expect(connection.lastPromptModel?.reasoningEffort, 'ultra');
        expect(connection.sendPromptCount, 2);
      },
    );

    testWidgets('Observe disables model and effort changes, not status', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(
            control: observingControl,
            currentModel: const {
              'providerID': 'openai',
              'modelID': 'gpt-5.4',
              'reasoningEffort': 'low',
            },
          ),
          const OptionsWireEvent(models: models, agents: []),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      // The model selector is now a borderless TextButton (composer redesign,
      // Variant A) rather than an outlined chip.
      final modelButton = tester.widget<TextButton>(
        find.descendant(
          of: find.byKey(const Key('session-detail-model-selector')),
          matching: find.byType(TextButton),
        ),
      );
      final statusButton = tester.widget<InkWell>(
        find.byKey(const Key('session-detail-status-chip')),
      );
      expect(modelButton.onPressed, isNull);
      expect(statusButton.onTap, isNotNull);
    });

    testWidgets(
      'live control fanout preserves local drafting without reattach',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: [sessionEvent(control: observingControl)],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        expect(
          tester
              .widget<TextField>(
                find.byKey(const Key('session-detail-prompt-input')),
              )
              .enabled,
          isTrue,
        );

        connection.emitSessionControl(drivingControl);
        await tester.pumpAndSettle();
        expect(
          tester
              .widget<TextField>(
                find.byKey(const Key('session-detail-prompt-input')),
              )
              .enabled,
          isTrue,
        );
        expect(connection.reattachModes, isEmpty);

        await tester.ensureVisible(
          find.byKey(const Key('session-detail-bottom-status-button')),
        );
        await tester.tap(
          find.byKey(const Key('session-detail-bottom-status-button')),
        );
        await tester.pumpAndSettle();
        expect(
          find.byKey(
            const Key('session-detail-status-sheet-control-pill-driving'),
          ),
          findsOneWidget,
        );
      },
    );

    testWidgets('the raw model id stays out of the bar (tooltip only)', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(
            control: drivingControl,
            currentModel: const {
              'providerID': 'anthropic',
              'modelID': 'claude-opus-4-6',
              'reasoningEffort': 'high',
            },
          ),
          const OptionsWireEvent(models: models, agents: []),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      // The bar shows the short label alone — never the raw model id, and no
      // effort suffix (Variant A's mock shows just the model name).
      expect(find.text('Claude Opus 4.6'), findsOneWidget);
      expect(find.textContaining('claude-opus-4-6'), findsNothing);
      expect(find.textContaining('High'), findsNothing);

      // The full id and the effort both live in the selector's tooltip.
      final tooltip = tester.widget<Tooltip>(
        find.descendant(
          of: find.byKey(const Key('session-detail-model-selector')),
          matching: find.byType(Tooltip),
        ),
      );
      expect(tooltip.message, contains('claude-opus-4-6'));
      expect(tooltip.message, contains('High'));
    });

    testWidgets('an unadvertised model shows a short name, never the raw id', (
      tester,
    ) async {
      // The reported bug: the session runs a model the broker never advertised,
      // so there is no ModelOption to read a label from. The bar used to fall
      // back to the raw id (`claude-opus-4-8`).
      final connection = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(
            control: drivingControl,
            currentModel: const {
              'providerID': 'anthropic',
              'modelID': 'claude-opus-4-8',
              'reasoningEffort': 'high',
            },
          ),
          const OptionsWireEvent(models: models, agents: []),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      expect(find.text('Opus'), findsOneWidget);
      expect(find.textContaining('claude-opus-4-8'), findsNothing);
      // No effort suffix leaks in, in either the labelled or raw spelling.
      expect(find.textContaining('high'), findsNothing);
      expect(find.textContaining('High'), findsNothing);

      final tooltip = tester.widget<Tooltip>(
        find.descendant(
          of: find.byKey(const Key('session-detail-model-selector')),
          matching: find.byType(Tooltip),
        ),
      );
      expect(tooltip.message, contains('claude-opus-4-8'));
      expect(tooltip.message, contains('high'));
    });

    // The broker's advertised label is untrusted input: it is plain JSON, and
    // real brokers ship labels that already embed the id. Pumps one advertised
    // [label] for `claude-opus-4-8` and returns the selector's tooltip.
    Future<Tooltip> pumpAdvertisedLabel(
      WidgetTester tester, {
      required String label,
      String modelID = 'claude-opus-4-8',
    }) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(
            control: drivingControl,
            currentModel: {
              'providerID': 'anthropic',
              'modelID': modelID,
              'reasoningEffort': 'high',
            },
          ),
          OptionsWireEvent(
            models: [
              ModelOption(
                providerID: 'anthropic',
                modelID: modelID,
                label: label,
                reasoningEfforts: const [
                  ReasoningEffort(effort: 'high', label: 'High'),
                ],
              ),
            ],
            agents: const [],
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      return tester.widget<Tooltip>(
        find.descendant(
          of: find.byKey(const Key('session-detail-model-selector')),
          matching: find.byType(Tooltip),
        ),
      );
    }

    testWidgets('an advertised label embedding the raw id is sanitized', (
      tester,
    ) async {
      final tooltip = await pumpAdvertisedLabel(
        tester,
        label: 'Opus · claude-opus-4-8',
      );

      expect(find.text('Opus'), findsOneWidget);
      expect(find.textContaining('claude-opus-4-8'), findsNothing);
      expect(tooltip.message, contains('claude-opus-4-8'));
      expect(tooltip.message, contains('High'));
    });

    testWidgets('a short model id does not leave a mangled label remnant', (
      tester,
    ) async {
      // The live broker advertises a SHORT modelID (`opus`) alongside the full
      // dashed id as the label. Excising `opus` leaves `claude--4-8`, which
      // tidies to the space-padded `claude · 4-8` — that used to read as a
      // human name and shipped verbatim to the composer.
      final tooltip = await pumpAdvertisedLabel(
        tester,
        label: 'claude-opus-4-8',
        modelID: 'opus',
      );

      expect(find.text('Opus'), findsOneWidget);
      final modelButton = find.byKey(
        const Key('session-detail-model-selector'),
      );
      expect(
        find.descendant(
          of: modelButton,
          matching: find.textContaining('claude'),
        ),
        findsNothing,
      );
      expect(
        find.descendant(of: modelButton, matching: find.textContaining('4-8')),
        findsNothing,
      );
      expect(tooltip.message, contains('opus'));
    });

    testWidgets('an advertised label that is only the raw id falls back', (
      tester,
    ) async {
      final tooltip = await pumpAdvertisedLabel(
        tester,
        label: 'claude-opus-4-8',
      );

      expect(find.text('Opus'), findsOneWidget);
      expect(find.textContaining('claude-opus-4-8'), findsNothing);
      expect(tooltip.message, contains('claude-opus-4-8'));
      expect(tooltip.message, contains('High'));
    });

    testWidgets('a genuinely human advertised label survives untouched', (
      tester,
    ) async {
      // The sanitizer must not over-strip: the id is not present here, so the
      // broker's own wording is preserved verbatim.
      final tooltip = await pumpAdvertisedLabel(tester, label: 'Opus 4.8');

      expect(find.text('Opus 4.8'), findsOneWidget);
      expect(find.textContaining('claude-opus-4-8'), findsNothing);
      expect(tooltip.message, contains('claude-opus-4-8'));
      expect(tooltip.message, contains('High'));
    });

    testWidgets('below 420dp the composer grows no overflow of its own', (
      tester,
    ) async {
      tester.view.physicalSize = const Size(380, 820);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);

      final connection = ScriptedSessionDetailConnection(
        events: [
          sessionEvent(
            control: drivingControl,
            currentModel: const {
              'providerID': 'openai',
              'modelID': 'gpt-5.4',
              'reasoningEffort': 'low',
            },
          ),
          const OptionsWireEvent(models: models, agents: []),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      // One overflow per session, and it is the strip's. The composer keeps
      // no menu of its own at any width.
      expect(
        find.byKey(const Key('session-detail-composer-overflow')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('session-detail-tool-expand-toggle')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('session-detail-report-view-toggle')),
        findsNothing,
      );

      // Both transcript toggles are reachable from the strip menu instead.
      await withSessionDetailViewMenu(tester, () async {
        expect(
          find.byKey(const Key('session-detail-view-item-report')),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('session-detail-view-item-expand')),
          findsOneWidget,
        );
      });

      // The composer's own right cluster keeps its input-adjacent actions.
      expect(
        find.byKey(const Key('session-detail-command-picker-button')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-detail-attach-button')),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-detail-send-button')),
        findsOneWidget,
      );
    });

    testWidgets(
      'mode control renders advertised agents and switches the live session',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: [
            sessionEvent(control: drivingControl, currentAgent: 'build'),
            const OptionsWireEvent(
              models: [],
              agents: [
                AgentOption(name: 'build', description: 'Implementation'),
                AgentOption(name: 'plan', description: 'Read-only planning'),
              ],
            ),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        final selector = find.byKey(
          const Key('session-detail-agent-selector'),
        );
        expect(selector, findsOneWidget);
        // The pill shows the broker-reported current agent name verbatim.
        expect(
          find.descendant(of: selector, matching: find.text('build')),
          findsOneWidget,
        );

        await tester.tap(selector);
        await tester.pumpAndSettle();
        expect(find.text('Read-only planning'), findsOneWidget);
        await tester.tap(
          find.byKey(const Key('session-detail-agent-option-plan')),
        );
        await tester.pumpAndSettle();

        // The switch went to the broker; the pill stays authoritative (still
        // 'build') until the broker pushes the new currentAgent.
        expect(connection.sendSetAgentCount, 1);
        expect(connection.lastSetAgent, 'plan');
        expect(
          find.descendant(of: selector, matching: find.text('build')),
          findsOneWidget,
        );

        // Broker confirmation — the same path a terminal-side Tab switch
        // takes — flips the pill.
        connection.emitEvent(
          sessionEvent(control: drivingControl, currentAgent: 'plan'),
        );
        await tester.pumpAndSettle();
        expect(
          find.descendant(of: selector, matching: find.text('plan')),
          findsOneWidget,
        );
      },
    );

    testWidgets(
      'no advertised agents means no mode control at all',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(
          events: [
            sessionEvent(
              control: drivingControl,
              currentModel: const {
                'providerID': 'openai',
                'modelID': 'gpt-5.4',
                'reasoningEffort': 'low',
              },
            ),
            const OptionsWireEvent(models: models, agents: []),
          ],
        );
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        expect(
          find.byKey(const Key('session-detail-composer-bottom-bar')),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('session-detail-agent-selector')),
          findsNothing,
        );
      },
    );
  });

  group('SessionDetailPage inline slash palette', () {
    const paletteCommands = CommandsWireEvent(
      commands: [
        SlashCommand(name: '/goal', description: 'Set the current goal'),
        SlashCommand(name: '/git', description: 'Git helpers'),
        SlashCommand(name: '/review'),
      ],
    );

    Finder palette() => find.byKey(const Key('session-detail-slash-palette'));
    Finder paletteItem(String name) =>
        find.byKey(ValueKey('session-detail-slash-palette-item-$name'));

    Future<TextEditingController> pumpComposer(WidgetTester tester) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: ScriptedSessionDetailConnection(
            events: const [paletteCommands],
          ),
        ),
      );
      await tester.pumpAndSettle();
      return tester
          .widget<TextField>(
            find.byKey(const Key('session-detail-prompt-input')),
          )
          .controller!;
    }

    testWidgets('a leading / opens the palette and filters as you type', (
      tester,
    ) async {
      await pumpComposer(tester);
      final input = find.byKey(const Key('session-detail-prompt-input'));
      expect(palette(), findsNothing);

      // A bare leading "/" opens with every command.
      await tester.enterText(input, '/');
      await tester.pumpAndSettle();
      expect(palette(), findsOneWidget);
      expect(paletteItem('goal'), findsOneWidget);
      expect(paletteItem('git'), findsOneWidget);
      expect(paletteItem('review'), findsOneWidget);

      // Typing narrows it.
      await tester.enterText(input, '/g');
      await tester.pumpAndSettle();
      expect(paletteItem('goal'), findsOneWidget);
      expect(paletteItem('git'), findsOneWidget);
      expect(paletteItem('review'), findsNothing);

      await tester.enterText(input, '/goa');
      await tester.pumpAndSettle();
      expect(paletteItem('goal'), findsOneWidget);
      expect(paletteItem('git'), findsNothing);

      // No match closes it rather than showing an empty list.
      await tester.enterText(input, '/zzz');
      await tester.pumpAndSettle();
      expect(palette(), findsNothing);
    });

    testWidgets('a / typed mid-sentence never opens the palette', (
      tester,
    ) async {
      await pumpComposer(tester);
      final input = find.byKey(const Key('session-detail-prompt-input'));

      await tester.enterText(input, 'ship it and/or revert');
      await tester.pumpAndSettle();
      expect(palette(), findsNothing);

      await tester.enterText(input, 'look at lib/src/goal');
      await tester.pumpAndSettle();
      expect(palette(), findsNothing);

      // Once the name is followed by args the palette gets out of the way.
      await tester.enterText(input, '/goal set finish the report');
      await tester.pumpAndSettle();
      expect(palette(), findsNothing);
    });

    testWidgets('arrow keys move the selection and Enter completes', (
      tester,
    ) async {
      final controller = await pumpComposer(tester);
      final input = find.byKey(const Key('session-detail-prompt-input'));

      await tester.enterText(input, '/g');
      await tester.pumpAndSettle();

      // Selection starts on the first match (/goal); ArrowDown moves to /git.
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();

      expect(controller.text, '/git ');
      expect(palette(), findsNothing);
    });

    testWidgets('Tab completes the highlighted command without sending', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: const [paletteCommands],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      final input = find.byKey(const Key('session-detail-prompt-input'));
      final controller = tester.widget<TextField>(input).controller!;

      await tester.enterText(input, '/rev');
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.tab);
      await tester.pumpAndSettle();

      expect(controller.text, '/review ');
      expect(palette(), findsNothing);
      expect(connection.sendPromptCount, 0);
      expect(connection.sendCommandCount, 0);
    });

    testWidgets('Esc dismisses the palette but keeps the typed text', (
      tester,
    ) async {
      final controller = await pumpComposer(tester);
      final input = find.byKey(const Key('session-detail-prompt-input'));

      await tester.enterText(input, '/g');
      await tester.pumpAndSettle();
      expect(palette(), findsOneWidget);

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(palette(), findsNothing);
      expect(controller.text, '/g');

      // Dismissal lasts only until the next edit.
      await tester.enterText(input, '/go');
      await tester.pumpAndSettle();
      expect(palette(), findsOneWidget);
    });

    testWidgets('tapping a palette row completes it', (tester) async {
      final controller = await pumpComposer(tester);
      final input = find.byKey(const Key('session-detail-prompt-input'));

      await tester.enterText(input, '/g');
      await tester.pumpAndSettle();
      await tester.tap(paletteItem('git'));
      await tester.pumpAndSettle();

      expect(controller.text, '/git ');
      expect(palette(), findsNothing);
    });
  });

  group('command args accept free text', () {
    test('plain prose becomes the documented default arg', () {
      final parsed = parseSessionCommandArgs('set finish the report');
      expect(parsed.error, isNull);
      expect(parsed.args, {
        sessionCommandDefaultArgKey: 'set finish the report',
      });
    });

    test('surrounding whitespace is trimmed', () {
      expect(
        parseSessionCommandArgs('  finish the report  ').args,
        {sessionCommandDefaultArgKey: 'finish the report'},
      );
    });

    test('an empty editor still means no args', () {
      final parsed = parseSessionCommandArgs('   ');
      expect(parsed.error, isNull);
      expect(parsed.args, isNull);
    });

    test('a JSON object still parses key-for-key', () {
      final parsed = parseSessionCommandArgs('{"path": "/tmp"}');
      expect(parsed.error, isNull);
      expect(parsed.args, {'path': '/tmp'});
    });

    test('JSON-shaped input still reports its parse errors', () {
      // Only a leading {/[ opts into the JSON path, so a typo in real JSON is
      // still caught instead of being shipped as prose.
      expect(
        parseSessionCommandArgs('{"path":').error,
        'Invalid JSON for command arguments.',
      );
      expect(
        parseSessionCommandArgs('["a", "b"]').error,
        'Command arguments must be a JSON object.',
      );
    });

    test('free text cannot smuggle a model override', () {
      final parsed = parseSessionCommandArgs(
        'finish the report',
        hasModelOverride: true,
      );
      expect(parsed.error, isNull);
      expect(parsed.args, isNot(contains('model')));
    });

    testWidgets('free-text args reach the broker as the default arg', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: const [
          CommandsWireEvent(
            commands: [
              SlashCommand(
                name: '/goal',
                description: 'Set the current goal',
                usage: '/goal set <text>',
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

      await tester.tap(find.byKey(const Key('session-detail-command-picker')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('/goal'));
      await tester.pumpAndSettle();
      expect(
        find.ancestor(
          of: find.text('Set the current goal'),
          matching: find.byType(SelectionArea),
        ),
        findsOneWidget,
      );
      expect(find.text('/goal set <text>'), findsOneWidget);

      await tester.enterText(
        find.byKey(const Key('session-detail-command-args-input')),
        'set finish the report',
      );
      await tester.pumpAndSettle();

      // No error, and the send button is live.
      final sendButton = tester.widget<IconButton>(
        find.byKey(const Key('session-detail-command-send-button')),
      );
      expect(sendButton.onPressed, isNotNull);

      await tester.tap(
        find.byKey(const Key('session-detail-command-send-button')),
      );
      await tester.pumpAndSettle();

      expect(connection.sendCommandCount, 1);
      expect(connection.lastCommandName, '/goal');
      expect(connection.lastCommandArgs, {'args': 'set finish the report'});
    });
  });
}
