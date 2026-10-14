// F06 — Approvals through the real App: permission, question and plan cards
// in a session's transcript, answering them, and what a settled, withdrawn or
// terminal-owned card says. The app speaks to a wire-level fake broker; every
// frame the app sends is read back from the socket.
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/features/settings/controller/locale_controller.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/approvals_wire.dart';
import '../support/feature/cosyncing_app.dart';
import '../support/feature/fake_broker.dart';
import '../support/feature/session_driver.dart';
import '../support/feature/session_wire.dart';
import '../support/feature/transcript_wire.dart';

final AppLocalizations en = lookupAppLocalizations(const Locale('en'));

const readOnlyNote =
    'This request is read-only. Answer where the agent is running.';
const waitingInTerminal =
    'This question is waiting in your terminal. Answer it there.';

/// The card (transcript box) that holds [inner].
Finder cardOf(Finder inner) =>
    find.ancestor(of: inner, matching: find.byType(TranscriptBox)).first;

void main() {
  group('permission cards', () {
    featureTest(
      'a card shows what is asked, answers with the options the broker '
      'advertised, says Sent, and keeps its actions after a failed send',
      (f) async {
        final longCommand = 'echo ${'x' * 400}';
        late FakeBroker studio;
        final app = await openTranscript(
          f,
          [
            // Metadata, and the alternative id key some adapters send.
            permissionRequest(
              'p-meta',
              permission: 'disk.write',
              reason: 'Need to write output',
              operation: 'create',
              target: '/tmp/report.txt',
            ),
            permissionRequest('p-id-2', idKey: 'permissionId'),
            // The send fails once.
            permissionRequest('p-fail'),
            // OpenCode and Codex canonical shapes with their options.
            permissionRequest(
              'p-oc',
              title: 'bash',
              detail: '/workspace · bun test',
              options: ['approve', 'approve-session', 'reject'],
            ),
            permissionRequest(
              'p-rule',
              title: 'Approve command',
              detail:
                  "/bin/bash -lc 'codex app-server daemon restart'\n"
                  'cwd: /work\nReload corrected model catalog configuration',
              options: ['approve', 'approve-rule', 'reject'],
            ),
            permissionRequest(
              'p-two',
              title: 'Read file',
              options: ['approve', 'reject'],
            ),
            permissionRequest('p-default', title: 'Run command'),
            permissionRequest(
              'p-unknown',
              title: 'Run command',
              options: [
                'approve',
                'approve-session',
                'reject',
                'reject-with-feedback',
              ],
            ),
            permissionRequest(
              'p-only-unknown',
              title: 'Run command',
              options: ['approve', 'reject', 'escalate-to-owner'],
            ),
            // Preview and detail.
            permissionRequest(
              'p-dup',
              title: 'Bash permission',
              toolName: 'Bash',
              inputPreview: 'command: rm -rf build',
              detail: 'Bash: rm -rf build',
            ),
            permissionRequest(
              'p-full',
              title: 'Edit',
              toolName: 'Edit',
              inputPreview: 'file_path: /work/src/app.ts',
              detail:
                  'file_path: /work/src/app.ts\n'
                  'old_string: const retries = 3;\n'
                  'new_string: const retries = 5;',
            ),
            permissionRequest(
              'p-long',
              title: 'Bash',
              toolName: 'Bash',
              inputPreview: '${'command: $longCommand'.substring(0, 239)}…',
              detail: 'command: $longCommand',
            ),
            permissionRequest(
              'p-short',
              title: 'Grep',
              toolName: 'Grep',
              inputPreview: 'pattern: a',
              detail: 'pattern: a',
            ),
          ],
          setup: (broker) => studio = broker,
        );
        var sendsFail = false;
        studio.failFrame = (_, frame) =>
            sendsFail &&
            frame['kind'] == 'approve' &&
            frame['requestId'] == 'p-fail';
        Map<String, dynamic> lastDecision() => app.decisionsSent(studio).last;

        // What the card shows.
        for (final text in const [
          'permission: disk.write',
          'reason: Need to write output',
          'operation: create',
          'target: /tmp/report.txt',
        ]) {
          expect(find.text(text), findsAtLeastNWidgets(1), reason: text);
        }

        // Title, body and actions are one plain selectable decision: one
        // box, no Card around it, one selection area, no SelectableText.
        final approve = app.permissionButton('p-meta', 'approve');
        final metaCard = cardOf(approve);
        expect(
          find.ancestor(of: approve, matching: find.byType(Card)),
          findsNothing,
        );
        expect(
          find.ancestor(of: approve, matching: find.byType(TranscriptBox)),
          findsOneWidget,
        );
        expect(
          inside(metaCard, find.text('Permission request')),
          findsOneWidget,
        );
        expect(
          find.ancestor(of: approve, matching: find.byType(SelectionArea)),
          findsOneWidget,
        );
        expect(
          find.descendant(of: metaCard, matching: find.byType(SelectableText)),
          findsNothing,
        );

        // Approve says Sent and settles the buttons; the frame is exact.
        await app.answerPermission('p-meta', 'approve');
        expect(find.text('Sent'), findsOneWidget);
        expect(app.permissionAnswerable('p-meta'), isFalse);
        expect(app.canPress(app.permissionButton('p-meta', 'reject')), isFalse);
        expect(lastDecision(), containsPair('requestId', 'p-meta'));
        expect(lastDecision(), containsPair('decision', 'approve'));

        // The alternative id key answers by the same id.
        await app.answerPermission('p-id-2', 'reject');
        expect(lastDecision(), containsPair('requestId', 'p-id-2'));
        expect(lastDecision(), containsPair('decision', 'reject'));

        // A failed send says so in plain words, leaks no transport text, and
        // leaves both actions pressable; the retry goes out.
        final sent = app.decisionsSent(studio).length;
        sendsFail = true;
        await app.answerPermission('p-fail', 'approve');
        expect(find.text('Failed'), findsOneWidget);
        expect(
          find.text('Request action failed. Please retry.'),
          findsOneWidget,
        );
        app.expectNoRawErrorLeak();
        expect(app.decisionsSent(studio), hasLength(sent));
        expect(app.canPress(app.permissionButton('p-fail', 'approve')), isTrue);
        expect(app.canPress(app.permissionButton('p-fail', 'reject')), isTrue);
        sendsFail = false;
        await app.answerPermission('p-fail', 'approve');
        expect(lastDecision(), containsPair('requestId', 'p-fail'));
        expect(app.permissionAnswerable('p-fail'), isFalse);

        // OpenCode: title now, command behind the toggle, three answers.
        expect(app.permissionButtons('p-oc'), findsNWidgets(3));
        expect(find.text('bash'), findsOneWidget);
        expect(find.textContaining('/workspace · bun test'), findsNothing);
        final oc = cardOf(app.permissionButton('p-oc', 'approve'));
        expect(inside(oc, find.text('Allow once')), findsOneWidget);
        await app.tap(
          inside(oc, find.byKey(const Key('session-permission-detail-toggle'))),
        );
        expect(find.text('/workspace · bun test'), findsOneWidget);
        await app.answerPermission('p-oc', 'approve-session');
        expect(lastDecision(), containsPair('decision', 'approve-session'));

        // Codex: the whole command behind the toggle, a persistent rule.
        expect(app.permissionButtons('p-rule'), findsNWidgets(3));
        final rule = cardOf(app.permissionButton('p-rule', 'approve'));
        expect(
          inside(rule, find.text('Allow matching commands')),
          findsOneWidget,
        );
        expect(
          find.textContaining('codex app-server daemon restart'),
          findsNothing,
        );
        await app.tap(
          inside(
            rule,
            find.byKey(const Key('session-permission-detail-toggle')),
          ),
        );
        expect(
          find.textContaining('codex app-server daemon restart'),
          findsOneWidget,
        );
        expect(
          find.textContaining('Reload corrected model catalog'),
          findsOneWidget,
        );
        await app.answerPermission('p-rule', 'approve-rule');
        expect(lastDecision(), containsPair('decision', 'approve-rule'));

        // Advertised options decide the buttons: none, two, unknown ones
        // are never drawn.
        expect(app.permissionButtons('p-two'), findsNWidgets(2));
        expect(
          app.permissionButton('p-two', 'approve-session'),
          findsNothing,
        );
        final two = cardOf(app.permissionButton('p-two', 'approve'));
        expect(inside(two, find.text('Allow')), findsOneWidget);
        expect(inside(two, find.text('Allow once')), findsNothing);
        expect(app.permissionButtons('p-default'), findsNWidgets(2));
        expect(app.permissionButtons('p-unknown'), findsNWidgets(3));
        expect(find.textContaining('reject-with-feedback'), findsNothing);
        expect(app.permissionButtons('p-only-unknown'), findsNWidgets(2));
        expect(find.textContaining('escalate-to-owner'), findsNothing);

        // Preview and detail: a preview that says it all has no toggle, a
        // cut one opens to the whole call.
        final dup = cardOf(app.permissionButton('p-dup', 'approve'));
        expect(inside(dup, find.text('command: rm -rf build')), findsOneWidget);
        expect(
          inside(
            dup,
            find.byKey(const Key('session-permission-detail-toggle')),
          ),
          findsNothing,
        );
        expect(find.textContaining('Bash: rm -rf build'), findsNothing);

        final full = cardOf(app.permissionButton('p-full', 'approve'));
        expect(
          inside(full, find.text('file_path: /work/src/app.ts')),
          findsOneWidget,
        );
        expect(find.textContaining('const retries = 5;'), findsNothing);
        await app.tap(
          inside(
            full,
            find.byKey(const Key('session-permission-detail-toggle')),
          ),
        );
        final fullText = app.tester.widget<Text>(
          inside(full, find.byKey(const Key('session-permission-full-detail'))),
        );
        expect(fullText.data, contains('old_string: const retries = 3;'));
        expect(fullText.data, contains('new_string: const retries = 5;'));

        final long = cardOf(app.permissionButton('p-long', 'approve'));
        await app.tap(
          inside(
            long,
            find.byKey(const Key('session-permission-detail-toggle')),
          ),
        );
        expect(
          app.tester
              .widget<Text>(
                inside(
                  long,
                  find.byKey(const Key('session-permission-full-detail')),
                ),
              )
              .data,
          'command: $longCommand',
        );

        final short = cardOf(app.permissionButton('p-short', 'approve'));
        expect(
          inside(
            short,
            find.byKey(const Key('session-permission-detail-toggle')),
          ),
          findsNothing,
        );
      },
    );

    featureTest(
      'a settled card says who settled it, never claims the app answered what '
      'the terminal did, and a card left to the terminal says so once',
      (f) async {
        const releasedReason =
            'Claude was bypassing permission checks, and cosyncing leaves any '
            'prompt it still shows to your terminal.';
        const plan = '# Ship the release\n\n1. Tag it.\n2. Promote it.';
        await f.storage.preferences.setShowDebugViews(value: true);
        late FakeBroker studio;
        final app = await openTranscript(
          f,
          [
            permissionRequest('p-ext'),
            permissionRequest('p-race'),
            permissionRequest('p-own'),
            permissionRequest('p-own2'),
            permissionRequest('p-unk'),
            permissionRequest('p-esc'),
            permissionRequest('p-stop'),
            permissionRequest('p-none'),
            // Request and resolution already in history.
            permissionRequest('p-settled', permission: 'disk.write'),
            permissionResolved('p-settled', decision: 'approve'),
            // A resolution of one id never settles another.
            userRow('First turn', key: 'turn-a-user'),
            permissionRequest('p-a'),
            answerRow('First answer', key: 'turn-a-answer'),
            userRow('Second turn', key: 'turn-b-user'),
            permissionRequest('p-b'),
            permissionResolved('p-a', decision: 'reject'),
            // Resolutions with no request draw nothing.
            permissionResolved('ghost-perm', decision: 'reject'),
            // Cards the terminal owns: released, plan, read-only.
            permissionRequest(
              'cm-1@a1',
              title: 'Write permission',
              toolName: 'Write',
              readOnly: true,
              blocking: false,
              permissionMode: 'bypassPermissions',
              releaseReason: 'mode:bypassPermissions',
              inputPreview: 'file_path: /work/notes.md',
              detail: 'Write: /work/notes.md',
            ),
            permissionRequest(
              'cm-1@a2',
              title: 'Edit permission',
              toolName: 'Edit',
              readOnly: true,
              blocking: false,
              permissionMode: 'bypassPermissions',
              releaseReason: 'mode:bypassPermissions',
              inputPreview: 'file_path: /work/plan.md',
            ),
            permissionRequest(
              'cm-2@b2',
              toolName: 'ExitPlanMode',
              readOnly: true,
              blocking: false,
              permissionMode: 'plan',
              releaseReason: 'plan:terminal-only',
              inputPreview: 'plan: # Ship the release',
              detail: 'plan: $plan',
            ),
            permissionRequest(
              'p-ro',
              title: 'Run command',
              readOnly: true,
              options: ['approve', 'approve-session', 'reject'],
            ),
            answerRow('Ordinary answer', key: 'last'),
          ],
          setup: (broker) => studio = broker,
        );
        // The card of [id]: by its buttons, or by its outcome when it has none.
        Finder card(String id) {
          final buttons = app.permissionButton(id, 'approve');
          return cardOf(
            buttons.evaluate().isNotEmpty
                ? buttons
                : find.byKey(Key('session-detail-permission-outcome-$id')),
          );
        }

        Finder open(String id) => cardOf(app.permissionButton(id, 'approve'));

        // Request plus resolution is one disabled card with its outcome, no
        // standalone resolution row, and nothing beside it says "Pending".
        expect(find.text('Permission resolved'), findsNothing);
        expect(find.text('Question resolved'), findsNothing);
        expect(find.text('Ordinary answer'), findsOneWidget);
        expect(app.permissionAnswerable('p-settled'), isFalse);
        expect(
          inside(card('p-settled'), find.text('Approved')),
          findsOneWidget,
        );
        expect(inside(card('p-settled'), find.text('Pending')), findsNothing);
        // A resolution for one id cannot cross-pair to another.
        expect(app.permissionAnswerable('p-a'), isFalse);
        expect(app.permissionAnswerable('p-b'), isTrue);

        // A card the terminal left to itself: reason, read-only note, not
        // pending on this seat; the plan is behind its toggle.
        expect(find.text('Approval left to your terminal'), findsNWidgets(3));
        expect(find.text(releasedReason), findsNWidgets(2));
        expect(
          inside(open('p-b'), find.text(readOnlyNote)),
          findsNothing,
        );
        final plan1 = cardOf(find.text(releasedReason).first);
        expect(inside(plan1, find.text(readOnlyNote)), findsOneWidget);
        expect(inside(plan1, find.text('Pending')), findsNothing);
        expect(find.textContaining('Write: /work/notes.md'), findsNothing);
        await app.tap(
          inside(
            plan1,
            find.byKey(const Key('session-permission-detail-toggle')),
          ),
        );
        expect(find.text('Write: /work/notes.md'), findsOneWidget);
        expect(find.textContaining('Promote it.'), findsNothing);
        expect(
          find.text(
            "This is Claude's plan. Approving it also picks how Claude "
            'carries on, so answer it in your terminal.',
          ),
          findsOneWidget,
        );
        expect(app.permissionButton('cm-2@b2', 'approve'), findsNothing);
        await app.tap(
          inside(
            cardOf(find.textContaining("This is Claude's plan.")),
            find.byKey(const Key('session-permission-detail-toggle')),
          ),
        );
        expect(
          app.tester
              .widget<Text>(
                find.byKey(const Key('session-permission-full-detail')).last,
              )
              .data,
          'plan: $plan',
        );
        // A canonical read-only permission stays inert while connected.
        expect(app.permissionButtons('p-ro'), findsNothing);
        expect(
          inside(
            cardOf(find.text('Run command').last),
            find.text(readOnlyNote),
          ),
          findsOneWidget,
        );

        // This seat answers two cards; the others settle without it.
        await app.answerPermission('p-race', 'approve');
        await app.answerPermission('p-own', 'approve');
        await app.answerPermission('p-own2', 'approve');
        expect(find.text('Sent'), findsNWidgets(3));
        await app.liveAll(studio, [
          questionResolved('ghost-q'),
          permissionResolved('p-ext', decision: 'external'),
          permissionResolved('p-race', decision: 'reject', decidedBy: 'band'),
          permissionResolved('p-own', decision: 'external'),
          permissionResolved('p-own2', decision: 'external', decidedBy: 'band'),
          permissionResolved('p-unk', decision: 'some-future-decision'),
          permissionResolved(
            'p-esc',
            decision: 'external',
            releaseReason: 'band',
          ),
          permissionResolved('p-stop', decision: 'external', decidedBy: 'app'),
          permissionResolved('p-none', decision: 'external'),
          permissionResolved(
            'cm-1@a1',
            decision: 'external',
            releaseReason: 'mode:bypassPermissions',
          ),
          permissionResolved(
            'cm-1@a2',
            decision: 'approve',
            releaseReason: 'mode:bypassPermissions',
          ),
        ]);
        for (final id in const [
          'p-ext',
          'p-race',
          'p-own',
          'p-own2',
          'p-unk',
          'p-esc',
          'p-stop',
          'p-none',
        ]) {
          expect(app.permissionAnswerable(id), isFalse, reason: id);
        }
        // Nothing the app did not press was sent on its behalf.
        expect(app.decisionsSent(studio), hasLength(3));

        // "external" with nobody named: another client for a card the app
        // never answered; for one it did, its own Sent stays the truest line.
        expect(
          inside(card('p-ext'), find.text('Resolved in another client.')),
          findsOneWidget,
        );
        expect(inside(card('p-own'), find.text('Sent')), findsOneWidget);
        expect(
          inside(card('p-own'), find.text('Resolved in another client.')),
          findsNothing,
        );
        // A named seat wins over this seat's badge.
        expect(inside(card('p-race'), find.text('Sent')), findsNothing);
        expect(inside(card('p-race'), find.text('Rejected')), findsOneWidget);
        expect(
          inside(card('p-race'), find.text('Answered in your terminal')),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('session-detail-permission-decided-by-p-race')),
          findsOneWidget,
        );
        expect(inside(card('p-own2'), find.text('Sent')), findsNothing);
        expect(
          inside(card('p-own2'), find.text('Answered in your terminal')),
          findsOneWidget,
        );
        // Escape and "Show Claude's dialog" are the terminal; the app's Stop
        // is the app; no word is another client.
        expect(
          inside(card('p-esc'), find.text('You answered it in your terminal.')),
          findsOneWidget,
        );
        expect(
          inside(card('p-esc'), find.text('Resolved in another client.')),
          findsNothing,
        );
        expect(
          inside(card('p-stop'), find.text(en.sessionRequestDecidedByApp)),
          findsOneWidget,
        );
        expect(
          inside(card('p-none'), find.text(en.sessionRequestResolvedElsewhere)),
          findsOneWidget,
        );
        // A retired released card says its reason once and that the terminal
        // settled it, even when the wire carries a decision on it.
        for (final id in const ['cm-1@a1', 'cm-1@a2']) {
          final released = card(id);
          expect(inside(released, find.text(releasedReason)), findsOneWidget);
          expect(
            inside(released, find.text('Settled in your terminal.')),
            findsOneWidget,
          );
          expect(inside(released, find.text(readOnlyNote)), findsNothing);
          expect(inside(released, find.text('Pending')), findsNothing);
          expect(inside(released, find.text('Approved')), findsNothing);
          expect(
            inside(released, find.text('Resolved in another client.')),
            findsNothing,
          );
        }

        // Debug keeps the canonical resolution frames Chat does not draw.
        expect(find.text('Question resolved'), findsNothing);
        await app.tapKey('session-detail-view-menu');
        await app.tapKey('session-detail-view-item-debug');
        await app.tapKey('debug-timeline-expander');
        expect(
          find.text('message: permission-resolved', skipOffstage: false),
          findsWidgets,
        );
        expect(
          find.text('message: question-resolved', skipOffstage: false),
          findsOneWidget,
        );
      },
    );
  });

  group('stale and inert cards', () {
    featureTest(
      'a card the session stops offering stops waiting, and no card is '
      'answerable while the stream is down or the app only observes',
      (f) async {
        late FakeBroker studio;
        final app = await openTranscript(
          f,
          [
            permissionRequest('perm-gone'),
            questionRequest('q-gone', [askQuestion('Continue?')]),
            permissionRequest('perm-kept'),
            questionRequest('q-kept', [askQuestion('Continue?')]),
          ],
          setup: (broker) => studio = broker,
        );
        var attach = 0;
        // Every later attach: what the broker still holds, replayed live.
        studio.attachFrames = (socket, session) => [
          studio.helloFrame(),
          {
            'kind': 'session',
            'info': {
              ...session,
              'control': studio.controls['s1'] ?? FakeBroker.drivingControl,
            },
          },
          {
            'kind': 'history',
            'messages': const <Object?>[],
            'cursor': 'reconnect-${++attach}',
          },
          {
            'kind': 'message',
            'seq': 0,
            'message': permissionRequest('perm-kept'),
          },
          {
            'kind': 'message',
            'seq': 0,
            'message': questionRequest('q-kept', [askQuestion('Continue?')]),
          },
        ];
        Future<void> reconnect(String reason) async {
          final before = studio.socketsFor('s1').length;
          studio.socketsFor('s1').last.drop();
          await app.pumpUntil(
            () => studio.socketsFor('s1').length > before,
            reason: reason,
          );
        }

        for (final id in const ['perm-gone', 'perm-kept']) {
          expect(app.permissionAnswerable(id), isTrue, reason: id);
        }
        expect(app.canPress(app.questionControl('reject', 'q-gone')), isTrue);

        // The reconnect sends again only the cards still waiting.
        await reconnect('the stream reconnects');
        await app.waitFor(
          find.byKey(
            const Key('session-detail-permission-withdrawn-perm-gone'),
          ),
        );
        expect(
          find.byKey(const Key('session-detail-question-withdrawn-q-gone')),
          findsOneWidget,
        );
        expect(find.text('No longer waiting for an answer.'), findsNWidgets(2));
        expect(find.text('Resolved in another client.'), findsNothing);
        expect(app.permissionAnswerable('perm-gone'), isFalse);
        expect(app.canPress(app.questionControl('reject', 'q-gone')), isFalse);
        expect(app.permissionAnswerable('perm-kept'), isTrue);
        expect(app.canPress(app.questionControl('reject', 'q-kept')), isTrue);

        // The stream is down: the cards that were waiting cannot be answered.
        studio.socketsAccepted = false;
        studio.socketsFor('s1').last.drop();
        await app.pumpUntil(
          () => !app.permissionAnswerable('perm-kept'),
          reason: 'a card is not answerable without a stream',
        );
        expect(app.canPress(app.questionControl('reject', 'q-kept')), isFalse);
        expect(
          app.canPress(app.questionControl('answer-button', 'q-kept')),
          isFalse,
        );
        studio.socketsAccepted = true;
        await app.pumpUntil(
          () => app.permissionAnswerable('perm-kept'),
          reason: 'the stream comes back and the card waits again',
        );

        // Observing: the cards are drawn, and none can be answered.
        studio.controls['s1'] = controlBlock(
          drive: driveBlock('observing'),
          terminalSync: syncBlock(supported: false),
        );
        await reconnect('the app attaches as an observer');
        await app.pumpUntil(
          () => app.composerIsReadOnly,
          reason: 'the observe bar',
        );
        expect(app.permissionButtons('perm-kept'), findsNWidgets(2));
        expect(app.permissionAnswerable('perm-kept'), isFalse);
        expect(
          app.canPress(app.permissionButton('perm-kept', 'reject')),
          isFalse,
        );
        expect(app.canPress(app.questionControl('reject', 'q-kept')), isFalse);
        expect(
          app.canPress(app.questionControl('answer-button', 'q-kept')),
          isFalse,
        );
        expect(app.decisionsSent(studio), isEmpty);
      },
    );
  });

  group('question cards', () {
    featureTest(
      'a question is answered, dismissed or refused empty, with each kind of '
      'question taking only the answers it accepts',
      (f) async {
        late FakeBroker studio;
        final app = await openTranscript(
          f,
          [
            questionRequest('q-free', [askQuestion('Which server runs this?')]),
            // An older adapter's flat shape.
            {
              'type': 'question-request',
              'questionId': 'q-flat',
              'question': 'Continue?',
              'prompt': 'Continue this step?',
            },
            questionRequest('q-fail', [askQuestion('Continue?')]),
            questionRequest('q-dismiss', [askQuestion('Continue?')]),
            // OpenCode: one answer array per question.
            questionRequest('q-oc', [
              askQuestion(
                'How should the migration run?',
                header: 'Migration',
                options: [
                  {
                    'label': 'Apply now',
                    'description': 'Run it before the next turn.',
                  },
                  {'label': 'Defer'},
                ],
                multiple: false,
              ),
              askQuestion(
                'Which checks should run?',
                header: 'Checks',
                options: [
                  {'label': 'Tests'},
                  {'label': 'Docs', 'description': 'Validate generated docs.'},
                ],
                multiple: true,
              ),
            ]),
            // Labels only: no free text for the multi-select (MB5b).
            questionRequest('q-labels', [
              askQuestion(
                'Which checks?',
                options: [
                  {'label': 'Lint'},
                  {'label': 'Test'},
                ],
                multiple: true,
                freeText: false,
              ),
              askQuestion(
                'Which build?',
                options: [
                  {'label': 'Debug'},
                  {'label': 'Release'},
                ],
              ),
            ]),
            // A number in its range, and only that (NQ1).
            questionRequest('q-num', [
              askQuestion(
                'How many slides?',
                options: <Object>[],
                kind: 'number',
                min: 3,
                max: 12,
                step: 1,
                unit: 'slides',
              ),
            ]),
            // Left to the terminal, and one the app could not even read.
            questionRequest(
              'q-term',
              [
                askQuestion(
                  'Which sizes?',
                  options: [
                    {'label': 'Small, cheap'},
                    {'label': 'Large'},
                  ],
                  multiple: true,
                  freeText: false,
                ),
              ],
              readOnly: true,
              blocking: false,
              answerInTerminal: true,
            ),
            questionRequest(
              'q-unread',
              const [],
              readOnly: true,
              blocking: false,
              answerInTerminal: true,
            ),
            questionRequest('q-watch', [
              askQuestion(
                'Which branch?',
                options: [
                  {'label': 'main'},
                  {'label': 'release'},
                ],
              ),
            ], readOnly: true),
            // Two cards of different sizes: typing on one never leaks to the
            // other when history is replaced above them.
            questionRequest('q-short', [
              askQuestion(
                'Short one?',
                options: [
                  {'label': 'a'},
                ],
              ),
            ]),
            questionRequest('q-long', [
              askQuestion(
                'Long one A?',
                options: [
                  {'label': 'x'},
                ],
              ),
              askQuestion(
                'Long one B?',
                options: [
                  {'label': 'y'},
                ],
              ),
            ]),
          ],
          setup: (broker) => studio = broker,
        );
        studio.failFrame = (_, frame) =>
            frame['kind'] == 'answer' && frame['requestId'] == 'q-fail';
        Map<String, dynamic> lastDecision() => app.decisionsSent(studio).last;

        // Title, input and actions are one plain selectable decision.
        final freeButton = app.questionControl('answer-button', 'q-free');
        final freeCard = cardOf(freeButton);
        expect(
          find.ancestor(of: freeButton, matching: find.byType(Card)),
          findsNothing,
        );
        expect(inside(freeCard, find.text('Question')), findsOneWidget);
        expect(
          inside(freeCard, find.text('Which server runs this?')),
          findsOneWidget,
        );
        expect(inside(freeCard, find.byType(TextField)), findsOneWidget);
        expect(
          find.ancestor(of: freeButton, matching: find.byType(SelectionArea)),
          findsOneWidget,
        );

        // The flat shape shows its question and prompt and splits lines into
        // answers.
        expect(find.text('question: Continue?'), findsAtLeastNWidgets(1));
        expect(
          find.text('prompt: Continue this step?'),
          findsAtLeastNWidgets(1),
        );
        await app.enterText(
          app.questionControl('answer', 'q-flat'),
          'yes\nmaybe later',
        );
        await app.sendAnswer('q-flat');
        expect(lastDecision(), containsPair('requestId', 'q-flat'));
        expect(lastDecision()['answers'], [
          ['yes'],
          ['maybe later'],
        ]);

        // Nothing is sent for an empty answer.
        expect(
          app.canPress(app.questionControl('answer-button', 'q-free')),
          isFalse,
        );
        await app.enterText(
          app.questionControl('custom', 'q-free', '-0'),
          'prod-1',
        );
        await app.sendAnswer('q-free');
        expect(lastDecision(), containsPair('requestId', 'q-free'));
        expect(lastDecision()['answers'], [
          ['prod-1'],
        ]);
        expect(app.decisionsSent(studio).first['kind'], 'answer');
        expect(find.text('Sent'), findsNWidgets(2));
        expect(
          app.canPress(app.questionControl('answer-button', 'q-free')),
          isFalse,
        );
        expect(app.canPress(app.questionControl('reject', 'q-free')), isFalse);

        // A refused send keeps what was typed and says it failed.
        await app.enterText(
          app.questionControl('custom', 'q-fail', '-0'),
          'yes',
        );
        await app.sendAnswer('q-fail');
        expect(find.text('Failed'), findsOneWidget);
        expect(
          app.tester
              .widget<TextField>(app.questionControl('custom', 'q-fail', '-0'))
              .controller
              ?.text,
          'yes',
        );
        app.expectNoRawErrorLeak();
        expect(
          app.canPress(app.questionControl('answer-button', 'q-fail')),
          isTrue,
        );

        // Dismiss tells the broker and closes the card's actions.
        await app.tap(app.questionControl('reject', 'q-dismiss'));
        expect(lastDecision(), containsPair('kind', 'reject-question'));
        expect(lastDecision(), containsPair('requestId', 'q-dismiss'));
        expect(
          app.canPress(app.questionControl('reject', 'q-dismiss')),
          isFalse,
        );

        // OpenCode: options and their descriptions, one array per question.
        expect(find.text('Migration'), findsOneWidget);
        expect(find.text('Run it before the next turn.'), findsOneWidget);
        expect(find.text('Validate generated docs.'), findsOneWidget);
        for (final pick in const [(0, 0), (1, 0), (1, 1)]) {
          await app.tap(app.questionOption('q-oc', pick.$1, pick.$2));
        }
        await app.sendAnswer('q-oc');
        expect(lastDecision()['answers'], [
          ['Apply now'],
          ['Tests', 'Docs'],
        ]);

        // A multi-select that takes only labels has no free-text field.
        expect(app.questionControl('custom', 'q-labels', '-0'), findsNothing);
        expect(app.questionControl('custom', 'q-labels', '-1'), findsOneWidget);
        for (final pick in const [(0, 0), (0, 1), (1, 1)]) {
          await app.tap(app.questionOption('q-labels', pick.$1, pick.$2));
        }
        await app.sendAnswer('q-labels');
        expect(lastDecision()['answers'], [
          ['Lint', 'Test'],
          ['Release'],
        ]);

        // A number question sends one number in its range, nothing else.
        final field = app.questionControl('number', 'q-num', '-0');
        expect(find.text('A number from 3 to 12'), findsOneWidget);
        expect(find.text('slides'), findsOneWidget);
        for (final refused in const ['20', '2', 'five', '1e1', '']) {
          await app.enterText(field, refused);
          expect(
            app.canPress(app.questionControl('answer-button', 'q-num')),
            isFalse,
            reason: 'Send waits for a number it takes, not "$refused"',
          );
        }
        expect(find.text('Enter a number from 3 to 12.'), findsNothing);
        await app.enterText(field, '20');
        expect(find.text('Enter a number from 3 to 12.'), findsOneWidget);
        await app.enterText(field, '12');
        expect(find.text('Enter a number from 3 to 12.'), findsNothing);
        await app.sendAnswer('q-num');
        expect(lastDecision()['answers'], [
          ['12'],
        ]);

        // A question the terminal owns: drawn, read-only, says where.
        expect(find.text(waitingInTerminal), findsNWidgets(2));
        expect(app.questionControl('custom', 'q-term', '-0'), findsNothing);
        expect(app.questionControl('answer-button', 'q-term'), findsNothing);
        expect(app.questionControl('reject', 'q-term'), findsNothing);
        expect(app.canPress(app.questionOption('q-term', 0, 0)), isFalse);
        expect(app.questionControl('answer', 'q-unread'), findsNothing);
        expect(find.text(readOnlyNote), findsOneWidget);
        expect(app.canPress(app.questionOption('q-watch', 0, 0)), isFalse);

        // Typing on one card never leaks to another when history is replaced
        // above it.
        final before = app.decisionsSent(studio).length;
        await app.enterText(
          app.questionControl('custom', 'q-long', '-0'),
          'typed-into-q-long',
        );
        app.socket(studio).emit({
          'kind': 'history',
          'messages': [
            userRow('prepended message', key: 'u0'),
            questionRequest('q-short', [
              askQuestion(
                'Short one?',
                options: [
                  {'label': 'a'},
                ],
              ),
            ]),
            questionRequest('q-long', [
              askQuestion(
                'Long one A?',
                options: [
                  {'label': 'x'},
                ],
              ),
              askQuestion(
                'Long one B?',
                options: [
                  {'label': 'y'},
                ],
              ),
            ]),
          ],
          'reset': true,
          'cursor': 'reset-1',
        });
        await app.settle();
        expect(find.text('prepended message'), findsOneWidget);
        expect(
          app.tester
                  .widget<TextField>(
                    app.questionControl('custom', 'q-short', '-0'),
                  )
                  .controller
                  ?.text ??
              '',
          isEmpty,
        );
        expect(app.questionControl('custom', 'q-long', '-0'), findsOneWidget);
        expect(app.questionControl('custom', 'q-long', '-1'), findsOneWidget);
        expect(app.decisionsSent(studio), hasLength(before));
      },
    );
  });

  group('settled questions', () {
    featureTest(
      'a settled question shows its answer and says who closed it, live and '
      'after a history reset, in every language',
      (f) async {
        const colour = {
          'question': 'Which colour?',
          'header': 'Colour',
          'multiple': false,
          'options': [
            {'label': 'Amber'},
            {'label': 'Teal'},
          ],
        };
        const checks = {
          'question': 'Which checks?',
          'header': 'Checks',
          'multiple': true,
          'options': [
            {'label': 'Lint'},
            {'label': 'Small, cheap'},
            {'label': 'Types'},
          ],
        };
        // Each end the broker reports, and the sentence a card shows for it.
        final ends =
            <
              ({
                String id,
                Map<String, Object?> by,
                bool answered,
                String Function(AppLocalizations) sentence,
              })
            >[
              (
                id: 'e-app',
                by: {'decidedBy': 'app'},
                answered: true,
                sentence: (l) => l.sessionRequestDecidedByApp,
              ),
              (
                id: 'e-band',
                by: {'releaseReason': 'band'},
                answered: true,
                sentence: (l) => l.sessionRequestReleaseBand,
              ),
              (
                id: 'e-expired',
                by: {'decidedBy': 'expired', 'releaseReason': 'expired'},
                answered: true,
                sentence: (l) => l.sessionRequestReleaseExpired,
              ),
              (
                id: 'e-none',
                by: const {},
                answered: true,
                sentence: (l) => l.sessionQuestionSettledElsewhere,
              ),
              (
                id: 'e-esc',
                by: {'releaseReason': 'band'},
                answered: false,
                sentence: (l) => l.sessionQuestionClosedUnansweredInTerminal,
              ),
              (
                id: 'e-stop',
                by: {'decidedBy': 'app'},
                answered: false,
                sentence: (l) => l.sessionQuestionClosedUnansweredInApp,
              ),
              (
                id: 'e-lapsed',
                by: {'decidedBy': 'expired', 'releaseReason': 'expired'},
                answered: false,
                sentence: (l) => l.sessionRequestReleaseExpired,
              ),
              // An older broker names nobody and sends no answers.
              (
                id: 'e-old',
                by: const {},
                answered: false,
                sentence: (l) => l.sessionQuestionSettledElsewhere,
              ),
            ];
        Map<String, Object?> asked(String id, {bool readOnly = false}) =>
            questionRequest(id, [colour], readOnly: readOnly ? true : null);
        Map<String, Object?> closed(
          ({
            String id,
            Map<String, Object?> by,
            bool answered,
            String Function(AppLocalizations) sentence,
          })
          end,
        ) => {
          ...questionResolved(
            end.id,
            answers: end.answered
                ? const [
                    ['Teal'],
                  ]
                : null,
          ),
          ...end.by,
        };

        late FakeBroker studio;
        final app = await openTranscript(
          f,
          [
            for (final end in ends) asked(end.id),
            // Sent from this app; dismissed from this app.
            asked('a-app'),
            asked('a-dismiss'),
            // Answered in the terminal: picks checked, typed text as text.
            questionRequest('a-term', [colour, checks], readOnly: true),
            // The card the app could answer moves to the agent's own picker.
            questionRequest('r-held', [colour]),
            questionRequest('r-nonblocking', [colour], blocking: false),
            // Open in the terminal: still awaiting an answer.
            asked('h-open', readOnly: true),
            asked('h-settled', readOnly: true),
          ],
          setup: (broker) => studio = broker,
        );
        String? outcome(String id) => app.questionOutcome(id);
        Future<void> expectSentences(AppLocalizations l10n) async {
          for (final end in ends) {
            expect(outcome(end.id), end.sentence(l10n), reason: end.id);
          }
        }

        // This app's own answer and dismissal.
        await app.tap(app.questionOption('a-app', 0, 1));
        await app.sendAnswer('a-app');
        await app.tap(app.questionControl('reject', 'a-dismiss'));
        expect(app.decisionsSent(studio).map((f) => f['kind']), [
          'answer',
          'reject-question',
        ]);
        expect(app.decisionsSent(studio).first['answers'], [
          ['Teal'],
        ]);

        // r-*: restated as open in the terminal, then settled there.
        const inTerminal = {'readOnly': true, 'answerInTerminal': true};
        Map<String, Object?> restated(String id) => {
          ...questionRequest(id, [colour]),
          ...inTerminal,
        };
        for (final id in const ['r-held', 'r-nonblocking']) {
          expect(app.canPress(app.questionOption(id, 0, 1)), isTrue);
        }
        await app.liveAll(studio, [
          restated('r-held'),
          restated('r-nonblocking'),
        ]);
        for (final id in const ['r-held', 'r-nonblocking']) {
          expect(
            app.canPress(app.questionOption(id, 0, 1)),
            isFalse,
            reason: id,
          );
          expect(app.questionControl('answer-button', id), findsNothing);
          expect(
            app.questionControl('in-terminal', id),
            findsOneWidget,
            reason: id,
          );
        }

        // Read-only cards still open: a-term, h-open, h-settled and the two
        // restated cards all wait on somebody; once settled they do not.
        expect(
          find.textContaining(en.sessionRequestAwaitingAnswer),
          findsNWidgets(5),
        );

        await app.liveAll(studio, [
          for (final end in ends) closed(end),
          questionResolved(
            'a-app',
            answers: const [
              ['Teal'],
            ],
            decidedBy: 'app',
          ),
          questionResolved('a-dismiss', decidedBy: 'app'),
          questionResolved(
            'a-term',
            answers: const [
              ['a dark green'],
              ['Lint', 'Small, cheap'],
            ],
          ),
          // A bare resolution after the answer does not take it away.
          questionResolved('a-term'),
          questionResolved(
            'r-held',
            answers: const [
              ['Teal'],
            ],
          ),
          questionResolved(
            'r-nonblocking',
            answers: const [
              ['Teal'],
            ],
          ),
          questionResolved('h-settled'),
        ]);

        await expectSentences(en);
        expect(outcome('a-app'), en.sessionRequestDecidedByApp);
        expect(app.optionChecked('a-app', 0, 1), isTrue);
        expect(app.optionChecked('a-app', 0, 0), isFalse);
        expect(app.canPress(app.questionOption('a-app', 0, 1)), isFalse);
        expect(app.questionControl('typed', 'a-app', '-0'), findsNothing);
        expect(outcome('a-dismiss'), en.sessionQuestionClosedUnansweredInApp);
        // Typed text is text, never an option; every pick is checked.
        expect(app.optionChecked('a-term', 0, 0), isFalse);
        expect(app.optionChecked('a-term', 0, 1), isFalse);
        expect(
          find.descendant(
            of: app.questionControl('typed', 'a-term', '-0'),
            matching: find.text('a dark green'),
          ),
          findsOneWidget,
        );
        expect(app.optionChecked('a-term', 1, 0), isTrue);
        expect(app.optionChecked('a-term', 1, 1), isTrue);
        expect(app.optionChecked('a-term', 1, 2), isFalse);
        expect(app.questionControl('typed', 'a-term', '-1'), findsNothing);
        for (final id in const ['r-held', 'r-nonblocking']) {
          expect(outcome(id), en.sessionRequestSettledInTerminal, reason: id);
          expect(app.optionChecked(id, 0, 1), isTrue, reason: id);
        }
        expect(
          find.textContaining(en.sessionRequestAwaitingAnswer),
          findsOneWidget,
        );
        expect(outcome('h-settled'), en.sessionQuestionSettledElsewhere);

        // A history reset replays the settled cards: nothing changes.
        app.socket(studio).emit({
          'kind': 'history',
          'messages': [
            for (final end in ends) ...[asked(end.id), closed(end)],
            asked('a-app'),
            questionResolved(
              'a-app',
              answers: const [
                ['Teal'],
              ],
              decidedBy: 'app',
            ),
            asked('a-dismiss'),
            questionResolved('a-dismiss', decidedBy: 'app'),
            questionRequest('a-term', [colour, checks], readOnly: true),
            questionResolved(
              'a-term',
              answers: const [
                ['a dark green'],
                ['Lint', 'Small, cheap'],
              ],
            ),
            restated('r-held'),
            questionResolved(
              'r-held',
              answers: const [
                ['Teal'],
              ],
            ),
            asked('h-open', readOnly: true),
          ],
          'reset': true,
          'cursor': 'reset-1',
        });
        await app.settle();
        await expectSentences(en);
        expect(outcome('a-app'), en.sessionRequestDecidedByApp);
        expect(app.optionChecked('a-app', 0, 1), isTrue);
        expect(outcome('a-dismiss'), en.sessionQuestionClosedUnansweredInApp);
        expect(app.optionChecked('a-term', 1, 1), isTrue);
        expect(outcome('r-held'), en.sessionRequestSettledInTerminal);
        expect(app.optionChecked('r-held', 0, 1), isTrue);
        expect(app.canPress(app.questionOption('r-held', 0, 1)), isFalse);

        // The same sentences in every language.
        for (final locale in const ['zh', 'ja', 'ko', 'es']) {
          await app.container
              .read(localeControllerProvider.notifier)
              .setLocale(Locale(locale));
          await app.settle();
          final l10n = lookupAppLocalizations(Locale(locale));
          await expectSentences(l10n);
          expect(
            outcome('a-app'),
            l10n.sessionRequestDecidedByApp,
            reason: locale,
          );
          expect(
            outcome('r-held'),
            l10n.sessionRequestSettledInTerminal,
            reason: locale,
          );
          expect(
            find.textContaining(l10n.sessionRequestAwaitingAnswer),
            findsOneWidget,
            reason: locale,
          );
        }
      },
    );
  });
}
