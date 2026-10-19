// Fixture payloads and expected copy read best inline and unwrapped, and the
// canonical package import paths exceed the style width.
// ignore_for_file: lines_longer_than_80_chars

import 'package:broker_contract/broker_contract.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import '../../../../support/session_detail_page_test_harness.dart';

void main() {
  group('transcript file links, end to end', () {
    // Both standalone and routed sessions use the shared narrow reader.
    testWidgets(
      'with no route to push, a read path opens the Files view, anchored',
      (tester) async {
        final brokerClient = _client()
          ..fsListingsByPath[''] = _directory(
            '',
            entries: const [
              FsDirEntry(
                name: 'a.md',
                path: 'lib/a.md',
                type: 'file',
                size: 40,
                mtimeMs: 0,
              ),
            ],
          )
          ..fsListingsByPath['/repo/lib/a.md'] = _file('lib/a.md')
          ..fsListingsByPath['lib'] = _directory(
            'lib',
            entries: const [
              FsDirEntry(
                name: 'a.md',
                path: 'lib/a.md',
                type: 'file',
                size: 40,
                mtimeMs: 0,
              ),
            ],
          )
          ..fsReadResult = FsReadResult(
            path: 'lib/a.md',
            size: 40,
            limit: 1024 * 1024,
            truncated: false,
            encoding: 'utf8',
            data: [
              'alpha',
              'beta',
              'gamma',
              'delta',
              for (var i = 0; i < 100; i++) '# Review section $i',
            ].join('\n'),
            mimeType: 'text/markdown',
          );

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [_readRow],
            brokerClient: brokerClient,
          ),
        );
        await tester.pumpAndSettle();

        // The gate probe runs once on attach, so the mention is already a link
        // before the reader ever opens the Files view.
        await tester.tap(find.byKey(const Key('tool-r1-details')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('tool-read-path')));
        await tester.pumpAndSettle();

        // The absolute path went to the broker verbatim; the read used the
        // workspace-relative spelling the broker resolved it to.
        expect(brokerClient.fsListedPaths, contains('/repo/lib/a.md'));
        expect(brokerClient.fsReadPaths, ['lib/a.md']);

        // The view switched, and the viewer opened on the anchored line with a
        // numbered gutter rather than one undifferentiated blob of text.
        expect(
          find.byKey(const Key('compact-manage-files')),
          findsOneWidget,
        );
        // A pane, not a popup. The dialog is gone and must not come back.
        expect(find.byType(AlertDialog), findsNothing);
        expect(find.byKey(const Key('file-viewer-pane')), findsOneWidget);
        // The anchor is carried by the gutter alone — an accent line number
        // and a 2dp accent edge, with no wash behind the code.
        expect(
          find.byKey(const Key('file-viewer-anchor-number')),
          findsOneWidget,
        );
        expect(
          find.byKey(const Key('file-viewer-anchor-edge')),
          findsOneWidget,
        );
        expect(find.text('gamma'), findsOneWidget);
        expect(find.text('3'), findsOneWidget);

        final source = find.byKey(const Key('file-viewer-lines'));
        final anchoredOffset = tester
            .widget<ListView>(source)
            .controller!
            .offset;
        await tester.drag(source, const Offset(0, -300));
        await tester.pumpAndSettle();
        final sourceOffset = tester.widget<ListView>(source).controller!.offset;
        expect(sourceOffset, greaterThan(anchoredOffset));
        await tester.tap(find.text('Chat').first);
        await tester.pumpAndSettle();
        await tester.tap(find.text('a.md').first);
        await tester.pumpAndSettle();
        expect(
          tester.widget<ListView>(source).controller!.offset,
          closeTo(sourceOffset, 2),
        );
        await tester.tap(find.byKey(const Key('file-viewer-mode-rendered')));
        await tester.pumpAndSettle();
        final rendered = find.byKey(const Key('file-viewer-rendered'));
        await tester.drag(rendered, const Offset(0, -200));
        await tester.pumpAndSettle();
        final renderedOffset = tester
            .widget<ListView>(rendered)
            .controller!
            .offset;
        await tester.tap(find.text('Chat').first);
        await tester.pumpAndSettle();
        await tester.tap(find.text('a.md').first);
        await tester.pumpAndSettle();
        expect(
          tester.widget<ListView>(rendered).controller!.offset,
          closeTo(renderedOffset, 2),
        );

        // A new click on the same line is a fresh navigation request.
        await tester.tap(find.text('Chat').first);
        await tester.pumpAndSettle();
        if (find.byKey(const Key('tool-read-path')).evaluate().isEmpty) {
          await tester.tap(find.byKey(const Key('tool-r1-details')));
          await tester.pumpAndSettle();
        }
        await tester.tap(find.byKey(const Key('tool-read-path')));
        await tester.pumpAndSettle();
        expect(
          tester.widget<ListView>(source).controller!.offset,
          closeTo(anchoredOffset, 2),
        );
        // Ordinary browser opening restores the explicit rendered preference.
        await openSessionDetailTestTab(tester, 'session-detail-tab-files');
        await tester.tap(
          find.byKey(const Key('session-detail-files-preview-lib/a.md')),
        );
        await tester.pumpAndSettle();
        expect(
          tester.widget<ListView>(rendered).controller!.offset,
          closeTo(renderedOffset, 2),
        );
      },
    );

    testWidgets('a routed session opens the shared reader, carrying its line', (
      tester,
    ) async {
      final brokerClient = _client()
        ..fsListingsByPath[''] = _directory('')
        ..fsListingsByPath['/repo/lib/a.md'] = _file('lib/a.md')
        ..fsReadResult = const FsReadResult(
          path: 'lib/a.md',
          size: 40,
          limit: 1024 * 1024,
          truncated: false,
          encoding: 'utf8',
          data: 'alpha\nbeta\ngamma\ndelta',
          mimeType: 'text/plain',
        );

      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [_readRow],
          brokerClient: brokerClient,
          withRouter: true,
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('tool-r1-details')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('tool-read-path')));
      await tester.pumpAndSettle();

      // Route availability does not create a second reader or lose the line.
      expect(find.byKey(const Key('file-viewer-pane')), findsOneWidget);
      expect(
        find.byKey(const Key('file-viewer-anchor-number')),
        findsOneWidget,
      );
      expect(find.byKey(const Key('compact-manage-files')), findsOneWidget);
      expect(brokerClient.fsReadPaths, ['lib/a.md']);
      // And the Files slot is not left holding a second copy of the same file
      // for the reader to find on Back.
      expect(
        find.byKey(const Key('session-detail-tab-panel-files')),
        findsNothing,
      );
    });

    testWidgets('a line past a truncated read says so, never lands on line 1', (
      tester,
    ) async {
      final brokerClient = _client()
        ..fsListingsByPath[''] = _directory('')
        ..fsListingsByPath['/repo/lib/a.md'] = _file('lib/a.md')
        ..fsReadResult = const FsReadResult(
          path: 'lib/a.md',
          size: 4000000,
          limit: 1048576,
          truncated: true,
          encoding: 'utf8',
          data: 'alpha\nbeta',
          mimeType: 'text/plain',
        );

      await tester.pumpWidget(
        buildSessionDetailTestPage(
          events: const [
            MessageWireEvent(
              seq: 1,
              message: AgentMessage(
                type: AgentMessageType.toolResult,
                raw: {
                  'type': 'tool-result',
                  'callId': 'r1',
                  'toolName': 'Read',
                  'toolClass': 'read',
                  'semantic': {
                    'kind': 'file-read',
                    'path': '/repo/lib/a.md',
                    'startLine': 4120,
                    'preview': 'x',
                  },
                },
              ),
            ),
          ],
          brokerClient: brokerClient,
        ),
      );
      await tester.pumpAndSettle();

      await tester.tap(find.byKey(const Key('tool-r1-details')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const Key('tool-read-path')));
      await tester.pumpAndSettle();

      expect(
        find.byKey(const Key('file-viewer-anchor-beyond')),
        findsOneWidget,
      );
      expect(
        find.text('Line 4120 is beyond the 2 lines this preview covers.'),
        findsOneWidget,
      );
    });

    testWidgets(
      'a closed gate keeps every mention plain and explains itself once',
      (tester) async {
        // The default host: `features.httpWorkspaceBrowsing` off, so every fs
        // request is refused for every client. Nothing may render as a link,
        // and the reason is stated exactly once, in the Files surface.
        final brokerClient = _client()
          ..fsListError = const BrokerException(
            message: 'Request failed',
            statusCode: 403,
            error: BrokerError(
              error: 'Remote file access is disabled',
              code: 'FS_REMOTE_DISABLED',
            ),
          );

        await tester.pumpWidget(
          buildSessionDetailTestPage(
            events: const [_readRow],
            brokerClient: brokerClient,
          ),
        );
        await tester.pumpAndSettle();

        await tester.tap(find.byKey(const Key('tool-r1-details')));
        await tester.pumpAndSettle();
        await tester.tap(find.byKey(const Key('tool-read-path')));
        await tester.pumpAndSettle();

        // The tap did nothing: no view switch, no dialog, no error toast.
        expect(
          find.byKey(const Key('session-detail-tab-panel-files')),
          findsNothing,
        );
        expect(find.byType(AlertDialog), findsNothing);
        expect(brokerClient.fsReadPaths, isEmpty);

        await openSessionDetailTestTab(tester, 'session-detail-tab-files');
        await tester.pumpAndSettle();

        expect(
          find.byKey(const Key('session-detail-files-links-off')),
          findsOneWidget,
        );
      },
    );
  });
}

const MessageWireEvent _readRow = MessageWireEvent(
  seq: 1,
  message: AgentMessage(
    type: AgentMessageType.toolResult,
    raw: {
      'type': 'tool-result',
      'callId': 'r1',
      'toolName': 'Read',
      'toolClass': 'read',
      'semantic': {
        'kind': 'file-read',
        'path': '/repo/lib/a.md',
        'startLine': 3,
        'preview': 'gamma',
      },
    },
  ),
);

FakeBrokerClient _client() => FakeBrokerClient();

FsDirectoryResult _directory(
  String path, {
  List<FsDirEntry> entries = const [],
}) => FsDirectoryResult(
  path: path,
  stat: FsNodeInfo(
    path: path,
    type: 'directory',
    size: 0,
    mtimeMs: 0,
    isDirectory: true,
    isRegularFile: false,
    isSymbolicLink: false,
  ),
  entries: entries,
);

FsDirectoryResult _file(String path) => FsDirectoryResult(
  path: path,
  stat: FsNodeInfo(
    path: path,
    type: 'file',
    size: 40,
    mtimeMs: 0,
    isDirectory: false,
    isRegularFile: true,
    isSymbolicLink: false,
  ),
  entries: const [],
);
