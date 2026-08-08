import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/attention/controller/push_token_coordinator.dart';
import 'package:cosyncing_client/src/features/attention/controller/push_token_provider.dart';
import 'package:cosyncing_client/src/features/attention/data/push_installation_id.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

void main() {
  setUpAll(() {
    registerFallbackValue(
      const PushWakeTokenRegistrationRequest(
        platform: 'fcm',
        token: 'fallback',
      ),
    );
  });

  late _MockBrokerClient brokerClient;
  late _InMemoryInstallationIdStore installationIdStore;

  setUp(() {
    brokerClient = _MockBrokerClient();
    installationIdStore = _InMemoryInstallationIdStore(
      seed: 'installation-id',
    );
    when(() => brokerClient.revokeWakeToken(any())).thenAnswer(
      (_) async => const PushWakeTokenRevokeResponse(ok: true, revoked: true),
    );
  });

  test('registers with stable installation id for profile', () async {
    final provider = _ControllablePushTokenProvider(
      platform: PushTokenPlatform.fcm,
      initialToken: 'token-abc',
    );
    when(() => brokerClient.registerWakeToken(any())).thenAnswer(
      (_) async => _registrationResponse(
        tokenPreview: 'tok...abc',
      ),
    );

    final coordinator = PushTokenCoordinator(
      brokerClient: brokerClient,
      brokerProfileId: 'profile-1',
      tokenProvider: provider,
      installationIdStore: installationIdStore,
      registrationLabel: 'Profile One',
    );

    await coordinator.start();
    await Future<void>.delayed(Duration.zero);

    final captured = verify(
      () => brokerClient.registerWakeToken(captureAny()),
    ).captured.cast<PushWakeTokenRegistrationRequest>();
    expect(captured, hasLength(1));
    expect(captured.first.deviceId, 'installation-id');
    expect(captured.first.platform, 'fcm');
    expect(captured.first.token, 'token-abc');
    expect(captured.first.label, 'Profile One');
    expect(installationIdStore.calls, 1);

    await coordinator.stop();
    provider.close();
  });

  test('re-registers when token rotates', () async {
    final provider = _ControllablePushTokenProvider(
      platform: PushTokenPlatform.apns,
      initialToken: 'token-a',
    );
    when(() => brokerClient.registerWakeToken(any())).thenAnswer(
      (_) async => _registrationResponse(tokenPreview: 'preview'),
    );

    final coordinator = PushTokenCoordinator(
      brokerClient: brokerClient,
      brokerProfileId: 'profile-1',
      tokenProvider: provider,
      installationIdStore: installationIdStore,
      registrationLabel: 'Profile One',
    );

    await coordinator.start();
    await Future<void>.delayed(Duration.zero);
    provider.emit('token-b');
    await Future<void>.delayed(Duration.zero);
    provider.emit('token-b');
    await Future<void>.delayed(Duration.zero);

    final captured = verify(
      () => brokerClient.registerWakeToken(captureAny()),
    ).captured.cast<PushWakeTokenRegistrationRequest>();
    expect(captured, hasLength(2));
    expect(captured[0].token, 'token-a');
    expect(captured[1].token, 'token-b');

    await coordinator.stop();
    provider.close();
  });

  test(
    'revokes stale registration when supported provider starts null',
    () async {
      final provider = _ControllablePushTokenProvider(
        platform: PushTokenPlatform.fcm,
      );
      when(() => brokerClient.revokeWakeToken(any())).thenAnswer(
        (_) async => const PushWakeTokenRevokeResponse(ok: true, revoked: true),
      );
      final coordinator = PushTokenCoordinator(
        brokerClient: brokerClient,
        brokerProfileId: 'profile-1',
        tokenProvider: provider,
        installationIdStore: installationIdStore,
      );

      await coordinator.start();

      verify(() => brokerClient.revokeWakeToken('installation-id')).called(1);
      verifyNever(() => brokerClient.registerWakeToken(any()));
      await coordinator.stop();
      provider.close();
    },
  );

  test('null rotation revokes once and a later token re-registers', () async {
    final provider = _ControllablePushTokenProvider(
      platform: PushTokenPlatform.apns,
      initialToken: 'token-a',
    );
    when(() => brokerClient.registerWakeToken(any())).thenAnswer(
      (_) async => _registrationResponse(tokenPreview: 'preview'),
    );
    when(() => brokerClient.revokeWakeToken(any())).thenAnswer(
      (_) async => const PushWakeTokenRevokeResponse(ok: true, revoked: true),
    );
    final coordinator = PushTokenCoordinator(
      brokerClient: brokerClient,
      brokerProfileId: 'profile-1',
      tokenProvider: provider,
      installationIdStore: installationIdStore,
    );

    await coordinator.start();
    provider.emit(null);
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);
    provider.emit(null);
    await Future<void>.delayed(Duration.zero);
    provider.emit('token-b');
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);

    verify(() => brokerClient.revokeWakeToken('installation-id')).called(1);
    final registrations = verify(
      () => brokerClient.registerWakeToken(captureAny()),
    ).captured.cast<PushWakeTokenRegistrationRequest>();
    expect(registrations.map((item) => item.token), ['token-a', 'token-b']);
    await coordinator.stop();
    provider.close();
  });

  test('failed null-token revoke retries the same desired state', () async {
    final provider = _ControllablePushTokenProvider(
      platform: PushTokenPlatform.fcm,
    );
    var attempts = 0;
    when(() => brokerClient.revokeWakeToken(any())).thenAnswer((_) async {
      attempts += 1;
      if (attempts == 1) throw StateError('offline');
      return const PushWakeTokenRevokeResponse(ok: true, revoked: true);
    });
    final errors = <Object>[];
    final coordinator = PushTokenCoordinator(
      brokerClient: brokerClient,
      brokerProfileId: 'profile-1',
      tokenProvider: provider,
      installationIdStore: installationIdStore,
      onError: (error, _) => errors.add(error),
    );

    await expectLater(coordinator.start(), throwsA(isA<StateError>()));
    provider.emit(null);
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);

    expect(attempts, 2);
    expect(errors, hasLength(1));
    await coordinator.stop();
    provider.close();
  });

  test('does not apply a stale token snapshot after a live rotation', () async {
    final provider = _DelayedSnapshotPushTokenProvider();
    when(() => brokerClient.registerWakeToken(any())).thenAnswer(
      (_) async => _registrationResponse(tokenPreview: 'preview'),
    );
    final coordinator = PushTokenCoordinator(
      brokerClient: brokerClient,
      brokerProfileId: 'profile-1',
      tokenProvider: provider,
      installationIdStore: installationIdStore,
    );

    final started = coordinator.start();
    provider
      ..emit('fresh-token')
      ..completeSnapshot(null);
    await started;
    await Future<void>.delayed(Duration.zero);

    final registrations = verify(
      () => brokerClient.registerWakeToken(captureAny()),
    ).captured.cast<PushWakeTokenRegistrationRequest>();
    expect(registrations.single.token, 'fresh-token');
    verifyNever(() => brokerClient.revokeWakeToken(any()));
    await coordinator.stop();
    provider.close();
  });

  test('revokes registration on opt-out', () async {
    when(() => brokerClient.revokeWakeToken(any())).thenAnswer(
      (_) async => const PushWakeTokenRevokeResponse(ok: true, revoked: true),
    );

    final coordinator = PushTokenCoordinator(
      brokerClient: brokerClient,
      brokerProfileId: 'profile-1',
      tokenProvider: const NoopPushTokenProvider(),
      installationIdStore: installationIdStore,
    );

    await coordinator.revokeRegistration();

    verify(() => brokerClient.revokeWakeToken('installation-id')).called(1);
  });

  test('does not mutate broker when token provider is unsupported', () async {
    final coordinator = PushTokenCoordinator(
      brokerClient: brokerClient,
      brokerProfileId: 'profile-1',
      tokenProvider: const NoopPushTokenProvider(),
      installationIdStore: installationIdStore,
    );

    await coordinator.start();
    await coordinator.stop();

    verifyNever(() => brokerClient.registerWakeToken(any()));
    verifyNever(() => brokerClient.revokeWakeToken(any()));
  });

  test('stop/cancel prevents further token registration', () async {
    final provider = _ControllablePushTokenProvider(
      platform: PushTokenPlatform.fcm,
      initialToken: 'token-a',
    );
    when(() => brokerClient.registerWakeToken(any())).thenAnswer(
      (_) async => _registrationResponse(tokenPreview: 'preview'),
    );

    final coordinator = PushTokenCoordinator(
      brokerClient: brokerClient,
      brokerProfileId: 'profile-1',
      tokenProvider: provider,
      installationIdStore: installationIdStore,
    );

    await coordinator.start();
    await Future<void>.delayed(Duration.zero);
    provider.emit('token-b');
    await Future<void>.delayed(Duration.zero);

    await coordinator.stop();
    provider.emit('token-c');
    await Future<void>.delayed(Duration.zero);

    final captured = verify(
      () => brokerClient.registerWakeToken(captureAny()),
    ).captured.cast<PushWakeTokenRegistrationRequest>();
    expect(captured, hasLength(2));
    expect(captured[0].token, 'token-a');
    expect(captured[1].token, 'token-b');

    provider.close();
  });

  test('failed registration can retry the same rotated token', () async {
    final provider = _ControllablePushTokenProvider(
      platform: PushTokenPlatform.fcm,
    );
    var attempts = 0;
    when(() => brokerClient.registerWakeToken(any())).thenAnswer((_) async {
      attempts += 1;
      if (attempts == 1) throw StateError('offline');
      return _registrationResponse(tokenPreview: 'preview');
    });
    final errors = <Object>[];
    final coordinator = PushTokenCoordinator(
      brokerClient: brokerClient,
      brokerProfileId: 'profile-1',
      tokenProvider: provider,
      installationIdStore: installationIdStore,
      onError: (error, _) => errors.add(error),
    );

    await coordinator.start();
    provider.emit('same-token');
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);
    provider.emit('same-token');
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);

    expect(attempts, 2);
    expect(errors, hasLength(1));
    await coordinator.stop();
    provider.close();
  });
}

