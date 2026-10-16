// F05 — Opening a session: what the page says before, while and after the
// broker answers, through the real App and a fake broker socket.
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/app/router/app_routes.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_identity_store.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/app_driver.dart';
import '../support/feature/cosyncing_app.dart';
import '../support/feature/fake_broker.dart';
import '../support/feature/roster_driver.dart';
import '../support/feature/session_driver.dart';
import '../support/feature/session_wire.dart';

final AppLocalizations en = lookupAppLocalizations(const Locale('en'));
final AppLocalizations zh = lookupAppLocalizations(const Locale('zh'));

const cwd = '/work/studio';

/// A broker whose session sockets say hello and then nothing, until the test
/// finishes the attach by hand: a slow adapter.
class SlowAttach {
  SlowAttach(this.broker) {
    broker.attachFrames = (socket, row) {
      sockets.add(socket);
      return [broker.helloFrame()];
    };
  }

  final FakeBroker broker;

  /// Sockets that opened and are waiting for the rest of the attach.
  final List<FakeBrokerSocket> sockets = [];

  /// The broker's session frame for [socket].
  void sendSession(
    FakeBrokerSocket socket, {
    Map<String, Object?>? control,
    Map<String, Object?> fields = const {},
  }) {
    final row = socket.session ?? {'id': socket.attachTarget!.$2};
    socket.emit({
      'kind': 'session',
      'info': {
        ...row,
        'control': control ?? FakeBroker.drivingControl,
        ...fields,
      },
    });
  }

  /// The broker's durable history for [socket].
  void sendHistory(
    FakeBrokerSocket socket, [
    List<Map<String, Object?>> messages = const [],
  ]) => socket.emit({
    'kind': 'history',
    'messages': messages,
    'cursor': 'cursor-1',
  });
}

FakeBroker studioWith(FeatureContext f, {String id = 's1'}) =>
    f.network.add('http://studio.test:7734')..addSession(id, 'Fix login');

/// The session header names the session in its information control.
Finder headerTitle(String text) => find.descendant(
  of: find.byKey(const Key('session-detail-top-strip')),
  matching: find.byWidgetPredicate(
    (w) => w is Tooltip && (w.message?.endsWith('\n$text') ?? false),
  ),
);

