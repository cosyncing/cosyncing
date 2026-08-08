import 'dart:async';
import 'dart:convert';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:broker_crypto/broker_crypto.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_diff_body_loader.dart';
import 'package:cosyncing_client/src/features/sessions/renderers/message_renderer_registry.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

/// A fake diff-body loader: returns [body], or throws to simulate an
/// unavailable/transient failure. Records the number of load attempts.
class _FakeDiffBodyLoader implements DiffBodyLoader {
  _FakeDiffBodyLoader({
    this.body,
    this.bodies,
    this.error,
    this.failFirst = false,
  });

  final String? body;

  /// Per-content-hash bodies, for exercising reload-on-reference-change.
  final Map<String, String>? bodies;
  final Object? error;
  final bool failFirst;
  int attempts = 0;

  @override
  Future<String> load({
    required String url,
    required String contentHash,
    int? expectedBytes,
  }) async {
    attempts++;
    // Rethrows the caller-supplied failure verbatim to exercise the
    // unavailable/too-large (typed) and transient (generic) fetch-error branches.
    // ignore: only_throw_errors
    if (error != null && !(failFirst && attempts > 1)) throw error!;
    return bodies?[contentHash] ??
        body ??
        '@@ -1,1 +1,1 @@\n-fetched old\n+fetched new';
  }
}

/// A session page whose only event is one edit tool-result carrying [raw]
/// (arbitrary canonical fields — fileChanges / diffRef), optionally with a
/// fake diff-body [loader].
Widget _rawResultPage(
  Map<String, Object?> raw, {
  DiffBodyLoader? loader,
}) => buildSessionDetailTestPage(
  diffBodyLoader: loader,
  events: [
    MessageWireEvent(
      seq: 1,
      message: AgentMessage(
        type: AgentMessageType.toolResult,
        raw: {
          'type': 'tool-result',
          'callId': 'e1',
          'toolClass': 'edit',
          'title': 'Edited files',
          ...raw,
        },
      ),
    ),
  ],
);

const _diff =
    '@@ -1,3 +1,4 @@\n'
    ' context line\n'
    '-old line\n'
    '+new line\n'
    '+added line';

/// Builds a session page whose only event is one edit tool-result carrying
/// [diff]. Mirrors how each adapter emits a final edit result (no paired call —
/// the final-only case), so expanding the row reaches the git-style diff view.
Widget _editResultPage(
  String diff, {
  String callId = 'e1',
  String? path,
  ThemeData? theme,
  double textScale = 1,
}) => buildSessionDetailTestPage(
  theme: theme,
  textScale: textScale,
  events: [
    MessageWireEvent(
      seq: 1,
      message: AgentMessage(
        type: AgentMessageType.toolResult,
        raw: {
          'type': 'tool-result',
          'callId': callId,
          'toolClass': 'edit',
          'title': 'Edited file',
          if (path != null) 'path': path,
          'diff': diff,
        },
      ),
    ),
  ],
);

/// Expands the edit row so the diff view mounts.
Future<void> _expand(WidgetTester tester, {String callId = 'e1'}) async {
  await tester.tap(find.byKey(Key('tool-$callId-details')));
  await tester.pumpAndSettle();
}

ThemeData _diffTheme({
  Brightness brightness = Brightness.light,
  TargetPlatform? platform,
}) {
  final spec = themeSpecById(kDefaultThemeId);
  return ThemeData(
    brightness: brightness,
    platform: platform,
    splashFactory: InkRipple.splashFactory,
    extensions: [
      if (brightness == Brightness.dark) spec.dark else spec.light,
    ],
  );
}

// One representative event-time edit diff per adapter, in the normalized shape
// each adapter's implementation.ts now emits (see the adapter tests):
//  - Claude: structuredPatch → `@@ -a,b +c,d @@` header + git-prefixed lines.
const _claudeDiff =
    '@@ -10,2 +10,3 @@\n'
    ' context ten\n'
    '-claude old\n'
    '+claude new\n'
    '+claude added';
//  - Codex: apply_patch (V4A) → git-style `diff --git`/`---`/`+++` + `@@ ctx`.
const _codexDiff =
    'diff --git a/lib/a.dart b/lib/a.dart\n'
    '--- a/lib/a.dart\n'
    '+++ b/lib/a.dart\n'
    '@@ class A\n'
    ' keep\n'
    '-codex old\n'
    '+codex new';
//  - Pi: passes through a real unified diff with index + hunk ranges.
const _piDiff =
    'diff --git a/p.py b/p.py\n'
    'index e69de29..a1b2c3d 100644\n'
    '--- a/p.py\n'
    '+++ b/p.py\n'
    '@@ -1,1 +1,2 @@\n'
    ' base line\n'
    '+pi added';
//  - OpenCode: passes through a patch body (no `diff --git` preamble).
const _opencodeDiff =
    '--- a/o.go\n'
    '+++ b/o.go\n'
    '@@ -3,1 +3,2 @@\n'
    ' anchor\n'
    '+opencode added';

