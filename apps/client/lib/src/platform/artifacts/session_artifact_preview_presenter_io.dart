import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:cosyncing_client/l10n/app_localizations.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_file_service.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_preview_html_policy.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_preview_result.dart';
import 'package:desktop_webview_window/desktop_webview_window.dart';
import 'package:flutter/material.dart';
import 'package:path/path.dart' as path;
import 'package:webview_flutter/webview_flutter.dart';

/// Default stale preview retention window.
const Duration sessionArtifactPreviewTempRetention = Duration(hours: 24);

const String _sessionArtifactPreviewTempRootMarker = 'artifact_previews';
const String _sessionArtifactPreviewScopePrefix = 'artifact_preview';

/// Minimal desktop webview abstraction for request-callback and launch wiring.
///
/// A tiny abstraction is used so we can unit-test callback wiring and launch
/// ordering without constructing real desktop webview windows in tests.
abstract interface class SessionArtifactPreviewDesktopWebview {
  /// Installs or clears the desktop URL request callback.
  void setOnUrlRequestCallback(OnUrlRequestCallback? callback);

  /// Launches [url] in the desktop webview.
  void launch(
    String url, {
    bool triggerOnUrlRequestEvent = true,
  });
}

/// Whether this target can present an HTML artifact preview.
bool get isSessionArtifactPreviewAvailable => true;

/// Presents a cached HTML artifact on IO-backed Flutter targets.
Future<SessionArtifactPreviewPresentationResult> showSessionArtifactPreview(
  BuildContext context,
  SessionArtifactCachedFile artifact, {
  SessionArtifactUriLauncher? uriLauncher,
}) async {
  final launcher = uriLauncher ?? const SessionArtifactPlatformUriLauncher();
  final localizations = AppLocalizations.of(context);
  final previewPath = await prepareSessionArtifactPreviewFilePath(
    artifact: artifact,
  );

  if (Platform.isLinux || Platform.isWindows) {
    return _openDesktopPreviewWindow(
      artifact,
      previewPath: previewPath,
      launcher: launcher,
      localizations: localizations,
    );
  }

  if (Platform.isAndroid || Platform.isIOS || Platform.isMacOS) {
    if (!context.mounted) {
      return const SessionArtifactPreviewPresentationResult.unsupported();
    }
    final result = await Navigator.of(context)
        .push<SessionArtifactPreviewPresentationResult>(
          MaterialPageRoute<SessionArtifactPreviewPresentationResult>(
            builder: (_) => _SessionArtifactWebViewPage(
              artifact: artifact,
              previewFilePath: previewPath,
              uriLauncher: launcher,
            ),
          ),
        );
    return result ?? const SessionArtifactPreviewPresentationResult.opened();
  }

  return const SessionArtifactPreviewPresentationResult.unsupported();
}

/// Opens a URI using the selected launcher backend and maps launch outcomes to
/// preview presentation results.
Future<SessionArtifactPreviewPresentationResult>
openArtifactPreviewUriInBrowser(
  Uri uri, {
  required SessionArtifactUriLauncher uriLauncher,
}) async {
  final launchResult = await uriLauncher.launchUri(uri);
  return launchResult.launched
      ? SessionArtifactPreviewPresentationResult.externalOpenFallback(uri)
      : SessionArtifactPreviewPresentationResult.externalOpenFailed(
          uri,
          error:
              launchResult.errorMessage ??
              'No launch result from external URI launcher.',
        );
}

