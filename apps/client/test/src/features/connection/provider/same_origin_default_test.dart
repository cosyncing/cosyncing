import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/data/active_broker_profile_store.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late ProviderContainer container;
  late _InMemoryBrokerProfileRepository repository;
  late _InMemoryActiveBrokerProfileStore activeStore;

  setUp(() {
    repository = _InMemoryBrokerProfileRepository();
    activeStore = _InMemoryActiveBrokerProfileStore();
    container = ProviderContainer(
      overrides: [
        brokerProfileRepositoryProvider.overrideWithValue(repository),
        activeBrokerProfileStoreProvider.overrideWithValue(activeStore),
      ],
    );
  });

  tearDown(() {
    container.dispose();
  });

  group('selectSameOriginBrokerProfile', () {
    test('selects, persists, and activates the same-origin profile', () async {
      final selected = await selectSameOriginBrokerProfile(
        container.read(_refProbeProvider),
        base: Uri.parse('http://127.0.0.1:7734/cosy/index.html'),
      );

      expect(selected, isNotNull);
      expect(selected!.baseUri, Uri.parse('http://127.0.0.1:7734'));

      // Active in-memory state is set so brokerClientProvider can build.
      final active = container.read(activeBrokerProfileProvider);
      expect(active?.baseUri, Uri.parse('http://127.0.0.1:7734'));

      // Persisted for restart survival and profile-list visibility.
      expect(
        await activeStore.getActiveProfileId(),
        'http://127.0.0.1:7734',
      );
      expect(
        await repository.getById('http://127.0.0.1:7734'),
        isNotNull,
      );
    });

    // Re-flagged item 26: everything that reacts to "which brokers exist"
    // reads brokerProfileListProvider. A bare repository write left that list
    // holding the empty snapshot it built moments earlier, so on web — where
    // this profile is the only broker — the attention feed coordinator saw no
    // profiles, started no workers, and the unread badge stayed dark forever.
    test('publishes the profile to the broker profile list', () async {
      // Build the list first, so it holds the pre-save (empty) snapshot —
      // exactly the ordering that hid the profile on a fresh web client.
      expect(await container.read(brokerProfileListProvider.future), isEmpty);

      await selectSameOriginBrokerProfile(
        container.read(_refProbeProvider),
        base: Uri.parse('http://127.0.0.1:7734/cosy/'),
      );

      final profiles = await container.read(brokerProfileListProvider.future);
      expect(
        profiles.map((profile) => profile.id),
        contains('http://127.0.0.1:7734'),
        reason: 'the feed coordinator only polls profiles in this list',
      );
    });

    test('derives an https/wss-capable base without a forced port', () async {
      final selected = await selectSameOriginBrokerProfile(
        container.read(_refProbeProvider),
        base: Uri.parse('https://broker.example.com/cosy/'),
      );

      expect(selected!.baseUri.toString(), 'https://broker.example.com');
    });

    test(
      'preserves an existing profile (and its credential) for the origin',
      () async {
        await repository.save(
          BrokerProfile(
            id: 'http://127.0.0.1:7734',
            displayName: 'My Saved Broker',
            baseUri: Uri.parse('http://127.0.0.1:7734'),
            createdAt: DateTime(2026, 6),
            credentialKey: 'broker-token:local',
          ),
        );

        final selected = await selectSameOriginBrokerProfile(
          container.read(_refProbeProvider),
          base: Uri.parse('http://127.0.0.1:7734/cosy/'),
        );

        expect(selected!.displayName, 'My Saved Broker');
        expect(selected.credentialKey, 'broker-token:local');
        expect(selected.createdAt, DateTime(2026, 6));
      },
    );

    test('no-ops for a non-attachable origin', () async {
      final selected = await selectSameOriginBrokerProfile(
        container.read(_refProbeProvider),
        base: Uri.parse('file:///tmp/cosy/index.html'),
      );

      expect(selected, isNull);
      expect(container.read(activeBrokerProfileProvider), isNull);
      expect(await activeStore.getActiveProfileId(), isNull);
    });
  });
}

/// Exposes a [Ref] from within the container so the top-level selector function
/// can be invoked in a test with the overridden repository/store providers.
final _refProbeProvider = Provider<Ref>((ref) => ref);

class _InMemoryBrokerProfileRepository implements BrokerProfileRepository {
  final Map<String, BrokerProfile> _profiles = {};

  @override
  Future<List<BrokerProfile>> getAll() async =>
      List<BrokerProfile>.from(_profiles.values);

  @override
  Future<BrokerProfile?> getById(String id) async => _profiles[id];

  @override
  Future<BrokerProfile> save(BrokerProfile profile) async {
    _profiles[profile.id] = profile;
    return profile;
  }

  @override
  Future<bool> delete({
    required String id,
    required String? incarnationId,
  }) async => _profiles.remove(id) != null;
}

class _InMemoryActiveBrokerProfileStore implements ActiveBrokerProfileStore {
  String? _activeProfileId;

  @override
  Future<String?> getActiveProfileId() async => _activeProfileId;

  @override
  Future<void> setActiveProfileId(String? profileId) async {
    _activeProfileId = profileId;
  }

  @override
  Future<void> clearActiveProfileId() async {
    _activeProfileId = null;
  }
}
