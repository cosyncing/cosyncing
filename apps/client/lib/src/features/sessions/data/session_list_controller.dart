import 'dart:async';
import 'dart:developer' as developer;

import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/broker_profiles/model/broker_profile.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/controller/new_session_controller.dart';
import 'package:cosyncing_client/src/features/sessions/data/broker_client_session_list_repository.dart';
import 'package:cosyncing_client/src/features/sessions/data/in_memory_session_list_repository.dart';
import 'package:cosyncing_client/src/features/sessions/data/roster_snapshot_store.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_cache_write_fence.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_list_repository.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_roster_window_controller.dart';
import 'package:cosyncing_client/src/features/sessions/data/session_status_registry.dart';
import 'package:cosyncing_client/src/features/sessions/model/session_roster_identity.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Provides the [SessionListRepository] singleton.
///
/// Override this provider in tests to inject a fake repository.
final sessionListRepositoryProvider = FutureProvider<SessionListRepository>(
  (ref) async {
    // Route entry can precede active-profile hydration. Waiting here prevents
    // the temporary null client from being published as an authoritative
    // empty in-memory roster for one frame.
    await ref.watch(activeBrokerProfileHydrationProvider.future);
    final client = await ref.watch(brokerClientProvider.future);
    if (client == null) {
      return InMemorySessionListRepository();
    }
    return BrokerClientSessionListRepository(brokerClient: client);
  },
);

/// Controller for the session list screen.
///
/// Manages loading, refreshing, and error states for the session list.
/// Screens dispatch intents; this controller owns the lifecycle.
/// The screen must call [load] on mount to trigger the initial fetch.
///
/// References:
/// - `docs/architecture/monorepo.md`
class SessionListController extends Notifier<SessionListState> {
  bool _inFlight = false;
  bool _feedActive = false;
  bool _feedUnsupported = false;
  int _feedGeneration = 0;
  SessionListRepository? _repository;
  LiveSessionListRepository? _liveRepository;
  _RosterLifecycleObserver? _lifecycleObserver;
  AppLifecycleState _lifecycleState = AppLifecycleState.resumed;
  SessionRosterQueryWindow _queryWindow = SessionRosterQueryWindow.last7Days;
  SessionRosterQueryWindow? _revisionWindow;

  /// Exact project directories with a display-alias mutation in flight.
  final Set<String> _projectRenamesInFlight = <String>{};

  /// Bumped on every `_load`, so a slow local snapshot read or a slow snapshot
  /// write from a superseded load can never publish or persist.
  int _loadGeneration = 0;

  /// Roster source whose snapshot this controller has already read. The
  /// snapshot is read ONCE per source, inside the existing initial load — never
  /// on a refresh, a delta reset, or a poll.
  RosterSource? _snapshotReadSource;

  /// The single in-flight (or completed) read for [_snapshotReadSource].
  ///
  /// Startup genuinely runs concurrent loads — the workspace mounts one, and
  /// broker-client resolution can start another — so "read once" cannot be a
  /// flag set before the await: the second load would see the source already
  /// marked, skip the read, and the first load's result would then be discarded
  /// as stale, leaving the cache unpublished by BOTH. Every load awaits this
  /// shared future instead, and the database is still read exactly once.
  Future<SessionRosterSnapshot?>? _snapshotRead;

  /// Set once the controller is torn down, so an in-flight local read/write
  /// resolving afterwards touches nothing.
  bool _disposed = false;

  /// Whether the roster has moved past the durable snapshot.
  bool _snapshotDirty = false;

  late SessionCacheWriteFence _cacheWriteFence;

  /// Cache generation of the latest change represented by [_snapshotDirty].
  SessionCacheWriteAdmission? _snapshotDirtyAdmission;

  /// The single in-flight coalesced snapshot write, if one is running.
  ///
  /// EVERY durable write goes through it — the authoritative response and the
  /// delta feed alike. Two writers would have no ordering: a quick delta save
  /// could land revision 2 while a slower full-response save was still open,
  /// and that older save would then overwrite the snapshot with revision 1.
  /// One writer, always persisting current state, cannot invert.
  Future<void>? _snapshotWrite;

