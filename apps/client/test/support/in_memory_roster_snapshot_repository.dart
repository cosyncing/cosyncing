import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/roster/roster_snapshot_store.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_identity.dart';

/// Roster snapshot storage with no database behind it.
///
/// The production provider opens the app's Drift database, so any widget test
/// that mounts the sessions feature without overriding it stands up another
/// connection to the same file — which is where the "multiple databases" noise
/// in the widget suite came from, and a real cross-test coupling underneath it.
/// Page harnesses default to this; a test that is actually about the cached
/// roster passes its own double instead.
final class InMemoryRosterSnapshotRepository
    implements RosterSnapshotRepository {
  /// Creates an empty store.
  InMemoryRosterSnapshotRepository();

  final Map<String, SessionRosterSnapshot> _byProfile = {};

  /// What each profile last saved, in call order.
  Map<String, SessionRosterSnapshot> get stored => Map.unmodifiable(_byProfile);

  @override
  Future<SessionRosterSnapshot?> load(
    String brokerProfileId, {
    required String endpoint,
  }) async => _byProfile[brokerProfileId];

  @override
  Future<SessionRosterSnapshot> save({
    required String brokerProfileId,
    required String endpoint,
    required List<SessionInfo> sessions,
    DateTime? now,
  }) async {
    final snapshot = SessionRosterSnapshot(
      brokerProfileId: brokerProfileId,
      rows: [
        for (final session in sessions)
          SessionRosterIdentity.fromSession(session),
      ],
      capturedAt: now ?? DateTime.now(),
      omittedRowCount: 0,
    );
    _byProfile[brokerProfileId] = snapshot;
    return snapshot;
  }

  @override
  Future<void> deleteForProfile(String brokerProfileId) async {
    _byProfile.remove(brokerProfileId);
  }
}
