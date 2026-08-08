import 'dart:async';

import 'package:cosyncing_client/src/errors/user_facing_error.dart';
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

  BrokerProfile loopbackProfile() => BrokerProfile(
    id: 'http://127.0.0.1:7734',
    displayName: 'local',
    baseUri: Uri.parse('http://127.0.0.1:7734'),
    createdAt: DateTime(2026),
  );

  group('BrokerCredentialsController', () {
    test('no active profile: save does not call credential store', () async {
      await container
          .read(brokerCredentialsControllerProvider.notifier)
          .saveToken('runtime-token');

      final state = container.read(brokerCredentialsControllerProvider);
      expect(state.notice, BrokerCredentialNotice.noActiveProfile);
      expect(state.hasError, isTrue);
      expect(store.writeCount, 0);
      expect(store.deleteCount, 0);
      expect(store.readCount, 0);
    });

    // A loopback broker still requires a token once one is provisioned: the
    // broker stops answering anonymously and enforces that on 127.0.0.1 like
    // anywhere else. Refusing to persist here previously left the app unable
    // to authenticate against its own local broker while the PoC UI, which
    // makes no such assumption, worked with the identical token.
    test('loopback profile: save persists like any other host', () async {
      await repository.save(loopbackProfile());
      container.read(activeBrokerProfileProvider.notifier).state =
          loopbackProfile();

      await container
          .read(brokerCredentialsControllerProvider.notifier)
          .saveToken('runtime-token');

      final state = container.read(brokerCredentialsControllerProvider);
      expect(state.hasError, isFalse);
      expect(store.writeCount, 1);
    });

    test(
      'save persists deterministic credential key and updates profile',
      () async {
        final profile = remoteProfile();
        await repository.save(profile);
        container.read(activeBrokerProfileProvider.notifier).state = profile;

        await container
            .read(brokerCredentialsControllerProvider.notifier)
            .saveToken('new-remote-token');

        final token = await store.readBrokerToken('broker-token:${profile.id}');
        final activeProfile = container.read(activeBrokerProfileProvider);
        final persistedProfile = await repository.getById(profile.id);

        expect(token, 'new-remote-token');
        expect(activeProfile?.credentialKey, 'broker-token:${profile.id}');
        expect(persistedProfile?.credentialKey, 'broker-token:${profile.id}');
        expect(store.writeCount, 1);
        expect(store.deleteCount, 0);
        expect(
          container.read(brokerCredentialsControllerProvider).notice,
          BrokerCredentialNotice.tokenSaved,
        );
        // The gate uses this to tell a just-typed bad token apart from a
        // stored credential that stopped working.
        expect(
          container
              .read(brokerCredentialsControllerProvider)
              .savedTokenThisSession,
          isTrue,
        );
      },
    );

    test(
      'clear deletes store token and clears profile credential key',
      () async {
        final profile = remoteProfile();
        final key = 'broker-token:${profile.id}';

        await repository.save(
          profile.copyWith(
            credentialKey: key,
            updatedAt: DateTime(2026),
          ),
        );
        await store.writeBrokerToken(key, 'old-token');
        container.read(activeBrokerProfileProvider.notifier).state =
            await repository.getById(profile.id);

        await container
            .read(brokerCredentialsControllerProvider.notifier)
            .clearToken();

        expect(await store.readBrokerToken(key), isNull);
        final persistedProfile = await repository.getById(profile.id);
        expect(persistedProfile?.credentialKey, isNull);
        expect(
          container.read(activeBrokerProfileProvider)?.credentialKey,
          isNull,
        );
        expect(store.deleteCount, 1);
        expect(
          container.read(brokerCredentialsControllerProvider).notice,
          BrokerCredentialNotice.tokenRemoved,
        );
      },
    );

    test(
      'blank token is treated as validation error and not persisted',
      () async {
        final profile = remoteProfile();
        await repository.save(profile);
        container.read(activeBrokerProfileProvider.notifier).state = profile;

        await container
            .read(brokerCredentialsControllerProvider.notifier)
            .saveToken('   ');

        expect(
          container.read(brokerCredentialsControllerProvider).notice,
          BrokerCredentialNotice.tokenEmpty,
        );
        expect(store.writeCount, 0);
        expect(store.readCount, 0);
        expect(store.deleteCount, 0);
        expect(await repository.getById(profile.id), isNotNull);
        final maybeKey = (await repository.getById(profile.id))?.credentialKey;
        expect(maybeKey, isNull);
      },
    );

    test(
      'save rolls back new token when profile persistence fails',
      () async {
        final profile = remoteProfile();
        await repository.save(profile);
        container.read(activeBrokerProfileProvider.notifier).state = profile;
        repository.throwOnSave = true;

        await container
            .read(brokerCredentialsControllerProvider.notifier)
            .saveToken('new-remote-token');

        final credentialKey = 'broker-token:${profile.id}';
        expect(await store.readBrokerToken(credentialKey), isNull);
        expect(store.writeCount, 1);
        expect(store.deleteCount, 1);
        expect(
          container.read(activeBrokerProfileProvider)?.credentialKey,
          isNull,
        );
        final failed = container.read(brokerCredentialsControllerProvider);
        expect(failed.notice, BrokerCredentialNotice.saveFailed);
        expect(failed.hasError, isTrue);
        // The raw exception is kept for the disclosure, never for the message.
        expect(failed.detail, contains('save failed'));
        expect(failed.failureKind, FailureKind.unknown);
      },
    );

    test('signOut clears the credential and the profile reference', () async {
      final profile = remoteProfile().copyWith(
        credentialKey: 'broker-token:${remoteProfile().id}',
      );
      await store.writeBrokerToken(profile.credentialKey!, 'stored-token');
      await repository.save(profile);
      container.read(activeBrokerProfileProvider.notifier).state = profile;

      await container
          .read(brokerCredentialsControllerProvider.notifier)
          .signOut();

      expect(await store.readBrokerToken(profile.credentialKey!), isNull);
      expect(store.deleteCount, 1);
      expect(
        container.read(activeBrokerProfileProvider)?.credentialKey,
        isNull,
      );
      expect(
        (await repository.getById(profile.id))?.credentialKey,
        isNull,
      );
      expect(
        container.read(brokerCredentialsControllerProvider).notice,
        BrokerCredentialNotice.signedOut,
      );
    });

    test('signOut clears a loopback profile credential too', () async {
      // Unlike clearToken, sign-out is unconditional: the user asked to drop
      // whatever is stored, including on loopback.
      final profile = loopbackProfile().copyWith(
        credentialKey: 'broker-token:${loopbackProfile().id}',
      );
      await store.writeBrokerToken(profile.credentialKey!, 'loopback-token');
      await repository.save(profile);
      container.read(activeBrokerProfileProvider.notifier).state = profile;

      await container
          .read(brokerCredentialsControllerProvider.notifier)
          .signOut();

      expect(await store.readBrokerToken(profile.credentialKey!), isNull);
      expect(
        container.read(brokerCredentialsControllerProvider).hasError,
        isFalse,
      );
    });

    test('signOut clears a paired peer credential', () async {
      final profile = remoteProfile().copyWith(
        credentialKey: 'broker-peer-token:${remoteProfile().id}',
      );
      await store.writeBrokerToken(profile.credentialKey!, 'peer-token');
      await repository.save(profile);
      container.read(activeBrokerProfileProvider.notifier).state = profile;

      await container
          .read(brokerCredentialsControllerProvider.notifier)
          .signOut();

      expect(await store.readBrokerToken(profile.credentialKey!), isNull);
      expect(
        container.read(activeBrokerProfileProvider)?.credentialKey,
        isNull,
      );
    });

    test('signOut with nothing stored is a no-op', () async {
      final profile = remoteProfile();
      await repository.save(profile);
      container.read(activeBrokerProfileProvider.notifier).state = profile;

      await container
          .read(brokerCredentialsControllerProvider.notifier)
          .signOut();

      expect(store.deleteCount, 0);
      expect(
        container.read(brokerCredentialsControllerProvider).notice,
        BrokerCredentialNotice.noCredentialStored,
      );
    });

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
