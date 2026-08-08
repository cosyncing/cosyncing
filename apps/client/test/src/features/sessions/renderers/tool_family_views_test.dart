// Fixture payloads and expected copy read best inline and unwrapped, and the
// canonical package import paths exceed the style width.
// ignore_for_file: lines_longer_than_80_chars

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/soft_minimalist_theme.dart';
// The canonical renderer imports keep their stable package paths for
// boundary-safe package import resolution.
import 'package:cosyncing_client/src/features/sessions/model/session_transcript_display.dart';
import 'package:cosyncing_client/src/features/sessions/model/tool_presentation.dart';
import 'package:cosyncing_client/src/features/sessions/renderers/message_renderer_registry.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('command family', () {
    testWidgets('shows command, cwd, separated streams, and exit code', (
      tester,
    ) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 'c1',
          'toolName': 'exec_command',
          'toolClass': 'execute',
          'title': 'make test',
          'exitCode': 2,
          'durationMs': 1500,
          'semantic': {
            'kind': 'command',
            'command': 'make test',
            'cwd': '/repo/app',
            'state': 'failed',
            'stdout': {'text': 'compiled 3 files'},
            'stderr': {'text': 'FAILED tests/test_x.py'},
          },
        }),
        expanded: true,
      );

      expect(find.byKey(const Key('tool-command-line')), findsOneWidget);
      expect(find.text('make test'), findsAtLeastNWidgets(1));
      expect(find.byKey(const Key('tool-command-cwd')), findsOneWidget);
      // The COLLAPSED summary now carries command + cwd as well, so the cwd
      // appears twice on an expanded row. Match the expanded one by key.
      expect(
        find.descendant(
          of: find.byKey(const Key('tool-command-cwd')),
          matching: find.textContaining('/repo/app'),
          matchRoot: true,
        ),
        findsOneWidget,
      );
      expect(find.text('make test · in /repo/app'), findsOneWidget);
      expect(find.byKey(const Key('tool-command-stdout')), findsOneWidget);
      expect(find.byKey(const Key('tool-command-stderr')), findsOneWidget);
      expect(find.text('compiled 3 files'), findsOneWidget);
      expect(find.text('FAILED tests/test_x.py'), findsOneWidget);
      expect(find.textContaining('exit 2'), findsOneWidget);
      expect(find.textContaining('1.5s'), findsOneWidget);
      expect(find.byKey(const Key('tool-command-state-chip')), findsOneWidget);
      expect(find.text('failed'), findsOneWidget);
    });

    testWidgets('a live call with no result reads as running', (tester) async {
      await _pumpTool(
        tester,
        call: _call({
          'callId': 'c1',
          'toolName': 'bash',
          'toolClass': 'execute',
          'semantic': {
            'kind': 'command',
            'command': 'sleep 60',
            'state': 'running',
          },
        }),
        expanded: true,
      );

      expect(find.text('running'), findsOneWidget);
      expect(find.byKey(const Key('tool-command-empty')), findsOneWidget);
      expect(find.text('No output yet.'), findsOneWidget);
    });

    testWidgets('an interrupted command says so without an exit code', (
      tester,
    ) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 'c1',
          'toolName': 'bash',
          'toolClass': 'execute',
          'semantic': {
            'kind': 'command',
            'command': 'npm run watch',
            'state': 'interrupted',
          },
        }),
        expanded: true,
      );

      expect(find.text('interrupted'), findsOneWidget);
      expect(find.textContaining('exit '), findsNothing);
    });

    testWidgets('missing metadata reads as unknown, never as success', (
      tester,
    ) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 'c1',
          'toolName': 'bash',
          'toolClass': 'execute',
          'semantic': {
            'kind': 'command',
            'command': 'mystery',
            'state': 'unknown',
          },
        }),
        expanded: true,
      );

      expect(find.text('state unknown'), findsOneWidget);
      expect(find.text('completed'), findsNothing);
      expect(find.text('The command produced no output.'), findsOneWidget);
    });

    testWidgets('merged output is labeled combined, never stdout', (
      tester,
    ) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 'c1',
          'toolName': 'bash',
          'toolClass': 'execute',
          'result': 'one blob of output',
          'semantic': {
            'kind': 'command',
            'command': 'ls',
            'state': 'completed',
          },
        }),
        expanded: true,
      );

      expect(find.byKey(const Key('tool-command-combined')), findsOneWidget);
      expect(find.text('Combined output'), findsOneWidget);
      expect(find.byKey(const Key('tool-command-stdout')), findsNothing);
    });

    testWidgets('ANSI never reaches the rendered surface', (tester) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 'c1',
          'toolName': 'bash',
          'toolClass': 'execute',
          'semantic': {
            'kind': 'command',
            'command': 'grep -r x .',
            'state': 'completed',
            'stdout': {'text': '\x1b[31mmatch\x1b[0m\x1b]0;title\x07'},
          },
        }),
        expanded: true,
      );

      expect(find.text('match'), findsOneWidget);
      expect(find.textContaining('\x1b'), findsNothing);
      expect(find.textContaining('[31m'), findsNothing);
    });

    testWidgets('truncation is stated for both client and source clipping', (
      tester,
    ) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 'c1',
          'toolName': 'bash',
          'toolClass': 'execute',
          'semantic': {
            'kind': 'command',
            'command': 'gen',
            'state': 'completed',
            'stdout': {'text': 'kept tail', 'truncated': true},
            'stderr': {
              'text': List.generate(900, (index) => 'e$index').join('\n'),
            },
          },
        }),
        expanded: true,
      );

      expect(
        find.byKey(const Key('tool-command-stdout-truncated')),
        findsOneWidget,
      );
      expect(
        find.text(
          'Output truncated by the agent before it reached this device.',
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('tool-command-stderr-truncated')),
        findsOneWidget,
      );
      expect(find.textContaining('earlier lines hidden'), findsOneWidget);
    });

    testWidgets('Copy puts the exact bounded stream on the clipboard', (
      tester,
    ) async {
      final clipboard = <String>[];
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            clipboard.add((call.arguments as Map)['text'] as String);
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          null,
        ),
      );

      await _pumpTool(
        tester,
        result: _result({
          'callId': 'c1',
          'toolName': 'bash',
          'toolClass': 'execute',
          'semantic': {
            'kind': 'command',
            'command': 'echo hi',
            'state': 'completed',
            'stdout': {'text': 'hi'},
          },
        }),
        expanded: true,
      );

      await tester.tap(find.byKey(const Key('tool-command-stdout-copy')));
      await tester.pump();
      expect(clipboard, ['hi']);
    });

    testWidgets('Copy controls meet the 48dp touch minimum', (tester) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 'c1',
          'toolName': 'bash',
          'toolClass': 'execute',
          'semantic': {
            'kind': 'command',
            'command': 'echo hi',
            'state': 'completed',
            'stdout': {'text': 'hi'},
          },
        }),
        expanded: true,
      );

      final size = tester.getSize(
        find.byKey(const Key('tool-command-stdout-copy')),
      );
      expect(size.width, greaterThanOrEqualTo(48));
      expect(size.height, greaterThanOrEqualTo(48));
    });

    testWidgets('a collapsed row builds no expanded body', (tester) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 'c1',
          'toolName': 'bash',
          'toolClass': 'execute',
          'semantic': {
            'kind': 'command',
            'command': 'echo hi',
            'state': 'completed',
            'stdout': {'text': 'secret-looking body'},
          },
        }),
      );

      expect(find.byKey(const Key('tool-command-section')), findsNothing);
      expect(find.text('secret-looking body'), findsNothing);
      // The collapsed row still carries its constant-cost summary + chips.
      expect(find.byKey(const Key('tool-command-state-chip')), findsOneWidget);
    });

    testWidgets('expand and collapse toggles the body in place', (
      tester,
    ) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 'c1',
          'toolName': 'bash',
          'toolClass': 'execute',
          'semantic': {
            'kind': 'command',
            'command': 'echo hi',
            'state': 'completed',
            'stdout': {'text': 'hello'},
          },
        }),
      );

      expect(find.text('hello'), findsNothing);
      await tester.tap(find.byKey(const ValueKey('tool-c1-details')));
      await tester.pumpAndSettle();
      expect(find.text('hello'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('tool-c1-details')));
      await tester.pumpAndSettle();
      expect(find.text('hello'), findsNothing);
    });

    testWidgets('renders in both brightnesses and both locales', (
      tester,
    ) async {
      for (final brightness in Brightness.values) {
        await _pumpTool(
          tester,
          result: _result({
            'callId': 'c1',
            'toolName': 'bash',
            'toolClass': 'execute',
            'semantic': {
              'kind': 'command',
              'command': 'ls',
              'state': 'completed',
              'stdout': {'text': 'ok'},
            },
          }),
          expanded: true,
          brightness: brightness,
        );
        expect(find.text('completed'), findsOneWidget);
        expect(find.text('stdout'), findsOneWidget);
      }

      await _pumpTool(
        tester,
        result: _result({
          'callId': 'c1',
          'toolName': 'bash',
          'toolClass': 'execute',
          'semantic': {
            'kind': 'command',
            'command': 'ls',
            'state': 'failed',
            'stdout': {'text': 'ok'},
          },
        }),
        expanded: true,
        locale: const Locale('zh'),
      );
      expect(find.text('已失败'), findsOneWidget);
      expect(find.text('标准输出'), findsOneWidget);
    });
  });

  group('file-read family', () {
    testWidgets('renders a line-numbered preview from the start line', (
      tester,
    ) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 'r1',
          'toolName': 'Read',
          'toolClass': 'lookup',
          'semantic': {
            'kind': 'file-read',
            'path': 'lib/main.dart',
            'startLine': 40,
            'preview': 'void main() {\n  runApp();\n}',
            'totalLines': 120,
          },
        }),
        expanded: true,
      );

      expect(find.byKey(const Key('tool-read-section')), findsOneWidget);
      expect(find.text('lib/main.dart'), findsAtLeastNWidgets(1));
      expect(find.text('40'), findsOneWidget);
      expect(find.text('42'), findsOneWidget);
      expect(find.text('void main() {'), findsOneWidget);
    });

    testWidgets('a read with no start line shows no fabricated numbers', (
      tester,
    ) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 'r1',
          'toolName': 'Read',
          'toolClass': 'lookup',
          'semantic': {
            'kind': 'file-read',
            'path': 'notes.txt',
            'preview': 'alpha\nbeta',
          },
        }),
        expanded: true,
      );

      expect(find.text('alpha'), findsOneWidget);
      expect(find.text('1'), findsNothing);
      expect(find.text('2'), findsNothing);
    });

    testWidgets('a very large line number still aligns and renders', (
      tester,
    ) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 'r1',
          'toolName': 'Read',
          'toolClass': 'lookup',
          'semantic': {
            'kind': 'file-read',
            'path': 'huge.log',
            'startLine': 1999998,
            'preview': 'a\nb',
          },
        }),
        expanded: true,
      );

      expect(find.text('1999998'), findsOneWidget);
      expect(find.text('1999999'), findsOneWidget);
      expect(tester.takeException(), isNull);
    });

    testWidgets('an unreadable file states why instead of showing nothing', (
      tester,
    ) async {
      for (final pair in const [
        ('missing', 'The file could not be found.'),
        ('unreadable', 'The file could not be read.'),
        ('binary', 'No text preview: the file is binary.'),
        ('empty', 'The file is empty.'),
      ]) {
        await _pumpTool(
          tester,
          result: _result({
            'callId': 'r1',
            'toolName': 'Read',
            'toolClass': 'lookup',
            'semantic': {
              'kind': 'file-read',
              'path': 'x',
              'unavailable': pair.$1,
            },
          }),
          expanded: true,
        );
        expect(find.text(pair.$2), findsOneWidget, reason: pair.$1);
      }
    });

    testWidgets('a truncated preview says how much it shows', (tester) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 'r1',
          'toolName': 'Read',
          'toolClass': 'lookup',
          'semantic': {
            'kind': 'file-read',
            'path': 'big.txt',
            'startLine': 1,
            'preview': List.generate(400, (index) => 'l$index').join('\n'),
            'totalLines': 5000,
          },
        }),
        expanded: true,
      );

      expect(find.byKey(const Key('tool-read-truncated')), findsOneWidget);
      expect(find.textContaining('200'), findsAtLeastNWidgets(1));
      expect(find.textContaining('5000'), findsOneWidget);
    });
  });

  group('search family', () {
    testWidgets('groups matches under each file', (tester) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 's1',
          'toolName': 'Grep',
          'toolClass': 'lookup',
          'semantic': {
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
        }),
        expanded: true,
      );

      expect(find.byKey(const Key('tool-search-section')), findsOneWidget);
      expect(find.textContaining('lib/a.dart'), findsOneWidget);
      expect(find.textContaining('lib/b.dart'), findsOneWidget);
      expect(find.text('// TODO a'), findsOneWidget);
      expect(find.text('// TODO c'), findsOneWidget);
      expect(find.byKey(const Key('tool-search-scope')), findsOneWidget);
    });

    testWidgets('an empty search states no matches for the query', (
      tester,
    ) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 's1',
          'toolName': 'Grep',
          'toolClass': 'lookup',
          'semantic': {'kind': 'search', 'query': 'zzz', 'matchCount': 0},
        }),
        expanded: true,
      );

      expect(find.byKey(const Key('tool-search-empty')), findsOneWidget);
      expect(find.text('No matches for "zzz".'), findsOneWidget);
    });

    testWidgets('dropped groups and matches are both disclosed', (
      tester,
    ) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 's1',
          'toolName': 'Grep',
          'toolClass': 'lookup',
          'semantic': {
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
        }),
        expanded: true,
      );

      expect(find.byKey(const Key('tool-search-truncated')), findsOneWidget);
      expect(
        find.byKey(const Key('tool-search-group-truncated')),
        findsOneWidget,
      );
    });

    testWidgets('a snippet the sender clipped is never shown as whole', (
      tester,
    ) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 's2',
          'toolName': 'Grep',
          'toolClass': 'lookup',
          'semantic': {
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
        }),
        expanded: true,
      );

      expect(find.byKey(const Key('tool-line-truncated')), findsOneWidget);
      expect(
        find.byKey(const Key('tool-search-match-truncated')),
        findsOneWidget,
      );
      // The group itself lost nothing, so it must NOT claim it did.
      expect(
        find.byKey(const Key('tool-search-group-truncated')),
        findsNothing,
      );
    });

    testWidgets('a snippet this device clips is disclosed too', (tester) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 's3',
          'toolName': 'Grep',
          'toolClass': 'lookup',
          'semantic': {
            'kind': 'search',
            'query': 'needle',
            'groups': [
              {
                'path': 'a.dart',
                'matches': [
                  {
                    'line': 4,
                    // Inside the wire bound, past the render bound.
                    'text':
                        'z' * (ToolPresentationBounds.searchSnippetChars + 40),
                  },
                ],
              },
            ],
          },
        }),
        expanded: true,
      );

      expect(find.byKey(const Key('tool-line-truncated')), findsOneWidget);
      expect(
        find.byKey(const Key('tool-search-match-truncated')),
        findsOneWidget,
      );
    });

    testWidgets('the collapsed row carries query, scope, and counts', (
      tester,
    ) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 's4',
          'toolName': 'Grep',
          'toolClass': 'lookup',
          'title': 'Grep',
          'semantic': {
            'kind': 'search',
            'query': 'TODO',
            'scope': 'lib/',
            'matchCount': 12,
            'fileCount': 3,
          },
        }),
      );

      expect(
        find.text('TODO · in lib/ · 12 matches in 3 files'),
        findsOneWidget,
      );
    });
  });

  group('web family', () {
    testWidgets('shows titles and domains, and keeps URLs as plain text', (
      tester,
    ) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 'w1',
          'toolName': 'WebSearch',
          'toolClass': 'lookup',
          'semantic': {
            'kind': 'web',
            'query': 'dart isolates',
            'results': [
              {
                'url': 'https://www.example.com/isolates',
                'title': 'Understanding isolates',
                'snippet': 'A short summary.',
              },
            ],
          },
        }),
        expanded: true,
      );

      expect(find.byKey(const Key('tool-web-section')), findsOneWidget);
      expect(find.text('Understanding isolates'), findsOneWidget);
      expect(find.text('example.com'), findsOneWidget);
      expect(find.text('A short summary.'), findsOneWidget);
      // Selectable text only — no tappable link affordance is introduced here.
      expect(find.byType(InkWell), findsOneWidget);
      // Nothing was clipped, so nothing claims it was.
      expect(find.byKey(const Key('tool-web-result-truncated')), findsNothing);
      // The collapsed row already identifies the lookup.
      expect(
        find.text('dart isolates · example.com · 1 result'),
        findsOneWidget,
      );
    });

    testWidgets('a clipped result snippet is disclosed on the result', (
      tester,
    ) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 'w3',
          'toolName': 'WebSearch',
          'toolClass': 'lookup',
          'semantic': {
            'kind': 'web',
            'query': 'dart isolates',
            'results': [
              {
                'url': 'https://www.example.com/isolates',
                'title': 'Understanding isolates',
                'snippet': 'Only the first bytes survived',
                'truncated': true,
              },
            ],
          },
        }),
        expanded: true,
      );

      expect(
        find.byKey(const Key('tool-web-result-truncated')),
        findsOneWidget,
      );
    });

    testWidgets('a fetch shows its URL and an empty search says so', (
      tester,
    ) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 'w1',
          'toolName': 'WebFetch',
          'toolClass': 'lookup',
          'semantic': {'kind': 'web', 'url': 'https://example.com/page'},
        }),
        expanded: true,
      );
      expect(find.byKey(const Key('tool-web-url')), findsOneWidget);

      await _pumpTool(
        tester,
        result: _result({
          'callId': 'w2',
          'toolName': 'WebSearch',
          'toolClass': 'lookup',
          'semantic': {'kind': 'web', 'query': 'nothing'},
        }),
        expanded: true,
      );
      expect(find.byKey(const Key('tool-web-empty')), findsOneWidget);
    });
  });

  group('generic and MCP fallback', () {
    testWidgets('renders an unknown tool without pretending to know it', (
      tester,
    ) async {
      await _pumpTool(
        tester,
        call: _call({
          'callId': 'm1',
          'toolName': 'mcp__vendor__do_thing',
          'toolClass': 'other',
          'args': {'zeta': 1, 'alpha': 'two'},
        }),
        result: _result({
          'callId': 'm1',
          'toolName': 'mcp__vendor__do_thing',
          'toolClass': 'other',
          'result': {'status': 'ok', 'count': 3},
        }),
        expanded: true,
      );

      expect(find.byKey(const Key('tool-fallback-section')), findsOneWidget);
      expect(find.byKey(const Key('tool-fallback-input')), findsOneWidget);
      expect(find.byKey(const Key('tool-fallback-output')), findsOneWidget);
      expect(find.textContaining('alpha'), findsOneWidget);
      expect(find.textContaining('status'), findsOneWidget);
      // No provider payload dump: the native tool name is not the body.
      expect(find.text('mcp__vendor__do_thing'), findsNothing);
    });

    testWidgets('credential-like values never reach the surface', (
      tester,
    ) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 'm1',
          'toolName': 'mcp__vendor__auth',
          'toolClass': 'other',
          'result': {
            'api_key': 'sk-live-SUPERSECRET',
            'authorization': 'Bearer SUPERSECRET',
            'endpoint': 'https://api.example.com',
          },
        }),
        expanded: true,
      );

      expect(find.textContaining('SUPERSECRET'), findsNothing);
      expect(find.textContaining('hidden'), findsAtLeastNWidgets(1));
      expect(find.textContaining('https://api.example.com'), findsOneWidget);
    });

    testWidgets('a redacted field carries screen-reader semantics', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      await _pumpTool(
        tester,
        result: _result({
          'callId': 'm1',
          'toolName': 'x',
          'toolClass': 'other',
          'result': {'password': 'hunter2'},
        }),
        expanded: true,
      );

      expect(
        find.bySemanticsLabel(
          'password: value hidden because it may contain a secret',
        ),
        findsOneWidget,
      );
      handle.dispose();
    });

    testWidgets('an oversized malformed payload stays bounded', (tester) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 'm1',
          'toolName': 'x',
          'toolClass': 'other',
          'result': {
            for (var index = 0; index < 400; index++) 'field$index': 'v' * 4000,
          },
        }),
        expanded: true,
      );

      expect(
        find.byKey(const Key('tool-fallback-output-truncated')),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('deeply nested data terminates without overflow', (
      tester,
    ) async {
      Object? nested = 'leaf';
      for (var index = 0; index < 60; index++) {
        nested = {'l$index': nested};
      }
      await _pumpTool(
        tester,
        result: _result({
          'callId': 'm1',
          'toolName': 'x',
          'toolClass': 'other',
          'result': nested,
        }),
        expanded: true,
      );
      expect(tester.takeException(), isNull);
      expect(
        find.byKey(const Key('tool-fallback-output-truncated')),
        findsOneWidget,
      );
    });
  });

  group('T1 diff ownership', () {
    testWidgets('an edit result still renders through the diff view', (
      tester,
    ) async {
      await _pumpTool(
        tester,
        result: _result({
          'callId': 'e1',
          'toolName': 'Edit',
          'toolClass': 'edit',
          'path': 'lib/a.dart',
          'diff': '--- a/lib/a.dart\n+++ b/lib/a.dart\n@@ -1 +1 @@\n-old\n+new',
        }),
        expanded: true,
      );

      expect(find.byKey(const Key('tool-diff-view')), findsOneWidget);
      expect(find.byKey(const Key('tool-command-section')), findsNothing);
      expect(find.byKey(const Key('tool-fallback-section')), findsNothing);
    });
  });
}

