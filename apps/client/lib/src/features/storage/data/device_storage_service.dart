import 'dart:async';
import 'dart:convert';

import 'package:cosyncing_client/src/features/broker_profiles/data/drift_broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_cache.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/storage/data/device_file_registry.dart';
import 'package:cosyncing_client/src/features/storage/data/local_storage_file_backend.dart';
import 'package:cosyncing_client/src/features/storage/data/managed_file_access.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/drift.dart';

/// One measured category; unknown bytes never mean zero.
final class DeviceStorageCategory {
  /// Creates a category subtotal.
  const DeviceStorageCategory(
    this.id,
    this.bytes,
    this.count, {
    this.eligibleBytes = 0,
    this.partial = false,
  });

  /// Stable category identifier.
  final String id;

  /// Measured logical/database or file bytes.
  final int? bytes;

  /// Snapshots for cache; files for file categories.
  final int count;

  /// Measured bytes currently eligible for removal.
  final int eligibleBytes;

  /// Some owned objects could not be inspected.
  final bool partial;
}

/// A finite scan, held separately from later arrivals.
final class DeviceStorageSnapshot {
  /// Creates a measured snapshot.
  const DeviceStorageSnapshot(
    this.id,
    this.measuredAt,
    this.categories, {
    this.physicalDatabaseBytes,
  });

  /// Physical database/WAL bytes; overlaps logical estimates and is never
  /// included in their sum or described as reclaimable bytes.
  final int? physicalDatabaseBytes;

  /// Opaque inventory identity.
  final String id;

  /// Start of the scan; also freezes age filters.
  final DateTime measuredAt;

  /// Independently measured categories.
  final List<DeviceStorageCategory> categories;
}

/// One owned copy in a review page. UI deletion accepts its opaque id only.
final class DeviceStorageItem {
  /// Creates a reviewed file entry.
  const DeviceStorageItem({
    required this.id,
    required this.label,
    required this.bytes,
    required this.savedAt,
    required this.eligible,
    this.reason,
    this.source,
    this.session,
    this.serverName,
  });

  /// Opaque ownership record.
  final String id;

  /// Filename without deletion path.
  final String label;

  /// Null when inspection was unavailable.
  final int? bytes;

  /// Recorded completion time.
  final DateTime savedAt;

  /// Whether the snapshot found it removable.
  final bool eligible;

  /// Machine-readable protection/failure reason.
  final String? reason;

  /// Owning saved source, when known.
  final String? source;

  /// Owning session, when known.
  final String? session;

  /// Saved human-readable owner name, resolved locally without a network read.
  final String? serverName;
}

/// Frozen cleanup selection, expiring after five minutes.
final class DeviceStoragePlan {
  /// Creates the finite confirmation summary.
  const DeviceStoragePlan(this.id, this.count, this.bytes);

  /// Opaque, one-use plan id.
  final String id;

  /// Eligible files in all selected pages.
  final int count;

  /// Estimated bytes; execution reports actual effects separately.
  final int bytes;
}

/// Counts actual effects, without calling missing bytes reclaimed.
final class DeviceStorageResult {
  /// Creates a completed or canceled result.
  const DeviceStorageResult({
    required this.planId,
    this.removed = 0,
    this.missing = 0,
    this.skipped = 0,
    this.failed = 0,
    this.bytes = 0,
    this.canceled = false,
  });

  /// Files unlinked successfully.
  final int removed;

  /// Copies already absent, reclaiming zero new bytes.
  final int missing;

  /// Changed or in-use copies preserved.
  final int skipped;

  /// Failed filesystem operations.
  final int failed;

  /// Bytes actually removed, or unknown after an interrupted unlink.
  final int? bytes;

  /// Cancellation stopped remaining work.
  final bool canceled;

  /// Durable selection whose failed items can be paged and reviewed again.
  final String planId;
}

