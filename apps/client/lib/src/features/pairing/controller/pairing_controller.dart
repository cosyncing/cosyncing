import 'dart:math';
import 'dart:typed_data';

import 'package:broker_contract/broker_contract.dart';
import 'package:broker_crypto/broker_crypto.dart' as crypto;
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_mutation_gate.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_credential.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/url_normalizer.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/data/active_broker_profile_store.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/pairing/data/transport_pairing_accept_service.dart';
import 'package:cosyncing_client/src/features/pairing/data/transport_pairing_store.dart';
import 'package:cosyncing_client/src/features/pairing/model/pairing_payload.dart';
import 'package:cosyncing_client/src/features/pairing/model/transport_qr_payload.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Runtime state for pairing payload import actions.
class PairingControllerState {
  /// Creates [PairingControllerState].
  PairingControllerState({
    this.isBusy = false,
    this.notice,
    String? technicalDetail,
  }) : technicalDetail = boundedTechnicalDetail(technicalDetail);

  /// Whether an import operation is active.
  final bool isBusy;

  /// Typed outcome. The view translates it at render time.
  final PairingNotice? notice;

  /// Bounded raw diagnostic for an explicit technical-details disclosure.
  final String? technicalDetail;

  /// Whether [notice] represents a failed operation.
  bool get hasError => notice?.isError ?? false;

  /// Returns a copy with optional overrides.
  PairingControllerState copyWith({
    bool? isBusy,
    Object? notice = _pairingSentinel,
    Object? technicalDetail = _pairingSentinel,
  }) {
    return PairingControllerState(
      isBusy: isBusy ?? this.isBusy,
      notice: notice == _pairingSentinel
          ? this.notice
          : notice as PairingNotice?,
      technicalDetail: technicalDetail == _pairingSentinel
          ? this.technicalDetail
          : technicalDetail as String?,
    );
  }
}

const Object _pairingSentinel = Object();

/// Locale-free pairing outcomes retained by the controller.
enum PairingNotice {
  /// No pairing text was provided.
  emptyInput,

  /// The provided pairing text could not be decoded.
  invalidInput,

  /// The scanned QR code does not contain pairing data.
  invalidQr,

  /// A URL-free pairing code needs a client-reachable Broker URL.
  brokerUrlRequired,

  /// The separately supplied Broker URL is invalid.
  brokerUrlInvalid,

  /// The pairing code uses an unsupported legacy format.
  oldQr,

  /// The Broker token could not be stored.
  tokenSaveFailed,

  /// The Broker profile could not be stored.
  profileSaveFailed,

  /// The stored Broker profile could not be activated.
  profileActivationFailed,

  /// A Broker profile was paired.
  paired,

  /// A device was paired.
  devicePaired,

  /// The paired device could not be activated.
  deviceActivationFailed,

  /// Secure storage could not be unlocked.
  unlockFailed,

  /// The Broker rejected the pairing request.
  rejected,

  /// The pairing request no longer exists.
  notFound,

  /// The pairing request expired.
  expired,

  /// The pairing request was already used.
  alreadyUsed,

  /// Too many pairing attempts were made.
  rateLimited,

  /// Pairing failed for an unclassified reason.
  failed;

  /// Whether this outcome should use error presentation.
  bool get isError => this != paired && this != devicePaired;
}

/// Controller for pairing payload import flows.
///
/// See `docs/architecture/client-ui.md`.
final pairingControllerProvider =
    NotifierProvider<PairingController, PairingControllerState>(
      PairingController.new,
    );

/// Handles parsing/saving of QR/pairing payloads.
class PairingController extends Notifier<PairingControllerState> {
  @override
  PairingControllerState build() {
    return PairingControllerState();
  }

  BrokerProfileRepository get _repository =>
      ref.read(brokerProfileRepositoryProvider);

  CredentialStore get _credentialStore => ref.read(credentialStoreProvider);

  BrokerProfileMutationGate get _profileMutationGate =>
      ref.read(brokerProfileMutationGateProvider);

  ActiveBrokerProfileStore get _activeStore =>
      ref.read(activeBrokerProfileStoreProvider);

  TransportPairingAcceptService get _transportPairingAcceptService =>
      ref.read(transportPairingAcceptServiceProvider);

  TransportPairingStore get _transportPairingStore =>
      ref.read(transportPairingStoreProvider);

