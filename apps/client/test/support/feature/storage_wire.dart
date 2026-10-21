import 'fake_broker.dart';

/// Server-side storage contract fixture. The app still uses its REST client,
/// persistence and uncertain-result reconciliation through the normal UI.
final class StorageDesk {
  StorageDesk(this.broker) {
    broker.routes.add(_route);
  }

  final FakeBroker broker;
  final Map<String, String> jobs = {};
  int plans = 0;
  bool failFirstJob = false;

  Map<String, Object?> job(String id) => {
    'jobId': id,
    'planId': 'plan-1',
    'state': 'completed',
    'total': 1,
    'processed': 1,
    'removed': failFirstJob && id == 'job-1' ? 0 : 1,
    'missing': 0,
    'skipped': 0,
    'failed': failFirstJob && id == 'job-1' ? 1 : 0,
    'reclaimedBytes': failFirstJob && id == 'job-1' ? 0 : 20,
    'retainedUntil': DateTime.now()
        .add(const Duration(days: 1))
        .millisecondsSinceEpoch,
  };

  Future<FakeBrokerResponse?> _route(FakeBrokerRequest request) async {
    switch ((request.method, request.path)) {
      case ('POST', '/api/storage/scans'):
        return const FakeBrokerResponse(202, {
          'scanId': 'scan-1',
          'state': 'completed',
        });
      case ('GET', '/api/storage'):
        return FakeBrokerResponse(200, {
          'capability': 'storage-v1',
          'inventoryId': 'inventory-1',
          'serverIdentity': broker.baseUri.host,
          'measuredAt': DateTime.now().millisecondsSinceEpoch,
          'status': 'complete',
          'actions': ['stored-files', 'cache'],
          'categories': [
            {
              'id': 'stored-files',
              'bytes': 20,
              'itemCount': 1,
              'eligibleCount': 1,
              'eligibleBytes': 20,
              'quality': 'measured',
            },
          ],
        });
      case ('GET', '/api/storage/items'):
        return const FakeBrokerResponse(200, {
          'eligibleCount': 1,
          'items': [
            {
              'id': 'item-1',
              'version': 'v1',
              'category': 'stored-files',
              'label': 'Report.txt',
              'size': 20,
              'createdAt': 1,
              'eligible': true,
            },
          ],
        });
      case ('POST', '/api/storage/cleanup-plans'):
        plans++;
        return FakeBrokerResponse(201, {
          'planId': 'plan-$plans',
          'inventoryId': 'inventory-1',
          'expiresAt': DateTime.now()
              .add(const Duration(minutes: 5))
              .millisecondsSinceEpoch,
          'itemCount': 1,
          'affectedSessions': 1,
          'logicalBytes': 20,
          'reclaimableBytes': 20,
          'skippedCount': 0,
        });
      case ('POST', '/api/storage/cleanup-jobs'):
        final key = (request.body! as Map)['idempotencyKey']! as String;
        final id = jobs.putIfAbsent(key, () => 'job-${jobs.length + 1}');
        return FakeBrokerResponse(202, job(id));
      case ('GET', final path)
          when path.startsWith('/api/storage/cleanup-jobs/'):
        return FakeBrokerResponse(200, job(path.split('/').last));
    }
    return null;
  }
}
