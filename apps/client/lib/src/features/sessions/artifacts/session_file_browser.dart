import 'dart:convert';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/file_reference.dart';
import 'package:cosyncing_client/src/features/sessions/transcript/session_file_link_scope.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Default byte cap for read-only file previews.
///
/// Mirrors the broker's default `/fs/read` cap. It bounds the PREVIEW only:
/// the workspace and signed-artifact download routes both support Range, so a
/// download is chunked and resumable however large the file is.
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
    this.anchorLine,
    this.anchorColumn,
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

  /// 1-based line the viewer should scroll to, when the mention carried one.
  final int? anchorLine;

  /// 1-based column to highlight inside [anchorLine], when one was carried.
  final int? anchorColumn;

  /// Lines the broker actually returned.
  ///
  /// `/fs/read` reads from byte 0 with no offset, so this is a prefix of the
  /// file whenever [truncated] is true — which is exactly when an anchor can
  /// point past the end of what was delivered.
  int get previewedLineCount =>
      text.isEmpty ? 0 : '\n'.allMatches(text).length + 1;

  /// Whether [anchorLine] names a line the broker did not deliver.
  ///
  /// The viewer must say so rather than silently landing on line 1: an honest
  /// "line N is beyond the previewed prefix" keeps a truncated read from
  /// reading as a complete one.
  bool get anchorBeyondPreview =>
      anchorLine != null && anchorLine! > previewedLineCount;
}

/// Immutable state for one session file browser.
@immutable
class SessionFileBrowserState {
  /// Creates state.
  SessionFileBrowserState({
    this.phase = SessionFileBrowserPhase.idle,
    this.currentPath = '',
    this.gate = SessionFileLinkGate.unknown,
    this.result,
    this.preview,
    this.errorCode,
    this.notice,
    this.noticeArgument,
    String? technicalDetail,
  }) : technicalDetail = boundedTechnicalDetail(technicalDetail);

  /// Current load phase.
  final SessionFileBrowserPhase phase;

  /// Cached outcome of this attach's single workspace-file-API gate probe.
  ///
  /// Held here rather than on a mention because the gate is a property of the
  /// host connection: one probe per attach answers it for every link on the
  /// page, and no amount of scrolling re-asks.
  final SessionFileLinkGate gate;

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
    SessionFileLinkGate? gate,
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
      gate: gate ?? this.gate,
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

/// Source-qualified identity for one session's read-only file browser.
///
/// [SessionDetailKey] alone is NOT this identity. Both things this controller
/// holds are facts about a HOST: the trust-gate verdict ("does this machine
/// serve workspace files to remote clients") and the loaded listing (that
/// machine's directory contents). Two brokers can hand out the same native
/// tool/session id, so a `(tool, sessionId)`-only key let a switch of the
/// active profile to a different broker keep the previous host's open/closed
/// verdict and its files on screen.
///
/// The qualifier is the exact `RosterSource.storageKey` — profile AND endpoint
/// AND incarnation — the same one the inline-schedule diagnostics and model
/// preference keys use: a profile is an editable pointer, so re-pointing it at
/// another machine keeps its id and an id-keyed verdict would be shown as the
/// new machine's.
@immutable
final class SessionFileBrowserKey {
  /// Creates a source-qualified file browser identity.
  const SessionFileBrowserKey({
    required this.brokerScopeKey,
    required this.session,
  });

  /// `RosterSource.storageKey` of the broker being browsed, or null when no
  /// profile is active.
  final String? brokerScopeKey;

  /// The session within that broker.
  final SessionDetailKey session;

  @override
  bool operator ==(Object other) =>
      other is SessionFileBrowserKey &&
      other.brokerScopeKey == brokerScopeKey &&
      other.session == session;

  @override
  int get hashCode => Object.hash(brokerScopeKey, session);

  @override
  String toString() =>
      'SessionFileBrowserKey(${brokerScopeKey ?? 'no-profile'} '
      '${session.tool}/${session.sessionId})';
}

/// The active broker's file browser identity for one session.
///
/// One place derives the qualifier, so the page, the Files panel and the gate
/// probe all land on the same notifier — and a profile switch moves them
/// together onto a fresh one instead of leaving some watchers behind.
final AutoDisposeProviderFamily<SessionFileBrowserKey, SessionDetailKey>
sessionFileBrowserKeyProvider = Provider.autoDispose
    .family<SessionFileBrowserKey, SessionDetailKey>((ref, session) {
      return SessionFileBrowserKey(
        brokerScopeKey: ref.watch(
          activeBrokerProfileProvider.select(
            (profile) => RosterSource.of(profile)?.storageKey,
          ),
        ),
        session: session,
      );
    });

/// Controller for the read-only file browser slice.
class SessionFileBrowserController
    extends
        AutoDisposeFamilyNotifier<
          SessionFileBrowserState,
          SessionFileBrowserKey
        > {
  @override
  SessionFileBrowserState build(SessionFileBrowserKey arg) {
    return SessionFileBrowserState();
  }

  /// Whether a gate probe is already in flight for this session.
  bool _probing = false;

  /// Probes the workspace-file gate exactly once per attach.
  ///
  /// Reuses the workspace-root `/fs?path=` call the Files tab already makes, so
  /// a session that later opens Files pays for one request, not two, and a
  /// session that never opens Files still learns whether its mentions can be
  /// links at all. Idempotent: once [SessionFileBrowserState.gate] is resolved
  /// this is a no-op, which is what keeps scrolling from ever re-asking.
  Future<void> probeGate() async {
    if (_probing || state.gate != SessionFileLinkGate.unknown) return;
    if (state.phase != SessionFileBrowserPhase.idle) return;
    _probing = true;
    try {
      await load();
    } finally {
      _probing = false;
    }
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
      final result = await repository.listPath(arg.session, path: normalized);
      state = SessionFileBrowserState(
        phase: SessionFileBrowserPhase.ready,
        currentPath: result.path,
        gate: SessionFileLinkGate.open,
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
        gate: _gateAfterFailure(path: normalized, code: null),
        notice: SessionFileBrowserNotice.failed,
        technicalDetail: failureDetail(e),
      );
    }
  }

