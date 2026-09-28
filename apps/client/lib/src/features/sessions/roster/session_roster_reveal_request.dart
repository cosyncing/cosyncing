import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The latest explicit open in this broker's workspace. Roster refreshes and
/// working-set persistence never publish requests or replay them on restart.
final sessionRosterRevealRequestProvider =
    StateProvider<SessionRosterRevealRequest?>((ref) {
      ref.watch(activeBrokerProfileProvider.select(RosterSource.of));
      return null;
    });

/// One navigation occurrence, even when its session is already selected.
///
/// Instance identity is intentional: two explicit opens of the same source and
/// session are distinct requests. A retained instance survives ordinary
/// rebuilds without undoing a collapse made after that navigation.
@immutable
final class SessionRosterRevealRequest {
  /// Creates a fresh reveal request for an exact broker/session identity.
  const SessionRosterRevealRequest({
    required this.sourceKey,
    required this.sessionKey,
  });

  /// Profile, endpoint and incarnation of the owning broker.
  final String sourceKey;

  /// The opened session's `tool/id` key within that broker.
  final String sessionKey;
}
