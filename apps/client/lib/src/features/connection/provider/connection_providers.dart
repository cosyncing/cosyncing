import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/secure_credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_credential.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/url_normalizer.dart';
import 'package:cosyncing_client/src/features/broker_profiles/provider/broker_profile_providers.dart';
import 'package:cosyncing_client/src/features/connection/data/active_broker_profile_store.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_http_transport.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_route_store.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_route_transport.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_source_migration.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_health_probe.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_routes.dart';
import 'package:cosyncing_client/src/features/connection/model/connection_state.dart';
import 'package:cosyncing_client/src/features/connection/model/real_broker_health_probe.dart';
import 'package:cosyncing_client/src/features/connection/model/same_origin_broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/broker_route_providers.dart';
import 'package:cosyncing_client/src/local/app_database.dart';
import 'package:flutter/foundation.dart' show immutable, kIsWeb;
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Provides the [BrokerHealthProbe] singleton.
///
/// Override this in tests to inject a fake implementation.
final brokerHealthProbeProvider = Provider<BrokerHealthProbe>(
  (ref) => RealBrokerHealthProbe(
    transport: ref.watch(brokerHttpTransportProvider),
    timeout: brokerProbeTimeout,
  ),
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
    // Neither read publishes state. Start them together under the mutation
    // gate so normal startup does not serialize two browser-worker trips.
    // Recovery can change durable metadata, so re-read selection afterwards
    // whenever a journal was present.
    final (recovery, selectedId) = await (
      readBrokerRouteRecovery(ref.read(appDatabaseProvider)),
      store.getActiveProfileId(),
    ).wait;
    if (recovery.merges) {
      try {
        await ref.read(brokerProfileMergeProvider).recover();
      } on Object {
        /* A committed merge retains its pending secret-cleanup journal. */
      }
    }
    try {
      if (recovery.proxies) {
        await ref.read(brokerRouteStoreProvider).recoverProxyWrites();
      }
    } on Object {
      // Preserve the journal while the keyring is locked. Resolving a required
      // path still validates its published secret and never falls back Direct.
    }
    if (recovery.migrations) {
      await BrokerSourceMigration(
        ref.read(appDatabaseProvider),
        ref.read(brokerRouteStoreProvider),
        ref.read(credentialStoreProvider),
      ).recover();
    }
    final persistedId =
        recovery.merges || recovery.proxies || recovery.migrations
        ? await store.getActiveProfileId()
        : selectedId;

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
  return ref.read(brokerProfileMutationGateProvider).runExclusive(() async {
    final existing = (await repository.getAll())
        .where(
          (profile) => profile.baseUri.origin == defaultProfile.baseUri.origin,
        )
        .firstOrNull;
    final resolved = existing ?? defaultProfile.copyWith(id: newConnectionId());
    final saved = await repository.save(resolved);
    ref.invalidate(brokerProfileListProvider);
    await ref
        .read(activeBrokerProfileStoreProvider)
        .setActiveProfileId(saved.id);
    ref.read(activeBrokerProfileProvider.notifier).state = saved;
    return saved;
  });
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
  var _intentGeneration = 0;

  @override
  ConnectionStateModel build() {
    return ConnectionStateModel();
  }

  /// Normalizes and validates [input], then runs a health probe.
  ///
  /// Transitions: idle/validating/success/failure → validating →
  /// success or failure.
  Future<bool> connect(String input) async {
    final intentGeneration = ++_intentGeneration;

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
      return false;
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
      return false;
    }

    // Run the health probe.
    state = ConnectionStateModel(
      status: ConnectionStatus.validating,
      brokerUrl: normalized,
    );

    final probe = ref.read(brokerHealthProbeProvider);
    final result = await probe.probe(normalized);
    if (!_isCurrent(intentGeneration)) return false;

    if (result.isSuccess) {
      final repository = ref.read(brokerProfileRepositoryProvider);
      final activated = await ref
          .read(brokerProfileMutationGateProvider)
          .runExclusive(() async {
            if (!_isCurrent(intentGeneration)) return false;
            final candidates = (await repository.getAll())
                .where((profile) => profile.baseUri.origin == normalized.origin)
                .toList();
            final activeId = ref.read(activeBrokerProfileProvider)?.id;
            final persistedProfile =
                candidates.where((p) => p.id == activeId).firstOrNull ??
                candidates.firstOrNull;
            final now = DateTime.now();
            final profile = BrokerProfile(
              id: persistedProfile?.id ?? newConnectionId(),
              displayName: persistedProfile?.displayName ?? normalized.host,
              baseUri: normalized,
              createdAt: persistedProfile?.createdAt ?? now,
              incarnationId: persistedProfile?.incarnationId,
              updatedAt: now,
              lastUsedAt: now,
              credentialKey: persistedProfile?.credentialKey,
              sourceIdentity: persistedProfile?.sourceIdentity,
            );
            final saved = await repository.save(profile);
            if (!_isCurrent(intentGeneration)) return false;
            ref.invalidate(brokerProfileListProvider);
            await ref
                .read(activeBrokerProfileStoreProvider)
                .setActiveProfileId(saved.id);
            if (!_isCurrent(intentGeneration)) return false;
            ref.read(activeBrokerProfileProvider.notifier).state = saved;
            return true;
          });
      if (!activated || !_isCurrent(intentGeneration)) return false;
      state = ConnectionStateModel(
        status: ConnectionStatus.success,
        brokerUrl: normalized,
        machine: result.machine,
      );
      return true;
    } else {
      if (!_isCurrent(intentGeneration)) return false;
      state = ConnectionStateModel(
        status: ConnectionStatus.failure,
        brokerUrl: normalized,
        failureKind: result.noAnswer
            ? ConnectionFailureKind.noAnswer
            : result.unhealthy
            ? ConnectionFailureKind.brokerUnhealthy
            : ConnectionFailureKind.unreachable,
        technicalDetail: result.detail ?? result.error?.detail,
      );
      return false;
    }
  }

  /// Retires any in-flight direct-connect result after a newer server choice.
  ///
  /// Saved-profile selection and pairing call this when their user intent
  /// begins, before any asynchronous profile work. A late health probe can
  /// therefore neither reactivate its server nor publish a stale success.
  void supersedePendingConnection() {
    _intentGeneration += 1;
    state = ConnectionStateModel();
  }

  bool _isCurrent(int intentGeneration) =>
      intentGeneration == _intentGeneration;

  /// Resets the connection state to idle.
  Future<void> reset() async {
    supersedePendingConnection();
    await ref.read(brokerProfileMutationGateProvider).runExclusive(() async {
      await ref.read(activeBrokerProfileStoreProvider).clearActiveProfileId();
      ref.read(activeBrokerProfileProvider.notifier).state = null;
    });
  }
}

