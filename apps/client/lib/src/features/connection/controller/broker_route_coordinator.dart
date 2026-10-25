import 'dart:async';
import 'dart:collection';
import 'dart:math';

import 'package:broker_client/broker_client.dart';
import 'package:cosyncing_client/src/features/broker_profiles/data/credential_store.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_credential.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_http_transport.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_route_probe.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_route_store.dart';
import 'package:cosyncing_client/src/features/connection/data/broker_route_transport.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_route_context.dart';
import 'package:cosyncing_client/src/features/connection/model/broker_routes.dart';
import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

/// One coordinated handoff per logical server, shared by REST and sessions.
enum BrokerRoutePhase {
  /// An approved route is committed and usable.
  connected,

  /// Collecting fresh observations while retaining the current route.
  evaluating,

  /// Verifying a candidate before a coordinated handoff.
  preparing,

  /// Draining mutations and committing the prepared route.
  switching,

  /// Reestablishing a route after transport loss.
  recovering,

  /// No approved route is currently ready.
  offline,
}

/// Read-only view of one server's current route observations.
final class BrokerRouteStatus {
  /// Copies status collections for a stable read-only observation.
  BrokerRouteStatus({
    required this.server,
    required this.phase,
    required this.activeRouteId,
    required Map<String, BrokerRouteObservation> observations,
    required Map<String, Object> failures,
    required Set<String> testing,
  }) : observations = Map.unmodifiable(observations),
       failures = Map.unmodifiable(failures),
       testing = Set.unmodifiable(testing);

  /// Saved logical server/access binding represented by this status.
  final BrokerRouteServer server;

  /// Current coordinated connection or recovery phase.
  final BrokerRoutePhase phase;

  /// Address committed for new requests, or null while offline.
  final String? activeRouteId;

  /// Immutable per-address readiness and latency observations.
  final Map<String, BrokerRouteObservation> observations;

  /// Observed failures for individual addresses, safe to sanitize on demand.
  final Map<String, Object> failures;

  /// Address identifiers whose coalesced readiness attempts are running.
  final Set<String> testing;
}

/// Global FIFO admission; each task is a sequential HTTP/WS attempt. Holding
/// at most three slots bounds real operations without serializing all routes.
final class _ProbeQueue {
  final _waiting = Queue<Future<void> Function()>();
  var _running = 0;
  Future<T> run<T>(Future<T> Function() action) {
    final result = Completer<T>();
    _waiting.add(() async {
      try {
        result.complete(await action());
      } on Object catch (error, stack) {
        result.completeError(error, stack);
      } finally {
        _running--;
        _drain();
      }
    });
    _drain();
    return result.future;
  }

  void _drain() {
    while (_running < 3 && _waiting.isNotEmpty) {
      _running++;
      unawaited(_waiting.removeFirst()());
    }
  }
}

final class _ServerRoutes {
  _ServerRoutes(this.profile, this.server);
  BrokerProfile profile;
  BrokerRouteServer server;
  BrokerRoutePhase phase = BrokerRoutePhase.offline;
  BrokerRouteTransport? active;
  final transports = <String, BrokerRouteTransport>{};
  final draining = <BrokerRouteTransport>{};
  final observations = <String, BrokerRouteObservation>{};
  final failures = <String, Object>{};
  final attempts = <String, Future<BrokerRouteObservation>>{};
  final probes = <String, BrokerRouteProbe>{};
  final fasterRounds = <String, int>{};
  Completer<BrokerRouteTransport>? firstReady;

  /// A generation callers already hold was retired, and
  /// [BrokerRouteCoordinator.onSwitch] has not told them yet. A
  /// [BrokerRouteCoordinator.resolve] caller waiting on [firstReady] must not
  /// suppress that announcement, or the open sessions and long-lived clients
  /// built on the retired generation are never rebuilt.
  bool retiredUnannounced = false;
  Future<void>? switching;
  Future<void>? round;
  bool roundIncludesAlternates = false;
  String? preparingRoute;
  DateTime? lastLatencySwitch;
  DateTime? lastRound;
  Timer? retry;
  int backoff = 0;
  int epoch = 0;
  int authGeneration = 0;
  int softFailures = 0;

  /// Starts/stops address-view cadence without activating another server.
  bool visible = false;
  int liveSessions = 0;
  bool revoked = false;
}

/// Coordinates approved routes without changing session/source ownership.
/// A user-initiated Test is the only operation that probes an inactive server.
final class BrokerRouteCoordinator extends ChangeNotifier {
  /// Shares fair probing and handoffs across the app’s clients.
  BrokerRouteCoordinator({
    required this.store,
    required this.credentials,
    required this.onSwitch,
    this.httpOverride,
    this.socketOverride,
    this.monotonicNow,
    DateTime Function()? now,
  }) : now = now ?? DateTime.now;

