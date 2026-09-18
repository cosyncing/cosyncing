import 'dart:math';

import 'package:broker_client_flutter/broker_client_flutter.dart';

/// Verifies that the platform secure store can persist pairing credentials.
typedef SecureStoragePreflight = Future<void> Function();

/// Writes, reads, and removes a temporary value through the production backend.
Future<void> verifySecureStorage({
  SecureBrokerCredentialBackend? backend,
}) async {
  const keyPrefix = 'cosyncing_client.storage_preflight:';
  final resolvedBackend =
      backend ?? FlutterSecureStorageBrokerCredentialBackend();
  final random = Random.secure();
  final nonce = List<int>.generate(
    24,
    (_) => random.nextInt(256),
  ).map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
  final key = '$keyPrefix$nonce';
  final sentinel = 'cosyncing-storage-preflight-$nonce';

  Object? failure;
  StackTrace? failureStack;
  try {
    await resolvedBackend.write(key, sentinel);
    final stored = await resolvedBackend.read(key);
    if (stored != sentinel) {
      throw const SecureStoragePreflightException(
        'Secure storage did not return the value written during preflight.',
      );
    }
  } on Object catch (error, stackTrace) {
    failure = error;
    failureStack = stackTrace;
  }

  try {
    await resolvedBackend.delete(key);
  } on Object catch (error, stackTrace) {
    failure ??= error;
    failureStack ??= stackTrace;
  }

  if (failure != null) {
    Error.throwWithStackTrace(failure, failureStack!);
  }
}

/// The secure store failed its write/read/delete preflight.
final class SecureStoragePreflightException implements Exception {
  /// Creates a preflight failure with a diagnostic [message].
  const SecureStoragePreflightException(this.message);

  /// Diagnostic text for technical details and tests.
  final String message;

  @override
  String toString() => message;
}
