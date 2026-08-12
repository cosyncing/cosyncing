import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_local_data_purge.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_mutation_gate.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/broker_profile_repository.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/url_normalizer.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/data/active_broker_profile_store.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/data/created_session_attach_intents.dart';
import 'package:cosyncing_client/src/features/sessions/data/roster_snapshot_store.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_draft_store.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Controller for Broker Profile management operations.
///
/// See `docs/architecture/client-ui.md` for the behavior
/// this controller supports from the profile-management screen.
final brokerProfileManagerControllerProvider =
    Provider<BrokerProfileManagerController>((ref) {
      return BrokerProfileManagerController(ref);
    });

/// Expected failure from broker profile manager operations.
///
/// [message] is user-facing product copy and must stay free of exception text
/// and internal identifiers — note that profile ids are broker base URLs, so
/// interpolating one shows the user a URL as if it named the thing that broke.
/// Raw diagnostics belong in [detail], which views surface behind a
/// "Technical details" disclosure rather than in the reading path.
class BrokerProfileManagerException implements Exception {
  /// Creates an expected profile-manager failure with a user-facing [message].
  const BrokerProfileManagerException(this.message, {this.detail});

  /// Human-readable failure message.
  final String message;

  /// Raw, untranslated diagnostic for support. Never shown by default.
  final String? detail;

  @override
  String toString() => message;
}

/// Handles profile selection, edits, and deletion without broker probing.
///
/// Keeps all side effects in the provider layer:
/// - `activeBrokerProfileProvider` updates active profile in-memory state.
/// - `activeBrokerProfileStoreProvider` updates persisted active profile id.
/// - `BrokerProfileRepository` updates durable profile rows.
///
/// See `docs/architecture/client-ui.md` for user-visible
/// effects and edge cases.
class BrokerProfileManagerController {
  /// Creates a controller with [ref].
  BrokerProfileManagerController(this.ref);

  /// Provider reference used for app state and dependency access.
  final Ref ref;

  BrokerProfileRepository get _repository =>
      ref.read(brokerProfileRepositoryProvider);
  CredentialStore get _credentialStore => ref.read(credentialStoreProvider);
  BrokerProfileMutationGate get _mutationGate =>
      ref.read(brokerProfileMutationGateProvider);

  /// Sets [profileId] as active without probing broker connectivity.
  ///
  /// Throws [BrokerProfileManagerException] if the profile id cannot be
  /// loaded.
  Future<void> setActiveProfile(
    String profileId, {
    BrokerProfile? expectedProfile,
  }) async {
    // Selecting a saved server is a newer user intent than any direct-connect
    // health probe still in flight on the retained Connection screen.
    ref
        .read(connectionControllerProvider.notifier)
        .supersedePendingConnection();

    Future<void> select(BrokerProfile? profile) async {
      if (profile == null) {
        throw const BrokerProfileManagerException(
          "Couldn't switch servers — that server is no longer saved on this "
          'device. Pick another server, or add it again.',
        );
      }
      await ref
          .read(activeBrokerProfileStoreProvider)
          .setActiveProfileId(profile.id);
      ref.read(activeBrokerProfileProvider.notifier).state = profile;
    }

    try {
      if (expectedProfile == null) {
        await _mutationGate.runForCurrent(profileId, select);
      } else {
        await _mutationGate.runForProfile(
          expectedProfile,
          select,
        );
      }
    } on BrokerProfileRetiredException {
      throw const BrokerProfileManagerException(
        "Couldn't switch servers — that saved server was replaced while the "
        'selection was pending. Select the current server and try again.',
      );
    }
  }

