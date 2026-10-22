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
