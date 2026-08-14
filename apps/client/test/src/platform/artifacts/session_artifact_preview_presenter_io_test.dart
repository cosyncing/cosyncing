import 'dart:io';

import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_file_service.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_preview_result.dart';
import 'package:cosyncing_client/src/platform/artifacts/session_artifact_preview_presenter_io.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as path;

void main() {
  group('prepareSessionArtifactPreviewFilePath', () {
    late Directory tempDir;

    setUp(() {
      tempDir = Directory.systemTemp.createTempSync(
        'session-artifact-preview-test',
      );
    });

    tearDown(() {
      if (tempDir.existsSync()) {
        tempDir.deleteSync(recursive: true);
      }
    });

    test('creates a hardened preview copy for HTML artifacts', () async {
      final sourcePath = '${tempDir.path}/report.html';
      await File(sourcePath).writeAsString(
        '''
<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body><a href="report.html" target="" download="">download</a><iframe TARGET=_self Download>frame</iframe></body></html>
''',
      );
      final artifact = _fakeCachedFile(
        sourcePath,
      );

      final preparedPath = await prepareSessionArtifactPreviewFilePath(
        artifact: artifact,
        rootDirectory: tempDir,
      );

      final expectedDirectory = sessionArtifactPreviewScopedDirectory(
        artifact: artifact,
        rootDirectory: tempDir,
      );
      expect(
        preparedPath,
        startsWith(expectedDirectory.path + path.separator),
      );
      expect(path.dirname(preparedPath), equals(expectedDirectory.path));
      expect(expectedDirectory.existsSync(), isTrue);
      final hardened = await File(preparedPath).readAsString();
      expect(
        hardened,
        contains(
          "default-src 'none'; script-src 'none'; form-action 'none'; "
          "object-src 'none';",
        ),
      );
      expect(hardened, isNot(contains('content="default-src *"')));
      expect(hardened, isNot(contains('target=""')));
      expect(hardened, isNot(contains('TARGET=_self')));
      expect(hardened, isNot(contains('download=""')));
      expect(hardened, isNot(contains('Download>frame')));
      expect(hardened, isNot(contains('TARGET=_self Download>')));
      expect(hardened, contains('href="report.html"'));
    });

    test(
      'cleans stale preview directories/files before creating fresh copies',
      () async {
        final staleArtifact = _fakeCachedFile(
          '${tempDir.path}/report-stale.html',
          fileName: 'report-stale.html',
          artifactKey: 'stale',
        );
        final freshArtifact = _fakeCachedFile(
          '${tempDir.path}/report-fresh.html',
          fileName: 'report-fresh.html',
          artifactKey: 'fresh',
        );
        final activeArtifact = _fakeCachedFile(
          '${tempDir.path}/report.html',
          fileName: 'report.html',
        );
        final root = sessionArtifactPreviewTempRootDirectory(
          rootDirectory: tempDir,
        );
        await root.create(recursive: true);
        final staleDirectory = sessionArtifactPreviewScopedDirectory(
          artifact: staleArtifact,
          previewRootDirectory: root,
        );
        final freshDirectory = sessionArtifactPreviewScopedDirectory(
          artifact: freshArtifact,
          previewRootDirectory: root,
        );
        await staleDirectory.create(recursive: true);
        await freshDirectory.create(recursive: true);
        final legacyStaleFile = File(path.join(root.path, 'legacy.html'));
        final unrelatedFile = File(path.join(root.path, 'notes.txt'));
        await File(
          path.join(staleDirectory.path, 'old.html'),
        ).writeAsString('old');
        await File(
          path.join(freshDirectory.path, 'fresh.html'),
        ).writeAsString('fresh');
        await legacyStaleFile.writeAsString('legacy');
        await unrelatedFile.writeAsString('plain text');

        final staleMoment = DateTime(2026, 7, 3, 8);
        final freshMoment = DateTime(2026, 7, 3, 11, 59);
        await File(path.join(staleDirectory.path, 'old.html')).setLastModified(
          staleMoment,
        );
        await File(
          path.join(freshDirectory.path, 'fresh.html'),
        ).setLastModified(
          freshMoment,
        );
        await legacyStaleFile.setLastModified(staleMoment);
        await unrelatedFile.setLastModified(staleMoment);

        await File(activeArtifact.cachedFilePath).writeAsString(
          '<html><body>ok</body></html>',
        );
        final preparedPath = await prepareSessionArtifactPreviewFilePath(
          artifact: activeArtifact,
          rootDirectory: tempDir,
          now: DateTime(2026, 7, 3, 12),
          staleRetention: const Duration(hours: 1),
        );

        expect(
          staleDirectory.existsSync(),
          isFalse,
        );
        expect(
          File(path.join(staleDirectory.path, 'old.html')).existsSync(),
          isFalse,
        );
        expect(freshDirectory.existsSync(), isTrue);
        expect(
          File(path.join(freshDirectory.path, 'fresh.html')).existsSync(),
          isTrue,
        );
        expect(legacyStaleFile.existsSync(), isFalse);
        expect(unrelatedFile.existsSync(), isTrue);
        expect(preparedPath, isNot(equals(activeArtifact.cachedFilePath)));
      },
    );

    test(
      'cleanup does not touch non-preview/source directories outside preview root',
      () async {
        final sourceDirectory = Directory(
          path.join(tempDir.path, 'cached_artifacts'),
        );
        await sourceDirectory.create(recursive: true);
        final sourceFile = File(path.join(sourceDirectory.path, 'report.html'));
        await sourceFile.writeAsString('source artifact');

        await cleanupSessionArtifactPreviewTempStorage(
          rootDirectory: tempDir,
        );

        expect(sourceDirectory.existsSync(), isTrue);
        expect(sourceFile.existsSync(), isTrue);
      },
    );

    test('returns the original cached path for non-HTML artifacts', () async {
      final sourcePath = '${tempDir.path}/notes.txt';
      await File(sourcePath).writeAsString('plain text');
      final artifact = _fakeCachedFile(
        sourcePath,
        fileName: 'notes.txt',
        contentType: 'text/plain',
      );

      final preparedPath = await prepareSessionArtifactPreviewFilePath(
        artifact: artifact,
        rootDirectory: tempDir,
      );

      expect(preparedPath, equals(sourcePath));
    });

    test('builds deterministic preview file names from artifact metadata', () {
      final artifactA = _fakeCachedFile(
        '${tempDir.path}/a.html',
        fileName: 'Report.HTML',
        artifactKey: 'artifact-key',
        contentHash: 'hash-value',
      );
      final artifactB = _fakeCachedFile(
        '${tempDir.path}/b.html',
        fileName: 'Report.HTML',
        artifactKey: 'artifact-key',
        contentHash: 'hash-value',
      );

      expect(
        buildSessionArtifactPreviewFileName(artifact: artifactA),
        equals(buildSessionArtifactPreviewFileName(artifact: artifactB)),
      );
      expect(
        buildSessionArtifactPreviewFileName(artifact: artifactA),
        endsWith('.html'),
      );
    });
  });

  group('evaluateDesktopPreviewLaunchCandidate', () {
    late Directory tempDir;

    setUp(() {
      tempDir = Directory.systemTemp.createTempSync(
        'session-artifact-desktop-preview-eval-test',
      );
    });

    tearDown(() {
      if (tempDir.existsSync()) {
        tempDir.deleteSync(recursive: true);
      }
    });

    test('allows the exact prepared local file launch URI', () {
      final preparedFile = '${tempDir.path}/report.html';
      final allowedLocalFileUri = Uri.file(preparedFile);

      final decision = evaluateDesktopPreviewLaunchCandidate(
        allowedLocalFileUri.toString(),
        allowedLocalFileUri: allowedLocalFileUri,
      );

      expect(decision.isAllowed, isTrue);
      expect(decision.result, isNull);
    });

    test('blocks external http URLs by policy classification', () {
      final allowedLocalFileUri = Uri.file('${tempDir.path}/report.html');
      const cases = <Map<String, dynamic>>[
        {
          'url': 'https://example.com/report.html',
          'reason': SessionArtifactPreviewNavigationBlockReason.externalScheme,
        },
        {
          'url': 'https://example.com/report.zip',
          'reason': SessionArtifactPreviewNavigationBlockReason.downloadLike,
        },
      ];

      for (final testCase in cases) {
        final decision = evaluateDesktopPreviewLaunchCandidate(
          testCase['url'] as String,
          allowedLocalFileUri: allowedLocalFileUri,
        );

        expect(decision.isAllowed, isFalse);
        expect(
          decision.result?.status,
          SessionArtifactPreviewPresentationStatus.blockedNavigation,
        );
        expect(decision.result?.blockReason, testCase['reason']);
      }
    });

    test('blocks different local files as localFileDisallowed', () {
      final allowedLocalFileUri = Uri.file('${tempDir.path}/report.html');
      final blockedLocalFileUri = Uri.file('${tempDir.path}/sibling.html');

      final decision = evaluateDesktopPreviewLaunchCandidate(
        blockedLocalFileUri.toString(),
        allowedLocalFileUri: allowedLocalFileUri,
      );

      expect(decision.isAllowed, isFalse);
      expect(
        decision.result?.blockReason,
        SessionArtifactPreviewNavigationBlockReason.localFileDisallowed,
      );
      expect(
        decision.result?.message,
        contains('local file disallowed'),
      );
    });

    test(
      'prevents blocked desktop launch before any launch surface is used',
      () {
        final allowedLocalFileUri = Uri.file('${tempDir.path}/report.html');
        const blockedCandidate = 'https://example.com/unexpected-landing.html';

        final decision = evaluateDesktopPreviewLaunchCandidate(
          blockedCandidate,
          allowedLocalFileUri: allowedLocalFileUri,
        );

        expect(decision.isAllowed, isFalse);
        expect(
          decision.result?.status,
          SessionArtifactPreviewPresentationStatus.blockedNavigation,
        );
        expect(decision.result?.uri, Uri.parse(blockedCandidate));
      },
    );
  });

  group('openArtifactPreviewUriInBrowser', () {
    const blockedUri = 'https://example.com/report.html';

    test('returns external-open fallback when launcher accepts URI', () async {
      final result = await openArtifactPreviewUriInBrowser(
        Uri.parse(blockedUri),
        uriLauncher: _FakeArtifactUriLauncher(success: true),
      );

      expect(
        result.status,
        SessionArtifactPreviewPresentationStatus.externalOpenFallback,
      );
      expect(result.uri, Uri.parse(blockedUri));
      expect(result.message, contains('Open in browser fallback requested'));
    });

    test('returns external-open failed when launcher rejects URI', () async {
      final result = await openArtifactPreviewUriInBrowser(
        Uri.parse(blockedUri),
        uriLauncher: _FakeArtifactUriLauncher(
          success: false,
          errorMessage: 'blocked by policy',
        ),
      );

      expect(
        result.status,
        SessionArtifactPreviewPresentationStatus.externalOpenFailed,
      );
      expect(result.uri, Uri.parse(blockedUri));
      expect(
        result.message,
        "Couldn't open the preview in your browser. Try again.",
      );
      expect(result.message, isNot(contains('blocked by policy')));
      expect(result.technicalDetail, 'blocked by policy');
    });
  });

  group('openDesktopPreviewFallbackInBrowser', () {
    late Directory tempDir;

    setUp(() {
      tempDir = Directory.systemTemp.createTempSync(
        'session-artifact-desktop-preview-fallback-test',
      );
    });

    tearDown(() {
      if (tempDir.existsSync()) {
        tempDir.deleteSync(recursive: true);
      }
    });

    test(
      'opens only policy-allowed candidate URIs through the launcher',
      () async {
        final allowedLocalFileUri = Uri.file('${tempDir.path}/report.html');
        final allowedLauncher = _FakeArtifactUriLauncher(success: true);
        final result = await openDesktopPreviewFallbackInBrowser(
          launchCandidateUri: allowedLocalFileUri,
          allowedLocalFileUri: allowedLocalFileUri,
          uriLauncher: allowedLauncher,
        );

        expect(
          result.status,
          SessionArtifactPreviewPresentationStatus.externalOpenFallback,
        );
        expect(allowedLauncher.launchCount, equals(1));
        expect(allowedLauncher.launchedUris, equals([allowedLocalFileUri]));
        expect(result.uri, equals(allowedLocalFileUri));
      },
    );

    test('does not launch disallowed candidate URIs', () async {
      final allowedLocalFileUri = Uri.file('${tempDir.path}/report.html');
      final blockedLauncher = _FakeArtifactUriLauncher(success: true);
      final result = await openDesktopPreviewFallbackInBrowser(
        launchCandidateUri: Uri.parse('https://example.com/report.html'),
        allowedLocalFileUri: allowedLocalFileUri,
        uriLauncher: blockedLauncher,
      );

      expect(
        result.status,
        equals(SessionArtifactPreviewPresentationStatus.blockedNavigation),
      );
      expect(
        result.blockReason,
        equals(SessionArtifactPreviewNavigationBlockReason.externalScheme),
      );
      expect(blockedLauncher.launchCount, equals(0));
      expect(blockedLauncher.launchedUris, isEmpty);
    });

    test(
      'returns external-open failed when policy-allowed launch fails',
      () async {
        final allowedLocalFileUri = Uri.file('${tempDir.path}/report.html');
        final failingLauncher = _FakeArtifactUriLauncher(
          success: false,
          errorMessage: 'launcher failed',
        );

        final result = await openDesktopPreviewFallbackInBrowser(
          launchCandidateUri: allowedLocalFileUri,
          allowedLocalFileUri: allowedLocalFileUri,
          uriLauncher: failingLauncher,
        );

        expect(
          result.status,
          SessionArtifactPreviewPresentationStatus.externalOpenFailed,
        );
        expect(result.uri, equals(allowedLocalFileUri));
        expect(result.message, isNot(contains('launcher failed')));
        expect(result.technicalDetail, 'launcher failed');
        expect(failingLauncher.launchCount, equals(1));
      },
    );
  });

  group('desktop webview URL-request guard', () {
    late Directory tempDir;

    setUp(() {
      tempDir = Directory.systemTemp.createTempSync(
        'session-artifact-desktop-preview-guard-test',
      );
    });

    tearDown(() {
      if (tempDir.existsSync()) {
        tempDir.deleteSync(recursive: true);
      }
    });

    test('allows exact prepared local file requests through callback', () {
      final allowedLocalFileUri = Uri.file('${tempDir.path}/preview.html');
      final fakeWebview = _FakeSessionArtifactDesktopWebview();

      installSessionArtifactPreviewUrlRequestGuard(
        webview: fakeWebview,
        allowedLocalFileUri: allowedLocalFileUri,
      );

      expect(
        fakeWebview.allowanceForRequest(allowedLocalFileUri.toString()),
        isTrue,
      );
      expect(fakeWebview.events, contains('callback-installed'));
    });

    test('blocks external http URLs through callback policy', () {
      final allowedLocalFileUri = Uri.file('${tempDir.path}/preview.html');
      final fakeWebview = _FakeSessionArtifactDesktopWebview();

      installSessionArtifactPreviewUrlRequestGuard(
        webview: fakeWebview,
        allowedLocalFileUri: allowedLocalFileUri,
      );

      expect(
        fakeWebview.allowanceForRequest('https://example.com/report.html'),
        isFalse,
      );
    });

    test('blocks download-like URLs through callback policy', () {
      final allowedLocalFileUri = Uri.file('${tempDir.path}/preview.html');
      final fakeWebview = _FakeSessionArtifactDesktopWebview();

      installSessionArtifactPreviewUrlRequestGuard(
        webview: fakeWebview,
        allowedLocalFileUri: allowedLocalFileUri,
      );

      expect(
        fakeWebview.allowanceForRequest('https://example.com/report.zip'),
        isFalse,
      );
    });

    test('blocks popup-like URLs through callback policy', () {
      final allowedLocalFileUri = Uri.file('${tempDir.path}/preview.html');
      final fakeWebview = _FakeSessionArtifactDesktopWebview();

      installSessionArtifactPreviewUrlRequestGuard(
        webview: fakeWebview,
        allowedLocalFileUri: allowedLocalFileUri,
      );

      expect(
        fakeWebview.allowanceForRequest('javascript:alert(1)'),
        isFalse,
      );
    });

    test('blocks sibling local file requests through callback policy', () {
      final allowedLocalFileUri = Uri.file('${tempDir.path}/report.html');
      final blockedLocalFileUri = Uri.file('${tempDir.path}/sibling.html');
      final fakeWebview = _FakeSessionArtifactDesktopWebview();

      installSessionArtifactPreviewUrlRequestGuard(
        webview: fakeWebview,
        allowedLocalFileUri: allowedLocalFileUri,
      );

      expect(
        fakeWebview.allowanceForRequest(blockedLocalFileUri.toString()),
        isFalse,
      );
    });

    test('installs callback before launch on the desktop launch path', () {
      final allowedLocalFileUri = Uri.file('${tempDir.path}/preview.html');
      final fakeWebview = _FakeSessionArtifactDesktopWebview();

      launchDesktopArtifactPreview(
        fakeWebview,
        allowedLocalFileUri: allowedLocalFileUri,
      );

      expect(
        fakeWebview.events,
        equals(<String>[
          'callback-installed',
          'launch-started:$allowedLocalFileUri',
          'callback-was-present-for-launch',
          'callback-evaluated:$allowedLocalFileUri',
        ]),
      );
    });
  });
}