  @override
  SessionListState build() {
    _cacheWriteFence = ref.read(sessionCacheWriteFenceProvider);
    final binding = WidgetsFlutterBinding.ensureInitialized();
    final observer = _lifecycleObserver ??= _RosterLifecycleObserver(
      onChanged: _handleLifecycleChanged,
    );
    binding.addObserver(observer);
    _lifecycleState = binding.lifecycleState ?? AppLifecycleState.resumed;
    _disposed = false;
    ref
      ..onDispose(() {
        _disposed = true;
        _cacheWriteFence.release(_snapshotDirtyAdmission);
        _snapshotDirtyAdmission = null;
        binding.removeObserver(observer);
        _stopFeed();
      })
      // A source change invalidates the roster the instant it happens, not when
      // the new broker's client finishes resolving. Waiting would leave the
      // PREVIOUS broker's sessions on screen under the new source's name, and
      // would also block the new source's cached identity — the snapshot read
      // is gated on there being no authoritative rows.
      //
      // The comparison is on the whole source, not the profile id: editing the
      // active profile's URL keeps its id, so an id-only check would keep
      // showing (and keep caching) the previous broker's roster under a profile
      // that now points somewhere else entirely.
      ..listen<BrokerProfile?>(activeBrokerProfileProvider, (previous, next) {
        final nextSource = RosterSource.of(next);
        if (RosterSource.of(previous) == nextSource) return;
        _handleSourceChanged(nextSource);
      })
      ..listen<AsyncValue<SessionRosterQueryWindow>>(
        sessionRosterWindowProvider,
        (previous, next) {
          final window = next.valueOrNull;
          if (window == null || window == _queryWindow) return;
          _queryWindow = window;
          _snapshotReadSource = null;
          _snapshotRead = null;
          _stopFeed(keepRepository: true);
          if (state.status == SessionListStatus.loaded) {
            unawaited(load());
          }
        },
      );
    return SessionListState(
      source: RosterSource.of(ref.read(activeBrokerProfileProvider)),
    );
  }

  /// Drops every roster fact belonging to the source being left.
  ///
  /// Bumping the load generation is what makes any in-flight fetch, snapshot
  /// read or snapshot write from the old source inert: each re-checks the
  /// generation before it publishes or persists.
  void _handleSourceChanged(RosterSource? source) {
    _loadGeneration++;
    _stopFeed();
    _repository = null;
    _revisionWindow = null;
    _snapshotReadSource = null;
    _snapshotRead = null;
    _snapshotDirty = false;
    _cacheWriteFence.release(_snapshotDirtyAdmission);
    _snapshotDirtyAdmission = null;
    // The shared status owner is profile-qualified too: the previous broker's
    // Working/Idle facts must not survive into the new broker's roster.
    ref.read(sessionStatusRegistryProvider.notifier).adoptSource(source);
    state = SessionListState(source: source);
  }

  /// Publishes an authoritative roster revision into the single status owner.
  ///
  /// The roster is the *slower* of the two authoritative sources — a live
  /// session frame reaches its own socket first — so this only ever installs a
  /// status the registry's `(revision, sequence)` ordering accepts.
  void _publishStatuses(RosterSource? source, int revision) {
    ref
        .read(sessionStatusRegistryProvider.notifier)
        .publishRoster(
          source: source,
          revision: revision,
          sessions: state.sessions,
        );
  }

  /// The roster source currently selected, read fresh from the profile.
  RosterSource? get _activeSource =>
      RosterSource.of(ref.read(activeBrokerProfileProvider));

  /// Whether work started under [source] at [generation] may still publish.
  ///
  /// Three independent ways to be stale, all of which a slow broker request can
  /// hit: the controller was torn down, a newer load superseded this one, or
  /// the active broker changed while the request was outstanding. The last is
  /// not implied by the second — the profile listener is delivered
  /// asynchronously, so a response can land in the window between the switch
  /// and the invalidation it triggers.
  bool _isStale(int generation, RosterSource? source) {
    if (_disposed || generation != _loadGeneration) return true;
    return source != null && _activeSource != source;
  }

