import 'dart:async';

import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/design/ui_scale.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:cosyncing_client/src/platform/update/web_handoff_participants.dart';
import 'package:desktop_drop/desktop_drop.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

void main() {
  group('desktop attachment intake', () {
    ThemeData platformTheme(TargetPlatform platform) => ThemeData(
      platform: platform,
      splashFactory: InkRipple.splashFactory,
      extensions: [themeSpecById(kDefaultThemeId).light],
    );

    Future<void> pressPaste(WidgetTester tester) async {
      await tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
      await tester.sendKeyEvent(LogicalKeyboardKey.keyV);
      await tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
      await tester.pump();
    }

    testWidgets('desktop drop surface leaves mobile unchanged', (tester) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('session-detail-attachment-drop-region')),
        findsOneWidget,
      );

      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          theme: platformTheme(TargetPlatform.android),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const Key('session-detail-attachment-drop-region')),
        findsNothing,
      );
    });

    testWidgets('actionable plain and rich paste remain draft text only', (
      tester,
    ) async {
      final clipboard = _FakeClipboard.native([
        const SessionAttachmentClipboardText('plain text'),
        const SessionAttachmentClipboardText(' + rich fallback'),
      ]);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          attachmentClipboard: clipboard,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.tap(input);

      await pressPaste(tester);
      await pressPaste(tester);
      await tester.pumpAndSettle();

      expect(
        tester.widget<TextField>(input).controller?.text,
        'plain text + rich fallback',
      );
      expect(find.byType(ActionChip), findsNothing);
      expect(clipboard.nativeReadCount, 2);
    });

    testWidgets('web text representations are never claimed as files', (
      tester,
    ) async {
      final clipboard = _FakeClipboard.web();
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          attachmentClipboard: clipboard,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.tap(input);
      final event = _FakeWebPasteEvent.text();

      clipboard.emit(event);
      // Browser/EditableText owns the unclaimed rich paste fallback.
      await tester.enterText(input, 'browser rich fallback');
      await tester.pump();

      expect(event.claimCount, 0);
      expect(
        tester.widget<TextField>(input).controller?.text,
        'browser rich fallback',
      );
      expect(find.byType(ActionChip), findsNothing);
    });

    testWidgets('rapid native paste gestures are serialized without loss', (
      tester,
    ) async {
      final first = Completer<SessionAttachmentClipboardRead>();
      final second = Completer<SessionAttachmentClipboardRead>();
      final clipboard = _FakeClipboard.nativeFutures([
        first.future,
        second.future,
      ]);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          attachmentClipboard: clipboard,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('session-detail-prompt-input')));

      await pressPaste(tester);
      await pressPaste(tester);
      expect(clipboard.nativeReadCount, 1);
      first.complete(
        SessionAttachmentClipboardFiles([_memoryItem('one.png', 1)]),
      );
      for (var attempt = 0; attempt < 20; attempt += 1) {
        await tester.pump(const Duration(milliseconds: 10));
        if (clipboard.nativeReadCount == 2) break;
      }
      expect(clipboard.nativeReadCount, 2);
      second.complete(
        SessionAttachmentClipboardFiles([_memoryItem('two.png', 2)]),
      );
      await tester.pumpAndSettle();

      expect(find.text('one.png'), findsOneWidget);
      expect(find.text('two.png'), findsOneWidget);
    });

    testWidgets('pending paste blocks send until attachment intake settles', (
      tester,
    ) async {
      final gate = Completer<SessionAttachmentClipboardRead>();
      final clipboard = _FakeClipboard.nativeFutures([gate.future]);
      final connection = ScriptedSessionDetailConnection(events: const []);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          attachmentClipboard: clipboard,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.enterText(input, 'wait for the file');
      await tester.tap(input);
      await pressPaste(tester);

      await tester.tap(find.byKey(const Key('session-detail-send-button')));
      await tester.pump();
      expect(connection.sendPromptCount, 0);
      expect(
        tester
            .widget<IconButton>(
              find.byKey(const Key('session-detail-send-button')),
            )
            .onPressed,
        isNull,
      );

      gate.complete(
        SessionAttachmentClipboardFiles([_memoryItem('ready.png', 1)]),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('session-detail-send-button')));
      await tester.pump();
      expect(connection.sendPromptCount, 1);
    });

    testWidgets('paste holds and queued acquisition are bounded at ownership', (
      tester,
    ) async {
      final gates = List.generate(
        9,
        (_) => Completer<SessionAttachmentClipboardRead>(),
      );
      final clipboard = _FakeClipboard.nativeFutures(
        gates.map((gate) => gate.future).toList(growable: false),
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          attachmentClipboard: clipboard,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('session-detail-prompt-input')));
      final baseline = WebHandoffParticipants.instance.participantCount;

      for (var gesture = 0; gesture < 9; gesture += 1) {
        await pressPaste(tester);
      }
      expect(
        WebHandoffParticipants.instance.participantCount,
        baseline + 8,
      );
      expect(clipboard.nativeReadCount, 1);

      await tester.pump(
        sessionAttachmentIntakeTimeout + const Duration(seconds: 1),
      );
      expect(WebHandoffParticipants.instance.participantCount, baseline);
      expect(clipboard.nativeReadCount, 1);
    });

    testWidgets('a failed clipboard probe still delivers the text paste', (
      tester,
    ) async {
      final clipboard = _FakeClipboard.nativeFutures([
        _failedRead(PlatformException(code: 'clipboard-unavailable')),
      ])..nativeTextReads = [Future.value('recovered text')];
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          attachmentClipboard: clipboard,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.tap(input);

      await pressPaste(tester);
      await tester.pumpAndSettle();

      // The chord was consumed, so the composer owes the ordinary paste.
      expect(clipboard.nativeTextReadCount, 1);
      expect(
        tester.widget<TextField>(input).controller?.text,
        'recovered text',
      );
      expect(find.byType(ActionChip), findsNothing);
    });

    testWidgets('a refused file clipboard never inserts its fallback text', (
      tester,
    ) async {
      final clipboard = _FakeClipboard.nativeFutures([
        _failedRead(const SessionAttachmentIntakeException('selection-size')),
      ])..nativeTextReads = [Future.value('file:///copied/photo.png')];
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          attachmentClipboard: clipboard,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.tap(input);

      await pressPaste(tester);
      await tester.pumpAndSettle();

      // A rejected file gesture is not a text paste: no URI fallback leaks in.
      expect(clipboard.nativeTextReadCount, 0);
      expect(tester.widget<TextField>(input).controller?.text, isEmpty);
      expect(find.textContaining("Couldn't add those files"), findsOneWidget);
    });

    testWidgets('paste overflow releases the chord to ordinary text paste', (
      tester,
    ) async {
      final gates = List.generate(
        sessionAttachmentMaxPendingGestures,
        (_) => Completer<SessionAttachmentClipboardRead>(),
      );
      final clipboard = _FakeClipboard.nativeFutures(
        gates.map((gate) => gate.future).toList(growable: false),
      );
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async => call.method == 'Clipboard.getData'
            ? <String, dynamic>{'text': 'platform paste'}
            : null,
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          attachmentClipboard: clipboard,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.tap(input);

      for (
        var gesture = 0;
        gesture < sessionAttachmentMaxPendingGestures;
        gesture += 1
      ) {
        await pressPaste(tester);
      }
      expect(tester.widget<TextField>(input).controller?.text, isEmpty);

      // The ninth gesture gets no lease, so nothing in A1b will ever insert
      // its text. The chord must fall through to EditableText instead of
      // being consumed and dropped.
      await pressPaste(tester);
      await tester.pumpAndSettle();

      expect(
        tester.widget<TextField>(input).controller?.text,
        'platform paste',
      );
    });

    testWidgets('text pasted after a caret move lands where it was pasted', (
      tester,
    ) async {
      final gate = Completer<SessionAttachmentClipboardRead>();
      final clipboard = _FakeClipboard.nativeFutures([gate.future]);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          attachmentClipboard: clipboard,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.enterText(input, 'head tail');
      await tester.tap(input);
      // Tapping moves the caret, so anchor the paste point afterwards.
      final controller = tester.widget<TextField>(input).controller!
        ..selection = const TextSelection.collapsed(offset: 4);
      await tester.pump();

      await pressPaste(tester);
      // The user moves the caret while the clipboard read is still in flight.
      controller.selection = const TextSelection.collapsed(offset: 9);
      await tester.pump();
      gate.complete(const SessionAttachmentClipboardText(' MID'));
      await tester.pumpAndSettle();

      expect(controller.text, 'head MID tail');
    });

    testWidgets('text pasted after a draft edit keeps the real input order', (
      tester,
    ) async {
      final gate = Completer<SessionAttachmentClipboardRead>();
      final clipboard = _FakeClipboard.nativeFutures([gate.future]);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          attachmentClipboard: clipboard,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.enterText(input, 'head tail');
      await tester.tap(input);
      final controller = tester.widget<TextField>(input).controller!
        ..selection = const TextSelection.collapsed(offset: 4);
      await tester.pump();

      await pressPaste(tester);
      // The user types at the start while the clipboard read is in flight.
      controller.value = const TextEditingValue(
        text: 'ZZhead tail',
        selection: TextSelection.collapsed(offset: 2),
      );
      await tester.pump();
      gate.complete(const SessionAttachmentClipboardText(' MID'));
      await tester.pumpAndSettle();

      // The paste belongs after 'head', where it was made — not after the
      // characters typed later.
      expect(controller.text, 'ZZhead MID tail');
    });

    testWidgets('text pasted after edits on both sides keeps input order', (
      tester,
    ) async {
      final gate = Completer<SessionAttachmentClipboardRead>();
      final clipboard = _FakeClipboard.nativeFutures([gate.future]);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          attachmentClipboard: clipboard,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.enterText(input, 'head tail');
      await tester.tap(input);
      final controller = tester.widget<TextField>(input).controller!
        ..selection = const TextSelection.collapsed(offset: 4);
      await tester.pump();

      await pressPaste(tester);
      // Two edits, one on each side of the paste point. A single diff of the
      // finished text against the anchor cannot tell these apart from one
      // replacement covering the paste point; folding them in as they arrive
      // can.
      controller.value = const TextEditingValue(
        text: 'ZZhead tail',
        selection: TextSelection.collapsed(offset: 2),
      );
      await tester.pump();
      controller.value = const TextEditingValue(
        text: 'ZZhead tailYY',
        selection: TextSelection.collapsed(offset: 13),
      );
      await tester.pump();
      gate.complete(const SessionAttachmentClipboardText(' MID'));
      await tester.pumpAndSettle();

      expect(controller.text, 'ZZhead MID tailYY');
    });

    testWidgets('an accepted send voids the text a dead lease still owed', (
      tester,
    ) async {
      final gate = Completer<SessionAttachmentClipboardRead>();
      final clipboard = _FakeClipboard.nativeFutures([gate.future]);
      final connection = ScriptedSessionDetailConnection(events: const []);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          attachmentClipboard: clipboard,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.enterText(input, 'first draft');
      await tester.tap(input);
      await pressPaste(tester);

      // The gesture expires, which releases the lease and unblocks send.
      await tester.pump(
        sessionAttachmentIntakeTimeout + const Duration(seconds: 1),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('session-detail-send-button')));
      await tester.pumpAndSettle();
      expect(connection.sendPromptCount, 1);
      final controller = tester.widget<TextField>(input).controller!;
      expect(controller.text, isEmpty);

      // The user starts the next draft, and only then does the platform
      // answer. The draft the chord was pressed against is gone, so the text
      // it owed is void — it must not cross into this one.
      await tester.enterText(input, 'second draft');
      await tester.pump();
      gate.complete(const SessionAttachmentClipboardText('LATE'));
      await tester.pumpAndSettle();

      expect(controller.text, 'second draft');
    });

    testWidgets('a paste the editor refuses is reported, not swallowed', (
      tester,
    ) async {
      final gate = Completer<SessionAttachmentClipboardRead>();
      final clipboard = _FakeClipboard.nativeFutures([gate.future]);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          attachmentClipboard: clipboard,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.enterText(input, 'head');
      await tester.tap(input);
      await tester.pump();

      await pressPaste(tester);
      // An IME composition opens while the clipboard is still answering. The
      // composer refuses to insert into it — correctly — but the chord was
      // already consumed, so silence would lose the paste with no signal.
      final controller = tester.widget<TextField>(input).controller!
        ..value = const TextEditingValue(
          text: 'headni',
          selection: TextSelection.collapsed(offset: 6),
          composing: TextRange(start: 4, end: 6),
        );
      await tester.pump();
      gate.complete(const SessionAttachmentClipboardText(' MID'));
      await tester.pumpAndSettle();

      expect(controller.text, 'headni');
      expect(
        find.textContaining("Couldn't add those"),
        findsOneWidget,
        reason: 'a consumed chord that inserted nothing must say so',
      );
    });

    testWidgets('a send that keeps the draft still owes it the text', (
      tester,
    ) async {
      final gate = Completer<SessionAttachmentClipboardRead>();
      final clipboard = _FakeClipboard.nativeFutures([gate.future]);
      final connection = ScriptedSessionDetailConnection(events: const []);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          attachmentClipboard: clipboard,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.enterText(input, 'head tail');
      await tester.tap(input);
      final controller = tester.widget<TextField>(input).controller!
        ..selection = const TextSelection.collapsed(offset: 4);
      await tester.pump();
      await pressPaste(tester);
      await tester.pump(
        sessionAttachmentIntakeTimeout + const Duration(seconds: 1),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('session-detail-send-button')));
      // The user keeps typing while the prompt is in flight, so the send
      // deliberately does NOT clear the composer.
      controller.value = const TextEditingValue(
        text: 'head tail and more',
        selection: TextSelection.collapsed(offset: 18),
      );
      await tester.pumpAndSettle();
      expect(connection.sendPromptCount, 1);
      expect(controller.text, 'head tail and more');

      gate.complete(const SessionAttachmentClipboardText(' MID'));
      await tester.pumpAndSettle();

      // That draft never ended, so the paste still belongs in it, at the point
      // it was made.
      expect(controller.text, 'head MID tail and more');
    });

    testWidgets('text arriving after the deadline is still pasted', (
      tester,
    ) async {
      final gate = Completer<SessionAttachmentClipboardRead>();
      final clipboard = _FakeClipboard.nativeFutures([gate.future]);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          attachmentClipboard: clipboard,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.tap(input);
      final baseline = WebHandoffParticipants.instance.participantCount;

      await pressPaste(tester);
      await tester.pump(
        sessionAttachmentIntakeTimeout + const Duration(seconds: 1),
      );
      // The attachment lease is gone, but the chord was consumed.
      expect(WebHandoffParticipants.instance.participantCount, baseline);

      gate.complete(const SessionAttachmentClipboardText('late text'));
      await tester.pumpAndSettle();

      expect(tester.widget<TextField>(input).controller?.text, 'late text');
    });

    testWidgets('the drop delivery bound travels into the platform', (
      tester,
    ) async {
      const channel = MethodChannel('desktop_drop');
      final calls = <MethodCall>[];
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
            ..setMockMethodCallHandler(channel, (call) async {
              calls.add(call);
              return null;
            });
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));

      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          attachmentClipboard: _FakeClipboard.native(const []),
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();

      final limits = calls
          .where((call) => call.method == 'setFileLimit')
          .map((call) => (call.arguments as Map)['limit'])
          .toList();
      // Without this the platform enumerates, stats, and marshals every path a
      // folder-sized drop carries before A1 gets to refuse it.
      expect(limits, isNotEmpty, reason: 'drop delivery must be bounded');
      expect(limits.first, sessionAttachmentMaxSnapshotFiles + 1);
    });

    testWidgets('each gesture expires on its own deadline, not the batch', (
      tester,
    ) async {
      final first = Completer<SessionAttachmentClipboardRead>();
      final second = Completer<SessionAttachmentClipboardRead>();
      final clipboard = _FakeClipboard.nativeFutures([
        first.future,
        second.future,
      ]);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          attachmentClipboard: clipboard,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('session-detail-prompt-input')));
      final baseline = WebHandoffParticipants.instance.participantCount;

      await pressPaste(tester);
      expect(clipboard.nativeReadCount, 1);
      // Second gesture starts one second before the first one's deadline.
      await tester.pump(
        sessionAttachmentIntakeTimeout - const Duration(seconds: 1),
      );
      await pressPaste(tester);
      expect(WebHandoffParticipants.instance.participantCount, baseline + 2);

      await tester.pump(const Duration(seconds: 2));
      await tester.pump();

      // Only the stalled first gesture expired; the second keeps its full
      // timeout and gets to run instead of inheriting one second.
      expect(WebHandoffParticipants.instance.participantCount, baseline + 1);
      expect(clipboard.nativeReadCount, 2);

      await tester.pump(sessionAttachmentIntakeTimeout);
      expect(WebHandoffParticipants.instance.participantCount, baseline);
    });

    testWidgets('rapid distinct web paste events are serialized and deduped', (
      tester,
    ) async {
      final clipboard = _FakeClipboard.web();
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          attachmentClipboard: clipboard,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('session-detail-prompt-input')));
      final first = _FakeWebPasteEvent.files([_memoryItem('first.png', 1)]);
      final second = _FakeWebPasteEvent.files([_memoryItem('second.png', 2)]);

      clipboard
        ..emit(first)
        ..emit(second)
        ..emit(second);
      await tester.pumpAndSettle();

      expect(first.claimCount, 1);
      expect(second.claimCount, 1);
      expect(find.text('first.png'), findsOneWidget);
      expect(find.text('second.png'), findsOneWidget);
    });

    testWidgets('rapid web paste ownership rejects overflow explicitly', (
      tester,
    ) async {
      final clipboard = _FakeClipboard.web();
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          attachmentClipboard: clipboard,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('session-detail-prompt-input')));
      final events = List.generate(
        9,
        (index) => _FakeWebPasteEvent.files([
          _memoryItem('web-$index.png', index),
        ]),
      );

      for (final event in events) {
        clipboard.emit(event);
      }
      await tester.pumpAndSettle();

      expect(events.take(8).map((event) => event.claimCount), everyElement(1));
      expect(events.last.claimCount, 0);
      expect(events.last.rejectCount, 1);
    });

    testWidgets('drop affordance is semantic in light/dark Compact/Roomy', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      final spec = themeSpecById(kDefaultThemeId);
      for (final variant in [
        (
          size: const Size(360, 760),
          brightness: Brightness.light,
          density: UiDensity.compact,
        ),
        (
          size: const Size(1200, 800),
          brightness: Brightness.dark,
          density: UiDensity.spacious,
        ),
      ]) {
        tester.view
          ..physicalSize = variant.size
          ..devicePixelRatio = 1;
        final tokens = variant.brightness == Brightness.dark
            ? spec.dark
            : spec.light;
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            theme: buildAppTheme(
              tokens,
              variant.brightness,
              density: variant.density.visualDensity,
            ).copyWith(platform: TargetPlatform.linux),
          ),
        );
        await tester.pumpAndSettle();
        final target = tester.widget<DropTarget>(
          find.byKey(const Key('session-detail-attachment-drop-region')),
        );
        target.onDragEntered?.call(_dropEventDetails);
        await tester.pump();

        final overlay = find.byKey(
          const Key('session-detail-attachment-drop-overlay'),
        );
        expect(overlay, findsOneWidget);
        expect(tester.getSemantics(overlay).label, contains('Drop files'));
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
      }
      tester.view
        ..resetPhysicalSize()
        ..resetDevicePixelRatio();
      semantics.dispose();
    });

    testWidgets('web-shaped intake does not install desktop_drop ownership', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          attachmentClipboard: _FakeClipboard.web(),
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();

      expect(find.byType(DropTarget), findsNothing);
      expect(
        find.byKey(const Key('session-detail-attachment-drop-region')),
        findsOneWidget,
      );
    });

    testWidgets('web directory is rejected before file enumeration', (
      tester,
    ) async {
      final clipboard = _FakeClipboard.web();
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          attachmentClipboard: clipboard,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      final region = find.byKey(
        const Key('session-detail-attachment-drop-region'),
      );
      final center = tester.getCenter(region);
      final event = _FakeWebDropEvent.directory(center);

      clipboard.emitDrop(event);
      await tester.pump();

      expect(event.rejectCount, 1);
      expect(event.claimCount, 0);
      expect(find.byType(ActionChip), findsNothing);
    });

    testWidgets('browser drag leaving the composer retires the overlay', (
      tester,
    ) async {
      final clipboard = _FakeClipboard.web();
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          attachmentClipboard: clipboard,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      final overlay = find.byKey(
        const Key('session-detail-attachment-drop-overlay'),
      );
      final center = tester.getCenter(
        find.byKey(const Key('session-detail-attachment-drop-region')),
      );

      clipboard.emitDrop(
        _FakeWebDropEvent(
          position: center,
          phase: SessionAttachmentWebDragPhase.enter,
        ),
      );
      await tester.pump();
      expect(overlay, findsOneWidget);

      // Browsers report the leave outside the composer, and protected-mode
      // transfers stop advertising files once the drag ends.
      clipboard.emitDrop(
        _FakeWebDropEvent(
          position: const Offset(-1000, -1000),
          phase: SessionAttachmentWebDragPhase.leave,
          hasFiles: false,
        ),
      );
      await tester.pump();

      expect(overlay, findsNothing);
    });

    testWidgets('browser drop outside the composer retires the overlay', (
      tester,
    ) async {
      final clipboard = _FakeClipboard.web();
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          attachmentClipboard: clipboard,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      final overlay = find.byKey(
        const Key('session-detail-attachment-drop-overlay'),
      );
      final center = tester.getCenter(
        find.byKey(const Key('session-detail-attachment-drop-region')),
      );

      clipboard.emitDrop(
        _FakeWebDropEvent(
          position: center,
          phase: SessionAttachmentWebDragPhase.enter,
        ),
      );
      await tester.pump();
      expect(overlay, findsOneWidget);

      final elsewhere = _FakeWebDropEvent(
        position: const Offset(-1000, -1000),
        phase: SessionAttachmentWebDragPhase.drop,
        items: [_memoryItem('stray.png', 1)],
      );
      clipboard.emitDrop(elsewhere);
      await tester.pumpAndSettle();

      expect(overlay, findsNothing);
      expect(elsewhere.claimCount, 0);
      expect(elsewhere.rejectCount, 0);
      expect(find.text('stray.png'), findsNothing);
    });

    testWidgets('web drop dedup memory stays bounded past its capacity', (
      tester,
    ) async {
      final clipboard = _FakeClipboard.web();
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          attachmentClipboard: clipboard,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      final center = tester.getCenter(
        find.byKey(const Key('session-detail-attachment-drop-region')),
      );
      final drops = List.generate(
        sessionAttachmentEventMemoryCapacity + 8,
        (index) => _FakeWebDropEvent(
          position: center,
          phase: SessionAttachmentWebDragPhase.drop,
          items: [_memoryItem('drop-$index.png', index)],
        ),
      );

      for (final drop in drops) {
        clipboard.emitDrop(drop);
        await tester.pumpAndSettle();
      }
      expect(drops.map((drop) => drop.claimCount), everyElement(1));

      // The newest identity is still remembered, so replay stays deduped.
      clipboard.emitDrop(drops.last);
      await tester.pumpAndSettle();
      expect(drops.last.claimCount, 1);

      // The oldest was evicted instead of being retained for the tab's life.
      clipboard.emitDrop(drops.first);
      await tester.pumpAndSettle();
      expect(drops.first.claimCount, 2);
      expect(tester.takeException(), isNull);
    });

    testWidgets(
      'drop is ordered, deduped, focus-preserving, and does not send',
      (
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
        final inputWidget = tester.widget<TextField>(input);
        final target = tester.widget<DropTarget>(
          find.byKey(const Key('session-detail-attachment-drop-region')),
        );
        target.onDragEntered?.call(_dropEventDetails);
        target.onDragEntered?.call(_dropEventDetails);
        await tester.pump();
        expect(
          find.byKey(const Key('session-detail-attachment-drop-overlay')),
          findsOneWidget,
        );
        target.onDragExited?.call(_dropEventDetails);
        await tester.pump();
        expect(
          find.byKey(const Key('session-detail-attachment-drop-overlay')),
          findsOneWidget,
        );
        target.onDragExited?.call(_dropEventDetails);
        await tester.pump();
        expect(
          find.byKey(const Key('session-detail-attachment-drop-overlay')),
          findsNothing,
        );

        final details = _dropDetails([
          _dropFile('first.png', [1, 2]),
          _dropFile('second.png', [3]),
        ]);
        target.onDragDone?.call(details);
        await tester.pumpAndSettle();
        target.onDragDone?.call(details);
        await tester.pumpAndSettle();

        expect(find.text('first.png'), findsOneWidget);
        expect(find.text('second.png'), findsOneWidget);
        expect(inputWidget.focusNode?.hasFocus, isTrue);
        expect(connection.sendPromptCount, 0);
        expect(connection.sendFileCount, 0);
      },
    );

    testWidgets('directory drop is rejected without changing draft or chips', (
      tester,
    ) async {
      final picker = FakeSessionAttachmentPicker();
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          attachmentPicker: picker,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('session-detail-attach-button')));
      final input = find.byKey(const Key('session-detail-prompt-input'));
      await tester.enterText(input, 'keep this draft');
      final target = tester.widget<DropTarget>(
        find.byKey(const Key('session-detail-attachment-drop-region')),
      );
      target.onDragDone?.call(
        _dropDetails([
          DropItemDirectory.fromData(
            Uint8List(0),
            const [],
            name: 'folder',
            path: '/folder',
          ),
        ]),
      );
      await tester.pumpAndSettle();

      expect(find.text('notes.txt'), findsOneWidget);
      expect(
        tester.widget<TextField>(input).controller?.text,
        'keep this draft',
      );
      expect(find.textContaining("Couldn't add those files"), findsOneWidget);
    });

    testWidgets('an oversized drop is refused before any file is stat-ed', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      final measured = <String>[];
      final target = tester.widget<DropTarget>(
        find.byKey(const Key('session-detail-attachment-drop-region')),
      );

      target.onDragDone?.call(
        _dropDetails(
          List.generate(
            sessionAttachmentMaxSnapshotFiles + 1,
            (index) => _CountingDropItem('/drop/bulk-$index.png', measured),
          ),
        ),
      );
      await tester.pumpAndSettle();

      // A1 needs one item past the limit to prove overflow; the rest must not
      // cost a filesystem round trip each.
      expect(measured, isEmpty);
      expect(find.textContaining("Couldn't add those files"), findsOneWidget);
      expect(find.byType(ActionChip), findsNothing);
    });

    testWidgets('a promised drop is rejected without adopting its bytes', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          theme: platformTheme(TargetPlatform.macOS),
        ),
      );
      await tester.pumpAndSettle();
      final measured = <String>[];
      final target = tester.widget<DropTarget>(
        find.byKey(const Key('session-detail-attachment-drop-region')),
      );

      target.onDragDone?.call(
        _dropDetails([
          _CountingDropItem(
            '/tmp/Drops/20260803/promised.png',
            measured,
            name: 'promised.png',
            fromPromise: true,
          ),
        ]),
      );
      await tester.pumpAndSettle();

      // A virtual payload the platform would materialize into app-owned
      // temporary storage: refused before it is read, never staged.
      expect(measured, isEmpty);
      expect(find.text('promised.png'), findsNothing);
      expect(find.byType(ActionChip), findsNothing);
      expect(find.textContaining("Couldn't add those files"), findsOneWidget);
    });

    testWidgets('URL drop is rejected without creating an attachment', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      final target = tester.widget<DropTarget>(
        find.byKey(const Key('session-detail-attachment-drop-region')),
      );
      target.onDragDone?.call(
        _dropDetails([
          DropItemFile.fromData(
            Uint8List.fromList([1]),
            name: 'remote.png',
            path: 'https://example.test/remote.png',
            mimeType: 'image/png',
          ),
        ]),
      );
      await tester.pumpAndSettle();

      expect(find.text('remote.png'), findsNothing);
      expect(find.textContaining("Couldn't add those files"), findsOneWidget);
    });

    testWidgets('Windows drive and UNC file paths are admitted', (
      tester,
    ) async {
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          theme: platformTheme(TargetPlatform.windows),
        ),
      );
      await tester.pumpAndSettle();
      final target = tester.widget<DropTarget>(
        find.byKey(const Key('session-detail-attachment-drop-region')),
      );
      target.onDragDone?.call(
        _dropDetails([
          DropItemFile.fromData(
            Uint8List.fromList([1]),
            name: 'drive.png',
            path: r'C:\project\drive.png',
            mimeType: 'image/png',
          ),
          DropItemFile.fromData(
            Uint8List.fromList([2]),
            name: 'unc.png',
            path: r'\\server\share\unc.png',
            mimeType: 'image/png',
          ),
        ]),
      );
      await tester.pumpAndSettle();

      expect(find.text('drive.png'), findsOneWidget);
      expect(find.text('unc.png'), findsOneWidget);
    });

    testWidgets(
      'acquisition holds N3b before first await and dispose releases',
      (
        tester,
      ) async {
        final gate = Completer<SessionAttachmentClipboardRead>();
        final clipboard = _FakeClipboard.nativeFutures([gate.future]);
        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [],
            attachmentClipboard: clipboard,
            theme: platformTheme(TargetPlatform.linux),
          ),
        );
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('session-detail-prompt-input')));
        final baseline = WebHandoffParticipants.instance.participantCount;

        await pressPaste(tester);
        expect(WebHandoffParticipants.instance.participantCount, baseline + 1);
        expect(await WebHandoffParticipants.instance.prepare(), isFalse);
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pump();
        expect(WebHandoffParticipants.instance.participantCount, 0);
        gate.complete(
          SessionAttachmentClipboardFiles([_memoryItem('late.png', 1)]),
        );
        await tester.pump();
      },
    );

    testWidgets('source replacement cancels acquisition before admission', (
      tester,
    ) async {
      final gate = Completer<SessionAttachmentClipboardRead>();
      final clipboard = _FakeClipboard.nativeFutures([gate.future]);
      final profileB = BrokerProfile(
        id: 'remote',
        displayName: 'remote',
        baseUri: Uri.parse('http://127.0.0.1:8834'),
        createdAt: DateTime(2026, 6, 28),
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          attachmentClipboard: clipboard,
          theme: platformTheme(TargetPlatform.linux),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('session-detail-prompt-input')));
      await pressPaste(tester);
      final container = ProviderScope.containerOf(
        tester.element(find.byType(SessionDetailPage)),
        listen: false,
      );
      container.read(activeBrokerProfileProvider.notifier).state = profileB;
      await tester.pump();
      gate.complete(
        SessionAttachmentClipboardFiles([_memoryItem('old.png', 1)]),
      );
      await tester.pumpAndSettle();
      expect(find.text('old.png'), findsNothing);
    });
  });
}