  /// Versioned device-local connection configuration.
  final BrokerRouteStore store;

  /// Broker authentication material; attached only after identity verification.
  final CredentialStore credentials;

  /// Publishes a committed handoff to the affected logical server’s clients.
  final Future<void> Function(BrokerProfile) onSwitch;

  /// Optional platform transport seam used by app-level wire fixtures.
  final BrokerHttpTransport? httpOverride;

  /// Optional WebSocket seam used by app-level wire fixtures.
  final WebSocketAdapter Function(String)? socketOverride;

  /// Wall clock for freshness and proof expiry; latency uses monotonic time.
  final DateTime Function() now;

  /// Monotonic latency clock, injectable independently of wall time.
  final Duration Function()? monotonicNow;
  final _queue = _ProbeQueue();
  final _servers = <String, _ServerRoutes>{};
  final _loading = <String, Future<_ServerRoutes>>{};
  final _proxyFailures = <String, ({DateTime until, int failures})>{};
  var _networkGeneration = 0;
  var _foreground = true;
  var _disposed = false;
  String? _selectedServer;
  Timer? _refresh;

  String _key(BrokerProfile profile) =>
      '${profile.id}#${profile.incarnationId}';

  /// Marks the selected roster as relevant even when no session tab is open.
  void selected(BrokerProfile? profile) {
    _selectedServer = profile == null ? null : _key(profile);
  }

  bool _relevant(_ServerRoutes state) =>
      state.visible ||
      state.liveSessions > 0 ||
      _key(state.profile) == _selectedServer;
  Future<_ServerRoutes> _server(BrokerProfile profile) async {
    final key = _key(profile);
    final cached = _servers[key];
    if (cached != null) {
      if (cached.profile.credentialKey != profile.credentialKey ||
          cached.profile.baseUri != profile.baseUri) {
        _retire(cached);
        cached.server = await store.ensure(profile);
      }
      cached.profile = profile;
      return cached;
    }
    final existing = _loading[key];
    if (existing != null) return existing;
    late final Future<_ServerRoutes> loading;
    loading = () async {
      try {
        final server = _ServerRoutes(profile, await store.ensure(profile));
        // Retirement removes the exact pending load. A new load for the same
        // key cannot adopt its result, and deleted profiles leave no tombstone.
        if (_disposed || !identical(_loading[key], loading)) {
          throw const BrokerRouteException('CONNECTION_RETIRED');
        }
        _servers[key] = server;
        return server;
      } finally {
        if (identical(_loading[key], loading)) unawaited(_loading.remove(key));
      }
    }();
    _loading[key] = loading;
    return loading;
  }

  /// Reads already loaded state without initiating probes for an inactive
  /// server.
  BrokerRouteStatus? status(BrokerProfile profile) {
    final state = _servers[_key(profile)];
    return state == null
        ? null
        : BrokerRouteStatus(
            server: state.server,
            phase: state.phase,
            activeRouteId: state.active?.context.routeId,
            observations: state.observations,
            failures: state.failures,
            testing: state.attempts.keys.toSet(),
          );
  }

  Future<EndpointResolver> _credential(
    BrokerProfile profile,
    Uri origin,
  ) async {
    final key = profile.credentialKey;
    final secret = key == null ? null : await credentials.readBrokerToken(key);
    if (key != null && (secret == null || secret.isEmpty)) {
      throw BrokerCredentialUnavailableException(profile.id);
    }
    final peer =
        key != null &&
        brokerCredentialKindForKey(key) == BrokerCredentialKind.peerToken;
    return EndpointResolver(
      baseUrl: origin.toString(),
      token: peer ? null : secret,
      peerToken: peer ? secret : null,
      clientProfileId: profile.id,
      clientProfileIncarnation: profile.incarnationId,
    );
  }

