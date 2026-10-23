import 'dart:async';
import 'dart:typed_data';

import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:broker_crypto/broker_crypto.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_route_transport.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/background_downloader_engine.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_descriptor.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_file_service.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_transfer.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_file_background_download.dart';
import 'package:cosyncing_client/src/features/sessions/attachments/session_attachment_picker.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/settings/controller/locale_controller.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

const String _sessionFileTransferSourcePrefix = 'session-file:';

final _canonicalContentHash = RegExp(r'^sha256:[0-9a-f]{64}$');

const _uploadResumeUnavailableMessage =
    'Upload cannot be resumed after app restart. '
    'Start a new upload from Session Detail.';
const _uploadResumeAlreadyInProgressMessage =
    'Upload resume is already in progress for this transfer.';
const _artifactReferenceMismatchMessage =
    'Artifact reference is not bound to this server, session, and version.';

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
    this.detail,
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

  /// Raw diagnostic, shown only through Technical details. Never persisted.
  final String? detail;

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

/// Raw errors retained only for explicit Technical details in this app run.
final StateProvider<Map<String, String>>
sessionArtifactTransferDetailsProvider = StateProvider<Map<String, String>>(
  (ref) {
    ref.listen(sessionArtifactTransferControllerProvider, (_, next) {
      final controller = ref.controller;
      if (controller.state.isEmpty) return;
      final byId = {for (final row in next) row.id: row};
      final retained = Map.of(controller.state)
        ..removeWhere((id, _) {
          final row = byId[id];
          // Every retry first leaves failed for queued/running, so status also
          // drops earlier details without building a previous-state map.
          return row == null ||
              row.status != SessionArtifactTransferStatus.failed;
        });
      if (retained.length != controller.state.length) {
        controller.state = retained;
      }
    });
    return {};
  },
);

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
      final l10n = resolveAppLocalizations(
        ref.watch(localeControllerProvider).valueOrNull,
      );
      late final SessionArtifactTransferWorker worker;
      final details = ref.read(sessionArtifactTransferDetailsProvider.notifier);
      void recordDetail(String id, String? detail) {
        if (detail == null) {
          if (details.state.containsKey(id)) {
            details.state = Map.of(details.state)..remove(id);
          }
        } else {
          details.state = {...details.state, id: detail};
        }
      }

      final transferController = ref.read(
        sessionArtifactTransferControllerProvider.notifier,
      );

      // Attach the native background download coordinator only where the engine
      // truly backgrounds (iOS/Android) and the file service can finalize a
      // completed download through the shared cache path. Elsewhere this is
      // null and the worker keeps the foreground resumable path unchanged.
      final hub = ref.watch(sessionFileBackgroundUpdateHubProvider);
      final engine = hub?.engine;
      final finalizer = fileService is BackgroundSessionDownloadFinalizer
          ? fileService as BackgroundSessionDownloadFinalizer
          : null;
      SessionFileBackgroundDownloadCoordinator? backgroundCoordinator;
      final requiresProxy =
          brokerClient != null &&
          (resolverRoute(brokerClient.resolver)?.context.requiresProxy ??
              false);
      if (!requiresProxy &&
          engine != null &&
          engine.isSupported &&
          finalizer != null) {
        final lifecycle = ref.watch(
          sessionNotificationLifecycleMonitorProvider,
        );
        // Inactive can be a visible app under the notification shade. Native
        // resume/pause still admits the actual picker launch; hidden/paused
        // completions permanently lose their offer here.
        bool isForeground() => switch (lifecycle.currentState) {
          BrokerAppLifecycleState.resumed ||
          BrokerAppLifecycleState.inactive => true,
          _ => false,
        };
        late final SessionFileBackgroundDownloadCoordinator coordinator;
        coordinator = SessionFileBackgroundDownloadCoordinator(
          hub: hub!,
          transferController: transferController,
          finalizer: finalizer,
          brokerProfileId: brokerProfileId,
          brokerClient: brokerClient,
          isForeground: isForeground,
          onFailureDetail: recordDetail,
          onReadyToSave: (id) async {
            await worker.saveCachedTransfer(
              id,
              cancelOnDismiss: true,
              shouldStart: () => coordinator.canOfferSave(id),
            );
          },
        );
        // Reconcile any download that completed while the app was gone, and
        // start listening for live task updates. Fails safe off-device.
        unawaited(coordinator.bootstrap());
        ref.onDispose(coordinator.dispose);
        backgroundCoordinator = coordinator;
      }

      return worker = SessionArtifactTransferWorker(
        brokerProfileId: brokerProfileId,
        brokerClient: brokerClient,
        fileService: fileService,
        transferController: transferController,
        sessionAttachmentPicker: ref.read(sessionAttachmentPickerProvider),
        backgroundCoordinator: backgroundCoordinator,
        saveQueue: ref.read(_sessionArtifactSaveQueueProvider),
        cachedCopyRemovedMessage: l10n.transferCachedCopyRemoved,
        saveBusyMessage: l10n.transferSaveBusy,
        saveDeferredMessage: l10n.transferSaveDeferred,
        onFailureDetail: recordDetail,
      );
    });

