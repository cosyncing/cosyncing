// F05 — The Status view of a session: what it says about who controls the
// session and what the user can do about it, plus the session actions.
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/cosyncing_app.dart';
import '../support/feature/fake_broker.dart';
import '../support/feature/roster_driver.dart';
import '../support/feature/session_driver.dart';
import '../support/feature/session_wire.dart';

final AppLocalizations en = lookupAppLocalizations(const Locale('en'));

const cwd = '/work/studio';

FakeBroker studioWith(FeatureContext f, {String id = 's1'}) =>
    f.network.add('http://studio.test:7734')..addSession(id, 'Fix login');

/// What the Status sheet shows for one control block.
typedef StatusCase = ({
  String name,
  Map<String, Object?> control,
  List<String> says,
  List<String> silent,
  bool takeOver,
  bool copyCommand,
});

void main() {
  group('what Status says about control', () {
    final cases = <StatusCase>[
      (
        name: 'a healthy shared terminal says it once',
        control: controlBlock(
          drive: driveBlock('observing', supported: false),
          terminalSync: syncBlock(
            active: true,
            presence: 'shared',
            action: 'handoff',
          ),
        ),
        // The pill is enough: no restatement, no Terminal block.
        says: [],
        silent: [
          en.sessionControlSyncedDescription,
          en.sessionTerminalSynced,
          en.sessionTerminalOptional,
        ],
        takeOver: false,
        copyCommand: false,
      ),
      (
        name: 'an observed session',
        control: controlBlock(
          drive: driveBlock('observing'),
          terminalSync: syncBlock(supported: false),
        ),
        says: [en.sessionControlObservingDescription],
        silent: [en.sessionControlUnavailableDescription],
        takeOver: true,
        copyCommand: false,
      ),
      (
        name: 'a terminal that can be joined offers both choices',
        control: controlBlock(
          drive: driveBlock('observing'),
          terminalSync: syncBlock(
            syncAvailable: true,
            action: 'join',
            command: 'codex resume --remote sock t1',
          ),
        ),
        says: [
          en.sessionControlSyncAvailableDescription,
          en.sessionSyncWithTerminal,
          'codex resume --remote sock t1',
          en.sessionContinueInCosyncingDescription,
        ],
        silent: [en.sessionControlUnavailableDescription],
        takeOver: true,
        copyCommand: true,
      ),
      (
        name: 'a join with no usable command falls back to Take over only',
        control: controlBlock(
          drive: driveBlock('observing'),
          terminalSync: syncBlock(
            syncAvailable: true,
            action: 'join',
            command: '   ',
          ),
        ),
        says: [en.sessionContinueInCosyncingDescription],
        silent: [en.sessionSyncWithTerminal],
        takeOver: true,
        copyCommand: false,
      ),
      (
        name: 'a join with neither path says it can only be observed',
        control: controlBlock(
          drive: driveBlock('unavailable', supported: false),
          terminalSync: syncBlock(syncAvailable: true, action: 'join'),
        ),
        says: [en.sessionControlUnavailableDescription],
        silent: [en.sessionSyncWithTerminal],
        takeOver: false,
        copyCommand: false,
      ),
      (
        name: 'a demoted session offers Take over instead of denying it',
        control: controlBlock(
          drive: driveBlock(
            'unavailable',
            supported: false,
            takeoverAvailable: true,
            takeoverMode: 'live',
          ),
          terminalSync: syncBlock(supported: false),
        ),
        says: [en.sessionControlTakeoverAvailableDescription],
        silent: [en.sessionControlUnavailableDescription],
        takeOver: true,
        copyCommand: false,
      ),
      (
        name: 'a terminal that is behind says so',
        control: controlBlock(
          drive: driveBlock('observing', supported: false),
          terminalSync: syncBlock(
            active: true,
            presence: 'shared',
            behind: true,
          ),
        ),
        says: [en.sessionTerminalBehind],
        silent: [],
        takeOver: false,
        copyCommand: false,
      ),
      (
        name: 'a broker reason survives behind Technical details',
        control: controlBlock(
          drive: driveBlock(
            'observing',
            reason: 'broker: fixture technical detail',
          ),
          terminalSync: syncBlock(supported: false),
        ),
        says: [],
        silent: ['broker: fixture technical detail'],
        takeOver: true,
        copyCommand: false,
      ),
    ];
    for (final c in cases) {
      featureTest('${c.name}: its explanation and its controls', (f) async {
        final studio = studioWith(f);
        studio.controls['s1'] = c.control;
        final app = await openSession(f, studio);
        await app.openStatus();

        final sheet = find.byKey(const Key('session-detail-status-sheet'));
        if (c.name == 'a broker reason survives behind Technical details') {
          await app.openTechnicalDetails(find.text(en.sessionControlHeading));
          expect(
            find.textContaining('broker: fixture technical detail'),
            findsOneWidget,
          );
          await app.tapKey('contextual-details-close');
        }
        for (final text in c.says) {
          expect(
            find.descendant(of: sheet, matching: find.textContaining(text)),
            findsWidgets,
            reason: 'says: $text',
          );
        }
        for (final text in c.silent) {
          expect(
            find.descendant(of: sheet, matching: find.text(text)),
            findsNothing,
            reason: 'does not say: $text',
          );
        }
        expect(
          find.byKey(const Key('session-detail-take-over-button')),
          c.takeOver ? findsOneWidget : findsNothing,
          reason: 'Take over',
        );
        expect(
          find.byKey(const Key('session-detail-status-copy-command')),
          c.copyCommand ? findsOneWidget : findsNothing,
          reason: 'copy command',
        );
      });
    }

    featureTest(
      'Take over from Status confirms first and then drives, exactly like '
      'the composer',
      (f) async {
        final studio = studioWith(f);
        final owned = OwnedSession(studio, 's1');
        final app = await openSession(f, studio);
        await app.openStatus();
        await app.tapKey('session-detail-take-over-button');
        expect(
          find.byKey(const Key('session-detail-take-over-dialog')),
          findsOneWidget,
        );
        await app.tapKey('session-detail-take-over-confirm');
        expect(owned.lastAttach['reason'], 'takeover');
        expect(app.pill, 'driving');
      },
    );

    featureTest(
      "the control Status shows is the active server's: a session of the "
      "same id on another server never inherits the previous one's "
      'ownership [REG]',
      (f) async {
        final studio = studioWith(f);
        studio.controls['s1'] = controlBlock(
          drive: driveBlock('observing'),
          terminalSync: syncBlock(supported: false),
        );
        final lab = f.network.add('http://lab.test:7734', machine: 'lab')
          ..addSession('s1', 'Lab session');
        await f.storage.seedServer(lab, active: false);
        final app = await openSession(f, studio);
        expect(app.pill, 'observing');

        await app.switchServer('http://lab.test:7734');
        await app.openFromRoster('s1', cwd: '/work/lab');
        expect(app.pill, 'driving');
        await app.openStatus();
        expect(
          find.byKey(const Key('session-detail-take-over-button')),
          findsNothing,
        );
        expect(
          find.text(en.sessionControlObservingDescription),
          findsNothing,
          reason: "the studio's control frame is never shown for the lab",
        );
      },
    );
  });

  group('session actions', () {
    featureTest(
      'the Status view never shows the session id; with debug views on, '
      'the identity lives in the Debug view only',
      (f) async {
        await f.storage.preferences.setShowDebugViews(value: true);
        final studio = f.network.add('http://studio.test:7734')
          ..addSession('ses_01JQ4Z8W', 'Fix login', nativeId: 'native-4711');
        final app = await openSession(f, studio, id: 'ses_01JQ4Z8W');
        await app.openStatus();
        final sheet = find.byKey(const Key('session-detail-status-sheet'));
        expect(
          find.descendant(
            of: sheet,
            matching: find.textContaining('ses_01JQ4Z8W'),
          ),
          findsNothing,
        );
        expect(find.textContaining('native-4711'), findsNothing);
        await app.dismissModal();

        await app.tapKey('session-detail-view-menu');
        await app.tapKey('session-detail-view-item-debug');
        expect(
          find.byKey(const Key('session-detail-debug-identity')),
          findsOneWidget,
        );
        expect(find.text('codex / ses_01JQ4Z8W'), findsOneWidget);
      },
    );

    featureTest('with debug views off there is no Debug view to open', (
      f,
    ) async {
      final studio = studioWith(f);
      final app = await openSession(f, studio);
      await app.tapKey('session-detail-view-menu');
      expect(
        find.byKey(const Key('session-detail-view-item-debug')),
        findsNothing,
      );
    });

    featureTest('actions an agent type cannot do are disabled and say why', (
      f,
    ) async {
      final studio = studioWith(f);
      final app = await openSession(f, studio);
      await app.openStatus();
      expect(find.text(en.sessionDuplicateDisabledUnsupported), findsNothing);
      expect(find.text(en.sessionExportDisabledUnsupported), findsOneWidget);
      for (final key in ['fork']) {
        expect(
          app.tester
              .widget<ListTile>(find.byKey(Key('session-detail-$key-button')))
              .enabled,
          isFalse,
          reason: key,
        );
      }
    });

    featureTest(
      'a session that is not attached disables its actions and says it '
      'must be connected',
      (f) async {
        final studio = studioWith(f)
          ..agents = [fakeAgent(canFork: true, canClone: true)];
        final app = await openSession(f, studio);
        await app.openStatus();
        await app.tapKey('session-detail-detach-button');
        await app.openStatus();
        expect(find.text(en.sessionActionDisabledOffline), findsWidgets);
        expect(
          app.tester
              .widget<ListTile>(
                find.byKey(const Key('session-detail-fork-button')),
              )
              .enabled,
          isFalse,
        );
      },
    );

    featureTest(
      "while the agent's capabilities are still loading the actions say "
      'they are checking, never that the agent lacks them',
      (f) async {
        final studio = studioWith(f)
          ..agents = [fakeAgent(canFork: true, canClone: true)];
        final held = studio.hold('GET', '/api/agents');
        final app = await openSession(f, studio);
        await app.openStatus();
        expect(
          find.text(en.sessionActionDisabledCapabilityPending),
          findsWidgets,
        );
        expect(find.text(en.sessionDuplicateDisabledUnsupported), findsNothing);

        held.release();
        await app.waitForAbsent(
          find.text(en.sessionActionDisabledCapabilityPending),
        );
        expect(
          app.tester
              .widget<ListTile>(
                find.byKey(const Key('session-detail-fork-button')),
              )
              .enabled,
          isTrue,
        );
      },
    );

    featureTest(
      'a capability read that failed says it could not confirm support, '
      'not that the agent lacks it',
      (f) async {
        final studio = studioWith(f)
          ..agents = [fakeAgent(canFork: true, canClone: true)];
        final held = studio.hold('GET', '/api/agents');
        final app = await openSession(f, studio);
        await app.openStatus();
        held.release(
          FakeBrokerResponse.error(500, 'INTERNAL', rawLeakSentinel),
        );
        await app.waitForAbsent(
          find.text(en.sessionActionDisabledCapabilityPending),
        );
        expect(
          find.text(en.sessionActionDisabledCapabilityUnknown),
          findsWidgets,
        );
        expect(find.text(en.sessionDuplicateDisabledUnsupported), findsNothing);
        app.expectNoRawErrorLeak();
      },
    );

    featureTest('Fork at latest asks the broker once and opens the '
        'new session in its own tab', (f) async {
      final studio = studioWith(f)
        ..agents = [fakeAgent(canFork: true, canClone: true)];
      final app = await openSession(f, studio);
      await app.openStatus();
      await app.tapKey('session-detail-fork-button');
      await app.pumpUntil(
        () => app.tab('fork-of-s1').evaluate().isNotEmpty,
        reason: 'the fork opens in a tab',
      );
      expect(
        studio.requestsTo('/api/sessions/codex/s1/fork', method: 'POST'),
        hasLength(1),
      );
    });

    featureTest(
      'forking a session another agent spawned is refused in plain words, '
      'and the app never asks again [REG]',
      (f) async {
        final studio = studioWith(f)
          ..agents = [fakeAgent(canFork: true)]
          ..respondNext(
            'POST',
            '/api/sessions/codex/s1/fork',
            FakeBrokerResponse.error(
              409,
              'SESSION_AGENT_OWNED',
              'RAW-LEAK-SENTINEL spawned by another agent',
            ),
          );
        final app = await openSession(f, studio);
        await app.openStatus();
        await app.tapKey('session-detail-fork-button');
        expect(find.text(en.sessionForkAgentOwnedRefusal), findsWidgets);
        app.expectNoRawErrorLeak();

        await app.tester.tap(
          find.byKey(const Key('session-detail-fork-button')),
          warnIfMissed: false,
        );
        await app.settle();
        expect(
          studio.requestsTo('/api/sessions/codex/s1/fork', method: 'POST'),
          hasLength(1),
        );
      },
    );

    featureTest(
      'Status omits Duplicate, Copy transcript and the local-data wrapper',
      (f) async {
        final app = await openSession(f, studioWith(f));
        await app.openStatus();
        expect(
          find.byKey(const Key('session-detail-copy-transcript-button')),
          findsNothing,
        );
        expect(
          find.byKey(const Key('session-detail-clone-button')),
          findsNothing,
        );
        expect(
          find.byKey(const Key('session-actions-local-data-caption')),
          findsNothing,
        );
        expect(
          find.byKey(const Key('session-detail-clear-current-cache-button')),
          findsOneWidget,
        );
      },
    );

    featureTest(
      'Clear this session cache asks first, removes the saved transcript '
      'for this session only, and tells the broker to clear its own',
      (f) async {
        final studio = studioWith(f)..addSession('s2', 'Tidy styles');
        studio.transcripts['s1'] = [modelOutput('Cached in s1.', id: 'a')];
        studio.transcripts['s2'] = [modelOutput('Cached in s2.', id: 'b')];
        await f.storage.seedServer(studio);
        final app = await f.launch();
        await app.openFromRoster('s1', cwd: cwd);
        await app.openFromRoster('s2');
        await app.elapse(const Duration(seconds: 2));

        await app.tester.tap(app.tab('s1'));
        await app.settle();
        await app.openStatus();
        await app.tapKey('session-detail-clear-current-cache-button');
        expect(
          studio.requestsTo('/api/sessions/codex/s1/cache', method: 'DELETE'),
          isEmpty,
          reason: 'nothing is cleared before the user confirms',
        );
        await app.tapKey('session-detail-clear-current-cache-confirm');
        expect(find.text(en.sessionCurrentCacheCleared), findsWidgets);
        expect(
          studio.requestsTo('/api/sessions/codex/s1/cache', method: 'DELETE'),
          hasLength(1),
        );

        studio.socketsAccepted = false;
        final again = await f.restart();
        await again.tester.tap(again.tab('s2'));
        await again.settle();
        expect(find.text('Cached in s2.'), findsOneWidget);
        await again.tester.tap(again.tab('s1'));
        await again.settle();
        expect(find.text('Cached in s1.'), findsNothing);
      },
    );
  });

  group('compatibility', () {
    featureTest(
      'when the pair is read-only the session actions are unavailable and '
      'say that compatibility is the reason',
      (f) async {
        final studio = studioWith(f)
          ..agents = [fakeAgent(canFork: true, canClone: true)];
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
        final app = await openSession(f, studio);
        await app.openStatus();
        expect(find.text(en.sessionActionDisabledReadOnly), findsWidgets);
        expect(
          app.tester
              .widget<ListTile>(
                find.byKey(const Key('session-detail-fork-button')),
              )
              .enabled,
          isFalse,
        );
      },
    );
  });
}