/// Opens the fallback URI in a desktop browser after applying the same preview
/// navigation policy used for in-window desktop preview launch paths.
///
/// The caller must provide both the candidate URI and prepared local URI.
///
/// The prepared local URI acts as the baseline allowlist. The launcher is only
/// invoked when policy allows the candidate.
Future<SessionArtifactPreviewPresentationResult>
openDesktopPreviewFallbackInBrowser({
  required Uri launchCandidateUri,
  required Uri allowedLocalFileUri,
  required SessionArtifactUriLauncher uriLauncher,
  bool allowSameDirectoryLocalAssets = false,
}) async {
  final launchDecision = evaluateDesktopPreviewLaunchCandidate(
    launchCandidateUri.toString(),
    allowedLocalFileUri: allowedLocalFileUri,
    allowSameDirectoryLocalAssets: allowSameDirectoryLocalAssets,
  );
  if (!launchDecision.isAllowed) {
    return launchDecision.result ??
        SessionArtifactPreviewPresentationResult.blockedNavigation(
          launchCandidateUri,
          reason: 'candidate launch target failed policy evaluation',
          blockReason:
              SessionArtifactPreviewNavigationBlockReason.localFileDisallowed,
        );
  }

  return openArtifactPreviewUriInBrowser(
    launchCandidateUri,
    uriLauncher: uriLauncher,
  );
}

/// Evaluates a desktop preview launch candidate against the same preview policy
/// used for in-app navigation.
///
/// Returns a policy decision so callers can fail early (for example before
/// creating a desktop preview window) when the candidate is disallowed.
SessionArtifactPreviewNavigationDecision evaluateDesktopPreviewLaunchCandidate(
  String launchCandidate, {
  required Uri allowedLocalFileUri,
  bool allowSameDirectoryLocalAssets = false,
}) {
  return SessionArtifactPreviewNavigationPolicy.evaluate(
    url: launchCandidate,
    allowedLocalFileUri: allowedLocalFileUri,
    allowSameDirectoryLocalAssets: allowSameDirectoryLocalAssets,
  );
}

/// Returns the callback decision for a desktop preview navigation request URL.
bool evaluateDesktopPreviewRequestUrl(
  String requestUrl, {
  required Uri allowedLocalFileUri,
  bool allowSameDirectoryLocalAssets = false,
}) {
  return evaluateDesktopPreviewLaunchCandidate(
    requestUrl,
    allowedLocalFileUri: allowedLocalFileUri,
    allowSameDirectoryLocalAssets: allowSameDirectoryLocalAssets,
  ).isAllowed;
}

/// Launches a desktop preview using a preinstalled URL-request guard.
///
/// Exported mainly for test seams that can confirm callback installation
/// happens before launch.
/// Governing doc: docs/architecture/client-ui.md
void launchDesktopArtifactPreview(
  SessionArtifactPreviewDesktopWebview webview, {
  required Uri allowedLocalFileUri,
  bool allowSameDirectoryLocalAssets = false,
}) {
  installSessionArtifactPreviewUrlRequestGuard(
    webview: webview,
    allowedLocalFileUri: allowedLocalFileUri,
    allowSameDirectoryLocalAssets: allowSameDirectoryLocalAssets,
  );
  webview.launch(allowedLocalFileUri.toString());
}

/// Installs the desktop URL request guard for preview navigation.
///
/// This guard applies the same policy evaluation used for launch candidate
/// checks so preflight and in-window navigation checks stay aligned.
void installSessionArtifactPreviewUrlRequestGuard({
  required SessionArtifactPreviewDesktopWebview webview,
  required Uri allowedLocalFileUri,
  bool allowSameDirectoryLocalAssets = false,
}) {
  webview.setOnUrlRequestCallback(
    (url) => evaluateDesktopPreviewRequestUrl(
      url,
      allowedLocalFileUri: allowedLocalFileUri,
      allowSameDirectoryLocalAssets: allowSameDirectoryLocalAssets,
    ),
  );
}