  /// Parses and persists a pairing payload.
  Future<void> importPayload(String rawPayload, {String? brokerUrl}) async {
    final trimmedInput = rawPayload.trim();
    if (trimmedInput.isEmpty) {
      state = PairingControllerState(notice: PairingNotice.emptyInput);
      return;
    }

    final transportQr = _tryParseTransportQr(trimmedInput);
    if (transportQr != null) {
      final effectiveBrokerUrl =
          transportQr.transportUrl ?? _parsePairingBrokerUrl(brokerUrl);
      if (effectiveBrokerUrl == null) {
        state = PairingControllerState(
          notice: brokerUrl == null || brokerUrl.trim().isEmpty
              ? PairingNotice.brokerUrlRequired
              : PairingNotice.brokerUrlInvalid,
        );
        return;
      }
      await _acceptTransportQr(transportQr, effectiveBrokerUrl);
      return;
    }

    if (_looksLikeTransportQr(trimmedInput)) {
      state = PairingControllerState(notice: PairingNotice.invalidQr);
      return;
    }

    await _importLegacyPayload(trimmedInput);
  }

  Future<void> _importLegacyPayload(String trimmedInput) async {
    final PairingPayload payload;
    try {
      payload = PairingPayload.parse(trimmedInput);
    } on PairingPayloadParseException {
      state = PairingControllerState(notice: PairingNotice.invalidInput);
      return;
    }

    ref
        .read(connectionControllerProvider.notifier)
        .supersedePendingConnection();
    state = PairingControllerState(isBusy: true);

    final profileId = payload.brokerUrl.toString();
    await _profileMutationGate.runForCurrent(profileId, (
      previousProfile,
    ) async {
      final previousCredentialKey = previousProfile?.credentialKey;
      final now = DateTime.now();

      final desiredDisplayName =
          payload.displayName?.trim() ??
          previousProfile?.displayName ??
          payload.brokerUrl.host;

      final willPersistToken = payload.hasToken;
      var credentialKey = previousProfile?.credentialKey;
      String? previousToken;
      var previousTokenWasRead = false;

      if (willPersistToken) {
        credentialKey = brokerSharedTokenCredentialKey(profileId);
        try {
          if (previousCredentialKey == credentialKey) {
            previousToken = await _credentialStore.readBrokerToken(
              credentialKey,
            );
            previousTokenWasRead = true;
          }
          await _credentialStore.writeBrokerToken(
            credentialKey,
            payload.token!.trim(),
          );
        } on Object catch (error) {
          state = PairingControllerState(
            notice: PairingNotice.tokenSaveFailed,
            technicalDetail: failureDetail(error),
          );
          return;
        }
      }

      final mergedProfile = BrokerProfile(
        id: profileId,
        displayName: desiredDisplayName,
        baseUri: payload.brokerUrl,
        createdAt: previousProfile?.createdAt ?? now,
        incarnationId: previousProfile?.incarnationId,
        updatedAt: now,
        lastUsedAt: previousProfile?.lastUsedAt,
        credentialKey: credentialKey,
      );

      late final BrokerProfile savedProfile;
      try {
        savedProfile = await _repository.save(mergedProfile);
        ref.invalidate(brokerProfileListProvider);
      } on Object catch (error) {
        await _rollbackTokenWrite(
          wroteToken: willPersistToken,
          credentialKey: credentialKey,
          previousCredentialKey: previousCredentialKey,
          previousToken: previousToken,
          previousTokenWasRead: previousTokenWasRead,
        );
        state = PairingControllerState(
          notice: PairingNotice.profileSaveFailed,
          technicalDetail: failureDetail(error),
        );
        return;
      }

      try {
        await _activeStore.setActiveProfileId(savedProfile.id);
      } on Object {
        state = PairingControllerState(
          notice: PairingNotice.profileActivationFailed,
        );
        return;
      }

      ref.read(activeBrokerProfileProvider.notifier).state = savedProfile;
      state = PairingControllerState(notice: PairingNotice.paired);
    });
  }

