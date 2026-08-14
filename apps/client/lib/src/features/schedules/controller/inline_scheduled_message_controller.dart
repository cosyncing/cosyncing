import 'dart:async';

import 'package:broker_client/broker_client.dart';
import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:broker_contract/broker_contract.dart';
import 'package:cosyncing_client/src/errors/user_facing_error.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/schedules/controller/inline_schedule_diagnostics.dart';
import 'package:cosyncing_client/src/features/schedules/controller/schedule_conflict.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:dio/dio.dart' show CancelToken;
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// The exact session identity used to scope inline scheduled-message rows.
///
/// Transport state is deliberately NOT part of this key. Making it part of the
/// family argument (or a watched build dependency) would rebuild the notifier
/// on every connect/disconnect frame and publish a fresh, empty
/// [InlineScheduledMessageState] — erasing the cached cards exactly when the
/// user can least afford to lose them. The lifecycle is reported through
/// [InlineScheduledMessageController.setTransportConnected] instead, which
/// changes the refresh POLICY while the state stays put.
@immutable
final class InlineScheduledMessageKey {
  /// Creates an inline schedule target.
  const InlineScheduledMessageKey({
    required this.tool,
    required this.sessionId,
  });

  /// Broker tool id.
  final String tool;

  /// Broker session id.
  final String sessionId;

  @override
  bool operator ==(Object other) =>
      other is InlineScheduledMessageKey &&
      other.tool == tool &&
      other.sessionId == sessionId;

  @override
  int get hashCode => Object.hash(tool, sessionId);
}

/// How current the rendered inline schedule rows are.
///
/// Automatic refresh is paused while the session transport is not connected, so
/// "these rows could not be renewed" still has to be observable — just not as
/// red transcript text. This is that place: controller state and Debug only.
/// Nothing in Chat renders it.
enum InlineScheduleFreshness {
  /// No canonical read has succeeded yet for this session and profile.
  unknown,

  /// The rendered rows came from the last successful canonical read.
  fresh,

  /// The rows are retained from an earlier read that a later refresh could not
  /// renew. The rows stay visible; only their provenance changed.
  stale,
}

/// Where an inline-schedule failure came from.
///
/// U6 suppresses connectivity noise, not provenance. Recording who asked is
/// what lets a later passive success clear a row a passive read raised, while
/// leaving a standing explicit failure — one the user caused and has not seen
/// resolved — exactly where it is.
enum InlineScheduleFailureProvenance {
  /// The user asked: an edit, a cancellation, or a manual refresh.
  explicitRequest,

  /// An automatic lifecycle refresh raised it.
  passiveRefresh,
}

/// Why an inline-schedule request failed, in the terms Chat renders.
///
/// Deliberately a closed set rather than a message: the localized sentence is
/// chosen by the view, so no broker or exception text can reach the primary
/// reading path.
enum InlineScheduleActionFailure {
  /// A read needs a broker client and the active profile has none.
  connectToView,

  /// A change needs a broker client and the active profile has none.
  connectToChange,

  /// The row the user acted on is no longer pending locally.
  missingRow,

  /// Another client changed the row first; the timeline was refreshed.
  conflict,

  /// A refresh failed; the classified kind supplies the advice.
  refreshFailed,

  /// An edit or cancellation failed; the kind supplies the advice.
  mutationFailed,
}

/// An actionable inline-schedule failure, kept typed until the view localizes.
@immutable
final class InlineScheduleActionError {
  /// Creates an actionable inline-schedule failure, bounding [detail].
  ///
  /// The bound is applied HERE rather than only where Debug copies the value,
  /// because this object lives in controller state until the next successful
  /// read — and a promoted passive failure is held twice, once as
  /// [InlineScheduledMessageState.passiveFailure] and once as
  /// [InlineScheduledMessageState.mutationError].
  factory InlineScheduleActionError({
    required InlineScheduleActionFailure failure,
    InlineScheduleFailureProvenance provenance =
        InlineScheduleFailureProvenance.explicitRequest,
    FailureKind failureKind = FailureKind.unknown,
    String? detail,
  }) => InlineScheduleActionError._(
    failure: failure,
    provenance: provenance,
    failureKind: failureKind,
    detail: boundedFailureDetail(detail),
  );

  /// Creates a failure with no broker text to bound.
  const InlineScheduleActionError.withoutDetail({
    required this.failure,
    this.provenance = InlineScheduleFailureProvenance.explicitRequest,
    this.failureKind = FailureKind.unknown,
  }) : detail = null;

