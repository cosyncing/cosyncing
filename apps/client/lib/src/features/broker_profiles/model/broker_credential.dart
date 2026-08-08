/// Stable secure-storage prefix for the broker's shared owner token.
const String brokerSharedTokenCredentialKeyPrefix = 'broker-token:';

/// Stable secure-storage prefix for a revocable QR-paired peer token.
const String brokerPeerTokenCredentialKeyPrefix = 'broker-peer-token:';

/// Authentication scheme selected by a saved broker credential reference.
enum BrokerCredentialKind {
  /// The broker-wide owner token sent as `x-cosyncing-token` / `token`.
  sharedToken,

  /// A revocable paired-device token sent as
  /// `x-cosyncing-peer-token` / `peerToken`.
  peerToken,
}

/// Raised when a profile references a credential that secure storage cannot
/// provide.
///
/// A configured credential must never silently downgrade to anonymous broker
/// access. The message deliberately omits the storage key and any secret
/// material.
final class BrokerCredentialUnavailableException implements Exception {
  /// Creates a profile-scoped credential failure.
  const BrokerCredentialUnavailableException(this.profileId);

  /// Profile whose configured credential could not be loaded.
  final String profileId;

  @override
  String toString() =>
      'Broker credential is unavailable for profile "$profileId". '
      'Reconnect or import a fresh pairing.';
}

/// Returns the authentication scheme encoded by [credentialKey].
///
/// Existing profile keys predate paired-device authentication and use the
/// shared-token scheme. Unknown keys therefore retain that compatibility
/// default, while the explicit peer prefix always selects peer auth.
BrokerCredentialKind brokerCredentialKindForKey(String credentialKey) {
  return credentialKey.startsWith(brokerPeerTokenCredentialKeyPrefix)
      ? BrokerCredentialKind.peerToken
      : BrokerCredentialKind.sharedToken;
}

/// Secure-storage key for a profile's shared owner token.
String brokerSharedTokenCredentialKey(String profileId) =>
    '$brokerSharedTokenCredentialKeyPrefix$profileId';

/// Secure-storage key for a profile's revocable paired-device token.
String brokerPeerTokenCredentialKey(String profileId) =>
    '$brokerPeerTokenCredentialKeyPrefix$profileId';
