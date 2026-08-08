import 'dart:async';
import 'dart:convert';

import 'package:broker_contract/broker_contract.dart';
import 'package:broker_crypto/broker_crypto.dart' as crypto;
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/data/active_broker_profile_store.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/pairing/controller/pairing_controller.dart';
import 'package:cosyncing_client/src/features/pairing/data/transport_pairing_accept_service.dart';
import 'package:cosyncing_client/src/features/pairing/data/transport_pairing_store.dart';
import 'package:cosyncing_client/src/features/pairing/model/transport_qr_payload.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late _SpyCredentialStore credentialStore;
  late _InMemoryBrokerProfileRepository repository;
  late _InMemoryActiveBrokerProfileStore activeStore;
  late _FakeTransportPairingAcceptService transportAcceptService;
  late _InMemoryTransportPairingStore transportStore;
  late ProviderContainer container;

  setUp(() {
    credentialStore = _SpyCredentialStore();
    repository = _InMemoryBrokerProfileRepository();
    activeStore = _InMemoryActiveBrokerProfileStore();
    transportAcceptService = _FakeTransportPairingAcceptService();
    transportStore = _InMemoryTransportPairingStore();

    container = ProviderContainer(
      overrides: [
        credentialStoreProvider.overrideWithValue(credentialStore),
        brokerProfileRepositoryProvider.overrideWithValue(repository),
        activeBrokerProfileStoreProvider.overrideWithValue(activeStore),
        transportPairingAcceptServiceProvider.overrideWithValue(
          transportAcceptService,
        ),
        transportPairingStoreProvider.overrideWithValue(transportStore),
      ],
    );
  });

  tearDown(() {
    container.dispose();
  });

  BrokerProfile existingProfile({
    String id = 'https://broker.example.com:9443',
    String displayName = 'Old Remote',
    String? credentialKey,
  }) {
    return BrokerProfile(
      id: id,
      displayName: displayName,
      baseUri: Uri.parse(id),
      createdAt: DateTime(2026, 6, 25),
      updatedAt: DateTime(2026, 6, 25, 12),
      credentialKey: credentialKey,
    );
  }

  group('PairingController', () {
    test(
      'imports plain payload and activates a new profile without token',
      () async {
        await container
            .read(pairingControllerProvider.notifier)
            .importPayload('https://broker.example.com:9443');

        final state = container.read(pairingControllerProvider);
        final stored = await repository.getById(
          'https://broker.example.com:9443',
        );

        expect(state.notice, PairingNotice.paired);
        expect(stored?.id, 'https://broker.example.com:9443');
        expect(stored?.displayName, 'broker.example.com');
        expect(stored?.credentialKey, isNull);
        expect(credentialStore.writeCount, 0);
        expect(activeStore.activeProfileId, 'https://broker.example.com:9443');
        expect(container.read(activeBrokerProfileProvider)?.id, stored?.id);
        expect(state.isBusy, isFalse);
      },
    );

    test(
      'imports pairing JSON with token and stores runtime credential key',
      () async {
        const profileId = 'https://broker.example.com:9443';

        await container
            .read(pairingControllerProvider.notifier)
            .importPayload(
              '{ "brokerUrl": "$profileId", '
              '"token": "abc", '
              '"displayName": "Office" }',
            );

        final state = container.read(pairingControllerProvider);
        final stored = await repository.getById(profileId);

        expect(state.notice, PairingNotice.paired);
        expect(stored?.credentialKey, 'broker-token:$profileId');
        expect(
          await credentialStore.readBrokerToken('broker-token:$profileId'),
          'abc',
        );
        expect(activeStore.activeProfileId, profileId);
        expect(
          container.read(activeBrokerProfileProvider)?.displayName,
          'Office',
        );
        expect(credentialStore.writeCount, 1);
        expect(credentialStore.deleteCount, 0);
        expect(credentialStore.readCount, 1);
      },
    );

    test(
      'updates existing profile and preserves createdAt and credential key '
      'without token',
      () async {
        const profileId = 'https://broker.example.com:9443';
        const credentialKey = 'broker-token:$profileId';
        final existing = existingProfile(credentialKey: credentialKey);
        await repository.save(existing);
        await credentialStore.writeBrokerToken(credentialKey, 'old-token');

        await container
            .read(pairingControllerProvider.notifier)
            .importPayload(
              '{ "brokerUrl": "$profileId", "displayName": "New Name" }',
            );

        final merged = await repository.getById(profileId);
        expect(merged, isNotNull);
        expect(merged!.displayName, 'New Name');
        expect(merged.createdAt, existing.createdAt);
        expect(merged.credentialKey, credentialKey);
        expect(
          await credentialStore.readBrokerToken(credentialKey),
          'old-token',
        );
        expect(credentialStore.writeCount, 1);
        expect(credentialStore.deleteCount, 0);
        expect(activeStore.activeProfileId, profileId);
      },
    );

    test('returns clear error for empty input', () async {
      await container
          .read(pairingControllerProvider.notifier)
          .importPayload('   ');

      final state = container.read(pairingControllerProvider);
      expect(state.notice, PairingNotice.emptyInput);
      expect(state.isBusy, isFalse);
      expect(credentialStore.writeCount, 0);
      expect(await repository.getAll(), isEmpty);
    });

    test('returns clear error for malformed payload', () async {
      await container
          .read(pairingControllerProvider.notifier)
          .importPayload('{ invalid json }');

      final state = container.read(pairingControllerProvider);
      expect(state.notice, PairingNotice.invalidInput);
      expect(state.isBusy, isFalse);
      expect(await repository.getAll(), isEmpty);
    });

    test(
      'restores existing token when profile save fails after token write',
      () async {
        const profileId = 'https://broker.example.com:9443';
        const credentialKey = 'broker-token:$profileId';
        final failingRepository = _FailingBrokerProfileRepository();
        final failingCredentialStore = _SpyCredentialStore();
        final failingActiveStore = _InMemoryActiveBrokerProfileStore();
        await failingRepository.save(
          existingProfile(credentialKey: credentialKey),
        );
        await failingCredentialStore.writeBrokerToken(
          credentialKey,
          'old-token',
        );
        failingRepository.failSaves = true;

        final failingContainer = ProviderContainer(
          overrides: [
            credentialStoreProvider.overrideWithValue(failingCredentialStore),
            brokerProfileRepositoryProvider.overrideWithValue(
              failingRepository,
            ),
            activeBrokerProfileStoreProvider.overrideWithValue(
              failingActiveStore,
            ),
          ],
        );

        await failingContainer
            .read(pairingControllerProvider.notifier)
            .importPayload(
              '{ "brokerUrl": "$profileId", "token": "new-token" }',
            );

        final state = failingContainer.read(pairingControllerProvider);
        final stored = await failingRepository.getById(profileId);

        expect(state.notice, PairingNotice.profileSaveFailed);
        expect(state.technicalDetail, isNotEmpty);
        expect(stored?.displayName, 'Old Remote');
        expect(
          await failingCredentialStore.readBrokerToken(credentialKey),
          'old-token',
        );
        expect(failingActiveStore.activeProfileId, isNull);
        failingContainer.dispose();
      },
    );

    test(
      'keeps imported profile and token when active persistence fails',
      () async {
        const profileId = 'https://broker.example.com:9443';
        const credentialKey = 'broker-token:$profileId';
        final activeFailRepository = _InMemoryBrokerProfileRepository();
        final activeFailCredentialStore = _SpyCredentialStore();
        final activeFailStore = _FailingActiveBrokerProfileStore();
        final activeFailContainer = ProviderContainer(
          overrides: [
            credentialStoreProvider.overrideWithValue(
              activeFailCredentialStore,
            ),
            brokerProfileRepositoryProvider.overrideWithValue(
              activeFailRepository,
            ),
            activeBrokerProfileStoreProvider.overrideWithValue(
              activeFailStore,
            ),
          ],
        );

        await activeFailContainer
            .read(pairingControllerProvider.notifier)
            .importPayload(
              '{ "brokerUrl": "$profileId", "token": "new-token" }',
            );

        final state = activeFailContainer.read(pairingControllerProvider);
        final stored = await activeFailRepository.getById(profileId);

        expect(state.notice, PairingNotice.profileActivationFailed);
        expect(stored?.credentialKey, credentialKey);
        expect(
          await activeFailCredentialStore.readBrokerToken(credentialKey),
          'new-token',
        );
        expect(activeFailContainer.read(activeBrokerProfileProvider), isNull);
        activeFailContainer.dispose();
      },
    );

    test('shows busy state while import is in progress', () async {
      final delayedRepo = _DelayedBrokerProfileRepository();
      final delayedStore = _SpyCredentialStore();
      final delayedActiveStore = _InMemoryActiveBrokerProfileStore();
      final delayedContainer = ProviderContainer(
        overrides: [
          credentialStoreProvider.overrideWithValue(delayedStore),
          brokerProfileRepositoryProvider.overrideWithValue(delayedRepo),
          activeBrokerProfileStoreProvider.overrideWithValue(
            delayedActiveStore,
          ),
        ],
      );

      final notifier = delayedContainer.read(
        pairingControllerProvider.notifier,
      );
      final future = notifier.importPayload('https://broker.example.com:9443');
      expect(
        delayedContainer.read(pairingControllerProvider).isBusy,
        isTrue,
      );
      delayedRepo.complete();
      await future;

      expect(
        delayedContainer.read(pairingControllerProvider).notice,
        PairingNotice.paired,
      );
      delayedContainer.dispose();
    });

    test(
      'accepts QR v2, stores credentials, and activates a peer-auth profile',
      () async {
        final qr = _transportQr(version: 2, pairingId: 'pair_abc');

        await container
            .read(pairingControllerProvider.notifier)
            .importPayload(qr);

        final state = container.read(pairingControllerProvider);

        expect(state.notice, PairingNotice.devicePaired);
        final profiles = await repository.getAll();
        expect(profiles, hasLength(1));
        expect(profiles.single.id, 'http://broker:7734');
        expect(profiles.single.displayName, 'broker-test');
        expect(
          profiles.single.credentialKey,
          'broker-peer-token:http://broker:7734',
        );
        expect(activeStore.activeProfileId, 'http://broker:7734');
        expect(
          container.read(activeBrokerProfileProvider)?.id,
          'http://broker:7734',
        );
        expect(
          await credentialStore.readBrokerToken(
            'broker-peer-token:http://broker:7734',
          ),
          'broker-peer-token',
        );
        expect(transportAcceptService.lastPairingId, 'pair_abc');
        expect(transportAcceptService.lastPeerId, startsWith('client-'));
        expect(transportStore.writes, 1);
        expect(transportStore.last?.brokerId, 'broker-test');
        expect(transportStore.last?.brokerUrl, Uri.parse('http://broker:7734'));
        expect(transportStore.last?.localPeerId, startsWith('client-'));
        expect(transportStore.last?.localPeerToken, isNotEmpty);
        expect(transportStore.last?.identityPrivateKey, isNotEmpty);
        expect(transportStore.last?.exchangePrivateKey, isNotEmpty);
        expect(transportStore.last?.brokerPeerId, 'broker-peer');
        expect(transportStore.last?.brokerPeerToken, 'broker-peer-token');
        expect(
          crypto.base64UrlDecodeNoPadding(transportStore.last!.dataKey),
          transportAcceptService.dataKey,
        );
      },
    );

    test(
      'restores the previous peer token when profile adoption fails',
      () async {
        const profileId = 'http://broker:7734';
        const credentialKey = 'broker-peer-token:$profileId';
        final failingRepository = _FailingBrokerProfileRepository();
        final failingCredentialStore = _SpyCredentialStore();
        final failingActiveStore = _InMemoryActiveBrokerProfileStore();
        final failingTransportStore = _InMemoryTransportPairingStore();
        await failingRepository.save(
          existingProfile(
            id: profileId,
            displayName: 'Existing paired broker',
            credentialKey: credentialKey,
          ),
        );
        await failingCredentialStore.writeBrokerToken(
          credentialKey,
          'previous-peer-token',
        );
        failingRepository.failSaves = true;

        final failingContainer = ProviderContainer(
          overrides: [
            credentialStoreProvider.overrideWithValue(failingCredentialStore),
            brokerProfileRepositoryProvider.overrideWithValue(
              failingRepository,
            ),
            activeBrokerProfileStoreProvider.overrideWithValue(
              failingActiveStore,
            ),
            transportPairingAcceptServiceProvider.overrideWithValue(
              transportAcceptService,
            ),
            transportPairingStoreProvider.overrideWithValue(
              failingTransportStore,
            ),
          ],
        );

        await failingContainer
            .read(pairingControllerProvider.notifier)
            .importPayload(_transportQr(version: 2, pairingId: 'pair_retry'));

        final state = failingContainer.read(pairingControllerProvider);
        expect(state.notice, PairingNotice.failed);
        expect(state.technicalDetail, isNotEmpty);
        expect(
          await failingCredentialStore.readBrokerToken(credentialKey),
          'previous-peer-token',
        );
        expect(failingTransportStore.credentials, isEmpty);
        expect(
          (await failingRepository.getById(profileId))?.displayName,
          'Existing paired broker',
        );
        expect(failingActiveStore.activeProfileId, isNull);
        failingContainer.dispose();
      },
    );

    test(
      'retains peer profile and credential when activation fails',
      () async {
        const profileId = 'http://broker:7734';
        const credentialKey = 'broker-peer-token:$profileId';
        final activeFailRepository = _InMemoryBrokerProfileRepository();
        final activeFailCredentialStore = _SpyCredentialStore();
        final activeFailStore = _FailingActiveBrokerProfileStore();
        final activeFailTransportStore = _InMemoryTransportPairingStore();
        final activeFailContainer = ProviderContainer(
          overrides: [
            credentialStoreProvider.overrideWithValue(
              activeFailCredentialStore,
            ),
            brokerProfileRepositoryProvider.overrideWithValue(
              activeFailRepository,
            ),
            activeBrokerProfileStoreProvider.overrideWithValue(
              activeFailStore,
            ),
            transportPairingAcceptServiceProvider.overrideWithValue(
              transportAcceptService,
            ),
            transportPairingStoreProvider.overrideWithValue(
              activeFailTransportStore,
            ),
          ],
        );

        await activeFailContainer
            .read(pairingControllerProvider.notifier)
            .importPayload(
              _transportQr(version: 2, pairingId: 'pair_active_fail'),
            );

        final state = activeFailContainer.read(pairingControllerProvider);
        expect(state.notice, PairingNotice.deviceActivationFailed);
        expect(
          (await activeFailRepository.getById(profileId))?.credentialKey,
          credentialKey,
        );
        expect(
          await activeFailCredentialStore.readBrokerToken(credentialKey),
          'broker-peer-token',
        );
        expect(activeFailTransportStore.credentials, hasLength(1));
        expect(activeFailContainer.read(activeBrokerProfileProvider), isNull);
        activeFailContainer.dispose();
      },
    );

    test(
      'guides legacy QR v1 payloads back to the token import path',
      () async {
        await container
            .read(pairingControllerProvider.notifier)
            .importPayload(_transportQr(version: 1));

        final state = container.read(pairingControllerProvider);

        expect(state.notice, PairingNotice.oldQr);
        expect(transportAcceptService.calls, 0);
        expect(transportStore.writes, 0);
        expect(await repository.getAll(), isEmpty);
      },
    );

    test('surfaces already-accepted QR as a distinct leak signal', () async {
      transportAcceptService.failure = const BrokerException(
        message: 'pairing failed',
        statusCode: 409,
        error: BrokerError(
          error: 'this pairing QR was already used',
          code: 'PAIRING_ALREADY_ACCEPTED',
        ),
      );

      await container
          .read(pairingControllerProvider.notifier)
          .importPayload(_transportQr(version: 2, pairingId: 'pair_used'));

      final state = container.read(pairingControllerProvider);

      expect(state.notice, PairingNotice.alreadyUsed);
      expect(transportStore.writes, 0);
    });

    test('bounds an oversized broker body in live controller state', () async {
      final oversized = 'pairing-body:${'x' * 5000}:unbounded-tail';
      transportAcceptService.failure = BrokerException(
        message: 'pairing failed',
        statusCode: 500,
        error: BrokerError(error: oversized, code: 'PAIRING_FAILED'),
      );

      await container
          .read(pairingControllerProvider.notifier)
          .importPayload(_transportQr(version: 2, pairingId: 'pair_large'));

      final detail = container.read(pairingControllerProvider).technicalDetail;
      expect(detail, isNotNull);
      expect(detail!.length, maxTechnicalDetailLength);
      expect(detail, endsWith('…'));
      expect(detail, isNot(contains('unbounded-tail')));
    });
  });
}

