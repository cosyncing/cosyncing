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

    // P1d. The capture used to OR in `liveState.activities.isNotEmpty`, so any
    // live agent-activity bar marked an idle session's send queued — and the
    // flag is immutable after capture, so the badge never cleared.

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
        expect(
          find.byKey(const Key('session-detail-information')),
          findsOneWidget,
        );
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

      const gutter = 12.0;
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
          await openComposerMenu(tester);
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
        await openComposerMenu(tester);
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
        await openComposerMenu(tester);
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
  });

  group('composer clear after an accepted send', () {
    testWidgets('a no-op controller revision still clears the sent text', (
      tester,
    ) async {
      // `_promptRevision` counts EVERY controller mutation -- the page says so
      // itself: "including remote/programmatic changes and edits that return
      // to the same empty value". The post-send clear required that counter to
      // be unchanged AND the text to still equal what was sent. Any no-op
      // mutation landing during the send await -- a composition drain, a draft
      // hydration re-applying the same string, a shared-draft echo -- bumped
      // the counter, so the clear was skipped and the SENT prompt stayed in
      // the composer as unsent text. From there it publishes as the shared
      // draft and becomes durable.
      //
      // Measured on installed v61: reasonix-permission-resolved.png shows the
      // prompt still in the composer while the transcript shows that same
      // prompt "Queued" -- before any reload. 28 sessions on that host held an
      // already-executed `rm -f <path> && touch <path>` this way.
      const prompt = 'rm -f /tmp/marker && touch /tmp/marker';
      final input = find.byKey(const Key('session-detail-prompt-input'));
      late final ScriptedSessionDetailConnection connection;
      connection = ScriptedSessionDetailConnection(
        events: const [],
        onSendPrompt: () async {
          // Text untouched; only the selection moves. This is the cheapest
          // faithful stand-in for the mutations that actually occur here, and
          // it is exactly the class the counter is documented to include.
          final field = tester.widget<TextField>(input);
          final controller = field.controller!;
          controller.value = controller.value.copyWith(
            selection: const TextSelection.collapsed(offset: 0),
          );
        },
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();

      await tester.enterText(input, prompt);
      await tester.pump();
      await tester.tap(find.byKey(const Key('session-detail-send-button')));
      await tester.pumpAndSettle();

      expect(connection.sendPromptCount, 1);
      expect(
        tester.widget<TextField>(input).controller!.text,
        isEmpty,
        reason: 'a sent prompt must not stay in the composer as unsent text',
      );
    });
  });
}
