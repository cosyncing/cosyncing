import 'dart:async';

import 'package:cosyncing_client/src/features/sessions/data/session_artifact_descriptor.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_artifact_file_service.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_detail_state.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/drift.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Direction/purpose of an artifact transfer record.
enum SessionArtifactTransferDirection {
  /// User requested a file download/export.
  download,

  /// User requested an HTML preview backed by a cached file.
  preview,

  /// User uploaded a local attachment into the live session.
  upload,
}

/// App-level transfer lifecycle.
enum SessionArtifactTransferStatus {
  /// The transfer was registered but has not started.
  queued,

  /// The artifact is being fetched/cached/exported.
  running,

  /// Artifact bytes are available in app cache.
  cached,

  /// The transfer completed and a user-visible action succeeded.
  completed,

  /// The user canceled the final destination/action.
  canceled,

  /// The transfer failed.
  failed,
}

final _canonicalContentHash = RegExp(r'^sha256:[0-9a-f]{64}$');

const _queuedForRestartMessage = 'Queued to resume after app restart';
const _uploadResumeUnavailableMessage =
    'Upload cannot be resumed after app restart. '
    'Start a new upload from Session Detail.';
const _uploadResumeRequiredMessage =
    'Upload was interrupted; select the file again to resume.';

/// App-lifetime transfer record for artifact file work.
///
/// Module G8 keeps this in memory but deliberately models the fields a Drift
/// table/background worker will need later.
@immutable
class SessionArtifactTransfer {
  /// Creates a [SessionArtifactTransfer].
  const SessionArtifactTransfer({
    required this.id,
    required this.sessionKey,
    required this.actionKey,
    required this.fileName,
    required this.direction,
    required this.status,
    required this.createdAt,
    required this.updatedAt,
    this.brokerProfileId,
    this.attemptCount = 0,
    this.artifactKey,
    this.sourceUrl,
    this.cachedFilePath,
    this.exportedPath,
    this.contentType,
    this.contentHash,
    this.uploadId,
    this.partialFilePath,
    this.downloadEtag,
    this.downloadLastModified,
    this.byteLength,
    this.bytesTransferred,
    this.totalBytes,
    this.error,
    this.message = '',
  });

  /// Stable transfer id.
  final String id;

  /// Broker profile that owns this transfer.
  ///
  /// Null is retained only for pre-v12 rows and isolated test fixtures. A
  /// production worker never replays an unscoped row against an active broker.
  final String? brokerProfileId;

  /// Session that owns this transfer.
  final SessionDetailKey sessionKey;

  /// UI action key from [SessionArtifactDescriptor.actionStateKey].
  final String actionKey;

  /// Display filename known at queue time.
  final String fileName;

  /// Transfer purpose.
  final SessionArtifactTransferDirection direction;

  /// Current lifecycle status.
  final SessionArtifactTransferStatus status;

  /// Number of user-triggered retry attempts.
  final int attemptCount;

  /// Broker artifact key, if provided.
  final String? artifactKey;

  /// Source URL or data URL marker.
  final String? sourceUrl;

  /// App cache path when bytes have been cached.
  final String? cachedFilePath;

  /// User-selected/exported path when a download completes.
  final String? exportedPath;

  /// MIME type when known.
  final String? contentType;

  /// Broker/content hash when known.
  final String? contentHash;

  /// Broker resumable upload id, when known.
  final String? uploadId;

  /// Durable staging file for a resumable workspace download.
  final String? partialFilePath;

  /// Strong ETag associated with [partialFilePath].
  final String? downloadEtag;

  /// Last-Modified validator associated with [partialFilePath].
  final String? downloadLastModified;

  /// Cached byte length when known.
  final int? byteLength;

  /// Bytes transferred so far when progress is known.
  final int? bytesTransferred;

  /// Total expected bytes when known.
  final int? totalBytes;

  /// Error message when [status] is [SessionArtifactTransferStatus.failed].
  final String? error;

