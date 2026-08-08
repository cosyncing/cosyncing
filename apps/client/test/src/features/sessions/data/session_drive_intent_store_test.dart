import 'package:cosyncing_client/src/features/sessions/data/session_drive_intent_store.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('DriftSessionDriveIntentStore', () {
    late AppDatabase database;
    late DateTime now;
    late DriftSessionDriveIntentStore store;

    setUp(() {
      database = AppDatabase(NativeDatabase.memory());
      now = DateTime.utc(2026, 7, 15, 12);
      store = DriftSessionDriveIntentStore(database, now: () => now);
    });

    tearDown(() async {
      await database.close();
    });

    Future<SessionDriveProvenance?> read({
      String brokerProfileId = 'local',
      String tool = 'claude',
      String sessionId = 'session-1',
    }) => store.read(
      brokerProfileId: brokerProfileId,
      tool: tool,
      sessionId: sessionId,
    );

    test('defaults to Observe without recorded provenance', () async {
      expect(await read(), isNull);
    });

    test('takeover lease stays valid through the 30 minute boundary', () async {
      await store.rememberTakeover(
        brokerProfileId: 'local',
        tool: 'claude',
        sessionId: 'session-1',
      );
      now = now.add(sessionDriveIntentTtl);

      final provenance = await read();
      expect(
        provenance?.kind,
        SessionDriveProvenanceKind.terminalTakeover,
      );
    });

    test('expires and removes a stale takeover lease', () async {
      await store.rememberTakeover(
        brokerProfileId: 'local',
        tool: 'claude',
        sessionId: 'session-1',
      );
      now = now.add(sessionDriveIntentTtl + const Duration(milliseconds: 1));

      expect(await read(), isNull);
      // The expired row was deleted; winding the clock back cannot revive it.
      now = now.subtract(sessionDriveIntentTtl);
      expect(await read(), isNull);
    });

    test('app-created provenance survives far beyond 30 minutes', () async {
      await store.rememberAppCreated(
        brokerProfileId: 'local',
        tool: 'codex',
        sessionId: 'session-1',
      );
      now = now.add(const Duration(days: 3));

      final provenance = await read(tool: 'codex');
      expect(provenance?.kind, SessionDriveProvenanceKind.appCreated);
    });

    test('takeover refresh never downgrades app-created provenance', () async {
      await store.rememberAppCreated(
        brokerProfileId: 'local',
        tool: 'codex',
        sessionId: 'session-1',
      );
      // A later successful Drive attach routes through the lease refresh.
      await store.rememberTakeover(
        brokerProfileId: 'local',
        tool: 'codex',
        sessionId: 'session-1',
      );
      now = now.add(const Duration(hours: 2));

      final provenance = await read(tool: 'codex');
      expect(provenance?.kind, SessionDriveProvenanceKind.appCreated);
    });

    test('takeover lease slides on refresh', () async {
      await store.rememberTakeover(
        brokerProfileId: 'local',
        tool: 'claude',
        sessionId: 'session-1',
      );
      now = now.add(const Duration(minutes: 20));
      await store.rememberTakeover(
        brokerProfileId: 'local',
        tool: 'claude',
        sessionId: 'session-1',
      );
      now = now.add(const Duration(minutes: 20));

      final provenance = await read();
      expect(
        provenance?.kind,
        SessionDriveProvenanceKind.terminalTakeover,
      );
    });

    test('legacy epoch-ms records read as a takeover lease', () async {
      await database
          .into(database.appSettingRows)
          .insertOnConflictUpdate(
            AppSettingRowsCompanion.insert(
              key: 'session_driving_intent:local:claude:session-1',
              value: '${now.millisecondsSinceEpoch}',
              updatedAt: now,
            ),
          );
      final fresh = await read();
      expect(fresh?.kind, SessionDriveProvenanceKind.terminalTakeover);

      now = now.add(sessionDriveIntentTtl + const Duration(milliseconds: 1));
      expect(await read(), isNull);
    });

    test('clear removes only the selected encoded session key', () async {
      await store.rememberTakeover(
        brokerProfileId: 'local',
        tool: 'claude/glm',
        sessionId: 'session:1',
      );
      await store.rememberTakeover(
        brokerProfileId: 'local',
        tool: 'claude',
        sessionId: 'glm/session:1',
      );

      await store.clear(
        brokerProfileId: 'local',
        tool: 'claude/glm',
        sessionId: 'session:1',
      );

      expect(
        await read(tool: 'claude/glm', sessionId: 'session:1'),
        isNull,
      );
      expect(
        await read(sessionId: 'glm/session:1'),
        isNotNull,
      );
    });

    test('same session identity remains isolated per broker profile', () async {
      await store.rememberAppCreated(
        brokerProfileId: 'broker-a',
        tool: 'claude',
        sessionId: 'shared-id',
      );

      expect(
        await read(brokerProfileId: 'broker-b', sessionId: 'shared-id'),
        isNull,
      );
      expect(
        await read(brokerProfileId: 'broker-a', sessionId: 'shared-id'),
        isNotNull,
      );
    });
  });
}