/// Demand-driven inventory and selective cleanup. Constructors start no work.
/// Scans and execution use bounded batches and the shared file admission fence.
final class DeviceStorageService {
  /// Shares existing cache, ownership and transfer/outbox boundaries.
  DeviceStorageService({
    required this.database,
    required this.registry,
    required this.files,
    required this.cache,
    ManagedFileAccess? access,
    DateTime Function()? now,
  }) : access = access ?? ManagedFileAccess.shared,
       _now = now ?? DateTime.now;

  /// App database; no cleanup deletes this database.
  final AppDatabase database;

  /// Durable ownership records.
  final DeviceFileRegistry registry;

  /// Platform inspection/unlink implementation.
  final LocalStorageFileBackend files;

  /// Existing transcript/roster write fence.
  final SessionCacheManagement cache;

  /// Same admission boundary used by previews/exports.
  final ManagedFileAccess access;
  final DateTime Function() _now;
  Future<DeviceStorageSnapshot>? _scan;
  Future<DeviceStorageResult>? _job;
  bool _cancel = false;
  bool _closed = false;

  /// Most recent snapshot, retained while the page is closed.
  DeviceStorageSnapshot? latest;

  /// Most recent accepted operation's result.
  DeviceStorageResult? result;

  /// Accepted local work survives navigation away from the page.
  Future<DeviceStorageResult>? get pending => _job;

  /// Coalesces concurrent refresh requests.
  Future<DeviceStorageSnapshot> scan() =>
      _scan ??= _scanOnce().whenComplete(() => _scan = null);

  /// Cancels background work when the app scope is disposed.
  void dispose() {
    _closed = true;
    _cancel = true;
  }

  Future<List<QueryRow>> _query(String sql, [List<Object> args = const []]) =>
      database
          .customSelect(
            sql,
            variables: [for (final value in args) Variable(value)],
          )
          .get();

  Future<String?> _protection(String location) async {
    if (access.inUse(location)) return 'IN_USE';
    final active = await _query(
      '''
SELECT 1 FROM artifact_transfer_rows WHERE
      (cached_file_path = ? OR partial_file_path = ? OR source_url = ?)
      AND (status IN ('queued','running') OR partial_file_path IS NOT NULL)
        LIMIT 1''',
      [location, location, location],
    );
    if (active.isNotEmpty) return 'IN_USE';
    final pending = await _query(
      '''
SELECT 1 FROM session_outbox_rows
      WHERE status != 'delivered' AND instr(payload_json,?) > 0 LIMIT 1''',
      [jsonEncode(location)],
    );
    return pending.isEmpty ? null : 'IN_USE';
  }

  Future<DeviceStorageCategory> _logical(
    String id,
    Map<String, List<String>> tables,
  ) async {
    var bytes = 0;
    var count = 0;
    try {
      // One database round trip per category. These are logical text sizes;
      // no file bodies or secure-store values are loaded to count metadata.
      final queries = tables.entries.map((table) {
        final expression = table.value
            .map((column) => 'coalesce(length(cast($column AS BLOB)),0)')
            .join('+');
        return 'SELECT count(*) AS n, coalesce(sum($expression),0) AS bytes '
            'FROM ${table.key}';
      });
      final row = (await _query(
        'SELECT sum(n) AS n, sum(bytes) AS bytes FROM '
        '(${queries.join(' UNION ALL ')})',
      )).single;
      count = row.read<int>('n');
      bytes = row.read<int>('bytes');
      return DeviceStorageCategory(
        id,
        bytes,
        count,
        eligibleBytes: id == 'cache' ? bytes : 0,
      );
    } on Object {
      return DeviceStorageCategory(id, null, count, partial: true);
    }
  }

