// F03a — Transcript rendering of file edits: each adapter's normalized diff
// shape, bounded long diffs, and oversized diff bodies the broker keeps behind
// a signed, content-hashed URL (fetched over the fake broker's HTTP).
//
// The diff shapes are written from the normalized output of each adapter's
// edit mapping (the adapters' own tests). They are repo-written, not captured
// from the real agents: unverified against a live agent.
// Long fixture strings and bidi controls are the data under test.
// ignore_for_file: lines_longer_than_80_chars
import 'dart:convert';

import 'package:broker_crypto/broker_crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../support/feature/cosyncing_app.dart';
import '../support/feature/fake_broker.dart';
import '../support/feature/session_driver.dart';
import '../support/feature/transcript_wire.dart';

Map<String, Object?> editResult(
  String callId, {
  String? diff,
  String path = 'lib/a.dart',
  Map<String, Object?> extra = const {},
}) => toolResultRow(
  callId,
  toolClass: 'edit',
  toolName: 'Edit',
  extra: {'title': 'Edited $path', 'path': path, 'diff': ?diff, ...extra},
);

const _diff =
    '@@ -1,3 +1,4 @@\n'
    ' context line\n'
    '-old line\n'
    '+new line\n'
    '+added line';

// Claude: structuredPatch -> `@@ -a,b +c,d @@` header + git-prefixed lines.
const _claudeDiff =
    '@@ -10,2 +10,3 @@\n context ten\n-claude old\n+claude new\n+claude added';
// Codex: apply_patch (V4A) -> git-style headers and a range-less `@@ ctx`.
const _codexDiff =
    'diff --git a/lib/a.dart b/lib/a.dart\n--- a/lib/a.dart\n'
    '+++ b/lib/a.dart\n@@ class A\n keep\n-codex old\n+codex new';
// Pi: a real unified diff with index line and hunk ranges.
const _piDiff =
    'diff --git a/p.py b/p.py\nindex e69de29..a1b2c3d 100644\n--- a/p.py\n'
    '+++ b/p.py\n@@ -1,1 +1,2 @@\n base line\n+pi added';
// OpenCode: a patch body with no `diff --git` preamble.
const _opencodeDiff =
    '--- a/o.go\n+++ b/o.go\n@@ -3,1 +3,2 @@\n anchor\n+opencode added';

String markers(Finder card) {
  final out = StringBuffer();
  for (final element
      in find
          .descendant(
            of: card,
            matching: find.byKey(const Key('tool-diff-marker')),
          )
          .evaluate()) {
    final widget = element.widget;
    if (widget is Text) {
      out.write(widget.data);
    } else {
      final text = find.descendant(
        of: find.byWidget(widget),
        matching: find.byType(Text),
      );
      for (final t in text.evaluate()) {
        out.write((t.widget as Text).data);
      }
    }
  }
  return out.toString();
}

