import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('brokerAttentionNotificationId', () {
    test('is stable for one profile and collapse key', () {
      final first = brokerAttentionNotificationId(
        brokerProfileId: 'profile-a',
        dedupeKey: 'session-outcome:codex:session-1',
      );
      final again = brokerAttentionNotificationId(
        brokerProfileId: ' profile-a ',
        dedupeKey: 'session-outcome:codex:session-1 ',
      );

      expect(first, again);
      expect(first, matches(RegExp(r'^attention-dedupe:[0-9a-f]{8}$')));
    });

    test('keeps identical keys apart across profiles', () {
      String id(String profile) => brokerAttentionNotificationId(
        brokerProfileId: profile,
        dedupeKey: 'session-outcome:codex:session-1',
      );

      expect(id('profile-a'), isNot(id('profile-b')));
    });

    test('rejects a blank profile or key', () {
      expect(
        () => brokerAttentionNotificationId(
          brokerProfileId: ' ',
          dedupeKey: 'key',
        ),
        throwsArgumentError,
      );
      expect(
        () => brokerAttentionNotificationId(
          brokerProfileId: 'profile',
          dedupeKey: '',
        ),
        throwsArgumentError,
      );
    });
  });

  group('BrokerNotificationRequest', () {
    test('freezes its payload', () {
      final source = <String, Object?>{'eventId': 'event-1'};
      final request = BrokerNotificationRequest(
        id: 'id',
        title: 'Turn finished',
        body: '',
        channel: _channel,
        playSound: false,
        payload: source,
        createdAt: DateTime.utc(2026, 9, 23),
      );
      source['eventId'] = 'changed';

      expect(request.payload['eventId'], 'event-1');
      expect(() => request.payload['x'] = 1, throwsUnsupportedError);
    });
  });

  group('BrokerNotificationDeliveryResult', () {
    test('only an unexpected failure is retryable', () {
      expect(BrokerNotificationDeliveryResult.shown.isRetryable, isFalse);
      for (final outcome in [
        BrokerNotificationDeliveryOutcome.blocked,
        BrokerNotificationDeliveryOutcome.unavailable,
      ]) {
        expect(BrokerNotificationDeliveryResult(outcome).isRetryable, isFalse);
      }
      expect(
        const BrokerNotificationDeliveryResult(
          BrokerNotificationDeliveryOutcome.failed,
        ).isRetryable,
        isTrue,
      );
    });
  });

  group('NoopBrokerNotificationSink', () {
    test('reports blocked because notifications are off', () async {
      final result = await const NoopBrokerNotificationSink().show(
        BrokerNotificationRequest(
          id: 'id',
          title: 'title',
          body: 'body',
          channel: _channel,
          playSound: true,
          payload: const {},
          createdAt: DateTime.utc(2026, 9, 23),
        ),
      );

      expect(result.outcome, BrokerNotificationDeliveryOutcome.blocked);
      expect(result.reason, 'disabled');
    });
  });
}

const _channel = BrokerNotificationChannel(
  id: 'cosy.v2.turnFinished',
  name: 'Turn finished',
  description: 'An agent finished its turn.',
  groupId: 'cosy.v2.sessions',
  defaultEnabled: true,
  defaultSound: false,
  urgent: false,
);