  /// Loads sessions from the repository.
  ///
  /// Transitions: any → loading → loaded/error.
  ///
  /// [silent] suppresses the visible loading/refreshing transition and skips
  /// the call entirely when a load is already in flight. Background refreshes
  /// (the roster poll) pass `true` so the "Updating…" affordance stays reserved
  /// for user-initiated loads and slow polls cannot stack.
  Future<void> load({bool silent = false}) async {
    // Existing workspace timers may still call the compatibility refresh.
    // Once the delta feed is healthy, those ticks perform no HTTP request.
    if (silent && _feedActive) return;
    if (silent && _inFlight) return;
    _inFlight = true;
    try {
      await _load(silent: silent);
    } finally {
      _inFlight = false;
    }
  }

  /// Changes one directory-backed project's display alias.
  ///
  /// The mutation is bound to the exact active [RosterSource]. A profile can
  /// be repointed while the PATCH is in flight, so both the client resolution
  /// and the response are requalified before they can change roster state.
  Future<bool> renameProject({
    required String cwd,
    required String name,
  }) async {
    final normalizedCwd = cwd.trim();
    if (normalizedCwd.isEmpty || normalizedCwd.contains('\u0000')) return false;
    if (!_projectRenamesInFlight.add(normalizedCwd)) return false;
    try {
      final source = state.source;
      if (source == null || _activeSource != source) return false;
      final client = await ref.read(brokerClientProvider.future);
      if (client == null || state.source != source || _activeSource != source) {
        return false;
      }
      final normalizedName = name.trim();
      final response = await client.renameProject(
        normalizedCwd,
        normalizedName.isEmpty ? null : normalizedName,
      );
      if (!response.ok ||
          response.cwd != normalizedCwd ||
          state.source != source ||
          _activeSource != source) {
        return false;
      }
      final sessions = [
        for (final session in state.sessions)
          if (session.cwd == normalizedCwd)
            SessionInfo.fromJson({
              ...session.toJson(),
              'projectName': response.projectName,
            })
          else
            session,
      ];
      state = state.copyWith(sessions: sessions);
      _markSnapshotDirty();
      return true;
    } on Object catch (error) {
      developer.log(
        'project rename failed',
        name: 'cosyncing.sessions',
        error: error,
      );
      return false;
    } finally {
      _projectRenamesInFlight.remove(normalizedCwd);
    }
  }

  /// Applies an accepted native session title to the authoritative roster row.
  ///
  /// Only the title changes: the rename response must not overwrite fresher
  /// status, control, model, or project facts already held by the roster.
  void renameSessionTitle(String tool, String id, String title) {
    if (_disposed) return;
    final index = state.sessions.indexWhere(
      (session) => session.tool == tool && session.id == id,
    );
    if (index < 0 || state.sessions[index].title == title) return;
    final sessions = [...state.sessions];
    final existing = sessions[index];
    sessions[index] = SessionInfo.fromJson({
      ...existing.toJson(),
      'title': title,
    });
    state = state.copyWith(sessions: sessions);
    _markSnapshotDirty();
  }

