import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:broker_client/broker_client.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_http_transport.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_route_context.dart';
import 'package:cosyncing_client/src/platform/connection/broker_route_transport.dart'
    as platform;
import 'package:dio/dio.dart';

final _resolverRoutes = Expando<BrokerRouteTransport>('broker route context');

/// Associates session/transfer factories with their REST client's exact path.
void bindResolverRoute(EndpointResolver resolver, BrokerRouteTransport route) =>
    _resolverRoutes[resolver] = route;

/// No source ownership is inferred from an endpoint URL.
BrokerRouteTransport? resolverRoute(EndpointResolver resolver) =>
    _resolverRoutes[resolver];

final _pinnedClientsKey = Object();

/// Resolves the client retained by this transfer's asynchronous scope only.
/// Concurrent transfers and unrelated session traffic cannot borrow its pool.
BrokerClient brokerRouteOperationClient(BrokerClient client) =>
    (Zone.current[_pinnedClientsKey]
        as Map<BrokerClient, BrokerClient>?)?[client] ??
    client;

/// Keeps a multi-request transfer on its captured route across a healthy
/// handoff. A sign-out, route/proxy edit, or hard failure still closes the
/// pool.
Future<T> withPinnedBrokerRoute<T>(
  BrokerClient? client,
  Future<T> Function() action,
) async {
  final route = client == null ? null : resolverRoute(client.resolver);
  if (client == null || route == null) return action();
  final resolver = client.resolver;
  final pinned = BrokerClient(
    baseUrl: resolver.baseUrl,
    token: resolver.token,
    peerToken: resolver.peerToken,
    clientProfileId: resolver.clientProfileId,
    clientProfileIncarnation: resolver.clientProfileIncarnation,
    dio: route.dio(pinned: true),
  );
  bindResolverRoute(pinned.resolver, route);
  try {
    return await runZoned(
      action,
      zoneValues: {
        _pinnedClientsKey: <BrokerClient, BrokerClient>{
          ...?Zone.current[_pinnedClientsKey]
              as Map<BrokerClient, BrokerClient>?,
          client: pinned,
        },
      },
    );
  } finally {
    pinned.close();
  }
}

/// Owns the pools and callbacks of one immutable connection generation.
final class BrokerRouteTransport {
  /// Owns pools for exactly one immutable connection context.
  BrokerRouteTransport(
    this.context, {
    this.httpOverride,
    this.socketOverride,
    this.onSessionCount,
    this.onTransportFailure,
    this.onAuthorizationRefused,
  });

  /// Exact immutable destination, network, proxy and credential generation.
  final BrokerRouteContext context;

  /// Optional platform transport seam used by app-level wire fixtures.
  final BrokerHttpTransport? httpOverride;

  /// Optional WebSocket seam used by app-level wire fixtures.
  final WebSocketAdapter Function(String)? socketOverride;

  /// Optional observer of physical session sockets entering/leaving the pool.
  final void Function(int)? onSessionCount;

  /// Reports an abnormal session transport loss for coordinated recovery.
  final void Function()? onTransportFailure;

  /// Invalidates the access binding after an authenticated 401.
  final void Function()? onAuthorizationRefused;
  final Set<_OwnedHttpAdapter> _clients = {};
  final Set<_OwnedWebSocket> _sockets = {};
  final Set<void Function()> _retainedResources = {};
  var _retired = false;
  var _forceRetired = false;
  void Function()? _onDrained;
  var _mutations = 0;
  Completer<void>? _idle;
  Dio? _probeClient;
  Completer<void>? _dispatchPaused;

  /// Holds new mutations while the coordinator drains receipts and commits.
  /// A rollback releases them on this path; retirement closes ordinary clients.
  void Function() pauseMutations() {
    final gate = _dispatchPaused ??= Completer<void>();
    return () {
      if (identical(_dispatchPaused, gate)) _dispatchPaused = null;
      if (!gate.isCompleted) gate.complete();
    };
  }

  /// Whether new ordinary work has been fenced for this context.
  bool get retired => _retired;

  /// Whether dispatched mutations still await a response or receipt.
  bool get hasOutstandingMutations => _mutations != 0;

  /// Completes when every mutation dispatched before the handoff has settled.
  Future<void> get mutationsSettled =>
      _mutations == 0 ? Future.value() : (_idle ??= Completer<void>()).future;

  void _mutationDelta(int delta) {
    _mutations += delta;
    if (_mutations == 0) {
      _idle?.complete();
      _idle = null;
    }
  }

