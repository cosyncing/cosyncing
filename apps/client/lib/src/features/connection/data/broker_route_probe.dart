import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:broker_client/broker_client.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:broker_crypto/broker_crypto.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_route_transport.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_route_context.dart';
import 'package:dio/dio.dart';

/// Converts transport-specific observations into stable presentation codes.
String brokerRouteFailureCode(Object error, {required bool browser}) {
  if (error is BrokerRouteTrustRequired) {
    return 'IDENTITY_VERIFICATION_REQUIRED';
  }
  if (error is BrokerRouteException) return error.code;
  if (error is DioException) {
    if (error.response?.statusCode == 401) return 'AUTHORIZATION_REQUIRED';
    if (error.response?.statusCode == 407) {
      return 'PROXY_AUTHENTICATION_REQUIRED';
    }
    if (error.error case final BrokerRouteException cause) return cause.code;
    if (error.type == DioExceptionType.badCertificate) return 'TLS_FAILED';
    if (browser && error.type == DioExceptionType.connectionError) {
      return 'BROWSER_BLOCKED';
    }
  }
  return 'CONNECTION_FAILED';
}

/// An unsigned key is only a proposal for the explicit first-trust UI.
final class BrokerRouteTrustRequired implements Exception {
  /// Carries only the proposed public key for first-trust review.
  const BrokerRouteTrustRequired(this.publicKey);

  /// Self-reported identity awaiting an explicit first-trust decision.
  final String publicKey;
  @override
  String toString() => 'Server identity needs verification';
}

/// Fresh route readiness for exactly one immutable transport context.
final class BrokerRouteObservation {
  /// Copies the samples for one exact readiness context.
  BrokerRouteObservation({
    required this.context,
    required this.identityPublicKey,
    required this.principalId,
    required this.authGeneration,
    required this.checkedAt,
    required List<double> samples,
    required this.handshakeMilliseconds,
  }) : samples = List.unmodifiable(samples);

  /// Exact immutable destination, network, proxy and credential generation.
  final BrokerRouteContext context;

  /// Pinned or verified broker identity, never a URL-derived identity.
  final String identityPublicKey;

  /// Authenticated account/peer identity; different peers remain separate.
  final String principalId;

  /// Authorization revision captured for this observation or context.
  final int authGeneration;

  /// Completion time used to display age and reject stale observations.
  final DateTime checkedAt;

  /// Successful authenticated application round trips, in milliseconds.
  final List<double> samples;

  /// Full proof/authentication/WS setup time, separate from latency.
  final double handshakeMilliseconds;

  /// Ranked median, unavailable until at least two samples succeeded.
  double? get medianMilliseconds {
    if (samples.length < 2) return null;
    final sorted = [...samples]..sort();
    return sorted.length == 2 ? (sorted[0] + sorted[1]) / 2 : sorted[1];
  }

  /// Whether this observation is within the bounded freshness window.
  bool fresh(DateTime now) {
    final age = now.difference(checkedAt);
    return !age.isNegative && age < const Duration(seconds: 60);
  }
}

/// One coalesced attempt owns actual cancellation of both HTTP and WS I/O.
final class BrokerRouteProbe {
  /// Creates one bounded attempt; construction starts no I/O.
  BrokerRouteProbe({
    required this.transport,
    required this.credentials,
    required this.expectedIdentity,
    this.expectedPrincipal,
    this.freshReadiness,
    this.onReady,
    this.monotonicNow,
    DateTime Function()? now,
  }) : now = now ?? DateTime.now;

  /// Scoped HTTP/WS pools used for every stage of this attempt.
  final BrokerRouteTransport transport;

  /// Broker authentication material; attached only after identity verification.
  final EndpointResolver credentials;

  /// Previously approved identity; null requires explicit first trust.
  final String? expectedIdentity;

  /// Required access identity when adding or reconsidering an address.
  final String? expectedPrincipal;

  /// Reusable readiness for this same immutable context, if still fresh.
  final BrokerRouteObservation? freshReadiness;

