import 'package:cosyncing_client/src/features/pairing/model/pairing_payload.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('PairingPayload', () {
    test('parses JSON payload with brokerUrl', () {
      final payload = PairingPayload.parse(
        '{ "brokerUrl": "https://broker.example.com:9443", '
        '"token": "abc", '
        '"displayName": "Workstation" }',
      );

      expect(payload.brokerUrl.toString(), 'https://broker.example.com:9443');
      expect(payload.token, 'abc');
      expect(payload.displayName, 'Workstation');
    });

    test('parses JSON payload with baseUrl alias', () {
      final payload = PairingPayload.parse(
        '{ "baseUrl": "http://broker.example.com:9443", '
        '"displayName": "Home" }',
      );

      expect(payload.brokerUrl.toString(), 'http://broker.example.com:9443');
      expect(payload.displayName, 'Home');
      expect(payload.token, isNull);
    });

    test('parses JSON payload with url alias', () {
      final payload = PairingPayload.parse(
        '{ "url": "https://broker.example.com:9443", '
        '"token": "token-from-url-alias" }',
      );

      expect(payload.brokerUrl.toString(), 'https://broker.example.com:9443');
      expect(payload.token, 'token-from-url-alias');
    });

    test('parses cosyncing URI payload', () {
      final payload = PairingPayload.parse(
        'cosyncing://pair?brokerUrl=https%3A%2F%2Fbroker.example.com%3A9443&'
        'token=abc&displayName=Workstation',
      );

      expect(payload.brokerUrl.toString(), 'https://broker.example.com:9443');
      expect(payload.token, 'abc');
      expect(payload.displayName, 'Workstation');
    });

    test('parses plain URL payload', () {
      final payload = PairingPayload.parse('https://broker.example.com:9443');

      expect(payload.brokerUrl.toString(), 'https://broker.example.com:9443');
      expect(payload.token, isNull);
      expect(payload.displayName, isNull);
    });

    test('reports parse error for missing broker URL fields', () {
      expect(
        () => PairingPayload.parse('{ "token": "abc" }'),
        throwsA(isA<PairingPayloadParseException>()),
      );
    });

    test('reports parse error for malformed broker URL', () {
      expect(
        () => PairingPayload.parse('http://'),
        throwsA(
          isA<PairingPayloadParseException>().having(
            (error) => error.message,
            'message',
            contains('Invalid URL'),
          ),
        ),
      );
    });
  });
}