/// Builds an authenticated client for one saved broker profile.
///
/// A profile credential may be either the broker-wide owner token or a
/// revocable QR-paired device token. The secure-storage key selects the wire
/// header scheme; secret values never enter Drift or current-broker request
/// URLs. Loopback does not bypass a configured credential because production
/// brokers may enforce auth on every interface, including localhost.
Future<BrokerClient> createBrokerClientForProfile(
  Ref ref,
  BrokerProfile profile,
) async {
  final transport = ref.read(brokerHttpTransportProvider);
  final coordinator = profile.incarnationId == null
      ? null
      : ref.read(brokerRouteCoordinatorProvider);
  final store = ref.read(credentialStoreProvider);
  final active = ref.read(activeBrokerProfileProvider);
  final unauthorized = ref.read(brokerUnauthorizedSignalProvider);
  final source = BrokerUnauthorizedSource.ofProfile(profile);
  void reportUnauthorized() => unauthorized.report(source);
  final credentialKey = profile.credentialKey;
  final raw = credentialKey == null
      ? null
      : await store.readBrokerToken(credentialKey);
  final credential = raw?.trim();
  if (credentialKey != null && (credential == null || credential.isEmpty)) {
    throw BrokerCredentialUnavailableException(profile.id);
  }
  final route = await coordinator?.resolve(
    profile,
    alternates:
        active?.id == profile.id &&
        active?.incarnationId == profile.incarnationId,
  );
  final peer =
      credentialKey != null &&
      brokerCredentialKindForKey(credentialKey) ==
          BrokerCredentialKind.peerToken;
  final client = BrokerClient(
    baseUrl: (route?.context.origin ?? profile.baseUri).toString(),
    token: peer ? null : credential,
    peerToken: peer ? credential : null,
    clientProfileId: profile.id,
    clientProfileIncarnation:
        profile.incarnationId ??
        'created-${profile.createdAt.toUtc().microsecondsSinceEpoch}',
    dio:
        route?.dio(onUnauthorized: reportUnauthorized) ??
        brokerTransportDioReportingUnauthorized(
          transport,
          onUnauthorized: reportUnauthorized,
        ),
  );
  if (route != null) bindResolverRoute(client.resolver, route);
  return client;
}

/// The saved server a refused request was sent to: profile, endpoint and
/// incarnation, so a refusal from another server (an attention feed polls
/// every saved one) or from before an edit is never read as the active
/// server's.
@immutable
final class BrokerUnauthorizedSource {
  /// Creates a source.
  const BrokerUnauthorizedSource({
    required this.profileId,
    required this.endpoint,
    required this.incarnationId,
  });

  /// The source [profile] names.
  factory BrokerUnauthorizedSource.ofProfile(BrokerProfile profile) =>
      BrokerUnauthorizedSource(
        profileId: profile.id,
        endpoint: profile.sourceIdentity ?? profile.baseUri.toString(),
        incarnationId: profile.incarnationId,
      );

  /// Saved profile id.
  final String profileId;

  /// Endpoint the request went to.
  final String endpoint;

  /// Profile incarnation.
  final String? incarnationId;

  @override
  bool operator ==(Object other) =>
      other is BrokerUnauthorizedSource &&
      other.profileId == profileId &&
      other.endpoint == endpoint &&
      other.incarnationId == incarnationId;

  @override
  int get hashCode => Object.hash(profileId, endpoint, incarnationId);
}

/// Carries every HTTP 401 an authenticated broker client receives.
///
/// The connection gate probes only at launch and on an explicit retry, so a
/// credential the broker stopped accepting while the app runs (a rotated
/// token, a revoked device) was never noticed: the roster went on asking and
/// being refused. Every client [createBrokerClientForProfile] builds reports
/// its 401s here and the gate decides whether to probe again.
class BrokerUnauthorizedSignal {
  final StreamController<BrokerUnauthorizedSource> _reports =
      StreamController<BrokerUnauthorizedSource>.broadcast();

  /// Refusals, as they arrive.
  Stream<BrokerUnauthorizedSource> get reports => _reports.stream;

  /// Records that a request to [source] came back 401.
  void report(BrokerUnauthorizedSource source) {
    if (!_reports.isClosed) _reports.add(source);
  }

  /// Closes the stream.
  void dispose() => unawaited(_reports.close());
}

/// The app's one [BrokerUnauthorizedSignal].
final brokerUnauthorizedSignalProvider = Provider<BrokerUnauthorizedSignal>((
  ref,
) {
  final signal = BrokerUnauthorizedSignal();
  ref.onDispose(signal.dispose);
  return signal;
});

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