  Future<void> _acceptTransportQr(
    TransportQrPayload payload,
    Uri brokerUrl,
  ) async {
    if (!payload.canAccept) {
      state = PairingControllerState(notice: PairingNotice.oldQr);
      return;
    }

    ref
        .read(connectionControllerProvider.notifier)
        .supersedePendingConnection();
    state = PairingControllerState(isBusy: true);

    try {
      final identity = await crypto.PairingCrypto.generateIdentityKeyPair();
      final exchange = await crypto.PairingCrypto.generateExchangeKeyPair();
      final localPeerId = _newPeerId();
      final localPeerToken = _newPeerToken();

      final accepted = await _transportPairingAcceptService.accept(
        payload,
        brokerUrl: brokerUrl,
        peerId: localPeerId,
        peerToken: localPeerToken,
        identityPublicKey: identity.publicKey,
        exchangePublicKey: exchange.publicKey,
      );

      final pairingId = payload.pairingId;
      final brokerPeerToken = accepted.broker.peerToken?.trim() ?? '';
      if (pairingId == null ||
          pairingId.isEmpty ||
          accepted.broker.peerId != payload.brokerId ||
          brokerPeerToken.isEmpty) {
        throw const crypto.PairingCryptoException(
          'Pairing acceptance is not bound to the scanned broker.',
        );
      }

      final wrappedDataKey = crypto.WrappedDataKey(
        version: accepted.wrappedDataKey.version,
        algorithm: accepted.wrappedDataKey.algorithm,
        ephemeralPublicKey: accepted.wrappedDataKey.ephemeralPublicKey,
        nonce: accepted.wrappedDataKey.nonce,
        ciphertext: accepted.wrappedDataKey.ciphertext,
        tag: accepted.wrappedDataKey.tag,
      );
      if (payload.version == 3) {
        if (accepted.broker.identityPublicKey != payload.publicKey ||
            accepted.brokerProof.version != 1 ||
            accepted.brokerProof.algorithm != 'Ed25519') {
          throw const crypto.PairingCryptoException(
            'Pairing acceptance identity does not match the scanned broker.',
          );
        }
        final proofValid = await crypto.PairingCrypto.verifyIdentitySignature(
          publicKey: payload.publicKey,
          message: crypto.PairingCrypto.pairingAcceptanceProofBytes(
            pairingId: pairingId,
            clientPeerId: localPeerId,
            clientIdentityPublicKey: identity.publicKey,
            clientExchangePublicKey: exchange.publicKey,
            brokerPeerId: accepted.broker.peerId,
            brokerPeerToken: brokerPeerToken,
            brokerIdentityPublicKey: accepted.broker.identityPublicKey,
            wrappedDataKey: wrappedDataKey,
          ),
          signature: accepted.brokerProof.signature,
        );
        if (!proofValid) {
          throw const crypto.PairingCryptoException(
            'Pairing acceptance signature is invalid.',
          );
        }
      }

      final unwrappedDataKey = await crypto.PairingCrypto.unwrapDataKey(
        wrappedDataKey,
        recipientPrivateKey: exchange.privateKey,
      );

      final credentialsId = _transportCredentialId(
        brokerId: payload.brokerId,
        localPeerId: localPeerId,
      );
      final now = DateTime.now();
      final credentials = TransportPairingCredentials(
        id: credentialsId,
        brokerId: payload.brokerId,
        brokerUrl: brokerUrl,
        localPeerId: localPeerId,
        localPeerToken: localPeerToken,
        identityPublicKey: identity.publicKey,
        identityPrivateKey: identity.privateKey,
        exchangePublicKey: exchange.publicKey,
        exchangePrivateKey: exchange.privateKey,
        brokerPeerId: accepted.broker.peerId,
        brokerPeerToken: brokerPeerToken,
        brokerIdentityPublicKey: accepted.broker.identityPublicKey,
        dataKey: crypto.base64UrlNoPadding(unwrappedDataKey),
        createdAt: now,
      );
      final adopted = await _adoptTransportPairing(
        payload: payload,
        brokerUrl: brokerUrl,
        credentials: credentials,
        brokerPeerToken: brokerPeerToken,
        now: now,
      );
      if (!adopted) return;

      state = PairingControllerState(notice: PairingNotice.devicePaired);
    } on BrokerException catch (error) {
      state = PairingControllerState(
        notice: _transportPairingNotice(error.error?.code),
        technicalDetail: failureDetail(error),
      );
    } on crypto.PairingCryptoException {
      state = PairingControllerState(notice: PairingNotice.unlockFailed);
    } on Object catch (error) {
      state = PairingControllerState(
        notice: PairingNotice.failed,
        technicalDetail: failureDetail(error),
      );
    }
  }

