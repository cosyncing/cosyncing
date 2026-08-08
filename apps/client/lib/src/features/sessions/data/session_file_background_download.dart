import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_artifact_file_service.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_artifact_transfer.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_artifact_transfer_worker.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_detail_state.dart';
import 'package:flutter/foundation.dart';

/// App-level lifecycle status of a native background download task.
///
/// Mirrors the subset of `background_downloader` `TaskStatus` values the
/// coordinator reconciles into the Drift ledger. The engine adapter maps the
/// package enum onto this type so the coordinator never imports the package.
enum BackgroundDownloadTaskStatus {
  /// Accepted by the native platform and waiting to start.
  enqueued,

  /// Actively downloading.
  running,

  /// Downloaded successfully (final).
  complete,

  /// Failed with an exception (final).
  failed,

  /// Canceled by the user or the system (final).
  canceled,

  /// Paused and possibly resumable.
  paused,

  /// URL not found / 404 (final).
  notFound,

  /// Failed and waiting for a retry backoff.
  waitingToRetry,
}

/// Immutable request to start one native background workspace-file download.
@immutable
class BackgroundSessionDownloadRequest {
  /// Creates a [BackgroundSessionDownloadRequest].
  const BackgroundSessionDownloadRequest({
    required this.taskId,
    required this.url,
    required this.headers,
    required this.directory,
    required this.stagingFileName,
  });

  /// Native task id. Always equal to the ledger transfer id so the record can
  /// be reconciled back to exactly one row.
  final String taskId;

  /// Fully-resolved broker `fs/download` URL, including the `path` query.
  final String url;

  /// Broker auth headers placed on the task.
  ///
  /// The token is never logged. See the FG8 log for the honest note that
  /// `background_downloader` durably persists task headers in its own tracking
  /// database and native session configuration for retry/resume.
  final Map<String, String> headers;

  /// Cache subdirectory (relative to the engine base directory) the native
  /// engine downloads into. Matches the finalizer's cache location.
  final String directory;

  /// Staging filename the native engine writes; finalization renames it to the
  /// safe cache name with MIME-extension parity and collision handling.
  final String stagingFileName;
}

/// Reconcilable snapshot of one native download task, drawn from the engine's
/// own tracking database or a live task callback.
@immutable
class BackgroundDownloadRecord {
  /// Creates a [BackgroundDownloadRecord].
  const BackgroundDownloadRecord({
    required this.taskId,
    required this.status,
    this.bytesTransferred,
    this.totalBytes,
    this.filePath,
    this.mimeType,
    this.errorMessage,
  });

  /// Native task id (equals the ledger transfer id).
  final String taskId;

  /// Current native lifecycle status.
  final BackgroundDownloadTaskStatus status;

  /// Bytes flushed so far when known.
  final int? bytesTransferred;

  /// Total expected bytes when known.
  final int? totalBytes;

  /// Absolute path to the downloaded file when [status] is
  /// [BackgroundDownloadTaskStatus.complete].
  final String? filePath;

  /// Response MIME type when the native task reported one.
  final String? mimeType;

  /// Failure detail when [status] is a failure state.
  final String? errorMessage;
}

/// Repo-owned seam wrapping the `background_downloader` package.
///
/// The worker and coordinator consume only this interface so all reconciliation
/// logic is unit-testable with a fake; no test depends on real platform
/// channels. Mirrors the `ResumableSessionArtifactFileService` seam style.
abstract interface class SessionFileBackgroundDownloader {
  /// Whether native background downloads actually background on this platform
  /// (iOS URLSession background sessions / Android WorkManager). False
  /// everywhere else so callers fall through to the foreground path unchanged.
  bool get isSupported;

  /// Ensures the engine and its tracking database are initialized. Idempotent.
  Future<void> ensureStarted();

  /// Enqueues a native background download. Returns whether it was accepted.
  Future<bool> enqueue(BackgroundSessionDownloadRequest request);

  /// Loads all currently tracked records for restart reconciliation.
  Future<List<BackgroundDownloadRecord>> loadRecords();

  /// Loads one tracked record by task id.
  Future<BackgroundDownloadRecord?> recordFor(String taskId);

  /// Cancels a running or enqueued native task. Best-effort.
  Future<void> cancel(String taskId);

  /// Drops a tracked record after it has been finalized into the ledger.
  Future<void> forget(String taskId);

  /// Live status/progress updates for enqueued tasks.
  Stream<BackgroundDownloadRecord> updates();
}

/// Drives the Drift transfer ledger from native background download tasks.
///
/// The ledger stays the single source of truth the UI reads. This coordinator
/// only reconciles the engine's task status onto ledger rows it owns (matching
/// the active broker profile), never resurrecting a terminal row and never
/// finalizing another profile's row.
class SessionFileBackgroundDownloadCoordinator {
  /// Creates a [SessionFileBackgroundDownloadCoordinator].
  SessionFileBackgroundDownloadCoordinator({
    required this.engine,
    required this.transferController,
    required this.finalizer,
    required this.brokerProfileId,
    required this.brokerClient,
  });

