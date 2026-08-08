import 'dart:io';

import 'package:broker_client/broker_client.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/url_normalizer.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final smokeConfig = _resolveSessionAttachSmokeConfig(
    brokerUrlEnv: Platform.environment['COSYNCING_BROKER_URL'],
    rawToken: Platform.environment['COSYNCING_TOKEN'],
    rawSmokeTool: Platform.environment['COSYNCING_SMOKE_TOOL'],
    rawSmokeSessionId: Platform.environment['COSYNCING_SMOKE_SESSION_ID'],
    rawTimeoutSeconds:
        Platform.environment['COSYNCING_ATTACH_SMOKE_TIMEOUT_SECONDS'],
  );

  test(
    'live broker session attach smoke connects in read-only mode',
    () async {
      final client = _buildBrokerClient(
        brokerUrl: smokeConfig.brokerUrl!,
        token: smokeConfig.token,
      );

      try {
        final sessionSelection = await _resolveSessionSelection(
          client: client,
          explicitTool: smokeConfig.explicitTool,
          explicitSessionId: smokeConfig.explicitSessionId,
        );

        final skipReason = sessionSelection.skipReason;
        if (skipReason != null) {
          // The test is considered intentionally skipped-by-config.
          expect(true, isTrue, reason: skipReason);
          return;
        }

        final resolver = EndpointResolver(
          baseUrl: smokeConfig.brokerUrl!,
          token: smokeConfig.token,
        );
        final connection = SessionConnection(
          resolver: resolver,
          tool: sessionSelection.tool!,
          sessionId: sessionSelection.sessionId!,
        );

        try {
          final attachResult = await _waitForSessionAttachSignal(
            connection: connection,
            timeout: smokeConfig.attachTimeout,
          );

          expect(
            attachResult.hasProtocolSignal,
            isTrue,
            reason:
                attachResult.failureReason ??
                'Expected session attach to emit broker protocol data.',
          );
          expect(
            attachResult.note,
            contains('smoke'),
          );
        } finally {
          // Prevent reconnect timers from extending test runtime.
          await connection.close();
          await connection.dispose();
        }
      } finally {
        client.close();
      }
    },
    skip: smokeConfig.baseSkipReason,
  );

  group('session attach smoke config parsing', () {
    test('missing URL is skipped', () {
      final config = _resolveSessionAttachSmokeConfig(
        brokerUrlEnv: null,
        rawToken: null,
        rawSmokeTool: null,
        rawSmokeSessionId: null,
        rawTimeoutSeconds: null,
      );

      expect(
        config.baseSkipReason,
        'Skipped: set COSYNCING_BROKER_URL to run this smoke test.',
      );
    });

    test('invalid URL is skipped', () {
      final config = _resolveSessionAttachSmokeConfig(
        brokerUrlEnv: '://bad',
        rawToken: null,
        rawSmokeTool: null,
        rawSmokeSessionId: null,
        rawTimeoutSeconds: null,
      );

      expect(
        config.baseSkipReason,
        'Skipped: COSYNCING_BROKER_URL is not a valid broker URL.',
      );
    });

    test('non-loopback brokers require token', () {
      final config = _resolveSessionAttachSmokeConfig(
        brokerUrlEnv: 'https://example.com',
        rawToken: null,
        rawSmokeTool: null,
        rawSmokeSessionId: null,
        rawTimeoutSeconds: null,
      );

      expect(
        config.baseSkipReason,
        'Skipped: remote broker smoke attach requires COSYNCING_TOKEN.',
      );
    });

    test('one-side explicit session selector is skipped with guidance', () {
      final config = _resolveSessionAttachSmokeConfig(
        brokerUrlEnv: 'http://127.0.0.1:7734',
        rawToken: null,
        rawSmokeTool: 'opencode',
        rawSmokeSessionId: null,
        rawTimeoutSeconds: null,
      );

      expect(
        config.baseSkipReason,
        'Skipped: both COSYNCING_SMOKE_TOOL and COSYNCING_SMOKE_SESSION_ID '
        'must be set together.',
      );
    });

    test('default timeout is 10 seconds', () {
      final config = _resolveSessionAttachSmokeConfig(
        brokerUrlEnv: 'http://127.0.0.1:7734',
        rawToken: null,
        rawSmokeTool: null,
        rawSmokeSessionId: null,
        rawTimeoutSeconds: null,
      );

      expect(config.attachTimeout, const Duration(seconds: 10));
    });

    test('bad timeout is skipped with a clear reason', () {
      final config = _resolveSessionAttachSmokeConfig(
        brokerUrlEnv: 'http://127.0.0.1:7734',
        rawToken: null,
        rawSmokeTool: null,
        rawSmokeSessionId: null,
        rawTimeoutSeconds: '-2',
      );

      expect(
        config.baseSkipReason,
        'Skipped: COSYNCING_ATTACH_SMOKE_TIMEOUT_SECONDS must be a '
        'positive integer.',
      );
    });
  });
}

