import 'dart:async';
import 'dart:collection';

import 'package:broker_client_flutter/broker_client_flutter.dart';
import 'package:cosyncing_client/src/features/attention/controller/attention_feed_runtime.dart';
import 'package:cosyncing_client/src/features/connection/provider/connection_providers.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_controller.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_retirement_ledger.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_detail_state.dart';
import 'package:cosyncing_client/src/features/sessions/detail/session_notification_hooks.dart';
import 'package:cosyncing_client/src/features/sessions/list/open_sessions_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_controller.dart';
import 'package:cosyncing_client/src/features/sessions/list/session_list_state.dart';
import 'package:cosyncing_client/src/features/sessions/workspace/session_viewport_registry.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

/// Keeps every explicit open session live without retaining hidden UI trees.
///
/// This widget belongs at the Sessions branch boundary, which stays mounted
/// across both Expanded workspace tabs and Compact detail routes. Each member
/// owns one Riverpod subscription to the existing auto-disposed detail
/// controller. The selected page watches that same provider; it never creates
/// a second controller or connection.
///
/// The branch boundary is not the outermost owner: the broker auth barrier
/// unmounts this whole subtree while a credential is refused and remounts a
/// replacement on the very next gate refresh. Retirements therefore publish to
/// the container-scoped [SessionDetailRetirementLedger], and no incarnation
/// creates a lease for a key whose retirement is still pending — otherwise the
/// replacement adopts a controller holding a connection resolver from before
/// the credential change, and the outgoing retirement later invalidates that
/// adopted provider behind the replacement's back.
class OpenSessionSyncSupervisor extends ConsumerStatefulWidget {
  /// Creates a resident synchronization owner around [child].
  const OpenSessionSyncSupervisor({required this.child, super.key});

  /// Visible Sessions branch content.
  final Widget child;

  @override
  ConsumerState<OpenSessionSyncSupervisor> createState() =>
      _OpenSessionSyncSupervisorState();
}

