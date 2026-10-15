// Mobile push wake for F07 feature tests: the device's FCM token source, and
// the broker's wake-token registry (`/api/push/wake-tokens`).
import 'dart:async';

import 'package:cosyncing_client/src/features/attention/controller/attention_remote_wake_runtime.dart';
import 'package:cosyncing_client/src/features/attention/controller/push_token_provider.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart' show Override;

import 'fake_broker.dart';

/// The device's push token source: a token that can rotate, and wake
/// signals the OS delivers to the app.
class FakePushTokens implements PushTokenProvider, PushWakeSignalProvider {
  /// A device holding [token].
  FakePushTokens(this.token);

  /// The token the platform holds now.
  String? token;

  final _changes = StreamController<String?>.broadcast();
  final _wakes = StreamController<void>.broadcast();

  @override
  PushTokenPlatform get platform => PushTokenPlatform.fcm;

  @override
  Future<String?> currentToken() async => token;

  @override
  Stream<String?> tokenChanges() => _changes.stream;

  @override
  Stream<void> wakeSignals() => _wakes.stream;

  @override
  void dispose() {}

  /// The platform rotates the token.
  void rotate(String next) {
    token = next;
    _changes.add(next);
  }

  /// The OS delivers an opaque push wake.
  void wake() => _wakes.add(null);

  /// Providers that put this token source under the app.
  List<Override> get overrides => [
    pushTokenProviderProvider.overrideWithValue(this),
  ];
}

/// One wake-token registration the broker holds.
class WakeRegistration {
  /// Creates a registration record.
  WakeRegistration(this.deviceId, this.platform, this.token, this.label);

  /// The app installation's id.
  final String deviceId;

  /// `fcm` or `apns`.
  final String platform;

  /// The push token.
  final String token;

  /// The label the app registered under.
  final String label;
}

/// The broker side of mobile push wake.
class WakeTokenDesk {
  /// Installs the wake-token routes on [broker].
  WakeTokenDesk(FakeBroker broker) {
    broker.routes.add((request) async {
      final path = request.path;
      if (request.method == 'POST' && path == '/api/push/wake-tokens') {
        final body = (request.body! as Map).cast<String, Object?>();
        final entry = WakeRegistration(
          body['deviceId']! as String,
          body['platform']! as String,
          body['token']! as String,
          (body['label'] as String?) ?? '',
        );
        registrations[entry.deviceId] = entry;
        history.add(entry);
        return FakeBrokerResponse(200, {
          'ok': true,
          'registration': {
            'deviceId': entry.deviceId,
            'platform': entry.platform,
            'tokenPreview': '…${entry.token.substring(entry.token.length - 2)}',
            'createdAt': '2026-10-01T00:00:00.000Z',
            'updatedAt': '2026-10-01T00:00:00.000Z',
          },
        });
      }
      final one = RegExp(r'^/api/push/wake-tokens/([^/]+)$').firstMatch(path);
      if (request.method == 'DELETE' && one != null) {
        final id = Uri.decodeComponent(one.group(1)!);
        revoked.add(id);
        registrations.remove(id);
        return const FakeBrokerResponse(200, {'ok': true, 'revoked': true});
      }
      return null;
    });
  }

  /// What the broker holds now, by device id.
  final Map<String, WakeRegistration> registrations = {};

  /// Every registration the app posted, oldest first.
  final List<WakeRegistration> history = [];

  /// Device ids the app revoked.
  final List<String> revoked = [];
}
