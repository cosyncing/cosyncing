import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_route_transport.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_descriptor.dart';
import 'package:cosyncing_client/src/features/settings/controller/locale_controller.dart';
import 'package:cosyncing_client/src/features/storage/data/device_file_registry.dart';
import 'package:cosyncing_client/src/features/storage/data/managed_file_access.dart';
import 'package:cosyncing_client/src/features/storage/data/managed_memory_files.dart';
import 'package:file_selector/file_selector.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:path/path.dart' as path_util;
import 'package:path_provider/path_provider.dart';

/// Cached artifact file metadata for local export.
@immutable
class SessionArtifactCachedFile {
  /// Creates a [SessionArtifactCachedFile].
  const SessionArtifactCachedFile({
    required this.cachedFilePath,
    required this.fileName,
    required this.byteLength,
    this.contentType,
    this.artifactKey,
    this.contentHash,
  });

  /// Absolute path to the cached file.
  final String cachedFilePath;

  /// Suggested file name for the artifact.
  final String fileName;

  /// MIME/content type, if available.
  final String? contentType;

  /// Artifact length, if available.
  final int byteLength;

  /// Artifact identity, if provided by broker metadata.
  final String? artifactKey;

  /// Content hash, if provided by broker metadata.
  final String? contentHash;
}

/// Cache/export lifecycle phases for artifact actions.
enum SessionArtifactActionPhase {
  /// No action is running.
  idle,

  /// Artifact data is being fetched and written to disk.
  loading,

  /// Artifact data is being prepared for preview.
  previewing,

  /// Artifact data has been cached and exported.
  saved,

  /// Artifact preview has been opened.
  previewed,

  /// Last action failed.
  error,
}

/// Per-artifact UI-facing action state.
@immutable
class SessionArtifactActionState {
  /// Creates a [SessionArtifactActionState].
  const SessionArtifactActionState({
    required this.phase,
    this.message = '',
    this.detail,
  });

  /// Current phase.
  final SessionArtifactActionPhase phase;

  /// Supplemental message for the current phase.
  final String message;

  /// Raw failure diagnostic for the explicit Technical details disclosure.
  final String? detail;
}

/// Cooperative cancellation signal for artifact file operations.
class SessionArtifactCancellationToken {
  var _isCanceled = false;
  String _reason = 'Canceled by user';
  final _canceled = Completer<void>();

  /// Completes once so native pickers/copies can be canceled cooperatively.
  Future<void> get whenCanceled => _canceled.future;

  /// Whether cancellation has been requested.
  bool get isCanceled => _isCanceled;

  /// User-facing cancellation reason.
  String get reason => _reason;

  /// Requests cancellation.
  void cancel([String reason = 'Canceled by user']) {
    _isCanceled = true;
    _reason = reason;
    if (!_canceled.isCompleted) _canceled.complete();
  }

  /// Throws when cancellation has been requested.
  void throwIfCanceled() {
    if (_isCanceled) {
      throw SessionArtifactCanceledException(_reason);
    }
  }
}

/// Exception thrown when artifact work is canceled cooperatively.
class SessionArtifactCanceledException implements Exception {
  /// Creates a [SessionArtifactCanceledException].
  const SessionArtifactCanceledException(this.message);

  /// Cancellation message.
  final String message;

  @override
  String toString() => message;
}

/// Raw artifact data plus metadata from a fetch or inline decode.
@immutable
class SessionArtifactFetchData {
  /// Creates a [SessionArtifactFetchData].
  const SessionArtifactFetchData({
    required this.bytes,
    this.contentType,
    this.artifactKey,
    this.contentHash,
  });

  /// Raw bytes fetched or decoded.
  final List<int> bytes;

  /// MIME type from response headers or decoded `data:` metadata.
  final String? contentType;

  /// Artifact identity from response headers.
  final String? artifactKey;

  /// Artifact hash from response headers.
  final String? contentHash;
}

/// Downloads artifact bytes from signed/direct URLs and session files.
abstract interface class ArtifactDownloadBackend {
  /// Fetches bytes for a signed/direct artifact URL.
  Future<ArtifactDownload> fetchArtifactUrl(String url);

  /// Fetches streamed bytes for a session workspace file.
  ///
  /// Routes to the broker `fs/download` endpoint with auth headers; the broker
  /// streams the requested full or partial attachment. MIME comes from the W14
  /// `x-cosyncing-mime-type`/`content-type` headers.
  Future<ArtifactDownload> fetchSessionFile(
    String tool,
    String sessionId,
    String path,
  );
}

/// Optional signed-artifact capability that enforces a byte ceiling while the
/// response is arriving, including on Flutter Web.
// ignore: one_member_abstracts
abstract interface class BoundedArtifactDownloadBackend {
  /// Fetches a signed artifact without accepting more than [maxBytes].
  Future<ArtifactDownload> fetchArtifactUrlBounded(
    String url, {
    required int maxBytes,
  });
}

/// Optional signed-artifact Range capability.
///
/// Separately optional from [ResumableArtifactDownloadBackend]: a backend may
/// resume workspace files against a broker whose artifact route still answers
/// only whole representations, and the service falls back to one un-ranged
/// fetch in that case rather than failing.
// ignore: one_member_abstracts
abstract interface class ResumableSignedArtifactDownloadBackend {
  /// Fetches one range of a signed artifact URL.
  Future<ArtifactDownload> fetchArtifactUrlRange(
    String url, {
    required int rangeStart,
    required int rangeEnd,
    String? ifRange,
  });
}

/// Optional backend capability for bounded Range/If-Range requests.
// ignore: one_member_abstracts
abstract interface class ResumableArtifactDownloadBackend {
  /// Fetches one bounded range of a session workspace file.
  Future<ArtifactDownload> fetchSessionFileRange(
    String tool,
    String sessionId,
    String path, {
    required int rangeStart,
    required int rangeEnd,
    String? ifRange,
  });
}

/// Optional web-safe signed-artifact range capability. Each response is
/// cancelled while receiving if it exceeds its caller-provided byte ceiling.
// ignore: one_member_abstracts
abstract interface class BoundedResumableSignedArtifactDownloadBackend {
  /// Fetches one authenticated, bounded range of a signed artifact URL.
  Future<ArtifactDownload> fetchArtifactUrlRangeBounded(
    String url, {
    required int rangeStart,
    required int rangeEnd,
    required int maxBytes,
    String? ifRange,
  });
}

/// Optional web-safe workspace range capability. Each response is cancelled
/// while receiving if it exceeds its caller-provided byte ceiling.
// ignore: one_member_abstracts
abstract interface class BoundedResumableArtifactDownloadBackend {
  /// Fetches one authenticated, bounded range of a workspace file.
  Future<ArtifactDownload> fetchSessionFileRangeBounded(
    String tool,
    String sessionId,
    String path, {
    required int rangeStart,
    required int rangeEnd,
    required int maxBytes,
    String? ifRange,
  });
}