AgentMessage _call(Map<String, dynamic> raw) => AgentMessage(
  type: AgentMessageType.toolCall,
  id: raw['callId'] as String?,
  raw: {'type': 'tool-call', ...raw},
);

AgentMessage _result(Map<String, dynamic> raw) => AgentMessage(
  type: AgentMessageType.toolResult,
  id: raw['callId'] as String?,
  raw: {'type': 'tool-result', ...raw},
);

Future<void> _pumpTool(
  WidgetTester tester, {
  AgentMessage? call,
  AgentMessage? result,
  bool expanded = false,
  Brightness brightness = Brightness.light,
  Locale locale = const Locale('en'),
}) async {
  final tokens = brightness == Brightness.light
      ? softMinimalistTheme.light
      : softMinimalistTheme.dark;
  final entry = ToolTranscriptDisplayEntry(
    call: call,
    result: result,
    sourceIndices: const [0],
  );
  await tester.pumpWidget(
    MaterialApp(
      key: ValueKey('$brightness-$locale-$expanded'),
      locale: locale,
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      theme: buildAppTheme(tokens, brightness),
      home: Scaffold(
        body: SingleChildScrollView(
          child: Builder(
            builder: (context) => buildToolTranscriptRenderer(
              context,
              entry,
              toolsExpanded: expanded,
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}
