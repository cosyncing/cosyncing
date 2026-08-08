import 'package:cosyncing_client/src/features/broker_profiles/data/credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/in_memory_credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_credential.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/controller/broker_gate_controller.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_auth_probe.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_gate_state.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late InMemoryCredentialStore store;
  late _RecordingAuthProbe probe;

  setUp(() {
    store = InMemoryCredentialStore();
    probe = _RecordingAuthProbe();
  });

  ProviderContainer makeContainer() {
    final container = ProviderContainer(
      overrides: [
        credentialStoreProvider.overrideWithValue(store),
        brokerAuthProbeProvider.overrideWithValue(probe),
      ],
    );
    addTearDown(container.dispose);
    return container;
  }

  BrokerProfile profileWith({String? credentialKey}) => BrokerProfile(
    id: 'https://broker.example.com:9443',
    displayName: 'broker.example.com',
    baseUri: Uri.parse('https://broker.example.com:9443'),
    createdAt: DateTime(2026),
    credentialKey: credentialKey,
  );

  test('reports unreachable when no broker profile is active', () async {
    final container = makeContainer();

    final state = await container.read(brokerGateControllerProvider.future);

    expect(state.status, BrokerGateStatus.unreachable);
    expect(state.shouldRequestCredential, isFalse);
    expect(probe.calls, isEmpty);
  });

  test('passes the stored credential to the probe', () async {
    final container = makeContainer();
    const key = 'broker-token:https://broker.example.com:9443';
    await store.writeBrokerToken(key, 'stored-secret');
    probe.result = const BrokerGateState.connected(machine: 'agent-one');
    container.read(activeBrokerProfileProvider.notifier).state = profileWith(
      credentialKey: key,
    );

    final state = await container.read(brokerGateControllerProvider.future);

    expect(state.status, BrokerGateStatus.connected);
    expect(state.machine, 'agent-one');
    expect(probe.calls.single.credential, 'stored-secret');
    expect(probe.calls.single.kind, BrokerCredentialKind.sharedToken);
  });

  test('selects the peer scheme for a paired credential key', () async {
    final container = makeContainer();
    const key = 'broker-peer-token:https://broker.example.com:9443';
    await store.writeBrokerToken(key, 'peer-secret');
    container.read(activeBrokerProfileProvider.notifier).state = profileWith(
      credentialKey: key,
    );

    await container.read(brokerGateControllerProvider.future);

    expect(probe.calls.single.credential, 'peer-secret');
    expect(probe.calls.single.kind, BrokerCredentialKind.peerToken);
  });

  test('probes with no credential when the profile has no key', () async {
    final container = makeContainer();
    container.read(activeBrokerProfileProvider.notifier).state = profileWith();

    await container.read(brokerGateControllerProvider.future);

    expect(probe.calls.single.credential, isNull);
  });

  test('surfaces the unauthorized rejected verdict from the probe', () async {
    final container = makeContainer();
    const key = 'broker-token:https://broker.example.com:9443';
    await store.writeBrokerToken(key, 'wrong-secret');
    probe.result = const BrokerGateState.unauthorized(
      credentialIssue: BrokerGateCredentialIssue.rejected,
    );
    container.read(activeBrokerProfileProvider.notifier).state = profileWith(
      credentialKey: key,
    );

    final state = await container.read(brokerGateControllerProvider.future);

    expect(state.status, BrokerGateStatus.unauthorized);
    expect(state.hasRejectedCredential, isTrue);
    expect(state.shouldRequestCredential, isTrue);
  });

  test('re-probes when the active profile changes', () async {
    final container = makeContainer();
    container.read(activeBrokerProfileProvider.notifier).state = profileWith();
    await container.read(brokerGateControllerProvider.future);
    expect(probe.calls, hasLength(1));

    const key = 'broker-token:https://broker.example.com:9443';
    await store.writeBrokerToken(key, 'fresh-secret');
    container.read(activeBrokerProfileProvider.notifier).state = profileWith(
      credentialKey: key,
    );
    await container.read(brokerGateControllerProvider.future);

    expect(probe.calls, hasLength(2));
    expect(probe.calls.last.credential, 'fresh-secret');
  });

  test('refresh re-runs the probe', () async {
    final container = makeContainer();
    container.read(activeBrokerProfileProvider.notifier).state = profileWith();
    await container.read(brokerGateControllerProvider.future);

    await container.read(brokerGateControllerProvider.notifier).refresh();

    expect(probe.calls, hasLength(2));
  });

  test('a credential-store failure falls back to an anonymous probe', () async {
    final container = ProviderContainer(
      overrides: [
        credentialStoreProvider.overrideWithValue(_ThrowingCredentialStore()),
        brokerAuthProbeProvider.overrideWithValue(probe),
      ],
    );
    addTearDown(container.dispose);
    container.read(activeBrokerProfileProvider.notifier).state = profileWith(
      credentialKey: 'broker-token:https://broker.example.com:9443',
    );

    final state = await container.read(brokerGateControllerProvider.future);

    expect(probe.calls.single.credential, isNull);
    expect(state.status, BrokerGateStatus.connected);
  });
}

class _ProbeCall {
  const _ProbeCall({required this.credential, required this.kind});

  final String? credential;
  final BrokerCredentialKind kind;
}

class _RecordingAuthProbe implements BrokerAuthProbe {
  final List<_ProbeCall> calls = <_ProbeCall>[];

  BrokerGateState result = const BrokerGateState.connected();

  @override
  Future<BrokerGateState> probe({
    required Uri baseUrl,
    String? credential,
    BrokerCredentialKind credentialKind = BrokerCredentialKind.sharedToken,
  }) async {
    calls.add(_ProbeCall(credential: credential, kind: credentialKind));
    return result;
  }
}

class _ThrowingCredentialStore implements CredentialStore {
  @override
  Future<String?> readBrokerToken(String credentialKey) async {
    throw StateError('secure storage unavailable');
  }

  @override
  Future<void> writeBrokerToken(String credentialKey, String token) async {}

  @override
  Future<void> deleteBrokerToken(String credentialKey) async {}
}
