// A stateful update server at the HTTP boundary. No controller is mocked.
// Public fixture fields are scenario controls, rather than a package API.
// ignore_for_file: public_member_api_docs
import 'dart:async';

import 'package:broker_contract/broker_contract.dart';

import 'fake_broker.dart';

/// Signed-channel and durable-job responses for the existing updates journeys.
class UpdateDesk {
  UpdateDesk(this.broker, {required this.now, this.onEvent}) {
    broker.routes.add(_route);
  }
  final FakeBroker broker;
  final DateTime Function() now;
  final void Function(String)? onEvent;
  bool allowed = true;
  bool losePreparationResponse = false;
  bool finish = true;
  bool revoked = false;
  bool contractKnown = true;
  bool canApply = true;
  static const manualBlocker =
      'This service has no qualified independent in-app update runner.';
  static const manualGuidance =
      'Use the signed installer or cosy update on this server.';
  int targetRevision = cosyncingClientContractRevision;
  Completer<void>? checkHeld;
  Completer<void>? preparationHeld;
  Completer<void>? jobReadHeld;
  int jobReads = 0;
  final preparations = <String, Map<String, Object?>>{};
  final plans = <String, Map<String, Object?>>{};
  final applies = <String>[];
  final events = <String>[];
  final grants = <String>{};
  final requests = <String>{};
  Map<String, Object?> get _running => {
    'version': '1.0.0',
    'buildId': '1111111',
  };
  Map<String, Object?> get _target => {
    'version': '2.0.0',
    'buildId': '2222222',
    'releaseId': 'rel-2.0.0+2222222',
  };
  Map<String, Object?> get _contract => {
    'revision': cosyncingClientContractRevision,
    'minimumPeerRevision': cosyncingClientMinimumBrokerRevision,
    'surfaceHash': cosyncingClientContractSurfaceHash,
  };

