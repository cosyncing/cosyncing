import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/credential_store.dart';

/// Kept only for compatibility with existing app-level test doubles and
/// callsites.
typedef SecureCredentialBackend = SecureBrokerCredentialBackend;

/// Secure-storage-backed runtime implementation of [CredentialStore].
final class SecureCredentialStore implements CredentialStore {
  /// Creates a store with an injectable [backend].
  SecureCredentialStore({
    SecureCredentialBackend? backend,
  }) : _store = backend == null
           ? SecureBrokerCredentialStore()
           : SecureBrokerCredentialStore(backend: backend);

  final BrokerCredentialStore _store;

  @override
  Future<String?> readBrokerToken(String credentialKey) async {
    return _store.readBrokerToken(credentialKey);
  }

  @override
  Future<void> writeBrokerToken(String credentialKey, String token) =>
      _store.writeBrokerToken(credentialKey, token);

  @override
  Future<void> deleteBrokerToken(String credentialKey) =>
      _store.deleteBrokerToken(credentialKey);
}
