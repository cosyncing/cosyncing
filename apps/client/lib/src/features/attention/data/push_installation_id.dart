import 'dart:convert';
import 'dart:math';

import 'package:cosyncing_client/src/local/app_database.dart';

const String _pushInstallationIdSettingKey = 'attention_push_installation_id';

/// Abstraction for durable, stable installation/device identifiers.
// ignore: one_member_abstracts
abstract interface class PushInstallationIdStore {
  /// Returns this app installation's identifier, creating one if missing.
  Future<String> readOrCreateInstallationId();
}

/// Drift-backed implementation backed by app settings.
///
/// The generated id is persisted in `appSettingRows` and reused forever.
class DriftPushInstallationIdStore implements PushInstallationIdStore {
  /// Creates a drift-backed installation id store.
  DriftPushInstallationIdStore({
    required this.database,
    this.clock = DateTime.now,
    this.idGenerator,
  });

  /// App database for persistence.
  final AppDatabase database;

  /// Clock used for timestamping setting updates.
  final DateTime Function() clock;

  /// Optional generator for deterministic ids in tests.
  final String Function()? idGenerator;
  Future<String>? _cachedRead;

  @override
  Future<String> readOrCreateInstallationId() {
    return _cachedRead ??= _readOrCreate();
  }

  Future<String> _readOrCreate() {
    return database.transaction(() async {
      final row =
          await (database.select(database.appSettingRows)..where(
                (row) => row.key.equals(_pushInstallationIdSettingKey),
              ))
              .getSingleOrNull();
      final existing = row?.value.trim();
      if (existing != null && existing.isNotEmpty) return existing;

      final generated = idGenerator?.call() ?? _defaultIdGenerator();
      if (generated.trim().isEmpty) {
        throw StateError('Push installation id generator returned empty id');
      }
      await database
          .into(database.appSettingRows)
          .insertOnConflictUpdate(
            AppSettingRowsCompanion.insert(
              key: _pushInstallationIdSettingKey,
              value: generated,
              updatedAt: clock(),
            ),
          );
      return generated;
    });
  }

  String _defaultIdGenerator() {
    final random = Random.secure();
    final bytes = List<int>.generate(18, (_) => random.nextInt(256));
    return 'dev_${base64Url.encode(bytes).replaceAll('=', '')}';
  }
}
