import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';

import 'package:cosyncing_client/src/features/sessions/data/session_list_repository.dart';

/// Real [SessionListRepository] implementation backed by [BrokerClient].
///
/// It caches the stable roster ETag and exposes the broker's bounded delta
/// journal while a roster surface is in the foreground.
/// See `docs/protocol/contract-sync.md`.
class BrokerClientSessionListRepository
    implements
        SessionListRepository,
        WindowedSessionListRepository,
        LiveSessionListRepository,
        WindowedLiveSessionListRepository {
  /// Creates a [BrokerClientSessionListRepository].
  BrokerClientSessionListRepository({
    required this._brokerClient,
  });

  final BrokerClient _brokerClient;
  final Map<String, String?> _etags = {};
  final Map<String, ListSessionsResponse> _lastResponses = {};

  @override
  Future<ListSessionsResponse> fetchSessions({bool force = false}) =>
      fetchSessionsWindowed(window: 'all', force: force);

  @override
  Future<ListSessionsResponse> fetchSessionsWindowed({
    required String window,
    bool force = false,
  }) async {
    final result = await _brokerClient.listSessionsConditional(
      etag: _etags[window],
      refresh: force,
      window: window,
    );
    _etags[window] = result.etag ?? _etags[window];
    final response = result.response;
    if (response != null) {
      _lastResponses[window] = response;
      return response;
    }
    final last = _lastResponses[window];
    if (result.notModified && last != null) return last;
    throw const BrokerException(
      message: 'Broker returned 304 before the initial roster snapshot',
    );
  }

  @override
  Future<SessionRosterDeltaBatch> waitForDeltas({
    required int after,
    Duration wait = const Duration(seconds: 25),
  }) => waitForDeltasWindowed(after: after, window: 'all', wait: wait);

  @override
  Future<SessionRosterDeltaBatch> waitForDeltasWindowed({
    required int after,
    required String window,
    Duration wait = const Duration(seconds: 25),
  }) async {
    try {
      return await _brokerClient.waitForSessionRosterDeltas(
        after: after,
        wait: wait,
        window: window,
      );
    } on RosterDeltaWaitCancelled {
      throw const SessionRosterDeltaWaitCancelledException();
    } on BrokerException catch (error, stackTrace) {
      if (error.statusCode == 404) {
        throw const SessionRosterDeltaFeedUnsupportedException();
      }
      throw SessionRosterDeltaFeedRetryableException(error, stackTrace);
    }
  }

  @override
  void cancelDeltaWait() => _brokerClient.cancelSessionRosterDeltaWait();
}
