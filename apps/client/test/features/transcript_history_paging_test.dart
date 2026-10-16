// F03b: paging through a long session the way a reader does. Older pages land
// above the reader and newer pages fill ranges the window released, one page
// per intentional gesture, and the row being read never moves while they do.
// A page that fails, stalls or is refused is retried or given up on by rule,
// and the reader's keys work without a mouse.
//
// Every wait is fake time; the broker answers `history-page` frames over the
// real stream.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/cosyncing_app.dart';
import '../support/feature/paging_broker.dart';
import '../support/feature/transcript_reader.dart';

void main() {
  group('paging at rest', () {
    featureTest('pages landing above and below, and pages released on either '
        'side, never move the row being read, across more than five pages '
        'and three changes of direction', (f) async {
      final (app, broker) = await openPaging(f);
      broker.holding = true;

      // Read back eight pages: each lands above the reader, and past the
      // budget the window releases pages between the reader and the tail.
      for (var page = 0; page < 8; page++) {
        await app.askForEarlier();
        expect(broker.older, hasLength(page + 1));
        await app.frames(3);
        // The notice at the start may sit just above the viewport.
        expect(find.text(loadingEarlier, skipOffstage: false), findsOneWidget);
        expect(find.text(loadingNewer, skipOffstage: false), findsNothing);
        final before = app.reading;
        broker.release();
        await app.frames();
        app.expectHeld(before, when: 'as older page ${page + 1} landed');
      }

      // Turn around and read forward: the released range below fills with
      // newer pages, and past the budget the window releases pages above.
      for (var page = 0; page < 2; page++) {
        final before = await app.askForNewer(broker);
        expect(before, isNotNull, reason: 'a released range must lie below');
        expect(broker.newer, hasLength(page + 1));
        expect(
          find.descendant(
            of: releasedRanges,
            matching: find.text(loadingNewer),
          ),
          findsOneWidget,
          reason: 'the range filling below the reader says so',
        );
        expect(find.text(loadingEarlier, skipOffstage: false), findsNothing);
        broker.release();
        await app.frames();
        app.expectHeld(before!, when: 'as newer page ${page + 1} landed');
      }

      // From the newest rows, read back up into the rest of that range: it
      // fills from its newer edge, above the reader.
      await app.jumpToEnd();
      for (var page = 0; page < 2; page++) {
        final requests = broker.older.length;
        final before = await app.askForRangeAbove(broker);
        expect(before, isNotNull, reason: 'a released range must lie above');
        expect(broker.older, hasLength(requests + 1));
        expect(
          find.descendant(
            of: releasedRanges,
            matching: find.text(loadingEarlier),
          ),
          findsOneWidget,
          reason: 'the range filling above the reader says so',
        );
        expect(find.text(loadingNewer, skipOffstage: false), findsNothing);
        broker.release();
        await app.frames();
        app.expectHeld(before!, when: 'as range page ${page + 1} landed');
      }

      // And once more from the start of what is loaded.
      for (var page = 0; page < 2; page++) {
        await app.askForEarlier();
        await app.frames(3);
        final before = app.reading;
        broker.release();
        await app.frames();
        app.expectHeld(before, when: 'as leading page ${page + 1} landed');
      }
      expect(broker.requests, hasLength(14));
    });
  });

  group('one page per intentional gesture', () {
    featureTest('opening never pages, and upward gestures load one 100-row '
        'page at a time through the true start', (f) async {
      final (app, broker) = await openPaging(f, total: 300);
      broker
        ..expectRequests(0, reason: 'opening never pages')
        ..holding = true;

      await app.jumpToStart();
      broker.expectRequests(0, reason: 'a jump is not the reader moving');

      await app.drag(120);
      expect(broker.requests, hasLength(1));
      expect(broker.requests.single.limit, 100);
      expect(broker.requests.single.cursor, 'b200');
      expect(find.text(loadingEarlier, skipOffstage: false), findsOneWidget);

      // Staying inside the threshold while the page is slow cannot ask for
      // the cursor in flight again.
      await app.drag(-20);
      expect(broker.requests, hasLength(1));

      broker.release();
      await app.frames();
      await app.jumpToStart();
      await app.drag(120);
      expect(broker.requests.map((r) => r.cursor), ['b200', 'b100']);

      // The last page ends at the start of the session.
      broker.release();
      await app.frames();
      await app.jumpToStart();
      expect(
        find.byKey(const Key('session-history-start-marker')),
        findsOneWidget,
      );
      expect(app.topOf(0), isNotNull, reason: 'the first row is reachable');
      await app.drag(160);
      expect(
        broker.requests,
        hasLength(2),
        reason: 'the authoritative start stops page requests for good',
      );

      expect(find.byKey(const Key('session-history-jump-latest')), findsOne);
      await app.tapKey('session-history-jump-latest');
      await app.settle();
      expect(
        app.position.pixels,
        closeTo(app.position.maxScrollExtent, 1),
        reason: 'Jump to latest lands on the newest rows',
      );
      expect(broker.requests, hasLength(2));
    });

    featureTest('one swipe at the start chains a bounded number of short '
        'pages, and a long page ends the chain', (f) async {
      final (app, broker) = await openPaging(
        f,
        total: 400,
        pageRows: 3,
        row: shortPagingRow,
      );
      await app.jumpToStart();
      final surface = find.byKey(const Key('session-detail-chat-scroll'));
      final swipe = await f.tester.startGesture(f.tester.getCenter(surface));
      await swipe.moveBy(const Offset(0, 140));
      await swipe.up();
      await app.frames(12);
      // Each short page lands with the reader still at the start, so it
      // calls for the next without any further movement: twice, the most
      // pages asked for without the reader's hand behind them.
      expect(broker.requests, hasLength(3));
      await app.pumpFor(const Duration(seconds: 3));
      expect(
        broker.requests,
        hasLength(3),
        reason: 'a still reader is not paged on and on',
      );

      // Moving again asks again. A long page then leaves the reader far from
      // the start, and nothing more is asked for.
      broker.pageRows = null;
      final again = await f.tester.startGesture(f.tester.getCenter(surface));
      await again.moveBy(const Offset(0, 60));
      await again.up();
      await app.frames(12);
      expect(broker.requests, hasLength(4));
      await app.pumpFor(const Duration(seconds: 3));
      expect(broker.requests, hasLength(4));
    });
  });

  group('keys', () {
    featureTest('Page Up and Page Down stay live without a mouse', (f) async {
      final (app, _) = await openPaging(f, total: 200);
      final tail = app.position.pixels;
      await app.pageKey(LogicalKeyboardKey.pageUp, times: 10);
      final afterUp = app.position.pixels;
      expect(afterUp, lessThan(tail));
      expect(_shortcutFocus(f), isTrue);
      await app.pageKey(LogicalKeyboardKey.pageDown, times: 10);
      expect(app.position.pixels, greaterThan(afterUp));
      expect(_shortcutFocus(f), isTrue);
    });

    featureTest('a dropped stream and its reconnect alone page nothing; the '
        'keyboard loads earlier rows once the reader asks', (f) async {
      final (app, broker) = await openPaging(f, total: 200);
      // The stream goes down and the broker refuses it for a while.
      final studio = broker.broker..socketsAccepted = false;
      broker.socket.drop();
      await app.elapse(const Duration(seconds: 2));
      await app.jumpToStart();
      await app.drag(120);
      broker.expectRequests(0, reason: 'nothing can page over a dead stream');
      expect(
        find.text('Reconnect to load earlier messages.'),
        findsNothing,
        reason: 'ordinary offline history is not a non-reloadable cursor gap',
      );

      studio.socketsAccepted = true;
      await app.pumpUntil(
        () => studio.socketsFor('s1').last.isConnected,
        reason: 'the app reconnects',
        every: const Duration(milliseconds: 500),
      );
      await app.frames(10);
      broker.expectRequests(
        0,
        reason: 'a reconnect must not consume the cursor',
      );
      expect(
        find.byKey(const Key('session-history-load-earlier')),
        findsNothing,
      );
      expect(_shortcutFocus(f), isTrue);

      await app.jumpToStart();
      await app.pageKey(LogicalKeyboardKey.pageUp, alt: true);
      expect(broker.requests, hasLength(1));
      expect(broker.requests.single.limit, 100);
    });
  });

  group('a page that does not come', () {
    featureTest('a transient refusal offers Retry until the page comes', (
      f,
    ) async {
      final (app, broker) = await openPaging(
        f,
        total: 300,
        configure: (broker) => broker.failNext = 1,
      );
      await app.jumpToStart();
      expect(
        find.byKey(const Key('session-history-load-earlier')),
        findsNothing,
        reason: 'a healthy start offers no button',
      );
      await app.drag(80);
      expect(broker.requests, hasLength(1));
      expect(broker.requests.single.failed, isTrue);
      final retry = find.byKey(const Key('session-history-load-earlier'));
      expect(retry, findsOneWidget);
      expect(find.text('Retry'), findsOneWidget);

      await app.pumpFor(const Duration(milliseconds: 700));
      expect(broker.requests.map((r) => r.cursor), ['b200', 'b200']);
      expect(broker.requests.last.failed, isFalse);
      expect(
        find.byKey(const Key('session-history-load-earlier')),
        findsNothing,
        reason: 'the page came; there is nothing to retry',
      );
    });

    // A tap on Retry leaves the transcript's selection in the notice row,
    // whose Retry button, loading line and blank slot then swap as the page
    // lands: the frames after the tap must not trip the selection registrar.
    featureTest('Retry asks again, and the page lands', (f) async {
      final (app, broker) = await openPaging(
        f,
        total: 300,
        configure: (broker) => broker.failNext = 1,
      );
      await app.jumpToStart();
      await app.drag(80);
      await f.tester.tap(find.byKey(const Key('session-history-load-earlier')));
      await app.frames(3);
      expect(broker.requests.map((r) => r.cursor), ['b200', 'b200']);
      await app.pumpFor(const Duration(seconds: 1));
      expect(
        find.byKey(const Key('session-history-load-earlier')),
        findsNothing,
        reason: 'the page landed',
      );
      expect(
        broker.requests,
        hasLength(2),
        reason: 'asked once more, not twice',
      );
    });

    featureTest('a page that failed for a passing reason is asked for again '
        'after a doubling backoff', (f) async {
      final (app, broker) = await openPaging(
        f,
        configure: (broker) => broker
          ..failNext = 2
          ..failureCode = 'HISTORY_PAGE_SOURCE_CHANGED',
      );
      await app.placeBelowStart(0.5);
      await app.wheel(-40);
      await f.tester.pump();
      expect(broker.requests, hasLength(1));
      // The reader stays at the boundary; the first retry waits 500 ms.
      await app.pumpFor(const Duration(milliseconds: 440));
      expect(broker.requests, hasLength(1));
      await app.pumpFor(const Duration(milliseconds: 120));
      expect(broker.requests, hasLength(2));
      // The second waits 1000 ms, and succeeds.
      await app.pumpFor(const Duration(milliseconds: 900));
      expect(broker.requests, hasLength(2));
      await app.pumpFor(const Duration(milliseconds: 160));
      expect(broker.requests, hasLength(3));
      expect(broker.requests.last.failed, isFalse);
      await app.pumpFor(const Duration(seconds: 3));
      expect(broker.requests, hasLength(3), reason: 'nothing more at rest');
    });

    featureTest('a page that brings nothing is asked for again only after '
        'the backoff, and the start of what is loaded says it failed', (
      f,
    ) async {
      final (app, broker) = await openPaging(
        f,
        configure: (broker) => broker.stallNext = 1000,
      );
      await app.placeBelowStart(0.5);
      await app.wheel(-40);
      await f.tester.pump();
      expect(broker.requests, hasLength(1));
      // 500 ms, then 1, 2 and 4 s (each counted from the frame the last answer
      // landed in), and no more once the automatic retries are spent.
      for (final (wait, asked) in const [
        (Duration(milliseconds: 440), 1),
        (Duration(milliseconds: 120), 2),
        (Duration(milliseconds: 900), 2),
        (Duration(milliseconds: 160), 3),
        (Duration(milliseconds: 1800), 3),
        (Duration(milliseconds: 250), 4),
        (Duration(milliseconds: 3700), 4),
        (Duration(milliseconds: 400), 5),
        (Duration(seconds: 20), 5),
      ]) {
        await app.pumpFor(wait);
        expect(broker.requests, hasLength(asked));
      }
      expect(broker.requests.map((r) => r.cursor).toSet(), {'b1900'});
      expect(
        find.byKey(
          const Key('session-history-page-error'),
          skipOffstage: false,
        ),
        findsOneWidget,
      );
      // Moving on the spent boundary asks for nothing by itself.
      for (var tick = 0; tick < 5; tick++) {
        await app.wheel(-40);
        await app.pumpFor(const Duration(milliseconds: 300));
      }
      expect(broker.requests, hasLength(5));
    });

    for (final code in const ['BAD_PARAM', 'HISTORY_PAGE_RESOURCE_LIMIT']) {
      featureTest('a refusal that cannot pass ($code) is never asked for '
          'again by itself', (f) async {
        final (app, broker) = await openPaging(
          f,
          total: 300,
          configure: (broker) => broker
            ..failNext = 1
            ..failureCode = code,
        );
        await app.jumpToStart();
        await app.drag(80);
        await app.pumpFor(const Duration(seconds: 20));
        for (var tick = 0; tick < 5; tick++) {
          await app.drag(80);
          await app.pumpFor(const Duration(milliseconds: 300));
        }
        expect(broker.requests, hasLength(1));
        if (code == 'HISTORY_PAGE_RESOURCE_LIMIT') {
          expect(
            find.text(
              'The server cannot load this history within its resource limits.',
            ),
            findsOneWidget,
            reason: 'a refusal that can never pass says so, in plain words',
          );
          expect(
            find.byKey(const Key('session-history-load-earlier')),
            findsNothing,
            reason: 'and offers no Retry',
          );
        }
      });
    }
  });
}

bool _shortcutFocus(FeatureContext f) => f.tester
    .widget<SelectionArea>(
      find.byKey(const Key('session-history-shortcut-focus')),
    )
    .focusNode!
    .hasFocus;