Future<_SessionSelection> _resolveSessionSelection({
  required BrokerClient client,
  required String? explicitTool,
  required String? explicitSessionId,
}) async {
  if (explicitTool != null || explicitSessionId != null) {
    return _SessionSelection(
      tool: explicitTool,
      sessionId: explicitSessionId,
    );
  }

  final response = await client.listSessions();
  if (response.sessions.isEmpty) {
    return const _SessionSelection(
      skipReason:
          'Skipped: no broker sessions found; attach smoke passes with no '
          'live session.',
    );
  }

  final firstSession = response.sessions.first;
  return _SessionSelection(
    tool: firstSession.tool,
    sessionId: firstSession.id,
  );
}

Future<_SessionAttachResult> _waitForSessionAttachSignal({
  required SessionConnection connection,
  required Duration timeout,
}) async {
  final pollEnd = DateTime.now().add(timeout);
  var receivedEvent = false;
  var connected = false;

  final eventSub = connection.events.listen((_) {
    receivedEvent = true;
  });
  final stateSub = connection.stateStream.listen((state) {
    if (state == SessionConnectionState.connected) {
      connected = true;
    }
  });

  try {
    await connection.connect();

    while (DateTime.now().isBefore(pollEnd)) {
      if (connected && receivedEvent) {
        return const _SessionAttachResult(
          hasProtocolSignal: true,
          note:
              'smoke success: SessionConnection connected and emitted at '
              'least one WireEvent.',
        );
      }

      if (connected && DateTime.now().isAfter(pollEnd)) {
        break;
      }

      if (connection.state == SessionConnectionState.closed) {
        return const _SessionAttachResult(
          hasProtocolSignal: false,
          failureReason:
              'SessionConnection reached closed state before attach signal.',
        );
      }

      await Future<void>.delayed(const Duration(milliseconds: 100));
    }

    final failureReason = connected
        ? 'SessionConnection reached connected state but did not emit a '
              'WireEvent within ${timeout.inSeconds}s.'
        : 'SessionConnection did not reach connected state within '
              '${timeout.inSeconds}s.';

    return _SessionAttachResult(
      hasProtocolSignal: false,
      failureReason: failureReason,
    );
  } finally {
    await eventSub.cancel();
    await stateSub.cancel();
  }
}

class _SessionSelection {
  const _SessionSelection({
    this.tool,
    this.sessionId,
    this.skipReason,
  });

  final String? tool;
  final String? sessionId;
  final String? skipReason;
}

class _SessionAttachResult {
  const _SessionAttachResult({
    required this.hasProtocolSignal,
    this.note,
    this.failureReason,
  });

  final bool hasProtocolSignal;
  final String? note;
  final String? failureReason;
}

class _SessionAttachSmokeConfig {
  const _SessionAttachSmokeConfig({
    required this.brokerUrl,
    required this.token,
    required this.explicitTool,
    required this.explicitSessionId,
    required this.attachTimeout,
    required this.baseSkipReason,
  });

  final String? brokerUrl;
  final String? token;
  final String? explicitTool;
  final String? explicitSessionId;
  final Duration attachTimeout;
  final String? baseSkipReason;
}