Future<SessionArtifactPreviewPresentationResult> _openDesktopPreviewWindow(
  SessionArtifactCachedFile artifact, {
  required String previewPath,
  required SessionArtifactUriLauncher launcher,
  required AppLocalizations localizations,
}) async {
  final allowedLocalFileUri = Uri.file(previewPath);
  final launchDecision = evaluateDesktopPreviewLaunchCandidate(
    allowedLocalFileUri.toString(),
    allowedLocalFileUri: allowedLocalFileUri,
  );
  if (!launchDecision.isAllowed) {
    return launchDecision.result ??
        SessionArtifactPreviewPresentationResult.blockedNavigation(
          allowedLocalFileUri,
          reason: 'candidate launch target failed policy evaluation',
          blockReason:
              SessionArtifactPreviewNavigationBlockReason.localFileDisallowed,
        );
  }

  final available = await WebviewWindow.isWebviewAvailable();
  if (!available) {
    return openDesktopPreviewFallbackInBrowser(
      launchCandidateUri: allowedLocalFileUri,
      allowedLocalFileUri: allowedLocalFileUri,
      uriLauncher: launcher,
    );
  }

  final webview = await WebviewWindow.create(
    configuration: CreateConfiguration(
      title: localizations.artifactPreviewWindowTitle(artifact.fileName),
      windowWidth: 1100,
      windowHeight: 760,
    ),
  );
  launchDesktopArtifactPreview(
    _DesktopWebviewAdapter(webview),
    allowedLocalFileUri: allowedLocalFileUri,
  );

  return const SessionArtifactPreviewPresentationResult.opened();
}

class _DesktopWebviewAdapter implements SessionArtifactPreviewDesktopWebview {
  const _DesktopWebviewAdapter(this._webview);

  final Webview _webview;

  @override
  void setOnUrlRequestCallback(OnUrlRequestCallback? callback) {
    _webview.setOnUrlRequestCallback(callback);
  }

  @override
  void launch(
    String url, {
    bool triggerOnUrlRequestEvent = true,
  }) {
    _webview.launch(
      url,
      triggerOnUrlRequestEvent: triggerOnUrlRequestEvent,
    );
  }
}

/// Builds a hardened local preview path for the supplied artifact.
///
/// For HTML-like artifacts, this copies the cached file into a stable app temp
/// directory and injects a restrictive Content-Security-Policy so preview loads
/// in the app copy only.
///
/// Non-HTML artifacts return their cached file path unchanged.
Future<String> prepareSessionArtifactPreviewFilePath({
  required SessionArtifactCachedFile artifact,
  Directory? rootDirectory,
  DateTime? now,
  Duration? staleRetention,
}) async {
  final isHtmlArtifact = SessionArtifactPreviewHtmlPolicy.isHtmlArtifactPreview(
    contentType: artifact.contentType,
    fileName: artifact.fileName,
  );
  if (!isHtmlArtifact) {
    return artifact.cachedFilePath;
  }

  final sourceFile = File(artifact.cachedFilePath);
  if (!sourceFile.existsSync()) {
    return artifact.cachedFilePath;
  }

  final previewDirectory = sessionArtifactPreviewTempRootDirectory(
    rootDirectory: rootDirectory,
  );
  await cleanupSessionArtifactPreviewTempStorage(
    previewRootDirectory: previewDirectory,
    now: now,
    retention: staleRetention ?? sessionArtifactPreviewTempRetention,
  );

  final scopedPreviewDirectory = sessionArtifactPreviewScopedDirectory(
    artifact: artifact,
    previewRootDirectory: previewDirectory,
  )..createSync(recursive: true);
  late final String sourceHtml;
  try {
    final sourceContents = sourceFile.readAsBytesSync();
    sourceHtml = utf8.decode(sourceContents, allowMalformed: true);
  } on Object {
    return artifact.cachedFilePath;
  }
  final hardenedHtml =
      SessionArtifactPreviewHtmlPolicy.injectRestrictiveContentSecurityPolicy(
        sourceHtml,
      );
  try {
    final previewFile = File(
      path.join(
        scopedPreviewDirectory.path,
        buildSessionArtifactPreviewFileName(artifact: artifact),
      ),
    );
    await previewFile.writeAsString(
      hardenedHtml,
      flush: true,
    );
    return previewFile.path;
  } on Object {
    return artifact.cachedFilePath;
  }
}

