import 'dart:async';
import 'dart:typed_data';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:broker_crypto/broker_crypto.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/data/background_downloader_engine.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_artifact_descriptor.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_artifact_file_service.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_artifact_transfer.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_attachment_picker.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_file_background_download.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_list_state.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

const String _sessionFileTransferSourcePrefix = 'session-file:';

final _canonicalContentHash = RegExp(r'^sha256:[0-9a-f]{64}$');

const _uploadResumeUnavailableMessage =
    'Upload cannot be resumed after app restart. '
    'Start a new upload from Session Detail.';
const _uploadResumeAlreadyInProgressMessage =
    'Upload resume is already in progress for this transfer.';
const _artifactReferenceMismatchMessage =
    'Artifact reference is not bound to this broker, session, and version.';

/// Maximum original byte size sent through the legacy WebSocket `file` frame.
///
/// Larger attachments use broker chunked-upload REST so progress, cancellation,
/// and retry remain visible through the durable transfer ledger.
const int legacyWebSocketFileFrameMaxBytes = 256 * 1024;

/// Client-side chunk size for the first resumable upload implementation.
const int chunkedUploadChunkBytes = 256 * 1024;

/// Foreground transfer execution outcomes.
enum SessionArtifactTransferWorkerOutcome {
  /// Download/export completed.
  completed,

  /// Artifact bytes were cached for preview.
  cached,

  /// User dismissed or canceled the transfer.
  canceled,

  /// Transfer failed.
  failed,

  /// A native background download was accepted and continues out of process.
  ///
  /// The ledger row is `running`; the background coordinator finalizes it to
  /// `cached` on task completion or on the next restart reconcile.
  enqueuedInBackground,
}

/// Result returned by foreground artifact transfer work.
@immutable
class SessionArtifactTransferWorkerResult {
  /// Creates a [SessionArtifactTransferWorkerResult].
  const SessionArtifactTransferWorkerResult({
    required this.transferId,
    required this.outcome,
    this.cachedFile,
    this.exportedPath,
    this.stagedUpload,
    this.message = '',
  });

  /// Transfer ledger id.
  final String transferId;

  /// Final worker outcome.
  final SessionArtifactTransferWorkerOutcome outcome;

  /// Cached file metadata, when available.
  final SessionArtifactCachedFile? cachedFile;

  /// Exported destination path, when available.
  final String? exportedPath;

  /// Opaque completed upload ready to be consumed by a prompt.
  final UploadCompleteResult? stagedUpload;

  /// User-facing detail or error message.
  final String message;

  /// Whether the worker completed or successfully started useful file work.
  ///
  /// [SessionArtifactTransferWorkerOutcome.enqueuedInBackground] counts as
  /// success because the native task was accepted; its terminal result arrives
  /// through ledger reconciliation, not this synchronous return.
  bool get succeeded =>
      outcome == SessionArtifactTransferWorkerOutcome.completed ||
      outcome == SessionArtifactTransferWorkerOutcome.cached ||
      outcome == SessionArtifactTransferWorkerOutcome.enqueuedInBackground;
}

/// App provider for foreground artifact transfer execution.
final sessionArtifactTransferWorkerProvider =
    Provider<SessionArtifactTransferWorker>((ref) {
      // The worker is bound to the EXACT broker — (profile, endpoint) — via
      // `RosterSource.storageKey`, not the profile id. Transfers move file
      // bytes over the network, so their ownership is broker authority: after
      // an endpoint edit that keeps the id, an id-keyed worker accepted the
      // old machine's rows and executed them through the NEW machine's
      // client. Watching the scope key also rebuilds this worker (and the
      // background coordinator) the moment the profile points elsewhere.
      final brokerProfileId = ref.watch(
        activeBrokerProfileProvider.select(
          (profile) => RosterSource.of(profile)?.storageKey,
        ),
      );
      final brokerClient = ref
          .watch(brokerClientProvider)
          .maybeWhen(data: (value) => value, orElse: () => null);
      final fileService = ref.watch(sessionArtifactFileServiceProvider);
      final transferController = ref.read(
        sessionArtifactTransferControllerProvider.notifier,
      );

      // Attach the native background download coordinator only where the engine
      // truly backgrounds (iOS/Android) and the file service can finalize a
      // completed download through the shared cache path. Elsewhere this is
      // null and the worker keeps the foreground resumable path unchanged.
      final engine = ref.watch(sessionFileBackgroundDownloaderProvider);
      final finalizer = fileService is BackgroundSessionDownloadFinalizer
          ? fileService as BackgroundSessionDownloadFinalizer
          : null;
      SessionFileBackgroundDownloadCoordinator? backgroundCoordinator;
      if (engine != null && engine.isSupported && finalizer != null) {
        final coordinator = SessionFileBackgroundDownloadCoordinator(
          engine: engine,
          transferController: transferController,
          finalizer: finalizer,
          brokerProfileId: brokerProfileId,
          brokerClient: brokerClient,
        );
        // Reconcile any download that completed while the app was gone, and
        // start listening for live task updates. Fails safe off-device.
        unawaited(coordinator.bootstrap());
        ref.onDispose(coordinator.dispose);
        backgroundCoordinator = coordinator;
      }

      return SessionArtifactTransferWorker(
        brokerProfileId: brokerProfileId,
        brokerClient: brokerClient,
        fileService: fileService,
        transferController: transferController,
        sessionAttachmentPicker: ref.read(sessionAttachmentPickerProvider),
        backgroundCoordinator: backgroundCoordinator,
      );
    });