  const InlineScheduleActionError._({
    required this.failure,
    required this.provenance,
    required this.failureKind,
    required this.detail,
  });

  /// Which request failed, and how the view should phrase it.
  final InlineScheduleActionFailure failure;

  /// Whether the user asked for the request that failed.
  final InlineScheduleFailureProvenance provenance;

  /// Classified transport/broker cause, used to pick localized recovery advice.
  final FailureKind failureKind;

  /// Raw diagnostic for a Debug disclosure. Never rendered as primary copy.
  final String? detail;

  @override
  bool operator ==(Object other) =>
      other is InlineScheduleActionError &&
      other.failure == failure &&
      other.provenance == provenance &&
      other.failureKind == failureKind &&
      other.detail == detail;

  @override
  int get hashCode => Object.hash(failure, provenance, failureKind, detail);
}

/// State for one session's pending scheduled messages.
@immutable
final class InlineScheduledMessageState {
  /// Creates inline schedule state.
  const InlineScheduledMessageState({
    this.schedules = const [],
    this.loading = false,
    this.mutatingIds = const {},
    this.mutationError,
    this.passiveFailure,
    this.freshness = InlineScheduleFreshness.unknown,
  });

  /// Canonical live message schedules for the target session.
  final List<ScheduleRecord> schedules;

  /// Whether an authenticated list refresh is in flight.
  final bool loading;

  /// Schedule ids with an edit or cancellation in flight.
  final Set<String> mutatingIds;

  /// The failure Chat renders as a visible, actionable row.
  ///
  /// Every explicit failure lands here. A PASSIVE failure lands here only when
  /// the next poll cannot plausibly resolve it without the user —
  /// authentication and structured rejections (compatibility, validation).
  /// Ordinary connectivity noise never does.
  final InlineScheduleActionError? mutationError;

  /// The last passive refresh failure, classified. Debug-facing only.
  ///
  /// Recorded for EVERY passive failure including the suppressed ones, so
  /// [freshness] never has to stand in for an unexamined cause.
  final InlineScheduleActionError? passiveFailure;

  /// Provenance of the rendered rows. Never rendered in Chat.
  final InlineScheduleFreshness freshness;

  /// Returns a copy with selected fields replaced.
  InlineScheduledMessageState copyWith({
    List<ScheduleRecord>? schedules,
    bool? loading,
    Set<String>? mutatingIds,
    InlineScheduleActionError? mutationError,
    bool clearMutationError = false,
    InlineScheduleActionError? passiveFailure,
    bool clearPassiveFailure = false,
    InlineScheduleFreshness? freshness,
  }) => InlineScheduledMessageState(
    schedules: schedules ?? this.schedules,
    loading: loading ?? this.loading,
    mutatingIds: mutatingIds ?? this.mutatingIds,
    mutationError: clearMutationError
        ? null
        : mutationError ?? this.mutationError,
    passiveFailure: clearPassiveFailure
        ? null
        : passiveFailure ?? this.passiveFailure,
    freshness: freshness ?? this.freshness,
  );
}

/// Low-frequency, lifecycle-bound refresh for one session's inline schedules.
final AutoDisposeNotifierProviderFamily<
  InlineScheduledMessageController,
  InlineScheduledMessageState,
  InlineScheduledMessageKey
>
inlineScheduledMessageControllerProvider = NotifierProvider.autoDispose
    .family<
      InlineScheduledMessageController,
      InlineScheduledMessageState,
      InlineScheduledMessageKey
    >(InlineScheduledMessageController.new);

