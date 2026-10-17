// F02 — The session roster, through the real App.
//
// Every scenario runs the real App against a wire-level fake broker
// (`test/support/feature/`): the real REST client, roster controller, delta
// feed, status registry, snapshot store and Drift database run; only the
// broker and time are fake. Waits are bounded pumps of fake time.
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_page.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_rename_region.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/drift.dart' show Value;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/cosyncing_app.dart';
import '../support/feature/fake_broker.dart';
import '../support/feature/roster_driver.dart';

final AppLocalizations en = lookupAppLocalizations(const Locale('en'));

DateTime daysAgo(int days) => DateTime.now().subtract(Duration(days: days));

String? windowOf(FakeBrokerRequest request) =>
    request.uri.queryParameters['window'];

Finder tooltipContaining(String text) => find.byWidgetPredicate(
  (w) => w is Tooltip && (w.message?.contains(text) ?? false),
);

void main() {
  group('roster window', () {
    featureTest(
      'a fresh install asks for the last seven days; an empty window offers '
      'all sessions and the choice survives a restart',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('old-1', 'Ancient refactor', updatedAt: daysAgo(30));
        await f.storage.seedServer(studio);
        final app = await f.launch();

        expect(windowOf(app.rosterReads(studio).first), '7d');
        expect(find.text(en.sessionsEmptyWindowLast7Days), findsOneWidget);
        expect(find.text('Ancient refactor'), findsNothing);

        await app.tapKey('workspace-empty-show-all');
        expect(windowOf(app.rosterReads(studio).last), 'all');
        await app.expandProject('/work/studio');
        expect(find.text('Ancient refactor'), findsOneWidget);

        studio.requests.clear();
        final again = await f.restart();
        expect(windowOf(again.rosterReads(studio).first), 'all');
      },
    );

    featureTest(
      'the activity filter changes what the broker is asked for, both ways',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('fresh', 'Fresh work')
          ..addSession('week', 'Last week', updatedAt: daysAgo(3))
          ..addSession('month', 'Last month', updatedAt: daysAgo(20));
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.expandProject('/work/studio');
        expect(find.text('Fresh work'), findsOneWidget);
        expect(find.text('Last week'), findsOneWidget);
        expect(find.text('Last month'), findsNothing);

        await app.tapKey('session-roster-filter-button');
        await app.tapKey('session-roster-filter-activity-today');
        expect(app.rosterReads(studio).map(windowOf), contains('1d'));
        await app.expandProject('/work/studio');
        expect(find.text('Fresh work'), findsOneWidget);
        expect(find.text('Last week'), findsNothing);
        final label = app.tester.widget<Text>(
          find.byKey(const Key('session-roster-window-label')),
        );
        expect(label.data, en.sessionRosterActivityToday);

        // The menu stays open between choices.
        await app.tapKey('session-roster-filter-activity-any');
        await app.expandProject('/work/studio');
        expect(find.text('Last month'), findsOneWidget);
      },
    );
  });

  featureTest(
    'Home counts old active sessions before filters and never fetches all time',
    (f) async {
      final studio = f.network.add('http://studio.test:7734')
        ..addSession(
          'old',
          'Old active work',
          status: SessionStatus.working,
          updatedAt: daysAgo(30),
        )
        ..addSession(
          'background',
          'Background approval',
          origin: 'exec',
          status: SessionStatus.needsInput,
          updatedAt: daysAgo(30),
        );
      final lab = f.network.add('http://lab.test:7734', machine: 'lab')
        ..addSession('lab', 'Lab task', status: SessionStatus.needsInput);
      await f.storage.seedServer(studio);
      await f.storage.seedServer(lab, active: false);
      var app = await f.launch();
      Finder count(String kind, String value) => find.descendant(
        of: find.byKey(Key('workspace-overview-count-$kind')),
        matching: find.text(value),
      );
      void noOverviewFetches() {
        for (final broker in [studio, lab]) {
          expect(
            app
                .rosterReads(broker)
                .where(
                  (request) =>
                      windowOf(request) == null || windowOf(request) == 'all',
                ),
            isEmpty,
          );
        }
      }

      expect(count('running', '1'), findsOneWidget);
      expect(count('waiting', '1'), findsOneWidget);
      noOverviewFetches();
      await app.search('no matching sidebar row');
      expect(count('running', '1'), findsOneWidget);
      expect(count('waiting', '1'), findsOneWidget);
      studio.updateSession('old', {'status': 'needs-input'});
      await app.pumpUntil(
        () => count('waiting', '2').evaluate().isNotEmpty,
        reason: 'Home follows a status change through the roster feed',
      );
      noOverviewFetches();
      await app.search('');
      await app.tapKey('session-roster-filter-button');
      await app.tapKey('session-roster-filter-activity-today');
      expect(count('waiting', '2'), findsOneWidget);
      noOverviewFetches();
      // Close the filter popover before changing the source.
      await app.tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await app.settle();
      await app.switchServer('http://lab.test:7734');
      await app.pumpUntil(
        () => count('waiting', '1').evaluate().isNotEmpty,
        reason: 'Home uses only the new source',
      );
      noOverviewFetches();
      await app.lifecycle(AppLifecycleState.paused);
      await app.lifecycle(AppLifecycleState.resumed);
      expect(count('waiting', '1'), findsOneWidget);
      noOverviewFetches();
      app = await f.restart();
      expect(count('waiting', '1'), findsOneWidget);
      noOverviewFetches();
    },
  );

  group('rows and projects', () {
    featureTest(
      'rows show titles and never a raw id; projects group by directory, '
      'start collapsed, wear the broker alias and stay open through a refresh',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('a1', 'Fix login', cwd: '/work/app')
          ..addSession('a2', 'a2', cwd: '/work/app')
          ..addSession(
            'b1',
            'Write docs',
            cwd: '/work/docs',
            projectName: 'Handbook',
          );
        await f.storage.seedServer(studio);
        final app = await f.launch();

        expect(find.text('Handbook'), findsOneWidget);
        expect(find.text('app'), findsOneWidget);
        expect(find.text('Fix login'), findsNothing, reason: 'collapsed');
        final reads = app.rosterReads(studio, window: '7d').length;

        await app.expandProject('/work/app');
        await app.elapse(const Duration(seconds: 5));
        expect(find.text('Fix login'), findsOneWidget);
        expect(find.text(en.sessionDetailTitleUntitled), findsOneWidget);
        expect(find.text('a2'), findsNothing, reason: 'the id is no title');
        expect(find.text('Write docs'), findsNothing);
        expect(
          app.rosterReads(studio, window: '7d'),
          hasLength(reads),
          reason: 'no fetch',
        );

        await app.tapKey('roster-freshness-refresh');
        expect(app.rosterReads(studio, window: '7d'), hasLength(reads + 1));
        expect(find.text('Fix login'), findsOneWidget, reason: 'still open');
        expect(find.text('Write docs'), findsNothing);
      },
    );

    featureTest(
      'at twice the text size the roster pane, the phone drawer and the '
      'overview beside it fit their width',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('a1', 'Fix login');
        await f.storage.seedServer(studio);
        final device = f.tester.platformDispatcher
          ..textScaleFactorTestValue = 2;
        addTearDown(device.clearTextScaleFactorTestValue);
        var app = await f.launch();
        await app.expandProject('/work/studio');
        expect(find.text('Fix login'), findsOneWidget);
        expect(f.tester.takeException(), isNull, reason: 'desktop pane');

        await f.quit();
        app = await f.launch(viewport: FeatureViewport.narrowPhone);
        expect(f.tester.takeException(), isNull, reason: 'phone overview');
        await app.tapKey('workspace-open-drawer');
        await app.expandProject('/work/studio');
        expect(find.text('Fix login'), findsOneWidget);
        expect(f.tester.takeException(), isNull, reason: 'phone drawer');
      },
    );

    featureTest(
      "a row says which agent and how long ago, from the broker's own clock, "
      'and the age moves on with the clock',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession(
            's1',
            'Tune the cache',
            updatedAt: f.now().subtract(const Duration(minutes: 5)),
          );
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.expandProject('/work/studio');
        expect(tooltipContaining('Codex'), findsOneWidget);
        expect(tooltipContaining('5m ago'), findsOneWidget);

        // Nothing changes on the broker; only the app's clock moves.
        await app.elapse(const Duration(minutes: 10));
        expect(tooltipContaining('Codex · 15m ago'), findsOneWidget);
        expect(tooltipContaining('Codex · 5m ago'), findsNothing);
      },
    );

    featureTest(
      'renaming a project sends the directory and shows the alias; switching '
      "servers loads the new server's roster at once, and an answer that "
      'lands after the switch changes nothing',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('a1', 'Fix login', cwd: '/work/app');
        final lab = f.network.add('http://lab.test:7734', machine: 'lab')
          ..addSession('l1', 'Lab run', cwd: '/work/app');
        await f.storage.seedServer(studio);
        await f.storage.seedServer(lab, active: false);
        final app = await f.launch();

        await app.renameProject('/work/app', 'Storefront');
        final rename = studio.requestsTo('/api/projects/rename').single;
        expect(rename.body, {'cwd': '/work/app', 'name': 'Storefront'});
        expect(find.text('Storefront'), findsOneWidget);

        final hold = studio.hold('PATCH', '/api/projects/rename');
        await app.renameProject('/work/app', 'Shop');
        expect(hold.pending, 1);
        await app.switchServer('http://lab.test:7734');
        // 3 s of fake time, well inside the workspace's 15 s roster poll: the
        // switch itself loads the new server's roster.
        await app.pumpUntil(
          () => lab.requestsTo('/api/sessions').isNotEmpty,
          reason: 'the second server roster loads at once, not on the poll',
          steps: 60,
        );
        hold.release();
        // The answer crosses the client's request pipeline in under a second
        // of fake time; let it land before asserting it changed nothing.
        await app.elapse(const Duration(seconds: 5));
        expect(find.text('Shop'), findsNothing);
        expect(find.text('Storefront'), findsNothing);
        expect(find.text('app'), findsOneWidget, reason: "the lab's own row");
      },
    );
  });

  group('search and review', () {
    featureTest(
      'search reveals matches inside collapsed projects without asking the '
      'broker, and clearing it puts the projects back',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('a1', 'Fix login', cwd: '/work/app')
          ..addSession('a2', 'Tidy styles', cwd: '/work/app')
          ..addSession('b1', 'Write docs', cwd: '/work/docs');
        await f.storage.seedServer(studio);
        final app = await f.launch();
        final reads = app.rosterReads(studio, window: '7d').length;

        await app.search('login');
        await app.elapse(const Duration(seconds: 5));
        expect(find.text('Fix login'), findsOneWidget);
        expect(find.text('Tidy styles'), findsNothing);
        expect(find.text('Write docs'), findsNothing);
        expect(app.rosterReads(studio, window: '7d'), hasLength(reads));

        await app.tapKey('session-roster-search-clear');
        expect(find.text('Fix login'), findsNothing, reason: 'collapsed again');

        await app.search('nothing matches this');
        expect(find.text(en.sessionRosterFilteredEmpty), findsOneWidget);
      },
    );

    featureTest('the slash key and Ctrl+F jump to the roster search', (
      f,
    ) async {
      final studio = f.network.add('http://studio.test:7734')
        ..addSession('a1', 'Fix login');
      await f.storage.seedServer(studio);
      final app = await f.launch();
      bool searchFocused() => app.tester
          .widget<EditableText>(
            find.descendant(
              of: find.byKey(const Key('session-roster-search')),
              matching: find.byType(EditableText),
            ),
          )
          .focusNode
          .hasFocus;

      expect(searchFocused(), isFalse);
      // Keys go to whatever has focus: the user has just used the roster.
      await app.expandProject('/work/studio');
      await app.tester.sendKeyEvent(LogicalKeyboardKey.slash);
      await app.settle();
      expect(searchFocused(), isTrue);

      await app.tester.tap(app.row('a1'));
      await app.settle();
      expect(searchFocused(), isFalse);
      await app.pressCtrlF();
      expect(searchFocused(), isTrue);
    });

    featureTest(
      'F5, Ctrl+R and Cmd+R refresh the roster, from the search field too',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('a1', 'Fix login');
        await f.storage.seedServer(studio);
        final app = await f.launch();
        // Keys go to whatever has focus: the user has just used the roster.
        await app.expandProject('/work/studio');

        Future<void> chord(LogicalKeyboardKey modifier) async {
          await app.tester.sendKeyDownEvent(modifier);
          await app.tester.sendKeyEvent(LogicalKeyboardKey.keyR);
          await app.tester.sendKeyUpEvent(modifier);
        }

        // Each press is followed by well under a second of fake time; the
        // workspace's own roster poll is 15 s away, so every read counted
        // here is the shortcut's.
        final presses = <String, Future<void> Function()>{
          'F5': () => app.tester.sendKeyEvent(LogicalKeyboardKey.f5),
          'Ctrl+R': () => chord(LogicalKeyboardKey.controlLeft),
          'Cmd+R': () => chord(LogicalKeyboardKey.metaLeft),
        };
        for (final MapEntry(key: name, value: press) in presses.entries) {
          final before = app.rosterReads(studio).length;
          await press();
          await app.settle();
          expect(
            app.rosterReads(studio).length,
            greaterThan(before),
            reason: '$name refreshes the roster',
          );
        }

        await app.tester.sendKeyEvent(LogicalKeyboardKey.slash);
        await app.settle();
        final before = app.rosterReads(studio).length;
        await app.tester.sendKeyEvent(LogicalKeyboardKey.f5);
        await app.settle();
        expect(
          app.rosterReads(studio).length,
          greaterThan(before),
          reason: 'F5 types nothing, so it refreshes from the search field',
        );
      },
    );

    featureTest(
      'a finished run marks its session ready to review until it is opened; '
      'other sessions stay unmarked',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('busy', 'Refactor build', status: SessionStatus.working)
          ..addSession('calm', 'Read the docs');
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.expandProject('/work/studio');
        const busyDot = Key('session-ready-/codex/busy');
        expect(find.byKey(busyDot), findsNothing, reason: 'still working');

        studio
          ..updateSession('busy', {'status': 'idle'})
          ..publishAttention(sessionId: 'busy');
        await app.pumpUntil(
          () => find.byKey(busyDot).evaluate().isNotEmpty,
          reason: 'the finished session is flagged',
        );
        expect(
          find.byKey(const Key('session-ready-/codex/calm')),
          findsNothing,
        );
        expect(find.byTooltip(en.sessionRosterReadyToReview), findsOneWidget);

        await app.openFromRoster('busy');
        await app.pumpUntil(
          () => find.byKey(busyDot).evaluate().isEmpty,
          reason: 'opening the session reads the completion',
        );
      },
    );

    featureTest(
      'rows are ordered needs-input, working, then idle, and a status change '
      'moves the row',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('idle', 'Idle one', updatedAt: daysAgo(1))
          ..addSession('work', 'Working one', status: SessionStatus.working)
          ..addSession('ask', 'Asking one', status: SessionStatus.needsInput);
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.expandProject('/work/studio');
        double top(String id) => app.tester.getTopLeft(app.row(id)).dy;

        expect(top('ask'), lessThan(top('work')));
        expect(top('work'), lessThan(top('idle')));

        studio.updateSession('idle', {'status': 'needs-input'});
        await app.pumpUntil(
          () => top('idle') < top('work'),
          reason: 'the session that now needs input moves up',
        );
      },
    );
  });

  group('live changes and races', () {
    featureTest(
      'a session changing rebuilds its own roster row and no other',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('a1', 'Fix login')
          ..addSession('a2', 'Tidy styles')
          ..addSession('a3', 'Write docs');
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.expandProject('/work/studio');
        final rebuilt = <String>[];
        debugOnRebuildDirtyWidget = (element, _) {
          if (element.widget case SessionRenameRegion(:final sessionId)) {
            rebuilt.add(sessionId);
          }
        };
        addTearDown(() => debugOnRebuildDirtyWidget = null);

        studio.updateSession('a2', {'status': 'working'});
        await app.pumpUntil(
          () => app.container
              .read(sessionListControllerProvider)
              .sessions
              .any((s) => s.id == 'a2' && s.status == SessionStatus.working),
          reason: 'the roster takes the new status',
        );

        expect(rebuilt, isNotEmpty, reason: 'the changed row shows it');
        expect(
          rebuilt.toSet(),
          {'a2'},
          reason: 'rows whose session did not change are kept as they were',
        );
      },
    );

    featureTest(
      'another session changing leaves the open session page, and its '
      'transcript, alone',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('s1', 'Fix login')
          ..addSession('s2', 'Tidy styles');
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.openFromRoster('s1', cwd: '/work/studio');
        await app.settle();
        var pageBuilds = 0;
        debugOnRebuildDirtyWidget = (element, _) {
          if (element.widget is SessionDetailPage) pageBuilds++;
        };
        addTearDown(() => debugOnRebuildDirtyWidget = null);

        studio.updateSession('s2', {'status': 'working'});
        await app.pumpUntil(
          () => app.container
              .read(sessionListControllerProvider)
              .sessions
              .any((s) => s.id == 's2' && s.status == SessionStatus.working),
          reason: "the roster takes the other session's new status",
        );

        expect(
          pageBuilds,
          0,
          reason: 'the open page shows nothing of another session',
        );
      },
    );

    featureTest(
      'the delta feed adds, renames and removes rows without another roster '
      'fetch, and the fallback poll stays quiet while it is healthy',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('a1', 'Fix login')
          ..addSession('a2', 'Tidy styles');
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.expandProject('/work/studio');
        final reads = app.rosterReads(studio, window: '7d').length;

        studio
          ..addSession('a3', 'Brand new work')
          ..updateSession('a1', {'title': 'Fix signup'})
          ..removeSession('a2');
        await app.pumpUntil(
          () => find.text('Brand new work').evaluate().isNotEmpty,
          reason: 'the new session arrives over the feed',
        );
        expect(find.text('Fix signup'), findsOneWidget);
        expect(find.text('Fix login'), findsNothing);
        expect(find.text('Tidy styles'), findsNothing);

        // A server deadline answers an empty batch at the same revision.
        // Following it must preserve the published roster object and its order.
        await app.lifecycle(AppLifecycleState.paused);
        final before = app.container.read(sessionListControllerProvider);
        studio.respondNextWhere(
          (r) => r.path == '/api/session-roster-deltas',
          FakeBrokerResponse(200, {
            'revision': studio.rosterRevision,
            'deltas': <Object>[],
          }),
        );
        final polls = studio.requestsTo('/api/session-roster-deltas').length;
        await app.lifecycle(AppLifecycleState.resumed);
        await app.pumpUntil(
          () =>
              studio.requestsTo('/api/session-roster-deltas').length >=
              polls + 2,
          reason: 'the empty heartbeat is consumed and the next poll waits',
        );
        expect(app.container.read(sessionListControllerProvider), same(before));

        // Minutes pass: the workspace's own poll timer fires, and asks nothing.
        await app.elapse(const Duration(minutes: 3));
        expect(app.rosterReads(studio, window: '7d'), hasLength(reads));
      },
    );

    featureTest(
      'a roster answer that comes back late can never overwrite a newer '
      'revision the feed already delivered',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('a1', 'Fix login');
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.expandProject('/work/studio');

        final stale = studio.rosterAnswer(window: '7d');
        final hold = studio.holdWhere(
          (r) => r.path == '/api/sessions' && windowOf(r) == '7d',
        );
        await app.tapKey('roster-freshness-refresh');
        expect(hold.pending, 1);

        studio.addSession('a2', 'Newer than the held answer');
        await app.pumpUntil(
          () => find.text('Newer than the held answer').evaluate().isNotEmpty,
          reason: 'the feed delivers the newer revision first',
        );
        hold.release(stale);
        // The answer crosses the client's request pipeline in under a second
        // of fake time; let it land before asserting it changed nothing.
        await app.elapse(const Duration(seconds: 5));
        expect(find.text('Newer than the held answer'), findsOneWidget);
        expect(find.text('Fix login'), findsOneWidget);
      },
    );

    featureTest(
      'a broker that starts its revisions over is followed once, then the '
      'feed carries on from the new numbering',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('a1', 'Before the restart')
          ..addSession('a2', 'Also before');
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.expandProject('/work/studio');
        expect(studio.rosterRevision, greaterThan(2));

        final now = DateTime.now().millisecondsSinceEpoch;
        studio.restartRoster(
          revision: 2,
          rows: [
            SessionInfo(
              id: 'n1',
              tool: 'codex',
              title: 'After the restart',
              status: SessionStatus.idle,
              attachMode: AttachMode.live,
              cwd: '/work/studio',
              updatedAt: now,
            ).toJson(),
          ],
        );
        await app.pumpUntil(
          () => find.text('After the restart').evaluate().isNotEmpty,
          reason: 'the reset roster replaces the old one',
        );
        expect(find.text('Before the restart'), findsNothing);
        expect(find.text('Also before'), findsNothing);

        studio.addSession('n2', 'After, over the feed');
        await app.pumpUntil(
          () => find.text('After, over the feed').evaluate().isNotEmpty,
          reason: 'revision numbering continues from the reset',
        );
        expect(find.text('After the restart'), findsOneWidget);
      },
    );

    featureTest(
      'a hidden app cancels its roster long poll and a resumed one asks again',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('a1', 'Fix login');
        await f.storage.seedServer(studio);
        final app = await f.launch();
        List<FakeBrokerRequest> polls() =>
            studio.requestsTo('/api/session-roster-deltas');
        expect(polls(), hasLength(1));
        expect(polls().single.cancelled, isFalse);

        await app.lifecycle(AppLifecycleState.paused);
        expect(polls().single.cancelled, isTrue);
        await app.elapse(const Duration(minutes: 2));
        expect(polls(), hasLength(1), reason: 'nothing asked while hidden');

        await app.lifecycle(AppLifecycleState.resumed);
        await app.pumpUntil(
          () => polls().length == 2,
          reason: 'the feed restarts when the app is shown again',
        );
        expect(polls().last.cancelled, isFalse);
      },
    );

    featureTest(
      'a roster feed that fails once is retried and carries on',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('a1', 'Fix login')
          ..respondNextWhere(
            (r) => r.path == '/api/session-roster-deltas',
            FakeBrokerResponse.error(500, 'INTERNAL', 'feed $rawLeakSentinel'),
          );
        await f.storage.seedServer(studio);
        final app = await f.launch();
        List<FakeBrokerRequest> polls() =>
            studio.requestsTo('/api/session-roster-deltas');
        await app.pumpUntil(
          () => polls().length >= 2,
          reason: 'the feed asks again after the failure',
          every: const Duration(milliseconds: 250),
        );
        expect(polls().first.answered, 500);
        expect(find.byKey(const Key('session-roster-error')), findsNothing);

        studio.addSession('a2', 'After the hiccup');
        await app.expandProject('/work/studio');
        await app.pumpUntil(
          () => find.text('After the hiccup').evaluate().isNotEmpty,
          reason: 'the retried feed delivers the change',
        );
        app.expectNoRawErrorLeak();
      },
    );

    featureTest(
      'a broker without a delta feed is polled, answers not-modified until '
      'something changes, and then updates the list',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..deltaFeedStatus = 404
          ..addSession('a1', 'Fix login');
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.expandProject('/work/studio');
        List<FakeBrokerRequest> windowReads() =>
            app.rosterReads(studio).where((r) => windowOf(r) == '7d').toList();
        final first = windowReads().length;

        await app.pumpUntil(
          () => windowReads().length > first,
          reason: 'the poll timer asks again',
          every: const Duration(seconds: 1),
        );
        final poll = windowReads().last;
        expect(poll.headers['if-none-match'], isNotNull);
        expect(poll.answered, 304);
        expect(find.text('Fix login'), findsOneWidget);

        studio.addSession('a2', 'Added while polling');
        await app.pumpUntil(
          () => find.text('Added while polling').evaluate().isNotEmpty,
          reason: 'the next poll sees the change',
          every: const Duration(seconds: 1),
        );
        expect(windowReads().last.answered, 200);
      },
    );

    featureTest(
      'an incomplete roster never deletes what it does not mention; the '
      'complete one that follows does',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('a1', 'Fix login')
          ..addSession('a2', 'Tidy styles');
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.expandProject('/work/studio');

        studio
          ..rosterComplete = false
          ..sessions.removeWhere((s) => s['id'] == 'a2')
          ..bumpRosterRevision();
        await app.pumpUntil(
          () =>
              !app.container.read(sessionListControllerProvider).rosterComplete,
          reason: 'the client reads the partial roster',
        );
        // Let the partial answer cross the request pipeline and be applied.
        await app.elapse(const Duration(seconds: 5));
        expect(find.text(en.workspacePartialRoster), findsOneWidget);
        expect(
          find.descendant(
            of: find.byKey(const Key('workspace-overview-count-running')),
            matching: find.text('—'),
          ),
          findsOneWidget,
        );
        expect(find.text('Tidy styles'), findsOneWidget, reason: 'not deleted');
        expect(find.text('Fix login'), findsOneWidget);

        studio
          ..rosterComplete = true
          ..bumpRosterRevision();
        await app.pumpUntil(
          () => find.text('Tidy styles').evaluate().isEmpty,
          reason: 'a complete roster is authoritative for removal',
        );
      },
    );
  });

  group('failure, retry and the cached roster', () {
    featureTest(
      'a failed first load offers exactly one Retry, in plain words, and '
      'retrying brings the rows',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('a1', 'Fix login');
        await f.storage.seedServer(studio);
        studio.respondNextWhere(
          (r) => r.path == '/api/sessions' && windowOf(r) == '7d',
          FakeBrokerResponse.error(500, 'INTERNAL', 'boom $rawLeakSentinel'),
        );
        final app = await f.launch();

        expect(find.byKey(const Key('session-roster-error')), findsOneWidget);
        expect(find.byKey(const Key('session-roster-retry')), findsOneWidget);
        expect(
          find.byKey(const Key('roster-freshness-retry')),
          findsNothing,
          reason: 'the header slot does not offer a second Retry',
        );
        expect(find.byKey(const Key('roster-freshness-deferred')), findsOne);
        app.expectNoRawErrorLeak();

        await app.retryRoster();
        await app.expandProject('/work/studio');
        expect(find.text('Fix login'), findsOneWidget);
        expect(find.byKey(const Key('session-roster-error')), findsNothing);
      },
    );

    featureTest(
      'a refresh that fails keeps the rows on screen and the header offers '
      'the one Retry',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('a1', 'Fix login');
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.expandProject('/work/studio');

        studio.respondNextWhere(
          (r) => r.path == '/api/sessions' && windowOf(r) == '7d',
          FakeBrokerResponse.error(503, 'UNAVAILABLE', 'try later'),
        );
        await app.tapKey('roster-freshness-refresh');
        expect(find.text('Fix login'), findsOneWidget);
        expect(find.byKey(const Key('roster-freshness-retry')), findsOneWidget);

        await app.tapKey('roster-freshness-retry');
        expect(find.byKey(const Key('roster-freshness-retry')), findsNothing);
        expect(find.byKey(const Key('roster-freshness-refresh')), findsOne);
        expect(find.text('Fix login'), findsOneWidget);
      },
    );

    featureTest(
      'a cold start shows the last known sessions, claiming no activity, '
      'until the broker answers; another server never sees them',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('a1', 'Fix login', status: SessionStatus.working);
        final lab = f.network.add('http://lab.test:7734', machine: 'lab')
          ..addSession('l1', 'Lab run');
        await f.storage.seedServer(studio);
        await f.storage.seedServer(lab, active: false);
        var app = await f.launch();
        await app.expandProject('/work/studio');
        expect(find.text(en.sessionRosterStatusWorking), findsWidgets);
        // The snapshot is written behind the roster; let it land.
        await app.elapse(const Duration(seconds: 1));

        final held = studio.holdWhere(
          (r) => r.path == '/api/sessions' && windowOf(r) == '7d',
        );
        app = await f.restart();
        expect(find.byKey(const Key('cached-roster-pane')), findsOneWidget);
        expect(find.text(en.sessionRosterCachedReconnecting), findsOneWidget);
        expect(
          find.descendant(
            of: find.byKey(const Key('workspace-overview-count-running')),
            matching: find.text('—'),
          ),
          findsOneWidget,
        );
        await app.tester.tap(
          find.byKey(const Key('cached-project-header-/work/studio')),
        );
        await app.settle();
        expect(find.text('Fix login'), findsOneWidget);
        expect(find.text(en.sessionRosterCachedRowLabel), findsOneWidget);
        expect(find.text(en.sessionRosterStatusWorking), findsNothing);

        held.release();
        await app.pumpUntil(
          () => find.byKey(const Key('cached-roster-pane')).evaluate().isEmpty,
          reason: 'the broker answer replaces the cache',
        );
        await app.expandProject('/work/studio');
        expect(find.text(en.sessionRosterStatusWorking), findsWidgets);

        // The same cache, another server: nothing of studio shows up there.
        final labHeld = lab.holdWhere(
          (r) => r.path == '/api/sessions' && windowOf(r) == '7d',
        );
        await app.switchServer('http://lab.test:7734');
        await app.waitFor(find.byKey(const Key('roster-freshness-busy')));
        expect(find.text('Fix login'), findsNothing);
        expect(find.byKey(const Key('cached-roster-pane')), findsNothing);
        labHeld.release();
        await app.pumpUntil(
          () => find.text('lab').evaluate().isNotEmpty,
          reason: "the lab's own roster arrives",
        );
        expect(find.text('Fix login'), findsNothing);
      },
    );
  });

  group('cached roster while the server is down', () {
    featureTest(
      'last-known sessions stay visible with a plain unreachable notice and '
      'Retry; retrying reaches the server again',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('a1', 'Fix login');
        await f.storage.seedServer(studio);
        var app = await f.launch();
        await app.elapse(const Duration(seconds: 1));

        studio.respondNextWhere(
          (r) => r.path == '/api/sessions' && windowOf(r) == '7d',
          FakeBrokerResponse.error(503, 'UNAVAILABLE', 'down $rawLeakSentinel'),
        );
        app = await f.restart();
        await app.waitFor(find.byKey(const Key('cached-roster-banner')));
        await app.pumpUntil(
          () => find
              .text(en.sessionRosterCachedUnreachable)
              .evaluate()
              .isNotEmpty,
          reason: 'the failure is reported on the cached roster',
        );
        app.expectNoRawErrorLeak();
        expect(find.byKey(const Key('cached-roster-pane')), findsOneWidget);

        await app.tapKey('cached-roster-retry');
        await app.pumpUntil(
          () => find.byKey(const Key('cached-roster-pane')).evaluate().isEmpty,
          reason: 'the server answers and replaces the cached rows',
        );
        await app.expandProject('/work/studio');
        expect(find.text('Fix login'), findsOneWidget);
      },
    );
  });

  group('a snapshot that cannot be trusted', () {
    featureTest(
      'a corrupt or future-version saved roster is ignored and replaced; '
      'the app still starts and loads the real one',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('a1', 'Fix login');
        await f.storage.seedServer(studio);
        var app = await f.launch();
        await app.elapse(const Duration(seconds: 1));
        final table = f.storage.database.rosterSnapshotRows;

        for (final damage in <RosterSnapshotRowsCompanion>[
          const RosterSnapshotRowsCompanion(rowsJson: Value('{not json')),
          const RosterSnapshotRowsCompanion(payloadVersion: Value(9999)),
        ]) {
          await f.storage.database.update(table).write(damage);
          final held = studio.holdWhere(
            (r) => r.path == '/api/sessions' && windowOf(r) == '7d',
          );
          app = await f.restart();
          expect(
            find.byKey(const Key('cached-roster-pane')),
            findsNothing,
            reason: 'nothing believable to show before the broker answers',
          );
          held.release();
          await app.expandProject('/work/studio');
          expect(find.text('Fix login'), findsOneWidget);
          await app.elapse(const Duration(seconds: 1));
        }
      },
    );
  });

  group('subagents', () {
    featureTest(
      'a subagent nests under its parent whichever arrives first, a working '
      'child makes the parent read Working, and search reveals only the '
      'matching path',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('lone', 'Unrelated work')
          ..addSession(
            'c1',
            'Child one',
            origin: 'subagent',
            parentThreadId: 'thread-p',
            nativeId: 'thread-c1',
            status: SessionStatus.working,
          );
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.expandProject('/work/studio');

        // The child arrived before its parent exists: it is not hidden.
        expect(find.text('Child one'), findsOneWidget);

        studio
          ..addSession('p1', 'Parent work', nativeId: 'thread-p')
          ..addSession(
            'c2',
            'Child two',
            origin: 'subagent',
            parentThreadId: 'thread-p',
            nativeId: 'thread-c2',
          );
        await app.pumpUntil(
          () => find.text('Parent work').evaluate().isNotEmpty,
          reason: 'the parent arrives',
        );
        expect(find.text('Child one'), findsNothing, reason: 'now nested');
        expect(find.text('Child two'), findsNothing);
        expect(find.text('Parent work'), findsOneWidget);
        expect(
          find.byKey(const Key('session-children-codex/p1')),
          findsOneWidget,
          reason: 'two linked sessions behind the parent',
        );
        // The idle parent reads Working while a child works.
        expect(find.text(en.sessionRosterStatusWorking), findsOneWidget);

        await app.search('Child two');
        Finder inList(String text) => find.descendant(
          of: find.byKey(const Key('session-roster-list')),
          matching: find.text(text),
        );
        expect(inList('Child two'), findsOneWidget);
        expect(inList('Parent work'), findsOneWidget);
        expect(inList('Child one'), findsNothing, reason: 'not on the path');
      },
    );
  });
}
