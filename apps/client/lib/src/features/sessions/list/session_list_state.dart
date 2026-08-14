import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/url_normalizer.dart';
import 'package:cosyncing_client/src/features/sessions/roster/session_roster_identity.dart';
import 'package:flutter/foundation.dart';

/// The exact broker a roster belongs to.
///
/// Profile id alone is NOT the roster source. Editing a profile's URL keeps its
/// id, so a roster, a durable snapshot or an in-flight request keyed only by id
/// can outlive the broker it came from and reappear under a profile the user
/// has already repointed somewhere else. Every roster fact in this feature is
/// therefore scoped to the profile, endpoint, and saved-row incarnation.
@immutable
final class RosterSource {
  /// Creates a roster source.
  const RosterSource({
    required this.profileId,
    required this.endpoint,
    this.incarnationId,
  });

  /// The broker [profile] currently points at.
  factory RosterSource.ofProfile(BrokerProfile profile) => RosterSource(
    profileId: profile.id,
    endpoint: normalizedBrokerEndpoint(profile.baseUri),
    incarnationId: profile.incarnationId,
  );

  /// Derives the source of [profile], or null when no profile is active.
  static RosterSource? of(BrokerProfile? profile) =>
      profile == null ? null : RosterSource.ofProfile(profile);

  /// Normalizes a broker URL for provenance comparison.
  ///
  /// Falls back to the raw string for anything the normalizer rejects: an
  /// unparseable URL must still compare equal to itself, so that a profile the
  /// client cannot normalize is treated as one unchanged source rather than as
  /// a new one on every read.
  static String normalizedBrokerEndpoint(Uri baseUri) {
    final raw = baseUri.toString();
    try {
      return normalizeBrokerUrl(raw).toString();
    } on Object {
      return raw;
    }
  }

  /// Owning broker profile id.
  final String profileId;

  /// Normalized broker endpoint the profile currently points at.
  final String endpoint;

  /// Opaque generation of the saved profile row.
  ///
  /// Null represents an unsaved or legacy profile. Durable repositories assign
  /// a non-null generation before a new profile becomes active.
  final String? incarnationId;

  /// Key that scopes broker-bound durable rows to this exact broker.
  ///
  /// This is the value written wherever local storage records what a broker
  /// said or what the app may do to one — transcripts, drafts, Drive
  /// provenance, created-session attach intents, outbox rows, negotiated
  /// hello, model preferences. A profile is an editable pointer: rows keyed
  /// by its id alone survive an endpoint edit and hand the previous machine's
  /// content and authority to the new one. The incarnation also changes after
  /// delete and re-add, so an old in-flight writer cannot publish into the
  /// replacement even when id and endpoint are identical. Rows keyed by this
  /// composite never match after either boundary — and neither does any legacy
  /// row written before source qualification existed.
  String get storageKey {
    final endpointKey =
        '${Uri.encodeComponent(profileId)}@${Uri.encodeComponent(endpoint)}';
    final generation = incarnationId;
    return generation == null
        ? endpointKey
        : '$endpointKey#${Uri.encodeComponent(generation)}';
  }

  /// Whether [storageKey] was written for [profileId] — at ANY endpoint.
  ///
  /// Profile deletion is the one flow that legitimately spans endpoints: the
  /// profile row is gone, so every broker it ever pointed at loses its local
  /// rows together. Also matches a bare legacy id, so pre-qualification rows
  /// are cleaned up rather than stranded.
  static bool storageKeyBelongsToProfile(String storageKey, String profileId) {
    if (storageKey == profileId) return true;
    return storageKey.startsWith('${Uri.encodeComponent(profileId)}@');
  }

  @override
  bool operator ==(Object other) =>
      other is RosterSource &&
      other.profileId == profileId &&
      other.endpoint == endpoint &&
      other.incarnationId == incarnationId;

  @override
  int get hashCode => Object.hash(profileId, endpoint, incarnationId);

  @override
  String toString() =>
      'RosterSource($profileId @ $endpoint # ${incarnationId ?? 'legacy'})';
}

