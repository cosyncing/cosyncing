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
  Future<void> discard() async {
    final path = _path;
    if (path == null) return;
    try {
      final file = File(path);
      if (file.existsSync()) await file.delete();
    } on Object {
      // Best effort. The offer expires in five minutes either way, and the
      // client never reads the file twice in one run.
    }
  }
}
