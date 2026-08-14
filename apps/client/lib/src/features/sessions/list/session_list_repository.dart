import 'package:broker_contract/broker_contract.dart';

/// Abstract interface for fetching sessions from the broker.
///
/// Feature controllers consume this interface; the concrete implementation
/// can be a real BrokerClient adapter or a fake for tests.
///
/// References:
/// - `docs/architecture/monorepo.md`
/// - `docs/protocol/contract-sync.md`
// ignore: one_member_abstracts — intentional DI boundary.
abstract interface class SessionListRepository {
  /// Fetches all sessions from the broker.
  Future<ListSessionsResponse> fetchSessions({bool force = false});
}

/// Query-bounded refinement implemented by current broker adapters.
abstract interface class WindowedSessionListRepository
    implements SessionListRepository {
  /// Fetches only the broker representation selected by [window].
  Future<ListSessionsResponse> fetchSessionsWindowed({
    required String window,
    bool force = false,
  });
}

/// Optional lightweight live roster capability for current brokers.
abstract interface class LiveSessionListRepository {
  /// Waits for bounded metadata/status changes after [after].
  Future<SessionRosterDeltaBatch> waitForDeltas({
    required int after,
    Duration wait = const Duration(seconds: 25),
  });

  /// Cancels the current wait when its roster is no longer foregrounded.
  void cancelDeltaWait();
}

/// Query-bounded refinement for the live roster journal.
abstract interface class WindowedLiveSessionListRepository
    implements LiveSessionListRepository {
  /// Waits for changes while omitting session payloads outside [window].
  Future<SessionRosterDeltaBatch> waitForDeltasWindowed({
    required int after,
    required String window,
    Duration wait = const Duration(seconds: 25),
  });
}

/// Expected cancellation when the roster surface leaves the foreground.
final class SessionRosterDeltaWaitCancelledException implements Exception {
  /// Creates the feature-level cancellation signal.
  const SessionRosterDeltaWaitCancelledException();
}

/// Indicates that the connected broker does not expose roster deltas.
final class SessionRosterDeltaFeedUnsupportedException implements Exception {
  /// Creates the feature-level unsupported-feed signal.
  const SessionRosterDeltaFeedUnsupportedException();
}

/// Indicates that the roster delta feed should retry after a short delay.
final class SessionRosterDeltaFeedRetryableException implements Exception {
  /// Creates a retryable feed failure while retaining its diagnostic cause.
  const SessionRosterDeltaFeedRetryableException(this.cause, this.stackTrace);

  /// Transport or broker error that interrupted the feed.
  final Object cause;

  /// Stack trace captured at the data-adapter boundary.
  final StackTrace stackTrace;
}

/// In-memory implementation of [SessionListRepository] for tests and previews.
///
/// Returns configurable fake session data without network access.
class InMemorySessionListRepository implements SessionListRepository {
  /// Creates an [InMemorySessionListRepository].
  ///
  /// [sessions] is the list of sessions to return. Defaults to empty.
  /// [delay] simulates network latency. Defaults to zero.
  /// [shouldFail] makes [fetchSessions] throw. Defaults to false.
  InMemorySessionListRepository({
    List<SessionInfo>? sessions,
    this.delay = Duration.zero,
    this.shouldFail = false,
  }) : sessions = sessions ?? const [];

  /// The sessions to return from [fetchSessions].
  List<SessionInfo> sessions;

  /// Simulated network latency.
  Duration delay;

  /// Whether [fetchSessions] should throw. Defaults to false.
  bool shouldFail;

  /// Number of times [fetchSessions] has been called.
  int fetchCount = 0;

  @override
  Future<ListSessionsResponse> fetchSessions({bool force = false}) async {
    fetchCount++;
    if (delay > Duration.zero) {
      await Future<void>.delayed(delay);
    }
    if (shouldFail) {
      throw Exception('Broker unreachable');
    }
    return ListSessionsResponse(sessions: sessions);
  }
}