  Future<void> _load({required bool silent, bool acceptReset = false}) async {
    final totalTimer = Stopwatch()..start();
    final repositoryTimer = Stopwatch()..start();
    Stopwatch? fetchTimer;
    var fetchDuration = Duration.zero;
    final generation = ++_loadGeneration;
    final prevStatus = state.status;
    // Hoisted so the failure path can apply the same source guard as the
    // success path: an error from the broker the user just left must not be
    // published over the broker they just chose.
    var loadSource = state.source;
    if (!silent || prevStatus != SessionListStatus.loaded) {
      state = state.copyWith(
        status: prevStatus == SessionListStatus.loaded
            ? SessionListStatus.refreshing
            : SessionListStatus.loading,
      );
    }

    try {
      // Resolve the durable choice before touching either cache or broker. A
      // saved Any-time snapshot must not be opened under the fresh-install
      // seven-day default for one startup frame and discarded as foreign.
      _queryWindow =
          ref.read(sessionRosterWindowProvider).valueOrNull ??
          await ref.read(sessionRosterWindowProvider.future);
      final requestWindow = _queryWindow;
      if (_isStale(generation, loadSource)) return;
      // LOCAL FIRST (N3). The cached roster exists to fill the seconds spent
      // building the broker client, reading its credential out of secure
      // storage and opening the socket — all of which sit behind
      // `sessionListRepositoryProvider` below. Reading the snapshot after that
      // would make it unavailable for the entire wait it was built for, and
      // completely unavailable offline.
      //
      // So the read starts as early as the profile can possibly be known, and
      // never delays the load: if the active profile is already hydrated (every
      // profile switch, and every load after the first) it starts right now;
      // otherwise it starts the moment hydration resolves, which still precedes
      // client construction because the repository provider awaits the same
      // hydration before it begins building anything.
      final activeSource = _activeSource;
      if (activeSource != null) {
        loadSource = activeSource;
        if (state.source != activeSource) {
          state = state.copyWith(source: activeSource);
        }
        unawaited(_publishCachedIdentity(generation, activeSource));
      } else {
        unawaited(_publishAfterProfileHydration(generation));
      }

      final repository = await ref.read(sessionListRepositoryProvider.future);
      if (_isStale(generation, loadSource)) return;
      // Hydration has necessarily completed by now, so this is the load's
      // authoritative source for the write path below.
      final source = _activeSource;
      loadSource = source ?? loadSource;
      if (source != null && state.source != source) {
        state = state.copyWith(source: source);
      }
      final repositoryChanged = !identical(repository, _repository);
      if (repositoryChanged) {
        // A broker/profile switch establishes a new revision namespace. Stop
        // the prior feed before fetching so it cannot race the new snapshot.
        _stopFeed();
      }
      repositoryTimer.stop();
      fetchTimer = Stopwatch()..start();
      final force = !silent && prevStatus == SessionListStatus.loaded;
      final statusRegistry = ref.read(
        sessionStatusRegistryProvider.notifier,
      );
      final revisionAdmission = statusRegistry.captureRevisionAdmission();
      final response = repository is WindowedSessionListRepository
          ? await repository.fetchSessionsWindowed(
              window: requestWindow.queryValue,
              force: force,
            )
          : await repository.fetchSessions(force: force);
      fetchTimer.stop();
      fetchDuration = fetchTimer.elapsed;
      // A roster request is the longest await in this method, and the user can
      // switch broker part-way through it. Everything below MUTATES shared
      // state — the rows, the repository the delta feed adopts, the durable
      // snapshot — so the source is revalidated here, once, before any of it.
      if (_isStale(generation, source)) {
        totalTimer.stop();
        _logLoadTiming(
          outcome: 'superseded',
          total: totalTimer.elapsed,
          repositoryResolution: repositoryTimer.elapsed,
          fetch: fetchDuration,
        );
        return;
      }
      _repository = repository;
      final snapshotRevision = response.revision ?? 0;
      final revisionNamespaceChanged = _revisionWindow != requestWindow;
      var replacedRoster = false;
      if (acceptReset ||
          repositoryChanged ||
          revisionNamespaceChanged ||
          snapshotRevision >= state.revision) {
        if (revisionNamespaceChanged || acceptReset) {
          statusRegistry.resetRevisionNamespace(
            source: source,
            revision: snapshotRevision,
            preserveLiveAfterSequence: revisionAdmission,
          );
        }
        // Atomic swap: the authoritative rows and the removal of the cached
        // ones are ONE assignment, so no frame can show both or neither.
        state = SessionListState(
          status: SessionListStatus.loaded,
          sessions: response.sessions,
          machine: response.machine,
          revision: snapshotRevision,
          source: source,
        );
        replacedRoster = true;
        _revisionWindow = requestWindow;
      } else {
        state = state.copyWith(
          status: SessionListStatus.loaded,
          clearCachedRoster: true,
        );
      }
      _publishStatuses(source, state.revision);
      _adoptLiveRepository(repository);
      if (replacedRoster) {
        // Through the same serialized writer as the delta feed, which the line
        // above may have just started. Persisting `response.sessions` directly
        // here would race it, and the loser would be whichever save happened to
        // finish last — not the newer roster.
        //
        // Not awaited, for the same reason the feed does not await it: the
        // roster is already on screen, and a durable write — to this source or
        // to one the user has left — must never be able to hold a load open.
        _markSnapshotDirty();
      }
      totalTimer.stop();
      _logLoadTiming(
        outcome: 'loaded',
        total: totalTimer.elapsed,
        repositoryResolution: repositoryTimer.elapsed,
        fetch: fetchDuration,
      );
    } on Object catch (e) {
      repositoryTimer.stop();
      fetchTimer?.stop();
      fetchDuration = fetchTimer?.elapsed ?? Duration.zero;
      totalTimer.stop();
      // Same guard as the success path. A broker that fails slowly is the most
      // likely one to be abandoned mid-request, and publishing its error over
      // the newly chosen broker would blame the wrong one and replace a healthy
      // roster with an error pane.
      if (_isStale(generation, loadSource)) {
        _logLoadTiming(
          outcome: 'superseded-error',
          total: totalTimer.elapsed,
          repositoryResolution: repositoryTimer.elapsed,
          fetch: fetchDuration,
          error: e,
        );
        return;
      }
      // A background poll that fails must not tear down a roster the user is
      // reading — a flaky tick would otherwise replace the list with an error
      // pane. Keep the last good state; the next tick (or a user-initiated
      // load) surfaces a persistent outage.
      final keepLastGood = silent && prevStatus == SessionListStatus.loaded;
      if (!keepLastGood) {
        state = SessionListState(
          status: SessionListStatus.error,
          error: userFacingMessage(e, lead: "Couldn't load sessions."),
          sessions: state.sessions,
          machine: state.machine,
          revision: state.revision,
          source: state.source,
          // A failed authoritative load keeps usable cached identity next to
          // Retry, but relabelled: these rows are last-known, not current.
          cachedRoster: state.cachedRoster?.withReason(
            CachedRosterReason.unreachable,
          ),
        );
      }
      _logLoadTiming(
        outcome: keepLastGood ? 'error-silent' : 'error',
        total: totalTimer.elapsed,
        repositoryResolution: repositoryTimer.elapsed,
        fetch: fetchDuration,
        error: e,
      );
    }
  }

