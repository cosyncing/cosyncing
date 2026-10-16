// F04d — Scheduled sends through the real App: "Send later" from the
// composer, the inline cards in Chat, editing and cancelling, how the cards
// keep fresh while the session's stream is up, and the manager page.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/app_driver.dart';
import '../support/feature/composer_driver.dart';
import '../support/feature/composer_wire.dart';
import '../support/feature/cosyncing_app.dart';
import '../support/feature/fake_broker.dart';
import '../support/feature/roster_driver.dart';
import '../support/feature/scheduled_wire.dart';
import '../support/feature/session_driver.dart';

const poll = Duration(seconds: 15);

Finder card(String id) => find.byKey(ValueKey('schedule-inline-card-$id'));
Finder cardText(String id) => find.byKey(ValueKey('schedule-inline-text-$id'));
ValueKey<String> managerRow(String id) => ValueKey('schedule-row-$id');

/// The scheduled messages Chat is showing, by schedule id.
List<String> cards() => [
  for (final element in find.byWidgetPredicate((w) {
    final key = w.key;
    return key is ValueKey<String> &&
        key.value.startsWith('schedule-inline-card-');
  }).evaluate())
    (element.widget.key! as ValueKey<String>).value.substring(
      'schedule-inline-card-'.length,
    ),
];

/// An opened session with its schedules.
Future<(AppDriver, FakeBroker, ComposerDesk, ScheduleDesk)> openScheduled(
  FeatureContext f, {
  void Function(ScheduleDesk schedules)? setup,
}) async {
  late ScheduleDesk schedules;
  final (app, studio, desk) = await openComposer(
    f,
    setup: (broker, desk) {
      schedules = ScheduleDesk(broker);
      setup?.call(schedules);
    },
  );
  return (app, studio, desk, schedules);
}

/// Waits (in fake time) until the broker has answered [reads] list reads.
Future<void> untilReads(AppDriver app, ScheduleDesk schedules, int reads) =>
    app.pumpUntil(
      () => schedules.listCalls >= reads,
      reason: 'the schedule list to be read $reads times',
      every: const Duration(milliseconds: 250),
    );

/// Opens the scheduled sends manager page.
Future<void> openManager(AppDriver app) async {
  await app.go('/settings/scheduled-sends');
  await app.settle();
}

/// The session's stream drops and the broker refuses new ones.
Future<void> loseStream(AppDriver app, FakeBroker studio) async {
  studio.socketsAccepted = false;
  for (final socket in studio.socketsFor('s1')) {
    socket.drop();
  }
  await app.tick(const Duration(seconds: 1));
}

