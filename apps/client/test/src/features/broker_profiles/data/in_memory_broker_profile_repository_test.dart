import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/in_memory_broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late InMemoryBrokerProfileRepository repository;

  setUp(() {
    repository = InMemoryBrokerProfileRepository();
  });

  BrokerProfile makeProfile({
    String id = 'p1',
    String displayName = 'Local Broker',
    String baseUrl = 'http://127.0.0.1:7734',
  }) {
    return BrokerProfile(
      id: id,
      displayName: displayName,
      baseUri: Uri.parse(baseUrl),
      createdAt: DateTime(2026, 6, 25),
    );
  }

  group('InMemoryBrokerProfileRepository', () {
    test('getAll returns empty list initially', () async {
      expect(await repository.getAll(), isEmpty);
    });

    test('save and getById', () async {
      final profile = makeProfile();
      await repository.save(profile);

      final retrieved = await repository.getById('p1');
      expect(retrieved, isNotNull);
      expect(retrieved!.id, 'p1');
      expect(retrieved.displayName, 'Local Broker');
    });

    test('save overwrites existing profile with same id', () async {
      final first = await repository.save(
        makeProfile(displayName: 'Old Name'),
      );
      final updated = await repository.save(
        first.copyWith(displayName: 'New Name'),
      );

      final retrieved = await repository.getById('p1');
      expect(retrieved!.displayName, 'New Name');
      expect(updated.incarnationId, first.incarnationId);
    });

    test('delete and re-add assigns a new incarnation', () async {
      final first = await repository.save(makeProfile());
      await repository.delete(
        id: first.id,
        incarnationId: first.incarnationId,
      );
      final replacement = await repository.save(makeProfile());

      expect(first.incarnationId, isNotNull);
      expect(replacement.incarnationId, isNot(first.incarnationId));
    });

    test('stale save and delete cannot mutate a replacement', () async {
      final first = await repository.save(makeProfile(displayName: 'A'));
      await repository.delete(
        id: first.id,
        incarnationId: first.incarnationId,
      );
      final replacement = await repository.save(
        makeProfile(displayName: 'B'),
      );

      await expectLater(
        repository.save(first.copyWith(displayName: 'stale A')),
        throwsA(isA<BrokerProfileRetiredException>()),
      );
      expect(
        await repository.delete(
          id: first.id,
          incarnationId: first.incarnationId,
        ),
        isFalse,
      );
      final durable = await repository.getById(first.id);
      expect(durable?.displayName, 'B');
      expect(durable?.incarnationId, replacement.incarnationId);
    });

    test('getAll returns profiles sorted by createdAt descending', () async {
      await repository.save(
        BrokerProfile(
          id: 'p1',
          displayName: 'First',
          baseUri: Uri.parse('http://127.0.0.1:7734'),
          createdAt: DateTime(2026, 6, 24),
        ),
      );
      await repository.save(
        BrokerProfile(
          id: 'p2',
          displayName: 'Second',
          baseUri: Uri.parse('http://127.0.0.1:7734'),
          createdAt: DateTime(2026, 6, 25),
        ),
      );

      final all = await repository.getAll();
      expect(all, hasLength(2));
      // Most recently created first.
      expect(all.first.id, 'p2');
    });

    test('getAll keeps used profiles before never-used profiles', () async {
      await repository.save(
        BrokerProfile(
          id: 'never-used',
          displayName: 'Never Used',
          baseUri: Uri.parse('http://127.0.0.1:7734'),
          createdAt: DateTime(2026, 7, 2),
        ),
      );
      await repository.save(
        BrokerProfile(
          id: 'used',
          displayName: 'Used',
          baseUri: Uri.parse('http://127.0.0.1:7734'),
          createdAt: DateTime(2026, 7),
          lastUsedAt: DateTime(2026, 7),
        ),
      );

      final all = await repository.getAll();

      expect(all.map((profile) => profile.id), ['used', 'never-used']);
    });

    test('delete removes profile', () async {
      await repository.save(makeProfile());

      final saved = await repository.getById('p1');
      final deleted = await repository.delete(
        id: 'p1',
        incarnationId: saved?.incarnationId,
      );
      expect(deleted, isTrue);
      expect(await repository.getById('p1'), isNull);
    });

    test('delete returns false for non-existent profile', () async {
      final deleted = await repository.delete(
        id: 'nonexistent',
        incarnationId: null,
      );
      expect(deleted, isFalse);
    });

    test('getById returns null for non-existent profile', () async {
      expect(await repository.getById('nonexistent'), isNull);
    });
  });
}