  Future<DeviceStorageSnapshot> _scanOnce() async {
    await _recoverInterrupted();
    final id = newStorageId();
    final measuredAt = _now();
    await database.customStatement(
      'INSERT INTO device_storage_inventories VALUES (?,?)',
      [id, measuredAt.millisecondsSinceEpoch],
    );
    final categories = <DeviceStorageCategory>[
      await _logical('cache', {
        'session_transcript_rows': [
          'messages_json',
          'cursor',
          'older_cursor',
          'gap_json',
          'truncation_json',
        ],
        'roster_snapshot_rows': ['rows_json'],
      }),
      await _logical('app-data', {
        'session_draft_rows': ['draft_text', 'conflict_text'],
        'session_outbox_rows': ['payload_json', 'last_error'],
        'app_setting_rows': ['key', 'value'],
        'broker_profile_rows': ['display_name', 'base_uri', 'credential_key'],
        'artifact_transfer_rows': [
          'id',
          'file_name',
          'cached_file_path',
          'source_url',
          'message',
          'error',
        ],
        'attention_event_rows': ['event_id'],
        'attention_cursor_rows': ['broker_profile_id'],
        'broker_route_servers': ['payload'],
        'broker_proxy_profiles': ['payload'],
        'broker_proxy_secret_journal': ['new_ref', 'old_ref', 'payload'],
        'broker_route_migrations': [
          'legacy_scope',
          'target_scope',
          'credential_ref',
          'state',
          'prepared_payload',
        ],
        'broker_profile_merges': [
          'survivor',
          'removed_profile',
          'credential_ref',
          'pairing_ref',
          'state',
        ],
        'broker_recovered_drafts': ['payload'],
        'broker_retired_setting_prefixes': ['prefix', 'profile'],
        'managed_device_files': [
          'location',
          'label',
          'category',
          'source',
          'session',
        ],
        'device_storage_plans': ['id', 'inventory', 'state'],
        'device_storage_plan_items': [
          'plan',
          'id',
          'location',
          'version',
          'outcome',
        ],
      }),
    ];
    // Adopt only existing ledger evidence and validated app-owned paths. Never
    // discover candidates by suffix or by walking a workspace.
    var after = '';
    for (;;) {
      if (_closed) throw const LocalStorageException('CANCELED');
      final rows = await _query(
        '''
SELECT id,cached_file_path,file_name,updated_at,broker_profile_id,session_id
        FROM artifact_transfer_rows
        WHERE id > ? AND cached_file_path IS NOT NULL AND status IN
        ('cached','completed')
        ORDER BY id LIMIT 100''',
        [after],
      );
      if (rows.isEmpty) break;
      for (final row in rows) {
        final location = row.read<String>('cached_file_path');
        try {
          if (await files.inspect(location) != null) {
            await registry.register(
              location: location,
              label: row.read<String>('file_name'),
              completedAt: DateTime.fromMillisecondsSinceEpoch(
                row.read<int>('updated_at') * 1000,
              ),
              source: row.readNullable<String>('broker_profile_id'),
              session: row.read<String>('session_id'),
            );
          }
        } on Object {
          /* Unproven legacy ownership is never adopted. */
        }
      }
      after = rows.last.read<String>('id');
    }
    // A rowid ceiling freezes arrivals while keeping memory independent of N.
    final ceiling = (await _query(
      'SELECT coalesce(max(rowid),0) AS n FROM managed_device_files',
    )).single.read<int>('n');
    for (final category in ['files', 'temporary']) {
      var bytes = 0;
      var count = 0;
      var eligibleBytes = 0;
      var cursor = 0;
      var partial = false;
      var measuredCount = 0;
      for (;;) {
        if (_closed) throw const LocalStorageException('CANCELED');
        final rows = await _query(
          'SELECT rowid AS position,* FROM managed_device_files WHERE rowid>? '
          'AND rowid<=? AND category=? ORDER BY rowid LIMIT 100',
          [cursor, ceiling, category],
        );
        if (rows.isEmpty) break;
        final observations = <List<Object?>>[];
        for (final row in rows) {
          final location = row.read<String>('location');
          LocalFileObservation? observation;
          String? reason;
          try {
            observation = await files.inspect(location);
            reason = observation == null
                ? 'MISSING'
                : await _protection(location);
            if (reason == null &&
                category == 'temporary' &&
                row.read<int>('completed_at') >
                    measuredAt
                        .subtract(const Duration(hours: 24))
                        .millisecondsSinceEpoch) {
              reason = 'RETENTION';
            }
          } on Object {
            reason = 'UNAVAILABLE';
            partial = true;
          }
          if (reason == 'MISSING') continue;
          count++;
          if (observation != null) measuredCount++;
          bytes += observation?.size ?? 0;
          if (reason == null) eligibleBytes += observation!.size;
          observations.add([
            id,
            row.read<String>('id'),
            location,
            row.read<String>('label'),
            row.read<int>('completed_at'),
            category,
            row.readNullable<String>('source'),
            row.readNullable<String>('session'),
            observation?.version,
            observation?.size,
            if (reason == null) 1 else 0,
            reason,
          ]);
        }
        await database.transaction(() async {
          for (final values in observations) {
            await database.customStatement(
              'INSERT INTO device_storage_items VALUES '
              '(?,?,?,?,?,?,?,?,?,?,?,?)',
              values,
            );
          }
        });
        cursor = rows.last.read<int>('position');
      }
      categories.add(
        DeviceStorageCategory(
          category,
          partial && measuredCount == 0 ? null : bytes,
          count,
          eligibleBytes: eligibleBytes,
          partial: partial,
        ),
      );
    }
    final discovery = files;
    if (discovery is LocalStorageDiscovery) {
      var unmanagedBytes = 0;
      var unmanagedCount = 0;
      var measuredCount = 0;
      var partial = false;
      try {
        await for (final entry
            in (discovery as LocalStorageDiscovery).discover()) {
          if (_closed) throw const LocalStorageException('CANCELED');
          if ((await _query(
            'SELECT 1 FROM managed_device_files WHERE location=? LIMIT 1',
            [entry.location],
          )).isNotEmpty) {
            continue;
          }
          unmanagedCount++;
          if (entry.bytes == null) {
            partial = true;
          } else {
            unmanagedBytes += entry.bytes!;
            measuredCount++;
          }
        }
      } on Object {
        partial = true;
      }
      categories.add(
        DeviceStorageCategory(
          'unmanaged',
          partial && measuredCount == 0 ? null : unmanagedBytes,
          unmanagedCount,
          partial: partial,
        ),
      );
    }
    int? physicalDatabaseBytes;
    final measurement = files;
    if (measurement is LocalDatabaseStorageMeasurement) {
      try {
        final databases = await _query('PRAGMA database_list');
        final main = databases
            .where((row) => row.read<String>('name') == 'main')
            .firstOrNull;
        if (main != null) {
          physicalDatabaseBytes =
              await (measurement as LocalDatabaseStorageMeasurement)
                  .databaseBytes(
                    main.read<String>('file'),
                  );
        }
      } on Object {
        /* Logical measurements remain useful independently. */
      }
    }
    final snapshot = DeviceStorageSnapshot(
      id,
      measuredAt,
      List.unmodifiable(categories),
      physicalDatabaseBytes: physicalDatabaseBytes,
    );
    latest = snapshot;
    await database.transaction(() async {
      final retainedAfter = measuredAt
          .subtract(const Duration(hours: 24))
          .millisecondsSinceEpoch;
      await database.customStatement(
        '''
DELETE FROM device_storage_plan_items WHERE plan IN
        (SELECT id FROM device_storage_plans WHERE expires<? AND
        state!='running')''',
        [retainedAfter],
      );
      await database.customStatement(
        "DELETE FROM device_storage_plans WHERE expires<? AND state!='running'",
        [retainedAfter],
      );
    });
    // Bounded retention: old, unreferenced snapshots cannot grow indefinitely.
    await database.customStatement(
      '''
DELETE FROM device_storage_items WHERE inventory IN (
      SELECT id FROM device_storage_inventories WHERE measured_at<? AND id NOT
        IN
      (SELECT inventory FROM device_storage_plans WHERE expires>?))''',
      [
        measuredAt.subtract(const Duration(hours: 24)).millisecondsSinceEpoch,
        measuredAt.millisecondsSinceEpoch,
      ],
    );
    await database.customStatement(
      '''
DELETE FROM device_storage_inventories WHERE id NOT IN
      (SELECT DISTINCT inventory FROM device_storage_items) AND id<>?''',
      [id],
    );
    return snapshot;
  }

