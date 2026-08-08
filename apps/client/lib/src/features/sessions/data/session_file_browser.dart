import 'dart:convert';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_detail_state.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Default byte cap for read-only file previews.
///
/// Mirrors the broker's default `/fs/read` cap. Downloads remain full-file
/// fetches because the broker does not support Range requests yet.
const int sessionFilePreviewDefaultMaxBytes = 1024 * 1024;

/// Repository boundary for read-only session workspace browsing.
abstract interface class SessionFileBrowserRepository {
  /// Lists or stats a path in the session workspace.
  Future<FsDirectoryResult> listPath(
    SessionDetailKey sessionKey, {
    String path = '',
  });

  /// Reads a bounded file preview.
  Future<FsReadResult> readFile(
    SessionDetailKey sessionKey, {
    required String path,
    int maxBytes = sessionFilePreviewDefaultMaxBytes,
  });
}

/// Broker-backed file browser repository.
class BrokerSessionFileBrowserRepository
    implements SessionFileBrowserRepository {
  /// Creates a broker-backed repository.
  const BrokerSessionFileBrowserRepository(this._client);

  final BrokerClient _client;

  @override
  Future<FsDirectoryResult> listPath(
    SessionDetailKey sessionKey, {
    String path = '',
  }) {
    return _client.listSessionDirectory(
      sessionKey.tool,
      sessionKey.sessionId,
      path: path.isEmpty ? null : path,
    );
  }

  @override
  Future<FsReadResult> readFile(
    SessionDetailKey sessionKey, {
    required String path,
    int maxBytes = sessionFilePreviewDefaultMaxBytes,
  }) {
    return _client.readSessionFile(
      sessionKey.tool,
      sessionKey.sessionId,
      path: path,
      maxBytes: maxBytes,
    );
  }
}

/// Provides the read-only file browser repository for the active broker.
final sessionFileBrowserRepositoryProvider =
    FutureProvider<SessionFileBrowserRepository?>((ref) async {
      final client = await ref.watch(brokerClientProvider.future);
      if (client == null) {
        return null;
      }
      return BrokerSessionFileBrowserRepository(client);
    });

/// File browser load phase.
enum SessionFileBrowserPhase {
  /// No browse has been started.
  idle,

  /// A directory/stat request is in flight.
  loading,

  /// Directory/stat data is available.
  ready,

  /// Remote file access is intentionally disabled by the broker host.
  remoteDisabled,

  /// A non-empty file read is in flight.
  previewing,

  /// Last operation failed.
  error,
}

/// Locale-free status and recovery copy selected by the file browser.
enum SessionFileBrowserNotice {
  /// The workspace root is loading.
  loadingWorkspace,

  /// A nested path is loading.
  loading,

  /// A Broker connection is required for browsing.
  connectToBrowse,

  /// A Broker connection is required for preview.
  connectToPreview,

  /// Only text files can be previewed.
  previewTextOnly,

  /// A file preview is loading.
  reading,

  /// The detected MIME type cannot be previewed.
  previewMimeUnavailable,

  /// The preview was truncated to the Broker read cap.
  previewTruncated,

  /// The requested path does not exist.
  pathNotFound,

  /// The session has no current working directory.
  noWorkingDirectory,

  /// The requested path is outside the workspace.
  pathOutsideWorkspace,

  /// A symlink target cannot be read.
  symlinkNotReadable,

  /// The requested item is not a regular file.
  notRegularFile,

  /// The requested path is not a directory.
  notDirectory,

  /// The file request failed validation.
  invalidRequest,

  /// The file exceeds the Broker download cap.
  downloadTooLarge,

  /// Remote file browsing is disabled by the Broker host.
  remoteDisabled,

  /// An otherwise unclassified file operation failed.
  failed,
}

/// Bounded read result for the preview dialog.
@immutable
class SessionFilePreview {
  /// Creates a preview.
  const SessionFilePreview({
    required this.path,
    required this.displayName,
    required this.mimeType,
    required this.size,
    required this.limit,
    required this.truncated,
    required this.text,
  });

  /// Workspace-relative path.
  final String path;

  /// Basename used in UI labels.
  final String displayName;