String _transportQr({
  required int version,
  String? pairingId,
}) {
  final payload = <String, Object?>{
    'version': version,
    'brokerId': 'broker-test',
    'publicKey': 'broker-public',
    'transport': {'kind': 'tailscale-direct', 'url': 'http://broker:7734'},
    if (pairingId != null) 'pairingId': pairingId,
  };
  return 'cosyncing://pair?payload=${crypto.base64UrlNoPadding(utf8.encode(jsonEncode(payload)))}';
}

class _SpyCredentialStore implements CredentialStore {
  final Map<String, String> _tokens = <String, String>{};

  int readCount = 0;
  int writeCount = 0;
  int deleteCount = 0;

  @override
  Future<String?> readBrokerToken(String credentialKey) async {
    readCount += 1;
    return _tokens[credentialKey];
  }

  @override
  Future<void> writeBrokerToken(String credentialKey, String token) async {
    writeCount += 1;
    _tokens[credentialKey] = token;
  }

  @override
  Future<void> deleteBrokerToken(String credentialKey) async {
    deleteCount += 1;
    _tokens.remove(credentialKey);
  }
}

class _InMemoryBrokerProfileRepository implements BrokerProfileRepository {
  final Map<String, BrokerProfile> _profiles = <String, BrokerProfile>{};

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

class _DelayedBrokerProfileRepository extends _InMemoryBrokerProfileRepository {
  Completer<void> completer = Completer<void>();