  /// User-facing transfer message.
  final String message;

  /// Transfer creation timestamp.
  final DateTime createdAt;

  /// Last mutation timestamp.
  final DateTime updatedAt;

  /// Display label for the direction.
  String get directionLabel => switch (direction) {
    SessionArtifactTransferDirection.download => 'Download',
    SessionArtifactTransferDirection.preview => 'Preview',
    SessionArtifactTransferDirection.upload => 'Upload',
  };

  /// Display label for the current status.
  String get statusLabel => switch (status) {
    SessionArtifactTransferStatus.queued => 'Queued',
    SessionArtifactTransferStatus.running => 'Running',
    SessionArtifactTransferStatus.cached => 'Cached',
    SessionArtifactTransferStatus.completed => 'Complete',
    SessionArtifactTransferStatus.canceled => 'Canceled',
    SessionArtifactTransferStatus.failed => 'Failed',
  };

  /// Human-readable detail string.
  String get detailLabel {
    if (message.isNotEmpty) {
      return message;
    }
    if (error != null && error!.isNotEmpty) {
      return error!;
    }
    return statusLabel;
  }

  /// Whether this transfer can use the explicit upload resume picker flow.
  ///
  /// This requires persisted upload metadata and one of the re-pick eligible
  /// states.
  bool get canSelectFileToResumeUpload {
    return direction == SessionArtifactTransferDirection.upload &&
        (status == SessionArtifactTransferStatus.queued ||
            status == SessionArtifactTransferStatus.failed ||
            status == SessionArtifactTransferStatus.canceled) &&
        uploadId != null &&
        uploadId!.trim().isNotEmpty &&
        byteLength != null &&
        byteLength! >= 0 &&
        contentHash != null &&
        _canonicalContentHash.hasMatch(contentHash!);
  }

  /// Human-readable byte progress, when known.
  String get progressLabel {
    final transferred = bytesTransferred;
    final total = totalBytes;
    if (transferred == null && total == null) {
      return '';
    }
    if (transferred != null && total != null) {
      return '$transferred/$total bytes';
    }
    if (transferred != null) {
      return '$transferred bytes';
    }
    return '0/$total bytes';
  }

  /// Reconstructs the file descriptor needed to retry this transfer.
  ///
  /// Inline `data:` payloads are intentionally not stored in transfer records,
  /// so they cannot be retried from durable metadata.
  SessionArtifactDescriptor? get retryDescriptor {
    if (direction == SessionArtifactTransferDirection.upload) {
      return null;
    }
    final source = sourceUrl;
    if (source == null || source == 'data:') {
      return null;
    }
    return SessionArtifactDescriptor(
      name: fileName,
      mimeType: contentType,
      size: byteLength,
      artifactKey: artifactKey,
      contentHash: contentHash,
      fetchUrl: source,
    );
  }

  /// Returns a copy with optional overrides.
  SessionArtifactTransfer copyWith({
    String? fileName,
    SessionArtifactTransferStatus? status,
    String? cachedFilePath,
    String? exportedPath,
    String? contentType,
    String? contentHash,
    String? uploadId,
    String? partialFilePath,
    String? downloadEtag,
    String? downloadLastModified,
    int? byteLength,
    int? bytesTransferred,
    int? totalBytes,
    String? error,
    String? message,
    DateTime? updatedAt,
    int? attemptCount,
    bool clearUploadId = false,
    bool clearDownloadCheckpoint = false,
    bool clearError = false,
    bool clearProgress = false,
  }) {
    return SessionArtifactTransfer(
      id: id,
      brokerProfileId: brokerProfileId,
      sessionKey: sessionKey,
      actionKey: actionKey,
      fileName: fileName ?? this.fileName,
      direction: direction,
      status: status ?? this.status,
      attemptCount: attemptCount ?? this.attemptCount,
      artifactKey: artifactKey,
      sourceUrl: sourceUrl,
      cachedFilePath: cachedFilePath ?? this.cachedFilePath,
      exportedPath: exportedPath ?? this.exportedPath,
      contentType: contentType ?? this.contentType,
      contentHash: contentHash ?? this.contentHash,
      uploadId: clearUploadId ? null : uploadId ?? this.uploadId,
      partialFilePath: clearDownloadCheckpoint
          ? null
          : partialFilePath ?? this.partialFilePath,
      downloadEtag: clearDownloadCheckpoint
          ? null
          : downloadEtag ?? this.downloadEtag,
      downloadLastModified: clearDownloadCheckpoint
          ? null
          : downloadLastModified ?? this.downloadLastModified,
      byteLength: byteLength ?? this.byteLength,
      bytesTransferred: clearProgress
          ? null
          : bytesTransferred ?? this.bytesTransferred,
      totalBytes: clearProgress ? null : totalBytes ?? this.totalBytes,
      error: clearError ? null : error ?? this.error,
      message: message ?? this.message,
      createdAt: createdAt,
      updatedAt: updatedAt ?? this.updatedAt,
    );
  }
}

