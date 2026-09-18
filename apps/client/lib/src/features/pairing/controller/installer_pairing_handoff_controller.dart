import 'package:cosyncing_client/src/features/pairing/controller/pairing_controller.dart';
import 'package:cosyncing_client/src/features/pairing/data/installer_pairing_handoff.dart';
import 'package:cosyncing_client/src/features/pairing/data/installer_pairing_inbox.dart';
import 'package:cosyncing_client/src/features/pairing/data/secure_storage_preflight.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// What became of the installer's pairing handoff on this launch.
enum InstallerPairingHandoffOutcome {
  /// There was no handoff file to read.
  absent,

  /// The handoff was redeemed and its credential and active profile were saved.
  imported,

  /// The pairing controller could not redeem, save, or activate the handoff.
  failed,

  /// Platform secure storage was not ready, so the offer was kept for retry.
  secureStorageUnavailable,

  /// The offer could not be removed safely, so it was not redeemed.
  discardFailed,

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

/// Secure-storage readiness check performed before one-use redemption.
final installerPairingStoragePreflightProvider =
    Provider<SecureStoragePreflight>(
      (ref) => verifySecureStorage,
    );

/// Delay between bounded secure-storage readiness attempts.
final installerPairingRetryDelayProvider =
    Provider<Future<void> Function(Duration)>(
      (ref) => Future<void>.delayed,
    );

/// Whether startup is actively finishing an installer pairing handoff.
final installerPairingInProgressProvider = StateProvider<bool>((ref) => false);

const List<Duration> _storageRetryDelays = <Duration>[
  Duration(milliseconds: 250),
  Duration(milliseconds: 500),
  Duration(seconds: 1),
  Duration(seconds: 2),
];

/// Consumes the installer's pairing handoff once, at startup.
///
/// The all-in-one installer pairs the broker it just set up with the client it
/// just placed, and leaves the offer in a file for this launch to redeem. Read
/// once, checked for secure-storage readiness, deleted, then redeemed: a second
/// launch must never find it again after redemption starts,
/// even if this one never finishes redeeming, and no outcome here may keep the
/// app from starting. A secure-storage readiness failure keeps the unredeemed
/// offer for a later launch; every failure after deletion falls back to manual
/// pairing.
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
      ref.read(installerPairingInProgressProvider.notifier).state = true;
      var handoffClaimed = false;
      try {
        final handoff = parseInstallerPairingHandoff(raw);
        if (handoff == null) {
          if (!await inbox.discard()) {
            return InstallerPairingHandoffOutcome.discardFailed;
          }
          return InstallerPairingHandoffOutcome.unreadable;
        }
        final now = ref.read(installerPairingClockProvider)();
        if (handoff.hasExpired(now)) {
          if (!await inbox.discard()) {
            return InstallerPairingHandoffOutcome.discardFailed;
          }
          return InstallerPairingHandoffOutcome.expired;
        }

        final preflight = ref.read(installerPairingStoragePreflightProvider);
        final delay = ref.read(installerPairingRetryDelayProvider);
        var storageReady = false;
        for (
          var attempt = 0;
          attempt <= _storageRetryDelays.length;
          attempt += 1
        ) {
          try {
            await preflight();
            storageReady = true;
            break;
          } on Object {
            if (attempt == _storageRetryDelays.length ||
                handoff.hasExpired(ref.read(installerPairingClockProvider)())) {
              break;
            }
            await delay(_storageRetryDelays[attempt]);
          }
        }
        if (!storageReady) {
          if (handoff.hasExpired(ref.read(installerPairingClockProvider)())) {
            if (!await inbox.discard()) {
              return InstallerPairingHandoffOutcome.discardFailed;
            }
            return InstallerPairingHandoffOutcome.expired;
          }
          return InstallerPairingHandoffOutcome.secureStorageUnavailable;
        }

        // Delete BEFORE broker acceptance. Acceptance consumes the one-use
        // offer before the platform credential writes finish, so deleting only
        // after import would leave an already-consumed offer after a crash.
        if (!await inbox.discard()) {
          return InstallerPairingHandoffOutcome.discardFailed;
        }
        handoffClaimed = true;
        await ref
            .read(pairingControllerProvider.notifier)
            .importPayload(handoff.qr, brokerUrl: handoff.brokerUrl);
        final notice = ref.read(pairingControllerProvider).notice;
        return notice == PairingNotice.paired ||
                notice == PairingNotice.devicePaired
            ? InstallerPairingHandoffOutcome.imported
            : InstallerPairingHandoffOutcome.failed;
      } on Object {
        return handoffClaimed
            ? InstallerPairingHandoffOutcome.failed
            : InstallerPairingHandoffOutcome.unreadable;
      } finally {
        ref.read(installerPairingInProgressProvider.notifier).state = false;
      }
    });