final _dropEventDetails = DropEventDetails(
  localPosition: Offset.zero,
  globalPosition: Offset.zero,
);

DropDoneDetails _dropDetails(List<DropItem> files) => DropDoneDetails(
  files: files,
  localPosition: Offset.zero,
  globalPosition: Offset.zero,
);

DropItemFile _dropFile(String name, List<int> bytes) => DropItemFile.fromData(
  Uint8List.fromList(bytes),
  name: name,
  path: '/drop/$name',
  mimeType: 'image/png',
);

/// A dropped file that records every filesystem measurement it is asked for.
final class _CountingDropItem extends DropItemFile {
  _CountingDropItem(
    super.path,
    this.measured, {
    super.name = 'bulk.png',
    super.fromPromise,
  }) : super(mimeType: 'image/png');

  final List<String> measured;

  @override
  Future<int> length() async {
    measured.add(name);
    return 1;
  }

  @override
  Stream<Uint8List> openRead([int? start, int? end]) =>
      Stream.value(Uint8List.fromList([1]));
}

/// A pre-failed clipboard read whose error is already claimed.
///
/// Without `Future.ignore` the zone reports the rejection as an uncaught async
/// error before the drain queue ever awaits it.
Future<SessionAttachmentClipboardRead> _failedRead(Object error) =>
    Future<SessionAttachmentClipboardRead>.error(error)..ignore();