void main() {
  group('Send later', () {
    featureTest(
      'schedules the composer text once, empties the composer, and shows the '
      'full prompt on a card with its state, Edit and Cancel',
      (f) async {
        final (app, _, _, schedules) = await openScheduled(f);
        await app.type('Continue this tonight');
        await app.openStatus();
        await app.tapKey('session-detail-send-later');
        expect(find.text('Schedule message'), findsOneWidget);
        expect(find.textContaining('Repeat'), findsNothing, reason: 'one-shot');
        await app.tapKey('schedule-message-submit');

        final body = schedules.created.single;
        expect(body['kind'], 'message');
        expect(body['tool'], 'codex');
        expect(body['sessionId'], 's1');
        expect(body['text'], 'Continue this tonight');
        expect(
          body['at']! as int,
          greaterThan(DateTime.now().millisecondsSinceEpoch),
        );

        await app.dismissModal();
        final id = schedules.rows.single['id']! as String;
        expect(card(id), findsOneWidget);
        expect(find.text('Continue this tonight'), findsOneWidget);
        expect(
          find.byKey(ValueKey('schedule-inline-state-$id')),
          findsOneWidget,
        );
        expect(find.text('Scheduled'), findsOneWidget);
        expect(app.composerText, isEmpty);
      },
    );

    featureTest(
      'a prompt over the length the broker accepts is refused in the sheet '
      'with a selectable message, and nothing is sent',
      (f) async {
        final (app, _, _, schedules) = await openScheduled(f);
        await app.type('x' * 32001);
        await app.openStatus();
        await app.tapKey('session-detail-send-later');
        await app.tapKey('schedule-message-submit');
        final error = find.byKey(const Key('schedule-message-error'));
        expect(error, findsOneWidget);
        expect(app.tester.widget(error), isA<SelectableText>());
        expect(schedules.created, isEmpty);
      },
    );
  });

  group('the cards in Chat', () {
    featureTest(
      "only this session's live messages are cards: other sessions, other "
      'tools and delivered rows are not',
      (f) async {
        final (app, _, _, _) = await openScheduled(
          f,
          setup: (schedules) {
            schedules
              ..addMessage('mine', id: 'mine')
              ..addMessage('theirs', id: 'other-session', sessionId: 's2')
              ..addMessage('other tool', id: 'other-tool', tool: 'claude')
              ..addMessage('done already', id: 'done', state: 'delivered');
          },
        );
        expect(cards(), ['mine']);
        expect(app.visibleText, contains('mine'));
        expect(app.visibleText, isNot(contains('theirs')));
        expect(app.visibleText, isNot(contains('done already')));
      },
    );

    featureTest(
      'Edit prefills the sheet and sends only the revision, the text and the '
      'time; the card follows, and a second edit uses the new revision',
      (f) async {
        final (app, _, _, schedules) = await openScheduled(
          f,
          setup: (s) => s.addMessage('Original scheduled prompt', id: 'a'),
        );
        await app.tapKey('schedule-inline-edit-a');
        expect(
          app.tester
              .widget<TextField>(find.byKey(const Key('schedule-message-text')))
              .controller!
              .text,
          'Original scheduled prompt',
        );
        await app.enterText(
          find.byKey(const Key('schedule-message-text')),
          'Edited once',
        );
        await app.tapKey('schedule-message-edit-submit');
        expect(schedules.edits.single.keys.toSet(), {
          'expectedRevision',
          'text',
          'at',
        });
        expect(schedules.edits.single['expectedRevision'], 1);
        expect(cardText('a'), findsOneWidget);
        expect(find.text('Edited once'), findsOneWidget);

        await app.tapKey('schedule-inline-edit-a');
        await app.enterText(
          find.byKey(const Key('schedule-message-text')),
          'Edited twice',
        );
        await app.tapKey('schedule-message-edit-submit');
        expect(schedules.edits.last['expectedRevision'], 2);
        expect(find.text('Edited twice'), findsOneWidget);
      },
    );

    featureTest('Cancel goes by id, without a revision, and the card goes', (
      f,
    ) async {
      final (app, studio, _, schedules) = await openScheduled(
        f,
        setup: (s) => s.addMessage('Cancel me', id: 'a'),
      );
      await app.tapKey('schedule-inline-cancel-a');
      expect(schedules.deletes, ['a']);
      final request = studio.requests.lastWhere((r) => r.method == 'DELETE');
      expect(request.path, '/api/schedules/a');
      expect(request.body, isNull);
      expect(cards(), isEmpty);
    });

    featureTest(
      'a message the broker delivers at its time leaves Chat once as the '
      'prompt it carried',
      (f) async {
        final (app, _, desk, schedules) = await openScheduled(
          f,
          setup: (s) => s.addMessage('Run the nightly report', id: 'a'),
        );
        expect(cards(), ['a']);
        schedules.deliver('a', desk);
        await app.tick(poll);
        await app.settle();
        expect(cards(), isEmpty);
        expect(app.bubbles('Run the nightly report'), 1);
      },
    );
  });

  group('keeping the cards fresh', () {
    featureTest(
      'while the stream is up the cards are re-read every 15 s; while it is '
      'down nothing is requested and the cards stay; reconnecting reads '
      'once and resumes the cadence',
      (f) async {
        final (app, studio, desk, schedules) = await openScheduled(
          f,
          setup: (s) => s.addMessage('Keep me', id: 'a'),
        );
        expect(schedules.listCalls, 1, reason: 'one connected initial read');
        await app.tick(poll);
        expect(schedules.listCalls, 2);

        await loseStream(app, studio);
        final before = schedules.listCalls;
        await app.tick(poll);
        await app.tick(poll);
        await app.tick(poll);
        expect(schedules.listCalls, before, reason: 'no read while offline');
        expect(cards(), ['a']);
        expect(find.byKey(const Key('schedule-inline-error')), findsNothing);

        studio.socketsAccepted = true;
        await app.pumpUntil(
          () => desk.attaches >= 2,
          reason: 'the stream to return',
          every: const Duration(seconds: 1),
        );
        await untilReads(app, schedules, before + 1);
        await app.tick(const Duration(seconds: 1));
        expect(schedules.listCalls, before + 1, reason: 'one reconnect read');
        await app.tick(poll);
        expect(schedules.listCalls, before + 2, reason: 'cadence resumed');
      },
    );

    featureTest(
      'on a phone, while Status takes the place of Chat no schedule is read; '
      'back in Chat the cards are read again',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('s1', 'Fix login');
        ComposerDesk(studio);
        final schedules = ScheduleDesk(studio)..addMessage('Keep me', id: 'a');
        await f.storage.seedServer(studio);
        final app = await f.launch(viewport: FeatureViewport.phone);
        await app.tapKey('workspace-open-drawer');
        await app.openFromRoster('s1', cwd: '/work/studio');
        expect(schedules.listCalls, 1);

        await app.openStatus();
        await app.tick(poll);
        await app.tick(poll);
        expect(schedules.listCalls, 1, reason: 'no cards on screen to keep');

        await app.tapKey('session-detail-view-back');
        await untilReads(app, schedules, 2);
        expect(cards(), ['a']);
      },
    );

    featureTest(
      'opening the session while the stream is down makes no read at all',
      (f) async {
        late ScheduleDesk schedules;
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('s1', 'Fix login');
        ComposerDesk(studio);
        schedules = ScheduleDesk(studio)..addMessage('Not yet', id: 'a');
        studio.socketsAccepted = false;
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.openFromRoster('s1', cwd: '/work/studio');
        await app.tick(poll);
        await app.tick(poll);
        expect(schedules.listCalls, 0);
      },
    );

    featureTest(
      'a backgrounded app makes no schedule reads, and coming back reads '
      'once and re-arms the timer',
      (f) async {
        final (app, _, _, schedules) = await openScheduled(
          f,
          setup: (s) => s.addMessage('Keep me', id: 'a'),
        );
        expect(schedules.listCalls, 1);
        await app.background();
        await app.tick(poll);
        await app.tick(poll);
        await app.tick(poll);
        expect(schedules.listCalls, 1);
        expect(cards(), ['a']);

        await app.foreground();
        await untilReads(app, schedules, 2);
        await app.tick(const Duration(seconds: 1));
        expect(schedules.listCalls, 2, reason: 'one catch-up read');
        await app.tick(poll);
        expect(schedules.listCalls, 3);
      },
    );
  });

  group('when the broker cannot be reached or refuses', () {
    featureTest(
      'a failing background read keeps the cards and says nothing in Chat',
      (f) async {
        final (app, _, _, schedules) = await openScheduled(
          f,
          setup: (s) => s.addMessage('Keep me', id: 'a'),
        );
        schedules.listFailure = FakeBrokerResponse.error(
          503,
          'UNAVAILABLE',
          'try later',
        );
        await app.tick(poll);
        expect(schedules.listCalls, 2);
        expect(cards(), ['a']);
        expect(find.byKey(const Key('schedule-inline-error')), findsNothing);

        schedules
          ..listFailure = null
          ..addMessage('Appeared', id: 'b');
        await app.tick(poll);
        expect(cards(), ['a', 'b']);
      },
    );

    featureTest(
      'an explicit Cancel that fails says so in Chat and keeps the card; the '
      'next try works',
      (f) async {
        final (app, _, _, schedules) = await openScheduled(
          f,
          setup: (s) => s.addMessage('Cancel me', id: 'a'),
        );
        schedules.mutationFailure = FakeBrokerResponse.error(
          500,
          'INTERNAL',
          'boom RAW-DETAIL',
        );
        await app.tapKey('schedule-inline-cancel-a');
        expect(find.byKey(const Key('schedule-inline-error')), findsOneWidget);
        expect(app.visibleText, isNot(contains('RAW-DETAIL')));
        expect(cards(), ['a']);

        await app.tapKey('schedule-inline-cancel-a');
        expect(cards(), isEmpty);
      },
    );

    featureTest(
      'editing a message that changed on another device refreshes the cards '
      'and reports the conflict',
      (f) async {
        final (app, _, _, schedules) = await openScheduled(
          f,
          setup: (s) => s.addMessage('Original', id: 'a'),
        );
        // Another device edits it: the broker's revision moves on.
        schedules.row('a')
          ..['revision'] = 5
          ..['text'] = 'Edited elsewhere';
        await app.tapKey('schedule-inline-edit-a');
        await app.enterText(
          find.byKey(const Key('schedule-message-text')),
          'My edit',
        );
        await app.tapKey('schedule-message-edit-submit');
        expect(schedules.edits.single['expectedRevision'], 1);
        expect(find.text('Edited elsewhere'), findsOneWidget);
        expect(find.text('My edit'), findsNothing);
        expect(find.byKey(const Key('schedule-inline-error')), findsOneWidget);
      },
    );

    featureTest(
      'a read still hanging when the stream drops cannot stall the '
      'reconnect, and its late answer does not replace the newer one',
      (f) async {
        final (app, studio, desk, schedules) = await openScheduled(
          f,
          setup: (s) => s.addMessage('Fresh', id: 'a'),
        );
        var first = true;
        final hung = studio.holdWhere((r) {
          if (r.method != 'GET' || r.path != '/api/schedules') return false;
          final mine = first;
          first = false;
          return mine;
        });
        await app.tick(poll);
        expect(hung.pending, 1);
        final stale = FakeBrokerResponse(200, {
          'ok': true,
          'schedules': [
            {...schedules.row('a'), 'text': 'Stale answer'},
          ],
        });

        studio.socketsAccepted = false;
        for (final socket in studio.socketsFor('s1')) {
          socket.drop();
        }
        await app.tick(const Duration(seconds: 1));
        studio.socketsAccepted = true;
        await app.pumpUntil(
          () => desk.attaches >= 2,
          reason: 'the stream to return',
          every: const Duration(seconds: 1),
        );
        await app.settle();
        expect(find.text('Fresh'), findsOneWidget);

        hung.release(stale);
        await app.settle();
        expect(find.text('Stale answer'), findsNothing);
        expect(find.text('Fresh'), findsOneWidget);
      },
    );
  });

  group('servers keep their schedules apart', () {
    featureTest(
      "switching server shows none of the other server's cards and reads "
      'nothing from the old one, the manager page kept from before the '
      'switch lists the new server; coming back shows its own again',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('s1', 'Studio work', cwd: '/work/studio');
        final lab = f.network.add('http://lab.test:7734', machine: 'lab')
          ..addSession('s1', 'Lab work', cwd: '/work/lab');
        ComposerDesk(studio);
        ComposerDesk(lab);
        final studioSchedules = ScheduleDesk(studio)
          ..addMessage('Studio prompt', id: 'studio-a');
        final labSchedules = ScheduleDesk(lab)
          ..addMessage('Lab prompt', id: 'lab-a');
        await f.storage.seedServer(studio);
        await f.storage.seedServer(lab, active: false);
        final app = await f.launch();
        // The settings branch keeps the manager page alive from here on.
        await openManager(app);
        expect(find.byKey(managerRow('studio-a')), findsOneWidget);
        await app.go('/sessions');
        await app.openFromRoster('s1', cwd: '/work/studio');
        expect(cards(), ['studio-a']);

        await app.switchServer('http://lab.test:7734');
        await app.openFromRoster('s1', cwd: '/work/lab');
        expect(cards(), ['lab-a']);
        expect(app.visibleText, isNot(contains('Studio prompt')));
        final studioReads = studioSchedules.listCalls;
        await app.tick(poll);
        await app.tick(poll);
        expect(studioSchedules.listCalls, studioReads);
        expect(labSchedules.listCalls, greaterThan(1));

        await openManager(app);
        expect(find.byKey(managerRow('lab-a')), findsOneWidget);
        expect(find.byKey(managerRow('studio-a')), findsNothing);
        await app.go('/sessions');

        await app.switchServer('http://studio.test:7734');
        await app.openFromRoster('s1', cwd: '/work/studio');
        expect(cards(), ['studio-a']);
        expect(app.visibleText, isNot(contains('Lab prompt')));
      },
    );
  });

  group('manager page', () {
    featureTest(
      "lists the broker's schedules, pauses and resumes one with its "
      'revision, and cancels then removes another',
      (f) async {
        final (app, _, _, schedules) = await openScheduled(
          f,
          setup: (s) => s
            ..addMessage('First prompt', id: 'a')
            ..addMessage('Second prompt', id: 'b'),
        );
        await openManager(app);
        expect(find.byKey(const ValueKey('schedule-row-a')), findsOneWidget);
        expect(find.byKey(const ValueKey('schedule-row-b')), findsOneWidget);

        await app.tap(find.byKey(const ValueKey('schedule-pause-a')));
        await app.settle();
        expect(schedules.actions.single['action'], 'pause');
        expect(schedules.actions.single['expectedRevision'], 1);
        expect(schedules.row('a')['state'], 'paused');
        expect(find.byKey(const ValueKey('schedule-resume-a')), findsOneWidget);

        await app.tap(find.byKey(const ValueKey('schedule-resume-a')));
        await app.settle();
        expect(schedules.row('a')['state'], 'scheduled');

        await app.tap(find.byKey(const ValueKey('schedule-delete-b')));
        await app.settle();
        expect(schedules.row('b')['state'], 'canceled');
        await app.tap(find.byKey(const ValueKey('schedule-delete-b')));
        await app.settle();
        expect(schedules.deletes, ['b', 'b']);
        expect(find.byKey(const ValueKey('schedule-row-b')), findsNothing);
        expect(find.byKey(const ValueKey('schedule-row-a')), findsOneWidget);
      },
    );

    featureTest(
      'a failing mutation is reported as a failed mutation and leaves the '
      'row as the broker has it',
      (f) async {
        final (app, _, _, schedules) = await openScheduled(
          f,
          setup: (s) => s.addMessage('Keep me', id: 'a'),
        );
        await openManager(app);
        schedules.mutationFailure = FakeBrokerResponse.error(
          500,
          'SCHEDULE_FAILED',
          'The broker could not do that.',
        );
        await app.tap(find.byKey(const ValueKey('schedule-pause-a')));
        await app.settle();
        expect(
          find.byKey(const ValueKey('schedule-manager-error')),
          findsOneWidget,
        );
        expect(schedules.row('a')['state'], 'scheduled');
        expect(find.byKey(const ValueKey('schedule-pause-a')), findsOneWidget);
      },
    );
  });
}
