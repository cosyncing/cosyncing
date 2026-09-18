import 'dart:io';

import 'package:cosyncing_client/src/features/pairing/data/installer_pairing_handoff.dart';

/// Reads the installer's handoff from the local filesystem.
class FileInstallerPairingInbox implements InstallerPairingInbox {
  /// Creates a [FileInstallerPairingInbox].
  const FileInstallerPairingInbox();

  String? get _path => installerPairingHandoffPath(
    Platform.environment,
    separator: Platform.pathSeparator,
  );

  @override
  Future<String?> read() async {
    final path = _path;
    if (path == null) return null;
    try {
      final file = File(path);
      if (!file.existsSync()) return null;
      return await file.readAsString();
    } on Object {
      // An unreadable inbox is an absent one. The user pairs by hand.
      return null;
    }
  }

  @override
  Future<bool> discard() async {
    final path = _path;
    if (path == null) return true;
    try {
      // A successful unlink is the claim. If another client already removed
      // the handoff, this launch must not redeem the same one-use offer.
      await File(path).delete();
      return true;
    } on Object {
      return false;
    }
  }
}
