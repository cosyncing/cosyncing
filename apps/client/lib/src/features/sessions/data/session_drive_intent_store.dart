import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Sliding lease for a terminal-created/unknown session the app explicitly
/// took over.
///
/// This mirrors the broker control oracle: after the lease expires the app
/// opens Observe-first again, but the manual Take over action always remains.
/// It is refreshed only by a successful Drive attach or a real app mutation —
/// never by a timer, reconnect, or page view.
const Duration sessionDriveIntentTtl = Duration(minutes: 30);

/// Wire value for the first attach of a session the app just created.
const String kDriveAttachReasonCreate = 'create';

/// Wire value for a reopen from the durable app-created preference.
const String kDriveAttachReasonAppRestore = 'app-restore';

/// Wire value for a reopen inside the terminal-takeover sliding lease.
const String kDriveAttachReasonLeaseRestore = 'lease-restore';

/// Wire value for reusing the exact broker-owned Drive another client found.
const String kDriveAttachReasonJoinExisting = 'join-existing';

/// Wire value for an explicit, user-confirmed Take over.
const String kDriveAttachReasonTakeover = 'takeover';

/// Why the app holds Drive provenance for a session.
enum SessionDriveProvenanceKind {
  /// The session was created from the app. This is a durable control
  /// preference: it never expires and authorizes safe on-demand restoration
  /// until the user explicitly hands off, observes, detaches, or ends.
  appCreated('app-created'),

  /// A terminal-created/unknown session the app explicitly took over. Silent
  /// restoration is bounded by the [sessionDriveIntentTtl] sliding lease.
  terminalTakeover('takeover');

  const SessionDriveProvenanceKind(this.token);

  /// Stable value stored in the app settings table.
  final String token;
}

/// One durable Drive provenance record.
class SessionDriveProvenance {
  /// Creates a provenance record.
  const SessionDriveProvenance({required this.kind, required this.recordedAt});

  /// Why the app may restore Drive for this session.
  final SessionDriveProvenanceKind kind;

  /// When the record was written or last refreshed.
  final DateTime recordedAt;
}

/// Durable, per-session record of the app's Drive control provenance.
///
/// `brokerProfileId` throughout this interface carries the broker SCOPE KEY —
/// `RosterSource.storageKey`, profile AND endpoint — because provenance is
/// authority over one exact broker's session. Re-pointing a profile at
/// another machine makes every record unreadable (fail closed), including any
/// legacy record keyed by the bare profile id, so an endpoint edit can never
/// silently restore Drive on the new machine.
abstract interface class SessionDriveIntentStore {
  /// Reads the current provenance, or `null` when none is valid.
  ///
  /// A [SessionDriveProvenanceKind.terminalTakeover] record outside its
  /// sliding lease reads as `null` (and may be garbage-collected); an
  /// [SessionDriveProvenanceKind.appCreated] record never expires.
  Future<SessionDriveProvenance?> read({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  });

  /// Records the durable app-created control preference.
  ///
  /// An existing takeover lease is upgraded; an existing app-created record is
  /// refreshed in place.
  Future<void> rememberAppCreated({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  });

  /// Records or refreshes the explicit terminal-takeover sliding lease.
  ///
  /// Never downgrades a durable app-created preference: refreshing an
  /// app-created record keeps its kind.
  Future<void> rememberTakeover({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  });

  /// Clears provenance after an explicit Handoff, Observe choice,
  /// Detach/Stop driving, or session End. Transient failures never call this.
  Future<void> clear({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  });
}

/// Drift-backed [SessionDriveIntentStore] using the existing settings KV table.
class DriftSessionDriveIntentStore implements SessionDriveIntentStore {
  /// Creates the store.
  DriftSessionDriveIntentStore(
    this.database, {
    DateTime Function()? now,
  }) : _now = now ?? DateTime.now;

  /// App-local durable database.
  final AppDatabase database;
  final DateTime Function() _now;

