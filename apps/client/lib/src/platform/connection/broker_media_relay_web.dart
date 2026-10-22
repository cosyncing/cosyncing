import 'package:cosyncing_client/src/features/connection/model/broker_route_context.dart';

/// Browsers cannot create or silently bypass a required native proxy path.
Future<(Uri, void Function())> createBrokerMediaRelay(
  BrokerRouteContext context,
  Uri destination,
) async => throw const BrokerRouteException('PROXY_UNSUPPORTED');
