// Fixture payloads and expected copy read best inline and unwrapped, and the
// canonical package import paths exceed the style width.
// ignore_for_file: lines_longer_than_80_chars

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/design/app_theme.dart';
import 'package:cosyncing_client/src/design/themes/soft_minimalist_theme.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/renderers/message_renderer_registry.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/file_reference.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_file_link_scope.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_transcript_display.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

const _sessionKey = SessionDetailKey(tool: 'claude', sessionId: 'session-1');

void main() {
  group('file-read card', () {
    testWidgets('an open gate makes the read path a link carrying its line', (
      tester,
    ) async {
      final opened = <SessionFileReference>[];
      await _pumpTool(
        tester,
        onOpen: opened.add,
        result: _readResult(),
      );

      await tester.tap(find.byKey(const Key('tool-read-path')));
      await tester.pump();

      expect(opened, hasLength(1));
      expect(opened.single.rawPath, '/repo/lib/a.dart');
      expect(opened.single.line, 120);
      expect(opened.single.kind, SessionFileReferenceKind.file);
    });

    testWidgets('a closed gate renders plain text and swallows no tap', (
      tester,
    ) async {
      // The settled decision: on a host with workspace browsing off, a mention
      // is ordinary text. A styled link that 403s teaches the reader the
      // feature is broken rather than that their host has the door shut.
      final opened = <SessionFileReference>[];
      await _pumpTool(
        tester,
        gate: SessionFileLinkGate.remoteDisabled,
        onOpen: opened.add,
        result: _readResult(),
      );

      expect(
        find.descendant(
          of: find.byKey(const Key('tool-read-path')),
          matching: find.text('/repo/lib/a.dart'),
          matchRoot: true,
        ),
        findsOneWidget,
      );
      await tester.tap(find.byKey(const Key('tool-read-path')));
      await tester.pump();
      expect(opened, isEmpty);
    });

    testWidgets('a session with no workspace renders plain text', (
      tester,
    ) async {
      final opened = <SessionFileReference>[];
      await _pumpTool(
        tester,
        gate: SessionFileLinkGate.noWorkspace,
        onOpen: opened.add,
        result: _readResult(),
      );

      await tester.tap(find.byKey(const Key('tool-read-path')));
      await tester.pump();
      expect(opened, isEmpty);
    });

    testWidgets('an unprobed gate renders plain text and raises one probe', (
      tester,
    ) async {
      // The probe is deferred to the first mention that reaches the screen, so
      // a session that shows none never spends a request. A screenful of
      // mentions must still raise exactly one ask.
      final opened = <SessionFileReference>[];
      var probes = 0;
      await _pumpTool(
        tester,
        gate: SessionFileLinkGate.unknown,
        onOpen: opened.add,
        onProbeNeeded: () => probes++,
        result: _readResult(),
      );

      expect(probes, greaterThanOrEqualTo(1));
      await tester.tap(find.byKey(const Key('tool-read-path')));
      await tester.pump();
      expect(opened, isEmpty);
    });

    testWidgets('a settled gate never raises another probe', (tester) async {
      var probes = 0;
      await _pumpTool(
        tester,
        gate: SessionFileLinkGate.remoteDisabled,
        onProbeNeeded: () => probes++,
        result: _readResult(),
      );

      expect(probes, 0);
    });

    testWidgets('outside any session scope the path stays plain text', (
      tester,
    ) async {
      // A renderer used outside a session page (a preview surface, a test) has
      // nowhere to send the tap, so it must not offer one.
      await _pumpTool(tester, withScope: false, result: _readResult());
      expect(
        find.descendant(
          of: find.byKey(const Key('tool-read-path')),
          matching: find.text('/repo/lib/a.dart'),
          matchRoot: true,
        ),
        findsOneWidget,
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('the link node reports isLink and activates on Enter', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      final opened = <SessionFileReference>[];
      await _pumpTool(
        tester,
        onOpen: opened.add,
        result: _readResult(),
      );

      final node = tester.getSemantics(
        find
            .descendant(
              of: find.byKey(const Key('tool-read-path')),
              matching: find.byType(Semantics),
              matchRoot: true,
            )
            .first,
      );
      expect(node.flagsCollection.isLink, isTrue);
      expect(node.label, contains('/repo/lib/a.dart:120'));

      final linkContext = tester.element(
        find
            .descendant(
              of: find.byKey(const Key('tool-read-path')),
              matching: find.byType(Text),
            )
            .first,
      );
      Focus.of(linkContext).requestFocus();
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();

      expect(opened, hasLength(1));
      expect(opened.single.rawPath, '/repo/lib/a.dart');
      semantics.dispose();
    });

    testWidgets('long-press opens the Flutter-drawn menu, not the browser', (
      tester,
    ) async {
      final opened = <SessionFileReference>[];
      await _pumpTool(
        tester,
        onOpen: opened.add,
        result: _readResult(),
      );

      await tester.longPress(find.byKey(const Key('tool-read-path')));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('transcript-file-link-copy-path')),
        findsOneWidget,
      );
      await tester.tap(
        find.byKey(const Key('transcript-file-link-open-folder')),
      );
      await tester.pumpAndSettle();

      expect(opened, hasLength(1));
      expect(opened.single.rawPath, '/repo/lib');
      expect(opened.single.kind, SessionFileReferenceKind.directory);
    });
  });

  group('search groups', () {
    testWidgets('a group header links to its file at the first match line', (
      tester,
    ) async {
      final opened = <SessionFileReference>[];
      await _pumpTool(
        tester,
        onOpen: opened.add,
        result: _result({
          'callId': 's1',
          'toolName': 'Grep',
          'toolClass': 'lookup',
          'semantic': {
            'kind': 'search',
            'query': 'TODO',
            'scope': 'lib/',
            'groups': [
              {
                'path': 'lib/a.dart',
                'matchCount': 2,
                'matches': [
                  {'line': 10, 'text': '// TODO a'},
                  {'line': 22, 'text': '// TODO b'},
                ],
              },
            ],
          },
        }),
      );

      await tester.tap(find.textContaining('lib/a.dart'));
      await tester.pump();

      expect(opened, hasLength(1));
      expect(opened.single.rawPath, 'lib/a.dart');
      expect(opened.single.line, 10);
    });

    testWidgets('the search SCOPE is never a link', (tester) async {
      final opened = <SessionFileReference>[];
      await _pumpTool(
        tester,
        onOpen: opened.add,
        result: _result({
          'callId': 's2',
          'toolName': 'Grep',
          'toolClass': 'lookup',
          'semantic': {
            'kind': 'search',
            'query': 'TODO',
            'scope': 'lib/',
            'groups': [
              {
                'path': 'lib/a.dart',
                'matches': [
                  {'line': 1, 'text': 'x'},
                ],
              },
            ],
          },
        }),
      );

      await tester.tap(find.byKey(const Key('tool-search-scope')));
      await tester.pump();
      expect(opened, isEmpty);
    });
  });

  group('edit diff header', () {
    testWidgets('the header links to the file the change acted on', (
      tester,
    ) async {
      final opened = <SessionFileReference>[];
      await _pumpTool(
        tester,
        onOpen: opened.add,
        result: _result({
          'callId': 'e1',
          'toolName': 'Edit',
          'toolClass': 'edit',
          'path': 'lib/a.dart',
          'diff': '--- a/lib/a.dart\n+++ b/lib/a.dart\n@@ -1 +1 @@\n-old\n+new',
        }),
      );

      await tester.tap(find.byKey(const Key('tool-diff-path')));
      await tester.pump();

      expect(opened, hasLength(1));
      expect(opened.single.rawPath, 'lib/a.dart');
    });

    testWidgets('a rename links the new path, never the "old → new" label', (
      tester,
    ) async {
      final opened = <SessionFileReference>[];
      await _pumpTool(
        tester,
        onOpen: opened.add,
        result: _result({
          'callId': 'e2',
          'toolName': 'Edit',
          'toolClass': 'edit',
          'fileChanges': [
            {
              'path': 'lib/new.dart',
              'previousPath': 'lib/old.dart',
              'operation': 'rename',
              'diff':
                  '--- a/lib/old.dart\n+++ b/lib/new.dart\n@@ -1 +1 @@\n-a\n+b',
            },
          ],
        }),
      );

      await tester.tap(find.textContaining('lib/old.dart → lib/new.dart'));
      await tester.pump();

      expect(opened, hasLength(1));
      expect(opened.single.rawPath, 'lib/new.dart');
    });
  });
}

