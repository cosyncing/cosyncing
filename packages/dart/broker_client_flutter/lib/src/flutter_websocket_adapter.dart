import 'dart:async';
import 'dart:convert';

import 'package:broker_client/broker_client.dart';
import 'package:web_socket_channel/web_socket_channel.dart';

/// Type signature for creating a socket channel for a URL.
typedef FlutterWebSocketChannelFactory = WebSocketChannel Function(String url);

/// Flutter implementation of [WebSocketAdapter] using `web_socket_channel`.
///
/// The adapter decodes incoming text frames into JSON objects and surfaces
/// JSON parsing failures as stream errors.
final class FlutterWebSocketAdapter implements WebSocketAdapter {
  /// Creates a Flutter WebSocket adapter for [url].
  ///
  /// [channelFactory] is injectable to make adapter tests deterministic and
  /// fully network-free.
  FlutterWebSocketAdapter(
    this.url, {
    FlutterWebSocketChannelFactory? channelFactory,
  }) : _channelFactory = channelFactory ?? _defaultChannelFactory;

  /// WebSocket URL used to connect.
  final String url;

  final FlutterWebSocketChannelFactory _channelFactory;
  final StreamController<Object?> _messages =
      StreamController<Object?>.broadcast();

  StreamSubscription<Object?>? _channelSub;
  WebSocketChannel? _channel;
  bool _isConnected = false;
  bool _isClosed = false;

  @override
  bool get isConnected => _isConnected && !_isClosed;

  @override
  Future<void> connect() async {
    if (_channel != null) {
      return;
    }

    final channel = _channelFactory(url);
    _channel = channel;

    try {
      await channel.ready;
    } catch (_) {
      _channel = null;
      _isConnected = false;
      rethrow;
    }
    if (_isClosed) {
      await close();
      return;
    }

    _isConnected = true;
    _channelSub = channel.stream.listen(
      _onIncomingFrame,
      onError: _messages.addError,
      onDone: close,
    );
  }

  @override
  void send(String data) {
    final channel = _channel;
    if (channel == null || !_isConnected || _isClosed) {
      throw StateError('WebSocket not connected');
    }
    channel.sink.add(data);
  }

  @override
  Stream<Object?> get messages => _messages.stream;

  @override
  void sendJson(Object data) => send(jsonEncode(data));

  @override
  Future<void> close() async {
    if (_isClosed) {
      return;
    }
    _isClosed = true;
    _isConnected = false;

    await _channelSub?.cancel();
    _channelSub = null;

    final channel = _channel;
    _channel = null;

    await channel?.sink.close();
    if (!_messages.isClosed) {
      await _messages.close();
    }
  }

  void _onIncomingFrame(Object? raw) {
    if (_isClosed) {
      return;
    }

    if (raw is String) {
      _decodeTextFrame(raw);
      return;
    }

    _messages.addError(
      const FormatException(
        'Invalid websocket frame: expected a text JSON frame.',
      ),
    );
  }

  void _decodeTextFrame(String raw) {
    try {
      final decoded = jsonDecode(raw);
      if (decoded is Map<String, dynamic> || decoded is List<dynamic>) {
        _messages.add(decoded);
      } else {
        _messages.addError(
          const FormatException(
            'Invalid websocket frame: expected decoded JSON object or array.',
          ),
        );
      }
    } on FormatException catch (error, stackTrace) {
      _messages.addError(error, stackTrace);
    }
  }

  static WebSocketChannel _defaultChannelFactory(String url) {
    return WebSocketChannel.connect(Uri.parse(url));
  }
}