  Future<FakeBrokerResponse?> _route(FakeBrokerRequest request) async {
    final path = request.path;
    if (path == '/api/broker/updates') {
      return FakeBrokerResponse(200, {
        'ok': true,
        'inventory': {
          'schemaVersion': 1,
          'installationId': broker.baseUri.host,
          'installationGeneration': 1,
          'updateManagementVersion': 1,
          'components': [
            {
              'component': 'broker',
              'platform': 'linux',
              'arch': 'x64',
              'ownership': 'cosyncing-installer',
              'running': _running,
              'available': _target,
              if (contractKnown) 'contract': _contract,
              'canCheck': true,
              'canPlan': true,
              'canApply': canApply,
              'canCancel': false,
              'requiresRestart': true,
              'blockers': <Object?>[
                if (!canApply)
                  {
                    'code': 'unsupported-platform',
                    'detail': manualBlocker,
                    'guidance': manualGuidance,
                  },
              ],
            },
          ],
          'busy': {
            'state': 'idle',
            'activeTurns': 0,
            'activeLaunches': 0,
            'pendingApprovals': 0,
            'observedAt': now().toIso8601String(),
          },
          'checkedAt': now().toIso8601String(),
        },
      });
    }
    if (path == '/api/broker/updates/check') {
      await checkHeld?.future;
      return FakeBrokerResponse(200, {
        'ok': true,
        'check': {
          'schemaVersion': 1,
          'status': 'update-available',
          'detailCode': 'available',
          'components': [
            {
              'component': 'broker',
              'running': _running,
              'available': _target,
              'releaseCheckedAt': now().toIso8601String(),
            },
          ],
        },
      });
    }
    if (path == '/api/broker/updates/history') {
      return const FakeBrokerResponse(200, {
        'ok': true,
        'history': <Object?>[],
      });
    }
    if (path == '/api/broker/update-grants/request') {
      requests.add('phone');
      return const FakeBrokerResponse(202, {'ok': true, 'requested': true});
    }
    if (path == '/api/broker/update-grants' && request.method == 'GET') {
      if (request.peerToken != null) {
        return const FakeBrokerResponse(403, {'error': 'owner required'});
      }
      return FakeBrokerResponse(200, {
        'ok': true,
        'grants': [
          for (final peer in grants) {'peerId': peer},
        ],
        'requests': [
          for (final peer in requests) {'peerId': peer},
        ],
      });
    }
    if (path == '/api/broker/update-grants' && request.method == 'POST') {
      final peer = (request.body! as Map)['peerId']! as String;
      grants.add(peer);
      requests.remove(peer);
      return const FakeBrokerResponse(201, {'ok': true});
    }
    if (path.startsWith('/api/broker/update-grants/') &&
        request.method == 'DELETE') {
      grants.remove(Uri.decodeComponent(path.split('/').last));
      return const FakeBrokerResponse(200, {'ok': true});
    }
    if (!path.startsWith('/api/broker/updates/')) return null;
    if (request.method == 'POST' && (!allowed || revoked)) {
      return const FakeBrokerResponse(403, {
        'ok': false,
        'code': 'UPDATE_PERMISSION_REQUIRED',
        'error': 'permission required',
      });
    }
    if (path.endsWith('/plans')) {
      final body = request.body! as Map;
      final clientRevision =
          (body['clientContract']! as Map)['revision']! as int;
      final acknowledgements = body['acknowledgements'] as List? ?? [];
      final id = 'plan-${plans.length}';
      final plan = <String, Object?>{
        'schemaVersion': 1,
        'planId': id,
        'releaseId': body['releaseId'],
        'installationId': broker.baseUri.host,
        'installationGeneration': 1,
        'expiresAt': now().add(const Duration(minutes: 15)).toIso8601String(),
        'components': [
          {
            'component': 'broker',
            'from': _running,
            'to': _target,
            'order': 0,
            'impacts': ['server-will-disconnect'],
          },
        ],
        'order': ['broker'],
        'requiredAcknowledgements': ['server-will-disconnect'],
        'outstandingAcknowledgements':
            acknowledgements.contains('server-will-disconnect')
            ? []
            : ['server-will-disconnect'],
        'blockers': <Object?>[
          if ((targetRevision - clientRevision).abs() > 1)
            {'code': 'no-safe-intermediate', 'detail': 'A newer app is needed'},
        ],
        'excluded': <Object?>[],
        'compatibility': {
          'final': {
            'broker': {..._contract, 'revision': targetRevision},
          },
        },
        'updateManagementVersion': 1,
      };
      plans[id] = plan;
      return FakeBrokerResponse(200, {'ok': true, 'plan': plan});
    }
    if (path.endsWith('/jobs') && request.method == 'POST') {
      final body = request.body! as Map;
      final key = body['idempotencyKey']! as String;
      final job = preparations.putIfAbsent(key, () {
        events.add('prepared');
        return {
          'schemaVersion': 1,
          'jobId': 'job-${preparations.length}',
          'planId': body['planId'],
          'releaseId': 'rel-2.0.0+2222222',
          'installationId': broker.baseUri.host,
          'installationGeneration': 1,
          'phase': 'ready',
          'sequence': 1,
          'createdAt': now().toIso8601String(),
          'updatedAt': now().toIso8601String(),
          'components': <Object?>[],
          'events': <Object?>[],
        };
      });
      await preparationHeld?.future;
      if (losePreparationResponse) {
        losePreparationResponse = false;
        return const FakeBrokerResponse(503, {'error': 'response lost'});
      }
      onEvent?.call('prepared');
      return FakeBrokerResponse(202, {'ok': true, 'job': job});
    }
    final jobId = path.split('/')[5];
    final job = preparations.values
        .where((j) => j['jobId'] == jobId)
        .firstOrNull;
    if (job == null) {
      return const FakeBrokerResponse(404, {'error': 'unknown job'});
    }
    if (request.method == 'GET') {
      jobReads++;
      await jobReadHeld?.future;
    }
    if (path.endsWith('/apply')) {
      events.add('applied');
      onEvent?.call('applied');
      applies.add(jobId);
      job['phase'] = finish ? 'succeeded' : 'verifying';
    } else if (path.endsWith('/cancel')) {
      job['phase'] = 'cancelled';
    }
    return FakeBrokerResponse(200, {'ok': true, 'job': job});
  }
}
