import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/features/pairing/model/transport_qr_payload.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Service boundary for accepting QR v2 transport pairing offers.
// A provider-backed interface keeps controller tests off the network.
// ignore: one_member_abstracts
abstract interface class TransportPairingAcceptService {
  /// Accepts [payload] with locally generated peer material.
  Future<TransportPairingAcceptResponse> accept(
    TransportQrPayload payload, {
    required Uri brokerUrl,
    required String peerId,
    required String peerToken,
    required String identityPublicKey,
    required String exchangePublicKey,
  });
}

/// Broker-backed transport pairing accept service.
final class BrokerTransportPairingAcceptService
    implements TransportPairingAcceptService {
  @override
  Future<TransportPairingAcceptResponse> accept(
    TransportQrPayload payload, {
    required Uri brokerUrl,
    required String peerId,
    required String peerToken,
    required String identityPublicKey,
    required String exchangePublicKey,
  }) async {
    final pairingId = payload.pairingId;
    if (pairingId == null || pairingId.isEmpty) {
      throw const FormatException('QR payload is missing pairingId');
    }
    final client = BrokerClient(baseUrl: brokerUrl.toString());
    try {
      return await client.acceptTransportPairing(
        pairingId,
        TransportPairingAcceptRequest(
          peerId: peerId,
          peerToken: peerToken,
          identityPublicKey: identityPublicKey,
          exchangePublicKey: exchangePublicKey,
        ),
      );
    } finally {
      client.close();
    }
  }
}

/// Provider for transport pairing accept service.
final transportPairingAcceptServiceProvider =
    Provider<TransportPairingAcceptService>(
      (ref) => BrokerTransportPairingAcceptService(),
    );
