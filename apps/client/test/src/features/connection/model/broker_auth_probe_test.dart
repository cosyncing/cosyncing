import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_credential.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_auth_probe.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_gate_state.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

class MockBrokerClient extends Mock implements BrokerClient {}

void main() {
  late MockBrokerClient client;
  late RealBrokerAuthProbe probe;
  String? capturedToken;
  String? capturedPeerToken;

  final baseUrl = Uri.parse('http://127.0.0.1:7734');

  setUp(() {
    client = MockBrokerClient();
    capturedToken = null;
    capturedPeerToken = null;
    probe = RealBrokerAuthProbe(
      clientFactory: ({required baseUrl, token, peerToken}) {
        capturedToken = token;
        capturedPeerToken = peerToken;
        return client;
      },
    );
  });

  void stubHealthThrows(Object error) {
    when(() => client.getBrokerHealth()).thenThrow(error);
  }

  group('connected', () {
    test('reports connected when the authenticated probe succeeds', () async {
      when(() => client.getBrokerHealth()).thenAnswer(
        (_) async => const BrokerHealthResponse(
          ok: true,
          status: 'ok',
          checkedAt: 0,
          machine: 'agent-one',
        ),
      );

      final state = await probe.probe(baseUrl: baseUrl, credential: 'good');

      expect(state.status, BrokerGateStatus.connected);
      expect(state.isConnected, isTrue);
      expect(state.shouldRequestCredential, isFalse);
      verify(() => client.close()).called(1);
    });

    test('reports connected when a broker needs no credential', () async {
      // Loopback brokers with no token configured answer anonymously. A
      // missing credential must not be treated as an auth failure.
      when(() => client.getBrokerHealth()).thenAnswer(
        (_) async => const BrokerHealthResponse(
          ok: true,
          status: 'ok',
          checkedAt: 0,
          machine: 'agent-one',
        ),
      );

      final state = await probe.probe(baseUrl: baseUrl);

      expect(state.status, BrokerGateStatus.connected);
      expect(capturedToken, isNull);
      expect(capturedPeerToken, isNull);
    });
  });

  group('unreachable', () {
    test('classifies a null status code as unreachable, not auth', () async {
      // Connection refused arrives as a BrokerException with no status code.
      stubHealthThrows(
        const BrokerException(message: 'Connection refused'),
      );

      final state = await probe.probe(baseUrl: baseUrl, credential: 'stored');

      expect(state.status, BrokerGateStatus.unreachable);
      expect(state.shouldRequestCredential, isFalse);
      expect(state.detail, contains('Connection refused'));
      verify(() => client.close()).called(1);
    });

    test('classifies a 503 as unreachable', () async {
      stubHealthThrows(
        const BrokerException(message: 'broker unavailable', statusCode: 503),
      );

      final state = await probe.probe(baseUrl: baseUrl, credential: 'stored');

      expect(state.status, BrokerGateStatus.unreachable);
      expect(state.shouldRequestCredential, isFalse);
    });

    test('classifies an unexpected transport error as unreachable', () async {
      stubHealthThrows(StateError('network down'));

      final state = await probe.probe(baseUrl: baseUrl);

      expect(state.status, BrokerGateStatus.unreachable);
      expect(state.detail, contains('network down'));
      verify(() => client.close()).called(1);
    });

    test('never asks for a credential when unreachable', () async {
      stubHealthThrows(const BrokerException(message: 'down'));

      final state = await probe.probe(baseUrl: baseUrl);

      expect(state.shouldRequestCredential, isFalse);
      expect(state.credentialIssue, isNull);
    });
  });

  group('unauthorized', () {
    test('401 with no stored credential reports missing', () async {
      stubHealthThrows(
        const BrokerException(message: 'unauthorized', statusCode: 401),
      );

      final state = await probe.probe(baseUrl: baseUrl);

      expect(state.status, BrokerGateStatus.unauthorized);
      expect(state.credentialIssue, BrokerGateCredentialIssue.missing);
      expect(state.hasRejectedCredential, isFalse);
      expect(state.shouldRequestCredential, isTrue);
    });

    test('401 with a stored credential reports rejected', () async {
      // The named "wrong credential" case: revoked, rotated, or just wrong.
      stubHealthThrows(
        const BrokerException(message: 'unauthorized', statusCode: 401),
      );

      final state = await probe.probe(
        baseUrl: baseUrl,
        credential: 'wrong-token',
      );

      expect(state.status, BrokerGateStatus.unauthorized);
      expect(state.credentialIssue, BrokerGateCredentialIssue.rejected);
      expect(state.hasRejectedCredential, isTrue);
      expect(state.shouldRequestCredential, isTrue);
    });

    test('a blank credential counts as missing, not rejected', () async {
      stubHealthThrows(
        const BrokerException(message: 'unauthorized', statusCode: 401),
      );

      final state = await probe.probe(baseUrl: baseUrl, credential: '   ');

      expect(state.credentialIssue, BrokerGateCredentialIssue.missing);
      expect(capturedToken, isNull);
    });
  });

  group('credential scheme', () {
    test('sends a shared token as the owner token', () async {
      when(() => client.getBrokerHealth()).thenAnswer(
        (_) async => const BrokerHealthResponse(
          ok: true,
          status: 'ok',
          checkedAt: 0,
          machine: 'agent-one',
        ),
      );

      // The shared-token scheme is the compatibility default.
      await probe.probe(baseUrl: baseUrl, credential: 'shared-secret');

      expect(capturedToken, 'shared-secret');
      expect(capturedPeerToken, isNull);
    });

    test('sends a paired credential as the peer token', () async {
      when(() => client.getBrokerHealth()).thenAnswer(
        (_) async => const BrokerHealthResponse(
          ok: true,
          status: 'ok',
          checkedAt: 0,
          machine: 'agent-one',
        ),
      );

      await probe.probe(
        baseUrl: baseUrl,
        credential: 'peer-secret',
        credentialKind: BrokerCredentialKind.peerToken,
      );

      expect(capturedPeerToken, 'peer-secret');
      expect(capturedToken, isNull);
    });
  });
}
