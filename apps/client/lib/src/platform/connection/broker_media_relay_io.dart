import 'dart:async';
import 'dart:io';

import 'package:cosyncing_client/src/features/connection/model/broker_route_context.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_routes.dart';
import 'package:cosyncing_client/src/platform/connection/broker_route_transport_io.dart';

/// Gives platform decoders a revocable loopback capability. Their requests can
/// never select a destination: the relay owns one exact broker media ticket and
/// uses the same native proxy/TLS adapter as REST and WebSockets. addStream
/// preserves socket backpressure instead of buffering a movie in memory.
Future<(Uri, void Function())> createBrokerMediaRelay(
  BrokerRouteContext context,
  Uri destination,
) async {
  context.requireDestination(destination);
  if (!RegExp(
        r'^/api/media-previews/[A-Za-z0-9_-]{43}$',
      ).hasMatch(destination.path) ||
      destination.hasQuery ||
      destination.hasFragment) {
    throw const BrokerRouteException('DESTINATION_NOT_VERIFIED');
  }
  final client = routeNativeHttpClient(context)
    ..maxConnectionsPerHost = 4
    ..autoUncompress = false;
  final HttpServer server;
  try {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
  } on Object {
    client.close(force: true);
    rethrow;
  }
  final local = Uri.parse(
    'http://127.0.0.1:${server.port}/${newConnectionId()}',
  );
  var active = 0;
  var closed = false;
  void close() {
    if (closed) return;
    closed = true;
    client.close(force: true);
    unawaited(server.close(force: true));
  }

  Future<void> serve(HttpRequest request) async {
    final response = request.response;
    HttpClientRequest? upstream;
    try {
      if (closed ||
          request.uri.path != local.path ||
          request.uri.hasQuery ||
          request.headers.value(HttpHeaders.hostHeader) != local.authority) {
        response.statusCode = HttpStatus.notFound;
        return;
      }
      if (!['GET', 'HEAD'].contains(request.method)) {
        response.statusCode = HttpStatus.methodNotAllowed;
        return;
      }
      if (active >= 4) {
        response.statusCode = HttpStatus.tooManyRequests;
        return;
      }
      active++;
      try {
        upstream = (await client.openUrl(request.method, destination))
          ..followRedirects = false;
        for (final name in [
          'range',
          'if-range',
          'if-none-match',
          'if-modified-since',
        ]) {
          final value = request.headers.value(name);
          if (value != null) upstream.headers.set(name, value);
        }
        final incoming = await upstream.close().timeout(
          const Duration(seconds: 20),
        );
        if (incoming.statusCode >= 300 &&
            incoming.statusCode < 400 &&
            incoming.statusCode != 304) {
          upstream.abort();
          response.statusCode = HttpStatus.badGateway;
          return;
        }
        response.statusCode = incoming.statusCode;
        for (final name in [
          'content-type',
          'content-length',
          'content-range',
          'accept-ranges',
          'etag',
          'last-modified',
          'cache-control',
        ]) {
          final value = incoming.headers.value(name);
          if (value != null) response.headers.set(name, value);
        }
        response.headers.set('x-content-type-options', 'nosniff');
        await response.addStream(incoming.timeout(const Duration(seconds: 20)));
      } finally {
        active--;
      }
    } on Object {
      upstream?.abort();
      // No exception text, remote URL, broker token or proxy secret is exposed
      // to platform viewers or to another local process.
      try {
        response.statusCode = HttpStatus.badGateway;
      } on Object {
        /* Headers may already be sent. */
      }
    } finally {
      try {
        await response.close();
      } on Object {
        upstream?.abort();
      }
    }
  }

  server.listen(
    (request) => unawaited(serve(request)),
    onError: (Object _) => close(),
  );
  return (local, close);
}
