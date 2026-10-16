import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_http_transport.dart';

import 'package:cosyncing_client/src/features/connection/model/broker_health_probe.dart';
import 'package:cosyncing_client/src/features/connection/model/health_probe_result.dart';

/// Real health probe implementation backed by [BrokerClient].
///
/// A small adapter from UI contract (`Uri`) to pure-Dart transport.
/// This preserves a clean seam for fake-first testing while keeping
/// transport in the package boundary.
/// See `docs/protocol/contract-sync.md`.
class RealBrokerHealthProbe implements BrokerHealthProbe {
  /// Creates a [RealBrokerHealthProbe].
  ///
  /// [clientFactory] is optional for testing and defaults to constructing
  /// a real client with the provided broker URL on [transport] (the platform
  /// HTTP transport when null).
  RealBrokerHealthProbe({
    BrokerClient Function(String baseUrl)? clientFactory,
    BrokerHttpTransport? transport,
    this.timeout,
  }) : _clientFactory =
           clientFactory ??
           ((baseUrl) => BrokerClient(
             baseUrl: baseUrl,
             dio: brokerTransportDio(transport),
           ));

  final BrokerClient Function(String baseUrl) _clientFactory;

  /// Optional upper bound for the transport request.
  final Duration? timeout;

  @override
  Future<HealthProbeResult> probe(Uri baseUrl) async {
    final client = _clientFactory(baseUrl.toString());
    try {
      final request = client.getHealth();
      final requestTimeout = timeout;
      final response = requestTimeout == null
          ? await request
          : await request.timeout(requestTimeout);
      if (!response.ok) {
        return const HealthProbeResult.failure(
          error: LocalizedFailure.notice(FailureLead.serverUnhealthy),
          unhealthy: true,
        );
      }
      return HealthProbeResult.success(machine: response.machine);
    } on TimeoutException catch (e) {
      // The server took the connection and sent nothing back in time: say so,
      // rather than calling a busy or stuck server unreachable.
      return HealthProbeResult.failure(
        error: LocalizedFailure.from(e, lead: FailureLead.reachServer),
        detail: failureDetail(e),
        noAnswer: true,
      );
    } on Object catch (e) {
      // Classified rather than dumped, matching the sibling
      // `RealBrokerAuthProbe`. A dropped connection used to surface here as
      // raw SocketException/ClientException text in the Connection screen's
      // status card.
      return HealthProbeResult.failure(
        error: LocalizedFailure.from(e, lead: FailureLead.reachServer),
        detail: failureDetail(e),
      );
    } finally {
      client.close();
    }
  }
}