  Future<BrokerRouteTransport> _transport(
    _ServerRoutes state,
    BrokerAddress address,
  ) async {
    final epoch = state.epoch;
    final networkGeneration = _networkGeneration;
    void requireCurrent() {
      if (_disposed ||
          epoch != state.epoch ||
          networkGeneration != _networkGeneration) {
        throw const BrokerRouteException('CONNECTION_RETIRED');
      }
    }

    final proxy = await store.proxy(address.proxyId);
    requireCurrent();
    final cached = state.transports[address.id];
    if (cached != null &&
        !cached.retired &&
        cached.context.routeGeneration == address.generation &&
        cached.context.origin == address.origin &&
        cached.context.proxyId == address.proxyId &&
        cached.context.proxy?.generation == proxy?.generation) {
      return cached;
    }
    cached?.retire();
    final secret = await store.proxySecret(proxy);
    requireCurrent();
    final context = BrokerRouteContext(
      profileId: state.profile.id,
      incarnation: state.profile.incarnationId!,
      origin: address.origin,
      routeId: address.id,
      routeGeneration: address.generation,
      networkGeneration: networkGeneration,
      authGeneration: state.authGeneration,
      identityPublicKey: state.server.identityPublicKey,
      principalId: state.server.principalId,
      proxyId: address.proxyId,
      proxy: proxy,
      proxyCredentials: secret,
    )..validatePath(native: !kIsWeb);
    final transport = BrokerRouteTransport(
      context,
      httpOverride: httpOverride,
      socketOverride: socketOverride,
      onAuthorizationRefused: () {
        if (_disposed ||
            (state.transports[address.id]?.context != context &&
                !state.draining.any(
                  (transport) => transport.context == context,
                ))) {
          return;
        }
        state.revoked = true;
        _retire(state);
        _changed();
      },
      onTransportFailure: () {
        if (_disposed || state.active?.context != context) return;
        // A session socket owns its reconnect cursor. With no alternate path,
        // rebuilding every consumer cannot improve its recovery: recheck the
        // one route in place, so the status still follows the server.
        if (state.server.principalId != null && _ordered(state).length < 2) {
          _recheck(state, failed: true);
          return;
        }
        unawaited(
          transportFailed(state.profile, hard: true).catchError((Object error) {
            state.failures[address.id] = error;
            _changed();
          }),
        );
      },
    );
    state.transports[address.id] = transport;
    return transport;
  }

  /// Existing single-address trust stays usable offline/on old brokers. New
  /// addresses cannot receive credentials until they pass identity readiness.
  Future<BrokerRouteTransport> resolve(
    BrokerProfile profile, {
    bool alternates = false,
  }) async {
    final state = await _server(profile);
    if (state.revoked) {
      throw const BrokerRouteException('AUTHORIZATION_REVOKED');
    }
    if (state.active case final active? when !active.retired) return active;
    final routes = _ordered(state);
    if (routes.isEmpty) throw const BrokerRouteException('NO_ENABLED_ADDRESS');
    if (state.server.principalId == null) {
      final original = routes
          .where(
            (route) =>
                route.legacyTrusted &&
                route.origin.origin == state.server.legacyOrigin.origin,
          )
          .firstOrNull;
      if (original == null) {
        throw const BrokerRouteException('IDENTITY_NOT_VERIFIED');
      }
      final transport = await _transport(state, original);
      state
        ..active = transport
        ..phase = BrokerRoutePhase.connected;
      return transport;
    }
    final ready = state.firstReady ??= Completer<BrokerRouteTransport>();
    unawaited(_round(state, alternates: alternates));
    return ready.future;
  }

  /// The addresses this server can bind. Old brokers have no identity proof,
  /// so only their original trusted address is ever used.
  List<BrokerAddress> _usable(_ServerRoutes state) {
    final routes = _ordered(state);
    if (state.server.principalId != null) return routes;
    return [
      for (final route in routes)
        if (route.legacyTrusted &&
            route.origin.origin == state.server.legacyOrigin.origin)
          route,
    ];
  }

  /// Rechecks a server's only route without retiring it. Sessions reconnect
  /// with their own cursors and no consumer is rebuilt; the status follows the
  /// check, and a failed check retries with backoff.
  void _recheck(_ServerRoutes state, {required bool failed}) {
    final active = state.active;
    if (active == null || active.retired) return;
    // A network change can strand every connection. One failed session
    // socket says nothing about the others, which keep their own liveness.
    active.resetConnections(sockets: !failed);
    state.observations.remove(active.context.routeId);
    if (failed) state.phase = BrokerRoutePhase.recovering;
    _changed();
    if (_foreground && _relevant(state)) unawaited(_round(state));
  }

  List<BrokerAddress> _ordered(_ServerRoutes state) {
    final routes =
        state.server.addresses
            .where(
              (a) =>
                  a.enabled &&
                  (state.server.mode != BrokerRouteMode.fixed ||
                      a.id == state.server.fixedRouteId),
            )
            .toList()
          ..sort((a, b) {
            final last = state.server.lastSuccessfulRouteId;
            if (a.id == last) return -1;
            if (b.id == last) return 1;
            return a.order.compareTo(b.order);
          });
    return routes;
  }

  /// Coalesces an explicit readiness round for the server’s enabled addresses.
  Future<void> testAll(BrokerProfile profile) async {
    final state = await _server(profile);
    await _round(state, explicit: true);
  }

  /// Verifies an address; unsaved edits use isolated temporary transports.
  Future<BrokerRouteObservation> testAddress(
    BrokerProfile profile,
    BrokerAddress address, {
    String? approvedIdentity,
  }) async {
    final state = await _server(profile);
    final configured = state.server.addresses
        .where((route) => route.id == address.id)
        .firstOrNull;
    if (configured?.origin == address.origin &&
        configured?.generation == address.generation &&
        configured?.proxyId == address.proxyId) {
      return _test(
        state,
        address,
        approvedIdentity: approvedIdentity,
        full: true,
      );
    }
    final proxy = await store.proxy(address.proxyId);
    return _testProposed(
      profile,
      address,
      proxy,
      await store.proxySecret(proxy),
      approvedIdentity: approvedIdentity,
    );
  }

