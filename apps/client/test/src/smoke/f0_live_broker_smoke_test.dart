import 'dart:io';

import 'package:broker_client/broker_client.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/url_normalizer.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final smokeConfig = _resolveBrokerConfigFromEnv(
    brokerUrlEnv: Platform.environment['COSYNCING_BROKER_URL'],
    rawToken: Platform.environment['COSYNCING_TOKEN'],
  );

  test(
    'live broker health endpoint responds with a successful result',
    () async {
      final client = _buildClient(
        brokerUrl: smokeConfig.brokerUrl!,
        token: smokeConfig.token,
      );
      try {
        final response = await client.getHealth();
        expect(response.ok, isTrue, reason: 'broker health reported failure');
        expect(
          response.machine,
          isNotEmpty,
          reason: 'broker response should include machine',
        );
      } finally {
        client.close();
      }
    },
    skip: smokeConfig.baseSkipReason,
  );

  test(
    'live broker listSessions endpoint responds with typed response',
    () async {
      final client = _buildClient(
        brokerUrl: smokeConfig.brokerUrl!,
        token: smokeConfig.token,
      );
      try {
        final response = await client.listSessions();
        expect(response.sessions, isNotNull);
      } finally {
        client.close();
      }
    },
    skip: smokeConfig.sessionListSkipReason,
  );

  group('broker URL validation', () {
    test('missing URL is skipped', () {
      final config = _resolveBrokerConfigFromEnv(
        brokerUrlEnv: null,
        rawToken: null,
      );

      expect(
        config.baseSkipReason,
        'Skipped: set COSYNCING_BROKER_URL to run this smoke test.',
      );
    });

    test('unsupported scheme is skipped', () {
      final config = _resolveBrokerConfigFromEnv(
        brokerUrlEnv: 'ftp://example.com',
        rawToken: null,
      );

      expect(
        config.baseSkipReason,
        'Skipped: COSYNCING_BROKER_URL is not a valid broker URL.',
      );
    });

    test('invalid uri is skipped', () {
      final config = _resolveBrokerConfigFromEnv(
        brokerUrlEnv: '://bad',
        rawToken: null,
      );

      expect(
        config.baseSkipReason,
        'Skipped: COSYNCING_BROKER_URL is not a valid broker URL.',
      );
    });

    test('missing host is skipped', () {
      final config = _resolveBrokerConfigFromEnv(
        brokerUrlEnv: 'http://',
        rawToken: null,
      );

      expect(
        config.baseSkipReason,
        'Skipped: COSYNCING_BROKER_URL is not a valid broker URL.',
      );
    });

    test('not-a-url is skipped as malformed broker URL', () {
      final config = _resolveBrokerConfigFromEnv(
        brokerUrlEnv: 'not-a-url',
        rawToken: null,
      );

      expect(
        config.baseSkipReason,
        'Skipped: COSYNCING_BROKER_URL is not a valid broker URL.',
      );
    });

    test('valid http URL passes base smoke check', () {
      final config = _resolveBrokerConfigFromEnv(
        brokerUrlEnv: 'http://127.0.0.1:7734',
        rawToken: null,
      );

      expect(config.baseSkipReason, isNull);
      expect(config.brokerUrl, 'http://127.0.0.1:7734');
    });
  });
}

BrokerClient _buildClient({
  required String brokerUrl,
  String? token,
}) {
  return BrokerClient(baseUrl: brokerUrl, token: token);
}

bool _isLoopbackHost(String host) {
  return host == 'localhost' || host == '127.0.0.1' || host == '::1';
}

class _BrokerSmokeConfig {
  _BrokerSmokeConfig({
    required this.brokerUrl,
    required this.token,
    required this.baseSkipReason,
    required this.sessionListSkipReason,
  });

  final String? brokerUrl;
  final String? token;
  final String? baseSkipReason;
  final String? sessionListSkipReason;
}

_BrokerSmokeConfig _resolveBrokerConfigFromEnv({
  required String? brokerUrlEnv,
  required String? rawToken,
}) {
  final token = (rawToken == null || rawToken.trim().isEmpty)
      ? null
      : rawToken.trim();

  final brokerUrl = _normalizeBrokerUrlFromEnv(brokerUrlEnv);
  if (brokerUrl == null) {
    return _BrokerSmokeConfig(
      brokerUrl: null,
      token: token,
      baseSkipReason: brokerUrlEnv == null || brokerUrlEnv.trim().isEmpty
          ? 'Skipped: set COSYNCING_BROKER_URL to run this smoke test.'
          : 'Skipped: COSYNCING_BROKER_URL is not a valid broker URL.',
      sessionListSkipReason: brokerUrlEnv == null || brokerUrlEnv.trim().isEmpty
          ? 'Skipped: set COSYNCING_BROKER_URL to run this smoke test.'
          : 'Skipped: COSYNCING_BROKER_URL is not a valid broker URL.',
    );
  }

  final isLoopback = _isLoopbackHost(Uri.parse(brokerUrl).host);
  final sessionListSkipReason = isLoopback || token != null
      ? null
      : 'Skipped: remote broker smoke listSessions requires COSYNCING_TOKEN.';

  return _BrokerSmokeConfig(
    brokerUrl: brokerUrl,
    token: token,
    baseSkipReason: null,
    sessionListSkipReason: sessionListSkipReason,
  );
}

String? _normalizeBrokerUrlFromEnv(String? rawInput) {
  final input = rawInput?.trim();
  if (input == null || input.isEmpty) {
    return null;
  }

  if (!input.startsWith('http://') && !input.startsWith('https://')) {
    return null;
  }

  try {
    final uri = normalizeBrokerUrl(input);
    if (validateBrokerUrl(uri).isNotEmpty) {
      return null;
    }
    return uri.toString();
  } on FormatException {
    return null;
  }
}