/// Persistence boundary for artifact transfer records.
abstract interface class SessionArtifactTransferRepository {
  /// Loads persisted transfers, newest first.
  Future<List<SessionArtifactTransfer>> loadTransfers();

  /// Inserts or updates one transfer.
  Future<void> upsertTransfer(SessionArtifactTransfer transfer);

  /// Deletes completed/canceled/failed transfer records.
  Future<void> deleteTerminalTransfers();
}

/// In-memory repository used until the Drift adapter lands.
class InMemorySessionArtifactTransferRepository
    implements SessionArtifactTransferRepository {
  final _transfers = <SessionArtifactTransfer>[];

  @override
  Future<List<SessionArtifactTransfer>> loadTransfers() async {
    return List.unmodifiable(_transfers);
  }

  @override
  Future<void> upsertTransfer(SessionArtifactTransfer transfer) async {
    final index = _transfers.indexWhere((item) => item.id == transfer.id);
    if (index < 0) {
      _transfers.insert(0, transfer);
    } else {
      _transfers[index] = transfer;
    }
  }

  @override
  Future<void> deleteTerminalTransfers() async {
    _transfers.removeWhere(_isTerminalTransfer);
  }
}

/// Drift-backed artifact transfer repository.
class DriftSessionArtifactTransferRepository
    implements SessionArtifactTransferRepository {
  /// Creates a repository backed by [database].
  const DriftSessionArtifactTransferRepository(this.database);

  /// App-local durable database.
  final AppDatabase database;

  @override
  Future<List<SessionArtifactTransfer>> loadTransfers() async {
    final rows =
        await (database.select(database.artifactTransferRows)..orderBy([
              (row) => OrderingTerm.desc(row.updatedAt),
              (row) => OrderingTerm.desc(row.createdAt),
            ]))
            .get();
    return rows.map(_fromRow).toList(growable: false);
  }

  @override
  Future<void> upsertTransfer(SessionArtifactTransfer transfer) async {
    await database
        .into(database.artifactTransferRows)
        .insertOnConflictUpdate(_toCompanion(transfer));
  }

  @override
  Future<void> deleteTerminalTransfers() async {
    await (database.delete(database.artifactTransferRows)..where(
          (row) => row.status.isIn(const ['completed', 'canceled', 'failed']),
        ))
        .go();
  }

  SessionArtifactTransfer _fromRow(ArtifactTransferRow row) {
    return SessionArtifactTransfer(
      id: row.id,
      brokerProfileId: row.brokerProfileId,
      sessionKey: SessionDetailKey(tool: row.tool, sessionId: row.sessionId),
      actionKey: row.actionKey,
      fileName: row.fileName,
      direction: SessionArtifactTransferDirection.values.byName(row.direction),
      status: SessionArtifactTransferStatus.values.byName(row.status),
      attemptCount: row.attemptCount,
      artifactKey: row.artifactKey,
      sourceUrl: row.sourceUrl,
      cachedFilePath: row.cachedFilePath,
      exportedPath: row.exportedPath,
      contentType: row.contentType,
      contentHash: row.contentHash,
      byteLength: row.byteLength,
      bytesTransferred: row.bytesTransferred,
      totalBytes: row.totalBytes,
      error: row.error,
      message: row.message,
      uploadId: row.uploadId,
      partialFilePath: row.partialFilePath,
      downloadEtag: row.downloadEtag,
      downloadLastModified: row.downloadLastModified,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    );
  }

  ArtifactTransferRowsCompanion _toCompanion(SessionArtifactTransfer transfer) {
    return ArtifactTransferRowsCompanion.insert(
      id: transfer.id,
      brokerProfileId: Value(transfer.brokerProfileId),
      tool: transfer.sessionKey.tool,
      sessionId: transfer.sessionKey.sessionId,
      actionKey: transfer.actionKey,
      fileName: transfer.fileName,
      direction: transfer.direction.name,
      status: transfer.status.name,
      attemptCount: Value(transfer.attemptCount),
      artifactKey: Value(transfer.artifactKey),
      sourceUrl: Value(transfer.sourceUrl),
      cachedFilePath: Value(transfer.cachedFilePath),
      exportedPath: Value(transfer.exportedPath),
      contentType: Value(transfer.contentType),
      contentHash: Value(transfer.contentHash),
      uploadId: Value(transfer.uploadId),
      partialFilePath: Value(transfer.partialFilePath),
      downloadEtag: Value(transfer.downloadEtag),
      downloadLastModified: Value(transfer.downloadLastModified),
      byteLength: Value(transfer.byteLength),
      bytesTransferred: Value(transfer.bytesTransferred),
      totalBytes: Value(transfer.totalBytes),
      error: Value(transfer.error),
      message: Value(transfer.message),
      createdAt: transfer.createdAt,
      updatedAt: transfer.updatedAt,
    );
  }
}

