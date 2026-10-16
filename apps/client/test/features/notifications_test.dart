// F07 — Notifications through the real App: the attention feed, what the OS
// shows while the app is in the background, the banner while it is open, the
// inbox, the unseen badge, and a tap on a notification. The broker is a
// wire-level fake whose attention log behaves like the real store; the OS
// notification centre is a fake under the app's real notification sink.
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_delivery_settings_controller.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_runtime.dart';
import 'package:cosyncing_client/src/features/attention/controller/notification_system_controller.dart';
import 'package:cosyncing_client/src/features/attention/data/attention_notification_type_settings_store.dart';
import 'package:cosyncing_client/src/features/attention/model/attention_notification_type.dart';
import 'package:cosyncing_client/src/features/connection/data/active_broker_profile_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/app_driver.dart';
import '../support/feature/attention_wire.dart';
import '../support/feature/cosyncing_app.dart';
import '../support/feature/fake_broker.dart';
import '../support/feature/fake_os_notifications.dart';
import '../support/feature/fake_push.dart';
import '../support/feature/store_faults.dart';
import '../support/notification_test_support.dart';

final AppLocalizations en = lookupAppLocalizations(const Locale('en'));

/// The app retries unsent read and dismiss posts every two minutes; a wait
/// for one steps a minute of fake time at a time.
const _drainTick = Duration(minutes: 1);

/// One device: its notification centre, its app lifecycle, and the saved
/// server with its attention log.
class Device {
  Device(this.f) {
    studio = f.network.add('http://studio.test:7734')
      ..addSession('s1', 'Fix login')
      ..addSession('s2', 'Refactor build')
      ..addSession('s3', 'Write the docs');
    desk = AttentionDesk(studio);
  }

  final FeatureContext f;
  final os = FakeOsNotifications();
  final lifecycle = ControllableLifecycleMonitor();
  late final FakeBroker studio;
  late final AttentionDesk desk;

  /// Launches the App over this device.
  Future<AppDriver> launch({
    FeatureViewport viewport = FeatureViewport.desktop,
    bool seed = true,
    List<Override> overrides = const [],
  }) async {
    if (seed) await f.storage.seedServer(studio);
    return f.launch(
      viewport: viewport,
      overrides: [...os.overrides(lifecycle), ...overrides],
    );
  }
}

