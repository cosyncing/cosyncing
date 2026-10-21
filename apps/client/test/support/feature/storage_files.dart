import 'dart:async';

import 'package:cosyncing_client/src/features/storage/data/local_storage_file_backend.dart';
import 'package:cosyncing_client/src/platform/storage/local_storage_file_backend_io.dart';

/// Real filesystem operations run outside the widget test's virtual clock;
/// app state, ownership checks and cleanup admission still run normally.
class NativeStorageFiles
    implements LocalStorageFileBackend, LocalStorageDiscovery {
  NativeStorageFiles(this.files, this.ioZone);
  final NativeLocalStorageFileBackend files;
  final Zone ioZone;
  Future<void>? pending;
  Future<T> _io<T>(Future<T> Function() action) {
    final result = Completer<T>();
    pending = ioZone.run(() async {
      try {
        result.complete(await action());
      } on Object catch (error, stack) {
        result.completeError(error, stack);
      }
    });
    return result.future;
  }

  @override
  Future<LocalFileObservation?> inspect(String location) =>
      _io(() => files.inspect(location));
  @override
  Future<int?> remove(String location, String version) =>
      _io(() => files.remove(location, version));
  @override
  Stream<LocalStorageDiscoveredFile> discover() async* {
    yield* Stream.fromIterable(await _io(() => files.discover().toList()));
  }
}

/// The filesystem edge of storage journeys. Production ownership, inventory,
/// planning, admission and outcome persistence all run above this boundary.
final class StorageFiles implements LocalStorageFileBackend {
  /// Files present on the device, including unregistered external exports.
  final Map<String, LocalFileObservation> entries = {};

  /// Inspection is observable so unrelated navigation cannot hide a scan.
  int inspections = 0;

  /// Copies for which the OS refuses unlinking.
  final Set<String> refused = {};

  /// Copies whose size and eligibility the OS cannot inspect.
  final Set<String> unavailable = {};

  /// Models a lifecycle transition at the OS unlink boundary.
  void Function()? beforeRemove;

  @override
  Future<LocalFileObservation?> inspect(String location) async {
    inspections++;
    if (unavailable.contains(location)) {
      throw const LocalStorageException('UNAVAILABLE');
    }
    return entries[location];
  }

  @override
  Future<int?> remove(String location, String version) async {
    beforeRemove?.call();
    if (refused.contains(location)) {
      throw Exception('Fixture permission denied');
    }
    final current = entries[location];
    if (current == null) return null;
    if (current.version != version) {
      throw const LocalStorageException('OBJECT_CHANGED');
    }
    entries.remove(location);
    return current.size;
  }
}