/// Foreground artifact transfer worker.
///
/// Owns ledger transitions for cache/export/preview file work. UI controllers
/// should map [SessionArtifactTransferWorkerResult] to view state instead of
/// duplicating transfer lifecycle steps.
class SessionArtifactTransferWorker {
  /// Creates a [SessionArtifactTransferWorker].
  SessionArtifactTransferWorker({
    required this.fileService,
    required this.transferController,
    this.brokerProfileId,
    this.brokerClient,
    this.sessionAttachmentPicker,
    this.backgroundCoordinator,
  });

  /// Broker REST client used for chunked uploads.
  final BrokerClient? brokerClient;

  /// Native background download coordinator, when the platform backgrounds
  /// downloads (iOS/Android). Null everywhere else.
  final SessionFileBackgroundDownloadCoordinator? backgroundCoordinator;

  /// Exact broker bound to this worker/client instance.
  ///
  /// Carries `RosterSource.storageKey` — profile AND endpoint — because this
  /// is the value stamped onto every row the worker queues and the value
  /// [_ownsTransfer] admits network work by. A bare profile id survives an
  /// endpoint edit; the composite never matches after one, so another
  /// machine's rows (and every legacy bare-id row) fail closed here.
  final String? brokerProfileId;

  /// File cache/export backend.
  final SessionArtifactFileService fileService;

  /// Transfer ledger controller.
  final SessionArtifactTransferController transferController;

  /// Picker boundary for explicit upload resume flow.
  final SessionAttachmentPicker? sessionAttachmentPicker;

  final _cancellationTokens = <String, SessionArtifactCancellationToken>{};
  final _chunkedUploadPayloads = <String, _ChunkedUploadPayload>{};
  final _uploadResumeInProgress = <String>{};

  /// Downloads and exports an artifact.
  Future<SessionArtifactTransferWorkerResult> downloadArtifact({
    required SessionDetailKey sessionKey,
    required SessionArtifactDescriptor descriptor,
    required bool hasActiveBrokerClient,
  }) async {
    final transferId = transferController.queueTransfer(
      sessionKey: sessionKey,
      descriptor: descriptor,
      direction: SessionArtifactTransferDirection.download,
      brokerProfileId: brokerProfileId,
    );
    return _runDownload(
      transferId: transferId,
      sessionKey: sessionKey,
      descriptor: descriptor,
      hasActiveBrokerClient: hasActiveBrokerClient,
    );
  }

  /// Downloads and exports a read-only session workspace file.
  Future<SessionArtifactTransferWorkerResult> downloadSessionFile({
    required SessionDetailKey sessionKey,
    required String path,
    required String fileName,
    required bool hasActiveBrokerClient,
    String? mimeType,
    int? byteLength,
  }) async {
    final descriptor = SessionArtifactDescriptor(
      name: fileName,
      path: path,
      mimeType: mimeType,
      size: byteLength,
      fetchUrl: _encodeSessionFileTransferSource(path),
    );
    final transferId = transferController.queueTransfer(
      sessionKey: sessionKey,
      descriptor: descriptor,
      direction: SessionArtifactTransferDirection.download,
      brokerProfileId: brokerProfileId,
    );
    return _runSessionFileDownload(
      transferId: transferId,
      sessionKey: sessionKey,
      path: path,
      fileName: fileName,
      mimeType: mimeType,
      hasActiveBrokerClient: hasActiveBrokerClient,
    );
  }

  /// Uploads a local attachment through the broker chunked-upload protocol.
  Future<SessionArtifactTransferWorkerResult> uploadSessionAttachment({
    required SessionDetailKey sessionKey,
    required SessionAttachment attachment,
  }) async {
    final fingerprint = await sha256StreamDigest(attachment.openRead());
    if (fingerprint.byteLength != attachment.byteLength) {
      const message = 'Attachment size changed before upload.';
      return SessionArtifactTransferWorkerResult(
        transferId: '${sessionKey.tool}:${sessionKey.sessionId}:upload:invalid',
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: message,
      );
    }
    final transferId = transferController.queueUploadTransfer(
      sessionKey: sessionKey,
      fileName: attachment.name,
      brokerProfileId: brokerProfileId,
      mimeType: attachment.mimeType,
      byteLength: attachment.byteLength,
      contentHash: fingerprint.digest,
    );
    final payload = _ChunkedUploadPayload(
      attachment: attachment,
      contentHash: fingerprint.digest,
    );

    _chunkedUploadPayloads[transferId] = payload;
    await transferController.persistTransfer(transferId);
    return _runChunkedUpload(
      transferId: transferId,
      sessionKey: sessionKey,
      payload: payload,
    );
  }

  /// Resumes a queued upload from durable metadata plus newly selected bytes.
  Future<SessionArtifactTransferWorkerResult> resumeUploadSessionAttachment({
    required String transferId,
    required SessionAttachment attachment,
  }) async {
    return _runUploadResumeOperation(
      transferId,
      () => _resumeUploadSessionAttachment(
        transferId: transferId,
        attachment: attachment,
      ),
    );
  }

