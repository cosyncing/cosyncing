/// Signed broker release-channel snapshot.
class BrokerUpdateSnapshot {
  /// Creates a snapshot.
  const BrokerUpdateSnapshot({
    required this.status,
    required this.currentVersion,
    required this.checkedAt,
    required this.detailCode,
    this.latestVersion,
    this.publishedAt,
    this.cached = false,
    this.nextCheckAt,
    this.raw = const {},
  });

  /// Decodes a broker update snapshot.
  factory BrokerUpdateSnapshot.fromJson(Map<String, dynamic> json) =>
      BrokerUpdateSnapshot(
        status: json['status'] as String? ?? 'unknown',
        currentVersion: json['currentVersion'] as String? ?? 'unknown',
        latestVersion: json['latestVersion'] as String?,
        publishedAt: json['publishedAt'] as String?,
        checkedAt: json['checkedAt'] as String? ?? '',
        detailCode: json['detailCode'] as String? ?? 'unknown',
        cached: json['cached'] as bool? ?? false,
        nextCheckAt: json['nextCheckAt'] as String?,
        raw: Map<String, dynamic>.of(json),
      );

  /// `true` when a verified signed release is newer.
  bool get updateAvailable => status == 'update-available';

  /// Release-channel state.
  final String status;

  /// Running broker version.
  final String currentVersion;

  /// Verified newer version, when present.
  final String? latestVersion;

  /// Stable release publication timestamp.
  final String? publishedAt;

  /// Check timestamp.
  final String checkedAt;

  /// Stable machine-readable reason.
  final String detailCode;

  /// Whether the broker served its daily cache.
  final bool cached;

  /// Cache expiry timestamp.
  final String? nextCheckAt;

  /// Forward-compatible payload.
  final Map<String, dynamic> raw;
}

/// Response from `GET /api/broker/update`.
class BrokerUpdateResponse {
  /// Creates a response.
  const BrokerUpdateResponse({required this.ok, required this.update});

  /// Decodes a response.
  factory BrokerUpdateResponse.fromJson(Map<String, dynamic> json) {
    final update = json['update'];
    if (update is! Map<Object?, Object?>) {
      throw const FormatException('broker update snapshot is required');
    }
    return BrokerUpdateResponse(
      ok: json['ok'] as bool? ?? false,
      update: BrokerUpdateSnapshot.fromJson(Map<String, dynamic>.from(update)),
    );
  }

  /// Whether the request succeeded.
  final bool ok;

  /// Signed channel snapshot.
  final BrokerUpdateSnapshot update;
}

/// Isolated systemd update-handoff result.
class BrokerUpdateHandoff {
  /// Creates a handoff result.
  const BrokerUpdateHandoff({
    required this.status,
    required this.detailCode,
    required this.message,
    required this.fromVersion,
    this.toVersion,
  });

  /// Decodes a handoff result.
  factory BrokerUpdateHandoff.fromJson(Map<String, dynamic> json) =>
      BrokerUpdateHandoff(
        status: json['status'] as String? ?? 'failed',
        detailCode: json['detailCode'] as String? ?? 'unknown',
        message: json['message'] as String? ?? '',
        fromVersion: json['fromVersion'] as String? ?? 'unknown',
        toVersion: json['toVersion'] as String?,
      );

  /// Accepted, blocked, or failed.
  final String status;

  /// Stable machine-readable reason.
  final String detailCode;

  /// User-facing outcome.
  final String message;

  /// Running version before handoff.
  final String fromVersion;

  /// Target version.
  final String? toVersion;
}

/// Response from `POST /api/broker/update`.
class BrokerUpdateTriggerResponse {
  /// Creates a trigger response.
  const BrokerUpdateTriggerResponse({
    required this.ok,
    required this.accepted,
    required this.update,
    this.handoff,
    this.message,
  });

  /// Decodes a trigger response.
  factory BrokerUpdateTriggerResponse.fromJson(Map<String, dynamic> json) {
    final update = json['update'];
    if (update is! Map<Object?, Object?>) {
      throw const FormatException('broker update snapshot is required');
    }
    final handoff = json['handoff'];
    return BrokerUpdateTriggerResponse(
      ok: json['ok'] as bool? ?? false,
      accepted: json['accepted'] as bool? ?? false,
      update: BrokerUpdateSnapshot.fromJson(Map<String, dynamic>.from(update)),
      handoff: handoff is Map<Object?, Object?>
          ? BrokerUpdateHandoff.fromJson(Map<String, dynamic>.from(handoff))
          : null,
      message: json['message'] as String?,
    );
  }

  /// Whether the HTTP operation succeeded.
  final bool ok;

  /// Whether an isolated updater was queued.
  final bool accepted;

  /// Signed channel snapshot used for the decision.
  final BrokerUpdateSnapshot update;

  /// Handoff result when an update was attempted.
  final BrokerUpdateHandoff? handoff;

  /// No-op explanation when no handoff was attempted.
  final String? message;

  /// Best user-facing result message.
  String get outcomeMessage =>
      handoff?.message ?? message ?? 'No update action was taken.';
}
