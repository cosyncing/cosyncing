import 'dart:convert';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

const _brokerIdentityPrefix = 'broker_identity:';
const _brokerHelloPrefix = 'broker_hello:';

/// Source-scoped durable broker version and contract identity.
///
/// Every key is a `RosterSource.storageKey` — (profile, endpoint, incarnation)
/// — because the identity describes the MACHINE that answered, not the profile
/// row pointing at it. A profile re-pointed at another broker keeps its id, so
/// an id-keyed row would hand the previous machine's version and contract to
/// the new one.
abstract interface class BrokerIdentityStore {
  /// Reads the last identity observed for [brokerScopeKey].
  Future<HealthResponse?> read(String brokerScopeKey);

  /// Saves an observed public broker identity for [brokerScopeKey].
  Future<void> write(String brokerScopeKey, HealthResponse health);

  /// Reads the last negotiated stream identity for [brokerScopeKey].
  Future<HelloWireEvent?> readHello(String brokerScopeKey);

  /// Saves the negotiated stream identity and compatibility decision.
  Future<void> writeHello(String brokerScopeKey, HelloWireEvent hello);
}

/// Drift-backed schema-free identity store.
class DriftBrokerIdentityStore implements BrokerIdentityStore {
  /// Creates a store.
  const DriftBrokerIdentityStore(this.database);

  /// Shared app database.
  final AppDatabase database;

  String _key(String scopeKey) => '$_brokerIdentityPrefix$scopeKey';

  String _helloKey(String scopeKey) => '$_brokerHelloPrefix$scopeKey';

  @override
  Future<HealthResponse?> read(String brokerScopeKey) async {
    final row =
        await (database.select(database.appSettingRows)
              ..where((table) => table.key.equals(_key(brokerScopeKey))))
            .getSingleOrNull();
    if (row == null) return null;
    try {
      return HealthResponse.fromJson(
        Map<String, dynamic>.from(jsonDecode(row.value) as Map),
      );
    } on Object {
      return null;
    }
  }

  @override
  Future<void> write(String brokerScopeKey, HealthResponse health) async {
    await database
        .into(database.appSettingRows)
        .insertOnConflictUpdate(
          AppSettingRowsCompanion.insert(
            key: _key(brokerScopeKey),
            value: jsonEncode(health.toJson()),
            updatedAt: DateTime.now(),
          ),
        );
  }

  @override
  Future<HelloWireEvent?> readHello(String brokerScopeKey) async {
    final row =
        await (database.select(database.appSettingRows)
              ..where((table) => table.key.equals(_helloKey(brokerScopeKey))))
            .getSingleOrNull();
    if (row == null) return null;
    try {
      final event = WireEvent.fromJson(
        Map<String, dynamic>.from(jsonDecode(row.value) as Map),
      );
      return event is HelloWireEvent ? event : null;
    } on Object {
      return null;
    }
  }

  @override
  Future<void> writeHello(
    String brokerScopeKey,
    HelloWireEvent hello,
  ) async {
    await database
        .into(database.appSettingRows)
        .insertOnConflictUpdate(
          AppSettingRowsCompanion.insert(
            key: _helloKey(brokerScopeKey),
            value: jsonEncode(hello.toJson()),
            updatedAt: DateTime.now(),
          ),
        );
  }
}

/// Durable broker identity store.
final brokerIdentityStoreProvider = Provider<BrokerIdentityStore>((ref) {
  return DriftBrokerIdentityStore(ref.watch(appDatabaseProvider));
});

/// Last negotiated hello for one exact broker source.
///
/// The family key is `RosterSource.storageKey`, so Settings never presents
/// compatibility learned from a profile's previous endpoint or incarnation.
final FutureProviderFamily<HelloWireEvent?, String>
brokerHelloIdentityProvider = FutureProvider.family<HelloWireEvent?, String>((
  ref,
  brokerScopeKey,
) {
  return ref.watch(brokerIdentityStoreProvider).readHello(brokerScopeKey);
});