  /// Tests proposed proxy material without publishing it to any saved binding.
  Future<BrokerRouteObservation> testProxy(
    BrokerProfile profile,
    BrokerAddress address,
    BrokerProxyProfile proxy,
    BrokerProxyCredentials? secret,
  ) => _testProposed(profile, address, proxy, secret);

  Future<BrokerRouteObservation> _testProposed(
    BrokerProfile profile,
    BrokerAddress address,
    BrokerProxyProfile? proxy,
    BrokerProxyCredentials? secret, {
    String? approvedIdentity,
  }) async {
    final state = await _server(profile);
    final epoch = state.epoch;
    return _queue.run(() async {
      if (_disposed || epoch != state.epoch) {
        throw const BrokerRouteException('CONNECTION_RETIRED');
      }
      final context = BrokerRouteContext(
        profileId: profile.id,
        incarnation: profile.incarnationId!,
        origin: address.origin,
        routeId: address.id,
        routeGeneration: address.generation,
        networkGeneration: _networkGeneration,
        identityPublicKey: state.server.identityPublicKey,
        principalId: state.server.principalId,
        proxyId: proxy?.id ?? address.proxyId,
        proxy: proxy,
        proxyCredentials: secret,
      );
      final transport = BrokerRouteTransport(
        context,
        httpOverride: httpOverride,
        socketOverride: socketOverride,
      );
      final key = 'proposed:${address.id}';
      BrokerRouteProbe? probe;
      try {
        final credential = await _credential(profile, address.origin);
        if (_disposed || epoch != state.epoch) {
          throw const BrokerRouteException('CONNECTION_RETIRED');
        }
        probe = BrokerRouteProbe(
          transport: transport,
          credentials: credential,
          expectedIdentity: approvedIdentity ?? state.server.identityPublicKey,
          expectedPrincipal: state.server.principalId,
          now: now,
          monotonicNow: monotonicNow,
        );
        state.probes[key]?.cancel();
        state.probes[key] = probe;
        final observation = await probe.run();
        if (_disposed || epoch != state.epoch) {
          throw const BrokerRouteException('CONNECTION_RETIRED');
        }
        return observation;
      } finally {
        if (identical(state.probes[key], probe)) state.probes.remove(key);
        transport.retire();
      }
    });
  }

  Future<BrokerRouteObservation> _test(
    _ServerRoutes state,
    BrokerAddress address, {
    String? approvedIdentity,
    bool full = false,
    bool select = false,
  }) {
    final existing = state.attempts[address.id];
    if (existing != null) return existing;
    final epoch = state.epoch;
    final attempt = _queue.run(() async {
      if (_disposed || epoch != state.epoch) {
        throw const BrokerRouteException('CONNECTION_RETIRED');
      }
      final transport = await _transport(state, address);
      final context = transport.context;
      final proxyKey = context.proxyId == null
          ? null
          : '${context.proxyId}:${context.proxy?.generation}:'
                '${context.networkGeneration}';
      final backoff = _proxyFailures[proxyKey];
      if (backoff != null && now().isBefore(backoff.until)) {
        throw const BrokerRouteException('PROXY_BACKOFF');
      }
      final credential = await _credential(state.profile, address.origin);
      if (_disposed || epoch != state.epoch || transport.retired) {
        throw const BrokerRouteException('CONNECTION_RETIRED');
      }
      final probe = BrokerRouteProbe(
        transport: transport,
        credentials: credential,
        expectedIdentity: approvedIdentity ?? state.server.identityPublicKey,
        expectedPrincipal: state.server.principalId,
        freshReadiness: full ? null : state.observations[address.id],
        now: now,
        monotonicNow: monotonicNow,
        onReady: (observation) {
          if (epoch != state.epoch || _disposed) return;
          state.observations[address.id] = observation;
          state.failures.remove(address.id);
          if (select && state.active == null) {
            unawaited(
              _commit(state, transport, latency: false).catchError((
                Object error,
              ) {
                if (epoch == state.epoch) state.failures[address.id] = error;
              }),
            );
          }
          _changed();
        },
      );
      state.probes[address.id] = probe;
      try {
        final observation = await probe.run();
        if (epoch != state.epoch || _disposed) {
          throw const BrokerRouteException('CONNECTION_RETIRED');
        }
        state.observations[address.id] = observation;
        state.failures.remove(address.id);
        if (proxyKey != null) _proxyFailures.remove(proxyKey);
        return observation;
      } on Object catch (error) {
        if (epoch == state.epoch && !_disposed) {
          final cause = error is DioException ? error.error : error;
          final sharedFailure =
              error is DioException && error.response?.statusCode == 407 ||
              cause is BrokerRouteException &&
                  {
                    'PROXY_UNREACHABLE',
                    'PROXY_AUTHENTICATION_REQUIRED',
                  }.contains(cause.code);
          if (proxyKey != null && sharedFailure) {
            final failures = (_proxyFailures[proxyKey]?.failures ?? 0) + 1;
            if (_proxyFailures.length >= 64 &&
                !_proxyFailures.containsKey(proxyKey)) {
              _proxyFailures.remove(_proxyFailures.keys.first);
            }
            _proxyFailures[proxyKey] = (
              until: now().add(
                Duration(seconds: min(30, 1 << min(failures, 5))),
              ),
              failures: failures,
            );
          }
          state.failures[address.id] = error;
          state.observations.remove(address.id);
        }
        rethrow;
      } finally {
        if (identical(state.probes[address.id], probe)) {
          state.probes.remove(address.id);
        }
      }
    });
    state.attempts[address.id] = attempt;
    void complete() {
      if (identical(state.attempts[address.id], attempt)) {
        state.attempts.remove(address.id);
      }
      _changed();
    }

    unawaited(
      attempt.then<void>(
        (_) {
          complete();
        },
        onError: (Object error, StackTrace _) {
          if (epoch == state.epoch && !_disposed) {
            state.failures[address.id] = error;
            state.observations.remove(address.id);
          }
          complete();
        },
      ),
    );
    _changed();
    return attempt;
  }

