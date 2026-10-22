// Optional transport measurements, outside the routine test discovery tree.
// Run from the repository root using the app's Flutter test configuration:
// PROXY_BENCH_OUT=/absolute/path/output/review/proxy.json \
//   bun scripts/client/run-client-command.ts flutter test \
//   ../../scripts/client/benchmark-native-proxy.dart --reporter expanded
// This measures real native I/O in the test VM, not release UI or energy cost.
import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:cosyncing_client/src/features/connection/model/broker_route_context.dart';
import 'package:cosyncing_client/src/platform/connection/broker_media_relay_io.dart';
import 'package:cosyncing_client/src/platform/connection/broker_route_transport_io.dart';
import 'package:flutter_test/flutter_test.dart';

Map<String, Object> resources() {
  final result = <String, Object>{
    'rssBytes': ProcessInfo.currentRss,
    'highWaterBytes': ProcessInfo.maxRss,
  };
  if (Platform.isLinux) {
    // Descriptor links can disappear while sockets close. Count entries
    // without following those links into files or directories.
    result['descriptors'] = Directory(
      '/proc/self/fd',
    ).listSync(followLinks: false).length;
    final stat = File('/proc/self/stat').readAsStringSync();
    final fields = stat.substring(stat.lastIndexOf(')') + 2).split(' ');
    result['cpuTicks'] = int.parse(fields[11]) + int.parse(fields[12]);
  }
  return result;
}

double milliseconds(Stopwatch watch) => watch.elapsedMicroseconds / 1000;