  /// Native download engine seam.
  final SessionFileBackgroundDownloader engine;

  /// Authoritative transfer ledger.
  final SessionArtifactTransferController transferController;

  /// Completed-download landing capability.
  final BackgroundSessionDownloadFinalizer finalizer;

  /// Exact broker that owns downloads started by this instance.
  ///
  /// Carries `RosterSource.storageKey` (profile AND endpoint), matching the
  /// stamp on ledger rows: a background download begun against one machine
  /// must never be reconciled or finalized through another machine's client
  /// after an endpoint edit that keeps the profile id.
  final String? brokerProfileId;

  /// Active broker client used to resolve the download URL and auth headers.
  final BrokerClient? brokerClient;

  StreamSubscription<BackgroundDownloadRecord>? _updatesSubscription;
  final _finalizing = <String>{};

  /// Whether native background downloads are available here.
  bool get isSupported => engine.isSupported;

  /// Initializes the engine, subscribes to live updates, and reconciles any
  /// tracked records left by a previous app run. Fails safe: if the native
  /// engine is unavailable in this environment, the foreground path still
  /// works, so all engine errors are swallowed here.
  Future<void> bootstrap() async {
    if (!isSupported) {
      return;
    }
    try {
      await engine.ensureStarted();
      listen();
      await reconcile();
    } on Object {
      // Engine/platform storage unavailable (e.g. under unit tests).
    }
  }

  /// Subscribes to live task updates. Idempotent.
  void listen() {
    _updatesSubscription ??= engine.updates().listen(
      (record) => unawaited(_reconcileRecordSafely(record)),
      onError: (Object _) {},
    );
  }

  /// [_reconcileRecord] with the same failure containment [reconcile] applies.
  ///
  /// A finalization error on a live update must mark the owned row failed, not
  /// escape as an unhandled async error that leaves the row pinned `running`
  /// until the next restart reconcile.
  Future<void> _reconcileRecordSafely(BackgroundDownloadRecord record) async {
    try {
      await _reconcileRecord(record);
    } on Object catch (e) {
      final transfer = transferController.transferById(record.taskId);
      if (transfer != null && _owns(transfer)) {
        transferController.markFailed(
          record.taskId,
          userFacingMessage(
            e,
            lead: "Couldn't update this background download.",
          ),
        );
      }
    }
  }

  /// Cancels the live subscription.
  Future<void> dispose() async {
    await _updatesSubscription?.cancel();
    _updatesSubscription = null;
  }