  Future<void> _round(
    _ServerRoutes state, {
    bool explicit = false,
    bool alternates = true,
  }) {
    final existing = state.round;
    if (existing != null) {
      if (alternates && !state.roundIncludesAlternates) {
        final epoch = state.epoch;
        return existing.then<void>((_) async {
          if (epoch != state.epoch || _disposed) return;
          await _round(state, explicit: explicit);
        });
      }
      return existing;
    }
    state.roundIncludesAlternates = alternates;
    late final Future<void> work;
    work = _runRound(state, explicit: explicit, alternates: alternates)
        .whenComplete(() {
          if (identical(state.round, work)) state.round = null;
        });
    return state.round = work;
  }

  Future<void> _runRound(
    _ServerRoutes state, {
    bool explicit = false,
    bool alternates = true,
  }) async {
    if (_disposed || state.revoked || (!_foreground && !explicit)) return;
    final epoch = state.epoch;
    // Old brokers have no identity-proof endpoint. Rebind their original
    // trusted address after a network generation change, while leaving ordinary
    // socket retries to the existing session reconnect policy.
    if (!explicit && state.server.principalId == null) {
      // A caller may already have rebound the address while this server was
      // in the background; the clients on the retired one still need telling.
      if (state.active != null &&
          !state.active!.retired &&
          !state.retiredUnannounced) {
        return;
      }
      try {
        await resolve(state.profile);
        if (_disposed || epoch != state.epoch) return;
        await _announce(state);
      } on Object catch (error) {
        if (_disposed || epoch != state.epoch) return;
        state.failures['legacy'] = error;
        state.phase = BrokerRoutePhase.offline;
        _scheduleRetry(state);
      }
      _changed();
      return;
    }
    final routes = _ordered(state);
    state
      ..lastRound = now()
      ..phase =
          state.active == null ||
              state.phase == BrokerRoutePhase.recovering ||
              state.phase == BrokerRoutePhase.offline
          ? BrokerRoutePhase.recovering
          : BrokerRoutePhase.evaluating;
    final selected = alternates ? routes : routes.take(1);
    final completed = <String>{};
    final considered = <String>{};
    void completedRoute(String id) {
      if (_disposed || epoch != state.epoch) return;
      completed.add(id);
      // A faster route normally completes before the current route. Compare
      // their completed samples from this round, never a first-sample snapshot
      // that temporarily replaced the current route's previous median.
      if (!completed.contains(state.active?.context.routeId)) return;
      for (final candidate in completed) {
        if (candidate == state.active?.context.routeId ||
            !considered.add(candidate)) {
          continue;
        }
        // Mutation draining owns no probe slot and cannot delay recovery.
        unawaited(
          _consider(state, candidate).catchError((Object error) {
            if (epoch == state.epoch && !_disposed) {
              state.failures[candidate] = error;
              _changed();
            }
          }),
        );
      }
    }

    await Future.wait([
      for (final route in selected)
        _test(
          state,
          route,
          full: state.active == null,
          select: true,
        ).then<void>(
          (_) => completedRoute(route.id),
          onError: (Object _, StackTrace _) {},
        ),
    ]);
    if (_disposed || epoch != state.epoch) return;
    if (state.preparingRoute == null && state.switching == null) {
      // A server's only route stays bound while it is down, so its own check
      // decides the status; alternates are judged by the switch above.
      final active = state.active;
      final unanswered =
          active != null &&
          routes.length < 2 &&
          !state.observations.containsKey(active.context.routeId);
      state.phase = active == null || unanswered
          ? BrokerRoutePhase.offline
          : BrokerRoutePhase.connected;
      if (unanswered) {
        _scheduleRetry(state);
      } else if (active != null && routes.length < 2) {
        state.backoff = 0;
      }
    }
    if (state.active == null) {
      final pending = state.firstReady;
      state.firstReady = null;
      if (pending != null && !pending.isCompleted) {
        pending.completeError(const BrokerRouteException('NO_READY_ADDRESS'));
      }
      _scheduleRetry(state);
    }
    _changed();
  }

