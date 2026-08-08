import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/drift_broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('DriftBrokerProfileRepository', () {
    late AppDatabase database;
    late DriftBrokerProfileRepository repository;

    setUp(() {
      database = AppDatabase(NativeDatabase.memory());
      repository = DriftBrokerProfileRepository(database);
    });

    tearDown(() async {
      await database.close();
    });

    test('getAll returns empty list initially', () async {
      expect(await repository.getAll(), isEmpty);
    });

    test('persists and loads profiles by id', () async {
      final profile = _profile(
        id: 'remote',
        displayName: 'Remote Broker',
        baseUri: Uri.parse('https://broker.example.com:9443'),
        credentialKey: 'broker-token:remote',
      );

      await repository.save(profile);

      final loaded = await repository.getById('remote');

      expect(loaded, isNotNull);
      expect(loaded!.id, 'remote');
      expect(loaded.displayName, 'Remote Broker');
      expect(loaded.baseUri, Uri.parse('https://broker.example.com:9443'));
      expect(loaded.createdAt, DateTime(2026, 7));
      expect(loaded.updatedAt, DateTime(2026, 7, 1, 12));
      expect(loaded.lastUsedAt, DateTime(2026, 7, 1, 13));
      expect(loaded.credentialKey, 'broker-token:remote');
    });

    test('save replaces existing profile row', () async {
      final first = await repository.save(_profile(displayName: 'Old Name'));
      final updated = await repository.save(
        first.copyWith(
          displayName: 'New Name',
          baseUri: Uri.parse('http://localhost:7734'),
          updatedAt: DateTime(2026, 7, 2),
        ),
      );

      final profiles = await repository.getAll();

      expect(profiles, hasLength(1));
      expect(profiles.single.displayName, 'New Name');
      expect(profiles.single.baseUri, Uri.parse('http://localhost:7734'));
      expect(profiles.single.updatedAt, DateTime(2026, 7, 2));
      expect(updated.incarnationId, first.incarnationId);
      expect(profiles.single.incarnationId, first.incarnationId);
    });

    test('delete and re-add assigns a new incarnation', () async {
      final first = await repository.save(_profile());
      await repository.delete(
        id: first.id,
        incarnationId: first.incarnationId,
      );
      final replacement = await repository.save(_profile());

      expect(first.incarnationId, isNotNull);
      expect(replacement.incarnationId, isNot(first.incarnationId));
    });

    test('stale save cannot overwrite a replacement incarnation', () async {
      final first = await repository.save(
        _profile(
          displayName: 'Incarnation A',
          baseUri: Uri.parse('http://alpha.test:7734'),
        ),
      );
      await repository.delete(
        id: first.id,
        incarnationId: first.incarnationId,
      );
      final replacement = await repository.save(
        _profile(
          displayName: 'Incarnation B',
          baseUri: Uri.parse('http://beta.test:7734'),
        ),
      );

      await expectLater(
        repository.save(
          first.copyWith(
            displayName: 'Stale A',
            baseUri: Uri.parse('http://stale-alpha.test:7734'),
          ),
        ),
        throwsA(isA<BrokerProfileRetiredException>()),
      );

      final durable = await repository.getById(first.id);
      expect(durable?.incarnationId, replacement.incarnationId);
      expect(durable?.displayName, 'Incarnation B');
      expect(durable?.baseUri.host, 'beta.test');
    });

    test('stale delete cannot remove a replacement incarnation', () async {
      final first = await repository.save(_profile());
      await repository.delete(
        id: first.id,
        incarnationId: first.incarnationId,
      );
      final replacement = await repository.save(_profile());

      expect(
        await repository.delete(
          id: first.id,
          incarnationId: first.incarnationId,
        ),
        isFalse,
      );
      expect(
        (await repository.getById(first.id))?.incarnationId,
        replacement.incarnationId,
      );
    });

    test('getAll sorts by lastUsedAt then createdAt descending', () async {
      await repository.save(
        _profile(
          id: 'older-created',
          displayName: 'Older Created',
          createdAt: DateTime(2026, 7),
          omitLastUsedAt: true,
        ),
      );
      await repository.save(
        _profile(
          id: 'newer-created',
          displayName: 'Newer Created',
          createdAt: DateTime(2026, 7, 2),
          omitLastUsedAt: true,
        ),
      );
      await repository.save(
        _profile(
          id: 'used-yesterday',
          displayName: 'Used Yesterday',
          createdAt: DateTime(2026, 7),
          lastUsedAt: DateTime(2026, 7, 1, 14),
        ),
      );
      await repository.save(
        _profile(
          id: 'used-today',
          displayName: 'Used Today',
          createdAt: DateTime(2026, 7),
          lastUsedAt: DateTime(2026, 7, 2, 9),
        ),
      );

      final profiles = await repository.getAll();

      expect(profiles.map((profile) => profile.id), [
        'used-today',
        'used-yesterday',
        'newer-created',
        'older-created',
      ]);
    });

    test('delete removes profile and reports whether a row existed', () async {
      final saved = await repository.save(_profile(id: 'delete-me'));

      expect(
        await repository.delete(
          id: 'delete-me',
          incarnationId: saved.incarnationId,
        ),
        isTrue,
      );
      expect(
        await repository.delete(
          id: 'delete-me',
          incarnationId: saved.incarnationId,
        ),
        isFalse,
      );
      expect(await repository.getById('delete-me'), isNull);
    });
  });
}

BrokerProfile _profile({
  String id = 'local',
  String displayName = 'Local Broker',
  Uri? baseUri,
  DateTime? createdAt,
  DateTime? updatedAt,
  DateTime? lastUsedAt,
  bool omitLastUsedAt = false,
  String? credentialKey,
}) {
  return BrokerProfile(
    id: id,
    displayName: displayName,
    baseUri: baseUri ?? Uri.parse('http://127.0.0.1:7734'),
    createdAt: createdAt ?? DateTime(2026, 7),
    updatedAt: updatedAt ?? DateTime(2026, 7, 1, 12),
    lastUsedAt: omitLastUsedAt ? null : lastUsedAt ?? DateTime(2026, 7, 1, 13),
    credentialKey: credentialKey,
  );
}
