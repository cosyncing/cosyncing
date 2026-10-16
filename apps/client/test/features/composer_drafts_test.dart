// The desk is configured field by field inside setup callbacks.
// ignore_for_file: cascade_invocations
// F04b — The unsent draft: relayed to the session's other clients, kept on
// the device, and reconciled when both sides changed. Every scenario runs on
// the real in-memory Drift database; debounces are crossed with fake time.
import 'package:cosyncing_client/src/features/sessions/transcript/session_draft_keepalive_store.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_draft_store.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart' show Override;
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/app_driver.dart';
import '../support/feature/composer_driver.dart';
import '../support/feature/composer_wire.dart';
import '../support/feature/cosyncing_app.dart';
import '../support/feature/fake_broker.dart';
import '../support/feature/faulty_draft_repository.dart';
import '../support/feature/roster_driver.dart';
import '../support/feature/session_driver.dart';
import '../support/feature/session_wire.dart';

const debounce = Duration(milliseconds: 300);
const keepLocal = Key('session-detail-draft-conflict-keep-local');
const useShared = Key('session-detail-draft-conflict-use-shared');

/// The stream drops and the broker refuses new ones until [reconnect].
Future<void> disconnect(AppDriver app, FakeBroker studio) async {
  studio.socketsAccepted = false;
  for (final socket in studio.socketsFor('s1')) {
    socket.drop();
  }
  await app.elapse(const Duration(seconds: 2));
}

/// The broker accepts streams again; waits for the app's next attach.
Future<void> reconnect(
  AppDriver app,
  FakeBroker studio,
  ComposerDesk desk,
) async {
  final before = desk.attaches;
  studio.socketsAccepted = true;
  await app.pumpUntil(
    () => desk.attaches > before,
    reason: 'the app to attach again',
    every: const Duration(seconds: 1),
  );
  await app.settle();
}

