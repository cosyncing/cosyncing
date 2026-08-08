import 'package:broker_client/broker_client.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/secure_credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_credential.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/url_normalizer.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/data/active_broker_profile_store.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_health_probe.dart';
import 'package:cosyncing_client/src/features/connection/model/connection_state.dart';
import 'package:cosyncing_client/src/features/connection/model/real_broker_health_probe.dart';
import 'package:cosyncing_client/src/features/connection/model/same_origin_broker_profile.dart';
import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Provides the [BrokerHealthProbe] singleton.
///
/// Override this in tests to inject a fake implementation.
final brokerHealthProbeProvider = Provider<BrokerHealthProbe>(
  (ref) => RealBrokerHealthProbe(),
);

/// Active broker profile selected from the Connection screen.
///
/// This profile is restored from durable app settings on startup.
///
/// See `docs/project/implementation-status.md` and
/// `docs/protocol/contract-sync.md`.
final activeBrokerProfileProvider = StateProvider<BrokerProfile?>(
  (ref) => null,
);

/// Restores the active broker profile from persisted app settings.
///
/// On startup, this loads the active profile id and hydrates
/// [activeBrokerProfileProvider] if the profile still exists.
/// If the persisted id is stale, it is cleared.
///
/// On web (`kIsWeb`), when no valid profile is already active, the app defaults
/// to the "this server" origin it was served from (see
/// [selectSameOriginBrokerProfile]). This lets the broker-served Flutter build
/// attach same-origin with no operator URL entry. Native platforms are
/// unaffected and keep the manual "enter a broker URL" flow.
final activeBrokerProfileHydrationProvider = FutureProvider<void>((ref) async {
  var needsWebDefault = false;
  await ref.read(brokerProfileMutationGateProvider).runExclusive(() async {
    final store = ref.read(activeBrokerProfileStoreProvider);
    final persistedId = await store.getActiveProfileId();

    if (persistedId != null) {
      final repository = ref.read(brokerProfileRepositoryProvider);
      final profile = await repository.getById(persistedId);
      if (profile != null) {
        ref.read(activeBrokerProfileProvider.notifier).state = profile;
        return;
      }
      // Persisted id is stale: clear it, then fall through to the web
      // default after releasing the mutation gate.
      await store.clearActiveProfileId();
    }
    needsWebDefault = kIsWeb;
  });

  if (needsWebDefault) {
    await selectSameOriginBrokerProfile(ref);
  }
});

/// Selects the same-origin ("this server") broker profile as active on web.
///
/// Derives the broker endpoint from [base] (defaults to [Uri.base] — the origin
/// the Flutter app was served from), persists it (so it appears in the profile
/// list and survives restarts), and marks it active. If a profile already
/// exists for that origin id, its saved metadata/credential is preserved.
/// Returns the selected profile, or `null` when the origin is not attachable
/// (e.g. `file://` or an empty host).
///
/// This is only invoked on web (guarded by `kIsWeb` at the call site). It is
/// exposed (rather than private) so it can be unit-tested with an explicit
/// [base], since `kIsWeb` is a compile-time constant that is always `false`
/// under the Dart VM test runner.
Future<BrokerProfile?> selectSameOriginBrokerProfile(
  Ref ref, {
  Uri? base,
}) async {
  final origin = base ?? Uri.base;
  if (!isAttachableOrigin(origin)) {
    return null;
  }

  final defaultProfile = sameOriginBrokerProfile(base: origin);
  final repository = ref.read(brokerProfileRepositoryProvider);
  return ref.read(brokerProfileMutationGateProvider).runForCurrent(
    defaultProfile.id,
    (existing) async {
      final resolved = existing ?? defaultProfile;
      final saved = await repository.save(resolved);
      ref.invalidate(brokerProfileListProvider);
      await ref
          .read(activeBrokerProfileStoreProvider)
          .setActiveProfileId(saved.id);
      ref.read(activeBrokerProfileProvider.notifier).state = saved;
      return saved;
    },
  );
}

