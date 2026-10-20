// F02 — Open-session tabs, through the real App.
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_store.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_ref.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/composer_driver.dart';
import '../support/feature/cosyncing_app.dart';
import '../support/feature/fake_broker.dart';
import '../support/feature/roster_driver.dart';

final AppLocalizations en = lookupAppLocalizations(const Locale('en'));

FakeBroker studioWithThree(FeatureContext f) =>
    f.network.add('http://studio.test:7734')
      ..addSession('s1', 'Fix login')
      ..addSession('s2', 'Tidy styles')
      ..addSession('s3', 'Write docs');

void main() {
  group('opening and closing', () {
    featureTest(
      'modifier selection closes a disjoint group or range with one Undo',
      (f) async {
        final studio = studioWithThree(f);
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.openFromRoster('s1', cwd: '/work/studio');
        await app.openFromRoster('s2');
        await app.openFromRoster('s3');
        await app.tap(app.tab('s1'));
        await app.tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
        await app.tap(app.tab('s3'));
        await app.tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
        expect(app.activeTabKey, 'codex/s1');
        expect(
          find.byKey(const Key('workspace-close-selected-tabs')),
          findsOneWidget,
        );
        await app.tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
        await app.tap(app.tab('s1'));
        await app.tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
        await app.chord(LogicalKeyboardKey.escape);
        expect(
          find.byKey(const Key('workspace-close-selected-tabs')),
          findsNothing,
        );
        await app.chord(
          LogicalKeyboardKey.keyW,
          modifiers: [
            LogicalKeyboardKey.controlLeft,
            LogicalKeyboardKey.altLeft,
          ],
        );
        expect(app.openTabKeys, ['codex/s2', 'codex/s3']);
        await app.tap(find.text(en.workspaceUndoCloseTabs));
        expect(app.openTabKeys, ['codex/s1', 'codex/s2', 'codex/s3']);
        expect(app.activeTabKey, 'codex/s1');
        await app.tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
        await app.tap(app.tab('s3'));
        await app.tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
        await app.chord(
          LogicalKeyboardKey.keyW,
          modifiers: [
            LogicalKeyboardKey.controlLeft,
            LogicalKeyboardKey.altLeft,
          ],
        );
        expect(app.openTabKeys, ['codex/s2']);
        expect(app.activeTabKey, 'codex/s2');
        await app.tap(find.text(en.workspaceUndoCloseTabs));
        expect(app.openTabKeys, ['codex/s1', 'codex/s2', 'codex/s3']);
        expect(app.activeTabKey, 'codex/s1');
        await app.tap(app.tab('s1'));
        await app.tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
        await app.tap(app.tab('s3'));
        await app.tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
        expect(app.activeTabKey, 'codex/s1');
        await app.tapKey('workspace-close-selected-tabs');
        expect(app.openTabKeys, isEmpty);
        await app.tap(find.text(en.workspaceUndoCloseTabs));
        expect(app.openTabKeys, ['codex/s1', 'codex/s2', 'codex/s3']);
        await app.tap(app.tab('s1'));
        await app.tester.sendKeyDownEvent(LogicalKeyboardKey.controlLeft);
        await app.tap(app.tab('s3'));
        await app.tester.sendKeyUpEvent(LogicalKeyboardKey.controlLeft);
        await app.tapKey('open-session-tab-close-codex/s1');
        expect(app.openTabKeys, ['codex/s2', 'codex/s3']);
        await app.tap(app.tab('s2'));
        await app.tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
        await app.tap(app.tab('s3'));
        await app.tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
        await app.tapKey('workspace-close-selected-tabs');
        await app.openFromRoster('s3');
        await app.openFromRoster('s2');
        await app.tap(find.text(en.workspaceUndoCloseTabs));
        expect(app.openTabKeys, ['codex/s3', 'codex/s2']);
        expect(
          studio.requests.where(
            (r) => r.method == 'DELETE' || r.path.endsWith('/end'),
          ),
          isEmpty,
        );
      },
    );
    featureTest(
      'a roster row opens one tab; opening it again only activates it; '
      'tabs keep the order they were opened in',
      (f) async {
        final studio = studioWithThree(f);
        await f.storage.seedServer(studio);
        final app = await f.launch();
        expect(app.openTabKeys, isEmpty);

        await app.openFromRoster('s1', cwd: '/work/studio');
        await app.openFromRoster('s2');
        await app.openFromRoster('s1');
        expect(app.openTabKeys, ['codex/s1', 'codex/s2']);
        expect(app.activeTabKey, 'codex/s1');
        expect(app.tabLabel('s1'), 'Fix login');

        await app.tester.tap(app.tab('s2'));
        await app.settle();
        expect(app.activeTabKey, 'codex/s2');
        expect(app.openTabKeys, ['codex/s1', 'codex/s2']);
      },
    );

    featureTest(
      'a tab is named by its session, an unnamed session reads as untitled '
      'rather than by its id, and a rename on the broker reaches the tab',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('u1', 'u1')
          ..addSession('t1', 'Original name');
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.openFromRoster('u1', cwd: '/work/studio');
        await app.openFromRoster('t1');

        expect(app.tabLabel('u1'), en.sessionDetailTitleUntitled);
        expect(find.text('u1'), findsNothing);
        expect(app.tabLabel('t1'), 'Original name');

        studio.updateSession('t1', {'title': 'Renamed upstream'});
        await app.pumpUntil(
          () => app.tabLabel('t1') == 'Renamed upstream',
          reason: 'the roster change reaches the open tab',
        );
      },
    );

    featureTest(
      'closing a tab, by its button or the middle mouse button, leaves the '
      'session running and in the roster; the neighbour takes over',
      (f) async {
        final studio = studioWithThree(f);
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.openFromRoster('s1', cwd: '/work/studio');
        await app.openFromRoster('s2');
        await app.openFromRoster('s3');
        expect(app.activeTabKey, 'codex/s3');

        await app.tapKey('open-session-tab-close-codex/s3');
        expect(app.openTabKeys, ['codex/s1', 'codex/s2']);
        expect(app.activeTabKey, isNotNull);
        expect(app.row('s3'), findsOneWidget, reason: 'still in the roster');

        await app.tester.tap(
          app.tab('s1'),
          buttons: kMiddleMouseButton,
          kind: PointerDeviceKind.mouse,
        );
        await app.settle();
        expect(app.openTabKeys, ['codex/s2']);
        expect(app.activeTabKey, 'codex/s2');
        final ends = studio.requests.where(
          (r) => r.method == 'DELETE' || r.path.endsWith('/end'),
        );
        expect(ends, isEmpty, reason: 'closing a tab ends nothing');
      },
    );

    featureTest(
      'Close all tabs says sessions keep running and Undo brings every tab '
      'back in order',
      (f) async {
        final studio = studioWithThree(f);
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.openFromRoster('s1', cwd: '/work/studio');
        await app.openFromRoster('s2');
        await app.openFromRoster('s3');
        await app.tester.tap(app.tab('s2'));
        await app.settle();

        await app.tapKey('workspace-close-all-tabs');
        expect(app.openTabKeys, isEmpty);
        expect(find.text(en.workspaceTabsClosed), findsOneWidget);

        await app.tap(find.text(en.workspaceUndoCloseTabs));
        expect(app.openTabKeys, ['codex/s1', 'codex/s2', 'codex/s3']);
        expect(app.activeTabKey, 'codex/s2');
      },
    );

    featureTest('tabs can be reordered by dragging', (f) async {
      final studio = studioWithThree(f);
      await f.storage.seedServer(studio);
      final app = await f.launch();
      await app.openFromRoster('s1', cwd: '/work/studio');
      await app.openFromRoster('s2');
      await app.openFromRoster('s3');

      final from = app.tester.getCenter(app.tab('s3'));
      final gesture = await app.tester.startGesture(
        from,
        kind: PointerDeviceKind.mouse,
      );
      await app.tester.pump(const Duration(milliseconds: 100));
      final left = app.tester.getTopLeft(app.tab('s1')).dx;
      for (var x = from.dx; x > left - 20; x -= 20) {
        await gesture.moveTo(Offset(x, from.dy));
        await app.tester.pump(const Duration(milliseconds: 50));
      }
      await app.tester.pump(const Duration(milliseconds: 200));
      await gesture.up();
      await app.settle();
      expect(app.openTabKeys, ['codex/s3', 'codex/s1', 'codex/s2']);
    });
  });

  group('remembering tabs', () {
    featureTest(
      'tabs and the active one come back after a restart; another server '
      'has its own set',
      (f) async {
        final studio = studioWithThree(f);
        final lab = f.network.add('http://lab.test:7734', machine: 'lab')
          ..addSession('l1', 'Lab run');
        await f.storage.seedServer(studio);
        await f.storage.seedServer(lab, active: false);
        var app = await f.launch();
        await app.openFromRoster('s1', cwd: '/work/studio');
        await app.openFromRoster('s2');
        await app.tester.tap(app.tab('s1'));
        await app.settle();

        app = await f.restart();
        await app.pumpUntil(
          () => app.openTabKeys.length == 2,
          reason: 'the working set loads',
        );
        expect(app.openTabKeys, ['codex/s1', 'codex/s2']);
        expect(app.activeTabKey, 'codex/s1');

        await app.switchServer('http://lab.test:7734');
        await app.pumpUntil(
          () => app.rosterReads(lab).isNotEmpty && app.openTabKeys.isEmpty,
          reason: 'the lab loads with a working set of its own',
        );
        await app.openFromRoster('l1', cwd: '/work/lab');
        expect(app.openTabKeys, ['codex/l1']);

        await app.switchServer('http://studio.test:7734');
        await app.pumpUntil(
          () => app.openTabKeys.length == 2,
          reason: "studio's own tabs return",
        );
        expect(app.openTabKeys, ['codex/s1', 'codex/s2']);
      },
    );

    featureTest(
      'a damaged saved tab is skipped, never blocking startup or the good ones',
      (f) async {
        final studio = studioWithThree(f);
        final server = await f.storage.seedServer(studio);
        final source = RosterSource.ofProfile(server).storageKey;
        final store = DriftOpenSessionsStore(f.storage.database);
        await store.openMember(
          source,
          const SessionRef.cachedIdentity(
            tool: 'codex',
            id: 's2',
            title: 'Tidy styles',
          ),
        );
        // A second record under the same source whose JSON is garbage.
        await f.storage.database
            .into(f.storage.database.appSettingRows)
            .insert(
              AppSettingRowsCompanion.insert(
                key:
                    '$openSessionMembershipSettingKeyPrefix'
                    '${_hex(source)}:${_hex('codex/broken')}',
                value: '{not json',
                updatedAt: DateTime.now(),
              ),
            );
        final app = await f.launch();
        await app.pumpUntil(
          () => app.openTabKeys.isNotEmpty,
          reason: 'the good tab loads',
        );
        expect(app.openTabKeys, ['codex/s2']);
        expect(find.text('Tidy styles'), findsWidgets);
      },
    );

    featureTest(
      'a session opened from the last-known roster becomes a tab that claims '
      'no activity until the broker answers',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('s1', 'Fix login', status: SessionStatus.needsInput);
        await f.storage.seedServer(studio);
        var app = await f.launch();
        await app.elapse(const Duration(seconds: 1));
        SessionStatus? statusOf(String id) => app.container
            .read(openSessionsControllerProvider)
            .valueOrNull
            ?.refs
            .where((r) => r.id == id)
            .singleOrNull
            ?.status;

        final held = studio.holdWhere(
          (r) => r.path == '/api/sessions' && windowOf(r) == '7d',
        );
        app = await f.restart();
        await app.tester.tap(
          find.byKey(const Key('cached-project-header-/work/studio')),
        );
        await app.settle();
        await app.tester.tap(
          find.byWidgetPredicate(
            (w) =>
                w.key is ValueKey<String> &&
                (w.key! as ValueKey<String>).value.startsWith(
                  'cached-session-row-',
                ) &&
                (w.key! as ValueKey<String>).value.endsWith('codex/s1'),
          ),
        );
        await app.settle();
        expect(app.openTabKeys, ['codex/s1']);
        expect(statusOf('s1'), isNull, reason: 'the cache stores no activity');

        held.release();
        await app.pumpUntil(
          () => statusOf('s1') == SessionStatus.needsInput,
          reason: "the broker's own status reaches the tab",
        );
      },
    );

    featureTest(
      'a link straight to a session opens it as a tab on a cold start',
      (f) async {
        final studio = studioWithThree(f);
        await f.storage.seedServer(studio);
        final app = await f.launch(initialLocation: '/sessions/codex/s2');
        await app.pumpUntil(
          () => app.openTabKeys.contains('codex/s2'),
          reason: 'the linked session opens',
        );
        expect(app.activeTabKey, 'codex/s2');
        expect(
          f.network.sockets.any((s) => s.url.path.contains('/codex/s2/')),
          isTrue,
        );
      },
    );
  });

  group('layouts', () {
    featureTest(
      'opening a session on a phone, then resizing to desktop and back, keeps '
      'that session open in both layouts',
      (f) async {
        final studio = studioWithThree(f);
        await f.storage.seedServer(studio);
        final app = await f.launch(viewport: FeatureViewport.phone);
        await app.tapKey('workspace-open-drawer');
        await app.expandProject('/work/studio');
        await app.tester.tap(app.row('s2'));
        await app.settle();

        f.tester.view.physicalSize = FeatureViewport.desktop.size;
        await app.settle();
        await app.pumpUntil(
          () => app.openTabKeys.contains('codex/s2'),
          reason: 'the desktop layout shows the open session as a tab',
        );
        expect(app.activeTabKey, 'codex/s2');
        expect(app.tabLabel('s2'), 'Tidy styles');

        // And back: the phone layout opens straight onto the same session.
        f.tester.view.physicalSize = FeatureViewport.phone.size;
        await app.settle();
        await app.pumpUntil(
          () => find.text('Tidy styles').evaluate().isNotEmpty,
          reason: 'the narrow layout shows the open session',
        );
        expect(app.openTabKeys, ['codex/s2']);
        expect(app.activeTabKey, 'codex/s2');
        expect(find.byKey(const Key('workspace-roster-pane')), findsNothing);
      },
    );
  });
}

String? windowOf(FakeBrokerRequest r) => r.uri.queryParameters['window'];

String _hex(String value) => [
  for (final unit in value.codeUnits) unit.toRadixString(16).padLeft(2, '0'),
].join();