_SessionAttachSmokeConfig _resolveSessionAttachSmokeConfig({
  required String? brokerUrlEnv,
  required String? rawToken,
  required String? rawSmokeTool,
  required String? rawSmokeSessionId,
  required String? rawTimeoutSeconds,
}) {
  final token = (rawToken == null || rawToken.trim().isEmpty)
      ? null
      : rawToken.trim();

  final brokerUrl = _normalizeBrokerUrlFromEnv(brokerUrlEnv);
  if (brokerUrl == null) {
    return _SessionAttachSmokeConfig(
      brokerUrl: null,
      token: token,
      explicitTool: null,
      explicitSessionId: null,
      attachTimeout: const Duration(seconds: 10),
      baseSkipReason: brokerUrlEnv == null || brokerUrlEnv.trim().isEmpty
          ? 'Skipped: set COSYNCING_BROKER_URL to run this smoke test.'
          : 'Skipped: COSYNCING_BROKER_URL is not a valid broker URL.',
    );
  }

  final attachTimeout = _parseAttachTimeout(rawTimeoutSeconds);
  if (attachTimeout == null) {
    return _SessionAttachSmokeConfig(
      brokerUrl: null,
      token: token,
      explicitTool: null,
      explicitSessionId: null,
      attachTimeout: const Duration(seconds: 10),
      baseSkipReason:
          'Skipped: COSYNCING_ATTACH_SMOKE_TIMEOUT_SECONDS must be a '
          'positive integer.',
    );
  }

  final isLoopback = _isLoopbackHost(Uri.parse(brokerUrl).host);
  if (!isLoopback && token == null) {
    return _SessionAttachSmokeConfig(
      brokerUrl: brokerUrl,
      token: null,
      explicitTool: _normalizeEnvValue(rawSmokeTool),
      explicitSessionId: _normalizeEnvValue(rawSmokeSessionId),
      attachTimeout: attachTimeout,
      baseSkipReason:
          'Skipped: remote broker smoke attach requires COSYNCING_TOKEN.',
    );
  }

  final normalizedTool = _normalizeEnvValue(rawSmokeTool);
  final normalizedSessionId = _normalizeEnvValue(rawSmokeSessionId);
  if ((normalizedTool == null) != (normalizedSessionId == null)) {
    return _SessionAttachSmokeConfig(
      brokerUrl: brokerUrl,
      token: token,
      explicitTool: normalizedTool,
      explicitSessionId: normalizedSessionId,
      attachTimeout: attachTimeout,
      baseSkipReason:
          'Skipped: both COSYNCING_SMOKE_TOOL and COSYNCING_SMOKE_SESSION_ID '
          'must be set together.',
    );
  }

  return _SessionAttachSmokeConfig(
    brokerUrl: brokerUrl,
    token: token,
    explicitTool: normalizedTool,
    explicitSessionId: normalizedSessionId,
    attachTimeout: attachTimeout,
    baseSkipReason: null,
  );
}

Duration? _parseAttachTimeout(String? rawTimeoutSeconds) {
  final trimmed = rawTimeoutSeconds?.trim();
  if (trimmed == null || trimmed.isEmpty) {
    return const Duration(seconds: 10);
  }

  final parsed = int.tryParse(trimmed);
  if (parsed == null || parsed <= 0) {
    return null;
  }

  return Duration(seconds: parsed);
}

String? _normalizeEnvValue(String? value) {
  final trimmed = value?.trim();
  return trimmed == null || trimmed.isEmpty ? null : trimmed;
}

BrokerClient _buildBrokerClient({
  required String brokerUrl,
  required String? token,
}) {
  return BrokerClient(baseUrl: brokerUrl, token: token);
}

bool _isLoopbackHost(String host) {
  return host == 'localhost' || host == '127.0.0.1' || host == '::1';
}

String? _normalizeBrokerUrlFromEnv(String? rawInput) {
  final input = rawInput?.trim();
  if (input == null || input.isEmpty) {
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