  /// Updates a profile's display name and base URL while preserving id/metadata.
  ///
  /// Preserves:
  /// - `id`
  /// - `createdAt`
  /// - `lastUsedAt`
  /// - `credentialKey` only when `baseUri` is unchanged
  ///
  /// Throws:
  /// - [FormatException] for unparseable URLs from [normalizeBrokerUrl]
  /// - [BrokerProfileManagerException] for missing profile rows, empty display
  ///   names, or validation failures
  Future<BrokerProfile> saveProfileEdits({
    required String profileId,
    required String displayName,
    required String baseUri,
    BrokerProfile? expectedProfile,
  }) async {
    final trimmedDisplayName = displayName.trim();
    if (trimmedDisplayName.isEmpty) {
      throw const BrokerProfileManagerException(
        'Display name cannot be empty.',
      );
    }

    final normalized = normalizeBrokerUrl(baseUri);
    final validationErrors = validateBrokerUrl(normalized);
    if (validationErrors.isNotEmpty) {
      throw BrokerProfileManagerException(validationErrors.join('; '));
    }

    Future<BrokerProfile> save(BrokerProfile? existing) async {
      if (existing == null) {
        throw const BrokerProfileManagerException(
          "Couldn't save these changes — that server is no longer saved on "
          'this device. It may have been deleted on another screen.',
        );
      }
      return _saveProfileEditsLocked(
        existing: existing,
        trimmedDisplayName: trimmedDisplayName,
        normalized: normalized,
      );
    }

    try {
      if (expectedProfile == null) {
        return await _mutationGate.runForCurrent(profileId, save);
      }
      return await _mutationGate.runForProfile(
        expectedProfile,
        save,
      );
    } on BrokerProfileRetiredException {
      throw const BrokerProfileManagerException(
        "Couldn't save these changes — that saved server was replaced while "
        'the edit was pending. Reopen the current server and try again.',
      );
    }
  }

  Future<BrokerProfile> _saveProfileEditsLocked({
    required BrokerProfile existing,
    required String trimmedDisplayName,
    required Uri normalized,
  }) async {
    final profileId = existing.id;
    final oldCredentialKey = existing.credentialKey;
    final isBaseUriChanged =
        existing.baseUri.toString() != normalized.toString();
    String? previousToken;
    if (isBaseUriChanged && oldCredentialKey != null) {
      previousToken = await _readProfileCredential(
        profileId: profileId,
        credentialKey: oldCredentialKey,
      );
      await _deleteProfileCredential(
        profileId: profileId,
        credentialKey: oldCredentialKey,
      );
    }

    final updated = existing.copyWith(
      displayName: trimmedDisplayName,
      baseUri: normalized,
      clearCredentialKey: isBaseUriChanged,
      updatedAt: DateTime.now(),
    );
    late final BrokerProfile saved;
    try {
      saved = await _repository.save(updated);
      ref.invalidate(brokerProfileListProvider);
    } on Object catch (error) {
      if (isBaseUriChanged && oldCredentialKey != null) {
        await _restoreProfileCredential(
          profileId: profileId,
          credentialKey: oldCredentialKey,
          previousToken: previousToken,
        );
      }
      throw BrokerProfileManagerException(
        "Couldn't save these changes. Check the server address and try again.",
        detail: failureDetail(error),
      );
    }

    return _finishProfileEdit(
      profileId: profileId,
      updated: saved,
      isBaseUriChanged: isBaseUriChanged,
    );
  }

  Future<BrokerProfile> _finishProfileEdit({
    required String profileId,
    required BrokerProfile updated,
    required bool isBaseUriChanged,
  }) async {
    if (isBaseUriChanged) {
      // N3: the roster identity snapshot belongs to the broker it was captured
      // from, not to the profile row. Repointing the profile makes those
      // identities another broker's, so they go with the credential. The reader
      // also refuses them on endpoint provenance; this is the cleanup half, so
      // nothing lingers on disk waiting to be refused.
      try {
        await ref
            .read(rosterSnapshotRepositoryProvider)
            .deleteForProfile(profileId);
      } on Object {
        // Best-effort, exactly like the draft cleanup on deletion: the load
        // path's provenance check is what makes the guarantee.
      }
    }

    final activeProfile = ref.read(activeBrokerProfileProvider);
    final activeStore = ref.read(activeBrokerProfileStoreProvider);
    final persistedActiveId = await activeStore.getActiveProfileId();
    final activeIncarnationMatches =
        activeProfile?.id == profileId &&
        activeProfile?.incarnationId == updated.incarnationId;
    final needsHydrationRepair =
        activeProfile == null && persistedActiveId == profileId;
    if (activeIncarnationMatches || needsHydrationRepair) {
      await activeStore.setActiveProfileId(updated.id);
      ref.read(activeBrokerProfileProvider.notifier).state = updated;
    }

    return updated;
  }

