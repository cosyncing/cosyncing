import 'package:cosyncing_client/src/features/sessions/sessions.dart';

final class InMemorySessionLiveStateViewStore
    implements SessionLiveStateViewStore {
  final Map<SessionDetailKey, Map<String, String>> _archived = {};

  @override
  Future<Map<String, String>> loadArchived(SessionDetailKey sessionKey) async {
    return Map.unmodifiable(_archived[sessionKey] ?? const {});
  }

  @override
  Future<void> saveArchived(
    SessionDetailKey sessionKey,
    Map<String, String> archived,
  ) async {
    _archived[sessionKey] = Map.of(archived);
  }
}
