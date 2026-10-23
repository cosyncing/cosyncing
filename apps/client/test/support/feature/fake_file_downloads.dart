// Platform boundaries for Android downloads. The native stream is deliberately
// single-subscription; its tracking database survives a process restart.
import 'dart:async';
import 'dart:io';

import 'package:cosyncing_client/src/features/sessions/artifacts/session_file_background_download.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path_provider_platform_interface/path_provider_platform_interface.dart';

class FakeDownloadTrackingDatabase {
  final records = <String, BackgroundDownloadRecord>{};
  final launches = <FakeBackgroundDownloadEngine>[];

  FakeBackgroundDownloadEngine launch() {
    final engine = FakeBackgroundDownloadEngine(this);
    launches.add(engine);
    return engine;
  }

  void complete(String id, String path, {String mimeType = 'text/markdown'}) {
    final record = BackgroundDownloadRecord(
      taskId: id,
      status: BackgroundDownloadTaskStatus.complete,
      filePath: path,
      mimeType: mimeType,
    );
    records[id] = record;
    if (launches.isNotEmpty) launches.last.emit(record);
  }
}

class FakeBackgroundDownloadEngine implements SessionFileBackgroundDownloader {
  FakeBackgroundDownloadEngine([FakeDownloadTrackingDatabase? database])
    : database = database ?? FakeDownloadTrackingDatabase() {
    _updates = StreamController<BackgroundDownloadRecord>(
      onListen: () => listens++,
    );
  }

  final FakeDownloadTrackingDatabase database;
  late final StreamController<BackgroundDownloadRecord> _updates;
  bool started = false;
  bool enqueueAccepted = true;
  Completer<void>? startup;
  int listens = 0;
  int starts = 0;
  int recordLoads = 0;
  final enqueued = <BackgroundSessionDownloadRequest>[];
  final canceled = <String>[];
  final forgotten = <String>[];
  List<BackgroundDownloadRecord> get records =>
      database.records.values.toList();
  set records(List<BackgroundDownloadRecord> values) {
    database.records
      ..clear()
      ..addEntries(values.map((r) => MapEntry(r.taskId, r)));
  }

  // Like the real plugin, updates without a native listener are dropped.
  void emit(BackgroundDownloadRecord record) {
    if (!_updates.isClosed && _updates.hasListener) _updates.add(record);
  }

  Future<void> dispose() => _updates.close();
  @override
  bool get isSupported => true;
  @override
  Future<void> ensureStarted() async {
    starts++;
    started = true;
    await startup?.future;
  }

  @override
  Future<bool> enqueue(BackgroundSessionDownloadRequest request) async {
    enqueued.add(request);
    if (enqueueAccepted) {
      database.records[request.taskId] = BackgroundDownloadRecord(
        taskId: request.taskId,
        status: BackgroundDownloadTaskStatus.running,
      );
    }
    return enqueueAccepted;
  }

  @override
  Future<List<BackgroundDownloadRecord>> loadRecords() async {
    recordLoads++;
    return records;
  }

  @override
  Future<BackgroundDownloadRecord?> recordFor(String taskId) async =>
      database.records[taskId];
  @override
  Future<void> cancel(String taskId) async {
    canceled.add(taskId);
  }

  @override
  Future<void> forget(String taskId) async {
    forgotten.add(taskId);
    database.records.remove(taskId);
  }

  @override
  Stream<BackgroundDownloadRecord> updates() => _updates.stream;
}

class FakeAndroidSaveAs {
  final requests = <Map<String, dynamic>>[];
  Object? response = <String, dynamic>{
    'uri': 'content://documents/saved/report.md',
    'displayName': '审阅意见.md',
  };
  PlatformException? error;
  Completer<void>? pending;
  void Function()? onCommitted;
  void Function()? onOpened;
  void Function()? beforeReply;
  bool ignoreCancellation = false;
  bool deferCancellation = false;
  Exception? cancelError;
  int? _activeRequest;
  final canceledRequests = <int>[];
  final returnedRequests = <int>[];

  void install() {
    const channel = MethodChannel('com.cosyncing.client/file_export');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          ..setMockMethodCallHandler(channel, (call) async {
            final args = Map<String, dynamic>.from(call.arguments as Map);
            if (call.method == 'cancelSaveAs') {
              final id = args['requestId'] as int;
              canceledRequests.add(id);
              if (!deferCancellation &&
                  _activeRequest == id &&
                  !(pending?.isCompleted ?? true)) {
                pending!.complete();
              }
              final failure = cancelError;
              if (failure != null) throw failure;
              return null;
            }
            expect(call.method, 'saveAs');
            if (_activeRequest != null) throw PlatformException(code: 'busy');
            final id = args['requestId'] as int;
            _activeRequest = id;
            requests.add(args);
            onOpened?.call();
            try {
              await pending?.future;
              if (canceledRequests.contains(id) && !ignoreCancellation) {
                return null;
              }
              final reply = response;
              final failure = error;
              beforeReply?.call();
              if (failure != null) throw failure;
              if (reply != null) onCommitted?.call();
              return reply;
            } finally {
              returnedRequests.add(id);
              _activeRequest = null;
            }
          });
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
  }
}

class DownloadTemporaryPaths extends PathProviderPlatform {
  DownloadTemporaryPaths(this.path);
  final String path;
  @override
  Future<String> getTemporaryPath() async => path;
  @override
  Future<String> getApplicationSupportPath() async => path;
}

/// Small staged native file; the real finalizer moves and registers it.
String stageNativeDownload(
  Directory directory,
  String id, {
  String contents = 'download fixture',
}) {
  final staging = File('${directory.path}/$id.part')
    ..writeAsStringSync(contents);
  return staging.path;
}
