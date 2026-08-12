import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/connection/model/real_broker_health_probe.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:mocktail/mocktail.dart';

class MockBrokerClient extends Mock implements BrokerClient {}

void main() {
  late MockBrokerClient client;
  late RealBrokerHealthProbe probe;

  setUp(() {
    client = MockBrokerClient();
    probe = RealBrokerHealthProbe(clientFactory: (_) => client);
  });

  test('returns success result on healthy broker response', () async {
    when(() => client.getHealth()).thenAnswer(
      (_) async => const HealthResponse(
        ok: true,
        machine: 'agent-one',
        controlMode: 'observe-drive',
        codexSyncServer: false,
      ),
    );

    final result = await probe.probe(Uri.parse('http://127.0.0.1:7734'));

    expect(result.isSuccess, isTrue);
    expect(result.machine, 'agent-one');
    verify(() => client.getHealth()).called(1);
    verify(() => client.close()).called(1);
  });

  test('returns failure result on unhealthy broker response', () async {
    when(() => client.getHealth()).thenAnswer(
      (_) async => const HealthResponse(
        ok: false,
        machine: 'agent-one',
        controlMode: 'observe-drive',
        codexSyncServer: false,
      ),
    );

    final result = await probe.probe(Uri.parse('http://127.0.0.1:7734'));

    expect(result.isSuccess, isFalse);
    expect(result.error, contains('reported itself unhealthy'));
    verify(() => client.close()).called(1);
  });

  test('returns failure result on BrokerException', () async {
    when(() => client.getHealth()).thenThrow(
      const BrokerException(message: 'broker unavailable', statusCode: 503),
    );

    final result = await probe.probe(Uri.parse('http://127.0.0.1:7734'));

    expect(result.isSuccess, isFalse);
    // The broker's own 5xx text is diagnostic, not instruction: it moves to
    // `detail` and the user reads a classified message instead.
    expect(result.error, contains("Couldn't reach the server"));
    expect(result.error, contains('on its end'));
    expect(result.error, isNot(contains('broker unavailable')));
    expect(result.detail, contains('broker unavailable'));
    verify(() => client.close()).called(1);
  });

  test('returns failure result on unexpected transport error', () async {
    when(() => client.getHealth()).thenThrow(StateError('network down'));

    final result = await probe.probe(Uri.parse('http://127.0.0.1:7734'));

    expect(result.isSuccess, isFalse);
    expect(result.error, contains("Couldn't reach the server"));
    expect(result.error, isNot(contains('network down')));
    expect(result.detail, contains('network down'));
    verify(() => client.close()).called(1);
  });
}
