import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:flutter/foundation.dart';

/// Readiness for the initial transcript bootstrap.
@immutable
final class SessionDetailBootstrapState {
  /// Creates a bootstrap status snapshot.
  const SessionDetailBootstrapState({
    this.readiness = SessionDetailBootstrapReadiness.idle,
    this.attempt = 0,
    this.hasCachedMessages = false,
    this.failureKind,
    this.failureSource,
  });

  /// Current bootstrap readiness.
  final SessionDetailBootstrapReadiness readiness;

  /// Incremented for each attach attempt so stale async work cannot win.
  final int attempt;

  /// True when transcript messages can remain visible during this bootstrap.
  ///
  /// This includes a persisted snapshot loaded for the first attach and the
  /// already-visible transcript retained across a later retry.
  final bool hasCachedMessages;

  /// Failure kind, used for recovery copy after modeled failures.
  final FailureKind? failureKind;

  /// Unlocalized failure family for a localized lead sentence.
  final SessionDetailBootstrapFailureSource? failureSource;

  /// Whether this attempt is waiting for the first authoritative history event.
  bool get isWaitingForInitialHistory =>
      readiness == SessionDetailBootstrapReadiness.awaitingInitialHistory;

  /// Whether this attempt has reached a terminal failure.
  bool get hasFailed => switch (readiness) {
    SessionDetailBootstrapReadiness.failed ||
    SessionDetailBootstrapReadiness.historyTimeout => true,
    SessionDetailBootstrapReadiness.idle ||
    SessionDetailBootstrapReadiness.resolvingProfile ||
    SessionDetailBootstrapReadiness.hydratingCachedTranscript ||
    SessionDetailBootstrapReadiness.attachingSocket ||
    SessionDetailBootstrapReadiness.awaitingInitialHistory ||
    SessionDetailBootstrapReadiness.ready => false,
  };

  /// Whether cached transcript content should remain visible during bootstrap.
  bool get keepShowingMessages => hasCachedMessages;

  /// Produces a copy with optional field overrides.
  SessionDetailBootstrapState copyWith({
    SessionDetailBootstrapReadiness? readiness,
    int? attempt,
    bool? hasCachedMessages,
    FailureKind? failureKind,
    SessionDetailBootstrapFailureSource? failureSource,
    bool clearFailure = false,
  }) {
    return SessionDetailBootstrapState(
      readiness: readiness ?? this.readiness,
      attempt: attempt ?? this.attempt,
      hasCachedMessages: hasCachedMessages ?? this.hasCachedMessages,
      failureKind: clearFailure ? null : (failureKind ?? this.failureKind),
      failureSource: clearFailure
          ? null
          : (failureSource ?? this.failureSource),
    );
  }

  /// Returns a typed state for profile resolution.
  SessionDetailBootstrapState resolvingProfile({
    required int attempt,
    required bool hasCachedMessages,
  }) => SessionDetailBootstrapState(
    readiness: SessionDetailBootstrapReadiness.resolvingProfile,
    attempt: attempt,
    hasCachedMessages: hasCachedMessages,
  );

  /// Returns a typed state for cache hydration.
  SessionDetailBootstrapState hydratingCache({
    required int attempt,
    required bool hasCachedMessages,
  }) => SessionDetailBootstrapState(
    readiness: SessionDetailBootstrapReadiness.hydratingCachedTranscript,
    attempt: attempt,
    hasCachedMessages: hasCachedMessages,
  );

  /// Returns a typed state for socket attach.
  SessionDetailBootstrapState attachingSocket({
    required int attempt,
    required bool hasCachedMessages,
  }) => SessionDetailBootstrapState(
    readiness: SessionDetailBootstrapReadiness.attachingSocket,
    attempt: attempt,
    hasCachedMessages: hasCachedMessages,
  );

  /// Returns a typed state for waiting on the first initial history event.
  SessionDetailBootstrapState awaitingInitialHistory({
    required int attempt,
    required bool hasCachedMessages,
  }) => SessionDetailBootstrapState(
    readiness: SessionDetailBootstrapReadiness.awaitingInitialHistory,
    attempt: attempt,
    hasCachedMessages: hasCachedMessages,
  );

  /// Returns the ready state after the first authoritative history event.
  SessionDetailBootstrapState ready({
    required int attempt,
    required bool hasCachedMessages,
  }) => SessionDetailBootstrapState(
    readiness: SessionDetailBootstrapReadiness.ready,
    attempt: attempt,
    hasCachedMessages: hasCachedMessages,
  );

  /// Returns a modeled terminal failure state.
  SessionDetailBootstrapState failure({
    required int attempt,
    required FailureKind kind,
    required SessionDetailBootstrapFailureSource source,
    bool hasCachedMessages = false,
    bool timeout = false,
  }) => SessionDetailBootstrapState(
    readiness: timeout
        ? SessionDetailBootstrapReadiness.historyTimeout
        : SessionDetailBootstrapReadiness.failed,
    attempt: attempt,
    failureKind: kind,
    failureSource: source,
    hasCachedMessages: hasCachedMessages,
  );
}

/// Attach lifecycle states for the first post-connect transcript gate.
enum SessionDetailBootstrapReadiness {
  /// No active attempt.
  idle,

  /// Resolving the active profile/client for this attach attempt.
  resolvingProfile,

  /// Loading a persisted transcript snapshot before the live stream begins.
  hydratingCachedTranscript,

  /// Connecting or reattaching the live stream.
  attachingSocket,

  /// Waiting for the first authoritative stream history event.
  awaitingInitialHistory,

  /// First authoritative history event arrived.
  ready,

  /// Failed to establish bootstrap for a modeled reason.
  failed,

  /// Timed out waiting for an authoritative history frame.
  historyTimeout,
}

/// Distinct non-localized failure families for bootstrap copy.
enum SessionDetailBootstrapFailureSource {
  /// No active broker profile was selected.
  noProfile,

  /// Connect/reattach failed.
  attach,

  /// The initial history event did not arrive within timeout.
  historyTimeout,
}