/// Production [ArtifactDownloadBackend] adapter built on [BrokerClient].
final class BrokerArtifactDownloadBackend
    implements
        ArtifactDownloadBackend,
        BoundedArtifactDownloadBackend,
        ResumableSignedArtifactDownloadBackend,
        BoundedResumableSignedArtifactDownloadBackend,
        ResumableArtifactDownloadBackend,
        BoundedResumableArtifactDownloadBackend {
  /// Creates a [BrokerArtifactDownloadBackend].
  const BrokerArtifactDownloadBackend(this._originalClient);

  final BrokerClient _originalClient;
  BrokerClient get _client => brokerRouteOperationClient(_originalClient);

  @override
  Future<ArtifactDownload> fetchArtifactUrl(String url) {
    return _client.fetchArtifactUrl(url);
  }

  @override
  Future<ArtifactDownload> fetchArtifactUrlBounded(
    String url, {
    required int maxBytes,
  }) {
    return _client.fetchArtifactUrlBounded(url, maxBytes: maxBytes);
  }

  @override
  Future<ArtifactDownload> fetchArtifactUrlRange(
    String url, {
    required int rangeStart,
    required int rangeEnd,
    String? ifRange,
  }) {
    return _client.fetchArtifactUrl(
      url,
      rangeStart: rangeStart,
      rangeEnd: rangeEnd,
      ifRange: ifRange,
    );
  }

  @override
  Future<ArtifactDownload> fetchArtifactUrlRangeBounded(
    String url, {
    required int rangeStart,
    required int rangeEnd,
    required int maxBytes,
    String? ifRange,
  }) {
    return _client.fetchArtifactUrlBounded(
      url,
      maxBytes: maxBytes,
      rangeStart: rangeStart,
      rangeEnd: rangeEnd,
      ifRange: ifRange,
    );
  }

  @override
  Future<ArtifactDownload> fetchSessionFile(
    String tool,
    String sessionId,
    String path,
  ) {
    return _client.downloadSessionFile(tool, sessionId, path: path);
  }

  @override
  Future<ArtifactDownload> fetchSessionFileRange(
    String tool,
    String sessionId,
    String path, {
    required int rangeStart,
    required int rangeEnd,
    String? ifRange,
  }) {
    return _client.downloadSessionFile(
      tool,
      sessionId,
      path: path,
      rangeStart: rangeStart,
      rangeEnd: rangeEnd,
      ifRange: ifRange,
    );
  }

  @override
  Future<ArtifactDownload> fetchSessionFileRangeBounded(
    String tool,
    String sessionId,
    String path, {
    required int rangeStart,
    required int rangeEnd,
    required int maxBytes,
    String? ifRange,
  }) {
    return _client.downloadSessionFileBounded(
      tool,
      sessionId,
      path: path,
      maxBytes: maxBytes,
      rangeStart: rangeStart,
      rangeEnd: rangeEnd,
      ifRange: ifRange,
    );
  }
}

/// Persisted state needed to continue one cached download.
@immutable
final class SessionFileDownloadCheckpoint {
  /// Creates a partial-file checkpoint.
  const SessionFileDownloadCheckpoint({
    required this.partialFilePath,
    required this.bytesTransferred,
    this.totalBytes,
    this.etag,
    this.lastModified,
  });

  /// App-owned `.part` file path.
  final String partialFilePath;

  /// Bytes durably flushed to [partialFilePath].
  final int bytesTransferred;

  /// Expected complete representation length.
  final int? totalBytes;

  /// Strong ETag validator.
  final String? etag;

  /// HTTP-date validator fallback.
  final String? lastModified;
}

/// Async callback after a partial range is flushed to disk.
typedef SessionFileDownloadCheckpointCallback =
    Future<void> Function(SessionFileDownloadCheckpoint checkpoint);

/// Cache-directory abstraction for testing and runtime customization.
// ignore: one_member_abstracts
abstract interface class ArtifactCacheDirectoryProvider {
  /// Returns writable artifact cache directory.
  Future<Directory> cacheDirectory();
}

/// Default path provider-backed artifact cache directory.
final class TemporaryArtifactCacheDirectoryProvider
    implements ArtifactCacheDirectoryProvider {
  /// Creates a [TemporaryArtifactCacheDirectoryProvider].
  const TemporaryArtifactCacheDirectoryProvider();

  @override
  Future<Directory> cacheDirectory() async {
    final temporary = await getTemporaryDirectory();
    final artifactsDir = Directory(
      '${temporary.path}/$sessionArtifactCacheSubdirectory',
    );
    await artifactsDir.create(recursive: true);
    return artifactsDir;
  }
}

/// Save destination abstraction for testable export.
// ignore: one_member_abstracts
abstract interface class ArtifactSaveTargetProvider {
  /// Opens save-as UX and returns selected file path.
  Future<String?> pickSavePath({
    required String suggestedName,
    String? mimeType,
  });
}

/// Testable file-selector save boundary.
typedef ArtifactSavePathPicker =
    Future<String?> Function({
      required String suggestedName,
      required List<XTypeGroup> acceptedTypeGroups,
    });

Future<String?> _pickArtifactSavePath({
  required String suggestedName,
  required List<XTypeGroup> acceptedTypeGroups,
}) {
  return getSaveLocation(
    acceptedTypeGroups: acceptedTypeGroups,
    suggestedName: suggestedName,
  ).then((location) => location?.path);
}

/// Resolves the save-dialog file-type label from the in-app language.
///
/// A null app locale means "follow system"; an explicit app locale always
/// wins even when it differs from the operating-system locale.
String artifactSaveTypeLabel({
  required ui.Locale? appLocale,
  required ui.Locale platformLocale,
}) {
  return resolveAppLocalizations(
    appLocale,
    systemLocales: [platformLocale],
  ).artifactKeyLabel;
}

/// Production implementation using `file_selector`.
final class FileSelectorArtifactSaveTargetProvider
    implements ArtifactSaveTargetProvider {
  /// Creates a [FileSelectorArtifactSaveTargetProvider].
  const FileSelectorArtifactSaveTargetProvider({
    required this.typeLabel,
    this.pathPicker = _pickArtifactSavePath,
  });

  /// Already-localized file-type label supplied by the app layer.
  final String typeLabel;

  /// Save-dialog boundary, injectable for locale and platform tests.
  final ArtifactSavePathPicker pathPicker;

  @override
  Future<String?> pickSavePath({
    required String suggestedName,
    String? mimeType,
  }) {
    final extension = _extractExtension(suggestedName);
    final groups = <XTypeGroup>[];

    if (extension != null) {
      groups.add(
        XTypeGroup(
          label: typeLabel,
          extensions: [extension],
          mimeTypes: mimeType == null ? null : [mimeType],
        ),
      );
    }

    return pathPicker(
      suggestedName: suggestedName,
      acceptedTypeGroups: groups,
    );
  }
}

/// Whether the released native client can save a cached file to the device.
bool cachedFileSaveSupportedOn(TargetPlatform platform) => switch (platform) {
  TargetPlatform.android ||
  TargetPlatform.linux ||
  TargetPlatform.macOS ||
  TargetPlatform.windows => true,
  TargetPlatform.iOS || TargetPlatform.fuchsia => false,
};

/// Checks a cached filesystem copy at the native file-service boundary.
bool cachedArtifactFileExists(String path) =>
    !kIsWeb && File(path).existsSync();

/// Exports a local cached file without reading its contents into Dart memory.
// ignore: one_member_abstracts
abstract interface class ArtifactExportTarget {
  /// Returns a destination path/URI, or null when the user cancels.
  Future<String?> export({
    required String sourcePath,
    required String suggestedName,
    String? mimeType,
    SessionArtifactCancellationToken? cancellationToken,
  });
}

/// Desktop save picker and filesystem copy.
final class FileSelectorArtifactExportTarget implements ArtifactExportTarget {
  /// Creates a target with the existing desktop save picker.
  const FileSelectorArtifactExportTarget(this.picker, {this.cancellationToken});

  /// Local path picker.
  final ArtifactSaveTargetProvider picker;

  /// Keeps desktop cancellation between destination selection and copying.
  final SessionArtifactCancellationToken? cancellationToken;

  @override
  Future<String?> export({
    required String sourcePath,
    required String suggestedName,
    String? mimeType,
    SessionArtifactCancellationToken? cancellationToken,
  }) async {
    final destination = await picker.pickSavePath(
      suggestedName: suggestedName,
      mimeType: mimeType,
    );
    (cancellationToken ?? this.cancellationToken)?.throwIfCanceled();
    if (destination == null) return null;
    await File(sourcePath).copy(destination);
    return destination;
  }
}

/// Optional display names returned by document providers that rename a file.
// ignore: one_member_abstracts
abstract interface class ArtifactExportNames {
  /// Actual destination name, when the platform reported it.
  String? exportedNameFor(String destination);
}