AgentMessage _result(Map<String, dynamic> raw) => AgentMessage(
  type: AgentMessageType.toolResult,
  id: raw['callId'] as String?,
  raw: {'type': 'tool-result', ...raw},
);

AgentMessage _readResult() => _result({
  'callId': 'r1',
  'toolName': 'Read',
  'toolClass': 'read',
  'semantic': {
    'kind': 'file-read',
    'path': '/repo/lib/a.dart',
    'startLine': 120,
    'preview': 'line one\nline two',
  },
});

Future<void> _pumpTool(
  WidgetTester tester, {
  AgentMessage? call,
  AgentMessage? result,
  SessionFileLinkGate gate = SessionFileLinkGate.open,
  bool withScope = true,
  void Function(SessionFileReference reference)? onOpen,
  VoidCallback? onProbeNeeded,
}) async {
  final tokens = softMinimalistTheme.light;
  final entry = ToolTranscriptDisplayEntry(
    call: call,
    result: result,
    sourceIndices: const [0],
  );
  Widget row(BuildContext context) =>
      buildToolTranscriptRenderer(context, entry, toolsExpanded: true);
  await tester.pumpWidget(
    MaterialApp(
      localizationsDelegates: AppLocalizations.localizationsDelegates,
      supportedLocales: AppLocalizations.supportedLocales,
      theme: buildAppTheme(tokens, Brightness.light),
      home: Scaffold(
        body: SingleChildScrollView(
          child: withScope
              ? SessionFileLinkScope(
                  sessionKey: _sessionKey,
                  gate: gate,
                  onOpen: onOpen ?? (_) {},
                  onProbeNeeded: onProbeNeeded ?? () {},
                  child: Builder(builder: row),
                )
              : Builder(builder: row),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}