/// App-lifetime serialization of Android document pickers and streamed copies.
class SessionArtifactSaveQueue {
  Future<void> _tail = Future<void>.value();
  final _tokens = <String, Set<SessionArtifactCancellationToken>>{};

  /// Cancels active and queued saves, including work begun by an older worker.
  void cancel(String transferId) {
    for (final token
        in _tokens[transferId]?.toList() ??
            <SessionArtifactCancellationToken>[]) {
      token.cancel();
    }
  }

  /// Holds the queue through copy completion, and always releases on errors.
  Future<T> run<T>(
    Future<T> Function() action, {
    required String transferId,
    required SessionArtifactCancellationToken cancellationToken,
  }) async {
    (_tokens[transferId] ??= {}).add(cancellationToken);
    Completer<void>? done;
    try {
      if (!kIsWeb && defaultTargetPlatform == TargetPlatform.android) {
        final previous = _tail;
        done = Completer<void>();
        _tail = done.future;
        await previous;
      }
      cancellationToken.throwIfCanceled();
      return await action();
    } finally {
      _tokens[transferId]?.remove(cancellationToken);
      if (_tokens[transferId]?.isEmpty ?? false) _tokens.remove(transferId);
      done?.complete();
    }
  }
}

final Provider<SessionArtifactSaveQueue> _sessionArtifactSaveQueueProvider =
    Provider(
      (ref) => SessionArtifactSaveQueue(),
    );

