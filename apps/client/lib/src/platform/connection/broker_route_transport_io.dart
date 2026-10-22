import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:broker_client/broker_client.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_route_context.dart';
import 'package:dio/dio.dart';
import 'package:dio/io.dart';

/// A lazy adapter with a pool owned by exactly one immutable context.
HttpClientAdapter routeHttpAdapter(BrokerRouteContext context) {
  context.validatePath(native: true);
  return context.proxy == null
      ? IOHttpClientAdapter(
          createHttpClient: () => routeNativeHttpClient(context),
        )
      : _ProxyHttpClientAdapter(context);
}

final _proxyRequestZoneKey = Object();

/// Dio attaches request.abort only after openUrl completes. A proxy may stall
/// before that point. Carry cancellation into this request's connection factory
/// without closing the route's other pooled connections.
final class _ProxyHttpClientAdapter extends IOHttpClientAdapter {
  _ProxyHttpClientAdapter(BrokerRouteContext context)
    : super(createHttpClient: () => routeNativeHttpClient(context));

  final _requests = <_PendingProxyConnections>{};

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    final pending = _PendingProxyConnections();
    _requests.add(pending);
    final cancellation = cancelFuture?.asStream().listen(
      (_) => pending.cancel(),
      onError: (Object _, StackTrace _) => pending.cancel(),
    );
    try {
      return await runZoned(
        () => super.fetch(options, requestStream, cancelFuture),
        zoneValues: {_proxyRequestZoneKey: pending},
      );
    } finally {
      // Also retire a handshake when a shorter per-request timeout wins.
      pending.cancel();
      _requests.remove(pending);
      await cancellation?.cancel();
    }
  }

  @override
  void close({bool force = false}) {
    for (final request in _requests) {
      request.cancel();
    }
    super.close(force: force);
  }
}

final class _PendingProxyConnections {
  final _cancel = <void Function()>{};
  bool _canceled = false;

  void add(void Function() cancel) {
    if (_canceled) {
      cancel();
    } else {
      _cancel.add(cancel);
    }
  }

  void remove(void Function() cancel) => _cancel.remove(cancel);

  void cancel() {
    _canceled = true;
    for (final cancel in _cancel.toList()) {
      cancel();
    }
    _cancel.clear();
  }
}

/// WebSockets use the same destination checks, proxy and secret generation.
WebSocketAdapter routeSocketAdapter(BrokerRouteContext context, String url) {
  final target = _withDefaultPort(url);
  context
    ..validatePath(native: true)
    ..requireDestination(Uri.parse(target));
  return _RouteWebSocket(context, target);
}

/// dart:io knows no default port for ws/wss: it rebuilds `wss://host/path` as
/// `https://host:0/path`, which fails the destination check and would name
/// port 0 to a proxy. Spell out the scheme's default port instead.
String _withDefaultPort(String url) {
  final uri = Uri.parse(url);
  if (uri.hasPort) return url;
  return switch (uri.scheme) {
    'wss' => uri.replace(port: 443).toString(),
    'ws' => uri.replace(port: 80).toString(),
    _ => url,
  };
}

/// Native streaming clients share the exact proxy and destination policy.
HttpClient routeNativeHttpClient(BrokerRouteContext context) {
  context.validatePath(native: true);
  final client = HttpClient()..connectionTimeout = const Duration(seconds: 10);
  final proxy = context.proxy;
  if (proxy == null) {
    // Never inherit process proxy variables for a saved Direct binding.
    client.findProxy = (uri) {
      context.requireDestination(uri);
      return 'DIRECT';
    };
  } else if (proxy.protocol == BrokerProxyProtocol.http) {
    if (context.origin.scheme == 'https') {
      // dart:io's built-in CONNECT path also attaches registered proxy
      // credentials to requests inside the TLS tunnel. Own this handshake so
      // that the broker can never receive Proxy-Authorization.
      client
        ..findProxy = (_) {
          return 'DIRECT';
        }
        ..connectionFactory = (uri, _, _) {
          context.requireDestination(uri);
          return Future.value(
            _proxyConnection(context, uri, httpTunnel: true),
          );
        };
      return client;
    }
    final host = proxy.host.startsWith('[')
        ? proxy.host.substring(1, proxy.host.length - 1)
        : proxy.host;
    client
      ..findProxy = (uri) {
        context.requireDestination(uri);
        return 'PROXY ${host.contains(':') ? '[$host]' : host}:${proxy.port}';
      }
      ..connectionFactory = (uri, proxyHost, proxyPort) {
        context.requireDestination(uri);
        if (proxyHost != host || proxyPort != proxy.port) {
          throw const BrokerRouteException('PROXY_REQUIRED');
        }
        return Future.value(_proxyConnection(context, uri, plainHttp: true));
      };
    final credentials = context.proxyCredentials;
    if (credentials != null) {
      // Supply only to this proxy on the first request. A challenge/retry would
      // drop streamed request bodies and could replay a broker mutation.
      client
        ..addProxyCredentials(
          host,
          proxy.port,
          '',
          HttpClientBasicCredentials(
            credentials.username,
            credentials.password,
          ),
        )
        ..authenticateProxy = (_, _, _, _) async => false;
    }
  } else {
    client
      ..findProxy = (_) {
        return 'DIRECT';
      }
      ..connectionFactory = (uri, proxyHost, proxyPort) {
        context.requireDestination(uri);
        return Future.value(_proxyConnection(context, uri));
      };
  }
  return client;
}