SessionAttachmentIntakeItem _memoryItem(String name, int value) =>
    MemorySessionAttachmentIntakeItem(
      bytes: Uint8List.fromList([value]),
      name: name,
    );

final class _FakeClipboard implements SessionAttachmentClipboard {
  _FakeClipboard.native(List<SessionAttachmentClipboardRead> reads)
    : this.nativeFutures(reads.map(Future.value).toList(growable: false));

  _FakeClipboard.nativeFutures(this._nativeReads) : usesWebPasteEvents = false;

  _FakeClipboard.web() : _nativeReads = const [], usesWebPasteEvents = true;

  final List<Future<SessionAttachmentClipboardRead>> _nativeReads;
  final Set<SessionAttachmentWebPasteListener> _listeners = {};
  final Set<SessionAttachmentWebDropListener> _dropListeners = {};
  int nativeReadCount = 0;
  int nativeTextReadCount = 0;

  /// Plain-text recovery answers, consumed in order by [readNativeText].
  List<Future<String?>> nativeTextReads = const [];

  /// Records `isActive` at each [readNative] call so cancellation is provable.
  final List<bool Function()?> activeProbes = [];

  @override
  final bool usesWebPasteEvents;

  @override
  bool get usesWebDropEvents => usesWebPasteEvents;