  /// Opens one transcript file mention in this session's Files surface.
  ///
  /// One `/fs?path=` stat decides the shape — the broker owns every filesystem
  /// fact, and the client re-decides none of them. A directory becomes the
  /// current listing; a file is read and returned as a preview carrying the
  /// mention's line anchor. Every error code keeps the notice the Files surface
  /// already localizes, shown in place: no tab is forced, and nothing retries.
  ///
  /// The raw path is sent exactly as the adapter recorded it. Absolute and `~`
  /// forms are relativized against the session root by the broker, which is the
  /// only side that can `realpath` either end.
  Future<SessionFilePreview?> openReference(
    SessionFileReference reference,
  ) async {
    final requested = reference.rawPath;
    state = state.copyWith(
      phase: SessionFileBrowserPhase.loading,
      notice: SessionFileBrowserNotice.loading,
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
      return null;
    }

    final FsDirectoryResult stat;
    try {
      stat = await repository.listPath(arg.session, path: requested);
    } on BrokerException catch (e) {
      state = _stateForBrokerException(path: state.currentPath, exception: e);
      return null;
    } on Object catch (e) {
      state = state.copyWith(
        phase: SessionFileBrowserPhase.error,
        notice: SessionFileBrowserNotice.failed,
        technicalDetail: failureDetail(e),
      );
      return null;
    }

    if (stat.stat.isDirectory) {
      state = SessionFileBrowserState(
        phase: SessionFileBrowserPhase.ready,
        currentPath: stat.path,
        gate: SessionFileLinkGate.open,
        result: stat,
      );
      return null;
    }

    if (!stat.stat.isRegularFile) {
      state = state.copyWith(
        phase: SessionFileBrowserPhase.ready,
        gate: SessionFileLinkGate.open,
        notice: SessionFileBrowserNotice.notRegularFile,
      );
      return null;
    }

    // The broker's resolved, workspace-relative spelling — never the client's
    // guess at one — is what the read and the parent listing both use.
    final resolvedPath = stat.stat.path;
    state = state.copyWith(
      phase: SessionFileBrowserPhase.previewing,
      gate: SessionFileLinkGate.open,
      notice: SessionFileBrowserNotice.reading,
      noticeArgument: _basename(resolvedPath),
    );

    final FsReadResult read;
    try {
      read = await repository.readFile(arg.session, path: resolvedPath);
    } on BrokerException catch (e) {
      state = _stateForBrokerException(path: state.currentPath, exception: e);
      return null;
    } on Object catch (e) {
      state = state.copyWith(
        phase: SessionFileBrowserPhase.error,
        notice: SessionFileBrowserNotice.failed,
        technicalDetail: failureDetail(e),
      );
      return null;
    }

    if (!isPreviewableRead(read)) {
      state = state.copyWith(
        phase: SessionFileBrowserPhase.ready,
        notice: SessionFileBrowserNotice.previewMimeUnavailable,
        noticeArgument: read.mimeType,
      );
      await _listContaining(repository, resolvedPath);
      return null;
    }

    final preview = SessionFilePreview(
      path: read.path,
      displayName: _basename(resolvedPath),
      mimeType: read.mimeType,
      size: read.size,
      limit: read.limit,
      truncated: read.truncated,
      text: decodeSessionFileReadText(read),
      anchorLine: reference.line,
      anchorColumn: reference.column,
    );
    state = state.copyWith(
      phase: SessionFileBrowserPhase.ready,
      preview: preview,
      notice: read.truncated ? SessionFileBrowserNotice.previewTruncated : null,
      noticeArgument: read.truncated ? read.limit.toString() : null,
      clearError: true,
      clearNotice: !read.truncated,
    );
    // Best-effort: leaving the surface on the file's own directory is what
    // makes "look, then come back" land somewhere useful. A failure here must
    // not discard the preview the user asked for, so it is not surfaced.
    await _listContaining(repository, resolvedPath);
    return preview;
  }