/// Returns the stable preview temp root directory for this platform/runtime.
///
/// The directory is always under `systemTemp/cosyncing_client/artifact_previews`
/// by default or under the same structure rooted by [rootDirectory] for tests.
Directory sessionArtifactPreviewTempRootDirectory({
  Directory? rootDirectory,
}) {
  return Directory(
    path.join(
      (rootDirectory ?? Directory.systemTemp).path,
      'cosyncing_client',
      _sessionArtifactPreviewTempRootMarker,
    ),
  );
}

/// Returns the scoped preview directory for a specific artifact.
///
/// Scoped directories keep preview copies isolated by artifact metadata so
/// versions do not overwrite each other and can be cleaned up independently.
Directory sessionArtifactPreviewScopedDirectory({
  required SessionArtifactCachedFile artifact,
  Directory? previewRootDirectory,
  Directory? rootDirectory,
}) {
  final previewRoot =
      previewRootDirectory ??
      sessionArtifactPreviewTempRootDirectory(rootDirectory: rootDirectory);

  return Directory(
    path.join(
      previewRoot.path,
      buildSessionArtifactPreviewDirectoryName(artifact: artifact),
    ),
  );
}

/// Returns a deterministic directory name for a preview artifact copy scope.
///
/// This keeps separate subdirectories for different HTML preview artifacts.
/// It also preserves deterministic names for the same metadata.
String buildSessionArtifactPreviewDirectoryName({
  required SessionArtifactCachedFile artifact,
}) {
  final seed = _previewArtifactCopySeed(artifact);
  final encodedSeed = base64Url.encode(utf8.encode(seed)).replaceAll('=', '');
  final sanitizedSeed = DefaultSessionArtifactFileService.sanitizeFileName(
    encodedSeed,
  );
  final stem = sanitizedSeed.isEmpty
      ? _sessionArtifactPreviewScopePrefix
      : '${_sessionArtifactPreviewScopePrefix}_$sanitizedSeed';
  return stem.length <= 120 ? stem : stem.substring(0, 120);
}

/// Removes stale preview storage under [previewRootDirectory].
///
/// Stale data is removed only when the target directory is the known preview
/// root.
/// Failure to read metadata or delete files/directories is ignored by design so
/// callers can continue in a degraded state.
Future<void> cleanupSessionArtifactPreviewTempStorage({
  Directory? previewRootDirectory,
  Directory? rootDirectory,
  DateTime? now,
  Duration retention = sessionArtifactPreviewTempRetention,
}) async {
  final effectivePreviewRoot =
      previewRootDirectory ??
      sessionArtifactPreviewTempRootDirectory(rootDirectory: rootDirectory);
  if (!_isSessionArtifactPreviewTempRoot(effectivePreviewRoot)) {
    return;
  }
  if (!effectivePreviewRoot.existsSync()) {
    return;
  }

  final cutoff = (now ?? DateTime.now()).subtract(retention);
  final previewEntries = effectivePreviewRoot.listSync(followLinks: false);
  for (final entry in previewEntries) {
    _deleteIfStaleSessionArtifactPreviewTempEntry(
      entry: entry,
      cutoff: cutoff,
    );
  }
}

void _deleteIfStaleSessionArtifactPreviewTempEntry({
  required FileSystemEntity entry,
  required DateTime cutoff,
}) {
  try {
    if (!_isSessionArtifactPreviewCleanupCandidate(entry: entry)) {
      return;
    }
    final modifiedAt = _previewTempEntryModifiedAt(entry: entry);
    if (modifiedAt.isAfter(cutoff)) {
      return;
    }

    entry.deleteSync(recursive: true);
  } on Object {
    // Ignore cleanup failures and continue.
  }
}

