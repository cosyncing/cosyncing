import 'package:cosyncing_client/src/features/sessions/data/session_detail_connection.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_list_state.dart';
import 'package:flutter/foundation.dart';

/// The one typed freshness state every roster and session surface presents.
///
/// Before R0b the same underlying transition had four visual owners: a Compact
/// spinner replacing Refresh, an Expanded `Updating…` subtitle, the
/// cached-roster pane's own sync icon, and a Session Detail control pill that
/// kept claiming Driving/Synced from data the socket could no longer vouch for.
/// They could all be active at once and none of them agreed.
///
/// The causes stay typed — Debug and recovery still need to tell "reconnecting
/// with cached data" from "the last request failed" — but the normal surface
/// has exactly one visual owner per region.
enum SessionFreshness {
  /// Nothing has been shown yet; the first authoritative load is in flight.
  initialLoading,

  /// Current data is on screen and a refresh is in flight.
  refreshing,

  /// Last-known data is on screen and the transport is being re-established.
  reconnecting,

  /// The data on screen is authoritative and current.
  current,

  /// The last attempt failed and the user has an action to take.
  failed;

  /// Whether a progress affordance belongs in the shared status slot.
  bool get isBusy =>
      this == SessionFreshness.initialLoading ||
      this == SessionFreshness.refreshing ||
      this == SessionFreshness.reconnecting;

  /// Whether what is on screen is last-known rather than authoritative.
  bool get isStale => this == SessionFreshness.reconnecting;
}

/// Roster freshness plus the actionable detail the failure state needs.
@immutable
final class RosterFreshnessPresentation {
  /// Creates a roster freshness presentation.
  const RosterFreshnessPresentation({
    required this.freshness,
    this.error,
    this.slotOwnsRecovery = false,
  });

  /// Derives the single roster freshness state from list state.
  ///
  /// Deliberately total: every [SessionListStatus] and cached-roster
  /// combination maps to exactly one state, so no surface can invent a sixth.
  factory RosterFreshnessPresentation.fromListState(SessionListState state) {
    final cached = state.cachedRoster;
    if (state.status == SessionListStatus.error) {
      // A completed failure is FAILED, never busy. Calling it `reconnecting`
      // because rows survived made the shared slot spin forever with nothing in
      // flight, and it hid the one action the user actually has. Retained rows
      // change who owns recovery, not whether the refresh failed.
      return RosterFreshnessPresentation(
        freshness: SessionFreshness.failed,
        error: state.error,
        // Exactly one surface offers Retry, in both layouts. Authoritative rows
        // render no banner of their own, so the slot owns recovery; a cached
        // pane or the empty error page states its own reason and keeps it.
        slotOwnsRecovery: state.sessions.isNotEmpty,
      );
    }
    if (cached != null && state.sessions.isEmpty) {
      return const RosterFreshnessPresentation(
        freshness: SessionFreshness.reconnecting,
      );
    }
    return switch (state.status) {
      SessionListStatus.loading => RosterFreshnessPresentation(
        freshness: state.sessions.isEmpty
            ? SessionFreshness.initialLoading
            : SessionFreshness.refreshing,
      ),
      SessionListStatus.refreshing => const RosterFreshnessPresentation(
        freshness: SessionFreshness.refreshing,
      ),
      SessionListStatus.loaded => const RosterFreshnessPresentation(
        freshness: SessionFreshness.current,
      ),
      SessionListStatus.error => const RosterFreshnessPresentation(
        freshness: SessionFreshness.failed,
      ),
    };
  }

  /// The single freshness state for the roster's status slot.
  final SessionFreshness freshness;

  /// Actionable failure text, when [freshness] is [SessionFreshness.failed].
  final String? error;

  /// Whether the shared slot is the surface that offers Retry.
  ///
  /// False when the content on screen carries its own reason and action (the
  /// cached-roster banner, the empty error page), so Retry never has two
  /// owners at once.
  final bool slotOwnsRecovery;
}

/// Session Detail freshness for the control/status footprint.
@immutable
final class SessionDetailFreshnessPresentation {
  /// Creates a detail freshness presentation.
  const SessionDetailFreshnessPresentation({required this.freshness});

  /// Derives the detail's freshness from its own transport and session frame.
  ///
  /// The control pill describes broker-owned ownership (Driving/Synced/
  /// Observing). That claim is only true while the socket that published it is
  /// connected AND has delivered an authoritative `SessionInfo`. Anything else
  /// is last-known, so the pill reads Reconnecting/Refreshing instead and the
  /// control actions it gates are unavailable until a current frame arrives.
  factory SessionDetailFreshnessPresentation.fromState(
    SessionDetailState state,
  ) {
    final connected =
        state.connectionStatus == SessionDetailConnectionStatus.connected;
    if (!connected) {
      return switch (state.connectionStatus) {
        SessionDetailConnectionStatus.connecting =>
          SessionDetailFreshnessPresentation(
            freshness: state.sessionInfo == null
                ? SessionFreshness.initialLoading
                : SessionFreshness.reconnecting,
          ),
        _ => const SessionDetailFreshnessPresentation(
          freshness: SessionFreshness.reconnecting,
        ),
      };
    }
    if (state.sessionInfo == null) {
      // Connected but the authoritative session frame has not landed yet: the
      // socket is healthy, so this is a refresh of current data, not a
      // reconnect with stale data.
      return const SessionDetailFreshnessPresentation(
        freshness: SessionFreshness.refreshing,
      );
    }
    return const SessionDetailFreshnessPresentation(
      freshness: SessionFreshness.current,
    );
  }

  /// The single freshness state for the detail's control footprint.
  final SessionFreshness freshness;

  /// Whether the broker-authored control pill may be rendered.
  ///
  /// Only a current frame authorizes Driving/Synced/Observing copy.
  bool get controlIsAuthoritative => freshness == SessionFreshness.current;
}