SessionArtifactCachedFile _fakeCachedFile(
  String path, {
  String fileName = 'preview.html',
  String contentType = 'text/html',
  String? artifactKey,
  String? contentHash,
}) {
  return SessionArtifactCachedFile(
    cachedFilePath: path,
    fileName: fileName,
    byteLength: 3,
    contentType: contentType,
    artifactKey: artifactKey,
    contentHash: contentHash,
  );
}

class _FakeArtifactUriLauncher implements SessionArtifactUriLauncher {
  _FakeArtifactUriLauncher({
    required this.success,
    this.errorMessage,
  });

  final bool success;
  final String? errorMessage;
  int launchCount = 0;
  final List<Uri> launchedUris = <Uri>[];

  @override
  String get name => 'test-fake';

  @override
  Future<SessionArtifactUriLaunchResult> launchUri(Uri uri) {
    launchCount++;
    launchedUris.add(uri);
    return Future.value(
      success
          ? const SessionArtifactUriLaunchResult.accepted()
          : SessionArtifactUriLaunchResult.failed(
              errorMessage ?? 'rejected by fake launcher',
            ),
    );
  }
}

class _FakeSessionArtifactDesktopWebview
    implements SessionArtifactPreviewDesktopWebview {
  bool Function(String)? callback;
  final events = <String>[];

  bool allowanceForRequest(String requestUrl) {
    final callbackToUse = callback;
    if (callbackToUse == null) {
      fail('URL-request callback was not installed.');
    }
    return callbackToUse(requestUrl);
  }

  @override
  void setOnUrlRequestCallback(bool Function(String)? callback) {
    events.add('callback-installed');
    this.callback = callback;
  }

  @override
  void launch(
    String url, {
    bool triggerOnUrlRequestEvent = true,
  }) {
    events.add('launch-started:$url');
    final isCallbackInstalled = callback != null;
    events.add(
      isCallbackInstalled
          ? 'callback-was-present-for-launch'
          : 'callback-missing-for-launch',
    );
    if (!isCallbackInstalled) {
      return;
    }
    final requestAllowed = callback!(url);
    events.add('callback-evaluated:$url');
    if (!requestAllowed) {
      fail('Prepared local file launch was unexpectedly blocked by callback.');
    }
  }
}