class _OpenSessionSyncSupervisorState
    extends ConsumerState<OpenSessionSyncSupervisor> {
  static const int _maxConcurrentColdAttaches = 2;

  final Map<SessionDetailKey, _ResidentSessionLease> _leases = {};
  final Set<SessionDetailKey> _watchedRetirements = {};
  final Queue<_AttachAdmission> _attachQueue = Queue<_AttachAdmission>();
  RosterSource? _source;
  SessionDetailKey? _visibleKey;
  int _runningAttaches = 0;
  int _admissionEpoch = 0;
  int _reconcileGeneration = 0;
  int _resumeGeneration = 0;
  int _sourceRetirementGeneration = 0;
  ProviderContainer? _container;
  SessionDetailRetirementLedger? _retirementLedger;
  BrokerAppLifecycleMonitor? _lifecycleMonitor;
  StreamSubscription<BrokerAppLifecycleState>? _lifecycleSubscription;
  OpenSessionsState? _latestOpen;
  BrokerAppLifecycleState _latestLifecycle = BrokerAppLifecycleState.resumed;
  bool _lifecycleSuspended = false;
  bool _resumeRefreshPending = false;
  bool _attachAdmissionSuspended = false;
  bool _sourceRetirementPending = false;

  @override
  void initState() {
    super.initState();
    final monitor = ref.read(sessionNotificationLifecycleMonitorProvider);
    _lifecycleMonitor = monitor;
    _latestLifecycle = monitor.currentState;
    _lifecycleSubscription = monitor.stateChanges.listen(
      _handleLifecycleChanged,
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final container = ProviderScope.containerOf(context);
    _container = container;
    // Cached here because dispose-time retirements must reach the ledger even
    // while the enclosing ProviderScope is being torn down.
    _retirementLedger = container.read(sessionDetailRetirementLedgerProvider);
  }

  @override
  Widget build(BuildContext context) {
    final currentSource = ref.watch(
      activeBrokerProfileProvider.select(RosterSource.of),
    );
    ref
      ..listen<RosterSource?>(
        activeBrokerProfileProvider.select(RosterSource.of),
        (previous, next) {
          if (previous == next || !mounted || _source == next) return;
          _adoptSource(next);
        },
      )
      ..watch(openSessionsControllerProvider)
      ..watch(visibleAttentionSessionProvider);
    _scheduleReconcile();
    // A source change is visible to child SessionDetailPage widgets during
    // this build, one frame before the supervisor's deferred reconciliation
    // can publish and await the old providers' retirements. Mounting the child
    // in that gap lets it reattach the still-resident provider against the new
    // endpoint, creating a transient socket that the retirement immediately
    // tears down. Withhold the whole child until the old source is retired;
    // the durable open set remains in the controller and remounts afterward.
    if (_sourceRetirementPending ||
        (_source != null && _source != currentSource)) {
      return const SizedBox.shrink(
        key: Key('open-session-source-retirement'),
      );
    }
    return widget.child;
  }

  @override
  void dispose() {
    _resumeGeneration++;
    unawaited(_lifecycleSubscription?.cancel());
    // The enclosing ProviderScope may already have disposed its container
    // during whole-window teardown. Closing subscriptions is still safe, but
    // there is no surviving window-local registry to clear in that case.
    unawaited(_retireAll(clearViewports: false));
    super.dispose();
  }

  void _handleLifecycleChanged(BrokerAppLifecycleState lifecycle) {
    if (!mounted) return;
    _latestLifecycle = lifecycle;
    _reconcileCurrentTruth();
  }

  /// Lifecycle truth as of this instant.
  ///
  /// The production monitor publishes transitions on an asynchronous broadcast
  /// stream, so `currentState` leads [_handleLifecycleChanged] by at least one
  /// microtask. Anything that admits transport work in that gap — a deferred
  /// reconciliation, a completing attach, a settled suspension — would
  /// otherwise decide against a lifecycle the app has already left. Every such
  /// decision reads the monitor; the cached field only covers a disposed one.
  BrokerAppLifecycleState _readLifecycle() {
    final monitor = _lifecycleMonitor;
    if (monitor != null) {
      _latestLifecycle = monitor.currentState;
    }
    return _latestLifecycle;
  }

  void _scheduleReconcile() {
    final generation = ++_reconcileGeneration;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || generation != _reconcileGeneration) return;
      _reconcileCurrentTruth();
    });
  }

  void _reconcileCurrentTruth() {
    final container = _container;
    if (!mounted || container == null) return;
    final source = RosterSource.of(
      container.read(activeBrokerProfileProvider),
    );
    final openAsync = container.read(openSessionsControllerProvider);
    final open = openAsync.isLoading || openAsync.hasError
        ? null
        : openAsync.valueOrNull;
    _reconcile(
      source,
      open,
      _readLifecycle(),
      _readVisibleKey(source),
    );
  }

  void _reconcile(
    RosterSource? source,
    OpenSessionsState? open,
    BrokerAppLifecycleState lifecycle,
    SessionDetailKey? visibleKey,
  ) {
    _latestLifecycle = lifecycle;
    _visibleKey = visibleKey;
    if (_source != source) {
      _adoptSource(source);
      if (_sourceRetirementPending) return;
    }
    if (open != null) _latestOpen = open;
    if (_sourceRetirementPending) {
      if (_isBackgroundLifecycle(lifecycle)) {
        _enterLifecycleSuspension();
      }
      return;
    }
    final settledOpen = _latestOpen;
    if (source == null || settledOpen == null) {
      if (_isBackgroundLifecycle(lifecycle)) {
        _enterLifecycleSuspension();
        _suspendBackgroundLeases();
      }
      return;
    }

    final desired = <SessionDetailKey>{
      for (final session in settledOpen.refs)
        SessionDetailKey(tool: session.tool, sessionId: session.id),
    };
    final removed = _leases.keys
        .where((key) => !desired.contains(key))
        .toList(growable: false);
    for (final key in removed) {
      _retireLease(key);
    }

    final viewportKeys = <SessionViewportKey>{
      for (final key in desired)
        SessionViewportKey.forSource(
          source: source,
          tool: key.tool,
          sessionId: key.sessionId,
        ),
    };
    ref
        .read(sessionViewportRegistryProvider.notifier)
        .synchronize(viewportKeys);

    if (_isBackgroundLifecycle(lifecycle)) {
      _enterLifecycleSuspension();
      _suspendBackgroundLeases();
      return;
    }
    if (_lifecycleSuspended) {
      if (lifecycle != BrokerAppLifecycleState.resumed ||
          _resumeRefreshPending) {
        return;
      }
      _resumeRefreshPending = true;
      final generation = ++_resumeGeneration;
      unawaited(_refreshRosterThenResume(generation, source));
      return;
    }

    _warmDesiredSessions(desired, _visibleKey, source);
  }

  /// Adopts [source] before descendant source listeners can attach against it.
  ///
  /// The supervisor's `ref.listen` is registered by the parent before any
  /// Session Detail descendant. Publishing the retirement ledger from that
  /// listener fences those descendants during the provider-notification turn,
  /// not one post-frame callback later.
  void _adoptSource(RosterSource? source) {
    if (_source == source) return;
    _source = source;
    _latestOpen = null;
    if (!_sourceRetirementPending &&
        (_leases.isNotEmpty || _runningAttaches > 0)) {
      _beginSourceRetirement();
      return;
    }
    if (!_sourceRetirementPending) {
      unawaited(_retireAll());
      setState(() {});
    }
  }

  void _warmDesiredSessions(
    Set<SessionDetailKey> desired,
    SessionDetailKey? visibleKey,
    RosterSource source,
  ) {
    // A real onstage detail may be admitted first, but the supervisor never
    // grants it authority. Only SessionDetailPage can promote the shared
    // controller to interactive; OpenSessionsState.activeKey is a restart hint.
    final ordered = [
      ...desired.where((key) => key == visibleKey),
      ...desired.where((key) => key != visibleKey),
    ];
    for (final key in ordered) {
      // The pending retirement may belong to a PREVIOUS supervisor
      // incarnation: the credential gate remounts this subtree, and adopting
      // the still-live controller here would revive a connection whose
      // resolver predates the credential change — and hand this lease to a
      // provider the old retirement is about to invalidate. Wait for the
      // handoff, then build from current truth.
      final pendingRetirement = _retirementLedger?.pendingFor(key);
      if (pendingRetirement != null) {
        _reconcileWhenRetired(key, pendingRetirement);
        continue;
      }
      final lease = _leases.putIfAbsent(key, () => _createLease(key, source));
      if (lease.suspended) {
        _resumeLeaseAfterSuspension(lease);
      } else {
        _requestAttach(lease);
      }
    }
    _drainAttachQueue();
  }

  void _enterLifecycleSuspension() {
    _attachAdmissionSuspended = true;
    if (_resumeRefreshPending) {
      _resumeRefreshPending = false;
      _resumeGeneration++;
    }
    if (!_lifecycleSuspended) {
      _lifecycleSuspended = true;
      _resumeGeneration++;
    }
  }

  void _suspendBackgroundLeases() {
    final selectedKey = _visibleKey;
    final background = _leases.keys
        .where((key) => key != selectedKey)
        .toList(growable: false);
    for (final key in background) {
      _suspendLease(_leases[key]!);
    }
  }

  Future<void> _refreshRosterThenResume(
    int generation,
    RosterSource source,
  ) async {
    try {
      await _container!.read(sessionRosterResumeRefreshProvider)();
    } on Object {
      // A failed compatibility refresh must not strand explicit tabs cold.
      // Their normal reconnect/replay path still provides the authoritative
      // session projection.
    }
    if (!mounted ||
        generation != _resumeGeneration ||
        _readLifecycle() != BrokerAppLifecycleState.resumed ||
        _source != source) {
      return;
    }
    _resumeRefreshPending = false;
    _lifecycleSuspended = false;
    _attachAdmissionSuspended = false;
    _reconcile(
      source,
      _latestOpen,
      _latestLifecycle,
      _readVisibleKey(source),
    );
  }

  _ResidentSessionLease _createLease(
    SessionDetailKey key,
    RosterSource source,
  ) {
    final provider = sessionDetailControllerProvider(key);
    final subscription = _container!.listen<SessionDetailState>(
      provider,
      (previous, next) {},
      fireImmediately: true,
    );
    return _ResidentSessionLease(
      key: key,
      source: source,
      subscription: subscription,
    );
  }

  void _requestAttach(_ResidentSessionLease lease) {
    if (_attachAdmissionSuspended ||
        _isBackgroundLifecycle(_readLifecycle()) ||
        lease.suspended ||
        !lease.active ||
        lease.source != _source) {
      return;
    }
    if (lease.attached || lease.running) return;
    if (lease.queued) return;
    lease.queued = true;
    final request = _AttachAdmission(lease: lease, epoch: _admissionEpoch);
    if (lease.key == _visibleKey) {
      _attachQueue.addFirst(request);
    } else {
      _attachQueue.addLast(request);
    }
  }

  void _drainAttachQueue() {
    // Admissions already queued under a resumed app are still cold attaches.
    // A hide that has not yet reached the listener must stop them here, or a
    // completing attach hands its lane straight to the next queued session.
    if (_attachAdmissionSuspended || _isBackgroundLifecycle(_readLifecycle())) {
      return;
    }
    while (_runningAttaches < _maxConcurrentColdAttaches &&
        _attachQueue.isNotEmpty) {
      final request = _attachQueue.removeFirst();
      final lease = request.lease..queued = false;
      if (request.epoch != _admissionEpoch ||
          !lease.active ||
          lease.suspended ||
          lease.running ||
          lease.attached ||
          lease.source != _source) {
        continue;
      }
      _runningAttaches++;
      lease.running = true;
      _startAttach(lease);
    }
  }

  void _startAttach(_ResidentSessionLease lease) {
    final generation = ++lease.attachGeneration;
    lease.admissionEpoch = _admissionEpoch;
    Future<void> operation;
    try {
      operation = ref
          .read(sessionDetailControllerProvider(lease.key).notifier)
          .attach(intent: SessionDetailAttachIntent.backgroundObserve);
    } on Object {
      operation = Future<void>.value();
    }
    unawaited(
      operation.then<void>(
        (_) => _completeAttach(lease, generation),
        onError: (Object _, StackTrace _) => _completeAttach(lease, generation),
      ),
    );
  }

  void _completeAttach(_ResidentSessionLease lease, int generation) {
    if (generation != lease.attachGeneration || !lease.running) return;
    lease
      ..running = false
      ..attached =
          lease.active &&
          !lease.suspended &&
          lease.source == _source &&
          lease.admissionEpoch == _admissionEpoch;
    if (_runningAttaches > 0) {
      _runningAttaches--;
    }
    if (lease.active &&
        !lease.suspended &&
        !lease.attached &&
        lease.source == _source) {
      _requestAttach(lease);
    }
    _drainAttachQueue();
  }

  void _retireLease(SessionDetailKey key) {
    final lease = _leases.remove(key);
    if (lease == null) return;
    lease.active = false;
    final retirement = _registerRetirement(key, _suspendAndCloseLease(lease));
    unawaited(
      retirement.whenComplete(() {
        if (mounted) {
          _reconcile(
            _source,
            _latestOpen,
            _readLifecycle(),
            _readVisibleKey(_source),
          );
        }
      }),
    );
    _drainAttachQueue();
  }

  /// Publishes [retirement] to the container-scoped ledger.
  ///
  /// The ledger outlives this State object, so a replacement supervisor (or a
  /// remounting detail page) can wait out a retirement its predecessor
  /// started. The returned future never errors and completes after the ledger
  /// entry is cleared.
  Future<void> _registerRetirement(
    SessionDetailKey key,
    Future<void> retirement,
  ) =>
      _retirementLedger?.register(key, retirement) ??
      retirement.then<void>((_) {}, onError: (Object _, StackTrace _) {});

  /// Re-runs reconciliation once [key]'s pending retirement completes.
  void _reconcileWhenRetired(SessionDetailKey key, Future<void> retirement) {
    if (!_watchedRetirements.add(key)) return;
    unawaited(
      retirement.whenComplete(() {
        _watchedRetirements.remove(key);
        if (!mounted) return;
        _reconcileCurrentTruth();
      }),
    );
  }

  Future<void> _retireAll({
    bool clearViewports = true,
    Future<void>? retirementBarrier,
  }) async {
    _admissionEpoch++;
    _attachQueue.clear();
    final retirements = <Future<void>>[];
    for (final lease in _leases.values) {
      lease.active = false;
      final retirement = retirementBarrier == null
          ? _suspendAndCloseLease(lease)
          : retirementBarrier.then<void>(
              (_) => _suspendAndCloseLease(lease),
            );
      retirements.add(
        _registerRetirement(lease.key, retirement),
      );
    }
    _leases.clear();
    _visibleKey = null;
    if (clearViewports) {
      _container?.read(sessionViewportRegistryProvider.notifier).clear();
    }
    await Future.wait(retirements);
  }

  void _beginSourceRetirement() {
    setState(() {
      _sourceRetirementPending = true;
      _attachAdmissionSuspended = true;
    });
    final generation = ++_sourceRetirementGeneration;
    // Publish every key's retirement immediately, so descendant source
    // listeners cannot self-rebind, but hold the actual invalidations until
    // the pending-state rebuild removes those descendant subscriptions.
    // Invalidating while an outgoing SessionDetailPage still watches the
    // family keeps the provider element alive and rebuilds the same controller
    // instance, violating the source-generation fence even though its
    // transport is replaced.
    final descendantsUnmounted = Completer<void>();
    final retirement = _retireAll(
      retirementBarrier: descendantsUnmounted.future,
    );
    WidgetsBinding.instance.addPostFrameCallback((_) {
      descendantsUnmounted.complete();
    });
    unawaited(_completeSourceRetirement(generation, retirement));
  }

  Future<void> _completeSourceRetirement(
    int generation,
    Future<void> retirement,
  ) async {
    await retirement;
    if (!mounted || generation != _sourceRetirementGeneration) return;
    try {
      _latestOpen = await _container!.read(
        openSessionsControllerProvider.future,
      );
    } on Object {
      _latestOpen = null;
    }
    if (!mounted || generation != _sourceRetirementGeneration) return;
    setState(() => _sourceRetirementPending = false);
    final lifecycle = _readLifecycle();
    _attachAdmissionSuspended =
        _lifecycleSuspended ||
        _resumeRefreshPending ||
        _isBackgroundLifecycle(lifecycle);
    _reconcile(
      _source,
      _latestOpen,
      lifecycle,
      _readVisibleKey(_source),
    );
  }

  SessionDetailKey? _readVisibleKey(RosterSource? source) {
    final container = _container;
    if (container == null) return null;
    return _qualifyVisibleKey(
      container.read(visibleAttentionSessionProvider),
      source,
    );
  }

  SessionDetailKey? _qualifyVisibleKey(
    VisibleAttentionSession? visible,
    RosterSource? source,
  ) {
    if (visible == null || source == null || visible.source != source) {
      return null;
    }
    try {
      if (!visible.isStillVisible()) return null;
    } on Object {
      // A disposed route can briefly leave its deferred claim in the provider.
      // Lifecycle ownership fails closed until the onstage scope republishes.
      return null;
    }
    return SessionDetailKey(
      tool: visible.tool,
      sessionId: visible.sessionId,
    );
  }

  bool _isBackgroundLifecycle(BrokerAppLifecycleState lifecycle) =>
      lifecycle == BrokerAppLifecycleState.hidden ||
      lifecycle == BrokerAppLifecycleState.paused ||
      lifecycle == BrokerAppLifecycleState.detached;

  void _suspendLease(_ResidentSessionLease lease) {
    if (lease.suspended || !lease.active) return;
    lease
      ..suspended = true
      ..attached = false
      ..queued = false;
    final generation = ++lease.suspensionGeneration;
    lease.suspension = _suspendController(lease).whenComplete(() {
      if (generation == lease.suspensionGeneration) {
        lease.suspension = null;
      }
    });
  }

  void _resumeLeaseAfterSuspension(_ResidentSessionLease lease) {
    if (!lease.suspended || lease.resumeScheduled) return;
    lease.resumeScheduled = true;
    final generation = lease.suspensionGeneration;
    final suspension = lease.suspension ?? Future<void>.value();
    unawaited(
      suspension.whenComplete(() {
        lease.resumeScheduled = false;
        if (!mounted ||
            generation != lease.suspensionGeneration ||
            _attachAdmissionSuspended ||
            !lease.active ||
            lease.source != _source) {
          return;
        }
        lease.suspended = false;
        _requestAttach(lease);
        _drainAttachQueue();
      }),
    );
  }

  Future<void> _suspendController(_ResidentSessionLease lease) async {
    try {
      await _container!
          .read(sessionDetailControllerProvider(lease.key).notifier)
          .suspendTransport();
    } on Object {
      // Suspension is a resource boundary. A transport that reports teardown
      // failure is still fenced by the controller's attempt generation.
    }
  }

  Future<void> _suspendAndCloseLease(_ResidentSessionLease lease) async {
    _suspendLeaseForRetirement(lease);
    await lease.suspension;
    lease.subscription.close();
    final container = _container;
    if (container == null) return;
    container.invalidate(sessionDetailControllerProvider(lease.key));
    // Riverpod destroys the invalidated element in a deferred scheduler pass,
    // not synchronously. Were the retirement to complete before that pass, a
    // waiting adopter's immediate read/listen would flush the invalidated
    // element and rebuild the SAME notifier instance — a controller whose
    // onDispose already ran — instead of creating a fresh one. The key is
    // only free once the pass has run.
    await container.pump();
  }

  void _suspendLeaseForRetirement(_ResidentSessionLease lease) {
    if (lease.suspended) return;
    lease
      ..suspended = true
      ..attached = false
      ..queued = false;
    final generation = ++lease.suspensionGeneration;
    lease.suspension = _suspendController(lease).whenComplete(() {
      if (generation == lease.suspensionGeneration) {
        lease.suspension = null;
      }
    });
  }
}

final class _ResidentSessionLease {
  _ResidentSessionLease({
    required this.key,
    required this.source,
    required this.subscription,
  });

  final SessionDetailKey key;
  final RosterSource source;
  final ProviderSubscription<SessionDetailState> subscription;
  bool active = true;
  bool queued = false;
  bool running = false;
  bool attached = false;
  bool suspended = false;
  bool resumeScheduled = false;
  int attachGeneration = 0;
  int admissionEpoch = 0;
  int suspensionGeneration = 0;
  Future<void>? suspension;
}

final class _AttachAdmission {
  const _AttachAdmission({required this.lease, required this.epoch});

  final _ResidentSessionLease lease;
  final int epoch;
}
