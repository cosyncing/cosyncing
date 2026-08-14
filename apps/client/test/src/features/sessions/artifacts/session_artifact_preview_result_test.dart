import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_preview_html_policy.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_preview_result.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('SessionArtifactPreviewPresentationResult', () {
    test('opened result describes a successful local preview', () {
      const result = SessionArtifactPreviewPresentationResult.opened();

      expect(result.opened, isTrue);
      expect(result.status, SessionArtifactPreviewPresentationStatus.opened);
      expect(result.message, 'Preview opened');
    });

    test('unsupported result distinguishes unavailable platforms', () {
      const result = SessionArtifactPreviewPresentationResult.unsupported();

      expect(result.opened, isFalse);
      expect(
        result.status,
        SessionArtifactPreviewPresentationStatus.unsupported,
      );
      expect(
        result.message,
        'Artifact preview is unavailable on this platform.',
      );
    });

    test('blocked navigation result includes the blocked destination', () {
      final result = SessionArtifactPreviewPresentationResult.blockedNavigation(
        Uri.parse('https://example.com/report.html'),
      );

      expect(result.opened, isFalse);
      expect(
        result.status,
        SessionArtifactPreviewPresentationStatus.blockedNavigation,
      );
      expect(result.uri, Uri.parse('https://example.com/report.html'));
      expect(result.message, contains('Blocked external preview navigation'));
      expect(result.message, contains('https://example.com/report.html'));
    });

    test('blocked navigation result includes popup-like reason metadata', () {
      final result = SessionArtifactPreviewPresentationResult.blockedNavigation(
        Uri.parse('about:blank'),
        blockReason: SessionArtifactPreviewNavigationBlockReason.popupLike,
      );

      expect(
        result.status,
        SessionArtifactPreviewPresentationStatus.blockedNavigation,
      );
      expect(
        result.blockReason,
        SessionArtifactPreviewNavigationBlockReason.popupLike,
      );
      expect(result.message, contains('popup/new-window-like target'));
    });

    test('external-open fallback result uses explicit fallback copy', () {
      final result =
          SessionArtifactPreviewPresentationResult.externalOpenFallback(
            Uri.parse('https://example.com/report.html'),
          );

      expect(result.opened, isFalse);
      expect(
        result.status,
        SessionArtifactPreviewPresentationStatus.externalOpenFallback,
      );
      expect(result.uri, Uri.parse('https://example.com/report.html'));
      expect(result.message, contains('Open in browser'));
      expect(result.message, contains('https://example.com/report.html'));
    });
  });

  group('SessionArtifactPreviewNavigationPolicy', () {
    test('allows local file navigation', () {
      final decision = SessionArtifactPreviewNavigationPolicy.evaluate(
        url: Uri.file('/tmp/report.html').toString(),
        allowedLocalFileUri: Uri.file('/tmp/report.html'),
      );

      expect(decision.isAllowed, isTrue);
      expect(decision.result, isNull);
    });

    test('blocks external navigation with a result message', () {
      final decision = SessionArtifactPreviewNavigationPolicy.evaluate(
        url: 'https://example.com/report.html',
        allowedLocalFileUri: Uri.file('/tmp/report.html'),
      );

      expect(decision.isAllowed, isFalse);
      expect(
        decision.result?.status,
        SessionArtifactPreviewPresentationStatus.blockedNavigation,
      );
      expect(
        decision.result?.message,
        contains('https://example.com/report.html'),
      );
      expect(
        decision.result?.blockReason,
        SessionArtifactPreviewNavigationBlockReason.externalScheme,
      );
    });

    test('blocks download-like targets before any popup flow', () {
      final decision = SessionArtifactPreviewNavigationPolicy.evaluate(
        url: 'https://example.com/report.zip',
        allowedLocalFileUri: Uri.file('/tmp/report.html'),
      );

      expect(decision.isAllowed, isFalse);
      expect(
        decision.result?.status,
        SessionArtifactPreviewPresentationStatus.blockedNavigation,
      );
      expect(
        decision.result?.blockReason,
        SessionArtifactPreviewNavigationBlockReason.downloadLike,
      );
      expect(
        decision.result?.message,
        contains('download-like target'),
      );
    });

    test('blocks popup-like targets before external scheme treatment', () {
      final decision = SessionArtifactPreviewNavigationPolicy.evaluate(
        url: 'about:blank',
        allowedLocalFileUri: Uri.file('/tmp/report.html'),
      );

      expect(decision.isAllowed, isFalse);
      expect(
        decision.result?.blockReason,
        SessionArtifactPreviewNavigationBlockReason.popupLike,
      );
      expect(
        decision.result?.message,
        contains('popup/new-window-like target'),
      );
      expect(
        decision.result?.message,
        contains('about:blank'),
      );
    });

    test('blocks malformed navigation targets', () {
      final decision = SessionArtifactPreviewNavigationPolicy.evaluate(
        url: '://bad',
        allowedLocalFileUri: Uri.file('/tmp/report.html'),
      );

      expect(decision.isAllowed, isFalse);
      expect(
        decision.result?.status,
        SessionArtifactPreviewPresentationStatus.blockedNavigation,
      );
    });

    test('blocks same-directory local files by default', () {
      final decision = SessionArtifactPreviewNavigationPolicy.evaluate(
        url: Uri.file('/tmp/report_assets/style.css').toString(),
        allowedLocalFileUri: Uri.file('/tmp/report.html'),
      );

      expect(decision.isAllowed, isFalse);
      expect(
        decision.result?.status,
        SessionArtifactPreviewPresentationStatus.blockedNavigation,
      );
    });

    test('blocks file URI with a different host', () {
      final decision = SessionArtifactPreviewNavigationPolicy.evaluate(
        url: 'file://remote-host/tmp/report.html',
        allowedLocalFileUri: Uri.file('/tmp/report.html'),
      );

      expect(decision.isAllowed, isFalse);
      expect(
        decision.result?.status,
        SessionArtifactPreviewPresentationStatus.blockedNavigation,
      );
    });

    test('same-directory opt-in does not throw for slashless file URI', () {
      final decision = SessionArtifactPreviewNavigationPolicy.evaluate(
        url: 'file:asset.css',
        allowedLocalFileUri: Uri.file('/tmp/report.html'),
        allowSameDirectoryLocalAssets: true,
      );

      expect(decision.isAllowed, isFalse);
      expect(
        decision.result?.status,
        SessionArtifactPreviewPresentationStatus.blockedNavigation,
      );
    });

    test('externalOpenFailed result indicates failed launch', () {
      const uri = 'https://example.com/report.html';
      final result =
          SessionArtifactPreviewPresentationResult.externalOpenFailed(
            Uri.parse(uri),
            error: 'launcher blocked',
          );

      expect(result.opened, isFalse);
      expect(result.completed, isFalse);
      expect(
        result.status,
        SessionArtifactPreviewPresentationStatus.externalOpenFailed,
      );
      expect(
        result.message,
        "Couldn't open the preview in your browser. Try again.",
      );
      expect(result.message, isNot(contains(uri)));
      expect(result.message, isNot(contains('launcher blocked')));
      expect(result.technicalDetail, 'launcher blocked');
    });

    test('completed preview when fallback launch is accepted', () {
      const uri = 'https://example.com/report.html';
      final result =
          SessionArtifactPreviewPresentationResult.externalOpenFallback(
            Uri.parse(uri),
          );

      expect(result.opened, isFalse);
      expect(result.completed, isTrue);
      expect(
        result.status,
        SessionArtifactPreviewPresentationStatus.externalOpenFallback,
      );
      expect(result.message, contains(uri));
    });
  });

  group('SessionArtifactPreviewHtmlPolicy', () {
    test('detects HTML artifacts from MIME type case-insensitively', () {
      expect(
        SessionArtifactPreviewHtmlPolicy.isHtmlArtifactPreview(
          contentType: 'TEXT/HTML; charset=UTF-8',
          fileName: 'report.bin',
        ),
        isTrue,
      );
    });

    test('detects HTML artifacts from extension case-insensitively', () {
      expect(
        SessionArtifactPreviewHtmlPolicy.isHtmlArtifactPreview(
          fileName: 'INDEX.HTML',
        ),
        isTrue,
      );
      expect(
        SessionArtifactPreviewHtmlPolicy.isHtmlArtifactPreview(
          contentType: 'text/plain',
          fileName: 'index.xhtml',
        ),
        isTrue,
      );
    });

    test(
      'classifies non-HTML artifacts without HTML content type or extension',
      () {
        expect(
          SessionArtifactPreviewHtmlPolicy.isHtmlArtifactPreview(
            contentType: 'text/plain',
            fileName: 'notes.txt',
          ),
          isFalse,
        );
      },
    );

    test('injects CSP inside existing head and removes old CSP tags', () {
      const source =
          '<html><head> '
          '<meta http-equiv="Content-Security-Policy" content="default-src *"> '
          '<title>Original</title>'
          '</head><body><p>Hi</p></body></html>';
      const policy = SessionArtifactPreviewHtmlPolicy
          .injectRestrictiveContentSecurityPolicy;
      final hardened = policy(
        source,
      );
      final cspMatches = RegExp(
        'content-security-policy',
        caseSensitive: false,
      ).allMatches(hardened);

      expect(cspMatches, hasLength(1));
      expect(hardened, contains('<head>'));
      expect(
        hardened,
        contains(
          "default-src 'none'; script-src 'none'; form-action 'none'; "
          "object-src 'none';",
        ),
      );
      expect(hardened, contains('<title>Original</title>'));
      expect(hardened, isNot(contains('content="default-src *"')));
    });

    test('removes unquoted existing CSP tags before injection', () {
      const source =
          '<html><head> '
          '<meta content="default-src *" http-equiv=Content-Security-Policy> '
          '</head><body></body></html>';
      const policy = SessionArtifactPreviewHtmlPolicy
          .injectRestrictiveContentSecurityPolicy;
      final hardened = policy(
        source,
      );
      final cspMatches = RegExp(
        'content-security-policy',
        caseSensitive: false,
      ).allMatches(hardened);

      expect(cspMatches, hasLength(1));
      expect(hardened, isNot(contains('content="default-src *"')));
    });

    test('removes quoted popup/download attributes in mixed-case tags', () {
      const source = '''
<html><body><a href="safe.html" TaRGeT="" dOwNlOaD="">link</a><div TARGET=_self download>download</div><img src="thumb.png" Target="_new"><a href='single.html' target='_blank' download='file.html'>single</a><a href=bare.html target download>bare</a></body></html>
''';
      const policy = SessionArtifactPreviewHtmlPolicy
          .injectRestrictiveContentSecurityPolicy;
      final hardened = policy(source);

      expect(hardened, isNot(contains('TaRGeT=""')));
      expect(hardened, isNot(contains('dOwNlOaD=""')));
      expect(
        hardened,
        isNot(contains('<div TARGET=_self download>')),
      );
      expect(hardened, isNot(contains('TARGET=_self')));
      expect(hardened, isNot(contains('Target="_new"')));
      expect(hardened, isNot(contains("target='_blank'")));
      expect(hardened, isNot(contains("download='file.html'")));
      expect(hardened, isNot(contains('<a href=bare.html target download>')));
      expect(hardened, contains('href="safe.html"'));
      expect(hardened, contains("href='single.html'"));
      expect(hardened, contains('href=bare.html'));
      expect(hardened, contains('src="thumb.png"'));
    });

    test('preserves mixed-case empty attributes in text nodes', () {
      const source = '''
<html><body><p>download target=_blank text should survive intact</p>plain text: target=_self and DOWNLOAD</body></html>
''';
      const policy = SessionArtifactPreviewHtmlPolicy
          .injectRestrictiveContentSecurityPolicy;
      final hardened = policy(source);

      expect(
        hardened,
        contains('download target=_blank text should survive intact'),
      );
      expect(
        hardened,
        contains('plain text: target=_self and DOWNLOAD'),
      );
      expect(
        hardened,
        contains('<p>download target=_blank text should survive intact</p>'),
      );
      expect(
        hardened,
        contains('plain text: target=_self and DOWNLOAD</body>'),
      );
    });

    test(
      'preserves ordinary attributes while stripping popup/download ones',
      () {
        const source = '''
<div id="root" class="card" data-download=marker data-target="item" aria-label="target download" href="https://example.com" src="/asset.svg" TARGET="_blank" DOWNLOAD="safe.txt">safe body</div>
''';
        const policy = SessionArtifactPreviewHtmlPolicy
            .injectRestrictiveContentSecurityPolicy;
        final hardened = policy(source);

        expect(hardened, contains('id="root"'));
        expect(hardened, contains('class="card"'));
        expect(hardened, contains('data-download=marker'));
        expect(hardened, contains('data-target="item"'));
        expect(hardened, contains('aria-label="target download"'));
        expect(hardened, contains('href="https://example.com"'));
        expect(hardened, contains('src="/asset.svg"'));
        expect(hardened, isNot(contains('TARGET="_blank"')));
        expect(hardened, isNot(contains('DOWNLOAD="safe.txt"')));
      },
    );

    test('adds a synthetic head block when no head is present', () {
      const source = '<html><body><p>Hi</p></body></html>';
      const policy = SessionArtifactPreviewHtmlPolicy
          .injectRestrictiveContentSecurityPolicy;
      final hardened = policy(
        source,
      );

      expect(hardened, contains('<head>'));
      expect(hardened, contains('</head>'));
      expect(hardened, contains('<body><p>Hi</p></body>'));
      expect(hardened.indexOf('<head>'), lessThan(hardened.indexOf('<body>')));
    });
  });
}