  /// Starts the local snapshot read as soon as the active profile is hydrated.
  ///
  /// Deliberately not awaited by `_load`: hydration must never sit in the
  /// roster's critical path, and a hydration failure is surfaced by the
  /// repository resolution, which awaits the same future.
  Future<void> _publishAfterProfileHydration(int generation) async {
    try {
      await ref.read(activeBrokerProfileHydrationProvider.future);
    } on Object {
      return;
    }
    if (_disposed || generation != _loadGeneration) return;
    final source = _activeSource;
    if (source == null) return;
    if (state.source != source) {
      state = state.copyWith(source: source);
    }
    await _publishCachedIdentity(generation, source);
  }

  /// Reads the active profile's bounded identity snapshot exactly once and
  /// publishes it while the authoritative roster is still pending.
  ///
  /// Every publish is guarded three ways, because a local read can easily
  /// outlive the load that started it: the load generation must still be
  /// current, the controller must not have been disposed, and the active
  /// source must still be the one the snapshot was read for. Profile A's rows
  /// can therefore never flash during profile B's startup.
  Future<void> _publishCachedIdentity(
    int generation,
    RosterSource? source,
  ) async {
    if (source == null) return;
    // Authoritative rows for THIS source outrank the cache. A switch resets
    // both the state and the memoized read, so the previous source's rows can
    // never suppress the new source's read.
    if (state.source == source && state.sessions.isNotEmpty) return;
    final snapshot = await _readSnapshotOnce(source);
    if (snapshot == null || snapshot.rows.isEmpty) return;
    if (_isStale(generation, source)) return;
    if (state.source != source) return;
    // The authoritative response may already have landed while this read was
    // outstanding; cached rows must never replace real ones.
    if (state.sessions.isNotEmpty) return;
    if (state.status == SessionListStatus.loaded) return;
    state = state.copyWith(
      cachedRoster: CachedRosterPresentation(
        snapshot: snapshot,
        reason: state.status == SessionListStatus.error
            ? CachedRosterReason.unreachable
            : CachedRosterReason.hydrating,
      ),
    );
  }

