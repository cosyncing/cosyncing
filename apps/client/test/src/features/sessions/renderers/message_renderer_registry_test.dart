import 'dart:convert';
import 'dart:io';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/components.dart';
import 'package:cosyncing_client/src/design/themes/soft_minimalist_theme.dart';
// The canonical renderer import exceeds the style line width; keep the stable
// package path for boundary-safe package import resolution.
// ignore: lines_longer_than_80_chars
import 'package:cosyncing_client/src/features/sessions/renderers/message_renderer_registry.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_transcript_display.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/tool_display_mode.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('message renderer registry', () {
    test('has a renderer for every canonical AgentMessageType', () {
      final canonicalTypes = <AgentMessageType>{
        for (final type in AgentMessageType.values)
          if (type != AgentMessageType.unknown) type,
      };

      expect(agentMessageRendererRegistry.keys.toSet(), canonicalTypes);
    });

    for (final fixture in _renderedFixtures) {
      testWidgets(
        'renders ${fixture.caseName} payload fields',
        (tester) async {
          await _pumpRenderer(tester, fixture.message);

          for (final expectedText in fixture.expectedText) {
            expect(find.textContaining(expectedText), findsAtLeastNWidgets(1));
          }
        },
      );
    }

    testWidgets('falls back for unknown message types', (tester) async {
      await _pumpRenderer(
        tester,
        const AgentMessage(
          type: AgentMessageType.unknown,
          raw: {'type': 'unknown', 'payload': 'fallback-only'},
        ),
      );

      expect(find.text('Unsupported message type'), findsOneWidget);
      // The wire type is no longer echoed in the bubble chrome; it lives in
      // the per-message Details dialog.
      expect(find.text('Type: unknown'), findsNothing);
      expect(find.textContaining('fallback-only'), findsAtLeastNWidgets(1));
    });

    testWidgets('error boxes show payload without generic filler', (
      tester,
    ) async {
      await _pumpRenderer(
        tester,
        const AgentMessage(
          type: AgentMessageType.error,
          raw: {
            'type': 'error',
            'code': 'E_WRITE',
            'message': 'Write failed',
          },
        ),
      );

      expect(find.byType(TranscriptBox), findsOneWidget);
      expect(find.text('code: E_WRITE'), findsOneWidget);
      expect(find.text('message: Write failed'), findsOneWidget);
      expect(find.text('No further detail was provided.'), findsNothing);
      expect(
        find.text(
          'The session reported an error. Open details for technical '
          'information.',
        ),
        findsNothing,
      );
    });

    testWidgets('empty error boxes use the localized no-detail fallback', (
      tester,
    ) async {
      await _pumpRenderer(
        tester,
        const AgentMessage(
          type: AgentMessageType.error,
          raw: {'type': 'error'},
        ),
      );
      expect(find.text('No further detail was provided.'), findsOneWidget);

      await _pumpRenderer(
        tester,
        const AgentMessage(
          type: AgentMessageType.error,
          raw: {'type': 'error'},
        ),
        locale: const Locale('zh'),
      );
      expect(find.text('未提供更多细节。'), findsOneWidget);
    });

    testWidgets('renders token counts as a slim caption, not a card', (
      tester,
    ) async {
      await _pumpRenderer(
        tester,
        const AgentMessage(
          type: AgentMessageType.tokenCount,
          raw: {'type': 'token-count', 'input': 100, 'output': 50},
        ),
      );

      expect(find.textContaining('100 input'), findsOneWidget);
      expect(find.textContaining('50 output'), findsOneWidget);
      expect(find.textContaining('total'), findsNothing);
      expect(find.byType(Card), findsNothing);
      expect(find.byType(Divider), findsNothing);
      expect(find.text('Token count'), findsNothing);
    });

    testWidgets('renders status events as a slim caption, not a card', (
      tester,
    ) async {
      await _pumpRenderer(
        tester,
        const AgentMessage(
          type: AgentMessageType.status,
          raw: {'type': 'status', 'status': 'Working on task'},
        ),
      );

      expect(find.text('Working on task'), findsOneWidget);
      expect(find.byType(Card), findsNothing);
      expect(find.byType(Divider), findsNothing);
      expect(find.text('Status'), findsNothing);
    });

    testWidgets(
      'renders a generic interruption as ancestor-selectable red inline text',
      (tester) async {
        for (final brightness in Brightness.values) {
          await _pumpRenderer(
            tester,
            const AgentMessage(
              type: AgentMessageType.notice,
              raw: {
                'type': 'notice',
                'message': 'Adapter-specific interruption copy',
                'semantic': {
                  'kind': 'interruption',
                  'reason': 'generic',
                },
              },
            ),
            brightness: brightness,
          );

          final finder = find.byKey(
            const Key('session-transcript-interruption-inline'),
          );
          expect(finder, findsOneWidget);
          expect(find.text('Interrupted'), findsOneWidget);
          expect(find.byType(Card), findsNothing);
          expect(find.byType(Icon), findsNothing);
          final text = tester.widget<Text>(
            find.descendant(of: finder, matching: find.byType(Text)),
          );
          expect(
            find.descendant(
              of: finder,
              matching: find.byType(SelectableText),
            ),
            findsNothing,
          );
          final tokens = brightness == Brightness.light
              ? softMinimalistTheme.light
              : softMinimalistTheme.dark;
          expect(text.style?.color, tokens.statusError);
        }
      },
    );

    testWidgets('explains repeated automatic approval denial inline', (
      tester,
    ) async {
      await _pumpRenderer(
        tester,
        const AgentMessage(
          type: AgentMessageType.notice,
          raw: {
            'type': 'notice',
            'message': 'Adapter-specific repeated denial copy',
            'semantic': {
              'kind': 'interruption',
              'reason': 'automatic-approval-denied-repeatedly',
            },
          },
        ),
      );

      expect(
        find.text(
          'Interrupted because automatic permission approval was denied '
          'repeatedly.',
        ),
        findsOneWidget,
      );
      expect(
        find.byKey(const Key('session-transcript-interruption-inline')),
        findsOneWidget,
      );
      expect(find.byType(SelectableText), findsNothing);
      expect(find.byType(Card), findsNothing);
      expect(find.byType(Icon), findsNothing);
    });

    testWidgets(
      'unknown notice text stays unchanged and neutral in light and dark',
      (tester) async {
        const raw =
            'Conversation interrupted — quoted by a lookup, not a marker.';
        for (final brightness in Brightness.values) {
          await _pumpRenderer(
            tester,
            const AgentMessage(
              type: AgentMessageType.notice,
              raw: {'type': 'notice', 'message': raw},
            ),
            brightness: brightness,
          );

          final finder = find.byKey(
            const Key('session-transcript-notice-inline'),
          );
          expect(finder, findsOneWidget);
          expect(find.text(raw), findsOneWidget);
          expect(
            find.byKey(
              const Key('session-transcript-interruption-inline'),
            ),
            findsNothing,
          );
          final text = tester.widget<Text>(
            find.descendant(
              of: finder,
              matching: find.byType(Text),
            ),
          );
          expect(
            find.descendant(
              of: finder,
              matching: find.byType(SelectableText),
            ),
            findsNothing,
          );
          final tokens = brightness == Brightness.light
              ? softMinimalistTheme.light
              : softMinimalistTheme.dark;
          expect(text.style?.color, tokens.textSecondary);
          expect(find.byType(Card), findsNothing);
          expect(find.byType(Icon), findsNothing);
        }
      },
    );

    testWidgets(
      'renders compaction as ancestor-selectable inline text without a card',
      (tester) async {
        for (final brightness in Brightness.values) {
          await _pumpRenderer(
            tester,
            const AgentMessage(
              type: AgentMessageType.historyReset,
              raw: {
                'type': 'history-reset',
                'notice': 'Adapter-specific compaction copy',
                'semantic': {'kind': 'compaction'},
              },
            ),
            brightness: brightness,
          );

          final finder = find.byKey(
            const Key('session-transcript-history-reset-inline'),
          );
          expect(finder, findsOneWidget);
          expect(find.text('Compaction complete'), findsOneWidget);
          final text = tester.widget<Text>(
            find.descendant(
              of: finder,
              matching: find.byType(Text),
            ),
          );
          expect(
            find.descendant(
              of: finder,
              matching: find.byType(SelectableText),
            ),
            findsNothing,
          );
          expect(text.data, 'Compaction complete');
          final tokens = brightness == Brightness.light
              ? softMinimalistTheme.light
              : softMinimalistTheme.dark;
          expect(text.style?.color, tokens.textSecondary);
          expect(find.byType(Card), findsNothing);
          expect(find.byType(Icon), findsNothing);
        }
      },
    );

    group('actionable requests and the read-only hint', () {
      // The hint renders as "<label> (read-only)". Passing it unconditionally
      // labelled an answerable request read-only directly above its own
      // working Reject / Allow buttons: the transcript called the decision
      // somebody else's while the card below it was taking that decision.
      testWidgets('an answerable request is not called read-only', (
        tester,
      ) async {
        await _pumpRenderer(
          tester,
          AgentMessage.fromJson({
            'type': 'permission-request',
            'requestId': 'perm-cutover-dry-run',
            'title': 'Bash',
            'detail': 'Run the staging cutover dry run',
          }),
        );

        expect(find.text('Permission request'), findsOneWidget);
        expect(find.textContaining('Bash'), findsAtLeastNWidgets(1));
        expect(find.textContaining('read-only'), findsNothing);
        expect(
          find.textContaining('Awaiting permission response'),
          findsNothing,
        );
      });

      testWidgets('a read-only request still says whose decision it is', (
        tester,
      ) async {
        await _pumpRenderer(
          tester,
          AgentMessage.fromJson({
            'type': 'permission-request',
            'requestId': 'perm-cutover-dry-run',
            'title': 'Bash',
            'detail': 'Run the staging cutover dry run',
            'readOnly': true,
          }),
        );

        expect(
          find.text('Awaiting permission response (read-only)'),
          findsOneWidget,
        );
      });

      testWidgets('an answerable question is not called read-only', (
        tester,
      ) async {
        await _pumpRenderer(
          tester,
          AgentMessage.fromJson({
            'type': 'question-request',
            'requestId': 'question-release-notes',
            'questions': [
              {'question': 'Publish the release notes?'},
            ],
          }),
        );

        expect(find.text('Question'), findsOneWidget);
        expect(find.text('Publish the release notes?'), findsOneWidget);
        expect(find.textContaining('read-only'), findsNothing);
        expect(find.textContaining('Awaiting answer'), findsNothing);
      });

      testWidgets('a read-only question still says whose answer it awaits', (
        tester,
      ) async {
        await _pumpRenderer(
          tester,
          AgentMessage.fromJson({
            'type': 'question-request',
            'requestId': 'question-release-notes',
            'readOnly': true,
            'questions': [
              {'question': 'Publish the release notes?'},
            ],
          }),
        );

        expect(find.text('Awaiting answer (read-only)'), findsOneWidget);
      });
    });

    group('D9 tool display', () {
      testWidgets('starts collapsed at narrow and wide widths', (
        tester,
      ) async {
        final message = AgentMessage.fromJson({
          'type': 'tool-call',
          'callId': 'execute-1',
          'toolName': 'native-name-is-display-only',
          'toolClass': 'execute',
          'args': {'command': 'flutter test'},
        });

        await _pumpRendererAtWidth(tester, message, width: 699);
        expect(find.byKey(const ValueKey('tool-detail-args')), findsNothing);

        await _pumpRendererAtWidth(tester, message, width: 700);
        expect(find.byKey(const ValueKey('tool-detail-args')), findsNothing);
      });

      testWidgets('Tier-1 and missing classes start collapsed but expand', (
        tester,
      ) async {
        final execute = AgentMessage.fromJson({
          'type': 'tool-call',
          'callId': 'execute-tier1',
          'toolClass': 'execute',
          'args': {'command': 'flutter test'},
        });
        await _pumpRendererAtWidth(
          tester,
          execute,
          width: 900,
          mode: ToolDisplayMode.tier1Only,
        );
        expect(find.byKey(const ValueKey('tool-detail-args')), findsNothing);
        await tester.tap(
          find.byKey(const ValueKey('tool-execute-tier1-details')),
        );
        await tester.pump();
        expect(find.byKey(const ValueKey('tool-detail-args')), findsOneWidget);

        final missingClass = AgentMessage.fromJson({
          'type': 'tool-call',
          'callId': 'missing-class',
          'args': {'path': 'README.md'},
        });
        await _pumpRendererAtWidth(tester, missingClass, width: 900);
        expect(find.byKey(const ValueKey('tool-detail-args')), findsNothing);
      });

      testWidgets('lookup stays collapsed on wide layouts', (tester) async {
        final lookup = AgentMessage.fromJson({
          'type': 'tool-call',
          'callId': 'lookup-1',
          'toolClass': 'lookup',
          'args': {'path': 'README.md'},
        });

        await _pumpRendererAtWidth(tester, lookup, width: 1200);

        expect(find.byKey(const ValueKey('tool-detail-args')), findsNothing);
      });

      testWidgets('lookup group keeps each child timestamp', (tester) async {
        AgentMessage lookup(String id, DateTime timestamp) =>
            AgentMessage.fromJson({
              'type': 'tool-call',
              'callId': id,
              'toolClass': 'lookup',
              'timestamp': timestamp.millisecondsSinceEpoch,
              'args': {'path': '$id.md'},
            });
        final first = lookup('lookup-a', DateTime(2026, 7, 18, 10, 15));
        final second = lookup('lookup-b', DateTime(2026, 7, 18, 10, 16));
        final group = LookupGroupTranscriptDisplayEntry(
          tools: [
            ToolTranscriptDisplayEntry(
              call: first,
              result: null,
              sourceIndices: const [0],
            ),
            ToolTranscriptDisplayEntry(
              call: second,
              result: null,
              sourceIndices: const [1],
            ),
          ],
        );

        await tester.pumpWidget(
          MaterialApp(
            localizationsDelegates: AppLocalizations.localizationsDelegates,
            supportedLocales: AppLocalizations.supportedLocales,
            // An expanded lookup row renders token-consuming surfaces, so the
            // theme extension must be attached (design/README.md).
            theme: buildAppTheme(softMinimalistTheme.light, Brightness.light),
            home: Scaffold(
              body: SingleChildScrollView(
                child: Builder(
                  builder: (context) => buildLookupGroupRenderer(
                    context,
                    group,
                    toolsExpanded: true,
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pump();

        expect(find.text('10:15'), findsOneWidget);
        expect(find.text('10:16'), findsOneWidget);
      });

      testWidgets('shows only finite authoritative duration metadata', (
        tester,
      ) async {
        final timed = AgentMessage.fromJson({
          'type': 'tool-result',
          'callId': 'timed-1',
          'toolClass': 'execute',
          'result': 'ok',
          'durationMs': 1540,
        });
        await _pumpRendererAtWidth(tester, timed, width: 700);
        expect(find.byKey(const Key('tool-duration-chip')), findsOneWidget);
        expect(find.text('1.5s'), findsOneWidget);

        final untimed = AgentMessage.fromJson({
          'type': 'tool-result',
          'callId': 'untimed-1',
          'toolClass': 'execute',
          'result': 'ok',
        });
        await _pumpRendererAtWidth(tester, untimed, width: 700);
        expect(find.byKey(const Key('tool-duration-chip')), findsNothing);
      });

      testWidgets('Show all restores the exact payload and can return', (
        tester,
      ) async {
        final output = List.filled(5000, 'x').join();
        final result = AgentMessage.fromJson({
          'type': 'tool-result',
          'callId': 'long-result',
          'toolClass': 'execute',
          'result': output,
        });
        await _pumpRendererAtWidth(tester, result, width: 700);
        await tester.tap(
          find.byKey(const ValueKey('tool-long-result-details')),
        );
        await tester.pump();

        Text detail() => tester.widget<Text>(
          find.byKey(const ValueKey('tool-detail-result')),
        );

        expect(detail().data, isNot(contains(output)));
        await tester.ensureVisible(find.text('Show all'));
        await tester.tap(find.text('Show all'));
        await tester.pump();
        expect(detail().data, 'result: $output');
        expect(find.text('Show preview'), findsOneWidget);
        await tester.ensureVisible(find.text('Show preview'));
        await tester.pump();
        await tester.tap(find.text('Show preview'));
        await tester.pump();
        expect(detail().data, isNot('result: $output'));
      });

      testWidgets('queued user bubble is visibly labeled', (tester) async {
        await _pumpRenderer(
          tester,
          AgentMessage.fromJson({
            'type': 'user-message',
            'key': 'queued-1',
            'text': 'Follow up',
            'queued': true,
          }),
        );

        expect(
          find.byKey(const Key('queued-user-message-badge')),
          findsOneWidget,
        );
        expect(find.text('Queued'), findsOneWidget);
      });

      group('message bodies are not duplicated by payload rows', () {
        testWidgets('user bubble shows its text exactly once', (tester) async {
          const body = 'Restart the broker and retry the upload.';
          await _pumpRenderer(
            tester,
            AgentMessage.fromJson({
              'type': 'user-message',
              'text': body,
              'key': '74fe8fb5-6887-46af-8d3f-2bc1f63f1a63',
              'turnId': 'turn-9',
              'sentAt': 1720000000000,
            }),
          );

          expect(find.textContaining(body), findsOneWidget);
        });

        testWidgets('user bubble hides transport envelope fields', (
          tester,
        ) async {
          await _pumpRenderer(
            tester,
            AgentMessage.fromJson({
              'type': 'user-message',
              'text': 'Ship it.',
              'key': '74fe8fb5-6887-46af-8d3f-2bc1f63f1a63',
              'turnId': 'turn-9',
              'sentAt': 1720000000000,
            }),
          );

          for (final leaked in const [
            '74fe8fb5-6887-46af-8d3f-2bc1f63f1a63',
            'turn-9',
            '1720000000000',
            'text:',
            'key:',
          ]) {
            expect(
              find.textContaining(leaked),
              findsNothing,
              reason: leaked,
            );
          }
        });

        testWidgets('model output shows its answer exactly once', (
          tester,
        ) async {
          const answer = 'The migration completed successfully.';
          await _pumpRenderer(
            tester,
            AgentMessage.fromJson({
              'type': 'model-output',
              'text': answer,
              'final': true,
              'key': 'a2f1c0de-0000-4000-8000-000000000000',
            }),
          );

          expect(find.textContaining(answer), findsOneWidget);
          expect(
            find.textContaining('a2f1c0de-0000-4000-8000-000000000000'),
            findsNothing,
          );
          expect(find.textContaining('final:'), findsNothing);
        });
      });

      group('markdown bodies render as formatted text', () {
        testWidgets('emphasis markers are consumed, not displayed', (
          tester,
        ) async {
          await _pumpRenderer(
            tester,
            AgentMessage.fromJson({
              'type': 'model-output',
              'text': 'Run **build** then `deploy` now.',
            }),
          );

          // The rendered characters no longer contain the markers.
          expect(
            find.textContaining('Run build then deploy now.'),
            findsOneWidget,
          );
          expect(find.textContaining('**build**'), findsNothing);
        });

        testWidgets('headings and bullets render without their markers', (
          tester,
        ) async {
          await _pumpRenderer(
            tester,
            AgentMessage.fromJson({
              'type': 'model-output',
              'text': '# Plan\n\n- first step\n- second step',
            }),
          );

          expect(find.textContaining('Plan'), findsWidgets);
          expect(find.textContaining('# Plan'), findsNothing);
          expect(find.textContaining('first step'), findsOneWidget);
          expect(find.textContaining('- first step'), findsNothing);
        });

        testWidgets('fenced code renders in a monospace block', (tester) async {
          await _pumpRenderer(
            tester,
            AgentMessage.fromJson({
              'type': 'model-output',
              'text': 'Try this:\n\n```bash\nls -la\n```',
            }),
          );

          expect(
            find.byKey(const ValueKey('markdown-code-block-0')),
            findsOneWidget,
          );
          final code = tester.widget<Text>(
            find.byKey(const ValueKey('markdown-code-block-0-code')),
          );
          expect(code.textSpan?.toPlainText(), 'ls -la');
          expect(code.textSpan?.style?.fontFamily, 'monospace');
          expect(
            (code.textSpan! as TextSpan).children,
            hasLength(greaterThan(1)),
          );
        });

        testWidgets('an unterminated fence still renders its content', (
          tester,
        ) async {
          await _pumpRenderer(
            tester,
            AgentMessage.fromJson({
              'type': 'model-output',
              'text': 'Streaming:\n\n```dart\nvoid main() {',
            }),
          );

          expect(
            find.byKey(const ValueKey('markdown-code-block-0')),
            findsOneWidget,
          );
          expect(find.textContaining('void main() {'), findsOneWidget);
        });

        testWidgets('plain text renders unchanged', (tester) async {
          const body = 'No markdown here, just a sentence.';
          await _pumpRenderer(
            tester,
            AgentMessage.fromJson({'type': 'model-output', 'text': body}),
          );

          expect(find.text(body), findsOneWidget);
        });
      });

      testWidgets('message bodies participate in an ancestor SelectionArea', (
        tester,
      ) async {
        // Bodies must be plain Text so the SelectionArea that wraps each
        // message can extend one selection across prose and fenced code.
        await _pumpRenderer(
          tester,
          AgentMessage.fromJson({
            'type': 'model-output',
            'text': 'Intro line\n\n```\ncode line\n```',
          }),
        );

        expect(find.byType(SelectableText), findsNothing);
      });

      test('preview obeys both caps and preserves the requested edge', () {
        final output = List.generate(
          60,
          (index) => 'line-$index ${List<String>.filled(80, '界').join()}',
        ).join('\n');

        final tail = buildToolTextPreview(output, keepTail: true);
        final head = buildToolTextPreview(output, keepTail: false);

        expect(tail.text.split('\n'), hasLength(lessThanOrEqualTo(40)));
        expect(utf8.encode(tail.text), hasLength(lessThanOrEqualTo(4096)));
        expect(tail.text, contains('line-59'));
        expect(tail.text, isNot(contains('line-0 ')));
        expect(head.text, contains('line-0 '));
        expect(head.text, isNot(contains('line-59')));
        expect(tail.isTruncated, isTrue);
        expect(head.isTruncated, isTrue);
      });
    });

    test('does not branch on tool names in renderer source', () {
      final source = File(
        'lib/src/features/sessions/renderers/message_renderer_registry.dart',
      ).readAsStringSync();
      final sanitizedSource = _sanitizeSourceForBranchCheck(source);
      final toolBranchPattern = RegExp(
        r'^(if|else if|switch)[^\n]*\btool\b',
        multiLine: true,
      );

      expect(
        toolBranchPattern.hasMatch(sanitizedSource),
        isFalse,
        reason: 'tool-based branch check',
      );
      expect(
        sanitizedSource,
        isNot(contains('switch (tool')),
        reason: 'tool-based switch branch',
      );
      expect(
        sanitizedSource,
        contains('message.type'),
        reason: 'type-driven dispatch',
      );
    });
  });
}

String _sanitizeSourceForBranchCheck(String source) {
  final withoutLineComments = source.replaceAll(RegExp('//.*'), '');
  final withoutBlockComments = withoutLineComments.replaceAll(
    RegExp(r'/\*[\s\S]*?\*/'),
    '',
  );
  final withoutSingleQuotes = withoutBlockComments.replaceAll(
    RegExp(r"'(?:\\.|[^'\\])*'"),
    '',
  );
  return withoutSingleQuotes.replaceAll(
    RegExp(r'"(?:\\.|[^"\\])*"'),
    '',
  );
}

List<_TypedMessageFixture> get _renderedFixtures => const [
  _TypedMessageFixture(
    caseName: 'model output final text',
    message: AgentMessage(
      type: AgentMessageType.modelOutput,
      raw: {
        'type': 'model-output',
        'text': 'Model replied with details.',
        'final': true,
        'key': 'turn-42',
      },
    ),
    expectedText: ['Model replied with details.'],
  ),
  _TypedMessageFixture(
    caseName: 'model output streaming delta',
    message: AgentMessage(
      type: AgentMessageType.modelOutput,
      raw: {
        'type': 'model-output',
        'delta': 'Streaming chunk',
      },
    ),
    expectedText: ['Streaming chunk'],
  ),
  _TypedMessageFixture(
    caseName: 'user message',
    message: AgentMessage(
      type: AgentMessageType.userMessage,
      raw: {'type': 'user-message', 'text': 'Hello from user'},
    ),
    expectedText: ['Hello from user'],
  ),
  _TypedMessageFixture(
    caseName: 'thinking',
    message: AgentMessage(
      type: AgentMessageType.thinking,
      raw: {
        'type': 'thinking',
        'thought': 'Considering possible approaches',
      },
    ),
    expectedText: ['Considering possible approaches'],
  ),
  _TypedMessageFixture(
    caseName: 'status',
    message: AgentMessage(
      type: AgentMessageType.status,
      raw: {'type': 'status', 'status': 'Working on task'},
    ),
    expectedText: ['Working on task'],
  ),
  _TypedMessageFixture(
    caseName: 'tool call',
    message: AgentMessage(
      type: AgentMessageType.toolCall,
      raw: {'type': 'tool-call', 'name': 'search-files'},
    ),
    expectedText: ['search-files'],
  ),
  _TypedMessageFixture(
    caseName: 'tool result',
    message: AgentMessage(
      type: AgentMessageType.toolResult,
      raw: {'type': 'tool-result', 'result': '3 entries found'},
    ),
    expectedText: ['3 entries found'],
  ),
  _TypedMessageFixture(
    caseName: 'terminal output',
    message: AgentMessage(
      type: AgentMessageType.terminalOutput,
      raw: {'type': 'terminal-output', 'command': 'git status'},
    ),
    expectedText: ['git status'],
  ),
  _TypedMessageFixture(
    caseName: 'notice',
    message: AgentMessage(
      type: AgentMessageType.notice,
      raw: {'type': 'notice', 'message': 'Broker notice for all clients'},
    ),
    expectedText: ['Broker notice for all clients'],
  ),
  _TypedMessageFixture(
    caseName: 'metadata update',
    message: AgentMessage(
      type: AgentMessageType.metadataUpdate,
      raw: {
        'type': 'metadata-update',
        'key': 'runtimeTotals',
        'value': {'totalRuntimeMs': 125000},
      },
    ),
    expectedText: [
      'Metadata updated: runtimeTotals',
      'totalRuntimeMs: 125000',
    ],
  ),
  _TypedMessageFixture(
    caseName: 'token count',
    message: AgentMessage(
      type: AgentMessageType.tokenCount,
      raw: {
        'type': 'token-count',
        'input': 100,
        'output': 50,
        'cacheRead': 25,
        'cacheWrite': 5,
        'cost': 0.1234,
      },
    ),
    expectedText: [
      'Tokens: 100 input, 50 output, 25 cache read, 5 cache write',
      '100 input',
      r'cost $0.1234',
    ],
  ),
  _TypedMessageFixture(
    caseName: 'run summary',
    message: AgentMessage(
      type: AgentMessageType.runSummary,
      raw: {
        'type': 'run-summary',
        'turnId': 'turn-1',
        'status': 'done',
        'totalRuntimeMs': 125000,
        'tokens': {'input': 100, 'output': 50},
      },
    ),
    expectedText: [
      'Run done - 2m 5s - Tokens: 100 input, 50 output',
      'turn-1',
    ],
  ),
  _TypedMessageFixture(
    caseName: 'file artifact',
    message: AgentMessage(
      type: AgentMessageType.fileArtifact,
      raw: {
        'type': 'file-artifact',
        'path': '/tmp/reports/report.md',
        'size': 1240,
      },
    ),
    expectedText: ['/tmp/reports/report.md'],
  ),
  _TypedMessageFixture(
    caseName: 'permission request',
    message: AgentMessage(
      type: AgentMessageType.permissionRequest,
      raw: {
        'type': 'permission-request',
        'permission': 'disk.write',
        'reason': 'Need to write output',
      },
    ),
    expectedText: ['disk.write', 'Need to write output'],
  ),
  _TypedMessageFixture(
    caseName: 'permission resolved externally',
    message: AgentMessage(
      type: AgentMessageType.permissionResolved,
      raw: {
        'type': 'permission-resolved',
        'requestId': 'perm-1',
        'decision': 'external',
      },
    ),
    expectedText: ['Resolved in another client.', 'external'],
  ),
  _TypedMessageFixture(
    caseName: 'question request',
    message: AgentMessage(
      type: AgentMessageType.questionRequest,
      raw: {
        'type': 'question-request',
        'question': 'Proceed with this step?',
      },
    ),
    expectedText: ['Proceed with this step?'],
  ),
  _TypedMessageFixture(
    caseName: 'goal state',
    message: AgentMessage(
      type: AgentMessageType.goalState,
      raw: {
        'type': 'goal-state',
        'title': 'Ship N stage',
        'status': 'active',
        'detail': 'Renderer catch-up',
        'elapsedMs': 61000,
      },
    ),
    expectedText: [
      'Goal active: Ship N stage',
      'Renderer catch-up',
      '1m 1s',
    ],
  ),
  _TypedMessageFixture(
    caseName: 'task list state',
    message: AgentMessage(
      type: AgentMessageType.taskListState,
      raw: {
        'type': 'task-list-state',
        'key': 'session',
        'title': 'Implementation tasks',
        'status': 'running',
        'items': [
          {
            'title': 'Review renderer gaps',
            'status': 'done',
            'priority': 'high',
          },
          {
            'title': 'Add typed renderers',
            'status': 'in-progress',
            'detail': 'N3 slice',
          },
          {'title': 'Run gates', 'status': 'open'},
        ],
      },
    ),
    expectedText: [
      'Implementation tasks running',
      '1 open',
      '1 in progress',
      '1 done',
      'Review renderer gaps - Done - high priority',
      'Add typed renderers - In progress - N3 slice',
    ],
  ),
  _TypedMessageFixture(
    caseName: 'agent activity',
    message: AgentMessage(
      type: AgentMessageType.agentActivity,
      raw: {
        'type': 'agent-activity',
        'kind': 'workflow',
        'title': 'Build index',
        'subtitle': 'phase two',
        'status': 'running',
        'elapsedMs': 62000,
        'agentsDone': 2,
        'agentsTotal': 8,
        'toolCalls': 5,
        'children': [
          {
            'title': 'Plan tests',
            'status': 'done',
            'phase': 'verify',
            'elapsedMs': 30000,
          },
        ],
      },
    ),
    expectedText: [
      'workflow running: Build index',
      'phase two',
      '2/8 agents',
      '5 tool calls',
      'Activity children',
      'Plan tests - Done - verify - 30s',
    ],
  ),
  _TypedMessageFixture(
    caseName: 'history reset',
    message: AgentMessage(
      type: AgentMessageType.historyReset,
      raw: {
        'type': 'history-reset',
        'notice': 'Reverted to an earlier message',
      },
    ),
    expectedText: [
      'Reverted to an earlier message',
    ],
  ),
  _TypedMessageFixture(
    caseName: 'error',
    message: AgentMessage(
      type: AgentMessageType.error,
      raw: {'type': 'error', 'code': 'E_TEST', 'message': 'Render failed'},
    ),
    expectedText: ['E_TEST', 'Render failed'],
  ),
];

Future<void> _pumpRenderer(
  WidgetTester tester,
  AgentMessage message, {
  Brightness brightness = Brightness.light,
  Locale? locale,
}) async {
  final tokens = brightness == Brightness.light
      ? softMinimalistTheme.light
      : softMinimalistTheme.dark;
  await tester.pumpWidget(
    MaterialApp(
      key: ValueKey(brightness),
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      locale: locale,
      theme: buildAppTheme(tokens, brightness).copyWith(
        splashFactory: InkRipple.splashFactory,
      ),
      home: Scaffold(
        body: Builder(
          builder: (context) => buildAgentMessageRenderer(
            context,
            message,
          ),
        ),
      ),
    ),
  );
}

Future<void> _pumpRendererAtWidth(
  WidgetTester tester,
  AgentMessage message, {
  required double width,
  ToolDisplayMode mode = ToolDisplayMode.responsive,
}) async {
  tester.view
    ..physicalSize = Size(width, 900)
    ..devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      theme: buildAppTheme(
        softMinimalistTheme.light,
        Brightness.light,
      ),
      home: ToolDisplayModeScope(
        mode: mode,
        child: Scaffold(
          body: SingleChildScrollView(
            child: Builder(
              builder: (context) => buildAgentMessageRenderer(context, message),
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pump();
}

class _TypedMessageFixture {
  const _TypedMessageFixture({
    required this.caseName,
    required this.message,
    required this.expectedText,
  });

  final String caseName;
  final AgentMessage message;
  final List<String> expectedText;
}