void main() {
  group('parseUnifiedDiff', () {
    test('resolves kinds and old/new line numbers', () {
      final parsed = parseUnifiedDiff(_diff);
      expect(parsed.truncated, isFalse);
      expect(parsed.lines.map((l) => l.kind), [
        DiffLineKind.hunkHeader,
        DiffLineKind.context,
        DiffLineKind.deletion,
        DiffLineKind.addition,
        DiffLineKind.addition,
      ]);

      final context = parsed.lines[1];
      expect(context.oldLine, 1);
      expect(context.newLine, 1);

      final deletion = parsed.lines[2];
      expect(deletion.oldLine, 2);
      expect(deletion.newLine, isNull);
      expect(deletion.text, 'old line');

      final firstAdd = parsed.lines[3];
      expect(firstAdd.newLine, 2);
      expect(firstAdd.oldLine, isNull);
      expect(parsed.lines[4].newLine, 3);
    });

    test('caps at maxLines and flags truncation', () {
      final big = List.generate(50, (i) => '+line $i').join('\n');
      final parsed = parseUnifiedDiff(big, maxLines: 10);
      expect(parsed.lines, hasLength(10));
      expect(parsed.truncated, isTrue);
    });

    test('a malformed patch still renders as context, never throws', () {
      final parsed = parseUnifiedDiff('not really a diff\njust text');
      expect(parsed.lines, hasLength(2));
      expect(
        parsed.lines.every((l) => l.kind == DiffLineKind.context),
        isTrue,
      );
    });

    test(
      'content lines beginning with -- or ++ are add/remove, not headers',
      () {
        final parsed = parseUnifiedDiff('@@ -1,2 +1,2 @@\n---\n+++\n context');
        expect(parsed.lines[1].kind, DiffLineKind.deletion);
        expect(parsed.lines[1].text, '--');
        expect(parsed.lines[1].oldLine, 1);
        expect(parsed.lines[2].kind, DiffLineKind.addition);
        expect(parsed.lines[2].text, '++');
        expect(parsed.lines[2].newLine, 1);
        // The following context line's number is not thrown off by one.
        expect(parsed.lines[3].kind, DiffLineKind.context);
        expect(parsed.lines[3].oldLine, 2);
      },
    );

    test('a header-less patch numbers lines from 1', () {
      final parsed = parseUnifiedDiff('+first line');
      expect(parsed.lines.single.newLine, 1);
    });

    test('a multi-file patch keeps each file section correct', () {
      const patch =
          'diff --git a/one.dart b/one.dart\n'
          '--- a/one.dart\n'
          '+++ b/one.dart\n'
          '@@ -1,2 +1,2 @@\n'
          ' keep\n'
          '-old one\n'
          '+new one\n'
          'diff --git a/two.dart b/two.dart\n'
          '--- a/two.dart\n'
          '+++ b/two.dart\n'
          '@@ -5,1 +5,2 @@\n'
          ' anchor\n'
          '+added two';
      final parsed = parseUnifiedDiff(patch);
      final metaTexts = parsed.lines
          .where((l) => l.kind == DiffLineKind.meta)
          .map((l) => l.text)
          .toList();
      // The second file's headers are meta, not misread as content.
      expect(metaTexts, contains('diff --git a/two.dart b/two.dart'));
      expect(metaTexts, contains('--- a/two.dart'));
      expect(metaTexts, contains('+++ b/two.dart'));
      final secondAdd = parsed.lines.firstWhere((l) => l.text == 'added two');
      expect(secondAdd.kind, DiffLineKind.addition);
      expect(secondAdd.newLine, 6);
    });

    test('a range-less Codex hunk does not fabricate line numbers', () {
      const patch =
          'diff --git a/x.dart b/x.dart\n'
          '--- a/x.dart\n'
          '+++ b/x.dart\n'
          '@@ class Foo\n' // no line ranges
          ' keep\n'
          '-old\n'
          '+new';
      final parsed = parseUnifiedDiff(patch);
      final del = parsed.lines.firstWhere((l) => l.text == 'old');
      final add = parsed.lines.firstWhere((l) => l.text == 'new');
      expect(del.kind, DiffLineKind.deletion);
      expect(add.kind, DiffLineKind.addition);
      // No ranges → no fabricated gutter numbers (was numbering from 1).
      expect(del.oldLine, isNull);
      expect(add.newLine, isNull);
    });

    test('content beginning with ++/-- inside a hunk is body, not a header', () {
      const patch = '@@ -1,1 +1,1 @@\n---flag\n+++counter';
      final parsed = parseUnifiedDiff(patch);
      final kinds = parsed.lines.map((l) => l.kind).toList();
      // The `---flag`/`+++counter` are a removed/added line, not file headers.
      expect(kinds, [
        DiffLineKind.hunkHeader,
        DiffLineKind.deletion,
        DiffLineKind.addition,
      ]);
      expect(parsed.lines[1].text, '--flag');
      expect(parsed.lines[2].text, '++counter');
    });

    test('range-less multi-file (no diff --git) keeps file 2 header meta', () {
      // Plain unified diff, range-less hunks, no `diff --git`: the `--- `/`+++ `
      // pair for file 2 must be a header, not red/green body lines (finding 5).
      const patch =
          '--- a/f1\n+++ b/f1\n@@ ctx\n+a1\n-r1\n'
          '--- a/f2\n+++ b/f2\n@@ ctx\n+a2\n-r2';
      final parsed = parseUnifiedDiff(patch);
      final metaTexts = parsed.lines
          .where((l) => l.kind == DiffLineKind.meta)
          .map((l) => l.text)
          .toList();
      expect(metaTexts, containsAll(['--- a/f2', '+++ b/f2']));
      // The four body lines are exactly two additions and two deletions — the
      // headers are NOT miscounted as content (the bug rendered +3/−3).
      final adds = parsed.lines.where((l) => l.kind == DiffLineKind.addition);
      final dels = parsed.lines.where((l) => l.kind == DiffLineKind.deletion);
      expect(adds.map((l) => l.text), ['a1', 'a2']);
      expect(dels.map((l) => l.text), ['r1', 'r2']);
    });

    test('a range-less `--- `/`+++ ` body pair is content, not a fake header', () {
      // Removed `-- old value` / added `++ new value` (rendered `--- old value` /
      // `+++ new value`) with NO following `@@` must stay red/green body — the
      // header-pair heuristic must not split it into a fake file (R3 #1).
      const patch =
          '--- a/x.txt\n+++ b/x.txt\n@@ context\n'
          '--- old value\n+++ new value';
      final parsed = parseUnifiedDiff(patch);
      final body = parsed.lines
          .where(
            (l) =>
                l.kind == DiffLineKind.addition ||
                l.kind == DiffLineKind.deletion,
          )
          .toList();
      expect(body.map((l) => l.kind), [
        DiffLineKind.deletion,
        DiffLineKind.addition,
      ]);
      expect(body[0].text, '-- old value');
      expect(body[1].text, '++ new value');
      // Only the true file header (followed by `@@`) is meta.
      final meta = parsed.lines
          .where((l) => l.kind == DiffLineKind.meta)
          .map((l) => l.text);
      expect(meta, containsAll(['--- a/x.txt', '+++ b/x.txt']));
      expect(meta, isNot(contains('--- old value')));
    });

    test('a body pair FOLLOWED BY a second hunk is still content (R4 #3)', () {
      // The `@@`-follows heuristic alone would mis-split this; credible-path
      // (non-`a/`·`b/` paths) keeps `--- old value`/`+++ new value` as body.
      const patch =
          '--- a/x.txt\n+++ b/x.txt\n@@ first\n'
          '--- old value\n+++ new value\n@@ second';
      final parsed = parseUnifiedDiff(patch);
      final del = parsed.lines.firstWhere((l) => l.text == '-- old value');
      final add = parsed.lines.firstWhere((l) => l.text == '++ new value');
      expect(del.kind, DiffLineKind.deletion);
      expect(add.kind, DiffLineKind.addition);
      final meta = parsed.lines
          .where((l) => l.kind == DiffLineKind.meta)
          .map((l) => l.text);
      expect(meta, isNot(contains('--- old value')));
    });
  });

  group('splitDiffByFile', () {
    test('a single-file patch returns one segment', () {
      final segments = splitDiffByFile(_diff);
      expect(segments, hasLength(1));
      expect(segments.single, _diff);
    });

    test('a git-style multi-file patch splits at each diff --git', () {
      const patch =
          'diff --git a/one.dart b/one.dart\n'
          '--- a/one.dart\n+++ b/one.dart\n@@ -1,1 +1,1 @@\n-one old\n+one new\n'
          'diff --git a/two.dart b/two.dart\n'
          'new file\n--- /dev/null\n+++ b/two.dart\n@@ -0,0 +1,1 @@\n+two new';
      final segments = splitDiffByFile(patch);
      expect(segments, hasLength(2));
      expect(segments[0], contains('one new'));
      expect(segments[0], isNot(contains('two new')));
      expect(segments[1], startsWith('diff --git a/two.dart'));
      expect(segments[1], contains('+two new'));
    });

    test(
      'range-less multi-file (no diff --git) splits into per-file segments',
      () {
        const patch =
            '--- a/f1\n+++ b/f1\n@@ ctx\n+a1\n-r1\n'
            '--- a/f2\n+++ b/f2\n@@ ctx\n+a2\n-r2';
        final segments = splitDiffByFile(patch);
        expect(segments, hasLength(2));
        expect(segments[0], contains('a1'));
        expect(segments[0], isNot(contains('a2')));
        expect(segments[1], startsWith('--- a/f2'));
        expect(segments[1], contains('a2'));
      },
    );

    test('ranged multi-file (no diff --git) closes each hunk and splits', () {
      const patch =
          '--- a/f1\n+++ b/f1\n@@ -1,1 +1,1 @@\n-r1\n+a1\n'
          '--- a/f2\n+++ b/f2\n@@ -1,1 +1,1 @@\n-r2\n+a2';
      final segments = splitDiffByFile(patch);
      expect(segments, hasLength(2));
      expect(segments[1], startsWith('--- a/f2'));
    });

    test('a range-less `--- `/`+++ ` body pair does not spuriously split', () {
      // The R3 finding-1 repro at the splitter level: one file, not two.
      const patch =
          '--- a/x.txt\n+++ b/x.txt\n@@ context\n'
          '--- old value\n+++ new value';
      final segments = splitDiffByFile(patch);
      expect(segments, hasLength(1));
    });

    test('a body pair before a second hunk does not split (credible-path)', () {
      // R4 finding 3: non-`a/`·`b/` paths → body, even followed by a `@@`.
      const patch =
          '--- a/x.txt\n+++ b/x.txt\n@@ first\n'
          '--- old value\n+++ new value\n@@ second';
      final segments = splitDiffByFile(patch);
      expect(segments, hasLength(1));
    });
  });

  group('diff tokens', () {
    test('add and remove tokens are distinct in light and dark', () {
      final spec = themeSpecById(kDefaultThemeId);
      for (final tokens in [spec.light, spec.dark]) {
        expect(tokens.diffAddText, isNot(tokens.diffRemoveText));
        expect(tokens.diffAddSurface, isNot(tokens.diffRemoveSurface));
        expect(tokens.diffAddText, isNot(tokens.diffAddSurface));
      }
    });
  });

  group('edit tool renders a git-style diff', () {
    testWidgets('expands to the coloured diff view, not raw monospace', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: [
            const MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.toolResult,
                raw: {
                  'type': 'tool-result',
                  'callId': 'edit-1',
                  'toolClass': 'edit',
                  'title': 'Edited main.dart',
                  'path': 'lib/main.dart',
                  'additions': 2,
                  'deletions': 1,
                  'durationMs': 1200,
                  'diff': _diff,
                },
              ),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();

      // Collapsed row shows the friendly title and change chips.
      expect(find.text('Edited main.dart'), findsOneWidget);
      expect(find.byKey(const Key('tool-diff-view')), findsNothing);

      await tester.tap(find.byKey(const Key('tool-edit-1-details')));
      await tester.pumpAndSettle();

      expect(find.byKey(const Key('tool-diff-view')), findsOneWidget);
      // Rendered as parsed lines, not dumped as a raw `diff:` field.
      expect(find.textContaining('diff:'), findsNothing);
      expect(find.text('new line'), findsOneWidget);
      expect(find.text('old line'), findsOneWidget);
    });

    testWidgets('re-parses when a replayed tool result updates the diff', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      final connection = ScriptedSessionDetailConnection(
        events: const [
          MessageWireEvent(
            seq: 1,
            message: AgentMessage(
              type: AgentMessageType.toolResult,
              raw: {
                'type': 'tool-result',
                'callId': 'e1',
                'toolClass': 'edit',
                'title': 'Edited x',
                'diff': '@@ -1,1 +1,1 @@\n-old A\n+new A',
              },
            ),
          ),
        ],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(events: const [], connection: connection),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('tool-e1-details')));
      await tester.pumpAndSettle();
      expect(find.text('new A'), findsOneWidget);

      // The same call id replays with an updated diff.
      connection.emitEvent(
        const MessageWireEvent(
          seq: 2,
          message: AgentMessage(
            type: AgentMessageType.toolResult,
            raw: {
              'type': 'tool-result',
              'callId': 'e1',
              'toolClass': 'edit',
              'title': 'Edited x',
              'diff': '@@ -1,1 +1,1 @@\n-old B\n+new B',
            },
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('new B'), findsOneWidget);
      expect(find.text('new A'), findsNothing);
    });
  });

  group('looksLikeBinaryDiff', () {
    test('detects git binary markers, ignores textual patches', () {
      expect(
        looksLikeBinaryDiff(
          'diff --git a/logo.png b/logo.png\n'
          'Binary files a/logo.png and b/logo.png differ',
        ),
        isTrue,
      );
      expect(looksLikeBinaryDiff('GIT binary patch\nliteral 12'), isTrue);
      expect(looksLikeBinaryDiff(_diff), isFalse);
      // "Binary" only trips the marker as a whole-line git notice, not content.
      expect(looksLikeBinaryDiff('+// Binary tree balancing'), isFalse);
    });
  });

  group('diff view is bounded, navigable, and honest', () {
    testWidgets('a binary-file change shows a note, never empty rows', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        _editResultPage(
          'diff --git a/logo.png b/logo.png\n'
          'index a1..b2 100644\n'
          'Binary files a/logo.png and b/logo.png differ',
          path: 'assets/logo.png',
        ),
      );
      await tester.pumpAndSettle();
      await _expand(tester);

      expect(find.byKey(const Key('tool-diff-view')), findsOneWidget);
      expect(find.byKey(const Key('tool-diff-binary')), findsOneWidget);
      // No misparsed +/- rows for a binary change.
      expect(find.byKey(const Key('tool-diff-show-more')), findsNothing);
    });

    testWidgets('a long diff builds one chunk with a show-more control', (
      tester,
    ) async {
      // A viewport tall enough that the chunk + control fit without scrolling,
      // so the tap lands (the control otherwise sits below the composer).
      addTearDown(tester.view.resetPhysicalSize);
      tester.view
        ..devicePixelRatio = 1
        ..physicalSize = const Size(1280, 4000);
      final big = StringBuffer('@@ -1,0 +1,200 @@\n')
        ..writeAll(List.generate(200, (i) => '+row $i'), '\n');
      await tester.pumpWidget(_editResultPage(big.toString()));
      await tester.pumpAndSettle();
      await _expand(tester);

      // First chunk (~60 rows) is built; rows past it are not yet in the tree.
      expect(find.byKey(const Key('tool-diff-show-more')), findsOneWidget);
      expect(find.text('row 10'), findsOneWidget);
      expect(find.text('row 90'), findsNothing);

      await tester.tap(find.byKey(const Key('tool-diff-show-more')));
      await tester.pumpAndSettle();
      expect(find.text('row 90'), findsOneWidget);
    });

    testWidgets('the truncation note appears only after the cap is revealed', (
      tester,
    ) async {
      // A viewport tall enough to hold the whole 400-row reveal, so the
      // show-more button is never scrolled behind the composer — each reveal
      // tap lands on the button directly (no off-screen-tap warning).
      addTearDown(() {
        tester.view.resetPhysicalSize();
        tester.view.resetDevicePixelRatio();
      });
      tester.view
        ..physicalSize = const Size(1280, 16000)
        ..devicePixelRatio = 1;
      // 500 additions > the 400-line parse cap → truncated.
      final huge = StringBuffer('@@ -1,0 +1,500 @@\n')
        ..writeAll(List.generate(500, (i) => '+big $i'), '\n');
      await tester.pumpWidget(_editResultPage(huge.toString()));
      await tester.pumpAndSettle();
      await _expand(tester);

      // Bounded: the note is withheld while more rows remain to reveal, and the
      // button labels the next reveal (one chunk), never all remaining.
      expect(find.byKey(const Key('tool-diff-truncated')), findsNothing);
      expect(find.byKey(const Key('tool-diff-show-more')), findsOneWidget);
      expect(find.text('Show 60 more lines'), findsOneWidget);

      var guard = 0;
      while (find
          .byKey(const Key('tool-diff-show-more'))
          .evaluate()
          .isNotEmpty) {
        await tester.tap(find.byKey(const Key('tool-diff-show-more')));
        await tester.pumpAndSettle();
        if (++guard > 20) fail('show-more did not converge');
      }
      expect(find.byKey(const Key('tool-diff-truncated')), findsOneWidget);
    });

    testWidgets('the copy control writes the raw diff to the clipboard', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      final copied = <MethodCall>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') copied.add(call);
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );

      await tester.pumpWidget(_editResultPage(_diff));
      await tester.pumpAndSettle();
      await _expand(tester);

      await tester.ensureVisible(find.byKey(const Key('tool-diff-copy')));
      await tester.tap(find.byKey(const Key('tool-diff-copy')));
      await tester.pump();
      expect(copied, hasLength(1));
      expect((copied.single.arguments as Map)['text'], _diff);
      // Let the confirmation SnackBar time out so no timer leaks.
      await tester.pump(const Duration(seconds: 5));
    });

    testWidgets('the copy target is a 40dp hit area on touch platforms', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        _editResultPage(_diff, theme: _diffTheme(platform: TargetPlatform.iOS)),
      );
      await tester.pumpAndSettle();
      await _expand(tester);

      // The InkWell fills its 40dp SizedBox child on touch platforms.
      final box = tester.getSize(find.byKey(const Key('tool-diff-copy')));
      expect(box.width, greaterThanOrEqualTo(40));
      expect(box.height, greaterThanOrEqualTo(40));
    });

    testWidgets('diff lines do not wrap and scroll horizontally as a unit', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        _editResultPage(
          '@@ -1,1 +1,2 @@\n'
          ' short\n'
          '+${'x' * 400}',
        ),
      );
      await tester.pumpAndSettle();
      await _expand(tester);

      // Diff line text is non-wrapping.
      final nonWrapping = find.byWidgetPredicate(
        (w) => w is Text && w.softWrap == false,
      );
      expect(nonWrapping, findsWidgets);
      // A single horizontal scroll wraps the whole diff body.
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
    });

    testWidgets('a result without a diff shows no diff view', (tester) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.toolResult,
                raw: {
                  'type': 'tool-result',
                  'callId': 'no-diff',
                  'toolClass': 'edit',
                  'title': 'Edited nothing',
                },
              ),
            ),
          ],
        ),
      );
      await tester.pumpAndSettle();
      await _expand(tester, callId: 'no-diff');
      expect(find.byKey(const Key('tool-diff-view')), findsNothing);
    });
  });

  group('renders each adapter normalized edit diff', () {
    final fixtures = <String, ({String diff, String addedLine})>{
      'claude': (diff: _claudeDiff, addedLine: 'claude new'),
      'codex': (diff: _codexDiff, addedLine: 'codex new'),
      'pi': (diff: _piDiff, addedLine: 'pi added'),
      'opencode': (diff: _opencodeDiff, addedLine: 'opencode added'),
    };
    for (final entry in fixtures.entries) {
      testWidgets('${entry.key} edit diff expands to coloured lines', (
        tester,
      ) async {
        useRoomyTestViewport(tester);
        await tester.pumpWidget(_editResultPage(entry.value.diff));
        await tester.pumpAndSettle();
        await _expand(tester);
        expect(find.byKey(const Key('tool-diff-view')), findsOneWidget);
        expect(find.text(entry.value.addedLine), findsOneWidget);
      });
    }
  });

  group('renders across density, brightness, and text scale', () {
    testWidgets('a wide diff renders without overflow in a compact viewport', (
      tester,
    ) async {
      addTearDown(tester.view.resetPhysicalSize);
      tester.view
        ..devicePixelRatio = 1
        ..physicalSize = const Size(380, 760);
      await tester.pumpWidget(
        _editResultPage(
          '@@ -1,1 +1,2 @@\n'
          ' anchor\n'
          '+${'wide ' * 60}',
        ),
      );
      await tester.pumpAndSettle();
      await _expand(tester);
      expect(find.byKey(const Key('tool-diff-view')), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('renders in the dark theme', (tester) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        _editResultPage(_diff, theme: _diffTheme(brightness: Brightness.dark)),
      );
      await tester.pumpAndSettle();
      await _expand(tester);
      expect(find.byKey(const Key('tool-diff-view')), findsOneWidget);
      expect(find.text('new line'), findsOneWidget);
    });

    testWidgets('renders at 2.0 text scale without overflow', (tester) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(_editResultPage(_diff, textScale: 2));
      await tester.pumpAndSettle();
      await _expand(tester);
      expect(find.byKey(const Key('tool-diff-view')), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('diff lines are selectable via the transcript SelectionArea', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(_editResultPage(_diff));
      await tester.pumpAndSettle();
      await _expand(tester);
      expect(
        find.ancestor(
          of: find.text('new line'),
          matching: find.byType(SelectionArea),
        ),
        findsWidgets,
      );
    });
  });

  group('adaptive line-number gutter', () {
    for (final width in <double>[360, 900]) {
      testWidgets(
        'sizes one, three, and five digits at ${width.toInt()}px',
        (tester) async {
          await tester.binding.setSurfaceSize(Size(width, 700));
          addTearDown(() => tester.binding.setSurfaceSize(null));

          Future<double> gutterFor(int line, String callId) async {
            await tester.pumpWidget(const SizedBox.shrink());
            await tester.pump();
            await tester.pumpWidget(
              _editResultPage(
                '@@ -$line,1 +$line,1 @@\n-old\n+new',
                callId: callId,
              ),
            );
            await tester.pumpAndSettle();
            await _expand(tester, callId: callId);
            return tester
                .getSize(
                  find.byKey(const Key('tool-diff-old-gutter')).first,
                )
                .width;
          }

          final one = await gutterFor(1, 'one');
          final three = await gutterFor(999, 'three');
          final five = await gutterFor(99999, 'five');

          expect(one, inInclusiveRange(20, 64));
          expect(three, greaterThan(one));
          expect(five, greaterThan(three));
          expect(five, lessThanOrEqualTo(64));
        },
      );
    }

    testWidgets('range-less diffs reserve no line-number columns', (
      tester,
    ) async {
      await tester.pumpWidget(
        _editResultPage('@@ class Example\n-old\n+new'),
      );
      await tester.pumpAndSettle();
      await _expand(tester);

      expect(find.byKey(const Key('tool-diff-old-gutter')), findsNothing);
      expect(find.byKey(const Key('tool-diff-new-gutter')), findsNothing);
      expect(
        tester.getSize(find.byKey(const Key('tool-diff-marker')).first).width,
        16,
      );
    });
  });

  group('large-diff build cost is bounded (chunk benchmark)', () {
    testWidgets('a 500-line diff builds at most one chunk of line rows', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      final huge = StringBuffer('@@ -1,0 +1,500 @@\n')
        ..writeAll(List.generate(500, (i) => '+cost $i'), '\n');
      await tester.pumpWidget(_editResultPage(huge.toString()));
      await tester.pumpAndSettle();
      await _expand(tester);

      // Only the first chunk's addition rows are materialized — build cost is
      // O(chunk), not O(500). The exact chunk size is an implementation detail;
      // the guarantee is that it is a small constant, never the full diff.
      final builtRows = find
          .byWidgetPredicate(
            (w) => w is Text && (w.data?.startsWith('cost ') ?? false),
          )
          .evaluate()
          .length;
      expect(builtRows, greaterThan(0));
      expect(builtRows, lessThanOrEqualTo(60));
    });
  });

  group('multi-file fileChanges and oversized diff references', () {
    testWidgets('a multi-file result renders one diff box per file', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      await tester.pumpWidget(
        _rawResultPage({
          'title': 'Changed 2 files',
          'additions': 3,
          'deletions': 1,
          'fileChanges': [
            {
              'path': 'lib/one.dart',
              'operation': 'edit',
              'additions': 1,
              'deletions': 1,
              'diff':
                  'diff --git a/lib/one.dart b/lib/one.dart\n'
                  '--- a/lib/one.dart\n+++ b/lib/one.dart\n'
                  '@@ -1,1 +1,1 @@\n-one old\n+one new',
            },
            {
              'path': 'lib/two.dart',
              'operation': 'create',
              'additions': 2,
              'deletions': 0,
              'diff':
                  'diff --git a/lib/two.dart b/lib/two.dart\n'
                  'new file\n--- /dev/null\n+++ b/lib/two.dart\n'
                  '@@ -0,0 +1,2 @@\n+two a\n+two b',
            },
          ],
        }),
      );
      await tester.pumpAndSettle();
      await _expand(tester);

      // One bordered diff box per file, both files' content visible.
      expect(find.byKey(const Key('tool-diff-file-0')), findsOneWidget);
      expect(find.byKey(const Key('tool-diff-file-1')), findsOneWidget);
      expect(find.text('one new'), findsOneWidget);
      expect(find.text('two a'), findsOneWidget);
    });

    testWidgets(
      'an oversized MULTI-FILE diff keeps one box per file after fetching',
      (tester) async {
        useRoomyTestViewport(tester);
        // The broker keeps per-file metadata (path/operation) and stashes the
        // aggregate body; the client re-splits it into one box per file, like
        // the inline multi-file path (finding 3).
        final loader = _FakeDiffBodyLoader(
          body:
              'diff --git a/lib/one.dart b/lib/one.dart\n'
              '--- a/lib/one.dart\n+++ b/lib/one.dart\n'
              '@@ -1,1 +1,1 @@\n-one old\n+one new\n'
              'diff --git a/lib/two.dart b/lib/two.dart\n'
              'new file\n--- /dev/null\n+++ b/lib/two.dart\n'
              '@@ -0,0 +1,1 @@\n+two new',
        );
        await tester.pumpWidget(
          _rawResultPage(
            {
              'title': 'Changed 2 files',
              // Metadata kept inline (per-file diff body moved to the ref).
              'fileChanges': [
                {'path': 'lib/one.dart', 'operation': 'edit'},
                {'path': 'lib/two.dart', 'operation': 'create'},
              ],
              'diffRef': {
                'fetchUrl': 'https://broker/x',
                'contentHash': 'd' * 64,
                'byteSize': 40000,
                'lineCount': 800,
              },
            },
            loader: loader,
          ),
        );
        await tester.pumpAndSettle();
        await _expand(tester);

        // One bordered box per file (not a single aggregate box), both visible.
        expect(find.byKey(const Key('tool-diff-ref-file-0')), findsOneWidget);
        expect(find.byKey(const Key('tool-diff-ref-file-1')), findsOneWidget);
        expect(find.byKey(const Key('tool-diff-ref-body')), findsNothing);
        expect(find.text('one new'), findsOneWidget);
        expect(find.text('two new'), findsOneWidget);
        // The create file's rename/operation label comes from kept metadata.
        expect(find.text('lib/two.dart'), findsWidgets);
      },
    );

    testWidgets('reloads when a replay repoints the row at a new body', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      final hashA = 'a' * 64;
      final hashB = 'b' * 64;
      final loader = _FakeDiffBodyLoader(
        bodies: {
          hashA: '@@ -1,1 +1,1 @@\n-old ref\n+body A',
          hashB: '@@ -1,1 +1,1 @@\n-old ref\n+body B',
        },
      );
      MessageWireEvent refEvent(int seq, String hash, String sig) =>
          MessageWireEvent(
            seq: seq,
            message: AgentMessage(
              type: AgentMessageType.toolResult,
              raw: {
                'type': 'tool-result',
                'callId': 'e1',
                'toolClass': 'edit',
                'title': 'Edited big',
                'diffRef': {
                  'fetchUrl': 'https://broker/x?sig=$sig',
                  'contentHash': hash,
                  'byteSize': 40000,
                },
              },
            ),
          );
      final connection = ScriptedSessionDetailConnection(
        events: [refEvent(1, hashA, '1')],
      );
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          diffBodyLoader: loader,
        ),
      );
      await tester.pumpAndSettle();
      await _expand(tester);
      expect(find.text('body A'), findsOneWidget);

      // The same call id replays pointing at a new content hash → reload.
      connection.emitEvent(refEvent(2, hashB, '2'));
      await tester.pumpAndSettle();
      expect(find.text('body B'), findsOneWidget);
      expect(find.text('body A'), findsNothing);
    });

    testWidgets('a broker-clipped oversized diff shows a truncated note', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      final loader = _FakeDiffBodyLoader(
        body: '@@ -1,1 +1,2 @@\n context\n+first part only',
      );
      await tester.pumpWidget(
        _rawResultPage(
          {
            'diffRef': {
              'fetchUrl': 'https://broker/x',
              'contentHash': 'e' * 64,
              'byteSize': 1048576,
              'lineCount': 20000,
              'truncated': true,
            },
          },
          loader: loader,
        ),
      );
      await tester.pumpAndSettle();
      await _expand(tester);

      expect(find.byKey(const Key('tool-diff-ref-body')), findsOneWidget);
      expect(find.byKey(const Key('tool-diff-ref-truncated')), findsOneWidget);
    });

    testWidgets('a clipped multi-file diff keeps survivors and notes omitted', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      // Two files in the metadata, but the clip left only file one's body in
      // the aggregate → render file one under its own metadata and note file
      // two as omitted, never collapse into one mislabeled box (R3 #3).
      final loader = _FakeDiffBodyLoader(
        body:
            'diff --git a/lib/one.dart b/lib/one.dart\n'
            '--- a/lib/one.dart\n+++ b/lib/one.dart\n'
            '@@ -1,1 +1,1 @@\n-one old\n+one new',
      );
      await tester.pumpWidget(
        _rawResultPage(
          {
            'title': 'Changed 2 files',
            'fileChanges': [
              {'path': 'lib/one.dart', 'operation': 'edit'},
              {'path': 'lib/two.dart', 'operation': 'create'},
            ],
            'diffRef': {
              'fetchUrl': 'https://broker/x',
              'contentHash': 'f' * 64,
              'byteSize': 4194304,
              'truncated': true,
            },
          },
          loader: loader,
        ),
      );
      await tester.pumpAndSettle();
      await _expand(tester);

      expect(find.byKey(const Key('tool-diff-ref-file-0')), findsOneWidget);
      expect(find.byKey(const Key('tool-diff-ref-file-1')), findsNothing);
      expect(find.byKey(const Key('tool-diff-ref-omitted')), findsOneWidget);
      expect(find.text('one new'), findsOneWidget);
    });

    testWidgets('an over-ceiling diff shows a too-large state, no retry', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      final loader = _FakeDiffBodyLoader(
        error: const DiffBodyTooLargeException(),
      );
      await tester.pumpWidget(
        _rawResultPage(
          {
            'diffRef': {
              'fetchUrl': 'https://broker/x',
              'contentHash': 'a' * 64,
              'byteSize': 5242880, // > the 4 MiB client ceiling
            },
          },
          loader: loader,
        ),
      );
      await tester.pumpAndSettle();
      await _expand(tester);

      expect(find.byKey(const Key('tool-diff-ref-toolarge')), findsOneWidget);
      expect(find.byKey(const Key('tool-diff-ref-retry')), findsNothing);
    });

    testWidgets('a routine URL re-sign of the same body does not refetch', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      final loader = _FakeDiffBodyLoader(body: '@@ -1,1 +1,1 @@\n-x\n+y');
      MessageWireEvent ev(int seq, String sig) => MessageWireEvent(
        seq: seq,
        message: AgentMessage(
          type: AgentMessageType.toolResult,
          raw: {
            'type': 'tool-result',
            'callId': 'e1',
            'toolClass': 'edit',
            'title': 'Edited big',
            'diffRef': {
              'fetchUrl': 'https://broker/x?sig=$sig',
              'contentHash': 'c' * 64,
              'byteSize':
                  200000, // uncached (> 128 KiB), so a refetch would show
            },
          },
        ),
      );
      final connection = ScriptedSessionDetailConnection(events: [ev(1, '1')]);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          diffBodyLoader: loader,
        ),
      );
      await tester.pumpAndSettle();
      await _expand(tester);
      expect(loader.attempts, 1);

      // Same hash, freshly-signed URL, previous load succeeded → no refetch.
      connection.emitEvent(ev(2, '2'));
      await tester.pumpAndSettle();
      expect(loader.attempts, 1);
    });

    testWidgets('an expired body refetches when its URL is re-signed', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      // First load fails unavailable (expired), second succeeds.
      final loader = _FakeDiffBodyLoader(
        body: '@@ -1,1 +1,1 @@\n-x\n+y',
        error: const DiffBodyUnavailableException(),
        failFirst: true,
      );
      MessageWireEvent ev(int seq, String sig) => MessageWireEvent(
        seq: seq,
        message: AgentMessage(
          type: AgentMessageType.toolResult,
          raw: {
            'type': 'tool-result',
            'callId': 'e1',
            'toolClass': 'edit',
            'title': 'Edited big',
            'diffRef': {
              'fetchUrl': 'https://broker/x?sig=$sig',
              'contentHash': 'c' * 64,
              'byteSize': 200000,
            },
          },
        ),
      );
      final connection = ScriptedSessionDetailConnection(events: [ev(1, '1')]);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          diffBodyLoader: loader,
        ),
      );
      await tester.pumpAndSettle();
      await _expand(tester);
      expect(
        find.byKey(const Key('tool-diff-ref-unavailable')),
        findsOneWidget,
      );

      // Re-signed URL for the same (expired) body → refetch, succeed.
      connection.emitEvent(ev(2, '2'));
      await tester.pumpAndSettle();
      expect(loader.attempts, 2);
      expect(find.text('y'), findsOneWidget);
    });

    testWidgets('a fresh URL arriving mid-request is used after stale fails', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      // The first load stays pending until we fail it; the second (retry with
      // the fresher URL) succeeds — the R4 #4 pending-request race.
      final loader = _RaceLoader();
      MessageWireEvent ev(int seq, String sig) => MessageWireEvent(
        seq: seq,
        message: AgentMessage(
          type: AgentMessageType.toolResult,
          raw: {
            'type': 'tool-result',
            'callId': 'e1',
            'toolClass': 'edit',
            'title': 'Edited big',
            'diffRef': {
              'fetchUrl': 'https://broker/x?sig=$sig',
              'contentHash': 'c' * 64,
              'byteSize': 200000, // uncached (>128 KiB)
            },
          },
        ),
      );
      final connection = ScriptedSessionDetailConnection(events: [ev(1, '1')]);
      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [],
          connection: connection,
          diffBodyLoader: loader,
        ),
      );
      await tester.pumpAndSettle();
      // Expand with a timed pump (NOT pumpAndSettle): the pending load keeps
      // the loading spinner animating, so pumpAndSettle would never settle.
      await tester.tap(find.byKey(const Key('tool-e1-details')));
      await tester.pump(const Duration(milliseconds: 400));
      // First request is in flight (loading), using the sig=1 URL.
      expect(loader.calls, 1);
      expect(find.byKey(const Key('tool-diff-ref-loading')), findsOneWidget);

      // A re-signed URL (same hash) arrives WHILE the first request is pending.
      // Pump enough to propagate the replay into _DiffRefView.reference (sig=2)
      // without settling (the spinner still animates).
      connection.emitEvent(ev(2, '2'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));

      // The stale sig=1 request now fails unavailable → reactive retry with the
      // current sig=2 URL, which succeeds (not a terminal unavailable state).
      loader.failFirstUnavailable();
      await tester.pumpAndSettle();
      // The stale sig=1 failure triggered exactly one retry, and it used the
      // FRESHER sig=2 URL — not a terminal "unavailable". Without the fix the
      // stale 403 would surface unavailable and never retry (calls would be 1).
      expect(loader.calls, 2);
      expect(loader.urls, [
        'https://broker/x?sig=1',
        'https://broker/x?sig=2',
      ]);
    });

    testWidgets('an oversized diff is fetched on expansion and rendered', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      final loader = _FakeDiffBodyLoader(
        body: '@@ -1,1 +1,2 @@\n context\n+fetched addition',
      );
      await tester.pumpWidget(
        _rawResultPage(
          {
            'title': 'Edited big.dart',
            'additions': 400,
            'diffRef': {
              'fetchUrl': 'https://broker/api/sessions/codex/s/diff/abc',
              'contentHash': 'a' * 64,
              'byteSize': 40000,
              'lineCount': 800,
            },
          },
          loader: loader,
        ),
      );
      await tester.pumpAndSettle();
      await _expand(tester);

      // Fetched on expansion, then the body renders (nothing shipped inline).
      expect(loader.attempts, 1);
      expect(find.byKey(const Key('tool-diff-ref-body')), findsOneWidget);
      expect(find.text('fetched addition'), findsOneWidget);
    });

    testWidgets('an evicted oversized diff shows an unavailable state', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      final loader = _FakeDiffBodyLoader(
        error: const DiffBodyUnavailableException(),
      );
      await tester.pumpWidget(
        _rawResultPage(
          {
            'diffRef': {
              'fetchUrl': 'https://broker/x',
              'contentHash': 'b' * 64,
              'byteSize': 40000,
            },
          },
          loader: loader,
        ),
      );
      await tester.pumpAndSettle();
      await _expand(tester);

      expect(
        find.byKey(const Key('tool-diff-ref-unavailable')),
        findsOneWidget,
      );
      expect(find.byKey(const Key('tool-diff-ref-retry')), findsNothing);
    });

    testWidgets('a transient fetch failure offers retry, then succeeds', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      final loader = _FakeDiffBodyLoader(
        body: '@@ -1,1 +1,1 @@\n-x\n+y',
        error: Exception('network'),
        failFirst: true,
      );
      await tester.pumpWidget(
        _rawResultPage(
          {
            'diffRef': {
              'fetchUrl': 'https://broker/x',
              'contentHash': 'c' * 64,
              'byteSize': 40000,
            },
          },
          loader: loader,
        ),
      );
      await tester.pumpAndSettle();
      await _expand(tester);

      expect(find.byKey(const Key('tool-diff-ref-error')), findsOneWidget);
      await tester.tap(find.byKey(const Key('tool-diff-ref-retry')));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('tool-diff-ref-body')), findsOneWidget);
      expect(loader.attempts, 2);
    });

    testWidgets('a vertical drag over the diff scrolls the transcript', (
      tester,
    ) async {
      useRoomyTestViewport(tester);
      // A wide, tall diff whose horizontal scroll must not eat vertical drags.
      final wide = StringBuffer('@@ -1,0 +1,40 @@\n')
        ..writeAll(
          List.generate(40, (i) => '+row $i ${'wide ' * 20}'),
          '\n',
        );
      await tester.pumpWidget(_editResultPage(wide.toString()));
      await tester.pumpAndSettle();
      await _expand(tester);

      // The vertical transcript scrollable (not the diff's horizontal one).
      final vertical = find
          .byWidgetPredicate(
            (w) =>
                w is Scrollable &&
                (w.axisDirection == AxisDirection.down ||
                    w.axisDirection == AxisDirection.up),
          )
          .first;
      final position = tester.state<ScrollableState>(vertical).position;
      final before = position.pixels;
      // U5b: expanding the diff grew the last row, and a following transcript
      // stays settled on the actual tail through that growth — so the drag that
      // proves the vertical gesture reaches the transcript has to go the other
      // way (finger down = scroll back up into history).
      expect(before, closeTo(position.maxScrollExtent, 32));
      await tester.drag(
        find.byKey(const Key('tool-diff-view')),
        const Offset(0, 200),
      );
      await tester.pumpAndSettle();
      final after = tester.state<ScrollableState>(vertical).position.pixels;
      expect(
        after,
        lessThan(before),
        reason: "the diff's horizontal scroll must not consume a vertical drag",
      );
    });
  });

  group('BrokerDiffBodyLoader is bounded and de-duplicated', () {
    BrokerDiffBodyLoader loaderFrom(_CountingBrokerClient client) {
      final container = ProviderContainer(
        overrides: [brokerClientProvider.overrideWith((ref) async => client)],
      );
      addTearDown(container.dispose);
      return container.read(diffBodyLoaderProvider) as BrokerDiffBodyLoader;
    }

    // The loader verifies bytes against the advertised hash before caching, so
    // tests pass the body's real content hash.
    Future<String> hashOf(String body) async =>
        (await sha256Digest(utf8.encode(body))).substring('sha256:'.length);

    test(
      'coalesces concurrent loads of the same body into one fetch',
      () async {
        final client = _CountingBrokerClient({'u': 'body-a'});
        final loader = loaderFrom(client);
        final hash = await hashOf('body-a');
        final results = await Future.wait([
          loader.load(url: 'u', contentHash: hash),
          loader.load(url: 'u', contentHash: hash),
        ]);
        expect(client.calls, 1); // one download, shared
        expect(results, ['body-a', 'body-a']);
      },
    );

    test('a cache hit avoids a refetch; a cache miss refetches', () async {
      final client = _CountingBrokerClient({'u1': 'body-b', 'u2': 'body-c'});
      final loader = loaderFrom(client);
      final h1 = await hashOf('body-b');
      final h2 = await hashOf('body-c');
      await loader.load(url: 'u1', contentHash: h1);
      await loader.load(url: 'u1', contentHash: h1); // cached
      expect(client.calls, 1);
      await loader.load(url: 'u2', contentHash: h2); // different body
      expect(client.calls, 2);
    });

    test(
      'a body past the per-entry byte ceiling is served but not cached',
      () async {
        // >128 KiB: never cached (it would evict everything smaller), so a 2nd
        // load refetches instead of hiding an unbounded body in the cache.
        final big = 'x' * (200 * 1024);
        final client = _CountingBrokerClient({'u': big});
        final loader = loaderFrom(client);
        final hash = await hashOf(big);
        final first = await loader.load(url: 'u', contentHash: hash);
        expect(first.length, 200 * 1024);
        await loader.load(url: 'u', contentHash: hash);
        expect(client.calls, 2);
      },
    );

    test('rejects a body that fails the content-hash check', () async {
      final client = _CountingBrokerClient({'u': 'real body'});
      final loader = loaderFrom(client);
      await expectLater(
        loader.load(url: 'u', contentHash: 'a' * 64),
        throwsA(isA<DiffBodyIntegrityException>()),
      );
    });

    test('rejects an advertised over-ceiling body without fetching', () async {
      final client = _CountingBrokerClient({'u': 'body'});
      final loader = loaderFrom(client);
      await expectLater(
        loader.load(
          url: 'u',
          contentHash: 'a' * 64,
          expectedBytes: 5 * 1024 * 1024, // > the 4 MiB client ceiling
        ),
        throwsA(isA<DiffBodyTooLargeException>()),
      );
      expect(client.calls, 0); // rejected before any network call
    });

    test('cache budget counts UTF-8 bytes, not string length', () async {
      // 50k '€' chars: 50k UTF-16 code units (< the 128 KiB ceiling) but 150k
      // UTF-8 bytes (> it). Counting bytes → not cached → a 2nd load refetches;
      // counting string length would wrongly cache it.
      final multibyte = '€' * (50 * 1024);
      final client = _CountingBrokerClient({'u': multibyte});
      final loader = loaderFrom(client);
      final hash = await hashOf(multibyte);
      await loader.load(url: 'u', contentHash: hash);
      await loader.load(url: 'u', contentHash: hash);
      expect(client.calls, 2);
    });
  });
}

