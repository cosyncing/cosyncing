import 'dart:async';

import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// One in-flight-retirement ledger per Riverpod container (app window).
final sessionDetailRetirementLedgerProvider =
    Provider<SessionDetailRetirementLedger>(
      (ref) => SessionDetailRetirementLedger(),
    );

/// Pending session-transport retirements, visible across widget incarnations.
///
/// A retirement — suspend transport, close the resident subscription,
/// invalidate the detail provider — is asynchronous, while the widgets that
/// own it are not: the credential gate can unmount the whole Sessions subtree
/// and remount a replacement before the outgoing supervisor's retirements
/// finish. Retirement state kept on the widget's own State object dies with
/// it, so the replacement would adopt the still-live controller — and with it
/// a connection resolver captured before the credential change.
///
/// The ledger lives in the container, which survives the remount. Whoever
/// starts a retirement registers it here; whoever wants to attach a session
/// first waits for that key's pending retirement, then builds a fresh
/// controller from current truth.
final class SessionDetailRetirementLedger {
  final Map<SessionDetailKey, Future<void>> _pending = {};

  /// The pending retirement for [key], or null when the key is free.
  ///
  /// The returned future never errors: a transport that fails its own
  /// teardown still frees the key.
  Future<void>? pendingFor(SessionDetailKey key) => _pending[key];

  /// Records [retirement] as pending for [key].
  ///
  /// A retirement registered while another is still pending COMPOSES with it:
  /// the key is freed only once every overlapping retirement has settled.
  /// Overwriting instead would let the later retirement free the key while
  /// the earlier one can still invalidate the controller an adopter just
  /// built on it — the exact clobbering the ledger exists to prevent.
  ///
  /// Returns the settled (never-erroring) future the ledger tracks. The key
  /// is freed before any callback attached to the returned future runs, so a
  /// completion-triggered reconcile already sees the key as free.
  Future<void> register(SessionDetailKey key, Future<void> retirement) {
    final sanitized = retirement.then<void>(
      (_) {},
      onError: (Object _, StackTrace _) {},
    );
    final previous = _pending[key];
    final joined = previous == null
        ? sanitized
        : Future.wait<void>([previous, sanitized]).then<void>((_) {});
    late final Future<void> settled;
    settled = joined.whenComplete(() {
      if (identical(_pending[key], settled)) _pending.remove(key);
    });
    _pending[key] = settled;
    return settled;
  }
}
