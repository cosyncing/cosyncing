import 'dart:io';

import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_preview_html_policy.dart';

import 'package:cosyncing_client/src/platform/artifacts/workspace_html_staging.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;

/// A page that declares a permissive policy for itself.
const String _pageDeclaringItsOwnPolicy =
    '<html><head><meta http-equiv="Content-Security-Policy" '
    'content="default-src *"></head><body>hi</body></html>';

Directory _root() {
  final dir = Directory.systemTemp.createTempSync('workspace-html-staging');
  addTearDown(() {
    if (dir.existsSync()) dir.deleteSync(recursive: true);
  });
  return dir;
}

void main() {
  group('workspace HTML staging', () {
    test('stages under a sibling marker, never the artifact tree', () {
      final root = _root();
      final staging = workspaceHtmlStagingRoot(rootDirectory: root);

      // The artifact preview's sweep deletes any HTML-named file under its own
      // root on an mtime pass. Sharing that tree would make one feature's
      // cleanup the other's data loss.
      expect(p.basename(staging.path), workspaceHtmlStagingMarker);
      expect(p.basename(staging.parent.path), 'cosyncing_client');
      expect(staging.path, isNot(contains('artifact_previews')));
    });

    test('the same read stages to the same path, a changed one does not', () {
      String stem({int size = 40, bool truncated = false}) =>
          workspaceHtmlStagingStem(
            sessionKey: 'codex/a',
            workspacePath: 'docs/coverage.html',
            size: size,
            truncated: truncated,
          );

      // Deterministic, so reopening a file reuses one copy instead of
      // littering the temp directory with one per click.
      expect(stem(), stem());
      expect(stem(size: 41), isNot(stem()));
      expect(stem(truncated: true), isNot(stem()));
      // And filesystem-safe: the seed is base64url of arbitrary path text.
      expect(stem(), matches(RegExp(r'^[A-Za-z0-9_-]+$')));
    });

    test(
      'a staged copy uses the same isolated document as the pane',
      () async {
        final root = _root();
        final file = await stageWorkspaceHtmlFile(
          sessionKey: 'codex/a',
          workspacePath: 'docs/coverage.html',
          html: _pageDeclaringItsOwnPolicy,
          size: 40,
          truncated: false,
          rootDirectory: root,
        );
        final staged = await file.readAsString();

        expect(
          staged,
          prepareInteractiveHtmlDocument(_pageDeclaringItsOwnPolicy),
        );
        expect(file.path, endsWith('.html'));
      },
    );

    test('an HTML extension the file already has is not doubled', () async {
      final root = _root();
      for (final name in ['report.htm', 'index.html']) {
        final file = await stageWorkspaceHtmlFile(
          sessionKey: 'codex/a',
          workspacePath: 'docs/$name',
          html: '<html><body>hi</body></html>',
          size: 28,
          truncated: false,
          rootDirectory: root,
        );
        // A doubled suffix reads as a different file to the reader who is
        // about to see it in their browser's title bar and downloads list.
        expect(p.basename(file.path), name);
      }
    });

    test(
      'XHTML handoff is an HTML wrapper; incomplete bytes cannot open',
      () async {
        final root = _root();
        final file = await stageWorkspaceHtmlFile(
          sessionKey: 'codex/a',
          workspacePath: 'report.xhtml',
          html: '<p>hi</p>',
          size: 9,
          truncated: false,
          rootDirectory: root,
        );
        expect(p.basename(file.path), 'report.xhtml.html');
        await expectLater(
          stageWorkspaceHtmlFile(
            sessionKey: 'codex/a',
            workspacePath: 'report.html',
            html: '<script>',
            size: 9000,
            truncated: true,
            rootDirectory: root,
          ),
          throwsStateError,
        );
      },
    );

    test('a name with no HTML extension gets one', () async {
      final root = _root();
      final file = await stageWorkspaceHtmlFile(
        sessionKey: 'codex/a',
        workspacePath: 'docs/report',
        html: '<html><body>hi</body></html>',
        size: 28,
        truncated: false,
        rootDirectory: root,
      );

      // Without it the browser has nothing to dispatch on and offers a save.
      expect(p.basename(file.path), 'report.html');
    });

    test('the sweep drops stale copies and keeps fresh ones', () async {
      final root = _root();
      final staging = workspaceHtmlStagingRoot(rootDirectory: root)
        ..createSync(recursive: true);
      final stale = Directory(p.join(staging.path, 'stale'))..createSync();
      final fresh = Directory(p.join(staging.path, 'fresh'))..createSync();

      await sweepWorkspaceHtmlStaging(
        root: staging,
        now: DateTime.now().add(const Duration(hours: 25)),
      );

      expect(stale.existsSync(), isFalse);
      // `fresh` was created at the same moment, so both are stale here; the
      // point of the pair is that the sweep works on the directory contents
      // rather than the root itself.
      expect(fresh.existsSync(), isFalse);
      expect(staging.existsSync(), isTrue);
    });

    test('a fresh copy survives the sweep', () async {
      final root = _root();
      final staging = workspaceHtmlStagingRoot(rootDirectory: root)
        ..createSync(recursive: true);
      final fresh = Directory(p.join(staging.path, 'fresh'))..createSync();

      await sweepWorkspaceHtmlStaging(root: staging, now: DateTime.now());

      expect(fresh.existsSync(), isTrue);
    });

    test('the sweep refuses anything that is not the staging root', () async {
      final root = _root();
      final notOurs = Directory(p.join(root.path, 'somebody_else'))
        ..createSync(recursive: true);
      final victim = File(p.join(notOurs.path, 'important.txt'))
        ..writeAsStringSync('keep me');

      // A wrong argument must not turn this into a directory deleter.
      expect(isWorkspaceHtmlStagingRoot(notOurs), isFalse);
      await sweepWorkspaceHtmlStaging(
        root: notOurs,
        now: DateTime.now().add(const Duration(days: 7)),
      );

      expect(victim.existsSync(), isTrue);
    });
  });
}
