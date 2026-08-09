import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_telemetry.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('SessionTelemetry.fromMessages', () {
    test('keeps only the newest token reading', () {
      final telemetry = SessionTelemetry.fromMessages([
        _message('token-count', {'input': 10, 'output': 5}),
        _message('token-count', {
          'input': 4,
          'output': 567,
          'cacheRead': 332792,
          'cacheWrite': 656,
        }),
      ]);

      expect(telemetry.inputTokens, 4);
      expect(telemetry.outputTokens, 567);
      expect(telemetry.cacheReadTokens, 332792);
      expect(telemetry.cacheWriteTokens, 656);
      expect(telemetry.totalTokens, 334019);
    });

    test('is empty before any reading arrives', () {
      final telemetry = SessionTelemetry.fromMessages([
        _message('model-output', {'text': 'hello'}),
      ]);

      expect(telemetry.isEmpty, isTrue);
      expect(telemetry.totalTokens, isNull);
    });

    test('reads context usage from a metadata update', () {
      final telemetry = SessionTelemetry.fromMessages([
        _message('metadata-update', {
          'key': 'contextUsage',
          'value': {'used': 90000, 'max': 200000},
        }),
      ]);

      expect(telemetry.contextPercent, closeTo(45, 0.001));
      expect(telemetry.contextUsedTokens, 90000);
      expect(telemetry.contextMaxTokens, 200000);
      expect(telemetry.isContextCritical, isFalse);
    });

    test('does not inflate a low used/max ratio (regression)', () {
      // 1700/200000 is 0.85%. A used/max value is already a percentage, so it
      // must not be re-multiplied to 85% — which previously tripped the false
      // context-critical warning at session start.
      final telemetry = SessionTelemetry.fromMessages([
        _message('metadata-update', {
          'key': 'contextUsage',
          'value': {'used': 1700, 'max': 200000},
        }),
      ]);

      expect(telemetry.contextPercent, closeTo(0.85, 0.001));
      expect(telemetry.isContextCritical, isFalse);
    });

    test('treats a bare ratio as a percent', () {
      final telemetry = SessionTelemetry.fromMessages([
        _message('metadata-update', {'key': 'context', 'value': 0.9}),
      ]);

      expect(telemetry.contextPercent, closeTo(90, 0.001));
      expect(telemetry.isContextCritical, isTrue);
    });

    test('flags context pressure at the PoC 85% threshold', () {
      final telemetry = SessionTelemetry.fromMessages([
        _message('metadata-update', {'key': 'contextUsage', 'value': 85}),
      ]);

      expect(telemetry.isContextCritical, isTrue);
    });

    test('reads runtime totals from a metadata update', () {
      final telemetry = SessionTelemetry.fromMessages([
        _message('metadata-update', {
          'key': 'runtimeTotals',
          'value': {
            'totalRuntimeMs': 65000,
            'agentRuntimeMs': 40000,
            'turnCount': 7,
          },
        }),
      ]);

      expect(telemetry.totalRuntimeMs, 65000);
      expect(telemetry.agentRuntimeMs, 40000);
      expect(telemetry.turnCount, 7);
    });

    test('a run summary contributes its nested token totals', () {
      final telemetry = SessionTelemetry.fromMessages([
        _message('run-summary', {
          'status': 'completed',
          'totalRuntimeMs': 1000,
          'tokens': {'input': 3, 'output': 4},
        }),
      ]);

      expect(telemetry.totalRuntimeMs, 1000);
      expect(telemetry.totalTokens, 7);
    });

    test('an unrelated metadata key changes nothing', () {
      final telemetry = SessionTelemetry.fromMessages([
        _message('metadata-update', {'key': 'model', 'value': 'opus'}),
      ]);

      expect(telemetry.isEmpty, isTrue);
    });
  });

  group('isSessionTelemetryMessage', () {
    test('claims token counts', () {
      expect(
        isSessionTelemetryMessage(_message('token-count', {'input': 1})),
        isTrue,
      );
    });

    test('claims context and runtime metadata', () {
      for (final key in [
        'contextUsage',
        'context-usage',
        'runtimeTotals',
        'sessionStats',
      ]) {
        expect(
          isSessionTelemetryMessage(
            _message('metadata-update', {'key': key, 'value': 1}),
          ),
          isTrue,
          reason: key,
        );
      }
    });

    test('leaves run summaries in the transcript', () {
      expect(
        isSessionTelemetryMessage(
          _message('run-summary', {'turnId': 'turn-1'}),
        ),
        isFalse,
      );
    });

    test('leaves unrelated metadata in the transcript', () {
      expect(
        isSessionTelemetryMessage(
          _message('metadata-update', {'key': 'model', 'value': 'opus'}),
        ),
        isFalse,
      );
    });
  });
}

AgentMessage _message(String type, Map<String, dynamic> fields) =>
    AgentMessage.fromJson({'type': type, ...fields});
