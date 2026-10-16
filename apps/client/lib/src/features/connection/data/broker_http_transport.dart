import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Builds the HTTP transport one broker client sends its requests through.
typedef BrokerHttpTransport = HttpClientAdapter Function();

/// Overrides the HTTP transport of every broker client the app builds.
///
/// Null in the app: each REST client, health and auth probe, pairing request
/// and session stream-ticket request creates its own platform [Dio], exactly
/// as it did before this seam existed. Feature tests override it to serve
/// those requests from an in-process fake broker at the wire level, so the
/// real clients, auth headers and response decoding run unchanged.
final brokerHttpTransportProvider = Provider<BrokerHttpTransport?>(
  (ref) => null,
);

/// A fresh [Dio] on [transport], or null for the platform default.
///
/// Broker clients treat a null `dio` as "build your own", so passing this
/// result through leaves the app's behaviour unchanged when no override is
/// installed.
Dio? brokerTransportDio(BrokerHttpTransport? transport) {
  if (transport == null) return null;
  return Dio()..httpClientAdapter = transport();
}

/// A [Dio] on [transport] (the platform default when null) that calls
/// [onUnauthorized] for every response the broker refuses with HTTP 401.
///
/// The refusal still reaches the caller unchanged; this only lets the app
/// notice that the credential it sent stopped working.
Dio brokerTransportDioReportingUnauthorized(
  BrokerHttpTransport? transport, {
  required void Function() onUnauthorized,
}) => (brokerTransportDio(transport) ?? Dio())
  ..interceptors.add(
    InterceptorsWrapper(
      onError: (error, handler) {
        if (error.response?.statusCode == 401) onUnauthorized();
        handler.next(error);
      },
    ),
  );
