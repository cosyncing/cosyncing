import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_list_state.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// One observed authoritative activity status for one session.
@immutable
final class SessionStatusObservation {
  /// Creates an observation.
  const SessionStatusObservation({
    required this.status,
    required this.revision,
    required this.sequence,
    required this.isLive,
  });

  /// The observed activity status.
  final SessionStatus status;

  /// Roster revision this observation is ordered against.
  ///
  /// A roster publish carries the broker revision the rows describe. A live
  /// session frame carries the newest roster revision this client had already
  /// applied when the frame arrived — its *floor*.
  final int revision;

  /// Monotone client-side arrival order, breaking ties between like sources.
  final int sequence;

  /// Whether this came from a session socket rather than the roster.
  final bool isLive;

  /// Whether [other] describes a newer authoritative fact than this one.
  ///
  /// Ordered by `(revision, live-over-roster, arrival)`.
  ///
  /// The middle term is the load-bearing one. Every status change advances the
  /// broker's roster journal, so a live frame observed while the client held
  /// revision R describes a fact the journal will record *after* R. A roster
  /// snapshot still reporting R was therefore generated before that fact
  /// existed, and must lose no matter how late it happens to arrive — which is
  /// exactly the regression where a slow roster response reinstated a Working
  /// row for a turn that had already finished.
  bool isSupersededBy(SessionStatusObservation other) {
    if (other.revision != revision) return other.revision > revision;
    if (other.isLive != isLive) return other.isLive;
    return other.sequence > sequence;
  }
}

/// Immutable published view of the registry.
@immutable
final class SessionStatusSnapshot {
  /// Creates a snapshot.
  const SessionStatusSnapshot({
    required this.source,
    required this.observations,
  });

  /// An empty snapshot for [source].
  factory SessionStatusSnapshot.empty(RosterSource? source) =>
      SessionStatusSnapshot(source: source, observations: const {});

  /// Broker the observations belong to.
  final RosterSource? source;

  /// Observations keyed by `tool\u0000sessionId`.
  final Map<String, SessionStatusObservation> observations;

  /// Newest authoritative status for one session, or null when none is known.
  SessionStatus? statusFor({required String tool, required String sessionId}) =>
      observations[sessionStatusKey(tool: tool, sessionId: sessionId)]?.status;

  /// [sessions] with each row's status replaced by the newest authoritative
  /// observation, when one exists.
  ///
  /// A roster row is itself an observation, so this only ever moves a row
  /// forward: the registry rejected anything older than the roster revision the
  /// row came from before it was stored.
  List<SessionInfo> apply(List<SessionInfo> sessions) {
    if (observations.isEmpty) return sessions;
    List<SessionInfo>? updated;
    for (var index = 0; index < sessions.length; index++) {
      final session = sessions[index];
      final status = statusFor(tool: session.tool, sessionId: session.id);
      if (status == null || status == session.status) continue;
      updated ??= List<SessionInfo>.of(sessions);
      updated[index] = SessionInfo.fromJson({
        ...session.toJson(),
        'status': sessionStatusWireValue(status),
      });
    }
    return updated ?? sessions;
  }
}

/// Registry key for one session inside one broker profile.
String sessionStatusKey({required String tool, required String sessionId}) =>
    '$tool\u0000$sessionId';

/// Broker wire value for [status].
String sessionStatusWireValue(SessionStatus status) => switch (status) {
  SessionStatus.working => 'working',
  SessionStatus.needsInput => 'needs-input',
  SessionStatus.idle => 'idle',
};

/// The single client-side owner of session activity status (R0b).
///
/// Before this registry the roster and each open Session Detail derived
/// Working/Idle independently: the detail folded its own socket's authoritative
/// `session` frame immediately, while the roster could only learn the same
/// transition by completing a bounded delta round trip. With both surfaces on
/// screen (Expanded) they disagreed, and whenever the roster feed was not
/// running — backgrounded, unsupported, or inside a retry window — the roster
/// kept the stale value until a page refresh.
///
/// Every authoritative observation now lands here, ordered by
/// `(rosterRevision, live-over-roster, arrivalSequence)`, and the roster
/// renders what this registry says. A late roster snapshot cannot overwrite a
/// newer live transition: a live observation is floored at the roster revision
/// the client had applied, and outranks a roster entry at that same revision.
///
/// Bounded and profile-qualified: observations belong to exactly one
/// [RosterSource] and are dropped wholesale when it changes; at most
/// [maxObservations] sessions are retained, evicting the least recently
/// observed first.
class SessionStatusRegistry extends Notifier<SessionStatusSnapshot> {
  /// Hard cap on retained per-session observations.
  static const int maxObservations = 512;

