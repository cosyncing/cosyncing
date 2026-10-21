import 'package:broker_client/broker_client.dart';

/// Owner configuration captured through one approved server connection.
final class BrokerRouteConfigurationSession {
  /// Takes ownership of the client until the review is dismissed.
  BrokerRouteConfigurationSession(this._client);

  final BrokerClient _client;

  /// Fetches the owner's current advertised and browser origins.
  Future<Map<String, dynamic>> load() => _client.getRouteConfiguration();

  /// Applies a generation-checked owner edit.
  Future<int> save({
    required int generation,
    required List<String> advertisedOrigins,
    required List<String> trustedClientOrigins,
  }) async {
    final result = await _client.saveRouteConfiguration({
      'generation': generation,
      'advertisedOrigins': advertisedOrigins,
      'trustedClientOrigins': trustedClientOrigins,
    });
    return result['generation'] as int;
  }

  /// Releases the captured transport and cancels pending requests.
  void close() => _client.close();
}
