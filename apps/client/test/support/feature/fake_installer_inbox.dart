// The installer's first-run pairing inbox, in memory.
//
// Same contract as the production file inbox (`FileInstallerPairingInbox`):
// `read` claims the waiting offer, `discard` erases the claim, `release` puts
// it back for a later attempt, `hasPending` reports an offer that landed
// behind the claim, and `changes` fires when the installer drops a new one.
// The file contract itself (paths, atomic rename, locking) stays covered by
// the narrow `installer_pairing_handoff_test.dart`.
import 'dart:async';
import 'dart:convert';

import 'package:cosyncing_client/src/features/pairing/data/installer_pairing_handoff.dart';

/// In-memory installer inbox with an observable ledger and fault hooks.
class FakeInstallerInbox implements InstallerPairingInbox {
  final _changes = StreamController<void>.broadcast();
  final _waiting = <String>[];
  String? _claimed;

  /// When true, `read` throws, like an unreadable inbox directory.
  bool failRead = false;

  /// When true, `discard` reports failure and leaves the claim in place.
  bool failDiscard = false;

  /// Ledger of inbox operations, in order (`read`, `discard`, `release`).
  final List<String> operations = [];

  /// The installer drops an offer document [raw] into the inbox.
  void drop(String raw, {bool notify = false}) {
    _waiting.add(raw);
    if (notify) _changes.add(null);
  }

  /// The installer drops a well-formed offer for [qr].
  void dropOffer(
    String qr, {
    String? brokerUrl,
    DateTime? expiresAt,
    bool notify = false,
  }) => drop(
    jsonEncode({
      'qr': qr,
      'brokerUrl': ?brokerUrl,
      if (expiresAt != null) 'expiresAt': expiresAt.toUtc().toIso8601String(),
    }),
    notify: notify,
  );

  /// Whether any offer bytes remain (claimed or waiting).
  bool get holdsOffer => _claimed != null || _waiting.isNotEmpty;

  /// Whether an offer is currently claimed by the app.
  bool get isClaimed => _claimed != null;

  @override
  Future<String?> read() async {
    operations.add('read');
    if (failRead) throw StateError('inbox unreadable');
    if (_claimed != null) return _claimed;
    if (_waiting.isEmpty) return null;
    return _claimed = _waiting.removeAt(0);
  }

  @override
  Future<bool> discard() async {
    operations.add('discard');
    if (_claimed == null || failDiscard) return false;
    _claimed = null;
    return true;
  }

  @override
  Future<void> release() async {
    operations.add('release');
    final claimed = _claimed;
    if (claimed == null) return;
    _claimed = null;
    _waiting.insert(0, claimed);
  }

  @override
  Future<bool> hasPending() async => _waiting.isNotEmpty;

  @override
  Stream<void> changes() => _changes.stream;
}