/// Runtime broker credential store.
///
/// Override this provider with a test double in unit tests. See
/// `docs/protocol/contract-sync.md`.
final credentialStoreProvider = Provider<CredentialStore>(
  (ref) => SecureCredentialStore(),
);

/// Built `BrokerClient` bound to the active broker profile.
///
/// Sessions and future live-session features can consume this provider.
/// See `docs/protocol/contract-sync.md`.
final AutoDisposeFutureProvider<BrokerClient?> brokerClientProvider =
    FutureProvider.autoDispose<BrokerClient?>((ref) async {
      final profile = ref.watch(activeBrokerProfileProvider);
      if (profile == null) {
        return null;
      }

      // Disposal is registered BEFORE the asynchronous build: losing the
      // last listener (or a profile switch) can dispose this provider while
      // the client is still being created, and registering onDispose after
      // the await then throws ("Cannot call onDispose after a provider was
      // disposed") while leaking the freshly built client.
      BrokerClient? built;
      var disposed = false;
      ref.onDispose(() {
        disposed = true;
        built?.close();
      });
      final client = await createBrokerClientForProfile(ref, profile);
      if (disposed) {
        // This build lost the race with a disposal: release the orphan and
        // resolve null. An already-obtained `.future` still RECEIVES this
        // value — returning the closed client would let a caller pass its
        // `client != null` check and then operate on a closed Dio.
        client.close();
        return null;
      }
      built = client;
      return client;
    });

/// Builds an operation-owned client bound to one explicit profile.
///
/// The shared [brokerClientProvider] client is auto-disposed: a profile
/// switch while a caller holds it across an await can close it mid-operation
/// (or, before the hardening above, crash the in-flight build). Flows that
/// must pair the broker they talk to with profile-qualified local writes —
/// created-session intents, Drive provenance — build their OWN client from
/// the profile they captured and close it when the operation ends. Tests
/// override this provider to inject fakes.
final Provider<Future<BrokerClient> Function(BrokerProfile profile)>
brokerClientFactoryProvider =
    Provider<Future<BrokerClient> Function(BrokerProfile profile)>(
      (ref) =>
          (profile) => createBrokerClientForProfile(ref, profile),
    );

/// Controller for the broker connection flow.
///
/// Manages the connection lifecycle: idle → validating → success/failure.
/// Screens dispatch intents; this controller owns the state machine.
class ConnectionController extends Notifier<ConnectionStateModel> {
  @override
  ConnectionStateModel build() {
    return ConnectionStateModel();
  }

  /// Normalizes and validates [input], then runs a health probe.
  ///
  /// Transitions: idle/validating/success/failure → validating →
  /// success or failure.
  Future<void> connect(String input) async {
    // Normalize the URL first.
    final Uri normalized;
    try {
      normalized = normalizeBrokerUrl(input);
    } on FormatException catch (e) {
      state = ConnectionStateModel(
        status: ConnectionStatus.failure,
        failureKind: ConnectionFailureKind.invalidAddress,
        technicalDetail: e.message,
      );
      return;
    }

    // Validate the normalized URL.
    final errors = validateBrokerUrl(normalized);
    if (errors.isNotEmpty) {
      state = ConnectionStateModel(
        status: ConnectionStatus.failure,
        brokerUrl: normalized,
        failureKind: ConnectionFailureKind.invalidAddress,
        technicalDetail: errors.join('; '),
      );
      return;
    }

    // Run the health probe.
    state = ConnectionStateModel(
      status: ConnectionStatus.validating,
      brokerUrl: normalized,
    );

    final probe = ref.read(brokerHealthProbeProvider);
    final result = await probe.probe(normalized);

    if (result.isSuccess) {
      final repository = ref.read(brokerProfileRepositoryProvider);
      await ref.read(brokerProfileMutationGateProvider).runForCurrent(
        normalized.toString(),
        (persistedProfile) async {
          final now = DateTime.now();
          final profile = BrokerProfile(
            id: normalized.toString(),
            displayName: persistedProfile?.displayName ?? normalized.host,
            baseUri: normalized,
            createdAt: persistedProfile?.createdAt ?? now,
            incarnationId: persistedProfile?.incarnationId,
            updatedAt: now,
            lastUsedAt: now,
            credentialKey: persistedProfile?.credentialKey,
          );
          final saved = await repository.save(profile);
          ref.invalidate(brokerProfileListProvider);
          await ref
              .read(activeBrokerProfileStoreProvider)
              .setActiveProfileId(saved.id);
          ref.read(activeBrokerProfileProvider.notifier).state = saved;
        },
      );
      state = ConnectionStateModel(
        status: ConnectionStatus.success,
        brokerUrl: normalized,
        machine: result.machine,
      );
    } else {
      state = ConnectionStateModel(
        status: ConnectionStatus.failure,
        brokerUrl: normalized,
        failureKind: result.unhealthy
            ? ConnectionFailureKind.brokerUnhealthy
            : ConnectionFailureKind.unreachable,
        technicalDetail: result.detail ?? result.error,
      );
    }
  }

