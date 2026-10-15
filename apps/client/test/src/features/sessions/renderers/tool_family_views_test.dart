// Fixture payloads and expected copy read best inline and unwrapped, and the
// canonical package import paths exceed the style width.
// ignore_for_file: lines_longer_than_80_chars

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/soft_minimalist_theme.dart';
import 'package:cosyncing_client/src/features/sessions/renderers/message_renderer_registry.dart';
// The canonical renderer imports keep their stable package paths for
// boundary-safe package import resolution.
import 'package:cosyncing_client/src/features/sessions/transcript/session_transcript_display.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('command family', () {
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
  });

  group('search family', () {
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