  /// Reads [source]'s snapshot at most once, sharing one read between loads.
  ///
  /// The memo is kept after it completes, so a refresh, a delta reset or a poll
  /// still performs no second database read; it is dropped only when the source
  /// changes.
  Future<SessionRosterSnapshot?> _readSnapshotOnce(RosterSource source) {
    final pending = _snapshotRead;
    if (pending != null && _snapshotReadSource == source) return pending;
    _snapshotReadSource = source;
    final read = _loadSnapshot(source);
    _snapshotRead = read;
    return read;
  }

  Future<SessionRosterSnapshot?> _loadSnapshot(RosterSource source) async {
    try {
      return await ref
          .read(rosterSnapshotRepositoryProvider)
          .load(source.profileId, endpoint: _snapshotEndpoint(source));
    } on Object catch (error, stackTrace) {
      // A local cache fault must never be able to block startup: fall open to
      // the ordinary loading treatment.
      developer.log(
        'roster-snapshot read failed',
        name: 'cosyncing.sessions',
        error: error,
        stackTrace: stackTrace,
      );
      return null;
    }
  }

  /// Rewrites the profile's snapshot from a successful authoritative response.
  ///
  /// Guarded the same way as the read: a response that arrived for a source the
  /// user has already switched away from is not written under the new source's
  /// id, and a superseded load writes nothing at all.
  Future<void> _refreshSnapshot(
    int generation,
    RosterSource? source,
    List<SessionInfo> sessions,
    SessionCacheWriteAdmission admission,
  ) async {
    final writeFence = _cacheWriteFence;
    if (source == null || _isStale(generation, source)) {
      writeFence.release(admission);
      return;
    }
    if (!writeFence.claim(admission)) return;
    try {
      await ref
          .read(rosterSnapshotRepositoryProvider)
          .save(
            brokerProfileId: source.profileId,
            endpoint: _snapshotEndpoint(source),
            sessions: sessions,
          );
    } on Object catch (error, stackTrace) {
      // Best-effort: the roster on screen is authoritative either way.
      developer.log(
        'roster-snapshot write failed',
        name: 'cosyncing.sessions',
        error: error,
        stackTrace: stackTrace,
      );
    }
  }

  String _snapshotEndpoint(RosterSource source) =>
      '${source.endpoint}#roster-window=${_queryWindow.queryValue}';

  /// Marks the durable snapshot stale after the roster changed.
  ///
  /// Used by the delta feed, which is the ONLY thing that moves the roster once
  /// it is healthy — it suppresses the silent full fetch entirely — so without
  /// this a long-lived client would restart into the roster it saw when it
  /// first connected, complete with sessions that have since been removed and
  /// titles/projects that have since been renamed.
  ///
  /// Coalesced without a timer: while a write is in flight, further changes
  /// only set the dirty flag, and the in-flight write re-checks it on
  /// completion. A burst of N deltas therefore costs at most two writes, and an
  /// idle feed costs none. Adds no broker request — it persists rows the feed
  /// already delivered.
  void _markSnapshotDirty() {
    _snapshotDirty = true;
    final writeFence = _cacheWriteFence;
    _snapshotDirtyAdmission = (writeFence..release(_snapshotDirtyAdmission))
        .admitRoster();
    unawaited(_flushSnapshot());
  }

  /// The one serialized writer. Always persists CURRENT state, never a
  /// captured older roster, so no completion order can invert two revisions.
  Future<void> _flushSnapshot() {
    final running = _snapshotWrite;
    if (running != null) return running;
    final started = _runSnapshotWrites();
    _snapshotWrite = started;
    return started;
  }

