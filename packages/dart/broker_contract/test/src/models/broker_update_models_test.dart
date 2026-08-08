import 'package:broker_contract/broker_contract.dart';
import 'package:test/test.dart';

void main() {
  test('decodes a signed release update snapshot', () {
    final response = BrokerUpdateResponse.fromJson({
      'ok': true,
      'update': {
        'schemaVersion': 1,
        'status': 'update-available',
        'currentVersion': '1.0.0',
        'latestVersion': '1.1.0',
        'publishedAt': '2026-07-18T12:00:00.000Z',
        'checkedAt': '2026-07-18T12:01:00.000Z',
        'detailCode': 'release-update-available',
        'cached': false,
        'nextCheckAt': '2026-07-19T12:01:00.000Z',
      },
    });

    expect(response.ok, isTrue);
    expect(response.update.updateAvailable, isTrue);
    expect(response.update.latestVersion, '1.1.0');
  });

  test('decodes accepted isolated updater handoff', () {
    final response = BrokerUpdateTriggerResponse.fromJson({
      'ok': true,
      'accepted': true,
      'update': {
        'status': 'update-available',
        'currentVersion': '1.0.0',
        'latestVersion': '1.1.0',
        'checkedAt': '2026-07-18T12:01:00.000Z',
        'detailCode': 'release-update-available',
      },
      'handoff': {
        'status': 'accepted',
        'detailCode': 'broker-update-accepted',
        'message': 'queued',
        'fromVersion': '1.0.0',
        'toVersion': '1.1.0',
      },
    });

    expect(response.accepted, isTrue);
    expect(response.handoff?.status, 'accepted');
    expect(response.outcomeMessage, 'queued');
  });

  test('fails closed when the update snapshot is absent', () {
    expect(
      () => BrokerUpdateResponse.fromJson({'ok': true}),
      throwsFormatException,
    );
  });
}
