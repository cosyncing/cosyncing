// F03b: what the transcript shows after the connection is interrupted or the
// rows arrive by a different road. However a session's rows reach the app (a
// fresh attach, a reconnect that replays only what is new, a broker resync, a
// copy saved on the device) the reader sees the same turns in the same order,
// each row once. A card still waiting for an answer is still waiting after a
// reconnect only if the broker says so.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/app_driver.dart';
import '../support/feature/cosyncing_app.dart';
import '../support/feature/fake_broker.dart';
import '../support/feature/history_frames.dart';
import '../support/feature/session_wire.dart';
import '../support/feature/transcript_reader.dart';
import '../support/feature/transcript_wire.dart';

/// One synthetic turn shaped like the real Codex mapping: a running run
/// summary at turn start, tool steps with a telemetry row after each, and a
/// completed run summary restating the same key at turn end.
List<Map<String, Object?>> turnRows(int n, {required int toolPairs}) => [
  row('run-summary', {'key': 'run:T$n', 'status': 'running', 'turnId': 'T$n'}),
  userRow('prompt $n', key: 'T$n:u0', turnId: 'T$n'),
  answerRow('opening $n', key: 'T$n:m0'),
  for (var i = 0; i < toolPairs; i++) ...[
    toolCallRow(
      'T$n:c$i',
      toolName: 'exec',
      extra: {'title': 'step $i'},
    ),
    toolResultRow('T$n:c$i', toolName: 'exec'),
    row('metadata-update', {
      'key': 'contextUsage',
      'value': {'used': n * 100 + i},
    }),
  ],
  answerRow('answer $n', key: 'T$n:mf'),
  row('run-summary', {
    'key': 'run:T$n',
    'status': 'done',
    'turnId': 'T$n',
    'totalRuntimeMs': n * 111000,
    'startedAt': n * 1000000,
    'completedAt': n * 1000000 + n * 111000,
    'userMessageKey': 'T$n:u0',
    'assistantMessageKey': 'T$n:mf',
    'tokens': {'input': n * 10, 'output': n},
  }),
  row('metadata-update', {
    'key': 'runtimeTotals',
    'value': {'turns': n},
  }),
];

/// What the transcript list shows, text run by text run, top to bottom.
///
/// The list is centered, so the rows above its center sit in the tree in
/// reverse: the screen is the order that matters.
String transcriptText(AppDriver app) {
  final runs = <(double, String)>[];
  for (final element
      in find
          .descendant(of: transcriptList, matching: find.byType(RichText))
          .evaluate()) {
    final text = (element.widget as RichText).text
        .toPlainText()
        .replaceAll('\u200b', '')
        .trim();
    // Icon glyphs are drawn from the private-use area.
    if (text.isEmpty || text.codeUnits.every((c) => c >= 0xE000)) continue;
    final box = element.renderObject! as RenderBox;
    runs.add((box.localToGlobal(Offset.zero).dy, text));
  }
  runs.sort((a, b) => a.$1.compareTo(b.$1));
  return [for (final run in runs) run.$2].join('\n');
}

/// Asserts the widgets of [finders] sit on screen in this order, top down.
void expectOnScreenInOrder(AppDriver app, List<Finder> finders) {
  var previous = double.negativeInfinity;
  for (final finder in finders) {
    expect(finder, findsOneWidget, reason: finder.describeMatch(Plurality.one));
    final top = app.tester.getTopLeft(finder).dy;
    expect(
      top,
      greaterThan(previous),
      reason: '${finder.describeMatch(Plurality.one)} must follow the previous',
    );
    previous = top;
  }
}

Future<void> reconnect(AppDriver app, FakeBroker studio, String id) async {
  final known = studio.socketsFor(id).length;
  studio.socketsFor(id).last.drop();
  await app.pumpUntil(
    () => studio.socketsFor(id).length > known,
    reason: 'the app reconnects',
    every: const Duration(milliseconds: 500),
  );
  await app.settle();
}