ConnectionTask<Socket> _proxyConnection(
  BrokerRouteContext context,
  Uri uri, {
  bool httpTunnel = false,
  bool plainHttp = false,
}) {
  final proxy = context.proxy!;
  ConnectionTask<Socket>? connecting;
  Socket? socket;
  var canceled = false;
  void cancel() {
    canceled = true;
    connecting?.cancel();
    socket?.destroy();
  }

  final pending =
      Zone.current[_proxyRequestZoneKey] as _PendingProxyConnections?;
  pending?.add(cancel);
  final attempt = () async {
    if (canceled) throw const BrokerRouteException('CANCELED');
    // The destination is never passed to Socket.connect/InternetAddress.lookup.
    final proxyHost = proxy.host.startsWith('[')
        ? proxy.host.substring(1, proxy.host.length - 1)
        : proxy.host;
    try {
      connecting = await Socket.startConnect(proxyHost, proxy.port);
      if (canceled) connecting!.cancel();
      socket = await connecting!.socket;
    } on SocketException {
      throw const BrokerRouteException('PROXY_UNREACHABLE');
    }
    if (canceled) {
      socket!.destroy();
      throw const BrokerRouteException('CANCELED');
    }
    if (plainHttp) return socket!;
    final reader = _ProxyHandshake(socket!, limit: httpTunnel ? 16384 : 1024);
    try {
      final credentials = context.proxyCredentials;
      if (httpTunnel) {
        final destination = uri.host.startsWith('[')
            ? uri.host.substring(1, uri.host.length - 1)
            : uri.host;
        final authority = [
          if (destination.contains(':')) '[$destination]' else destination,
          uri.port,
        ].join(':');
        final encodedCredentials = credentials == null
            ? null
            : base64Encode(
                utf8.encode(
                  '${credentials.username}:${credentials.password}',
                ),
              );
        final auth = credentials == null
            ? ''
            : 'Proxy-Authorization: Basic '
                  '$encodedCredentials\r\n';
        socket!.add(
          ascii.encode(
            'CONNECT $authority HTTP/1.1\r\nHost: $authority\r\n$auth\r\n',
          ),
        );
        await socket!.flush();
        final header = await reader.readHttpHeader();
        final status = RegExp(
          r'^HTTP/1\.[01] ([0-9]{3})(?: |\r)',
        ).firstMatch(header)?.group(1);
        if (status == '407') {
          throw const BrokerRouteException('PROXY_AUTHENTICATION_REQUIRED');
        }
        if (status != '200') {
          throw const BrokerRouteException('PROXY_TUNNEL_REFUSED');
        }
      } else {
        socket!.add([5, 1, if (credentials == null) 0 else 2]);
        await socket!.flush();
        final method = await reader.read(2);
        if (method[0] != 5 || method[1] != (credentials == null ? 0 : 2)) {
          throw const BrokerRouteException('PROXY_AUTHENTICATION_REQUIRED');
        }
        if (credentials != null) {
          final user = utf8.encode(credentials.username);
          final password = utf8.encode(credentials.password);
          if (user.isEmpty ||
              user.length > 255 ||
              password.isEmpty ||
              password.length > 255) {
            throw const BrokerRouteException('PROXY_CREDENTIAL_INVALID');
          }
          socket!.add([1, user.length, ...user, password.length, ...password]);
          await socket!.flush();
          final auth = await reader.read(2);
          if (auth[0] != 1 || auth[1] != 0) {
            throw const BrokerRouteException('PROXY_AUTHENTICATION_REQUIRED');
          }
        }
        final address = InternetAddress.tryParse(uri.host);
        final destination = address == null
            ? ascii.encode(uri.host)
            : address.rawAddress;
        if (destination.isEmpty || destination.length > 255) {
          throw const BrokerRouteException('DESTINATION_INVALID');
        }
        socket!.add([
          5,
          1,
          0,
          if (address == null) ...[
            3,
            destination.length,
          ] else if (address.type == InternetAddressType.IPv4)
            1
          else
            4,
          ...destination,
          uri.port >> 8,
          uri.port & 255,
        ]);
        await socket!.flush();
        final reply = await reader.read(4);
        if (reply[0] != 5 || reply[2] != 0) {
          throw const BrokerRouteException('PROXY_PROTOCOL_ERROR');
        }
        if (reply[1] != 0) {
          throw const BrokerRouteException('DESTINATION_UNAVAILABLE');
        }
        final length = switch (reply[3]) {
          1 => 4,
          4 => 16,
          3 => (await reader.read(1)).single,
          _ => throw const BrokerRouteException('PROXY_PROTOCOL_ERROR'),
        };
        await reader.read(length + 2);
      }
      if (canceled) throw const BrokerRouteException('CANCELED');
      if (uri.scheme == 'https') {
        reader.pauseForTls();
        // Dart's secure upgrade uses the host for TLS verification/SNI without
        // resolving it locally. The proxy-connected socket remains the path.
        socket = await SecureSocket.secure(socket!, host: uri.host);
        if (canceled) {
          socket!.destroy();
          throw const BrokerRouteException('CANCELED');
        }
        return socket!;
      }
      return reader.handoff();
    } on Object {
      socket?.destroy();
      rethrow;
    }
  }();
  return ConnectionTask.fromSocket(
    attempt
        .timeout(
          const Duration(seconds: 10),
          onTimeout: () {
            cancel();
            throw const BrokerRouteException('PROXY_TIMEOUT');
          },
        )
        .whenComplete(() => pending?.remove(cancel)),
    cancel,
  );
}

