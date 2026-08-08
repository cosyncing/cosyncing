import 'dart:async';

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('classifyFailure', () {
    test('a BrokerException with no status never reached the broker', () {
      // BrokerClient funnels connection refused, DNS failure, TLS failure and
      // timeouts into a BrokerException with a null statusCode. That is the
      // property the whole "offline" classification rests on.
      expect(
        classifyFailure(const BrokerException(message: 'connection refused')),
        FailureKind.offline,
      );
    });

    test('401 and 403 are credential problems', () {
      for (final status in [401, 403]) {
        expect(
          classifyFailure(
            BrokerException(message: 'nope', statusCode: status),
          ),
          FailureKind.unauthorized,
          reason: 'status $status',
        );
      }
    });

    test('other 4xx are request rejections', () {
      expect(
        classifyFailure(const BrokerException(message: 'bad', statusCode: 400)),
        FailureKind.rejected,
      );
    });

    test('5xx is a broker-side fault', () {
      expect(
        classifyFailure(
          const BrokerException(message: 'boom', statusCode: 503),
        ),
        FailureKind.brokerFault,
      );
    });

    test('a timeout is treated as offline', () {
      expect(classifyFailure(TimeoutException('slow')), FailureKind.offline);
    });

    test('a missing platform plugin is a device storage failure', () {
      expect(
        classifyFailure(const MissingPluginExceptionForTest()),
        FailureKind.deviceStorage,
      );
    });

    test('an unrecognized error stays unknown rather than guessing', () {
      expect(classifyFailure(StateError('whatever')), FailureKind.unknown);
    });
  });

  group('failureDetail', () {
    test('prefers the broker structured error and keeps code and status', () {
      const error = BrokerException(
        message: 'fallback message',
        statusCode: 409,
        error: BrokerError(error: 'schedule changed', code: 'STALE'),
      );

      final detail = failureDetail(error);

      expect(detail, contains('schedule changed'));
      expect(detail, contains('STALE'));
      expect(detail, contains('409'));
    });

    test('falls back to toString for non-broker errors', () {
      expect(failureDetail(StateError('disk on fire')), contains('disk'));
    });

    test('bounds oversized broker bodies once and is idempotent', () {
      final oversized = 'broker-body:${'x' * 5000}:unbounded-tail';
      final detail = failureDetail(
        BrokerException(
          message: 'fallback',
          statusCode: 500,
          error: BrokerError(error: oversized, code: 'BROKER_FAILURE'),
        ),
      );

      expect(detail.length, maxTechnicalDetailLength);
      expect(detail, endsWith('…'));
      expect(detail, isNot(contains('unbounded-tail')));
      expect(boundedTechnicalDetail(detail), detail);
    });
  });

  group('describeFailure', () {
    test('message names the operation and the next step', () {
      final described = describeFailure(
        const BrokerException(message: 'connection refused'),
        lead: "Couldn't save the token.",
      );

      expect(described.message, startsWith("Couldn't save the token."));
      expect(described.message, contains('try again'));
    });

    test('never puts the raw exception in the message', () {
      // The whole point of the module: the diagnostic stays retrievable, but
      // out of the sentence a user reads.
      final described = describeFailure(
        StateError('PlatformChannel#42 blew up'),
        lead: "Couldn't sign out.",
      );

      expect(described.message, isNot(contains('PlatformChannel#42')));
      expect(described.message, isNot(contains('Bad state')));
      expect(described.detail, contains('PlatformChannel#42'));
    });

    test('advice differs by failure kind rather than being generic', () {
      final offline = describeFailure(
        const BrokerException(message: 'refused'),
        lead: 'Lead.',
      ).message;
      final unauthorized = describeFailure(
        const BrokerException(message: 'nope', statusCode: 401),
        lead: 'Lead.',
      ).message;

      expect(offline, isNot(unauthorized));
    });

    test('every kind produces advice that tells the user what to do', () {
      for (final kind in FailureKind.values) {
        final advice = recoveryAdviceEn(kind);
        expect(advice, isNotEmpty, reason: '$kind');
        expect(
          advice.toLowerCase(),
          anyOf(
            contains('try again'),
            contains('pair'),
            contains('restart'),
          ),
          reason: '$kind must offer a next step',
        );
      }
    });
  });
}

class MissingPluginExceptionForTest implements Exception {
  const MissingPluginExceptionForTest();
}
