/// A saved broker endpoint profile.
///
/// Stores the normalized [baseUri] and display metadata.
/// [credentialKey] points at the runtime credential store slot for the broker
/// token, when one exists.
class BrokerProfile {
  /// Creates a [BrokerProfile].
  const BrokerProfile({
    required this.id,
    required this.displayName,
    required this.baseUri,
    required this.createdAt,
    this.incarnationId,
    this.updatedAt,
    this.lastUsedAt,
    this.credentialKey,
  });

  /// Unique identifier for this profile.
  final String id;

  /// User-facing display name.
  final String displayName;

  /// Normalized broker HTTP base URL (e.g. `http://127.0.0.1:7734`).
  ///
  /// Always stored with scheme, host, and port — never raw user input.
  final Uri baseUri;

  /// When this profile was created.
  final DateTime createdAt;

  /// Opaque generation of this saved profile row.
  ///
  /// Deleting and re-adding the same id creates a new incarnation. Broker-bound
  /// authority keys include this value so a write admitted by the deleted
  /// incarnation can never become addressable by the replacement.
  ///
  /// Null is accepted for profiles that have not been saved yet and for
  /// compatibility with test fixtures. Repositories assign it on first save.
  final String? incarnationId;

  /// When this profile was last updated, if ever.
  final DateTime? updatedAt;

  /// When this profile was last used to connect, if ever.
  final DateTime? lastUsedAt;

  /// Key into secure storage for the broker token, if any.
  final String? credentialKey;

  /// Returns a copy with optional overrides.
  ///
  /// Set [clearCredentialKey] to remove the secure-storage reference. Passing
  /// `credentialKey: null` keeps the existing key unchanged, matching the
  /// other nullable fields in this method.
  BrokerProfile copyWith({
    String? id,
    String? displayName,
    Uri? baseUri,
    DateTime? createdAt,
    String? incarnationId,
    DateTime? updatedAt,
    DateTime? lastUsedAt,
    String? credentialKey,
    bool clearCredentialKey = false,
  }) {
    return BrokerProfile(
      id: id ?? this.id,
      displayName: displayName ?? this.displayName,
      baseUri: baseUri ?? this.baseUri,
      createdAt: createdAt ?? this.createdAt,
      incarnationId: incarnationId ?? this.incarnationId,
      updatedAt: updatedAt ?? this.updatedAt,
      lastUsedAt: lastUsedAt ?? this.lastUsedAt,
      credentialKey: clearCredentialKey
          ? null
          : credentialKey ?? this.credentialKey,
    );
  }

  @override
  String toString() =>
      'BrokerProfile(id: $id, displayName: $displayName, baseUri: $baseUri)';
}