void main() {
  group('the first frame', () {
    featureTest(
      'a session opened from the roster is named at once, never by its id, '
      'and the page says it is loading until history arrives',
      (f) async {
        final studio = studioWith(f);
        final slow = SlowAttach(studio);
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.openFromRoster('s1', cwd: cwd);

        expect(find.text('Fix login'), findsWidgets);
        expect(headerTitle('Fix login'), findsOneWidget);
        expect(find.text('s1'), findsNothing);
        expect(
          find.text(en.sessionDetailBootstrapLoadingTitle),
          findsOneWidget,
        );
        expect(find.text(en.sessionDetailBootstrapLoadingBody), findsOneWidget);
        expect(
          find.text(en.sessionDetailTranscriptEmpty),
          findsNothing,
          reason: 'not empty: nothing has been said yet',
        );

        final socket = slow.sockets.single;
        slow
          ..sendSession(socket)
          ..sendHistory(socket, [modelOutput('Fixed it.')]);
        await app.settle();
        expect(find.text('Fixed it.'), findsOneWidget);
        expect(find.text(en.sessionDetailBootstrapLoadingTitle), findsNothing);
      },
    );

    featureTest(
      'a session reached only by its link is named "Opening session" in the '
      "user's language until the broker names it, and an untitled session "
      'is "Untitled", never the id',
      (f) async {
        await f.storage.preferences.setLocaleTag('zh');
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('ses_deep_link_01', '');
        final slow = SlowAttach(studio);
        await f.storage.seedServer(studio);
        final app = await f.launch(
          initialLocation: '/sessions/codex/ses_deep_link_01',
        );
        expect(headerTitle(zh.sessionDetailTitleOpening), findsOneWidget);
        expect(find.text('ses_deep_link_01'), findsNothing);

        final socket = slow.sockets.single;
        slow.sendSession(socket, fields: {'title': 'Named by the broker'});
        await app.settle();
        expect(headerTitle('Named by the broker'), findsOneWidget);

        slow.sendSession(socket, fields: {'title': ''});
        await app.settle();
        expect(
          headerTitle(zh.sessionDetailTitleUntitled),
          findsOneWidget,
          reason: 'an authoritative empty title retires the stale one',
        );
        expect(find.text('ses_deep_link_01'), findsNothing);
      },
    );

    featureTest(
      'the page claims an empty session only after the broker said the '
      'history is empty',
      (f) async {
        final studio = studioWith(f);
        final slow = SlowAttach(studio);
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.openFromRoster('s1', cwd: cwd);

        final socket = slow.sockets.single;
        slow.sendSession(socket);
        await app.settle();
        expect(find.text(en.sessionDetailTranscriptEmpty), findsNothing);
        expect(
          find.text(en.sessionDetailBootstrapLoadingTitle),
          findsOneWidget,
        );

        slow.sendHistory(socket);
        await app.settle();
        expect(find.text(en.sessionDetailTranscriptEmpty), findsOneWidget);
      },
    );
  });

  group('when the broker is slow or refuses', () {
    featureTest(
      'a session that never answers fails at the deadline in plain words, '
      'Retry attaches once while it is in flight, and a recovered broker '
      'loads the session',
      (f) async {
        final studio = studioWith(f);
        final slow = SlowAttach(studio);
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.openFromRoster('s1', cwd: cwd);
        expect(
          find.text(en.sessionDetailBootstrapLoadingTitle),
          findsOneWidget,
        );

        await app.pumpUntil(
          () => find
              .text(en.sessionDetailBootstrapFailureTitle)
              .evaluate()
              .isNotEmpty,
          reason: 'the attach deadline passes',
          every: const Duration(seconds: 1),
        );
        app.expectNoRawErrorLeak();
        expect(
          find.byKey(const Key('session-detail-bootstrap-retry')),
          findsOneWidget,
        );

        final attempts = slow.sockets.length;
        final retry = find.byKey(const Key('session-detail-bootstrap-retry'));
        await app.tester.tap(retry);
        await app.tester.tap(retry, warnIfMissed: false);
        await app.settle();
        expect(
          slow.sockets.length,
          attempts + 1,
          reason:
              'a second press while the retry is in flight attaches nothing',
        );

        final socket = slow.sockets.last;
        slow
          ..sendSession(socket)
          ..sendHistory(socket, [modelOutput('Back again.')]);
        await app.settle();
        expect(find.text('Back again.'), findsOneWidget);
        expect(find.text(en.sessionDetailBootstrapFailureTitle), findsNothing);
      },
    );

    featureTest(
      'a session that answers but never sends its history says the history '
      'is taking too long, and Retry starts a fresh attempt',
      (f) async {
        final studio = studioWith(f);
        final slow = SlowAttach(studio);
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.openFromRoster('s1', cwd: cwd);
        slow.sendSession(slow.sockets.single);

        await app.pumpUntil(
          () => find
              .text(en.sessionDetailBootstrapTimeoutTitle)
              .evaluate()
              .isNotEmpty,
          reason: 'the history deadline passes',
          every: const Duration(seconds: 1),
        );
        expect(find.text(en.sessionDetailBootstrapTimeoutBody), findsOneWidget);
        expect(find.text(en.sessionDetailBootstrapFailureTitle), findsNothing);

        await app.tapKey('session-detail-bootstrap-retry');
        expect(slow.sockets, hasLength(2), reason: 'a fresh attach');
        final socket = slow.sockets.last;
        slow
          ..sendSession(socket)
          ..sendHistory(socket, [modelOutput('History at last.')]);
        await app.settle();
        expect(find.text('History at last.'), findsOneWidget);
      },
    );

    featureTest(
      'a broker that refuses the attach fails the page once and keeps '
      'failing: the history deadline does not turn it into a timeout, and '
      'nothing retries on its own',
      (f) async {
        final studio = studioWith(f);
        final slow = SlowAttach(studio);
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.openFromRoster('s1', cwd: cwd);
        slow.sockets.single.emit({
          'kind': 'error',
          'message': 'This session is not available.',
        });
        await app.settle();
        expect(
          find.text(en.sessionDetailBootstrapFailureTitle),
          findsOneWidget,
        );

        await app.elapse(const Duration(seconds: 40));
        expect(
          find.text(en.sessionDetailBootstrapFailureTitle),
          findsOneWidget,
        );
        expect(find.text(en.sessionDetailBootstrapTimeoutTitle), findsNothing);
        expect(slow.sockets, hasLength(1), reason: 'no silent retry loop');
      },
    );

    featureTest(
      'a stream the broker will not open fails in plain words with the raw '
      'error out of sight, and Retry loads the session once it can',
      (f) async {
        final studio = studioWith(f);
        studio.transcripts['s1'] = [modelOutput('Worth waiting for.')];
        await f.storage.seedServer(studio);
        final app = await f.launch();
        studio.socketsAccepted = false;
        await app.openFromRoster('s1', cwd: cwd);
        await app.pumpUntil(
          () => find
              .text(en.sessionDetailBootstrapFailureTitle)
              .evaluate()
              .isNotEmpty,
          reason: 'the refused stream fails the page',
          every: const Duration(seconds: 1),
        );
        app.expectNoRawErrorLeak();

        studio.socketsAccepted = true;
        await app.tapKey('session-detail-bootstrap-retry');
        expect(find.text('Worth waiting for.'), findsOneWidget);
      },
    );
  });

  group('what the app already knows', () {
    featureTest(
      'a saved transcript stays readable while the session reconnects, and '
      'the live history replaces it without a duplicate',
      (f) async {
        final studio = studioWith(f);
        studio.transcripts['s1'] = [modelOutput('Said yesterday.', id: 'm1')];
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.openFromRoster('s1', cwd: cwd);
        expect(find.text('Said yesterday.'), findsOneWidget);
        // Let the transcript reach the device cache.
        await app.elapse(const Duration(seconds: 2));

        studio.socketsAccepted = false;
        final again = await f.restart();
        expect(find.text('Said yesterday.'), findsOneWidget);
        expect(
          find.text(en.sessionDetailBootstrapLoadingTitle),
          findsNothing,
          reason: 'saved messages are shown, not a blocking spinner',
        );
        expect(
          find.text(en.sessionDetailBootstrapCachedWaiting),
          findsOneWidget,
        );

        studio.socketsAccepted = true;
        studio.transcripts['s1'] = [
          modelOutput('Said yesterday.', id: 'm1'),
          modelOutput('Said just now.', id: 'm2'),
        ];
        await again.pumpUntil(
          () => find.text('Said just now.').evaluate().isNotEmpty,
          reason: 'the session reconnects and replays its history',
          every: const Duration(seconds: 1),
        );
        expect(find.text('Said yesterday.'), findsOneWidget);
      },
    );
  });

  group('credentials and identity', () {
    featureTest(
      'a token the broker stopped accepting is replaced at the gate and the '
      'open session comes back on exactly one socket carrying the new token',
      (f) async {
        final studio = f.network.add(
          'http://studio.test:7734',
          ownerToken: 'tok-1',
        )..addSession('s1', 'Fix login');
        await f.storage.seedServer(studio, ownerToken: 'tok-1');
        final app = await f.launch();
        await app.openFromRoster('s1', cwd: cwd);
        expect(studio.socketsFor('s1').single.credential, 'tok-1');

        // The broker's token is rotated while the app is closed.
        studio.ownerToken = 'tok-2';
        final before = studio.socketsFor('s1').length;
        final again = await f.restart();
        expect(
          find.byKey(const Key('broker-gate-token-field')),
          findsOneWidget,
          reason:
              'the stored token no longer works: the gate asks for a new one',
        );
        expect(
          studio.socketsFor('s1'),
          hasLength(before),
          reason: 'the open session did not attach anonymously behind the gate',
        );
        await again.saveGateToken('tok-2');
        await again.pumpUntil(
          () => studio.socketsFor('s1').length > before,
          reason: 'the session attaches again',
          every: const Duration(seconds: 1),
        );
        await again.settle();
        final sockets = studio.socketsFor('s1');
        expect(
          sockets.skip(before).map((s) => s.credential),
          everyElement('tok-2'),
          reason: 'no socket after the save is anonymous or uses the old token',
        );
        expect(
          [
            for (final s in sockets.skip(before))
              if (s.isConnected) s,
          ],
          hasLength(1),
          reason: 'one live stream',
        );
      },
    );

    featureTest(
      'a token rotated while the app is open is noticed at the next refused '
      'call: the sign-in gate appears once, without a relaunch, and the new '
      'token brings the roster and the open session back',
      (f) async {
        final studio = f.network.add(
          'http://studio.test:7734',
          ownerToken: 'tok-1',
        )..addSession('s1', 'Fix login');
        await f.storage.seedServer(studio, ownerToken: 'tok-1');
        final app = await f.launch();
        await app.openFromRoster('s1', cwd: cwd);
        expect(studio.socketsFor('s1').single.credential, 'tok-1');
        final barrier = find.byKey(const Key('broker-auth-barrier'));
        expect(barrier, findsNothing);
        final probes = studio.requestsTo('/api/broker/health').length;

        // The broker's token is rotated while the app runs.
        studio.ownerToken = 'tok-2';
        await app.pumpUntil(
          () => barrier.evaluate().isNotEmpty,
          reason: 'a refused call brings up the sign-in gate',
          every: const Duration(seconds: 1),
        );
        expect(
          find.byKey(const Key('broker-gate-credential-rejected')),
          findsOneWidget,
          reason:
              'the same gate a launch shows for a token that stopped '
              'working',
        );
        expect(
          studio.requestsTo('/api/broker/health'),
          hasLength(probes + 1),
          reason: 'one probe confirmed the refusal',
        );

        // Refused calls go on behind the gate; none of them probes again.
        await app.elapse(const Duration(minutes: 3));
        expect(studio.requestsTo('/api/broker/health'), hasLength(probes + 1));
        expect(barrier, findsOneWidget);

        final sockets = studio.socketsFor('s1').length;
        await app.saveGateToken('tok-2');
        await app.waitForAbsent(barrier);
        await app.pumpUntil(
          () => studio.requests.any(
            (r) => r.path == '/api/sessions' && r.ownerToken == 'tok-2',
          ),
          reason: 'the roster asks again with the new token',
          every: const Duration(seconds: 1),
        );
        await app.pumpUntil(
          () => studio
              .socketsFor('s1')
              .skip(sockets)
              .any((s) => s.isConnected && s.credential == 'tok-2'),
          reason: 'the open session comes back with the new token',
          every: const Duration(seconds: 1),
        );

        // A route that refuses on its own while the token still works costs
        // one probe, never one per refusal.
        const deltas = '/api/session-roster-deltas';
        final checks = studio.requestsTo('/api/broker/health').length;
        final polls = studio.requestsTo(deltas).length;
        studio
          ..deltaFeedStatus = 401
          ..updateSession('s1', {'title': 'Fix login (renamed)'});
        await app.elapse(const Duration(minutes: 2));
        expect(
          studio.requestsTo(deltas).length - polls,
          greaterThan(5),
          reason: 'the roster feed kept retrying the refused route',
        );
        expect(studio.requestsTo('/api/broker/health'), hasLength(checks + 1));
        expect(barrier, findsNothing);
      },
    );

    featureTest(
      'a token saved in Settings while a session is open on an anonymous '
      'socket replaces that socket with one that carries the token',
      (f) async {
        final studio = studioWith(f);
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.openFromRoster('s1', cwd: cwd);
        expect(studio.socketsFor('s1').single.credential, isNull);

        await app.go(brokerDevicesSettingsRoute);
        await app.enterText(
          find.byKey(const Key('settings-broker-token-field')),
          'fresh-token',
        );
        await app.tapKey('settings-save-token');
        await app.pumpUntil(
          () => studio.socketsFor('s1').length == 2,
          reason: 'the credential save replaces the session socket',
        );
        final [anonymous, authenticated] = studio.socketsFor('s1');
        expect(anonymous.isConnected, isFalse);
        expect(authenticated.credential, 'fresh-token');
        expect(authenticated.isConnected, isTrue);
        await app.go(sessionsRoute);
        expect(
          studio.socketsFor('s1'),
          hasLength(2),
          reason: 'coming back adds no further attach',
        );
      },
    );

    featureTest(
      "each server's negotiated identity is remembered under that server "
      "alone: opening a session on one never writes, or shows, another's",
      (f) async {
        final studio = studioWith(f);
        final lab = f.network.add('http://lab.test:7734', machine: 'lab')
          ..addSession('l1', 'Lab run');
        lab.attachFrames = (socket, row) => [
          helloWith(lab, version: '0.9.1'),
          {
            'kind': 'session',
            'info': {...row, 'control': FakeBroker.drivingControl},
          },
          {'kind': 'history', 'messages': const <Object?>[], 'cursor': 'c1'},
        ];
        final studioProfile = await f.storage.seedServer(studio);
        final labProfile = await f.storage.seedServer(lab, active: false);
        final store = DriftBrokerIdentityStore(f.storage.database);
        String keyOf(BrokerProfile? profile) =>
            RosterSource.of(profile)!.storageKey;

        final app = await f.launch();
        await app.openFromRoster('s1', cwd: cwd);
        expect(
          (await store.readHello(keyOf(studioProfile)))?.brokerVersion,
          '0.7.0',
        );
        expect(
          await store.readHello(keyOf(labProfile)),
          isNull,
          reason: 'lab has not been opened: nothing is known about it',
        );

        await app.switchServer(labProfile.id);
        await app.openFromRoster('l1', cwd: '/work/lab');
        expect(
          (await store.readHello(keyOf(labProfile)))?.brokerVersion,
          '0.9.1',
        );
        expect(
          (await store.readHello(keyOf(studioProfile)))?.brokerVersion,
          '0.7.0',
          reason: "lab's hello did not overwrite studio's",
        );
      },
    );

    featureTest(
      'a broker that declares the pair read-only attaches the session for '
      'reading only: the page says so, nothing can be sent, and the decision '
      'is remembered for that server',
      (f) async {
        final studio = studioWith(f);
        studio.attachFrames = (socket, row) => [
          helloWith(
            studio,
            status: 'hard-incompatible',
            readOnly: true,
            reason: 'revision mismatch',
          ),
          {
            'kind': 'session',
            'info': {...row, 'control': FakeBroker.drivingControl},
          },
          {'kind': 'history', 'messages': const <Object?>[], 'cursor': 'c1'},
        ];
        final profile = await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.openFromRoster('s1', cwd: cwd);

        await app.send('can anyone hear me');
        expect(app.framesSent(studio, 'prompt'), isEmpty);
        await app.openStatus();
        expect(
          find.text(en.sessionCompatibilityHardIncompatible),
          findsWidgets,
        );

        final hello = await DriftBrokerIdentityStore(
          f.storage.database,
        ).readHello(RosterSource.of(profile)!.storageKey);
        expect(
          hello?.compatibility.status,
          BrokerClientCompatibilityStatus.hardIncompatible,
        );
        expect(hello?.compatibility.readOnly, isTrue);
      },
    );
  });

  group('renaming from the session', () {
    Future<void> rename(AppDriver app, String title) async {
      await app.tapKey('session-detail-information');
      await app.tap(find.byKey(const Key('session-detail-wide-title')));
      await app.enterText(
        find.byKey(const Key('session-detail-rename-input')),
        title,
      );
      await app.tester.testTextInput.receiveAction(TextInputAction.done);
      await app.settle();
      await app.dismissModal();
    }

    featureTest(
      'renaming from the session sends the new title and the header, tab '
      'and roster all show it',
      (f) async {
        final studio = studioWith(f)
          ..agents = [fakeAgent(canRenameNative: true)];
        final app = await openSession(f, studio);
        await rename(app, 'Fix the login bug');

        final request = studio
            .requestsTo('/api/sessions/codex/s1/rename', method: 'PATCH')
            .single;
        expect(request.body, {'title': 'Fix the login bug'});
        expect(headerTitle('Fix the login bug'), findsOneWidget);
        expect(app.tabLabel('s1'), 'Fix the login bug');
      },
    );

    featureTest(
      'a rename still in flight when the user switches server is not '
      "applied to the other server's session of the same id [REG]",
      (f) async {
        final studio = studioWith(f)
          ..agents = [fakeAgent(canRenameNative: true)];
        final lab = f.network.add('http://lab.test:7734', machine: 'lab')
          ..addSession('s1', 'Lab original')
          ..agents = [fakeAgent(canRenameNative: true)];
        await f.storage.seedServer(lab, active: false);
        final app = await openSession(f, studio);
        final held = studio.hold('PATCH', '/api/sessions/codex/s1/rename');
        await rename(app, 'Studio rename');
        expect(held.pending, 1);

        await app.switchServer('http://lab.test:7734');
        held.release();
        await app.elapse(const Duration(seconds: 20));
        expect(
          lab.requestsTo('/api/sessions/codex/s1/rename', method: 'PATCH'),
          isEmpty,
        );
        expect(find.text('Studio rename'), findsNothing);
        await app.openFromRoster('s1', cwd: '/work/lab');
        expect(headerTitle('Lab original'), findsOneWidget);
      },
    );
  });

  group('a server that moves to another machine', () {
    featureTest(
      "editing a saved server's address keeps its open tab but leaves the "
      "old machine's session behind: its stream is closed, the new machine "
      'shows only its own session, and a prompt that was waiting for the old '
      'one never reaches it [REG]',
      (f) async {
        final old = f.network.add('http://old.test:7734', machine: 'old')
          ..addSession('s1', 'Old machine');
        final fresh = f.network.add('http://new.test:7734', machine: 'new')
          ..addSession('s1', 'New machine');
        fresh.transcripts['s1'] = [modelOutput('From the new machine.')];
        final profile = await f.storage.seedServer(old);
        final app = await f.launch();
        await app.openFromRoster('s1', cwd: '/work/old');
        expect(old.socketsFor('s1').single.isConnected, isTrue);

        // The old machine goes quiet and a prompt is typed into the void.
        old.socketsAccepted = false;
        old.socketsFor('s1').single.drop();
        await app.settle();
        await app.send('queued for the old machine');
        expect(
          find.text('queued for the old machine'),
          findsWidgets,
          reason: 'the prompt is held on screen, waiting for the old machine',
        );

        await app.go(brokerProfilesRoute);
        await app.editSavedServer(profile.id, address: 'http://new.test:7734');
        await app.go(sessionsRoute);
        await app.pumpUntil(
          () => app.openTabKeys.contains('codex/s1'),
          reason: 'the tab belongs to the saved server, not to its address',
        );
        expect(app.openTabKeys, ['codex/s1']);
        expect(
          [for (final s in old.socketsFor('s1')) s.isConnected],
          everyElement(isFalse),
        );

        await app.openFromRoster('s1', cwd: '/work/new');
        expect(headerTitle('New machine'), findsOneWidget);
        expect(find.text('From the new machine.'), findsOneWidget);
        await app.elapse(const Duration(seconds: 30));
        expect(find.text('queued for the old machine'), findsNothing);
        expect(
          app.framesSent(fresh, 'prompt'),
          isEmpty,
          reason: 'a prompt typed for the old machine is never replayed',
        );
        expect(app.framesSent(old, 'prompt'), isEmpty);
      },
    );
  });
}
