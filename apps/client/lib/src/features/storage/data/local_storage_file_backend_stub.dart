import 'package:cosyncing_client/src/features/storage/data/local_storage_file_backend.dart';
import 'package:cosyncing_client/src/features/storage/data/managed_memory_files.dart';

/// Browser storage is the bounded, app-owned memory cache.
LocalStorageFileBackend createLocalStorageFileBackend(
  ManagedMemoryFiles memory,
) => memory;
