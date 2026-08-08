import 'package:broker_contract/broker_contract.dart';
import 'package:test/test.dart';

void main() {
  group('BrokerError with code', () {
    test('fromJson parses error message', () {
      final json = {'error': 'session not found'};
      final error = BrokerError.fromJson(json);
      expect(error.error, 'session not found');
    });

    test('toJson serializes error message', () {
      const error = BrokerError(error: 'session not found');
      final json = error.toJson();
      expect(json['error'], 'session not found');
    });

    test('roundtrip serialization', () {
      const error = BrokerError(error: 'test error');
      final json = error.toJson();
      final restored = BrokerError.fromJson(json);
      expect(restored.error, error.error);
    });
  });

  group('BrokerException', () {
    test('toString includes message', () {
      const exception = BrokerException(message: 'request failed');
      expect(exception.toString(), contains('request failed'));
    });

    test('toString includes status code', () {
      const exception = BrokerException(
        message: 'not found',
        statusCode: 404,
      );
      expect(exception.toString(), contains('404'));
    });

    test('toString includes broker error', () {
      const exception = BrokerException(
        message: 'bad request',
        statusCode: 400,
        error: BrokerError(error: 'invalid tool'),
      );
      expect(exception.toString(), contains('invalid tool'));
    });

    test('toString includes broker error code', () {
      const exception = BrokerException(
        message: 'bad request',
        statusCode: 400,
        error: BrokerError(
          error: 'invalid tool',
          code: 'BAD_PARAM',
        ),
      );
      expect(exception.toString(), contains('BAD_PARAM'));
    });
  });

  group('BrokerError', () {
    test('fromJson parses error and code', () {
      final json = {'error': 'transcript export failed', 'code': 'R2_DISABLED'};
      final error = BrokerError.fromJson(json);
      expect(error.error, 'transcript export failed');
      expect(error.code, 'R2_DISABLED');
    });

    test('toJson includes code when set', () {
      const error = BrokerError(
        error: 'transcript export failed',
        code: 'BAD_PARAM',
      );
      final json = error.toJson();
      expect(json['error'], 'transcript export failed');
      expect(json['code'], 'BAD_PARAM');
    });
  });
}
