import 'dart:async';
import 'dart:convert';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_route_context.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_routes.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/drift.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Device-local secure namespace, independent of broker and pairing secrets.
final proxyCredentialBackendProvider = Provider<SecureBrokerCredentialBackend>(
  (ref) => FlutterSecureStorageBrokerCredentialBackend(),
);

/// Checks all recovery journals in one database round trip. Empty journals do
/// not require constructing secure stores during ordinary startup.
Future<({bool merges, bool proxies, bool migrations})> readBrokerRouteRecovery(
  AppDatabase database,
) async {
  final row = await database
      .customSelect(
        'SELECT EXISTS(SELECT 1 FROM broker_profile_merges '
        "WHERE state='cleanup') AS merges, "
        'EXISTS(SELECT 1 FROM broker_proxy_secret_journal) AS proxies, '
        "EXISTS(SELECT 1 FROM broker_route_migrations WHERE state='prepared' "
        'AND prepared_payload IS NOT NULL) AS migrations',
      )
      .getSingle();
  return (
    merges: row.read<int>('merges') != 0,
    proxies: row.read<int>('proxies') != 0,
    migrations: row.read<int>('migrations') != 0,
  );
}

/// Durable route metadata and resumable publication of proxy secret references.
final brokerRouteStoreProvider = Provider<BrokerRouteStore>(
  (ref) => BrokerRouteStore(
    ref.watch(appDatabaseProvider),
    ref.watch(proxyCredentialBackendProvider),
  ),
);

/// Persists device-local routes and journals proxy credential publication.
final class BrokerRouteStore {
  /// Shares the app database and the separate proxy secret backend.
  BrokerRouteStore(this.database, this.secrets);

  /// App database containing route metadata and source-owned local state.
  final AppDatabase database;

  /// Device-local secure backend for proxy credentials only.
  final SecureBrokerCredentialBackend secrets;
  Future<void> _proxyWrites = Future.value();

  Future<T> _serializeProxyWrite<T>(Future<T> Function() write) {
    final result = _proxyWrites.then((_) => write());
    _proxyWrites = result.then<void>(
      (_) {},
      onError: (Object _, StackTrace _) {},
    );
    return result;
  }

  /// Ordinary startup reads an existing route and its current incarnation in
  /// one query. Only first use or an address edit needs a write transaction.
  Future<BrokerRouteServer> ensure(BrokerProfile profile) async {
    final row = await database
        .customSelect(
          'SELECT s.payload FROM broker_route_servers s '
          'JOIN broker_profile_rows p ON p.id=s.profile '
          'AND p.incarnation_id=s.incarnation '
          'WHERE s.profile=? AND s.incarnation=?',
          variables: [Variable(profile.id), Variable(profile.incarnationId)],
        )
        .getSingleOrNull();
    if (row != null) {
      final existing = BrokerRouteServer.fromJson(
        jsonDecode(row.read<String>('payload')) as Map<String, dynamic>,
      );
      if (existing.legacyOrigin.origin == profile.baseUri.origin) {
        return existing;
      }
    }
    return _ensureChanged(profile);
  }

  Future<BrokerRouteServer> _ensureChanged(
    BrokerProfile profile,
  ) => database.transaction(() async {
    await _requireCurrent(profile.id, profile.incarnationId!);
    final existing = await read(profile.id, profile.incarnationId!);
    if (existing != null) {
      if (existing.legacyOrigin.origin == profile.baseUri.origin) {
        return existing;
      }
      // Old-client edits of an unverified single address retain compatibility.
      // Verified logical servers must use address verification instead.
      if (existing.identityPublicKey != null) {
        throw const BrokerRouteException('CONFIGURATION_CHANGED');
      }
      final replacement = BrokerAddress(
        id: newConnectionId(),
        origin: Uri.parse(profile.baseUri.origin),
        label: profile.baseUri.host,
        order: 0,
        legacyTrusted: true,
      );
      final updated = BrokerRouteServer(
        profileId: profile.id,
        incarnation: profile.incarnationId!,
        legacyOrigin: profile.baseUri,
        addresses: [replacement],
        credentialReference: profile.credentialKey,
        lastSuccessfulRouteId: replacement.id,
        generation: existing.generation + 1,
      );
      await database.customStatement(
        'UPDATE broker_route_servers SET payload=? WHERE profile=? AND '
        'incarnation=?',
        [jsonEncode(updated.toJson()), profile.id, profile.incarnationId],
      );
      return updated;
    }
    final server = BrokerRouteServer.initial(
      profileId: profile.id,
      incarnation: profile.incarnationId!,
      origin: profile.baseUri,
      credentialReference: profile.credentialKey,
    );
    await database.customStatement(
      'INSERT INTO broker_route_servers VALUES (?,?,?)',
      [profile.id, profile.incarnationId, jsonEncode(server.toJson())],
    );
    return server;
  });

