import 'package:cosyncing_client/src/features/pairing/controller/pairing_controller.dart';
import 'package:cosyncing_client/src/features/pairing/data/installer_pairing_handoff.dart';
import 'package:cosyncing_client/src/features/pairing/data/installer_pairing_inbox.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// What became of the installer's pairing handoff on this launch.
enum InstallerPairingHandoffOutcome {
  /// There was no handoff file to read.
  absent,

  /// A handoff was read and its payload was handed to the pairing controller.
  imported,

  /// A handoff was read and had already expired, so it was discarded unused.
  expired,

  /// A handoff was read and could not be understood, so it was discarded.
  unreadable,
}

/// Source of the installer's one-shot pairing handoff.
///
/// A provider so tests can supply one; the app always gets the real file.
final installerPairingInboxProvider = Provider<InstallerPairingInbox>(
  (ref) => const FileInstallerPairingInbox(),
);

/// Clock the handoff's expiry is judged against. Overridden in tests.
final installerPairingClockProvider = Provider<DateTime Function()>(
  (ref) => DateTime.now,
);

/// Consumes the installer's pairing handoff once, at startup.
///
/// The all-in-one installer pairs the broker it just set up with the client it
/// just placed, and leaves the offer in a file for this launch to redeem. Read
/// once, deleted, then redeemed: a second launch must never find it again,
/// even if this one never finishes redeeming, and no outcome here may keep the
/// app from starting. Every failure ends the same way — the file is gone and
/// the user pairs by hand, which is what they would have done anyway.
final installerPairingHandoffProvider =
    FutureProvider<InstallerPairingHandoffOutcome>((ref) async {
      final inbox = ref.read(installerPairingInboxProvider);
      String? raw;
      try {
        raw = await inbox.read();
      } on Object {
        return InstallerPairingHandoffOutcome.absent;
      }
      if (raw == null) return InstallerPairingHandoffOutcome.absent;
      // Deleted BEFORE it is redeemed, not after. The bytes are in
      // hand, so the file has no further purpose, while redeeming
      // can take a long time: it calls the broker and then writes
      // the platform credential store, and on macOS a keychain
      // write can sit on a user prompt. Observed on a real Mac —
      // the broker had registered the peer while the offer was
      // still on disk, because `importPayload` had not returned
      // and the discard was waiting behind it. Removing it first
      // makes the one-use rule hold when the app is closed
      // mid-import, not only when the import returns.
      await inbox.discard();
      try {
        final handoff = parseInstallerPairingHandoff(raw);
        if (handoff == null) return InstallerPairingHandoffOutcome.unreadable;
        final now = ref.read(installerPairingClockProvider)();
        if (handoff.hasExpired(now)) {
          return InstallerPairingHandoffOutcome.expired;
        }
        await ref
            .read(pairingControllerProvider.notifier)
            .importPayload(handoff.qr, brokerUrl: handoff.brokerUrl);
        return InstallerPairingHandoffOutcome.imported;
      } on Object {
        return InstallerPairingHandoffOutcome.unreadable;
      }
    });