void main() {
  group('delivery to the OS', () {
    featureTest(
      'a background outcome reaches the OS once the user opted in, by type, '
      'and the OS entry follows the event until it is read or answered',
      (f) async {
        final device = Device(f);
        final (:os, :lifecycle, :desk) = (
          os: device.os,
          lifecycle: device.lifecycle,
          desk: device.desk,
        );
        // Written before the app ever polled: history, never presented.
        desk.publish(sessionId: 's2', sessionTitle: 'Refactor build');
        final app = await device.launch();

        // The first-run card asks; opting in asks the OS once.
        expect(
          find.byKey(const Key('notification-onboarding-banner')),
          findsOneWidget,
        );
        await app.tapKey('notification-onboarding-enable');
        expect(os.permissionPrompts, 1);
        expect(
          find.byKey(const Key('notification-onboarding-banner')),
          findsNothing,
        );
        await app.pumpUntil(
          () => desk.polls >= 2,
          reason: 'the feed finished its first sync and is long polling',
        );
        expect(os.shown, isEmpty, reason: 'catch-up rows are never presented');

        lifecycle.emit(BrokerAppLifecycleState.paused);
        final finished = desk.publish(
          sessionId: 's1',
          sessionTitle: 'Fix login',
        );
        await app.pumpUntil(
          () => os.active.length == 1,
          reason: 'the finished run reaches the OS',
        );
        expect(os.active.single.title, en.notificationTypeTitleTurnFinished);
        expect(os.active.single.body, 'Fix login');
        expect(os.active.single.sound, isFalse);
        expect(os.active.single.eventId, finished['id']);

        // A request is urgent: sound, and a long title is cut at a character
        // boundary, not in the middle of a CJK glyph.
        final long = '修复登录页面在手机上无法提交表单的问题' * 4;
        final ask = desk.publish(
          kind: 'permission-required',
          sessionId: 's1',
          sessionTitle: long,
          requestId: 'req-1',
        );
        final failed = desk.publish(
          kind: 'run-failed',
          sessionId: 's2',
          sessionTitle: 'Refactor build',
        );
        await app.waitForOs(os, 3);
        final byEvent = {for (final n in os.active) n.eventId: n};
        expect(
          byEvent[ask['id']]!.title,
          en.notificationTypeTitlePermissionRequest,
        );
        expect(byEvent[ask['id']]!.sound, isTrue);
        expect(
          byEvent[ask['id']]!.body,
          '${long.characters.take(47)}…',
          reason: 'cut after 47 characters, with an ellipsis',
        );
        expect(
          byEvent[failed['id']]!.title,
          en.notificationTypeTitleTurnFailed,
        );
        // A newer outcome of the same session takes the notification's slot.
        final again = desk.publish(
          sessionId: 's1',
          sessionTitle: 'Fix login',
        );
        await app.pumpUntil(
          () => os.shown.any((n) => n.eventId == again['id']),
          reason: 'the second finish is presented',
        );
        expect(os.active.length, 3);
        expect(os.active.where((n) => n.eventId == finished['id']), isEmpty);

        // A type the user turned off never reaches the OS; its row stays in
        // the inbox. A later presented event proves it was passed over.
        await app.container
            .read(attentionNotificationTypeSettingsControllerProvider.notifier)
            .set(
              AttentionNotificationType.goalFinished,
              AttentionNotificationTypeSetting.defaultsFor(
                AttentionNotificationType.goalFinished,
              ).copyWith(enabled: false),
            );
        final goal = desk.publish(
          kind: 'goal-finished',
          sessionId: 's2',
          sessionTitle: 'Refactor build',
        );
        final sentinel = desk.publish(
          kind: 'run-failed',
          sessionId: 's1',
          sessionTitle: 'Fix login',
        );
        await app.pumpUntil(
          () => os.shown.any((n) => n.eventId == sentinel['id']),
          reason: 'the event after the muted one is presented',
        );
        expect(os.shown.where((n) => n.eventId == goal['id']), isEmpty);

        // The request is answered somewhere else: its notification goes.
        final before = os.active.length;
        desk.resolve(ask['id']! as String);
        await app.pumpUntil(
          () => os.active.every((n) => n.eventId != ask['id']),
          reason: 'an answered request leaves the OS',
        );
        expect(os.active.length, before - 1);
        // An outcome read on another device goes too.
        final elsewhere = desk.publish(
          sessionId: 's3',
          sessionTitle: 'Write the docs',
        );
        await app.pumpUntil(
          () => os.active.any((n) => n.eventId == elsewhere['id']),
          reason: 'the third session finishes',
        );
        desk.seenElsewhere(elsewhere['id']! as String);
        await app.pumpUntil(
          () => os.active.every((n) => n.eventId != elsewhere['id']),
          reason: 'an outcome seen elsewhere leaves the OS',
        );

        // The user taps what is left for s1: the app opens that session on
        // that server and reads the event.
        final tapped = os.active.firstWhere(
          (n) => n.payload['sessionId'] == 's1',
        );
        os.tap(tapped);
        await app.pumpUntil(
          () => find
              .byKey(const Key('session-detail-prompt-input'))
              .evaluate()
              .isNotEmpty,
          reason: 'a tap opens the session',
        );
        expect(device.studio.socketsFor('s1'), isNotEmpty);
        expect(device.studio.socketsFor('s2'), isEmpty);
        await app.pumpUntil(
          () => desk.acknowledged.contains(tapped.eventId),
          reason: 'the tapped event is read on the broker',
        );
        await app.pumpUntil(
          () => os.active.every((n) => n.eventId != tapped.eventId),
          reason: 'reading the event clears its notification',
        );
      },
    );
  });

  group('while the app is open', () {
    featureTest(
      'an arrival is a banner and not an OS entry, the session on screen is '
      'not announced, another server is, and a burst is one banner',
      (f) async {
        final device = Device(f);
        final (:os, :desk) = (os: device.os, desk: device.desk);
        final lab = f.network.add('http://lab.test:7734')
          ..addSession('s2', 'Lab session');
        final labDesk = AttentionDesk(lab);
        await f.storage.seedServer(lab, active: false);
        final app = await device.launch();
        await app.tapKey('notification-onboarding-enable');
        await app.pumpUntil(
          () => desk.polls >= 2 && labDesk.polls >= 2,
          reason: 'both servers are long polling',
        );

        // Foreground: a banner naming the session, nothing in the OS.
        final first = desk.publish(
          sessionId: 's2',
          sessionTitle: 'Refactor build',
        );
        await app.waitFor(app.banner);
        expect(
          find.textContaining('Refactor build'),
          findsAtLeastNWidgets(1),
        );
        expect(os.shown, isEmpty);
        // Open goes to that session, which reads its event.
        await app.tapKey('foreground-attention-open');
        await app.pumpUntil(
          () => device.studio.socketsFor('s2').isNotEmpty,
          reason: 'the banner opens the session',
        );
        expect(app.banner, findsNothing);
        await app.pumpUntil(
          () => desk.acknowledged.contains(first['id']),
          reason: 'opening the session reads its finished run',
        );

        // The session on screen is not announced; a request on it still is.
        final quiet = desk.publish(
          sessionId: 's2',
          sessionTitle: 'Refactor build',
        );
        desk.publish(
          kind: 'question-required',
          sessionId: 's2',
          sessionTitle: 'Refactor build',
          requestId: 'q1',
        );
        await app.waitFor(app.banner);
        // Reading the finished run is what looking at the session does.
        await app.pumpUntil(
          () => desk.acknowledged.contains(quiet['id']),
          reason: 'a run that finished on screen is read',
        );
        expect(
          app.tester
              .widget<Text>(find.byKey(const Key('foreground-attention-title')))
              .data,
          contains('needs input'),
          reason: 'one banner, for the request alone',
        );
        // A request that needs the user stays; Close dismisses the banner.
        await app.elapse(const Duration(seconds: 30));
        expect(app.banner, findsOneWidget);
        await app.tapKey('foreground-attention-close-button');
        expect(app.banner, findsNothing);
        expect(os.shown, isEmpty);

        // The same tool and session id on another server is a different
        // session: not suppressed, and Open switches to that server.
        labDesk.publish(sessionId: 's2', sessionTitle: 'Lab session');
        await app.waitFor(app.banner);
        expect(find.textContaining('Lab session'), findsAtLeastNWidgets(1));
        await app.tapKey('foreground-attention-open');
        await app.pumpUntil(
          () =>
              app.activeServer?.id == lab.baseUri.toString() &&
              lab.socketsFor('s2').isNotEmpty,
          reason: 'Open switches to the server the event came from',
        );

        // A reconnect burst of fifty is one aggregate banner, which an
        // informational batch lets go of after its time.
        final burst = [
          for (var i = 0; i < 50; i++)
            desk.publish(sessionId: 'x$i', sessionTitle: 'Job $i'),
        ];
        await app.waitFor(app.banner);
        expect(
          app.tester
              .widget<Text>(find.byKey(const Key('foreground-attention-title')))
              .data,
          en.foregroundAttentionAggregateTitle(50),
        );
        expect(
          app.tester
              .widget<Text>(
                find.byKey(const Key('foreground-attention-detail')),
              )
              .data,
          en.foregroundAttentionFinishedCount(50),
        );
        expect(app.banner, findsOneWidget);
        await app.elapse(const Duration(seconds: 9));
        expect(app.banner, findsNothing);
        expect(os.shown, isEmpty);

        // A change that does not move the presentation is quiet; a new
        // presentation revision is announced again.
        desk
          ..change(burst[0]['id']! as String, {'summary': 'edited'})
          ..renew(burst[1]['id']! as String);
        await app.waitFor(app.banner);
        expect(find.textContaining('Job 1'), findsAtLeastNWidgets(1));
        expect(find.textContaining('Job 0'), findsNothing);
      },
    );
  });

  group('the inbox', () {
    featureTest(
      'the inbox holds every server, counts what is unseen, and reading and '
      'dismissing reach only the server the event came from; opening the '
      "other server's row switches to it, or says it couldn't",
      (f) async {
        final device = Device(f);
        final (:desk, :studio) = (desk: device.desk, studio: device.studio);
        final lab = f.network.add('http://lab.test:7734')
          ..addSession('s2', 'Lab session');
        final labDesk = AttentionDesk(lab);
        await f.storage.seedServer(lab, active: false);
        final active = FaultyActiveServerStore(f.storage.activeServer);

        // What happened while the app was closed.
        final ask = desk.publish(
          kind: 'permission-required',
          sessionId: 's1',
          sessionTitle: 'Fix login',
          requestId: 'r1',
        );
        final older = desk.publish(
          sessionId: 's2',
          sessionTitle: 'Refactor build',
        );
        final newer = desk.publish(
          sessionId: 's2',
          sessionTitle: 'Refactor build',
        );
        final app = await device.launch(
          viewport: FeatureViewport.desktopTall,
          overrides: [
            activeBrokerProfileStoreProvider.overrideWithValue(active),
          ],
        );
        await app.tapKey('notification-onboarding-enable');
        await app.pumpUntil(
          () => desk.polls >= 2 && labDesk.polls >= 2,
          reason: 'both feeds synced once and are long polling',
        );
        // What was there before the app first polled is history: it fills
        // the inbox but is not unseen. What arrives now is.
        expect(app.badge, 0);
        device.lifecycle.emit(BrokerAppLifecycleState.paused);
        final failed = desk.publish(
          kind: 'run-failed',
          sessionId: 's3',
          sessionTitle: 'Write the docs',
        );
        final labDone = labDesk.publish(
          sessionId: 's2',
          sessionTitle: 'Lab session',
        );
        final paired = labDesk.publish(
          kind: 'device-paired',
          agent: 'cosyncing',
          title: 'Phone paired',
        );
        await app.pumpUntil(
          () => app.badge == 3,
          reason: 'the badge counts the three new arrivals across servers',
        );
        device.lifecycle.emit(BrokerAppLifecycleState.resumed);

        await app.openInbox();
        await app.waitFor(app.inboxRow(ask['id']!));
        // A session that finished twice is listed once, by its newest run;
        // the other server's session of the same id is its own row.
        expect(app.inboxRow(newer['id']!), findsOneWidget);
        expect(app.inboxRow(older['id']!), findsNothing);
        expect(app.inboxRow(labDone['id']!), findsOneWidget);
        expect(app.rowText(labDone['id']!), contains('lab.test'));
        expect(app.rowText(newer['id']!), contains('studio.test'));
        expect(app.inboxRow(failed['id']!), findsOneWidget);
        expect(app.inboxRow(paired['id']!), findsOneWidget);
        // Looking at the inbox is what clears the badge.
        await app.pumpUntil(() => app.badge == 0, reason: 'the badge clears');

        // Reading and dismissing take effect here at once. The other server
        // is down; what happened to its events waits and is posted to it
        // alone when it answers, while this server hears about its own.
        lab.reachable = false;
        expect(app.rowUnread(paired['id']!), isTrue);
        await app.tap(
          find.descendant(
            of: app.inboxRow(paired['id']!),
            matching: find.text('Mark read'),
          ),
        );
        expect(app.rowUnread(paired['id']!), isFalse);
        // The row stays where it was and says its read waits for its server.
        await app.waitFor(find.text(en.attentionSavedLocallySyncPending));
        await app.dismissRow(failed['id']!);
        await app.dismissRow(labDone['id']!);
        expect(app.inboxRow(failed['id']!), findsNothing);
        expect(app.inboxRow(labDone['id']!), findsNothing);
        // What the OS still showed for them is gone with them.
        expect(
          device.os.active.where(
            (n) => n.eventId == failed['id'] || n.eventId == labDone['id'],
          ),
          isEmpty,
        );
        expect(app.inboxRow(paired['id']!), findsOneWidget);
        await app.pumpUntil(
          () => desk.dismissedSingly.contains(failed['id']),
          every: _drainTick,
          steps: 6,
          reason: 'the studio hears of its own dismissal',
        );
        expect(desk.acknowledged, isEmpty);
        expect(labDesk.acknowledged, isEmpty);
        expect(labDesk.dismissedSingly, isEmpty);
        lab.reachable = true;
        await app.pumpUntil(
          every: _drainTick,
          steps: 6,
          () =>
              labDesk.acknowledged.contains(paired['id']) &&
              labDesk.dismissedSingly.contains(labDone['id']),
          reason: 'the other server hears of its events once it answers',
        );
        expect(desk.dismissedSingly, [failed['id']]);
        expect(desk.acknowledged, isEmpty);
        expect(labDesk.dismissedSingly, [labDone['id']]);
        expect(labDesk.acknowledged, [paired['id']]);

        // Clear activity: Undo keeps everything; letting it expire dismisses
        // exactly the revisions that were shown, and never the pending ask.
        Future<void> clearActivity() async {
          await app.tapKey('attention-activity-actions');
          await app.tapKey('attention-clear-all');
        }

        await app.waitForAbsent(find.byType(SnackBar));
        await clearActivity();
        expect(app.inboxRow(paired['id']!), findsNothing);
        await app.tap(find.text(en.inboxEnhancementUndo));
        await app.elapse(const Duration(seconds: 6));
        expect(app.inboxRow(paired['id']!), findsOneWidget);
        expect(desk.batches, isEmpty);
        expect(labDesk.batches, isEmpty);
        await clearActivity();
        await app.elapse(const Duration(seconds: 6));
        expect(app.inboxRow(paired['id']!), findsNothing);
        await app.pumpUntil(
          every: _drainTick,
          steps: 6,
          () => labDesk.batches.isNotEmpty,
          reason: 'the cleared activity is dismissed in bulk',
        );
        expect(
          [for (final (id, _) in labDesk.batches.expand((b) => b)) id],
          contains(paired['id']),
        );
        expect(app.inboxRow(paired['id']!), findsNothing);
        final cleared = [
          for (final (id, _) in desk.batches.expand((b) => b)) id,
        ];
        expect(cleared, isNot(contains(ask['id'])));
        expect(app.inboxRow(ask['id']!), findsOneWidget);

        // A row's age reads on the app's clock and moves on with it, with
        // nothing new from the broker.
        String age(Map<String, Object?> event) {
          final at = DateTime.fromMillisecondsSinceEpoch(
            event['updatedAt']! as int,
          );
          return en.sessionRosterMinutesAgo(f.now().difference(at).inMinutes);
        }

        await app.elapse(const Duration(minutes: 3));
        final threeLater = age(ask);
        expect(app.rowText(ask['id']!), contains(threeLater));
        await app.elapse(const Duration(minutes: 2));
        expect(age(ask), isNot(threeLater));
        expect(app.rowText(ask['id']!), contains(age(ask)));

        // Clear all takes requests too, one bulk dismissal per server, each
        // carrying the revision that was shown.
        final batchesBefore = desk.batches.length;
        await app.tapKey('attention-clear-inbox');
        await app.elapse(const Duration(seconds: 6));
        expect(app.inboxRow(ask['id']!), findsNothing);
        // A dismissed newest outcome stays dismissed: the older run of the
        // same session does not come back in its place.
        expect(app.inboxRow(older['id']!), findsNothing);
        expect(app.inboxRow(newer['id']!), findsNothing);
        await app.pumpUntil(
          every: _drainTick,
          steps: 6,
          () => desk.batches.length > batchesBefore,
          reason: 'Clear all dismisses the pending request',
        );
        expect(desk.batches.last, contains((ask['id']! as String, 1)));
        expect(app.inboxRow(ask['id']!), findsNothing);

        // Opening the other server's row switches to that server first. A
        // switch this device cannot save says so, as the server switcher
        // does, and opens nothing; trying again switches and opens it.
        final labAgain = labDesk.publish(
          sessionId: 's2',
          sessionTitle: 'Lab session',
        );
        await app.waitFor(app.inboxRow(labAgain['id']!));
        await app.waitForAbsent(find.byType(SnackBar));
        Finder review() => find.descendant(
          of: app.inboxRow(labAgain['id']!),
          matching: find.text(en.inboxEnhancementReview),
        );
        active.sets.failNext = true;
        await app.tap(review());
        expect(find.text(en.brokerProfileActivateFailed), findsOneWidget);
        expect(app.activeServer?.id, studio.baseUri.toString());
        expect(app.inboxRow(labAgain['id']!), findsOneWidget);
        expect(lab.socketsFor('s2'), isEmpty, reason: 'nothing was opened');
        await app.waitForAbsent(find.byType(SnackBar));
        await app.tap(review());
        await app.pumpUntil(
          () =>
              app.activeServer?.id == lab.baseUri.toString() &&
              lab.socketsFor('s2').isNotEmpty,
          reason: 'the second try switches and opens the session',
        );
      },
    );
  });

  group('the feed', () {
    featureTest(
      'a server that refuses the credential is not asked again all night, '
      'and the feed picks up again when the app returns',
      (f) async {
        final device = Device(f);
        final (:desk, :lifecycle) = (
          desk: device.desk,
          lifecycle: device.lifecycle,
        );
        desk.pollStatus = 401;
        final app = await device.launch();
        await app.pumpUntil(
          () => desk.polls >= 1,
          reason: 'the feed asked once and was refused',
        );
        final asked = desk.polls;
        await app.elapse(const Duration(minutes: 20));
        expect(
          desk.polls - asked,
          lessThanOrEqualTo(1),
          reason: 'twenty minutes of fake time, not one ask a minute',
        );
        desk.pollStatus = null;
        final arrival = desk.publish(
          sessionId: 's1',
          sessionTitle: 'Fix login',
        );
        lifecycle
          ..emit(BrokerAppLifecycleState.paused)
          ..emit(BrokerAppLifecycleState.resumed);
        await app.pumpUntil(
          () =>
              app.container.read(attentionFeedSupportProvider).isNotEmpty &&
              desk.polls > asked + 1,
          reason: 'coming back to the app asks again',
        );
        await app.openInbox();
        await app.waitFor(app.inboxRow(arrival['id']!));
      },
    );
  });

  group('inbox actions', () {
    featureTest(
      'Mark read, Dismiss and Clear all in the inbox reach the broker at '
      'once, not at the next drain',
      (f) async {
        final device = Device(f);
        final desk = device.desk;
        final done = desk.publish(sessionId: 's1', sessionTitle: 'Fix login');
        final rest = desk.publish(sessionId: 's2', sessionTitle: 'Tune it');
        final app = await device.launch();
        await app.tapKey('notification-onboarding-enable');
        await app.pumpUntil(() => desk.polls >= 2, reason: 'first sync');
        // Arriving after the first sync, it is unread activity.
        final paired = desk.publish(
          kind: 'device-paired',
          agent: 'cosyncing',
          title: 'Phone paired',
        );
        await app.openInbox();
        await app.waitFor(app.inboxRow(paired['id']!));

        await app.tap(
          find.descendant(
            of: app.inboxRow(paired['id']!),
            matching: find.text('Mark read'),
          ),
        );
        await app.pumpUntil(
          () => desk.acknowledged.contains(paired['id']),
          reason: 'the read reaches the broker without waiting for the drain',
        );
        await app.dismissRow(done['id']!);
        await app.pumpUntil(
          () => desk.dismissedSingly.contains(done['id']),
          reason:
              'the dismissal reaches the broker without waiting for the '
              'drain',
        );
        // Clear all posts once its Undo window closes.
        await app.tapKey('attention-clear-inbox');
        await app.pumpUntil(
          () => desk.batches.expand((b) => b).any((i) => i.$1 == rest['id']),
          reason: 'Clear all reaches the broker without waiting for the drain',
        );
      },
    );

    featureTest(
      'a Dismiss the server fails to take says it is saved here and will '
      'sync, as Mark read does, though the row is already gone',
      (f) async {
        final device = Device(f);
        final (:desk, :studio) = (desk: device.desk, studio: device.studio);
        final done = desk.publish(sessionId: 's1', sessionTitle: 'Fix login');
        final app = await device.launch();
        await app.tapKey('notification-onboarding-enable');
        await app.pumpUntil(() => desk.polls >= 2, reason: 'first sync');
        await app.openInbox();
        await app.waitFor(app.inboxRow(done['id']!));

        // A server that is going away answers late: the row leaves the inbox
        // at once, and only then does the dismissal fail.
        final late = studio.holdWhere(
          (request) =>
              request.method == 'POST' &&
              request.path.endsWith('/${done['id']}/dismiss'),
        );
        await app.dismissRow(done['id']!);
        await app.pumpUntil(
          () => late.arrivals == 1,
          reason: 'the dismissal is in flight',
        );
        expect(app.inboxRow(done['id']!), findsNothing);
        expect(find.text(en.attentionSavedLocallySyncPending), findsNothing);
        late.release(
          FakeBrokerResponse.error(503, 'UNAVAILABLE', 'Going away.'),
        );
        await app.waitFor(find.text(en.attentionSavedLocallySyncPending));
        expect(desk.dismissedSingly, isEmpty);

        // The dismissal was kept, and reaches the server on the next drain.
        await app.pumpUntil(
          () => desk.dismissedSingly.contains(done['id']),
          every: _drainTick,
          steps: 6,
          reason: 'the saved dismissal syncs once the server answers',
        );
        expect(app.inboxRow(done['id']!), findsNothing);
      },
    );
  });

  group('Android and Windows', () {
    featureTest(
      'a refused permission blocks delivery and is retried when granted, and '
      'a channel the user turned off in system settings stays off',
      platform: TargetPlatform.android,
      (f) async {
        final device = Device(f);
        final (:os, :lifecycle, :desk) = (
          os: device.os,
          lifecycle: device.lifecycle,
          desk: device.desk,
        );
        os
          ..managesChannels = true
          ..requestResult = const NotificationPermissionStatus(
            NotificationPermissionState.denied,
          );
        final app = await device.launch();
        // Every type is declared to the OS, localized, and the channels from
        // before per-type settings are deleted.
        await app.pumpUntil(
          () => os.declaredChannels.isNotEmpty,
          reason: 'the app declares its notification channels',
        );
        expect(
          {for (final c in os.declaredChannels) c.id},
          {for (final t in AttentionNotificationType.values) t.channelId},
        );
        expect(os.deletedChannelIds, legacyAttentionNotificationChannelIds);

        // The user opts in and the OS says no: the master switch is on, but
        // nothing can be shown.
        await app.tapKey('notification-onboarding-enable');
        expect(os.permissionPrompts, 1);
        await app.pumpUntil(
          () => desk.polls >= 2,
          reason: 'the feed is running',
        );
        lifecycle.emit(BrokerAppLifecycleState.paused);
        final ask = desk.publish(
          kind: 'permission-required',
          sessionId: 's1',
          sessionTitle: 'Fix login',
          requestId: 'r1',
        );
        await app.pumpUntil(
          () =>
              app.container
                  .read(lastAttentionNotificationDeliveryProvider)
                  ?.result
                  .outcome ==
              BrokerNotificationDeliveryOutcome.blocked,
          reason: 'the refused delivery is recorded as blocked',
        );
        expect(os.shown, isEmpty);

        // The user allows notifications in system settings and comes back:
        // the request the OS refused is presented again, on screen.
        os.permission = NotificationPermissionStatus.granted;
        lifecycle.emit(BrokerAppLifecycleState.resumed);
        await app.waitFor(app.banner);
        expect(find.textContaining('needs input'), findsAtLeastNWidgets(1));
        expect(ask['id'], isNotNull);

        // One channel switched off in Android settings: its events never
        // reach the OS, and the inbox keeps them.
        os.channels['cosy.v2.turn_failed'] = const NotificationChannelState(
          enabled: false,
          sound: true,
        );
        lifecycle.emit(BrokerAppLifecycleState.paused);
        final failed = desk.publish(
          kind: 'run-failed',
          sessionId: 's2',
          sessionTitle: 'Refactor build',
        );
        final finished = desk.publish(
          sessionId: 's3',
          sessionTitle: 'Write the docs',
        );
        await app.pumpUntil(
          () => os.shown.any((n) => n.eventId == finished['id']),
          reason: 'the next event is presented',
        );
        expect(os.shown.where((n) => n.eventId == failed['id']), isEmpty);
        lifecycle.emit(BrokerAppLifecycleState.resumed);
        await app.openInbox();
        await app.waitFor(app.inboxRow(failed['id']!));
      },
    );

    featureTest(
      'a Windows device clears the toasts an older client left, once',
      platform: TargetPlatform.windows,
      (f) async {
        final device = Device(f);
        final app = await device.launch();
        await app.pumpUntil(
          () => device.os.clearAllCount == 1,
          reason: 'the legacy toasts are cleared',
        );
        await f.restart();
        await app.settle();
        expect(device.os.clearAllCount, 1, reason: 'the migration is done');
      },
    );
  });

  group('mobile push wake', () {
    featureTest(
      'the token is registered, follows a rotation and is revoked, and a '
      'push wake fetches what the app missed',
      (f) async {
        final device = Device(f);
        final desk = device.desk;
        final wake = WakeTokenDesk(device.studio);
        final push = FakePushTokens('token-aaaa');
        final app = await f.storage
            .seedServer(device.studio)
            .then(
              (_) => f.launch(
                overrides: [
                  ...device.os.overrides(device.lifecycle),
                  ...push.overrides,
                ],
              ),
            );
        // System notifications are off; the feed still keeps the inbox.
        await app.tapKey('notification-onboarding-dismiss');
        final settings = app.container.read(
          attentionDeliverySettingsControllerProvider.notifier,
        );
        await settings.setRemoteWakeEnabled(enabled: true);
        await app.pumpUntil(
          () => wake.registrations.isNotEmpty,
          reason: 'the push token is registered with the server',
        );
        final installation = wake.history.single;
        expect(installation.platform, 'fcm');
        expect(installation.token, 'token-aaaa');
        expect(installation.label, 'studio.test');

        // A push wake is an opaque hint: the app fetches the log itself, as
        // soon as the feed's own long poll lets go of it, and counts what is
        // new.
        await app.pumpUntil(
          () => desk.polls >= 2,
          reason: 'the feed is long polling',
        );
        final fetched = desk.immediatePolls;
        push.wake();
        final arrival = desk.publish(
          sessionId: 's1',
          sessionTitle: 'Fix login',
        );
        await app.pumpUntil(
          () => desk.immediatePolls == fetched + 1 && app.badge == 1,
          reason: 'a wake fetched the log and the arrival is counted',
        );
        await app.openInbox();
        await app.waitFor(app.inboxRow(arrival['id']!));

        // The platform rotates the token: the broker learns the new one for
        // the same installation.
        push.rotate('token-bbbb');
        await app.pumpUntil(
          () => wake.history.length == 2,
          reason: 'the rotated token is registered',
        );
        expect(wake.history.last.token, 'token-bbbb');
        expect(wake.history.last.deviceId, installation.deviceId);
        expect(wake.registrations, hasLength(1));

        // Turning it off revokes the registration.
        await settings.setRemoteWakeEnabled(enabled: false);
        await app.pumpUntil(
          () => wake.revoked.contains(installation.deviceId),
          reason: 'turning wake off revokes the registration',
        );
        expect(wake.registrations, isEmpty);
      },
    );
  });
}
