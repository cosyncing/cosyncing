import 'dart:async';
import 'dart:convert';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:dio/dio.dart';
import 'package:test/test.dart';

final class _ImmediateFrameWebSocketAdapter extends FakeWebSocketAdapter {
  @override
  Future<void> connect() async {
    await super.connect();
    simulateMessage({
      'kind': 'session',
      'info': {
        'id': 'session-1',
        'tool': 'opencode',
        'title': 'Immediate session',
        'status': 'idle',
        'attachMode': 'observe',
      },
    });
    simulateMessage({
      'kind': 'history',
      'reset': true,
      'messages': const <Object?>[],
      'cursor': 'immediate-cursor',
    });
  }
}

/// A socket that reports itself not open while the connection still holds
/// it (a handshake in flight, or a close not yet reported).
final class _ClosingWebSocketAdapter extends FakeWebSocketAdapter {
  bool open = true;

  @override
  bool get isConnected => open && super.isConnected;
}

final class _ImmediateEndedWebSocketAdapter extends FakeWebSocketAdapter {
  @override
  Future<void> connect() async {
    await super.connect();
    simulateMessage({'kind': 'ended', 'reason': 'native-ended'});
  }
}

void main() {
  group('SessionConnection', () {
    late FakeWebSocketAdapter adapter;
    String? streamUrl;
    late SessionConnection connection;
    late List<WireEvent> receivedEvents;
    late List<SessionConnectionState> stateChanges;

    SessionConnection createConnection({
      String tool = 'opencode',
      String sessionId = 'session-1',
      String baseUrl = 'http://127.0.0.1:7734',
      String artifactMode = 'reference',
      String? mode,
      String? reason,
      bool readOnly = false,
      int initialHistory = 100,
    }) {
      final resolver = EndpointResolver(baseUrl: baseUrl);
      return SessionConnection(
        resolver: resolver,
        tool: tool,
        sessionId: sessionId,
        artifactMode: artifactMode,
        mode: mode,
        reason: reason,
        readOnly: readOnly,
        initialHistory: initialHistory,
        adapterFactory: (url) {
          streamUrl = url;
          return adapter = FakeWebSocketAdapter();
        },
      );
    }

    /// Allow microtasks to flush (broadcast stream delivery,
    /// async continuations after await).
    Future<void> flush() => Future<void>.delayed(Duration.zero);

    setUp(() {
      receivedEvents = [];
      stateChanges = [];
      connection = createConnection();
      connection.events.listen(receivedEvents.add);
      connection.stateStream.listen(stateChanges.add);
    });

    tearDown(() async {
      await connection.dispose();
    });

    group('connect', () {
      test(
        'captures frames emitted synchronously during adapter connect',
        () async {
          final immediateAdapter = _ImmediateFrameWebSocketAdapter();
          connection = SessionConnection(
            resolver: EndpointResolver(baseUrl: 'http://127.0.0.1:7734'),
            tool: 'opencode',
            sessionId: 'session-1',
            adapterFactory: (_) => immediateAdapter,
          );
          connection.events.listen(receivedEvents.add);

          await connection.connect();
          await flush();

          expect(receivedEvents.whereType<SessionWireEvent>(), hasLength(1));
          expect(receivedEvents.whereType<HistoryWireEvent>(), hasLength(1));
          expect(connection.cursor, 'immediate-cursor');
        },
      );

      test(
        'does not reconnect after synchronous ended during connect',
        () async {
          final immediateAdapter = _ImmediateEndedWebSocketAdapter();
          connection = SessionConnection(
            resolver: EndpointResolver(baseUrl: 'http://127.0.0.1:7734'),
            tool: 'opencode',
            sessionId: 'session-1',
            adapterFactory: (_) => immediateAdapter,
          );
          connection.events.listen(receivedEvents.add);

          await connection.connect();
          await flush();

          expect(receivedEvents.whereType<EndedWireEvent>(), hasLength(1));
          expect(connection.state, SessionConnectionState.closed);
          expect(immediateAdapter.isConnected, isFalse);
        },
      );

      test('transitions to connecting then connected', () async {
        await connection.connect();
        await flush();
        expect(connection.state, SessionConnectionState.connected);
        expect(
          stateChanges,
          contains(SessionConnectionState.connecting),
        );
        expect(
          stateChanges,
          contains(SessionConnectionState.connected),
        );
      });

      test(
        'requests artifactMode=reference by default for stream URL',
        () async {
          streamUrl = null;
          connection = createConnection();
          connection.events.listen(receivedEvents.add);
          connection.stateStream.listen(stateChanges.add);

          await connection.connect();
          await flush();

          expect(streamUrl, isNotNull);
          expect(
            Uri.parse(streamUrl!).queryParameters['artifactMode'],
            'reference',
          );
        },
      );

      test(
        'exchanges header credential for a one-use WebSocket ticket',
        () async {
          final dio = Dio();
          RequestOptions? ticketRequest;
          dio.interceptors.add(
            InterceptorsWrapper(
              onRequest: (options, handler) {
                if (options.path.endsWith('/api/health')) {
                  handler.resolve(
                    Response<Map<String, dynamic>>(
                      requestOptions: options,
                      statusCode: 200,
                      data: {
                        'ok': true,
                        'contract': {'revision': 16},
                      },
                    ),
                  );
                  return;
                }
                ticketRequest = options;
                handler.resolve(
                  Response<Map<String, dynamic>>(
                    requestOptions: options,
                    statusCode: 201,
                    data: {
                      'ok': true,
                      'wsAuthTicket': 'short-lived-ticket',
                      'expiresAt': '2026-08-22T00:00:30.000Z',
                    },
                  ),
                );
              },
            ),
          );
          String? ticketedUrl;
          final ticketed = SessionConnection(
            resolver: EndpointResolver(
              baseUrl: 'https://broker.example.com',
              token: 'long-lived-secret',
            ),
            tool: 'codex',
            sessionId: 'session-ticket',
            dio: dio,
            adapterFactory: (url) {
              ticketedUrl = url;
              return FakeWebSocketAdapter();
            },
          );
          addTearDown(ticketed.dispose);

          await ticketed.connect();

          expect(
            ticketRequest?.uri.toString(),
            'https://broker.example.com/api/ws-auth-tickets',
          );
          expect(
            ticketRequest?.headers['x-cosyncing-token'],
            'long-lived-secret',
          );
          final parsed = Uri.parse(ticketedUrl!);
          expect(parsed.queryParameters, {
            'wsAuthTicket': 'short-lived-ticket',
          });
          expect(ticketedUrl, isNot(contains('long-lived-secret')));
        },
      );

      test(
        'maps minimal health with a credential to an authentication error',
        () async {
          final dio = Dio();
          dio.interceptors.add(
            InterceptorsWrapper(
              onRequest: (options, handler) {
                handler.resolve(
                  Response<Map<String, dynamic>>(
                    requestOptions: options,
                    statusCode: 200,
                    data: {'ok': true},
                  ),
                );
              },
            ),
          );
          final rejected = SessionConnection(
            resolver: EndpointResolver(
              baseUrl: 'https://broker.example.com',
              token: 'revoked-secret',
            ),
            tool: 'codex',
            sessionId: 'rejected-session',
            dio: dio,
            adapterFactory: (_) => FakeWebSocketAdapter(),
          );
          addTearDown(rejected.dispose);

          await rejected.connect();

          expect(
            rejected.lastConnectionError,
            isA<BrokerException>()
                .having((error) => error.statusCode, 'statusCode', 401)
                .having(
                  (error) => error.error?.code,
                  'code',
                  'AUTH_REQUIRED',
                ),
          );
          expect(rejected.state, SessionConnectionState.reconnecting);
        },
      );

      test('bounds ticket acquisition when the broker is half-open', () async {
        final dio = Dio();
        dio.interceptors.add(
          InterceptorsWrapper(
            onRequest: (options, handler) {
              if (options.path.endsWith('/api/health')) {
                handler.resolve(
                  Response<Map<String, dynamic>>(
                    requestOptions: options,
                    statusCode: 200,
                    data: {
                      'ok': true,
                      'contract': {'revision': 16},
                    },
                  ),
                );
              }
              // Deliberately leave the ticket request unresolved.
            },
          ),
        );
        final bounded = SessionConnection(
          resolver: EndpointResolver(
            baseUrl: 'https://half-open.example.com',
            token: 'credential',
          ),
          tool: 'codex',
          sessionId: 'bounded-session',
          dio: dio,
          authRequestTimeout: const Duration(milliseconds: 20),
          adapterFactory: (_) => FakeWebSocketAdapter(),
        );
        addTearDown(() async {
          await bounded.dispose();
          dio.close(force: true);
        });

        await bounded.connect();

        expect(bounded.lastConnectionError, isA<TimeoutException>());
        expect(bounded.state, SessionConnectionState.reconnecting);
      });

      test(
        'refuses a revision 15 broker without putting a credential in a URL',
        () async {
          final dio = Dio();
          var ticketRequests = 0;
          var socketUrls = 0;
          dio.interceptors.add(
            InterceptorsWrapper(
              onRequest: (options, handler) {
                if (options.path.endsWith('/api/ws-auth-tickets')) {
                  ticketRequests += 1;
                }
                handler.resolve(
                  Response<Map<String, dynamic>>(
                    requestOptions: options,
                    statusCode: 200,
                    data: {
                      'ok': true,
                      'contract': {'revision': 15},
                    },
                  ),
                );
              },
            ),
          );
          final legacy = SessionConnection(
            resolver: EndpointResolver(
              baseUrl: 'https://old-broker.example.com',
              token: 'rollout-only-secret',
            ),
            tool: 'codex',
            sessionId: 'legacy-session',
            dio: dio,
            adapterFactory: (_) {
              socketUrls += 1;
              return FakeWebSocketAdapter();
            },
          );
          addTearDown(legacy.dispose);

          await legacy.connect();

          expect(ticketRequests, 0);
          expect(socketUrls, 0);
          expect(legacy.lastConnectionError, isA<UnsupportedError>());
          expect(legacy.state, SessionConnectionState.reconnecting);
        },
      );

      test(
        'refuses revision 14 without putting a credential in a URL',
        () async {
          final dio = Dio();
          var ticketRequests = 0;
          var socketUrls = 0;
          dio.interceptors.add(
            InterceptorsWrapper(
              onRequest: (options, handler) {
                if (options.path.endsWith('/api/ws-auth-tickets')) {
                  ticketRequests += 1;
                }
                handler.resolve(
                  Response<Map<String, dynamic>>(
                    requestOptions: options,
                    statusCode: 200,
                    data: {
                      'ok': true,
                      'contract': {'revision': 14},
                    },
                  ),
                );
              },
            ),
          );
          final unsupported = SessionConnection(
            resolver: EndpointResolver(
              baseUrl: 'https://unsupported-broker.example.com',
              token: 'must-not-enter-a-url',
            ),
            tool: 'codex',
            sessionId: 'unsupported-session',
            dio: dio,
            adapterFactory: (url) {
              socketUrls += 1;
              return FakeWebSocketAdapter();
            },
          );
          addTearDown(unsupported.dispose);

          await unsupported.connect();

          expect(ticketRequests, 0);
          expect(socketUrls, 0);
          expect(unsupported.lastConnectionError, isA<UnsupportedError>());
          expect(unsupported.state, SessionConnectionState.reconnecting);
        },
      );

      test(
        'automatic reconnect starts after revision 15 upgrades to '
        'ticket authentication',
        () async {
          final dio = Dio();
          var brokerRevision = 15;
          var healthRequests = 0;
          var ticketRequests = 0;
          dio.interceptors.add(
            InterceptorsWrapper(
              onRequest: (options, handler) {
                if (options.path.endsWith('/api/health')) {
                  healthRequests += 1;
                  handler.resolve(
                    Response<Map<String, dynamic>>(
                      requestOptions: options,
                      statusCode: 200,
                      data: {
                        'ok': true,
                        'contract': {'revision': brokerRevision},
                      },
                    ),
                  );
                  return;
                }
                ticketRequests += 1;
                handler.resolve(
                  Response<Map<String, dynamic>>(
                    requestOptions: options,
                    statusCode: 201,
                    data: {
                      'ok': true,
                      'wsAuthTicket': 'ticket-after-upgrade',
                    },
                  ),
                );
              },
            ),
          );
          final adapters = <FakeWebSocketAdapter>[];
          final streamUrls = <String>[];
          final upgrading = SessionConnection(
            resolver: EndpointResolver(
              baseUrl: 'https://broker.example.com',
              token: 'rollout-secret',
            ),
            tool: 'codex',
            sessionId: 'upgrade-session',
            dio: dio,
            adapterFactory: (url) {
              streamUrls.add(url);
              final next = FakeWebSocketAdapter();
              adapters.add(next);
              return next;
            },
          );
          addTearDown(upgrading.dispose);

          await upgrading.connect();
          expect(streamUrls, isEmpty);
          expect(ticketRequests, 0);
          expect(upgrading.lastConnectionError, isA<UnsupportedError>());

          brokerRevision = 16;
          await Future<void>.delayed(const Duration(milliseconds: 1200));
          await flush();

          expect(healthRequests, 2);
          expect(ticketRequests, 1);
          final upgradedQuery = Uri.parse(streamUrls.last).queryParameters;
          expect(upgradedQuery, {'wsAuthTicket': 'ticket-after-upgrade'});
          expect(streamUrls.last, isNot(contains('rollout-secret')));
          expect(upgrading.state, SessionConnectionState.connected);
        },
      );

      test(
        'failed ticket reconnect refuses a revision 15 rollback',
        () async {
          final dio = Dio();
          var brokerRevision = 16;
          var healthRequests = 0;
          var ticketRequests = 0;
          dio.interceptors.add(
            InterceptorsWrapper(
              onRequest: (options, handler) {
                if (options.path.endsWith('/api/health')) {
                  healthRequests += 1;
                  handler.resolve(
                    Response<Map<String, dynamic>>(
                      requestOptions: options,
                      statusCode: 200,
                      data: {
                        'ok': true,
                        'contract': {'revision': brokerRevision},
                      },
                    ),
                  );
                  return;
                }
                ticketRequests += 1;
                if (brokerRevision < 16) {
                  handler.reject(
                    DioException(
                      requestOptions: options,
                      response: Response<void>(
                        requestOptions: options,
                        statusCode: 404,
                      ),
                      type: DioExceptionType.badResponse,
                    ),
                  );
                  return;
                }
                handler.resolve(
                  Response<Map<String, dynamic>>(
                    requestOptions: options,
                    statusCode: 201,
                    data: {'wsAuthTicket': 'ticket-before-rollback'},
                  ),
                );
              },
            ),
          );
          final adapters = <FakeWebSocketAdapter>[];
          final streamUrls = <String>[];
          final rollingBack = SessionConnection(
            resolver: EndpointResolver(
              baseUrl: 'https://broker.example.com',
              token: 'rollback-secret',
            ),
            tool: 'codex',
            sessionId: 'rollback-session',
            dio: dio,
            adapterFactory: (url) {
              streamUrls.add(url);
              final next = FakeWebSocketAdapter();
              adapters.add(next);
              return next;
            },
          );
          addTearDown(rollingBack.dispose);

          await rollingBack.connect();
          expect(Uri.parse(streamUrls.single).queryParameters, {
            'wsAuthTicket': 'ticket-before-rollback',
          });

          brokerRevision = 15;
          adapters.single.simulateDisconnect();
          await Future<void>.delayed(const Duration(milliseconds: 3400));
          await flush();

          expect(healthRequests, 2);
          expect(ticketRequests, 2);
          expect(streamUrls, hasLength(1));
          expect(rollingBack.lastConnectionError, isA<UnsupportedError>());
          expect(rollingBack.state, SessionConnectionState.reconnecting);
        },
      );

      test('requests configured artifactMode on stream URL', () async {
        streamUrl = null;
        connection = createConnection(artifactMode: 'inline');
        connection.events.listen(receivedEvents.add);
        connection.stateStream.listen(stateChanges.add);

        await connection.connect();
        await flush();

        expect(streamUrl, isNotNull);
        expect(
          Uri.parse(streamUrl!).queryParameters['artifactMode'],
          'inline',
        );
      });

      test('requests default initialHistory=100 on stream URL', () async {
        streamUrl = null;
        connection = createConnection();
        connection.events.listen(receivedEvents.add);
        connection.stateStream.listen(stateChanges.add);

        await connection.connect();
        await flush();

        expect(streamUrl, isNotNull);
        expect(
          Uri.parse(streamUrl!).queryParameters['initialHistory'],
          '100',
        );
      });

      test('respects custom initialHistory query parameter', () async {
        streamUrl = null;
        connection = createConnection(initialHistory: 50);
        connection.events.listen(receivedEvents.add);
        connection.stateStream.listen(stateChanges.add);

        await connection.connect();
        await flush();

        expect(streamUrl, isNotNull);
        expect(
          Uri.parse(streamUrl!).queryParameters['initialHistory'],
          '50',
        );
      });

      test('is a no-op when already connected', () async {
        await connection.connect();
        await flush();
        stateChanges.clear();

        await connection.connect();
        await flush();
        expect(stateChanges, isEmpty);
      });
    });

    group('WireEvent parsing', () {
      test(
        'emits AttachConflictWireEvent from attach-conflict frame',
        () async {
          await connection.connect();
          await flush();

          adapter.simulateMessage({
            'kind': 'attach-conflict',
            'requestedMode': 'resume',
            'reason': 'app-restore',
            'code': 'DRIVE_OWNERSHIP_CONFLICT',
            'message': 'A terminal owns this session.',
          });
          await flush();

          expect(receivedEvents, hasLength(1));
          final conflict = receivedEvents.first;
          expect(conflict, isA<AttachConflictWireEvent>());
          conflict as AttachConflictWireEvent;
          expect(conflict.requestedMode, 'resume');
          expect(conflict.reason, 'app-restore');
          expect(conflict.code, 'DRIVE_OWNERSHIP_CONFLICT');
          expect(conflict.message, 'A terminal owns this session.');
          // A structured conflict is informational: the socket continues as
          // Observe, so the connection stays connected.
          expect(connection.state, SessionConnectionState.connected);
          expect(connection.mode, isNull);
          expect(connection.reason, isNull);
        },
      );

      test(
        'downgrades create to app-restore after confirmed Driving',
        () async {
          connection = createConnection(mode: 'resume', reason: 'create');
          connection.events.listen(receivedEvents.add);
          await connection.connect();
          adapter.simulateMessage({
            'kind': 'session',
            'info': {
              'id': 'session-1',
              'tool': 'codex',
              'title': 'Test',
              'status': 'idle',
              'attachMode': 'resume',
              'control': {
                'drive': {'supported': true, 'state': 'driving'},
                'terminalSync': {
                  'supported': true,
                  'syncAvailable': true,
                  'active': false,
                },
              },
            },
          });
          await flush();

          expect(connection.mode, 'resume');
          expect(connection.reason, 'app-restore');
        },
      );

      test(
        'downgrades takeover to lease-restore after confirmed Driving',
        () async {
          connection = createConnection(mode: 'resume', reason: 'takeover');
          connection.events.listen(receivedEvents.add);
          await connection.connect();
          adapter.simulateMessage({
            'kind': 'session',
            'info': {
              'id': 'session-1',
              'tool': 'codex',
              'title': 'Test',
              'status': 'idle',
              'attachMode': 'resume',
              'control': {
                'drive': {'supported': true, 'state': 'driving'},
                'terminalSync': {
                  'supported': true,
                  'syncAvailable': true,
                  'active': false,
                },
              },
            },
          });
          await flush();

          expect(connection.reason, 'lease-restore');
        },
      );

      test('emits SessionWireEvent from session frame', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'session',
          'info': {
            'id': 'session-1',
            'tool': 'opencode',
            'title': 'Test',
            'status': 'idle',
            'attachMode': 'live',
          },
        });
        await flush();

        expect(receivedEvents, hasLength(1));
        expect(receivedEvents.first, isA<SessionWireEvent>());
        expect(connection.sessionInfo, isNotNull);
        expect(connection.sessionInfo!.id, 'session-1');
      });

      test(
        'emits HistoryWireEvent with its messages',
        () async {
          await connection.connect();
          await flush();

          adapter.simulateMessage({
            'kind': 'history',
            'messages': [
              {'type': 'user-message', 'id': 'msg-1'},
              {'type': 'model-output', 'id': 'msg-2'},
            ],
            'cursor': 'cursor-abc',
          });
          await flush();

          expect(receivedEvents, hasLength(1));
          expect(receivedEvents.first, isA<HistoryWireEvent>());
          expect(
            (receivedEvents.first as HistoryWireEvent).messages,
            hasLength(2),
          );
          expect(connection.cursor, 'cursor-abc');
        },
      );

      test(
        'unavailable incremental history preserves backward paging',
        () async {
          await connection.connect();
          await flush();

          adapter
            ..simulateMessage({
              'kind': 'history',
              'reset': true,
              'messages': const <Object?>[],
              'cursor': 'tail-cursor',
              'olderCursor': 'older-cursor',
              'hasEarlier': true,
            })
            ..simulateMessage({
              'kind': 'history',
              'reset': false,
              'messages': const <Object?>[],
              'hasEarlier': true,
              'gap': {
                'code': 'HISTORY_PAGE_SOURCE_CHANGED',
                'reason': 'source-changed',
                'message': 'Native history is temporarily unavailable.',
              },
            });
          await flush();

          expect(connection.olderCursor, 'older-cursor');
          expect(connection.hasEarlier, isTrue);
        },
      );

      test('reset history reaches listeners as a replacement', () async {
        await connection.connect();
        await flush();

        adapter
          ..simulateMessage({
            'kind': 'history',
            'messages': [
              {'type': 'user-message', 'id': 'old-message'},
            ],
          })
          ..simulateMessage({
            'kind': 'message',
            'seq': 1,
            'message': {'type': 'model-output', 'id': 'old-live'},
          })
          ..simulateMessage({
            'kind': 'history',
            'reset': true,
            'messages': [
              {'type': 'user-message', 'id': 'replacement'},
            ],
          });
        await flush();

        final reset = receivedEvents.whereType<HistoryWireEvent>().last;
        expect(reset.reset, isTrue);
        expect(reset.messages.map((message) => message.id), ['replacement']);
      });

      test('emits MessageWireEvent', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'message',
          'seq': 5,
          'message': {'type': 'status', 'id': 'msg-5'},
        });
        await flush();

        expect(receivedEvents, hasLength(1));
        final event = receivedEvents.first as MessageWireEvent;
        expect(event.seq, 5);
        expect(event.message.id, 'msg-5');
      });

      test('emits CommandsWireEvent', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'commands',
          'commands': [
            {'name': 'build'},
          ],
        });
        await flush();

        expect(receivedEvents, hasLength(1));
        expect(connection.commands, hasLength(1));
        expect(connection.commands.first.name, 'build');
      });

      test('emits OptionsWireEvent with broker fields', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'options',
          'models': [
            {
              'providerID': 'anthropic',
              'modelID': 'claude-sonnet-4-6',
              'label': 'Claude Sonnet',
            },
          ],
          'agents': [
            {'name': 'build', 'description': 'Builder'},
          ],
          'modes': [
            {
              'value': 'ask-permission',
              'label': 'Ask Permission',
              'category': 'ask-permission',
            },
          ],
        });
        await flush();

        expect(receivedEvents, hasLength(1));
        expect(connection.models, hasLength(1));
        expect(connection.models.first.providerID, 'anthropic');
        expect(connection.models.first.modelID, 'claude-sonnet-4-6');
        expect(connection.agents, hasLength(1));
        expect(connection.agents.first.name, 'build');
        expect(connection.modes, hasLength(1));
        expect(connection.modes!.first.value, 'ask-permission');
      });

      test('emits NoticeWireEvent', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'notice',
          'message': 'Session paused',
        });
        await flush();

        expect(receivedEvents, hasLength(1));
        expect(
          (receivedEvents.first as NoticeWireEvent).message,
          'Session paused',
        );
      });

      test('emits ErrorWireEvent', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'error',
          'message': 'Permission denied',
        });
        await flush();

        expect(receivedEvents, hasLength(1));
        expect(
          (receivedEvents.first as ErrorWireEvent).message,
          'Permission denied',
        );
      });

      test(
        'emits UnknownWireEvent for unrecognized kind',
        () async {
          await connection.connect();
          await flush();

          adapter.simulateMessage({
            'kind': 'future-feature',
            'data': 'value',
          });
          await flush();

          expect(receivedEvents, hasLength(1));
          expect(receivedEvents.first, isA<UnknownWireEvent>());
        },
      );

      test(
        'malformed known frame becomes UnknownWireEvent',
        () async {
          await connection.connect();
          await flush();

          // 'session' kind but missing 'info' — should not crash.
          adapter.simulateMessage({
            'kind': 'session',
            'broken': true,
          });
          await flush();

          expect(receivedEvents, hasLength(1));
          expect(receivedEvents.first, isA<UnknownWireEvent>());
          final unknown = receivedEvents.first as UnknownWireEvent;
          expect(unknown.kind, 'session');
        },
      );
    });

    group('history reset', () {
      test('reset flag reaches listeners unchanged', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'history',
          'messages': [
            {'type': 'user-message', 'id': 'msg-1'},
            {'type': 'model-output', 'id': 'msg-2'},
          ],
        });
        await flush();

        adapter.simulateMessage({
          'kind': 'history',
          'messages': [
            {'type': 'user-message', 'id': 'msg-new'},
          ],
          'reset': true,
        });
        await flush();
        final frames = receivedEvents.whereType<HistoryWireEvent>().toList();
        expect(frames.map((frame) => frame.reset), [false, true]);
        expect(frames.last.messages.single.id, 'msg-new');
      });

      test('non-reset history is forwarded as an increment', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'history',
          'messages': [
            {'type': 'user-message', 'id': 'msg-1'},
          ],
        });
        await flush();

        adapter.simulateMessage({
          'kind': 'history',
          'messages': [
            {'type': 'model-output', 'id': 'msg-2'},
          ],
        });
        await flush();
        final frames = receivedEvents.whereType<HistoryWireEvent>().toList();
        expect(frames.map((frame) => frame.reset), [false, false]);
        expect(
          frames.expand((frame) => frame.messages).map((message) => message.id),
          ['msg-1', 'msg-2'],
        );
      });
    });

    group('transport retention', () {
      // The session view's bounded history window is the only owner of
      // decoded transcript rows. The transport used to keep a second copy
      // that grew with every live frame, every repeated older page and every
      // update to one key, regardless of the window's bounds.
      test('exposes no transcript list and keeps only paging state', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'history',
          'reset': true,
          'cursor': 'reconnect-1',
          'olderCursor': 'older-1',
          'hasEarlier': true,
          'messages': [
            for (var i = 0; i < 100; i++)
              {'type': 'model-output', 'key': 'initial-$i', 'text': 'x'},
          ],
        });
        for (var i = 0; i < 2000; i++) {
          adapter.simulateMessage({
            'kind': 'message',
            'seq': i + 1,
            'message': {'type': 'model-output', 'key': 'live-$i', 'text': 'x'},
          });
        }
        for (var repeat = 0; repeat < 10; repeat++) {
          adapter.simulateMessage({
            'kind': 'history-page',
            'cursor': 'older-2',
            'hasMore': true,
            'endOfHistory': false,
            'messages': [
              for (var i = 0; i < 100; i++)
                {'type': 'model-output', 'key': 'older-$i', 'text': 'x'},
            ],
          });
        }
        for (var i = 0; i < 1000; i++) {
          adapter.simulateMessage({
            'kind': 'message',
            'seq': 2001 + i,
            'message': {'type': 'model-output', 'key': 'same', 'text': '$i'},
          });
        }
        await flush();

        expect(receivedEvents, hasLength(1 + 2000 + 10 + 1000));
        expect(connection.cursor, 'reconnect-1');
        expect(connection.olderCursor, 'older-2');
        expect(connection.hasEarlier, isTrue);
        expect(
          // A regression that restores a transcript getter fails here.
          // ignore: avoid_dynamic_calls
          () => (connection as dynamic).messages,
          throwsNoSuchMethodError,
        );
      });
    });

    group('cursor tracking', () {
      test('updates cursor from history frame', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'history',
          'messages': <dynamic>[],
          'cursor': 'cursor-v1',
        });
        await flush();
        expect(connection.cursor, 'cursor-v1');

        adapter.simulateMessage({
          'kind': 'history',
          'messages': <dynamic>[],
          'cursor': 'cursor-v2',
        });
        await flush();
        expect(connection.cursor, 'cursor-v2');
      });

      test(
        'preserves cursor when history has no cursor',
        () async {
          await connection.connect();
          await flush();

          adapter.simulateMessage({
            'kind': 'history',
            'messages': <dynamic>[],
            'cursor': 'cursor-v1',
          });
          await flush();

          adapter.simulateMessage({
            'kind': 'history',
            'messages': <dynamic>[],
          });
          await flush();
          expect(connection.cursor, 'cursor-v1');
        },
      );

      test('tracks attach ticket and history gap from history frame', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'history',
          'messages': <dynamic>[],
          'cursor': 'cursor-v1',
          'attachTicket': 'ticket-v1',
          'gap': {
            'code': 'HISTORY_CURSOR_GONE',
            'reason': 'cursor-out-of-range',
            'message': 'full replay was sent',
          },
        });
        await flush();

        expect(connection.attachTicket, 'ticket-v1');
        expect(connection.lastHistoryGap?.code, 'HISTORY_CURSOR_GONE');
        expect(connection.lastHistoryGap?.reason, 'cursor-out-of-range');
        expect(connection.lastHistoryGap?.message, 'full replay was sent');
      });
    });

    group('history refresh and newer pages (revision 28)', () {
      Future<void> attach() async {
        await connection.connect();
        await flush();
        adapter.simulateMessage({
          'kind': 'history',
          'reset': true,
          'messages': <dynamic>[],
          'cursor': 'c1',
          'attachTicket': 't1',
          'olderCursor': 'o1',
          'hasEarlier': true,
          'endCursor': 'e1',
          'newerHistory': true,
          'gap': {
            'code': 'HISTORY_CURSOR_GONE',
            'reason': 'cursor-out-of-range',
            'message': 'full replay was sent',
          },
        });
        await flush();
      }

      Map<String, dynamic> lastSent() =>
          jsonDecode(adapter.sentFrames.last) as Map<String, dynamic>;

      test('a refresh answer advances only the reconnect cursor', () async {
        await attach();
        final id = connection.requestHistoryRefresh(cursor: 'c1');
        expect(id, isNotNull);
        expect(lastSent(), {
          'kind': 'history-refresh',
          'cursor': 'c1',
          'clientMessageId': id,
        });
        adapter.simulateMessage({
          'kind': 'history',
          'messages': [
            {'type': 'user-message', 'key': 'u1', 'text': 'persisted'},
          ],
          'cursor': 'c2',
          'endCursor': 'e2',
          'newerHistory': true,
          'clientMessageId': id,
        });
        await flush();
        final refresh = receivedEvents.whereType<HistoryWireEvent>().last;
        expect(refresh.clientMessageId, id);
        expect(connection.cursor, 'c2');
        expect(connection.attachTicket, 't1', reason: 'a refresh is no ticket');
        expect(connection.olderCursor, 'o1');
        expect(connection.hasEarlier, isTrue);
        expect(connection.lastHistoryGap?.code, 'HISTORY_CURSOR_GONE');
      });

      test('a refresh is sent only from the current cursor', () async {
        await attach();
        expect(connection.requestHistoryRefresh(cursor: 'stale'), isNull);
        expect(
          adapter.sentFrames.where((frame) => frame.contains('refresh')),
          isEmpty,
        );
      });

      test('an answer from a cursor since moved past is dropped', () async {
        await attach();
        final id = connection.requestHistoryRefresh(cursor: 'c1');
        // A resync replaced the window before the answer arrived.
        adapter
          ..simulateMessage({
            'kind': 'history',
            'reset': true,
            'messages': <dynamic>[],
            'cursor': 'c9',
            'endCursor': 'e9',
            'newerHistory': true,
          })
          ..simulateMessage({
            'kind': 'history',
            'messages': [
              {'type': 'user-message', 'key': 'u1', 'text': 'stale'},
            ],
            'cursor': 'c2',
            'endCursor': 'e2',
            'clientMessageId': id,
          });
        await flush();
        expect(connection.cursor, 'c9');
        expect(
          receivedEvents.whereType<HistoryWireEvent>().map((e) => e.cursor),
          ['c1', 'c9'],
        );
      });

      test('a reset settles every refresh asked before it, even one whose '
          'cursor it restores', () async {
        await attach();
        final id = connection.requestHistoryRefresh(cursor: 'c1');
        // A replacement that lands back on the same cursor (the refreshed
        // rows were reverted), then the answer read before it.
        adapter
          ..simulateMessage({
            'kind': 'history',
            'reset': true,
            'messages': <dynamic>[],
            'cursor': 'c1',
            'endCursor': 'e1',
            'newerHistory': true,
          })
          ..simulateMessage({
            'kind': 'history',
            'messages': [
              {'type': 'user-message', 'key': 'u1', 'text': 'reverted'},
            ],
            'cursor': 'c2',
            'endCursor': 'e2',
            'clientMessageId': id,
          });
        await flush();
        expect(connection.cursor, 'c1');
        expect(
          receivedEvents.whereType<HistoryWireEvent>().map((e) => e.cursor),
          ['c1', 'c1'],
        );
        // One asked after the reset is answered as usual.
        final next = connection.requestHistoryRefresh(cursor: 'c1');
        adapter.simulateMessage({
          'kind': 'history',
          'messages': <dynamic>[],
          'cursor': 'c3',
          'clientMessageId': next,
        });
        await flush();
        expect(connection.cursor, 'c3');
      });

      test('an unrequested or repeated answer is dropped', () async {
        await attach();
        final id = connection.requestHistoryRefresh(cursor: 'c1');
        for (final answer in ['nobody-asked', id!, id]) {
          adapter.simulateMessage({
            'kind': 'history',
            'messages': <dynamic>[],
            'cursor': answer == 'nobody-asked' ? 'cX' : 'c2',
            'clientMessageId': answer,
          });
        }
        await flush();
        expect(connection.cursor, 'c2');
        expect(
          receivedEvents.whereType<HistoryWireEvent>().map((e) => e.cursor),
          ['c1', 'c2'],
        );
      });

      test(
        'a reconnect forgets requests the old socket can never answer',
        () async {
          await connection.connect();
          await flush();
          adapter.simulateMessage({
            'kind': 'history',
            'messages': <dynamic>[],
            'cursor': 'c1',
          });
          await flush();
          final id = connection.requestHistoryRefresh(cursor: 'c1');
          final oldAdapter = adapter..simulateDisconnect();
          await flush();
          await connection.connect();
          await flush();
          expect(identical(adapter, oldAdapter), isFalse);
          adapter.simulateMessage({
            'kind': 'history',
            'messages': <dynamic>[],
            'cursor': 'c7',
            'clientMessageId': id,
          });
          await flush();
          expect(connection.cursor, 'c1');
        },
      );

      test(
        'an automatic reconnect forgets requests the old socket can never '
        'answer',
        () async {
          await attach();
          final id = connection.requestHistoryRefresh(cursor: 'c1');
          final oldAdapter = adapter..simulateDisconnect();
          await flush();
          // The reconnect timer (1s) opens a new socket by itself.
          await Future<void>.delayed(const Duration(milliseconds: 1200));
          await flush();
          expect(identical(adapter, oldAdapter), isFalse);
          expect(adapter.isConnected, isTrue);
          adapter.simulateMessage({
            'kind': 'history',
            'messages': <dynamic>[],
            'cursor': 'c7',
            'clientMessageId': id,
          });
          await flush();
          expect(connection.cursor, 'c1');
        },
      );

      test('a reset carrying a refresh id is no refresh answer', () async {
        await attach();
        final id = connection.requestHistoryRefresh(cursor: 'c1');
        adapter.simulateMessage({
          'kind': 'history',
          'reset': true,
          'messages': <dynamic>[],
          'cursor': 'c2',
          'clientMessageId': id,
        });
        await flush();
        expect(connection.cursor, 'c1');
        expect(receivedEvents.whereType<HistoryWireEvent>(), hasLength(1));
      });

      test('a nack settles the request it answers', () async {
        await attach();
        final id = connection.requestHistoryRefresh(cursor: 'c1');
        adapter
          ..simulateMessage({
            'kind': 'nack',
            'code': 'HISTORY_PAGE_SOURCE_CHANGED',
            'message': 'try again',
            'clientMessageId': id,
          })
          ..simulateMessage({
            'kind': 'history',
            'messages': <dynamic>[],
            'cursor': 'c2',
            'clientMessageId': id,
          });
        await flush();
        expect(connection.cursor, 'c1');
        expect(receivedEvents.whereType<NackWireEvent>(), hasLength(1));
        expect(receivedEvents.whereType<HistoryWireEvent>(), hasLength(1));
      });

      test('no refresh is sent on a socket that is not open', () async {
        final closing = _ClosingWebSocketAdapter();
        connection = SessionConnection(
          resolver: EndpointResolver(baseUrl: 'http://127.0.0.1:7734'),
          tool: 'opencode',
          sessionId: 'session-1',
          adapterFactory: (_) => closing,
        );
        await connection.connect();
        await flush();
        closing.simulateMessage({
          'kind': 'history',
          'messages': <dynamic>[],
          'cursor': 'c1',
        });
        await flush();
        closing.open = false;
        expect(connection.requestHistoryRefresh(cursor: 'c1'), isNull);
        closing.open = true;
        expect(connection.requestHistoryRefresh(cursor: 'c1'), isNotNull);
      });

      test('a newer page never moves the older boundary', () async {
        await attach();
        final id = connection.requestNewerHistoryPage(
          cursor: 'o1',
          until: 'e1',
          limit: 50,
        );
        expect(lastSent(), {
          'kind': 'history-page',
          'cursor': 'o1',
          'limit': 50,
          'direction': 'newer',
          'until': 'e1',
          'clientMessageId': id,
        });
        adapter.simulateMessage({
          'kind': 'history-page',
          'messages': <dynamic>[],
          'cursor': 'e1',
          'hasMore': false,
          'endOfHistory': true,
          'direction': 'newer',
          'clientMessageId': id,
        });
        await flush();
        expect(connection.olderCursor, 'o1');
        expect(connection.hasEarlier, isTrue);
        final page = receivedEvents.whereType<HistoryPageWireEvent>().single;
        expect(page.isNewer, isTrue);
      });
    });

    group('seq: 0 replay frames', () {
      test('tolerates seq: 0 message frames', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'message',
          'seq': 0,
          'message': {
            'type': 'agent-activity',
            'id': 'replay-1',
          },
        });
        await flush();

        expect(receivedEvents, hasLength(1));
        final event = receivedEvents.first as MessageWireEvent;
        expect(event.seq, 0);
        expect(event.message.id, 'replay-1');
      });
    });

    group('ended frame', () {
      test('transitions to closed on ended frame', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'ended',
          'reason': 'user-disconnect',
        });
        await flush();

        expect(connection.state, SessionConnectionState.closed);
        expect(
          stateChanges,
          contains(SessionConnectionState.closed),
        );
      });
    });

    group('outbound messages', () {
      test('sendPrompt sends text key', () async {
        await connection.connect();
        await flush();
        final clientMessageId = connection.sendPrompt('hello');

        expect(adapter.sentFrames, hasLength(1));
        final frame =
            jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
        expect(frame['kind'], 'prompt');
        expect(frame['text'], 'hello');
        expect(frame.containsKey('content'), isFalse);
        expect(frame['clientMessageId'], clientMessageId);
        expect(clientMessageId, matches(RegExp(r'^[A-Za-z0-9._:-]{1,160}$')));
      });

      test('sendPrompt forwards model and reasoning override', () async {
        await connection.connect();
        await flush();
        connection.sendPrompt(
          'hello',
          model: const SessionCurrentModel(
            providerID: 'openai',
            modelID: 'gpt-5.4',
            reasoningEffort: 'high',
          ),
        );

        final frame =
            jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
        expect(frame['model'], containsPair('modelID', 'gpt-5.4'));
        expect(frame['model'], containsPair('reasoningEffort', 'high'));
      });

      test('sendPrompt forwards the exact selected permission mode', () async {
        await connection.connect();
        await flush();
        connection.sendPrompt('hello', permissionMode: 'auto');

        final frame =
            jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
        // The exact advertised token, unrewritten: the broker validates it
        // against what the adapter published and rejects anything else.
        expect(frame['permissionMode'], 'auto');
      });

      test('sendPrompt omits the mode when none was selected', () async {
        await connection.connect();
        await flush();
        connection
          ..sendPrompt('hello')
          ..sendPrompt('hello again', permissionMode: '');

        for (final sent in adapter.sentFrames) {
          final frame = jsonDecode(sent) as Map<String, dynamic>;
          // Absent, not empty. Omitting it leaves the session in the mode it
          // already holds; an empty token would be rejected as unadvertised
          // and cost the user the whole prompt.
          expect(frame.containsKey('permissionMode'), isFalse);
        }
      });

      test('sendPrompt forwards ordered inline and staged files', () async {
        await connection.connect();
        await flush();
        connection.sendPrompt(
          'inspect',
          clientMessageId: 'cm-files',
          files: const [
            PromptFileAttachment.inline(
              name: 'small.txt',
              mimeType: 'text/plain',
              size: 1,
              data: 'eA==',
            ),
            PromptFileAttachment.staged(
              name: 'large.bin',
              mimeType: 'application/octet-stream',
              size: 300000,
              stagedRef: 'stg1.opaque',
            ),
          ],
        );

        final frame =
            jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
        expect(frame['clientMessageId'], 'cm-files');
        expect(frame['files'], hasLength(2));
        expect(
          (frame['files'] as List).first,
          containsPair('data', 'eA=='),
        );
        expect(
          (frame['files'] as List).last,
          containsPair('stagedRef', 'stg1.opaque'),
        );
      });

      test(
        'sendDraft sends ephemeral shared text without idempotency id',
        () async {
          await connection.connect();
          await flush();
          connection.sendDraft('phone draft');

          final frame =
              jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
          expect(frame, {'kind': 'draft', 'text': 'phone draft'});
          expect(frame.containsKey('clientMessageId'), isFalse);
        },
      );

      test(
        'sendDraft forwards version tokens for a revision-3 broker',
        () async {
          await connection.connect();
          await flush();
          connection.sendDraft(
            'phone draft',
            updateId: 'u-9',
            baseRevision: 4,
          );

          final frame =
              jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
          expect(frame, {
            'kind': 'draft',
            'text': 'phone draft',
            'updateId': 'u-9',
            'baseRevision': 4,
          });
        },
      );

      test('sends plan and artifact interactions with stable ids', () async {
        await connection.connect();
        await flush();

        final planId = connection.sendPlanAction(
          const PlanActionRequest(
            action: PlanActionKind.approve,
            planKey: 'tasks:main',
            planRevision: 'revision-7',
            title: 'Plan',
          ),
          clientMessageId: 'cm.plan-1',
        );
        final artifactId = connection.sendArtifactInteraction(
          const ArtifactInteractionRequest(
            artifactKey: 'artifact-1',
            interaction: {'type': 'click', 'action': 'approve'},
          ),
          clientMessageId: 'cm.artifact-1',
        );

        final frames = adapter.sentFrames
            .map((value) => jsonDecode(value) as Map<String, dynamic>)
            .toList(growable: false);
        expect(planId, 'cm.plan-1');
        expect(frames[0]['kind'], 'plan-action');
        expect(frames[0]['action'], 'approve');
        expect(artifactId, 'cm.artifact-1');
        expect(frames[1]['kind'], 'artifact-interaction');
        expect(frames[1]['artifactKey'], 'artifact-1');
      });

      test('sends explicit attach-ticket ack and nack receipts', () async {
        await connection.connect();
        await flush();

        connection
          ..sendAck('ticket-1')
          ..sendNack('ticket-2', clientMessageId: 'cm.receipt-1');

        final frames = adapter.sentFrames
            .map((value) => jsonDecode(value) as Map<String, dynamic>)
            .toList(growable: false);
        expect(frames[0], {'kind': 'ack', 'attachTicket': 'ticket-1'});
        expect(frames[1], {
          'kind': 'nack',
          'attachTicket': 'ticket-2',
          'clientMessageId': 'cm.receipt-1',
        });
      });

      test('sendCommand sends correct frame', () async {
        await connection.connect();
        await flush();
        final clientMessageId = connection.sendCommand('build');

        final frame =
            jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
        expect(frame['kind'], 'command');
        expect(frame['name'], 'build');
        expect(frame['clientMessageId'], clientMessageId);
      });

      test('sendCommand forwards model override', () async {
        await connection.connect();
        await flush();
        connection.sendCommand(
          'review',
          model: const SessionCurrentModel(
            providerID: 'anthropic',
            modelID: 'claude-opus-4-6',
            reasoningEffort: 'max',
          ),
        );

        final frame =
            jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
        expect(frame['model'], containsPair('modelID', 'claude-opus-4-6'));
      });

      test('sendApprove sends correct frame', () async {
        await connection.connect();
        await flush();
        final clientMessageId = connection.sendApprove('req-1', 'approve');

        final frame =
            jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
        expect(frame['kind'], 'approve');
        expect(frame['requestId'], 'req-1');
        expect(frame['decision'], 'approve');
        expect(frame['clientMessageId'], clientMessageId);
      });

      test('sendAnswer sends string[][]', () async {
        await connection.connect();
        await flush();
        final clientMessageId = connection.sendAnswer('req-2', [
          ['yes'],
          ['option-a', 'option-b'],
        ]);

        final frame =
            jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
        expect(frame['kind'], 'answer');
        expect(frame['requestId'], 'req-2');
        expect(frame['answers'], [
          ['yes'],
          ['option-a', 'option-b'],
        ]);
        expect(frame['clientMessageId'], clientMessageId);
      });

      test('sendRejectQuestion sends correct frame', () async {
        await connection.connect();
        await flush();
        final clientMessageId = connection.sendRejectQuestion('req-3');

        final frame =
            jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
        expect(frame['kind'], 'reject-question');
        expect(frame['requestId'], 'req-3');
        expect(frame['clientMessageId'], clientMessageId);
      });

      test('sendFile sends data key', () async {
        await connection.connect();
        await flush();
        final clientMessageId = connection.sendFile(
          name: 'readme.md',
          data: '# Hello',
          mimeType: 'text/markdown',
        );

        final frame =
            jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
        expect(frame['kind'], 'file');
        expect(frame['name'], 'readme.md');
        expect(frame['data'], '# Hello');
        expect(frame.containsKey('content'), isFalse);
        expect(frame['mimeType'], 'text/markdown');
        expect(frame['clientMessageId'], clientMessageId);
      });

      test('sendHandoff sends an idempotent control frame', () async {
        await connection.connect();
        connection.sendHandoff(clientMessageId: 'cm-handoff');

        expect(jsonDecode(adapter.sentFrames.last), {
          'kind': 'handoff',
          'clientMessageId': 'cm-handoff',
        });
      });

      test('explicit clientMessageId is reused for retry frames', () async {
        await connection.connect();
        await flush();

        final clientMessageId = connection.sendPrompt(
          'retry me',
          clientMessageId: 'cm.retry-1',
        );

        final frame =
            jsonDecode(adapter.sentFrames.first) as Map<String, dynamic>;
        expect(clientMessageId, 'cm.retry-1');
        expect(frame['clientMessageId'], 'cm.retry-1');
      });

      test(
        'invalid explicit clientMessageId is rejected before send',
        () async {
          await connection.connect();
          await flush();

          expect(
            () => connection.sendPrompt('bad', clientMessageId: 'bad id'),
            throwsA(isA<ArgumentError>()),
          );
          expect(adapter.sentFrames, isEmpty);
        },
      );

      test(
        'outbound frames are dropped when not connected',
        () async {
          expect(
            () => connection.sendPrompt('hello'),
            returnsNormally,
          );
          expect(
            () => connection.sendCommand('build'),
            returnsNormally,
          );
          expect(
            () => connection.sendApprove('r', 'approve'),
            returnsNormally,
          );
        },
      );
    });

    group('read-only declaration', () {
      // The declaration must survive the transport, not just the first attach.
      // An automatic reconnect that silently dropped it would hand the socket
      // back full authority at exactly the moment nobody is watching — and
      // unlike `mode`/`reason`, there is no refusal frame that would reveal it.
      test('rides every reconnect, not only the first attach', () async {
        final connection = createConnection(readOnly: true);
        await connection.connect();
        await flush();
        expect(streamUrl, contains('readOnly=1'));

        streamUrl = '';
        adapter.simulateDisconnect();
        await flush();
        await Future<void>.delayed(const Duration(milliseconds: 1200));
        await flush();

        expect(
          streamUrl,
          contains('readOnly=1'),
          reason: 'the automatic reconnect must keep declaring it',
        );
        await connection.dispose();
      });

      test('is monotone — a later reattach cannot clear it', () async {
        final connection = createConnection(readOnly: true);
        await connection.connect();
        await flush();

        await connection.reattach();
        await flush();
        expect(
          streamUrl,
          contains('readOnly=1'),
          reason: 'a re-attach that asks for nothing must not grant anything',
        );
        expect(connection.readOnly, isTrue);
        await connection.dispose();
      });

      test('is absent unless asked for', () async {
        final connection = createConnection();
        await connection.connect();
        await flush();
        expect(streamUrl, isNot(contains('readOnly')));
        await connection.dispose();
      });
    });

    group('generation suppression', () {
      test(
        'reconnect creates new adapter and processes events',
        () async {
          await connection.connect();
          await flush();

          adapter.simulateMessage({
            'kind': 'notice',
            'message': 'before',
          });
          await flush();
          expect(receivedEvents, hasLength(1));

          // Disconnect triggers reconnect. The reconnect timer
          // (1s) will fire, bump generation, and create a new
          // adapter.
          adapter.simulateDisconnect();
          await flush();

          // Wait for the reconnect timer to fire.
          await Future<void>.delayed(
            const Duration(milliseconds: 1200),
          );
          await flush();

          // New adapter should be active.
          expect(adapter.isConnected, isTrue);
          expect(
            connection.state,
            SessionConnectionState.connected,
          );

          // Events on the new adapter are processed.
          adapter.simulateMessage({
            'kind': 'notice',
            'message': 'after',
          });
          await flush();

          final notices = receivedEvents.whereType<NoticeWireEvent>().toList();
          expect(notices, hasLength(2));
          expect(notices[0].message, 'before');
          expect(notices[1].message, 'after');
        },
      );

      test(
        'manual connect during reconnect cancels old timer',
        () async {
          await connection.connect();
          await flush();

          // Disconnect — reconnect timer scheduled (1s).
          adapter.simulateDisconnect();
          await flush();
          expect(
            connection.state,
            SessionConnectionState.reconnecting,
          );

          // Immediately call connect() again. This should
          // cancel the pending reconnect timer and create a
          // fresh connection with a new generation.
          await connection.connect();
          await flush();
          expect(
            connection.state,
            SessionConnectionState.connected,
          );

          // Only the new adapter should be active.
          adapter.simulateMessage({
            'kind': 'notice',
            'message': 'manual',
          });
          await flush();

          final notices = receivedEvents.whereType<NoticeWireEvent>().toList();
          expect(notices, hasLength(1));
          expect(notices[0].message, 'manual');

          // Wait past the old reconnect timer delay. If the
          // timer was not cancelled, it would fire and create
          // a third adapter, overwriting ours. Verify state
          // is still connected (not stuck in reconnecting).
          await Future<void>.delayed(
            const Duration(milliseconds: 1200),
          );
          await flush();
          expect(
            connection.state,
            SessionConnectionState.connected,
          );
        },
      );

      test(
        'WireEvent.fromJson tolerates malformed known frames',
        () async {
          final event = WireEvent.fromJson({
            'kind': 'session',
            'broken': true,
          });
          expect(event, isA<UnknownWireEvent>());
          expect((event as UnknownWireEvent).kind, 'session');
        },
      );
    });

    group('reconnect', () {
      test('attempts reconnect on disconnect', () async {
        await connection.connect();
        await flush();
        expect(connection.state, SessionConnectionState.connected);

        adapter.simulateDisconnect();
        await flush();

        expect(
          stateChanges,
          contains(SessionConnectionState.reconnecting),
        );
      });

      test('does not reconnect after ended frame', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({'kind': 'ended'});
        await flush();

        expect(connection.state, SessionConnectionState.closed);
      });

      test(
        'a restart does not carry the last attach failure into the new attach',
        () async {
          await connection.connect();
          await flush();
          adapter
            ..simulateMessage({
              'kind': 'hello',
              'brokerContract': {'revision': 20, 'surfaceHash': 'fixture'},
              'clientContract': {'revision': 20, 'surfaceHash': 'fixture'},
              'compatibility': {
                'status': 'exact',
                'readOnly': false,
                'brokerRevision': 20,
                'clientRevision': 20,
              },
            })
            ..simulateMessage({
              'kind': 'error',
              'message': 'attach failed: native session refused',
            })
            ..simulateDisconnect();
          await flush();
          expect(connection.lastConnectionError, isNotNull);

          final seen = <Object?>[];
          final subscription = connection.stateStream.listen(
            (_) => seen.add(connection.lastConnectionError),
          );
          await connection.restartAttach();
          await flush();
          await subscription.cancel();
          expect(seen, isNotEmpty);
          expect(seen.first, isNull);
        },
      );

      test(
        'pre-bootstrap broker error closes once and preserves the attach cause',
        () async {
          await connection.connect();
          await flush();

          adapter
            ..simulateMessage({
              'kind': 'hello',
              'brokerContract': {'revision': 20, 'surfaceHash': 'fixture'},
              'clientContract': {'revision': 20, 'surfaceHash': 'fixture'},
              'compatibility': {
                'status': 'exact',
                'readOnly': false,
                'brokerRevision': 20,
                'clientRevision': 20,
              },
            })
            ..simulateMessage({
              'kind': 'error',
              'message': 'attach failed: native session refused',
            })
            ..simulateDisconnect();
          await flush();

          expect(connection.state, SessionConnectionState.closed);
          expect(
            connection.lastConnectionError,
            isA<BrokerException>().having(
              (error) => error.message,
              'message',
              'attach failed: native session refused',
            ),
          );
          await Future<void>.delayed(const Duration(milliseconds: 1200));
          expect(connection.state, SessionConnectionState.closed);
        },
      );

      test(
        'does not overwrite synchronous ended during reconnect',
        () async {
          final initialAdapter = FakeWebSocketAdapter();
          final endedAdapter = _ImmediateEndedWebSocketAdapter();
          var attempts = 0;
          connection = SessionConnection(
            resolver: EndpointResolver(baseUrl: 'http://127.0.0.1:7734'),
            tool: 'opencode',
            sessionId: 'session-1',
            adapterFactory: (_) {
              attempts += 1;
              return attempts == 1 ? initialAdapter : endedAdapter;
            },
          );
          connection.events.listen(receivedEvents.add);

          await connection.connect();
          initialAdapter.simulateDisconnect();
          await Future<void>.delayed(const Duration(milliseconds: 1200));
          await flush();

          expect(attempts, 2);
          expect(receivedEvents.whereType<EndedWireEvent>(), hasLength(1));
          expect(connection.state, SessionConnectionState.closed);
          expect(endedAdapter.isConnected, isFalse);
        },
      );

      test('reattaches with ticket query from last history cursor', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage({
          'kind': 'history',
          'messages': <dynamic>[],
          'cursor': 'cursor-v1',
        });
        await flush();

        adapter.simulateDisconnect();
        await flush();
        await Future<void>.delayed(const Duration(milliseconds: 1200));
        await flush();

        expect(streamUrl, isNotNull);
        final query = Uri.parse(streamUrl!).queryParameters;
        expect(query['ticket'], 'cursor-v1');
        expect(query.containsKey('since'), isFalse);
      });
    });

    group('reattach', () {
      test('re-attaches under resume mode (Take over)', () async {
        await connection.connect();
        await flush();
        expect(
          Uri.parse(streamUrl!).queryParameters.containsKey('mode'),
          isFalse,
        );

        await connection.reattach(mode: 'resume');
        await flush();

        expect(connection.state, SessionConnectionState.connected);
        expect(Uri.parse(streamUrl!).queryParameters['mode'], 'resume');
        expect(connection.mode, 'resume');
      });

      test('re-attaches back to Observe (hand back) with no mode', () async {
        await connection.reattach(mode: 'resume');
        await flush();
        expect(Uri.parse(streamUrl!).queryParameters['mode'], 'resume');

        await connection.reattach();
        await flush();
        expect(
          Uri.parse(streamUrl!).queryParameters.containsKey('mode'),
          isFalse,
        );
        expect(connection.mode, isNull);
      });

      test('drop-triggered reconnect preserves resume mode', () async {
        await connection.reattach(mode: 'resume');
        await flush();

        adapter.simulateDisconnect();
        await flush();
        await Future<void>.delayed(const Duration(milliseconds: 1200));
        await flush();

        expect(connection.state, SessionConnectionState.connected);
        expect(Uri.parse(streamUrl!).queryParameters['mode'], 'resume');
      });

      test(
        'carries the drive-attach reason and clears it on Observe',
        () async {
          await connection.reattach(mode: 'resume', reason: 'app-restore');
          await flush();

          var query = Uri.parse(streamUrl!).queryParameters;
          expect(query['mode'], 'resume');
          expect(query['reason'], 'app-restore');
          expect(connection.reason, 'app-restore');

          // Hand back to Observe: both mode and reason must drop, so a bare
          // attach can never accidentally re-claim Drive.
          await connection.reattach();
          await flush();
          query = Uri.parse(streamUrl!).queryParameters;
          expect(query.containsKey('mode'), isFalse);
          expect(query.containsKey('reason'), isFalse);
          expect(connection.reason, isNull);
        },
      );

      test(
        'join-existing carries and then clears the exact owner revision',
        () async {
          const revision = SessionOwnerRevision(epoch: 'broker-epoch', seq: 14);
          await connection.reattach(
            mode: 'resume',
            reason: 'join-existing',
            ownerRevision: revision,
          );
          await flush();

          var query = Uri.parse(streamUrl!).queryParameters;
          expect(query['reason'], 'join-existing');
          expect(query['ownerEpoch'], 'broker-epoch');
          expect(query['ownerSeq'], '14');
          expect(connection.ownerRevision?.seq, 14);

          connection.disarmDriveAuthority();
          expect(connection.ownerRevision, isNull);
          await connection.reattach();
          await flush();
          query = Uri.parse(streamUrl!).queryParameters;
          expect(query.containsKey('ownerEpoch'), isFalse);
          expect(query.containsKey('ownerSeq'), isFalse);
        },
      );

      test(
        'a restart attaches again as it was, from the last history cursor',
        () async {
          await connection.reattach(mode: 'resume', reason: 'lease-restore');
          await flush();
          adapter.simulateMessage({
            'kind': 'history',
            'messages': <dynamic>[],
            'cursor': 'cursor-v2',
          });
          await flush();

          await connection.restartAttach();
          await flush();

          expect(connection.state, SessionConnectionState.connected);
          final query = Uri.parse(streamUrl!).queryParameters;
          expect(query['mode'], 'resume');
          expect(query['reason'], 'lease-restore');
          expect(query['ticket'], 'cursor-v2');
          expect(connection.mode, 'resume');
        },
      );

      test(
        'drop-triggered reconnect preserves the drive-attach reason',
        () async {
          await connection.reattach(mode: 'resume', reason: 'lease-restore');
          await flush();

          adapter.simulateDisconnect();
          await flush();
          await Future<void>.delayed(const Duration(milliseconds: 1200));
          await flush();

          expect(connection.state, SessionConnectionState.connected);
          final query = Uri.parse(streamUrl!).queryParameters;
          expect(query['mode'], 'resume');
          expect(query['reason'], 'lease-restore');
        },
      );

      test(
        'drop-triggered join reconnect preserves the exact owner revision',
        () async {
          const revision = SessionOwnerRevision(
            epoch: 'join-reconnect-epoch',
            seq: 27,
          );
          await connection.reattach(
            mode: 'resume',
            reason: 'join-existing',
            ownerRevision: revision,
          );
          await flush();

          adapter.simulateDisconnect();
          await flush();
          await Future<void>.delayed(const Duration(milliseconds: 1200));
          await flush();

          expect(connection.state, SessionConnectionState.connected);
          final query = Uri.parse(streamUrl!).queryParameters;
          expect(query['mode'], 'resume');
          expect(query['reason'], 'join-existing');
          expect(query['ownerEpoch'], 'join-reconnect-epoch');
          expect(query['ownerSeq'], '27');
        },
      );

      test(
        'ordinary frames never disarm the drive-attach mode and reason',
        () async {
          await connection.reattach(mode: 'resume', reason: 'app-restore');
          await flush();

          // Every non-arbitration frame the broker can interleave mid-stream:
          // none of them answers the attach-authority request, so none may
          // demote the next reconnect to Observe.
          adapter
            ..simulateMessage({'kind': 'notice', 'message': 'heads up'})
            ..simulateMessage({'kind': 'error', 'message': 'transient'})
            ..simulateMessage({'kind': 'draft', 'text': 'wip', 'at': 1})
            ..simulateMessage({
              'kind': 'ack',
              'ack': 'client-message',
              'clientMessageId': 'm1',
            })
            ..simulateMessage({
              'kind': 'nack',
              'code': 'BAD_PARAM',
              'message': 'rejected',
              'clientMessageId': 'm2',
            })
            ..simulateMessage({'kind': 'future-frame'});
          await flush();

          expect(connection.mode, 'resume');
          expect(connection.reason, 'app-restore');

          adapter.simulateDisconnect();
          await flush();
          await Future<void>.delayed(const Duration(milliseconds: 1200));
          await flush();

          final query = Uri.parse(streamUrl!).queryParameters;
          expect(query['mode'], 'resume');
          expect(query['reason'], 'app-restore');
        },
      );

      test(
        'attach-conflict disarms the authority request before reconnect',
        () async {
          await connection.reattach(
            mode: 'resume',
            reason: 'join-existing',
            ownerRevision: const SessionOwnerRevision(
              epoch: 'owner-before-conflict',
              seq: 9,
            ),
          );
          await flush();

          adapter.simulateMessage({
            'kind': 'attach-conflict',
            'requestedMode': 'resume',
            'reason': 'join-existing',
            'code': 'JOIN_OWNER_STALE',
            'message': 'The owner changed.',
          });
          await flush();

          expect(connection.ownerRevision, isNull);

          adapter.simulateDisconnect();
          await flush();
          await Future<void>.delayed(const Duration(milliseconds: 1200));
          await flush();

          // The denied one-shot authority request must not silently retry.
          final query = Uri.parse(streamUrl!).queryParameters;
          expect(query.containsKey('mode'), isFalse);
          expect(query.containsKey('reason'), isFalse);
        },
      );

      test('close invalidates an in-flight connect continuation', () async {
        final delayedAdapter = _DelayedConnectAdapter();
        final racingConnection = SessionConnection(
          resolver: EndpointResolver(
            baseUrl: 'http://127.0.0.1:7734',
          ),
          tool: 'claude',
          sessionId: 'race-session',
          adapterFactory: (_) => delayedAdapter,
        );
        addTearDown(racingConnection.dispose);
        final racingStates = <SessionConnectionState>[];
        racingConnection.stateStream.listen(racingStates.add);

        final connectFuture = racingConnection.connect();
        await flush();
        await racingConnection.close();
        delayedAdapter.completeConnect();
        await connectFuture;
        await flush();

        expect(racingConnection.state, SessionConnectionState.closed);
        expect(racingStates, isNot(contains(SessionConnectionState.connected)));
      });
    });

    group('dispose', () {
      test('closes streams and sets state to closed', () async {
        await connection.connect();
        await flush();
        await connection.dispose();
        await flush();
        expect(connection.state, SessionConnectionState.closed);
      });
    });

    group('malformed frames', () {
      test('ignores non-JSON messages', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage('not json at all');
        await flush();

        expect(receivedEvents, isEmpty);
      });

      test('ignores null messages', () async {
        await connection.connect();
        await flush();

        adapter.simulateMessage(null);
        await flush();

        expect(receivedEvents, isEmpty);
      });
    });
  });
}

class _DelayedConnectAdapter implements WebSocketAdapter {
  final _messages = StreamController<Object?>.broadcast();
  final _connectCompleter = Completer<void>();
  bool _connected = false;
  bool _closed = false;

  @override
  bool get isConnected => _connected;

  void completeConnect() => _connectCompleter.complete();

  @override
  Future<void> connect() async {
    await _connectCompleter.future;
    if (!_closed) {
      _connected = true;
    }
  }

  @override
  Stream<Object?> get messages => _messages.stream;

  @override
  void send(String data) {
    if (!_connected) {
      throw StateError('WebSocket not connected');
    }
  }

  @override
  void sendJson(Object data) => send(jsonEncode(data));

  @override
  Future<void> close() async {
    _closed = true;
    _connected = false;
  }
}