  Future<void> _consider(_ServerRoutes state, String routeId) async {
    if (state.server.mode == BrokerRouteMode.fixed &&
        routeId != state.server.fixedRouteId) {
      return;
    }
    final candidate = state.observations[routeId];
    if (candidate == null || !candidate.fresh(now())) return;
    final active = state.active;
    if (active == null) {
      await _commit(state, state.transports[routeId]!, latency: false);
      return;
    }
    if (active.context.routeId == routeId) return;
    final current = state.observations[active.context.routeId];
    final score = candidate.medianMilliseconds;
    final oldScore = current?.medianMilliseconds;
    if (current == null ||
        !current.fresh(now()) ||
        score == null ||
        oldScore == null ||
        oldScore - score < 20 ||
        score > oldScore * 0.8) {
      state.fasterRounds[routeId] = 0;
      return;
    }
    final rounds = (state.fasterRounds[routeId] ?? 0) + 1;
    state.fasterRounds[routeId] = rounds;
    if (rounds < 2 ||
        (state.lastLatencySwitch != null &&
            now().difference(state.lastLatencySwitch!) <
                const Duration(seconds: 30))) {
      return;
    }
    // This probe may have reused readiness for latency. Require a fresh proof
    // and WS check in preparation, while the working route continues serving.
    if (state.preparingRoute != null) return;
    final epoch = state.epoch;
    state
      ..preparingRoute = routeId
      ..phase = BrokerRoutePhase.preparing;
    final transport = state.transports[routeId]!;
    final address = state.server.addresses.firstWhere((a) => a.id == routeId);
    try {
      final observation = await _test(state, address, full: true);
      if (_disposed || epoch != state.epoch || transport.retired) return;
      state.observations[routeId] = observation;
      await _commit(state, transport, latency: true);
    } finally {
      if (epoch == state.epoch) {
        state.preparingRoute = null;
        if (state.phase == BrokerRoutePhase.preparing) {
          state.phase = state.active == null
              ? BrokerRoutePhase.offline
              : BrokerRoutePhase.connected;
        }
      }
    }
  }

  Future<void> _commit(
    _ServerRoutes state,
    BrokerRouteTransport next, {
    required bool latency,
  }) async {
    if (state.switching != null) return state.switching;
    if (state.active == next || state.revoked || next.retired) return;
    final epoch = state.epoch;
    void Function()? releaseMutations;
    void requireCurrent() {
      if (_disposed || epoch != state.epoch || next.retired) {
        throw const BrokerRouteException('CONNECTION_RETIRED');
      }
    }

    Future<void> commit() async {
      final old = state.active;
      if (latency && old != null) {
        releaseMutations = old.pauseMutations();
        await old.mutationsSettled;
      }
      if (_disposed || epoch != state.epoch || next.retired) return;
      state
        ..phase = BrokerRoutePhase.switching
        ..active = next;
      try {
        final server = await store.read(
          state.profile.id,
          state.profile.incarnationId!,
        );
        requireCurrent();
        if (server == null) {
          throw const BrokerRouteException('CONNECTION_RETIRED');
        }
        final updated = server.copyWith(
          lastSuccessfulRouteId: next.context.routeId,
        );
        await store.save(updated, expectedGeneration: server.generation);
        requireCurrent();
        state.server = updated.copyWith(generation: server.generation + 1);
        // The initial caller is already waiting for this context. Invalidating
        // its provider here would dispose that construction before completion.
        // A replacement for a retired generation is announced regardless.
        if (old != null ||
            state.firstReady == null ||
            state.retiredUnannounced) {
          await _announce(state);
          requireCurrent();
        }
      } on Object {
        if (epoch == state.epoch && !_disposed) {
          state
            ..active = old?.retired ?? true ? null : old
            ..phase = state.active == null
                ? BrokerRoutePhase.offline
                : BrokerRoutePhase.connected;
        }
        rethrow;
      }
      state
        ..phase = BrokerRoutePhase.connected
        ..backoff = 0
        ..softFailures = 0;
      state.retry?.cancel();
      state.retry = null;
      if (latency) state.lastLatencySwitch = now();
      state.fasterRounds.clear();
      if (old != null && old != next) {
        old.retire(allowPinned: latency);
        // Keep draining media generations until profile retirement so a later
        // sign-out or proxy edit can still close their pinned resources.
        state.draining.add(old);
        old.whenDrained(() => state.draining.remove(old));
        state.transports.remove(old.context.routeId);
        state.observations.remove(old.context.routeId);
      }
      final ready = state.firstReady;
      state.firstReady = null;
      if (ready != null && !ready.isCompleted) ready.complete(next);
      _changed();
    }

    final future = state.switching = commit();
    try {
      await future;
    } finally {
      releaseMutations?.call();
      state.switching = null;
    }
  }

