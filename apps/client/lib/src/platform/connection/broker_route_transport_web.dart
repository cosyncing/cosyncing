import 'dart:async';
import 'dart:js_interop';
import 'dart:typed_data';

import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_route_context.dart';
import 'package:dio/dio.dart';
import 'package:web/web.dart' as web;

/// Browser networking honors origin policy and never ignores a required proxy.
/// Fetch rejects redirects before following them; XHR cannot offer that fence.
HttpClientAdapter routeHttpAdapter(BrokerRouteContext context) {
  context.validatePath(native: false);
  if (web.window.location.protocol == 'https:' &&
      context.origin.scheme == 'http') {
    throw const BrokerRouteException('BROWSER_MIXED_CONTENT');
  }
  return _FetchAdapter(context);
}

/// Browser-managed WebSocket path; custom native proxy bindings are blocked.
WebSocketAdapter routeSocketAdapter(BrokerRouteContext context, String url) {
  context.validatePath(native: false);
  if (web.window.location.protocol == 'https:' &&
      context.origin.scheme == 'http') {
    throw const BrokerRouteException('BROWSER_MIXED_CONTENT');
  }
  context.requireDestination(Uri.parse(url));
  return FlutterWebSocketAdapter(url);
}

extension type _IterableHeaders(JSObject _) implements JSObject {
  external void forEach(JSFunction callback);
}

final class _FetchAdapter implements HttpClientAdapter {
  _FetchAdapter(this.context);
  final BrokerRouteContext context;
  final _requests = <web.AbortController>{};
  bool _closed = false;

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async {
    context.requireDestination(options.uri);
    if (_closed) throw const BrokerRouteException('CONNECTION_RETIRED');
    final abort = web.AbortController();
    _requests.add(abort);
    Timer? deadline;
    DioException? interrupted;
    void cancel([DioException? error]) {
      interrupted = error;
      abort.abort();
    }

    unawaited(
      cancelFuture?.then(
        (_) => cancel(
          DioException.requestCancelled(
            requestOptions: options,
            reason: 'Request canceled',
          ),
        ),
      ),
    );
    final timeout = options.connectTimeout;
    if (timeout != null && timeout > Duration.zero) {
      deadline = Timer(
        timeout,
        () => cancel(
          DioException.connectionTimeout(
            requestOptions: options,
            timeout: timeout,
          ),
        ),
      );
    }
    void release() {
      deadline?.cancel();
      _requests.remove(abort);
    }

    try {
      // Browser request-stream support differs by engine. Existing uploads use
      // 256 KiB chunks; bound the fallback buffer instead of accepting an
      // unbounded multipart body or selecting a different network path.
      Uint8List? body;
      if (requestStream != null) {
        final bytes = BytesBuilder(copy: false);
        await for (final chunk in requestStream) {
          if (abort.signal.aborted) {
            throw interrupted ??
                const BrokerRouteException('CONNECTION_CANCELED');
          }
          if (bytes.length + chunk.length > 16 * 1024 * 1024) {
            throw const BrokerRouteException('UPLOAD_CHUNK_TOO_LARGE');
          }
          bytes.add(chunk);
        }
        body = bytes.takeBytes();
      }
      final headers = web.Headers();
      for (final entry in options.headers.entries) {
        if (entry.key.toLowerCase() == 'content-length') continue;
        headers.set(
          entry.key,
          entry.value is Iterable
              ? (entry.value as Iterable).join(', ')
              : '${entry.value}',
        );
      }
      final response = await web.window
          .fetch(
            options.uri.toString().toJS,
            web.RequestInit(
              method: options.method,
              headers: headers,
              body: body?.toJS,
              redirect: 'error',
              credentials: 'same-origin',
              cache: 'no-store',
              signal: abort.signal,
            ),
          )
          .toDart;
      deadline?.cancel();
      if (body != null) options.onSendProgress?.call(body.length, body.length);
      final responseHeaders = <String, List<String>>{};
      _IterableHeaders(response.headers).forEach(
        ((JSString value, JSString key, JSAny _) {
          responseHeaders[key.toDart] = [value.toDart];
        }).toJS,
      );
      Stream<Uint8List> read() async* {
        final stream = response.body;
        if (stream == null) {
          release();
          return;
        }
        final reader = web.ReadableStreamDefaultReader(stream);
        try {
          while (true) {
            final next = await reader.read().toDart;
            if (next.done) break;
            yield (next.value! as JSUint8Array).toDart;
          }
        } on Object catch (error) {
          throw interrupted ??
              DioException.connectionError(
                requestOptions: options,
                reason: 'Browser connection failed',
                error: error,
              );
        } finally {
          abort.abort();
          reader.releaseLock();
          release();
        }
      }

      return ResponseBody(
        read(),
        response.status,
        headers: responseHeaders,
        statusMessage: response.statusText,
        onClose: () {
          cancel();
          release();
        },
      );
    } on Object catch (error) {
      cancel(interrupted);
      release();
      if (interrupted != null) throw interrupted!;
      if (error is DioException || error is BrokerRouteException) rethrow;
      throw DioException.connectionError(
        requestOptions: options,
        reason: 'Browser refused the connection or redirect',
        error: error,
      );
    }
  }

  @override
  void close({bool force = false}) {
    _closed = true;
    if (force) {
      for (final request in _requests) {
        request.abort();
      }
    }
  }
}