/// Bounded handshake data; after handoff the socket stream retains its
/// normal backpressure. No upload/download body passes through this buffer.
final class _ProxyHandshake {
  _ProxyHandshake(this.socket, {required this.limit}) {
    subscription = socket.listen(
      _data,
      onError: _error,
      onDone: () {
        if (output case final controller?) {
          unawaited(controller.close());
        } else {
          _error(const BrokerRouteException('PROXY_CLOSED'));
        }
      },
    );
  }
  final Socket socket;
  final int limit;
  late final StreamSubscription<Uint8List> subscription;
  final List<int> buffer = [];
  Completer<void>? changed;
  Object? failure;
  StreamController<Uint8List>? output;

  void _data(Uint8List data) {
    if (output case final controller?) {
      controller.add(data);
      return;
    }
    if (buffer.length + data.length > limit) {
      _error(const BrokerRouteException('PROXY_PROTOCOL_ERROR'));
      socket.destroy();
      return;
    }
    buffer.addAll(data);
    changed?.complete();
    changed = null;
  }

  void _error(Object error) {
    failure = error;
    if (output case final controller?) {
      controller.addError(error);
      unawaited(controller.close());
    }
    changed?.complete();
    changed = null;
  }

  Future<List<int>> read(int count) async {
    while (buffer.length < count) {
      if (failure case final error?) {
        Error.throwWithStackTrace(error, StackTrace.current);
      }
      await (changed ??= Completer<void>()).future;
    }
    final bytes = buffer.sublist(0, count);
    buffer.removeRange(0, count);
    return bytes;
  }

  Future<String> readHttpHeader() async {
    final bytes = <int>[];
    while (bytes.length < limit) {
      bytes.add((await read(1)).single);
      final n = bytes.length;
      if (n >= 4 &&
          bytes[n - 4] == 13 &&
          bytes[n - 3] == 10 &&
          bytes[n - 2] == 13 &&
          bytes[n - 1] == 10) {
        return latin1.decode(bytes);
      }
    }
    throw const BrokerRouteException('PROXY_PROTOCOL_ERROR');
  }