/// Android Storage Access Framework save picker and streamed native copy.
final class AndroidArtifactExportTarget
    implements ArtifactExportTarget, ArtifactExportNames {
  /// Creates the app-owned platform boundary.
  AndroidArtifactExportTarget();

  final _names = <String, String>{};

  @override
  String? exportedNameFor(String destination) => _names[destination];

  static const _channel = MethodChannel('com.cosyncing.client/file_export');
  static int _requestSequence = 0;

  @override
  Future<String?> export({
    required String sourcePath,
    required String suggestedName,
    String? mimeType,
    SessionArtifactCancellationToken? cancellationToken,
  }) async {
    cancellationToken?.throwIfCanceled();
    final requestId = ++_requestSequence;
    var active = true;
    if (cancellationToken != null) {
      unawaited(
        cancellationToken.whenCanceled.then((_) async {
          if (active) {
            await _channel.invokeMethod<void>('cancelSaveAs', {
              'requestId': requestId,
            });
          }
        }),
      );
    }
    Map<String, dynamic>? result;
    try {
      result = await _channel.invokeMapMethod<String, dynamic>('saveAs', {
        'requestId': requestId,
        'sourcePath': sourcePath,
        'suggestedName': suggestedName,
        'mimeType': mimeType,
      });
    } finally {
      active = false;
    }
    // A successful native write is committed even if cancellation arrived at
    // the same instant. Native cancellation returns null before committing.
    if (result == null) cancellationToken?.throwIfCanceled();
    final uri = result?['uri'] as String?;
    final name = result?['displayName'] as String?;
    if (uri != null && name != null && name.isNotEmpty) _names[uri] = name;
    return uri;
  }
}

/// Reports byte progress from cache/export operations.
typedef SessionArtifactProgressCallback =
    void Function({required int bytesTransferred, int? totalBytes});

/// Contract for cache/export operations.
abstract interface class SessionArtifactFileService {
  /// Caches artifact bytes in app writable storage.
  ///
  /// [checkpoint] continues a previous attempt's `.part` file; passing none
  /// starts at byte 0 and truncates any partial the caller left behind, which
  /// is what an implementation with no durable staging can do. [onCheckpoint]
  /// is awaited after each flushed range, so the ledger commit lands before the
  /// next one is requested.
  Future<SessionArtifactCachedFile> cacheArtifact(
    SessionArtifactDescriptor descriptor, {
    SessionFileDownloadCheckpoint? checkpoint,
    SessionFileDownloadCheckpointCallback? onCheckpoint,
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  });

  /// Caches a read-only session workspace file for download/export.
  ///
  /// Fetches streamed bytes from the broker `fs/download` endpoint (auth-aware)
  /// and writes them to app cache using the same atomic staging path as
  /// [cacheArtifact]. The file-browser download path reuses the existing
  /// transfer ledger/worker rather than a parallel one.
  Future<SessionArtifactCachedFile> cacheSessionFile({
    required String tool,
    required String sessionId,
    required String path,
    required String fileName,
    String? mimeType,
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  });

  /// Exports cached artifact through destination picker/interaction.
  Future<String?> exportCachedArtifact(
    SessionArtifactCachedFile artifact, {
    SessionArtifactCancellationToken? cancellationToken,
  });
}

/// Optional restart-safe workspace download capability.
// ignore: one_member_abstracts
abstract interface class ResumableSessionArtifactFileService {
  /// Caches a session file in bounded ranges with durable checkpoints.
  Future<SessionArtifactCachedFile> cacheSessionFileResumable({
    required String tool,
    required String sessionId,
    required String path,
    required String fileName,
    String? mimeType,
    SessionFileDownloadCheckpoint? checkpoint,
    SessionFileDownloadCheckpointCallback? onCheckpoint,
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  });
}

/// Cache subdirectory shared by [TemporaryArtifactCacheDirectoryProvider] and
/// the native background download engine, so a background-completed file lands
/// in the same cache directory a foreground download uses.
const String sessionArtifactCacheSubdirectory = 'cosyncing_client_artifacts';

/// Landing capability for a completed native background download (FG8).
///
/// Implemented by [DefaultSessionArtifactFileService] so a background-completed
/// file lands through the exact same safe-filename, MIME-extension parity, and
/// collision handling as a foreground download.
abstract interface class BackgroundSessionDownloadFinalizer {
  /// Cache subdirectory (relative to the temporary base directory) the native
  /// engine downloads into.
  String get backgroundDownloadSubdirectory;

  /// Moves a completed native download into the shared cache path and returns
  /// its cached-file metadata, resolving the safe final name from [mimeType].
  Future<SessionArtifactCachedFile> finalizeBackgroundDownload({
    required String downloadedFilePath,
    required String fileName,
    String? mimeType,
  });
}

/// App provider for session artifact file operations.
final sessionArtifactFileServiceProvider = Provider<SessionArtifactFileService>(
  (ref) {
    final client = ref
        .watch(brokerClientProvider)
        .maybeWhen(data: (value) => value, orElse: () => null);

    final downloadBackend = client == null
        ? null
        : BrokerArtifactDownloadBackend(client);
    if (kIsWeb) {
      return BrowserSessionArtifactFileService(
        downloadBackend,
        memory: ref.watch(managedMemoryFilesProvider),
        onCompleted: ref.watch(deviceFileRegistryProvider).register,
      );
    }
    return DefaultSessionArtifactFileService(
      downloadBackend: downloadBackend,
      onCompleted: ref.watch(deviceFileRegistryProvider).register,
      cacheDirectoryProvider: const TemporaryArtifactCacheDirectoryProvider(),
      exportTarget: defaultTargetPlatform == TargetPlatform.android
          ? AndroidArtifactExportTarget()
          : null,
      saveTargetProvider: FileSelectorArtifactSaveTargetProvider(
        typeLabel: artifactSaveTypeLabel(
          appLocale: ref.watch(localeControllerProvider).valueOrNull,
          platformLocale: ui.PlatformDispatcher.instance.locale,
        ),
      ),
    );
  },
);

const int _browserArtifactCacheMaxBytes = 64 * 1024 * 1024;
const int _browserSessionFileRangeBytes = 1024 * 1024;

/// Durable registration runs only after a complete copy exists.
typedef ArtifactCopyCompleted =
    Future<void> Function({required String location, required String label});