  // An expired execution lease cannot authorize more deletion. Keep completed
  // receipts, mark uncertain/untouched items retryable, and require fresh
  // review.
  Future<void> _recoverInterrupted() async {
    await database.transaction(() async {
      await database.customStatement(
        "UPDATE device_storage_plan_items SET outcome='FAILED' "
        'WHERE outcome IS NULL AND plan IN (SELECT id FROM '
        'device_storage_plans '
        "WHERE state='running' AND coalesce(lease_until,0)<?)",
        [_now().millisecondsSinceEpoch],
      );
      await database.customStatement(
        "UPDATE device_storage_plans SET state='interrupted' "
        "WHERE state='running' AND coalesce(lease_until,0)<?",
        [_now().millisecondsSinceEpoch],
      );
    });
    if (_job != null) return;
    final plans = await _query(
      'SELECT id,state FROM device_storage_plans '
      "WHERE state IN ('completed','canceled','interrupted') "
      'ORDER BY expires DESC,rowid DESC LIMIT 1',
    );
    if (plans.isEmpty) return;
    final plan = plans.single;
    final counts = (await _query(
      "SELECT sum(outcome='REMOVED') AS removed, "
      "sum(outcome='MISSING') AS missing, sum(outcome='FAILED') AS failed, "
      "sum(outcome NOT IN ('REMOVED','MISSING','FAILED')) AS skipped, "
      'coalesce(sum(reclaimed),0) AS bytes '
      'FROM device_storage_plan_items WHERE plan=?',
      [plan.read<String>('id')],
    )).single;
    result = DeviceStorageResult(
      planId: plan.read<String>('id'),
      removed: counts.readNullable<int>('removed') ?? 0,
      missing: counts.readNullable<int>('missing') ?? 0,
      failed: counts.readNullable<int>('failed') ?? 0,
      skipped: counts.readNullable<int>('skipped') ?? 0,
      bytes: plan.read<String>('state') == 'interrupted'
          ? null
          : counts.read<int>('bytes'),
      canceled: plan.read<String>('state') != 'completed',
    );
  }

