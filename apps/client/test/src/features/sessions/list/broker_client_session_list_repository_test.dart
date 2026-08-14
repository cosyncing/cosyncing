import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/sessions.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

class MockBrokerClient extends Mock implements BrokerClient {}

void main() {
  late MockBrokerClient client;
  late BrokerClientSessionListRepository repository;

  setUp(() {
    client = MockBrokerClient();
    repository = BrokerClientSessionListRepository(brokerClient: client);
  });

  test('fetchSessions delegates with a conditional roster request', () async {
    when(
      () => client.listSessionsConditional(
        window: 'all',
      ),
    ).thenAnswer(
      (_) async => const ConditionalSessionListResult.modified(
        etag: 'W/"one"',
        response: ListSessionsResponse(
          machine: 'test-machine',
          revision: 4,
          sessions: [
            SessionInfo(
              id: 'session-1',
              tool: 'opencode',
              title: 'Test session',
              status: SessionStatus.idle,
              attachMode: AttachMode.live,
            ),
          ],
        ),
      ),
    );

    final response = await repository.fetchSessions();

    expect(response.machine, 'test-machine');
    expect(response.sessions, hasLength(1));
    expect(response.sessions.first.id, 'session-1');
    verify(
      () => client.listSessionsConditional(
        window: 'all',
      ),
    ).called(1);
  });

  test('304 reuses the last decoded roster without another body', () async {
    when(
      () => client.listSessionsConditional(
        window: 'all',
      ),
    ).thenAnswer(
      (_) async => const ConditionalSessionListResult.modified(
        etag: 'W/"one"',
        response: ListSessionsResponse(
          revision: 1,
          sessions: [
            SessionInfo(
              id: 'session-1',
              tool: 'codex',
              title: 'Cached',
              status: SessionStatus.idle,
              attachMode: AttachMode.observe,
            ),
          ],
        ),
      ),
    );
    when(
      () => client.listSessionsConditional(
        etag: 'W/"one"',
        window: 'all',
      ),
    ).thenAnswer(
      (_) async => const ConditionalSessionListResult.notModified(
        etag: 'W/"one"',
      ),
    );

    final first = await repository.fetchSessions();
    final second = await repository.fetchSessions();

    expect(identical(first, second), isTrue);
  });

  test('errors from BrokerClient propagate to caller', () async {
    when(
      () => client.listSessionsConditional(
        window: 'all',
      ),
    ).thenAnswer(
      (_) async => throw const BrokerException(
        message: 'session list failed',
        statusCode: 500,
      ),
    );

    await expectLater(
      repository.fetchSessions(),
      throwsA(isA<BrokerException>()),
    );
  });

  test('delta wait maps expected transport cancellation', () async {
    when(
      () => client.waitForSessionRosterDeltas(
        after: 7,
        wait: const Duration(seconds: 10),
        window: 'all',
      ),
    ).thenThrow(const RosterDeltaWaitCancelled());

    await expectLater(
      repository.waitForDeltas(after: 7, wait: const Duration(seconds: 10)),
      throwsA(isA<SessionRosterDeltaWaitCancelledException>()),
    );
  });

  test('delta wait maps a missing route to unsupported', () async {
    when(
      () => client.waitForSessionRosterDeltas(
        after: 7,
        wait: const Duration(seconds: 10),
        window: 'all',
      ),
    ).thenThrow(
      const BrokerException(message: 'not found', statusCode: 404),
    );

    await expectLater(
      repository.waitForDeltas(after: 7, wait: const Duration(seconds: 10)),
      throwsA(isA<SessionRosterDeltaFeedUnsupportedException>()),
    );
  });

  test('delta wait maps other broker failures to retryable', () async {
    when(
      () => client.waitForSessionRosterDeltas(
        after: 7,
        wait: const Duration(seconds: 10),
        window: 'all',
      ),
    ).thenThrow(
      const BrokerException(message: 'unavailable', statusCode: 503),
    );

    await expectLater(
      repository.waitForDeltas(after: 7, wait: const Duration(seconds: 10)),
      throwsA(
        isA<SessionRosterDeltaFeedRetryableException>().having(
          (error) => error.cause,
          'cause',
          isA<BrokerException>(),
        ),
      ),
    );
  });
}