bool _isSessionArtifactPreviewCleanupCandidate({
  required FileSystemEntity entry,
}) {
  if (entry is Directory) {
    final name = path.basename(entry.path);
    return name == _sessionArtifactPreviewScopePrefix ||
        name.startsWith('${_sessionArtifactPreviewScopePrefix}_');
  }

  if (entry is File) {
    return SessionArtifactPreviewHtmlPolicy.isHtmlArtifactPreview(
      fileName: path.basename(entry.path),
    );
  }

  return false;
}

DateTime _previewTempEntryModifiedAt({required FileSystemEntity entry}) {
  final entryModified = entry.statSync().modified;
  if (entry is! Directory) {
    return entryModified;
  }

  var latestModified = DateTime.fromMillisecondsSinceEpoch(0);
  try {
    final nestedEntries = entry.listSync(recursive: true, followLinks: false);
    for (final nestedEntry in nestedEntries) {
      final nestedModified = nestedEntry.statSync().modified;
      if (nestedModified.isAfter(latestModified)) {
        latestModified = nestedModified;
      }
    }
  } on Object {
    // Ignore metadata-read failures and keep the best-effort deletion model.
  }

  if (latestModified.millisecondsSinceEpoch == 0) {
    return entryModified;
  }

  return latestModified;
}

bool _isSessionArtifactPreviewTempRoot(Directory directory) {
  final normalized = path.normalize(directory.path);
  final parts = path.split(normalized);
  if (parts.length < 2) {
    return false;
  }

  return parts[parts.length - 1] == _sessionArtifactPreviewTempRootMarker &&
      parts[parts.length - 2] == 'cosyncing_client';
}

/// Builds a deterministic hardened preview file name.
///
/// The file stem is derived from artifact metadata and a stable encoded seed so
/// repeated prep operations for the same artifact produce a stable local file
/// name.
String buildSessionArtifactPreviewFileName({
  required SessionArtifactCachedFile artifact,
}) {
  final baseFileName = DefaultSessionArtifactFileService.sanitizeFileName(
    artifact.fileName.trim().isEmpty ? 'artifact' : artifact.fileName,
  );
  final extension = _previewArtifactExtension(artifact);
  final seed = _previewArtifactCopySeed(artifact);
  final encodedSeed = base64Url.encode(utf8.encode(seed)).replaceAll('=', '');
  final sanitizedSeed = DefaultSessionArtifactFileService.sanitizeFileName(
    encodedSeed,
  );
  final baseName = path.basenameWithoutExtension(baseFileName);
  final seedSuffix = sanitizedSeed.isEmpty ? 'preview' : sanitizedSeed;
  final combinedStem =
      '${baseName.isNotEmpty ? baseName : 'artifact'}_$seedSuffix';
  final trimmedStem = combinedStem.length <= 120
      ? combinedStem
      : combinedStem.substring(0, 120);

  return '$trimmedStem$extension';
}

String _previewArtifactCopySeed(SessionArtifactCachedFile artifact) {
  final parts = <String>[];
  final fileName = artifact.fileName.trim();
  if (fileName.isNotEmpty) {
    parts.add('file:$fileName');
  }
  final artifactKey = artifact.artifactKey?.trim();
  if (artifactKey != null && artifactKey.isNotEmpty) {
    parts.add('key:$artifactKey');
  }
  final contentHash = artifact.contentHash?.trim();
  if (contentHash != null && contentHash.isNotEmpty) {
    parts.add('hash:$contentHash');
  }

  if (parts.isEmpty) {
    return 'artifact';
  }

  return parts.join('|');
}

String _previewArtifactExtension(SessionArtifactCachedFile artifact) {
  final rawFileName = artifact.fileName
      .split('?')
      .first
      .split('#')
      .first
      .trim();
  final extension = path.extension(rawFileName).toLowerCase();
  if (extension.isNotEmpty) {
    return extension;
  }

  final contentType = artifact.contentType?.toLowerCase();
  if (contentType != null) {
    final mimeType = contentType.split(';').first.trim();
    if (mimeType == 'text/html' || mimeType == 'application/xhtml+xml') {
      return '.html';
    }
  }

  return '.html';
}

