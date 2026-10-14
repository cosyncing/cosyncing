// F03a — Transcript rendering: what a row looks like. Every scenario opens a
// session through the real App and feeds history/live frames over the fake
// session socket (`support/feature/transcript_wire.dart`).
// Long fixture strings and bidi controls are the data under test.
// ignore_for_file: lines_longer_than_80_chars, text_direction_code_point_in_literal
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/app_driver.dart';
import '../support/feature/cosyncing_app.dart';
import '../support/feature/fake_broker.dart';
import '../support/feature/session_driver.dart';
import '../support/feature/transcript_wire.dart';

final AppLocalizations en = lookupAppLocalizations(const Locale('en'));

Finder toolRow(String callId) => find.byKey(ValueKey('tool-$callId-details'));

void main() {
  group('conversation rows', () {
    featureTest('a prompt and its answer show once, with no transport fields', (
      f,
    ) async {
      final app = await openTranscript(f, [
        userRow(
          'Fix the login bug',
          key: 'user-key-1',
          turnId: 'turn-9',
          extra: {'sentAt': 1791971336003, 'clientKey': 'client-abc'},
        ),
        answerRow('Done: the login form validates again.', key: 'answer-key-1'),
        runSummaryRow('turn-9'),
      ]);
      expect(app.shown('Fix the login bug'), 1);
      expect(app.shown('Done: the login form validates again.'), 1);
      for (final internal in [
        'user-key-1',
        'answer-key-1',
        'turn-9',
        'client-abc',
        'user-message',
        'model-output',
      ]) {
        expect(app.visibleText, isNot(contains(internal)), reason: internal);
      }
      // The user's bubble sits to the right of the answer.
      final bubble = find.textContaining('Fix the login bug');
      final answer = find.textContaining('Done: the login form');
      expect(
        app.tester.getTopLeft(bubble).dx,
        greaterThan(app.tester.getTopLeft(answer).dx),
      );
    });

    featureTest('one row of every canonical type renders; an unknown type '
        'becomes a generic card and an unnamed event is kept', (f) async {
      final app = await openTranscript(f, [
        userRow('hello there', key: 'u1', turnId: 't1'),
        answerRow('Hi **bold** answer', key: 'm1'),
        row('thinking', {'text': 'Considering', 'key': 'th1'}),
        row('status', {'status': 'Working on task'}),
        toolCallRow('c1', semantic: commandSemantic('ls', state: 'running')),
        toolResultRow('c1', semantic: commandSemantic('ls', stdout: 'a\nb')),
        row('terminal-output', {'command': 'git status'}),
        row('notice', {'message': 'Broker notice'}),
        row('metadata-update', {
          'key': 'runtimeTotals',
          'value': {'totalRuntimeMs': 125000},
        }),
        row('token-count', {'input': 100, 'output': 50}),
        row('file-artifact', {'path': '/tmp/reports/report.md', 'size': 1240}),
        row('permission-request', {
          'requestId': 'p1',
          'permission': 'disk.write',
          'reason': 'Need to write output',
        }),
        row('question-request', {
          'requestId': 'q1',
          'question': 'Proceed with this step?',
        }),
        row('history-reset', {'notice': 'Reverted to an earlier message'}),
        row('error', {'code': 'E_TEST', 'message': 'Render failed'}),
        row('event', {
          'name': 'session.forked',
          'payload': {'from': 's-1'},
        }),
        row('event', {
          'payload': {'anything': 1},
        }),
        row('future-type', {'payload': 'fallback-only'}),
        runSummaryRow('t1'),
      ]);
      app.expectInOrder([
        'hello there',
        'Hi bold answer',
        'Thinking',
        'git status',
        'Broker notice',
        '/tmp/reports/report.md',
        'disk.write',
        'Need to write output',
        'Proceed with this step?',
        'Reverted to an earlier message',
        'Render failed',
        'session.forked',
        'Unsupported message type',
        'fallback-only',
      ]);
      expect(toolRow('c1'), findsOneWidget);
      // The unnamed event is a card of its own (two "Event" headings).
      expect(find.text('Event'), findsNWidgets(2));
      // Bookkeeping frames are captions or state, never cards.
      expect(app.visibleText, isNot(contains('runtimeTotals')));
    });

    featureTest('bookkeeping never becomes a row; errors and notices beside it '
        'always render', (f) async {
      final app = await openTranscript(f, [
        row('event', {
          'name': 'claude.init',
          'payload': {'model': 'claude-haiku-4-5'},
        }),
        row('event', {
          'name': 'dsh.session-event',
          'payload': {'eventType': 'run/started', 'seq': 3},
        }),
        row('event', {
          'name': 'init',
          'payload': {'model': 'legacy-init-model'},
        }),
        row('event', {
          'name': 'transcript.unknown-type',
          'payload': {'lineType': 'fork-context-ref'},
        }),
        row('metadata-update', {
          'key': 'sessionUsage',
          'value': 'inputTokens: 11191; outputTokens: 107',
        }),
        row('event', {
          'name': 'session.renamed',
          'payload': {'title': 'x'},
        }),
        row('notice', {'message': 'the terminal took over'}),
        row('error', {'message': 'the session failed'}),
      ]);
      for (final hidden in [
        'claude.init',
        'claude-haiku-4-5',
        'dsh.session-event',
        'run/started',
        'legacy-init-model',
        'transcript.unknown-type',
        'fork-context-ref',
        'sessionUsage',
        'inputTokens',
      ]) {
        expect(app.visibleText, isNot(contains(hidden)), reason: hidden);
      }
      // An ordinary event next to them still shows: suppression is by name.
      expect(app.visibleText, contains('session.renamed'));
      expect(app.visibleText, contains('the terminal took over'));
      expect(app.visibleText, contains('the session failed'));
    });

    // Captured from the broker over each adapter's fake native store
    // (e2e/adapters/kits/capture-history-frames.ts). Weaker evidence than a
    // capture from the real agent: the fake store holds plain conversation.
    for (final agent in CapturedHistory.agents) {
      featureTest("the $agent adapter's normalized history frame shows its "
          'conversation in order, once, without bookkeeping', (f) async {
        final captured = CapturedHistory.load(agent);
        final app = await openTranscript(f, captured.messages, tool: agent);
        app.expectInOrder(captured.texts);
        for (final text in captured.texts) {
          expect(app.shown(text), 1, reason: '$agent shows "$text" once');
        }
        for (final internal in ['run-summary', 'metadata-update', 'status']) {
          expect(app.visibleText, isNot(contains(internal)));
        }
        // No row carries an adapter key or turn id.
        expect(app.visibleText, isNot(contains('turn-seed')));
      });
    }
  });

  group('streaming and replay', () {
    featureTest('same-key deltas grow one row in place; an authoritative '
        'snapshot replaces them', (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final app = await openTranscript(f, [
        userRow('Explain', key: 'u1'),
      ], broker: studio);
      await app.live(studio, answerDelta('Hello', 'turn-1:text'));
      expect(app.shown('Hello'), 1);
      await app.live(studio, answerDelta(' world', 'turn-1:text'));
      expect(app.shown('Hello world'), 1);
      expect(app.visibleText, isNot(contains('Hello\n')));
      // The authoritative snapshot (a history frame) replaces the deltas.
      socketOf(app, studio).emit({
        'kind': 'history',
        'messages': [
          userRow('Explain', key: 'u1'),
          answerRow('Complete answer', key: 'turn-1:text'),
        ],
        'cursor': 'cursor-2',
      });
      await app.settle();
      expect(app.shown('Complete answer'), 1);
      expect(app.visibleText, isNot(contains('Hello world')));
    });

    featureTest('a catch-up copy of a delivered final neither duplicates nor '
        'demotes it', (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final app = await openTranscript(f, [
        userRow('Question', key: 'u1', turnId: 't1'),
        answerRow('The answer is 42.', key: 'codex:turn-1:msg_abc:t'),
        runSummaryRow('t1'),
      ], broker: studio);
      await app.live(
        studio,
        answerRow(
          'The answer is 42.',
          key: 'codex:turn-1:msg_abc:t',
          final_: false,
        ),
      );
      expect(app.shown('The answer is 42.'), 1);
      // Still a completed message: the turn footer's Copy is offered.
      expect(find.byKey(const Key('conversation-turn-copy')), findsOneWidget);
    });

    featureTest('replays with stable ids dedupe; identical text under another '
        'key stays a second bubble', (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final rows = [
        userRow('Continue', key: 'user-1'),
        userRow('Continue', key: 'user-2'),
        toolCallRow('call-1', semantic: commandSemantic('make')),
        toolResultRow('call-1', semantic: commandSemantic('make')),
        row('permission-request', {
          'requestId': 'perm-1',
          'title': 'Old title',
        }),
      ];
      final app = await openTranscript(f, rows, broker: studio);
      expect(app.shown('Continue'), 2);
      // A reconnect replays everything, the permission under a new title.
      socketOf(app, studio).emit({
        'kind': 'history',
        'messages': [
          ...rows.sublist(0, 4),
          row('permission-request', {
            'requestId': 'perm-1',
            'title': 'Current title',
          }),
        ],
        'cursor': 'cursor-2',
      });
      await app.settle();
      expect(app.shown('Continue'), 2);
      expect(toolRow('call-1'), findsOneWidget);
      expect(app.shown('Current title'), 1);
      expect(app.visibleText, isNot(contains('Old title')));
    });

    featureTest('a queued bubble is replaced by its delivered message, matched '
        'by key', (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final app = await openTranscript(f, [
        userRow('First turn', key: 'u0'),
        answerRow('Working on it', key: 'm0'),
        userRow('Run the checks', key: 'user-message-1', queued: true),
      ], broker: studio);
      expect(
        find.byKey(const Key('queued-user-message-badge')),
        findsOneWidget,
      );
      await app.live(studio, userRow('Run the checks', key: 'user-message-1'));
      expect(app.shown('Run the checks'), 1);
      expect(find.byKey(const Key('queued-user-message-badge')), findsNothing);
    });
  });

  group('tools', () {
    featureTest('one invocation is one card however calls and results '
        'interleave', (f) async {
      final app = await openTranscript(f, [
        userRow('Run both', key: 'u1'),
        toolCallRow(
          'exec-a',
          semantic: commandSemantic('make a', state: 'running'),
        ),
        toolCallRow(
          'exec-b',
          semantic: commandSemantic('make b', state: 'running'),
        ),
        row('thinking', {'text': 'Waiting on the commands', 'key': 'th'}),
        row('token-count', {'input': 10, 'output': 5}),
        toolResultRow(
          'exec-b',
          semantic: commandSemantic('make b', stdout: 'b ok'),
        ),
        toolResultRow(
          'exec-a',
          semantic: commandSemantic('make a', state: 'failed'),
        ),
        // A result whose call was cut from history renders alone.
        toolResultRow('exec-lost', semantic: commandSemantic('lost cmd')),
        // A call still running renders alone.
        toolCallRow(
          'exec-live',
          semantic: commandSemantic('sleep 60', state: 'running'),
        ),
      ]);
      for (final id in ['exec-a', 'exec-b', 'exec-lost', 'exec-live']) {
        expect(toolRow(id), findsOneWidget, reason: id);
      }
      app.expectInOrder(['make a', 'make b', 'lost cmd', 'sleep 60']);
      // Each card carries its own state: a failed, b and lost completed, live running.
      String stateOf(String id) => app.textOf(
        find.ancestor(
          of: toolRow(id),
          matching: find.byKey(ValueKey('tool-card-$id')),
        ),
      );
      expect(stateOf('exec-a'), contains('failed'));
      expect(stateOf('exec-b'), contains('completed'));
      expect(stateOf('exec-lost'), contains('completed'));
      expect(stateOf('exec-live'), contains('running'));
    });

    featureTest('a repeated call id pairs each call with its own result', (
      f,
    ) async {
      final app = await openTranscript(f, [
        // Adapters key every row; the call id alone repeats.
        toolCallRow(
          'exec-1',
          extra: {'key': 'k1:call'},
          semantic: commandSemantic('first run', state: 'running'),
        ),
        toolResultRow(
          'exec-1',
          extra: {'key': 'k1:result'},
          semantic: commandSemantic('first run', state: 'failed'),
        ),
        toolCallRow(
          'exec-1',
          extra: {'key': 'k2:call'},
          semantic: commandSemantic('second run', state: 'running'),
        ),
        toolResultRow(
          'exec-1',
          extra: {'key': 'k2:result'},
          semantic: commandSemantic('second run'),
        ),
      ]);
      expect(toolRow('exec-1'), findsNWidgets(2));
      final cards = find.byKey(const ValueKey('tool-card-exec-1'));
      expect(cards, findsNWidgets(2));
      expect(
        app.textOf(cards.at(0)),
        allOf(contains('first run'), contains('failed')),
      );
      expect(
        app.textOf(cards.at(1)),
        allOf(contains('second run'), contains('completed')),
      );
    });

    featureTest('consecutive lookups group, keep their own times, and an '
        'execute or answer row ends the group', (f) async {
      final app = await openTranscript(f, [
        userRow('Inspect it', key: 'u1'),
        toolCallRow(
          'read-1',
          toolClass: 'lookup',
          toolName: 'Read',
          extra: {'timestamp': 1791971336000},
        ),
        toolResultRow(
          'read-1',
          toolClass: 'lookup',
          toolName: 'Read',
          extra: {'timestamp': 1791971336000},
        ),
        toolCallRow(
          'grep-1',
          toolClass: 'lookup',
          toolName: 'Grep',
          extra: {'timestamp': 1791971399000},
        ),
        toolResultRow(
          'grep-1',
          toolClass: 'lookup',
          toolName: 'Grep',
          extra: {'timestamp': 1791971399000},
        ),
        toolCallRow('exec-1'),
        toolCallRow('read-2', toolClass: 'lookup'),
        answerRow('Looked', key: 'm1', final_: false),
        toolCallRow('read-3', toolClass: 'lookup'),
        // A missing or unknown class is never grouped.
        row('tool-call', {'callId': 'no-class'}),
        toolCallRow('future-1', toolClass: 'future-class'),
        row('tool-call', {'callId': 'future-2', 'toolClass': 'future-class'}),
      ]);
      expect(find.byKey(const ValueKey('lookup-group-read-1')), findsOneWidget);
      expect(find.text(en.lookupsCount(2)), findsOneWidget);
      // Only the first group exists: read-2 and read-3 are lone rows.
      expect(
        find.textContaining(en.lookupsCount(2).replaceAll('2', '')),
        findsOneWidget,
      );
      for (final lone in [
        'exec-1',
        'read-2',
        'read-3',
        'no-class',
        'future-1',
        'future-2',
      ]) {
        expect(toolRow(lone), findsOneWidget, reason: lone);
      }
      // The group opens to its children, each with its own time.
      await app.tap(find.byKey(const ValueKey('lookup-group-details-0')));
      expect(toolRow('read-1'), findsOneWidget);
      expect(toolRow('grep-1'), findsOneWidget);
      final times = find.byKey(const Key('transcript-message-time'));
      expect(times, findsNWidgets(2));
      expect(
        app.textOf(times.at(0)) == app.textOf(times.at(1)),
        isFalse,
        reason: 'each child keeps its own timestamp',
      );
    });

    for (final viewport in [
      FeatureViewport.phoneTall,
      FeatureViewport.desktopTall,
    ]) {
      featureTest('a tool row starts collapsed and expands and collapses in '
          'place at ${viewport.size.width.toInt()} dp', (f) async {
        final app = await openTranscript(
          f,
          [
            toolResultRow(
              'c1',
              semantic: commandSemantic('echo hi', stdout: 'hello from stdout'),
              extra: {'durationMs': 1500},
            ),
          ],
          viewport: viewport,
        );
        expect(app.visibleText, isNot(contains('hello from stdout')));
        // Only a finite authoritative duration is shown.
        expect(find.byKey(const Key('tool-duration-chip')), findsOneWidget);
        await app.toggleTool('c1');
        expect(app.visibleText, contains('hello from stdout'));
        await app.toggleTool('c1');
        expect(app.visibleText, isNot(contains('hello from stdout')));
      });
    }
  });

  group('command rows', () {
    featureTest('a command row states what ran, where, how it ended and what '
        'it printed', (f) async {
      final app = await openTranscript(f, [
        toolResultRow(
          'c-fail',
          toolName: 'exec_command',
          extra: {'title': 'make test', 'exitCode': 2, 'durationMs': 1500},
          semantic: commandSemantic(
            'make test',
            state: 'failed',
            cwd: '/repo/app',
            stdout: 'compiled 3 files',
            stderr: 'FAILED tests/test_x.py',
          ),
        ),
        toolCallRow(
          'c-run',
          semantic: commandSemantic('sleep 60', state: 'running'),
        ),
        toolResultRow(
          'c-int',
          semantic: commandSemantic('npm run watch', state: 'interrupted'),
        ),
        toolResultRow(
          'c-unk',
          semantic: commandSemantic('mystery', state: 'unknown'),
        ),
        toolResultRow(
          'c-comb',
          extra: {'result': 'one blob of output'},
          semantic: commandSemantic('ls'),
        ),
      ]);
      await app.inspect('c-fail', (card) {
        Finder it(Finder finder) => inside(card, finder);
        expect(it(find.byKey(const Key('tool-command-line'))), findsOneWidget);
        expect(it(find.text('make test · in /repo/app')), findsOneWidget);
        expect(
          it(find.byKey(const Key('tool-command-stdout'))),
          findsOneWidget,
        );
        expect(
          it(find.byKey(const Key('tool-command-stderr'))),
          findsOneWidget,
        );
        expect(it(find.text('compiled 3 files')), findsOneWidget);
        expect(it(find.text('FAILED tests/test_x.py')), findsOneWidget);
        expect(it(find.textContaining('exit 2')), findsOneWidget);
        expect(it(find.textContaining('1.5s')), findsOneWidget);
        expect(it(find.text('failed')), findsOneWidget);
      });
      await app.inspect('c-run', (card) {
        expect(inside(card, find.text('running')), findsOneWidget);
        expect(inside(card, find.text('No output yet.')), findsOneWidget);
      });
      await app.inspect('c-int', (card) {
        expect(inside(card, find.text('interrupted')), findsOneWidget);
        expect(inside(card, find.textContaining('exit ')), findsNothing);
      });
      await app.inspect('c-unk', (card) {
        expect(inside(card, find.text('state unknown')), findsOneWidget);
        expect(inside(card, find.text('completed')), findsNothing);
        expect(
          inside(card, find.text('The command produced no output.')),
          findsOneWidget,
        );
      });
      await app.inspect('c-comb', (card) {
        expect(inside(card, find.text('Combined output')), findsOneWidget);
        expect(
          inside(card, find.byKey(const Key('tool-command-stdout'))),
          findsNothing,
        );
      });
    });

    featureTest('a clipped command says who clipped it, and Copy copies the '
        'exact bounded stream with a 48 dp target', (f) async {
      final app = await openTranscript(f, [
        toolResultRow(
          'c-trunc',
          semantic: {
            ...commandSemantic(
              'gen',
              stdout: 'kept tail',
              stdoutTruncated: true,
            ),
            'stderr': {'text': List.generate(900, (i) => 'e$i').join('\n')},
          },
        ),
        toolResultRow(
          'c-copy',
          semantic: commandSemantic('echo hi', stdout: 'hi'),
        ),
      ]);
      await app.inspect('c-trunc', (card) {
        expect(
          inside(card, find.byKey(const Key('tool-command-stdout-truncated'))),
          findsOneWidget,
        );
        expect(
          inside(
            card,
            find.text(
              'Output truncated by the agent before it reached this device.',
            ),
          ),
          findsOneWidget,
        );
        expect(
          inside(card, find.byKey(const Key('tool-command-stderr-truncated'))),
          findsOneWidget,
        );
        expect(
          inside(card, find.textContaining('earlier lines hidden')),
          findsOneWidget,
        );
      });
      final clipboard = app.captureClipboard();
      await app.toggleTool('c-copy');
      final copy = find.byKey(const Key('tool-command-stdout-copy'));
      final size = app.tester.getSize(copy);
      expect(size.width, greaterThanOrEqualTo(48));
      expect(size.height, greaterThanOrEqualTo(48));
      await app.tap(copy);
      expect(clipboard, ['hi']);
    });

    // CSI, OSC (BEL and ST terminated), CR, DEL, C1, bidi overrides and an
    // unterminated escape: none may reach the screen, text and newlines stay.
    featureTest('terminal escapes in command and fallback output never reach '
        'the screen', (f) async {
      const hostile = <String, String>{
        'csi': '\x1b[31mmatch\x1b[0m',
        'osc-bel': 'open\x1b]0;title\x07done',
        'osc-st': 'open\x1b]8;;https://x.test\x1b\\link\x1b]8;;\x1b\\done',
        'cr': 'progress 10%\rprogress 100%',
        'del': 'before\x7fafter',
        'c1': 'before\u009b31mafter',
        'bidi': 'safe‮evil‬end',
        'unterminated': 'visible\x1b[31',
      };
      final app = await openTranscript(f, [
        for (final entry in hostile.entries) ...[
          toolResultRow(
            'cmd-${entry.key}',
            semantic: commandSemantic('run ${entry.key}', stdout: entry.value),
          ),
          toolResultRow(
            'fb-${entry.key}',
            toolClass: 'other',
            toolName: 'mcp__v__t',
            extra: {
              'result': {'out': entry.value},
            },
          ),
        ],
        toolResultRow(
          'kept',
          semantic: commandSemantic('keep', stdout: 'tab\there\nline two'),
        ),
      ]);
      for (final id in [
        for (final key in hostile.keys) ...['cmd-$key', 'fb-$key'],
        'kept',
      ]) {
        await app.inspect(id, (card) {
          final screen = app.visibleText;
          for (final bad in [
            '\x1b',
            '\x07',
            '\x7f',
            '\u009b',
            '‮',
            '‬',
            '[31m',
            ']0;title',
            '8;;',
          ]) {
            expect(
              screen,
              isNot(contains(bad)),
              reason: '$id leaked ${bad.codeUnits}',
            );
          }
        });
      }
      await app.inspect('kept', (card) {
        expect(inside(card, find.textContaining('tab\there')), findsOneWidget);
        expect(inside(card, find.textContaining('line two')), findsOneWidget);
      });
      await app.inspect(
        'cmd-csi',
        (card) => expect(inside(card, find.text('match')), findsOneWidget),
      );
      await app.inspect(
        'cmd-unterminated',
        (card) => expect(inside(card, find.text('visible')), findsOneWidget),
      );
    });
  });

  group('file, search and web rows', () {
    featureTest('a file read shows a line-numbered preview, or says why there '
        'is none', (f) async {
      final app = await openTranscript(f, [
        toolResultRow(
          'r-num',
          toolClass: 'lookup',
          toolName: 'Read',
          semantic: {
            'kind': 'file-read',
            'path': 'lib/main.dart',
            'startLine': 40,
            'preview': 'void main() {\n  runApp();\n}',
            'totalLines': 120,
          },
        ),
        toolResultRow(
          'r-plain',
          toolClass: 'lookup',
          toolName: 'Read',
          semantic: {
            'kind': 'file-read',
            'path': 'notes.txt',
            'preview': 'alpha\nbeta',
          },
        ),
        toolResultRow(
          'r-huge',
          toolClass: 'lookup',
          toolName: 'Read',
          semantic: {
            'kind': 'file-read',
            'path': 'huge.log',
            'startLine': 1999998,
            'preview': 'a\nb',
          },
        ),
        toolResultRow(
          'r-big',
          toolClass: 'lookup',
          toolName: 'Read',
          semantic: {
            'kind': 'file-read',
            'path': 'big.txt',
            'startLine': 1,
            'preview': List.generate(400, (i) => 'l$i').join('\n'),
            'totalLines': 5000,
          },
        ),
        for (final reason in ['missing', 'unreadable', 'binary', 'empty'])
          toolResultRow(
            'r-$reason',
            toolClass: 'lookup',
            toolName: 'Read',
            semantic: {
              'kind': 'file-read',
              'path': 'x',
              'unavailable': reason,
            },
          ),
      ]);
      await app.openLookupGroup();
      await app.inspect('r-num', (card) {
        expect(
          inside(card, find.byKey(const Key('tool-read-section'))),
          findsOneWidget,
        );
        expect(inside(card, find.text('40')), findsOneWidget);
        expect(inside(card, find.text('42')), findsOneWidget);
        expect(inside(card, find.text('void main() {')), findsOneWidget);
      });
      await app.inspect('r-plain', (card) {
        expect(inside(card, find.text('alpha')), findsOneWidget);
        // No start line: no fabricated numbers.
        expect(inside(card, find.text('1')), findsNothing);
        expect(inside(card, find.text('2')), findsNothing);
      });
      await app.inspect('r-huge', (card) {
        expect(inside(card, find.text('1999998')), findsOneWidget);
        expect(inside(card, find.text('1999999')), findsOneWidget);
      });
      await app.inspect('r-big', (card) {
        expect(
          inside(card, find.byKey(const Key('tool-read-truncated'))),
          findsOneWidget,
        );
        expect(inside(card, find.textContaining('5000')), findsOneWidget);
      });
      for (final (reason, copy) in const [
        ('missing', 'The file could not be found.'),
        ('unreadable', 'The file could not be read.'),
        ('binary', 'No text preview: the file is binary.'),
        ('empty', 'The file is empty.'),
      ]) {
        await app.inspect('r-$reason', (card) {
          expect(inside(card, find.text(copy)), findsOneWidget, reason: reason);
        });
      }
    });

    featureTest('a search groups matches per file, says when nothing matched '
        'and discloses every kind of clipping', (f) async {
      final app = await openTranscript(f, [
        toolResultRow(
          's-groups',
          toolClass: 'lookup',
          toolName: 'Grep',
          extra: {'title': 'Grep'},
          semantic: {
            'kind': 'search',
            'query': 'TODO',
            'scope': 'lib/',
            'matchCount': 3,
            'fileCount': 2,
            'groups': [
              {
                'path': 'lib/a.dart',
                'matchCount': 2,
                'matches': [
                  {'line': 10, 'text': '// TODO a'},
                  {'line': 22, 'text': '// TODO b'},
                ],
              },
              {
                'path': 'lib/b.dart',
                'matchCount': 1,
                'matches': [
                  {'line': 5, 'text': '// TODO c'},
                ],
              },
            ],
          },
        ),
        toolResultRow(
          's-none',
          toolClass: 'lookup',
          toolName: 'Grep',
          semantic: {
            'kind': 'search',
            'query': 'zzz',
            'matchCount': 0,
          },
        ),
        toolResultRow(
          's-dropped',
          toolClass: 'lookup',
          toolName: 'Grep',
          semantic: {
            'kind': 'search',
            'query': 'x',
            'truncated': true,
            'groups': [
              {
                'path': 'a.dart',
                'matchCount': 500,
                'truncated': true,
                'matches': [
                  {'line': 1, 'text': 'x'},
                ],
              },
            ],
          },
        ),
        toolResultRow(
          's-sender',
          toolClass: 'lookup',
          toolName: 'Grep',
          semantic: {
            'kind': 'search',
            'query': 'needle',
            'groups': [
              {
                'path': 'a.dart',
                'matches': [
                  {
                    'line': 4,
                    'text': 'clipped by the sender',
                    'truncated': true,
                  },
                ],
              },
            ],
          },
        ),
        toolResultRow(
          's-device',
          toolClass: 'lookup',
          toolName: 'Grep',
          semantic: {
            'kind': 'search',
            'query': 'needle',
            'groups': [
              {
                'path': 'a.dart',
                'matches': [
                  {'line': 4, 'text': 'z' * 4000},
                ],
              },
            ],
          },
        ),
      ]);
      await app.openLookupGroup();
      expect(
        find.text('TODO · in lib/ · 3 matches in 2 files'),
        findsOneWidget,
      );
      await app.inspect('s-groups', (card) {
        expect(inside(card, find.textContaining('lib/a.dart')), findsOneWidget);
        expect(inside(card, find.textContaining('lib/b.dart')), findsOneWidget);
        expect(inside(card, find.text('// TODO a')), findsOneWidget);
        expect(inside(card, find.text('// TODO c')), findsOneWidget);
        expect(
          inside(card, find.byKey(const Key('tool-search-scope'))),
          findsOneWidget,
        );
      });
      await app.inspect('s-none', (card) {
        expect(
          inside(card, find.text('No matches for "zzz".')),
          findsOneWidget,
        );
      });
      await app.inspect('s-dropped', (card) {
        expect(
          inside(card, find.byKey(const Key('tool-search-truncated'))),
          findsOneWidget,
        );
        expect(
          inside(card, find.byKey(const Key('tool-search-group-truncated'))),
          findsOneWidget,
        );
      });
      await app.inspect('s-sender', (card) {
        expect(
          inside(card, find.byKey(const Key('tool-search-match-truncated'))),
          findsOneWidget,
        );
        // The group itself lost nothing, so it must not claim it did.
        expect(
          inside(card, find.byKey(const Key('tool-search-group-truncated'))),
          findsNothing,
        );
      });
      await app.inspect('s-device', (card) {
        expect(
          inside(card, find.byKey(const Key('tool-search-match-truncated'))),
          findsOneWidget,
        );
      });
    });

    featureTest('web rows show titles and domains, keep URLs as plain text, '
        'and a fetch shows its URL', (f) async {
      final app = await openTranscript(f, [
        toolResultRow(
          'w-search',
          toolClass: 'lookup',
          toolName: 'WebSearch',
          semantic: {
            'kind': 'web',
            'query': 'dart isolates',
            'results': [
              {
                'url': 'https://www.example.com/isolates',
                'title': 'Understanding isolates',
                'snippet': 'A short summary.',
                'truncated': true,
              },
            ],
          },
        ),
        toolResultRow(
          'w-fetch',
          toolClass: 'lookup',
          toolName: 'WebFetch',
          semantic: {
            'kind': 'web',
            'url': 'https://example.com/page',
          },
        ),
        toolResultRow(
          'w-empty',
          toolClass: 'lookup',
          toolName: 'WebSearch',
          semantic: {
            'kind': 'web',
            'query': 'nothing',
          },
        ),
      ]);
      await app.openLookupGroup();
      expect(
        find.text('dart isolates · example.com · 1 result'),
        findsOneWidget,
      );
      await app.inspect('w-search', (card) {
        expect(
          inside(card, find.text('Understanding isolates')),
          findsOneWidget,
        );
        expect(inside(card, find.text('example.com')), findsOneWidget);
        expect(inside(card, find.text('A short summary.')), findsOneWidget);
        expect(
          inside(card, find.byKey(const Key('tool-web-result-truncated'))),
          findsOneWidget,
        );
        // No tappable link is introduced: the URL never becomes a hyperlink.
        expect(inside(card, find.byType(InkWell)), findsOneWidget);
      });
      await app.inspect('w-fetch', (card) {
        expect(
          inside(card, find.byKey(const Key('tool-web-url'))),
          findsOneWidget,
        );
      });
      await app.inspect('w-empty', (card) {
        expect(
          inside(card, find.byKey(const Key('tool-web-empty'))),
          findsOneWidget,
        );
      });
    });
  });

  group('unknown and MCP tools', () {
    featureTest('an unknown tool shows ordered structured data, redacts '
        'credential-like fields and stays bounded', (f) async {
      final semantics = f.tester.ensureSemantics();
      var deep = <String, Object?>{'leaf': 'bottom'};
      for (var i = 0; i < 60; i++) {
        deep = {'l$i': deep};
      }
      final app = await openTranscript(f, [
        toolCallRow(
          'm-plain',
          toolClass: 'other',
          toolName: 'mcp__vendor__do_thing',
          extra: {
            'args': {'zeta': 1, 'alpha': 'two'},
          },
        ),
        toolResultRow(
          'm-plain',
          toolClass: 'other',
          toolName: 'mcp__vendor__do_thing',
          extra: {
            'result': {'status': 'ok', 'count': 3},
          },
        ),
        toolResultRow(
          'm-secret',
          toolClass: 'other',
          toolName: 'mcp__vendor__auth',
          extra: {
            'result': {
              'api_key': 'sk-live-SUPERSECRET',
              'authorization': 'Bearer SUPERSECRET',
              'password': 'hunter2',
              'endpoint': 'https://api.example.com',
            },
          },
        ),
        toolResultRow(
          'm-huge',
          toolClass: 'other',
          toolName: 'x',
          extra: {
            'result': {for (var i = 0; i < 400; i++) 'field$i': 'v' * 300},
          },
        ),
        toolResultRow(
          'm-deep',
          toolClass: 'other',
          toolName: 'x',
          extra: {'result': deep},
        ),
      ]);
      await app.inspect('m-plain', (card) {
        expect(
          inside(card, find.byKey(const Key('tool-fallback-section'))),
          findsOneWidget,
        );
        expect(
          inside(card, find.byKey(const Key('tool-fallback-input'))),
          findsOneWidget,
        );
        expect(
          inside(card, find.byKey(const Key('tool-fallback-output'))),
          findsOneWidget,
        );
        expect(inside(card, find.textContaining('alpha')), findsOneWidget);
        expect(inside(card, find.textContaining('status')), findsOneWidget);
        // Fields keep a stable order, not the payload's.
        final input = app.textOf(
          inside(card, find.byKey(const Key('tool-fallback-input'))),
        );
        expect(input.indexOf('alpha'), lessThan(input.indexOf('zeta')));
      });
      await app.inspect('m-secret', (card) {
        expect(app.visibleText, isNot(contains('SUPERSECRET')));
        expect(app.visibleText, isNot(contains('hunter2')));
        expect(inside(card, find.textContaining('hidden')), findsWidgets);
        expect(
          inside(card, find.textContaining('https://api.example.com')),
          findsOneWidget,
        );
        expect(
          find.bySemanticsLabel(
            'password: value hidden because it may contain a secret',
          ),
          findsOneWidget,
        );
      });
      await app.inspect('m-huge', (card) {
        expect(
          inside(card, find.byKey(const Key('tool-fallback-output-truncated'))),
          findsOneWidget,
        );
      });
      await app.inspect('m-deep', (card) {
        expect(
          inside(card, find.byKey(const Key('tool-fallback-output-truncated'))),
          findsOneWidget,
        );
      });
      expect(app.tester.takeException(), isNull);
      semantics.dispose();
    });
  });
}

FakeBrokerSocket socketOf(AppDriver app, FakeBroker broker) =>
    app.socket(broker);