  /// Only failed transport liveness/abnormal WS closure enters this path.
  /// Ordinary API refusal or slow agent work cannot declare a route dead.
  Future<void> transportFailed(
    BrokerProfile profile, {
    required bool hard,
  }) async {
    final state = await _server(profile);
    if (state.server.principalId == null || state.revoked) return;
    if (!hard && ++state.softFailures < 2) return;
    final old = state.active;
    if (old != null) {
      old.retire();
      state
        ..active = null
        ..retiredUnannounced = true;
      state.observations.remove(old.context.routeId);
    }
    // A recently authenticated alternate already passed its WS check. It can
    // recover immediately even if another address occupies a hanging slot.
    for (final address in _ordered(state)) {
      final observation = state.observations[address.id];
      final ready = state.transports[address.id];
      if (ready != null &&
          !ready.retired &&
          observation != null &&
          observation.fresh(now())) {
        await _commit(state, ready, latency: false);
        break;
      }
    }
    // Schedule all candidates fairly. Their readiness callbacks can commit
    // immediately without waiting for an earlier, hanging candidate to finish.
    await _round(state);
  }

  void _scheduleRetry(_ServerRoutes state) {
    if (!_foreground ||
        state.revoked ||
        state.retry != null ||
        !_relevant(state)) {
      return;
    }
    final seconds = min(30, 1 << min(state.backoff++, 5));
    final jitter = Random().nextInt(101);
    state.retry = Timer(Duration(milliseconds: seconds * 1000 + jitter), () {
      state.retry = null;
      if (!_disposed && _foreground && _relevant(state)) {
        unawaited(_round(state));
      }
    });
  }

  /// Starts/stops address-view cadence without activating another server.
  Future<void> visible(BrokerProfile profile, {required bool visible}) async {
    final state = visible ? await _server(profile) : _servers[_key(profile)];
    if (state == null) return;
    state.visible = visible;
    _scheduleRefresh();
  }

  /// A live session consumer remains relevant while its transport is down.
  Future<void Function()> retainSession(BrokerProfile profile) async {
    final state = await _server(profile);
    state.liveSessions++;
    _scheduleRefresh();
    var released = false;
    return () {
      if (released) return;
      released = true;
      state.liveSessions = max(0, state.liveSessions - 1);
      _scheduleRefresh();
    };
  }

  /// Pauses alternate probing while the app is backgrounded.
  void foreground({required bool value}) {
    _foreground = value;
    if (!value) {
      for (final state in _servers.values) {
        state.retry?.cancel();
        state.retry = null;
        for (final probe in state.probes.values) {
          probe.cancel();
        }
      }
    } else {
      for (final state in _servers.values.where(_relevant)) {
        unawaited(_round(state));
      }
    }
    _scheduleRefresh();
  }

  /// Invalidates old network observations and rechecks relevant servers only.
  void networkChanged() {
    _networkGeneration++;
    _proxyFailures.clear();
    for (final state in _servers.values) {
      final relevant = _relevant(state);
      final preserveActive =
          _usable(state).length == 1 &&
          state.switching == null &&
          state.active != null &&
          !state.active!.retired;
      // Configuration and credential edits rebuild their own clients; nothing
      // else tells the clients on a generation a network change retired.
      if (!preserveActive && state.active != null) {
        state.retiredUnannounced = true;
      }
      _retire(state, preserveActive: preserveActive);
      if (preserveActive) {
        // The same route may now take another path. Nothing may keep waiting
        // on connections the old network carried.
        _recheck(state, failed: false);
      } else if (_foreground && relevant) {
        unawaited(_round(state));
      }
    }
    _changed();
  }

