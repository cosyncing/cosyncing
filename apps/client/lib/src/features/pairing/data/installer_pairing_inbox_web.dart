import 'package:cosyncing_client/src/features/pairing/data/installer_pairing_handoff.dart';

/// The web build has no filesystem and no installer that writes to one.
///
/// A browser client is served BY the broker it would pair with, so it attaches
/// same-origin and never needs a handoff. This exists so the startup wiring is
/// the same on every platform rather than guarded by `kIsWeb` at the call site.
class FileInstallerPairingInbox implements InstallerPairingInbox {
  /// Creates a [FileInstallerPairingInbox].
  const FileInstallerPairingInbox();

  @override
  Future<String?> read() async => null;

  @override
  Future<void> discard() async {}
}
