import 'package:cosyncing_client/src/features/connection/model/real_broker_health_probe.dart';
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

  /// The broker stayed unavailable, so the claimed offer was kept for retry.
  brokerUnavailable,

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
  (ref) => FileInstallerPairingInbox(),
);

/// Native inbox events let an already-open client consume a new handoff.
final installerPairingInboxChangesProvider = StreamProvider<void>(
  (ref) => ref.watch(installerPairingInboxProvider).changes(),
);

/// Clock the handoff's expiry is judged against. Overridden in tests.
final installerPairingClockProvider = Provider<DateTime Function()>(
  (ref) => DateTime.now,
);

/// Secure-storage readiness check performed before one-use redemption.
final installerPairingStoragePreflightProvider =
    Provider<SecureStoragePreflight>((ref) => verifySecureStorage);

/// Safe readiness probe run before the one-use acceptance request.
final installerPairingBrokerPreflightProvider =
    Provider<Future<void> Function(String)>((ref) => _verifyBrokerReady);

/// Delay between bounded secure-storage readiness attempts.
final installerPairingRetryDelayProvider =
    Provider<Future<void> Function(Duration)>((ref) => Future<void>.delayed);

/// Whether startup is actively finishing an installer pairing handoff.
final installerPairingInProgressProvider = StateProvider<bool>((ref) => false);

const List<Duration> _storageRetryDelays = <Duration>[
  Duration(milliseconds: 250),
  Duration(milliseconds: 500),
  Duration(seconds: 1),
  Duration(seconds: 2),
];

const List<Duration> _brokerRetryDelays = <Duration>[
  Duration(seconds: 1),
  Duration(seconds: 2),
  Duration(seconds: 4),
  Duration(seconds: 8),
  Duration(seconds: 16),
];

Future<void> _verifyBrokerReady(String brokerUrl) async {
  final health = await RealBrokerHealthProbe(
    timeout: const Duration(seconds: 5),
  ).probe(Uri.parse(brokerUrl));
  if (!health.isSuccess) {
    throw StateError('Broker health check was not ready.');
  }
}

/// Consumes the installer's pairing handoff once, at startup.
///
/// The all-in-one installer pairs the broker it just set up with the client it
/// just placed, and leaves the offer in a file for this launch to redeem. Read
/// once, checked for secure-storage readiness, atomically claimed, then
/// redeemed. The claim prevents concurrent redemption but survives a crash or
/// transient broker startup failure. Success and terminal failures erase it;
/// recoverable failures release it for a later attempt.
final installerPairingHandoffProvider =
    FutureProvider<InstallerPairingHandoffOutcome>((ref) async {
      final inbox = ref.read(installerPairingInboxProvider);
      var emptyOutcome = InstallerPairingHandoffOutcome.absent;
      while (true) {
        String? raw;
        try {
          raw = await inbox.read();
        } on Object {
          return emptyOutcome;
        }
        if (raw == null) return emptyOutcome;
        ref.read(installerPairingInProgressProvider.notifier).state = true;
        try {
          final handoff = parseInstallerPairingHandoff(raw);
          if (handoff == null) {
            if (!await inbox.discard()) {
              return InstallerPairingHandoffOutcome.discardFailed;
            }
            emptyOutcome = InstallerPairingHandoffOutcome.unreadable;
            if (await inbox.hasPending()) continue;
            return InstallerPairingHandoffOutcome.unreadable;
          }
          final now = ref.read(installerPairingClockProvider)();
          if (handoff.hasExpired(now)) {
            if (!await inbox.discard()) {
              return InstallerPairingHandoffOutcome.discardFailed;
            }
            emptyOutcome = InstallerPairingHandoffOutcome.expired;
            if (await inbox.hasPending()) continue;
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
                  handoff.hasExpired(
                    ref.read(installerPairingClockProvider)(),
                  )) {
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
              emptyOutcome = InstallerPairingHandoffOutcome.expired;
              if (await inbox.hasPending()) continue;
              return InstallerPairingHandoffOutcome.expired;
            }
            await inbox.release();
            return InstallerPairingHandoffOutcome.secureStorageUnavailable;
          }

          final brokerUrl = handoff.brokerUrl;
          if (brokerUrl != null) {
            final brokerPreflight = ref.read(
              installerPairingBrokerPreflightProvider,
            );
            var brokerReady = false;
            for (
              var attempt = 0;
              attempt <= _brokerRetryDelays.length;
              attempt += 1
            ) {
              try {
                await brokerPreflight(brokerUrl);
                brokerReady = true;
                break;
              } on Object {
                if (attempt == _brokerRetryDelays.length ||
                    handoff.hasExpired(
                      ref.read(installerPairingClockProvider)(),
                    )) {
                  break;
                }
                await delay(_brokerRetryDelays[attempt]);
              }
            }
            if (!brokerReady) {
              if (handoff.hasExpired(
                ref.read(installerPairingClockProvider)(),
              )) {
                if (!await inbox.discard()) {
                  return InstallerPairingHandoffOutcome.discardFailed;
                }
                emptyOutcome = InstallerPairingHandoffOutcome.expired;
                if (await inbox.hasPending()) continue;
                return InstallerPairingHandoffOutcome.expired;
              }
              await inbox.release();
              return InstallerPairingHandoffOutcome.brokerUnavailable;
            }
          }

          // Health is safe to retry because it does not consume the offer.
          // Erase the recoverable claim immediately before the one deliberately
          // non-retried acceptance request: a lost response is ambiguous and
          // must never create a second peer identity.
          if (!await inbox.discard()) {
            return InstallerPairingHandoffOutcome.discardFailed;
          }
          try {
            await ref
                .read(pairingControllerProvider.notifier)
                .importPayload(handoff.qr, brokerUrl: handoff.brokerUrl);
          } on Object {
            return InstallerPairingHandoffOutcome.failed;
          }
          final notice = ref.read(pairingControllerProvider).notice;
          return notice == PairingNotice.paired ||
                  notice == PairingNotice.devicePaired
              ? InstallerPairingHandoffOutcome.imported
              : InstallerPairingHandoffOutcome.failed;
        } on Object {
          await inbox.release();
          return InstallerPairingHandoffOutcome.unreadable;
        } finally {
          ref.read(installerPairingInProgressProvider.notifier).state = false;
        }
      }
    });
