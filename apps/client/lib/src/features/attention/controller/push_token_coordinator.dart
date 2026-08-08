import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/attention/controller/push_token_provider.dart';
import 'package:cosyncing_client/src/features/attention/data/push_installation_id.dart';

/// Receives asynchronous token-rotation registration failures.
typedef PushTokenRegistrationErrorHandler =
    void Function(Object error, StackTrace stackTrace);

/// Registers and maintains a stable wake-token registration with a broker.
///
/// See `docs/architecture/client-ui.md` for runtime
/// behavior and wake-token privacy constraints.
class PushTokenCoordinator {
  /// Creates a profile-scoped wake-token coordinator.
  PushTokenCoordinator({
    required this.brokerClient,
    required this.brokerProfileId,
    required this.tokenProvider,
    required this.installationIdStore,
    this.registrationLabel,
    this.onError,
  });

  /// Broker API client for registration and revocation calls.
  final BrokerClient brokerClient;

  /// Scope key for per-profile registration bookkeeping.
  final String brokerProfileId;

  /// Push provider for this platform or profile.
  final PushTokenProvider tokenProvider;

  /// Stable installation id store.
  final PushInstallationIdStore installationIdStore;

  /// Optional human-readable registration label.
  final String? registrationLabel;

  /// Optional observer for background token-rotation failures.
  final PushTokenRegistrationErrorHandler? onError;

  StreamSubscription<String?>? _tokenSubscription;
  String? _trackedToken;
  String? _installationId;
  bool _isStopped = false;
  bool _hasReconciledState = false;
  int _tokenRevision = 0;
  Future<void> _serial = Future<void>.value();

  /// Starts token tracking and performs an initial registration sync.
  Future<void> start() async {
    if (_tokenSubscription != null) return;
    if (_isStopped) {
      _isStopped = false;
    }
    if (tokenProvider is NoopPushTokenProvider) return;
    final snapshotRevision = _tokenRevision;
    final tokenStream = tokenProvider.tokenChanges();
    _tokenSubscription = tokenStream.listen((token) {
      _tokenRevision += 1;
      _enqueue(token);
    });
    final currentToken = await tokenProvider.currentToken();
    if (_tokenRevision == snapshotRevision) {
      await _enqueue(currentToken);
    } else {
      // A live rotation is newer than the snapshot read that overlapped it.
      await _serial;
    }
  }

  /// Stops token tracking and cancels subscriptions.
  Future<void> stop() async {
    _isStopped = true;
    await _tokenSubscription?.cancel();
    _tokenSubscription = null;
    await _serial;
    _trackedToken = null;
    _hasReconciledState = false;
    _tokenRevision = 0;
  }

  /// Compatibility alias for disposal.
  Future<void> dispose() => stop();

  /// Revokes this profile installation registration on opt-out.
  Future<void> revokeRegistration() async {
    final installationId = await _readInstallationId();
    await brokerClient.revokeWakeToken(installationId);
  }

  Future<void> _enqueue(String? token) {
    final operation = _serial.then((_) => _registerOrUpdateToken(token));
    _serial = operation.catchError((Object error, StackTrace stackTrace) {
      onError?.call(error, stackTrace);
    });
    return operation;
  }

  Future<void> _registerOrUpdateToken(String? token) async {
    if (_isStopped || tokenProvider is NoopPushTokenProvider) {
      return;
    }

    final normalized = token?.trim();
    final nextToken = (normalized == null || normalized.isEmpty)
        ? null
        : normalized;

    if (_hasReconciledState && _trackedToken == nextToken) {
      return;
    }

    if (nextToken == null) {
      await _revokeWakeToken();
      _trackedToken = null;
      _hasReconciledState = true;
      return;
    }

    final installationId = await _readInstallationId();
    await brokerClient.registerWakeToken(
      PushWakeTokenRegistrationRequest(
        deviceId: installationId,
        platform: tokenProvider.platform.wireValue,
        token: nextToken,
        label: registrationLabel ?? brokerProfileId,
      ),
    );
    _trackedToken = nextToken;
    _hasReconciledState = true;
  }

  Future<String> _readInstallationId() async {
    return _installationId ??= await installationIdStore
        .readOrCreateInstallationId();
  }

  Future<void> _revokeWakeToken() async {
    final installationId = await _readInstallationId();
    await brokerClient.revokeWakeToken(installationId);
  }
}