  /// Deletes a broker profile, its saved token, and every durable row it owns.
  ///
  /// The ORDER is the guarantee, and it is the reverse of the obvious one:
  ///
  /// 1. Revoke the active selection. Broker-bound controllers admit work
  ///    against the exact active source, so clearing it first is what stops
  ///    them starting a read, a mutation, or an outbox write into the rows
  ///    about to be deleted. Deleting the profile row first would leave every
  ///    controller running against a live client for a profile being erased.
  /// 2. Snapshot and remove the credential. If a later mandatory step fails,
  ///    restore the snapshot so a surviving profile never points at a missing
  ///    token.
  /// 3. Purge the local rows, atomically and MANDATORILY. Drive provenance and
  ///    retryable outbox/transfer actions are authority, not cache: swallowing
  ///    a failure here deletes the profile the user can see while leaving the
  ///    authority that acts on their behalf.
  /// 4. Delete the exact profile row in that SAME Drift transaction. A failed
  ///    purge or row delete therefore leaves both the row and all local data
  ///    intact for a retry.
  ///
  /// Revocation is deliberately not rolled back when a later step fails:
  /// re-arming a profile whose purge just failed is exactly what this order
  /// exists to prevent. The user reselects a broker; nothing is lost.
  ///
  /// Throws [BrokerProfileManagerException] when the token or the local rows
  /// cannot be removed.
  Future<void> deleteProfile(
    String profileId, {
    BrokerProfile? expectedProfile,
  }) async {
    try {
      if (expectedProfile == null) {
        await _mutationGate.runForCurrent(profileId, (current) async {
          if (current != null) await _deleteProfileLocked(current);
        });
      } else {
        await _mutationGate.runForProfile(
          expectedProfile,
          _deleteProfileLocked,
        );
      }
    } on BrokerProfileRetiredException {
      // The action belonged to a deleted incarnation and never reached a side
      // effect. The replacement is intentionally untouched.
      return;
    } on BrokerProfileManagerException {
      rethrow;
    } on Object catch (error) {
      throw BrokerProfileManagerException(
        "Couldn't load this saved server for deletion. "
        '${recoveryAdviceEn(classifyFailure(error))}',
        detail: failureDetail(error),
      );
    }
  }