class _SessionArtifactWebViewPage extends StatefulWidget {
  const _SessionArtifactWebViewPage({
    required this.artifact,
    required this.previewFilePath,
    required this.uriLauncher,
  });

  final SessionArtifactCachedFile artifact;
  final String previewFilePath;
  final SessionArtifactUriLauncher uriLauncher;

  @override
  State<_SessionArtifactWebViewPage> createState() =>
      _SessionArtifactWebViewPageState();
}

class _SessionArtifactWebViewPageState
    extends State<_SessionArtifactWebViewPage> {
  late final WebViewController _controller;
  late final Uri _cachedFileUri;
  var _progress = 0;
  Object? _loadError;
  SessionArtifactPreviewPresentationResult? _blockedNavigationResult;
  bool _isLaunchingBrowser = false;

  @override
  void initState() {
    super.initState();
    _cachedFileUri = Uri.file(widget.previewFilePath);
    _controller = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.disabled)
      ..setNavigationDelegate(
        NavigationDelegate(
          onProgress: (progress) {
            if (mounted) {
              setState(() => _progress = progress);
            }
          },
          onWebResourceError: (error) {
            if (mounted) {
              setState(() => _loadError = error.description);
            }
          },
          onNavigationRequest: (request) {
            final decision = _evaluateNavigationRequest(request.url);
            if (!decision.isAllowed) {
              if (mounted) {
                setState(() => _blockedNavigationResult = decision.result);
              }
              return NavigationDecision.prevent;
            }
            return NavigationDecision.navigate;
          },
        ),
      );
    unawaited(_controller.loadFile(widget.previewFilePath));
  }

  SessionArtifactPreviewNavigationDecision _evaluateNavigationRequest(
    String url,
  ) {
    return SessionArtifactPreviewNavigationPolicy.evaluate(
      url: url,
      allowedLocalFileUri: _cachedFileUri,
    );
  }

  Future<void> _onOpenInBrowser() async {
    final blockedNavigationResult = _blockedNavigationResult;
    if (blockedNavigationResult == null || _isLaunchingBrowser) {
      return;
    }

    setState(() => _isLaunchingBrowser = true);

    final result = await openArtifactPreviewUriInBrowser(
      _fallbackUri(blockedNavigationResult),
      uriLauncher: widget.uriLauncher,
    );

    if (!mounted) {
      return;
    }

    if (result.status ==
        SessionArtifactPreviewPresentationStatus.externalOpenFallback) {
      Navigator.of(context).pop(result);
      return;
    }

    setState(() {
      _blockedNavigationResult = result;
      _isLaunchingBrowser = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final l10n = AppLocalizations.of(context);
    final loadError = _loadError;
    final blockedNavigationResult = _blockedNavigationResult;

    return Scaffold(
      appBar: AppBar(
        title: Text(
          widget.artifact.fileName,
          overflow: TextOverflow.ellipsis,
        ),
      ),
      body: Column(
        children: [
          if (_progress < 100) LinearProgressIndicator(value: _progress / 100),
          if (loadError != null)
            MaterialBanner(
              content: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SelectableText(l10n.artifactPreviewLoadFailed),
                  ExpansionTile(
                    tilePadding: EdgeInsets.zero,
                    title: Text(l10n.technicalDetails),
                    children: [SelectableText(loadError.toString())],
                  ),
                ],
              ),
              actions: [
                TextButton(
                  onPressed: () {
                    setState(() => _loadError = null);
                    unawaited(
                      _controller.loadFile(widget.previewFilePath),
                    );
                  },
                  child: Text(l10n.retry),
                ),
              ],
            ),
          if (blockedNavigationResult != null)
            MaterialBanner(
              content: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  SelectableText(
                    _artifactPreviewPresentationMessage(
                      l10n,
                      blockedNavigationResult,
                    ),
                  ),
                  ExpansionTile(
                    tilePadding: EdgeInsets.zero,
                    title: Text(l10n.technicalDetails),
                    children: [
                      SelectableText(
                        [
                          blockedNavigationResult.message,
                          if (blockedNavigationResult.technicalDetail
                              case final detail?)
                            detail,
                        ].join('\n'),
                      ),
                    ],
                  ),
                ],
              ),
              actions: [
                TextButton(
                  onPressed: () {
                    setState(() => _blockedNavigationResult = null);
                  },
                  child: Text(l10n.dismiss),
                ),
                TextButton(
                  onPressed: _isLaunchingBrowser ? null : _onOpenInBrowser,
                  child: Text(
                    _isLaunchingBrowser ? l10n.opening : l10n.openInBrowser,
                  ),
                ),
              ],
            ),
          Expanded(child: WebViewWidget(controller: _controller)),
        ],
      ),
    );
  }

  Uri _fallbackUri(SessionArtifactPreviewPresentationResult result) {
    return result.uri ?? _cachedFileUri;
  }
}