  Future<void> _runSnapshotWrites() async {
    try {
      // Deliberately no early `return` on a source change. The writer is
      // serialized across sources, not owned by one: a delta for broker B that
      // arrives while broker A's write is still running only sets the flag, so
      // if this loop exited on A's staleness B's roster would sit unwritten
      // until some later delta happened to arrive. Each pass re-reads the
      // CURRENT source and rows instead, which also means a write that started
      // before the last delta of a burst still persists the final roster.
      while (_snapshotDirty && !_disposed) {
        _snapshotDirty = false;
        final admission = _snapshotDirtyAdmission;
        _snapshotDirtyAdmission = null;
        final generation = _loadGeneration;
        final source = state.source;
        if (source == null || _activeSource != source) {
          _cacheWriteFence.release(admission);
          break;
        }
        if (admission == null) continue;
        await _refreshSnapshot(
          generation,
          source,
          state.sessions,
          admission,
        );
      }
    } finally {
      _snapshotWrite = null;
    }
    // Only reachable when the loop broke on a transiently unusable source; a
    // change that re-dirtied the flag must not wait for the next one.
    if (_snapshotDirty && !_disposed) unawaited(_flushSnapshot());
  }

  void _adoptLiveRepository(SessionListRepository repository) {
    LiveSessionListRepository? live;
    if (repository is LiveSessionListRepository) {
      live = repository as LiveSessionListRepository;
    }
    if (identical(live, _liveRepository)) {
      if (_isForeground) _startFeed();
      return;
    }
    _stopFeed();
    _liveRepository = live;
    _feedUnsupported = false;
    if (_isForeground) _startFeed();
  }

  bool get _isForeground =>
      _lifecycleState == AppLifecycleState.resumed ||
      _lifecycleState == AppLifecycleState.inactive;

  void _handleLifecycleChanged(AppLifecycleState next) {
    _lifecycleState = next;
    if (_isForeground) {
      _startFeed();
    } else {
      _stopFeed(keepRepository: true);
    }
  }

  void _startFeed() {
    final repository = _liveRepository;
    if (repository == null ||
        _feedActive ||
        _feedUnsupported ||
        !_isForeground) {
      return;
    }
    final generation = ++_feedGeneration;
    _feedActive = true;
    unawaited(_runFeed(repository, generation));
  }

  Future<void> _runFeed(
    LiveSessionListRepository repository,
    int generation,
  ) async {
    try {
      while (generation == _feedGeneration && _isForeground) {
        final batch = repository is WindowedLiveSessionListRepository
            ? await repository.waitForDeltasWindowed(
                after: state.revision,
                window: _queryWindow.queryValue,
              )
            : await repository.waitForDeltas(after: state.revision);
        if (generation != _feedGeneration || !_isForeground) return;
        if (batch.resetRequired) {
          await _load(silent: true, acceptReset: true);
          continue;
        }
        if (!_applyDeltaBatch(batch)) {
          await _load(silent: true);
        }
      }
    } on SessionRosterDeltaWaitCancelledException {
      // Expected when hidden, disposed, or switching broker profiles.
    } on SessionRosterDeltaFeedUnsupportedException {
      _feedUnsupported = true;
    } on SessionRosterDeltaFeedRetryableException {
      if (generation == _feedGeneration && _isForeground) {
        await Future<void>.delayed(const Duration(seconds: 1));
        if (generation == _feedGeneration) {
          _feedActive = false;
          _startFeed();
          return;
        }
      }
    } on Object catch (error, stackTrace) {
      developer.log(
        'roster-delta-feed failed',
        name: 'cosyncing.sessions',
        error: error,
        stackTrace: stackTrace,
      );
    } finally {
      if (generation == _feedGeneration) _feedActive = false;
    }
  }

