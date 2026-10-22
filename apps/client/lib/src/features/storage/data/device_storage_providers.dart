import 'package:cosyncing_client/src/features/sessions/detail/session_cache.dart';
import 'package:cosyncing_client/src/features/storage/data/device_file_registry.dart';
import 'package:cosyncing_client/src/features/storage/data/device_storage_service.dart';
import 'package:cosyncing_client/src/features/storage/data/local_storage_file_backend.dart';
import 'package:cosyncing_client/src/features/storage/data/local_storage_file_backend_stub.dart'
    if (dart.library.io) 'package:cosyncing_client/src/platform/storage/local_storage_file_backend_io.dart'
    as platform;
import 'package:cosyncing_client/src/features/storage/data/managed_memory_files.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:cosyncing_client/src/platform/clock/app_clock.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Filesystem edge; reading metadata never authorizes deletion ownership.
final localStorageFileBackendProvider = Provider<LocalStorageFileBackend>(
  (ref) => platform.createLocalStorageFileBackend(
    ref.watch(managedMemoryFilesProvider),
  ),
);

/// Demand-driven storage work. Reading this provider starts no scan or timer.
final deviceStorageServiceProvider = Provider<DeviceStorageService>((ref) {
  final service = DeviceStorageService(
    database: ref.watch(appDatabaseProvider),
    registry: ref.watch(deviceFileRegistryProvider),
    files: ref.watch(localStorageFileBackendProvider),
    now: ref.watch(appClockProvider),
    cache: ref.watch(sessionCacheManagementProvider),
  );
  ref.onDispose(service.dispose);
  return service;
});
