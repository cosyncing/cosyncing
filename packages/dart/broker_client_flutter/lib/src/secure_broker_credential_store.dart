import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// Backend abstraction used by the credential store.
abstract interface class SecureBrokerCredentialBackend {
  /// Reads the value at [key].
  Future<String?> read(String key);

  /// Writes [value] at [key].
  Future<void> write(String key, String value);

  /// Deletes the entry at [key], if any.
  Future<void> delete(String key);
}

/// FlutterSecureStorage-backed implementation of
/// [SecureBrokerCredentialBackend].
final class FlutterSecureStorageBrokerCredentialBackend
    implements SecureBrokerCredentialBackend {
  /// Creates a backend with an optional [delegate].
  FlutterSecureStorageBrokerCredentialBackend({FlutterSecureStorage? delegate})
    : _delegate =
          delegate ??
          const FlutterSecureStorage(
            // The public macOS client is intentionally distributed without an
            // Apple development certificate. The data-protection keychain
            // requires the signed Keychain Sharing capability, while the
            // standard macOS login keychain remains OS-managed secure storage
            // and works for this unsigned application.
            mOptions: MacOsOptions(usesDataProtectionKeychain: false),
          );

  final FlutterSecureStorage _delegate;

  @override
  Future<String?> read(String key) => _delegate.read(key: key);

  @override
  Future<void> write(String key, String value) =>
      _delegate.write(key: key, value: value);

  @override
  Future<void> delete(String key) => _delegate.delete(key: key);
}

/// Platform-agnostic broker credential storage adapter.
abstract interface class BrokerCredentialStore {
  /// Reads the broker token stored for [credentialKey].
  Future<String?> readBrokerToken(String credentialKey);

  /// Stores [token] for [credentialKey].
  Future<void> writeBrokerToken(String credentialKey, String token);

  /// Deletes the token stored for [credentialKey].
  Future<void> deleteBrokerToken(String credentialKey);
}

/// Secure-storage-backed implementation of [BrokerCredentialStore].
final class SecureBrokerCredentialStore implements BrokerCredentialStore {
  /// Creates a secure credential store with an injectable [backend].
  SecureBrokerCredentialStore({SecureBrokerCredentialBackend? backend})
    : _backend = backend ?? FlutterSecureStorageBrokerCredentialBackend();

  /// Prefix used for all broker credential entries.
  static const String brokerTokenStorageKeyPrefix =
      'cosyncing_client.broker_token:';

  final SecureBrokerCredentialBackend _backend;

  static String _normalizeCredentialKey(String credentialKey) =>
      credentialKey.trim();

  static String _normalizeToken(String token) => token.trim();

  static String _storageKey(String credentialKey) =>
      '$brokerTokenStorageKeyPrefix$credentialKey';

  @override
  Future<String?> readBrokerToken(String credentialKey) async {
    final normalizedCredentialKey = _normalizeCredentialKey(credentialKey);
    if (normalizedCredentialKey.isEmpty) {
      return null;
    }

    final token = await _backend.read(_storageKey(normalizedCredentialKey));
    final normalizedToken = token?.trim();
    return normalizedToken == null || normalizedToken.isEmpty
        ? null
        : normalizedToken;
  }

  @override
  Future<void> writeBrokerToken(String credentialKey, String token) async {
    final normalizedCredentialKey = _normalizeCredentialKey(credentialKey);
    if (normalizedCredentialKey.isEmpty) {
      return;
    }

    final normalizedToken = _normalizeToken(token);
    if (normalizedToken.isEmpty) {
      await deleteBrokerToken(normalizedCredentialKey);
      return;
    }

    await _backend.write(_storageKey(normalizedCredentialKey), normalizedToken);
  }

  @override
  Future<void> deleteBrokerToken(String credentialKey) async {
    final normalizedCredentialKey = _normalizeCredentialKey(credentialKey);
    if (normalizedCredentialKey.isEmpty) {
      return;
    }

    await _backend.delete(_storageKey(normalizedCredentialKey));
  }
}