  Future<bool> _adoptTransportPairing({
    required TransportQrPayload payload,
    required Uri brokerUrl,
    required TransportPairingCredentials credentials,
    required String brokerPeerToken,
    required DateTime now,
  }) async {
    final profileBaseUri = brokerBaseFromOrigin(brokerUrl);
    final profileId = profileBaseUri.toString();
    final credentialKey = brokerPeerTokenCredentialKey(profileId);
    return _profileMutationGate.runForCurrent(profileId, (
      previousProfile,
    ) async {
      final previousCredentialKey = previousProfile?.credentialKey;
      final previousPeerToken = await _credentialStore.readBrokerToken(
        credentialKey,
      );
      final previousTransportCredentials = await _transportPairingStore.read(
        credentials.id,
      );

      var wroteTransportCredentials = false;
      var wrotePeerToken = false;
      try {
        await _transportPairingStore.write(credentials);
        wroteTransportCredentials = true;
        await _credentialStore.writeBrokerToken(credentialKey, brokerPeerToken);
        wrotePeerToken = true;

        final brokerLabel = payload.brokerId.trim();
        final profile = BrokerProfile(
          id: profileId,
          displayName:
              previousProfile?.displayName ??
              (brokerLabel.isEmpty ? brokerUrl.host : brokerLabel),
          baseUri: profileBaseUri,
          createdAt: previousProfile?.createdAt ?? now,
          incarnationId: previousProfile?.incarnationId,
          updatedAt: now,
          lastUsedAt: now,
          credentialKey: credentialKey,
        );
        final savedProfile = await _repository.save(profile);
        ref.invalidate(brokerProfileListProvider);

        try {
          await _activeStore.setActiveProfileId(savedProfile.id);
        } on Object {
          state = PairingControllerState(
            notice: PairingNotice.deviceActivationFailed,
          );
          return false;
        }

        ref.read(activeBrokerProfileProvider.notifier).state = savedProfile;

        if (previousCredentialKey != null &&
            previousCredentialKey != credentialKey) {
          try {
            await _credentialStore.deleteBrokerToken(previousCredentialKey);
          } on Object {
            // The new revocable credential is already authoritative. Failure
            // to remove an obsolete local secret must not undo a usable
            // pairing.
          }
        }
        return true;
      } on Object {
        if (wrotePeerToken) {
          try {
            if (previousPeerToken == null) {
              await _credentialStore.deleteBrokerToken(credentialKey);
            } else {
              await _credentialStore.writeBrokerToken(
                credentialKey,
                previousPeerToken,
              );
            }
          } on Object {
            // Preserve the primary pairing failure.
          }
        }
        if (wroteTransportCredentials) {
          try {
            if (previousTransportCredentials == null) {
              await _transportPairingStore.delete(credentials.id);
            } else {
              await _transportPairingStore.write(previousTransportCredentials);
            }
          } on Object {
            // Preserve the primary pairing failure.
          }
        }
        rethrow;
      }
    });
  }

  Future<void> _rollbackTokenWrite({
    required bool wroteToken,
    required String? credentialKey,
    required String? previousCredentialKey,
    required String? previousToken,
    required bool previousTokenWasRead,
  }) async {
    if (!wroteToken || credentialKey == null) {
      return;
    }

    try {
      if (previousCredentialKey == credentialKey && previousTokenWasRead) {
        if (previousToken == null) {
          await _credentialStore.deleteBrokerToken(credentialKey);
        } else {
          await _credentialStore.writeBrokerToken(credentialKey, previousToken);
        }
        return;
      }

      await _credentialStore.deleteBrokerToken(credentialKey);
    } on Object {
      // Best-effort cleanup only. Surface the original import failure instead.
    }
  }
}

Uri? _parsePairingBrokerUrl(String? input) {
  if (input == null || input.trim().isEmpty) return null;
  try {
    final normalized = normalizeBrokerUrl(input);
    return validateBrokerUrl(normalized).isEmpty ? normalized : null;
  } on FormatException {
    return null;
  }
}

TransportQrPayload? _tryParseTransportQr(String input) {
  if (!_looksLikeTransportQr(input)) return null;
  try {
    return TransportQrPayload.parse(input);
  } on Object {
    return null;
  }
}

bool _looksLikeTransportQr(String input) {
  final uri = Uri.tryParse(input.trim());
  return uri != null && uri.scheme == 'cosyncing' && uri.host == 'pair';
}

PairingNotice _transportPairingNotice(String? code) {
  return switch (code) {
    'PAIRING_NOT_FOUND' => PairingNotice.notFound,
    'PAIRING_EXPIRED' => PairingNotice.expired,
    'PAIRING_ALREADY_ACCEPTED' => PairingNotice.alreadyUsed,
    'PAIRING_INVALID_INPUT' => PairingNotice.rejected,
    'PAIRING_RATE_LIMITED' => PairingNotice.rateLimited,
    _ => PairingNotice.failed,
  };
}

String _transportCredentialId({
  required String brokerId,
  required String localPeerId,
}) {
  return '$brokerId:$localPeerId';
}

String _newPeerId() => 'client-${_randomBase64Url(16)}';

String _newPeerToken() => _randomBase64Url(32);

String _randomBase64Url(int bytes) {
  final random = Random.secure();
  return crypto.base64UrlNoPadding(
    Uint8List.fromList(List<int>.generate(bytes, (_) => random.nextInt(256))),
  );
}