  Future<void> _deleteProfileLocked(BrokerProfile existing) async {
    final profileId = existing.id;
    String? credentialKey;
    String? previousToken;
    BrokerProfile? clearedActiveProfile;
    var stage = _ProfileDeletionStage.profileLookup;
    try {
      credentialKey = existing.credentialKey;

      await ref.read(appDatabaseProvider).transaction(() async {
        // The transaction is also the ABA admission boundary. A delete that
        // captured incarnation A before A was removed must retire here instead
        // of clearing or purging replacement B.
        final current = await _repository.getById(profileId);
        if (current?.incarnationId != existing.incarnationId) {
          throw BrokerProfileRetiredException(profileId);
        }

        // 1. Fence: nothing may keep speaking for this exact incarnation.
        stage = _ProfileDeletionStage.activeSelection;
        final activeProfile = ref.read(activeBrokerProfileProvider);
        final activeStore = ref.read(activeBrokerProfileStoreProvider);
        final persistedActiveId = await activeStore.getActiveProfileId();
        final activeInMemory =
            activeProfile?.id == profileId &&
            activeProfile?.incarnationId == existing.incarnationId;
        if (activeInMemory) {
          clearedActiveProfile = activeProfile;
          ref.read(activeBrokerProfileProvider.notifier).state = null;
        }
        if (persistedActiveId == profileId) {
          await activeStore.clearActiveProfileId();
        }

        // One-shot created-session attach intents are in-memory but outlive
        // the profile row within a run; a re-added profile must not consume
        // them.
        ref.read(createdSessionAttachIntentsProvider).forgetProfile(profileId);

        // 2. The credential store cannot be rolled back by Drift. Snapshot it
        // inside the serialized boundary and compensate it if the transaction
        // rejects or fails to commit.
        stage = _ProfileDeletionStage.credential;
        if (credentialKey != null) {
          previousToken = await _readProfileCredential(
            profileId: profileId,
            credentialKey: credentialKey,
          );
          await _deleteProfileCredential(
            profileId: profileId,
            credentialKey: credentialKey,
          );
        }

        // 3. Authority: everything durable the profile owned, at every
        // endpoint and incarnation. The profile-row CAS below is part of this
        // same transaction, so either all database deletes commit or none do.
        stage = _ProfileDeletionStage.localData;
        await ref
            .read(sessionDraftRepositoryProvider)
            .deleteForProfile(profileId);
        await ref
            .read(rosterSnapshotRepositoryProvider)
            .deleteForProfile(profileId);
        await ref
            .read(brokerProfileLocalDataPurgeProvider)
            .deleteForProfile(profileId);

        // 4. The exact profile incarnation, last but still in the transaction.
        stage = _ProfileDeletionStage.profileRow;
        final deleted = await _repository.delete(
          id: profileId,
          incarnationId: existing.incarnationId,
        );
        if (!deleted) throw BrokerProfileRetiredException(profileId);
      });

      // Profile observers see the deletion only after every row commit.
      ref.invalidate(brokerProfileListProvider);
    } on BrokerProfileRetiredException {
      // An out-of-band repository replacement bypassed the application gate.
      // Never compensate into its shared credential or active-profile state.
      rethrow;
    } on Object catch (error) {
      if (credentialKey != null && previousToken != null) {
        await _restoreProfileCredential(
          profileId: profileId,
          credentialKey: credentialKey,
          previousToken: previousToken,
        );
      }
      if (stage == _ProfileDeletionStage.activeSelection &&
          clearedActiveProfile != null) {
        ref.read(activeBrokerProfileProvider.notifier).state =
            clearedActiveProfile;
      }
      if (error is BrokerProfileManagerException) {
        rethrow;
      }
      final lead = switch (stage) {
        _ProfileDeletionStage.profileLookup =>
          "Couldn't load this saved server for deletion.",
        _ProfileDeletionStage.activeSelection =>
          "Couldn't clear this server as the active server.",
        _ProfileDeletionStage.credential =>
          "Couldn't remove this server's saved token from the device.",
        _ProfileDeletionStage.localData =>
          "Couldn't delete this server — the data saved for it is still on "
              'this device, so the saved server was kept.',
        _ProfileDeletionStage.profileRow =>
          "Couldn't delete this saved server. Its token was restored.",
      };
      throw BrokerProfileManagerException(
        '$lead ${recoveryAdviceEn(classifyFailure(error))}',
        detail: failureDetail(error),
      );
    }
  }

  Future<void> _deleteProfileCredential({
    required String profileId,
    required String credentialKey,
  }) async {
    try {
      await _credentialStore.deleteBrokerToken(credentialKey);
    } on Object catch (error) {
      throw BrokerProfileManagerException(
        "Couldn't remove this server's saved token from the device. "
        '${recoveryAdviceEn(classifyFailure(error))}',
        detail: failureDetail(error),
      );
    }
  }

  Future<String?> _readProfileCredential({
    required String profileId,
    required String credentialKey,
  }) async {
    try {
      return await _credentialStore.readBrokerToken(credentialKey);
    } on Object catch (error) {
      throw BrokerProfileManagerException(
        "Couldn't read this server's saved token from the device. "
        '${recoveryAdviceEn(classifyFailure(error))}',
        detail: failureDetail(error),
      );
    }
  }

  Future<void> _restoreProfileCredential({
    required String profileId,
    required String credentialKey,
    required String? previousToken,
  }) async {
    if (previousToken == null) {
      return;
    }

    try {
      await _credentialStore.writeBrokerToken(credentialKey, previousToken);
    } on Object catch (error) {
      throw BrokerProfileManagerException(
        "Couldn't restore this server's saved token after the change was "
        'rolled back. You may need to paste the token again.',
        detail: failureDetail(error),
      );
    }
  }
}

enum _ProfileDeletionStage {
  profileLookup,
  activeSelection,
  credential,
  localData,
  profileRow,
}
