import 'dart:convert';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_route_transport.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/storage/data/device_file_registry.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/drift.dart';

/// One pinned server/caller review. Active workspace changes cannot retarget
/// it.
final class ServerStorageSession {
  /// Captures the saved profile and its credential-aware client factory.
  ServerStorageSession({
    required this.profile,
    required this.database,
    required this._clientFactory,
  });

  /// Server named by confirmations and every subsequent request.
  final BrokerProfile profile;

  /// Journal acceptance before sending any destructive request.
  final AppDatabase database;
  final Future<BrokerClient> Function(BrokerProfile) _clientFactory;
  BrokerClient? _client;
  Future<BrokerClient>? _creating;

  /// Last measurement is retained visibly stale after a network failure.
  StorageInventory? inventory;

  /// Last accepted/reconciled job state.
  StorageCleanupJob? job;
  bool _closed = false;
  Map<String, Object?>? _pendingAcceptance;

  /// An accepted request may have reached the broker; reconcile its exact key.
  bool get uncertainAcceptance => _pendingAcceptance != null;

  String get _key =>
      'storage.cleanup.${RosterSource.ofProfile(profile).storageKey}';

  /// Resolves one immutable client; never follows the workspace selection.
  Future<BrokerClient> client() {
    if (_client case final client?) {
      if (!(resolverRoute(client.resolver)?.retired ?? false)) {
        return Future.value(client);
      }
      client.close();
      _client = null;
    }
    return _creating ??= _createClient().whenComplete(() => _creating = null);
  }

  Future<BrokerClient> _createClient() async {
    final client = await _clientFactory(profile);
    if (_closed) {
      client.close();
      throw const BrokerException(message: 'Storage review closed');
    }
    return _client = client;
  }

  /// Entry/explicit refresh only. Long-polling waits never launch another scan.
  Future<StorageInventory> refresh() async {
    final broker = await client();
    final scan = await broker.startStorageScan();
    var status = scan;
    while (status['state'] == 'running' && !_closed) {
      status = await broker.getStorageScan(scan['scanId'] as String);
    }
    if (_closed || status['state'] != 'completed') {
      throw const BrokerException(message: 'Storage scan unavailable');
    }
    return inventory = await broker.getStorage();
  }

  /// Persists acceptance identity first; retries reuse the same exact plan/key.
  Future<StorageCleanupJob> submit(StorageCleanupPlan plan) async {
    if (_pendingAcceptance case final record?) return _accept(record);
    if (job != null && !job!.finished) {
      throw const BrokerException(message: 'Cleanup is already in progress');
    }
    final snapshot = inventory;
    if (snapshot == null || plan.inventoryId != snapshot.inventoryId) {
      throw StateError('Inventory changed');
    }
    final record = <String, Object?>{
      'planId': plan.planId,
      'idempotencyKey': newStorageId(),
      'serverIdentity': snapshot.serverIdentity,
    };
    await _save(record);
    _pendingAcceptance = record;
    return _accept(record);
  }

  Future<StorageCleanupJob> _accept(Map<String, Object?> record) async {
    final broker = await client();
    final current = inventory ?? await broker.getStorage();
    if (record['serverIdentity'] != current.serverIdentity) {
      throw const BrokerException(message: 'Server identity changed');
    }
    try {
      job = await broker.startStorageCleanup(
        record['planId']! as String,
        record['idempotencyKey']! as String,
      );
    } on BrokerException catch (error) {
      if (error.error?.code == 'PLAN_EXPIRED') {
        await database.customStatement(
          'DELETE FROM app_setting_rows WHERE key=?',
          [_key],
        );
        _pendingAcceptance = null;
      }
      rethrow;
    }
    record['jobId'] = job!.jobId;
    record['retainedUntil'] = job!.retainedUntil.millisecondsSinceEpoch;
    await _save(record);
    _pendingAcceptance = null;
    return job!;
  }

  /// Reopening reconciles the accepted job or uncertain acceptance, never a
  /// new selection.
  Future<StorageCleanupJob?> recover() async {
    final rows = await database
        .customSelect(
          'SELECT value FROM app_setting_rows WHERE key=?',
          variables: [Variable(_key)],
        )
        .get();
    if (rows.isEmpty) return null;
    final record = Map<String, Object?>.from(
      jsonDecode(rows.single.read<String>('value')) as Map,
    );
    final broker = await client();
    final current = inventory ?? await broker.getStorage();
    if (record['serverIdentity'] != current.serverIdentity) {
      throw const BrokerException(message: 'Server identity changed');
    }
    if (record['jobId'] case final String id) {
      try {
        return job = await broker.getStorageCleanup(id);
      } on BrokerException catch (error) {
        final retainedUntil = record['retainedUntil'] as int?;
        if (error.statusCode != 404 ||
            retainedUntil == null ||
            DateTime.now().millisecondsSinceEpoch < retainedUntil) {
          rethrow;
        }
        await database.customStatement(
          'DELETE FROM app_setting_rows WHERE key=?',
          [_key],
        );
        return job = null;
      }
    }
    _pendingAcceptance = record;
    return _accept(record);
  }

  /// Waits for progress through the broker's bounded long-poll endpoint.
  Future<StorageCleanupJob> progress() async =>
      job = await (await client()).getStorageCleanup(job!.jobId);

  /// Stops remaining items; already completed effects remain visible.
  Future<StorageCleanupJob> cancel() async =>
      job = await (await client()).cancelStorageCleanup(job!.jobId);
  Future<void> _save(Map<String, Object?> value) => database.customStatement(
    'INSERT INTO app_setting_rows(key,value,updated_at) VALUES (?,?,?) ON '
    'CONFLICT(key) DO UPDATE SET '
    'value=excluded.value,updated_at=excluded.updated_at',
    [_key, jsonEncode(value), DateTime.now().millisecondsSinceEpoch ~/ 1000],
  );

  /// Closing the review detaches its wait, without canceling a server job.
  void close() {
    _closed = true;
    _client?.close();
  }
}