void main() {
  group('edit diffs', () {
    featureTest("each adapter's normalized edit shape expands to +/- diff "
        'lines', (f) async {
      final app = await openTranscript(f, [
        editResult('claude', diff: _claudeDiff),
        editResult('codex', diff: _codexDiff),
        editResult('pi', diff: _piDiff, path: 'p.py'),
        editResult('opencode', diff: _opencodeDiff, path: 'o.go'),
      ]);
      expect(find.byKey(const Key('tool-diff-view')), findsNothing);
      for (final (id, added, removed) in const [
        ('claude', 'claude new', 'claude old'),
        ('codex', 'codex new', 'codex old'),
        ('pi', 'pi added', null),
        ('opencode', 'opencode added', null),
      ]) {
        await app.inspect(id, (card) {
          expect(
            inside(card, find.byKey(const Key('tool-diff-view'))),
            findsOneWidget,
          );
          expect(inside(card, find.text(added)), findsOneWidget, reason: id);
          if (removed != null) {
            expect(
              inside(card, find.text(removed)),
              findsOneWidget,
              reason: id,
            );
          }
          // Parsed lines, not a raw `diff:` dump.
          expect(inside(card, find.textContaining('diff:')), findsNothing);
        });
      }
    });

    // [REG R4 #3] `--- `/`+++ ` pairs that are file headers must not be
    // counted as removed/added lines (the header miscount rendered +3/-3), and
    // a removed `-- old value` line must not be read as a header.
    featureTest('file headers are not miscounted as changes, and content that '
        'looks like a header stays content', (f) async {
      final app = await openTranscript(f, [
        editResult(
          'two-files',
          diff:
              '--- a/f1\n+++ b/f1\n@@ ctx\n+a1\n-r1\n'
              '--- a/f2\n+++ b/f2\n@@ ctx\n+a2\n-r2',
        ),
        editResult(
          'body-pair',
          diff:
              '--- a/x.txt\n+++ b/x.txt\n@@ context\n'
              '--- old value\n+++ new value',
        ),
      ]);
      await app.inspect('two-files', (card) {
        final shown = markers(card);
        expect('+'.allMatches(shown).length, 2, reason: 'markers: $shown');
        expect('-'.allMatches(shown).length, 2, reason: 'markers: $shown');
        expect(inside(card, find.text('a2')), findsOneWidget);
        expect(inside(card, find.text('r2')), findsOneWidget);
      });
      await app.inspect('body-pair', (card) {
        expect(inside(card, find.text('-- old value')), findsOneWidget);
        expect(inside(card, find.text('++ new value')), findsOneWidget);
        final shown = markers(card);
        expect('+'.allMatches(shown).length, 1);
        expect('-'.allMatches(shown).length, 1);
      });
    });
  });

  group('diff gutters and layout', () {
    for (final viewport in [
      FeatureViewport.narrowPhoneTall,
      FeatureViewport.desktopTall,
    ]) {
      featureTest('the line-number gutter fits one, three and five digits at '
          '${viewport.size.width.toInt()} dp', (f) async {
        final app = await openTranscript(f, [
          editResult('one', diff: '@@ -1,1 +1,1 @@\n-old\n+new'),
          editResult('three', diff: '@@ -999,1 +999,1 @@\n-old\n+new'),
          editResult('five', diff: '@@ -99999,1 +99999,1 @@\n-old\n+new'),
        ], viewport: viewport);
        double gutter(Finder card) => app.tester
            .getSize(
              inside(card, find.byKey(const Key('tool-diff-old-gutter'))).first,
            )
            .width;
        late double one;
        late double three;
        late double five;
        await app.inspect('one', (card) => one = gutter(card));
        await app.inspect('three', (card) => three = gutter(card));
        await app.inspect('five', (card) => five = gutter(card));
        expect(one, inInclusiveRange(20, 64));
        expect(three, greaterThan(one));
        expect(five, greaterThan(three));
        expect(five, lessThanOrEqualTo(64));
      });
    }

    featureTest('range-less diffs reserve no line-number columns, and a '
        'binary change shows a note instead of empty rows', (f) async {
      final app = await openTranscript(f, [
        editResult('rangeless', diff: '@@ class Example\n-old\n+new'),
        editResult(
          'binary',
          path: 'assets/logo.png',
          diff:
              'diff --git a/logo.png b/logo.png\nindex a1..b2 100644\n'
              'Binary files a/logo.png and b/logo.png differ',
        ),
      ]);
      await app.inspect('rangeless', (card) {
        expect(
          inside(card, find.byKey(const Key('tool-diff-old-gutter'))),
          findsNothing,
        );
        expect(
          inside(card, find.byKey(const Key('tool-diff-new-gutter'))),
          findsNothing,
        );
        expect(
          app.tester
              .getSize(
                inside(card, find.byKey(const Key('tool-diff-marker'))).first,
              )
              .width,
          16,
        );
      });
      await app.inspect('binary', (card) {
        expect(
          inside(card, find.byKey(const Key('tool-diff-binary'))),
          findsOneWidget,
        );
        expect(
          inside(card, find.byKey(const Key('tool-diff-show-more'))),
          findsNothing,
        );
      });
    });

    featureTest('a multi-file change shows one box per file', (f) async {
      final app = await openTranscript(f, [
        editResult(
          'multi',
          path: 'lib/one.dart',
          extra: {
            'title': 'Changed 2 files',
            'fileChanges': [
              {
                'path': 'lib/one.dart',
                'operation': 'edit',
                'additions': 1,
                'deletions': 1,
                'diff':
                    'diff --git a/lib/one.dart b/lib/one.dart\n--- a/lib/one.dart\n'
                    '+++ b/lib/one.dart\n@@ -1,1 +1,1 @@\n-one old\n+one new',
              },
              {
                'path': 'lib/two.dart',
                'operation': 'create',
                'additions': 2,
                'deletions': 0,
                'diff':
                    'diff --git a/lib/two.dart b/lib/two.dart\nnew file\n'
                    '--- /dev/null\n+++ b/lib/two.dart\n@@ -0,0 +1,2 @@\n+two a\n+two b',
              },
            ],
          },
        ),
      ]);
      await app.inspect('multi', (card) {
        expect(
          inside(card, find.byKey(const Key('tool-diff-file-0'))),
          findsOneWidget,
        );
        expect(
          inside(card, find.byKey(const Key('tool-diff-file-1'))),
          findsOneWidget,
        );
        expect(inside(card, find.text('one new')), findsOneWidget);
        expect(inside(card, find.text('two a')), findsOneWidget);
      });
    });

    featureTest('a long diff builds one chunk with show-more, and the '
        'truncation note comes only after the cap', (f) async {
      final big = [
        '@@ -1,0 +1,200 @@',
        for (var i = 0; i < 200; i++) '+row $i',
      ].join('\n');
      // 500 additions pass the 400-line parse cap.
      final huge = [
        '@@ -1,0 +1,500 @@',
        for (var i = 0; i < 500; i++) '+big $i',
      ].join('\n');
      final app = await openTranscript(f, [
        editResult('big', diff: big),
        editResult('huge', diff: huge),
      ]);
      await app.toggleTool('big');
      expect(find.byKey(const Key('tool-diff-show-more')), findsOneWidget);
      expect(find.text('row 10'), findsOneWidget);
      expect(find.text('row 90'), findsNothing);
      await app.tapKey('tool-diff-show-more');
      expect(find.text('row 90'), findsOneWidget);
      await app.toggleTool('big');

      await app.toggleTool('huge');
      expect(find.byKey(const Key('tool-diff-truncated')), findsNothing);
      expect(find.text('Show 60 more lines'), findsOneWidget);
      var guard = 0;
      while (find
          .byKey(const Key('tool-diff-show-more'))
          .evaluate()
          .isNotEmpty) {
        await app.tapKey('tool-diff-show-more');
        if (++guard > 20) fail('show-more did not converge');
      }
      expect(find.byKey(const Key('tool-diff-truncated')), findsOneWidget);
    });

    featureTest('Copy puts the raw diff on the clipboard from a 40 dp target '
        'on touch platforms', (f) async {
      final app = await openTranscript(f, [editResult('e1', diff: _diff)]);
      final copied = app.captureClipboard();
      await app.toggleTool('e1');
      final size = app.tester.getSize(find.byKey(const Key('tool-diff-copy')));
      expect(size.width, greaterThanOrEqualTo(40));
      expect(size.height, greaterThanOrEqualTo(40));
      await app.tapKey('tool-diff-copy');
      expect(copied, [_diff]);
      // The confirmation snack bar times out on its own.
      await app.elapse(const Duration(seconds: 6));
    }, platform: TargetPlatform.iOS);

    featureTest('diff lines do not wrap, scroll horizontally as one unit and '
        'are selectable', (f) async {
      final app = await openTranscript(f, [
        editResult('wide', diff: '@@ -1,1 +1,2 @@\n short\n+${'x' * 400}'),
      ]);
      await app.toggleTool('wide');
      expect(
        find.byWidgetPredicate((w) => w is Text && w.softWrap == false),
        findsWidgets,
      );
      expect(
        find.descendant(
          of: find.byKey(const Key('tool-diff-view')),
          matching: find.byWidgetPredicate(
            (w) =>
                w is SingleChildScrollView &&
                w.scrollDirection == Axis.horizontal,
          ),
        ),
        findsOneWidget,
      );
      expect(
        find.ancestor(
          of: find.text('short'),
          matching: find.byType(SelectionArea),
        ),
        findsWidgets,
      );
    });

    for (final (label, viewport, mode, scale) in [
      ('a 320 dp phone', FeatureViewport.narrowPhoneTall, null, null),
      ('the dark theme', FeatureViewport.desktopTall, 'dark', null),
      ('2.0 text scale on a phone', FeatureViewport.phoneTall, null, 2.0),
    ]) {
      featureTest('a wide diff lays out without overflow on $label', (f) async {
        final app = await openTranscript(
          f,
          [
            editResult(
              'wide',
              diff: '@@ -1,1 +1,2 @@\n anchor\n+${'wide ' * 60}',
            ),
          ],
          viewport: viewport,
          themeMode: mode,
          systemTextScale: scale,
          deepLink: true,
        );
        await app.toggleTool('wide');
        expect(find.byKey(const Key('tool-diff-view')), findsOneWidget);
        final error = app.tester.takeException();
        expect(
          error == null ? null : (error as FlutterError).toStringDeep(),
          isNull,
        );
      });
    }

    featureTest('a vertical drag over a diff scrolls the transcript, not the '
        'diff', (f) async {
      final wide = [
        '@@ -1,0 +1,40 @@',
        for (var i = 0; i < 40; i++) '+row $i ${'wide ' * 20}',
      ].join('\n');
      final app = await openTranscript(
        f,
        [editResult('e1', diff: wide)],
        viewport: FeatureViewport.desktop,
      );
      await app.toggleTool('e1');
      final vertical = app.transcriptScrollable;
      final position = app.tester.state<ScrollableState>(vertical).position;
      final before = position.pixels;
      // A transcript that follows its tail stays on the tail as the diff
      // grows, so the proving drag goes back up into history.
      expect(before, closeTo(position.maxScrollExtent, 32));
      await app.tester.drag(
        find.byKey(const Key('tool-diff-view')),
        const Offset(0, 200),
      );
      await app.settle();
      expect(
        app.tester.state<ScrollableState>(vertical).position.pixels,
        lessThan(before),
      );
    });
  });

  group('oversized diff bodies', () {
    /// Serves [body] at `/api/sessions/codex/s1/artifact/<name>` and returns the `diffRef` a
    /// broker would put on the tool result, signed with [sig].
    Future<Map<String, Object?>> serve(
      FakeBroker broker,
      String name,
      String body, {
      String sig = '1',
      int? advertisedBytes,
      bool truncated = false,
      String? hash,
    }) async {
      final bytes = utf8.encode(body);
      final digest = (await sha256Digest(bytes)).substring('sha256:'.length);
      broker.files['/api/sessions/codex/s1/artifact/$name'] =
          FakeBrokerResponse.text(200, body);
      return {
        'fetchUrl': broker.baseUri
            .resolve('/api/sessions/codex/s1/artifact/$name?sig=$sig')
            .toString(),
        'contentHash': hash ?? digest,
        'byteSize': advertisedBytes ?? bytes.length,
        'lineCount': 800,
        if (truncated) 'truncated': true,
      };
    }

    Map<String, Object?> refResult(
      String callId,
      Map<String, Object?> ref, {
      Map<String, Object?> extra = const {},
    }) => editResult(
      callId,
      path: 'lib/big.dart',
      extra: {'title': 'Edited big.dart', 'diffRef': ref, ...extra},
    );

    int fetches(FakeBroker broker, String name) => broker
        .requestsTo('/api/sessions/codex/s1/artifact/$name', method: 'GET')
        .length;

    featureTest('a diff the broker kept behind a URL is fetched once, when the '
        'row opens, and rendered', (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final ref = await serve(
        studio,
        'a',
        '@@ -1,1 +1,2 @@\n context\n+fetched addition',
      );
      final app = await openTranscript(f, [
        refResult('big', ref),
      ], broker: studio);
      expect(
        fetches(studio, 'a'),
        0,
        reason: 'nothing is fetched while collapsed',
      );
      await app.toggleTool('big');
      expect(fetches(studio, 'a'), 1);
      expect(find.byKey(const Key('tool-diff-ref-body')), findsOneWidget);
      expect(find.text('fetched addition'), findsOneWidget);
      // Collapsing and opening again is served from the cache.
      await app.toggleTool('big');
      await app.toggleTool('big');
      expect(find.text('fetched addition'), findsOneWidget);
      expect(fetches(studio, 'a'), 1);
    });

    featureTest('a clipped body says so; a clipped multi-file diff keeps its '
        'survivors and notes what was omitted', (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final one = await serve(
        studio,
        'clipped',
        '@@ -1,1 +1,2 @@\n context\n+first part only',
        truncated: true,
      );
      final two = await serve(
        studio,
        'survivor',
        'diff --git a/lib/one.dart b/lib/one.dart\n--- a/lib/one.dart\n'
            '+++ b/lib/one.dart\n@@ -1,1 +1,1 @@\n-one old\n+one new',
        truncated: true,
      );
      final all = await serve(
        studio,
        'whole',
        'diff --git a/lib/one.dart b/lib/one.dart\n--- a/lib/one.dart\n'
            '+++ b/lib/one.dart\n@@ -1,1 +1,1 @@\n-one old\n+one new\n'
            'diff --git a/lib/two.dart b/lib/two.dart\nnew file\n--- /dev/null\n'
            '+++ b/lib/two.dart\n@@ -0,0 +1,1 @@\n+two new',
      );
      final files = [
        {'path': 'lib/one.dart', 'operation': 'edit'},
        {'path': 'lib/two.dart', 'operation': 'create'},
      ];
      final app = await openTranscript(f, [
        refResult('clipped', one),
        refResult('survivor', two, extra: {'fileChanges': files}),
        refResult('whole', all, extra: {'fileChanges': files}),
      ], broker: studio);
      await app.inspect('clipped', (card) {
        expect(
          inside(card, find.byKey(const Key('tool-diff-ref-body'))),
          findsOneWidget,
        );
        expect(
          inside(card, find.byKey(const Key('tool-diff-ref-truncated'))),
          findsOneWidget,
        );
      });
      await app.inspect('survivor', (card) {
        expect(
          inside(card, find.byKey(const Key('tool-diff-ref-file-0'))),
          findsOneWidget,
        );
        expect(
          inside(card, find.byKey(const Key('tool-diff-ref-file-1'))),
          findsNothing,
        );
        expect(
          inside(card, find.byKey(const Key('tool-diff-ref-omitted'))),
          findsOneWidget,
        );
        expect(inside(card, find.text('one new')), findsOneWidget);
      });
      await app.inspect('whole', (card) {
        expect(
          inside(card, find.byKey(const Key('tool-diff-ref-file-0'))),
          findsOneWidget,
        );
        expect(
          inside(card, find.byKey(const Key('tool-diff-ref-file-1'))),
          findsOneWidget,
        );
        expect(
          inside(card, find.byKey(const Key('tool-diff-ref-body'))),
          findsNothing,
        );
        expect(inside(card, find.text('one new')), findsOneWidget);
        expect(inside(card, find.text('two new')), findsOneWidget);
      });
    });

    featureTest('an over-ceiling body is never fetched and has no retry; an '
        'evicted one says unavailable and has no retry', (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final big = await serve(
        studio,
        'toobig',
        '@@ -1,1 +1,1 @@\n-x\n+y',
        advertisedBytes: 5 * 1024 * 1024,
      );
      final gone = await serve(studio, 'gone', '@@ -1,1 +1,1 @@\n-x\n+y');
      studio.files['/api/sessions/codex/s1/artifact/gone'] =
          FakeBrokerResponse.error(404, 'ARTIFACT_NOT_FOUND', 'gone');
      final app = await openTranscript(f, [
        refResult('toobig', big),
        refResult('gone', gone),
      ], broker: studio);
      await app.inspect('toobig', (card) {
        expect(
          inside(card, find.byKey(const Key('tool-diff-ref-toolarge'))),
          findsOneWidget,
        );
        expect(
          inside(card, find.byKey(const Key('tool-diff-ref-retry'))),
          findsNothing,
        );
      });
      expect(fetches(studio, 'toobig'), 0);
      await app.inspect('gone', (card) {
        expect(
          inside(card, find.byKey(const Key('tool-diff-ref-unavailable'))),
          findsOneWidget,
        );
        expect(
          inside(card, find.byKey(const Key('tool-diff-ref-retry'))),
          findsNothing,
        );
      });
      app.expectNoRawErrorLeak();
    });

    featureTest('a transient failure offers Retry, which succeeds; a body '
        'that does not match its hash is rejected', (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final flaky = await serve(
        studio,
        'flaky',
        '@@ -1,1 +1,1 @@\n-x\n+recovered',
      );
      final forged = await serve(
        studio,
        'forged',
        '@@ -1,1 +1,1 @@\n-x\n+forged body',
        hash: 'd' * 64,
      );
      final app = await openTranscript(f, [
        refResult('flaky', flaky),
        refResult('forged', forged),
      ], broker: studio);
      studio.respondNext(
        'GET',
        '/api/sessions/codex/s1/artifact/flaky',
        FakeBrokerResponse.error(500, 'BROKER_INTERNAL', 'try later'),
      );
      await app.toggleTool('flaky');
      expect(find.byKey(const Key('tool-diff-ref-error')), findsOneWidget);
      await app.tapKey('tool-diff-ref-retry');
      expect(find.byKey(const Key('tool-diff-ref-body')), findsOneWidget);
      expect(find.text('recovered'), findsOneWidget);
      expect(fetches(studio, 'flaky'), 2);
      await app.toggleTool('flaky');

      await app.toggleTool('forged');
      expect(find.text('forged body'), findsNothing);
      expect(find.byKey(const Key('tool-diff-ref-body')), findsNothing);
      expect(find.byKey(const Key('tool-diff-ref-error')), findsOneWidget);
      app.expectNoRawErrorLeak();
    });

    featureTest('a re-signed URL for a body already shown is not fetched '
        'again; an expired body is fetched again once the URL is re-signed', (
      f,
    ) async {
      final studio = f.network.add('http://studio.test:7734');
      // Over the loader's cache ceiling, so only the row's own state can
      // prevent a second download.
      final body = '@@ -1,1 +1,1 @@\n-x\n+shown\n${'+pad\n' * 40000}';
      final ref = await serve(studio, 'resign', body);
      final app = await openTranscript(f, [
        refResult('e1', ref),
      ], broker: studio);
      await app.toggleTool('e1');
      expect(find.text('shown'), findsOneWidget);
      expect(fetches(studio, 'resign'), 1);
      await app.live(
        studio,
        refResult('e1', {
          ...ref,
          'fetchUrl': studio.baseUri
              .resolve('/api/sessions/codex/s1/artifact/resign?sig=2')
              .toString(),
        }),
      );
      expect(find.text('shown'), findsOneWidget);
      expect(
        fetches(studio, 'resign'),
        1,
        reason: 'same body, fresh signature',
      );
      await app.toggleTool('e1');

      // An expired signature: unavailable first, then the broker re-signs.
      final expired = await serve(studio, 'expired', body);
      studio.files['/api/sessions/codex/s1/artifact/expired'] =
          FakeBrokerResponse.error(404, 'ARTIFACT_NOT_FOUND', 'expired');
      await app.live(studio, refResult('e2', expired));
      await app.toggleTool('e2');
      expect(
        find.byKey(const Key('tool-diff-ref-unavailable')),
        findsOneWidget,
      );
      studio.files['/api/sessions/codex/s1/artifact/expired'] =
          FakeBrokerResponse.text(200, body);
      await app.live(
        studio,
        refResult('e2', {
          ...expired,
          'fetchUrl': studio.baseUri
              .resolve('/api/sessions/codex/s1/artifact/expired?sig=2')
              .toString(),
        }),
      );
      expect(find.byKey(const Key('tool-diff-ref-body')), findsOneWidget);
      expect(fetches(studio, 'expired'), 2);
    });

    featureTest('two rows opened on one body share one download, and a '
        'replay that repoints a row loads the new body', (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final shared = await serve(
        studio,
        'shared',
        '@@ -1,1 +1,1 @@\n-x\n+shared body',
      );
      final a = await serve(studio, 'body-a', '@@ -1,1 +1,1 @@\n-old\n+body A');
      final b = await serve(studio, 'body-b', '@@ -1,1 +1,1 @@\n-old\n+body B');
      final app = await openTranscript(f, [
        refResult('r1', shared),
        refResult('r2', shared),
        refResult('moving', a),
      ], broker: studio);
      final held = studio.hold('GET', '/api/sessions/codex/s1/artifact/shared');
      await app.toggleTool('r1');
      await app.toggleTool('r2');
      expect(held.arrivals, 1, reason: 'one download for both rows');
      held.release();
      await app.settle();
      expect(find.text('shared body'), findsNWidgets(2));
      expect(fetches(studio, 'shared'), 1);
      await app.toggleTool('r1');
      await app.toggleTool('r2');

      await app.toggleTool('moving');
      expect(find.text('body A'), findsOneWidget);
      await app.live(studio, refResult('moving', b));
      expect(find.text('body B'), findsOneWidget);
      expect(find.text('body A'), findsNothing);
    });

    featureTest('a fresh URL that arrives while the first request is in '
        'flight is the one retried after the stale one fails', (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final body = '@@ -1,1 +1,1 @@\n-x\n+after retry\n${'+pad\n' * 40000}';
      final ref = await serve(studio, 'race', body);
      final app = await openTranscript(f, [
        refResult('e1', ref),
      ], broker: studio);
      final held = studio.hold('GET', '/api/sessions/codex/s1/artifact/race');
      await app.toggleTool('e1');
      expect(find.byKey(const Key('tool-diff-ref-loading')), findsOneWidget);
      await app.live(
        studio,
        refResult('e1', {
          ...ref,
          'fetchUrl': studio.baseUri
              .resolve('/api/sessions/codex/s1/artifact/race?sig=2')
              .toString(),
        }),
      );
      held.release(
        FakeBrokerResponse.error(403, 'ARTIFACT_FORBIDDEN', 'stale signature'),
      );
      await app.pumpUntil(
        () =>
            fetches(studio, 'race') == 2 &&
            studio.requests.last.answered != null,
        reason: 'the stale request fails and the fresher URL is retried',
      );
      final sigs = [
        for (final r in studio.requestsTo(
          '/api/sessions/codex/s1/artifact/race',
          method: 'GET',
        ))
          r.uri.queryParameters['sig'],
      ];
      expect(sigs, ['1', '2']);
    });

    featureTest('the retried body renders after a stale URL fails', (f) async {
      final studio = f.network.add('http://studio.test:7734');
      final body = '@@ -1,1 +1,1 @@\n-x\n+after retry\n${'+pad\n' * 40000}';
      final ref = await serve(studio, 'race2', body);
      final app = await openTranscript(f, [
        refResult('e1', ref),
      ], broker: studio);
      final held = studio.hold('GET', '/api/sessions/codex/s1/artifact/race2');
      await app.toggleTool('e1');
      await app.live(
        studio,
        refResult('e1', {
          ...ref,
          'fetchUrl': studio.baseUri
              .resolve('/api/sessions/codex/s1/artifact/race2?sig=2')
              .toString(),
        }),
      );
      held.release(
        FakeBrokerResponse.error(403, 'ARTIFACT_FORBIDDEN', 'stale signature'),
      );
      await app.pumpUntil(
        () => find.text('after retry').evaluate().isNotEmpty,
        reason: 'the retry with the fresher URL renders the body',
      );
    });
  });
}
