// F05 — Who controls a session, through the real App: the ownership pill,
// Take over, hand back, Drive restore, detach and reconnect.
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/cosyncing_app.dart';
import '../support/feature/fake_broker.dart';
import '../support/feature/roster_driver.dart';
import '../support/feature/session_driver.dart';
import '../support/feature/session_wire.dart';

final AppLocalizations en = lookupAppLocalizations(const Locale('en'));
final AppLocalizations zh = lookupAppLocalizations(const Locale('zh'));

const cwd = '/work/studio';

/// A saved server with one Codex session, [id], the roster knows as [mode].
FakeBroker studioWith(
  FeatureContext f, {
  String id = 's1',
  AttachMode mode = AttachMode.live,
}) =>
    f.network.add('http://studio.test:7734')
      ..addSession(id, 'Fix login', attachMode: mode);

/// Where the app says a takeover was refused (a snack bar, and the Observe
/// bar where there is room for its sentence).
Finder refusalNote(String text) => find.text(text);

void main() {
  group('who owns the session', () {
    featureTest(
      'the header pill says the one ownership fact the broker published, '
      'and only a session the app can drive has a live composer',
      (f) async {
        // pill, takeover offered, composer read-only
        final rows = <String, (Map<String, Object?>, String, bool, bool)>{
          'drive': (controlBlock(), 'driving', false, false),
          'observe': (
            controlBlock(
              drive: driveBlock('observing'),
              terminalSync: syncBlock(supported: false),
            ),
            'observing',
            true,
            true,
          ),
          'synced': (
            controlBlock(
              drive: driveBlock('observing', supported: false),
              terminalSync: syncBlock(active: true, presence: 'shared'),
            ),
            'synced',
            false,
            false,
          ),
          // Sync outranks Drive: app and terminal are co-clients of one owner.
          'both': (
            controlBlock(
              drive: driveBlock('driving'),
              terminalSync: syncBlock(active: true, presence: 'shared'),
            ),
            'synced',
            false,
            false,
          ),
          'join': (
            controlBlock(
              drive: driveBlock('observing'),
              terminalSync: syncBlock(
                syncAvailable: true,
                action: 'join',
                command: 'codex resume --remote sock t1',
              ),
            ),
            'syncAvailable',
            true,
            true,
          ),
          // A foreign session the operator may still take over reads as
          // Observing, never as untakeable [REG].
          'foreign': (
            controlBlock(
              drive: driveBlock(
                'observing',
                supported: false,
                takeoverAvailable: true,
                takeoverMode: 'live',
              ),
              terminalSync: syncBlock(supported: false),
            ),
            'observing',
            true,
            true,
          ),
          'neither': (
            controlBlock(
              drive: driveBlock('unavailable', supported: false),
              terminalSync: syncBlock(supported: false),
            ),
            'unavailable',
            false,
            true,
          ),
        };
        final studio = f.network.add('http://studio.test:7734');
        for (final id in rows.keys) {
          studio
            ..addSession(id, id)
            ..controls[id] = rows[id]!.$1;
        }
        await f.storage.seedServer(studio);
        final app = await f.launch();

        var first = true;
        for (final MapEntry(:key, :value) in rows.entries) {
          await app.openFromRoster(key, cwd: first ? cwd : null);
          first = false;
          final (_, pill, takeOver, readOnly) = value;
          expect(app.pill, pill, reason: '$key: pill');
          expect(
            find.byKey(const Key('session-detail-composer-take-over-button')),
            takeOver ? findsOneWidget : findsNothing,
            reason: '$key: Take over offered',
          );
          expect(app.composerIsReadOnly, readOnly, reason: '$key: composer');
        }
      },
    );

    featureTest(
      'a synced session that accepts answers only is still Synced, but '
      'never claims the composer is live',
      (f) async {
        final studio = studioWith(f);
        studio.controls['s1'] = controlBlock(
          drive: driveBlock('observing', supported: false),
          terminalSync: syncBlock(
            active: true,
            presence: 'shared',
            input: 'answer-only',
          ),
        );
        final app = await openSession(f, studio);
        expect(app.pill, 'synced');
        await app.openStatus();
        expect(find.text(en.sessionControlAnswersOnly), findsWidgets);
        expect(find.text(en.sessionControlSyncedDescription), findsNothing);
      },
    );
  });

  group('take over', () {
    featureTest(
      'Take over asks first; Cancel changes nothing, Confirm re-attaches '
      'asking for Drive and the session becomes Driving',
      (f) async {
        final studio = studioWith(f, mode: AttachMode.resume);
        final owned = OwnedSession(studio, 's1');
        final app = await openSession(f, studio);
        expect(app.pill, 'observing');
        expect(owned.attaches, hasLength(1));

        await app.takeOver(confirm: false);
        expect(owned.attaches, hasLength(1), reason: 'Cancel attaches nothing');
        expect(app.pill, 'observing');

        await app.takeOver();
        expect(owned.attaches, hasLength(2));
        expect(owned.lastAttach['mode'], 'resume');
        expect(owned.lastAttach['reason'], 'takeover');
        expect(
          owned.lastAttach['ticket'],
          isNotNull,
          reason: 'the history position is kept across the re-attach',
        );
        expect(app.pill, 'driving');
        expect(app.composerIsReadOnly, isFalse);

        await app.send('ship it');
        expect(app.framesSent(studio, 'prompt').single['text'], 'ship it');
      },
    );

    featureTest(
      'a broker that declares live takeover is attached live, not resume',
      (f) async {
        final studio = studioWith(f);
        final owned = OwnedSession(studio, 's1', takeoverMode: 'live');
        final app = await openSession(f, studio);
        await app.takeOver();
        expect(owned.lastAttach['mode'], 'live');
        expect(owned.lastAttach['reason'], 'takeover');
        expect(app.pill, 'driving');
      },
    );

    featureTest(
      '"Don\'t warn me again" skips the confirmation from then on, also '
      'after a restart',
      (f) async {
        final studio = studioWith(f)..addSession('s2', 'Tidy styles');
        final owned = OwnedSession(studio, 's1', alsoIds: ['s2']);
        final app = await openSession(f, studio);
        await app.tapKey('session-detail-composer-take-over-button');
        await app.tapKey('session-detail-take-over-never-warn');
        await app.tapKey('session-detail-take-over-confirm');
        expect(app.pill, 'driving');

        final again = await f.restart();
        await again.openFromRoster('s2', cwd: cwd);
        expect(again.pill, 'observing');
        await again.tapKey('session-detail-composer-take-over-button');
        expect(
          find.byKey(const Key('session-detail-take-over-dialog')),
          findsNothing,
        );
        expect(again.pill, 'driving');
        expect(owned.drives('s2'), isTrue);
      },
    );

    featureTest(
      'a refused takeover leaves the session Observing and says why in the '
      "user's language; a later reconnect never asks for Drive again",
      (f) async {
        final studio = studioWith(f);
        final owned = OwnedSession(studio, 's1')
          ..refuseWith = 'DRIVE_OWNERSHIP_CONFLICT';
        final app = await openSession(f, studio);
        await app.takeOver();

        expect(app.pill, 'observing');
        expect(app.composerIsReadOnly, isTrue);
        expect(
          refusalNote(en.sessionDriveTakeoverOwnershipConflictNote),
          findsWidgets,
        );

        // The stream drops and comes back on its own: Observe, no Drive ask.
        studio.socketsFor('s1').last.drop();
        await app.pumpUntil(
          () => owned.attaches.length >= 3,
          reason: 'the dropped stream reconnects',
          every: const Duration(seconds: 1),
        );
        expect(
          owned.attaches.skip(2).every((a) => a['reason'] == null),
          isTrue,
          reason: 'an explicit authority request is never silently retried',
        );
        expect(app.pill, 'observing');
      },
    );

    for (final (code, enNote, zhNote) in [
      (
        'DRIVE_OWNERSHIP_UNKNOWN',
        en.sessionDriveTakeoverOwnershipUnknownNote,
        zh.sessionDriveTakeoverOwnershipUnknownNote,
      ),
      (
        'DRIVE_NATIVE_SESSION_UNRESUMABLE',
        en.sessionDriveNativeTakeoverUnresumableNote,
        zh.sessionDriveNativeTakeoverUnresumableNote,
      ),
      (
        'DRIVE_RESTORE_FAILED',
        en.sessionDriveTakeoverFailureNote,
        zh.sessionDriveTakeoverFailureNote,
      ),
    ]) {
      for (final (locale, note) in [('en', enNote), ('zh', zhNote)]) {
        featureTest(
          'a takeover refused with $code says so in plain $locale, never '
          'the raw code',
          (f) async {
            await f.storage.preferences.setLocaleTag(locale);
            final studio = studioWith(f);
            OwnedSession(studio, 's1').refuseWith = code;
            final app = await openSession(f, studio);
            await app.takeOver();
            expect(refusalNote(note), findsWidgets);
            expect(app.visibleText, isNot(contains(code)));
            expect(app.pill, 'observing');
          },
        );
      }
    }
  });

  group('a takeover that never gets an answer', () {
    featureTest(
      'is declared unconfirmed after the deadline, the socket falls back to '
      'Observe, and a late Drive grant on the abandoned socket changes '
      'nothing [REG delayed-Driving]',
      (f) async {
        final studio = studioWith(f);
        final owned = OwnedSession(studio, 's1');
        final app = await openSession(f, studio);
        owned.stall = true;
        await app.takeOver();
        final stalled = studio.socketsFor('s1').last;
        expect(owned.lastAttach['reason'], 'takeover');
        expect(app.pill, isNot('driving'), reason: 'nothing was granted yet');

        await app.pumpUntil(
          () => find
              .text(en.sessionDriveTakeoverTimeoutNote)
              .evaluate()
              .isNotEmpty,
          reason: 'the takeover is declared unconfirmed',
          every: const Duration(seconds: 1),
        );
        expect(app.pill, 'observing');
        expect(
          studio.socketsFor('s1').last.attachParams['reason'],
          isNull,
          reason: 'the armed socket is replaced by a bare Observe attach',
        );
        expect(stalled.closedByApp, isTrue);

        // The broker finally grants Drive on the socket the app abandoned.
        owned.appDrives = true;
        stalled.emit(owned.sessionFrame(studio.sessions.single));
        await app.settle();
        expect(app.pill, 'observing');
        expect(app.composerIsReadOnly, isTrue);
      },
    );
  });

  group('handing control back', () {
    featureTest(
      'copying the resume command hands the session to the terminal: the '
      'broker confirms, the pill reads Observing, and a restart does not '
      'restore Drive',
      (f) async {
        final studio = studioWith(f);
        final owned = OwnedSession(
          studio,
          's1',
          drivingTerminalSync: syncBlock(
            presence: 'unknown',
            action: 'handoff',
            command: 'codex resume --remote sock t1',
          ),
        );
        await f.storage.seedServer(studio);
        final app = await f.launch();
        final clipboard = app.captureClipboard();
        await app.openFromRoster('s1', cwd: cwd);
        await app.takeOver();
        expect(app.pill, 'driving');

        await app.openStatus();
        await app.tapKey('session-detail-status-copy-command');
        expect(clipboard, ['codex resume --remote sock t1']);
        expect(app.framesSent(studio, 'handoff'), hasLength(1));
        expect(app.pill, 'observing');
        expect(owned.appDrives, isFalse);
        await app.dismissModal();
        expect(app.composerIsReadOnly, isTrue);

        final again = await f.restart();
        await again.openFromRoster('s1', cwd: cwd);
        expect(
          owned.lastAttach['reason'],
          isNull,
          reason: "handing control back ends the app's claim on the session",
        );
      },
    );

    featureTest(
      'a refused handoff keeps the session Driving and says it was not '
      'confirmed',
      (f) async {
        final studio = studioWith(f);
        OwnedSession(
          studio,
          's1',
          drivingTerminalSync: syncBlock(
            presence: 'unknown',
            action: 'handoff',
            command: 'codex resume --remote sock t1',
          ),
        ).refuseHandoff = true;
        final app = await openSession(f, studio);
        app.captureClipboard();
        await app.takeOver();
        await app.openStatus();
        await app.tapKey('session-detail-status-copy-command');
        expect(app.framesSent(studio, 'handoff'), hasLength(1));
        expect(app.pill, 'driving');
        expect(find.text(en.sessionCommandCopiedHandoffFailed), findsWidgets);
      },
    );

    featureTest(
      'an Observing session shows its resume command for the terminal, and '
      'copying it asks the broker for nothing [REG]',
      (f) async {
        final studio = studioWith(f);
        studio.controls['s1'] = controlBlock(
          drive: driveBlock('observing'),
          terminalSync: syncBlock(
            supported: false,
            action: 'handoff',
            command: 'cd /work && claude --resume abc-123',
          ),
        );
        final app = await openSession(f, studio);
        final clipboard = app.captureClipboard();
        await app.openStatus();
        expect(find.text('cd /work && claude --resume abc-123'), findsWidgets);
        await app.tapKey('session-detail-status-copy-command');
        expect(clipboard, ['cd /work && claude --resume abc-123']);
        expect(app.framesSent(studio, 'handoff'), isEmpty);
        expect(app.pill, 'observing');
      },
    );
  });

  group('losing the session to the terminal', () {
    featureTest(
      'when the terminal writes, the app is demoted to Observe at once and '
      'a later reconnect does not reclaim the lost owner',
      (f) async {
        final studio = studioWith(f);
        final owned = OwnedSession(studio, 's1', takeoverMode: 'live');
        final app = await openSession(f, studio);
        await app.takeOver();
        expect(app.pill, 'driving');

        owned.terminalTakesOver();
        await app.settle();
        expect(app.pill, 'observing');
        expect(app.composerIsReadOnly, isTrue);

        studio.socketsFor('s1').last.drop();
        await app.pumpUntil(
          () => owned.attaches.length >= 3,
          reason: 'the stream reconnects',
          every: const Duration(seconds: 1),
        );
        expect(owned.lastAttach['reason'], isNull);
        expect(owned.lastAttach['mode'], 'live');
        expect(app.pill, 'observing');
      },
    );
  });

  group('how a session is attached', () {
    featureTest(
      'the first attach joins a live row live and only observes the rest: '
      'Drive is never requested without provenance',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('live', 'live')
          ..addSession('resume', 'resume', attachMode: AttachMode.resume)
          ..addSession('observe', 'observe', attachMode: AttachMode.observe);
        await f.storage.seedServer(studio);
        final app = await f.launch();
        var first = true;
        for (final id in ['live', 'resume', 'observe']) {
          await app.openFromRoster(id, cwd: first ? cwd : null);
          first = false;
        }
        String? modeOf(String id) =>
            studio.socketsFor(id).first.attachParams['mode'];
        expect(modeOf('live'), 'live');
        expect(modeOf('resume'), isNull);
        expect(modeOf('observe'), isNull);
        for (final id in ['live', 'resume', 'observe']) {
          expect(
            studio.socketsFor(id).first.attachParams['reason'],
            isNull,
            reason: '$id: nothing was created or taken over',
          );
        }
      },
    );

    featureTest(
      'an attach mode this client does not know is attached read-only: the '
      'composer is never live, not even for the first frame',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('s1', 'Future mode', extra: {'attachMode': 'quantum'});
        final app = await openSession(f, studio);
        final attach = studio.socketsFor('s1').first.attachParams;
        expect(attach['readOnly'], '1');
        expect(attach['mode'], isNull);
        expect(find.text(en.sessionControlUnknownDescription), findsOneWidget);
        await app.send('hello?');
        expect(app.framesSent(studio, 'prompt'), isEmpty);
      },
    );
  });

  group('Drive across a restart', () {
    featureTest(
      'a session the app took over is restored to Drive when it is reopened; '
      'a session the app created is restored too',
      (f) async {
        final studio = studioWith(f);
        final owned = OwnedSession(studio, 's1', alsoIds: ['created-1']);
        final app = await openSession(f, studio);
        await app.takeOver();
        expect(app.pill, 'driving');

        await app.openNewSession();
        await app.submitNewSession();
        await app.pumpUntil(
          () => app.tab('created-1').evaluate().isNotEmpty,
          reason: 'the created session opens in a tab',
        );
        expect(studio.socketsFor('created-1').first.attachParams, {
          ...studio.socketsFor('created-1').first.attachParams,
          'mode': 'resume',
          'reason': 'create',
        });

        final again = await f.restart();
        expect(again.activeTabKey, 'codex/created-1');
        await again.pumpUntil(
          () => studio.socketsFor('created-1').length >= 2,
          reason: 'the created session reattaches',
        );
        expect(
          studio.socketsFor('created-1').last.attachParams['reason'],
          'app-restore',
        );
        expect(again.pill, 'driving');

        await again.openFromRoster('s1', cwd: cwd);
        await again.pumpUntil(
          () => studio.socketsFor('s1').last.attachParams['reason'] != null,
          reason: 'opening the session asks to restore Drive',
        );
        expect(studio.socketsFor('s1').last.attachParams['mode'], 'resume');
        expect(
          studio.socketsFor('s1').last.attachParams['reason'],
          'lease-restore',
        );
        expect(again.pill, 'driving');
        expect(owned.drives('s1'), isTrue);
      },
    );

    featureTest(
      'a restore the broker denies leaves the session Observing with a note '
      'that Take over is still possible, and Take over works afterwards',
      (f) async {
        final studio = studioWith(f);
        final owned = OwnedSession(studio, 's1');
        final app = await openSession(f, studio);
        await app.takeOver();

        owned
          ..appDrives = false
          ..refuseWith = 'DRIVE_OWNERSHIP_CONFLICT';
        final again = await f.restart();
        await again.openFromRoster('s1', cwd: cwd);
        expect(owned.lastAttach['reason'], 'lease-restore');
        expect(again.pill, 'observing');
        await again.openStatus();
        expect(find.text(en.sessionDriveRestoreConflictNote), findsWidgets);
        await again.dismissModal();

        owned.refuseWith = null;
        await again.takeOver();
        expect(again.pill, 'driving');
      },
    );

    featureTest(
      'Detach is an explicit exit: the stream closes, the transcript stays, '
      'and the next launch does not restore Drive',
      (f) async {
        final studio = studioWith(f);
        studio.transcripts['s1'] = [modelOutput('Hello from the agent')];
        final owned = OwnedSession(studio, 's1');
        final app = await openSession(f, studio);
        await app.takeOver();
        expect(find.text('Hello from the agent'), findsOneWidget);

        await app.openStatus();
        await app.tapKey('session-detail-detach-button');
        expect(studio.socketsFor('s1').last.closedByApp, isTrue);
        expect(find.text('Hello from the agent'), findsOneWidget);
        expect(
          find.byKey(const Key('session-detail-composer-attach')),
          findsOneWidget,
          reason: 'the composer offers Attach while detached',
        );

        await app.tapKey('session-detail-composer-attach');
        expect(studio.socketsFor('s1').last.closedByApp, isFalse);
        expect(
          find.text('Hello from the agent'),
          findsOneWidget,
          reason: 'one copy of the transcript, not two',
        );

        await app.openStatus();
        await app.tapKey('session-detail-detach-button');
        final again = await f.restart();
        await again.openFromRoster('s1', cwd: cwd);
        expect(
          owned.lastAttach['reason'],
          isNull,
          reason: 'a detached session is not silently re-driven',
        );
      },
    );
  });

  group('the stream drops', () {
    featureTest(
      'the page keeps its transcript, reconnects from its history position, '
      'and live rows keep arriving without a duplicate',
      (f) async {
        final studio = studioWith(f);
        studio.transcripts['s1'] = [modelOutput('First row', id: 'm1')];
        final app = await openSession(f, studio);
        expect(find.text('First row'), findsOneWidget);
        studio.socketsFor('s1').single.drop();
        await app.settle();
        expect(find.text('First row'), findsOneWidget);

        await app.pumpUntil(
          () => studio.socketsFor('s1').length == 2,
          reason: 'the dropped stream reconnects',
          every: const Duration(seconds: 1),
        );
        final second = studio.socketsFor('s1').last;
        expect(second.attachParams['ticket'], 'cursor-1');
        await app.settle();
        second.emit({
          'kind': 'message',
          'seq': 2,
          'message': modelOutput('Second row', id: 'm2'),
        });
        await app.settle();
        expect(find.text('First row'), findsOneWidget);
        expect(find.text('Second row'), findsOneWidget);
      },
    );

    featureTest(
      'a live status change on the open session reaches its roster row '
      'without waiting for the roster feed, and the header follows',
      (f) async {
        final studio = studioWith(f);
        final app = await openSession(f, studio);
        expect(app.rosterRefs.single.status, SessionStatus.idle);
        final reads = app.rosterReads(studio).length;

        final session = studio.sessions.single;
        studio.socketsFor('s1').single.emit({
          'kind': 'session',
          'info': {
            ...session,
            'status': 'working',
            'control': FakeBroker.drivingControl,
          },
        });
        await app.settle();
        expect(app.rosterRefs.single.status, SessionStatus.working);
        expect(app.rosterReads(studio), hasLength(reads));

        studio.socketsFor('s1').single.emit({
          'kind': 'session',
          'info': {
            ...session,
            'status': 'idle',
            'control': FakeBroker.drivingControl,
          },
        });
        await app.settle();
        expect(
          app.rosterRefs.single.status,
          SessionStatus.idle,
          reason: 'idle clears a stale Working',
        );
      },
    );
  });
}