/// Owns exact filtering and revision-checked mutations for inline cards.
///
/// Automatic work is gated on the live session transport, reported by Chat
/// through [setTransportConnected]. There is no connectivity probe, endpoint,
/// keepalive, or second timer here: the status Chat already renders is the
/// only signal, and while it is anything other than connected this controller
/// issues no list request at all.
final class InlineScheduledMessageController
    extends
        AutoDisposeFamilyNotifier<
          InlineScheduledMessageState,
          InlineScheduledMessageKey
        > {
  /// Polling is deliberately much less frequent than session transport work.
  static const pollInterval = Duration(seconds: 15);

  Timer? _pollTimer;
  StreamSubscription<BrokerAppLifecycleState>? _lifecycleSubscription;
  Future<void>? _refreshInFlight;
  _RefreshScope? _refreshScope;
  int _refreshRevision = 0;
  InlineScheduledMessageKey? _target;
  int _generation = 0;
  int _dataGeneration = 0;
  int _mutationsInFlight = 0;

  /// Whether this notifier has been disposed for good.
  ///
  /// Set by the `onDispose` registered in [build] and cleared at the top of
  /// every [build], so it is true only after a REAL disposal — leaving Chat —
  /// and never during the dispose-then-rebuild Riverpod performs when a watched
  /// dependency changes. A request that outlives the surface it was started for
  /// must touch neither `ref` nor `state` again.
  bool _disposed = false;

  /// Latest transport state reported by Chat. Starts false so a session opened
  /// while offline issues nothing until the first connected frame.
  bool _transportConnected = false;

  /// Whether the host document may issue schedule traffic.
  ///
  /// Cached rows remain in [state] while hidden; only requests and the timer
  /// are retired.
  bool _appVisible = true;

  /// Whether this session page is the onstage retained page.
  bool _hostVisible = true;

  bool get _workVisible => _appVisible && _hostVisible;

  /// Which broker SOURCE — (profile, endpoint) — [_transportConnected]
  /// describes.
  ///
  /// A connection belongs to one machine, not to the profile row pointing at
  /// it. `SessionDetailState.forActiveSource` already resets Session Detail to
  /// a disconnected default the instant that source changes, so an unqualified
  /// `true` here would be the OLD transport's answer — and would let a switch,
  /// including an endpoint edit that keeps the profile id, issue a schedule GET
  /// before the new session transport has connected. Reports are honored only
  /// for the source they were made for.
  RosterSource? _reportedTransportSource;

  /// Bumped on every transport transition. A read that started under an older
  /// epoch is retired: adopting its response — or its failure — after a drop is
  /// the reconnect race this controller exists to remove.
  int _transportEpoch = 0;

  /// Which source the previous [build] ran for.
  ///
  /// Matching [_reportedTransportSource] against the CURRENT source is not
  /// enough on its own: an A → B → A sequence would find A's original report
  /// still matching and revive it, arming a read on a transport report that
  /// predates two switches. Every transition invalidates the report instead.
  RosterSource? _lastBuiltSource;

  bool get _mutationInFlight => _mutationsInFlight > 0;

  /// Whether the low-frequency poll timer is currently armed.
  ///
  /// Test/Debug visibility only; nothing in Chat reads it.
  @visibleForTesting
  bool get debugPollingActive => _pollTimer != null;

  @override
  InlineScheduledMessageState build(InlineScheduledMessageKey arg) {
    _target = arg;
    _disposed = false;
    final lifecycleMonitor = ref.read(
      sessionNotificationLifecycleMonitorProvider,
    );
    _appVisible = !_isBackgroundLifecycle(lifecycleMonitor.currentState);
    unawaited(_lifecycleSubscription?.cancel());
    _lifecycleSubscription = lifecycleMonitor.stateChanges.listen((next) {
      if (!_disposed) {
        setAppVisible(visible: !_isBackgroundLifecycle(next));
      }
    });
    // The exact broker source, not the profile id: an endpoint edit keeps the
    // id, and an id-keyed rebuild kept the previous machine's prompt-bearing
    // cards, its polling, and its diagnostics under the new one.
    final source = ref.watch(
      activeBrokerProfileProvider.select(RosterSource.of),
    );
    final generation = ++_generation;
    _stopPolling();
    if (_lastBuiltSource != source) {
      _lastBuiltSource = source;
      // Any standing report described a different machine's transport.
      _transportConnected = false;
      _reportedTransportSource = null;
      _transportEpoch += 1;
      _cancelTrackedRefresh('broker source changed');
    }
    // Runs on real disposal (leaving Chat) AND between rebuilds, so it must not
    // clear the reported transport state: a profile switch would otherwise
    // disarm a session that is still connected and never read again.
    ref.onDispose(() {
      _disposed = true;
      _generation += 1;
      _transportEpoch += 1;
      _stopPolling();
      unawaited(_lifecycleSubscription?.cancel());
      _cancelTrackedRefresh('inline schedule surface disposed');
    });

    // Only a report made FOR this source can arm it. After a switch the
    // standing report belongs to the previous transport, so this session stays
    // silent until Chat reports the new broker's own connected state.
    if (_workVisible &&
        source != null &&
        _transportConnected &&
        _reportedTransportSource == source) {
      _startPolling(generation: generation);
    }

    return const InlineScheduledMessageState();
  }

  /// Reports whether the live session transport is genuinely connected.
  ///
  /// Chat calls this with the `SessionDetailConnectionStatus` it already
  /// renders. Repeated frames of the same value are a no-op, so a noisy
  /// reconnect cannot stack timers or reconnect reads. This never writes state
  /// synchronously — it is safe to call from a build method, and every state
  /// change it causes lands in a later microtask.
  void setTransportConnected({required bool connected}) {
    final source = _activeSource;
    if (_reportedTransportSource == source &&
        _transportConnected == connected) {
      return;
    }
    _reportedTransportSource = source;
    _transportConnected = connected;
    _transportEpoch += 1;
    _stopPolling();
    // Every transition retires the read that was running under the old one, so
    // release it here rather than leave it holding a socket across the drop.
    _cancelTrackedRefresh('session transport state changed');
    if (!connected || !_workVisible) {
      // A read retired by this drop publishes nothing, so nothing else would
      // settle the indicator — and a request that hangs past the drop would
      // leave it stuck true for as long as the socket takes to fail.
      _settleRetiredLoading();
      return;
    }
    if (source == null) return;
    _startPolling(generation: _generation);
  }

  /// Reports whether the host document permits inline schedule traffic.
  ///
  /// Hidden, paused, and detached states cancel the timer and any in-flight
  /// read without clearing cached cards. Resuming issues one catch-up read if
  /// the selected Session Detail transport is still connected.
  void setAppVisible({required bool visible}) {
    if (_appVisible == visible) return;
    _appVisible = visible;
    _transportEpoch += 1;
    _stopPolling();
    _cancelTrackedRefresh('app lifecycle visibility changed');
    if (!visible) {
      _settleRetiredLoading();
      return;
    }
    if (!_hostVisible || !_transportConnected || _activeSource == null) return;
    _startPolling(generation: _generation);
  }

  /// Reports whether this retained Session Detail page is onstage.
  ///
  /// The app lifecycle and page visibility are separate gates: an app resume
  /// must not restart polling for a tab that remains hidden in the page LRU.
  void setHostVisible({required bool visible}) {
    if (_hostVisible == visible) return;
    _hostVisible = visible;
    _transportEpoch += 1;
    _stopPolling();
    _cancelTrackedRefresh('retained session page visibility changed');
    if (!visible) {
      _settleRetiredLoading();
      return;
    }
    if (!_appVisible || !_transportConnected || _activeSource == null) return;
    _startPolling(generation: _generation);
  }

  static bool _isBackgroundLifecycle(BrokerAppLifecycleState lifecycle) =>
      lifecycle == BrokerAppLifecycleState.hidden ||
      lifecycle == BrokerAppLifecycleState.paused ||
      lifecycle == BrokerAppLifecycleState.detached;

  /// Refreshes canonical rows for an EXPLICIT, user-initiated request.
  ///
  /// Failures stay actionable and reach Chat. Automatic lifecycle refreshes use
  /// the poll path instead, which keeps its failures out of the transcript.
  ///
  /// Concurrent explicit calls coalesce, so a slow broker response cannot
  /// create overlapping user-initiated reads. An explicit call never coalesces
  /// onto — or waits for — an automatic poll; see [_refresh].
  Future<void> refresh({bool force = false}) =>
      _refresh(force: force, origin: _RefreshOrigin.explicitRequest);

  /// Adopts a just-created row before the next broker poll completes.
  void upsert(ScheduleRecord schedule) {
    if (!_isInlineSchedule(schedule)) return;
    _dataGeneration += 1;
    _publish(
      state.copyWith(
        schedules: _replace(schedule),
        loading: false,
        clearMutationError: true,
      ),
    );
  }

  /// Applies a narrow message-card PATCH using the rendered revision.
  Future<bool> update(String id, ScheduleUpdate request) {
    return _mutate(
      id,
      (client) => client.updateSchedule(id, request),
    );
  }

  /// Cancels the rendered live row through the revision-free DELETE route.
  Future<bool> cancel(String id) async {
    final schedule = state.schedules.where((row) => row.id == id).firstOrNull;
    if (schedule == null) {
      _publish(
        state.copyWith(
          mutationError: const InlineScheduleActionError.withoutDetail(
            failure: InlineScheduleActionFailure.missingRow,
          ),
        ),
      );
      return false;
    }
    return _mutate(
      id,
      (client) => client.deleteSchedule(id),
    );
  }

  void _stopPolling() {
    _pollTimer?.cancel();
    _pollTimer = null;
  }

  /// Arms the single low-frequency timer and issues the one read the connected
  /// transition owes.
  ///
  /// The read does NOT wait for a request left over from before the drop. That
  /// request is already retired by the epoch bump and can publish nothing, so
  /// waiting on it buys no safety while making reconnect hostage to a socket
  /// that may never answer — a hung pre-disconnect GET would mean the session
  /// never refreshes again. The two may overlap; only the current epoch's
  /// result is ever adopted.
  ///
  /// The read is deferred by a microtask because this runs from a widget build
  /// (Chat reports the transport there) and starting it writes `loading`.
  void _startPolling({required int generation}) {
    assert(_workVisible, 'hidden documents cannot arm schedule polling');
    assert(_pollTimer == null, 'the caller cancels before re-arming');
    final epoch = _transportEpoch;
    _pollTimer = Timer.periodic(pollInterval, (_) {
      unawaited(_refresh(force: false, origin: _RefreshOrigin.poll));
    });
    Future<void>.microtask(() {
      if (_disposed ||
          !_workVisible ||
          !_transportConnected ||
          _generation != generation ||
          _transportEpoch != epoch) {
        return;
      }
      unawaited(_refresh(force: true, origin: _RefreshOrigin.poll));
    });
  }

  /// Settles the refresh indicator for a read this controller has abandoned.
  ///
  /// Deferred, because the transport report arrives during a widget build.
  void _settleRetiredLoading() {
    final generation = _generation;
    final epoch = _transportEpoch;
    scheduleMicrotask(() {
      if (_generation != generation || _transportEpoch != epoch) return;
      if (state.loading) _publish(state.copyWith(loading: false));
    });
  }

  /// Admits one canonical read, or adopts an equivalent one already running.
  ///
  /// Nothing ever QUEUES here. A request that waited on an active read would
  /// inherit that read's timing, so a hung GET could hold a manual refresh — or
  /// a 409 reconciliation, with the user's row still spinning — for as long as
  /// the socket takes to fail. Requests that may not adopt the active read
  /// start immediately and take the newest revision; the superseded read keeps
  /// running but [_canPublish] fences it out of publishing when it answers, so
  /// a stale snapshot can never land on top of a newer one.
  Future<void> _refresh({
    required bool force,
    required _RefreshOrigin origin,
  }) {
    if (_disposed || !_workVisible) return Future<void>.value();
    final source = _activeSource;
    if (source == null) return Future<void>.value();
    if (!force && _mutationInFlight) return Future<void>.value();
    final active = _refreshInFlight;
    final activeScope = _refreshScope;
    // "Same lane" = same source, build generation, and transport epoch, so
    // both requests would publish into the same context. Across lanes the older
    // request is already retired and there is nothing to coordinate.
    final sameLane =
        active != null &&
        activeScope != null &&
        activeScope.source == source &&
        activeScope.generation == _generation &&
        activeScope.transportEpoch == _transportEpoch;
    if (sameLane && _mayRide(origin, activeScope.origin)) return active;

    final scope = _RefreshScope(
      source: source,
      generation: _generation,
      transportEpoch: _transportEpoch,
      dataGeneration: _dataGeneration,
      revision: ++_refreshRevision,
      origin: origin,
      cancelToken: CancelToken(),
    );
    // The superseded read is not merely ignored, it is ABANDONED: the broker
    // client carries no default timeout, so an ignored read would hold its
    // request and connection slot until the socket failed on its own. Without
    // this, repeated supersessions accumulate outstanding requests without
    // bound.
    _cancelTrackedRefresh('superseded by a newer inline schedule read');
    late Future<void> tracked;
    tracked = _refreshImpl(scope).whenComplete(() {
      // Only the request that still owns the lane clears it: a superseded read
      // finishing later must not erase its successor's bookkeeping.
      if (identical(_refreshInFlight, tracked)) {
        _refreshInFlight = null;
        _refreshScope = null;
      }
    });
    _refreshInFlight = tracked;
    _refreshScope = scope;
    return tracked;
  }

  /// Abandons the tracked read, releasing its request and connection slot.
  ///
  /// Cancellation is how "retired" stops being bookkeeping and starts being
  /// real: a retired read that keeps running is still a live socket.
  void _cancelTrackedRefresh(String reason) {
    final scope = _refreshScope;
    if (scope != null && !scope.cancelToken.isCancelled) {
      scope.cancelToken.cancel(reason);
    }
    _refreshInFlight = null;
    _refreshScope = null;
  }

  /// Whether a request of [origin] may adopt the [active] in-lane read instead
  /// of issuing its own.
  static bool _mayRide(_RefreshOrigin origin, _RefreshOrigin active) =>
      switch (origin) {
        // A poll adds nothing over a user-driven read already running in its
        // lane. It does NOT ride an older poll: riding one forever is how a
        // single hung read becomes a session that never refreshes again, so
        // the next 15s tick replaces it instead.
        _RefreshOrigin.poll => active != _RefreshOrigin.poll,
        // A user action must not inherit a poll's suppressed failure, nor wait
        // on a socket the poll may never get an answer from.
        _RefreshOrigin.explicitRequest =>
          active == _RefreshOrigin.explicitRequest,
        // Reconciliation sits on the mutation's critical path with the row's
        // spinner held, so it always issues its own read.
        _RefreshOrigin.conflictReconciliation => false,
      };

  Future<bool> _mutate(
    String id,
    Future<Object> Function(BrokerClient client) mutation,
  ) async {
    if (state.mutatingIds.contains(id)) return false;
    final source = _activeSource;
    final generation = _generation;
    _mutationsInFlight += 1;
    _dataGeneration += 1;
    _publish(
      state.copyWith(
        loading: false,
        mutatingIds: {...state.mutatingIds, id},
        clearMutationError: true,
      ),
    );
    try {
      final client = await ref.read(brokerClientProvider.future);
      if (client == null) {
        throw const _MissingBrokerClient();
      }
      final response = await mutation(client);
      if (!_isCurrent(source, generation)) return false;
      _dataGeneration += 1;
      final nextSchedules = switch (response) {
        ScheduleMutationResponse(:final schedule) => _replaceOrRemove(schedule),
        ScheduleCanceledResponse(:final schedule) => _replaceOrRemove(schedule),
        ScheduleRemovedResponse() => [
          for (final row in state.schedules)
            if (row.id != id) row,
        ],
        _ => throw StateError('Unexpected schedule mutation response.'),
      };
      _publish(
        state.copyWith(
          schedules: nextSchedules,
          mutatingIds: {...state.mutatingIds}..remove(id),
          clearMutationError: true,
        ),
      );
      return true;
    } on Object catch (error) {
      if (!_isCurrent(source, generation)) return false;
      if (isScheduleConflict(error)) {
        await _refreshAfterConflict(source, generation);
        if (!_isCurrent(source, generation)) return false;
      }
      _publish(
        state.copyWith(
          mutatingIds: {...state.mutatingIds}..remove(id),
          mutationError: _inlineScheduleActionError(error),
        ),
      );
      return false;
    } finally {
      _mutationsInFlight -= 1;
    }
  }

  /// Re-reads canonical rows after another client won a 409.
  ///
  /// It does NOT wait for a read already in flight. Awaiting an automatic poll
  /// here would let one hung GET hold the conflict unresolved indefinitely,
  /// with `mutatingIds` still containing the row the user acted on — a stuck
  /// spinner and no error, which is worse than the delayed manual refresh the
  /// same wait used to cause.
  Future<void> _refreshAfterConflict(
    RosterSource? source,
    int generation,
  ) async {
    if (!_isCurrent(source, generation)) return;
    // The conflict itself is the user-visible failure; this reconciliation
    // read is bookkeeping, so it must not overwrite that error with its own.
    await _refresh(
      force: true,
      origin: _RefreshOrigin.conflictReconciliation,
    );
  }

  Future<void> _refreshImpl(_RefreshScope scope) async {
    final passive = scope.isPassive;
    _publish(
      passive
          ? state.copyWith(loading: true)
          : state.copyWith(loading: true, clearMutationError: true),
    );
    try {
      final client = await ref.read(brokerClientProvider.future);
      if (!_canPublish(scope)) return;
      if (client == null) {
        _publishRefreshFailure(
          passive: passive,
          failure: const InlineScheduleActionError.withoutDetail(
            failure: InlineScheduleActionFailure.connectToView,
          ),
        );
        return;
      }
      final response = await client.listSchedules(
        cancelToken: scope.cancelToken,
      );
      if (!_canPublish(scope)) return;
      if (scope.dataGeneration != _dataGeneration) {
        // A local create/edit/cancel superseded this GET. Keep its rows and
        // settle the refresh indicator without allowing the old snapshot to
        // paint over the newer local state.
        _publish(state.copyWith(loading: false));
        return;
      }
      final standing = state.mutationError;
      _publish(
        state.copyWith(
          schedules: _filtered(response.schedules),
          loading: false,
          freshness: InlineScheduleFreshness.fresh,
          // A passive success renews the rows and clears a row a passive read
          // raised (the condition just resolved), but never absolves a standing
          // edit/cancel failure the user has not seen resolved.
          clearMutationError:
              !passive ||
              standing?.provenance ==
                  InlineScheduleFailureProvenance.passiveRefresh,
          clearPassiveFailure: true,
        ),
      );
    } on RequestCancelled {
      // Abandoned work, never a fault: this controller asked for the read to
      // stop. Publishing anything here — even settling `loading` — would
      // overwrite state that whatever caused the cancellation now owns.
      return;
    } on Object catch (error) {
      if (!_canPublish(scope)) return;
      if (scope.dataGeneration != _dataGeneration) {
        _publish(state.copyWith(loading: false));
        return;
      }
      _publishRefreshFailure(
        passive: passive,
        failure: InlineScheduleActionError(
          failure: InlineScheduleActionFailure.refreshFailed,
          failureKind: classifyFailure(error),
          detail: failureDetail(error),
        ),
      );
    }
  }

  /// Settles a refresh that failed. Rows are preserved either way: a failed
  /// read never had a newer snapshot to replace them with.
  ///
  /// A passive failure is CLASSIFIED before it is suppressed. U6 removes
  /// connectivity noise, not every automatic failure: an expired credential or
  /// a structured rejection is still there in 15 seconds, so silently filing it
  /// as ordinary staleness would hide a fault the user is the only one who can
  /// clear.
  void _publishRefreshFailure({
    required bool passive,
    required InlineScheduleActionError failure,
  }) {
    if (!passive) {
      _publish(
        state.copyWith(
          loading: false,
          freshness: InlineScheduleFreshness.stale,
          mutationError: failure,
        ),
      );
      return;
    }
    final recorded = InlineScheduleActionError(
      failure: failure.failure,
      provenance: InlineScheduleFailureProvenance.passiveRefresh,
      failureKind: failure.failureKind,
      detail: failure.detail,
    );
    // Never over a standing explicit failure the user has not resolved.
    final promote =
        _passiveFailureNeedsUser(recorded.failureKind) &&
        state.mutationError == null;
    _publish(
      state.copyWith(
        loading: false,
        freshness: InlineScheduleFreshness.stale,
        passiveFailure: recorded,
        mutationError: promote ? recorded : null,
      ),
    );
  }

  /// Whether a passive failure needs the user rather than the next poll.
  ///
  /// Authentication and structured rejections (compatibility, validation) are
  /// actionable and no amount of polling resolves them. Transport failures and
  /// broker-side faults are exactly the transient noise U6 exists to suppress.
  static bool _passiveFailureNeedsUser(FailureKind kind) => switch (kind) {
    FailureKind.unauthorized || FailureKind.rejected => true,
    FailureKind.offline ||
    FailureKind.brokerFault ||
    FailureKind.deviceStorage ||
    FailureKind.unknown => false,
  };

  /// Assigns [next] and mirrors its freshness into the Debug-facing store.
  ///
  /// Every state write goes through here so the reading Debug shows after Chat
  /// unmounts cannot drift from what the controller actually settled on.
  void _publish(InlineScheduledMessageState next) {
    if (_disposed) return;
    state = next;
    final target = _target;
    final source = _activeSource;
    // Unqualified readings would outlive their broker and be shown for the
    // next one, so a reading with no source to attribute it to is not kept.
    if (target == null || source == null) return;
    ref
        .read(inlineScheduleDiagnosticsProvider.notifier)
        .record(
          InlineScheduleDiagnosticsKey(
            brokerScopeKey: source.storageKey,
            tool: target.tool,
            sessionId: target.sessionId,
          ),
          InlineScheduleDiagnostics(
            freshness: next.freshness,
            scheduleCount: next.schedules.length,
            passiveFailureKind: next.passiveFailure?.failureKind,
            passiveFailureDetail: next.passiveFailure?.detail,
          ),
        );
  }

  /// Whether a read admitted under [scope] may still publish.
  ///
  /// The scope is the one captured when the request was ADMITTED, never
  /// resampled, so a request cannot drift into a context it was not started
  /// for. Order matters: the generation and disposal checks come first and
  /// short-circuit, so a request that outlived its notifier never reads `ref`.
  bool _canPublish(_RefreshScope scope) =>
      !_disposed &&
      _generation == scope.generation &&
      _transportEpoch == scope.transportEpoch &&
      // A later admission in this lane already owns the answer.
      _refreshRevision == scope.revision &&
      _activeSource == scope.source;

  List<ScheduleRecord> _filtered(Iterable<ScheduleRecord> rows) {
    final byId = <String, ScheduleRecord>{};
    for (final row in rows) {
      if (_isInlineSchedule(row)) byId[row.id] = row;
    }
    final result = byId.values.toList()
      ..sort((left, right) {
        final byAt = left.at.compareTo(right.at);
        return byAt != 0 ? byAt : left.id.compareTo(right.id);
      });
    return result;
  }

  List<ScheduleRecord> _replace(ScheduleRecord schedule) {
    final rows = <String, ScheduleRecord>{
      for (final row in state.schedules) row.id: row,
    };
    rows[schedule.id] = schedule;
    return _filtered(rows.values);
  }

  List<ScheduleRecord> _replaceOrRemove(ScheduleRecord schedule) {
    if (_isInlineSchedule(schedule)) return _replace(schedule);
    return [
      for (final row in state.schedules)
        if (row.id != schedule.id) row,
    ];
  }

  bool _isInlineSchedule(ScheduleRecord schedule) {
    final target = _target;
    return target != null &&
        schedule.kind == ScheduleKind.message &&
        schedule.state.isLive &&
        schedule.tool == target.tool &&
        schedule.sessionId == target.sessionId;
  }

  /// The broker this controller is currently allowed to speak for.
  RosterSource? get _activeSource =>
      RosterSource.of(ref.read(activeBrokerProfileProvider));

  bool _isCurrent(RosterSource? source, int generation) =>
      !_disposed && _generation == generation && _activeSource == source;
}