  final Map<String, SessionStatusObservation> _observations = {};
  RosterSource? _source;
  var _sequence = 0;

  @override
  SessionStatusSnapshot build() => SessionStatusSnapshot.empty(null);

  /// Drops every observation that does not belong to [source].
  void adoptSource(RosterSource? source) {
    if (_source == source) return;
    _source = source;
    _observations.clear();
    _publish();
  }

  /// Captures the last status arrival admitted before a snapshot request.
  int captureRevisionAdmission() => _sequence;

  /// Starts a new broker revision namespace for the same source.
  ///
  /// Query windows own independent broker journals. Switching from Any time to
  /// seven days can therefore legitimately move from revision 900 to revision
  /// 2. Live observations that arrived while the snapshot request was in
  /// flight are newer than that snapshot and are rebased onto its revision.
  /// Older live observations are incomparable and are discarded.
  void resetRevisionNamespace({
    required RosterSource? source,
    required int revision,
    required int preserveLiveAfterSequence,
  }) {
    final preserve = _source == source
        ? _observations.entries
              .where(
                (entry) =>
                    entry.value.isLive &&
                    entry.value.sequence > preserveLiveAfterSequence,
              )
              .toList(growable: false)
        : const <MapEntry<String, SessionStatusObservation>>[];
    _source = source;
    _observations
      ..clear()
      ..addEntries(
        preserve.map(
          (entry) => MapEntry(
            entry.key,
            SessionStatusObservation(
              status: entry.value.status,
              revision: revision,
              sequence: entry.value.sequence,
              isLive: true,
            ),
          ),
        ),
      );
    _publish();
  }

  /// Records the authoritative roster rows at [revision].
  void publishRoster({
    required RosterSource? source,
    required int revision,
    required List<SessionInfo> sessions,
  }) {
    if (!_adopt(source)) return;
    var changed = false;
    for (final session in sessions) {
      changed =
          _record(
            key: sessionStatusKey(tool: session.tool, sessionId: session.id),
            observation: SessionStatusObservation(
              status: session.status,
              revision: revision,
              sequence: ++_sequence,
              isLive: false,
            ),
          ) ||
          changed;
    }
    if (changed) _publish();
  }

  /// Records one authoritative live transition observed on a session socket.
  ///
  /// [rosterRevisionFloor] is the newest roster revision this client has
  /// applied. It is what makes the ordering total without a clock: a roster
  /// snapshot generated before this frame carries a revision at or below the
  /// floor and loses; one generated after carries a higher revision and wins.
  void publishLive({
    required RosterSource? source,
    required String tool,
    required String sessionId,
    required SessionStatus status,
    required int rosterRevisionFloor,
  }) {
    if (!_adopt(source)) return;
    final changed = _record(
      key: sessionStatusKey(tool: tool, sessionId: sessionId),
      observation: SessionStatusObservation(
        status: status,
        revision: rosterRevisionFloor,
        sequence: ++_sequence,
        isLive: true,
      ),
    );
    if (changed) _publish();
  }

  /// Whether [source] owns the registry now, adopting it when it changed.
  bool _adopt(RosterSource? source) {
    if (source == null) return false;
    if (_source != source) {
      _source = source;
      _observations.clear();
    }
    return true;
  }

  bool _record({
    required String key,
    required SessionStatusObservation observation,
  }) {
    final current = _observations[key];
    if (current != null && !current.isSupersededBy(observation)) return false;
    _observations
      ..remove(key)
      ..[key] = observation;
    _evictToBound();
    return current?.status != observation.status;
  }

  /// Least-recently-observed eviction; insertion order is observation order
  /// because every accepted record re-inserts its key.
  void _evictToBound() {
    while (_observations.length > maxObservations) {
      final oldest = _observations.keys.first;
      _observations.remove(oldest);
    }
  }

  void _publish() {
    state = SessionStatusSnapshot(
      source: _source,
      observations: Map<String, SessionStatusObservation>.unmodifiable(
        Map<String, SessionStatusObservation>.of(_observations),
      ),
    );
  }
}

/// Provider for the single client-side session-status owner.
final sessionStatusRegistryProvider =
    NotifierProvider<SessionStatusRegistry, SessionStatusSnapshot>(
      SessionStatusRegistry.new,
    );