  /// Publishes usable readiness before collecting the remaining latency
  /// samples.
  final void Function(BrokerRouteObservation)? onReady;

  /// Wall clock for freshness and proof expiry; latency uses monotonic time.
  final DateTime Function() now;

  /// Injectable monotonic time; defaults to the attempt's own stopwatch.
  final Duration Function()? monotonicNow;
  final _cancel = CancelToken();
  WebSocketAdapter? _socket;
  Dio? _client;

  /// Closes temporary HTTP/WS work and fences a superseded attempt.
  void cancel() {
    if (!_cancel.isCancelled) _cancel.cancel('Connection attempt superseded');
    if (_client case final client?) transport.abandonProbeClient(client);
    if (_socket case final socket?) unawaited(socket.close());
  }

  /// Verifies identity, access and WS readiness within one total deadline.
  Future<BrokerRouteObservation> run() async {
    final client = _client = transport.probeClient();
    final deadline = Timer(const Duration(seconds: 10), cancel);
    final watch = Stopwatch()..start();
    Duration elapsed() => monotonicNow?.call() ?? watch.elapsed;
    final started = elapsed();
    final context = transport.context;
    final samples = <double>[];
    try {
      final cached = freshReadiness;
      final reuse =
          cached != null &&
          identical(cached.context, context) &&
          cached.fresh(now());
      String key;
      if (reuse) {
        key = cached.identityPublicKey;
      } else {
        final nonce = base64UrlNoPadding(
          List.generate(32, (_) => Random.secure().nextInt(256)),
        );
        final response = await client.post<Map<String, dynamic>>(
          '${context.origin}/api/connection/identity-proof',
          data: {'nonce': nonce, 'origin': context.origin.origin},
          cancelToken: _cancel,
        );
        final proof = response.data!;
        key = proof['identityPublicKey'] as String;
        final issued = proof['issuedAt'] as int;
        final expires = proof['expiresAt'] as int;
        final instant = now().millisecondsSinceEpoch;
        if (proof['version'] != 1 ||
            proof['nonce'] != nonce ||
            proof['origin'] != context.origin.origin ||
            expires <= issued ||
            expires - issued > 15000 ||
            issued > instant + 5000 ||
            expires < instant) {
          throw const BrokerRouteException('IDENTITY_PROOF_INVALID');
        }
        if (expectedIdentity != null && key != expectedIdentity) {
          throw const BrokerRouteException('SERVER_IDENTITY_CHANGED');
        }
        final valid = await PairingCrypto.verifyIdentitySignature(
          publicKey: key,
          message: utf8.encode(
            jsonEncode([
              'cosyncing/server-routes-v1',
              nonce,
              context.origin.origin,
              key,
              issued,
              expires,
            ]),
          ),
          signature: proof['signature'] as String,
        );
        if (!valid) throw const BrokerRouteException('IDENTITY_PROOF_INVALID');
        if (expectedIdentity == null) throw BrokerRouteTrustRequired(key);
      }
      if (_cancel.isCancelled) {
        throw const BrokerRouteException('CONNECTION_CANCELED');
      }
      // No broker credential is attached before the fresh origin-bound proof.
      final authenticatedOptions = Options(headers: credentials.authHeaders);
      String? observedPrincipal;
      int? observedAuthorization;
      Future<Map<String, dynamic>> check() async {
        final began = elapsed();
        final result = (await client.get<Map<String, dynamic>>(
          '${context.origin}/api/connection/check',
          options: authenticatedOptions,
          cancelToken: _cancel,
        )).data!;
        samples.add((elapsed() - began).inMicroseconds / 1000);
        if (result['identityPublicKey'] != key ||
            result['capability'] != 'server-routes-v1') {
          throw const BrokerRouteException('SERVER_IDENTITY_CHANGED');
        }
        if (expectedPrincipal != null &&
            result['principalId'] != expectedPrincipal) {
          throw const BrokerRouteException('PRINCIPAL_CHANGED');
        }
        final principal = result['principalId'] as String;
        final authorization = result['authGeneration'] as int;
        if ((observedPrincipal != null && principal != observedPrincipal) ||
            (observedAuthorization != null &&
                authorization != observedAuthorization)) {
          throw const BrokerRouteException('AUTHORIZATION_CHANGED');
        }
        observedPrincipal = principal;
        observedAuthorization = authorization;
        final contract = BrokerContractIdentity.fromJson(
          result['contract'] as Map<String, dynamic>,
        );
        if (!updatePairIsUsable(
          const ClientContractIdentity(
            revision: cosyncingClientContractRevision,
            minimumBrokerRevision: cosyncingClientMinimumBrokerRevision,
            surfaceHash: cosyncingClientContractSurfaceHash,
          ),
          contract,
        )) {
          throw const BrokerRouteException('BROKER_INCOMPATIBLE');
        }
        return result;
      }

      final authenticated = await check();
      final principal = authenticated['principalId'] as String;
      final authorization = authenticated['authGeneration'] as int;
      if (reuse &&
          (principal != cached.principalId ||
              authorization != cached.authGeneration)) {
        throw const BrokerRouteException('AUTHORIZATION_CHANGED');
      }
      if (!reuse) {
        final ticket = (await client.post<Map<String, dynamic>>(
          '${context.origin}/api/ws-auth-tickets',
          options: authenticatedOptions,
          data: {
            'audience': 'connection-check',
            'params': {
              'clientVersion': cosyncingClientVersion,
              'contractRevision': '$cosyncingClientContractRevision',
              'minimumBrokerRevision': '$cosyncingClientMinimumBrokerRevision',
              'contractSurfaceHash': cosyncingClientContractSurfaceHash,
            },
          },
          cancelToken: _cancel,
        )).data!;
        final socket = _socket = transport.socket(
          context.origin
              .replace(
                scheme: context.origin.scheme == 'https' ? 'wss' : 'ws',
                path: '/api/connection/check/ws',
                queryParameters: {
                  'wsAuthTicket': ticket['wsAuthTicket'] as String,
                },
              )
              .toString(),
        );
        final first = socket.messages.first;
        // Observe errors immediately even when connect fails before awaiting
        // the frame, avoiding an unhandled error from a canceled handshake.
        unawaited(
          first.then<void>((_) {}, onError: (Object _, StackTrace _) {}),
        );
        try {
          await socket.connect();
          final hello = await first;
          if (hello is! Map ||
              hello['kind'] != 'connection-check' ||
              hello['identityPublicKey'] != key ||
              hello['principalId'] != principal ||
              hello['authGeneration'] != authorization ||
              (hello['compatibility'] as Map?)?['status'] ==
                  'hard-incompatible') {
            throw const BrokerRouteException('WEBSOCKET_NOT_READY');
          }
          await socket.close();
        } on BrokerRouteException {
          rethrow;
        } on Object {
          throw const BrokerRouteException('WEBSOCKET_NOT_READY');
        }
        _socket = null;
      }
      final handshake = (elapsed() - started).inMicroseconds / 1000;
      BrokerRouteObservation observation() => BrokerRouteObservation(
        context: context,
        identityPublicKey: key,
        principalId: principal,
        authGeneration: authorization,
        checkedAt: now(),
        samples: samples,
        handshakeMilliseconds: handshake,
      );
      if (_cancel.isCancelled) {
        throw const BrokerRouteException('CONNECTION_CANCELED');
      }
      onReady?.call(observation());
      // Readiness is already usable; a slow third sample cannot delay attach.
      for (var index = 1; index < 3; index++) {
        try {
          await check();
        } on DioException catch (error) {
          if (error.response?.statusCode == 401 ||
              error.response?.statusCode == 403) {
            rethrow;
          }
          if (_cancel.isCancelled) break;
        }
      }
      return observation();
    } finally {
      deadline.cancel();
      _client = null;
      if (_socket case final socket?) await socket.close();
    }
  }
}
