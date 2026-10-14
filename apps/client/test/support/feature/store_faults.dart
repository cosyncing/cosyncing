// Fault hooks around the app's REAL stores.
//
// Each wrapper delegates to the production Drift / secure-storage store over
// the scenario's `FeatureStorage`, and can fail or hold one operation. They
// replace the per-file spy/gated/failing store copies the legacy tests carried.
// Install them with `f.launch(overrides: [...])`.
import 'dart:async';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/data/active_broker_profile_store.dart';
import 'package:cosyncing_client/src/features/pairing/data/secure_storage_preflight.dart';
import 'package:cosyncing_client/src/features/pairing/data/transport_pairing_store.dart';
import 'package:cosyncing_client/src/features/sessions/roster/roster_snapshot_store.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_identity.dart';

/// One store operation that can be failed or held by the test.
class StoreFault {
  /// Fail every call (until reset) with a store error.
  bool fail = false;

  /// Fail only the next call.
  bool failNext = false;

  Completer<void>? _hold;

  /// Calls that have started.
  int calls = 0;

  /// Calls currently parked by [hold].
  int parked = 0;

  /// Parks the next calls until [release].
  void hold() => _hold = Completer<void>();

  /// Lets parked calls continue.
  void release() {
    final hold = _hold;
    _hold = null;
    hold?.complete();
  }

  Future<void> enter(String what) async {
    calls += 1;
    final hold = _hold;
    if (hold != null) {
      parked += 1;
      await hold.future;
      parked -= 1;
    }
    if (fail || failNext) {
      failNext = false;
      throw StateError('$what failed (injected)');
    }
  }
}

/// [CredentialStore] over the real secure store, with faults.
class FaultyCredentialStore implements CredentialStore {
  /// Wraps [inner].
  FaultyCredentialStore(this.inner);

  /// The real store.
  final CredentialStore inner;

  /// Fault on reads.
  final StoreFault reads = StoreFault();

  /// Fault on writes.
  final StoreFault writes = StoreFault();

  /// Fault on deletes.
  final StoreFault deletes = StoreFault();

  @override
  Future<String?> readBrokerToken(String credentialKey) async {
    await reads.enter('credential read');
    return inner.readBrokerToken(credentialKey);
  }

  @override
  Future<void> writeBrokerToken(String credentialKey, String token) async {
    await writes.enter('credential write');
    return inner.writeBrokerToken(credentialKey, token);
  }

  @override
  Future<void> deleteBrokerToken(String credentialKey) async {
    await deletes.enter('credential delete');
    return inner.deleteBrokerToken(credentialKey);
  }
}

/// [BrokerProfileRepository] over the real Drift repository, with faults.
class FaultyProfileRepository implements BrokerProfileRepository {
  /// Wraps [inner].
  FaultyProfileRepository(this.inner);

  /// The real repository.
  final BrokerProfileRepository inner;

  /// Fault on reads (`getAll`, `getById`).
  final StoreFault reads = StoreFault();

  /// Fault on saves.
  final StoreFault saves = StoreFault();

  /// Fault on deletes.
  final StoreFault deletes = StoreFault();

  @override
  Future<List<BrokerProfile>> getAll() async {
    await reads.enter('profile list');
    return inner.getAll();
  }

  @override
  Future<BrokerProfile?> getById(String id) async {
    await reads.enter('profile read');
    return inner.getById(id);
  }

  @override
  Future<BrokerProfile> save(BrokerProfile profile) async {
    await saves.enter('profile save');
    return inner.save(profile);
  }

  @override
  Future<bool> delete({
    required String id,
    required String? incarnationId,
  }) async {
    await deletes.enter('profile delete');
    return inner.delete(id: id, incarnationId: incarnationId);
  }
}

/// [ActiveBrokerProfileStore] over the real Drift store, with faults.
class FaultyActiveServerStore implements ActiveBrokerProfileStore {
  /// Wraps [inner].
  FaultyActiveServerStore(this.inner);

  /// The real store.
  final ActiveBrokerProfileStore inner;

  /// Fault on `setActiveProfileId`.
  final StoreFault sets = StoreFault();

  /// Fault on `clearActiveProfileId`.
  final StoreFault clears = StoreFault();

  @override
  Future<String?> getActiveProfileId() => inner.getActiveProfileId();

  @override
  Future<void> setActiveProfileId(String? profileId) async {
    await sets.enter('active server save');
    return inner.setActiveProfileId(profileId);
  }

  @override
  Future<void> clearActiveProfileId() async {
    await clears.enter('active server clear');
    return inner.clearActiveProfileId();
  }
}

/// [TransportPairingStore] over the real secure store, with faults.
class FaultyTransportPairingStore implements TransportPairingStore {
  /// Wraps [inner].
  FaultyTransportPairingStore(this.inner);

  /// The real store.
  final TransportPairingStore inner;

  /// Fault on writes.
  final StoreFault writes = StoreFault();

  @override
  Future<TransportPairingCredentials?> read(String id) => inner.read(id);

  @override
  Future<void> write(TransportPairingCredentials credentials) async {
    await writes.enter('pairing credential write');
    return inner.write(credentials);
  }

  @override
  Future<void> delete(String id) => inner.delete(id);
}

/// The platform keyring behind secure storage, which may not be ready yet
/// (a locked or not-yet-started system keyring).
///
/// While [ready] is false it garbles what it reads back, so the app's REAL
/// write/read/delete preflight (`verifySecureStorage`) fails the way a locked
/// keyring makes it fail. Install with
/// `installerPairingStoragePreflightProvider.overrideWithValue(k.preflight)`.
class UnreadyKeyring implements SecureBrokerCredentialBackend {
  final _inner = FlutterSecureStorageBrokerCredentialBackend();

  /// Whether reads return what was written.
  bool ready = false;

  /// Preflight attempts made against this keyring.
  int preflights = 0;

  /// The production preflight, run against this keyring.
  SecureStoragePreflight get preflight => () {
    preflights += 1;
    return verifySecureStorage(backend: this);
  };

  @override
  Future<String?> read(String key) async {
    final value = await _inner.read(key);
    return ready ? value : 'garbled';
  }

  @override
  Future<void> write(String key, String value) => _inner.write(key, value);

  @override
  Future<void> delete(String key) => _inner.delete(key);
}

/// [RosterSnapshotRepository] over the real Drift snapshot store, with faults.
class FaultyRosterSnapshots implements RosterSnapshotRepository {
  /// Wraps [inner]. Pass [deletes] to keep one fault across provider
  /// rebuilds (the repository is rebuilt with its database).
  FaultyRosterSnapshots(this.inner, {StoreFault? deletes})
    : deletes = deletes ?? StoreFault();

  /// The real repository.
  final RosterSnapshotRepository inner;

  /// Fault on `deleteForProfile` (profile deletion's purge step).
  final StoreFault deletes;

  @override
  Future<SessionRosterSnapshot?> load(
    String brokerProfileId, {
    required String endpoint,
  }) => inner.load(brokerProfileId, endpoint: endpoint);

  @override
  Future<SessionRosterSnapshot> save({
    required String brokerProfileId,
    required String endpoint,
    required List<SessionInfo> sessions,
    DateTime? now,
  }) => inner.save(
    brokerProfileId: brokerProfileId,
    endpoint: endpoint,
    sessions: sessions,
    now: now,
  );

  @override
  Future<void> deleteForProfile(String brokerProfileId) async {
    await deletes.enter('roster snapshot delete');
    return inner.deleteForProfile(brokerProfileId);
  }
}
