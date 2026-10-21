// Inventory I/O must yield between files instead of blocking the UI isolate.
// ignore_for_file: avoid_slow_async_io

import 'dart:io';

import 'package:cosyncing_client/src/features/storage/data/local_storage_file_backend.dart';
import 'package:cosyncing_client/src/features/storage/data/managed_memory_files.dart';
import 'package:path/path.dart' as path;
import 'package:path_provider/path_provider.dart';

/// Native app cache boundary. It never traverses arbitrary workspace roots.
final class NativeLocalStorageFileBackend
    implements
        LocalStorageFileBackend,
        LocalDatabaseStorageMeasurement,
        LocalStorageDiscovery {
  /// Production root, with a test seam for isolated fixtures.
  NativeLocalStorageFileBackend({
    Future<String> Function()? root,
    String? previewRoot,
  }) : _root = root ?? _artifactRoot,
       _previewRoot =
           previewRoot ??
           path.join(
             Directory.systemTemp.path,
             'cosyncing_client',
             'artifact_previews',
           );

  final Future<String> Function() _root;
  final String _previewRoot;

  static Future<String> _artifactRoot() async => path.join(
    (await getTemporaryDirectory()).path,
    'cosyncing_client_artifacts',
  );

  Future<File> _ownedFile(String location) async {
    final root = path.normalize(path.absolute(await _root()));
    final target = path.normalize(path.absolute(location));
    final previews = path.normalize(_previewRoot);
    final preview =
        path.dirname(path.dirname(target)) == previews &&
        path.basename(path.dirname(target)).startsWith('artifact_preview');
    final ownedRoot = preview ? previews : root;
    if ((!preview && path.dirname(target) != root) ||
        target.endsWith('.part')) {
      throw const FileSystemException('UNMANAGED');
    }
    final rootType = await FileSystemEntity.type(ownedRoot, followLinks: false);
    if (rootType == FileSystemEntityType.notFound) return File(target);
    if (rootType != FileSystemEntityType.directory) {
      throw const FileSystemException('UNMANAGED');
    }
    final realRoot = await Directory(ownedRoot).resolveSymbolicLinks();
    if (preview) {
      final parent = path.dirname(target);
      final parentType = await FileSystemEntity.type(
        parent,
        followLinks: false,
      );
      if (parentType == FileSystemEntityType.notFound) return File(target);
      if (parentType != FileSystemEntityType.directory ||
          path.normalize(await Directory(parent).resolveSymbolicLinks()) !=
              path.join(realRoot, path.basename(parent))) {
        throw const FileSystemException('UNMANAGED');
      }
    }
    final type = await FileSystemEntity.type(target, followLinks: false);
    if (type != FileSystemEntityType.file &&
        type != FileSystemEntityType.notFound) {
      throw const FileSystemException('UNMANAGED');
    }
    if (type == FileSystemEntityType.file &&
        path.normalize(await File(target).resolveSymbolicLinks()) !=
            path.join(realRoot, path.relative(target, from: ownedRoot))) {
      throw const FileSystemException('UNMANAGED');
    }
    return File(target);
  }

  @override
  Future<LocalFileObservation?> inspect(String location) async {
    final file = await _ownedFile(location);
    final stat = await file.stat();
    if (stat.type == FileSystemEntityType.notFound) return null;
    if (stat.type != FileSystemEntityType.file) {
      throw const FileSystemException('UNMANAGED');
    }
    return LocalFileObservation(
      size: stat.size,
      version:
          '${stat.size}:${stat.modified.microsecondsSinceEpoch}:'
          '${stat.changed.microsecondsSinceEpoch}',
    );
  }

  @override
  Future<int?> databaseBytes(String databasePath) async {
    if (databasePath.isEmpty || !path.isAbsolute(databasePath)) return null;
    var total = 0;
    try {
      for (final suffix in ['', '-wal']) {
        final file = File('$databasePath$suffix');
        final type = await FileSystemEntity.type(file.path, followLinks: false);
        if (suffix.isNotEmpty && type == FileSystemEntityType.notFound) {
          continue;
        }
        if (type != FileSystemEntityType.file) return null;
        final stat = await file.stat();
        if (stat.type != FileSystemEntityType.file) return null;
        total += stat.size;
      }
      return total;
    } on FileSystemException {
      return null;
    }
  }

  @override
  Stream<LocalStorageDiscoveredFile> discover() async* {
    final cacheRoot = path.normalize(path.absolute(await _root()));
    final previewRoot = _previewRoot;
    var inspected = 0;
    Stream<LocalStorageDiscoveredFile> entries(
      String root, {
      bool previewDirectories = false,
    }) async* {
      try {
        final type = await FileSystemEntity.type(root, followLinks: false);
        if (type == FileSystemEntityType.notFound) return;
        if (type != FileSystemEntityType.directory) {
          yield LocalStorageDiscoveredFile(root, null);
          return;
        }
        final realRoot = await Directory(root).resolveSymbolicLinks();
        await for (final entity in Directory(root).list(followLinks: false)) {
          if (++inspected > 20000) {
            yield LocalStorageDiscoveredFile(root, null);
            return;
          }
          if (previewDirectories &&
              entity is Directory &&
              path.basename(entity.path).startsWith('artifact_preview') &&
              path.normalize(await entity.resolveSymbolicLinks()) ==
                  path.join(realRoot, path.basename(entity.path))) {
            yield* entries(entity.path);
          } else if (entity is File) {
            final stat = await entity.stat();
            yield LocalStorageDiscoveredFile(
              entity.path,
              stat.type == FileSystemEntityType.file ? stat.size : null,
            );
          } else {
            // A link, nested directory or unknown object is never traversed.
            yield LocalStorageDiscoveredFile(entity.path, null);
          }
        }
      } on FileSystemException {
        yield LocalStorageDiscoveredFile(root, null);
      }
    }

    yield* entries(cacheRoot);
    if (inspected <= 20000) {
      yield* entries(previewRoot, previewDirectories: true);
    }
  }

  @override
  Future<int?> remove(String location, String version) async {
    final current = await inspect(location);
    if (current == null) return null;
    if (current.version != version) {
      throw const LocalStorageException('OBJECT_CHANGED');
    }
    final file = await _ownedFile(location);
    await file.delete();
    return current.size;
  }
}

/// The platform default.
LocalStorageFileBackend createLocalStorageFileBackend(
  ManagedMemoryFiles memory,
) => NativeLocalStorageFileBackend();