  void _scheduleRefresh() {
    _refresh?.cancel();
    _refresh = null;
    if (!_foreground || _disposed) return;
    Duration? next;
    for (final state in _servers.values) {
      if (state.revoked ||
          state.server.principalId == null ||
          (!state.visible &&
              (state.liveSessions == 0 || state.server.addresses.length < 2))) {
        continue;
      }
      final cadence = Duration(seconds: state.visible ? 15 : 60);
      final age = state.lastRound == null
          ? Duration.zero
          : now().difference(state.lastRound!);
      final remaining = cadence - age;
      final due = remaining.isNegative ? Duration.zero : remaining;
      if (next == null || due < next) next = due;
    }
    if (next == null) return;
    _refresh = Timer(next, () async {
      final rounds = <Future<void>>[];
      for (final state in _servers.values) {
        if (state.revoked ||
            state.server.principalId == null ||
            (!state.visible &&
                (state.liveSessions == 0 ||
                    state.server.addresses.length < 2))) {
          continue;
        }
        final cadence = Duration(seconds: state.visible ? 15 : 60);
        if (state.lastRound == null ||
            now().difference(state.lastRound!) >= cadence) {
          rounds.add(_round(state));
        }
      }
      await Future.wait(rounds);
      _scheduleRefresh();
    });
  }

  /// Revalidate loaded dependents after proxy publication or deletion. Dormant
  /// saved servers read the current profile only when next explicitly used.
  Future<void> proxyChanged(String proxyId) async {
    final dependents = (await store.proxyDependents(
      proxyId,
    )).map((dependent) => dependent.$1).toSet();
    for (final state in _servers.values.toList()) {
      if (_disposed) return;
      if (identical(_servers[_key(state.profile)], state) &&
          dependents.contains(state.profile.id)) {
        await configurationChanged(state.profile);
      }
    }
  }

  /// Reload committed edits, invalidate observations and fence older callbacks.
  Future<void> configurationChanged(BrokerProfile profile) async {
    final state = await _server(profile);
    final server = await store.read(profile.id, profile.incarnationId!);
    if (server == null) {
      retireProfile(profile);
      return;
    }
    _retire(state);
    state
      ..server = server
      ..profile = profile
      ..revoked = false;
    await _announce(state);
    _changed();
  }

  /// Labels do not invalidate a working connection or its measurements.
  Future<void> labelsChanged(BrokerProfile profile) async {
    final state = await _server(profile);
    final server = await store.read(profile.id, profile.incarnationId!);
    if (server != null) {
      state.server = server;
      for (final entry in [...state.transports.entries]) {
        final configured = server.addresses
            .where((a) => a.id == entry.key)
            .firstOrNull;
        final context = entry.value.context;
        if ((configured == null ||
                configured.origin != context.origin ||
                configured.generation != context.routeGeneration ||
                configured.proxyId != context.proxyId) &&
            !identical(entry.value, state.active)) {
          entry.value.retire();
          state.transports.remove(entry.key);
          state.observations.remove(entry.key);
        }
      }
    }
    _changed();
  }

  /// Tells the clients built on this server's earlier generations to rebuild.
  Future<void> _announce(_ServerRoutes state) {
    state.retiredUnannounced = false;
    return onSwitch(state.profile);
  }

  void _retire(_ServerRoutes state, {bool preserveActive = false}) {
    final active = preserveActive ? state.active : null;
    state.epoch++;
    state.round = null;
    for (final probe in state.probes.values) {
      probe.cancel();
    }
    if (active == null) state.active?.retire();
    for (final transport in [...state.draining]) {
      transport.retire();
    }
    state.draining.clear();
    for (final transport in state.transports.values) {
      if (!identical(transport, active)) transport.retire();
    }
    state.probes.clear();
    state.transports.clear();
    if (active != null) state.transports[active.context.routeId] = active;
    state.observations.clear();
    state.attempts.clear();
    state.fasterRounds.clear();
    state
      ..preparingRoute = null
      ..active = active;
    state.retry?.cancel();
    state
      ..retry = null
      ..phase = active == null
          ? BrokerRoutePhase.offline
          : BrokerRoutePhase.connected;
    final waiting = state.firstReady;
    state.firstReady = null;
    if (waiting != null && !waiting.isCompleted) {
      waiting.completeError(const BrokerRouteException('CONNECTION_RETIRED'));
    }
  }

  /// A saved token changed or was removed. No previously authenticated pool
  /// may survive even when the opaque secure-store reference is unchanged.
  void authorizationChanged(BrokerProfile profile) {
    final state = _servers[_key(profile)];
    if (state != null) {
      state.authGeneration++;
      _retire(state);
      state.revoked = false;
    }
    _changed();
  }

  /// Cancels this incarnation and fences loaders and delayed callbacks.
  void retireProfile(BrokerProfile profile) {
    final key = _key(profile);
    _loading.remove(key);
    final state = _servers.remove(key);
    if (state != null) _retire(state);
    _scheduleRefresh();
    _changed();
  }

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _refresh?.cancel();
    for (final state in _servers.values) {
      _retire(state);
    }
    _servers.clear();
    super.dispose();
  }
}