String _artifactPreviewPresentationMessage(
  AppLocalizations l10n,
  SessionArtifactPreviewPresentationResult result,
) => switch (result.status) {
  SessionArtifactPreviewPresentationStatus.externalOpenFailed =>
    l10n.artifactPreviewBrowserFailed,
  _ => l10n.artifactPreviewBlocked,
};

/// Opens a URI with the platform's own handler.
///
/// Public because the workspace HTML hand-off launches through the same
/// command resolution — `xdg-open` on Linux, `rundll32` on Windows — and two
/// implementations of "open this in the user's browser" would be two things to
/// keep in policy agreement.
class SessionArtifactPlatformUriLauncher implements SessionArtifactUriLauncher {
  /// The only instance needed.
  const SessionArtifactPlatformUriLauncher();

  @override
  String get name => 'ProcessRunUriLauncher';

  @override
  Future<SessionArtifactUriLaunchResult> launchUri(Uri uri) async {
    final command = _sessionArtifactOpenCommand();
    if (command == null) {
      return const SessionArtifactUriLaunchResult.failed(
        'No external URL launcher command is available for this platform.',
      );
    }

    try {
      final commandArguments = [...command.arguments, uri.toString()];
      final result = await Process.run(command.executable, commandArguments);
      if (result.exitCode == 0) {
        return const SessionArtifactUriLaunchResult.accepted();
      }
      final stderr = result.stderr.toString().trim();
      final stdout = result.stdout.toString().trim();
      final messageParts = <String>[];
      if (stderr.isNotEmpty) {
        messageParts.add('stderr: $stderr');
      }
      if (stdout.isNotEmpty) {
        messageParts.add('stdout: $stdout');
      }
      final details = messageParts.isEmpty
          ? ''
          : ' (${messageParts.join(', ')})';
      return SessionArtifactUriLaunchResult.failed(
        'Process returned exit code ${result.exitCode}$details',
      );
    } on Object catch (error) {
      return SessionArtifactUriLaunchResult.failed(
        'Failed to run launch command: $error',
      );
    }
  }

  _SessionArtifactOpenCommand? _sessionArtifactOpenCommand() {
    if (Platform.isMacOS) {
      return const _SessionArtifactOpenCommand(
        executable: 'open',
        arguments: <String>[],
      );
    }
    if (Platform.isLinux) {
      return const _SessionArtifactOpenCommand(
        executable: 'xdg-open',
        arguments: <String>[],
      );
    }
    if (Platform.isWindows) {
      return const _SessionArtifactOpenCommand(
        executable: 'rundll32',
        arguments: <String>['url.dll,FileProtocolHandler'],
      );
    }
    return null;
  }
}

class _SessionArtifactOpenCommand {
  const _SessionArtifactOpenCommand({
    required this.executable,
    required this.arguments,
  });

  final String executable;
  final List<String> arguments;
}