  /// Broker-sniffed MIME type, if known.
  final String? mimeType;

  /// Full file size.
  final int size;

  /// Effective broker read cap.
  final int limit;

  /// Whether [text] was truncated by the broker.
  final bool truncated;

  /// Decoded preview text.
  final String text;
}

/// Immutable state for one session file browser.
@immutable
class SessionFileBrowserState {
  /// Creates state.
  SessionFileBrowserState({
    this.phase = SessionFileBrowserPhase.idle,
    this.currentPath = '',
    this.result,
    this.preview,
    this.errorCode,
    this.notice,
    this.noticeArgument,
    String? technicalDetail,
  }) : technicalDetail = boundedTechnicalDetail(technicalDetail);

  /// Current load phase.
  final SessionFileBrowserPhase phase;

  /// Workspace-relative directory path currently shown.
  final String currentPath;

  /// Latest listing/stat result.
  final FsDirectoryResult? result;

  /// Latest bounded file preview, if any.
  final SessionFilePreview? preview;

  /// Broker error code, if available.
  final String? errorCode;

  /// Locale-free status or recovery classification.
  final SessionFileBrowserNotice? notice;

  /// Bounded value used by notices such as MIME type or filename.
  final String? noticeArgument;

  /// Raw diagnostic detail retained outside primary user-facing copy.
  final String? technicalDetail;

  /// Directory entries grouped directories first, then files, other, symlinks.
  List<FsDirEntry> get groupedEntries {
    final entries = [...?result?.entries]
      ..sort((a, b) {
        final typeCompare = _entryTypeRank(a).compareTo(_entryTypeRank(b));
        if (typeCompare != 0) {
          return typeCompare;
        }
        return a.name.toLowerCase().compareTo(b.name.toLowerCase());
      });
    return List.unmodifiable(entries);
  }

  /// Path breadcrumbs including root.
  List<SessionFileBreadcrumb> get breadcrumbs {
    final normalized = normalizeSessionFilePath(currentPath);
    if (normalized.isEmpty) {
      return const [SessionFileBreadcrumb(label: 'Workspace', path: '')];
    }
    final parts = normalized.split('/');
    final crumbs = <SessionFileBreadcrumb>[
      const SessionFileBreadcrumb(label: 'Workspace', path: ''),
    ];
    for (var index = 0; index < parts.length; index++) {
      crumbs.add(
        SessionFileBreadcrumb(
          label: parts[index],
          path: parts.take(index + 1).join('/'),
        ),
      );
    }
    return List.unmodifiable(crumbs);
  }

  /// Returns a copy with optional overrides.
  SessionFileBrowserState copyWith({
    SessionFileBrowserPhase? phase,
    String? currentPath,
    FsDirectoryResult? result,
    SessionFilePreview? preview,
    String? errorCode,
    SessionFileBrowserNotice? notice,
    String? noticeArgument,
    String? technicalDetail,
    bool clearPreview = false,
    bool clearError = false,
    bool clearNotice = false,
  }) {
    return SessionFileBrowserState(
      phase: phase ?? this.phase,
      currentPath: currentPath ?? this.currentPath,
      result: result ?? this.result,
      preview: clearPreview ? null : preview ?? this.preview,
      errorCode: clearError ? null : errorCode ?? this.errorCode,
      notice: clearNotice ? null : notice ?? this.notice,
      noticeArgument: clearNotice
          ? null
          : noticeArgument ?? this.noticeArgument,
      technicalDetail: clearError
          ? null
          : technicalDetail ?? this.technicalDetail,
    );
  }
}

/// One breadcrumb segment in the session file browser.
@immutable
class SessionFileBreadcrumb {
  /// Creates a breadcrumb.
  const SessionFileBreadcrumb({
    required this.label,
    required this.path,
  });

  /// Display label.
  final String label;

  /// Workspace-relative path.
  final String path;
}