void main() {
  group('relaying the draft', () {
    featureTest(
      "typing is relayed after the pause and the broker's echo of it is "
      'swallowed',
      (f) async {
        final (app, _, desk) = await openComposer(f);
        await app.type('half a thought');
        await app.tick(const Duration(milliseconds: 100));
        expect(desk.drafts, isEmpty, reason: 'still inside the debounce');

        await app.tick(debounce);
        final frame = desk.drafts.single;
        expect(frame['text'], 'half a thought');
        expect(frame['updateId'], isA<String>());
        expect(desk.draftText, 'half a thought');
        expect(app.composerText, 'half a thought');
        expect(find.byKey(keepLocal), findsNothing);
        final rows = await durableDrafts(f);
        expect(rows['s1']!.text, 'half a thought');
        expect(rows['s1']!.dirty, isFalse, reason: 'acknowledged by the echo');
      },
    );

    featureTest(
      'a draft another client wrote fills an empty composer, but never '
      'replaces what the user is typing',
      (f) async {
        final (app, _, desk) = await openComposer(f);
        desk.writeFromElsewhere('from the terminal');
        await app.settle();
        expect(app.composerText, 'from the terminal');

        await app.type('my own words');
        await app.tick(debounce);
        desk.writeFromElsewhere('newer elsewhere');
        await app.settle();
        expect(app.composerText, 'my own words');
        expect(find.byKey(keepLocal), findsNothing);
      },
    );

    featureTest(
      'on a broker without versioned drafts the relay is last-writer-wins '
      'and a changed remote draft waits for an IME composition to end',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('s1', 'Fix login');
        // Contract revision 2 predates versioned drafts.
        studio.contractRevision = 2;
        final desk = ComposerDesk(studio, versionedDrafts: false);
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.openFromRoster('s1', cwd: '/work/studio');

        await app.focusComposer();
        f.tester.testTextInput.updateEditingValue(
          const TextEditingValue(
            text: 'local composing',
            selection: TextSelection.collapsed(offset: 15),
            composing: TextRange(start: 6, end: 15),
          ),
        );
        await app.settle();
        desk.writeFromElsewhere('remote replacement');
        await app.settle();
        expect(app.composerText, 'local composing', reason: 'composing');

        f.tester.testTextInput.updateEditingValue(
          const TextEditingValue(
            text: 'local composing',
            selection: TextSelection.collapsed(offset: 15),
          ),
        );
        await app.settle();
        expect(app.composerText, 'remote replacement');
        // A legacy broker is never sent versioning fields.
        for (final frame in desk.drafts) {
          expect(frame.containsKey('baseRevision'), isFalse);
          expect(frame.containsKey('updateId'), isFalse);
        }
      },
    );

    featureTest(
      'a trailing edit waits for the echo of the one in flight, then goes out '
      'on the advanced revision',
      (f) async {
        final (app, _, desk) = await openComposer(
          f,
          setup: (_, desk) => desk.holdDraftFrames = true,
        );
        await app.type('first');
        await app.tick(debounce);
        expect(desk.drafts, hasLength(1));
        final firstId = desk.drafts.single['updateId'];

        await app.type('first and second');
        await app.tick(debounce);
        expect(desk.drafts, hasLength(1), reason: 'waits for the echo');

        desk.releaseDraftFrames();
        await app.tick(debounce);
        await app.settle();
        expect(desk.drafts, hasLength(2));
        expect(desk.drafts.last['text'], 'first and second');
        expect(desk.drafts.last['baseRevision'], 1);
        expect(desk.drafts.last['updateId'], isNot(firstId));
      },
    );
  });

  group('away from the broker', () {
    featureTest(
      'an edit made while the stream is down is stored dirty without a '
      'relay, survives a restart, and is published once on reconnect',
      (f) async {
        final (app, studio, desk) = await openComposer(f);
        await disconnect(app, studio);
        await app.type('typed before the drop');
        await app.tick(debounce);
        expect(desk.drafts, isEmpty);
        expect((await durableDrafts(f))['s1'], (
          text: 'typed before the drop',
          dirty: true,
        ));

        final again = await f.restart();
        studio.socketsAccepted = true;
        await again.openFromRoster('s1', cwd: '/work/studio');
        expect(again.composerText, 'typed before the drop');
        await again.pumpUntil(
          () => desk.drafts.isNotEmpty,
          reason: 'the dirty draft to be published',
          every: const Duration(seconds: 1),
        );
        await again.settle();
        expect(desk.drafts.map((d) => d['text']), ['typed before the drop']);
        expect(desk.draftText, 'typed before the drop');
        expect((await durableDrafts(f))['s1']!.dirty, isFalse);
      },
    );

    featureTest(
      'a draft typed while only observing is kept, and published once the '
      'app holds control',
      (f) async {
        final (app, studio, desk) = await openComposer(
          f,
          setup: (studio, _) => studio.controls['s1'] = controlBlock(
            drive: driveBlock('observing'),
            terminalSync: syncBlock(supported: false),
          ),
        );
        // Observing replaces the composer with the Observe bar; the draft the
        // other side wrote is still staged.
        desk.writeFromElsewhere('from the terminal');
        await app.settle();
        expect(desk.drafts, isEmpty);

        studio.controls.remove('s1');
        desk.publishSession();
        await app.settle();
        expect(app.composerText, 'from the terminal');
      },
    );

    featureTest(
      'a draft cleared elsewhere while the app was closed is cleared here '
      'too, not redisplayed',
      (f) async {
        final (app, studio, desk) = await openComposer(f);
        await app.type('sent from another device');
        await app.tick(debounce);
        expect((await durableDrafts(f))['s1']!.dirty, isFalse);

        await f.quit();
        desk
          ..draftText = ''
          ..draftRevision += 1;
        final again = await f.launch();
        await again.openFromRoster('s1', cwd: '/work/studio');
        expect(again.composerText, isEmpty);
        expect((await durableDrafts(f))['s1']?.text ?? '', isEmpty);
      },
    );
  });

  group('both sides changed', () {
    /// Types a synced draft, loses the stream, edits it offline, and comes
    /// back after the other client rewrote the shared draft. The last
    /// keystroke is two seconds old by then (fake time, the clock the
    /// recently-typed guard reads), so this is the independent-edits case,
    /// not a live typing race.
    Future<(AppDriver, FakeBroker, ComposerDesk)> divergedDrafts(
      FeatureContext f,
    ) async {
      final (app, studio, desk) = await openComposer(f);
      await app.type('synced');
      await app.tick(debounce);
      await disconnect(app, studio);
      await app.type('device edit');
      await app.tick(debounce);
      desk.writeFromElsewhere('shared edit');
      await app.elapse(const Duration(seconds: 2));
      await reconnect(app, studio, desk);
      await app.pumpUntil(
        () => find.byKey(keepLocal).evaluate().isNotEmpty,
        reason: 'the conflict banner',
        every: const Duration(seconds: 1),
      );
      return (app, studio, desk);
    }

    featureTest(
      'independent edits on both sides keep both versions and ask; nothing is '
      'overwritten until the user chooses',
      (f) async {
        final (app, _, desk) = await divergedDrafts(f);
        expect(find.text('Resolve draft conflict'), findsOneWidget);
        expect(find.byKey(useShared), findsOneWidget);
        expect(app.composerText, 'device edit');
        expect(desk.draftText, 'shared edit');
      },
    );

    featureTest("Keep device publishes this device's text over the shared "
        'draft', (f) async {
      final (app, _, desk) = await divergedDrafts(f);
      await app.tap(find.byKey(keepLocal));
      await app.tick(debounce);
      expect(find.text('Resolve draft conflict'), findsNothing);
      expect(desk.draftText, 'device edit');
      expect(desk.drafts.last['baseRevision'], desk.draftRevision - 1);
      expect(app.composerText, 'device edit');
    });

    featureTest("Use shared replaces this device's text, and only then", (
      f,
    ) async {
      final (app, _, desk) = await divergedDrafts(f);
      await app.tap(find.byKey(useShared));
      expect(find.text('Resolve draft conflict'), findsNothing);
      expect(app.composerText, 'shared edit');
      expect(desk.draftText, 'shared edit');
      expect((await durableDrafts(f))['s1'], (
        text: 'shared edit',
        dirty: false,
      ));
    });
  });

  group('what is kept when the page goes away', () {
    featureTest(
      'losing focus makes the coalesced edit durable at once, inside the '
      'debounce',
      (f) async {
        final (app, _, _) = await openComposer(f);
        await app.type('typed then focus lost');
        await app.tick(const Duration(milliseconds: 50));
        expect(await durableDrafts(f), isEmpty);
        primaryFocus?.unfocus();
        await app.settle();
        expect((await durableDrafts(f))['s1']!.text, 'typed then focus lost');
      },
    );

    featureTest(
      'every background boundary (inactive, hidden, paused) flushes the edit '
      'before the page can be torn down',
      (f) async {
        final (app, _, _) = await openComposer(f);
        final steps = <(AppLifecycleState, String)>[
          (AppLifecycleState.inactive, 'text at inactive'),
          (AppLifecycleState.hidden, 'text at hidden'),
          (AppLifecycleState.paused, 'text at paused'),
        ];
        for (final (state, text) in steps) {
          await app.type(text);
          await app.tick(const Duration(milliseconds: 50));
          f.tester.binding.handleAppLifecycleStateChanged(state);
          await app.settle();
          expect((await durableDrafts(f))['s1']!.text, text, reason: '$state');
        }
        await app.foreground();
      },
    );

    featureTest(
      'closing the tab inside the debounce makes the draft durable before '
      'the tab goes',
      (f) async {
        final (app, _, _) = await openComposer(f);
        await app.type('typed then closed the tab');
        await app.tick(const Duration(milliseconds: 50));
        await app.tapKey('open-session-tab-close-codex/s1');
        expect(promptField, findsNothing);
        expect(
          (await durableDrafts(f))['s1']!.text,
          'typed then closed the tab',
        );
      },
    );
  });

  group('sending a draft', () {
    featureTest(
      'a sent draft is gone everywhere: the composer, this device and the '
      "session's shared draft",
      (f) async {
        final (app, _, desk) = await openComposer(f);
        await app.type('ship it');
        await app.tick(debounce);
        expect(desk.draftText, 'ship it');

        await app.pressSend();
        await app.settle();
        expect(app.composerText, isEmpty);
        expect(desk.draftText, isEmpty);
        expect(desk.prompts.single['draftRevision'], 1);
        expect((await durableDrafts(f))['s1']?.text ?? '', isEmpty);
      },
    );

    featureTest(
      "a refused prompt's text is still in the composer after a restart",
      (f) async {
        final (app, _, desk) = await openComposer(f);
        desk.answer = PromptAnswer.refuse;
        await app.send('refused words');
        await app.settle();
        expect(app.composerText, 'refused words');

        final again = await f.restart();
        await again.openFromRoster('s1', cwd: '/work/studio');
        expect(again.composerText, 'refused words');
        expect((await durableDrafts(f))['s1']!.text, 'refused words');
      },
    );

    Future<(AppDriver, ComposerDesk)> refusedBesideNewerText(
      FeatureContext f,
    ) async {
      final (app, _, desk) = await openComposer(
        f,
        setup: (_, desk) => desk.answer = PromptAnswer.hold,
      );
      await app.send('the first attempt');
      await app.type('newer thought');
      await app.tick(debounce);
      desk.refuse(desk.prompts.single);
      await app.settle();
      return (app, desk);
    }

    featureTest(
      'a refused prompt that meets newer typing is offered back, not lost: '
      'Use kept version restores it',
      (f) async {
        final (app, _) = await refusedBesideNewerText(f);
        expect(app.composerText, 'newer thought');
        expect(find.text('Recover kept version'), findsOneWidget);
        await app.tap(find.text('Use kept version'));
        expect(app.composerText, 'the first attempt');
        expect(find.text('Recover kept version'), findsNothing);
      },
    );

    featureTest('Keep what I typed discards the refused prompt', (f) async {
      final (app, _) = await refusedBesideNewerText(f);
      await app.tap(find.text('Keep what I typed'));
      expect(app.composerText, 'newer thought');
      expect(find.text('Recover kept version'), findsNothing);
      expect((await durableDrafts(f))['s1']!.text, 'newer thought');
    });

    featureTest(
      'a refusal that lands inside the debounce of newer typing still '
      'offers the refused prompt back',
      (f) async {
        final (app, _, desk) = await openComposer(
          f,
          setup: (_, desk) => desk.answer = PromptAnswer.hold,
        );
        await app.send('the first attempt');
        await app.type('newer thought');
        desk.refuse(desk.prompts.single);
        await app.settle();
        await app.tick(debounce);
        expect(find.text('Recover kept version'), findsOneWidget);
        expect(app.composerText, 'newer thought');
        await app.tap(find.text('Use kept version'));
        expect(app.composerText, 'the first attempt');
      },
    );
  });

  group('a hard refresh', () {
    /// One launch of the App over [storage] whose draft saves can be held,
    /// sharing [keepalive] with the other launches: the page's
    /// write-ahead record outlives a document, the database write may not.
    List<Override> launchOverrides(
      FeatureContext f,
      MemorySessionDraftKeepaliveStore keepalive,
      void Function(FaultyDraftRepository repo)? onCreate,
    ) => [
      sessionDraftKeepaliveProvider.overrideWithValue(
        SessionDraftKeepalive(keepalive),
      ),
      FaultyDraftRepository.overrideFor(f.storage, onCreate: onCreate),
    ];

    featureTest(
      'text typed before the page was destroyed, whose save never landed, '
      'comes back on the next start and is published',
      (f) async {
        final keepalive = MemorySessionDraftKeepaliveStore();
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('s1', 'Fix login');
        final desk = ComposerDesk(studio);
        await f.storage.seedServer(studio);

        late FaultyDraftRepository first;
        final app = await f.launch(
          overrides: launchOverrides(f, keepalive, (repo) {
            first = repo..saves.hold();
          }),
        );
        await app.openFromRoster('s1', cwd: '/work/studio');
        await app.type('what was on screen');
        await app.tick(debounce);
        expect(first.saves.parked, isPositive, reason: 'the save is stuck');
        expect(await durableDrafts(f), isEmpty);
        expect(keepalive.readAll(), isNotEmpty, reason: 'write-ahead record');

        // The document is destroyed; the held save is never finished.
        await f.quit();
        final again = await f.launch(
          overrides: launchOverrides(f, keepalive, null),
        );
        await again.openFromRoster('s1', cwd: '/work/studio');
        expect(again.composerText, 'what was on screen');
        expect((await durableDrafts(f))['s1']!.text, 'what was on screen');
        await again.pumpUntil(
          () => desk.draftText == 'what was on screen',
          reason: 'the adopted draft to be published',
          every: const Duration(seconds: 1),
        );
      },
    );

    featureTest(
      'a landed save leaves no record behind, and a sent draft is not '
      'resurrected by the next start',
      (f) async {
        final keepalive = MemorySessionDraftKeepaliveStore();
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('s1', 'Fix login');
        ComposerDesk(studio);
        await f.storage.seedServer(studio);
        final app = await f.launch(
          overrides: launchOverrides(f, keepalive, null),
        );
        await app.openFromRoster('s1', cwd: '/work/studio');
        await app.type('already saved');
        await app.tick(debounce);
        await app.settle();
        expect(keepalive.readAll(), isEmpty);

        await app.send('delivered');
        await f.quit();
        final again = await f.launch(
          overrides: launchOverrides(f, keepalive, null),
        );
        await again.openFromRoster('s1', cwd: '/work/studio');
        expect(again.composerText, isEmpty);
      },
    );
  });

  group('storage that refuses', () {
    featureTest(
      'a draft the device cannot store stays in the composer and is not '
      'relayed; it is stored once storage recovers',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('s1', 'Fix login');
        final desk = ComposerDesk(studio);
        await f.storage.seedServer(studio);
        late FaultyDraftRepository repo;
        final app = await f.launch(
          overrides: [
            FaultyDraftRepository.overrideFor(
              f.storage,
              onCreate: (inner) => repo = inner,
            ),
          ],
        );
        await app.openFromRoster('s1', cwd: '/work/studio');

        repo.saves.fail = true;
        await app.type('cannot be stored');
        await app.tick(debounce);
        await app.tick(const Duration(seconds: 2));
        expect(app.composerText, 'cannot be stored');
        expect(await durableDrafts(f), isEmpty);
        expect(desk.drafts, isEmpty);

        repo.saves.fail = false;
        await app.type('cannot be stored, then can');
        await app.tick(debounce);
        await app.settle();
        expect(
          (await durableDrafts(f))['s1']!.text,
          'cannot be stored, then can',
        );
        expect(desk.draftText, 'cannot be stored, then can');
      },
    );

    featureTest(
      'a draft over the storage cap is refused visibly, never stored as a '
      'prefix; the last storable text survives',
      (f) async {
        final (app, _, desk) = await openComposer(f);
        await app.type('small draft');
        await app.tick(debounce);
        final published = desk.drafts.length;

        await app.type('x' * (maxLocalDraftTextChars + 1));
        await app.tick(debounce);
        expect(
          find.byKey(const Key('session-draft-too-long-status')),
          findsOneWidget,
        );
        expect(desk.drafts, hasLength(published));
        expect((await durableDrafts(f))['s1']!.text, 'small draft');

        await app.type('fits again');
        await app.tick(debounce);
        expect(
          find.byKey(const Key('session-draft-too-long-status')),
          findsNothing,
        );
        expect((await durableDrafts(f))['s1']!.text, 'fits again');
      },
    );
  });

  group('servers keep their drafts apart', () {
    featureTest(
      'a draft typed for a session on one server is not shown, relayed or '
      "stored under another server's session with the same id, and is "
      'there when you come back',
      (f) async {
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('s1', 'Studio work', cwd: '/work/studio');
        final lab = f.network.add('http://lab.test:7734', machine: 'lab')
          ..addSession('s1', 'Lab work', cwd: '/work/lab');
        final studioDesk = ComposerDesk(studio);
        final labDesk = ComposerDesk(lab);
        await f.storage.seedServer(studio);
        await f.storage.seedServer(lab, active: false);
        final app = await f.launch();
        await app.openFromRoster('s1', cwd: '/work/studio');
        await app.type('for the studio only');
        await app.tick(debounce);
        expect(studioDesk.draftText, 'for the studio only');

        await app.switchServer('http://lab.test:7734');
        await app.openFromRoster('s1', cwd: '/work/lab');
        expect(app.composerText, isEmpty);
        await app.elapse(const Duration(seconds: 2));
        expect(labDesk.drafts, isEmpty);
        expect(labDesk.draftText, isEmpty);

        await app.type('for the lab');
        await app.tick(debounce);
        expect(labDesk.draftText, 'for the lab');
        expect(studioDesk.draftText, 'for the studio only');

        await app.switchServer('http://studio.test:7734');
        await app.openFromRoster('s1', cwd: '/work/studio');
        expect(app.composerText, 'for the studio only');
      },
    );
  });
}