  /// Lists the directory containing [path], keeping the current preview.
  Future<void> _listContaining(
    SessionFileBrowserRepository repository,
    String path,
  ) async {
    final parent = SessionFileReference(rawPath: path).parent.rawPath;
    final normalized = normalizeSessionFilePath(parent);
    if (normalized == state.currentPath && state.result != null) return;
    try {
      final listing = await repository.listPath(arg.session, path: normalized);
      state = state.copyWith(currentPath: listing.path, result: listing);
    } on Object {
      // The preview stands on its own; a failed sibling listing is not an error
      // the reader can act on.
    }
  }

  /// Closes the open preview, keeping the listing behind it.
  ///
  /// The viewer is a pane now, not a dialog, so closing it is a state change
  /// rather than a `Navigator.pop`. The listing is deliberately kept: the
  /// reader closed a file, not the workspace.
  void closePreview() {
    if (state.preview == null) return;
    state = state.copyWith(clearPreview: true, clearNotice: true);
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
    if (entry.type != 'file') {
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
      final read = await repository.readFile(arg.session, path: entry.path);
      if (!isPreviewableRead(read)) {
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
        gate: SessionFileLinkGate.open,
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
        gate: SessionFileLinkGate.remoteDisabled,
        errorCode: code,
        notice: SessionFileBrowserNotice.remoteDisabled,
        technicalDetail: exception.message,
      );
    }
    return SessionFileBrowserState(
      phase: SessionFileBrowserPhase.error,
      currentPath: path,
      gate: _gateAfterFailure(path: path, code: code),
      errorCode: code,
      notice: _noticeForSessionFileError(code),
      technicalDetail: exception.message,
    );
  }

  /// The gate outcome a failed request implies, if any.
  ///
  /// Only a WORKSPACE-ROOT request can decide the gate: a `NOT_FOUND` on a
  /// nested path means that file is gone, while the same code on the root means
  /// the session has no working directory — the fs routes short-circuit
  /// `NO_CWD` to 404 ahead of the error mapper, so the two arrive identically
  /// and only the requested path tells them apart. A nested failure leaves an
  /// already-resolved gate exactly where it was.
  SessionFileLinkGate _gateAfterFailure({
    required String path,
    required String? code,
  }) {
    if (code == 'FS_REMOTE_DISABLED') return SessionFileLinkGate.remoteDisabled;
    if (path.isNotEmpty) return state.gate;
    if (code == 'NO_CWD' || code == 'NOT_FOUND') {
      return SessionFileLinkGate.noWorkspace;
    }
    return state.gate == SessionFileLinkGate.unknown
        ? SessionFileLinkGate.unavailable
        : state.gate;
  }
}

String _basename(String path) {
  final normalized = path.replaceAll(r'\', '/');
  final trimmed = normalized.length > 1 && normalized.endsWith('/')
      ? normalized.substring(0, normalized.length - 1)
      : normalized;
  final index = trimmed.lastIndexOf('/');
  final name = index < 0 ? trimmed : trimmed.substring(index + 1);
  return name.isEmpty ? path : name;
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

/// Provider for one session's read-only file browser, on one exact broker.
final AutoDisposeNotifierProviderFamily<
  SessionFileBrowserController,
  SessionFileBrowserState,
  SessionFileBrowserKey
>
sessionFileBrowserControllerProvider = NotifierProvider.autoDispose
    .family<
      SessionFileBrowserController,
      SessionFileBrowserState,
      SessionFileBrowserKey
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
      'The file is larger than the server download limit.',
    'FS_REMOTE_DISABLED' =>
      'Workspace file browsing is disabled for HTTP clients. Enable '
          'features.httpWorkspaceBrowsing in the broker configuration and '
          'restart the broker.',
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
///
/// A hint, never the whole answer: the broker guesses the label from the path
/// suffix, so a broker older than the widened suffix table returns
/// `application/octet-stream` for most source. [isPreviewableRead] is what the
/// read path asks.
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

/// Whether a `/fs/read` payload can be shown as text.
///
/// Brokers upgrade independently of clients, so refusing on a MIME label the
/// broker guessed from an extension is the bug that keeps `.py`, `.rs` and
/// `.toml` from opening at all. `encoding == 'utf8'` is the broker's own
/// byte-level finding (`looksUtf8ish`, `artifacts/fs-browse.ts`) that the
/// payload decoded cleanly, and it outranks the guess.
///
/// `base64` gets no such bypass — [decodeSessionFileReadText] would decode
/// those bytes with `allowMalformed: true` and hand back mojibake — so a base64
/// read is still judged on its label alone, exactly as today. That keeps every
/// binary refusal standing (`image/png`, `application/pdf`,
/// `application/octet-stream` all fail the label test) without retracting the one
/// case the label does admit: a `text/*` file the broker could not decode as
/// UTF-8. A binary renderer is what replaces that, not this predicate.
bool isPreviewableRead(FsReadResult read) {
  if (read.encoding == 'utf8') {
    return true;
  }
  return isPreviewableMime(read.mimeType);
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