class _MockBrokerClient extends Mock implements BrokerClient {}

class _InMemoryInstallationIdStore implements PushInstallationIdStore {
  _InMemoryInstallationIdStore({String? seed}) : _id = seed;

  String? _id;
  int calls = 0;

  @override
  Future<String> readOrCreateInstallationId() async {
    calls += 1;
    return _id ??= 'generated-installation-$calls';
  }
}

class _ControllablePushTokenProvider implements PushTokenProvider {
  _ControllablePushTokenProvider({
    required this.platform,
    String? initialToken,
  }) : _token = initialToken;

  @override
  final PushTokenPlatform platform;

  final StreamController<String?> _controller =
      StreamController<String?>.broadcast();
  String? _token;

  @override
  Future<String?> currentToken() async => _token;

  @override
  Stream<String?> tokenChanges() => _controller.stream;

  @override
  void dispose() {
    _controller.close();
  }

  void emit(String? token) {
    _token = token;
    _controller.add(token);
  }

  void close() {
    if (!_controller.isClosed) {
      _controller.close();
    }
  }
}

class _DelayedSnapshotPushTokenProvider implements PushTokenProvider {
  final Completer<String?> _snapshot = Completer<String?>();
  final StreamController<String?> _controller =
      StreamController<String?>.broadcast();

  @override
  PushTokenPlatform get platform => PushTokenPlatform.fcm;

  @override
  Future<String?> currentToken() => _snapshot.future;

  @override
  Stream<String?> tokenChanges() => _controller.stream;

  void completeSnapshot(String? token) => _snapshot.complete(token);

  void emit(String? token) => _controller.add(token);

  void close() => _controller.close();

  @override
  void dispose() => close();
}

PushWakeTokenRegistrationResponse _registrationResponse({
  required String tokenPreview,
}) {
  return PushWakeTokenRegistrationResponse(
    ok: true,
    registration: PushWakeTokenRegistration(
      deviceId: 'installation-id',
      platform: 'fcm',
      tokenPreview: tokenPreview,
      createdAt: '2026-07-11T19:00:00.000Z',
      updatedAt: '2026-07-11T19:00:01.000Z',
    ),
  );
}