  @override
  void addWebPasteListener(SessionAttachmentWebPasteListener listener) {
    _listeners.add(listener);
  }

  @override
  void removeWebPasteListener(SessionAttachmentWebPasteListener listener) {
    _listeners.remove(listener);
  }

  @override
  void addWebDropListener(SessionAttachmentWebDropListener listener) {
    _dropListeners.add(listener);
  }

  @override
  void removeWebDropListener(SessionAttachmentWebDropListener listener) {
    _dropListeners.remove(listener);
  }

  void emit(SessionAttachmentWebPasteEvent event) {
    for (final listener in _listeners.toList(growable: false)) {
      listener(event);
    }
  }

  void emitDrop(SessionAttachmentWebDropEvent event) {
    for (final listener in _dropListeners.toList(growable: false)) {
      listener(event);
    }
  }

  @override
  Future<SessionAttachmentClipboardRead> readNative({
    bool Function()? isActive,
  }) {
    activeProbes.add(isActive);
    final index = nativeReadCount++;
    return _nativeReads[index];
  }

  @override
  Future<String?> readNativeText() {
    final index = nativeTextReadCount++;
    if (index >= nativeTextReads.length) return Future.value();
    return nativeTextReads[index];
  }
}

final class _FakeWebDropEvent implements SessionAttachmentWebDropEvent {
  _FakeWebDropEvent({
    required Offset position,
    required this.phase,
    this.items = const [],
    this.hasFiles = true,
    this.hasDirectory = false,
  }) : clientX = position.dx,
       clientY = position.dy;