  void complete() {
    completer.complete();
  }

  @override
  Future<BrokerProfile> save(BrokerProfile profile) async {
    await completer.future;
    return super.save(profile);
  }
}

class _FailingBrokerProfileRepository extends _InMemoryBrokerProfileRepository {
  bool failSaves = false;

  @override
  Future<BrokerProfile> save(BrokerProfile profile) async {
    if (failSaves) {
      throw StateError('save failed');
    }
    return super.save(profile);
  }
}

class _InMemoryActiveBrokerProfileStore implements ActiveBrokerProfileStore {
  String? activeProfileId;

  @override
  Future<String?> getActiveProfileId() async {
    return activeProfileId;
  }

  @override
  Future<void> setActiveProfileId(String? profileId) async {
    activeProfileId = profileId;
  }

  @override
  Future<void> clearActiveProfileId() async {
    activeProfileId = null;
  }
}

class _FakeTransportPairingAcceptService
    implements TransportPairingAcceptService {
  final List<int> dataKey = List<int>.generate(32, (index) => index + 1);
  Object? failure;
  int calls = 0;
  String? lastPairingId;
  String? lastPeerId;

  @override
  Future<TransportPairingAcceptResponse> accept(
    TransportQrPayload payload, {
    required String peerId,
    required String peerToken,
    required String identityPublicKey,
    required String exchangePublicKey,
  }) async {
    calls += 1;
    lastPairingId = payload.pairingId;
    lastPeerId = peerId;
    final failure = this.failure;
    if (failure != null) {
      Error.throwWithStackTrace(failure, StackTrace.current);
    }

    final wrapped = await crypto.PairingCrypto.wrapDataKeyForPeer(
      dataKey: dataKey,
      recipientPublicKey: exchangePublicKey,
    );
    return TransportPairingAcceptResponse(
      peer: TransportPairingPeer(
        peerId: peerId,
        label: 'Phone',
        identityPublicKey: identityPublicKey,
      ),
      broker: const TransportPairingPeer(
        peerId: 'broker-peer',
        peerToken: 'broker-peer-token',
        identityPublicKey: 'broker-identity-public',
      ),
      wrappedDataKey: TransportWrappedDataKey(
        version: wrapped.version,
        algorithm: wrapped.algorithm,
        ephemeralPublicKey: wrapped.ephemeralPublicKey,
        nonce: wrapped.nonce,
        ciphertext: wrapped.ciphertext,
        tag: wrapped.tag,
      ),
    );
  }
}

class _InMemoryTransportPairingStore implements TransportPairingStore {
  final Map<String, TransportPairingCredentials> credentials =
      <String, TransportPairingCredentials>{};
  int writes = 0;
  TransportPairingCredentials? last;

  @override
  Future<void> write(TransportPairingCredentials credentials) async {
    writes += 1;
    last = credentials;
    this.credentials[credentials.id] = credentials;
  }

  @override
  Future<TransportPairingCredentials?> read(String id) async {
    return credentials[id];
  }

  @override
  Future<void> delete(String id) async {
    credentials.remove(id);
  }
}

class _FailingActiveBrokerProfileStore
    extends _InMemoryActiveBrokerProfileStore {
  @override
  Future<void> setActiveProfileId(String? profileId) async {
    throw StateError('active save failed');
  }
}
