import 'package:cosyncing_client/src/features/connection/model/same_origin_broker_profile.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('sameOriginBrokerProfile', () {
    test('builds a profile from an http origin with explicit port', () {
      final profile = sameOriginBrokerProfile(
        base: Uri.parse('http://127.0.0.1:7734/cosy/index.html'),
        now: DateTime(2026, 7, 7),
      );

      expect(profile.id, 'http://127.0.0.1:7734');
      expect(profile.baseUri, Uri.parse('http://127.0.0.1:7734'));
      expect(profile.baseUri.scheme, 'http');
      expect(profile.baseUri.port, 7734);
      expect(profile.displayName, sameOriginBrokerDisplayName);
      expect(profile.credentialKey, isNull);
      expect(profile.createdAt, DateTime(2026, 7, 7));
    });

    test('builds an https profile with the port left implicit', () {
      final profile = sameOriginBrokerProfile(
        base: Uri.parse('https://broker.example.com/cosy/'),
      );

      // Portless https origin must stay portless so the derived WebSocket URL
      // is wss://host (implicit 443), not wss://host:7734.
      expect(profile.baseUri.toString(), 'https://broker.example.com');
      expect(profile.baseUri.scheme, 'https');
      expect(profile.id, 'https://broker.example.com');
    });

    test('preserves a non-default explicit https port', () {
      final profile = sameOriginBrokerProfile(
        base: Uri.parse('https://broker.example.com:8443/cosy/x'),
      );

      expect(profile.baseUri.toString(), 'https://broker.example.com:8443');
      expect(profile.baseUri.port, 8443);
    });
  });

  group('isAttachableOrigin', () {
    test('accepts http and https origins', () {
      expect(
        isAttachableOrigin(Uri.parse('http://127.0.0.1:7734/cosy/')),
        true,
      );
      expect(isAttachableOrigin(Uri.parse('https://example.com/cosy/')), true);
    });

    test('rejects non-http(s) schemes', () {
      expect(
        isAttachableOrigin(Uri.parse('file:///tmp/cosy/index.html')),
        false,
      );
      expect(isAttachableOrigin(Uri.parse('about:blank')), false);
    });

    test('rejects an empty host', () {
      expect(isAttachableOrigin(Uri.parse('http:///cosy/')), false);
    });
  });
}
