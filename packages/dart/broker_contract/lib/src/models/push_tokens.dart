/// Push wake-token models for broker mobile push registration.
///
/// Route payloads intentionally avoid exposing raw tokens outside
/// transport. The model only exposes `tokenPreview` and stable metadata
/// to preserve privacy.
library;

/// Request payload for `POST /api/push/wake-tokens`.
class PushWakeTokenRegistrationRequest {
  const PushWakeTokenRegistrationRequest({
    required this.platform,
    required this.token,
    this.deviceId,
    this.label,
  });

  factory PushWakeTokenRegistrationRequest.fromJson(Map<String, dynamic> json) {
    return PushWakeTokenRegistrationRequest(
      deviceId: json['deviceId'] as String?,
      platform: json['platform'] as String? ?? '',
      token: json['token'] as String? ?? '',
      label: json['label'] as String?,
    );
  }

  /// Existing registration device identifier, if any.
  final String? deviceId;

  /// Push platform: `apns` or `fcm`.
  final String platform;

  /// Raw token from OS push provider.
  ///
  /// This value is only sent in API payloads and never persisted in local app
  /// models.
  final String token;

  /// Optional human-readable label for this installation.
  final String? label;

  Map<String, dynamic> toJson() {
    final output = <String, dynamic>{
      'platform': platform,
      'token': token,
    };

    if (deviceId != null) {
      output['deviceId'] = deviceId;
    }
    if (label != null) {
      output['label'] = label;
    }
    return output;
  }
}

/// Registration details returned by wake-token routes.
class PushWakeTokenRegistration {
  const PushWakeTokenRegistration({
    required this.deviceId,
    required this.platform,
    required this.tokenPreview,
    required this.createdAt,
    required this.updatedAt,
    this.label,
  });

  factory PushWakeTokenRegistration.fromJson(Map<String, dynamic> json) {
    return PushWakeTokenRegistration(
      deviceId: json['deviceId'] as String? ?? '',
      platform: json['platform'] as String? ?? '',
      tokenPreview: json['tokenPreview'] as String? ?? '',
      label: json['label'] as String?,
      createdAt: json['createdAt'] as String? ?? '',
      updatedAt: json['updatedAt'] as String? ?? '',
    );
  }

  /// Stable installation identifier used by the broker.
  final String deviceId;

  /// Push platform: `apns` or `fcm`.
  final String platform;

  /// Broker-truncated or redacted token preview.
  final String tokenPreview;

  /// Optional device label.
  final String? label;

  /// Registration creation timestamp.
  final String createdAt;

  /// Registration last-update timestamp.
  final String updatedAt;

  Map<String, dynamic> toJson() => {
    'deviceId': deviceId,
    'platform': platform,
    'tokenPreview': tokenPreview,
    'label': label,
    'createdAt': createdAt,
    'updatedAt': updatedAt,
  };
}

/// Response from `POST /api/push/wake-tokens`.
class PushWakeTokenRegistrationResponse {
  const PushWakeTokenRegistrationResponse({
    required this.ok,
    required this.registration,
  });

  factory PushWakeTokenRegistrationResponse.fromJson(
    Map<String, dynamic> json,
  ) {
    final registrationJson = json['registration'];
    return PushWakeTokenRegistrationResponse(
      ok: json['ok'] as bool? ?? false,
      registration: registrationJson is Map<String, dynamic>
          ? PushWakeTokenRegistration.fromJson(registrationJson)
          : const PushWakeTokenRegistration(
              deviceId: '',
              platform: '',
              tokenPreview: '',
              createdAt: '',
              updatedAt: '',
            ),
    );
  }

  /// Whether the request succeeded.
  final bool ok;

  /// Registration stored by the broker.
  final PushWakeTokenRegistration registration;

  Map<String, dynamic> toJson() => {
    'ok': ok,
    'registration': registration.toJson(),
  };
}

/// Response from `GET /api/push/wake-tokens`.
class PushWakeTokenListResponse {
  const PushWakeTokenListResponse({
    required this.ok,
    required this.registrations,
  });

  factory PushWakeTokenListResponse.fromJson(Map<String, dynamic> json) {
    final rawRegistrations = json['registrations'];
    return PushWakeTokenListResponse(
      ok: json['ok'] as bool? ?? false,
      registrations: rawRegistrations is List
          ? rawRegistrations
                .whereType<Map<String, dynamic>>()
                .map(PushWakeTokenRegistration.fromJson)
                .toList(growable: false)
          : const <PushWakeTokenRegistration>[],
    );
  }

  /// Whether the request succeeded.
  final bool ok;

  /// Active registrations.
  final List<PushWakeTokenRegistration> registrations;

  Map<String, dynamic> toJson() => {
    'ok': ok,
    'registrations': registrations
        .map((PushWakeTokenRegistration item) => item.toJson())
        .toList(growable: false),
  };
}

/// Response from `DELETE /api/push/wake-tokens/:deviceId`.
class PushWakeTokenRevokeResponse {
  const PushWakeTokenRevokeResponse({
    required this.ok,
    required this.revoked,
  });

  factory PushWakeTokenRevokeResponse.fromJson(Map<String, dynamic> json) {
    return PushWakeTokenRevokeResponse(
      ok: json['ok'] as bool? ?? false,
      revoked: json['revoked'] as bool? ?? false,
    );
  }

  /// Whether revoke endpoint accepted the request.
  final bool ok;

  /// Whether the broker revoked a registration for this `deviceId`.
  final bool revoked;

  Map<String, dynamic> toJson() => {
    'ok': ok,
    'revoked': revoked,
  };
}
