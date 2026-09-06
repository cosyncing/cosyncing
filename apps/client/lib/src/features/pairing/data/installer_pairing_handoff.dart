import 'dart:convert';

/// File the installer writes a first-run pairing offer into.
///
/// It lives under the BROKER's state home even though only the client reads
/// it. That is deliberate and it is not the client reading broker state: the
/// all-in-one installer places the broker and this client on ONE machine in
/// one run, and it needs somewhere to leave the offer it just asked the broker
/// for. The broker's state home is the one directory both halves of that
/// install already agree on, it is owner-only, and `COSYNCING_HOME` relocates
/// it for both. Think of it as an inbox the installer drops a letter into, not
/// as a place the client goes looking for the broker's business.
///
/// The offer inside is one-use and expires in five minutes, so a file left
/// behind by a client that never started is a dead offer rather than a
/// standing credential.
const String installerPairingHandoffFileName = 'client-pairing.json';

/// A pairing offer handed over by the installer for the client's first run.
class InstallerPairingHandoff {
  /// Creates an [InstallerPairingHandoff].
  const InstallerPairingHandoff({
    required this.qr,
    this.brokerUrl,
    this.expiresAt,
  });

  /// The v3 transport pairing payload, exactly as `pair --json` emitted it.
  final String qr;

  /// Broker URL the client should attach to, when the payload carries none.
  final String? brokerUrl;

  /// When the offer stops being redeemable, when the installer stated it.
  final DateTime? expiresAt;

  /// Whether this offer is already dead at [now].
  ///
  /// An offer with no stated expiry is treated as live: the broker still
  /// refuses a stale one, so guessing here would only turn a redeemable offer
  /// into a discarded one.
  bool hasExpired(DateTime now) {
    final deadline = expiresAt;
    return deadline != null && !now.isBefore(deadline);
  }
}

/// Parses an installer handoff document, or returns `null` when it is not one.
///
/// Every failure is the same answer — `null` — because every failure has the
/// same remedy: ignore the file and let the user pair by hand. A malformed
/// handoff must never be the reason an app will not start.
InstallerPairingHandoff? parseInstallerPairingHandoff(String raw) {
  final Object? decoded;
  try {
    decoded = jsonDecode(raw);
  } on FormatException {
    return null;
  }
  if (decoded is! Map<String, dynamic>) return null;
  final qr = decoded['qr'];
  if (qr is! String || qr.trim().isEmpty) return null;
  final brokerUrl = decoded['brokerUrl'];
  final expiresAt = decoded['expiresAt'];
  return InstallerPairingHandoff(
    qr: qr.trim(),
    brokerUrl: brokerUrl is String && brokerUrl.trim().isNotEmpty
        ? brokerUrl.trim()
        : null,
    expiresAt: expiresAt is String ? DateTime.tryParse(expiresAt) : null,
  );
}

/// Resolves the handoff file's path from [environment], or `null`.
///
/// `COSYNCING_HOME` first and absolute-only, which is the same rule the broker
/// and both installers apply to it. Otherwise the user's home directory, read
/// from `HOME` or — on Windows, which sets no `HOME` — `USERPROFILE`, matching
/// the broker's own default of `os.homedir()` plus `.cosyncing`.
String? installerPairingHandoffPath(
  Map<String, String> environment, {
  String separator = '/',
}) {
  String? absolute(String? value) {
    final trimmed = value?.trim();
    if (trimmed == null || trimmed.isEmpty) return null;
    final rooted =
        trimmed.startsWith('/') ||
        trimmed.startsWith(r'\') ||
        RegExp(r'^[A-Za-z]:[\\/]').hasMatch(trimmed);
    return rooted ? trimmed : null;
  }

  final stateHome = absolute(environment['COSYNCING_HOME']);
  if (stateHome != null) {
    return '$stateHome$separator$installerPairingHandoffFileName';
  }
  final home =
      absolute(environment['HOME']) ?? absolute(environment['USERPROFILE']);
  if (home == null) return null;
  return '$home$separator.cosyncing$separator'
      '$installerPairingHandoffFileName';
}

/// Reads and consumes the installer's one-shot pairing handoff.
abstract class InstallerPairingInbox {
  /// Returns the handoff document, or `null` when there is none to read.
  Future<String?> read();

  /// Removes the handoff file, whatever became of its contents.
  Future<void> discard();
}