  /// Creates a scoped REST client; pinned transfers retain this generation.
  Dio dio({void Function()? onUnauthorized, bool pinned = false}) {
    if (_retired) throw const BrokerRouteException('CONNECTION_RETIRED');
    late final _OwnedHttpAdapter adapter;
    void Function()? release;
    var closed = false;
    bool usable() => !closed && (!_retired || (pinned && !_forceRetired));
    adapter = _OwnedHttpAdapter(
      () => httpOverride?.call() ?? platform.routeHttpAdapter(context),
      () {
        closed = true;
        _clients.remove(adapter);
        release?.call();
        release = null;
      },
    );
    final client = Dio(BaseOptions(followRedirects: false))
      ..httpClientAdapter = adapter;
    if (pinned) {
      release = retainResource(() => adapter.close(force: true));
    } else {
      _clients.add(adapter);
    }
    const mutationKey = 'cosyncing.route.mutation';
    void finish(RequestOptions request) {
      if (request.extra.remove(mutationKey) != true) return;
      _mutationDelta(-1);
    }

    client.interceptors.add(
      InterceptorsWrapper(
        onRequest: (request, handler) async {
          try {
            if (!['GET', 'HEAD', 'OPTIONS'].contains(request.method)) {
              await _dispatchPaused?.future;
            }
            if (!usable()) {
              throw const BrokerRouteException('CONNECTION_RETIRED');
            }
            context.requireDestination(request.uri);
            // Request-local options cannot enable credential-bearing redirects.
            request.followRedirects = false;
            if (!['GET', 'HEAD', 'OPTIONS'].contains(request.method)) {
              request.extra[mutationKey] = true;
              _mutations++;
            }
            handler.next(request);
          } on Object catch (error) {
            handler.reject(
              DioException(
                requestOptions: request,
                error: error,
                type: DioExceptionType.cancel,
              ),
            );
          }
        },
        onResponse: (response, handler) {
          finish(response.requestOptions);
          if (!usable()) {
            handler.reject(
              DioException(
                requestOptions: response.requestOptions,
                error: const BrokerRouteException('CONNECTION_RETIRED'),
                type: DioExceptionType.cancel,
              ),
            );
          } else {
            handler.next(response);
          }
        },
        onError: (error, handler) {
          finish(error.requestOptions);
          if (usable() &&
              error.response?.statusCode == 401 &&
              error.requestOptions.headers.keys.any(
                (key) => {
                  'x-cosyncing-token',
                  'x-cosyncing-peer-token',
                  'authorization',
                }.contains(key.toLowerCase()),
              )) {
            // A scoped owner API can refuse a request while the credential
            // remains valid. Let the gate confirm it through broker health.
            // Peer revocation and authenticated readiness refusals invalidate
            // every route immediately, before any fallback can send secrets.
            if (error.requestOptions.headers.keys.any(
                  (key) => key.toLowerCase() == 'x-cosyncing-peer-token',
                ) ||
                {
                  '/api/broker/health',
                  '/api/connection/check',
                }.contains(error.requestOptions.uri.path)) {
              onAuthorizationRefused?.call();
            }
            onUnauthorized?.call();
          }
          handler.next(error);
        },
      ),
    );
    return client;
  }

  /// Sequential readiness rounds reuse this generation's authenticated pool.
  Dio probeClient() => _probeClient ??= dio();

  /// A canceled attempt must close its real pending sockets. Successful rounds
  /// leave their pool available for the next bounded latency sample.
  void abandonProbeClient(Dio client) {
    if (identical(client, _probeClient)) _probeClient = null;
    client.close(force: true);
  }

  /// Creates a session socket under the same destination and proxy policy.
  WebSocketAdapter socket(String url) {
    if (_retired) throw const BrokerRouteException('CONNECTION_RETIRED');
    context.requireDestination(Uri.parse(url));
    final session = Uri.parse(url).path.startsWith('/api/sessions/');
    late final _OwnedWebSocket socket;
    socket = _OwnedWebSocket(
      socketOverride?.call(url) ?? platform.routeSocketAdapter(context, url),
      onCount: session ? onSessionCount : null,
      onFailure: session ? onTransportFailure : null,
      onMutation: session ? _mutationDelta : null,
      mutationWait: () => _dispatchPaused?.future,
      onClosed: () => _sockets.remove(socket),
    );
    _sockets.add(socket);
    return socket;
  }

  /// A visible media resource may finish on its original approved path during
  /// a healthy handoff. Authorization/configuration retirement always stops it.
  void Function() retainResource(void Function() close) {
    if (_retired) throw const BrokerRouteException('CONNECTION_RETIRED');
    _retainedResources.add(close);
    return () {
      _retainedResources.remove(close);
      if (_retainedResources.isEmpty) {
        _onDrained?.call();
        _onDrained = null;
      }
    };
  }

  /// Drops this generation's connections without fencing it. Requests held on
  /// a path the network no longer carries fail and retry on new connections,
  /// and session sockets, unless excluded, reconnect with their own cursors.
  /// Pinned transfers keep their connections.
  void resetConnections({bool sockets = true}) {
    if (_retired) return;
    for (final client in [..._clients]) {
      client.reset();
    }
    if (!sockets) return;
    for (final socket in [..._sockets]) {
      socket.drop();
    }
  }

  /// Releases the coordinator's draining generation once its last view closes.
  void whenDrained(void Function() callback) {
    if (_retainedResources.isEmpty) {
      callback();
    } else {
      _onDrained = callback;
    }
  }