/// Browser artifact cache/export path.
///
/// Web has no `dart:io` temporary directory and `file_selector_web` returns a
/// dummy save path by design. Retain only a bounded LRU of fetched bytes, then
/// hand an [XFile] to the browser so its native download behavior owns the
/// destination. Desktop/mobile continue through
/// [DefaultSessionArtifactFileService]'s atomic filesystem path.
final class BrowserSessionArtifactFileService
    implements SessionArtifactFileService {
  /// Creates the web implementation bound to the active broker client.
  BrowserSessionArtifactFileService(
    this._downloadBackend, {
    ManagedMemoryFiles? memory,
    this._onCompleted,
  }) : _memory = memory ?? ManagedMemoryFiles();

  final ArtifactDownloadBackend? _downloadBackend;
  final ManagedMemoryFiles _memory;
  final ArtifactCopyCompleted? _onCompleted;

  @override
  Future<SessionArtifactCachedFile> cacheArtifact(
    SessionArtifactDescriptor descriptor, {
    // Web has no `.part` file to continue: the bytes live in a bounded
    // in-memory LRU that a reload discards, so there is never durable partial
    // state for a checkpoint to describe. Accepted and ignored rather than
    // unsupported, so the worker wires one call site for both platforms.
    SessionFileDownloadCheckpoint? checkpoint,
    SessionFileDownloadCheckpointCallback? onCheckpoint,
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  }) async {
    cancellationToken?.throwIfCanceled();
    final source = descriptor.downloadSourceUrl;
    if (source == null || source.isEmpty) {
      throw StateError('Artifact does not provide a download source.');
    }
    final fetched = descriptor.isInlineDataUrl
        ? DefaultSessionArtifactFileService.decodeDataUrl(source)
        : await _fetchReference(
            descriptor,
            source,
            cancellationToken: cancellationToken,
            onProgress: onProgress,
          );
    cancellationToken?.throwIfCanceled();
    final contentType = fetched.contentType ?? descriptor.mimeType;
    final fileName = DefaultSessionArtifactFileService.resolveSafeFileName(
      descriptor,
      contentType: contentType,
    );
    final cacheKey = await _retain(
      fetched.bytes,
      fileName: fileName,
      cancellationToken: cancellationToken,
      onProgress: onProgress,
    );
    return SessionArtifactCachedFile(
      cachedFilePath: cacheKey,
      fileName: fileName,
      contentType: contentType,
      byteLength: fetched.bytes.length,
      artifactKey: descriptor.artifactKey ?? fetched.artifactKey,
      contentHash: descriptor.contentHash ?? fetched.contentHash,
    );
  }

  @override
  Future<SessionArtifactCachedFile> cacheSessionFile({
    required String tool,
    required String sessionId,
    required String path,
    required String fileName,
    String? mimeType,
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  }) async {
    cancellationToken?.throwIfCanceled();
    final backend = _downloadBackend;
    if (backend == null) {
      throw StateError('Connect to an active server before downloading.');
    }
    final download = await _fetchBoundedSessionFile(
      backend,
      tool: tool,
      sessionId: sessionId,
      path: path,
      cancellationToken: cancellationToken,
      onProgress: onProgress,
    );
    cancellationToken?.throwIfCanceled();
    final contentType = download.contentType ?? mimeType;
    final safeName = DefaultSessionArtifactFileService.resolveSafeFileName(
      SessionArtifactDescriptor(name: fileName, path: path),
      contentType: contentType,
    );
    final cacheKey = await _retain(
      download.bytes,
      fileName: safeName,
      cancellationToken: cancellationToken,
      onProgress: onProgress,
    );
    return SessionArtifactCachedFile(
      cachedFilePath: cacheKey,
      fileName: safeName,
      contentType: contentType,
      byteLength: download.bytes.length,
    );
  }

  @override
  Future<String?> exportCachedArtifact(
    SessionArtifactCachedFile artifact, {
    SessionArtifactCancellationToken? cancellationToken,
  }) async {
    cancellationToken?.throwIfCanceled();
    final entry = _memory.read(artifact.cachedFilePath);
    if (entry == null) {
      throw StateError(
        'The browser artifact cache entry is no longer available.',
      );
    }
    final release = ManagedFileAccess.shared.acquire(artifact.cachedFilePath);
    try {
      await XFile.fromData(
        entry,
        name: artifact.fileName,
        mimeType: artifact.contentType,
      ).saveTo('');
      cancellationToken?.throwIfCanceled();
      return artifact.fileName;
    } finally {
      release();
    }
  }

  Future<SessionArtifactFetchData> _fetchReference(
    SessionArtifactDescriptor descriptor,
    String source, {
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  }) async {
    final backend = _downloadBackend;
    if (backend == null) {
      throw StateError('Connect to an active server before downloading.');
    }
    if (backend is! BoundedArtifactDownloadBackend) {
      throw StateError(
        'The active server cannot bound browser artifact downloads.',
      );
    }
    final boundedBackend = backend as BoundedArtifactDownloadBackend;
    // Chunk it where the backend can, so one oversized artifact is refused at
    // the first range rather than after a whole bounded response arrives.
    final download = backend is BoundedResumableSignedArtifactDownloadBackend
        ? await _fetchBoundedRanged(
            ({
              required rangeStart,
              required rangeEnd,
              required maxBytes,
              ifRange,
            }) => (backend as BoundedResumableSignedArtifactDownloadBackend)
                .fetchArtifactUrlRangeBounded(
                  source,
                  rangeStart: rangeStart,
                  rangeEnd: rangeEnd,
                  maxBytes: maxBytes,
                  ifRange: ifRange,
                ),
            cancellationToken: cancellationToken,
            onProgress: onProgress,
          )
        : await boundedBackend.fetchArtifactUrlBounded(
            source,
            maxBytes: _browserArtifactCacheMaxBytes,
          );
    final expectedArtifactKey = descriptor.artifactKey?.trim();
    if (expectedArtifactKey != null &&
        expectedArtifactKey.isNotEmpty &&
        download.artifactKey?.trim() != expectedArtifactKey) {
      throw StateError('Artifact identity did not match the requested file.');
    }
    final expectedContentHash = descriptor.contentHash?.trim();
    if (expectedContentHash != null &&
        expectedContentHash.isNotEmpty &&
        download.contentHash?.trim() != expectedContentHash) {
      throw StateError('Artifact version did not match the requested file.');
    }
    return SessionArtifactFetchData(
      bytes: download.bytes,
      contentType: download.contentType,
      artifactKey: download.artifactKey,
      contentHash: download.contentHash,
    );
  }

  Future<ArtifactDownload> _fetchBoundedSessionFile(
    ArtifactDownloadBackend backend, {
    required String tool,
    required String sessionId,
    required String path,
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  }) async {
    if (backend is! BoundedResumableArtifactDownloadBackend) {
      throw StateError(
        'The active server cannot bound browser workspace '
        'downloads.',
      );
    }
    final boundedBackend = backend as BoundedResumableArtifactDownloadBackend;
    return _fetchBoundedRanged(
      ({required rangeStart, required rangeEnd, required maxBytes, ifRange}) =>
          boundedBackend.fetchSessionFileRangeBounded(
            tool,
            sessionId,
            path,
            rangeStart: rangeStart,
            rangeEnd: rangeEnd,
            maxBytes: maxBytes,
            ifRange: ifRange,
          ),
      cancellationToken: cancellationToken,
      onProgress: onProgress,
    );
  }

  /// The shared bounded chunk loop behind both browser download paths.
  ///
  /// Web has no `.part` file to resume from, so this loop is about the CEILING
  /// rather than restart-safety: it keeps a single response from ever exceeding
  /// the cache bound while the bytes are arriving. Workspace files and signed
  /// artifacts differ only in how one bounded range is fetched.
  Future<ArtifactDownload> _fetchBoundedRanged(
    Future<ArtifactDownload> Function({
      required int rangeStart,
      required int rangeEnd,
      required int maxBytes,
      String? ifRange,
    })
    fetchRange, {
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  }) async {
    final bytes = BytesBuilder(copy: false);
    var offset = 0;
    int? totalBytes;
    String? etag;
    String? lastModified;
    String? contentType;
    String? artifactKey;
    String? contentHash;
    onProgress?.call(bytesTransferred: 0);
    while (totalBytes == null || offset < totalBytes) {
      cancellationToken?.throwIfCanceled();
      final remaining = _browserArtifactCacheMaxBytes - offset;
      if (remaining <= 0) {
        throw ArtifactTooLargeException(
          limit: _browserArtifactCacheMaxBytes,
          advertised: totalBytes,
        );
      }
      final requestBytes = remaining < _browserSessionFileRangeBytes
          ? remaining
          : _browserSessionFileRangeBytes;
      final validator = etag ?? lastModified;
      final download = await fetchRange(
        rangeStart: offset,
        rangeEnd: offset + requestBytes - 1,
        maxBytes: requestBytes,
        ifRange: offset == 0 ? null : validator,
      );
      cancellationToken?.throwIfCanceled();
      contentType = download.contentType ?? contentType;
      artifactKey = download.artifactKey ?? artifactKey;
      contentHash = download.contentHash ?? contentHash;
      final range = _parseContentRange(download.contentRange);
      if (download.statusCode == 416) {
        if (range?.total == offset) {
          totalBytes = offset;
          break;
        }
        throw const BrokerException(
          message: 'Download range is outside the current file.',
          statusCode: 416,
        );
      }
      if (download.statusCode == 200) {
        if (offset != 0 ||
            download.bytes.length > _browserArtifactCacheMaxBytes ||
            (download.contentLength != null &&
                download.contentLength != download.bytes.length)) {
          throw const BrokerException(
            message: 'Server returned an invalid full browser download.',
          );
        }
        bytes.add(download.bytes);
        offset = download.bytes.length;
        totalBytes = offset;
        onProgress?.call(bytesTransferred: offset, totalBytes: totalBytes);
        break;
      }
      if (download.statusCode != 206 ||
          range == null ||
          range.total == null ||
          range.start != offset ||
          range.end < range.start ||
          range.end >= range.total! ||
          range.end - range.start + 1 != download.bytes.length ||
          download.bytes.isEmpty) {
        throw const BrokerException(
          message: 'Server returned an invalid browser download range.',
        );
      }
      if (range.total! > _browserArtifactCacheMaxBytes) {
        throw ArtifactTooLargeException(
          limit: _browserArtifactCacheMaxBytes,
          advertised: range.total,
        );
      }
      final representationChanged =
          (etag != null && download.etag != etag) ||
          (etag == null &&
              lastModified != null &&
              download.lastModified != lastModified);
      if (representationChanged) {
        throw const BrokerException(
          message: 'Download representation changed between browser ranges.',
        );
      }
      final completesFile = range.end + 1 == range.total;
      if (!completesFile &&
          validator == null &&
          download.etag == null &&
          download.lastModified == null) {
        throw const BrokerException(
          message: 'Server did not provide a browser range validator.',
        );
      }
      bytes.add(download.bytes);
      offset = offset + download.bytes.length;
      totalBytes = range.total;
      etag = download.etag ?? etag;
      lastModified = download.lastModified ?? lastModified;
      onProgress?.call(bytesTransferred: offset, totalBytes: totalBytes);
    }
    if (offset != totalBytes) {
      throw const BrokerException(
        message: 'Browser download ended before the complete file arrived.',
      );
    }
    return ArtifactDownload(
      bytes: bytes.takeBytes(),
      contentType: contentType,
      contentLength: totalBytes,
      etag: etag,
      lastModified: lastModified,
      artifactKey: artifactKey,
      contentHash: contentHash,
    );
  }

  Future<String> _retain(
    List<int> bytes, {
    required String fileName,
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  }) async {
    cancellationToken?.throwIfCanceled();
    final key = _memory.retain(bytes);
    await _onCompleted?.call(location: key, label: fileName);
    onProgress?.call(bytesTransferred: bytes.length, totalBytes: bytes.length);
    return key;
  }
}

