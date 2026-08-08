import 'package:broker_contract/broker_contract.dart';
import 'package:test/test.dart';

void main() {
  group('PushWakeTokenRegistrationRequest', () {
    test('serializes required platform and token', () {
      const request = PushWakeTokenRegistrationRequest(
        platform: 'fcm',
        token: 'raw-token',
      );

      final json = request.toJson();
      expect(json, equals({'platform': 'fcm', 'token': 'raw-token'}));
    });

    test('omits empty optional fields from payload', () {
      const request = PushWakeTokenRegistrationRequest(
        deviceId: 'device-id',
        platform: 'apns',
        token: 'raw-token',
        label: 'phone',
      );

      expect(
        request.toJson(),
        equals({
          'deviceId': 'device-id',
          'platform': 'apns',
          'token': 'raw-token',
          'label': 'phone',
        }),
      );
    });

    test('deserializes from JSON payload', () {
      final request = PushWakeTokenRegistrationRequest.fromJson({
        'deviceId': 'device-id',
        'platform': 'fcm',
        'token': 'raw-token',
        'label': 'label',
      });

      expect(request.deviceId, 'device-id');
      expect(request.platform, 'fcm');
      expect(request.token, 'raw-token');
      expect(request.label, 'label');
    });
  });

  group('PushWakeTokenRegistrationResponse', () {
    test('deserializes registration payload', () {
      final response = PushWakeTokenRegistrationResponse.fromJson({
        'ok': true,
        'registration': {
          'deviceId': 'device-id',
          'platform': 'fcm',
          'tokenPreview': 'appl...abcd',
          'label': 'phone',
          'createdAt': '2026-07-11T19:00:00.000Z',
          'updatedAt': '2026-07-11T19:01:00.000Z',
        },
      });

      expect(response.ok, isTrue);
      expect(response.registration.deviceId, 'device-id');
      expect(response.registration.platform, 'fcm');
      expect(response.registration.tokenPreview, 'appl...abcd');
      expect(response.registration.createdAt, '2026-07-11T19:00:00.000Z');
      expect(response.registration.updatedAt, '2026-07-11T19:01:00.000Z');
      expect(response.registration.label, 'phone');
      expect(response.registration.toJson(), isNot(contains('token')));
    });

    test('uses a safe fallback when registration is missing', () {
      final response = PushWakeTokenRegistrationResponse.fromJson({'ok': true});

      expect(response.registration.deviceId, isEmpty);
      expect(response.registration.tokenPreview, isEmpty);
      expect(response.ok, isTrue);
    });
  });

  group('PushWakeTokenListResponse', () {
    test('deserializes and omits raw token in list model', () {
      final response = PushWakeTokenListResponse.fromJson({
        'ok': true,
        'registrations': [
          {
            'deviceId': 'device-id',
            'platform': 'fcm',
            'token': 'super-secret-token',
            'tokenPreview': 'fcm...ABCD',
            'createdAt': '2026-07-11T19:00:00.000Z',
            'updatedAt': '2026-07-11T19:00:01.000Z',
          },
        ],
      });

      expect(response.ok, isTrue);
      expect(response.registrations, hasLength(1));
      final registration = response.registrations.first;
      expect(registration.deviceId, 'device-id');
      expect(registration.platform, 'fcm');
      expect(registration.tokenPreview, 'fcm...ABCD');
      expect(registration.toJson(), isNot(contains('token')));
      expect(registration.toString(), isNot(contains('super-secret-token')));
    });

    test('serializes empty payload without registrations', () {
      final response = PushWakeTokenListResponse.fromJson({
        'ok': true,
        'registrations': <Map<String, dynamic>>[],
      });

      expect(response.ok, isTrue);
      expect(response.registrations, isEmpty);
      expect(
        response.toJson(),
        equals(<String, dynamic>{'ok': true, 'registrations': <Object>[]}),
      );
    });
  });

  group('PushWakeTokenRevokeResponse', () {
    test('deserializes revoke response', () {
      final response = PushWakeTokenRevokeResponse.fromJson({
        'ok': true,
        'revoked': true,
      });

      expect(response.ok, isTrue);
      expect(response.revoked, isTrue);
      expect(response.toJson()['revoked'], isTrue);
    });
  });
}
