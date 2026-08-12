import 'package:cosyncing_client/src/features/broker_profiles/model/url_normalizer.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('normalizeBrokerUrl', () {
    test('parses full HTTP URL', () {
      final uri = normalizeBrokerUrl('http://192.0.2.10:7734');
      expect(uri.scheme, 'http');
      expect(uri.host, '192.0.2.10');
      expect(uri.port, 7734);
    });

    test('parses full HTTPS URL', () {
      final uri = normalizeBrokerUrl('https://broker.example.com:443');
      expect(uri.scheme, 'https');
      expect(uri.host, 'broker.example.com');
      expect(uri.port, 443);
    });

    test('keeps a portless HTTPS server address exact', () {
      final uri = normalizeBrokerUrl('https://fixture.tailnet.ts.net');
      expect(uri.toString(), 'https://fixture.tailnet.ts.net');
      expect(uri.port, 443);
      expect(uri.hasPort, isFalse);
    });

    test('strips path from full URL', () {
      final uri = normalizeBrokerUrl('http://127.0.0.1:7734/api/health');
      expect(uri.path, isEmpty);
      expect(uri.host, '127.0.0.1');
      expect(uri.port, 7734);
    });

    test('strips query parameters from full URL', () {
      final uri = normalizeBrokerUrl('http://127.0.0.1:7734?token=abc');
      expect(uri.query, isEmpty);
      expect(uri.path, isEmpty);
      expect(uri.host, '127.0.0.1');
      expect(uri.port, 7734);
    });

    test('strips fragment from full URL', () {
      final uri = normalizeBrokerUrl('http://127.0.0.1:7734#section');
      expect(uri.fragment, isEmpty);
      expect(uri.path, isEmpty);
      expect(uri.host, '127.0.0.1');
      expect(uri.port, 7734);
    });

    test('strips path, query, and fragment from pasted health URL', () {
      final uri = normalizeBrokerUrl('http://host:7734/api/health?x=1#y');
      expect(uri.toString(), 'http://host:7734');
      expect(uri.path, isEmpty);
      expect(uri.query, isEmpty);
      expect(uri.fragment, isEmpty);
      expect(uri.host, 'host');
      expect(uri.port, 7734);
    });

    test('defaults port for URL without explicit port', () {
      final uri = normalizeBrokerUrl('http://127.0.0.1');
      expect(uri.port, 7734);
    });

    test('parses host:port format', () {
      final uri = normalizeBrokerUrl('192.168.1.10:8080');
      expect(uri.scheme, 'http');
      expect(uri.host, '192.168.1.10');
      expect(uri.port, 8080);
    });

    test('parses bare host with default port', () {
      final uri = normalizeBrokerUrl('192.168.1.10');
      expect(uri.scheme, 'http');
      expect(uri.host, '192.168.1.10');
      expect(uri.port, 7734);
    });

    test('handles localhost shorthand', () {
      final uri = normalizeBrokerUrl('localhost');
      expect(uri.scheme, 'http');
      expect(uri.host, '127.0.0.1');
      expect(uri.port, 7734);
    });

    test('handles 127.0.0.1 shorthand', () {
      final uri = normalizeBrokerUrl('127.0.0.1');
      expect(uri.scheme, 'http');
      expect(uri.host, '127.0.0.1');
      expect(uri.port, 7734);
    });

    test('trims whitespace', () {
      final uri = normalizeBrokerUrl('  http://127.0.0.1:7734  ');
      expect(uri.host, '127.0.0.1');
      expect(uri.port, 7734);
    });

    test('throws on empty input', () {
      expect(() => normalizeBrokerUrl(''), throwsFormatException);
      expect(() => normalizeBrokerUrl('   '), throwsFormatException);
    });

    test('throws on URL with no host', () {
      expect(() => normalizeBrokerUrl('http://'), throwsFormatException);
    });
  });

  group('brokerBaseFromOrigin', () {
    test('derives origin from an http page URL with explicit port', () {
      final origin = brokerBaseFromOrigin(
        Uri.parse('http://127.0.0.1:7734/cosy/index.html'),
      );
      expect(origin.toString(), 'http://127.0.0.1:7734');
      expect(origin.scheme, 'http');
      expect(origin.host, '127.0.0.1');
      expect(origin.port, 7734);
    });

    test('preserves https scheme and keeps default port implicit', () {
      final origin = brokerBaseFromOrigin(
        Uri.parse('https://example.com/cosy/deep/route'),
      );
      // Portless origin stays portless so WS derivation is wss://host (443),
      // not wss://host:7734.
      expect(origin.toString(), 'https://example.com');
      expect(origin.scheme, 'https');
    });

    test('preserves a non-default explicit https port', () {
      final origin = brokerBaseFromOrigin(
        Uri.parse('https://example.com:8443/cosy/'),
      );
      expect(origin.toString(), 'https://example.com:8443');
      expect(origin.port, 8443);
    });

    test('does NOT force the default broker port for portless input', () {
      final origin = brokerBaseFromOrigin(
        Uri.parse('http://example.com/cosy/'),
      );
      expect(origin.toString(), 'http://example.com');
    });
  });

  group('validateBrokerUrl', () {
    test('returns empty list for valid URL', () {
      final uri = Uri.parse('http://127.0.0.1:7734');
      expect(validateBrokerUrl(uri), isEmpty);
    });

    test('reports empty host', () {
      final uri = Uri(scheme: 'http', host: '', port: 7734);
      final errors = validateBrokerUrl(uri);
      expect(errors, contains('Host is required'));
    });

    test('reports invalid port', () {
      final uri = Uri(scheme: 'http', host: '127.0.0.1', port: 0);
      final errors = validateBrokerUrl(uri);
      expect(errors, contains('Port must be between 1 and 65535'));
    });

    test('reports port too high', () {
      final uri = Uri(scheme: 'http', host: '127.0.0.1', port: 70000);
      final errors = validateBrokerUrl(uri);
      expect(errors, contains('Port must be between 1 and 65535'));
    });

    test('reports invalid scheme', () {
      final uri = Uri(scheme: 'ftp', host: '127.0.0.1', port: 7734);
      final errors = validateBrokerUrl(uri);
      expect(errors, contains('Scheme must be http or https'));
    });

    test('accepts https scheme', () {
      final uri = Uri.parse('https://broker.example.com:443');
      expect(validateBrokerUrl(uri), isEmpty);
    });
  });
}