  @override
  Future<SessionDriveProvenance?> read({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  }) async {
    final key = _key(brokerProfileId, tool, sessionId);
    final row = await (database.select(
      database.appSettingRows,
    )..where((table) => table.key.equals(key))).getSingleOrNull();
    if (row == null) return null;
    final provenance = _decode(row.value);
    if (provenance == null) {
      await _delete(key);
      return null;
    }
    if (provenance.kind == SessionDriveProvenanceKind.appCreated) {
      // Durable control preference: valid at any later time, even after
      // restart, until an explicit user exit clears it.
      return provenance;
    }
    final nowMs = _now().millisecondsSinceEpoch;
    final recordedMs = provenance.recordedAt.millisecondsSinceEpoch;
    if (nowMs >= recordedMs &&
        nowMs - recordedMs <= sessionDriveIntentTtl.inMilliseconds) {
      return provenance;
    }
    // Lease expiry blocks silent restoration only; the manual Take over
    // action does not depend on this record, so deleting it is pure hygiene.
    await _delete(key);
    return null;
  }

  @override
  Future<void> rememberAppCreated({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  }) => _write(
    brokerProfileId,
    tool,
    sessionId,
    SessionDriveProvenanceKind.appCreated,
  );

  @override
  Future<void> rememberTakeover({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  }) async {
    final existing = await read(
      brokerProfileId: brokerProfileId,
      tool: tool,
      sessionId: sessionId,
    );
    // A durable app-created preference outranks a bounded lease; a Drive
    // refresh on such a session must not silently narrow it to 30 minutes.
    final kind = existing?.kind == SessionDriveProvenanceKind.appCreated
        ? SessionDriveProvenanceKind.appCreated
        : SessionDriveProvenanceKind.terminalTakeover;
    await _write(brokerProfileId, tool, sessionId, kind);
  }

  @override
  Future<void> clear({
    required String brokerProfileId,
    required String tool,
    required String sessionId,
  }) => _delete(_key(brokerProfileId, tool, sessionId));

  Future<void> _write(
    String brokerProfileId,
    String tool,
    String sessionId,
    SessionDriveProvenanceKind kind,
  ) async {
    await database
        .into(database.appSettingRows)
        .insertOnConflictUpdate(
          AppSettingRowsCompanion.insert(
            key: _key(brokerProfileId, tool, sessionId),
            value: '${kind.token}:${_now().millisecondsSinceEpoch}',
            updatedAt: _now(),
          ),
        );
  }

  SessionDriveProvenance? _decode(String raw) {
    // Legacy records were a bare epoch-ms written by the pre-provenance
    // 30-minute intent store; read them as a takeover lease.
    final legacy = int.tryParse(raw);
    if (legacy != null) {
      return SessionDriveProvenance(
        kind: SessionDriveProvenanceKind.terminalTakeover,
        recordedAt: DateTime.fromMillisecondsSinceEpoch(legacy),
      );
    }
    final separator = raw.lastIndexOf(':');
    if (separator <= 0) return null;
    final token = raw.substring(0, separator);
    final at = int.tryParse(raw.substring(separator + 1));
    if (at == null) return null;
    for (final kind in SessionDriveProvenanceKind.values) {
      if (kind.token == token) {
        return SessionDriveProvenance(
          kind: kind,
          recordedAt: DateTime.fromMillisecondsSinceEpoch(at),
        );
      }
    }
    return null;
  }

  Future<void> _delete(String key) async {
    await (database.delete(
      database.appSettingRows,
    )..where((table) => table.key.equals(key))).go();
  }

  static String _key(String brokerProfileId, String tool, String sessionId) =>
      'session_driving_intent:${Uri.encodeComponent(brokerProfileId)}:'
      '${Uri.encodeComponent(tool)}:'
      '${Uri.encodeComponent(sessionId)}';
}

/// Provider for durable Drive provenance.
final sessionDriveIntentStoreProvider = Provider<SessionDriveIntentStore>((
  ref,
) {
  return DriftSessionDriveIntentStore(ref.watch(appDatabaseProvider));
});
