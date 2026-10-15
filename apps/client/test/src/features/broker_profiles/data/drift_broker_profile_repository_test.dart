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
