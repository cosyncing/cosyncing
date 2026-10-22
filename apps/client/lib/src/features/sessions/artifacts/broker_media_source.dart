import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_route_transport.dart';
import 'package:cosyncing_client/src/features/sessions/artifacts/file_media_source.dart';
import 'package:cosyncing_client/src/platform/connection/broker_media_relay.dart';

/// Keeps platform decoders on a required proxy without exposing credentials.
Future<FileMediaSource> brokerMediaSource(
  BrokerClient client,
  MediaPreviewTicket ticket,
) async {
  final route = resolverRoute(client.resolver);
  void releaseTicket() =>
      unawaited(client.releaseMediaPreview(ticket).catchError((Object _) {}));
  if (route == null || !route.context.requiresProxy) {
    return FileMediaSource(uri: ticket.url, release: releaseTicket);
  }
  void Function()? closeRelay;
  try {
    final (uri, close) = await createBrokerMediaRelay(
      route.context,
      ticket.url,
    );
    closeRelay = close;
    final release = route.retainResource(close);
    return FileMediaSource(
      uri: uri,
      release: () {
        close();
        release();
        releaseTicket();
      },
    );
  } on Object {
    closeRelay?.call();
    releaseTicket();
    rethrow;
  }
}