  Future<int> _cutoff(String inventory, int days) async {
    final rows = await _query(
      'SELECT measured_at FROM device_storage_inventories WHERE id=?',
      [inventory],
    );
    if (rows.isEmpty) throw const LocalStorageException('INVENTORY_EXPIRED');
    return rows.single.read<int>('measured_at') -
        Duration(days: days).inMilliseconds;
  }

  /// A stable, bounded page from the measured inventory.
  Future<List<DeviceStorageItem>> page(
    String inventory, {
    int offset = 0,
    int olderThanDays = 0,
    String search = '',
    bool largestFirst = false,
    String category = 'files',
    String? failedPlan,
  }) async {
    final cutoff = await _cutoff(inventory, olderThanDays);
    final rows = await _query(
      '''
SELECT * FROM device_storage_items WHERE inventory=? AND
        completed_at<=? AND (category=? OR ?!='')
      AND instr(lower(label),lower(?))>0
      AND (?='' OR id IN (SELECT id FROM device_storage_plan_items
        WHERE plan=? AND outcome='FAILED')) ORDER BY ${largestFirst ? 'bytes DESC,id' : 'completed_at DESC,id'} LIMIT 100 OFFSET ?''',
      [
        inventory,
        cutoff,
        category,
        failedPlan ?? '',
        search,
        failedPlan ?? '',
        failedPlan ?? '',
        offset,
      ],
    );
    final serverNames = {
      for (final profile in await DriftBrokerProfileRepository(
        database,
      ).getAll())
        RosterSource.ofProfile(profile).storageKey: profile.displayName,
    };
    return [
      for (final row in rows)
        DeviceStorageItem(
          id: row.read<String>('id'),
          label: row.read<String>('label'),
          bytes: row.readNullable<int>('bytes'),
          savedAt: DateTime.fromMillisecondsSinceEpoch(
            row.read<int>('completed_at'),
          ),
          eligible: row.read<int>('eligible') == 1,
          reason: row.readNullable<String>('reason'),
          source: row.readNullable<String>('source'),
          session: row.readNullable<String>('session'),
          serverName: serverNames[row.readNullable<String>('source')],
        ),
    ];
  }

