import 'package:cosyncing_client/src/features/broker_profiles/data/credential_store.dart';

/// In-memory runtime credential store for tests and provider overrides.
final class InMemoryCredentialStore implements CredentialStore {
  final Map<String, String> _tokens = <String, String>{};

  static String _normalizeCredentialKey(String credentialKey) =>
      credentialKey.trim();

  static String _normalizeToken(String token) => token.trim();

  @override
  Future<String?> readBrokerToken(String credentialKey) async {
    final normalizedCredentialKey = _normalizeCredentialKey(credentialKey);
    if (normalizedCredentialKey.isEmpty) {
      return null;
    }

    final token = _tokens[normalizedCredentialKey];
    if (token == null || token.trim().isEmpty) {
      return null;
    }
    return token;
  }

  @override
  Future<void> writeBrokerToken(String credentialKey, String token) async {
    final normalizedCredentialKey = _normalizeCredentialKey(credentialKey);
    if (normalizedCredentialKey.isEmpty) {
      return;
    }

    final normalizedToken = _normalizeToken(token);
    if (normalizedToken.isEmpty) {
      _tokens.remove(normalizedCredentialKey);
      return;
    }

    _tokens[normalizedCredentialKey] = normalizedToken;
  }

  @override
  Future<void> deleteBrokerToken(String credentialKey) async {
    final normalizedCredentialKey = _normalizeCredentialKey(credentialKey);
    if (normalizedCredentialKey.isEmpty) {
      return;
    }
    _tokens.remove(normalizedCredentialKey);
  }
}
