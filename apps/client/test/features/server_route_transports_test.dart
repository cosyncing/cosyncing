import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_route_transport.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_route_context.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/session_artifact_file_service.dart';
import 'package:cosyncing_client/src/platform/connection/broker_media_relay_io.dart';
import 'package:cosyncing_client/src/platform/connection/broker_route_transport_io.dart';
import 'package:dio/dio.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test(
    'saved proxy carries HTTP, TLS, streams and WebSockets without bypass',
    () async {
      final root = Directory.current.path.endsWith('/apps/client')
          ? Directory.current.parent.parent.path
          : Directory.current.path;
      final fixture = await Process.start(
        'bun',
        ['run', 'e2e/harness/fakes/native-proxy-fixture.ts'],
        workingDirectory: root,
        environment: {'COSYNCING_TEST_PROXY_IPV6': '1'},
      );
      final errors = StringBuffer();
      final stderr = fixture.stderr
          .transform(utf8.decoder)
          .listen(errors.write);
      final output = StreamIterator(
        fixture.stdout.transform(utf8.decoder).transform(const LineSplitter()),
      );
      addTearDown(() async {
        await fixture.stdin.close();
        try {
          expect(
            await fixture.exitCode.timeout(const Duration(seconds: 5)),
            0,
            reason: errors.toString(),
          );
        } on TimeoutException {
          fixture.kill(ProcessSignal.sigkill);
          await fixture.exitCode;
          fail('Proxy fixture did not close: $errors');
        } finally {
          await output.cancel();
          await stderr.cancel();
        }
      });
      expect(
        await output.moveNext().timeout(const Duration(seconds: 5)),
        isTrue,
      );
      final config = jsonDecode(output.current) as Map<String, dynamic>;
      SecurityContext.defaultContext.setTrustedCertificatesBytes(
        utf8.encode(config['caPem'] as String),
      );
      BrokerRouteContext context(
        BrokerProxyProtocol protocol, {
        bool tls = false,
        bool remoteDns = false,
        bool wrongPassword = false,
        bool ipv6 = false,
        String? destinationHost,
      }) {
        final proxy = BrokerProxyProfile(
          id: protocol.name,
          name: 'Local fixture',
          protocol: protocol,
          host: '127.0.0.1',
          port:
              config[protocol == BrokerProxyProtocol.http
                      ? 'httpPort'
                      : 'socksPort']
                  as int,
          generation: 1,
          credentialKey: 'fixture-secret',
        );
        return BrokerRouteContext(
          profileId: 'fixture',
          incarnation: 'one',
          routeId: 'primary',
          routeGeneration: 1,
          networkGeneration: 1,
          origin: Uri(
            scheme: tls ? 'https' : 'http',
            host:
                destinationHost ??
                (ipv6
                    ? '::1'
                    : (remoteDns ? 'proxy-only.invalid' : '127.0.0.1')),
            port:
                config[ipv6
                        ? (tls ? 'tls6Port' : 'plain6Port')
                        : (tls ? 'tlsPort' : 'plainPort')]
                    as int,
          ),
          proxyId: proxy.id,
          proxy: proxy,
          proxyCredentials: BrokerProxyCredentials(
            'fixture-user',
            wrongPassword ? 'wrong' : 'fixture-password',
          ),
        );
      }

      Dio client(BrokerRouteContext route) => Dio(
        BaseOptions(
          baseUrl: route.origin.toString(),
          followRedirects: false,
          connectTimeout: const Duration(seconds: 10),
          receiveTimeout: const Duration(seconds: 10),
          headers: {'x-cosyncing-token': 'broker-fixture-token'},
        ),
      )..httpClientAdapter = routeHttpAdapter(route);

      for (final protocol in BrokerProxyProtocol.values) {
        for (final tls in [false, true]) {
          final route = context(protocol, tls: tls, remoteDns: !tls);
          final http = client(route);
          try {
            expect(
              (await http.get<Map<String, dynamic>>('/ready')).data!['ok'],
              isTrue,
            );
            final range = await http.get<List<int>>(
              '/file',
              options: Options(
                headers: {'Range': 'bytes=32-63'},
                responseType: ResponseType.bytes,
              ),
            );
            expect(range.statusCode, 206);
            expect(range.data, List.filled(32, 97));
            final download = await http.get<ResponseBody>(
              '/file',
              options: Options(responseType: ResponseType.stream),
            );
            expect(
              await download.data!.stream.fold<int>(
                0,
                (n, data) => n + data.length,
              ),
              256 * 1024,
            );
            // Platform decoders only see a local capability. The relay sends
            // ranged media through the same proxy, retaining that approved path
            // during a healthy handoff and stopping it on sign-out/removal.
            final lease = BrokerRouteTransport(route);
            final (mediaUri, closeRelay) = await createBrokerMediaRelay(
              route,
              route.origin.replace(path: '/api/media-previews/${'A' * 43}'),
            );
            final release = lease.retainResource(closeRelay);
            final decoder = HttpClient()..findProxy = (_) => 'DIRECT';
            try {
              lease.retire(allowPinned: true);
              final mediaRequest = await decoder.getUrl(mediaUri);
              mediaRequest.headers.set('range', 'bytes=32-63');
              final media = await mediaRequest.close();
              expect(media.statusCode, 206);
              expect(
                await media.expand((bytes) => bytes).toList(),
                List.filled(32, 97),
              );
              final invalid = await decoder.getUrl(
                mediaUri.replace(path: '/not-the-capability'),
              );
              expect((await invalid.close()).statusCode, 404);
              lease.retire();
              await expectLater(
                () async => (await decoder.getUrl(mediaUri)).close(),
                throwsA(anyOf(isA<SocketException>(), isA<HttpException>())),
              );
            } finally {
              decoder.close(force: true);
              closeRelay();
              release();
            }
            final transferRoute = BrokerRouteTransport(route);
            final ordinary = BrokerClient(
              baseUrl: route.origin.toString(),
              token: 'broker-fixture-token',
              dio: transferRoute.dio(),
            );
            bindResolverRoute(ordinary.resolver, transferRoute);
            final backend = BrokerArtifactDownloadBackend(ordinary);
            try {
              await withPinnedBrokerRoute(ordinary, () async {
                final first = await backend.fetchArtifactUrlRangeBounded(
                  '/file',
                  rangeStart: 0,
                  rangeEnd: 31,
                  maxBytes: 32,
                );
                expect(first.bytes, List.filled(32, 97));
                // A provider replacing its REST client must not cancel the
                // already admitted transfer's next range on the old path.
                ordinary.close();
                transferRoute.retire(allowPinned: true);
                final next = await backend.fetchArtifactUrlRangeBounded(
                  '/file',
                  rangeStart: 32,
                  rangeEnd: 63,
                  maxBytes: 32,
                  ifRange: first.etag,
                );
                expect(next.bytes, List.filled(32, 97));
                expect(
                  transferRoute.dio,
                  throwsA(isA<BrokerRouteException>()),
                );
                transferRoute.retire();
                await expectLater(
                  backend.fetchArtifactUrlRangeBounded(
                    '/file',
                    rangeStart: 64,
                    rangeEnd: 95,
                    maxBytes: 32,
                  ),
                  throwsA(isA<BrokerException>()),
                );
              });
            } finally {
              ordinary.close();
              transferRoute.retire();
            }
            await expectLater(
              http.get<Object>('/redirect'),
              throwsA(isA<DioException>()),
            );
            final upload = await http.post<Map<String, dynamic>>(
              '/upload',
              data: Stream<List<int>>.fromIterable(
                List.generate(8, (_) => List.filled(8192, 42)),
              ),
              options: Options(
                headers: {'content-length': 65536},
                contentType: 'application/octet-stream',
              ),
            );
            expect(upload.data!['bytes'], 65536);
            final socket = routeSocketAdapter(
              route,
              route.origin
                  .replace(scheme: tls ? 'wss' : 'ws', path: '/stream')
                  .toString(),
            );
            final frames = StreamIterator(socket.messages);
            try {
              await socket.connect();
              expect(
                await frames.moveNext().timeout(const Duration(seconds: 10)),
                isTrue,
              );
              expect(frames.current, {'kind': 'ready'});
              socket.sendJson({'echo': protocol.name});
              expect(
                await frames.moveNext().timeout(const Duration(seconds: 10)),
                isTrue,
              );
              expect(frames.current, {'echo': protocol.name});
            } finally {
              await frames.cancel();
              await socket.close();
            }
          } on Object catch (error, stack) {
            final inspection = Dio();
            final evidence = await inspection.get<Object>(
              'http://127.0.0.1:${config['controlPort']}/',
            );
            inspection.close(force: true);
            Error.throwWithStackTrace(
              StateError(
                '${protocol.name} TLS=$tls: $error; ${evidence.data}; $errors',
              ),
              stack,
            );
          } finally {
            http.close(force: true);
          }
        }
        // These destinations listen on ::1; the fixture cannot silently map
        // IPv6 onto IPv4. Exercise both CONNECT/TLS and ordinary proxy HTTP,
        // including SOCKS address-type 4 and WebSocket framing.
        for (final tls in [false, true]) {
          final route = context(protocol, tls: tls, ipv6: true);
          final http = client(route);
          try {
            final range = await http.get<List<int>>(
              '/file',
              options: Options(
                headers: {'Range': 'bytes=32-63'},
                responseType: ResponseType.bytes,
              ),
            );
            expect(range.statusCode, 206);
            expect(range.data, List.filled(32, 97));
            final socket = routeSocketAdapter(
              route,
              route.origin
                  .replace(scheme: tls ? 'wss' : 'ws', path: '/stream')
                  .toString(),
            );
            final frames = StreamIterator(socket.messages);
            try {
              await socket.connect();
              expect(
                await frames.moveNext().timeout(const Duration(seconds: 10)),
                isTrue,
              );
              expect(frames.current, {'kind': 'ready'});
            } finally {
              await frames.cancel();
              await socket.close();
            }
          } finally {
            http.close(force: true);
          }
        }
        final failedDns = client(
          context(
            protocol,
            tls: true,
            destinationHost: 'missing.proxy-only.invalid',
          ),
        );
        try {
          await expectLater(
            failedDns.get<Object>('/must-not-arrive'),
            throwsA(
              isA<DioException>().having(
                (error) => error.error,
                'proxy failure',
                isA<BrokerRouteException>().having(
                  (error) => error.code,
                  'stage',
                  protocol == BrokerProxyProtocol.http
                      ? 'PROXY_TUNNEL_REFUSED'
                      : 'DESTINATION_UNAVAILABLE',
                ),
              ),
            ),
          );
        } finally {
          failedDns.close(force: true);
        }
        final hanging = client(
          context(protocol, tls: true, destinationHost: 'proxy-hang.invalid'),
        );
        final cancellation = CancelToken();
        try {
          final canceled = expectLater(
            hanging.get<Object>('/must-not-arrive', cancelToken: cancellation),
            throwsA(
              isA<DioException>().having(
                (error) => error.type,
                'kind',
                DioExceptionType.cancel,
              ),
            ),
          );
          expect(
            await output.moveNext().timeout(
              const Duration(seconds: 5),
              onTimeout: () => throw TimeoutException(
                '${protocol.name} did not reach the pending handshake',
              ),
            ),
            isTrue,
          );
          expect(jsonDecode(output.current), {'waiting': protocol.name});
          cancellation.cancel('Fixture cancellation');
          await canceled;
          expect(
            await output.moveNext().timeout(
              const Duration(seconds: 5),
              onTimeout: () => throw TimeoutException(
                '${protocol.name} socket stayed open after cancellation',
              ),
            ),
            isTrue,
          );
          expect(
            jsonDecode(output.current),
            {'closed': protocol.name},
            reason: 'Canceling a pending handshake must close the proxy socket',
          );
        } finally {
          cancellation.cancel();
          hanging.close(force: true);
        }
        final badCertificate = client(
          context(protocol, tls: true, remoteDns: true),
        );
        try {
          await expectLater(
            badCertificate.get<Object>('/bad-certificate'),
            throwsA(isA<DioException>()),
          );
        } finally {
          badCertificate.close(force: true);
        }
        final wrong = client(context(protocol, wrongPassword: true));
        try {
          await expectLater(
            wrong.get<Object>('/must-not-arrive'),
            throwsA(isA<DioException>()),
          );
        } finally {
          wrong.close(force: true);
        }
      }
      // Saved addresses usually omit the scheme's default port, as in
      // https://host.example. A Direct route must still open its socket there.
      // Tests cannot bind 443, so only the TCP target moves to the fixture's
      // listener; URL handling and the destination check run unchanged.
      final standardPort = BrokerRouteContext(
        profileId: 'fixture',
        incarnation: 'one',
        routeId: 'standard-port',
        routeGeneration: 1,
        networkGeneration: 1,
        origin: Uri.parse('https://127.0.0.1'),
      );
      await HttpOverrides.runWithHttpOverrides(() async {
        final socket = routeSocketAdapter(
          standardPort,
          'wss://127.0.0.1/stream',
        );
        final frames = StreamIterator(socket.messages);
        try {
          await socket.connect();
          expect(
            await frames.moveNext().timeout(const Duration(seconds: 10)),
            isTrue,
          );
          expect(frames.current, {'kind': 'ready'});
        } finally {
          await frames.cancel();
          await socket.close();
        }
      }, _StandardPortListener(config['tlsPort'] as int));
      final control = Dio();
      final evidence = (await control.get<Map<String, dynamic>>(
        'http://127.0.0.1:${config['controlPort']}/',
      )).data!;
      control.close(force: true);
      final requests = (evidence['requests'] as List)
          .cast<Map<String, dynamic>>();
      expect(
        requests.where((row) => row['path'] == '/must-not-arrive'),
        isEmpty,
      );
      expect(
        requests.every((row) => row['proxyAuthorization'] == false),
        isTrue,
        reason: requests.toString(),
      );
      expect(
        requests
            .where(
              (row) =>
                  row['path'] != '/stream' &&
                  !(row['path'] as String).startsWith('/api/media-previews/'),
            )
            .every((row) => row['token'] == 'broker-fixture-token'),
        isTrue,
      );
      final paths = (evidence['proxyRequests'] as List)
          .cast<Map<String, dynamic>>();
      for (final protocol in ['http', 'http-connect', 'socks5']) {
        expect(
          paths.any(
            (row) =>
                row['protocol'] == protocol &&
                ['::1', '[::1]'].contains(row['host']),
          ),
          isTrue,
          reason: '$protocol must carry the literal IPv6 destination',
        );
      }
      for (final protocol in ['http-connect', 'socks5']) {
        expect(
          paths.any(
            (row) =>
                row['protocol'] == protocol &&
                row['host'] == 'missing.proxy-only.invalid',
          ),
          isTrue,
          reason: 'Destination DNS failure must originate at the chosen proxy',
        );
      }
      expect(paths.any((row) => row['host'] == 'unapproved.invalid'), isFalse);
      expect(requests.any((row) => row['path'] == '/bad-certificate'), isFalse);
      expect(
        paths.any(
          (row) =>
              row['protocol'] == 'socks5' &&
              row['host'] == 'proxy-only.invalid',
        ),
        isTrue,
      );
      expect(
        paths.any(
          (row) =>
              row['protocol'] == 'http-connect' && row['authenticated'] == true,
        ),
        isTrue,
      );
    },
    timeout: const Timeout(Duration(seconds: 90)),
  );
}

/// Stands one local TLS listener in for a host's standard HTTPS port.
final class _StandardPortListener extends HttpOverrides {
  _StandardPortListener(this.port);
  final int port;

  @override
  HttpClient createHttpClient(SecurityContext? context) =>
      super.createHttpClient(context)
        ..connectionFactory = (uri, _, _) =>
            SecureSocket.startConnect(uri.host, port);
}