bool _saveUnavailable(Object error) =>
    error is PlatformException &&
    (error.code == 'busy' || error.code == 'no_activity');

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
    this.onFailureDetail,
    SessionArtifactSaveQueue? saveQueue,
    this.saveDeferredMessage = 'Downloaded. Use Save to choose a destination.',
    this.saveBusyMessage =
        'Another save is in progress. Try Save again when it finishes.',
    this.cachedCopyRemovedMessage =
        'The cached copy was removed. Download the file again.',
  }) : _saveQueue = saveQueue ?? SessionArtifactSaveQueue();

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

  /// Localized recovery when device cleanup has removed a cached copy.
  final String cachedCopyRemovedMessage;

  /// Localized recovery for the defensive native serialization guard.
  final String saveBusyMessage;

  /// Localized success/recovery when saving is temporarily unavailable.
  final String saveDeferredMessage;

  /// In-memory diagnostic sink; the ledger keeps only the friendly message.
  final void Function(String id, String? detail)? onFailureDetail;

  /// Transfer ledger controller.
  final SessionArtifactTransferController transferController;

  /// Picker boundary for explicit upload resume flow.
  final SessionAttachmentPicker? sessionAttachmentPicker;

  final SessionArtifactSaveQueue _saveQueue;

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

  /// Saves an existing cached copy. A row-tap cancellation keeps its state;
  /// cancellation of the automatic post-download picker marks it canceled.
  Future<SessionArtifactTransferWorkerResult> saveCachedTransfer(
    String transferId, {
    bool cancelOnDismiss = false,
    bool Function()? shouldStart,
  }) async {
    final token = _registerCancellationToken(transferId);
    final requested = transferController.transferById(transferId);
    SessionArtifactTransfer? original;
    bool canUpdateRow() =>
        !token.isCanceled &&
        original != null &&
        identical(transferController.transferById(transferId), original);
    try {
      return await _saveQueue.run(
        () async {
          original = transferController.transferById(transferId);
          // Earlier queued Saves can legitimately complete the same row.
          // Capture a fresh baseline when this picker reaches the front.
          final current = original;
          final validQueuedRow =
              current != null &&
              requested != null &&
              current.attemptCount == requested.attemptCount &&
              (identical(current, requested) ||
                  current.status == SessionArtifactTransferStatus.completed);
          if (!validQueuedRow ||
              !canUpdateRow() ||
              !(shouldStart?.call() ?? true)) {
            return SessionArtifactTransferWorkerResult(
              transferId: transferId,
              outcome: SessionArtifactTransferWorkerOutcome.canceled,
            );
          }
          var cached = cachedFileForTransfer(transferId);
          final destination = await fileService.exportCachedArtifact(
            cached,
            cancellationToken: token,
          );
          if (destination == null || !canUpdateRow()) {
            if (destination == null && cancelOnDismiss && canUpdateRow()) {
              transferController.markCanceled(
                transferId,
                message: 'Save destination canceled',
              );
            }
            return SessionArtifactTransferWorkerResult(
              transferId: transferId,
              outcome: SessionArtifactTransferWorkerOutcome.canceled,
              cachedFile: cached,
            );
          }
          cached = _withExportedName(cached, destination);
          final message = 'Saved ${cached.fileName}';
          transferController.markExported(
            transferId,
            cached,
            exportedPath: destination,
            message: message,
          );
          onFailureDetail?.call(transferId, null);
          return SessionArtifactTransferWorkerResult(
            transferId: transferId,
            outcome: SessionArtifactTransferWorkerOutcome.completed,
            cachedFile: cached,
            exportedPath: destination,
            message: message,
          );
        },
        transferId: transferId,
        cancellationToken: token,
      );
    } on SessionArtifactCanceledException {
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.canceled,
      );
    } on Object catch (error) {
      if (!canUpdateRow()) return _canceledSaveResult(transferId);
      final failure = describeFailure(
        error,
        lead: "Couldn't save this artifact.",
      );
      final message =
          error is StateError && error.message == cachedCopyRemovedMessage
          ? cachedCopyRemovedMessage
          : error is PlatformException && error.code == 'busy'
          ? saveBusyMessage
          : failure.message;
      // A separate Save attempt preserves the prior state and diagnostic.
      if (cancelOnDismiss && canUpdateRow() && !_saveUnavailable(error)) {
        transferController.markFailed(transferId, message);
        onFailureDetail?.call(transferId, failure.detail ?? message);
      }
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: message,
        detail: failure.detail,
      );
    } finally {
      _unregisterCancellationToken(transferId, token);
    }
  }

  SessionArtifactTransferWorkerResult _canceledSaveResult(String id) =>
      SessionArtifactTransferWorkerResult(
        transferId: id,
        outcome: SessionArtifactTransferWorkerOutcome.canceled,
      );

  SessionArtifactTransferWorkerResult _deferredSaveResult(String id) =>
      SessionArtifactTransferWorkerResult(
        transferId: id,
        outcome: SessionArtifactTransferWorkerOutcome.cached,
        message: saveDeferredMessage,
      );

  SessionArtifactCachedFile _withExportedName(
    SessionArtifactCachedFile cached,
    String destination,
  ) {
    final service = fileService;
    final name = service is ArtifactExportNames
        ? (service as ArtifactExportNames).exportedNameFor(destination)
        : null;
    if (name == null || name == cached.fileName) return cached;
    return SessionArtifactCachedFile(
      cachedFilePath: cached.cachedFilePath,
      fileName: name,
      byteLength: cached.byteLength,
      contentType: cached.contentType,
      artifactKey: cached.artifactKey,
      contentHash: cached.contentHash,
    );
  }

  /// Validates the local copy for Save and Share without requiring a server.
  SessionArtifactCachedFile cachedFileForTransfer(String transferId) {
    final transfer = transferController.transferById(transferId);
    final path = transfer?.cachedFilePath;
    if (transfer == null ||
        !transfer.hasSettledCachedCopy ||
        path == null ||
        !cachedArtifactFileExists(path)) {
      throw StateError(cachedCopyRemovedMessage);
    }
    return SessionArtifactCachedFile(
      cachedFilePath: path,
      fileName: transfer.fileName,
      contentType: transfer.contentType,
      byteLength: transfer.byteLength ?? 0,
      artifactKey: transfer.artifactKey,
      contentHash: transfer.contentHash,
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
      _saveQueue.cancel(transferId);
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
        'Switch to the saved server and address that created this '
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
      const message = 'Connect to the server before retrying this upload.';
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
  }) => _withPinnedTransport(transferId, () async {
    final cancellationToken = _registerCancellationToken(transferId);
    transferController.markRunning(
      transferId,
      message: 'Uploading ${payload.fileName}...',
    );
    final originalClient = brokerClient;
    final client = originalClient == null
        ? null
        : brokerRouteOperationClient(originalClient);
    if (client == null) {
      const message = 'Connect to the server before uploading this file.';
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
      final detail = describeFailure(
        e,
        lead: "Couldn't upload this file.",
      ).detail;
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
            detail: detail,
          );
        }
      }
      transferController.markFailed(transferId, message);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: message,
        detail: detail,
      );
    } finally {
      _unregisterCancellationToken(transferId, cancellationToken);
    }
  });

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
        'UPLOAD_TOO_LARGE' => 'Upload is larger than the server limit.',
        'UPLOAD_NOT_FOUND' => _uploadResumeUnavailableMessage,
        'UPLOAD_EXPIRED' => _uploadResumeUnavailableMessage,
        'UPLOAD_SIZE_MISMATCH' =>
          'Upload size did not match the server record.',
        'BAD_PARAM' => 'Upload request was rejected by the server.',
        _ => userFacingMessage(
          error,
          lead: "Couldn't upload this file.",
        ),
      };
    }
    return userFacingMessage(error, lead: "Couldn't upload this file.");
  }

  /// The ledger's staging state for [transferId], or null for a fresh start.
  ///
  /// A download keeps its transfer id across attempts — `retryTransfer` reuses
  /// the row — so the `.part` file and the validators it was fetched with
  /// outlive a cancel, a failure and an app restart. Null when the row has no
  /// partial file: the loop then truncates whatever it finds and starts at 0.
  SessionFileDownloadCheckpoint? _downloadCheckpoint(String transferId) {
    final transfer = transferController.transferById(transferId);
    final partialFilePath = transfer?.partialFilePath;
    if (transfer == null || partialFilePath == null) return null;
    return SessionFileDownloadCheckpoint(
      partialFilePath: partialFilePath,
      bytesTransferred: transfer.bytesTransferred ?? 0,
      totalBytes: transfer.totalBytes,
      etag: transfer.downloadEtag,
      lastModified: transfer.downloadLastModified,
    );
  }

  /// Commits one staging checkpoint to the durable ledger.
  Future<void> _commitDownloadCheckpoint(
    String transferId,
    SessionFileDownloadCheckpoint checkpoint,
  ) {
    return transferController.updateDownloadCheckpoint(
      id: transferId,
      partialFilePath: checkpoint.partialFilePath,
      bytesTransferred: checkpoint.bytesTransferred,
      totalBytes: checkpoint.totalBytes,
      etag: checkpoint.etag,
      lastModified: checkpoint.lastModified,
    );
  }

  Future<SessionArtifactTransferWorkerResult> _runSessionFileDownload({
    required String transferId,
    required SessionDetailKey sessionKey,
    required String path,
    required String fileName,
    required bool hasActiveBrokerClient,
    String? mimeType,
  }) => _withPinnedTransport(
    transferId,
    () async {
      // Platform capability gate: on iOS/Android, hand the workspace-file
      // download to the native engine so it survives backgrounding. Other
      // platforms use the foreground resumable path below.
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
      final runAttempt = transferController
          .transferById(transferId)
          ?.attemptCount;
      SessionArtifactTransfer? exportingTransfer;
      transferController.markRunning(transferId, message: 'Downloading...');

      if (!hasActiveBrokerClient) {
        const message = 'Connect to the server before downloading this file.';
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
        var cached = fileService is ResumableSessionArtifactFileService
            ? await (fileService as ResumableSessionArtifactFileService)
                  .cacheSessionFileResumable(
                    tool: sessionKey.tool,
                    sessionId: sessionKey.sessionId,
                    path: path,
                    fileName: fileName,
                    mimeType: mimeType,
                    checkpoint: _downloadCheckpoint(transferId),
                    onCheckpoint: (checkpoint) =>
                        _commitDownloadCheckpoint(transferId, checkpoint),
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
        exportingTransfer = transferController.transferById(transferId);
        final destination = await _saveQueue.run(
          () => fileService.exportCachedArtifact(
            cached,
            cancellationToken: cancellationToken,
          ),
          transferId: transferId,
          cancellationToken: cancellationToken,
        );
        if (cancellationToken.isCanceled ||
            !identical(
              transferController.transferById(transferId),
              exportingTransfer,
            )) {
          return SessionArtifactTransferWorkerResult(
            transferId: transferId,
            outcome: SessionArtifactTransferWorkerOutcome.canceled,
            cachedFile: cached,
          );
        }
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

        cached = _withExportedName(cached, destination);
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
        final current = transferController.transferById(transferId);
        if (current?.attemptCount == runAttempt &&
            (current?.status == SessionArtifactTransferStatus.running ||
                current?.status == SessionArtifactTransferStatus.cached) &&
            (exportingTransfer == null ||
                identical(current, exportingTransfer))) {
          transferController.markCanceled(transferId, message: e.message);
        }
        return SessionArtifactTransferWorkerResult(
          transferId: transferId,
          outcome: SessionArtifactTransferWorkerOutcome.canceled,
          message: e.message,
        );
      } on Object catch (e) {
        if (cancellationToken.isCanceled ||
            transferController.transferById(transferId)?.attemptCount !=
                runAttempt ||
            (exportingTransfer != null &&
                !identical(
                  transferController.transferById(transferId),
                  exportingTransfer,
                ))) {
          return _canceledSaveResult(transferId);
        }
        final failure = describeFailure(
          e,
          lead: "Couldn't download this file.",
        );
        final message = failure.message;
        if (_saveUnavailable(e)) return _deferredSaveResult(transferId);
        transferController.markFailed(transferId, message);
        return SessionArtifactTransferWorkerResult(
          transferId: transferId,
          outcome: SessionArtifactTransferWorkerOutcome.failed,
          message: message,
          detail: failure.detail,
        );
      } finally {
        _unregisterCancellationToken(transferId, cancellationToken);
      }
    },
    expectedAttempt: transferController.transferById(transferId)?.attemptCount,
  );

  /// Requests active cancellation for a queued or running transfer.
  ///
  /// Also cancels the native background task, if any, so a backgrounded
  /// download stops when the user cancels from the transfer manager.
  void cancelTransfer(String transferId) {
    _cancellationTokens[transferId]?.cancel();
    _saveQueue.cancel(transferId);
    unawaited(backgroundCoordinator?.cancel(transferId));
    transferController.cancelTransfer(transferId);
  }

  Future<SessionArtifactTransferWorkerResult> _runDownload({
    required String transferId,
    required SessionDetailKey sessionKey,
    required SessionArtifactDescriptor descriptor,
    required bool hasActiveBrokerClient,
  }) => _withPinnedTransport(
    transferId,
    () async {
      final cancellationToken = _registerCancellationToken(transferId);
      final runAttempt = transferController
          .transferById(transferId)
          ?.attemptCount;
      SessionArtifactTransfer? exportingTransfer;
      transferController.markRunning(transferId, message: 'Downloading...');

      if (!descriptor.isInlineDataUrl && !hasActiveBrokerClient) {
        const message =
            'Connect to the server before downloading this artifact.';
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
        var cached = await fileService.cacheArtifact(
          descriptor,
          checkpoint: _downloadCheckpoint(transferId),
          onCheckpoint: (checkpoint) =>
              _commitDownloadCheckpoint(transferId, checkpoint),
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
        exportingTransfer = transferController.transferById(transferId);
        final destination = await _saveQueue.run(
          () => fileService.exportCachedArtifact(
            cached,
            cancellationToken: cancellationToken,
          ),
          transferId: transferId,
          cancellationToken: cancellationToken,
        );
        if (cancellationToken.isCanceled ||
            !identical(
              transferController.transferById(transferId),
              exportingTransfer,
            )) {
          return SessionArtifactTransferWorkerResult(
            transferId: transferId,
            outcome: SessionArtifactTransferWorkerOutcome.canceled,
            cachedFile: cached,
          );
        }
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

        cached = _withExportedName(cached, destination);
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
        final current = transferController.transferById(transferId);
        if (current?.attemptCount == runAttempt &&
            (current?.status == SessionArtifactTransferStatus.running ||
                current?.status == SessionArtifactTransferStatus.cached) &&
            (exportingTransfer == null ||
                identical(current, exportingTransfer))) {
          transferController.markCanceled(transferId, message: e.message);
        }
        return SessionArtifactTransferWorkerResult(
          transferId: transferId,
          outcome: SessionArtifactTransferWorkerOutcome.canceled,
          message: e.message,
        );
      } on Object catch (e) {
        if (cancellationToken.isCanceled ||
            transferController.transferById(transferId)?.attemptCount !=
                runAttempt ||
            (exportingTransfer != null &&
                !identical(
                  transferController.transferById(transferId),
                  exportingTransfer,
                ))) {
          return _canceledSaveResult(transferId);
        }
        final failure = describeFailure(
          e,
          lead: "Couldn't save this artifact.",
        );
        final message = failure.message;
        if (_saveUnavailable(e)) return _deferredSaveResult(transferId);
        transferController.markFailed(transferId, message);
        return SessionArtifactTransferWorkerResult(
          transferId: transferId,
          outcome: SessionArtifactTransferWorkerOutcome.failed,
          message: message,
          detail: failure.detail,
        );
      } finally {
        _unregisterCancellationToken(transferId, cancellationToken);
      }
    },
    expectedAttempt: transferController.transferById(transferId)?.attemptCount,
  );

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
  }) => _withPinnedTransport(transferId, () async {
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
      const message = 'Connect to the server before previewing this artifact.';
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
        checkpoint: _downloadCheckpoint(transferId),
        onCheckpoint: (checkpoint) =>
            _commitDownloadCheckpoint(transferId, checkpoint),
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
      final failure = describeFailure(
        e,
        lead: "Couldn't prepare this artifact preview.",
      );
      final message = failure.message;
      transferController.markFailed(transferId, message);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: message,
        detail: failure.detail,
      );
    } finally {
      _unregisterCancellationToken(transferId, cancellationToken);
    }
  });

  String? _artifactReferenceError(
    SessionDetailKey sessionKey,
    SessionArtifactDescriptor descriptor,
  ) {
    if (descriptor.isInlineDataUrl) return null;
    final originalClient = brokerClient;
    final client = originalClient == null
        ? null
        : brokerRouteOperationClient(originalClient);
    final source = Uri.tryParse(descriptor.downloadSourceUrl ?? '');
    final broker = client == null ? null : Uri.tryParse(client.baseUrl);
    Uri? resolvedSource;
    if (source != null && broker != null) {
      if (source.hasScheme) {
        resolvedSource = source;
      } else if (!source.hasAuthority && source.path.startsWith('/')) {
        resolvedSource = broker.resolveUri(source);
      }
    }
    final artifactKey = descriptor.artifactKey?.trim() ?? '';
    final contentHash = descriptor.contentHash?.trim() ?? '';
    if (source == null ||
        broker == null ||
        resolvedSource == null ||
        resolvedSource.userInfo.isNotEmpty ||
        !_sameOrigin(resolvedSource, broker) ||
        artifactKey.isEmpty ||
        contentHash.isEmpty ||
        resolvedSource.queryParameters['expires']?.isNotEmpty != true ||
        resolvedSource.queryParameters['sig']?.isNotEmpty != true) {
      return _artifactReferenceMismatchMessage;
    }
    final segments = resolvedSource.pathSegments;
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

  Future<SessionArtifactTransferWorkerResult> _withPinnedTransport(
    String transferId,
    Future<SessionArtifactTransferWorkerResult> Function() action, {
    int? expectedAttempt,
  }) async {
    bool isCurrent() =>
        expectedAttempt == null ||
        transferController.transferById(transferId)?.attemptCount ==
            expectedAttempt;
    try {
      onFailureDetail?.call(transferId, null);
      final result = await withPinnedBrokerRoute(brokerClient, action);
      if (!isCurrent()) return _canceledSaveResult(transferId);
      onFailureDetail?.call(
        transferId,
        result.outcome == SessionArtifactTransferWorkerOutcome.failed
            ? result.detail
            : null,
      );
      return result;
    } on Object catch (error) {
      if (!isCurrent()) return _canceledSaveResult(transferId);
      final failure = describeFailure(
        error,
        lead: "Couldn't transfer this file.",
      );
      final message = failure.message;
      transferController.markFailed(transferId, message);
      onFailureDetail?.call(transferId, failure.detail);
      return SessionArtifactTransferWorkerResult(
        transferId: transferId,
        outcome: SessionArtifactTransferWorkerOutcome.failed,
        message: message,
        detail: failure.detail,
      );
    }
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