  /// Reads the route state only for the exact saved profile incarnation.
  Future<BrokerRouteServer?> read(String profile, String incarnation) async {
    final row = await database
        .customSelect(
          'SELECT payload FROM broker_route_servers WHERE profile=? AND '
          'incarnation=?',
          variables: [Variable(profile), Variable(incarnation)],
        )
        .getSingleOrNull();
    return row == null
        ? null
        : BrokerRouteServer.fromJson(
            jsonDecode(row.read<String>('payload')) as Map<String, dynamic>,
          );
  }

  /// Optimistic generation check fences late editor/probe results.
  Future<void> save(
    BrokerRouteServer next, {
    required int expectedGeneration,
  }) => database.transaction(() async {
    await _requireCurrent(next.profileId, next.incarnation);
    final current = await read(next.profileId, next.incarnation);
    if (current == null || current.generation != expectedGeneration) {
      throw const BrokerRouteException('CONFIGURATION_CHANGED');
    }
    await database.customStatement(
      'UPDATE broker_route_servers SET payload=? WHERE profile=? AND '
      'incarnation=?',
      [
        jsonEncode(next.copyWith(generation: expectedGeneration + 1).toJson()),
        next.profileId,
        next.incarnation,
      ],
    );
  });

  Future<void> _requireCurrent(String profile, String incarnation) async {
    final row = await database
        .customSelect(
          'SELECT incarnation_id FROM broker_profile_rows WHERE id=?',
          variables: [Variable(profile)],
        )
        .getSingleOrNull();
    if (row == null ||
        row.readNullable<String>('incarnation_id') != incarnation) {
      throw BrokerProfileRetiredException(profile);
    }
  }

  /// Lists non-secret device-local proxy profiles without probing them.
  Future<List<BrokerProxyProfile>> proxies() async => [
    for (final row
        in await database
            .customSelect(
              'SELECT payload FROM broker_proxy_profiles ORDER BY id',
            )
            .get())
      BrokerProxyProfile.fromJson(
        jsonDecode(row.read<String>('payload')) as Map<String, dynamic>,
      ),
  ];

  /// Resolves a saved proxy binding; missing bindings remain missing.
  Future<BrokerProxyProfile?> proxy(String? id) async {
    if (id == null) return null;
    final row = await database
        .customSelect(
          'SELECT payload FROM broker_proxy_profiles WHERE id=?',
          variables: [Variable(id)],
        )
        .getSingleOrNull();
    return row == null
        ? null
        : BrokerProxyProfile.fromJson(
            jsonDecode(row.read<String>('payload')) as Map<String, dynamic>,
          );
  }

  /// Reads transient credentials from the proxy-only secure namespace.
  Future<BrokerProxyCredentials?> proxySecret(
    BrokerProxyProfile? profile,
  ) async {
    final key = profile?.credentialKey;
    if (key == null) return null;
    final raw = await secrets.read(key);
    if (raw == null) return null;
    final json = jsonDecode(raw) as Map<String, dynamic>;
    return BrokerProxyCredentials(
      json['username'] as String,
      json['password'] as String,
    );
  }

