import 'dart:math';

import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Opaque, device-local identifiers contain no path or credential.
String newStorageId() {
  final random = Random.secure();
  return List.generate(
    16,
    (_) => random.nextInt(256).toRadixString(16).padLeft(2, '0'),
  ).join();
}

/// Durable evidence of ownership, independent of transfer history retention.
final class DeviceFileRegistry {
  /// Uses the app's versioned schema; constructing it performs no I/O.
  DeviceFileRegistry(this.database);

  /// Database shared with the transfer and outbox ledgers.
  final AppDatabase database;

  /// Records completed files only; exports are never registered.
  Future<void> register({
    required String location,
    required String label,
    DateTime? completedAt,
    String category = 'files',
    String? source,
    String? session,
  }) => database.customStatement(
    '''
INSERT INTO managed_device_files
        (id,location,label,completed_at,category,source,session) VALUES
        (?,?,?,?,?,?,?)
        ON CONFLICT(location) DO UPDATE SET label=excluded.label,
source=coalesce(excluded.source,source),session=coalesce(excluded.session,session)''',
    [
      newStorageId(),
      location,
      label,
      (completedAt ?? DateTime.now()).millisecondsSinceEpoch,
      category,
      source,
      session,
    ],
  );
}

/// Shared by foreground/background completion and storage review.
final deviceFileRegistryProvider = Provider<DeviceFileRegistry>(
  (ref) => DeviceFileRegistry(ref.watch(appDatabaseProvider)),
);