  /// Count used by Select all; it uses exactly the same frozen filter as plans.
  Future<int> eligibleCount(
    String inventory, {
    int olderThanDays = 0,
    String search = '',
    String category = 'files',
    String? failedPlan,
  }) async {
    final cutoff = await _cutoff(inventory, olderThanDays);
    return (await _query(
      """
SELECT count(*) AS n FROM device_storage_items WHERE inventory=?
      AND eligible=1 AND completed_at<=? AND (category=? OR ?!='')
      AND instr(lower(label),lower(?))>0
      AND (?='' OR id IN (SELECT id FROM device_storage_plan_items
        WHERE plan=? AND outcome='FAILED'))""",
      [
        inventory,
        cutoff,
        category,
        failedPlan ?? '',
        search,
        failedPlan ?? '',
        failedPlan ?? '',
      ],
    )).single.read<int>('n');
  }

  /// Freezes explicit selections, or all eligible matches including later
  /// pages.
  Future<DeviceStoragePlan> plan(
    String inventory, {
    Set<String>? selectedIds,
    int olderThanDays = 0,
    String search = '',
    String category = 'files',
    String? failedPlan,
  }) async {
    final id = newStorageId();
    final cutoff = await _cutoff(inventory, olderThanDays);
    await database.transaction(() async {
      await database.customStatement(
        'INSERT INTO device_storage_plans(id,inventory,expires,state) '
        "VALUES (?,?,?,'pending')",
        [
          id,
          inventory,
          _now().add(const Duration(minutes: 5)).millisecondsSinceEpoch,
        ],
      );
      const selection = '''
SELECT ?,id,location,version,bytes FROM device_storage_items
        WHERE inventory=? AND eligible=1 AND completed_at<=?
        AND (category=? OR ?!='') AND instr(lower(label),lower(?))>0
        AND (?='' OR id IN (SELECT id FROM device_storage_plan_items
          WHERE plan=? AND outcome='FAILED'))''';
      if (selectedIds == null) {
        await database.customStatement(
          'INSERT INTO '
          'device_storage_plan_items(plan,id,location,version,bytes) '
          '$selection',
          [
            id,
            inventory,
            cutoff,
            category,
            failedPlan ?? '',
            search,
            failedPlan ?? '',
            failedPlan ?? '',
          ],
        );
      } else {
        for (final itemId in selectedIds) {
          await database.customStatement(
            'INSERT INTO '
            'device_storage_plan_items(plan,id,location,version,bytes) '
            '$selection AND id=?',
            [
              id,
              inventory,
              cutoff,
              category,
              failedPlan ?? '',
              search,
              failedPlan ?? '',
              failedPlan ?? '',
              itemId,
            ],
          );
        }
      }
    });
    final row = (await _query(
      'SELECT count(*) AS n,coalesce(sum(bytes),0) AS bytes FROM '
      'device_storage_plan_items WHERE plan=?',
      [id],
    )).single;
    return DeviceStoragePlan(id, row.read<int>('n'), row.read<int>('bytes'));
  }

  /// Stops remaining work without undoing completed effects.
  void cancelRemaining() {
    _cancel = true;
  }