void main() {
  final t1 = turnRows(1, toolPairs: 4);
  final t2 = turnRows(2, toolPairs: 4);
  final t3 = turnRows(3, toolPairs: 4);
  final noon = [...t1, ...t2];
  final full = [...noon, ...t3];

  /// A session `s1` that the broker serves with [attaches], beside a `fresh`
  /// session holding the whole history from the start.
  Future<(AppDriver, FakeBroker, String)> open(
    FeatureContext f,
    List<AttachScript> attaches,
  ) async {
    final (app, studio) = await launchWithTranscript(
      f,
      const [],
      viewport: FeatureViewport.desktopTall,
      setup: (studio) {
        studio.addSession('fresh', 'Fresh', cwd: '/work/studio');
        scriptAttaches(studio, 'fresh', [
          (_) => [historyFrame(full, reset: true, cursor: 'c-fresh')],
        ]);
        scriptAttaches(studio, 's1', attaches);
      },
    );
    await app.go('/sessions/codex/fresh');
    final expected = transcriptText(app);
    expect(expected, contains('answer 3'));
    await app.go('/sessions/codex/s1');
    return (app, studio, expected);
  }

  group('every road to the same transcript', () {
    for (final mode in ['tier-1-only', 'final-messages-only']) {
      featureTest('file cards stay with their creating messages after replay '
          'and reset with $mode', (f) async {
        final studio = f.network.add('http://studio.test:7734');
        final history = [
          userRow('Create the first report', key: 'old-prompt'),
          toolResultRow(
            'old-write',
            toolName: 'Write',
            extra: {
              'path': '/work/studio/report.md',
            },
          ),
          answerRow('First report finished', key: 'old-answer'),
          userRow('Continue the conversation', key: 'new-prompt'),
          answerRow('Latest answer', key: 'latest-answer'),
        ];
        final file = row('file-artifact', {
          'artifactKey': 'original-report',
          'path': 'report.md',
          'name': 'original-report.md',
          'mimeType': 'text/markdown',
          'transcriptAnchor': {'type': 'tool-result', 'key': 'old-write'},
        });
        final sent = row('file-artifact', {
          'artifactKey': 'sent-report',
          'path': 'sent.md',
          'name': 'sent-report.md',
          'mimeType': 'text/markdown',
          'proactive': true,
          'transcriptAnchor': {'type': 'model-output', 'key': 'old-answer'},
        });
        final app = await openTranscript(
          f,
          history,
          broker: studio,
          toolDisplay: mode,
          setup: (studio) => scriptAttaches(studio, 's1', [
            (_) => [historyFrame(history, reset: true, cursor: 'reports')],
            (_) => [
              historyFrame(const [], cursor: 'reports'),
              messageFrame(file, 0),
              messageFrame(sent, 0),
            ],
          ]),
        );
        await app.liveAll(studio, [file, sent]);
        void expectPosition() => expectOnScreenInOrder(app, [
          find.text('Create the first report'),
          find.text('original-report.md'),
          find.textContaining('First report finished'),
          find.text('sent-report.md'),
          find.text('Continue the conversation'),
          find.textContaining('Latest answer'),
        ]);
        expectPosition();
        await reconnect(app, studio, 's1');
        expectPosition();
        app.socket(studio).emit(historyFrame(history, reset: true));
        await app.liveAll(studio, [file, sent]);
        expectPosition();
      });
    }

    featureTest('old cached file cards wait for their creating history page '
        'and later rewrites never steal them', (f) async {
      final (app, paging) = await openPaging(
        f,
        total: 200,
        row: (index) => switch (index) {
          91 => userRow(
            'Ambiguous file request',
            key: 'ambiguous-request',
            extra: {'sentAt': 1000},
          ),
          92 || 93 => toolResultRow(
            'ambiguous-$index',
            toolName: 'Write',
            extra: {'path': '/work/studio/reports/ambiguous.md'},
          ),
          94 => userRow(
            'Next request',
            key: 'after-ambiguous',
            extra: {'sentAt': 3000},
          ),
          95 => userRow(
            'Original file request',
            key: 'original-request',
            extra: {'sentAt': 4000},
          ),
          96 => toolResultRow(
            'legacy-write',
            toolName: 'Write',
            extra: {
              'path': '/work/studio/reports/legacy.md',
            },
          ),
          97 => answerRow('Original file completed', key: 'original-completed'),
          98 => userRow(
            'Following request',
            key: 'following-request',
            extra: {'sentAt': 6000},
          ),
          189 => userRow(
            'Rewrite the same file',
            key: 'rewrite-request',
            extra: {'sentAt': 10000},
          ),
          190 => toolResultRow(
            'newer-write',
            toolName: 'Write',
            extra: {'path': '/work/studio/reports/legacy.md'},
          ),
          191 => userRow(
            'Continue after rewriting',
            key: 'after-rewrite',
            extra: {'sentAt': 11000},
          ),
          _ => userRow('Row $index.', key: 'row-$index'),
        },
      );
      final legacy = row('file-artifact', {
        'artifactKey': 'legacy-report',
        'path': 'reports/legacy.md',
        'name': 'legacy-report.md',
        'mimeType': 'text/markdown',
        'transcriptAnchor': {
          'type': 'workspace-write',
          'path': 'reports/legacy.md',
          'createdAt': 5000,
        },
      });
      final exact = row('file-artifact', {
        ...legacy,
        'artifactKey': 'exact-report',
        'name': 'exact-report.md',
        'transcriptAnchor': {'type': 'tool-result', 'key': 'legacy-write'},
      });
      final ambiguous = row('file-artifact', {
        ...legacy,
        'artifactKey': 'ambiguous-report',
        'path': 'reports/ambiguous.md',
        'name': 'ambiguous-report.md',
        'transcriptAnchor': {
          'type': 'workspace-write',
          'path': 'reports/ambiguous.md',
          'createdAt': 2000,
        },
      });
      await app.liveAll(paging.broker, [legacy, exact, ambiguous]);
      expect(find.text('legacy-report.md'), findsNothing);
      expect(find.text('exact-report.md'), findsNothing);
      expect(find.text('ambiguous-report.md'), findsNothing);
      await app.askForEarlier();
      await app.frames();
      final source = find.text('Original file request');
      for (
        var gesture = 0;
        gesture < 20 && source.evaluate().isEmpty;
        gesture++
      ) {
        await app.drag(320);
        await app.frames(3);
      }
      expectOnScreenInOrder(app, [
        find.text('Original file request'),
        find.text('legacy-report.md'),
        find.text('exact-report.md'),
        find.textContaining('Original file completed'),
      ]);

      // A later write in another turn cannot steal the pre-upgrade card,
      // and multiple writes inside its original turn stay ambiguous.
      await app.live(
        paging.broker,
        toolResultRow(
          'another-write',
          toolName: 'Write',
          extra: {'path': '/work/studio/reports/legacy.md'},
        ),
      );
      expect(find.text('legacy-report.md'), findsOneWidget);
      expect(find.text('exact-report.md'), findsOneWidget);
      expect(find.text('ambiguous-report.md'), findsNothing);
    });

    featureTest('a reconnect that replays only the newest rows shows what a '
        'fresh attach shows', (f) async {
      final (app, studio, expected) = await open(f, [
        (_) => [historyFrame(noon, reset: true, cursor: 'c-noon')],
        (_) => [historyFrame(t3, cursor: 'c-full')],
      ]);
      expect(transcriptText(app), isNot(contains('answer 3')));
      await reconnect(app, studio, 's1');
      expect(
        studio.socketsFor('s1').last.attachParams['ticket'],
        'c-noon',
        reason: 'the reconnect asks for what came after the rows it holds',
      );
      expect(transcriptText(app), expected);
    });

    featureTest('a full snapshot without a cursor, the shape of an older '
        "broker's resync, shows what a fresh attach shows", (f) async {
      final (app, studio, expected) = await open(f, [
        (_) => [historyFrame(noon, reset: true, cursor: 'c-noon')],
      ]);
      await app.liveAll(studio, t3);
      studio.socketsFor('s1').last.emit(historyFrame(full));
      await app.settle();
      expect(transcriptText(app), expected);
    });

    featureTest('a window that was scrambled is repaired by a full '
        'snapshot', (f) async {
      // The retained window has turn 3 spliced before turns 1 and 2, as the
      // old merge left it in a corrupted saved copy.
      final (app, studio, expected) = await open(f, [
        (_) => [
          historyFrame([...t3, ...noon], reset: true, cursor: 'c-bad'),
        ],
      ]);
      expect(transcriptText(app), isNot(expected));
      studio.socketsFor('s1').last.emit(historyFrame(full));
      await app.settle();
      expect(transcriptText(app), expected);
    });

    featureTest('a copy saved on the device, plus the reconnect rows, shows '
        'what a fresh attach shows', (f) async {
      final (first, studio, expected) = await open(f, [
        (_) => [historyFrame(noon, reset: true, cursor: 'c-noon')],
        (_) => [historyFrame(t3, cursor: 'c-full')],
      ]);
      expect(transcriptText(first), isNot(contains('answer 3')));
      await first.elapse(const Duration(seconds: 5));
      await f.quit();

      final app = await f.restart();
      await app.go('/sessions/codex/s1');
      expect(
        studio.socketsFor('s1').last.attachParams['ticket'],
        'c-noon',
        reason: 'the saved copy resumes from the cursor it holds',
      );
      expect(transcriptText(app), expected);
    });
  });

  group("the order of a turn is the broker's, whatever the delivery", () {
    final turn = [
      userRow('prompt u1', key: 'u1'),
      answerRow('commentary', key: 'c1'),
      toolCallRow('call-1', semantic: commandSemantic('step one')),
      toolResultRow('call-1', semantic: commandSemantic('step one')),
      toolCallRow('call-2', semantic: commandSemantic('step two')),
      toolResultRow('call-2', semantic: commandSemantic('step two')),
      answerRow('final response', key: 'f1'),
    ];
    // What an append-only merge once persisted: the final response kept from
    // live delivery, every recovered tool row appended behind it.
    final malformed = [turn[0], turn[1], turn[6], ...turn.sublist(2, 6)];

    void expectTurn(AppDriver app) {
      final screen = transcriptText(app);
      var from = 0;
      for (final text in const [
        'prompt u1',
        'commentary',
        'step one',
        'step two',
        'final response',
      ]) {
        final at = screen.indexOf(text, from);
        expect(at, isNonNegative, reason: '"$text" after $from in\n$screen');
        expect(
          screen.indexOf(text, at + text.length),
          -1,
          reason: '"$text" is shown once',
        );
        from = at + text.length;
      }
    }

    Future<(AppDriver, FakeBroker)> openTurn(
      FeatureContext f,
      List<AttachScript> attaches,
    ) async {
      final (app, studio) = await launchWithTranscript(
        f,
        const [],
        viewport: FeatureViewport.desktopTall,
        setup: (studio) => scriptAttaches(studio, 's1', attaches),
      );
      await app.go('/sessions/codex/s1');
      return (app, studio);
    }

    featureTest('rows delivered live alone', (f) async {
      final (app, studio) = await openTurn(f, [
        (_) => [historyFrame(const [], reset: true, cursor: 'c0')],
      ]);
      await app.liveAll(studio, turn);
      expectTurn(app);
    });

    featureTest('rows in the attach history alone', (f) async {
      final (app, _) = await openTurn(f, [
        (_) => [historyFrame(turn, reset: true, cursor: 'c1')],
      ]);
      expectTurn(app);
    });

    featureTest('tool rows that never came live are recovered before the '
        'final response that did', (f) async {
      final (app, studio) = await openTurn(f, [
        (_) => [historyFrame(const [], reset: true, cursor: 'c0')],
      ]);
      await app.liveAll(studio, [
        turn[0],
        turn[1],
        answerDelta('final ', 'f1'),
        answerDelta('response', 'f1'),
      ]);
      expect(transcriptText(app), isNot(contains('step one')));
      studio.socketsFor('s1').last.emit(historyFrame(turn, cursor: 'c2'));
      await app.settle();
      expectTurn(app);
    });

    featureTest('rows seen live and again in the next history are held '
        'once each, in native order', (f) async {
      final (app, studio) = await openTurn(f, [
        (_) => [historyFrame(const [], reset: true, cursor: 'c0')],
      ]);
      await app.liveAll(studio, turn.sublist(0, 3));
      studio
          .socketsFor('s1')
          .last
          .emit(
            historyFrame(turn.sublist(1), cursor: 'c2'),
          );
      await app.settle();
      expectTurn(app);
    });

    featureTest('a reset replay replaces what live delivery left', (f) async {
      final (app, studio) = await openTurn(f, [
        (_) => [historyFrame(const [], reset: true, cursor: 'c0')],
      ]);
      await app.liveAll(studio, [turn[0], turn[1], turn[6]]);
      studio
          .socketsFor('s1')
          .last
          .emit(
            historyFrame(turn, reset: true, cursor: 'c3'),
          );
      await app.settle();
      expectTurn(app);
    });

    featureTest('a saved copy in the old, wrong order is repaired by the '
        'next incremental frame', (f) async {
      final (first, studio) = await openTurn(f, [
        (_) => [historyFrame(malformed, reset: true, cursor: 'cached')],
        (_) => [historyFrame(turn, cursor: 'c4')],
      ]);
      expect(
        transcriptText(first).indexOf('final response'),
        lessThan(transcriptText(first).indexOf('step one')),
        reason: 'setup: the copy really is in the wrong order',
      );
      await first.elapse(const Duration(seconds: 5));
      await f.quit();

      final app = await f.restart();
      await app.go('/sessions/codex/s1');
      expect(studio.socketsFor('s1').last.attachParams['ticket'], 'cached');
      expectTurn(app);
    });
  });

  group('a reconnect that missed more rows than the broker will replay', () {
    for (final (name, newerHistory, hello) in [
      ('a revision-28 broker', true, null),
      (
        'a revision-27 broker',
        false,
        (FakeBroker broker) => helloWith(
          broker,
          version: '0.5.14',
          status: 'broker-behind',
          reason: 'broker is behind',
        ),
      ),
      (
        'a revision-26 broker',
        false,
        (FakeBroker broker) => helloWith(
          broker,
          version: '0.5.13',
          status: 'hard-incompatible',
          readOnly: true,
          reason: 'contract revisions differ by more than the overlap',
        ),
      ),
    ]) {
      featureTest('$name keeps the pages already read only if it can page '
          'forward', (f) async {
        final (app, paging) = await openPaging(
          f,
          total: 100,
          newerHistory: newerHistory,
          configure: (paging) {
            paging.reconnectCap = 150;
            if (hello != null) paging.hello = () => hello(paging.broker);
          },
        );
        // 200 rows are saved while the stream is down: more than a reconnect
        // replays, so the broker answers with its newest page.
        for (var index = 100; index < 300; index++) {
          paging.append(markedRow(index), live: false);
        }
        await reconnect(app, paging.broker, 's1');
        expect(paging.attaches.last['ticket'], 'r100');
        await app.jumpToEnd();
        expect(app.topOf(299), isNotNull, reason: 'the newest row is shown');

        await app.jumpToStart();
        if (!newerHistory) {
          expect(
            app.topOf(0),
            isNull,
            reason: 'the capped frame replaced the rows read before it',
          );
          expect(releasedRanges, findsNothing);
          await app.jumpToEnd();
          await app.wheel(-40);
          expect(paging.refreshes, isEmpty, reason: 'it cannot refresh');
          expect(paging.newer, isEmpty, reason: 'it cannot page forward');
          return;
        }
        expect(
          app.topOf(0),
          isNotNull,
          reason: 'the pages already read are still there',
        );
        // The rows between fill from the older edge with newer pages, and
        // never claim the start of the session.
        await app.bringRangeToLowerHalf();
        await app.wheel(40);
        expect(paging.newer, hasLength(1));
        expect(paging.newer.single.cursor, 'b100');
        expect(paging.newer.single.until, 'b200');
        await app.frames(10);
        var found = false;
        for (var step = 0; step < 100 && !found; step++) {
          found = app.topOf(150) != null;
          if (!found) {
            app.position.jumpTo(
              app.position.pixels + app.position.viewportDimension / 2,
            );
            await app.tester.pump();
          }
        }
        expect(found, isTrue, reason: 'the rows that were missed arrived');
      });
    }
  });

  group('what the device saved', () {
    featureTest('a saved copy resumes from its cursor only if it holds exactly '
        'what the cursor covers', (
      f,
    ) async {
      // On a broker that names no boundary for live rows, a long stream
      // releases rows the copy cannot reload; the copy must not tell the next
      // attach to resume after rows it does not have.
      final (app, studio) = await launchWithTranscript(
        f,
        const [],
        viewport: FeatureViewport.desktopTall,
        setup: (studio) {
          for (final id in ['long', 'short', 'quiet']) {
            studio.addSession(id, id, cwd: '/work/studio');
            scriptAttaches(studio, id, [
              (_) => [
                historyFrame(
                  [
                    for (var i = 0; i < 100; i++)
                      answerRow('Old $i', key: 'o$i'),
                  ],
                  reset: true,
                  cursor: 'r100',
                ),
              ],
              (_) => [historyFrame(const [], reset: true, cursor: 'r-after')],
            ]);
          }
        },
      );
      await app.go('/sessions/codex/long');
      await app.liveAll(studio, [
        for (var i = 0; i < 1000; i++) answerRow('Live $i', key: 'l$i'),
      ], id: 'long');
      await app.go('/sessions/codex/short');
      await app.liveAll(studio, [
        for (var i = 0; i < 10; i++) answerRow('Live $i', key: 'l$i'),
      ], id: 'short');
      await app.go('/sessions/codex/quiet');
      await app.elapse(const Duration(seconds: 5));
      await f.quit();

      final restarted = await f.restart();
      await restarted.go('/sessions/codex/long');
      await restarted.go('/sessions/codex/short');
      await restarted.go('/sessions/codex/quiet');
      expect(
        studio.socketsFor('quiet')[1].attachParams['ticket'],
        'r100',
        reason: 'a copy that holds exactly what its cursor covers resumes',
      );
      for (final id in ['short', 'long']) {
        expect(
          studio.socketsFor(id)[1].attachParams['ticket'],
          isNull,
          reason:
              '$id grew by rows its cursor does not cover, so the copy '
              'cannot say "resume after everything here"',
        );
      }
    });
  });

  group('cards waiting for an answer', () {
    featureTest('stay waiting across a reconnect only if the broker says '
        'they still are', (f) async {
      Map<String, Object?> card(String id) => row('permission-request', {
        'requestId': id,
        'title': 'Run $id?',
        'tool': 'shell',
      });
      final (app, studio) = await launchWithTranscript(
        f,
        const [],
        viewport: FeatureViewport.desktopTall,
        setup: (studio) => scriptAttaches(studio, 's1', [
          (_) => [
            historyFrame(
              [userRow('Go', key: 'u1')],
              reset: true,
              cursor: 'r1',
            ),
            messageFrame(card('p1'), 1),
            messageFrame(card('p2'), 2),
            messageFrame(card('p3'), 3),
          ],
          // The reconnect restates only the card still waiting, and one more
          // was answered meanwhile.
          (_) => [
            historyFrame(const [], cursor: 'r1'),
            messageFrame(card('p1'), 101),
            messageFrame(
              row('permission-resolved', {
                'requestId': 'p3',
                'decision': 'allow',
              }),
              102,
            ),
          ],
        ]),
      );
      await app.go('/sessions/codex/s1');
      Finder approve(String id) =>
          find.byKey(Key('session-detail-permission-approve-$id'));
      bool answerable(String id) =>
          app.tester.widget<FilledButton>(approve(id)).onPressed != null;
      for (final id in ['p1', 'p2', 'p3']) {
        expect(answerable(id), isTrue, reason: '$id waits for an answer');
      }

      await reconnect(app, studio, 's1');
      expect(answerable('p1'), isTrue, reason: 'the broker restated it');
      expect(
        app.shown('No longer waiting for an answer.'),
        1,
        reason: 'p2 was not restated: the broker no longer offers it',
      );
      expect(answerable('p2'), isFalse);
      expect(
        app.shown('Resolved.'),
        1,
        reason: 'p3 was answered while the stream was down',
      );
      expect(answerable('p3'), isFalse);

      // A flood of large rows: the card the broker still offers is pinned
      // beside them; the one it stopped offering is released like an answered
      // one.
      await app.liveAll(studio, [
        for (var i = 0; i < 14; i++)
          toolResultRow(
            'big-$i',
            toolName: 'Read',
            extra: {'result': 'r' * (450 * 1024)},
          ),
      ]);
      expect(
        answerable('p1'),
        isTrue,
        reason: 'a card still waiting is never pushed out by new rows',
      );
      expect(
        approve('p2'),
        findsNothing,
        reason: 'the broker no longer offers it, so it gives way',
      );
    });
  });
}
