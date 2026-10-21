import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:cosyncing_client/src/design/app_tokens.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_viewer_pane.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_file_service.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_preview_html_policy.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_preview_result.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_file_browser.dart';
import 'package:cosyncing_client/src/features/storage/data/device_file_registry.dart';
import 'package:cosyncing_client/src/features/storage/data/managed_file_access.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path/path.dart' as path;

/// Default stale preview retention window.
const Duration sessionArtifactPreviewTempRetention = Duration(hours: 24);

const String _sessionArtifactPreviewTempRootMarker = 'artifact_previews';
const String _sessionArtifactPreviewScopePrefix = 'artifact_preview';

/// Whether this target can present an HTML artifact preview.
bool get isSessionArtifactPreviewAvailable => true;

/// Presents a cached HTML artifact on IO-backed Flutter targets.
Future<SessionArtifactPreviewPresentationResult> showSessionArtifactPreview(
  BuildContext context,
  SessionArtifactCachedFile artifact, {
  SessionArtifactUriLauncher? uriLauncher,
}) async {
  final launcher = uriLauncher ?? const SessionArtifactPlatformUriLauncher();
  final releaseSource = ManagedFileAccess.shared.acquire(
    artifact.cachedFilePath,
  );
  try {
    if (Platform.isLinux || Platform.isWindows) {
      final previewPath = await prepareSessionArtifactPreviewFilePath(
        artifact: artifact,
      );
      if (previewPath != artifact.cachedFilePath && context.mounted) {
        await ProviderScope.containerOf(context, listen: false)
            .read(deviceFileRegistryProvider)
            .register(
              location: previewPath,
              label: artifact.fileName,
              category: 'temporary',
            );
      }
      final uri = Uri.file(previewPath);
      return await openDesktopPreviewFallbackInBrowser(
        launchCandidateUri: uri,
        allowedLocalFileUri: uri,
        uriLauncher: launcher,
      );
    }
    if (Platform.isAndroid || Platform.isIOS || Platform.isMacOS) {
      final text = await _readCompleteHtml(File(artifact.cachedFilePath));
      if (!context.mounted) {
        return const SessionArtifactPreviewPresentationResult.unsupported();
      }
      await Navigator.of(context).push<void>(
        MaterialPageRoute<void>(
          builder: (context) => Scaffold(
            appBar: AppBar(title: Text(artifact.fileName)),
            body: FileViewerPane(
              content: FileViewerSource(
                preview: SessionFilePreview(
                  path: artifact.fileName,
                  displayName: artifact.fileName,
                  mimeType: artifact.contentType,
                  text: text,
                  size: utf8.encode(text).length,
                  limit: _cachedHtmlPreviewByteLimit,
                  truncated: false,
                ),
              ),
              sessionLabel: '',
              toolColor: context.tokens.accent,
            ),
          ),
        ),
      );
      return const SessionArtifactPreviewPresentationResult.opened();
    }
  } on Object {
    // Never hand the original, unsandboxed file to a browser on prep failure.
    return const SessionArtifactPreviewPresentationResult.unsupported();
  } finally {
    releaseSource();
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
  final access = ManagedFileAccess.shared;
  final release = uri.scheme == 'file'
      ? access.acquire(uri.toFilePath())
      : null;
  try {
    final launchResult = await uriLauncher.launchUri(uri);
    if (launchResult.launched && uri.scheme == 'file') {
      access.retainForSession(uri.toFilePath());
    }
    return launchResult.launched
        ? SessionArtifactPreviewPresentationResult.externalOpenFallback(uri)
        : SessionArtifactPreviewPresentationResult.externalOpenFailed(
            uri,
            error:
                launchResult.errorMessage ??
                'No launch result from external URI launcher.',
          );
  } finally {
    release?.call();
  }
}

/// Opens the prepared copy in a desktop browser after validating the launch
/// against that exact local file.
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

const int _cachedHtmlPreviewByteLimit = 2 * 1024 * 1024;

Future<String> _readCompleteHtml(File file) async {
  final bytes = BytesBuilder(copy: false);
  await for (final chunk in file.openRead(0, _cachedHtmlPreviewByteLimit + 1)) {
    bytes.add(chunk);
    if (bytes.length > _cachedHtmlPreviewByteLimit) {
      throw StateError('HTML preview exceeds the bounded read');
    }
  }
  return utf8.decode(bytes.takeBytes());
}

/// Builds a hardened local preview path for the supplied artifact.
///
/// For HTML-like artifacts, this copies the cached file into a stable app temp
/// directory and wraps complete bounded bytes in an isolated interactive child.
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
    throw StateError('HTML preview source is unavailable');
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
  final sourceHtml = await _readCompleteHtml(sourceFile);
  final previewFile = File(
    path.join(
      scopedPreviewDirectory.path,
      buildSessionArtifactPreviewFileName(artifact: artifact),
    ),
  );
  if (!ManagedFileAccess.shared.inUse(previewFile.path)) {
    await ManagedFileAccess.shared.remove(
      previewFile.path,
      () => previewFile.writeAsString(
        prepareInteractiveHtmlDocument(sourceHtml),
        flush: true,
      ),
    );
  }
  return previewFile.path;
}

/// Returns the stable preview temp root directory for this platform/runtime.
///
/// The directory is always under
/// `systemTemp/cosyncing_client/artifact_previews`
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
    if (!ManagedFileAccess.shared.inUseTree(entry.path)) {
      _deleteIfStaleSessionArtifactPreviewTempEntry(
        entry: entry,
        cutoff: cutoff,
      );
    }
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

String _previewArtifactExtension(SessionArtifactCachedFile artifact) => '.html';

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
