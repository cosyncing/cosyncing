import 'dart:convert';

import 'package:broker_contract/broker_contract.dart';
import 'package:broker_crypto/broker_crypto.dart';

import 'fake_broker.dart';

/// Real Ed25519 proofs at the fake broker boundary. The app verifies them and
/// performs its actual migration, selection, ticket and connection workflows.
final class RoutesDesk {
  RoutesDesk(this.identity, this.now);
  final IdentityKeyPair identity;
  final DateTime Function() now;
  final List<FakeBroker> brokers = [];
  final Set<String> advertised = {};
  String principal = 'owner';
  bool wrongNonce = false;
  bool wrongOrigin = false;
  bool badSignature = false;
  int checkRequests = 0;
  final Map<String, Duration> latency = {};
  int configurationGeneration = 1;
  List<String> browsers = [];

  void add(FakeBroker broker) {
    brokers.add(broker);
    advertised.add(broker.baseUri.origin);
    broker.routes.add((request) async {
      if (request.path == '/api/connection/identity-proof') {
        final body = request.body! as Map;
        if (!advertised.contains(body['origin'])) {
          return const FakeBrokerResponse(403, {
            'error': 'Origin not advertised',
          });
        }
        final nonce = wrongNonce ? 'other-nonce' : body['nonce'] as String;
        final origin = wrongOrigin
            ? 'https://other.test'
            : body['origin'] as String;
        final issued = now().millisecondsSinceEpoch;
        final expires = issued + 15000;
        final signature = await PairingCrypto.signIdentityMessage(
          privateKey: identity.privateKey,
          message: utf8.encode(
            jsonEncode([
              'cosyncing/server-routes-v1',
              nonce,
              origin,
              identity.publicKey,
              issued,
              expires,
            ]),
          ),
        );
        return FakeBrokerResponse(200, {
          'version': 1,
          'nonce': nonce,
          'origin': origin,
          'identityPublicKey': identity.publicKey,
          'issuedAt': issued,
          'expiresAt': expires,
          'signature': badSignature ? 'invalid' : signature,
        });
      }
      if (request.path == '/api/connection/check') {
        checkRequests++;
        if (latency[broker.baseUri.origin] case final delay?) {
          await Future<void>.delayed(delay);
        }
        return FakeBrokerResponse(200, check());
      }
      if (request.path == '/api/connection/configuration') {
        if (request.method == 'POST') {
          final body = request.body! as Map;
          if (body['generation'] != configurationGeneration) {
            return const FakeBrokerResponse(400, {'error': 'Changed'});
          }
          configurationGeneration++;
          advertised
            ..clear()
            ..addAll((body['advertisedOrigins'] as List).cast<String>());
          browsers = (body['trustedClientOrigins'] as List).cast<String>();
        }
        return FakeBrokerResponse(200, {
          'version': 1,
          'generation': configurationGeneration,
          'advertisedOrigins': advertised.toList(),
          'trustedClientOrigins': browsers,
        });
      }
      return null;
    });
    broker.connectionCheckFrame = (_) => {
      'kind': 'connection-check',
      ...check(),
      'compatibility': {
        'status': 'compatible',
        'readOnly': false,
        'broker': contract,
      },
    };
  }

  Map<String, Object?> get contract => {
    'revision': cosyncingClientContractRevision,
    'minimumClientRevision': cosyncingClientMinimumBrokerRevision,
    'surfaceHash': cosyncingClientContractSurfaceHash,
  };
  Map<String, Object?> check() => {
    'capability': 'server-routes-v1',
    'identityPublicKey': identity.publicKey,
    'principalId': principal,
    'authGeneration': 1,
    'contract': contract,
  };
}