  /// Accepts a plan once. Navigating away does not cancel an accepted
  /// operation.
  Future<DeviceStorageResult> execute(DeviceStoragePlan plan) {
    if (_job != null) return Future.error(const LocalStorageException('BUSY'));
    _cancel = false;
    return _job = _execute(
      plan,
    ).then((value) => result = value).whenComplete(() => _job = null);
  }

  Future<DeviceStorageResult> _execute(DeviceStoragePlan plan) async {
    var removed = 0;
    var missing = 0;
    var skipped = 0;
    var failed = 0;
    var bytes = 0;
    await database.transaction(() async {
      final rows = await _query(
        'SELECT * FROM device_storage_plans WHERE id=?',
        [plan.id],
      );
      if (rows.isEmpty || rows.single.read<String>('state') != 'pending') {
        throw const LocalStorageException('PLAN_CONSUMED');
      }
      if (rows.single.read<int>('expires') <= _now().millisecondsSinceEpoch) {
        throw const LocalStorageException('PLAN_EXPIRED');
      }
      if ((await _query(
        "SELECT 1 FROM device_storage_plans WHERE state='running' LIMIT 1",
      )).isNotEmpty) {
        throw const LocalStorageException('BUSY');
      }
      await database.customStatement(
        "UPDATE device_storage_plans SET state='running',lease_until=? WHERE "
        'id=?',
        [
          _now().add(const Duration(minutes: 2)).millisecondsSinceEpoch,
          plan.id,
        ],
      );
    });
    while (!_cancel && !_closed) {
      await database.customStatement(
        'UPDATE device_storage_plans SET lease_until=? '
        "WHERE id=? AND state='running'",
        [
          _now().add(const Duration(minutes: 2)).millisecondsSinceEpoch,
          plan.id,
        ],
      );
      final batch = await _query(
        'SELECT * FROM device_storage_plan_items WHERE plan=? AND outcome IS '
        'NULL ORDER BY id LIMIT 32',
        [plan.id],
      );
      if (batch.isEmpty) break;
      for (final row in batch) {
        if (_cancel || _closed) break;
        final admitted = await _query(
          "SELECT 1 FROM device_storage_plans WHERE id=? AND state='running' "
          'AND lease_until>?',
          [plan.id, _now().millisecondsSinceEpoch],
        );
        if (admitted.isEmpty) {
          _cancel = true;
          break;
        }
        var outcome = 'FAILED';
        var reclaimed = 0;
        final location = row.read<String>('location');
        try {
          final count = await access.remove(location, () async {
            if (await _protection(location) != null) {
              throw const LocalStorageException('IN_USE');
            }
            return files.remove(location, row.read<String>('version'));
          });
          if (count == null) {
            missing++;
            outcome = 'MISSING';
          } else {
            removed++;
            reclaimed = count;
            bytes += count;
            outcome = 'REMOVED';
          }
        } on LocalStorageException catch (error) {
          skipped++;
          outcome = error.code;
        } on Object {
          failed++;
        }
        await database.transaction(() async {
          await database.customStatement(
            'UPDATE device_storage_plan_items SET outcome=?,reclaimed=? WHERE '
            'plan=? AND id=?',
            [outcome, reclaimed, plan.id, row.read<String>('id')],
          );
          if (outcome == 'REMOVED' || outcome == 'MISSING') {
            await database.customStatement(
              'DELETE FROM managed_device_files WHERE id=?',
              [row.read<String>('id')],
            );
          }
        });
      }
    }
    await database.customStatement(
      "UPDATE device_storage_plans SET state=? WHERE id=? AND state='running'",
      [if (_cancel || _closed) 'canceled' else 'completed', plan.id],
    );
    return DeviceStorageResult(
      removed: removed,
      missing: missing,
      skipped: skipped,
      failed: failed,
      bytes: bytes,
      canceled: _cancel || _closed,
      planId: plan.id,
    );
  }
}