/// App-level transfer persistence provider.
final sessionArtifactTransferRepositoryProvider =
    Provider<SessionArtifactTransferRepository>(
      (ref) => DriftSessionArtifactTransferRepository(
        ref.watch(appDatabaseProvider),
      ),
    );

/// App-lifetime artifact transfer ledger.
final sessionArtifactTransferControllerProvider =
    NotifierProvider<
      SessionArtifactTransferController,
      List<SessionArtifactTransfer>
    >(SessionArtifactTransferController.new);

/// In-memory transfer controller.
///
/// This is intentionally independent from widgets and file services so a later
/// Drift/native background implementation can preserve the same call shape.
class SessionArtifactTransferController
    extends Notifier<List<SessionArtifactTransfer>> {
  var _sequence = 0;
  Future<void> _persistenceQueue = Future<void>.value();

  @override
  List<SessionArtifactTransfer> build() {
    unawaited(hydrate());
    return const [];
  }

  /// Loads persisted transfer records into state.
  Future<void> hydrate() async {
    final repository = ref.read(sessionArtifactTransferRepositoryProvider);
    final transfers = await repository.loadTransfers();
    final now = DateTime.now();
    final normalizedTransfers = [
      for (final transfer in transfers)
        _normalizeTransferForRestart(transfer, now),
    ];
    final currentById = {for (final transfer in state) transfer.id: transfer};
    final merged = [
      ...state,
      for (final transfer in normalizedTransfers)
        if (!currentById.containsKey(transfer.id)) transfer,
    ];
    state = List.unmodifiable(merged);
    if (_sequence < merged.length) {
      _sequence = merged.length;
    }
    final changed = <SessionArtifactTransfer>[];
    for (var i = 0; i < transfers.length; i += 1) {
      final original = transfers[i];
      final normalized = normalizedTransfers[i];
      if (original.status != normalized.status ||
          original.message != normalized.message ||
          original.error != normalized.error) {
        changed.add(normalized);
      }
    }
    if (changed.isNotEmpty) {
      await Future.wait(
        [for (final transfer in changed) _persistInOrder(transfer)],
      );
    }
  }

  /// Queues a transfer and returns its id.
  String queueTransfer({
    required SessionDetailKey sessionKey,
    required SessionArtifactDescriptor descriptor,
    required SessionArtifactTransferDirection direction,
    String? brokerProfileId,
  }) {
    final now = DateTime.now();
    _sequence += 1;
    final id =
        '${sessionKey.tool}:${sessionKey.sessionId}:'
        '${descriptor.actionStateKey}:${direction.name}:$_sequence';
    final transfer = SessionArtifactTransfer(
      id: id,
      brokerProfileId: brokerProfileId,
      sessionKey: sessionKey,
      actionKey: descriptor.actionStateKey,
      fileName: _displayFileName(descriptor),
      direction: direction,
      status: SessionArtifactTransferStatus.queued,
      artifactKey: descriptor.artifactKey,
      sourceUrl: descriptor.isInlineDataUrl
          ? 'data:'
          : descriptor.downloadSourceUrl,
      contentType: descriptor.mimeType,
      contentHash: descriptor.contentHash,
      byteLength: descriptor.size,
      bytesTransferred: 0,
      totalBytes: descriptor.size,
      createdAt: now,
      updatedAt: now,
    );
    state = [transfer, ...state];
    unawaited(_persistInOrder(transfer));
    return id;
  }

  /// Queues a transfer row for a local session attachment upload.
  String queueUploadTransfer({
    required SessionDetailKey sessionKey,
    required String fileName,
    String? brokerProfileId,
    String? mimeType,
    int? byteLength,
    String? contentHash,
  }) {
    final transferId = queueTransfer(
      sessionKey: sessionKey,
      descriptor: SessionArtifactDescriptor(
        name: fileName,
        mimeType: mimeType,
        size: byteLength,
      ),
      direction: SessionArtifactTransferDirection.upload,
      brokerProfileId: brokerProfileId,
    );
    if (byteLength != null || mimeType != null || contentHash != null) {
      _update(
        transferId,
        (transfer, now) => transfer.copyWith(
          contentType: mimeType,
          byteLength: byteLength,
          totalBytes: byteLength,
          contentHash: contentHash,
          updatedAt: now,
        ),
      );
    }
    return transferId;
  }

  /// Persists the current transfer snapshot for the given id.
  Future<void> persistTransfer(String id) async {
    final transfer = transferById(id);
    if (transfer == null) {
      return;
    }
    await _persistInOrder(transfer);
  }

  /// Updates upload metadata and awaits persistence.
  Future<void> updateUploadState({
    required String id,
    String? uploadId,
    int? bytesTransferred,
    int? totalBytes,
    bool clearUploadId = false,
    bool clearProgress = false,
  }) async {
    await _updateAndPersist(
      id,
      (transfer, now) => transfer.copyWith(
        uploadId: uploadId,
        bytesTransferred: bytesTransferred,
        totalBytes: totalBytes,
        clearUploadId: clearUploadId,
        clearProgress: clearProgress,
        updatedAt: now,
      ),
    );
  }

  /// Commits a resumable download staging checkpoint before the next range.
  Future<void> updateDownloadCheckpoint({
    required String id,
    required String partialFilePath,
    required int bytesTransferred,
    int? totalBytes,
    String? etag,
    String? lastModified,
  }) async {
    await _updateAndPersist(
      id,
      (transfer, now) => transfer.copyWith(
        partialFilePath: partialFilePath,
        downloadEtag: etag,
        downloadLastModified: lastModified,
        bytesTransferred: bytesTransferred,
        totalBytes: totalBytes,
        updatedAt: now,
      ),
    );
  }

  /// Marks a transfer as actively running.
  void markRunning(String id, {String message = ''}) {
    _update(
      id,
      (transfer, now) => transfer.copyWith(
        status: SessionArtifactTransferStatus.running,
        message: message,
        updatedAt: now,
        clearError: true,
      ),
    );
  }

  /// Records cached file metadata.
  void markCached(
    String id,
    SessionArtifactCachedFile artifact, {
    String message = '',
  }) {
    _update(
      id,
      (transfer, now) => transfer.copyWith(
        status: SessionArtifactTransferStatus.cached,
        cachedFilePath: artifact.cachedFilePath,
        contentType: artifact.contentType,
        contentHash: artifact.contentHash,
        byteLength: artifact.byteLength,
        bytesTransferred: artifact.byteLength,
        totalBytes: artifact.byteLength,
        message: message,
        updatedAt: now,
        clearError: true,
        clearDownloadCheckpoint: true,
      ),
    );
  }

  /// Records cached file metadata and waits for the durable ledger commit.
  Future<void> markCachedWithPersistence(
    String id,
    SessionArtifactCachedFile artifact, {
    String message = '',
  }) async {
    await _updateAndPersist(
      id,
      (transfer, now) => transfer.copyWith(
        status: SessionArtifactTransferStatus.cached,
        cachedFilePath: artifact.cachedFilePath,
        contentType: artifact.contentType,
        contentHash: artifact.contentHash,
        byteLength: artifact.byteLength,
        bytesTransferred: artifact.byteLength,
        totalBytes: artifact.byteLength,
        message: message,
        updatedAt: now,
        clearError: true,
        clearDownloadCheckpoint: true,
      ),
    );
  }

  /// Marks an upload transfer as completed.
  void markUploaded(
    String id, {
    required int byteLength,
    String? fileName,
    String? exportedPath,
    String? contentType,
    String message = '',
  }) {
    _update(
      id,
      (transfer, now) => transfer.copyWith(
        status: SessionArtifactTransferStatus.completed,
        fileName: fileName,
        exportedPath: exportedPath,
        contentType: contentType,
        byteLength: byteLength,
        bytesTransferred: byteLength,
        totalBytes: transfer.totalBytes ?? byteLength,
        message: message,
        updatedAt: now,
        clearError: true,
      ),
    );
  }

  /// Marks an upload transfer as completed and awaits persistence.
  Future<void> markUploadedWithPersistence(
    String id, {
    required int byteLength,
    String? fileName,
    String? exportedPath,
    String? contentType,
    String message = '',
  }) async {
    await _updateAndPersist(
      id,
      (transfer, now) => transfer.copyWith(
        status: SessionArtifactTransferStatus.completed,
        fileName: fileName,
        exportedPath: exportedPath,
        contentType: contentType,
        byteLength: byteLength,
        bytesTransferred: byteLength,
        totalBytes: transfer.totalBytes ?? byteLength,
        message: message,
        updatedAt: now,
        clearError: true,
      ),
    );
  }

  /// Marks a download/export transfer complete.
  void markExported(
    String id,
    SessionArtifactCachedFile artifact, {
    required String exportedPath,
    String message = '',
  }) {
    _update(
      id,
      (transfer, now) => transfer.copyWith(
        status: SessionArtifactTransferStatus.completed,
        cachedFilePath: artifact.cachedFilePath,
        exportedPath: exportedPath,
        contentType: artifact.contentType,
        contentHash: artifact.contentHash,
        byteLength: artifact.byteLength,
        bytesTransferred: artifact.byteLength,
        totalBytes: artifact.byteLength,
        message: message,
        updatedAt: now,
        clearError: true,
      ),
    );
  }

  /// Marks a preview transfer complete.
  void markPreviewed(
    String id,
    SessionArtifactCachedFile artifact, {
    String message = '',
  }) {
    _update(
      id,
      (transfer, now) => transfer.copyWith(
        status: SessionArtifactTransferStatus.completed,
        cachedFilePath: artifact.cachedFilePath,
        contentType: artifact.contentType,
        contentHash: artifact.contentHash,
        byteLength: artifact.byteLength,
        bytesTransferred: artifact.byteLength,
        totalBytes: artifact.byteLength,
        message: message,
        updatedAt: now,
        clearError: true,
      ),
    );
  }

  /// Marks a transfer canceled.
  void markCanceled(String id, {String message = 'Canceled'}) {
    _update(
      id,
      (transfer, now) => transfer.copyWith(
        status: SessionArtifactTransferStatus.canceled,
        message: message,
        updatedAt: now,
        clearError: true,
      ),
    );
  }

  /// Cancels a queued/running/cached transfer.
  void cancelTransfer(String id) {
    _update(id, (transfer, now) {
      if (_isTerminalTransfer(transfer)) {
        return transfer;
      }
      return transfer.copyWith(
        status: SessionArtifactTransferStatus.canceled,
        message: 'Canceled by user',
        updatedAt: now,
        clearError: true,
      );
    });
  }

  /// Marks a transfer failed.
  void markFailed(String id, String error) {
    _update(
      id,
      (transfer, now) => transfer.copyWith(
        status: SessionArtifactTransferStatus.failed,
        error: error,
        message: error,
        updatedAt: now,
      ),
    );
  }

  /// Records byte progress for an active transfer.
  void markProgress(
    String id, {
    required int bytesTransferred,
    int? totalBytes,
  }) {
    _update(
      id,
      (transfer, now) => transfer.copyWith(
        bytesTransferred: bytesTransferred,
        totalBytes: totalBytes,
        updatedAt: now,
      ),
    );
  }

  /// Requeues a failed or canceled transfer for a future retry.
  void retryTransfer(String id) {
    _update(id, (transfer, now) {
      if (transfer.status != SessionArtifactTransferStatus.failed &&
          transfer.status != SessionArtifactTransferStatus.canceled) {
        return transfer;
      }
      final clearUploadProgress =
          transfer.direction != SessionArtifactTransferDirection.upload;
      return transfer.copyWith(
        status: SessionArtifactTransferStatus.queued,
        attemptCount: transfer.attemptCount + 1,
        message: 'Queued for retry',
        updatedAt: now,
        clearError: true,
        clearProgress: clearUploadProgress,
      );
    });
  }

  /// Returns a transfer by id, when present in memory.
  SessionArtifactTransfer? transferById(String id) {
    for (final transfer in state) {
      if (transfer.id == id) {
        return transfer;
      }
    }
    return null;
  }

  /// Returns transfers for a single session, newest first.
  List<SessionArtifactTransfer> transfersFor(SessionDetailKey sessionKey) {
    return state
        .where((transfer) => transfer.sessionKey == sessionKey)
        .toList(growable: false);
  }

  /// Clears terminal transfer records.
  void clearTerminalTransfers() {
    state = state
        .where((transfer) => !_isTerminalTransfer(transfer))
        .toList(growable: false);
    _queuePersistenceOperation(
      () => ref
          .read(sessionArtifactTransferRepositoryProvider)
          .deleteTerminalTransfers(),
    );
  }

  SessionArtifactTransfer? _updateState(
    String id,
    SessionArtifactTransfer Function(
      SessionArtifactTransfer transfer,
      DateTime now,
    )
    update,
  ) {
    final now = DateTime.now();
    SessionArtifactTransfer? updatedTransfer;
    state = [
      for (final transfer in state)
        if (transfer.id == id)
          updatedTransfer = update(transfer, now)
        else
          transfer,
    ];
    final updated = updatedTransfer;
    if (updated == null) {
      return null;
    }
    return updated;
  }

  void _update(
    String id,
    SessionArtifactTransfer Function(
      SessionArtifactTransfer transfer,
      DateTime now,
    )
    update,
  ) {
    final updated = _updateState(id, update);
    if (updated != null) {
      _queuePersistenceOperation(() => _persistTransfer(updated));
    }
  }

  Future<void> _persistInOrder(SessionArtifactTransfer transfer) {
    return _queuePersistenceOperation(() => _persistTransfer(transfer));
  }

  Future<void> _queuePersistenceOperation(
    Future<void> Function() operation,
  ) {
    final next = _persistenceQueue.then((_) => operation());
    _persistenceQueue = next.catchError((_) {});
    return next;
  }

  Future<void> _persistTransfer(SessionArtifactTransfer transfer) {
    return ref
        .read(sessionArtifactTransferRepositoryProvider)
        .upsertTransfer(transfer);
  }

  Future<void> _updateAndPersist(
    String id,
    SessionArtifactTransfer Function(
      SessionArtifactTransfer transfer,
      DateTime now,
    )
    update,
  ) async {
    final updated = _updateState(id, update);
    if (updated != null) {
      await _persistInOrder(updated);
    }
  }

  SessionArtifactTransfer _normalizeTransferForRestart(
    SessionArtifactTransfer transfer,
    DateTime now,
  ) {
    final isUpload =
        transfer.direction == SessionArtifactTransferDirection.upload;
    if (!isUpload) {
      if (transfer.status != SessionArtifactTransferStatus.running) {
        return transfer;
      }
      return transfer.copyWith(
        status: SessionArtifactTransferStatus.queued,
        message: _queuedForRestartMessage,
        updatedAt: now,
        clearError: true,
      );
    }

    final isReplayable = _isReplayableUploadSource(transfer);
    final isIncompleteUpload =
        transfer.status == SessionArtifactTransferStatus.queued ||
        transfer.status == SessionArtifactTransferStatus.running;
    final shouldNormalize = isIncompleteUpload;
    final message = isReplayable
        ? _uploadResumeRequiredMessage
        : _uploadResumeUnavailableMessage;

    if (!shouldNormalize) {
      return transfer;
    }
    if (!isReplayable) {
      return transfer.copyWith(
        status: SessionArtifactTransferStatus.failed,
        message: message,
        error: message,
        updatedAt: now,
        clearUploadId: true,
      );
    }

    final status = transfer.status == SessionArtifactTransferStatus.running
        ? SessionArtifactTransferStatus.queued
        : transfer.status;

    return transfer.copyWith(
      status: status,
      message: message,
      updatedAt: now,
      clearError: true,
    );
  }

  bool _isReplayableUploadSource(SessionArtifactTransfer transfer) {
    if (transfer.direction != SessionArtifactTransferDirection.upload) {
      return false;
    }
    if (transfer.status != SessionArtifactTransferStatus.queued &&
        transfer.status != SessionArtifactTransferStatus.running) {
      return false;
    }
    final uploadId = transfer.uploadId;
    final contentHash = transfer.contentHash;
    final byteLength = transfer.byteLength;
    if (uploadId == null || uploadId.trim().isEmpty) {
      return false;
    }
    if (byteLength == null || byteLength < 0) {
      return false;
    }
    if (contentHash == null || !_canonicalContentHash.hasMatch(contentHash)) {
      return false;
    }
    return true;
  }

  static String _displayFileName(SessionArtifactDescriptor descriptor) {
    final name = descriptor.name?.trim();
    if (name != null && name.isNotEmpty) {
      return name;
    }
    final path = descriptor.path?.trim();
    if (path != null && path.isNotEmpty) {
      final normalized = path.replaceAll(r'\', '/');
      final parts = normalized.split('/');
      return parts.last.isEmpty ? 'artifact' : parts.last;
    }
    return descriptor.artifactKey ?? 'artifact';
  }
}

bool _isTerminalTransfer(SessionArtifactTransfer transfer) {
  return switch (transfer.status) {
    SessionArtifactTransferStatus.completed ||
    SessionArtifactTransferStatus.canceled ||
    SessionArtifactTransferStatus.failed => true,
    _ => false,
  };
}