  Future<SessionArtifactTransferWorkerResult> _resumeUploadSessionAttachment({
    required String transferId,
    required SessionAttachment attachment,
  }) async {
    final transfer = transferController.transferById(transferId);
    if (transfer == null) {
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: 'Transfer not found.',
      );
    }
    if (!_ownsTransfer(transfer)) {
      return _profileMismatchResult(transferId);
    }
    if (transfer.direction != SessionArtifactTransferDirection.upload) {
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: 'Transfer is not an upload.',
      );
    }
    if (transfer.status == SessionArtifactTransferStatus.completed) {
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: 'Transfer already completed.',
      );
    }
    if (transfer.status != SessionArtifactTransferStatus.queued &&
        transfer.status != SessionArtifactTransferStatus.failed &&
        transfer.status != SessionArtifactTransferStatus.canceled) {
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: 'Transfer is not in a resumable state.',
      );
    }
    if (transfer.status == SessionArtifactTransferStatus.failed ||
        transfer.status == SessionArtifactTransferStatus.canceled) {
      transferController.retryTransfer(transferId);
    }
    final uploadId = transfer.uploadId;
    if (uploadId == null || uploadId.trim().isEmpty) {
      const message = _uploadResumeUnavailableMessage;
      transferController.markFailed(transferId, message);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: message,
      );
    }
    if (transfer.contentHash == null) {
      const message = _uploadResumeUnavailableMessage;
      transferController.markFailed(transferId, message);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: message,
      );
    }
    if (!_canonicalContentHash.hasMatch(transfer.contentHash!)) {
      const message = 'Upload fingerprint has an invalid format.';
      transferController.markFailed(transferId, message);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: message,
      );
    }
    final persistedByteLength = transfer.byteLength;
    if (persistedByteLength == null ||
        persistedByteLength != attachment.byteLength) {
      const message = 'Upload size changed before resume.';
      transferController.markFailed(transferId, message);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: message,
      );
    }

    final fingerprint = await sha256StreamDigest(attachment.openRead());
    if (fingerprint.byteLength != attachment.byteLength) {
      const message = 'Upload size changed before upload.';
      transferController.markFailed(transferId, message);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: message,
      );
    }
    if (fingerprint.digest != transfer.contentHash) {
      const message = 'Upload fingerprint changed before retry.';
      transferController.markFailed(transferId, message);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: message,
      );
    }

    final payload = _ChunkedUploadPayload(
      attachment: attachment,
      contentHash: transfer.contentHash,
      uploadId: uploadId,
      offset: transfer.bytesTransferred ?? 0,
    );

    _chunkedUploadPayloads[transferId] = payload;

    return _runChunkedUpload(
      transferId: transferId,
      sessionKey: transfer.sessionKey,
      payload: payload,
      resumeUpload: true,
    );
  }

  /// Starts the explicit upload re-pick flow for a durable upload row.
  Future<SessionArtifactTransferWorkerResult> selectFileToResumeUpload({
    required String transferId,
  }) async {
    return _runUploadResumeOperation(
      transferId,
      () async {
        final transfer = transferController.transferById(transferId);
        if (transfer == null) {
          return SessionArtifactTransferWorkerResult(
            transferId: transferId,
            outcome: SessionArtifactTransferWorkerOutcome.failed,
            message: 'Transfer not found.',
          );
        }
        if (!_ownsTransfer(transfer)) {
          return _profileMismatchResult(transferId);
        }
        if (!transfer.canSelectFileToResumeUpload) {
          return SessionArtifactTransferWorkerResult(
            transferId: transferId,
            outcome: SessionArtifactTransferWorkerOutcome.failed,
            message: 'Transfer is not in a resumable state.',
          );
        }
        final picker = sessionAttachmentPicker;
        if (picker == null) {
          return SessionArtifactTransferWorkerResult(
            transferId: transferId,
            outcome: SessionArtifactTransferWorkerOutcome.failed,
            message: 'Upload picker is unavailable for this environment.',
          );
        }

        final List<SessionAttachment> selectedAttachments;
        try {
          selectedAttachments = await picker.pickAttachments(
            allowMultiple: false,
          );
        } on SessionAttachmentTooLargeException {
          return SessionArtifactTransferWorkerResult(
            transferId: transferId,
            outcome: SessionArtifactTransferWorkerOutcome.failed,
            message: 'Selected file is too large to resume upload.',
          );
        } on Object {
          return SessionArtifactTransferWorkerResult(
            transferId: transferId,
            outcome: SessionArtifactTransferWorkerOutcome.failed,
            message: 'Upload resume file could not be selected.',
          );
        }

        if (selectedAttachments.isEmpty) {
          return SessionArtifactTransferWorkerResult(
            transferId: transferId,
            outcome: SessionArtifactTransferWorkerOutcome.canceled,
            message: 'Upload resume selection was canceled.',
          );
        }
        final selectedAttachment = selectedAttachments.single;

        return _resumeUploadSessionAttachment(
          transferId: transferId,
          attachment: selectedAttachment,
        );
      },
    );
  }

  Future<SessionArtifactTransferWorkerResult> _runUploadResumeOperation(
    String transferId,
    Future<SessionArtifactTransferWorkerResult> Function() operation,
  ) {
    if (_uploadResumeInProgress.contains(transferId)) {
      return Future.value(
        SessionArtifactTransferWorkerResult(
          transferId: transferId,
          outcome: SessionArtifactTransferWorkerOutcome.failed,
          message: _uploadResumeAlreadyInProgressMessage,
        ),
      );
    }

    _uploadResumeInProgress.add(transferId);
    return operation().whenComplete(
      () => _uploadResumeInProgress.remove(transferId),
    );
  }

  /// Re-executes a failed or canceled transfer from its durable metadata.
  Future<SessionArtifactTransferWorkerResult> retryTransfer(
    String transferId, {
    required bool hasActiveBrokerClient,
  }) async {
    final transfer = transferController.transferById(transferId);
    if (transfer == null) {
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: 'Transfer not found.',
      );
    }
    if (!_ownsTransfer(transfer)) {
      return _profileMismatchResult(transferId);
    }
    final canResumeQueuedDownload =
        transfer.direction != SessionArtifactTransferDirection.upload &&
        transfer.status == SessionArtifactTransferStatus.queued;
    if (transfer.status != SessionArtifactTransferStatus.failed &&
        transfer.status != SessionArtifactTransferStatus.canceled &&
        !canResumeQueuedDownload) {
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: 'Transfer is not retryable.',
      );
    }
    if (transfer.direction == SessionArtifactTransferDirection.upload &&
        _chunkedUploadPayloads[transferId] == null) {
      final String message;
      if (transfer.canSelectFileToResumeUpload) {
        message =
            'Upload retry source is unavailable after app restart. Use '
            "'Select file to resume' in Transfer Manager.";
      } else {
        message = _uploadResumeUnavailableMessage;
      }
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: message,
      );
    }

    if (!canResumeQueuedDownload) {
      transferController.retryTransfer(transferId);
    }
    switch (transfer.direction) {
      case SessionArtifactTransferDirection.download:
        final descriptor = transfer.retryDescriptor;
        if (descriptor == null) {
          return _buildRetrySourceFailure(transferId);
        }
        return _sessionFilePathFromTransfer(transfer) == null
            ? _runDownload(
                transferId: transferId,
                sessionKey: transfer.sessionKey,
                descriptor: descriptor,
                hasActiveBrokerClient: hasActiveBrokerClient,
              )
            : _runSessionFileDownload(
                transferId: transferId,
                sessionKey: transfer.sessionKey,
                path: _sessionFilePathFromTransfer(transfer)!,
                fileName: transfer.fileName,
                mimeType: transfer.contentType,
                hasActiveBrokerClient: hasActiveBrokerClient,
              );
      case SessionArtifactTransferDirection.preview:
        final descriptor = transfer.retryDescriptor;
        if (descriptor == null) {
          return _buildRetrySourceFailure(transferId);
        }
        return _runPreview(
          transferId: transferId,
          sessionKey: transfer.sessionKey,
          descriptor: descriptor,
          hasActiveBrokerClient: hasActiveBrokerClient,
        );
      case SessionArtifactTransferDirection.upload:
        return _retryChunkedUpload(
          transferId,
          transfer,
          hasActiveBrokerClient: hasActiveBrokerClient,
        );
    }
  }

  SessionArtifactTransferWorkerResult _buildRetrySourceFailure(
    String transferId,
  ) {
    const message = 'Transfer retry source is unavailable.';
    transferController.markFailed(transferId, message);
    return SessionArtifactTransferWorkerResult(
      transferId: transferId,
      outcome: SessionArtifactTransferWorkerOutcome.failed,
      message: message,
    );
  }

  /// Whether [transfer] belongs to THIS exact broker.
  ///
  /// Exact-equality over the scope key: a row stamped by the same profile at
  /// another endpoint — or by a build that stamped bare profile ids — must
  /// never be uploaded to or downloaded from the broker this worker's client
  /// talks to.
  bool _ownsTransfer(SessionArtifactTransfer transfer) {
    final activeScopeKey = brokerProfileId;
    final ownerScopeKey = transfer.brokerProfileId;
    return activeScopeKey != null &&
        ownerScopeKey != null &&
        ownerScopeKey == activeScopeKey;
  }

  SessionArtifactTransferWorkerResult _profileMismatchResult(
    String transferId,
  ) => SessionArtifactTransferWorkerResult(
    transferId: transferId,
    outcome: SessionArtifactTransferWorkerOutcome.failed,
    message:
        'Switch to the broker profile and endpoint that created this '
        'transfer before retrying it.',
  );

  String _encodeSessionFileTransferSource(String path) {
    return '$_sessionFileTransferSourcePrefix${Uri.encodeComponent(path)}';
  }

  String? _sessionFilePathFromTransfer(SessionArtifactTransfer transfer) {
    final source = transfer.sourceUrl;
    if (source == null ||
        !source.startsWith(_sessionFileTransferSourcePrefix)) {
      return null;
    }
    return Uri.decodeComponent(
      source.substring(_sessionFileTransferSourcePrefix.length),
    );
  }

  Future<SessionArtifactTransferWorkerResult> _retryChunkedUpload(
    String transferId,
    SessionArtifactTransfer transfer, {
    required bool hasActiveBrokerClient,
  }) async {
    final payload = _chunkedUploadPayloads[transferId];
    if (payload == null) {
      const message =
          'Upload retry source is unavailable after app restart. Select the '
          'file again to retry.';
      transferController.markFailed(transferId, message);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: message,
      );
    }
    if (!hasActiveBrokerClient) {
      const message = 'No active broker client for upload retry.';
      transferController.markFailed(transferId, message);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: message,
      );
    }
    final fingerprint = await sha256StreamDigest(
      payload.attachment.openRead(),
    );
    if (fingerprint.byteLength != payload.byteLength) {
      const message = 'Attachment size changed before upload.';
      transferController.markFailed(transferId, message);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: message,
      );
    }
    if (payload.contentHash != null) {
      if (fingerprint.digest != payload.contentHash) {
        const message = 'Upload fingerprint changed before retry.';
        transferController.markFailed(transferId, message);
        return SessionArtifactTransferWorkerResult(
          transferId: transferId,
          outcome: SessionArtifactTransferWorkerOutcome.failed,
          message: message,
        );
      }
    }
    return _runChunkedUpload(
      transferId: transferId,
      sessionKey: transfer.sessionKey,
      payload: payload,
      resumeUpload: payload.uploadId != null,
    );
  }

  Future<SessionArtifactTransferWorkerResult> _runChunkedUpload({
    required String transferId,
    required SessionDetailKey sessionKey,
    required _ChunkedUploadPayload payload,
    bool resumeUpload = false,
  }) async {
    final cancellationToken = _registerCancellationToken(transferId);
    transferController.markRunning(
      transferId,
      message: 'Uploading ${payload.fileName}...',
    );
    final client = brokerClient;
    if (client == null) {
      const message = 'No active broker client for chunked upload.';
      transferController.markFailed(transferId, message);
      _unregisterCancellationToken(transferId, cancellationToken);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: message,
      );
    }

    try {
      cancellationToken.throwIfCanceled();
      var uploadId = payload.uploadId;
      var offset = payload.offset;
      if (resumeUpload) {
        if (uploadId == null || uploadId.isEmpty) {
          const message = 'Upload session source is unavailable.';
          transferController.markFailed(transferId, message);
          return SessionArtifactTransferWorkerResult(
            transferId: transferId,
            outcome: SessionArtifactTransferWorkerOutcome.failed,
            message: message,
          );
        }
        final status = await client.getUploadStatus(
          sessionKey.tool,
          sessionKey.sessionId,
          uploadId,
        );
        _validateUploadResponse(
          stage: 'status',
          requestedUploadId: uploadId,
          responseUploadId: status.uploadId,
          responseSize: status.size,
          byteLength: payload.byteLength,
        );
        _validateUploadOffset(
          offset: status.offset,
          byteLength: payload.byteLength,
          transferId: transferId,
        );
        offset = status.offset;
        payload.offset = offset;
      } else if (uploadId == null) {
        final init = await client.initUpload(
          sessionKey.tool,
          sessionKey.sessionId,
          name: payload.fileName,
          mimeType: payload.mimeType,
          size: payload.byteLength,
          contentHash: payload.contentHash,
        );
        uploadId = init.uploadId;
        _validateUploadResponse(
          stage: 'init',
          requestedUploadId: null,
          responseUploadId: init.uploadId,
          responseSize: init.size,
          byteLength: payload.byteLength,
        );
        _validateUploadOffset(
          offset: init.offset,
          byteLength: payload.byteLength,
          transferId: transferId,
        );
        offset = init.offset;
        payload
          ..uploadId = uploadId
          ..offset = offset;
        await transferController.updateUploadState(
          id: transferId,
          uploadId: uploadId,
          bytesTransferred: offset,
          totalBytes: payload.byteLength,
        );
      } else {
        final status = await client.getUploadStatus(
          sessionKey.tool,
          sessionKey.sessionId,
          uploadId,
        );
        _validateUploadResponse(
          stage: 'status',
          requestedUploadId: uploadId,
          responseUploadId: status.uploadId,
          responseSize: status.size,
          byteLength: payload.byteLength,
        );
        _validateUploadOffset(
          offset: status.offset,
          byteLength: payload.byteLength,
          transferId: transferId,
        );
        offset = status.offset;
        payload.offset = offset;
      }
      _validateUploadOffset(
        offset: offset,
        byteLength: payload.byteLength,
        transferId: transferId,
      );
      await transferController.updateUploadState(
        id: transferId,
        uploadId: uploadId,
        bytesTransferred: offset,
        totalBytes: payload.byteLength,
      );
      transferController.markProgress(
        transferId,
        bytesTransferred: offset,
        totalBytes: payload.byteLength,
      );

      while (offset < payload.byteLength) {
        cancellationToken.throwIfCanceled();
        final end = (offset + chunkedUploadChunkBytes).clamp(
          0,
          payload.byteLength,
        );
        final chunk = await _readAttachmentRange(
          payload.attachment,
          start: offset,
          end: end,
        );
        try {
          final patch = await client.patchUploadChunk(
            sessionKey.tool,
            sessionKey.sessionId,
            uploadId,
            offset: offset,
            bytes: chunk,
          );
          _validateUploadResponse(
            stage: 'patch',
            requestedUploadId: uploadId,
            responseUploadId: patch.uploadId,
            responseSize: patch.size,
            byteLength: payload.byteLength,
          );
          _validatePatchOffset(
            offset: patch.offset,
            byteLength: payload.byteLength,
            offsetAtChunkStart: offset,
            transferId: transferId,
          );
          offset = patch.offset;
          payload.offset = offset;
        } on UploadOffsetMismatchException catch (e) {
          final expectedOffset = e.expectedOffset;
          if (expectedOffset == null) {
            throw StateError('Upload offset mismatch.');
          }
          _validateUploadOffset(
            offset: expectedOffset,
            byteLength: payload.byteLength,
            transferId: transferId,
          );
          offset = expectedOffset;
          payload.offset = offset;
        }
        await transferController.updateUploadState(
          id: transferId,
          uploadId: uploadId,
          bytesTransferred: offset,
          totalBytes: payload.byteLength,
        );
        transferController.markProgress(
          transferId,
          bytesTransferred: offset,
          totalBytes: payload.byteLength,
        );
      }

      cancellationToken.throwIfCanceled();
      final completed = await client.completeUpload(
        sessionKey.tool,
        sessionKey.sessionId,
        uploadId,
      );
      final message = 'Staged ${completed.name}';
      await transferController.markUploadedWithPersistence(
        transferId,
        byteLength: completed.size,
        fileName: completed.name,
        contentType: completed.mimeType,
        message: message,
      );
      _chunkedUploadPayloads.remove(transferId);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.completed,
        stagedUpload: completed,
        message: message,
      );
    } on SessionArtifactCanceledException catch (e) {
      transferController.markCanceled(transferId, message: e.message);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.canceled,
        message: e.message,
      );
    } on Object catch (e) {
      final message = _uploadFailureMessage(e);
      if (e is BrokerException) {
        final code = e.error?.code;
        if (code == 'UPLOAD_EXPIRED' || code == 'UPLOAD_NOT_FOUND') {
          _chunkedUploadPayloads.remove(transferId);
          await transferController.updateUploadState(
            id: transferId,
            clearUploadId: true,
          );
          transferController.markFailed(transferId, message);
          await transferController.persistTransfer(transferId);
          return SessionArtifactTransferWorkerResult(
            transferId: transferId,
            outcome: SessionArtifactTransferWorkerOutcome.failed,
            message: message,
          );
        }
      }
      transferController.markFailed(transferId, message);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: message,
      );
    } finally {
      _unregisterCancellationToken(transferId, cancellationToken);
    }
  }

  void _validateUploadOffset({
    required int offset,
    required int byteLength,
    required String transferId,
  }) {
    if (offset < 0 || offset > byteLength) {
      throw StateError(
        'Upload offset for transfer $transferId is outside the expected '
        'range (expected 0 to $byteLength, got $offset).',
      );
    }
  }

  Future<Uint8List> _readAttachmentRange(
    SessionAttachment attachment, {
    required int start,
    required int end,
  }) async {
    final expectedLength = end - start;
    final builder = BytesBuilder(copy: false);
    var received = 0;
    await for (final bytes in attachment.openRead(start: start, end: end)) {
      received += bytes.length;
      if (received > expectedLength) {
        throw StateError('Attachment source exceeded the requested chunk.');
      }
      builder.add(bytes);
    }
    if (received != expectedLength) {
      throw StateError('Attachment size changed before upload.');
    }
    return builder.takeBytes();
  }

  void _validateUploadResponse({
    required String stage,
    required String? requestedUploadId,
    required String? responseUploadId,
    required int responseSize,
    required int byteLength,
  }) {
    if (responseUploadId == null || responseUploadId.isEmpty) {
      throw StateError(
        'Upload $stage response returned an invalid uploadId.',
      );
    }
    if (requestedUploadId != null && responseUploadId != requestedUploadId) {
      throw StateError(
        'Upload $stage response uploadId does not match the requested '
        'uploadId (expected $requestedUploadId, got $responseUploadId).',
      );
    }
    if (responseSize != 0 && responseSize != byteLength) {
      throw StateError(
        'Upload $stage response size did not match the expected size of '
        '$byteLength bytes.',
      );
    }
  }

  void _validatePatchOffset({
    required int offset,
    required int byteLength,
    required int offsetAtChunkStart,
    required String transferId,
  }) {
    if (offset <= offsetAtChunkStart || offset > byteLength) {
      throw StateError(
        'Upload patch result offset was invalid for transfer '
        '$transferId (got $offset).',
      );
    }
  }

  String _uploadFailureMessage(Object error) {
    if (error is UploadOffsetMismatchException) {
      final expected = error.expectedOffset;
      return expected == null
          ? 'Upload offset mismatch.'
          : 'Upload offset mismatch at byte $expected.';
    }
    if (error is BrokerException) {
      final code = error.error?.code;
      return switch (code) {
        'UPLOAD_TOO_LARGE' => 'Upload is larger than the broker limit.',
        'UPLOAD_NOT_FOUND' => _uploadResumeUnavailableMessage,
        'UPLOAD_EXPIRED' => _uploadResumeUnavailableMessage,
        'UPLOAD_SIZE_MISMATCH' =>
          'Upload size did not match the broker record.',
        'BAD_PARAM' => 'Upload request was rejected by the broker.',
        _ => userFacingMessage(
          error,
          lead: "Couldn't upload this file.",
        ),
      };
    }
    return userFacingMessage(error, lead: "Couldn't upload this file.");
  }

  Future<SessionArtifactTransferWorkerResult> _runSessionFileDownload({
    required String transferId,
    required SessionDetailKey sessionKey,
    required String path,
    required String fileName,
    required bool hasActiveBrokerClient,
    String? mimeType,
  }) async {
    // Platform capability gate: on iOS/Android, hand the workspace-file download
    // to the native background engine so it survives backgrounding. Everywhere
    // else fall through to the foreground resumable path below unchanged.
    final coordinator = backgroundCoordinator;
    if (coordinator != null && coordinator.isSupported) {
      return coordinator.startDownload(
        transferId: transferId,
        sessionKey: sessionKey,
        path: path,
        fileName: fileName,
        mimeType: mimeType,
        hasActiveBrokerClient: hasActiveBrokerClient,
      );
    }

    final cancellationToken = _registerCancellationToken(transferId);
    transferController.markRunning(transferId, message: 'Downloading...');

    if (!hasActiveBrokerClient) {
      const message = 'No active broker client for file download.';
      transferController.markFailed(transferId, message);
      _unregisterCancellationToken(transferId, cancellationToken);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: message,
      );
    }

    try {
      cancellationToken.throwIfCanceled();
      final transfer = transferController.transferById(transferId);
      final cached = fileService is ResumableSessionArtifactFileService
          ? await (fileService as ResumableSessionArtifactFileService)
                .cacheSessionFileResumable(
                  tool: sessionKey.tool,
                  sessionId: sessionKey.sessionId,
                  path: path,
                  fileName: fileName,
                  mimeType: mimeType,
                  checkpoint: transfer?.partialFilePath == null
                      ? null
                      : SessionFileDownloadCheckpoint(
                          partialFilePath: transfer!.partialFilePath!,
                          bytesTransferred: transfer.bytesTransferred ?? 0,
                          totalBytes: transfer.totalBytes,
                          etag: transfer.downloadEtag,
                          lastModified: transfer.downloadLastModified,
                        ),
                  onCheckpoint: (checkpoint) =>
                      transferController.updateDownloadCheckpoint(
                        id: transferId,
                        partialFilePath: checkpoint.partialFilePath,
                        bytesTransferred: checkpoint.bytesTransferred,
                        totalBytes: checkpoint.totalBytes,
                        etag: checkpoint.etag,
                        lastModified: checkpoint.lastModified,
                      ),
                  cancellationToken: cancellationToken,
                  onProgress: ({required bytesTransferred, totalBytes}) {
                    cancellationToken.throwIfCanceled();
                    transferController.markProgress(
                      transferId,
                      bytesTransferred: bytesTransferred,
                      totalBytes: totalBytes,
                    );
                  },
                )
          : await fileService.cacheSessionFile(
              tool: sessionKey.tool,
              sessionId: sessionKey.sessionId,
              path: path,
              fileName: fileName,
              mimeType: mimeType,
              cancellationToken: cancellationToken,
              onProgress: ({required bytesTransferred, totalBytes}) {
                cancellationToken.throwIfCanceled();
                transferController.markProgress(
                  transferId,
                  bytesTransferred: bytesTransferred,
                  totalBytes: totalBytes,
                );
              },
            );
      cancellationToken.throwIfCanceled();
      await transferController.markCachedWithPersistence(
        transferId,
        cached,
        message: 'Cached ${cached.fileName}',
      );
      final destination = await fileService.exportCachedArtifact(
        cached,
        cancellationToken: cancellationToken,
      );
      cancellationToken.throwIfCanceled();
      if (destination == null) {
        const message = 'Save destination canceled';
        transferController.markCanceled(transferId, message: message);
        return SessionArtifactTransferWorkerResult(
          transferId: transferId,
          outcome: SessionArtifactTransferWorkerOutcome.canceled,
          cachedFile: cached,
          message: message,
        );
      }

      final message = 'Saved ${cached.fileName}';
      transferController.markExported(
        transferId,
        cached,
        exportedPath: destination,
        message: message,
      );
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.completed,
        cachedFile: cached,
        exportedPath: destination,
        message: message,
      );
    } on SessionArtifactCanceledException catch (e) {
      transferController.markCanceled(transferId, message: e.message);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.canceled,
        message: e.message,
      );
    } on Object catch (e) {
      final message = userFacingMessage(
        e,
        lead: "Couldn't download this file.",
      );
      transferController.markFailed(transferId, message);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: message,
      );
    } finally {
      _unregisterCancellationToken(transferId, cancellationToken);
    }
  }

  /// Requests active cancellation for a queued or running transfer.
  ///
  /// Also cancels the native background task, if any, so a backgrounded
  /// download stops when the user cancels from the transfer manager.
  void cancelTransfer(String transferId) {
    _cancellationTokens[transferId]?.cancel();
    unawaited(backgroundCoordinator?.cancel(transferId));
    transferController.cancelTransfer(transferId);
  }

  Future<SessionArtifactTransferWorkerResult> _runDownload({
    required String transferId,
    required SessionDetailKey sessionKey,
    required SessionArtifactDescriptor descriptor,
    required bool hasActiveBrokerClient,
  }) async {
    final cancellationToken = _registerCancellationToken(transferId);
    transferController.markRunning(transferId, message: 'Downloading...');

    if (!descriptor.isInlineDataUrl && !hasActiveBrokerClient) {
      const message = 'No active broker client for artifact download.';
      transferController.markFailed(transferId, message);
      _unregisterCancellationToken(transferId, cancellationToken);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: message,
      );
    }

    final referenceError = _artifactReferenceError(sessionKey, descriptor);
    if (referenceError != null) {
      transferController.markFailed(transferId, referenceError);
      _unregisterCancellationToken(transferId, cancellationToken);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: referenceError,
      );
    }

    try {
      cancellationToken.throwIfCanceled();
      final cached = await fileService.cacheArtifact(
        descriptor,
        cancellationToken: cancellationToken,
        onProgress: ({required bytesTransferred, totalBytes}) {
          cancellationToken.throwIfCanceled();
          transferController.markProgress(
            transferId,
            bytesTransferred: bytesTransferred,
            totalBytes: totalBytes,
          );
        },
      );
      cancellationToken.throwIfCanceled();
      transferController.markCached(
        transferId,
        cached,
        message: 'Cached ${cached.fileName}',
      );
      final destination = await fileService.exportCachedArtifact(
        cached,
        cancellationToken: cancellationToken,
      );
      cancellationToken.throwIfCanceled();
      if (destination == null) {
        const message = 'Save destination canceled';
        transferController.markCanceled(transferId, message: message);
        return SessionArtifactTransferWorkerResult(
          transferId: transferId,
          outcome: SessionArtifactTransferWorkerOutcome.canceled,
          cachedFile: cached,
          message: message,
        );
      }

      final message = 'Saved ${cached.fileName}';
      transferController.markExported(
        transferId,
        cached,
        exportedPath: destination,
        message: message,
      );
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.completed,
        cachedFile: cached,
        exportedPath: destination,
        message: message,
      );
    } on SessionArtifactCanceledException catch (e) {
      transferController.markCanceled(transferId, message: e.message);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.canceled,
        message: e.message,
      );
    } on Object catch (e) {
      final message = userFacingMessage(
        e,
        lead: "Couldn't save this artifact.",
      );
      transferController.markFailed(transferId, message);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: message,
      );
    } finally {
      _unregisterCancellationToken(transferId, cancellationToken);
    }
  }

  /// Caches an HTML artifact for preview.
  Future<SessionArtifactTransferWorkerResult> preparePreview({
    required SessionDetailKey sessionKey,
    required SessionArtifactDescriptor descriptor,
    required bool hasActiveBrokerClient,
  }) async {
    final transferId = transferController.queueTransfer(
      sessionKey: sessionKey,
      descriptor: descriptor,
      direction: SessionArtifactTransferDirection.preview,
      brokerProfileId: brokerProfileId,
    );
    return _runPreview(
      transferId: transferId,
      sessionKey: sessionKey,
      descriptor: descriptor,
      hasActiveBrokerClient: hasActiveBrokerClient,
    );
  }

  Future<SessionArtifactTransferWorkerResult> _runPreview({
    required String transferId,
    required SessionDetailKey sessionKey,
    required SessionArtifactDescriptor descriptor,
    required bool hasActiveBrokerClient,
  }) async {
    final cancellationToken = _registerCancellationToken(transferId);
    transferController.markRunning(transferId, message: 'Preparing preview...');

    if (!descriptor.isHtmlPreviewCandidate) {
      const message = 'Only HTML artifacts can be previewed.';
      transferController.markFailed(transferId, message);
      _unregisterCancellationToken(transferId, cancellationToken);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: message,
      );
    }

    if (!descriptor.isInlineDataUrl && !hasActiveBrokerClient) {
      const message = 'No active broker client for artifact preview.';
      transferController.markFailed(transferId, message);
      _unregisterCancellationToken(transferId, cancellationToken);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: message,
      );
    }

    final referenceError = _artifactReferenceError(sessionKey, descriptor);
    if (referenceError != null) {
      transferController.markFailed(transferId, referenceError);
      _unregisterCancellationToken(transferId, cancellationToken);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: referenceError,
      );
    }

    try {
      cancellationToken.throwIfCanceled();
      final cached = await fileService.cacheArtifact(
        descriptor,
        cancellationToken: cancellationToken,
        onProgress: ({required bytesTransferred, totalBytes}) {
          cancellationToken.throwIfCanceled();
          transferController.markProgress(
            transferId,
            bytesTransferred: bytesTransferred,
            totalBytes: totalBytes,
          );
        },
      );
      cancellationToken.throwIfCanceled();
      final message = 'Cached ${cached.fileName} for preview';
      transferController.markCached(transferId, cached, message: message);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.cached,
        cachedFile: cached,
        message: message,
      );
    } on SessionArtifactCanceledException catch (e) {
      transferController.markCanceled(transferId, message: e.message);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.canceled,
        message: e.message,
      );
    } on Object catch (e) {
      final message = userFacingMessage(
        e,
        lead: "Couldn't prepare this artifact preview.",
      );
      transferController.markFailed(transferId, message);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: message,
      );
    } finally {
      _unregisterCancellationToken(transferId, cancellationToken);
    }
  }

  String? _artifactReferenceError(
    SessionDetailKey sessionKey,
    SessionArtifactDescriptor descriptor,
  ) {
    if (descriptor.isInlineDataUrl) return null;
    final client = brokerClient;
    final source = Uri.tryParse(descriptor.downloadSourceUrl ?? '');
    final broker = client == null ? null : Uri.tryParse(client.baseUrl);
    final artifactKey = descriptor.artifactKey?.trim() ?? '';
    final contentHash = descriptor.contentHash?.trim() ?? '';
    if (source == null ||
        broker == null ||
        !source.hasScheme ||
        source.userInfo.isNotEmpty ||
        !_sameOrigin(source, broker) ||
        artifactKey.isEmpty ||
        contentHash.isEmpty ||
        source.queryParameters['expires']?.isNotEmpty != true ||
        source.queryParameters['sig']?.isNotEmpty != true) {
      return _artifactReferenceMismatchMessage;
    }
    final segments = source.pathSegments;
    if (segments.length != 6 ||
        segments[0] != 'api' ||
        segments[1] != 'sessions' ||
        segments[2] != sessionKey.tool ||
        segments[3] != sessionKey.sessionId ||
        segments[4] != 'artifact' ||
        segments[5] != artifactKey) {
      return _artifactReferenceMismatchMessage;
    }
    return null;
  }

  bool _sameOrigin(Uri left, Uri right) {
    int effectivePort(Uri uri) => uri.hasPort
        ? uri.port
        : switch (uri.scheme.toLowerCase()) {
            'https' => 443,
            'http' => 80,
            _ => -1,
          };
    return left.scheme.toLowerCase() == right.scheme.toLowerCase() &&
        left.host.toLowerCase() == right.host.toLowerCase() &&
        effectivePort(left) == effectivePort(right);
  }

  SessionArtifactCancellationToken _registerCancellationToken(
    String transferId,
  ) {
    final token = SessionArtifactCancellationToken();
    _cancellationTokens[transferId] = token;
    return token;
  }

  void _unregisterCancellationToken(
    String transferId,
    SessionArtifactCancellationToken token,
  ) {
    if (identical(_cancellationTokens[transferId], token)) {
      _cancellationTokens.remove(transferId);
    }
  }
}

final class _ChunkedUploadPayload {
  _ChunkedUploadPayload({
    required this.attachment,
    this.contentHash,
    this.uploadId,
    int? offset,
  }) : offset = offset ?? 0;

  final SessionAttachment attachment;
  String get fileName => attachment.name;
  int get byteLength => attachment.byteLength;
  String? get mimeType => attachment.mimeType;
  final String? contentHash;
  String? uploadId;
  int offset = 0;
}
