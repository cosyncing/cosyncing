import 'dart:async';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:stream_channel/stream_channel.dart';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  Future<void> flush() => Future<void>.delayed(Duration.zero);

  group('FlutterWebSocketAdapter', () {
    test('sends frames and decodes valid JSON frames', () async {
      final connector = _FakeChannelConnector();
      final adapter = FlutterWebSocketAdapter(
        'ws://127.0.0.1/stream',
        channelFactory: connector.connect,
      );

      final emitted = <Object?>[];
      final errors = <Object>[];
      final sub = adapter.messages.listen(emitted.add, onError: errors.add);
      addTearDown(sub.cancel);

      await adapter.connect();
      await flush();

      final channel = connector.lastChannel;
      expect(channel, isNotNull);

      channel!.pushIncoming('{"kind":"notice","message":"attached"}');
      channel.pushIncoming('["one","two"]');
      await flush();

      expect(
        emitted,
        containsAllInOrder([
          {'kind': 'notice', 'message': 'attached'},
          ['one', 'two'],
        ]),
      );
      expect(errors, isEmpty);

      adapter.send('frame');
      expect(channel.sinkMessages, contains('frame'));
    });

    test('surfaces malformed JSON as stream errors', () async {
      final connector = _FakeChannelConnector();
      final adapter = FlutterWebSocketAdapter(
        'ws://127.0.0.1/stream',
        channelFactory: connector.connect,
      );

      final errors = <Object>[];
      final emitted = <Object?>[];
      final sub = adapter.messages.listen(emitted.add, onError: errors.add);
      addTearDown(sub.cancel);

      await adapter.connect();
      await flush();

      connector.lastChannel!.pushIncoming('not-json');
      connector.lastChannel!.pushIncoming(1);
      connector.lastChannel!.pushIncoming('"not-an-object-or-array"');
      await flush();

      expect(emitted, isEmpty);
      expect(errors.whereType<FormatException>(), hasLength(3));
      expect(errors.first, isA<FormatException>());
    });

    test('throws on send while disconnected', () async {
      final adapter = FlutterWebSocketAdapter(
        'ws://127.0.0.1/stream',
        channelFactory: _fakeDisconnectedChannelFactory,
      );

      expect(
        () => adapter.send('frame'),
        throwsA(
          isA<StateError>().having(
            (StateError error) => error.message,
            'message',
            'WebSocket not connected',
          ),
        ),
      );
    });

    test('failed ready resets channel state for a later connect', () async {
      final connector = _FakeChannelConnector();
      final adapter = FlutterWebSocketAdapter(
        'ws://127.0.0.1/stream',
        channelFactory: connector.connectWithFailingFirstReady,
      );

      await expectLater(adapter.connect(), throwsA(isA<StateError>()));
      expect(adapter.isConnected, isFalse);

      await adapter.connect();
      expect(adapter.isConnected, isTrue);

      await adapter.close();
    });

    test('closes sink and stream idempotently', () async {
      final connector = _FakeChannelConnector();
      final adapter = FlutterWebSocketAdapter(
        'ws://127.0.0.1/stream',
        channelFactory: connector.connect,
      );
      final done = Completer<void>();
      final sub = adapter.messages.listen((_) {}, onDone: done.complete);
      addTearDown(sub.cancel);

      await adapter.connect();
      await flush();

      await adapter.close();
      await adapter.close();
      await done.future;

      expect(connector.lastChannel, isNotNull);
      expect(
        (connector.lastChannel!.sink as _FakeWebSocketSink).isClosed,
        isTrue,
      );
    });
  });
}

final class _FakeChannelConnector {
  final List<_FakeWebSocketChannel> channels = [];
  bool _failNextReady = true;

  WebSocketChannel connect(String url) {
    final channel = _FakeWebSocketChannel();
    channels.add(channel);
    return channel;
  }

  WebSocketChannel connectWithFailingFirstReady(String url) {
    final channel = _FakeWebSocketChannel(
      readyError: _failNextReady ? StateError('ready failed') : null,
    );
    _failNextReady = false;
    channels.add(channel);
    return channel;
  }

  _FakeWebSocketChannel? get lastChannel =>
      channels.isEmpty ? null : channels.last;
}

final class _FakeWebSocketChannel
    with StreamChannelMixin<Object?>
    implements WebSocketChannel {
  _FakeWebSocketChannel({Object? readyError})
    : _incoming = StreamController<Object?>(sync: true) {
    if (readyError == null) {
      _ready.complete();
    } else {
      _ready.completeError(readyError);
    }
  }

  final StreamController<Object?> _incoming;
  final _sink = _FakeWebSocketSink();

  @override
  Stream<Object?> get stream => _incoming.stream;

  @override
  WebSocketSink get sink => _sink;

  @override
  String? get protocol => null;

  @override
  int? get closeCode => null;

  @override
  String? get closeReason => null;

  @override
  Future<void> get ready => _ready.future;
  final Completer<void> _ready = Completer<void>();

  List<Object?> get sinkMessages => _sink.messages;

  void pushIncoming(Object? data) {
    _incoming.add(data);
  }
}

final class _FakeWebSocketSink implements WebSocketSink {
  final List<Object?> messages = [];
  bool isClosed = false;
  final Completer<void> _done = Completer<void>();

  @override
  void add(Object? data) {
    if (isClosed) {
      return;
    }
    messages.add(data);
  }

  @override
  void addError(Object error, [StackTrace? stackTrace]) {}

  @override
  Future<void> addStream(Stream<Object?> stream) async {
    await for (final event in stream) {
      add(event);
    }
  }

  @override
  Future<void> close([int? closeCode, String? closeReason]) async {
    if (isClosed) {
      return;
    }
    isClosed = true;
    _done.complete();
  }

  @override
  Future<void> get done => _done.future;
}

WebSocketChannel _fakeDisconnectedChannelFactory(String _) =>
    throw UnsupportedError('no live connection');