  bool _applyDeltaBatch(SessionRosterDeltaBatch batch) {
    if (batch.revision < state.revision) return true;
    final ordered = [...batch.deltas]
      ..sort((a, b) => a.revision.compareTo(b.revision));
    var expected = state.revision + 1;
    final byKey = <String, SessionInfo>{
      for (final session in state.sessions) _sessionKey(session): session,
    };
    for (final delta in ordered) {
      if (delta.revision <= state.revision) continue;
      if (delta.revision != expected) return false;
      expected++;
      final key = '${delta.machine}/${delta.tool}/${delta.sessionId}';
      if (delta.removed) {
        byKey.remove(key);
      } else if (delta.session case final session?) {
        byKey[_sessionKey(session)] = session;
      } else {
        return false;
      }
    }
    if (ordered.isEmpty && batch.revision != state.revision) return false;
    final sessions = byKey.values.toList(growable: false)
      ..sort(_compareSessions);
    final rosterChanged = ordered.isNotEmpty;
    state = state.copyWith(
      status: SessionListStatus.loaded,
      sessions: sessions,
      revision: batch.revision,
    );
    _publishStatuses(state.source, batch.revision);
    // A healthy feed replaces the full fetch entirely, so this is the only path
    // that can keep the durable snapshot current. A revision-only batch changed
    // no identity and needs no write.
    if (rosterChanged) _markSnapshotDirty();
    return true;
  }

  String _sessionKey(SessionInfo session) =>
      '${session.machine ?? state.machine ?? ''}/${session.tool}/${session.id}';

  static int _compareSessions(SessionInfo a, SessionInfo b) {
    int rank(SessionStatus status) => switch (status) {
      SessionStatus.needsInput => 0,
      SessionStatus.working => 1,
      SessionStatus.idle => 2,
    };
    return rank(a.status).compareTo(rank(b.status)) != 0
        ? rank(a.status).compareTo(rank(b.status))
        : (b.updatedAt ?? 0).compareTo(a.updatedAt ?? 0);
  }

  void _stopFeed({bool keepRepository = false}) {
    _feedGeneration++;
    _feedActive = false;
    _liveRepository?.cancelDeltaWait();
    if (!keepRepository) _liveRepository = null;
  }

  void _logLoadTiming({
    required String outcome,
    required Duration total,
    required Duration repositoryResolution,
    required Duration fetch,
    Object? error,
  }) {
    developer.log(
      'roster-load outcome=$outcome totalMs=${total.inMilliseconds} '
      'repositoryResolutionMs=${repositoryResolution.inMilliseconds} '
      'fetchSessionsMs=${fetch.inMilliseconds}',
      name: 'cosyncing.sessions',
      error: error,
    );
  }
}

final class _RosterLifecycleObserver extends WidgetsBindingObserver {
  _RosterLifecycleObserver({required this.onChanged});

  final ValueChanged<AppLifecycleState> onChanged;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) => onChanged(state);
}

/// Provider for the [SessionListController].
final sessionListControllerProvider =
    NotifierProvider<SessionListController, SessionListState>(
      SessionListController.new,
    );

/// One coalesced silent roster refresh shared by lifecycle resume consumers.
typedef SessionRosterResumeRefresh = Future<void> Function();

/// Prevents the workspace and resident-session supervisor from issuing two
/// roster refreshes for the same resume transition.
final sessionRosterResumeRefreshProvider = Provider<SessionRosterResumeRefresh>(
  (ref) {
    Future<void>? inFlight;
    return () {
      final active = inFlight;
      if (active != null) return active;
      late final Future<void> operation;
      operation =
          Future.wait<void>([
            ref.read(sessionListControllerProvider.notifier).load(silent: true),
            ref.read(sessionCreationReadyProvider.notifier).refresh(),
          ]).whenComplete(() {
            if (identical(inFlight, operation)) inFlight = null;
          });
      inFlight = operation;
      return operation;
    };
  },
);

/// The roster rows every roster surface renders (R0b).
///
/// [SessionListController] owns roster *membership and metadata*; the
/// [SessionStatusRegistry] owns Working/Idle. Both roster layouts read this one
/// projection, so an open Session Detail's live transition reaches the roster
/// in the same frame instead of waiting for a delta round trip — and both
/// layouts necessarily agree with each other and with the open detail.
final rosterSessionsProvider = Provider<List<SessionInfo>>((ref) {
  final rows = ref.watch(sessionListControllerProvider).sessions;
  return ref.watch(sessionStatusRegistryProvider).apply(rows);
});