  /// Starts a native background download for a queued ledger row.
  Future<SessionArtifactTransferWorkerResult> startDownload({
    required String transferId,
    required SessionDetailKey sessionKey,
    required String path,
    required String fileName,
    required bool hasActiveBrokerClient,
    String? mimeType,
  }) async {
    final client = brokerClient;
    if (!hasActiveBrokerClient || client == null) {
      const message = 'No active broker client for file download.';
      transferController.markFailed(transferId, message);
      return _failed(transferId, message);
    }
    try {
      await engine.ensureStarted();
      listen();
      final url = _downloadUrl(
        client,
        sessionKey.tool,
        sessionKey.sessionId,
        path,
      );
      final headers = client.resolver.authHeaders;
      final safeTaskId = DefaultSessionArtifactFileService.sanitizeFileName(
        transferId,
      );
      final staging = '$safeTaskId.part';
      transferController.markRunning(
        transferId,
        message: 'Downloading in the background...',
      );
      final accepted = await engine.enqueue(
        BackgroundSessionDownloadRequest(
          taskId: transferId,
          url: url,
          headers: headers,
          directory: finalizer.backgroundDownloadSubdirectory,
          stagingFileName: staging,
        ),
      );
      if (!accepted) {
        const message = 'The background download engine rejected the task.';
        transferController.markFailed(transferId, message);
        return _failed(transferId, message);
      }
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.enqueuedInBackground,
        message: 'Downloading $fileName in the background',
      );
    } on Object catch (e) {
      final message = userFacingMessage(
        e,
        lead: "Couldn't start the background download.",
      );
      transferController.markFailed(transferId, message);
      return _failed(transferId, message);
    }
  }

  /// Cancels the native task backing [transferId]. Best-effort; the ledger row
  /// is canceled by the worker regardless.
  Future<void> cancel(String transferId) async {
    try {
      await engine.cancel(transferId);
    } on Object {
      // Native cancel is best-effort; a stale/finished task may be gone.
    }
  }

  /// Reconciles every tracked native record onto the ledger.
  ///
  /// Called on a fresh worker after app restart so a background-completed
  /// download finalizes its ledger row even if the app was killed mid-transfer.
  Future<void> reconcile() async {
    final List<BackgroundDownloadRecord> records;
    try {
      records = await engine.loadRecords();
    } on Object {
      // Engine/platform storage unavailable (e.g. under unit tests). Nothing
      // to reconcile.
      return;
    }
    for (final record in records) {
      await _reconcileRecordSafely(record);
    }
  }

  Future<void> _reconcileRecord(BackgroundDownloadRecord record) async {
    final transfer = transferController.transferById(record.taskId);
    // Unknown row, or a row owned by a different broker profile: never
    // reconcile it into this profile's ledger (invariant: profile scoping).
    if (transfer == null || !_owns(transfer)) {
      return;
    }
    switch (record.status) {
      case BackgroundDownloadTaskStatus.enqueued:
      case BackgroundDownloadTaskStatus.running:
      case BackgroundDownloadTaskStatus.waitingToRetry:
        if (_isResumable(transfer)) {
          transferController
            ..markRunning(
              record.taskId,
              message: 'Downloading in the background...',
            )
            ..markProgress(
              record.taskId,
              bytesTransferred:
                  record.bytesTransferred ?? transfer.bytesTransferred ?? 0,
              totalBytes: record.totalBytes ?? transfer.totalBytes,
            );
        }
      case BackgroundDownloadTaskStatus.complete:
        await _finalize(record, transfer);
      case BackgroundDownloadTaskStatus.failed:
      case BackgroundDownloadTaskStatus.notFound:
        if (!_isTerminal(transfer)) {
          transferController.markFailed(
            record.taskId,
            record.errorMessage ?? 'Background download failed.',
          );
        }
        // Forget even when the row was already terminal, so stale records
        // cannot accumulate in the engine's tracking database.
        await engine.forget(record.taskId);
      case BackgroundDownloadTaskStatus.canceled:
        if (!_isTerminal(transfer)) {
          transferController.markCanceled(record.taskId);
        }
        await engine.forget(record.taskId);
      case BackgroundDownloadTaskStatus.paused:
        // Leave the row running; a resume will produce a fresh update.
        break;
    }
  }

  Future<void> _finalize(
    BackgroundDownloadRecord record,
    SessionArtifactTransfer transfer,
  ) async {
    // Idempotent, and never resurrects a terminal row: a completion callback
    // and a restart reconcile can both fire, and a canceled/failed row must not
    // be finalized by a late completion.
    if (transfer.status == SessionArtifactTransferStatus.cached ||
        _isTerminal(transfer)) {
      // A late completion for an already-settled row: drop the stale native
      // record so the engine's tracking database cannot grow unboundedly.
      await engine.forget(record.taskId);
      return;
    }
    if (!_finalizing.add(record.taskId)) {
      return;
    }
    try {
      final downloadedPath = record.filePath;
      if (downloadedPath == null) {
        transferController.markFailed(
          record.taskId,
          'Background download completed without a file path.',
        );
        return;
      }
      final cached = await finalizer.finalizeBackgroundDownload(
        downloadedFilePath: downloadedPath,
        fileName: transfer.fileName,
        mimeType: record.mimeType ?? transfer.contentType,
      );
      // markCachedWithPersistence clears the download checkpoint and durably
      // commits, exactly as the foreground path does.
      await transferController.markCachedWithPersistence(
        record.taskId,
        cached,
        message: 'Downloaded ${cached.fileName}',
      );
      await engine.forget(record.taskId);
    } finally {
      _finalizing.remove(record.taskId);
    }
  }

  bool _owns(SessionArtifactTransfer transfer) {
    final active = brokerProfileId;
    final owner = transfer.brokerProfileId;
    return active != null && owner != null && owner == active;
  }

  bool _isResumable(SessionArtifactTransfer transfer) =>
      transfer.status == SessionArtifactTransferStatus.queued ||
      transfer.status == SessionArtifactTransferStatus.running;

  bool _isTerminal(SessionArtifactTransfer transfer) =>
      switch (transfer.status) {
        SessionArtifactTransferStatus.completed ||
        SessionArtifactTransferStatus.canceled ||
        SessionArtifactTransferStatus.failed => true,
        _ => false,
      };

  SessionArtifactTransferWorkerResult _failed(
    String transferId,
    String message,
  ) => SessionArtifactTransferWorkerResult(
    transferId: transferId,
    outcome: SessionArtifactTransferWorkerOutcome.failed,
    message: message,
  );

  String _downloadUrl(
    BrokerClient client,
    String tool,
    String sessionId,
    String path,
  ) {
    final base = client.resolver.fsDownloadEndpoint(tool, sessionId);
    return Uri.parse(
      base,
    ).replace(queryParameters: {'path': path}).toString();
  }
}