  /// The journal is durable before the secure write. Metadata is published
  /// only after the new secret exists; old material is removed after commit.
  Future<BrokerProxyProfile> saveProxy(
    BrokerProxyProfile profile, {
    BrokerProxyCredentials? credentials,
    bool clearCredentials = false,
  }) => _serializeProxyWrite(() async {
    await _recoverProxyWrites();
    validateProxyEndpoint(profile.host, profile.port);
    final previous = await proxy(profile.id);
    if (previous != null && previous.generation != profile.generation) {
      throw const BrokerRouteException('CONFIGURATION_CHANGED');
    }
    final changed =
        previous == null ||
        previous.protocol != profile.protocol ||
        previous.host != profile.host ||
        previous.port != profile.port ||
        credentials != null ||
        clearCredentials;
    final key = credentials == null
        ? (clearCredentials ? null : previous?.credentialKey)
        : 'cosyncing_client.proxy:${profile.id}:${newConnectionId()}';
    final next = BrokerProxyProfile(
      id: profile.id,
      name: profile.name,
      protocol: profile.protocol,
      host: profile.host,
      port: profile.port,
      generation: (previous?.generation ?? 0) + (changed ? 1 : 0),
      credentialKey: key,
    );
    await database.transaction(() async {
      final current = await proxy(profile.id);
      if (current?.generation != previous?.generation) {
        throw const BrokerRouteException('CONFIGURATION_CHANGED');
      }
      await database.customStatement(
        'INSERT INTO broker_proxy_secret_journal VALUES (?,?,?,?)',
        [next.id, key, previous?.credentialKey, jsonEncode(next.toJson())],
      );
    });
    if (credentials != null) {
      await secrets.write(
        key!,
        jsonEncode({
          'username': credentials.username,
          'password': credentials.password,
        }),
      );
    }
    await _publishProxy(next.id);
    return next;
  });

  /// Resume interrupted secret publication. Missing new material leaves the
  /// old profile intact; its pending edit can be retried or discarded.
  Future<void> recoverProxyWrites() =>
      _serializeProxyWrite(_recoverProxyWrites);

  Future<void> _recoverProxyWrites() async {
    final rows = await database
        .customSelect('SELECT id FROM broker_proxy_secret_journal')
        .get();
    for (final row in rows) {
      await _publishProxy(row.read<String>('id'), recovering: true);
    }
  }

  Future<void> _publishProxy(String id, {bool recovering = false}) async {
    final row = await database
        .customSelect(
          'SELECT * FROM broker_proxy_secret_journal WHERE id=?',
          variables: [Variable(id)],
        )
        .getSingleOrNull();
    if (row == null) return;
    final key = row.readNullable<String>('new_ref');
    final old = row.readNullable<String>('old_ref');
    if (key != null && key != old && await secrets.read(key) == null) {
      if (!recovering) {
        throw const BrokerRouteException('PROXY_CREDENTIAL_REQUIRED');
      }
      // The secure write never committed. The old profile and secret remain
      // authoritative; discard the incomplete edit so it can be retried.
      await database.customStatement(
        'DELETE FROM broker_proxy_secret_journal WHERE id=?',
        [id],
      );
      return;
    }
    final deleted =
        (jsonDecode(row.read<String>('payload'))
            as Map<String, dynamic>)['deleted'] ==
        true;
    await database.transaction(() async {
      if (deleted) {
        await database.customStatement(
          'DELETE FROM broker_proxy_profiles WHERE id=?',
          [id],
        );
      } else {
        await database.customStatement(
          'INSERT OR REPLACE INTO broker_proxy_profiles VALUES (?,?)',
          [id, row.read<String>('payload')],
        );
      }
      // The journal survives metadata commit until old-secret deletion has
      // succeeded. Re-running publication is idempotent after an interruption.
    });
    if (old != null && old != key) await secrets.delete(old);
    await database.customStatement(
      'DELETE FROM broker_proxy_secret_journal WHERE id=?',
      [id],
    );
  }

  /// Bindings retain this ID and become blocked. Removal never selects Direct.
  Future<void> removeProxy(String id) => _serializeProxyWrite(() async {
    await _recoverProxyWrites();
    await database.transaction(() async {
      final current = await proxy(id);
      await database.customStatement(
        'INSERT INTO broker_proxy_secret_journal VALUES (?,?,?,?)',
        [
          id,
          null,
          current?.credentialKey,
          jsonEncode({'deleted': true}),
        ],
      );
    });
    await _publishProxy(id);
  });

  /// Lists saved addresses that would be affected by a proxy edit/removal.
  Future<List<(String, BrokerAddress)>> proxyDependents(String id) async {
    final rows = await database
        .customSelect('SELECT payload FROM broker_route_servers')
        .get();
    return [
      for (final row in rows)
        for (final server in [
          BrokerRouteServer.fromJson(
            jsonDecode(row.read<String>('payload')) as Map<String, dynamic>,
          ),
        ])
          for (final route in server.addresses)
            if (route.proxyId == id) (server.profileId, route),
    ];
  }
}