  /// Stops real I/O and fences completion before a replacement can dispatch.
  void retire({bool allowPinned = false}) {
    if (!allowPinned && !_forceRetired) {
      _forceRetired = true;
      for (final close in [..._retainedResources]) {
        close();
      }
      _retainedResources.clear();
      _onDrained?.call();
      _onDrained = null;
    }
    if (_retired) return;
    _retired = true;
    final dispatch = _dispatchPaused;
    _dispatchPaused = null;
    if (dispatch != null && !dispatch.isCompleted) dispatch.complete();
    for (final client in [..._clients]) {
      client.close(force: true);
    }
    for (final socket in [..._sockets]) {
      unawaited(socket.close());
    }
    _clients.clear();
    _sockets.clear();
    _probeClient = null;
  }
}

final class _OwnedHttpAdapter implements HttpClientAdapter {
  _OwnedHttpAdapter(this._create, this.onClosed) : _inner = _create();
  final HttpClientAdapter Function() _create;
  final void Function() onClosed;
  HttpClientAdapter _inner;
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? body,
    Future<void>? cancel,
  ) => _inner.fetch(options, body, cancel);

  /// Fails requests on the current pool; later requests use a new one.
  void reset() {
    final old = _inner;
    _inner = _create();
    old.close(force: true);
  }

  @override
  void close({bool force = false}) {
    onClosed();
    _inner.close(force: force);
  }
}

final class _OwnedWebSocket implements WebSocketAdapter {
  _OwnedWebSocket(
    this.inner, {
    required this.onClosed,
    this.onCount,
    this.onFailure,
    this.onMutation,
    this.mutationWait,
  });
  final WebSocketAdapter inner;
  final void Function(int)? onCount;
  final void Function()? onFailure;
  final void Function(int)? onMutation;
  final Future<void>? Function()? mutationWait;
  final void Function() onClosed;
  final _pending = <String>{};
  bool _closed = false;
  bool _counted = false;
  bool _reportedFailure = false;
  int _waitingDispatch = 0;
  void _failed() {
    if (_closed || _reportedFailure) return;
    _reportedFailure = true;
    onFailure?.call();
  }

  /// Ends the connection as a loss its session recovers from, without
  /// reporting a route failure: the route itself was not observed to fail.
  /// The session reconnects without closing this adapter, so it is released
  /// here, exactly as [close] would.
  void drop() => unawaited(close());

  @override
  bool get isConnected => inner.isConnected;
  @override
  Stream<Object?> get messages => inner.messages.transform(
    StreamTransformer.fromHandlers(
      handleData: (data, EventSink<Object?> sink) {
        if (!_closed &&
            data is Map &&
            data['pending'] != true &&
            (data['kind'] == 'nack' ||
                (data['kind'] == 'ack' && data['ack'] == 'client-message'))) {
          if (_pending.remove(data['clientMessageId'])) onMutation?.call(-1);
        }
        sink.add(data);
      },
      handleError: (Object error, StackTrace stack, EventSink<Object?> sink) {
        _failed();
        sink.addError(error, stack);
      },
      handleDone: (sink) {
        final closure = inner;
        if (closure is! WebSocketCloseDetails ||
            (closure as WebSocketCloseDetails).closeCode != 1000) {
          _failed();
        }
        sink.close();
      },
    ),
  );
  @override
  Future<void> connect() async {
    await inner.connect();
    if (!_closed && !_counted) {
      _counted = true;
      onCount?.call(1);
    }
  }

  @override
  void send(String data) => _send(jsonDecode(data), () => inner.send(data));
  @override
  void sendJson(Object data) => _send(data, () => inner.sendJson(data));
  void _send(Object? data, void Function() send) {
    final mutating =
        data is Map &&
        !{
          'history',
          'history-page',
          'history-refresh',
          'ping',
          'heartbeat',
          'ack',
          'nack',
        }.contains(data['kind']);
    final waiting = mutating ? mutationWait?.call() : null;
    if (waiting != null) {
      if (_waitingDispatch >= 64) {
        throw const BrokerRouteException('HANDOFF_BUSY');
      }
      _waitingDispatch++;
      unawaited(
        waiting.then((_) {
          _waitingDispatch--;
          if (!_closed) {
            try {
              _send(data, send);
            } on Object {
              _failed();
            }
          }
        }),
      );
      return;
    }
    String? admitted;
    if (!_closed &&
        onMutation != null &&
        data is Map &&
        data['clientMessageId'] is String &&
        !{
          'history',
          'history-page',
          'history-refresh',
          'ping',
          'heartbeat',
          'ack',
          'nack',
        }.contains(data['kind'])) {
      final id = data['clientMessageId'] as String;
      if (_pending.add(id)) {
        admitted = id;
        onMutation!(1);
      }
    }
    try {
      send();
    } on Object {
      if (admitted != null && _pending.remove(admitted)) onMutation?.call(-1);
      rethrow;
    }
  }

  @override
  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    if (_pending.isNotEmpty) {
      onMutation?.call(-_pending.length);
      _pending.clear();
    }
    if (_counted) {
      _counted = false;
      onCount?.call(-1);
    }
    onClosed();
    await inner.close();
  }
}
