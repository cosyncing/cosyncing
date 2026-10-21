import 'dart:typed_data';

import 'package:cosyncing_client/src/features/storage/data/device_file_registry.dart';
import 'package:cosyncing_client/src/features/storage/data/local_storage_file_backend.dart';
import 'package:cosyncing_client/src/features/storage/data/managed_file_access.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Bounded browser memory copies shared across broker-client generations.
/// Reloading discards them; they are never reported as reclaimed disk bytes.
final class ManagedMemoryFiles implements LocalStorageFileBackend {
  final Map<String, Uint8List> _entries = {};
  int _bytes = 0;

  /// Retains a complete copy, evicting only entries without readers.
  String retain(List<int> bytes) {
    const maximumBytes = 64 * 1024 * 1024;
    if (bytes.length > maximumBytes) {
      throw const LocalStorageException(
        'Artifact exceeds the browser cache limit.',
      );
    }
    while (_entries.length >= 16 || _bytes + bytes.length > maximumBytes) {
      final candidates = _entries.keys.where(
        (key) => !ManagedFileAccess.shared.inUse(key),
      );
      if (candidates.isEmpty) {
        throw const LocalStorageException('Browser cache is in use.');
      }
      _bytes -= _entries.remove(candidates.first)!.length;
    }
    final id = 'browser-artifact:${newStorageId()}';
    final retained = Uint8List.fromList(bytes);
    _entries[id] = retained;
    _bytes += retained.length;
    return id;
  }

  /// Returns a retained copy while refreshing its bounded LRU position.
  Uint8List? read(String id) {
    final bytes = _entries.remove(id);
    if (bytes != null) _entries[id] = bytes;
    return bytes;
  }

  @override
  Future<LocalFileObservation?> inspect(String location) async {
    if (!location.startsWith('browser-artifact:')) {
      throw const LocalStorageException('UNAVAILABLE');
    }
    final bytes = _entries[location];
    return bytes == null
        ? null
        : LocalFileObservation(size: bytes.length, version: location);
  }

  @override
  Future<int?> remove(String location, String version) async {
    if (version != location) {
      throw const LocalStorageException('OBJECT_CHANGED');
    }
    final bytes = _entries.remove(location);
    if (bytes == null) return null;
    _bytes -= bytes.length;
    return bytes.length;
  }
}

/// No cache allocation or scan occurs until a download/storage action uses it.
final managedMemoryFilesProvider = Provider<ManagedMemoryFiles>(
  (ref) => ManagedMemoryFiles(),
);