  void pauseForTls() {
    subscription.pause();
    if (buffer.isNotEmpty) {
      throw const BrokerRouteException('PROXY_PROTOCOL_ERROR');
    }
  }

  Socket handoff() {
    subscription.pause();
    output = StreamController<Uint8List>(
      onListen: subscription.resume,
      onPause: subscription.pause,
      onResume: subscription.resume,
      onCancel: () {
        socket.destroy();
        return subscription.cancel();
      },
    );
    if (buffer.isNotEmpty) {
      output!.add(Uint8List.fromList(buffer));
      buffer.clear();
    }
    return _TunnelSocket(output!.stream, socket);
  }
}

/// A plain HTTP tunnel has consumed its SOCKS greeting, so the existing socket
/// subscription is forwarded. TLS instead returns Dart's actual SecureSocket.
final class _TunnelSocket extends StreamView<Uint8List> implements Socket {
  _TunnelSocket(super.stream, this.socket);
  final Socket socket;
  @override
  void add(List<int> data) => socket.add(data);
  @override
  void addError(Object error, [StackTrace? stackTrace]) =>
      socket.addError(error, stackTrace);
  @override
  Future<void> addStream(Stream<List<int>> stream) => socket.addStream(stream);
  @override
  Future<void> flush() => socket.flush();
  @override
  Future<void> close() async {
    await socket.close();
  }

  @override
  Future<void> get done async {
    await socket.done;
  }

  @override
  Encoding get encoding => socket.encoding;
  @override
  set encoding(Encoding value) => socket.encoding = value;
  @override
  void write(Object? object) => socket.write(object);
  @override
  void writeAll(Iterable<Object?> objects, [String separator = '']) =>
      socket.writeAll(objects, separator);
  @override
  void writeCharCode(int charCode) => socket.writeCharCode(charCode);
  @override
  void writeln([Object? object = '']) => socket.writeln(object);
  @override
  void destroy() => socket.destroy();
  @override
  bool setOption(SocketOption option, bool enabled) =>
      socket.setOption(option, enabled);
  @override
  Uint8List getRawOption(RawSocketOption option) => socket.getRawOption(option);
  @override
  void setRawOption(RawSocketOption option) => socket.setRawOption(option);
  @override
  InternetAddress get address => socket.address;
  @override
  InternetAddress get remoteAddress => socket.remoteAddress;
  @override
  int get port => socket.port;
  @override
  int get remotePort => socket.remotePort;
}

final class _RouteWebSocket implements WebSocketAdapter, WebSocketCloseDetails {
  _RouteWebSocket(this.context, this.url);
  final BrokerRouteContext context;
  final String url;
  final _messages = StreamController<Object?>.broadcast();
  HttpClient? _client;
  WebSocket? _socket;
  StreamSubscription<Object?>? _subscription;
  bool _closed = false;
  @override
  bool get isConnected => !_closed && _socket?.readyState == WebSocket.open;
  @override
  int? get closeCode => _socket?.closeCode;
  @override
  Stream<Object?> get messages => _messages.stream;
  @override
  Future<void> connect() async {
    if (_closed || _socket != null) return;
    _client = routeNativeHttpClient(context);
    try {
      final socket = await WebSocket.connect(url, customClient: _client)
          .timeout(
            const Duration(seconds: 10),
            onTimeout: () {
              _client!.close(force: true);
              throw const BrokerRouteException('WEBSOCKET_TIMEOUT');
            },
          );
      if (_closed) {
        await socket.close();
        return;
      }
      _socket = socket;
      _subscription = socket.listen(
        (Object? value) {
          try {
            if (!_closed) _messages.add(jsonDecode(value! as String));
          } on Object catch (error, stack) {
            if (!_closed) _messages.addError(error, stack);
          }
        },
        onError: (Object error, StackTrace stack) {
          if (!_closed) _messages.addError(error, stack);
        },
        onDone: () => unawaited(close()),
      );
    } on Object {
      _client!.close(force: true);
      rethrow;
    }
  }

  @override
  void send(String data) {
    if (!isConnected) throw StateError('WebSocket is not connected');
    _socket!.add(data);
  }

  @override
  void sendJson(Object data) => send(jsonEncode(data));
  @override
  Future<void> close() async {
    if (_closed) return;
    _closed = true;
    _client?.close(force: true);
    await _subscription?.cancel();
    await _socket?.close();
    unawaited(_messages.close());
  }
}
