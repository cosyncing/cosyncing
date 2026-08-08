import 'package:broker_contract/broker_contract.dart';
import 'package:test/test.dart';

void main() {
  test('decodes local, peer, and degraded machine rosters', () {
    final response = AggregatedMachinesResponse.fromJson(const {
      'ok': true,
      'machine': 'local-machine',
      'machines': [
        {
          'machine': 'local-machine',
          'role': 'local',
          'status': 'ok',
          'sessionCount': 1,
          'sessions': [
            {
              'id': 'session-1',
              'tool': 'claude',
              'title': 'Local work',
              'status': 'idle',
              'attachMode': 'observe',
              'machine': 'local-machine',
            },
          ],
        },
        {
          'machine': 'peer-a',
          'role': 'peer',
          'status': 'degraded',
          'baseUrl': 'http://peer-a:7734',
          'code': 'MACHINE_PEER_TIMEOUT',
          'error': 'timed out',
          'sessionCount': 0,
          'sessions': <Object?>[],
        },
      ],
    });

    expect(response.ok, isTrue);
    expect(response.machine, 'local-machine');
    expect(response.machines.first.role, MachineRosterRole.local);
    expect(response.machines.first.sessions.single.machine, 'local-machine');
    expect(response.machines.last.status, MachineRosterStatus.degraded);
    expect(response.machines.last.code, 'MACHINE_PEER_TIMEOUT');
    expect(response.toJson()['machines'], hasLength(2));
  });

  test('tolerates future role and status values', () {
    final roster = MachineRoster.fromJson(const {
      'machine': 'future',
      'role': 'relay',
      'status': 'offline',
      'sessions': <Object?>[],
    });

    expect(roster.role, MachineRosterRole.unknown);
    expect(roster.status, MachineRosterStatus.unknown);
    expect(roster.sessionCount, 0);
  });

  test('decodes composite identity and authoritative direct resolution', () {
    final resolution = MachineSessionResolution.fromJson(const {
      'ok': true,
      'status': 'resolved',
      'identity': {
        'machineId': 'peer-id',
        'tool': 'codex',
        'sessionId': 'session-1',
        'key': 'opaque-composite-key',
      },
      'owner': {
        'machineId': 'peer-id',
        'machine': 'Peer workstation',
        'role': 'peer',
        'route': 'direct',
        'authoritative': true,
        'baseUrl': 'https://peer.example.test',
        'streamUrl': 'wss://peer.example.test/api/session',
        'requiresIndependentAuthentication': true,
      },
      'session': {
        'id': 'session-1',
        'tool': 'codex',
        'title': 'Peer work',
        'status': 'idle',
        'attachMode': 'observe',
        'identity': {
          'machineId': 'peer-id',
          'tool': 'codex',
          'sessionId': 'session-1',
          'key': 'opaque-composite-key',
        },
        'owner': {
          'machineId': 'peer-id',
          'machine': 'Peer workstation',
          'role': 'peer',
          'route': 'direct',
          'authoritative': true,
          'baseUrl': 'https://peer.example.test',
          'streamUrl': 'wss://peer.example.test/api/session',
          'requiresIndependentAuthentication': true,
        },
      },
    });

    expect(resolution.identity.key, 'opaque-composite-key');
    expect(resolution.owner?.route, MachineSessionRouteState.direct);
    expect(resolution.owner?.requiresIndependentAuthentication, isTrue);
    expect(resolution.canConnect, isTrue);
  });

  test('fails closed when a resolved response omits its session', () {
    final resolution = MachineSessionResolution.fromJson(const {
      'ok': true,
      'status': 'resolved',
      'identity': {
        'machineId': 'peer-id',
        'tool': 'codex',
        'sessionId': 'session-1',
        'key': 'opaque-composite-key',
      },
      'owner': {
        'machineId': 'peer-id',
        'machine': 'Peer workstation',
        'role': 'peer',
        'route': 'direct',
        'authoritative': true,
        'baseUrl': 'https://peer.example.test',
        'requiresIndependentAuthentication': true,
      },
    });

    expect(resolution.canConnect, isFalse);
  });

  test('keeps stale owners displayable but not connectable', () {
    final resolution = MachineSessionResolution.fromJson(const {
      'ok': false,
      'status': 'stale',
      'code': 'MACHINE_ROUTE_STALE',
      'identity': {
        'machineId': 'peer-id',
        'tool': 'codex',
        'sessionId': 'session-1',
        'key': 'opaque-composite-key',
      },
    });

    expect(resolution.status, MachineSessionResolutionStatus.stale);
    expect(resolution.canConnect, isFalse);
  });

  test('rejects a resolved route whose owner identity does not match', () {
    final resolution = MachineSessionResolution.fromJson(const {
      'ok': true,
      'status': 'resolved',
      'identity': {
        'machineId': 'peer-id',
        'tool': 'codex',
        'sessionId': 'session-1',
        'key': 'opaque-composite-key',
      },
      'owner': {
        'machineId': 'different-peer',
        'machine': 'Different workstation',
        'role': 'peer',
        'route': 'direct',
        'authoritative': true,
        'baseUrl': 'https://different.example.test',
        'requiresIndependentAuthentication': true,
      },
    });

    expect(resolution.canConnect, isFalse);
  });
}
