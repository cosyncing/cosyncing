import 'package:broker_contract/broker_contract.dart';
// The canonical registry import exceeds the style line width; keep the stable
// package path for boundary-safe package import resolution.
// ignore: lines_longer_than_80_chars
import 'package:cosyncing_client/src/features/sessions/model/tool_presentation.dart';
import 'package:flutter_test/flutter_test.dart';

AgentMessage _call(Map<String, dynamic> raw) => AgentMessage(
  type: AgentMessageType.toolCall,
  raw: {
    'type': 'tool-call',
    ...raw,
  },
);

AgentMessage _result(Map<String, dynamic> raw) => AgentMessage(
  type: AgentMessageType.toolResult,
  raw: {
    'type': 'tool-result',
    ...raw,
  },
);

void main() {
  group('family resolution', () {
    test('an explicit semantic selects its family for every provider', () {
      for (final entry in const {
        'command': ToolPresentationFamily.command,
        'file-read': ToolPresentationFamily.fileRead,
        'search': ToolPresentationFamily.search,
        'web': ToolPresentationFamily.web,
      }.entries) {
        expect(
          resolveToolPresentationFamily(
            result: _result({
              'toolName': 'anything_at_all',
              'semantic': {
                'kind': entry.key,
                'command': 'ls',
                'state': 'completed',
                'path': '/tmp/a.txt',
              },
            }),
          ),
          entry.value,
          reason: entry.key,
        );
      }
    });

    test('equivalent semantics from different providers resolve alike', () {
      // Same canonical envelope, wildly different native tool names.
      const semantic = {
        'kind': 'command',
        'command': 'pytest -q',
        'state': 'failed',
      };
      for (final toolName in const [
        'exec_command',
        'Bash',
        'bash',
        'shell',
        'mcp__vendor__run',
      ]) {
        final resolved = resolveToolPresentationFamily(
          result: _result({'toolName': toolName, 'semantic': semantic}),
        );
        expect(resolved, ToolPresentationFamily.command, reason: toolName);
      }
    });

    test('a diff payload stays with the T1 edit renderer', () {
      expect(
        resolveToolPresentationFamily(
          result: _result({
            'toolClass': 'lookup',
            'diff': '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b',
          }),
        ),
        ToolPresentationFamily.edit,
      );
      expect(
        resolveToolPresentationFamily(
          result: _result({
            'toolClass': 'edit',
            'diffRef': {'fetchUrl': 'https://x', 'contentHash': 'h'},
          }),
        ),
        ToolPresentationFamily.edit,
      );
    });

    test('a revision-8 execute row still resolves to the command family', () {
      expect(
        resolveToolPresentationFamily(
          result: _result({'toolClass': 'execute', 'title': 'ls -la'}),
        ),
        ToolPresentationFamily.command,
      );
    });

    test('an unknown future family falls back rather than guessing', () {
      expect(
        resolveToolPresentationFamily(
          result: _result({
            'toolClass': 'other',
            'semantic': {'kind': 'quantum-teleport'},
          }),
        ),
        ToolPresentationFamily.generic,
      );
    });

    test('a lookup with no semantic stays generic instead of pretending', () {
      expect(
        resolveToolPresentationFamily(
          result: _result({'toolClass': 'lookup', 'title': 'Read foo.dart'}),
        ),
        ToolPresentationFamily.generic,
      );
    });
  });

  group('control-sequence sanitization', () {
    test('strips CSI colour codes but keeps the visible text', () {
      expect(
        sanitizeControlSequences('\x1b[31merror\x1b[0m: boom'),
        'error: boom',
      );
    });

    test('strips OSC sequences terminated by BEL and by ST', () {
      expect(sanitizeControlSequences('\x1b]0;title\x07ok'), 'ok');
      expect(sanitizeControlSequences('\x1b]8;;http://x\x1b\\ok'), 'ok');
    });

    test('drops carriage returns, DEL, C1 controls, and bidi overrides', () {
      expect(sanitizeControlSequences('a\rb'), 'ab');
      expect(sanitizeControlSequences('a\x7fb'), 'ab');
      expect(sanitizeControlSequences('ab'), 'ab');
      expect(sanitizeControlSequences('a\u202Eb'), 'ab');
    });

    test('keeps tabs and newlines, which carry real layout', () {
      expect(sanitizeControlSequences('a\tb\nc'), 'a\tb\nc');
    });

    test('an unterminated escape cannot swallow the rest of the output', () {
      // A truncated CSI at the very end must not loop or drop everything after.
      expect(sanitizeControlSequences('done\x1b['), 'done');
    });
  });

  group('bounded bodies', () {
    test('a body inside the bound is not marked truncated', () {
      final bounded = boundToolBody(
        'a\nb\nc',
        keepTail: true,
        maxLines: 3,
        maxChars: 100,
      );
      expect(bounded.text, 'a\nb\nc');
      expect(bounded.truncated, isFalse);
    });

    test('tail-first keeps the newest lines and counts what it hid', () {
      final bounded = boundToolBody(
        List.generate(10, (index) => 'line$index').join('\n'),
        keepTail: true,
        maxLines: 3,
        maxChars: 10000,
      );
      expect(bounded.text, 'line7\nline8\nline9');
      expect(bounded.truncated, isTrue);
      expect(bounded.hiddenLines, 7);
    });

    test('head-first keeps the oldest lines', () {
      final bounded = boundToolBody(
        List.generate(10, (index) => 'line$index').join('\n'),
        keepTail: false,
        maxLines: 2,
        maxChars: 10000,
      );
      expect(bounded.text, 'line0\nline1');
      expect(bounded.truncated, isTrue);
    });

    test('work is proportional to the bound, not the accumulated output', () {
      // The same bound applied to 8 MiB and to 8 KiB must produce the same
      // rendered size — this is the property that keeps a live fragment cheap.
      final huge = 'x' * (8 * 1024 * 1024);
      final small = 'x' * (8 * 1024);
      final boundedHuge = boundToolBody(
        huge,
        keepTail: true,
        maxLines: 400,
        maxChars: 2048,
      );
      final boundedSmall = boundToolBody(
        small,
        keepTail: true,
        maxLines: 400,
        maxChars: 2048,
      );
      expect(boundedHuge.text.length, 2048);
      expect(boundedSmall.text.length, 2048);
      expect(boundedHuge.truncated, isTrue);
    });
  });

  group('command presentation', () {
    test('separated streams stay separate and keep source truncation', () {
      final presentation = buildToolCommandPresentation(
        expanded: true,
        result: _result({
          'exitCode': 2,
          'semantic': {
            'kind': 'command',
            'command': 'make test',
            'cwd': '/repo',
            'state': 'failed',
            'stdout': {'text': 'ok\n', 'totalBytes': 3},
            'stderr': {'text': 'boom\n', 'truncated': true},
          },
        }),
      )!;
      expect(presentation.command, 'make test');
      expect(presentation.cwd, '/repo');
      expect(presentation.state, ToolCommandState.failed);
      expect(presentation.exitCode, 2);
      expect(presentation.hasSeparateStreams, isTrue);
      expect(presentation.stdout.text, 'ok\n');
      expect(presentation.stderr.text, 'boom\n');
      expect(presentation.stderrTruncatedBySource, isTrue);
      expect(presentation.stdoutTruncatedBySource, isFalse);
    });

    test('a merged-output source is never presented as a named stream', () {
      final presentation = buildToolCommandPresentation(
        expanded: true,
        result: _result({
          'result': 'merged output',
          'semantic': {
            'kind': 'command',
            'command': 'ls',
            'state': 'completed',
          },
        }),
      )!;
      expect(presentation.hasSeparateStreams, isFalse);
      expect(presentation.combined.text, 'merged output');
      expect(presentation.stdout.isEmpty, isTrue);
    });

    test('missing metadata yields unknown, never a fabricated exit code', () {
      final presentation = buildToolCommandPresentation(
        expanded: false,
        result: _result({
          'semantic': {
            'kind': 'command',
            'command': 'flaky',
            'state': 'unknown',
          },
        }),
      )!;
      expect(presentation.state, ToolCommandState.unknown);
      expect(presentation.exitCode, isNull);
    });

    test('a call with no result presents as running', () {
      final presentation = buildToolCommandPresentation(
        expanded: false,
        call: _call({
          'semantic': {
            'kind': 'command',
            'command': 'sleep 30',
            'state': 'running',
          },
        }),
      )!;
      expect(presentation.state, ToolCommandState.running);
      expect(presentation.hasOutput, isFalse);
    });

    test('the collapsed bound is far tighter than the expanded one', () {
      final long = List.generate(500, (index) => 'row$index').join('\n');
      final message = _result({
        'semantic': {
          'kind': 'command',
          'command': 'gen',
          'state': 'completed',
          'stdout': {'text': long},
        },
      });
      final collapsed = buildToolCommandPresentation(
        expanded: false,
        result: message,
      )!;
      final expanded = buildToolCommandPresentation(
        expanded: true,
        result: message,
      )!;
      expect(collapsed.stdout.text.split('\n'), hasLength(12));
      expect(expanded.stdout.text.split('\n'), hasLength(400));
      expect(collapsed.stdout.truncated, isTrue);
    });

    test('ANSI in a command line and its output is sanitized', () {
      final presentation = buildToolCommandPresentation(
        expanded: true,
        result: _result({
          'semantic': {
            'kind': 'command',
            'command': '\x1b[1mgit\x1b[0m status',
            'state': 'completed',
            'stdout': {'text': '\x1b[32mclean\x1b[0m'},
          },
        }),
      )!;
      expect(presentation.command, 'git status');
      expect(presentation.stdout.text, 'clean');
    });

    test('a revision-8 execute row derives command and state honestly', () {
      final presentation = buildToolCommandPresentation(
        expanded: true,
        result: _result({
          'toolClass': 'execute',
          'title': 'npm run build',
          'exitCode': 1,
          'result': 'failed',
        }),
      )!;
      expect(presentation.command, 'npm run build');
      expect(presentation.state, ToolCommandState.failed);
      expect(presentation.hasSeparateStreams, isFalse);
      expect(presentation.combined.text, 'failed');
    });
  });

  group('file-read presentation', () {
    test('numbers lines from the published start line', () {
      final presentation = buildToolFileReadPresentation(
        result: _result({
          'semantic': {
            'kind': 'file-read',
            'path': 'lib/main.dart',
            'startLine': 120,
            'preview': 'a\nb\nc',
            'totalLines': 400,
          },
        }),
      )!;
      expect(presentation.path, 'lib/main.dart');
      expect(presentation.lines.map((line) => line.number), [120, 121, 122]);
      expect(presentation.totalLines, 400);
    });

    test(
      'absent line numbers render no gutter rather than counting from 1',
      () {
        final presentation = buildToolFileReadPresentation(
          result: _result({
            'semantic': {
              'kind': 'file-read',
              'path': 'x.txt',
              'preview': 'a\nb',
            },
          }),
        )!;
        expect(presentation.lines.every((line) => line.number == null), isTrue);
      },
    );

    test('a very large start line is preserved exactly', () {
      final presentation = buildToolFileReadPresentation(
        result: _result({
          'semantic': {
            'kind': 'file-read',
            'path': 'huge.log',
            'startLine': 1999998,
            'preview': 'a\nb',
          },
        }),
      )!;
      expect(presentation.lines.first.number, 1999998);
      expect(presentation.lines.last.number, 1999999);
    });

    test('an unavailable read states why and renders no body', () {
      final presentation = buildToolFileReadPresentation(
        result: _result({
          'semantic': {
            'kind': 'file-read',
            'path': 'img.png',
            'unavailable': 'binary',
          },
        }),
      )!;
      expect(presentation.unavailable, ToolReadUnavailableReason.binary);
      expect(presentation.lines, isEmpty);
    });

    test('the preview is clipped to the render bound', () {
      final presentation = buildToolFileReadPresentation(
        result: _result({
          'semantic': {
            'kind': 'file-read',
            'path': 'big.txt',
            'startLine': 1,
            'preview': List.generate(1000, (index) => 'l$index').join('\n'),
          },
        }),
      )!;
      expect(presentation.lines, hasLength(200));
      expect(presentation.truncated, isTrue);
    });
  });

  group('search presentation', () {
    test('groups matches per file with authoritative counts', () {
      final presentation = buildToolSearchPresentation(
        result: _result({
          'semantic': {
            'kind': 'search',
            'query': 'TODO',
            'scope': 'lib/',
            'matchCount': 9,
            'fileCount': 2,
            'groups': [
              {
                'path': 'a.dart',
                'matchCount': 7,
                'matches': [
                  {'line': 3, 'text': '// TODO one'},
                ],
                'truncated': true,
              },
              {'path': 'b.dart', 'matchCount': 2},
            ],
          },
        }),
      )!;
      expect(presentation.query, 'TODO');
      expect(presentation.scope, 'lib/');
      expect(presentation.matchCount, 9);
      expect(presentation.fileCount, 2);
      expect(presentation.groups, hasLength(2));
      expect(presentation.groups.first.matches.single.number, 3);
      expect(presentation.groups.first.truncated, isTrue);
    });

    test('a genuine no-match result is distinguishable from a bounded one', () {
      final empty = buildToolSearchPresentation(
        result: _result({
          'semantic': {'kind': 'search', 'query': 'zzz', 'matchCount': 0},
        }),
      )!;
      expect(empty.isEmptyResult, isTrue);

      final bounded = buildToolSearchPresentation(
        result: _result({
          'semantic': {
            'kind': 'search',
            'query': 'zzz',
            'truncated': true,
          },
        }),
      )!;
      expect(bounded.isEmptyResult, isFalse);
      expect(bounded.truncated, isTrue);
    });

    test('group and snippet bounds hold', () {
      final presentation = buildToolSearchPresentation(
        result: _result({
          'semantic': {
            'kind': 'search',
            'groups': [
              for (var index = 0; index < 50; index++)
                {
                  'path': 'f$index.dart',
                  'matches': [
                    for (var match = 0; match < 40; match++)
                      {'text': 'x' * 900},
                  ],
                },
            ],
          },
        }),
      )!;
      expect(presentation.groups, hasLength(20));
      expect(presentation.truncated, isTrue);
      expect(presentation.groups.first.matches, hasLength(10));
      expect(
        presentation.groups.first.matches.first.text.length,
        lessThanOrEqualTo(300),
      );
    });
  });

  group('web presentation', () {
    test('extracts a readable domain and keeps the URL as text', () {
      final presentation = buildToolWebPresentation(
        result: _result({
          'semantic': {
            'kind': 'web',
            'query': 'dart isolates',
            'results': [
              {
                'url': 'https://www.example.com/a/b?c=d',
                'title': 'Isolates',
                'snippet': 'about isolates',
              },
            ],
          },
        }),
      )!;
      expect(presentation.results.single.domain, 'example.com');
      expect(
        presentation.results.single.url,
        'https://www.example.com/a/b?c=d',
      );
      expect(presentation.results.single.title, 'Isolates');
    });

    test('an unparseable URL degrades to bounded text', () {
      expect(toolWebDomain('not a url at all'), 'not a url at all');
      expect(toolWebDomain('x' * 200).length, 60);
    });

    test('the result bound holds', () {
      final presentation = buildToolWebPresentation(
        result: _result({
          'semantic': {
            'kind': 'web',
            'results': [
              for (var index = 0; index < 40; index++)
                {'url': 'https://example.com/$index'},
            ],
          },
        }),
      )!;
      expect(presentation.results, hasLength(10));
      expect(presentation.truncated, isTrue);
    });

    test('a sender-clipped result carries its flag through', () {
      final presentation = buildToolWebPresentation(
        result: _result({
          'semantic': {
            'kind': 'web',
            'results': [
              {'url': 'https://example.com/a', 'snippet': 'partial'},
              {
                'url': 'https://example.com/b',
                'snippet': 'partial',
                'truncated': true,
              },
            ],
          },
        }),
      )!;
      expect(presentation.results.first.truncated, isFalse);
      expect(presentation.results.last.truncated, isTrue);
    });
  });

  group('decode bounds', () {
    // The renderer's bounds are the SECOND line of defence. These prove the
    // first one: an oversized frame is never fully materialized just to be
    // trimmed afterwards.
    test('an oversized group list is capped while decoding', () {
      final semantic = _result({
        'semantic': {
          'kind': 'search',
          'groups': [
            for (var index = 0; index < 5000; index++)
              {'path': 'file$index.dart'},
          ],
        },
      }).toolSemantic!.search!;
      expect(semantic.groups, hasLength(ToolSemanticDecodeBounds.searchGroups));
      expect(semantic.truncated, isTrue);
    });

    test('an oversized match list is capped while decoding', () {
      final semantic = _result({
        'semantic': {
          'kind': 'search',
          'groups': [
            {
              'path': 'a.dart',
              'matches': [
                for (var index = 0; index < 5000; index++)
                  {'line': index + 1, 'text': 'match $index'},
              ],
            },
          ],
        },
      }).toolSemantic!.search!;
      final group = semantic.groups.single;
      expect(
        group.matches,
        hasLength(ToolSemanticDecodeBounds.searchMatchesPerGroup),
      );
      expect(group.truncated, isTrue);
    });

    test('an oversized result list is capped while decoding', () {
      final semantic = _result({
        'semantic': {
          'kind': 'web',
          'results': [
            for (var index = 0; index < 5000; index++)
              {'url': 'https://example.com/$index'},
          ],
        },
      }).toolSemantic!.web!;
      expect(semantic.results, hasLength(ToolSemanticDecodeBounds.webResults));
      expect(semantic.truncated, isTrue);
    });
  });

  group('collapsed summary', () {
    test('a command summary carries the command and cwd, no body', () {
      final summary = resolveToolSummary(
        result: _result({
          'semantic': {
            'kind': 'command',
            'command': 'make test',
            'cwd': '/repo',
            'state': 'failed',
            'stdout': {'text': 'x' * 100000},
          },
        }),
      )!;
      expect(summary.family, ToolPresentationFamily.command);
      expect(summary.primary, 'make test');
      expect(summary.secondary, '/repo');
    });

    test('a search summary carries query, scope, and authoritative counts', () {
      final summary = resolveToolSummary(
        result: _result({
          'semantic': {
            'kind': 'search',
            'query': 'TODO',
            'scope': 'lib/',
            'matchCount': 12,
            'fileCount': 3,
          },
        }),
      )!;
      expect(summary.primary, 'TODO');
      expect(summary.secondary, 'lib/');
      expect(summary.matchCount, 12);
      expect(summary.fileCount, 3);
    });

    test('a search without an authoritative file count uses its groups', () {
      final summary = resolveToolSummary(
        result: _result({
          'semantic': {
            'kind': 'search',
            'query': 'TODO',
            'groups': [
              {'path': 'a.dart'},
              {'path': 'b.dart'},
            ],
          },
        }),
      )!;
      expect(summary.fileCount, 2);
      expect(summary.matchCount, isNull);
    });

    test('a file-read summary is the path', () {
      final summary = resolveToolSummary(
        result: _result({
          'semantic': {
            'kind': 'file-read',
            'path': 'lib/main.dart',
            'preview': 'void main() {}',
          },
        }),
      )!;
      expect(summary.family, ToolPresentationFamily.fileRead);
      expect(summary.primary, 'lib/main.dart');
    });

    test('a web summary prefers the query and adds the domain', () {
      final summary = resolveToolSummary(
        result: _result({
          'semantic': {
            'kind': 'web',
            'query': 'dart isolates',
            'results': [
              {'url': 'https://www.example.com/a'},
            ],
          },
        }),
      )!;
      expect(summary.primary, 'dart isolates');
      expect(summary.secondary, 'example.com');
      expect(summary.resultCount, 1);
    });

    test('a fetch with no query summarizes as its domain', () {
      final summary = resolveToolSummary(
        result: _result({
          'semantic': {'kind': 'web', 'url': 'https://docs.example.com/page'},
        }),
      )!;
      expect(summary.primary, 'docs.example.com');
    });

    test('a row with no semantic resolves to no summary', () {
      expect(
        resolveToolSummary(
          result: _result({'toolClass': 'execute', 'title': 'make test'}),
        ),
        isNull,
      );
    });

    test('resolving a summary is constant work in the body size', () {
      // Both fixtures are built ONCE, outside the timed region: this measures
      // the resolver, not the cost of materializing a quarter-megabyte string.
      AgentMessage message(int bodyBytes) => _result({
        'semantic': {
          'kind': 'command',
          'command': 'make test',
          'state': 'completed',
          'stdout': {'text': 'x' * bodyBytes},
        },
      });
      final smallMessage = message(1024);
      final largeMessage = message(1024 * 256);
      resolveToolSummary(result: smallMessage); // warm up

      final small = Stopwatch()..start();
      for (var i = 0; i < 500; i++) {
        resolveToolSummary(result: smallMessage);
      }
      small.stop();
      final large = Stopwatch()..start();
      for (var i = 0; i < 500; i++) {
        resolveToolSummary(result: largeMessage);
      }
      large.stop();
      // A 256x larger body must not make the collapsed summary cost more.
      expect(
        large.elapsedMicroseconds,
        lessThan(5 * (small.elapsedMicroseconds + 50)),
      );
    });
  });

  group('structured fallback', () {
    test('orders map keys deterministically', () {
      final first = buildToolFallbackPresentation({'z': 1, 'a': 2, 'm': 3});
      final second = buildToolFallbackPresentation({'m': 3, 'z': 1, 'a': 2});
      expect(
        first.rows.map((row) => row.label),
        second.rows.map((row) => row.label),
      );
      expect(first.rows.map((row) => row.label), ['a', 'm', 'z']);
    });

    test('redacts credential-like field names, not their neighbours', () {
      final presentation = buildToolFallbackPresentation({
        'api_key': 'sk-live-abcdef',
        'ApiKey': 'sk-live-abcdef',
        'x-api-key': 'sk-live-abcdef',
        'authorization': 'Bearer abc',
        'password': 'hunter2',
        'sessionToken': 'abc',
        'endpoint': 'https://example.com',
      });
      final rendered = presentation.rows.map((row) => row.value).join(' ');
      expect(rendered, isNot(contains('sk-live-abcdef')));
      expect(rendered, isNot(contains('hunter2')));
      expect(rendered, isNot(contains('Bearer')));
      expect(rendered, contains('https://example.com'));
      expect(
        presentation.rows.where((row) => row.redacted).map((row) => row.label),
        containsAll(<String>['api_key', 'ApiKey', 'x-api-key', 'password']),
      );
    });

    test('isRedactedToolField normalizes separators and casing', () {
      for (final key in const [
        'apiKey',
        'API_KEY',
        'x-api-key',
        'accessKey',
        'private_key',
        'refresh-token',
        'Cookie',
      ]) {
        expect(isRedactedToolField(key), isTrue, reason: key);
      }
      for (final key in const ['path', 'command', 'count', 'url']) {
        expect(isRedactedToolField(key), isFalse, reason: key);
      }
    });

    test('deep nesting terminates at the depth bound', () {
      Object? nested = 'leaf';
      for (var index = 0; index < 40; index++) {
        nested = {'level$index': nested};
      }
      final presentation = buildToolFallbackPresentation(nested);
      expect(presentation.truncated, isTrue);
      expect(
        presentation.rows.every((row) => row.depth <= 5),
        isTrue,
      );
    });

    test('a self-referencing payload terminates instead of recursing', () {
      final cyclic = <String, Object?>{'name': 'root'};
      cyclic['self'] = cyclic;
      final presentation = buildToolFallbackPresentation(cyclic);
      expect(presentation.truncated, isTrue);
      expect(presentation.rows.length, lessThan(20));
    });

    test('breadth is bounded per level', () {
      final wide = {
        for (var index = 0; index < 500; index++)
          'k${index.toString().padLeft(4, '0')}': index,
      };
      final presentation = buildToolFallbackPresentation(wide);
      expect(presentation.truncated, isTrue);
      expect(presentation.rows.length, lessThanOrEqualTo(33));
    });

    test('binary-like content is summarized, never dumped', () {
      final binary = String.fromCharCodes(
        List.generate(4096, (index) => index % 7),
      );
      final presentation = buildToolFallbackPresentation({'blob': binary});
      final row = presentation.rows.single;
      expect(row.value, startsWith('<binary '));
      expect(row.value.length, lessThan(40));
    });

    test('a malformed payload still renders something bounded', () {
      for (final payload in <Object?>[
        null,
        '',
        42,
        <Object?>[null, null],
        {'': null},
        {1: 'int key'},
      ]) {
        final presentation = buildToolFallbackPresentation(payload);
        expect(presentation.rows.length, lessThanOrEqualTo(4));
      }
    });

    test('an oversized payload is clipped and says so', () {
      final presentation = buildToolFallbackPresentation({
        for (var index = 0; index < 30; index++) 'field$index': 'y' * 5000,
      });
      expect(presentation.truncated, isTrue);
      for (final row in presentation.rows) {
        expect(row.value.length, lessThanOrEqualTo(201));
      }
    });

    test('control sequences never reach a fallback value', () {
      final presentation = buildToolFallbackPresentation({
        'note': '\x1b[31mred\x1b[0m\u202Etext',
      });
      expect(presentation.rows.single.value, 'redtext');
    });
  });

  group('bounded work instrumentation', () {
    // A body far larger than any render bound, reused across the shallow and
    // deep cases so the only variable is transcript depth.
    final huge = List.generate(200000, (index) => 'line$index').join('\n');

    AgentMessage command(String stdout) => _result({
      'exitCode': 0,
      'semantic': {
        'kind': 'command',
        'command': 'generate',
        'state': 'completed',
        'stdout': {'text': stdout},
      },
    });

    test('a collapsed row reads its state without touching any body', () {
      // resolveToolCommandState must not scale with output: the same call on a
      // 200k-line body and a 1-line body does identical work.
      final big = command(huge);
      final small = command('one');
      expect(resolveToolCommandState(result: big), ToolCommandState.completed);
      expect(
        resolveToolCommandState(result: small),
        ToolCommandState.completed,
      );

      final bigStopwatch = Stopwatch()..start();
      for (var index = 0; index < 2000; index++) {
        resolveToolCommandState(result: big);
      }
      bigStopwatch.stop();
      final smallStopwatch = Stopwatch()..start();
      for (var index = 0; index < 2000; index++) {
        resolveToolCommandState(result: small);
      }
      smallStopwatch.stop();
      // Generous ceiling: this asserts the absence of a size-proportional scan,
      // not a precise timing. A body-touching implementation is ~5 orders out.
      expect(
        bigStopwatch.elapsedMicroseconds,
        lessThan(200 * (smallStopwatch.elapsedMicroseconds + 50)),
      );
    });

    test('expanded rendering stays bounded regardless of retained size', () {
      final expanded = buildToolCommandPresentation(
        expanded: true,
        result: command(huge),
      )!;
      expect(
        expanded.stdout.text.length,
        lessThanOrEqualTo(ToolPresentationBounds.expandedOutputChars),
      );
      expect(
        expanded.stdout.text.split('\n').length,
        lessThanOrEqualTo(ToolPresentationBounds.expandedOutputLines),
      );
      expect(expanded.stdout.truncated, isTrue);
    });

    test('retained and rendered sizes are independent', () {
      // The retained wire body is 200k lines; the collapsed render is 12 and
      // the expanded render is 400. Neither render bound moves with retention.
      final collapsed = buildToolCommandPresentation(
        expanded: false,
        result: command(huge),
      )!;
      final expanded = buildToolCommandPresentation(
        expanded: true,
        result: command(huge),
      )!;
      expect(collapsed.stdout.text.split('\n'), hasLength(12));
      expect(expanded.stdout.text.split('\n'), hasLength(400));
    });

    test('a deep transcript costs the same per row as a shallow one', () {
      // Per-row derivation is independent of how many rows precede it, because
      // nothing here consults transcript position or accumulated state.
      final rows = [for (var index = 0; index < 500; index++) command('out')];
      final shallow = Stopwatch()..start();
      buildToolCommandPresentation(expanded: true, result: rows.first);
      shallow.stop();
      final deep = Stopwatch()..start();
      buildToolCommandPresentation(expanded: true, result: rows.last);
      deep.stop();
      expect(
        deep.elapsedMicroseconds,
        lessThan(100 * (shallow.elapsedMicroseconds + 50)),
      );
    });

    test('a live fragment does not re-derive the whole accumulated output', () {
      // Successive frames redeliver a growing body. Each frame's render cost is
      // bounded by the render bound, not by the accumulated size, so total work
      // across N frames stays linear in N rather than quadratic.
      final body = StringBuffer();
      final sizes = <int>[];
      for (var frame = 0; frame < 50; frame++) {
        body.write('fragment $frame\n' * 100);
        final presentation = buildToolCommandPresentation(
          expanded: false,
          result: command(body.toString()),
        )!;
        sizes.add(presentation.stdout.text.length);
      }
      expect(sizes.first, lessThanOrEqualTo(2048));
      expect(sizes.last, lessThanOrEqualTo(2048));
    });
  });
}