/// Who asked for a canonical read.
///
/// Separate from whether the read's failure is suppressed, because the two
/// answer different questions: a 409 reconciliation must start as promptly as
/// a user action, yet its failure is bookkeeping the conflict message outranks.
enum _RefreshOrigin {
  /// The periodic timer or the single read a connected transition owes.
  poll,

  /// The user asked. Its failure reaches Chat.
  explicitRequest,

  /// Reconciliation after another client won a 409.
  conflictReconciliation,
}

/// The exact publishing context one read was admitted under.
///
/// Captured at admission and carried through every await. Re-reading the
/// controller's current source, generation, or epoch inside a delayed closure
/// is what lets an A-originated read publish B's rows — or touch a provider
/// that no longer exists.
@immutable
final class _RefreshScope {
  const _RefreshScope({
    required this.source,
    required this.generation,
    required this.transportEpoch,
    required this.dataGeneration,
    required this.revision,
    required this.origin,
    required this.cancelToken,
  });

  /// Exact broker source the read belongs to.
  final RosterSource source;

  /// Notifier build generation at admission.
  final int generation;

  /// Transport epoch at admission.
  final int transportEpoch;

  /// Local edit generation at admission; a newer one outranks this snapshot.
  final int dataGeneration;

  /// Monotonic admission order. A later admission supersedes this read.
  final int revision;

  /// Who asked.
  final _RefreshOrigin origin;

  /// Releases this read's request when it is superseded or retired.
  final CancelToken cancelToken;

  /// Whether this read's failure stays out of Chat.
  bool get isPassive => origin != _RefreshOrigin.explicitRequest;
}

/// Raised when an explicit change has no broker client to run against.
final class _MissingBrokerClient implements Exception {
  const _MissingBrokerClient();

  @override
  String toString() => 'No broker client for the active broker profile.';
}

InlineScheduleActionError _inlineScheduleActionError(Object error) {
  if (isScheduleConflict(error)) {
    return const InlineScheduleActionError.withoutDetail(
      failure: InlineScheduleActionFailure.conflict,
    );
  }
  if (error is _MissingBrokerClient) {
    return const InlineScheduleActionError.withoutDetail(
      failure: InlineScheduleActionFailure.connectToChange,
    );
  }
  return InlineScheduleActionError(
    failure: InlineScheduleActionFailure.mutationFailed,
    failureKind: classifyFailure(error),
    detail: failureDetail(error),
  );
}
