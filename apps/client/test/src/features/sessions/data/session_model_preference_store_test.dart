import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_model_preference_store.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late AppDatabase database;
  late DriftSessionModelPreferenceStore store;

  setUp(() {
    database = AppDatabase(NativeDatabase.memory());
    store = DriftSessionModelPreferenceStore(database);
  });

  tearDown(() async => database.close());

  test('persists exact selections independently by broker lineage', () async {
    const firstKey = SessionModelPreferenceKey(
      brokerProfileId: 'local',
      tool: 'claude',
      lineageId: 'lineage-1',
    );
    const secondKey = SessionModelPreferenceKey(
      brokerProfileId: 'remote',
      tool: 'claude',
      lineageId: 'lineage-1',
    );
    const model = SessionCurrentModel(
      providerID: 'anthropic',
      modelID: 'claude-opus-4-6',
      reasoningEffort: 'max',
      variant: 'fable',
    );

    await store.save(firstKey, model);

    expect((await store.load(firstKey))?.toJson(), model.toJson());
    expect(await store.load(secondKey), isNull);
  });

  test('replaces and clears a saved selection', () async {
    const key = SessionModelPreferenceKey(
      brokerProfileId: 'local',
      tool: 'claude',
      lineageId: 'lineage-1',
    );
    await store.save(
      key,
      const SessionCurrentModel(
        providerID: 'openai',
        modelID: 'gpt-5.4',
        reasoningEffort: 'low',
      ),
    );
    await store.save(
      key,
      const SessionCurrentModel(
        providerID: 'anthropic',
        modelID: 'claude-opus-4-6',
        reasoningEffort: 'high',
      ),
    );

    expect((await store.load(key))?.modelID, 'claude-opus-4-6');
    await store.clear(key);
    expect(await store.load(key), isNull);
  });

  test('per-tool defaults persist independently of lineage rows', () async {
    const lineageKey = SessionModelPreferenceKey(
      brokerProfileId: 'local',
      tool: 'opencode',
      lineageId: 'lineage-1',
    );
    const model = SessionCurrentModel(
      providerID: 'LongCat',
      modelID: 'LongCat-2.0',
      variant: 'default',
    );

    await store.saveToolDefault(
      brokerProfileId: 'local',
      tool: 'opencode',
      model: model,
    );

    expect(
      (await store.loadToolDefault(
        brokerProfileId: 'local',
        tool: 'opencode',
      ))?.toJson(),
      model.toJson(),
    );
    // Scoped per tool AND broker, and never colliding with the lineage scope.
    expect(
      await store.loadToolDefault(brokerProfileId: 'local', tool: 'codex'),
      isNull,
    );
    expect(
      await store.loadToolDefault(brokerProfileId: 'remote', tool: 'opencode'),
      isNull,
    );
    expect(await store.load(lineageKey), isNull);

    await store.saveToolDefault(
      brokerProfileId: 'local',
      tool: 'opencode',
      model: const SessionCurrentModel(
        providerID: 'volcengine-plan',
        modelID: 'glm-5.2',
      ),
    );
    expect(
      (await store.loadToolDefault(
        brokerProfileId: 'local',
        tool: 'opencode',
      ))?.modelID,
      'glm-5.2',
    );
  });
}