  /// Resets the connection state to idle.
  Future<void> reset() async {
    await ref.read(brokerProfileMutationGateProvider).runExclusive(() async {
      await ref.read(activeBrokerProfileStoreProvider).clearActiveProfileId();
      ref.read(activeBrokerProfileProvider.notifier).state = null;
    });
    state = ConnectionStateModel();
  }
}

/// Builds an authenticated client for one saved broker profile.
///
/// A profile credential may be either the broker-wide owner token or a
/// revocable QR-paired device token. The secure-storage key selects the wire
/// header/query scheme; secret values never enter Drift. Loopback does not
/// bypass a configured credential because production brokers may enforce auth
/// on every interface, including localhost.
Future<BrokerClient> createBrokerClientForProfile(
  Ref ref,
  BrokerProfile profile,
) async {
  final sourceArguments = (
    profileId: profile.id,
    incarnation:
        profile.incarnationId ??
        'created-${profile.createdAt.toUtc().microsecondsSinceEpoch}',
  );
  final credentialKey = profile.credentialKey;
  if (credentialKey == null) {
    return BrokerClient(
      baseUrl: profile.baseUri.toString(),
      clientProfileId: sourceArguments.profileId,
      clientProfileIncarnation: sourceArguments.incarnation,
    );
  }

  final raw = await ref
      .read(credentialStoreProvider)
      .readBrokerToken(credentialKey);
  final credential = raw?.trim();
  if (credential == null || credential.isEmpty) {
    throw BrokerCredentialUnavailableException(profile.id);
  }

  return switch (brokerCredentialKindForKey(credentialKey)) {
    BrokerCredentialKind.sharedToken => BrokerClient(
      baseUrl: profile.baseUri.toString(),
      token: credential,
      clientProfileId: sourceArguments.profileId,
      clientProfileIncarnation: sourceArguments.incarnation,
    ),
    BrokerCredentialKind.peerToken => BrokerClient(
      baseUrl: profile.baseUri.toString(),
      peerToken: credential,
      clientProfileId: sourceArguments.profileId,
      clientProfileIncarnation: sourceArguments.incarnation,
    ),
  };
}

/// Returns true for local hostnames that typically use loopback auth.
///
/// Shared by settings token controls so loopback handling is consistent.
bool isLoopbackHost(String host) {
  return host == 'localhost' || host == '127.0.0.1' || host == '::1';
}

/// Provider for the [ConnectionController].
final NotifierProvider<ConnectionController, ConnectionStateModel>
connectionControllerProvider =
    NotifierProvider<ConnectionController, ConnectionStateModel>(
      ConnectionController.new,
    );
