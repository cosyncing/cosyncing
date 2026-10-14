import 'dart:async';

import 'package:cosyncing_client/src/features/broker_profiles/controller/broker_profile_manager_controller.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/pairing/controller/pairing_controller.dart';
import 'package:cosyncing_client/src/features/settings/controller/broker_credentials_controller.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late _SpyCredentialStore store;
  late _InMemoryBrokerProfileRepository repository;
  late ProviderContainer container;

  setUp(() {
    store = _SpyCredentialStore();
    repository = _InMemoryBrokerProfileRepository();
    final database = AppDatabase(NativeDatabase.memory());
    addTearDown(database.close);
    container = ProviderContainer(
      overrides: [
        appDatabaseProvider.overrideWithValue(database),
        credentialStoreProvider.overrideWithValue(store),
        brokerProfileRepositoryProvider.overrideWithValue(repository),
      ],
    );
  });

  tearDown(() {
    container.dispose();
  });

  BrokerProfile remoteProfile() => BrokerProfile(
    id: 'https://broker.example.com:9443',
    displayName: 'broker.example.com',
    baseUri: Uri.parse('https://broker.example.com:9443'),
    createdAt: DateTime(2026),
  );

  group('BrokerCredentialsController', () {
    test(
      'held A token save cannot cross delete and pairing re-add of B',
      () async {
        final profileA = remoteProfile().copyWith(incarnationId: 'inc-a');
        final key = 'broker-token:${profileA.id}';
        await repository.save(profileA);
        await store.writeBrokerToken(key, 'token-a');
        container.read(activeBrokerProfileProvider.notifier).state = profileA;

        store.holdNextWrite();
        final staleSave = container
            .read(brokerCredentialsControllerProvider.notifier)
            .saveToken('stale-token-a');
        await store.writeStarted.future;

        final replacement = _replaceWithPairedProfile(
          container: container,
          profileA: profileA,
          tokenB: 'token-b',
        );
        var replacementFinished = false;
        unawaited(replacement.whenComplete(() => replacementFinished = true));
        await Future<void>.delayed(Duration.zero);
        expect(replacementFinished, isFalse);

        store.releaseWrite();
        await staleSave;
        final profileB = await replacement;

        expect(profileB.incarnationId, isNot(profileA.incarnationId));
        expect(await store.readBrokerToken(key), 'token-b');
        expect(
          container.read(activeBrokerProfileProvider)?.incarnationId,
          profileB.incarnationId,
        );
      },
    );

    test(
      'held A clearToken delete cannot remove re-added B token',
      () async {
        final profileA = remoteProfile().copyWith(
          incarnationId: 'inc-a',
          credentialKey: 'broker-token:${remoteProfile().id}',
        );
        final key = profileA.credentialKey!;
        await repository.save(profileA);
        await store.writeBrokerToken(key, 'token-a');
        container.read(activeBrokerProfileProvider.notifier).state = profileA;

        store.holdNextDelete();
        final staleClear = container
            .read(brokerCredentialsControllerProvider.notifier)
            .clearToken();
        await store.deleteStarted.future;

        final replacement = _replaceWithPairedProfile(
          container: container,
          profileA: profileA,
          tokenB: 'token-b-clear',
        );
        await Future<void>.delayed(Duration.zero);
        expect(await repository.getById(profileA.id), same(profileA));

        store.releaseDelete();
        await staleClear;
        final profileB = await replacement;

        expect(profileB.incarnationId, isNot(profileA.incarnationId));
        expect(await store.readBrokerToken(key), 'token-b-clear');
      },
    );

    test(
      'held A signOut delete cannot remove re-added B token',
      () async {
        final profileA = remoteProfile().copyWith(
          incarnationId: 'inc-a',
          credentialKey: 'broker-token:${remoteProfile().id}',
        );
        final key = profileA.credentialKey!;
        await repository.save(profileA);
        await store.writeBrokerToken(key, 'token-a');
        container.read(activeBrokerProfileProvider.notifier).state = profileA;

        store.holdNextDelete();
        final staleSignOut = container
            .read(brokerCredentialsControllerProvider.notifier)
            .signOut();
        await store.deleteStarted.future;

        final replacement = _replaceWithPairedProfile(
          container: container,
          profileA: profileA,
          tokenB: 'token-b-sign-out',
        );

        store.releaseDelete();
        await staleSignOut;
        final profileB = await replacement;

        expect(profileB.incarnationId, isNot(profileA.incarnationId));
        expect(await store.readBrokerToken(key), 'token-b-sign-out');
      },
    );
  });
}

Future<BrokerProfile> _replaceWithPairedProfile({
  required ProviderContainer container,
  required BrokerProfile profileA,
  required String tokenB,
}) async {
  await container
      .read(brokerProfileManagerControllerProvider)
      .deleteProfile(profileA.id, expectedProfile: profileA);
  await container
      .read(pairingControllerProvider.notifier)
      .importPayload(
        '{ "brokerUrl": "${profileA.id}", '
        '"token": "$tokenB", "displayName": "Replacement B" }',
      );
  return (await container
      .read(brokerProfileRepositoryProvider)
      .getById(profileA.id))!;
}

final class _SpyCredentialStore implements CredentialStore {
  final Map<String, String> _tokens = <String, String>{};

  int readCount = 0;
  int writeCount = 0;
  int deleteCount = 0;
  Completer<void> writeStarted = Completer<void>();
  Completer<void> deleteStarted = Completer<void>();
  Completer<void>? _releaseHeldWrite;
  Completer<void>? _releaseHeldDelete;

  void holdNextWrite() {
    writeStarted = Completer<void>();
    _releaseHeldWrite = Completer<void>();
  }

  void releaseWrite() {
    _releaseHeldWrite?.complete();
  }

  void holdNextDelete() {
    deleteStarted = Completer<void>();
    _releaseHeldDelete = Completer<void>();
  }

  void releaseDelete() {
    _releaseHeldDelete?.complete();
  }

  @override
  Future<String?> readBrokerToken(String credentialKey) async {
    readCount += 1;
    return _tokens[credentialKey];
  }

  @override
  Future<void> writeBrokerToken(String credentialKey, String token) async {
    writeCount += 1;
    final release = _releaseHeldWrite;
    if (release != null) {
      writeStarted.complete();
      await release.future;
      if (identical(_releaseHeldWrite, release)) {
        _releaseHeldWrite = null;
      }
    }
    _tokens[credentialKey] = token;
  }

  @override
  Future<void> deleteBrokerToken(String credentialKey) async {
    deleteCount += 1;
    final release = _releaseHeldDelete;
    if (release != null) {
      deleteStarted.complete();
      await release.future;
      if (identical(_releaseHeldDelete, release)) {
        _releaseHeldDelete = null;
      }
    }
    _tokens.remove(credentialKey);
  }
}

class _InMemoryBrokerProfileRepository implements BrokerProfileRepository {
  final Map<String, BrokerProfile> _profiles = <String, BrokerProfile>{};

  bool throwOnSave = false;

  @override
  Future<List<BrokerProfile>> getAll() async {
    return _profiles.values.toList();
  }

  @override
  Future<BrokerProfile?> getById(String id) async {
    return _profiles[id];
  }

  @override
  Future<BrokerProfile> save(BrokerProfile profile) async {
    if (throwOnSave) {
      throw StateError('save failed');
    }
    _profiles[profile.id] = profile;
    return profile;
  }

  @override
  Future<bool> delete({
    required String id,
    required String? incarnationId,
  }) async {
    return _profiles.remove(id) != null;
  }
}
