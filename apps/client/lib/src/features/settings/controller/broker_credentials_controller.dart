import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_mutation_gate.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

const String _credentialKeyPrefix = 'broker-token:';

/// What just happened to the stored broker credential.
///
/// The controller reports an outcome, not a sentence. Wording lives in the ARB
/// files and is resolved by the view (see `brokerCredentialNoticeText`),
/// because these outcomes surface on the connection gate — the first screen a
/// new user sees, and the one surface in the app that is fully translated. A
/// controller that returned English strings could never be translated there.
enum BrokerCredentialNotice {
  /// A token was stored successfully.
  tokenSaved,

  /// A stored token was deleted.
  tokenRemoved,

  /// Sign-out removed the stored credential.
  signedOut,

  /// A clear was requested with no token stored.
  noTokenStored,

  /// A credential action ran with no active broker profile.
  noActiveProfile,

  /// Sign-out ran with no active broker profile.
  noProfileActive,

  /// Sign-out ran with nothing stored to remove.
  noCredentialStored,

  /// The submitted token was blank.
  tokenEmpty,

  /// Storing the token failed.
  saveFailed,

  /// Deleting the token failed.
  removeFailed,

  /// Signing out failed.
  signOutFailed;

  /// Whether this outcome should be presented as an error.
  bool get isFailure =>
      this == saveFailed ||
      this == removeFailed ||
      this == signOutFailed ||
      this == noActiveProfile ||
      this == tokenEmpty;
}

/// Runtime state for manual broker token controls in settings and on the gate.
class BrokerCredentialsState {
  /// Creates a [BrokerCredentialsState].
  const BrokerCredentialsState({
    this.isBusy = false,
    this.notice,
    this.failureKind,
    this.detail,
    this.savedTokenThisSession = false,
  });

  /// Whether save/clear is in progress.
  final bool isBusy;

  /// The outcome of the last credential action, if any.
  final BrokerCredentialNotice? notice;

  /// How the failure reached us. Set only when [notice] is a failure that
  /// wrapped a caught exception; drives which recovery advice is shown.
  final FailureKind? failureKind;

  /// Raw, untranslated diagnostic for a "Technical details" disclosure.
  ///
  /// Never concatenated into the message a user reads.
  final String? detail;

  /// Whether a token was successfully stored during this app session.
  ///
  /// Lets the gate tell "the token you just typed was refused" apart from "the
  /// credential that used to work stopped working". Those need different copy:
  /// on a brand-new device the second framing claims access that never existed.
  final bool savedTokenThisSession;

  /// Whether the last outcome was a failure.
  bool get hasError => notice?.isFailure ?? false;

  /// Returns a copy with optional overrides.
  BrokerCredentialsState copyWith({
    bool? isBusy,
    Object? notice = _copySentinel,
    Object? failureKind = _copySentinel,
    Object? detail = _copySentinel,
    bool? savedTokenThisSession,
  }) {
    return BrokerCredentialsState(
      isBusy: isBusy ?? this.isBusy,
      notice: notice == _copySentinel
          ? this.notice
          : notice as BrokerCredentialNotice?,
      failureKind: failureKind == _copySentinel
          ? this.failureKind
          : failureKind as FailureKind?,
      detail: detail == _copySentinel ? this.detail : detail as String?,
      savedTokenThisSession:
          savedTokenThisSession ?? this.savedTokenThisSession,
    );
  }
}

const Object _copySentinel = Object();

/// Handles manual token save and clear flows for the active remote broker
/// profile.
///
/// References:
/// - `docs/architecture/client-ui.md`
final brokerCredentialsControllerProvider =
    NotifierProvider<BrokerCredentialsController, BrokerCredentialsState>(
      BrokerCredentialsController.new,
    );

