import 'package:broker_contract/broker_contract.dart';
import 'package:test/test.dart';

void main() {
  group('HealthResponse', () {
    test('fromJson parses all fields', () {
      final json = {
        'ok': true,
        'product': 'cosyncing',
        'version': '1.2.3',
        'contract': {
          'revision': 2,
          'minimumClientRevision': 1,
          'surfaceHash': 'fnv1a32:12345678',
        },
        'machine': 'test-machine',
        'controlMode': 'observe-drive',
        'codexSyncServer': false,
      };

      final health = HealthResponse.fromJson(json);
      expect(health.ok, isTrue);
      expect(health.product, 'cosyncing');
      expect(health.version, '1.2.3');
      expect(health.contract?.revision, 2);
      expect(health.machine, 'test-machine');
      expect(health.controlMode, 'observe-drive');
      expect(health.codexSyncServer, isFalse);
    });

    test('fromJson handles null fields', () {
      final json = {
        'ok': true,
      };

      final health = HealthResponse.fromJson(json);
      expect(health.ok, isTrue);
      expect(health.machine, isNull);
      expect(health.controlMode, isNull);
      expect(health.codexSyncServer, isNull);
    });

    test('toJson serializes all fields', () {
      const health = HealthResponse(
        ok: true,
        machine: 'test-machine',
        controlMode: 'observe-drive',
        codexSyncServer: false,
        healthStatus: 'healthy',
        healthCheckedAt: 1730000000000,
      );

      final json = health.toJson();
      expect(json['ok'], isTrue);
      expect(json['machine'], 'test-machine');
      expect(json['controlMode'], 'observe-drive');
      expect(json['codexSyncServer'], isFalse);
      expect(json['healthStatus'], 'healthy');
      expect(json['healthCheckedAt'], 1730000000000);
    });

    test('roundtrip serialization', () {
      const health = HealthResponse(
        ok: true,
        machine: 'test-machine',
        controlMode: 'true-sync-terminal',
        codexSyncServer: true,
        healthStatus: 'degraded',
        healthCheckedAt: 1731000000000,
      );

      final json = health.toJson();
      final restored = HealthResponse.fromJson(json);
      expect(restored.ok, health.ok);
      expect(restored.machine, health.machine);
      expect(restored.controlMode, health.controlMode);
      expect(restored.codexSyncServer, health.codexSyncServer);
      expect(restored.healthStatus, health.healthStatus);
      expect(restored.healthCheckedAt, health.healthCheckedAt);
    });

    test('parses legacy health payload from old broker', () {
      final health = HealthResponse.fromJson({
        'ok': false,
        'machine': 'old-broker',
      });

      expect(health.ok, isFalse);
      expect(health.machine, 'old-broker');
      expect(health.healthStatus, isNull);
      expect(health.healthCheckedAt, isNull);
    });

    test('tolerates unknown fields', () {
      final json = {
        'ok': true,
        'machine': 'test-machine',
        'unknownField': 'should be ignored',
        'anotherUnknown': 42,
      };

      final health = HealthResponse.fromJson(json);
      expect(health.ok, isTrue);
      expect(health.machine, 'test-machine');
    });
  });
}
