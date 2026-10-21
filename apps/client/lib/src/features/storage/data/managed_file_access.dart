import 'dart:async';

import 'package:cosyncing_client/src/features/storage/data/local_storage_file_backend.dart';

/// Serializes opening app-owned files with cleanup admission.
/// Callers acquire before any asynchronous open and retain until it closes.
final class ManagedFileAccess {
  final Map<String, int> _leases = {};
  final Set<String> _deleting = {};
  final Set<String> _external = {};

  /// Shared process boundary for native previews, exports and cleanup.
  static final shared = ManagedFileAccess();

  /// Whether an open/transfer currently owns the file.
  bool inUse(String path) => (_leases[path] ?? 0) > 0;

  /// Unknown external viewer lifetimes stay protected until this app exits.
  void retainForSession(String path) {
    if (_external.add(path)) acquire(path);
  }

  /// Existing preview retention must respect readers of a scoped directory.
  bool inUseTree(String directory) => _leases.keys.any(
    (key) =>
        key == directory ||
        key.startsWith('$directory/') ||
        key.startsWith('$directory\\'),
  );

  /// Acquires synchronously so cleanup cannot be admitted between check/open.
  void Function() acquire(String path) {
    if (_deleting.contains(path)) throw const LocalStorageException('IN_USE');
    _leases.update(path, (value) => value + 1, ifAbsent: () => 1);
    var released = false;
    return () {
      if (released) return;
      released = true;
      final count = (_leases[path] ?? 1) - 1;
      if (count == 0) {
        _leases.remove(path);
      } else {
        _leases[path] = count;
      }
    };
  }

  /// Runs only when there are no readers and prevents new ones until done.
  Future<T> remove<T>(String path, Future<T> Function() operation) async {
    if (inUse(path) || !_deleting.add(path)) {
      throw const LocalStorageException('IN_USE');
    }
    try {
      return await operation();
    } finally {
      _deleting.remove(path);
    }
  }
}