  _FakeWebDropEvent.directory(Offset position)
    : this(
        position: position,
        phase: SessionAttachmentWebDragPhase.drop,
        hasDirectory: true,
      );

  final List<SessionAttachmentIntakeItem> items;
  int claimCount = 0;
  int rejectCount = 0;
  int acceptCount = 0;

  @override
  final double clientX;

  @override
  final double clientY;

  @override
  final bool hasDirectory;

  @override
  final bool hasFiles;

  @override
  Object get identity => this;

  @override
  final SessionAttachmentWebDragPhase phase;

  @override
  void acceptOperation() => acceptCount += 1;

  @override
  List<SessionAttachmentIntakeItem> claimFiles() {
    claimCount += 1;
    return items;
  }

  @override
  void reject() => rejectCount += 1;
}

final class _FakeWebPasteEvent implements SessionAttachmentWebPasteEvent {
  _FakeWebPasteEvent.text() : items = const [];

  _FakeWebPasteEvent.files(this.items);

  final List<SessionAttachmentIntakeItem> items;
  int claimCount = 0;
  int rejectCount = 0;

  @override
  bool get hasFiles => items.isNotEmpty;

  @override
  Object get identity => this;

  @override
  List<SessionAttachmentIntakeItem> claimFiles() {
    claimCount += 1;
    return items;
  }

  @override
  void rejectFiles() => rejectCount += 1;
}