/// Default file service used by the app feature layer.
final class DefaultSessionArtifactFileService
    implements
        SessionArtifactFileService,
        ResumableSessionArtifactFileService,
        BackgroundSessionDownloadFinalizer,
        ArtifactExportNames {
  /// Creates a [DefaultSessionArtifactFileService].
  const DefaultSessionArtifactFileService({
    required ArtifactDownloadBackend? downloadBackend,
    required ArtifactCacheDirectoryProvider cacheDirectoryProvider,
    required ArtifactSaveTargetProvider saveTargetProvider,
    ArtifactExportTarget? exportTarget,
    ArtifactCopyCompleted? onCompleted,
  }) : this._(
         downloadBackend: downloadBackend,
         cacheDirectoryProvider: cacheDirectoryProvider,
         saveTargetProvider: saveTargetProvider,
         exportTarget: exportTarget,
         onCompleted: onCompleted,
       );

  const DefaultSessionArtifactFileService._({
    required this._downloadBackend,
    required this._cacheDirectoryProvider,
    required this._saveTargetProvider,
    this._exportTarget,
    this._onCompleted,
  });

  @override
  String? exportedNameFor(String destination) {
    return switch (_exportTarget) {
      final ArtifactExportNames target => target.exportedNameFor(destination),
      _ => null,
    };
  }

  final ArtifactExportTarget? _exportTarget;
  final ArtifactDownloadBackend? _downloadBackend;
  final ArtifactCacheDirectoryProvider _cacheDirectoryProvider;
  final ArtifactSaveTargetProvider _saveTargetProvider;
  final ArtifactCopyCompleted? _onCompleted;

  static const Map<String, String> _extensionByMime = {
    'text/plain': 'txt',
    'text/html': 'html',
    'application/json': 'json',
    'application/pdf': 'pdf',
    'image/png': 'png',
    'image/jpeg': 'jpg',
  };

  /// Decodes `data:` URLs.
  static SessionArtifactFetchData decodeDataUrl(String dataUrl) {
    if (!dataUrl.startsWith('data:')) {
      throw const FormatException('Not a data URL');
    }

    final commaIndex = dataUrl.indexOf(',');
    if (commaIndex < 0) {
      throw const FormatException('Malformed data URL');
    }

    final metadata = dataUrl.substring('data:'.length, commaIndex);
    final dataSection = dataUrl.substring(commaIndex + 1);
    final isBase64 = metadata.toLowerCase().contains(';base64');
    final mimeType = metadata
        .split(';')
        .firstWhere(
          (part) => part.contains('/'),
          orElse: () => '',
        );

    final bytes = isBase64
        ? base64.decode(dataSection)
        : utf8.encode(Uri.decodeFull(dataSection));

    return SessionArtifactFetchData(
      bytes: bytes,
      contentType: mimeType.isNotEmpty ? mimeType : null,
    );
  }

  /// Resolves safe filename from artifact metadata.
  static String resolveSafeFileName(
    SessionArtifactDescriptor descriptor, {
    String? contentType,
  }) {
    final configuredName = descriptor.name?.trim();
    final base = (configuredName?.isNotEmpty ?? false)
        ? configuredName
        : _safeFileBaseFromPath(descriptor.path);

    var fileName = sanitizeFileName(base ?? 'artifact');
    final extension = _mimeToExtension(contentType);
    if (_extractExtension(fileName) == null && extension != null) {
      fileName = '$fileName.$extension';
    }

    return fileName;
  }

  /// Sanitizes an arbitrary filename for app cache writes.
  static String sanitizeFileName(String raw) {
    var sanitized = raw
        .replaceAll('\u0000', '')
        .replaceAll('\r', '')
        .replaceAll('\n', ' ')
        .replaceAll('/', '_')
        .replaceAll(r'\', '_')
        .replaceAll(':', '_')
        .replaceAll('*', '_')
        .replaceAll('?', '_')
        .replaceAll('"', '_')
        .replaceAll('<', '_')
        .replaceAll('>', '_')
        .replaceAll('|', '_');

    sanitized = sanitized.trim();

    if (sanitized.isEmpty) {
      return 'artifact';
    }

    sanitized = sanitized.replaceAll('..', '_');
    sanitized = sanitized.replaceAll('\u0000', '').trim();

    if (sanitized.isEmpty || sanitized == '.' || sanitized == '..') {
      return 'artifact';
    }

    return sanitized;
  }

  /// Returns a safe base name from path metadata.
  static String? _safeFileBaseFromPath(String? path) {
    if (path == null) {
      return null;
    }

    final normalized = path.replaceAll(r'\', '/');
    final parts = normalized
        .split('/')
        .where((part) => part.trim().isNotEmpty && part != '.')
        .toList(growable: false);

    return parts.isEmpty ? null : parts.last;
  }

  static String? _extractExtension(String fileName) {
    final index = fileName.lastIndexOf('.');
    if (index < 0 || index == fileName.length - 1) {
      return null;
    }

    final extension = fileName.substring(index + 1).trim();
    if (extension.isEmpty) {
      return null;
    }

    return extension.toLowerCase();
  }

  static String? _mimeToExtension(String? contentType) {
    final normalized = contentType?.split(';').first.trim().toLowerCase();
    if (normalized == null || normalized.isEmpty) {
      return null;
    }

    return _extensionByMime[normalized];
  }

  @override
  Future<SessionArtifactCachedFile> cacheArtifact(
    SessionArtifactDescriptor descriptor, {
    SessionFileDownloadCheckpoint? checkpoint,
    SessionFileDownloadCheckpointCallback? onCheckpoint,
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  }) async {
    cancellationToken?.throwIfCanceled();
    final source = descriptor.downloadSourceUrl;
    if (source == null || source.isEmpty) {
      throw StateError('Artifact does not provide a download source.');
    }

    // The chunked machinery already existed and was proven, so it is reused
    // here rather than reimplemented: bounded ranges, `If-Range` validation,
    // no whole-file buffering, and — with a [checkpoint] from the caller's
    // ledger — the same continue-across-attempts behaviour the workspace path
    // has. With no checkpoint each call still starts at byte 0.
    //
    // An inline `data:` artifact is not on the wire at all: its bytes are in
    // the descriptor, there is nothing to range over, and the request would
    // leave as an HTTP GET for a `data:` URL. It decodes locally, the way the
    // browser service and the un-ranged path have always decoded it.
    final rangedBackend = switch (_downloadBackend) {
      final ResumableSignedArtifactDownloadBackend value
          when !descriptor.isInlineDataUrl =>
        value,
      _ => null,
    };
    if (rangedBackend != null) {
      final cached = await _resumableChunkedDownload(
        fetchRange: ({required rangeStart, required rangeEnd, ifRange}) =>
            rangedBackend.fetchArtifactUrlRange(
              source,
              rangeStart: rangeStart,
              rangeEnd: rangeEnd,
              ifRange: ifRange,
            ),
        fetchWhole: (resolvedMime) => _wholeArtifactDownload(
          descriptor,
          source,
          cancellationToken: cancellationToken,
          onProgress: onProgress,
        ),
        resolveFileName: (resolvedMime) => resolveSafeFileName(
          descriptor,
          contentType: resolvedMime ?? descriptor.mimeType,
        ),
        mimeType: descriptor.mimeType,
        checkpoint: checkpoint,
        onCheckpoint: onCheckpoint,
        cancellationToken: cancellationToken,
        onProgress: onProgress,
      );
      return SessionArtifactCachedFile(
        cachedFilePath: cached.cachedFilePath,
        fileName: cached.fileName,
        contentType: cached.contentType ?? descriptor.mimeType,
        byteLength: cached.byteLength,
        artifactKey: descriptor.artifactKey ?? cached.artifactKey,
        contentHash: descriptor.contentHash ?? cached.contentHash,
      );
    }

    return _wholeArtifactDownload(
      descriptor,
      source,
      cancellationToken: cancellationToken,
      onProgress: onProgress,
    );
  }

  /// One un-ranged artifact fetch through the shared atomic staging path.
  ///
  /// Used when the backend advertises no artifact Range capability, and as the
  /// fail-closed fallback when a 206 arrives with no representation validator.
  Future<SessionArtifactCachedFile> _wholeArtifactDownload(
    SessionArtifactDescriptor descriptor,
    String source, {
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  }) async {
    final fetched = await _fetchBytes(descriptor, source);
    final safeFileName = resolveSafeFileName(
      descriptor,
      contentType: fetched.contentType ?? descriptor.mimeType,
    );
    final finalPath = await _persistCacheBytes(
      bytes: fetched.bytes,
      safeFileName: safeFileName,
      cancellationToken: cancellationToken,
      onProgress: onProgress,
    );

    return SessionArtifactCachedFile(
      cachedFilePath: finalPath,
      fileName: _filenameFromPath(finalPath),
      contentType: fetched.contentType ?? descriptor.mimeType,
      byteLength: fetched.bytes.length,
      artifactKey: descriptor.artifactKey ?? fetched.artifactKey,
      contentHash: descriptor.contentHash ?? fetched.contentHash,
    );
  }

  @override
  Future<SessionArtifactCachedFile> cacheSessionFile({
    required String tool,
    required String sessionId,
    required String path,
    required String fileName,
    String? mimeType,
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  }) async {
    return cacheSessionFileResumable(
      tool: tool,
      sessionId: sessionId,
      path: path,
      fileName: fileName,
      mimeType: mimeType,
      cancellationToken: cancellationToken,
      onProgress: onProgress,
    );
  }

  @override
  Future<SessionArtifactCachedFile> cacheSessionFileResumable({
    required String tool,
    required String sessionId,
    required String path,
    required String fileName,
    String? mimeType,
    SessionFileDownloadCheckpoint? checkpoint,
    SessionFileDownloadCheckpointCallback? onCheckpoint,
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  }) async {
    cancellationToken?.throwIfCanceled();
    final backend = _downloadBackend;
    if (backend == null) {
      throw StateError('Connect to an active server before downloading.');
    }
    final resumableBackend = switch (backend) {
      final ResumableArtifactDownloadBackend value => value,
      _ => null,
    };
    if (resumableBackend == null) {
      return _fullSessionFileDownload(
        backend,
        tool: tool,
        sessionId: sessionId,
        path: path,
        fileName: fileName,
        mimeType: mimeType,
        cancellationToken: cancellationToken,
        onProgress: onProgress,
      );
    }
    return _resumableChunkedDownload(
      fetchRange: ({required rangeStart, required rangeEnd, ifRange}) =>
          resumableBackend.fetchSessionFileRange(
            tool,
            sessionId,
            path,
            rangeStart: rangeStart,
            rangeEnd: rangeEnd,
            ifRange: ifRange,
          ),
      fetchWhole: (resolvedMime) => _fullSessionFileDownload(
        backend,
        tool: tool,
        sessionId: sessionId,
        path: path,
        fileName: fileName,
        mimeType: resolvedMime,
        cancellationToken: cancellationToken,
        onProgress: onProgress,
      ),
      resolveFileName: (resolvedMime) =>
          _resolveSessionFileName(fileName, resolvedMime),
      mimeType: mimeType,
      checkpoint: checkpoint,
      onCheckpoint: onCheckpoint,
      cancellationToken: cancellationToken,
      onProgress: onProgress,
    );
  }

  /// The shared resumable chunk loop behind both cached download paths.
  ///
  /// A workspace file and a signed artifact differ only in HOW one range is
  /// fetched and where the final name comes from. Everything else the loop does
  /// — the `.part` staging file, the `If-Range` validator, 416 and
  /// representation-change recovery, the checkpoint callbacks, the fail-closed
  /// fallback when a 206 arrives with no validator — is identical, and was
  /// proven on the workspace path long before an artifact could use it. Two
  /// copies of this would be two chances to get resume wrong.
  Future<SessionArtifactCachedFile> _resumableChunkedDownload({
    required Future<ArtifactDownload> Function({
      required int rangeStart,
      required int rangeEnd,
      String? ifRange,
    })
    fetchRange,
    required Future<SessionArtifactCachedFile> Function(String? mimeType)
    fetchWhole,
    required String Function(String? mimeType) resolveFileName,
    String? mimeType,
    SessionFileDownloadCheckpoint? checkpoint,
    SessionFileDownloadCheckpointCallback? onCheckpoint,
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  }) async {
    const chunkBytes = 512 * 1024;
    cancellationToken?.throwIfCanceled();
    final cacheDirectory = await _cacheDirectoryProvider.cacheDirectory();
    cancellationToken?.throwIfCanceled();
    final safeFileName = resolveFileName(mimeType);
    var partialPath = _validatedPartialPath(
      checkpoint?.partialFilePath,
      cacheDirectory,
    );
    if (partialPath == null) {
      final finalPath = _nextAvailablePath(
        cacheDirectory.path,
        safeFileName,
      );
      partialPath = '$finalPath.part';
    }
    final partialFile = File(partialPath);
    final release = ManagedFileAccess.shared.acquire(partialPath);
    try {
      await partialFile.parent.create(recursive: true);
      var offset = 0;
      if (partialFile.existsSync()) offset = partialFile.lengthSync();
      var totalBytes = checkpoint?.totalBytes;
      var etag = offset > 0 ? checkpoint?.etag : null;
      var lastModified = offset > 0 ? checkpoint?.lastModified : null;
      var resolvedMime = mimeType;
      String? servedArtifactKey;
      String? servedContentHash;

      if (offset > 0 && etag == null && lastModified == null) {
        await partialFile.writeAsBytes(const [], flush: true);
        offset = 0;
        totalBytes = null;
        await onCheckpoint?.call(
          SessionFileDownloadCheckpoint(
            partialFilePath: partialPath,
            bytesTransferred: 0,
          ),
        );
      }

      onProgress?.call(bytesTransferred: offset, totalBytes: totalBytes);
      var restartedRepresentation = false;
      while (totalBytes == null || offset < totalBytes) {
        cancellationToken?.throwIfCanceled();
        final validator = etag ?? lastModified;
        final download = await fetchRange(
          rangeStart: offset,
          rangeEnd: offset + chunkBytes - 1,
          ifRange: offset == 0 ? null : validator,
        );
        cancellationToken?.throwIfCanceled();
        resolvedMime = download.contentType ?? resolvedMime;
        servedArtifactKey = download.artifactKey ?? servedArtifactKey;
        servedContentHash = download.contentHash ?? servedContentHash;
        final range = _parseContentRange(download.contentRange);

        if (download.statusCode == 416) {
          final remoteLength = range?.total;
          if (remoteLength != null && remoteLength == offset) {
            if (!partialFile.existsSync()) {
              await partialFile.writeAsBytes(const [], flush: true);
            }
            totalBytes = remoteLength;
            break;
          }
          if (!restartedRepresentation) {
            restartedRepresentation = true;
            await partialFile.writeAsBytes(const [], flush: true);
            offset = 0;
            totalBytes = null;
            etag = null;
            lastModified = null;
            await onCheckpoint?.call(
              SessionFileDownloadCheckpoint(
                partialFilePath: partialPath,
                bytesTransferred: 0,
              ),
            );
            continue;
          }
          throw const BrokerException(
            message: 'Download range is outside the current file.',
            statusCode: 416,
          );
        }

        if (download.statusCode == 200) {
          if (download.contentLength case final advertisedLength?
              when advertisedLength != download.bytes.length) {
            throw const BrokerException(
              message: 'Server returned an incomplete full download.',
            );
          }
          await partialFile.writeAsBytes(download.bytes, flush: true);
          offset = download.bytes.length;
          totalBytes = offset;
        } else if (download.statusCode == 206) {
          if (download.etag == null && download.lastModified == null) {
            // A 206 with no validator cannot guard later range requests with an
            // If-Range header, so a mid-download representation change would be
            // undetectable and could corrupt the file. Abandon the partial and
            // fall back to one un-ranged full download.
            if (partialFile.existsSync()) partialFile.deleteSync();
            await onCheckpoint?.call(
              SessionFileDownloadCheckpoint(
                partialFilePath: partialPath,
                bytesTransferred: 0,
              ),
            );
            return fetchWhole(resolvedMime);
          }
          if (range == null ||
              range.total == null ||
              range.start != offset ||
              range.end < range.start ||
              range.end >= range.total! ||
              range.end - range.start + 1 != download.bytes.length ||
              download.bytes.isEmpty) {
            throw const BrokerException(
              message: 'Server returned an invalid download range.',
            );
          }
          final representationChanged =
              (etag != null && download.etag != etag) ||
              (etag == null &&
                  lastModified != null &&
                  download.lastModified != lastModified);
          if (representationChanged) {
            if (restartedRepresentation) {
              throw const BrokerException(
                message: 'Download representation changed repeatedly.',
              );
            }
            restartedRepresentation = true;
            await partialFile.writeAsBytes(const [], flush: true);
            offset = 0;
            totalBytes = null;
            etag = null;
            lastModified = null;
            await onCheckpoint?.call(
              SessionFileDownloadCheckpoint(
                partialFilePath: partialPath,
                bytesTransferred: 0,
              ),
            );
            continue;
          }
          await partialFile.writeAsBytes(
            download.bytes,
            mode: FileMode.append,
            flush: true,
          );
          offset += download.bytes.length;
          totalBytes = range.total;
        } else {
          throw BrokerException(
            message: 'Unexpected download status ${download.statusCode}.',
            statusCode: download.statusCode,
          );
        }

        etag = download.etag ?? etag;
        lastModified = download.lastModified ?? lastModified;
        await onCheckpoint?.call(
          SessionFileDownloadCheckpoint(
            partialFilePath: partialPath,
            bytesTransferred: offset,
            totalBytes: totalBytes,
            etag: etag,
            lastModified: lastModified,
          ),
        );
        onProgress?.call(
          bytesTransferred: offset,
          totalBytes: totalBytes,
        );
        if (download.statusCode == 200) break;
      }

      cancellationToken?.throwIfCanceled();
      if (totalBytes == null || offset != totalBytes) {
        throw const BrokerException(
          message: 'Download ended before the complete file was received.',
        );
      }
      // Resolve the final name from the representation the broker served
      // (its response content-type), matching the single-shot path. The `.part`
      // staging name keeps its derivation; only the rename target picks
      // up the server-sniffed extension.
      final targetDirectory = partialFile.parent.path;
      final resolvedFileName = resolveFileName(resolvedMime);
      var finalPath = '$targetDirectory/$resolvedFileName';
      if (File(finalPath).existsSync() ||
          ManagedFileAccess.shared.inUse(finalPath)) {
        finalPath = _nextAvailablePath(targetDirectory, resolvedFileName);
      }
      partialFile.renameSync(finalPath);
      await _onCompleted?.call(
        location: finalPath,
        label: _filenameFromPath(finalPath),
      );
      return SessionArtifactCachedFile(
        cachedFilePath: finalPath,
        fileName: _filenameFromPath(finalPath),
        contentType: resolvedMime,
        byteLength: offset,
        artifactKey: servedArtifactKey,
        contentHash: servedContentHash,
      );
    } finally {
      release();
    }
  }

  /// Downloads a session workspace file in one un-ranged request and persists
  /// it through the shared atomic staging path. Used when the backend has no
  /// resumable capability and as the fail-closed fallback when the broker
  /// serves ranged responses without a representation validator.
  Future<SessionArtifactCachedFile> _fullSessionFileDownload(
    ArtifactDownloadBackend backend, {
    required String tool,
    required String sessionId,
    required String path,
    required String fileName,
    String? mimeType,
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  }) async {
    final download = await backend.fetchSessionFile(tool, sessionId, path);
    final resolvedMime = download.contentType ?? mimeType;
    final safeFileName = _resolveSessionFileName(fileName, resolvedMime);
    final finalPath = await _persistCacheBytes(
      bytes: download.bytes,
      safeFileName: safeFileName,
      cancellationToken: cancellationToken,
      onProgress: onProgress,
    );
    return SessionArtifactCachedFile(
      cachedFilePath: finalPath,
      fileName: _filenameFromPath(finalPath),
      contentType: resolvedMime,
      byteLength: download.bytes.length,
    );
  }

  @override
  String get backgroundDownloadSubdirectory => sessionArtifactCacheSubdirectory;

  @override
  Future<SessionArtifactCachedFile> finalizeBackgroundDownload({
    required String downloadedFilePath,
    required String fileName,
    String? mimeType,
  }) async {
    final source = File(downloadedFilePath);
    final byteLength = source.existsSync() ? source.lengthSync() : 0;
    final cacheDirectory = await _cacheDirectoryProvider.cacheDirectory();
    // Same safe-filename (MIME extension parity) and collision handling the
    // foreground resumable path applies at its final rename.
    final safeFileName = _resolveSessionFileName(fileName, mimeType);
    final finalPath = _nextAvailablePath(cacheDirectory.path, safeFileName);
    final release = ManagedFileAccess.shared.acquire(finalPath);
    try {
      final targetFile = File(finalPath);
      await targetFile.parent.create(recursive: true);
      try {
        await source.rename(finalPath);
      } on FileSystemException {
        // Cross-device move: copy and delete the native temporary file.
        await source.copy(finalPath);
        if (source.existsSync()) {
          source.deleteSync();
        }
      }
      await _onCompleted?.call(
        location: finalPath,
        label: _filenameFromPath(finalPath),
      );
      return SessionArtifactCachedFile(
        cachedFilePath: finalPath,
        fileName: _filenameFromPath(finalPath),
        contentType: mimeType,
        byteLength: byteLength,
      );
    } finally {
      release();
    }
  }

  String? _validatedPartialPath(String? candidate, Directory cacheDirectory) {
    if (candidate == null || !candidate.endsWith('.part')) return null;
    final root = path_util.normalize(cacheDirectory.absolute.path);
    final path = path_util.normalize(File(candidate).absolute.path);
    return path_util.isWithin(root, path) ? path : null;
  }

  /// Writes [bytes] to the app cache with atomic staging, returning the final
  /// path. Shared by artifact and session-file cache paths.
  Future<String> _persistCacheBytes({
    required List<int> bytes,
    required String safeFileName,
    SessionArtifactCancellationToken? cancellationToken,
    SessionArtifactProgressCallback? onProgress,
  }) async {
    cancellationToken?.throwIfCanceled();
    onProgress?.call(bytesTransferred: 0, totalBytes: bytes.length);
    final cacheDirectory = await _cacheDirectoryProvider.cacheDirectory();
    cancellationToken?.throwIfCanceled();
    final finalPath = _nextAvailablePath(cacheDirectory.path, safeFileName);
    final release = ManagedFileAccess.shared.acquire(finalPath);
    try {
      final targetFile = File(finalPath);
      final stagingPath = '$finalPath.part';
      final stagingFile = File(stagingPath);

      try {
        await stagingFile.parent.create(recursive: true);
        if (stagingFile.existsSync()) {
          stagingFile.deleteSync();
        }

        await stagingFile.writeAsBytes(bytes, flush: true);
        cancellationToken?.throwIfCanceled();
        onProgress?.call(
          bytesTransferred: bytes.length,
          totalBytes: bytes.length,
        );
        if (targetFile.existsSync()) {
          targetFile.deleteSync();
        }
        stagingFile.renameSync(finalPath);
      } on Exception {
        if (stagingFile.existsSync()) {
          stagingFile.deleteSync();
        }
        rethrow;
      }

      await _onCompleted?.call(location: finalPath, label: safeFileName);
      return finalPath;
    } finally {
      release();
    }
  }

  /// Resolves a safe cache filename for a session workspace file, falling back
  /// to a MIME-derived extension only when the entry name lacks one.
  String _resolveSessionFileName(String fileName, String? contentType) {
    var safe = sanitizeFileName(fileName);
    final extension = _mimeToExtension(contentType);
    if (_extractExtension(safe) == null && extension != null) {
      safe = '$safe.$extension';
    }
    return safe;
  }

  @override
  Future<String?> exportCachedArtifact(
    SessionArtifactCachedFile artifact, {
    SessionArtifactCancellationToken? cancellationToken,
  }) async {
    cancellationToken?.throwIfCanceled();
    final release = ManagedFileAccess.shared.acquire(artifact.cachedFilePath);
    try {
      final destination =
          await (_exportTarget ??
                  FileSelectorArtifactExportTarget(
                    _saveTargetProvider,
                    cancellationToken: cancellationToken,
                  ))
              .export(
                sourcePath: artifact.cachedFilePath,
                suggestedName: artifact.fileName,
                mimeType: artifact.contentType,
                cancellationToken: cancellationToken,
              );
      return destination;
    } finally {
      release();
    }
  }

  // Callers acquire the selected target or its .part lease synchronously,
  // before any await, so concurrent writers cannot choose the same name.
  String _nextAvailablePath(String directoryPath, String fileName) {
    if (!fileName.contains('.')) {
      var index = 0;
      while (true) {
        final candidate = index == 0 ? fileName : '$fileName-$index';
        final candidatePath = '$directoryPath/$candidate';
        if (!ManagedFileAccess.shared.inUse(candidatePath) &&
            !ManagedFileAccess.shared.inUse('$candidatePath.part') &&
            !File(candidatePath).existsSync() &&
            !File('$candidatePath.part').existsSync()) {
          return candidatePath;
        }
        index += 1;
      }
    }

    final lastDot = fileName.lastIndexOf('.');
    final stem = fileName.substring(0, lastDot);
    final extension = fileName.substring(lastDot);
    var index = 0;

    while (true) {
      final candidateName = index == 0 ? fileName : '$stem-$index$extension';
      final candidatePath = '$directoryPath/$candidateName';
      if (!ManagedFileAccess.shared.inUse(candidatePath) &&
          !ManagedFileAccess.shared.inUse('$candidatePath.part') &&
          !File(candidatePath).existsSync() &&
          !File('$candidatePath.part').existsSync()) {
        return candidatePath;
      }
      index += 1;
    }
  }

  Future<SessionArtifactFetchData> _fetchBytes(
    SessionArtifactDescriptor descriptor,
    String source,
  ) async {
    if (descriptor.isInlineDataUrl) {
      final decoded = decodeDataUrl(source);
      return SessionArtifactFetchData(
        bytes: decoded.bytes,
        contentType: decoded.contentType,
        artifactKey: descriptor.artifactKey,
        contentHash: descriptor.contentHash,
      );
    }

    final backend = _downloadBackend;
    if (backend == null) {
      throw StateError('Connect to an active server before downloading.');
    }

    final download = await backend.fetchArtifactUrl(source);
    final expectedArtifactKey = descriptor.artifactKey?.trim();
    if (expectedArtifactKey != null && expectedArtifactKey.isNotEmpty) {
      final receivedArtifactKey = download.artifactKey?.trim();
      if (receivedArtifactKey != expectedArtifactKey) {
        throw StateError('Artifact identity did not match the requested file.');
      }
    }
    final expectedContentHash = descriptor.contentHash?.trim();
    if (expectedContentHash != null && expectedContentHash.isNotEmpty) {
      final receivedContentHash = download.contentHash?.trim();
      if (receivedContentHash != expectedContentHash) {
        throw StateError('Artifact version did not match the requested file.');
      }
    }
    return SessionArtifactFetchData(
      bytes: download.bytes,
      contentType: download.contentType,
      artifactKey: download.artifactKey,
      contentHash: download.contentHash,
    );
  }

  static String _filenameFromPath(String path) {
    final normalized = path.replaceAll(r'\', '/');
    final parts = normalized.split('/');
    if (parts.isEmpty || parts.last.isEmpty) {
      return path;
    }

    return parts.last;
  }
}

String? _extractExtension(String fileName) =>
    DefaultSessionArtifactFileService._extractExtension(fileName);

final class _ContentRange {
  const _ContentRange({required this.start, required this.end, this.total});

  final int start;
  final int end;
  final int? total;
}

_ContentRange? _parseContentRange(String? raw) {
  if (raw == null) return null;
  final satisfied = RegExp(
    r'^bytes (\d+)-(\d+)/(\d+|\*)$',
  ).firstMatch(raw.trim());
  if (satisfied != null) {
    return _ContentRange(
      start: int.parse(satisfied.group(1)!),
      end: int.parse(satisfied.group(2)!),
      total: satisfied.group(3) == '*' ? null : int.parse(satisfied.group(3)!),
    );
  }
  final unsatisfied = RegExp(r'^bytes \*/(\d+)$').firstMatch(raw.trim());
  if (unsatisfied != null) {
    return _ContentRange(
      start: -1,
      end: -1,
      total: int.parse(unsatisfied.group(1)!),
    );
  }
  return null;
}