void main() {
  test(
    'optional native proxy large-transfer measurements',
    () async {
      final destination = Platform.environment['PROXY_BENCH_OUT'];
      if (destination == null || !destination.startsWith('/')) {
        throw ArgumentError('Set PROXY_BENCH_OUT to an absolute output path');
      }
      final rounds = int.parse(
        Platform.environment['PROXY_BENCH_ROUNDS'] ?? '20',
      );
      final tlsFilter = Platform.environment['PROXY_BENCH_TLS'];
      final pathFilter = Platform.environment['PROXY_BENCH_PATH'];
      if (![null, 'true', 'false'].contains(tlsFilter) ||
          ![null, 'direct', 'http', 'socks5'].contains(pathFilter)) {
        throw ArgumentError(
          'Use PROXY_BENCH_TLS=true|false and PROXY_BENCH_PATH=direct|http|socks5',
        );
      }
      final bytes = int.parse(
        Platform.environment['PROXY_BENCH_BYTES'] ?? '${32 * 1024 * 1024}',
      );
      if (rounds < 1 ||
          rounds > 100 ||
          bytes < 65536 ||
          bytes > 64 * 1024 * 1024) {
        throw ArgumentError('Use 1..100 rounds and 64 KiB..64 MiB bodies');
      }
      final root = Directory.current.path.endsWith('/apps/client')
          ? Directory.current.parent.parent.path
          : Directory.current.path;
      final fixture = await Process.start(
        'bun',
        ['run', 'e2e/harness/fakes/native-proxy-fixture.ts'],
        workingDirectory: root,
        environment: {'COSYNCING_TEST_PROXY_BYTES': '$bytes'},
      );
      final errors = StringBuffer();
      final stderr = fixture.stderr
          .transform(utf8.decoder)
          .listen(errors.write);
      Map<String, dynamic>? fixtureConfig;
      final lines = StreamIterator(
        fixture.stdout.transform(utf8.decoder).transform(const LineSplitter()),
      );
      try {
        if (!await lines.moveNext().timeout(const Duration(seconds: 10))) {
          throw StateError('Fixture did not start: $errors');
        }
        final config = jsonDecode(lines.current) as Map<String, dynamic>;
        fixtureConfig = config;
        SecurityContext.defaultContext.setTrustedCertificatesBytes(
          utf8.encode(config['caPem'] as String),
        );
        Map<String, Object?>? phase;
        final samples = <Map<String, Object?>>[];
        final setups = <Map<String, Object?>>[];
        final initialResources = resources();
        void save() {
          final output = File(destination)..parent.createSync(recursive: true);
          output.writeAsStringSync(
            const JsonEncoder.withIndent('  ').convert({
              'measuredAt': DateTime.now().toUtc().toIso8601String(),
              'platform': Platform.operatingSystem,
              'runtime': Platform.version,
              'rounds': rounds,
              'tlsFilter': tlsFilter,
              'pathFilter': pathFilter,
              'fileBytes': bytes,
              'samples': samples,
              'phase': phase,
              'setups': setups,
              'resourcesBefore': initialResources,
              'resourcesAfter': resources(),
              'limitations': [
                'Candidate transport in the Flutter test VM, not profile/release UI.',
                'Controlled loopback proxy; no artificial DNS/authentication delay.',
                'No pre-change native comparison, frame, physical mobile, or energy evidence.',
                'Resource samples include the test VM; high-water RSS is cumulative.',
              ],
            }),
          );
        }

        for (final tls in [false, true]) {
          if (tlsFilter != null && tls.toString() != tlsFilter) continue;
          final paths =
              <
                ({
                  String name,
                  BrokerRouteContext route,
                  HttpClient client,
                  StreamIterator<Object?> frames,
                  void Function(Object) send,
                  Future<void> Function() close,
                })
              >[];
          try {
            for (final protocol in [null, ...BrokerProxyProtocol.values]) {
              final name = protocol?.name ?? 'direct';
              if (pathFilter != null && name != pathFilter) continue;
              final proxy = protocol == null
                  ? null
                  : BrokerProxyProfile(
                      id: name,
                      name: name,
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
              final route = BrokerRouteContext(
                profileId: 'fixture',
                incarnation: 'one',
                routeId: name,
                routeGeneration: 1,
                networkGeneration: 1,
                origin: Uri(
                  scheme: tls ? 'https' : 'http',
                  host: protocol != null && !tls
                      ? 'proxy-only.invalid'
                      : '127.0.0.1',
                  port: config[tls ? 'tlsPort' : 'plainPort'] as int,
                ),
                proxyId: proxy?.id,
                proxy: proxy,
                proxyCredentials: proxy == null
                    ? null
                    : const BrokerProxyCredentials(
                        'fixture-user',
                        'fixture-password',
                      ),
              );
              final client = routeNativeHttpClient(route);
              final socket = routeSocketAdapter(
                route,
                route.origin
                    .replace(scheme: tls ? 'wss' : 'ws', path: '/stream')
                    .toString(),
              );
              final frames = StreamIterator(socket.messages);
              final connect = Stopwatch()..start();
              try {
                await socket.connect();
                expect(
                  await frames.moveNext().timeout(const Duration(seconds: 10)),
                  isTrue,
                );
                expect(frames.current, {'kind': 'ready'});
                paths.add((
                  name: name,
                  route: route,
                  client: client,
                  frames: frames,
                  send: socket.sendJson,
                  close: socket.close,
                ));
                setups.add({
                  'path': name,
                  'tls': tls,
                  'websocketMs': milliseconds(connect),
                });
              } on Object {
                client.close(force: true);
                await frames.cancel();
                await socket.close();
                rethrow;
              }
            }
            for (var round = 0; round < rounds; round++) {
              // Rotate all three paths so no protocol always runs first.
              for (var order = 0; order < paths.length; order++) {
                final path = paths[(order + round) % paths.length];
                final before = resources();
                void beginPhase(String name) {
                  phase = {
                    'round': round,
                    'path': path.name,
                    'tls': tls,
                    'operation': name,
                    'startedAt': DateTime.now().toUtc().toIso8601String(),
                  };
                  File(
                    '$destination.progress.json',
                  ).writeAsStringSync(jsonEncode(phase));
                }

                Future<Map<String, Object>> download({int? rangeEnd}) async {
                  beginPhase(rangeEnd == null ? 'download' : 'range');
                  final watch = Stopwatch()..start();
                  final request = await path.client
                      .getUrl(path.route.origin.replace(path: '/file'))
                      .timeout(const Duration(seconds: 20));
                  request.followRedirects = false;
                  if (rangeEnd != null)
                    request.headers.set('range', 'bytes=0-$rangeEnd');
                  final response = await request.close().timeout(
                    const Duration(seconds: 20),
                  );
                  expect(response.statusCode, rangeEnd == null ? 200 : 206);
                  final count = await response
                      .timeout(const Duration(seconds: 20))
                      .fold<int>(0, (n, chunk) => n + chunk.length);
                  expect(count, rangeEnd == null ? bytes : rangeEnd + 1);
                  return {'bytes': count, 'ms': milliseconds(watch)};
                }

                final echo = <double>[];
                Future<void> foreground() async {
                  for (var i = 0; i < 20; i++) {
                    final marker = '$tls/$round/$order/$i';
                    final watch = Stopwatch()..start();
                    path.send({'echo': marker});
                    expect(
                      await path.frames.moveNext().timeout(
                        const Duration(seconds: 10),
                      ),
                      isTrue,
                    );
                    expect(path.frames.current, {'echo': marker});
                    echo.add(milliseconds(watch));
                  }
                }

                final both = await Future.wait<Object?>([
                  download(),
                  foreground().then<Object?>((_) => null),
                ], eagerError: true);
                final ranged = await download(rangeEnd: bytes ~/ 2 - 1);
                beginPhase('upload');
                final uploadWatch = Stopwatch()..start();
                final upload = await path.client
                    .postUrl(path.route.origin.replace(path: '/upload'))
                    .timeout(const Duration(seconds: 20));
                upload.contentLength = bytes;
                upload.followRedirects = false;
                final chunk = Uint8List(65536);
                Stream<List<int>> chunks() async* {
                  for (var sent = 0; sent < bytes; sent += chunk.length) {
                    yield bytes - sent < chunk.length
                        ? Uint8List.sublistView(chunk, 0, bytes - sent)
                        : chunk;
                  }
                }

                await upload
                    .addStream(chunks())
                    .timeout(const Duration(seconds: 20));
                final uploaded = await upload.close().timeout(
                  const Duration(seconds: 20),
                );
                if (uploaded.statusCode != 200) {
                  final inspection = HttpClient()..findProxy = (_) => 'DIRECT';
                  try {
                    final request = await inspection.getUrl(
                      Uri.parse('http://127.0.0.1:${config['controlPort']}/'),
                    );
                    final evidence = await (await request.close())
                        .transform(utf8.decoder)
                        .join();
                    File(
                      '$destination.failure.json',
                    ).writeAsStringSync(evidence);
                    fail(
                      '${path.name} TLS=$tls upload returned ${uploaded.statusCode}; $evidence',
                    );
                  } finally {
                    inspection.close(force: true);
                  }
                }
                expect(
                  jsonDecode(
                    await uploaded
                        .timeout(const Duration(seconds: 20))
                        .transform(utf8.decoder)
                        .join(),
                  ),
                  {'bytes': bytes},
                );
                final uploadMs = milliseconds(uploadWatch);
                beginPhase('media');
                final mediaWatch = Stopwatch()..start();
                final remoteMedia = path.route.origin.replace(
                  path: '/api/media-previews/${'A' * 43}',
                );
                // Match brokerMediaSource: Direct decoders use the ticket URL;
                // only a proxy-required route creates the capability relay.
                final (mediaUri, stopMedia) = path.route.requiresProxy
                    ? await createBrokerMediaRelay(path.route, remoteMedia)
                    : (remoteMedia, () {});
                final decoder = HttpClient()..findProxy = (_) => 'DIRECT';
                try {
                  final media = await decoder
                      .getUrl(mediaUri)
                      .timeout(const Duration(seconds: 20));
                  media.headers.set('range', 'bytes=0-${bytes ~/ 2 - 1}');
                  final response = await media.close().timeout(
                    const Duration(seconds: 20),
                  );
                  expect(response.statusCode, 206);
                  expect(
                    await response
                        .timeout(const Duration(seconds: 20))
                        .fold<int>(0, (n, part) => n + part.length),
                    bytes ~/ 2,
                  );
                } finally {
                  decoder.close(force: true);
                  stopMedia();
                }
                phase = null;
                samples.add({
                  'round': round,
                  'order': order,
                  'path': path.name,
                  'tls': tls,
                  'before': before,
                  'full': both[0],
                  'range': ranged,
                  'uploadMs': uploadMs,
                  'mediaRangeMs': milliseconds(mediaWatch),
                  'streamMs': echo,
                  'after': resources(),
                });
                save();
              }
            }
          } finally {
            for (final path in paths) {
              path.client.close(force: true);
              await path.frames.cancel();
              await path.close();
            }
          }
          save();
        }
      } on Object catch (error) {
        final inspection = HttpClient()..findProxy = (_) => 'DIRECT';
        try {
          final request = await inspection
              .getUrl(
                Uri.parse('http://127.0.0.1:${fixtureConfig!['controlPort']}/'),
              )
              .timeout(const Duration(seconds: 3));
          final response = await request.close().timeout(
            const Duration(seconds: 3),
          );
          final evidence = await response
              .timeout(const Duration(seconds: 3))
              .transform(utf8.decoder)
              .join();
          File('$destination.failure.json').writeAsStringSync(
            jsonEncode({
              'error': error.toString(),
              'fixture': jsonDecode(evidence),
              'phase': File('$destination.progress.json').existsSync()
                  ? jsonDecode(
                      File('$destination.progress.json').readAsStringSync(),
                    )
                  : null,
            }),
          );
        } on Object {
          // Preserve the original failure when the fixture itself has exited.
        } finally {
          inspection.close(force: true);
        }
        rethrow;
      } finally {
        await fixture.stdin.close();
        try {
          expect(
            await fixture.exitCode.timeout(const Duration(seconds: 10)),
            0,
            reason: errors.toString(),
          );
        } on TimeoutException {
          fixture.kill(ProcessSignal.sigkill);
          await fixture.exitCode;
          rethrow;
        } finally {
          await lines.cancel();
          await stderr.cancel();
        }
      }
    },
    timeout: const Timeout(Duration(minutes: 10)),
  );
}
