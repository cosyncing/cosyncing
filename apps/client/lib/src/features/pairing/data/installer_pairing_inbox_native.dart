import 'dart:convert';
import 'dart:io';

import 'package:cosyncing_client/src/features/pairing/data/installer_pairing_handoff.dart';

/// Reads the installer's handoff from the local filesystem.
class FileInstallerPairingInbox implements InstallerPairingInbox {
  /// Creates a [FileInstallerPairingInbox].
  FileInstallerPairingInbox({String? path}) : _overridePath = path;

  final String? _overridePath;
  static const String _claimSuffix = '.claimed';
  RandomAccessFile? _claim;
  String? _claimPath;

  String? get _path =>
      _overridePath ??
      installerPairingHandoffPath(
        Platform.environment,
        separator: Platform.pathSeparator,
      );

  @override
  Future<String?> read() async {
    final existingClaim = _claim;
    if (existingClaim != null) {
      return _readClaim(existingClaim);
    }
    final path = _path;
    if (path == null) return null;
    final claimedPath = '$path$_claimSuffix';
    final claimedFile = File(claimedPath);
    try {
      if (!claimedFile.existsSync()) {
        final pendingFile = File(path);
        if (!pendingFile.existsSync()) return null;
        try {
          pendingFile.renameSync(claimedPath);
        } on FileSystemException {
          // Another client may have won the rename. The lock below serializes
          // access to that claim; any other failure remains an absent inbox.
          if (!claimedFile.existsSync()) return null;
        }
      }
      final handle = await claimedFile.open(mode: FileMode.append);
      await handle.lock();
      _claim = handle;
      _claimPath = claimedPath;
      final raw = await _readClaim(handle);
      if (raw == null) {
        await _closeClaim(preserve: false);
      }
      return raw;
    } on Object {
      await _closeClaim(preserve: true);
      return null;
    }
  }

  @override
  Future<bool> discard() async {
    if (_claim == null) return false;
    try {
      return await _closeClaim(preserve: false);
    } on Object {
      return false;
    }
  }

  @override
  Future<void> release() async {
    try {
      await _closeClaim(preserve: true);
    } on Object {
      // A failed release must not keep the app from starting. The operating
      // system releases the lock when this process exits.
    }
  }

  @override
  Future<bool> hasPending() async {
    final path = _path;
    return path != null && File(path).existsSync();
  }

  @override
  Stream<void> changes() async* {
    final path = _path;
    if (path == null) return;
    final directory = File(path).parent;
    try {
      await for (final event in directory.watch()) {
        final createdPending =
            event is FileSystemCreateEvent && event.path == path;
        final movedToPending =
            event is FileSystemMoveEvent && event.destination == path;
        if (createdPending || movedToPending) {
          yield null;
        }
      }
    } on FileSystemException {
      // An unwatcheable inbox simply retains startup-only handoff behavior.
    }
  }

  Future<String?> _readClaim(RandomAccessFile handle) async {
    final length = await handle.length();
    if (length == 0) return null;
    await handle.setPosition(0);
    return utf8.decode(await handle.read(length));
  }

  Future<bool> _closeClaim({required bool preserve}) async {
    final handle = _claim;
    final path = _claimPath;
    _claim = null;
    _claimPath = null;
    if (handle == null) return true;
    Object? failure;
    if (!preserve) {
      try {
        // Erase the reusable offer while the exclusive lock is still held.
        // An unlink after unlocking would let a waiting process read it.
        await handle.truncate(0);
        await handle.flush();
      } on Object catch (error) {
        failure = error;
      }
    }
    try {
      await handle.unlock();
    } on Object catch (error) {
      failure ??= error;
    }
    try {
      await handle.close();
    } on Object catch (error) {
      failure ??= error;
    }
    if (!preserve && failure == null && path != null) {
      try {
        await File(path).delete();
      } on FileSystemException {
        // Truncation already removed the offer. A zero-byte tombstone is safe
        // and a future read cleans it up.
      }
    }
    return failure == null;
  }
}