/// Loading status for the session list.
enum SessionListStatus {
  /// Initial load in progress.
  loading,

  /// Sessions loaded successfully.
  loaded,

  /// An error occurred while loading sessions.
  error,

  /// Refreshing an already-loaded list.
  refreshing,
}

/// Why cached identity rows are on screen instead of authoritative ones (N3).
///
/// This is the typed freshness boundary: a roster row is either authoritative
/// (a [SessionInfo] with real status) or cached identity (a
/// [SessionRosterIdentity] with none). There is no third, blended state, and no
/// code path converts one into the other.
enum CachedRosterReason {
  /// The authoritative roster request is still in flight.
  hydrating,

  /// The authoritative roster request failed; the rows are last-known identity.
  unreachable,
}

/// Cached identity rows published while authoritative hydration is pending or
/// unreachable.
@immutable
final class CachedRosterPresentation {
  /// Creates a cached-roster presentation.
  const CachedRosterPresentation({
    required this.snapshot,
    required this.reason,
  });

  /// The bounded identity snapshot read once at startup.
  final SessionRosterSnapshot snapshot;

  /// Why these rows are being shown.
  final CachedRosterReason reason;

  /// Returns a copy with a different [reason].
  CachedRosterPresentation withReason(CachedRosterReason next) =>
      CachedRosterPresentation(snapshot: snapshot, reason: next);
}

/// Immutable state for the session list screen.
class SessionListState {
  /// Creates a [SessionListState].
  const SessionListState({
    this.status = SessionListStatus.loading,
    this.sessions = const [],
    this.error,
    this.machine,
    this.revision = 0,
    this.cachedRoster,
    this.source,
  });

  /// The current loading status.
  final SessionListStatus status;

  /// Broker these rows describe: profile id AND endpoint.
  ///
  /// Load-bearing, not diagnostic: every roster field here belongs to exactly
  /// one broker, so switching profile — or repointing the active profile at a
  /// different URL — must invalidate them together rather than leave the
  /// previous broker's sessions on screen under the new one's name.
  final RosterSource? source;

  /// Broker profile id these rows describe.
  String? get profileId => source?.profileId;

  /// The list of sessions.
  final List<SessionInfo> sessions;

  /// Error message, if [status] is [SessionListStatus.error].
  final String? error;

  /// Machine hostname from the broker, if available.
  final String? machine;

  /// Newest authoritative broker roster revision applied by this client.
  final int revision;

  /// Last-known identity rows for the active profile, when they are currently
  /// standing in for an authoritative roster.
  ///
  /// Null whenever authoritative rows are on screen: a successful response
  /// clears this in the SAME state assignment that publishes [sessions], so the
  /// two are never both live and the swap cannot be observed half-done.
  final CachedRosterPresentation? cachedRoster;

  /// Whether the list is currently loading (initial or refresh).
  bool get isLoading =>
      status == SessionListStatus.loading ||
      status == SessionListStatus.refreshing;

  /// Whether there are no sessions to display.
  bool get isEmpty => sessions.isEmpty && !isLoading;

  /// Returns a copy with optional overrides.
  SessionListState copyWith({
    SessionListStatus? status,
    List<SessionInfo>? sessions,
    String? error,
    String? machine,
    int? revision,
    CachedRosterPresentation? cachedRoster,
    bool clearCachedRoster = false,
    RosterSource? source,
  }) {
    return SessionListState(
      status: status ?? this.status,
      sessions: sessions ?? this.sessions,
      error: error,
      machine: machine ?? this.machine,
      revision: revision ?? this.revision,
      cachedRoster: clearCachedRoster
          ? null
          : cachedRoster ?? this.cachedRoster,
      source: source ?? this.source,
    );
  }

  @override
  String toString() =>
      'SessionListState(status: $status, sessions: ${sessions.length}, '
      'error: $error, machine: $machine, revision: $revision, '
      'source: $source, '
      'cachedRows: ${cachedRoster?.snapshot.rows.length ?? 0})';
}
