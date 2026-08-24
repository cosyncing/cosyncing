import 'package:broker_contract/broker_contract.dart';
import 'package:test/test.dart';

void main() {
  group('runtime admin contract models', () {
    test('parses runtime status with unknown blocker state', () {
      final response = RuntimeUpdatesResponse.fromJson({
        'ok': true,
        'updates': [
          {
            'agent': 'codex',
            'displayName': 'Codex',
            'managed': true,
            'state': 'pending',
            'updateAvailable': true,
            'autoRestartReady': false,
            'pendingChanges': ['configuration', 'future-change'],
            'checkedAt': 1730000000000,
            'blockerComposition': {
              'idle': 1,
              'working': 0,
              'needsInput': 2,
              'unknown': 3,
              'future': 4,
            },
            'blockerDetails': [
              {
                'id': 'auth',
                'status': 'maintenance-mode',
                'detail': 'Manual action required',
                'future': 'ignored',
              },
            ],
            'future': 'field',
          },
        ],
      });

      expect(response.ok, isTrue);
      expect(response.updates, hasLength(1));
      final update = response.updates.first;
      expect(update.state, 'pending');
      expect(update.isKnownState, isTrue);
      expect(update.pendingChanges, ['configuration', 'future-change']);
      expect(update.toJson()['pendingChanges'], [
        'configuration',
        'future-change',
      ]);
      expect(update.blockerComposition!.idle, 1);
      expect(update.blockerComposition!.raw['future'], 4);
      expect(update.blockerDetails.first.status, 'maintenance-mode');
      expect(update.blockerDetails.first.isKnownStatus, isFalse);
      expect(update.raw['future'], 'field');
    });

    test('preserves unknown codex policy strings', () {
      final response = CodexUpdatePolicyResponse.fromJson({
        'ok': true,
        'codexUpdatePolicy': 'when-retry-window-open',
      });
      expect(response.ok, isTrue);
      expect(response.isKnownPolicy, isFalse);
      expect(
        response.toJson(),
        containsPair('codexUpdatePolicy', 'when-retry-window-open'),
      );
    });

    test(
      'parses broker-health components while preserving unknown component keys',
      () {
        final response = BrokerHealthResponse.fromJson({
          'ok': true,
          'machine': 'dev-machine',
          'principal': {
            'kind': 'peer',
            'roles': ['observe', 'files'],
          },
          'status': 'critical',
          'checkedAt': 1730011111111,
          'components': {
            'state-filesystem': {
              'status': 'critical',
              'detailCodes': ['capacity-critical', 'custom-detail'],
              'checkedAt': 1730011111100,
              'extra': 'value',
            },
            'attention-store': {
              'status': 'healthy',
              'detailCodes': <String>[],
              'checkedAt': 1730011111111,
            },
            'custom-service': {
              'status': 'degraded',
              'detailCodes': ['lag'],
              'checkedAt': 1730011111112,
            },
          },
          'diagnostics': {'eventLoopDelayMs': 12.5, 'unknown': 'kept'},
        });

        expect(response.status, 'critical');
        expect(response.principalKind, 'peer');
        expect(response.principalRoles, ['observe', 'files']);
        expect(response.ownerOperationsAvailable, isFalse);
        expect(response.checkedAt, 1730011111111);
        expect(response.components, hasLength(3));
        expect(response.components['state-filesystem']!.detailCodes, [
          'capacity-critical',
          'custom-detail',
        ]);
        expect(response.components['custom-service']!.raw['detailCodes'], [
          'lag',
        ]);
        expect(response.isKnownStatus, isTrue);
      },
    );

    test('parses restart-all partial failures and unknown components', () {
      final response = BrokerRestartAllResponse.fromJson({
        'ok': true,
        'partialFailure': true,
        'components': {
          'codex': {
            'ok': false,
            'skipped': false,
            'reason': 'already-running',
            'error': 'restart failed',
          },
          'opencode': {
            'strategy': 'broker-relaunch',
            'restartsWithBroker': true,
          },
          'broker': {'scheduled': false, 'dryRun': true},
          'observer': {'state': 'disabled'},
        },
        'message': 'Codex failed, other components queued',
      });

      expect(response.ok, isTrue);
      expect(response.partialFailure, isTrue);
      expect(response.components!.codex?.ok, isFalse);
      expect(response.components!.codex?.skipped, isFalse);
      expect(response.components!.codex?.reason, 'already-running');
      expect(response.components!.opencode?.strategy, 'broker-relaunch');
      expect(response.components!.broker?.scheduled, isFalse);
      expect(response.components!.broker?.dryRun, isTrue);
      expect(response.components!.extraComponents['observer'], {
        'state': 'disabled',
      });
      expect(response.message, contains('Codex failed'));
    });

    test('parses tokdash quota and estimated buckets', () {
      final response = TokdashQuotaResponse.fromJson({
        'ok': true,
        'baseUrl': 'http://127.0.0.1:55423',
        'endpoint': '/api/quota',
        'data': {
          'enabled': true,
          'timestamp': 1730022222000,
          'providers': {
            'codex': {
              'provider': 'codex',
              'network_enabled': true,
              'buckets': [
                {
                  'account': 'primary',
                  'bucket': '5h',
                  'bucket_label': '5-hour',
                  'used_percent': 34,
                  'remaining_percent': 66,
                  'resets_at': 1730029999000,
                  'captured_at': 1730021111000,
                  'source': 'tokdash',
                  'status': 'ok',
                },
                {
                  'account': 'primary',
                  'bucket': '7d',
                  'bucket_label': 'weekly',
                  'used_percent': 21,
                  'remaining_percent': 79,
                  'resets_at': 1730099999000,
                  'captured_at': 1730022222000,
                  'source': 'tokdash',
                  'status': 'ok',
                },
              ],
              'status': 'ok',
              'status_detail': null,
              'status_at': 1730010000000,
              'updated_at': 1730011111111,
              'sources': ['codex', 'broker'],
              'estimated': true,
            },
          },
        },
      });

      expect(response.ok, isTrue);
      expect(response.data, isNotNull);
      final provider = response.data!.providers['codex'];
      expect(provider, isNotNull);
      expect(provider!.estimated, isTrue);
      expect(provider.buckets, hasLength(2));
      expect(provider.buckets.first.bucket, '5h');
      expect(provider.buckets.first.remainingPercent, 66);
      expect(provider.buckets.last.bucket, '7d');
      expect(provider.buckets.last.remainingPercent, 79);
      expect(provider.buckets.last.source, 'tokdash');
    });

    test('normalizes epoch-second quota timestamps to milliseconds', () {
      // Tokdash's /api/quota emits epoch seconds while the contract documents
      // milliseconds; the model boundary normalizes so consumers always see
      // the documented unit.
      final response = TokdashQuotaResponse.fromJson({
        'ok': true,
        'data': {
          'enabled': true,
          'timestamp': 1730022222,
          'providers': {
            'codex': {
              'provider': 'codex',
              'network_enabled': true,
              'buckets': [
                {
                  'account': 'primary',
                  'bucket': '5h',
                  'bucket_label': '5-hour',
                  'used_percent': 34,
                  'remaining_percent': 66,
                  'resets_at': 1730029999,
                  'captured_at': 1730021111,
                  'source': 'tokdash',
                  'status': 'ok',
                },
              ],
              'status': 'ok',
              'status_detail': null,
              'status_at': 1730010000,
              'updated_at': 1730011111,
              'sources': ['codex'],
              'estimated': false,
            },
          },
        },
      });

      expect(response.data!.timestamp, 1730022222000);
      final provider = response.data!.providers['codex']!;
      expect(provider.statusAt, 1730010000000);
      expect(provider.updatedAt, 1730011111000);
      expect(provider.buckets.single.resetsAt, 1730029999000);
      expect(provider.buckets.single.capturedAt, 1730021111000);
    });

    test('parses quota preference responses with enabled and errors', () {
      final enabled = TokdashQuotaPreferenceResponse.fromJson({
        'ok': true,
        'enabled': true,
      });
      expect(enabled.ok, isTrue);
      expect(enabled.enabled, isTrue);
      expect(enabled.error, isNull);

      final blocked = TokdashQuotaPreferenceResponse.fromJson({
        'ok': false,
        'enabled': null,
        'error': 'enabled must be a boolean',
      });
      expect(blocked.ok, isFalse);
      expect(blocked.error, 'enabled must be a boolean');
    });
  });
}
