import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_list_repository.dart';

/// In-memory implementation of [SessionListRepository] for tests.
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

  /// Whether [fetchSessions] should throw.
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