/// Riverpod notifier for settings credential state.
final class BrokerCredentialsController
    extends Notifier<BrokerCredentialsState> {
  @override
  BrokerCredentialsState build() {
    return const BrokerCredentialsState();
  }

  CredentialStore get _credentialStore => ref.read(credentialStoreProvider);

  BrokerProfileRepository get _brokerProfileRepository =>
      ref.read(brokerProfileRepositoryProvider);

  BrokerProfileMutationGate get _profileMutationGate =>
      ref.read(brokerProfileMutationGateProvider);

  /// Saves a token for the active non-loopback profile.
  ///
  /// Blank/whitespace values are rejected and are not persisted.
  Future<void> saveToken(String rawToken) async {
    final activeProfile = ref.read(activeBrokerProfileProvider);
    if (activeProfile == null) {
      state = state.copyWith(
        notice: BrokerCredentialNotice.noActiveProfile,
        failureKind: null,
        detail: null,
      );
      return;
    }

    // NB: no loopback exemption. A loopback broker may still require a token —
    // the broker stops answering anonymously the moment an owner token is
    // provisioned, and it enforces that on 127.0.0.1 exactly as it does
    // anywhere else. Refusing to persist a token here left the app unable to
    // authenticate against its own local broker, while the PoC UI, which makes
    // no such assumption, worked with the identical token. Only the broker can
    // say whether a credential is required; the client must never infer that
    // from a hostname.
    final token = rawToken.trim();
    if (token.isEmpty) {
      state = state.copyWith(
        notice: BrokerCredentialNotice.tokenEmpty,
        failureKind: null,
        detail: null,
      );
      return;
    }

    final savedBefore = state.savedTokenThisSession;
    state = BrokerCredentialsState(
      isBusy: true,
      savedTokenThisSession: savedBefore,
    );
    try {
      await _profileMutationGate.runForProfile(activeProfile, (current) async {
        _requireActiveIncarnation(activeProfile);
        final credentialKey = _credentialKeyForProfile(current.id);
        final previousCredentialKey = current.credentialKey;
        final previousToken = await _credentialStore.readBrokerToken(
          credentialKey,
        );
        var wroteToken = false;
        try {
          await _credentialStore.writeBrokerToken(credentialKey, token);
          wroteToken = true;

          final updatedProfile = current.copyWith(
            credentialKey: credentialKey,
            updatedAt: DateTime.now(),
          );
          final saved = await _brokerProfileRepository.save(updatedProfile);
          _requireActiveIncarnation(activeProfile);
          ref.read(activeBrokerProfileProvider.notifier).state = saved;

          if (previousCredentialKey != null &&
              previousCredentialKey != credentialKey) {
            try {
              await _credentialStore.deleteBrokerToken(previousCredentialKey);
            } on Object {
              // The current row already points to the new credential. Failure
              // to remove an obsolete key must not roll that committed change
              // back or expose it to a replacement incarnation.
            }
          }
        } on Object {
          if (wroteToken) {
            await _restoreToken(credentialKey, previousToken);
          }
          rethrow;
        }
      });

      state = const BrokerCredentialsState(
        notice: BrokerCredentialNotice.tokenSaved,
        savedTokenThisSession: true,
      );
    } on Object catch (error) {
      // The raw exception goes to `detail`, never into the message. This state
      // renders on the connection gate, which already has a collapsed
      // "Technical details" disclosure for exactly this.
      state = state.copyWith(
        isBusy: false,
        notice: BrokerCredentialNotice.saveFailed,
        failureKind: classifyFailure(error),
        detail: failureDetail(error),
      );
    }
  }

  /// Deletes the active token and clears the profile credential key reference.
  Future<void> clearToken() async {
    final activeProfile = ref.read(activeBrokerProfileProvider);
    if (activeProfile == null) {
      state = state.copyWith(
        notice: BrokerCredentialNotice.noActiveProfile,
        failureKind: null,
        detail: null,
      );
      return;
    }

    state = const BrokerCredentialsState(isBusy: true);
    try {
      final removed = await _clearCredentialForActive(activeProfile);
      state = BrokerCredentialsState(
        notice: removed
            ? BrokerCredentialNotice.tokenRemoved
            : BrokerCredentialNotice.noTokenStored,
      );
    } on Object catch (error) {
      state = state.copyWith(
        isBusy: false,
        notice: BrokerCredentialNotice.removeFailed,
        failureKind: classifyFailure(error),
        detail: failureDetail(error),
      );
    }
  }

  /// Clears the stored broker credential for the active profile.
  ///
  /// This is the user-initiated escape hatch behind the Settings sign-out
  /// control. Unlike [clearToken] it is unconditional: it also applies to
  /// loopback profiles and to peer credentials issued by pairing, because the
  /// user asked to sign out of whatever is currently stored.
  ///
  /// Retention is otherwise unchanged by design — credentials persist until
  /// this is invoked. See `docs/architecture/client-ui.md`.
  Future<void> signOut() async {
    final activeProfile = ref.read(activeBrokerProfileProvider);
    if (activeProfile == null) {
      state = const BrokerCredentialsState(
        notice: BrokerCredentialNotice.noProfileActive,
      );
      return;
    }

    state = const BrokerCredentialsState(isBusy: true);
    try {
      final removed = await _clearCredentialForActive(activeProfile);
      state = BrokerCredentialsState(
        notice: removed
            ? BrokerCredentialNotice.signedOut
            : BrokerCredentialNotice.noCredentialStored,
      );
    } on Object catch (error) {
      state = state.copyWith(
        isBusy: false,
        notice: BrokerCredentialNotice.signOutFailed,
        failureKind: classifyFailure(error),
        detail: failureDetail(error),
      );
    }
  }

  String _credentialKeyForProfile(String profileId) =>
      '$_credentialKeyPrefix$profileId';

  Future<bool> _clearCredentialForActive(BrokerProfile expectedActive) {
    return _profileMutationGate.runForProfile(expectedActive, (current) async {
      _requireActiveIncarnation(expectedActive);
      final credentialKey = current.credentialKey;
      if (credentialKey == null) return false;

      final previousToken = await _credentialStore.readBrokerToken(
        credentialKey,
      );
      var deletedToken = false;
      try {
        await _credentialStore.deleteBrokerToken(credentialKey);
        deletedToken = true;

        final updatedProfile = current.copyWith(
          clearCredentialKey: true,
          updatedAt: DateTime.now(),
        );
        final saved = await _brokerProfileRepository.save(updatedProfile);
        _requireActiveIncarnation(expectedActive);
        ref.read(activeBrokerProfileProvider.notifier).state = saved;
        return true;
      } on Object {
        if (deletedToken) {
          await _restoreToken(credentialKey, previousToken);
        }
        rethrow;
      }
    });
  }

  void _requireActiveIncarnation(BrokerProfile expected) {
    final active = ref.read(activeBrokerProfileProvider);
    final sameIncarnation =
        active?.id == expected.id &&
        active?.incarnationId == expected.incarnationId;
    if (!sameIncarnation) {
      throw BrokerProfileRetiredException(expected.id);
    }
  }

  Future<void> _restoreToken(String credentialKey, String? previousToken) {
    if (previousToken == null) {
      return _credentialStore.deleteBrokerToken(credentialKey);
    }
    return _credentialStore.writeBrokerToken(credentialKey, previousToken);
  }
}
