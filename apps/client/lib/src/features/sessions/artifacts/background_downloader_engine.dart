import 'dart:async';

import 'package:background_downloader/background_downloader.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_file_background_download.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// `background_downloader`-backed [SessionFileBackgroundDownloader].
///
/// This is the only file that imports the package. It holds no reconciliation
/// logic: it maps package tasks/records/updates onto the repo-owned seam types
/// so the coordinator (and its tests) never touch a platform channel.
///
/// Native setup (per the package README): iOS needs no `Info.plist` or
/// AppDelegate changes for downloads (it registers its own `URLSession`
/// background handler); Android needs no manifest entries for downloads
/// without notifications. All
/// channel work is deferred out of the constructor so merely building the
/// provider is safe under unit tests.
final class BackgroundDownloaderSessionFileDownloader
    implements SessionFileBackgroundDownloader {
  /// Creates a [BackgroundDownloaderSessionFileDownloader].
  BackgroundDownloaderSessionFileDownloader();

  bool _started = false;

  @override
  bool get isSupported {
    if (kIsWeb) {
      return false;
    }
    // Only iOS (URLSession background sessions) and Android (WorkManager)
    // actually keep downloading while backgrounded. Everywhere else the caller
    // falls through to the foreground resumable path unchanged.
    return defaultTargetPlatform == TargetPlatform.iOS ||
        defaultTargetPlatform == TargetPlatform.android;
  }

  @override
  Future<void> ensureStarted() async {
    if (_started) {
      return;
    }
    // Activates the tracking database and reschedules tasks killed while the
    // app was gone. Idempotent on the package side.
    await FileDownloader().start();
    _started = true;
  }

  @override
  Future<bool> enqueue(BackgroundSessionDownloadRequest request) {
    final task = DownloadTask(
      taskId: request.taskId,
      url: request.url,
      headers: request.headers,
      filename: request.stagingFileName,
      directory: request.directory,
      baseDirectory: BaseDirectory.temporary,
      updates: Updates.statusAndProgress,
      allowPause: true,
    );
    return FileDownloader().enqueue(task);
  }

  @override
  Future<List<BackgroundDownloadRecord>> loadRecords() async {
    final records = await FileDownloader().database.allRecords();
    return Future.wait(records.map(_fromRecord));
  }

  @override
  Future<BackgroundDownloadRecord?> recordFor(String taskId) async {
    final record = await FileDownloader().database.recordForId(taskId);
    return record == null ? null : _fromRecord(record);
  }

  @override
  Future<void> cancel(String taskId) async {
    await FileDownloader().cancelTaskWithId(taskId);
  }

  @override
  Future<void> forget(String taskId) async {
    try {
      await FileDownloader().database.deleteRecordWithId(taskId);
    } on Object {
      // Best-effort cleanup; a missing record is fine.
    }
  }

  @override
  Stream<BackgroundDownloadRecord> updates() {
    return FileDownloader().updates.asyncMap(_fromUpdate);
  }

  Future<BackgroundDownloadRecord> _fromRecord(TaskRecord record) async {
    final status = _mapStatus(record.status);
    return BackgroundDownloadRecord(
      taskId: record.taskId,
      status: status,
      bytesTransferred: _bytesTransferred(
        record.progress,
        record.expectedFileSize,
      ),
      totalBytes: _totalBytes(record.expectedFileSize),
      filePath: status == BackgroundDownloadTaskStatus.complete
          ? await record.task.filePath()
          : null,
      errorMessage: record.exception?.description,
    );
  }

  Future<BackgroundDownloadRecord> _fromUpdate(TaskUpdate update) async {
    switch (update) {
      case TaskStatusUpdate():
        final status = _mapStatus(update.status);
        return BackgroundDownloadRecord(
          taskId: update.task.taskId,
          status: status,
          filePath: status == BackgroundDownloadTaskStatus.complete
              ? await update.task.filePath()
              : null,
          mimeType: update.mimeType,
          errorMessage: update.exception?.description,
        );
      case TaskProgressUpdate():
        return BackgroundDownloadRecord(
          taskId: update.task.taskId,
          status: BackgroundDownloadTaskStatus.running,
          bytesTransferred: _bytesTransferred(
            update.progress,
            update.expectedFileSize,
          ),
          totalBytes: _totalBytes(update.expectedFileSize),
        );
    }
  }

  static BackgroundDownloadTaskStatus _mapStatus(TaskStatus status) {
    return switch (status) {
      TaskStatus.enqueued => BackgroundDownloadTaskStatus.enqueued,
      TaskStatus.running => BackgroundDownloadTaskStatus.running,
      TaskStatus.complete => BackgroundDownloadTaskStatus.complete,
      TaskStatus.notFound => BackgroundDownloadTaskStatus.notFound,
      TaskStatus.failed => BackgroundDownloadTaskStatus.failed,
      TaskStatus.canceled => BackgroundDownloadTaskStatus.canceled,
      TaskStatus.waitingToRetry => BackgroundDownloadTaskStatus.waitingToRetry,
      TaskStatus.paused => BackgroundDownloadTaskStatus.paused,
    };
  }

  static int? _bytesTransferred(double progress, int expectedFileSize) {
    if (expectedFileSize <= 0) {
      return null;
    }
    if (progress <= 0) {
      return 0;
    }
    if (progress >= 1) {
      return expectedFileSize;
    }
    return (progress * expectedFileSize).round();
  }

  static int? _totalBytes(int expectedFileSize) =>
      expectedFileSize > 0 ? expectedFileSize : null;
}

/// App provider for the native background download engine.
///
/// Returns `null` on platforms that do not truly background downloads so the
/// worker skips the coordinator and keeps the foreground resumable path.
final sessionFileBackgroundDownloaderProvider =
    Provider<SessionFileBackgroundDownloader?>((ref) {
      final engine = BackgroundDownloaderSessionFileDownloader();
      return engine.isSupported ? engine : null;
    });