/// Controller for the read-only file browser slice.
class SessionFileBrowserController
    extends
        AutoDisposeFamilyNotifier<SessionFileBrowserState, SessionDetailKey> {
  @override
  SessionFileBrowserState build(SessionDetailKey arg) {
    return SessionFileBrowserState();
  }

  /// Loads [path], replacing the current directory/stat result.
  Future<void> load({String path = ''}) async {
    final normalized = normalizeSessionFilePath(path);
    state = state.copyWith(
      phase: SessionFileBrowserPhase.loading,
      currentPath: normalized,
      notice: normalized.isEmpty
          ? SessionFileBrowserNotice.loadingWorkspace
          : SessionFileBrowserNotice.loading,
      clearError: true,
      clearPreview: true,
    );

    final repository = await ref.read(
      sessionFileBrowserRepositoryProvider.future,
    );
    if (repository == null) {
      state = state.copyWith(
        phase: SessionFileBrowserPhase.error,
        notice: SessionFileBrowserNotice.connectToBrowse,
      );
      return;
    }

    try {
      final result = await repository.listPath(arg, path: normalized);
      state = SessionFileBrowserState(
        phase: SessionFileBrowserPhase.ready,
        currentPath: result.path,
        result: result,
      );
    } on BrokerException catch (e) {
      state = _stateForBrokerException(
        path: normalized,
        exception: e,
      );
    } on Object catch (e) {
      state = SessionFileBrowserState(
        phase: SessionFileBrowserPhase.error,
        currentPath: normalized,
        notice: SessionFileBrowserNotice.failed,
        technicalDetail: failureDetail(e),
      );
    }
  }

  /// Navigates to a directory entry.
  Future<void> openDirectory(FsDirEntry entry) async {
    if (entry.type != 'directory') {
      return;
    }
    await load(path: entry.path);
  }

  /// Reads [entry] into [SessionFilePreview] when it is previewable text.
  Future<SessionFilePreview?> previewFile(FsDirEntry entry) async {
    if (!_isPreviewableEntry(entry)) {
      state = state.copyWith(
        phase: SessionFileBrowserPhase.ready,
        notice: SessionFileBrowserNotice.previewTextOnly,
      );
      return null;
    }

    state = state.copyWith(
      phase: SessionFileBrowserPhase.previewing,
      notice: SessionFileBrowserNotice.reading,
      noticeArgument: entry.name,
      clearError: true,
      clearPreview: true,
    );

    final repository = await ref.read(
      sessionFileBrowserRepositoryProvider.future,
    );
    if (repository == null) {
      state = state.copyWith(
        phase: SessionFileBrowserPhase.error,
        notice: SessionFileBrowserNotice.connectToPreview,
      );
      return null;
    }

    try {
      final read = await repository.readFile(arg, path: entry.path);
      if (!isPreviewableMime(read.mimeType)) {
        state = state.copyWith(
          phase: SessionFileBrowserPhase.ready,
          notice: SessionFileBrowserNotice.previewMimeUnavailable,
          noticeArgument: read.mimeType,
        );
        return null;
      }
      final preview = SessionFilePreview(
        path: read.path,
        displayName: entry.name,
        mimeType: read.mimeType,
        size: read.size,
        limit: read.limit,
        truncated: read.truncated,
        text: decodeSessionFileReadText(read),
      );
      state = state.copyWith(
        phase: SessionFileBrowserPhase.ready,
        preview: preview,
        notice: read.truncated
            ? SessionFileBrowserNotice.previewTruncated
            : null,
        noticeArgument: read.truncated ? read.limit.toString() : null,
        clearError: true,
        clearNotice: !read.truncated,
      );
      return preview;
    } on BrokerException catch (e) {
      state = _stateForBrokerException(
        path: state.currentPath,
        exception: e,
      );
      return null;
    } on Object catch (e) {
      state = state.copyWith(
        phase: SessionFileBrowserPhase.error,
        notice: SessionFileBrowserNotice.failed,
        technicalDetail: failureDetail(e),
      );
      return null;
    }
  }

  SessionFileBrowserState _stateForBrokerException({
    required String path,
    required BrokerException exception,
  }) {
    final code = exception.error?.code;
    if (code == 'FS_REMOTE_DISABLED') {
      return SessionFileBrowserState(
        phase: SessionFileBrowserPhase.remoteDisabled,
        currentPath: path,
        errorCode: code,
        notice: SessionFileBrowserNotice.remoteDisabled,
        technicalDetail: exception.message,
      );
    }
    return SessionFileBrowserState(
      phase: SessionFileBrowserPhase.error,
      currentPath: path,
      errorCode: code,
      notice: _noticeForSessionFileError(code),
      technicalDetail: exception.message,
    );
  }
}

