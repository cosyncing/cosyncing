/// Runtime storage boundary for broker credentials.
///
/// The app keeps credentials behind this abstraction so storage strategy can
/// swap without touching broker-client wiring.
abstract interface class CredentialStore {
  /// Reads the broker token stored at [credentialKey].
  Future<String?> readBrokerToken(String credentialKey);

  /// Stores [token] at [credentialKey].
  Future<void> writeBrokerToken(String credentialKey, String token);

  /// Deletes any token stored at [credentialKey].
  Future<void> deleteBrokerToken(String credentialKey);
}
