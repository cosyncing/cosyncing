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
  group('SessionDetailPage prompt composer', () {
    ThemeData platformTheme(TargetPlatform platform) => ThemeData(
      platform: platform,
      splashFactory: InkRipple.splashFactory,
      extensions: [themeSpecById(kDefaultThemeId).light],
    );

    Future<void> pressModifiedEnter(
      WidgetTester tester,
      LogicalKeyboardKey modifier,
    ) async {
      await tester.sendKeyDownEvent(modifier);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(modifier);
      await tester.pump();
    }

    testWidgets('shows an accepted prompt immediately and adopts its echo', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(events: const []);
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      const prompt = 'Visible before the agent replies';
      await tester.enterText(
        find.byKey(const Key('session-detail-prompt-input')),
        prompt,
      );
      await tester.tap(find.byKey(const Key('session-detail-send-button')));
      await tester.pumpAndSettle();
      expect(find.text(prompt), findsOneWidget);

      connection.emitEvent(
        MessageWireEvent(
          seq: 1,
          message: AgentMessage.fromJson({
            'type': 'user-message',
            'key': 'native-echo',
            'text': prompt,
          }),
        ),
      );
      await tester.pump();
      expect(find.text(prompt), findsOneWidget);
    });

    testWidgets('labels an optimistic follow-up queued while working', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: [
          SessionWireEvent(
            info: SessionInfo.fromJson({
              'id': 'session-1',
              'tool': 'claude',
              'title': 'Busy session',
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
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('session-detail-prompt-input')),
        'Follow up',
      );
      await tester.pump();
      final send = tester.widget<IconButton>(
        find.byKey(const Key('session-detail-send-button')),
      );
      expect(send.onPressed, isNotNull);
      send.onPressed!();
      await tester.pumpAndSettle();

      final container = ProviderScope.containerOf(
        tester.element(find.byType(SessionDetailPage)),
      );
      final state = container.read(
        sessionDetailControllerProvider(
          const SessionDetailKey(tool: 'claude', sessionId: 'session-1'),
        ),
      );
      expect(connection.sendPromptCount, 1);
      expect(state.sessionInfo?.status, SessionStatus.working);
      expect(state.optimisticPrompts.single.queued, isTrue);
      expect(
        find.byKey(const Key('queued-user-message-badge')),
        findsOneWidget,
      );
    });

    testWidgets('debounces session-scoped draft relay and swallows its echo', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(events: const []);
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.enterText(input, 'shared draft');
      await tester.pump(const Duration(milliseconds: 299));
      expect(connection.sendDraftCount, 0);
      await tester.pump(const Duration(milliseconds: 1));
      await tester.pump();
      expect(connection.sendDraftCount, 1);
      expect(connection.lastDraft, 'shared draft');

      connection.emitEvent(
        const DraftWireEvent(text: 'shared draft', at: 10),
      );
      await tester.pump();
      await tester.pump();
      expect(connection.sendDraftCount, 1);
      expect(tester.widget<TextField>(input).controller?.text, 'shared draft');
    });

    testWidgets('applies remote draft but preserves newer focused typing', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(events: const []);
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      final input = find.byKey(const Key('session-detail-prompt-input'));
      connection.emitEvent(const DraftWireEvent(text: 'from phone', at: 10));
      await tester.pump();
      await tester.pump();
      expect(tester.widget<TextField>(input).controller?.text, 'from phone');

      connection.emitEvent(
        const DraftWireEvent(text: 'same millisecond, later frame', at: 10),
      );
      await tester.pump();
      await tester.pump();
      expect(
        tester.widget<TextField>(input).controller?.text,
        'same millisecond, later frame',
      );

      await tester.enterText(input, 'new local typing');
      connection.emitEvent(
        const DraftWireEvent(text: 'stale remote race', at: 20),
      );
      await tester.pump();
      await tester.pump();
      expect(
        tester.widget<TextField>(input).controller?.text,
        'new local typing',
      );
      await tester.pump(const Duration(milliseconds: 300));
      await tester.pump();
      expect(connection.lastDraft, 'new local typing');
    });

    testWidgets('stages a changed remote draft until IME composition ends', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(events: const []);
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      final editable = tester.widget<EditableText>(
        find.descendant(
          of: find.byKey(const Key('session-detail-prompt-input')),
          matching: find.byType(EditableText),
        ),
      );
      editable.focusNode.requestFocus();
      editable.controller.value = const TextEditingValue(
        text: 'local composing',
        selection: TextSelection.collapsed(offset: 15),
        composing: TextRange(start: 6, end: 15),
      );
      await tester.pump();

      connection.emitEvent(
        const DraftWireEvent(text: 'remote replacement', at: 30),
      );
      await tester.pump();
      await tester.pump();

      expect(editable.controller.text, 'local composing');
      expect(
        editable.controller.value.composing,
        const TextRange(start: 6, end: 15),
      );
      expect(editable.focusNode.hasFocus, isTrue);

      editable.controller.value = editable.controller.value.copyWith(
        composing: TextRange.empty,
      );
      await tester.pump();
      await tester.pump();

      expect(editable.controller.text, 'remote replacement');
      expect(
        editable.controller.selection,
        const TextSelection.collapsed(offset: 18),
      );
      expect(editable.controller.value.composing, TextRange.empty);
      expect(editable.focusNode.hasFocus, isTrue);
    });

    testWidgets(
      'an IME-staged draft from profile A never drains under profile B',
      (tester) async {
        final profileA = createTestBrokerProfile();
        final profileB = BrokerProfile(
          id: 'remote',
          displayName: 'remote',
          baseUri: Uri.parse('http://127.0.0.1:8834'),
          createdAt: DateTime(2026, 6, 28),
        );
        final connection = ScriptedSessionDetailConnection(events: const []);
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            brokerProfile: profileA,
          ),
        );
        await tester.pumpAndSettle();

        final editable = tester.widget<EditableText>(
          find.descendant(
            of: find.byKey(const Key('session-detail-prompt-input')),
            matching: find.byType(EditableText),
          ),
        );
        editable.focusNode.requestFocus();
        editable.controller.value = const TextEditingValue(
          text: 'profile B local composition',
          selection: TextSelection.collapsed(offset: 27),
          composing: TextRange(start: 16, end: 27),
        );
        await tester.pump();

        connection.emitEvent(
          const DraftWireEvent(text: 'profile A staged draft', at: 35),
        );
        await tester.pump();
        await tester.pump();
        expect(editable.controller.text, 'profile B local composition');

        final container = ProviderScope.containerOf(
          tester.element(find.byType(SessionDetailPage)),
          listen: false,
        );
        container.read(activeBrokerProfileProvider.notifier).state = profileB;
        for (var frame = 0; frame < 10; frame++) {
          await tester.pump(const Duration(milliseconds: 100));
        }

        expect(
          editable.controller.text,
          isNot('profile A staged draft'),
          reason: 'a staged draft must retire with its exact broker source',
        );
        expect(find.text('profile A staged draft'), findsNothing);
      },
    );

    testWidgets(
      'an IME-staged surface from profile A never drains under profile B',
      (tester) async {
        final profileA = createTestBrokerProfile();
        final profileB = BrokerProfile(
          id: 'remote',
          displayName: 'remote',
          baseUri: Uri.parse('http://127.0.0.1:8834'),
          createdAt: DateTime(2026, 6, 28),
        );
        final initial = SessionDetailState(
          tool: 'claude',
          sessionId: 'session-1',
          source: RosterSource.ofProfile(profileA),
          bootstrapState: const SessionDetailBootstrapState(
            readiness: SessionDetailBootstrapReadiness.ready,
            attempt: 1,
          ),
        );
        final seeded = SeededSessionDetailController(initial);
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            seededController: seeded,
            brokerProfile: profileA,
          ),
        );
        await tester.pumpAndSettle();

        final editable = tester.widget<EditableText>(
          find.descendant(
            of: find.byKey(const Key('session-detail-prompt-input')),
            matching: find.byType(EditableText),
          ),
        );
        editable.focusNode.requestFocus();
        editable.controller.value = const TextEditingValue(
          text: 'profile B local composition',
          selection: TextSelection.collapsed(offset: 27),
          composing: TextRange(start: 16, end: 27),
        );
        await tester.pump();

        seeded.emittedState = initial.copyWith(
          draftSurface: const SessionDraftSurface(
            text: 'profile A staged surface',
            token: 1,
            kind: SessionDraftSurfaceKind.forceReplace,
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(editable.controller.text, 'profile B local composition');

        final container = ProviderScope.containerOf(
          tester.element(find.byType(SessionDetailPage)),
          listen: false,
        );
        container.read(activeBrokerProfileProvider.notifier).state = profileB;
        for (var frame = 0; frame < 10; frame++) {
          await tester.pump(const Duration(milliseconds: 100));
        }

        expect(
          editable.controller.text,
          isNot('profile A staged surface'),
          reason: 'a staged surface must retire with its exact broker source',
        );
        expect(find.text('profile A staged surface'), findsNothing);
      },
    );

    testWidgets(
      'a newer legacy draft wins when its apply races an older IME drain',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(events: const []);
        await tester.pumpWidget(
          buildSessionDetailTestPage(events: const [], connection: connection),
        );
        await tester.pumpAndSettle();

        final editable = tester.widget<EditableText>(
          find.descendant(
            of: find.byKey(const Key('session-detail-prompt-input')),
            matching: find.byType(EditableText),
          ),
        );
        editable.focusNode.requestFocus();
        editable.controller.value = const TextEditingValue(
          text: 'local composing',
          selection: TextSelection.collapsed(offset: 15),
          composing: TextRange(start: 6, end: 15),
        );
        await tester.pump();

        connection.emitEvent(
          const DraftWireEvent(text: 'older staged draft', at: 40),
        );
        await tester.pump();
        await tester.pump();
        expect(editable.controller.text, 'local composing');

        connection.emitEvent(
          const DraftWireEvent(text: 'newer remote draft', at: 41),
        );
        tester.binding.addPostFrameCallback((_) {
          editable.controller.value = editable.controller.value.copyWith(
            composing: TextRange.empty,
          );
        });
        await tester.pump();
        await tester.pump();

        expect(editable.controller.text, 'newer remote draft');
      },
    );

    testWidgets(
      'a newer surface token wins when its apply races an older IME drain',
      (tester) async {
        const initial = SessionDetailState(
          tool: 'claude',
          sessionId: 'session-1',
          bootstrapState: SessionDetailBootstrapState(
            readiness: SessionDetailBootstrapReadiness.ready,
            attempt: 1,
          ),
        );
        final seeded = SeededSessionDetailController(initial);
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            seededController: seeded,
          ),
        );
        await tester.pumpAndSettle();

        final editable = tester.widget<EditableText>(
          find.descendant(
            of: find.byKey(const Key('session-detail-prompt-input')),
            matching: find.byType(EditableText),
          ),
        );
        editable.focusNode.requestFocus();
        editable.controller.value = const TextEditingValue(
          text: 'local composing',
          selection: TextSelection.collapsed(offset: 15),
          composing: TextRange(start: 6, end: 15),
        );
        await tester.pump();

        seeded.emittedState = initial.copyWith(
          draftSurface: const SessionDraftSurface(
            text: 'older staged surface',
            token: 1,
            kind: SessionDraftSurfaceKind.forceReplace,
          ),
        );
        await tester.pump();
        await tester.pump();
        expect(editable.controller.text, 'local composing');

        seeded.emittedState = initial.copyWith(
          draftSurface: const SessionDraftSurface(
            text: 'newer surface',
            token: 2,
            kind: SessionDraftSurfaceKind.forceReplace,
          ),
        );
        tester.binding.addPostFrameCallback((_) {
          editable.controller.value = editable.controller.value.copyWith(
            composing: TextRange.empty,
          );
        });
        await tester.pump();
        await tester.pump();

        expect(editable.controller.text, 'newer surface');
      },
    );

    testWidgets('voice input inserts a draft and never sends it', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(events: const []);
      final speechInput = FakeSpeechInput();
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          speechInput: speechInput,
        ),
      );
      await tester.pumpAndSettle();

      final inputFinder = find.byKey(
        const Key('session-detail-prompt-input'),
      );
      await tester.enterText(inputFinder, 'draft tail');
      final controller = tester.widget<TextField>(inputFinder).controller!
        ..selection = const TextSelection.collapsed(offset: 5);

      await tester.tap(
        find.byKey(const Key('session-detail-voice-input-button')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('voice-policy-platform-service')));
      await tester.pumpAndSettle();

      speechInput.emitReady('spoken words');
      await tester.pumpAndSettle();

      expect(controller.text, 'draft spoken words tail');
      expect(connection.sendPromptCount, 0);
    });

    testWidgets('two dictations each insert once and never send', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(events: const []);
      final speechInput = FakeSpeechInput();
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          speechInput: speechInput,
        ),
      );
      await tester.pumpAndSettle();

      final inputFinder = find.byKey(
        const Key('session-detail-prompt-input'),
      );
      final controller = tester.widget<TextField>(inputFinder).controller!;

      speechInput.emitReady('first');
      await tester.pumpAndSettle();
      expect(controller.text, 'first');

      speechInput.emitReady('second');
      await tester.pumpAndSettle();
      expect(controller.text, 'first second');
      expect(connection.sendPromptCount, 0);
    });

    testWidgets('backgrounding cancels active voice input', (tester) async {
      addTearDown(
        () => tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        ),
      );
      final speechInput = FakeSpeechInput();
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], speechInput: speechInput),
      );
      await tester.pumpAndSettle();

      speechInput.emitListening();
      expect(speechInput.current, isA<SpeechInputListening>());

      tester.binding.handleAppLifecycleStateChanged(AppLifecycleState.paused);
      await tester.pumpAndSettle();

      expect(speechInput.cancelCallCount, 1);
      expect(speechInput.current, isA<SpeechInputIdle>());
    });

    testWidgets('shows recognition failure after an attempted dictation', (
      tester,
    ) async {
      final speechInput = FakeSpeechInput();
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], speechInput: speechInput),
      );
      await tester.pumpAndSettle();

      await tester.tap(
        find.byKey(const Key('session-detail-voice-input-button')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('voice-policy-platform-service')));
      await tester.pumpAndSettle();
      speechInput.emitUnavailable('Microphone permission was denied.');
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('voice-input-status')), findsOneWidget);
      expect(find.text('Microphone permission was denied.'), findsOneWidget);
    });

    testWidgets('keeps composer controls visible across widths', (
      tester,
    ) async {
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });

      for (final size in const [Size(360, 720), Size(1280, 800)]) {
        tester.view
          ..physicalSize = size
          ..devicePixelRatio = 1;

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
          ),
        );
        await tester.pumpAndSettle();

        // U3: the harness session resolves with an empty title, so the strip
        // names it neutrally instead of falling back to its native id.
        expect(find.text('Untitled session'), findsOneWidget);
        expect(find.text('session-1'), findsNothing);
        expect(
          find.byKey(const Key('session-detail-prompt-input')),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('session-detail-send-button')),
          findsOneWidget,
        );
      }
    });

    testWidgets('chat content keeps a gutter at phone width', (tester) async {
      // The chat tab is full-bleed so the transcript scrollbar can reach the
      // window edge. Below the readable-width cap the ConstrainedBox is a
      // no-op, so nothing but the inner horizontal padding keeps chat content
      // off the screen edge — guard it here, since no other test would catch
      // text running edge to edge on a phone.
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });
      tester.view
        ..physicalSize = const Size(360, 720)
        ..devicePixelRatio = 1;

      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                id: 'model-1',
                type: AgentMessageType.modelOutput,
                raw: {'type': 'model-output', 'text': 'Edge to edge?'},
              ),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      const gutter = 16.0;
      final scrollView = tester.getRect(
        find.byKey(const Key('session-detail-chat-scroll')),
      );
      expect(scrollView.left, 0);
      expect(scrollView.right, 360);

      final bubble = tester.getRect(
        find.byKey(const ValueKey('session-message-context-model-1')),
      );
      expect(bubble.left, greaterThanOrEqualTo(gutter));
      expect(bubble.right, lessThanOrEqualTo(360 - gutter));

      final composer = tester.getRect(
        find.byKey(const Key('session-detail-prompt-input')),
      );
      expect(composer.left, greaterThanOrEqualTo(gutter));
      expect(composer.right, lessThanOrEqualTo(360 - gutter));
    });

    testWidgets(
      'keeps local composer editable while disconnected',
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
              events: [HistoryWireEvent(messages: [], reset: true)],
            ),
          ),
        );
        await tester.pumpAndSettle();

        final disconnectedInput = tester.widget<TextField>(
          find.byKey(const Key('session-detail-prompt-input')),
        );
        expect(disconnectedInput.enabled, isTrue);
        await tester.enterText(
          find.byKey(const Key('session-detail-prompt-input')),
          'staged while reconnecting',
        );
        await tester.pump(const Duration(milliseconds: 300));
        expect(
          disconnectedInput.controller?.text,
          'staged while reconnecting',
        );
        final disconnectedSendButton = tester.widget<IconButton>(
          find.byKey(const Key('session-detail-send-button')),
        );
        expect(disconnectedSendButton.onPressed, isNull);
        final attachButton = tester.widget<IconButton>(
          find.byKey(const Key('session-detail-attach-button')),
        );
        expect(attachButton.onPressed, isNull);
      },
    );

    testWidgets(
      'multi-select stages chips and sends text plus retained files once',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(events: const []);
        final attachmentPicker = FakeSessionAttachmentPicker()
          ..selectedAttachments = const [
            SessionAttachment(
              name: 'notes.txt',
              data: 'aGVsbG8=',
              byteLength: 5,
              mimeType: 'text/plain',
            ),
            SessionAttachment(
              name: 'diagram.svg',
              data: 'PHN2Zy8+',
              byteLength: 6,
              mimeType: 'image/svg+xml',
            ),
          ];
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            attachmentPicker: attachmentPicker,
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(find.byKey(const Key('session-detail-attach-button')));
        await tester.pumpAndSettle();

        expect(attachmentPicker.pickCount, 1);
        expect(attachmentPicker.allowMultipleValues, [isTrue]);
        expect(connection.sendFileCount, 0);
        expect(connection.sendPromptCount, 0);
        expect(find.text('notes.txt'), findsOneWidget);
        expect(find.text('diagram.svg'), findsOneWidget);
        expect(find.text('5 bytes · Ready to send'), findsOneWidget);

        attachmentPicker.selectedAttachments = const [
          SessionAttachment(
            name: 'revised.txt',
            data: 'cmV2aXNlZA==',
            byteLength: 7,
            mimeType: 'text/plain',
          ),
        ];
        await tester.tap(
          find.byKey(
            const Key('session-detail-attachment-replace-attachment-1'),
          ),
        );
        await tester.pumpAndSettle();
        expect(attachmentPicker.allowMultipleValues, [isTrue, isFalse]);
        expect(find.text('notes.txt'), findsNothing);
        expect(find.text('revised.txt'), findsOneWidget);

        await tester.tap(
          find.byKey(
            const Key('session-detail-attachment-remove-attachment-2'),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('diagram.svg'), findsNothing);

        await tester.enterText(
          find.byKey(const Key('session-detail-prompt-input')),
          'Review the revision',
        );
        await tester.tap(find.byKey(const Key('session-detail-send-button')));
        await tester.pump();

        expect(connection.sendPromptCount, 1);
        expect(connection.lastPrompt, 'Review the revision');
        expect(connection.lastPromptFiles, hasLength(1));
        expect(connection.lastPromptFiles.single.name, 'revised.txt');
        expect(connection.lastPromptFiles.single.data, 'cmV2aXNlZA==');
        expect(connection.lastPromptFiles.single.stagedRef, isNull);
        expect(
          find.byKey(
            const Key('session-detail-attachment-remove-attachment-1'),
          ),
          findsOneWidget,
          reason: 'files remain until the prompt terminal ACK',
        );

        connection.emitEvent(
          AckWireEvent(
            ackKind: 'client-message',
            clientMessageId: connection.lastPromptClientMessageId,
          ),
        );
        await tester.pumpAndSettle();
        expect(find.text('revised.txt'), findsNothing);
        expect(
          tester
              .widget<TextField>(
                find.byKey(const Key('session-detail-prompt-input')),
              )
              .controller
              ?.text,
          isEmpty,
        );
      },
    );

    testWidgets(
      'attachment ACK preserves a newer draft typed while send is pending',
      (tester) async {
        final connection = ScriptedSessionDetailConnection(events: const []);
        final attachmentPicker = FakeSessionAttachmentPicker();
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            attachmentPicker: attachmentPicker,
          ),
        );
        await tester.pumpAndSettle();

        final input = find.byKey(const Key('session-detail-prompt-input'));
        await tester.tap(find.byKey(const Key('session-detail-attach-button')));
        await tester.pumpAndSettle();
        await tester.enterText(input, 'First prompt with a file');
        await tester.tap(find.byKey(const Key('session-detail-send-button')));
        await tester.pump();

        expect(connection.sendPromptCount, 1);
        expect(connection.lastPromptFiles, hasLength(1));
        await tester.enterText(input, 'Second draft while waiting for ACK');
        await tester.pump();

        connection.emitEvent(
          AckWireEvent(
            ackKind: 'client-message',
            clientMessageId: connection.lastPromptClientMessageId,
          ),
        );
        await tester.pumpAndSettle();

        expect(
          tester.widget<TextField>(input).controller?.text,
          'Second draft while waiting for ACK',
        );
        expect(find.text('notes.txt'), findsNothing);
      },
    );

    testWidgets('prompt NACK retains attachment and text for retry', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(events: const []);
      final attachmentPicker = FakeSessionAttachmentPicker();
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          attachmentPicker: attachmentPicker,
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('session-detail-attach-button')));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const Key('session-detail-prompt-input')),
        'Keep this draft',
      );
      await tester.tap(find.byKey(const Key('session-detail-send-button')));
      await tester.pump();
      connection.emitEvent(
        NackWireEvent(
          code: 'attachment-consumption-failed',
          message: 'adapter did not receive the file',
          clientMessageId: connection.lastPromptClientMessageId,
        ),
      );
      await tester.pumpAndSettle();

      expect(connection.sendPromptCount, 1);
      expect(find.text('notes.txt'), findsOneWidget);
      expect(
        find.text('5 bytes · Not delivered — retry by sending'),
        findsOneWidget,
      );
      expect(
        find.text(
          "The agent didn't receive every file. "
          'Your prompt and files are still here.',
        ),
        findsOneWidget,
      );
      expect(find.textContaining('adapter did not receive'), findsNothing);
      expect(
        tester
            .widget<TextField>(
              find.byKey(const Key('session-detail-prompt-input')),
            )
            .controller
            ?.text,
        'Keep this draft',
      );
    });

    testWidgets(
      'attachment chips are localized and usable in light/dark compact/roomy',
      (tester) async {
        final semantics = tester.ensureSemantics();
        final spec = themeSpecById(kDefaultThemeId);
        for (final variant in [
          (
            size: const Size(360, 760),
            brightness: Brightness.light,
            platform: TargetPlatform.android,
            locale: const Locale('en'),
            status: '5 bytes · Ready to send',
            semantic: 'notes.txt, 5 bytes, Ready to send',
          ),
          (
            size: const Size(1200, 800),
            brightness: Brightness.dark,
            platform: TargetPlatform.linux,
            locale: const Locale('zh'),
            status: '5 字节 · 可以发送',
            semantic: 'notes.txt，5 字节，可以发送',
          ),
        ]) {
          tester.view
            ..physicalSize = variant.size
            ..devicePixelRatio = 1;
          final tokens = variant.brightness == Brightness.dark
              ? spec.dark
              : spec.light;
          final attachmentPicker = FakeSessionAttachmentPicker();
          await tester.pumpWidget(
            buildSessionDetailTestPage(
              events: const [],
              attachmentPicker: attachmentPicker,
              locale: variant.locale,
              theme: buildAppTheme(
                tokens,
                variant.brightness,
              ).copyWith(platform: variant.platform),
            ),
          );
          await tester.pumpAndSettle();
          await tester.tap(
            find.byKey(const Key('session-detail-attach-button')),
          );
          await tester.pumpAndSettle();

          expect(find.text(variant.status), findsOneWidget);
          expect(
            tester
                .getSemantics(find.byKey(const ValueKey('attachment-1')))
                .label,
            contains(variant.semantic),
          );
          final remove = find.byKey(
            const Key('session-detail-attachment-remove-attachment-1'),
          );
          final replace = find.byKey(
            const Key('session-detail-attachment-replace-attachment-1'),
          );
          expect(remove, findsOneWidget);
          expect(replace, findsOneWidget);
          if (variant.platform == TargetPlatform.android) {
            expect(
              tester.getSize(remove).shortestSide,
              greaterThanOrEqualTo(40),
            );
            expect(
              tester.getSize(replace).shortestSide,
              greaterThanOrEqualTo(40),
            );
          }
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox.shrink());
        }
        tester.view
          ..resetPhysicalSize()
          ..resetDevicePixelRatio();
        semantics.dispose();
      },
    );

    testWidgets(
      'attachment composer goldens show ready controls and delivery failure',
      (tester) async {
        tester.view
          ..physicalSize = const Size(1000, 720)
          ..devicePixelRatio = 1;
        addTearDown(() {
          tester.view
            ..resetPhysicalSize()
            ..resetDevicePixelRatio();
        });
        final spec = themeSpecById(kDefaultThemeId);
        final picker = FakeSessionAttachmentPicker()
          ..selectedAttachments = const [
            SessionAttachment(
              name: 'research-notes.txt',
              data: 'aGVsbG8=',
              byteLength: 5,
              mimeType: 'text/plain',
            ),
            SessionAttachment(
              name: 'architecture.svg',
              data: 'PHN2Zy8+',
              byteLength: 6,
              mimeType: 'image/svg+xml',
            ),
          ];

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            attachmentPicker: picker,
            theme: buildAppTheme(spec.light, Brightness.light),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('session-detail-attach-button')));
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const Key('session-detail-prompt-input')),
          'Review both attached files',
        );
        await tester.pump();
        await expectLater(
          find.byKey(const Key('session-detail-composer')),
          matchesGoldenFile(
            'goldens/attachment_composer_light_ready.png',
          ),
        );

        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pumpAndSettle();
        final connection = ScriptedSessionDetailConnection(events: const []);
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            connection: connection,
            attachmentPicker: picker,
            theme: buildAppTheme(spec.dark, Brightness.dark),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('session-detail-attach-button')));
        await tester.pumpAndSettle();
        await tester.enterText(
          find.byKey(const Key('session-detail-prompt-input')),
          'Keep this draft if delivery fails',
        );
        await tester.tap(find.byKey(const Key('session-detail-send-button')));
        await tester.pump();
        connection.emitEvent(
          NackWireEvent(
            code: 'attachment-consumption-failed',
            message: 'adapter did not receive the files',
            clientMessageId: connection.lastPromptClientMessageId,
          ),
        );
        await tester.pumpAndSettle();
        await expectLater(
          find.byType(SessionDetailPage),
          matchesGoldenFile(
            'goldens/attachment_composer_dark_delivery_failure.png',
          ),
        );
      },
    );

    testWidgets(
      'capability gate disables attachments without adapter support',
      (
        tester,
      ) async {
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            brokerClient: FakeBrokerClient(
              agents: [
                fakeAgentInfo(supportsNativeFileInput: false),
              ],
            ),
          ),
        );
        await tester.pumpAndSettle();

        final attach = tester.widget<IconButton>(
          find.byKey(const Key('session-detail-attach-button')),
        );
        expect(attach.onPressed, isNull);
        expect(
          find.byTooltip("Files aren't supported in this session"),
          findsOneWidget,
        );
      },
    );

    testWidgets('disables send when connected prompt is empty', (tester) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
        ),
      );
      await tester.pumpAndSettle();

      final connectedInput = tester.widget<TextField>(
        find.byKey(const Key('session-detail-prompt-input')),
      );
      expect(connectedInput.enabled, isTrue);
      final emptySendButton = tester.widget<IconButton>(
        find.byKey(const Key('session-detail-send-button')),
      );
      expect(emptySendButton.onPressed, isNull);
    });

    testWidgets('Control-K focuses the prompt composer', (tester) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
        ),
      );
      await tester.pumpAndSettle();

      final promptEditable = find.descendant(
        of: find.byKey(const Key('session-detail-prompt-input')),
        matching: find.byType(EditableText),
      );
      expect(
        tester.widget<EditableText>(promptEditable).focusNode.hasFocus,
        isFalse,
      );

      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyK);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await tester.pump();

      expect(
        tester.widget<EditableText>(promptEditable).focusNode.hasFocus,
        isTrue,
      );
    });

    testWidgets('Control-Enter sends on Linux while plain Enter is multiline', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(events: const []);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();

      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.enterText(input, 'first line');
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(connection.sendPromptCount, 0);
      final field = tester.widget<TextField>(input);
      expect(field.keyboardType, TextInputType.multiline);
      expect(field.textInputAction, TextInputAction.newline);
      expect(field.controller?.text, 'first line');

      await tester.enterText(input, 'send from Linux');
      await pressModifiedEnter(tester, LogicalKeyboardKey.controlLeft);
      await tester.pumpAndSettle();
      expect(connection.sendPromptCount, 1);
      expect(connection.lastPrompt, 'send from Linux');
    });

    testWidgets('Command-Enter is the macOS send chord, not Control-Enter', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(events: const []);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          theme: platformTheme(TargetPlatform.macOS),
        ),
      );
      await tester.pumpAndSettle();

      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.enterText(input, 'send from macOS');
      await pressModifiedEnter(tester, LogicalKeyboardKey.controlLeft);
      expect(connection.sendPromptCount, 0);

      await pressModifiedEnter(tester, LogicalKeyboardKey.metaLeft);
      await tester.pumpAndSettle();
      expect(connection.sendPromptCount, 1);
      expect(connection.lastPrompt, 'send from macOS');
    });

    testWidgets('send chord is scoped to the focused composer', (tester) async {
      final connection = ScriptedSessionDetailConnection(events: const []);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();

      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.enterText(input, 'do not send globally');
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pump();
      await pressModifiedEnter(tester, LogicalKeyboardKey.controlLeft);

      expect(connection.sendPromptCount, 0);
      expect(
        tester.widget<TextField>(input).controller?.text,
        'do not send globally',
      );
    });

    testWidgets('slash palette keeps priority over the send chord', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(
        events: const [
          CommandsWireEvent(
            commands: [
              SlashCommand(name: 'goal', kind: SlashCommandKind.prompt),
            ],
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();

      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.enterText(input, '/g');
      await tester.pump();
      expect(
        find.byKey(const Key('session-detail-slash-palette')),
        findsOneWidget,
      );
      await pressModifiedEnter(tester, LogicalKeyboardKey.controlLeft);

      expect(connection.sendPromptCount, 0);
      expect(tester.widget<TextField>(input).controller?.text, '/goal ');
    });

    testWidgets('send chord does not submit an active IME composition', (
      tester,
    ) async {
      final connection = ScriptedSessionDetailConnection(events: const []);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();

      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.tap(input);
      final controller = tester.widget<TextField>(input).controller!
        ..value = const TextEditingValue(
          text: 'composing',
          selection: TextSelection.collapsed(offset: 9),
          composing: TextRange(start: 0, end: 9),
        );
      await tester.pump();
      await pressModifiedEnter(tester, LogicalKeyboardKey.controlLeft);

      expect(connection.sendPromptCount, 0);
      expect(controller.text, 'composing');
    });

    testWidgets('rapid repeated send chords cannot duplicate a submission', (
      tester,
    ) async {
      final sendWrite = Completer<void>();
      final connection = ScriptedSessionDetailConnection(
        events: const [],
        onSendPrompt: () => sendWrite.future,
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('session-detail-prompt-input')),
        'only once',
      );
      await tester.pump();
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await tester.pump();

      expect(connection.sendPromptCount, 1);
      sendWrite.complete();
      await tester.pumpAndSettle();
      expect(connection.sendPromptCount, 1);
    });

    testWidgets('clears prompt only after successful send', (tester) async {
      final connection = ScriptedSessionDetailConnection(events: const []);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
        ),
      );
      await tester.pumpAndSettle();

      const prompt = '  this is a test  ';
      await tester.enterText(
        find.byKey(const Key('session-detail-prompt-input')),
        prompt,
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('session-detail-send-button')));
      await tester.pumpAndSettle();

      expect(connection.sendPromptCount, 1);
      expect(connection.lastPrompt, 'this is a test');
      expect(
        tester
                .widget<TextField>(
                  find.byKey(const Key('session-detail-prompt-input')),
                )
                .controller
                ?.text ??
            '',
        isEmpty,
      );
    });

    testWidgets('keeps prompt text on send failure', (tester) async {
      final connection = ScriptedSessionDetailConnection(
        events: const [],
        failFirstSend: true,
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
        ),
      );
      await tester.pumpAndSettle();

      await tester.enterText(
        find.byKey(const Key('session-detail-prompt-input')),
        'fail-send',
      );
      await tester.pump();
      await tester.tap(find.byKey(const Key('session-detail-send-button')));
      await tester.pumpAndSettle();

      expect(connection.sendPromptCount, 1);
      expect(
        tester
                .widget<TextField>(
                  find.byKey(const Key('session-detail-prompt-input')),
                )
                .controller
                ?.text ??
            '',
        'fail-send',
      );
    });
  });
}