SessionFileBrowserNotice _noticeForSessionFileError(String? code) {
  return switch (code) {
    'NOT_FOUND' => SessionFileBrowserNotice.pathNotFound,
    'NO_CWD' => SessionFileBrowserNotice.noWorkingDirectory,
    'PATH_ESCAPE' => SessionFileBrowserNotice.pathOutsideWorkspace,
    'PATH_SYMLINK' => SessionFileBrowserNotice.symlinkNotReadable,
    'NOT_REGULAR_FILE' => SessionFileBrowserNotice.notRegularFile,
    'NOT_DIRECTORY' => SessionFileBrowserNotice.notDirectory,
    'BAD_PARAM' => SessionFileBrowserNotice.invalidRequest,
    'FS_DOWNLOAD_TOO_LARGE' => SessionFileBrowserNotice.downloadTooLarge,
    'FS_REMOTE_DISABLED' => SessionFileBrowserNotice.remoteDisabled,
    _ => SessionFileBrowserNotice.failed,
  };
}

/// Provider for one session's read-only file browser.
final AutoDisposeNotifierProviderFamily<
  SessionFileBrowserController,
  SessionFileBrowserState,
  SessionDetailKey
>
sessionFileBrowserControllerProvider = NotifierProvider.autoDispose
    .family<
      SessionFileBrowserController,
      SessionFileBrowserState,
      SessionDetailKey
    >(SessionFileBrowserController.new);

/// Normalizes a cwd-relative POSIX path for UI navigation.
String normalizeSessionFilePath(String path) {
  final normalized = path.replaceAll(r'\', '/').trim();
  if (normalized.isEmpty || normalized == '.') {
    return '';
  }
  return normalized
      .split('/')
      .where((part) => part.isNotEmpty && part != '.')
      .join('/');
}

/// Human-readable broker error mapping for file browser failures.
String userMessageForSessionFileError(BrokerException exception) {
  return switch (exception.error?.code) {
    'NOT_FOUND' => 'Path not found.',
    'NO_CWD' => 'This session does not have a current working directory yet.',
    'PATH_ESCAPE' => 'That path is outside the session workspace.',
    'PATH_SYMLINK' => 'Symlink targets are not readable from the app.',
    'NOT_REGULAR_FILE' => 'Only regular files can be previewed or downloaded.',
    'NOT_DIRECTORY' => 'That path is not a directory.',
    'BAD_PARAM' => 'The file request was invalid.',
    'FS_DOWNLOAD_TOO_LARGE' =>
      'The file is larger than the broker download cap.',
    'FS_REMOTE_DISABLED' =>
      'Remote file browsing is disabled. Set COSYNCING_FS_REMOTE_ENABLED=1 '
          'on the broker host.',
    _ => userFacingMessage(
      exception,
      lead: "Couldn't access this file.",
    ),
  };
}

/// Decodes a broker `/fs/read` payload to text.
String decodeSessionFileReadText(FsReadResult result) {
  if (result.encoding == 'base64') {
    return utf8.decode(base64.decode(result.data), allowMalformed: true);
  }
  return result.data;
}

/// MIME-driven preview eligibility.
bool isPreviewableMime(String? mimeType) {
  final mime = mimeType?.split(';').first.trim().toLowerCase();
  if (mime == null || mime.isEmpty) {
    return false;
  }
  return mime.startsWith('text/') ||
      mime == 'application/json' ||
      mime == 'application/xml' ||
      mime == 'application/javascript' ||
      mime == 'application/x-yaml';
}

bool _isPreviewableEntry(FsDirEntry entry) {
  if (entry.type != 'file') {
    return false;
  }
  return true;
}

int _entryTypeRank(FsDirEntry entry) {
  return switch (entry.type) {
    'directory' => 0,
    'file' => 1,
    'other' => 2,
    'symlink' => 3,
    _ => 2,
  };
}
