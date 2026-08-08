import 'dart:async';
import 'dart:convert';
import 'dart:io' as io;

import 'package:broker_client/src/websocket_adapter.dart';

/// Platform-specific [WebSocketAdapter] using `dart:io`.
///
/// This file is imported via conditional import in
/// `websocket_adapter.dart`.
WebSocketAdapter createPlatformWebSocketAdapter(String url) =>
    _IoWebSocketAdapter(url);

class _IoWebSocketAdapter implements WebSocketAdapter {
  _IoWebSocketAdapter(this.url);

  final String url;
  io.WebSocket? _socket;
  final _controller = StreamController<Object?>.broadcast();

  @override
  bool get isConnected => _socket != null;

  @override
  Future<void> connect() async {
    _socket = await io.WebSocket.connect(url);
    _socket!.listen(
      _controller.add,
      onError: _controller.addError,
      onDone: () {
        _socket = null;
        if (!_controller.isClosed) {
          _controller.close();
        }
      },
    );
  }

  @override
  void send(String data) {
    final socket = _socket;
    if (socket == null) {
      throw StateError('WebSocket not connected');
    }
    socket.add(data);
  }

  @override
  void sendJson(Object data) {
    send(jsonEncode(data));
  }

  @override
  Stream<Object?> get messages => _controller.stream;

  @override
  Future<void> close() async {
    final socket = _socket;
    _socket = null;
    if (socket != null) {
      await socket.close(1000, 'client close');
    }
    if (!_controller.isClosed) {
      await _controller.close();
    }
  }
}
