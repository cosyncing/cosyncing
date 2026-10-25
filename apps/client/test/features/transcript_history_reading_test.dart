// F03b: what a reader of a long session is told and keeps. A history the
// broker refused never reads as an empty or complete session; a long live
// stream while the reader is far back neither moves them nor grows the window
// past its budget; a text selection survives older pages and streamed rows.
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter/gestures.dart' show PointerDeviceKind;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/cosyncing_app.dart';
import '../support/feature/history_frames.dart';
import '../support/feature/session_driver.dart';
import '../support/feature/transcript_reader.dart';
import '../support/feature/transcript_wire.dart';

const _resourceLimitGap = {
  'code': 'HISTORY_PAGE_RESOURCE_LIMIT',
  'reason': 'resource-limit',
  'message':
      'This native history exceeds the bounded paging index; the newest '
      'messages are shown and earlier ones cannot be loaded.',
};

List<Map<String, Object?>> messages(int count) => [
  for (var i = 1; i <= count; i++) userRow('Message $i', key: 'u$i'),
];

void main() {
  group('prompt scroll shortcuts', () {
    for (final hasPrompt in [true, false]) {
      final outcome = hasPrompt
          ? 'lands on the first prompt'
          : 'proves no earlier prompt exists';
      featureTest(
        'a full retained window releases its source boundary and $outcome',
        (f) async {
          final (app, broker) = await openPaging(
            f,
            total: 600,
            row: (index) => index == 0 && hasPrompt
                ? userRow('Row 0. First prompt', key: 'u0')
                : answerRow('Row $index. Continued output.', key: 'm$index'),
          );
          await app.readBack(broker, 4);
          await app.jumpToEnd();
          const key = SessionDetailKey(tool: 'codex', sessionId: 's1');
          final provider = sessionDetailControllerProvider(key);
          final before = app.container.read(provider).transcriptWindow;
          expect(before.messageCount, 500);
          expect(before.olderHistoryCursor, 'b100');
          final reader = app.reading;
          await app.tapKey('session-history-previous-prompt');
          await app.pumpUntil(
            () => find
                .byKey(const Key('session-history-previous-prompt'))
                .evaluate()
                .isEmpty,
            reason:
                'the first prompt or a proven start ends backward navigation',
          );
          expect(broker.older.length, 5);
          if (hasPrompt) {
            expect(app.reading.index, 0);
          } else {
            app.expectHeld(reader, when: 'the scan proves there is no prompt');
            await app.wheel(-24);
            await app.wheel(24);
            await app.jumpToEnd();
            expect(
              find.byKey(const Key('session-history-previous-prompt')),
              findsNothing,
              reason: 'scrolling and Down do not forget the proven boundary',
            );
          }
          expect(
            find.text('Could not load the previous user message.'),
            findsNothing,
          );
        },
      );
    }

    featureTest('touch jitter cancels once and restores following', (f) async {
      final (app, broker) = await openPaging(
        f,
        total: 900,
        viewport: FeatureViewport.phone,
        row: (index) =>
            answerRow('Row $index. ${markedProse(index, 6)}', key: 'm$index'),
      );
      broker.holding = true;
      final up = find.byKey(const Key('session-history-previous-prompt'));
      final down = find.byKey(const Key('session-history-jump-latest'));
      await app.tap(up);
      expect(broker.hasHeld, isTrue);
      final cancel = await f.tester.startGesture(f.tester.getCenter(up));
      await cancel.moveBy(const Offset(2, 3));
      await f.tester.pump();
      expect(f.tester.widget<IconButton>(up).icon, isA<SizedBox>());
      await cancel.up();
      await app.settle();
      expect(down, findsNothing, reason: 'Cancel restores following at bottom');
      expect(
        broker.older,
        hasLength(1),
        reason: 'the release does not tap a rebuilt Up',
      );
      broker.append(answerRow('Row 900. Follow after cancel', key: 'm900'));
      await app.settle();
      expect(app.topOf(900), isNotNull);
      broker.release();
      await app.settle();
      await app.tap(up);
      final tap = await f.tester.startGesture(
        f.tester.getCenter(transcriptList),
      );
      await tap.moveBy(const Offset(2, 3));
      await tap.up();
      await f.tester.pump();
      app.position.jumpTo(app.position.pixels - 24);
      await f.tester.pump();
      expect(
        f.tester.widget<IconButton>(up).icon,
        isA<SizedBox>(),
        reason:
            'jitter cannot turn a later programmatic update '
            'into user scrolling',
      );
      await f.tester.drag(transcriptList, const Offset(0, 100));
      await app.settle();
      expect(
        f.tester.widget<IconButton>(up).icon,
        isA<Icon>(),
        reason: 'an actual transcript drag cancels the scan',
      );
      final reader = app.reading;
      broker.release();
      await app.settle();
      app.expectHeld(reader, when: 'the drag-canceled reply arrives');
    });

    for (final failure in [
      'NOT_SUPPORTED',
      'HISTORY_CURSOR_GONE',
      'no-progress',
    ]) {
      featureTest('a permanent prompt-search failure has no Retry: $failure', (
        f,
      ) async {
        final (app, broker) = await openPaging(
          f,
          total: 200,
          row: (index) => answerRow('Row $index. Output', key: 'm$index'),
        );
        if (failure == 'no-progress') {
          broker.stallNext = 1;
        } else {
          broker
            ..failNext = 1
            ..failureCode = failure;
        }
        await app.tapKey('session-history-previous-prompt');
        expect(
          find.text('Could not load the previous user message.'),
          findsOneWidget,
        );
        expect(find.widgetWithText(SnackBarAction, 'Retry'), findsNothing);
        final up = find.byKey(const Key('session-history-previous-prompt'));
        expect(f.tester.widget<IconButton>(up).onPressed, isNull);
        await f.tester.tap(up);
        await app.settle();
        expect(broker.older, hasLength(1));
      });
    }

    featureTest('report view lands on loaded and unloaded user rows', (
      f,
    ) async {
      final (app, broker) = await openPaging(
        f,
        total: 900,
        row: (index) => index == 899
            ? answerRow('Row 899. ${markedProse(899, 30)}', key: 'm899')
            : index == 650
            ? userRow('Row 650. Queued prompt', key: 'u650', queued: true)
            : commandHeavyRow(index, turn: 400, output: 32),
      );
      await app.hideToolCalls();
      await app.tapKey('session-history-previous-prompt');
      expect(app.reading.index, 800);
      await app.tapKey('session-history-previous-prompt');
      expect(app.reading.index, 650);
      await app.tapKey('session-history-previous-prompt');
      expect(app.reading.index, 400);
      await app.tapKey('session-history-previous-prompt');
      expect(app.reading.index, 0);
      expect(
        find.byKey(const Key('session-history-previous-prompt')),
        findsNothing,
      );
      await app.tapKey('session-history-jump-latest');
      broker.append(answerRow('Row 900. Follow in report view', key: 'm900'));
      await app.settle();
      expect(app.topOf(900), isNotNull);
    });

    featureTest('End cancels a held scan at an unchanged bottom', (f) async {
      final (app, broker) = await openPaging(
        f,
        total: 900,
        row: (index) => index == 0
            ? userRow('Row 0. Earlier prompt', key: 'u0')
            : answerRow('Row $index. ${markedProse(index, 6)}', key: 'm$index'),
      );
      broker.holding = true;
      await app.tapKey('session-history-previous-prompt');
      expect(broker.hasHeld, isTrue);
      final bottom = app.reading;
      await app.pageKey(LogicalKeyboardKey.end);
      expect(
        find.byKey(const Key('session-history-jump-latest')),
        findsNothing,
        reason: 'End resumes following even when its offset does not change',
      );
      final up = find.byKey(const Key('session-history-previous-prompt'));
      expect(
        f.tester.widget<IconButton>(up).icon,
        isA<Icon>(),
        reason: 'the old navigation intent is canceled',
      );
      broker
        ..holding = false
        ..release();
      await app.settle();
      app.expectHeld(bottom, when: 'the End-canceled reply arrives');
      broker.append(answerRow('Row 900. Follow after End', key: 'm900'));
      await app.settle();
      expect(app.topOf(900), isNotNull);
    });

    featureTest('a Cancel press keeps its action when the scan settles', (
      f,
    ) async {
      final (app, broker) = await openPaging(
        f,
        total: 900,
        viewport: FeatureViewport.phone,
        row: (index) =>
            answerRow('Row $index. ${markedProse(index, 6)}', key: 'm$index'),
      );
      broker.holding = true;
      final up = find.byKey(const Key('session-history-previous-prompt'));
      await app.tap(up);
      final press = await f.tester.startGesture(f.tester.getCenter(up));
      broker
        ..failNext = 1
        ..holding = false
        ..release();
      for (
        var frame = 0;
        frame < 20 && f.tester.widget<IconButton>(up).icon is SizedBox;
        frame++
      ) {
        await f.tester.pump(const Duration(milliseconds: 16));
      }
      expect(f.tester.widget<IconButton>(up).icon, isA<Icon>());
      expect(
        find.text('Could not load the previous user message.'),
        findsOneWidget,
      );
      final settledRequests = broker.requests.length;
      expect(settledRequests, 2);
      await press.up();
      await app.settle();
      expect(
        broker.requests,
        hasLength(settledRequests),
        reason: 'releasing the former Cancel cannot activate the rebuilt Up',
      );
      expect(
        find.byKey(const Key('session-history-jump-latest')),
        findsNothing,
      );
      final focus = Focus.of(
        f.tester.element(
          find.descendant(of: up, matching: find.byIcon(Icons.arrow_upward)),
        ),
      )..requestFocus();
      await f.tester.pump();
      broker.holding = true;
      await f.tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await app.frames(2);
      expect(
        focus.hasFocus,
        isTrue,
        reason: 'Up-to-Cancel retains keyboard focus',
      );
      expect(f.tester.widget<IconButton>(up).icon, isA<SizedBox>());
      await f.tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await app.settle();
      expect(focus.hasFocus, isTrue);
      expect(f.tester.widget<IconButton>(up).icon, isA<Icon>());
      expect(broker.requests, hasLength(settledRequests + 1));
      broker
        ..holding = false
        ..release();
      await app.settle();
    });

    featureTest('a complete short conversation has no scroll shortcuts', (
      f,
    ) async {
      await openTranscript(f, [
        userRow('A short prompt', key: 'u1'),
        answerRow('A short answer', key: 'm1'),
      ]);
      expect(
        find.byKey(const Key('session-history-previous-prompt')),
        findsNothing,
      );
      expect(
        find.byKey(const Key('session-history-jump-latest')),
        findsNothing,
      );
    });

    featureTest('up steps through user rows and down resumes streaming', (
      f,
    ) async {
      final (app, broker) = await openPaging(
        f,
        total: 100,
        row: (index) => index == 99
            ? answerRow('Row 99. ${markedProse(99, 30)}', key: 'm99')
            : commandHeavyRow(index, turn: 20, output: 32),
      );
      final input = find.byKey(const Key('session-detail-prompt-input'));
      await app.enterText(input, 'Keep this draft');
      final field = f.tester.widget<TextField>(input);
      expect(field.focusNode!.hasFocus, isTrue);
      expect(
        find.byKey(const Key('session-history-jump-latest')),
        findsNothing,
      );
      await app.captureReview('scroll-shortcuts-desktop-light-bottom');
      await app.tapKey('session-history-previous-prompt');
      expect(app.reading.index, 80);
      expect(field.focusNode!.hasFocus, isTrue);
      await app.captureReview('scroll-shortcuts-desktop-light-reading');
      // Rapid taps use the pending destination even before layout has run.
      final up = find.byKey(const Key('session-history-previous-prompt'));
      await f.tester.tap(up);
      await f.tester.tap(up);
      await app.settle();
      expect(app.reading.index, 40);
      final before = app.reading;
      broker.append(answerRow('Row 100. A new answer', key: 'm100'));
      await app.settle();
      app.expectHeld(
        before,
        when: 'a live answer arrives after prompt navigation',
      );
      await app.tapKey('session-history-jump-latest');
      expect(field.focusNode!.hasFocus, isTrue);
      expect(field.controller!.text, 'Keep this draft');
      expect(
        find.byKey(const Key('session-history-jump-latest')),
        findsNothing,
      );
      broker.append(answerRow('Row 101. Followed answer', key: 'm101'));
      await app.settle();
      expect(app.topOf(101), isNotNull);
      await app.tapKey('session-history-previous-prompt');
      final down = find.byKey(const Key('session-history-jump-latest'));
      final downIcon = find.descendant(
        of: down,
        matching: find.byIcon(Icons.arrow_downward),
      );
      final downFocus = Focus.of(f.tester.element(downIcon))..requestFocus();
      await f.tester.pump();
      expect(downFocus.hasFocus, isTrue);
      await f.tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await app.settle();
      expect(down, findsNothing);
      expect(FocusManager.instance.primaryFocus, isNot(same(downFocus)));
      await f.tester.sendKeyEvent(LogicalKeyboardKey.tab);
      expect(FocusManager.instance.primaryFocus, isNot(same(downFocus)));
    });

    featureTest(
      'a second reader crosses a turn longer than the retained window',
      (f) async {
        final (app, broker) = await openPaging(
          f,
          total: 900,
          row: (index) => index == 899
              ? answerRow('Row 899. ${markedProse(899, 30)}', key: 'm899')
              : commandHeavyRow(index, turn: 800),
        );
        await app.tapKey('session-history-previous-prompt');
        expect(app.reading.index, 800);
        final before = app.reading;
        // Fill the tail while the original prompt remains the protected
        // reader, then search past hundreds more rows outside this window.
        for (var index = 900; index < 1300; index++) {
          broker.append(commandHeavyRow(index, turn: 800));
          if (index % 50 == 49) await app.frames(2);
        }
        await app.settle();
        app.expectHeld(before, when: '400 newer rows fill the retained tail');
        await app.tapKey('session-history-previous-prompt');
        await app.pumpUntil(
          () => app.topOf(0) != null,
          reason: 'the prompt before 800 canonical rows becomes the reader',
        );
        expect(app.reading.index, 0);
        expect(broker.older.length, 17);
        const key = SessionDetailKey(tool: 'codex', sessionId: 's1');
        final window = app.container
            .read(sessionDetailControllerProvider(key))
            .transcriptWindow;
        expect(
          window.messageCount,
          lessThanOrEqualTo(kMaxActiveTranscriptMessages),
        );
        expect(
          window.estimatedBytes,
          lessThanOrEqualTo(kMaxActiveTranscriptDecodedBytes),
        );
        await app.tapKey('session-history-jump-latest');
        expect(app.position.extentAfter, lessThanOrEqualTo(32));
      },
    );

    featureTest(
      'a held scan preserves the view and a canceled reply cannot land',
      (f) async {
        final (app, broker) = await openPaging(
          f,
          total: 900,
          row: (index) => index == 899
              ? answerRow('Row 899. ${markedProse(899, 30)}', key: 'm899')
              : commandHeavyRow(index, turn: 800, output: 32),
        );
        await app.tapKey('session-history-previous-prompt');
        final before = app.reading;
        broker.holding = true;
        await app.tapKey('session-history-previous-prompt');
        expect(broker.hasHeld, isTrue);
        app.expectHeld(before, when: 'a navigation page is held');
        expect(
          find.byKey(const Key('session-transcript-tail-reveal-gate')),
          findsOneWidget,
        );
        await app.tapKey('session-history-jump-latest');
        final bottom = app.reading;
        broker
          ..holding = false
          ..release();
        await app.settle();
        app.expectHeld(bottom, when: 'the canceled page eventually arrives');
        expect(broker.older, hasLength(1));
        broker
          ..failNext = 1
          ..failureCode = 'NOT_SUPPORTED';
        await app.tapKey('session-history-previous-prompt');
        await app.tapKey('session-history-previous-prompt');
        final up = find.byKey(const Key('session-history-previous-prompt'));
        expect(f.tester.widget<IconButton>(up).onPressed, isNull);
        expect(
          find.byTooltip('Earlier user messages cannot be loaded'),
          findsOneWidget,
        );
      },
    );

    featureTest(
      'a landing near the bottom keeps reading mode during streaming',
      (f) async {
        final (app, broker) = await openPaging(
          f,
          total: 5,
          row: (index) => index == 2
              ? userRow('Row 2. Near-bottom prompt', key: 'u2')
              : answerRow(
                  'Row $index. ${markedProse(index, 3)}',
                  key: 'm$index',
                ),
        );
        final viewport = f.tester.getRect(transcriptList);
        final textTop = app.topOf(2)!;
        final size = f.tester.view.physicalSize;
        f.tester.view.physicalSize = Size(
          size.width,
          size.height + viewport.top + 4 - textTop,
        );
        await app.settle();
        await app.tapKey('session-history-previous-prompt');
        expect(app.position.extentAfter, lessThanOrEqualTo(32));
        final before = app.reading;
        broker.append(answerRow('Row 5. Streamed while reading', key: 'm5'));
        await app.settle();
        app.expectHeld(
          before,
          when: 'streaming after a landing within the bottom threshold',
        );
        expect(
          find.byKey(const Key('session-history-jump-latest')),
          findsOneWidget,
        );
        await app.tapKey('session-history-jump-latest');
        expect(app.position.extentAfter, lessThanOrEqualTo(0.5));
      },
    );

    featureTest(
      'phone dark controls navigate queued user rows and preserve the editor',
      (f) async {
        await f.storage.preferences.setThemeMode('dark');
        final (app, _) = await openPaging(
          f,
          total: 100,
          viewport: FeatureViewport.phone,
          row: (index) {
            if (index == 99) {
              return answerRow('Row 99. ${markedProse(99, 30)}', key: 'm99');
            }
            if (index == 40) return userRow('', key: 'u40');
            if (index == 41 || index == 61) {
              return row('file-artifact', {
                'artifactKey': 'attachment-$index',
                'userMessageKey': index == 41 ? 'u40' : 'unloaded-user',
                'name': index == 41 ? 'attached.txt' : 'orphan.txt',
                'mimeType': 'text/plain',
                'url': 'data:text/plain;base64,aGk=',
              });
            }
            return {
              ...commandHeavyRow(index, turn: 20, output: 32),
              if (index == 80) 'queued': true,
            };
          },
        );
        final input = find.byKey(const Key('session-detail-prompt-input'));
        await app.enterText(input, 'Keep the phone draft');
        final field = f.tester.widget<TextField>(input);
        await app.captureReview('scroll-shortcuts-phone-dark-bottom');
        await app.tapKey('session-history-previous-prompt');
        expect(
          app.reading.index,
          80,
          reason: 'a queued user bubble is a navigation stop',
        );
        expect(field.focusNode!.hasFocus, isTrue);
        await app.captureReview('scroll-shortcuts-phone-dark-reading');
        await app.tapKey('session-history-previous-prompt');
        expect(
          app.reading.index,
          60,
          reason: 'an orphan attachment is not a stop',
        );
        await app.tapKey('session-history-previous-prompt');
        final attachment = find.text('attached.txt');
        expect(attachment, findsOneWidget);
        final viewport = f.tester.getRect(transcriptList);
        final attachmentTop = f.tester.getTopLeft(attachment).dy;
        expect(
          attachmentTop,
          inInclusiveRange(viewport.top, viewport.top + 120),
        );
        await app.tapKey('session-history-previous-prompt');
        expect(
          app.reading.index,
          20,
          reason: 'the attachment-only user row was one stop',
        );
        await app.tapKey('session-history-jump-latest');
        expect(field.focusNode!.hasFocus, isTrue);
        expect(field.controller!.text, 'Keep the phone draft');
      },
    );

    featureTest(
      'a capped scan continues from its last boundary and failures can retry',
      (f) async {
        final (app, broker) = await openPaging(
          f,
          total: 2600,
          row: (index) => index == 2599
              ? answerRow('Row 2599. ${markedProse(2599, 30)}', key: 'm2599')
              : commandHeavyRow(index, turn: 2500, output: 32),
        );
        await app.tapKey('session-history-previous-prompt');
        expect(app.reading.index, 2500);
        broker.failNext = 1;
        await app.tapKey('session-history-previous-prompt');
        expect(
          find.text('Could not load the previous user message.'),
          findsOneWidget,
        );
        expect(app.reading.index, 2500);
        await app.tap(find.text('Retry'));
        expect(
          broker.older.length,
          21,
          reason: 'a transient failure and a bounded 20-page walk',
        );
        expect(broker.older.last.cursor, 'b600');
        expect(find.text('Continue'), findsOneWidget);
        expect(app.reading.index, 2500);
        await app.tap(find.text('Continue'));
        await app.pumpUntil(
          () => app.topOf(0) != null,
          reason: 'Continue resumes at b500 and reaches the first prompt',
        );
        expect(broker.older[21].cursor, 'b500');
        expect(broker.older.length, 26);
        expect(app.reading.index, 0);
      },
    );

    featureTest(
      'an existing page request is reused before scanning '
      'and cancellation restores follow',
      (f) async {
        final (app, broker) = await openPaging(
          f,
          total: 900,
          row: (index) => index == 899
              ? answerRow('Row 899. ${markedProse(899, 30)}', key: 'm899')
              : commandHeavyRow(index, turn: 800, output: 32),
        );
        await app.tapKey('session-history-previous-prompt');
        const key = SessionDetailKey(tool: 'codex', sessionId: 's1');
        final controller = app.container.read(
          sessionDetailControllerProvider(key).notifier,
        );
        broker.holding = true;
        await controller.loadEarlierHistory();
        await app.tapKey('session-history-previous-prompt');
        expect(
          broker.older,
          hasLength(1),
          reason: 'navigation waits for the existing request',
        );
        broker
          ..holding = false
          ..release();
        await app.pumpUntil(
          () => app.topOf(0) != null,
          reason: 'the existing page is reused before the remaining walk',
        );
        expect(broker.older.length, 8);
        expect(broker.older.map((request) => request.cursor).toSet().length, 8);

        await app.tapKey('session-history-jump-latest');
        // Drop the prompt rows from the tail and walk from a following bottom.
        broker.resync();
        await app.settle();
        broker.holding = true;
        // The latest prompt is retained but above the viewport; land on it,
        // return to bottom, then a reset without it starts an unloaded lookup.
        broker.socket.emit(
          historyFrame(
            [answerRow('Row 899. ${markedProse(899, 30)}', key: 'm899')],
            reset: true,
            cursor: 'r900',
            hasEarlier: true,
            olderCursor: 'b899',
          ),
        );
        await app.settle();
        await app.tapKey('session-history-previous-prompt');
        expect(broker.hasHeld, isTrue);
        await app.tapKey('session-history-previous-prompt');
        expect(
          find.byKey(const Key('session-history-jump-latest')),
          findsNothing,
        );
        broker
          ..release()
          ..holding = false
          ..append(answerRow('Row 900. Still following', key: 'm900'));
        await app.settle();
        expect(app.topOf(900), isNotNull);
      },
    );
  });

  group('a history the broker could not read', () {
    for (final (locale, tag) in [('English', 'en'), ('Chinese', 'zh')]) {
      featureTest('a refused history with a bounded replay shows neither a '
          'start nor an empty session ($locale)', (f) async {
        final app = await openTranscript(
          f,
          const [],
          locale: tag,
          setup: (studio) => scriptAttaches(studio, 's1', [
            (_) => [
              historyFrame(
                messages(6),
                reset: true,
                cursor: 'tail-cursor',
                hasEarlier: true,
                truncated: {'shown': 6, 'total': 996},
                gap: _resourceLimitGap,
              ),
            ],
          ]),
        );
        final l10n = await AppLocalizations.delegate.load(Locale(tag));
        expect(app.shown('Message 6'), 1);
        final up = find.byKey(const Key('session-history-previous-prompt'));
        expect(f.tester.widget<IconButton>(up).onPressed, isNull);
        expect(
          find.byTooltip(l10n.sessionHistoryPromptUnavailable),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('session-history-start-marker')),
          findsNothing,
          reason: 'a refusal cannot prove the start of the session',
        );
        expect(
          app.shown(l10n.sessionDetailTranscriptEmpty),
          0,
          reason: 'a refusal cannot prove the session has no messages',
        );
        final gapText = f.tester.widget<Text>(
          find.byKey(const Key('session-history-gap-text')),
        );
        expect(
          gapText.data,
          l10n.sessionHistoryUnavailable('HISTORY_PAGE_RESOURCE_LIMIT'),
          reason: 'the visible sentence is localized copy and nothing else',
        );
        // The broker's own sentence is English operator prose: it may be one
        // tap away, never inside the localized line.
        expect(gapText.data, isNot(contains('bounded paging index')));
        expect(find.byKey(const Key('contextual-details-text')), findsNothing);
        await app.openTechnicalDetails(
          find.byKey(const Key('session-history-diagnostic-item')),
        );
        final detail = f.tester.widget<SelectableText>(
          find.byKey(const Key('contextual-details-text')),
        );
        expect(detail.data, contains(_resourceLimitGap['message']));
        await app.tapKey('contextual-details-close');
      });
    }

    featureTest('a refusal with no replay keeps the rows already held', (
      f,
    ) async {
      final (app, studio) = await launchWithTranscript(
        f,
        const [],
        setup: (studio) => scriptAttaches(studio, 's1', [
          (_) => [
            historyFrame(
              messages(5),
              reset: true,
              cursor: 'first-cursor',
              hasEarlier: true,
              truncated: {'shown': 5, 'total': 400},
            ),
          ],
        ]),
      );
      await app.go('/sessions/codex/s1');
      final l10n = await AppLocalizations.delegate.load(const Locale('en'));
      expect(app.shown('Message 5'), 1);

      // The reconnect the broker cannot serve: no replacement, no rows, no
      // cursor move, only the truthful gap.
      studio
          .socketsFor('s1')
          .last
          .emit(historyFrame(const [], gap: _resourceLimitGap));
      await app.settle();
      expect(
        app.shown('Message 5'),
        1,
        reason: 'a refusal never erases rows the client already holds',
      );
      expect(
        find.byKey(const Key('session-history-start-marker')),
        findsNothing,
      );
      expect(app.shown(l10n.sessionDetailTranscriptEmpty), 0);
      expect(find.byKey(const Key('session-history-gap-text')), findsOneWidget);
    });

    featureTest('a refusal retracts a start the session had proven', (f) async {
      final (app, studio) = await launchWithTranscript(
        f,
        const [],
        setup: (studio) => scriptAttaches(studio, 's1', [
          (_) => [historyFrame(messages(3), reset: true, cursor: 'complete')],
        ]),
      );
      await app.go('/sessions/codex/s1');
      expect(
        find.byKey(const Key('session-history-start-marker')),
        findsOneWidget,
        reason: 'a complete replay genuinely reaches the start',
      );
      studio
          .socketsFor('s1')
          .last
          .emit(
            historyFrame(
              const [],
              gap: const {
                'code': 'HISTORY_PAGE_SOURCE_CHANGED',
                'reason': 'source-changed',
                'message':
                    'This session changed while its history was being read; no '
                    'messages could be replayed. Reconnect to retry.',
              },
            ),
          );
      await app.settle();
      expect(
        find.byKey(const Key('session-history-start-marker')),
        findsNothing,
        reason: 'a source that can no longer be read cannot prove its start',
      );
      expect(app.shown('Message 3'), 1);
    });

    featureTest('a contentless refusal, the last resort, still claims neither '
        'a start nor an empty session', (f) async {
      final app = await openTranscript(
        f,
        const [],
        setup: (studio) => scriptAttaches(studio, 's1', [
          (_) => [historyFrame(const [], gap: _resourceLimitGap)],
        ]),
      );
      final l10n = await AppLocalizations.delegate.load(const Locale('en'));
      expect(
        find.byKey(const Key('session-history-start-marker')),
        findsNothing,
      );
      expect(app.shown(l10n.sessionDetailTranscriptEmpty), 0);
      expect(
        find.byKey(const Key('session-history-gap-text')),
        findsOneWidget,
        reason: 'the gap is the only truthful thing to render here',
      );
    });

    featureTest('an ordinary stale cursor still reports its full replay', (
      f,
    ) async {
      final app = await openTranscript(
        f,
        const [],
        setup: (studio) => scriptAttaches(studio, 's1', [
          (_) => [
            historyFrame(
              messages(4),
              reset: true,
              cursor: 'replayed',
              gap: const {
                'code': 'HISTORY_CURSOR_DIVERGED',
                'reason': 'cursor-prefix-mismatch',
                'message':
                    'history cursor no longer matches this session; full '
                    'replay was sent',
              },
            ),
          ],
        ]),
      );
      final l10n = await AppLocalizations.delegate.load(const Locale('en'));
      final gapText = f.tester.widget<Text>(
        find.byKey(const Key('session-history-gap-text')),
      );
      expect(
        gapText.data,
        contains(
          l10n.sessionHistoryCursorUnavailable('HISTORY_CURSOR_DIVERGED'),
        ),
      );
      expect(app.shown('Message 4'), 1);
    });
  });

  group('a long session read far back', () {
    featureTest('a stream of rows while the reader is far back neither moves '
        'them nor outgrows the window', (f) async {
      final (app, broker) = await openPaging(f, total: 300);
      await app.readBack(broker, 2);
      await app.jumpToStart();
      final before = app.reading;

      // 600 rows are saved and streamed while the reader sits at the start of
      // what is loaded.
      for (var index = 300; index < 900; index++) {
        broker.append(markedRow(index));
        if (index % 50 == 49) await app.frames(2);
      }
      await app.settle();
      app.expectHeld(before, when: 'while 600 rows streamed in behind them');
      expect(
        broker.refreshes,
        isNotEmpty,
        reason: 'the client asks the broker for boundaries as rows arrive',
      );

      const key = SessionDetailKey(tool: 'codex', sessionId: 's1');
      final window = app.container
          .read(sessionDetailControllerProvider(key))
          .transcriptWindow;
      expect(
        window.messageCount,
        lessThanOrEqualTo(kMaxActiveTranscriptMessages),
        reason: 'the window stays inside its budget',
      );

      // The newest rows are there when the reader goes back to them.
      await app.jumpToEnd();
      expect(app.topOf(899), isNotNull, reason: 'the newest row is shown');
    });

    featureTest('a selection survives an older page landing and rows '
        'streaming in', (f) async {
      final (app, broker) = await openPaging(f, total: 200);
      final copied = app.captureClipboard();
      await app.jumpToStart();
      Finder rowText(int index) => find.byWidgetPredicate(
        (w) => w is RichText && w.text.toPlainText().startsWith('Row $index.'),
      );
      final start = f.tester.getTopLeft(rowText(100)) + const Offset(2, 8);
      final end = f.tester.getBottomRight(rowText(101)) - const Offset(2, 8);
      final drag = await f.tester.createGesture(kind: PointerDeviceKind.mouse);
      await drag.addPointer(location: start);
      await drag.down(start);
      await f.tester.pump();
      await drag.moveTo(start + const Offset(40, 2));
      await f.tester.pump();
      await drag.moveTo(end);
      await f.tester.pump();
      await drag.up();
      await app.settle();

      // An older page lands above the selection, and a row streams in below.
      await app.pageKey(LogicalKeyboardKey.pageUp, alt: true);
      await app.frames(10);
      expect(broker.older, hasLength(1));
      broker.append(markedRow(200));
      await app.frames(5);

      final area = find.ancestor(
        of: transcriptList,
        matching: find.byType(SelectionArea),
      );
      f.tester
          .state<SelectionAreaState>(area)
          .selectableRegion
          // No public hook exposes the selected content; the framework's own
          // copy path is the user's Copy.
          // ignore: deprecated_member_use
          .copySelection(SelectionChangedCause.toolbar);
      await f.tester.pump();
      expect(copied, isNotEmpty);
      expect(copied.last, contains('Row 100.'));
      expect(copied.last, contains('Row 101.'));
      expect(
        copied.last.indexOf('Row 100.'),
        lessThan(copied.last.indexOf('Row 101.')),
      );
    });
  });
}
