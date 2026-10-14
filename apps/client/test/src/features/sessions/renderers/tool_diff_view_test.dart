import 'dart:convert';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:broker_crypto/broker_crypto.dart';
import 'package:cosyncing_client/src/design/themes/theme_registry.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/renderers/message_renderer_registry.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_diff_body_loader.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

/// A fake diff-body loader: returns [body], or throws to simulate an
/// unavailable/transient failure. Records the number of load attempts.
class _FakeDiffBodyLoader implements DiffBodyLoader {
  _FakeDiffBodyLoader({this.body});

  final String? body;
  int attempts = 0;

  @override
  Future<String> load({
    required String url,
    required String contentHash,
    int? expectedBytes,
  }) async {
    attempts++;
    return body ?? '@@ -1,1 +1,1 @@\n-fetched old\n+fetched new';
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

  group('renders across density, brightness, and text scale', () {
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

class _CountingBrokerClient extends BrokerClient {
  _CountingBrokerClient(this._bodies) : super(baseUrl: 'http://127.0.0.1:7734');

  final Map<String, String> _bodies;
  int calls = 0;

  @override
  Future<ArtifactDownload> fetchArtifactUrlBounded(
    String url, {
    required int maxBytes,
    int? rangeStart,
    int? rangeEnd,
    String? ifRange,
  }) async {
    calls++;
    return ArtifactDownload(bytes: utf8.encode(_bodies[url] ?? ''));
  }
}
