/// Push wake-token models for broker mobile push registration.
///
/// Route payloads intentionally avoid exposing raw tokens outside
/// transport. The model only exposes `tokenPreview` and stable metadata
/// to preserve privacy.
library;

/// Registration platform for a browser Web Push subscription (revision 27).
const String webPushPlatform = 'webpush';

/// A browser push subscription: where the broker posts, and the keys it
/// encrypts each payload to.
class WebPushSubscription {
  const WebPushSubscription({
    required this.endpoint,
    required this.p256dh,
    required this.auth,
  });

  factory WebPushSubscription.fromJson(Map<String, dynamic> json) {
    final keys = json['keys'];
    final keyMap = keys is Map<String, dynamic>
        ? keys
        : const <String, dynamic>{};
    return WebPushSubscription(
      endpoint: json['endpoint'] as String? ?? '',
      p256dh: keyMap['p256dh'] as String? ?? '',
      auth: keyMap['auth'] as String? ?? '',
    );
  }

  /// The push service URL for this browser. It is a capability: whoever holds
  /// it can deliver to the browser, so it is never shown.
  final String endpoint;

  /// The browser's P-256 public key, base64url.
  final String p256dh;

  /// The browser's authentication secret, base64url.
  final String auth;

  Map<String, dynamic> toJson() => {
    'endpoint': endpoint,
    'keys': {'p256dh': p256dh, 'auth': auth},
  };
}

/// How one notification type appears in a Web Push: the title in the user's
/// language, and whether the body (the session title) is left out.
class WebPushPresentation {
  const WebPushPresentation({
    required this.title,
    this.typeOnly = false,
    this.silent = false,
  });

  factory WebPushPresentation.fromJson(Map<String, dynamic> json) =>
      WebPushPresentation(
        title: json['title'] as String? ?? '',
        typeOnly: json['typeOnly'] as bool? ?? false,
        silent: json['silent'] as bool? ?? false,
      );

  /// Localized type title, such as "Turn finished".
  final String title;

  /// Whether the notification shows the type only.
  final bool typeOnly;

  /// Whether the notification appears without a sound.
  final bool silent;

  Map<String, dynamic> toJson() => {
    'title': title,
    if (typeOnly) 'typeOnly': true,
    if (silent) 'silent': true,
  };
}

/// Response from `GET /api/push/web-push-key` (revision 27).
class WebPushKeyResponse {
  const WebPushKeyResponse({required this.ok, required this.publicKey});

  factory WebPushKeyResponse.fromJson(Map<String, dynamic> json) =>
      WebPushKeyResponse(
        ok: json['ok'] as bool? ?? false,
        publicKey: json['publicKey'] as String? ?? '',
      );

  /// Whether the request succeeded.
  final bool ok;

  /// The broker's VAPID public key: an uncompressed P-256 point, base64url.
  final String publicKey;

  Map<String, dynamic> toJson() => {'ok': ok, 'publicKey': publicKey};
}

/// Request payload for `POST /api/push/wake-tokens`.
class PushWakeTokenRegistrationRequest {
  const PushWakeTokenRegistrationRequest({
    required this.platform,
    required this.token,
    this.deviceId,
    this.label,
    this.subscription,
    this.presentation,
    this.context,
  });

  /// A browser Web Push registration: the subscription is the credential, and
  /// [presentation] names the types to push with their localized titles; a
  /// type it leaves out is never pushed. [context] is echoed back in every
  /// push, for the service worker to route a click.
  const PushWakeTokenRegistrationRequest.webPush({
    required String this.deviceId,
    required WebPushSubscription this.subscription,
    required Map<String, WebPushPresentation> this.presentation,
    this.context,
    this.label,
  }) : platform = webPushPlatform,
       token = '';

  factory PushWakeTokenRegistrationRequest.fromJson(Map<String, dynamic> json) {
    final subscription = json['subscription'];
    final presentation = json['presentation'];
    return PushWakeTokenRegistrationRequest(
      deviceId: json['deviceId'] as String?,
      platform: json['platform'] as String? ?? '',
      token: json['token'] as String? ?? '',
      label: json['label'] as String?,
      subscription: subscription is Map<String, dynamic>
          ? WebPushSubscription.fromJson(subscription)
          : null,
      presentation: presentation is Map<String, dynamic>
          ? {
              for (final MapEntry(:key, :value) in presentation.entries)
                if (value is Map<String, dynamic>)
                  key: WebPushPresentation.fromJson(value),
            }
          : null,
      context: json['context'] as String?,
    );
  }

  /// Web Push subscription (`webpush` only).
  final WebPushSubscription? subscription;

  /// Types to push, by type id, with how each appears (`webpush` only).
  final Map<String, WebPushPresentation>? presentation;

  /// Opaque text the broker echoes in every push (`webpush` only).
  final String? context;

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
    if (subscription != null) {
      output['subscription'] = subscription!.toJson();
    }
    if (presentation != null) {
      output['presentation'] = {
        for (final MapEntry(:key, :value) in presentation!.entries)
          key: value.toJson(),
      };
    }
    if (context != null) {
      output['context'] = context;
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
    this.presentationTypes,
  });

  factory PushWakeTokenRegistration.fromJson(Map<String, dynamic> json) {
    final types = json['presentationTypes'];
    return PushWakeTokenRegistration(
      deviceId: json['deviceId'] as String? ?? '',
      platform: json['platform'] as String? ?? '',
      tokenPreview: json['tokenPreview'] as String? ?? '',
      label: json['label'] as String?,
      createdAt: json['createdAt'] as String? ?? '',
      updatedAt: json['updatedAt'] as String? ?? '',
      presentationTypes: types is List
          ? types.whereType<String>().toList(growable: false)
          : null,
    );
  }

  /// The types a `webpush` registration pushes (never their titles).
  final List<String>? presentationTypes;

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
    'presentationTypes': ?presentationTypes,
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
