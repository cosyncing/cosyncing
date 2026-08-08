import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/features/sessions/data/data.dart';
import 'package:drift/native.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('DriftSessionOutboxRepository', () {
    late AppDatabase database;
    late DriftSessionOutboxRepository repository;

    const sessionKey = SessionDetailKey(
      tool: 'claude',
      sessionId: 'session-1',
    );

    setUp(() {
      database = AppDatabase(NativeDatabase.memory());
      repository = DriftSessionOutboxRepository(database);
    });

    tearDown(() async {
      await database.close();
    });

    test('persists queued messages for a session', () async {
      final message = SessionOutboxMessage.create(
        sessionKey: sessionKey,
        brokerProfileId: 'profile-a',
        clientMessageId: 'ca.test.1',
        kind: SessionOutboxMessageKind.prompt,
        payload: const {'text': 'hello'},
      );

      await repository.upsert(message);

      final messages = await repository.loadForSession(sessionKey);
      expect(messages, hasLength(1));
      expect(messages.single.clientMessageId, 'ca.test.1');
      expect(messages.single.status, SessionOutboxMessageStatus.queued);
      expect(messages.single.payload, const {'text': 'hello'});
      expect(messages.single.brokerProfileId, 'profile-a');
    });

    test('automatic replay reads only the exact broker profile', () async {
      for (final profileId in ['profile-a', 'profile-b']) {
        await repository.upsert(
          SessionOutboxMessage.create(
            sessionKey: sessionKey,
            brokerProfileId: profileId,
            clientMessageId: 'ca.$profileId',
            kind: SessionOutboxMessageKind.prompt,
            payload: {'text': profileId},
          ),
        );
      }
      await repository.upsert(
        SessionOutboxMessage.create(
          sessionKey: sessionKey,
          clientMessageId: 'ca.legacy-unscoped',
          kind: SessionOutboxMessageKind.prompt,
          payload: const {'text': 'legacy'},
        ),
      );

      final messages = await repository.loadRetryableForSession(
        sessionKey,
        brokerProfileId: 'profile-a',
      );

      expect(messages.map((message) => message.clientMessageId), [
        'ca.profile-a',
      ]);
    });

    test('marks an acked message delivered', () async {
      final message = SessionOutboxMessage.create(
        sessionKey: sessionKey,
        clientMessageId: 'ca.test.2',
        kind: SessionOutboxMessageKind.command,
        payload: const {'name': '/status'},
      );
      await repository.upsert(message);

      await repository.markDelivered('ca.test.2');

      final messages = await repository.loadForSession(sessionKey);
      expect(messages.single.status, SessionOutboxMessageStatus.delivered);
    });

    test(
      'terminal broker receipt cannot regress into the replay set',
      () async {
        final message = SessionOutboxMessage.create(
          sessionKey: sessionKey,
          clientMessageId: 'ca.test.terminal',
          kind: SessionOutboxMessageKind.prompt,
          payload: const {'text': 'hello'},
        );
        await repository.upsert(message);
        await repository.markSending(message.clientMessageId);
        await repository.markDelivered(message.clientMessageId);

        // Simulate stale callbacks arriving after the broker receipt.
        await repository.markSending(message.clientMessageId);
        await repository.markRetryable(message.clientMessageId, 'late error');
        await repository.markFailed(message.clientMessageId, 'late nack');

        final stored = await repository.loadForSession(sessionKey);
        expect(stored.single.status, SessionOutboxMessageStatus.delivered);
        expect(stored.single.lastError, isNull);
        expect(stored.single.attemptCount, 1);
      },
    );

    test(
      'loads only retryable pending messages in short retry window',
      () async {
        final now = DateTime.now();
        await repository.upsert(
          SessionOutboxMessage(
            sessionKey: sessionKey,
            clientMessageId: 'ca.retry.1',
            kind: SessionOutboxMessageKind.prompt,
            payload: const {'text': 'retry me'},
            status: SessionOutboxMessageStatus.retryable,
            attemptCount: 1,
            createdAt: now.subtract(const Duration(seconds: 30)),
            updatedAt: now,
          ),
        );
        await repository.upsert(
          SessionOutboxMessage(
            sessionKey: sessionKey,
            clientMessageId: 'ca.retry.old',
            kind: SessionOutboxMessageKind.prompt,
            payload: const {'text': 'too old'},
            status: SessionOutboxMessageStatus.retryable,
            attemptCount: 1,
            createdAt: now.subtract(const Duration(minutes: 5)),
            updatedAt: now,
          ),
        );

        final retryable = await repository.loadRetryableForSession(
          sessionKey,
          now: now,
        );

        expect(
          retryable.map((message) => message.clientMessageId),
          ['ca.retry.1'],
        );
      },
    );
  });
}
