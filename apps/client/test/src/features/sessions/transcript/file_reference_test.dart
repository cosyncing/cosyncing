// Fixture payloads read best inline and unwrapped, and the canonical package
// import paths exceed the style width.
// ignore_for_file: lines_longer_than_80_chars

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/file_reference.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/tool_presentation.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('SessionFileReference.parse', () {
    test('a bare path carries no anchor', () {
      final reference = SessionFileReference.parse('lib/foo.ts');
      expect(reference?.rawPath, 'lib/foo.ts');
      expect(reference?.line, isNull);
      expect(reference?.column, isNull);
      expect(reference?.displayPath, 'lib/foo.ts');
    });

    test('a trailing :line splits into path and line', () {
      final reference = SessionFileReference.parse('lib/foo.ts:42');
      expect(reference?.rawPath, 'lib/foo.ts');
      expect(reference?.line, 42);
      expect(reference?.column, isNull);
      expect(reference?.displayPath, 'lib/foo.ts:42');
    });

    test('a trailing :line:column splits into all three', () {
      final reference = SessionFileReference.parse('lib/foo.ts:42:7');
      expect(reference?.rawPath, 'lib/foo.ts');
      expect(reference?.line, 42);
      expect(reference?.column, 7);
      expect(reference?.displayPath, 'lib/foo.ts:42:7');
    });

    test('a Windows drive letter is not a line anchor', () {
      final reference = SessionFileReference.parse(r'C:\a\b.ts');
      expect(reference?.rawPath, r'C:\a\b.ts');
      expect(reference?.line, isNull);
    });

    test('a Windows path still splits a real trailing line anchor', () {
      final reference = SessionFileReference.parse(r'C:\a\b.ts:42');
      expect(reference?.rawPath, r'C:\a\b.ts');
      expect(reference?.line, 42);
    });

    test('a colon that is not a line anchor is left in the path', () {
      final reference = SessionFileReference.parse('a:b/c.ts');
      expect(reference?.rawPath, 'a:b/c.ts');
      expect(reference?.line, isNull);
    });

    test('a ~ prefix is passed through, never expanded client-side', () {
      // The broker host owns `homedir()`; a client-side expansion would be a
      // second resolver that drifts from the one doing containment.
      final reference = SessionFileReference.parse('~/x/notes.md');
      expect(reference?.rawPath, '~/x/notes.md');
    });

    test('an absolute path is passed through untouched', () {
      final reference = SessionFileReference.parse('/srv/x/proj/lib/a.dart');
      expect(reference?.rawPath, '/srv/x/proj/lib/a.dart');
    });

    test(
      'empty, whitespace, null, and control-bearing paths resolve to null',
      () {
        expect(SessionFileReference.parse(''), isNull);
        expect(SessionFileReference.parse('   '), isNull);
        expect(SessionFileReference.parse(null), isNull);
        expect(SessionFileReference.parse('lib/a\nb.dart'), isNull);
        expect(SessionFileReference.parse('lib/a\u0000b.dart'), isNull);
      },
    );

    test('a structured line wins over a suffix line', () {
      final reference = SessionFileReference.parse('lib/a.dart:42', line: 10);
      expect(reference?.rawPath, 'lib/a.dart');
      expect(reference?.line, 10);
    });

    test(
      'a non-positive line is dropped rather than rendered as an anchor',
      () {
        expect(SessionFileReference.parse('a.dart', line: 0)?.line, isNull);
        expect(SessionFileReference.parse('a.dart', line: -3)?.line, isNull);
      },
    );

    test('a column without a line is dropped', () {
      final reference = SessionFileReference.parse('a.dart', column: 7);
      expect(reference?.line, isNull);
      expect(reference?.column, isNull);
    });
  });

  group('SessionFileReference.parent', () {
    test('a nested path yields its directory', () {
      expect(
        SessionFileReference.parse('lib/src/a.dart')?.parent.rawPath,
        'lib/src',
      );
      expect(
        SessionFileReference.parse('lib/src/a.dart')?.parent.kind,
        SessionFileReferenceKind.directory,
      );
    });

    test('a top-level name yields the workspace root', () {
      expect(SessionFileReference.parse('a.dart')?.parent.rawPath, '');
      expect(
        SessionFileReference.parse('a.dart')?.parent.isWorkspaceRoot,
        isTrue,
      );
    });

    test('an absolute path yields its absolute directory', () {
      expect(
        SessionFileReference.parse('/srv/x/proj/a.dart')?.parent.rawPath,
        '/srv/x/proj',
      );
    });

    test('a trailing slash does not produce an empty segment', () {
      expect(
        SessionFileReference.parse('lib/src/')?.parent.rawPath,
        'lib',
      );
    });
  });

  group('fileReferencesForToolRow', () {
    test('a file-read semantic carries its path and start line', () {
      final references = fileReferencesForToolRow(
        result: _result({
          'callId': 'r1',
          'semantic': {
            'kind': 'file-read',
            'path': '/repo/lib/a.dart',
            'startLine': 120,
            'preview': 'x',
          },
        }),
      );
      expect(references, hasLength(1));
      expect(references.single.rawPath, '/repo/lib/a.dart');
      expect(references.single.line, 120);
      expect(references.single.kind, SessionFileReferenceKind.file);
    });

    test('search groups become references; the SCOPE never does', () {
      // A Grep/Glob `path` argument is a search scope DIRECTORY, not a file it
      // found. Turning it into a file reference would give every grep a bogus
      // link, which is exactly the key-name heuristic this model refuses.
      final references = fileReferencesForToolRow(
        result: _result({
          'callId': 's1',
          'semantic': {
            'kind': 'search',
            'query': 'TODO',
            'scope': 'lib/',
            'groups': [
              {
                'path': 'lib/a.dart',
                'matches': [
                  {'line': 10, 'text': '// TODO a'},
                  {'line': 22, 'text': '// TODO b'},
                ],
              },
              {
                'path': 'lib/b.dart',
                'matches': [
                  {'line': 5, 'text': '// TODO c'},
                ],
              },
            ],
          },
        }),
      );
      expect(references.map((it) => it.rawPath), ['lib/a.dart', 'lib/b.dart']);
      // The first published match, so a tap lands on evidence, not on line 1.
      expect(references.first.line, 10);
      expect(references.last.line, 5);
      expect(references.map((it) => it.rawPath), isNot(contains('lib/')));
    });

    test('a match group with no line numbers still resolves the file', () {
      final references = fileReferencesForToolRow(
        result: _result({
          'callId': 's2',
          'semantic': {
            'kind': 'search',
            'groups': [
              {
                'path': 'lib/a.dart',
                'matches': [
                  {'text': 'no line published'},
                ],
              },
            ],
          },
        }),
      );
      expect(references.single.rawPath, 'lib/a.dart');
      expect(references.single.line, isNull);
    });

    test('tool-result.path and fileChanges both contribute', () {
      final references = fileReferencesForToolRow(
        result: _result({
          'callId': 'e1',
          'path': 'lib/edited.dart',
          'fileChanges': [
            {'path': 'lib/renamed.dart', 'previousPath': 'lib/old.dart'},
            {'path': 'lib/edited.dart'},
          ],
        }),
      );
      expect(references.map((it) => it.rawPath), [
        'lib/edited.dart',
        'lib/renamed.dart',
        'lib/old.dart',
      ]);
    });

    test("a command's cwd is a directory reference", () {
      final references = fileReferencesForToolRow(
        result: _result({
          'callId': 'c1',
          'semantic': {
            'kind': 'command',
            'command': 'make test',
            'cwd': '/repo/app',
            'state': 'completed',
          },
        }),
      );
      expect(references.single.rawPath, '/repo/app');
      expect(references.single.kind, SessionFileReferenceKind.directory);
    });

    test('a row with no structured path contributes nothing', () {
      // Every Kimi tool row looked like this before its adapter stamped paths:
      // a generic payload with a path-ish string in it. Prose is never scanned,
      // so nothing here becomes a link.
      final references = fileReferencesForToolRow(
        result: _result({
          'callId': 'g1',
          'result': 'I updated src/main.rs and lib/other.dart for you.',
        }),
      );
      expect(references, isEmpty);
    });

    test('references are de-duplicated and bounded', () {
      final references = fileReferencesForToolRow(
        result: _result({
          'callId': 'b1',
          'path': 'lib/a.dart',
          'fileChanges': [
            for (var index = 0; index < 200; index++) {'path': 'lib/a.dart'},
          ],
        }),
      );
      expect(references, hasLength(1));
    });
  });

  group('presentation round-trip', () {
    test('the carried reference is the unclipped path the summary clipped', () {
      final path = '/repo/${'deeply-nested/' * 20}leaf.dart';
      final result = _result({
        'callId': 'r2',
        'semantic': {'kind': 'file-read', 'path': path, 'preview': 'x'},
      });

      final summary = resolveToolSummary(result: result);
      final presentation = buildToolFileReadPresentation(result: result);

      expect(
        path.length,
        greaterThan(ToolPresentationBounds.collapsedTitleChars),
      );
      expect(summary!.primary, isNot(path));
      expect(summary.primary, endsWith('…'));
      expect(presentation!.reference!.rawPath, path);
    });

    test('a search group presentation carries the group reference', () {
      final presentation = buildToolSearchPresentation(
        result: _result({
          'callId': 's3',
          'semantic': {
            'kind': 'search',
            'groups': [
              {
                'path': 'lib/a.dart',
                'matches': [
                  {'line': 31, 'text': 'hit'},
                ],
              },
            ],
          },
        }),
      );
      expect(presentation!.groups.single.reference!.rawPath, 'lib/a.dart');
      expect(presentation.groups.single.reference!.line, 31);
    });
  });
}

AgentMessage _result(Map<String, dynamic> raw) => AgentMessage(
  type: AgentMessageType.toolResult,
  id: raw['callId'] as String?,
  raw: {'type': 'tool-result', ...raw},
);