/// A broker client whose `fetchArtifactUrlBounded` returns a per-URL body and
/// counts calls, for asserting the loader's cache/dedup/integrity behaviour.
/// A loader that holds its FIRST load pending (via a completer) so a test can
/// inject a fresher URL mid-request, then resolve the first load — exercising
/// the pending-request race. Records every URL it was asked to load.
class _RaceLoader implements DiffBodyLoader {
  final Completer<String> _first = Completer<String>();
  final List<String> urls = <String>[];
  int calls = 0;

  @override
  Future<String> load({
    required String url,
    required String contentHash,
    int? expectedBytes,
  }) {
    calls++;
    urls.add(url);
    if (calls == 1) return _first.future; // held until failFirstUnavailable()
    return Future<String>.value('@@ -1,1 +1,1 @@\n-x\n+fresh body');
  }

  void failFirstUnavailable() =>
      _first.completeError(const DiffBodyUnavailableException());
}

class _CountingBrokerClient extends BrokerClient {
  _CountingBrokerClient(this._bodies) : super(baseUrl: 'http://127.0.0.1:7734');

  final Map<String, String> _bodies;
  int calls = 0;

  @override
  Future<ArtifactDownload> fetchArtifactUrlBounded(
    String url, {
    required int maxBytes,
  }) async {
    calls++;
    return ArtifactDownload(bytes: utf8.encode(_bodies[url] ?? ''));
  }
}
